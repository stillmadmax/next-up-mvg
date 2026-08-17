// Network first for the app's own files, cache only as an offline fallback.
// GitHub Pages serves them with max-age=600, so a plain reload can otherwise
// keep running the previous build for ten minutes after a deploy — the whole
// reason this file exists. Bump CACHE only to discard old entries; correctness
// does not depend on it, since every request goes to the network first.
const CACHE = 'next-up-v1';

// Enough to start the app without a network. Departure data is never cached.
const SHELL = [
  './',
  './index.html',
  './app.js',
  './api.js',
  './style.css',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  // The MVG API is live data on another origin — leave it to the network.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        // cache: 'reload' bypasses the browser's HTTP cache, which is the point.
        const fresh = await fetch(new Request(request.url, { cache: 'reload' }));
        if (fresh.ok) (await caches.open(CACHE)).put(request, fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Offline on a URL we never cached: a navigation still gets the shell.
        if (request.mode === 'navigate') return caches.match('./');
        throw err;
      }
    })()
  );
});
