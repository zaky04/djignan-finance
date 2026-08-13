/* ==========================================================================
   GeoFinance System — Bootstrap & routeur SPA
   Point d'entrée : câble l'écran de verrouillage, initialise tous les
   modules, gère la navigation entre vues et la réaction aux changements
   de données (bus d'événements).
   ========================================================================== */

import { STORES, dbAdd, dbPut, dbGetAll, getSetting, setSetting } from './db.js';
import { initLockScreen, isBiometricAvailable, registerBiometric } from './auth.js';
import { bus, EVENTS, appState } from './state.js';
import { uuid, escapeHtml, openModal, showToast, CURRENCIES } from './utils.js';
import { checkWeeklyBackupReminder } from './backup.js';
import { maybeShowInstallPrompt } from './install-prompt.js';
import { checkAndNotify, isNotificationSupported, requestNotificationPermission } from './notifications.js';

import { renderDashboard, DASHBOARD_PANEL_DEFAULTS } from './modules/dashboard.js';
import { renderWallets, initWalletsModule, openWalletModal } from './modules/wallets.js';
import { renderTransactions, initTransactionsModule, openQuickAdd } from './modules/transactions.js';
import { renderBudgets, initBudgetsModule, generateDueRecurring } from './modules/budgets.js';
import { renderSavings, initSavingsModule } from './modules/savings.js';
import { renderInvestments, initInvestmentsModule } from './modules/investments.js';
import { renderDebts, initDebtsModule, ensureDebtCategoryId } from './modules/debts.js';
import { renderTools, initToolsModule } from './modules/tools.js';
import { renderReports, initReportsModule } from './modules/reports.js';
import { renderShared, initSharedModule } from './modules/shared.js';
import { renderKeptAccounts, initKeptAccountsModule } from './modules/kept-accounts.js';
import {
  renderSettings, initSettingsModule, PROFILE_FIELDS, AUTO_LOCK_OPTIONS,
  OPTIONAL_MODULES, applyOptionalModuleVisibility, DASHBOARD_PANEL_LABELS,
} from './modules/settings.js';
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
  const moduleStates = await Promise.all(OPTIONAL_MODULES.map(async (m) => [m.view, await getSetting(m.key, false)]));
  const disabledViews = new Set(moduleStates.filter(([, enabled]) => !enabled).map(([view]) => view));
  const views = MORE_VIEWS.filter((v) => !disabledViews.has(v));
  const modal = openModal(
    views.map((v) => `<button type="button" class="nav-item" style="width:100%;" data-view-target="${v}">${escapeHtml(VIEW_TITLES[v])}</button>`).join(''),
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

/** Rattrape les transactions de dette/créance créées avant l'introduction de la catégorie dédiée
    "Prêt et créance" (identifiables par le champ debtId sans categoryId — voir debts.js). Coût
    négligeable une fois la migration faite (plus aucune ligne à traiter ensuite), donc appelée à
    chaque boot plutôt que gardée par un flag one-shot : plus robuste si de futures transactions
    sans catégorie apparaissaient pour une autre raison. Pas besoin de notifier/re-render ici :
    ceci tourne avant le déverrouillage, et onUnlocked() fait de toute façon un rendu complet et
    frais du tableau de bord juste après.*/
async function migrateDebtTransactionCategories() {
  const transactions = await dbGetAll(STORES.TRANSACTIONS);
  const toFix = transactions.filter((t) => t.debtId && !t.categoryId);
  for (const t of toFix) {
    t.categoryId = await ensureDebtCategoryId(t.type);
    await dbPut(STORES.TRANSACTIONS, t);
  }
}

/** Applique ?view=X ou ?action=quick-add (raccourcis PWA déclarés dans manifest.json — appui
    long sur l'icône de l'app) une fois déverrouillé, puis nettoie l'URL pour ne pas rejouer
    l'action à chaque re-déverrouillage dans la même session. */
function applyShortcutParams() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const action = params.get('action');
  if (view && VIEW_RENDERERS[view]) navigateTo(view);
  if (action === 'quick-add') openQuickAdd();
  if (view || action) window.history.replaceState({}, '', window.location.pathname);
}

/** Bouton "Passer cette étape" commun à (presque) toutes les étapes de l'onboarding : avance
    sans rien enregistrer, laissant les valeurs par défaut déjà seedées (seedDefaultsIfNeeded)
    ou les réglages par défaut de chaque module en place. */
function skipStepButtonHtml() {
  return '<button type="button" class="btn btn-ghost btn-block" id="ob-skip" style="margin-top:8px;">Passer cette étape</button>';
}

/** Assistant de configuration multi-étapes affiché une seule fois, à la toute première
    utilisation (flag onboardingCompleted), juste après la création du code PIN. Chaque étape
    est individuellement passable ("Passer cette étape") — rien n'est obligatoire au-delà de la
    création du PIN lui-même, pour ne pas décourager un premier lancement trop long ; tout reste
    modifiable ensuite dans Paramètres. */
