// Service worker: lets the app be installed on a phone's home screen,
// opens offline with the last version, and shows reminder notifications.
const CACHE = 'steady-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'icons.js', 'budget.js', 'store.js', 'config.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'vendor/supabase.js', 'vendor/591.supabase.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// App files: try the network first so updates show up, fall back to the saved copy offline.
// Requests to other sites (the database) are never cached.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// Reminder notifications (sent by the reminder service once it is set up).
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Steady Budget', {
    body: data.body || 'A priority could use a little more money.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(list =>
    list.length ? list[0].focus() : self.clients.openWindow('./')));
});
