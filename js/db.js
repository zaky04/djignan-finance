/* ==========================================================================
   Djignan Financial System — Couche IndexedDB
   Toutes les données de l'application vivent exclusivement dans IndexedDB.
   Les identifiants sont des UUID applicatifs (pas d'autoIncrement) afin que
   l'import/export JSON puisse fusionner ou restaurer sans collision.
   ========================================================================== */

import { DEFAULT_CATEGORY_LOOK } from './icons.js';
import { mergeProjectLists } from './group-project.js';

// Le nom de la base est normalement fixe ; le seul point d'extension est un test dédié
// (test/ledger.test.html) qui pose ce global AVANT d'importer ce module pour rediriger toutes
// les opérations vers une base IndexedDB isolée, jamais celle de l'utilisateur. Sur une page
// normale de l'app, ce global n'existe jamais : comportement inchangé.
export const DB_NAME = (typeof window !== 'undefined' && window.__GEOFINANCE_TEST_DB_NAME__) || 'geofinance-db';
export const DB_VERSION = 5;

export const STORES = {
  WALLETS: 'wallets',
  TRANSACTIONS: 'transactions',
  CATEGORIES: 'categories',
  BUDGETS: 'budgets',
  RECURRING: 'recurring',
  SAVINGS_GOALS: 'savingsGoals',
  INVESTMENTS: 'investments',
  INVESTMENT_ENTRIES: 'investmentEntries',
  DEBTS: 'debts',
  DEBT_PAYMENTS: 'debtPayments',
  EXCHANGE_RATES: 'exchangeRates',
  EXCHANGE_RATE_HISTORY: 'exchangeRateHistory',
  AUDIT_LOG: 'auditLog',
  SETTINGS: 'settings',
  PARTICIPANTS: 'participants',
  SHARED_EXPENSES: 'sharedExpenses',
  CATEGORIZATION_RULES: 'categorizationRules',
  KEPT_ACCOUNTS: 'keptAccounts',
  KEPT_ACCOUNT_ENTRIES: 'keptAccountEntries',
  TONTINES: 'tontines',
};

/** Catégories créées au tout premier boot (seedDefaultsIfNeeded(), app.js) et réutilisées telles
    quelles par le mode démo (demo-data.js, qui doit les recréer lui-même car il vide STORES.
    CATEGORIES via wipeAllData()/wipeUserData() avant de semer ses données) — un seul jeu de
    référence pour éviter que les deux listes dérivent l'une de l'autre en silence (une catégorie
    renommée d'un côté seulement casserait les correspondances par nom du mode démo). */
export const DEFAULT_CATEGORIES = [
  { name: 'Salaire', type: 'income' },
  { name: 'Autres revenus', type: 'income' },
  { name: 'Alimentation', type: 'expense' },
  { name: 'Logement', type: 'expense' },
  { name: 'Transport', type: 'expense' },
  { name: 'Loisirs', type: 'expense' },
  { name: 'Santé', type: 'expense' },
  { name: 'Abonnements', type: 'expense' },
  { name: 'Autres dépenses', type: 'expense' },
].map((c) => ({ ...c, ...DEFAULT_CATEGORY_LOOK[c.name] }));

let dbPromise = null;

