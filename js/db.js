/* ==========================================================================
   GeoFinance System — Couche IndexedDB
   Toutes les données de l'application vivent exclusivement dans IndexedDB.
   Les identifiants sont des UUID applicatifs (pas d'autoIncrement) afin que
   l'import/export JSON puisse fusionner ou restaurer sans collision.
   ========================================================================== */

export const DB_NAME = 'geofinance-db';
export const DB_VERSION = 4;

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
};

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

export async function dbPut(store, value) {
  const db = await openDatabase();
  await reqToPromise(tx(db, store, 'readwrite').objectStore(store).put(value));
  return value;
}

export async function dbAdd(store, value) {
  const db = await openDatabase();
  await reqToPromise(tx(db, store, 'readwrite').objectStore(store).add(value));
  return value;
}

export async function dbDelete(store, id) {
  const db = await openDatabase();
  await reqToPromise(tx(db, store, 'readwrite').objectStore(store).delete(id));
}

export async function dbClear(store) {
  const db = await openDatabase();
  await reqToPromise(tx(db, store, 'readwrite').objectStore(store).clear());
}

export async function dbBulkPut(store, values) {
  if (!values || !values.length) return;
  const db = await openDatabase();
  const t = tx(db, store, 'readwrite');
  const os = t.objectStore(store);
  values.forEach((v) => os.put(v));
  await new Promise((resolve, reject) => {
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/* ---------- Journal d'audit ---------- */
export async function logAudit({ entityType, entityId, action, before = null, after = null, note = '' }) {
  await dbAdd(STORES.AUDIT_LOG, {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    entityType,
    entityId,
    action,
    before,
    after,
    note,
  });
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
export async function exportAllData() {
  const data = { exportedAt: new Date().toISOString(), version: DB_VERSION, stores: {} };
  for (const store of Object.values(STORES)) {
    data.stores[store] = await dbGetAll(store);
  }
  return data;
}

export async function importAllData(data, { merge = false } = {}) {
  if (!data || !data.stores) throw new Error('Fichier de sauvegarde invalide.');
  for (const store of Object.values(STORES)) {
    const rows = data.stores[store];
    if (!rows) continue;
    if (!merge) await dbClear(store);
    await dbBulkPut(store, rows);
  }
}

export async function wipeAllData() {
  for (const store of Object.values(STORES)) {
    await dbClear(store);
  }
}
