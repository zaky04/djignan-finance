/* ==========================================================================
   GeoFinance System — Module Partage de dépenses
   Suivi façon Splitwise entre participants (colocation, voyage, couple…) :
   chaque dépense partagée est payée par une personne et répartie à parts
   égales entre les participants concernés ; le solde net de chacun indique
   qui doit combien au groupe. Indépendant des portefeuilles/dettes
   personnelles pour ne pas fausser le patrimoine net (voir ledger.js).
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbAdd, dbDelete, logAudit } from '../db.js';
import { uuid, formatCurrency, formatDate, escapeHtml, todayISO, openModal, confirmDialog, showToast, currencySelectHtml, wireCurrencySelect, readCurrencyValue } from '../utils.js';
import { notifyDataChanged } from '../state.js';

const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2h4v2H2V5h4l1-2Z"/></svg>';

/* ---------- Participants ---------- */
function participantRowHtml(p) {
  return `
    <div class="tx-row" data-participant-id="${p.id}">
      <div class="tx-main"><div class="tx-title">${escapeHtml(p.name)}</div></div>
      <div class="card-actions"><button type="button" class="icon-btn" data-action="delete-participant" title="Supprimer">${DELETE_ICON}</button></div>
    </div>`;
}

async function renderParticipantsPanel(container) {
  const participants = await dbGetAll(STORES.PARTICIPANTS);
  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Participants</h3></div>
      <form id="participant-form" class="filters-bar" style="align-items:flex-end;margin-bottom:${participants.length ? '10px' : '0'};">
        <div class="form-row" style="margin:0;flex:1;min-width:160px;"><label>Nom</label><input type="text" name="name" required maxlength="40" placeholder="Ex: Awa"></div>
        <button type="submit" class="btn btn-primary">Ajouter</button>
      </form>
      ${participants.map(participantRowHtml).join('')}
    </div>`;

  container.querySelector('#participant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const record = { id: uuid(), name: fd.get('name').trim() };
    if (!record.name) return;
    await dbAdd(STORES.PARTICIPANTS, record);
    showToast('Participant ajouté.');
    notifyDataChanged('participants');
  });

  container.querySelectorAll('[data-action="delete-participant"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-participant-id]').dataset.participantId;
      const ok = await confirmDialog('Supprimer ce participant ? Les dépenses partagées existantes le mentionnant resteront mais afficheront un nom inconnu.', { danger: true, confirmText: 'Supprimer' });
      if (!ok) return;
      await dbDelete(STORES.PARTICIPANTS, id);
      showToast('Participant supprimé.');
      notifyDataChanged('participants');
    });
  });
}

/* ---------- Dépenses partagées ---------- */
function sharedExpenseFormHtml(participants, defaultCurrency) {
  return `
    <form id="shared-expense-form">
      <div class="form-row"><label>Description</label><input type="text" name="description" required maxlength="80" placeholder="Ex: Courses, Essence, Hôtel…"></div>
      <div class="form-row"><label>Montant total</label><input type="number" step="0.01" min="0" name="amount" required></div>
      <div class="form-row"><label>Devise</label>${currencySelectHtml(defaultCurrency)}</div>
      <div class="form-row"><label>Payé par</label>
        <select name="paidBy" required>${participants.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>Réparti entre (parts égales)</label>
        ${participants.map((p) => `
          <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;padding:4px 0;cursor:pointer;">
            <input type="checkbox" name="splitAmong" value="${p.id}" checked> ${escapeHtml(p.name)}
          </label>`).join('')}
      </div>
      <div class="form-row"><label>Date</label><input type="date" name="date" value="${todayISO()}"></div>
      <button type="submit" class="btn btn-primary btn-block">Enregistrer</button>
    </form>`;
}

function openSharedExpenseModal(participants, defaultCurrency) {
  if (participants.length < 2) { showToast('Ajoutez au moins 2 participants avant de créer une dépense partagée.'); return; }
  const modal = openModal(sharedExpenseFormHtml(participants, defaultCurrency), { title: 'Nouvelle dépense partagée' });
  wireCurrencySelect(modal.el);
  const form = modal.el.querySelector('#shared-expense-form');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const splitAmong = fd.getAll('splitAmong');
    if (splitAmong.length < 1) { showToast('Sélectionnez au moins un participant.'); return; }
    const record = {
      id: uuid(),
      description: fd.get('description').trim(),
      amount: parseFloat(fd.get('amount')) || 0,
      currency: readCurrencyValue(form),
      paidBy: fd.get('paidBy'),
      splitAmong,
      date: fd.get('date') || todayISO(),
      settled: false,
      createdAt: new Date().toISOString(),
    };
    await dbAdd(STORES.SHARED_EXPENSES, record);
    await logAudit({ entityType: 'sharedExpense', entityId: record.id, action: 'create', after: record });
    modal.close();
    showToast('Dépense partagée enregistrée.');
    notifyDataChanged('sharedExpenses');
  });
}

function sharedExpenseRowHtml(exp, participants) {
  const payer = participants.find((p) => p.id === exp.paidBy);
  const names = exp.splitAmong.map((id) => participants.find((p) => p.id === id)?.name || '?').join(', ');
  return `
    <div class="tx-row" data-shared-expense-id="${exp.id}">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(exp.description)}</div>
        <div class="tx-sub">Payé par ${escapeHtml(payer?.name || '?')} · ${formatDate(exp.date)} · Partagé entre ${escapeHtml(names)}</div>
      </div>
      <div class="tx-amount amount">${formatCurrency(exp.amount, exp.currency)}</div>
      <div class="card-actions"><button type="button" class="icon-btn" data-action="delete-expense" title="Supprimer">${DELETE_ICON}</button></div>
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

function balancesPanelHtml(byCurrency, participants) {
  if (!byCurrency.size) return '';
  const sections = [...byCurrency.entries()].map(([currency, balances]) => `
    <div style="margin-bottom:10px;">
      <div style="font-size:12.5px;font-weight:700;color:var(--text-muted);margin-bottom:6px;">${escapeHtml(currency)}</div>
      ${participants.map((p) => {
        const bal = balances.get(p.id) || 0;
        if (Math.abs(bal) < 0.005) return `<div class="stat-row"><span class="stat-row-label">${escapeHtml(p.name)}</span><span>À jour</span></div>`;
        const label = bal > 0 ? 'Doit recevoir' : 'Doit au groupe';
        return `<div class="stat-row"><span class="stat-row-label">${escapeHtml(p.name)}</span><span class="badge ${bal > 0 ? 'badge-pos' : 'badge-neg'}">${label} · ${formatCurrency(Math.abs(bal), currency)}</span></div>`;
      }).join('')}
    </div>`).join('');
  return `<div class="panel" style="margin-bottom:16px;"><div class="panel-header"><h3>Soldes</h3></div>${sections}</div>`;
}

/* ---------- Point d'entrée du module ---------- */
export async function renderShared() {
  const container = document.getElementById('shared-content');
  if (!container) return;
  const [participants, expenses] = await Promise.all([dbGetAll(STORES.PARTICIPANTS), dbGetAll(STORES.SHARED_EXPENSES)]);
  const sortedExpenses = [...expenses].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const byCurrency = computeBalances(expenses, participants);

  container.innerHTML = `
    <div id="shared-participants"></div>
    ${balancesPanelHtml(byCurrency, participants)}
    <div class="panel">
      <div class="panel-header">
        <h3>Dépenses partagées</h3>
        <button type="button" class="btn btn-primary" id="shared-expense-add-btn">+ Nouvelle dépense</button>
      </div>
      ${sortedExpenses.length ? sortedExpenses.map((exp) => sharedExpenseRowHtml(exp, participants)).join('') : '<div class="empty-state">Aucune dépense partagée. Ajoutez des participants puis créez votre première dépense.</div>'}
    </div>`;

  await renderParticipantsPanel(document.getElementById('shared-participants'));

  container.querySelector('#shared-expense-add-btn').addEventListener('click', () => {
    openSharedExpenseModal(participants, participants[0] ? (expenses[0]?.currency || 'EUR') : 'EUR');
  });

  container.querySelectorAll('[data-action="delete-expense"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('[data-shared-expense-id]').dataset.sharedExpenseId;
      const exp = expenses.find((x) => x.id === id);
      const ok = await confirmDialog(`Supprimer la dépense "${exp?.description}" ?`, { danger: true, confirmText: 'Supprimer' });
      if (!ok) return;
      await dbDelete(STORES.SHARED_EXPENSES, id);
      await logAudit({ entityType: 'sharedExpense', entityId: id, action: 'delete', before: exp });
      showToast('Dépense supprimée.');
      notifyDataChanged('sharedExpenses');
    });
  });
}

export function initSharedModule() {}
