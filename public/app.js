// ─────────────────────────────────────────────────────────────
// fanchat 클라이언트 — 화면 3개를 오가는 앱
//   로그인 → 채팅방 목록 → 1:1 채팅
// 목록 화면은 방송인/팬이 똑같이 공유해요. 서버가 "내가 낀 방"만
// 걸러서 보내주기 때문에, 방송인에겐 팬 목록으로, 팬에겐 방송인
// 목록으로 보이는 것뿐이에요.
// ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const screens = { auth: $('auth-screen'), list: $('list-screen'), chat: $('chat-screen'), settings: $('settings-screen') };
function showScreen(name) {
  for (const key of Object.keys(screens)) screens[key].hidden = key !== name;
}

// 아바타 자리에 프사가 있으면 사진을, 없으면 이름 앞 두 글자를 표시
function applyAvatar(el, avatar, fallbackText) {
  if (avatar) {
    el.classList.add('has-photo');
    el.style.backgroundImage = `url("${avatar}")`;
    el.textContent = '';
  } else {
    el.classList.remove('has-photo');
    el.style.backgroundImage = '';
    el.textContent = (fallbackText || '?').slice(0, 2);
  }
}

let ws = null;
let me = null;                 // { id, nickname, isBroadcaster }
let token = localStorage.getItem('fanchat-token');
let currentRoomId = null;      // 지금 열어둔 방 (목록 화면이면 null)
let currentPeer = null;        // 지금 방의 상대 { name, avatar } — 말풍선 옆 프사에 사용
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
      securityQuestion: $('auth-security-q').value,
      securityAnswer: $('auth-security-a').value,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    $('auth-error').textContent = data.error || '오류가 발생했어요';
    return;
  }
  saveLoginAndEnter(data);
}
function saveLoginAndEnter(data) {
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

// ─────────── 비밀번호 찾기 (보안 질문 방식) ───────────
$('forgot-link').addEventListener('click', () => {
  $('auth-main').hidden = true;
  $('auth-reset').hidden = false;
});
$('reset-back-btn').addEventListener('click', () => {
  $('auth-reset').hidden = true;
  $('auth-main').hidden = false;
});

// 1단계: 닉네임으로 보안 질문 가져오기
$('reset-find-btn').addEventListener('click', async () => {
  $('reset-error').textContent = '';
  const res = await fetch('/api/forgot/question', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: $('reset-nickname').value.trim() }),
  });
  const data = await res.json();
  if (!res.ok) { $('reset-error').textContent = data.error; return; }
  $('reset-question').textContent = data.question;
  $('reset-step2').hidden = false;
});

// 2단계: 답 + 새 비밀번호로 재설정 → 성공 시 바로 로그인
$('reset-submit-btn').addEventListener('click', async () => {
  $('reset-error').textContent = '';
  const res = await fetch('/api/forgot/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nickname: $('reset-nickname').value.trim(),
      securityAnswer: $('reset-answer').value,
      newPassword: $('reset-newpw').value,
    }),
  });
  const data = await res.json();
  if (!res.ok) { $('reset-error').textContent = data.error; return; }
  alert('비밀번호를 새로 설정했어요. 자동으로 로그인할게요.');
  saveLoginAndEnter(data);
});

function logout() {
  localStorage.removeItem('fanchat-token');
  localStorage.removeItem('fanchat-user');
  location.href = location.pathname; // 주소의 ?b= 부분도 지우고 처음으로
}
$('logout-btn').addEventListener('click', logout);

// ─────────── 프로필 설정 ───────────
function openSettings() {
  applyAvatar($('settings-avatar'), me.avatar, me.nickname);
  $('settings-name').textContent = me.nickname + (me.isBroadcaster ? ' (방송인)' : '');
  $('open-welcome-btn').hidden = !me.isBroadcaster; // 입장 인사말은 방송인만
  showScreen('settings');
}
$('settings-btn').addEventListener('click', openSettings);
$('my-name').addEventListener('click', openSettings);
$('settings-back-btn').addEventListener('click', () => showScreen('list'));
$('avatar-change-btn').addEventListener('click', () => $('avatar-file').click());
$('settings-avatar').addEventListener('click', () => $('avatar-file').click());

