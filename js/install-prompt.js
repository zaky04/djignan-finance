/* ==========================================================================
   Djignan Financial System — Invite à l'installation (PWA)
   Chrome / Edge (Android + PC) exposent l'API beforeinstallprompt : on
   l'intercepte pour proposer un vrai bouton "Installer" au lieu de compter
   sur l'icône discrète de la barre d'adresse. iOS Safari ne propose AUCUNE
   installation programmatique (restriction Apple) : on affiche à la place
   des instructions claires (Partager > Sur l'écran d'accueil).
   ========================================================================== */

import { getSetting, setSetting } from './db.js';
import { t } from './i18n.js';

let deferredPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
});

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
export function isIOS() {
  const ua = window.navigator.userAgent;
  const isIPhoneLike = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isIPadOS13Plus = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIPhoneLike || isIPadOS13Plus;
}
export function isSafari() {
  const ua = window.navigator.userAgent;
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
}
export function isAndroid() {
  return /android/i.test(window.navigator.userAgent);
}
export function hasDeferredPrompt() {
  return !!deferredPrompt;
}

/** Déclenche le prompt natif d'installation (Chrome/Edge). Retourne 'accepted' | 'dismissed' | null. */
export async function triggerInstall() {
  if (!deferredPrompt) return null;
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  await setSetting('installPromptSnoozedUntil', choice.outcome === 'accepted' ? null : new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString());
  return choice.outcome;
}

export async function resetInstallPromptSnooze() {
  await setSetting('installPromptSnoozedUntil', null);
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" style="vertical-align:-3px;"><path fill="currentColor" d="M12 2 8 6h2.5v9h3V6H16L12 2Zm7 9v9H5v-9H3v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9h-2Z"/></svg>';

function bannerHtml({ title, body, showInstallBtn }) {
  return `
    <div class="install-banner" id="install-banner" role="dialog" aria-label="${t("Installer l'application")}">
      <button type="button" class="install-banner-close" aria-label="${t('Fermer')}">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6Z"/></svg>
      </button>
      <div class="install-banner-icon">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 2c-4 3-9 3.5-9 3.5V12c0 6 4 9.5 9 10.5 5-1 9-4.5 9-10.5V5.5S16 5 12 2Z"/></svg>
      </div>
      <div class="install-banner-body">
        <div class="install-banner-title">${title}</div>
        <div class="install-banner-text">${body}</div>
      </div>
      ${showInstallBtn ? `<button type="button" class="btn btn-primary" id="install-banner-btn">${t('Installer')}</button>` : ''}
    </div>`;
}

async function dismiss(days) {
  document.getElementById('install-banner')?.remove();
  await setSetting('installPromptSnoozedUntil', new Date(Date.now() + days * 24 * 3600 * 1000).toISOString());
}

/** À appeler une fois après le déverrouillage (n'affiche rien si déjà installé ou récemment ignoré). */
export async function maybeShowInstallPrompt() {
  if (isStandalone() || document.getElementById('install-banner')) return;

  const snoozedUntil = await getSetting('installPromptSnoozedUntil');
  if (snoozedUntil && Date.now() < new Date(snoozedUntil).getTime()) return;

  let html;
  if (deferredPrompt) {
    html = bannerHtml({
      title: t('Installer Djignan sur cet appareil'),
      body: t("Accès direct depuis l'écran d'accueil et fonctionnement 100% hors-ligne."),
      showInstallBtn: true,
    });
  } else if (isIOS() && isSafari()) {
    html = bannerHtml({
      title: t("Installez Djignan sur l'écran d'accueil"),
      body: t('Appuyez sur {icon} <strong>Partager</strong>, puis <strong>« Sur l\'écran d\'accueil »</strong>.', { icon: SHARE_ICON }),
      showInstallBtn: false,
    });
  } else {
    return; // Navigateur sans méthode d'installation connue (ex: Firefox).
  }

  document.body.insertAdjacentHTML('beforeend', html);
  const banner = document.getElementById('install-banner');
  banner.querySelector('.install-banner-close').addEventListener('click', () => dismiss(7));

  const installBtn = document.getElementById('install-banner-btn');
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      banner.remove();
      await triggerInstall();
    });
  }
}
