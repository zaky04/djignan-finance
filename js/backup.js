/* ==========================================================================
   GeoFinance System — Sauvegarde / Restauration
   Export/import JSON complet (avec variante chiffrée AES-GCM pour la copie
   distante hebdomadaire) + rappel hebdomadaire de sauvegarde.
   ========================================================================== */

import { STORES, dbGetAll, dbAdd, dbBulkPut, exportAllData, importAllData, getSetting, setSetting } from './db.js';
import { getEnrichedTransactions, guessCategoryId } from './ledger.js';
import { uuid, todayISO, currentMonthKey, downloadFile, readFileAsText, showToast, safeNumber } from './utils.js';
import { notifyDataChanged } from './state.js';

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function deriveAesKey(passphrase, saltBuf) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBuf, iterations: 150000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

/* JSON.stringify() sérialise silencieusement un Blob en "{}" (aucune propriété
   énumérable) : les justificatifs photo des transactions (receiptBlob) seraient
   perdus sans bruit à l'export. On les convertit en data URL (chaîne base64)
   avant stringify, et on les reconvertit en Blob après parse à l'import. */
async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
async function serializeReceiptsForExport(data) {
  for (const t of data.stores?.[STORES.TRANSACTIONS] || []) {
    if (t.receiptBlob instanceof Blob) {
      t.receiptDataUrl = await blobToDataUrl(t.receiptBlob);
      delete t.receiptBlob;
    }
  }
}
export async function deserializeReceiptsForImport(data) {
  for (const t of data.stores?.[STORES.TRANSACTIONS] || []) {
    if (t.receiptDataUrl) {
      t.receiptBlob = await dataUrlToBlob(t.receiptDataUrl);
      delete t.receiptDataUrl;
    }
  }
}

/** À appeler après toute sauvegarde réussie (export manuel, chiffré, ou auto) : marque
    lastBackupAt ET remet à zéro le compteur de report, pour que le rappel hebdomadaire
    redevienne "poli" (snooze 24h autorisé) tant que l'utilisateur ne l'ignore pas à nouveau
    plusieurs fois de suite. Voir checkWeeklyBackupReminder(). */
export async function markBackupDone() {
  await setSetting('lastBackupAt', new Date().toISOString());
  await setSetting('backupSnoozeCount', 0);
}

/* ---------- Export / import JSON en clair ---------- */
export async function exportJsonBackup() {
  const data = await exportAllData();
  await serializeReceiptsForExport(data);
  downloadFile(`geofinance-backup-${todayISO()}.json`, JSON.stringify(data, null, 2), 'application/json');
  await markBackupDone();
}

export async function importJsonBackup(file, { merge = false } = {}) {
  const text = await readFileAsText(file);
  const data = JSON.parse(text);
  await deserializeReceiptsForImport(data);
  await importAllData(data, { merge });
  notifyDataChanged('all');
}

/* ---------- Export / import JSON chiffré (AES-GCM 256, PBKDF2) ----------
   buildEncryptedPayload()/decryptPayload() portent tout le cœur cryptographique, indépendamment
   de la destination (fichier téléchargé ici, document Firestore dans firebase-sync.js) : le même
   chiffrement, testé une seule fois, sert aux deux. */
export async function buildEncryptedPayload(passphrase) {
  const data = await exportAllData();
  await serializeReceiptsForExport(data);
  const json = JSON.stringify(data);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json));
  return {
    geofinanceEncryptedBackup: true,
    version: 1,
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(ciphertext),
  };
}

export async function decryptPayload(payload, passphrase) {
  if (!payload?.geofinanceEncryptedBackup) throw new Error("Ce n'est pas une sauvegarde chiffrée GeoFinance valide.");
  const key = await deriveAesKey(passphrase, base64ToBuf(payload.salt));
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(payload.iv) }, key, base64ToBuf(payload.ciphertext));
  } catch {
    throw new Error('Mot de passe incorrect ou sauvegarde corrompue.');
  }
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

export async function exportEncryptedBackup(passphrase) {
  const payload = await buildEncryptedPayload(passphrase);
  downloadFile(`geofinance-backup-chiffre-${todayISO()}.json`, JSON.stringify(payload), 'application/json');
  await markBackupDone();
}

export async function importEncryptedBackup(file, passphrase, { merge = false } = {}) {
  const text = await readFileAsText(file);
  const payload = JSON.parse(text);
  const data = await decryptPayload(payload, passphrase);
  await deserializeReceiptsForImport(data);
  await importAllData(data, { merge });
  notifyDataChanged('all');
}

