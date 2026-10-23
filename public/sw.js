// Service worker: la interfaz funciona sin conexión (campaña, tutorial, partidas contra la IA).
// - Navegación: red primero, con la copia en caché como respaldo sin conexión.
// - Código de la app (js, css, html): red primero, con la caché solo como respaldo sin conexión. Antes se servía la copia en caché
//   y se actualizaba después, así que tras cada despliegue un visitante recurrente veía una mezcla de módulos viejos y nuevos.
// - Archivos que no cambian (vendor, iconos, fuentes): caché y actualización en segundo plano.
// - /api y /ws nunca se cachean. Sube VERSION para invalidar la caché tras un despliegue.
const VERSION = 'checkpoint-v2';
const isCode = (path) => /\.(js|css|html|webmanifest)$/.test(path);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/icon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/ws') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }

  if (isCode(url.pathname)) {
    event.respondWith(
      caches.open(VERSION).then((cache) =>
        fetch(req, { cache: 'no-cache' }) // revalida siempre con el servidor (304 si no cambió)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(async () => (await cache.match(req)) ?? Response.error()),
      ),
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
