/* ==========================================================================
   GeoFinance System — Module Budgets, Catégories & Récurrences
   Trois onglets : Budgets du mois (plafonds + alertes 70/90%), Catégories
   (arborescence éditable), Récurrences & Échéancier (abonnements/factures
   avec génération automatique des transactions dues et prévision de solde
   de fin de mois).
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbAdd, dbDelete, logAudit } from '../db.js';
import { computeCategoryActuals, computeEndOfMonthForecast } from '../ledger.js';
import {
  uuid, formatCurrency, formatDate, formatMonthLabel, formatPercent, escapeHtml, todayISO, localISODate,
  currentMonthKey, monthKeyOffset, percentage, budgetProgressClass, openModal, confirmDialog, showToast,
} from '../utils.js';
import { notifyDataChanged } from '../state.js';

const EDIT_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 7h12l-1 14H7L6 7Zm3-4h6l1 2h4v2H2V5h4l1-2Z"/></svg>';
const PLUS_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M6 4h4v16H6V4Zm8 0h4v16h-4V4Z"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5v14l11-7L8 5Z"/></svg>';

const FREQ_LABELS = { weekly: 'Hebdomadaire', monthly: 'Mensuelle', yearly: 'Annuelle' };

let activeTab = 'monthly';
let monthKey = currentMonthKey();

/* ==========================================================================
   Onglet 1 — Budgets du mois
   ========================================================================== */
function budgetCategoryCardHtml(cat, actual, limit, currency) {
  const pct = limit ? percentage(actual, limit) : 0;
  const cls = budgetProgressClass(pct);
  return `
    <div class="summary-card" style="${cat.parentId ? 'margin-left:16px;' : ''}">
      <div class="card-title-row">
        <div style="font-weight:700;font-size:14px;">${cat.parentId ? '— ' : ''}${escapeHtml(cat.name)}</div>
        <input type="number" min="0" step="0.01" data-limit-input="${cat.id}" value="${limit || ''}" placeholder="Budget"
          style="width:100px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-alt);text-align:right;">
      </div>
      <div class="progress-track"><div class="progress-fill ${cls}" style="width:${Math.min(pct, 100)}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-muted);margin-top:6px;">
        <span>${formatCurrency(actual, currency)}</span>
        <span>${limit ? formatPercent(pct, 0) : 'Pas de limite'}</span>
      </div>
    </div>`;
}

