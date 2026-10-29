/* ==========================================================================
   Djignan Financial System — Moteur de calcul financier partagé
   Centralise tous les calculs (soldes, agrégats mensuels, historique du
   patrimoine) pour que dashboard/wallets/budgets/investissements/dettes/
   outils/rapports affichent des chiffres strictement cohérents entre eux.

   Convention patrimoine net = soldes portefeuilles + valeur investissements
   + créances - dettes. Les objectifs d'épargne ne sont PAS additionnés en
   plus : leur argent est dans les portefeuilles d'usage Épargne/Bloqué qui
   leur sont liés (déjà comptés dans les soldes de portefeuilles), donc les
   compter à part créerait un double comptage. Un portefeuille Épargne ou
   Bloqué compte dans le patrimoine net mais PAS dans le « reste à vivre ».
   ========================================================================== */

import { STORES, dbGetAll, getSetting } from './db.js';
import { advanceDate } from './recurrence.js';
import { convertAmount, currentMonthKey, monthKeyOffset, localISODate, intlLocale } from './utils.js';
// Aliasé en tr (pas t) : ce fichier utilise `t` comme nom de variable pour une transaction dans
// plusieurs fonctions — même piège documenté dans dashboard.js/transactions.js/debts.js/tools.js/
// reports-extras.js/search.js/backup.js.
import { t as tr } from './i18n.js';

async function ctx() {
  const [wallets, transactions, categories, budgets, investments, investmentEntries, debts, debtPayments, rates, rateHistory, baseCurrency] = await Promise.all([
    dbGetAll(STORES.WALLETS),
    dbGetAll(STORES.TRANSACTIONS),
    dbGetAll(STORES.CATEGORIES),
    dbGetAll(STORES.BUDGETS),
    dbGetAll(STORES.INVESTMENTS),
    dbGetAll(STORES.INVESTMENT_ENTRIES),
    dbGetAll(STORES.DEBTS),
    dbGetAll(STORES.DEBT_PAYMENTS),
    dbGetAll(STORES.EXCHANGE_RATES),
    dbGetAll(STORES.EXCHANGE_RATE_HISTORY),
    getSetting('baseCurrency', 'EUR'),
  ]);
  return { wallets, transactions, categories, budgets, investments, investmentEntries, debts, debtPayments, rates, rateHistory, baseCurrency };
}

function toBase(amount, currency, rates, baseCurrency) {
  return convertAmount(amount, currency, baseCurrency, rates, baseCurrency);
}

/** Un mouvement de portefeuille lié à un investissement (investmentId) doit-il être exclu des
    agrégats de dépenses/revenus discrétionnaires (résumé mensuel, budget vs réel, camembert de
    catégories...) ? Achat/apport (investmentMovementType 'purchase'/'contribution', toujours
    type='expense') et retrait de capital ('withdrawal', type='income' mais ce n'est QUE le retour
    d'un capital déjà compté ailleurs, pas un revenu) : oui, exclus. Dividende ('dividend',
    type='income') : non — c'est un vrai revenu d'investissement, contrairement à
    investmentMovementType==='withdrawal' ou à un prêt reçu (debtId, exclu symétriquement des deux
    côtés lui aussi, voir plus bas). */
export function isInvestmentMovementExcluded(t) {
  // Cotisation ou pot de tontine (tontines.js) : de l'argent mis de côté puis récupéré, ni une dépense
  // ni un revenu. Sa contrepartie est comptée dans le patrimoine (voir tontinePositionAsOf).
  if (t.tontineId) return true;
  if (!t.investmentId) return false;
  return t.type === 'expense' || t.investmentMovementType === 'withdrawal';
}

/** Reconstruit les taux tels qu'ils étaient à une date donnée : pour chaque devise, on prend
    l'entrée d'historique la plus récente à/avant cutoffDate, ou le taux actuel si aucun
    historique n'existe encore pour cette devise (compatibilité avec les données existantes). */
function ratesAsOf(cutoffDate, rates, rateHistory) {
  if (!cutoffDate) return rates;
  return rates.map((r) => {
    const past = rateHistory
      .filter((h) => h.code === r.code && h.date <= cutoffDate)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    return past.length ? { ...r, rateToBase: past[0].rateToBase } : r;
  });
}

/** Rôle d'un portefeuille : 'current' (utilisable au quotidien — TOUS les portefeuilles créés avant
    l'existence de ce champ), 'savings' (épargne) ou 'blocked' (bloqué jusqu'à une date de
    déblocage). Un portefeuille non courant n'apparaît dans AUCUN sélecteur du quotidien (saisie
    express, récurrences, remboursements, achats d'investissement…) : on n'y verse et on n'en retire
    qu'en ouvrant sa fiche (wallets.js) ou depuis l'objectif d'épargne qui lui est lié. */
export function walletUsage(wallet) {
  return wallet?.usage === 'savings' || wallet?.usage === 'blocked' ? wallet.usage : 'current';
}

/** Portefeuille proposable dans les sélecteurs du quotidien : actif ET courant. */
export function isDailyWallet(wallet) {
  return !wallet.archived && walletUsage(wallet) === 'current';
}

/** Raison pour laquelle on ne peut PAS retirer d'argent de ce portefeuille aujourd'hui (portefeuille
    bloqué avant sa date de déblocage), ou null si le retrait est possible. */
export function withdrawalLockedUntil(wallet, today = localISODate()) {
  if (walletUsage(wallet) !== 'blocked') return null;
  return wallet.unlockDate && wallet.unlockDate > today ? wallet.unlockDate : null;
}

/** Solde de chaque portefeuille (dans SA propre devise), jusqu'à une date optionnelle incluse. */
export function walletBalancesAsOf(wallets, transactions, cutoffDate = null) {
  const balances = new Map(wallets.map((w) => [w.id, w.initialBalance || 0]));
  for (const t of transactions) {
    if (cutoffDate && t.date > cutoffDate) continue;
    const amt = Number(t.amount) || 0;
    if (t.type === 'income') {
      balances.set(t.walletId, (balances.get(t.walletId) || 0) + amt);
    } else if (t.type === 'expense') {
      balances.set(t.walletId, (balances.get(t.walletId) || 0) - amt);
    } else if (t.type === 'transfer') {
      balances.set(t.walletId, (balances.get(t.walletId) || 0) - amt);
      balances.set(t.targetWalletId, (balances.get(t.targetWalletId) || 0) + amt);
    }
  }
  return balances;
}

export async function getAllWalletBalances() {
  const { wallets, transactions } = await ctx();
  const balances = walletBalancesAsOf(wallets, transactions);
  return wallets.map((w) => ({ ...w, balance: balances.get(w.id) || 0 }));
}

export async function getWalletBalance(walletId) {
  const { wallets, transactions } = await ctx();
  return walletBalancesAsOf(wallets, transactions).get(walletId) || 0;
}

/** Valeur d'un investissement à une date donnée (dernière valorisation connue avant/à cette date,
    plus les apports nets saisis depuis). Si aucune valorisation n'a encore été saisie (avant cutoffDate), on reconstruit le capital NET
    investi à cette date (capital initial + apports - retraits, voir computeMetrics()/investments.js
    pour le même calcul en "temps réel") au lieu de renvoyer seulement le capital initial figé — sans
    ça, un apport ultérieur sans valorisation immédiate après (cas normal : on ne revalorise pas à
    chaque apport) faisait paraître l'investissement en perte immédiate (valeur < capital investi) et
    cet apport "disparaissait" du patrimoine net : l'argent sort bien du portefeuille (transaction
    liée) mais n'était compté nulle part ailleurs tant qu'aucune valorisation n'était saisie à la
    main. */
