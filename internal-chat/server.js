import express from 'express';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { randomBytes } from 'crypto';
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
const CHATWOOT_API_TOKEN = String(process.env.CHATWOOT_USER_ACCESS_TOKEN || '');
const CHATWOOT_PLATFORM_TOKEN = String(process.env.CHATWOOT_PLATFORM_TOKEN || '');
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || '1');
const MANAGER_ADMIN_TOKEN = String(process.env.MANAGER_ADMIN_TOKEN || '');

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
  inbox_id,
  inbox_token,
  phone,
  status,
  chatwoot_account_id,
  chatwoot_user_id,
  chatwoot_user_email,
  created_at,
  updated_at
`;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
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
      ADD COLUMN IF NOT EXISTS chatwoot_temp_password TEXT;
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

// Standalone selector bootstrap. Chatwoot embeds should call /api/agents with userId/accountId.
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
    const res = await fetch(`${EVOLUTION_URL}${path}`, {
      ...options,
      headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
  }
}

async function cwtFetch(path, options = {}) {
  try {
    const res = await fetch(`${CHATWOOT_URL}${path}`, {
      ...options,
      headers: { api_access_token: CHATWOOT_API_TOKEN, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
  }
}

// Uses Chatwoot Platform API token for account/user provisioning
async function platformFetch(path, options = {}) {
  try {
    const res = await fetch(`${CHATWOOT_URL}${path}`, {
      ...options,
      headers: { api_access_token: CHATWOOT_PLATFORM_TOKEN, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
  }
}

// Uses a specific user's access token for a given Chatwoot account
async function cwtAccountFetch(path, userToken, options = {}) {
  try {
    const res = await fetch(`${CHATWOOT_URL}${path}`, {
      ...options,
      headers: { api_access_token: userToken, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  } catch (err) {
    return { status: 503, data: { error: 'Network/Fetch Error', details: err.message } };
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

async function enableEvolutionHistorySync(instanceName, accountId, userToken) {
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
    body: JSON.stringify({
      enabled: true,
      accountId: String(accountId),
      token: userToken,
      url: CHATWOOT_URL,
      signMsg: false,
      reopenConversation: true,
      conversationPending: false,
      importContacts: true,
      importMessages: true,
      daysLimitImportMessages: 365,
    }),
  });

  return { settings, chatwoot };
}

async function getChatwootUserIdByEmail(email) {
  const { rows } = await pool.query('SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
  return rows[0]?.id || null;
}

async function getPlatformUserToken(userId) {
  const token = await platformFetch(`/platform/api/v1/users/${userId}/token`, { method: 'POST' });
  if (token.status >= 300) return null;
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

function evolutionRemoteJid(key = {}) {
  return key.remoteJidAlt || key.remoteJid || '';
}

function jidPhone(jid) {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  return `+${jid.split('@')[0].replace(/\D/g, '')}`;
}

function contactNameFromEvolution(row, remoteJid) {
  const chatName = String(row.chat_name || row.name || '').trim();
  const pushName = String(row.pushName || '').trim();
  if (chatName && chatName !== 'Você') return chatName;
  if (pushName && pushName !== 'Você') return pushName;
  return String(remoteJid || '').split('@')[0] || 'Contato';
}

function evolutionDate(value, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function ensureChatwootThreadForRemoteJid({
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
    'SELECT id, contact_id, contact_inbox_id FROM conversations WHERE account_id = $1 AND inbox_id = $2 AND contact_inbox_id = $3 LIMIT 1',
    [client.chatwoot_account_id, client.inbox_id, contactInbox.rows[0].id],
  );

  if (!conversation.rowCount) {
    conversation = await pool.query(
      `
        INSERT INTO conversations
          (account_id, inbox_id, status, created_at, updated_at, contact_id, contact_inbox_id, additional_attributes, custom_attributes, last_activity_at, identifier)
        VALUES
          ($1, $2, 0, $3, $3, $4, $5, '{}', '{}', $3, $6)
        RETURNING id, contact_id, contact_inbox_id
      `,
      [client.chatwoot_account_id, client.inbox_id, createdDate, contact.rows[0].id, contactInbox.rows[0].id, remoteJid],
    );
    if (stats) stats.conversations_created += 1;
  }

  const conversationData = {
    id: conversation.rows[0].id,
    contact_id: conversation.rows[0].contact_id || contact.rows[0].id,
    contact_inbox_source_id: contactInbox.rows[0].source_id,
  };

  conversationCache.set(cacheKey, conversationData);
  return conversationData;
}

async function importEvolutionHistoryForClient(client) {
  if (!client.instance_name || !client.chatwoot_account_id || !client.inbox_id) {
    throw new Error('client is missing instance/account/inbox');
  }

  const instance = await evolutionPool.query('SELECT id FROM "Instance" WHERE name = $1 LIMIT 1', [client.instance_name]);
  if (!instance.rowCount) throw new Error(`Evolution instance not found: ${client.instance_name}`);
  const instanceId = instance.rows[0].id;

  let userId = client.chatwoot_user_id || null;
  if (!userId && client.chatwoot_user_email) {
    userId = await getChatwootUserIdByEmail(client.chatwoot_user_email);
    if (userId) await pool.query('UPDATE fluvius_clients SET chatwoot_user_id = $1 WHERE id = $2', [userId, client.id]);
  }
  if (!userId) {
    const fallback = await pool.query(
      'SELECT users.id FROM users INNER JOIN account_users ON account_users.user_id = users.id WHERE account_users.account_id = $1 ORDER BY users.id LIMIT 1',
      [client.chatwoot_account_id],
    );
    userId = fallback.rows[0]?.id || null;
  }
  if (!userId) throw new Error(`No Chatwoot user found for account ${client.chatwoot_account_id}`);

  const userToken = await getPlatformUserToken(userId);
  if (userToken) await enableEvolutionHistorySync(client.instance_name, client.chatwoot_account_id, userToken);

  const [contactsResult, chatsResult, evolutionRows] = await Promise.all([
    evolutionPool.query(
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
    ),
    evolutionPool.query(
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
    ),
    evolutionPool.query(
      `
        SELECT
          m.id,
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
      `,
      [instanceId],
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
  };
  const conversationCache = new Map();
  const seenRemoteJids = new Set();

  for (const row of contactsResult.rows) {
    const remoteJid = evolutionRemoteJid(row);
    if (!remoteJid || remoteJid === 'status@broadcast' || seenRemoteJids.has(remoteJid)) continue;
    await ensureChatwootThreadForRemoteJid({
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
    await ensureChatwootThreadForRemoteJid({
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

  for (const row of evolutionRows.rows) {
    const key = safeJsonParse(row.key);
    const remoteJid = evolutionRemoteJid(key);
    if (!remoteJid || remoteJid === 'status@broadcast') {
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
      await evolutionPool.query(
        'UPDATE "Message" SET "chatwootMessageId" = $1, "chatwootInboxId" = $2, "chatwootConversationId" = $3, "chatwootContactInboxSourceId" = $4, "chatwootIsRead" = true WHERE id = $5',
        [existing.id, existing.inbox_id, existing.conversation_id, existing.contact_inbox_source_id, row.id],
      );
      stats.messages_relinked += 1;
      continue;
    }

    const content = evolutionMessageContent(row).trim();
    const createdAt = new Date(Number(row.messageTimestamp) * 1000);
    const contactName = contactNameFromEvolution(row, remoteJid);
    const conversation = await ensureChatwootThreadForRemoteJid({
      client,
      remoteJid,
      displayName: contactName,
      createdAt,
      conversationCache,
      stats,
    });
    if (!conversation) {
      stats.messages_skipped += 1;
      continue;
    }

    if (!content) {
      stats.messages_skipped += 1;
      continue;
    }

    const fromMe = key.fromMe === true || String(key.fromMe) === 'true';
    const senderType = fromMe ? 'User' : 'Contact';
    const senderId = fromMe ? userId : conversation.contact_id;
    const messageType = fromMe ? 1 : 0;

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

    await evolutionPool.query(
      'UPDATE "Message" SET "chatwootMessageId" = $1, "chatwootInboxId" = $2, "chatwootConversationId" = $3, "chatwootContactInboxSourceId" = $4, "chatwootIsRead" = true WHERE id = $5',
      [message.rows[0].id, client.inbox_id, conversation.id, conversation.contact_inbox_source_id, row.id],
    );

    stats.messages_imported += 1;
  }

  return {
    client_id: client.id,
    instance_name: client.instance_name,
    account_id: client.chatwoot_account_id,
    inbox_id: client.inbox_id,
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

// Create instance + Chatwoot inbox and link them
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

  // 2. Create Chatwoot inbox
  const cwt = await cwtFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes`, {
    method: 'POST',
    body: JSON.stringify({ name, channel: { type: 'api', webhook_url: '' } }),
  });
  if (cwt.status >= 300) return res.status(cwt.status).json({ step: 'create_inbox', error: cwt.data });

  const inboxToken = cwt.data?.channel_id || cwt.data?.id || '';
  const accessToken = cwt.data?.inbox_identifier || cwt.data?.channel?.identifier || '';

  // 3. Link Evolution → Chatwoot
  const link = await evoFetch(`/chatwoot/set/${name}`, {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      accountId: CHATWOOT_ACCOUNT_ID,
      token: CHATWOOT_API_TOKEN,
      url: CHATWOOT_URL,
      signMsg: false,
      reopenConversation: true,
      conversationPending: false,
    }),
  });
  if (link.status >= 300) return res.status(link.status).json({ step: 'link_chatwoot', error: link.data });

  res.json({ instance: evo.data, inbox: cwt.data, link: link.data });
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
app.get('/manager/api/clients', async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${CLIENT_PUBLIC_FIELDS} FROM fluvius_clients ORDER BY created_at DESC`);
  res.json(rows);
});

// Create and fully provision a client (multi-tenant: creates Chatwoot account + user)
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
  const created = {};

  try {
    // STEP 1: Create Chatwoot account for the company
    const acct = await platformFetch('/platform/api/v1/accounts', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    if (acct.status >= 300) {
      const err = provisioningError('create_chatwoot_account', acct);
      return res.status(err.status).json(err.body);
    }

    const accountId = acct.data?.id;
    if (!accountId) throw new Error('Chatwoot account response did not include id');
    created.accountId = accountId;

    // STEP 2: Create Chatwoot user (admin of the company)
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
    if (!userId || !userToken) throw new Error('Chatwoot user response did not include id/access_token');

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

    // STEP 5: Create Chatwoot inbox inside the company's account
    // Uses the user's token to create within the correct account
    const cwt = await cwtAccountFetch(`/api/v1/accounts/${accountId}/inboxes`, userToken, {
      method: 'POST',
      body: JSON.stringify({ name: instanceName, channel: { type: 'api', webhook_url: '' } }),
    });
    if (cwt.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('create_inbox', cwt, cleanup);
      return res.status(err.status).json(err.body);
    }

    const inboxId = cwt.data?.id || null;
    const inboxToken = cwt.data?.inbox_identifier || '';
    if (!inboxId || !inboxToken) throw new Error('Chatwoot inbox response did not include id/inbox_identifier');

    // STEP 6: Link Evolution to Chatwoot using the user's access token.
    const link = await evoFetch(`/chatwoot/set/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        accountId: String(accountId),
        token: userToken,
        url: CHATWOOT_URL,
        signMsg: false,
        reopenConversation: true,
        conversationPending: false,
        importContacts: true,
        importMessages: true,
        daysLimitImportMessages: 365,
      }),
    });
    if (link.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      const err = provisioningError('link_chatwoot', link, cleanup);
      return res.status(err.status).json(err.body);
    }

    const historySync = await enableEvolutionHistorySync(instanceName, accountId, userToken);
    if (historySync.settings.status >= 300 || historySync.chatwoot.status >= 300) {
      const cleanup = await cleanupProvisioning(created);
      return res.status(500).json({
        step: 'enable_history_sync',
        error: { settings: historySync.settings.data, chatwoot: historySync.chatwoot.data },
        cleanup,
      });
    }

    // STEP 7: Update inbox webhook so Chatwoot replies go back to Evolution.
    const evolutionWebhookUrl = `${EVOLUTION_URL}/chatwoot/webhook/${instanceName}`;
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
        (name, email, token, instance_name, inbox_id, inbox_token, status, chatwoot_account_id, chatwoot_user_id, chatwoot_user_email)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
       RETURNING ${CLIENT_PUBLIC_FIELDS}`,
      [name, email, onboardToken, instanceName, inboxId, inboxToken, accountId, userId, email],
    );

    return res.json({ ...rows[0], chatwoot_temp_password: tempPassword, chatwoot_url: CHATWOOT_PUBLIC_URL });
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
    adminUserId = await getChatwootUserIdByEmail(client.chatwoot_user_email);
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
      if (!userId) throw new Error(`Chatwoot agent response did not include id for ${agent.email}`);
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

app.post('/manager/api/clients/:id/import-history', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'client not found' });

  try {
    const result = await importEvolutionHistoryForClient(rows[0]);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      step: 'import_history',
      error: err.message,
    });
  }
});

// Delete client + Evolution instance
app.delete('/manager/api/clients/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const client = rows[0];
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
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE token = $1', [token]);
  return rows[0] || null;
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
  res.json({ name: client.name, status: client.status, phone: client.phone, chatwootUrl });
});

// Get QR code for onboarding
app.get('/onboard/:token/qr', async (req, res) => {
  const client = await getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  const { status, data } = await evoFetch(`/instance/connect/${client.instance_name}`);
  res.status(status).json(data);
});

// Request phone pairing code
app.post('/onboard/:token/phone', async (req, res) => {
  const client = await getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  const phone = String(req.body.phone || '').replace(/\D/g, '');
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Número inválido' });
  const { status, data } = await evoFetch(`/instance/pairingCode/${client.instance_name}`, {
    method: 'POST',
    body: JSON.stringify({ number: phone }),
  });
  res.status(status).json(data);
});

// Check connection status (for polling)
app.get('/onboard/:token/status', async (req, res) => {
  const client = await getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: 'Link inválido' });
  const { data } = await evoFetch(`/instance/connectionState/${client.instance_name}`);
  const state = (data?.instance?.state || data?.state || '').toLowerCase();
  const phone = data?.instance?.profileName || data?.instance?.wuid?.replace('@s.whatsapp.net','') || '';
  if (state === 'open' && client.status !== 'connected') {
    await pool.query(
      'UPDATE fluvius_clients SET status=$1, phone=$2, updated_at=NOW() WHERE token=$3',
      ['connected', phone || client.phone, req.params.token],
    );
  }
  res.json({ state, phone });
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

migrateWithRetry()
  .then(() => {
    server.listen(port, () => {
      console.log(`Fluvius internal chat listening on ${port}`);
    });
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