$('avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !ws || ws.readyState !== 1) return;
  if (!file.type.startsWith('image/')) return alert('이미지 파일만 쓸 수 있어요.');
  try {
    // 프사는 작아도 충분하니 256px로 더 작게 압축
    const dataUrl = await compressImage(file, 256, 0.8);
    if (dataUrl.length > 500_000) return alert('사진이 너무 커요. 더 작은 사진을 써주세요.');
    ws.send(JSON.stringify({ type: 'set_avatar', dataUrl }));
  } catch {
    alert('사진을 처리하지 못했어요.');
  }
});

$('avatar-remove-btn').addEventListener('click', () => {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'remove_avatar' }));
});

// ─────────── 차단 목록 관리 ───────────
$('open-blocklist-btn').addEventListener('click', () => {
  if (!ws || ws.readyState !== 1) return;
  $('blocklist').innerHTML = '';
  $('blocklist-empty').hidden = true;
  $('blocklist-view').hidden = false;
  ws.send(JSON.stringify({ type: 'block_list' }));
});
$('blocklist-close-btn').addEventListener('click', () => { $('blocklist-view').hidden = true; });

// ─────────── 입장 인사말 설정 (방송인 전용) ───────────
$('open-welcome-btn').addEventListener('click', () => {
  if (!ws || ws.readyState !== 1) return;
  $('welcome-input').value = '';
  $('welcome-view').hidden = false;
  ws.send(JSON.stringify({ type: 'get_welcome' })); // 저장돼 있던 값 불러오기
});
$('welcome-close-btn').addEventListener('click', () => { $('welcome-view').hidden = true; });
$('welcome-save-btn').addEventListener('click', () => {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'set_welcome', text: $('welcome-input').value }));
});

function renderBlockList(list) {
  const box = $('blocklist');
  box.innerHTML = '';
  $('blocklist-empty').hidden = list.length > 0;
  for (const u of list) {
    const item = document.createElement('div');
    item.className = 'block-item';
    const av = document.createElement('div');
    av.className = 'avatar';
    applyAvatar(av, u.avatar, u.nickname);
    const name = document.createElement('div');
    name.className = 'block-name';
    name.textContent = u.nickname;
    const btn = document.createElement('button');
    btn.textContent = '차단 해제';
    btn.addEventListener('click', () => {
      ws.send(JSON.stringify({ type: 'unblock_user', targetId: u.id }));
    });
    item.appendChild(av);
    item.appendChild(name);
    item.appendChild(btn);
    box.appendChild(item);
  }
}

// ─────────── 앱 진입 (로그인 성공 후) ───────────
function enterApp() {
  $('my-name').textContent = me.nickname + (me.isBroadcaster ? ' (방송인)' : '');
  // 방송인: 탭(전체 피드 기본) / 팬: 방송인 추가 입력칸 + 방 목록만
  $('tab-bar').hidden = !me.isBroadcaster;
  $('add-box').hidden = me.isBroadcaster;
  $('feed-photos-btn').hidden = !me.isBroadcaster; // 단톡 사진 모아보기는 방송인만
  showScreen('list');
  showTab(me.isBroadcaster ? 'feed' : 'rooms');
  connect();
}

// ─────────── 탭 전환 (방송인 전용) ───────────
let activeTab = 'rooms';
function showTab(name) {
  activeTab = name;
  const feed = name === 'feed';
  $('tab-feed').classList.toggle('active', feed);
  $('tab-rooms').classList.toggle('active', !feed);
  $('feed-view').hidden = !feed;
  $('feed-bar').hidden = !feed || !me.isBroadcaster;
  $('room-list').hidden = feed;
  $('invite-box').hidden = feed || !me.isBroadcaster; // 초대 링크는 목록 탭에서
  if (feed) $('empty-hint').hidden = true;
  if (feed && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'open_feed' })); // 피드 열 때마다 최신으로 새로 받아옴
  }
}
$('tab-feed').addEventListener('click', () => showTab('feed'));
$('tab-rooms').addEventListener('click', () => showTab('rooms'));

$('copy-invite-btn').addEventListener('click', async () => {
  const link = `${location.origin}/?b=${encodeURIComponent(me.nickname)}`;
  await navigator.clipboard.writeText(link);
  $('copy-invite-btn').textContent = '복사됨!';
  setTimeout(() => { $('copy-invite-btn').textContent = '링크 복사'; }, 1500);
});

