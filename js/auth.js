/* ==========================================================================
   Djignan Financial System — Sécurité locale (PIN + biométrie WebAuthn)
   Le code PIN n'est jamais stocké en clair : dérivation PBKDF2-SHA256 avec
   sel aléatoire (Web Crypto). La biométrie utilise l'authenticator de
   plateforme (Windows Hello / Touch ID / empreinte Android) via WebAuthn,
   avec vérification de signature ECDSA P-256 entièrement locale (aucun
   serveur "relying party" distant n'est requis).
   ========================================================================== */

import { getSetting, setSetting, logAudit } from './db.js';
import { t } from './i18n.js';
import { icon as svgIcon } from './icons.js';

const PBKDF2_ITERATIONS = 150000;
const MAX_ATTEMPTS_BEFORE_THROTTLE = 5;
const THROTTLE_MS = 30000;

/* ---------- Utilitaires binaires ---------- */
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
function concatBuffers(...bufs) {
  const total = bufs.reduce((sum, b) => sum + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of bufs) { out.set(new Uint8Array(b), offset); offset += b.byteLength; }
  return out.buffer;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- Hachage PIN (PBKDF2-SHA256) ---------- */
async function derivePinHash(pin, saltBuf, iterations = PBKDF2_ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuf, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bits;
}

export async function isPinConfigured() {
  return !!(await getSetting('pinHash'));
}

export async function setupPin(pin) {
  if (!/^\d{4,6}$/.test(pin)) throw new Error(t('Le PIN doit contenir entre 4 et 6 chiffres.'));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(pin, salt);
  await setSetting('pinSalt', bufToBase64(salt));
  await setSetting('pinHash', bufToBase64(hash));
  await setSetting('pinIterations', PBKDF2_ITERATIONS);
  await setSetting('pinLength', pin.length);
  await setSetting('failedAttempts', 0);
  await logAudit({ entityType: 'security', entityId: 'pin', action: 'setup', note: t('Code PIN configuré') });
}

export async function getPinLength() {
  return getSetting('pinLength', 6);
}

/** Compare un code au hachage enregistré sous `prefix` (« pin » = propriétaire, « helperPin » = aidant : clés
    pinSalt/pinHash/pinIterations, helperPinSalt/helperPinHash/helperPinIterations). Ne touche à aucun compteur. */
async function codeMatches(prefix, code) {
  const saltB64 = await getSetting(`${prefix}Salt`);
  const hashB64 = await getSetting(`${prefix}Hash`);
  const iterations = await getSetting(`${prefix}Iterations`, PBKDF2_ITERATIONS);
  if (!saltB64 || !hashB64) return false;
  const candidate = await derivePinHash(code, base64ToBuf(saltB64), iterations);
  return timingSafeEqual(new Uint8Array(candidate), new Uint8Array(base64ToBuf(hashB64)));
}

/* ---------- Journal des codes ratés ----------
   Chaque code faux (au déverrouillage ou avant une action sensible) est daté dans un journal propre à l'appareil, gardé à 30
   entrées. Au déverrouillage suivant du propriétaire : « 3 codes ratés depuis votre dernière visite » (consumeUnlockReport).
   Quelqu'un qui a tenté d'ouvrir le téléphone devient visible au lieu de rester silencieux. */
const FAILURE_LOG_MAX = 30;
async function logPinFailure() {
  const log = await getSetting('pinFailureLog', []);
  const list = Array.isArray(log) ? log : [];
  list.push(Date.now());
  await setSetting('pinFailureLog', list.slice(-FAILURE_LOG_MAX));
}

/** À appeler à chaque déverrouillage du PROPRIÉTAIRE (jamais de l'aidant, sinon il effacerait ce que le propriétaire doit
    voir). Renvoie les codes ratés depuis sa dernière visite, puis date cette visite. Première visite : rien à signaler. */
export async function consumeUnlockReport(now = Date.now()) {
  const since = Number(await getSetting('lastUnlockAt', 0)) || 0;
  const log = await getSetting('pinFailureLog', []);
  await setSetting('lastUnlockAt', now);
  if (!since) return { since: 0, failures: 0, lastFailureAt: null };
  const recent = (Array.isArray(log) ? log : []).filter((ts) => ts > since && ts <= now);
  return { since, failures: recent.length, lastFailureAt: recent.length ? Math.max(...recent) : null };
}

/** Les fautes de frappe du propriétaire juste AVANT sa réussite (dans la dernière minute) ne sont pas une intrusion : on les retire du
    journal, sinon « 1 code incorrect pendant votre absence » s'afficherait à chaque coquille suivie du bon code. */
const OWN_TYPO_WINDOW_MS = 60 * 1000;
async function forgetRecentFailures(now = Date.now()) {
  const log = await getSetting('pinFailureLog', []);
  if (!Array.isArray(log) || !log.length) return;
  const kept = log.filter((ts) => ts < now - OWN_TYPO_WINDOW_MS);
  if (kept.length !== log.length) await setSetting('pinFailureLog', kept);
}

export async function verifyPin(pin) {
  if (!(await getSetting('pinSalt')) || !(await getSetting('pinHash'))) return false;
  const ok = await codeMatches('pin', pin);
  await setSetting('failedAttempts', ok ? 0 : (await getSetting('failedAttempts', 0)) + 1);
  if (ok) await forgetRecentFailures(); else await logPinFailure();
  return ok;
}

/** Déverrouillage : renvoie 'owner' (code du propriétaire), 'helper' (code aidant) ou null (aucun des deux). Un code faux
    compte UNE tentative, qu'un code aidant existe ou non (même blocage anti-brute-force). */
export async function verifyAccessCode(code) {
  if (await codeMatches('pin', code)) { await setSetting('failedAttempts', 0); await forgetRecentFailures(); return 'owner'; }
  // Le code aidant ne remet PAS le compteur d'échecs à zéro : sinon quelqu'un qui le connaît pourrait deviner le code du propriétaire
  // par séries de 4 essais en repassant par le code aidant entre deux séries (le blocage anti-brute-force ne se déclencherait jamais).
  if (await isHelperConfigured() && await codeMatches('helperPin', code)) return 'helper';
  if (!(await getSetting('pinSalt'))) return null; // aucun code configuré : rien à compter
  await setSetting('failedAttempts', (await getSetting('failedAttempts', 0)) + 1);
  await logPinFailure();
  return null;
}

/* ---------- Code aidant ---------- */
export async function isHelperConfigured() {
  return !!(await getSetting('helperPinHash'));
}

/** Définit (ou remplace) le code de l'aidant. Exige le code du propriétaire. Le code aidant a le même nombre de chiffres que celui du
    propriétaire (l'écran de verrouillage valide tout seul à cette longueur) et doit être différent. Lève une Error au message affichable. */
export async function setupHelperPin(code, ownerPin) {
  const { ok, waitSeconds } = await verifyPinForAction(ownerPin);
  if (!ok) throw new Error(waitSeconds > 0 ? t('Trop de tentatives. Réessayez dans {s}s.', { s: waitSeconds }) : t('Code PIN incorrect.'));
  const length = await getPinLength();
  if (!/^\d{4,6}$/.test(code) || code.length !== length) throw new Error(t('Le code aidant doit avoir {n} chiffres, comme votre code.', { n: length }));
  if (await codeMatches('pin', code)) throw new Error(t('Le code aidant doit être différent du vôtre.'));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePinHash(code, salt);
  await setSetting('helperPinSalt', bufToBase64(salt));
  await setSetting('helperPinHash', bufToBase64(hash));
  await setSetting('helperPinIterations', PBKDF2_ITERATIONS);
  await setSetting('helperPinLength', code.length);
  await logAudit({ entityType: 'security', entityId: 'helper-pin', action: 'setup', note: t('Code aidant défini') });
}

export async function removeHelperPin() {
  for (const key of ['helperPinSalt', 'helperPinHash', 'helperPinIterations', 'helperPinLength']) await setSetting(key, null);
  await logAudit({ entityType: 'security', entityId: 'helper-pin', action: 'remove', note: t('Code aidant retiré') });
}

/** Vérifie le PIN pour une action sensible (suppression, réinitialisation) en réutilisant le même
    blocage anti-brute-force que l'écran de verrouillage (réglages pinThrottledUntil / failedAttempts,
    persistés : recharger la page ne le remet pas à zéro). */
export async function verifyPinForAction(pin) {
  const until = await getSetting('pinThrottledUntil', 0);
  if (Date.now() < until) return { ok: false, waitSeconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) };
  const ok = await verifyPin(pin);
  if (ok) {
    await setSetting('pinThrottledUntil', 0);
    return { ok: true, waitSeconds: 0 };
  }
  const attempts = await getSetting('failedAttempts', 0);
  if (attempts >= MAX_ATTEMPTS_BEFORE_THROTTLE) {
    await setSetting('pinThrottledUntil', Date.now() + THROTTLE_MS);
    return { ok: false, waitSeconds: Math.ceil(THROTTLE_MS / 1000) };
  }
  return { ok: false, waitSeconds: 0 };
}

