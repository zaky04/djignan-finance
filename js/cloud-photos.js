/* ==========================================================================
   Djignan Financial System — Photos de la sauvegarde cloud, envoyées UNE SEULE FOIS chacune

   Avant : chaque sauvegarde cloud renvoyait toutes les photos de justificatifs (en base64, puis en base64 du chiffré : ×1,8), même
   celles envoyées la veille. Désormais :
   - la sauvegarde chiffrée des DONNÉES ne contient aucune photo, seulement `receiptHash` sur chaque transaction (backup.js) ;
   - chaque photo est envoyée à part, chiffrée, sous l'identifiant de son empreinte (SHA-256 de ses octets d'origine) ;
   - un index (`photoIndex`) liste les photos déjà envoyées : une sauvegarde ne transfère que les NOUVELLES photos ;
   - les photos qui ne sont plus référencées (transaction supprimée) sont supprimées du cloud après une sauvegarde réussie ;
   - à la restauration, les données reviennent d'abord, puis chaque photo est récupérée et déchiffrée.

   Tout passe par une interface de stockage minimale `{ get(id), set(id, data), deleteMany(ids) }` : firebase-sync.js la branche sur
   Firestore (même sous-collection `chunks` que les morceaux de la sauvegarde, donc AUCUNE règle de sécurité à modifier), les tests
   sur une mémoire. Ce fichier ne connaît pas Firebase.

   Chiffrement : AES-GCM, clé dérivée du MÊME mot de passe que la sauvegarde (PBKDF2, une fois par envoi) avec un sel propre aux photos,
   stocké dans l'index avec un petit témoin chiffré. Si le mot de passe change, le témoin ne s'ouvre plus : les photos sont alors
   renvoyées sous la nouvelle clé et les anciennes supprimées.
   ========================================================================== */

import { compressImageBlob } from './utils.js';
import { BACKUP_PHOTO_PROFILES, isLightBackupPhotos, deriveAesKey, bufToBase64, base64ToBuf } from './backup.js';

export const PHOTO_INDEX_ID = 'photoIndex';
/** Un document Firestore ne peut pas dépasser ~1 Mo : une photo chiffrée plus grosse est découpée en plusieurs morceaux. */
export const PHOTO_PART_CHARS = 900000;
const INDEX_SAVE_EVERY = 25; // l'index est réécrit toutes les N photos, pour qu'un envoi interrompu reprenne là où il s'est arrêté
const KEY_CHECK_TEXT = 'djignan-photos-v1';

export const photoDocId = (hash, i) => `p_${hash}_${i}`;

/* ---------- Chiffrement (pur, sans stockage) ---------- */

/** Nouvel index : sel propre aux photos + témoin chiffré servant à reconnaître le bon mot de passe. */
export async function newPhotoManifest(passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveAesKey(passphrase, salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const check = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(KEY_CHECK_TEXT));
  return { key, manifest: { salt: bufToBase64(salt), check: { iv: bufToBase64(iv), data: bufToBase64(check) } } };
}

/** Clé de l'index existant, ou null si le mot de passe ne correspond pas (index absent, abîmé ou chiffré avec un autre mot de passe). */
export async function openPhotoManifest(passphrase, manifest) {
  try {
    if (!manifest?.salt || !manifest?.check?.iv || !manifest?.check?.data) return null;
    const key = await deriveAesKey(passphrase, base64ToBuf(manifest.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(manifest.check.iv) }, key, base64ToBuf(manifest.check.data));
    return new TextDecoder().decode(plain) === KEY_CHECK_TEXT ? key : null;
  } catch {
    return null;
  }
}

