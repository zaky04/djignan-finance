/* ==========================================================================
   GeoFinance System — Module Portefeuilles & Devises
   ========================================================================== */

import { STORES, dbGetAll, dbPut, dbAdd, dbDelete, dbGetAllByIndex, logAudit, getSetting, setSetting } from '../db.js';
import { getAllWalletBalances, computeNetWorth, computeNetWorthHistory, computeNetWorthComposition, computeMonthlyBudgetSummary, computeEndOfMonthForecast } from '../ledger.js';
import { uuid, formatCurrency, escapeHtml, todayISO, currentMonthKey, openModal, confirmDialog, showToast, currencySelectHtml, wireCurrencySelect, readCurrencyValue } from '../utils.js';
import { notifyDataChanged } from '../state.js';
import { renderExpensesByCategoryChart } from '../charts.js';

function setAmount(el, value, currency) {
  if (!el) return;
  el.dataset.value = value;
  el.textContent = formatCurrency(value, currency);
}

async function renderWealthHero() {
  const [{ total, currency }, netWorthHistory, monthlyBudget, forecast, composition] = await Promise.all([
    computeNetWorth(),
    computeNetWorthHistory(6),
    computeMonthlyBudgetSummary(currentMonthKey()),
    computeEndOfMonthForecast(),
    computeNetWorthComposition(),
  ]);

  const compositionRows = [
    { label: 'Liquidités', value: composition.liquid, color: '#4f5bff' },
    { label: 'Investissements', value: composition.invested, color: '#16a34a' },
    { label: 'Créances', value: composition.receivables, color: '#0891b2' },
    { label: 'Dettes', value: composition.debts, color: '#e11d48' },
  ].filter((r) => r.value > 0);
  renderExpensesByCategoryChart('chart-net-worth-composition', compositionRows, composition.currency);

  setAmount(document.getElementById('net-worth-value'), total, currency);
  const trendEl = document.getElementById('net-worth-trend');
  if (trendEl) {
    if (netWorthHistory.length >= 2) {
      const prev = netWorthHistory[netWorthHistory.length - 2].value;
      const diff = total - prev;
      const sign = diff >= 0 ? '+' : '';
      const pctLabel = prev !== 0 ? ` (${sign}${((diff / Math.abs(prev)) * 100).toFixed(1)}%)` : '';
      trendEl.textContent = `${sign}${formatCurrency(diff, currency)}${pctLabel} vs mois dernier`;
    } else {
      trendEl.textContent = 'Pas encore assez d\'historique';
    }
  }

  const upcomingBillsTotal = forecast.upcoming
    .filter((u) => u.type === 'expense')
    .reduce((sum, u) => sum + u.amountBase, 0);
  const reservedBudget = Math.max(0, monthlyBudget.remaining);
  const safeToSpend = forecast.current - upcomingBillsTotal - reservedBudget;
  setAmount(document.getElementById('safe-to-spend-value'), safeToSpend, forecast.currency);
  document.getElementById('hero-safe-to-spend')?.classList.toggle('is-negative', safeToSpend < 0);
  const safeTrendEl = document.getElementById('safe-to-spend-trend');
  if (safeTrendEl) {
    safeTrendEl.textContent = safeToSpend >= 0
      ? 'Après budgets réservés et échéances à venir'
      : '⚠ Dépenses prévues supérieures aux liquidités disponibles';
  }
}

