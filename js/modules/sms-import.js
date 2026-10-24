/* ==========================================================================
   Djignan Financial System — Import de SMS / notifications Mobile Money
   Coller un (ou plusieurs) SMS de confirmation Orange Money / Wave / MTN MoMo / Moov… :
   l'appli en tire montant, sens, contrepartie, frais et référence, puis propose les
   transactions correspondantes. Rien n'est enregistré sans validation (cases à cocher).

   Aucun accès aux SMS de l'appareil : l'utilisateur colle le texte (ou le partage vers
   l'appli, voir applyShareTarget() dans app.js). Aucune donnée ne quitte l'appareil.
   L'analyse elle-même est dans mobile-money-parser.js (module pur, testé hors navigateur).
   ========================================================================== */

import { STORES, dbGetAll, dbWriteBatch, logAudit } from '../db.js';
import { isDailyWallet, guessCategoryId, FEE_CATEGORY_VARIANTS } from '../ledger.js';
import { uuid, formatCurrency, formatDate, escapeHtml, todayISO, openModal, showToast, debounce } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { parseMobileMoneyMessages, currencyMatchesWallet } from '../mobile-money-parser.js';
import { t } from '../i18n.js';

/** Libellé de la transaction, construit à partir du message analysé (traduit à la création). */
export function buildSmsNote(msg) {
  const who = msg.counterparty || msg.phone || '';
  let base;
  switch (msg.kind) {
    case 'withdrawal': base = t('Retrait Mobile Money'); break;
    case 'deposit': base = t('Dépôt Mobile Money'); break;
    case 'airtime': base = t('Recharge / forfait'); break;
    case 'payment': base = who ? t('Paiement — {name}', { name: who }) : t('Paiement Mobile Money'); break;
    case 'transfer_in': base = who ? t('Reçu de {name}', { name: who }) : t('Argent reçu'); break;
    default: base = who ? t('Envoi à {name}', { name: who }) : t('Envoi Mobile Money');
  }
  return (msg.provider ? `${msg.provider} · ${base}` : base).slice(0, 140);
}

async function ensureFeeCategoryId() {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const existing = categories.find((c) => c.type === 'expense' && FEE_CATEGORY_VARIANTS.includes(c.name));
  if (existing) return existing.id;
  const record = { id: uuid(), name: t('Frais'), type: 'expense', parentId: null, createdAt: new Date().toISOString() };
  await dbWriteBatch([{ store: STORES.CATEGORIES, type: 'add', value: record }]);
  return record.id;
}

function categoryOptionsHtml(categories, selectedId) {
  const roots = categories.filter((c) => !c.parentId);
  const html = [];
  for (const r of roots) {
    html.push(`<option value="${escapeHtml(r.id)}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`);
    for (const child of categories.filter((c) => c.parentId === r.id)) {
      html.push(`<option value="${escapeHtml(child.id)}" ${child.id === selectedId ? 'selected' : ''}>— ${escapeHtml(child.name)}</option>`);
    }
  }
  return `<option value="">${t('Sans catégorie')}</option>${html.join('')}`;
}

/** Portefeuille proposé par défaut : celui dont le nom contient l'opérateur lu (« Orange Money »),
    sinon un portefeuille Mobile Money dans la bonne devise, sinon le premier compatible. */
function pickDefaultWallet(wallets, messages) {
  const first = messages[0];
  if (!first) return wallets[0] || null;
  const compatible = wallets.filter((w) => currencyMatchesWallet(first.currency, w.currency));
  const pool = compatible.length ? compatible : wallets;
  const byProvider = first.provider && pool.find((w) => w.name.toLowerCase().includes(first.provider.toLowerCase().split(' ')[0]));
  return byProvider || pool.find((w) => w.type === 'mobile_money') || pool[0] || null;
}