function upgrade(db) {
  if (!db.objectStoreNames.contains(STORES.WALLETS)) {
    const s = db.createObjectStore(STORES.WALLETS, { keyPath: 'id' });
    s.createIndex('byArchived', 'archived');
  }
  if (!db.objectStoreNames.contains(STORES.TRANSACTIONS)) {
    const s = db.createObjectStore(STORES.TRANSACTIONS, { keyPath: 'id' });
    s.createIndex('byWallet', 'walletId');
    s.createIndex('byDate', 'date');
    s.createIndex('byCategory', 'categoryId');
    s.createIndex('byType', 'type');
    s.createIndex('byReconciled', 'reconciled');
  }
  if (!db.objectStoreNames.contains(STORES.CATEGORIES)) {
    const s = db.createObjectStore(STORES.CATEGORIES, { keyPath: 'id' });
    s.createIndex('byParent', 'parentId');
    s.createIndex('byType', 'type');
  }
  if (!db.objectStoreNames.contains(STORES.BUDGETS)) {
    const s = db.createObjectStore(STORES.BUDGETS, { keyPath: 'id' });
    s.createIndex('byMonth', 'month');
    s.createIndex('byCategory', 'categoryId');
  }
  if (!db.objectStoreNames.contains(STORES.RECURRING)) {
    const s = db.createObjectStore(STORES.RECURRING, { keyPath: 'id' });
    s.createIndex('byActive', 'active');
    s.createIndex('byNextDate', 'nextDate');
  }
  if (!db.objectStoreNames.contains(STORES.SAVINGS_GOALS)) {
    const s = db.createObjectStore(STORES.SAVINGS_GOALS, { keyPath: 'id' });
    s.createIndex('byArchived', 'archived');
  }
  if (!db.objectStoreNames.contains(STORES.INVESTMENTS)) {
    const s = db.createObjectStore(STORES.INVESTMENTS, { keyPath: 'id' });
    s.createIndex('byAssetClass', 'assetClass');
  }
  if (!db.objectStoreNames.contains(STORES.INVESTMENT_ENTRIES)) {
    const s = db.createObjectStore(STORES.INVESTMENT_ENTRIES, { keyPath: 'id' });
    s.createIndex('byInvestment', 'investmentId');
    s.createIndex('byDate', 'date');
  }
  if (!db.objectStoreNames.contains(STORES.DEBTS)) {
    const s = db.createObjectStore(STORES.DEBTS, { keyPath: 'id' });
    s.createIndex('byType', 'type');
    s.createIndex('byStatus', 'status');
  }
  if (!db.objectStoreNames.contains(STORES.DEBT_PAYMENTS)) {
    const s = db.createObjectStore(STORES.DEBT_PAYMENTS, { keyPath: 'id' });
    s.createIndex('byDebt', 'debtId');
  }
  if (!db.objectStoreNames.contains(STORES.EXCHANGE_RATES)) {
    db.createObjectStore(STORES.EXCHANGE_RATES, { keyPath: 'code' });
  }
  if (!db.objectStoreNames.contains(STORES.EXCHANGE_RATE_HISTORY)) {
    const s = db.createObjectStore(STORES.EXCHANGE_RATE_HISTORY, { keyPath: 'id' });
    s.createIndex('byCode', 'code');
    s.createIndex('byDate', 'date');
  }
  if (!db.objectStoreNames.contains(STORES.AUDIT_LOG)) {
    const s = db.createObjectStore(STORES.AUDIT_LOG, { keyPath: 'id' });
    s.createIndex('byTimestamp', 'timestamp');
    s.createIndex('byEntity', 'entityType');
  }
  if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
    db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(STORES.PARTICIPANTS)) {
    db.createObjectStore(STORES.PARTICIPANTS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORES.SHARED_EXPENSES)) {
    const s = db.createObjectStore(STORES.SHARED_EXPENSES, { keyPath: 'id' });
    s.createIndex('byDate', 'date');
  }
  if (!db.objectStoreNames.contains(STORES.CATEGORIZATION_RULES)) {
    const s = db.createObjectStore(STORES.CATEGORIZATION_RULES, { keyPath: 'id' });
    s.createIndex('byCategory', 'categoryId');
  }
  // Comptes gardés : argent de tiers (famille, proches) que l'utilisateur garde/gère. Stores
  // volontairement séparés des portefeuilles/transactions personnels — aucune fonction de
  // ledger.js ne doit jamais les lire, pour ne jamais les compter dans le patrimoine net.
  if (!db.objectStoreNames.contains(STORES.KEPT_ACCOUNTS)) {
    const s = db.createObjectStore(STORES.KEPT_ACCOUNTS, { keyPath: 'id' });
    s.createIndex('byArchived', 'archived');
  }
  if (!db.objectStoreNames.contains(STORES.KEPT_ACCOUNT_ENTRIES)) {
    const s = db.createObjectStore(STORES.KEPT_ACCOUNT_ENTRIES, { keyPath: 'id' });
    s.createIndex('byAccount', 'accountId');
  }
  // Tontines (module optionnel, js/modules/tontines.js) : cercles d'épargne rotative. Membres,
  // ordre des tours et paiements vivent DANS le document (petit, jamais requêté par champ).
  if (!db.objectStoreNames.contains(STORES.TONTINES)) {
    db.createObjectStore(STORES.TONTINES, { keyPath: 'id' });
  }
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => upgrade(e.target.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('[DB] Mise à niveau bloquée par un autre onglet ouvert.');
  });
  return dbPromise;
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- CRUD génériques ---------- */
export async function dbGet(store, id) {
  const db = await openDatabase();
  return reqToPromise(tx(db, store, 'readonly').objectStore(store).get(id));
}

export async function dbGetAll(store) {
  const db = await openDatabase();
  return reqToPromise(tx(db, store, 'readonly').objectStore(store).getAll());
}

