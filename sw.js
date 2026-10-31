// Service worker: cacher app-skallet for rask oppstart og offline-visning.
// Sanntidsdata fra Entur caches aldri.
const CACHE = 'minbuss-v3';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/api.js', 'js/store.js', 'js/ui.js', 'js/map.js', 'js/theme.js',
  'icons/icon.svg', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.hostname.endsWith('entur.io')) return;
  const sameOrigin = url.origin === self.location.origin;
  const isLib = url.hostname === 'cdnjs.cloudflare.com';
  if (!sameOrigin && !isLib) return; // kartfliser o.l. går rett til nett

  // Nett først (alltid ferskeste versjon), cache som reserve.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request)),
  );
});
