/* ==========================================================================
   Djignan Financial System — Bilan de l'année à partager
   Même mécanique que le bilan du mois (monthly-recap.js) : des phrases calculées en local par des règles
   simples, une image à envoyer et un texte à copier, avec ou sans les montants. Rien ne quitte l'appareil.

   buildAnnualRecap est pur (aucun accès base) et testé hors navigateur ; loadAnnualRecap le nourrit.
   ========================================================================== */

import { STORES, dbGetAll, getSetting } from './db.js';
import { computeNetWorth } from './ledger.js';
import { periodTotals, shareRecapImage } from './monthly-recap.js';
import { formatCurrency, intlLocale } from './utils.js';
import { t as tr } from './i18n.js';

const MASK = '•••';

function monthName(year, monthIndex) {
  return new Intl.DateTimeFormat(intlLocale(), { month: 'long' }).format(new Date(year, monthIndex, 1));
}

export function buildAnnualRecap({ year, transactions = [], wallets = [], categories = [], rates = [], baseCurrency = 'XOF', netWorthStart = null, netWorthEnd = null }) {
  const data = { transactions, wallets, categories, rates, baseCurrency };
  const total = periodTotals(String(year), data);
  const prev = periodTotals(String(year - 1), data);
  const months = [];
  for (let m = 0; m < 12; m++) {
    const key = `${year}-${String(m + 1).padStart(2, '0')}`;
    const mt = periodTotals(key, data);
    if (mt.income > 0 || mt.expenses > 0) months.push({ monthIndex: m, income: mt.income, expenses: mt.expenses, net: mt.income - mt.expenses });
  }
  const net = total.income - total.expenses;
  const top = [...total.byCategory.values()].sort((a, b) => b.value - a.value).slice(0, 5)
    .map((row) => ({ ...row, share: total.expenses > 0 ? (row.value / total.expenses) * 100 : 0 }));
  const bestMonth = months.length ? [...months].sort((a, b) => b.net - a.net)[0] : null;
  const priciestMonth = months.length ? [...months].sort((a, b) => b.expenses - a.expenses)[0] : null;
  return {
    year, currency: baseCurrency, income: total.income, expenses: total.expenses, net,
    savingsRate: total.income > 0 ? (net / total.income) * 100 : null,
    monthsWithData: months.length,
    avgMonthlyExpenses: months.length ? total.expenses / months.length : 0,
    prevExpenses: prev.expenses,
    expensesDeltaPct: prev.expenses > 0 ? ((total.expenses - prev.expenses) / prev.expenses) * 100 : null,
    top, bestMonth, priciestMonth, biggest: total.biggest,
    netWorthChange: netWorthStart != null && netWorthEnd != null && Math.abs(netWorthStart) > 0.005 ? netWorthEnd - netWorthStart : null,
    hasData: total.income > 0 || total.expenses > 0,
  };
}

/** Phrases du bilan annuel (au plus 5), par règles. `hideAmounts` remplace tout montant par •••. */
export function annualHighlights(recap, { hideAmounts = false } = {}) {
  const money = (v) => (hideAmounts ? MASK : formatCurrency(v, recap.currency));
  const lines = [];
  if (recap.expenses > 0) {
    if (recap.expensesDeltaPct != null && Math.abs(recap.expensesDeltaPct) >= 3) {
      lines.push(recap.expensesDeltaPct > 0
        ? tr('Vous avez dépensé {amount} en {year} ({avg} par mois), soit {pct} % de plus qu\'en {prev}.', { amount: money(recap.expenses), year: recap.year, avg: money(recap.avgMonthlyExpenses), pct: Math.round(recap.expensesDeltaPct), prev: recap.year - 1 })
        : tr('Vous avez dépensé {amount} en {year} ({avg} par mois), soit {pct} % de moins qu\'en {prev}.', { amount: money(recap.expenses), year: recap.year, avg: money(recap.avgMonthlyExpenses), pct: Math.round(-recap.expensesDeltaPct), prev: recap.year - 1 }));
    } else {
      lines.push(tr('Vous avez dépensé {amount} en {year}, soit {avg} par mois en moyenne.', { amount: money(recap.expenses), year: recap.year, avg: money(recap.avgMonthlyExpenses) }));
    }
  }
  if (recap.income > 0) {
    lines.push(recap.net >= 0
      ? tr('Vous avez mis de côté {amount} sur l\'année ({pct} % de vos entrées).', { amount: money(recap.net), pct: Math.round(recap.savingsRate) })
      : tr('Vos dépenses dépassent vos entrées de {amount} sur l\'année.', { amount: money(-recap.net) }));
  }
  if (recap.top[0]) lines.push(tr('{name} pèse {pct} % de vos dépenses ({amount}).', { name: recap.top[0].name, pct: Math.round(recap.top[0].share), amount: money(recap.top[0].value) }));
  if (recap.bestMonth && recap.monthsWithData >= 3 && recap.bestMonth.net > 0) {
    lines.push(tr('Votre meilleur mois : {month} ({amount} mis de côté).', { month: monthName(recap.year, recap.bestMonth.monthIndex), amount: money(recap.bestMonth.net) }));
  }
  if (recap.priciestMonth && recap.monthsWithData >= 3) {
    lines.push(tr('Le mois le plus cher : {month} ({amount} de dépenses).', { month: monthName(recap.year, recap.priciestMonth.monthIndex), amount: money(recap.priciestMonth.expenses) }));
  }
  if (recap.netWorthChange != null) {
    lines.push(recap.netWorthChange >= 0
      ? tr('Votre patrimoine a progressé de {amount} sur l\'année.', { amount: money(recap.netWorthChange) })
      : tr('Votre patrimoine a reculé de {amount} sur l\'année.', { amount: money(-recap.netWorthChange) }));
  }
  return lines.slice(0, 5);
}

export function annualAsText(recap, opts = {}) {
  const money = (v) => (opts.hideAmounts ? MASK : formatCurrency(v, recap.currency));
  return [
    tr('Mon année — {year}', { year: recap.year }),
    `${tr('Entrées')} : ${money(recap.income)} · ${tr('Sorties')} : ${money(recap.expenses)} · ${tr('Épargne nette')} : ${money(recap.net)}`,
    ...annualHighlights(recap, opts).map((l) => `• ${l}`),
    'Djignan',
  ].join('\n');
}

export async function loadAnnualRecap(year) {
  const [transactions, wallets, categories, rates, baseCurrency] = await Promise.all([
    dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES), dbGetAll(STORES.EXCHANGE_RATES), getSetting('baseCurrency', 'EUR'),
  ]);
  const thisYear = new Date().getFullYear();
  const [start, end] = await Promise.all([
    computeNetWorth(`${year - 1}-12-31`),
    computeNetWorth(year < thisYear ? `${year}-12-31` : null),
  ]);
  return buildAnnualRecap({ year, transactions, wallets, categories, rates, baseCurrency, netWorthStart: start.total, netWorthEnd: end.total });
}

/** Partage l'image du bilan annuel (voir shareRecapImage) — la carte est la même que celle du mois, avec
    l'année en titre et les phrases annuelles. */
export function shareAnnualImage(recap, opts = {}) {
  return shareRecapImage({
    currency: recap.currency, income: recap.income, expenses: recap.expenses, net: recap.net, top: recap.top,
    title: String(recap.year), fileKey: String(recap.year),
    linesFn: (o) => annualHighlights(recap, o), textFn: (o) => annualAsText(recap, o),
  }, opts);
}
