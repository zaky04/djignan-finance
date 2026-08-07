/* ==========================================================================
   GeoFinance System — Module Budgets, Catégories & Récurrences
   Trois onglets : Budgets du mois (plafonds + alertes 70/90%), Catégories
   (arborescence éditable), Récurrences & Échéancier (abonnements/factures
   avec génération automatique des transactions dues et prévision de solde
   de fin de mois).
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbAdd, dbDelete, logAudit, getSetting } from '../db.js';
import { computeCategoryActuals, computeEndOfMonthForecast, computeEnvelopeCarryover, computeAnnualCategoryActuals } from '../ledger.js';
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

const CATEGORY_ICONS = {
  tag: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M21.4 12.6 12.6 21.4a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1 0-2.8L11.4 2.6A2 2 0 0 1 12.8 2H20a2 2 0 0 1 2 2v7.2a2 2 0 0 1-.6 1.4ZM16 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>',
  cart: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 4h14l-1.6 8.6a2 2 0 0 1-2 1.6H8.9a2 2 0 0 1-2-1.6L5.4 3.4 3 3V1h3a1 1 0 0 1 1 .8L7 4Zm1 16a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>',
  home: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2 2 10.5V22h6v-7h8v7h6V10.5L12 2Z"/></svg>',
  car: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M5 11 6.6 6.2A2 2 0 0 1 8.5 5h7a2 2 0 0 1 1.9 1.2L19 11h1a1 1 0 0 1 1 1v6h-2a2 2 0 1 1-4 0H9a2 2 0 1 1-4 0H3v-6a1 1 0 0 1 1-1h1Zm3-1h8l-1-3H9L8 10Z"/></svg>',
  health: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 21S3 14.9 3 8.5A5.5 5.5 0 0 1 12 5a5.5 5.5 0 0 1 9 3.5C21 14.9 12 21 12 21Z"/></svg>',
  food: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 2v8a2 2 0 0 0 2 2v10h2V12a2 2 0 0 0 2-2V2H8v7H7V2H6Zm11 0c-2 0-3 3-3 6v3h2v11h2V2Z"/></svg>',
  travel: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2.5 1.8V22l3.5-1 3.5 1v-1.2L13 19v-5.5l8 2.5Z"/></svg>',
  education: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 2 1 8l11 6 9-4.9V17h2V8L12 2ZM5 13.2V18c0 2 3.1 4 7 4s7-2 7-4v-4.8l-7 3.8-7-3.8Z"/></svg>',
  fun: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 4h10a4 4 0 0 1 4 4v3a6 6 0 0 1-5 5.9V19h2v2H6v-2h2v-2.1A6 6 0 0 1 3 11V8a4 4 0 0 1 4-4Zm2 5.5A1.5 1.5 0 1 0 9 12a1.5 1.5 0 0 0 0-2.5Zm6 0a1.5 1.5 0 1 0 0 2.5 1.5 1.5 0 0 0 0-2.5Z"/></svg>',
  salary: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 7h18v12H3V7Zm2 2v8h14V9H5Zm7 1a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM3 4h18v2H3V4Z"/></svg>',
  gift: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 7h-2.2a3 3 0 0 0-5.8-1.8A3 3 0 0 0 6.2 7H4a1 1 0 0 0-1 1v3h18V8a1 1 0 0 0-1-1ZM3 12v9a1 1 0 0 0 1 1h7v-10H3Zm10 0v10h7a1 1 0 0 0 1-1v-9h-8Z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 4v12h10V6H7Zm5 13.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"/></svg>',
};
const CATEGORY_COLORS = ['#4f5bff', '#16a34a', '#f59e0b', '#e11d48', '#7c3aed', '#0891b2', '#84cc16', '#ea580c', '#64748b', '#db2777'];
const DEFAULT_CATEGORY_ICON = 'tag';
const DEFAULT_CATEGORY_COLOR = CATEGORY_COLORS[0];

let activeTab = 'monthly';
let monthKey = currentMonthKey();

/* ==========================================================================
   Onglet 1 — Budgets du mois
   ========================================================================== */
