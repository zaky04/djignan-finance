/* ==========================================================================
   Djignan Financial System — Projets collectifs (voir js/group-project.js pour le modèle)
   Une dépense à plusieurs dont chacun paie ce qu'il peut (le voyage d'un parent, un mariage…). Les autres ne sont
   qu'un SUIVI (qui a payé combien) : rien n'entre ni ne sort de mes portefeuilles pour eux. MA participation, elle,
   est réelle : soit une dépense exceptionnelle sur un de mes portefeuilles, soit financée par un prêt (créé en même
   temps, éventuellement pris dans un compte gardé : l'argent quitte alors le compte et y revient aux remboursements).
   Les projets vivent dans le réglage `groupProjects` (comme les provisions) : pas de nouveau store, ils suivent les
   sauvegardes. Affichés en tête de l'écran « Partage de dépenses ».
   ========================================================================== */

import { STORES, dbGetAll, dbAdd, dbWriteBatch, logAudit, getSetting } from '../db.js';
import { uuid, formatCurrency, formatDate, escapeHtml, todayISO, openModal, confirmDialog, showToast, safeNumber, currencySelectHtml, wireCurrencySelect, readCurrencyValue } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { isDailyWallet } from '../ledger.js';
import { ensureDebtCategoryId, deleteDebtCascade } from './debts.js';
import { projectTotals, knownContributors } from '../group-project.js';
import { t } from '../i18n.js';
import { icon as svgIcon } from '../icons.js';

const EDIT_ICON = svgIcon('edit', 16);
const DELETE_ICON = svgIcon('trash', 16);
const SETTING_KEY = 'groupProjects';

async function loadProjects() {
  const value = await getSetting(SETTING_KEY, []);
  return Array.isArray(value) ? value : [];
}
/** Écriture des projets, à joindre à un lot dbWriteBatch (atomique avec les transactions/dettes créées en même temps). */
const projectsOp = (projects) => ({ store: STORES.SETTINGS, type: 'put', value: { key: SETTING_KEY, value: projects } });

function walletOptionsHtml(wallets, currency) {
  const matching = wallets.filter((w) => w.currency === currency);
  if (!matching.length) return `<option value="">${t('Aucun portefeuille en {currency}', { currency: escapeHtml(currency) })}</option>`;
  return matching.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('');
}

function keptBalance(account, entries) {
  return (account.initialBalance || 0) + entries.filter((e) => e.accountId === account.id)
    .reduce((s, e) => s + (e.type === 'in' ? (e.amount || 0) : -(e.amount || 0)), 0);
}

/** Catégorie de dépense « exceptionnelle » portant le nom du projet (retrouvée si elle existe déjà). */
async function ensureProjectCategory(name) {
  const categories = await dbGetAll(STORES.CATEGORIES);
  const label = name.slice(0, 40);
  const existing = categories.find((c) => c.type === 'expense' && c.name === label && c.exceptional === true);
  if (existing) return existing.id;
  const category = { id: uuid(), name: label, type: 'expense', parentId: null, exceptional: true, createdAt: new Date().toISOString() };
  await dbAdd(STORES.CATEGORIES, category);
  return category.id;
}