export async function openSmsImportModal({ text = '' } = {}) {
  const [allWallets, categories, existingTx] = await Promise.all([
    dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES), dbGetAll(STORES.TRANSACTIONS),
  ]);
  const wallets = allWallets.filter(isDailyWallet);
  const existingRefs = new Set(existingTx.map((x) => x.externalRef).filter(Boolean));
  const existingKeys = new Set(existingTx.map((x) => `${x.walletId}|${x.date}|${x.type}|${x.amount}`));

  const modal = openModal(`
    <p style="margin:0 0 10px;" class="fs-13 c-muted">${t("Collez ici un ou plusieurs SMS de confirmation (Orange Money, Wave, MTN MoMo, Moov…). Séparez-les par une ligne vide. Rien ne quitte votre appareil, et rien n'est enregistré sans votre validation.")}</p>
    <textarea id="sms-text" rows="5" style="width:100%;" placeholder="${escapeHtml(t('Ex : Vous avez envoyé 5 000 F à Moussa… Nouveau solde : 12 400 F'))}"></textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px;">
      <button type="button" class="btn btn-ghost" id="sms-paste-btn">${t('Coller depuis le presse-papiers')}</button>
    </div>
    <div id="sms-summary" class="fs-13 c-muted mb-8"></div>
    <div id="sms-results"></div>
    <div id="sms-footer" hidden>
      <div class="form-row"><label>${t('Portefeuille')}</label><select id="sms-wallet"></select></div>
      <label id="sms-fee-row" style="display:flex;align-items:center;gap:8px;margin:6px 0 12px;cursor:pointer;" hidden class="fs-14">
        <input type="checkbox" id="sms-fee-check" checked> ${t('Enregistrer aussi les frais comme dépense séparée')}
      </label>
      <button type="button" class="btn btn-primary btn-block" id="sms-import-btn">${t('Importer')}</button>
    </div>`, { title: t('Importer des SMS Mobile Money') });

  const el = (id) => modal.el.querySelector(id);
  const textArea = el('#sms-text');
  const resultsEl = el('#sms-results');
  const summaryEl = el('#sms-summary');
  const footerEl = el('#sms-footer');
  const walletSelect = el('#sms-wallet');
  const feeRow = el('#sms-fee-row');
  const feeCheck = el('#sms-fee-check');
  const importBtn = el('#sms-import-btn');

  let rows = []; // { msg, include, type, categoryId, targetWalletId, reverse, issue, duplicate }

  walletSelect.innerHTML = wallets.length
    ? wallets.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('')
    : `<option value="">${t("Créez un portefeuille d'abord")}</option>`;

  const walletById = () => wallets.find((w) => w.id === walletSelect.value) || null;
  const cashWalletFor = (wallet) => wallets.find((w) => w.type === 'cash' && w.id !== wallet?.id && w.currency === wallet?.currency) || null;

  /** Recalcule, pour le portefeuille choisi, ce qui est importable (devise, doublon, virement). */
  function evaluateRows() {
    const wallet = walletById();
    for (const row of rows) {
      const { msg } = row;
      row.issue = wallet && !currencyMatchesWallet(msg.currency, wallet.currency)
        ? t('Devise du SMS ({currency}) différente de celle du portefeuille', { currency: msg.currency === 'CFA' ? 'FCFA' : msg.currency })
        : null;
      const date = msg.date || todayISO();
      const keyType = row.type === 'transfer' ? 'transfer' : row.type;
      const walletForKey = row.reverse ? row.targetWalletId : wallet?.id;
      if (msg.reference && existingRefs.has(msg.reference)) row.duplicate = 'ref';
      else if (!msg.reference && existingKeys.has(`${walletForKey}|${date}|${keyType}|${msg.amount}`)) row.duplicate = 'key';
      else row.duplicate = null;
      if (row.issue) row.include = false;
    }
  }

  function applyDefaultsForWallet() {
    const wallet = walletById();
    for (const row of rows) {
      const { msg } = row;
      const cash = cashWalletFor(wallet);
      if (msg.kind === 'withdrawal' && cash) { row.type = 'transfer'; row.targetWalletId = cash.id; row.reverse = false; }
      else if (msg.kind === 'deposit' && cash) { row.type = 'transfer'; row.targetWalletId = cash.id; row.reverse = true; }
      else {
        row.type = msg.direction === 'in' ? 'income' : 'expense';
        row.targetWalletId = null;
        row.reverse = false;
      }
    }
  }

  function transferTargetOptions(row) {
    const wallet = walletById();
    return wallets
      .filter((w) => w.id !== wallet?.id && w.currency === wallet?.currency)
      .map((w) => `<option value="${escapeHtml(w.id)}" ${w.id === row.targetWalletId ? 'selected' : ''}>${escapeHtml(w.name)}</option>`)
      .join('');
  }

  function rowHtml(row, index) {
    const { msg } = row;
    const wallet = walletById();
    const cur = wallet?.currency || (msg.currency === 'CFA' ? 'XOF' : msg.currency);
    const typeOptions = ['expense', 'income', 'transfer']
      .map((v) => `<option value="${v}" ${row.type === v ? 'selected' : ''}>${t(v === 'expense' ? 'Dépense' : v === 'income' ? 'Recette' : 'Transfert')}</option>`).join('');
    const catList = categories.filter((c) => c.type === row.type);
    const badges = [
      row.issue ? `<span class="badge badge-neg">${escapeHtml(row.issue)}</span>` : '',
      row.duplicate === 'ref' ? `<span class="badge badge-warn">${t('Déjà importé')}</span>` : '',
      row.duplicate === 'key' ? `<span class="badge badge-warn">${t('Peut-être déjà enregistré')}</span>` : '',
      msg.direction == null ? `<span class="badge badge-warn">${t('Sens à vérifier')}</span>` : '',
    ].join(' ');
    return `
      <div class="sms-row" data-sms-index="${index}" style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;${row.issue ? 'opacity:.6;' : ''}">
        <label style="display:flex;gap:10px;align-items:flex-start;cursor:pointer;">
          <input type="checkbox" data-sms-check ${row.include ? 'checked' : ''} ${row.issue ? 'disabled' : ''} style="margin-top:4px;">
          <span style="flex:1;min-width:0;">
            <strong>${escapeHtml(formatCurrency(msg.amount, cur))}</strong>
            <span class="tx-sub"> · ${formatDate(msg.date || todayISO())}</span>
            <span style="display:block;overflow-wrap:anywhere;" class="fs-13">${escapeHtml(buildSmsNote(msg))}</span>
            ${msg.fee > 0 ? `<span class="tx-sub">${t('Frais : {amount}', { amount: formatCurrency(msg.fee, cur) })}</span>` : ''}
            ${badges ? `<span style="display:block;" class="mt-4">${badges}</span>` : ''}
          </span>
        </label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;" class="mt-8">
          <select data-sms-type aria-label="${escapeHtml(t('Type'))}">${typeOptions}</select>
          ${row.type === 'transfer'
            ? `<select data-sms-target aria-label="${escapeHtml(t('Vers le portefeuille'))}">${transferTargetOptions(row) || `<option value="">${t('Aucun autre portefeuille dans cette devise')}</option>`}</select>`
            : `<select data-sms-cat aria-label="${escapeHtml(t('Catégorie'))}">${categoryOptionsHtml(catList, row.categoryId)}</select>`}
        </div>
      </div>`;
  }

  function refreshFooter() {
    const included = rows.filter((r) => r.include && !r.issue);
    importBtn.textContent = t('Importer {count} opération(s)', { count: included.length });
    importBtn.disabled = included.length === 0;
    feeRow.hidden = !included.some((r) => r.msg.fee > 0);
  }

  function renderRows() {
    evaluateRows();
    resultsEl.innerHTML = rows.map(rowHtml).join('');
    refreshFooter();
  }

  async function analyze() {
    const { messages, unrecognized } = parseMobileMoneyMessages(textArea.value);
    rows = [];
    if (!messages.length) {
      resultsEl.innerHTML = '';
      footerEl.hidden = true;
      summaryEl.textContent = textArea.value.trim() ? t("Aucun montant reconnu dans ce texte. Vérifiez qu'il s'agit bien d'un SMS de confirmation.") : '';
      return;
    }
    const best = pickDefaultWallet(wallets, messages);
    if (best) walletSelect.value = best.id;
    rows = messages.map((msg) => ({ msg, include: true, type: 'expense', categoryId: '', targetWalletId: null, reverse: false, issue: null, duplicate: null }));
    applyDefaultsForWallet();
    // Catégorie proposée d'après l'historique (même mécanisme que la Saisie express).
    for (const row of rows) {
      if (row.type !== 'transfer') row.categoryId = (await guessCategoryId(buildSmsNote(row.msg), row.type)) || '';
    }
    evaluateRows();
    for (const row of rows) if (row.duplicate) row.include = false;
    footerEl.hidden = false;
    summaryEl.textContent = unrecognized
      ? t('{count} message(s) reconnu(s), {skipped} ignoré(s) (aucun montant trouvé).', { count: messages.length, skipped: unrecognized })
      : t('{count} message(s) reconnu(s).', { count: messages.length });
    renderRows();
  }

  const analyzeDebounced = debounce(() => analyze().catch((err) => console.warn('[SMS]', err)), 350);
  textArea.addEventListener('input', analyzeDebounced);

  el('#sms-paste-btn').addEventListener('click', async () => {
    try {
      textArea.value = await navigator.clipboard.readText();
      await analyze();
    } catch {
      showToast(t('Collez le texte dans le champ (appui long) : le navigateur refuse l’accès au presse-papiers.'));
    }
  });

  walletSelect.addEventListener('change', () => { applyDefaultsForWallet(); renderRows(); });

  resultsEl.addEventListener('change', async (e) => {
    const rowEl = e.target.closest('[data-sms-index]');
    if (!rowEl) return;
    const row = rows[Number(rowEl.dataset.smsIndex)];
    if (e.target.matches('[data-sms-check]')) row.include = e.target.checked;
    else if (e.target.matches('[data-sms-type]')) {
      row.type = e.target.value;
      row.reverse = row.type === 'transfer' ? row.reverse : false;
      if (row.type === 'transfer' && !row.targetWalletId) row.targetWalletId = cashWalletFor(walletById())?.id || wallets.find((w) => w.id !== walletSelect.value && w.currency === walletById()?.currency)?.id || null;
      if (row.type !== 'transfer') row.categoryId = (await guessCategoryId(buildSmsNote(row.msg), row.type)) || '';
      renderRows();
      return;
    } else if (e.target.matches('[data-sms-cat]')) row.categoryId = e.target.value;
    else if (e.target.matches('[data-sms-target]')) row.targetWalletId = e.target.value || null;
    refreshFooter();
  });

  importBtn.addEventListener('click', async () => {
    const wallet = walletById();
    if (!wallet) { showToast(t('Créez au moins un portefeuille avant de saisir une transaction.')); return; }
    const included = rows.filter((r) => r.include && !r.issue);
    if (!included.length) return;
    if (included.some((r) => r.type === 'transfer' && !r.targetWalletId)) {
      showToast(t('Choisissez le portefeuille de destination du transfert.'));
      return;
    }
    importBtn.disabled = true;
    const withFees = feeCheck.checked;
    const feeCategoryId = withFees && included.some((r) => r.msg.fee > 0) ? await ensureFeeCategoryId() : null;
    const now = new Date().toISOString();
    const operations = [];
    const audits = [];
    for (const row of included) {
      const { msg } = row;
      const date = msg.date || todayISO();
      const note = buildSmsNote(msg);
      const isTransfer = row.type === 'transfer';
      const record = {
        id: uuid(),
        type: row.type,
        walletId: isTransfer && row.reverse ? row.targetWalletId : wallet.id,
        targetWalletId: isTransfer ? (row.reverse ? wallet.id : row.targetWalletId) : null,
        categoryId: isTransfer ? null : (row.categoryId || null),
        amount: msg.amount,
        date, note,
        tags: ['sms'],
        reconciled: false,
        externalRef: msg.reference || null,
        provider: msg.provider || null,
        createdAt: now,
      };
      operations.push({ store: STORES.TRANSACTIONS, type: 'add', value: record });
      audits.push(record);
      if (withFees && msg.fee > 0) {
        const feeRecord = {
          id: uuid(), type: 'expense', walletId: wallet.id, targetWalletId: null, categoryId: feeCategoryId,
          amount: msg.fee, date, note: t('Frais — {note}', { note }).slice(0, 140), tags: ['sms'],
          reconciled: false, externalRef: msg.reference ? `${msg.reference}#frais` : null, mmFee: true, provider: msg.provider || null, createdAt: now,
        };
        operations.push({ store: STORES.TRANSACTIONS, type: 'add', value: feeRecord });
        audits.push(feeRecord);
      }
    }
    // Une seule transaction IndexedDB : tout ou rien (voir dbWriteBatch, db.js).
    await dbWriteBatch(operations);
    for (const record of audits) {
      await logAudit({ entityType: 'transaction', entityId: record.id, action: 'create', after: record, note: t('Import SMS Mobile Money') });
    }
    modal.close();
    showToast(t('{count} transaction(s) importée(s).', { count: audits.length }));
    notifyDataChanged('transactions');
  });

  if (text) {
    textArea.value = text;
    await analyze();
  }
}

export function initSmsImport() {
  document.getElementById('transaction-sms-btn')?.addEventListener('click', () => openSmsImportModal());
}