// 방송인 이름 또는 초대 링크를 직접 입력해서 방 추가
function addBroadcaster() {
  let value = $('add-input').value.trim();
  if (!value || !ws || ws.readyState !== 1) return;
  // 링크를 통째로 붙여넣었으면 ?b=뒤의 방송인 이름만 뽑아냄
  const match = value.match(/[?&]b=([^&]+)/);
  if (match) value = decodeURIComponent(match[1]);
  ws.send(JSON.stringify({ type: 'join_broadcaster', nickname: value }));
  $('add-input').value = '';
}
$('add-btn').addEventListener('click', addBroadcaster);
$('add-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addBroadcaster();
});

// 피드 입력창 = 전체 발송 (방송인의 기본 쓰기 방식)
function sendFeedAnnounce() {
  const text = $('feed-input').value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'announce', text }));
  $('feed-input').value = '';
  $('feed-input').focus();
}
$('feed-send-btn').addEventListener('click', sendFeedAnnounce);
$('feed-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendFeedAnnounce();
});

// 피드의 사진 버튼 = 사진 전체 발송 (모든 팬에게)
$('feed-image-btn').addEventListener('click', () => $('feed-image-file').click());
$('feed-image-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !ws || ws.readyState !== 1) return;
  if (!file.type.startsWith('image/')) return alert('이미지 파일만 보낼 수 있어요.');
  if (!confirm('이 사진을 모든 팬에게 발송할까요?')) return; // 사진 전체 발송은 되돌릴 수 없으니 한 번 확인
  try {
    const dataUrl = await compressImage(file, 1024, 0.7);
    if (dataUrl.length > 2_000_000) return alert('사진이 너무 커요. 더 작은 사진을 보내주세요.');
    ws.send(JSON.stringify({ type: 'announce_image', dataUrl }));
  } catch {
    alert('사진을 처리하지 못했어요.');
  }
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
      // 서버가 알려준 "진짜 내 정보"로 저장값을 바로잡음 (내 메시지 인식 오류 방지)
      if (data.me) {
        me = { ...me, ...data.me };
        localStorage.setItem('fanchat-user', JSON.stringify(me));
        if (currentRoomId) ws.send(JSON.stringify({ type: 'open_room', roomId: currentRoomId })); // 열린 방 다시 그려 정렬 교정
      }
      // 초대 링크로 들어왔다면 그 방송인의 방으로 바로 이동
      if (pendingJoin) {
        ws.send(JSON.stringify({ type: 'join_broadcaster', nickname: pendingJoin }));
        pendingJoin = null;
      }
      // 방송인이 피드 탭이면 피드 받아오기 (연결 직후와 재연결 때 모두)
      if (me.isBroadcaster && activeTab === 'feed') {
        ws.send(JSON.stringify({ type: 'open_feed' }));
      }
    } else if (data.type === 'rooms') {
      renderRoomList(data.rooms);
    } else if (data.type === 'feed') {
      renderFeed(data.items);
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
    } else if (data.type === 'room_photos') {
      if (data.roomId === currentRoomId) renderPhotos(data.photos);
    } else if (data.type === 'feed_photos') {
      renderPhotos(data.photos);
    } else if (data.type === 'blocked') {
      // 차단 완료 → 방에서 나와 목록으로 (그 방은 목록에서 사라짐)
      if (data.roomId === currentRoomId) {
        currentRoomId = null;
        showScreen('list');
      }
      alert('차단했어요.');
    } else if (data.type === 'block_list') {
      renderBlockList(data.list);
    } else if (data.type === 'welcome') {
      $('welcome-input').value = data.text || '';
    } else if (data.type === 'welcome_saved') {
      alert(data.text ? '입장 인사말을 저장했어요.' : '입장 인사말을 비웠어요. (이제 안 나가요)');
      $('welcome-view').hidden = true;
    } else if (data.type === 'avatar_set') {
      // 내 프사가 바뀜 → 저장해두고 설정 화면 즉시 반영
      me.avatar = data.avatar;
      localStorage.setItem('fanchat-user', JSON.stringify(me));
      applyAvatar($('settings-avatar'), me.avatar, me.nickname);
    } else if (data.type === 'announce_done') {
      // 발송 완료 → 피드를 새로 받아서 내 말풍선이 (한 번만) 나타나게
      if (activeTab === 'feed') ws.send(JSON.stringify({ type: 'open_feed' }));
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
  $('empty-hint').hidden = activeTab === 'feed' || rooms.length > 0;

  for (const room of rooms) {
    const item = document.createElement('div');
    item.className = 'room-item';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    applyAvatar(avatar, room.peerAvatar, room.peer);

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

// ─────────── 통합 피드 (방송인 전용) ───────────
function renderFeed(items) {
  const view = $('feed-view');
  view.innerHTML = '';
  if (items.length === 0) {
    const hint = document.createElement('p');
    hint.style.cssText = 'margin:auto;text-align:center;color:#999;font-size:14px;line-height:1.7;';
    hint.textContent = '아직 메시지가 없어요. 아래에 쓰면 팬 전원에게 발송돼요.';
    view.appendChild(hint);
    return;
  }
  for (const m of items) appendFeedItem(m, false);
  view.scrollTop = view.scrollHeight;
}

function appendFeedItem(m, scroll = true) {
  const view = $('feed-view');
  const mine = m.sender_id === me.id;

  if (mine) {
    // 내(방송인) 메시지: 오른쪽 보라 말풍선(또는 사진) + "전체 발송" 꼬리표
    const wrap = document.createElement('div');
    wrap.className = 'feed-mine';
    const bubble = document.createElement('div');
    if ((m.kind === 'image' || m.kind === 'announce_image') && m.text) {
      // 실시간 메시지는 사진 데이터를 갖고 있어 인라인 표시
      bubble.className = 'bubble image-bubble';
      const img = document.createElement('img');
      img.src = m.text;
      img.alt = '사진';
      img.addEventListener('click', () => openLightbox(m.text));
      bubble.appendChild(img);
    } else if (m.kind === 'image' || m.kind === 'announce_image') {
      // 피드에서 불러온 사진은 원본을 안 실어서 가볍게 "[사진]"으로 (모아보기에서 봄)
      bubble.className = 'bubble';
      bubble.style.background = '#5b4ddb';
      bubble.style.color = '#fff';
      bubble.textContent = '[사진]';
    } else {
      bubble.className = 'bubble';
      bubble.style.background = '#5b4ddb';
      bubble.style.color = '#fff';
      bubble.textContent = m.text;
    }
    const tag = document.createElement('div');
    tag.className = 'feed-tag';
    const isAnnounce = m.kind === 'announce' || m.kind === 'announce_image';
    tag.textContent = (isAnnounce ? '📢 전체 발송' : '개별 답장') + ' · ' + formatTime(m.created_at);
    wrap.appendChild(bubble);
    wrap.appendChild(tag);
    view.appendChild(wrap);
  } else {
    // 팬 메시지: 이름표 + 말풍선. 누르면 그 팬과의 1:1 채팅방으로 이동!
    const row = document.createElement('div');
    row.className = 'feed-fan';
    row.title = m.sender_name + '님과의 1:1 채팅방 열기';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    applyAvatar(avatar, m.sender_avatar, m.sender_name);

    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'feed-fan-name';
    name.textContent = m.sender_name + ' · ' + formatTime(m.created_at);
    const bubble = document.createElement('div');
    if (m.kind === 'image' && m.text) {
      bubble.className = 'bubble image-bubble';
      const img = document.createElement('img');
      img.src = m.text;
      img.alt = '사진 (누르면 크게 보기)';
      // 사진 클릭 = 크게 보기. stopPropagation으로 "1:1 방 이동" 클릭이 같이 실행되는 걸 막음
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openLightbox(m.text);
      });
      bubble.appendChild(img);
    } else if (m.kind === 'image') {
      bubble.className = 'bubble';
      bubble.textContent = '[사진]'; // 피드에선 가볍게 표시, 누르면 방으로 이동
    } else {
      bubble.className = 'bubble';
      bubble.textContent = m.text;
    }
    body.appendChild(name);
    body.appendChild(bubble);

    row.appendChild(avatar);
    row.appendChild(body);
    row.addEventListener('click', () => openRoom(m.room_id)); // 핵심: 피드 → 1:1 방
    view.appendChild(row);
  }
  if (scroll) view.scrollTop = view.scrollHeight;
}