async function renderMonthlyTab(container) {
  const [actuals, allBudgets, forecast] = await Promise.all([
    computeCategoryActuals(monthKey, 'expense'),
    dbGetAll(STORES.BUDGETS),
    computeEndOfMonthForecast(),
  ]);
  const monthBudgets = allBudgets.filter((b) => b.month === monthKey);
  const budgetByCategory = Object.fromEntries(monthBudgets.map((b) => [b.categoryId, b]));
  const categories = await dbGetAll(STORES.CATEGORIES);
  const roots = categories.filter((c) => c.type === 'expense' && !c.parentId);

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px;margin-bottom:14px;">
      <button type="button" class="icon-btn" id="bud-prev-month" aria-label="Mois précédent">‹</button>
      <strong style="min-width:130px;text-align:center;display:inline-block;">${formatMonthLabel(monthKey)}</strong>
      <button type="button" class="icon-btn" id="bud-next-month" aria-label="Mois suivant">›</button>
    </div>
    <div class="hero-card" style="margin-bottom:18px;">
      <div class="hero-card-label">Solde prévisionnel de fin de mois</div>
      <div class="hero-card-value"><span class="amount" data-value="${forecast.projected}">${formatCurrency(forecast.projected, forecast.currency)}</span></div>
      <div class="hero-card-trend">Solde actuel : ${formatCurrency(forecast.current, forecast.currency)}${forecast.upcoming.length ? ` · ${forecast.upcoming.length} échéance(s) à venir ce mois-ci` : ''}</div>
    </div>
    <div class="grid-cards" id="budget-categories-grid"></div>`;

  const grid = container.querySelector('#budget-categories-grid');
  const cards = [];
  for (const root of roots) {
    const rootActual = actuals.find((a) => a.categoryId === root.id)?.actual || 0;
    cards.push(budgetCategoryCardHtml(root, rootActual, budgetByCategory[root.id]?.limit, forecast.currency));
    for (const child of categories.filter((c) => c.parentId === root.id)) {
      const childActual = actuals.find((a) => a.categoryId === child.id)?.actual || 0;
      cards.push(budgetCategoryCardHtml(child, childActual, budgetByCategory[child.id]?.limit, forecast.currency));
    }
  }
  grid.innerHTML = cards.join('') || '<div class="empty-state">Aucune catégorie de dépense. Créez-en dans l\'onglet Catégories.</div>';

  container.querySelector('#bud-prev-month').onclick = () => { monthKey = monthKeyOffset(monthKey, -1); renderMonthlyTab(container); };
  container.querySelector('#bud-next-month').onclick = () => { monthKey = monthKeyOffset(monthKey, 1); renderMonthlyTab(container); };

  grid.querySelectorAll('[data-limit-input]').forEach((input) => {
    input.addEventListener('change', async () => {
      const categoryId = input.dataset.limitInput;
      const limit = parseFloat(input.value) || 0;
      const existing = monthBudgets.find((b) => b.categoryId === categoryId);
      const record = existing ? { ...existing, limit } : { id: uuid(), categoryId, month: monthKey, limit };
      await dbPut(STORES.BUDGETS, record);
      showToast('Budget mis à jour.');
      notifyDataChanged('budgets');
    });
  });
}

/* ==========================================================================
   Onglet 2 — Catégories & sous-catégories
   ========================================================================== */
function categoryFormHtml(category, presetParentId, presetType) {
  const type = category?.type || presetType || 'expense';
  return `
    <form id="category-form">
      <div class="form-row">
        <label>Nom</label>
        <input type="text" name="name" required maxlength="40" value="${escapeHtml(category?.name || '')}">
      </div>
      ${!presetParentId ? `
      <div class="form-row">
        <label>Type</label>
        <select name="type" id="category-type-select">
          <option value="expense" ${type === 'expense' ? 'selected' : ''}>Dépense</option>
          <option value="income" ${type === 'income' ? 'selected' : ''}>Recette</option>
        </select>
      </div>
      <div class="form-row">
        <label>Catégorie parente (optionnel)</label>
        <select name="parentId" id="category-parent-select"><option value="">— Catégorie principale —</option></select>
      </div>` : `<input type="hidden" name="type" value="${escapeHtml(type)}"><input type="hidden" name="parentId" value="${escapeHtml(presetParentId)}">`}
      <button type="submit" class="btn btn-primary btn-block">${category ? 'Enregistrer' : 'Créer'}</button>
    </form>`;
}

async function populateParentSelect(select, type, excludeId) {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const roots = categories.filter((c) => c.type === type && !c.parentId && c.id !== excludeId);
  select.innerHTML = '<option value="">— Catégorie principale —</option>' + roots.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
}

function openCategoryModal(category = null, presetParentId = null, presetType = null) {
  const modal = openModal(categoryFormHtml(category, presetParentId, presetType), { title: category ? 'Modifier la catégorie' : (presetParentId ? 'Nouvelle sous-catégorie' : 'Nouvelle catégorie') });
  const form = modal.el.querySelector('#category-form');
  const typeSelect = modal.el.querySelector('#category-type-select');
  const parentSelect = modal.el.querySelector('#category-parent-select');

  if (typeSelect && parentSelect) {
    populateParentSelect(parentSelect, typeSelect.value, category?.id);
    typeSelect.addEventListener('change', () => populateParentSelect(parentSelect, typeSelect.value, category?.id));
    if (category?.parentId) parentSelect.value = category.parentId;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const before = category ? { ...category } : null;
    const record = {
      id: category?.id || uuid(),
      name: fd.get('name').trim(),
      type: fd.get('type'),
      parentId: fd.get('parentId') || null,
      createdAt: category?.createdAt || new Date().toISOString(),
    };
    await dbPut(STORES.CATEGORIES, record);
    await logAudit({ entityType: 'category', entityId: record.id, action: category ? 'update' : 'create', before, after: record });
    modal.close();
    showToast(category ? 'Catégorie mise à jour.' : 'Catégorie créée.');
    notifyDataChanged('categories');
  });
}

function categoryRowHtml(cat, isChild = false) {
  return `
    <div class="tx-row" data-category-id="${cat.id}" style="${isChild ? 'padding-left:24px;' : ''}">
      <div class="tx-main"><div class="tx-title">${isChild ? '— ' : ''}${escapeHtml(cat.name)}</div></div>
      <div class="card-actions">
        ${!isChild ? `<button type="button" class="icon-btn" data-action="add-sub" title="Ajouter une sous-catégorie">${PLUS_ICON}</button>` : ''}
        <button type="button" class="icon-btn" data-action="edit" title="Modifier">${EDIT_ICON}</button>
        <button type="button" class="icon-btn" data-action="delete" title="Supprimer">${DELETE_ICON}</button>
      </div>
    </div>`;
}

async function renderCategoriesTab(container) {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const group = (type, label) => {
    const roots = categories.filter((c) => c.type === type && !c.parentId);
    const rows = roots.map((r) => categoryRowHtml(r) + categories.filter((c) => c.parentId === r.id).map((ch) => categoryRowHtml(ch, true)).join('')).join('');
    return `<div class="panel" style="margin-bottom:16px;"><div class="panel-header"><h3>${label}</h3></div>${rows || '<div class="empty-state">Aucune catégorie.</div>'}</div>`;
  };
  container.innerHTML = group('expense', 'Catégories de dépenses') + group('income', 'Catégories de recettes');

  container.addEventListener('click', async function handler(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !container.contains(btn)) return;
    const row = e.target.closest('[data-category-id]');
    const categories2 = await dbGetAll(STORES.CATEGORIES);
    const cat = categories2.find((c) => c.id === row.dataset.categoryId);
    if (!cat) return;

    if (btn.dataset.action === 'add-sub') {
      openCategoryModal(null, cat.id, cat.type);
    } else if (btn.dataset.action === 'edit') {
      openCategoryModal(cat);
    } else if (btn.dataset.action === 'delete') {
      const hasChildren = categories2.some((c) => c.parentId === cat.id);
      if (hasChildren) { showToast('Supprimez d\'abord les sous-catégories.'); return; }
      const ok = await confirmDialog(`Supprimer la catégorie "${cat.name}" ? Les transactions déjà enregistrées resteront mais afficheront "Sans catégorie".`, { danger: true, confirmText: 'Supprimer' });
      if (ok) {
        await dbDelete(STORES.CATEGORIES, cat.id);
        await logAudit({ entityType: 'category', entityId: cat.id, action: 'delete', before: cat });
        showToast('Catégorie supprimée.');
        notifyDataChanged('categories');
      }
    }
  });
}

/* ==========================================================================
   Onglet 3 — Récurrences & échéancier
   ========================================================================== */
function recurringFormHtml(r) {
  return `
    <form id="recurring-form">
      <div class="segmented" data-field="type">
        <button type="button" class="segmented-btn ${(!r || r.type === 'expense') ? 'is-active' : ''}" data-value="expense">Dépense</button>
        <button type="button" class="segmented-btn ${r?.type === 'income' ? 'is-active' : ''}" data-value="income">Recette</button>
      </div>
      <input type="hidden" name="type" value="${r?.type || 'expense'}">
      <div class="form-row"><label>Nom</label><input type="text" name="name" required maxlength="60" value="${escapeHtml(r?.name || '')}" placeholder="Ex: Loyer, Netflix, Salaire…"></div>
      <div class="form-row"><label>Montant</label><input type="number" step="0.01" min="0" name="amount" required value="${r?.amount ?? ''}"></div>
      <div class="form-row"><label>Portefeuille</label><select name="walletId" required></select></div>
      <div class="form-row" data-field="categoryRow"><label>Catégorie</label><select name="categoryId"></select></div>
      <div class="form-row"><label>Fréquence</label>
        <select name="frequency">
          <option value="monthly" ${(!r || r.frequency === 'monthly') ? 'selected' : ''}>Mensuelle</option>
          <option value="weekly" ${r?.frequency === 'weekly' ? 'selected' : ''}>Hebdomadaire</option>
          <option value="yearly" ${r?.frequency === 'yearly' ? 'selected' : ''}>Annuelle</option>
        </select>
      </div>
      <div class="form-row"><label>Prochaine échéance</label><input type="date" name="nextDate" required value="${r?.nextDate || todayISO()}"></div>
      <button type="submit" class="btn btn-primary btn-block">${r ? 'Enregistrer' : 'Créer la récurrence'}</button>
    </form>`;
}

function openRecurringModal(r = null) {
  const modal = openModal(recurringFormHtml(r), { title: r ? 'Modifier la récurrence' : 'Nouvelle récurrence' });
  const form = modal.el.querySelector('#recurring-form');
  const typeHidden = form.elements.type;
  const walletSelect = form.elements.walletId;
  const categorySelect = form.elements.categoryId;
  let currentType = r?.type || 'expense';

  async function populate() {
    const wallets = (await dbGetAll(STORES.WALLETS)).filter((w) => !w.archived);
    walletSelect.innerHTML = wallets.map((w) => `<option value="${w.id}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('') || '<option value="">Créez un portefeuille d\'abord</option>';
    if (r?.walletId) walletSelect.value = r.walletId;

    const categories = await dbGetAll(STORES.CATEGORIES);
    const roots = categories.filter((c) => c.type === currentType && !c.parentId);
    categorySelect.innerHTML = roots.map((root) => {
      const children = categories.filter((c) => c.parentId === root.id).map((ch) => `<option value="${ch.id}">— ${escapeHtml(ch.name)}</option>`).join('');
      return `<option value="${root.id}">${escapeHtml(root.name)}</option>${children}`;
    }).join('') || '<option value="">Aucune catégorie</option>';
    if (r?.categoryId) categorySelect.value = r.categoryId;
  }

  modal.el.querySelectorAll('.segmented-btn').forEach((b) => b.addEventListener('click', () => {
    currentType = b.dataset.value;
    typeHidden.value = currentType;
    modal.el.querySelectorAll('.segmented-btn').forEach((x) => x.classList.toggle('is-active', x === b));
    populate();
  }));

  populate();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    if (!fd.get('walletId')) { showToast('Créez au moins un portefeuille avant d\'ajouter une récurrence.'); return; }
    const before = r ? { ...r } : null;
    const record = {
      id: r?.id || uuid(),
      type: currentType,
      name: fd.get('name').trim(),
      amount: parseFloat(fd.get('amount')) || 0,
      walletId: fd.get('walletId'),
      categoryId: fd.get('categoryId') || null,
      frequency: fd.get('frequency'),
      nextDate: fd.get('nextDate'),
      active: r?.active ?? true,
    };
    await dbPut(STORES.RECURRING, record);
    await logAudit({ entityType: 'recurring', entityId: record.id, action: r ? 'update' : 'create', before, after: record });
    modal.close();
    showToast(r ? 'Récurrence mise à jour.' : 'Récurrence créée.');
    notifyDataChanged('recurring');
  });
}

