/* ==========================================================================
   Djignan Financial System — Module Investissements
   Capital investi vs valeur actuelle, ROI %, dividendes, et tableau
   comparatif du rendement annualisé (yield) par classe d'actif.
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbDelete, dbAdd, logAudit, getSetting, setSetting } from '../db.js';
import { investmentValueAsOf, getExchangeRates, computeInvestmentValueHistory, isDailyWallet } from '../ledger.js';
import { uuid, formatCurrency, formatDate, formatPercent, escapeHtml, todayISO, convertAmount, openModal, confirmDialog, showToast, currencySelectHtml, wireCurrencySelect, readCurrencyValue, safeNumber } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { renderNetWorthTrendChart } from '../charts.js';
import { openProofExportModal, PRINT_ICON } from '../proof-export.js';
import { createLinkedDebt, openPaymentModal } from './debts.js';
import { t } from '../i18n.js';
import { icon as svgIcon } from '../icons.js';

// Les valeurs (libellés affichés) sont traduites à l'usage via t(...), jamais les clés
// (immobilier/actions/...) : ces clés sont les valeurs stockées en base (inv.assetClass), pas du
// texte d'interface.
export const ASSET_CLASSES = {
  immobilier: 'Immobilier',
  actions: 'Actions',
  flotte: 'Flotte / Transport',
  business: 'Business',
  obligations: 'Obligations',
  crypto: 'Cryptomonnaies',
  autre: 'Autre',
};

// Immobilier et véhicules sont des biens physiques valorisés périodiquement (pas de
// marché liquide), à distinguer visuellement des actifs financiers dans la liste —
// mais ils restent suivis avec exactement le même mécanisme (mêmes stores/calculs),
// pas de duplication de données.
const PHYSICAL_ASSET_CLASSES = ['immobilier', 'flotte'];
let assetFilter = 'all'; // 'all' | 'physical' | 'financial'

// Mêmes conventions que ASSET_CLASSES ci-dessus : les clés sont stockées en base (entry.type), les
// valeurs (libellés) sont traduites à l'usage via t(...).
export const ENTRY_TYPE_LABELS = { contribution: 'Apport', withdrawal: 'Retrait', dividend: 'Dividende', valuation: 'Valorisation' };
const EDIT_ICON = svgIcon('edit', 16);
const DELETE_ICON = svgIcon('trash', 16);
const HISTORY_ICON = svgIcon('history', 16);

function walletOptionsHtml(wallets, currency) {
  const matching = wallets.filter((w) => w.currency === currency);
  if (!matching.length) return `<option value="">${t('Aucun portefeuille en {currency}', { currency: escapeHtml(currency) })}</option>`;
  return matching.map((w) => `<option value="${w.id}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('');
}

/* ---------- Répartition d'un mouvement d'argent sur plusieurs portefeuilles ----------
   Réutilisé par le formulaire d'achat (création d'investissement) et par le formulaire
   d'apport/dividende de l'historique — même pattern que le mode scindé par catégorie de
   transactions.js, mais scindé par PORTEFEUILLE : chaque ligne devient sa propre transaction,
   toutes partageant investmentId (+ investmentEntryId pour les apports/dividendes) et un
   splitGroupId commun, uniquement pour un affichage/regroupement futur éventuel. */
function walletSplitRowHtml(wallets, currency, optionsHtml = null) {
  return `<div data-split-row style="display:flex;gap:8px;align-items:center;" class="mb-8">
    <select class="split-wallet" style="flex:2;">${optionsHtml ?? walletOptionsHtml(wallets, currency)}</select>
    <input type="number" step="0.01" min="0" class="split-amount" placeholder="0.00" style="flex:1;">
    <button type="button" class="icon-btn split-remove" aria-label="${t('Retirer')}">${DELETE_ICON}</button>
  </div>`;
}

/** Câble un bloc "répartir sur plusieurs portefeuilles" : bouton de bascule, lignes
    portefeuille/montant dynamiques, total courant. `getWallets`/`getCurrency` sont des fonctions
    (pas des valeurs figées) car la devise peut changer après ouverture du formulaire. */
function wireWalletSplit({ toggleBtn, singleSelect, splitWrap, listEl, addBtn, totalEl, getWallets, getCurrency, getOptionsHtml = null }) {
  let splitMode = false;
  // `getOptionsHtml` (optionnel) remplace la liste de portefeuilles par défaut : un dividende peut
  // aussi être RÉINVESTI directement (autre investissement), destination qui n'est pas un
  // portefeuille — voir dividendDestinationOptionsHtml.
  const optionsFor = () => (getOptionsHtml ? getOptionsHtml() : null);

  function updateTotal() {
    const rows = [...listEl.querySelectorAll('[data-split-row]')];
    const sum = rows.reduce((s, row) => s + (parseFloat(row.querySelector('.split-amount').value) || 0), 0);
    totalEl.textContent = t('Total réparti : {sum}', { sum: sum.toFixed(2) });
    return sum;
  }

  function addRow() {
    const wrap = document.createElement('div');
    wrap.innerHTML = walletSplitRowHtml(getWallets(), getCurrency(), optionsFor());
    const row = wrap.firstElementChild;
    listEl.appendChild(row);
    row.querySelector('.split-amount').addEventListener('input', updateTotal);
    row.querySelector('.split-remove').addEventListener('click', () => { row.remove(); updateTotal(); });
  }

  function refreshRowWallets() {
    const wallets = getWallets();
    const currency = getCurrency();
    listEl.querySelectorAll('[data-split-row]').forEach((row) => {
      const sel = row.querySelector('.split-wallet');
      const prevVal = sel.value;
      sel.innerHTML = optionsFor() ?? walletOptionsHtml(wallets, currency);
      if ([...sel.options].some((o) => o.value === prevVal)) sel.value = prevVal;
    });
  }

  function setSplitMode(on) {
    splitMode = on;
    singleSelect.hidden = splitMode;
    splitWrap.hidden = !splitMode;
    toggleBtn.textContent = splitMode ? t('Revenir à un seul portefeuille') : t('Répartir sur plusieurs portefeuilles');
    if (splitMode && !listEl.children.length) { addRow(); addRow(); updateTotal(); }
  }

  toggleBtn.addEventListener('click', () => setSplitMode(!splitMode));
  addBtn.addEventListener('click', () => { addRow(); updateTotal(); });

  return {
    isSplit: () => splitMode,
    refreshRowWallets,
    getRows: () => [...listEl.querySelectorAll('[data-split-row]')]
      .map((row) => ({ walletId: row.querySelector('.split-wallet').value, amount: safeNumber(parseFloat(row.querySelector('.split-amount').value)) }))
      .filter((r) => r.walletId && r.amount > 0),
  };
}

// Mêmes variantes FR/EN qu'ensureDebtCategoryId (debts.js) : une note créée en anglais ne doit pas
// faire naître une seconde catégorie "Investment" à côté de "Investissement" déjà existante.
const INVESTMENT_CATEGORY_NAME_VARIANTS = ['Investissement', 'Investment'];

/** Retrouve (ou crée) la catégorie "Investissement" pour le type de transaction donné (achat =
    expense, dividende = income — les catégories sont scindées par type). Même rôle que
    ensureDebtCategoryId (debts.js) : les mouvements de portefeuille liés à un investissement
    n'apparaissent jamais "Sans catégorie", tout en restant exclus des agrégats budgétaires côté
    dépense (voir ledger.js, filtré via investmentId, pas via la catégorie). */
export async function ensureInvestmentCategoryId(txType) {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const existing = categories.find((c) => c.type === txType && INVESTMENT_CATEGORY_NAME_VARIANTS.includes(c.name));
  if (existing) return existing.id;
  const category = { id: uuid(), name: t('Investissement'), type: txType, parentId: null, createdAt: new Date().toISOString() };
  await dbAdd(STORES.CATEGORIES, category);
  return category.id;
}