export function investmentValueAsOf(investment, entries, cutoffDate) {
  // Investissement annulé : plus rien à compter à partir de la date d'annulation (aucun remboursement
  // n'est inscrit dans un portefeuille, voir investments.js) — avant cette date, il comptait normalement.
  if (investment.status === 'cancelled' && (!cutoffDate || !investment.cancelledAt || investment.cancelledAt <= cutoffDate)) return 0;
  const relevant = entries
    .filter((e) => e.investmentId === investment.id && e.type === 'valuation' && (!cutoffDate || e.date <= cutoffDate))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const lastValuation = relevant[0] || null;
  if (!lastValuation && cutoffDate && investment.createdAt && investment.createdAt.slice(0, 10) > cutoffDate) return 0;
  // Une valorisation est la valeur totale À SA DATE : les apports/retraits datés strictement APRÈS
  // elle s'y ajoutent (ou s'en retranchent), sinon un apport — surtout un gros, financé par un
  // prêt — ferait baisser le patrimoine net du montant apporté jusqu'à la prochaine revalorisation.
  const own = entries.filter((e) => e.investmentId === investment.id
    && (!cutoffDate || e.date <= cutoffDate)
    && (!lastValuation || e.date > lastValuation.date));
  const contributions = own.filter((e) => e.type === 'contribution').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const withdrawals = own.filter((e) => e.type === 'withdrawal').reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const base = lastValuation ? lastValuation.amount : (investment.capitalInvested || 0);
  return base + contributions - withdrawals;
}

/** Montant restant dû d'une dette/créance à une date donnée. */
function debtRemainingAsOf(debt, payments, cutoffDate) {
  if (cutoffDate && debt.startDate && debt.startDate > cutoffDate) return 0;
  // Dette/créance annulée (remise de dette, sans remboursement) : le restant dû tombe à 0 à partir de la
  // date d'annulation, sans qu'aucune transaction de portefeuille n'existe pour cela.
  if (debt.status === 'cancelled' && (!cutoffDate || !debt.cancelledAt || debt.cancelledAt <= cutoffDate)) return 0;
  const paid = payments
    .filter((p) => p.debtId === debt.id && (!cutoffDate || p.date <= cutoffDate))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  return Math.max(0, (debt.principal || 0) - paid);
}

/** Position nette dans les tontines à une date : cotisations versées − pots reçus (en devise de base).
    Positive avant d'avoir reçu son pot (c'est de l'épargne récupérable), négative après (il reste des
    cotisations à verser) — l'argent sorti du portefeuille ne « disparaît » donc pas du patrimoine. Lit
    uniquement les transactions (tontineId / tontineMovement), aucun autre store. */
export function tontinePositionAsOf(transactions, wallets, cutoffDate, rates, baseCurrency) {
  const currencyOf = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  let total = 0;
  for (const t of transactions) {
    if (!t.tontineId || (cutoffDate && t.date > cutoffDate)) continue;
    const amt = toBase(Number(t.amount) || 0, currencyOf[t.walletId] || baseCurrency, rates, baseCurrency);
    if (t.tontineMovement === 'pot') total -= amt;
    else total += amt; // cotisation
  }
  return total;
}

/** Cœur pur (aucun accès DB) de computeNetWorth, séparé pour que computeNetWorthHistory puisse
    l'appeler en boucle sur des données déjà chargées une seule fois — voir cette fonction pour le
    contexte (elle rechargeait ctx() à chaque mois, ~7x plus lent sur un historique de plusieurs
    années, mesuré à ~1,5s pour 6 mois avec 14 600 transactions contre ~200ms une fois corrigé). */
function netWorthAt(cutoffDate, { wallets, transactions, investments, investmentEntries, debts, debtPayments, rates, rateHistory, baseCurrency }) {
  const balances = walletBalancesAsOf(wallets, transactions, cutoffDate);
  const ratesForDate = ratesAsOf(cutoffDate, rates, rateHistory);

  let total = 0;
  for (const w of wallets) {
    if (cutoffDate && w.createdAt && w.createdAt.slice(0, 10) > cutoffDate) continue;
    total += toBase(balances.get(w.id) || 0, w.currency, ratesForDate, baseCurrency);
  }
  for (const inv of investments) {
    total += toBase(investmentValueAsOf(inv, investmentEntries, cutoffDate), inv.currency, ratesForDate, baseCurrency);
  }
  for (const d of debts) {
    const remaining = debtRemainingAsOf(d, debtPayments, cutoffDate);
    total += (d.type === 'receivable' ? 1 : -1) * toBase(remaining, d.currency, ratesForDate, baseCurrency);
  }
  total += tontinePositionAsOf(transactions, wallets, cutoffDate, ratesForDate, baseCurrency);
  return { total, currency: baseCurrency };
}

export async function computeNetWorth(cutoffDate = null) {
  return netWorthAt(cutoffDate, await ctx());
}

/** Répartition du patrimoine net (liquidités courantes / épargne / bloqué / investissements /
    créances / dettes) à une date donnée, pour le donut de composition. Le patrimoine net compte
    TOUS les portefeuilles, quel que soit leur rôle : épargner ou bloquer de l'argent ne le fait pas
    sortir de votre patrimoine, seulement de ce que vous pouvez dépenser au quotidien. */
export async function computeNetWorthComposition(cutoffDate = null) {
  const { wallets, transactions, investments, investmentEntries, debts, debtPayments, rates, rateHistory, baseCurrency } = await ctx();
  const balances = walletBalancesAsOf(wallets, transactions, cutoffDate);
  const ratesForDate = ratesAsOf(cutoffDate, rates, rateHistory);

  let liquid = 0, savings = 0, blocked = 0, invested = 0, receivables = 0, debtTotal = 0;
  for (const w of wallets) {
    if (cutoffDate && w.createdAt && w.createdAt.slice(0, 10) > cutoffDate) continue;
    const amount = toBase(balances.get(w.id) || 0, w.currency, ratesForDate, baseCurrency);
    const usage = walletUsage(w);
    if (usage === 'savings') savings += amount;
    else if (usage === 'blocked') blocked += amount;
    else liquid += amount;
  }
  for (const inv of investments) {
    invested += toBase(investmentValueAsOf(inv, investmentEntries, cutoffDate), inv.currency, ratesForDate, baseCurrency);
  }
  for (const d of debts) {
    const remaining = toBase(debtRemainingAsOf(d, debtPayments, cutoffDate), d.currency, ratesForDate, baseCurrency);
    if (d.type === 'receivable') receivables += remaining;
    else debtTotal += remaining;
  }
  // La tontine est de l'épargne collective : sa position nette s'ajoute à l'épargne.
  savings += tontinePositionAsOf(transactions, wallets, cutoffDate, ratesForDate, baseCurrency);
  return { liquid, savings, blocked, invested, receivables, debts: debtTotal, currency: baseCurrency };
}

/** Historique du patrimoine net sur N mois (fin de chaque mois), pour le graphique de tendance.
    ctx() n'est chargé qu'une fois (voir netWorthAt) — même principe que computeInvestmentValueHistory/
    computeDebtHistory ci-dessous, qui elles n'avaient jamais eu ce problème. */
export async function computeNetWorthHistory(months = 6) {
  const data = await ctx();
  const points = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 0); // dernier jour du mois
    const cutoff = localISODate(d);
    const { total } = netWorthAt(cutoff, data);
    points.push({ label: new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit' }).format(d), value: Math.round(total * 100) / 100 });
  }
  return points;
}

/** Historique du patrimoine net, fin de chaque mois de l'ANNÉE donnée (Jan-Déc) — variante
    calendaire de computeNetWorthHistory() (qui est glissante sur les N derniers mois), pour
    partager le même sélecteur d'année que les autres courbes de la page Rapports. Pour l'année en
    cours, les mois futurs affichent simplement le patrimoine actuel (aucune transaction future ne
    peut exister) plutôt qu'une valeur artificiellement nulle. */