async function maybeShowOnboarding() {
  if (await getSetting('onboardingCompleted', false)) return;
  // Garde supplémentaire au-delà du flag : une install existante qui met à jour vers cette
  // version a déjà des portefeuilles, donc n'est pas "nouvelle" même sans le flag posé —
  // ne jamais lui montrer l'onboarding a posteriori, seulement le marquer fait silencieusement.
  const hasWallets = (await dbGetAll(STORES.WALLETS)).length > 0;
  await setSetting('onboardingCompleted', true); // marqué avant affichage : fermer sans agir ne doit pas re-harceler à chaque déverrouillage
  if (hasWallets) return;

  const steps = [
    {
      title: 'Bienvenue sur GeoFinance',
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;font-size:13.5px;color:var(--text-muted);">Choisissez d'abord la devise dans laquelle suivre votre argent au quotidien — vous pourrez quand même créer des portefeuilles dans d'autres devises ensuite.</p>
          <form id="ob-currency-form">
            <div class="form-row">
              <label>Devise principale</label>
              <select name="baseCurrency">${CURRENCIES.map((c) => `<option value="${c}" ${c === 'EUR' ? 'selected' : ''}>${c}</option>`).join('')}</select>
            </div>
            <button type="submit" class="btn btn-primary btn-block">Continuer</button>
          </form>
          ${skipStepButtonHtml()}`;
        el.querySelector('#ob-currency-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await setSetting('baseCurrency', new FormData(e.target).get('baseCurrency'));
          next();
        });
        el.querySelector('#ob-skip').addEventListener('click', () => next());
      },
    },
    {
      title: 'Votre premier portefeuille',
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;font-size:13.5px;color:var(--text-muted);">Créez votre premier portefeuille (compte bancaire, mobile money, espèces…) pour commencer à suivre vos finances.</p>
          <button type="button" class="btn btn-primary btn-block" id="ob-wallet-create">Créer un portefeuille</button>
          ${skipStepButtonHtml()}`;
        el.querySelector('#ob-wallet-create').addEventListener('click', () => {
          // Le formulaire de portefeuille est une modale à part entière (réutilisée telle
          // quelle depuis wallets.js) : on masque celle de l'assistant pendant ce temps plutôt
          // que de la fermer, pour pouvoir la ré-afficher et enchaîner sur l'étape suivante
          // une fois celle-ci refermée (créée ou annulée, peu importe — voir "tout passable").
          modal.el.style.display = 'none';
          openWalletModal(null, { onDone: () => { modal.el.style.display = ''; next(); } });
        });
        el.querySelector('#ob-skip').addEventListener('click', () => next());
      },
    },
    {
      title: 'Votre profil',
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;font-size:13.5px;color:var(--text-muted);">Utilisé pour la salutation sur le tableau de bord et l'en-tête des rapports PDF. Reste 100% local, jamais transmis.</p>
          <form id="ob-profile-form">
            ${PROFILE_FIELDS.map((f) => `
              <div class="form-row">
                <label>${escapeHtml(f.label)}</label>
                <input type="${f.type}" name="${f.key}" maxlength="120">
              </div>`).join('')}
            <button type="submit" class="btn btn-primary btn-block">Continuer</button>
          </form>
          ${skipStepButtonHtml()}`;
        el.querySelector('#ob-profile-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          await setSetting('userProfile', Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, (fd.get(f.key) || '').trim()])));
          next();
        });
        el.querySelector('#ob-skip').addEventListener('click', () => next());
      },
    },
    {
      title: 'Personnalisez votre tableau de bord',
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;font-size:13.5px;color:var(--text-muted);">Choisissez les panneaux affichés sur le tableau de bord (modifiable à tout moment dans Paramètres).</p>
          <form id="ob-dashboard-form">
            ${Object.entries(DASHBOARD_PANEL_LABELS).map(([key, label]) => `
              <label style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:14px;cursor:pointer;">
                <input type="checkbox" name="${key}" ${DASHBOARD_PANEL_DEFAULTS[key] ? 'checked' : ''}>
                ${escapeHtml(label)}
              </label>`).join('')}
            <button type="submit" class="btn btn-primary btn-block" style="margin-top:10px;">Continuer</button>
          </form>
          ${skipStepButtonHtml()}`;
        el.querySelector('#ob-dashboard-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const panels = Object.fromEntries(Object.keys(DASHBOARD_PANEL_LABELS).map((key) => [key, fd.get(key) === 'on']));
          await setSetting('dashboardPanels', { ...DASHBOARD_PANEL_DEFAULTS, ...panels });
          next();
        });
        el.querySelector('#ob-skip').addEventListener('click', () => next());
      },
    },
    {
      title: 'Modules optionnels',
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;font-size:13.5px;color:var(--text-muted);">Activez ce qui s'applique à votre usage (modifiable à tout moment dans Paramètres).</p>
          <form id="ob-modules-form">
            ${OPTIONAL_MODULES.map((mod) => `
              <label style="display:flex;align-items:center;gap:10px;padding:6px 0;font-size:14px;cursor:pointer;">
                <input type="checkbox" name="${mod.key}">
                ${escapeHtml(mod.label)}
              </label>
              <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px;">${escapeHtml(mod.description)}</p>`).join('')}
            <button type="submit" class="btn btn-primary btn-block">Continuer</button>
          </form>
          ${skipStepButtonHtml()}`;
        el.querySelector('#ob-modules-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          for (const mod of OPTIONAL_MODULES) await setSetting(mod.key, fd.get(mod.key) === 'on');
          await applyOptionalModuleVisibility();
          next();
        });
        el.querySelector('#ob-skip').addEventListener('click', () => next());
      },
    },
    {
      title: 'Sécurité',
      async render(el, { next }) {
        const bioAvailable = await isBiometricAvailable();
        el.innerHTML = `
          <p style="margin:0 0 16px;font-size:13.5px;color:var(--text-muted);">Réglez le verrouillage automatique après inactivité${bioAvailable ? ' et activez le déverrouillage biométrique' : ''}.</p>
          <div class="form-row">
            <label>Verrouillage automatique après inactivité</label>
            <select id="ob-auto-lock">${AUTO_LOCK_OPTIONS.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')}</select>
          </div>
          ${bioAvailable ? '<button type="button" class="btn btn-ghost btn-block" id="ob-bio-enable" style="margin-bottom:10px;">Activer le déverrouillage biométrique</button>' : ''}
          <button type="button" class="btn btn-primary btn-block" id="ob-continue">Continuer</button>
          ${skipStepButtonHtml()}`;
        el.querySelector('#ob-bio-enable')?.addEventListener('click', async (e) => {
          try {
            await registerBiometric();
            showToast('Biométrie activée.');
            e.target.textContent = 'Biométrie activée ✓';
            e.target.disabled = true;
          } catch (err) {
            showToast(err.message || "Échec de l'activation biométrique.");
          }
        });
        el.querySelector('#ob-continue').addEventListener('click', async () => {
          await setSetting('autoLockMinutes', parseInt(el.querySelector('#ob-auto-lock').value, 10) || 0);
          next();
        });
        el.querySelector('#ob-skip').addEventListener('click', () => next());
      },
    },
    {
      title: 'Notifications',
      async render(el, { next }) {
        const supported = isNotificationSupported();
        el.innerHTML = `
          <p style="margin:0 0 16px;font-size:13.5px;color:var(--text-muted);">Rappels locaux pour vos budgets qui approchent leur limite, vos échéances proches et vos soldes bas.</p>
          ${supported
            ? '<button type="button" class="btn btn-primary btn-block" id="ob-notif-enable">Activer les notifications</button>'
            : '<p class="empty-state" style="padding:8px 0;">Non supportées par ce navigateur.</p>'}
          <button type="button" class="btn btn-ghost btn-block" id="ob-finish" style="margin-top:10px;">${supported ? 'Passer, terminer' : 'Terminer'}</button>`;
        el.querySelector('#ob-notif-enable')?.addEventListener('click', async () => {
          const perm = await requestNotificationPermission();
          if (perm === 'granted') { showToast('Notifications activées.'); await checkAndNotify(); }
          next();
        });
        el.querySelector('#ob-finish').addEventListener('click', () => next());
      },
    },
  ];

  let index = 0;
  const modal = openModal('<div id="ob-step-content"></div>', { title: steps[0].title });
  const titleEl = modal.el.querySelector('.modal-header h3');

  async function renderStep() {
    const step = steps[index];
    if (titleEl) titleEl.textContent = step.title;
    const body = modal.el.querySelector('.modal-body');
    body.innerHTML = `<p style="font-size:11px;color:var(--text-faint);margin:0 0 12px;text-transform:uppercase;letter-spacing:.04em;">Étape ${index + 1} / ${steps.length}</p><div id="ob-step-content"></div>`;
    await step.render(body.querySelector('#ob-step-content'), { next });
  }
  async function next() {
    index++;
    if (index >= steps.length) { modal.close(); return; }
    await renderStep();
  }

  await renderStep();
}

async function onUnlocked() {
  document.getElementById('lock-screen').hidden = true;
  document.getElementById('app').hidden = false;
  markActivity();
  await generateDueRecurring();
  navigateTo('dashboard');
  applyShortcutParams();
  await maybeShowOnboarding();
  maybeShowInstallPrompt();
  checkAndNotify();
  setTimeout(() => checkWeeklyBackupReminder(), 4000); // décalé pour ne pas superposer les deux invites
}

(async function boot() {
  try {
    // Réduit le risque que le navigateur évince l'IndexedDB sous pression de stockage
    // (silencieux sinon : la demande peut être refusée sans avertissement, mais ça ne
    // coûte rien de la faire — c'est le principal facteur de perte de données sur mobile).
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

    await seedDefaultsIfNeeded();
    await migrateDebtTransactionCategories();

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
    await applyOptionalModuleVisibility();

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
