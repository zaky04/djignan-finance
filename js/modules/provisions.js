/* ==========================================================================
   Djignan Financial System — Provisions pour événements (Tabaski, rentrée scolaire, fêtes, cérémonies…)
   Une dépense annuelle PRÉVISIBLE ne doit pas surprendre : on la découpe en mensualités et on met l'argent de côté
   avant. Une provision s'appuie sur le mode enveloppe qui existe déjà :
   - une catégorie de dépense en mode enveloppe (créée au besoin, ou reprise si elle porte déjà ce nom) ;
   - un budget mensuel = objectif ÷ nombre de mois restants, du mois courant JUSQU'AU MOIS DE L'ÉVÉNEMENT inclus ;
   - le report d'enveloppe (computeEnvelopeCarryover) accumule donc ce qui n'est pas dépensé : le jour J, il reste
     exactement l'objectif à dépenser dans cette catégorie.
   Comme ces budgets comptent dans le « reste à vivre », l'argent provisionné y est déjà réservé.
   Les provisions elles-mêmes (nom, objectif, mois) sont un petit réglage local ; les calculs sont purs et testés.
   ========================================================================== */

import { STORES, dbGetAll, dbWriteBatch, getSetting, setSetting, logAudit } from '../db.js';
import { computeEnvelopeCarryover } from '../ledger.js';
import { uuid, formatCurrency, escapeHtml, openModal, confirmDialog, showToast, currentMonthKey, monthKeyOffset, safeNumber, intlLocale, ZERO_DECIMAL_CURRENCIES } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { t } from '../i18n.js';
import { categoryLook, icon as svgIcon, CATEGORY_ICON_KEYS } from '../icons.js';

const CATEGORY_ICONS = Object.fromEntries(CATEGORY_ICON_KEYS.map((k) => [k, svgIcon(k, 18)]));

const SETTING_KEY = 'eventProvisions';

/** Événements proposés : le mois est une suggestion (la Tabaski et la Korité se déplacent d'une dizaine de jours
    chaque année) que l'utilisateur ajuste. `icon`/`color` : apparence de la catégorie créée. */
export const PROVISION_PRESETS = [
  { key: 'tabaski', name: 'Tabaski', month: 5, floating: true, icon: 'gift', color: '#b9663a' },
  { key: 'korite', name: 'Korité', month: 3, floating: true, icon: 'gift', color: '#2d8a7a' },
  { key: 'school', name: 'Rentrée scolaire', month: 9, floating: false, icon: 'education', color: '#1f5fa6' },
  { key: 'holidays', name: 'Fêtes de fin d\'année', month: 12, floating: false, icon: 'gift', color: '#c9a24a' },
  { key: 'ceremony', name: 'Cérémonie (mariage, baptême, deuil…)', month: null, floating: false, icon: 'fun', color: '#6a5f9e' },
  { key: 'other', name: 'Autre événement', month: null, floating: false, icon: 'coins', color: '#4f8a3c' },
];

/* ---------- Calculs purs ---------- */

/** Clé du mois (AAAA-MM) de la prochaine occurrence d'un événement tombant au mois `eventMonth` (1-12) :
    ce mois-ci ou plus tard, jamais dans le passé. */
export function nextEventMonthKey(eventMonth, fromMonthKey = currentMonthKey()) {
  const [y, m] = fromMonthKey.split('-').map(Number);
  const year = eventMonth >= m ? y : y + 1;
  return `${year}-${String(eventMonth).padStart(2, '0')}`;
}

