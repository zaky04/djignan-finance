/* ==========================================================================
   GeoFinance System — Bootstrap & routeur SPA
   Point d'entrée : câble l'écran de verrouillage, initialise tous les
   modules, gère la navigation entre vues et la réaction aux changements
   de données (bus d'événements).
   ========================================================================== */

import { STORES, dbAdd, dbGetAll, getSetting, setSetting } from './db.js';
import { initLockScreen } from './auth.js';
import { bus, EVENTS, appState } from './state.js';
import { uuid, escapeHtml, openModal, showToast } from './utils.js';
import { checkWeeklyBackupReminder } from './backup.js';
import { maybeShowInstallPrompt } from './install-prompt.js';
import { checkAndNotify } from './notifications.js';

import { renderDashboard } from './modules/dashboard.js';
import { renderWallets, initWalletsModule } from './modules/wallets.js';
import { renderTransactions, initTransactionsModule, openQuickAdd } from './modules/transactions.js';
import { renderBudgets, initBudgetsModule, generateDueRecurring } from './modules/budgets.js';
import { renderSavings, initSavingsModule } from './modules/savings.js';
import { renderInvestments, initInvestmentsModule } from './modules/investments.js';
import { renderDebts, initDebtsModule } from './modules/debts.js';
import { renderTools, initToolsModule } from './modules/tools.js';
import { renderReports, initReportsModule } from './modules/reports.js';
import { renderShared, initSharedModule } from './modules/shared.js';
import { renderKeptAccounts, initKeptAccountsModule } from './modules/kept-accounts.js';
import { renderSettings, initSettingsModule } from './modules/settings.js';
import { initSearchModule } from './modules/search.js';

const VIEW_RENDERERS = {
  dashboard: renderDashboard,
  wallets: renderWallets,
  transactions: renderTransactions,
  budgets: renderBudgets,
  savings: renderSavings,
  investments: renderInvestments,
  debts: renderDebts,
  tools: renderTools,
  reports: renderReports,
  shared: renderShared,
  keptAccounts: renderKeptAccounts,
  settings: renderSettings,
};

const VIEW_TITLES = {
  dashboard: 'Tableau de bord', wallets: 'Portefeuilles', transactions: 'Transactions', budgets: 'Budgets',
  savings: 'Épargne', investments: 'Investissements', debts: 'Dettes & créances', tools: 'Outils',
  reports: 'Rapports', shared: 'Partage de dépenses', keptAccounts: 'Comptes gardés', settings: 'Paramètres',
};

const MORE_VIEWS = ['wallets', 'savings', 'investments', 'debts', 'tools', 'reports', 'shared', 'keptAccounts', 'settings'];

let lockScreenApi = null;
let lastActivityAt = Date.now();

function markActivity() { lastActivityAt = Date.now(); }

async function lockNow() {
  document.getElementById('app').hidden = true;
  if (lockScreenApi) {
    await lockScreenApi.lock();
    lockScreenApi.show();
  }
}

async function checkAutoLock() {
  const appEl = document.getElementById('app');
  if (!appEl || appEl.hidden) return; // déjà verrouillé
  const minutes = await getSetting('autoLockMinutes', 0);
  if (!minutes) return;
  if (Date.now() - lastActivityAt >= minutes * 60 * 1000) {
    await lockNow();
  }
}

function navigateTo(view) {
  if (!VIEW_RENDERERS[view]) return;
  appState.currentView = view;

  document.querySelectorAll('.view').forEach((el) => {
    const active = el.dataset.view === view;
    el.hidden = !active;
    el.classList.toggle('is-active', active);
  });
  document.querySelectorAll('[data-view-target]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.viewTarget === view);
  });
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = VIEW_TITLES[view] || '';

  VIEW_RENDERERS[view]();
  bus.emit(EVENTS.VIEW_CHANGED, view);
}

async function openMoreSheet() {
  const keptAccountsEnabled = await getSetting('keptAccountsEnabled', false);
  const views = MORE_VIEWS.filter((v) => v !== 'keptAccounts' || keptAccountsEnabled);
  const modal = openModal(
    views.map((v) => `<button type="button" class="nav-item" style="width:100%;" data-view-target="${v}">${escapeHtml(VIEW_TITLES[v])}</button>`).join(''),
    { title: 'Plus' }
  );
  modal.el.querySelectorAll('[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => { navigateTo(btn.dataset.viewTarget); modal.close(); });
  });
}

/** Bascule la visibilité du bouton de nav "Comptes gardés" (masqué par défaut, fonctionnalité
    optionnelle activée dans Paramètres). Appelée au boot et depuis settings.js au changement. */
