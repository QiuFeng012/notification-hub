/**
 * 这个 service worker 只做一件事：服务没在跑的时候，给一个看得懂的页面。
 *
 * 它刻意**不缓存任何应用代码**。
 *
 * 理由：这是一个本地应用，服务端一直在这台机器上，离线使用没有任何意义；
 * 而缓存应用代码的代价是实打实的——重新构建之后打开的还是旧界面，
 * 而且会旧到让人以为是代码没生效。这个项目里界面改得很勤，
 * 这种"看起来对、其实在跑旧代码"的问题最难查。
 *
 * 所以拦截范围被压到最小：
 *   - 只处理导航请求（打开窗口/刷新页面），静态资源一律不碰；
 *   - /api/ 一律直连，缓存住的旧卡片比连不上更糟；
 *   - 只有网络请求真的失败时，才回落到缓存里那一张说明页。
 */
const OFFLINE_CACHE = 'notification-hub-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      // cache: 'reload' 绕开 HTTP 缓存，避免把一张旧的说明页固化下来
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== OFFLINE_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // 只接管导航。静态资源不经过这里，也就不存在"资源被缓存住"的可能。
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(request).catch(() =>
      caches
        .open(OFFLINE_CACHE)
        .then((cache) => cache.match(OFFLINE_URL))
        .then((cached) => cached ?? Response.error()),
    ),
  );
});
