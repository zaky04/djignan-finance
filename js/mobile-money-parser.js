/* ==========================================================================
   Djignan Financial System — Lecture des SMS / notifications Mobile Money
   Module PUR (aucun accès base, DOM ni réseau) : transforme le texte d'un SMS de
   confirmation (Orange Money, Wave, MTN MoMo, Moov Money, Airtel Money, M-Pesa…)
   en transaction proposée. Testé hors navigateur (voir test/mobile-money-parser.test.html).

   Pourquoi pas un gabarit par opérateur : les formulations changent d'un pays et d'une
   année à l'autre, et je n'ai pas accès à un corpus officiel de SMS. L'analyse repose donc
   sur des mots-clés et sur l'ÉTIQUETTE qui précède chaque montant (« frais », « solde »…),
   ce qui reste robuste quand l'ordre des phrases change. Un SMS non reconnu renvoie null :
   l'utilisateur saisit alors à la main, rien n'est jamais enregistré sans validation.
   ========================================================================== */

/** Espaces typographiques (insécable, fine insécable…) ramenés à un espace normal. */
function normalizeSpaces(text) {
  return String(text || '').replace(/[    ]/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

// Devises reconnues. 'cfa' = ambigu entre XOF et XAF : le portefeuille de l'utilisateur tranche.
const CURRENCY_SYMBOLS = [
  ['F\\s?CFA', 'CFA'], ['FCFA', 'CFA'], ['CFA', 'CFA'], ['FCF', 'CFA'],
  ['XOF', 'XOF'], ['XAF', 'XAF'],
  ['GH₵', 'GHS'], ['GHS', 'GHS'], ['GHC', 'GHS'],
  ['NGN', 'NGN'], ['₦', 'NGN'], ['MAD', 'MAD'], ['DHS?', 'MAD'],
  ['EUR', 'EUR'], ['€', 'EUR'], ['USD', 'USD'], ['\\$', 'USD'],
  ['F(?![A-Za-zÀ-ÿ])', 'CFA'], // « 5000F » mais pas « 5000 Frais »
];
const CURRENCY_ALT = CURRENCY_SYMBOLS.map(([re]) => re).join('|');
const NUMBER_RE = '\\d{1,3}(?:[ .,\']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';

function currencyCodeOf(token) {
  const t = token.replace(/\s+/g, '').toUpperCase();
  if (t === 'F' || t === 'FCFA' || t === 'CFA' || t === 'FCF') return 'CFA';
  if (t === 'GH₵' || t === 'GHC') return 'GHS';
  if (t === '₦') return 'NGN';
  if (t === '€') return 'EUR';
  if (t === '$') return 'USD';
  if (t === 'DH' || t === 'DHS') return 'MAD';
  return t;
}

/** « 5 000 », « 5.000 », « 5,000.50 », « 1 234,5 »… → nombre. Heuristique : le DERNIER séparateur
    suivi de 1-2 chiffres est une décimale ; sinon un séparateur suivi de 3 chiffres est un séparateur
    de milliers. Renvoie null si illisible. */
export function parseAmountToken(raw) {
  let s = String(raw || '').trim().replace(/[ '  ]/g, '');
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const lastSep = Math.max(lastDot, lastComma);
  if (lastSep === -1) return Number(s);
  const decimals = s.length - lastSep - 1;
  const sepChar = s[lastSep];
  const otherSepPresent = s.slice(0, lastSep).includes(sepChar === '.' ? ',' : '.');
  const sameSepRepeated = s.slice(0, lastSep).includes(sepChar);
  let value;
  if (decimals === 3 && !otherSepPresent) {
    // « 5.000 » / « 5,000 » : milliers (aucune devise de la zone n'a 3 décimales).
    value = Number(s.replace(/[.,]/g, ''));
  } else if (decimals >= 1 && decimals <= 2 && !sameSepRepeated) {
    value = Number(s.slice(0, lastSep).replace(/[.,]/g, '') + '.' + s.slice(lastSep + 1));
  } else {
    return null; // ambigu (ex: « 1.2.3 ») : on préfère ne rien proposer
  }
  return Number.isFinite(value) ? value : null;
}

function allAmountMatches(text) {
  const out = [];
  const after = new RegExp(`(${NUMBER_RE})\\s*(${CURRENCY_ALT})`, 'gi');
  const before = new RegExp(`(${CURRENCY_ALT})\\s*(${NUMBER_RE})`, 'gi');
  for (const [re, numberGroup, currencyGroup] of [[after, 1, 2], [before, 2, 1]]) {
    let m;
    while ((m = re.exec(text))) {
      const start = m.index;
      // Pas au milieu d'un autre nombre (« 12 345 » lu depuis le « 345 »).
      if (re === after && start > 0 && /[\d.,]/.test(text[start - 1])) continue;
      const value = parseAmountToken(m[numberGroup]);
      if (value == null || value < 0) continue;
      out.push({ start, end: start + m[0].length, value, currency: currencyCodeOf(m[currencyGroup]) });
    }
  }
  // Une même chaîne peut être vue par les deux motifs (« FCFA 5000 F ») : on garde la première, sans chevauchement.
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const m of out) {
    if (kept.length && m.start < kept[kept.length - 1].end) continue;
    kept.push(m);
  }
  return kept;
}

/** Étiquette du montant d'après le texte qui le PRÉCÈDE dans la même phrase. */
function labelOf(text, start) {
  const windowStart = Math.max(0, start - 40);
  let before = text.slice(windowStart, start).toLowerCase();
  const sentenceBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('. '), before.lastIndexOf('; '));
  if (sentenceBreak >= 0) before = before.slice(sentenceBreak + 1);
  if (/(solde|balance|\bbal\b)[^0-9]*$/.test(before)) return 'balance';
  if (/\b(?:frais|fee|fees|commission|charges?|taxes?)\b[^0-9]*$/.test(before)) return 'fee';
  if (/(plafond|limite|limit|maximum|max\.?)[^0-9]*$/.test(before)) return 'ignore';
  return 'main';
}

const STRONG_IN = /(re[cç]u|re[cç]ois|r[ée]ception|cr[ée]dit[ée]|cr[ée]dit\s+de|d[ée]p[oô]t|deposit|cash[\s-]?in|received|credited|approvisionn|vous\s+a\s+envoy[ée])/gi;
const STRONG_OUT = /(envoy[ée]|envoi|sent|retrait|retir[ée]|withdraw|paiement|pay[ée]|payment|paid|achat|purchase|bought|d[ée]bit|recharge|airtime|cash[\s-]?out|forfait|souscri|transf[ée]r[ée]\s+[àa]\b)/gi;
const WEAK_TRANSFER = /(transf[ée]r[et]?|transfer)/i;

function firstIndex(re, text) {
  re.lastIndex = 0;
  const m = re.exec(text);
  return m ? m.index : -1;
}

function detectDirection(text) {
  const iIn = firstIndex(STRONG_IN, text);
  const iOut = firstIndex(STRONG_OUT, text);
  // « Vous avez reçu » l'emporte sur « transféré » ; si les deux sont forts, le premier mot gagne.
  if (iIn >= 0 && iOut >= 0) return iIn < iOut ? 'in' : 'out';
  if (iIn >= 0) return 'in';
  if (iOut >= 0) return 'out';
  if (WEAK_TRANSFER.test(text)) return 'out';
  return null;
}

function detectKind(text, direction) {
  const lower = text.toLowerCase();
  if (/retrait|withdraw|cash[\s-]?out/.test(lower)) return 'withdrawal';
  if (/d[ée]p[oô]t|deposit|cash[\s-]?in/.test(lower)) return 'deposit';
  if (/recharge|airtime|forfait|cr[ée]dit\s+de\s+communication|data\s+bundle/.test(lower)) return 'airtime';
  if (/paiement|payment|paid|pay[ée]|achat|purchase|marchand|merchant|facture|bill/.test(lower)) return 'payment';
  return direction === 'in' ? 'transfer_in' : 'transfer_out';
}

const PROVIDERS = [
  [/orange\s*money|\bOM\b/i, 'Orange Money'],
  [/\bwave\b/i, 'Wave'],
  [/\bmtn\b|\bmomo\b|mobile\s*money\s*mtn/i, 'MTN MoMo'],
  [/moov/i, 'Moov Money'],
  [/airtel/i, 'Airtel Money'],
  [/m-?pesa/i, 'M-Pesa'],
  [/free\s*money|\bwizall\b|\bjoni\s*joni\b/i, 'Free Money'],
];

function detectProvider(text) {
  for (const [re, name] of PROVIDERS) if (re.test(text)) return name;
  return null;
}

/** Cherche une date JJ/MM/AAAA (convention française, jamais MM/JJ) ou AAAA-MM-JJ. */
function detectDate(text, today) {
  const candidates = [];
  const dmy = /(^|[^\d./-])(\d{1,2})([/-])(\d{1,2})\3(\d{4}|\d{2})(?![\d])/g;
  let m;
  while ((m = dmy.exec(text))) candidates.push({ d: +m[2], mo: +m[4], y: m[5].length === 2 ? 2000 + +m[5] : +m[5] });
  const dmyDots = /(^|[^\d./-])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\d])/g;
  while ((m = dmyDots.exec(text))) candidates.push({ d: +m[2], mo: +m[3], y: +m[4] });
  const iso = /(^|[^\d-])(\d{4})-(\d{2})-(\d{2})(?![\d])/g;
  while ((m = iso.exec(text))) candidates.push({ d: +m[4], mo: +m[3], y: +m[2] });
  const limit = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  for (const c of candidates) {
    if (c.mo < 1 || c.mo > 12 || c.d < 1 || c.d > 31) continue;
    const date = new Date(c.y, c.mo - 1, c.d);
    if (date.getMonth() !== c.mo - 1 || date.getDate() !== c.d) continue; // 31/02…
    if (date >= limit) continue; // une opération passée, jamais une date future
    if (c.y < today.getFullYear() - 5) continue;
    return `${c.y}-${String(c.mo).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
  }
  return null;
}

function detectReference(text) {
  const re = /\b(?:financial\s*transaction\s*id|transaction\s*id|id\s+de\s+transaction|id\s+transaction|txn\s*id|trans\.?\s*id|r[ée]f[ée]rence|r[ée]f|ref|id)\s*[:#.]?\s*([A-Za-z0-9][A-Za-z0-9._-]{4,})/i;
  const m = re.exec(text);
  if (!m) return null;
  const value = m[1].replace(/[.-]+$/, '');
  // Un identifiant contient presque toujours un chiffre (évite « ref valid », « id est »).
  return /\d/.test(value) ? value : null;
}

const NAME_STOP = /\s+(?:frais|fee|fees|ref|r[ée]f|id|nouveau|new|solde|balance|le|on|at|date|transaction|numero|num[ée]ro|effectu\w*|r[ée]ussi\w*|succ[èe]s|termin\w*|valid\w*|confirm\w*|avec|et|merci)\b.*$/i;

/** Contrepartie : le nom (ou numéro) juste après le montant (« … 5000F à Moussa Diop (771234567) »). */
function detectCounterparty(text, mainMatch, direction) {
  const rest = text.slice(mainMatch.end);
  const re = direction === 'in'
    ? /^\s*(?:de|du|d'|from|par)\s+(.+)/i
    : /^\s*(?:[àa]|au|vers|to|pour|chez|for)\s+(.+)/i;
  let m = re.exec(rest);
  if (!m && direction === 'in') m = /^\s*(?:de|du|from)\s+(.+)/i.exec(rest);
  if (!m) {
    // Forme anglaise « … GHS 20.00 to X » déjà couverte ; forme « de X » avant le montant :
    const beforeText = text.slice(0, mainMatch.start);
    const b = direction === 'in'
      ? /(?:de|du|from)\s+([A-Za-zÀ-ÿ0-9][^:]{1,40}?)\s*[:\-–]?\s*$/i.exec(beforeText)
      : null;
    if (!b) return { name: null, phone: null };
    m = [null, b[1]];
  }
  let chunk = m[1].split(/[\n.;,]/)[0];
  const parenMatch = /\(([+\d][\d\s]{6,})\)/.exec(chunk);
  const phone = parenMatch ? parenMatch[1].replace(/\s+/g, '') : null;
  chunk = chunk.replace(/\([^)]*\)/g, ' ').replace(NAME_STOP, '').replace(/\s+/g, ' ').trim();
  if (!chunk) return { name: null, phone };
  // Le « nom » est en fait un numéro de téléphone.
  const digits = chunk.replace(/[\s.+-]/g, '');
  if (/^\d{7,15}$/.test(digits)) return { name: null, phone: phone || digits };
  return { name: chunk.slice(0, 60), phone };
}

/**
 * Analyse UN message. Renvoie null si aucun montant exploitable n'est trouvé.
 * {
 *   direction: 'in' | 'out' | null,    // null = sens inconnu, à choisir par l'utilisateur
 *   kind: 'transfer_out'|'transfer_in'|'withdrawal'|'deposit'|'payment'|'airtime',
 *   amount, currency ('CFA' = XOF ou XAF, à trancher d'après le portefeuille),
 *   fee, feeCurrency, balance, counterparty, phone, date (AAAA-MM-JJ | null), reference, provider
 * }
 */
export function parseMobileMoneyMessage(rawText, { today = new Date() } = {}) {
  const text = normalizeSpaces(rawText);
  if (!text) return null;
  const matches = allAmountMatches(text).map((m) => ({ ...m, label: labelOf(text, m.start) }));
  const main = matches.find((m) => m.label === 'main' && m.value > 0);
  if (!main) return null;
  const fee = matches.find((m) => m.label === 'fee');
  const balance = matches.find((m) => m.label === 'balance');

  const direction = detectDirection(text);
  const { name, phone } = detectCounterparty(text, main, direction === 'in' ? 'in' : 'out');
  return {
    direction,
    kind: detectKind(text, direction),
    amount: main.value,
    currency: main.currency,
    fee: fee ? fee.value : 0,
    balance: balance ? balance.value : null,
    counterparty: name,
    phone,
    date: detectDate(text, today),
    reference: detectReference(text),
    provider: detectProvider(text),
    raw: String(rawText).trim().slice(0, 600),
  };
}

/** Plusieurs messages collés d'un coup : séparés par une ligne vide, ou une ligne chacun quand
    chaque ligne est un message complet. Les messages non reconnus sont comptés, pas silencieusement perdus. */
export function parseMobileMoneyMessages(rawText, opts = {}) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return { messages: [], unrecognized: 0 };
  let blocks = text.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length === 1) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1 && lines.filter((l) => parseMobileMoneyMessage(l, opts)).length >= 2) blocks = lines;
  }
  const messages = [];
  let unrecognized = 0;
  for (const block of blocks) {
    const parsed = parseMobileMoneyMessage(block, opts);
    if (parsed) messages.push(parsed);
    else unrecognized++;
  }
  return { messages, unrecognized };
}

/** Un portefeuille convient-il à la devise lue ? « CFA » (F, FCFA…) convient à XOF comme à XAF. */
export function currencyMatchesWallet(parsedCurrency, walletCurrency) {
  if (parsedCurrency === 'CFA') return walletCurrency === 'XOF' || walletCurrency === 'XAF';
  return parsedCurrency === walletCurrency;
}
