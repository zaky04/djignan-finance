/* ==========================================================================
   GeoFinance System — Module Dettes & Créances
   Suivi des remboursements + simulateur stratégique Avalanche / Boule de neige.
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbDelete, dbAdd, logAudit, getSetting } from '../db.js';
import { getExchangeRates } from '../ledger.js';
import { uuid, formatCurrency, formatDate, formatPercent, escapeHtml, todayISO, percentage, convertAmount, openModal, confirmDialog, showToast, currencySelectHtml, wireCurrencySelect, readCurrencyValue } from '../utils.js';
import { notifyDataChanged } from '../state.js';

const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2h4v2H2V5h4l1-2Z"/></svg>';
const PAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>';

function remaining(debt, payments) {
  const paid = payments.filter((p) => p.debtId === debt.id).reduce((s, p) => s + p.amount, 0);
  return Math.max(0, (debt.principal || 0) - paid);
}

function debtCardHtml(d, payments) {
  const paid = (debt_paid_of(d, payments));
  const rem = Math.max(0, (d.principal || 0) - paid);
  const pct = percentage(paid, d.principal);
  const isDebt = d.type === 'debt';
  return `
    <div class="summary-card" data-debt-id="${d.id}">
      <div class="card-title-row">
        <div>
          <span class="badge ${isDebt ? 'badge-neg' : 'badge-pos'}">${isDebt ? 'Dette' : 'Créance'}</span>
          <div style="font-weight:700;font-size:14.5px;margin-top:6px;">${escapeHtml(d.personName)}</div>
          ${d.note ? `<div class="tx-sub">${escapeHtml(d.note)}</div>` : ''}
        </div>
        <div class="card-actions">
          <button type="button" class="icon-btn" data-action="pay" title="Enregistrer un remboursement">${PAY_ICON}</button>
          <button type="button" class="icon-btn" data-action="edit" title="Modifier">${EDIT_ICON}</button>
          <button type="button" class="icon-btn" data-action="delete" title="Supprimer">${DELETE_ICON}</button>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${Math.min(pct, 100)}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-muted);margin:6px 0 10px;">
        <span>Remboursé : ${formatCurrency(paid, d.currency)}</span>
        <span>${formatPercent(pct, 0)}</span>
      </div>
      <div class="stat-row"><span class="stat-row-label">Montant initial</span><span>${formatCurrency(d.principal, d.currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">Restant dû</span><span class="amount" data-value="${rem}">${formatCurrency(rem, d.currency)}</span></div>
      ${d.interestRate ? `<div class="stat-row"><span class="stat-row-label">Taux d'intérêt annuel</span><span>${formatPercent(d.interestRate, 1)}</span></div>` : ''}
      ${d.dueDate ? `<div class="stat-row"><span class="stat-row-label">Échéance</span><span>${formatDate(d.dueDate)}</span></div>` : ''}
    </div>`;
}
function debt_paid_of(d, payments) {
  return payments.filter((p) => p.debtId === d.id).reduce((s, p) => s + p.amount, 0);
}

function debtFormHtml(d, defaultCurrency) {
  return `
    <form id="debt-form">
      <div class="segmented" data-field="type">
        <button type="button" class="segmented-btn ${(!d || d.type === 'debt') ? 'is-active' : ''}" data-value="debt">Dette (je dois)</button>
        <button type="button" class="segmented-btn ${d?.type === 'receivable' ? 'is-active' : ''}" data-value="receivable">Créance (on me doit)</button>
      </div>
      <input type="hidden" name="type" value="${d?.type || 'debt'}">
      <div class="form-row"><label>Nom de la personne / organisme</label><input type="text" name="personName" required maxlength="60" value="${escapeHtml(d?.personName || '')}"></div>
      <div class="form-row"><label>Montant</label><input type="number" step="0.01" min="0" name="principal" required value="${d?.principal ?? ''}"></div>
      <div class="form-row"><label>Devise</label>${currencySelectHtml(d?.currency || defaultCurrency)}</div>
      <div class="form-row"><label>Taux d'intérêt annuel % (optionnel)</label><input type="number" step="0.01" min="0" name="interestRate" value="${d?.interestRate ?? ''}"></div>
      <div class="form-row"><label>Date de départ</label><input type="date" name="startDate" value="${d?.startDate || todayISO()}"></div>
      <div class="form-row"><label>Échéance (optionnel)</label><input type="date" name="dueDate" value="${d?.dueDate || ''}"></div>
      <div class="form-row"><label>Note (optionnel)</label><input type="text" name="note" maxlength="140" value="${escapeHtml(d?.note || '')}"></div>
      <button type="submit" class="btn btn-primary btn-block">${d ? 'Enregistrer' : 'Créer'}</button>
    </form>`;
}

async function openDebtModal(d = null) {
  const defaultCurrency = d ? d.currency : await getSetting('baseCurrency', 'EUR');
  const modal = openModal(debtFormHtml(d, defaultCurrency), { title: d ? 'Modifier' : 'Nouvelle dette / créance' });
  wireCurrencySelect(modal.el);
  let currentType = d?.type || 'debt';
  modal.el.querySelectorAll('.segmented-btn').forEach((b) => b.addEventListener('click', () => {
    currentType = b.dataset.value;
    modal.el.querySelector('[name="type"]').value = currentType;
    modal.el.querySelectorAll('.segmented-btn').forEach((x) => x.classList.toggle('is-active', x === b));
  }));

  modal.el.querySelector('#debt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const before = d ? { ...d } : null;
    const record = {
      id: d?.id || uuid(),
      type: currentType,
      personName: fd.get('personName').trim(),
      principal: parseFloat(fd.get('principal')) || 0,
      currency: readCurrencyValue(e.target),
      interestRate: parseFloat(fd.get('interestRate')) || 0,
      startDate: fd.get('startDate') || todayISO(),
      dueDate: fd.get('dueDate') || null,
      status: d?.status || 'active',
      note: (fd.get('note') || '').trim().slice(0, 140),
    };
    await dbPut(STORES.DEBTS, record);
    await logAudit({ entityType: 'debt', entityId: record.id, action: d ? 'update' : 'create', before, after: record });
    modal.close();
    showToast(d ? 'Mis à jour.' : 'Créé.');
    notifyDataChanged('debts');
  });
}

function openPaymentModal(d) {
  const modal = openModal(`
    <form id="payment-form">
      <div class="form-row"><label>Montant remboursé</label><input type="number" step="0.01" min="0" name="amount" required autofocus></div>
      <div class="form-row"><label>Date</label><input type="date" name="date" value="${todayISO()}"></div>
      <div class="form-row"><label>Note (optionnel)</label><input type="text" name="note" maxlength="140"></div>
      <button type="submit" class="btn btn-primary btn-block">Enregistrer</button>
    </form>`, { title: `Remboursement — ${d.personName}` });

  modal.el.querySelector('#payment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payment = { id: uuid(), debtId: d.id, amount: parseFloat(fd.get('amount')) || 0, date: fd.get('date'), note: (fd.get('note') || '').trim().slice(0, 140) };
    await dbAdd(STORES.DEBT_PAYMENTS, payment);
    await logAudit({ entityType: 'debtPayment', entityId: payment.id, action: 'create', after: payment });

    const payments = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === d.id);
    const rem = remaining(d, payments);
    if (rem <= 0.005 && d.status !== 'paid') {
      const before = { ...d };
      d.status = 'paid';
      await dbPut(STORES.DEBTS, d);
      await logAudit({ entityType: 'debt', entityId: d.id, action: 'update', before, after: d, note: 'Soldée' });
    }
    modal.close();
    showToast('Remboursement enregistré.');
    notifyDataChanged('debts');
  });
}

/* ---------- Simulateur Avalanche / Boule de neige ---------- */
function simulateRepayment(debts, payments, monthlyBudget, method, rates, baseCurrency) {
  const list = debts
    .filter((d) => d.type === 'debt' && d.status === 'active')
    .map((d) => ({
      id: d.id,
      name: d.personName,
      balance: convertAmount(remaining(d, payments), d.currency, baseCurrency, rates, baseCurrency),
      rate: (d.interestRate || 0) / 100 / 12,
    }))
    .filter((d) => d.balance > 0.005);

  if (method === 'avalanche') list.sort((a, b) => b.rate - a.rate);
  else list.sort((a, b) => a.balance - b.balance);

  let month = 0, totalInterest = 0;
  const payoffMonth = {};
  while (list.some((d) => d.balance > 0.005) && month < 600) {
    month++;
    for (const d of list) {
      if (d.balance > 0) { const interest = d.balance * d.rate; d.balance += interest; totalInterest += interest; }
    }
    let budget = monthlyBudget;
    for (const d of list) {
      if (d.balance <= 0 || budget <= 0) continue;
      const pay = Math.min(budget, d.balance);
      d.balance -= pay;
      budget -= pay;
      if (d.balance <= 0.005 && !payoffMonth[d.id]) payoffMonth[d.id] = month;
    }
  }
  return {
    months: month,
    maxedOut: month >= 600,
    totalInterest,
    order: list.map((d) => ({ name: d.name, payoffMonth: payoffMonth[d.id] || null })).sort((a, b) => (a.payoffMonth || 999) - (b.payoffMonth || 999)),
  };
}