export async function dbGetAllByIndex(store, indexName, query) {
  const db = await openDatabase();
  const idx = tx(db, store, 'readonly').objectStore(store).index(indexName);
  return reqToPromise(idx.getAll(query));
}

/* ---------- Version des données (cache de lecture du moteur de calcul) ----------
   Chaque écriture passant par ce fichier fait avancer ce compteur, juste AVANT et juste APRÈS. ledger.js s'en sert pour réutiliser
   une même lecture complète de la base entre plusieurs calculs d'un même affichage (le tableau de bord en lance une dizaine,
   chacun relisait toutes les transactions : ~100 ms l'un avec 5 ans d'historique, donc plusieurs secondes sur un téléphone modeste).
   Un lecteur qui chevauche une écriture voit un compteur différent à la fin et ne garde donc rien de périmé. */
let dataVersion = 0;
export function getDataVersion() { return dataVersion; }
async function writing(fn) {
  dataVersion++;
  try { return await fn(); } finally { dataVersion++; }
}

export async function dbPut(store, value) {
  await checkHelperWrite(store, value, 'put');
  const db = await openDatabase();
  await writing(() => reqToPromise(tx(db, store, 'readwrite').objectStore(store).put(value)));
  return value;
}

/* ---------- Rôle d'accès (propriétaire / aidant) ----------
   Un « aidant » (un proche qui tient le cahier d'un parent) déverrouille l'appli avec son propre code : il voit tout et peut
   AJOUTER des opérations, mais jamais supprimer, vider, restaurer ni importer. Ce garde est ici, au plus bas, pour couvrir
   tous les écrans d'un coup ; l'interface masque en plus ce qui lui est fermé (Paramètres, confirmations de suppression).
   Limite assumée : toutes les données sont locales, donc quelqu'un qui maîtrise les outils de développement du navigateur
   peut le contourner — c'est une protection contre l'accident et l'usage ordinaire, comme le code PIN, pas un coffre-fort.
   Le rôle vaut « propriétaire » tant que rien ne le change : démarrage, tests et tout le code existant restent inchangés. */
let accessRole = 'owner';
export function setAccessRole(role) { accessRole = role === 'helper' ? 'helper' : 'owner'; }
export function getAccessRole() { return accessRole; }
export class HelperRestrictedError extends Error {
  constructor() { super('Action réservée au propriétaire.'); this.name = 'HelperRestrictedError'; }
}
export function assertOwner() { if (accessRole === 'helper') throw new HelperRestrictedError(); }

/** Réglages que l'aidant ne peut pas réécrire : des données du propriétaire rangées dans la table des réglages. */
const HELPER_BLOCKED_SETTINGS = new Set(['groupProjects', 'baseCurrency', 'userProfile']);

/** Règle d'écriture de l'aidant, appliquée à chaque `add`/`put` (dbAdd, dbPut, dbWriteBatch). Il peut CRÉER n'importe quel nouvel
    enregistrement, mais pas ÉCRASER l'existant :
      - transactions : créer, et modifier celles qu'il a lui-même saisies (la marque `enteredBy` est posée à la création et conservée) ;
      - journal d'audit : libre ; réglages : libres sauf ceux listés ci-dessus ;
      - toute autre table : un enregistrement qui existe déjà (portefeuille, dette, budget, objectif, taux…) est réservé au propriétaire.
    C'est ce qui ferme « Annuler la dette », la modification d'un montant, l'archivage, etc., sans écran par écran. Sans effet pour le propriétaire. */
async function checkHelperWrite(store, value, kind) {
  if (accessRole !== 'helper' || !value) return;
  if (store === STORES.TRANSACTIONS) {
    if (kind === 'put') {
      const existing = await dbGet(store, value.id);
      if (existing && existing.enteredBy !== 'helper') throw new HelperRestrictedError();
    }
    value.enteredBy = 'helper'; // nouvelle saisie, ou modification d'une saisie à lui : la marque reste
    return;
  }
  if (store === STORES.AUDIT_LOG) return;
  if (store === STORES.SETTINGS) {
    if (HELPER_BLOCKED_SETTINGS.has(value.key)) throw new HelperRestrictedError();
    return;
  }
  if (kind === 'put') {
    const key = value[STORE_KEY_PATH[store] || 'id'];
    const existing = key !== undefined ? await dbGet(store, key) : null;
    if (existing && !(store === STORES.DEBTS && isSettleOnlyChange(existing, value))) throw new HelperRestrictedError();
  }
}