export async function computeNetWorthHistoryForYear(year) {
  const data = await ctx();
  const points = [];
  for (let m = 0; m < 12; m++) {
    const d = new Date(year, m + 1, 0); // dernier jour du mois
    const cutoff = localISODate(d);
    const { total } = netWorthAt(cutoff, data);
    points.push({ label: new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit' }).format(d), value: Math.round(total * 100) / 100 });
  }
  return points;
}

/** Totaux des mouvements d'historique d'investissement (apports/dividendes/retraits) sur une plage
    de dates [startDate, endDate] incluses, convertis en devise de base — pour la section
    "Investissements" du bilan PDF (reports.js). */
export async function computeInvestmentEntryTotals(startDate, endDate) {
  const { investments, investmentEntries, rates, baseCurrency } = await ctx();
  const currencyByInvestment = Object.fromEntries(investments.map((i) => [i.id, i.currency]));
  const totals = { contribution: 0, dividend: 0, withdrawal: 0 };
  for (const e of investmentEntries) {
    if (!e.date || e.date < startDate || e.date > endDate) continue;
    if (!(e.type in totals)) continue;
    const cur = currencyByInvestment[e.investmentId];
    // Entrée orpheline (investissement supprimé entre-temps) : ignorée, comme
    // exportInvestmentEntriesCsv() (backup.js) — sans ça, le montant brut (potentiellement dans une
    // devise étrangère) serait compté comme s'il était déjà en devise de base, faussant le total.
    if (!cur) continue;
    totals[e.type] += toBase(Number(e.amount) || 0, cur, rates, baseCurrency);
  }
  return { ...totals, currency: baseCurrency };
}

/** Historique de la valeur totale des investissements sur N mois (fin de chaque mois). */
export async function computeInvestmentValueHistory(months = 6) {
  const { investments, investmentEntries, rates, rateHistory, baseCurrency } = await ctx();
  const points = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const cutoff = localISODate(d);
    const ratesForDate = ratesAsOf(cutoff, rates, rateHistory);
    let total = 0;
    for (const inv of investments) {
      if (inv.createdAt && inv.createdAt.slice(0, 10) > cutoff) continue;
      total += toBase(investmentValueAsOf(inv, investmentEntries, cutoff), inv.currency, ratesForDate, baseCurrency);
    }
    points.push({ label: new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit' }).format(d), value: Math.round(total * 100) / 100 });
  }
  return points;
}

/** Historique du total des dettes restant dues sur N mois (fin de chaque mois) — tendance de désendettement. */
export async function computeDebtHistory(months = 6) {
  const { debts, debtPayments, rates, rateHistory, baseCurrency } = await ctx();
  const activeDebts = debts.filter((d) => d.type === 'debt');
  const points = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    const cutoff = localISODate(d);
    const ratesForDate = ratesAsOf(cutoff, rates, rateHistory);
    let total = 0;
    for (const debt of activeDebts) {
      total += toBase(debtRemainingAsOf(debt, debtPayments, cutoff), debt.currency, ratesForDate, baseCurrency);
    }
    points.push({ label: new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit' }).format(d), value: Math.round(total * 100) / 100 });
  }
  return points;
}

/** Résumé du mois : entrées, sorties, épargne nette, cash-flow (converti en devise de base). */
export async function computeMonthSummary(monthKey = currentMonthKey()) {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  let income = 0, expenses = 0;
  for (const t of transactions) {
    if (!t.date || !t.date.startsWith(monthKey)) continue;
    if (t.debtId) continue; // mouvement de dette/créance : pas une dépense/recette discrétionnaire
    // Achat/apport/retrait d'investissement exclus (transferts de capital) — mais un dividende
    // reste un vrai revenu, donc PAS exclu du côté "income" (voir isInvestmentMovementExcluded).
    if (isInvestmentMovementExcluded(t)) continue;
    const cur = walletCurrency[t.walletId] || baseCurrency;
    const amt = toBase(Number(t.amount) || 0, cur, rates, baseCurrency);
    if (t.type === 'income') income += amt;
    else if (t.type === 'expense') expenses += amt;
  }
  const netSavings = income - expenses;
  return { income, expenses, netSavings, cashFlow: netSavings, currency: baseCurrency };
}

/** Étiquettes techniques posées par l'appli elle-même (import SMS) : sans intérêt pour un bilan. */
const TECHNICAL_TAGS = new Set(['sms']);

/** Bilan par étiquette pour un mois : entrées, sorties et résultat (entrées − sorties), en devise de
    base. Sert au suivi « pro / perso » : étiqueter « pro » ses opérations d'activité donne son
    résultat du mois sans séparer les portefeuilles. Une transaction à plusieurs étiquettes compte
    dans chacune (ces totaux ne s'additionnent donc pas). Mêmes exclusions que computeMonthSummary. */
export async function computeTagSummary(monthKey = currentMonthKey()) {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const byTag = new Map();
  for (const t of transactions) {
    if (!t.date || !t.date.startsWith(monthKey) || t.debtId || isInvestmentMovementExcluded(t)) continue;
    if (t.type !== 'income' && t.type !== 'expense') continue;
    const amt = toBase(Number(t.amount) || 0, walletCurrency[t.walletId] || baseCurrency, rates, baseCurrency);
    for (const tag of new Set((t.tags || []).filter((x) => !TECHNICAL_TAGS.has(x)))) {
      const row = byTag.get(tag) || { tag, income: 0, expenses: 0, count: 0 };
      if (t.type === 'income') row.income += amt; else row.expenses += amt;
      row.count++;
      byTag.set(tag, row);
    }
  }
  const rows = [...byTag.values()].map((r) => ({ ...r, result: r.income - r.expenses }));
  rows.sort((a, b) => (b.income + b.expenses) - (a.income + a.expenses));
  return { rows, currency: baseCurrency };
}

/** Entrées/sorties sur une plage de dates [startDate, endDate] incluses (YYYY-MM-DD), pour les
    résumés qui ne s'alignent pas sur un mois calendaire (ex : résumé hebdomadaire). */
export async function computeSpendingBetween(startDate, endDate) {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  let income = 0, expenses = 0;
  for (const t of transactions) {
    if (!t.date || t.date < startDate || t.date > endDate) continue;
    if (t.debtId) continue;
    if (isInvestmentMovementExcluded(t)) continue;
    const amt = toBase(Number(t.amount) || 0, walletCurrency[t.walletId] || baseCurrency, rates, baseCurrency);
    if (t.type === 'income') income += amt;
    else if (t.type === 'expense') expenses += amt;
  }
  return { income, expenses, netSavings: income - expenses, currency: baseCurrency };
}

/** Dépenses du mois groupées par catégorie (top 7 + "Autres"). Chaque ligne porte la couleur
    personnalisée de la catégorie (color, si définie) pour que le graphique et la liste utilisent
    la même teinte — null pour "Sans catégorie"/"Autres" (couleur de repli côté graphique). */
export async function computeExpensesByCategory(monthKey = currentMonthKey()) {
  const { wallets, transactions, categories, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const catById = Object.fromEntries(categories.map((c) => [c.id, c]));
  const totals = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || !t.date || !t.date.startsWith(monthKey)) continue;
    if (t.debtId) continue;
    if (isInvestmentMovementExcluded(t)) continue;
    const cur = walletCurrency[t.walletId] || baseCurrency;
    const amt = toBase(Number(t.amount) || 0, cur, rates, baseCurrency);
    const cat = catById[t.categoryId];
    const key = cat?.id || 'none';
    const existing = totals.get(key);
    if (existing) existing.value += amt;
    else totals.set(key, { label: cat?.name || tr('Sans catégorie'), value: amt, color: cat?.color || null });
  }
  const sorted = [...totals.values()].sort((a, b) => b.value - a.value);
  if (sorted.length <= 8) return sorted;
  const top = sorted.slice(0, 7);
  const autres = sorted.slice(7).reduce((s, r) => s + r.value, 0);
  top.push({ label: tr('Autres'), value: autres, color: null });
  return top;
}

/** Historique mensuel (12 mois d'une année donnée) du total des transactions d'un type
    (income/expense), optionnellement filtré à une seule catégorie (categoryId null -> toutes
    catégories confondues). Alimente les courbes de variation mensuelle du tableau de bord,
    filtrables par année et par catégorie. */
export async function computeMonthlyTypeHistory(year, type = 'expense', categoryId = null) {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const totals = new Array(12).fill(0);
  for (const t of transactions) {
    if (t.type !== type || !t.date || !t.date.startsWith(String(year))) continue;
    if (t.debtId) continue;
    if (isInvestmentMovementExcluded(t)) continue;
    if (categoryId && t.categoryId !== categoryId) continue;
    const cur = walletCurrency[t.walletId] || baseCurrency;
    const amt = toBase(Number(t.amount) || 0, cur, rates, baseCurrency);
    const monthIdx = parseInt(t.date.slice(5, 7), 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) totals[monthIdx] += amt;
  }
  const points = totals.map((value, i) => ({
    label: new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit' }).format(new Date(year, i, 1)),
    value: Math.round(value * 100) / 100,
  }));
  return { points, currency: baseCurrency };
}

/** Catégories d'un type donné, triées par nom — pour peupler le filtre des courbes de variation. */
export async function getCategoriesByType(type) {
  const { categories } = await ctx();
  return categories.filter((c) => c.type === type).sort((a, b) => a.name.localeCompare(b.name));
}

/** Épargne nette mensuelle (revenus - dépenses) sur une année, avec le taux d'épargne (%) associé
    à chaque mois (0% si aucun revenu ce mois-là, plutôt qu'une division par zéro). */
export async function computeMonthlyNetSavingsHistory(year) {
  const [{ points: incomePoints, currency }, { points: expensePoints }] = await Promise.all([
    computeMonthlyTypeHistory(year, 'income', null),
    computeMonthlyTypeHistory(year, 'expense', null),
  ]);
  const points = incomePoints.map((p, i) => {
    const income = p.value;
    const expenses = expensePoints[i].value;
    const net = Math.round((income - expenses) * 100) / 100;
    const rate = income > 0 ? Math.round((net / income) * 1000) / 10 : 0;
    return { label: p.label, net, rate };
  });
  return { points, currency };
}

/** Historique mensuel (12 mois d'une année) budget vs réel — total sur les catégories budgétées ce
    mois-là, ou une seule catégorie si categoryId est fourni. Complément annuel à
    computeBudgetVsActual() qui ne couvre qu'un seul mois à la fois. Même convention que
    computeMonthlyBudgetSummary() pour "toutes catégories" : seules les catégories ayant un budget
    posé ce mois-là entrent dans le total (comparer à des dépenses hors budget n'aurait pas de sens). */
export async function computeMonthlyBudgetVsActualHistory(year, categoryId = null) {
  const { wallets, transactions, budgets, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const budgetTotals = new Array(12).fill(0);
  const actualTotals = new Array(12).fill(0);

  for (let m = 0; m < 12; m++) {
    const monthKey = `${year}-${String(m + 1).padStart(2, '0')}`;
    const monthBudgets = budgets.filter((b) => b.month === monthKey && (!categoryId || b.categoryId === categoryId));
    budgetTotals[m] = monthBudgets.reduce((s, b) => s + (b.limit || 0), 0);
    const budgetedCategoryIds = new Set(monthBudgets.map((b) => b.categoryId));
    for (const t of transactions) {
      if (t.type !== 'expense' || !t.date || !t.date.startsWith(monthKey)) continue;
      if (t.debtId) continue;
      if (isInvestmentMovementExcluded(t)) continue;
      if (categoryId) { if (t.categoryId !== categoryId) continue; }
      else if (!budgetedCategoryIds.has(t.categoryId)) continue;
      const cur = walletCurrency[t.walletId] || baseCurrency;
      actualTotals[m] += toBase(Number(t.amount) || 0, cur, rates, baseCurrency);
    }
  }

  const points = Array.from({ length: 12 }, (_, i) => ({
    label: new Intl.DateTimeFormat(intlLocale(), { month: 'short', year: '2-digit' }).format(new Date(year, i, 1)),
    budget: Math.round(budgetTotals[i] * 100) / 100,
    actual: Math.round(actualTotals[i] * 100) / 100,
  }));
  return { points, currency: baseCurrency };
}

/** Budget vs réel du mois, par catégorie budgétée. */
export async function computeBudgetVsActual(monthKey = currentMonthKey()) {
  const { wallets, transactions, categories, budgets, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const monthBudgets = budgets.filter((b) => b.month === monthKey);

  const actualByCategory = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || !t.date || !t.date.startsWith(monthKey)) continue;
    if (t.debtId) continue;
    if (isInvestmentMovementExcluded(t)) continue;
    const cur = walletCurrency[t.walletId] || baseCurrency;
    const amt = toBase(Number(t.amount) || 0, cur, rates, baseCurrency);
    actualByCategory.set(t.categoryId, (actualByCategory.get(t.categoryId) || 0) + amt);
  }

  return monthBudgets.map((b) => ({
    categoryId: b.categoryId,
    label: catName[b.categoryId] || tr('Sans catégorie'),
    budget: b.limit,
    actual: actualByCategory.get(b.categoryId) || 0,
  }));
}

/** Budget mensuel total : somme des plafonds attribués à chaque catégorie ce mois-ci,
    dépensé sur ces catégories budgétées, et ce qu'il reste à dépenser. */
export async function computeMonthlyBudgetSummary(monthKey = currentMonthKey()) {
  const rows = await computeBudgetVsActual(monthKey);
  const { baseCurrency } = await ctx();
  const totalBudget = rows.reduce((sum, r) => sum + (r.budget || 0), 0);
  const totalSpent = rows.reduce((sum, r) => sum + (r.actual || 0), 0);
  return { totalBudget, totalSpent, remaining: totalBudget - totalSpent, currency: baseCurrency };
}

/* ---------- Suggestions de budget (d'après les habitudes de dépense) ---------- */
const BUDGET_SUGGESTION_MONTHS = 6;
const BUDGET_SUGGESTION_HALF_LIFE = 2; // mois : une dépense plus ancienne de 2 mois pèse moitié moins
const BUDGET_SUGGESTION_MARGIN = 1.05;

function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Arrondit à 2 chiffres significatifs (17 340 → 17 000 ; 8 230 → 8 200 ; 43,7 → 44) : un budget
    "propre" à saisir et à lire, sans fausse précision. `up` arrondit au-dessus (plancher fixe). */
function roundTwoSignificant(value, up = false) {
  if (!(value > 0)) return 0;
  const unit = Math.pow(10, Math.floor(Math.log10(value)) - 1);
  const q = value / unit;
  return Math.round((up ? Math.ceil(q - 1e-9) : Math.round(q)) * unit * 100) / 100;
}

/** Cœur pur (testable sans base) : montants mensuels d'UNE catégorie, du plus ancien au plus récent
    (uniquement des mois réellement utilisables), plus un plancher fixe éventuel (récurrences
    actives de cette catégorie, en équivalent mensuel). Renvoie null s'il n'y a rien à suggérer.
    - Moyenne pondérée à décroissance exponentielle : les mois récents comptent davantage, donc la
      suggestion suit les habitudes qui évoluent.
    - Changement de régime : si les 2 derniers mois sont TOUS DEUX nettement au-dessus (ou en
      dessous) de la moyenne antérieure, on s'aligne directement sur eux au lieu d'attendre que la
      pondération rattrape — sinon un loyer qui monte resterait sous-estimé pendant des mois.
    - Mois exceptionnel isolé (un seul mois > 2× la médiane) : remplacé par la médiane, pour qu'une
      grosse facture ponctuelle ne gonfle pas le budget des mois suivants (ni ne fausse la flèche de
      tendance). Deux mois élevés = nouvelle habitude, jamais neutralisée. */
export function suggestBudgetFromHistory(amounts, floor = 0) {
  const n = amounts.length;
  if (n < 2) return null;
  const nonZero = amounts.filter((a) => a > 0);
  if (!nonZero.length && !(floor > 0)) return null;
  const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

  // Plafonnement d'un pic isolé AVANT toute autre analyse : sinon il fausserait aussi la détection
  // de changement de régime et la flèche de tendance (un pic ancien ferait croire à une baisse).
  let adj = amounts;
  if (nonZero.length >= 3) {
    const med = medianOf(nonZero);
    if (nonZero.filter((a) => a > 2 * med).length === 1) adj = amounts.map((a) => (a > 2 * med ? med : a));
  }

  const last2 = adj.slice(-2);
  const olderMean = mean(adj.slice(0, -2));
  const shiftedUp = n >= 4 && Math.min(...last2) > olderMean * 1.2;
  const shiftedDown = n >= 4 && olderMean > 0 && Math.max(...last2) < olderMean * 0.8;

  let base;
  if (shiftedUp || shiftedDown) {
    base = mean(last2);
  } else {
    let weightedSum = 0;
    let weightTotal = 0;
    adj.forEach((a, i) => {
      const weight = Math.pow(0.5, (n - 1 - i) / BUDGET_SUGGESTION_HALF_LIFE);
      weightedSum += a * weight;
      weightTotal += weight;
    });
    base = weightedSum / weightTotal;
  }

  const irregular = nonZero.length / n < 0.5;
  // Une flèche de tendance n'a de sens que pour une dépense régulière.
  let trend = 'flat';
  if (n >= 4 && !irregular) {
    const recent = mean(last2);
    if (olderMean > 0 ? recent / olderMean > 1.15 : recent > 0) trend = 'up';
    else if (olderMean > 0 && recent / olderMean < 0.85) trend = 'down';
  }

  let suggested = roundTwoSignificant(base * BUDGET_SUGGESTION_MARGIN);
  const fixedFloor = floor > 0 ? roundTwoSignificant(floor, true) : 0;
  if (fixedFloor > suggested) suggested = fixedFloor;
  if (!(suggested > 0)) return null;
  return {
    suggested,
    avg3: mean(amounts.slice(-3)),
    trend,
    monthsWithSpend: nonZero.length,
    monthsUsed: n,
    irregular: !fixedFloor && irregular,
    hasFixedPart: fixedFloor > 0,
  };
}

/** Propose un budget pour chaque catégorie de dépense d'après les 6 derniers mois COMPLETS avant
    `monthKey` (le mois en cours n'est jamais compté : il est partiel). Mêmes exclusions que tous les
    autres agrégats (mouvements de dette et d'investissement). Les mois antérieurs à la toute
    première transaction sont ignorés (ce ne sont pas des mois "à 0 dépense" mais des mois sans
    historique), et le premier mois d'utilisation aussi quand il reste assez d'autres mois (souvent
    partiel). Aucun état mémorisé : tout est recalculé à chaque appel, donc la suggestion suit
    automatiquement l'évolution des habitudes. */
export async function computeBudgetSuggestions(monthKey = currentMonthKey()) {
  const { wallets, transactions, categories, budgets, rates, baseCurrency } = await ctx();
  const recurring = await dbGetAll(STORES.RECURRING);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));

  let firstMonth = null;
  for (const t of transactions) {
    if (!t.date) continue;
    const m = t.date.slice(0, 7);
    if (!firstMonth || m < firstMonth) firstMonth = m;
  }
  let months = [];
  for (let i = BUDGET_SUGGESTION_MONTHS; i >= 1; i--) months.push(monthKeyOffset(monthKey, -i));
  months = months.filter((m) => firstMonth && m >= firstMonth);
  if (months.length >= 4 && months[0] === firstMonth) months = months.slice(1);

  const base = {
    currency: baseCurrency,
    monthsUsed: months.length,
    unconfirmedRates: rates.filter((r) => r.confirmed === false).map((r) => r.code),
  };
  if (months.length < 2) return { ...base, insufficient: true, rows: [], averageIncome: 0 };

  const monthSet = new Set(months);
  const spend = new Map();
  const incomeByMonth = new Map(months.map((m) => [m, 0]));
  for (const t of transactions) {
    const m = t.date?.slice(0, 7);
    if (!m || !monthSet.has(m)) continue;
    if (t.debtId || isInvestmentMovementExcluded(t)) continue;
    const amt = toBase(Number(t.amount) || 0, walletCurrency[t.walletId] || baseCurrency, rates, baseCurrency);
    if (t.type === 'expense') {
      const key = `${m}|${t.categoryId}`;
      spend.set(key, (spend.get(key) || 0) + amt);
    } else if (t.type === 'income') {
      incomeByMonth.set(m, incomeByMonth.get(m) + amt);
    }
  }

  // Plancher fixe : récurrences actives de dépense (hors apports d'investissement, exclus des
  // budgets comme partout ailleurs) en équivalent mensuel. Les récurrences annuelles sont ignorées :
  // ce n'est pas un coût mensuel (elles ont leur propre onglet "Budgets annuels").
  const floors = new Map();
  for (const r of recurring) {
    if (!r.active || r.type !== 'expense' || r.investmentId || !r.categoryId) continue;
    const factor = r.frequency === 'monthly' ? 1 : r.frequency === 'weekly' ? 52 / 12 : 0;
    if (!factor) continue;
    const amt = toBase(Number(r.amount) || 0, walletCurrency[r.walletId] || baseCurrency, rates, baseCurrency) * factor;
    floors.set(r.categoryId, (floors.get(r.categoryId) || 0) + amt);
  }

  const currentLimits = new Map(budgets.filter((b) => b.month === monthKey).map((b) => [b.categoryId, b.limit || 0]));
  const rows = [];
  for (const c of categories) {
    if (c.type !== 'expense') continue;
    const amounts = months.map((m) => spend.get(`${m}|${c.id}`) || 0);
    const s = suggestBudgetFromHistory(amounts, floors.get(c.id) || 0);
    if (!s) continue;
    rows.push({ categoryId: c.id, label: c.name, parentId: c.parentId || null, currentLimit: currentLimits.get(c.id) || 0, ...s });
  }
  rows.sort((a, b) => b.suggested - a.suggested);
  const averageIncome = [...incomeByMonth.values()].reduce((s, v) => s + v, 0) / months.length;
  return { ...base, insufficient: false, rows, averageIncome };
}

export async function getExchangeRates() {
  const { rates, baseCurrency } = await ctx();
  return { rates, baseCurrency };
}

/** Devises dont le taux n'a jamais été confirmé par l'utilisateur (créé à 1:1 par défaut lors
    du premier portefeuille/investissement/dette dans cette devise). Tant qu'il reste à 1:1 sans
    confirmation, le patrimoine net et tous les totaux convertis dans cette devise sont trompeurs. */
export async function getUnconfirmedRates() {
  const { rates } = await ctx();
  return rates.filter((r) => r.confirmed === false);
}

/** Somme des soldes de portefeuilles actifs ACCESSIBLES (courants + épargne), hors investissements/
    dettes. Les portefeuilles bloqués sont exclus : on ne peut pas y toucher avant leur date de
    déblocage, donc ce n'est ni un fonds d'urgence ni un budget d'achat. Sert aux outils (fonds
    d'urgence, impact d'un achat) — PAS au « reste à vivre », qui ne compte que les portefeuilles
    courants (voir computeEndOfMonthForecast). */
export async function computeLiquidBalance(cutoffDate = null) {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const balances = walletBalancesAsOf(wallets, transactions, cutoffDate);
  let total = 0;
  for (const w of wallets) {
    if (w.archived || walletUsage(w) === 'blocked') continue;
    total += toBase(balances.get(w.id) || 0, w.currency, rates, baseCurrency);
  }
  return { total, currency: baseCurrency };
}

/** Affectation de l'argent d'un portefeuille d'épargne/bloqué entre PLUSIEURS objectifs (une voiture ET
    une maison dans le même compte d'épargne). Un objectif a, dans chaque portefeuille lié, une part :
        part = goal.allocations[walletId] (montant de départ saisi)
             + versements étiquetés de CET objectif (virements portant savingsGoalId, vers ce portefeuille)
             − retraits étiquetés de cet objectif (depuis ce portefeuille).
    Ce qui reste du solde du portefeuille, non affecté à un objectif actif, est « libre » (solde initial
    non affecté, intérêts, versements faits directement depuis la fiche du portefeuille). Un objectif
    archivé libère sa part. L'argent est toujours celui du portefeuille : rien n'est compté deux fois
    dans le patrimoine.
    Renvoie { goals: Map(goalId → { linked, saved, wallets: [{ id, name, usage, unlockDate, allocated }] }),
              wallets: Map(walletId → { balance, allocated, free, goals: [{ goalId, name, amount }] }) }.
    Un objectif sans portefeuille lié (ancien suivi manuel) garde linked: false et son ancien montant
    saisi à la main (goal.currentAmount), jamais de l'argent réel du ledger. */
export async function computeSavingsAllocations() {
  const { wallets, transactions } = await ctx();
  const goals = await dbGetAll(STORES.SAVINGS_GOALS);
  const balances = walletBalancesAsOf(wallets, transactions);
  const walletById = new Map(wallets.map((w) => [w.id, w]));
  const goalById = new Map(goals.map((g) => [g.id, g]));

  // alloc.get(goalId).get(walletId) = part de l'objectif dans ce portefeuille
  const alloc = new Map();
  for (const goal of goals) {
    const perWallet = new Map();
    for (const id of goal.walletIds || []) perWallet.set(id, Number((goal.allocations || {})[id]) || 0);
    alloc.set(goal.id, perWallet);
  }
  for (const t of transactions) {
    if (!t.savingsGoalId || t.type !== 'transfer') continue;
    const goal = goalById.get(t.savingsGoalId);
    if (!goal) continue;
    const perWallet = alloc.get(goal.id);
    const amt = Number(t.amount) || 0;
    if (perWallet.has(t.targetWalletId)) perWallet.set(t.targetWalletId, perWallet.get(t.targetWalletId) + amt);
    else if (perWallet.has(t.walletId)) perWallet.set(t.walletId, perWallet.get(t.walletId) - amt);
  }

  const goalsResult = new Map();
  const walletsResult = new Map();
  const ensureWallet = (id) => {
    if (!walletsResult.has(id)) walletsResult.set(id, { balance: balances.get(id) || 0, allocated: 0, free: 0, goals: [] });
    return walletsResult.get(id);
  };
  for (const goal of goals) {
    const perWallet = alloc.get(goal.id);
    const detail = [...perWallet.entries()].filter(([id]) => walletById.has(id)).map(([id, amount]) => {
      const w = walletById.get(id);
      return { id, name: w.name, usage: walletUsage(w), unlockDate: w.unlockDate || null, allocated: Math.max(0, amount) };
    });
    const linked = (goal.walletIds || []).length > 0;
    goalsResult.set(goal.id, { linked, saved: linked ? detail.reduce((s, d) => s + d.allocated, 0) : (goal.currentAmount || 0), wallets: detail });
    if (!goal.archived) {
      for (const d of detail) {
        const w = ensureWallet(d.id);
        w.allocated += d.allocated;
        w.goals.push({ goalId: goal.id, name: goal.name, amount: d.allocated });
      }
    }
  }
  for (const w of wallets) {
    if (walletUsage(w) === 'current') continue;
    const entry = ensureWallet(w.id);
    entry.free = entry.balance - entry.allocated;
  }
  for (const entry of walletsResult.values()) entry.free = entry.balance - entry.allocated;
  return { goals: goalsResult, wallets: walletsResult };
}

/** Dépenses/recettes réelles du mois pour CHAQUE catégorie d'un type donné (y compris à 0). */
export async function computeCategoryActuals(monthKey = currentMonthKey(), type = 'expense') {
  const { wallets, transactions, categories, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const cats = categories.filter((c) => c.type === type);
  const totals = new Map(cats.map((c) => [c.id, 0]));
  for (const t of transactions) {
    if (t.type !== type || !t.date || !t.date.startsWith(monthKey)) continue;
    if (t.debtId) continue;
    if (isInvestmentMovementExcluded(t)) continue;
    const cur = walletCurrency[t.walletId] || baseCurrency;
    const amt = toBase(Number(t.amount) || 0, cur, rates, baseCurrency);
    totals.set(t.categoryId, (totals.get(t.categoryId) || 0) + amt);
  }
  return cats.map((c) => ({ categoryId: c.id, label: c.name, parentId: c.parentId, actual: totals.get(c.id) || 0 }));
}

/** Dépenses/recettes réelles de l'ANNÉE pour CHAQUE catégorie d'un type donné (y compris à 0). */
export async function computeAnnualCategoryActuals(year, type = 'expense') {
  const { wallets, transactions, categories, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const cats = categories.filter((c) => c.type === type);
  const totals = new Map(cats.map((c) => [c.id, 0]));
  for (const t of transactions) {
    if (t.type !== type || !t.date || !t.date.startsWith(String(year))) continue;
    if (t.debtId) continue;
    if (isInvestmentMovementExcluded(t)) continue;
    const cur = walletCurrency[t.walletId] || baseCurrency;
    const amt = toBase(Number(t.amount) || 0, cur, rates, baseCurrency);
    totals.set(t.categoryId, (totals.get(t.categoryId) || 0) + amt);
  }
  return cats.map((c) => ({ categoryId: c.id, label: c.name, parentId: c.parentId, actual: totals.get(c.id) || 0 }));
}

/** Solde prévisionnel de fin de mois = liquidités actuelles + récurrences actives restant à échoir ce mois-ci. */
export async function computeEndOfMonthForecast() {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const recurring = await dbGetAll(STORES.RECURRING);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const balances = walletBalancesAsOf(wallets, transactions);

  // Seuls les portefeuilles COURANTS : l'argent mis de côté (épargne/bloqué) n'est pas à dépenser,
  // donc il ne doit ni gonfler le « reste à vivre » ni le solde prévisionnel de fin de mois.
  let current = 0;
  for (const w of wallets) {
    if (!isDailyWallet(w)) continue;
    current += toBase(balances.get(w.id) || 0, w.currency, rates, baseCurrency);
  }

  const today = new Date();
  const todayStr = localISODate(today);
  const endOfMonthStr = localISODate(new Date(today.getFullYear(), today.getMonth() + 1, 0));

  let projected = current;
  const upcoming = [];
  // TOUTES les occurrences restant à échoir ce mois-ci, pas seulement la prochaine : une récurrence
  // hebdomadaire tombe 4 à 5 fois dans un mois, la compter une seule fois faisait surestimer le
  // « reste à vivre » (même parcours que la prévision de trésorerie, forecast.js).
  for (const r of recurring) {
    if (!r.active || !r.nextDate) continue;
    const cur = walletCurrency[r.walletId] || baseCurrency;
    const amt = toBase(Number(r.amount) || 0, cur, rates, baseCurrency);
    const anchorDay = r.anchorDay ?? Number(r.nextDate.slice(8, 10));
    let date = r.nextDate;
    for (let guard = 0; date <= endOfMonthStr && guard < 60; guard++) {
      if (date >= todayStr) {
        projected += (r.type === 'income' ? 1 : -1) * amt;
        upcoming.push({ ...r, nextDate: date, amountBase: amt });
      }
      const next = advanceDate(date, r.frequency, anchorDay);
      if (next <= date) break;
      date = next;
    }
  }
  upcoming.sort((a, b) => a.nextDate.localeCompare(b.nextDate));
  return { current, projected, currency: baseCurrency, upcoming };
}

/** « Reste à vivre » : liquidités courantes − échéances de dépense à venir ce mois-ci − budgets encore
    disponibles. Pur (reçoit la prévision et les lignes budget/réel déjà calculées). Deux corrections par
    rapport à l'ancienne formule (liquidités − échéances − « reste du budget total ») :
    - une facture récurrente à venir est déjà DANS le budget de sa catégorie : on la retire du budget
      réservé de cette catégorie, sinon elle était déduite deux fois (loyer de 100 000 sur un budget
      « Logement » de 100 000 : 200 000 de moins au lieu de 100 000) ;
    - le dépassement d'une catégorie ne vient plus « compenser » le reste d'une autre (le reste réservé est
      la somme des restes positifs, catégorie par catégorie). */
export function computeSafeToSpend(forecast, budgetRows) {
  const billsByCategory = new Map();
  let upcomingBillsTotal = 0;
  for (const u of forecast.upcoming) {
    if (u.type !== 'expense') continue;
    upcomingBillsTotal += u.amountBase;
    if (u.categoryId) billsByCategory.set(u.categoryId, (billsByCategory.get(u.categoryId) || 0) + u.amountBase);
  }
  let reservedBudget = 0;
  for (const r of budgetRows) {
    const left = (r.budget || 0) - (r.actual || 0);
    reservedBudget += Math.max(0, left - (billsByCategory.get(r.categoryId) || 0));
  }
  return { safeToSpend: forecast.current - upcomingBillsTotal - reservedBudget, upcomingBillsTotal, reservedBudget };
}

/** Transactions jointes (portefeuille/catégorie), triées récentes d'abord, avec filtres optionnels. */
export async function getEnrichedTransactions({ limit = null, monthKey = null, walletId = null, categoryId = null, type = null } = {}) {
  const { wallets, transactions, categories } = await ctx();
  const walletById = Object.fromEntries(wallets.map((w) => [w.id, w]));
  const catById = Object.fromEntries(categories.map((c) => [c.id, c]));

  let rows = transactions.filter((t) => {
    if (monthKey && !(t.date || '').startsWith(monthKey)) return false;
    if (walletId && t.walletId !== walletId && t.targetWalletId !== walletId) return false;
    if (categoryId && t.categoryId !== categoryId) return false;
    if (type && t.type !== type) return false;
    return true;
  });

  rows.sort((a, b) => (a.date === b.date ? (b.createdAt || '').localeCompare(a.createdAt || '') : b.date.localeCompare(a.date)));
  if (limit) rows = rows.slice(0, limit);

  return rows.map((t) => ({
    ...t,
    wallet: walletById[t.walletId] || null,
    targetWallet: t.targetWalletId ? walletById[t.targetWalletId] || null : null,
    category: catById[t.categoryId] || null,
  }));
}

/** Report d'enveloppe : cumul (budget - dépensé) de tous les mois BUDGÉTÉS avant monthKey pour
    cette catégorie. Utilisé quand la catégorie a envelopeMode activé, pour que le solde non
    dépensé (ou le dépassement) d'un mois se reporte sur le suivant, façon YNAB. */
export async function computeEnvelopeCarryover(categoryId, monthKey) {
  const { wallets, transactions, budgets, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const priorBudgets = budgets.filter((b) => b.categoryId === categoryId && b.month < monthKey && !b.period);
  let carry = 0;
  for (const b of priorBudgets) {
    // debtId exclu, comme dans tous les autres agrégats mensuels de ce fichier (computeMonthSummary,
    // computeBudgetVsActual, computeCategoryActuals...) : un mouvement de dette/créance catégorisé
    // "Prêt"/"Créance" n'est pas une dépense discrétionnaire. Cet oubli faisait diverger le report
    // d'enveloppe (qui l'incluait) de l'"actual" réellement affiché à l'écran (qui l'exclut déjà).
    const actual = transactions
      .filter((t) => t.type === 'expense' && t.categoryId === categoryId && !t.debtId && !isInvestmentMovementExcluded(t) && (t.date || '').startsWith(b.month))
      .reduce((sum, t) => sum + toBase(Number(t.amount) || 0, walletCurrency[t.walletId] || baseCurrency, rates, baseCurrency), 0);
    carry += (b.limit || 0) - actual;
  }
  return carry;
}

// Préfixes exacts posés par generateDueRecurring() (budgets.js) sur chaque transaction qu'elle
// génère automatiquement — voir plus bas pourquoi il faut les retirer avant de comparer à
// recurringNames. Deux variantes (le texte passe par t(), voir i18n.js) : une transaction générée
// pendant que l'app était en anglais porte "Recurrence: {nom}", pas "Récurrence : {nom}" — les deux
// doivent être reconnues quelle que soit la langue active au moment de la lecture, une transaction
// existante ne se retraduit jamais rétroactivement.
const RECURRING_NOTE_PREFIXES = ['récurrence : ', 'recurrence: '];

/** Détecte les paiements récurrents non déclarés en Récurrences : même note + montant similaire
    apparaissant sur au moins 2 mois distincts. Exclut ce qui correspond déjà à une récurrence active. */
export async function detectRecurringCandidates() {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const recurring = await dbGetAll(STORES.RECURRING);
  const recurringNames = new Set(recurring.map((r) => (r.name || '').trim().toLowerCase()));
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));

  const groups = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || !t.note || !t.note.trim()) continue;
    const noteKey = t.note.trim().toLowerCase();
    // Les transactions générées automatiquement par une récurrence active portent la note
    // "Récurrence : {nom}" (budgets.js), pas juste "{nom}" — comparer noteKey tel quel à
    // recurringNames ne matchait donc JAMAIS ces transactions, et cette fonction re-proposait en
    // permanence les récurrences déjà déclarées comme si elles ne l'étaient pas.
    const matchedPrefix = RECURRING_NOTE_PREFIXES.find((p) => noteKey.startsWith(p));
    const strippedKey = matchedPrefix ? noteKey.slice(matchedPrefix.length) : noteKey;
    if (recurringNames.has(noteKey) || recurringNames.has(strippedKey)) continue;
    const amtBase = toBase(Number(t.amount) || 0, walletCurrency[t.walletId] || baseCurrency, rates, baseCurrency);
    const key = `${noteKey}::${Math.round(amtBase)}`;
    if (!groups.has(key)) groups.set(key, { note: t.note.trim(), amounts: [], months: new Set() });
    const g = groups.get(key);
    g.amounts.push(amtBase);
    g.months.add((t.date || '').slice(0, 7));
  }

  const candidates = [...groups.values()]
    .filter((g) => g.months.size >= 2)
    .map((g) => ({
      note: g.note,
      occurrences: g.months.size,
      avgAmount: g.amounts.reduce((a, b) => a + b, 0) / g.amounts.length,
    }))
    .sort((a, b) => b.avgAmount - a.avgAmount);

  const totalMonthly = candidates.reduce((s, c) => s + c.avgAmount, 0);
  return { candidates, totalMonthly, currency: baseCurrency };
}

