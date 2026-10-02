// 셸만 캐시하는 서비스 워커 — 앱을 홈 화면에서 열 때 정적 파일을 빨리 띄우기 위함.
// /api·/ws 는 인증·실시간 데이터라 절대 캐시하지 않는다.
// 정적 파일은 네트워크 우선 — 데스크톱 앱이 업데이트되면 다음 접속에 바로 새 셸을 받는다.
const CACHE = 'ta-remote-shell-v1';
const SHELL = [
  '/', '/mobile.css', '/mobile.js', '/remote-core.js', '/dashboard-core.js',
  '/xterm.js', '/xterm.css', '/manifest.webmanifest', '/icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  // 페어링 해시(#pair=)는 서버로 가지 않으므로 경로만으로 셸을 고른다
  const key = req.mode === 'navigate' ? '/' : url.pathname;
  if (!SHELL.includes(key)) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then((hit) => hit || Response.error()))
  );
});