/** Seule modification d'une dette existante permise à l'aidant : la passer de « active » à « soldée » parce qu'un remboursement
    qu'il vient d'enregistrer a tout couvert (le lot d'écritures de debts.js contient alors ce `put`). Tout autre champ
    modifié (montant, nom, échéance, annulation…) reste refusé. */
function isSettleOnlyChange(before, after) {
  if (before.status !== 'active' || after.status !== 'paid') return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('status');
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) return false;
  return true;
}

export async function dbAdd(store, value) {
  await checkHelperWrite(store, value, 'add'); // marque aussi ce que l'aidant saisit : le propriétaire le retrouve (bilan de visite, audit)
  const db = await openDatabase();
  await writing(() => reqToPromise(tx(db, store, 'readwrite').objectStore(store).add(value)));
  return value;
}

export async function dbDelete(store, id) {
  if (accessRole === 'helper') {
    // Seule exception : l'aidant peut annuler ce QU'IL VIENT de saisir (toast « Annuler »). Rien d'autre.
    const own = store === STORES.TRANSACTIONS && (await dbGet(store, id))?.enteredBy === 'helper';
    if (!own) throw new HelperRestrictedError();
  }
  const db = await openDatabase();
  await writing(() => reqToPromise(tx(db, store, 'readwrite').objectStore(store).delete(id)));
}

export async function dbClear(store) {
  assertOwner();
  const db = await openDatabase();
  await writing(() => reqToPromise(tx(db, store, 'readwrite').objectStore(store).clear()));
}

export async function dbBulkPut(store, values) {
  if (!values || !values.length) return;
  assertOwner(); // écrasement en masse (import CSV, données de démonstration) : réservé au propriétaire
  const db = await openDatabase();
  const t = tx(db, store, 'readwrite');
  const os = t.objectStore(store);
  await writing(async () => {
    values.forEach((v) => os.put(v));
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      // Sans onabort, une transaction abandonnée sans événement d'erreur (quota dépassé) laissait la promesse
      // pendante pour toujours.
      t.onabort = () => reject(t.error || new Error('Transaction abandonnée'));
    });
  });
}

/** Exécute plusieurs écritures (add/put/delete, sur un ou plusieurs stores) dans UNE SEULE
    transaction IndexedDB : soit toutes appliquées, soit aucune. Chaque dbAdd/dbPut/dbDelete
    "isolé" ouvre SA PROPRE transaction — un enchaînement de plusieurs appels séparés pour une même
    opération logique (ex: enregistrer un remboursement = une ligne DEBT_PAYMENTS + une transaction
    de portefeuille + parfois passer la dette à "soldée") peut donc laisser un état partiellement
    écrit si l'onglet/l'appareil meurt exactement entre deux appels (fermeture forcée, coupure de
    courant, l'OS qui tue l'onglet en arrière-plan sur mobile) — improbable par occurrence, mais
    jamais acceptable pour un solde financier. `operations` est un tableau de
    { store, type: 'add'|'put'|'delete', value } (value = l'id pour 'delete'). À utiliser pour tout
    groupe d'écritures qui doivent réussir ou échouer ensemble. */
export async function dbWriteBatch(operations) {
  if (!operations || !operations.length) return;
  if (accessRole === 'helper') {
    if (operations.some((op) => op.type === 'delete')) throw new HelperRestrictedError();
    // Vérifié AVANT toute écriture : le lot est atomique, donc un seul refus annule tout (rien n'est à moitié écrit).
    for (const op of operations) await checkHelperWrite(op.store, op.value, op.type);
  }
  const storeNames = [...new Set(operations.map((op) => op.store))];
  const db = await openDatabase();
  const t = tx(db, storeNames, 'readwrite');
  await writing(async () => {
    for (const op of operations) {
      const os = t.objectStore(op.store);
      if (op.type === 'delete') os.delete(op.value);
      else os[op.type](op.value);
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('Transaction abandonnée'));
    });
  });
}

/* ---------- Journal d'audit ---------- */

/** Copie d'un enregistrement pour le journal, SANS ses fichiers binaires. Une transaction avec photo de justificatif (receiptBlob)
    était recopiée telle quelle dans le journal à chaque création, modification ou suppression : la photo se retrouvait stockée
    2 à 3 fois (mesuré : ~114 Mo utilisés pour ~51 Mo de photos). Le journal garde la trace de l'opération, pas de l'image.
    Renvoie le MÊME objet quand il n'y a rien à retirer. */
