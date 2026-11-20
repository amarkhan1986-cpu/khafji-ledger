// Raseed offline copy.
// index.html holds the whole app. The bill reader (engine/) and the PDF/HEIC helpers (lib/) are big,
// so they live in their own cache that survives app updates and is only replaced when they change.
const VERSION = 'raseed-app-654ba649e3';
const ENGINE = 'raseed-engine-3b37310ccb';
const TILES = 'raseed-map-tiles';
const MAX_TILES = 900;
const CORE = ['./', './index.html', './manifest.webmanifest'].concat(["icons/apple-touch-icon.png", "icons/favicon-32.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"].map(f => './' + f));

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    await c.addAll(CORE.map(u => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();                       // a new version takes over at once (the page offers a reload)
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION && k !== ENGINE && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// photos, PDFs and message text shared to the app (Android "Share" menu)
function inbox() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('raseed-share', 1);
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
// the page gets its own isolated process, so the reader can use several processor cores
function isolated(resp) {
  if (!resp || resp.type === 'opaque' || resp.status === 0) return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}
async function fromCacheThenNet(cacheName, req) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req, { ignoreSearch: true });
  if (hit) return isolated(hit);
  const r = await fetch(req);
  if (r.ok) c.put(req, r.clone()).catch(() => {});
  return isolated(r);
}

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) { e.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET') return;
  if (url.origin === self.location.origin) {
    const path = url.pathname;
    if (/\/(engine|lib)\//.test(path)) { e.respondWith(fromCacheThenNet(ENGINE, req)); return; }
    if (/\/sw\.js$/.test(path)) return;
    e.respondWith((async () => {
      const c = await caches.open(VERSION);
      if (req.mode === 'navigate') {
        // the saved app first (instant, works offline); fetch it from the internet only when missing
        const hit = await c.match('./index.html');
        if (hit) return isolated(hit);
        try { const r = await fetch(req); if (r.ok) c.put('./index.html', r.clone()); return isolated(r); }
        catch (err) { return new Response('<h3 style="font-family:sans-serif;padding:24px">Raseed needs internet the very first time it opens.</h3>', { headers: { 'Content-Type': 'text/html' } }); }
      }
      const hit = await c.match(req, { ignoreSearch: true });
      if (hit) return isolated(hit);
      try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return isolated(r); }
      catch (err) { return Response.error(); }
    })());
    return;
  }
  // satellite map pictures: internet first, keep the last ones for offline viewing
  if (/arcgisonline\.com/i.test(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      try {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') { c.put(req, r.clone()).catch(() => {}); trimTiles(c); }
        return r;
      } catch (err) { return (await c.match(req)) || Response.error(); }
    })());
  }
});
