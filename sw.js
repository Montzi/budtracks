// Offline shell. Bump VERSION on each release so phones pick up the new build.
const VERSION = 'budtracks-v26';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first for the page so updates land fast; cache first for everything else.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // The bank service and Plaid are never cached or answered by the shell: let them go straight to the network.
  { const h = new URL(req.url); if (h.origin !== location.origin && !/fonts\.(googleapis|gstatic)\.com$/.test(h.hostname)) return; }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put('index.html', copy)); return r; })
      .catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok && (new URL(req.url).origin === location.origin || /fonts\.(googleapis|gstatic)\.com$/.test(new URL(req.url).hostname))) {
      const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy));
    }
    return r;
  })));
});
