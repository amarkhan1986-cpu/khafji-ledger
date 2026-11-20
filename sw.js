// Khafji Ledger offline copy. The whole app (reader, PDF reader, map code, fonts) is in index.html,
// so once it is saved here the app opens and scans with no internet at all.
const VERSION = 'ledger-8d96c26011';
const CORE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];
const TILES = 'ledger-map-tiles';
const MAX_TILES = 800;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// photos, PDFs and message text shared to the app (Android "Share" menu)
function inbox() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('khafji-share', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('inbox', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function receiveShare(request) {
  try {
    const fd = await request.formData();
    const files = fd.getAll('files').filter(f => f && f.size);
    const text = ['title', 'text', 'url'].map(k => fd.get(k)).filter(Boolean).join('\n');
    const db = await inbox();
    await new Promise((res, rej) => {
      const tx = db.transaction('inbox', 'readwrite');
      tx.objectStore('inbox').put({ id: Date.now() + '-' + Math.random().toString(36).slice(2), files, text, at: Date.now() });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) {}
  return Response.redirect('./?shared=1', 303);
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  if (url.origin === self.location.origin) {
    // the app itself: from the saved copy first (instant, offline), the network only if missing
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      const hit = req.mode === 'navigate' ? (await c.match('./index.html')) : (await c.match(req, { ignoreSearch: true }));
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
      catch (err) { return (await c.match('./index.html')) || Response.error(); }
    })());
    return;
  }
  // map pictures: use the internet when there is one, keep the last 800 for offline viewing
  if (/tile|arcgisonline|basemaps|openstreetmap|opentopomap/i.test(url.href)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      try {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') { c.put(req, r.clone()); trimTiles(c); }
        return r;
      } catch (err) { return (await c.match(req)) || Response.error(); }
    })());
  }
});
