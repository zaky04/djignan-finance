/* ==========================================================================
   GeoFinance System — OCR local des justificatifs (Tesseract.js)
   100% local : le moteur, le cœur WASM et le modèle de reconnaissance
   français sont vendorisés dans vendor/ et précachés par le service worker.
   Aucun appel réseau externe n'est jamais effectué, y compris hors-ligne.
   ========================================================================== */

let scriptLoadPromise = null;

function ensureTesseractScript() {
  if (window.Tesseract) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './vendor/tesseract.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Impossible de charger le moteur OCR (vendor/tesseract.min.js manquant)."));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

/** Repère le montant le plus probable dans un texte OCR de reçu : priorité aux
    nombres proches d'un mot-clé ("total", "montant"…), sinon le plus grand
    trouvé (le total est en général la plus grosse ligne d'un ticket). */
function parseAmountFromText(text) {
  const numberPattern = /(\d[\d ]{0,7}\d|\d)[.,](\d{2})(?!\d)/g;
  const candidates = [];
  let match;
  while ((match = numberPattern.exec(text))) {
    const value = parseFloat(`${match[1].replace(/\s/g, '')}.${match[2]}`);
    if (!(value > 0 && value < 1000000)) continue;
    const context = text.slice(Math.max(0, match.index - 20), match.index).toLowerCase();
    const isTotalContext = /total|montant|payer|somme|d[uû]/.test(context);
    candidates.push({ value, isTotalContext });
  }
  if (!candidates.length) return null;
  const pool = candidates.some((c) => c.isTotalContext) ? candidates.filter((c) => c.isTotalContext) : candidates;
  return pool.reduce((max, c) => (c.value > max.value ? c : max), pool[0]).value;
}

/** Extrait le montant probable d'une photo de justificatif. Renvoie null si
    rien de fiable n'est détecté (l'utilisateur doit alors saisir à la main). */
export async function extractAmountFromImage(blob) {
  await ensureTesseractScript();
  // Résolus en URL absolues nous-mêmes : dans certaines versions bundlées de
  // Tesseract.js, la résolution interne des chemins relatifs ne s'applique
  // pas correctement à workerPath une fois passé au Worker (blob-wrapped),
  // ce qui fait échouer importScripts() avec une URL encore relative.
  const abs = (path) => new URL(path, window.location.href).href;
  const worker = await window.Tesseract.createWorker('fra', 1, {
    workerPath: abs('./vendor/tesseract-worker.min.js'),
    corePath: abs('./vendor/tesseract-core-lstm.js'),
    langPath: abs('./vendor/'),
    cacheMethod: 'none',
    gzip: true,
    // Un worker "blob-wrapped" (comportement par défaut) a pour self.location.href une URL
    // blob:, ce qui casse la résolution relative interne du fichier .wasm jumeau par le
    // glue Emscripten (corePath lui-même). En désactivant workerBlobURL, le Worker est créé
    // directement sur workerPath (même origine, donc pas de restriction cross-origin), et
    // self.location.href redevient l'URL réelle sous /vendor/.
    workerBlobURL: false,
  });
  try {
    const { data: { text } } = await worker.recognize(blob);
    return parseAmountFromText(text);
  } finally {
    await worker.terminate();
  }
}
