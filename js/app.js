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

import { renderDashboard } from './modules/dashboard.js';
import { renderWallets, initWalletsModule } from './modules/wallets.js';
import { renderTransactions, initTransactionsModule, openQuickAdd } from './modules/transactions.js';
import { renderBudgets, initBudgetsModule, generateDueRecurring } from './modules/budgets.js';
import { renderSavings, initSavingsModule } from './modules/savings.js';
import { renderInvestments, initInvestmentsModule } from './modules/investments.js';
import { renderDebts, initDebtsModule } from './modules/debts.js';
import { renderTools, initToolsModule } from './modules/tools.js';
import { renderReports, initReportsModule } from './modules/reports.js';
import { renderSettings, initSettingsModule } from './modules/settings.js';

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
  settings: renderSettings,
};

const VIEW_TITLES = {
  dashboard: 'Tableau de bord', wallets: 'Portefeuilles', transactions: 'Transactions', budgets: 'Budgets',
  savings: 'Épargne', investments: 'Investissements', debts: 'Dettes & créances', tools: 'Outils',
  reports: 'Rapports', settings: 'Paramètres',
};

const MORE_VIEWS = ['savings', 'investments', 'debts', 'tools', 'reports', 'settings'];

let lockScreenApi = null;

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

function openMoreSheet() {
  const modal = openModal(
    MORE_VIEWS.map((v) => `<button type="button" class="nav-item" style="width:100%;" data-view-target="${v}">${escapeHtml(VIEW_TITLES[v])}</button>`).join(''),
    { title: 'Plus' }
  );
  modal.el.querySelectorAll('[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => { navigateTo(btn.dataset.viewTarget); modal.close(); });
  });
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

  document.getElementById('lock-now-btn')?.addEventListener('click', async () => {
    document.getElementById('app').hidden = true;
    if (lockScreenApi) {
      await lockScreenApi.lock();
      lockScreenApi.show();
    }
  });

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
  await generateDueRecurring();
  navigateTo('dashboard');
  checkWeeklyBackupReminder();
}

(async function boot() {
  await seedDefaultsIfNeeded();

  initWalletsModule();
  initTransactionsModule();
  initBudgetsModule();
  initSavingsModule();
  initInvestmentsModule();
  initDebtsModule();
  initToolsModule();
  initReportsModule();
  initSettingsModule();
  wireGlobalChrome();

  appState.theme = await getSetting('theme', 'auto');
  applyTheme(appState.theme);
  appState.privacyHidden = await getSetting('privacyHidden', false);
  applyPrivacy(appState.privacyHidden);

  lockScreenApi = initLockScreen({ onUnlock: onUnlocked });
})();