/** Dépenses quotidiennes du mois (en devise de base), pour la vue calendrier. */
export async function computeDailySpending(monthKey) {
  const { wallets, transactions, rates, baseCurrency } = await ctx();
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const totals = new Map();
  for (const t of transactions) {
    if (t.type !== 'expense' || !t.date || !t.date.startsWith(monthKey)) continue;
    if (t.debtId) continue;
    // Manquait ici (seule fonction d'agrégation du fichier à l'oublier) : sans cette exclusion, un
    // achat/apport d'investissement gonflait la vue calendrier alors que le résumé du mois
    // (computeMonthSummary) et tous les autres agrégats l'excluent déjà — la somme des jours du
    // calendrier ne correspondait plus au total "Dépenses" affiché ailleurs pour le même mois.
    if (isInvestmentMovementExcluded(t)) continue;
    const amt = toBase(Number(t.amount) || 0, walletCurrency[t.walletId] || baseCurrency, rates, baseCurrency);
    totals.set(t.date, (totals.get(t.date) || 0) + amt);
  }
  return { totals, currency: baseCurrency };
}

/** Score de santé financière (0-100) : taux d'épargne (40%), ratio d'endettement (30%),
    respect du budget du mois (30%). Composite indicatif, pas un conseil financier personnalisé. */