/* ---------- Import / export CSV des transactions ---------- */
function csvEscape(value) {
  let s = String(value ?? '');
  // Neutralise l'injection de formule façon "CSV injection" (OWASP) : un champ commençant
  // par =, +, -, @ peut être interprété comme une formule par Excel/Sheets à l'ouverture.
  // Les notes peuvent provenir d'un relevé bancaire tiers importé (pas toujours sous le
  // contrôle direct de l'utilisateur), d'où la prudence même dans un export "de confiance".
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Exporte les transactions en CSV. Sans monthKey : historique complet. */
export async function exportTransactionsCsv(monthKey = null) {
  const rows = await getEnrichedTransactions(monthKey ? { monthKey } : {});
  const header = ['Date', 'Type', 'Portefeuille', 'Vers portefeuille', 'Catégorie', 'Montant', 'Devise', 'Note', 'Pointée'];
  const lines = [header.join(';')];
  for (const t of rows) {
    lines.push([
      t.date, t.type, csvEscape(t.wallet?.name || ''), csvEscape(t.targetWallet?.name || ''),
      csvEscape(t.category?.name || ''), t.amount, t.wallet?.currency || '', csvEscape(t.note || ''), t.reconciled ? 'Oui' : 'Non',
    ].map(csvEscape).join(';'));
  }
  const suffix = monthKey || 'historique-complet';
  downloadFile(`geofinance-transactions-${suffix}.csv`, '﻿' + lines.join('\n'), 'text/csv;charset=utf-8');
}

function parseCsvLine(line, delimiter = ';') {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; } }
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const GEOFINANCE_CSV_HEADER = ['Date', 'Type', 'Portefeuille', 'Vers portefeuille', 'Catégorie', 'Montant', 'Devise', 'Note', 'Pointée'];

function detectDelimiter(headerLine) {
  let best = ';', bestCount = 0;
  for (const d of [';', ',', '\t']) {
    const count = parseCsvLine(headerLine, d).length;
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/** Lit et analyse un CSV de transactions : détecte le délimiteur et si le format correspond
    exactement à l'export GeoFinance (import direct possible) ou non (relevé bancaire générique,
    nécessite un mapping manuel des colonnes par l'utilisateur avant import). */
export async function analyzeTransactionsCsv(file) {
  const text = await readFileAsText(file);
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) throw new Error('Fichier CSV vide.');
  const delimiter = detectDelimiter(lines[0]);
  const headerCells = parseCsvLine(lines[0], delimiter).map((h) => h.trim());
  const rows = lines.slice(1).map((l) => parseCsvLine(l, delimiter));
  const isGeoFinanceFormat = headerCells.length === GEOFINANCE_CSV_HEADER.length
    && headerCells.every((h, i) => h.toLowerCase() === GEOFINANCE_CSV_HEADER[i].toLowerCase());
  return { format: isGeoFinanceFormat ? 'geofinance' : 'generic', headerCells, rows, delimiter };
}

/** Détecte un doublon probable : même portefeuille, même date, montant quasi identique et même
    type — cas typique d'un relevé réimporté sur une période qui chevauche un import précédent. */
function isDuplicateTransaction(existingTransactions, candidate) {
  return existingTransactions.some((t) =>
    t.walletId === candidate.walletId
    && t.date === candidate.date
    && t.type === candidate.type
    && Math.abs((t.amount || 0) - candidate.amount) < 0.005
  );
}

/** Importe des lignes déjà parsées au format GeoFinance (Date;Type;Portefeuille;...). Crée les portefeuilles/catégories manquants.
    Retourne { imported, skipped } — skipped compte les lignes ignorées car déjà présentes. */
export async function importGeoFinanceCsvRows(rows) {
  const wallets = await dbGetAll(STORES.WALLETS);
  const categories = await dbGetAll(STORES.CATEGORIES);
  const existingTransactions = await dbGetAll(STORES.TRANSACTIONS);
  let walletsChanged = false, categoriesChanged = false;

  function findOrCreateWallet(name, currency) {
    if (!name) return null;
    let w = wallets.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!w) {
      w = { id: uuid(), name, type: 'bank', currency: currency || 'EUR', initialBalance: 0, archived: false, createdAt: new Date().toISOString() };
      wallets.push(w); walletsChanged = true;
    }
    return w;
  }
  function findOrCreateCategory(name, type) {
    if (!name || type === 'transfer') return null;
    let c = categories.find((x) => x.type === type && x.name.toLowerCase() === name.toLowerCase());
    if (!c) {
      c = { id: uuid(), name, type, parentId: null, createdAt: new Date().toISOString() };
      categories.push(c); categoriesChanged = true;
    }
    return c;
  }

  let imported = 0, skipped = 0;
  for (const cols of rows) {
    const [date, type, walletName, targetWalletName, categoryName, amountStr, currency, note, reconciledStr] = cols;
    if (!['income', 'expense', 'transfer'].includes(type)) continue;
    const wallet = findOrCreateWallet(walletName, currency);
    if (!wallet) continue;
    const targetWallet = type === 'transfer' ? findOrCreateWallet(targetWalletName, currency) : null;
    const category = findOrCreateCategory(categoryName, type);
    const tx = {
      id: uuid(), type, walletId: wallet.id, targetWalletId: targetWallet?.id || null,
      categoryId: category?.id || null, amount: safeNumber(parseFloat(amountStr)), date: date || todayISO(),
      note: note || '', reconciled: (reconciledStr || '').toLowerCase().startsWith('oui'),
      createdAt: new Date().toISOString(),
    };
    if (isDuplicateTransaction(existingTransactions, tx)) { skipped++; continue; }
    await dbAdd(STORES.TRANSACTIONS, tx);
    existingTransactions.push(tx);
    imported++;
  }
  if (walletsChanged) await dbBulkPut(STORES.WALLETS, wallets);
  if (categoriesChanged) await dbBulkPut(STORES.CATEGORIES, categories);
  notifyDataChanged('all');
  return { imported, skipped };
}

