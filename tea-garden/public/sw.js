// Service Worker：离线壳（应用外壳缓存）。API 写请求永远走网络（不缓存），
// 日记离线写入由页面 outbox 承担，保证不会"假成功"。
const CACHE = 'tea-shell-v1';
const SHELL = ['/', '/css/style.css', '/js/api.js', '/js/map.js', '/js/offline.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // 接口一律不缓存
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
