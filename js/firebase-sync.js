/* ==========================================================================
   GeoFinance System — Sauvegarde cloud optionnelle (Firebase Auth + Firestore)
   Connexion Google + sauvegarde/restauration À LA DEMANDE d'un blob chiffré
   AES-GCM (buildEncryptedPayload/decryptPayload, backup.js — même chiffrement
   que l'export chiffré local, déjà testé). Volontairement PAS de synchro
   continue/bidirectionnelle : pas de moteur de résolution de conflits à
   construire, juste "envoyer la dernière sauvegarde" / "récupérer la
   dernière sauvegarde", au choix de l'utilisateur.

   Le SDK Firebase (modular, CDN ESM — pas de build/npm, cohérent avec le
   reste du projet) n'est chargé qu'au premier besoin réel (connexion, ou
   ouverture des Paramètres si une connexion précédente est connue) — jamais
   sur le chemin par défaut de l'app. Même principe que le chargement
   paresseux de Tesseract dans ocr.js.

   Le blob chiffré est découpé en morceaux (backups/{uid}/chunks/{i}, voir
   CHUNK_SIZE) plutôt que stocké dans un seul document backups/{uid} : Firestore
   refuse tout document de plus de ~1 Mo, et l'historique de transactions +
   les justificatifs photo en base64 dépassent vite cette limite en usage réel.
   ========================================================================== */

import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';
import { buildEncryptedPayload, decryptPayload, deserializeReceiptsForImport, markBackupDone } from './backup.js';
import { importAllData, getSetting, setSetting } from './db.js';
import { openModal, showToast, confirmDialog, formatDate } from './utils.js';
import { notifyDataChanged } from './state.js';
import { isStandalone, isIOS, isAndroid } from './install-prompt.js';

/* signInWithPopup est notoirement peu fiable sur mobile, et carrément non fonctionnel dans une
   PWA installée en plein écran (display-mode: standalone) : il n'y a pas de fenêtre de navigateur
   dans laquelle ouvrir la popup, donc le clic "Se connecter" ne fait rien de visible. On préfère
   signInWithRedirect (navigation de page complète, retour automatique après connexion) sur mobile/
   standalone d'emblée, et en repli si la popup échoue quand même ailleurs. */
function shouldPreferRedirect() {
  return isStandalone() || isIOS() || isAndroid();
}
const POPUP_FALLBACK_CODES = new Set([
  'auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request',
]);

// À ajuster si une version plus récente est disponible au moment du déploiement
// (voir firebase.google.com/docs/web/setup) — sans build, la version est figée ici.
const SDK_VERSION = '10.14.1';

let sdkPromise = null;
let firebaseAuth = null;
let firebaseDb = null;

/** Charge le SDK Firebase et initialise l'app — mémoïsé, un seul chargement réseau même si
    appelé plusieurs fois. Renvoie les sous-modules auth/firestore (les fonctions dont on a
    besoin, ex. signInWithPopup, doc, setDoc — l'API modulaire de Firebase les expose ainsi). */
function ensureFirebase() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    const [{ initializeApp }, authMod, firestoreMod] = await Promise.all([
      import(/* @vite-ignore */ `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
      import(/* @vite-ignore */ `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
      import(/* @vite-ignore */ `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`),
    ]);
    const app = initializeApp(firebaseConfig);
    firebaseAuth = authMod.getAuth(app);
    firebaseDb = firestoreMod.getFirestore(app);
    return { authMod, firestoreMod };
  })();
  return sdkPromise;
}

/** L'état de connexion de Firebase Auth se restaure de façon ASYNCHRONE après initialisation
    (lecture d'une session persistée) — lire authInstance.currentUser immédiatement après getAuth()
    peut donc renvoyer null même pour un utilisateur déjà connecté. onAuthStateChanged() est le
    seul moyen fiable de savoir l'état réel, sa première notification arrivant une fois la
    restauration terminée (avec l'utilisateur, ou null si vraiment déconnecté). */
function waitForAuthReady(authMod) {
  return new Promise((resolve) => {
    const unsubscribe = authMod.onAuthStateChanged(firebaseAuth, (user) => { unsubscribe(); resolve(user); });
  });
}

/** Renvoie l'utilisateur connecté (flux popup, résolu tout de suite) ou `null` (flux redirection :
    la page navigue vers Google puis revient sur l'app — l'appelant n'a rien à faire d'autre,
    handlePendingRedirect() complète la connexion au rechargement, voir renderCloudBackupSection). */
