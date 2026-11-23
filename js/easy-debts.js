/* ==========================================================================
   Djignan Financial System — Saisie guidée des prêts (accueil facile : « On me doit » / « Je dois »)
   Même esprit que la saisie guidée des dépenses (easy-home.js) : gros boutons, pavé numérique, lecture à voix haute.

   Deux gestes, pour chacune des deux touches :
     - un NOUVEAU prêt : qui ? → (quel portefeuille ?) → combien ? → c'est bon ?
         « On me doit » = j'ai prêté de l'argent (une créance) ; « Je dois » = j'ai emprunté (une dette) ;
     - un REMBOURSEMENT d'un prêt déjà noté : on touche la personne → combien ? → (quel portefeuille ?) → c'est bon ?
   Les prêts avec intérêts, participants, compte gardé ou projet collectif ne sont pas gérés ici : on ouvre alors la fenêtre
   de remboursement complète de l'écran Dettes & créances (le cas simple passe par debts.js : isSimpleDebt).
   L'écriture réutilise debts.js (createSimpleDebt / recordSimplePayment) : mêmes enregistrements, même journal d'audit,
   annulable d'un toucher.
   ========================================================================== */

import { STORES, dbGetAll, getSetting } from './db.js';
import { getWalletBalance, isDailyWallet } from './ledger.js';
import { keypadPress, addToAmount, quickAmounts } from './easy-home.js';
import {
  isSimpleDebt, listOpenDebts, createSimpleDebt, recordSimplePayment, undoSimplePayment, deleteDebtCascade, openPaymentModal,
} from './modules/debts.js';
import {
  isSpeechSupported, speak, stopSpeaking, primeSpeech, spokenAmount, buildDebtSpeech, isSpeakConfirmationsEnabled,
} from './speech-out.js';
import { formatCurrency, escapeHtml, openModal, showToast, intlLocale, todayISO, ZERO_DECIMAL_CURRENCIES } from './utils.js';
import { notifyDataChanged } from './state.js';
import { t, getLanguage } from './i18n.js';
import { isVoiceSupported, listenOnce } from './voice-input.js';
import { icon } from './icons.js';

const KEYPAD_ROWS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const walletIcon = (w) => icon(w.type === 'mobile_money' ? 'phone' : w.type === 'cash' ? 'banknote' : w.type === 'bank' ? 'bank' : 'wallet', 30);

/** Ce que fait l'opération, d'après la touche (`owed` / `owe`) et le geste (nouveau prêt ou remboursement). Pure.
    lend = j'ai prêté ; borrow = j'ai emprunté ; collect = on me rend ; repay = je rends. */
export function debtAction(kind, mode) {
  if (kind === 'owed') return mode === 'new' ? 'lend' : 'collect';
  return mode === 'new' ? 'borrow' : 'repay';
}

/** L'argent sort-il du portefeuille ? (prêter, ou rendre) — sinon il y entre. Pure. */
export function debtMoneyLeaves(action) { return action === 'lend' || action === 'repay'; }

