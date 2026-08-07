/* ==========================================================================
   GeoFinance System — Rappels proactifs (budgets, échéances récurrentes)
   Utilise l'API Notification (locale), pas l'API Push : une vraie
   notification "app fermée" nécessiterait un serveur d'envoi, ce qui irait
   à l'encontre du principe 100% local de l'application. Ces rappels
   s'affichent quand l'app est ouverte/réactivée (au déverrouillage), avec
   une dé-duplication pour ne pas re-notifier plusieurs fois la même chose.
   ========================================================================== */

import { STORES, dbGetAll, getSetting, setSetting } from './db.js';
import { computeBudgetVsActual, getAllWalletBalances } from './ledger.js';
import { formatCurrency, formatDate, currentMonthKey, percentage, todayISO } from './utils.js';

export function isNotificationSupported() {
  return 'Notification' in window;
}

export function getNotificationPermission() {
  return isNotificationSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) throw new Error('Les notifications ne sont pas supportées par ce navigateur.');
  return Notification.requestPermission();
}

/**
 * Affiche une notification. Ne propage jamais d'exception : un affichage
 * qui échoue (permission révoquée en cours de route, etc.) ne doit pas
 * interrompre le traitement des autres rappels du lot. Renvoie true/false
 * pour indiquer si l'affichage a réellement réussi (sert à la dé-duplication :
 * on ne marque "notifié" que ce qui a vraiment été montré).
 */
async function fireNotification(title, options) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg?.showNotification) {
      await reg.showNotification(title, { icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', ...options });
    } else {
      new Notification(title, { icon: 'icons/icon-192.png', ...options });
    }
    return true;
  } catch (err) {
    console.warn('[notifications] Échec d\'affichage :', err);
    return false;
  }
}

/** Vérifie les échéances récurrentes proches et les budgets qui dépassent 70/90%, notifie si nouveau. */
export async function checkAndNotify() {
  if (getNotificationPermission() !== 'granted') return;

  const notifiedRecurring = await getSetting('notifiedRecurringDates', {});
  const notifiedBudgets = await getSetting('notifiedBudgetTiers', {});
  const notifiedDebts = await getSetting('notifiedDebtDates', {});
  const notifiedLowBalance = await getSetting('notifiedLowBalanceWallets', {});
  let recurringChanged = false;
  let budgetsChanged = false;
  let debtsChanged = false;
  let lowBalanceChanged = false;

  // ---- Échéances récurrentes dans les 3 prochains jours ----
  const today = todayISO();
  const in3Days = new Date();
  in3Days.setDate(in3Days.getDate() + 3);
  const horizonStr = `${in3Days.getFullYear()}-${String(in3Days.getMonth() + 1).padStart(2, '0')}-${String(in3Days.getDate()).padStart(2, '0')}`;

  const [recurring, wallets] = await Promise.all([dbGetAll(STORES.RECURRING), dbGetAll(STORES.WALLETS)]);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));

  for (const r of recurring) {
    if (!r.active || !r.nextDate) continue;
    if (r.nextDate < today || r.nextDate > horizonStr) continue;
    const key = `${r.id}:${r.nextDate}`;
    if (notifiedRecurring[key]) continue;

    const label = r.type === 'income' ? 'Recette prévue' : 'Facture à venir';
    const ok = await fireNotification(label, {
      body: `${r.name} — ${formatCurrency(r.amount, walletCurrency[r.walletId] || 'EUR')} le ${formatDate(r.nextDate)}`,
      tag: `recurring-${key}`,
    });
    if (ok) { notifiedRecurring[key] = true; recurringChanged = true; }
  }

  // ---- Échéances de dettes/créances dans les 3 prochains jours ----
  const [debts, debtPayments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);
  for (const d of debts) {
    if (d.status === 'paid' || !d.dueDate) continue;
    if (d.dueDate < today || d.dueDate > horizonStr) continue;
    const key = `${d.id}:${d.dueDate}`;
    if (notifiedDebts[key]) continue;

    const paid = debtPayments.filter((p) => p.debtId === d.id).reduce((s, p) => s + p.amount, 0);
    const remaining = Math.max(0, (d.principal || 0) - paid);
    const label = d.type === 'debt' ? 'Dette à échéance' : 'Créance à échéance';
    const ok = await fireNotification(label, {
      body: `${d.personName} — ${formatCurrency(remaining, d.currency)} restant le ${formatDate(d.dueDate)}`,
      tag: `debt-${key}`,
    });
    if (ok) { notifiedDebts[key] = true; debtsChanged = true; }
  }

  // ---- Portefeuilles sous leur seuil d'alerte de solde bas ----
  // Dé-duplication par hystérésis : on ne re-notifie que si le solde est repassé
  // au-dessus du seuil entre-temps (sinon on répéterait la même alerte à chaque vérification).
  const walletBalances = await getAllWalletBalances();
  for (const w of walletBalances) {
    if (w.archived || !w.lowBalanceThreshold) continue;
    if (w.balance < w.lowBalanceThreshold) {
      if (notifiedLowBalance[w.id]) continue;
      const ok = await fireNotification('Solde bas', {
        body: `${w.name} est passé sous ${formatCurrency(w.lowBalanceThreshold, w.currency)} (solde actuel : ${formatCurrency(w.balance, w.currency)}).`,
        tag: `low-balance-${w.id}`,
      });
      if (ok) { notifiedLowBalance[w.id] = true; lowBalanceChanged = true; }
    } else if (notifiedLowBalance[w.id]) {
      delete notifiedLowBalance[w.id];
      lowBalanceChanged = true;
    }
  }

  // ---- Budgets au-delà des seuils d'alerte (réglables dans Paramètres) ----
  const thresholds = await getSetting('budgetAlertThresholds', { warn: 70, danger: 90 });
  const monthKey = currentMonthKey();
  const budgetRows = await computeBudgetVsActual(monthKey);
  for (const row of budgetRows) {
    if (!row.budget) continue;
    const pct = percentage(row.actual, row.budget);
    const tier = pct >= thresholds.danger ? thresholds.danger : pct >= thresholds.warn ? thresholds.warn : 0;
    if (!tier) continue;
    const key = `${row.categoryId}:${monthKey}`;
    if ((notifiedBudgets[key] || 0) >= tier) continue;

    const ok = await fireNotification('Budget bientôt atteint', {
      body: `« ${row.label} » est à ${pct.toFixed(0)}% de sa limite mensuelle.`,
      tag: `budget-${key}`,
    });
    if (ok) { notifiedBudgets[key] = tier; budgetsChanged = true; }
  }

  if (recurringChanged) await setSetting('notifiedRecurringDates', notifiedRecurring);
  if (budgetsChanged) await setSetting('notifiedBudgetTiers', notifiedBudgets);
  if (debtsChanged) await setSetting('notifiedDebtDates', notifiedDebts);
  if (lowBalanceChanged) await setSetting('notifiedLowBalanceWallets', notifiedLowBalance);
}
