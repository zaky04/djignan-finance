/* ==========================================================================
   Djignan Financial System — Bootstrap & routeur SPA
   Point d'entrée : câble l'écran de verrouillage, initialise tous les
   modules, gère la navigation entre vues et la réaction aux changements
   de données (bus d'événements).
   ========================================================================== */

import './app-mode.js'; // en tout premier : pose .is-app avant le moindre rendu (voir app-mode.js)
import { STORES, dbAdd, dbPut, dbDelete, dbGetAll, getSetting, setSetting, DEFAULT_CATEGORIES, setAccessRole, maintainAuditLog } from './db.js';
import { initLockScreen, isBiometricAvailable, registerBiometric, isPinConfigured, consumeUnlockReport } from './auth.js';
import { bus, EVENTS, appState, notifyDataChanged } from './state.js';
import { createBackController } from './back-navigation.js';
import { setAutoMasking } from './privacy.js';
import { uuid, escapeHtml, openModal, showToast, confirmDialog, CURRENCIES, intlLocale, currentMonthKey, todayISO } from './utils.js';
import { checkWeeklyBackupReminder, importEncryptedBackup } from './backup.js';
import { checkWeeklyCloudBackupReminder, checkCloudStaleness, signInWithGoogle, pullBackupFromCloud, restoreDoneMessage, warmUpGoogleSignIn, initCloudAutoBackup } from './firebase-sync.js';
import { seedDemoData, clearDemoData } from './demo-data.js';
import { maybeShowInstallPrompt } from './install-prompt.js';
import { checkAndNotify, isNotificationSupported, requestNotificationPermission } from './notifications.js';
import { initI18n, t } from './i18n.js';
import { icon as svgIcon } from './icons.js';

// Une action refusée au rôle « aidant » (db.js) : un message clair plutôt qu'une erreur silencieuse dans la console.
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason?.name !== 'HelperRestrictedError') return;
  event.preventDefault();
  showToast(t('Action réservée au propriétaire.'));
});
import { initCardActions } from './card-actions.js';
import { initPanels } from './panels.js';
import { REQUIRE_ACTIVATION_CODE, ACTIVATION_CODE_HASH } from './activation-config.js';

import { renderDashboard, initDashboardModule, DASHBOARD_PANEL_DEFAULTS } from './modules/dashboard.js';
import { renderWallets, initWalletsModule, openWalletModal } from './modules/wallets.js';
import { renderTransactions, initTransactionsModule, openQuickAdd, resetTransactionsMonth } from './modules/transactions.js';
import { renderBudgets, initBudgetsModule, generateDueRecurring, resetBudgetsPeriod } from './modules/budgets.js';
import { renderSavings, initSavingsModule } from './modules/savings.js';
import { renderInvestments, initInvestmentsModule } from './modules/investments.js';
import { renderDebts, initDebtsModule, ensureDebtCategoryId, LEGACY_DEBT_CATEGORY_NAME } from './modules/debts.js';
import { renderTools, initToolsModule } from './modules/tools.js';
import { renderReports, initReportsModule, resetReportsPeriod } from './modules/reports.js';
import { renderShared, initSharedModule } from './modules/shared.js';
import { renderKeptAccounts, initKeptAccountsModule } from './modules/kept-accounts.js';
import { renderTontines, initTontinesModule } from './modules/tontines.js';
import {
  renderSettings, initSettingsModule, PROFILE_FIELDS, AUTO_LOCK_OPTIONS,
  OPTIONAL_MODULES, applyOptionalModuleVisibility, DASHBOARD_PANEL_LABELS,
} from './modules/settings.js';
import { initSearchModule } from './modules/search.js';
import { openSmsImportModal } from './modules/sms-import.js';
import { getUiMode, setUiMode, applyUiMode, SIMPLE_MORE_VIEWS } from './ui-mode.js';
import { syncNativeReminders } from './native-reminders.js';
import { initEasyHome, applyEasyHome, renderEasyHome, setEasyHome, openAddEntry } from './easy-home.js';
import { openEasyDebts } from './easy-debts.js';
import { maybeRunMonthlyBackupCheck } from './backup-verify.js';
import { queueSharedSms } from './sms-queue.js';
import { isSpeechSupported } from './speech-out.js';

const VIEW_RENDERERS = {
  // Accueil facile (easy-home.js) : rendu en plus du tableau de bord, seulement si le réglage est activé.
  // `finally` : l'accueil facile se dessine même si un panneau du tableau de bord lève une erreur (sinon écran vide).
  dashboard: async () => { try { await renderDashboard(); } finally { await renderEasyHome(); } },
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
  tontines: renderTontines,
  settings: renderSettings,
};

const VIEW_ICONS = {
  wallets: 'wallet', savings: 'jar', investments: 'chart', debts: 'ledger', tools: 'wrench', reports: 'report',
  shared: 'people', keptAccounts: 'key', tontines: 'circle', settings: 'sliders',
};

const VIEW_TITLES = {
  dashboard: 'Tableau de bord', wallets: 'Portefeuilles', transactions: 'Transactions', budgets: 'Budgets',
  savings: 'Épargne', investments: 'Investissements', debts: 'Dettes & créances', tools: 'Outils',
  reports: 'Rapports', shared: 'Partage de dépenses', keptAccounts: 'Comptes gardés', tontines: 'Tontines', settings: 'Paramètres',
};

const MORE_VIEWS = ['wallets', 'savings', 'investments', 'debts', 'tools', 'reports', 'shared', 'keptAccounts', 'tontines', 'settings'];

let lockScreenApi = null;
let lastActivityAt = Date.now();

function markActivity() { lastActivityAt = Date.now(); }

// Reprogramme les rappels Android (native-reminders.js) peu après un changement de données : on attend
// la fin d'une rafale d'écritures plutôt que de recalculer à chacune. Sans effet hors de l'APK.
let reminderSyncTimer = null;
function scheduleNativeReminderSync() {
  clearTimeout(reminderSyncTimer);
  reminderSyncTimer = setTimeout(() => syncNativeReminders(), 3000);
}

async function lockNow() {
  document.getElementById('app').hidden = true;
  if (lockScreenApi) {
    await lockScreenApi.lock();
    lockScreenApi.show();
  }
}

