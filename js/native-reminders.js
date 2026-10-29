/* ==========================================================================
   Djignan Financial System — Rappels planifiés (application Android)
   Le défaut des rappels actuels (notifications.js) : ils ne s'affichent que si l'appli a été ouverte
   — un loyer, une dette ou une tontine peut donc passer sans le moindre signal. Une PWA ne peut pas
   programmer de notification à une date donnée sans serveur ; l'APK, lui, le peut grâce au plugin
   natif @capacitor/local-notifications : le système Android déclenche la notification à l'heure
   prévue, appli fermée, sans serveur ni compte.

   Ce module ne fait RIEN en dehors de l'APK (plugin absent) : isNativeReminderSupported() renvoie false.
   Prérequis côté APK (hors dépôt, voir CLAUDE.md §9) : `npm install @capacitor/local-notifications`,
   `npx cap sync android`, puis reconstruire et signer l'APK.

   À chaque changement de données, la liste est recalculée en entier : tout ce que ce module avait
   programmé est annulé puis reprogrammé (aucun rappel orphelin après une suppression ou un report).
   Rappels : la veille et le jour même à 9 h, pour les prochains 45 jours — récurrences, échéances de
   dettes/créances, tours de tontine.
   ========================================================================== */

import { STORES, dbGetAll, getSetting, setSetting } from './db.js';
import { formatCurrency, formatDate, todayISO, ZERO_DECIMAL_CURRENCIES } from './utils.js';
import { unpaidInstallments } from './loan-schedule.js';
import { roundDate } from './modules/tontines.js';
import { t } from './i18n.js';

const HORIZON_DAYS = 45;
const REMINDER_HOUR = 9;

function plugin() {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.LocalNotifications || null : null;
}

export function isNativeReminderSupported() {
  return !!plugin();
}

/** Identifiant entier stable (le plugin exige un entier 32 bits) dérivé d'une clé de rappel. */
export function reminderId(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2147483000 + 1;
}

function atNineOn(isoDay, daysBefore = 0) {
  const [y, m, d] = isoDay.split('-').map(Number);
  return new Date(y, m - 1, d - daysBefore, REMINDER_HOUR, 0, 0, 0);
}

/** Liste pure des rappels à programmer : [{ key, at: Date, title, body }], triée par date, uniquement
    dans le futur et dans l'horizon. Aucun accès base : testable hors navigateur. */
export function buildReminderPlan({ recurring = [], debts = [], payments = [], tontines = [], wallets = [], now = new Date() }) {
  const horizon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + HORIZON_DAYS);
  const walletCurrency = Object.fromEntries(wallets.map((w) => [w.id, w.currency]));
  const plan = [];
  const push = (key, isoDay, daysBefore, title, body) => {
    const at = atNineOn(isoDay, daysBefore);
    if (at > now && at <= horizon) plan.push({ key: `${key}:${daysBefore}`, at, title, body });
  };

  for (const r of recurring) {
    if (!r.active || !r.nextDate || r.investmentId) continue;
    const label = r.type === 'income' ? t('Recette prévue') : t('Facture à venir');
    const body = t('{name} — {amount} le {date}', { name: r.name, amount: formatCurrency(r.amount, walletCurrency[r.walletId] || 'XOF'), date: formatDate(r.nextDate) });
    push(`rec-${r.id}-${r.nextDate}`, r.nextDate, 1, label, body);
    push(`rec-${r.id}-${r.nextDate}`, r.nextDate, 0, label, body);
  }

  for (const d of debts) {
    const nextInstallment = unpaidInstallments(d, payments, todayISO(), ZERO_DECIMAL_CURRENCIES.has(d.currency) ? 0 : 2)[0];
    if (nextInstallment) {
      const label = nextInstallment.date < todayISO() ? t('Mensualité en retard') : (d.type === 'debt' ? t('Mensualité de prêt à venir') : t('Mensualité à encaisser'));
      const body = t('{name} — {amount} le {date}', { name: d.personName, amount: formatCurrency(nextInstallment.payment, d.currency), date: formatDate(nextInstallment.date) });
      push(`inst-${d.id}-${nextInstallment.date}`, nextInstallment.date < todayISO() ? todayISO() : nextInstallment.date, 1, label, body);
      push(`inst-${d.id}-${nextInstallment.date}`, nextInstallment.date < todayISO() ? todayISO() : nextInstallment.date, 0, label, body);
    }
    if (d.status === 'paid' || d.status === 'cancelled' || !d.dueDate) continue;
    const paid = payments.filter((p) => p.debtId === d.id).reduce((s, p) => s + p.amount, 0);
    const remaining = Math.max(0, (d.principal || 0) - paid);
    if (remaining <= 0.005) continue;
    const label = d.type === 'debt' ? t('Dette à échéance') : t('Créance à échéance');
    const body = t('{name} — {amount} restant le {date}', { name: d.personName, amount: formatCurrency(remaining, d.currency), date: formatDate(d.dueDate) });
    push(`debt-${d.id}-${d.dueDate}`, d.dueDate, 1, label, body);
    push(`debt-${d.id}-${d.dueDate}`, d.dueDate, 0, label, body);
  }

  for (const tn of tontines) {
    for (let i = 0; i < tn.members.length; i++) {
      const day = roundDate(tn, i);
      if (day < todayISO()) continue;
      const paidByMe = (tn.payments || []).some((p) => p.round === i && tn.members.find((m) => m.id === p.memberId)?.isMe);
      if (paidByMe) continue;
      const body = t('Tontine « {tontine} », tour {n} le {date} : cotisation {amount}.', { tontine: tn.name, n: i + 1, date: formatDate(day), amount: formatCurrency(tn.amount, tn.currency) });
      push(`tontine-${tn.id}-${i}`, day, 1, t('Tontine : cotisation à venir'), body);
      push(`tontine-${tn.id}-${i}`, day, 0, t('Tontine : cotisation à venir'), body);
      break; // le prochain tour non payé suffit ; les suivants seront programmés après
    }
  }

  return plan.sort((a, b) => a.at - b.at);
}