export async function computeFinancialHealthScore(monthKey = currentMonthKey()) {
  const [summary, composition, budgetRows] = await Promise.all([
    computeMonthSummary(monthKey),
    computeNetWorthComposition(),
    computeBudgetVsActual(monthKey),
  ]);

  const savingsRate = summary.income > 0 ? summary.netSavings / summary.income : 0;
  const savingsScore = Math.max(0, Math.min(100, (savingsRate / 0.2) * 100));

  const grossAssets = composition.liquid + composition.savings + composition.blocked + composition.invested + composition.receivables;
  const debtRatio = grossAssets > 0 ? composition.debts / grossAssets : (composition.debts > 0 ? 1 : 0);
  const debtScore = Math.max(0, Math.min(100, 100 - debtRatio * 100));

  const budgeted = budgetRows.filter((r) => r.budget > 0);
  // Tolérance d'un demi-centime : les montants sont des Number sommés directement (pas de
  // représentation en centimes entiers), donc une somme peut ponctuellement déraper de quelques
  // millièmes d'un centime — sans ça, un budget respecté "pile" pourrait apparaître dépassé par
  // erreur d'arrondi flottant. Même convention que debts.js (comparaisons de soldes à 0.005 près).
  const withinBudget = budgeted.filter((r) => r.actual <= r.budget + 0.005).length;
  const budgetAdherencePct = budgeted.length ? (withinBudget / budgeted.length) * 100 : 70;
  const budgetScore = budgetAdherencePct;

  const score = Math.round(savingsScore * 0.4 + debtScore * 0.3 + budgetScore * 0.3);
  return { score, savingsRate, debtRatio, budgetAdherencePct, currency: summary.currency };
}

