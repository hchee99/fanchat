// ─────────────────────────────────────────────────────────────
// 서비스 워커 = 앱(탭)이 꺼져 있어도 백그라운드에서 도는 작은 프로그램.
// 서버가 보낸 푸시를 받아 알림 배너를 띄우고, 알림을 누르면 앱을 열어줘요.
// ─────────────────────────────────────────────────────────────

// 푸시 도착 → 알림 배너 표시 (소리·진동 없이 silent)
self.addEventListener('push', (event) => {
  let data = { title: '새 메시지', body: '', url: '/' };
  try { data = { ...data, ...event.data.json() }; } catch { /* 형식 오류 무시 */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      silent: true,               // ← 소리 없이 배너만
      tag: 'fanchat-message',     // 같은 태그는 배너가 쌓이지 않고 갱신됨
      data: { url: data.url || '/' },
    })
  );
});

// 알림 클릭 → 이미 열린 앱이 있으면 그 창으로, 없으면 새로 열기
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
