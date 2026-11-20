/* ==========================================================================
   Djignan Financial System — Module Paramètres
   Sécurité (PIN/biométrie), devise de base, sauvegarde/restauration
   (JSON, JSON chiffré, CSV), remise à zéro complète.
   ========================================================================== */

import { STORES, dbGetAll, dbWriteBatch, getSetting, setSetting, wipeAllData } from '../db.js';
import { changePin, isBiometricAvailable, isBiometricConfigured, registerBiometric, removeBiometric, isHelperConfigured, setupHelperPin, removeHelperPin, getPinLength } from '../auth.js';
import { verifyBackup, getLastBackupVerification } from '../backup-verify.js';
import {
  exportJsonBackup, importJsonBackup, exportEncryptedBackup, importEncryptedBackup,
  analyzeTransactionsCsv, importDjignanCsvRows, importGenericCsvRows, exportTransactionsCsv,
  isFileSystemAccessSupported, chooseAutoBackupDirectory, getAutoBackupDirectory, clearAutoBackupDirectory,
  estimateBackupSize, optimizeStoredReceipts, formatBytes,
} from '../backup.js';
import { isNotificationSupported, getNotificationPermission, requestNotificationPermission, checkAndNotify } from '../notifications.js';
import { renderCloudBackupSection } from '../firebase-sync.js';
import { isStandalone, isIOS, isSafari, isAndroid, hasDeferredPrompt, triggerInstall, resetInstallPromptSnooze } from '../install-prompt.js';
import { DASHBOARD_PANEL_DEFAULTS, BUDGET_ALERT_THRESHOLD_DEFAULTS } from './dashboard.js';
import { escapeHtml, formatDate, localISODate, CURRENCIES, openModal, confirmDialog, confirmReplaceAllData, showToast } from '../utils.js';
import { notifyDataChanged, appState } from '../state.js';
import { getUiMode, setUiMode } from '../ui-mode.js';
import { isEasyHomeEnabled, setEasyHome } from '../easy-home.js';
import { isSpeechSupported, speak, primeSpeech } from '../speech-out.js';
import { isNativeReminderSupported, enableNativeReminders, disableNativeReminders } from '../native-reminders.js';
import { t, getLanguage, setLanguage } from '../i18n.js';

function hiddenFileInput(accept, onFile) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  document.body.appendChild(input);
  return input;
}

function openCsvMappingModal(analysis) {
  const { headerCells, rows } = analysis;
  const colOptions = headerCells.map((h, i) => `<option value="${i}">${t('{col} (colonne {n})', { col: escapeHtml(h), n: i + 1 })}</option>`).join('');

  const modal = openModal(`
    <form id="csv-mapping-form">
      <p class="fs-13 c-muted mb-12">${t("Ce fichier ne correspond pas au format d'export Djignan. Indiquez à quoi correspond chaque colonne pour l'importer quand même ({count} ligne(s) détectée(s)).", { count: rows.length })}</p>
      <div class="form-row"><label>${t('Portefeuille de destination')}</label><select name="walletId" id="csv-map-wallet" required></select></div>
      <div class="form-row"><label>${t('Colonne Date')}</label><select name="dateCol">${colOptions}</select></div>
      <div class="form-row"><label>${t('Colonne Description / libellé (optionnel)')}</label><select name="noteCol"><option value="">${t('Aucune')}</option>${colOptions}</select></div>
      <div class="form-row"><label>${t('Format du montant')}</label>
        <select name="amountMode" id="csv-map-amount-mode">
          <option value="single">${t('Une seule colonne (montant signé : + recette / − dépense)')}</option>
          <option value="debitCredit">${t('Deux colonnes séparées (Débit / Crédit)')}</option>
        </select>
      </div>
      <div id="csv-map-single-fields">
        <div class="form-row"><label>${t('Colonne Montant')}</label><select name="amountCol">${colOptions}</select></div>
        <label style="display:flex;align-items:center;gap:8px;" class="fs-13 mb-14"><input type="checkbox" name="invertSign"> ${t('Inverser le signe (si les dépenses sont positives dans ce fichier)')}</label>
      </div>
      <div id="csv-map-debit-credit-fields" hidden>
        <div class="form-row"><label>${t('Colonne Débit (dépenses)')}</label><select name="debitCol">${colOptions}</select></div>
        <div class="form-row"><label>${t('Colonne Crédit (recettes)')}</label><select name="creditCol">${colOptions}</select></div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">${t('Importer')}</button>
    </form>`, { title: t('Associer les colonnes du CSV') });

  (async () => {
    const wallets = (await dbGetAll(STORES.WALLETS)).filter((w) => !w.archived);
    const walletSelect = modal.el.querySelector('#csv-map-wallet');
    walletSelect.innerHTML = wallets.length
      ? wallets.map((w) => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${escapeHtml(w.currency)})</option>`).join('')
      : `<option value="">${t("Créez un portefeuille d'abord")}</option>`;
  })();

  const modeSelect = modal.el.querySelector('#csv-map-amount-mode');
  const singleFields = modal.el.querySelector('#csv-map-single-fields');
  const debitCreditFields = modal.el.querySelector('#csv-map-debit-credit-fields');
  modeSelect.addEventListener('change', () => {
    const isDebitCredit = modeSelect.value === 'debitCredit';
    singleFields.hidden = isDebitCredit;
    debitCreditFields.hidden = !isDebitCredit;
  });

  modal.el.querySelector('#csv-mapping-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (!fd.get('walletId')) { showToast(t("Créez au moins un portefeuille avant d'importer.")); return; }
    const mapping = {
      walletId: fd.get('walletId'),
      dateCol: parseInt(fd.get('dateCol'), 10),
      noteCol: fd.get('noteCol') !== '' ? parseInt(fd.get('noteCol'), 10) : null,
      amountMode: fd.get('amountMode'),
      amountCol: parseInt(fd.get('amountCol'), 10),
      invertSign: fd.get('invertSign') === 'on',
      debitCol: parseInt(fd.get('debitCol'), 10),
      creditCol: parseInt(fd.get('creditCol'), 10),
    };
    try {
      const { imported, skipped, invalid } = await importGenericCsvRows(rows, mapping);
      modal.close();
      let message = t('{count} transaction(s) importée(s).', { count: imported });
      if (skipped) message += ' ' + t('{count} doublon(s) ignoré(s).', { count: skipped });
      if (invalid) message += ' ' + t('{count} ligne(s) invalide(s) ignorée(s) (date ou montant illisible — vérifiez le mapping des colonnes).', { count: invalid });
      showToast(message);
    } catch (err) {
      showToast(t('Erreur : {message}', { message: err.message || t('import impossible.') }));
    }
  });
}

function promptPassphrase(title) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <form id="passphrase-form">
        <div class="form-row"><label>${t('Mot de passe de la sauvegarde')}</label><input type="password" name="passphrase" required minlength="6" autofocus></div>
        <button type="submit" class="btn btn-primary btn-block">${t('Continuer')}</button>
      </form>`, { title, onClose: () => resolve(null) });
    modal.el.querySelector('#passphrase-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = new FormData(e.target).get('passphrase');
      // resolve() AVANT modal.close() : close() déclenche onClose() (=> resolve(null))
      // synchroniquement — appeler resolve(p) après serait un no-op (une promesse déjà
      // résolue ignore les résolutions suivantes), le mot de passe réel serait perdu. Bug
      // réel confirmé : l'export/import JSON chiffré ne fonctionnait jamais depuis ce menu.
      resolve(p);
      modal.close();
    });
  });
}