function auditSnapshot(record) {
  if (!record || typeof record !== 'object') return record;
  let out = record;
  for (const [key, value] of Object.entries(record)) {
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      if (out === record) out = { ...record };
      out[key] = '[fichier]';
    }
  }
  return out;
}

export async function logAudit({ entityType, entityId, action, before = null, after = null, note = '' }) {
  await dbAdd(STORES.AUDIT_LOG, {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    entityType,
    entityId,
    action,
    before: auditSnapshot(before),
    after: auditSnapshot(after),
    note,
    ...(accessRole === 'helper' ? { actor: 'helper' } : {}), // qui a agi : seulement noté pour l'aidant
  });
}

/** Nombre de lignes du journal au-delà duquel les plus anciennes sont supprimées. Le journal n'a pas de fin : sans plafond, 5 ans
    d'usage ≈ 8 000 lignes recopiant chaque opération, et chaque sauvegarde (JSON, chiffrée, cloud) les embarquait toutes. L'écran
    « Journal d'audit » n'affiche de toute façon que les 150 dernières. */
export const AUDIT_LOG_MAX_ROWS = 3000;
const AUDIT_LOG_PRUNE_SLACK = 300; // on ne nettoie qu'une fois ce surplus atteint, pas à chaque ouverture

const AUDIT_BATCH = 150; // lignes traitées par transaction : courte, pour que l'écriture d'une opération de l'utilisateur ne patiente pas

/** Une courte transaction sur le journal ; `work(store, done)` pose ses requêtes et appelle `done(valeur)` quand il a fini. */
function auditTransaction(db, work) {
  return writing(() => new Promise((resolve, reject) => {
    const t = tx(db, STORES.AUDIT_LOG, 'readwrite');
    let result;
    work(t.objectStore(STORES.AUDIT_LOG), (value) => { result = value; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction abandonnée'));
  }));
}
const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Entretien du journal d'audit, à lancer au repos après le déverrouillage du propriétaire : (1) supprime les plus anciennes lignes
    au-delà du plafond ; (2) une seule fois, retire les photos déjà recopiées dans d'anciennes entrées. Sans effet pour l'aidant.
    Renvoie { compacted, pruned }. */
export async function maintainAuditLog() {
  if (accessRole === 'helper') return { compacted: 0, pruned: 0 };
  const db = await openDatabase();
  // Tout se fait par petits lots, avec une pause entre chacun : avec 5 ans d'historique, une seule grosse transaction bloquait toute
  // écriture dans le journal (donc l'enregistrement d'une opération) pendant plusieurs secondes — mesuré : 3,6 s d'attente.

  // 1. Suppression des plus anciennes lignes au-delà du plafond, d'après l'index d'horodatage.
  const total = await reqToPromise(tx(db, STORES.AUDIT_LOG, 'readonly').objectStore(STORES.AUDIT_LOG).count());
  let pruned = 0;
  if (total > AUDIT_LOG_MAX_ROWS + AUDIT_LOG_PRUNE_SLACK) {
    const excess = total - AUDIT_LOG_MAX_ROWS;
    while (pruned < excess) {
      const wanted = Math.min(AUDIT_BATCH * 2, excess - pruned);
      const removed = await auditTransaction(db, (store, done, fail) => {
        let count = 0;
        const req = store.index('byTimestamp').openKeyCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor || count >= wanted) { done(count); return; }
          store.delete(cursor.primaryKey);
          count++;
          cursor.continue();
        };
        req.onerror = () => fail(req.error);
      });
      if (!removed) break;
      pruned += removed;
      await yieldToUi();
    }
  }

  // 2. Une seule fois : retirer les photos déjà recopiées dans d'anciennes entrées (parcours par identifiant, lot après lot).
  let compacted = 0;
  if (!(await getSetting('auditCompacted', false))) {
    let lastKey = null;
    for (;;) {
      const batch = await auditTransaction(db, (store, done, fail) => {
        let count = 0, changed = 0, lastSeen = null;
        const req = store.openCursor(lastKey === null ? null : IDBKeyRange.lowerBound(lastKey, true));
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { done({ changed, lastSeen, finished: true }); return; }
          lastSeen = cursor.primaryKey;
          const row = cursor.value;
          const before = auditSnapshot(row.before);
          const after = auditSnapshot(row.after);
          if (before !== row.before || after !== row.after) { cursor.update({ ...row, before, after }); changed++; }
          if (++count >= AUDIT_BATCH) { done({ changed, lastSeen, finished: false }); return; }
          cursor.continue();
        };
        req.onerror = () => fail(req.error);
      });
      compacted += batch.changed;
      if (batch.finished || batch.lastSeen === null) break;
      lastKey = batch.lastSeen;
      await yieldToUi();
    }
    await setSetting('auditCompacted', true);
  }
  return { compacted, pruned };
}

