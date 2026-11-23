/* ==========================================================================
   Djignan Financial System — Écran d'accueil facile (gros boutons, images, voix)
   Pour qui lit peu, ou n'a jamais utilisé une appli de comptes : l'accueil devient quatre grosses
   touches (« J'ai reçu », « J'ai dépensé », « On me doit », « Je dois »), le solde en très gros avec un
   bouton « Écouter », et les dernières opérations. Rien d'autre.

   Saisie guidée en quelques touches, sans clavier de téléphone :
     combien ? (pavé numérique + billets/pièces qui s'additionnent) → pour quoi ? (images de catégories)
     → c'est bon ? (récapitulatif lu à voix haute, alerte si le montant est très au-dessus de l'habitude).
   Le portefeuille n'est demandé que s'il y en a plusieurs. L'enregistrement réutilise recordTemplateNow
   (quick-templates.js) : même transaction, même journal d'audit, annulable.

   Réglage `easyHome` (désactivé par défaut : une installation existante ne change JAMAIS toute seule).
   Affichage piloté en CSS par body[data-easy-home="on"] (voir la fin de styles.css) ; le contenu du
   panneau #easy-home est rendu ici. Les fonctions de pavé (keypadPress, addToAmount, quickAmounts) sont
   pures et testées hors navigateur.
   ========================================================================== */

import { STORES, dbGetAll, getSetting, setSetting } from './db.js';
import {
  computeNetWorthComposition, computeEndOfMonthForecast, computeBudgetVsActual, computeSafeToSpend,
  getWalletBalance, checkUnusualExpense, isDailyWallet, getEnrichedTransactions,
} from './ledger.js';
import { recordTemplateNow, undoRecordedTemplate, pastOrTodayISO } from './quick-templates.js';
import {
  isSpeechSupported, speak, stopSpeaking, primeSpeech, spokenAmount,
  buildBalanceSpeech, buildSavedSpeech, buildConfirmSpeech, buildTransferSavedSpeech, buildTransferConfirmSpeech, buildMonthSpeech, isSpeakConfirmationsEnabled,
} from './speech-out.js';
import { loadMonthlyRecap } from './monthly-recap.js';
import { formatCurrency, formatDate, escapeHtml, openModal, showToast, intlLocale, todayISO, localISODate, compressImageBlob, ZERO_DECIMAL_CURRENCIES } from './utils.js';
import { notifyDataChanged } from './state.js';
import { t, getLanguage } from './i18n.js';
import { isVoiceSupported, listenOnce } from './voice-input.js';
import { icon, categoryLook } from './icons.js';

/* ---------- Pavé numérique (fonctions pures) ---------- */

const MAX_INTEGER_DIGITS = 10;

/** Applique une touche du pavé à la saisie (une chaîne : « 2500 », « 12.5 »). Touches : '0'-'9', '00', '000',
    '.', 'back', 'clear'. Jamais de zéro en tête, au plus 2 décimales (si `allowDecimal`), au plus 10 chiffres. */
export function keypadPress(value, key, { allowDecimal = false } = {}) {
  const current = String(value || '');
  if (key === 'clear') return '';
  if (key === 'back') return current.slice(0, -1);
  if (key === '.') {
    if (!allowDecimal || current.includes('.')) return current;
    return current === '' ? '0.' : `${current}.`;
  }
  if (!/^\d{1,3}$/.test(key)) return current;
  const [whole, decimals] = current.split('.');
  if (decimals !== undefined) {
    return decimals.length + key.length > 2 ? current : `${current}${key}`;
  }
  const next = `${whole}${key}`.replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(next)) return ''; // on ne garde pas un « 0 » seul : l'affichage montre déjà zéro
  return next.length > MAX_INTEGER_DIGITS ? current : next;
}

/** Ajoute un billet/une pièce au montant saisi (« 5 000 » touché deux fois = 10 000). Renvoie la nouvelle saisie. */
export function addToAmount(value, add) {
  const sum = Math.round(((Number(value) || 0) + (Number(add) || 0)) * 100) / 100;
  if (!(sum > 0) || sum >= 10 ** MAX_INTEGER_DIGITS) return String(value || '');
  return String(sum);
}

/** Billets et pièces proposés selon la devise : francs CFA (sans centimes) ou devise à centimes. */
export function quickAmounts(currency) {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? [100, 500, 1000, 2000, 5000, 10000] : [1, 5, 10, 20, 50, 100];
}

/* ---------- Réglage ---------- */

export async function isEasyHomeEnabled() {
  return !!(await getSetting('easyHome', false));
}

