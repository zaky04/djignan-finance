/* ==========================================================================
   GeoFinance System — Synchronisation Firebase Firestore
   Stratégie : write-through silencieux (IndexedDB d'abord, Firestore en
   arrière-plan) + pull complet au (re)login.
   L'app fonctionne à 100% hors-ligne même si Firebase est inaccessible.
   ========================================================================== */

import { FIREBASE_CONFIG } from './firebase-config.js';
import { exportAllData, importAllData, getSetting, setSetting } from './db.js';
import { showToast } from './utils.js';

/* ---------- État interne ---------- */
let _app = null;
let _auth = null;
let _db = null;
let _currentUser = null;
let _syncEnabled = false;
let _offlineQueue = []; // opérations en attente si hors-ligne

/* ---------- Stores à ne PAS synchroniser sur Firestore
   (données d'appareil uniquement, ou trop volumineuses) ---------- */
const STORES_EXCLUDED_FROM_SYNC = new Set([
  'auditLog',        // journal local uniquement, peut être volumineux
  'exchangeRates',   // données publiques, re-téléchargées à chaque session
  'exchangeRateHistory',
]);

/* ---------- Indicateur visuel de statut sync dans l'UI ---------- */
function setSyncStatus(status) {
  // status : 'idle' | 'syncing' | 'error' | 'offline' | 'disabled'
  const indicator = document.getElementById('sync-status-indicator');
  if (!indicator) return;
  const icons = {
    idle:     '☁️',
    syncing:  '🔄',
    error:    '⚠️',
    offline:  '📴',
    disabled: '',
  };
  const labels = {
    idle:     'Sauvegarde cloud active',
    syncing:  'Synchronisation en cours…',
    error:    'Erreur de synchronisation',
    offline:  'Hors-ligne — sync en attente',
    disabled: '',
  };
  indicator.title = labels[status] || '';
  indicator.textContent = icons[status] || '';
  indicator.dataset.status = status;
  indicator.hidden = status === 'disabled';
}

/* ---------- Initialisation du SDK Firebase (chargé dynamiquement) ---------- */
async function loadFirebaseSDK() {
  if (_app) return true;
  try {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } =
      await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    const { getFirestore, doc, setDoc, deleteDoc, collection, getDocs, writeBatch } =
      await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');

    _app = initializeApp(FIREBASE_CONFIG);
    _auth = { instance: getAuth(_app), GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged };
    _db = { instance: getFirestore(_app), doc, setDoc, deleteDoc, collection, getDocs, writeBatch };
    return true;
  } catch (err) {
    console.warn('[Firebase] Impossible de charger le SDK :', err);
    return false;
  }
}

/* ---------- Connexion avec Google ---------- */
export async function signInWithGoogle() {
  const loaded = await loadFirebaseSDK();
  if (!loaded) throw new Error('SDK Firebase indisponible. Vérifiez la connexion réseau.');

  const provider = new _auth.GoogleAuthProvider();
  try {
    const result = await _auth.signInWithPopup(_auth.instance, provider);
    return result.user;
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return null;
    throw err;
  }
}

/* ---------- Déconnexion ---------- */
export async function signOutFromFirebase() {
  if (!_auth) return;
  await _auth.signOut(_auth.instance);
  _currentUser = null;
  _syncEnabled = false;
  setSyncStatus('disabled');
  await setSetting('firebaseUid', null);
  await setSetting('firebaseEmail', null);
  await setSetting('firebaseDisplayName', null);
  await setSetting('lastCloudSync', null);
}

/* ---------- Utilisateur courant ---------- */
export function getCurrentFirebaseUser() {
  return _currentUser;
}

export async function getStoredFirebaseSession() {
  const uid = await getSetting('firebaseUid', null);
  if (!uid) return null;
  return {
    uid,
    email: await getSetting('firebaseEmail', null),
    displayName: await getSetting('firebaseDisplayName', null),
  };
}

/* ---------- Démarrage de l'écoute d'état auth ---------- */
export async function initFirebaseSync(onUserChange) {
  const loaded = await loadFirebaseSDK();
  if (!loaded) {
    setSyncStatus('disabled');
    return;
  }

  _auth.onAuthStateChanged(_auth.instance, async (user) => {
    _currentUser = user;
    if (user) {
      _syncEnabled = true;
      await setSetting('firebaseUid', user.uid);
      await setSetting('firebaseEmail', user.email || '');
      await setSetting('firebaseDisplayName', user.displayName || '');
      setSyncStatus('idle');
      _flushOfflineQueue();
    } else {
      _syncEnabled = false;
      setSyncStatus('disabled');
    }
    onUserChange?.(user);
  });
}

/* ---------- Écriture d'un enregistrement vers Firestore ---------- */
export async function syncRecordToCloud(storeName, record) {
  if (!_syncEnabled || !_currentUser || STORES_EXCLUDED_FROM_SYNC.has(storeName)) return;
  if (!record?.id) return;

  const operation = { type: 'put', storeName, record };

  if (!navigator.onLine) {
    _offlineQueue.push(operation);
    setSyncStatus('offline');
    return;
  }

  try {
    setSyncStatus('syncing');
    const { doc: docFn, setDoc } = _db;
    const docRef = docFn(_db.instance, 'users', _currentUser.uid, storeName, record.id);
    // Sérialiser les Blob (justificatifs photo) en base64 si présents
    const data = await _serializeForFirestore(record);
    await setDoc(docRef, data, { merge: true });
    await setSetting('lastCloudSync', new Date().toISOString());
    setSyncStatus('idle');
  } catch (err) {
    console.warn(`[Firebase] Erreur sync put ${storeName}/${record.id} :`, err);
    setSyncStatus('error');
    _offlineQueue.push(operation);
  }
}

