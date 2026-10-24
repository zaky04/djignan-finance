/* ==========================================================================
   Djignan Financial System — Prévision de trésorerie (30 / 60 jours)
   Réponse à : « vais-je tenir jusqu'à la fin du mois, et quand ça se tend ? ». À partir du solde
   COURANT d'aujourd'hui (les portefeuilles épargne/bloqué n'y sont pas, comme dans « Reste à vivre »),
   on déroule jour par jour ce qui est déjà connu :
   - CERTAIN : récurrences actives (loyer, abonnements, apports automatiques…), dettes qu'on doit
     rembourser à leur échéance, cotisations de tontine à verser ;
   - INCERTAIN (courbe « optimiste », séparée) : créances qu'on attend d'encaisser à leur échéance,
     pot de tontine à recevoir — rien ne garantit qu'ils arrivent ce jour-là.
   Les dépenses courantes non récurrentes (courses, transport…) ne sont PAS projetées : ce n'est pas une
   moyenne, c'est la liste de ce qu'on sait déjà. Le message le dit.

   Module pur (buildCashflowForecast) : aucun accès base, testé hors navigateur. Il utilise
   advanceDate (recurrence.js), la même fonction que la génération automatique des récurrences.
   ========================================================================== */

import { STORES, dbGetAll, getSetting } from './db.js';
import { walletBalancesAsOf, isDailyWallet } from './ledger.js';
import { advanceDate } from './recurrence.js';
import { roundDate } from './modules/tontines.js';
import { convertAmount, localISODate, todayISO, ZERO_DECIMAL_CURRENCIES } from './utils.js';
import { unpaidInstallments } from './loan-schedule.js';

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return localISODate(new Date(y, m - 1, d + n));
}

/**
 * @returns {{ startBalance, currency, days, events: [{date,label,amount,kind,certain,balance}],
 *   points: [{date, balance, optimistic}], minBalance, minDate, endBalance, endOptimistic,
 *   firstNegativeDate, totalIn, totalOut }}
 * `amount` est signé (négatif = sortie), en devise de base.
 */
export function buildCashflowForecast({ wallets = [], transactions = [], recurring = [], debts = [], payments = [], tontines = [], rates = [], baseCurrency = 'XOF', today = todayISO(), days = 60 }) {
  const toBase = (amount, currency) => convertAmount(amount, currency, baseCurrency, rates, baseCurrency);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const end = addDays(today, days);

  const balances = walletBalancesAsOf(wallets, transactions);
  let startBalance = 0;
  for (const w of wallets) if (isDailyWallet(w)) startBalance += toBase(balances.get(w.id) || 0, w.currency);

  const events = [];
  const push = (date, label, amount, kind, certain) => {
    if (date < today) date = today; // une échéance en retard pèse dès aujourd'hui
    if (date > end || !amount) return;
    events.push({ date, label, amount, kind, certain });
  };

  // 1. Récurrences : toutes les occurrences de la fenêtre (pas seulement la prochaine).
  for (const r of recurring) {
    if (!r.active || !r.nextDate) continue;
    const currency = walletCurrency[r.walletId] || baseCurrency;
    const amount = toBase(Number(r.amount) || 0, currency) * (r.type === 'income' ? 1 : -1);
    let date = r.nextDate;
    for (let guard = 0; date <= end && guard < 400; guard++) {
      push(date, r.name, amount, 'recurring', true);
      const next = advanceDate(date, r.frequency, r.anchorDay);
      if (next <= date) break;
      date = next;
    }
  }

  // 2. Dettes et créances à échéance, pour ce qui reste dû.
  for (const d of debts) {
    // Prêt à intérêts avec échéancier : chaque mensualité restante pèse à sa date (au lieu d'une seule échéance finale).
    const installments = unpaidInstallments(d, payments, today, ZERO_DECIMAL_CURRENCIES.has(d.currency) ? 0 : 2);
    if (installments.length) {
      for (const row of installments) {
        const amount = toBase(row.payment, d.currency);
        if (d.type === 'debt') push(row.date, d.personName, -amount, 'debt', true);
        else push(row.date, d.personName, amount, 'receivable', false);
      }
      continue;
    }
    if (d.status === 'paid' || !d.dueDate) continue;
    const paid = payments.filter((p) => p.debtId === d.id).reduce((s, p) => s + p.amount, 0);
    const remaining = Math.max(0, (d.principal || 0) - paid);
    if (remaining <= 0.005) continue;
    const amount = toBase(remaining, d.currency);
    if (d.type === 'debt') push(d.dueDate, d.personName, -amount, 'debt', true);
    else push(d.dueDate, d.personName, amount, 'receivable', false);
  }

  // 3. Tontines : ma cotisation à chaque tour non payé (certain), le pot quand c'est mon tour (incertain).
  for (const tn of tontines) {
    for (let i = 0; i < tn.members.length; i++) {
      const date = roundDate(tn, i);
      if (date > end) break;
      const me = tn.members.find((m) => m.isMe);
      const paid = (tn.payments || []).some((p) => p.round === i && p.memberId === me?.id);
      if (!paid && date >= today) push(date, tn.name, -toBase(tn.amount, tn.currency), 'tontine', true);
      const beneficiaryId = tn.order[i % tn.order.length];
      const potReceived = (tn.pots || []).some((p) => p.round === i);
      if (beneficiaryId === me?.id && !potReceived && date >= today) push(date, tn.name, toBase(tn.amount * tn.members.length, tn.currency), 'pot', false);
    }
  }

  events.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);

  // Courbes jour par jour.
  const points = [];
  let certain = startBalance;
  let optimistic = startBalance;
  let idx = 0;
  let minBalance = startBalance; let minDate = today; let firstNegativeDate = startBalance < 0 ? today : null;
  for (let day = 0; day <= days; day++) {
    const date = addDays(today, day);
    while (idx < events.length && events[idx].date === date) {
      const ev = events[idx];
      optimistic += ev.amount;
      if (ev.certain) certain += ev.amount;
      ev.balance = certain;
      idx++;
    }
    points.push({ date, balance: certain, optimistic });
    if (certain < minBalance) { minBalance = certain; minDate = date; }
    if (certain < 0 && !firstNegativeDate) firstNegativeDate = date;
  }
  const certainEvents = events.filter((e) => e.certain);
  return {
    startBalance, currency: baseCurrency, days, events, points, minBalance, minDate, firstNegativeDate,
    endBalance: certain, endOptimistic: optimistic,
    totalIn: certainEvents.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0),
    totalOut: -certainEvents.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0),
  };
}

/** Charge les données et construit la prévision. */
export async function loadCashflowForecast(days = 60) {
  const [wallets, transactions, recurring, debts, payments, tontines, rates, baseCurrency] = await Promise.all([
    dbGetAll(STORES.WALLETS), dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.RECURRING), dbGetAll(STORES.DEBTS),
    dbGetAll(STORES.DEBT_PAYMENTS), dbGetAll(STORES.TONTINES), dbGetAll(STORES.EXCHANGE_RATES), getSetting('baseCurrency', 'EUR'),
  ]);
  return buildCashflowForecast({ wallets, transactions, recurring, debts, payments, tontines, rates, baseCurrency, days });
}
