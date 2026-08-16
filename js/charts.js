/* ==========================================================================
   Djignan Financial System — Wrappers Chart.js
   Chart.js est chargé en global (vendor/chart.min.js, <script defer>) avant
   ce module. Les instances sont mises en registre pour être détruites avant
   chaque re-rendu (évite les fuites mémoire lors des changements de vue).
   ========================================================================== */

import { formatCurrency } from './utils.js';
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

/** Courbe multi-séries (ex: comparaison année N vs N-1, ou budget vs réel dans le temps).
    series = [{label, points: [{label, value}], dashed}] — toutes les séries partagent le même axe
    x (labels pris sur la première série). Généralise renderNetWorthTrendChart() à plusieurs
    séries ; laissé comme fonction séparée pour ne rien changer aux appels existants (dashboard,
    dettes, investissements) qui n'ont besoin que d'une seule série. */
export function renderMultiTrendChart(canvasId, series, currency = 'EUR') {
  if (!ensureChartLib()) return;
  destroy(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const colors = baseColors();
  const palette = [colors.accent, colors.muted, ...PALETTE];

  const chart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: (series[0]?.points || []).map((p) => p.label),
      datasets: (series || []).map((s, i) => ({
        label: s.label,
        data: s.points.map((p) => p.value),
        borderColor: palette[i % palette.length],
        backgroundColor: `${palette[i % palette.length]}22`,
        borderDash: s.dashed ? [6, 4] : [],
        // Remplissage sous la courbe seulement s'il n'y a qu'une seule série — avec 2 séries
        // (comparaison année N/N-1, ou budget vs réel), une zone remplie sous l'une des deux
        // courbes seulement suggérerait à tort une signification particulière à cette aire.
        fill: series.length === 1,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: palette[i % palette.length],
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: series.length > 1, position: 'bottom', labels: { color: colors.muted, boxWidth: 10, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${formatCurrency(ctx.parsed.y, currency)}` } },
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

/** Barres épargne nette mensuelle : vert si positif, rouge si négatif. points = [{label, value}].
    asPercent : les valeurs sont déjà des pourcentages (pas de formatCurrency, suffixe "%"). */
export function renderNetSavingsBarChart(canvasId, points, currency = 'EUR', asPercent = false) {
  if (!ensureChartLib()) return;
  destroy(canvasId);
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const colors = baseColors();

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: (points || []).map((p) => p.label),
      datasets: [{
        data: (points || []).map((p) => p.value),
        backgroundColor: (points || []).map((p) => (p.value >= 0 ? colors.pos : colors.neg)),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${asPercent ? ctx.parsed.y + '%' : formatCurrency(ctx.parsed.y, currency)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: colors.muted, font: { size: 11 } } },
        y: {
          grid: { color: colors.border },
          ticks: { color: colors.muted, font: { size: 11 }, callback: (v) => (asPercent ? `${v}%` : formatCurrency(v, currency)) },
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

/** Détruit tous les graphiques enregistrés (ex: avant changement de thème global). */
export function destroyAllCharts() {
  registry.forEach((c) => c.destroy());
  registry.clear();
}
