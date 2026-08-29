// HarmonyOS 6 + dsh 极速高刷离线缓存 ServiceWorker
const CACHE_NAME = 'aih-hos6-pwa-v1';
const PRECACHE_URLS = [
  '/ui/',
  '/ui/manifest.json',
  '/ui/ai-home-logo.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 请求与 SSE 流式请求直连，不走缓存
  if (url.pathname.startsWith('/v0/') || url.pathname.startsWith('/v1/') || event.request.headers.get('accept')?.includes('text/event-stream')) {
    return;
  }

  // 静态静态资源采用 Cache First + Network Revalidate
  if (url.pathname.startsWith('/ui/static/') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css') || url.pathname.endsWith('.png')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          fetch(event.request).then((networkRes) => {
            if (networkRes.ok) {
              caches.open(CACHE_NAME).then((c) => c.put(event.request, networkRes));
            }
          }).catch(() => {});
          return cached;
        }
        return fetch(event.request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // HTML 导航页采用 Network First + Fallback to Cache
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return res;
      }).catch(() => {
        return caches.match(event.request).then((cached) => cached || caches.match('/ui/'));
      })
    );
  }
});
