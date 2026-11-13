/* ==========================================================================
   Djignan Financial System — Détail du « reste à vivre »
   Le chiffre intègre des échéances (récurrences, mensualités de prêt, dettes arrivant à terme) et des budgets encore
   disponibles : sans détail, impossible de savoir d'où il vient ni de repérer une anomalie. Cette fenêtre le décompose
   ligne par ligne avec la MÊME formule que le chiffre affiché (explainSafeToSpend, ledger.js) : la somme des lignes est
   toujours égale au reste à vivre.
   ========================================================================== */

import { STORES, dbGetAll } from '../db.js';
import { computeEndOfMonthForecast, computeBudgetVsActual, explainSafeToSpend } from '../ledger.js';
import { formatCurrency, formatDate, escapeHtml, openModal, currentMonthKey, todayISO } from '../utils.js';
import { t } from '../i18n.js';

export async function openSafeToSpendDetail() {
  const [forecast, budgetRows, debts] = await Promise.all([
    computeEndOfMonthForecast(), computeBudgetVsActual(currentMonthKey()), dbGetAll(STORES.DEBTS),
  ]);
  const e = explainSafeToSpend(forecast, budgetRows);
  const cur = forecast.currency;
  const today = todayISO();
  const money = (value) => formatCurrency(value, cur);
  const line = (label, valueHtml, { strong = false, sub = '' } = {}) => `
    <div class="stat-row${strong ? ' fw-700' : ''}">
      <span class="stat-row-label">${label}${sub ? `<span class="tx-sub" style="display:block;">${sub}</span>` : ''}</span>
      <span>${valueHtml}</span>
    </div>`;

  const billLines = e.bills.length
    ? e.bills.map((b) => line(
      `${escapeHtml(b.name)}${b.isDebt ? ` <span class="badge">${t('dette')}</span>` : ''}`,
      `−${escapeHtml(money(b.amount))}`,
      { sub: `${b.date < today ? `<span class="c-neg">${t('en retard')}</span> · ` : ''}${escapeHtml(formatDate(b.date))}` },
    )).join('')
    : `<div class="tx-sub mb-8">${t('Aucune échéance à venir ce mois-ci.')}</div>`;

  const reservedLines = e.reserved.length
    ? e.reserved.map((r) => line(escapeHtml(r.label), `−${escapeHtml(money(r.amount))}`)).join('')
    : `<div class="tx-sub mb-8">${t('Aucun budget à réserver.')}</div>`;

  const ignored = debts.filter((d) => d.type === 'debt' && d.forecastIgnored && d.status !== 'paid' && d.status !== 'cancelled').length;

  openModal(`
    ${line(t('Liquidités courantes'), `+${escapeHtml(money(e.current))}`, { sub: t("Portefeuilles du quotidien seulement (ni l'épargne, ni les comptes bloqués).") })}
    <div class="fw-700 fs-14 mt-12 mb-4">${t('Échéances à venir ce mois-ci')} · −${escapeHtml(money(e.billsTotal))}</div>
    ${billLines}
    <div class="fw-700 fs-14 mt-12 mb-4">${t('Budgets encore disponibles')} · −${escapeHtml(money(e.reservedTotal))}</div>
    ${reservedLines}
    <div style="border-top:2px solid var(--border);margin-top:12px;padding-top:6px;">
      ${line(t('Reste à vivre'), `<strong class="${e.safeToSpend < 0 ? 'c-neg' : ''}">${escapeHtml(money(e.safeToSpend))}</strong>`, { strong: true })}
    </div>
    <p class="fs-12 c-muted mt-10">${t("Un budget déjà couvert par une échéance de sa catégorie n'est pas compté deux fois.")}</p>
    ${ignored ? `<p class="fs-12 c-muted">${t('{count} dette(s) ignorée(s) dans la prévision (case « Ne pas compter cette dette… » de leur fiche).', { count: ignored })}</p>` : ''}
  `, { title: t('Détail du reste à vivre') });
}