/* ---------- Paramètres (clé/valeur) ---------- */
export async function getSetting(key, fallback = null) {
  const row = await dbGet(STORES.SETTINGS, key);
  return row ? row.value : fallback;
}

export async function setSetting(key, value) {
  await dbPut(STORES.SETTINGS, { key, value });
}

/* ---------- Export / Import complet (utilisé par backup.js) ---------- */
/** Clés de STORES.SETTINGS propres à CET appareil, jamais exportées dans une sauvegarde — ni en
    clair, ni même dans la variante "chiffrée" (défense en profondeur : le hash/sel du PIN et les
    identifiants biométriques ne doivent jamais quitter l'appareil, quelle que soit la protection
    autour du fichier). Restaurer une sauvegarde doit toujours redemander un PIN sur l'appareil de
    destination, jamais hériter silencieusement de celui de l'appareil d'origine.
    autoBackupDirHandle est en plus un FileSystemDirectoryHandle (objet natif non sérialisable en
    JSON, comme un Blob) : l'exporter produirait une entrée cassée sans intérêt. */
const DEVICE_LOCAL_SETTING_KEYS = new Set([
  'pinSalt', 'pinHash', 'pinIterations', 'pinLength', 'failedAttempts', 'pinThrottledUntil',
  'biometricCredentialId', 'biometricPublicKeySpki',
  'autoBackupDirHandle', 'autoBackupLastError', // dernière erreur d'écriture dans le dossier (backup.js) : propre à CET appareil
  // Sauvegarde cloud automatique (firebase-sync.js) : le mot de passe de chiffrement ne doit JAMAIS
  // figurer dans la sauvegarde qu'il protège, et l'état (activée, en échec, en pause) est propre à
  // chaque appareil — un fichier de sauvegarde forgé ne doit pas non plus pouvoir l'activer.
  'cloudAutoBackupEnabled', 'cloudAutoBackupPassphrase', 'cloudAutoBackupDirty',
  'cloudAutoBackupFailures', 'cloudAutoBackupLastError', 'cloudAutoBackupBlocked',
  // Rappels planifiés Android (native-reminders.js) : identifiants propres à CET appareil.
  'nativeRemindersEnabled', 'nativeReminderIds',
  // Code « aidant » (auth.js) : même nature que le PIN — jamais exporté, jamais importable depuis un fichier forgé.
  'helperPinHash', 'helperPinSalt', 'helperPinIterations', 'helperPinLength',
  // Journal des codes ratés et date de la dernière visite du propriétaire (auth.js) : propres à CET appareil.
  'pinFailureLog', 'lastUnlockAt',
  // Résultat de la dernière vérification de sauvegarde (backup-verify.js) et SMS en attente de validation (sms-queue.js).
  'backupVerification', 'smsInbox',
  // Entretien du journal d'audit (maintainAuditLog) : « déjà compacté » vaut pour la base de CET appareil, pas pour celle d'une sauvegarde importée.
  'auditCompacted', 'cloudPhotoPruneBlocked',
  // Assistant IA (ai-assistant.js) : clé API personnelle et consentement, propres à CET appareil, jamais exportés ni importables.
  'aiApiKey', 'aiConsent',
]);

export async function exportAllData() {
  const data = { exportedAt: new Date().toISOString(), version: DB_VERSION, stores: {} };
  for (const store of Object.values(STORES)) {
    const rows = await dbGetAll(store);
    data.stores[store] = store === STORES.SETTINGS
      ? rows.filter((r) => !DEVICE_LOCAL_SETTING_KEYS.has(r.key))
      : rows;
  }
  return data;
}

/** Corrige typeof number non finis (NaN/Infinity) sur les champs de premier niveau d'une ligne
    importée — un fichier de sauvegarde n'est pas une entrée fiable (corruption, édition manuelle,
    fichier forgé) ; sans ça, une valeur comme "Infinity" se propagerait telle quelle dans les
    calculs de ledger.js (l'idiome `Number(x) || 0` utilisé ailleurs ne filtre PAS Infinity, qui
    est "truthy" — voir safeNumber() dans utils.js). */
function sanitizeImportedRow(row) {
  if (!row || typeof row !== 'object') return row;
  for (const key of Object.keys(row)) {
    if (typeof row[key] === 'number' && !Number.isFinite(row[key])) row[key] = 0;
  }
  return row;
}

