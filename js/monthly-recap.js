/* ==========================================================================
   Djignan Financial System — Bilan du mois à partager
   Une page lisible en dix secondes : ce qui est entré, sorti, ce qui a changé par rapport au mois
   dernier, ce qui pèse le plus. Entièrement calculé en local par des règles simples (aucune IA, rien
   n'est envoyé nulle part) ; l'utilisateur choisit ensuite de partager l'image ou le texte, avec ou
   sans les montants.

   buildMonthlyRecap est pur (aucun accès base) et testé hors navigateur ; loadMonthlyRecap le nourrit.
   ========================================================================== */

import { STORES, dbGetAll, getSetting } from './db.js';
import { isInvestmentMovementExcluded } from './ledger.js';
import { convertAmount, formatCurrency, formatMonthLabel, formatDate, monthKeyOffset } from './utils.js';
import { t as tr } from './i18n.js';

const MASK = '•••';

/** Totaux par catégorie (dépenses) et entrées/sorties d'un mois, en devise de base. */
function monthTotals(monthKey, { transactions, wallets, categories, rates, baseCurrency }) {
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const byCategory = new Map();
  let income = 0; let expenses = 0; let biggest = null; const days = new Set();
  for (const tx of transactions) {
    if (!tx.date || !tx.date.startsWith(monthKey) || tx.debtId || isInvestmentMovementExcluded(tx)) continue;
    if (tx.type !== 'income' && tx.type !== 'expense') continue;
    const amount = convertAmount(Number(tx.amount) || 0, walletCurrency[tx.walletId] || baseCurrency, baseCurrency, rates, baseCurrency);
    if (tx.type === 'income') { income += amount; continue; }
    expenses += amount;
    days.add(tx.date);
    const key = tx.categoryId || 'none';
    const row = byCategory.get(key) || { key, name: catName[tx.categoryId] || tr('Sans catégorie'), value: 0 };
    row.value += amount;
    byCategory.set(key, row);
    if (!biggest || amount > biggest.amount) biggest = { amount, name: (tx.note || '').trim() || catName[tx.categoryId] || tr('Sans catégorie'), date: tx.date };
  }
  return { income, expenses, byCategory, biggest, daysWithSpending: days.size };
}

export function buildMonthlyRecap({ monthKey, transactions = [], wallets = [], categories = [], budgets = [], rates = [], baseCurrency = 'XOF' }) {
  const data = { transactions, wallets, categories, rates, baseCurrency };
  const cur = monthTotals(monthKey, data);
  const prev = monthTotals(monthKeyOffset(monthKey, -1), data);
  const net = cur.income - cur.expenses;
  const savingsRate = cur.income > 0 ? (net / cur.income) * 100 : null;
  const expensesDeltaPct = prev.expenses > 0 ? ((cur.expenses - prev.expenses) / prev.expenses) * 100 : null;

  const top = [...cur.byCategory.values()].sort((a, b) => b.value - a.value).slice(0, 5).map((row) => {
    const before = prev.byCategory.get(row.key)?.value || 0;
    return { ...row, share: cur.expenses > 0 ? (row.value / cur.expenses) * 100 : 0, prev: before, deltaPct: before > 0 ? ((row.value - before) / before) * 100 : null, delta: row.value - before };
  });

  const budgetsOver = budgets.filter((b) => b.month === monthKey && b.limit > 0).map((b) => {
    const spent = cur.byCategory.get(b.categoryId)?.value || 0;
    return { name: categories.find((c) => c.id === b.categoryId)?.name || tr('Sans catégorie'), pct: (spent / b.limit) * 100 };
  }).filter((b) => b.pct > 100).sort((a, b) => b.pct - a.pct);

  return {
    monthKey, currency: baseCurrency, income: cur.income, expenses: cur.expenses, net, savingsRate,
    prevExpenses: prev.expenses, expensesDeltaPct, top, budgetsOver, biggest: cur.biggest,
    hasData: cur.income > 0 || cur.expenses > 0,
  };
}

