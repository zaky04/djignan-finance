/* ==========================================================================
   Djignan Financial System — Saisie vocale
   « 2 500 taxi », « j'ai dépensé deux mille cinq cents francs pour le taxi », « reçu salaire
   150 000 » → montant, libellé et sens (dépense / recette).

   Reconnaissance : API Web Speech du NAVIGATEUR (SpeechRecognition). Elle n'est pas fournie par
   l'appli : sur Chrome l'audio est traité par le service de reconnaissance de Google, sur Safari par
   celui d'Apple — c'est pourquoi un consentement explicite est demandé à la première utilisation
   (voir openVoiceCapture dans transactions.js). Non disponible dans les builds natifs (Capacitor,
   Tauri) : la fonction isVoiceSupported() y renvoie false et le bouton reste masqué.

   L'analyse du texte (parseSpokenEntry) est pure et testée hors navigateur.
   ========================================================================== */

export function isVoiceSupported() {
  if (typeof window === 'undefined') return false;
  if (window.__TAURI__ || (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return false;
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** Écoute une seule phrase et résout avec le texte reconnu. `onInterim(texte)` reçoit le texte
    provisoire pendant que l'utilisateur parle. Rejette avec une Error dont `code` vaut l'erreur
    de l'API ('not-allowed', 'no-speech', 'network'…). `controller.stop()` interrompt l'écoute. */
export function listenOnce({ lang = 'fr', onInterim = () => {} } = {}) {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const controller = { stop: () => {} };
  const promise = new Promise((resolve, reject) => {
    const rec = new Ctor();
    rec.lang = lang === 'en' ? 'en-US' : 'fr-FR';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    let finalText = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const piece = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += piece; else interim += piece;
      }
      onInterim((finalText + interim).trim());
    };
    rec.onerror = (event) => {
      const err = new Error(event.error || 'speech-error');
      err.code = event.error || 'speech-error';
      finish(reject, err);
    };
    rec.onend = () => {
      if (finalText.trim()) finish(resolve, finalText.trim());
      else { const err = new Error('no-speech'); err.code = 'no-speech'; finish(reject, err); }
    };
    controller.stop = () => { try { rec.stop(); } catch { /* déjà arrêtée */ } };
    try { rec.start(); } catch (err) { finish(reject, err); }
  });
  return { promise, controller };
}

/* ---------- Nombres écrits en toutes lettres ---------- */
const FR_UNITS = { zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16, vingt: 20, vingts: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };
const EN_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function isNumberWord(word, lang) {
  if (lang === 'en') return word in EN_UNITS || ['hundred', 'thousand', 'million', 'and'].includes(word);
  return word in FR_UNITS || ['cent', 'cents', 'mille', 'million', 'millions'].includes(word);
}

/** Convertit une suite de mots-nombres (déjà normalisés, sans accents) en nombre. */
function wordsToNumber(words, lang) {
  let total = 0;
  let current = 0;
  let lastUnit = 0;
  for (const w of words) {
    if (lang === 'en') {
      if (w === 'and') continue;
      if (w in EN_UNITS) { current += EN_UNITS[w]; }
      else if (w === 'hundred') current = (current || 1) * 100;
      else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
      else if (w === 'million') { total += (current || 1) * 1000000; current = 0; }
      continue;
    }
    if (w === 'et') continue;
    if (w in FR_UNITS) {
      // « quatre-vingt(s) » = 4 × 20, pas 4 + 20.
      if ((w === 'vingt' || w === 'vingts') && lastUnit === 4 && current >= 4) current += 76;
      else current += FR_UNITS[w];
      lastUnit = FR_UNITS[w];
      continue;
    }
    lastUnit = 0;
    if (w === 'cent' || w === 'cents') current = (current || 1) * 100;
    else if (w === 'mille') { total += (current || 1) * 1000; current = 0; }
    else if (w === 'million' || w === 'millions') { total += (current || 1) * 1000000; current = 0; }
  }
  return total + current;
}

const INCOME_HINT = /\b(re[cç]u|recu|recois|gagn[ée]?|recette|entr[ée]e|salaire|paie|remboursement|income|received|earned|salary|got paid|paid me)\b/i;

/** Texte dicté → { type, amount, note }. `amount` vaut null si aucun nombre n'est trouvé. */
export function parseSpokenEntry(rawText, lang = 'fr') {
  const original = String(rawText || '').trim();
  if (!original) return { type: 'expense', amount: null, note: '' };
  const type = INCOME_HINT.test(stripAccents(original)) || INCOME_HINT.test(original) ? 'income' : 'expense';

  // Chiffres : « 2 500 », « 2.500 », « 1 250,50 » → un seul nombre.
  let text = original.replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, '$1');
  let amount = null;
  const digit = /\d+(?:[.,]\d{1,2})?(?!\d)/.exec(text);
  if (digit) {
    amount = Number(digit[0].replace(',', '.'));
    text = text.slice(0, digit.index) + ' ' + text.slice(digit.index + digit[0].length);
  } else {
    // Mots : plus longue suite de mots-nombres.
    const tokens = text.split(/[\s]+/);
    const norm = tokens.map((tk) => stripAccents(tk.toLowerCase().replace(/[^\p{L}-]/gu, '')));
    let best = null;
    for (let i = 0; i < norm.length; i++) {
      const run = [];
      let j = i;
      while (j < norm.length) {
        const parts = norm[j].split('-').filter(Boolean);
        if (parts.length && parts.every((p) => isNumberWord(p, lang))) { run.push(...parts); j++; } else break;
      }
      if (run.length && (!best || run.length > best.words.length) && run.some((w) => w !== 'et' && w !== 'and')) best = { start: i, end: j, words: run };
      if (run.length) i = j - 1;
    }
    if (best) {
      const value = wordsToNumber(best.words, lang);
      if (value > 0) {
        amount = value;
        tokens.splice(best.start, best.end - best.start);
        text = tokens.join(' ');
      }
    }
  }

  // Mots de remplissage retirés du libellé. Délimiteurs explicites plutôt que \b : \b ne reconnaît
  // pas « é » comme lettre, donc « dépensé » ne serait jamais retiré.
  const fillerWords = lang === 'en'
    ? ['i spent', 'i paid', 'i received', 'i got', 'i earned', 'i bought', 'spent', 'paid', 'received', 'got', 'earned', 'bought', 'for', 'on', 'the', 'a', 'an', 'of', 'dollars', 'dollar', 'euros', 'euro', 'cfa', 'francs', 'franc', 'xof', 'xaf', 'expense', 'income']
    : ["j'ai dépensé", "j'ai payé", "j'ai reçu", "j'ai gagné", "j'ai acheté", 'dépense', 'recette', 'entrée', 'reçu', 'payé', 'pour', 'de', 'du', 'des', 'le', 'la', 'les', 'au', 'aux', 'francs', 'franc', 'f cfa', 'fcfa', 'cfa', 'xof', 'xaf', 'euros', 'euro'];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]");
  const fillerRe = new RegExp(`(^|[\\s,.;:])(?:${fillerWords.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?=$|[\\s,.;:])`, 'giu');
  let note = text.replace(/(^|\s)[ld]['’](?=\p{L})/giu, '$1 ').replace(fillerRe, ' ').replace(fillerRe, ' ').replace(/[€$]/g, ' ').replace(/\s+/g, ' ').trim();
  note = note.replace(/^[-–,.:;]+|[-–,.:;]+$/g, '').trim();
  if (note) note = note.charAt(0).toUpperCase() + note.slice(1);
  return { type, amount, note: note.slice(0, 140) };
}