/** Nombre de mois entre deux clés AAAA-MM, bornes incluses (≥ 1 si to ≥ from, sinon 0). */
export function monthsInclusive(fromKey, toKey) {
  const [fy, fm] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

/** Mensualité à mettre de côté : ce qu'il reste à réunir, réparti sur les mois restants, arrondi AU-DESSUS à la
    précision de la devise (on préfère un peu trop que pas assez : l'objectif est atteint pile à l'événement). */
export function monthlyContribution(remainingNeeded, monthsLeft, decimals = 2) {
  if (!(remainingNeeded > 0) || !(monthsLeft > 0)) return 0;
  const f = Math.pow(10, decimals);
  return Math.ceil((remainingNeeded / monthsLeft) * f - 1e-9) / f;
}

/** Où en est une provision : mis de côté, reste à réunir, retard éventuel. `available` = report d'enveloppe
    cumulé jusqu'à AUJOURD'HUI inclus (mensualités versées − dépenses faites dans la catégorie). */
export function provisionStatus({ target, available, monthly, monthsElapsed, monthsTotal, eventMonthKey }, today = currentMonthKey()) {
  const saved = Math.max(0, available);
  const expectedSoFar = Math.min(target, monthly * monthsElapsed);
  const behindBy = Math.max(0, expectedSoFar - available);
  return {
    saved,
    progress: target > 0 ? Math.min(1, saved / target) : 0,
    remaining: Math.max(0, target - saved),
    behindBy: behindBy > 0.005 ? behindBy : 0,
    monthsLeft: Math.max(0, monthsTotal - monthsElapsed),
    isPast: today > eventMonthKey,
  };
}

/* ---------- Données ---------- */
export async function loadProvisions() {
  const list = await getSetting(SETTING_KEY, []);
  return Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string') : [];
}
async function saveProvisions(list) { await setSetting(SETTING_KEY, list); }

async function ensureProvisionCategory(name, look) {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const existing = categories.find((c) => c.type === 'expense' && c.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (existing.envelopeMode) return { category: existing, ops: [] };
    return { category: { ...existing, envelopeMode: true }, ops: [{ store: STORES.CATEGORIES, type: 'put', value: { ...existing, envelopeMode: true } }] };
  }
  const category = { id: uuid(), name, type: 'expense', parentId: null, icon: look.icon, color: look.color, envelopeMode: true, createdAt: new Date().toISOString() };
  return { category, ops: [{ store: STORES.CATEGORIES, type: 'add', value: category }] };
}

/** Écrit (ou réécrit) les budgets mensuels d'une provision du mois courant jusqu'au mois de l'événement. Les mois
    déjà passés ne sont jamais touchés. Renvoie le nombre de mois et la mensualité. */
async function writeProvisionBudgets(prov, decimals) {
  const from = currentMonthKey();
  const last = prov.eventMonthKey;
  const months = monthsInclusive(from, last);
  if (!months) return { months: 0, monthly: 0 };
  // Ce qui est déjà réuni AVANT ce mois (report d'enveloppe) vient en déduction : modifier une provision en cours
  // de route ne repart pas de zéro.
  const alreadySaved = Math.max(0, await computeEnvelopeCarryover(prov.categoryId, from));
  const monthly = monthlyContribution(prov.targetAmount - alreadySaved, months, decimals);
  const all = await dbGetAll(STORES.BUDGETS);
  const ops = [];
  for (let i = 0; i < months; i++) {
    const month = monthKeyOffset(from, i);
    const existing = all.find((b) => b.categoryId === prov.categoryId && b.month === month);
    if (monthly > 0) ops.push({ store: STORES.BUDGETS, type: 'put', value: existing ? { ...existing, limit: monthly } : { id: uuid(), categoryId: prov.categoryId, month, limit: monthly } });
    else if (existing) ops.push({ store: STORES.BUDGETS, type: 'delete', value: existing.id });
  }
  if (ops.length) await dbWriteBatch(ops);
  return { months, monthly };
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(), { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}
function monthName(m) {
  return new Intl.DateTimeFormat(intlLocale(), { month: 'long' }).format(new Date(2026, m - 1, 1));
}

/* ---------- Fenêtre de création / modification ---------- */
async function openProvisionModal(prov = null, baseCurrency) {
  const decimals = ZERO_DECIMAL_CURRENCIES.has(baseCurrency) ? 0 : 2;
  const monthOptions = (selected) => Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${selected === i + 1 ? 'selected' : ''}>${escapeHtml(monthName(i + 1))}</option>`).join('');
  const modal = openModal(`
    <form id="provision-form">
      ${prov ? '' : `<div class="form-row"><label>${t('Événement')}</label>
        <div class="preset-chips">${PROVISION_PRESETS.map((p) => `<button type="button" class="link-chip preset-chip" data-preset="${p.key}">${escapeHtml(t(p.name))}</button>`).join('')}</div></div>`}
      <div class="form-row"><label>${t('Nom')}</label><input type="text" name="name" required maxlength="60" value="${escapeHtml(prov?.name || '')}" placeholder="${escapeHtml(t('Ex : Tabaski'))}"></div>
      <div class="form-row"><label>${t('Montant à prévoir ({currency})', { currency: escapeHtml(baseCurrency) })}</label><input type="number" name="target" required min="0" step="${decimals ? '0.01' : '1'}" value="${prov?.targetAmount ?? ''}"></div>
      <div class="form-row"><label>${t("Mois de l'événement")}</label><select name="month">${monthOptions(prov?.eventMonth ?? new Date().getMonth() + 1)}</select>
        <p class="fs-12 c-muted mt-6" id="provision-hint"></p></div>
      <p class="fs-13 c-muted" id="provision-preview"></p>
      <button type="submit" class="btn btn-primary btn-block">${prov ? t('Enregistrer') : t('Créer la provision')}</button>
    </form>`, { title: prov ? t('Modifier la provision') : t('Nouvelle provision') });

  const form = modal.el.querySelector('#provision-form');
  const previewEl = modal.el.querySelector('#provision-preview');
  const hintEl = modal.el.querySelector('#provision-hint');
  const refreshPreview = () => {
    const target = safeNumber(parseFloat(form.elements.target.value));
    const key = nextEventMonthKey(Number(form.elements.month.value));
    const months = monthsInclusive(currentMonthKey(), key);
    previewEl.textContent = target > 0
      ? t('À mettre de côté : {amount} par mois pendant {count} mois (jusqu\'en {month}).', { amount: formatCurrency(monthlyContribution(target, months, decimals), baseCurrency), count: months, month: monthLabel(key) })
      : '';
  };
  form.addEventListener('input', refreshPreview);
  modal.el.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
    const preset = PROVISION_PRESETS.find((p) => p.key === btn.dataset.preset);
    form.elements.name.value = t(preset.name);
    if (preset.month) form.elements.month.value = String(preset.month);
    hintEl.textContent = preset.floating ? t("Cette fête se déplace d'une dizaine de jours chaque année : vérifiez le mois.") : '';
    form.dataset.preset = preset.key;
    refreshPreview();
  }));
  refreshPreview();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    const target = safeNumber(parseFloat(form.elements.target.value));
    if (!name) return;
    if (!(target > 0)) { showToast(t('Saisissez un montant supérieur à 0.')); return; }
    const eventMonth = Number(form.elements.month.value);
    const eventMonthKey = nextEventMonthKey(eventMonth);
    const list = await loadProvisions();
    const preset = PROVISION_PRESETS.find((p) => p.key === form.dataset.preset);
    const look = { icon: preset?.icon || 'coins', color: preset?.color || '#4f8a3c' };

    let record;
    if (prov) {
      record = { ...prov, name, targetAmount: target, eventMonth, eventMonthKey };
    } else {
      const { category, ops } = await ensureProvisionCategory(name, look);
      if (ops.length) await dbWriteBatch(ops);
      record = { id: uuid(), name, categoryId: category.id, targetAmount: target, eventMonth, eventMonthKey, startMonthKey: currentMonthKey(), createdAt: new Date().toISOString() };
    }
    const { months, monthly } = await writeProvisionBudgets(record, decimals);
    await saveProvisions(prov ? list.map((p) => (p.id === prov.id ? record : p)) : [...list, record]);
    await logAudit({ entityType: 'provision', entityId: record.id, action: prov ? 'update' : 'create', before: prov, after: record });
    modal.close();
    showToast(t('Provision enregistrée : {amount} par mois pendant {count} mois.', { amount: formatCurrency(monthly, baseCurrency), count: months }));
    notifyDataChanged('budgets');
  });
}

/* ---------- Onglet « Provisions » ---------- */
export async function renderProvisionsTab(container) {
  const [list, categories, baseCurrency, budgets] = await Promise.all([loadProvisions(), dbGetAll(STORES.CATEGORIES), getSetting('baseCurrency', 'EUR'), dbGetAll(STORES.BUDGETS)]);
  const decimals = ZERO_DECIMAL_CURRENCIES.has(baseCurrency) ? 0 : 2;
  const today = currentMonthKey();
  const nextMonth = monthKeyOffset(today, 1);

  const cards = await Promise.all(list.map(async (prov) => {
    const category = categories.find((c) => c.id === prov.categoryId);
    const look = category ? categoryLook(category) : { icon: 'coins', color: '#4f8a3c' };
    const available = category ? await computeEnvelopeCarryover(prov.categoryId, nextMonth) : 0;
    const own = budgets.filter((b) => b.categoryId === prov.categoryId && b.month <= prov.eventMonthKey).sort((a, b) => a.month.localeCompare(b.month));
    const monthly = own.find((b) => b.month >= today)?.limit || own[own.length - 1]?.limit || 0;
    const monthsTotal = own.length || monthsInclusive(prov.startMonthKey || today, prov.eventMonthKey);
    const monthsElapsed = Math.min(monthsTotal, own.filter((b) => b.month <= today).length);
    const status = provisionStatus({ target: prov.targetAmount, available, monthly, monthsElapsed, monthsTotal, eventMonthKey: prov.eventMonthKey }, today);
    const monthsUntil = monthsInclusive(today, prov.eventMonthKey) - 1;
    const when = status.isPast ? t('Événement passé') : monthsUntil <= 0 ? t('Ce mois-ci') : t('dans {count} mois', { count: monthsUntil });
    return `
      <div class="summary-card" data-provision-id="${escapeHtml(prov.id)}">
        <div class="card-title-row">
          <div style="display:flex;align-items:center;gap:8px;" class="fw-700 fs-14">
            <span class="cat-dot" style="background:${look.color}22;color:${look.color};">${CATEGORY_ICONS[look.icon] || svgIcon('coins', 16)}</span>
            ${escapeHtml(prov.name)}
          </div>
          <div class="card-actions">
            ${status.isPast ? '' : `<button type="button" class="icon-btn" data-action="edit" aria-label="${t('Modifier')}" title="${t('Modifier')}">${svgIcon('edit', 16)}</button>`}
            <button type="button" class="icon-btn" data-action="delete" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${svgIcon('trash', 16)}</button>
          </div>
        </div>
        <div class="progress-track"><div class="progress-fill ${status.behindBy ? 'is-warn' : ''}" style="width:${(status.progress * 100).toFixed(0)}%"></div></div>
        <div class="stat-row"><span class="stat-row-label">${t('Mis de côté')}</span><span class="amount">${formatCurrency(status.saved, baseCurrency)} / ${formatCurrency(prov.targetAmount, baseCurrency)}</span></div>
        <div class="stat-row"><span class="stat-row-label">${t('Événement')}</span><span>${escapeHtml(monthLabel(prov.eventMonthKey))} · ${escapeHtml(when)}</span></div>
        ${monthly > 0 && !status.isPast ? `<div class="stat-row"><span class="stat-row-label">${t('Mensualité')}</span><span class="amount">${formatCurrency(monthly, baseCurrency)}</span></div>` : ''}
        ${status.behindBy ? `<p class="alert alert-warn mt-8">${t('En retard de {amount} : une partie a été dépensée avant l\'événement.', { amount: formatCurrency(status.behindBy, baseCurrency) })}</p>` : ''}
        ${status.isPast ? `<button type="button" class="btn btn-ghost btn-block mt-8" data-action="renew">${t("Reconduire pour l'an prochain")}</button>` : ''}
      </div>`;
  }));

  container.innerHTML = `
    <div class="view-header mb-10">
      <h2 class="fs-15">${t('Provisions pour événements')}</h2>
      <button type="button" class="btn btn-primary" id="provision-add-btn">${t('+ Nouvelle provision')}</button>
    </div>
    <p class="fs-13 c-muted mb-12">${t("Tabaski, rentrée scolaire, fêtes, cérémonies : une grosse dépense prévisible se prépare mois après mois. Djignan répartit l'objectif en mensualités (budgets en mode enveloppe) pour que l'argent soit là le jour J.")}</p>
    <div class="grid-cards">${cards.join('') || `<div class="empty-state">${t("Aucune provision. Créez-en une pour la Tabaski, la rentrée scolaire ou vos fêtes de fin d'année.")}</div>`}</div>`;

  container.querySelector('#provision-add-btn').onclick = () => openProvisionModal(null, baseCurrency);
  container.onclick = async (e) => {
    const btn = e.target.closest('[data-action]');
    const card = e.target.closest('[data-provision-id]');
    if (!btn || !card || !container.contains(btn)) return;
    const prov = list.find((p) => p.id === card.dataset.provisionId);
    if (!prov) return;
    if (btn.dataset.action === 'edit') { openProvisionModal(prov, baseCurrency); return; }
    if (btn.dataset.action === 'renew') {
      const eventMonthKey = nextEventMonthKey(prov.eventMonth);
      const record = { ...prov, eventMonthKey, startMonthKey: currentMonthKey() };
      const { months, monthly } = await writeProvisionBudgets(record, decimals);
      await saveProvisions(list.map((p) => (p.id === prov.id ? record : p)));
      showToast(t('Provision reconduite : {amount} par mois pendant {count} mois.', { amount: formatCurrency(monthly, baseCurrency), count: months }));
      notifyDataChanged('budgets');
      return;
    }
    if (btn.dataset.action === 'delete') {
      const ok = await confirmDialog(t('Supprimer la provision « {name} » ? Ses budgets à venir sont retirés ; la catégorie et vos dépenses restent.', { name: prov.name }), { danger: true, requirePin: true, confirmText: t('Supprimer') });
      if (!ok) return;
      const all = await dbGetAll(STORES.BUDGETS);
      const future = all.filter((b) => b.categoryId === prov.categoryId && b.month >= currentMonthKey() && b.month <= prov.eventMonthKey);
      if (future.length) await dbWriteBatch(future.map((b) => ({ store: STORES.BUDGETS, type: 'delete', value: b.id })));
      await saveProvisions(list.filter((p) => p.id !== prov.id));
      await logAudit({ entityType: 'provision', entityId: prov.id, action: 'delete', before: prov });
      showToast(t('Provision supprimée.'));
      notifyDataChanged('budgets');
    }
  };
}
