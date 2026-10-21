/* ==========================================================================
   Djignan Financial System — Module Partage de dépenses
   Suivi façon Splitwise entre participants (colocation, voyage, couple…) :
   chaque dépense partagée est payée par une personne et répartie à parts
   égales entre les participants concernés. Si un participant est marqué
   "Moi", le reliquat réel devient une vraie dette/créance (module Dettes &
   créances, voir debts.js) plutôt qu'un simple solde informatif :
   - Si "Moi" est le payeur : le MONTANT TOTAL (pas ma part) est enregistré
     comme une vraie dépense personnelle tout de suite (c'est cet argent-là
     qui a réellement quitté mon portefeuille) ; chaque AUTRE participant
     inclus dans la répartition devient une créance ("on me doit") pour sa
     part, réglable depuis Dettes & créances (le remboursement y crée alors
     une vraie transaction de recette).
   - Si "Moi" fait partie de la répartition mais n'est PAS le payeur : rien
     ne bouge tout de suite dans mon portefeuille (je n'ai encore rien payé
     en réalité) ; ma part devient une dette ("je dois") envers le payeur,
     réglable depuis Dettes & créances quand je le rembourse réellement.
   Ce découpage évite le double comptage qu'aurait causé l'ancien
   comportement (débiter "ma part" immédiatement ET compter séparément le
   remboursement réel plus tard). */

import { STORES, dbGetAll, dbPut, dbAdd, dbDelete, logAudit, getSetting } from '../db.js';
import { uuid, formatCurrency, formatDate, escapeHtml, todayISO, openModal, confirmDialog, showToast, currencySelectHtml, wireCurrencySelect, readCurrencyValue, safeNumber } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { isDailyWallet } from '../ledger.js';
import { t } from '../i18n.js';
import { createLinkedDebt, deleteDebtCascade } from './debts.js';
import { icon as svgIcon } from '../icons.js';

const EDIT_ICON = svgIcon('edit', 16);
const DELETE_ICON = svgIcon('trash', 16);

/* ---------- Participants ---------- */
function participantRowHtml(p) {
  return `
    <div class="tx-row" data-participant-id="${p.id}">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(p.name)} ${p.isMe ? `<span class="badge badge-accent">${t('Moi')}</span>` : ''}</div>
      </div>
      <div class="card-actions">
        ${!p.isMe ? `<button type="button" class="btn btn-ghost fs-13" data-action="set-me" style="padding:4px 10px;">${t('Définir comme moi')}</button>` : ''}
        <button type="button" class="icon-btn" data-action="delete-participant" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${DELETE_ICON}</button>
      </div>
    </div>`;
}

async function renderParticipantsPanel(container) {
  const participants = await dbGetAll(STORES.PARTICIPANTS);
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Participants')}</h3></div>
      <form id="participant-form" class="filters-bar" style="align-items:flex-end;margin-bottom:${participants.length ? '10px' : '0'};">
        <div class="form-row m-0" style="flex:1;min-width:160px;"><label>${t('Nom')}</label><input type="text" name="name" required maxlength="40" placeholder="${t('Ex: Awa')}"></div>
        <button type="submit" class="btn btn-primary">${t('Ajouter')}</button>
      </form>
      ${participants.map(participantRowHtml).join('')}
    </div>`;

  container.querySelector('#participant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const record = { id: uuid(), name: fd.get('name').trim() };
    if (!record.name) return;
    await dbAdd(STORES.PARTICIPANTS, record);
    showToast(t('Participant ajouté.'));
    notifyDataChanged('participants');
  });

  container.querySelectorAll('[data-action="delete-participant"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-participant-id]').dataset.participantId;
      const ok = await confirmDialog(t('Supprimer ce participant ? Les dépenses partagées existantes le mentionnant resteront mais afficheront un nom inconnu.'), { danger: true, requirePin: true, confirmText: t('Supprimer') });
      if (!ok) return;
      await dbDelete(STORES.PARTICIPANTS, id);
      showToast(t('Participant supprimé.'));
      notifyDataChanged('participants');
    });
  });

  container.querySelectorAll('[data-action="set-me"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-participant-id]').dataset.participantId;
      const previousMe = participants.find((p) => p.isMe);
      if (previousMe) await dbPut(STORES.PARTICIPANTS, { ...previousMe, isMe: false });
      const target = participants.find((p) => p.id === id);
      await dbPut(STORES.PARTICIPANTS, { ...target, isMe: true });
      showToast(t('{name} défini comme "Moi".', { name: target.name }));
      notifyDataChanged('participants');
    });
  });
}

/* ---------- Dépenses partagées ---------- */
function categoryOptionsHtml(categories) {
  const roots = categories.filter((c) => c.type === 'expense' && !c.parentId);
  let html = `<option value="">${t('Sans catégorie')}</option>`;
  for (const r of roots) {
    html += `<option value="${r.id}">${escapeHtml(r.name)}</option>`;
    for (const child of categories.filter((c) => c.parentId === r.id)) {
      html += `<option value="${child.id}">— ${escapeHtml(child.name)}</option>`;
    }
  }
  return html;
}

function walletOptionsHtml(wallets, currency) {
  const matching = wallets.filter((w) => w.currency === currency);
  if (!matching.length) return `<option value="">${t('Aucun portefeuille en {currency}', { currency: escapeHtml(currency) })}</option>`;
  return matching.map((w) => `<option value="${w.id}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('');
}