// Libellés traduits à l'usage via t(...) (voir renderSecuritySection ci-dessous et l'assistant de
// configuration dans app.js) — jamais ici, pour rester une simple table de données réutilisable.
export const AUTO_LOCK_OPTIONS = [[0, 'Jamais'], [1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [30, '30 minutes']];

async function renderSecuritySection(container) {
  const bioSupported = await isBiometricAvailable();
  const bioConfigured = await isBiometricConfigured();
  const autoLockMinutes = await getSetting('autoLockMinutes', 0);
  const privacyAutoHide = await getSetting('privacyAutoHide', false);

  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Sécurité')}</h3></div>
      <form id="pin-change-form" class="mb-18">
        <div class="form-row"><label>${t('Code PIN actuel')}</label><input type="password" name="oldPin" required minlength="4" maxlength="6" inputmode="numeric" pattern="\\d{4,6}"></div>
        <div class="form-row"><label>${t('Nouveau code PIN (4-6 chiffres)')}</label><input type="password" name="newPin" required minlength="4" maxlength="6" inputmode="numeric" pattern="\\d{4,6}"></div>
        <div class="form-row"><label>${t('Confirmer le nouveau code')}</label><input type="password" name="newPinConfirm" required minlength="4" maxlength="6" inputmode="numeric" pattern="\\d{4,6}"></div>
        <button type="submit" class="btn btn-primary">${t('Changer le code PIN')}</button>
      </form>
      <div class="stat-row">
        <span class="stat-row-label">${t('Déverrouillage biométrique')}</span>
        <span>
          ${!bioSupported ? `<span class="badge">${t('Non disponible sur cet appareil')}</span>` : `
            <span class="badge ${bioConfigured ? 'badge-pos' : ''}">${bioConfigured ? t('Activée') : t('Désactivée')}</span>
            <button type="button" class="btn btn-ghost ml-8" id="bio-toggle-btn">${bioConfigured ? t('Désactiver') : t('Activer')}</button>
          `}
        </span>
      </div>
      <label class="stat-row mt-10" style="cursor:pointer;">
        <span class="stat-row-label">${t("Mode discret : masquer les montants à chaque ouverture")}</span>
        <input type="checkbox" id="privacy-auto-hide" ${privacyAutoHide ? 'checked' : ''}>
      </label>
      <p class="fs-12 c-muted mt-4">${t("Les montants restent masqués jusqu'à ce que vous touchiez l'œil de la barre du haut : pratique dans les transports ou en public.")}</p>
      <div class="stat-row mt-10">
        <span class="stat-row-label">${t("Verrouillage automatique après inactivité")}</span>
        <select id="auto-lock-select" aria-label="${t('Verrouillage automatique après inactivité')}">${AUTO_LOCK_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === autoLockMinutes ? 'selected' : ''}>${t(l)}</option>`).join('')}</select>
      </div>
    </div>`;

  container.querySelector('#privacy-auto-hide').addEventListener('change', async (e) => {
    await setSetting('privacyAutoHide', e.target.checked);
    showToast(e.target.checked ? t('Mode discret activé : les montants seront masqués à chaque ouverture.') : t('Mode discret désactivé.'));
  });

  container.querySelector('#auto-lock-select').addEventListener('change', async (e) => {
    await setSetting('autoLockMinutes', parseInt(e.target.value, 10) || 0);
    showToast(t('Verrouillage automatique mis à jour.'));
  });

  container.querySelector('#pin-change-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('newPin') !== fd.get('newPinConfirm')) { showToast(t('Les nouveaux codes ne correspondent pas.')); return; }
    try {
      const { helperRemoved } = await changePin(fd.get('oldPin'), fd.get('newPin'));
      showToast(t('Code PIN modifié.'));
      if (helperRemoved) showToast(t("Le code aidant a été retiré (il doit avoir le même nombre de chiffres que votre code). Redéfinissez-en un si besoin."), { duration: 8000 });
      e.target.reset();
      renderHelperSection(document.getElementById('settings-helper'));
    } catch (err) {
      showToast(err.message || t('Erreur lors du changement de PIN.'));
    }
  });

  container.querySelector('#bio-toggle-btn')?.addEventListener('click', async () => {
    if (bioConfigured) {
      const ok = await confirmDialog(t('Désactiver le déverrouillage biométrique ?'));
      if (ok) { await removeBiometric(); showToast(t('Biométrie désactivée.')); renderSecuritySection(container); }
    } else {
      try {
        await registerBiometric();
        showToast(t('Biométrie activée.'));
        renderSecuritySection(container);
      } catch (err) {
        showToast(err.message || t("Échec de l'activation biométrique."));
      }
    }
  });
}

// Libellés traduits à l'usage via t(...) (voir renderProfileSection ci-dessous), jamais ici — même
// convention que AUTO_LOCK_OPTIONS.
export const PROFILE_FIELDS = [
  { key: 'lastName', label: 'Nom de famille', type: 'text' },
  { key: 'firstName', label: 'Prénom', type: 'text' },
  { key: 'phone', label: 'Numéro de téléphone', type: 'tel' },
  { key: 'address', label: 'Adresse', type: 'text' },
  { key: 'jobTitle', label: 'Fonction', type: 'text' },
];

async function renderProfileSection(container) {
  const profile = await getSetting('userProfile', {});
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Mon profil')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Informations personnelles utilisées pour personnaliser l'application (salutation sur le tableau de bord, en-tête des rapports PDF). Reste 100% local, jamais transmis.")}</p>
      <form id="profile-form">
        ${PROFILE_FIELDS.map((f) => `
          <div class="form-row">
            <label>${escapeHtml(t(f.label))}</label>
            <input type="${f.type}" name="${f.key}" maxlength="120" value="${escapeHtml(profile[f.key] || '')}">
          </div>`).join('')}
        <button type="submit" class="btn btn-primary">${t('Enregistrer le profil')}</button>
      </form>
    </div>`;

  container.querySelector('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const updated = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, (fd.get(f.key) || '').trim()]));
    await setSetting('userProfile', updated);
    showToast(t('Profil mis à jour.'));
    notifyDataChanged('settings');
  });
}

/** Langue de l'interface (FR/EN). setLanguage() recharge la page pour appliquer la traduction
    partout d'un coup, plutôt que de rendre chaque écran individuellement réactif à ce changement
    rare. */
async function renderLanguageSection(container) {
  const lang = getLanguage();
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>Langue / Language</h3></div>
      <div class="form-row" style="max-width:200px;">
        <select id="language-select" aria-label="Langue / Language">
          <option value="fr" ${lang === 'fr' ? 'selected' : ''}>Français</option>
          <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
        </select>
      </div>
    </div>`;

  container.querySelector('#language-select').addEventListener('change', async (e) => {
    await setLanguage(e.target.value);
  });
}

