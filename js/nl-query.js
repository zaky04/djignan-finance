/* ==========================================================================
   Djignan Financial System — Questions en langage naturel, traitées en local
   « Combien j'ai dépensé en transport en septembre ? », « Qui me doit de l'argent ? »,
   « Quel est mon solde ? », « Ma plus grosse dépense ce mois ? »…

   Aucun modèle de langage, aucun envoi : un petit analyseur à règles reconnaît l'INTENTION (dépense,
   entrée, solde, qui me doit, plus grosse dépense), la PÉRIODE (aujourd'hui, ce mois, mois dernier,
   « en septembre », 30 derniers jours…) et un FILTRE (une catégorie, une étiquette, ou un mot de la
   note, comme « taxi »). Ce qu'il ne comprend pas, il ne l'invente pas : answerQuestion() renvoie
   null et la recherche normale prend le relais.

   Module pur (answerQuestion) : aucun accès base, testé hors navigateur ; askLocally() charge les données.
   Français et anglais.
   ========================================================================== */

import { STORES, dbGetAll, getSetting } from './db.js';
import { isInvestmentMovementExcluded } from './ledger.js';
import { convertAmount, formatCurrency, formatDate, formatMonthLabel, localISODate, todayISO } from './utils.js';
import { t as tr } from './i18n.js';

export function normalizeText(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
}

const QUESTION_START = /^(combien|quel|quelle|quels|quelles|qui|ou en suis|ou ai-je|how much|how many|what|who|which|total)\b/;
export function isQuestion(text) {
  const q = normalizeText(text);
  return q.length >= 6 && (q.includes('?') || QUESTION_START.test(q));
}

