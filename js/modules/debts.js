/* ==========================================================================
   Djignan Financial System — Module Dettes & Créances
   Suivi des remboursements + simulateur stratégique Avalanche / Boule de neige.
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbDelete, dbAdd, dbWriteBatch, logAudit, getSetting } from '../db.js';
import { getExchangeRates, computeDebtHistory, isDailyWallet } from '../ledger.js';
import { uuid, formatCurrency, formatDate, formatPercent, escapeHtml, todayISO, percentage, convertAmount, openModal, confirmDialog, showToast, currencySelectHtml, wireCurrencySelect, readCurrencyValue, safeNumber, ZERO_DECIMAL_CURRENCIES, onceSubmit, amountForOption } from '../utils.js';
import { buildSchedule, scheduleStatus, accruedInterest, roundTo } from '../loan-schedule.js';
import { notifyDataChanged } from '../state.js';
import { renderNetWorthTrendChart } from '../charts.js';
import { openProofExportModal, PRINT_ICON } from '../proof-export.js';
import { openDebtAcknowledgementModal } from '../debt-acknowledgement.js';
import { openPersonLedger, summarizePeople, openPersonReminder } from './person-ledger.js';
import { parseParticipants, participantsToText, participantStatuses } from '../shared-loan.js';
// Aliasé en tr (pas t) : ce fichier utilise `t` comme nom de variable pour une transaction dans
// initDebtsModule() (handler de suppression) — voir le même piège documenté dans dashboard.js/
// transactions.js.
import { t as tr } from '../i18n.js';
import { icon as svgIcon } from '../icons.js';

const EDIT_ICON = svgIcon('edit', 16);
const DELETE_ICON = svgIcon('trash', 16);
const PERSON_ICON = svgIcon('person', 16);
const PAY_ICON = svgIcon('pay', 16);
const REMIND_ICON = svgIcon('message', 16);
const SCHEDULE_ICON = svgIcon('history', 16);
const ACK_ICON = svgIcon('receipt', 16);
const CANCEL_ICON = svgIcon('close', 16);
const RESTORE_ICON = svgIcon('repay', 16);

const decimalsOf = (currency) => (ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2);

/** D'où est venu l'argent d'un remboursement (absent = un portefeuille, comme tous les anciens) : texte court, ou ''. */
function paymentSourceLabel(p) {
  if (p.source === 'direct') return p.sourceName ? tr('Revenu direct ({name})', { name: p.sourceName }) : tr('Revenu direct');
  if (p.source === 'third') return tr('Payé par {name}', { name: p.sourceName || '—' });
  return '';
}

/** Intérêts déjà payés sur une dette (somme des parts d'intérêts de ses remboursements). */
function interestPaidOf(debt, payments) {
  return payments.filter((p) => p.debtId === debt.id).reduce((s, p) => s + (Number(p.interestPart) || 0), 0);
}

/** Vue d'ensemble d'un prêt à intérêts : restant dû, intérêts courus depuis le dernier remboursement,
    échéancier (si une durée est renseignée) et son état au regard de ce qui a été versé. */
function loanSnapshot(d, payments, today = todayISO()) {
  const own = payments.filter((p) => p.debtId === d.id);
  const rem = Math.max(0, (d.principal || 0) - own.reduce((s, p) => s + p.amount, 0));
  const decimals = decimalsOf(d.currency);
  const lastDate = own.map((p) => p.date || '').sort().pop() || d.startDate;
  const accrued = accruedInterest(rem, d.interestRate, lastDate, today, decimals);
  const schedule = buildSchedule({ principal: d.principal, annualRatePct: d.interestRate, termMonths: d.termMonths, startDate: d.startDate, decimals });
  const cashPaid = own.reduce((s, p) => s + p.amount + (Number(p.interestPart) || 0), 0);
  const status = schedule.rows.length ? scheduleStatus(schedule, cashPaid, today) : null;
  return { rem, accrued, schedule, status, interestPaid: interestPaidOf(d, payments) };
}

function remaining(debt, payments) {
  if (debt.status === 'cancelled') return 0;
  const paid = payments.filter((p) => p.debtId === debt.id).reduce((s, p) => s + p.amount, 0);
  return Math.max(0, (debt.principal || 0) - paid);
}

/** Crée une dette/créance SANS transaction d'ouverture (donc sans mouvement de portefeuille à la
    création) — pour les cas où le mouvement réel, s'il a lieu, est déjà enregistré ailleurs (ex:
    shared.js, où la transaction de la dépense partagée elle-même couvre déjà l'argent qui a
    réellement bougé). Le remboursement passe ensuite par le flux existant (openPaymentModal /
    bouton "Rembourser"), qui lui crée bien une vraie transaction. */
export async function createLinkedDebt({ type, personName, principal, currency, startDate, note, sharedExpenseId, investmentId, interestRate, dueDate, auditNote }) {
  const record = {
    id: uuid(), type, personName, principal, currency,
    interestRate: interestRate || 0, startDate, dueDate: dueDate || null, status: 'active',
    note: note || '', openingTransactionId: null, sharedExpenseId: sharedExpenseId || null,
    // Prêt contracté pour financer un investissement (investments.js) : l'argent ne passe par AUCUN
    // portefeuille à l'ouverture (il va directement de la banque au vendeur), donc pas de transaction
    // d'ouverture — seuls les remboursements, eux, débitent un portefeuille courant.
    investmentId: investmentId || null,
    createdAt: new Date().toISOString(),
  };
  await dbPut(STORES.DEBTS, record);
  await logAudit({ entityType: 'debt', entityId: record.id, action: 'create', after: record, note: auditNote || tr('Issue du partage de dépenses') });
  return record;
}

/** Annule une dette/créance SANS rien rembourser : le restant dû est effacé (remise de dette), mais
    l'ouverture et les remboursements déjà faits restent tels quels dans les portefeuilles et dans
    l'historique — aucune transaction n'est créée ni supprimée, donc aucun solde de portefeuille ne bouge.
    `cancelledAmount` garde ce qui a été effacé, pour l'afficher et le replacer dans le relevé. */
export async function cancelDebt(debt, { date = todayISO(), note = '' } = {}) {
  const payments = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === debt.id);
  const record = { ...debt, status: 'cancelled', cancelledAt: date, cancelledAmount: remaining(debt, payments), cancelNote: note };
  await dbPut(STORES.DEBTS, record);
  await logAudit({ entityType: 'debt', entityId: debt.id, action: 'update', before: debt, after: record, note: tr('Annulée sans remboursement (aucun mouvement de portefeuille)') });
  return record;
}

/** Annule l'annulation : la dette redevient active (ou soldée si tout est déjà remboursé). */
export async function restoreCancelledDebt(debt) {
  const payments = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === debt.id);
  const { cancelledAt, cancelledAmount, cancelNote, ...rest } = debt;
  const left = Math.max(0, (debt.principal || 0) - payments.reduce((sum, p) => sum + p.amount, 0));
  const record = { ...rest, status: left <= 0.005 ? 'paid' : 'active' };
  await dbPut(STORES.DEBTS, record);
  await logAudit({ entityType: 'debt', entityId: debt.id, action: 'update', before: debt, after: record, note: tr('Annulation retirée') });
  return record;
}

/** Supprime une dette/créance et tout ce qui en découle (remboursements + transactions liées —
    ouverture ET remboursements). Réutilisé par la suppression directe (bouton "Supprimer" ci-
    dessous) et par la suppression en cascade d'une dépense partagée qui l'a générée (shared.js).
    Retourne les enregistrements supprimés (pour un "Annuler"), ou null si la dette n'existe déjà
    plus (ex: déjà supprimée manuellement depuis Dettes & créances). */
export async function deleteDebtCascade(debtId) {
  const debt = (await dbGetAll(STORES.DEBTS)).find((x) => x.id === debtId);
  if (!debt) return null;
  const payments = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === debtId);
  const linkedTx = (await dbGetAll(STORES.TRANSACTIONS)).filter((t) => t.debtId === debtId || t.debtInterestId === debtId);
  // Prêt reçu d'un compte gardé : les mouvements du compte (sortie à l'ouverture, entrées aux remboursements) partent avec la dette.
  const keptEntries = (await dbGetAll(STORES.KEPT_ACCOUNT_ENTRIES)).filter((e) => e.debtId === debtId);
  // Une seule transaction IndexedDB pour toutes ces suppressions (voir dbWriteBatch, db.js) : sans
  // ça, une interruption en cours de route pouvait laisser des remboursements/transactions orphelins
  // (la dette supprimée mais ses mouvements de portefeuille toujours là, ou l'inverse).
  await dbWriteBatch([
    ...payments.map((p) => ({ store: STORES.DEBT_PAYMENTS, type: 'delete', value: p.id })),
    ...linkedTx.map((t) => ({ store: STORES.TRANSACTIONS, type: 'delete', value: t.id })),
    ...keptEntries.map((e) => ({ store: STORES.KEPT_ACCOUNT_ENTRIES, type: 'delete', value: e.id })),
    { store: STORES.DEBTS, type: 'delete', value: debtId },
  ]);
  await logAudit({ entityType: 'debt', entityId: debtId, action: 'delete', before: debt });
  return { debt, payments, linkedTx, keptEntries };
}

/** Prêt reçu d'un COMPTE GARDÉ (`debt.keptAccountId`, voir group-projects.js) : l'argent a quitté le compte à l'ouverture ;
    chaque remboursement (capital + intérêts, quelle qu'en soit la source) l'y remet. Renvoie l'opération d'écriture à
    joindre au lot du remboursement, ou [] si la dette n'est pas concernée ou si le compte n'existe plus. */
async function keptReturnOps(d, payment, amount) {
  if (!d.keptAccountId || !(amount > 0)) return [];
  const account = (await dbGetAll(STORES.KEPT_ACCOUNTS)).find((a) => a.id === d.keptAccountId);
  if (!account) return [];
  return [{ store: STORES.KEPT_ACCOUNT_ENTRIES, type: 'add', value: {
    id: uuid(), accountId: account.id, type: 'in', amount, date: payment.date,
    note: tr('Remboursement du prêt par {name}', { name: d.borrowerName || tr('moi') }),
    debtId: d.id, debtPaymentId: payment.id, createdAt: new Date().toISOString(),
  } }];
}

export const DEBT_CATEGORY_NAMES = { debt: 'Prêt', receivable: 'Créance' };
/** Ancien nom unique (avant que "Prêt" et "Créance" soient distingués) — gardé pour que la
    migration dans app.js puisse repérer et corriger les transactions déjà catégorisées avec. */
