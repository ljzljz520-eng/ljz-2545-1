// 离线外壳：只缓存应用壳与 GET 静态资源；API 与附件下载永不缓存（权限/撤回必须实时生效）
const CACHE = 'tea-shell-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/js/api.js', '/js/hillmap.js',
  '/js/map-page.js', '/js/diaries-page.js', '/js/offline.js', '/diaries.html', '/tests.html', '/gift.html'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/gift/')) return; // 不拦截接口
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(hit => fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => hit || caches.match('/diaries.html')))
  );
});