const MONTHS = [
  ['janvier', 'january'], ['fevrier', 'february'], ['mars', 'march'], ['avril', 'april'], ['mai', 'may'], ['juin', 'june'],
  ['juillet', 'july'], ['aout', 'august'], ['septembre', 'september'], ['octobre', 'october'], ['novembre', 'november'], ['decembre', 'december'],
];

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Période visée par la question : { start, end, label (texte clé), tag } ou null. */
export function parsePeriod(question, today = todayISO()) {
  const q = normalizeText(question);
  const [y, m, d] = today.split('-').map(Number);
  const day = (offset) => localISODate(new Date(y, m - 1, d + offset));
  const monday = () => { const dow = new Date(y, m - 1, d).getDay(); return -((dow + 6) % 7); };
  const lastOf = (yy, mm) => new Date(yy, mm, 0).getDate();

  let match;
  if ((match = /(?:(\d+)\s+derniers?\s+jours|(?:last|past)\s+(\d+)\s+days)/.exec(q))) {
    const n = Math.min(730, Number(match[1] || match[2]));
    return { start: day(-(n - 1)), end: today, kind: 'days', n };
  }
  if (/\b(aujourd'hui|today)\b/.test(q)) return { start: today, end: today, kind: 'today' };
  if (/\b(hier|yesterday)\b/.test(q)) return { start: day(-1), end: day(-1), kind: 'yesterday' };
  if (/semaine derniere|last week|previous week/.test(q)) return { start: day(monday() - 7), end: day(monday() - 1), kind: 'lastWeek' };
  if (/cette semaine|this week/.test(q)) return { start: day(monday()), end: today, kind: 'week' };
  if (/mois dernier|mois precedent|last month|previous month/.test(q)) {
    const pm = m === 1 ? 12 : m - 1; const py = m === 1 ? y - 1 : y;
    return { start: iso(py, pm, 1), end: iso(py, pm, lastOf(py, pm)), kind: 'month', month: `${py}-${pad(pm)}` };
  }
  if (/annee derniere|last year|previous year/.test(q)) return { start: iso(y - 1, 1, 1), end: iso(y - 1, 12, 31), kind: 'year', year: y - 1 };
  if (/cette annee|this year/.test(q)) return { start: iso(y, 1, 1), end: today, kind: 'year', year: y };
  // « en septembre », « septembre 2025 », « in september »
  for (let i = 0; i < 12; i++) {
    const re = new RegExp(`\\b(${MONTHS[i][0]}|${MONTHS[i][1]})\\b(?:\\s+(20\\d\\d))?`);
    if ((match = re.exec(q))) {
      const month = i + 1;
      const year = match[2] ? Number(match[2]) : (month > m ? y - 1 : y); // sans année : le plus récent déjà commencé
      return { start: iso(year, month, 1), end: iso(year, month, lastOf(year, month)), kind: 'month', month: `${year}-${pad(month)}` };
    }
  }
  if (/ce mois|this month/.test(q)) return { start: iso(y, m, 1), end: iso(y, m, lastOf(y, m)), kind: 'month', month: `${y}-${pad(m)}` };
  return null;
}

function periodLabel(period) {
  if (!period) return '';
  if (period.kind === 'month') return formatMonthLabel(period.month);
  if (period.kind === 'today') return tr("aujourd'hui");
  if (period.kind === 'yesterday') return tr('hier');
  if (period.kind === 'year') return String(period.year);
  if (period.kind === 'days') return tr('sur les {n} derniers jours', { n: period.n });
  return `${formatDate(period.start)} → ${formatDate(period.end)}`;
}

// Mots qui ne désignent pas ce qu'on cherche (filtre « mot de la note »).
const STOP = new Set(('combien quel quelle quels quelles qui ou est sont ai as a avons ont j\'ai j\' je tu il on me mon ma mes de du des le la les l\' un une et en au aux pour sur dans par ce cet cette ces ca ' +
  'depense depenses depenser depense ai-je paye payes sorti sortis recu recus gagne gagnes entre entres entrees revenu revenus argent total solde reste doit dois dois-je grosse gros grande plus ' +
  'aujourd\'hui hier semaine mois annee derniers derniere dernier precedent jours jour fin debut depuis ' +
  'how much many did i do my me spent spend earned received get got what is the was were of for on in at to a an this last previous past days day week month year total balance owe owes who ' +
  'janvier fevrier mars avril mai juin juillet aout septembre octobre novembre decembre january february march april june july august september october november december').split(' '));

function keywordsOf(question, consumed) {
  return normalizeText(question).replace(/\?/g, ' ').replace(/\b20\d\d\b/g, ' ').replace(/\b\d+\b/g, ' ')
    .split(/[^a-z0-9']+/).map((w) => w.replace(/^'+|'+$/g, '')).filter((w) => w.length >= 3 && !STOP.has(w) && !consumed.has(w));
}

function singular(word) { return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word; }

/** Réponse à une question, ou null si elle n'est pas comprise. */
export function answerQuestion(question, data, { today = todayISO() } = {}) {
  const { transactions = [], categories = [], wallets = [], debts = [], payments = [], rates = [], baseCurrency = 'XOF' } = data;
  const q = normalizeText(question);
  if (!q) return null;
  const money = (v) => formatCurrency(v, baseCurrency);
  const toBase = (amount, cur) => convertAmount(amount, cur, baseCurrency, rates, baseCurrency);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));

  // ---- Qui me doit / combien je dois ----
  const remainingOf = (d) => Math.max(0, (d.principal || 0) - payments.filter((p) => p.debtId === d.id).reduce((s, p) => s + p.amount, 0));
  const open = debts.filter((d) => d.status !== 'paid' && d.status !== 'cancelled' && remainingOf(d) > 0.005);
  const named = open.filter((d) => q.includes(normalizeText(d.personName)));
  const owedToMeAsk = /\bqui me doit|me doit|owes me|owe me|who owes\b/.test(q);
  const iOweAsk = /combien je dois|je dois combien|a qui je dois|i owe|what do i owe/.test(q);
  if (owedToMeAsk || iOweAsk) {
    const type = owedToMeAsk ? 'receivable' : 'debt';
    const pool = (named.length ? named : open).filter((d) => d.type === type);
    if (!pool.length) return { kind: 'debts', text: owedToMeAsk ? tr("Personne ne vous doit d'argent pour le moment.") : tr("Vous ne devez rien pour le moment.") };
    const byPerson = new Map();
    for (const d of pool) byPerson.set(d.personName, (byPerson.get(d.personName) || 0) + toBase(remainingOf(d), d.currency));
    const total = [...byPerson.values()].reduce((s, v) => s + v, 0);
    const list = [...byPerson.entries()].sort((a, b) => b[1] - a[1]).map(([name, v]) => `${name} : ${money(v)}`);
    return { kind: 'debts', text: owedToMeAsk ? tr('On vous doit {amount} au total.', { amount: money(total) }) : tr('Vous devez {amount} au total.', { amount: money(total) }), lines: list };
  }

  // ---- Solde ----
  if (/\bsolde\b|combien (me reste|il me reste|j'ai en tout|ai-je en tout)|how much (money )?(do i have|is left|have i got)|\bbalance\b/.test(q) && !/depens|spent|recu|gagne|earned/.test(q)) {
    const balances = new Map(wallets.map((w) => [w.id, w.initialBalance || 0]));
    for (const tx of transactions) {
      const amt = Number(tx.amount) || 0;
      if (tx.type === 'income') balances.set(tx.walletId, (balances.get(tx.walletId) || 0) + amt);
      else if (tx.type === 'expense') balances.set(tx.walletId, (balances.get(tx.walletId) || 0) - amt);
      else if (tx.type === 'transfer') { balances.set(tx.walletId, (balances.get(tx.walletId) || 0) - amt); balances.set(tx.targetWalletId, (balances.get(tx.targetWalletId) || 0) + amt); }
    }
    const active = wallets.filter((w) => !w.archived);
    const total = active.reduce((s, w) => s + toBase(balances.get(w.id) || 0, w.currency), 0);
    return { kind: 'balance', text: tr('Vous avez {amount} au total sur vos portefeuilles.', { amount: money(total) }), lines: active.map((w) => `${w.name} : ${formatCurrency(balances.get(w.id) || 0, w.currency)}`) };
  }

  // ---- Dépenses / entrées / plus grosse dépense ----
  const wantsIncome = /recu|recois|gagne|gagn|revenu|entree|entre\b|income|earned|received|salary|salaire/.test(q);
  const wantsBiggest = /plus gros|plus grande|plus grosse|biggest|largest|highest/.test(q);
  const wantsSpend = /depens|sorti|paye|spent|spend|cout|cost|achete|bought|paid/.test(q);
  if (!wantsIncome && !wantsSpend && !wantsBiggest && !/combien|how much/.test(q)) return null;
  const type = wantsIncome && !wantsSpend && !wantsBiggest ? 'income' : 'expense';

  const period = parsePeriod(question, today) || (() => { const [y, m] = today.split('-').map(Number); return { start: iso(y, m, 1), end: today, kind: 'month', month: `${y}-${pad(m)}` }; })();

  // Filtre : catégorie (nom le plus long contenu dans la question) puis mots de la note/étiquette.
  const catMatches = categories.filter((c) => c.type === type && c.name && (q.includes(normalizeText(c.name)) || q.includes(singular(normalizeText(c.name))))).sort((a, b) => b.name.length - a.name.length);
  const category = catMatches[0] || null;
  const consumed = new Set(category ? normalizeText(category.name).split(/[^a-z0-9']+/) : []);
  const keywords = keywordsOf(question, consumed);
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));

  const rows = transactions.filter((tx) => {
    if (tx.type !== type || tx.debtId || isInvestmentMovementExcluded(tx)) return false;
    if (!tx.date || tx.date < period.start || tx.date > period.end) return false;
    if (category && tx.categoryId !== category.id) return false;
    if (keywords.length) {
      const hay = normalizeText(`${tx.note || ''} ${(tx.tags || []).join(' ')} ${catName[tx.categoryId] || ''}`);
      if (!keywords.every((k) => hay.includes(k) || hay.includes(singular(k)))) return false;
    }
    return true;
  }).map((tx) => ({ tx, amount: toBase(Number(tx.amount) || 0, walletCurrency[tx.walletId] || baseCurrency) }));

  const filterText = [category ? `« ${category.name} »` : '', keywords.length ? `« ${keywords.join(' ')} »` : ''].filter(Boolean).join(' ');
  const when = periodLabel(period);

  if (!rows.length) {
    return { kind: type, text: filterText ? tr('Aucune opération trouvée pour {filter} ({period}).', { filter: filterText, period: when }) : tr('Aucune opération trouvée ({period}).', { period: when }) };
  }
  if (wantsBiggest) {
    const top = rows.reduce((a, b) => (b.amount > a.amount ? b : a));
    const name = (top.tx.note || '').trim() || catName[top.tx.categoryId] || tr('Sans catégorie');
    return { kind: 'biggest', text: tr('Plus grosse opération ({period}) : {name}, {amount} le {date}.', { period: when, name, amount: money(top.amount), date: formatDate(top.tx.date) }) };
  }
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const head = type === 'income' ? tr('Entrées') : tr('Dépenses');
  return { kind: type, text: tr('{head}{filter} ({period}) : {amount} en {count} opération(s).', { head, filter: filterText ? ` — ${filterText}` : '', period: when, amount: money(total), count: rows.length }), total, count: rows.length };
}

export async function askLocally(question) {
  const [transactions, categories, wallets, debts, payments, rates, baseCurrency] = await Promise.all([
    dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.CATEGORIES), dbGetAll(STORES.WALLETS), dbGetAll(STORES.DEBTS),
    dbGetAll(STORES.DEBT_PAYMENTS), dbGetAll(STORES.EXCHANGE_RATES), getSetting('baseCurrency', 'EUR'),
  ]);
  return answerQuestion(question, { transactions, categories, wallets, debts, payments, rates, baseCurrency });
}