async function renderCurrencySection(container) {
  const baseCurrency = await getSetting('baseCurrency', 'EUR');
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Devise de base')}</h3></div>
      <p class="fs-13 c-muted mb-10">${t('Toutes les conversions (patrimoine net, rapports, outils) sont exprimées dans cette devise. La modifier réinitialise vos taux de change existants.')}</p>
      <div class="form-row" style="max-width:200px;">
        <select id="base-currency-select" aria-label="${t('Devise de base')}">${CURRENCIES.map((c) => `<option value="${c}" ${c === baseCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
    </div>`;

  container.querySelector('#base-currency-select').addEventListener('change', async (e) => {
    const newCurrency = e.target.value;
    const ok = await confirmDialog(t('Passer la devise de base à {currency} ? Vos taux de change existants seront réinitialisés à 1 et devront être ressaisis.', { currency: newCurrency }), { confirmText: t('Confirmer') });
    if (!ok) { e.target.value = baseCurrency; return; }
    if (newCurrency === baseCurrency) return;
    await changeBaseCurrency(newCurrency);
    showToast(t('Devise de base mise à jour.'));
    notifyDataChanged('all');
  });
}

/** Passe à une nouvelle devise de base. Les taux et leur historique sont exprimés dans l'ANCIENNE devise de base : on les repart
    de zéro. Chaque devise réellement utilisée (l'ancienne devise de base comprise, qui n'avait pas de ligne de taux) reçoit un
    taux 1:1 marqué « non confirmé », pour que l'alerte du tableau de bord et le panneau des taux invitent à le ressaisir au
    lieu de fausser le patrimoine en silence. Suppression des anciens taux et création des nouveaux dans une seule écriture. */
export async function changeBaseCurrency(newCurrency) {
  const oldCurrency = await getSetting('baseCurrency', 'EUR');
  const [rates, history, wallets, investments, debts, tontines, goals] = await Promise.all([
    dbGetAll(STORES.EXCHANGE_RATES), dbGetAll(STORES.EXCHANGE_RATE_HISTORY), dbGetAll(STORES.WALLETS),
    dbGetAll(STORES.INVESTMENTS), dbGetAll(STORES.DEBTS), dbGetAll(STORES.TONTINES), dbGetAll(STORES.SAVINGS_GOALS),
  ]);
  const used = new Set([...wallets, ...investments, ...debts, ...tontines, ...goals].map((x) => x.currency).filter(Boolean));
  used.delete(newCurrency);
  await setSetting('baseCurrency', newCurrency);
  await dbWriteBatch([
    ...rates.map((r) => ({ store: STORES.EXCHANGE_RATES, type: 'delete', value: r.code })),
    ...history.map((h) => ({ store: STORES.EXCHANGE_RATE_HISTORY, type: 'delete', value: h.id })),
    ...[...used].map((code) => ({ store: STORES.EXCHANGE_RATES, type: 'put', value: { code, rateToBase: 1, confirmed: false } })),
  ]);
  return { oldCurrency, newCurrency, unconfirmed: [...used] };
}

/** Importe un fichier ; s'il ne correspond plus à son empreinte (modifié ou abîmé depuis l'export), le dit et demande avant de
    continuer. Renvoie false si l'utilisateur a renoncé. Toute autre erreur est relancée à l'appelant. */
async function runImportWithIntegrityCheck(run) {
  try {
    await run(false);
  } catch (err) {
    if (err?.name !== 'BackupIntegrityError') throw err;
    const go = await confirmDialog(`${err.message} ${t('Importer quand même ?')}`, { danger: true, confirmText: t('Importer quand même') });
    if (!go) return false;
    await run(true);
  }
  return true;
}

async function renderBackupSection(container) {
  const lastBackupAt = await getSetting('lastBackupAt');
  const backupSnoozedUntil = await getSetting('backupSnoozedUntil');
  const lastBackupLabel = lastBackupAt ? formatDate(lastBackupAt) : t('jamais');
  const snoozedLabel = backupSnoozedUntil && Date.now() < new Date(backupSnoozedUntil).getTime()
    ? ' · ' + t("rappel mis en pause jusqu'au {date}", { date: formatDate(backupSnoozedUntil) })
    : '';
  const autoBackupDir = await getAutoBackupDirectory();

  // Taille attendue de la sauvegarde (et des photos qui en font l'essentiel) : un souci d'estimation
  // ne doit jamais empêcher d'ouvrir cette section, d'où le try/catch.
  let sizeHtml = '';
  try {
    const est = await estimateBackupSize();
    const badgeClass = est.level === 'critical' ? 'badge-neg' : est.level === 'warn' ? 'badge-warn' : 'badge-pos';
    const sizeAdvice = est.level === 'ok' ? '' : `<p style="font-size:12px;color:var(--${est.level === 'critical' ? 'neg' : 'text-muted'});margin:6px 0 0;">${
      est.level === 'critical'
        ? t("Sauvegarde très volumineuse : l'envoi peut être très long, voire échouer sur un téléphone. Réduisez les photos ci-dessous.")
        : t("Sauvegarde volumineuse : l'envoi peut être lent. Réduire les photos ci-dessous allège nettement la sauvegarde.")}</p>`;
    sizeHtml = `
      <div class="stat-row mt-6"><span class="stat-row-label">${t('Taille estimée de la sauvegarde')}</span><span class="badge ${badgeClass}">≈ ${formatBytes(est.estimatedBytes)}</span></div>
      <div class="stat-row mt-6"><span class="stat-row-label">${t('Photos de justificatifs')}</span><span>${est.photoCount} · ${formatBytes(est.photoStoredBytes)}</span></div>
      ${sizeAdvice}
      ${est.optimizableCount > 0 ? `
        <div class="mt-10">
          <button type="button" class="btn btn-ghost" id="optimize-receipts-btn" data-count="${est.optimizableCount}">${t('Réduire les photos ({count})', { count: est.optimizableCount })}</button>
          <p style="margin:6px 0 0;" class="fs-12 c-faint">${t("Réduit une fois pour toutes les photos déjà enregistrées (taille et qualité, lisibles). Irréversible : exportez d'abord une copie si vous voulez garder les originaux.")}</p>
        </div>` : ''}`;
  } catch { /* estimation indisponible : section affichée sans ces lignes */ }

  let autoBackupHtml;
  if (!isFileSystemAccessSupported()) {
    autoBackupHtml = `<span class="badge">${t('Non disponible sur ce navigateur (Chrome/Edge sur ordinateur uniquement)')}</span>`;
  } else if (autoBackupDir) {
    autoBackupHtml = `
      <span class="badge badge-pos">${t('Dossier : {name}', { name: escapeHtml(autoBackupDir.name) })}</span>
      <button type="button" class="btn btn-ghost ml-8" id="auto-backup-disable-btn">${t('Désactiver')}</button>`;
  } else {
    autoBackupHtml = `<button type="button" class="btn btn-ghost" id="auto-backup-choose-btn">${t('Choisir un dossier')}</button>`;
  }

  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Sauvegarde &amp; restauration')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Toutes vos données restent locales. Exportez régulièrement une copie (JSON complet ou CSV) pour éviter toute perte. Un rappel s'affiche automatiquement si aucune sauvegarde n'a été faite depuis 7 jours.")}</p>
      <div class="stat-row"><span class="stat-row-label">${t('Dernière sauvegarde')}</span><span>${lastBackupLabel}${snoozedLabel}</span></div>
      ${sizeHtml}
      <div class="stat-row mt-6"><span class="stat-row-label">${t('Sauvegarde automatique hebdomadaire')}</span><span>${autoBackupHtml}</span></div>
      <p style="margin:6px 0 0;" class="fs-12 c-faint">${t("Si un dossier est choisi, Djignan y écrit un export JSON automatiquement à chaque rappel hebdomadaire, sans action de votre part.")}</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;" class="mt-12">
        <button type="button" class="btn btn-primary" id="export-json-btn">${t('Exporter (JSON)')}</button>
        <button type="button" class="btn btn-ghost" id="import-json-btn">${t('Importer (JSON)')}</button>
        <button type="button" class="btn btn-ghost" id="export-encrypted-btn">${t('Exporter (JSON chiffré)')}</button>
        <button type="button" class="btn btn-ghost" id="import-encrypted-btn">${t('Importer (JSON chiffré)')}</button>
        <button type="button" class="btn btn-ghost" id="export-csv-btn">${t('Exporter des transactions (CSV)')}</button>
        <button type="button" class="btn btn-ghost" id="import-csv-btn">${t('Importer des transactions (CSV)')}</button>
      </div>
    </div>
    <div class="panel" style="border-color:var(--neg);">
      <div class="panel-header"><h3 class="c-neg">${t('Zone dangereuse')}</h3></div>
      <button type="button" class="btn btn-danger" id="wipe-data-btn">${t('Réinitialiser toutes les données')}</button>
    </div>`;

  container.querySelector('#auto-backup-choose-btn')?.addEventListener('click', async () => {
    try {
      await chooseAutoBackupDirectory();
      showToast(t('Dossier de sauvegarde automatique configuré.'));
      renderBackupSection(container);
    } catch (err) {
      if (err.name !== 'AbortError') showToast(t('Erreur : {message}', { message: err.message || t('sélection impossible.') }));
    }
  });
  container.querySelector('#auto-backup-disable-btn')?.addEventListener('click', async () => {
    await clearAutoBackupDirectory();
    showToast(t('Sauvegarde automatique désactivée.'));
    renderBackupSection(container);
  });

  container.querySelector('#optimize-receipts-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const count = Number(btn.dataset.count) || 0;
    const ok = await confirmDialog(
      t('Réduire {count} photo(s) de justificatifs ? La taille et la qualité seront diminuées (elles restent lisibles). Les originaux ne sont pas conservés.', { count }),
      { confirmText: t('Réduire les photos'), danger: true },
    );
    if (!ok) return;
    btn.disabled = true;
    try {
      const { optimized, savedBytes } = await optimizeStoredReceipts((done, total) => { btn.textContent = t('Réduction… {done}/{total}', { done, total }); });
      showToast(optimized > 0
        ? t('{count} photo(s) réduite(s), {size} économisés.', { count: optimized, size: formatBytes(savedBytes) })
        : t('Aucune photo à réduire.'));
    } catch (err) {
      showToast(t('Erreur : {message}', { message: err.message || t('réduction impossible.') }), { duration: 8000 });
    }
    renderBackupSection(container);
  });

  container.querySelector('#export-json-btn').addEventListener('click', async () => { await exportJsonBackup(); showToast(t('Sauvegarde JSON exportée.')); renderBackupSection(container); });

  container.querySelector('#import-json-btn').addEventListener('click', () => {
    hiddenFileInput('application/json', async (file) => {
      const merge = await confirmDialog(t('Fusionner avec les données existantes ? "Annuler" remplacera entièrement les données actuelles par celles du fichier.'), { confirmText: t('Fusionner'), cancelText: t('Remplacer tout') });
      if (!merge && !(await confirmReplaceAllData())) return;
      try {
        const done = await runImportWithIntegrityCheck((ignoreIntegrity) => importJsonBackup(file, { merge, ignoreIntegrity }));
        if (done) showToast(t('Import réussi.'));
      } catch (err) { showToast(t('Erreur : {message}', { message: err.message || t('fichier invalide.') })); }
    }).click();
  });

  container.querySelector('#export-encrypted-btn').addEventListener('click', async () => {
    const p1 = await promptPassphrase(t('Mot de passe de chiffrement'));
    if (!p1) return;
    try {
      await exportEncryptedBackup(p1);
      showToast(t('Sauvegarde chiffrée exportée.'));
    } catch (err) { // relecture de contrôle échouée (backup.js) : le fichier n'est pas proposé
      showToast(err.message || t('Erreur lors de la sauvegarde chiffrée.'), { duration: 9000 });
    }
    renderBackupSection(container);
  });

  container.querySelector('#import-encrypted-btn').addEventListener('click', () => {
    hiddenFileInput('application/json', async (file) => {
      const p = await promptPassphrase(t('Mot de passe de la sauvegarde'));
      if (!p) return;
      const merge = await confirmDialog(t('Fusionner avec les données existantes ?'), { confirmText: t('Fusionner'), cancelText: t('Remplacer tout') });
      if (!merge && !(await confirmReplaceAllData())) return;
      try {
        const done = await runImportWithIntegrityCheck((ignoreIntegrity) => importEncryptedBackup(file, p, { merge, ignoreIntegrity }));
        if (done) showToast(t('Import réussi.'));
      } catch (err) { showToast(t('Erreur : {message}', { message: err.message || t('fichier invalide.') })); }
    }).click();
  });

  container.querySelector('#export-csv-btn').addEventListener('click', async () => {
    await exportTransactionsCsv();
    showToast(t('Export CSV généré.'));
  });

  container.querySelector('#import-csv-btn').addEventListener('click', () => {
    hiddenFileInput('.csv,text/csv', async (file) => {
      try {
        const analysis = await analyzeTransactionsCsv(file);
        if (analysis.format === 'djignan') {
          const { imported, skipped } = await importDjignanCsvRows(analysis.rows);
          let message = t('{count} transaction(s) importée(s).', { count: imported });
          if (skipped) message += ' ' + t('{count} doublon(s) ignoré(s).', { count: skipped });
          showToast(message);
        } else {
          openCsvMappingModal(analysis);
        }
      } catch (err) { showToast(t('Erreur : {message}', { message: err.message || t('fichier invalide.') })); }
    }).click();
  });

  container.querySelector('#wipe-data-btn').addEventListener('click', async () => {
    const ok = await confirmDialog(t('Supprimer DÉFINITIVEMENT toutes les données de Djignan (portefeuilles, transactions, budgets, investissements, dettes…) ? Cette action est irréversible. Exportez une sauvegarde avant si besoin.'), { danger: true, confirmText: t('Tout supprimer') });
    if (!ok) return;
    // Dernière barrière : code PIN + texte affiché en clair à recopier (empêche un clic malheureux ou
    // une réinitialisation par quelqu'un qui a juste l'appareil déverrouillé entre les mains).
    const ok2 = await confirmDialog(t('Dernière confirmation : voulez-vous vraiment tout réinitialiser ?'), {
      danger: true, requirePin: true, typeToConfirm: t('SUPPRIMER TOUT'), confirmText: t('Oui, réinitialiser'),
    });
    if (!ok2) return;
    await wipeAllData();
    showToast(t('Toutes les données ont été réinitialisées.'));
    notifyDataChanged('all');
  });
}

async function renderNotificationsSection(container) {
  const supported = isNotificationSupported();
  const permission = getNotificationPermission();
  const thresholds = { ...BUDGET_ALERT_THRESHOLD_DEFAULTS, ...(await getSetting('budgetAlertThresholds', {})) };

  let statusHtml;
  if (!supported) {
    statusHtml = `<span class="badge">${t('Non supportées par ce navigateur')}</span>`;
  } else if (permission === 'granted') {
    statusHtml = `<span class="badge badge-pos">${t('Activées')}</span><button type="button" class="btn btn-ghost ml-8" id="notif-test-btn">${t('Tester')}</button>`;
  } else if (permission === 'denied') {
    statusHtml = `<span class="badge badge-neg">${t('Bloquées par le navigateur')}</span>`;
  } else {
    statusHtml = `<span class="badge">${t('Désactivées')}</span><button type="button" class="btn btn-primary ml-8" id="notif-enable-btn">${t('Activer')}</button>`;
  }

  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Notifications')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Rappels locaux pour vos échéances récurrentes proches (3 jours), vos dettes/créances arrivant à échéance (3 jours), vos budgets qui approchent leur limite et vos portefeuilles passant sous leur seuil d'alerte (réglable sur chaque portefeuille). Ces rappels s'affichent quand l'application est ouverte ou récemment réactivée — un envoi en arrière-plan app totalement fermée nécessiterait un serveur distant, ce qui irait à l'encontre du principe 100% local de Djignan.")}</p>
      <div class="stat-row"><span class="stat-row-label">${t('Statut')}</span><span>${statusHtml}</span></div>
      ${permission === 'denied' ? `<p class="fs-12 c-faint mt-8">${t('Vous avez bloqué les notifications pour ce site. Autorisez-les dans les paramètres de votre navigateur pour les réactiver.')}</p>` : ''}
      <div class="stat-row mt-10" style="align-items:center;">
        <span class="stat-row-label">${t("Seuils d'alerte budget")}</span>
        <span style="display:flex;align-items:center;gap:8px;">
          <input type="number" min="1" max="100" aria-label="${t("Seuil d'avertissement (%)")}" id="threshold-warn" value="${thresholds.warn}" style="width:60px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-alt);text-align:right;"> ${t('% avertissement')}
          <input type="number" min="1" max="100" aria-label="${t('Seuil critique (%)')}" id="threshold-danger" value="${thresholds.danger}" style="width:60px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface-alt);text-align:right;"> ${t('% dépassement')}
        </span>
      </div>
    </div>`;

  container.querySelector('#notif-enable-btn')?.addEventListener('click', async () => {
    const perm = await requestNotificationPermission();
    if (perm === 'granted') { showToast(t('Notifications activées.')); await checkAndNotify(); }
    else if (perm === 'denied') { showToast(t('Notifications refusées.')); }
    renderNotificationsSection(container);
  });

  container.querySelector('#notif-test-btn')?.addEventListener('click', async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body: t('Voici à quoi ressemblera un rappel.'), icon: 'icons/icon-192.png' };
    if (reg?.showNotification) await reg.showNotification('Djignan', opts);
    else new Notification('Djignan', opts);
  });

  const saveThresholds = async () => {
    const warn = parseInt(container.querySelector('#threshold-warn').value, 10) || BUDGET_ALERT_THRESHOLD_DEFAULTS.warn;
    const danger = parseInt(container.querySelector('#threshold-danger').value, 10) || BUDGET_ALERT_THRESHOLD_DEFAULTS.danger;
    if (warn >= danger) { showToast(t("Le seuil d'avertissement doit être inférieur au seuil de dépassement.")); return; }
    await setSetting('budgetAlertThresholds', { warn, danger });
    showToast(t('Seuils mis à jour.'));
  };
  container.querySelector('#threshold-warn')?.addEventListener('change', saveThresholds);
  container.querySelector('#threshold-danger')?.addEventListener('change', saveThresholds);
}