/** Pose l'attribut CSS et montre/cache le panneau. À rappeler après tout changement du réglage. */
export async function applyEasyHome() {
  const on = await isEasyHomeEnabled();
  document.body.dataset.easyHome = on ? 'on' : 'off';
  const panel = document.getElementById('easy-home');
  if (panel) panel.hidden = !on;
  return on;
}

export async function setEasyHome(on) {
  await setSetting('easyHome', !!on);
  return applyEasyHome();
}

/* ---------- Chiffres de l'accueil ---------- */

/** Ce que l'accueil montre et ce que « Écouter » lit : un seul calcul pour les deux, donc jamais d'écart. */
export async function loadEasySnapshot() {
  const composition = await computeNetWorthComposition();
  let safeToSpend = null;
  try {
    const [forecast, budgetRows] = await Promise.all([computeEndOfMonthForecast(), computeBudgetVsActual()]);
    safeToSpend = computeSafeToSpend(forecast, budgetRows).safeToSpend;
  } catch (err) {
    console.warn('[Accueil facile] reste à vivre indisponible', err); // on lit le solde quand même
  }
  return { liquid: composition.liquid, safeToSpend, receivables: composition.receivables, debts: composition.debts, currency: composition.currency };
}

export async function speakBalance() {
  primeSpeech();
  if (!isSpeechSupported()) { showToast(t("La lecture à voix haute n'est pas disponible sur cet appareil.")); return; }
  const spoken = await speak(buildBalanceSpeech(await loadEasySnapshot()));
  if (!spoken) showToast(t("Aucune voix n'est installée sur cet appareil : le texte reste affiché."));
}

/** « Écouter mon mois » : le bilan du mois en cours (monthly-recap.js) lu à voix haute. */
export async function speakMonth() {
  primeSpeech();
  if (!isSpeechSupported()) { showToast(t("La lecture à voix haute n'est pas disponible sur cet appareil.")); return; }
  const spoken = await speak(buildMonthSpeech(await loadMonthlyRecap(todayISO().slice(0, 7))));
  if (!spoken) showToast(t("Aucune voix n'est installée sur cet appareil : le texte reste affiché."));
}

/* ---------- Accueil ---------- */

function recentRowHtml(tx) {
  const isTransfer = tx.type === 'transfer';
  const title = isTransfer ? `${tx.wallet?.name || '—'} → ${tx.targetWallet?.name || '—'}` : (tx.category?.name || t('Sans catégorie'));
  const look = isTransfer ? { icon: 'swap', color: 'var(--accent)' } : categoryLook(tx.category);
  const sign = tx.type === 'income' ? '+' : tx.type === 'expense' ? '−' : '';
  const cls = tx.type === 'income' ? 'pos' : tx.type === 'expense' ? 'neg' : '';
  return `
    <div class="easy-recent-row">
      <span class="easy-recent-icon" style="color:${look.color};">${icon(look.icon, 24)}</span>
      <span class="easy-recent-title">${escapeHtml(title)}</span>
      <span class="easy-recent-amount amount ${cls}" data-value="${tx.amount}">${sign}${escapeHtml(formatCurrency(tx.amount, tx.wallet?.currency || 'EUR'))}</span>
    </div>`;
}

export async function renderEasyHome() {
  const host = document.getElementById('easy-home');
  if (!host || host.hidden) return;
  const [snap, recent] = await Promise.all([loadEasySnapshot(), getEnrichedTransactions({ limit: 3 })]);
  const cur = snap.currency;
  const speakBtn = isSpeechSupported()
    ? `<div class="easy-speak-row"><button type="button" class="easy-speak" id="easy-speak-btn">${icon('speaker', 28)}<span>${t('Écouter')}</span></button>
      <button type="button" class="easy-speak" id="easy-month-btn">${icon('chart', 28)}<span>${t('Mon mois')}</span></button></div>` : '';
  const safeLine = snap.safeToSpend === null ? ''
    : snap.safeToSpend >= 0
      ? `<div class="easy-balance-sub">${t("Il vous reste {amount} à dépenser ce mois-ci", { amount: `<span class="amount" data-value="${snap.safeToSpend}">${escapeHtml(formatCurrency(snap.safeToSpend, cur))}</span>` })}</div>`
      : `<div class="easy-balance-sub is-bad">${t('Attention : dépenses prévues au-dessus de votre argent')}</div>`;
  host.innerHTML = `
    <div class="easy-balance">
      <div class="easy-balance-label">${t("J'ai en tout")}</div>
      <div class="easy-balance-value amount" data-value="${snap.liquid}">${escapeHtml(formatCurrency(snap.liquid, cur))}</div>
      ${safeLine}
      ${speakBtn}
    </div>
    <div class="easy-tiles">
      <button type="button" class="easy-tile easy-in" data-easy="income">${icon('arrowDown', 44)}<span class="easy-tile-label">${t("J'ai reçu")}</span></button>
      <button type="button" class="easy-tile easy-out" data-easy="expense">${icon('arrowUp', 44)}<span class="easy-tile-label">${t("J'ai dépensé")}</span></button>
      <button type="button" class="easy-tile easy-owed" data-easy="owed">${icon('people', 44)}<span class="easy-tile-label">${t('On me doit')}</span><span class="easy-tile-amount amount" data-value="${snap.receivables}">${escapeHtml(formatCurrency(snap.receivables, cur))}</span></button>
      <button type="button" class="easy-tile easy-owe" data-easy="owe">${icon('ledger', 44)}<span class="easy-tile-label">${t('Je dois')}</span><span class="easy-tile-amount amount" data-value="${snap.debts}">${escapeHtml(formatCurrency(snap.debts, cur))}</span></button>
    </div>
    <button type="button" class="btn btn-ghost easy-move" data-easy="transfer">${icon('swap', 28)} <span>${t("Je déplace de l'argent")}</span></button>
    ${recent.length ? `<h3 class="easy-section-title">${t('Dernières opérations')}</h3><div class="easy-recent">${recent.map(recentRowHtml).join('')}</div>` : ''}`;
}