export async function changePin(oldPin, newPin) {
  // Même blocage anti-brute-force que l'écran de verrouillage : sans lui, quelqu'un qui tient le téléphone
  // déverrouillé pouvait essayer tous les codes à la suite depuis « Changer le code PIN ».
  const { ok, waitSeconds } = await verifyPinForAction(oldPin);
  if (!ok) throw new Error(waitSeconds > 0 ? t('Trop de tentatives. Réessayez dans {s}s.', { s: waitSeconds }) : t('Ancien code PIN incorrect.'));
  await setupPin(newPin);
  // Le code aidant doit rester de même longueur que le nôtre et différent : sinon l'écran de verrouillage ne pourrait plus
  // l'accepter (ou, pire, les deux codes seraient identiques). On le retire plutôt que de le laisser inutilisable.
  let helperRemoved = false;
  if (await isHelperConfigured()) {
    const sameLength = (await getSetting('helperPinLength', 0)) === newPin.length;
    if (!sameLength || await codeMatches('helperPin', newPin)) { await removeHelperPin(); helperRemoved = true; }
  }
  return { helperRemoved };
}

/* ---------- Biométrie (WebAuthn, authenticator de plateforme) ---------- */
export async function isBiometricAvailable() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export async function isBiometricConfigured() {
  return !!(await getSetting('biometricCredentialId'));
}

