/* ==========================================================================
   GeoFinance System — Module Rapports
   Génération d'un bilan PDF (patrimoine, résumé mensuel, dépenses par
   catégorie, budget vs réel) et export CSV des transactions.
   ========================================================================== */

import { computeNetWorth, computeMonthSummary, computeExpensesByCategory, computeBudgetVsActual, computeCategoryActuals } from '../ledger.js';
import { formatCurrency, formatMonthLabel, currentMonthKey, monthKeyOffset, localISODate, showToast } from '../utils.js';
import { exportTransactionsCsv } from '../backup.js';

let reportMonthKey = currentMonthKey();
let reportYear = parseInt(currentMonthKey().slice(0, 4), 10);

async function generatePdfReport() {
  if (!window.jspdf) { showToast("La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant)."); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 20;
  const pageBreakIfNeeded = () => { if (y > 275) { doc.addPage(); y = 20; } };

  doc.setFontSize(18);
  doc.text('GeoFinance System — Bilan financier', 14, y); y += 8;
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Période : ${formatMonthLabel(reportMonthKey)}`, 14, y); y += 10;
  doc.setTextColor(0);

  const [{ total, currency }, summary, expensesByCategory, budgetVsActual] = await Promise.all([
    computeNetWorth(), computeMonthSummary(reportMonthKey), computeExpensesByCategory(reportMonthKey), computeBudgetVsActual(reportMonthKey),
  ]);

  doc.setFontSize(13); doc.text('Résumé', 14, y); y += 7;
  doc.setFontSize(10);
  [
    `Patrimoine net global : ${formatCurrency(total, currency)}`,
    `Entrées du mois : ${formatCurrency(summary.income, summary.currency)}`,
    `Sorties du mois : ${formatCurrency(summary.expenses, summary.currency)}`,
    `Épargne nette : ${formatCurrency(summary.netSavings, summary.currency)}`,
  ].forEach((line) => { doc.text(line, 14, y); y += 6; });
  y += 6;

  doc.setFontSize(13); doc.text('Dépenses par catégorie', 14, y); y += 7;
  doc.setFontSize(10);
  if (expensesByCategory.length) {
    for (const row of expensesByCategory) {
      pageBreakIfNeeded();
      doc.text(row.label, 14, y);
      doc.text(formatCurrency(row.value, summary.currency), 196, y, { align: 'right' });
      y += 6;
    }
  } else { doc.text('Aucune dépense ce mois-ci.', 14, y); y += 6; }
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text('Budget vs réel', 14, y); y += 7;
  doc.setFontSize(10);
  if (budgetVsActual.length) {
    for (const row of budgetVsActual) {
      pageBreakIfNeeded();
      doc.text(row.label, 14, y);
      doc.text(`${formatCurrency(row.actual, summary.currency)} / ${formatCurrency(row.budget, summary.currency)}`, 196, y, { align: 'right' });
      y += 6;
    }
  } else { doc.text('Aucun budget défini ce mois-ci.', 14, y); y += 6; }

  doc.save(`geofinance-bilan-${reportMonthKey}.pdf`);
  showToast('Bilan PDF généré.');
}

async function generateAnnualPdfReport() {
  if (!window.jspdf) { showToast("La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant)."); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 20;
  const pageBreakIfNeeded = () => { if (y > 275) { doc.addPage(); y = 20; } };

  const monthKeys = Array.from({ length: 12 }, (_, i) => `${reportYear}-${String(i + 1).padStart(2, '0')}`);

  doc.setFontSize(18);
  doc.text('GeoFinance System — Bilan annuel', 14, y); y += 8;
  doc.setFontSize(11);
  doc.setTextColor(100);
  doc.text(`Année ${reportYear}`, 14, y); y += 10;
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

  doc.setFontSize(13); doc.text('Résumé annuel', 14, y); y += 7;
  doc.setFontSize(10);
  [
    `Revenus totaux : ${formatCurrency(totalIncome, currency)}`,
    `Dépenses totales : ${formatCurrency(totalExpenses, currency)}`,
    `Épargne nette totale : ${formatCurrency(totalNetSavings, currency)}`,
    `Patrimoine net au 1er janvier : ${formatCurrency(netWorthStart, currency)}`,
    `Patrimoine net au 31 décembre : ${formatCurrency(netWorthEnd, currency)}`,
    `Variation du patrimoine sur l'année : ${formatCurrency(netWorthEnd - netWorthStart, currency)}`,
  ].forEach((line) => { doc.text(line, 14, y); y += 6; });
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text('Détail mensuel', 14, y); y += 7;
  doc.setFontSize(10);
  doc.text('Mois', 14, y);
  doc.text('Entrées', 100, y, { align: 'right' });
  doc.text('Sorties', 148, y, { align: 'right' });
  doc.text('Épargne nette', 196, y, { align: 'right' });
  y += 5;
  doc.setDrawColor(200); doc.line(14, y, 196, y); y += 5;
  monthKeys.forEach((mk, i) => {
    pageBreakIfNeeded();
    const m = monthlySummaries[i];
    doc.text(formatMonthLabel(mk), 14, y);
    doc.text(formatCurrency(m.income, m.currency), 100, y, { align: 'right' });
    doc.text(formatCurrency(m.expenses, m.currency), 148, y, { align: 'right' });
    doc.text(formatCurrency(m.netSavings, m.currency), 196, y, { align: 'right' });
    y += 6;
  });
  y += 6;

  pageBreakIfNeeded();
  doc.setFontSize(13); doc.text('Dépenses par catégorie (cumul annuel)', 14, y); y += 7;
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
      doc.text(formatCurrency(amount, currency), 196, y, { align: 'right' });
      y += 6;
    }
  } else {
    doc.text('Aucune dépense cette année.', 14, y); y += 6;
  }

  doc.save(`geofinance-bilan-annuel-${reportYear}.pdf`);
  showToast('Bilan annuel PDF généré.');
}