export const LEGACY_DEBT_CATEGORY_NAME = 'Prêt et créance';
// Toutes les traductions connues des deux noms canoniques ci-dessus (FR + EN), utilisées UNIQUEMENT
// pour retrouver une catégorie déjà créée quelle que soit la langue active au moment de sa création
// (ensureDebtCategoryId ci-dessous) — jamais pour choisir le nom à la création, qui passe par tr()
// comme d'habitude. Sans ça, un utilisateur changeant de langue se retrouverait avec une nouvelle
// catégorie "Loan" créée à côté de son "Prêt" existant au lieu de le réutiliser.
const DEBT_CATEGORY_NAME_VARIANTS = {
  debt: ['Prêt', 'Loan'],
  receivable: ['Créance', 'Receivable'],
};

/** Retrouve (ou crée) la catégorie "Prêt" (dette) ou "Créance" selon debtType, pour le type de
    transaction donné (income/expense — les catégories sont scindées par type dans ce store, donc
    il existe potentiellement une catégorie "Prêt" ET une "Créance" par type, jusqu'à 4 au total).
    Utilisée pour que les mouvements de dette/créance (ouverture + remboursement) n'apparaissent
    jamais "Sans catégorie" dans la liste des transactions, tout en restant exclus des agrégats
    budgétaires (voir ledger.js, filtré via le champ debtId, pas via la catégorie). */
export async function ensureDebtCategoryId(debtType, txType) {
  const canonicalName = DEBT_CATEGORY_NAMES[debtType] || DEBT_CATEGORY_NAMES.debt;
  const variants = DEBT_CATEGORY_NAME_VARIANTS[debtType] || DEBT_CATEGORY_NAME_VARIANTS.debt;
  const categories = await dbGetAll(STORES.CATEGORIES);
  const existing = categories.find((c) => c.type === txType && variants.includes(c.name));
  if (existing) return existing.id;
  const category = { id: uuid(), name: tr(canonicalName), type: txType, parentId: null, createdAt: new Date().toISOString() };
  await dbAdd(STORES.CATEGORIES, category);
  return category.id;
}

/* ---------- Saisie guidée (accueil facile, easy-debts.js) ----------
   Le cas courant, sans les options avancées (intérêts, participants, compte gardé, projet) : « j'ai prêté 5 000 à Awa »,
   « Awa m'a rendu 2 000 ». Mêmes enregistrements que l'écran Dettes & créances (même catégorie, mêmes liens debtId/
   debtPaymentId), donc tout s'y retrouve, se modifie et se supprime comme d'habitude. */

/** Une dette/créance que la saisie guidée sait rembourser seule : sans intérêts ni participants, sans compte gardé ni
    projet collectif ni investissement. Les autres passent par la fenêtre de remboursement complète. */
export function isSimpleDebt(d) {
  return !!d && !(d.interestRate > 0) && !(d.participants && d.participants.length) && !d.keptAccountId && !d.projectId && !d.investmentId && !d.sharedExpenseId;
}

/** Dettes (`type: 'debt'`) ou créances (`'receivable'`) encore à régler, avec le restant dû, les plus anciennes d'abord. */
export async function listOpenDebts(type) {
  const [debts, payments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);
  return debts.filter((d) => d.type === type && d.status === 'active')
    .map((d) => ({ debt: d, owed: remaining(d, payments.filter((p) => p.debtId === d.id)) }))
    .filter((x) => x.owed > 0.005)
    .sort((a, b) => (a.debt.startDate || '').localeCompare(b.debt.startDate || ''));
}

/** Nouvelle dette (`type: 'debt'`, j'ai emprunté) ou créance (`'receivable'`, j'ai prêté). Avec `walletId`, l'argent entre
    dans (dette) ou sort de (créance) ce portefeuille aujourd'hui ; sans, rien ne bouge (le prêt date d'avant l'appli).
    Renvoie `{ debt, openingTx }` (ou `null` si le portefeuille ne convient pas) ; on l'annule par deleteDebtCascade(debt.id). */
export async function createSimpleDebt({ type, personName, principal, currency, walletId = null, date = todayISO(), dueDate = null, note = '' }) {
  const name = String(personName || '').trim().slice(0, 60);
  if (!name || !(principal > 0) || (type !== 'debt' && type !== 'receivable')) return null;
  let wallet = null;
  if (walletId) {
    wallet = (await dbGetAll(STORES.WALLETS)).find((w) => w.id === walletId);
    if (!wallet || !isDailyWallet(wallet)) return null;
    currency = wallet.currency; // la dette suit la devise du portefeuille
  }
  const debt = {
    id: uuid(), type, personName: name, principal: safeNumber(principal), currency, interestRate: 0, termMonths: null,
    // Échéance facultative : un jour valide, pas avant la date du prêt (sinon la dette serait « en retard » dès sa création).
    startDate: date, dueDate: /^\d{4}-\d{2}-\d{2}$/.test(dueDate || '') && dueDate >= date ? dueDate : null,
    status: 'active', note: String(note || '').trim().slice(0, 140), openingTransactionId: null, createdAt: new Date().toISOString(),
  };
  let openingTx = null;
  if (wallet) {
    const txType = type === 'debt' ? 'income' : 'expense';
    openingTx = {
      id: uuid(), type: txType, walletId: wallet.id, targetWalletId: null, categoryId: await ensureDebtCategoryId(type, txType),
      amount: debt.principal, date,
      note: type === 'debt' ? tr('Prêt reçu de {name}', { name }) : tr('Prêt accordé à {name}', { name }),
      tags: [], reconciled: false, debtId: debt.id, createdAt: new Date().toISOString(),
    };
    debt.openingTransactionId = openingTx.id;
  }
  await dbWriteBatch([...(openingTx ? [{ store: STORES.TRANSACTIONS, type: 'add', value: openingTx }] : []), { store: STORES.DEBTS, type: 'put', value: debt }]);
  if (openingTx) await logAudit({ entityType: 'transaction', entityId: openingTx.id, action: 'create', after: openingTx, note: tr('Mouvement de dette/créance') });
  await logAudit({ entityType: 'debt', entityId: debt.id, action: 'create', after: debt });
  return { debt, openingTx };
}

/** Remboursement simple d'une dette/créance sans intérêts, passant par un portefeuille (de la devise de la dette). Refuse
    (renvoie `null`) un montant nul, supérieur au restant dû, une dette non simple, ou un portefeuille qui ne convient pas. */
export async function recordSimplePayment(debt, { amount, walletId, date = todayISO(), note = '' }) {
  if (!isSimpleDebt(debt) || !(amount > 0)) return null;
  const [wallets, allPayments] = await Promise.all([dbGetAll(STORES.WALLETS), dbGetAll(STORES.DEBT_PAYMENTS)]);
  const wallet = wallets.find((w) => w.id === walletId);
  if (!wallet || !isDailyWallet(wallet) || wallet.currency !== debt.currency) return null;
  const own = allPayments.filter((p) => p.debtId === debt.id);
  const owed = remaining(debt, own);
  const value = roundTo(safeNumber(amount), decimalsOf(debt.currency));
  if (!(value > 0) || value > owed + 0.005) return null;
  const payment = { id: uuid(), debtId: debt.id, amount: value, interestPart: 0, date, note: String(note || '').trim().slice(0, 140) };
  const txType = debt.type === 'debt' ? 'expense' : 'income';
  const tx = {
    id: uuid(), type: txType, walletId: wallet.id, targetWalletId: null, categoryId: await ensureDebtCategoryId(debt.type, txType),
    amount: value, date, note: tr('Remboursement — {name}', { name: debt.personName }),
    tags: [], reconciled: false, debtId: debt.id, debtPaymentId: payment.id, createdAt: new Date().toISOString(),
  };
  const settles = owed - value <= 0.005;
  const after = settles ? { ...debt, status: 'paid' } : null;
  await dbWriteBatch([
    { store: STORES.DEBT_PAYMENTS, type: 'add', value: payment },
    { store: STORES.TRANSACTIONS, type: 'add', value: tx },
    ...(after ? [{ store: STORES.DEBTS, type: 'put', value: after }] : []),
  ]);
  await logAudit({ entityType: 'debtPayment', entityId: payment.id, action: 'create', after: payment });
  await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'create', after: tx, note: tr('Remboursement de dette/créance') });
  if (after) await logAudit({ entityType: 'debt', entityId: debt.id, action: 'update', before: debt, after, note: tr('Soldée') });
  return { payment, tx, settled: settles, debtBefore: debt };
}

/** Annule un remboursement fait par recordSimplePayment : retire le versement et sa transaction, et rouvre la dette si ce
    versement l'avait soldée. */
export async function undoSimplePayment(result) {
  await dbWriteBatch([
    { store: STORES.DEBT_PAYMENTS, type: 'delete', value: result.payment.id },
    { store: STORES.TRANSACTIONS, type: 'delete', value: result.tx.id },
    ...(result.settled ? [{ store: STORES.DEBTS, type: 'put', value: result.debtBefore }] : []),
  ]);
  await logAudit({ entityType: 'debtPayment', entityId: result.payment.id, action: 'delete', before: result.payment, note: tr('Remboursement (annulation)') });
  await logAudit({ entityType: 'transaction', entityId: result.tx.id, action: 'delete', before: result.tx, note: tr('Remboursement (annulation)') });
}

/** Fiche à exporter (PDF/Excel) pour cette dette/créance : voir proof-export.js pour le format.
    Le tableau part de l'ouverture et suit le restant dû après chaque remboursement. */
