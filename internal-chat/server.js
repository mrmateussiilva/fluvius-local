import express from 'express';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Server } from 'socket.io';
import pg from 'pg';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, 'public', 'uploads');

const port = Number(process.env.PORT || 4000);
const EVOLUTION_URL = String(process.env.EVOLUTION_SERVER_URL || 'http://evolution:8080');
const EVOLUTION_API_KEY = String(process.env.EVOLUTION_API_KEY || '');
const CHATWOOT_URL = String(process.env.CHATWOOT_FRONTEND_URL || 'http://chatwoot:3000');
const CHATWOOT_PUBLIC_URL = String(process.env.CHATWOOT_PUBLIC_URL || process.env.CHATWOOT_FRONTEND_URL || 'http://localhost:3000');
const INTERNAL_CHAT_PUBLIC_URL = String(process.env.INTERNAL_CHAT_PUBLIC_URL || 'http://localhost:4000');
const CHATWOOT_API_TOKEN = String(process.env.CHATWOOT_USER_ACCESS_TOKEN || '');
const CHATWOOT_PLATFORM_TOKEN = String(process.env.CHATWOOT_PLATFORM_TOKEN || '');
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || '1');
const PASSWORD_RESET_TOKEN_TTL_HOURS = 24;
const MANAGER_ADMIN_TOKEN = String(process.env.MANAGER_ADMIN_TOKEN || '');
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '');
const CRM_AI_ENABLED = String(process.env.CRM_AI_ENABLED || 'false') === 'true';
const CRM_AI_MODEL = String(process.env.CRM_AI_MODEL || process.env.CAPTAIN_GEMINI_MODEL || 'gemini-2.0-flash');
const CRM_AI_CONFIDENCE_THRESHOLD = Math.min(Math.max(Number(process.env.CRM_AI_CONFIDENCE_THRESHOLD || 0.7), 0), 1);
const CRM_AI_MAX_MESSAGES = Math.min(Math.max(Number(process.env.CRM_AI_MAX_MESSAGES || 30), 5), 80);
const CRM_AI_AUTO_INTERVAL_SECONDS = Math.max(Number(process.env.CRM_AI_AUTO_INTERVAL_SECONDS || 0), 0);
const CRM_AI_AUTO_LIMIT = Math.min(Math.max(Number(process.env.CRM_AI_AUTO_LIMIT || 5), 1), 30);
const EVOLUTION_HISTORY_AUTO_IMPORT_ENABLED = String(process.env.EVOLUTION_HISTORY_AUTO_IMPORT_ENABLED || 'false') === 'true';
const EVOLUTION_HISTORY_AUTO_IMPORT_INTERVAL_SECONDS = Math.max(Number(process.env.EVOLUTION_HISTORY_AUTO_IMPORT_INTERVAL_SECONDS || 10), 5);
const EVOLUTION_HISTORY_AUTO_IMPORT_LIMIT = Math.min(Math.max(Number(process.env.EVOLUTION_HISTORY_AUTO_IMPORT_LIMIT || 20), 1), 100);
const EVOLUTION_HISTORY_MANUAL_IMPORT_LIMIT = Math.min(Math.max(Number(process.env.EVOLUTION_HISTORY_MANUAL_IMPORT_LIMIT || 25), 1), 100);
const EVOLUTION_HISTORY_IMPORT_THROTTLE_MS = Math.min(Math.max(Number(process.env.EVOLUTION_HISTORY_IMPORT_THROTTLE_MS || 150), 0), 2000);
const EVOLUTION_CHATWOOT_DIRECT_DB_IMPORT_ENABLED = String(process.env.EVOLUTION_CHATWOOT_DIRECT_DB_IMPORT_ENABLED || 'false') === 'true';
const TRIAGE_BOT_ENABLED = String(process.env.TRIAGE_BOT_ENABLED || 'false') === 'true';
const TRIAGE_BOT_INTERVAL_SECONDS = Math.max(Number(process.env.TRIAGE_BOT_INTERVAL_SECONDS || 7), 5);
const TRIAGE_BOT_LIMIT = Math.min(Math.max(Number(process.env.TRIAGE_BOT_LIMIT || 10), 1), 50);
const TRIAGE_BOT_NEW_CONVERSATION_WINDOW_HOURS = Math.min(Math.max(Number(process.env.TRIAGE_BOT_NEW_CONVERSATION_WINDOW_HOURS || 24), 1), 720);
const TRIAGE_BOT_OPTIONS_RAW = String(process.env.TRIAGE_BOT_OPTIONS || '');
const TRIAGE_BOT_AI_ENABLED = Boolean(GEMINI_API_KEY) && String(process.env.TRIAGE_BOT_AI_ENABLED || 'true') === 'true';