/* ---------- Affichage ---------- */
function projectCardHtml(project) {
  const totals = projectTotals(project);
  const cur = project.currency;
  const over = totals.remaining < -0.005;
  const people = totals.byPerson.map((p) => `
    <div class="stat-row">
      <span class="stat-row-label">${escapeHtml(p.name || t('Moi'))}${p.isMe && p.name && p.name !== t('Moi') ? ` <span class="badge badge-accent">${t('Moi')}</span>` : ''}</span>
      <span class="amount">${formatCurrency(p.total, cur)}</span>
    </div>`).join('');
  const rows = [...(project.contributions || [])].sort((a, b) => (b.date || '').localeCompare(a.date || '')).map((c) => {
    const kindLabel = c.isMe ? (c.kind === 'loan' ? t('prêt') : t('portefeuille')) : t('suivi');
    return `
    <div class="tx-row" data-contribution-id="${escapeHtml(c.id)}">
      <div class="tx-main">
        <div class="tx-title">${escapeHtml(c.who || t('Moi'))} <span class="badge">${kindLabel}</span></div>
        <div class="tx-sub">${formatDate(c.date)}${c.note ? ' · ' + escapeHtml(c.note) : ''}</div>
      </div>
      <div class="tx-amount amount">${formatCurrency(c.amount, cur)}</div>
      <button type="button" class="icon-btn" data-action="delete-contribution" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${DELETE_ICON}</button>
    </div>`;
  }).join('');
  return `
    <div class="summary-card mb-16" data-project-id="${escapeHtml(project.id)}">
      <div class="card-title-row">
        <div>
          <div class="fw-700 fs-15">${escapeHtml(project.name)}</div>
          <div class="tx-sub">${t('Objectif : {amount}', { amount: formatCurrency(totals.target, cur) })}</div>
        </div>
        <div class="card-actions">
          <button type="button" class="icon-btn" data-action="edit-project" aria-label="${t('Modifier')}" title="${t('Modifier')}">${EDIT_ICON}</button>
          <button type="button" class="icon-btn" data-action="delete-project" aria-label="${t('Supprimer')}" title="${t('Supprimer')}">${DELETE_ICON}</button>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill" style="width:${totals.percent}%"></div></div>
      <div style="display:flex;justify-content:space-between;margin:6px 0 10px;" class="fs-13 c-muted">
        <span>${t('Collecté : {amount}', { amount: formatCurrency(totals.collected, cur) })}</span>
        <span class="${over ? 'c-pos' : ''}">${over
          ? t('Objectif dépassé de {amount}', { amount: formatCurrency(Math.abs(totals.remaining), cur) })
          : t('Reste à couvrir : {amount}', { amount: formatCurrency(Math.max(0, totals.remaining), cur) })}</span>
      </div>
      ${people ? `<div class="mb-8"><div class="fs-13 c-muted mb-4">${t('Qui a payé combien')}</div>${people}</div>` : ''}
      ${totals.mine.total > 0 ? `<div class="stat-row"><span class="stat-row-label">${t('Ma participation')}</span><span>${t('portefeuille {wallet} · prêt {loan}', { wallet: formatCurrency(totals.mine.wallet, cur), loan: formatCurrency(totals.mine.loan, cur) })}</span></div>` : ''}
      ${rows ? `<div class="mt-8">${rows}</div>` : ''}
      <button type="button" class="btn btn-primary mt-8" data-action="add-contribution">${t('+ Ajouter une participation')}</button>
    </div>`;
}