export async function registerBiometric() {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'Djignan Financial System' },
      user: { id: userId, name: 'local-user', displayName: 'Utilisateur local' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      timeout: 60000,
      attestation: 'none',
    },
  });

  if (!credential) throw new Error(t('Enregistrement biométrique annulé.'));
  if (typeof credential.response.getPublicKey !== 'function') {
    throw new Error(t("Ce navigateur ne permet pas d'extraire la clé publique (getPublicKey indisponible)."));
  }
  const spki = credential.response.getPublicKey();
  if (!spki) throw new Error(t('Impossible de récupérer la clé publique biométrique.'));

  await setSetting('biometricCredentialId', bufToBase64(credential.rawId));
  await setSetting('biometricPublicKeySpki', bufToBase64(spki));
  await logAudit({ entityType: 'security', entityId: 'biometric', action: 'register', note: t('Biométrie activée') });
}

export async function removeBiometric() {
  await setSetting('biometricCredentialId', null);
  await setSetting('biometricPublicKeySpki', null);
  await logAudit({ entityType: 'security', entityId: 'biometric', action: 'remove', note: t('Biométrie désactivée') });
}

/* DER (ASN.1) -> signature brute r||s (P-256, composantes 32 octets) */
function derToRawSignature(derBuf) {
  const der = new Uint8Array(derBuf);
  let offset = 2; // SEQUENCE tag + length
  function readInt() {
    if (der[offset] !== 0x02) throw new Error('Signature DER invalide.');
    offset++;
    let len = der[offset++];
    let bytes = der.slice(offset, offset + len);
    offset += len;
    // retire le octet de padding 0x00 si présent (nombre positif codé sur bit haut)
    while (bytes.length > 32 && bytes[0] === 0x00) bytes = bytes.slice(1);
    const out = new Uint8Array(32);
    out.set(bytes, 32 - bytes.length);
    return out;
  }
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw.buffer;
}