// ─────────── 1:1 채팅 화면 ───────────
function openRoom(roomId) {
  currentRoomId = roomId;
  ws.send(JSON.stringify({ type: 'open_room', roomId }));
}

// ─────────── 사진 모아보기 (1:1 방 + 단톡 공용) ───────────
function openPhotos(title, requestMsg) {
  if (!ws || ws.readyState !== 1) return;
  $('photos-title').textContent = title;
  $('photos-grid').innerHTML = '';
  $('photos-empty').hidden = true;
  $('photos-view').hidden = false;
  ws.send(JSON.stringify(requestMsg));
}
// 1:1 방 ⋮ 버튼 → 메뉴 열고 닫기
$('room-menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('room-menu').hidden = !$('room-menu').hidden;
});
// 바깥을 누르면 메뉴 닫기
document.addEventListener('click', () => { $('room-menu').hidden = true; });
$('menu-photos-btn').addEventListener('click', () => {
  $('room-menu').hidden = true;
  if (currentRoomId) openPhotos('사진 모아보기', { type: 'room_photos', roomId: currentRoomId });
});
$('menu-block-btn').addEventListener('click', () => {
  $('room-menu').hidden = true;
  if (!currentRoomId || !ws || ws.readyState !== 1) return;
  const who = currentPeer ? currentPeer.name : '이 사용자';
  if (!confirm(`${who}님을 차단할까요?\n차단하면 서로 메시지를 주고받을 수 없고 목록에서 사라져요.`)) return;
  ws.send(JSON.stringify({ type: 'block_user', roomId: currentRoomId }));
});
// 단톡 헤더 🖼 → 모든 팬 방 사진
$('feed-photos-btn').addEventListener('click', () => {
  openPhotos('단톡 사진 모아보기', { type: 'feed_photos' });
});
$('photos-close-btn').addEventListener('click', () => { $('photos-view').hidden = true; });

