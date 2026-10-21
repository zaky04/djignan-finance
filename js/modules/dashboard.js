/* ==========================================================================
   Djignan Financial System — Module Tableau de bord
   ========================================================================== */

import { formatCurrency, formatDate, formatMonthLabel, formatPercent, escapeHtml, currentMonthKey, monthKeyOffset, percentage, budgetProgressClass } from '../utils.js';
import { computeNetWorth, computeNetWorthHistory, computeNetWorthComposition, computeMonthSummary, computeExpensesByCategory, computeBudgetVsActual, computeMonthlyBudgetSummary, computeEndOfMonthForecast, getEnrichedTransactions, getUnconfirmedRates, computeBudgetSuggestions } from '../ledger.js';
import { renderExpensesByCategoryChart, renderBudgetVsActualChart, renderMultiTrendChart } from '../charts.js';
import { loadCashflowForecast } from '../forecast.js';
import { loadMonthlyRecap, recapHighlights, shareRecapImage } from '../monthly-recap.js';
import { STORES, dbGetAll, getSetting, setSetting } from '../db.js';
import { openBudgetSuggestions } from './budgets.js';
import { openQuickAdd } from './transactions.js';
import { getTemplates, recordTemplateNow, undoRecordedTemplate } from '../quick-templates.js';
import { notifyDataChanged } from '../state.js';
import { showToast } from '../utils.js';
import { getCloudAutoBackupAlert } from '../firebase-sync.js';
// Aliasé en tr (pas t) : ce fichier utilise déjà `t` comme nom de paramètre pour une transaction
// (voir txRowHtml(t)) — importer la fonction de traduction sous le même nom la masquerait
// silencieusement à l'intérieur de cette fonction (t('Sans catégorie') appellerait alors la
// transaction comme une fonction au lieu de traduire, TypeError immédiat).
import { t as tr } from '../i18n.js';
import { icon as svgIcon, knownCategoryLook } from '../icons.js';

export const DASHBOARD_PANEL_DEFAULTS = { watchCategories: true, upcomingBills: true, charts: true, recentTransactions: true, safeToSpend: true, netWorth: true, debtsBalance: true, favorites: true, forecast: true, recap: true };
export const BUDGET_ALERT_THRESHOLD_DEFAULTS = { warn: 70, danger: 90 };

const TX_ICONS = {
  income: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 20V6M6 12l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  expense: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v14M6 12l6 6 6-6"/></svg>',
  transfer: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
};

function renderMonthTrend(elId, current, previous, currency, invert = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  const diff = current - previous;
  const favorable = invert ? diff <= 0 : diff >= 0;
  const sign = diff >= 0 ? '+' : '';
  el.textContent = tr('{amount} vs mois dernier', { amount: `${sign}${formatCurrency(diff, currency)}` });
  el.classList.remove('pos', 'neg');
  el.classList.add(favorable ? 'pos' : 'neg');
}

function setAmount(el, value, currency) {
  if (!el) return;
  el.dataset.value = value;
  el.textContent = formatCurrency(value, currency);
}

