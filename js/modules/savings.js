/* ==========================================================================
   Djignan Financial System — Module Épargne
   Un objectif d'épargne est LIÉ à un ou plusieurs portefeuilles d'usage
   « Épargne » ou « Bloqué » (voir walletUsage, ledger.js) : l'argent épargné
   est de l'argent réel, dans ces portefeuilles, donc déjà compté dans le
   patrimoine net — l'objectif n'ajoute rien de plus (aucun double comptage).
   - UN portefeuille peut servir PLUSIEURS objectifs (une voiture ET une
     maison dans le même compte d'épargne) : chaque objectif a sa PART dans
     le portefeuille (computeSavingsAllocations, ledger.js) ; ce qui n'est
     affecté à aucun objectif actif est « libre ».
   - Progression = somme des parts de l'objectif dans ses portefeuilles liés.
   - Épargner = virement d'un portefeuille COURANT vers un portefeuille lié,
     étiqueté avec l'objectif (augmente SA part) ; récupérer = virement
     inverse, limité à sa part (refusé avant la date de déblocage d'un
     portefeuille bloqué). Les deux passent par la fiche du portefeuille
     (openWalletMoveModal, wallets.js) : ces portefeuilles n'apparaissent dans
     aucun écran du quotidien.
   Les anciens objectifs (suivi manuel, sans portefeuille) restent affichés
   avec leur ancien montant jusqu'à ce qu'on les lie à un portefeuille.
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbDelete, logAudit, getSetting } from '../db.js';
import { computeSavingsAllocations, walletUsage, withdrawalLockedUntil } from '../ledger.js';
import { uuid, formatCurrency, formatDate, escapeHtml, percentage, openModal, confirmDialog, showToast, currencySelectHtml, wireCurrencySelect, readCurrencyValue, safeNumber } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { openWalletMoveModal, openWalletModal } from './wallets.js';
import { t } from '../i18n.js';
import { icon as svgIcon } from '../icons.js';

const EDIT_ICON = svgIcon('edit', 16);
const DELETE_ICON = svgIcon('trash', 16);
const ARCHIVE_ICON = svgIcon('archive', 16);

function gaugeSvg(pct, color) {
  const r = 32, c = 2 * Math.PI * r;
  const offset = c - (Math.min(pct, 100) / 100) * c;
  return `
    <svg viewBox="0 0 80 80" width="72" height="72" style="transform:rotate(-90deg)">
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="var(--border)" stroke-width="8"/>
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}"/>
    </svg>`;
}

function goalCardHtml(g, progress) {
  const info = progress.get(g.id) || { linked: false, saved: g.currentAmount || 0, wallets: [] };
  const pct = percentage(info.saved, g.targetAmount);
  const color = pct >= 100 ? 'var(--pos)' : 'var(--accent)';
  const walletLines = info.wallets.map((w) => {
    const locked = w.usage === 'blocked' && withdrawalLockedUntil({ usage: w.usage, unlockDate: w.unlockDate });
    return `<div class="tx-sub">${escapeHtml(w.name)} : ${formatCurrency(w.allocated, g.currency)}${locked ? ` · ${t('bloqué jusqu\'au {date}', { date: formatDate(w.unlockDate) })}` : ''}</div>`;
  }).join('');
  return `
    <div class="summary-card" data-goal-id="${g.id}">
      <div style="display:flex;gap:14px;align-items:center;">
        <div style="position:relative;width:72px;height:72px;flex-shrink:0;">
          ${gaugeSvg(pct, color)}
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;" class="fs-13">${pct.toFixed(0)}%</div>
        </div>
        <div style="flex:1;min-width:0;">
          <div class="fw-700 fs-15">${escapeHtml(g.name)}${info.linked ? '' : ` <span class="badge badge-neg">${t('Non lié')}</span>`}</div>
          <div class="tx-sub amount" data-value="${info.saved}">${formatCurrency(info.saved, g.currency)} / ${formatCurrency(g.targetAmount, g.currency)}</div>
          ${g.targetDate ? `<div class="tx-sub">${t('Échéance : {date}', { date: formatDate(g.targetDate) })}</div>` : ''}
        </div>
      </div>
      ${walletLines ? `<div class="mt-10">${walletLines}</div>` : ''}
      ${info.linked ? '' : `<p style="margin:10px 0 0;" class="fs-13 c-muted">${t("Cet objectif est encore suivi à la main : liez-le à un portefeuille d'épargne pour qu'il reflète l'argent réel.")}</p>`}
      <div class="card-actions mt-10" style="justify-content:flex-end;flex-wrap:wrap;">
        ${info.linked
          ? `<button type="button" class="btn btn-ghost" data-action="deposit">${t('Épargner')}</button>
             <button type="button" class="btn btn-ghost" data-action="withdraw">${t('Récupérer')}</button>`
          : `<button type="button" class="btn btn-primary" data-action="edit">${t('Lier à un portefeuille')}</button>`}
        <button type="button" class="icon-btn" data-action="edit" aria-label="${t('Modifier')}" title="${t('Modifier')}">${EDIT_ICON}</button>
        <button type="button" class="icon-btn" data-action="archive" aria-label="${g.archived ? t('Désarchiver') : t('Archiver')}" title="${g.archived ? t('Désarchiver') : t('Archiver')}">${ARCHIVE_ICON}</button>
        <button type="button" class="icon-btn" data-action="delete" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${DELETE_ICON}</button>
      </div>
    </div>`;
}

function goalFormHtml(g, defaultCurrency) {
  return `
    <form id="goal-form">
      <div class="form-row"><label>${t("Nom de l'objectif")}</label><input type="text" name="name" required maxlength="60" value="${escapeHtml(g?.name || '')}" placeholder="${t("Ex: Fonds d'urgence, Voyage, Apport immobilier…")}"></div>
      <div class="form-row"><label>${t('Montant cible')}</label><input type="number" step="0.01" min="0" name="targetAmount" required value="${g?.targetAmount ?? ''}"></div>
      <div class="form-row"><label>${t('Devise')}</label>${currencySelectHtml(g?.currency || defaultCurrency)}</div>
      <div class="form-row"><label>${t('Date cible (optionnel)')}</label><input type="date" name="targetDate" value="${g?.targetDate || ''}"></div>
      <div class="form-row">
        <label>${t("Portefeuilles d'épargne liés")}</label>
        <div id="goal-wallet-choices"></div>
        <button type="button" class="btn btn-ghost mt-6" id="goal-create-wallet">${t("+ Créer un portefeuille d'épargne")}</button>
        <p style="margin:6px 0 0;" class="fs-12 c-muted">${t("L'argent épargné vit dans ces portefeuilles (usage Épargne ou Bloqué, même devise) et compte dans votre patrimoine. Un même portefeuille peut servir plusieurs objectifs : indiquez la part qui revient à celui-ci.")}</p>
      </div>
      ${g && !(g.walletIds || []).length && g.currentAmount ? `<p class="alert alert-warn mb-12">${t("L'ancien montant saisi à la main ({amount}) sera remplacé par le solde réel des portefeuilles liés.", { amount: formatCurrency(g.currentAmount, g.currency) })}</p>` : ''}
      <button type="submit" class="btn btn-primary btn-block">${g ? t('Enregistrer') : t("Créer l'objectif")}</button>
    </form>`;
}

export async function openGoalModal(g = null) {
  const defaultCurrency = g ? g.currency : await getSetting('baseCurrency', 'EUR');
  const modal = openModal(goalFormHtml(g, defaultCurrency), { title: g ? t("Modifier l'objectif") : t("Nouvel objectif d'épargne") });
  wireCurrencySelect(modal.el);
  const form = modal.el.querySelector('#goal-form');
  const choicesEl = modal.el.querySelector('#goal-wallet-choices');
  // Sélection et parts saisies, conservées si l'utilisateur change de devise ou revient d'une
  // création de portefeuille (le formulaire est re-rendu).
  const checked = new Set(g?.walletIds || []);
  const typedShares = new Map();
  // Parts actuelles de cet objectif (départ + versements − retraits) : on les réaffiche telles quelles
  // à l'édition, et on retrouve la partie « étiquetée » pour ne réécrire que le montant de départ.
  const currentShare = new Map();
  const baseShare = new Map(Object.entries(g?.allocations || {}).map(([id, v]) => [id, Number(v) || 0]));
  let allocation = null;

  async function renderWalletChoices() {
    choicesEl.querySelectorAll('[name="walletIds"]').forEach((cb) => { if (cb.checked) checked.add(cb.value); else checked.delete(cb.value); });
    choicesEl.querySelectorAll('[data-share-input]').forEach((input) => typedShares.set(input.dataset.shareInput, input.value));
    const currency = readCurrencyValue(form);
    const wallets = await dbGetAll(STORES.WALLETS);
    allocation = await computeSavingsAllocations();
    for (const w of allocation.goals.get(g?.id)?.wallets || []) currentShare.set(w.id, w.allocated);
    const eligible = wallets.filter((w) => !w.archived && walletUsage(w) !== 'current' && w.currency === currency);
    choicesEl.innerHTML = eligible.length
      ? eligible.map((w) => {
          const mine = g && !g.archived ? (currentShare.get(w.id) || 0) : 0;
          const free = Math.max(0, (allocation.wallets.get(w.id)?.free ?? 0) + mine);
          const isChecked = checked.has(w.id);
          const value = typedShares.has(w.id) ? typedShares.get(w.id) : String(currentShare.get(w.id) || 0);
          return `<div style="padding:6px 0;">
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;" class="fs-14">
              <input type="checkbox" name="walletIds" value="${w.id}" ${isChecked ? 'checked' : ''}>
              ${escapeHtml(w.name)} <span class="badge">${escapeHtml(t(walletUsage(w) === 'blocked' ? 'Bloqué' : 'Épargne'))}</span>
            </label>
            <div style="display:flex;align-items:center;gap:8px;margin:4px 0 0 28px;font-size:13px;color:var(--text-muted);" ${isChecked ? '' : 'hidden'} data-share-row="${w.id}">
              ${t('Part de cet objectif')} <input type="number" step="0.01" min="0" data-share-input="${w.id}" value="${escapeHtml(value)}" style="width:120px;padding:6px 8px;">
              <span>${t('Libre : {amount}', { amount: formatCurrency(free, currency) })}</span>
            </div>
          </div>`;
        }).join('')
      : `<p class="fs-13 c-muted m-0">${t("Aucun portefeuille d'épargne ou bloqué dans cette devise. Créez-en un ci-dessous.")}</p>`;
    choicesEl.querySelectorAll('[name="walletIds"]').forEach((cb) => cb.addEventListener('change', () => {
      choicesEl.querySelector(`[data-share-row="${cb.value}"]`).hidden = !cb.checked;
    }));
  }
  modal.el.querySelectorAll('[data-currency-select], [data-currency-other]').forEach((el) => {
    el.addEventListener('change', renderWalletChoices);
    el.addEventListener('input', renderWalletChoices);
  });
  await renderWalletChoices();

  modal.el.querySelector('#goal-create-wallet').addEventListener('click', () => {
    openWalletModal(null, { preset: { usage: 'savings', currency: readCurrencyValue(form) }, onDone: renderWalletChoices });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const walletIds = [...form.querySelectorAll('[name="walletIds"]:checked')].map((cb) => cb.value);
    if (!walletIds.length) { showToast(t("Liez au moins un portefeuille d'épargne ou bloqué.")); return; }

    // Part de l'objectif dans chaque portefeuille lié. Ce qui est saisi est la part TOTALE voulue ; on
    // n'enregistre que le montant de DÉPART (part − versements/retraits déjà étiquetés), le reste étant
    // recalculé depuis les virements (computeSavingsAllocations). Plafonnée à ce qui est libre dans le
    // portefeuille (+ la part actuelle de cet objectif) : on ne peut pas s'attribuer l'argent d'un autre.
    const allocations = {};
    const wallets = await dbGetAll(STORES.WALLETS);
    for (const id of walletIds) {
      const wanted = safeNumber(parseFloat(form.querySelector(`[data-share-input="${id}"]`)?.value));
      const mine = g && !g.archived ? (currentShare.get(id) || 0) : 0;
      const free = Math.max(0, (allocation.wallets.get(id)?.free ?? 0) + mine);
      if (wanted < 0 || wanted > free + 0.005) {
        const w = wallets.find((x) => x.id === id);
        showToast(t('Part trop élevée dans « {name} » : {amount} libre.', { name: w?.name || '', amount: formatCurrency(free, readCurrencyValue(form)) }));
        return;
      }
      const tagged = (currentShare.get(id) || 0) - (baseShare.get(id) || 0);
      allocations[id] = wanted - tagged;
    }

    const before = g ? { ...g } : null;
    const record = {
      id: g?.id || uuid(),
      name: fd.get('name').trim(),
      targetAmount: safeNumber(parseFloat(fd.get('targetAmount'))),
      // Ancien suivi manuel : une fois lié, la progression vient des portefeuilles (voir
      // computeSavingsAllocations, ledger.js) — on remet l'ancien montant à 0 plutôt que de le
      // laisser traîner dans l'enregistrement sans plus jamais être lu.
      currentAmount: 0,
      walletIds,
      allocations,
      currency: readCurrencyValue(e.target),
      targetDate: fd.get('targetDate') || null,
      archived: g?.archived || false,
      createdAt: g?.createdAt || new Date().toISOString(),
    };
    await dbPut(STORES.SAVINGS_GOALS, record);
    await logAudit({ entityType: 'savingsGoal', entityId: record.id, action: g ? 'update' : 'create', before, after: record });
    modal.close();
    showToast(g ? t('Objectif mis à jour.') : t('Objectif créé.'));
    notifyDataChanged('savings');
  });
}

/** Choisit un des portefeuilles liés quand l'objectif en a plusieurs (un seul → renvoyé tel quel). */
async function pickLinkedWallet(g, mode) {
  const wallets = (await dbGetAll(STORES.WALLETS)).filter((w) => (g.walletIds || []).includes(w.id));
  if (!wallets.length) return null;
  if (wallets.length === 1) return wallets[0];
  return new Promise((resolve) => {
    let done = false;
    const modal = openModal(`
      <p style="margin:0 0 12px;" class="fs-13 c-muted">${mode === 'deposit' ? t('Dans quel portefeuille épargner ?') : t('Depuis quel portefeuille récupérer ?')}</p>
      <div class="proof-actions" style="flex-direction:column;">${wallets.map((w) => `<button type="button" class="btn btn-ghost" data-pick="${w.id}">${escapeHtml(w.name)}</button>`).join('')}</div>`,
    { title: g.name, onClose: () => { if (!done) resolve(null); } });
    modal.el.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', () => {
      done = true;
      modal.close();
      resolve(wallets.find((w) => w.id === btn.dataset.pick));
    }));
  });
}

