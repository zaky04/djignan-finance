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
import { keypadPress, addToAmount, quickAmounts, isoDaysAgo, dayLabel, openEasyNoteEditor } from './easy-home.js';
import { pastOrTodayISO } from './quick-templates.js';
import {
  isSimpleDebt, listOpenDebts, createSimpleDebt, recordSimplePayment, undoSimplePayment, deleteDebtCascade, openPaymentModal,
  updateSimpleDebtDetails, revertDebtDetails,
} from './modules/debts.js';
import { openPersonReminder } from './modules/person-ledger.js';
import {
  isSpeechSupported, speak, stopSpeaking, primeSpeech, spokenAmount, buildDebtSpeech, isSpeakConfirmationsEnabled,
} from './speech-out.js';
import { formatCurrency, formatDate, escapeHtml, openModal, showToast, intlLocale, todayISO, localISODate, ZERO_DECIMAL_CURRENCIES } from './utils.js';
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

/** Date locale dans `days` jours (AAAA-MM-JJ). */
const isoInDays = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return localISODate(d); };

/** « Quand doit-il rendre ? » : pas de date, 1 semaine, 2 semaines, 1 mois, ou un autre jour. Commun à la saisie d'un nouveau prêt et à « Corriger la date de
    retour ». `due` : l'échéance actuelle (`''` = aucune) ; `min` : plus petit jour du calendrier « Autre jour ». */
function dueChooserHtml(kind, due, min) {
  const presets = [['', t('Pas de date')], [isoInDays(7), t('1 semaine')], [isoInDays(14), t('2 semaines')], [isoInDays(30), t('1 mois')]];
  const isOther = !!due && !presets.some(([iso]) => iso === due);
  const label = kind === 'owed' ? t('Quand doit-il vous rendre ?') : t('Quand devez-vous rendre ?');
  return `<div class="easy-date" role="group" aria-label="${escapeHtml(label)}">
        <span class="easy-note-label">${escapeHtml(label)}</span>
        <div class="easy-date-row">
          ${presets.map(([iso, text]) => `<button type="button" class="btn easy-day ${due === iso ? 'is-on' : 'btn-ghost'}" data-due="${iso}" aria-pressed="${due === iso}">${escapeHtml(text)}</button>`).join('')}
          <button type="button" class="btn easy-day ${isOther ? 'is-on' : 'btn-ghost'}" id="easy-due-other" aria-pressed="${isOther}">${escapeHtml(isOther ? formatDate(due) : t('Autre jour'))}</button>
        </div>
        <input type="date" id="easy-due-input" class="easy-day-input" min="${escapeHtml(min)}" value="${escapeHtml(due)}" hidden aria-label="${escapeHtml(t('Choisir le jour'))}">
      </div>`;
}

/** Branche les boutons de `dueChooserHtml` (présents dans `root`) : `onChoose(iso)` reçoit `''` (pas de date) ou un jour AAAA-MM-JJ. */
function bindDueChooser(root, onChoose) {
  const input = root.querySelector('#easy-due-input');
  root.querySelectorAll('[data-due]').forEach((b) => b.addEventListener('click', () => onChoose(b.dataset.due)));
  root.querySelector('#easy-due-other')?.addEventListener('click', () => { input.hidden = false; if (input.showPicker) { try { input.showPicker(); } catch { input.focus(); } } else input.focus(); });
  input?.addEventListener('change', () => { if (input.value) onChoose(input.value); });
}

/** Enregistre la correction d'un prêt, la trace au journal d'audit et propose « Annuler » d'un toucher. L'aidant ne peut pas modifier un prêt existant
    (`HelperRestrictedError`). Renvoie true si la correction est faite. */