export async function verifyBiometric() {
  const credIdB64 = await getSetting('biometricCredentialId');
  const spkiB64 = await getSetting('biometricPublicKeySpki');
  if (!credIdB64 || !spkiB64) throw new Error(t('Biométrie non configurée.'));

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: base64ToBuf(credIdB64), type: 'public-key' }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  if (!assertion) return false;

  const clientDataHash = await crypto.subtle.digest('SHA-256', assertion.response.clientDataJSON);
  const signedData = concatBuffers(assertion.response.authenticatorData, clientDataHash);
  const rawSignature = derToRawSignature(assertion.response.signature);

  const publicKey = await crypto.subtle.importKey(
    'spki', base64ToBuf(spkiB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, rawSignature, signedData);
  if (!valid) await logAudit({ entityType: 'security', entityId: 'biometric', action: 'verify_failed' });
  return valid;
}

/* ==========================================================================
   Écran de verrouillage — machine à états DOM (setup / confirm / unlock)
   ========================================================================== */
export function initLockScreen({ onUnlock }) {
  const screen = document.getElementById('lock-screen');
  const title = document.getElementById('lock-title');
  const subtitle = document.getElementById('lock-subtitle');
  const dotsWrap = document.getElementById('pin-dots');
  const dots = Array.from(dotsWrap.querySelectorAll('.pin-dot'));
  const errorEl = document.getElementById('lock-error');
  const keypad = document.getElementById('pin-keypad');
  const backspaceBtn = document.getElementById('pin-backspace');
  const biometricBtn = document.getElementById('pin-biometric');

  const FINGERPRINT_HTML = biometricBtn.innerHTML;
  const CHECK_HTML = svgIcon('check', 22);

  let mode = 'setup'; // 'setup' | 'confirm' | 'unlock'
  let buffer = '';
  let firstEntry = '';
  let expectedLength = 6;
  let throttledUntil = 0;
  // Empêche deux vérifications (PIN ou biométrique) de tourner en même temps : verifyPin() est un
  // calcul PBKDF2 de plusieurs dizaines/centaines de ms pendant lequel le clavier reste cliquable
  // (backspace + un nouveau chiffre suffit à redéclencher handleDigit avant que le premier appel ne
  // résolve). Sans ce verrou, deux verifyPin() concurrents lisent le même failedAttempts avant que
  // l'un ou l'autre n'écrive sa mise à jour — l'incrément est perdu, sous-comptant les échecs réels
  // et retardant le blocage anti-brute-force qu'ils sont censés déclencher.
  let verifying = false;

  function renderDots(maxLen) {
    dots.forEach((dot, i) => {
      dot.hidden = i >= maxLen;
      dot.classList.toggle('is-filled', i < buffer.length);
      dot.classList.remove('is-error');
    });
  }

  function shakeError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    dots.slice(0, buffer.length || expectedLength).forEach((d) => d.classList.add('is-error'));
    setTimeout(() => dots.forEach((d) => d.classList.remove('is-error')), 300);
  }

  function clearBuffer() {
    buffer = '';
    renderDots(mode === 'setup' ? 6 : expectedLength);
  }

  async function enterSetupMode() {
    mode = 'setup';
    buffer = ''; firstEntry = '';
    title.textContent = t('Créer votre code PIN');
    subtitle.textContent = t('Choisissez un code à 4-6 chiffres pour protéger vos données locales, puis touchez ✓ pour valider.');
    errorEl.hidden = true;
    biometricBtn.hidden = true;
    renderDots(6);
  }

  async function enterConfirmMode() {
    mode = 'confirm';
    buffer = '';
    expectedLength = firstEntry.length;
    title.textContent = t('Confirmez votre code PIN');
    subtitle.textContent = t('Ressaisissez le même code pour confirmer.');
    errorEl.hidden = true;
    biometricBtn.hidden = true;
    renderDots(expectedLength);
  }

  async function enterUnlockMode() {
    mode = 'unlock';
    buffer = '';
    expectedLength = await getPinLength();
    title.textContent = t('Déverrouiller Djignan');
    subtitle.textContent = t('Saisissez votre code PIN.');
    errorEl.hidden = true;
    renderDots(expectedLength);
    const bioAvailable = (await isBiometricAvailable()) && (await isBiometricConfigured());
    biometricBtn.innerHTML = FINGERPRINT_HTML;
    biometricBtn.setAttribute('aria-label', t('Déverrouillage biométrique'));
    biometricBtn.hidden = !bioAvailable;
    // Le blocage anti-brute-force doit survivre à un rechargement de page (sinon il suffit
    // de recharger pour l'annuler) : on le relit depuis les settings à chaque entrée en mode unlock.
    throttledUntil = await getSetting('pinThrottledUntil', 0);
    if (Date.now() < throttledUntil) showThrottleError();
  }

  let throttleTimer = null;
  function showThrottleError() {
    const remaining = Math.ceil((throttledUntil - Date.now()) / 1000);
    shakeError(t('Trop de tentatives. Réessayez dans {s}s.', { s: Math.max(remaining, 1) }));
    // Le décompte avance seul et le message disparaît à la fin du blocage (avant, il restait figé sur « 25s » même après l'échéance).
    clearInterval(throttleTimer);
    throttleTimer = setInterval(() => {
      const left = Math.ceil((throttledUntil - Date.now()) / 1000);
      if (left <= 0) { clearInterval(throttleTimer); throttleTimer = null; errorEl.hidden = true; return; }
      errorEl.textContent = t('Trop de tentatives. Réessayez dans {s}s.', { s: left });
    }, 1000);
  }

  async function handleDigit(d) {
    if (mode === 'unlock' && Date.now() < throttledUntil) { showThrottleError(); return; }
    if (mode === 'setup') {
      if (buffer.length >= 6) return;
      buffer += d;
      renderDots(6);
      if (buffer.length >= 4) {
        // Bascule le bouton "empreinte" en validation (coche) dès 4 chiffres
        biometricBtn.innerHTML = CHECK_HTML;
        biometricBtn.setAttribute('aria-label', t('Valider le code'));
        biometricBtn.hidden = false;
      }
      if (buffer.length === 6) {
        firstEntry = buffer;
        await enterConfirmMode();
      }
      return;
    }
    if (mode === 'confirm') {
      buffer += d;
      renderDots(expectedLength);
      if (buffer.length === expectedLength) {
        if (buffer === firstEntry) {
          try {
            await setupPin(buffer);
            onUnlock({ role: 'owner' });
          } catch (err) {
            // Filet de sécurité : une erreur ici (ex. IndexedDB indisponible) laissait jusqu'ici le
            // clavier silencieusement mort — dots remplis, rien d'autre — sans le moindre signal pour
            // l'utilisateur ni pour le diagnostic. handleDigit() est appelée « fire-and-forget » par
            // le clic (voir plus bas), donc toute exception non rattrapée ici devenait une rejection
            // de promesse non gérée, invisible dans l'UI.
            console.error('[auth] Échec setupPin/onUnlock :', err);
            shakeError(err.message || t('Une erreur est survenue. Réessayez.'));
            setTimeout(clearBuffer, 400);
          }
        } else {
          shakeError(t('Les codes ne correspondent pas. Recommencez.'));
          setTimeout(enterSetupMode, 700);
        }
      }
      return;
    }
    if (mode === 'unlock') {
      buffer += d;
      renderDots(expectedLength);
      if (buffer.length === expectedLength && !verifying) {
        verifying = true;
        try {
          const role = await verifyAccessCode(buffer); // 'owner' | 'helper' | null (code aidant : voir setupHelperPin)
          if (role) {
            // Seul le propriétaire lève le blocage (voir verifyAccessCode : le code aidant ne doit pas pouvoir le contourner).
            if (role === 'owner') {
              throttledUntil = 0;
              await setSetting('pinThrottledUntil', 0);
            }
            onUnlock({ role });
          } else {
            const attempts = await getSetting('failedAttempts', 0);
            shakeError(t('Code PIN incorrect.'));
            if (attempts >= MAX_ATTEMPTS_BEFORE_THROTTLE) {
              throttledUntil = Date.now() + THROTTLE_MS;
              await setSetting('pinThrottledUntil', throttledUntil);
              showThrottleError();
            }
            setTimeout(clearBuffer, 400);
          }
        } catch (err) {
          // Même filet de sécurité que pour setupPin() ci-dessus, côté déverrouillage cette fois :
          // sans ce catch, une exception dans verifyPin() (ou dans onUnlock() s'il levait de façon
          // synchrone) laissait l'utilisateur bloqué sur l'écran de code, dots remplis, sans aucune
          // réaction — exactement ce qu'un utilisateur a rapporté après un retour de redirection
          // Google (signInWithRedirect), sans qu'on ait pu reproduire la cause exacte à distance.
          console.error('[auth] Échec verifyPin/onUnlock :', err);
          shakeError(err.message || t('Une erreur est survenue. Réessayez.'));
          setTimeout(clearBuffer, 400);
        } finally {
          verifying = false;
        }
      }
    }
  }

  keypad.addEventListener('click', (e) => {
    const key = e.target.closest('.pin-key');
    if (!key) return;
    if (key === backspaceBtn) {
      buffer = buffer.slice(0, -1);
      renderDots(mode === 'setup' ? 6 : expectedLength);
      if (mode === 'setup' && buffer.length < 4) biometricBtn.hidden = true;
      return;
    }
    if (key === biometricBtn) {
      if (mode === 'setup' && buffer.length >= 4) {
        firstEntry = buffer;
        enterConfirmMode();
        return;
      }
      if (mode === 'unlock' && !verifying) {
        verifying = true;
        verifyBiometric()
          .then(async (ok) => {
            if (ok) {
              // Une identité prouvée biométriquement doit lever le blocage PIN au même titre qu'un
              // PIN correct : sans ça, un utilisateur throttlé après 5 échecs de PIN qui se
              // déverrouille par empreinte reste bloqué au PIN au verrouillage suivant (throttledUntil
              // et failedAttempts n'étaient jamais réinitialisés par le chemin biométrique).
              throttledUntil = 0;
              await setSetting('pinThrottledUntil', 0);
              await setSetting('failedAttempts', 0);
              onUnlock({ role: 'owner' }); // l'empreinte enregistrée est celle du propriétaire
            } else {
              shakeError(t('Échec de la vérification biométrique.'));
            }
          })
          .catch(() => shakeError(t('Biométrie indisponible ou annulée.')))
          .finally(() => { verifying = false; });
      }
      return;
    }
    const digit = key.dataset.key;
    if (digit === undefined) return;
    // Filet de sécurité final : handleDigit() est asynchrone mais appelée sans await depuis un
    // handler d'événement synchrone — n'importe quelle exception qu'un futur changement laisserait
    // échapper malgré les try/catch internes ci-dessus deviendrait sinon une rejection de promesse
    // non gérée, invisible dans l'UI (le symptôme exact qu'on cherche à éliminer ici).
    handleDigit(digit).catch((err) => {
      console.error('[auth] Erreur inattendue dans handleDigit :', err);
      shakeError(t('Une erreur est survenue. Réessayez.'));
    });
  });

  (async function boot() {
    if (await isPinConfigured()) {
      await enterUnlockMode();
    } else {
      await enterSetupMode();
    }
    screen.hidden = false;
  })();

  return {
    lock: enterUnlockMode,
    hide: () => { screen.hidden = true; },
    show: () => { screen.hidden = false; },
  };
}
