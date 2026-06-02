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
const CHATWOOT_API_TOKEN = String(process.env.CHATWOOT_USER_ACCESS_TOKEN || '');
const CHATWOOT_ACCOUNT_ID = String(process.env.CHATWOOT_ACCOUNT_ID || '1');

const allowedOrigins = String(process.env.INTERNAL_CHAT_ALLOWED_ORIGINS || '*')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DATABASE || 'chatwoot',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: '25mb' }));
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

    ALTER TABLE internal_chat_messages
      ADD COLUMN IF NOT EXISTS attachment_kind TEXT,
      ADD COLUMN IF NOT EXISTS attachment_name TEXT,
      ADD COLUMN IF NOT EXISTS attachment_mime TEXT,
      ADD COLUMN IF NOT EXISTS attachment_size BIGINT,
      ADD COLUMN IF NOT EXISTS attachment_url TEXT,
      ADD COLUMN IF NOT EXISTS attachment_data_url TEXT;

    CREATE INDEX IF NOT EXISTS index_internal_chat_messages_room_id_id
      ON internal_chat_messages(room_id, id);

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
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

function userFields(prefix = 'users') {
  return `${prefix}.id, ${prefix}.name, ${prefix}.email`;
}

async function ensureParticipant(roomId, userId) {
  const result = await pool.query(
    'SELECT 1 FROM internal_chat_participants WHERE room_id = $1 AND user_id = $2',
    [roomId, userId],
  );
  return result.rowCount > 0;
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

app.get('/api/agents', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT DISTINCT ${userFields('users')}
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
  if (!userId) return res.status(400).json({ error: 'userId is required' });

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
      GROUP BY rooms.id, last_message.content, last_message.attachment_kind, last_message.created_at, unread.unread_count
      ORDER BY COALESCE(last_message.created_at, rooms.updated_at) DESC
    `,
    [userId],
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
  if (!userId || !otherUserId || userId === otherUserId) {
    return res.status(400).json({ error: 'valid userId and otherUserId are required' });
  }

  const [first, second] = [userId, otherUserId].sort((a, b) => a - b);
  const dmKey = `${first}:${second}`;

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
  const title = String(req.body.title || '').trim();
  const participantIds = [...new Set((req.body.participantIds || []).map(Number).filter(Boolean))];
  if (!userId || !title || participantIds.length === 0) {
    return res.status(400).json({ error: 'userId, title and participantIds are required' });
  }

  const allParticipants = [...new Set([userId, ...participantIds])];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const room = await client.query(
      'INSERT INTO internal_chat_rooms (kind, title, created_by) VALUES ($1, $2, $3) RETURNING id, kind, title, updated_at',
      ['group', title, userId],
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
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipant(roomId, userId))) return res.status(403).json({ error: 'not a participant' });

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
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipant(roomId, userId))) return res.status(403).json({ error: 'not a participant' });

  const room = await pool.query(
    `
      SELECT id, kind, title, updated_at
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
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipant(roomId, userId))) return res.status(403).json({ error: 'not a participant' });

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
  if (!roomId || !userId) return res.status(400).json({ error: 'roomId and userId are required' });
  if (!(await ensureParticipant(roomId, userId))) return res.status(403).json({ error: 'not a participant' });

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