/** Devine la catégorie la plus probable pour une note libre de transaction (Saisie express,
    import CSV générique). Priorité aux règles explicites de l'utilisateur (Budgets > Règles,
    STORES.CATEGORIZATION_RULES) ; à défaut, ressemblance textuelle (même prédicat de
    correspondance qu'avant : égalité ou inclusion dans un sens ou l'autre) avec les transactions
    déjà catégorisées du même type — mais on retient la catégorie la plus FRÉQUENTE parmi les
    correspondances plutôt que celle de la transaction correspondante la plus récente, pour qu'une
    catégorisation ponctuellement erronée sur un achat récurrent ne fausse pas toutes les
    suggestions suivantes. Renvoie null si rien de probant.
    Partagée entre transactions.js et backup.js, qui dupliquaient chacun une version de cette
    logique — celle de backup.js (import CSV générique) ne consultait jamais les règles. */
export async function guessCategoryId(note, type) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const n = norm(note);
  if (n.length < 3) return null;

  if (type === 'expense' || type === 'income') {
    const rules = await dbGetAll(STORES.CATEGORIZATION_RULES);
    const ruleMatch = rules.find((r) => r.pattern && n.includes(r.pattern.toLowerCase()));
    if (ruleMatch) return ruleMatch.categoryId;
  }

  const transactions = await dbGetAll(STORES.TRANSACTIONS);
  const scores = new Map(); // categoryId -> nombre de correspondances
  for (const t of transactions) {
    if (t.type !== type || !t.categoryId || !t.note) continue;
    const tn = norm(t.note);
    if (tn !== n && !tn.includes(n) && !n.includes(tn)) continue;
    scores.set(t.categoryId, (scores.get(t.categoryId) || 0) + 1);
  }
  if (!scores.size) return null;
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const UNUSUAL_EXPENSE_MIN_SAMPLES = 3;
const UNUSUAL_EXPENSE_RATIO = 2.5;