/* L'application peut rester ouverte des jours (le verrouillage automatique est désactivé par défaut, et sur téléphone le processus
   survit en arrière-plan). Les écrans gardaient alors le mois de leur ouverture : après minuit le 1er, Transactions, Budgets et
   Rapports affichaient encore le mois précédent, et les récurrences du jour n'étaient générées qu'au prochain déverrouillage.
   Ce contrôle détecte le changement de jour (au repos toutes les 15 s, et au retour sur l'application) et remet les écrans sur
   la période courante, une seule fois — la navigation volontaire dans un autre mois reste libre jusqu'au prochain changement. */
let lastSeenDay = todayISO();
let lastSeenMonthKey = currentMonthKey();
async function handleDayRollover() {
  const today = todayISO();
  if (today === lastSeenDay) return;
  lastSeenDay = today;
  if (currentMonthKey() !== lastSeenMonthKey) {
    lastSeenMonthKey = currentMonthKey();
    resetTransactionsMonth();
    resetBudgetsPeriod();
    resetReportsPeriod();
  }
  const appEl = document.getElementById('app');
  if (!appEl || appEl.hidden) return; // verrouillé : onUnlocked() s'en chargera
  // Récurrences du nouveau jour : propriétaire seulement (l'aidant ne peut pas écrire) ; sinon elles seront générées au prochain déverrouillage.
  if (appState.role === 'owner') { try { await generateDueRecurring(); } catch (err) { console.warn('[Récurrences]', err); } }
  VIEW_RENDERERS[appState.currentView]?.();
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

/* ---------- Bouton Retour (téléphone, geste, flèche de la barre du haut) — voir back-navigation.js ---------- */
const backController = createBackController({
  currentView: () => appState.currentView,
  goToView: (view) => navigateTo(view, { fromBack: true }),
  closeTopModal: () => {
    const root = document.getElementById('modal-root');
    const top = root && [...root.children].filter((el) => el.classList.contains('modal-backdrop')).pop();
    if (!top) return false;
    const closeBtn = top.querySelector('.modal-close');
    if (closeBtn) closeBtn.click(); else top.click(); // sans croix : un clic sur le fond (fermeture standard des fenêtres)
    return true;
  },
  isAppVisible: () => { const appEl = document.getElementById('app'); return !!appEl && !appEl.hidden; },
  onStartupBack: () => startupBack(),
  onExitWarning: () => showToast(t('Appuyez encore sur Retour pour quitter.')),
});
/** Retour du téléphone sur les écrans de démarrage (restauration, création du PIN) : même effet que leur bouton « Retour ». */
function startupBack() {
  const shown = (id) => { const el = document.getElementById(id); return !!el && !el.hidden; };
  if (shown('restore-screen')) {
    const button = document.querySelector('#restore-local-cancel, #restore-cloud-cancel, #restore-back-btn');
    if (button) { button.click(); return true; }
    return false;
  }
  const pinBack = document.getElementById('pin-back');
  if (shown('lock-screen') && pinBack && !pinBack.hidden) { pinBack.click(); return true; }
  return false;
}
let backTrapped = false;
/** Garde toujours une entrée d'historique « au-dessus » de la base : un retour la consomme au lieu de quitter l'application. */
function armBackTrap() {
  if (backTrapped) return;
  window.history.pushState({ djignan: 'top' }, '');
  backTrapped = true;
}
function initBackNavigation() {
  window.history.replaceState({ djignan: 'base' }, '');
  armBackTrap();
  window.addEventListener('popstate', () => {
    backTrapped = false; // le retour vient de consommer l'entrée « top »
    if (backController.handleBack()) armBackTrap(); // géré : on reste dans l'application, piège réarmé
  });
  document.addEventListener('djignan:modal-open', armBackTrap); // ex. après un « quitter » refusé, puis une fenêtre qui s'ouvre
  document.getElementById('topbar-back')?.addEventListener('click', () => { backController.handleBack(); });
}

function navigateTo(view, { fromBack = false } = {}) {
  if (!VIEW_RENDERERS[view]) return;
  if (!fromBack) { backController.visit(appState.currentView, view); armBackTrap(); }
  appState.currentView = view;
  const backBtn = document.getElementById('topbar-back');
  if (backBtn) backBtn.hidden = !backController.canGoBack();

  document.querySelectorAll('.view').forEach((el) => {
    const active = el.dataset.view === view;
    el.hidden = !active;
    el.classList.toggle('is-active', active);
  });
  document.querySelectorAll('[data-view-target]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.viewTarget === view);
  });
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = t(VIEW_TITLES[view] || '');

  VIEW_RENDERERS[view]();
  bus.emit(EVENTS.VIEW_CHANGED, view);
}

async function openMoreSheet() {
  const moduleStates = await Promise.all(OPTIONAL_MODULES.map(async (m) => [m.view, await getSetting(m.key, !!m.defaultEnabled)]));
  const disabledViews = new Set(moduleStates.filter(([, enabled]) => !enabled).map(([view]) => view));
  const simple = (await getUiMode()) === 'simple';
  // Mode simple : les écrans de base + les modules optionnels que l'utilisateur a lui-même activés.
  const simpleViews = [...SIMPLE_MORE_VIEWS.filter((v) => v !== 'settings'), ...OPTIONAL_MODULES.map((m) => m.view), 'settings'];
  const views = (simple ? simpleViews : MORE_VIEWS).filter((v) => !disabledViews.has(v));
  const modal = openModal(
    views.map((v) => `<button type="button" class="nav-item" style="width:100%;" data-view-target="${v}">${svgIcon(VIEW_ICONS[v] || 'tag', 20)}<span>${escapeHtml(t(VIEW_TITLES[v]))}</span></button>`).join('')
      + (simple ? `<button type="button" class="nav-item" style="width:100%;" data-switch-full>${escapeHtml(t('Passer en mode complet'))}</button>` : ''),
    { title: 'Plus' }
  );
  modal.el.querySelector('[data-switch-full]')?.addEventListener('click', async () => {
    await setUiMode('full');
    modal.close();
    VIEW_RENDERERS[appState.currentView]?.();
    showToast(t('Mode complet activé.'));
  });
  modal.el.querySelectorAll('[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => { navigateTo(btn.dataset.viewTarget); modal.close(); });
  });
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
}

