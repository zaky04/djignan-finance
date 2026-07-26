/* ==========================================================================
   GeoFinance System — Module Outils stratégiques
   Simulateur de trajectoire patrimoniale, calculateur d'inflation, fonds
   d'urgence, enveloppes 50/30/20, détection d'anomalies de dépenses,
   journal d'audit.
   ========================================================================== */

import { STORES, dbGetAll, getSetting } from '../db.js';
import { computeMonthSummary, computeLiquidBalance, computeNetWorth } from '../ledger.js';
import { formatCurrency, formatPercent, escapeHtml, currentMonthKey, monthKeyOffset, convertAmount, localISODate } from '../utils.js';

function panel(title, bodyHtml, id) {
  return `<div class="panel" style="grid-column:1/-1;margin-bottom:18px;" ${id ? `id="${id}"` : ''}>
    <div class="panel-header"><h3>${title}</h3></div>
    ${bodyHtml}
  </div>`;
}

/* ---------- 1. Simulateur de trajectoire patrimoniale ---------- */
async function renderWealthTrajectoryTool() {
  const { total, currency } = await computeNetWorth();
  const summary = await computeMonthSummary(currentMonthKey());
  const defaultMonthlySavings = Math.max(0, Math.round(summary.netSavings));

  const body = `
    <div class="filters-bar" style="margin-bottom:14px;">
      <div class="form-row" style="margin:0;"><label>Épargne mensuelle (${escapeHtml(currency)})</label><input type="number" id="wt-savings" value="${defaultMonthlySavings}" step="10"></div>
      <div class="form-row" style="margin:0;"><label>Rendement annuel attendu (%)</label><input type="number" id="wt-return" value="4" step="0.1"></div>
    </div>
    <div id="wt-results" class="grid-cards"></div>
    <p style="font-size:12px;color:var(--text-faint);margin-top:10px;">Projection à partir du patrimoine net actuel (${formatCurrency(total, currency)}), en supposant un rendement composé constant et une épargne mensuelle régulière.</p>`;

  const html = panel("Simulateur de trajectoire patrimoniale (1, 3, 5 ans)", body, 'tool-wealth-trajectory');

  function compute() {
    const el = document.getElementById('tool-wealth-trajectory');
    if (!el) return;
    const pmt = parseFloat(el.querySelector('#wt-savings').value) || 0;
    const annualReturn = parseFloat(el.querySelector('#wt-return').value) || 0;
    const r = annualReturn / 100 / 12;
    const results = [1, 3, 5].map((years) => {
      const n = years * 12;
      const fvPrincipal = total * Math.pow(1 + r, n);
      const fvSavings = r === 0 ? pmt * n : pmt * ((Math.pow(1 + r, n) - 1) / r);
      return { years, value: fvPrincipal + fvSavings };
    });
    el.querySelector('#wt-results').innerHTML = results.map((r2) => `
      <div class="summary-card">
        <div class="summary-card-label">Dans ${r2.years} an${r2.years > 1 ? 's' : ''}</div>
        <div class="summary-card-value">${formatCurrency(r2.value, currency)}</div>
      </div>`).join('');
  }

  return { html, wire: () => { document.getElementById('tool-wealth-trajectory').addEventListener('input', compute); compute(); } };
}

/* ---------- 2. Calculateur d'inflation & pouvoir d'achat ---------- */
async function renderInflationTool() {
  const { baseCurrency } = await getExchangeRatesSafe();
  const body = `
    <div class="filters-bar" style="margin-bottom:14px;">
      <div class="form-row" style="margin:0;"><label>Montant (${escapeHtml(baseCurrency)})</label><input type="number" id="inf-amount" value="1000" step="10"></div>
      <div class="form-row" style="margin:0;"><label>Inflation annuelle (%)</label><input type="number" id="inf-rate" value="3" step="0.1"></div>
      <div class="form-row" style="margin:0;"><label>Durée (années)</label><input type="number" id="inf-years" value="10" step="1"></div>
    </div>
    <div id="inf-results"></div>`;
  const html = panel('Calculateur d\'inflation & pouvoir d\'achat', body, 'tool-inflation');

  function compute() {
    const el = document.getElementById('tool-inflation');
    if (!el) return;
    const amount = parseFloat(el.querySelector('#inf-amount').value) || 0;
    const rate = parseFloat(el.querySelector('#inf-rate').value) || 0;
    const years = parseFloat(el.querySelector('#inf-years').value) || 0;
    const realValue = amount / Math.pow(1 + rate / 100, years);
    const loss = amount - realValue;
    const lossPct = amount ? (loss / amount) * 100 : 0;
    el.querySelector('#inf-results').innerHTML = `
      <div class="stat-row"><span class="stat-row-label">Pouvoir d'achat réel dans ${years} an(s)</span><span>${formatCurrency(realValue, baseCurrency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">Perte de valeur</span><span class="badge badge-neg">-${formatCurrency(loss, baseCurrency)} (${formatPercent(lossPct)})</span></div>`;
  }
  return { html, wire: () => { document.getElementById('tool-inflation').addEventListener('input', compute); compute(); } };
}