function directEvolutionImportDisabledPayload() {
  return {
    error: 'evolution_chatwoot_direct_db_import_disabled',
    message:
      'Importar mensagens da Evolution pelo internal-chat está desabilitado: esse fluxo escreve direto no banco do Chatwoot e pula callbacks/realtime do Rails.',
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertValidInternalUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL, got: ${value}`);
  }

  if (parsed.hostname === 'host') {
    throw new Error(`${name} points to invalid hostname "host"; use the Docker service URL instead`);
  }
}

assertValidInternalUrl('EVOLUTION_SERVER_URL', EVOLUTION_URL);
assertValidInternalUrl('CHATWOOT_FRONTEND_URL', CHATWOOT_URL);

const allowedOrigins = String(process.env.INTERNAL_CHAT_ALLOWED_ORIGINS || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const CLIENT_PUBLIC_FIELDS = `
  id,
  name,
  email,
  token,
  instance_name,
  channel_display_name,
  inbox_id,
  inbox_token,
  phone,
  status,
  chatwoot_account_id,
  chatwoot_user_id,
  chatwoot_user_email,
  integration_status,
  integration_last_checked_at,
  integration_last_error,
  integration_repaired_at,
  archived_at,
  archived_reason,
  archive_cleanup,
  created_at,
  updated_at
`;

const CRM_STAGES = [
  { key: 'novo-lead', title: 'Novo lead', color: '#3b82f6' },
  { key: 'em-atendimento', title: 'Em atendimento', color: '#22c55e' },
  { key: 'orcamento-enviado', title: 'Orçamento enviado', color: '#f59e0b' },
  { key: 'follow-up', title: 'Follow-up', color: '#8b5cf6' },
  { key: 'fechado', title: 'Fechado', color: '#10b981' },
  { key: 'perdido', title: 'Perdido', color: '#ef4444' },
  { key: 'pos-venda', title: 'Pós-venda', color: '#06b6d4' },
];
const CRM_STAGE_KEYS = CRM_STAGES.map(stage => stage.key);
const CRM_DEFAULT_STAGE_KEY = CRM_STAGES[0].key;
const CRM_CLOSED_STAGE_KEYS = new Set(['fechado', 'perdido']);
const CHATWOOT_ATTRIBUTE_MODELS = {
  conversation_attribute: 0,
  contact_attribute: 1,
};
const CHATWOOT_ATTRIBUTE_TYPES = {
  text: 0,
  currency: 2,
  date: 5,
};
const CRM_CUSTOM_ATTRIBUTES = [
  {
    key: 'origem_lead',
    name: 'Origem do lead',
    description: 'Canal, campanha ou indicação que originou o contato.',
    model: 'contact_attribute',
    type: 'text',
  },
  {
    key: 'produto_interesse',
    name: 'Produto/interesse',
    description: 'Produto, serviço ou necessidade principal do lead.',
    model: 'contact_attribute',
    type: 'text',
  },
  {
    key: 'valor_estimado',
    name: 'Valor estimado',
    description: 'Valor comercial estimado para a oportunidade.',
    model: 'contact_attribute',
    type: 'currency',
  },
  {
    key: 'proximo_follow_up',
    name: 'Próximo follow-up',
    description: 'Data combinada para retomar o atendimento comercial.',
    model: 'conversation_attribute',
    type: 'date',
  },
  {
    key: 'observacao_comercial',
    name: 'Observação comercial',
    description: 'Notas comerciais internas sobre a oportunidade.',
    model: 'conversation_attribute',
    type: 'text',
  },
];
const CRM_CUSTOM_ATTRIBUTE_KEYS = new Set(CRM_CUSTOM_ATTRIBUTES.map(attribute => attribute.key));

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DATABASE || 'chatwoot',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
});

const evolutionPool = new Pool({
  host: process.env.EVOLUTION_POSTGRES_HOST || process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.EVOLUTION_POSTGRES_PORT || process.env.POSTGRES_PORT || 5432),
  database: process.env.EVOLUTION_POSTGRES_DATABASE || process.env.EVOLUTION_POSTGRES_DB || 'evolution',
  user: process.env.EVOLUTION_POSTGRES_USER || process.env.POSTGRES_USER || 'postgres',
  password: process.env.EVOLUTION_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'postgres',
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 25 * 1024 * 1024,
});
const onlineUsers = new Map();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAllOrigins = allowedOrigins.includes('*');
  const allowedOrigin = allowAllOrigins ? '*' : allowedOrigins.find(item => item === origin);

  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: '25mb' }));

function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => {
        const index = item.indexOf('=');
        if (index === -1) return [item, ''];
        return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
      }),
  );
}

function managerAuthenticated(req) {
  if (!MANAGER_ADMIN_TOKEN) return true;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const cookieToken = parseCookies(req.headers.cookie || '').fluvius_manager_token || '';
  return bearer === MANAGER_ADMIN_TOKEN || cookieToken === MANAGER_ADMIN_TOKEN;
}

function requireManagerAuth(req, res, next) {
  if (managerAuthenticated(req)) return next();
  return res.status(401).json({ error: 'manager_auth_required' });
}

app.use((req, res, next) => {
  if (req.path === '/manager/login') return next();
  if (req.path.startsWith('/manager/api')) return requireManagerAuth(req, res, next);
  return next();
});

app.use(express.static('public'));

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;

  const dataUrl = String(attachment.dataUrl || '');
  const url = String(attachment.url || '');
  const mime = String(attachment.mime || '');
  const name = String(attachment.name || 'arquivo').slice(0, 180);
  const kind = String(attachment.kind || '').slice(0, 24);
  const size = Number(attachment.size || 0);

  if (!url && !dataUrl.startsWith('data:')) return null;
  if (!mime || !kind) return null;
  if (size > 12 * 1024 * 1024) return null;

  return { dataUrl, url, mime, name, kind, size };
}

function safeFileName(value) {
  const extension = path.extname(String(value || '')).slice(0, 16);
  const base = path.basename(String(value || 'arquivo'), extension)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'arquivo';
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${base}${extension}`;
}

function attachmentKindFromMime(mime) {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS internal_chat_rooms (
      id BIGSERIAL PRIMARY KEY,
      account_id BIGINT,
      kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
      title TEXT,
      dm_key TEXT UNIQUE,
      created_by BIGINT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS internal_chat_participants (
      room_id BIGINT NOT NULL REFERENCES internal_chat_rooms(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id BIGINT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS internal_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES internal_chat_rooms(id) ON DELETE CASCADE,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE internal_chat_messages
      ALTER COLUMN content DROP NOT NULL;

    ALTER TABLE internal_chat_rooms
      ADD COLUMN IF NOT EXISTS account_id BIGINT;

    ALTER TABLE internal_chat_messages
      ADD COLUMN IF NOT EXISTS attachment_kind TEXT,
      ADD COLUMN IF NOT EXISTS attachment_name TEXT,
      ADD COLUMN IF NOT EXISTS attachment_mime TEXT,
      ADD COLUMN IF NOT EXISTS attachment_size BIGINT,
      ADD COLUMN IF NOT EXISTS attachment_url TEXT,
      ADD COLUMN IF NOT EXISTS attachment_data_url TEXT;

    CREATE INDEX IF NOT EXISTS index_internal_chat_messages_room_id_id
      ON internal_chat_messages(room_id, id);

    CREATE INDEX IF NOT EXISTS index_internal_chat_rooms_account_id
      ON internal_chat_rooms(account_id);

    CREATE TABLE IF NOT EXISTS fluvius_clients (
      id          BIGSERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      email       TEXT,
      token       TEXT UNIQUE NOT NULL,
      instance_name TEXT,
      channel_display_name TEXT,
      inbox_id    INTEGER,
      inbox_token TEXT,
      phone       TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      chatwoot_account_id INTEGER,
      chatwoot_user_id INTEGER,
      chatwoot_user_email TEXT,
      chatwoot_temp_password TEXT,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE fluvius_clients
      ADD COLUMN IF NOT EXISTS chatwoot_account_id INTEGER,
      ADD COLUMN IF NOT EXISTS chatwoot_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS chatwoot_user_email TEXT,
      ADD COLUMN IF NOT EXISTS chatwoot_temp_password TEXT,
      ADD COLUMN IF NOT EXISTS channel_display_name TEXT,
      ADD COLUMN IF NOT EXISTS integration_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS integration_last_checked_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS integration_last_error TEXT,
      ADD COLUMN IF NOT EXISTS integration_repaired_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS archived_reason TEXT,
      ADD COLUMN IF NOT EXISTS archive_cleanup JSONB;

    CREATE TABLE IF NOT EXISTS fluvius_password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id BIGINT NOT NULL,
      client_id BIGINT REFERENCES fluvius_clients(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS index_fluvius_password_reset_tokens_user_account
      ON fluvius_password_reset_tokens(user_id, account_id);

    CREATE INDEX IF NOT EXISTS index_fluvius_password_reset_tokens_expires_at
      ON fluvius_password_reset_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS fluvius_client_inboxes (
      id                   BIGSERIAL PRIMARY KEY,
      client_id            BIGINT NOT NULL REFERENCES fluvius_clients(id) ON DELETE CASCADE,
      label                TEXT NOT NULL,
      instance_name        TEXT NOT NULL UNIQUE,
      channel_display_name TEXT NOT NULL,
      inbox_id             INTEGER,
      inbox_token          TEXT,
      phone                TEXT,
      token                TEXT UNIQUE NOT NULL,
      status               TEXT NOT NULL DEFAULT 'pending',
      integration_status   TEXT NOT NULL DEFAULT 'pending',
      integration_last_checked_at TIMESTAMP,
      integration_last_error TEXT,
      integration_repaired_at TIMESTAMP,
      created_at           TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS index_fluvius_client_inboxes_client_id
      ON fluvius_client_inboxes(client_id);

    ALTER TABLE fluvius_clients
      ADD COLUMN IF NOT EXISTS chatbot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS chatbot_type TEXT NOT NULL DEFAULT 'triage',
      ADD COLUMN IF NOT EXISTS chatbot_welcome_message TEXT,
      ADD COLUMN IF NOT EXISTS chatbot_absence_message TEXT,
      ADD COLUMN IF NOT EXISTS chatbot_options JSONB,
      ADD COLUMN IF NOT EXISTS chatbot_trigger_keyword TEXT;

    ALTER TABLE fluvius_client_inboxes
      ADD COLUMN IF NOT EXISTS chatbot_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS chatbot_type TEXT NOT NULL DEFAULT 'triage',
      ADD COLUMN IF NOT EXISTS chatbot_welcome_message TEXT,
      ADD COLUMN IF NOT EXISTS chatbot_absence_message TEXT,
      ADD COLUMN IF NOT EXISTS chatbot_options JSONB,
      ADD COLUMN IF NOT EXISTS chatbot_trigger_keyword TEXT;
  `);
}

function userFields(prefix = 'users') {
  return `${prefix}.id, ${prefix}.name, ${prefix}.email`;
}

async function accountIdsForUser(userId) {
  const { rows } = await pool.query(
    'SELECT account_id FROM account_users WHERE user_id = $1 ORDER BY account_id ASC',
    [userId],
  );
  return rows.map(row => Number(row.account_id));
}

async function resolveAccountIdForUser(userId, requestedAccountId = null) {
  const accountIds = await accountIdsForUser(userId);
  if (!accountIds.length) return null;
  const parsedAccountId = Number(requestedAccountId || 0);
  if (parsedAccountId && accountIds.includes(parsedAccountId)) return parsedAccountId;
  return accountIds[0];
}

async function usersBelongToAccount(userIds, accountId) {
  const uniqueUserIds = [...new Set(userIds.map(Number).filter(Boolean))];
  if (!uniqueUserIds.length || !accountId) return false;
  const { rows } = await pool.query(
    `
      SELECT COUNT(DISTINCT user_id)::int AS matched
      FROM account_users
      WHERE account_id = $1 AND user_id = ANY($2::bigint[])
    `,
    [accountId, uniqueUserIds],
  );
  return Number(rows[0]?.matched || 0) === uniqueUserIds.length;
}

async function roomAccountId(roomId) {
  const { rows } = await pool.query('SELECT account_id FROM internal_chat_rooms WHERE id = $1', [roomId]);
  return rows[0]?.account_id ? Number(rows[0].account_id) : null;
}

async function ensureParticipant(roomId, userId) {
  const result = await pool.query(
    'SELECT 1 FROM internal_chat_participants WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  return result.rowCount > 0;
}

async function ensureParticipantInAccount(roomId, userId, accountId = null) {
  if (!(await ensureParticipant(roomId, userId))) return false;
  const resolvedAccountId = accountId || await resolveAccountIdForUser(userId);
  if (!resolvedAccountId) return false;
  const roomAccount = await roomAccountId(roomId);
  if (!roomAccount) {
    await pool.query('UPDATE internal_chat_rooms SET account_id = $1 WHERE id = $2 AND account_id IS NULL', [resolvedAccountId, roomId]);
    return true;
  }
  return Number(roomAccount) === Number(resolvedAccountId);
}

async function createMessage({ roomId, userId, content, attachment }) {
  const parsedContent = String(content || '').trim();
  const parsedAttachment = normalizeAttachment(attachment);
  if (!parsedContent && !parsedAttachment) return null;

  const { rows } = await pool.query(
    `
      INSERT INTO internal_chat_messages (
        room_id,
        sender_id,
        content,
        attachment_kind,
        attachment_name,
        attachment_mime,
        attachment_size,
        attachment_url,
        attachment_data_url
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, room_id, sender_id, content, created_at,
        attachment_kind, attachment_name, attachment_mime, attachment_size, attachment_url, attachment_data_url
    `,
    [
      roomId,
      userId,
      parsedContent || null,
      parsedAttachment?.kind || null,
      parsedAttachment?.name || null,
      parsedAttachment?.mime || null,
      parsedAttachment?.size || null,
      parsedAttachment?.url || null,
      parsedAttachment?.dataUrl || null,
    ],
  );
  await pool.query('UPDATE internal_chat_rooms SET updated_at = NOW() WHERE id = $1', [roomId]);

  const user = await pool.query(`SELECT ${userFields()} FROM users WHERE id = $1`, [userId]);
  return {
    ...rows[0],
    sender_name: user.rows[0]?.name || 'Agente',
    sender_email: user.rows[0]?.email || '',
  };
}

async function unreadSummary(userId) {
  const { rows } = await pool.query(
    `
      SELECT
        COALESCE(SUM(room_counts.unread_count), 0)::int AS total_unread
      FROM internal_chat_participants participants
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unread_count
        FROM internal_chat_messages messages
        WHERE messages.room_id = participants.room_id
          AND messages.sender_id <> participants.user_id
          AND messages.id > COALESCE(participants.last_read_message_id, 0)
      ) room_counts ON true
      WHERE participants.user_id = $1
    `,
    [userId],
  );
  return rows[0] || { total_unread: 0 };
}

async function emitUnread(userId) {
  const summary = await unreadSummary(userId);
  io.to(`user:${userId}`).emit('unread:update', summary);
}

function onlineUserIds() {
  return [...onlineUsers.entries()].filter(([, sockets]) => sockets.size > 0).map(([userId]) => Number(userId));
}

function emitPresence() {
  io.emit('presence:update', { onlineUserIds: onlineUserIds() });
}

app.get('/api/agents', async (req, res) => {
  const userId = Number(req.query.userId);
  const accountId = await resolveAccountIdForUser(userId, req.query.accountId);
  if (!userId || !accountId) return res.status(400).json({ error: 'valid userId/accountId is required' });

  const { rows } = await pool.query(`
    SELECT DISTINCT ${userFields('users')}
    FROM users
    INNER JOIN account_users ON account_users.user_id = users.id
    WHERE users.confirmed_at IS NOT NULL
      AND account_users.account_id = $1
    ORDER BY users.name ASC
  `, [accountId]);
  res.json({ accountId, agents: rows });
});

async function requireAccountAccess(req, res) {
  const accountId = Number(req.params.accountId || req.query.accountId || req.body?.accountId || 0);
  const userId = Number(req.query.userId || req.body?.userId || 0);
  if (!accountId) {
    res.status(400).json({ error: 'accountId is required' });
    return null;
  }
  if (!userId) {
    res.status(400).json({ error: 'userId is required' });
    return null;
  }
  if (!(await usersBelongToAccount([userId], accountId))) {
    res.status(403).json({ error: 'user does not belong to this account' });
    return null;
  }
  return { accountId, userId };
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function crmAttribute(conversationAttrs, contactAttrs, key) {
  return conversationAttrs?.[key] ?? contactAttrs?.[key] ?? '';
}

function crmTruthy(value) {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'sim'].includes(String(value || '').toLowerCase());
}

function normalizeCurrencyNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value || '').trim();
  if (!text) return 0;

  const normalized = text
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.max(0, amount) : 0;
}

function normalizeCrmPriority(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['alta', 'high'].includes(normalized)) return 'alta';
  if (['media', 'média', 'medium'].includes(normalized)) return 'media';
  if (['baixa', 'low'].includes(normalized)) return 'baixa';
  return '';
}

function crmPriorityRank(priority) {
  return { alta: 3, media: 2, baixa: 1 }[priority] || 0;
}

function decorateCrmLead(lead) {
  const conversationAttrs = lead.conversation_custom_attributes || {};
  const contactAttrs = lead.contact_custom_attributes || {};
  const lastActivityAt = lead.last_activity_at || lead.created_at;
  const stageDefinition = CRM_STAGES.find(stage => stage.key === lead.stage) || CRM_STAGES[0];
  const isClosedStage = CRM_CLOSED_STAGE_KEYS.has(stageDefinition.key);
  const needsFollowup = Number(lead.status) !== 1
    && lastActivityAt
    && new Date(lastActivityAt).getTime() < Date.now() - (24 * 60 * 60 * 1000)
    && !isClosedStage;
  const aiConfidence = clampNumber(conversationAttrs.crm_ai_last_confidence || 0, 0, 1);
  const aiScore = Math.round(clampNumber(conversationAttrs.crm_ai_score || (needsFollowup ? 70 : 40), 0, 100));
  const aiPriority = normalizeCrmPriority(conversationAttrs.crm_ai_priority)
    || (needsFollowup ? 'alta' : Number(lead.status) !== 1 && !isClosedStage ? 'media' : 'baixa');
  const estimatedValueNumber = normalizeCurrencyNumber(
    conversationAttrs.crm_ai_estimated_value_number
      ?? conversationAttrs.estimated_value_number
      ?? crmAttribute(conversationAttrs, contactAttrs, 'valor_estimado')
      ?? conversationAttrs.crm_ai_estimated_value
  );
  const aiLastAnalyzedAt = conversationAttrs.crm_ai_last_analyzed_at || '';
  const aiNeedsReview = crmTruthy(conversationAttrs.crm_ai_needs_review)
    || !aiLastAnalyzedAt
    || (aiConfidence > 0 && aiConfidence < CRM_AI_CONFIDENCE_THRESHOLD);

  return {
    ...lead,
    stage_key: stageDefinition.key,
    stage: stageDefinition.title,
    status_label: ['Aberta', 'Resolvida', 'Pendente', 'Adiada'][Number(lead.status)] || String(lead.status),
    needs_followup: needsFollowup,
    estimated_value_number: estimatedValueNumber,
    ai_score: aiScore,
    ai_priority: aiPriority,
    ai_next_action: String(conversationAttrs.crm_ai_next_action || (needsFollowup ? 'Retomar contato parado há mais de 24h' : '')).slice(0, 240),
    ai_risk_reason: String(conversationAttrs.crm_ai_risk_reason || (needsFollowup ? 'Sem atividade recente em oportunidade aberta' : '')).slice(0, 240),
    ai_stage_reason: String(conversationAttrs.crm_ai_stage_reason || '').slice(0, 300),
    ai_needs_review: aiNeedsReview,
    ai_last_analyzed_at: aiLastAnalyzedAt,
    ai_last_confidence: aiConfidence,
    ai_suggested_stage_key: conversationAttrs.crm_ai_suggested_stage || '',
    chatwoot_url: lead.display_id ? conversationUrl(lead.account_id, lead.display_id) : '',
  };
}

async function crmSummaryForAccount(accountId) {
  await ensureCrmDefaults(accountId);

  const counts = Object.fromEntries(CRM_STAGE_KEYS.map(stage => [stage, 0]));
  const stageValueTotals = Object.fromEntries(CRM_STAGE_KEYS.map(stage => [stage, 0]));
  const summaryRows = await pool.query(
    `WITH conversation_stages AS (
       SELECT
         conversations.id,
         conversations.account_id,
         conversations.status,
         conversations.last_activity_at,
         conversations.created_at,
         conversations.custom_attributes AS conversation_custom_attributes,
         contacts.custom_attributes AS contact_custom_attributes,
         COALESCE(MAX(tags.name) FILTER (WHERE tags.name = ANY($2::text[])), $3) AS stage
       FROM conversations
       LEFT JOIN contacts ON contacts.id = conversations.contact_id
       LEFT JOIN taggings
         ON taggings.taggable_type = 'Conversation'
        AND taggings.context = 'labels'
        AND taggings.taggable_id = conversations.id
       LEFT JOIN tags ON tags.id = taggings.tag_id
       WHERE conversations.account_id = $1
       GROUP BY conversations.id, contacts.id
     )
     SELECT *
     FROM conversation_stages`,
    [accountId, CRM_STAGE_KEYS, CRM_DEFAULT_STAGE_KEY],
  );
  let followups = 0;
  let openConversations = 0;
  let newLeads = 0;
  let pipelineValueOpen = 0;
  let pipelineValueWon = 0;
  let pipelineValueLost = 0;
  let atRiskCount = 0;
  let needsAiReviewCount = 0;

  for (const row of summaryRows.rows.map(decorateCrmLead)) {
    if (counts[row.stage_key] !== undefined) counts[row.stage_key] += 1;
    if (stageValueTotals[row.stage_key] !== undefined) {
      stageValueTotals[row.stage_key] += row.estimated_value_number;
    }
    if (row.needs_followup) followups += 1;
    if (Number(row.status) !== 1) openConversations += 1;
    if (Number(row.status) !== 1 && row.stage_key === CRM_DEFAULT_STAGE_KEY) newLeads += 1;
    if (row.stage_key === 'fechado') pipelineValueWon += row.estimated_value_number;
    else if (row.stage_key === 'perdido') pipelineValueLost += row.estimated_value_number;
    else pipelineValueOpen += row.estimated_value_number;
    if (!CRM_CLOSED_STAGE_KEYS.has(row.stage_key) && (row.needs_followup || row.ai_priority === 'alta' || row.ai_risk_reason)) {
      atRiskCount += 1;
    }
    if (row.ai_needs_review) needsAiReviewCount += 1;
  }

  return {
    account_id: accountId,
    ai_configured: crmAiConfigured(),
    confidence_threshold: CRM_AI_CONFIDENCE_THRESHOLD,
    stages: CRM_STAGES.map(stage => ({
      ...stage,
      total: counts[stage.key] || 0,
      estimated_value_total: stageValueTotals[stage.key] || 0,
    })),
    followups,
    open_conversations: openConversations,
    new_leads: newLeads,
    pipeline_value_open: pipelineValueOpen,
    pipeline_value_won: pipelineValueWon,
    pipeline_value_lost: pipelineValueLost,
    at_risk_count: atRiskCount,
    needs_ai_review_count: needsAiReviewCount,
  };
}

async function crmLeadsForAccount(accountId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 80), 1), 200);
  const stageFilter = normalizeCrmStage(options.stage)?.key || '';
  const followupOnly = String(options.followup || '') === 'true';

  await ensureCrmDefaults(accountId);

  const leads = await pool.query(
    `WITH conversation_stages AS (
       SELECT
         conversations.id,
         COALESCE(MAX(tags.name) FILTER (WHERE tags.name = ANY($2::text[])), $3) AS stage
       FROM conversations
       LEFT JOIN taggings
         ON taggings.taggable_type = 'Conversation'
        AND taggings.context = 'labels'
        AND taggings.taggable_id = conversations.id
       LEFT JOIN tags ON tags.id = taggings.tag_id
       WHERE conversations.account_id = $1
       GROUP BY conversations.id
     )
     SELECT
       conversations.id,
       conversations.display_id,
       conversations.status,
       conversations.assignee_id,
       conversations.last_activity_at,
       conversations.created_at,
       conversations.custom_attributes AS conversation_custom_attributes,
       contacts.name AS contact_name,
       contacts.email AS contact_email,
       contacts.phone_number,
       contacts.custom_attributes AS contact_custom_attributes,
       users.name AS assignee_name,
       users.email AS assignee_email,
       conversation_stages.stage,
       last_message.content AS last_message,
       last_message.created_at AS last_message_at
     FROM conversations
     INNER JOIN conversation_stages ON conversation_stages.id = conversations.id
     LEFT JOIN contacts ON contacts.id = conversations.contact_id
     LEFT JOIN users ON users.id = conversations.assignee_id
     LEFT JOIN LATERAL (
       SELECT content, created_at
       FROM messages
       WHERE messages.conversation_id = conversations.id
         AND messages.private = false
       ORDER BY messages.created_at DESC
       LIMIT 1
     ) last_message ON true
     WHERE conversations.account_id = $1
       AND ($5::text = '' OR conversation_stages.stage = $5)
       AND (
         $6::boolean = false
         OR (
           conversations.status <> 1
           AND COALESCE(conversations.last_activity_at, conversations.created_at) < NOW() - INTERVAL '24 hours'
           AND conversation_stages.stage <> ALL($4::text[])
         )
       )
     ORDER BY COALESCE(conversations.last_activity_at, conversations.created_at) DESC
     LIMIT $7`,
    [accountId, CRM_STAGE_KEYS, CRM_DEFAULT_STAGE_KEY, [...CRM_CLOSED_STAGE_KEYS], stageFilter, followupOnly, limit],
  );

  return {
    account_id: accountId,
    stages: CRM_STAGES,
    ai_configured: crmAiConfigured(),
    confidence_threshold: CRM_AI_CONFIDENCE_THRESHOLD,
    leads: leads.rows
      .map(lead => decorateCrmLead({ ...lead, account_id: accountId }))
      .sort((a, b) => (
        crmPriorityRank(b.ai_priority) - crmPriorityRank(a.ai_priority)
        || Number(b.needs_followup) - Number(a.needs_followup)
        || b.estimated_value_number - a.estimated_value_number
        || b.ai_score - a.ai_score
        || new Date(b.last_activity_at || b.created_at).getTime() - new Date(a.last_activity_at || a.created_at).getTime()
      )),
  };
}

async function updateCrmStageForAccount(accountId, conversationId, stage) {
  const conversation = await pool.query(
    'SELECT id, display_id FROM conversations WHERE id = $1 AND account_id = $2 LIMIT 1',
    [conversationId, accountId],
  );
  if (!conversation.rowCount) return null;

  await ensureCrmDefaults(accountId);

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const stageTags = await dbClient.query('SELECT id FROM tags WHERE name = ANY($1::text[])', [CRM_STAGE_KEYS]);
    const removedTagIds = stageTags.rows.map(row => Number(row.id));

    if (removedTagIds.length) {
      await dbClient.query(
        `DELETE FROM taggings
         WHERE taggable_type = 'Conversation'
           AND context = 'labels'
           AND taggable_id = $1
           AND tag_id = ANY($2::int[])`,
        [conversationId, removedTagIds],
      );
    }

    let tag = await dbClient.query('SELECT id FROM tags WHERE name = $1 LIMIT 1', [stage.key]);
    if (!tag.rowCount) {
      tag = await dbClient.query('INSERT INTO tags (name, taggings_count) VALUES ($1, 0) RETURNING id', [stage.key]);
    }
    const tagId = Number(tag.rows[0].id);

    await dbClient.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at)
       SELECT $1, 'Conversation', $2, 'labels', NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM taggings
         WHERE tag_id = $1
           AND taggable_type = 'Conversation'
           AND taggable_id = $2
           AND context = 'labels'
       )`,
      [tagId, conversationId],
    );

    const labels = await updateConversationCachedLabels(dbClient, conversationId);
    await refreshTaggingCounts(dbClient, [...removedTagIds, tagId]);
    await dbClient.query('COMMIT');

    return {
      conversation_id: conversationId,
      display_id: conversation.rows[0].display_id,
      stage_key: stage.key,
      stage: stage.title,
      labels,
      chatwoot_url: conversationUrl(accountId, conversation.rows[0].display_id),
    };
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
}

function normalizeCrmFieldPayload(value) {
  if (!value || typeof value !== 'object') return {};
  const fields = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!CRM_CUSTOM_ATTRIBUTE_KEYS.has(key)) continue;
    fields[key] = String(rawValue ?? '').trim().slice(0, 1000);
  }
  return fields;
}

async function updateCrmFieldsForAccount(accountId, conversationId, fields) {
  const normalizedFields = normalizeCrmFieldPayload(fields);
  if (!Object.keys(normalizedFields).length) return null;

  const { rows } = await pool.query(
    `UPDATE conversations
     SET custom_attributes = COALESCE(custom_attributes, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND account_id = $2
     RETURNING id, display_id, custom_attributes`,
    [conversationId, accountId, JSON.stringify(normalizedFields)],
  );
  return rows[0] || null;
}

function crmAiConfigured() {
  return CRM_AI_ENABLED && Boolean(GEMINI_API_KEY);
}

function cleanJsonText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function parseGeminiJson(value) {
  const cleaned = cleanJsonText(value);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('Gemini did not return valid JSON');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function normalizeAiAnalysis(raw) {
  const stage = normalizeCrmStage(raw?.stage);
  const confidence = Math.min(Math.max(Number(raw?.confidence || 0), 0), 1);
  const summary = String(raw?.summary || raw?.reason || '').trim().slice(0, 1200);
  const interest = String(raw?.interest || raw?.produto_interesse || '').trim().slice(0, 300);
  const nextFollowUp = String(raw?.next_follow_up || '').trim().slice(0, 30);
  const estimatedValue = String(raw?.estimated_value || '').trim().slice(0, 80);
  const estimatedValueNumber = normalizeCurrencyNumber(raw?.estimated_value_number || estimatedValue);
  const shouldFollowUp = Boolean(raw?.should_follow_up);
  const score = Math.round(clampNumber(raw?.score || raw?.ai_score || 0, 0, 100));
  const priority = normalizeCrmPriority(raw?.priority || raw?.ai_priority) || 'media';
  const nextAction = String(raw?.next_action || raw?.ai_next_action || '').trim().slice(0, 240);
  const riskReason = String(raw?.risk_reason || raw?.ai_risk_reason || '').trim().slice(0, 240);
  const stageReason = String(raw?.stage_reason || raw?.ai_stage_reason || '').trim().slice(0, 300);

  if (!stage) throw new Error('Gemini returned an invalid CRM stage');

  return {
    stage,
    confidence,
    summary,
    interest,
    next_follow_up: /^\d{4}-\d{2}-\d{2}$/.test(nextFollowUp) ? nextFollowUp : '',
    estimated_value: estimatedValue,
    estimated_value_number: estimatedValueNumber,
    should_follow_up: shouldFollowUp,
    score,
    priority,
    next_action: nextAction,
    risk_reason: riskReason,
    stage_reason: stageReason,
  };
}

async function geminiGenerateJson(prompt) {
  const model = CRM_AI_MODEL.startsWith('models/') ? CRM_AI_MODEL : `models/${CRM_AI_MODEL}`;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${encodeURIComponent(model).replace(/%2F/g, '/')}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Gemini request failed with status ${response.status}`);
  }

  const text = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n').trim();
  if (!text) throw new Error('Gemini returned an empty response');
  return parseGeminiJson(text);
}

async function conversationTranscriptForAi(accountId, conversationId) {
  const conversation = await pool.query(
    `SELECT
       conversations.id,
       conversations.display_id,
       conversations.status,
       conversations.assignee_id,
       conversations.created_at,
       conversations.last_activity_at,
       conversations.custom_attributes,
       contacts.name AS contact_name,
       contacts.email AS contact_email,
       contacts.phone_number,
       users.name AS assignee_name,
       users.email AS assignee_email
     FROM conversations
     LEFT JOIN contacts ON contacts.id = conversations.contact_id
     LEFT JOIN users ON users.id = conversations.assignee_id
     WHERE conversations.id = $1
       AND conversations.account_id = $2
     LIMIT 1`,
    [conversationId, accountId],
  );
  if (!conversation.rowCount) return null;

  const messages = await pool.query(
    `SELECT content, message_type, private, created_at
     FROM messages
     WHERE conversation_id = $1
       AND private = false
       AND content IS NOT NULL
       AND trim(content) <> ''
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, CRM_AI_MAX_MESSAGES],
  );

  return {
    conversation: conversation.rows[0],
    messages: messages.rows.reverse().map(message => ({
      role: Number(message.message_type) === 0 ? 'cliente' : 'atendente',
      content: String(message.content || '').slice(0, 1500),
      created_at: message.created_at,
    })),
  };
}

function buildCrmAiPrompt(payload) {
  const stageList = CRM_STAGES.map(stage => `- ${stage.key}: ${stage.title}`).join('\n');
  const contact = payload.conversation;
  const transcript = payload.messages
    .map(message => `[${message.role}] ${message.content}`)
    .join('\n');

  return `
Voce e um analista comercial do Fluvius. Classifique a conversa em uma etapa do funil CRM.

Etapas validas:
${stageList}

Regras:
- Responda somente JSON valido, sem markdown.
- Use exatamente uma das chaves de etapa em "stage".
- Nao invente informacoes que nao aparecam na conversa.
- Use "confidence" entre 0 e 1.
- Se o cliente pediu preco, proposta ou recebeu valores, prefira "orcamento-enviado".
- Se falta resposta do cliente ou existe combinacao futura, prefira "follow-up".
- Se houve compra/confirmacao/contrato/pagamento, use "fechado".
- Se recusou, nao quer mais, sem interesse ou perdeu prazo, use "perdido".
- Se ja e cliente e precisa suporte depois da venda, use "pos-venda".
- Caso esteja em conversa ativa sem proposta clara, use "em-atendimento".
- Caso tenha pouca informacao, use "novo-lead".
- "estimated_value_number" deve ser numero em reais, sem simbolo, usando 0 se nao houver valor.
- "score" deve indicar chance comercial de 0 a 100, considerando interesse, urgencia, fit e avancos.
- "priority" deve ser "alta", "media" ou "baixa" para orientar o gestor.
- "next_action" deve ser uma acao objetiva para o responsavel executar.
- "risk_reason" deve explicar risco comercial ou ficar vazio se nao houver risco claro.
- "stage_reason" deve explicar em uma frase por que escolheu a etapa.

Contato:
Nome: ${contact.contact_name || 'Nao informado'}
Telefone: ${contact.phone_number || 'Nao informado'}
Email: ${contact.contact_email || 'Nao informado'}
Responsavel: ${contact.assignee_name || contact.assignee_email || 'Nao atribuido'}

Conversa:
${transcript || 'Sem mensagens publicas com texto.'}

Formato obrigatorio:
{
  "stage": "novo-lead",
  "confidence": 0.0,
  "interest": "",
  "estimated_value": "",
  "estimated_value_number": 0,
  "score": 0,
  "priority": "media",
  "next_action": "",
  "risk_reason": "",
  "stage_reason": "",
  "next_follow_up": "",
  "should_follow_up": false,
  "summary": ""
}
`.trim();
}

async function analyzeCrmConversation(accountId, conversationId, options = {}) {
  if (!crmAiConfigured()) {
    throw new Error('CRM AI is disabled or GEMINI_API_KEY is missing');
  }

  const payload = await conversationTranscriptForAi(accountId, conversationId);
  if (!payload) return null;
  if (!payload.messages.length) throw new Error('conversation has no public text messages to analyze');

  const rawAnalysis = await geminiGenerateJson(buildCrmAiPrompt(payload));
  const analysis = normalizeAiAnalysis(rawAnalysis);
  const apply = options.apply !== false && analysis.confidence >= CRM_AI_CONFIDENCE_THRESHOLD;

  let stageResult = null;
  let fieldsResult = null;
  if (apply) {
    stageResult = await updateCrmStageForAccount(accountId, conversationId, analysis.stage);
    const noteParts = [
      analysis.summary && `IA: ${analysis.summary}`,
      analysis.interest && `Interesse: ${analysis.interest}`,
      analysis.estimated_value && `Valor estimado: ${analysis.estimated_value}`,
      analysis.next_action && `Proxima acao: ${analysis.next_action}`,
      analysis.risk_reason && `Risco: ${analysis.risk_reason}`,
      analysis.stage_reason && `Motivo da etapa: ${analysis.stage_reason}`,
      `Confianca: ${Math.round(analysis.confidence * 100)}%`,
    ].filter(Boolean);
    const fields = {
      observacao_comercial: noteParts.join('\n'),
    };
    if (analysis.interest) fields.produto_interesse = analysis.interest;
    if (analysis.estimated_value) fields.valor_estimado = analysis.estimated_value;
    if (analysis.next_follow_up) fields.proximo_follow_up = analysis.next_follow_up;
    fieldsResult = await updateCrmFieldsForAccount(accountId, conversationId, fields);
  }

  const aiAttributes = {
    crm_ai_last_analyzed_at: new Date().toISOString(),
    crm_ai_last_confidence: analysis.confidence,
    crm_ai_last_stage: analysis.stage.key,
    crm_ai_suggested_stage: analysis.stage.key,
    crm_ai_last_applied: apply,
    crm_ai_score: analysis.score,
    crm_ai_priority: analysis.priority,
    crm_ai_next_action: analysis.next_action,
    crm_ai_risk_reason: analysis.risk_reason,
    crm_ai_stage_reason: analysis.stage_reason,
    crm_ai_summary: analysis.summary,
    crm_ai_interest: analysis.interest,
    crm_ai_estimated_value: analysis.estimated_value,
    crm_ai_estimated_value_number: analysis.estimated_value_number,
    crm_ai_needs_review: !apply,
  };
  const aiFieldsResult = await pool.query(
    `UPDATE conversations
     SET custom_attributes = COALESCE(custom_attributes, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND account_id = $2
     RETURNING custom_attributes`,
    [conversationId, accountId, JSON.stringify(aiAttributes)],
  );

  return {
    conversation_id: conversationId,
    display_id: payload.conversation.display_id,
    applied: apply,
    confidence_threshold: CRM_AI_CONFIDENCE_THRESHOLD,
    stage_key: analysis.stage.key,
    stage: analysis.stage.title,
    confidence: analysis.confidence,
    interest: analysis.interest,
    estimated_value: analysis.estimated_value,
    estimated_value_number: analysis.estimated_value_number,
    score: analysis.score,
    priority: analysis.priority,
    next_action: analysis.next_action,
    risk_reason: analysis.risk_reason,
    stage_reason: analysis.stage_reason,
    next_follow_up: analysis.next_follow_up,
    should_follow_up: analysis.should_follow_up,
    summary: analysis.summary,
    labels: stageResult?.labels || null,
    conversation_custom_attributes: aiFieldsResult.rows[0]?.custom_attributes
      || fieldsResult?.custom_attributes
      || payload.conversation.custom_attributes
      || {},
    chatwoot_url: conversationUrl(accountId, payload.conversation.display_id),
  };
}

async function crmConversationIdsForAutoAnalysis(accountId, limit = 10) {
  const safeLimit = Math.min(Math.max(Number(limit || 10), 1), 50);
  const cutoff = new Date(Date.now() - (6 * 60 * 60 * 1000)).toISOString();
  const { rows } = await pool.query(
    `SELECT conversations.id
     FROM conversations
     WHERE conversations.account_id = $1
       AND conversations.status <> 1
       AND COALESCE(conversations.custom_attributes->>'crm_ai_last_analyzed_at', '') < $3
     ORDER BY COALESCE(conversations.last_activity_at, conversations.created_at) DESC
     LIMIT $2`,
    [accountId, safeLimit, cutoff],
  );
  return rows.map(row => Number(row.id));
}

app.get('/api/accounts/:accountId/crm/summary', async (req, res) => {
  try {
    const access = await requireAccountAccess(req, res);
    if (!access) return;
    res.json(await crmSummaryForAccount(access.accountId));
  } catch (err) {
    res.status(500).json({ step: 'crm_summary', error: err.message });
  }
});

app.get('/api/accounts/:accountId/crm/leads', async (req, res) => {
  try {
    const access = await requireAccountAccess(req, res);
    if (!access) return;
    res.json(await crmLeadsForAccount(access.accountId, req.query));
  } catch (err) {
    res.status(500).json({ step: 'crm_leads', error: err.message });
  }
});

app.post('/api/accounts/:accountId/crm/leads/:conversationId/stage', async (req, res) => {
  const access = await requireAccountAccess(req, res);
  if (!access) return;

  const conversationId = Number(req.params.conversationId);
  const stage = normalizeCrmStage(req.body?.stage);
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (!stage) return res.status(400).json({ error: 'invalid CRM stage' });

  try {
    const result = await updateCrmStageForAccount(access.accountId, conversationId, stage);
    if (!result) return res.status(404).json({ error: 'conversation not found for this account' });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ step: 'update_crm_stage', error: err.message });
  }
});

app.patch('/api/accounts/:accountId/crm/leads/:conversationId/fields', async (req, res) => {
  const access = await requireAccountAccess(req, res);
  if (!access) return;

  const conversationId = Number(req.params.conversationId);
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  try {
    const result = await updateCrmFieldsForAccount(access.accountId, conversationId, req.body?.fields);
    if (!result) return res.status(404).json({ error: 'conversation not found for this account' });
    return res.json({
      conversation_id: conversationId,
      display_id: result.display_id,
      conversation_custom_attributes: result.custom_attributes || {},
      chatwoot_url: conversationUrl(access.accountId, result.display_id),
    });
  } catch (err) {
    return res.status(500).json({ step: 'update_crm_fields', error: err.message });
  }
});

app.post('/api/accounts/:accountId/crm/leads/:conversationId/analyze', async (req, res) => {
  const access = await requireAccountAccess(req, res);
  if (!access) return;

  const conversationId = Number(req.params.conversationId);
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  try {
    const result = await analyzeCrmConversation(access.accountId, conversationId, {
      apply: req.body?.apply !== false,
    });
    if (!result) return res.status(404).json({ error: 'conversation not found for this account' });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ step: 'crm_ai_analyze', error: err.message });
  }
});