/** Clé primaire attendue par store (voir upgrade()) — sert à valider une ligne importée AVANT toute
    écriture. */
const STORE_KEY_PATH = { [STORES.SETTINGS]: 'key', [STORES.EXCHANGE_RATES]: 'code' };

/** Champs que le code suppose toujours présents et bien typés (tri par date, sommes, devises...).
    Une ligne qui ne les respecte pas fait planter un écran entier (ex: une transaction à date null
    casse le tableau de bord) : un fichier de sauvegarde corrompu ou forgé est donc refusé EN ENTIER
    plutôt que de bloquer l'app après coup. Volontairement minimal : seulement ce dont le code dépend. */
const REQUIRED_FIELDS = {
  [STORES.TRANSACTIONS]: { date: 'date', amount: 'number', walletId: 'string', type: 'string' },
  [STORES.WALLETS]: { name: 'string', currency: 'string' },
  [STORES.INVESTMENTS]: { name: 'string', currency: 'string' },
  [STORES.INVESTMENT_ENTRIES]: { date: 'date', amount: 'number', investmentId: 'string', type: 'string' },
  [STORES.DEBTS]: { principal: 'number', currency: 'string', personName: 'string' },
  [STORES.DEBT_PAYMENTS]: { date: 'date', amount: 'number', debtId: 'string' },
  [STORES.BUDGETS]: { limit: 'number' },
  [STORES.SAVINGS_GOALS]: { name: 'string' },
  [STORES.CATEGORIES]: { name: 'string' },
  [STORES.TONTINES]: { name: 'string', amount: 'number', currency: 'string' },
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const UNSAFE_ID_CHARS = /[<>"'`&\\\s]/;

function rowMatchesRequiredFields(store, row) {
  const rules = REQUIRED_FIELDS[store];
  if (!rules) return true;
  return Object.entries(rules).every(([field, kind]) => {
    const v = row[field];
    if (kind === 'date') return typeof v === 'string' && ISO_DATE.test(v);
    return typeof v === kind && (kind !== 'number' || Number.isFinite(v));
  });
}

/** Importe une sauvegarde. ATOMIQUE : tout est validé d'abord, puis vidage + écriture de TOUS les
    stores dans une seule transaction IndexedDB — soit tout est importé, soit rien ne change. Avant,
    chaque store était vidé puis rempli séparément : une ligne sans identifiant (fichier corrompu ou
    forgé) faisait échouer l'import en plein milieu, après avoir déjà effacé des stores entiers, et
    laissait l'appareil avec des données à moitié anciennes, à moitié nouvelles. */
export async function importAllData(data, { merge = false, dryRun = false } = {}) {
  // `dryRun` : valide tout le fichier (mêmes règles que l'import réel) sans rien écrire — sert à VÉRIFIER qu'une sauvegarde
  // est restaurable (backup-verify.js). Renvoie le nombre de lignes par store.
  if (!dryRun) assertOwner();
  if (!data || typeof data !== 'object' || !data.stores || typeof data.stores !== 'object') throw new Error('Fichier de sauvegarde invalide.');
  const plan = [];
  for (const store of Object.values(STORES)) {
    let rows = data.stores[store];
    if (!rows) continue;
    if (!Array.isArray(rows)) throw new Error('Fichier de sauvegarde invalide.');
    // Symétrique à exportAllData() : un fichier de sauvegarde (potentiellement forgé) ne doit
    // JAMAIS pouvoir poser/écraser le PIN ou les identifiants biométriques de CET appareil — la
    // seule voie légitime pour ça reste les flux internes d'auth.js (setupPin, registerBiometric).
    if (store === STORES.SETTINGS) rows = rows.filter((r) => !DEVICE_LOCAL_SETTING_KEYS.has(r?.key));
    const keyPath = STORE_KEY_PATH[store] || 'id';
    for (const row of rows) {
      const key = row && typeof row === 'object' && !Array.isArray(row) ? row[keyPath] : undefined;
      if ((typeof key !== 'string' && typeof key !== 'number') || key === '') throw new Error('Fichier de sauvegarde invalide.');
      // Les identifiants sont écrits tels quels dans des attributs HTML (data-…-id="…") : un fichier forgé ne doit pas
      // pouvoir y glisser de quoi en sortir. Un vrai identifiant (UUID…) ne contient jamais ces caractères.
      if (store !== STORES.SETTINGS && typeof key === 'string' && UNSAFE_ID_CHARS.test(key)) throw new Error('Fichier de sauvegarde invalide.');
      // Même contrôle sur les champs qui référencent un autre enregistrement (categoryId, walletId, walletIds…) :
      // ils finissent eux aussi dans des attributs HTML (data-…, value des <option>).
      if (store !== STORES.SETTINGS) {
        for (const [field, v] of Object.entries(row)) {
          if (!/Ids?$/.test(field)) continue;
          const refs = Array.isArray(v) ? v : [v];
          if (refs.some((r) => typeof r === 'string' && UNSAFE_ID_CHARS.test(r))) throw new Error('Fichier de sauvegarde invalide.');
        }
      }
    }
    const cleaned = rows.map(sanitizeImportedRow);
    if (!cleaned.every((row) => rowMatchesRequiredFields(store, row))) throw new Error('Fichier de sauvegarde invalide.');
    plan.push({ store, rows: cleaned });
  }
  if (dryRun) return Object.fromEntries(plan.map((p) => [p.store, p.rows.length]));
  if (!plan.length) return;
  // Mode « fusionner » : les projets collectifs (un seul réglage contenant toute la liste) sont réunis par identifiant au
  // lieu d'être remplacés en bloc par ceux de la sauvegarde — sinon importer une sauvegarde effaçait les projets locaux.
  if (merge) {
    const settingsPlan = plan.find((p) => p.store === STORES.SETTINGS);
    if (settingsPlan && settingsPlan.rows.some((r) => r.key === 'groupProjects')) {
      const localProjects = (await dbGetAll(STORES.SETTINGS)).find((r) => r.key === 'groupProjects')?.value;
      settingsPlan.rows = settingsPlan.rows.map((r) => (r.key === 'groupProjects' ? { ...r, value: mergeProjectLists(localProjects, r.value) } : r));
    }
  }
  // Remplacement complet : les réglages propres à CET appareil (PIN, biométrie, mot de passe de la
  // sauvegarde cloud automatique, rappels Android — voir DEVICE_LOCAL_SETTING_KEYS) ne viennent jamais
  // d'une sauvegarde, donc ne doivent pas être effacés avec le reste : sans ça, restaurer une sauvegarde
  // sur son propre téléphone supprimait son PIN et désactivait en silence la sauvegarde automatique.
  // (Sur un appareil neuf il n'y a rien à préserver : le PIN reste à créer, comme voulu.)
  const preservedSettings = !merge && plan.some((p) => p.store === STORES.SETTINGS)
    ? (await dbGetAll(STORES.SETTINGS)).filter((r) => DEVICE_LOCAL_SETTING_KEYS.has(r.key))
    : [];
  const db = await openDatabase();
  const t = db.transaction(plan.map((p) => p.store), 'readwrite');
  const done = new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Import annulé.'));
  });
  await writing(async () => {
    try {
      for (const { store, rows } of plan) {
        const os = t.objectStore(store);
        if (!merge) os.clear();
        rows.forEach((row) => os.put(row));
        if (store === STORES.SETTINGS) preservedSettings.forEach((row) => os.put(row));
      }
    } catch (err) {
      try { t.abort(); } catch { /* déjà terminée */ }
      done.catch(() => {});
      throw err;
    }
    await done;
  });
}