function budgetCategoryCardHtml(cat, actual, limit, currency, carryover = null) {
  const effectiveLimit = carryover != null ? Math.max(0, (limit || 0) + carryover) : limit;
  const pct = effectiveLimit ? percentage(actual, effectiveLimit) : 0;
  const cls = budgetProgressClass(pct);
  const color = cat.color || DEFAULT_CATEGORY_COLOR;
  const icon = CATEGORY_ICONS[cat.icon] || CATEGORY_ICONS[DEFAULT_CATEGORY_ICON];
  const carryLabel = carryover != null
    ? `<div style="font-size:11.5px;color:${carryover >= 0 ? 'var(--pos)' : 'var(--neg)'};margin-top:4px;">Enveloppe : ${carryover >= 0 ? '+' : ''}${formatCurrency(carryover, currency)} reporté du mois dernier${limit ? ` · budget effectif ${formatCurrency(effectiveLimit, currency)}` : ''}</div>`
    : '';
  return `
    <div class="summary-card" style="${cat.parentId ? 'margin-left:16px;' : ''}">
      <div class="card-title-row">
        <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:14px;">
          <span style="display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:${color}22;color:${color};flex-shrink:0;">${icon}</span>
          ${cat.parentId ? '— ' : ''}${escapeHtml(cat.name)}${cat.envelopeMode ? ' <span class="badge badge-accent" style="margin-left:4px;">Enveloppe</span>' : ''}
        </div>
        <input type="number" min="0" step="0.01" data-limit-input="${cat.id}" value="${limit || ''}" placeholder="Budget"
          style="width:100px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-alt);text-align:right;">
      </div>
      <div class="progress-track"><div class="progress-fill ${cls}" style="width:${Math.min(pct, 100)}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;color:var(--text-muted);margin-top:6px;">
        <span>${formatCurrency(actual, currency)}</span>
        <span>${effectiveLimit ? formatPercent(pct, 0) : 'Pas de limite'}</span>
      </div>
      ${carryLabel}
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
  const prevMonthKey = monthKeyOffset(monthKey, -1);
  const prevMonthBudgets = allBudgets.filter((b) => b.month === prevMonthKey && b.limit > 0);
  const canCopyPrevious = monthBudgets.length === 0 && prevMonthBudgets.length > 0;
  const categories = await dbGetAll(STORES.CATEGORIES);
  const roots = categories.filter((c) => c.type === 'expense' && !c.parentId);

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px;margin-bottom:14px;">
      <button type="button" class="icon-btn" id="bud-prev-month" aria-label="Mois précédent">‹</button>
      <strong style="min-width:130px;text-align:center;display:inline-block;">${formatMonthLabel(monthKey)}</strong>
      <button type="button" class="icon-btn" id="bud-next-month" aria-label="Mois suivant">›</button>
      ${canCopyPrevious ? '<button type="button" class="btn btn-ghost" id="bud-copy-prev" style="margin-left:auto;">Reprendre les budgets du mois dernier</button>' : ''}
    </div>
    <div class="hero-card" style="margin-bottom:18px;">
      <div class="hero-card-label">Solde prévisionnel de fin de mois</div>
      <div class="hero-card-value"><span class="amount" data-value="${forecast.projected}">${formatCurrency(forecast.projected, forecast.currency)}</span></div>
      <div class="hero-card-trend">Solde actuel : ${formatCurrency(forecast.current, forecast.currency)}${forecast.upcoming.length ? ` · ${forecast.upcoming.length} échéance(s) à venir ce mois-ci` : ''}</div>
    </div>
    <div class="grid-cards" id="budget-categories-grid"></div>`;

  const grid = container.querySelector('#budget-categories-grid');
  const orderedCats = [];
  for (const root of roots) {
    orderedCats.push(root);
    orderedCats.push(...categories.filter((c) => c.parentId === root.id));
  }
  const cards = await Promise.all(orderedCats.map(async (cat) => {
    const actual = actuals.find((a) => a.categoryId === cat.id)?.actual || 0;
    const carryover = cat.envelopeMode ? await computeEnvelopeCarryover(cat.id, monthKey) : null;
    return budgetCategoryCardHtml(cat, actual, budgetByCategory[cat.id]?.limit, forecast.currency, carryover);
  }));
  grid.innerHTML = cards.join('') || '<div class="empty-state">Aucune catégorie de dépense. Créez-en dans l\'onglet Catégories.</div>';

  container.querySelector('#bud-prev-month').onclick = () => { monthKey = monthKeyOffset(monthKey, -1); renderMonthlyTab(container); };
  container.querySelector('#bud-next-month').onclick = () => { monthKey = monthKeyOffset(monthKey, 1); renderMonthlyTab(container); };
  container.querySelector('#bud-copy-prev')?.addEventListener('click', async () => {
    for (const b of prevMonthBudgets) {
      await dbPut(STORES.BUDGETS, { id: uuid(), categoryId: b.categoryId, month: monthKey, limit: b.limit });
    }
    showToast(`${prevMonthBudgets.length} budget(s) repris du mois dernier.`);
    notifyDataChanged('budgets');
  });

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
   Onglet 1bis — Budgets annuels (postes planifiés à l'année plutôt qu'au mois)
   ========================================================================== */
let annualYear = new Date().getFullYear();

async function renderAnnualTab(container) {
  const [actuals, allBudgets, categories, currency] = await Promise.all([
    computeAnnualCategoryActuals(annualYear, 'expense'),
    dbGetAll(STORES.BUDGETS),
    dbGetAll(STORES.CATEGORIES),
    getSetting('baseCurrency', 'EUR'),
  ]);
  const yearKey = String(annualYear);
  const yearBudgets = allBudgets.filter((b) => b.period === 'annual' && b.month === yearKey);
  const budgetByCategory = Object.fromEntries(yearBudgets.map((b) => [b.categoryId, b]));
  const roots = categories.filter((c) => c.type === 'expense' && !c.parentId);
  const totalBudget = yearBudgets.reduce((s, b) => s + (b.limit || 0), 0);
  const totalActual = actuals.filter((a) => budgetByCategory[a.categoryId]).reduce((s, a) => s + a.actual, 0);

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:4px;margin-bottom:14px;">
      <button type="button" class="icon-btn" id="bud-prev-year" aria-label="Année précédente">‹</button>
      <strong style="min-width:80px;text-align:center;display:inline-block;">${annualYear}</strong>
      <button type="button" class="icon-btn" id="bud-next-year" aria-label="Année suivante">›</button>
    </div>
    ${yearBudgets.length ? `<p style="font-size:12.5px;color:var(--text-muted);margin-bottom:14px;">${formatCurrency(totalActual, currency)} dépensé sur ${formatPercent(totalBudget ? percentage(totalActual, totalBudget) : 0, 0)} du budget annuel total attribué (${formatCurrency(totalBudget, currency)}).</p>` : ''}
    <div class="grid-cards" id="budget-annual-grid"></div>`;

  const grid = container.querySelector('#budget-annual-grid');
  const orderedCats = [];
  for (const root of roots) {
    orderedCats.push(root);
    orderedCats.push(...categories.filter((c) => c.parentId === root.id));
  }
  const cards = orderedCats.map((cat) => {
    const actual = actuals.find((a) => a.categoryId === cat.id)?.actual || 0;
    return budgetCategoryCardHtml(cat, actual, budgetByCategory[cat.id]?.limit, currency);
  });
  grid.innerHTML = cards.join('') || '<div class="empty-state">Aucune catégorie de dépense. Créez-en dans l\'onglet Catégories.</div>';

  container.querySelector('#bud-prev-year').onclick = () => { annualYear -= 1; renderAnnualTab(container); };
  container.querySelector('#bud-next-year').onclick = () => { annualYear += 1; renderAnnualTab(container); };

  grid.querySelectorAll('[data-limit-input]').forEach((input) => {
    input.addEventListener('change', async () => {
      const categoryId = input.dataset.limitInput;
      const limit = parseFloat(input.value) || 0;
      const existing = yearBudgets.find((b) => b.categoryId === categoryId);
      const record = existing ? { ...existing, limit } : { id: uuid(), categoryId, month: yearKey, period: 'annual', limit };
      await dbPut(STORES.BUDGETS, record);
      showToast('Budget annuel mis à jour.');
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
      <div class="form-row">
        <label>Icône</label>
        <div class="icon-picker">
          ${Object.entries(CATEGORY_ICONS).map(([key, svg]) => `
            <button type="button" class="icon-picker-btn ${(category?.icon || DEFAULT_CATEGORY_ICON) === key ? 'is-active' : ''}" data-icon="${key}">${svg}</button>
          `).join('')}
        </div>
        <input type="hidden" name="icon" value="${category?.icon || DEFAULT_CATEGORY_ICON}">
      </div>
      <div class="form-row">
        <label>Couleur</label>
        <div class="color-picker">
          ${CATEGORY_COLORS.map((c) => `<button type="button" class="color-picker-btn ${(category?.color || DEFAULT_CATEGORY_COLOR) === c ? 'is-active' : ''}" data-color="${c}" style="background:${c};"></button>`).join('')}
        </div>
        <input type="hidden" name="color" value="${category?.color || DEFAULT_CATEGORY_COLOR}">
      </div>
      <div data-field="envelopeRow" ${type !== 'expense' ? 'hidden' : ''}>
        <label style="display:flex;align-items:center;gap:10px;padding:8px 0 14px;font-size:13.5px;cursor:pointer;">
          <input type="checkbox" name="envelopeMode" ${category?.envelopeMode ? 'checked' : ''}>
          Mode enveloppe : reporter le solde non dépensé (ou le dépassement) sur le mois suivant
        </label>
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
  const envelopeRow = modal.el.querySelector('[data-field="envelopeRow"]');

  if (typeSelect && parentSelect) {
    populateParentSelect(parentSelect, typeSelect.value, category?.id);
    typeSelect.addEventListener('change', () => {
      populateParentSelect(parentSelect, typeSelect.value, category?.id);
      if (envelopeRow) envelopeRow.hidden = typeSelect.value !== 'expense';
    });
    if (category?.parentId) parentSelect.value = category.parentId;
  }

  modal.el.querySelectorAll('.icon-picker-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      form.elements.icon.value = btn.dataset.icon;
      modal.el.querySelectorAll('.icon-picker-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });
  modal.el.querySelectorAll('.color-picker-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      form.elements.color.value = btn.dataset.color;
      modal.el.querySelectorAll('.color-picker-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const before = category ? { ...category } : null;
    const record = {
      id: category?.id || uuid(),
      name: fd.get('name').trim(),
      type: fd.get('type'),
      parentId: fd.get('parentId') || null,
      icon: fd.get('icon') || DEFAULT_CATEGORY_ICON,
      color: fd.get('color') || DEFAULT_CATEGORY_COLOR,
      envelopeMode: fd.get('type') === 'expense' && fd.get('envelopeMode') === 'on',
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
  const color = cat.color || DEFAULT_CATEGORY_COLOR;
  const icon = CATEGORY_ICONS[cat.icon] || CATEGORY_ICONS[DEFAULT_CATEGORY_ICON];
  return `
    <div class="tx-row" data-category-id="${cat.id}" style="${isChild ? 'padding-left:24px;' : ''}">
      <div class="tx-icon" style="color:${color};background:${color}22;">${icon}</div>
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
   Onglet — Règles de catégorisation automatique
   Une règle : si la note d'une transaction contient ce texte, la catégorie
   est présélectionnée automatiquement en Saisie express (voir transactions.js).
   ========================================================================== */
function ruleRowHtml(rule, categories) {
  const cat = categories.find((c) => c.id === rule.categoryId);
  return `
    <div class="tx-row" data-rule-id="${rule.id}">
      <div class="tx-main">
        <div class="tx-title">« ${escapeHtml(rule.pattern)} »</div>
        <div class="tx-sub">→ ${escapeHtml(cat?.name || 'Catégorie supprimée')}</div>
      </div>
      <div class="card-actions">
        <button type="button" class="icon-btn" data-action="delete" title="Supprimer">${DELETE_ICON}</button>
      </div>
    </div>`;
}

async function renderRulesTab(container) {
  const [rules, categories] = await Promise.all([dbGetAll(STORES.CATEGORIZATION_RULES), dbGetAll(STORES.CATEGORIES)]);
  const expenseCats = categories.filter((c) => c.type === 'expense');
  const catOptionsHtml = expenseCats.map((c) => `<option value="${c.id}">${c.parentId ? '— ' : ''}${escapeHtml(c.name)}</option>`).join('');

  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Nouvelle règle</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">Quand la note d'une dépense contient ce texte, la catégorie est présélectionnée automatiquement en Saisie express.</p>
      <form id="rule-form" class="filters-bar" style="align-items:flex-end;">
        <div class="form-row" style="margin:0;flex:1;min-width:160px;"><label>Texte à repérer</label><input type="text" name="pattern" required maxlength="60" placeholder="Ex: netflix"></div>
        <div class="form-row" style="margin:0;flex:1;min-width:160px;"><label>Catégorie</label><select name="categoryId" required>${catOptionsHtml}</select></div>
        <button type="submit" class="btn btn-primary">Ajouter</button>
      </form>
    </div>
    <div class="panel">
      <div class="panel-header"><h3>Règles actives</h3></div>
      ${rules.length ? rules.map((r) => ruleRowHtml(r, categories)).join('') : '<div class="empty-state">Aucune règle. Ajoutez-en une ci-dessus pour automatiser la catégorisation.</div>'}
    </div>`;

  container.querySelector('#rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const record = { id: uuid(), pattern: fd.get('pattern').trim().toLowerCase(), categoryId: fd.get('categoryId'), createdAt: new Date().toISOString() };
    if (!record.pattern) return;
    await dbAdd(STORES.CATEGORIZATION_RULES, record);
    showToast('Règle créée.');
    notifyDataChanged('categorizationRules');
    renderRulesTab(container);
  });

  container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ruleId = btn.closest('[data-rule-id]').dataset.ruleId;
      await dbDelete(STORES.CATEGORIZATION_RULES, ruleId);
      showToast('Règle supprimée.');
      notifyDataChanged('categorizationRules');
      renderRulesTab(container);
    });
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
      <button type="button" class="tab-btn ${activeTab === 'annual' ? 'is-active' : ''}" data-tab="annual">Budgets annuels</button>
      <button type="button" class="tab-btn ${activeTab === 'categories' ? 'is-active' : ''}" data-tab="categories">Catégories</button>
      <button type="button" class="tab-btn ${activeTab === 'recurring' ? 'is-active' : ''}" data-tab="recurring">Récurrences</button>
      <button type="button" class="tab-btn ${activeTab === 'rules' ? 'is-active' : ''}" data-tab="rules">Règles</button>
    </div>
    <div id="budgets-tab-content" style="margin-top:16px;"></div>`;

  content.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => { activeTab = b.dataset.tab; renderBudgets(); }));
  const tabContent = document.getElementById('budgets-tab-content');
  if (activeTab === 'monthly') await renderMonthlyTab(tabContent);
  else if (activeTab === 'annual') await renderAnnualTab(tabContent);
  else if (activeTab === 'categories') await renderCategoriesTab(tabContent);
  else if (activeTab === 'rules') await renderRulesTab(tabContent);
  else await renderRecurringTab(tabContent);
}

export function initBudgetsModule() {
  document.getElementById('budget-add-btn')?.addEventListener('click', () => openCategoryModal());
}