/* ---------- Saisie guidée ---------- */

/** Date locale d'il y a `back` jours (AAAA-MM-JJ). */
function isoDaysAgo(back) {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return localISODate(d);
}
/** « Aujourd'hui », « Hier », « Avant-hier » (écrits en toutes lettres). */
function dayLabel(back) { return back === 0 ? t("Aujourd'hui") : back === 1 ? t('Hier') : t('Avant-hier'); }

const KEYPAD_ROWS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Ouvre la saisie guidée pour une dépense ou une recette. */
export async function openEasyEntry(type) {
  primeSpeech(); // dans le geste du clic, avant tout await (voir primeSpeech)
  const [allWallets, allCategories, allTx] = await Promise.all([dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES), dbGetAll(STORES.TRANSACTIONS)]);
  const isTransfer = type === 'transfer';
  // Déplacer de l'argent : tous les portefeuilles non archivés (l'épargne aussi), mais seulement vers un autre de la MÊME devise.
  const pool = allWallets.filter((w) => !w.archived);
  const peersOf = (w) => pool.filter((o) => o.id !== w.id && o.currency === w.currency);
  const wallets = isTransfer ? pool.filter((w) => peersOf(w).length > 0) : allWallets.filter(isDailyWallet);
  if (!wallets.length) {
    showToast(isTransfer
      ? t("Pour déplacer de l'argent, il faut deux portefeuilles dans la même devise (menu Plus, puis Portefeuilles).")
      : t("Créez d'abord un portefeuille (menu Plus, puis Portefeuilles)."));
    return;
  }

  // Le portefeuille le plus utilisé récemment passe en premier.
  const lastUse = new Map();
  for (const tx of allTx) if (tx.walletId && (tx.date || '') >= (lastUse.get(tx.walletId) || '')) lastUse.set(tx.walletId, tx.date || '');
  wallets.sort((a, b) => (lastUse.get(b.id) || '').localeCompare(lastUse.get(a.id) || ''));

  // Catégories les plus utilisées d'abord (120 derniers jours ≈ la saisie la plus courante).
  const usage = new Map();
  for (const tx of allTx) if (tx.type === type && tx.categoryId) usage.set(tx.categoryId, (usage.get(tx.categoryId) || 0) + 1);
  const categories = allCategories.filter((c) => c.type === type && !c.parentId)
    .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || a.name.localeCompare(b.name));

  const state = { step: (wallets.length > 1 || isTransfer) ? 'wallet' : 'amount', walletId: wallets[0].id, targetId: null, amount: '', categoryId: null, note: '', date: todayISO(), photo: null, photoUrl: '' };
  const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // même plafond que le partage entrant (sw.js) : au-delà, la photo n'est pas gardée
  const setPhoto = (blob) => { if (state.photoUrl) URL.revokeObjectURL(state.photoUrl); state.photo = blob; state.photoUrl = blob ? URL.createObjectURL(blob) : ''; };
  const wallet = () => wallets.find((w) => w.id === state.walletId);
  const currency = () => wallet().currency;
  const allowDecimal = () => !ZERO_DECIMAL_CURRENCIES.has(currency());
  const target = () => pool.find((w) => w.id === state.targetId) || null;
  const title = isTransfer ? t("Je déplace de l'argent") : type === 'income' ? t("J'ai reçu de l'argent") : t("J'ai dépensé de l'argent");

  const modal = openModal('<div id="easy-step"></div>', { title, onClose: () => { stopSpeaking(); setPhoto(null); } });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  const stepEl = modal.el.querySelector('#easy-step');

  function stepDots() {
    const order = isTransfer ? ['wallet', 'target', 'amount', 'confirm'] : wallets.length > 1 ? ['wallet', 'amount', 'category', 'confirm'] : ['amount', 'category', 'confirm'];
    return `<div class="easy-dots" aria-hidden="true">${order.map((s) => `<span class="${s === state.step ? 'is-current' : (order.indexOf(s) < order.indexOf(state.step) ? 'is-done' : '')}"></span>`).join('')}</div>`;
  }

  function render() {
    stepEl.innerHTML = stepDots() + `<div id="easy-body"></div>`;
    const body = stepEl.querySelector('#easy-body');
    if (state.step === 'wallet') renderWalletStep(body);
    else if (state.step === 'target') renderTargetStep(body);
    else if (state.step === 'amount') renderAmountStep(body);
    else if (state.step === 'category') renderCategoryStep(body);
    else renderConfirmStep(body);
  }
  const go = (step) => { stopSpeaking(); state.step = step; render(); };

  function renderWalletStep(body) {
    body.innerHTML = `
      <p class="easy-question">${isTransfer ? t("D'où part l'argent ?") : t('Sur quel portefeuille ?')}</p>
      <div class="easy-wallets">
        ${wallets.map((w) => `<button type="button" class="easy-wallet" data-wallet="${escapeHtml(w.id)}">${icon(w.type === 'mobile_money' ? 'phone' : w.type === 'cash' ? 'banknote' : w.type === 'bank' ? 'bank' : 'wallet', 30)}<span class="easy-wallet-name">${escapeHtml(w.name)}</span><span class="easy-wallet-cur">${escapeHtml(w.currency)}</span></button>`).join('')}
      </div>`;
    body.querySelectorAll('[data-wallet]').forEach((btn) => btn.addEventListener('click', () => {
      if (state.walletId !== btn.dataset.wallet) state.amount = ''; // la devise peut changer : on repart d'un montant vide
      state.walletId = btn.dataset.wallet;
      if (isTransfer) {
        if (state.targetId && !peersOf(wallet()).some((o) => o.id === state.targetId)) state.targetId = null; // l'ancienne destination n'est plus possible
        go('target');
        return;
      }
      go('amount');
    }));
  }

  /** Déplacement : vers quel portefeuille ? (seulement ceux de la même devise que celui d'où part l'argent) */
  function renderTargetStep(body) {
    const peers = peersOf(wallet());
    body.innerHTML = `
      <p class="easy-question">${t("Où va l'argent ?")}</p>
      <div class="easy-wallets">
        ${peers.map((w) => `<button type="button" class="easy-wallet" data-target="${escapeHtml(w.id)}">${icon(w.type === 'mobile_money' ? 'phone' : w.type === 'cash' ? 'banknote' : w.type === 'bank' ? 'bank' : 'wallet', 30)}<span class="easy-wallet-name">${escapeHtml(w.name)}</span><span class="easy-wallet-cur">${escapeHtml(w.currency)}</span></button>`).join('')}
      </div>
      <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-back">${t('Retour')}</button></div>`;
    body.querySelectorAll('[data-target]').forEach((btn) => btn.addEventListener('click', () => { state.targetId = btn.dataset.target; go('amount'); }));
    body.querySelector('#easy-back').addEventListener('click', () => go('wallet'));
  }

  function renderAmountStep(body) {
    const keys = [...KEYPAD_ROWS, allowDecimal() ? '.' : '000', '0', 'back'];
    body.innerHTML = `
      <p class="easy-question">${t('Combien ?')}</p>
      <div class="easy-amount" aria-live="polite"><span id="easy-amount-num"></span></div>
      <div class="easy-amount-words" id="easy-amount-words"></div>
      <div class="easy-quick" aria-label="${escapeHtml(t('Billets et pièces'))}">
        ${quickAmounts(currency()).map((n) => `<button type="button" class="easy-quick-btn" data-add="${n}" aria-label="${escapeHtml(t('Ajouter {amount}', { amount: spokenAmount(n, currency()) }))}">+ ${escapeHtml(n.toLocaleString(intlLocale()))}</button>`).join('')}
      </div>
      <div class="easy-keypad">
        ${keys.map((k) => `<button type="button" class="easy-key ${k === 'back' ? 'is-back' : ''}" data-key="${k}" ${k === 'back' ? `aria-label="${escapeHtml(t('Effacer le dernier chiffre'))}"` : ''}>${k === 'back' ? icon('backspace', 26) : k === '.' ? (getLanguage() === 'en' ? '.' : ',') : k}</button>`).join('')}
      </div>
      <div class="easy-actions">
        ${isSpeechSupported() ? `<button type="button" class="btn btn-ghost easy-btn" id="easy-say">${icon('speaker', 22)} ${t('Écouter')}</button>` : ''}
        <button type="button" class="btn btn-ghost easy-btn" id="easy-clear">${t('Tout effacer')}</button>
        <button type="button" class="btn btn-primary easy-btn easy-next" id="easy-next">${t('Suivant')} ${icon('chevron', 20)}</button>
      </div>`;
    const numEl = body.querySelector('#easy-amount-num');
    const wordsEl = body.querySelector('#easy-amount-words');
    const nextBtn = body.querySelector('#easy-next');
    const sayBtn = body.querySelector('#easy-say');
    function refresh() {
      const n = Number(state.amount) || 0;
      numEl.textContent = formatCurrency(n, currency());
      wordsEl.textContent = n > 0 ? spokenAmount(n, currency()) : '';
      nextBtn.disabled = !(n > 0);
      if (sayBtn) sayBtn.disabled = !(n > 0);
    }
    body.querySelectorAll('[data-key]').forEach((btn) => btn.addEventListener('click', () => {
      state.amount = keypadPress(state.amount, btn.dataset.key, { allowDecimal: allowDecimal() });
      refresh();
    }));
    body.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', () => {
      state.amount = addToAmount(state.amount, Number(btn.dataset.add));
      refresh();
    }));
    body.querySelector('#easy-clear').addEventListener('click', () => { state.amount = keypadPress(state.amount, 'clear'); refresh(); });
    sayBtn?.addEventListener('click', () => { primeSpeech(); speak(spokenAmount(Number(state.amount) || 0, currency())); });
    nextBtn.addEventListener('click', () => go(isTransfer ? 'confirm' : 'category')); // un déplacement n'a pas de catégorie
    refresh();
  }

  function renderCategoryStep(body) {
    const tile = (id, label, look) => `
      <button type="button" class="easy-cat" data-cat="${escapeHtml(id)}" style="--cat:${look.color};">
        <span class="easy-cat-icon">${icon(look.icon, 34)}</span><span class="easy-cat-name">${escapeHtml(label)}</span>
      </button>`;
    body.innerHTML = `
      <p class="easy-question">${type === 'income' ? t("D'où vient cet argent ?") : t('Pour quoi ?')}</p>
      <div class="easy-cats">
        ${categories.map((c) => tile(c.id, c.name, categoryLook(c))).join('')}
        ${tile('', t('Autre chose'), { icon: 'more', color: 'var(--text-muted)' })}
      </div>
      <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-back">${t('Retour')}</button></div>`;
    body.querySelectorAll('[data-cat]').forEach((btn) => btn.addEventListener('click', () => {
      state.categoryId = btn.dataset.cat || null;
      go('confirm');
    }));
    body.querySelector('#easy-back').addEventListener('click', () => go('amount'));
  }

  function renderConfirmStep(body) {
    const n = Number(state.amount) || 0;
    const cat = categories.find((c) => c.id === state.categoryId) || null;
    const catName = cat ? cat.name : t('Autre chose');
    const look = cat ? categoryLook(cat) : { icon: 'more', color: 'var(--text-muted)' };
    body.innerHTML = `
      <p class="easy-question">${t("C'est bon ?")}</p>
      <div class="easy-summary">
        <div class="easy-summary-kind ${isTransfer ? '' : type === 'income' ? 'pos' : 'neg'}">${isTransfer ? `${icon('swap', 30)} ${t('Déplacé')}` : `${icon(type === 'income' ? 'arrowDown' : 'arrowUp', 30)} ${type === 'income' ? t('Reçu') : t('Dépensé')}`}</div>
        <div class="easy-summary-amount amount" data-value="${n}">${escapeHtml(formatCurrency(n, currency()))}</div>
        <div class="easy-summary-words">${escapeHtml(spokenAmount(n, currency()))}</div>
        ${isTransfer
          ? `<div class="easy-summary-line">${icon('wallet', 22)} ${escapeHtml(t('De {name}', { name: wallet().name }))}</div>
        <div class="easy-summary-line">${icon('wallet', 22)} ${escapeHtml(t('Vers {name}', { name: target() ? target().name : '' }))}</div>`
          : `<div class="easy-summary-line"><span style="color:${look.color};">${icon(look.icon, 22)}</span> ${escapeHtml(catName)}</div>
        <div class="easy-summary-line">${icon('wallet', 22)} ${escapeHtml(wallet().name)}</div>`}
      </div>
      <div class="easy-date" role="group" aria-label="${escapeHtml(t('Quel jour ?'))}">
        <span class="easy-note-label">${t('Quel jour ?')}</span>
        <div class="easy-date-row">
          ${[0, 1, 2].map((back) => { const iso = isoDaysAgo(back); return `<button type="button" class="btn easy-day ${state.date === iso ? 'is-on' : 'btn-ghost'}" data-day="${iso}" aria-pressed="${state.date === iso}">${escapeHtml(dayLabel(back))}</button>`; }).join('')}
          <button type="button" class="btn easy-day ${[0, 1, 2].some((b) => isoDaysAgo(b) === state.date) ? 'btn-ghost' : 'is-on'}" id="easy-day-other" aria-pressed="${![0, 1, 2].some((b) => isoDaysAgo(b) === state.date)}">${escapeHtml(![0, 1, 2].some((b) => isoDaysAgo(b) === state.date) ? formatDate(state.date) : t('Autre jour'))}</button>
        </div>
        <input type="date" id="easy-day-input" class="easy-day-input" max="${todayISO()}" value="${state.date}" hidden aria-label="${escapeHtml(t('Choisir le jour'))}">
      </div>
      <div class="easy-extras ${isTransfer ? 'is-single' : ''}">
      <div class="easy-note">
        <button type="button" class="btn btn-ghost easy-btn" id="easy-note-toggle" ${state.note ? 'hidden' : ''}>${icon('edit', 22)} ${t('Ajouter une note')}</button>
        <div class="easy-note-box" id="easy-note-box" ${state.note ? '' : 'hidden'}>
          <label class="easy-note-label" for="easy-note-input">${t('Note (facultatif)')}</label>
          <div class="easy-note-row">
            <input type="text" id="easy-note-input" maxlength="140" value="${escapeHtml(state.note)}" placeholder="${escapeHtml(t('Ex : taxi, marché, cadeau…'))}" autocomplete="off">
            ${isVoiceSupported() ? `<button type="button" class="btn btn-ghost easy-btn easy-mic" id="easy-note-mic" aria-pressed="false" aria-label="${escapeHtml(t('Dicter la note'))}">${icon('mic', 26)}</button>` : ''}
          </div>
        </div>
      </div>
      ${isTransfer ? '' : `<div class="easy-photo">
        <button type="button" class="btn btn-ghost easy-btn" id="easy-photo-toggle" ${state.photo ? 'hidden' : ''}>${icon('receipt', 22)} ${t('Ajouter une photo')}</button>
        <input type="file" id="easy-photo-input" accept="image/*" capture="environment" hidden>
        <div class="easy-photo-box" id="easy-photo-box" ${state.photo ? '' : 'hidden'}>
          <img id="easy-photo-img" alt="${escapeHtml(t('Photo du justificatif'))}" src="${escapeHtml(state.photoUrl)}">
          <button type="button" class="btn btn-ghost easy-btn" id="easy-photo-remove">${icon('trash', 20)} ${t('Retirer la photo')}</button>
        </div>
      </div>`}
      </div>
      <div class="easy-warning" id="easy-warning" hidden></div>
      <div class="easy-actions easy-actions-stack">
        <button type="button" class="btn easy-btn easy-save" id="easy-save">${icon('check', 28)} ${t('Oui, enregistrer')}</button>
        <div class="easy-actions">
          ${isSpeechSupported() ? `<button type="button" class="btn btn-ghost easy-btn" id="easy-say">${icon('speaker', 22)} ${t('Écouter')}</button>` : ''}
          <button type="button" class="btn btn-ghost easy-btn" id="easy-fix">${t('Corriger')}</button>
        </div>
      </div>`;

    // Avertissements, purement informatifs (rien n'empêche d'enregistrer) :
    //  - montant très au-dessus de l'habitude de la catégorie : le cas typique d'un zéro de trop ;
    //  - dépense supérieure à ce que contient le portefeuille.
    const addWarning = (text) => {
      const warnEl = body.querySelector('#easy-warning');
      if (!warnEl?.isConnected) return; // l'utilisateur a déjà changé d'étape
      const line = document.createElement('p');
      line.textContent = text;
      warnEl.appendChild(line);
      warnEl.hidden = false;
    };
    if (type === 'expense' || isTransfer) {
      getWalletBalance(state.walletId).then((balance) => {
        if (n > balance + 0.005) {
          addWarning(t(isTransfer ? "Attention : {wallet} ne contient que {balance}. Ce déplacement le ferait passer en négatif." : "Attention : {wallet} ne contient que {balance}. Cette dépense le ferait passer en négatif.", { wallet: wallet().name, balance: formatCurrency(Math.max(balance, 0), currency()) }));
        }
      }).catch(() => {});
      if (!isTransfer && state.categoryId) {
        checkUnusualExpense(state.categoryId, n, state.walletId).then((unusual) => {
          if (!unusual) return;
          addWarning(t("Attention : c'est environ {ratio} fois plus que d'habitude pour « {category} » (en moyenne {average}). Vérifiez le montant.", {
            ratio: Math.round(unusual.ratio), category: catName, average: formatCurrency(unusual.average, unusual.currency),
          }));
        }).catch(() => {});
      }
    }

    body.querySelector('#easy-say')?.addEventListener('click', () => {
      primeSpeech();
      speak(isTransfer
        ? buildTransferConfirmSpeech({ amount: n, currency: currency(), fromName: wallet().name, toName: target() ? target().name : '' })
        : buildConfirmSpeech({ type, amount: n, currency: currency(), categoryName: cat ? cat.name : '', walletName: wallet().name }));
    });
    // Jour de l'opération : aujourd'hui par défaut ; hier, avant-hier, ou un autre jour (jamais dans le futur). On note souvent en fin de journée,
    // ou le lendemain : sans ça, la dépense d'hier était enregistrée à la date d'aujourd'hui.
    const dayInput = body.querySelector('#easy-day-input');
    const chooseDay = (iso) => { state.date = pastOrTodayISO(iso); renderConfirmStep(body); };
    body.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => chooseDay(b.dataset.day)));
    body.querySelector('#easy-day-other').addEventListener('click', () => { dayInput.hidden = false; if (dayInput.showPicker) { try { dayInput.showPicker(); } catch { dayInput.focus(); } } else dayInput.focus(); });
    dayInput.addEventListener('change', () => { if (dayInput.value) chooseDay(dayInput.value); });
    // Photo facultative du justificatif (ticket, facture) : prise avec l'appareil photo ou choisie dans la galerie, réduite avant d'être gardée.
    // Comme la note, elle reste si l'on change le jour ou corrige le montant, et rien n'apparaît pour qui n'en veut pas.
    const photoInput = body.querySelector('#easy-photo-input');
    body.querySelector('#easy-photo-toggle')?.addEventListener('click', () => photoInput.click());
    photoInput?.addEventListener('change', async () => {
      const file = photoInput.files[0];
      photoInput.value = '';
      if (!file) return;
      if (!file.type.startsWith('image/')) { showToast(t("Ce fichier n'est pas une photo.")); return; }
      if (file.size > MAX_PHOTO_BYTES) { showToast(t('Cette photo est trop lourde (15 Mo au plus).')); return; }
      try { setPhoto(await compressImageBlob(file)); } catch { showToast(t('Impossible de lire cette photo.')); return; }
      if (body.isConnected) { renderConfirmStep(body); body.querySelector('#easy-photo-box')?.scrollIntoView?.({ block: 'nearest' }); } // l'aperçu ne doit pas rester sous le bouton « Enregistrer »
    });
    body.querySelector('#easy-photo-remove')?.addEventListener('click', () => { setPhoto(null); renderConfirmStep(body); });
    // Note facultative : au clavier, ou dictée (micro) pour qui n'écrit pas facilement. Gardée si l'on corrige le montant puis revient ici.
    const noteInput = body.querySelector('#easy-note-input');
    body.querySelector('#easy-note-toggle').addEventListener('click', (e) => {
      e.currentTarget.hidden = true;
      body.querySelector('#easy-note-box').hidden = false;
      noteInput.focus();
      body.querySelector('#easy-note-box').scrollIntoView?.({ block: 'nearest' });
    });
    noteInput.addEventListener('input', () => { state.note = noteInput.value.slice(0, 140); });
    const micBtn = body.querySelector('#easy-note-mic');
    let listening = null;
    micBtn?.addEventListener('click', () => {
      if (listening) { listening.controller.stop(); return; }
      stopSpeaking(); // la voix de l'application ne doit pas être captée par le micro
      listening = listenOnce({ lang: getLanguage(), onInterim: (text) => { noteInput.value = text.slice(0, 140); } });
      micBtn.classList.add('is-listening');
      micBtn.setAttribute('aria-pressed', 'true');
      listening.promise.then((text) => { noteInput.value = text.slice(0, 140); state.note = noteInput.value; })
        .catch((err) => showToast(err?.code === 'not-allowed' ? t("Le micro n'est pas autorisé : autorisez-le dans les réglages du navigateur.") : t("Je n'ai rien entendu. Réessayez ou écrivez la note.")))
        .finally(() => { listening = null; micBtn.classList.remove('is-listening'); micBtn.setAttribute('aria-pressed', 'false'); });
    });
    body.querySelector('#easy-fix').addEventListener('click', () => { listening?.controller.stop(); go('amount'); });
    body.querySelector('#easy-save').addEventListener('click', async (e) => {
      primeSpeech(); // avant tout await : la lecture de confirmation suit l'enregistrement
      const saveBtn = e.currentTarget; // e.currentTarget vaut null après un await : on le garde avant
      saveBtn.disabled = true; // un seul enregistrement, même en cas de double toucher
      const record = await recordTemplateNow({
        type, walletId: state.walletId, targetWalletId: isTransfer ? state.targetId : null, categoryId: isTransfer ? null : state.categoryId,
        amount: n, note: state.note.trim(), date: state.date, receiptBlob: isTransfer ? null : state.photo,
      });
      if (!record) {
        saveBtn.disabled = false;
        showToast(t("Impossible d'enregistrer : ce portefeuille n'est plus disponible."));
        return;
      }
      const walletName = wallet().name;
      const targetName = target() ? target().name : '';
      const cur = currency();
      const walletId = state.walletId;
      modal.close();
      notifyDataChanged('transactions');
      showToast(t('Enregistré.'), {
        actionLabel: t('Annuler'),
        onAction: async () => { stopSpeaking(); await undoRecordedTemplate(record); notifyDataChanged('transactions'); showToast(t('Annulé.')); },
      });
      if (await isSpeakConfirmationsEnabled()) {
        speak(isTransfer
          ? buildTransferSavedSpeech({ amount: n, currency: cur, fromName: walletName, toName: targetName, balance: await getWalletBalance(walletId) })
          : buildSavedSpeech({ type, amount: n, currency: cur, categoryName: cat ? cat.name : '', walletName, balance: await getWalletBalance(walletId) }));
      }
    });
  }

  render();
}