async function saveDebtCorrection(debt, patch, { auditNote, doneMsg, failMsg, onChange = null }) {
  let result;
  try {
    result = await updateSimpleDebtDetails(debt, patch, { auditNote });
  } catch (err) {
    showToast(err?.name === 'HelperRestrictedError' ? t('Action réservée au propriétaire.') : failMsg);
    return false;
  }
  if (!result) { showToast(failMsg); return false; }
  notifyDataChanged('all');
  onChange?.();
  showToast(doneMsg, {
    actionLabel: t('Annuler'),
    onAction: async () => {
      try { await revertDebtDetails(result); } catch { showToast(t('Action réservée au propriétaire.')); return; }
      notifyDataChanged('all');
      onChange?.();
      showToast(t('Annulé.'));
    },
  });
  return true;
}

/** « Modifier » d'un prêt de la liste : deux gros boutons, « Corriger la note » et « Corriger la date de retour » (ou « Ajouter… » s'il n'y en a pas),
    qui montrent la valeur actuelle. La note ouvre la même fenêtre (champ + micro) que pour une opération ; la date reprend les choix de la saisie d'un
    nouveau prêt (pas de date, 1 semaine, 2 semaines, 1 mois, autre jour) et s'enregistre dès qu'on en touche un. Réservé aux prêts simples (sans intérêts
    ni participants…) ; annulable d'un toucher ; `onChange` est appelé après chaque correction ou annulation. */
export function openEasyDebtFix(debt, kind, { onChange = null } = {}) {
  if (!isSimpleDebt(debt) || debt.status !== 'active') return null;
  const note = (debt.note || '').trim();
  const due = debt.dueDate || '';
  const optionHtml = (id, name, current) => `<button type="button" class="easy-wallet" id="${id}">${icon('edit', 30)}<span class="easy-debt-text"><span class="easy-wallet-name">${escapeHtml(name)}</span>${current ? `<span class="easy-wallet-cur easy-fix-current">${escapeHtml(current)}</span>` : ''}</span></button>`;
  const modal = openModal(`
    <p class="easy-question">${escapeHtml(debt.personName)}</p>
    <div class="easy-wallets">
      ${optionHtml('easy-debtfix-note', note ? t('Corriger la note') : t('Ajouter une note'), note)}
      ${optionHtml('easy-debtfix-due', due ? t('Corriger la date de retour') : t('Ajouter une date de retour'), due ? t('À rendre le {date}', { date: formatDate(due) }) : '')}
    </div>
    <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-debtfix-cancel">${escapeHtml(t('Fermer'))}</button></div>`, { title: t('Modifier') });
  modal.el.querySelector('.modal-card').classList.add('easy-modal');
  modal.el.querySelector('#easy-debtfix-cancel').addEventListener('click', () => modal.close());
  modal.el.querySelector('#easy-debtfix-note').addEventListener('click', () => {
    modal.close();
    openEasyNoteEditor({
      current: note,
      placeholder: t('Ex : pour le loyer, un cadeau…'),
      onSave: (text) => saveDebtCorrection(debt, { note: text }, {
        auditNote: t("Note du prêt corrigée depuis l'accueil facile"), doneMsg: text ? t('Note corrigée.') : t('Note effacée.'), failMsg: t("La note n'a pas pu être changée."), onChange,
      }),
    });
  });
  modal.el.querySelector('#easy-debtfix-due').addEventListener('click', () => {
    modal.close();
    const min = debt.startDate || '';
    const dueModal = openModal(`
      ${dueChooserHtml(kind, due, min)}
      <div class="easy-actions"><button type="button" class="btn btn-ghost easy-btn" id="easy-duefix-cancel">${escapeHtml(t('Fermer'))}</button></div>`, { title: due ? t('Corriger la date de retour') : t('Ajouter une date de retour') });
    dueModal.el.querySelector('.modal-card').classList.add('easy-modal');
    dueModal.el.querySelector('#easy-duefix-cancel').addEventListener('click', () => dueModal.close());
    bindDueChooser(dueModal.el, async (iso) => {
      if (iso && min && iso < min) { showToast(t('La date de retour ne peut pas être avant le prêt.')); return; }
      dueModal.close();
      if (iso === due) return;
      await saveDebtCorrection(debt, { dueDate: iso }, {
        auditNote: t("Date de retour corrigée depuis l'accueil facile"), doneMsg: iso ? t('Date de retour corrigée.') : t('Date de retour effacée.'), failMsg: t("La date de retour n'a pas pu être changée."), onChange,
      });
    });
  });
  return modal;
}