async function renderInstallSection(container) {
  const standalone = isStandalone();
  const iosSafari = isIOS() && isSafari();
  const iosOther = isIOS() && !isSafari();
  const androidLike = isAndroid() && !isIOS();

  let statusHtml, extraHtml = '';
  if (standalone) {
    statusHtml = `<span class="badge badge-pos">${t('Déjà installée')}</span>`;
  } else if (hasDeferredPrompt()) {
    statusHtml = `<span class="badge badge-pos">${t('Disponible')}</span><button type="button" class="btn btn-primary ml-8" id="install-now-btn">${t('Installer maintenant')}</button>`;
  } else if (iosSafari) {
    statusHtml = `<span class="badge">${t('Installation manuelle')}</span>`;
    extraHtml = `<p class="fs-13 c-muted mt-10">${t('Appuyez sur <strong>Partager</strong>, puis <strong>« Sur l\'écran d\'accueil »</strong>.')}</p>`;
  } else if (iosOther) {
    statusHtml = `<span class="badge">${t('Non disponible dans ce navigateur')}</span>`;
    extraHtml = `<p class="fs-13 c-muted mt-10">${t('Sur iPhone/iPad, l\'installation n\'est possible que depuis <strong>Safari</strong> (restriction Apple). Ouvrez ce site dans Safari, puis Partager → « Sur l\'écran d\'accueil ».')}</p>`;
  } else if (androidLike) {
    statusHtml = `<span class="badge">${t('Pas encore proposée')}</span>`;
    extraHtml = `<p class="fs-13 c-muted mt-10">${t('Ouvrez le menu ⋮ de votre navigateur et choisissez « Installer l\'application » ou « Ajouter à l\'écran d\'accueil ».')}</p>`;
  } else {
    statusHtml = `<span class="badge">${t('Pas encore proposée')}</span>`;
    extraHtml = `<p class="fs-13 c-muted mt-10">${t('Cherchez une icône d\'installation dans la barre d\'adresse, ou le menu du navigateur → « Installer Djignan ».')}</p>`;
  }

  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Installation')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Installez Djignan sur cet appareil pour un accès direct depuis l'écran d'accueil, en plein écran et 100% hors-ligne.")}</p>
      <div class="stat-row"><span class="stat-row-label">${t('Statut')}</span><span>${statusHtml}</span></div>
      ${extraHtml}
      ${!standalone ? `<button type="button" class="btn btn-ghost mt-12" id="reset-install-snooze-btn">${t('Réafficher le rappel automatique')}</button>` : ''}
    </div>`;

  container.querySelector('#install-now-btn')?.addEventListener('click', async () => {
    const outcome = await triggerInstall();
    if (outcome === 'accepted') showToast(t('Application installée !'));
    else if (outcome === 'dismissed') showToast(t('Installation annulée.'));
    renderInstallSection(container);
  });

  container.querySelector('#reset-install-snooze-btn')?.addEventListener('click', async () => {
    await resetInstallPromptSnooze();
    showToast(t("Le rappel d'installation réapparaîtra à la prochaine ouverture (si votre navigateur le propose)."));
  });
}

async function renderUpdateSection(container) {
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Mise à jour')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Djignan fonctionne hors-ligne grâce à une copie locale de l'application. Vérifiez ici si une nouvelle version a été publiée : seul le code de l'application est remplacé, vos données (portefeuilles, transactions, budgets…) restent intactes.")}</p>
      <div class="stat-row"><span class="stat-row-label">${t('Statut')}</span><span id="update-status"><span class="badge">${t('Non vérifié')}</span></span></div>
      <button type="button" class="btn btn-primary mt-12" id="check-update-btn">${t('Vérifier les mises à jour')}</button>
    </div>`;

  const statusEl = container.querySelector('#update-status');
  const btn = container.querySelector('#check-update-btn');

  btn.addEventListener('click', async () => {
    if (!('serviceWorker' in navigator)) {
      showToast(t('Mises à jour automatiques non supportées par ce navigateur.'));
      return;
    }
    btn.disabled = true;
    btn.textContent = t('Vérification…');
    statusEl.innerHTML = `<span class="badge">${t('Vérification…')}</span>`;

    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        statusEl.innerHTML = `<span class="badge">${t('Aucune installation hors-ligne active')}</span>`;
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
        statusEl.innerHTML = `<span class="badge badge-pos">${t('Nouvelle version installée')}</span>`;
        showToast(t('Nouvelle version installée, rechargement…'));
        window.location.reload();
        return;
      }
      statusEl.innerHTML = `<span class="badge badge-pos">${t('Version à jour')}</span>`;
      showToast(t('Vous utilisez déjà la dernière version.'));
    } catch (err) {
      statusEl.innerHTML = `<span class="badge badge-neg">${t('Échec de la vérification')}</span>`;
      showToast(t('Erreur : {message}', { message: err.message || t('vérification impossible.') }));
    } finally {
      btn.disabled = false;
      btn.textContent = t('Vérifier les mises à jour');
    }
  });
}

