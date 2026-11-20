/* ==========================================================================
   Djignan Financial System — Vérification de la sauvegarde
   « Ma sauvegarde est-elle utilisable le jour où j'en aurai besoin ? » On ne le découvre d'habitude qu'au moment de restaurer,
   c'est-à-dire trop tard. verifyBackup() rejoue la chaîne complète sans toucher aux données :
     export → texte JSON → relecture → empreinte recalculée → signature comparée à ce qui est en base → validation « à blanc »
     avec les mêmes règles que l'import réel (importAllData, dryRun).
   Toute différence (une table qui perd des lignes, un total de transactions qui bouge, une ligne refusée à l'import) est
   rapportée. Les photos de justificatifs ne sont pas rejouées (lourd) : leur nombre est seulement indiqué.

   Lancée à la demande (Paramètres) et automatiquement au plus une fois par mois après le déverrouillage du propriétaire ;
   un échec reste visible sur le tableau de bord jusqu'à la prochaine vérification réussie. Résultat dans le réglage
   `backupVerification` (propre à l'appareil : jamais exporté).
   ========================================================================== */

import { STORES, dbGetAll, exportAllData, importAllData, getSetting, setSetting } from './db.js';
import { computeIntegrity, checkIntegrity, fingerprintStores, diffFingerprints } from './backup-integrity.js';
import { t } from './i18n.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_CHECK_EVERY_DAYS = 30;

/** Une vérification complète. Si elle trouve un écart, on la REFAIT une fois (verifyBackup) : une écriture arrivée entre l'export et la lecture
    directe de la base (une opération, une ligne de journal) change un compte et ferait croire à un problème qui n'existe pas. */
async function runVerificationOnce() {
  const issues = [];
  let rows = 0;
  let bytes = 0;
  let photos = 0;
  try {
    const data = await exportAllData();
    // Les photos sont comptées puis retirées de la copie : on vérifie la structure, pas leur recompression.
    for (const row of data.stores[STORES.TRANSACTIONS] || []) {
      if (row.receiptBlob) { photos += 1; delete row.receiptBlob; }
    }
    data.integrity = await computeIntegrity(data.stores);
    const json = JSON.stringify(data);
    bytes = json.length;
    const reread = JSON.parse(json); // ce que contiendrait le fichier une fois relu

    if ((await checkIntegrity(reread)) !== 'ok') issues.push(t("L'empreinte de la sauvegarde ne se recalcule pas à l'identique."));

    // Ce qui est réellement en base (lecture directe, indépendante de l'export), comparé à ce que la relecture retrouve.
    const live = {};
    for (const store of Object.values(STORES)) live[store] = await dbGetAll(store);
    const labels = {
      [STORES.TRANSACTIONS]: t('Transactions'), [STORES.WALLETS]: t('Portefeuilles'), [STORES.DEBTS]: t('Dettes & créances'),
      [STORES.CATEGORIES]: t('Catégories'), [STORES.BUDGETS]: t('Budgets'),
    };
    const skip = { skip: [STORES.SETTINGS] };
    issues.push(...diffFingerprints(fingerprintStores(live, skip), fingerprintStores(reread.stores, skip), labels));

    // Validation à blanc : une ligne que l'import refuserait empêcherait toute restauration.
    try {
      const counts = await importAllData(reread, { dryRun: true });
      rows = Object.values(counts || {}).reduce((sum, n) => sum + n, 0);
    } catch {
      issues.push(t("Une restauration serait refusée : au moins une ligne ne respecte pas le format attendu. Faites quand même une sauvegarde, puis contrôlez vos données."));
    }
  } catch (err) {
    issues.push(err?.message || t('Vérification impossible.'));
  }
  return { issues, rows, bytes, photos };
}

export async function verifyBackup({ now = Date.now() } = {}) {
  let outcome = await runVerificationOnce();
  if (outcome.issues.length) outcome = await runVerificationOnce();
  const result = { at: now, ok: outcome.issues.length === 0, ...outcome };
  await setSetting('backupVerification', result);
  return result;
}

export async function getLastBackupVerification() {
  const last = await getSetting('backupVerification', null);
  return last && typeof last === 'object' ? last : null;
}

/** Lance la vérification si la dernière date de plus de 30 jours (ou n'a jamais eu lieu). Renvoie le résultat, ou null si rien à faire. */
export async function maybeRunMonthlyBackupCheck(now = Date.now()) {
  const last = await getLastBackupVerification();
  // Une vérification réussie vaut 30 jours ; un échec est revérifié dès le lendemain (un problème corrigé ne doit pas rester affiché un mois).
  const validFor = (last && last.ok ? BACKUP_CHECK_EVERY_DAYS : 1) * DAY_MS;
  if (last && now - last.at < validFor) return null;
  return verifyBackup({ now });
}

/** Message d'alerte du tableau de bord si la dernière vérification a trouvé un problème, sinon null. */
export async function getBackupVerificationAlert() {
  const last = await getLastBackupVerification();
  if (!last || last.ok) return null;
  return t("La dernière vérification de votre sauvegarde a trouvé un problème : {issue}. Ouvrez Paramètres, section « Vérifier ma sauvegarde », pour la relancer.", { issue: (last.issues && last.issues[0]) || '?' });
}