/** `kind` : 'owed' (« On me doit », créances) ou 'owe' (« Je dois », dettes). */
export async function openEasyDebts(kind) {
  primeSpeech(); // dans le geste du clic, avant tout await
  const debtType = kind === 'owed' ? 'receivable' : 'debt';
  const [open, allWallets, allDebts, baseCurrency] = await Promise.all([listOpenDebts(debtType), dbGetAll(STORES.WALLETS), dbGetAll(STORES.DEBTS), getSetting('baseCurrency', 'XOF')]);
  const dailyWallets = allWallets.filter(isDailyWallet);
  const names = [...new Set(allDebts.slice().sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '')).map((d) => d.personName).filter(Boolean))].slice(0, 5);

  const state = { step: open.length ? 'list' : 'who', mode: 'new', debt: null, owed: 0, name: '', amount: '', walletId: null, noWallet: false, due: '', date: todayISO(), note: '' };
  let noteListening = null; // dictée de la note en cours (écran « C'est bon ? »)
  const hasList = open.length > 0;
  const action = () => debtAction(kind, state.mode);
  const walletsForNow = () => (state.mode === 'repay' ? dailyWallets.filter((w) => w.currency === state.debt.currency) : dailyWallets);
  const wallet = () => dailyWallets.find((w) => w.id === state.walletId) || null;
  const currency = () => (state.mode === 'repay' ? state.debt.currency : (wallet() ? wallet().currency : baseCurrency));
  const allowDecimal = () => !ZERO_DECIMAL_CURRENCIES.has(currency());
  const title = kind === 'owed' ? t('On me doit') : t('Je dois');

  const modal = openModal('<div id="easy-step"></div>', { title, onClose: () => { stopSpeaking(); noteListening?.controller.stop(); } });
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
  /** Relit les prêts en cours (après une correction de note ou d'échéance) et réaffiche la liste si on y est. */
  async function reloadOpen() {
    open.splice(0, open.length, ...await listOpenDebts(debtType));
    if (state.step === 'list') render();
  }

  /** Les prêts en cours (touchez celui à rembourser) + le bouton « nouveau ». */
  function renderList(body) {
    body.innerHTML = `
      <p class="easy-question">${kind === 'owed' ? t('Qui vous doit encore de l\'argent ?') : t('À qui devez-vous encore de l\'argent ?')}</p>
      <div class="easy-wallets">
        ${open.map((x, i) => `<div class="easy-debt-row">
          <button type="button" class="easy-wallet" data-debt="${i}">${icon('person', 30)}<span class="easy-debt-text"><span class="easy-wallet-name">${escapeHtml(x.debt.personName)}</span><span class="easy-wallet-cur amount" data-value="${x.owed}">${escapeHtml(formatCurrency(x.owed, x.debt.currency))}</span></span></button>
          ${isSimpleDebt(x.debt) ? `<button type="button" class="easy-wallet easy-edit" data-edit="${i}" aria-label="${escapeHtml(t('Modifier {name}', { name: x.debt.personName }))}" title="${escapeHtml(t('Modifier {name}', { name: x.debt.personName }))}">${icon('edit', 26)}<span class="easy-remind-label">${escapeHtml(t('Modifier'))}</span></button>` : ''}
          ${kind === 'owed' ? `<button type="button" class="easy-wallet easy-remind" data-remind="${i}" aria-label="${escapeHtml(t('Relancer {name}', { name: x.debt.personName }))}" title="${escapeHtml(t('Relancer {name}', { name: x.debt.personName }))}">${icon('message', 26)}<span class="easy-remind-label">${escapeHtml(t('Relancer'))}</span></button>` : ''}
        </div>`).join('')}
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
    // « Relancer » : message WhatsApp / SMS prêt à envoyer (fenêtre de person-ledger.js, la même que sur l'écran Dettes), posée par-dessus.
    body.querySelectorAll('[data-remind]').forEach((btn) => btn.addEventListener('click', async () => {
      const picked = open[Number(btn.dataset.remind)];
      const [debts, payments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);
      openPersonReminder(picked.debt.personName, debts, payments);
    }));
    // « Modifier » : corriger la note ou la date de retour (fenêtre posée par-dessus) ; la liste se recharge après chaque correction ou annulation.
    body.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => {
      openEasyDebtFix(open[Number(btn.dataset.edit)].debt, kind, { onChange: reloadOpen });
    }));
    body.querySelector('#easy-new').addEventListener('click', () => { Object.assign(state, { mode: 'new', debt: null, amount: '', walletId: null, noWallet: false, due: '' }); go('who'); });
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

  /** Plus ancien jour possible : un remboursement ne peut pas précéder le prêt qu'il rembourse ; un nouveau prêt n'a pas de limite. */
  const earliestDay = () => (state.mode === 'repay' && state.debt?.startDate ? state.debt.startDate : '');
  /** « Quel jour ? » : aujourd'hui par défaut ; hier, avant-hier ou un autre jour (jamais dans le futur, jamais avant le prêt remboursé). */
  function dayChooserHtml() {
    const min = earliestDay();
    const quick = [0, 1, 2].map((back) => ({ back, iso: isoDaysAgo(back) }));
    const isOther = !quick.some((q) => q.iso === state.date);
    return `<div class="easy-date" role="group" aria-label="${escapeHtml(t('Quel jour ?'))}">
        <span class="easy-note-label">${escapeHtml(t('Quel jour ?'))}</span>
        <div class="easy-date-row">
          ${quick.map(({ back, iso }) => `<button type="button" class="btn easy-day ${state.date === iso ? 'is-on' : 'btn-ghost'}" data-day="${iso}" aria-pressed="${state.date === iso}" ${min && iso < min ? 'disabled' : ''}>${escapeHtml(dayLabel(back))}</button>`).join('')}
          <button type="button" class="btn easy-day ${isOther ? 'is-on' : 'btn-ghost'}" id="easy-day-other" aria-pressed="${isOther}">${escapeHtml(isOther ? formatDate(state.date) : t('Autre jour'))}</button>
        </div>
        <input type="date" id="easy-day-input" class="easy-day-input" ${min ? `min="${escapeHtml(min)}"` : ''} max="${todayISO()}" value="${escapeHtml(state.date)}" hidden aria-label="${escapeHtml(t('Choisir le jour'))}">
      </div>`;
  }

  function renderConfirm(body) {
    if (earliestDay() && state.date < earliestDay()) state.date = earliestDay() <= todayISO() ? earliestDay() : todayISO(); // un autre prêt a été choisi entre-temps
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
        ${!repay && state.due ? `<div class="easy-summary-line">${icon('history', 22)} ${escapeHtml(t('À rendre le {date}', { date: formatDate(state.due) }))}</div>` : ''}
      </div>
      ${dayChooserHtml()}
      ${repay ? '' : dueChooserHtml(kind, state.due, todayISO())}
      <div class="easy-note">
        <button type="button" class="btn btn-ghost easy-btn" id="easy-note-toggle" ${state.note ? 'hidden' : ''}>${icon('edit', 22)} ${escapeHtml(t('Ajouter une note'))}</button>
        <div class="easy-note-box" id="easy-note-box" ${state.note ? '' : 'hidden'}>
          <label class="easy-note-label" for="easy-note-input">${escapeHtml(t('Note (facultatif)'))}</label>
          <div class="easy-note-row">
            <input type="text" id="easy-note-input" maxlength="140" value="${escapeHtml(state.note)}" placeholder="${escapeHtml(t('Ex : pour le loyer, un cadeau…'))}" autocomplete="off">
            ${isVoiceSupported() ? `<button type="button" class="btn btn-ghost easy-btn easy-mic" id="easy-note-mic" aria-pressed="false" aria-label="${escapeHtml(t('Dicter la note'))}">${icon('mic', 26)}</button>` : ''}
          </div>
        </div>
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
    // Échéance (nouveau prêt seulement) : pas de date, dans 1 ou 2 semaines, dans 1 mois, ou un autre jour (jamais dans le passé).
    bindDueChooser(body, (iso) => { state.due = /^\d{4}-\d{2}-\d{2}$/.test(iso || '') && iso >= todayISO() ? iso : ''; renderConfirm(body); });
    // Jour de l'opération : jamais dans le futur, jamais avant le prêt que l'on rembourse (sinon on garde le jour actuel).
    const dayInput = body.querySelector('#easy-day-input');
    const chooseDay = (iso) => {
      const day = pastOrTodayISO(iso);
      if (!earliestDay() || day >= earliestDay()) state.date = day;
      renderConfirm(body);
    };
    body.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => chooseDay(b.dataset.day)));
    body.querySelector('#easy-day-other').addEventListener('click', () => { dayInput.hidden = false; if (dayInput.showPicker) { try { dayInput.showPicker(); } catch { dayInput.focus(); } } else dayInput.focus(); });
    dayInput.addEventListener('change', () => { if (dayInput.value) chooseDay(dayInput.value); });
    // Note facultative (au clavier ou dictée) : gardée si l'on change le jour ou l'échéance, ou si l'on corrige le montant puis revient.
    const noteInput = body.querySelector('#easy-note-input');
    body.querySelector('#easy-note-toggle').addEventListener('click', (e) => {
      e.currentTarget.hidden = true;
      body.querySelector('#easy-note-box').hidden = false;
      noteInput.focus();
      body.querySelector('#easy-note-box').scrollIntoView?.({ block: 'nearest' });
    });
    noteInput.addEventListener('input', () => { state.note = noteInput.value.slice(0, 140); });
    const micBtn = body.querySelector('#easy-note-mic');
    micBtn?.addEventListener('click', () => {
      if (noteListening) { noteListening.controller.stop(); return; }
      stopSpeaking(); // la voix de l'application ne doit pas être captée par le micro
      const session = listenOnce({ lang: getLanguage(), onInterim: (text) => { noteInput.value = text.slice(0, 140); } });
      noteListening = session;
      micBtn.classList.add('is-listening');
      micBtn.setAttribute('aria-pressed', 'true');
      session.promise.then((text) => { state.note = text.slice(0, 140); noteInput.value = state.note; })
        .catch((err) => showToast(err?.code === 'not-allowed' ? t("Le micro n'est pas autorisé : autorisez-le dans les réglages du navigateur.") : t("Je n'ai rien entendu. Réessayez ou écrivez la note.")))
        .finally(() => { if (noteListening === session) noteListening = null; micBtn.classList.remove('is-listening'); micBtn.setAttribute('aria-pressed', 'false'); });
    });
    body.querySelector('#easy-say')?.addEventListener('click', () => { primeSpeech(); speak(buildDebtSpeech(sentenceInfo({ left }))); });
    body.querySelector('#easy-fix').addEventListener('click', () => { noteListening?.controller.stop(); go('amount'); });
    body.querySelector('#easy-save').addEventListener('click', async (e) => {
      primeSpeech();
      const saveBtn = e.currentTarget;
      saveBtn.disabled = true; // un seul enregistrement, même en cas de double toucher
      const date = state.date;
      let undo;
      let balanceWalletId = state.walletId;
      if (repay) {
        const result = await recordSimplePayment(state.debt, { amount: n, walletId: state.walletId, date, note: state.note });
        if (!result) { saveBtn.disabled = false; showToast(t("Impossible d'enregistrer : vérifiez le montant et le portefeuille.")); return; }
        undo = () => undoSimplePayment(result);
      } else {
        const result = await createSimpleDebt({ type: debtType, personName: state.name, principal: n, currency: currency(), walletId: state.walletId, date, dueDate: state.due || null, note: state.note });
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