async function buildDebtProof(d) {
  const [allPayments, profile] = await Promise.all([dbGetAll(STORES.DEBT_PAYMENTS), getSetting('userProfile', {})]);
  const own = allPayments.filter((p) => p.debtId === d.id).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const isDebt = d.type === 'debt';
  const cur = d.currency;
  const money = (amount) => ({ amount, currency: cur });
  const paid = own.reduce((s, p) => s + p.amount, 0);
  const rem = d.status === 'cancelled' ? 0 : Math.max(0, (d.principal || 0) - paid);
  const declarant = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || tr('Utilisateur');

  const snap = loanSnapshot(d, allPayments);
  let running = d.principal || 0;
  const rows = [[{ date: d.startDate }, isDebt ? tr('Ouverture de la dette') : tr("Ouverture de la créance"), d.note || '', money(d.principal || 0), money(running)]];
  for (const p of own) {
    running = Math.max(0, running - p.amount);
    const interestNote = p.interestPart > 0 ? tr('dont intérêts : {amount}', { amount: formatCurrency(p.interestPart, cur) }) : '';
    rows.push([{ date: p.date }, tr('Remboursement'), [paymentSourceLabel(p), p.note, interestNote].filter(Boolean).join(' · '), money(p.amount), money(running)]);
  }

  if (d.status === 'cancelled') {
    rows.push([{ date: d.cancelledAt || d.startDate }, tr('Annulation'), d.cancelNote || '', money(d.cancelledAmount ?? 0), money(0)]);
  }

  return {
    title: isDebt ? tr('Fiche de dette') : tr('Fiche de créance'),
    subtitle: d.personName,
    signatures: isDebt
      ? [tr('Le débiteur — {name}', { name: declarant }), tr('Le créancier — {name}', { name: d.personName })]
      : [tr('Le créancier — {name}', { name: declarant }), tr('Le débiteur — {name}', { name: d.personName })],
    blocks: [
      {
        type: 'rows',
        heading: tr('Informations générales'),
        rows: [
          [tr('Type'), isDebt ? tr('Dette (je dois)') : tr('Créance (on me doit)')],
          [tr('Nom de la personne / organisme'), d.personName],
          [tr('Devise'), cur],
          [tr('Montant initial'), money(d.principal || 0)],
          ...(d.interestRate ? [[tr("Taux d'intérêt annuel"), formatPercent(d.interestRate, 1)]] : []),
          [tr('Date de départ'), { date: d.startDate }],
          ...(d.dueDate ? [[tr('Échéance'), { date: d.dueDate }]] : []),
          [tr('Statut'), d.status === 'paid' ? tr('Soldée') : d.status === 'cancelled' ? tr('Annulée') : tr('En cours')],
          ...(d.status === 'cancelled' ? [[tr('Annulée le'), { date: d.cancelledAt || d.startDate }], [tr('Montant annulé'), money(d.cancelledAmount ?? 0)]] : []),
          ...(d.note ? [[tr('Note'), d.note]] : []),
        ],
      },
      {
        type: 'rows',
        heading: tr('Synthèse'),
        rows: [
          [tr('Total remboursé'), money(paid)],
          ...(d.interestRate > 0 ? [[tr('Intérêts payés'), money(snap.interestPaid)]] : []),
          ...(snap.schedule.rows.length ? [[tr('Mensualité prévue'), money(snap.schedule.payment)], [tr("Total des intérêts prévus"), money(snap.schedule.totalInterest)]] : []),
          [tr('Restant dû'), money(rem)],
          [tr('Taux de remboursement'), formatPercent(percentage(paid, d.principal), 0)],
        ],
      },
      {
        type: 'table',
        heading: tr('Historique des remboursements'),
        columns: [
          { label: tr('Date'), align: 'left', weight: 2.4 },
          { label: tr('Opération'), align: 'left', weight: 3.4 },
          { label: tr('Note'), align: 'left', weight: 3.4 },
          { label: `${tr('Montant')} (${cur})`, align: 'right', weight: 2.8 },
          { label: `${tr('Restant dû')} (${cur})`, align: 'right', weight: 2.8 },
        ],
        rows,
      },
      ...(snap.schedule.rows.length ? [{
        type: 'table',
        heading: tr('Échéancier prévu'),
        columns: [
          { label: tr('Échéance'), align: 'left', weight: 2.4 },
          { label: `${tr('Mensualité')} (${cur})`, align: 'right', weight: 2.8 },
          { label: `${tr('Intérêts')} (${cur})`, align: 'right', weight: 2.6 },
          { label: `${tr('Capital')} (${cur})`, align: 'right', weight: 2.6 },
          { label: `${tr('Restant dû')} (${cur})`, align: 'right', weight: 2.8 },
        ],
        rows: snap.schedule.rows.map((row) => [{ date: row.date }, money(row.payment), money(row.interest), money(row.principal), money(row.balance)]),
      }] : []),
    ],
  };
}

function debtCardHtml(d, payments, investmentName = null) {
  const paid = (debt_paid_of(d, payments));
  const rem = Math.max(0, (d.principal || 0) - paid);
  const pct = percentage(paid, d.principal);
  const isDebt = d.type === 'debt';
  const loan = d.interestRate > 0 ? loanSnapshot(d, payments) : null;
  return `
    <div class="summary-card" data-debt-id="${escapeHtml(d.id)}">
      <div class="card-title-row">
        <div>
          <span class="badge ${isDebt ? 'badge-neg' : 'badge-pos'}">${isDebt ? tr('Dette') : tr('Créance')}</span>
          <div class="fw-700 fs-15 mt-6">${escapeHtml(d.personName)}</div>
          ${d.note ? `<div class="tx-sub">${escapeHtml(d.note)}</div>` : ''}
          ${investmentName ? `<div class="tx-sub">${tr('Finance l\'investissement « {name} »', { name: escapeHtml(investmentName) })}</div>` : ''}
        </div>
        <div class="card-actions">
          ${!isDebt && rem > 0.005 ? `<button type="button" class="icon-btn" data-action="remind" aria-label="${tr('Relancer')}" title="${tr('Relancer par WhatsApp ou SMS')}">${REMIND_ICON}</button>` : ''}
          <button type="button" class="icon-btn" data-action="person" aria-label="${tr('Fiche de la personne')}" title="${tr('Fiche de la personne')}">${PERSON_ICON}</button>
          <button type="button" class="icon-btn" data-action="export" aria-label="${tr('Exporter / imprimer')}" title="${tr('Exporter / imprimer')}">${PRINT_ICON}</button>
          ${rem > 0.005 ? `<button type="button" class="icon-btn" data-action="acknowledge" aria-label="${tr('Reconnaissance de dette (PDF)')}" title="${tr('Reconnaissance de dette (PDF)')}">${ACK_ICON}</button>` : ''}
          ${loan?.schedule.rows.length ? `<button type="button" class="icon-btn" data-action="schedule" aria-label="${tr('Échéancier')}" title="${tr('Échéancier')}">${SCHEDULE_ICON}</button>` : ''}
          <button type="button" class="icon-btn" data-action="pay" aria-label="${tr('Enregistrer un remboursement')}" title="${tr('Enregistrer un remboursement')}">${PAY_ICON}</button>
          <button type="button" class="icon-btn" data-action="edit" aria-label="${tr('Modifier')}" title="${tr('Modifier')}">${EDIT_ICON}</button>
          ${rem > 0.005 ? `<button type="button" class="icon-btn" data-action="cancel" aria-label="${tr('Annuler la dette')}" title="${isDebt ? tr('Annuler cette dette sans remboursement') : tr('Annuler cette créance sans remboursement')}">${CANCEL_ICON}</button>` : ''}
          <button type="button" class="icon-btn" data-action="delete" aria-label="${tr('Supprimer')}" title="${tr('Supprimer')}">${DELETE_ICON}</button>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${Math.min(pct, 100)}%"></div></div>
      <div style="display:flex;justify-content:space-between;margin:6px 0 10px;" class="fs-13 c-muted">
        <span>${tr('Remboursé : {amount}', { amount: formatCurrency(paid, d.currency) })}</span>
        <span>${formatPercent(pct, 0)}</span>
      </div>
      <div class="stat-row"><span class="stat-row-label">${tr('Montant initial')}</span><span>${formatCurrency(d.principal, d.currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${tr('Restant dû')}</span><span class="amount" data-value="${rem}">${formatCurrency(rem, d.currency)}</span></div>
      ${d.forecastIgnored ? `<div class="tx-sub mt-6">${tr('Ignorée dans la prévision et le reste à vivre')}</div>` : ''}
      ${sharedLoanSectionHtml(d, payments)}
      ${(() => {
        const offWallet = payments.filter((p) => p.debtId === d.id && (p.source === 'direct' || p.source === 'third'));
        const offWalletTotal = offWallet.reduce((s, p) => s + p.amount, 0);
        if (!(offWalletTotal > 0)) return '';
        const names = [...new Set(offWallet.map(paymentSourceLabel).filter(Boolean))].join(', ');
        return `<div class="stat-row"><span class="stat-row-label">${tr('Réglé hors portefeuille')}</span><span title="${escapeHtml(names)}">${formatCurrency(offWalletTotal, d.currency)}</span></div>`;
      })()}
      ${d.interestRate ? `<div class="stat-row"><span class="stat-row-label">${tr("Taux d'intérêt annuel")}</span><span>${formatPercent(d.interestRate, 1)}</span></div>` : ''}
      ${d.dueDate ? `<div class="stat-row"><span class="stat-row-label">${tr('Échéance')}</span><span>${formatDate(d.dueDate)}</span></div>` : ''}
      ${loan && rem > 0.005 ? `<div class="stat-row"><span class="stat-row-label">${tr('Intérêts courus (estimation)')}</span><span class="amount">${formatCurrency(loan.accrued, d.currency)}</span></div>` : ''}
      ${loan && loan.interestPaid > 0 ? `<div class="stat-row"><span class="stat-row-label">${tr('Intérêts déjà payés')}</span><span class="amount">${formatCurrency(loan.interestPaid, d.currency)}</span></div>` : ''}
      ${loan?.status?.next && rem > 0.005 ? `<div class="stat-row"><span class="stat-row-label">${loan.status.next.status === 'due' ? tr('Échéance en retard') : tr('Prochaine mensualité')}</span><span class="${loan.status.next.status === 'due' ? 'c-neg' : ''}">${formatCurrency(loan.status.next.payment, d.currency)} · ${formatDate(loan.status.next.date)}</span></div>` : ''}
    </div>`;
}
/** Prêt partagé (à mon nom) : ma part, puis pour chaque participant ce qu'il a versé et ce qu'il me doit encore. */
function sharedLoanSectionHtml(d, payments) {
  if (d.type !== 'debt' || !d.participants?.length) return '';
  const statuses = participantStatuses(d, payments);
  const owedTotal = statuses.reduce((s, x) => s + x.owed, 0);
  const myShare = Math.max(0, (d.principal || 0) - statuses.reduce((s, x) => s + x.share, 0));
  const rows = statuses.map((x) => `
    <div class="stat-row">
      <span class="stat-row-label">${escapeHtml(x.name)}</span>
      <span class="${x.owed > 0.005 ? 'c-neg' : 'c-pos'}">${tr('{paid} sur {share}', { paid: formatCurrency(x.paid, d.currency), share: formatCurrency(x.share, d.currency) })}${x.waived > 0 ? ` · ${tr('abandonné : {amount}', { amount: formatCurrency(x.waived, d.currency) })}` : ''}</span>
    </div>`).join('');
  return `
    <div class="mt-8" style="border-top:1px solid var(--border);padding-top:8px;">
      <div class="stat-row"><span class="stat-row-label fw-700">${tr('Prêt partagé — ma part')}</span><span class="amount" data-value="${myShare}">${formatCurrency(myShare, d.currency)}</span></div>
      ${rows}
      ${owedTotal > 0.005 ? `<div class="stat-row"><span class="stat-row-label">${tr('Reste à recevoir des participants')}</span><span class="amount">${formatCurrency(owedTotal, d.currency)}</span></div>
      <button type="button" class="btn btn-ghost fs-13 mt-6" data-action="contribution">${tr('Participation reçue')}</button>` : ''}
    </div>`;
}

