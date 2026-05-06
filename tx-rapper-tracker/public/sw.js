const CACHE = 'txrt-v1';
const PRECACHE = ['/', '/dashboard', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];
const API_CACHE_ROUTES = ['/api/artists', '/api/trends'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (API_CACHE_ROUTES.some(r => url.pathname.startsWith(r))) {
    e.respondWith(networkFirstWithCache(e.request));
  } else if (['document','script','style','font'].includes(e.request.destination)) {
    e.respondWith(cacheFirst(e.request));
  }
});

async function networkFirstWithCache(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-From-Cache', 'true');
      return new Response(cached.body, { status: cached.status, headers });
    }
    return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    const cache = await caches.open(CACHE);
    cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}