// Standalone selector bootstrap. Fluvius embeds should call /api/agents with userId/accountId.
app.get('/api/bootstrap-users', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT ${userFields('users')}, account_users.account_id
    FROM users
    INNER JOIN account_users ON account_users.user_id = users.id
    WHERE users.confirmed_at IS NOT NULL
    ORDER BY users.name ASC
  `);
  res.json(rows);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'internal-chat' });
});

app.get('/api/rooms', async (req, res) => {
  const userId = Number(req.query.userId);
  const accountId = await resolveAccountIdForUser(userId, req.query.accountId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!accountId) return res.status(400).json({ error: 'valid accountId is required' });

  const { rows } = await pool.query(
    `
      SELECT
        rooms.id,
        rooms.kind,
        rooms.title,
        rooms.updated_at,
        COALESCE(
          NULLIF(last_message.content, ''),
          CASE
            WHEN last_message.attachment_kind = 'image' THEN 'Imagem'
            WHEN last_message.attachment_kind = 'audio' THEN 'Audio'
            WHEN last_message.attachment_kind = 'file' THEN 'Arquivo'
            ELSE NULL
          END
        ) AS last_message,
        last_message.created_at AS last_message_at,
        COALESCE(unread.unread_count, 0)::int AS unread_count,
        COALESCE(
          rooms.title,
          string_agg(other_users.name, ', ' ORDER BY other_users.name)
        ) AS display_name
      FROM internal_chat_rooms rooms
      INNER JOIN internal_chat_participants me
        ON me.room_id = rooms.id AND me.user_id = $1
      LEFT JOIN internal_chat_participants others
        ON others.room_id = rooms.id AND others.user_id <> $1
      LEFT JOIN users other_users
        ON other_users.id = others.user_id
      LEFT JOIN LATERAL (
        SELECT content, attachment_kind, created_at
        FROM internal_chat_messages
        WHERE room_id = rooms.id
        ORDER BY id DESC
        LIMIT 1
      ) last_message ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS unread_count
        FROM internal_chat_messages messages
        WHERE messages.room_id = rooms.id
          AND messages.sender_id <> $1
          AND messages.id > COALESCE(me.last_read_message_id, 0)
      ) unread ON true
      WHERE rooms.account_id = $2
      GROUP BY rooms.id, last_message.content, last_message.attachment_kind, last_message.created_at, unread.unread_count
      ORDER BY COALESCE(last_message.created_at, rooms.updated_at) DESC
    `,
    [userId, accountId],
  );
  res.json(rows);
});

app.get('/api/unread', async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  res.json(await unreadSummary(userId));
});

app.post('/api/uploads', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'file body is required' });
  }
  if (req.body.length > 12 * 1024 * 1024) {
    return res.status(413).json({ error: 'file is too large' });
  }

  const mime = String(req.headers['content-type'] || 'application/octet-stream');
  const originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'arquivo'));
  const fileName = safeFileName(originalName);
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(path.join(uploadDir, fileName), req.body);

  res.json({
    kind: attachmentKindFromMime(mime),
    name: originalName.slice(0, 180),
    mime,
    size: req.body.length,
    url: `/uploads/${fileName}`,
  });
});

app.post('/api/rooms/dm', async (req, res) => {
  const userId = Number(req.body.userId);
  const otherUserId = Number(req.body.otherUserId);
  const accountId = await resolveAccountIdForUser(userId, req.body.accountId);
  if (!userId || !otherUserId || userId === otherUserId) {
    return res.status(400).json({ error: 'valid userId and otherUserId are required' });
  }
  if (!accountId || !(await usersBelongToAccount([userId, otherUserId], accountId))) {
    return res.status(403).json({ error: 'users must belong to the same account' });
  }

  const [first, second] = [userId, otherUserId].sort((a, b) => a - b);
  const dmKey = `${accountId}:${first}:${second}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const room = await client.query(
      `
        INSERT INTO internal_chat_rooms (kind, dm_key, created_by)
        VALUES ('dm', $1, $2)
        ON CONFLICT (dm_key) DO UPDATE SET updated_at = internal_chat_rooms.updated_at
        RETURNING id, kind, title, updated_at
      `,
      [dmKey, userId],
    );
    const roomId = room.rows[0].id;
    await client.query('UPDATE internal_chat_rooms SET account_id = $1 WHERE id = $2', [accountId, roomId]);
    await client.query(
      `
        INSERT INTO internal_chat_participants (room_id, user_id)
        VALUES ($1, $2), ($1, $3)
        ON CONFLICT DO NOTHING
      `,
      [roomId, userId, otherUserId],
    );
    await client.query('COMMIT');
    res.json(room.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/rooms/group', async (req, res) => {
  const userId = Number(req.body.userId);
  const accountId = await resolveAccountIdForUser(userId, req.body.accountId);
  const title = String(req.body.title || '').trim();
  const participantIds = [...new Set((req.body.participantIds || []).map(Number).filter(Boolean))];
  if (!userId || !title || participantIds.length === 0) {
    return res.status(400).json({ error: 'userId, title and participantIds are required' });
  }

  const allParticipants = [...new Set([userId, ...participantIds])];
  if (!accountId || !(await usersBelongToAccount(allParticipants, accountId))) {
    return res.status(403).json({ error: 'all participants must belong to the same account' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const room = await client.query(
      'INSERT INTO internal_chat_rooms (account_id, kind, title, created_by) VALUES ($1, $2, $3, $4) RETURNING id, kind, title, updated_at',
      [accountId, 'group', title, userId],
    );
    for (const participantId of allParticipants) {
      await client.query(
        'INSERT INTO internal_chat_participants (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [room.rows[0].id, participantId],
      );
    }
    await client.query('COMMIT');
    res.json(room.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/rooms/:roomId/messages', async (req, res) => {
  const roomId = Number(req.params.roomId);
  const userId = Number(req.query.userId);
  const accountId = await resolveAccountIdForUser(userId, req.query.accountId);
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipantInAccount(roomId, userId, accountId))) return res.status(403).json({ error: 'not a participant in this account' });

  const { rows } = await pool.query(
    `
      SELECT messages.id, messages.room_id, messages.sender_id, messages.content, messages.created_at,
             messages.attachment_kind, messages.attachment_name, messages.attachment_mime,
             messages.attachment_size, messages.attachment_url, messages.attachment_data_url,
             users.name AS sender_name, users.email AS sender_email
      FROM internal_chat_messages messages
      INNER JOIN users ON users.id = messages.sender_id
      WHERE messages.room_id = $1
      ORDER BY messages.id ASC
      LIMIT 500
    `,
    [roomId],
  );
  res.json(rows);
});

app.get('/api/rooms/:roomId', async (req, res) => {
  const roomId = Number(req.params.roomId);
  const userId = Number(req.query.userId);
  const accountId = await resolveAccountIdForUser(userId, req.query.accountId);
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipantInAccount(roomId, userId, accountId))) return res.status(403).json({ error: 'not a participant in this account' });

  const room = await pool.query(
    `
      SELECT id, account_id, kind, title, updated_at
      FROM internal_chat_rooms
      WHERE id = $1
    `,
    [roomId],
  );
  const participants = await pool.query(
    `
      SELECT ${userFields('users')}
      FROM internal_chat_participants participants
      INNER JOIN users ON users.id = participants.user_id
      WHERE participants.room_id = $1
      ORDER BY users.name ASC
    `,
    [roomId],
  );

  res.json({ ...room.rows[0], participants: participants.rows });
});

app.post('/api/rooms/:roomId/read', async (req, res) => {
  const roomId = Number(req.params.roomId);
  const userId = Number(req.body.userId);
  const accountId = await resolveAccountIdForUser(userId, req.body.accountId);
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipantInAccount(roomId, userId, accountId))) return res.status(403).json({ error: 'not a participant in this account' });

  const { rows } = await pool.query(
    'SELECT COALESCE(MAX(id), 0)::bigint AS last_message_id FROM internal_chat_messages WHERE room_id = $1',
    [roomId],
  );
  const lastMessageId = rows[0]?.last_message_id || 0;
  await pool.query(
    'UPDATE internal_chat_participants SET last_read_message_id = $1 WHERE room_id = $2 AND user_id = $3',
    [lastMessageId, roomId, userId],
  );
  await emitUnread(userId);
  res.json({ ok: true, last_read_message_id: lastMessageId });
});

app.post('/api/rooms/:roomId/messages', async (req, res) => {
  const roomId = Number(req.params.roomId);
  const userId = Number(req.body.userId);
  const accountId = await resolveAccountIdForUser(userId, req.body.accountId);
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipantInAccount(roomId, userId, accountId))) return res.status(403).json({ error: 'not a participant in this account' });

  const message = await createMessage({
    roomId,
    userId,
    content: req.body.content,
    attachment: req.body.attachment,
  });
  if (!message) return res.status(400).json({ error: 'content or attachment is required' });

  io.to(`room:${roomId}`).emit('message:new', message);
  const participants = await pool.query(
    'SELECT user_id FROM internal_chat_participants WHERE room_id = $1 AND user_id <> $2',
    [roomId, userId],
  );
  await Promise.all(participants.rows.map(row => emitUnread(row.user_id)));
  res.json(message);
});

// ─── WhatsApp Connection Manager & Client Provisioning ──────────────────────

app.post('/manager/login', (req, res) => {
  const token = String(req.body?.token || '');
  if (!MANAGER_ADMIN_TOKEN) return res.json({ ok: true, auth_disabled: true });
  if (token !== MANAGER_ADMIN_TOKEN) return res.status(401).json({ error: 'invalid_token' });

  const secure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  res.setHeader(
    'Set-Cookie',
    `fluvius_manager_token=${encodeURIComponent(token)}; Path=/manager; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`,
  );
  res.json({ ok: true });
});

app.post('/manager/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'fluvius_manager_token=; Path=/manager; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/manager/api/session', (_req, res) => {
  res.json({ ok: true });
});