export async function renderGroupProjects(container) {
  if (!container) return;
  const projects = await loadProjects();
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header">
        <h3>${t('Projets collectifs')}</h3>
        <button type="button" class="btn btn-primary" id="project-add-btn">${t('+ Nouveau projet')}</button>
      </div>
      <p class="fs-13 c-muted mb-12">${t("Une dépense à plusieurs (voyage d'un parent, cérémonie…) où chacun paie ce qu'il peut. Les autres participants sont seulement notés ; votre part, elle, sort bien de vos comptes.")}</p>
      ${projects.length ? projects.map(projectCardHtml).join('') : `<div class="empty-state">${t('Aucun projet collectif. Créez-en un pour suivre qui a payé combien.')}</div>`}
    </div>`;

  container.querySelector('#project-add-btn').addEventListener('click', () => openProjectModal());
  container.querySelectorAll('[data-project-id]').forEach((card) => {
    const project = projects.find((p) => p.id === card.dataset.projectId);
    if (!project) return;
    card.querySelector('[data-action="add-contribution"]').addEventListener('click', () => openContributionModal(project, projects));
    card.querySelector('[data-action="edit-project"]').addEventListener('click', () => openProjectModal(project));
    card.querySelector('[data-action="delete-project"]').addEventListener('click', () => deleteProject(project, projects));
    card.querySelectorAll('[data-action="delete-contribution"]').forEach((btn) => {
      btn.addEventListener('click', () => deleteContribution(project, projects, btn.closest('[data-contribution-id]').dataset.contributionId));
    });
  });
}

/* ---------- Projet : création / modification ---------- */
async function openProjectModal(project = null) {
  const baseCurrency = await getSetting('baseCurrency', 'EUR');
  const modal = openModal(`
    <form id="project-form">
      <div class="form-row"><label>${t('Nom du projet')}</label><input type="text" name="name" required maxlength="60" value="${escapeHtml(project?.name || '')}" placeholder="${escapeHtml(t('Ex : Voyage de papa'))}"></div>
      <div class="form-row"><label>${t('Montant à réunir')}</label><input type="number" step="0.01" min="0" name="target" required value="${project?.target ?? ''}"></div>
      ${project ? '' : `<div class="form-row"><label>${t('Devise')}</label>${currencySelectHtml(baseCurrency)}</div>`}
      <p class="fs-12 c-muted mb-12">${project ? '' : t("Une catégorie de dépense exceptionnelle au nom du projet sera créée : vos paiements n'entrent pas dans vos dépenses du mois.")}</p>
      <button type="submit" class="btn btn-primary btn-block">${project ? t('Enregistrer') : t('Créer')}</button>
    </form>`, { title: project ? t('Modifier le projet') : t('Nouveau projet collectif') });
  if (!project) wireCurrencySelect(modal.el);
  const form = modal.el.querySelector('#project-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim().slice(0, 60);
    const target = safeNumber(parseFloat(fd.get('target')));
    if (!name) return;
    if (!(target > 0)) { showToast(t('Saisissez un montant supérieur à 0.')); return; }
    const projects = await loadProjects();
    let record;
    if (project) {
      record = { ...projects.find((p) => p.id === project.id), name, target };
      await dbWriteBatch([projectsOp(projects.map((p) => (p.id === project.id ? record : p)))]);
    } else {
      record = { id: uuid(), name, target, currency: readCurrencyValue(form), categoryId: await ensureProjectCategory(name), createdAt: new Date().toISOString(), contributions: [] };
      await dbWriteBatch([projectsOp([record, ...projects])]);
    }
    await logAudit({ entityType: 'groupProject', entityId: record.id, action: project ? 'update' : 'create', before: project, after: record });
    modal.close();
    showToast(project ? t('Projet mis à jour.') : t('Projet créé.'));
    notifyDataChanged('all');
  });
}

/* ---------- Participation : ajout ---------- */
async function openContributionModal(project, allProjects) {
  const cur = project.currency;
  const [wallets, keptAccounts, keptEntries, keptEnabled, profile] = await Promise.all([
    dbGetAll(STORES.WALLETS), dbGetAll(STORES.KEPT_ACCOUNTS), dbGetAll(STORES.KEPT_ACCOUNT_ENTRIES), getSetting('keptAccountsEnabled', false), getSetting('userProfile', {}),
  ]);
  const dailyWallets = wallets.filter(isDailyWallet);
  // Comptes gardés utilisables pour un prêt : activés dans Paramètres, non archivés, même devise que le projet.
  const keptChoices = keptEnabled ? keptAccounts.filter((a) => !a.archived && a.currency === cur) : [];
  const myName = (profile?.firstName || '').trim() || t('Moi');
  const names = knownContributors(allProjects);

  const modal = openModal(`
    <form id="contribution-form">
      <div class="segmented" data-field="who">
        <button type="button" class="segmented-btn is-active" data-value="other">${t("Quelqu'un d'autre")}</button>
        <button type="button" class="segmented-btn" data-value="me">${t('Moi')}</button>
      </div>
      <div class="form-row" data-field="otherName"><label>${t('Qui a payé ?')}</label>
        <input type="text" name="who" maxlength="60" list="project-names" autocomplete="off">
        <datalist id="project-names">${names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}</datalist></div>
      <div class="form-row"><label>${t('Montant')} (${escapeHtml(cur)})</label><input type="number" step="0.01" min="0" name="amount" required></div>
      <div class="form-row"><label>${t('Date')}</label><input type="date" name="date" value="${todayISO()}"></div>
      <div class="form-row"><label>${t('Note (optionnel)')}</label><input type="text" name="note" maxlength="140"></div>

      <div data-field="meRows" hidden>
        <div class="form-row"><label>${t('Comment payez-vous ?')}</label>
          <select name="funding">
            <option value="wallet">${t('Depuis un de mes portefeuilles')}</option>
            <option value="loan">${t('Avec un prêt')}</option>
          </select></div>
        <div class="form-row" data-field="walletRow"><label data-field="walletLabel">${t('Portefeuille')}</label>
          <select name="walletId">${walletOptionsHtml(dailyWallets, cur)}</select></div>
        <div data-field="loanRows" hidden>
          <div class="form-row"><label>${t('Qui vous prête ?')}</label>
            <select name="lender">
              <option value="person">${t('Une personne ou une banque')}</option>
              ${keptChoices.length ? `<option value="kept">${t('Un de mes comptes gardés')}</option>` : ''}
            </select></div>
          <div class="form-row" data-field="lenderName"><label>${t('Nom du prêteur')}</label><input type="text" name="lenderName" maxlength="60"></div>
          <div class="form-row" data-field="keptRow" hidden><label>${t('Compte gardé')}</label>
            <select name="keptAccountId">${keptChoices.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.ownerName)} — ${formatCurrency(keptBalance(a, keptEntries), a.currency)}</option>`).join('')}</select>
            <p class="fs-12 c-muted mt-6">${t("L'argent sort de ce compte (son solde baisse) et y revient à chaque remboursement. Il reste hors de votre patrimoine ; la dette, elle, y est.")}</p></div>
          <div class="form-row"><label>${t("Taux d'intérêt annuel % (optionnel)")}</label><input type="number" step="0.01" min="0" name="interestRate"></div>
          <div class="form-row"><label>${t('Échéance (optionnel)')}</label><input type="date" name="dueDate"></div>
          <p class="fs-12 c-muted mb-12">${t("Le prêt arrive dans le portefeuille choisi ci-dessus puis ressort aussitôt en dépense exceptionnelle : les deux écritures sont faites pour vous.")}</p>
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${t('Enregistrer')}</button>
    </form>`, { title: t('Participation — {name}', { name: project.name }) });

  const form = modal.el.querySelector('#contribution-form');
  let who = 'other';
  const show = (field, on) => { modal.el.querySelector(`[data-field="${field}"]`).hidden = !on; };
  const refresh = () => {
    show('otherName', who === 'other');
    show('meRows', who === 'me');
    form.elements.who.required = who === 'other';
    const loan = who === 'me' && form.elements.funding.value === 'loan';
    show('loanRows', loan);
    show('walletRow', who === 'me');
    modal.el.querySelector('[data-field="walletLabel"]').textContent = loan ? t('Portefeuille de passage') : t('Portefeuille');
    const kept = loan && form.elements.lender.value === 'kept';
    show('keptRow', kept);
    show('lenderName', loan && !kept);
    form.elements.lenderName.required = loan && !kept;
  };
  modal.el.querySelectorAll('.segmented-btn').forEach((b) => b.addEventListener('click', () => {
    who = b.dataset.value;
    modal.el.querySelectorAll('.segmented-btn').forEach((x) => x.classList.toggle('is-active', x === b));
    refresh();
  }));
  form.elements.funding.addEventListener('change', refresh);
  form.elements.lender.addEventListener('change', refresh);
  refresh();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const amount = safeNumber(parseFloat(fd.get('amount')));
    const date = fd.get('date') || todayISO();
    const note = String(fd.get('note') || '').trim().slice(0, 140);
    if (!(amount > 0)) { showToast(t('Saisissez un montant supérieur à 0.')); return; }

    const projects = await loadProjects();
    const current = projects.find((p) => p.id === project.id);
    if (!current) return;
    const save = (contribution, ops, audit) => async () => {
      const updated = { ...current, contributions: [...(current.contributions || []), contribution] };
      await dbWriteBatch([...ops, projectsOp(projects.map((p) => (p.id === current.id ? updated : p)))]);
      for (const a of audit) await logAudit(a);
      modal.close();
      showToast(t('Participation enregistrée.'));
      notifyDataChanged('all');
    };

    // 1. Quelqu'un d'autre : simple suivi, rien ne bouge chez moi.
    if (who === 'other') {
      const name = String(fd.get('who') || '').trim().slice(0, 60);
      if (!name) return;
      await save({ id: uuid(), who: name, isMe: false, kind: 'other', amount, date, note }, [], [])();
      return;
    }

    // 2. Moi : une vraie dépense exceptionnelle, depuis un portefeuille ou financée par un prêt.
    const walletId = fd.get('walletId');
    if (!walletId) { showToast(t("Créez d'abord un portefeuille en {currency}.", { currency: cur })); return; }
    const expenseTx = {
      id: uuid(), type: 'expense', walletId, targetWalletId: null, categoryId: current.categoryId || null, amount, date,
      note: t('{project} — ma participation', { project: current.name }), tags: [], reconciled: false,
      exceptional: true, projectId: current.id, createdAt: new Date().toISOString(),
    };
    if (fd.get('funding') === 'wallet') {
      await save({ id: uuid(), who: myName, isMe: true, kind: 'wallet', amount, date, note, transactionId: expenseTx.id },
        [{ store: STORES.TRANSACTIONS, type: 'add', value: expenseTx }],
        [{ entityType: 'transaction', entityId: expenseTx.id, action: 'create', after: expenseTx, note: t('Participation à un projet collectif') }])();
      return;
    }

    // Prêt : personne/banque ou compte gardé.
    const useKept = fd.get('lender') === 'kept';
    const keptAccount = useKept ? keptChoices.find((a) => a.id === fd.get('keptAccountId')) : null;
    if (useKept && !keptAccount) { showToast(t('Choisissez un compte gardé.')); return; }
    if (keptAccount && amount > keptBalance(keptAccount, keptEntries) + 0.005) {
      showToast(t("Ce compte gardé ne contient pas assez ({balance}) pour prêter {amount}.", { balance: formatCurrency(keptBalance(keptAccount, keptEntries), cur), amount: formatCurrency(amount, cur) }));
      return;
    }
    const lenderName = keptAccount ? keptAccount.ownerName : String(fd.get('lenderName') || '').trim().slice(0, 60);
    if (!lenderName) return;
    const debt = {
      id: uuid(), type: 'debt', personName: lenderName, principal: amount, currency: cur,
      interestRate: Math.max(0, safeNumber(parseFloat(fd.get('interestRate')))), termMonths: null,
      startDate: date, dueDate: fd.get('dueDate') || null, status: 'active', note: current.name,
      openingTransactionId: null, exceptional: true, projectId: current.id, borrowerName: myName,
      ...(keptAccount ? { keptAccountId: keptAccount.id } : {}), createdAt: new Date().toISOString(),
    };
    const openingTx = {
      id: uuid(), type: 'income', walletId, targetWalletId: null, categoryId: await ensureDebtCategoryId('debt', 'income'), amount, date,
      note: t('Prêt reçu de {name}', { name: lenderName }), tags: [], reconciled: false, debtId: debt.id, createdAt: new Date().toISOString(),
    };
    debt.openingTransactionId = openingTx.id;
    const keptOut = keptAccount ? { id: uuid(), accountId: keptAccount.id, type: 'out', amount, date,
      note: t('Prêt à {name} — {project}', { name: myName, project: current.name }), debtId: debt.id, createdAt: new Date().toISOString() } : null;
    await save({ id: uuid(), who: myName, isMe: true, kind: 'loan', amount, date, note, transactionId: expenseTx.id, debtId: debt.id },
      [
        { store: STORES.DEBTS, type: 'add', value: debt },
        { store: STORES.TRANSACTIONS, type: 'add', value: openingTx },
        { store: STORES.TRANSACTIONS, type: 'add', value: expenseTx },
        ...(keptOut ? [{ store: STORES.KEPT_ACCOUNT_ENTRIES, type: 'add', value: keptOut }] : []),
      ],
      [
        { entityType: 'debt', entityId: debt.id, action: 'create', after: debt, note: t('Prêt pour un projet collectif') },
        { entityType: 'transaction', entityId: expenseTx.id, action: 'create', after: expenseTx, note: t('Participation à un projet collectif') },
      ])();
  });
}