function recurringRowHtml(r, wallets, categories) {
  const wallet = wallets.find((w) => w.id === r.walletId);
  const cat = categories.find((c) => c.id === r.categoryId);
  return `
    <div class="tx-row" data-recurring-id="${r.id}">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(r.name)} ${!r.active ? '<span class="badge">Inactif</span>' : ''}</div>
        <div class="tx-sub">${escapeHtml(wallet?.name || '—')} · ${escapeHtml(cat?.name || 'Sans catégorie')} · ${FREQ_LABELS[r.frequency]} · Prochaine échéance : ${formatDate(r.nextDate)}</div>
      </div>
      <div class="tx-amount amount ${r.type === 'income' ? 'pos' : 'neg'}">${r.type === 'income' ? '+' : '−'}${formatCurrency(r.amount, wallet?.currency || 'EUR')}</div>
      <div class="card-actions">
        <button type="button" class="icon-btn" data-action="toggle" title="${r.active ? 'Désactiver' : 'Activer'}">${r.active ? PAUSE_ICON : PLAY_ICON}</button>
        <button type="button" class="icon-btn" data-action="edit" title="Modifier">${EDIT_ICON}</button>
        <button type="button" class="icon-btn" data-action="delete" title="Supprimer">${DELETE_ICON}</button>
      </div>
    </div>`;
}