function computeMetrics(inv, entries) {
  const own = entries.filter((e) => e.investmentId === inv.id);
  const contributions = own.filter((e) => e.type === 'contribution').reduce((s, e) => s + e.amount, 0);
  const withdrawals = own.filter((e) => e.type === 'withdrawal').reduce((s, e) => s + e.amount, 0);
  const dividends = own.filter((e) => e.type === 'dividend').reduce((s, e) => s + e.amount, 0);
  const netInvested = (inv.capitalInvested || 0) + contributions - withdrawals;
  const currentValue = investmentValueAsOf(inv, entries, null);
  const gain = currentValue - netInvested + dividends;
  const roiPct = netInvested ? (gain / netInvested) * 100 : 0;
  const yearsHeld = Math.max((Date.now() - new Date(inv.createdAt).getTime()) / (365.25 * 24 * 3600 * 1000), 1 / 12);
  const annualizedYieldPct = roiPct / yearsHeld;
  return { netInvested, currentValue, dividends, gain, roiPct, annualizedYieldPct };
}

/** Fiche à exporter (PDF/Excel) pour cet investissement : voir proof-export.js pour le format. */
async function buildInvestmentProof(inv) {
  const [allEntries, profile, allDebts, allDebtPayments] = await Promise.all([dbGetAll(STORES.INVESTMENT_ENTRIES), getSetting('userProfile', {}), dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);
  const loan = loansFor(inv, allDebts, allDebtPayments);
  const loanNameById = new Map((loan?.loans || []).map((l) => [l.debt.id, l.debt.personName]));
  const loanPayments = loan ? allDebtPayments.filter((p) => loanNameById.has(p.debtId)).sort((a, b) => (a.date || '').localeCompare(b.date || '')) : [];
  const own = allEntries
    .filter((e) => e.investmentId === inv.id)
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
  const metrics = computeMetrics(inv, allEntries);
  const cur = inv.currency;
  const sumOf = (type) => own.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0);
  const declarant = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || t('Utilisateur');
  const money = (amount) => ({ amount, currency: cur });

  const historyRows = [];
  if ((inv.capitalInvested || 0) > 0) historyRows.push([{ date: (inv.createdAt || '').slice(0, 10) }, t('Capital initial'), '', money(inv.capitalInvested)]);
  for (const e of own) {
    // Une valorisation est la valeur TOTALE du bien à cette date, pas un flux d'argent : on le dit
    // pour qu'elle ne soit pas lue comme un apport sur le document imprimé.
    const label = e.type === 'valuation' ? t('Valorisation (valeur totale à cette date)') : t(ENTRY_TYPE_LABELS[e.type] || e.type);
    historyRows.push([{ date: e.date }, label, e.note || '', money(e.amount)]);
  }

  return {
    title: t("Fiche d'investissement"),
    subtitle: inv.name,
    warnings: inv.description ? [] : [t("Cet investissement n'a pas de description : ajoutez-en une (bouton Modifier) pour obtenir un document complet.")],
    signatures: [t('Le déclarant — {name}', { name: declarant })],
    blocks: [
      {
        type: 'rows',
        heading: t('Informations générales'),
        rows: [
          [t('Nom'), inv.name],
          [t("Classe d'actif"), t(ASSET_CLASSES[inv.assetClass] || inv.assetClass)],
          [t('Devise'), cur],
          [t('Date de création'), { date: (inv.createdAt || '').slice(0, 10) }],
          ...(inv.reference ? [[t('Référence'), inv.reference]] : []),
        ],
      },
      { type: 'text', heading: t('Description'), text: inv.description || '' },
      {
        type: 'rows',
        heading: t('Synthèse financière'),
        rows: [
          [t('Capital initial'), money(inv.capitalInvested || 0)],
          [t('Apports cumulés'), money(sumOf('contribution'))],
          [t('Retraits cumulés'), money(sumOf('withdrawal'))],
          [t('Capital net investi'), money(metrics.netInvested)],
          [t('Valeur actuelle'), money(metrics.currentValue)],
          [t('Dividendes perçus'), money(metrics.dividends)],
          [t('Plus/moins-value + revenus'), money(metrics.gain)],
          [t('ROI global'), formatPercent(metrics.roiPct)],
          [t('Rendement annualisé'), formatPercent(metrics.annualizedYieldPct)],
        ],
      },
      ...(loan ? [{
        type: 'rows',
        heading: t('Financement par prêt'),
        rows: [
          [t('Total emprunté'), money(loan.principal)],
          [t('Total remboursé'), money(loan.paid)],
          [t('Restant dû'), money(loan.remaining)],
          [t('Valeur nette (valeur − prêt restant)'), money(metrics.currentValue - loan.remaining)],
        ],
      }, {
        type: 'table',
        heading: t('Prêts'),
        columns: [
          { label: t('Date'), align: 'left', weight: 2.4 },
          { label: t('Prêteur'), align: 'left', weight: 3.4 },
          { label: t('Taux / échéance'), align: 'left', weight: 3 },
          { label: `${t('Montant du prêt')} (${cur})`, align: 'right', weight: 2.8 },
          { label: `${t('Restant dû')} (${cur})`, align: 'right', weight: 2.8 },
        ],
        rows: loan.loans.map((l) => [
          { date: l.debt.startDate },
          l.debt.personName,
          [l.debt.interestRate ? formatPercent(l.debt.interestRate, 1) : '', l.debt.dueDate ? formatDate(l.debt.dueDate) : ''].filter(Boolean).join(' · '),
          money(l.debt.principal || 0),
          money(l.remaining),
        ]),
      }] : []),
      {
        type: 'table',
        heading: t('Historique des mouvements'),
        columns: [
          { label: t('Date'), align: 'left', weight: 2.4 },
          { label: t('Opération'), align: 'left', weight: 3.6 },
          { label: t('Note'), align: 'left', weight: 4 },
          { label: `${t('Montant')} (${cur})`, align: 'right', weight: 3 },
        ],
        rows: historyRows,
      },
      ...(loan ? [{
        type: 'table',
        heading: t('Remboursements du prêt'),
        columns: [
          { label: t('Date'), align: 'left', weight: 2.4 },
          { label: t('Prêteur'), align: 'left', weight: 3.4 },
          { label: t('Note'), align: 'left', weight: 3.2 },
          { label: `${t('Montant')} (${cur})`, align: 'right', weight: 3 },
        ],
        rows: loanPayments.map((p) => [{ date: p.date }, loanNameById.get(p.debtId) || '', p.note || '', money(p.amount)]),
      }] : []),
    ],
  };
}

const REPAY_ICON = svgIcon('repay', 16);

/** Prêts liés à un investissement, avec leur restant dû, ou null s'il n'y en a aucun. Un investissement
    peut avoir PLUSIEURS prêts : celui de l'achat, puis d'autres contractés en cours de route
    (augmentation de capital, réparation…) — chaque dette porte `investmentId` (inv.loanDebtId, ancien
    champ du tout premier prêt, reste pris en compte). Une dette supprimée depuis Dettes & créances
    disparaît simplement de la liste. */
function loansFor(inv, debts, debtPayments) {
  const own = debts.filter((d) => d.investmentId === inv.id || d.id === inv.loanDebtId);
  if (!own.length) return null;
  const loans = own.map((debt) => {
    const paid = debtPayments.filter((p) => p.debtId === debt.id).reduce((s, p) => s + (p.amount || 0), 0);
    return { debt, paid, remaining: Math.max(0, (debt.principal || 0) - paid) };
  });
  return {
    loans,
    principal: loans.reduce((s, l) => s + (l.debt.principal || 0), 0),
    paid: loans.reduce((s, l) => s + l.paid, 0),
    remaining: loans.reduce((s, l) => s + l.remaining, 0),
  };
}