async function evoFetch(path, options = {}) {
  try {
    const headers = { apikey: EVOLUTION_API_KEY, ...(options.headers || {}) };
    if (options.body && !headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${EVOLUTION_URL}${path}`, {
      ...options,
      headers,
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
  }
}

async function cwtFetch(path, options = {}) {
  try {
    const headers = { api_access_token: CHATWOOT_API_TOKEN, ...(options.headers || {}) };
    if (options.body && !headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${CHATWOOT_URL}${path}`, {
      ...options,
      headers,
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
  }
}

// Uses Fluvius Platform API token for account/user provisioning
async function platformFetch(path, options = {}) {
  try {
    const headers = { api_access_token: CHATWOOT_PLATFORM_TOKEN, ...(options.headers || {}) };
    if (options.body && !headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${CHATWOOT_URL}${path}`, {
      ...options,
      headers,
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
  }
}

// Uses a specific user's access token for a given Fluvius account
async function cwtAccountFetch(path, userToken, options = {}) {
  try {
    const headers = { api_access_token: userToken, ...(options.headers || {}) };
    if (options.body && !headers['Content-Type'] && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${CHATWOOT_URL}${path}`, {
      ...options,
      headers,
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
  }
}

const DEFAULT_TRIAGE_OPTIONS = [
  { key: '1', label: 'Comercial' },
  { key: '2', label: 'Financeiro' },
  { key: '3', label: 'Suporte' },
  { key: '4', label: 'Falar com atendente' },
];

function parseTriageOptions() {
  if (!TRIAGE_BOT_OPTIONS_RAW) return DEFAULT_TRIAGE_OPTIONS;
  try {
    const parsed = JSON.parse(TRIAGE_BOT_OPTIONS_RAW);
    if (!Array.isArray(parsed)) return DEFAULT_TRIAGE_OPTIONS;

    const options = parsed
      .map((item, index) => ({
        key: String(item?.key || index + 1).trim(),
        label: String(item?.label || item?.name || '').trim(),
        team_id: Number(item?.team_id || 0) || null,
        assignee_id: Number(item?.assignee_id || 0) || null,
        assignee_email: String(item?.assignee_email || '').trim().toLowerCase() || null,
      }))
      .filter(item => item.key && item.label);

    return options.length ? options : DEFAULT_TRIAGE_OPTIONS;
  } catch {
    return DEFAULT_TRIAGE_OPTIONS;
  }
}

function slugifyLabel(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseTriageOptionsForClient(client) {
  if (client && client.chatbot_options) {
    try {
      const parsed = typeof client.chatbot_options === 'string' ? JSON.parse(client.chatbot_options) : client.chatbot_options;
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      console.warn('Failed to parse client.chatbot_options:', e.message);
    }
  }
  return parseTriageOptions();
}

function triageMenuText(client) {
  const options = parseTriageOptionsForClient(client);
  return options.map(option => `${option.key} - ${option.label}`).join('\n');
}

function triageGreetingForClient(client, contactName = 'Cliente') {
  if (client && client.chatbot_welcome_message) {
    let msg = client.chatbot_welcome_message;
    msg = msg.replace(/\{client\.name\}/g, contactName);
    msg = msg.replace(/\{Nome do cliente\}/g, contactName);
    msg = msg.replace(/\{Nome da empresa\}/g, client.name || '');
    return msg;
  }
  const companyName = String(client.name || 'nossa empresa').trim();
  return [
    `Olá, seja bem-vindo(a) à empresa ${companyName}!`,
    '',
    'Para direcionar seu atendimento, escolha uma opção:',
    '',
    triageMenuText(client),
    '',
    'Digite apenas o número da opção desejada.',
  ].join('\n');
}

function triageConfirmationText(option) {
  return `Perfeito, vou direcionar seu atendimento para ${option.label}.`;
}

function triageAiConfirmationText(option) {
  return `Entendido! 🤖 Percebi que você precisa de ajuda com *${option.label}*. Vou te encaminhar agora!`;
}

function triageInvalidOptionText(client) {
  return [
    'Não consegui identificar a opção.',
    '',
    'Digite apenas um dos números abaixo:',
    '',
    triageMenuText(client),
  ].join('\n');
}

async function updateConversationCustomAttributes(accountId, conversationId, attributes) {
  const { rows } = await pool.query(
    `UPDATE conversations
     SET custom_attributes = COALESCE(custom_attributes, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $1
       AND account_id = $2
     RETURNING id, display_id, custom_attributes`,
    [conversationId, accountId, JSON.stringify(attributes)],
  );
  return rows[0] || null;
}

async function ensureAccountLabel(accountId, title, color = '#64748b') {
  const label = await pool.query(
    `INSERT INTO labels (title, description, color, show_on_sidebar, account_id, created_at, updated_at)
     VALUES ($1, $2, $3, true, $4, NOW(), NOW())
     ON CONFLICT (title, account_id) DO UPDATE
       SET updated_at = NOW()
     RETURNING id`,
    [title, `Label automatica Fluvius: ${title}`, color, accountId],
  );
  return label.rows[0]?.id || null;
}

async function addConversationLabel(accountId, conversationId, labelName, color = '#64748b') {
  if (!labelName) return [];
  await ensureAccountLabel(accountId, labelName, color);

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    let tag = await dbClient.query('SELECT id FROM tags WHERE name = $1 LIMIT 1', [labelName]);
    if (!tag.rowCount) {
      tag = await dbClient.query('INSERT INTO tags (name, taggings_count) VALUES ($1, 0) RETURNING id', [labelName]);
    }
    const tagId = Number(tag.rows[0].id);

    await dbClient.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at)
       SELECT $1, 'Conversation', $2, 'labels', NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM taggings
         WHERE tag_id = $1
           AND taggable_type = 'Conversation'
           AND taggable_id = $2
           AND context = 'labels'
       )`,
      [tagId, conversationId],
    );

    const labels = await updateConversationCachedLabels(dbClient, conversationId);
    await refreshTaggingCounts(dbClient, [tagId]);
    await dbClient.query('COMMIT');
    return labels;
  } catch (error) {
    await dbClient.query('ROLLBACK');
    throw error;
  } finally {
    dbClient.release();
  }
}

async function clientAdminToken(client) {
  let adminUserId = client.chatwoot_user_id || null;
  if (!adminUserId && client.chatwoot_user_email) {
    adminUserId = await getCwtUserIdByEmail(client.chatwoot_user_email);
    if (adminUserId) {
      await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1 WHERE id = $2', [adminUserId, client.id]);
    }
  }
  if (!adminUserId) return null;
  return getPlatformUserToken(adminUserId);
}

async function sendTriageMessage(client, conversation, content) {
  const token = await clientAdminToken(client);
  if (!token) throw new Error(`client ${client.id} admin token not available`);

  const response = await cwtAccountFetch(
    `/api/v1/accounts/${client.chatwoot_account_id}/conversations/${conversation.display_id}/messages`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        content,
        message_type: 'outgoing',
        private: false,
      }),
    },
  );

  if (response.status >= 300) {
    throw new Error(`send triage message failed: ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function assignTriageConversation(client, conversation, option) {
  const token = await clientAdminToken(client);
  if (!token) throw new Error(`client ${client.id} admin token not available`);

  let teamId = option.team_id || null;
  if (!teamId && option.label) {
    const team = await pool.query(
      'SELECT id FROM teams WHERE account_id = $1 AND lower(name) = lower($2) LIMIT 1',
      [client.chatwoot_account_id, option.label],
    );
    teamId = Number(team.rows[0]?.id || 0) || null;
  }

  let assigneeId = option.assignee_id || null;
  if (!assigneeId && option.assignee_email) {
    assigneeId = await getCwtUserIdByEmail(option.assignee_email);
  }

  if (teamId) {
    const team = await cwtAccountFetch(
      `/api/v1/accounts/${client.chatwoot_account_id}/conversations/${conversation.display_id}/assignments`,
      token,
      { method: 'POST', body: JSON.stringify({ team_id: teamId }) },
    );
    if (team.status >= 300) throw new Error(`assign triage team failed: ${JSON.stringify(team.data)}`);
  }

  if (assigneeId) {
    const agent = await cwtAccountFetch(
      `/api/v1/accounts/${client.chatwoot_account_id}/conversations/${conversation.display_id}/assignments`,
      token,
      { method: 'POST', body: JSON.stringify({ assignee_id: assigneeId }) },
    );
    if (agent.status >= 300) throw new Error(`assign triage agent failed: ${JSON.stringify(agent.data)}`);
  }
}

function provisioningError(step, response, cleanup = {}) {
  const status = response?.status || 500;
  return {
    status,
    body: {
      step,
      error: response?.data || response,
      cleanup,
    },
  };
}

async function cleanupProvisioning(created) {
  const cleanup = {};

  if (created.instanceName) {
    const evo = await evoFetch(`/instance/delete/${created.instanceName}`, { method: 'DELETE' });
    cleanup.evolution = evo.status < 300 || evo.status === 404
      ? 'deleted'
      : { status: evo.status, error: evo.data };
  }

  if (created.accountId && CHATWOOT_PLATFORM_TOKEN) {
    const account = await platformFetch(`/platform/api/v1/accounts/${created.accountId}`, { method: 'DELETE' });
    cleanup.chatwoot_account = account.status < 300 || account.status === 404
      ? 'deleted'
      : { status: account.status, error: account.data };
  }

  return cleanup;
}

async function logoutEvolutionInstance(instanceName) {
  if (!instanceName) return 'skipped';
  const response = await evoFetch(`/instance/logout/${instanceName}`, { method: 'DELETE' });
  return response.status < 300 || response.status === 404
    ? 'disconnected'
    : { status: response.status, error: response.data };
}

async function enableEvolutionHistorySync(instanceName, accountId, userToken, nameInbox = null) {
  const settings = await evoFetch(`/settings/set/${instanceName}`, {
    method: 'POST',
    body: JSON.stringify({
      rejectCall: false,
      msgCall: '',
      groupsIgnore: false,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: true,
    }),
  });

  const chatwoot = await evoFetch(`/chatwoot/set/${instanceName}`, {
    method: 'POST',
    body: JSON.stringify(evolutionChatwootPayload(accountId, userToken, nameInbox)),
  });

  return { settings, chatwoot };
}

function expectedInboxWebhookUrl(instanceName) {
  return `${EVOLUTION_URL}/chatwoot/webhook/${instanceName}`;
}

function evolutionChatwootPayload(accountId, userToken, nameInbox = null) {
  const payload = {
    enabled: true,
    accountId: String(accountId),
    token: userToken,
    url: CHATWOOT_URL,
    signMsg: true,
    signDelimiter: '\\n',
    reopenConversation: true,
    conversationPending: false,
    importContacts: true,
    importMessages: true,
    daysLimitImportMessages: 365,
  };
  const inboxName = String(nameInbox || '').trim();
  if (inboxName) payload.nameInbox = inboxName;
  return payload;
}

function slugPart(value, fallback, maxLength = 20) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength);
  return slug || fallback;
}

function extraInboxInstanceName(client, extraInbox, label = '') {
  return [
    'fluvius',
    slugPart(client.name, 'cliente', 20),
    slugPart(label || extraInbox.label || extraInbox.channel_display_name, 'whatsapp', 16),
    Date.now().toString(36),
  ].join('-');
}

async function evolutionConnectionState(instanceName) {
  if (!instanceName) return 'unknown';
  const response = await evoFetch(`/instance/connectionState/${instanceName}`);
  if (response.status >= 300) return 'unknown';
  return String(response.data?.instance?.state || response.data?.state || 'unknown').toLowerCase();
}

async function setClientIntegrationState(clientId, status, error = null, repaired = false, isExtraInbox = false) {
  const table = isExtraInbox ? 'fluvius_client_inboxes' : 'fluvius_clients';
  await pool.query(
    `UPDATE ${table}
     SET integration_status = $2,
         integration_last_checked_at = NOW(),
         integration_last_error = $3,
         integration_repaired_at = CASE WHEN $4 THEN NOW() ELSE integration_repaired_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [clientId, status, error ? String(error).slice(0, 2000) : null, repaired],
  );
}

async function clientTokenForIntegration(client) {
  let userId = client.chatwoot_user_id || null;
  if (!userId && client.chatwoot_user_email) {
    userId = await getCwtUserIdByEmail(client.chatwoot_user_email);
    if (userId) {
      await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1, updated_at = NOW() WHERE id = $2', [userId, client.id]);
    }
  }
  if (!userId) return null;
  return getPlatformUserToken(userId);
}

async function updateClientInboxWebhook(client, userToken, actions = []) {
  if (!client.chatwoot_account_id || !client.inbox_id) {
    return { ok: false, status: 400, details: 'client is missing account or inbox' };
  }

  const webhookUrl = expectedInboxWebhookUrl(client.instance_name);
  const response = await cwtAccountFetch(
    `/api/v1/accounts/${client.chatwoot_account_id}/inboxes/${client.inbox_id}`,
    userToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ channel: { webhook_url: webhookUrl } }),
    },
  );

  if (response.status < 300) actions.push('inbox_webhook_updated');
  return {
    ok: response.status < 300,
    status: response.status,
    details: response.status < 300 ? { webhook_url: webhookUrl } : response.data,
  };
}

async function repairClientIntegration(client, isExtraInbox = false) {
  const actions = [];
  const errors = [];

  if (!client.instance_name || !client.chatwoot_account_id || !client.inbox_id) {
    const message = 'client is missing instance/account/inbox';
    await setClientIntegrationState(client.id, 'error', message, false, isExtraInbox);
    return { repaired: false, actions, errors: [message] };
  }

  const userToken = await clientTokenForIntegration(client);
  if (!userToken) {
    const message = 'client admin token not available';
    await setClientIntegrationState(client.id, 'error', message, false, isExtraInbox);
    return { repaired: false, actions, errors: [message] };
  }

  const settings = await evoFetch(`/settings/set/${client.instance_name}`, {
    method: 'POST',
    body: JSON.stringify({
      rejectCall: false,
      msgCall: '',
      groupsIgnore: false,
      alwaysOnline: false,
      readMessages: false,
      readStatus: false,
      syncFullHistory: true,
    }),
  });
  if (settings.status < 300) actions.push('evolution_settings_updated');
  else errors.push({ step: 'evolution_settings', status: settings.status, error: settings.data });

  const link = await evoFetch(`/chatwoot/set/${client.instance_name}`, {
    method: 'POST',
    body: JSON.stringify(evolutionChatwootPayload(
      client.chatwoot_account_id,
      userToken,
      client.channel_display_name,
    )),
  });
  if (link.status < 300) actions.push('evolution_chatwoot_link_updated');
  else errors.push({ step: 'evolution_chatwoot_link', status: link.status, error: link.data });

  const webhook = await updateClientInboxWebhook(client, userToken, actions);
  if (!webhook.ok) errors.push({ step: 'inbox_webhook', status: webhook.status, error: webhook.details });

  const status = errors.length ? 'error' : 'ok';
  await setClientIntegrationState(client.id, status, errors.length ? JSON.stringify(errors) : null, !errors.length, isExtraInbox);

  return {
    repaired: !errors.length,
    actions,
    errors,
  };
}

async function clientIntegrationStatus(client, isExtraInbox = false) {
  const result = {
    client_id: client.id,
    instance_name: client.instance_name,
    account_id: client.chatwoot_account_id,
    inbox_id: client.inbox_id,
    integration_status: client.integration_status || 'pending',
    integration_last_checked_at: client.integration_last_checked_at || null,
    integration_last_error: client.integration_last_error || null,
    evolution_instance: { ok: false, status: 404, details: null },
    chatwoot_link: { ok: false, status: 'unknown', details: null },
    inbox_webhook: { ok: false, status: 404, details: null },
    history_import: { ok: true, status: 'ready', details: null },
    media_probe: { ok: true, status: 'ready', details: null },
  };

  if (!client.instance_name || !client.chatwoot_account_id || !client.inbox_id) {
    result.history_import = { ok: false, status: 400, details: 'client is missing instance/account/inbox' };
    result.media_probe = { ok: false, status: 400, details: 'client is missing instance/account/inbox' };
    await setClientIntegrationState(client.id, 'error', result.history_import.details, false, isExtraInbox);
    return result;
  }

  const instance = await evolutionPool.query('SELECT id, name FROM "Instance" WHERE name = $1 LIMIT 1', [client.instance_name]);
  if (instance.rowCount) {
    result.evolution_instance = { ok: true, status: 'found', details: instance.rows[0] };
  }

  const inbox = await pool.query(
    `SELECT inboxes.id, channel_api.webhook_url
     FROM inboxes
     INNER JOIN channel_api ON channel_api.id = inboxes.channel_id AND inboxes.channel_type = 'Channel::Api'
     WHERE inboxes.id = $1
       AND inboxes.account_id = $2
     LIMIT 1`,
    [client.inbox_id, client.chatwoot_account_id],
  );
  const expectedWebhook = expectedInboxWebhookUrl(client.instance_name);
  if (inbox.rowCount) {
    const webhookUrl = inbox.rows[0].webhook_url || '';
    result.inbox_webhook = {
      ok: webhookUrl === expectedWebhook,
      status: webhookUrl === expectedWebhook ? 'ok' : 'mismatch',
      details: { webhook_url: webhookUrl, expected_webhook_url: expectedWebhook },
    };
  }

  const link = await evoFetch(`/chatwoot/find/${client.instance_name}`);
  if (link.status < 300) {
    const data = Array.isArray(link.data) ? link.data[0] : link.data;
    const url = data?.url || data?.chatwootUrl || data?.chatwoot_url || '';
    const chatwootLinkOk = (!url || url === CHATWOOT_URL)
      && (!data?.nameInbox || data.nameInbox === client.channel_display_name);
    result.chatwoot_link = {
      ok: chatwootLinkOk,
      status: chatwootLinkOk ? 'ok' : 'mismatch',
      details: { ...data, expected_nameInbox: client.channel_display_name },
    };
  } else if (link.status !== 404) {
    result.chatwoot_link = { ok: false, status: link.status, details: link.data };
  } else {
    result.chatwoot_link = { ok: false, status: 'unknown', details: 'Evolution did not expose chatwoot/find for this instance' };
  }

  const pendingMedia = await evolutionPool.query(
    `SELECT COUNT(*)::int AS count
     FROM "Message" m
     INNER JOIN "Instance" i ON i.id = m."instanceId"
     WHERE i.name = $1
       AND (m."chatwootMessageId" IS NULL OR m."chatwootMessageId" = 0)
       AND m."messageType" IN ('imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage')`,
    [client.instance_name],
  );
  result.media_probe.details = { pending_media_messages: pendingMedia.rows[0]?.count || 0 };

  const ok = result.evolution_instance.ok && result.chatwoot_link.ok && result.inbox_webhook.ok && result.history_import.ok;
  await setClientIntegrationState(client.id, ok ? 'ok' : 'error', ok ? null : JSON.stringify({
    evolution_instance: result.evolution_instance,
    chatwoot_link: result.chatwoot_link,
    inbox_webhook: result.inbox_webhook,
  }), false, isExtraInbox);

  return result;
}

async function getCwtUserIdByEmail(email) {
  const { rows } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
  return rows[0]?.id || null;
}

async function ensureCrmDefaults(accountId) {
  if (!accountId) return [];
  const created = { labels: [], attributes: [] };

  for (const stage of CRM_STAGES) {
    const existing = await pool.query(
      'SELECT id FROM labels WHERE account_id = $1 AND lower(title) = lower($2) LIMIT 1',
      [accountId, stage.key],
    );
    if (existing.rowCount) continue;

    const { rows } = await pool.query(
      `INSERT INTO labels (title, description, color, show_on_sidebar, account_id, created_at, updated_at)
       VALUES ($1, $2, $3, true, $4, NOW(), NOW())
       ON CONFLICT (title, account_id) DO NOTHING
       RETURNING id, title`,
      [stage.key, `Etapa do funil comercial Fluvius: ${stage.title}`, stage.color, accountId],
    );
    if (rows[0]) created.labels.push(rows[0]);
  }

  for (const attribute of CRM_CUSTOM_ATTRIBUTES) {
    const attributeModel = CHATWOOT_ATTRIBUTE_MODELS[attribute.model];
    const displayType = CHATWOOT_ATTRIBUTE_TYPES[attribute.type];

    const existing = await pool.query(
      `SELECT id
       FROM custom_attribute_definitions
       WHERE account_id = $1
         AND attribute_model = $2
         AND lower(attribute_key) = lower($3)
       LIMIT 1`,
      [accountId, attributeModel, attribute.key],
    );
    if (existing.rowCount) continue;

    const { rows } = await pool.query(
      `INSERT INTO custom_attribute_definitions
        (attribute_display_name, attribute_key, attribute_display_type, default_value, attribute_model, account_id, attribute_description, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (attribute_key, attribute_model, account_id) DO NOTHING
       RETURNING id, attribute_key, attribute_display_name`,
      [attribute.name, attribute.key, displayType, attributeModel, accountId, attribute.description],
    );
    if (rows[0]) created.attributes.push(rows[0]);
  }

  return created;
}

function normalizeCrmStage(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return CRM_STAGES.find(stage => stage.key === normalized || stage.title.toLowerCase() === normalized) || null;
}

function conversationUrl(accountId, displayId) {
  return `${CHATWOOT_PUBLIC_URL}/app/accounts/${accountId}/conversations/${displayId}`;
}

async function updateConversationCachedLabels(dbClient, conversationId) {
  const { rows } = await dbClient.query(
    `SELECT tags.name
     FROM taggings
     INNER JOIN tags ON tags.id = taggings.tag_id
     WHERE taggings.taggable_type = 'Conversation'
       AND taggings.context = 'labels'
       AND taggings.taggable_id = $1
     ORDER BY tags.name ASC`,
    [conversationId],
  );
  const labels = rows.map(row => row.name);
  await dbClient.query(
    'UPDATE conversations SET cached_label_list = $1, updated_at = NOW() WHERE id = $2',
    [labels.join(', '), conversationId],
  );
  return labels;
}

async function refreshTaggingCounts(dbClient, tagIds) {
  const uniqueTagIds = [...new Set(tagIds.map(Number).filter(Boolean))];
  for (const tagId of uniqueTagIds) {
    await dbClient.query(
      'UPDATE tags SET taggings_count = (SELECT COUNT(*) FROM taggings WHERE tag_id = $1) WHERE id = $1',
      [tagId],
    );
  }
}

async function getPlatformUserToken(userId) {
  const token = await platformFetch(`/platform/api/v1/users/${userId}/token`, { method: 'POST' });
  if (token.status >= 300) {
    console.warn(`[getPlatformUserToken] failed status=${token.status} data=${JSON.stringify(token.data)}`);
    return null;
  }
  return token.data?.access_token || null;
}

function parseAgentPayload(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => ({
      name: String(item?.name || '').trim(),
      email: String(item?.email || '').trim().toLowerCase(),
    }))
    .filter(item => item.name && item.email);
}

function generateTempPassword() {
  return `${randomBytes(4).toString('hex')}Ab1!`;
}

function passwordResetTokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function passwordResetUrl(token) {
  return `${INTERNAL_CHAT_PUBLIC_URL.replace(/\/$/, '')}/reset-password/${encodeURIComponent(token)}`;
}

function sanitizeResetUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    account_id: Number(row.account_id),
    role_label: row.role_label || row.role || 'Agente',
  };
}

async function createPasswordResetLink({ clientId, accountId, userId }) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = passwordResetTokenHash(token);

  await pool.query(
    `
      UPDATE fluvius_password_reset_tokens
      SET used_at = NOW()
      WHERE user_id = $1
        AND account_id = $2
        AND used_at IS NULL
        AND expires_at > NOW()
    `,
    [userId, accountId],
  );

  await pool.query(
    `
      INSERT INTO fluvius_password_reset_tokens
        (token_hash, user_id, account_id, client_id, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 hour'))
    `,
    [tokenHash, userId, accountId, clientId, PASSWORD_RESET_TOKEN_TTL_HOURS],
  );

  return {
    reset_url: passwordResetUrl(token),
    expires_in_hours: PASSWORD_RESET_TOKEN_TTL_HOURS,
  };
}

async function findValidPasswordResetToken(token) {
  const tokenHash = passwordResetTokenHash(token);
  const { rows } = await pool.query(
    `
      SELECT
        reset.token_hash,
        reset.user_id AS id,
        reset.account_id,
        reset.client_id,
        reset.expires_at,
        reset.used_at,
        users.name,
        users.email,
        account_users.role
      FROM fluvius_password_reset_tokens reset
      INNER JOIN users ON users.id = reset.user_id
      INNER JOIN account_users
        ON account_users.user_id = reset.user_id
       AND account_users.account_id = reset.account_id
      WHERE reset.token_hash = $1
      LIMIT 1
    `,
    [tokenHash],
  );

  const row = rows[0];
  if (!row) return { error: 'invalid_token' };
  if (row.used_at) return { error: 'token_already_used' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { error: 'token_expired' };
  return { row };
}

async function resetCwtUserPassword(userId, password) {
  const payload = {
    password,
    confirmed: true,
  };

  let reset = await platformFetch(`/platform/api/v1/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });

  if (reset.status === 404 || reset.status === 405) {
    reset = await platformFetch(`/platform/api/v1/users/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  return reset;
}

function safeJsonParse(value, fallback = {}) {
  try {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function evolutionMessageContent(row) {
  const message = safeJsonParse(row.message);
  const type = row.messageType;

  if (type === 'conversation') return String(message.conversation || '');
  if (type === 'extendedTextMessage') return String(message.extendedTextMessage?.text || '');
  if (type === 'imageMessage') return ['_<Image Message>_', message.imageMessage?.caption].filter(Boolean).join('\n');
  if (type === 'videoMessage') return ['_<Video Message>_', message.videoMessage?.caption].filter(Boolean).join('\n');
  if (type === 'audioMessage') return '_<Audio Message>_';
  if (type === 'stickerMessage') return '_<Sticker Message>_';
  if (type === 'documentMessage') return ['_<Document Message>_', message.documentMessage?.fileName || message.documentMessage?.title].filter(Boolean).join(' ');
  if (type === 'contactMessage') return ['_<Contact Message>_', message.contactMessage?.displayName].filter(Boolean).join(' ');
  if (type === 'interactiveMessage') {
    return [
      message.interactiveMessage?.header?.title,
      message.interactiveMessage?.body?.text,
      message.interactiveMessage?.contextInfo?.externalAdReply?.title,
      message.interactiveMessage?.contextInfo?.externalAdReply?.body,
    ].filter(Boolean).join('\n\n');
  }
  return `_<${type || 'Unknown Message'}>_`;
}

function mediaKindFromMessageType(type) {
  if (type === 'imageMessage') return 'image';
  if (type === 'videoMessage') return 'video';
  if (type === 'audioMessage') return 'audio';
  if (type === 'stickerMessage') return 'image';
  if (type === 'documentMessage') return 'file';
  return null;
}

function mediaNodeForMessage(message, type) {
  if (!message || !type) return {};
  return message[type] || {};
}

function extensionFromMime(mime) {
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  const known = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'application/pdf': 'pdf',
  };
  return known[value] || value.split('/')[1]?.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'bin';
}

function evolutionMediaInfo(row) {
  const kind = mediaKindFromMessageType(row.messageType);
  if (!kind) return null;

  const message = safeJsonParse(row.message);
  const node = mediaNodeForMessage(message, row.messageType);
  const mime = String(node.mimetype || node.mimeType || '').split(';')[0] || 'application/octet-stream';
  const fallbackName = `${String(row.wa_id || row.id || Date.now()).replace(/[^A-Za-z0-9_.-]/g, '-')}.${extensionFromMime(mime)}`;
  const name = String(node.fileName || node.title || fallbackName).slice(0, 180);

  return {
    kind,
    mime,
    name,
    caption: String(node.caption || '').trim(),
  };
}

function parseEvolutionBase64Media(data) {
  const candidates = [
    data?.base64,
    data?.data?.base64,
    data?.message?.base64,
    data?.media?.base64,
  ].filter(Boolean);
  const raw = String(candidates[0] || '').trim();
  if (!raw) return null;
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  return {
    base64: match ? match[2] : raw,
    mime: match ? match[1] : (data?.mimetype || data?.mimeType || data?.data?.mimetype || ''),
    name: data?.fileName || data?.filename || data?.data?.fileName || '',
  };
}

async function downloadEvolutionMedia(instanceName, row) {
  const key = safeJsonParse(row.key);
  if (!instanceName || !key?.id) return null;

  const response = await evoFetch(`/chat/getBase64FromMediaMessage/${instanceName}`, {
    method: 'POST',
    body: JSON.stringify({
      message: { key },
      convertToMp4: false,
    }),
  });

  if (response.status >= 300) return null;
  return parseEvolutionBase64Media(response.data);
}

function chatwootMessageIdFromResponse(data) {
  return Number(data?.id || data?.message?.id || data?.payload?.id || data?.data?.id || 0) || null;
}

async function createChatwootMessageViaApi({ client, userToken, conversation, content, messageType, media }) {
  const form = new FormData();
  form.append('content', content || '');
  form.append('message_type', messageType);
  form.append('private', 'false');

  if (media?.base64) {
    const bytes = Buffer.from(media.base64, 'base64');
    const blob = new Blob([bytes], { type: media.mime || 'application/octet-stream' });
    form.append('attachments[]', blob, media.name || 'arquivo');
  }

  const response = await cwtAccountFetch(
    `/api/v1/accounts/${client.chatwoot_account_id}/conversations/${conversation.display_id || conversation.id}/messages`,
    userToken,
    {
      method: 'POST',
      body: form,
    },
  );

  return {
    response,
    messageId: response.status < 300 ? chatwootMessageIdFromResponse(response.data) : null,
  };
}

function evolutionRemoteJid(key = {}) {
  return key.remoteJidAlt || key.remoteJid || key.remotejidalt || key.remotejid || '';
}

async function updateEvolutionMessageChatwootLink(row, values) {
  const params = [
    values.messageId,
    values.inboxId,
    values.conversationId,
    values.contactInboxSourceId,
    row.id,
  ];
  const byId = await evolutionPool.query(
    'UPDATE "Message" SET "chatwootMessageId" = $1, "chatwootInboxId" = $2, "chatwootConversationId" = $3, "chatwootContactInboxSourceId" = $4, "chatwootIsRead" = true WHERE id = $5',
    params,
  );
  if (byId.rowCount || !row.instance_id || !row.wa_id) return byId.rowCount;

  const byWaId = await evolutionPool.query(
    'UPDATE "Message" SET "chatwootMessageId" = $1, "chatwootInboxId" = $2, "chatwootConversationId" = $3, "chatwootContactInboxSourceId" = $4, "chatwootIsRead" = true WHERE "instanceId" = $5 AND key->>\'id\' = $6',
    [values.messageId, values.inboxId, values.conversationId, values.contactInboxSourceId, row.instance_id, row.wa_id],
  );
  return byWaId.rowCount;
}

async function markEvolutionMessageSkipped(row) {
  const byId = await evolutionPool.query(
    'UPDATE "Message" SET "chatwootMessageId" = -1, "chatwootIsRead" = true WHERE id = $1 AND ("chatwootMessageId" IS NULL OR "chatwootMessageId" = 0)',
    [row.id],
  );
  if (byId.rowCount || !row.instance_id || !row.wa_id) return byId.rowCount;

  const byWaId = await evolutionPool.query(
    'UPDATE "Message" SET "chatwootMessageId" = -1, "chatwootIsRead" = true WHERE "instanceId" = $1 AND key->>\'id\' = $2 AND ("chatwootMessageId" IS NULL OR "chatwootMessageId" = 0)',
    [row.instance_id, row.wa_id],
  );
  return byWaId.rowCount;
}

function jidPhone(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  return `+${jid.split('@')[0].replace(/\D/g, '')}`;
}

function contactNameFromEvolution(row, remoteJid) {
  const chatName = String(row.chat_name || row.name || '').trim();
  const pushName = String(row.pushName || row.pushname || '').trim();
  if (chatName && chatName !== 'Você') return chatName;
  if (pushName && pushName !== 'Você') return pushName;
  return String(remoteJid || '').split('@')[0] || 'Contato';
}

function evolutionDate(value, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function ensureCwtThreadForRemoteJid({
  client,
  remoteJid,
  displayName,
  createdAt,
  conversationCache,
  stats,
}) {
  if (!remoteJid || remoteJid === 'status@broadcast') return null;

  const cacheKey = String(remoteJid);
  const cached = conversationCache.get(cacheKey);
  if (cached) return cached;

  const sourceId = `evolution:${remoteJid}`;
  const createdDate = evolutionDate(createdAt);
  const contactName = String(displayName || '').trim() || remoteJid.split('@')[0] || 'Contato';
  const phone = jidPhone(remoteJid);

  let contact = await pool.query(
    'SELECT id, name, identifier FROM contacts WHERE account_id = $1 AND identifier = $2 LIMIT 1',
    [client.chatwoot_account_id, remoteJid],
  );

  if (!contact.rowCount) {
    contact = await pool.query(
      `
        INSERT INTO contacts
          (name, phone_number, account_id, created_at, updated_at, additional_attributes, identifier, custom_attributes, contact_type, middle_name, last_name, location, country_code, blocked)
        VALUES
          ($1, $2, $3, $4, $4, '{}', $5, '{}', 0, '', '', '', '', false)
        RETURNING id, name, identifier
      `,
      [contactName, phone, client.chatwoot_account_id, createdDate, remoteJid],
    );
    if (stats) stats.contacts_created += 1;
  } else if (
    contact.rows[0].name !== contactName &&
    contact.rows[0].identifier === remoteJid &&
    (!contact.rows[0].name || contact.rows[0].name === contact.rows[0].identifier)
  ) {
    await pool.query(
      'UPDATE contacts SET name = $1, updated_at = GREATEST(updated_at, $2) WHERE id = $3',
      [contactName, createdDate, contact.rows[0].id],
    );
  }

  let contactInbox = await pool.query(
    'SELECT id, source_id FROM contact_inboxes WHERE inbox_id = $1 AND source_id = $2 LIMIT 1',
    [client.inbox_id, sourceId],
  );

  if (!contactInbox.rowCount) {
    contactInbox = await pool.query(
      `
        INSERT INTO contact_inboxes
          (contact_id, inbox_id, source_id, created_at, updated_at, hmac_verified, pubsub_token)
        VALUES
          ($1, $2, $3, $4, $4, false, $5)
        RETURNING id, source_id
      `,
      [contact.rows[0].id, client.inbox_id, sourceId, createdDate, randomBytes(16).toString('hex')],
    );
  }

  let conversation = await pool.query(
    'SELECT id, display_id, contact_id, contact_inbox_id FROM conversations WHERE account_id = $1 AND inbox_id = $2 AND contact_inbox_id = $3 LIMIT 1',
    [client.chatwoot_account_id, client.inbox_id, contactInbox.rows[0].id],
  );

  if (!conversation.rowCount) {
    conversation = await pool.query(
      `
        INSERT INTO conversations
          (account_id, inbox_id, status, created_at, updated_at, contact_id, contact_inbox_id, additional_attributes, custom_attributes, last_activity_at, identifier)
        VALUES
          ($1, $2, 0, $3, $3, $4, $5, '{}', '{}', $3, $6)
        RETURNING id, display_id, contact_id, contact_inbox_id
      `,
      [client.chatwoot_account_id, client.inbox_id, createdDate, contact.rows[0].id, contactInbox.rows[0].id, remoteJid],
    );
    if (stats) stats.conversations_created += 1;
  }

  const conversationData = {
    id: conversation.rows[0].id,
    display_id: conversation.rows[0].display_id || conversation.rows[0].id,
    contact_id: conversation.rows[0].contact_id || contact.rows[0].id,
    contact_inbox_source_id: contactInbox.rows[0].source_id,
  };

  conversationCache.set(cacheKey, conversationData);
  return conversationData;
}

async function importEvolutionHistoryForClient(client, options = {}) {
  if (!EVOLUTION_CHATWOOT_DIRECT_DB_IMPORT_ENABLED) {
    const error = new Error(directEvolutionImportDisabledPayload().message);
    error.code = 'EVOLUTION_CHATWOOT_DIRECT_DB_IMPORT_DISABLED';
    throw error;
  }

  if (!client.instance_name || !client.chatwoot_account_id || !client.inbox_id) {
    throw new Error('client is missing instance/account/inbox');
  }

  const syncSettings = options.syncSettings !== false;
  const ensureAllThreads = options.ensureAllThreads !== false;
  const pendingLimit = Math.min(Math.max(Number(options.pendingLimit || 0), 0), 500);
  const throttleMs = Math.min(Math.max(Number(options.throttleMs || 0), 0), 2000);

  const instance = await evolutionPool.query('SELECT id FROM "Instance" WHERE name = $1 LIMIT 1', [client.instance_name]);
  if (!instance.rowCount) throw new Error(`Evolution instance not found: ${client.instance_name}`);
  const instanceId = instance.rows[0].id;

  let userId = client.chatwoot_user_id || null;
  if (!userId && client.chatwoot_user_email) {
    userId = await getCwtUserIdByEmail(client.chatwoot_user_email);
    if (userId) await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1 WHERE id = $2', [userId, client.id]);
  }
  if (!userId) {
    const fallback = await pool.query(
      'SELECT users.id FROM users INNER JOIN account_users ON account_users.user_id = users.id WHERE account_users.account_id = $1 ORDER BY users.id LIMIT 1',
      [client.chatwoot_account_id],
    );
    userId = fallback.rows[0]?.id || null;
  }
  if (!userId) throw new Error(`No Fluvius user found for account ${client.chatwoot_account_id}`);

  let userToken = null;
  if (syncSettings) {
    userToken = await getPlatformUserToken(userId);
    if (userToken) await enableEvolutionHistorySync(
      client.instance_name,
      client.chatwoot_account_id,
      userToken,
      client.channel_display_name,
    );
  }

  const [contactsResult, chatsResult, evolutionRows] = await Promise.all([
    ensureAllThreads
      ? evolutionPool.query(
          `
            SELECT
              id,
              "remoteJid" AS remoteJid,
              "pushName" AS pushName,
              "createdAt" AS createdAt,
              "updatedAt" AS updatedAt
            FROM "Contact"
            WHERE "instanceId" = $1
            ORDER BY "createdAt" ASC, id ASC
          `,
          [instanceId],
        )
      : Promise.resolve({ rows: [], rowCount: 0 }),
    ensureAllThreads
      ? evolutionPool.query(
          `
            SELECT
              id,
              name,
              "remoteJid" AS remoteJid,
              "createdAt" AS createdAt,
              "updatedAt" AS updatedAt
            FROM "Chat"
            WHERE "instanceId" = $1
            ORDER BY "createdAt" ASC, id ASC
          `,
          [instanceId],
        )
      : Promise.resolve({ rows: [], rowCount: 0 }),
    evolutionPool.query(
      `
        SELECT
          m.id,
          m."instanceId" AS instance_id,
          m.key->>'id' AS wa_id,
          m.key,
          m."pushName",
          m."messageType",
          m.message,
          m."messageTimestamp",
          m."chatwootMessageId",
          c.name AS chat_name
        FROM "Message" m
        LEFT JOIN "Chat" c
          ON c."instanceId" = m."instanceId"
         AND c."remoteJid" = COALESCE(m.key->>'remoteJidAlt', m.key->>'remoteJid')
        WHERE m."instanceId" = $1
          AND (m."chatwootMessageId" IS NULL OR m."chatwootMessageId" = 0)
          AND COALESCE(m.key->>'remoteJidAlt', m.key->>'remoteJid') <> 'status@broadcast'
        ORDER BY m."messageTimestamp" ASC, m.id ASC
        ${pendingLimit > 0 ? 'LIMIT $2' : ''}
      `,
      pendingLimit > 0 ? [instanceId, pendingLimit] : [instanceId],
    ),
  ]);

  const stats = {
    contacts_found: contactsResult.rowCount,
    chats_found: chatsResult.rowCount,
    messages_found: evolutionRows.rowCount,
    contacts_created: 0,
    conversations_created: 0,
    threads_ensured: 0,
    messages_imported: 0,
    messages_relinked: 0,
    messages_skipped: 0,
    media_imported: 0,
    media_pending: 0,
  };
  const conversationCache = new Map();
  const seenRemoteJids = new Set();

  for (const row of contactsResult.rows) {
    const remoteJid = evolutionRemoteJid(row);
    if (!remoteJid || remoteJid === 'status@broadcast' || seenRemoteJids.has(remoteJid)) continue;
    await ensureCwtThreadForRemoteJid({
      client,
      remoteJid,
      displayName: contactNameFromEvolution(row, remoteJid),
      createdAt: row.createdAt,
      conversationCache,
      stats,
    });
    seenRemoteJids.add(remoteJid);
    stats.threads_ensured += 1;
  }

  for (const row of chatsResult.rows) {
    const remoteJid = evolutionRemoteJid(row);
    if (!remoteJid || remoteJid === 'status@broadcast' || seenRemoteJids.has(remoteJid)) continue;
    await ensureCwtThreadForRemoteJid({
      client,
      remoteJid,
      displayName: contactNameFromEvolution(row, remoteJid),
      createdAt: row.createdAt,
      conversationCache,
      stats,
    });
    seenRemoteJids.add(remoteJid);
    stats.threads_ensured += 1;
  }

  let processedRows = 0;
  for (const row of evolutionRows.rows) {
    if (processedRows > 0 && throttleMs > 0) await sleep(throttleMs);
    processedRows += 1;

    const key = safeJsonParse(row.key);
    const remoteJid = evolutionRemoteJid(key);
    if (!remoteJid || remoteJid === 'status@broadcast') {
      await markEvolutionMessageSkipped(row);
      stats.messages_skipped += 1;
      continue;
    }

    const keyId = String(key.id || row.id);
    const sourceId = `WAID:${keyId}`;
    const existingMessage = await pool.query(
      `
        SELECT messages.id, messages.inbox_id, messages.conversation_id, contact_inboxes.source_id AS contact_inbox_source_id
        FROM messages
        INNER JOIN conversations ON conversations.id = messages.conversation_id
        LEFT JOIN contact_inboxes ON contact_inboxes.id = conversations.contact_inbox_id
        WHERE messages.source_id = $1
        LIMIT 1
      `,
      [sourceId],
    );

    if (existingMessage.rowCount) {
      const existing = existingMessage.rows[0];
      await updateEvolutionMessageChatwootLink(row, {
        messageId: existing.id,
        inboxId: existing.inbox_id,
        conversationId: existing.conversation_id,
        contactInboxSourceId: existing.contact_inbox_source_id,
      });
      stats.messages_relinked += 1;
      continue;
    }

    const content = evolutionMessageContent(row).trim();
    const createdAt = new Date(Number(row.messageTimestamp) * 1000);
    const contactName = contactNameFromEvolution(row, remoteJid);
    const conversation = await ensureCwtThreadForRemoteJid({
      client,
      remoteJid,
      displayName: contactName,
      createdAt,
      conversationCache,
      stats,
    });
    if (!conversation) {
      await markEvolutionMessageSkipped(row);
      stats.messages_skipped += 1;
      continue;
    }

    if (!content) {
      await markEvolutionMessageSkipped(row);
      stats.messages_skipped += 1;
      continue;
    }

    const fromMe = key.fromMe === true || String(key.fromMe) === 'true';
    const senderType = fromMe ? 'User' : 'Contact';
    const senderId = fromMe ? userId : conversation.contact_id;
    const messageType = fromMe ? 1 : 0;
    const mediaInfo = evolutionMediaInfo(row);

    if (mediaInfo && !fromMe) {
      const downloadedMedia = await downloadEvolutionMedia(client.instance_name, row);
      if (!downloadedMedia?.base64) {
        stats.media_pending += 1;
        continue;
      }

      userToken ||= await getPlatformUserToken(userId);
      if (!userToken) {
        stats.media_pending += 1;
        continue;
      }

      const apiMessage = await createChatwootMessageViaApi({
        client,
        userToken,
        conversation,
        content,
        messageType: fromMe ? 'outgoing' : 'incoming',
        media: {
          base64: downloadedMedia.base64,
          mime: downloadedMedia.mime || mediaInfo.mime,
          name: downloadedMedia.name || mediaInfo.name,
        },
      });

      if (!apiMessage.messageId) {
        stats.media_pending += 1;
        continue;
      }

      await pool.query(
        'UPDATE messages SET source_id = $1, updated_at = GREATEST(updated_at, $2) WHERE id = $3 AND account_id = $4',
        [sourceId, createdAt, apiMessage.messageId, client.chatwoot_account_id],
      );

      await updateEvolutionMessageChatwootLink(row, {
        messageId: apiMessage.messageId,
        inboxId: client.inbox_id,
        conversationId: conversation.id,
        contactInboxSourceId: conversation.contact_inbox_source_id,
      });

      stats.messages_imported += 1;
      stats.media_imported += 1;
      continue;
    }

    const message = await pool.query(
      `
        INSERT INTO messages
          (content, account_id, inbox_id, conversation_id, message_type, created_at, updated_at, private, status, source_id, content_type, content_attributes, sender_type, sender_id, external_source_ids, additional_attributes, processed_message_content, sentiment)
        VALUES
          ($1, $2, $3, $4, $5, $6, $6, false, 0, $7, 0, '{}', $8, $9, '{}', '{}', $1, '{}')
        RETURNING id
      `,
      [content, client.chatwoot_account_id, client.inbox_id, conversation.id, messageType, createdAt, sourceId, senderType, senderId],
    );

    await pool.query(
      'UPDATE conversations SET last_activity_at = GREATEST(last_activity_at, $1), updated_at = GREATEST(updated_at, $1) WHERE id = $2',
      [createdAt, conversation.id],
    );

    await updateEvolutionMessageChatwootLink(row, {
      messageId: message.rows[0].id,
      inboxId: client.inbox_id,
      conversationId: conversation.id,
      contactInboxSourceId: conversation.contact_inbox_source_id,
    });

    stats.messages_imported += 1;
  }

  return {
    client_id: client.id,
    instance_name: client.instance_name,
    account_id: client.chatwoot_account_id,
    inbox_id: client.inbox_id,
    pending_limit: pendingLimit,
    throttle_ms: throttleMs,
    ensure_all_threads: ensureAllThreads,
    ...stats,
  };
}

// Health endpoint for manager
app.get('/manager/api/health', async (_req, res) => {
  const evo = await evoFetch('/instance/fetchInstances');
  const cwt = CHATWOOT_API_TOKEN ? await cwtFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes`) : { status: 401, data: 'No token' };
  res.json({
    evolution: evo.status < 300 ? 'ok' : 'error',
    evolution_status: evo.status,
    chatwoot: cwt.status < 300 ? 'ok' : 'error',
    chatwoot_status: cwt.status,
    has_token: !!CHATWOOT_API_TOKEN,
    has_platform_token: !!CHATWOOT_PLATFORM_TOKEN,
  });
});

// List all Evolution instances
app.get('/manager/api/instances', async (_req, res) => {
  const { status, data } = await evoFetch('/instance/fetchInstances');
  res.status(status).json(data);
});

// Get QR code for an instance
app.get('/manager/api/instances/:name/qr', async (req, res) => {
  const { status, data } = await evoFetch(`/instance/connect/${req.params.name}`);
  res.status(status).json(data);
});

// Get connection status
app.get('/manager/api/instances/:name/status', async (req, res) => {
  const { status, data } = await evoFetch(`/instance/connectionState/${req.params.name}`);
  res.status(status).json(data);
});

// Create instance + Fluvius inbox and link them
app.post('/manager/api/instances', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!CHATWOOT_API_TOKEN) return res.status(400).json({ error: 'CHATWOOT_USER_ACCESS_TOKEN is not configured in environment' });

  // 1. Create Evolution instance
  const evo = await evoFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify({ instanceName: name, integration: 'WHATSAPP-BAILEYS' }),
  });
  if (evo.status >= 300) return res.status(evo.status).json({ step: 'create_instance', error: evo.data });

  // 2. Create Fluvius inbox
  const cwt = await cwtFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes`, {
    method: 'POST',
    body: JSON.stringify({ name, channel: { type: 'api', webhook_url: '' } }),
  });
  if (cwt.status >= 300) return res.status(cwt.status).json({ step: 'create_inbox', error: cwt.data });

  // 3. Link Evolution → Fluvius
  const link = await evoFetch(`/chatwoot/set/${name}`, {
    method: 'POST',
    body: JSON.stringify(evolutionChatwootPayload(CHATWOOT_ACCOUNT_ID, CHATWOOT_API_TOKEN, name)),
  });
  if (link.status >= 300) return res.status(link.status).json({ step: 'link_chatwoot', error: link.data });

  const webhook = await cwtFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes/${cwt.data?.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ channel: { webhook_url: expectedInboxWebhookUrl(name) } }),
  });
  if (webhook.status >= 300) return res.status(webhook.status).json({ step: 'update_inbox_webhook', error: webhook.data });

  res.json({ instance: evo.data, inbox: cwt.data, link: link.data, webhook: webhook.data });
});

// Delete instance
app.delete('/manager/api/instances/:name', async (req, res) => {
  const { status, data } = await evoFetch(`/instance/delete/${req.params.name}`, { method: 'DELETE' });
  res.status(status).json(data);
});

// Logout instance
app.post('/manager/api/instances/:name/logout', async (req, res) => {
  const { status, data } = await evoFetch(`/instance/logout/${req.params.name}`, { method: 'DELETE' });
  res.status(status).json(data);
});

// Serve manager page
app.get('/manager', (_req, res) => {
  res.sendFile('manager.html', { root: 'public' });
});

// ─── Client Provisioning ─────────────────────────────────────────────────────

// List clients
app.get('/manager/api/clients', async (req, res) => {
  const includeArchived = String(req.query.include_archived || '') === 'true';
  const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
  const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients ${where} ORDER BY created_at DESC`);
  res.json(rows.map(row => ({ ...row, chatwoot_url: CHATWOOT_PUBLIC_URL })));
});