function renderPhotos(photos) {
  const grid = $('photos-grid');
  grid.innerHTML = '';
  $('photos-empty').hidden = photos.length > 0;
  for (const p of photos) {
    const img = document.createElement('img');
    img.src = p.text;
    img.alt = '사진';
    img.addEventListener('click', () => openLightbox(p.text));
    grid.appendChild(img);
  }
}

$('back-btn').addEventListener('click', () => {
  currentRoomId = null;
  $('photos-view').hidden = true; // 방 나갈 때 모아보기도 닫기
  showScreen('list');
  // 방송인이 피드 탭이었다면 방에 다녀온 사이의 변화를 반영해 새로 받아옴
  if (me.isBroadcaster && activeTab === 'feed' && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'open_feed' }));
  }
});

function renderHistory(data) {
  currentPeer = { name: data.peer, avatar: data.peerAvatar || null };
  $('peer-name').textContent = data.peer;
  applyAvatar($('peer-avatar'), currentPeer.avatar, data.peer); // 헤더에 상대 프사
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
  if (m.kind === 'image' || m.kind === 'announce_image') {
    // 이미지 메시지(일반/전체발송): 말풍선 안에 사진을 넣고, 누르면 크게 보기
    bubble.className = 'bubble image-bubble';
    const img = document.createElement('img');
    img.src = m.text; // 압축된 dataURL
    img.alt = '사진';
    img.addEventListener('click', () => openLightbox(m.text));
    img.addEventListener('load', scrollToBottom); // 사진 로딩 후 높이가 바뀌면 다시 맨 아래로
    bubble.appendChild(img);
  } else {
    bubble.className = 'bubble';
    bubble.textContent = m.text; // textContent라서 남이 보낸 HTML은 실행되지 않아 안전
  }

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

  // 상대(theirs) 말풍선 왼쪽에 상대 프사 (카톡 스타일)
  if (!mine && currentPeer) {
    const av = document.createElement('div');
    av.className = 'avatar msg-avatar';
    applyAvatar(av, currentPeer.avatar, currentPeer.name);
    line.appendChild(av);
  }
  line.appendChild(bubble);
  line.appendChild(meta);
  row.appendChild(line);
  $('messages').appendChild(row);
}

