/* ==========================================================================
   GeoFinance System — Service Worker
   Stratégie : precache complet de l'app shell + cache-first avec mise à jour
   en arrière-plan (stale-while-revalidate) pour un fonctionnement 100% hors-ligne.
   ========================================================================== */

const CACHE_VERSION = 'v2';
const CACHE_NAME = `geofinance-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/auth.js',
  './js/state.js',
  './js/utils.js',
  './js/charts.js',
  './js/backup.js',
  './js/install-prompt.js',
  './js/modules/dashboard.js',
  './js/modules/wallets.js',
  './js/modules/transactions.js',
  './js/modules/budgets.js',
  './js/modules/savings.js',
  './js/modules/investments.js',
  './js/modules/debts.js',
  './js/modules/tools.js',
  './js/modules/reports.js',
  './vendor/chart.min.js',
  './vendor/jspdf.umd.min.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
];

/* ---------- Install : precache de l'app shell ---------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll échoue globalement si une seule ressource est absente (ex: vendor
      // pas encore téléchargé) -> on précache individuellement pour être tolérant.
      return Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Précache échoué pour', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* ---------- Activate : purge des anciens caches ---------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('geofinance-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/* ---------- Fetch : cache-first + revalidation en arrière-plan ---------- */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Seules les requêtes GET same-origin sont gérées par le cache applicatif.
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached || caches.match('./index.html'));

      // Stale-while-revalidate : sert le cache immédiatement si présent,
      // met à jour en tâche de fond ; sinon attend le réseau.
      return cached || networkFetch;
    })
  );
});

/* ---------- Messages : permet à app.js de forcer une mise à jour ---------- */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
