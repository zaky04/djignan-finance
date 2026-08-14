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
   ========================================================================== */

import { firebaseConfig, isFirebaseConfigured } from './firebase-config.js';
import { buildEncryptedPayload, decryptPayload, deserializeReceiptsForImport, markBackupDone } from './backup.js';
import { importAllData, getSetting, setSetting } from './db.js';
import { openModal, showToast, confirmDialog, formatDate } from './utils.js';
import { notifyDataChanged } from './state.js';

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

export async function signInWithGoogle() {
  const { authMod } = await ensureFirebase();
  const provider = new authMod.GoogleAuthProvider();
  const result = await authMod.signInWithPopup(firebaseAuth, provider);
  return result.user;
}

export async function signOutGoogle() {
  const { authMod } = await ensureFirebase();
  await authMod.signOut(firebaseAuth);
}

export async function pushBackupToCloud(passphrase) {
  const { firestoreMod } = await ensureFirebase();
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Non connecté.');
  const payload = await buildEncryptedPayload(passphrase);
  await firestoreMod.setDoc(firestoreMod.doc(firebaseDb, 'backups', user.uid), {
    payload: JSON.stringify(payload),
    updatedAt: firestoreMod.serverTimestamp(),
  });
  await markBackupDone();
  await setSetting('lastCloudBackupAt', new Date().toISOString());
}

export async function pullBackupFromCloud(passphrase, { merge = false } = {}) {
  const { firestoreMod } = await ensureFirebase();
  const user = firebaseAuth.currentUser;
  if (!user) throw new Error('Non connecté.');
  const snap = await firestoreMod.getDoc(firestoreMod.doc(firebaseDb, 'backups', user.uid));
  if (!snap.exists()) throw new Error('Aucune sauvegarde cloud trouvée pour ce compte.');
  const payload = JSON.parse(snap.data().payload);
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
      modal.close();
      resolve(p);
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
  // Ne charge le SDK au chargement des Paramètres que si une connexion précédente est connue —
  // sinon un utilisateur qui n'a jamais touché à cette fonctionnalité ne déclenche jamais le
  // chargement réseau du SDK Firebase rien qu'en ouvrant ses Paramètres.
  if (await getSetting('cloudBackupWasSignedIn', false)) {
    try {
      const { authMod } = await ensureFirebase();
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
      await signInWithGoogle();
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