export async function wipeAllData() {
  for (const store of Object.values(STORES)) {
    await dbClear(store);
  }
}

/** Comme wipeAllData(), mais préserve les réglages propres à CET appareil (PIN, identifiants
    biométriques, dossier de sauvegarde auto — voir DEVICE_LOCAL_SETTING_KEYS) au lieu de tout
    effacer sans distinction. Pour tout effacement déclenché par l'app elle-même sans intention de
    "réinitialisation complète de l'appareil" (ex: charger/effacer les données de démonstration,
    voir demo-data.js) — contrairement à wipeAllData(), qui reste le bon outil pour un vrai "Tout
    supprimer" explicite côté utilisateur (settings.js), où détruire aussi le PIN est acceptable
    puisque l'utilisateur en a été prévenu. Sans cette distinction, wipeAllData() effacerait le PIN
    qu'un utilisateur vient tout juste de créer s'il est appelé pendant l'onboarding (juste après la
    création du PIN) — le laissant sans code valide pour déverrouiller après le prochain
    verrouillage, sans même un message d'erreur avant un rechargement complet de page. */
export async function wipeUserData() {
  const settingsRows = await dbGetAll(STORES.SETTINGS);
  const preserved = settingsRows.filter((r) => DEVICE_LOCAL_SETTING_KEYS.has(r.key));
  await wipeAllData();
  for (const row of preserved) await dbPut(STORES.SETTINGS, row);
}