function renderSimulatorResult(result, method, currency) {
  if (result.maxedOut) {
    return `<div class="alert alert-danger">Avec ce budget mensuel, les intérêts dépassent votre capacité de remboursement (${method}). Augmentez le montant mensuel.</div>`;
  }
  const years = (result.months / 12).toFixed(1);
  return `
    <div class="panel" style="margin-bottom:12px;">
      <div class="panel-header"><h3>${method === 'avalanche' ? 'Avalanche (taux le plus élevé d\'abord)' : 'Boule de neige (plus petit montant d\'abord)'}</h3></div>
      <div class="stat-row"><span class="stat-row-label">Durée totale estimée</span><span>${result.months} mois (~${years} ans)</span></div>
      <div class="stat-row"><span class="stat-row-label">Intérêts totaux payés</span><span>${formatCurrency(result.totalInterest, currency)}</span></div>
      <div style="margin-top:8px;font-size:12.5px;color:var(--text-muted);">
        Ordre de remboursement : ${result.order.map((o, i) => `${i + 1}. ${escapeHtml(o.name)} (mois ${o.payoffMonth || '—'})`).join(' · ')}
      </div>
    </div>`;
}

async function renderSimulator(container) {
  const { baseCurrency } = await getExchangeRates();
  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Simulateur de remboursement stratégique</h3></div>
      <div class="form-row" style="max-width:260px;">
        <label>Budget mensuel disponible (en ${escapeHtml(baseCurrency)}) pour rembourser vos dettes</label>
        <input type="number" min="0" step="10" id="sim-budget" value="200">
      </div>
      <button type="button" class="btn btn-primary" id="sim-run-btn">Comparer Avalanche vs Boule de neige</button>
    </div>
    <div id="sim-results"></div>`;

  container.querySelector('#sim-run-btn').addEventListener('click', async () => {
    const budget = parseFloat(container.querySelector('#sim-budget').value) || 0;
    const [debts, payments, { rates, baseCurrency: base }] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS), getExchangeRates()]);
    const avalanche = simulateRepayment(debts, payments, budget, 'avalanche', rates, base);
    const snowball = simulateRepayment(debts, payments, budget, 'snowball', rates, base);
    const results = document.getElementById('sim-results');
    results.innerHTML = renderSimulatorResult(avalanche, 'avalanche', base) + renderSimulatorResult(snowball, 'snowball', base);
  });
}

export async function renderDebts() {
  const container = document.getElementById('debts-content');
  if (!container) return;
  const [debts, payments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);

  const cardsHtml = debts.length
    ? `<div class="grid-cards" style="margin-bottom:20px;">${debts.map((d) => debtCardHtml(d, payments)).join('')}</div>`
    : '<div class="empty-state">Aucune dette ni créance enregistrée.</div>';

  container.innerHTML = `${cardsHtml}<div id="debts-simulator"></div>`;
  await renderSimulator(document.getElementById('debts-simulator'));
}

export function initDebtsModule() {
  document.getElementById('debt-add-btn')?.addEventListener('click', () => openDebtModal());

  document.getElementById('debts-content')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('[data-debt-id]');
    if (!card) return;
    const debts = await dbGetAll(STORES.DEBTS);
    const d = debts.find((x) => x.id === card.dataset.debtId);
    if (!d) return;

    if (btn.dataset.action === 'pay') {
      openPaymentModal(d);
    } else if (btn.dataset.action === 'edit') {
      openDebtModal(d);
    } else if (btn.dataset.action === 'delete') {
      const ok = await confirmDialog(`Supprimer "${d.personName}" et tout son historique de remboursement ?`, { danger: true, confirmText: 'Supprimer' });
      if (ok) {
        const payments = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === d.id);
        for (const p of payments) await dbDelete(STORES.DEBT_PAYMENTS, p.id);
        await dbDelete(STORES.DEBTS, d.id);
        await logAudit({ entityType: 'debt', entityId: d.id, action: 'delete', before: d });
        showToast('Supprimé.');
        notifyDataChanged('debts');
      }
    }
  });
}