/** Signale une dépense nettement plus élevée que l'habitude pour sa catégorie — purement
    informatif, n'empêche jamais l'enregistrement. Sert surtout à rattraper une erreur de saisie
    (ex: 45 000 tapé au lieu de 4 500). Comparaison faite en devise de base (une catégorie peut
    recevoir des dépenses de portefeuilles en devises différentes). Renvoie null si la catégorie a
    moins de UNUSUAL_EXPENSE_MIN_SAMPLES dépenses passées (pas assez d'historique pour que "la
    moyenne" veuille dire quoi que ce soit), si le montant ne dépasse pas UNUSUAL_EXPENSE_RATIO fois
    cette moyenne, ou si une devise impliquée dans la comparaison a un taux non confirmé (par défaut
    1:1, "presque certainement faux" — voir getUnconfirmedRates() — la comparaison serait trompeuse).
    excludeId sert à ignorer la transaction elle-même lors d'une modification.
    Fait son propre chargement ciblé plutôt que ctx() (qui charge aussi catégories/budgets/
    investissements/dettes, inutiles ici) : appelée à chaque enregistrement de dépense, pas
    seulement pour un rendu de vue. */
export async function checkUnusualExpense(categoryId, amount, walletId, excludeId = null) {
  if (!categoryId || !amount) return null;
  const [wallets, transactions, rates, baseCurrency] = await Promise.all([
    dbGetAll(STORES.WALLETS), dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.EXCHANGE_RATES), getSetting('baseCurrency', 'EUR'),
  ]);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const past = transactions.filter((t) => t.type === 'expense' && t.categoryId === categoryId && t.id !== excludeId);
  if (past.length < UNUSUAL_EXPENSE_MIN_SAMPLES) return null;

  const currenciesInvolved = new Set([walletCurrency[walletId], ...past.map((t) => walletCurrency[t.walletId])]);
  const unconfirmed = rates.some((r) => currenciesInvolved.has(r.code) && r.code !== baseCurrency && r.confirmed === false);
  if (unconfirmed) return null;

  const pastBase = past.map((t) => toBase(Number(t.amount) || 0, walletCurrency[t.walletId] || baseCurrency, rates, baseCurrency));
  const average = pastBase.reduce((s, v) => s + v, 0) / pastBase.length;
  const amountBase = toBase(amount, walletCurrency[walletId] || baseCurrency, rates, baseCurrency);
  if (average <= 0 || amountBase < average * UNUSUAL_EXPENSE_RATIO) return null;

  return { average, amount: amountBase, ratio: amountBase / average, currency: baseCurrency };
}