/** Photo → morceaux de texte chiffrés. En clair : [longueur du type MIME (1 octet)][type MIME][octets de l'image]. */
export async function encryptPhotoToParts(key, blob, partChars = PHOTO_PART_CHARS) {
  const mime = new TextEncoder().encode(String(blob.type || 'image/jpeg').slice(0, 100));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const plain = new Uint8Array(1 + mime.length + bytes.length);
  plain[0] = mime.length;
  plain.set(mime, 1);
  plain.set(bytes, 1 + mime.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  const text = bufToBase64(packed.buffer);
  const parts = [];
  for (let i = 0; i < text.length; i += partChars) parts.push(text.slice(i, i + partChars));
  return parts.length ? parts : [''];
}

/** Morceaux chiffrés → photo (Blob). Lève une erreur si la clé ne convient pas ou si les données sont abîmées. */
export async function decryptPhotoFromParts(key, parts) {
  const packed = new Uint8Array(base64ToBuf(parts.join('')));
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12)));
  const mimeLen = plain[0];
  const mime = new TextDecoder().decode(plain.slice(1, 1 + mimeLen));
  // Seul un vrai type d'image est repris : une sauvegarde modifiée ne doit pas pouvoir y glisser autre chose.
  return new Blob([plain.slice(1 + mimeLen)], { type: /^image\/[a-z0-9.+-]+$/i.test(mime) ? mime : 'image/jpeg' });
}

/** Réduit la photo avant envoi, selon le réglage « Photos allégées dans les sauvegardes » (backup.js). */
async function defaultPrepare(blob) {
  const profile = (await isLightBackupPhotos()) ? BACKUP_PHOTO_PROFILES.light : BACKUP_PHOTO_PROFILES.normal;
  return compressImageBlob(blob, profile);
}

