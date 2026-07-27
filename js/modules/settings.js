/* ==========================================================================
   GeoFinance System — Module Paramètres
   Sécurité (PIN/biométrie), devise de base, sauvegarde/restauration
   (JSON, JSON chiffré, CSV), remise à zéro complète.
   ========================================================================== */

import { STORES, dbGetAll, dbBulkPut, getSetting, setSetting, wipeAllData } from '../db.js';
import { changePin, isBiometricAvailable, isBiometricConfigured, registerBiometric, removeBiometric } from '../auth.js';
import { exportJsonBackup, importJsonBackup, exportEncryptedBackup, importEncryptedBackup, importTransactionsCsv, exportTransactionsCsv } from '../backup.js';
import { escapeHtml, CURRENCIES, openModal, confirmDialog, showToast } from '../utils.js';
import { notifyDataChanged } from '../state.js';

function hiddenFileInput(accept, onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  document.body.appendChild(input);
  return input;
}

function promptPassphrase(title) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <form id="passphrase-form">
        <div class="form-row"><label>Mot de passe de la sauvegarde</label><input type="password" name="passphrase" required minlength="6" autofocus></div>
        <button type="submit" class="btn btn-primary btn-block">Continuer</button>
      </form>`, { title, onClose: () => resolve(null) });
    modal.el.querySelector('#passphrase-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = new FormData(e.target).get('passphrase');
      modal.close();
      resolve(p);
    });
  });
}

async function renderSecuritySection(container) {
  const bioSupported = await isBiometricAvailable();
  const bioConfigured = await isBiometricConfigured();

  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Sécurité</h3></div>
      <form id="pin-change-form" style="margin-bottom:18px;">
        <div class="form-row"><label>Code PIN actuel</label><input type="password" name="oldPin" required minlength="4" maxlength="6" inputmode="numeric" pattern="\\d{4,6}"></div>
        <div class="form-row"><label>Nouveau code PIN (4-6 chiffres)</label><input type="password" name="newPin" required minlength="4" maxlength="6" inputmode="numeric" pattern="\\d{4,6}"></div>
        <div class="form-row"><label>Confirmer le nouveau code</label><input type="password" name="newPinConfirm" required minlength="4" maxlength="6" inputmode="numeric" pattern="\\d{4,6}"></div>
        <button type="submit" class="btn btn-primary">Changer le code PIN</button>
      </form>
      <div class="stat-row">
        <span class="stat-row-label">Déverrouillage biométrique</span>
        <span>
          ${!bioSupported ? '<span class="badge">Non disponible sur cet appareil</span>' : `
            <span class="badge ${bioConfigured ? 'badge-pos' : ''}">${bioConfigured ? 'Activée' : 'Désactivée'}</span>
            <button type="button" class="btn btn-ghost" id="bio-toggle-btn" style="margin-left:8px;">${bioConfigured ? 'Désactiver' : 'Activer'}</button>
          `}
        </span>
      </div>
    </div>`;

  container.querySelector('#pin-change-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('newPin') !== fd.get('newPinConfirm')) { showToast('Les nouveaux codes ne correspondent pas.'); return; }
    try {
      await changePin(fd.get('oldPin'), fd.get('newPin'));
      showToast('Code PIN modifié.');
      e.target.reset();
    } catch (err) {
      showToast(err.message || 'Erreur lors du changement de PIN.');
    }
  });

  container.querySelector('#bio-toggle-btn')?.addEventListener('click', async () => {
    if (bioConfigured) {
      const ok = await confirmDialog('Désactiver le déverrouillage biométrique ?');
      if (ok) { await removeBiometric(); showToast('Biométrie désactivée.'); renderSecuritySection(container); }
    } else {
      try {
        await registerBiometric();
        showToast('Biométrie activée.');
        renderSecuritySection(container);
      } catch (err) {
        showToast(err.message || 'Échec de l\'activation biométrique.');
      }
    }
  });
}

