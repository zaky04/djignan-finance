/* ==========================================================================
   GeoFinance System — Enregistrement du Service Worker
   Fichier externe (pas de <script> inline dans index.html) pour permettre une
   Content-Security-Policy stricte sans script-src 'unsafe-inline'.
   ========================================================================== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.error("Échec d'enregistrement du Service Worker :", err);
    });
  });
}
