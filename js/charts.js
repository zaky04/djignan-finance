/* ==========================================================================
   GeoFinance System — Wrappers Chart.js
   Chart.js est chargé en global (vendor/chart.min.js, <script defer>) avant
   ce module. Les instances sont mises en registre pour être détruites avant
   chaque re-rendu (évite les fuites mémoire lors des changements de vue).
   ========================================================================== */

import { formatCurrency } from './utils.js';

const registry = new Map();

const PALETTE = ['#4f5bff', '#16a34a', '#f59e0b', '#e11d48', '#7c3aed', '#0891b2', '#84cc16', '#ea580c', '#64748b', '#db2777'];

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
        { label: 'Budget', data: (rows || []).map((r) => r.budget), backgroundColor: colors.border, borderRadius: 4 },
        { label: 'Réel', data: (rows || []).map((r) => r.actual), backgroundColor: colors.accent, borderRadius: 4 },
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

/** Détruit tous les graphiques enregistrés (ex: avant changement de thème global). */
export function destroyAllCharts() {
  registry.forEach((c) => c.destroy());
  registry.clear();
}
