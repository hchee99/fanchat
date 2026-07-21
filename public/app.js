// ─────────────────────────────────────────────────────────────
// fanchat 클라이언트 — 화면 3개를 오가는 앱
//   로그인 → 채팅방 목록 → 1:1 채팅
// 목록 화면은 방송인/팬이 똑같이 공유해요. 서버가 "내가 낀 방"만
// 걸러서 보내주기 때문에, 방송인에겐 팬 목록으로, 팬에겐 방송인
// 목록으로 보이는 것뿐이에요.
// ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const screens = { auth: $('auth-screen'), list: $('list-screen'), chat: $('chat-screen') };
function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
}

let ws = null;
let me = null;                 // { id, nickname, isBroadcaster }
let token = localStorage.getItem('fanchat-token');
let currentRoomId = null;      // 지금 열어둔 방 (목록 화면이면 null)
let pendingJoin = null;        // 초대 링크(?b=방송인)로 들어온 경우 기억해둠

// ── 초대 링크 확인: ?b=방송인닉네임 ──
const inviteTarget = new URLSearchParams(location.search).get('b');
if (inviteTarget) pendingJoin = inviteTarget;

// ─────────── 로그인 / 회원가입 ───────────
async function authRequest(path) {
  $('auth-error').textContent = '';
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: $('auth-nickname').value.trim(),
      password: $('auth-password').value,
      isBroadcaster: $('auth-broadcaster').checked,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    $('auth-error').textContent = data.error || '오류가 발생했어요';
    return;
  }
  token = data.token;
  me = data.user;
  localStorage.setItem('fanchat-token', token);
  localStorage.setItem('fanchat-user', JSON.stringify(me));
  enterApp();
}
$('login-btn').addEventListener('click', () => authRequest('/api/login'));
$('signup-btn').addEventListener('click', () => authRequest('/api/signup'));
$('auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authRequest('/api/login');
});

function logout() {
  localStorage.removeItem('fanchat-token');
  localStorage.removeItem('fanchat-user');
  location.href = location.pathname; // 주소의 ?b= 부분도 지우고 처음으로
}
$('logout-btn').addEventListener('click', logout);

// ─────────── 앱 진입 (로그인 성공 후) ───────────
function enterApp() {
  $('my-name').textContent = me.nickname + (me.isBroadcaster ? ' (방송인)' : '');
  // 방송인에게만 초대 링크 복사 버튼을 보여줌
  $('invite-box').hidden = !me.isBroadcaster;
  showScreen('list');
  connect();
}

$('copy-invite-btn').addEventListener('click', async () => {
  const link = `${location.origin}/?b=${encodeURIComponent(me.nickname)}`;
  await navigator.clipboard.writeText(link);
  $('copy-invite-btn').textContent = '복사됨!';
  setTimeout(() => { $('copy-invite-btn').textContent = '링크 복사'; }, 1500);
});

// ─────────── 서버 연결 (WebSocket) ───────────
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setStatus(true);
    ws.send(JSON.stringify({ type: 'auth', token })); // 첫 인사 = 본인 인증
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'auth_fail') {
      logout(); // 토큰이 낡았으면 다시 로그인
    } else if (data.type === 'auth_ok') {
      // 초대 링크로 들어왔다면 그 방송인의 방으로 바로 이동
      if (pendingJoin) {
        ws.send(JSON.stringify({ type: 'join_broadcaster', nickname: pendingJoin }));
        pendingJoin = null;
      }
    } else if (data.type === 'rooms') {
      renderRoomList(data.rooms);
    } else if (data.type === 'joined') {
      openRoom(data.roomId);
    } else if (data.type === 'history') {
      renderHistory(data);
    } else if (data.type === 'chat') {
      onChat(data);
    } else if (data.type === 'read') {
      // 상대가 읽었음 → 열려있는 방이면 내 말풍선의 1 지우기
      if (data.roomId === currentRoomId) {
        document.querySelectorAll('.unread').forEach((el) => el.remove());
      }
    } else if (data.type === 'error') {
      alert(data.text);
    }
  };

  ws.onclose = () => {
    setStatus(false);
    setTimeout(connect, 2000); // 자동 재연결
  };
}