// Client operational details for the manager UI.
app.get('/manager/api/clients/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  let agents = [];

  if (client.chatwoot_account_id) {
    const agentRows = await pool.query(
      `SELECT
         users.id,
         users.name,
         users.email,
         account_users.role
       FROM account_users
       INNER JOIN users ON users.id = account_users.user_id
       WHERE account_users.account_id = $1
       ORDER BY account_users.role DESC, users.name ASC`,
      [client.chatwoot_account_id],
    );
    agents = agentRows.rows.map(agent => {
      const role = String(agent.role);
      return {
        ...agent,
        role_label: role === '1' || role === 'administrator' ? 'Administrador' : 'Agente',
      };
    });
  }

  res.json({
    ...client,
    chatwoot_url: CHATWOOT_PUBLIC_URL,
    agents,
  });
});

// Rename the visible WhatsApp channel/inbox name for manager operations.
app.patch('/manager/api/clients/:id/channel-name', async (req, res) => {
  const id = Number(req.params.id);
  const channelDisplayName = String(req.body?.channel_display_name || '').trim();
  if (!channelDisplayName) return res.status(400).json({ error: 'channel_display_name is required' });
  if (channelDisplayName.length > 80) return res.status(400).json({ error: 'channel_display_name is too long' });

  const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id || !client.inbox_id) {
    return res.status(400).json({ error: 'client is missing Fluvius account or inbox' });
  }

  let adminUserId = client.chatwoot_user_id || null;
  if (!adminUserId && client.chatwoot_user_email) {
    adminUserId = await getCwtUserIdByEmail(client.chatwoot_user_email);
    if (adminUserId) {
      await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1 WHERE id = $2', [adminUserId, id]);
    }
  }
  if (!adminUserId) return res.status(404).json({ error: 'client admin user not found' });

  const userToken = await getPlatformUserToken(adminUserId);
  if (!userToken) return res.status(400).json({ error: 'could not create Fluvius admin token' });

  const chatwootUpdate = await cwtAccountFetch(
    `/api/v1/accounts/${client.chatwoot_account_id}/inboxes/${client.inbox_id}`,
    userToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ name: channelDisplayName }),
    },
  );
  if (chatwootUpdate.status >= 300) {
    return res.status(chatwootUpdate.status).json({
      step: 'rename_channel',
      error: chatwootUpdate.data,
    });
  }

  const inbox = await pool.query(
    `UPDATE inboxes
     SET name = $1, updated_at = NOW()
     WHERE id = $2 AND account_id = $3
     RETURNING id, name`,
    [channelDisplayName, client.inbox_id, client.chatwoot_account_id],
  );
  if (!inbox.rowCount) return res.status(404).json({ error: 'Fluvius inbox not found for this client' });

  const updated = await pool.query(
    `UPDATE fluvius_clients
     SET channel_display_name = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING ${CLIENT_PUBLIC_FIELDS}`,
    [channelDisplayName, id],
  );

  const chatwootLink = await evoFetch(`/chatwoot/set/${client.instance_name}`, {
    method: 'POST',
    body: JSON.stringify(evolutionChatwootPayload(
      client.chatwoot_account_id,
      userToken,
      channelDisplayName,
    )),
  });
  if (chatwootLink.status >= 300) {
    return res.status(chatwootLink.status).json({
      step: 'update_evolution_chatwoot_link',
      error: chatwootLink.data,
    });
  }

  res.json({
    ...updated.rows[0],
    chatwoot_url: CHATWOOT_PUBLIC_URL,
    inbox_name: inbox.rows[0].name,
    chatwoot_link: chatwootLink.data,
  });
});

app.get('/manager/api/clients/:id/crm/summary', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });

    const client = rows[0];
    if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

    const summary = await crmSummaryForAccount(client.chatwoot_account_id);
    res.json({ client_id: id, ...summary });
  } catch (err) {
    res.status(500).json({ step: 'crm_summary', error: err.message });
  }
});

app.get('/manager/api/clients/:id/crm/leads', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });

    const client = rows[0];
    if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

    const leads = await crmLeadsForAccount(client.chatwoot_account_id, req.query);
    res.json({ client_id: id, ...leads });
  } catch (err) {
    res.status(500).json({ step: 'crm_leads', error: err.message });
  }
});

