/* ==========================================================================
   Djignan Financial System — Lecture à voix haute (synthèse vocale)
   Pour qui lit peu ou mal : l'appli peut DIRE son solde, ce qu'on lui doit, et confirmer chaque
   enregistrement (« C'est noté : dépense de deux mille cinq cents francs CFA. Il vous reste… »).

   Synthèse : API Web Speech du navigateur (speechSynthesis). Contrairement à la dictée
   (voice-input.js), elle ne fait RIEN sortir de l'appareil par la volonté de l'appli : le texte lu
   est construit ici, et la voix vient du système (Android, Windows, iOS). Elle marche donc aussi dans
   les builds natifs et, selon la voix installée, sans réseau. Si le système n'a aucune voix,
   isSpeechSupported() reste vrai mais rien ne sort : l'écran affiche toujours le texte.

   Les montants sont dits EN TOUTES LETTRES (amountInWords, déjà utilisé pour la reconnaissance de
   dette) plutôt qu'en chiffres : une voix lit « 45000 » de façons très variables, jamais « quarante-
   cinq mille francs CFA » de travers.

   Les fonctions buildXxxSpeech sont pures (aucun accès base, aucun DOM) et testées hors navigateur.
   ========================================================================== */

import { getSetting } from './db.js';
import { getLanguage, t } from './i18n.js';
import { amountInWords } from './debt-acknowledgement.js';
import { ZERO_DECIMAL_CURRENCIES } from './utils.js';

export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';
}

const langTag = (lang) => (lang === 'en' ? 'en-US' : 'fr-FR');

/** Meilleure voix pour une langue : même langue ET région, sinon même langue ; une voix locale
    (installée sur l'appareil, utilisable hors-ligne) passe avant une voix en ligne. null = laisser le
    système choisir d'après `utterance.lang`. Pure. */
export function pickVoice(voices, tag) {
  const norm = (s) => String(s || '').toLowerCase().replace('_', '-');
  const want = norm(tag);
  const primary = want.split('-')[0];
  const list = Array.isArray(voices) ? voices : [];
  const byLocal = (a, b) => Number(!!b.localService) - Number(!!a.localService);
  const exact = list.filter((v) => norm(v.lang) === want).sort(byLocal);
  if (exact.length) return exact[0];
  const sameLanguage = list.filter((v) => norm(v.lang).split('-')[0] === primary).sort(byLocal);
  return sameLanguage[0] || null;
}

/** Coupe un texte en phrases courtes : certains moteurs (Chrome) coupent une lecture trop longue. Pure. */
export function splitSentences(text) {
  // Pas de « lookbehind » (?<=…) : il exige Safari 16.4 et une erreur de syntaxe à la lecture du fichier empêcherait toute l'appli de démarrer.
  return (String(text || '').match(/[^.!?…]+[.!?…]*/g) || []).map((s) => s.trim()).filter(Boolean);
}

/** À appeler directement dans un geste de l'utilisateur (clic) AVANT tout `await` : iOS/Safari n'autorise
    la parole que si elle démarre d'un geste. Une phrase vide « débloque » les lectures suivantes. */
export function primeSpeech() {
  if (!isSpeechSupported()) return;
  try { window.speechSynthesis.speak(new window.SpeechSynthesisUtterance('')); } catch { /* sans effet */ }
}

export function stopSpeaking() {
  if (!isSpeechSupported()) return;
  try { window.speechSynthesis.cancel(); } catch { /* sans effet */ }
}

/** Lit le texte (en remplaçant toute lecture en cours). Résout `true` à la fin de la lecture, `false` si
    rien n'a pu être dit. Ne rejette jamais : une lecture ratée ne doit jamais bloquer un enregistrement. */
export function speak(text, { lang = getLanguage() } = {}) {
  const sentences = splitSentences(text);
  if (!isSpeechSupported() || !sentences.length) return Promise.resolve(false);
  const synth = window.speechSynthesis;
  const tag = langTag(lang);
  return new Promise((resolve) => {
    try {
      synth.cancel();
      const voice = pickVoice(synth.getVoices(), tag);
      // Garde-fou : un moteur qui n'émet jamais « end » (WebView sans voix) ne doit pas laisser la promesse pendante.
      const giveUp = setTimeout(() => resolve(false), 30000);
      sentences.forEach((sentence, i) => {
        const u = new window.SpeechSynthesisUtterance(sentence);
        u.lang = tag;
        u.rate = 0.9; // un peu plus lent que la normale : on dicte des montants
        if (voice) u.voice = voice;
        if (i === sentences.length - 1) {
          u.onend = () => { clearTimeout(giveUp); resolve(true); };
          // « canceled » / « interrupted » : une lecture plus récente a pris la place (2e toucher sur « Écouter ») — ce n'est pas
          // l'absence de voix, l'appelant ne doit pas afficher « aucune voix installée ».
          u.onerror = (ev) => { clearTimeout(giveUp); resolve(!!ev && (ev.error === 'canceled' || ev.error === 'interrupted')); };
        }
        synth.speak(u);
      });
    } catch {
      resolve(false);
    }
  });
}