function debt_paid_of(d, payments) {
  return payments.filter((p) => p.debtId === d.id).reduce((s, p) => s + p.amount, 0);
}

function latestPaymentDate(d, payments) {
  const own = payments.filter((p) => p.debtId === d.id).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return own[0]?.date || d.startDate;
}

function paidDebtRowHtml(d, paidDate) {
  const isDebt = d.type === 'debt';
  return `
    <div class="tx-row" data-debt-id="${escapeHtml(d.id)}">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(d.personName)}</div>
        <div class="tx-sub">${formatDate(paidDate)}${d.note ? ' · ' + escapeHtml(d.note) : ''}</div>
      </div>
      <div class="tx-amount amount ${isDebt ? 'neg' : 'pos'}">${formatCurrency(d.principal, d.currency)}</div>
      <div class="card-actions">
        <button type="button" class="icon-btn" data-action="export" aria-label="${tr('Exporter / imprimer')}" title="${tr('Exporter / imprimer')}">${PRINT_ICON}</button>
        <button type="button" class="icon-btn" data-action="delete" aria-label="${tr('Supprimer')}" title="${tr('Supprimer')}">${DELETE_ICON}</button>
      </div>
    </div>`;
}

function cancelledDebtRowHtml(d) {
  const isDebt = d.type === 'debt';
  return `
    <div class="tx-row" data-debt-id="${escapeHtml(d.id)}">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(d.personName)} <span class="badge">${isDebt ? tr('Dette') : tr('Créance')}</span></div>
        <div class="tx-sub">${tr('Annulée le {date}', { date: formatDate(d.cancelledAt || d.startDate) })} · ${tr('{amount} effacé sur {principal}', { amount: formatCurrency(d.cancelledAmount ?? 0, d.currency), principal: formatCurrency(d.principal, d.currency) })}${d.cancelNote ? ' · ' + escapeHtml(d.cancelNote) : ''}</div>
      </div>
      <div class="card-actions">
        <button type="button" class="icon-btn" data-action="export" aria-label="${tr('Exporter / imprimer')}" title="${tr('Exporter / imprimer')}">${PRINT_ICON}</button>
        <button type="button" class="icon-btn" data-action="restore" aria-label="${tr('Rétablir')}" title="${tr('Rétablir cette dette (retirer l\'annulation)')}">${RESTORE_ICON}</button>
        <button type="button" class="icon-btn" data-action="delete" aria-label="${tr('Supprimer')}" title="${tr('Supprimer')}">${DELETE_ICON}</button>
      </div>
    </div>`;
}

function walletOptionsHtml(wallets, currency) {
  const matching = wallets.filter((w) => w.currency === currency);
  if (!matching.length) return `<option value="">${tr('Aucun portefeuille en {currency}', { currency: escapeHtml(currency) })}</option>`;
  return matching.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('');
}

function debtFormHtml(d, defaultCurrency) {
  const isEdit = !!d;
  return `
    <form id="debt-form">
      ${d?.projectId ? `<p class="alert alert-warn mb-12">${tr("Ce prêt a été créé par un projet collectif : le montant, la date, la devise et le type ne se modifient pas ici (ils sont repris dans le projet, la dépense et le compte gardé). Pour les changer, retirez la participation depuis Partage de dépenses.")}</p>` : ''}
      <div class="segmented" data-field="type">
        <button type="button" class="segmented-btn ${(!d || d.type === 'debt') ? 'is-active' : ''}" data-value="debt">${tr('Dette (je dois)')}</button>
        <button type="button" class="segmented-btn ${d?.type === 'receivable' ? 'is-active' : ''}" data-value="receivable">${tr('Créance (on me doit)')}</button>
      </div>
      <input type="hidden" name="type" value="${d?.type || 'debt'}">
      <div class="form-row"><label>${tr('Nom de la personne / organisme')}</label><input type="text" name="personName" required maxlength="60" value="${escapeHtml(d?.personName || '')}"></div>
      <div class="form-row"><label>${tr('Montant')}</label><input type="number" step="0.01" min="0" name="principal" required value="${d?.principal ?? ''}"></div>
      <div class="form-row"><label>${tr('Devise')}</label>${currencySelectHtml(d?.currency || defaultCurrency)}</div>
      ${!isEdit ? `
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" name="movesMoneyNow" checked> ${tr('Cet argent bouge aujourd\'hui')}
        </label>
        <p style="margin:2px 0 0;" class="fs-12 c-muted">${tr('Décochez si c\'est une dette déjà existante avant d\'utiliser l\'app (aucun mouvement de portefeuille ne sera créé).')}</p>
      </div>
      <div class="form-row" data-field="movesMoneyWallet">
        <label>${tr('Portefeuille')}</label>
        <select name="walletId"></select>
      </div>` : ''}
      <div class="form-row"><label>${tr("Taux d'intérêt annuel % (optionnel)")}</label><input type="number" step="0.01" min="0" name="interestRate" value="${d?.interestRate ?? ''}"></div>
      <div class="form-row"><label>${tr("Durée du prêt en mois (optionnel — pour l'échéancier)")}</label><input type="number" step="1" min="1" max="600" name="termMonths" value="${d?.termMonths ?? ''}"></div>
      <div class="form-row"><label>${tr('Date de départ')}</label><input type="date" name="startDate" value="${d?.startDate || todayISO()}"></div>
      <div class="form-row"><label>${tr('Échéance (optionnel)')}</label><input type="date" name="dueDate" value="${d?.dueDate || ''}"></div>
      <div class="form-row"><label>${tr('Note (optionnel)')}</label><input type="text" name="note" maxlength="140" value="${escapeHtml(d?.note || '')}"></div>
      <div data-field="sharedLoanRows" ${d && d.type !== 'debt' ? 'hidden' : ''}>
        <div class="form-row">
          <label>${tr('Prêt partagé : les autres participants (optionnel)')}</label>
          <textarea name="participants" rows="4" placeholder="${escapeHtml(tr('Un par ligne : « Awa » ou « Moussa : 50000 »'))}">${escapeHtml(participantsToText(d?.participants))}</textarea>
          <p class="fs-12 c-muted mt-6" id="shared-loan-hint">${tr("Le prêt reste à votre nom : vous devez tout au prêteur, et chaque participant vous doit sa part. Sans montant, les parts sont égales (la vôtre comprise).")}</p>
        </div>
        <div class="form-row">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" name="forecastIgnored" ${d?.forecastIgnored ? 'checked' : ''}> ${tr('Ne pas compter cette dette dans la prévision et le reste à vivre')}
          </label>
          <p style="margin:2px 0 0;" class="fs-12 c-muted">${tr("Pour une vieille dette en retard que vous ne comptez plus régler : sans cela, elle réduit votre reste à vivre indéfiniment. Elle reste visible ici et dans le patrimoine.")}</p>
        </div>
        <div class="form-row">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
            <input type="checkbox" name="exceptional" ${d?.exceptional ? 'checked' : ''}> ${tr('Ce prêt finance une dépense exceptionnelle')}
          </label>
          <p style="margin:2px 0 0;" class="fs-12 c-muted">${tr("Ses intérêts ne comptent pas dans vos dépenses du mois (le capital remboursé n'y compte déjà jamais).")}</p>
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${d ? tr('Enregistrer') : tr('Créer')}</button>
    </form>`;
}