async function renderRecurringTab(container) {
  const [recurring, wallets, categories] = await Promise.all([dbGetAll(STORES.RECURRING), dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES)]);
  const sorted = [...recurring].sort((a, b) => (a.nextDate || '').localeCompare(b.nextDate || ''));

  container.innerHTML = `
    <div class="view-header" style="margin-bottom:10px;">
      <h2 style="font-size:15px;">Dépenses &amp; recettes récurrentes</h2>
      <button type="button" class="btn btn-primary" id="recurring-add-btn">+ Nouvelle récurrence</button>
    </div>
    <div class="panel">
      ${sorted.length ? sorted.map((r) => recurringRowHtml(r, wallets, categories)).join('') : '<div class="empty-state">Aucune récurrence. Ajoutez vos abonnements et factures régulières pour anticiper votre solde de fin de mois.</div>'}
    </div>`;

  container.querySelector('#recurring-add-btn').addEventListener('click', () => openRecurringModal());

  container.addEventListener('click', async function handler(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !container.contains(btn)) return;
    const row = e.target.closest('[data-recurring-id]');
    const all = await dbGetAll(STORES.RECURRING);
    const r = all.find((x) => x.id === row.dataset.recurringId);
    if (!r) return;

    if (btn.dataset.action === 'toggle') {
      const before = { ...r };
      r.active = !r.active;
      await dbPut(STORES.RECURRING, r);
      await logAudit({ entityType: 'recurring', entityId: r.id, action: 'update', before, after: r });
      renderRecurringTab(container);
    } else if (btn.dataset.action === 'edit') {
      openRecurringModal(r);
    } else if (btn.dataset.action === 'delete') {
      const ok = await confirmDialog(`Supprimer la récurrence "${r.name}" ? Les transactions déjà générées seront conservées.`, { danger: true, confirmText: 'Supprimer' });
      if (ok) {
        await dbDelete(STORES.RECURRING, r.id);
        await logAudit({ entityType: 'recurring', entityId: r.id, action: 'delete', before: r });
        showToast('Récurrence supprimée.');
        notifyDataChanged('recurring');
      }
    }
  });
}