const WALLET_TYPES = {
  bank: { label: 'Compte bancaire', icon: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2 2 8v2h20V8L12 2Zm-7 9v7H3v2h18v-2h-2v-7h-2v7h-3v-7h-2v7H9v-7H7v7H5v-7H3Z"/></svg>' },
  mobile_money: { label: 'Mobile Money', icon: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm0 4v12h10V6H7Zm5 13.2a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4Z"/></svg>' },
  cash: { label: 'Espèces', icon: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M2 6h20v12H2V6Zm2 2v8h16V8H4Zm8 1.5A2.5 2.5 0 1 1 9.5 12 2.5 2.5 0 0 1 12 9.5ZM5 8v2a2 2 0 0 0 2-2H5Zm14 0h-2a2 2 0 0 0 2 2V8ZM5 16v-2a2 2 0 0 0-2 2h2Zm14 0h2a2 2 0 0 0-2-2v2Z"/></svg>' },
  investment: { label: "Portefeuille d'investissement", icon: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 17l6-6 4 4 8-8 1.4 1.4L14 17.8l-4-4-5 5z"/></svg>' },
  savings: { label: 'Épargne spécifique', icon: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2c-4 3-9 3.5-9 3.5V12c0 6 4 9.5 9 10.5 5-1 9-4.5 9-10.5V5.5S16 5 12 2Z"/></svg>' },
};

function walletFormHtml(wallet, defaultCurrency) {
  const isEdit = !!wallet;
  return `
    <form id="wallet-form">
      <div class="form-row">
        <label>Nom du portefeuille</label>
        <input type="text" name="name" required maxlength="60" value="${escapeHtml(wallet?.name || '')}" placeholder="Ex: BNP Paribas, Orange Money…">
      </div>
      <div class="form-row">
        <label>Type</label>
        <select name="type">
          ${Object.entries(WALLET_TYPES).map(([key, meta]) => `<option value="${key}" ${wallet?.type === key ? 'selected' : ''}>${meta.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label>Devise</label>
        ${currencySelectHtml(wallet?.currency || defaultCurrency)}
      </div>
      <div class="form-row">
        <label>${isEdit ? 'Solde initial' : 'Solde de départ'}</label>
        <input type="number" step="0.01" name="initialBalance" value="${wallet?.initialBalance ?? 0}">
      </div>
      <div class="form-row">
        <label>Seuil d'alerte de solde bas (optionnel)</label>
        <input type="number" min="0" step="0.01" name="lowBalanceThreshold" value="${wallet?.lowBalanceThreshold ?? ''}" placeholder="Ex: 50">
      </div>
      <button type="submit" class="btn btn-primary btn-block">${isEdit ? 'Enregistrer' : 'Créer le portefeuille'}</button>
    </form>`;
}

async function openWalletModal(wallet = null) {
  const defaultCurrency = wallet ? wallet.currency : await getSetting('baseCurrency', 'EUR');
  const modal = openModal(walletFormHtml(wallet, defaultCurrency), { title: wallet ? 'Modifier le portefeuille' : 'Nouveau portefeuille' });
  wireCurrencySelect(modal.el);
  modal.el.querySelector('#wallet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const currency = readCurrencyValue(e.target);
    const before = wallet ? { ...wallet } : null;
    const record = {
      id: wallet?.id || uuid(),
      name: fd.get('name').trim(),
      type: fd.get('type'),
      currency,
      initialBalance: parseFloat(fd.get('initialBalance')) || 0,
      lowBalanceThreshold: parseFloat(fd.get('lowBalanceThreshold')) || 0,
      archived: wallet?.archived || false,
      createdAt: wallet?.createdAt || new Date().toISOString(),
    };
    await dbPut(STORES.WALLETS, record);
    await logAudit({ entityType: 'wallet', entityId: record.id, action: wallet ? 'update' : 'create', before, after: record });
    await ensureExchangeRateRow(currency);
    modal.close();
    showToast(wallet ? 'Portefeuille mis à jour.' : 'Portefeuille créé.');
    notifyDataChanged('wallets');
  });
}

async function ensureExchangeRateRow(currency) {
  const base = await getSetting('baseCurrency', 'EUR');
  if (currency === base) return;
  const existing = await dbGetAll(STORES.EXCHANGE_RATES);
  if (!existing.some((r) => r.code === currency)) {
    // confirmed:false tant que l'utilisateur n'a pas explicitement saisi/validé ce taux —
    // 1:1 est presque toujours faux (ex: 1 XOF ≠ 1 EUR) et fausserait silencieusement le
    // patrimoine net si on ne le signalait pas (voir renderRatesPanel + dashboard.js).
    await dbPut(STORES.EXCHANGE_RATES, { code: currency, rateToBase: 1, confirmed: false });
  }
}

function walletCardHtml(w) {
  const meta = WALLET_TYPES[w.type] || WALLET_TYPES.bank;
  return `
    <div class="summary-card" data-wallet-id="${w.id}">
      <div class="card-title-row">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="tx-icon">${meta.icon}</div>
          <div>
            <div class="summary-card-label">${escapeHtml(meta.label)} · ${escapeHtml(w.currency)}</div>
            <div style="font-weight:700;font-size:14.5px;">${escapeHtml(w.name)}</div>
          </div>
        </div>
        <div class="card-actions">
          <button type="button" class="icon-btn" data-action="edit" title="Modifier">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25ZM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z"/></svg>
          </button>
          <button type="button" class="icon-btn" data-action="archive" title="${w.archived ? 'Désarchiver' : 'Archiver'}">
            <svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M3 4h18v4H3V4Zm1 6h16v10H4V10Zm4 3v2h8v-2H8Z"/></svg>
          </button>
        </div>
      </div>
      <div class="summary-card-value amount" data-value="${w.balance}">${formatCurrency(w.balance, w.currency)}</div>
    </div>`;
}

/** Récupère les taux du jour depuis un service public gratuit, sans clé d'API (open.er-api.com).
    Renvoie { code: unités de `code` pour 1 unité de `base` } — c'est l'inverse de notre
    convention rateToBase (voir convertAmount() dans utils.js), à inverser à l'usage. Best-effort :
    l'app doit rester 100% utilisable sans ça, donc tout échec (hors-ligne, service indisponible,
    devise absente de la réponse) se dégrade en simple message, jamais en blocage. */
async function fetchLiveRates(base) {
  const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`);
  if (!res.ok) throw new Error('Requête réseau échouée');
  const data = await res.json();
  if (data.result !== 'success' || !data.rates) throw new Error('Réponse inattendue du service');
  return data.rates;
}

async function renderRatesPanel() {
  const panel = document.getElementById('wallets-rates-panel');
  if (!panel) return;
  const base = await getSetting('baseCurrency', 'EUR');
  const rates = await dbGetAll(STORES.EXCHANGE_RATES);
  if (!rates.length) {
    panel.innerHTML = `<div class="panel"><h3 style="margin-bottom:6px;">Taux de change</h3><p class="empty-state" style="padding:12px 0;">Aucune devise étrangère utilisée. Devise de base : <strong>${escapeHtml(base)}</strong>.</p></div>`;
    return;
  }
  const unconfirmedCount = rates.filter((r) => r.confirmed === false).length;
  panel.innerHTML = `
    <div class="panel">
      <div class="panel-header">
        <h3>Taux de change (devise de base : ${escapeHtml(base)})</h3>
        <button type="button" class="btn btn-ghost" id="rates-fetch-live-btn">Actualiser via internet</button>
      </div>
      ${unconfirmedCount ? `<p class="alert alert-warn" style="margin-bottom:10px;">⚠ ${unconfirmedCount > 1 ? `${unconfirmedCount} taux ne sont` : 'Un taux n\'est'} pas encore confirmé (valeur 1:1 par défaut, presque certainement fausse). Corrigez-les ci-dessous pour un patrimoine net exact.</p>` : ''}
      <div class="filters-bar" style="flex-direction:column;align-items:stretch;gap:10px;">
        ${rates.map((r) => `
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="badge ${r.confirmed === false ? 'badge-neg' : 'badge-accent'}" style="min-width:56px;justify-content:center;">${escapeHtml(r.code)}</span>
            <span style="font-size:13px;color:var(--text-muted);">1 ${escapeHtml(r.code)} =</span>
            <input type="number" step="0.0001" min="0" data-rate-code="${escapeHtml(r.code)}" value="${r.rateToBase}" style="width:110px;padding:7px 9px;border-radius:8px;border:1px solid ${r.confirmed === false ? 'var(--neg)' : 'var(--border)'};background:var(--surface);">
            <span style="font-size:13px;color:var(--text-muted);">${escapeHtml(base)}</span>
            ${r.confirmed === false ? '<span style="font-size:12px;color:var(--neg);">non confirmé</span>' : ''}
          </div>`).join('')}
      </div>
    </div>`;

  panel.querySelector('#rates-fetch-live-btn').addEventListener('click', async () => {
    const btn = panel.querySelector('#rates-fetch-live-btn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Récupération…';
    try {
      const live = await fetchLiveRates(base);
      let updated = 0;
      const missing = [];
      for (const r of rates) {
        const unitsPerBase = Number(live[r.code]);
        if (!isFinite(unitsPerBase) || unitsPerBase <= 0) { missing.push(r.code); continue; }
        const rateToBase = 1 / unitsPerBase;
        await dbPut(STORES.EXCHANGE_RATES, { code: r.code, rateToBase, confirmed: true });
        await dbAdd(STORES.EXCHANGE_RATE_HISTORY, { id: uuid(), code: r.code, date: todayISO(), rateToBase });
        updated++;
      }
      showToast(updated
        ? `${updated} taux mis à jour.${missing.length ? ` Introuvables : ${missing.join(', ')} (à saisir manuellement).` : ''}`
        : `Aucun taux trouvé pour vos devises (${missing.join(', ')}) — saisissez-les manuellement.`);
      notifyDataChanged('rates');
    } catch {
      showToast('Récupération impossible (hors-ligne ou service indisponible). Vous pouvez toujours saisir les taux manuellement.');
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });

  panel.querySelectorAll('[data-rate-code]').forEach((input) => {
    input.addEventListener('change', async () => {
      const code = input.dataset.rateCode;
      const value = parseFloat(input.value) || 0;
      await dbPut(STORES.EXCHANGE_RATES, { code, rateToBase: value, confirmed: true });
      // On archive le taux du jour dans l'historique AVANT d'appliquer le nouveau,
      // pour que les calculs de patrimoine passés restent basés sur le taux qui
      // était réellement en vigueur à chaque date (voir ledger.js ratesAsOf()).
      await dbAdd(STORES.EXCHANGE_RATE_HISTORY, { id: uuid(), code, date: todayISO(), rateToBase: value });
      showToast(`Taux de ${code} mis à jour.`);
      notifyDataChanged('rates');
    });
  });
}

export async function renderWallets() {
  const grid = document.getElementById('wallets-grid');
  if (!grid) return;
  await renderWealthHero();
  const wallets = await getAllWalletBalances();
  const active = wallets.filter((w) => !w.archived);
  const archived = wallets.filter((w) => w.archived);

  if (!active.length && !archived.length) {
    grid.innerHTML = '<div class="empty-state">Aucun portefeuille pour le moment. Créez votre premier compte bancaire, mobile money ou espèces.</div>';
  } else {
    grid.innerHTML = active.map(walletCardHtml).join('') +
      (archived.length ? `<div style="grid-column:1/-1;font-size:12.5px;color:var(--text-faint);font-weight:700;margin-top:8px;">ARCHIVÉS</div>${archived.map(walletCardHtml).join('')}` : '');
  }

  if (!document.getElementById('wallets-rates-panel')) {
    const panel = document.createElement('div');
    panel.id = 'wallets-rates-panel';
    grid.after(panel);
  }
  await renderRatesPanel();
}

export function initWalletsModule() {
  document.getElementById('wallet-add-btn')?.addEventListener('click', () => openWalletModal());

  document.getElementById('wallets-grid')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const card = e.target.closest('[data-wallet-id]');
    const walletId = card?.dataset.walletId;
    const wallets = await dbGetAll(STORES.WALLETS);
    const wallet = wallets.find((w) => w.id === walletId);
    if (!wallet) return;

    if (btn.dataset.action === 'edit') {
      openWalletModal(wallet);
    } else if (btn.dataset.action === 'archive') {
      const txCount = (await dbGetAllByIndex(STORES.TRANSACTIONS, 'byWallet', walletId)).length;
      if (!wallet.archived && txCount === 0) {
        const ok = await confirmDialog(`Supprimer définitivement "${wallet.name}" ? Ce portefeuille n'a aucune transaction, la suppression est possible.`, { danger: true, confirmText: 'Supprimer' });
        if (ok) {
          await dbDelete(STORES.WALLETS, walletId);
          await logAudit({ entityType: 'wallet', entityId: walletId, action: 'delete', before: wallet });
          showToast('Portefeuille supprimé.');
          notifyDataChanged('wallets');
        }
        return;
      }
      const before = { ...wallet };
      wallet.archived = !wallet.archived;
      await dbPut(STORES.WALLETS, wallet);
      await logAudit({ entityType: 'wallet', entityId: walletId, action: 'update', before, after: wallet, note: wallet.archived ? 'Archivé' : 'Désarchivé' });
      showToast(wallet.archived ? 'Portefeuille archivé.' : 'Portefeuille désarchivé.');
      notifyDataChanged('wallets');
    }
  });
}

export { WALLET_TYPES, openWalletModal };