export async function openDebtModal(d = null, { personName = '' } = {}) {
  const defaultCurrency = d ? d.currency : await getSetting('baseCurrency', 'EUR');
  const modal = openModal(debtFormHtml(d, defaultCurrency), { title: d ? tr('Modifier') : tr('Nouvelle dette / créance') });
  wireCurrencySelect(modal.el);
  if (personName && !d) modal.el.querySelector('[name="personName"]').value = personName;
  let currentType = d?.type || 'debt';
  modal.el.querySelectorAll('.segmented-btn').forEach((b) => b.addEventListener('click', () => {
    currentType = b.dataset.value;
    modal.el.querySelector('[name="type"]').value = currentType;
    modal.el.querySelectorAll('.segmented-btn').forEach((x) => x.classList.toggle('is-active', x === b));
    // Le partage et la dépense exceptionnelle ne concernent que mes dettes (pas ce que les autres me doivent).
    modal.el.querySelector('[data-field="sharedLoanRows"]').hidden = currentType !== 'debt';
  }));

  const form = modal.el.querySelector('#debt-form');
  // Aperçu en direct de ma part et de celle des autres, pour que la répartition ne réserve pas de surprise.
  const participantsHint = modal.el.querySelector('#shared-loan-hint');
  const defaultHintText = participantsHint.textContent;
  const refreshParticipantsHint = () => {
    const principal = safeNumber(parseFloat(form.elements.principal.value));
    const parsed = parseParticipants(form.elements.participants.value, principal, decimalsOf(readCurrencyValue(form)), d?.participants || []);
    if (parsed.error || !parsed.participants.length || !(principal > 0)) { participantsHint.textContent = defaultHintText; return; }
    const cur = readCurrencyValue(form);
    participantsHint.textContent = tr('Votre part : {mine} · les {count} autre(s) : {others}', {
      mine: formatCurrency(parsed.myShare, cur), count: parsed.participants.length,
      others: formatCurrency(parsed.participants.reduce((s, p) => s + p.share, 0), cur),
    });
  };
  form.elements.participants.addEventListener('input', refreshParticipantsHint);
  form.elements.principal.addEventListener('input', refreshParticipantsHint);
  const movesCheckbox = form.elements.movesMoneyNow;
  const walletRow = modal.el.querySelector('[data-field="movesMoneyWallet"]');
  const walletSelect = form.elements.walletId;

  if (movesCheckbox) {
    let allWallets = [];
    const refreshWalletOptions = async () => {
      if (!allWallets.length) allWallets = (await dbGetAll(STORES.WALLETS)).filter(isDailyWallet);
      walletSelect.innerHTML = walletOptionsHtml(allWallets, readCurrencyValue(form));
    };
    const syncWalletVisibility = () => { walletRow.hidden = !movesCheckbox.checked; };
    movesCheckbox.addEventListener('change', syncWalletVisibility);
    modal.el.querySelectorAll('[data-currency-select], [data-currency-other]').forEach((el) => {
      el.addEventListener('change', refreshWalletOptions);
      el.addEventListener('input', refreshWalletOptions);
    });
    await refreshWalletOptions();
    syncWalletVisibility();
  }

  onceSubmit(form, async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const before = d ? { ...d } : null;
    const currency = readCurrencyValue(e.target);
    const movesMoneyNow = !d && movesCheckbox?.checked;
    if (movesMoneyNow && !walletSelect.value) { showToast(tr('Choisissez un portefeuille, ou décochez "Cet argent bouge aujourd\'hui".')); return; }

    const record = {
      ...(d || {}),
      id: d?.id || uuid(),
      type: currentType,
      personName: fd.get('personName').trim(),
      principal: safeNumber(parseFloat(fd.get('principal'))),
      currency,
      interestRate: safeNumber(parseFloat(fd.get('interestRate'))),
      termMonths: Math.floor(safeNumber(parseInt(fd.get('termMonths'), 10))) || null,
      startDate: fd.get('startDate') || todayISO(),
      dueDate: fd.get('dueDate') || null,
      status: d?.status || 'active',
      note: (fd.get('note') || '').trim().slice(0, 140),
      openingTransactionId: d?.openingTransactionId || null,
    };

    if (!(record.principal > 0)) { showToast(tr('Saisissez un montant supérieur à 0.')); return; }

    // Prêt créé par un projet collectif : son montant, sa date, sa devise et son type sont aussi portés par la ligne du
    // projet, la dépense exceptionnelle et (si le prêteur est un compte gardé) la sortie du compte. Les modifier ici les
    // désynchroniserait ; seuls le taux, l'échéance, la note et les participants restent libres.
    if (d?.projectId && (record.principal !== d.principal || record.currency !== d.currency || record.type !== d.type || record.startDate !== d.startDate)) {
      showToast(tr('Ce prêt appartient à un projet collectif : le montant, la date, la devise et le type se changent depuis le projet.'));
      return;
    }

    // Prêt partagé et dépense exceptionnelle : réservés aux dettes (voir shared-loan.js pour le modèle).
    if (currentType === 'debt') {
      const parsed = parseParticipants(fd.get('participants'), record.principal, decimalsOf(currency), d?.participants || []);
      if (parsed.error === 'too-many') { showToast(tr('Trop de participants : 300 au maximum.')); return; }
      if (parsed.error === 'too-much') { showToast(tr('Les parts saisies ({amount}) dépassent le montant du prêt.', { amount: formatCurrency(parsed.fixedTotal, currency) })); return; }
      if (parsed.error) { showToast(tr('Ligne illisible dans la liste des participants : écrivez un nom, ou « Nom : montant ».')); return; }
      // Un participant qui a déjà versé quelque chose ne peut pas disparaître de la liste (ni changer de nom : il
      // serait perçu comme un autre) — sinon ses versements ne se rattacheraient plus à personne.
      if (d?.participants?.length) {
        const keptIds = new Set(parsed.participants.map((p) => p.id));
        const existingPayments = await dbGetAll(STORES.DEBT_PAYMENTS);
        const stuck = d.participants.find((old) => !keptIds.has(old.id)
          && (existingPayments.some((p) => p.debtId === d.id && p.participantId === old.id) || (d.handedIn || []).some((h) => h.participantId === old.id) || (d.waived || []).some((h) => h.participantId === old.id)));
        if (stuck) { showToast(tr('« {name} » a déjà versé une participation : gardez-le dans la liste, avec le même nom.', { name: stuck.name })); return; }
      }
      if (parsed.participants.length) record.participants = parsed.participants; else delete record.participants;
      if (form.elements.exceptional.checked) record.exceptional = true; else delete record.exceptional;
      if (form.elements.forecastIgnored.checked) record.forecastIgnored = true; else delete record.forecastIgnored;
    } else {
      delete record.participants;
      delete record.exceptional;
      delete record.forecastIgnored;
    }

    // Modification d'une dette existante : le montant, la date, la devise et le type doivent rester
    // cohérents avec ce qui a déjà bougé dans les portefeuilles (transaction d'ouverture, remboursements),
    // et le statut « soldée » doit suivre le nouveau montant (sinon une dette relevée restait cachée
    // des échéances, de la prévision et des rappels, ou une dette abaissée ne se soldait jamais).
    const extraOps = [];
    if (d) {
      const paid = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === d.id).reduce((sum, p) => sum + p.amount, 0);
      if ((d.openingTransactionId || paid > 0) && (record.currency !== d.currency || record.type !== d.type)) {
        showToast(tr('Le type et la devise ne peuvent plus changer : des mouvements de portefeuille y sont liés. Supprimez cette dette et recréez-la.'));
        return;
      }
      if (d.status === 'cancelled') {
        // Une dette annulée le reste après modification ; le montant effacé suit le nouveau principal.
        record.status = 'cancelled';
        record.cancelledAmount = Math.max(0, record.principal - paid);
      } else {
        record.status = (record.principal - paid) <= 0.005 ? 'paid' : 'active';
      }
      if (d.openingTransactionId) {
        const openingTx = (await dbGetAll(STORES.TRANSACTIONS)).find((x) => x.id === d.openingTransactionId);
        if (openingTx) {
          extraOps.push({ store: STORES.TRANSACTIONS, type: 'put', value: {
            ...openingTx,
            amount: record.principal,
            date: record.startDate,
            note: record.type === 'debt' ? tr('Prêt reçu de {name}', { name: record.personName }) : tr('Prêt accordé à {name}', { name: record.personName }),
          } });
        }
      }
    }

    if (movesMoneyNow) {
      const txType = currentType === 'debt' ? 'income' : 'expense';
      const openingTx = {
        id: uuid(),
        type: txType,
        walletId: walletSelect.value,
        targetWalletId: null,
        categoryId: await ensureDebtCategoryId(currentType, txType),
        amount: record.principal,
        date: record.startDate,
        note: currentType === 'debt' ? tr('Prêt reçu de {name}', { name: record.personName }) : tr('Prêt accordé à {name}', { name: record.personName }),
        tags: [],
        reconciled: false,
        debtId: record.id,
        createdAt: new Date().toISOString(),
      };
      await dbAdd(STORES.TRANSACTIONS, openingTx);
      await logAudit({ entityType: 'transaction', entityId: openingTx.id, action: 'create', after: openingTx, note: tr('Mouvement de dette/créance') });
      record.openingTransactionId = openingTx.id;
    }

    await dbWriteBatch([...extraOps, { store: STORES.DEBTS, type: 'put', value: record }]);
    await logAudit({ entityType: 'debt', entityId: record.id, action: d ? 'update' : 'create', before, after: record });
    modal.close();
    showToast(d ? tr('Mis à jour.') : tr('Créé.'));
    notifyDataChanged(movesMoneyNow || extraOps.length ? 'all' : 'debts');
  });
}

/** Catégorie des intérêts d'un prêt : « Intérêts de prêt » (charge, dette) ou « Intérêts » (revenu,
    créance). Contrairement au capital remboursé (exclu des budgets, simple mouvement de dette), les
    intérêts sont un vrai coût / un vrai gain : ils comptent dans les dépenses et les revenus. */
const LOAN_INTEREST_CATEGORY_VARIANTS = {
  expense: ['Intérêts de prêt', 'Loan interest'],
  income: ['Intérêts', 'Interest', 'Intérêts perçus'],
};
async function ensureLoanInterestCategoryId(txType) {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const existing = categories.find((c) => c.type === txType && LOAN_INTEREST_CATEGORY_VARIANTS[txType].includes(c.name));
  if (existing) return existing.id;
  const category = { id: uuid(), name: tr(txType === 'expense' ? 'Intérêts de prêt' : 'Intérêts'), type: txType, parentId: null, createdAt: new Date().toISOString() };
  await dbAdd(STORES.CATEGORIES, category);
  return category.id;
}