/* ==========================================================================
   Génération automatique des transactions dues (appelée au démarrage)
   ========================================================================== */
function advanceDate(dateStr, frequency) {
  const [y, m, day] = dateStr.split('-').map(Number);
  const d = new Date(y, m - 1, day);
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return localISODate(d);
}

export async function generateDueRecurring() {
  const recurring = await dbGetAll(STORES.RECURRING);
  const todayStr = todayISO();
  let generated = false;

  for (const r of recurring) {
    if (!r.active || !r.nextDate) continue;
    let guard = 0;
    while (r.nextDate <= todayStr && guard < 60) {
      const tx = {
        id: uuid(), type: r.type, walletId: r.walletId, targetWalletId: null,
        categoryId: r.categoryId, amount: r.amount, date: r.nextDate,
        note: `Récurrence : ${r.name}`, reconciled: false, createdAt: new Date().toISOString(),
      };
      await dbAdd(STORES.TRANSACTIONS, tx);
      await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'create', after: tx, note: 'Générée automatiquement (récurrence)' });
      r.nextDate = advanceDate(r.nextDate, r.frequency);
      generated = true;
      guard++;
    }
    await dbPut(STORES.RECURRING, r);
  }
  if (generated) notifyDataChanged('transactions');
  return generated;
}

/* ==========================================================================
   Point d'entrée du module
   ========================================================================== */
export async function renderBudgets() {
  const content = document.getElementById('budgets-content');
  if (!content) return;
  content.innerHTML = `
    <div class="tabs-bar">
      <button type="button" class="tab-btn ${activeTab === 'monthly' ? 'is-active' : ''}" data-tab="monthly">Budgets du mois</button>
      <button type="button" class="tab-btn ${activeTab === 'categories' ? 'is-active' : ''}" data-tab="categories">Catégories</button>
      <button type="button" class="tab-btn ${activeTab === 'recurring' ? 'is-active' : ''}" data-tab="recurring">Récurrences &amp; Échéancier</button>
    </div>
    <div id="budgets-tab-content" style="margin-top:16px;"></div>`;

  content.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => { activeTab = b.dataset.tab; renderBudgets(); }));
  const tabContent = document.getElementById('budgets-tab-content');
  if (activeTab === 'monthly') await renderMonthlyTab(tabContent);
  else if (activeTab === 'categories') await renderCategoriesTab(tabContent);
  else await renderRecurringTab(tabContent);
}

export function initBudgetsModule() {
  document.getElementById('budget-add-btn')?.addEventListener('click', () => openCategoryModal());
}
