/* ==========================================================================
   GeoFinance System — Module Transactions
   Contient : la modale "Saisie express" (création + édition, réutilisée
   dans toute l'app), la liste filtrée des transactions, et le
   rapprochement bancaire ("check-in").
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbDelete, logAudit } from '../db.js';
import { getEnrichedTransactions } from '../ledger.js';
import { uuid, formatCurrency, formatDate, formatMonthLabel, escapeHtml, todayISO, currentMonthKey, monthKeyOffset, openModal, confirmDialog, showToast } from '../utils.js';
import { notifyDataChanged } from '../state.js';

const TX_ICONS = {
  income: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 20V6M6 12l6-6 6 6"/></svg>',
  expense: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v14M6 12l6 6 6-6"/></svg>',
  transfer: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M7 7h11l-3-3M17 17H6l3 3"/></svg>',
};
const CHECK_CIRCLE = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1.2 14.5-4.3-4.3 1.4-1.4 2.9 2.9 6.1-6.1 1.4 1.4-7.5 7.5Z"/></svg>';
const EMPTY_CIRCLE = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="1.6" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"/></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2h4v2H2V5h4l1-2Z"/></svg>';

/* ==========================================================================
   Modale Saisie express (création + édition)
   ========================================================================== */
export function openQuickAdd({ editTransaction = null } = {}) {
  document.querySelectorAll('#modal-root .modal-backdrop[data-modal="quick-add"]').forEach((el) => el.remove());
  const tpl = document.getElementById('tpl-modal-quick-add');
  const root = document.getElementById('modal-root');
  root.appendChild(tpl.content.cloneNode(true));
  const backdrop = root.querySelector('.modal-backdrop[data-modal="quick-add"]');

  function close() {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  const form = backdrop.querySelector('#quick-add-form');
  const segButtons = backdrop.querySelectorAll('.segmented-btn');
  const targetWalletRow = backdrop.querySelector('[data-field="targetWalletRow"]');
  const categoryRow = backdrop.querySelector('[data-field="categoryRow"]');
  const titleEl = backdrop.querySelector('#qa-title');
  const walletSelect = form.elements.walletId;
  const targetWalletSelect = form.elements.targetWalletId;
  const categorySelect = form.elements.categoryId;

  let currentType = editTransaction?.type || 'expense';

  async function populateWallets() {
    const wallets = (await dbGetAll(STORES.WALLETS)).filter((w) => !w.archived);
    const opts = wallets.map((w) => `<option value="${w.id}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('');
    walletSelect.innerHTML = opts || '<option value="">Créez un portefeuille d\'abord</option>';
    targetWalletSelect.innerHTML = opts;
  }

  async function populateCategories() {
    const all = await dbGetAll(STORES.CATEGORIES);
    const roots = all.filter((c) => c.type === currentType && !c.parentId);
    let html = '';
    for (const r of roots) {
      html += `<option value="${r.id}">${escapeHtml(r.name)}</option>`;
      for (const child of all.filter((c) => c.parentId === r.id)) {
        html += `<option value="${child.id}">— ${escapeHtml(child.name)}</option>`;
      }
    }
    categorySelect.innerHTML = html || '<option value="">Aucune catégorie (créez-en dans Budgets)</option>';
  }

  function setType(type) {
    currentType = type;
    segButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.value === type));
    targetWalletRow.hidden = type !== 'transfer';
    categoryRow.hidden = type === 'transfer';
    targetWalletSelect.required = type === 'transfer';
    categorySelect.required = type !== 'transfer';
    titleEl.textContent = editTransaction ? 'Modifier la transaction' : (type === 'transfer' ? 'Transfert entre portefeuilles' : 'Saisie express');
    if (type !== 'transfer') populateCategories();
  }

  segButtons.forEach((b) => b.addEventListener('click', () => setType(b.dataset.value)));

  /* Auto-catégorisation : si la note ressemble à une transaction déjà catégorisée,
     pré-sélectionne sa catégorie (tant que l'utilisateur n'a pas choisi la sienne). */
  let categoryTouchedByUser = !!editTransaction;
  categorySelect.addEventListener('change', () => { categoryTouchedByUser = true; });

  const norm = (s) => (s || '').trim().toLowerCase();
  async function suggestCategoryFromNote() {
    if (categoryTouchedByUser || currentType === 'transfer') return;
    const note = norm(form.elements.note.value);
    if (note.length < 3) return;
    const all = await dbGetAll(STORES.TRANSACTIONS);
    const match = all
      .filter((t) => t.type === currentType && t.categoryId && t.note)
      .map((t) => ({ t, n: norm(t.note) }))
      .filter(({ n }) => n === note || n.includes(note) || note.includes(n))
      .sort((a, b) => (b.t.date || '').localeCompare(a.t.date || ''))[0]?.t;
    if (match && categorySelect.querySelector(`option[value="${match.categoryId}"]`)) {
      categorySelect.value = match.categoryId;
    }
  }
  let suggestDebounce = null;
  form.elements.note.addEventListener('input', () => {
    clearTimeout(suggestDebounce);
    suggestDebounce = setTimeout(suggestCategoryFromNote, 250);
  });

  (async () => {
    await populateWallets();
    setType(currentType);
    form.elements.date.value = editTransaction?.date || todayISO();
    form.elements.amount.value = editTransaction?.amount ?? '';
    form.elements.note.value = editTransaction?.note || '';
    if (editTransaction) {
      walletSelect.value = editTransaction.walletId;
      if (editTransaction.type === 'transfer') targetWalletSelect.value = editTransaction.targetWalletId;
      else categorySelect.value = editTransaction.categoryId || '';
    }
  })();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const type = currentType;
    const walletId = fd.get('walletId');
    const targetWalletId = type === 'transfer' ? fd.get('targetWalletId') : null;

    if (!walletId) { showToast('Créez au moins un portefeuille avant de saisir une transaction.'); return; }
    if (type === 'transfer' && walletId === targetWalletId) { showToast('Choisissez deux portefeuilles différents.'); return; }

    const record = {
      id: editTransaction?.id || uuid(),
      type,
      walletId,
      targetWalletId,
      categoryId: type !== 'transfer' ? (fd.get('categoryId') || null) : null,
      amount: parseFloat(fd.get('amount')) || 0,
      date: fd.get('date'),
      note: (fd.get('note') || '').trim().slice(0, 140),
      reconciled: editTransaction?.reconciled || false,
      createdAt: editTransaction?.createdAt || new Date().toISOString(),
    };
    const before = editTransaction ? { ...editTransaction } : null;
    await dbPut(STORES.TRANSACTIONS, record);
    await logAudit({ entityType: 'transaction', entityId: record.id, action: editTransaction ? 'update' : 'create', before, after: record });
    close();
    showToast(editTransaction ? 'Transaction modifiée.' : 'Transaction enregistrée.');
    notifyDataChanged('transactions');
  });
}

/* ==========================================================================
   Liste des transactions (vue complète, filtrable)
   ========================================================================== */
const filters = { monthKey: currentMonthKey(), walletId: '', categoryId: '', type: '', reconciled: '' };

function txRowHtml(t) {
  const isTransfer = t.type === 'transfer';
  const title = isTransfer ? `${t.wallet?.name || '—'} → ${t.targetWallet?.name || '—'}` : (t.category?.name || 'Sans catégorie');
  const sub = `${escapeHtml(t.wallet?.name || '')} · ${formatDate(t.date)}${t.note ? ' · ' + escapeHtml(t.note) : ''}`;
  const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
  const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : '';
  const currency = t.wallet?.currency || 'EUR';

  return `
    <div class="tx-row" data-tx-id="${t.id}">
      <div class="tx-icon">${TX_ICONS[t.type] || ''}</div>
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(title)}</div>
        <div class="tx-sub">${sub}</div>
      </div>
      <div class="tx-amount amount ${cls}" data-value="${t.amount}">${sign}${formatCurrency(t.amount, currency)}</div>
      <div class="card-actions">
        <button type="button" class="icon-btn" data-action="reconcile" title="${t.reconciled ? 'Pointée (cliquer pour annuler)' : 'Marquer comme pointée'}" style="color:${t.reconciled ? 'var(--pos)' : 'var(--text-faint)'}">
          ${t.reconciled ? CHECK_CIRCLE : EMPTY_CIRCLE}
        </button>
        <button type="button" class="icon-btn" data-action="edit" title="Modifier">${EDIT_ICON}</button>
        <button type="button" class="icon-btn" data-action="delete" title="Supprimer">${DELETE_ICON}</button>
      </div>
    </div>`;
}

async function renderList() {
  const container = document.getElementById('transactions-list');
  if (!container) return;
  let rows = await getEnrichedTransactions({
    monthKey: filters.monthKey,
    walletId: filters.walletId || null,
    categoryId: filters.categoryId || null,
    type: filters.type || null,
  });
  if (filters.reconciled === 'yes') rows = rows.filter((r) => r.reconciled);
  if (filters.reconciled === 'no') rows = rows.filter((r) => !r.reconciled);

  container.innerHTML = rows.length ? rows.map(txRowHtml).join('') : '<div class="tx-empty">Aucune transaction pour ces filtres.</div>';
}

async function renderFiltersBar() {
  const bar = document.getElementById('transactions-filters');
  if (!bar) return;
  const [wallets, categories] = await Promise.all([dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES)]);

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px;">
      <button type="button" class="icon-btn" id="tx-prev-month" aria-label="Mois précédent">‹</button>
      <strong style="min-width:130px;text-align:center;display:inline-block;">${formatMonthLabel(filters.monthKey)}</strong>
      <button type="button" class="icon-btn" id="tx-next-month" aria-label="Mois suivant">›</button>
    </div>
    <select id="tx-filter-wallet"><option value="">Tous les portefeuilles</option>${wallets.map((w) => `<option value="${w.id}" ${filters.walletId === w.id ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')}</select>
    <select id="tx-filter-category"><option value="">Toutes catégories</option>${categories.map((c) => `<option value="${c.id}" ${filters.categoryId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
    <select id="tx-filter-type">
      <option value="">Tous types</option>
      <option value="income" ${filters.type === 'income' ? 'selected' : ''}>Recettes</option>
      <option value="expense" ${filters.type === 'expense' ? 'selected' : ''}>Dépenses</option>
      <option value="transfer" ${filters.type === 'transfer' ? 'selected' : ''}>Transferts</option>
    </select>
    <select id="tx-filter-reconciled">
      <option value="">Rapprochement : toutes</option>
      <option value="yes" ${filters.reconciled === 'yes' ? 'selected' : ''}>Pointées</option>
      <option value="no" ${filters.reconciled === 'no' ? 'selected' : ''}>Non pointées</option>
    </select>`;

  bar.querySelector('#tx-prev-month').onclick = () => { filters.monthKey = monthKeyOffset(filters.monthKey, -1); renderTransactions(); };
  bar.querySelector('#tx-next-month').onclick = () => { filters.monthKey = monthKeyOffset(filters.monthKey, 1); renderTransactions(); };
  bar.querySelector('#tx-filter-wallet').onchange = (e) => { filters.walletId = e.target.value; renderList(); };
  bar.querySelector('#tx-filter-category').onchange = (e) => { filters.categoryId = e.target.value; renderList(); };
  bar.querySelector('#tx-filter-type').onchange = (e) => { filters.type = e.target.value; renderList(); };
  bar.querySelector('#tx-filter-reconciled').onchange = (e) => { filters.reconciled = e.target.value; renderList(); };
}

export async function renderTransactions() {
  await renderFiltersBar();
  await renderList();
}

export function initTransactionsModule() {
  document.getElementById('transaction-add-btn')?.addEventListener('click', () => openQuickAdd());

  document.getElementById('transactions-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const row = e.target.closest('[data-tx-id]');
    const txId = row?.dataset.txId;
    const all = await dbGetAll(STORES.TRANSACTIONS);
    const t = all.find((x) => x.id === txId);
    if (!t) return;

    if (btn.dataset.action === 'reconcile') {
      const before = { ...t };
      t.reconciled = !t.reconciled;
      await dbPut(STORES.TRANSACTIONS, t);
      await logAudit({ entityType: 'transaction', entityId: t.id, action: 'update', before, after: t, note: t.reconciled ? 'Pointée' : 'Dépointée' });
      renderList();
    } else if (btn.dataset.action === 'edit') {
      openQuickAdd({ editTransaction: t });
    } else if (btn.dataset.action === 'delete') {
      const ok = await confirmDialog('Supprimer définitivement cette transaction ?', { danger: true, confirmText: 'Supprimer' });
      if (ok) {
        await dbDelete(STORES.TRANSACTIONS, txId);
        await logAudit({ entityType: 'transaction', entityId: txId, action: 'delete', before: t });
        showToast('Transaction supprimée.');
        notifyDataChanged('transactions');
      }
    }
  });
}
