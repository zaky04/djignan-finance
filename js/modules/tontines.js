/* ==========================================================================
   Djignan Financial System — Tontines (module optionnel)
   Une tontine (« cotisation », « njangi », « osusu »…) : N personnes versent chacune le même montant à
   chaque tour, et à chaque tour une personne différente reçoit la totalité (le « pot »). Ici on ne
   MANIPULE aucun argent : l'appli tient le carnet — qui a payé ce tour, qui reçoit, quand — et
   enregistre dans un portefeuille ce que l'utilisateur lui-même verse et reçoit.

   Effet sur les comptes (voir ledger.js) : ses cotisations et son pot sont des transactions marquées
   tontineId/tontineMovement. Elles sont EXCLUES des dépenses et revenus (ce n'est que de l'argent mis
   de côté puis récupéré) et la position nette (versé − reçu) compte dans le patrimoine, sur la ligne
   « épargne ». Le solde du portefeuille reste, lui, exact au franc près.

   Pas de collecte ni de redistribution d'argent : aucune réglementation de microfinance n'est en jeu.
   La logique de calendrier (roundDate, currentRoundIndex…) est pure et testée hors navigateur.
   ========================================================================== */

import { STORES, dbGetAll, dbWriteBatch, logAudit, getSetting } from '../db.js';
import { isDailyWallet } from '../ledger.js';
import { uuid, formatCurrency, formatDate, escapeHtml, todayISO, localISODate, openModal, confirmDialog, showToast, safeNumber, currencySelectHtml, wireCurrencySelect, readCurrencyValue, openExternalUrl } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { whatsappUrl } from './person-ledger.js';
import { t as tr } from '../i18n.js';
import { icon as svgIcon } from '../icons.js';

/* ---------- Calendrier (pur) ---------- */
const PERIOD_DAYS = { weekly: 7, biweekly: 14 };

function parseDay(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Date (AAAA-MM-JJ) du tour `index` (0 = premier tour = date de départ). Mensuel : même jour du mois,
    ramené au dernier jour du mois quand il n'existe pas (le 31 → le 28/30). */
export function roundDate(tontine, index) {
  const start = parseDay(tontine.startDate);
  if (tontine.frequency === 'monthly') {
    const target = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(start.getDate(), lastDay));
    return localISODate(target);
  }
  const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + (PERIOD_DAYS[tontine.frequency] || 7) * index);
  return localISODate(date);
}

/** Tour en cours : le dernier dont la date est passée (0 si la tontine n'a pas encore commencé), au
    plus le dernier tour. */
export function currentRoundIndex(tontine, today = todayISO()) {
  const total = tontine.members.length;
  let index = 0;
  for (let i = 0; i < total; i++) if (roundDate(tontine, i) <= today) index = i;
  return index;
}

export function beneficiaryOf(tontine, index) {
  const memberId = tontine.order[index % tontine.order.length];
  return tontine.members.find((m) => m.id === memberId) || null;
}

export function potAmount(tontine) {
  return tontine.amount * tontine.members.length;
}

export function hasPaid(tontine, round, memberId) {
  return (tontine.payments || []).some((p) => p.round === round && p.memberId === memberId);
}

/** Ma position nette dans cette tontine (versé − reçu), pour l'affichage. */
export function myNetPosition(tontine) {
  const paid = (tontine.payments || []).filter((p) => p.txId).reduce((s, p) => s + p.amount, 0);
  const received = (tontine.pots || []).reduce((s, p) => s + p.amount, 0);
  return paid - received;
}

/** « Nom ; téléphone » par ligne → membres. Lignes vides ignorées, noms dédoublonnés sans tenir compte de la casse. */
export function parseMembersText(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const [rawName, rawPhone] = line.split(';');
    const name = (rawName || '').trim().slice(0, 40);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, phone: (rawPhone || '').trim().slice(0, 30) });
  }
  return out;
}