function scrollToBottom() {
  $('messages').scrollTop = $('messages').scrollHeight;
}

// 사진 크게 보기: 새 탭은 브라우저가 data 주소를 차단하므로,
// 앱 안에서 어두운 배경 위에 크게 띄우고 아무 데나 누르면 닫히게 (카톡 방식)
function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.id = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  img.alt = '사진 크게 보기';
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

function onChat(data) {
  // 방송인이 피드를 보고 있으면: 팬의 새 메시지를 피드에 실시간으로 추가하고,
  // 화면을 실제로 보고 있다면 바로 읽음 처리 (팬 화면의 숫자 1이 사라지게)
  if (me.isBroadcaster && activeTab === 'feed' && !$('feed-view').hidden
      && currentRoomId === null && data.message.sender_id !== me.id) {
    appendFeedItem({ ...data.message, room_id: data.roomId });
    if (document.visibilityState === 'visible') {
      ws.send(JSON.stringify({ type: 'read', roomId: data.roomId }));
    }
  }
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

// ─────────── 이미지 전송 ───────────
// 사진 버튼 → 파일 선택창 열기
$('image-btn').addEventListener('click', () => $('image-file').click());

// 파일이 선택되면: 큰 사진을 자동으로 줄여서(압축) 전송. 원본을 그대로 보내면
// 용량이 너무 커서 저장·전송이 느려지므로, 가로세로 최대 1024px + JPEG 품질 0.7로 압축.
$('image-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 같은 파일을 또 골라도 change가 다시 발생하게 초기화
  if (!file || !currentRoomId || !ws || ws.readyState !== 1) return;
  if (!file.type.startsWith('image/')) return alert('이미지 파일만 보낼 수 있어요.');

  try {
    const dataUrl = await compressImage(file, 1024, 0.7);
    if (dataUrl.length > 2_000_000) return alert('사진이 너무 커요. 더 작은 사진을 보내주세요.');
    ws.send(JSON.stringify({ type: 'image', roomId: currentRoomId, dataUrl }));
  } catch {
    alert('사진을 처리하지 못했어요.');
  }
});

// 이미지를 canvas에 다시 그려서 크기를 줄이고 JPEG로 변환 (dataURL 반환)
function compressImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const scale = maxSize / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─────────── 모바일 키보드 대응 ───────────
// 키보드가 올라오면 "실제로 보이는 높이"에 화면을 맞추고, 채팅은 맨 아래로 스크롤.
// visualViewport = 키보드를 뺀 실제 보이는 영역을 알려주는 브라우저 기능.
// 높이는 CSS(100dvh + interactive-widget)가 알아서 맞추므로, JS는 키보드가 뜰 때
// 맨 아래로 스크롤만 담당해요 (입력한 최신 메시지가 바로 보이게).
function setAppHeight() {
  if (currentRoomId) scrollToBottom();
  else if (me && me.isBroadcaster && activeTab === 'feed') {
    const fv = $('feed-view');
    if (fv) fv.scrollTop = fv.scrollHeight;
  }
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
  window.visualViewport.addEventListener('scroll', setAppHeight);
}
window.addEventListener('resize', setAppHeight);
setAppHeight();

// 입력창을 탭해서 키보드가 뜰 때도 최근 메시지가 보이도록 (키보드 애니메이션 후 스크롤)
$('msg-input').addEventListener('focus', () => setTimeout(scrollToBottom, 300));

// ─────────── 시작: 저장된 로그인이 있으면 바로 입장 ───────────
// 저장된 값이 손상돼 있어도 앱이 멈추지 않게 try로 감싸고, 실패하면 로그인 화면으로
function startup() {
  const savedUser = localStorage.getItem('fanchat-user');
  if (!token || !savedUser) return showScreen('auth');
  try {
    me = JSON.parse(savedUser);
    if (!me || !me.id) throw new Error('invalid user');
    enterApp();
  } catch {
    localStorage.removeItem('fanchat-token');
    localStorage.removeItem('fanchat-user');
    token = null;
    showScreen('auth');
  }
}
startup();
