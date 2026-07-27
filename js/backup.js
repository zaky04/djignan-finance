/* ==========================================================================
   GeoFinance System — Sauvegarde / Restauration
   Export/import JSON complet (avec variante chiffrée AES-GCM pour la copie
   distante hebdomadaire) + rappel hebdomadaire de sauvegarde.
   ========================================================================== */

import { STORES, dbGetAll, dbAdd, dbBulkPut, exportAllData, importAllData, getSetting, setSetting } from './db.js';
import { getEnrichedTransactions } from './ledger.js';
import { uuid, todayISO, currentMonthKey, downloadFile, readFileAsText, showToast } from './utils.js';
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

/* ---------- Export / import JSON en clair ---------- */
export async function exportJsonBackup() {
  const data = await exportAllData();
  downloadFile(`geofinance-backup-${todayISO()}.json`, JSON.stringify(data, null, 2), 'application/json');
  await setSetting('lastBackupAt', new Date().toISOString());
}

export async function importJsonBackup(file, { merge = false } = {}) {
  const text = await readFileAsText(file);
  const data = JSON.parse(text);
  await importAllData(data, { merge });
  notifyDataChanged('all');
}

/* ---------- Export / import JSON chiffré (AES-GCM 256, PBKDF2) ---------- */
export async function exportEncryptedBackup(passphrase) {
  const data = await exportAllData();
  const json = JSON.stringify(data);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(passphrase, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json));
  const payload = {
    geofinanceEncryptedBackup: true,
    version: 1,
    salt: bufToBase64(salt),
    iv: bufToBase64(iv),
    ciphertext: bufToBase64(ciphertext),
  };
  downloadFile(`geofinance-backup-chiffre-${todayISO()}.json`, JSON.stringify(payload), 'application/json');
  await setSetting('lastBackupAt', new Date().toISOString());
}

export async function importEncryptedBackup(file, passphrase, { merge = false } = {}) {
  const text = await readFileAsText(file);
  const payload = JSON.parse(text);
  if (!payload.geofinanceEncryptedBackup) throw new Error("Ce fichier n'est pas une sauvegarde chiffrée GeoFinance valide.");
  const key = await deriveAesKey(passphrase, base64ToBuf(payload.salt));
  let plainBuf;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBuf(payload.iv) }, key, base64ToBuf(payload.ciphertext));
  } catch {
    throw new Error('Mot de passe incorrect ou fichier corrompu.');
  }
  const data = JSON.parse(new TextDecoder().decode(plainBuf));
  await importAllData(data, { merge });
  notifyDataChanged('all');
}

/* ---------- Import / export CSV des transactions ---------- */
function csvEscape(value) {
  const s = String(value ?? '');
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

/** Importe des transactions depuis un CSV (format généré par le module Rapports). Crée les portefeuilles/catégories manquants. */
export async function importTransactionsCsv(file) {
  const text = await readFileAsText(file);
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) throw new Error('Fichier CSV vide.');
  const rows = lines.slice(1).map((l) => parseCsvLine(l));

  const wallets = await dbGetAll(STORES.WALLETS);
  const categories = await dbGetAll(STORES.CATEGORIES);
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

  let imported = 0;
  for (const cols of rows) {
    const [date, type, walletName, targetWalletName, categoryName, amountStr, currency, note, reconciledStr] = cols;
    if (!['income', 'expense', 'transfer'].includes(type)) continue;
    const wallet = findOrCreateWallet(walletName, currency);
    if (!wallet) continue;
    const targetWallet = type === 'transfer' ? findOrCreateWallet(targetWalletName, currency) : null;
    const category = findOrCreateCategory(categoryName, type);
    const tx = {
      id: uuid(), type, walletId: wallet.id, targetWalletId: targetWallet?.id || null,
      categoryId: category?.id || null, amount: parseFloat(amountStr) || 0, date: date || todayISO(),
      note: note || '', reconciled: (reconciledStr || '').toLowerCase().startsWith('oui'),
      createdAt: new Date().toISOString(),
    };
    await dbAdd(STORES.TRANSACTIONS, tx);
    imported++;
  }
  if (walletsChanged) await dbBulkPut(STORES.WALLETS, wallets);
  if (categoriesChanged) await dbBulkPut(STORES.CATEGORIES, categories);
  notifyDataChanged('all');
  return imported;
}

/* ---------- Rappel hebdomadaire ---------- */
export async function checkWeeklyBackupReminder() {
  const last = await getSetting('lastBackupAt');
  const snoozedUntil = await getSetting('backupSnoozedUntil');
  const now = Date.now();
  if (snoozedUntil && now < new Date(snoozedUntil).getTime()) return;
  const lastMs = last ? new Date(last).getTime() : 0;
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  if (now - lastMs < sevenDaysMs) return;
  showBackupReminderModal();
}

function showBackupReminderModal() {
  document.querySelectorAll('#modal-root .modal-backdrop[data-modal="backup-reminder"]').forEach((el) => el.remove());
  const tpl = document.getElementById('tpl-modal-backup-reminder');
  const root = document.getElementById('modal-root');
  root.appendChild(tpl.content.cloneNode(true));
  const backdrop = root.querySelector('.modal-backdrop[data-modal="backup-reminder"]');

  function close() { backdrop.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  backdrop.querySelector('#backup-later-btn').addEventListener('click', async () => {
    await setSetting('backupSnoozedUntil', new Date(Date.now() + 24 * 3600 * 1000).toISOString());
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
