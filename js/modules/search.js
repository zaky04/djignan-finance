/* ==========================================================================
   GeoFinance System — Recherche globale
   Cherche en mémoire (jeu de données personnel, donc petit) parmi
   transactions, portefeuilles, dettes/créances, objectifs d'épargne et
   investissements. Ouverture via l'icône loupe ou Ctrl/Cmd+K.
   ========================================================================== */

import { STORES, dbGetAll } from '../db.js';
import { getEnrichedTransactions } from '../ledger.js';
import { formatCurrency, formatDate, escapeHtml, debounce } from '../utils.js';

const TYPE_LABELS = {
  transaction: 'Transaction',
  wallet: 'Portefeuille',
  debt: 'Dette',
  receivable: 'Créance',
  savings: 'Épargne',
  investment: 'Investissement',
};

function goToView(view) {
  document.querySelector(`[data-view-target="${view}"]`)?.click();
}

function norm(s) {
  return (s || '').toString().toLowerCase();
}

async function collectSearchIndex() {
  const [transactions, wallets, debts, savingsGoals, investments] = await Promise.all([
    getEnrichedTransactions({ limit: 500 }),
    dbGetAll(STORES.WALLETS),
    dbGetAll(STORES.DEBTS),
    dbGetAll(STORES.SAVINGS_GOALS),
    dbGetAll(STORES.INVESTMENTS),
  ]);

  const items = [];

  for (const t of transactions) {
    items.push({
      type: 'transaction',
      haystack: `${t.note || ''} ${t.category?.name || ''} ${t.wallet?.name || ''}`,
      title: t.category?.name || t.note || 'Transaction',
      sub: `${t.wallet?.name || ''} · ${formatDate(t.date)}${t.note ? ' · ' + t.note : ''}`,
      amount: formatCurrency(t.amount, t.wallet?.currency || 'EUR'),
      view: 'transactions',
    });
  }
  for (const w of wallets.filter((w) => !w.archived)) {
    items.push({
      type: 'wallet',
      haystack: w.name,
      title: w.name,
      sub: w.currency,
      view: 'wallets',
    });
  }
  for (const d of debts) {
    items.push({
      type: d.type === 'debt' ? 'debt' : 'receivable',
      haystack: `${d.personName} ${d.note || ''}`,
      title: d.personName,
      sub: formatCurrency(d.principal, d.currency),
      view: 'debts',
    });
  }
  for (const g of savingsGoals.filter((g) => !g.archived)) {
    items.push({
      type: 'savings',
      haystack: g.name,
      title: g.name,
      sub: `${formatCurrency(g.currentAmount, g.currency)} / ${formatCurrency(g.targetAmount, g.currency)}`,
      view: 'savings',
    });
  }
  for (const inv of investments) {
    items.push({
      type: 'investment',
      haystack: inv.name,
      title: inv.name,
      sub: formatCurrency(inv.capitalInvested, inv.currency),
      view: 'investments',
    });
  }

  return items;
}

function resultRowHtml(item) {
  return `
    <button type="button" class="search-result" data-view="${item.view}">
      <span class="badge badge-accent search-result-badge">${TYPE_LABELS[item.type]}</span>
      <span class="search-result-body">
        <span class="search-result-title">${escapeHtml(item.title)}</span>
        <span class="search-result-sub">${escapeHtml(item.sub)}</span>
      </span>
      ${item.amount ? `<span class="search-result-amount">${escapeHtml(item.amount)}</span>` : ''}
    </button>`;
}

export function openGlobalSearch() {
  document.querySelectorAll('.modal-backdrop[data-modal="search"]').forEach((el) => el.remove());

  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.dataset.modal = 'search';
  backdrop.innerHTML = `
    <div class="modal-card search-modal" role="dialog" aria-modal="true" aria-label="Recherche">
      <div class="search-input-row">
        <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"/></svg>
        <input type="text" id="search-input" placeholder="Rechercher une transaction, un portefeuille, une dette…" autocomplete="off">
        <button type="button" class="icon-btn modal-close" aria-label="Fermer">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6Z"/></svg>
        </button>
      </div>
      <div id="search-results" class="search-results">
        <div class="empty-state">Tapez pour rechercher parmi vos transactions, portefeuilles, dettes, objectifs d'épargne et investissements.</div>
      </div>
    </div>`;
  root.appendChild(backdrop);

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const input = backdrop.querySelector('#search-input');
  const resultsEl = backdrop.querySelector('#search-results');
  let index = null;

  const runSearch = debounce(() => {
    const q = norm(input.value).trim();
    if (!q) {
      resultsEl.innerHTML = '<div class="empty-state">Tapez pour rechercher parmi vos transactions, portefeuilles, dettes, objectifs d\'épargne et investissements.</div>';
      return;
    }
    const matches = index.filter((it) => norm(it.haystack).includes(q)).slice(0, 40);
    resultsEl.innerHTML = matches.length
      ? matches.map(resultRowHtml).join('')
      : '<div class="empty-state">Aucun résultat.</div>';
  }, 120);

  input.addEventListener('input', runSearch);
  resultsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.search-result');
    if (!btn) return;
    close();
    goToView(btn.dataset.view);
  });

  collectSearchIndex().then((items) => { index = items; });

  setTimeout(() => input.focus(), 50);
}

export function initSearchModule() {
  document.getElementById('search-btn')?.addEventListener('click', () => openGlobalSearch());
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openGlobalSearch();
    }
  });
}
