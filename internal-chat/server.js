import express from 'express';
import fs from 'fs/promises';
import http from 'http';
import path from 'path';
import { Server } from 'socket.io';
import pg from 'pg';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, 'public', 'uploads');

const port = Number(process.env.PORT || 4000);
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
