/* ==========================================================================
   GeoFinance System — Wrappers Chart.js
   Chart.js est chargé en global (vendor/chart.min.js, <script defer>) avant
   ce module. Les instances sont mises en registre pour être détruites avant
   chaque re-rendu (évite les fuites mémoire lors des changements de vue).
   ========================================================================== */

import { formatCurrency, escapeHtml } from './utils.js';
import { t } from './i18n.js';

const registry = new Map();

export const PALETTE = ['#4f5bff', '#16a34a', '#f59e0b', '#e11d48', '#7c3aed', '#0891b2', '#84cc16', '#ea580c', '#64748b', '#db2777'];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || getComputedStyle(document.body).getPropertyValue(name).trim();
}

function baseColors() {
  return {
    text: cssVar('--text') || '#12162b',
    muted: cssVar('--text-muted') || '#6b7086',
    border: cssVar('--border') || '#e7e9f2',
    accent: cssVar('--accent') || '#4f5bff',
    pos: cssVar('--pos') || '#16a34a',
    neg: cssVar('--neg') || '#e11d48',
  };
}

function destroy(canvasId) {
  const existing = registry.get(canvasId);
  if (existing) { existing.destroy(); registry.delete(canvasId); }
}

function ensureChartLib() {
  if (typeof window.Chart === 'undefined') {
    console.error('[charts] Chart.js non chargé (vendor/chart.min.js manquant ?)');
    return false;
  }
  return true;
}

/** Camembert : répartition des dépenses par catégorie. rows = [{label, value}] */
export function renderExpensesByCategoryChart(canvasId, rows, currency = 'EUR') {
  if (!ensureChartLib()) return;
  destroy(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const colors = baseColors();

  if (!rows || !rows.length) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const chart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [{
        data: rows.map((r) => r.value),
        backgroundColor: rows.map((r, i) => r.color || PALETTE[i % PALETTE.length]),
        borderColor: cssVar('--surface') || '#fff',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { color: colors.muted, boxWidth: 10, padding: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${formatCurrency(ctx.parsed, currency)}`,
          },
        },
      },
    },
  });
  registry.set(canvasId, chart);
}

/** Courbe : évolution de la valeur nette. points = [{label, value}] */
export function renderNetWorthTrendChart(canvasId, points, currency = 'EUR', label = 'Valeur nette') {
  if (!ensureChartLib()) return;
  destroy(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const colors = baseColors();

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: (points || []).map((p) => p.label),
      datasets: [{
        label,
        data: (points || []).map((p) => p.value),
        borderColor: colors.accent,
        backgroundColor: `${colors.accent}22`,
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: colors.accent,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${formatCurrency(ctx.parsed.y, currency)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: colors.muted, font: { size: 11 } } },
        y: {
          grid: { color: colors.border },
          ticks: { color: colors.muted, font: { size: 11 }, callback: (v) => formatCurrency(v, currency) },
        },
      },
    },
  });
  registry.set(canvasId, chart);
}

/** Barres groupées : budget vs réel par catégorie. rows = [{label, budget, actual}] */
export function renderBudgetVsActualChart(canvasId, rows, currency = 'EUR') {
  if (!ensureChartLib()) return;
  destroy(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const colors = baseColors();

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: (rows || []).map((r) => r.label),
      datasets: [
        { label: t('Budget'), data: (rows || []).map((r) => r.budget), backgroundColor: colors.border, borderRadius: 4 },
        { label: t('Réel'), data: (rows || []).map((r) => r.actual), backgroundColor: colors.accent, borderRadius: 4 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: colors.muted, boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y, currency)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: colors.muted, font: { size: 11 } } },
        y: { grid: { color: colors.border }, ticks: { color: colors.muted, font: { size: 11 }, callback: (v) => formatCurrency(v, currency) } },
      },
    },
  });
  registry.set(canvasId, chart);
}

/** Diagramme de flux simplifié (façon Sankey) : revenus du mois se répartissant vers les
    catégories de dépenses et l'épargne nette. SVG généré à la main (pas de librairie tierce)
    pour rester léger — un seul nœud source (Revenus), un nœud par flux à droite.
    flows = [{label, value, color}]. */
export function renderIncomeFlowSankey(containerId, { income, flows, currency }) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const positiveFlows = (flows || []).filter((f) => f.value > 0);
  if (!income || income <= 0 || !positiveFlows.length) {
    container.innerHTML = `<div class="empty-state">${t('Pas assez de données ce mois-ci pour afficher le flux.')}</div>`;
    return;
  }
  const colors = baseColors();
  const total = positiveFlows.reduce((s, f) => s + f.value, 0);
  const rowH = 30;
  const height = Math.max(rowH, positiveFlows.length * rowH);
  const width = 640;
  const leftX = 58, leftW = 8, rightX = 500, rightW = 8;
  const midX = (leftX + leftW + rightX) / 2;

  let y = 0;
  const rights = positiveFlows.map((f) => {
    const h = (f.value / total) * height;
    const row = { ...f, y, h };
    y += h;
    return row;
  });

  const paths = rights.map((r) => `
    <path d="M ${leftX + leftW} ${r.y} C ${midX} ${r.y}, ${midX} ${r.y}, ${rightX} ${r.y}
             L ${rightX} ${r.y + r.h}
             C ${midX} ${r.y + r.h}, ${midX} ${r.y + r.h}, ${leftX + leftW} ${r.y + r.h} Z"
          fill="${r.color}" opacity="0.32"/>`).join('');

  const labels = rights.map((r) => `
    <rect x="${rightX}" y="${r.y}" width="${rightW}" height="${Math.max(1, r.h - 2)}" fill="${r.color}"/>
    <text x="${rightX + rightW + 10}" y="${r.y + r.h / 2}" dominant-baseline="middle" font-size="12" fill="${colors.text}">${escapeHtml(r.label)} · ${formatCurrency(r.value, currency)}</text>`).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" style="max-width:100%;height:auto;display:block;" preserveAspectRatio="xMinYMin meet">
      <rect x="${leftX}" y="0" width="${leftW}" height="${height}" fill="${colors.accent}"/>
      <text x="${leftX - 8}" y="${height / 2}" text-anchor="end" dominant-baseline="middle" font-size="12" font-weight="700" fill="${colors.text}">${t('Revenus')}</text>
      ${paths}
      ${labels}
    </svg>
    <div style="text-align:center;font-size:12px;color:var(--text-muted);margin-top:6px;">${t('Revenus du mois : {amount}', { amount: formatCurrency(income, currency) })}</div>`;
}

/** Détruit tous les graphiques enregistrés (ex: avant changement de thème global). */
export function destroyAllCharts() {
  registry.forEach((c) => c.destroy());
  registry.clear();
}