app.post('/manager/api/clients/:id/crm/leads/:conversationId/stage', async (req, res) => {
  const id = Number(req.params.id);
  const conversationId = Number(req.params.conversationId);
  const stage = normalizeCrmStage(req.body?.stage);
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (!stage) return res.status(400).json({ error: 'invalid CRM stage' });

  const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

  const conversation = await pool.query(
    'SELECT id, display_id FROM conversations WHERE id = $1 AND account_id = $2 LIMIT 1',
    [conversationId, client.chatwoot_account_id],
  );
  if (!conversation.rowCount) return res.status(404).json({ error: 'conversation not found for this client' });

  await ensureCrmDefaults(client.chatwoot_account_id);

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const stageTags = await dbClient.query(
      'SELECT id FROM tags WHERE name = ANY($1::text[])',
      [CRM_STAGE_KEYS],
    );
    const removedTagIds = stageTags.rows.map(row => Number(row.id));

    if (removedTagIds.length) {
      await dbClient.query(
        `DELETE FROM taggings
         WHERE taggable_type = 'Conversation'
           AND context = 'labels'
           AND taggable_id = $1
           AND tag_id = ANY($2::int[])`,
        [conversationId, removedTagIds],
      );
    }

    let tag = await dbClient.query('SELECT id FROM tags WHERE name = $1 LIMIT 1', [stage.key]);
    if (!tag.rowCount) {
      tag = await dbClient.query('INSERT INTO tags (name, taggings_count) VALUES ($1, 0) RETURNING id', [stage.key]);
    }
    const tagId = Number(tag.rows[0].id);

    await dbClient.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at)
       SELECT $1, 'Conversation', $2, 'labels', NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM taggings
         WHERE tag_id = $1
           AND taggable_type = 'Conversation'
           AND taggable_id = $2
           AND context = 'labels'
       )`,
      [tagId, conversationId],
    );

    const labels = await updateConversationCachedLabels(dbClient, conversationId);
    await refreshTaggingCounts(dbClient, [...removedTagIds, tagId]);
    await dbClient.query('COMMIT');

    res.json({
      conversation_id: conversationId,
      display_id: conversation.rows[0].display_id,
      stage_key: stage.key,
      stage: stage.title,
      labels,
      chatwoot_url: conversationUrl(client.chatwoot_account_id, conversation.rows[0].display_id),
    });
  } catch (err) {
    await dbClient.query('ROLLBACK');
    res.status(500).json({ step: 'update_crm_stage', error: err.message });
  } finally {
    dbClient.release();
  }
});

app.post('/manager/api/clients/:id/crm/leads/:conversationId/analyze', async (req, res) => {
  const id = Number(req.params.id);
  const conversationId = Number(req.params.conversationId);
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

  try {
    const result = await analyzeCrmConversation(client.chatwoot_account_id, conversationId, {
      apply: req.body?.apply !== false,
    });
    if (!result) return res.status(404).json({ error: 'conversation not found for this client' });
    res.json({ client_id: id, ...result });
  } catch (err) {
    res.status(500).json({ step: 'crm_ai_analyze', error: err.message });
  }
});

app.post('/manager/api/clients/:id/crm/analyze', async (req, res) => {
  const id = Number(req.params.id);
  const limit = Math.min(Math.max(Number(req.body?.limit || req.query.limit || 10), 1), 30);

  const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

  try {
    const conversationIds = await crmConversationIdsForAutoAnalysis(client.chatwoot_account_id, limit);
    const results = [];
    const errors = [];

    for (const conversationId of conversationIds) {
      try {
        results.push(await analyzeCrmConversation(client.chatwoot_account_id, conversationId, {
          apply: req.body?.apply !== false,
        }));
      } catch (err) {
        errors.push({ conversation_id: conversationId, error: err.message });
      }
    }

    res.json({
      client_id: id,
      requested: conversationIds.length,
      analyzed: results.length,
      applied: results.filter(item => item?.applied).length,
      skipped: results.filter(item => item && !item.applied).length,
      results,
      errors,
    });
  } catch (err) {
    res.status(500).json({ step: 'crm_ai_batch_analyze', error: err.message });
  }
});

// Create and fully provision a client (multi-tenant: creates Fluvius account + user)
app.post('/manager/api/clients', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (!CHATWOOT_PLATFORM_TOKEN) return res.status(400).json({ error: 'CHATWOOT_PLATFORM_TOKEN is not configured. Create a Platform App in /super_admin and add the token to .env' });

  const existingLocal = await pool.query(
    'SELECT id FROM fluvius_clients WHERE lower(email) = lower($1) OR lower(chatwoot_user_email) = lower($1) LIMIT 1',
    [email],
  );
  if (existingLocal.rowCount) {
    return res.status(409).json({ step: 'validate_email', error: 'email_already_provisioned' });
  }

  const onboardToken = randomBytes(24).toString('base64url');
  const tempPassword = generateTempPassword();
  const instanceName = `fluvius-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 28)}-${Date.now().toString(36)}`;
  const channelDisplayName = `WhatsApp - ${name}`.slice(0, 80);
  const created = {};

  try {
    // STEP 1: Create Fluvius account for the company
    const acct = await platformFetch('/platform/api/v1/accounts', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (acct.status >= 300) {
      const err = provisioningError('create_chatwoot_account', acct);
      return res.status(err.status).json(err.body);
    }

    const accountId = acct.data?.id;
    if (!accountId) throw new Error('Fluvius account response did not include id');
    created.accountId = accountId;
    await ensureCrmDefaults(accountId);

    // STEP 2: Create Fluvius user (admin of the company)
    const usr = await platformFetch('/platform/api/v1/users', {
      method: 'POST',
      body: JSON.stringify({ name, email, password: tempPassword, role: 'agent', confirmed: true }),
    });
    if (usr.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('create_chatwoot_user', usr, cleanup);
      return res.status(err.status).json(err.body);
    }

    const userId = usr.data?.id;
    const userToken = usr.data?.access_token;
    if (!userId || !userToken) throw new Error('Fluvius user response did not include id/access_token');

    // STEP 3: Associate user to the new account as Administrator
    const assoc = await platformFetch(`/platform/api/v1/accounts/${accountId}/account_users`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, role: 'administrator' }),
    });
    if (assoc.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('associate_user', assoc, cleanup);
      return res.status(err.status).json(err.body);
    }

    // STEP 4: Create Evolution WhatsApp instance
    const evo = await evoFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({ instanceName, integration: 'WHATSAPP-BAILEYS' }),
    });
    if (evo.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('create_instance', evo, cleanup);
      return res.status(err.status).json(err.body);
    }
    created.instanceName = instanceName;

    // STEP 5: Create Fluvius inbox inside the company's account
    // Uses the user's token to create within the correct account
    const cwt = await cwtAccountFetch(`/api/v1/accounts/${accountId}/inboxes`, userToken, {
      method: 'POST',
      body: JSON.stringify({ name: channelDisplayName, channel: { type: 'api', webhook_url: '' } }),
    });
    if (cwt.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('create_inbox', cwt, cleanup);
      return res.status(err.status).json(err.body);
    }

    const inboxId = cwt.data?.id || null;
    const inboxToken = cwt.data?.inbox_identifier || '';
    if (!inboxId || !inboxToken) throw new Error('Fluvius inbox response did not include id/inbox_identifier');

    // STEP 6: Link Evolution to Fluvius using the user's access token.
    const link = await evoFetch(`/chatwoot/set/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify(evolutionChatwootPayload(accountId, userToken, channelDisplayName)),
    });
    if (link.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('link_chatwoot', link, cleanup);
      return res.status(err.status).json(err.body);
    }

    const historySync = await enableEvolutionHistorySync(instanceName, accountId, userToken, channelDisplayName);
    if (historySync.settings.status >= 300 || historySync.chatwoot.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      return res.status(500).json({
        step: 'enable_history_sync',
        error: { settings: historySync.settings.data, chatwoot: historySync.chatwoot.data },
        cleanup,
      });
    }

    // STEP 7: Update inbox webhook so Fluvius replies go back to Evolution.
    const evolutionWebhookUrl = expectedInboxWebhookUrl(instanceName);
    const webhook = await cwtAccountFetch(`/api/v1/accounts/${accountId}/inboxes/${inboxId}`, userToken, {
      method: 'PATCH',
      body: JSON.stringify({ channel: { webhook_url: evolutionWebhookUrl } }),
    });
    if (webhook.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('update_inbox_webhook', webhook, cleanup);
      return res.status(err.status).json(err.body);
    }

    // STEP 8: Save to DB. Password is intentionally not persisted.
    const { rows } = await pool.query(
      `INSERT INTO fluvius_clients
        (name, email, token, instance_name, channel_display_name, inbox_id, inbox_token, status, chatwoot_account_id, chatwoot_user_id, chatwoot_user_email, integration_status, integration_last_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, 'ok', NOW())
       RETURNING ${CLIENT_PUBLIC_FIELDS}`,
      [name, email, onboardToken, instanceName, channelDisplayName, inboxId, inboxToken, accountId, userId, email],
    );

    const insertedClient = rows[0];

    // --- PROVISION DEFAULT AUTOMATIONS ---
    try {
      const userToken = await getPlatformUserToken(userId);
      if (userToken) {
        // 1. Tag new-lead
        await fetch(`${CHATWOOT_URL}/api/v1/accounts/${accountId}/automation_rules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', api_access_token: userToken },
          body: JSON.stringify({
            name: 'Etiquetar novo lead',
            description: 'Etiqueta todas as novas conversas automaticamente',
            event_name: 'conversation_created',
            conditions: [{ attribute_key: 'status', filter_operator: 'equal_to', values: ['open'] }],
            actions: [{ action_name: 'add_label', action_params: ['novo-lead'] }]
          })
        });

        // 2. Welcome message (if configured)
        const welcomeMessage = process.env.DEFAULT_WELCOME_MESSAGE;
        if (welcomeMessage) {
          await fetch(`${CHATWOOT_URL}/api/v1/accounts/${accountId}/automation_rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', api_access_token: userToken },
            body: JSON.stringify({
              name: 'Mensagem de Boas-vindas',
              description: 'Envia mensagem automática na primeira interação',
              event_name: 'conversation_created',
              conditions: [{ attribute_key: 'status', filter_operator: 'equal_to', values: ['open'] }],
              actions: [{ action_name: 'send_message', action_params: [welcomeMessage] }]
            })
          });
        }
      }
    } catch (autoErr) {
      console.error('Failed to provision default automations:', autoErr);
    }

    return res.json({ ...insertedClient, chatwoot_temp_password: tempPassword, chatwoot_url: CHATWOOT_PUBLIC_URL });
  } catch (err) {
    const cleanup = await cleanupProvisioning(created);
    return res.status(500).json({
      step: 'provision_client',
      error: err.message,
      cleanup,
    });
  }
});

// Create agents for a client account and add them to the client's WhatsApp inbox.
app.post('/manager/api/clients/:id/agents', async (req, res) => {
  const id = Number(req.params.id);
  const agents = parseAgentPayload(req.body?.agents);
  if (!agents.length) return res.status(400).json({ error: 'agents are required' });
  if (agents.length > 50) return res.status(400).json({ error: 'maximum 50 agents per request' });

  const uniqueEmails = new Set(agents.map(agent => agent.email));
  if (uniqueEmails.size !== agents.length) {
    return res.status(400).json({ error: 'duplicated agent email in request' });
  }

  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id || !client.inbox_id) {
    return res.status(400).json({ error: 'client is missing chatwoot account or inbox' });
  }

  let adminUserId = client.chatwoot_user_id || null;
  if (!adminUserId && client.chatwoot_user_email) {
    adminUserId = await getCwtUserIdByEmail(client.chatwoot_user_email);
    if (adminUserId) {
      await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1 WHERE id = $2', [adminUserId, id]);
    }
  }

  if (!adminUserId) return res.status(400).json({ error: 'client admin user not found' });

  const adminToken = await getPlatformUserToken(adminUserId);
  if (!adminToken) return res.status(400).json({ error: 'client admin token not available' });

  const createdAgents = [];
  const createdUserIds = [];

  try {
    for (const agent of agents) {
      const password = generateTempPassword();
      const user = await platformFetch('/platform/api/v1/users', {
        method: 'POST',
        body: JSON.stringify({
          name: agent.name,
          email: agent.email,
          password,
          custom_attributes: { provisioned_by: 'fluvius_manager', client_id: String(id) },
        }),
      });

      if (user.status >= 300) {
        return res.status(user.status).json({
          step: 'create_agent_user',
          error: user.data,
          created_agents: createdAgents,
        });
      }

      const userId = user.data?.id;
      if (!userId) throw new Error(`Fluvius agent response did not include id for ${agent.email}`);
      createdUserIds.push(userId);

      const assoc = await platformFetch(`/platform/api/v1/accounts/${client.chatwoot_account_id}/account_users`, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, role: 'agent' }),
      });

      if (assoc.status >= 300) {
        return res.status(assoc.status).json({
          step: 'associate_agent',
          error: assoc.data,
          created_agents: createdAgents,
        });
      }

      createdAgents.push({
        id: userId,
        name: agent.name,
        email: agent.email,
        chatwoot_temp_password: password,
      });
    }

    const inboxMembers = await cwtAccountFetch(
      `/api/v1/accounts/${client.chatwoot_account_id}/inbox_members`,
      adminToken,
      {
        method: 'POST',
        body: JSON.stringify({ inbox_id: client.inbox_id, user_ids: createdUserIds }),
      },
    );

    if (inboxMembers.status >= 300) {
      return res.status(inboxMembers.status).json({
        step: 'add_agents_to_inbox',
        error: inboxMembers.data,
        created_agents: createdAgents,
      });
    }

    return res.json({
      client_id: id,
      account_id: client.chatwoot_account_id,
      inbox_id: client.inbox_id,
      agents: createdAgents,
    });
  } catch (err) {
    return res.status(500).json({
      step: 'create_agents',
      error: err.message,
      created_agents: createdAgents,
    });
  }
});

app.get('/reset-password/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.get('/api/password-reset/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const result = await findValidPasswordResetToken(token);
  if (result.error) return res.status(400).json({ error: result.error });
  return res.json({
    user: sanitizeResetUser(result.row),
    expires_at: result.row.expires_at,
    chatwoot_url: CHATWOOT_PUBLIC_URL,
  });
});

app.post('/api/password-reset/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const password = String(req.body?.password || '');
  const passwordConfirmation = String(req.body?.password_confirmation || '');

  if (!CHATWOOT_PLATFORM_TOKEN) return res.status(400).json({ error: 'CHATWOOT_PLATFORM_TOKEN is not configured' });
  if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });
  if (password !== passwordConfirmation) return res.status(400).json({ error: 'password_confirmation_mismatch' });

  const result = await findValidPasswordResetToken(token);
  if (result.error) return res.status(400).json({ error: result.error });

  const consumed = await pool.query(
    `
      UPDATE fluvius_password_reset_tokens
      SET used_at = NOW()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING token_hash
    `,
    [result.row.token_hash],
  );
  if (!consumed.rowCount) return res.status(400).json({ error: 'token_already_used' });

  const reset = await resetCwtUserPassword(result.row.id, password);
  if (reset.status >= 300) {
    return res.status(reset.status).json({
      step: 'reset_password_with_token',
      error: reset.data,
    });
  }

  return res.json({
    ok: true,
    user: sanitizeResetUser(result.row),
    chatwoot_url: CHATWOOT_PUBLIC_URL,
  });
});

// Generate a one-use password reset link for the company administrator.
app.post('/manager/api/clients/:id/admin/password-reset-link', async (req, res) => {
  const id = Number(req.params.id);
  if (!CHATWOOT_PLATFORM_TOKEN) return res.status(400).json({ error: 'CHATWOOT_PLATFORM_TOKEN is not configured' });

  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

  let userId = client.chatwoot_user_id || null;
  if (!userId && client.chatwoot_user_email) {
    userId = await getCwtUserIdByEmail(client.chatwoot_user_email);
    if (userId) await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1 WHERE id = $2', [userId, id]);
  }

  if (!userId) return res.status(404).json({ error: 'client admin user not found' });

  const membership = await pool.query(
    `SELECT users.id, users.name, users.email, account_users.role
     FROM account_users
     INNER JOIN users ON users.id = account_users.user_id
     WHERE account_users.account_id = $1
       AND users.id = $2
     LIMIT 1`,
    [client.chatwoot_account_id, userId],
  );
  if (!membership.rowCount) return res.status(404).json({ error: 'client admin user is not linked to this account' });

  const link = await createPasswordResetLink({
    clientId: id,
    accountId: client.chatwoot_account_id,
    userId,
  });

  return res.json({
    ...link,
    user: {
      id: userId,
      name: membership.rows[0].name || client.name,
      email: membership.rows[0].email || client.chatwoot_user_email || client.email,
      role_label: 'Administrador',
    },
    chatwoot_url: CHATWOOT_PUBLIC_URL,
  });
});

// Generate a one-use password reset link for a company agent.
app.post('/manager/api/clients/:id/agents/:userId/password-reset-link', async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!CHATWOOT_PLATFORM_TOKEN) return res.status(400).json({ error: 'CHATWOOT_PLATFORM_TOKEN is not configured' });

  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

  const membership = await pool.query(
    `SELECT users.id, users.name, users.email, account_users.role
     FROM account_users
     INNER JOIN users ON users.id = account_users.user_id
     WHERE account_users.account_id = $1
       AND users.id = $2
     LIMIT 1`,
    [client.chatwoot_account_id, userId],
  );
  if (!membership.rowCount) return res.status(404).json({ error: 'agent not found for this client' });

  const link = await createPasswordResetLink({
    clientId: id,
    accountId: client.chatwoot_account_id,
    userId,
  });

  return res.json({
    ...link,
    user: {
      id: userId,
      name: membership.rows[0].name,
      email: membership.rows[0].email,
      role_label: 'Agente',
    },
    chatwoot_url: CHATWOOT_PUBLIC_URL,
  });
});

// Reset the company administrator password and return the new temporary password once.
app.post('/manager/api/clients/:id/admin/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  if (!CHATWOOT_PLATFORM_TOKEN) return res.status(400).json({ error: 'CHATWOOT_PLATFORM_TOKEN is not configured' });

  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

  let userId = client.chatwoot_user_id || null;
  if (!userId && client.chatwoot_user_email) {
    userId = await getCwtUserIdByEmail(client.chatwoot_user_email);
    if (userId) await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1 WHERE id = $2', [userId, id]);
  }

  if (!userId) return res.status(404).json({ error: 'client admin user not found' });

  const membership = await pool.query(
    `SELECT users.id, users.name, users.email, account_users.role
     FROM account_users
     INNER JOIN users ON users.id = account_users.user_id
     WHERE account_users.account_id = $1
       AND users.id = $2
     LIMIT 1`,
    [client.chatwoot_account_id, userId],
  );
  if (!membership.rowCount) return res.status(404).json({ error: 'client admin user is not linked to this account' });

  const password = generateTempPassword();
  const reset = await resetCwtUserPassword(userId, password);

  if (reset.status >= 300) {
    return res.status(reset.status).json({
      step: 'reset_client_admin_password',
      error: reset.data,
    });
  }

  return res.json({
    id: userId,
    name: membership.rows[0].name || client.name,
    email: membership.rows[0].email || client.chatwoot_user_email || client.email,
    role_label: 'Administrador',
    chatwoot_temp_password: password,
  });
});

// Reset a company agent password and return the new temporary password once.
app.post('/manager/api/clients/:id/agents/:userId/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!CHATWOOT_PLATFORM_TOKEN) return res.status(400).json({ error: 'CHATWOOT_PLATFORM_TOKEN is not configured' });

  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  const client = rows[0];
  if (!client.chatwoot_account_id) return res.status(400).json({ error: 'client is missing chatwoot account' });

  const membership = await pool.query(
    `SELECT users.id, users.name, users.email, account_users.role
     FROM account_users
     INNER JOIN users ON users.id = account_users.user_id
     WHERE account_users.account_id = $1
       AND users.id = $2
     LIMIT 1`,
    [client.chatwoot_account_id, userId],
  );
  if (!membership.rowCount) return res.status(404).json({ error: 'agent not found for this client' });

  const password = generateTempPassword();
  const reset = await resetCwtUserPassword(userId, password);

  if (reset.status >= 300) {
    return res.status(reset.status).json({
      step: 'reset_agent_password',
      error: reset.data,
    });
  }

  return res.json({
    id: userId,
    name: membership.rows[0].name,
    email: membership.rows[0].email,
    chatwoot_temp_password: password,
  });
});

app.get('/manager/api/clients/:id/integration/status', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  try {
    const status = await clientIntegrationStatus(rows[0]);
    return res.json(status);
  } catch (err) {
    await setClientIntegrationState(id, 'error', err.message);
    return res.status(500).json({
      step: 'integration_status',
      error: err.message,
    });
  }
});

app.post('/manager/api/clients/:id/integration/repair', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  try {
    const repair = await repairClientIntegration(rows[0]);
    const fresh = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
    const statusAfter = fresh.rowCount ? await clientIntegrationStatus(fresh.rows[0]) : null;
    return res.status(repair.repaired ? 200 : 500).json({
      ...repair,
      status_after: statusAfter,
    });
  } catch (err) {
    await setClientIntegrationState(id, 'error', err.message);
    return res.status(500).json({
      step: 'integration_repair',
      error: err.message,
    });
  }
});

app.post('/manager/api/clients/:id/import-history', async (req, res) => {
  if (!EVOLUTION_CHATWOOT_DIRECT_DB_IMPORT_ENABLED) {
    return res.status(410).json(directEvolutionImportDisabledPayload());
  }

  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  try {
    const body = req.body || {};
    const mode = String(body.mode || req.query.mode || 'safe').toLowerCase();
    const safeMode = mode !== 'full';
    const pendingLimit = Math.min(
      Math.max(Number(body.pendingLimit || req.query.pendingLimit || (safeMode ? EVOLUTION_HISTORY_MANUAL_IMPORT_LIMIT : 0)), 0),
      500,
    );
    const throttleMs = Math.min(
      Math.max(Number(body.throttleMs ?? req.query.throttleMs ?? (safeMode ? EVOLUTION_HISTORY_IMPORT_THROTTLE_MS : 0)), 0),
      2000,
    );
    const ensureAllThreads = safeMode
      ? false
      : String(body.ensureAllThreads ?? req.query.ensureAllThreads ?? 'true') !== 'false';

    await repairClientIntegration(rows[0]);
    const result = await importEvolutionHistoryForClient(rows[0], {
      syncSettings: !safeMode,
      ensureAllThreads,
      pendingLimit,
      throttleMs,
    });
    return res.json({
      mode: safeMode ? 'safe' : 'full',
      ...result,
    });
  } catch (err) {
    return res.status(500).json({
      step: 'import_history',
      error: err.message,
    });
  }
});

// ─── Extra Inboxes Management ───────────────────────────────────────────────────