export async function signInWithGoogle() {
  const { authMod } = await ensureFirebase();
  const provider = new authMod.GoogleAuthProvider();
  if (shouldPreferRedirect()) {
    await setSetting('cloudRedirectPending', true);
    await authMod.signInWithRedirect(firebaseAuth, provider);
    return null;
  }
  try {
    const result = await authMod.signInWithPopup(firebaseAuth, provider);
    return result.user;
  } catch (err) {
    if (!POPUP_FALLBACK_CODES.has(err.code)) throw err;
    await setSetting('cloudRedirectPending', true);
    await authMod.signInWithRedirect(firebaseAuth, provider);
    return null;
  }
}

/** À appeler après ensureFirebase() si un cloudRedirectPending est en cours : complète la
    connexion démarrée par signInWithRedirect() avant que la page ne navigue vers Google.
    Sans effet (retourne vite) s'il n'y a en fait aucune redirection en attente. */
async function handlePendingRedirect(authMod) {
  if (!(await getSetting('cloudRedirectPending', false))) return;
  try {
    const result = await authMod.getRedirectResult(firebaseAuth);
    if (result?.user) await setSetting('cloudBackupWasSignedIn', true);
  } finally {
    await setSetting('cloudRedirectPending', false);
  }
}

export async function signOutGoogle() {
  const { authMod } = await ensureFirebase();
  await authMod.signOut(firebaseAuth);
}

// Firestore refuse un document de plus de ~1 048 487 octets. Avec l'historique de transactions
// et les justificatifs photo (convertis en data URL base64 dans le payload — voir
// serializeReceiptsForExport() dans backup.js), la sauvegarde complète dépasse vite cette limite
// pour un usage réel. On découpe donc le JSON chiffré en morceaux stockés dans une sous-collection
// plutôt que dans un seul champ — marge confortable sous la limite exacte.
const CHUNK_SIZE = 900000;

export async function pushBackupToCloud(passphrase) {
  const { firestoreMod } = await ensureFirebase();
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Non connecté.');
  const payloadStr = JSON.stringify(await buildEncryptedPayload(passphrase));
  const chunks = [];
  for (let i = 0; i < payloadStr.length; i += CHUNK_SIZE) chunks.push(payloadStr.slice(i, i + CHUNK_SIZE));

  const chunksRef = firestoreMod.collection(firebaseDb, 'backups', user.uid, 'chunks');
  const existing = await firestoreMod.getDocs(chunksRef);
  const batch = firestoreMod.writeBatch(firebaseDb);
  // Supprime d'abord les anciens morceaux : leur nombre peut varier d'une sauvegarde à l'autre
  // (données en plus ou en moins) — sans ça, d'anciens morceaux en trop resteraient et
  // corrompraient la sauvegarde suivante à la lecture (concaténation avec des restes obsolètes).
  existing.forEach((d) => batch.delete(d.ref));
  chunks.forEach((chunk, i) => batch.set(firestoreMod.doc(chunksRef, String(i)), { data: chunk }));
  batch.set(firestoreMod.doc(firebaseDb, 'backups', user.uid), { chunkCount: chunks.length, updatedAt: firestoreMod.serverTimestamp() });
  await batch.commit();

  await markBackupDone();
  await setSetting('lastCloudBackupAt', new Date().toISOString());
}

export async function pullBackupFromCloud(passphrase, { merge = false } = {}) {
  const { firestoreMod } = await ensureFirebase();
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Non connecté.');
  const snap = await firestoreMod.getDoc(firestoreMod.doc(firebaseDb, 'backups', user.uid));
  if (!snap.exists()) throw new Error('Aucune sauvegarde cloud trouvée pour ce compte.');
  const { chunkCount } = snap.data();
  const chunksRef = firestoreMod.collection(firebaseDb, 'backups', user.uid, 'chunks');
  const chunkDocs = await Promise.all(
    Array.from({ length: chunkCount }, (_, i) => firestoreMod.getDoc(firestoreMod.doc(chunksRef, String(i))))
  );
  const payloadStr = chunkDocs.map((d) => d.data().data).join('');
  const payload = JSON.parse(payloadStr);
  const data = await decryptPayload(payload, passphrase);
  await deserializeReceiptsForImport(data);
  await importAllData(data, { merge });
  notifyDataChanged('all');
}