/* ---------- Frais Mobile Money ---------- */
// Catégories de frais reconnues (l'import de SMS en crée une « Frais » ; sms-import.js l'importe d'ici).
export const FEE_CATEGORY_VARIANTS = ['Frais', 'Fees', 'Frais bancaires', 'Frais de transaction', 'Bank fees'];

/** Une transaction est-elle un frais Mobile Money ? Les frais créés par l'import de SMS portent mmFee ;
    les plus anciens se reconnaissent à leur référence (« …#frais ») ou à l'étiquette « sms » + catégorie de frais. */
export function isMobileMoneyFee(t, feeCategoryIds) {
  if (t.type !== 'expense') return false;
  if (t.mmFee) return true;
  if (typeof t.externalRef === 'string' && t.externalRef.endsWith('#frais')) return true;
  return Array.isArray(t.tags) && t.tags.includes('sms') && feeCategoryIds.has(t.categoryId);
}

/** Opérateur d'un frais : champ provider (imports récents), sinon le début du libellé
    (« Frais — Orange Money · Envoi à… »), sinon le nom du portefeuille. */
function feeOperator(t, walletName) {
  if (t.provider) return t.provider;
  const m = /^(?:Frais|Fees?)\s*—\s*(.+?)\s·\s/.exec(t.note || '');
  if (m) return m[1];
  return walletName || tr('Non précisé');
}

/** Frais Mobile Money payés : total du mois par opérateur, historique des `monthsBack` derniers mois,
    cumul de l'année et projection annuelle — pour que ce coût, d'ordinaire invisible, saute aux yeux. */
export async function computeMobileMoneyFees(monthKey = currentMonthKey(), monthsBack = 6) {
  const { wallets, transactions, categories, rates, baseCurrency } = await ctx();
  const walletById = Object.fromEntries(wallets.map((w) => [w.id, w]));
  const feeCats = new Set(categories.filter((c) => c.type === 'expense' && FEE_CATEGORY_VARIANTS.includes(c.name)).map((c) => c.id));
  const keys = [];
  for (let i = monthsBack - 1; i >= 0; i--) keys.push(monthKeyOffset(monthKey, -i));
  const history = new Map(keys.map((k) => [k, 0]));
  const byOperator = new Map();
  const year = monthKey.slice(0, 4);
  let monthTotal = 0; let monthCount = 0; let monthExpenses = 0; let yearToDate = 0; let yearCount = 0;
  for (const t of transactions) {
    if (t.type !== 'expense' || !t.date || t.debtId || isInvestmentMovementExcluded(t)) continue;
    const month = t.date.slice(0, 7);
    const wallet = walletById[t.walletId];
    const amount = toBase(Number(t.amount) || 0, wallet?.currency || baseCurrency, rates, baseCurrency);
    if (month === monthKey) monthExpenses += amount;
    if (!isMobileMoneyFee(t, feeCats)) continue;
    if (history.has(month)) history.set(month, history.get(month) + amount);
    if (t.date.startsWith(year) && month <= monthKey) { yearToDate += amount; yearCount++; }
    if (month === monthKey) {
      monthTotal += amount; monthCount++;
      const name = feeOperator(t, wallet?.name);
      const row = byOperator.get(name) || { name, total: 0, count: 0 };
      row.total += amount; row.count++;
      byOperator.set(name, row);
    }
  }
  const monthsElapsed = Math.max(1, Number(monthKey.slice(5, 7)));
  return {
    currency: baseCurrency,
    month: { total: monthTotal, count: monthCount, share: monthExpenses > 0 ? (monthTotal / monthExpenses) * 100 : 0, operators: [...byOperator.values()].sort((a, b) => b.total - a.total) },
    history: keys.map((k) => ({ monthKey: k, total: Math.round(history.get(k) * 100) / 100 })),
    yearToDate, yearCount, projectedYear: (yearToDate / monthsElapsed) * 12,
    hasData: yearCount > 0 || [...history.values()].some((v) => v > 0),
  };
}