/** Phrases du bilan (au plus 5), par règles. `hideAmounts` remplace tout montant par •••. */
export function recapHighlights(recap, { hideAmounts = false } = {}) {
  const money = (v) => (hideAmounts ? MASK : formatCurrency(v, recap.currency));
  const lines = [];
  if (recap.expensesDeltaPct != null && Math.abs(recap.expensesDeltaPct) >= 3) {
    lines.push(recap.expensesDeltaPct > 0
      ? tr('Vous avez dépensé {amount}, soit {pct} % de plus que le mois dernier.', { amount: money(recap.expenses), pct: Math.round(recap.expensesDeltaPct) })
      : tr('Vous avez dépensé {amount}, soit {pct} % de moins que le mois dernier.', { amount: money(recap.expenses), pct: Math.round(-recap.expensesDeltaPct) }));
  } else if (recap.expenses > 0) {
    // « comme le mois dernier » n'a de sens que s'il y a eu un mois dernier : sans historique, on ne compare pas.
    lines.push(recap.expensesDeltaPct != null
      ? tr('Vous avez dépensé {amount}, à peu près comme le mois dernier.', { amount: money(recap.expenses) })
      : tr('Vous avez dépensé {amount} ce mois-ci.', { amount: money(recap.expenses) }));
  }
  if (recap.income > 0) {
    lines.push(recap.net >= 0
      ? tr('Vous avez mis de côté {amount} ({pct} % de vos entrées).', { amount: money(recap.net), pct: Math.round(recap.savingsRate) })
      : tr('Vos dépenses dépassent vos entrées de {amount}.', { amount: money(-recap.net) }));
  }
  const first = recap.top[0];
  if (first) lines.push(tr('{name} pèse {pct} % de vos dépenses ({amount}).', { name: first.name, pct: Math.round(first.share), amount: money(first.value) }));
  // Plus forte hausse / baisse de catégorie : seulement si elle compte (≥ 25 % ET ≥ 5 % des dépenses du mois).
  const significant = recap.top.filter((r) => r.deltaPct != null && Math.abs(r.deltaPct) >= 25 && Math.abs(r.delta) >= recap.expenses * 0.05);
  const rise = significant.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  const fall = significant.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta)[0];
  if (rise) lines.push(tr('{name} a augmenté de {pct} % ({amount} de plus).', { name: rise.name, pct: Math.round(rise.deltaPct), amount: money(rise.delta) }));
  if (fall) lines.push(tr('Bravo : {name} baisse de {pct} %.', { name: fall.name, pct: Math.round(-fall.deltaPct) }));
  if (recap.budgetsOver.length) lines.push(tr('{count} budget(s) dépassé(s) : {names}.', { count: recap.budgetsOver.length, names: recap.budgetsOver.slice(0, 3).map((b) => b.name).join(', ') }));
  // Pas de « plus grosse dépense » quand on masque les montants : son libellé peut nommer quelqu'un
  // (« Envoi à Moussa »), donc révéler plus que ce que l'utilisateur a choisi de montrer.
  if (recap.biggest && lines.length < 5 && !hideAmounts) lines.push(tr('Plus grosse dépense : {name}, {amount} le {date}.', { name: recap.biggest.name, amount: money(recap.biggest.amount), date: formatDate(recap.biggest.date) }));
  return lines.slice(0, 5);
}

export function recapAsText(recap, opts = {}) {
  const money = (v) => (opts.hideAmounts ? MASK : formatCurrency(v, recap.currency));
  return [
    tr('Mon mois — {month}', { month: formatMonthLabel(recap.monthKey) }),
    `${tr('Entrées')} : ${money(recap.income)} · ${tr('Sorties')} : ${money(recap.expenses)} · ${tr('Épargne nette')} : ${money(recap.net)}`,
    ...recapHighlights(recap, opts).map((l) => `• ${l}`),
    'Djignan',
  ].join('\n');
}

