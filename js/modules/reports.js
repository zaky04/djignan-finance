/* ==========================================================================
   GeoFinance System — Module Rapports
   Génération d'un bilan PDF (patrimoine, résumé mensuel, dépenses par
   catégorie, budget vs réel) et export CSV des transactions.
   ========================================================================== */

import { computeNetWorth, computeMonthSummary, computeExpensesByCategory, computeBudgetVsActual } from '../ledger.js';
import { formatCurrency, formatMonthLabel, currentMonthKey, monthKeyOffset, showToast } from '../utils.js';
import { exportTransactionsCsv } from '../backup.js';

let reportMonthKey = currentMonthKey();

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
    </div>`;

  container.querySelector('#rep-prev-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, -1); renderReports(); };
  container.querySelector('#rep-next-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, 1); renderReports(); };
  container.querySelector('#rep-pdf-btn').onclick = () => generatePdfReport();
  container.querySelector('#rep-csv-month-btn').onclick = async () => { await exportTransactionsCsv(reportMonthKey); showToast('Export CSV généré.'); };
  container.querySelector('#rep-csv-all-btn').onclick = async () => { await exportTransactionsCsv(); showToast('Export CSV généré.'); };
}

export function initReportsModule() {}