export async function renderSavings() {
  const container = document.getElementById('savings-content');
  if (!container) return;
  const [goals, allocation] = await Promise.all([dbGetAll(STORES.SAVINGS_GOALS), computeSavingsAllocations()]);
  const progress = allocation.goals;
  const active = goals.filter((g) => !g.archived);
  const archived = goals.filter((g) => g.archived);
  const card = (g) => goalCardHtml(g, progress);

  container.innerHTML = active.length || archived.length
    ? active.map(card).join('') + (archived.length ? `<div style="grid-column:1/-1;" class="fs-13 c-faint fw-700 mt-8">${t('ARCHIVÉS')}</div>${archived.map(card).join('')}` : '')
    : `<div class="empty-state">${t("Aucun objectif d'épargne. Créez-en un pour visualiser votre progression.")}</div>`;
}

export function initSavingsModule() {
  document.getElementById('savings-add-btn')?.addEventListener('click', () => openGoalModal());

  document.getElementById('savings-content')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('[data-goal-id]');
    const goals = await dbGetAll(STORES.SAVINGS_GOALS);
    const g = goals.find((x) => x.id === card?.dataset.goalId);
    if (!g) return;

    if (btn.dataset.action === 'deposit' || btn.dataset.action === 'withdraw') {
      const wallet = await pickLinkedWallet(g, btn.dataset.action);
      if (wallet) openWalletMoveModal(wallet, btn.dataset.action, { goal: g });
    } else if (btn.dataset.action === 'edit') {
      openGoalModal(g);
    } else if (btn.dataset.action === 'archive') {
      const before = { ...g };
      g.archived = !g.archived;
      await dbPut(STORES.SAVINGS_GOALS, g);
      await logAudit({ entityType: 'savingsGoal', entityId: g.id, action: 'update', before, after: g });
      showToast(g.archived ? t('Objectif archivé.') : t('Objectif désarchivé.'));
      notifyDataChanged('savings');
    } else if (btn.dataset.action === 'delete') {
      const ok = await confirmDialog(t('Supprimer définitivement l\'objectif "{name}" ? Les portefeuilles liés et l\'argent qu\'ils contiennent ne sont pas touchés.', { name: g.name }), { danger: true, requirePin: true, confirmText: t('Supprimer') });
      if (ok) {
        await dbDelete(STORES.SAVINGS_GOALS, g.id);
        await logAudit({ entityType: 'savingsGoal', entityId: g.id, action: 'delete', before: g });
        showToast(t('Objectif supprimé.'));
        notifyDataChanged('savings');
      }
    }
  });
}