function investmentCardHtml(inv, metrics, loan = null) {
  const positive = metrics.gain >= 0;
  return `
    <div class="summary-card" data-investment-id="${inv.id}">
      <div class="card-title-row">
        <div>
          <span class="badge badge-accent">${escapeHtml(t(ASSET_CLASSES[inv.assetClass] || inv.assetClass))}</span>
          <div class="fw-700 fs-15 mt-6">${escapeHtml(inv.name)}</div>
          ${inv.description
            ? `<div class="tx-sub inv-desc">${escapeHtml(inv.description)}</div>`
            : `<span class="badge badge-neg mt-6">${t('Description manquante')}</span>`}
        </div>
        <div class="card-actions">
          ${loan && loan.remaining > 0.005 ? `<button type="button" class="icon-btn" data-action="repay" aria-label="${t('Rembourser le prêt')}" title="${t('Rembourser le prêt')}">${REPAY_ICON}</button>` : ''}
          <button type="button" class="icon-btn" data-action="export" aria-label="${t('Exporter / imprimer')}" title="${t('Exporter / imprimer')}">${PRINT_ICON}</button>
          <button type="button" class="icon-btn" data-action="history" aria-label="${t('Historique / Ajouter')}" title="${t('Historique / Ajouter')}">${HISTORY_ICON}</button>
          <button type="button" class="icon-btn" data-action="edit" aria-label="${t('Modifier')}" title="${t('Modifier')}">${EDIT_ICON}</button>
          <button type="button" class="icon-btn" data-action="delete" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${DELETE_ICON}</button>
        </div>
      </div>
      <div class="stat-row"><span class="stat-row-label">${t('Capital net investi')}</span><span class="amount" data-value="${metrics.netInvested}">${formatCurrency(metrics.netInvested, inv.currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${t('Valeur actuelle')}</span><span class="amount" data-value="${metrics.currentValue}">${formatCurrency(metrics.currentValue, inv.currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${t('Dividendes perçus')}</span><span class="amount" data-value="${metrics.dividends}">${formatCurrency(metrics.dividends, inv.currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${t('Plus/moins-value + revenus')}</span><span class="badge ${positive ? 'badge-pos' : 'badge-neg'}">${positive ? '+' : ''}${formatCurrency(metrics.gain, inv.currency)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${t('ROI global')}</span><span class="badge ${metrics.roiPct >= 0 ? 'badge-pos' : 'badge-neg'}">${formatPercent(metrics.roiPct)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${t('Rendement annualisé')}</span><span class="badge ${metrics.annualizedYieldPct >= 0 ? 'badge-pos' : 'badge-neg'}">${formatPercent(metrics.annualizedYieldPct)}</span></div>
      ${loan ? `
      <div class="stat-row"><span class="stat-row-label">${loan.loans.length === 1 ? t('Prêt — {name}', { name: escapeHtml(loan.loans[0].debt.personName) }) : t('Prêts ({count})', { count: loan.loans.length })}</span><span class="amount" data-value="${loan.remaining}">${loan.remaining > 0.005 ? t('{amount} restant', { amount: formatCurrency(loan.remaining, inv.currency) }) : t('Soldé')}</span></div>
      <div class="stat-row"><span class="stat-row-label">${t('Valeur nette (valeur − prêt restant)')}</span><span class="amount" data-value="${metrics.currentValue - loan.remaining}">${formatCurrency(metrics.currentValue - loan.remaining, inv.currency)}</span></div>` : ''}
    </div>`;
}