function setStatus(onlineNow) {
  $('conn-status').textContent = onlineNow ? '● 연결됨' : '● 재연결 중...';
  $('conn-status').className = onlineNow ? 'status-on' : 'status-off';
}

// ─────────── 채팅방 목록 화면 ───────────
function formatTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return '방금';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}분 전`;
  const d = new Date(ms);
  if (diff < 24 * 60 * 60 * 1000) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderRoomList(rooms) {
  const list = $('room-list');
  list.innerHTML = '';
  $('empty-hint').hidden = rooms.length > 0;

  for (const room of rooms) {
    const item = document.createElement('div');
    item.className = 'room-item';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = room.peer.slice(0, 2);

    const mid = document.createElement('div');
    mid.className = 'room-mid';
    const peerEl = document.createElement('div');
    peerEl.className = 'room-peer';
    peerEl.textContent = room.peer + (room.peerIsBroadcaster ? ' 📺' : '');
    const lastEl = document.createElement('div');
    lastEl.className = 'room-last';
    lastEl.textContent = room.lastText || '(아직 대화가 없어요)';
    mid.appendChild(peerEl);
    mid.appendChild(lastEl);

    const side = document.createElement('div');
    side.className = 'room-side';
    const timeEl = document.createElement('div');
    timeEl.className = 'room-time';
    timeEl.textContent = formatTime(room.lastTime);
    side.appendChild(timeEl);
    if (room.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = room.unread;
      side.appendChild(badge);
    }

    item.appendChild(avatar);
    item.appendChild(mid);
    item.appendChild(side);
    item.addEventListener('click', () => openRoom(room.id));
    list.appendChild(item);
  }
}

// ─────────── 1:1 채팅 화면 ───────────
function openRoom(roomId) {
  currentRoomId = roomId;
  ws.send(JSON.stringify({ type: 'open_room', roomId }));
}

$('back-btn').addEventListener('click', () => {
  currentRoomId = null;
  showScreen('list');
});

function renderHistory(data) {
  $('peer-name').textContent = data.peer;
  $('messages').innerHTML = '';
  for (const m of data.messages) renderMessage(m);
  showScreen('chat');
  $('msg-input').focus();
  scrollToBottom();
}

function renderMessage(m) {
  const mine = m.sender_id === me.id;
  const row = document.createElement('div');
  row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;

  const line = document.createElement('div');
  line.className = 'bubble-line';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.text;

  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  if (mine && !m.read) {
    const unread = document.createElement('span');
    unread.className = 'unread';
    unread.textContent = '1';
    meta.appendChild(unread);
  }
  const time = document.createElement('span');
  const d = new Date(m.created_at);
  time.textContent = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  meta.appendChild(time);

  line.appendChild(bubble);
  line.appendChild(meta);
  row.appendChild(line);
  $('messages').appendChild(row);
}

function scrollToBottom() {
  $('messages').scrollTop = $('messages').scrollHeight;
}

function onChat(data) {
  if (data.roomId !== currentRoomId) return; // 다른 방 메시지면 목록 배지가 알아서 갱신됨
  renderMessage(data.message);
  scrollToBottom();
  // 내가 이 방을 보고 있으니 바로 읽음 처리
  if (data.message.sender_id !== me.id && document.visibilityState === 'visible') {
    ws.send(JSON.stringify({ type: 'read', roomId: currentRoomId }));
  }
}

function sendMessage() {
  const text = $('msg-input').value.trim();
  if (!text || !ws || ws.readyState !== 1 || !currentRoomId) return;
  ws.send(JSON.stringify({ type: 'chat', roomId: currentRoomId, text }));
  $('msg-input').value = '';
  $('msg-input').focus();
}
$('send-btn').addEventListener('click', sendMessage);
$('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

// ─────────── 시작: 저장된 로그인이 있으면 바로 입장 ───────────
const savedUser = localStorage.getItem('fanchat-user');
if (token && savedUser) {
  me = JSON.parse(savedUser);
  enterApp();
} else {
  showScreen('auth');
}