export async function openPaymentModal(d, { prefill = null } = {}) {
  const wallets = (await dbGetAll(STORES.WALLETS)).filter(isDailyWallet);
  const hasInterest = d.interestRate > 0;
  const allPayments = await dbGetAll(STORES.DEBT_PAYMENTS);
  const decimals = decimalsOf(d.currency);
  const owedNow = remaining(d, allPayments.filter((p) => p.debtId === d.id));
  const suggestedInterest = hasInterest ? loanSnapshot(d, allPayments).accrued : 0;
  const initialInterest = prefill?.interest ?? (suggestedInterest > 0 ? suggestedInterest : '');
  const modal = openModal(`
    <form id="payment-form">
      <div class="form-row"><label>${hasInterest ? tr('Montant versé (capital + intérêts)') : tr('Montant remboursé')}</label><input type="number" step="0.01" min="0" name="amount" required autofocus value="${prefill?.total ?? ''}"></div>
      ${hasInterest ? `
      <div class="form-row"><label>${tr('dont intérêts')}</label><input type="number" step="0.01" min="0" name="interestPart" value="${initialInterest}">
        <p class="fs-12 c-muted mt-6" id="payment-split-hint"></p></div>` : ''}
      ${d.type === 'debt' ? `
      <div class="form-row"><label>${tr('Source du remboursement')}</label>
        <select name="source">
          <option value="wallet">${tr('Un de mes portefeuilles')}</option>
          <option value="direct">${tr('Revenu direct (ne passe par aucun portefeuille)')}</option>
          <option value="third">${tr("Payé par quelqu'un d'autre")}</option>
        </select>
        <p class="fs-12 c-muted mt-6" id="payment-source-hint"></p></div>
      <div class="form-row" data-field="sourceNameRow" hidden><label id="payment-source-name-label"></label><input type="text" name="sourceName" maxlength="60"></div>` : ''}
      <div class="form-row" data-field="walletRow"><label>${tr('Portefeuille')}</label><select name="walletId" required>${walletOptionsHtml(wallets, d.currency)}</select></div>
      <div class="form-row"><label>${tr('Date')}</label><input type="date" name="date" value="${todayISO()}"></div>
      <div class="form-row"><label>${tr('Note (optionnel)')}</label><input type="text" name="note" maxlength="140"></div>
      <button type="submit" class="btn btn-primary btn-block">${tr('Enregistrer')}</button>
    </form>`, { title: tr('Remboursement — {name}', { name: d.personName }) });

  const form = modal.el.querySelector('#payment-form');
  const hintEl = modal.el.querySelector('#payment-split-hint');
  // Les intérêts courus ne sont qu'une ESTIMATION (taux qui varie, retard, franchise, intérêts renégociés…) : tant que
  // l'utilisateur n'a pas touché au champ « dont intérêts », il suit le montant versé (jamais plus que ce montant, le
  // reste est du capital) ; dès qu'il le modifie, sa valeur prime. Un versement qui ne couvre que des intérêts est permis.
  let interestTouched = prefill?.interest != null;
  const refreshHint = () => {
    if (!hintEl) return;
    const total = safeNumber(parseFloat(form.elements.amount.value));
    const interest = safeNumber(parseFloat(form.elements.interestPart.value));
    if (total > 0 && interest > total + 0.005) {
      hintEl.textContent = tr('Les intérêts ({interest}) dépassent le montant versé ({total}) : augmentez le montant versé ou corrigez les intérêts.', { interest: formatCurrency(interest, d.currency), total: formatCurrency(total, d.currency) });
      hintEl.classList.add('c-neg');
      return;
    }
    hintEl.classList.remove('c-neg');
    if (total > 0 && roundTo(total - interest, decimals) <= 0) hintEl.textContent = tr('Ce versement ne couvre que des intérêts : le capital restant dû ne baisse pas.');
    else hintEl.textContent = total > 0
      ? tr('Capital remboursé : {capital} · intérêts : {interest} (intérêts courus estimés : {accrued}, modifiable)', { capital: formatCurrency(Math.max(0, total - interest), d.currency), interest: formatCurrency(interest, d.currency), accrued: formatCurrency(suggestedInterest, d.currency) })
      : tr('Intérêts courus estimés depuis le dernier remboursement : {accrued}. Vous pouvez les modifier.', { accrued: formatCurrency(suggestedInterest, d.currency) });
  };
  // Source du remboursement (dettes uniquement) : tant que l'argent vient d'un portefeuille, on débite ce portefeuille
  // (comportement historique). Avec un revenu direct (activité, vente encaissée et reversée aussitôt) ou une personne qui
  // paie à ma place, AUCUN portefeuille ne bouge : seul le restant dû baisse — d'où un patrimoine net qui monte du
  // montant remboursé, ce qui est juste (de l'argent gagné ou donné a soldé la dette sans que mes actifs diminuent).
  const sourceSelect = form.elements.source;
  const walletRow = form.querySelector('[data-field="walletRow"]');
  const sourceNameRow = form.querySelector('[data-field="sourceNameRow"]');
  const sourceHint = form.querySelector('#payment-source-hint');
  const refreshSource = () => {
    const src = sourceSelect ? sourceSelect.value : 'wallet';
    walletRow.hidden = src !== 'wallet';
    form.elements.walletId.required = src === 'wallet';
    if (!sourceNameRow) return;
    sourceNameRow.hidden = src === 'wallet';
    form.elements.sourceName.required = src === 'third';
    form.querySelector('#payment-source-name-label').textContent = src === 'third' ? tr('Nom de la personne') : tr("D'où vient l'argent (optionnel)");
    form.elements.sourceName.placeholder = src === 'third' ? '' : tr('Ex : activité, vente…');
    sourceHint.textContent = src === 'wallet' ? ''
      : src === 'direct' ? tr("Aucun portefeuille n'est débité. Ce montant n'est pas compté dans vos revenus du mois.")
        : tr("Aucun portefeuille n'est débité : cette personne règle une partie de votre dette (sa participation).");
  };
  if (sourceSelect) { sourceSelect.addEventListener('change', refreshSource); refreshSource(); }

  if (hintEl) {
    form.elements.interestPart.addEventListener('input', () => { interestTouched = true; });
    form.elements.amount.addEventListener('input', () => {
      if (interestTouched || !(suggestedInterest > 0)) return;
      const total = safeNumber(parseFloat(form.elements.amount.value));
      form.elements.interestPart.value = total > 0 ? String(Math.min(suggestedInterest, total)) : String(suggestedInterest);
    });
    form.addEventListener('input', refreshHint);
    refreshHint();
  }

  onceSubmit(form, async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    // Seule une dette peut être réglée hors portefeuille ; une créance encaissée entre toujours dans un portefeuille.
    const source = d.type === 'debt' ? (fd.get('source') || 'wallet') : 'wallet';
    const sourceName = String(fd.get('sourceName') || '').trim().slice(0, 60);
    const walletId = source === 'wallet' ? fd.get('walletId') : null;
    if (source === 'wallet' && !walletId) { showToast(tr("Créez d'abord un portefeuille en {currency}.", { currency: d.currency })); return; }
    if (source === 'third' && !sourceName) { showToast(tr('Indiquez qui a payé.')); return; }
    const total = safeNumber(parseFloat(fd.get('amount')));
    if (!(total > 0)) { showToast(tr('Saisissez un montant supérieur à 0.')); return; }
    // Le capital remboursé (= total − intérêts) fait baisser le restant dû ; les intérêts sont une charge à part.
    const interestPart = hasInterest ? roundTo(Math.max(0, safeNumber(parseFloat(fd.get('interestPart')))), decimals) : 0;
    const principalPart = roundTo(total - interestPart, decimals);
    if (hasInterest && interestPart > total + 0.005) { showToast(tr('Les intérêts ({interest}) dépassent le montant versé ({total}) : augmentez le montant versé ou corrigez les intérêts.', { interest: formatCurrency(interestPart, d.currency), total: formatCurrency(total, d.currency) })); return; }
    // Un versement d'intérêts seuls est légitime (le capital ne bouge pas) ; sans intérêts, il faut du capital.
    if (principalPart < 0 || (principalPart === 0 && !(interestPart > 0))) { showToast(tr('Saisissez un montant supérieur à 0.')); return; }
    const payment = { id: uuid(), debtId: d.id, amount: principalPart, interestPart: interestPart || 0, date: fd.get('date') || todayISO(), note: (fd.get('note') || '').trim().slice(0, 140) };
    // Remboursement hors portefeuille : on garde d'où vient l'argent (absent = portefeuille, comme tous les anciens).
    if (source !== 'wallet') { payment.source = source; payment.sourceName = sourceName; }
    // Rembourser plus que le restant dû fabriquerait une transaction de portefeuille sans contrepartie
    // (la dette passerait en négatif) : on refuse plutôt que de fausser le solde.
    const paidBefore = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === d.id);
    const owed = remaining(d, paidBefore);
    if (payment.amount > owed + 0.005) { showToast(tr('Le remboursement ({amount}) dépasse le restant dû ({owed}).', { amount: formatCurrency(payment.amount, d.currency), owed: formatCurrency(owed, d.currency) })); return; }

    const paymentTxType = d.type === 'debt' ? 'expense' : 'income';
    const paymentTx = {
      id: uuid(),
      type: paymentTxType,
      walletId,
      targetWalletId: null,
      categoryId: await ensureDebtCategoryId(d.type, paymentTxType),
      amount: payment.amount,
      date: payment.date,
      note: tr('Remboursement — {name}', { name: d.personName }),
      tags: [],
      reconciled: false,
      debtId: d.id,
      debtPaymentId: payment.id,
      createdAt: new Date().toISOString(),
    };
    const interestTx = interestPart > 0 && source === 'wallet' ? {
      id: uuid(),
      type: paymentTxType,
      walletId,
      targetWalletId: null,
      categoryId: await ensureLoanInterestCategoryId(paymentTxType),
      amount: interestPart,
      date: payment.date,
      note: tr('Intérêts — {name}', { name: d.personName }),
      tags: [],
      reconciled: false,
      debtInterestId: d.id, // rattaché à la dette (suppression en cascade, verrouillage à la modification) SANS debtId : compte dans les dépenses/revenus
      debtPaymentId: payment.id,
      // Prêt qui finance une dépense exceptionnelle : ses intérêts le sont aussi (hors discipline mensuelle).
      ...(d.exceptional ? { exceptional: true } : {}),
      createdAt: new Date().toISOString(),
    } : null;

    const existingPayments = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === d.id);
    const rem = remaining(d, [...existingPayments, payment]);
    const willBePaid = rem <= 0.005 && d.status !== 'paid';
    const debtBefore = willBePaid ? { ...d } : null;
    if (willBePaid) d.status = 'paid';

    // Une seule transaction IndexedDB pour toutes les écritures : soit toutes appliquées, soit aucune —
    // sans ça, une interruption pile entre deux `await dbAdd` séparés pouvait laisser une ligne
    // DEBT_PAYMENTS enregistrée sans sa transaction de portefeuille correspondante (la dette paraîtrait
    // remboursée alors que l'argent n'aurait jamais bougé), voir dbWriteBatch (db.js).
    const operations = [
      { store: STORES.DEBT_PAYMENTS, type: 'add', value: payment },
    ];
    if (payment.amount > 0 && source === 'wallet') operations.push({ store: STORES.TRANSACTIONS, type: 'add', value: paymentTx });
    if (interestTx) operations.push({ store: STORES.TRANSACTIONS, type: 'add', value: interestTx });
    operations.push(...await keptReturnOps(d, payment, payment.amount + interestPart));
    if (willBePaid) operations.push({ store: STORES.DEBTS, type: 'put', value: d });
    await dbWriteBatch(operations);

    await logAudit({ entityType: 'debtPayment', entityId: payment.id, action: 'create', after: payment });
    if (payment.amount > 0 && source === 'wallet') await logAudit({ entityType: 'transaction', entityId: paymentTx.id, action: 'create', after: paymentTx, note: tr('Remboursement de dette/créance') });
    if (interestTx) await logAudit({ entityType: 'transaction', entityId: interestTx.id, action: 'create', after: interestTx, note: tr("Intérêts d'un prêt") });
    if (willBePaid) await logAudit({ entityType: 'debt', entityId: d.id, action: 'update', before: debtBefore, after: d, note: tr('Soldée') });

    modal.close();
    showToast(tr('Remboursement enregistré.'));
    // Hors portefeuille : aucune transaction créée, mais le patrimoine net change → on prévient toutes les vues.
    notifyDataChanged(interestTx || source !== 'wallet' ? 'all' : 'debts');
  });
}

/** Participation reçue d'un participant à un prêt partagé (voir shared-loan.js). Deux cas :
    - « versée directement au prêteur » : un remboursement de source « participant », aucun portefeuille ne bouge ;
    - « remise à moi » : l'argent entre dans l'un de mes portefeuilles (mouvement lié à la dette, donc hors revenus du
      mois) et la dette ne baisse pas encore — je rembourserai ensuite moi-même, par le bouton habituel. */