export async function renderReports() {
  const container = document.getElementById('reports-content');
  if (!container) return;
  container.innerHTML = `
    <div class="panel">
      <div class="panel-header"><h3>Bilan financier mensuel</h3></div>
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:16px;">
        <button type="button" class="icon-btn" id="rep-prev-month" aria-label="Mois précédent">‹</button>
        <strong style="min-width:130px;text-align:center;display:inline-block;">${formatMonthLabel(reportMonthKey)}</strong>
        <button type="button" class="icon-btn" id="rep-next-month" aria-label="Mois suivant">›</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;">
        <button type="button" class="btn btn-primary" id="rep-pdf-btn">Générer le bilan PDF</button>
        <button type="button" class="btn btn-ghost" id="rep-csv-month-btn">Exporter les transactions du mois (CSV)</button>
        <button type="button" class="btn btn-ghost" id="rep-csv-all-btn">Exporter tout l'historique (CSV)</button>
      </div>
    </div>
    <div class="panel" style="margin-top:16px;">
      <div class="panel-header"><h3>Bilan annuel</h3></div>
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:16px;">
        <button type="button" class="icon-btn" id="rep-prev-year" aria-label="Année précédente">‹</button>
        <strong style="min-width:80px;text-align:center;display:inline-block;">${reportYear}</strong>
        <button type="button" class="icon-btn" id="rep-next-year" aria-label="Année suivante">›</button>
      </div>
      <button type="button" class="btn btn-primary" id="rep-annual-pdf-btn">Générer le bilan annuel PDF</button>
    </div>`;

  container.querySelector('#rep-prev-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, -1); renderReports(); };
  container.querySelector('#rep-next-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, 1); renderReports(); };
  container.querySelector('#rep-prev-year').onclick = () => { reportYear -= 1; renderReports(); };
  container.querySelector('#rep-next-year').onclick = () => { reportYear += 1; renderReports(); };
  container.querySelector('#rep-annual-pdf-btn').onclick = () => generateAnnualPdfReport();
  container.querySelector('#rep-pdf-btn').onclick = () => generatePdfReport();
  container.querySelector('#rep-csv-month-btn').onclick = async () => { await exportTransactionsCsv(reportMonthKey); showToast('Export CSV généré.'); };
  container.querySelector('#rep-csv-all-btn').onclick = async () => { await exportTransactionsCsv(); showToast('Export CSV généré.'); };
}

export function initReportsModule() {}