// Add an extra inbox to an existing client
app.post('/manager/api/clients/:id/inboxes', async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'invalid client id' });
  const label = String(req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label is required' });

  try {
    const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });
    const client = rows[0];

    if (!client.chatwoot_account_id) {
      return res.status(400).json({ error: 'client missing chatwoot account' });
    }

    const userToken = await clientTokenForIntegration(client);
    if (!userToken) return res.status(500).json({ error: 'could not get admin token for client' });

    const onboardToken = randomBytes(24).toString('base64url');
    const instanceName = `fluvius-${client.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20)}-${label.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 10)}-${Date.now().toString(36)}`;
    const channelDisplayName = `${client.name} - ${label}`.slice(0, 80);
    const created = {};

    // 1. Create Evolution instance
    const evo = await evoFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({ instanceName, integration: 'WHATSAPP-BAILEYS' }),
    });
    if (evo.status >= 300) {
      return res.status(evo.status).json(provisioningError('create_instance', evo).body);
    }
    created.instanceName = instanceName;

    // 2. Create Fluvius inbox
    const cwt = await cwtAccountFetch(`/api/v1/accounts/${client.chatwoot_account_id}/inboxes`, userToken, {
      method: 'POST',
      body: JSON.stringify({ name: channelDisplayName, channel: { type: 'api', webhook_url: '' } }),
    });
    if (cwt.status >= 300) {
      await evoFetch(`/instance/delete/${instanceName}`, { method: 'DELETE' });
      return res.status(cwt.status).json(provisioningError('create_inbox', cwt).body);
    }
    
    const inboxId = cwt.data?.id || null;
    const inboxToken = cwt.data?.inbox_identifier || '';
    if (!inboxId || !inboxToken) throw new Error('Fluvius inbox response missing id/inbox_identifier');

    // 3. Link Evolution to Chatwoot
    const link = await evoFetch(`/chatwoot/set/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify(evolutionChatwootPayload(client.chatwoot_account_id, userToken, channelDisplayName)),
    });

    const historySync = await enableEvolutionHistorySync(instanceName, client.chatwoot_account_id, userToken, channelDisplayName);
    
    // 4. Update inbox webhook
    const evolutionWebhookUrl = expectedInboxWebhookUrl(instanceName);
    const webhook = await cwtAccountFetch(`/api/v1/accounts/${client.chatwoot_account_id}/inboxes/${inboxId}`, userToken, {
      method: 'PATCH',
      body: JSON.stringify({ channel: { webhook_url: evolutionWebhookUrl } }),
    });

    // 5. Save to DB
    const insert = await pool.query(
      `INSERT INTO fluvius_client_inboxes
        (client_id, label, instance_name, channel_display_name, inbox_id, inbox_token, token, status, integration_status, integration_last_checked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'ok', NOW())
       RETURNING *`,
      [id, label, instanceName, channelDisplayName, inboxId, inboxToken, onboardToken]
    );

    res.json(insert.rows[0]);
  } catch (err) {
    if (created.instanceName) {
      await evoFetch(`/instance/delete/${created.instanceName}`, { method: 'DELETE' });
    }
    res.status(500).json({ error: err.message });
  }
});

// List extra inboxes
app.get('/manager/api/clients/:id/inboxes', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT * FROM fluvius_client_inboxes WHERE client_id = $1 ORDER BY created_at ASC', [id]);
    const withConnectionState = await Promise.all(rows.map(async row => ({
      ...row,
      connection_state: await evolutionConnectionState(row.instance_name),
    })));
    res.json(withConnectionState);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete extra inbox
app.delete('/manager/api/clients/:id/inboxes/:inboxId', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inboxId = Number(req.params.inboxId);
    if (isNaN(id) || isNaN(inboxId)) return res.status(400).json({ error: 'invalid id' });
    
    const { rows } = await pool.query('SELECT * FROM fluvius_client_inboxes WHERE id = $1 AND client_id = $2', [inboxId, id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const extraInbox = rows[0];

  const cleanup = {};
  if (extraInbox.instance_name) {
    const evo = await evoFetch(`/instance/delete/${extraInbox.instance_name}`, { method: 'DELETE' });
    cleanup.evolution = evo.status < 300 || evo.status === 404 ? 'deleted' : { status: evo.status, error: evo.data };
  }
  
  if (extraInbox.inbox_id) {
    const clientRows = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
    const client = clientRows.rows[0];
    const userToken = await clientTokenForIntegration(client);
    if (userToken) {
      const cwt = await cwtAccountFetch(`/api/v1/accounts/${client.chatwoot_account_id}/inboxes/${extraInbox.inbox_id}`, userToken, { method: 'DELETE' });
      cleanup.chatwoot_inbox = cwt.status < 300 || cwt.status === 404 ? 'deleted' : { status: cwt.status, error: cwt.data };
    }
  }

    await pool.query('DELETE FROM fluvius_client_inboxes WHERE id = $1', [inboxId]);
    res.json({ ok: true, cleanup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/manager/api/clients/:id/inboxes/:inboxId/integration/status', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inboxId = Number(req.params.inboxId);
    if (isNaN(id) || isNaN(inboxId)) return res.status(400).json({ error: 'invalid id' });

    const { rows } = await pool.query('SELECT * FROM fluvius_client_inboxes WHERE id = $1 AND client_id = $2', [inboxId, id]);
    if (!rows.length) return res.status(404).json({ error: 'inbox not found' });
  
  const clientRows = await pool.query('SELECT chatwoot_account_id FROM fluvius_clients WHERE id = $1', [id]);
  const clientData = clientRows.rows[0];

  const adaptedClient = {
    id: rows[0].id,
    instance_name: rows[0].instance_name,
    chatwoot_account_id: clientData.chatwoot_account_id,
    inbox_id: rows[0].inbox_id,
    channel_display_name: rows[0].channel_display_name,
    integration_status: rows[0].integration_status,
    integration_last_checked_at: rows[0].integration_last_checked_at,
    integration_last_error: rows[0].integration_last_error
  };

    const status = await clientIntegrationStatus(adaptedClient, true);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/manager/api/clients/:id/inboxes/:inboxId/integration/repair', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inboxId = Number(req.params.inboxId);
    if (isNaN(id) || isNaN(inboxId)) return res.status(400).json({ error: 'invalid id' });

    const { rows } = await pool.query('SELECT * FROM fluvius_client_inboxes WHERE id = $1 AND client_id = $2', [inboxId, id]);
    if (!rows.length) return res.status(404).json({ error: 'inbox not found' });
  
  const clientRows = await pool.query('SELECT chatwoot_account_id, chatwoot_user_id, chatwoot_user_email FROM fluvius_clients WHERE id = $1', [id]);
  const clientData = clientRows.rows[0];

  const adaptedClient = {
    id: rows[0].id,
    instance_name: rows[0].instance_name,
    chatwoot_account_id: clientData.chatwoot_account_id,
    inbox_id: rows[0].inbox_id,
    channel_display_name: rows[0].channel_display_name,
    chatwoot_user_id: clientData.chatwoot_user_id,
    chatwoot_user_email: clientData.chatwoot_user_email
  };

    const repair = await repairClientIntegration(adaptedClient, true);
    res.json(repair);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/manager/api/clients/:id/inboxes/:inboxId/integration/replace-instance', async (req, res) => {
  const created = {};
  try {
    const id = Number(req.params.id);
    const inboxId = Number(req.params.inboxId);
    if (isNaN(id) || isNaN(inboxId)) return res.status(400).json({ error: 'invalid id' });

    const { rows } = await pool.query('SELECT * FROM fluvius_client_inboxes WHERE id = $1 AND client_id = $2', [inboxId, id]);
    if (!rows.length) return res.status(404).json({ error: 'inbox not found' });
    const extraInbox = rows[0];

    const clientRows = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients WHERE id = $1`, [id]);
    if (!clientRows.rows.length) return res.status(404).json({ error: 'client not found' });
    const client = clientRows.rows[0];
    if (!client.chatwoot_account_id || !extraInbox.inbox_id) {
      return res.status(400).json({ error: 'client or extra inbox is missing Fluvius account/inbox' });
    }

    const userToken = await clientTokenForIntegration(client);
    if (!userToken) return res.status(400).json({ error: 'client admin token not available' });

    const oldInstanceName = extraInbox.instance_name;
    const requestedLabel = String(req.body?.label || '').trim();
    const newInstanceName = extraInboxInstanceName(client, extraInbox, requestedLabel);

    const evo = await evoFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({ instanceName: newInstanceName, integration: 'WHATSAPP-BAILEYS' }),
    });
    if (evo.status >= 300) {
      return res.status(evo.status).json(provisioningError('create_instance', evo).body);
    }
    created.instanceName = newInstanceName;

    const settings = await evoFetch(`/settings/set/${newInstanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        rejectCall: false,
        msgCall: '',
        groupsIgnore: false,
        alwaysOnline: false,
        readMessages: false,
        readStatus: false,
        syncFullHistory: true,
      }),
    });
    if (settings.status >= 300) {
      await evoFetch(`/instance/delete/${newInstanceName}`, { method: 'DELETE' });
      return res.status(settings.status).json({ step: 'evolution_settings', error: settings.data });
    }

    const link = await evoFetch(`/chatwoot/set/${newInstanceName}`, {
      method: 'POST',
      body: JSON.stringify(evolutionChatwootPayload(
        client.chatwoot_account_id,
        userToken,
        extraInbox.channel_display_name,
      )),
    });
    if (link.status >= 300) {
      await evoFetch(`/instance/delete/${newInstanceName}`, { method: 'DELETE' });
      return res.status(link.status).json({ step: 'evolution_chatwoot_link', error: link.data });
    }

    const actions = ['evolution_instance_created', 'evolution_settings_updated', 'evolution_chatwoot_link_updated'];
    const updated = await pool.query(
      `UPDATE fluvius_client_inboxes
       SET instance_name = $1,
           status = 'pending',
           integration_status = 'ok',
           integration_last_checked_at = NOW(),
           integration_last_error = NULL,
           integration_repaired_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND client_id = $3
       RETURNING *`,
      [newInstanceName, inboxId, id],
    );

    const adaptedClient = {
      id: extraInbox.id,
      instance_name: newInstanceName,
      chatwoot_account_id: client.chatwoot_account_id,
      inbox_id: extraInbox.inbox_id,
      channel_display_name: extraInbox.channel_display_name,
      chatwoot_user_id: client.chatwoot_user_id,
      chatwoot_user_email: client.chatwoot_user_email,
    };
    const webhook = await updateClientInboxWebhook(adaptedClient, userToken, actions);
    if (!webhook.ok) {
      await pool.query(
        `UPDATE fluvius_client_inboxes
         SET instance_name = $1,
             integration_status = 'error',
             integration_last_checked_at = NOW(),
             integration_last_error = $2,
             updated_at = NOW()
         WHERE id = $3 AND client_id = $4`,
        [oldInstanceName, JSON.stringify({ step: 'inbox_webhook', error: webhook.details }).slice(0, 2000), inboxId, id],
      );
      await evoFetch(`/instance/delete/${newInstanceName}`, { method: 'DELETE' });
      return res.status(webhook.status || 500).json({ step: 'inbox_webhook', error: webhook.details });
    }

    let oldInstanceCleanup = null;
    if (oldInstanceName && oldInstanceName !== newInstanceName) {
      const cleanup = await evoFetch(`/instance/delete/${oldInstanceName}`, { method: 'DELETE' });
      oldInstanceCleanup = cleanup.status < 300 || cleanup.status === 404
        ? 'deleted'
        : { status: cleanup.status, error: cleanup.data };
    }

    res.json({
      replaced: true,
      actions,
      old_instance_name: oldInstanceName,
      new_instance_name: newInstanceName,
      inbox_id: extraInbox.inbox_id,
      extra_inbox: updated.rows[0],
      onboarding_url: `/onboard/${updated.rows[0].token}`,
      old_instance_cleanup: oldInstanceCleanup,
      connection_state: await evolutionConnectionState(newInstanceName),
    });
  } catch (err) {
    if (created.instanceName) {
      await evoFetch(`/instance/delete/${created.instanceName}`, { method: 'DELETE' });
    }
    res.status(500).json({ step: 'replace_instance', error: err.message });
  }
});
// --- Automations Proxy ---
app.get('/manager/api/clients/:id/automations', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT chatwoot_account_id, chatwoot_user_id, chatwoot_user_email FROM fluvius_clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });
    const client = rows[0];
    const userToken = await clientTokenForIntegration({ id, ...client });
    if (!userToken) return res.status(500).json({ error: 'could not get admin token' });

    const r = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${client.chatwoot_account_id}/automation_rules`, {
      headers: { api_access_token: userToken }
    });
    const data = await r.json();
    res.status(r.status).json(data.payload || data);
  } catch (err) {
    console.error('Automation GET error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

function sanitizeAutomationRuleBody(body) {
  if (body && Array.isArray(body.conditions) && body.conditions.length > 0) {
    const lastCondition = body.conditions[body.conditions.length - 1];
    if (lastCondition) {
      delete lastCondition.query_operator;
    }
  }
  return body;
}

app.post('/manager/api/clients/:id/automations', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT chatwoot_account_id, chatwoot_user_id, chatwoot_user_email FROM fluvius_clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });
    const client = rows[0];
    const userToken = await clientTokenForIntegration({ id, ...client });
    if (!userToken) return res.status(500).json({ error: 'could not get admin token' });

    const sanitizedBody = sanitizeAutomationRuleBody(req.body);
    console.log('Automation POST payload:', sanitizedBody);
    const r = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${client.chatwoot_account_id}/automation_rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', api_access_token: userToken },
      body: JSON.stringify(sanitizedBody)
    });
    
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      data = { raw_response: text };
    }
    
    if (!r.ok) {
      console.error('Automation POST failed:', r.status, data);
    }
    
    res.status(r.status).json(data);
  } catch (err) {
    console.error('Automation POST error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.patch('/manager/api/clients/:id/automations/:ruleId', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ruleId = Number(req.params.ruleId);
    if (isNaN(id) || isNaN(ruleId)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT chatwoot_account_id, chatwoot_user_id, chatwoot_user_email FROM fluvius_clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });
    const client = rows[0];
    const userToken = await clientTokenForIntegration({ id, ...client });
    
    const sanitizedBody = sanitizeAutomationRuleBody(req.body);
    const r = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${client.chatwoot_account_id}/automation_rules/${ruleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', api_access_token: userToken },
      body: JSON.stringify(sanitizedBody)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/manager/api/clients/:id/automations/:ruleId', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ruleId = Number(req.params.ruleId);
    if (isNaN(id) || isNaN(ruleId)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT chatwoot_account_id, chatwoot_user_id, chatwoot_user_email FROM fluvius_clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });
    const client = rows[0];
    const userToken = await clientTokenForIntegration({ id, ...client });
    
    const r = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${client.chatwoot_account_id}/automation_rules/${ruleId}`, {
      method: 'DELETE',
      headers: { api_access_token: userToken }
    });
    
    if (r.ok) {
      return res.status(r.status).send();
    }
    
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    res.status(r.status).json(data);
  } catch (err) {
    console.error('Automation DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/manager/api/clients/:id/automations/:ruleId/toggle', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const ruleId = Number(req.params.ruleId);
    if (isNaN(id) || isNaN(ruleId)) return res.status(400).json({ error: 'invalid id' });
    const { rows } = await pool.query('SELECT chatwoot_account_id, chatwoot_user_id, chatwoot_user_email FROM fluvius_clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });
    const client = rows[0];
    const userToken = await clientTokenForIntegration({ id, ...client });
    
    // First get the rule to flip its active status
    let r = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${client.chatwoot_account_id}/automation_rules/${ruleId}`, {
      headers: { api_access_token: userToken }
    });
    if (!r.ok) return res.status(r.status).json(await r.json());
    const rule = await r.json();
    
    // Now toggle
    r = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${client.chatwoot_account_id}/automation_rules/${ruleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', api_access_token: userToken },
      body: JSON.stringify({ active: !rule.active })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Archive client safely: disconnects WhatsApp sessions, keeps Fluvius data.
app.post('/manager/api/clients/:id/archive', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'client not found' });
    const client = rows[0];
    if (client.archived_at) {
      return res.status(409).json({ error: 'client already archived' });
    }

    const extraInboxes = await pool.query(
      'SELECT id, instance_name FROM fluvius_client_inboxes WHERE client_id = $1 ORDER BY created_at ASC',
      [id],
    );
    const cleanup = {
      main_instance: await logoutEvolutionInstance(client.instance_name),
      extra_instances: [],
    };

    for (const inbox of extraInboxes.rows) {
      cleanup.extra_instances.push({
        id: inbox.id,
        instance_name: inbox.instance_name,
        result: await logoutEvolutionInstance(inbox.instance_name),
      });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 500) || null;

    await pool.query(
      `UPDATE fluvius_client_inboxes
       SET status = 'pending', updated_at = NOW()
       WHERE client_id = $1`,
      [id],
    );

    const updated = await pool.query(
      `UPDATE fluvius_clients
       SET archived_at = NOW(),
           archived_reason = $2,
           archive_cleanup = $3::jsonb,
           status = 'pending',
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${CLIENT_PUBLIC_FIELDS}`,
      [id, reason, JSON.stringify(cleanup)],
    );

    res.json({ ok: true, client: { ...updated.rows[0], chatwoot_url: CHATWOOT_PUBLIC_URL }, cleanup });
  } catch (err) {
    res.status(500).json({ step: 'archive_client', error: err.message });
  }
});

app.post('/manager/api/clients/:id/restore', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const updated = await pool.query(
      `UPDATE fluvius_clients
       SET archived_at = NULL,
           archived_reason = NULL,
           archive_cleanup = NULL,
           status = 'pending',
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${CLIENT_PUBLIC_FIELDS}`,
      [id],
    );
    if (!updated.rowCount) return res.status(404).json({ error: 'client not found' });

    res.json({ ok: true, client: { ...updated.rows[0], chatwoot_url: CHATWOOT_PUBLIC_URL } });
  } catch (err) {
    res.status(500).json({ step: 'restore_client', error: err.message });
  }
});

// Destructive delete kept for maintenance only. Manager UI uses archive instead.
app.delete('/manager/api/clients/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const client = rows[0];
  const confirmation = String(req.body?.confirmation || '');
  if (confirmation !== `DELETE ${client.name}`) {
    return res.status(400).json({
      error: 'destructive_delete_confirmation_required',
      confirmation: `DELETE ${client.name}`,
    });
  }
  const cleanup = {};
  if (client.instance_name) {
    const evo = await evoFetch(`/instance/delete/${client.instance_name}`, { method: 'DELETE' });
    cleanup.evolution = evo.status < 300 || evo.status === 404 ? 'deleted' : { status: evo.status, error: evo.data };
  }
  if (client.chatwoot_account_id && CHATWOOT_PLATFORM_TOKEN) {
    const account = await platformFetch(`/platform/api/v1/accounts/${client.chatwoot_account_id}`, { method: 'DELETE' });
    cleanup.chatwoot_account = account.status < 300 || account.status === 404 ? 'deleted' : { status: account.status, error: account.data };
  }
  await pool.query('DELETE FROM fluvius_clients WHERE id = $1', [id]);
  res.json({ ok: true, cleanup });
});

// ─── Client Onboarding Routes ─────────────────────────────────────────────────

async function getClientByToken(token) {
  const { rows } = await pool.query("SELECT *, 'main' as token_type FROM fluvius_clients WHERE token = $1", [token]);
  if (rows.length) return rows[0];

  const extraRows = await pool.query(
    `SELECT i.*, 'extra' as token_type, i.channel_display_name as name, c.archived_at, c.archived_reason
     FROM fluvius_client_inboxes i
     INNER JOIN fluvius_clients c ON c.id = i.client_id
     WHERE i.token = $1`,
    [token],
  );
  if (extraRows.rows.length) return extraRows.rows[0];

  return null;
}

function archivedClientPayload() {
  return {
    error: 'client_archived',
    message: 'Empresa arquivada. Restaure no Manager antes de reconectar o WhatsApp.',
  };
}

// Onboarding page
app.get('/onboard/:token', (_req, res) => {
  res.sendFile('onboard.html', { root: 'public' });
});

// Get client info (for onboarding page JS)
app.get('/onboard/:token/info', async (req, res) => {
  const client = await getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: 'Link inválido ou expirado' });
  const chatwootUrl = process.env.CHATWOOT_PUBLIC_URL || process.env.CHATWOOT_FRONTEND_URL || 'http://localhost:3000';
  res.json({
    name: client.name,
    status: client.archived_at ? 'archived' : client.status,
    phone: client.phone,
    chatwootUrl,
    archived_at: client.archived_at,
  });
});

// Get QR code for onboarding
app.get('/onboard/:token/qr', async (req, res) => {
  const client = await getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  if (client.archived_at) return res.status(409).json(archivedClientPayload());
  const { status, data } = await evoFetch(`/instance/connect/${client.instance_name}`);
  res.status(status).json(data);
});

// Request phone pairing code
app.post('/onboard/:token/phone', async (req, res) => {
  const client = await getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  if (client.archived_at) return res.status(409).json(archivedClientPayload());
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Número inválido' });
  const { status, data } = await evoFetch(`/instance/connect/${client.instance_name}?number=${encodeURIComponent(phone)}`);
  const pairingCode = data?.code || data?.pairingCode || data?.qrcode?.pairingCode || '';
  if (status < 300 && !pairingCode) {
    return res.status(502).json({
      error: 'A Evolution não retornou código de pareamento para este número. Confira se o número tem WhatsApp ativo e tente novamente.',
      evolution: data,
    });
  }
  res.status(status).json(data);
});

// Check connection status (for polling)
app.get('/onboard/:token/status', async (req, res) => {
  const client = await getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  if (client.archived_at) return res.status(409).json(archivedClientPayload());
  const { data } = await evoFetch(`/instance/connectionState/${client.instance_name}`);
  const state = (data?.instance?.state || data?.state || '').toLowerCase();
  const phone = data?.instance?.profileName || data?.instance?.wuid?.replace('@s.whatsapp.net','') || '';
  if (state === 'open' && client.status !== 'connected') {
    if (client.token_type === 'extra') {
      await pool.query(
        'UPDATE fluvius_client_inboxes SET status=$1, phone=$2, updated_at=NOW() WHERE token=$3',
        ['connected', phone || client.phone, req.params.token],
      );
    } else {
      await pool.query(
        'UPDATE fluvius_clients SET status=$1, phone=$2, updated_at=NOW() WHERE token=$3',
        ['connected', phone || client.phone, req.params.token],
      );
    }
  }
  res.json({ state, phone });
});

// ─── Client Dashboard Routes ──────────────────────────────────────────────────

// Serve client dashboard page
app.get('/client/:token', (_req, res) => {
  res.sendFile('client_dashboard.html', { root: 'public' });
});

// Get client settings
app.get('/client/:token/settings', async (req, res) => {
  const token = req.params.token;
  const client = await getClientByToken(token);
  if (!client) return res.status(404).json({ error: 'Link inválido ou expirado' });
  if (client.archived_at) return res.status(409).json(archivedClientPayload());

  let connectionState = 'close';
  let phone = client.phone || '';
  try {
    const { data } = await evoFetch(`/instance/connectionState/${client.instance_name}`);
    connectionState = (data?.instance?.state || data?.state || 'close').toLowerCase();
    if (data?.instance?.wuid) {
      phone = data.instance.wuid.replace('@s.whatsapp.net', '');
    }
  } catch (e) {
    console.error('Failed to get connection state:', e.message);
  }

  // Update DB status if it doesn't match the current Evolution connection state
  if (connectionState === 'open' && client.status !== 'connected') {
    const table = client.token_type === 'extra' ? 'fluvius_client_inboxes' : 'fluvius_clients';
    await pool.query(
      `UPDATE ${table} SET status=$1, phone=$2, updated_at=NOW() WHERE token=$3`,
      ['connected', phone, token]
    );
  } else if (connectionState !== 'open' && client.status === 'connected') {
    const table = client.token_type === 'extra' ? 'fluvius_client_inboxes' : 'fluvius_clients';
    await pool.query(
      `UPDATE ${table} SET status=$1, updated_at=NOW() WHERE token=$2`,
      ['pending', token]
    );
  }

  const chatwootUrl = process.env.CHATWOOT_PUBLIC_URL || process.env.CHATWOOT_FRONTEND_URL || 'http://localhost:3000';

  res.json({
    name: client.name,
    instance_name: client.instance_name,
    phone: phone || client.phone,
    connection_state: connectionState,
    status: connectionState === 'open' ? 'connected' : 'pending',
    chatwootUrl,
    chatbot_enabled: client.chatbot_enabled,
    chatbot_type: client.chatbot_type,
    chatbot_welcome_message: client.chatbot_welcome_message,
    chatbot_absence_message: client.chatbot_absence_message,
    chatbot_options: client.chatbot_options || DEFAULT_TRIAGE_OPTIONS,
    chatbot_trigger_keyword: client.chatbot_trigger_keyword
  });
});

// Update client settings
app.post('/client/:token/settings', async (req, res) => {
  const token = req.params.token;
  const client = await getClientByToken(token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  if (client.archived_at) return res.status(409).json(archivedClientPayload());

  const {
    chatbot_enabled,
    chatbot_type,
    chatbot_welcome_message,
    chatbot_absence_message,
    chatbot_options,
    chatbot_trigger_keyword
  } = req.body;

  const table = client.token_type === 'extra' ? 'fluvius_client_inboxes' : 'fluvius_clients';

  await pool.query(
    `UPDATE ${table}
     SET chatbot_enabled = $1,
         chatbot_type = $2,
         chatbot_welcome_message = $3,
         chatbot_absence_message = $4,
         chatbot_options = $5::jsonb,
         chatbot_trigger_keyword = $6,
         updated_at = NOW()
     WHERE token = $7`,
    [
      !!chatbot_enabled,
      chatbot_type || 'triage',
      chatbot_welcome_message || null,
      chatbot_absence_message || null,
      chatbot_options ? JSON.stringify(chatbot_options) : null,
      chatbot_trigger_keyword ? String(chatbot_trigger_keyword).trim() : null,
      token
    ]
  );

  res.json({ ok: true });
});

// Disconnect WhatsApp session
app.post('/client/:token/disconnect', async (req, res) => {
  const token = req.params.token;
  const client = await getClientByToken(token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  if (client.archived_at) return res.status(409).json(archivedClientPayload());

  // Call Evolution API logout
  const { status, data } = await evoFetch(`/instance/logout/${client.instance_name}`, { method: 'DELETE' });

  // Update DB status to pending and clear phone
  const table = client.token_type === 'extra' ? 'fluvius_client_inboxes' : 'fluvius_clients';
  await pool.query(
    `UPDATE ${table} SET status = 'pending', phone = NULL, updated_at = NOW() WHERE token = $1`,
    [token]
  );

  res.status(status).json({ ok: true, data });
});

// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => {

  res.sendFile('index.html', { root: 'public' });
});