async function openContributionModal(d) {
  const [wallets, allPayments] = await Promise.all([dbGetAll(STORES.WALLETS), dbGetAll(STORES.DEBT_PAYMENTS)]);
  const statuses = participantStatuses(d, allPayments).filter((x) => x.owed > 0.005);
  if (!statuses.length) { showToast(tr('Tous les participants ont réglé leur part.')); return; }
  const modal = openModal(`
    <form id="contribution-form">
      <div class="form-row"><label>${tr('Participant')}</label>
        <select name="participantId">${statuses.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)} — ${tr('reste {amount}', { amount: amountForOption(x.owed, d.currency) })}</option>`).join('')}</select></div>
      <div class="form-row"><label>${tr('Montant reçu')}</label><input type="number" step="0.01" min="0" name="amount" required value="${statuses[0].owed}"></div>
      <div class="form-row"><label>${tr('Comment a-t-il payé ?')}</label>
        <select name="mode">
          <option value="direct">${tr('Directement au prêteur (aucun portefeuille ne bouge)')}</option>
          <option value="handed">${tr("Il m'a remis l'argent (entre dans un de mes portefeuilles)")}</option>
          <option value="waive">${tr('Il ne paiera pas : abandonner sa part (ou une partie)')}</option>
        </select>
        <p class="fs-12 c-muted mt-6" data-field="waiveHint" hidden>${tr("Aucun argent ne bouge : la créance sur lui baisse, et c'est une perte pour vous (vous devez toujours tout au prêteur).")}</p></div>
      <div class="form-row" data-field="walletRow" hidden><label>${tr('Portefeuille')}</label><select name="walletId">${walletOptionsHtml(wallets.filter(isDailyWallet), d.currency)}</select></div>
      <div class="form-row"><label>${tr('Date')}</label><input type="date" name="date" value="${todayISO()}"></div>
      <div class="form-row"><label>${tr('Note (optionnel)')}</label><input type="text" name="note" maxlength="140"></div>
      <button type="submit" class="btn btn-primary btn-block">${tr('Enregistrer')}</button>
    </form>`, { title: tr('Participation reçue — {name}', { name: d.personName }) });

  const form = modal.el.querySelector('#contribution-form');
  const walletRow = form.querySelector('[data-field="walletRow"]');
  const syncMode = () => {
    walletRow.hidden = form.elements.mode.value !== 'handed';
    form.querySelector('[data-field="waiveHint"]').hidden = form.elements.mode.value !== 'waive';
  };
  form.elements.mode.addEventListener('change', syncMode);
  // Le montant proposé suit le reste dû du participant choisi.
  form.elements.participantId.addEventListener('change', () => {
    const st = statuses.find((x) => x.id === form.elements.participantId.value);
    if (st) form.elements.amount.value = st.owed;
  });

  onceSubmit(form, async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const st = statuses.find((x) => x.id === fd.get('participantId'));
    const amount = roundTo(safeNumber(parseFloat(fd.get('amount'))), decimalsOf(d.currency));
    const mode = fd.get('mode');
    const date = fd.get('date') || todayISO();
    const note = String(fd.get('note') || '').trim().slice(0, 140);
    if (!st || !(amount > 0)) { showToast(tr('Saisissez un montant supérieur à 0.')); return; }
    if (amount > st.owed + 0.005) { showToast(tr('Ce montant ({amount}) dépasse ce que {name} doit encore ({owed}).', { amount: formatCurrency(amount, d.currency), name: st.name, owed: formatCurrency(st.owed, d.currency) })); return; }

    if (mode === 'waive') {
      // Part abandonnée : aucune transaction, aucun remboursement — seule la créance sur ce participant baisse.
      const entry = { id: uuid(), participantId: st.id, amount, date, note };
      const record = { ...d, waived: [...(d.waived || []), entry] };
      await dbWriteBatch([{ store: STORES.DEBTS, type: 'put', value: record }]);
      await logAudit({ entityType: 'debt', entityId: d.id, action: 'update', before: d, after: record, note: tr('Part abandonnée (prêt partagé)') });
    } else if (mode === 'direct') {
      // Réglé directement au prêteur : une ligne de remboursement, sans transaction de portefeuille.
      const owedToLender = remaining(d, allPayments.filter((p) => p.debtId === d.id));
      if (amount > owedToLender + 0.005) { showToast(tr('Le remboursement ({amount}) dépasse le restant dû ({owed}).', { amount: formatCurrency(amount, d.currency), owed: formatCurrency(owedToLender, d.currency) })); return; }
      const payment = { id: uuid(), debtId: d.id, amount, interestPart: 0, date, note, source: 'participant', sourceName: st.name, participantId: st.id };
      const willBePaid = owedToLender - amount <= 0.005 && d.status !== 'paid';
      const record = willBePaid ? { ...d, status: 'paid' } : null;
      await dbWriteBatch([
        { store: STORES.DEBT_PAYMENTS, type: 'add', value: payment },
        ...(await keptReturnOps(d, payment, amount)),
        ...(record ? [{ store: STORES.DEBTS, type: 'put', value: record }] : []),
      ]);
      await logAudit({ entityType: 'debtPayment', entityId: payment.id, action: 'create', after: payment, note: tr('Participation versée directement au prêteur') });
      if (record) await logAudit({ entityType: 'debt', entityId: d.id, action: 'update', before: d, after: record, note: tr('Soldée') });
    } else {
      const walletId = fd.get('walletId');
      if (!walletId) { showToast(tr("Créez d'abord un portefeuille en {currency}.", { currency: d.currency })); return; }
      const contribution = { id: uuid(), participantId: st.id, amount, date };
      const tx = {
        id: uuid(), type: 'income', walletId, targetWalletId: null,
        categoryId: await ensureDebtCategoryId('debt', 'income'),
        amount, date,
        note: tr('Participation de {name} — {debt}', { name: st.name, debt: d.personName }),
        tags: [], reconciled: false,
        debtId: d.id, // lié à la dette : exclu des revenus du mois, comme tout mouvement de dette
        debtContributionId: contribution.id,
        createdAt: new Date().toISOString(),
      };
      contribution.transactionId = tx.id;
      const record = { ...d, handedIn: [...(d.handedIn || []), contribution] };
      await dbWriteBatch([
        { store: STORES.TRANSACTIONS, type: 'add', value: tx },
        { store: STORES.DEBTS, type: 'put', value: record },
      ]);
      await logAudit({ entityType: 'transaction', entityId: tx.id, action: 'create', after: tx, note: tr('Participation remise (prêt partagé)') });
      await logAudit({ entityType: 'debt', entityId: d.id, action: 'update', before: d, after: record, note: tr('Participation remise (prêt partagé)') });
    }
    modal.close();
    showToast(tr('Participation enregistrée.'));
    notifyDataChanged('all');
  });
}

/** Annulation d'une dette/créance : explique ce que ça fait (et ne fait pas) avant de confirmer. */
async function openCancelDebtModal(d) {
  const payments = await dbGetAll(STORES.DEBT_PAYMENTS);
  const left = remaining(d, payments.filter((p) => p.debtId === d.id));
  const isDebt = d.type === 'debt';
  const modal = openModal(`
    <form id="cancel-debt-form">
      <p class="fs-13" style="margin:0 0 10px;">${isDebt
        ? tr('Vous n\'avez plus à rembourser les {amount} restants à {name}.', { amount: formatCurrency(left, d.currency), name: escapeHtml(d.personName) })
        : tr('{name} n\'a plus à vous rembourser les {amount} restants.', { amount: formatCurrency(left, d.currency), name: escapeHtml(d.personName) })}</p>
      <p class="fs-12 c-muted" style="margin:0 0 12px;">${tr('Aucun mouvement n\'est ajouté dans vos portefeuilles : le prêt / l\'emprunt d\'origine et les remboursements déjà faits restent dans l\'historique. Vous pourrez rétablir la dette depuis la liste « Annulées ».')}</p>
      <div class="form-row"><label>${tr('Date d\'annulation')}</label><input type="date" name="date" value="${todayISO()}"></div>
      <div class="form-row"><label>${tr('Motif (optionnel)')}</label><input type="text" name="note" maxlength="140"></div>
      <button type="submit" class="btn btn-primary btn-block">${tr('Annuler la dette')}</button>
    </form>`, { title: tr('Annulation — {name}', { name: d.personName }) });
  modal.el.querySelector('#cancel-debt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await cancelDebt(d, { date: fd.get('date') || todayISO(), note: (fd.get('note') || '').trim().slice(0, 140) });
    modal.close();
    showToast(tr('Dette annulée.'));
    notifyDataChanged('debts');
  });
}

/** Échéancier d'un prêt à intérêts : chaque mensualité (capital + intérêts), son état au regard de ce qui a
    déjà été versé, le total des intérêts prévus, et un bouton pour enregistrer la prochaine mensualité. */
async function openScheduleModal(d) {
  const payments = await dbGetAll(STORES.DEBT_PAYMENTS);
  const snap = loanSnapshot(d, payments);
  if (!snap.status) { showToast(tr("Indiquez la durée du prêt (Modifier) pour obtenir l'échéancier.")); return; }
  const cur = d.currency;
  const badge = (status) => status === 'paid'
    ? `<span class="badge badge-pos">${tr('Payée')}</span>`
    : status === 'due' ? `<span class="badge badge-neg">${tr('En retard')}</span>` : `<span class="badge">${tr('À venir')}</span>`;
  const next = snap.status.next;
  const modal = openModal(`
    <div class="stat-row"><span class="stat-row-label">${tr('Mensualité')}</span><strong class="amount">${formatCurrency(snap.schedule.payment, cur)}</strong></div>
    <div class="stat-row"><span class="stat-row-label">${tr('Total des intérêts prévus')}</span><span class="amount">${formatCurrency(snap.schedule.totalInterest, cur)}</span></div>
    <div class="stat-row"><span class="stat-row-label">${tr('Coût total du prêt')}</span><span class="amount">${formatCurrency(snap.schedule.totalPaid, cur)}</span></div>
    ${snap.status.shortfall > 0.005 ? `<p class="alert alert-warn mt-8">${tr('Retard : il manque {amount} pour être à jour des échéances passées.', { amount: formatCurrency(snap.status.shortfall, cur) })}</p>` : ''}
    <div class="schedule-list mt-10">
      ${snap.status.rows.map((row) => `
        <div class="tx-row">
          <div class="tx-main"><div class="tx-title">${row.index}. ${formatDate(row.date)}</div>
            <div class="tx-sub">${tr('Capital {principal} · intérêts {interest} · restant {balance}', { principal: formatCurrency(row.principal, cur), interest: formatCurrency(row.interest, cur), balance: formatCurrency(row.balance, cur) })}</div></div>
          <div class="tx-amount amount">${formatCurrency(row.payment, cur)}</div>
          ${badge(row.status)}
        </div>`).join('')}
    </div>
    ${next ? `<button type="button" class="btn btn-primary btn-block mt-12" id="schedule-pay-btn">${tr('Enregistrer la prochaine mensualité')}</button>` : ''}`,
  { title: tr('Échéancier — {name}', { name: d.personName }) });
  modal.el.querySelector('#schedule-pay-btn')?.addEventListener('click', () => {
    modal.close();
    openPaymentModal(d, { prefill: { total: next.payment, interest: next.interest } });
  });
}

/* ---------- Simulateur Avalanche / Boule de neige ---------- */
function simulateRepayment(debts, payments, monthlyBudget, method, rates, baseCurrency) {
  const list = debts
    .filter((d) => d.type === 'debt' && d.status === 'active')
    .map((d) => ({
      id: d.id,
      name: d.personName,
      balance: convertAmount(remaining(d, payments), d.currency, baseCurrency, rates, baseCurrency),
      rate: (d.interestRate || 0) / 100 / 12,
    }))
    .filter((d) => d.balance > 0.005);

  if (method === 'avalanche') list.sort((a, b) => b.rate - a.rate);
  else list.sort((a, b) => a.balance - b.balance);

  let month = 0, totalInterest = 0;
  const payoffMonth = {};
  while (list.some((d) => d.balance > 0.005) && month < 600) {
    month++;
    for (const d of list) {
      if (d.balance > 0) { const interest = d.balance * d.rate; d.balance += interest; totalInterest += interest; }
    }
    let budget = monthlyBudget;
    for (const d of list) {
      if (d.balance <= 0 || budget <= 0) continue;
      const pay = Math.min(budget, d.balance);
      d.balance -= pay;
      budget -= pay;
      if (d.balance <= 0.005 && !payoffMonth[d.id]) payoffMonth[d.id] = month;
    }
  }
  return {
    months: month,
    maxedOut: month >= 600,
    totalInterest,
    order: list.map((d) => ({ name: d.name, payoffMonth: payoffMonth[d.id] || null })).sort((a, b) => (a.payoffMonth || 999) - (b.payoffMonth || 999)),
  };
}

function renderSimulatorResult(result, method, currency) {
  if (result.maxedOut) {
    return `<div class="alert alert-danger">${tr('Avec ce budget mensuel, les intérêts dépassent votre capacité de remboursement ({method}). Augmentez le montant mensuel.', { method })}</div>`;
  }
  const years = (result.months / 12).toFixed(1);
  return `
    <div class="panel mb-12">
      <div class="panel-header"><h3>${method === 'avalanche' ? tr("Avalanche (taux le plus élevé d'abord)") : tr("Boule de neige (plus petit montant d'abord)")}</h3></div>
      <div class="stat-row"><span class="stat-row-label">${tr('Durée totale estimée')}</span><span>${tr('{months} mois (~{years} ans)', { months: result.months, years })}</span></div>
      <div class="stat-row"><span class="stat-row-label">${tr('Intérêts totaux payés')}</span><span>${formatCurrency(result.totalInterest, currency)}</span></div>
      <div class="mt-8 fs-13 c-muted">
        ${tr('Ordre de remboursement : {list}', { list: result.order.map((o, i) => `${i + 1}. ${escapeHtml(o.name)} (${tr('mois {n}', { n: o.payoffMonth || '—' })})`).join(' · ') })}
      </div>
    </div>`;
}

async function renderSimulator(container) {
  const { baseCurrency } = await getExchangeRates();
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${tr('Simulateur de remboursement stratégique')}</h3></div>
      <div class="form-row" style="max-width:260px;">
        <label>${tr('Budget mensuel disponible (en {currency}) pour rembourser vos dettes', { currency: escapeHtml(baseCurrency) })}</label>
        <input type="number" min="0" step="10" id="sim-budget" value="200">
      </div>
      <button type="button" class="btn btn-primary" id="sim-run-btn">${tr('Comparer Avalanche vs Boule de neige')}</button>
    </div>
    <div id="sim-results"></div>`;

  container.querySelector('#sim-run-btn').addEventListener('click', async () => {
    const budget = parseFloat(container.querySelector('#sim-budget').value) || 0;
    const [debts, payments, { rates, baseCurrency: base }] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS), getExchangeRates()]);
    const avalanche = simulateRepayment(debts, payments, budget, 'avalanche', rates, base);
    const snowball = simulateRepayment(debts, payments, budget, 'snowball', rates, base);
    const results = document.getElementById('sim-results');
    results.innerHTML = renderSimulatorResult(avalanche, 'avalanche', base) + renderSimulatorResult(snowball, 'snowball', base);
  });
}