// Libellés traduits à l'usage via t(...) (voir renderDashboardConfigSection ci-dessous et
// l'assistant de configuration dans app.js), jamais ici — même convention que AUTO_LOCK_OPTIONS.
export const DASHBOARD_PANEL_LABELS = {
  watchCategories: 'Catégories à surveiller',
  upcomingBills: 'Prochaines échéances',
  charts: 'Graphiques',
  recentTransactions: 'Transactions récentes',
  safeToSpend: 'Reste à vivre',
  netWorth: 'Patrimoine net global',
  debtsBalance: 'Solde créances & dettes',
  favorites: 'Favoris',
  forecast: 'Prévision de trésorerie',
  recap: 'Bilan du mois',
};

/** Modules optionnels de l'app : masqués par défaut, activables ici ou pendant l'onboarding
    (app.js). Liste volontairement conçue pour grandir — ajouter un module futur ne demande
    qu'une entrée ici, ni renderFeaturesSection() ni le pas "modules" de l'onboarding n'ont à
    changer. navId est optionnel (bouton de nav à masquer/afficher quand le module n'en a pas). */
// label/description traduits à l'usage via t(...) (renderFeaturesSection ci-dessous et l'assistant
// de configuration dans app.js), jamais ici — même convention que AUTO_LOCK_OPTIONS.
export const OPTIONAL_MODULES = [
  {
    key: 'keptAccountsEnabled',
    label: 'Comptes gardés',
    description: "Ajoute un onglet dédié pour suivre l'argent d'un proche que vous gérez (petit frère, conjointe, mère…), totalement séparé de vos portefeuilles et de votre patrimoine net.",
    navId: 'nav-kept-accounts',
    view: 'keptAccounts',
  },
  {
    key: 'tontinesEnabled',
    // Visible dès l'installation (désactivable ici) : une fonction cachée derrière un réglage n'est
    // jamais découverte — signalé par l'auteur qui ne trouvait pas l'onglet.
    defaultEnabled: true,
    label: 'Tontines',
    description: "Ajoute un onglet pour suivre une tontine (cotisation) : qui a payé ce tour, qui reçoit le pot, et vos propres versements, enregistrés dans votre portefeuille. L'appli ne manipule aucun argent.",
    navId: 'nav-tontines',
    view: 'tontines',
  },
];