function applyPrivacy(hidden) {
  document.body.dataset.privacy = hidden ? 'hidden' : 'visible';
  setAutoMasking(hidden);
  const toggle = document.getElementById('privacy-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', String(hidden));
    // L'étiquette dit ce que fera le toucher (avant : toujours « Masquer », même quand les montants étaient déjà cachés).
    const label = t(hidden ? 'Afficher les montants' : 'Masquer les montants');
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('title', label);
  }
}

function wireGlobalChrome() {
  document.querySelectorAll('[data-view-target]').forEach((el) => {
    el.addEventListener('click', () => navigateTo(el.dataset.viewTarget));
  });

  document.getElementById('bottom-nav-more')?.addEventListener('click', openMoreSheet);

  document.getElementById('quick-add-btn')?.addEventListener('click', () => openAddEntry(() => openQuickAdd()));
  document.getElementById('bottom-nav-add')?.addEventListener('click', () => openAddEntry(() => openQuickAdd()));

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
    showToast(t('Thème : {mode}', { mode: t({ auto: 'Automatique', light: 'Clair', dark: 'Sombre' }[appState.theme]) }));
    VIEW_RENDERERS[appState.currentView]?.();
  });

  document.getElementById('lock-now-btn')?.addEventListener('click', lockNow);

  ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll'].forEach((ev) => {
    document.addEventListener(ev, markActivity, { passive: true });
  });
  setInterval(() => { checkAutoLock(); handleDayRollover(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') handleDayRollover(); });

  bus.on(EVENTS.DATA_CHANGED, (scope) => {
    VIEW_RENDERERS[appState.currentView]?.();
    // scope 'all' = import/restauration (locale ou cloud) : peut avoir changé des réglages de
    // modules optionnels (ex: keptAccountsEnabled) sans passer par settings.js, qui applique déjà
    // la visibilité lui-même — sans ça le bouton de nav reste dans l'état d'avant l'import jusqu'au
    // prochain rechargement de page.
    if (scope === 'all') {
      applyOptionalModuleVisibility(); applyUiMode();
      // Une restauration peut avoir changé le réglage de l'accueil facile : on le réapplique avant de redessiner.
      applyEasyHome().then(() => { if (appState.currentView === 'dashboard') renderEasyHome(); });
    }
    scheduleNativeReminderSync();
  });
}

async function seedDefaultsIfNeeded() {
  const categories = await dbGetAll(STORES.CATEGORIES);
  if (categories.length === 0) {
    // t(c.name) : traduit le nom dans la langue courante SEULEMENT au moment de la création (un
    // nouvel utilisateur anglophone démarre avec "Food"/"Housing"...) — jamais après coup, une
    // catégorie déjà créée (par défaut ou renommée) ne doit jamais changer toute seule si la langue
    // change ensuite, voir i18n.js.
    for (const c of DEFAULT_CATEGORIES) {
      await dbAdd(STORES.CATEGORIES, { id: uuid(), parentId: null, createdAt: new Date().toISOString(), ...c, name: t(c.name) });
    }
  }
  const base = await getSetting('baseCurrency');
  if (!base) await setSetting('baseCurrency', 'EUR');
}

/** Rattrape les transactions de dette/créance dont la catégorie n'est pas (ou plus) à jour :
    - debtId sans categoryId (créées avant l'introduction de la catégorie dédiée) ;
    - categoryId pointant vers l'ancienne catégorie unique "Prêt et créance" (avant qu'elle soit
      scindée en "Prêt"/"Créance" selon le sens — voir debts.js DEBT_CATEGORY_NAMES).
    Nettoie ensuite les catégories "Prêt et créance" orphelines (plus aucune transaction NI budget
    ne les référence) pour ne pas laisser de catégories mortes dans Budgets > Catégories.
    Coût négligeable une fois la migration faite, donc appelée à chaque boot plutôt que gardée par
    un flag one-shot : plus robuste si de nouvelles transactions mal catégorisées apparaissaient
    pour une autre raison. Pas besoin de notifier/re-render ici : ceci tourne avant le
    déverrouillage, et onUnlocked() fait de toute façon un rendu complet et frais juste après. */
async function migrateDebtTransactionCategories() {
  const [transactions, categories, debts] = await Promise.all([
    dbGetAll(STORES.TRANSACTIONS),
    dbGetAll(STORES.CATEGORIES),
    dbGetAll(STORES.DEBTS),
  ]);
  const legacyCategoryIds = new Set(categories.filter((c) => c.name === LEGACY_DEBT_CATEGORY_NAME).map((c) => c.id));
  const toFix = transactions.filter((t) => t.debtId && (!t.categoryId || legacyCategoryIds.has(t.categoryId)));

  if (toFix.length) {
    const debtById = Object.fromEntries(debts.map((d) => [d.id, d]));
    for (const t of toFix) {
      const debt = debtById[t.debtId];
      if (!debt) continue; // dette supprimée entre-temps (ses transactions auraient dû l'être aussi) : rien de fiable à déduire, on laisse tel quel
      t.categoryId = await ensureDebtCategoryId(debt.type, t.type);
      await dbPut(STORES.TRANSACTIONS, t);
    }
  }

  if (legacyCategoryIds.size) {
    const [freshTransactions, budgets] = await Promise.all([dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.BUDGETS)]);
    const stillReferenced = new Set([...freshTransactions.map((t) => t.categoryId), ...budgets.map((b) => b.categoryId)]);
    for (const id of legacyCategoryIds) {
      if (!stillReferenced.has(id)) await dbDelete(STORES.CATEGORIES, id);
    }
  }
}

/** Applique ?view=X ou ?action=quick-add (raccourcis PWA déclarés dans manifest.json — appui
    long sur l'icône de l'app) une fois déverrouillé, puis nettoie l'URL pour ne pas rejouer
    l'action à chaque re-déverrouillage dans la même session. */
function applyShortcutParams() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const action = params.get('action');
  if (view && Object.hasOwn(VIEW_RENDERERS, view)) navigateTo(view);
  if (action === 'quick-add') openQuickAdd();
  if (view || action) window.history.replaceState({}, '', window.location.pathname);
}

// Même nom que côté sw.js (SHARE_TARGET_CACHE) — doit rester identique, c'est le SW qui écrit
// dans ce cache (à la réception d'un partage) et cette fonction qui le lit (au redémarrage).
const SHARE_TARGET_CACHE = 'share-target-cache';