async function renderCurrencySection(container) {
  const baseCurrency = await getSetting('baseCurrency', 'EUR');
  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Devise de base</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">Toutes les conversions (patrimoine net, rapports, outils) sont exprimées dans cette devise. La modifier réinitialise vos taux de change existants.</p>
      <div class="form-row" style="max-width:200px;">
        <select id="base-currency-select">${CURRENCIES.map((c) => `<option value="${c}" ${c === baseCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
    </div>`;

  container.querySelector('#base-currency-select').addEventListener('change', async (e) => {
    const newCurrency = e.target.value;
    const ok = await confirmDialog(`Passer la devise de base à ${newCurrency} ? Vos taux de change existants seront réinitialisés à 1 et devront être ressaisis.`, { confirmText: 'Confirmer' });
    if (!ok) { e.target.value = baseCurrency; return; }
    await setSetting('baseCurrency', newCurrency);
    const rates = await dbGetAll(STORES.EXCHANGE_RATES);
    const reset = rates.map((r) => ({ ...r, rateToBase: 1 }));
    await dbBulkPut(STORES.EXCHANGE_RATES, reset);
    showToast('Devise de base mise à jour.');
    notifyDataChanged('all');
  });
}

function renderBackupSection(container) {
  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Sauvegarde &amp; restauration</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;">Toutes vos données restent locales. Exportez régulièrement une copie (JSON complet ou CSV) pour éviter toute perte.</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;">
        <button type="button" class="btn btn-primary" id="export-json-btn">Exporter (JSON)</button>
        <button type="button" class="btn btn-ghost" id="import-json-btn">Importer (JSON)</button>
        <button type="button" class="btn btn-ghost" id="export-encrypted-btn">Exporter (JSON chiffré)</button>
        <button type="button" class="btn btn-ghost" id="import-encrypted-btn">Importer (JSON chiffré)</button>
        <button type="button" class="btn btn-ghost" id="export-csv-btn">Exporter des transactions (CSV)</button>
        <button type="button" class="btn btn-ghost" id="import-csv-btn">Importer des transactions (CSV)</button>
      </div>
    </div>
    <div class="panel" style="border-color:var(--neg);">
      <div class="panel-header"><h3 style="color:var(--neg);">Zone dangereuse</h3></div>
      <button type="button" class="btn btn-danger" id="wipe-data-btn">Réinitialiser toutes les données</button>
    </div>`;

  container.querySelector('#export-json-btn').addEventListener('click', async () => { await exportJsonBackup(); showToast('Sauvegarde JSON exportée.'); });

  container.querySelector('#import-json-btn').addEventListener('click', () => {
    hiddenFileInput('application/json', async (file) => {
      const merge = await confirmDialog('Fusionner avec les données existantes ? "Annuler" remplacera entièrement les données actuelles par celles du fichier.', { confirmText: 'Fusionner', cancelText: 'Remplacer tout' });
      try {
        await importJsonBackup(file, { merge });
        showToast('Import réussi.');
      } catch (err) { showToast('Erreur : ' + (err.message || 'fichier invalide.')); }
    }).click();
  });

  container.querySelector('#export-encrypted-btn').addEventListener('click', async () => {
    const p1 = await promptPassphrase('Mot de passe de chiffrement');
    if (!p1) return;
    await exportEncryptedBackup(p1);
    showToast('Sauvegarde chiffrée exportée.');
  });

  container.querySelector('#import-encrypted-btn').addEventListener('click', () => {
    hiddenFileInput('application/json', async (file) => {
      const p = await promptPassphrase('Mot de passe de la sauvegarde');
      if (!p) return;
      const merge = await confirmDialog('Fusionner avec les données existantes ?', { confirmText: 'Fusionner', cancelText: 'Remplacer tout' });
      try {
        await importEncryptedBackup(file, p, { merge });
        showToast('Import réussi.');
      } catch (err) { showToast('Erreur : ' + (err.message || 'fichier invalide.')); }
    }).click();
  });

  container.querySelector('#export-csv-btn').addEventListener('click', async () => {
    await exportTransactionsCsv();
    showToast('Export CSV généré.');
  });

  container.querySelector('#import-csv-btn').addEventListener('click', () => {
    hiddenFileInput('.csv,text/csv', async (file) => {
      try {
        const count = await importTransactionsCsv(file);
        showToast(`${count} transaction(s) importée(s).`);
      } catch (err) { showToast('Erreur : ' + (err.message || 'fichier invalide.')); }
    }).click();
  });

  container.querySelector('#wipe-data-btn').addEventListener('click', async () => {
    const ok = await confirmDialog('Supprimer DÉFINITIVEMENT toutes les données de GeoFinance (portefeuilles, transactions, budgets, investissements, dettes…) ? Cette action est irréversible. Exportez une sauvegarde avant si besoin.', { danger: true, confirmText: 'Tout supprimer' });
    if (!ok) return;
    const ok2 = await confirmDialog('Dernière confirmation : voulez-vous vraiment tout réinitialiser ?', { danger: true, confirmText: 'Oui, réinitialiser' });
    if (!ok2) return;
    await wipeAllData();
    showToast('Toutes les données ont été réinitialisées.');
    notifyDataChanged('all');
  });
}

export async function renderSettings() {
  const container = document.getElementById('settings-content');
  if (!container) return;
  container.innerHTML = '<div id="settings-security"></div><div id="settings-currency"></div><div id="settings-backup"></div>';
  await renderSecuritySection(document.getElementById('settings-security'));
  await renderCurrencySection(document.getElementById('settings-currency'));
  renderBackupSection(document.getElementById('settings-backup'));
}

export function initSettingsModule() {}