/* ---------- UI (Paramètres) ---------- */
function promptPassphrase(title) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <form id="cloud-passphrase-form">
        <div class="form-row"><label>Mot de passe de chiffrement</label><input type="password" name="passphrase" required minlength="6" autofocus></div>
        <button type="submit" class="btn btn-primary btn-block">Continuer</button>
      </form>`, { title, onClose: () => resolve(null) });
    modal.el.querySelector('#cloud-passphrase-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = new FormData(e.target).get('passphrase');
      // resolve() AVANT modal.close() : close() déclenche onClose() (=> resolve(null))
      // synchroniquement — appeler resolve(p) après serait un no-op (une promesse déjà
      // résolue ignore les résolutions suivantes), le mot de passe réel serait perdu.
      resolve(p);
      modal.close();
    });
  });
}

export async function renderCloudBackupSection(container) {
  if (!isFirebaseConfigured) {
    container.innerHTML = `
      <div class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><h3>Sauvegarde cloud (optionnelle)</h3></div>
        <p class="empty-state" style="padding:12px 0;">Fonctionnalité pas encore configurée par l'auteur de l'app.</p>
      </div>`;
    return;
  }

  const lastCloudBackupAt = await getSetting('lastCloudBackupAt');
  let user = null;
  // Ne charge le SDK au chargement des Paramètres que si une connexion précédente est connue, OU
  // qu'un retour de redirection Google est en attente (flux mobile/PWA installée, voir
  // shouldPreferRedirect()) — sinon un utilisateur qui n'a jamais touché à cette fonctionnalité
  // ne déclenche jamais le chargement réseau du SDK Firebase rien qu'en ouvrant ses Paramètres.
  if (await getSetting('cloudBackupWasSignedIn', false) || await getSetting('cloudRedirectPending', false)) {
    try {
      const { authMod } = await ensureFirebase();
      await handlePendingRedirect(authMod);
      user = await waitForAuthReady(authMod);
      if (!user) await setSetting('cloudBackupWasSignedIn', false);
    } catch {
      // Hors-ligne ou service indisponible : reste affiché comme déconnecté, pas d'erreur bloquante.
    }
  }

  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Sauvegarde cloud (optionnelle)</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;">Sauvegarde chiffrée sur votre compte Google, pour la récupérer après une réinstallation. Le mot de passe de chiffrement n'est jamais transmis — sans lui, personne (y compris Google) ne peut lire vos données.</p>
      ${user ? `
        <div class="stat-row"><span class="stat-row-label">Connecté</span><span>${user.email || user.displayName || ''}</span></div>
        <div class="stat-row" style="margin-top:6px;"><span class="stat-row-label">Dernière sauvegarde cloud</span><span>${lastCloudBackupAt ? formatDate(lastCloudBackupAt) : 'jamais'}</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;">
          <button type="button" class="btn btn-primary" id="cloud-push-btn">Sauvegarder maintenant</button>
          <button type="button" class="btn btn-ghost" id="cloud-pull-btn">Restaurer depuis le cloud</button>
          <button type="button" class="btn btn-ghost" id="cloud-signout-btn">Se déconnecter</button>
        </div>` : `
        <button type="button" class="btn btn-primary" id="cloud-signin-btn">Se connecter avec Google</button>`}
    </div>`;

  container.querySelector('#cloud-signin-btn')?.addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Connexion…';
    try {
      const user = await signInWithGoogle();
      if (!user) return; // flux redirection : la page va naviguer vers Google, rien d'autre à faire ici
      await setSetting('cloudBackupWasSignedIn', true);
      showToast('Connecté.');
      await renderCloudBackupSection(container);
    } catch (err) {
      showToast('Erreur : ' + (err.message || 'connexion impossible.'));
      btn.disabled = false;
      btn.textContent = 'Se connecter avec Google';
    }
  });

  container.querySelector('#cloud-signout-btn')?.addEventListener('click', async () => {
    await signOutGoogle();
    await setSetting('cloudBackupWasSignedIn', false);
    showToast('Déconnecté.');
    await renderCloudBackupSection(container);
  });

  container.querySelector('#cloud-push-btn')?.addEventListener('click', async () => {
    const p = await promptPassphrase('Chiffrer la sauvegarde cloud');
    if (!p) return;
    try {
      await pushBackupToCloud(p);
      showToast('Sauvegarde envoyée dans le cloud.');
      await renderCloudBackupSection(container);
    } catch (err) {
      showToast('Erreur : ' + (err.message || 'envoi impossible.'));
    }
  });

  container.querySelector('#cloud-pull-btn')?.addEventListener('click', async () => {
    const p = await promptPassphrase('Mot de passe de la sauvegarde cloud');
    if (!p) return;
    const merge = await confirmDialog('Fusionner avec les données existantes ? "Annuler" remplacera entièrement les données actuelles par celles du cloud.', { confirmText: 'Fusionner', cancelText: 'Remplacer tout' });
    try {
      await pullBackupFromCloud(p, { merge });
      showToast('Données restaurées depuis le cloud.');
    } catch (err) {
      showToast('Erreur : ' + (err.message || 'restauration impossible.'));
    }
  });
}