export async function loadMonthlyRecap(monthKey) {
  const [transactions, wallets, categories, budgets, rates, baseCurrency] = await Promise.all([
    dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES), dbGetAll(STORES.BUDGETS),
    dbGetAll(STORES.EXCHANGE_RATES), getSetting('baseCurrency', 'EUR'),
  ]);
  return buildMonthlyRecap({ monthKey, transactions, wallets, categories, budgets, rates, baseCurrency });
}

/* ---------- Image à partager (canvas 1080 × 1350) ---------- */
function wrapText(ctx, text, maxWidth) {
  // Coupe sur l'espace normal UNIQUEMENT : les espaces insécables (séparateur de milliers) ne doivent
  // jamais couper un montant en deux (« 5 / 000 F CFA »).
  const words = text.split(/ +/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Dessine la carte et renvoie un Blob PNG. */
export function renderRecapCard(recap, { hideAmounts = false } = {}) {
  const W = 1080; const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const money = (v) => (hideAmounts ? MASK : formatCurrency(v, recap.currency));

  ctx.fillStyle = '#111226'; ctx.fillRect(0, 0, W, H);

  const font = (size, weight = 400) => `${weight} ${size}px "Source Sans 3", system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillStyle = '#c9a24a'; ctx.font = font(34, 700); ctx.fillText('DJIGNAN', 80, 110);
  ctx.fillStyle = '#ffffff'; ctx.font = font(64, 800); ctx.fillText(formatMonthLabel(recap.monthKey), 80, 200);

  const kpis = [[tr('Entrées'), money(recap.income), '#4cc38a'], [tr('Sorties'), money(recap.expenses), '#f08071'], [tr('Épargne nette'), money(recap.net), recap.net >= 0 ? '#4cc38a' : '#f08071']];
  kpis.forEach(([label, value, color], i) => {
    const x = 80 + i * 320;
    ctx.fillStyle = '#b7bdd9'; ctx.font = font(28); ctx.fillText(label, x, 300);
    ctx.fillStyle = color; ctx.font = font(hideAmounts ? 44 : 38, 800); ctx.fillText(value, x, 352, 300);
  });

  let y = 450;
  ctx.fillStyle = '#ffffff'; ctx.font = font(34, 700); ctx.fillText(tr('Là où part votre argent'), 80, y); y += 30;
  for (const row of recap.top.slice(0, 4)) {
    y += 56;
    ctx.fillStyle = '#dfe3f5'; ctx.font = font(30); ctx.fillText(row.name, 80, y, 560);
    ctx.fillStyle = '#b7bdd9'; ctx.textAlign = 'right'; ctx.fillText(`${Math.round(row.share)} %`, W - 80, y); ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(80, y + 14, W - 160, 14);
    ctx.fillStyle = '#7fb0ea'; ctx.fillRect(80, y + 14, Math.max(8, (W - 160) * Math.min(1, row.share / 100)), 14);
    y += 40;
  }

  y += 70;
  ctx.fillStyle = '#ffffff'; ctx.font = font(34, 700); ctx.fillText(tr('Ce qu’il faut retenir'), 80, y);
  ctx.font = font(31);
  for (const line of recapHighlights(recap, { hideAmounts }).slice(0, 4)) {
    ctx.fillStyle = '#dfe3f5';
    for (const [i, part] of wrapText(ctx, line, W - 200).entries()) {
      y += 46;
      ctx.fillText(i === 0 ? `•  ${part}` : `    ${part}`, 80, y);
    }
    y += 12;
  }

  ctx.fillStyle = '#7f86a8'; ctx.font = font(26); ctx.fillText(tr('Calculé sur mon téléphone — mes données restent chez moi.'), 80, H - 70);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

/** Partage l'image (Web Share avec fichier) ; à défaut, la télécharge. Renvoie 'shared' | 'downloaded' | 'cancelled'. */
export async function shareRecapImage(recap, opts = {}) {
  const blob = await renderRecapCard(recap, opts);
  const file = new File([blob], `djignan-bilan-${recap.monthKey}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: recapAsText(recap, opts) });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return 'downloaded';
}
