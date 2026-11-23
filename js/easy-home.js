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

import { STORES, dbGetAll, dbAdd, dbPut, dbDelete, logAudit, getSetting, setSetting } from './db.js';
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
import { formatCurrency, formatDate, escapeHtml, openModal, confirmDialog, showToast, intlLocale, todayISO, localISODate, compressImageBlob, ZERO_DECIMAL_CURRENCIES } from './utils.js';
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
    <button type="button" class="easy-recent-row" data-tx="${escapeHtml(tx.id)}">
      <span class="easy-recent-icon" style="color:${look.color};">${icon(look.icon, 24)}</span>
      <span class="easy-recent-title">${escapeHtml(title)}</span>
      <span class="easy-recent-amount amount ${cls}" data-value="${tx.amount}">${sign}${escapeHtml(formatCurrency(tx.amount, tx.wallet?.currency || 'EUR'))}</span>
    </button>`;
}

/** Une opération liée à un prêt, un investissement, une tontine, une dépense partagée ou un projet se supprime depuis son élément d'origine
    (sinon celui-ci resterait orphelin : voir transactionLinkKind dans transactions.js). */
export function isLinkedTransaction(tx) {
  return !!tx && !!(tx.debtId || tx.debtInterestId || tx.investmentId || tx.tontineId || tx.sharedExpenseId || tx.projectId);
}

/** Toucher une des dernières opérations de l'accueil : ce qu'elle est (montant, catégorie, portefeuille, jour, note) et, si elle est
    une erreur, un gros bouton « Supprimer » (avec code PIN s'il y en a un, annulable d'un toucher). */
export async function openEasyTxDetail(id, { onChange = null } = {}) {
  const [allTx, wallets, categories] = await Promise.all([dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES)]);
  const tx = allTx.find((x) => x.id === id);
  if (!tx) return;
  const wallet = wallets.find((w) => w.id === tx.walletId);
  const target = wallets.find((w) => w.id === tx.targetWalletId);
  const cat = categories.find((c) => c.id === tx.categoryId) || null;
  const cur = wallet?.currency || 'EUR';
  const isTransfer = tx.type === 'transfer';
  const look = isTransfer ? { icon: 'swap', color: 'var(--accent)' } : categoryLook(cat);
  const kind = isTransfer ? t('Déplacé') : tx.type === 'income' ? t('Reçu') : t('Dépensé');
  const linked = isLinkedTransaction(tx);
  const modal = openModal(`
    <div class="easy-summary">
      <div class="easy-summary-kind ${isTransfer ? '' : tx.type === 'income' ? 'pos' : 'neg'}">${icon(isTransfer ? 'swap' : tx.type === 'income' ? 'arrowDown' : 'arrowUp', 30)} ${escapeHtml(kind)}</div>
      <div class="easy-summary-amount amount" data-value="${tx.amount}">${escapeHtml(formatCurrency(tx.amount, cur))}</div>
      <div class="easy-summary-words">${escapeHtml(spokenAmount(tx.amount, cur))}</div>
      ${isTransfer
        ? `<div class="easy-summary-line">${icon('wallet', 22)} ${escapeHtml(t('De {name}', { name: wallet?.name || '—' }))}</div>
      <div class="easy-summary-line">${icon('wallet', 22)} ${escapeHtml(t('Vers {name}', { name: target?.name || '—' }))}</div>`
        : `<div class="easy-summary-line"><span style="color:${look.color};">${icon(look.icon, 22)}</span> ${escapeHtml(cat ? cat.name : t('Sans catégorie'))}</div>
      <div class="easy-summary-line">${icon('wallet', 22)} ${escapeHtml(wallet?.name || '—')}</div>`}
      <div class="easy-summary-line">${icon('history', 22)} ${escapeHtml(formatDate(tx.date))}</div>
      ${tx.note ? `<div class="easy-summary-line">${icon('edit', 22)} ${escapeHtml(tx.note)}</div>` : ''}
    </div>
    ${linked ? `<p class="easy-hint">${escapeHtml(t("Cette opération est liée à un prêt, un investissement, une tontine ou une dépense partagée : pour la supprimer, supprimez l'élément d'origine."))}</p>` : ''}
    <div class="easy-actions easy-actions-stack">
      ${linked ? '' : `<button type="button" class="btn btn-primary easy-btn" id="easy-tx-fix">${icon('edit', 24)} ${escapeHtml(t('Corriger le montant'))}</button>`}
      ${linked || isTransfer ? '' : `<button type="button" class="btn btn-ghost easy-btn" id="easy-tx-cat">${icon('tag', 24)} ${escapeHtml(t('Corriger la catégorie'))}</button>`}
      ${linked || isTransfer || walletFixChoices(tx, wallets).length < 2 ? '' : `<button type="button" class="btn btn-ghost easy-btn" id="easy-tx-wallet">${icon('wallet', 24)} ${escapeHtml(t('Corriger le portefeuille'))}</button>`}
      ${linked || !isTransfer || transferFixChoices(tx, wallets).length < 2 ? '' : `<button type="button" class="btn btn-ghost easy-btn" id="easy-tx-wallets">${icon('swap', 24)} ${escapeHtml(t('Corriger les portefeuilles'))}</button>`}
      ${linked ? '' : `<button type="button" class="btn btn-ghost easy-btn" id="easy-tx-day">${icon('history', 24)} ${escapeHtml(t('Corriger le jour'))}</button>`}
      ${linked ? '' : `<button type="button" class="btn btn-ghost easy-btn" id="easy-tx-note">${icon('edit', 24)} ${escapeHtml(tx.note ? t('Corriger la note') : t('Ajouter une note'))}</button>`}
      ${linked ? '' : `<button type="button" class="btn btn-danger easy-btn" id="easy-tx-delete">${icon('trash', 24)} ${escapeHtml(t('Supprimer cette opération'))}</button>`}
      <button type="button" class="btn btn-ghost easy-btn" id="easy-tx-close">${escapeHtml(t('Fermer'))}</button>
    </div>`, { title: t('Cette opération') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  modal.el.querySelector('#easy-tx-close').addEventListener('click', () => modal.close());
  modal.el.querySelector('#easy-tx-fix')?.addEventListener('click', () => { modal.close(); openEasyAmountFix(tx, cur, { onChange }); });
  modal.el.querySelector('#easy-tx-cat')?.addEventListener('click', () => { modal.close(); openEasyCategoryFix(tx, { onChange }); });
  modal.el.querySelector('#easy-tx-wallet')?.addEventListener('click', () => { modal.close(); openEasyWalletFix(tx, { onChange }); });
  modal.el.querySelector('#easy-tx-wallets')?.addEventListener('click', () => { modal.close(); openEasyTransferFix(tx, { onChange }); });
  modal.el.querySelector('#easy-tx-day')?.addEventListener('click', () => { modal.close(); openEasyDayFix(tx, { onChange }); });
  modal.el.querySelector('#easy-tx-note')?.addEventListener('click', () => { modal.close(); openEasyNoteFix(tx, { onChange }); });
  modal.el.querySelector('#easy-tx-delete')?.addEventListener('click', async () => {
    const ok = await confirmDialog(t('Supprimer cette opération ? ({amount})', { amount: formatCurrency(tx.amount, cur) }), { danger: true, requirePin: true, confirmText: t('Supprimer') });
    if (!ok) return;
    modal.close();
    await dbDelete(STORES.TRANSACTIONS, tx.id);
    await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'delete', before: tx, note: t('Suppression depuis l\'accueil facile') });
    notifyDataChanged('transactions');
    onChange?.();
    showToast(t('Opération supprimée.'), {
      actionLabel: t('Annuler'),
      onAction: async () => {
        await dbAdd(STORES.TRANSACTIONS, tx);
        await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'create', after: tx, note: t('Restaurée (annulation)') });
        notifyDataChanged('transactions');
        onChange?.();
        showToast(t('Annulé.'));
      },
    });
  });
}

/** « Corriger le montant » : le pavé numérique avec le montant actuel déjà écrit ; seul le montant change (le reste de l'opération
    ne bouge pas), la modification est inscrite au journal d'audit et annulable. Renvoie le nouveau montant, ou null si rien n'a changé. */
export function openEasyAmountFix(tx, cur, { onChange = null } = {}) {
  const allowDecimal = !ZERO_DECIMAL_CURRENCIES.has(cur);
  let amount = String(tx.amount);
  const keys = [...KEYPAD_ROWS, allowDecimal ? '.' : '000', '0', 'back'];
  const modal = openModal(`
    <p class="easy-question">${escapeHtml(t('Quel est le bon montant ?'))}</p>
    <div class="easy-amount" aria-live="polite"><span id="easy-fix-num"></span></div>
    <div class="easy-amount-words" id="easy-fix-words"></div>
    <div class="easy-keypad">
      ${keys.map((k) => `<button type="button" class="easy-key ${k === 'back' ? 'is-back' : ''}" data-key="${k}" ${k === 'back' ? `aria-label="${escapeHtml(t('Effacer le dernier chiffre'))}"` : ''}>${k === 'back' ? icon('backspace', 26) : k === '.' ? (getLanguage() === 'en' ? '.' : ',') : k}</button>`).join('')}
    </div>
    <div class="easy-actions easy-actions-stack">
      <button type="button" class="btn btn-primary easy-btn easy-save" id="easy-fix-save">${icon('check', 28)} ${escapeHtml(t('Enregistrer'))}</button>
      <div class="easy-actions">
        <button type="button" class="btn btn-ghost easy-btn" id="easy-fix-clear">${escapeHtml(t('Tout effacer'))}</button>
        <button type="button" class="btn btn-ghost easy-btn" id="easy-fix-cancel">${escapeHtml(t('Fermer'))}</button>
      </div>
    </div>`, { title: t('Corriger le montant') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  const numEl = modal.el.querySelector('#easy-fix-num');
  const wordsEl = modal.el.querySelector('#easy-fix-words');
  const saveBtn = modal.el.querySelector('#easy-fix-save');
  function refresh() {
    const n = Number(amount) || 0;
    numEl.textContent = formatCurrency(n, cur);
    wordsEl.textContent = n > 0 ? spokenAmount(n, cur) : '';
    saveBtn.disabled = !(n > 0) || n === Number(tx.amount);
  }
  modal.el.querySelectorAll('[data-key]').forEach((btn) => btn.addEventListener('click', () => { amount = keypadPress(amount, btn.dataset.key, { allowDecimal }); refresh(); }));
  modal.el.querySelector('#easy-fix-clear').addEventListener('click', () => { amount = ''; refresh(); });
  modal.el.querySelector('#easy-fix-cancel').addEventListener('click', () => modal.close());
  saveBtn.addEventListener('click', async () => {
    const n = Number(amount) || 0;
    if (!(n > 0) || n === Number(tx.amount)) return;
    modal.close();
    await saveTxCorrection(tx, { amount: n }, {
      auditNote: t("Montant corrigé depuis l'accueil facile"), doneMsg: t('Montant corrigé.'), failMsg: t("Le montant n'a pas pu être changé."), onChange,
    });
  });
  refresh();
  return modal;
}

/** Enregistre une correction d'une opération (quelques champs seulement), la trace au journal d'audit et propose « Annuler » d'un toucher.
    Commun à « Corriger le montant » et « Corriger le jour ». Renvoie true si la correction est faite. */
async function saveTxCorrection(tx, patch, { auditNote, doneMsg, failMsg, onChange = null }) {
  const before = { ...tx };
  const after = { ...tx, ...patch };
  try {
    await dbPut(STORES.TRANSACTIONS, after);
  } catch (err) {
    showToast(err?.name === 'HelperRestrictedError' ? t('Action réservée au propriétaire.') : failMsg);
    return false;
  }
  await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'update', before, after, note: auditNote });
  notifyDataChanged('transactions');
  onChange?.();
  showToast(doneMsg, {
    actionLabel: t('Annuler'),
    onAction: async () => {
      await dbPut(STORES.TRANSACTIONS, before);
      await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'update', before: after, after: before, note: t('Restaurée (annulation)') });
      notifyDataChanged('transactions');
      onChange?.();
      showToast(t('Annulé.'));
    },
  });
  return true;
}

/** Une grosse tuile de catégorie (icône + nom), commune à la saisie guidée et à « Corriger la catégorie ». `current` la marque comme choix actuel. */
function categoryTileHtml(id, label, look, current = false) {
  return `
      <button type="button" class="easy-cat ${current ? 'is-current' : ''}" data-cat="${escapeHtml(id)}" style="--cat:${look.color};" ${current ? 'aria-pressed="true"' : ''}>
        <span class="easy-cat-icon">${icon(look.icon, 34)}</span><span class="easy-cat-name">${escapeHtml(label)}</span>
      </button>`;
}

/** « Corriger la catégorie » (dépense ou recette, pas un déplacement) : les mêmes grosses tuiles que la saisie guidée, la plus utilisée en premier,
    la catégorie actuelle marquée. Toucher une autre tuile change la catégorie tout de suite (annulable d'un toucher) ; toucher l'actuelle ferme. */
export async function openEasyCategoryFix(tx, { onChange = null } = {}) {
  const [allCategories, allTx] = await Promise.all([dbGetAll(STORES.CATEGORIES), dbGetAll(STORES.TRANSACTIONS)]);
  const usage = new Map();
  for (const x of allTx) if (x.type === tx.type && x.categoryId) usage.set(x.categoryId, (usage.get(x.categoryId) || 0) + 1);
  const categories = allCategories.filter((c) => c.type === tx.type && (!c.parentId || c.id === tx.categoryId))
    .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || a.name.localeCompare(b.name));
  const modal = openModal(`
    <p class="easy-question">${escapeHtml(tx.type === 'income' ? t("D'où vient cet argent ?") : t('Pour quoi ?'))}</p>
    <div class="easy-cats">
      ${categories.map((c) => categoryTileHtml(c.id, c.name, categoryLook(c), c.id === tx.categoryId)).join('')}
      ${categoryTileHtml('', t('Autre chose'), { icon: 'more', color: 'var(--text-muted)' }, !tx.categoryId)}
    </div>
    <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-catfix-cancel">${escapeHtml(t('Fermer'))}</button></div>`, { title: t('Corriger la catégorie') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  modal.el.querySelector('#easy-catfix-cancel').addEventListener('click', () => modal.close());
  modal.el.querySelectorAll('[data-cat]').forEach((btn) => btn.addEventListener('click', async () => {
    const categoryId = btn.dataset.cat || null;
    modal.close();
    if (categoryId === (tx.categoryId || null)) return;
    await saveTxCorrection(tx, { categoryId }, {
      auditNote: t("Catégorie corrigée depuis l'accueil facile"), doneMsg: t('Catégorie corrigée.'), failMsg: t("La catégorie n'a pas pu être changée."), onChange,
    });
  }));
  return modal;
}

