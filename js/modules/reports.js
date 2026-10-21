/* ==========================================================================
   Djignan Financial System — Module Rapports
   Génération d'un bilan PDF (patrimoine, résumé mensuel, dépenses par
   catégorie, budget vs réel) et export CSV des transactions.
   ========================================================================== */

import {
  computeNetWorth, computeMonthSummary, computeExpensesByCategory, computeBudgetVsActual, computeCategoryActuals,
  computeMonthlyTypeHistory, getCategoriesByType, computeMonthlyNetSavingsHistory, computeMonthlyBudgetVsActualHistory, computeNetWorthHistoryForYear,
  computeNetWorthComposition, computeInvestmentEntryTotals, computeTagSummary,
} from '../ledger.js';
import { formatCurrency, formatMonthLabel, currentMonthKey, monthKeyOffset, localISODate, showToast, escapeHtml } from '../utils.js';
import { exportTransactionsCsv, exportInvestmentEntriesCsv } from '../backup.js';
import { STORES, dbGetAll, getSetting } from '../db.js';
import { healthScorePanelHtml, calendarPanelHtml, wireCalendarPanel } from './reports-extras.js';
import { renderExpensesByCategoryChart, renderNetWorthTrendChart, renderBudgetVsActualChart, renderMultiTrendChart, renderNetSavingsBarChart } from '../charts.js';
import { loadMonthlyRecap, recapHighlights, recapAsText, shareRecapImage } from '../monthly-recap.js';
import { t } from '../i18n.js';

/** formatCurrency() insère des espaces insécables/fines (ex: séparateur de milliers en fr-FR) que
    la police intégrée de jsPDF (Helvetica, encodage WinAnsi) ne sait pas dessiner — elle affiche à
    la place un caractère de repli qui ressemble à "/". On les remplace par un espace normal
    uniquement pour le rendu PDF (l'affichage à l'écran, lui, garde le formatage Intl d'origine). */
const PDF_UNSAFE_SPACES_RE = new RegExp('[' + [0x202f, 0x00a0, 0x2009, 0x2007].map((c) => String.fromCharCode(c)).join('') + ']', 'g');
function pdfAmount(amount, currency) {
  return formatCurrency(amount, currency).replace(PDF_UNSAFE_SPACES_RE, ' ');
}

function profileHeaderLines(profile) {
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  return [fullName, profile.jobTitle, profile.address, profile.phone].filter(Boolean);
}

let reportMonthKey = currentMonthKey();
let reportYear = parseInt(currentMonthKey().slice(0, 4), 10);

// État des filtres de la section Graphiques — persiste entre les re-rendus de renderReports()
// (navigation mois/année), même principe que reportMonthKey/reportYear ci-dessus.
let repExpensesCategoryId = '';
let repIncomeCategoryId = '';
let repBudgetCategoryId = '';
let repExpensesCompareYoY = false;
let repIncomeCompareYoY = false;
let repSavingsAsPercent = false;

