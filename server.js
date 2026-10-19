'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const rooms = new Map();
const fileIndex = new Map();
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 1024 * 1024 * 1024); // 1 GiB by default
const PLAYABLE_PREFIXES = ['video/', 'audio/'];
const ALLOWED_PLAYABLE_TYPES = new Set([
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-m4v',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac', 'audio/flac'
]);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(PUBLIC_DIR));

function safeText(value, maxLength = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
}
function validRoomId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(value);
}
function createRoomId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}
function ensureRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      createdAt: Date.now(),
      users: new Map(),
      files: [],
      media: null,
      playback: { paused: true, currentTime: 0, updatedAt: Date.now(), actor: null },
      messages: []
    };
    rooms.set(roomId, room);
  }
  return room;
}
function publicFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    url: `/media/${encodeURIComponent(file.id)}`,
    uploadedAt: file.uploadedAt,
    playable: file.playable
  };
}
function roomSnapshot(room) {
  return {
    roomId: room.id,
    members: [...room.users.values()].map(({ id, name }) => ({ id, name })),
    files: room.files.map(publicFile),
    media: room.media,
    playback: room.playback,
    messages: room.messages
  };
}
function broadcastMembers(room) {
  io.to(room.id).emit('room:members', [...room.users.values()].map(({ id, name }) => ({ id, name })));
}
function removeSocketFromRoom(socket) {
  const oldRoomId = socket.data.roomId;
  if (!oldRoomId) return;
  const room = rooms.get(oldRoomId);
  socket.data.roomId = null;
  if (!room) return;
  room.users.delete(socket.id);
  socket.leave(oldRoomId);
  broadcastMembers(room);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(_file.originalname).slice(0, 12).replace(/[^.a-zA-Z0-9]/g, '')}`)
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 2 },
  fileFilter: (_req, file, cb) => {
    // Preserve arbitrary shared files, but do not trust the client's MIME type for execution.
    if (file.originalname && file.originalname.length <= 255) cb(null, true);
    else cb(new Error('File name is too long.'));
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/room/:roomId', (req, res) => {
  if (!validRoomId(req.params.roomId)) return res.status(404).send('Room link not found.');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.post('/api/rooms/:roomId/files', (req, res) => {
  const { roomId } = req.params;
  if (!validRoomId(roomId)) return res.status(400).json({ error: 'Invalid room link.' });
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: 'This room does not exist yet. Reopen the room link and try again.' });

  upload.single('file')(req, res, (err) => {
    if (err) {
      const tooLarge = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? `That file is too large. The limit is ${Math.round(MAX_FILE_BYTES / (1024 ** 3))} GB.` : err.message || 'Upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a file first.' });

    const normalizedMime = String(req.file.mimetype || 'application/octet-stream').toLowerCase();
    const playable = ALLOWED_PLAYABLE_TYPES.has(normalizedMime) || PLAYABLE_PREFIXES.some(prefix => normalizedMime.startsWith(prefix));
    const file = {
      id: path.basename(req.file.filename, path.extname(req.file.filename)),
      path: req.file.path,
      name: safeText(path.basename(req.file.originalname), 255) || 'Shared file',
      mimeType: normalizedMime,
      size: req.file.size,
      uploadedAt: Date.now(),
      playable
    };
    fileIndex.set(file.id, file);
    room.files.push(file);
    // Video/audio uploaded into a room becomes the shared selection immediately.
    if (file.playable) {
      room.media = publicFile(file);
      room.playback = { paused: true, currentTime: 0, updatedAt: Date.now(), actor: null };
      io.to(roomId).emit('media:changed', { media: room.media, playback: room.playback });
    }
    io.to(roomId).emit('file:added', publicFile(file));
    res.status(201).json({ file: publicFile(file), media: room.media, playback: room.playback });
  });
});

// Media is streamed inline to support seeking/range requests. Non-media files download as attachments.
app.get('/media/:fileId', (req, res) => {
  const file = fileIndex.get(req.params.fileId);
  if (!file || !fs.existsSync(file.path)) return res.status(404).send('File not found.');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (file.playable) {
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    return res.sendFile(file.path);
  }
  res.download(file.path, file.name);
});

io.on('connection', socket => {
  socket.on('room:create', ack => {
    let id;
    do { id = createRoomId(); } while (rooms.has(id));
    ensureRoom(id);
    if (typeof ack === 'function') ack({ ok: true, roomId: id });
  });

  socket.on('room:join', (payload, ack) => {
    const roomId = safeText(payload?.roomId, 32);
    const name = safeText(payload?.name, 24) || `Guest-${crypto.randomBytes(2).toString('hex')}`;
    if (!validRoomId(roomId)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Room codes must be 4–32 letters or numbers.' });
      return;
    }
    removeSocketFromRoom(socket);
    const room = ensureRoom(roomId);
    socket.join(roomId);
    socket.data.roomId = roomId;
    room.users.set(socket.id, { id: socket.id, name });
    socket.emit('room:state', roomSnapshot(room));
    broadcastMembers(room);
    if (typeof ack === 'function') ack({ ok: true, roomId });
  });

  socket.on('room:leave', () => removeSocketFromRoom(socket));

  socket.on('chat:send', payload => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const text = safeText(payload?.text, 500);
    if (!text) return;
    const member = room.users.get(socket.id);
    const message = {
      id: crypto.randomUUID(),
      userId: socket.id,
      name: member?.name || 'Guest',
      text,
      at: Date.now()
    };
    room.messages.push(message);
    if (room.messages.length > 100) room.messages.splice(0, room.messages.length - 100);
    io.to(roomId).emit('chat:new', message);
  });

  socket.on('media:select', payload => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    const file = fileIndex.get(safeText(payload?.fileId, 80));
    if (!room || !file || !file.playable || !room.files.some(entry => entry.id === file.id)) return;
    room.media = publicFile(file);
    room.playback = { paused: true, currentTime: 0, updatedAt: Date.now(), actor: socket.id };
    io.to(roomId).emit('media:changed', { media: room.media, playback: room.playback });
  });

  socket.on('playback:update', payload => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.media) return;
    const currentTime = Number(payload?.currentTime);
    if (!Number.isFinite(currentTime) || currentTime < 0) return;
    room.playback = {
      paused: Boolean(payload?.paused),
      currentTime: Math.min(currentTime, 24 * 60 * 60),
      updatedAt: Date.now(),
      actor: socket.id
    };
    io.to(roomId).emit('playback:state', room.playback);
  });

  socket.on('disconnect', () => removeSocketFromRoom(socket));
});

// Keep abandoned, empty rooms from accumulating forever in this in-memory MVP.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, room] of rooms) {
    if (room.users.size === 0 && room.createdAt < cutoff) rooms.delete(id);
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`WatchParty is running at http://localhost:${PORT}`);
  console.log(`Per-file upload limit: ${(MAX_FILE_BYTES / (1024 ** 3)).toFixed(1)} GiB`);
});
