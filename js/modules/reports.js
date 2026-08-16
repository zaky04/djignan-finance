/* ==========================================================================
   GeoFinance System — Module Rapports
   Génération d'un bilan PDF (patrimoine, résumé mensuel, dépenses par
   catégorie, budget vs réel) et export CSV des transactions.
   ========================================================================== */

import { computeNetWorth, computeMonthSummary, computeExpensesByCategory, computeBudgetVsActual, computeCategoryActuals } from '../ledger.js';
import { formatCurrency, formatMonthLabel, currentMonthKey, monthKeyOffset, localISODate, showToast } from '../utils.js';
import { exportTransactionsCsv } from '../backup.js';
import { getSetting } from '../db.js';
import { healthScorePanelHtml, calendarPanelHtml, wireCalendarPanel } from './reports-extras.js';
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

async function generatePdfReport() {
  if (!window.jspdf) { showToast(t("La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant).")); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  let y = 20;
  const pageBreakIfNeeded = () => { if (y > 275) { doc.addPage(); y = 20; } };

  const profile = await getSetting('userProfile', {});
  doc.setFontSize(18);
  doc.text(t('GeoFinance System — Bilan financier'), 14, y); y += 8;
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

  doc.save(`geofinance-bilan-${reportMonthKey}.pdf`);
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
  doc.text(t('GeoFinance System — Bilan annuel'), 14, y); y += 8;
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

  doc.save(`geofinance-bilan-annuel-${reportYear}.pdf`);
  showToast(t('Bilan annuel PDF généré.'));
}

export async function renderReports() {
  const container = document.getElementById('reports-content');
  if (!container) return;
  container.innerHTML = `
    <div class="panel">
      <div class="panel-header"><h3>${t('Bilan financier mensuel')}</h3></div>
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:16px;">
        <button type="button" class="icon-btn" id="rep-prev-month" aria-label="${t('Mois précédent')}">‹</button>
        <strong style="min-width:130px;text-align:center;display:inline-block;">${formatMonthLabel(reportMonthKey)}</strong>
        <button type="button" class="icon-btn" id="rep-next-month" aria-label="${t('Mois suivant')}">›</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;">
        <button type="button" class="btn btn-primary" id="rep-pdf-btn">${t('Générer le bilan PDF')}</button>
        <button type="button" class="btn btn-ghost" id="rep-csv-month-btn">${t('Exporter les transactions du mois (CSV)')}</button>
        <button type="button" class="btn btn-ghost" id="rep-csv-all-btn">${t("Exporter tout l'historique (CSV)")}</button>
      </div>
    </div>
    <div class="panel" style="margin-top:16px;">
      <div class="panel-header"><h3>${t('Bilan annuel')}</h3></div>
      <div style="display:flex;align-items:center;gap:4px;margin-bottom:16px;">
        <button type="button" class="icon-btn" id="rep-prev-year" aria-label="${t('Année précédente')}">‹</button>
        <strong style="min-width:80px;text-align:center;display:inline-block;">${reportYear}</strong>
        <button type="button" class="icon-btn" id="rep-next-year" aria-label="${t('Année suivante')}">›</button>
      </div>
      <button type="button" class="btn btn-primary" id="rep-annual-pdf-btn">${t('Générer le bilan annuel PDF')}</button>
    </div>
    ${await healthScorePanelHtml(reportMonthKey)}
    ${await calendarPanelHtml(reportMonthKey)}`;

  wireCalendarPanel(container, reportMonthKey);

  container.querySelector('#rep-prev-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, -1); renderReports(); };
  container.querySelector('#rep-next-month').onclick = () => { reportMonthKey = monthKeyOffset(reportMonthKey, 1); renderReports(); };
  container.querySelector('#rep-prev-year').onclick = () => { reportYear -= 1; renderReports(); };
  container.querySelector('#rep-next-year').onclick = () => { reportYear += 1; renderReports(); };
  container.querySelector('#rep-annual-pdf-btn').onclick = () => generateAnnualPdfReport();
  container.querySelector('#rep-pdf-btn').onclick = () => generatePdfReport();
  container.querySelector('#rep-csv-month-btn').onclick = async () => { await exportTransactionsCsv(reportMonthKey); showToast(t('Export CSV généré.')); };
  container.querySelector('#rep-csv-all-btn').onclick = async () => { await exportTransactionsCsv(); showToast(t('Export CSV généré.')); };
}

export function initReportsModule() {}