/** « 2 500 F CFA » → « deux mille cinq cents francs CFA » (voir amountInWords). */
export function spokenAmount(amount, currency) {
  // Arrondi à la précision de la devise AVANT de convertir en lettres : un solde converti peut avoir 4 décimales (« et cent centimes »
  // pour 1523,9967) et, en francs CFA, amountInWords tronque quand l'affichage arrondit — la voix doit dire ce que l'écran montre.
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  const factor = 10 ** decimals;
  return amountInWords(Math.round(Math.abs(Number(amount) || 0) * factor) / factor, currency);
}

/** Texte lu pour « mon solde ». `snapshot` : { liquid, safeToSpend (ou null), receivables, debts, currency }. */
export function buildBalanceSpeech(snapshot) {
  const { liquid = 0, safeToSpend = null, receivables = 0, debts = 0, currency } = snapshot || {};
  const say = (n) => spokenAmount(n, currency);
  const parts = [];
  if (liquid > 0.004) parts.push(t('En tout, vous avez {amount}.', { amount: say(liquid) }));
  else if (liquid < -0.004) parts.push(t('Attention : votre solde est négatif, il manque {amount}.', { amount: say(liquid) }));
  else parts.push(t("Vous n'avez rien dans vos portefeuilles."));
  if (safeToSpend !== null && safeToSpend !== undefined) {
    if (safeToSpend > 0.004) parts.push(t("Après vos dépenses prévues, il vous reste {amount} à dépenser jusqu'à la fin du mois.", { amount: say(safeToSpend) }));
    else if (safeToSpend < -0.004) parts.push(t('Attention : vos dépenses prévues dépassent votre argent de {amount}.', { amount: say(safeToSpend) }));
    else parts.push(t("Après vos dépenses prévues, il ne vous reste rien à dépenser ce mois-ci."));
  }
  if (receivables > 0.004) parts.push(t('On vous doit {amount}.', { amount: say(receivables) }));
  if (debts > 0.004) parts.push(t('Vous devez {amount}.', { amount: say(debts) }));
  return parts.join(' ');
}

/** Texte lu juste après un enregistrement. `info` : { type: 'income'|'expense', amount, currency,
    categoryName?, walletName, balance? }. */
export function buildSavedSpeech(info) {
  const { type, amount, currency, categoryName = '', walletName = '', balance = null } = info;
  const say = (n) => spokenAmount(n, currency);
  const parts = [];
  if (type === 'income') parts.push(t("C'est noté : vous avez reçu {amount}.", { amount: say(amount) }));
  else parts.push(categoryName
    ? t("C'est noté : dépense de {amount}, {category}.", { amount: say(amount), category: categoryName })
    : t("C'est noté : dépense de {amount}.", { amount: say(amount) }));
  if (balance !== null && balance !== undefined && walletName) {
    if (balance < -0.004) parts.push(t('Attention : {wallet} est en négatif, il manque {amount}.', { wallet: walletName, amount: say(balance) }));
    else if (type === 'income') parts.push(t('Vous avez maintenant {amount} sur {wallet}.', { amount: say(balance), wallet: walletName }));
    else parts.push(t('Il vous reste {amount} sur {wallet}.', { amount: say(balance), wallet: walletName }));
  }
  return parts.join(' ');
}

/** Texte lu AVANT l'enregistrement (écran « C'est bon ? »). Mêmes champs que buildSavedSpeech, sans solde. */
export function buildConfirmSpeech(info) {
  const { type, amount, currency, categoryName = '', walletName = '' } = info;
  const say = spokenAmount(amount, currency);
  const head = type === 'income'
    ? t('Vous avez reçu {amount}', { amount: say })
    : (categoryName ? t('Dépense de {amount}, {category}', { amount: say, category: categoryName }) : t('Dépense de {amount}', { amount: say }));
  return walletName
    ? t("{head}, sur {wallet}. Pour enregistrer, touchez le bouton vert.", { head, wallet: walletName })
    : t('{head}. Pour enregistrer, touchez le bouton vert.', { head });
}

/** Déplacement d'argent entre deux portefeuilles : lu avant l'enregistrement. */
export function buildTransferConfirmSpeech(info) {
  const { amount, currency, fromName = '', toName = '' } = info;
  return t("Déplacement de {amount}, de {from} vers {to}. Pour enregistrer, touchez le bouton vert.", { amount: spokenAmount(amount, currency), from: fromName, to: toName });
}

/** Déplacement enregistré : ce qui a été fait, et ce qui reste sur le portefeuille d'où part l'argent. */
export function buildTransferSavedSpeech(info) {
  const { amount, currency, fromName = '', toName = '', balance = null } = info;
  const parts = [t("C'est noté : {amount} déplacés de {from} vers {to}.", { amount: spokenAmount(amount, currency), from: fromName, to: toName })];
  if (balance !== null && balance !== undefined && fromName) {
    if (balance < -0.004) parts.push(t('Attention : {wallet} est en négatif, il manque {amount}.', { wallet: fromName, amount: spokenAmount(balance, currency) }));
    else parts.push(t('Il vous reste {amount} sur {wallet}.', { amount: spokenAmount(balance, currency), wallet: fromName }));
  }
  return parts.join(' ');
}

/** Réglage « lire à voix haute les confirmations » (clé speakConfirmations, désactivé par défaut). */
export async function isSpeakConfirmationsEnabled() {
  return isSpeechSupported() && !!(await getSetting('speakConfirmations', false));
}
