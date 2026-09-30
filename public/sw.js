// Service worker minimo: serve solo a far riconoscere l'app come installabile
// e a tenere la "scocca" statica (script, stile, icone) pronta anche con una
// connessione debole. I dati (tutto cio' che passa da /api o /mcp) vanno
// SEMPRE in rete: cachiare i task darebbe l'illusione di dati aggiornati
// quando non lo sono, ed e' esattamente il tipo di sfiducia che affossa un
// task manager personale.

const CACHE = 'shell-v1';
const SHELL = ['/style.css', '/app.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  const isShellAsset = SHELL.includes(url.pathname) || url.pathname.startsWith('/icons/');
  if (!isShellAsset) return; // tutto il resto (pagina, /api, /mcp) va dritto in rete

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fresh = fetch(event.request)
        .then((res) => { caches.open(CACHE).then((c) => c.put(event.request, res.clone())); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
