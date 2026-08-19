/* eslint-disable no-restricted-globals */
/**
 * Blup service worker.
 *
 * Two jobs, both of which only a service worker can do:
 *
 *   1. Receive Web Push while no tab is open, and show the notification.
 *   2. Keep the app shell available when the network is not, so opening Blup
 *      on a festival field shows the app (and its cached data) instead of the
 *      browser's dinosaur.
 *
 * Deliberately conservative about caching: the app shell and static assets are
 * cache-first because they are content-hashed and immutable, everything else is
 * network-first. Caching an API response here would mean two caches disagreeing
 * about the same data — the app already persists its own query cache, and that
 * one knows what is safe to keep.
 */

const VERSION = 'blup-v1';
const SHELL_CACHE = `${VERSION}-shell`;

/** Everything needed to render something useful with no network at all. */
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.ico'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // A missing shell entry must not fail the whole install, or one 404
      // leaves the app with no service worker at all.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // never cache Supabase or Stripe
  if (url.pathname.startsWith('/_expo/')) {
    // Content-hashed bundles: safe to serve from cache forever.
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
        return response;
      })),
    );
    return;
  }

  // A navigation with no network falls back to the cached shell, which then
  // hydrates from the app's own persisted query cache.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((hit) => hit ?? caches.match('/'))),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Blup', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Blup';
  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Same tag replaces an earlier notification about the same thing instead of
    // stacking five reminders for one event.
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: { url: data.url || '/activity' },
    timestamp: Date.now(),
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/activity';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Reuse an open tab if there is one — opening a second copy of the app is
      // how you end up with two sessions and a confused user.
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