export async function renderDebts() {
  const container = document.getElementById('debts-content');
  if (!container) return;
  const [debts, payments, investments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS), dbGetAll(STORES.INVESTMENTS)]);
  const investmentNames = new Map(investments.map((i) => [i.id, i.name]));

  const activeDebts = debts.filter((d) => d.status !== 'paid' && d.status !== 'cancelled');
  const paidDebts = debts.filter((d) => d.status === 'paid');
  const cancelledDebts = debts.filter((d) => d.status === 'cancelled');

  const cardsHtml = activeDebts.length
    ? `<div class="grid-cards mb-20">${activeDebts.map((d) => debtCardHtml(d, payments, investmentNames.get(d.investmentId) || null)).join('')}</div>`
    : `<div class="empty-state">${tr('Aucune dette ni créance active.')}</div>`;

  const hasDebts = debts.some((d) => d.type === 'debt');
  const chartHtml = hasDebts
    ? `<div class="chart-card mb-20"><h3>${tr('Évolution du désendettement')}</h3><div class="chart-canvas-wrap"><canvas id="chart-debts-trend"></canvas></div></div>`
    : '';

  const paidHtml = paidDebts.length
    ? `<div class="panel mt-20">
        <div class="panel-header"><h3>${tr('Soldées')}</h3></div>
        ${paidDebts
          .map((d) => ({ d, paidDate: latestPaymentDate(d, payments) }))
          .sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''))
          .map(({ d, paidDate }) => paidDebtRowHtml(d, paidDate))
          .join('')}
      </div>`
    : '';

  const cancelledHtml = cancelledDebts.length
    ? `<div class="panel mt-20">
        <div class="panel-header"><h3>${tr('Annulées')}</h3></div>
        <p class="fs-12 c-muted" style="margin:0 0 8px;">${tr('Dettes et créances effacées sans remboursement : l\'historique reste, aucun mouvement de portefeuille n\'a été ajouté.')}</p>
        ${cancelledDebts
          .sort((a, b) => (b.cancelledAt || '').localeCompare(a.cancelledAt || ''))
          .map(cancelledDebtRowHtml)
          .join('')}
      </div>`
    : '';

  // « Par personne » : la page du cahier où l'on voit, d'un coup d'œil, qui doit quoi à qui.
  const people = summarizePeople(debts, payments);
  const peopleHtml = people.length
    ? `<div class="panel mb-20">
        <div class="panel-header"><h3>${tr('Par personne')}</h3></div>
        ${people.map((p) => {
          const lines = Object.entries(p.balances).filter(([, v]) => v !== 0).map(([cur, v]) => v > 0
            ? `<span class="pos">${tr('vous doit {amount}', { amount: formatCurrency(v, cur) })}</span>`
            : `<span class="neg">${tr('vous lui devez {amount}', { amount: formatCurrency(-v, cur) })}</span>`).join(' · ');
          return `<button type="button" class="tx-row person-row" data-person-open="${escapeHtml(p.name)}">
            <div class="tx-main"><div class="tx-title">${escapeHtml(p.name)}</div><div class="tx-sub">${lines}</div></div>
            <span class="tx-sub">›</span></button>`;
        }).join('')}
      </div>`
    : '';

  container.innerHTML = `${peopleHtml}${cardsHtml}${chartHtml}<div id="debts-simulator"></div>${paidHtml}${cancelledHtml}`;

  if (hasDebts) {
    const { baseCurrency } = await getExchangeRates();
    const history = await computeDebtHistory(6);
    renderNetWorthTrendChart('chart-debts-trend', history, baseCurrency, tr('Dette restante'));
  }

  await renderSimulator(document.getElementById('debts-simulator'));
}

/** Fiche d'une personne : relevé, relance WhatsApp, remboursement et nouvelle dette depuis la fiche. */
async function openPerson(personName) {
  const [debts, payments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);
  await openPersonLedger(personName, debts, payments, {
    onPay: (debt) => openPaymentModal(debt),
    onAcknowledge: async (debt) => openDebtAcknowledgementModal(debt, await dbGetAll(STORES.DEBT_PAYMENTS)),
    onNew: (name) => openDebtModal(null, { personName: name }),
  });
}

export function initDebtsModule() {
  document.getElementById('debt-add-btn')?.addEventListener('click', () => openDebtModal());

  document.getElementById('debts-content')?.addEventListener('click', async (e) => {
    const personRow = e.target.closest('[data-person-open]');
    if (personRow) { openPerson(personRow.dataset.personOpen); return; }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('[data-debt-id]');
    if (!card) return;
    const debts = await dbGetAll(STORES.DEBTS);
    const d = debts.find((x) => x.id === card.dataset.debtId);
    if (!d) return;

    if (btn.dataset.action === 'remind') {
      openPersonReminder(d.personName, debts, await dbGetAll(STORES.DEBT_PAYMENTS));
    } else if (btn.dataset.action === 'person') {
      openPerson(d.personName);
    } else if (btn.dataset.action === 'pay') {
      openPaymentModal(d);
    } else if (btn.dataset.action === 'contribution') {
      openContributionModal(d);
    } else if (btn.dataset.action === 'schedule') {
      openScheduleModal(d);
    } else if (btn.dataset.action === 'acknowledge') {
      openDebtAcknowledgementModal(d, await dbGetAll(STORES.DEBT_PAYMENTS));
    } else if (btn.dataset.action === 'export') {
      openProofExportModal(() => buildDebtProof(d));
    } else if (btn.dataset.action === 'edit') {
      openDebtModal(d);
    } else if (btn.dataset.action === 'cancel') {
      openCancelDebtModal(d);
    } else if (btn.dataset.action === 'restore') {
      await restoreCancelledDebt(d);
      showToast(tr('Annulation retirée.'));
      notifyDataChanged('debts');
    } else if (btn.dataset.action === 'delete') {
      // Un prêt créé par un projet collectif se retire depuis le projet : le supprimer ici laisserait la participation
      // comptée dans le projet, sa dépense dans les transactions et la sortie dans le compte gardé.
      if (d.projectId) { showToast(tr('Ce prêt appartient à un projet collectif : retirez la participation depuis Partage de dépenses.')); return; }
      const ok = await confirmDialog(tr('Supprimer "{name}" et tout son historique de remboursement (et les mouvements de portefeuille associés) ?', { name: d.personName }), { danger: true, requirePin: true, confirmText: tr('Supprimer') });
      if (ok) {
        const removed = await deleteDebtCascade(d.id);
        if (!removed) return;
        notifyDataChanged('debts');
        showToast(tr('Supprimé.'), {
          actionLabel: tr('Annuler'),
          onAction: async () => {
            await dbAdd(STORES.DEBTS, removed.debt);
            for (const p of removed.payments) await dbAdd(STORES.DEBT_PAYMENTS, p);
            for (const t of removed.linkedTx) await dbAdd(STORES.TRANSACTIONS, t);
            for (const e of removed.keptEntries || []) await dbAdd(STORES.KEPT_ACCOUNT_ENTRIES, e);
            await logAudit({ entityType: 'debt', entityId: d.id, action: 'create', after: d, note: tr('Restaurée (annulation)') });
            showToast(tr('Restauré.'));
            notifyDataChanged('debts');
          },
        });
      }
    }
  });
}
