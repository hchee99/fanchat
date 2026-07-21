// ─────────────────────────────────────────────────────────────
// fanchat 서버 — 방송인↔팬 1:1 채팅 플랫폼
// 구조는 미니 카카오톡과 같은 "우체국"인데, 세 가지가 추가됐어요:
//   1. 로그인 (내가 누구인지 서버가 기억)
//   2. 방 = 방송인+팬 짝 (초대 링크로 생성)
//   3. 데이터베이스 저장 (서버가 재시작해도 대화 유지)
// ─────────────────────────────────────────────────────────────
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 지금 접속 중인 사람들: userId -> 그 사람의 연결들(폰+PC 동시 접속 가능하게 Set)
const online = new Map();

// ── 비밀번호는 절대 그대로 저장하지 않아요 ──
// 해시 = 원본을 복원할 수 없는 일방향 지문. 유출돼도 비밀번호를 알 수 없어요.
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

// ─────────── 회원가입 / 로그인 (HTTP API) ───────────
app.post('/api/signup', (req, res) => {
  const nickname = String(req.body.nickname || '').trim().slice(0, 20);
  const password = String(req.body.password || '');
  const isBroadcaster = req.body.isBroadcaster ? 1 : 0;

  if (nickname.length < 2) return res.status(400).json({ error: '닉네임은 2글자 이상이어야 해요' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4글자 이상이어야 해요' });

  const salt = crypto.randomBytes(16).toString('hex');
  try {
    db.prepare('INSERT INTO users (nickname, pw_hash, pw_salt, is_broadcaster, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(nickname, hashPassword(password, salt), salt, isBroadcaster, Date.now());
  } catch {
    return res.status(409).json({ error: '이미 사용 중인 닉네임이에요' });
  }
  return login(res, nickname, password);
});

app.post('/api/login', (req, res) => {
  return login(res, String(req.body.nickname || '').trim(), String(req.body.password || ''));
});

function login(res, nickname, password) {
  const user = db.prepare('SELECT * FROM users WHERE nickname = ?').get(nickname);
  if (!user || hashPassword(password, user.pw_salt) !== user.pw_hash) {
    return res.status(401).json({ error: '닉네임 또는 비밀번호가 맞지 않아요' });
  }
  // 토큰 = 로그인 성공 증표. 이후 요청마다 이걸로 본인 확인 (매번 비밀번호를 보내지 않게)
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, Date.now());
  res.json({ token, user: { id: user.id, nickname: user.nickname, isBroadcaster: !!user.is_broadcaster } });
}

// ─────────── 자주 쓰는 조회들 ───────────

// 내 채팅방 목록: 상대 이름 + 마지막 메시지 + 안 읽은 개수, 최신순
function getRoomList(userId) {
  return db.prepare(`
    SELECT r.id,
      u.nickname AS peer,
      u.is_broadcaster AS peerIsBroadcaster,
      (SELECT text FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) AS lastText,
      (SELECT created_at FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) AS lastTime,
      (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id AND m.sender_id != ? AND m.read = 0) AS unread
    FROM rooms r
    JOIN users u ON u.id = CASE WHEN r.broadcaster_id = ? THEN r.fan_id ELSE r.broadcaster_id END
    WHERE r.broadcaster_id = ? OR r.fan_id = ?
    ORDER BY COALESCE(lastTime, r.created_at) DESC
  `).all(userId, userId, userId, userId);
}

function getRoomIfMember(roomId, userId) {
  return db.prepare('SELECT * FROM rooms WHERE id = ? AND (broadcaster_id = ? OR fan_id = ?)')
    .get(roomId, userId, userId);
}

// 특정 사람에게 보내기 (접속 중인 모든 기기로)
function sendTo(userId, data) {
  const sockets = online.get(userId);
  if (!sockets) return;
  const msg = JSON.stringify(data);
  for (const s of sockets) {
    if (s.readyState === 1) s.send(msg);
  }
}

// 방 목록이 바뀌었으니 다시 그리라고 알려주기
function pushRoomList(userId) {
  sendTo(userId, { type: 'rooms', rooms: getRoomList(userId) });
}

// ─────────── 실시간 통신 (WebSocket) ───────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // [인증] 연결 후 첫 메시지로 토큰을 보내 본인 확인
    if (data.type === 'auth') {
      const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(String(data.token || ''));
      if (!session) return ws.send(JSON.stringify({ type: 'auth_fail' }));
      ws.userId = session.user_id;
      if (!online.has(ws.userId)) online.set(ws.userId, new Set());
      online.get(ws.userId).add(ws);
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      pushRoomList(ws.userId);
      return;
    }

    if (!ws.userId) return; // 인증 전에는 아무것도 못 함

    // [방송인 방 만들기] 팬이 초대 링크로 들어옴 → 그 방송인과의 방을 찾거나 새로 만듦
    if (data.type === 'join_broadcaster') {
      const b = db.prepare('SELECT * FROM users WHERE nickname = ? AND is_broadcaster = 1')
        .get(String(data.nickname || ''));
      if (!b) return ws.send(JSON.stringify({ type: 'error', text: '그런 방송인을 찾을 수 없어요' }));
      if (b.id === ws.userId) return ws.send(JSON.stringify({ type: 'error', text: '자기 자신과는 채팅할 수 없어요' }));

      let room = db.prepare('SELECT * FROM rooms WHERE broadcaster_id = ? AND fan_id = ?').get(b.id, ws.userId);
      if (!room) {
        const r = db.prepare('INSERT INTO rooms (broadcaster_id, fan_id, created_at) VALUES (?, ?, ?)')
          .run(b.id, ws.userId, Date.now());
        room = { id: r.lastInsertRowid };
        pushRoomList(b.id); // 방송인 목록에도 새 방이 뜨게
      }
      pushRoomList(ws.userId);
      ws.send(JSON.stringify({ type: 'joined', roomId: room.id }));
    }

    // [방 열기] 이전 대화를 보내주고, 상대가 보낸 메시지를 읽음 처리
    else if (data.type === 'open_room') {
      const room = getRoomIfMember(data.roomId, ws.userId);
      if (!room) return;
      const peerId = room.broadcaster_id === ws.userId ? room.fan_id : room.broadcaster_id;
      const peer = db.prepare('SELECT nickname FROM users WHERE id = ?').get(peerId);

      db.prepare('UPDATE messages SET read = 1 WHERE room_id = ? AND sender_id != ?').run(room.id, ws.userId);
      sendTo(peerId, { type: 'read', roomId: room.id }); // 상대 화면의 숫자 1 지우기

      const messages = db.prepare('SELECT id, sender_id, text, created_at, read FROM messages WHERE room_id = ? ORDER BY id')
        .all(room.id);
      ws.send(JSON.stringify({ type: 'history', roomId: room.id, peer: peer.nickname, messages }));
      pushRoomList(ws.userId);
    }

    // [채팅] 저장하고 → 나와 상대 모두에게 전달 (미니 카카오톡과 같은 심장부)
    else if (data.type === 'chat') {
      const room = getRoomIfMember(data.roomId, ws.userId);
      if (!room) return;
      const text = String(data.text || '').slice(0, 1000).trim();
      if (!text) return;

      const now = Date.now();
      const r = db.prepare('INSERT INTO messages (room_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)')
        .run(room.id, ws.userId, text, now);

      const msg = { type: 'chat', roomId: room.id, message: { id: r.lastInsertRowid, sender_id: ws.userId, text, created_at: now, read: 0 } };
      const peerId = room.broadcaster_id === ws.userId ? room.fan_id : room.broadcaster_id;
      sendTo(ws.userId, msg);
      sendTo(peerId, msg);
      pushRoomList(ws.userId);
      pushRoomList(peerId);
    }

    // [읽음 확인] 방을 보고 있는 상태에서 새 메시지가 도착했을 때
    else if (data.type === 'read') {
      const room = getRoomIfMember(data.roomId, ws.userId);
      if (!room) return;
      db.prepare('UPDATE messages SET read = 1 WHERE room_id = ? AND sender_id != ?').run(room.id, ws.userId);
      const peerId = room.broadcaster_id === ws.userId ? room.fan_id : room.broadcaster_id;
      sendTo(peerId, { type: 'read', roomId: room.id });
      pushRoomList(ws.userId);
    }
  });

  ws.on('close', () => {
    if (!ws.userId) return;
    const set = online.get(ws.userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) online.delete(ws.userId);
    }
  });
});

const PORT = process.env.PORT || 3100;
server.listen(PORT, () => {
  console.log(`fanchat 서버 실행 중: http://localhost:${PORT}`);
});