/** `kind` : 'owed' (« On me doit », créances) ou 'owe' (« Je dois », dettes). */
export async function openEasyDebts(kind) {
  primeSpeech(); // dans le geste du clic, avant tout await
  const debtType = kind === 'owed' ? 'receivable' : 'debt';
  const [open, allWallets, allDebts, baseCurrency] = await Promise.all([listOpenDebts(debtType), dbGetAll(STORES.WALLETS), dbGetAll(STORES.DEBTS), getSetting('baseCurrency', 'XOF')]);
  const dailyWallets = allWallets.filter(isDailyWallet);
  const names = [...new Set(allDebts.slice().sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')).map((d) => d.personName).filter(Boolean))].slice(0, 5);

  const state = { step: open.length ? 'list' : 'who', mode: 'new', debt: null, owed: 0, name: '', amount: '', walletId: null, noWallet: false };
  const hasList = open.length > 0;
  const action = () => debtAction(kind, state.mode);
  const walletsForNow = () => (state.mode === 'repay' ? dailyWallets.filter((w) => w.currency === state.debt.currency) : dailyWallets);
  const wallet = () => dailyWallets.find((w) => w.id === state.walletId) || null;
  const currency = () => (state.mode === 'repay' ? state.debt.currency : (wallet() ? wallet().currency : baseCurrency));
  const allowDecimal = () => !ZERO_DECIMAL_CURRENCIES.has(currency());
  const title = kind === 'owed' ? t('On me doit') : t('Je dois');

  const modal = openModal('<div id="easy-step"></div>', { title, onClose: () => stopSpeaking() });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  const stepEl = modal.el.querySelector('#easy-step');

  function order() {
    if (state.mode === 'repay') return walletsForNow().length > 1 ? ['list', 'amount', 'wallet', 'confirm'] : ['list', 'amount', 'confirm'];
    return [...(hasList ? ['list'] : []), 'who', ...(dailyWallets.length ? ['wallet'] : []), 'amount', 'confirm'];
  }
  function stepDots() {
    const o = order();
    return `<div class="easy-dots" aria-hidden="true">${o.map((s) => `<span class="${s === state.step ? 'is-current' : (o.indexOf(s) < o.indexOf(state.step) ? 'is-done' : '')}"></span>`).join('')}</div>`;
  }
  function render() {
    stepEl.innerHTML = stepDots() + '<div id="easy-body"></div>';
    const body = stepEl.querySelector('#easy-body');
    if (state.step === 'list') renderList(body);
    else if (state.step === 'who') renderWho(body);
    else if (state.step === 'wallet') renderWallet(body);
    else if (state.step === 'amount') renderAmount(body);
    else renderConfirm(body);
  }
  const go = (step) => { stopSpeaking(); state.step = step; render(); };

  /** Les prêts en cours (touchez celui à rembourser) + le bouton « nouveau ». */
  function renderList(body) {
    body.innerHTML = `
      <p class="easy-question">${kind === 'owed' ? t('Qui vous doit encore de l\'argent ?') : t('À qui devez-vous encore de l\'argent ?')}</p>
      <div class="easy-wallets">
        ${open.map((x, i) => `<button type="button" class="easy-wallet" data-debt="${i}">${icon('person', 30)}<span class="easy-wallet-name">${escapeHtml(x.debt.personName)}</span><span class="easy-wallet-cur amount" data-value="${x.owed}">${escapeHtml(formatCurrency(x.owed, x.debt.currency))}</span></button>`).join('')}
      </div>
      <div class="easy-actions easy-actions-stack">
        <button type="button" class="btn btn-ghost easy-btn easy-move" id="easy-new">${icon('plus', 26)} <span>${kind === 'owed' ? t("J'ai prêté de l'argent") : t("J'ai emprunté de l'argent")}</span></button>
      </div>`;
    body.querySelectorAll('[data-debt]').forEach((btn) => btn.addEventListener('click', () => {
      const picked = open[Number(btn.dataset.debt)];
      if (!isSimpleDebt(picked.debt)) { modal.close(); openPaymentModal(picked.debt); return; } // intérêts, participants… : fenêtre complète
      if (!dailyWallets.some((w) => w.currency === picked.debt.currency)) { showToast(t("Créez d'abord un portefeuille en {currency}.", { currency: picked.debt.currency })); return; }
      Object.assign(state, { mode: 'repay', debt: picked.debt, owed: picked.owed, amount: '', walletId: null });
      const usable = walletsForNow();
      if (usable.length === 1) state.walletId = usable[0].id;
      go('amount');
    }));
    body.querySelector('#easy-new').addEventListener('click', () => { Object.assign(state, { mode: 'new', debt: null, amount: '', walletId: null, noWallet: false }); go('who'); });
  }

  /** Nouveau prêt : avec qui ? (écrit ou dicté, ou un nom déjà utilisé) */
  function renderWho(body) {
    body.innerHTML = `
      <p class="easy-question">${kind === 'owed' ? t('À qui avez-vous prêté ?') : t("Qui vous a prêté de l'argent ?")}</p>
      <div class="easy-note-box">
        <label class="easy-note-label" for="easy-who-input">${t('Son nom')}</label>
        <div class="easy-note-row">
          <input type="text" id="easy-who-input" maxlength="60" value="${escapeHtml(state.name)}" placeholder="${escapeHtml(t('Ex : Awa, mon voisin…'))}" autocomplete="off" autofocus>
          ${isVoiceSupported() ? `<button type="button" class="btn btn-ghost easy-btn easy-mic" id="easy-who-mic" aria-pressed="false" aria-label="${escapeHtml(t('Dicter le nom'))}">${icon('mic', 26)}</button>` : ''}
        </div>
      </div>
      ${names.length ? `<div class="easy-names">${names.map((n, i) => `<button type="button" class="btn btn-ghost easy-name" data-name="${i}">${escapeHtml(n)}</button>`).join('')}</div>` : ''}
      <div class="easy-actions">
        ${hasList ? `<button type="button" class="btn btn-ghost easy-btn" id="easy-back">${t('Retour')}</button>` : ''}
        <button type="button" class="btn btn-primary easy-btn easy-next" id="easy-next">${t('Suivant')} ${icon('chevron', 20)}</button>
      </div>`;
    const input = body.querySelector('#easy-who-input');
    const next = body.querySelector('#easy-next');
    const refresh = () => { state.name = input.value.trim().slice(0, 60); next.disabled = !state.name; };
    input.addEventListener('input', refresh);
    body.querySelectorAll('[data-name]').forEach((b) => b.addEventListener('click', () => { input.value = names[Number(b.dataset.name)]; refresh(); }));
    const micBtn = body.querySelector('#easy-who-mic');
    let listening = null;
    micBtn?.addEventListener('click', () => {
      if (listening) { listening.controller.stop(); return; }
      stopSpeaking();
      listening = listenOnce({ lang: getLanguage(), onInterim: (text) => { input.value = text.slice(0, 60); refresh(); } });
      micBtn.classList.add('is-listening'); micBtn.setAttribute('aria-pressed', 'true');
      listening.promise.then((text) => { input.value = text.slice(0, 60); refresh(); })
        .catch((err) => showToast(err?.code === 'not-allowed' ? t("Le micro n'est pas autorisé : autorisez-le dans les réglages du navigateur.") : t("Je n'ai rien entendu. Réessayez ou écrivez la note.")))
        .finally(() => { listening = null; micBtn.classList.remove('is-listening'); micBtn.setAttribute('aria-pressed', 'false'); });
    });
    body.querySelector('#easy-back')?.addEventListener('click', () => { listening?.controller.stop(); go('list'); });
    next.addEventListener('click', () => { listening?.controller.stop(); refresh(); if (state.name) go(dailyWallets.length ? 'wallet' : 'amount'); });
    refresh();
  }

  /** Quel portefeuille ? Pour un nouveau prêt, on peut aussi dire que l'argent ne bouge pas (le prêt date d'avant l'appli). */
  function renderWallet(body) {
    const list = walletsForNow();
    const isNew = state.mode === 'new';
    body.innerHTML = `
      <p class="easy-question">${debtMoneyLeaves(action()) ? t("D'où part l'argent ?") : t("Où l'argent est-il entré ?")}</p>
      <div class="easy-wallets">
        ${list.map((w) => `<button type="button" class="easy-wallet" data-wallet="${escapeHtml(w.id)}">${walletIcon(w)}<span class="easy-wallet-name">${escapeHtml(w.name)}</span><span class="easy-wallet-cur">${escapeHtml(w.currency)}</span></button>`).join('')}
        ${isNew ? `<button type="button" class="easy-wallet" data-wallet="">${icon('history', 30)}<span class="easy-wallet-name">${t('Pas de mouvement : c\'était avant')}</span></button>` : ''}
      </div>
      <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-back">${t('Retour')}</button></div>`;
    body.querySelectorAll('[data-wallet]').forEach((btn) => btn.addEventListener('click', () => {
      const id = btn.dataset.wallet || null;
      if (isNew && state.walletId !== id) state.amount = ''; // la devise peut changer (pas pour un remboursement : elle est celle de la dette)
      state.walletId = id; state.noWallet = id === null;
      go(isNew ? 'amount' : 'confirm');
    }));
    body.querySelector('#easy-back').addEventListener('click', () => go(isNew ? 'who' : 'amount'));
  }

  function renderAmount(body) {
    const keys = [...KEYPAD_ROWS, allowDecimal() ? '.' : '000', '0', 'back'];
    const repay = state.mode === 'repay';
    body.innerHTML = `
      <p class="easy-question">${repay ? (kind === 'owed' ? t('Combien vous rend-il ?') : t('Combien rendez-vous ?')) : t('Combien ?')}</p>
      <div class="easy-amount" aria-live="polite"><span id="easy-amount-num"></span></div>
      <div class="easy-amount-words" id="easy-amount-words"></div>
      ${repay ? `<div class="easy-quick"><button type="button" class="easy-quick-btn easy-all" id="easy-all">${escapeHtml(t('Tout : {amount}', { amount: formatCurrency(state.owed, currency()) }))}</button></div>` : ''}
      <div class="easy-quick" aria-label="${escapeHtml(t('Billets et pièces'))}">
        ${quickAmounts(currency()).map((n) => `<button type="button" class="easy-quick-btn" data-add="${n}" aria-label="${escapeHtml(t('Ajouter {amount}', { amount: spokenAmount(n, currency()) }))}">+ ${escapeHtml(n.toLocaleString(intlLocale()))}</button>`).join('')}
      </div>
      <div class="easy-keypad">
        ${keys.map((k) => `<button type="button" class="easy-key ${k === 'back' ? 'is-back' : ''}" data-key="${k}" ${k === 'back' ? `aria-label="${escapeHtml(t('Effacer le dernier chiffre'))}"` : ''}>${k === 'back' ? icon('backspace', 26) : k === '.' ? (getLanguage() === 'en' ? '.' : ',') : k}</button>`).join('')}
      </div>
      <p class="easy-hint c-neg" id="easy-too-much" hidden></p>
      <div class="easy-actions">
        <button type="button" class="btn btn-ghost easy-btn" id="easy-back">${t('Retour')}</button>
        ${isSpeechSupported() ? `<button type="button" class="btn btn-ghost easy-btn" id="easy-say">${icon('speaker', 22)} ${t('Écouter')}</button>` : ''}
        <button type="button" class="btn btn-ghost easy-btn" id="easy-clear">${t('Tout effacer')}</button>
        <button type="button" class="btn btn-primary easy-btn easy-next" id="easy-next">${t('Suivant')} ${icon('chevron', 20)}</button>
      </div>`;
    const numEl = body.querySelector('#easy-amount-num');
    const wordsEl = body.querySelector('#easy-amount-words');
    const nextBtn = body.querySelector('#easy-next');
    const sayBtn = body.querySelector('#easy-say');
    const tooMuch = body.querySelector('#easy-too-much');
    function refresh() {
      const n = Number(state.amount) || 0;
      const over = repay && n > state.owed + 0.005;
      numEl.textContent = formatCurrency(n, currency());
      wordsEl.textContent = n > 0 ? spokenAmount(n, currency()) : '';
      tooMuch.hidden = !over;
      if (over) tooMuch.textContent = t("C'est plus que ce qui reste à rendre ({owed}).", { owed: formatCurrency(state.owed, currency()) });
      nextBtn.disabled = !(n > 0) || over;
      if (sayBtn) sayBtn.disabled = !(n > 0);
    }
    body.querySelectorAll('[data-key]').forEach((btn) => btn.addEventListener('click', () => { state.amount = keypadPress(state.amount, btn.dataset.key, { allowDecimal: allowDecimal() }); refresh(); }));
    body.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', () => { state.amount = addToAmount(state.amount, Number(btn.dataset.add)); refresh(); }));
    body.querySelector('#easy-all')?.addEventListener('click', () => { state.amount = String(state.owed); refresh(); });
    body.querySelector('#easy-clear').addEventListener('click', () => { state.amount = keypadPress(state.amount, 'clear'); refresh(); });
    sayBtn?.addEventListener('click', () => { primeSpeech(); speak(spokenAmount(Number(state.amount) || 0, currency())); });
    body.querySelector('#easy-back').addEventListener('click', () => {
      if (repay) go('list');
      else go(dailyWallets.length ? 'wallet' : 'who');
    });
    nextBtn.addEventListener('click', () => go(repay && walletsForNow().length > 1 ? 'wallet' : 'confirm'));
    refresh();
  }

  function sentenceInfo(extra = {}) {
    return { action: action(), amount: Number(state.amount) || 0, currency: currency(), name: state.mode === 'repay' ? state.debt.personName : state.name, ...extra };
  }

  function renderConfirm(body) {
    const n = Number(state.amount) || 0;
    const repay = state.mode === 'repay';
    const person = repay ? state.debt.personName : state.name;
    const w = wallet();
    const act = action();
    const left = repay ? Math.max(0, state.owed - n) : null;
    const kindLabel = { lend: t('Prêté'), borrow: t('Emprunté'), collect: t('Récupéré'), repay: t('Rendu') }[act];
    body.innerHTML = `
      <p class="easy-question">${t("C'est bon ?")}</p>
      <div class="easy-summary">
        <div class="easy-summary-kind ${debtMoneyLeaves(act) ? 'neg' : 'pos'}">${icon(debtMoneyLeaves(act) ? 'arrowUp' : 'arrowDown', 30)} ${escapeHtml(kindLabel)}</div>
        <div class="easy-summary-amount amount" data-value="${n}">${escapeHtml(formatCurrency(n, currency()))}</div>
        <div class="easy-summary-words">${escapeHtml(spokenAmount(n, currency()))}</div>
        <div class="easy-summary-line">${icon('person', 22)} ${escapeHtml(person)}</div>
        <div class="easy-summary-line">${w ? `${icon('wallet', 22)} ${escapeHtml(w.name)}` : `${icon('history', 22)} ${escapeHtml(t("Aucun portefeuille ne bouge"))}`}</div>
        ${repay ? `<div class="easy-summary-line">${icon('ledger', 22)} ${escapeHtml(left > 0.005 ? t('Il restera {amount}', { amount: formatCurrency(left, currency()) }) : t('Tout sera réglé'))}</div>` : ''}
      </div>
      <div class="easy-warning" id="easy-warning" hidden></div>
      <div class="easy-actions easy-actions-stack">
        <button type="button" class="btn easy-btn easy-save" id="easy-save">${icon('check', 28)} ${t('Oui, enregistrer')}</button>
        <div class="easy-actions">
          ${isSpeechSupported() ? `<button type="button" class="btn btn-ghost easy-btn" id="easy-say">${icon('speaker', 22)} ${t('Écouter')}</button>` : ''}
          <button type="button" class="btn btn-ghost easy-btn" id="easy-fix">${t('Corriger')}</button>
        </div>
      </div>`;
    if (w && debtMoneyLeaves(act)) {
      getWalletBalance(w.id).then((balance) => {
        const warnEl = body.querySelector('#easy-warning');
        if (!warnEl?.isConnected || n <= balance + 0.005) return;
        warnEl.textContent = t('Attention : {wallet} ne contient que {balance}. Cette opération le ferait passer en négatif.', { wallet: w.name, balance: formatCurrency(Math.max(balance, 0), currency()) });
        warnEl.hidden = false;
      }).catch(() => {});
    }
    body.querySelector('#easy-say')?.addEventListener('click', () => { primeSpeech(); speak(buildDebtSpeech(sentenceInfo({ left }))); });
    body.querySelector('#easy-fix').addEventListener('click', () => go('amount'));
    body.querySelector('#easy-save').addEventListener('click', async (e) => {
      primeSpeech();
      const saveBtn = e.currentTarget;
      saveBtn.disabled = true; // un seul enregistrement, même en cas de double toucher
      const date = todayISO();
      let undo;
      let balanceWalletId = state.walletId;
      if (repay) {
        const result = await recordSimplePayment(state.debt, { amount: n, walletId: state.walletId, date });
        if (!result) { saveBtn.disabled = false; showToast(t("Impossible d'enregistrer : vérifiez le montant et le portefeuille.")); return; }
        undo = () => undoSimplePayment(result);
      } else {
        const result = await createSimpleDebt({ type: debtType, personName: state.name, principal: n, currency: currency(), walletId: state.walletId, date });
        if (!result) { saveBtn.disabled = false; showToast(t("Impossible d'enregistrer : ce portefeuille n'est plus disponible.")); return; }
        undo = () => deleteDebtCascade(result.debt.id);
      }
      const info = sentenceInfo({ saved: true, left });
      modal.close();
      notifyDataChanged('all');
      showToast(t('Enregistré.'), {
        actionLabel: t('Annuler'),
        onAction: async () => { stopSpeaking(); await undo(); notifyDataChanged('all'); showToast(t('Annulé.')); },
      });
      if (await isSpeakConfirmationsEnabled()) speak(buildDebtSpeech({ ...info, balance: balanceWalletId ? await getWalletBalance(balanceWalletId) : null, walletName: w ? w.name : '' }));
    });
  }

  render();
}