export async function applyOptionalModuleVisibility() {
  for (const mod of OPTIONAL_MODULES) {
    if (!mod.navId) continue;
    const navBtn = document.getElementById(mod.navId);
    if (navBtn) navBtn.hidden = !(await getSetting(mod.key, !!mod.defaultEnabled));
  }
}

async function renderFeaturesSection(container) {
  const states = await Promise.all(OPTIONAL_MODULES.map((mod) => getSetting(mod.key, !!mod.defaultEnabled)));
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Fonctionnalités optionnelles')}</h3></div>
      ${OPTIONAL_MODULES.map((mod, i) => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;" class="fs-14">
          <input type="checkbox" data-module-key="${mod.key}" ${states[i] ? 'checked' : ''}>
          ${escapeHtml(t(mod.label))}
        </label>
        <p style="margin:2px 0 10px;" class="fs-13 c-muted">${escapeHtml(t(mod.description))}</p>`).join('')}
    </div>`;

  container.querySelectorAll('[data-module-key]').forEach((input) => {
    input.addEventListener('change', async (e) => {
      await setSetting(input.dataset.moduleKey, e.target.checked);
      await applyOptionalModuleVisibility();
      showToast(t('Fonctionnalité mise à jour.'));
    });
  });
}

/** Rappels planifiés : uniquement dans l'APK Android (plugin de notifications locales) — voir
    native-reminders.js. Dans la PWA et l'exécutable, la section n'apparaît pas. */
async function renderNativeRemindersSection(container) {
  // Hors de l'APK, la section reste VISIBLE et dit comment obtenir la fonction (une section masquée ne se
  // découvre jamais).
  if (!isNativeReminderSupported()) {
    container.innerHTML = `
      <div class="panel mb-16">
        <div class="panel-header"><h3>${t('Rappels planifiés')}</h3></div>
        <p class="fs-13 c-muted m-0">${t("Rappel la veille et le jour même (9 h) des factures, échéances de dettes et cotisations de tontine, même appli fermée. Disponible dans l'application Android (APK) : une page web ne peut pas programmer de notification sans serveur. Ici, les rappels s'affichent à l'ouverture de l'appli.")}</p>
      </div>`;
    return;
  }
  const enabled = await getSetting('nativeRemindersEnabled', false);
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Rappels planifiés')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Recevez un rappel la veille et le jour même (9 h) des factures, échéances de dettes et créances, et cotisations de tontine — même appli fermée. Rien n'est envoyé : c'est le téléphone qui les programme.")}</p>
      <button type="button" class="btn ${enabled ? 'btn-ghost' : 'btn-primary'}" id="native-reminders-btn">${enabled ? t('Désactiver les rappels planifiés') : t('Activer les rappels planifiés')}</button>
    </div>`;
  container.querySelector('#native-reminders-btn').addEventListener('click', async () => {
    try {
      if (enabled) { await disableNativeReminders(); showToast(t('Rappels planifiés désactivés.')); }
      else { const n = await enableNativeReminders(); showToast(t('{count} rappel(s) programmé(s).', { count: n })); }
    } catch (err) {
      showToast(err.message || t('Opération impossible.'));
    }
    await renderNativeRemindersSection(container);
  });
}

async function renderUiModeSection(container) {
  const mode = await getUiMode();
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t("Mode d'affichage")}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Simple : entrées, sorties, solde, favoris, dettes et créances — comme un cahier. Complet : toutes les fonctions (budgets, épargne, investissements, rapports, outils…).")}</p>
      <div class="segmented" id="ui-mode-segmented">
        <button type="button" class="segmented-btn ${mode === 'simple' ? 'is-active' : ''}" data-mode="simple">${t('Simple')}</button>
        <button type="button" class="segmented-btn ${mode === 'full' ? 'is-active' : ''}" data-mode="full">${t('Complet')}</button>
      </div>
    </div>`;
  container.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await setUiMode(btn.dataset.mode);
      container.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('is-active', b === btn));
      showToast(t('Mode d\'affichage mis à jour.'));
    });
  });
}

