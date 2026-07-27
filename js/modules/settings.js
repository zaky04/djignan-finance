/* ==========================================================================
   GeoFinance System — Module Paramètres
   Sécurité (PIN/biométrie), devise de base, sauvegarde/restauration
   (JSON, JSON chiffré, CSV), remise à zéro complète.
   ========================================================================== */

import { STORES, dbGetAll, dbBulkPut, getSetting, setSetting, wipeAllData } from '../db.js';
import { changePin, isBiometricAvailable, isBiometricConfigured, registerBiometric, removeBiometric } from '../auth.js';
import { exportJsonBackup, importJsonBackup, exportEncryptedBackup, importEncryptedBackup, importTransactionsCsv, exportTransactionsCsv } from '../backup.js';
import { isNotificationSupported, getNotificationPermission, requestNotificationPermission, checkAndNotify } from '../notifications.js';
import { isStandalone, isIOS, isSafari, isAndroid, hasDeferredPrompt, triggerInstall, resetInstallPromptSnooze } from '../install-prompt.js';
import { escapeHtml, formatDate, CURRENCIES, openModal, confirmDialog, showToast } from '../utils.js';
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

async function renderBackupSection(container) {
  const lastBackupAt = await getSetting('lastBackupAt');
  const backupSnoozedUntil = await getSetting('backupSnoozedUntil');
  const lastBackupLabel = lastBackupAt ? formatDate(lastBackupAt) : 'jamais';
  const snoozedLabel = backupSnoozedUntil && Date.now() < new Date(backupSnoozedUntil).getTime()
    ? ` · rappel mis en pause jusqu'au ${formatDate(backupSnoozedUntil)}`
    : '';

  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Sauvegarde &amp; restauration</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;">Toutes vos données restent locales. Exportez régulièrement une copie (JSON complet ou CSV) pour éviter toute perte. Un rappel s'affiche automatiquement si aucune sauvegarde n'a été faite depuis 7 jours.</p>
      <div class="stat-row"><span class="stat-row-label">Dernière sauvegarde</span><span>${lastBackupLabel}${snoozedLabel}</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:12px;">
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

  container.querySelector('#export-json-btn').addEventListener('click', async () => { await exportJsonBackup(); showToast('Sauvegarde JSON exportée.'); renderBackupSection(container); });

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
    renderBackupSection(container);
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

async function renderNotificationsSection(container) {
  const supported = isNotificationSupported();
  const permission = getNotificationPermission();

  let statusHtml;
  if (!supported) {
    statusHtml = '<span class="badge">Non supportées par ce navigateur</span>';
  } else if (permission === 'granted') {
    statusHtml = '<span class="badge badge-pos">Activées</span><button type="button" class="btn btn-ghost" id="notif-test-btn" style="margin-left:8px;">Tester</button>';
  } else if (permission === 'denied') {
    statusHtml = '<span class="badge badge-neg">Bloquées par le navigateur</span>';
  } else {
    statusHtml = '<span class="badge">Désactivées</span><button type="button" class="btn btn-primary" id="notif-enable-btn" style="margin-left:8px;">Activer</button>';
  }

  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Notifications</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;">Rappels locaux pour vos échéances récurrentes proches (3 jours) et vos budgets qui approchent leur limite (70%/90%). Ces rappels s'affichent quand l'application est ouverte ou récemment réactivée — un envoi en arrière-plan app totalement fermée nécessiterait un serveur distant, ce qui irait à l'encontre du principe 100% local de GeoFinance.</p>
      <div class="stat-row"><span class="stat-row-label">Statut</span><span>${statusHtml}</span></div>
      ${permission === 'denied' ? '<p style="font-size:12px;color:var(--text-faint);margin-top:8px;">Vous avez bloqué les notifications pour ce site. Autorisez-les dans les paramètres de votre navigateur pour les réactiver.</p>' : ''}
    </div>`;

  container.querySelector('#notif-enable-btn')?.addEventListener('click', async () => {
    const perm = await requestNotificationPermission();
    if (perm === 'granted') { showToast('Notifications activées.'); await checkAndNotify(); }
    else if (perm === 'denied') { showToast('Notifications refusées.'); }
    renderNotificationsSection(container);
  });

  container.querySelector('#notif-test-btn')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body: "Voici à quoi ressemblera un rappel.", icon: 'icons/icon-192.png' };
    if (reg?.showNotification) await reg.showNotification('GeoFinance', opts);
    else new Notification('GeoFinance', opts);
  });
}

async function renderInstallSection(container) {
  const standalone = isStandalone();
  const iosSafari = isIOS() && isSafari();
  const iosOther = isIOS() && !isSafari();
  const androidLike = isAndroid() && !isIOS();

  let statusHtml, extraHtml = '';
  if (standalone) {
    statusHtml = '<span class="badge badge-pos">Déjà installée</span>';
  } else if (hasDeferredPrompt()) {
    statusHtml = '<span class="badge badge-pos">Disponible</span><button type="button" class="btn btn-primary" id="install-now-btn" style="margin-left:8px;">Installer maintenant</button>';
  } else if (iosSafari) {
    statusHtml = '<span class="badge">Installation manuelle</span>';
    extraHtml = "<p style=\"font-size:12.5px;color:var(--text-muted);margin-top:10px;\">Appuyez sur <strong>Partager</strong>, puis <strong>« Sur l'écran d'accueil »</strong>.</p>";
  } else if (iosOther) {
    statusHtml = '<span class="badge">Non disponible dans ce navigateur</span>';
    extraHtml = '<p style="font-size:12.5px;color:var(--text-muted);margin-top:10px;">Sur iPhone/iPad, l\'installation n\'est possible que depuis <strong>Safari</strong> (restriction Apple). Ouvrez ce site dans Safari, puis Partager → « Sur l\'écran d\'accueil ».</p>';
  } else if (androidLike) {
    statusHtml = '<span class="badge">Pas encore proposée</span>';
    extraHtml = '<p style="font-size:12.5px;color:var(--text-muted);margin-top:10px;">Ouvrez le menu ⋮ de votre navigateur et choisissez « Installer l\'application » ou « Ajouter à l\'écran d\'accueil ».</p>';
  } else {
    statusHtml = '<span class="badge">Pas encore proposée</span>';
    extraHtml = '<p style="font-size:12.5px;color:var(--text-muted);margin-top:10px;">Cherchez une icône d\'installation dans la barre d\'adresse, ou le menu du navigateur → « Installer GeoFinance ».</p>';
  }

  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Installation</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;">Installez GeoFinance sur cet appareil pour un accès direct depuis l'écran d'accueil, en plein écran et 100% hors-ligne.</p>
      <div class="stat-row"><span class="stat-row-label">Statut</span><span>${statusHtml}</span></div>
      ${extraHtml}
      ${!standalone ? '<button type="button" class="btn btn-ghost" id="reset-install-snooze-btn" style="margin-top:12px;">Réafficher le rappel automatique</button>' : ''}
    </div>`;

  container.querySelector('#install-now-btn')?.addEventListener('click', async () => {
    const outcome = await triggerInstall();
    if (outcome === 'accepted') showToast('Application installée !');
    else if (outcome === 'dismissed') showToast('Installation annulée.');
    renderInstallSection(container);
  });

  container.querySelector('#reset-install-snooze-btn')?.addEventListener('click', async () => {
    await resetInstallPromptSnooze();
    showToast("Le rappel d'installation réapparaîtra à la prochaine ouverture (si votre navigateur le propose).");
  });
}

async function renderUpdateSection(container) {
  container.innerHTML = `
    <div class="panel" style="margin-bottom:16px;">
      <div class="panel-header"><h3>Mise à jour</h3></div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;">GeoFinance fonctionne hors-ligne grâce à une copie locale de l'application. Vérifiez ici si une nouvelle version a été publiée : seul le code de l'application est remplacé, vos données (portefeuilles, transactions, budgets…) restent intactes.</p>
      <div class="stat-row"><span class="stat-row-label">Statut</span><span id="update-status"><span class="badge">Non vérifié</span></span></div>
      <button type="button" class="btn btn-primary" id="check-update-btn" style="margin-top:12px;">Vérifier les mises à jour</button>
    </div>`;

  const statusEl = container.querySelector('#update-status');
  const btn = container.querySelector('#check-update-btn');

  btn.addEventListener('click', async () => {
    if (!('serviceWorker' in navigator)) {
      showToast('Mises à jour automatiques non supportées par ce navigateur.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Vérification…';
    statusEl.innerHTML = '<span class="badge">Vérification…</span>';

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        statusEl.innerHTML = '<span class="badge">Aucune installation hors-ligne active</span>';
        return;
      }

      // sw.js active toute nouvelle version dès son installation (self.skipWaiting()
      // inconditionnel) puis prend le contrôle de la page ouverte : "controllerchange"
      // est donc le signal fiable qu'une nouvelle version vient d'être installée.
      const updated = await new Promise((resolve) => {
        const onControllerChange = () => resolve(true);
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, { once: true });
        reg.update().catch(() => {});
        setTimeout(() => {
          navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
          resolve(false);
        }, 4000);
      });

      if (updated) {
        statusEl.innerHTML = '<span class="badge badge-pos">Nouvelle version installée</span>';
        showToast('Nouvelle version installée, rechargement…');
        window.location.reload();
        return;
      }
      statusEl.innerHTML = '<span class="badge badge-pos">À jour</span>';
      showToast('Vous utilisez déjà la dernière version.');
    } catch (err) {
      statusEl.innerHTML = '<span class="badge badge-neg">Échec de la vérification</span>';
      showToast('Erreur : ' + (err.message || 'vérification impossible.'));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Vérifier les mises à jour';
    }
  });
}

export async function renderSettings() {
  const container = document.getElementById('settings-content');
  if (!container) return;
  container.innerHTML = '<div id="settings-security"></div><div id="settings-notifications"></div><div id="settings-install"></div><div id="settings-update"></div><div id="settings-currency"></div><div id="settings-backup"></div>';
  await renderSecuritySection(document.getElementById('settings-security'));
  await renderNotificationsSection(document.getElementById('settings-notifications'));
  await renderInstallSection(document.getElementById('settings-install'));
  await renderUpdateSection(document.getElementById('settings-update'));
  await renderCurrencySection(document.getElementById('settings-currency'));
  await renderBackupSection(document.getElementById('settings-backup'));
}

export function initSettingsModule() {}