/* ---------- 3. Calculateur de fonds d'urgence ---------- */
async function averageMonthlyExpenses(months = 3) {
  let sum = 0;
  for (let i = 1; i <= months; i++) {
    const mk = monthKeyOffset(currentMonthKey(), -i);
    const s = await computeMonthSummary(mk);
    sum += s.expenses;
  }
  return sum / months;
}

async function renderEmergencyFundTool() {
  const avgExpenses = await averageMonthlyExpenses(3);
  const { total: liquid, currency } = await computeLiquidBalance();

  const body = `
    <div class="filters-bar" style="margin-bottom:14px;">
      <div class="form-row" style="margin:0;"><label>Dépenses mensuelles moyennes (${escapeHtml(currency)})</label><input type="number" id="ef-expenses" value="${Math.round(avgExpenses)}" step="10"></div>
      <div class="form-row" style="margin:0;"><label>Mois de couverture souhaités</label>
        <select id="ef-months"><option value="3">3 mois</option><option value="6" selected>6 mois</option><option value="12">12 mois</option></select>
      </div>
    </div>
    <div id="ef-results"></div>`;
  const html = panel("Calculateur de fonds d'urgence", body, 'tool-emergency-fund');

  function compute() {
    const el = document.getElementById('tool-emergency-fund');
    if (!el) return;
    const expenses = parseFloat(el.querySelector('#ef-expenses').value) || 0;
    const months = parseFloat(el.querySelector('#ef-months').value) || 0;
    const target = expenses * months;
    const autonomyMonths = expenses ? liquid / expenses : 0;
    const gap = Math.max(0, target - liquid);
    el.querySelector('#ef-results').innerHTML = `
      <div class="stat-row"><span class="stat-row-label">Liquidités actuelles (portefeuilles)</span><span>${formatCurrency(liquid, currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">Objectif (${months} mois)</span><span>${formatCurrency(target, currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">Autonomie actuelle</span><span class="badge ${autonomyMonths >= months ? 'badge-pos' : 'badge-neg'}">${autonomyMonths.toFixed(1)} mois</span></div>
      ${gap > 0 ? `<div class="stat-row"><span class="stat-row-label">Montant à épargner pour atteindre l'objectif</span><span>${formatCurrency(gap, currency)}</span></div>` : '<div class="alert alert-info" style="margin-top:8px;">Objectif de fonds d\'urgence atteint !</div>'}`;
  }
  return { html, wire: () => { document.getElementById('tool-emergency-fund').addEventListener('input', compute); compute(); } };
}

/* ---------- 4. Budgets par enveloppes (50/30/20 personnalisable) ---------- */
async function renderEnvelopeTool() {
  const summary = await computeMonthSummary(currentMonthKey());
  const income = Math.round(summary.income) || 0;

  const body = `
    <div class="filters-bar" style="margin-bottom:14px;">
      <div class="form-row" style="margin:0;"><label>Revenu mensuel (${escapeHtml(summary.currency)})</label><input type="number" id="env-income" value="${income}" step="10"></div>
      <div class="form-row" style="margin:0;"><label>% Besoins essentiels</label><input type="number" id="env-needs" value="50" step="1"></div>
      <div class="form-row" style="margin:0;"><label>% Envies / loisirs</label><input type="number" id="env-wants" value="30" step="1"></div>
      <div class="form-row" style="margin:0;"><label>% Épargne / dettes</label><input type="number" id="env-savings" value="20" step="1"></div>
    </div>
    <div id="env-results" class="grid-cards"></div>
    <p id="env-warning" class="alert alert-warn" style="display:none;margin-top:10px;">Les pourcentages ne totalisent pas 100%.</p>`;
  const html = panel('Système de budgets par enveloppes (méthode 50/30/20)', body, 'tool-envelope');

  function compute() {
    const el = document.getElementById('tool-envelope');
    if (!el) return;
    const income2 = parseFloat(el.querySelector('#env-income').value) || 0;
    const needsPct = parseFloat(el.querySelector('#env-needs').value) || 0;
    const wantsPct = parseFloat(el.querySelector('#env-wants').value) || 0;
    const savingsPct = parseFloat(el.querySelector('#env-savings').value) || 0;
    const totalPct = needsPct + wantsPct + savingsPct;
    el.querySelector('#env-warning').style.display = Math.abs(totalPct - 100) > 0.5 ? 'block' : 'none';

    const rows = [
      { label: 'Besoins essentiels', pct: needsPct },
      { label: 'Envies / loisirs', pct: wantsPct },
      { label: 'Épargne / remboursement dettes', pct: savingsPct },
    ];
    el.querySelector('#env-results').innerHTML = rows.map((r) => `
      <div class="summary-card">
        <div class="summary-card-label">${r.label} (${r.pct}%)</div>
        <div class="summary-card-value">${formatCurrency(income2 * r.pct / 100, summary.currency)}</div>
      </div>`).join('');
  }
  return { html, wire: () => { document.getElementById('tool-envelope').addEventListener('input', compute); compute(); } };
}

/* ---------- 5. Analyse des habitudes & détection d'anomalies ---------- */
async function renderAnomalyTool() {
  const [wallets, transactions] = await Promise.all([dbGetAll(STORES.WALLETS), dbGetAll(STORES.TRANSACTIONS)]);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const { rates, baseCurrency } = await getExchangeRatesSafe();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = localISODate(cutoff);

  const dailyTotals = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || !t.date || t.date < cutoffStr) continue;
    const amt = convertAmount(t.amount, walletCurrency[t.walletId] || baseCurrency, baseCurrency, rates, baseCurrency);
    dailyTotals.set(t.date, (dailyTotals.get(t.date) || 0) + amt);
  }

  const values = [...dailyTotals.values()];
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const variance = values.length ? values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length : 0;
  const stdev = Math.sqrt(variance);
  const threshold = mean + 2 * stdev;

  const anomalies = [...dailyTotals.entries()]
    .filter(([, v]) => v > threshold && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const body = anomalies.length
    ? anomalies.map(([date, v]) => {
      const pctAbove = mean ? ((v - mean) / mean) * 100 : 0;
      return `<div class="stat-row"><span class="stat-row-label">${date}</span><span>${formatCurrency(v, baseCurrency)} <span class="badge badge-neg">+${pctAbove.toFixed(0)}% vs moyenne</span></span></div>`;
    }).join('')
    : '<div class="empty-state">Aucune anomalie détectée sur les 90 derniers jours.</div>';

  const html = panel('Analyse des habitudes & détection d\'anomalies (90 derniers jours)',
    `<p style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">Moyenne journalière : ${formatCurrency(mean, baseCurrency)} · Écart-type : ${formatCurrency(stdev, baseCurrency)}. Un jour est signalé si ses dépenses dépassent la moyenne + 2 écarts-types.</p>${body}`);
  return { html, wire: () => {} };
}