/** Reçoit une photo partagée depuis une autre app (galerie, messagerie...) via le Web Share
    Target déclaré dans manifest.json : sw.js intercepte le POST entrant, met le fichier en cache
    et redirige vers ?share-target=1 — lu ici une fois déverrouillé, pour ouvrir Saisie express
    avec la photo déjà chargée dans l'OCR (montant/commerçant/date détectés automatiquement),
    encore plus rapide qu'un partage de justificatif classique depuis l'app elle-même. */
async function applyShareTarget() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('share-target') !== '1') return;
  window.history.replaceState({}, '', window.location.pathname);
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(SHARE_TARGET_CACHE);
    const textResponse = await cache.match('shared-text');
    if (textResponse) await cache.delete('shared-text');
    const response = await cache.match('shared-receipt');
    if (response) {
      await cache.delete('shared-receipt');
      openQuickAdd({ sharedReceiptBlob: await response.blob() });
      return;
    }
    // Texte partagé sans photo : le plus souvent un SMS Mobile Money transféré depuis la messagerie. Gardé en file d'attente
    // (sms-queue.js) pour ne pas être perdu si l'utilisateur ferme la fenêtre : le tableau de bord rappelle « N SMS à valider ».
    if (textResponse) {
      await queueSharedSms(await textResponse.text());
      notifyDataChanged('settings'); // fait apparaître le rappel du tableau de bord, même si la fenêtre est fermée sans importer
      openSmsImportModal();
    }
  } catch (err) {
    console.warn('[ShareTarget]', err);
  }
}

/** Bouton "Passer cette étape" commun à (presque) toutes les étapes de l'onboarding : avance
    sans rien enregistrer, laissant les valeurs par défaut déjà seedées (seedDefaultsIfNeeded)
    ou les réglages par défaut de chaque module en place. */