/** Un gros bouton de portefeuille (icône, nom, devise), commun à la saisie guidée et à « Corriger le portefeuille ». `attr` : l'attribut data-* qui porte l'identifiant. */
function walletTileHtml(w, attr, current = false) {
  const ico = w.type === 'mobile_money' ? 'phone' : w.type === 'cash' ? 'banknote' : w.type === 'bank' ? 'bank' : 'wallet';
  return `<button type="button" class="easy-wallet ${current ? 'is-current' : ''}" ${attr}="${escapeHtml(w.id)}" ${current ? 'aria-pressed="true"' : ''}>${icon(ico, 30)}<span class="easy-wallet-name">${escapeHtml(w.name)}</span><span class="easy-wallet-cur">${escapeHtml(w.currency)}</span></button>`;
}

/** Portefeuilles vers lesquels on peut ramener une opération : de tous les jours, non archivés, dans la MÊME devise (le montant reste juste). */
function walletFixChoices(tx, wallets) {
  const current = wallets.find((w) => w.id === tx.walletId);
  if (!current) return [];
  return wallets.filter((w) => w.id === tx.walletId || (isDailyWallet(w) && w.currency === current.currency));
}

/** « Corriger le portefeuille » (dépense ou recette) : « Sur quel portefeuille ? » avec les mêmes gros boutons que la saisie guidée, l'actuel marqué.
    Toucher un autre portefeuille déplace l'opération (son solde et celui de l'autre changent, la devise reste la même) ; annulable d'un toucher. */