/** Code aidant (auth.js, db.js) : un proche tient le cahier sans pouvoir rien supprimer ni régler. */
async function renderHelperSection(container) {
  if (!container) return;
  const configured = await isHelperConfigured();
  const length = await getPinLength();
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Code aidant')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Pour qu'un proche tienne votre cahier à votre place : il ouvre l'appli avec son propre code, voit tout et peut ajouter des opérations, mais ne peut rien supprimer, restaurer ni réinitialiser, ni toucher aux réglages. Ce qu'il saisit vous est signalé à votre prochaine visite.")}</p>
      <p class="fs-12 c-muted mb-12">${t("C'est une protection contre les erreurs et l'usage ordinaire, pas un coffre-fort : toutes les données restent sur cet appareil.")}</p>
      <p class="fs-14 mb-12"><strong>${configured ? t('Un code aidant est défini.') : t("Aucun code aidant n'est défini.")}</strong></p>
      <form id="helper-form">
        <div class="form-row"><label for="helper-code">${t('Code aidant ({n} chiffres)', { n: length })}</label>
          <input type="password" id="helper-code" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="${length}" autocomplete="off" required></div>
        <div class="form-row"><label for="helper-code2">${t('Confirmer le code aidant')}</label>
          <input type="password" id="helper-code2" name="code2" inputmode="numeric" pattern="[0-9]*" maxlength="${length}" autocomplete="off" required></div>
        <div class="form-row"><label for="helper-owner-pin">${t('Votre code PIN (pour autoriser)')}</label>
          <input type="password" id="helper-owner-pin" name="ownerPin" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" required></div>
        <button type="submit" class="btn btn-primary">${configured ? t('Changer le code aidant') : t('Définir le code aidant')}</button>
        ${configured ? `<button type="button" class="btn btn-ghost" id="helper-remove-btn">${t('Retirer le code aidant')}</button>` : ''}
      </form>
    </div>`;
  container.querySelector('#helper-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('code') !== fd.get('code2')) { showToast(t('Les codes ne correspondent pas.')); return; }
    try {
      await setupHelperPin(String(fd.get('code')), String(fd.get('ownerPin')));
      showToast(t('Code aidant enregistré.'));
      renderHelperSection(container);
    } catch (err) {
      showToast(err.message || t('Erreur lors de la définition du code aidant.'));
    }
  });
  container.querySelector('#helper-remove-btn')?.addEventListener('click', async () => {
    if (!(await confirmDialog(t("Retirer le code aidant ? Votre proche ne pourra plus ouvrir l'appli."), { danger: true, requirePin: true, confirmText: t('Retirer') }))) return;
    await removeHelperPin();
    showToast(t('Code aidant retiré.'));
    renderHelperSection(container);
  });
}

/** Vérification de la sauvegarde (backup-verify.js) : à la demande, et automatique une fois par mois. */
async function renderBackupCheckSection(container) {
  if (!container) return;
  const last = await getLastBackupVerification();
  const when = last ? formatDate(localISODate(new Date(last.at))) : '';
  const status = !last
    ? `<p class="fs-14 mb-12">${t("Votre sauvegarde n'a pas encore été vérifiée.")}</p>`
    : last.ok
      ? `<p class="fs-14 mb-12">${t('Vérifiée le {date} : {rows} lignes relues sans écart, la restauration serait acceptée.', { date: when, rows: last.rows })}</p>`
      : `<p class="fs-14 c-neg mb-12"><strong>${t('Vérifiée le {date} : problème trouvé.', { date: when })}</strong></p>
         <ul class="fs-13 mb-12">${(last.issues || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Vérifier ma sauvegarde')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Simule une sauvegarde puis sa restauration, sans rien modifier, et compare avec vos données : nombre de lignes de chaque table et total des transactions. Fait aussi automatiquement une fois par mois.")}</p>
      ${status}
      <button type="button" class="btn btn-primary" id="backup-verify-btn">${t('Vérifier maintenant')}</button>
    </div>`;
  container.querySelector('#backup-verify-btn').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = t('Vérification en cours…');
    const result = await verifyBackup();
    showToast(result.ok ? t('Sauvegarde vérifiée : aucun écart.') : t('Problème trouvé : voir le détail dans Paramètres.'), { duration: 6000 });
    renderBackupCheckSection(container);
  });
}

/** Accueil facile (gros boutons, images) et lecture à voix haute — voir easy-home.js et speech-out.js. */
async function renderEasyHomeSection(container) {
  const [easyOn, speakOn] = await Promise.all([isEasyHomeEnabled(), getSetting('speakConfirmations', false)]);
  const speechOk = isSpeechSupported();
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Accueil facile et voix')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t("Pour qui lit peu : un accueil à quatre grosses touches avec des images, une saisie guidée sans clavier, et l'appli qui lit à voix haute.")}</p>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;" class="fs-14">
        <input type="checkbox" id="easy-home-toggle" ${easyOn ? 'checked' : ''}>
        ${escapeHtml(t('Accueil facile (gros boutons et images)'))}
      </label>
      <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:${speechOk ? 'pointer' : 'default'};" class="fs-14">
        <input type="checkbox" id="speak-confirmations-toggle" ${speakOn && speechOk ? 'checked' : ''} ${speechOk ? '' : 'disabled'}>
        ${escapeHtml(t("Lire à voix haute le solde après chaque enregistrement"))}
      </label>
      ${speechOk
        ? `<button type="button" class="btn btn-ghost mt-8" id="speech-test-btn">${t('Tester la voix')}</button>
           <p class="fs-12 c-muted mt-8">${t("La voix vient de votre téléphone ou ordinateur. Si vous n'entendez rien, vérifiez le volume et qu'une voix est installée dans les réglages du système.")}</p>`
        : `<p class="fs-12 c-muted mt-8">${t("La lecture à voix haute n'est pas disponible sur cet appareil.")}</p>`}
    </div>`;
  container.querySelector('#easy-home-toggle').addEventListener('change', async (e) => {
    await setEasyHome(e.target.checked);
    showToast(e.target.checked ? t('Accueil facile activé.') : t('Accueil facile désactivé.'));
  });
  container.querySelector('#speak-confirmations-toggle').addEventListener('change', async (e) => {
    await setSetting('speakConfirmations', e.target.checked);
    showToast(t('Réglage enregistré.'));
  });
  container.querySelector('#speech-test-btn')?.addEventListener('click', async () => {
    primeSpeech();
    const spoken = await speak(t("Bonjour. Ceci est un essai de la voix de l'application."));
    if (!spoken) showToast(t("Aucune voix n'est installée sur cet appareil : le texte reste affiché."));
  });
}

async function renderDashboardConfigSection(container) {
  const panels = { ...DASHBOARD_PANEL_DEFAULTS, ...(await getSetting('dashboardPanels', {})) };

  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${t('Tableau de bord')}</h3></div>
      <p class="fs-13 c-muted mb-12">${t('Choisissez les panneaux affichés sur le tableau de bord (la carte « Budget mensuel alloué » et les 4 chiffres du mois restent toujours visibles).')}</p>
      ${Object.entries(DASHBOARD_PANEL_LABELS).map(([key, label]) => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 0;cursor:pointer;" class="fs-14">
          <input type="checkbox" data-panel-key="${key}" ${panels[key] ? 'checked' : ''}>
          ${escapeHtml(t(label))}
        </label>`).join('')}
    </div>`;

  container.querySelectorAll('[data-panel-key]').forEach((input) => {
    input.addEventListener('change', async () => {
      const current = { ...DASHBOARD_PANEL_DEFAULTS, ...(await getSetting('dashboardPanels', {})) };
      current[input.dataset.panelKey] = input.checked;
      await setSetting('dashboardPanels', current);
      showToast(t('Tableau de bord mis à jour.'));
    });
  });
}

// Coordonnées affichées dans « À propos du développeur » (Paramètres) et dans le crédit de la
// barre latérale (index.html, mis à jour séparément — statique, pas piloté par ce fichier).
// Téléphone volontairement absent pour l'instant (non fourni) : ajouter une ligne
// stat-row supplémentaire ici (Téléphone / DEVELOPER_PHONE, lien tel:) le jour où il l'est.
const DEVELOPER_NAME = 'Bibiê Adtcheko';
const DEVELOPER_EMAIL = 'ronywest01@gmail.com';

function renderDeveloperSection(container) {
  container.innerHTML = `
    <div class="panel mt-16">
      <div class="panel-header"><h3>${t('À propos du développeur')}</h3></div>
      <div class="stat-row"><span class="stat-row-label">${t('Nom')}</span><span>${escapeHtml(DEVELOPER_NAME)}</span></div>
      <div class="stat-row"><span class="stat-row-label">${t('Email')}</span><a href="mailto:${DEVELOPER_EMAIL}" style="color:var(--accent);">${escapeHtml(DEVELOPER_EMAIL)}</a></div>
    </div>`;
}

export async function renderSettings() {
  const container = document.getElementById('settings-content');
  if (!container) return;
  // Un aidant (code aidant, auth.js) n'a accès à aucun réglage : on le lui explique au lieu de lui montrer des boutons refusés.
  if (appState.role === 'helper') {
    container.innerHTML = `
      <div class="panel">
        <div class="panel-header"><h3>${t('Réglages réservés au propriétaire')}</h3></div>
        <p class="fs-14">${t("Vous êtes connecté avec le code aidant : vous pouvez consulter vos comptes et ajouter des opérations. Les réglages, les sauvegardes et les suppressions sont réservés au propriétaire.")}</p>
      </div>`;
    return;
  }
  container.innerHTML = '<div id="settings-profile"></div><div id="settings-uimode"></div><div id="settings-easy"></div><div id="settings-security"></div><div id="settings-helper"></div><div id="settings-notifications"></div><div id="settings-native-reminders"></div><div id="settings-install"></div><div id="settings-update"></div><div id="settings-dashboard"></div><div id="settings-features"></div><div id="settings-language"></div><div id="settings-currency"></div><div id="settings-backup-check"></div><div id="settings-backup"></div><div id="settings-cloud-backup"></div><div id="settings-developer"></div>';
  await renderProfileSection(document.getElementById('settings-profile'));
  await renderUiModeSection(document.getElementById('settings-uimode'));
  await renderEasyHomeSection(document.getElementById('settings-easy'));
  await renderSecuritySection(document.getElementById('settings-security'));
  await renderHelperSection(document.getElementById('settings-helper'));
  await renderNotificationsSection(document.getElementById('settings-notifications'));
  await renderNativeRemindersSection(document.getElementById('settings-native-reminders'));
  await renderInstallSection(document.getElementById('settings-install'));
  await renderUpdateSection(document.getElementById('settings-update'));
  await renderDashboardConfigSection(document.getElementById('settings-dashboard'));
  await renderFeaturesSection(document.getElementById('settings-features'));
  await renderLanguageSection(document.getElementById('settings-language'));
  await renderCurrencySection(document.getElementById('settings-currency'));
  await renderBackupSection(document.getElementById('settings-backup'));
  await renderBackupCheckSection(document.getElementById('settings-backup-check'));
  await renderCloudBackupSection(document.getElementById('settings-cloud-backup'));
  renderDeveloperSection(document.getElementById('settings-developer'));
}

export function initSettingsModule() {}