function renderAlerts(budgetRows, thresholds, unconfirmedRates, currency) {
  const stack = document.getElementById('dashboard-alerts');
  if (!stack) return;
  stack.innerHTML = '';

  if (unconfirmedRates.length) {
    const div = document.createElement('div');
    div.className = 'alert alert-danger';
    const codes = unconfirmedRates.map((r) => r.code).join(', ');
    div.textContent = tr('Taux de change non confirmé pour {codes} (valeur 1:1 par défaut) — le patrimoine net affiché est probablement faux. À corriger dans Portefeuilles.', { codes });
    stack.appendChild(div);
  }

  const overBudget = budgetRows
    .map((r) => ({ ...r, pct: percentage(r.actual, r.budget) }))
    .filter((r) => r.pct >= thresholds.warn)
    .sort((a, b) => b.pct - a.pct);

  for (const r of overBudget.slice(0, 4)) {
    const level = r.pct >= thresholds.danger ? 'danger' : 'warn';
    const div = document.createElement('div');
    div.className = `alert alert-${level}`;
    div.textContent = r.pct >= 100
      ? tr('Budget "{label}" dépassé ({pct}% utilisé)', { label: r.label, pct: r.pct.toFixed(0) })
      : tr('Budget "{label}" à {pct}% de la limite', { label: r.label, pct: r.pct.toFixed(0) });
    stack.appendChild(div);
  }

  // Alerte prédictive : catégories pas encore signalées ci-dessus (sous le seuil), mais dont le
  // rythme de dépense actuel projette un dépassement avant la fin du mois — prévient AVANT le
  // fait plutôt que de constater après coup, seule chose que les alertes ci-dessus font. Ignore
  // les tout premiers jours du mois : sur 1-4 jours de données, une seule dépense matinale suffit
  // à fausser complètement l'extrapolation (même garde-fou que checkUnusualExpense, ledger.js,
  // qui exige un minimum d'historique avant de se fier à une moyenne).
  const overBudgetIds = new Set(overBudget.map((r) => r.categoryId));
  const now = new Date();
  const daysElapsed = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (daysElapsed >= 5 && daysElapsed < daysInMonth) {
    const projected = budgetRows
      .filter((r) => r.budget > 0 && !overBudgetIds.has(r.categoryId))
      .map((r) => ({ ...r, projectedTotal: (r.actual / daysElapsed) * daysInMonth }))
      .filter((r) => r.projectedTotal > r.budget)
      .sort((a, b) => b.projectedTotal / b.budget - a.projectedTotal / a.budget);

    for (const r of projected.slice(0, 2)) {
      const overshootDay = Math.min(daysInMonth, Math.max(daysElapsed + 1, Math.ceil((r.budget / r.projectedTotal) * daysInMonth)));
      const div = document.createElement('div');
      div.className = 'alert alert-warn';
      div.textContent = tr('Au rythme actuel, le budget "{label}" sera dépassé de {amount} vers le {day}.', {
        label: r.label,
        amount: formatCurrency(r.projectedTotal - r.budget, currency),
        day: overshootDay,
      });
      stack.appendChild(div);
    }
  }
}

/** Rappel quand aucun budget n'est défini pour le mois en cours alors qu'il y a assez d'historique
    pour en suggérer (voir computeBudgetSuggestions, ledger.js). Asynchrone et non bloquant : le
    calcul relit tout l'historique, donc l'alerte s'ajoute à la pile une fois prête plutôt que de
    retarder le rendu du tableau de bord. Ignorable pour le mois en cours (réapparaît le mois
    suivant). Le garde `data-budget-suggest` évite un doublon si deux rendus se chevauchent. */
async function maybeShowBudgetSuggestionReminder(monthKey) {
  if ((await getSetting('budgetSuggestionDismissedMonth', null)) === monthKey) return;
  const data = await computeBudgetSuggestions(monthKey);
  if (data.insufficient || !data.rows.length) return;
  const stack = document.getElementById('dashboard-alerts');
  if (!stack || stack.querySelector('[data-budget-suggest]')) return;

  const div = document.createElement('div');
  div.className = 'alert alert-info';
  div.dataset.budgetSuggest = '1';
  const text = document.createElement('span');
  text.textContent = tr('Vos budgets pour {month} ne sont pas encore définis.', { month: formatMonthLabel(monthKey) });
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn btn-ghost alert-action';
  open.textContent = tr('Voir les suggestions');
  open.addEventListener('click', () => openBudgetSuggestions(monthKey));
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'icon-btn';
  dismiss.textContent = '✕';
  dismiss.setAttribute('aria-label', tr('Ignorer pour ce mois'));
  dismiss.addEventListener('click', async () => {
    await setSetting('budgetSuggestionDismissedMonth', monthKey);
    div.remove();
  });
  div.append(text, open, dismiss);
  stack.appendChild(div);
}

/** Pastille de la ligne : icône et couleur de la catégorie quand elle en a une, sinon la flèche entrée/sortie/virement. */
function txIconHtml(t) {
  const look = t.type !== 'transfer' ? knownCategoryLook(t.category) : null;
  if (!look) return `<div class="tx-icon">${TX_ICONS[t.type] || ''}</div>`;
  const color = escapeHtml(look.color);
  return `<div class="tx-icon" style="color:${color};background:${color}22;">${svgIcon(look.icon, 18)}</div>`;
}

