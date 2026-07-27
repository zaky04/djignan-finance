/* ==========================================================================
   GeoFinance System — Module Tableau de bord
   ========================================================================== */

import { formatCurrency, formatDate, formatPercent, escapeHtml, currentMonthKey, percentage, budgetProgressClass } from '../utils.js';
import { computeNetWorth, computeNetWorthHistory, computeMonthSummary, computeExpensesByCategory, computeBudgetVsActual, computeMonthlyBudgetSummary, computeEndOfMonthForecast, getEnrichedTransactions } from '../ledger.js';
import { renderExpensesByCategoryChart, renderNetWorthTrendChart, renderBudgetVsActualChart } from '../charts.js';

const TX_ICONS = {
  income: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 20V6M6 12l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  expense: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v14M6 12l6 6 6-6"/></svg>',
  transfer: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
};

function setAmount(el, value, currency) {
  if (!el) return;
  el.dataset.value = value;
  el.textContent = formatCurrency(value, currency);
}

function renderAlerts(budgetRows) {
  const stack = document.getElementById('dashboard-alerts');
  if (!stack) return;
  stack.innerHTML = '';
  const overBudget = budgetRows
    .map((r) => ({ ...r, pct: percentage(r.actual, r.budget) }))
    .filter((r) => r.pct >= 70)
    .sort((a, b) => b.pct - a.pct);

  for (const r of overBudget.slice(0, 4)) {
    const level = r.pct >= 90 ? 'danger' : 'warn';
    const div = document.createElement('div');
    div.className = `alert alert-${level}`;
    div.textContent = r.pct >= 100
      ? `Budget "${r.label}" dépassé (${r.pct.toFixed(0)}% utilisé)`
      : `Budget "${r.label}" à ${r.pct.toFixed(0)}% de la limite`;
    stack.appendChild(div);
  }
}

function txRowHtml(t) {
  const isTransfer = t.type === 'transfer';
  const title = isTransfer
    ? `${t.wallet?.name || '—'} → ${t.targetWallet?.name || '—'}`
    : (t.category?.name || 'Sans catégorie');
  const sub = `${escapeHtml(t.wallet?.name || '')} · ${formatDate(t.date)}${t.note ? ' · ' + escapeHtml(t.note) : ''}`;
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : '';
  const currency = t.wallet?.currency || 'EUR';

  return `
    <div class="tx-row">
      <div class="tx-icon">${TX_ICONS[t.type] || ''}</div>
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(title)}</div>
        <div class="tx-sub">${sub}</div>
      </div>
      <div class="tx-amount amount ${cls}" data-value="${t.amount}">${sign}${formatCurrency(t.amount, currency)}</div>
    </div>`;
}

function renderRecentTransactions(rows) {
  const container = document.getElementById('dashboard-recent-transactions');
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = '<div class="tx-empty">Aucune transaction pour le moment. Utilisez « Saisie express » pour commencer.</div>';
    return;
  }
  container.innerHTML = rows.map(txRowHtml).join('');
}

function watchCategoryRowHtml(r) {
  const pct = percentage(r.actual, r.budget);
  const cls = budgetProgressClass(pct);
  return `
    <div style="padding:10px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;justify-content:space-between;font-size:13.5px;font-weight:600;margin-bottom:6px;">
        <span>${escapeHtml(r.label)}</span>
        <span>${formatPercent(pct, 0)}</span>
      </div>
      <div class="progress-track"><div class="progress-fill ${cls}" style="width:${Math.min(pct, 100)}%"></div></div>
    </div>`;
}

