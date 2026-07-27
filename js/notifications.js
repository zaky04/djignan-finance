/* ==========================================================================
   GeoFinance System — Rappels proactifs (budgets, échéances récurrentes)
   Utilise l'API Notification (locale), pas l'API Push : une vraie
   notification "app fermée" nécessiterait un serveur d'envoi, ce qui irait
   à l'encontre du principe 100% local de l'application. Ces rappels
   s'affichent quand l'app est ouverte/réactivée (au déverrouillage), avec
   une dé-duplication pour ne pas re-notifier plusieurs fois la même chose.
   ========================================================================== */

import { STORES, dbGetAll, getSetting, setSetting } from './db.js';
import { computeBudgetVsActual } from './ledger.js';
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
  let recurringChanged = false;
  let budgetsChanged = false;

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

  // ---- Budgets à 70%/90% du mois en cours ----
  const monthKey = currentMonthKey();
  const budgetRows = await computeBudgetVsActual(monthKey);
  for (const row of budgetRows) {
    if (!row.budget) continue;
    const pct = percentage(row.actual, row.budget);
    const tier = pct >= 90 ? 90 : pct >= 70 ? 70 : 0;
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
}
