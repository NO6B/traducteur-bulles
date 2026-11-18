// Service worker de l'application : fonctionnement hors ligne et réception des images partagées (Android).
const VERSION = 'tb-v2';
const SHELL = [
  './', './index.html', './app.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  '../engine/ocr.js', '../engine/paddle.js', '../engine/router.js', '../engine/translate.js', '../engine/render.js',
  '../lib/ort/ort.wasm.min.js', '../lib/tesseract.min.js', '../lib/worker.min.js', '../fonts/comic-neue-700.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      // Seules les anciennes versions de l'app sont supprimées (pas les modèles ni les partages).
      if (key.startsWith('tb-v') && key !== VERSION) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// Partage depuis la galerie ou une capture d'écran (Android) : on garde les fichiers puis on ouvre l'app.
async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('images').filter((f) => f && f.size);
  const cache = await caches.open('tb-shared');
  await Promise.all(files.map((f, i) => cache.put(
    new Request(`./shared/${Date.now()}-${i}`),
    new Response(f, { headers: { 'content-type': f.type || 'image/jpeg', 'x-name': encodeURIComponent(f.name || 'image') } }),
  )));
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return; // traduction, données OCR : réseau direct
  // Fichiers de l'app : réponse immédiate depuis le cache, mise à jour en arrière-plan.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: url.pathname.endsWith('/app/') });
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