function parseFlexibleNumber(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim().replace(/[^\d,.\-]/g, '');
  if (!s) return 0;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/** Accepte YYYY-MM-DD ou JJ/MM/AAAA (avec /, . ou - comme séparateur) — format usuel des relevés bancaires européens. */
function parseFlexibleDate(raw) {
  if (!raw) return null;
  const s = raw.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

/** Importe des lignes de relevé bancaire générique selon un mapping de colonnes choisi par
    l'utilisateur. mapping: { walletId, dateCol, noteCol, amountMode: 'single'|'debitCredit',
    amountCol, invertSign, debitCol, creditCol }. La catégorie est devinée via guessCategoryId()
    (ledger.js — règles explicites de Budgets > Règles puis ressemblance avec des transactions
    déjà catégorisées, partagé avec la Saisie express), sinon laissée vide.
    Retourne { imported, skipped } — skipped compte les lignes ignorées car déjà présentes
    (même portefeuille, date, montant et type — cas d'un relevé réimporté sur une période
    qui chevauche un import précédent). */
export async function importGenericCsvRows(rows, mapping) {
  const wallets = await dbGetAll(STORES.WALLETS);
  const wallet = wallets.find((w) => w.id === mapping.walletId);
  if (!wallet) throw new Error('Portefeuille introuvable.');

  const allTransactions = await dbGetAll(STORES.TRANSACTIONS);

  let imported = 0, skipped = 0;
  for (const cols of rows) {
    const date = parseFlexibleDate(cols[mapping.dateCol]);
    if (!date) continue;
    const note = mapping.noteCol != null ? (cols[mapping.noteCol] || '').trim().slice(0, 140) : '';

    let amount, type;
    if (mapping.amountMode === 'debitCredit') {
      const debit = parseFlexibleNumber(cols[mapping.debitCol]);
      const credit = parseFlexibleNumber(cols[mapping.creditCol]);
      if (debit > 0) { amount = debit; type = 'expense'; }
      else if (credit > 0) { amount = credit; type = 'income'; }
      else continue;
    } else {
      let raw = parseFlexibleNumber(cols[mapping.amountCol]);
      if (mapping.invertSign) raw = -raw;
      if (!raw) continue;
      amount = Math.abs(raw);
      type = raw < 0 ? 'expense' : 'income';
    }

    const tx = {
      id: uuid(), type, walletId: wallet.id, targetWalletId: null,
      categoryId: await guessCategoryId(note, type), amount, date, note,
      reconciled: false, createdAt: new Date().toISOString(),
    };
    if (isDuplicateTransaction(allTransactions, tx)) { skipped++; continue; }
    await dbAdd(STORES.TRANSACTIONS, tx);
    allTransactions.push(tx);
    imported++;
  }
  notifyDataChanged('all');
  return { imported, skipped };
}

/* ---------- Sauvegarde automatique locale (File System Access API) ----------
   Optionnelle : l'utilisateur choisit un dossier une fois, GeoFinance y écrit
   ensuite un export JSON automatiquement au moment du rappel hebdomadaire,
   sans qu'il ait à cliquer sur "Exporter" à chaque fois. Uniquement supporté
   par les navigateurs basés Chromium sur ordinateur ; repli gracieux sinon
   sur le rappel manuel existant. */
export function isFileSystemAccessSupported() {
  return 'showDirectoryPicker' in window;
}

export async function chooseAutoBackupDirectory() {
  if (!isFileSystemAccessSupported()) throw new Error("Votre navigateur ne permet pas cette fonctionnalité (Chrome/Edge sur ordinateur uniquement).");
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await setSetting('autoBackupDirHandle', handle);
  return handle;
}

export async function getAutoBackupDirectory() {
  return getSetting('autoBackupDirHandle', null);
}

export async function clearAutoBackupDirectory() {
  await setSetting('autoBackupDirHandle', null);
}

async function ensureAutoBackupPermission(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
}

/** Écrit un export JSON dans le dossier de sauvegarde automatique choisi, si configuré et
    autorisé. Retourne true si l'écriture a réussi (auquel cas lastBackupAt est mis à jour). */
export async function runAutoBackupIfConfigured() {
  const handle = await getAutoBackupDirectory();
  if (!handle) return false;
  try {
    if (!(await ensureAutoBackupPermission(handle))) return false;
    const data = await exportAllData();
    await serializeReceiptsForExport(data);
    const fileHandle = await handle.getFileHandle(`geofinance-backup-${todayISO()}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    await markBackupDone();
    return true;
  } catch (err) {
    console.warn('[backup] Sauvegarde automatique échouée :', err);
    return false;
  }
}

/* ---------- Rappel hebdomadaire ----------
   "Plus tard" ne peut pas être utilisé indéfiniment : au-delà de 3 reports consécutifs, le
   rappel passe en mode "urgent" (bouton "Plus tard" retiré, ne reste que "Exporter maintenant"
   ou fermer). Fermer sans exporter en mode urgent NE pose PAS de nouveau snooze, donc le rappel
   réapparaîtra au prochain déverrouillage — c'est volontaire : au-delà de 3 reports, on considère
   que le rappel poli n'a pas fonctionné et qu'il faut relancer l'utilisateur à chaque session
   jusqu'à ce qu'il exporte réellement (voir markBackupDone() qui remet le compteur à 0). */
const BACKUP_SNOOZE_LIMIT = 3;

export async function checkWeeklyBackupReminder() {
  const last = await getSetting('lastBackupAt');
  const snoozedUntil = await getSetting('backupSnoozedUntil');
  const snoozeCount = await getSetting('backupSnoozeCount', 0);
  const now = Date.now();
  const urgent = snoozeCount >= BACKUP_SNOOZE_LIMIT;
  if (!urgent && snoozedUntil && now < new Date(snoozedUntil).getTime()) return;
  const lastMs = last ? new Date(last).getTime() : 0;
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  if (now - lastMs < sevenDaysMs) return;

  if (await runAutoBackupIfConfigured()) { showToast('Sauvegarde automatique effectuée.'); return; }

  showBackupReminderModal(urgent);
}

function showBackupReminderModal(urgent = false) {
  document.querySelectorAll('#modal-root .modal-backdrop[data-modal="backup-reminder"]').forEach((el) => el.remove());
  const tpl = document.getElementById('tpl-modal-backup-reminder');
  const root = document.getElementById('modal-root');
  root.appendChild(tpl.content.cloneNode(true));
  const backdrop = root.querySelector('.modal-backdrop[data-modal="backup-reminder"]');

  if (urgent) {
    backdrop.querySelector('#backup-title').textContent = 'Sauvegarde en retard ⚠';
    backdrop.querySelector('.modal-body > p').textContent = "Vous avez repoussé ce rappel plusieurs fois. Vos données ne vivent que sur cet appareil : sans export, un changement de téléphone, une réinstallation ou un nettoyage du cache les effacerait définitivement. Exportez-les maintenant.";
    backdrop.querySelector('#backup-later-btn').remove();
  }

  function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  backdrop.querySelector('#backup-later-btn')?.addEventListener('click', async () => {
    await setSetting('backupSnoozedUntil', new Date(Date.now() + 24 * 3600 * 1000).toISOString());
    await setSetting('backupSnoozeCount', (await getSetting('backupSnoozeCount', 0)) + 1);
    close();
  });

  backdrop.querySelector('#backup-export-btn').addEventListener('click', () => {
    const body = backdrop.querySelector('.modal-body');
    body.innerHTML = `
      <form id="encrypted-export-form">
        <p style="margin:0 0 12px;font-size:13px;color:var(--text-muted);">Choisissez un mot de passe pour chiffrer votre sauvegarde avant de l'envoyer vers votre stockage distant (Drive, etc.). Conservez-le précieusement : sans lui, la sauvegarde ne pourra pas être restaurée.</p>
        <div class="form-row"><label>Mot de passe</label><input type="password" name="passphrase" required minlength="6" autofocus></div>
        <div class="form-row"><label>Confirmer le mot de passe</label><input type="password" name="passphraseConfirm" required minlength="6"></div>
        <button type="submit" class="btn btn-primary btn-block">Chiffrer et exporter</button>
      </form>`;
    body.querySelector('#encrypted-export-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('passphrase') !== fd.get('passphraseConfirm')) { showToast('Les mots de passe ne correspondent pas.'); return; }
      await exportEncryptedBackup(fd.get('passphrase'));
      showToast('Sauvegarde chiffrée exportée.');
      close();
    });
  });
}
