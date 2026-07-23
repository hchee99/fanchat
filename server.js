// ─────────────────────────────────────────────────────────────
// fanchat 서버 — 방송인↔팬 1:1 채팅 플랫폼
// 구조는 미니 카카오톡과 같은 "우체국"인데, 세 가지가 추가됐어요:
//   1. 로그인 (내가 누구인지 서버가 기억)
//   2. 방 = 방송인+팬 짝 (초대 링크로 생성)
//   3. 데이터베이스 저장 — Turso 클라우드(영구) 또는 로컬 파일 (db.js 참고)
// 데이터베이스가 클라우드에 있을 수 있어서 모든 DB 작업은 await로 기다려요.
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

// 보안 질문의 "답"도 비밀번호처럼 해시로 저장해요. 대소문자/앞뒤공백은 무시(normalize).
function normalizeAnswer(a) {
  return String(a || '').trim().toLowerCase();
}

// 서버 상태 확인용 (지금 어떤 저장소를 쓰는지 — Turso 연결 문제 진단에 사용)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    storage: process.env.TURSO_DATABASE_URL ? 'turso' : 'file',
  });
});

// ─────────── 회원가입 / 로그인 (HTTP API) ───────────
app.post('/api/signup', async (req, res) => {
  const nickname = String(req.body.nickname || '').trim().slice(0, 20);
  const password = String(req.body.password || '');
  const isBroadcaster = req.body.isBroadcaster ? 1 : 0;
  const securityQ = String(req.body.securityQuestion || '').trim().slice(0, 100);
  const securityA = normalizeAnswer(req.body.securityAnswer);

  if (nickname.length < 2) return res.status(400).json({ error: '닉네임은 2글자 이상이어야 해요' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4글자 이상이어야 해요' });
  if (!securityQ) return res.status(400).json({ error: '보안 질문을 선택해주세요' });
  if (securityA.length < 1) return res.status(400).json({ error: '보안 질문의 답을 입력해주세요' });

  const salt = crypto.randomBytes(16).toString('hex');
  const saSalt = crypto.randomBytes(16).toString('hex');
  try {
    await db.run(
      'INSERT INTO users (nickname, pw_hash, pw_salt, is_broadcaster, created_at, security_q, sa_hash, sa_salt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [nickname, hashPassword(password, salt), salt, isBroadcaster, Date.now(), securityQ, hashPassword(securityA, saSalt), saSalt]
    );
  } catch {
    return res.status(409).json({ error: '이미 사용 중인 닉네임이에요' });
  }
  return login(res, nickname, password);
});

app.post('/api/login', (req, res) => {
  return login(res, String(req.body.nickname || '').trim(), String(req.body.password || ''));
});

// [비번찾기 1단계] 닉네임을 주면 그 사람의 보안 질문을 알려줌
app.post('/api/forgot/question', async (req, res) => {
  const user = await db.get('SELECT security_q FROM users WHERE nickname = ?', [String(req.body.nickname || '').trim()]);
  if (!user) return res.status(404).json({ error: '그런 닉네임이 없어요' });
  if (!user.security_q) return res.status(400).json({ error: '이 계정은 보안 질문이 없어 재설정할 수 없어요. 새로 가입해주세요' });
  res.json({ question: user.security_q });
});

// [비번찾기 2단계] 답이 맞으면 새 비밀번호로 교체
app.post('/api/forgot/reset', async (req, res) => {
  const nickname = String(req.body.nickname || '').trim();
  const answer = normalizeAnswer(req.body.securityAnswer);
  const newPassword = String(req.body.newPassword || '');
  if (newPassword.length < 4) return res.status(400).json({ error: '새 비밀번호는 4글자 이상이어야 해요' });

  const user = await db.get('SELECT * FROM users WHERE nickname = ?', [nickname]);
  if (!user || !user.sa_hash) return res.status(404).json({ error: '재설정할 수 없는 계정이에요' });
  if (hashPassword(answer, user.sa_salt) !== user.sa_hash) {
    return res.status(401).json({ error: '보안 질문의 답이 맞지 않아요' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await db.run('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?', [hashPassword(newPassword, salt), salt, user.id]);
  return login(res, nickname, newPassword); // 재설정 후 바로 로그인
});

async function login(res, nickname, password) {
  const user = await db.get('SELECT * FROM users WHERE nickname = ?', [nickname]);
  if (!user || hashPassword(password, user.pw_salt) !== user.pw_hash) {
    return res.status(401).json({ error: '닉네임 또는 비밀번호가 맞지 않아요' });
  }
  // 토큰 = 로그인 성공 증표. 이후 요청마다 이걸로 본인 확인 (매번 비밀번호를 보내지 않게)
  const token = crypto.randomBytes(32).toString('hex');
  await db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', [token, user.id, Date.now()]);
  res.json({ token, user: { id: user.id, nickname: user.nickname, isBroadcaster: !!user.is_broadcaster, avatar: user.avatar || null } });
}

// ─────────── 자주 쓰는 조회들 ───────────

// 내 채팅방 목록: 상대 이름 + 마지막 메시지 + 안 읽은 개수, 최신순
function getRoomList(userId) {
  return db.all(`
    SELECT r.id,
      u.nickname AS peer,
      u.is_broadcaster AS peerIsBroadcaster,
      u.avatar AS peerAvatar,
      (SELECT CASE WHEN m.kind IN ('image', 'announce_image') THEN '[사진]' ELSE m.text END FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) AS lastText,
      (SELECT created_at FROM messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) AS lastTime,
      (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id AND m.sender_id != ? AND m.read = 0) AS unread
    FROM rooms r
    JOIN users u ON u.id = CASE WHEN r.broadcaster_id = ? THEN r.fan_id ELSE r.broadcaster_id END
    WHERE r.broadcaster_id = ? OR r.fan_id = ?
    ORDER BY COALESCE(lastTime, r.created_at) DESC
  `, [userId, userId, userId, userId]);
}

function getRoomIfMember(roomId, userId) {
  return db.get('SELECT * FROM rooms WHERE id = ? AND (broadcaster_id = ? OR fan_id = ?)', [roomId, userId, userId]);
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
async function pushRoomList(userId) {
  if (!online.has(userId)) return; // 접속 중이 아니면 조회할 필요도 없음
  sendTo(userId, { type: 'rooms', rooms: await getRoomList(userId) });
}

// ─────────── 실시간 통신 (WebSocket) ───────────
wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    try {
      // [인증] 연결 후 첫 메시지로 토큰을 보내 본인 확인
      if (data.type === 'auth') {
        const session = await db.get('SELECT * FROM sessions WHERE token = ?', [String(data.token || '')]);
        if (!session) return ws.send(JSON.stringify({ type: 'auth_fail' }));
        ws.userId = session.user_id;
        const u = await db.get('SELECT nickname, is_broadcaster, avatar FROM users WHERE id = ?', [ws.userId]);
        ws.nickname = u ? u.nickname : '';
        ws.isBroadcaster = u ? !!u.is_broadcaster : false;
        ws.avatar = u ? (u.avatar || null) : null;
        if (!online.has(ws.userId)) online.set(ws.userId, new Set());
        online.get(ws.userId).add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        await pushRoomList(ws.userId);
        return;
      }

      if (!ws.userId) return; // 인증 전에는 아무것도 못 함

      // [프로필 사진 설정] 압축된 사진(dataURL)을 내 프사로 저장
      if (data.type === 'set_avatar') {
        const dataUrl = String(data.dataUrl || '');
        if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(dataUrl)) return;
        if (dataUrl.length > 500_000) { // 프사는 작아도 되니 상한을 낮게
          return ws.send(JSON.stringify({ type: 'error', text: '프로필 사진이 너무 커요.' }));
        }
        await db.run('UPDATE users SET avatar = ? WHERE id = ?', [dataUrl, ws.userId]);
        ws.avatar = dataUrl;
        ws.send(JSON.stringify({ type: 'avatar_set', avatar: dataUrl }));
        return;
      }

      // [프로필 사진 제거] 기본(글자 동그라미)으로 되돌리기
      if (data.type === 'remove_avatar') {
        await db.run('UPDATE users SET avatar = NULL WHERE id = ?', [ws.userId]);
        ws.avatar = null;
        ws.send(JSON.stringify({ type: 'avatar_set', avatar: null }));
        return;
      }

      // [방송인 방 만들기] 팬이 초대 링크로 들어옴 → 그 방송인과의 방을 찾거나 새로 만듦
      if (data.type === 'join_broadcaster') {
        const b = await db.get('SELECT * FROM users WHERE nickname = ? AND is_broadcaster = 1', [String(data.nickname || '')]);
        if (!b) return ws.send(JSON.stringify({ type: 'error', text: '그런 방송인을 찾을 수 없어요' }));
        if (b.id === ws.userId) return ws.send(JSON.stringify({ type: 'error', text: '자기 자신과는 채팅할 수 없어요' }));

        let room = await db.get('SELECT * FROM rooms WHERE broadcaster_id = ? AND fan_id = ?', [b.id, ws.userId]);
        if (!room) {
          const r = await db.run('INSERT INTO rooms (broadcaster_id, fan_id, created_at) VALUES (?, ?, ?)', [b.id, ws.userId, Date.now()]);
          room = { id: r.lastInsertRowid };
          await pushRoomList(b.id); // 방송인 목록에도 새 방이 뜨게
        }
        await pushRoomList(ws.userId);
        ws.send(JSON.stringify({ type: 'joined', roomId: room.id }));
      }

      // [방 열기] 이전 대화를 보내주고, 상대가 보낸 메시지를 읽음 처리
      else if (data.type === 'open_room') {
        const room = await getRoomIfMember(data.roomId, ws.userId);
        if (!room) return;
        const peerId = room.broadcaster_id === ws.userId ? room.fan_id : room.broadcaster_id;
        const peer = await db.get('SELECT nickname, avatar FROM users WHERE id = ?', [peerId]);

        await db.run('UPDATE messages SET read = 1 WHERE room_id = ? AND sender_id != ?', [room.id, ws.userId]);
        sendTo(peerId, { type: 'read', roomId: room.id }); // 상대 화면의 숫자 1 지우기

        const messages = await db.all('SELECT id, sender_id, text, created_at, read, kind FROM messages WHERE room_id = ? ORDER BY id', [room.id]);
        ws.send(JSON.stringify({ type: 'history', roomId: room.id, peer: peer.nickname, peerAvatar: peer.avatar || null, messages }));
        await pushRoomList(ws.userId);
      }

      // [채팅] 저장하고 → 나와 상대 모두에게 전달 (미니 카카오톡과 같은 심장부)
      else if (data.type === 'chat') {
        const room = await getRoomIfMember(data.roomId, ws.userId);
        if (!room) return;
        const text = String(data.text || '').slice(0, 1000).trim();
        if (!text) return;

        const now = Date.now();
        const r = await db.run('INSERT INTO messages (room_id, sender_id, text, created_at, kind) VALUES (?, ?, ?, ?, ?)', [room.id, ws.userId, text, now, 'text']);

        const msg = { type: 'chat', roomId: room.id, message: { id: r.lastInsertRowid, sender_id: ws.userId, sender_name: ws.nickname, sender_avatar: ws.avatar, text, created_at: now, read: 0, kind: 'text' } };
        const peerId = room.broadcaster_id === ws.userId ? room.fan_id : room.broadcaster_id;
        sendTo(ws.userId, msg);
        sendTo(peerId, msg);
        await pushRoomList(ws.userId);
        await pushRoomList(peerId);
      }

      // [이미지 전송] 클라이언트가 압축한 이미지(dataURL)를 받아 저장·전달
      else if (data.type === 'image') {
        const room = await getRoomIfMember(data.roomId, ws.userId);
        if (!room) return;
        const dataUrl = String(data.dataUrl || '');
        // data:image/... 형식만 허용하고, 서버측 크기 상한(약 2MB)으로 남용 방지
        if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(dataUrl)) return;
        if (dataUrl.length > 2_000_000) {
          return ws.send(JSON.stringify({ type: 'error', text: '이미지가 너무 커요. 더 작은 사진을 보내주세요.' }));
        }

        const now = Date.now();
        const r = await db.run('INSERT INTO messages (room_id, sender_id, text, created_at, kind) VALUES (?, ?, ?, ?, ?)', [room.id, ws.userId, dataUrl, now, 'image']);

        const msg = { type: 'chat', roomId: room.id, message: { id: r.lastInsertRowid, sender_id: ws.userId, sender_name: ws.nickname, sender_avatar: ws.avatar, text: dataUrl, created_at: now, read: 0, kind: 'image' } };
        const peerId = room.broadcaster_id === ws.userId ? room.fan_id : room.broadcaster_id;
        sendTo(ws.userId, msg);
        sendTo(peerId, msg);
        await pushRoomList(ws.userId);
        await pushRoomList(peerId);
      }

      // [공지 전체 발송] 방송인이 공지 1개를 쓰면 → 자기 팬들의 모든 방에 개별 발송
      // 팬 입장에선 "방송인이 나에게 개인적으로 보낸 메시지"로 보여요 (버블과 같은 원리).
      else if (data.type === 'announce') {
        if (!ws.isBroadcaster) return; // 방송인만 가능
        const text = String(data.text || '').slice(0, 1000).trim();
        if (!text) return;

        const rooms = await db.all('SELECT * FROM rooms WHERE broadcaster_id = ?', [ws.userId]);
        const now = Date.now();
        const affectedUsers = new Set();

        // kind='announce'로 저장해서, 피드에서 "전체 발송"임을 알아보고 중복 없이 한 번만 보여줄 수 있게
        for (const room of rooms) {
          const r = await db.run('INSERT INTO messages (room_id, sender_id, text, created_at, kind) VALUES (?, ?, ?, ?, ?)', [room.id, ws.userId, text, now, 'announce']);
          const msg = { type: 'chat', roomId: room.id, message: { id: r.lastInsertRowid, sender_id: ws.userId, sender_name: ws.nickname, sender_avatar: ws.avatar, text, created_at: now, read: 0, kind: 'announce' } };
          sendTo(room.fan_id, msg); // 각 팬에게 전송
          affectedUsers.add(room.fan_id);
        }
        // 목록 화면(미리보기/시간)도 갱신
        for (const fanId of affectedUsers) await pushRoomList(fanId);
        await pushRoomList(ws.userId);
        ws.send(JSON.stringify({ type: 'announce_done', count: rooms.length }));
      }

      // [사진 전체 발송] 텍스트 공지와 같은 구조 — 사진을 모든 팬 방에 개별 발송
      else if (data.type === 'announce_image') {
        if (!ws.isBroadcaster) return; // 방송인만 가능
        const dataUrl = String(data.dataUrl || '');
        if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(dataUrl)) return;
        if (dataUrl.length > 2_000_000) {
          return ws.send(JSON.stringify({ type: 'error', text: '이미지가 너무 커요. 더 작은 사진을 보내주세요.' }));
        }

        const rooms = await db.all('SELECT * FROM rooms WHERE broadcaster_id = ?', [ws.userId]);
        const now = Date.now();
        const affectedUsers = new Set();

        for (const room of rooms) {
          const r = await db.run('INSERT INTO messages (room_id, sender_id, text, created_at, kind) VALUES (?, ?, ?, ?, ?)', [room.id, ws.userId, dataUrl, now, 'announce_image']);
          const msg = { type: 'chat', roomId: room.id, message: { id: r.lastInsertRowid, sender_id: ws.userId, sender_name: ws.nickname, sender_avatar: ws.avatar, text: dataUrl, created_at: now, read: 0, kind: 'announce_image' } };
          sendTo(room.fan_id, msg);
          affectedUsers.add(room.fan_id);
        }
        for (const fanId of affectedUsers) await pushRoomList(fanId);
        await pushRoomList(ws.userId);
        ws.send(JSON.stringify({ type: 'announce_done', count: rooms.length }));
      }

      // [통합 피드] 방송인 전용: 모든 팬 방의 메시지를 시간순으로 한 줄로 모아서 보내줌
      // 전체 발송(announce)은 방마다 복사돼 저장되므로, 같은 내용+시각은 하나로 합쳐요(중복 제거).
      else if (data.type === 'open_feed') {
        if (!ws.isBroadcaster) return;

        // 피드를 여는 것도 "읽음"으로 처리 — 안 그러면 팬 화면의 숫자 1이
        // 방송인이 1:1 방을 일일이 열기 전까지 안 사라져요
        const unreadRooms = await db.all(`
          SELECT DISTINCT m.room_id, r.fan_id
          FROM messages m JOIN rooms r ON r.id = m.room_id
          WHERE r.broadcaster_id = ? AND m.sender_id != ? AND m.read = 0
        `, [ws.userId, ws.userId]);
        if (unreadRooms.length > 0) {
          await db.run(`
            UPDATE messages SET read = 1
            WHERE room_id IN (SELECT id FROM rooms WHERE broadcaster_id = ?) AND sender_id != ?
          `, [ws.userId, ws.userId]);
          for (const row of unreadRooms) {
            sendTo(row.fan_id, { type: 'read', roomId: row.room_id }); // 팬 화면의 1 지우기
          }
          await pushRoomList(ws.userId); // 내 방 목록 배지도 갱신
        }

        const items = await db.all(`
          SELECT m.id, m.room_id, m.sender_id, m.text, m.created_at, m.kind, u.nickname AS sender_name, u.avatar AS sender_avatar
          FROM messages m
          JOIN rooms r ON r.id = m.room_id
          JOIN users u ON u.id = m.sender_id
          WHERE r.broadcaster_id = ?
            AND (m.sender_id != ? OR m.kind IN ('announce', 'announce_image'))
          GROUP BY CASE WHEN m.kind IN ('announce', 'announce_image') THEN 'a' || m.created_at ELSE 'm' || m.id END
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 100
        `, [ws.userId, ws.userId]);
        items.reverse(); // 화면에는 오래된 것부터 아래로
        ws.send(JSON.stringify({ type: 'feed', items }));
      }

      // [읽음 확인] 방을 보고 있는 상태에서 새 메시지가 도착했을 때
      else if (data.type === 'read') {
        const room = await getRoomIfMember(data.roomId, ws.userId);
        if (!room) return;
        await db.run('UPDATE messages SET read = 1 WHERE room_id = ? AND sender_id != ?', [room.id, ws.userId]);
        const peerId = room.broadcaster_id === ws.userId ? room.fan_id : room.broadcaster_id;
        sendTo(peerId, { type: 'read', roomId: room.id });
        await pushRoomList(ws.userId);
      }
    } catch (err) {
      // DB가 잠깐 응답하지 못해도 서버 전체가 죽지 않게
      console.error('처리 중 오류:', err.message);
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

// 데이터베이스 준비가 끝난 뒤에 서버 문을 열어요
const PORT = process.env.PORT || 3100;
db.init().then(() => {
  server.listen(PORT, () => {
    console.log(`fanchat 서버 실행 중: http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('데이터베이스 연결 실패:', err.message);
  process.exit(1);
});