export async function applyKeptAccountsVisibility() {
  const enabled = await getSetting('keptAccountsEnabled', false);
  const navBtn = document.getElementById('nav-kept-accounts');
  if (navBtn) navBtn.hidden = !enabled;
  if (!enabled && appState.currentView === 'keptAccounts') navigateTo('dashboard');
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

function applyPrivacy(hidden) {
  document.body.dataset.privacy = hidden ? 'hidden' : 'visible';
  document.getElementById('privacy-toggle')?.setAttribute('aria-pressed', String(hidden));
}

function wireGlobalChrome() {
  document.querySelectorAll('[data-view-target]').forEach((el) => {
    el.addEventListener('click', () => navigateTo(el.dataset.viewTarget));
  });

  document.getElementById('bottom-nav-more')?.addEventListener('click', openMoreSheet);

  document.getElementById('quick-add-btn')?.addEventListener('click', () => openQuickAdd());
  document.getElementById('bottom-nav-add')?.addEventListener('click', () => openQuickAdd());

  document.getElementById('privacy-toggle')?.addEventListener('click', async () => {
    appState.privacyHidden = !appState.privacyHidden;
    applyPrivacy(appState.privacyHidden);
    await setSetting('privacyHidden', appState.privacyHidden);
  });

  document.getElementById('theme-toggle')?.addEventListener('click', async () => {
    const order = ['auto', 'light', 'dark'];
    const idx = order.indexOf(appState.theme);
    appState.theme = order[(idx + 1) % order.length];
    applyTheme(appState.theme);
    await setSetting('theme', appState.theme);
    showToast(`Thème : ${{ auto: 'Automatique', light: 'Clair', dark: 'Sombre' }[appState.theme]}`);
    VIEW_RENDERERS[appState.currentView]?.();
  });

  document.getElementById('lock-now-btn')?.addEventListener('click', lockNow);

  ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'].forEach((ev) => {
    document.addEventListener(ev, markActivity, { passive: true });
  });
  setInterval(checkAutoLock, 15000);

  bus.on(EVENTS.DATA_CHANGED, () => { VIEW_RENDERERS[appState.currentView]?.(); });
}

async function seedDefaultsIfNeeded() {
  const categories = await dbGetAll(STORES.CATEGORIES);
  if (categories.length === 0) {
    const defaults = [
      { name: 'Salaire', type: 'income' },
      { name: 'Autres revenus', type: 'income' },
      { name: 'Alimentation', type: 'expense' },
      { name: 'Logement', type: 'expense' },
      { name: 'Transport', type: 'expense' },
      { name: 'Loisirs', type: 'expense' },
      { name: 'Santé', type: 'expense' },
      { name: 'Abonnements', type: 'expense' },
      { name: 'Autres dépenses', type: 'expense' },
    ];
    for (const c of defaults) {
      await dbAdd(STORES.CATEGORIES, { id: uuid(), parentId: null, createdAt: new Date().toISOString(), ...c });
    }
  }
  const base = await getSetting('baseCurrency');
  if (!base) await setSetting('baseCurrency', 'EUR');
}

async function onUnlocked() {
  document.getElementById('lock-screen').hidden = true;
  document.getElementById('app').hidden = false;
  markActivity();
  await generateDueRecurring();
  navigateTo('dashboard');
  maybeShowInstallPrompt();
  checkAndNotify();
  setTimeout(() => checkWeeklyBackupReminder(), 4000); // décalé pour ne pas superposer les deux invites
}

(async function boot() {
  try {
    await seedDefaultsIfNeeded();

    initWalletsModule();
    initTransactionsModule();
    initBudgetsModule();
    initSavingsModule();
    initInvestmentsModule();
    initDebtsModule();
    initToolsModule();
    initReportsModule();
    initSharedModule();
    initKeptAccountsModule();
    initSettingsModule();
    initSearchModule();
    wireGlobalChrome();

    appState.theme = await getSetting('theme', 'auto');
    applyTheme(appState.theme);
    appState.privacyHidden = await getSetting('privacyHidden', false);
    applyPrivacy(appState.privacyHidden);
    await applyKeptAccountsVisibility();

    lockScreenApi = initLockScreen({ onUnlock: onUnlocked });
  } catch (err) {
    console.error('[GeoFinance] Échec critique au démarrage :', err);
    const lockScreen = document.getElementById('lock-screen');
    if (lockScreen) {
      lockScreen.innerHTML = `
        <div class="lock-card">
          <p class="lock-error">Une erreur a empêché le démarrage de l'application. Rechargez la page ; si le problème persiste, essayez de vider le cache du navigateur pour ce site.</p>
        </div>`;
      lockScreen.hidden = false;
    }
  }
})();