/* ---------- Catégorie « Tontine » ---------- */
const CATEGORY_VARIANTS = ['Tontine', 'Cotisation', 'Tontine / cotisation'];

async function ensureTontineCategoryId(type) {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const found = categories.find((c) => c.type === type && CATEGORY_VARIANTS.includes(c.name));
  if (found) return found.id;
  const record = { id: uuid(), name: tr('Tontine'), type, parentId: null, createdAt: new Date().toISOString() };
  await dbWriteBatch([{ store: STORES.CATEGORIES, type: 'add', value: record }]);
  return record.id;
}

/* ---------- Formulaire ---------- */
function frequencyLabel(freq) {
  return freq === 'monthly' ? tr('Mensuelle') : freq === 'biweekly' ? tr('Toutes les 2 semaines') : tr('Hebdomadaire');
}

async function openTontineForm(existing = null) {
  const baseCurrency = existing?.currency || await getSetting('baseCurrency', 'XOF');
  const wallets = (await dbGetAll(STORES.WALLETS)).filter(isDailyWallet);
  const me = existing?.members.find((m) => m.isMe);
  const others = existing ? existing.members.filter((m) => !m.isMe) : [];
  const myRank = existing ? existing.order.indexOf(me?.id) + 1 : 1;
  const othersText = existing
    ? existing.order.map((id) => existing.members.find((m) => m.id === id)).filter((m) => m && !m.isMe).map((m) => (m.phone ? `${m.name} ; ${m.phone}` : m.name)).join('\n')
    : '';
  const locked = !!existing && ((existing.payments || []).length || (existing.pots || []).length);

  const modal = openModal(`
    <form id="tontine-form">
      <div class="form-row"><label>${tr('Nom de la tontine')}</label><input type="text" name="name" required maxlength="50" value="${escapeHtml(existing?.name || '')}" placeholder="${escapeHtml(tr('Ex : Cotisation du quartier'))}"></div>
      <div class="form-row"><label>${tr('Montant par personne et par tour')}</label><input type="number" name="amount" min="0" step="0.01" required value="${existing?.amount ?? ''}" ${locked ? 'readonly' : ''}></div>
      <div class="form-row"><label>${tr('Devise')}</label>${locked ? `<input type="text" value="${escapeHtml(baseCurrency)}" readonly>` : currencySelectHtml(baseCurrency)}</div>
      <div class="form-row"><label>${tr('Fréquence')}</label>
        <select name="frequency">
          ${['weekly', 'biweekly', 'monthly'].map((f) => `<option value="${f}" ${(existing?.frequency || 'monthly') === f ? 'selected' : ''}>${frequencyLabel(f)}</option>`).join('')}
        </select></div>
      <div class="form-row"><label>${tr('Date du premier tour')}</label><input type="date" name="startDate" required value="${existing?.startDate || todayISO()}"></div>
      <div class="form-row"><label>${tr('Mon portefeuille (cotisations et pot)')}</label><select name="walletId" id="tontine-wallet"></select></div>
      <div class="form-row"><label>${tr('Les autres membres, un par ligne, dans leur ordre de passage (nom ; téléphone facultatif)')}</label>
        <textarea name="others" rows="5" ${locked ? 'readonly' : ''} placeholder="Awa ; +225 07 00 00 00 00&#10;Moussa&#10;Mariam">${escapeHtml(othersText)}</textarea></div>
      <div class="form-row"><label>${tr('Mon rang dans l\'ordre de passage')}</label><input type="number" name="rank" min="1" step="1" value="${myRank}" ${locked ? 'readonly' : ''}></div>
      ${locked ? `<p class="tx-sub">${tr('Des paiements sont déjà enregistrés : le montant, la devise et les membres ne sont plus modifiables.')}</p>` : ''}
      <button type="submit" class="btn btn-primary btn-block">${existing ? tr('Enregistrer') : tr('Créer')}</button>
    </form>`, { title: existing ? tr('Modifier la tontine') : tr('Nouvelle tontine') });

  const form = modal.el.querySelector('#tontine-form');
  if (!locked) wireCurrencySelect(modal.el);
  const walletSelect = form.querySelector('#tontine-wallet');
  const refreshWallets = () => {
    const currency = locked ? baseCurrency : readCurrencyValue(form);
    const matching = wallets.filter((w) => w.currency === currency);
    walletSelect.innerHTML = matching.length
      ? matching.map((w) => `<option value="${w.id}" ${w.id === existing?.walletId ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('')
      : `<option value="">${tr('Aucun portefeuille en {currency}', { currency })}</option>`;
  };
  refreshWallets();
  modal.el.querySelectorAll('[data-currency-select], [data-currency-other]').forEach((el) => { el.addEventListener('change', refreshWallets); el.addEventListener('input', refreshWallets); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const amount = safeNumber(parseFloat(fd.get('amount')));
    if (!(amount > 0)) { showToast(tr('Saisissez un montant supérieur à 0.')); return; }
    const currency = locked ? baseCurrency : readCurrencyValue(form);

    let members; let order;
    if (locked) {
      members = existing.members; order = existing.order;
    } else {
      const others = parseMembersText(fd.get('others'));
      if (!others.length) { showToast(tr('Ajoutez au moins un autre membre.')); return; }
      const meMember = { id: me?.id || uuid(), name: tr('Moi'), phone: '', isMe: true };
      const otherMembers = others.map((o, i) => {
        const prior = existing?.members.find((m) => !m.isMe && m.name.toLowerCase() === o.name.toLowerCase());
        return { id: prior?.id || uuid(), name: o.name, phone: o.phone, isMe: false };
      });
      const rank = Math.min(Math.max(1, Math.round(safeNumber(parseInt(fd.get('rank'), 10), 1))), otherMembers.length + 1);
      const ordered = [...otherMembers];
      ordered.splice(rank - 1, 0, meMember);
      members = ordered; order = ordered.map((m) => m.id);
    }
    const record = {
      id: existing?.id || uuid(), name: fd.get('name').trim().slice(0, 50), currency, amount,
      frequency: fd.get('frequency'), startDate: fd.get('startDate') || todayISO(),
      walletId: walletSelect.value || null, members, order,
      payments: existing?.payments || [], pots: existing?.pots || [],
      createdAt: existing?.createdAt || new Date().toISOString(),
    };
    await dbWriteBatch([{ store: STORES.TONTINES, type: 'put', value: record }]);
    await logAudit({ entityType: 'tontine', entityId: record.id, action: existing ? 'update' : 'create', before: existing, after: record });
    modal.close();
    showToast(existing ? tr('Mis à jour.') : tr('Créé.'));
    notifyDataChanged('tontines');
  });
}

/* ---------- Fiche d'un tour ---------- */
async function openTontineDetail(tontineId, roundIndex = null) {
  const tontine = (await dbGetAll(STORES.TONTINES)).find((x) => x.id === tontineId);
  if (!tontine) return;
  const total = tontine.members.length;
  const round = Math.min(Math.max(0, roundIndex ?? currentRoundIndex(tontine)), total - 1);
  const beneficiary = beneficiaryOf(tontine, round);
  const cur = tontine.currency;
  const potReceived = (tontine.pots || []).find((p) => p.round === round);
  const profile = await getSetting('userProfile', {});

  const memberRows = tontine.order.map((id) => tontine.members.find((m) => m.id === id)).filter(Boolean).map((m) => {
    const paid = hasPaid(tontine, round, m.id);
    const isBeneficiary = beneficiary?.id === m.id;
    const remind = !paid && !m.isMe && !isBeneficiary
      ? `<button type="button" class="btn btn-ghost" data-remind="${m.id}">${tr('Relancer')}</button>` : '';
    return `<div class="tx-row">
      <div class="tx-main"><div class="tx-title">${escapeHtml(m.isMe ? tr('Moi') : m.name)}${isBeneficiary ? ` <span class="badge badge-pos">${tr('Reçoit le pot')}</span>` : ''}</div>
        <div class="tx-sub">${paid ? tr('A cotisé') : tr('N\'a pas encore cotisé')}</div></div>
      ${remind}
      <button type="button" class="btn ${paid ? 'btn-ghost' : 'btn-primary'}" data-toggle-paid="${m.id}">${paid ? svgIcon('check', 16) + ' ' + tr('Payé') : tr('Marquer payé')}</button>
    </div>`;
  }).join('');

  const modal = openModal(`
    <div style="display:flex;align-items:center;justify-content:center;gap:8px;" class="mb-6">
      <button type="button" class="icon-btn" id="tontine-prev" aria-label="${tr('Tour précédent')}" ${round <= 0 ? 'disabled' : ''}>‹</button>
      <strong>${tr('Tour {n} / {total}', { n: round + 1, total })}</strong>
      <button type="button" class="icon-btn" id="tontine-next" aria-label="${tr('Tour suivant')}" ${round >= total - 1 ? 'disabled' : ''}>›</button>
    </div>
    <p class="tx-sub ta-center" style="margin:0 0 12px;">${formatDate(roundDate(tontine, round))} · ${tr('Pot : {amount}', { amount: formatCurrency(potAmount(tontine), cur) })} · ${tr('bénéficiaire : {name}', { name: escapeHtml(beneficiary?.isMe ? tr('Moi') : beneficiary?.name || '—') })}</p>
    ${beneficiary?.isMe ? (potReceived
      ? `<p class="alert alert-info">${tr('Pot reçu le {date} : {amount}', { date: formatDate(potReceived.date), amount: formatCurrency(potReceived.amount, cur) })}</p>`
      : `<button type="button" class="btn btn-primary btn-block mb-12" id="tontine-pot-btn">${tr("J'ai reçu le pot")}</button>`) : ''}
    ${memberRows}
    <p class="tx-sub mt-12">${tr('Ma position : {amount} (versé moins reçu).', { amount: formatCurrency(myNetPosition(tontine), cur) })}</p>`,
  { title: tontine.name });

  const reopen = (r) => { modal.close(); openTontineDetail(tontineId, r); };
  modal.el.querySelector('#tontine-prev').addEventListener('click', () => reopen(round - 1));
  modal.el.querySelector('#tontine-next').addEventListener('click', () => reopen(round + 1));

  modal.el.querySelectorAll('[data-toggle-paid]').forEach((btn) => btn.addEventListener('click', async () => {
    const member = tontine.members.find((m) => m.id === btn.dataset.togglePaid);
    btn.disabled = true;
    try {
      await togglePayment(tontine, round, member);
      modal.close();
      notifyDataChanged('tontines');
      openTontineDetail(tontineId, round);
    } catch (err) {
      btn.disabled = false;
      showToast(err.message || tr('Opération impossible.'));
    }
  }));

  modal.el.querySelectorAll('[data-remind]').forEach((btn) => btn.addEventListener('click', () => {
    const member = tontine.members.find((m) => m.id === btn.dataset.remind);
    const sender = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    const message = tr('Bonjour {name}, petit rappel pour la tontine « {tontine} » : la cotisation du tour {n} ({amount}) n\'est pas encore reçue. Merci !', {
      name: member.name, tontine: tontine.name, n: round + 1, amount: formatCurrency(tontine.amount, cur),
    }) + (sender ? `\n— ${sender}` : '');
    openExternalUrl(whatsappUrl(member.phone, message));
  }));

  modal.el.querySelector('#tontine-pot-btn')?.addEventListener('click', async () => {
    modal.close();
    openPotForm(tontine, round);
  });
}

/** Coche / décoche la cotisation d'un membre pour un tour. Pour MOI, crée / supprime la transaction. */
async function togglePayment(tontine, round, member) {
  const payments = [...(tontine.payments || [])];
  const existingIndex = payments.findIndex((p) => p.round === round && p.memberId === member.id);
  const operations = [];
  if (existingIndex >= 0) {
    const [removed] = payments.splice(existingIndex, 1);
    if (removed.txId) operations.push({ store: STORES.TRANSACTIONS, type: 'delete', value: removed.txId });
  } else {
    const payment = { id: uuid(), round, memberId: member.id, date: todayISO(), amount: tontine.amount, txId: null };
    if (member.isMe) {
      const wallet = (await dbGetAll(STORES.WALLETS)).find((w) => w.id === tontine.walletId);
      if (!wallet || !isDailyWallet(wallet) || wallet.currency !== tontine.currency) {
        throw new Error(tr('Choisissez un portefeuille valide pour cette tontine (Modifier).'));
      }
      const tx = {
        id: uuid(), type: 'expense', walletId: wallet.id, targetWalletId: null,
        categoryId: await ensureTontineCategoryId('expense'), amount: tontine.amount, date: payment.date,
        note: tr('Tontine {name} — tour {n}', { name: tontine.name, n: round + 1 }).slice(0, 140), tags: [], reconciled: false,
        tontineId: tontine.id, tontineMovement: 'contribution', tontineRound: round, createdAt: new Date().toISOString(),
      };
      payment.txId = tx.id;
      operations.push({ store: STORES.TRANSACTIONS, type: 'add', value: tx });
    }
    payments.push(payment);
  }
  operations.push({ store: STORES.TONTINES, type: 'put', value: { ...tontine, payments } });
  await dbWriteBatch(operations);
}

function openPotForm(tontine, round) {
  const modal = openModal(`
    <form id="pot-form">
      <div class="form-row"><label>${tr('Montant reçu')}</label><input type="number" name="amount" min="0" step="0.01" required value="${potAmount(tontine)}"></div>
      <div class="form-row"><label>${tr('Date')}</label><input type="date" name="date" value="${todayISO()}" required></div>
      <button type="submit" class="btn btn-primary btn-block">${tr('Enregistrer')}</button>
    </form>`, { title: tr('Pot reçu — tour {n}', { n: round + 1 }) });
  modal.el.querySelector('#pot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const amount = safeNumber(parseFloat(fd.get('amount')));
    if (!(amount > 0)) { showToast(tr('Saisissez un montant supérieur à 0.')); return; }
    const wallet = (await dbGetAll(STORES.WALLETS)).find((w) => w.id === tontine.walletId);
    if (!wallet || !isDailyWallet(wallet) || wallet.currency !== tontine.currency) {
      showToast(tr('Choisissez un portefeuille valide pour cette tontine (Modifier).'));
      return;
    }
    const tx = {
      id: uuid(), type: 'income', walletId: wallet.id, targetWalletId: null,
      categoryId: await ensureTontineCategoryId('income'), amount, date: fd.get('date'),
      note: tr('Pot de la tontine {name} — tour {n}', { name: tontine.name, n: round + 1 }).slice(0, 140), tags: [], reconciled: false,
      tontineId: tontine.id, tontineMovement: 'pot', tontineRound: round, createdAt: new Date().toISOString(),
    };
    const pots = [...(tontine.pots || []), { id: uuid(), round, date: tx.date, amount, txId: tx.id }];
    await dbWriteBatch([
      { store: STORES.TRANSACTIONS, type: 'add', value: tx },
      { store: STORES.TONTINES, type: 'put', value: { ...tontine, pots } },
    ]);
    await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'create', after: tx, note: tr('Pot de tontine') });
    modal.close();
    showToast(tr('Pot enregistré.'));
    notifyDataChanged('tontines');
  });
}

/* ---------- Écran ---------- */
function cardHtml(tontine) {
  const total = tontine.members.length;
  const round = currentRoundIndex(tontine);
  const beneficiary = beneficiaryOf(tontine, round);
  const paidCount = tontine.members.filter((m) => hasPaid(tontine, round, m.id)).length;
  const cur = tontine.currency;
  const mePaid = hasPaid(tontine, round, tontine.members.find((m) => m.isMe)?.id);
  return `
    <div class="summary-card" data-tontine-id="${tontine.id}">
      <div class="card-title-row">
        <div>
          <div class="fw-700 fs-15">${escapeHtml(tontine.name)}</div>
          <div class="tx-sub">${frequencyLabel(tontine.frequency)} · ${formatCurrency(tontine.amount, cur)} × ${total}</div>
        </div>
        <div class="card-actions">
          <button type="button" class="icon-btn" data-action="edit" aria-label="${tr('Modifier')}" title="${tr('Modifier')}">✎</button>
          <button type="button" class="icon-btn" data-action="delete" aria-label="${tr('Supprimer')}" title="${tr('Supprimer')}">🗑</button>
        </div>
      </div>
      <div class="stat-row"><span class="stat-row-label">${tr('Tour en cours')}</span><span>${round + 1} / ${total} · ${formatDate(roundDate(tontine, round))}</span></div>
      <div class="stat-row"><span class="stat-row-label">${tr('Bénéficiaire')}</span><span>${escapeHtml(beneficiary?.isMe ? tr('Moi') : beneficiary?.name || '—')}</span></div>
      <div class="stat-row"><span class="stat-row-label">${tr('Pot')}</span><span>${formatCurrency(potAmount(tontine), cur)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${tr('Cotisations de ce tour')}</span><span>${paidCount} / ${total}${mePaid ? '' : ' · ' + tr('la mienne : à verser')}</span></div>
      <button type="button" class="btn btn-primary btn-block mt-10" data-action="open">${tr('Ouvrir le tour')}</button>
    </div>`;
}

export async function renderTontines() {
  const container = document.getElementById('tontines-content');
  if (!container) return;
  const tontines = await dbGetAll(STORES.TONTINES);
  container.innerHTML = tontines.length
    ? `<div class="grid-cards">${tontines.map(cardHtml).join('')}</div>`
    : `<div class="empty-state">${tr("Aucune tontine. Créez-en une pour suivre qui cotise et qui reçoit à chaque tour.")}</div>`;
}

export function initTontinesModule() {
  document.getElementById('tontine-add-btn')?.addEventListener('click', () => openTontineForm());
  document.getElementById('tontines-content')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    const card = e.target.closest('[data-tontine-id]');
    if (!btn || !card) return;
    const tontine = (await dbGetAll(STORES.TONTINES)).find((x) => x.id === card.dataset.tontineId);
    if (!tontine) return;
    if (btn.dataset.action === 'open') openTontineDetail(tontine.id);
    else if (btn.dataset.action === 'edit') openTontineForm(tontine);
    else if (btn.dataset.action === 'delete') {
      const linked = (await dbGetAll(STORES.TRANSACTIONS)).filter((x) => x.tontineId === tontine.id);
      const ok = await confirmDialog(
        linked.length
          ? tr('Supprimer « {name} » et les {count} opération(s) enregistrées dans vos portefeuilles ?', { name: tontine.name, count: linked.length })
          : tr('Supprimer « {name} » ?', { name: tontine.name }),
        { danger: true, requirePin: true, confirmText: tr('Supprimer') },
      );
      if (!ok) return;
      await dbWriteBatch([
        ...linked.map((x) => ({ store: STORES.TRANSACTIONS, type: 'delete', value: x.id })),
        { store: STORES.TONTINES, type: 'delete', value: tontine.id },
      ]);
      await logAudit({ entityType: 'tontine', entityId: tontine.id, action: 'delete', before: tontine });
      showToast(tr('Supprimé.'));
      notifyDataChanged('all');
    }
  });
}