function txRowHtml(t) {
  const isTransfer = t.type === 'transfer';
  const title = isTransfer
    ? `${t.wallet?.name || '—'} → ${t.targetWallet?.name || '—'}`
    : (t.category?.name || tr('Sans catégorie'));
  const sub = `${escapeHtml(t.wallet?.name || '')} · ${formatDate(t.date)}${t.note ? ' · ' + escapeHtml(t.note) : ''}${t.splitGroupId ? ' · ' + tr('Scindée') : ''}`;
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : '';
  const currency = t.wallet?.currency || 'EUR';
  const tagsHtml = t.tags?.length ? `<div class="tx-tags">${t.tags.map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join('')}</div>` : '';

  return `
    <div class="tx-row">
      ${txIconHtml(t)}
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(title)}</div>
        <div class="tx-sub">${sub}</div>
        ${tagsHtml}
      </div>
      <div class="tx-amount amount ${cls}" data-value="${t.amount}">${sign}${formatCurrency(t.amount, currency)}</div>
    </div>`;
}

function renderRecentTransactions(rows) {
  const container = document.getElementById('dashboard-recent-transactions');
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="tx-empty">${tr('Aucune transaction pour le moment. Utilisez « Saisie express » pour commencer.')}</div>`;
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
    : `<div class="tx-empty">${tr("Aucun budget défini pour l'instant.")}</div>`;
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
    : `<div class="tx-empty">${tr('Aucune échéance à venir ce mois-ci.')}</div>`;
}

/** "Bonjour" en journée, "Bonsoir" le soir/la nuit — convention française usuelle (bascule à 18h,
    reste sur "Bonsoir" jusqu'à l'aube). Heure locale de l'appareil, pas UTC : un salut affiché au
    mauvais moment de la journée n'a pas de sens. */
function greetingWord() {
  const hour = new Date().getHours();
  return tr(hour >= 18 || hour < 5 ? 'Bonsoir' : 'Bonjour');
}

/* ---------- Prévision de trésorerie 30/60 jours (voir forecast.js) ---------- */
let forecastDays = 30;
const FORECAST_KIND_LABELS = { recurring: 'Récurrent', debt: 'Dette à rembourser', receivable: 'Créance à encaisser', tontine: 'Cotisation de tontine', pot: 'Pot de tontine' };

async function renderForecast(panelEl) {
  const forecast = await loadCashflowForecast(forecastDays);
  const cur = forecast.currency;
  panelEl.hidden = false;
  panelEl.querySelectorAll('#forecast-days [data-days]').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.days) === forecastDays));

  const headline = document.getElementById('forecast-headline');
  const chartWrap = document.getElementById('forecast-chart-wrap');
  const emptyCta = document.getElementById('forecast-empty-cta');
  // Rien de connu à venir : on garde le panneau VISIBLE (sinon la fonction reste introuvable) avec
  // l'explication de ce qui l'alimente, au lieu de le masquer.
  const empty = !forecast.events.length;
  chartWrap.hidden = empty;
  emptyCta.hidden = !empty;
  if (empty) {
    headline.className = '';
    headline.textContent = tr('Rien de prévu pour les {days} prochains jours.', { days: forecastDays });
    document.getElementById('forecast-note').textContent = tr("La prévision se remplit avec vos récurrences (loyer, abonnements), les échéances de vos dettes et créances, et vos tontines — elle ne prévoit pas les dépenses courantes.");
    document.getElementById('forecast-events').innerHTML = '';
    return;
  }
  if (forecast.firstNegativeDate) {
    headline.className = 'neg';
    headline.textContent = tr('⚠ Solde négatif prévu le {date} (plus bas : {amount}).', { date: formatDate(forecast.firstNegativeDate), amount: formatCurrency(forecast.minBalance, cur) });
  } else {
    headline.className = '';
    headline.textContent = tr('Dans {days} jours : {end} (au plus bas {min} le {date}).', { days: forecastDays, end: formatCurrency(forecast.endBalance, cur), min: formatCurrency(forecast.minBalance, cur), date: formatDate(forecast.minDate) });
  }
  document.getElementById('forecast-note').textContent = tr("Calculé d'après vos récurrences, échéances de dettes et tontines — pas vos dépenses courantes (courses, transport…).");

  const step = forecastDays > 30 ? 3 : 2;
  const sampled = forecast.points.filter((_, i) => i % step === 0 || i === forecast.points.length - 1);
  const label = (p) => formatDate(p.date, { day: '2-digit', month: 'short' });
  const series = [{ label: tr('Solde prévu'), points: sampled.map((p) => ({ label: label(p), value: Math.round(p.balance) })) }];
  if (forecast.points.some((p) => Math.round(p.optimistic) !== Math.round(p.balance))) {
    series.push({ label: tr('Si tout est encaissé'), dashed: true, points: sampled.map((p) => ({ label: label(p), value: Math.round(p.optimistic) })) });
  }
  renderMultiTrendChart('chart-forecast', series, cur);

  document.getElementById('forecast-events').innerHTML = forecast.events.slice(0, 6).map((ev) => `
    <div class="tx-row">
      <div class="tx-main"><div class="tx-title">${escapeHtml(ev.label)}${ev.certain ? '' : ` <span class="badge badge-warn">${tr('incertain')}</span>`}</div>
        <div class="tx-sub">${formatDate(ev.date)} · ${tr(FORECAST_KIND_LABELS[ev.kind] || '')}</div></div>
      <div class="tx-amount amount ${ev.amount >= 0 ? 'pos' : 'neg'}">${ev.amount >= 0 ? '+' : '−'}${formatCurrency(Math.abs(ev.amount), cur)}</div>
    </div>`).join('');
}

/* ---------- Bilan du mois (voir monthly-recap.js) : visible aussi en mode simple, où Rapports est masqué ---------- */
let dashboardRecapMonth = null;

async function renderRecapPanel(panelEl) {
  // Le mois en cours s'il a déjà des opérations, sinon le mois précédent (début de mois).
  let monthKey = currentMonthKey();
  let recap = await loadMonthlyRecap(monthKey);
  if (!recap.hasData) { monthKey = monthKeyOffset(monthKey, -1); recap = await loadMonthlyRecap(monthKey); }
  if (!recap.hasData) { panelEl.hidden = true; dashboardRecapMonth = null; return; }
  dashboardRecapMonth = monthKey;
  panelEl.hidden = false;
  document.getElementById('recap-dash-title').textContent = tr('Bilan — {month}', { month: formatMonthLabel(monthKey) });
  document.getElementById('recap-dash-lines').innerHTML = recapHighlights(recap).slice(0, 3).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
}

/* ---------- Favoris : un toucher = l'opération d'aujourd'hui (voir quick-templates.js) ---------- */
let favoriteItems = new Map();

async function renderFavorites(panelEl) {
  const [templates, wallets] = await Promise.all([getTemplates(), dbGetAll(STORES.WALLETS)]);
  favoriteItems = new Map(templates.map((x) => [x.id, x]));
  // Toujours visible : sans favori, le panneau explique comment en créer (sinon la fonction reste cachée).
  panelEl.hidden = false;
  const container = document.getElementById('dashboard-favorites');
  if (!container) return;
  if (!templates.length) {
    container.innerHTML = `<p class="tx-sub" style="margin:0;">${tr("Aucun favori pour l'instant. Dans « Saisie express », remplissez une opération que vous refaites souvent (ex : « Taxi », 1 500) puis touchez « Garder comme favori ».")}</p>`;
    return;
  }
  container.innerHTML = templates.map((x) => {
    const cur = wallets.find((w) => w.id === x.walletId)?.currency || 'EUR';
    const amount = x.amount > 0 ? ` · ${escapeHtml(formatCurrency(x.amount, cur))}` : '';
    const sign = x.type === 'income' ? '+' : '−';
    return `<button type="button" class="qa-chip" data-favorite-id="${x.id}">${sign} ${escapeHtml(x.label)}${amount}</button>`;
  }).join('');
}

async function onFavoriteClick(event) {
  const btn = event.target.closest('[data-favorite-id]');
  const tpl = btn && favoriteItems.get(btn.dataset.favoriteId);
  if (!tpl) return;
  if (!(tpl.amount > 0)) { openQuickAdd({ prefill: tpl }); return; } // montant variable : on le demande
  btn.disabled = true; // évite un double enregistrement par double-clic
  const record = await recordTemplateNow(tpl);
  if (!record) {
    btn.disabled = false;
    showToast(tr('Ce favori ne peut plus être enregistré (portefeuille supprimé ou archivé). Retirez-le dans Saisie express.'));
    return;
  }
  notifyDataChanged('transactions');
  showToast(tr('{label} enregistré.', { label: tpl.label }), {
    actionLabel: tr('Annuler'),
    onAction: async () => { await undoRecordedTemplate(record); notifyDataChanged('transactions'); showToast(tr('Annulé.')); },
  });
}

/** Câblage une seule fois des éléments statiques de index.html (favoris, partage du bilan, prévision) —
    ils ne sont pas régénérés à chaque renderDashboard(), contrairement au reste du tableau de bord. */
export function initDashboardModule() {
  document.getElementById('dashboard-favorites')?.addEventListener('click', onFavoriteClick);
  document.getElementById('recap-dash-share')?.addEventListener('click', async () => {
    if (!dashboardRecapMonth) return;
    const outcome = await shareRecapImage(await loadMonthlyRecap(dashboardRecapMonth));
    if (outcome === 'downloaded') showToast(tr("Image téléchargée : envoyez-la depuis votre galerie."));
  });
  document.getElementById('forecast-days')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-days]');
    if (!btn) return;
    forecastDays = Number(btn.dataset.days) === 60 ? 60 : 30;
    renderForecast(document.getElementById('panel-forecast')).catch((err) => console.warn('[Prévision]', err));
  });
}

export async function renderDashboard() {
  const monthKey = currentMonthKey();
  const panels = { ...DASHBOARD_PANEL_DEFAULTS, ...(await getSetting('dashboardPanels', {})) };
  const thresholds = { ...BUDGET_ALERT_THRESHOLD_DEFAULTS, ...(await getSetting('budgetAlertThresholds', {})) };

  const profile = await getSetting('userProfile', {});
  const greetingEl = document.getElementById('dashboard-greeting');
  if (greetingEl) greetingEl.textContent = profile.firstName ? `${greetingWord()}, ${profile.firstName}` : '';

  const watchEl = document.getElementById('panel-watch-categories');
  const billsEl = document.getElementById('panel-upcoming-bills');
  if (watchEl) watchEl.hidden = !panels.watchCategories;
  if (billsEl) billsEl.hidden = !panels.upcomingBills;
  const panelsGridEl = document.getElementById('dashboard-panels-grid');
  if (panelsGridEl) panelsGridEl.hidden = !panels.watchCategories && !panels.upcomingBills;
  const chartsEl = document.getElementById('dashboard-charts-grid');
  if (chartsEl) chartsEl.hidden = !panels.charts;
  const recentEl = document.getElementById('panel-recent-transactions');
  if (recentEl) recentEl.hidden = !panels.recentTransactions;
  const safeToSpendEl = document.getElementById('panel-safe-to-spend-dash');
  if (safeToSpendEl) safeToSpendEl.hidden = !panels.safeToSpend;
  const netWorthEl = document.getElementById('panel-net-worth-dash');
  if (netWorthEl) netWorthEl.hidden = !panels.netWorth;
  const debtsBalanceEl = document.getElementById('panel-debts-balance-dash');
  if (debtsBalanceEl) debtsBalanceEl.hidden = !panels.debtsBalance;
  const positionEl = document.getElementById('panel-position-dash');
  if (positionEl) positionEl.hidden = !panels.netWorth && !panels.debtsBalance;

  const [summary, prevSummary, expensesByCategory, netWorthHistory, budgetVsActual, monthlyBudget, forecast, recentTx, netWorth, composition, unconfirmedRates] = await Promise.all([
    computeMonthSummary(monthKey),
    computeMonthSummary(monthKeyOffset(monthKey, -1)),
    computeExpensesByCategory(monthKey),
    computeNetWorthHistory(2),
    computeBudgetVsActual(monthKey),
    computeMonthlyBudgetSummary(monthKey),
    computeEndOfMonthForecast(),
    getEnrichedTransactions({ limit: 8 }),
    computeNetWorth(),
    computeNetWorthComposition(),
    getUnconfirmedRates(),
  ]);
  const currency = summary.currency;

  if (panels.safeToSpend) {
    const upcomingBillsTotal = forecast.upcoming.filter((u) => u.type === 'expense').reduce((sum, u) => sum + u.amountBase, 0);
    const reservedBudget = Math.max(0, monthlyBudget.remaining);
    const safeToSpend = forecast.current - upcomingBillsTotal - reservedBudget;
    setAmount(document.getElementById('dash-safe-to-spend-value'), safeToSpend, forecast.currency);
    safeToSpendEl?.classList.toggle('is-negative', safeToSpend < 0);
    const dailyEl = document.getElementById('dash-safe-to-spend-daily');
    if (dailyEl) {
      // Uniquement quand il reste un solde positif : un "reste à vivre" négatif divisé en
      // montant/jour n'a pas de sens à afficher (déjà couvert par le message d'alerte ci-dessous).
      if (safeToSpend > 0) {
        const now = new Date();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const daysRemaining = daysInMonth - now.getDate() + 1; // aujourd'hui inclus
        const daily = safeToSpend / daysRemaining;
        dailyEl.textContent = tr('Soit {amount}/jour sur les {days} jour(s) restant(s)', { amount: formatCurrency(daily, forecast.currency), days: daysRemaining });
        dailyEl.hidden = false;
      } else {
        dailyEl.hidden = true;
      }
    }
    const safeTrendEl = document.getElementById('dash-safe-to-spend-trend');
    if (safeTrendEl) {
      safeTrendEl.textContent = safeToSpend >= 0
        ? tr('Après budgets réservés et échéances à venir')
        : tr('⚠ Dépenses prévues supérieures aux liquidités disponibles');
    }
  }

  if (panels.netWorth) {
    setAmount(document.getElementById('dash-net-worth-value'), netWorth.total, netWorth.currency);
    const netWorthTrendEl = document.getElementById('dash-net-worth-trend');
    if (netWorthTrendEl) {
      if (netWorthHistory.length >= 2) {
        const prev = netWorthHistory[netWorthHistory.length - 2].value;
        const diff = netWorth.total - prev;
        const sign = diff >= 0 ? '+' : '';
        const pctLabel = prev !== 0 ? ` (${sign}${((diff / Math.abs(prev)) * 100).toFixed(1)}%)` : '';
        netWorthTrendEl.textContent = tr('{amount} vs mois dernier', { amount: `${sign}${formatCurrency(diff, netWorth.currency)}${pctLabel}` });
      } else {
        netWorthTrendEl.textContent = tr("Pas encore assez d'historique");
      }
    }
  }

  if (panels.debtsBalance) {
    setAmount(document.getElementById('dash-receivables-value'), composition.receivables, composition.currency);
    setAmount(document.getElementById('dash-debts-value'), composition.debts, composition.currency);
    setAmount(document.getElementById('dash-debts-net-value'), composition.receivables - composition.debts, composition.currency);
  }

  renderMonthTrend('summary-trend-income', summary.income, prevSummary.income, currency);
  renderMonthTrend('summary-trend-expenses', summary.expenses, prevSummary.expenses, currency, true);
  renderMonthTrend('summary-trend-netSavings', summary.netSavings, prevSummary.netSavings, currency);
  renderMonthTrend('summary-trend-cashFlow', summary.cashFlow, prevSummary.cashFlow, currency);

  setAmount(document.getElementById('budget-month-value'), monthlyBudget.totalBudget, monthlyBudget.currency);
  const budgetTrendEl = document.getElementById('budget-month-trend');
  if (monthlyBudget.totalBudget > 0) {
    // Tolérance d'un demi-centime (même convention que ledger.js/debts.js) : évite qu'un budget
    // respecté "pile" affiche "Dépassé de 0,00 €" à cause d'un résidu flottant infime.
    const remainingLabel = monthlyBudget.remaining >= -0.005
      ? tr('Reste {amount} ce mois-ci', { amount: formatCurrency(monthlyBudget.remaining, monthlyBudget.currency) })
      : tr('Dépassé de {amount}', { amount: formatCurrency(Math.abs(monthlyBudget.remaining), monthlyBudget.currency) });
    budgetTrendEl.textContent = tr('{spent} dépensé sur catégories budgétées · {remainingLabel}', {
      spent: formatCurrency(monthlyBudget.totalSpent, monthlyBudget.currency), remainingLabel,
    });
  } else {
    budgetTrendEl.textContent = tr('Aucun budget défini pour ce mois — allez dans Budgets pour en attribuer');
  }

  const unallocatedBadge = document.getElementById('budget-unallocated-badge');
  if (summary.income > 0) {
    const unallocated = summary.income - monthlyBudget.totalBudget;
    unallocatedBadge.hidden = false;
    unallocatedBadge.textContent = unallocated >= 0
      ? tr('{amount} non affecté', { amount: formatCurrency(unallocated, monthlyBudget.currency) })
      : tr('Budgets > revenu de {amount}', { amount: formatCurrency(Math.abs(unallocated), monthlyBudget.currency) });
  } else {
    unallocatedBadge.hidden = true;
  }

  setAmount(document.getElementById('dash-income-value'), summary.income, summary.currency);
  setAmount(document.getElementById('dash-expenses-value'), summary.expenses, summary.currency);
  setAmount(document.getElementById('dash-netsavings-value'), summary.netSavings, summary.currency);
  setAmount(document.getElementById('dash-cashflow-value'), summary.cashFlow, summary.currency);

  if (panels.charts) {
    renderExpensesByCategoryChart('chart-expenses-category', expensesByCategory, currency);
    renderBudgetVsActualChart('chart-budget-vs-actual', budgetVsActual, currency);
  }

  renderAlerts(budgetVsActual, thresholds, unconfirmedRates, currency);
  // Sauvegarde cloud automatique en pause ou en échec : à voir ICI, pas seulement dans Paramètres.
  getCloudAutoBackupAlert().then((message) => {
    const stack = document.getElementById('dashboard-alerts');
    if (!message || !stack || stack.querySelector('[data-cloud-auto-alert]')) return;
    const div = document.createElement('div');
    div.className = 'alert alert-warn';
    div.dataset.cloudAutoAlert = '1';
    div.textContent = message;
    stack.appendChild(div);
  }).catch(() => {});
  if (budgetVsActual.every((r) => !(r.budget > 0))) maybeShowBudgetSuggestionReminder(monthKey).catch((err) => console.warn('[BudgetSuggest]', err));
  const forecastEl = document.getElementById('panel-forecast');
  if (forecastEl) {
    if (panels.forecast) await renderForecast(forecastEl).catch((err) => { forecastEl.hidden = true; console.warn('[Prévision]', err); });
    else forecastEl.hidden = true;
  }
  const recapEl = document.getElementById('panel-recap');
  if (recapEl) {
    if (panels.recap) await renderRecapPanel(recapEl).catch((err) => { recapEl.hidden = true; console.warn('[Bilan]', err); });
    else recapEl.hidden = true;
  }
  const favoritesEl = document.getElementById('panel-favorites');
  if (favoritesEl) {
    if (panels.favorites) await renderFavorites(favoritesEl);
    else favoritesEl.hidden = true;
  }
  if (panels.recentTransactions) renderRecentTransactions(recentTx);
  if (panels.watchCategories) renderWatchCategories(budgetVsActual);
  if (panels.upcomingBills) renderUpcomingBills(forecast.upcoming, forecast.currency);
}
