/* ==========================================================================
   Djignan Financial System — Enregistrement du Service Worker et mises à jour
   Fichier externe (pas de <script> inline dans index.html) pour permettre une
   Content-Security-Policy stricte sans script-src 'unsafe-inline'.

   Les mises à jour : une nouvelle version se télécharge en arrière-plan (sw.js, CACHE_VERSION) mais une page déjà ouverte garde
   l'ancienne jusqu'à son rechargement. Avant, rien ne le signalait : il fallait fermer puis rouvrir l'application, et beaucoup
   croyaient ne jamais recevoir les mises à jour. Maintenant :
   - l'application cherche une nouvelle version à l'ouverture, au retour sur l'application et toutes les 30 minutes ;
   - dès qu'elle est prête, un bandeau « Une nouvelle version est prête · Recharger » apparaît (la page n'est jamais rechargée d'office
     pendant qu'on s'en sert : une saisie en cours serait perdue) ; une page en arrière-plan est rechargée par sw.js lui-même.
   ========================================================================== */

const TEXTS = {
  fr: { ready: 'Une nouvelle version est prête.', reload: 'Recharger' },
  en: { ready: 'A new version is ready.', reload: 'Reload' },
};

function showUpdateBanner() {
  if (document.getElementById('update-banner')) return;
  const lang = (document.documentElement.lang || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr';
  const bar = document.createElement('div');
  bar.id = 'update-banner';
  bar.setAttribute('role', 'status');
  bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:2000;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-radius:12px;background:#1f3a8a;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.3);font:600 14px/1.3 system-ui,sans-serif;max-width:520px;margin:0 auto;';
  const text = document.createElement('span');
  text.textContent = TEXTS[lang].ready;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = TEXTS[lang].reload;
  button.style.cssText = 'border:0;border-radius:8px;padding:8px 14px;background:#fff;color:#1f3a8a;font:700 14px system-ui,sans-serif;cursor:pointer;flex-shrink:0;';
  button.addEventListener('click', () => window.location.reload());
  bar.append(text, button);
  document.body.appendChild(bar);
}

if ('serviceWorker' in navigator) {
  // Une page qui n'avait pas encore de Service Worker (toute première visite) n'a rien à « mettre à jour » : seul un changement de
  // contrôleur sur une page déjà contrôlée signale une nouvelle version.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showUpdateBanner(); hadController = true; });
  navigator.serviceWorker.addEventListener('message', (event) => { if (event.data && event.data.type === 'NEW_VERSION') showUpdateBanner(); });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((registration) => {
      // Cherche une nouvelle version sans attendre la prochaine ouverture : une application laissée ouverte (ordinateur, tablette) ou
      // restée en arrière-plan (iPhone) ne le ferait pas toute seule avant longtemps. Espacé d'au moins 10 minutes.
      let lastCheck = Date.now();
      const check = () => {
        if (Date.now() - lastCheck < 10 * 60 * 1000) return;
        lastCheck = Date.now();
        registration.update().catch(() => { /* hors-ligne : sans importance */ });
      };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      setInterval(check, 30 * 60 * 1000);
    }).catch((err) => {
      console.error("Échec d'enregistrement du Service Worker :", err);
    });
  });
}