function sharedExpenseFormHtml(participants, defaultCurrency, meParticipant) {
  return `
    <form id="shared-expense-form">
      <div class="form-row"><label>${t('Description')}</label><input type="text" name="description" required maxlength="80" placeholder="${t('Ex: Courses, Essence, Hôtel…')}"></div>
      <div class="form-row"><label>${t('Montant total')}</label><input type="number" step="0.01" min="0" name="amount" required></div>
      <div class="form-row"><label>${t('Devise')}</label>${currencySelectHtml(defaultCurrency)}</div>
      <div class="form-row"><label>${t('Payé par')}</label>
        <select name="paidBy" required>${participants.map((p) => `<option value="${p.id}" ${meParticipant?.id === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>${t('Réparti entre (parts égales)')}</label>
        ${participants.map((p) => `
          <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;" class="fs-14">
            <input type="checkbox" name="splitAmong" value="${p.id}" ${meParticipant ? `data-is-me="${p.id === meParticipant.id}"` : ''} checked> ${escapeHtml(p.name)}
          </label>`).join('')}
      </div>
      <div class="form-row"><label>${t('Date')}</label><input type="date" name="date" value="${todayISO()}"></div>
      ${meParticipant ? `
      <div data-field="payerFields">
        <p style="margin:0 0 10px;" class="fs-12 c-muted">${t("Vous avez payé : le montant total sera enregistré tout de suite dans vos transactions. La part de chaque autre participant deviendra une créance à régler dans Dettes & créances.")}</p>
        <div class="form-row"><label>${t('Catégorie')}</label><select name="categoryId"></select></div>
        <div class="form-row"><label>${t('Portefeuille')}</label><select name="walletId"></select></div>
      </div>
      <p data-field="oweNotice" style="margin:0 0 10px;" hidden class="fs-12 c-muted">${t("Quelqu'un d'autre a payé : votre part deviendra une dette à régler dans Dettes & créances, sans toucher vos transactions tout de suite.")}</p>` : ''}
      <button type="submit" class="btn btn-primary btn-block">${t('Enregistrer')}</button>
    </form>`;
}

async function openSharedExpenseModal(participants, defaultCurrency) {
  if (participants.length < 2) { showToast(t('Ajoutez au moins 2 participants avant de créer une dépense partagée.')); return; }
  const meParticipant = participants.find((p) => p.isMe) || null;
  const [categories, wallets] = await Promise.all([dbGetAll(STORES.CATEGORIES), dbGetAll(STORES.WALLETS)]);
  const activeWallets = wallets.filter(isDailyWallet);
  const modal = openModal(sharedExpenseFormHtml(participants, defaultCurrency, meParticipant), { title: t('Nouvelle dépense partagée') });
  wireCurrencySelect(modal.el);
  const form = modal.el.querySelector('#shared-expense-form');
  const payerFields = modal.el.querySelector('[data-field="payerFields"]');
  const oweNotice = modal.el.querySelector('[data-field="oweNotice"]');
  const categorySelect = form.elements.categoryId;
  const walletSelect = form.elements.walletId;
  const paidBySelect = form.elements.paidBy;

  if (meParticipant) {
    categorySelect.innerHTML = categoryOptionsHtml(categories);
    const refreshWalletOptions = () => { walletSelect.innerHTML = walletOptionsHtml(activeWallets, readCurrencyValue(form)); };
    // Visible selon QUI paie (pas selon qui fait partie de la répartition) : c'est le paiement du
    // montant total qui a besoin d'un portefeuille/catégorie, pas ma seule part — voir le
    // commentaire d'en-tête du fichier pour le raisonnement complet.
    const syncPayerFieldsVisibility = () => {
      const isMePaying = paidBySelect.value === meParticipant.id;
      const meInSplit = form.querySelector(`[data-is-me="true"]`)?.checked;
      payerFields.hidden = !isMePaying;
      oweNotice.hidden = isMePaying || !meInSplit;
    };
    paidBySelect.addEventListener('change', syncPayerFieldsVisibility);
    form.querySelectorAll('[name="splitAmong"]').forEach((cb) => cb.addEventListener('change', syncPayerFieldsVisibility));
    modal.el.querySelectorAll('[data-currency-select], [data-currency-other]').forEach((el) => {
      el.addEventListener('change', refreshWalletOptions);
      el.addEventListener('input', refreshWalletOptions);
    });
    refreshWalletOptions();
    syncPayerFieldsVisibility();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const splitAmong = fd.getAll('splitAmong');
    if (splitAmong.length < 1) { showToast(t('Sélectionnez au moins un participant.')); return; }
    if (!(safeNumber(parseFloat(fd.get('amount'))) > 0)) { showToast(t('Saisissez un montant supérieur à 0.')); return; }
    const currency = readCurrencyValue(form);
    const record = {
      id: uuid(),
      description: fd.get('description').trim(),
      amount: safeNumber(parseFloat(fd.get('amount'))),
      currency,
      paidBy: fd.get('paidBy'),
      splitAmong,
      date: fd.get('date') || todayISO(),
      settled: false,
      myTransactionId: null,
      createdAt: new Date().toISOString(),
    };
    const share = record.amount / splitAmong.length;
    const isMePaying = meParticipant && record.paidBy === meParticipant.id;
    const iOwe = meParticipant && !isMePaying && splitAmong.includes(meParticipant.id);
    let touchesMoney = false;

    if (isMePaying) {
      const walletId = fd.get('walletId');
      if (!walletId) { showToast(t("Créez d'abord un portefeuille en {currency}.", { currency })); return; }
      // Le montant TOTAL, pas ma part : c'est cet argent-là qui quitte réellement mon portefeuille
      // tout de suite (voir commentaire d'en-tête du fichier).
      const myTx = {
        id: uuid(),
        type: 'expense',
        walletId,
        targetWalletId: null,
        categoryId: fd.get('categoryId') || null,
        amount: record.amount,
        date: record.date,
        note: t('Partagé — {description}', { description: record.description }),
        tags: [],
        reconciled: false,
        sharedExpenseId: record.id,
        createdAt: new Date().toISOString(),
      };
      await dbAdd(STORES.TRANSACTIONS, myTx);
      await logAudit({ entityType: 'transaction', entityId: myTx.id, action: 'create', after: myTx, note: t('Paiement (dépense partagée)') });
      record.myTransactionId = myTx.id;
      touchesMoney = true;

      // Chaque AUTRE participant inclus dans la répartition me doit sa part : une vraie créance,
      // réglable depuis Dettes & créances (pas de transaction d'ouverture ici — l'argent a déjà
      // bougé via myTx ci-dessus, une transaction d'ouverture en plus doublerait le montant compté).
      for (const pid of splitAmong) {
        if (pid === meParticipant.id) continue;
        const participant = participants.find((p) => p.id === pid);
        await createLinkedDebt({
          type: 'receivable',
          personName: participant?.name || '?',
          principal: share,
          currency,
          startDate: record.date,
          note: t('Part de « {description} »', { description: record.description }),
          sharedExpenseId: record.id,
        });
      }
    } else if (iOwe) {
      // Rien ne bouge dans mon portefeuille maintenant (je n'ai encore rien payé en réalité) : ma
      // part devient une dette envers le payeur, réglée plus tard depuis Dettes & créances.
      const payer = participants.find((p) => p.id === record.paidBy);
      await createLinkedDebt({
        type: 'debt',
        personName: payer?.name || '?',
        principal: share,
        currency,
        startDate: record.date,
        note: t('Part de « {description} »', { description: record.description }),
        sharedExpenseId: record.id,
      });
      touchesMoney = true; // pas une transaction, mais notifyDataChanged('all') reste nécessaire (onglet Dettes)
    }

    await dbAdd(STORES.SHARED_EXPENSES, record);
    await logAudit({ entityType: 'sharedExpense', entityId: record.id, action: 'create', after: record });
    modal.close();
    showToast(t('Dépense partagée enregistrée.'));
    notifyDataChanged(touchesMoney ? 'all' : 'sharedExpenses');
  });
}

function remainingOf(debt, payments) {
  const paid = payments.filter((p) => p.debtId === debt.id).reduce((s, p) => s + p.amount, 0);
  return Math.max(0, (debt.principal || 0) - paid);
}

/** Statut de règlement d'une dépense partagée, dérivé en direct des dettes/créances qu'elle a
    générées (pas d'un champ stocké séparément — évite tout risque de désynchronisation si l'une
    d'elles est réglée ou supprimée directement depuis Dettes & créances). */
function settlementStatusHtml(linkedDebts, payments, currency) {
  if (!linkedDebts.length) return '';
  const remaining = linkedDebts.reduce((s, d) => s + remainingOf(d, payments), 0);
  if (remaining <= 0.005) return `<span class="badge badge-pos">${t('Réglé')}</span>`;
  return `<span class="badge badge-neg">${t('{amount} restant · voir Dettes & créances', { amount: formatCurrency(remaining, currency) })}</span>`;
}

function sharedExpenseRowHtml(exp, participants, linkedDebts, payments) {
  const payer = participants.find((p) => p.id === exp.paidBy);
  const names = exp.splitAmong.map((id) => participants.find((p) => p.id === id)?.name || '?').join(', ');
  return `
    <div class="tx-row" data-shared-expense-id="${exp.id}">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(exp.description)}</div>
        <div class="tx-sub">${t('Payé par {payer} · {date} · Partagé entre {names}', { payer: escapeHtml(payer?.name || '?'), date: formatDate(exp.date), names: escapeHtml(names) })}</div>
        <div class="tx-sub">${settlementStatusHtml(linkedDebts, payments, exp.currency)}</div>
      </div>
      <div class="tx-amount amount">${formatCurrency(exp.amount, exp.currency)}</div>
      <div class="card-actions"><button type="button" class="icon-btn" data-action="delete-expense" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${DELETE_ICON}</button></div>
    </div>`;
}

/* ---------- Soldes nets par devise ---------- */
function computeBalances(expenses, participants) {
  const byCurrency = new Map();
  for (const exp of expenses) {
    if (!byCurrency.has(exp.currency)) byCurrency.set(exp.currency, new Map(participants.map((p) => [p.id, 0])));
    const balances = byCurrency.get(exp.currency);
    const share = exp.splitAmong.length ? exp.amount / exp.splitAmong.length : 0;
    if (balances.has(exp.paidBy)) balances.set(exp.paidBy, balances.get(exp.paidBy) + exp.amount);
    for (const pid of exp.splitAmong) {
      if (balances.has(pid)) balances.set(pid, balances.get(pid) - share);
    }
  }
  return byCurrency;
}

function balancesPanelHtml(byCurrency, participants, meParticipant) {
  if (!byCurrency.size) return '';
  const sections = [...byCurrency.entries()].map(([currency, balances]) => `
    <div class="mb-10">
      <div class="fs-13 fw-700 c-muted mb-6">${escapeHtml(currency)}</div>
      ${participants.map((p) => {
        // La ligne "Moi" ne montre PAS ce solde brut (il ignore les remboursements déjà réglés
        // via Dettes & créances, donc redeviendrait trompeur dès le premier règlement partiel) :
        // le vrai reliquat, à jour, se lit sur chaque dette/créance individuelle là-bas.
        if (meParticipant && p.id === meParticipant.id) {
          return `<div class="stat-row"><span class="stat-row-label">${escapeHtml(p.name)}</span><span class="c-muted fs-13">${t('→ voir Dettes & créances')}</span></div>`;
        }
        const bal = balances.get(p.id) || 0;
        if (Math.abs(bal) < 0.005) return `<div class="stat-row"><span class="stat-row-label">${escapeHtml(p.name)}</span><span>${t('À jour')}</span></div>`;
        const label = bal > 0 ? t('Doit recevoir') : t('Doit au groupe');
        return `<div class="stat-row"><span class="stat-row-label">${escapeHtml(p.name)}</span><span class="badge ${bal > 0 ? 'badge-pos' : 'badge-neg'}">${label} · ${formatCurrency(Math.abs(bal), currency)}</span></div>`;
      }).join('')}
    </div>`).join('');
  return `<div class="panel mb-16"><div class="panel-header"><h3>${t('Soldes')}</h3></div>${sections}</div>`;
}

/* ---------- Point d'entrée du module ---------- */
export async function renderShared() {
  const container = document.getElementById('shared-content');
  if (!container) return;
  const [participants, expenses, debts, debtPayments] = await Promise.all([
    dbGetAll(STORES.PARTICIPANTS), dbGetAll(STORES.SHARED_EXPENSES), dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS),
  ]);
  const meParticipant = participants.find((p) => p.isMe) || null;
  const sortedExpenses = [...expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const byCurrency = computeBalances(expenses, participants);
  const debtsByExpense = (expenseId) => debts.filter((d) => d.sharedExpenseId === expenseId);

  container.innerHTML = `
    <div id="shared-participants"></div>
    ${balancesPanelHtml(byCurrency, participants, meParticipant)}
    <div class="panel">
      <div class="panel-header">
        <h3>${t('Dépenses partagées')}</h3>
        <button type="button" class="btn btn-primary" id="shared-expense-add-btn">${t('+ Nouvelle dépense')}</button>
      </div>
      ${sortedExpenses.length
        ? sortedExpenses.map((exp) => sharedExpenseRowHtml(exp, participants, debtsByExpense(exp.id), debtPayments)).join('')
        : `<div class="empty-state">${t('Aucune dépense partagée. Ajoutez des participants puis créez votre première dépense.')}</div>`}
    </div>`;

  await renderParticipantsPanel(document.getElementById('shared-participants'));

  container.querySelector('#shared-expense-add-btn').addEventListener('click', async () => {
    // Devise de la dernière dépense partagée, sinon devise de base : un défaut codé en dur à EUR
    // faisait échouer l'enregistrement d'une dépense payée par « moi » (« Créez d'abord un
    // portefeuille en EUR ») pour tout utilisateur dont les portefeuilles sont en XOF/XAF.
    const baseCurrency = await getSetting('baseCurrency', 'EUR');
    openSharedExpenseModal(participants, expenses[0]?.currency || baseCurrency);
  });

  container.querySelectorAll('[data-action="delete-expense"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-shared-expense-id]').dataset.sharedExpenseId;
      const exp = expenses.find((x) => x.id === id);
      const linkedDebts = debtsByExpense(id);
      const message = exp?.myTransactionId || linkedDebts.length
        ? t('Supprimer la dépense "{description}" ? Votre part personnelle liée, ainsi que les dettes/créances (et leurs remboursements déjà enregistrés) issues de cette dépense, seront aussi retirées.', { description: exp?.description })
        : t('Supprimer la dépense "{description}" ?', { description: exp?.description });
      const ok = await confirmDialog(message, { danger: true, requirePin: true, confirmText: t('Supprimer') });
      if (!ok) return;
      const myTx = exp?.myTransactionId ? (await dbGetAll(STORES.TRANSACTIONS)).find((t2) => t2.id === exp.myTransactionId) : null;
      await dbDelete(STORES.SHARED_EXPENSES, id);
      if (myTx) await dbDelete(STORES.TRANSACTIONS, myTx.id);
      const removedDebts = [];
      for (const d of linkedDebts) {
        const removed = await deleteDebtCascade(d.id);
        if (removed) removedDebts.push(removed);
      }
      await logAudit({ entityType: 'sharedExpense', entityId: id, action: 'delete', before: exp });
      showToast(t('Dépense supprimée.'), {
        actionLabel: t('Annuler'),
        onAction: async () => {
          await dbAdd(STORES.SHARED_EXPENSES, exp);
          if (myTx) await dbAdd(STORES.TRANSACTIONS, myTx);
          for (const removed of removedDebts) {
            await dbAdd(STORES.DEBTS, removed.debt);
            for (const p of removed.payments) await dbAdd(STORES.DEBT_PAYMENTS, p);
            for (const t2 of removed.linkedTx) await dbAdd(STORES.TRANSACTIONS, t2);
          }
          await logAudit({ entityType: 'sharedExpense', entityId: id, action: 'create', after: exp, note: t('Restaurée (annulation)') });
          showToast(t('Restauré.'));
          notifyDataChanged('all');
        },
      });
      notifyDataChanged('all');
    });
  });
}

export function initSharedModule() {}