io.on('connection', socket => {
  socket.on('user:join', async ({ userId, accountId }) => {
    const parsedUserId = Number(userId);
    const parsedAccountId = await resolveAccountIdForUser(parsedUserId, accountId);
    if (!parsedUserId) return;
    if (!parsedAccountId) return;
    socket.data.userId = parsedUserId;
    socket.data.accountId = parsedAccountId;
    socket.join(`user:${parsedUserId}`);
    socket.join(`account:${parsedAccountId}`);
    if (!onlineUsers.has(parsedUserId)) onlineUsers.set(parsedUserId, new Set());
    onlineUsers.get(parsedUserId).add(socket.id);
    await emitUnread(parsedUserId);
    socket.emit('presence:update', { onlineUserIds: onlineUserIds() });
    io.to(`account:${parsedAccountId}`).emit('presence:update', { onlineUserIds: onlineUserIds() });
  });

  socket.on('join', async ({ userId, accountId, roomId }) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    const parsedAccountId = await resolveAccountIdForUser(parsedUserId, accountId);
    if (!parsedUserId || !parsedRoomId) return;
    if (!(await ensureParticipantInAccount(parsedRoomId, parsedUserId, parsedAccountId))) return;
    socket.join(`room:${parsedRoomId}`);
  });

  socket.on('typing:start', async ({ userId, accountId, roomId }) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    const parsedAccountId = await resolveAccountIdForUser(parsedUserId, accountId);
    if (!parsedUserId || !parsedRoomId) return;
    if (!(await ensureParticipantInAccount(parsedRoomId, parsedUserId, parsedAccountId))) return;
    socket.to(`room:${parsedRoomId}`).emit('typing:update', { roomId: parsedRoomId, userId: parsedUserId, typing: true });
  });

  socket.on('typing:stop', async ({ userId, accountId, roomId }) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    const parsedAccountId = await resolveAccountIdForUser(parsedUserId, accountId);
    if (!parsedUserId || !parsedRoomId) return;
    if (!(await ensureParticipantInAccount(parsedRoomId, parsedUserId, parsedAccountId))) return;
    socket.to(`room:${parsedRoomId}`).emit('typing:update', { roomId: parsedRoomId, userId: parsedUserId, typing: false });
  });

  socket.on('message:create', async ({ userId, accountId, roomId, content, attachment }, callback) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    const parsedAccountId = await resolveAccountIdForUser(parsedUserId, accountId);
    const parsedContent = String(content || '').trim();
    const parsedAttachment = normalizeAttachment(attachment);
    if (!parsedUserId || !parsedRoomId || (!parsedContent && !parsedAttachment)) return;
    if (!(await ensureParticipantInAccount(parsedRoomId, parsedUserId, parsedAccountId))) return;

    const message = await createMessage({
      roomId: parsedRoomId,
      userId: parsedUserId,
      content: parsedContent,
      attachment: parsedAttachment,
    });
    io.to(`room:${parsedRoomId}`).emit('message:new', message);
    const participants = await pool.query(
      'SELECT user_id FROM internal_chat_participants WHERE room_id = $1 AND user_id <> $2',
      [parsedRoomId, parsedUserId],
    );
    await Promise.all(participants.rows.map(row => emitUnread(row.user_id)));
    callback?.({ ok: true, message });
  });

  socket.on('disconnect', () => {
    const userId = socket.data.userId;
    const accountId = socket.data.accountId;
    if (!userId || !onlineUsers.has(userId)) return;
    onlineUsers.get(userId).delete(socket.id);
    if (onlineUsers.get(userId).size === 0) onlineUsers.delete(userId);
    if (accountId) io.to(`account:${accountId}`).emit('presence:update', { onlineUserIds: onlineUserIds() });
  });
});

async function migrateWithRetry(maxAttempts = 20, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await migrate();
      return;
    } catch (error) {
      const isNotReady = error.code === '42P01' || error.message?.includes('does not exist');
      if (isNotReady && attempt < maxAttempts) {
        console.log(`[internal-chat] Banco ainda nao esta pronto (tentativa ${attempt}/${maxAttempts}). Aguardando ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        console.error('[internal-chat] Falha ao inicializar:', error);
        process.exit(1);
      }
    }
  }
}

let crmAiAutoRunning = false;

async function runCrmAiAutoAnalysis() {
  if (!crmAiConfigured() || crmAiAutoRunning) return;
  crmAiAutoRunning = true;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, chatwoot_account_id
       FROM fluvius_clients
       WHERE chatwoot_account_id IS NOT NULL
       ORDER BY id ASC`,
    );

    for (const client of rows) {
      const accountId = Number(client.chatwoot_account_id);
      if (!accountId) continue;
      const conversationIds = await crmConversationIdsForAutoAnalysis(accountId, CRM_AI_AUTO_LIMIT);
      for (const conversationId of conversationIds) {
        try {
          const result = await analyzeCrmConversation(accountId, conversationId, { apply: true });
          console.log(`[crm-ai] ${client.name || client.id} conversation=${conversationId} stage=${result.stage_key} applied=${result.applied}`);
        } catch (error) {
          console.warn(`[crm-ai] failed conversation=${conversationId}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.warn(`[crm-ai] automatic analysis failed: ${error.message}`);
  } finally {
    crmAiAutoRunning = false;
  }
}

function startCrmAiAutoAnalysis() {
  if (!crmAiConfigured() || CRM_AI_AUTO_INTERVAL_SECONDS <= 0) return;
  const intervalMs = Math.max(CRM_AI_AUTO_INTERVAL_SECONDS, 60) * 1000;
  console.log(`[crm-ai] automatic CRM analysis enabled every ${Math.round(intervalMs / 1000)}s`);
  setTimeout(runCrmAiAutoAnalysis, 15000);
  setInterval(runCrmAiAutoAnalysis, intervalMs);
}

let evolutionHistoryAutoImportRunning = false;

async function evolutionHistoryAutoImportClients() {
  const { rows } = await pool.query(
    `SELECT *
     FROM fluvius_clients
     WHERE instance_name IS NOT NULL
       AND instance_name <> ''
       AND chatwoot_account_id IS NOT NULL
       AND inbox_id IS NOT NULL
     ORDER BY id ASC`,
  );
  return rows;
}

async function runEvolutionHistoryAutoImport() {
  if (!EVOLUTION_HISTORY_AUTO_IMPORT_ENABLED || evolutionHistoryAutoImportRunning) return;
  evolutionHistoryAutoImportRunning = true;
  try {
    const clients = await evolutionHistoryAutoImportClients();
    for (const client of clients) {
      try {
        const result = await importEvolutionHistoryForClient(client, {
          syncSettings: false,
          ensureAllThreads: false,
          pendingLimit: EVOLUTION_HISTORY_AUTO_IMPORT_LIMIT,
          throttleMs: EVOLUTION_HISTORY_IMPORT_THROTTLE_MS,
        });
        if (result.messages_found || result.messages_imported || result.messages_relinked || result.messages_skipped || result.media_pending) {
          console.log(
            `[evolution-import] client=${client.id} instance=${client.instance_name} found=${result.messages_found} imported=${result.messages_imported} relinked=${result.messages_relinked} skipped=${result.messages_skipped} media_imported=${result.media_imported || 0} media_pending=${result.media_pending || 0}`,
          );
        }
      } catch (error) {
        console.warn(`[evolution-import] failed client=${client.id} instance=${client.instance_name}: ${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[evolution-import] automatic import failed: ${error.message}`);
  } finally {
    evolutionHistoryAutoImportRunning = false;
  }
}

function startEvolutionHistoryAutoImport() {
  if (!EVOLUTION_HISTORY_AUTO_IMPORT_ENABLED) return;
  if (!EVOLUTION_CHATWOOT_DIRECT_DB_IMPORT_ENABLED) {
    console.warn('[evolution-import] automatic import disabled: direct Chatwoot DB writes are blocked');
    return;
  }

  const intervalMs = EVOLUTION_HISTORY_AUTO_IMPORT_INTERVAL_SECONDS * 1000;
  console.log(`[evolution-import] automatic import enabled every ${EVOLUTION_HISTORY_AUTO_IMPORT_INTERVAL_SECONDS}s`);
  setTimeout(runEvolutionHistoryAutoImport, 5000);
  setInterval(runEvolutionHistoryAutoImport, intervalMs);
}

let triageBotRunning = false;

async function triageClients() {
  const { rows } = await pool.query(
    `SELECT id, chatwoot_account_id, inbox_id, instance_name, name, chatbot_enabled, chatbot_type, chatbot_welcome_message, chatbot_absence_message, chatbot_options, chatbot_trigger_keyword, chatwoot_user_id, chatwoot_user_email, 'main' as source_type
     FROM fluvius_clients
     WHERE chatwoot_account_id IS NOT NULL
       AND inbox_id IS NOT NULL
       AND chatbot_enabled = true
     UNION ALL
     SELECT i.id, c.chatwoot_account_id, i.inbox_id, i.instance_name, i.channel_display_name as name, i.chatbot_enabled, i.chatbot_type, i.chatbot_welcome_message, i.chatbot_absence_message, i.chatbot_options, i.chatbot_trigger_keyword, c.chatwoot_user_id, c.chatwoot_user_email, 'extra' as source_type
     FROM fluvius_client_inboxes i
     INNER JOIN fluvius_clients c ON i.client_id = c.id
     WHERE c.chatwoot_account_id IS NOT NULL
       AND i.inbox_id IS NOT NULL
       AND i.chatbot_enabled = true
     ORDER BY id ASC`,
  );
  return rows;
}

async function pendingTriageGreetings(client) {
  const { rows } = await pool.query(
    `SELECT conversations.id, conversations.display_id, conversations.account_id, conversations.inbox_id, contacts.name AS contact_name
     FROM conversations
     INNER JOIN contacts ON conversations.contact_id = contacts.id
     WHERE conversations.account_id = $1
       AND conversations.inbox_id = $2
       AND conversations.status <> 1
       AND conversations.created_at > NOW() - ($3::int * INTERVAL '1 hour')
       AND COALESCE(conversations.custom_attributes->>'fluvius_triage_state', '') = ''
       AND EXISTS (
         SELECT 1
         FROM messages
         WHERE messages.conversation_id = conversations.id
           AND messages.private = false
           AND messages.message_type = 0
           AND messages.content IS NOT NULL
           AND trim(messages.content) <> ''
       )
     ORDER BY conversations.created_at ASC
     LIMIT $4`,
    [
      client.chatwoot_account_id,
      client.inbox_id,
      TRIAGE_BOT_NEW_CONVERSATION_WINDOW_HOURS,
      TRIAGE_BOT_LIMIT,
    ],
  );
  return rows;
}

async function waitingTriageReplies(client) {
  const { rows } = await pool.query(
    `SELECT
       conversations.id,
       conversations.display_id,
       conversations.account_id,
       conversations.inbox_id,
       latest_message.id AS latest_incoming_message_id,
       latest_message.content AS latest_incoming_content
     FROM conversations
     INNER JOIN LATERAL (
       SELECT messages.id, messages.content, messages.created_at
       FROM messages
       WHERE messages.conversation_id = conversations.id
         AND messages.private = false
         AND messages.message_type = 0
         AND messages.content IS NOT NULL
         AND trim(messages.content) <> ''
       ORDER BY messages.id DESC
       LIMIT 1
     ) latest_message ON true
     WHERE conversations.account_id = $1
       AND conversations.inbox_id = $2
       AND conversations.status <> 1
       AND conversations.custom_attributes->>'fluvius_triage_state' = 'waiting'
       AND latest_message.created_at > COALESCE(
         NULLIF(conversations.custom_attributes->>'fluvius_triage_greeted_at', '')::timestamptz,
         conversations.created_at
       )
       AND latest_message.id > COALESCE(
         NULLIF(conversations.custom_attributes->>'fluvius_triage_last_incoming_id', '')::bigint,
         0
       )
     ORDER BY latest_message.id ASC
     LIMIT $3`,
    [client.chatwoot_account_id, client.inbox_id, TRIAGE_BOT_LIMIT],
  );
  return rows;
}

async function greetTriageConversation(client, conversation) {
  await sendTriageMessage(client, conversation, triageGreetingForClient(client, conversation.contact_name));
  await addConversationLabel(client.chatwoot_account_id, conversation.id, 'triagem-bot', '#0ea5e9');
  await updateConversationCustomAttributes(client.chatwoot_account_id, conversation.id, {
    fluvius_triage_state: 'waiting',
    fluvius_triage_greeted_at: new Date().toISOString(),
    fluvius_triage_company_name: client.name || '',
  });
}

function triageOptionFromContent(content, client) {
  const normalized = String(content || '').trim().toLowerCase();
  const numericMatch = normalized.match(/^(\d+)\b/);
  const key = numericMatch ? numericMatch[1] : normalized;
  return parseTriageOptionsForClient(client).find(option => option.key.toLowerCase() === key) || null;
}

async function triageDetectIntentWithAI(client, content) {
  if (!TRIAGE_BOT_AI_ENABLED || !content) return null;
  const options = parseTriageOptionsForClient(client);
  if (!options.length) return null;

  const optionsList = options.map(o => `${o.key} - ${o.label}`).join('\n');
  const companyName = String(client.name || 'empresa').trim();

  const prompt = `Você é um assistente de triagem da empresa "${companyName}" no WhatsApp.
Um cliente enviou a seguinte mensagem:
"${content}"

As opções de atendimento disponíveis são:
${optionsList}

Identifique qual opção melhor atende à necessidade do cliente.
Responda APENAS com JSON:
- Se identificar com ALTA confiança: {"key": "1", "confidence": "high"}
- Se não souber ou tiver dúvida: {"key": null, "confidence": "low"}
Nunca invente opções. Se a mensagem for saudação genérica (oi, olá, tudo bem), retorne null.`;

  try {
    const result = await geminiGenerateJson(prompt);
    const key = String(result?.key || '').trim();
    const confidence = String(result?.confidence || '').toLowerCase();
    if (!key || key === 'null' || confidence !== 'high') return null;
    return options.find(o => o.key === key) || null;
  } catch (err) {
    console.warn(`[triage-ai] intent detection failed: ${err.message}`);
    return null;
  }
}

async function routeTriageConversation(client, conversation) {
  let option = triageOptionFromContent(conversation.latest_incoming_content, client);
  const latestIncomingId = String(conversation.latest_incoming_message_id || '');
  let aiDetected = false;

  // Fallback: try Gemini AI intent detection if numeric match failed
  if (!option && TRIAGE_BOT_AI_ENABLED) {
    option = await triageDetectIntentWithAI(client, conversation.latest_incoming_content);
    if (option) {
      aiDetected = true;
      console.log(`[triage-ai] detected intent key=${option.key} label="${option.label}" for conversation=${conversation.display_id}`);
    }
  }

  if (!option) {
    await sendTriageMessage(client, conversation, triageInvalidOptionText(client));
    await updateConversationCustomAttributes(client.chatwoot_account_id, conversation.id, {
      fluvius_triage_last_incoming_id: latestIncomingId,
      fluvius_triage_last_invalid_at: new Date().toISOString(),
    });
    return { routed: false, reason: 'invalid_option' };
  }

  const label = `triagem-${slugifyLabel(option.label) || option.key}`;
  await addConversationLabel(client.chatwoot_account_id, conversation.id, label, '#22c55e');
  await assignTriageConversation(client, conversation, option);
  const confirmText = aiDetected ? triageAiConfirmationText(option) : triageConfirmationText(option);
  await sendTriageMessage(client, conversation, confirmText);
  await updateConversationCustomAttributes(client.chatwoot_account_id, conversation.id, {
    fluvius_triage_state: 'routed',
    fluvius_triage_option: option.key,
    fluvius_triage_label: option.label,
    fluvius_triage_last_incoming_id: latestIncomingId,
    fluvius_triage_routed_at: new Date().toISOString(),
  });
  return { routed: true, option, aiDetected };
}

async function resetTriageOnTriggerWord(client) {
  const keyword = String(client.chatbot_trigger_keyword || '').trim().toLowerCase();
  if (!keyword) return;

  try {
    const { rows } = await pool.query(
      `SELECT
         conversations.id,
         conversations.display_id,
         latest_message.content
       FROM conversations
       INNER JOIN LATERAL (
         SELECT messages.id, messages.content, messages.created_at
         FROM messages
         WHERE messages.conversation_id = conversations.id
           AND messages.private = false
           AND messages.message_type = 0
           AND messages.content IS NOT NULL
           AND trim(messages.content) <> ''
         ORDER BY messages.id DESC
         LIMIT 1
       ) latest_message ON true
       WHERE conversations.account_id = $1
         AND conversations.inbox_id = $2
         AND COALESCE(conversations.custom_attributes->>'fluvius_triage_state', '') <> ''
         AND LOWER(latest_message.content) LIKE '%' || $3 || '%'
         AND latest_message.created_at > NOW() - INTERVAL '2 hours'
       LIMIT 10`,
      [client.chatwoot_account_id, client.inbox_id, keyword]
    );

    for (const row of rows) {
      console.log(`[triage-trigger] Resetting conversation id=${row.id} display_id=${row.display_id} because keyword "${keyword}" was found in: "${row.content}"`);
      await pool.query(
        `UPDATE conversations
         SET custom_attributes = custom_attributes - 'fluvius_triage_state' - 'fluvius_triage_option' - 'fluvius_triage_label' - 'fluvius_triage_greeted_at' - 'fluvius_triage_routed_at',
             updated_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
    }
  } catch (error) {
    console.warn(`[triage-trigger] failed for client=${client.id}: ${error.message}`);
  }
}

// ─── In-memory lock to prevent double-processing conversations via webhook+poll ──
const triageProcessingConvs = new Map(); // convId -> timestamp
function triageLock(convId) {
  const now = Date.now();
  const last = triageProcessingConvs.get(convId) || 0;
  if (now - last < 8000) return false; // locked for 8s
  triageProcessingConvs.set(convId, now);
  return true;
}

// ─── Chatwoot Webhook — instant triage processing ────────────────────────────
app.post('/webhook/chatwoot', express.json({ limit: '1mb' }), (req, res) => {
  // Acknowledge immediately so Chatwoot doesn't retry
  res.status(200).json({ ok: true });

  if (!TRIAGE_BOT_ENABLED) return;

  const payload = req.body;
  if (payload.event !== 'message_created') return;
  // Only process incoming messages from contacts (message_type 0 = incoming)
  if (payload.message_type !== 0) return;
  // Skip outgoing bot messages
  if (payload.sender?.type === 'agent_bot' || payload.sender?.type === 'agent') return;

  const accountId = Number(payload.account?.id || 0);
  const inboxId = Number(payload.inbox?.id || 0);
  const conversationId = Number(payload.conversation?.id || 0);
  const conversationDisplayId = Number(payload.conversation?.display_id || 0);
  const messageId = Number(payload.id || 0);
  const content = String(payload.content || '').trim();
  const contactName = String(payload.sender?.name || 'Cliente').trim();

  if (!accountId || !inboxId || !conversationId) return;

  // Avoid double-processing same conversation too quickly
  if (!triageLock(conversationId)) return;

  // Process asynchronously (do not await here — response already sent)
  (async () => {
    try {
      const clients = await triageClients();
      const client = clients.find(
        c => Number(c.chatwoot_account_id) === accountId && Number(c.inbox_id) === inboxId,
      );
      if (!client) return;

      // Fetch current triage state from DB
      const convRes = await pool.query(
        'SELECT id, display_id, custom_attributes FROM conversations WHERE id = $1 LIMIT 1',
        [conversationId],
      );
      if (!convRes.rows.length) return;
      const conv = convRes.rows[0];
      const triageState = String(conv.custom_attributes?.fluvius_triage_state || '');
      const lastIncomingId = Number(conv.custom_attributes?.fluvius_triage_last_incoming_id || 0);

      // Skip if this message was already processed
      if (messageId && lastIncomingId && messageId <= lastIncomingId && triageState === 'waiting') return;

      const keyword = String(client.chatbot_trigger_keyword || '').toLowerCase().trim();
      const contentLower = content.toLowerCase();

      // ── Case 1: Trigger keyword detected → reset + re-greet immediately ──
      if (keyword && contentLower.includes(keyword) && triageState !== '') {
        await pool.query(
          `UPDATE conversations SET custom_attributes = custom_attributes
            - 'fluvius_triage_state'
            - 'fluvius_triage_greeted_at'
            - 'fluvius_triage_option'
            - 'fluvius_triage_label'
            - 'fluvius_triage_routed_at'
            - 'fluvius_triage_last_incoming_id'
            - 'fluvius_triage_last_invalid_at'
           WHERE id = $1`,
          [conversationId],
        );
        const convForGreet = {
          id: conversationId,
          display_id: conversationDisplayId,
          account_id: accountId,
          inbox_id: inboxId,
          contact_name: contactName,
        };
        await greetTriageConversation(client, convForGreet);
        console.log(`[triage-webhook] reset+greeted client=${client.id} conversation=${conversationDisplayId}`);
        return;
      }

      // ── Case 2: No triage state → greet immediately ──
      if (!triageState) {
        const convForGreet = {
          id: conversationId,
          display_id: conversationDisplayId,
          account_id: accountId,
          inbox_id: inboxId,
          contact_name: contactName,
        };
        await greetTriageConversation(client, convForGreet);
        console.log(`[triage-webhook] greeted client=${client.id} conversation=${conversationDisplayId}`);
        return;
      }

      // ── Case 3: Waiting for option selection → route immediately ──
      if (triageState === 'waiting') {
        const convForRoute = {
          id: conversationId,
          display_id: conversationDisplayId,
          account_id: accountId,
          inbox_id: inboxId,
          latest_incoming_message_id: messageId,
          latest_incoming_content: content,
        };
        const result = await routeTriageConversation(client, convForRoute);
        console.log(`[triage-webhook] routed client=${client.id} conversation=${conversationDisplayId} routed=${result.routed}`);
      }
    } catch (err) {
      console.warn(`[triage-webhook] error processing conversation=${conversationDisplayId}: ${err.message}`);
    }
  })();
});

async function runTriageBot() {
  if (!TRIAGE_BOT_ENABLED || triageBotRunning) return;
  triageBotRunning = true;
  try {
    const clients = await triageClients();
    for (const client of clients) {
      await resetTriageOnTriggerWord(client);

      const greetings = await pendingTriageGreetings(client);
      for (const conversation of greetings) {
        try {
          await greetTriageConversation(client, conversation);
          console.log(`[triage-polling] greeted client=${client.id} conversation=${conversation.display_id}`);
        } catch (error) {
          console.warn(`[triage-polling] greeting failed client=${client.id} conversation=${conversation.display_id}: ${error.message}`);
        }
      }

      const replies = await waitingTriageReplies(client);
      for (const conversation of replies) {
        try {
          const result = await routeTriageConversation(client, conversation);
          console.log(`[triage-polling] reply client=${client.id} conversation=${conversation.display_id} routed=${result.routed}`);
        } catch (error) {
          console.warn(`[triage-polling] routing failed client=${client.id} conversation=${conversation.display_id}: ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.warn(`[triage-polling] run failed: ${error.message}`);
  } finally {
    triageBotRunning = false;
  }
}

function startTriageBot() {
  if (!TRIAGE_BOT_ENABLED) return;
  console.log(`[triage-polling] enabled every ${TRIAGE_BOT_INTERVAL_SECONDS}s`);
  setTimeout(runTriageBot, 10000);
  setInterval(runTriageBot, TRIAGE_BOT_INTERVAL_SECONDS * 1000);
}

migrateWithRetry()
  .then(() => {
    server.listen(port, () => {
      console.log(`Fluvius internal chat listening on ${port}`);
      startEvolutionHistoryAutoImport();
      startCrmAiAutoAnalysis();
      startTriageBot();
    });
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