export async function openEasyWalletFix(tx, { onChange = null } = {}) {
  const wallets = walletFixChoices(tx, await dbGetAll(STORES.WALLETS));
  const modal = openModal(`
    <p class="easy-question">${escapeHtml(t('Sur quel portefeuille ?'))}</p>
    <div class="easy-wallets">${wallets.map((w) => walletTileHtml(w, 'data-wallet', w.id === tx.walletId)).join('')}</div>
    <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-walletfix-cancel">${escapeHtml(t('Fermer'))}</button></div>`, { title: t('Corriger le portefeuille') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  modal.el.querySelector('#easy-walletfix-cancel').addEventListener('click', () => modal.close());
  modal.el.querySelectorAll('[data-wallet]').forEach((btn) => btn.addEventListener('click', async () => {
    const walletId = btn.dataset.wallet;
    modal.close();
    if (walletId === tx.walletId) return;
    await saveTxCorrection(tx, { walletId }, {
      auditNote: t("Portefeuille corrigé depuis l'accueil facile"), doneMsg: t('Portefeuille corrigé.'), failMsg: t("Le portefeuille n'a pas pu être changé."), onChange,
    });
  }));
  return modal;
}

/** « Corriger la note » (ou « Ajouter une note ») : un grand champ avec le texte actuel, au clavier ou dicté avec le micro (comme à la saisie).
    Seule la note change ; la vider l'efface. Inscrit au journal d'audit et annulable comme les autres corrections. */
export function openEasyNoteFix(tx, { onChange = null } = {}) {
  const current = (tx.note || '').trim();
  let listening = null;
  const modal = openModal(`
    <p class="easy-question">${escapeHtml(t('Quelle note ?'))}</p>
    <div class="easy-note-row">
      <input type="text" id="easy-notefix-input" maxlength="140" value="${escapeHtml(current)}" placeholder="${escapeHtml(t('Ex : taxi, marché, cadeau…'))}" aria-label="${escapeHtml(t('Note (facultatif)'))}" autocomplete="off">
      ${isVoiceSupported() ? `<button type="button" class="btn btn-ghost easy-btn easy-mic" id="easy-notefix-mic" aria-pressed="false" aria-label="${escapeHtml(t('Dicter la note'))}">${icon('mic', 26)}</button>` : ''}
    </div>
    <div class="easy-actions easy-actions-stack">
      <button type="button" class="btn btn-primary easy-btn easy-save" id="easy-notefix-save" disabled>${icon('check', 28)} ${escapeHtml(t('Enregistrer'))}</button>
      <div class="easy-actions">
        ${current ? `<button type="button" class="btn btn-ghost easy-btn" id="easy-notefix-clear">${escapeHtml(t('Effacer la note'))}</button>` : ''}
        <button type="button" class="btn btn-ghost easy-btn" id="easy-notefix-cancel">${escapeHtml(t('Fermer'))}</button>
      </div>
    </div>`, { title: current ? t('Corriger la note') : t('Ajouter une note'), onClose: () => listening?.controller.stop() });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  const input = modal.el.querySelector('#easy-notefix-input');
  const saveBtn = modal.el.querySelector('#easy-notefix-save');
  const refresh = () => { saveBtn.disabled = input.value.trim() === current; };
  input.addEventListener('input', refresh);
  const micBtn = modal.el.querySelector('#easy-notefix-mic');
  micBtn?.addEventListener('click', () => {
    if (listening) { listening.controller.stop(); return; }
    stopSpeaking(); // la voix de l'application ne doit pas être captée par le micro
    listening = listenOnce({ lang: getLanguage(), onInterim: (text) => { input.value = text.slice(0, 140); refresh(); } });
    micBtn.classList.add('is-listening');
    micBtn.setAttribute('aria-pressed', 'true');
    listening.promise.then((text) => { input.value = text.slice(0, 140); refresh(); })
      .catch((err) => showToast(err?.code === 'not-allowed' ? t("Le micro n'est pas autorisé : autorisez-le dans les réglages du navigateur.") : t("Je n'ai rien entendu. Réessayez ou écrivez la note.")))
      .finally(() => { listening = null; micBtn.classList.remove('is-listening'); micBtn.setAttribute('aria-pressed', 'false'); });
  });
  modal.el.querySelector('#easy-notefix-clear')?.addEventListener('click', () => { input.value = ''; refresh(); input.focus(); });
  modal.el.querySelector('#easy-notefix-cancel').addEventListener('click', () => modal.close());
  saveBtn.addEventListener('click', async () => {
    const note = input.value.trim().slice(0, 140);
    if (note === current) return;
    modal.close();
    await saveTxCorrection(tx, { note }, {
      auditNote: t("Note corrigée depuis l'accueil facile"), doneMsg: note ? t('Note corrigée.') : t('Note effacée.'), failMsg: t("La note n'a pas pu être changée."), onChange,
    });
  });
  return modal;
}

/** Portefeuilles d'un déplacement : tous ceux de la MÊME devise (le montant reste juste), non archivés ; le départ et l'arrivée actuels restent proposés
    même archivés (sinon ils disparaîtraient). L'épargne en fait partie, comme à la saisie d'un déplacement. */
function transferFixChoices(tx, wallets) {
  const current = wallets.find((w) => w.id === tx.walletId);
  if (!current) return [];
  return wallets.filter((w) => w.currency === current.currency && (!w.archived || w.id === tx.walletId || w.id === tx.targetWalletId));
}

/** « Corriger les portefeuilles » d'un déplacement : « D'où part l'argent ? » puis « Où va l'argent ? », comme à la saisie, avec le départ et
    l'arrivée actuels marqués. Rien n'est écrit avant le second choix ; départ et arrivée changent ensemble (annulable d'un toucher, trace au journal). */
export async function openEasyTransferFix(tx, { onChange = null } = {}) {
  const choices = transferFixChoices(tx, await dbGetAll(STORES.WALLETS));
  let fromId = tx.walletId;
  const modal = openModal('<div id="easy-transferfix"></div>', { title: t('Corriger les portefeuilles') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  const root = modal.el.querySelector('#easy-transferfix');
  function renderFrom() {
    const tiles = choices.filter((w) => !w.archived || w.id === tx.walletId);
    root.innerHTML = `
      <p class="easy-question">${escapeHtml(t("D'où part l'argent ?"))}</p>
      <div class="easy-wallets">${tiles.map((w) => walletTileHtml(w, 'data-from', w.id === tx.walletId)).join('')}</div>
      <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-transferfix-cancel">${escapeHtml(t('Fermer'))}</button></div>`;
    root.querySelectorAll('[data-from]').forEach((btn) => btn.addEventListener('click', () => { fromId = btn.dataset.from; renderTo(); }));
    root.querySelector('#easy-transferfix-cancel').addEventListener('click', () => modal.close());
  }
  function renderTo() {
    const tiles = choices.filter((w) => w.id !== fromId && (!w.archived || w.id === tx.targetWalletId));
    root.innerHTML = `
      <p class="easy-question">${escapeHtml(t("Où va l'argent ?"))}</p>
      <div class="easy-wallets">${tiles.map((w) => walletTileHtml(w, 'data-to', w.id === tx.targetWalletId)).join('')}</div>
      <div class="easy-actions">
        <button type="button" class="btn btn-ghost easy-btn" id="easy-transferfix-back">${escapeHtml(t('Retour'))}</button>
        <button type="button" class="btn btn-ghost easy-btn" id="easy-transferfix-cancel">${escapeHtml(t('Fermer'))}</button>
      </div>`;
    root.querySelector('#easy-transferfix-back').addEventListener('click', renderFrom);
    root.querySelector('#easy-transferfix-cancel').addEventListener('click', () => modal.close());
    root.querySelectorAll('[data-to]').forEach((btn) => btn.addEventListener('click', async () => {
      const toId = btn.dataset.to;
      modal.close();
      if (fromId === tx.walletId && toId === tx.targetWalletId) return;
      await saveTxCorrection(tx, { walletId: fromId, targetWalletId: toId }, {
        auditNote: t("Portefeuilles corrigés depuis l'accueil facile"), doneMsg: t('Portefeuilles corrigés.'), failMsg: t("Les portefeuilles n'ont pas pu être changés."), onChange,
      });
    }));
  }
  renderFrom();
  return modal;
}

/** « Corriger le jour » : les mêmes gros boutons que la saisie guidée (Aujourd'hui, Hier, Avant-hier, Autre jour — jamais dans le futur).
    Seul le jour change ; trace au journal et annulable comme pour le montant. */
export function openEasyDayFix(tx, { onChange = null } = {}) {
  let date = tx.date;
  const modal = openModal('<div id="easy-dayfix"></div>', { title: t('Corriger le jour') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  const root = modal.el.querySelector('#easy-dayfix');
  function render() {
    const isQuick = [0, 1, 2].some((b) => isoDaysAgo(b) === date);
    root.innerHTML = `
      <p class="easy-question">${escapeHtml(t('Quel est le bon jour ?'))}</p>
      <div class="easy-date" role="group" aria-label="${escapeHtml(t('Quel jour ?'))}">
        <div class="easy-date-row">
          ${[0, 1, 2].map((back) => { const iso = isoDaysAgo(back); return `<button type="button" class="btn easy-day ${date === iso ? 'is-on' : 'btn-ghost'}" data-day="${iso}" aria-pressed="${date === iso}">${escapeHtml(dayLabel(back))}</button>`; }).join('')}
          <button type="button" class="btn easy-day ${isQuick ? 'btn-ghost' : 'is-on'}" id="easy-dayfix-other" aria-pressed="${!isQuick}">${escapeHtml(isQuick ? t('Autre jour') : formatDate(date))}</button>
        </div>
        <input type="date" id="easy-dayfix-input" class="easy-day-input" max="${todayISO()}" value="${escapeHtml(date)}" hidden aria-label="${escapeHtml(t('Choisir le jour'))}">
      </div>
      <div class="easy-actions easy-actions-stack">
        <button type="button" class="btn btn-primary easy-btn easy-save" id="easy-dayfix-save" ${date === tx.date ? 'disabled' : ''}>${icon('check', 28)} ${escapeHtml(t('Enregistrer'))}</button>
        <button type="button" class="btn btn-ghost easy-btn" id="easy-dayfix-cancel">${escapeHtml(t('Fermer'))}</button>
      </div>`;
    const input = root.querySelector('#easy-dayfix-input');
    const choose = (iso) => { date = pastOrTodayISO(iso); render(); };
    root.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.day)));
    root.querySelector('#easy-dayfix-other').addEventListener('click', () => { input.hidden = false; if (input.showPicker) { try { input.showPicker(); } catch { input.focus(); } } else input.focus(); });
    input.addEventListener('change', () => { if (input.value) choose(input.value); });
    root.querySelector('#easy-dayfix-cancel').addEventListener('click', () => modal.close());
    root.querySelector('#easy-dayfix-save').addEventListener('click', async () => {
      if (date === tx.date) return;
      modal.close();
      await saveTxCorrection(tx, { date }, {
        auditNote: t("Jour corrigé depuis l'accueil facile"), doneMsg: t('Jour corrigé.'), failMsg: t("Le jour n'a pas pu être changé."), onChange,
      });
    });
  }
  render();
  return modal;
}

const HISTORY_PAGE = 30;

/** « Un jour » en toutes lettres pour les titres de la liste : Aujourd'hui, Hier, sinon la date. */
export function historyDayLabel(date, today = todayISO()) {
  if (date === today) return t("Aujourd'hui");
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  if (date === localISODate(d)) return t('Hier');
  return formatDate(date);
}

/** Regroupe des opérations déjà triées (récentes d'abord) par jour : [{date, items}]. */
export function groupByDay(list) {
  const groups = [];
  for (const tx of list) {
    const last = groups[groups.length - 1];
    if (last && last.date === tx.date) last.items.push(tx);
    else groups.push({ date: tx.date, items: [tx] });
  }
  return groups;
}

/** « Voir toutes mes opérations » : les opérations par jour (30 à la fois), chacune se touche pour la voir ou la supprimer. */
export function openEasyHistory() {
  let count = HISTORY_PAGE;
  const modal = openModal('<div id="easy-history"></div>', { title: t('Toutes mes opérations') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  const host = modal.el.querySelector('#easy-history');
  async function render() {
    const rows = await getEnrichedTransactions({ limit: count + 1 });
    const more = rows.length > count;
    const shown = rows.slice(0, count);
    if (!shown.length) { host.innerHTML = `<p class="easy-hint">${escapeHtml(t("Aucune opération pour l'instant."))}</p>`; return; }
    host.innerHTML = groupByDay(shown).map((g) => `
      <h4 class="easy-day-title">${escapeHtml(historyDayLabel(g.date))}</h4>
      <div class="easy-recent">${g.items.map(recentRowHtml).join('')}</div>`).join('')
      + (more ? `<button type="button" class="btn btn-ghost easy-btn" id="easy-history-more">${escapeHtml(t('Voir plus'))}</button>` : '');
  }
  host.addEventListener('click', (event) => {
    if (event.target.closest('#easy-history-more')) { count += HISTORY_PAGE; render(); return; }
    const row = event.target.closest('[data-tx]');
    if (row) openEasyTxDetail(row.dataset.tx, { onChange: render });
  });
  render();
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
    ${recent.length ? `<h3 class="easy-section-title">${t('Dernières opérations')}</h3><div class="easy-recent">${recent.map(recentRowHtml).join('')}</div>
      <button type="button" class="btn btn-ghost easy-more" id="easy-history-btn">${icon('history', 28)} <span>${t('Voir toutes mes opérations')}</span></button>` : ''}`;
}

/* ---------- Saisie guidée ---------- */

/** Date locale d'il y a `back` jours (AAAA-MM-JJ). */
export function isoDaysAgo(back) {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return localISODate(d);
}
/** « Aujourd'hui », « Hier », « Avant-hier » (écrits en toutes lettres). */
export function dayLabel(back) { return back === 0 ? t("Aujourd'hui") : back === 1 ? t('Hier') : t('Avant-hier'); }

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
        ${wallets.map((w) => walletTileHtml(w, 'data-wallet')).join('')}
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
        ${peers.map((w) => walletTileHtml(w, 'data-target')).join('')}
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
    const tile = categoryTileHtml;
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
    if (event.target.closest('#easy-history-btn')) { openEasyHistory(); return; }
    const row = event.target.closest('[data-tx]');
    if (row) { openEasyTxDetail(row.dataset.tx); return; }
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