/* ---------- Petit outil : exécute `worker(item)` sur une liste, N à la fois, s'arrête au premier échec ---------- */
async function runPool(items, concurrency, worker) {
  let next = 0;
  let failure = null;
  const run = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try { await worker(item); } catch (err) { failure = failure || err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  if (failure) throw failure;
}

/* ---------- Suppression de photos du cloud ---------- */
async function deletePhotos(store, hashes, concurrency = 6) {
  const ids = [];
  await runPool(hashes, concurrency, async (hash) => {
    const first = await store.get(photoDocId(hash, 0));
    const n = Math.max(1, Math.min(Number(first?.n) || 1, 50));
    for (let i = 0; i < n; i++) ids.push(photoDocId(hash, i));
  });
  if (ids.length) await store.deleteMany(ids);
}

/* ---------- Envoi ---------- */

/** Envoie les photos pas encore dans le cloud. `photos` : Map empreinte → Blob d'origine (backup.js, buildEncryptedPayload).
    Renvoie { uploaded, total, reset }. Un échec (réseau…) interrompt l'envoi MAIS l'index garde les photos déjà parties : le prochain essai
    reprend sans les renvoyer. Les photos illisibles avec l'ancien mot de passe sont supprimées une fois les nouvelles envoyées. */
export async function uploadPhotos({ store, passphrase, photos, onProgress = () => {}, concurrency = 4, partChars = PHOTO_PART_CHARS, prepare = defaultPrepare }) {
  let indexDoc = await store.get(PHOTO_INDEX_ID);
  let key = indexDoc ? await openPhotoManifest(passphrase, indexDoc) : null;
  let reset = false;
  // `orphans` : photos à supprimer du cloud (illisibles avec l'ancien mot de passe). Gardées dans l'index tant qu'elles ne sont pas
  // réellement supprimées, pour qu'un envoi interrompu n'en oublie aucune.
  let orphans = Array.isArray(indexDoc?.orphans) ? [...indexDoc.orphans] : [];
  if (!key) {
    // Premier envoi, ou mot de passe changé : nouvel index ; les anciennes photos sont à supprimer une fois les nouvelles envoyées.
    const previous = Array.isArray(indexDoc?.hashes) ? indexDoc.hashes : [];
    orphans = [...new Set([...orphans, ...previous])];
    reset = previous.length > 0;
    const created = await newPhotoManifest(passphrase);
    key = created.key;
    indexDoc = { ...created.manifest, hashes: [] };
    await store.set(PHOTO_INDEX_ID, { ...indexDoc, ...(orphans.length ? { orphans } : {}), updatedAt: Date.now() });
  }
  const sent = new Set(indexDoc.hashes || []);
  const todo = [...photos.keys()].filter((hash) => !sent.has(hash));
  let done = 0;
  const saveIndex = () => store.set(PHOTO_INDEX_ID, { salt: indexDoc.salt, check: indexDoc.check, hashes: [...sent], ...(orphans.length ? { orphans } : {}), updatedAt: Date.now() });
  onProgress({ done, total: todo.length });
  try {
    await runPool(todo, concurrency, async (hash) => {
      const parts = await encryptPhotoToParts(key, await prepare(photos.get(hash)), partChars);
      for (let i = 0; i < parts.length; i++) await store.set(photoDocId(hash, i), { data: parts[i], n: parts.length });
      sent.add(hash); // seulement une fois TOUS ses morceaux écrits
      done++;
      onProgress({ done, total: todo.length });
      if (done % INDEX_SAVE_EVERY === 0) await saveIndex();
    });
  } finally {
    if (todo.length) { try { await saveIndex(); } catch { /* l'erreur d'origine prime */ } }
  }
  // Une photo qui vient d'être renvoyée sous la nouvelle clé porte le MÊME identifiant que son ancienne copie (identifiant = empreinte de
  // la photo) : elle l'a déjà remplacée, la « supprimer comme ancienne » effacerait la copie neuve.
  orphans = orphans.filter((hash) => !sent.has(hash));
  if (orphans.length) {
    try {
      await deletePhotos(store, orphans);
      orphans = [];
      await saveIndex();
    } catch (err) { console.warn('[Photos cloud] anciennes photos non supprimées (nouvel essai à la prochaine sauvegarde) :', err); }
  }
  return { uploaded: done, total: photos.size, reset };
}

/** Supprime du cloud les photos que la sauvegarde qui vient d'être validée ne référence plus (transaction supprimée…). À appeler
    APRÈS la bascule de la sauvegarde, jamais avant. `referenced` : Set des empreintes encore utilisées. */
export async function pruneUnreferencedPhotos({ store, referenced }) {
  const indexDoc = await store.get(PHOTO_INDEX_ID);
  const hashes = Array.isArray(indexDoc?.hashes) ? indexDoc.hashes : [];
  const unused = hashes.filter((hash) => !referenced.has(hash));
  if (!unused.length) return 0;
  await deletePhotos(store, unused);
  await store.set(PHOTO_INDEX_ID, { salt: indexDoc.salt, check: indexDoc.check, hashes: hashes.filter((hash) => referenced.has(hash)), ...(indexDoc.orphans?.length ? { orphans: indexDoc.orphans } : {}), updatedAt: Date.now() });
  return unused.length;
}

/* ---------- Récupération ---------- */

/** Récupère et déchiffre les photos d'empreintes `hashes`. Renvoie { blobs: Map empreinte → Blob, missing: [empreintes] }.
    Une photo absente ou illisible va dans `missing` : la restauration continue sans elle, elle ne bloque jamais le reste. */
export async function downloadPhotos({ store, passphrase, hashes, onProgress = () => {}, concurrency = 6 }) {
  const blobs = new Map();
  const unique = [...new Set(hashes)];
  const indexDoc = unique.length ? await store.get(PHOTO_INDEX_ID) : null;
  const key = indexDoc ? await openPhotoManifest(passphrase, indexDoc) : null;
  if (!key) return { blobs, missing: unique };
  let done = 0;
  onProgress({ done, total: unique.length });
  await runPool(unique, concurrency, async (hash) => {
    try {
      const first = await store.get(photoDocId(hash, 0));
      if (!first || typeof first.data !== 'string') throw new Error('absente');
      const n = Math.max(1, Math.min(Number(first.n) || 1, 50));
      const parts = [first.data];
      for (let i = 1; i < n; i++) {
        const part = await store.get(photoDocId(hash, i));
        if (!part || typeof part.data !== 'string') throw new Error('incomplète');
        parts.push(part.data);
      }
      blobs.set(hash, await decryptPhotoFromParts(key, parts));
    } catch { /* photo introuvable ou abîmée : comptée comme manquante */ }
    done++;
    onProgress({ done, total: unique.length });
  });
  return { blobs, missing: unique.filter((hash) => !blobs.has(hash)) };
}