let syncing = null;

/** Recalcule et reprogramme tous les rappels. Renvoie le nombre programmé (0 si non supporté ou
    désactivé). Ne lève jamais : un échec de programmation ne doit pas gêner l'appli. */
export function syncNativeReminders() {
  if (syncing) return syncing; // un seul recalcul à la fois ; le suivant verra les dernières données
  syncing = (async () => {
    try {
      const lib = plugin();
      if (!lib || !(await getSetting('nativeRemindersEnabled', false))) return 0;
      const perm = await lib.checkPermissions();
      if (perm.display !== 'granted') return 0;

      const [recurring, debts, payments, tontines, wallets] = await Promise.all([
        dbGetAll(STORES.RECURRING), dbGetAll(STORES.DEBTS), dbGetAll(STORES.DEBT_PAYMENTS), dbGetAll(STORES.TONTINES), dbGetAll(STORES.WALLETS),
      ]);
      const plan = buildReminderPlan({ recurring, debts, payments, tontines, wallets });

      // Annule tout ce que ce module avait programmé (identifiants mémorisés), puis reprogramme.
      const previous = await getSetting('nativeReminderIds', []);
      if (previous.length) await lib.cancel({ notifications: previous.map((id) => ({ id })) });
      const notifications = plan.map((p) => ({ id: reminderId(p.key), title: p.title, body: p.body, schedule: { at: p.at, allowWhileIdle: true } }));
      if (notifications.length) await lib.schedule({ notifications });
      await setSetting('nativeReminderIds', notifications.map((n) => n.id));
      return notifications.length;
    } catch (err) {
      console.warn('[Rappels planifiés]', err);
      return 0;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Active les rappels planifiés : demande l'autorisation Android (13+), puis programme. */
export async function enableNativeReminders() {
  const lib = plugin();
  if (!lib) throw new Error(t("Disponible uniquement dans l'application Android."));
  const perm = await lib.requestPermissions();
  if (perm.display !== 'granted') throw new Error(t('Autorisation refusée : activez les notifications pour Djignan dans les réglages Android.'));
  await setSetting('nativeRemindersEnabled', true);
  return syncNativeReminders();
}

export async function disableNativeReminders() {
  const lib = plugin();
  await setSetting('nativeRemindersEnabled', false);
  const previous = await getSetting('nativeReminderIds', []);
  if (lib && previous.length) await lib.cancel({ notifications: previous.map((id) => ({ id })) }).catch(() => {});
  await setSetting('nativeReminderIds', []);
}