function investmentFormHtml(inv, defaultCurrency) {
  const isEdit = !!inv;
  return `
    <form id="investment-form">
      <div class="form-row"><label>${t('Nom')}</label><input type="text" name="name" required maxlength="60" value="${escapeHtml(inv?.name || '')}" placeholder="${t('Ex: Appartement Cocody, Actions Total…')}"></div>
      <div class="form-row"><label>${t('Description')}</label><textarea name="description" required maxlength="600" rows="3" placeholder="${t('Ex: Terrain de 500 m² à Cocody, acquis en 2024 auprès de M. Kouassi')}">${escapeHtml(inv?.description || '')}</textarea></div>
      <div class="form-row"><label>${t('Référence (optionnel)')}</label><input type="text" name="reference" maxlength="100" value="${escapeHtml(inv?.reference || '')}" placeholder="${t('N° de titre foncier, plaque, compte titres…')}"></div>
      <div class="form-row"><label>${t("Classe d'actif")}</label>
        <select name="assetClass">${Object.entries(ASSET_CLASSES).map(([k, l]) => `<option value="${k}" ${inv?.assetClass === k ? 'selected' : ''}>${t(l)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>${t('Devise')}</label>${currencySelectHtml(inv?.currency || defaultCurrency)}</div>
      <div class="form-row"><label>${t('Capital investi initial')}</label><input type="number" step="0.01" min="0" name="capitalInvested" required value="${inv?.capitalInvested ?? ''}"></div>
      ${!isEdit ? `
      <div class="form-row">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" name="financedByLoan"> ${t('Financer une partie (ou la totalité) par un prêt')}
        </label>
      </div>
      <div data-field="loanFields" hidden>
        <div class="form-row"><label>${t('Montant financé par le prêt')}</label><input type="number" step="0.01" min="0" name="loanAmount"></div>
        <div class="form-row"><label>${t('Prêteur (personne ou organisme)')}</label><input type="text" name="loanLender" maxlength="60" placeholder="${t('Ex: Banque Atlantique')}"></div>
        <div class="form-row"><label>${t("Taux d'intérêt annuel % (optionnel)")}</label><input type="number" step="0.01" min="0" name="loanRate"></div>
        <div class="form-row"><label>${t('Échéance (optionnel)')}</label><input type="date" name="loanDueDate"></div>
        <p id="inv-loan-hint" style="margin:0 0 12px;" class="fs-13 c-muted"></p>
      </div>
      <div class="form-row" data-field="walletPartCheck">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" name="movesMoneyNow" checked> <span id="inv-wallet-part-label">${t("Débiter ce montant d'un portefeuille")}</span>
        </label>
        <p style="margin:2px 0 0;" class="fs-12 c-muted">${t('Décochez si cet investissement existait déjà avant d\'utiliser l\'app (aucun mouvement de portefeuille ne sera créé).')}</p>
      </div>
      <div class="form-row" data-field="movesMoneyWallet">
        <label>${t('Portefeuille')}</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <select name="walletId" style="flex:1;"></select>
          <button type="button" class="btn btn-ghost" id="inv-split-toggle" style="white-space:nowrap;">${t('Répartir sur plusieurs portefeuilles')}</button>
        </div>
        <div id="inv-split-wrap" hidden>
          <div id="inv-split-list"></div>
          <button type="button" class="btn btn-ghost" id="inv-split-add">${t('+ Ajouter un portefeuille')}</button>
          <div id="inv-split-total" class="fs-13 c-muted mt-4"></div>
        </div>
      </div>` : ''}
      <button type="submit" class="btn btn-primary btn-block">${inv ? t('Enregistrer') : t("Créer l'investissement")}</button>
    </form>`;
}

export async function openInvestmentModal(inv = null) {
  const defaultCurrency = inv ? inv.currency : await getSetting('baseCurrency', 'EUR');
  const modal = openModal(investmentFormHtml(inv, defaultCurrency), { title: inv ? t("Modifier l'investissement") : t('Nouvel investissement') });
  wireCurrencySelect(modal.el);

  const form = modal.el.querySelector('#investment-form');
  const movesCheckbox = form.elements.movesMoneyNow;
  const walletRow = modal.el.querySelector('[data-field="movesMoneyWallet"]');
  const walletSelect = form.elements.walletId;
  let walletSplit = null;

  if (movesCheckbox) {
    let allWallets = [];
    const refreshWalletOptions = async () => {
      if (!allWallets.length) allWallets = (await dbGetAll(STORES.WALLETS)).filter(isDailyWallet);
      walletSelect.innerHTML = walletOptionsHtml(allWallets, readCurrencyValue(form));
      walletSplit?.refreshRowWallets();
    };
    // Financement par prêt : le prêt couvre une partie (ou la totalité) du prix, le reste seulement est
    // débité des portefeuilles. Le prêt ne passe par AUCUN portefeuille à l'ouverture (voir
    // createLinkedDebt, debts.js) ; seuls ses remboursements, plus tard, en débitent un.
    const loanCheckbox = form.elements.financedByLoan;
    const loanFields = modal.el.querySelector('[data-field="loanFields"]');
    const walletPartCheck = modal.el.querySelector('[data-field="walletPartCheck"]');
    const loanHint = modal.el.querySelector('#inv-loan-hint');
    const walletPartLabel = modal.el.querySelector('#inv-wallet-part-label');
    const walletPartNow = () => {
      const total = safeNumber(parseFloat(form.elements.capitalInvested.value));
      const loan = loanCheckbox.checked ? safeNumber(parseFloat(form.elements.loanAmount.value)) : 0;
      return Math.max(0, total - loan);
    };
    const syncWalletVisibility = () => {
      const coveredByLoan = loanCheckbox.checked && walletPartNow() <= 0;
      loanFields.hidden = !loanCheckbox.checked;
      form.elements.loanAmount.required = loanCheckbox.checked;
      form.elements.loanLender.required = loanCheckbox.checked;
      walletPartCheck.hidden = coveredByLoan;
      walletPartLabel.textContent = loanCheckbox.checked ? t('Débiter la part payée par vos portefeuilles') : t("Débiter ce montant d'un portefeuille");
      loanHint.textContent = loanCheckbox.checked ? t('Part payée par vos portefeuilles : {amount}', { amount: formatCurrency(walletPartNow(), readCurrencyValue(form)) }) : '';
      walletRow.hidden = !movesCheckbox.checked || coveredByLoan;
    };
    [movesCheckbox, loanCheckbox, form.elements.loanAmount, form.elements.capitalInvested].forEach((el) => {
      el.addEventListener('change', syncWalletVisibility);
      el.addEventListener('input', syncWalletVisibility);
    });
    modal.el.querySelectorAll('[data-currency-select], [data-currency-other]').forEach((el) => {
      el.addEventListener('change', refreshWalletOptions);
      el.addEventListener('input', refreshWalletOptions);
    });
    await refreshWalletOptions();
    syncWalletVisibility();

    walletSplit = wireWalletSplit({
      toggleBtn: modal.el.querySelector('#inv-split-toggle'),
      singleSelect: walletSelect,
      splitWrap: modal.el.querySelector('#inv-split-wrap'),
      listEl: modal.el.querySelector('#inv-split-list'),
      addBtn: modal.el.querySelector('#inv-split-add'),
      totalEl: modal.el.querySelector('#inv-split-total'),
      getWallets: () => allWallets,
      getCurrency: () => readCurrencyValue(form),
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const before = inv ? { ...inv } : null;
    const currency = readCurrencyValue(e.target);
    const capitalInvested = safeNumber(parseFloat(fd.get('capitalInvested')));
    if (capitalInvested < 0) { showToast(t('Saisissez un montant supérieur à 0.')); return; }

    // Financement par prêt (création seulement) : le prêt couvre une partie du prix, les portefeuilles
    // le reste (walletPart). Validé AVANT toute écriture pour ne jamais créer un prêt orphelin.
    const financedByLoan = !inv && !!form.elements.financedByLoan?.checked;
    const loanAmount = financedByLoan ? safeNumber(parseFloat(fd.get('loanAmount'))) : 0;
    const loanLender = financedByLoan ? (fd.get('loanLender') || '').trim() : '';
    if (financedByLoan) {
      if (!(loanAmount > 0)) { showToast(t('Indiquez le montant financé par le prêt.')); return; }
      if (loanAmount > capitalInvested + 0.005) { showToast(t("Le prêt ne peut pas dépasser le prix de l'investissement ({total}).", { total: capitalInvested.toFixed(2) })); return; }
      if (!loanLender) { showToast(t('Indiquez le prêteur.')); return; }
    }
    const walletPart = Math.max(0, capitalInvested - loanAmount);

    const movesMoneyNow = !inv && !!movesCheckbox?.checked && walletPart > 0;
    const isSplit = movesMoneyNow && !!walletSplit?.isSplit();

    let splitRows = [];
    if (isSplit) {
      splitRows = walletSplit.getRows();
      const sum = splitRows.reduce((s, r) => s + r.amount, 0);
      if (splitRows.length < 2) { showToast(t('Ajoutez au moins deux portefeuilles avec un montant.')); return; }
      if (Math.abs(sum - walletPart) > 0.005) {
        showToast(t('La somme des montants répartis ({sum}) doit égaler le capital investi ({total}).', { sum: sum.toFixed(2), total: walletPart.toFixed(2) }));
        return;
      }
    } else if (movesMoneyNow && !walletSelect.value) {
      showToast(t('Choisissez un portefeuille, ou décochez "Débiter ce montant d\'un portefeuille".'));
      return;
    }

    const description = (fd.get('description') || '').trim();
    if (!description) { showToast(t('La description est obligatoire.')); return; }

    // Le capital initial et la devise d'un investissement déjà débité d'un portefeuille (ou financé par
    // un prêt) ne se modifient pas ici : la transaction d'achat resterait à l'ancien montant et le solde
    // du portefeuille divergerait en silence. On corrige via l'historique (apport/retrait) à la place.
    if (inv && (currency !== inv.currency || Math.abs(capitalInvested - (inv.capitalInvested || 0)) > 0.005)) {
      const hasPurchase = (await dbGetAll(STORES.TRANSACTIONS)).some((x) => x.investmentId === inv.id && x.investmentMovementType === 'purchase');
      if (hasPurchase || inv.loanDebtId) {
        showToast(t("Le capital initial et la devise ne peuvent plus changer : l'achat a déjà été enregistré. Utilisez l'historique (apport, retrait, valorisation)."));
        return;
      }
    }

    const record = {
      ...(inv || {}),
      id: inv?.id || uuid(),
      name: fd.get('name').trim(),
      description,
      reference: (fd.get('reference') || '').trim(),
      assetClass: fd.get('assetClass'),
      currency,
      capitalInvested,
      createdAt: inv?.createdAt || new Date().toISOString(),
      walletId: inv ? (inv.walletId || null) : (movesMoneyNow && !isSplit ? walletSelect.value : null),
    };

    if (movesMoneyNow) {
      const categoryId = await ensureInvestmentCategoryId('expense');
      const splitGroupId = isSplit ? uuid() : null;
      const rows = isSplit ? splitRows : [{ walletId: walletSelect.value, amount: walletPart }];
      for (const r of rows) {
        const purchaseTx = {
          id: uuid(),
          type: 'expense',
          walletId: r.walletId,
          targetWalletId: null,
          categoryId,
          amount: r.amount,
          date: record.createdAt.slice(0, 10),
          note: t('Achat — {name}', { name: record.name }),
          tags: [],
          reconciled: false,
          investmentId: record.id,
          investmentMovementType: 'purchase',
          splitGroupId,
          createdAt: new Date().toISOString(),
        };
        await dbAdd(STORES.TRANSACTIONS, purchaseTx);
        await logAudit({ entityType: 'transaction', entityId: purchaseTx.id, action: 'create', after: purchaseTx, note: t("Achat d'investissement") });
      }
    }

    if (financedByLoan) {
      const debt = await createLinkedDebt({
        type: 'debt',
        personName: loanLender,
        principal: loanAmount,
        currency,
        startDate: record.createdAt.slice(0, 10),
        note: t('Prêt pour « {name} »', { name: record.name }),
        investmentId: record.id,
        interestRate: safeNumber(parseFloat(fd.get('loanRate'))),
        dueDate: fd.get('loanDueDate') || null,
        auditNote: t('Prêt lié à un investissement'),
      });
      record.loanDebtId = debt.id;
    } else if (inv?.loanDebtId) {
      record.loanDebtId = inv.loanDebtId;
    }

    await dbPut(STORES.INVESTMENTS, record);
    await logAudit({ entityType: 'investment', entityId: record.id, action: inv ? 'update' : 'create', before, after: record });
    modal.close();
    showToast(inv ? t('Investissement mis à jour.') : t('Investissement créé.'));
    notifyDataChanged(movesMoneyNow || financedByLoan ? 'all' : 'investments');
  });
}

// Ces trois types déplacent réellement de l'argent depuis/vers un portefeuille — valorisation n'en
// a pas besoin (jamais un mouvement d'argent, juste une réévaluation).
const MONEY_MOVING_ENTRY_TYPES = ['contribution', 'dividend', 'withdrawal'];
// Parmi ceux-ci, dividende ET retrait CRÉDITENT le portefeuille (argent qui sort de l'investissement
// vers le portefeuille) ; apport le DÉBITE (argent qui part du portefeuille vers l'investissement).
const CREDIT_ENTRY_TYPES = ['dividend', 'withdrawal'];
const ENTRY_NOTE_LABELS = { contribution: 'Apport — {name}', dividend: 'Dividende — {name}', withdrawal: 'Retrait — {name}' };

async function openHistoryModal(inv) {
  const [entries, wallets, allInvestments] = await Promise.all([
    dbGetAll(STORES.INVESTMENT_ENTRIES).then((rows) => rows.filter((e) => e.investmentId === inv.id).sort((a, b) => b.date.localeCompare(a.date))),
    dbGetAll(STORES.WALLETS).then((rows) => rows.filter(isDailyWallet)),
    dbGetAll(STORES.INVESTMENTS),
  ]);
  const otherInvestments = allInvestments.filter((i) => i.id !== inv.id && i.currency === inv.currency);
  // Destinations d'un dividende : un portefeuille COURANT, OU un réinvestissement direct dans cet
  // investissement ou un autre de la même devise (valeur "inv:<id>"). Dans ce dernier cas l'argent
  // ne passe jamais par un portefeuille : le dividende est bien compté comme perçu, et s'ajoute
  // comme apport à l'investissement de destination.
  const dividendOptionsHtml = () => `
    <optgroup label="${t('Portefeuilles')}">${walletOptionsHtml(wallets, inv.currency)}</optgroup>
    <optgroup label="${t('Réinvestir')}">
      <option value="inv:${inv.id}">${t('↻ Cet investissement')}</option>
      ${otherInvestments.map((i) => `<option value="inv:${i.id}">${escapeHtml(i.name)}</option>`).join('')}
    </optgroup>`;

  const modal = openModal(`
    <form id="entry-form" class="mb-16">
      <div class="form-row"><label>${t('Type')}</label>
        <select name="type">${Object.entries(ENTRY_TYPE_LABELS).map(([k, l]) => `<option value="${k}">${t(l)}</option>`).join('')}</select>
      </div>
      <div class="form-row"><label>${t('Montant')}</label><input type="number" step="0.01" min="0" name="amount" required></div>
      <div class="form-row" data-field="entryLoanCheck" hidden>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
          <input type="checkbox" name="entryFinancedByLoan"> ${t('Financer par un prêt (augmentation de capital, réparation…)')}
        </label>
      </div>
      <div data-field="entryLoanFields" hidden>
        <div class="form-row"><label>${t('Montant financé par le prêt')}</label><input type="number" step="0.01" min="0" name="entryLoanAmount"></div>
        <div class="form-row"><label>${t('Prêteur (personne ou organisme)')}</label><input type="text" name="entryLoanLender" maxlength="60" placeholder="${t('Ex: Banque Atlantique')}"></div>
        <div class="form-row"><label>${t("Taux d'intérêt annuel % (optionnel)")}</label><input type="number" step="0.01" min="0" name="entryLoanRate"></div>
        <div class="form-row"><label>${t('Échéance (optionnel)')}</label><input type="date" name="entryLoanDueDate"></div>
        <p id="entry-loan-hint" style="margin:0 0 12px;" class="fs-13 c-muted"></p>
      </div>
      <div class="form-row" data-field="entryWallet">
        <label>${t('Portefeuille')}</label>
        <div style="display:flex;gap:8px;align-items:center;">
          <select name="walletId" style="flex:1;">${walletOptionsHtml(wallets, inv.currency)}</select>
          <button type="button" class="btn btn-ghost" id="entry-split-toggle" style="white-space:nowrap;">${t('Répartir sur plusieurs portefeuilles')}</button>
        </div>
        <div id="entry-split-wrap" hidden>
          <div id="entry-split-list"></div>
          <button type="button" class="btn btn-ghost" id="entry-split-add">${t('+ Ajouter un portefeuille')}</button>
          <div id="entry-split-total" class="fs-13 c-muted mt-4"></div>
        </div>
        <p id="entry-wallet-hint" style="margin:2px 0 0;" class="fs-12 c-muted"></p>
      </div>
      <div class="form-row"><label>${t('Date')}</label><input type="date" name="date" value="${todayISO()}" required></div>
      <div class="form-row"><label>${t('Note (optionnel)')}</label><input type="text" name="note" maxlength="140"></div>
      <button type="submit" class="btn btn-primary btn-block">${t('Ajouter')}</button>
    </form>
    <div id="entry-list">
      ${entries.length ? entries.map((e) => `
        <div class="tx-row" data-entry-id="${e.id}">
          <div class="tx-main">
            <div class="tx-title">${t(ENTRY_TYPE_LABELS[e.type])}${e.note ? ' · ' + escapeHtml(e.note) : ''}</div>
            <div class="tx-sub">${formatDate(e.date)}</div>
          </div>
          <div class="tx-amount">${formatCurrency(e.amount, inv.currency)}</div>
          <div class="card-actions"><button type="button" class="icon-btn" data-action="delete-entry" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${DELETE_ICON}</button></div>
        </div>`).join('') : `<div class="empty-state">${t('Aucun historique pour le moment.')}</div>`}
    </div>
  `, { title: t('Historique — {name}', { name: inv.name }) });

  const entryForm = modal.el.querySelector('#entry-form');
  const entryWalletRow = modal.el.querySelector('[data-field="entryWallet"]');
  const entryWalletSelect = entryForm.elements.walletId;
  const typeSelect = entryForm.elements.type;
  const syncEntryWalletVisibility = () => { entryWalletRow.hidden = !MONEY_MOVING_ENTRY_TYPES.includes(typeSelect.value); };
  typeSelect.addEventListener('change', syncEntryWalletVisibility);
  syncEntryWalletVisibility();

  const entrySplit = wireWalletSplit({
    toggleBtn: modal.el.querySelector('#entry-split-toggle'),
    singleSelect: entryWalletSelect,
    splitWrap: modal.el.querySelector('#entry-split-wrap'),
    listEl: modal.el.querySelector('#entry-split-list'),
    addBtn: modal.el.querySelector('#entry-split-add'),
    totalEl: modal.el.querySelector('#entry-split-total'),
    getWallets: () => wallets,
    getCurrency: () => inv.currency,
    getOptionsHtml: () => (typeSelect.value === 'dividend' ? dividendOptionsHtml() : null),
  });

  const entryHintEl = modal.el.querySelector('#entry-wallet-hint');
  const refreshDestinationUi = () => {
    const isDividend = typeSelect.value === 'dividend';
    entryWalletSelect.innerHTML = isDividend ? dividendOptionsHtml() : walletOptionsHtml(wallets, inv.currency);
    entrySplit.refreshRowWallets();
    entryHintEl.textContent = isDividend
      ? t("Dividende : crédité sur un portefeuille, ou réinvesti directement (dans cet investissement ou un autre) sans passer par un portefeuille. Vous pouvez répartir entre plusieurs destinations.")
      : typeSelect.value === 'contribution'
        ? t('Apport : débité de ce portefeuille.')
        : t('Retrait : crédité sur ce portefeuille.');
  };
  // Apport financé par un prêt (en cours de vie de l'investissement) : le prêt couvre une partie ou la
  // totalité de l'apport, le reste seulement est débité des portefeuilles courants.
  const loanCheckRow = modal.el.querySelector('[data-field="entryLoanCheck"]');
  const loanFieldsEl = modal.el.querySelector('[data-field="entryLoanFields"]');
  const loanHintEl = modal.el.querySelector('#entry-loan-hint');
  const loanCheckbox = entryForm.elements.entryFinancedByLoan;
  const walletAmountNow = () => {
    const total = safeNumber(parseFloat(entryForm.elements.amount.value));
    const loan = loanCheckbox.checked ? safeNumber(parseFloat(entryForm.elements.entryLoanAmount.value)) : 0;
    return Math.max(0, total - loan);
  };
  const syncLoanUi = () => {
    const isContribution = typeSelect.value === 'contribution';
    loanCheckRow.hidden = !isContribution;
    const loanOn = isContribution && loanCheckbox.checked;
    loanFieldsEl.hidden = !loanOn;
    entryForm.elements.entryLoanAmount.required = loanOn;
    entryForm.elements.entryLoanLender.required = loanOn;
    const coveredByLoan = loanOn && walletAmountNow() <= 0;
    loanHintEl.textContent = loanOn ? t('Part payée par vos portefeuilles : {amount}', { amount: formatCurrency(walletAmountNow(), inv.currency) }) : '';
    entryWalletRow.hidden = !MONEY_MOVING_ENTRY_TYPES.includes(typeSelect.value) || coveredByLoan;
  };
  typeSelect.addEventListener('change', syncLoanUi);
  [loanCheckbox, entryForm.elements.entryLoanAmount, entryForm.elements.amount].forEach((el) => {
    el.addEventListener('change', syncLoanUi);
    el.addEventListener('input', syncLoanUi);
  });

  typeSelect.addEventListener('change', refreshDestinationUi);
  refreshDestinationUi();
  syncLoanUi();

  entryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const type = fd.get('type');
    const amount = safeNumber(parseFloat(fd.get('amount')));
    // Une valorisation à 0 est légitime (perte totale) ; un apport, dividende ou retrait à 0 ne l'est pas.
    if (type === 'valuation' ? amount < 0 : !(amount > 0)) { showToast(t('Saisissez un montant supérieur à 0.')); return; }
    const movesMoney = MONEY_MOVING_ENTRY_TYPES.includes(type);

    // Apport financé (en tout ou partie) par un prêt : la part « prêt » ne passe par AUCUN portefeuille
    // (la banque paie directement), seule la part restante (walletAmount) est débitée.
    const financedByLoan = type === 'contribution' && !!entryForm.elements.entryFinancedByLoan.checked;
    const loanAmount = financedByLoan ? safeNumber(parseFloat(fd.get('entryLoanAmount'))) : 0;
    const loanLender = financedByLoan ? (fd.get('entryLoanLender') || '').trim() : '';
    if (financedByLoan) {
      if (!(loanAmount > 0)) { showToast(t('Indiquez le montant financé par le prêt.')); return; }
      if (loanAmount > amount + 0.005) { showToast(t("Le prêt ne peut pas dépasser le montant de l'apport ({total}).", { total: amount.toFixed(2) })); return; }
      if (!loanLender) { showToast(t('Indiquez le prêteur.')); return; }
    }
    const walletAmount = Math.max(0, amount - loanAmount);
    const needsWallet = movesMoney && walletAmount > 0;
    const isSplit = needsWallet && entrySplit.isSplit();
    const entryWalletId = fd.get('walletId') || '';

    let splitRows = [];
    if (isSplit) {
      splitRows = entrySplit.getRows();
      const sum = splitRows.reduce((s, r) => s + r.amount, 0);
      if (splitRows.length < 2) { showToast(t('Ajoutez au moins deux portefeuilles avec un montant.')); return; }
      if (Math.abs(sum - walletAmount) > 0.005) {
        showToast(t('La somme des montants répartis ({sum}) doit égaler le montant ({total}).', { sum: sum.toFixed(2), total: walletAmount.toFixed(2) }));
        return;
      }
    } else if (needsWallet && !entryWalletId) {
      showToast(t('Choisissez un portefeuille.'));
      return;
    }

    // Lignes de destination : "inv:<id>" = réinvestissement direct (dividende seulement), sinon un
    // portefeuille. Seules les lignes portefeuille créent des transactions de portefeuille.
    const destinationRows = needsWallet ? (isSplit ? splitRows : [{ walletId: entryWalletId, amount: walletAmount }]) : [];
    const walletRows = destinationRows.filter((r) => !r.walletId.startsWith('inv:'));
    const reinvestRows = type === 'dividend' ? destinationRows.filter((r) => r.walletId.startsWith('inv:')) : [];

    const entry = {
      id: uuid(),
      investmentId: inv.id,
      type,
      amount,
      date: fd.get('date'),
      note: (fd.get('note') || '').trim().slice(0, 140),
      walletId: walletRows.length === 1 && destinationRows.length === 1 ? walletRows[0].walletId : null,
    };
    if (financedByLoan) {
      const debt = await createLinkedDebt({
        type: 'debt',
        personName: loanLender,
        principal: loanAmount,
        currency: inv.currency,
        startDate: entry.date,
        note: `${t('Prêt pour « {name} »', { name: inv.name })}${entry.note ? ' — ' + entry.note : ''}`,
        investmentId: inv.id,
        interestRate: safeNumber(parseFloat(fd.get('entryLoanRate'))),
        dueDate: fd.get('entryLoanDueDate') || null,
        auditNote: t('Prêt lié à un investissement'),
      });
      entry.loanDebtId = debt.id;
    }
    await dbAdd(STORES.INVESTMENT_ENTRIES, entry);
    await logAudit({ entityType: 'investmentEntry', entityId: entry.id, action: 'create', after: entry });

    // Dividende réinvesti : un apport est créé sur l'investissement de destination (même celui-ci),
    // relié au dividende d'origine (sourceEntryId) pour qu'une suppression du dividende retire aussi
    // ces apports. Aucun mouvement de portefeuille : l'argent n'y est jamais passé.
    for (const r of reinvestRows) {
      const reinvestEntry = {
        id: uuid(),
        investmentId: r.walletId.slice(4),
        type: 'contribution',
        amount: r.amount,
        date: entry.date,
        note: t('Dividende réinvesti — {name}', { name: inv.name }),
        walletId: null,
        sourceEntryId: entry.id,
      };
      await dbAdd(STORES.INVESTMENT_ENTRIES, reinvestEntry);
      await logAudit({ entityType: 'investmentEntry', entityId: reinvestEntry.id, action: 'create', after: reinvestEntry, note: t('Dividende réinvesti') });
    }

    if (walletRows.length) {
      const txType = CREDIT_ENTRY_TYPES.includes(type) ? 'income' : 'expense';
      const categoryId = await ensureInvestmentCategoryId(txType);
      const splitGroupId = walletRows.length > 1 ? uuid() : null;
      const rows = walletRows;
      for (const r of rows) {
        const moneyTx = {
          id: uuid(),
          type: txType,
          walletId: r.walletId,
          targetWalletId: null,
          categoryId,
          amount: r.amount,
          date: entry.date,
          note: t(ENTRY_NOTE_LABELS[type], { name: inv.name }),
          tags: [],
          reconciled: false,
          investmentId: inv.id,
          investmentEntryId: entry.id,
          investmentMovementType: type,
          splitGroupId,
          createdAt: new Date().toISOString(),
        };
        await dbAdd(STORES.TRANSACTIONS, moneyTx);
        await logAudit({ entityType: 'transaction', entityId: moneyTx.id, action: 'create', after: moneyTx, note: t('Mouvement de portefeuille lié à un investissement') });
      }
    }

    modal.close();
    showToast(t('Entrée ajoutée.'));
    notifyDataChanged(walletRows.length || financedByLoan ? 'all' : 'investments');
  });

  modal.el.querySelector('#entry-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action="delete-entry"]');
    if (!btn) return;
    const entryId = e.target.closest('[data-entry-id]').dataset.entryId;
    // Apports issus du réinvestissement de ce dividende : ils n'ont de sens qu'avec lui, on les retire
    // en même temps plutôt que de laisser du capital sans origine.
    const reinvested = (await dbGetAll(STORES.INVESTMENT_ENTRIES)).filter((en) => en.sourceEntryId === entryId);
    const ok = await confirmDialog(
      reinvested.length
        ? t("Supprimer cette entrée d'historique et les {count} réinvestissement(s) qui en découlent ?", { count: reinvested.length })
        : t("Supprimer cette entrée d'historique ?"),
      { danger: true, requirePin: true, confirmText: t('Supprimer') },
    );
    if (ok) {
      const linkedTx = (await dbGetAll(STORES.TRANSACTIONS)).filter((tx) => tx.investmentEntryId === entryId);
      for (const tx of linkedTx) await dbDelete(STORES.TRANSACTIONS, tx.id);
      for (const en of reinvested) {
        await dbDelete(STORES.INVESTMENT_ENTRIES, en.id);
        await logAudit({ entityType: 'investmentEntry', entityId: en.id, action: 'delete', before: en });
      }
      await dbDelete(STORES.INVESTMENT_ENTRIES, entryId);
      await logAudit({ entityType: 'investmentEntry', entityId: entryId, action: 'delete' });
      modal.close();
      showToast(t('Entrée supprimée.'));
      notifyDataChanged(linkedTx.length ? 'all' : 'investments');
    }
  });
}

const DEFAULT_ALLOCATION_ALERT_THRESHOLD = 70;

function renderYieldTable(rows, baseCurrency, rates, threshold, showAlert) {
  const byClass = new Map();
  for (const r of rows) {
    const key = r.inv.assetClass;
    const netInvestedBase = convertAmount(r.metrics.netInvested, r.inv.currency, baseCurrency, rates, baseCurrency);
    const currentValueBase = convertAmount(r.metrics.currentValue, r.inv.currency, baseCurrency, rates, baseCurrency);
    if (!byClass.has(key)) byClass.set(key, { netInvested: 0, currentValue: 0, weightedYield: 0 });
    const acc = byClass.get(key);
    acc.netInvested += netInvestedBase;
    acc.currentValue += currentValueBase;
    acc.weightedYield += r.metrics.annualizedYieldPct * Math.max(netInvestedBase, 0);
  }
  const lines = [...byClass.entries()].map(([key, acc]) => ({
    label: t(ASSET_CLASSES[key] || key),
    netInvested: acc.netInvested,
    currentValue: acc.currentValue,
    yieldPct: acc.netInvested ? acc.weightedYield / acc.netInvested : 0,
  }));
  if (!lines.length) return `<div class="empty-state">${t('Ajoutez des investissements pour voir le comparatif de rendement.')}</div>`;

  // Part de chaque classe dans le portefeuille (basée sur la valeur actuelle, pas le capital
  // investi — une classe qui a bien performé doit peser plus lourd dans l'alerte de dérive
  // d'allocation, même si son capital investi initial était modeste). Les valeurs négatives
  // (dette nette rare sur un bien physique) sont ignorées pour ce calcul, pas soustraites.
  const totalValue = lines.reduce((s, l) => s + Math.max(l.currentValue, 0), 0);
  const linesWithShare = lines.map((l) => ({ ...l, sharePct: totalValue ? (Math.max(l.currentValue, 0) / totalValue) * 100 : 0 }));
  // showAlert=false quand un filtre (Actifs financiers/Biens physiques) est actif : le pourcentage
  // ne serait calculé que sur le sous-ensemble affiché, pas le "portefeuille" que le texte de
  // l'alerte prétend décrire — trompeur (une classe peut sembler dominer un sous-ensemble alors
  // qu'elle pèse peu sur le portefeuille réel). linesWithShare.length < 2 exclu aussi : avec une
  // seule classe d'actif, sa part est TOUJOURS 100%, ce n'est pas une "dérive" à signaler, juste
  // l'état normal d'un portefeuille qui débute — l'alerte s'afficherait sans jamais pouvoir
  // disparaître, ce qui la rendrait inutile (bruit permanent).
  const overThreshold = (showAlert && linesWithShare.length > 1) ? linesWithShare.filter((l) => l.sharePct > threshold) : [];

  const alertHtml = overThreshold.length ? `
    <div class="alert alert-warn mb-12">
      ${overThreshold.map((l) => escapeHtml(t('{label} représente {pct}% de votre portefeuille (seuil {threshold}%).', { label: l.label, pct: l.sharePct.toFixed(0), threshold }))).join('<br>')}
    </div>` : '';

  return alertHtml + `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;" class="fs-14">
        <thead><tr style="text-align:left;" class="c-muted">
          <th style="padding:8px 6px;">${t("Classe d'actif")}</th><th style="padding:8px 6px;">${t('Capital net')}</th><th style="padding:8px 6px;">${t('Valeur actuelle')}</th><th style="padding:8px 6px;">${t('Part du portefeuille')}</th><th style="padding:8px 6px;">${t('Rendement annualisé')}</th>
        </tr></thead>
        <tbody>
          ${linesWithShare.map((l) => `
            <tr style="border-top:1px solid var(--border);">
              <td style="padding:8px 6px;" class="fw-600">${escapeHtml(l.label)}</td>
              <td style="padding:8px 6px;">${formatCurrency(l.netInvested, baseCurrency)}</td>
              <td style="padding:8px 6px;">${formatCurrency(l.currentValue, baseCurrency)}</td>
              <td style="padding:8px 6px;"><span class="badge ${l.sharePct > threshold ? 'badge-neg' : ''}">${formatPercent(l.sharePct, 0)}</span></td>
              <td style="padding:8px 6px;"><span class="badge ${l.yieldPct >= 0 ? 'badge-pos' : 'badge-neg'}">${formatPercent(l.yieldPct)}</span></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

export async function renderInvestments() {
  const container = document.getElementById('investments-content');
  if (!container) return;
  const [investments, entries, { rates, baseCurrency }, threshold, debts, debtPayments] = await Promise.all([
    dbGetAll(STORES.INVESTMENTS), dbGetAll(STORES.INVESTMENT_ENTRIES), getExchangeRates(),
    getSetting('investmentAllocationAlertThreshold', DEFAULT_ALLOCATION_ALERT_THRESHOLD),
    dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS),
  ]);

  if (!investments.length) {
    container.innerHTML = `<div class="empty-state">${t('Aucun investissement suivi. Ajoutez votre premier actif (immobilier, actions, business…).')}</div>`;
    return;
  }

  const allRows = investments.map((inv) => ({ inv, metrics: computeMetrics(inv, entries), loan: loansFor(inv, debts, debtPayments) }));
  const rows = allRows.filter((r) => {
    if (assetFilter === 'physical') return PHYSICAL_ASSET_CLASSES.includes(r.inv.assetClass);
    if (assetFilter === 'financial') return !PHYSICAL_ASSET_CLASSES.includes(r.inv.assetClass);
    return true;
  });

  container.innerHTML = `
    <div class="tabs-bar mb-16">
      <button type="button" class="tab-btn ${assetFilter === 'all' ? 'is-active' : ''}" data-asset-filter="all">${t('Tous')}</button>
      <button type="button" class="tab-btn ${assetFilter === 'financial' ? 'is-active' : ''}" data-asset-filter="financial">${t('Actifs financiers')}</button>
      <button type="button" class="tab-btn ${assetFilter === 'physical' ? 'is-active' : ''}" data-asset-filter="physical">${t('Biens physiques')}</button>
    </div>
    <div class="grid-cards mb-18">${rows.length ? rows.map((r) => investmentCardHtml(r.inv, r.metrics, r.loan)).join('') : `<div class="empty-state">${t('Aucun actif dans cette catégorie.')}</div>`}</div>
    <div class="chart-card mb-18">
      <h3>${t('Évolution de la valeur du portefeuille')}</h3>
      <div class="chart-canvas-wrap"><canvas id="chart-investments-trend"></canvas></div>
    </div>
    <div class="panel">
      <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <h3>${t("Comparatif de rendement par classe d'actif")}</h3>
        <label style="display:flex;align-items:center;gap:6px;font-weight:400;" class="fs-13 c-muted">
          ${t('Alerte si plus de')}
          <input type="number" id="allocation-threshold" min="1" max="100" step="1" value="${threshold}" style="width:56px;">%
        </label>
      </div>
      <div id="yield-table-wrap">${renderYieldTable(rows, baseCurrency, rates, threshold, assetFilter === 'all')}</div>
    </div>`;

  container.querySelectorAll('[data-asset-filter]').forEach((btn) => {
    btn.addEventListener('click', () => { assetFilter = btn.dataset.assetFilter; renderInvestments(); });
  });

  container.querySelector('#allocation-threshold').addEventListener('change', async (e) => {
    const value = Math.min(100, Math.max(1, parseInt(e.target.value, 10) || DEFAULT_ALLOCATION_ALERT_THRESHOLD));
    e.target.value = value;
    await setSetting('investmentAllocationAlertThreshold', value);
    container.querySelector('#yield-table-wrap').innerHTML = renderYieldTable(rows, baseCurrency, rates, value, assetFilter === 'all');
  });

  const history = await computeInvestmentValueHistory(6);
  renderNetWorthTrendChart('chart-investments-trend', history, baseCurrency, t('Valeur du portefeuille'));
}

export function initInvestmentsModule() {
  document.getElementById('investment-add-btn')?.addEventListener('click', () => openInvestmentModal());

  document.getElementById('investments-content')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('[data-investment-id]');
    if (!card) return;
    const investments = await dbGetAll(STORES.INVESTMENTS);
    const inv = investments.find((x) => x.id === card.dataset.investmentId);
    if (!inv) return;

    if (btn.dataset.action === 'history') {
      openHistoryModal(inv);
    } else if (btn.dataset.action === 'export') {
      openProofExportModal(() => buildInvestmentProof(inv));
    } else if (btn.dataset.action === 'repay') {
      const [allDebts, allPayments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);
      const open = (loansFor(inv, allDebts, allPayments)?.loans || []).filter((l) => l.remaining > 0.005);
      if (open.length === 1) {
        openPaymentModal(open[0].debt);
      } else if (open.length > 1) {
        // Plusieurs prêts sur cet investissement : on choisit celui qu'on rembourse.
        const picker = openModal(`
          <p style="margin:0 0 12px;" class="fs-13 c-muted">${t('Quel prêt voulez-vous rembourser ?')}</p>
          <div class="proof-actions" style="flex-direction:column;">${open.map((l) => `<button type="button" class="btn btn-ghost" data-pick-loan="${l.debt.id}">${escapeHtml(l.debt.personName)} — ${t('{amount} restant', { amount: formatCurrency(l.remaining, inv.currency) })}</button>`).join('')}</div>`,
        { title: inv.name });
        picker.el.querySelectorAll('[data-pick-loan]').forEach((b) => b.addEventListener('click', () => {
          picker.close();
          openPaymentModal(open.find((l) => l.debt.id === b.dataset.pickLoan).debt);
        }));
      }
    } else if (btn.dataset.action === 'edit') {
      openInvestmentModal(inv);
    } else if (btn.dataset.action === 'delete') {
      const linkedRecurring = (await dbGetAll(STORES.RECURRING)).filter((r) => r.investmentId === inv.id);
      const confirmMsg = linkedRecurring.length
        ? t('Supprimer l\'investissement "{name}" et tout son historique (mouvements de portefeuille associés ET {count} apport(s) récurrent(s) lié(s)) ?', { name: inv.name, count: linkedRecurring.length })
        : t('Supprimer l\'investissement "{name}" et tout son historique (et les mouvements de portefeuille associés) ?', { name: inv.name });
      // Supprimer l'investissement n'efface PAS une dette envers la banque : le prêt reste enregistré
      // dans Dettes & créances (simplement détaché de cet investissement).
      const linkedLoans = (await dbGetAll(STORES.DEBTS)).filter((d) => d.investmentId === inv.id || d.id === inv.loanDebtId);
      const ok = await confirmDialog(linkedLoans.length
        ? `${confirmMsg} ${t('Le(s) prêt(s) « {name} » reste(nt) enregistré(s) dans Dettes & créances.', { name: linkedLoans.map((d) => d.personName).join(', '), count: linkedLoans.length })}`
        : confirmMsg, { danger: true, requirePin: true, confirmText: t('Supprimer') });
      if (ok) {
        for (const loan of linkedLoans) await dbPut(STORES.DEBTS, { ...loan, investmentId: null });
        const entries = (await dbGetAll(STORES.INVESTMENT_ENTRIES)).filter((en) => en.investmentId === inv.id);
        for (const en of entries) await dbDelete(STORES.INVESTMENT_ENTRIES, en.id);
        const linkedTx = (await dbGetAll(STORES.TRANSACTIONS)).filter((tx) => tx.investmentId === inv.id);
        for (const tx of linkedTx) await dbDelete(STORES.TRANSACTIONS, tx.id);
        // Sans ça, une récurrence d'apport (DCA) pointant sur cet investissement resterait active
        // et continuerait à débiter le portefeuille indéfiniment à chaque déverrouillage
        // (generateDueRecurring, budgets.js), en créant des entrées d'historique orphelines
        // invisibles nulle part dans l'UI.
        for (const r of linkedRecurring) await dbDelete(STORES.RECURRING, r.id);
        await dbDelete(STORES.INVESTMENTS, inv.id);
        await logAudit({ entityType: 'investment', entityId: inv.id, action: 'delete', before: inv });
        showToast(t('Investissement supprimé.'));
        notifyDataChanged(linkedTx.length || linkedRecurring.length ? 'all' : 'investments');
      }
    }
  });
}
