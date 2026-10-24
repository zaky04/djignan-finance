/* ==========================================================================
   Djignan Financial System — Mode discret : masquer TOUS les montants à l'écran
   Le masquage de base est en CSS : tout élément portant la classe `.amount` est remplacé par « ••••• » quand
   body[data-privacy="hidden"]. Mais beaucoup de montants sont écrits à l'intérieur d'une phrase (« Reste 55 500 F CFA
   ce mois-ci », « +794 500 F CFA vs mois dernier », bilans, outils…) sans élément dédié : ils restaient visibles.

   Plutôt que d'ajouter une classe à des centaines d'endroits (et d'en oublier à chaque nouvelle fonction), ce module
   repère tout montant écrit avec une devise dans le texte affiché et l'enveloppe dans <span class="amount auto-mask"> tant
   que le mode discret est actif ; un MutationObserver traite aussi ce qui s'affiche ensuite (changement d'écran,
   fenêtre, notification). En quittant le mode discret, le texte d'origine est restitué à l'identique.
   Les champs de saisie ne sont jamais touchés (on ne masque pas ce que l'utilisateur est en train de taper).
   ========================================================================== */

const CURRENCY_CODES = 'XOF|XAF|EUR|USD|GBP|MAD|NGN|GHS|JPY|CFA';
const SYMBOLS = String.raw`€|\$|£|₦|GH₵`;
// Un code de devise est en MAJUSCULES (Intl) et ne doit pas être le début d'un mot (« madame », « valeur »).
const CODE = `(?:${CURRENCY_CODES})(?![A-Za-zÀ-ÿ])`;
const NUM = String.raw`\d[\d\u202f\u00a0 .,]*\d|\d`;
// 1) nombre suivi de sa devise : « 55 500 F CFA », « 120,00 € »  2) devise/symbole devant : « €300.00 », « XOF 1,235 »
const AMOUNT_SOURCE = String.raw`(?:[+\-−]\s?)?(?:${NUM})\s?(?:F\s?CFA|FCFA|${CODE}|${SYMBOLS})|(?:${SYMBOLS}|\b${CODE})\s?[+\-−]?\s?(?:${NUM})`;

// svg : un <span> HTML n'a pas sa place dans un texte SVG (il disparaîtrait) ; les graphiques sont floutés en CSS.
const SKIP_SELECTOR = '.amount, .auto-mask, input, textarea, select, option, script, style, template, svg, [contenteditable="true"], .privacy-ignore';
const ROOT_SELECTORS = ['#app', '#modal-root', '#toast-container'];

let observer = null;
let active = false;
let pending = new Set();
let scheduled = false;

function wrapTextNode(node) {
  const text = node.nodeValue;
  if (!text || text.length < 3) return;
  const re = new RegExp(AMOUNT_SOURCE, 'g');
  if (!re.test(text)) return;
  re.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0].trim()) { re.lastIndex++; continue; }
    if (m.index > last) frag.append(text.slice(last, m.index));
    const span = document.createElement('span');
    span.className = 'amount auto-mask';
    span.dataset.autoMask = m[0];
    span.textContent = m[0];
    frag.append(span);
    last = m.index + m[0].length;
  }
  if (!frag.childNodes.length) return;
  if (last < text.length) frag.append(text.slice(last));
  node.replaceWith(frag);
}

function maskIn(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!root.parentElement?.closest(SKIP_SELECTOR)) wrapTextNode(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP_SELECTOR)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(wrapTextNode);
}

function flush() {
  scheduled = false;
  if (!active) { pending.clear(); return; }
  const batch = [...pending];
  pending = new Set();
  // On se déconnecte pendant nos propres modifications : elles ne doivent pas redéclencher l'observateur.
  observer?.disconnect();
  for (const node of batch) if (node.isConnected) maskIn(node);
  observeRoots();
}

function schedule(node) {
  pending.add(node);
  // setTimeout (pas requestAnimationFrame) : rAF est suspendu dans un onglet en arrière-plan, et le masquage ne doit jamais attendre.
  if (!scheduled) { scheduled = true; setTimeout(flush, 16); }
}

function observeRoots() {
  if (!observer) return;
  for (const sel of ROOT_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) observer.observe(el, { childList: true, subtree: true, characterData: true });
  }
}

function unmaskAll() {
  document.querySelectorAll('.auto-mask').forEach((span) => {
    const parent = span.parentNode;
    span.replaceWith(document.createTextNode(span.dataset.autoMask ?? span.textContent));
    parent?.normalize?.();
  });
}

/** Active ou désactive le masquage automatique des montants écrits dans le texte. */
export function setAutoMasking(on) {
  if (on === active) return;
  active = on;
  if (!on) {
    observer?.disconnect();
    unmaskAll();
    return;
  }
  if (!observer) {
    observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'characterData') schedule(rec.target);
        else rec.addedNodes.forEach((n) => schedule(n));
      }
    });
  }
  for (const sel of ROOT_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) maskIn(el);
  }
  observeRoots();
}
