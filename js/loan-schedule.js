/* ==========================================================================
   Djignan Financial System — Prêts avec intérêts : mensualité, échéancier, intérêts courus
   Module PUR (aucun accès base ni DOM), testé hors navigateur. Les montants sont arrondis à la précision
   de la devise (entiers pour XOF/XAF/JPY, centimes sinon) pour qu'une mensualité affichée soit exactement
   ce qu'on peut payer.

   Modèle : une dette porte `interestRate` (taux annuel nominal, en %) et, facultativement, `termMonths`.
   Mensualité constante (annuité) ; la première échéance tombe un mois après la date de départ, le jour du
   mois étant conservé (clampé au dernier jour des mois courts, comme les récurrences).
   Un remboursement enregistre `amount` (le CAPITAL remboursé, qui fait baisser le restant dû) et
   `interestPart` (la part d'intérêts, une vraie charge) : le total versé est amount + interestPart.
   ========================================================================== */

function pad(n) { return String(n).padStart(2, '0'); }

/** Date AAAA-MM-JJ + n mois, jour conservé (ramené au dernier jour du mois cible s'il n'existe pas). */
export function addMonthsISO(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  const target = new Date(y, (m - 1) + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(Math.min(d, last))}`;
}

export function roundTo(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Mensualité constante d'un prêt (annuité). Taux nul : capital / durée. */
export function annuityPayment(principal, annualRatePct, months, decimals = 2) {
  if (!(principal > 0) || !(months > 0)) return 0;
  const r = (annualRatePct || 0) / 100 / 12;
  const raw = r === 0 ? principal / months : (principal * r) / (1 - Math.pow(1 + r, -months));
  return roundTo(raw, decimals);
}

/** Échéancier complet. Renvoie { rows: [{ index, date, payment, interest, principal, balance }],
    payment, totalInterest, totalPaid }. La dernière ligne solde exactement le capital (les arrondis
    s'y absorbent). Un prêt sans durée (termMonths absent) n'a pas d'échéancier : rows = []. */
export function buildSchedule({ principal, annualRatePct = 0, termMonths = 0, startDate, decimals = 2 }) {
  const months = Math.floor(Number(termMonths) || 0);
  if (!(principal > 0) || months < 1 || !startDate) return { rows: [], payment: 0, totalInterest: 0, totalPaid: 0 };
  const r = (annualRatePct || 0) / 100 / 12;
  const payment = annuityPayment(principal, annualRatePct, months, decimals);
  const rows = [];
  let balance = principal;
  let totalInterest = 0;
  for (let i = 1; i <= months; i++) {
    const interest = roundTo(balance * r, decimals);
    let principalPart = roundTo(payment - interest, decimals);
    let pay = payment;
    if (i === months || principalPart > balance) { principalPart = roundTo(balance, decimals); pay = roundTo(principalPart + interest, decimals); }
    balance = roundTo(balance - principalPart, decimals);
    totalInterest = roundTo(totalInterest + interest, decimals);
    rows.push({ index: i, date: addMonthsISO(startDate, i), payment: pay, interest, principal: principalPart, balance });
  }
  return { rows, payment, totalInterest, totalPaid: roundTo(rows.reduce((s, row) => s + row.payment, 0), decimals) };
}

/** Rapproche l'échéancier de ce qui a été versé (total = capital + intérêts) : chaque ligne est
    « paid » si le cumul des échéances jusqu'à elle est couvert, sinon « due » (date passée),
    « upcoming » (à venir). `next` = première ligne non couverte. `shortfall` = ce qui manque pour
    couvrir les échéances déjà dues (retard), 0 si à jour. */
export function scheduleStatus(schedule, cashPaid, today) {
  let cumulative = 0;
  let next = null;
  let dueTotal = 0;
  const rows = schedule.rows.map((row) => {
    cumulative = roundTo(cumulative + row.payment, 6);
    let status;
    if (cumulative <= cashPaid + 0.005) status = 'paid';
    else {
      status = row.date <= today ? 'due' : 'upcoming';
      if (!next) next = row;
    }
    if (row.date <= today) dueTotal = cumulative;
    return { ...row, status };
  });
  return { rows, next, shortfall: Math.max(0, roundTo(dueTotal - cashPaid, 6)) };
}

/** Intérêts courus entre deux dates sur un capital restant, au taux annuel (jours réels / 365). */
export function accruedInterest(balance, annualRatePct, fromDate, toDate, decimals = 2) {
  if (!(balance > 0) || !(annualRatePct > 0) || !fromDate || !toDate) return 0;
  const a = new Date(String(fromDate).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(toDate).slice(0, 10) + 'T00:00:00');
  const days = Math.max(0, Math.round((b - a) / 86400000));
  return roundTo(balance * (annualRatePct / 100) * (days / 365), decimals);
}

/** Mensualités RESTANT À PAYER d'un prêt à intérêts (échéancier rapproché de ce qui a déjà été versé), en retard
    comprises. Vide si la dette n'a pas de taux ni de durée. Partagée par la prévision de trésorerie, les rappels
    et les notifications : toutes lisent la même échéance. */
export function unpaidInstallments(debt, payments, today, decimals = 2) {
  if (!(debt.termMonths > 0) || !(debt.interestRate > 0) || debt.status === 'paid') return [];
  const schedule = buildSchedule({ principal: debt.principal, annualRatePct: debt.interestRate, termMonths: debt.termMonths, startDate: debt.startDate, decimals });
  if (!schedule.rows.length) return [];
  const cashPaid = payments.filter((p) => p.debtId === debt.id).reduce((sum, p) => sum + p.amount + (Number(p.interestPart) || 0), 0);
  return scheduleStatus(schedule, cashPaid, today).rows.filter((row) => row.status !== 'paid');
}