async function evoFetch(path, options = {}) {
  const res = await fetch(`${EVOLUTION_URL}${path}`, {
    ...options,
    headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}

async function cwtFetch(path, options = {}) {
  const res = await fetch(`${CHATWOOT_URL}${path}`, {
    ...options,
    headers: { api_access_token: CHATWOOT_API_TOKEN, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}

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

  const inboxToken = cwt.data?.channel_id ? cwt.data : cwt.data;
  const accessToken = cwt.data?.inbox_identifier || cwt.data?.channel?.identifier || '';

  // 3. Link Evolution → Chatwoot
  await evoFetch(`/chatwoot/set/${name}`, {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      account_id: CHATWOOT_ACCOUNT_ID,
      token: accessToken,
      url: CHATWOOT_URL,
      sign_msg: false,
      reopen_conversation: true,
      conversation_pending: false,
    }),
  });

  res.json({ instance: evo.data, inbox: cwt.data });
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
  const { rows } = await pool.query('SELECT * FROM fluvius_clients ORDER BY created_at DESC');
  res.json(rows);
});

// Create and fully provision a client
app.post('/manager/api/clients', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });

  const token = randomBytes(24).toString('base64url');
  const instanceName = `fluvius-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 32)}-${Date.now().toString(36)}`;

  // 1. Create Evolution instance
  const evo = await evoFetch('/instance/create', {
    method: 'POST',
    body: JSON.stringify({ instanceName, integration: 'WHATSAPP-BAILEYS' }),
  });
  if (evo.status >= 300) return res.status(evo.status).json({ step: 'create_instance', error: evo.data });

  // 2. Create Chatwoot inbox
  let inboxId = null;
  let inboxToken = '';
  if (CHATWOOT_API_TOKEN) {
    const cwt = await cwtFetch(`/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/inboxes`, {
      method: 'POST',
      body: JSON.stringify({ name, channel: { type: 'api', webhook_url: '' } }),
    });
    if (cwt.status < 300) {
      inboxId = cwt.data?.id || null;
      inboxToken = cwt.data?.inbox_identifier || cwt.data?.channel?.identifier || '';

      // 3. Link Evolution → Chatwoot
      await evoFetch(`/chatwoot/set/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify({
          enabled: true,
          account_id: CHATWOOT_ACCOUNT_ID,
          token: inboxToken,
          url: 'http://chatwoot:3000',
          sign_msg: false,
          reopen_conversation: true,
          conversation_pending: false,
        }),
      });
    }
  }

  // 4. Save client to DB
  const { rows } = await pool.query(
    `INSERT INTO fluvius_clients (name, email, token, instance_name, inbox_id, inbox_token, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
    [name, email || null, token, instanceName, inboxId, inboxToken],
  );

  res.json(rows[0]);
});

// Delete client + Evolution instance
app.delete('/manager/api/clients/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM fluvius_clients WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  const client = rows[0];
  if (client.instance_name) {
    await evoFetch(`/instance/delete/${client.instance_name}`, { method: 'DELETE' });
  }
  await pool.query('DELETE FROM fluvius_clients WHERE id = $1', [id]);
  res.json({ ok: true });
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
  res.json({ name: client.name, status: client.status, phone: client.phone });
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
  socket.on('user:join', async ({ userId }) => {
    const parsedUserId = Number(userId);
    if (!parsedUserId) return;
    socket.data.userId = parsedUserId;
    socket.join(`user:${parsedUserId}`);
    if (!onlineUsers.has(parsedUserId)) onlineUsers.set(parsedUserId, new Set());
    onlineUsers.get(parsedUserId).add(socket.id);
    await emitUnread(parsedUserId);
    socket.emit('presence:update', { onlineUserIds: onlineUserIds() });
    emitPresence();
  });

  socket.on('join', async ({ userId, roomId }) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    if (!parsedUserId || !parsedRoomId) return;
    if (!(await ensureParticipant(parsedRoomId, parsedUserId))) return;
    socket.join(`room:${parsedRoomId}`);
  });

  socket.on('typing:start', async ({ userId, roomId }) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    if (!parsedUserId || !parsedRoomId) return;
    if (!(await ensureParticipant(parsedRoomId, parsedUserId))) return;
    socket.to(`room:${parsedRoomId}`).emit('typing:update', { roomId: parsedRoomId, userId: parsedUserId, typing: true });
  });

  socket.on('typing:stop', async ({ userId, roomId }) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    if (!parsedUserId || !parsedRoomId) return;
    if (!(await ensureParticipant(parsedRoomId, parsedUserId))) return;
    socket.to(`room:${parsedRoomId}`).emit('typing:update', { roomId: parsedRoomId, userId: parsedUserId, typing: false });
  });

  socket.on('message:create', async ({ userId, roomId, content, attachment }, callback) => {
    const parsedUserId = Number(userId);
    const parsedRoomId = Number(roomId);
    const parsedContent = String(content || '').trim();
    const parsedAttachment = normalizeAttachment(attachment);
    if (!parsedUserId || !parsedRoomId || (!parsedContent && !parsedAttachment)) return;
    if (!(await ensureParticipant(parsedRoomId, parsedUserId))) return;

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
    if (!userId || !onlineUsers.has(userId)) return;
    onlineUsers.get(userId).delete(socket.id);
    if (onlineUsers.get(userId).size === 0) onlineUsers.delete(userId);
    emitPresence();
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