function renderWatchCategories(budgetRows) {
  const container = document.getElementById('dashboard-watch-categories');
  if (!container) return;
  const top = budgetRows
    .filter((r) => r.budget > 0)
    .map((r) => ({ ...r, pct: percentage(r.actual, r.budget) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3);
  container.innerHTML = top.length
    ? top.map(watchCategoryRowHtml).join('')
    : '<div class="tx-empty">Aucun budget défini pour l\'instant.</div>';
}

function upcomingBillRowHtml(u, currency) {
  const sign = u.type === 'income' ? '+' : '−';
  const cls = u.type === 'income' ? 'pos' : 'neg';
  return `
    <div class="tx-row">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(u.name)}</div>
        <div class="tx-sub">${formatDate(u.nextDate)}</div>
      </div>
      <div class="tx-amount amount ${cls}">${sign}${formatCurrency(u.amountBase, currency)}</div>
    </div>`;
}

function renderUpcomingBills(upcoming, currency) {
  const container = document.getElementById('dashboard-upcoming-bills');
  if (!container) return;
  container.innerHTML = upcoming.length
    ? upcoming.slice(0, 5).map((u) => upcomingBillRowHtml(u, currency)).join('')
    : '<div class="tx-empty">Aucune échéance à venir ce mois-ci.</div>';
}

export async function renderDashboard() {
  const monthKey = currentMonthKey();

  const [{ total, currency }, summary, expensesByCategory, netWorthHistory, budgetVsActual, monthlyBudget, forecast, recentTx] = await Promise.all([
    computeNetWorth(),
    computeMonthSummary(monthKey),
    computeExpensesByCategory(monthKey),
    computeNetWorthHistory(6),
    computeBudgetVsActual(monthKey),
    computeMonthlyBudgetSummary(monthKey),
    computeEndOfMonthForecast(),
    getEnrichedTransactions({ limit: 8 }),
  ]);

  setAmount(document.getElementById('net-worth-value'), total, currency);

  const trendEl = document.getElementById('net-worth-trend');
  if (netWorthHistory.length >= 2) {
    const prev = netWorthHistory[netWorthHistory.length - 2].value;
    const diff = total - prev;
    const sign = diff >= 0 ? '+' : '';
    const pctLabel = prev !== 0 ? ` (${sign}${((diff / Math.abs(prev)) * 100).toFixed(1)}%)` : '';
    trendEl.textContent = `${sign}${formatCurrency(diff, currency)}${pctLabel} vs mois dernier`;
  } else {
    trendEl.textContent = 'Pas encore assez d\'historique';
  }

  setAmount(document.getElementById('budget-month-value'), monthlyBudget.totalBudget, monthlyBudget.currency);
  const budgetTrendEl = document.getElementById('budget-month-trend');
  if (monthlyBudget.totalBudget > 0) {
    const remainingLabel = monthlyBudget.remaining >= 0
      ? `Reste ${formatCurrency(monthlyBudget.remaining, monthlyBudget.currency)} ce mois-ci`
      : `Dépassé de ${formatCurrency(Math.abs(monthlyBudget.remaining), monthlyBudget.currency)}`;
    budgetTrendEl.textContent = `${formatCurrency(monthlyBudget.totalSpent, monthlyBudget.currency)} dépensé sur catégories budgétées · ${remainingLabel}`;
  } else {
    budgetTrendEl.textContent = 'Aucun budget défini pour ce mois — allez dans Budgets pour en attribuer';
  }

  const unallocatedBadge = document.getElementById('budget-unallocated-badge');
  if (summary.income > 0) {
    const unallocated = summary.income - monthlyBudget.totalBudget;
    unallocatedBadge.hidden = false;
    unallocatedBadge.textContent = unallocated >= 0
      ? `${formatCurrency(unallocated, monthlyBudget.currency)} non affecté`
      : `Budgets > revenu de ${formatCurrency(Math.abs(unallocated), monthlyBudget.currency)}`;
  } else {
    unallocatedBadge.hidden = true;
  }

  const upcomingBillsTotal = forecast.upcoming
    .filter((u) => u.type === 'expense')
    .reduce((sum, u) => sum + u.amountBase, 0);
  const reservedBudget = Math.max(0, monthlyBudget.remaining);
  const safeToSpend = forecast.current - upcomingBillsTotal - reservedBudget;
  setAmount(document.getElementById('safe-to-spend-value'), safeToSpend, forecast.currency);
  document.getElementById('hero-safe-to-spend').classList.toggle('is-negative', safeToSpend < 0);
  document.getElementById('safe-to-spend-trend').textContent = safeToSpend >= 0
    ? 'Après budgets réservés et échéances à venir'
    : '⚠ Dépenses prévues supérieures aux liquidités disponibles';

  const summaryEls = document.querySelectorAll('#view-dashboard .summary-card .summary-card-value');
  setAmount(summaryEls[0], summary.income, summary.currency);
  setAmount(summaryEls[1], summary.expenses, summary.currency);
  setAmount(summaryEls[2], summary.netSavings, summary.currency);
  setAmount(summaryEls[3], summary.cashFlow, summary.currency);

  renderExpensesByCategoryChart('chart-expenses-category', expensesByCategory, currency);
  renderNetWorthTrendChart('chart-net-worth-trend', netWorthHistory, currency);
  renderBudgetVsActualChart('chart-budget-vs-actual', budgetVsActual, currency);

  renderAlerts(budgetVsActual);
  renderRecentTransactions(recentTx);
  renderWatchCategories(budgetVsActual);
  renderUpcomingBills(forecast.upcoming, forecast.currency);
}