/* ---------- Suppressions ---------- */
async function deleteContribution(project, projects, contributionId) {
  const contribution = (project.contributions || []).find((c) => c.id === contributionId);
  if (!contribution) return;
  const real = contribution.kind !== 'other';
  const message = !real
    ? t('Retirer cette participation de {who} ({amount}) ?', { who: contribution.who, amount: formatCurrency(contribution.amount, project.currency) })
    : contribution.kind === 'wallet'
      ? t('Supprimer votre participation de {amount} ? La dépense créée sur votre portefeuille sera supprimée aussi.', { amount: formatCurrency(contribution.amount, project.currency) })
      : t('Supprimer votre participation de {amount} ? La dépense et le prêt créés pour elle seront supprimés aussi.', { amount: formatCurrency(contribution.amount, project.currency) });
  const ok = await confirmDialog(message, { danger: true, requirePin: real, confirmText: t('Supprimer') });
  if (!ok) return;

  const ops = [];
  if (contribution.kind === 'loan' && contribution.debtId) {
    // Un prêt déjà en partie remboursé ne se supprime pas d'ici : ce serait effacer de vrais remboursements.
    const payments = (await dbGetAll(STORES.DEBT_PAYMENTS)).filter((p) => p.debtId === contribution.debtId);
    if (payments.length) { showToast(t('Ce prêt a déjà été remboursé en partie : supprimez-le depuis Dettes & créances.')); return; }
    await deleteDebtCascade(contribution.debtId);
  }
  if (contribution.transactionId) ops.push({ store: STORES.TRANSACTIONS, type: 'delete', value: contribution.transactionId });
  const updated = { ...project, contributions: project.contributions.filter((c) => c.id !== contributionId) };
  ops.push(projectsOp(projects.map((p) => (p.id === project.id ? updated : p))));
  await dbWriteBatch(ops);
  await logAudit({ entityType: 'groupProject', entityId: project.id, action: 'update', before: project, after: updated, note: t('Participation retirée') });
  showToast(t('Participation retirée.'));
  notifyDataChanged('all');
}

async function deleteProject(project, projects) {
  const real = (project.contributions || []).some((c) => c.kind !== 'other');
  const ok = await confirmDialog(
    real
      ? t('Supprimer le projet « {name} » ? Les dépenses et prêts créés pour vos participations restent dans vos comptes (supprimez-les depuis Transactions ou Dettes & créances si besoin).', { name: project.name })
      : t('Supprimer le projet « {name} » ?', { name: project.name }),
    { danger: true, requirePin: true, confirmText: t('Supprimer') },
  );
  if (!ok) return;
  await dbWriteBatch([projectsOp(projects.filter((p) => p.id !== project.id))]);
  await logAudit({ entityType: 'groupProject', entityId: project.id, action: 'delete', before: project });
  showToast(t('Projet supprimé.'));
  notifyDataChanged('all');
}
