/* ==========================================================================
   Djignan Financial System — Rappels proactifs (budgets, échéances récurrentes)
   Utilise l'API Notification (locale), pas l'API Push : une vraie
   notification "app fermée" nécessiterait un serveur d'envoi, ce qui irait
   à l'encontre du principe 100% local de l'application. Ces rappels
   s'affichent quand l'app est ouverte/réactivée (au déverrouillage), avec
   une dé-duplication pour ne pas re-notifier plusieurs fois la même chose.
   ========================================================================== */

import { STORES, dbGetAll, getSetting, setSetting } from './db.js';
import { computeBudgetVsActual, getAllWalletBalances, computeSpendingBetween } from './ledger.js';
import { formatCurrency, formatDate, currentMonthKey, percentage, todayISO, localISODate } from './utils.js';
import { t } from './i18n.js';

/** Lundi (YYYY-MM-DD) de la semaine contenant `date`. */
function mondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = dimanche … 6 = samedi
  d.setDate(d.getDate() + ((day === 0 ? -6 : 1) - day));
  return localISODate(d);
}

export function isNotificationSupported() {
  return 'Notification' in window;
}

export function getNotificationPermission() {
  return isNotificationSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission() {
  if (!isNotificationSupported()) throw new Error(t('Les notifications ne sont pas supportées par ce navigateur.'));
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

    const label = r.type === 'income' ? t('Recette prévue') : t('Facture à venir');
    const ok = await fireNotification(label, {
      body: t('{name} — {amount} le {date}', { name: r.name, amount: formatCurrency(r.amount, walletCurrency[r.walletId] || 'EUR'), date: formatDate(r.nextDate) }),
      tag: `recurring-${key}`,
    });
    if (ok) { notifiedRecurring[key] = true; recurringChanged = true; }
  }

  // ---- Récurrences d'apport d'investissement (DCA) en pause depuis longtemps ----
  // Rappel unique par récurrence tant qu'elle reste en pause (dé-duplication par hystérésis, même
  // principe que les portefeuilles sous seuil de solde bas ci-dessous) : évite d'oublier de
  // reprendre un apport automatique suspendu par erreur.
  const notifiedPausedDca = await getSetting('notifiedPausedDcaRecurring', {});
  let pausedDcaChanged = false;
  const PAUSED_DCA_REMINDER_MS = 30 * 24 * 3600 * 1000; // 30 jours
  for (const r of recurring) {
    if (!r.investmentId) continue;
    if (r.active || !r.pausedAt) {
      if (notifiedPausedDca[r.id]) { delete notifiedPausedDca[r.id]; pausedDcaChanged = true; }
      continue;
    }
    if (Date.now() - new Date(r.pausedAt).getTime() < PAUSED_DCA_REMINDER_MS) continue;
    if (notifiedPausedDca[r.id]) continue;
    const ok = await fireNotification(t('Apport automatique en pause'), {
      body: t('« {name} » est en pause depuis plus de 30 jours — reprenez-le si ce n\'était pas volontaire.', { name: r.name }),
      tag: `paused-dca-${r.id}`,
    });
    if (ok) { notifiedPausedDca[r.id] = true; pausedDcaChanged = true; }
  }
  if (pausedDcaChanged) await setSetting('notifiedPausedDcaRecurring', notifiedPausedDca);

  // ---- Investissements sans réévaluation depuis longtemps ----
  // Sans entrée "valuation", investmentValueAsOf() (ledger.js) retombe sur le capital investi —
  // "Valeur actuelle" (et l'alerte de dérive d'allocation qui en dépend, voir investments.js) peut
  // donc rester silencieusement fausse pendant des mois. Même logique que l'alerte de taux de
  // change non confirmé déjà existante. Dé-duplication liée à la date de dernière valorisation
  // précise (pas juste un booléen) : si l'utilisateur revalorise puis laisse à nouveau traîner,
  // le rappel doit pouvoir se redéclencher.
  const notifiedStaleValuation = await getSetting('notifiedStaleValuation', {});
  let staleValuationChanged = false;
  const STALE_VALUATION_MS = 90 * 24 * 3600 * 1000; // 90 jours
  const [investments, investmentEntries] = await Promise.all([dbGetAll(STORES.INVESTMENTS), dbGetAll(STORES.INVESTMENT_ENTRIES)]);
  for (const inv of investments) {
    const valuations = investmentEntries.filter((e) => e.investmentId === inv.id && e.type === 'valuation').sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const lastValuationDate = valuations[0]?.date || (inv.createdAt || '').slice(0, 10);
    if (!lastValuationDate) continue;
    if (Date.now() - new Date(lastValuationDate).getTime() < STALE_VALUATION_MS) {
      if (notifiedStaleValuation[inv.id]) { delete notifiedStaleValuation[inv.id]; staleValuationChanged = true; }
      continue;
    }
    if (notifiedStaleValuation[inv.id] === lastValuationDate) continue;
    const ok = await fireNotification(t('Réévaluation recommandée'), {
      body: t('« {name} » n\'a pas été réévalué depuis plus de 3 mois — sa valeur affichée peut être obsolète.', { name: inv.name }),
      tag: `stale-valuation-${inv.id}`,
    });
    if (ok) { notifiedStaleValuation[inv.id] = lastValuationDate; staleValuationChanged = true; }
  }
  if (staleValuationChanged) await setSetting('notifiedStaleValuation', notifiedStaleValuation);

  // ---- Échéances de dettes/créances dans les 3 prochains jours ----
  const [debts, debtPayments] = await Promise.all([dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS)]);
  for (const d of debts) {
    if (d.status === 'paid' || !d.dueDate) continue;
    if (d.dueDate < today || d.dueDate > horizonStr) continue;
    const key = `${d.id}:${d.dueDate}`;
    if (notifiedDebts[key]) continue;

    const paid = debtPayments.filter((p) => p.debtId === d.id).reduce((s, p) => s + p.amount, 0);
    const remaining = Math.max(0, (d.principal || 0) - paid);
    const label = d.type === 'debt' ? t('Dette à échéance') : t('Créance à échéance');
    const ok = await fireNotification(label, {
      body: t('{name} — {amount} restant le {date}', { name: d.personName, amount: formatCurrency(remaining, d.currency), date: formatDate(d.dueDate) }),
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
      const ok = await fireNotification(t('Solde bas'), {
        body: t('{name} est passé sous {threshold} (solde actuel : {balance}).', { name: w.name, threshold: formatCurrency(w.lowBalanceThreshold, w.currency), balance: formatCurrency(w.balance, w.currency) }),
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

    const ok = await fireNotification(t('Budget bientôt atteint'), {
      body: t('« {label} » est à {pct}% de sa limite mensuelle.', { label: row.label, pct: pct.toFixed(0) }),
      tag: `budget-${key}`,
    });
    if (ok) { notifiedBudgets[key] = tier; budgetsChanged = true; }
  }

  if (recurringChanged) await setSetting('notifiedRecurringDates', notifiedRecurring);
  if (budgetsChanged) await setSetting('notifiedBudgetTiers', notifiedBudgets);
  if (debtsChanged) await setSetting('notifiedDebtDates', notifiedDebts);
  if (lowBalanceChanged) await setSetting('notifiedLowBalanceWallets', notifiedLowBalance);

  // ---- Résumé de la semaine passée, une fois par semaine au premier déverrouillage ----
  const currentWeekStart = mondayOf(new Date());
  const lastWeeklySummaryWeek = await getSetting('lastWeeklySummaryWeek');
  if (lastWeeklySummaryWeek !== currentWeekStart) {
    const prevWeekEnd = new Date(currentWeekStart);
    prevWeekEnd.setDate(prevWeekEnd.getDate() - 1);
    const prevWeekStart = new Date(prevWeekEnd);
    prevWeekStart.setDate(prevWeekStart.getDate() - 6);
    const prevWeekStartStr = localISODate(prevWeekStart);
    const prevWeekEndStr = localISODate(prevWeekEnd);

    const weekSummary = await computeSpendingBetween(prevWeekStartStr, prevWeekEndStr);
    if (weekSummary.income > 0 || weekSummary.expenses > 0) {
      const ok = await fireNotification(t('Résumé de la semaine'), {
        body: t('{expenses} dépensé, {income} reçu · épargne nette {netSavings}.', {
          expenses: formatCurrency(weekSummary.expenses, weekSummary.currency),
          income: formatCurrency(weekSummary.income, weekSummary.currency),
          netSavings: formatCurrency(weekSummary.netSavings, weekSummary.currency),
        }),
        tag: `weekly-summary-${currentWeekStart}`,
      });
      if (ok) await setSetting('lastWeeklySummaryWeek', currentWeekStart);
    } else {
      // Aucune activité la semaine passée : on marque quand même la semaine comme traitée
      // pour ne pas re-tenter le calcul à chaque déverrouillage.
      await setSetting('lastWeeklySummaryWeek', currentWeekStart);
    }
  }
}