/* ---------- Suppression d'un enregistrement de Firestore ---------- */
export async function deleteRecordFromCloud(storeName, id) {
  if (!_syncEnabled || !_currentUser || STORES_EXCLUDED_FROM_SYNC.has(storeName)) return;
  if (!id) return;

  const operation = { type: 'delete', storeName, id };

  if (!navigator.onLine) {
    _offlineQueue.push(operation);
    setSyncStatus('offline');
    return;
  }

  try {
    setSyncStatus('syncing');
    const { doc: docFn, deleteDoc } = _db;
    const docRef = docFn(_db.instance, 'users', _currentUser.uid, storeName, id);
    await deleteDoc(docRef);
    await setSetting('lastCloudSync', new Date().toISOString());
    setSyncStatus('idle');
  } catch (err) {
    console.warn(`[Firebase] Erreur sync delete ${storeName}/${id} :`, err);
    setSyncStatus('error');
    _offlineQueue.push(operation);
  }
}

/* ---------- Pull complet depuis Firestore → IndexedDB ---------- */
export async function pullFromCloud() {
  if (!_syncEnabled || !_currentUser) return { success: false, reason: 'Non connecté' };
  if (!navigator.onLine) return { success: false, reason: 'Hors-ligne' };

  try {
    setSyncStatus('syncing');
    const { collection, getDocs, doc: docFn } = _db;
    const stores = {};

    // Lister tous les sous-stores de l'utilisateur
    const STORES_TO_PULL = [
      'wallets','transactions','categories','budgets','recurring',
      'savingsGoals','investments','investmentEntries','debts',
      'debtPayments','settings','participants','sharedExpenses',
      'categorizationRules','keptAccounts','keptAccountEntries',
    ];

    for (const storeName of STORES_TO_PULL) {
      const colRef = collection(_db.instance, 'users', _currentUser.uid, storeName);
      const snapshot = await getDocs(colRef);
      stores[storeName] = snapshot.docs.map((d) => _deserializeFromFirestore(d.data()));
    }

    // Merge dans IndexedDB (ne touche pas aux stores exclus)
    await importAllData({ stores }, { merge: true });
    await setSetting('lastCloudSync', new Date().toISOString());
    setSyncStatus('idle');
    return { success: true };
  } catch (err) {
    console.warn('[Firebase] Erreur pull depuis cloud :', err);
    setSyncStatus('error');
    return { success: false, reason: err.message };
  }
}

/* ---------- Push complet IndexedDB → Firestore (migration initiale) ---------- */
export async function pushAllToCloud() {
  if (!_syncEnabled || !_currentUser) return { success: false, reason: 'Non connecté' };
  if (!navigator.onLine) return { success: false, reason: 'Hors-ligne' };

  try {
    setSyncStatus('syncing');
    const allData = await exportAllData();
    const { writeBatch, doc: docFn } = _db;

    for (const [storeName, rows] of Object.entries(allData.stores)) {
      if (STORES_EXCLUDED_FROM_SYNC.has(storeName) || !rows?.length) continue;

      // Firestore writeBatch est limité à 500 opérations
      const chunks = _chunk(rows, 499);
      for (const chunk of chunks) {
        const batch = writeBatch(_db.instance);
        for (const record of chunk) {
          if (!record?.id) continue;
          const data = await _serializeForFirestore(record);
          const docRef = docFn(_db.instance, 'users', _currentUser.uid, storeName, record.id);
          batch.set(docRef, data, { merge: true });
        }
        await batch.commit();
      }
    }

    await setSetting('lastCloudSync', new Date().toISOString());
    setSyncStatus('idle');
    return { success: true };
  } catch (err) {
    console.warn('[Firebase] Erreur push vers cloud :', err);
    setSyncStatus('error');
    return { success: false, reason: err.message };
  }
}

/* ---------- Envoi de la queue hors-ligne à la reconnexion ---------- */
async function _flushOfflineQueue() {
  if (!_offlineQueue.length || !navigator.onLine || !_syncEnabled) return;
  const queue = [..._offlineQueue];
  _offlineQueue = [];

  for (const op of queue) {
    try {
      if (op.type === 'put') {
        await syncRecordToCloud(op.storeName, op.record);
      } else if (op.type === 'delete') {
        await deleteRecordFromCloud(op.storeName, op.id);
      }
    } catch (err) {
      console.warn('[Firebase] Erreur flush queue :', err);
    }
  }
}

window.addEventListener('online', _flushOfflineQueue);

/* ---------- Sérialisation Firestore (Blob → base64 data URL) ---------- */
async function _serializeForFirestore(record) {
  const data = { ...record };
  if (data.receiptBlob instanceof Blob) {
    data.receiptDataUrl = await _blobToDataUrl(data.receiptBlob);
    delete data.receiptBlob;
  }
  // Firestore ne tolère pas undefined → remplacer par null
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) data[key] = null;
  }
  return data;
}

function _deserializeFromFirestore(data) {
  const record = { ...data };
  if (record.receiptDataUrl) {
    // On garde receiptDataUrl tel quel, la logique de db.js le convertit en Blob à l'import
    // (même comportement que backup.js → importAllData → deserializeReceiptsForImport)
  }
  return record;
}

async function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function _chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}
