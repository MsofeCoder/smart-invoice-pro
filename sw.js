/**
 * Service Worker — offline app shell.
 *
 * Strategy
 *   navigations  network-first (a fresh deploy is picked up immediately),
 *                falling back to the *requested* page in cache, then index.html
 *   assets       cache-first, with a background refresh for stale-while-
 *                revalidate behaviour on stylesheets and scripts
 *
 * UPDATES
 *   A new worker precaches everything, then takes over via `skipWaiting()` +
 *   `clients.claim()`. The page listens for `controllerchange` and reloads
 *   exactly once, so a user never ends up running yesterday's JavaScript
 *   against today's markup — the failure mode that makes an offline PWA look
 *   "stuck on an old version".
 *
 *   `register()` is called with `updateViaCache: 'none'` so the browser never
 *   serves this file from the HTTP cache; otherwise an update can be delayed
 *   by up to 24 hours and no amount of cache-busting helps.
 *
 * Bump CACHE_NAME on every deploy — it is what makes clients pick up new files.
 */
const CACHE_NAME = 'smart-invoice-pro-v20';

/** Cache prefixes owned by this app, used to sweep up after a rename. */
const OWNED_PREFIXES = ['smart-invoice-pro-', 'crown-invoice-pro-'];

const APP_SHELL = [
  './',
  './index.html',
  './invoice.html',
  './customers.html',
  './products.html',
  './reports.html',
  './settings.html',
  './css/styles.css',
  './js/app.config.js',
  './js/config.js',
  './js/app.js',
  './js/charts.js',
  './js/invoice.js',
  './js/customer.js',
  './js/product.js',
  './js/report.js',
  './js/settings.js',
  './js/shell.js',
  './js/cloud.config.js',
  './js/cloudClient.js',
  './js/monitoring.js',
  './js/monitoringModel.js',
  './js/monitoringStore.js',
  './js/accountUI.js',
  './libs/supabase.js',
  './js/onboarding.js',
  './js/feedback.js',
  './js/db.js',
  './js/storageService.js',
  './js/licenseService.js',
  './js/share.js',
  './js/currency.js',
  './js/calculations.js',
  './js/export.js',
  './js/utils.js',
  './js/brand.js',
  './js/brand-boot.js',
  './libs/jspdf.umd.min.js',
  './libs/jspdf.plugin.autotable.min.js',
  './libs/qrcode.min.js',
  './manifest.json',
  './favicon.svg',
  './favicon.ico',
  './favicon.png',
  './assets/fonts/inter-latin.woff2',
  './assets/fonts/plus-jakarta-sans-latin.woff2',
  './assets/brand/logo-mark.svg',
  './assets/brand/logo-horizontal.svg',
  './assets/brand/logo-horizontal-dark.svg',
  './assets/brand/logo-mono.svg',
  './assets/brand/favicon.svg',
  './assets/logo.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon.ico',
  './assets/icons/apple-touch-icon.png',
];

/* ================= Install: pre-cache app shell =================
   Each entry is cached independently. `cache.addAll()` is all-or-nothing: one
   missing or renamed asset rejects the whole batch and the service worker never
   installs, leaving the app permanently online-only with no obvious symptom. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(
        APP_SHELL.map((url) => cache.add(url).catch((err) => {
          console.warn('[SW] failed to precache', url, err);
        }))
      ))
      .then(() => self.skipWaiting())
  );
});

/* ================= Activate: clean old caches ================= */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          // Drop our own stale caches (including any left by a previous
          // product name) but never touch caches another app on this origin
          // may own.
          .filter((key) => key !== CACHE_NAME && OWNED_PREFIXES.some((p) => key.startsWith(p)))
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

/* ================= Fetch ================= */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip cross-origin requests (e.g. external fonts) — let them pass through
  if (url.origin !== self.location.origin) return;

  // Never cache the service worker itself; the browser must be able to fetch a
  // new one, and a cached copy is the classic cause of "stuck on old version".
  if (url.pathname.endsWith('/sw.js')) return;

  /* Navigations: network-first so a fresh deploy is picked up, falling back to
     the *requested* page in cache. Falling back to index.html unconditionally
     would silently serve the dashboard when the user opens invoice.html offline. */
  if (request.mode === 'navigate') {
    /* Cache under the PATH, not the full URL. The app links to
       `invoice.html?new=1` and the tour adds `?tour=<step>`, so keying on the
       request would mint a new, permanent cache entry for every query variant
       and the navigation cache would grow without bound. The lookup mirrors the
       same normalisation so an offline deep link still resolves. */
    const key = new URL(request.url);
    key.search = '';
    key.hash = '';

    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(key.href, copy));
          }
          return response;
        })
        .catch(() => caches.match(key.href)
          .then((cached) => cached || caches.match(request))
          .then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  /* Static assets: cache-first, then refresh the entry in the background so the
     *next* load is current. Returning the cached copy immediately keeps loads
     instant; the refresh means a changed stylesheet is picked up on the
     following navigation rather than needing a second hard reload. */
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => {
        // Offline fallback for images
        if (request.destination === 'image') {
          return caches.match('./assets/logo.png');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });

      if (cached) {
        // Fire-and-forget refresh; the cached response is returned regardless.
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
      return network;
    })
  );
});

/* ================= Message ================= */
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data.type === 'CACHE_VERSION') {
    // Lets the page report which build it is actually running.
    event.source?.postMessage({ type: 'CACHE_VERSION', version: CACHE_NAME });
  }
});