function skipStepButtonHtml() {
  return `<button type="button" class="btn btn-ghost btn-block mt-8" id="ob-skip">${t('Passer cette étape')}</button>`;
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

  // Nouvelle installation : mode simple par défaut (modifiable à la 1re étape et dans Paramètres).
  // Une installation existante n'arrive jamais ici : son affichage ne change pas tout seul.
  await setUiMode('simple');

  const steps = [
    {
      title: t('Comment voulez-vous utiliser Djignan ?'),
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${t("Vous pourrez changer à tout moment dans Paramètres.")}</p>
          <button type="button" class="btn btn-primary btn-block" id="ob-mode-simple" style="display:block;text-align:left;white-space:normal;height:auto;padding:12px 14px;">
            <strong>${t('Simple — comme un cahier')}</strong><br><span style="font-weight:400;" class="fs-13">${t('Entrées, sorties, solde, favoris, dettes et créances.')}</span>
          </button>
          <button type="button" class="btn btn-ghost btn-block mt-10" id="ob-mode-full" style="display:block;text-align:left;white-space:normal;height:auto;padding:12px 14px;">
            <strong>${t('Complet')}</strong><br><span style="font-weight:400;" class="fs-13">${t('Budgets, épargne, investissements, rapports, outils…')}</span>
          </button>
          <button type="button" class="btn btn-ghost btn-block mt-10" id="ob-mode-easy" style="display:block;text-align:left;white-space:normal;height:auto;padding:12px 14px;">
            <strong>${t('Très facile — gros boutons et voix')}</strong><br><span style="font-weight:400;" class="fs-13">${t('Quatre grosses touches, des images, et l\'appli peut vous lire votre solde à voix haute.')}</span>
          </button>`;
        el.querySelector('#ob-mode-easy').addEventListener('click', async () => {
          await setUiMode('simple');
          await setEasyHome(true);
          if (isSpeechSupported()) await setSetting('speakConfirmations', true);
          next();
        });
        el.querySelector('#ob-mode-simple').addEventListener('click', async () => { await setUiMode('simple'); next(); });
        el.querySelector('#ob-mode-full').addEventListener('click', async () => { await setUiMode('full'); next(); });
      },
    },
    {
      title: t('Bienvenue sur Djignan'),
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${t("Choisissez d'abord la devise dans laquelle suivre votre argent au quotidien — vous pourrez quand même créer des portefeuilles dans d'autres devises ensuite.")}</p>
          <form id="ob-currency-form">
            <div class="form-row">
              <label>${t('Devise principale')}</label>
              <select name="baseCurrency">${CURRENCIES.map((c) => `<option value="${c}" ${c === 'EUR' ? 'selected' : ''}>${c}</option>`).join('')}</select>
            </div>
            <button type="submit" class="btn btn-primary btn-block">${t('Continuer')}</button>
          </form>
          ${skipStepButtonHtml()}
          <button type="button" class="btn btn-ghost btn-block mt-8" id="ob-demo">${t("Découvrir avec des données d'exemple")}</button>`;
        el.querySelector('#ob-currency-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          await setSetting('baseCurrency', new FormData(e.target).get('baseCurrency'));
          next();
        });
        el.querySelector('#ob-skip').addEventListener('click', () => next());
        // Quitte tout l'assistant (pas juste cette étape) : un jeu de données fictif rend le
        // reste du parcours (créer SON portefeuille, SON profil...) sans objet. isDemoModeActive
        // fait apparaître un bandeau permanent pour repartir de zéro avant d'entrer de vraies
        // données — voir renderDemoModeBanner() et demo-data.js.
        el.querySelector('#ob-demo').addEventListener('click', async () => {
          await seedDemoData();
          modal.close();
          notifyDataChanged('all');
          renderDemoModeBanner();
          showToast(t('Données de démonstration chargées.'));
        });
      },
    },
    {
      title: t('Votre premier portefeuille'),
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${t('Créez votre premier portefeuille (compte bancaire, mobile money, espèces…) pour commencer à suivre vos finances.')}</p>
          <button type="button" class="btn btn-primary btn-block" id="ob-wallet-create">${t('Créer un portefeuille')}</button>
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
      title: t('Votre profil'),
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${t("Utilisé pour la salutation sur le tableau de bord et l'en-tête des rapports PDF. Reste 100% local, jamais transmis.")}</p>
          <form id="ob-profile-form">
            ${PROFILE_FIELDS.map((f) => `
              <div class="form-row">
                <label>${escapeHtml(t(f.label))}</label>
                <input type="${f.type}" name="${f.key}" maxlength="120">
              </div>`).join('')}
            <button type="submit" class="btn btn-primary btn-block">${t('Continuer')}</button>
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
      title: t('Personnalisez votre tableau de bord'),
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${t('Choisissez les panneaux affichés sur le tableau de bord (modifiable à tout moment dans Paramètres).')}</p>
          <form id="ob-dashboard-form">
            ${Object.entries(DASHBOARD_PANEL_LABELS).map(([key, label]) => `
              <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;" class="fs-14">
                <input type="checkbox" name="${key}" ${DASHBOARD_PANEL_DEFAULTS[key] ? 'checked' : ''}>
                ${escapeHtml(t(label))}
              </label>`).join('')}
            <button type="submit" class="btn btn-primary btn-block mt-10">${t('Continuer')}</button>
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
      title: t('Modules optionnels'),
      async render(el, { next }) {
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${t("Activez ce qui s'applique à votre usage (modifiable à tout moment dans Paramètres).")}</p>
          <form id="ob-modules-form">
            ${OPTIONAL_MODULES.map((mod) => `
              <label style="display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;" class="fs-14">
                <input type="checkbox" name="${mod.key}" ${mod.defaultEnabled ? 'checked' : ''}>
                ${escapeHtml(t(mod.label))}
              </label>
              <p style="margin:0 0 8px;" class="fs-12 c-muted">${escapeHtml(t(mod.description))}</p>`).join('')}
            <button type="submit" class="btn btn-primary btn-block">${t('Continuer')}</button>
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
      title: t('Sécurité'),
      async render(el, { next }) {
        const bioAvailable = await isBiometricAvailable();
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${bioAvailable ? t('Réglez le verrouillage automatique après inactivité et activez le déverrouillage biométrique.') : t('Réglez le verrouillage automatique après inactivité.')}</p>
          <div class="form-row">
            <label>${t('Verrouillage automatique après inactivité')}</label>
            <select id="ob-auto-lock">${AUTO_LOCK_OPTIONS.map(([v, l]) => `<option value="${v}">${escapeHtml(t(l))}</option>`).join('')}</select>
          </div>
          ${bioAvailable ? `<button type="button" class="btn btn-ghost btn-block mb-10" id="ob-bio-enable">${t('Activer le déverrouillage biométrique')}</button>` : ''}
          <button type="button" class="btn btn-primary btn-block" id="ob-continue">${t('Continuer')}</button>
          ${skipStepButtonHtml()}`;
        el.querySelector('#ob-bio-enable')?.addEventListener('click', async (e) => {
          try {
            await registerBiometric();
            showToast(t('Biométrie activée.'));
            e.target.textContent = t('Biométrie activée');
            e.target.disabled = true;
          } catch (err) {
            showToast(err.message || t("Échec de l'activation biométrique."));
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
      title: t('Notifications'),
      async render(el, { next }) {
        const supported = isNotificationSupported();
        el.innerHTML = `
          <p style="margin:0 0 16px;" class="fs-14 c-muted">${t('Rappels locaux pour vos budgets qui approchent leur limite, vos échéances proches et vos soldes bas.')}</p>
          ${supported
            ? `<button type="button" class="btn btn-primary btn-block" id="ob-notif-enable">${t('Activer les notifications')}</button>`
            : `<p class="empty-state" style="padding:8px 0;">${t('Non supportées par ce navigateur.')}</p>`}
          <button type="button" class="btn btn-ghost btn-block mt-10" id="ob-finish">${supported ? t('Passer, terminer') : t('Terminer')}</button>`;
        el.querySelector('#ob-notif-enable')?.addEventListener('click', async () => {
          const perm = await requestNotificationPermission();
          if (perm === 'granted') { showToast(t('Notifications activées.')); await checkAndNotify(); }
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
    body.innerHTML = `<p style="margin:0 0 12px;text-transform:uppercase;letter-spacing:.04em;" class="fs-11 c-faint">${t('Étape {n} / {total}', { n: index + 1, total: steps.length })}</p><div id="ob-step-content"></div>`;
    await step.render(body.querySelector('#ob-step-content'), { next });
    // « Retour » à l'étape précédente (avant : aucune étape ne pouvait être revue, une mauvaise devise restait choisie).
    if (index > 0) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'btn btn-ghost btn-block mt-8';
      back.id = 'ob-back';
      back.textContent = t('Retour');
      back.addEventListener('click', async () => { index = Math.max(0, index - 1); await renderStep(); });
      body.appendChild(back);
    }
  }
  async function next() {
    index++;
    if (index >= steps.length) {
      modal.close();
      notifyDataChanged('all'); // réglages posés pendant l'assistant (accueil facile, mode…) : on redessine, même sans portefeuille créé
      return;
    }
    await renderStep();
  }

  await renderStep();
}

/** Bandeau permanent affiché tant que isDemoModeActive est vrai (voir demo-data.js) — visible sur
    toutes les vues, pas seulement le tableau de bord, pour qu'il soit impossible de manquer qu'on
    explore des données fictives et pas ses propres finances. */
async function renderDemoModeBanner() {
  const container = document.getElementById('demo-mode-banner');
  if (!container) return;
  const active = await getSetting('isDemoModeActive', false);
  if (!active) { container.hidden = true; container.innerHTML = ''; return; }
  container.hidden = false;
  container.innerHTML = `
    <p class="alert alert-info m-0">
      ${t('Vous explorez des données de démonstration.')}
      <button type="button" class="btn btn-ghost ml-8" id="demo-clear-btn" style="padding:4px 10px;">${t('Effacer et commencer avec mes données')}</button>
    </p>`;
  container.querySelector('#demo-clear-btn').addEventListener('click', async () => {
    const ok = await confirmDialog(t('Effacer les données de démonstration et repartir de zéro ?'), { confirmText: t('Effacer'), danger: false });
    if (!ok) return;
    await clearDemoData();
    window.location.reload();
  });
}

/** Code d'activation optionnel (dépôt "pro" uniquement — voir activation-config.js), affiché avant
    même le choix de la langue, sur une toute première installation. Ne fait rien si
    REQUIRE_ACTIVATION_CODE est désactivé (dépôt gratuit) ou si cet appareil est déjà activé. La
    vérification par hash SHA-256 (Web Crypto, natif navigateur) n'est PAS une sécurité réelle — le
    hash de référence est visible dans le code source livré au client, donc retrouvable par une
    personne déterminée à lire le JS. C'est un filtre de distribution pratique, pas une protection
    cryptographique. */
async function showActivationCodeScreenIfNeeded() {
  if (!REQUIRE_ACTIVATION_CODE) return;
  if (await getSetting('activated', false)) return;
  return new Promise((resolve) => {
    const screen = document.getElementById('activation-screen');
    const lockScreen = document.getElementById('lock-screen');
    lockScreen.hidden = true;
    screen.hidden = false;
    const form = document.getElementById('activation-form');
    const input = document.getElementById('activation-code-input');
    const errorEl = document.getElementById('activation-error');
    input.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = input.value.trim().toUpperCase();
      if (!code) return;
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
      const hashHex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hashHex === ACTIVATION_CODE_HASH) {
        await setSetting('activated', true);
        errorEl.hidden = true;
        screen.hidden = true;
        lockScreen.hidden = false;
        resolve();
      } else {
        errorEl.hidden = false;
        input.value = '';
        input.focus();
      }
    });
  });
}

/** Affiché une seule fois, avant même l'écran de création du code PIN, sur une toute première
    installation uniquement (même garde que maybeShowOnboarding() : un PIN déjà configuré signifie
    que ce n'est pas une première installation, on ne redemande jamais après coup à un utilisateur
    existant). Résout une fois la langue choisie ; initI18n() est rappelé immédiatement pour que
    seedDefaultsIfNeeded() (juste après, dans boot()) crée les catégories par défaut dans la bonne
    langue — pas de rechargement de page, contrairement à setLanguage() (Paramètres). */
function showLanguageChoiceScreen() {
  return new Promise((resolve) => {
    const screen = document.getElementById('language-screen');
    const lockScreen = document.getElementById('lock-screen');
    lockScreen.hidden = true;
    screen.hidden = false;
    // L'écran peut être rouvert par « Retour » (depuis la restauration) : les deux écouteurs sont retirés ensemble dès qu'un choix est fait,
    // sinon celui du bouton non utilisé resterait et, au passage suivant, ferait réapparaître le mauvais écran.
    const listeners = new AbortController();
    async function choose(lang) {
      listeners.abort();
      await setSetting('language', lang);
      await initI18n();
      screen.hidden = true;
      lockScreen.hidden = false;
      resolve();
    }
    document.getElementById('language-choice-fr').addEventListener('click', () => choose('fr'), { signal: listeners.signal });
    document.getElementById('language-choice-en').addEventListener('click', () => choose('en'), { signal: listeners.signal });
  });
}

/** Affiché une seule fois, après le choix de la langue et avant la création du code PIN, sur une
    toute première installation uniquement (même garde que les écrans précédents). Propose de
    restaurer une sauvegarde (locale, prioritaire, ou cloud) plutôt que de repartir de zéro — pont
    de migration pour un utilisateur qui bascule depuis une autre installation (ex: GeoFinance vers
    Djignan). Nécessaire car le stockage du navigateur n'est PAS toujours partagé entre deux apps
    de la même origine : sur PC, GeoFinance et Djignan partagent la même IndexedDB (même origine
    zaky04.github.io, DB_NAME volontairement inchangé) donc les données de l'une apparaissent déjà
    dans l'autre sans rien faire — mais une PWA "Ajoutée à l'écran d'accueil" sur iOS reçoit un bac
    à sable de stockage totalement isolé PAR APP, même si les deux pointent vers la même origine :
    limite de plateforme WebKit, aucun moyen de la contourner en code. Les deux chemins de
    restauration excluent toujours le PIN de l'appareil source (DEVICE_LOCAL_SETTING_KEYS, db.js) :
    un nouveau code PIN reste à créer sur CET appareil quelle que soit l'option choisie, par
    conception (voir le correctif de sécurité du 13 août dans CLAUDE.md — un fichier de sauvegarde
    ne doit jamais pouvoir poser un PIN sur un nouvel appareil). */
function showRestoreScreenIfNeeded() {
  return new Promise((resolve) => {
    const screen = document.getElementById('restore-screen');
    const lockScreen = document.getElementById('lock-screen');
    const content = document.getElementById('restore-screen-content');

    function finish(outcome = 'done') {
      screen.hidden = true;
      lockScreen.hidden = false;
      resolve(outcome); // 'done' : on continue vers la création du PIN ; 'back' : on revient au choix de la langue
    }

    function renderLoading(message) {
      content.innerHTML = `
        <h1 class="lock-title">${t('Restauration en cours…')}</h1>
        <p class="lock-subtitle">${message}</p>`;
    }

    function renderChoice() {
      content.innerHTML = `
        <h1 class="lock-title">${t('Restaurer vos données ?')}</h1>
        <p class="lock-subtitle">${t('Si vous basculez depuis une autre installation (ex: GeoFinance), importez votre sauvegarde pour retrouver vos données et réglages sur cet appareil.')}</p>
        <div style="display:flex;flex-direction:column;gap:10px;width:100%;" class="mt-18">
          <button type="button" class="btn btn-primary btn-block" id="restore-local-btn">${t('Importer une sauvegarde locale')}</button>
          <button type="button" class="btn btn-ghost btn-block" id="restore-cloud-btn">${t('Restaurer depuis le cloud (Google)')}</button>
          <button type="button" class="btn btn-ghost btn-block" id="restore-skip-btn" style="opacity:.75;">${t('Configurer un nouveau compte')}</button>
          <button type="button" class="btn btn-ghost btn-block" id="restore-back-btn">${t('Retour')}</button>
        </div>`;
      content.querySelector('#restore-local-btn').addEventListener('click', renderLocalForm);
      content.querySelector('#restore-cloud-btn').addEventListener('click', startCloudSignIn);
      content.querySelector('#restore-skip-btn').addEventListener('click', () => finish('done'));
      content.querySelector('#restore-back-btn').addEventListener('click', () => finish('back'));
      // Précharge Google Identity Services + le SDK Firebase dès que ce bouton est visible, pas
      // seulement au clic : sur mobile, le délai réseau du chargement pouvait faire perdre le geste
      // utilisateur nécessaire à l'ouverture de la popup (voir warmUpGoogleSignIn(), firebase-sync.js).
      warmUpGoogleSignIn();
    }

    function renderLocalForm() {
      content.innerHTML = `
        <h1 class="lock-title">${t('Importer une sauvegarde locale')}</h1>
        <p class="lock-subtitle">${t('Sélectionnez le fichier de sauvegarde chiffrée (.json) et son mot de passe.')}</p>
        <form id="restore-local-form" style="width:100%;display:flex;flex-direction:column;gap:10px;" class="mt-18">
          <input type="file" id="restore-local-file" accept="application/json,.json" required>
          <input type="password" id="restore-local-passphrase" placeholder="${t('Mot de passe de chiffrement')}" required minlength="6" autocomplete="off">
          <p class="lock-error" id="restore-local-error" aria-live="assertive" hidden></p>
          <button type="submit" class="btn btn-primary btn-block">${t('Restaurer')}</button>
          <button type="button" class="btn btn-ghost btn-block" id="restore-local-cancel">${t('Retour')}</button>
        </form>`;
      const errorEl = content.querySelector('#restore-local-error');
      content.querySelector('#restore-local-cancel').addEventListener('click', renderChoice);
      content.querySelector('#restore-local-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = content.querySelector('#restore-local-file').files[0];
        const passphrase = content.querySelector('#restore-local-passphrase').value;
        if (!file) return;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        errorEl.hidden = true;
        try {
          // ignoreIntegrity : sur ce premier écran il n'y a aucun moyen de « confirmer » un écart, et le fichier chiffré est déjà authentifié par
          // son mot de passe (AES-GCM) : un écart d'empreinte ne pourrait venir que d'un défaut de l'appli, qui ne doit jamais bloquer une restauration.
          await importEncryptedBackup(file, passphrase, { merge: false, ignoreIntegrity: true });
          finish('done');
        } catch (err) {
          errorEl.textContent = err.message || t('Restauration impossible.');
          errorEl.hidden = false;
          submitBtn.disabled = false;
        }
      });
    }

    function renderCloudPassphraseForm() {
      content.innerHTML = `
        <h1 class="lock-title">${t('Restaurer depuis le cloud')}</h1>
        <p class="lock-subtitle">${t('Connecté. Entrez le mot de passe de chiffrement de votre sauvegarde cloud.')}</p>
        <form id="restore-cloud-form" style="width:100%;display:flex;flex-direction:column;gap:10px;" class="mt-18">
          <input type="password" id="restore-cloud-passphrase" placeholder="${t('Mot de passe de chiffrement')}" required minlength="6" autocomplete="off">
          <p class="lock-error" id="restore-cloud-error" aria-live="assertive" hidden></p>
          <button type="submit" class="btn btn-primary btn-block">${t('Restaurer')}</button>
          <button type="button" class="btn btn-ghost btn-block" id="restore-cloud-cancel">${t('Retour')}</button>
        </form>`;
      const errorEl = content.querySelector('#restore-cloud-error');
      content.querySelector('#restore-cloud-cancel').addEventListener('click', renderChoice);
      content.querySelector('#restore-cloud-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const passphrase = content.querySelector('#restore-cloud-passphrase').value;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        errorEl.hidden = true;
        try {
          const restored = await pullBackupFromCloud(passphrase, { merge: false });
          await setSetting('cloudBackupWasSignedIn', true);
          if (restored?.missingPhotos) showToast(restoreDoneMessage(restored), { duration: 9000 });
          finish('done');
        } catch (err) {
          errorEl.textContent = err.message || t('Restauration impossible.');
          errorEl.hidden = false;
          submitBtn.disabled = false;
        }
      });
    }

    async function startCloudSignIn() {
      renderLoading(t('Connexion à Google…'));
      try {
        await signInWithGoogle();
        await setSetting('cloudBackupWasSignedIn', true);
        renderCloudPassphraseForm();
      } catch (err) {
        renderChoice();
        showToast(t('Erreur : {message}', { message: err.message || t('connexion impossible.') }));
      }
    }

    lockScreen.hidden = true;
    screen.hidden = false;
    renderChoice();
  });
}

/** Ce que le propriétaire doit savoir à son retour : codes ratés pendant son absence, opérations saisies par l'aidant. */
async function showUnlockReport() {
  const report = await consumeUnlockReport();
  if (!report.since) return; // toute première visite : rien à comparer
  const sinceIso = new Date(report.since).toISOString();
  const helperEntries = (await dbGetAll(STORES.TRANSACTIONS)).filter((tx) => tx.enteredBy === 'helper' && (tx.createdAt || '') > sinceIso).length;
  if (!report.failures && !helperEntries) return;
  const when = (ts) => new Date(ts).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' });
  const lines = [];
  if (report.failures) lines.push(t('{count} code(s) incorrect(s) saisi(s) pendant votre absence, le dernier le {date}. Si ce n\'était pas vous, changez votre code PIN dans Paramètres.', { count: report.failures, date: when(report.lastFailureAt) }));
  if (helperEntries) lines.push(t('Votre aidant a saisi {count} opération(s).', { count: helperEntries }));
  const modal = openModal(`
    <ul class="unlock-report">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    <div class="modal-actions">
      ${helperEntries ? `<button type="button" class="btn btn-ghost" data-act="see">${escapeHtml(t('Voir les opérations'))}</button>` : ''}
      <button type="button" class="btn btn-primary" data-act="ok">${escapeHtml(t('OK'))}</button>
    </div>`, { title: t('Depuis votre dernière visite') });
  modal.el.querySelector('[data-act="ok"]').addEventListener('click', () => modal.close());
  modal.el.querySelector('[data-act="see"]')?.addEventListener('click', () => { modal.close(); navigateTo('transactions'); });
}

async function onUnlocked({ role = 'owner' } = {}) {
  // Le rôle côté interface est posé AVANT que l'appli soit montrée : sinon un aidant verrait un instant l'écran du propriétaire
  // (Paramètres encore affichés) avec ses droits, le temps des tâches ci-dessous.
  appState.role = role;
  document.body.dataset.role = role;
  document.getElementById('lock-screen').hidden = true;
  document.getElementById('app').hidden = false;
  markActivity();
  // Les tâches du système (récurrences échues…) s'exécutent toujours en « propriétaire » côté base : elles ne doivent ni être
  // refusées ni être attribuées à l'aidant. `finally` : même si elles échouent, la session reprend SON rôle (jamais de droits en trop).
  setAccessRole('owner');
  try { await generateDueRecurring(); } finally { setAccessRole(role); }
  // Mode discret : les montants sont masqués dès l'ouverture (dans le métro, au bureau…) — l'œil de la barre du haut
  // les réaffiche d'un geste. Non mémorisé : ça ne change pas le choix manuel enregistré pour les autres cas.
  if (await getSetting('privacyAutoHide', false)) { appState.privacyHidden = true; applyPrivacy(true); }
  navigateTo('dashboard');
  if (role === 'owner') showUnlockReport().catch((err) => console.warn('[Rapport de visite]', err));
  applyShortcutParams();
  await applyShareTarget();
  await renderDemoModeBanner();
  await maybeShowOnboarding();
  maybeShowInstallPrompt();
  checkAndNotify();
  // En premier parmi les invites au démarrage : avertir d'une sauvegarde cloud plus récente (risque
  // de doublons/données écrasées si l'utilisateur commence à saisir sur cet appareil) prime sur les
  // simples rappels de sauvegarde ci-dessous. checkCloudStaleness() ne charge le SDK Firebase que
  // pour un utilisateur déjà connecté au cloud (cloudBackupWasSignedIn) — jamais par défaut.
  // Toutes ces invites touchent aux sauvegardes (exporter, restaurer, envoyer dans le cloud) : réservées au propriétaire.
  // Un aidant (code aidant, db.js) ne les voit pas — et ne pourrait de toute façon pas restaurer.
  if (role === 'owner') {
    setTimeout(() => checkCloudStaleness(), 2000);
    setTimeout(() => checkWeeklyBackupReminder(), 4000); // décalé pour ne pas superposer les deux invites
    // Encore décalé par rapport au rappel local : si les deux sont dus le même jour, on ne veut pas
    // les empiler l'un sur l'autre. checkWeeklyCloudBackupReminder() ne charge le SDK Firebase que si
    // l'utilisateur clique "Sauvegarder maintenant" dans le rappel, jamais pour décider s'il s'affiche.
    setTimeout(() => checkWeeklyCloudBackupReminder(), 6000);
    // Une fois par mois au plus : la sauvegarde est-elle relisible et complète ? (échec visible sur le tableau de bord.)
    setTimeout(() => maybeRunMonthlyBackupCheck().then((result) => { if (result && !result.ok && appState.currentView === 'dashboard') renderDashboard(); }).catch((err) => console.warn('[Vérification de sauvegarde]', err)), 9000);
    // Entretien du journal d'audit (photos recopiées, plafond de lignes) : au repos, après les invites ci-dessus. Échec sans conséquence.
    setTimeout(() => maintainAuditLog().catch((err) => console.warn('[Journal d\'audit]', err)), 15000);
  }
  // Sauvegarde cloud automatique (opt-in) : n'écoute que les changements de données et ne charge le SDK
  // Firebase que si elle a été activée ET qu'il y a quelque chose à envoyer.
  initCloudAutoBackup();
  scheduleNativeReminderSync();
}

(async function boot() {
  try {
    // Réduit le risque que le navigateur évince l'IndexedDB sous pression de stockage
    // (silencieux sinon : la demande peut être refusée sans avertissement, mais ça ne
    // coûte rien de la faire — c'est le principal facteur de perte de données sur mobile).
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

    // Avant tout le reste : traduit immédiatement le châssis statique de l'app (menu, barre du
    // haut, bas de page mobile) et prépare t() pour tous les rendus JS qui suivent — sans ça, un
    // utilisateur en anglais verrait un flash de français le temps que le reste du boot s'exécute.
    await initI18n();
    // Le retour du téléphone doit déjà fonctionner sur les écrans de démarrage (langue, restauration, création du PIN) : piège et écouteur
    // sont donc posés AVANT eux (avant, le retour quittait la page dès le premier écran).
    initBackNavigation();

    // Code d'activation (dépôt pro uniquement), choix de la langue, puis proposition de restaurer
    // une sauvegarde — avant même la création du code PIN, sur une toute première installation
    // (jamais pour une install existante — voir les gardes dans showActivationCodeScreenIfNeeded()/
    // showLanguageChoiceScreen()/showRestoreScreenIfNeeded()). La langue n'est redemandée que si
    // elle n'est pas déjà enregistrée — robustesse générale si boot() devait un jour se relancer
    // avant la création du PIN pour une autre raison, pas de re-harceler inutilement.
    if (!(await isPinConfigured())) {
      await showActivationCodeScreenIfNeeded();
      // Langue → restauration → création du PIN, avec « Retour » d'une étape à la précédente (avant : aucune étape ne se revoyait).
      let stage = (await getSetting('language')) ? 'restore' : 'language';
      for (;;) {
        if (stage === 'language') await showLanguageChoiceScreen();
        if ((await showRestoreScreenIfNeeded()) !== 'back') break;
        stage = 'language';
      }
    }

    await seedDefaultsIfNeeded();
    await migrateDebtTransactionCategories();

    initDashboardModule();
    initCardActions();
    initPanels();
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
    initTontinesModule();
    initSettingsModule();
    initSearchModule();
    wireGlobalChrome();
    initEasyHome({ navigateTo, openDebts: openEasyDebts });

    appState.theme = await getSetting('theme', 'auto');
    applyTheme(appState.theme);
    appState.privacyHidden = await getSetting('privacyHidden', false);
    applyPrivacy(appState.privacyHidden);
    await applyOptionalModuleVisibility();
    await applyUiMode();
    await applyEasyHome();

    lockScreenApi = initLockScreen({ onUnlock: onUnlocked, onBackToStart: () => window.location.reload() }); // création du PIN : « Retour » rouvre la restauration (la langue choisie est gardée)
  } catch (err) {
    console.error('[Djignan] Échec critique au démarrage :', err);
    const lockScreen = document.getElementById('lock-screen');
    if (lockScreen) {
      lockScreen.innerHTML = `
        <div class="lock-card">
          <p class="lock-error">${t("Une erreur a empêché le démarrage de l'application. Rechargez la page ; si le problème persiste, essayez de vider le cache du navigateur pour ce site.")}</p>
        </div>`;
      lockScreen.hidden = false;
    }
  }
})();
