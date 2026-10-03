// 셸만 캐시하는 서비스 워커 — 앱을 홈 화면에서 열 때 정적 파일을 빨리 띄우기 위함.
// /api·/ws 는 인증·실시간 데이터라 절대 캐시하지 않는다.
// 정적 파일은 네트워크 우선 — 데스크톱 앱이 업데이트되면 다음 접속에 바로 새 셸을 받는다.
const CACHE = 'ta-remote-shell-v3';
// VPN 이 꺼지면 요청이 오래 매달린다 — 이 시간 안에 응답이 없으면 캐시 셸을 띄워
// 앱이 'PC 에 연결할 수 없음' 안내를 보여 줄 수 있게 한다
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  '/', '/boot-guard.js', '/mobile.css', '/mobile.js', '/remote-core.js', '/dashboard-core.js',
  '/xterm.js', '/xterm.css', '/manifest.webmanifest', '/icon.png', '/icon-192.png', '/icon-512.png',
  '/apple-touch-icon.png'
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
  event.respondWith(networkFirst(req, key));
});

function networkFirst(req, key) {
  const network = fetch(req).then((res) => {
    // 시간 초과로 캐시를 먼저 돌려줬더라도 늦게 온 새 셸은 캐시에 남긴다
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy));
    }
    return res;
  });
  const fallback = () => caches.match(key).then((hit) => hit || network);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      caches.match(key).then((hit) => { if (hit && !done) { done = true; resolve(hit); } });
    }, NETWORK_TIMEOUT_MS);
    network.then((res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    }, () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(fallback().catch(() => Response.error()));
    });
  });
}