async function categoryOptionsHtml(type, selectedId) {
  const cats = await getCategoriesByType(type);
  return `<option value="">${t('Toutes catégories')}</option>` +
    cats.map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

/** Onglets « Dépenses et revenus » et « Budget et patrimoine » : les graphiques de Rapports, répartis par
    sujet au lieu d'un seul mur de sept cartes. Les graphiques annuels partagent le sélecteur d'année de
    la barre de période (reportYear), ceux du mois le sélecteur de mois (reportMonthKey) — un seul
    réglage cohérent sur toute la page. */
async function spendingTabHtml() {
  const [expenseCatOptions, incomeCatOptions] = await Promise.all([
    categoryOptionsHtml('expense', repExpensesCategoryId),
    categoryOptionsHtml('income', repIncomeCategoryId),
  ]);
  return `
    <div class="charts-grid">
      <div class="chart-card">
        <h3>${t('Dépenses par catégorie')} <span class="chart-card-period">· ${formatMonthLabel(reportMonthKey)}</span></h3>
        <div class="chart-canvas-wrap"><canvas id="rep-chart-expenses-category"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-head">
          <h3>${t('Variation mensuelle des dépenses')}</h3>
          <div class="chart-card-controls">
            <label class="chart-card-check">
              <input type="checkbox" id="rep-expenses-compare" ${repExpensesCompareYoY ? 'checked' : ''}> ${t("Comparer à l'année précédente")}
            </label>
            <select id="rep-expenses-category">${expenseCatOptions}</select>
          </div>
        </div>
        <div class="chart-canvas-wrap"><canvas id="rep-chart-expenses-trend"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-head">
          <h3>${t('Variation mensuelle des entrées')}</h3>
          <div class="chart-card-controls">
            <label class="chart-card-check">
              <input type="checkbox" id="rep-income-compare" ${repIncomeCompareYoY ? 'checked' : ''}> ${t("Comparer à l'année précédente")}
            </label>
            <select id="rep-income-category">${incomeCatOptions}</select>
          </div>
        </div>
        <div class="chart-canvas-wrap"><canvas id="rep-chart-income-trend"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-head">
          <h3>${t('Épargne nette mensuelle')}</h3>
          <label class="chart-card-check">
            <input type="checkbox" id="rep-savings-percent" ${repSavingsAsPercent ? 'checked' : ''}> ${t('Afficher en %')}
          </label>
        </div>
        <div class="chart-canvas-wrap"><canvas id="rep-chart-net-savings"></canvas></div>
      </div>
    </div>`;
}

async function budgetTabHtml() {
  const budgetCatOptions = await categoryOptionsHtml('expense', repBudgetCategoryId);
  return `
    <div class="charts-grid">
      <div class="chart-card">
        <h3>${t('Budget vs réel')} <span class="chart-card-period">· ${formatMonthLabel(reportMonthKey)}</span></h3>
        <div class="chart-canvas-wrap"><canvas id="rep-chart-budget-vs-actual"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-card-head">
          <h3>${t('Budget vs réel — tendance annuelle')}</h3>
          <select id="rep-budget-category">${budgetCatOptions}</select>
        </div>
        <div class="chart-canvas-wrap"><canvas id="rep-chart-budget-trend"></canvas></div>
      </div>
      <div class="chart-card chart-card-full">
        <h3>${t('Évolution de la valeur nette')}</h3>
        <div class="chart-canvas-wrap"><canvas id="rep-chart-net-worth"></canvas></div>
      </div>
    </div>`;
}

async function refreshExpensesTrendChart() {
  const { points, currency } = await computeMonthlyTypeHistory(reportYear, 'expense', repExpensesCategoryId || null);
  const series = [{ label: String(reportYear), points }];
  if (repExpensesCompareYoY) {
    const { points: prevPoints } = await computeMonthlyTypeHistory(reportYear - 1, 'expense', repExpensesCategoryId || null);
    series.push({ label: String(reportYear - 1), points: prevPoints, dashed: true });
  }
  renderMultiTrendChart('rep-chart-expenses-trend', series, currency);
}

async function refreshIncomeTrendChart() {
  const { points, currency } = await computeMonthlyTypeHistory(reportYear, 'income', repIncomeCategoryId || null);
  const series = [{ label: String(reportYear), points }];
  if (repIncomeCompareYoY) {
    const { points: prevPoints } = await computeMonthlyTypeHistory(reportYear - 1, 'income', repIncomeCategoryId || null);
    series.push({ label: String(reportYear - 1), points: prevPoints, dashed: true });
  }
  renderMultiTrendChart('rep-chart-income-trend', series, currency);
}

async function refreshNetSavingsChart() {
  const { points, currency } = await computeMonthlyNetSavingsHistory(reportYear);
  const chartPoints = points.map((p) => ({ label: p.label, value: repSavingsAsPercent ? p.rate : p.net }));
  renderNetSavingsBarChart('rep-chart-net-savings', chartPoints, currency, repSavingsAsPercent);
}

async function refreshBudgetTrendChart() {
  const { points, currency } = await computeMonthlyBudgetVsActualHistory(reportYear, repBudgetCategoryId || null);
  const series = [
    { label: t('Réel'), points: points.map((p) => ({ label: p.label, value: p.actual })) },
    { label: t('Budget'), points: points.map((p) => ({ label: p.label, value: p.budget })), dashed: true },
  ];
  renderMultiTrendChart('rep-chart-budget-trend', series, currency);
}

async function renderSpendingCharts(container) {
  const [{ currency }, expensesByCategory] = await Promise.all([computeNetWorth(), computeExpensesByCategory(reportMonthKey)]);
  renderExpensesByCategoryChart('rep-chart-expenses-category', expensesByCategory, currency);
  await refreshExpensesTrendChart();
  await refreshIncomeTrendChart();
  await refreshNetSavingsChart();

  container.querySelector('#rep-expenses-category').onchange = (e) => { repExpensesCategoryId = e.target.value; refreshExpensesTrendChart(); };
  container.querySelector('#rep-expenses-compare').onchange = (e) => { repExpensesCompareYoY = e.target.checked; refreshExpensesTrendChart(); };
  container.querySelector('#rep-income-category').onchange = (e) => { repIncomeCategoryId = e.target.value; refreshIncomeTrendChart(); };
  container.querySelector('#rep-income-compare').onchange = (e) => { repIncomeCompareYoY = e.target.checked; refreshIncomeTrendChart(); };
  container.querySelector('#rep-savings-percent').onchange = (e) => { repSavingsAsPercent = e.target.checked; refreshNetSavingsChart(); };
}

async function renderBudgetCharts(container) {
  const [{ currency }, budgetVsActual, netWorthHistory] = await Promise.all([
    computeNetWorth(), computeBudgetVsActual(reportMonthKey), computeNetWorthHistoryForYear(reportYear),
  ]);
  renderBudgetVsActualChart('rep-chart-budget-vs-actual', budgetVsActual, currency);
  renderNetWorthTrendChart('rep-chart-net-worth', netWorthHistory, currency, t('Valeur nette'));
  await refreshBudgetTrendChart();

  container.querySelector('#rep-budget-category').onchange = (e) => { repBudgetCategoryId = e.target.value; refreshBudgetTrendChart(); };
}

async function generatePdfReport() {
  if (!window.jspdf) { showToast(t("La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant).")); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 20;
  const pageBreakIfNeeded = () => { if (y > 275) { doc.addPage(); y = 20; } };

  const profile = await getSetting('userProfile', {});
  doc.setFontSize(18);
  doc.text(t('Djignan Financial System — Bilan financier'), 14, y); y += 8;
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(t('Période : {month}', { month: formatMonthLabel(reportMonthKey) }), 14, y); y += 6;
  for (const line of profileHeaderLines(profile)) { doc.text(line, 14, y); y += 5; }
  y += 4;
  doc.setTextColor(0);

  const [{ total, currency }, summary, expensesByCategory, budgetVsActual] = await Promise.all([
    computeNetWorth(), computeMonthSummary(reportMonthKey), computeExpensesByCategory(reportMonthKey), computeBudgetVsActual(reportMonthKey),
  ]);

  doc.setFontSize(13); doc.text(t('Résumé'), 14, y); y += 7;
  doc.setFontSize(10);
  [
    t('Patrimoine net global : {amount}', { amount: pdfAmount(total, currency) }),
    t('Entrées du mois : {amount}', { amount: pdfAmount(summary.income, summary.currency) }),
    t('Sorties du mois : {amount}', { amount: pdfAmount(summary.expenses, summary.currency) }),
    t('Épargne nette : {amount}', { amount: pdfAmount(summary.netSavings, summary.currency) }),
  ].forEach((line) => { doc.text(line, 14, y); y += 6; });
  y += 6;

  doc.setFontSize(13); doc.text(t('Dépenses par catégorie'), 14, y); y += 7;
  doc.setFontSize(10);
  if (expensesByCategory.length) {
    for (const row of expensesByCategory) {
      pageBreakIfNeeded();
      doc.text(row.label, 14, y);
      doc.text(pdfAmount(row.value, summary.currency), 196, y, { align: 'right' });
      y += 6;
    }
  } else { doc.text(t('Aucune dépense ce mois-ci.'), 14, y); y += 6; }
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text(t('Budget vs réel'), 14, y); y += 7;
  doc.setFontSize(10);
  if (budgetVsActual.length) {
    for (const row of budgetVsActual) {
      pageBreakIfNeeded();
      doc.text(row.label, 14, y);
      doc.text(`${pdfAmount(row.actual, summary.currency)} / ${pdfAmount(row.budget, summary.currency)}`, 196, y, { align: 'right' });
      y += 6;
    }
  } else { doc.text(t('Aucun budget défini ce mois-ci.'), 14, y); y += 6; }
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text(t('Investissements'), 14, y); y += 7;
  doc.setFontSize(10);
  const monthStart = `${reportMonthKey}-01`;
  const monthEnd = localISODate(new Date(parseInt(reportMonthKey.slice(0, 4), 10), parseInt(reportMonthKey.slice(5, 7), 10), 0));
  const [{ invested }, entryTotals, investmentCount] = await Promise.all([
    computeNetWorthComposition(monthEnd), computeInvestmentEntryTotals(monthStart, monthEnd), dbGetAll(STORES.INVESTMENTS).then((rows) => rows.length),
  ]);
  // Existence réelle d'un investissement suivi, pas juste "un total non nul ce mois-ci" : un
  // investissement dont la valeur nette au 0€ (entièrement retiré) ou sans aucun mouvement ce
  // mois précis ne doit pas afficher "Aucun investissement suivi" alors qu'il est bien tracké.
  if (investmentCount > 0) {
    [
      t('Valeur totale du portefeuille : {amount}', { amount: pdfAmount(invested, currency) }),
      t('Apports du mois : {amount}', { amount: pdfAmount(entryTotals.contribution, entryTotals.currency) }),
      t('Dividendes du mois : {amount}', { amount: pdfAmount(entryTotals.dividend, entryTotals.currency) }),
      t('Retraits du mois : {amount}', { amount: pdfAmount(entryTotals.withdrawal, entryTotals.currency) }),
    ].forEach((line) => { doc.text(line, 14, y); y += 6; });
  } else {
    doc.text(t('Aucun investissement suivi.'), 14, y); y += 6;
  }

  doc.save(`djignan-bilan-${reportMonthKey}.pdf`);
  showToast(t('Bilan PDF généré.'));
}

async function generateAnnualPdfReport() {
  if (!window.jspdf) { showToast(t("La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant).")); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 20;
  const pageBreakIfNeeded = () => { if (y > 275) { doc.addPage(); y = 20; } };

  const monthKeys = Array.from({ length: 12 }, (_, i) => `${reportYear}-${String(i + 1).padStart(2, '0')}`);

  const profile = await getSetting('userProfile', {});
  doc.setFontSize(18);
  doc.text(t('Djignan Financial System — Bilan annuel'), 14, y); y += 8;
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(t('Année {year}', { year: reportYear }), 14, y); y += 6;
  for (const line of profileHeaderLines(profile)) { doc.text(line, 14, y); y += 5; }
  y += 4;
  doc.setTextColor(0);

  const monthlySummaries = await Promise.all(monthKeys.map((mk) => computeMonthSummary(mk)));
  const startCutoff = localISODate(new Date(reportYear - 1, 11, 31));
  const endCutoff = localISODate(new Date(reportYear, 11, 31));
  const [{ total: netWorthStart, currency }, { total: netWorthEnd }] = await Promise.all([
    computeNetWorth(startCutoff), computeNetWorth(endCutoff),
  ]);

  const totalIncome = monthlySummaries.reduce((s, m) => s + m.income, 0);
  const totalExpenses = monthlySummaries.reduce((s, m) => s + m.expenses, 0);
  const totalNetSavings = monthlySummaries.reduce((s, m) => s + m.netSavings, 0);

  doc.setFontSize(13); doc.text(t('Résumé annuel'), 14, y); y += 7;
  doc.setFontSize(10);
  [
    t('Revenus totaux : {amount}', { amount: pdfAmount(totalIncome, currency) }),
    t('Dépenses totales : {amount}', { amount: pdfAmount(totalExpenses, currency) }),
    t('Épargne nette totale : {amount}', { amount: pdfAmount(totalNetSavings, currency) }),
    t('Patrimoine net au 1er janvier : {amount}', { amount: pdfAmount(netWorthStart, currency) }),
    t('Patrimoine net au 31 décembre : {amount}', { amount: pdfAmount(netWorthEnd, currency) }),
    t("Variation du patrimoine sur l'année : {amount}", { amount: pdfAmount(netWorthEnd - netWorthStart, currency) }),
  ].forEach((line) => { doc.text(line, 14, y); y += 6; });
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text(t('Détail mensuel'), 14, y); y += 7;
  doc.setFontSize(10);
  doc.text(t('Mois'), 14, y);
  doc.text(t('Entrées'), 100, y, { align: 'right' });
  doc.text(t('Sorties'), 148, y, { align: 'right' });
  doc.text(t('Épargne nette'), 196, y, { align: 'right' });
  y += 5;
  doc.setDrawColor(200); doc.line(14, y, 196, y); y += 5;
  monthKeys.forEach((mk, i) => {
    pageBreakIfNeeded();
    const m = monthlySummaries[i];
    doc.text(formatMonthLabel(mk), 14, y);
    doc.text(pdfAmount(m.income, m.currency), 100, y, { align: 'right' });
    doc.text(pdfAmount(m.expenses, m.currency), 148, y, { align: 'right' });
    doc.text(pdfAmount(m.netSavings, m.currency), 196, y, { align: 'right' });
    y += 6;
  });
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text(t('Dépenses par catégorie (cumul annuel)'), 14, y); y += 7;
  doc.setFontSize(10);
  const categoryTotals = new Map();
  for (const mk of monthKeys) {
    const actuals = await computeCategoryActuals(mk, 'expense');
    for (const row of actuals) {
      if (!row.actual) continue;
      categoryTotals.set(row.label, (categoryTotals.get(row.label) || 0) + row.actual);
    }
  }
  const sortedCategories = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
  if (sortedCategories.length) {
    for (const [label, amount] of sortedCategories) {
      pageBreakIfNeeded();
      doc.text(label, 14, y);
      doc.text(pdfAmount(amount, currency), 196, y, { align: 'right' });
      y += 6;
    }
  } else {
    doc.text(t('Aucune dépense cette année.'), 14, y); y += 6;
  }
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text(t('Investissements'), 14, y); y += 7;
  doc.setFontSize(10);
  const [{ invested: investedEnd }, entryTotalsYear, investmentCountYear] = await Promise.all([
    computeNetWorthComposition(endCutoff), computeInvestmentEntryTotals(`${reportYear}-01-01`, endCutoff), dbGetAll(STORES.INVESTMENTS).then((rows) => rows.length),
  ]);
  if (investmentCountYear > 0) {
    [
      t('Valeur totale du portefeuille au 31 décembre : {amount}', { amount: pdfAmount(investedEnd, currency) }),
      t('Apports de l\'année : {amount}', { amount: pdfAmount(entryTotalsYear.contribution, entryTotalsYear.currency) }),
      t('Dividendes de l\'année : {amount}', { amount: pdfAmount(entryTotalsYear.dividend, entryTotalsYear.currency) }),
      t('Retraits de l\'année : {amount}', { amount: pdfAmount(entryTotalsYear.withdrawal, entryTotalsYear.currency) }),
    ].forEach((line) => { doc.text(line, 14, y); y += 6; });
  } else {
    doc.text(t('Aucun investissement suivi.'), 14, y); y += 6;
  }

  doc.save(`djignan-bilan-annuel-${reportYear}.pdf`);
  showToast(t('Bilan annuel PDF généré.'));
}

/** « Bilan du mois à partager » : phrases calculées en local + image/texte à envoyer (voir
    monthly-recap.js). Les montants peuvent être masqués avant de partager. */
async function recapPanelHtml(monthKey) {
  const recap = await loadMonthlyRecap(monthKey);
  if (!recap.hasData) return '';
  const lines = recapHighlights(recap);
  return `
    <div class="panel" style="margin-top:16px;" id="recap-panel">
      <div class="panel-header"><h3>${t('Bilan du mois à partager')}</h3></div>
      <ul style="margin:0 0 12px;padding-left:18px;font-size:13.5px;line-height:1.6;">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px;cursor:pointer;">
        <input type="checkbox" id="recap-hide-amounts"> ${t('Masquer les montants (garder les pourcentages)')}
      </label>
      <div style="display:flex;flex-wrap:wrap;gap:10px;">
        <button type="button" class="btn btn-primary" id="recap-share-btn">${t("Partager l'image")}</button>
        <button type="button" class="btn btn-ghost" id="recap-copy-btn">${t('Copier le texte')}</button>
      </div>
    </div>`;
}

function wireRecapPanel(container, monthKey) {
  const panel = container.querySelector('#recap-panel');
  if (!panel) return;
  const hide = () => panel.querySelector('#recap-hide-amounts').checked;
  panel.querySelector('#recap-hide-amounts').addEventListener('change', async () => {
    const recap = await loadMonthlyRecap(monthKey);
    panel.querySelector('ul').innerHTML = recapHighlights(recap, { hideAmounts: hide() }).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  });
  panel.querySelector('#recap-share-btn').addEventListener('click', async () => {
    const recap = await loadMonthlyRecap(monthKey);
    const outcome = await shareRecapImage(recap, { hideAmounts: hide() });
    if (outcome === 'downloaded') showToast(t("Image téléchargée : envoyez-la depuis votre galerie."));
  });
  panel.querySelector('#recap-copy-btn').addEventListener('click', async () => {
    const recap = await loadMonthlyRecap(monthKey);
    try { await navigator.clipboard.writeText(recapAsText(recap, { hideAmounts: hide() })); showToast(t('Texte copié.')); }
    catch { showToast(t("Impossible de copier : sélectionnez le texte à la main.")); }
  });
}

/** « Par étiquette » : entrées, sorties et résultat du mois pour chaque étiquette (ex : « pro » pour
    une activité). Masqué tant qu'aucune opération n'est étiquetée. */
async function tagSummaryPanelHtml(monthKey) {
  const { rows, currency } = await computeTagSummary(monthKey);
  if (!rows.length) return '';
  return `
    <div class="panel" style="margin-top:16px;">
      <div class="panel-header"><h3>${t('Résultat par étiquette')}</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px;">${t("Étiquetez vos opérations (ex : « pro ») dans la Saisie express : vous voyez ici ce que chaque activité rapporte ce mois-ci. Une opération à plusieurs étiquettes compte dans chacune.")}</p>
      ${rows.map((r) => `
        <div class="tx-row">
          <div class="tx-main">
            <div class="tx-title">${escapeHtml(r.tag)}</div>
            <div class="tx-sub">${t('Entrées : {income} · Sorties : {expenses}', { income: formatCurrency(r.income, currency), expenses: formatCurrency(r.expenses, currency) })}</div>
          </div>
          <div class="tx-amount amount ${r.result >= 0 ? 'pos' : 'neg'}">${r.result >= 0 ? '+' : '−'}${formatCurrency(Math.abs(r.result), currency)}</div>
        </div>`).join('')}
    </div>`;
}

/** Onglet « Bilans » : exports (PDF, CSV), bilan du mois à partager, résultat par étiquette. */
async function summaryTabHtml() {
  return `
    <div class="panel">
      <div class="panel-header"><h3>${t('Bilan financier mensuel')} <span class="chart-card-period">· ${formatMonthLabel(reportMonthKey)}</span></h3></div>
      <button type="button" class="btn btn-primary" id="rep-pdf-btn">${t('Générer le bilan PDF')}</button>
      <div class="report-links">
        <button type="button" class="link-btn" id="rep-csv-month-btn">${t('Exporter les transactions du mois (CSV)')}</button>
        <button type="button" class="link-btn" id="rep-csv-all-btn">${t("Exporter tout l'historique (CSV)")}</button>
        <button type="button" class="link-btn" id="rep-csv-investments-btn">${t("Exporter l'historique des investissements (CSV)")}</button>
      </div>
    </div>
    <div class="panel" style="margin-top:16px;">
      <div class="panel-header"><h3>${t('Bilan annuel')} <span class="chart-card-period">· ${reportYear}</span></h3></div>
      <button type="button" class="btn btn-primary" id="rep-annual-pdf-btn">${t('Générer le bilan annuel PDF')}</button>
    </div>
    ${await recapPanelHtml(reportMonthKey)}
    ${await tagSummaryPanelHtml(reportMonthKey)}`;
}

const REPORT_TABS = [
  ['summary', 'Bilans'],
  ['spending', 'Dépenses et revenus'],
  ['budget', 'Budget et patrimoine'],
  ['health', 'Santé et calendrier'],
];
let reportTab = 'summary';

export async function renderReports() {
  const container = document.getElementById('reports-content');
  if (!container) return;
  if (!REPORT_TABS.some(([key]) => key === reportTab)) reportTab = 'summary';

  let body = '';
  if (reportTab === 'summary') body = await summaryTabHtml();
  else if (reportTab === 'spending') body = await spendingTabHtml();
  else if (reportTab === 'budget') body = await budgetTabHtml();
  else body = `${await healthScorePanelHtml(reportMonthKey)}${await calendarPanelHtml(reportMonthKey)}`;

  container.innerHTML = `
    <div class="report-period">
      <div class="report-period-group">
        <span class="report-period-label">${t('Mois')}</span>
        <button type="button" class="icon-btn" id="rep-prev-month" aria-label="${t('Mois précédent')}">‹</button>
        <strong class="report-period-value">${formatMonthLabel(reportMonthKey)}</strong>
        <button type="button" class="icon-btn" id="rep-next-month" aria-label="${t('Mois suivant')}">›</button>
      </div>
      <div class="report-period-group">
        <span class="report-period-label">${t('Année')}</span>
        <button type="button" class="icon-btn" id="rep-prev-year" aria-label="${t('Année précédente')}">‹</button>
        <strong class="report-period-value">${reportYear}</strong>
        <button type="button" class="icon-btn" id="rep-next-year" aria-label="${t('Année suivante')}">›</button>
      </div>
    </div>
    <div class="tabs-bar">
      ${REPORT_TABS.map(([key, label]) => `<button type="button" class="tab-btn ${reportTab === key ? 'is-active' : ''}" data-report-tab="${key}">${t(label)}</button>`).join('')}
    </div>
    <div class="report-body">${body}</div>`;

  container.querySelectorAll('[data-report-tab]').forEach((b) => b.addEventListener('click', () => { reportTab = b.dataset.reportTab; renderReports(); }));
  container.querySelector('#rep-prev-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, -1); renderReports(); };
  container.querySelector('#rep-next-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, 1); renderReports(); };
  container.querySelector('#rep-prev-year').onclick = () => { reportYear -= 1; renderReports(); };
  container.querySelector('#rep-next-year').onclick = () => { reportYear += 1; renderReports(); };

  if (reportTab === 'summary') {
    wireRecapPanel(container, reportMonthKey);
    container.querySelector('#rep-annual-pdf-btn').onclick = () => generateAnnualPdfReport();
    container.querySelector('#rep-pdf-btn').onclick = () => generatePdfReport();
    container.querySelector('#rep-csv-month-btn').onclick = async () => { await exportTransactionsCsv(reportMonthKey); showToast(t('Export CSV généré.')); };
    container.querySelector('#rep-csv-all-btn').onclick = async () => { await exportTransactionsCsv(); showToast(t('Export CSV généré.')); };
    container.querySelector('#rep-csv-investments-btn').onclick = async () => { await exportInvestmentEntriesCsv(); showToast(t('Export CSV généré.')); };
  } else if (reportTab === 'spending') {
    await renderSpendingCharts(container);
  } else if (reportTab === 'budget') {
    await renderBudgetCharts(container);
  } else {
    wireCalendarPanel(container, reportMonthKey);
  }
}

export function initReportsModule() {}