/** Bouton « + » (barre du bas et du haut) en accueil facile : au lieu du formulaire classique, deux gros choix
    (« J'ai reçu » / « J'ai dépensé ») qui ouvrent la saisie guidée. Les tuiles reprennent le style de l'accueil. */
export function openEasyChooser() {
  const modal = openModal(`<div class="easy-tiles easy-chooser">
      <button type="button" class="easy-tile easy-in" data-easy="income">${icon('arrowDown', 44)}<span class="easy-tile-label">${escapeHtml(t("J'ai reçu"))}</span></button>
      <button type="button" class="easy-tile easy-out" data-easy="expense">${icon('arrowUp', 44)}<span class="easy-tile-label">${escapeHtml(t("J'ai dépensé"))}</span></button>
      <button type="button" class="easy-tile easy-move-tile" data-easy="transfer">${icon('swap', 44)}<span class="easy-tile-label">${escapeHtml(t("Je déplace de l'argent"))}</span></button>
    </div>`, { title: t('Que voulez-vous noter ?') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  modal.el.querySelector('.easy-chooser').addEventListener('click', (event) => {
    const tile = event.target.closest('[data-easy]');
    if (!tile) return;
    const kind = tile.dataset.easy;
    modal.close();
    openEasyEntry(kind); // dans le même geste : primeSpeech() reste valable
  });
}

/** Ce que fait le bouton « + » : saisie guidée en accueil facile, sinon la saisie rapide habituelle (`openClassic`). */
export function openAddEntry(openClassic) {
  if (document.body.dataset.easyHome === 'on') openEasyChooser();
  else openClassic();
}

/* ---------- Câblage (une seule fois) ---------- */

/** `navigateTo` vient d'app.js (qui importe ce module : l'importer ici ferait un cycle). */
export function initEasyHome({ navigateTo, openDebts = null }) {
  document.getElementById('easy-home')?.addEventListener('click', (event) => {
    const speakBtn = event.target.closest('#easy-speak-btn');
    if (speakBtn) { speakBalance(); return; }
    if (event.target.closest('#easy-month-btn')) { speakMonth(); return; }
    const tile = event.target.closest('[data-easy]');
    if (!tile) return;
    const kind = tile.dataset.easy;
    if (kind === 'income' || kind === 'expense' || kind === 'transfer') openEasyEntry(kind);
    else if (openDebts) openDebts(kind); // « On me doit » / « Je dois » : saisie guidée (easy-debts.js, branchée par app.js)
    else navigateTo('debts');
  });
  // Bouton « Écouter » du tableau de bord habituel (carte « Reste à vivre ») : utile même hors accueil facile.
  const dashSpeak = document.getElementById('dash-speak-btn');
  if (dashSpeak) {
    dashSpeak.hidden = !isSpeechSupported();
    dashSpeak.addEventListener('click', speakBalance);
  }
}