async function getExchangeRatesSafe() {
  const baseCurrency = await getSetting('baseCurrency', 'EUR');
  const rates = await dbGetAll(STORES.EXCHANGE_RATES);
  return { rates, baseCurrency };
}

/* ---------- 6. Journal d'audit ---------- */
function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(d);
}
const ACTION_LABELS = { create: 'Création', update: 'Modification', delete: 'Suppression' };

async function renderAuditLogTool() {
  const rows = (await dbGetAll(STORES.AUDIT_LOG)).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 150);
  const body = rows.length
    ? `<div style="max-height:420px;overflow-y:auto;">${rows.map((r) => `
        <div class="stat-row">
          <span class="stat-row-label">${formatDateTime(r.timestamp)} · ${escapeHtml(r.entityType)}</span>
          <span class="badge ${r.action === 'delete' ? 'badge-neg' : r.action === 'create' ? 'badge-pos' : 'badge-accent'}">${ACTION_LABELS[r.action] || r.action}${r.note ? ' — ' + escapeHtml(r.note) : ''}</span>
        </div>`).join('')}</div>`
    : '<div class="empty-state">Aucune activité enregistrée pour le moment.</div>';
  const html = panel("Journal d'audit (150 dernières actions)", body);
  return { html, wire: () => {} };
}

/* ---------- Point d'entrée ---------- */
export async function renderTools() {
  const container = document.getElementById('tools-content');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Chargement des outils…</div>';

  const tools = await Promise.all([
    renderWealthTrajectoryTool(),
    renderInflationTool(),
    renderEmergencyFundTool(),
    renderEnvelopeTool(),
    renderAnomalyTool(),
    renderAuditLogTool(),
  ]);

  container.innerHTML = tools.map((t) => t.html).join('');
  tools.forEach((t) => t.wire());
}

export function initToolsModule() {
  // Rien à câbler statiquement : chaque outil se recalcule via ses propres écouteurs "input".
}
