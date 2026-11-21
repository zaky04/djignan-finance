/* ==========================================================================
   Djignan Financial System — Assistant : bilan en mots simples, et questions à une IA (optionnel)

   Trois modes, au choix dans Paramètres (`aiMode`) :
   - « off »   : rien (défaut) ;
   - « local » : un bilan du mois rédigé PAR L'APPLICATION, sur l'appareil, sans réseau ni modèle (buildLocalReport) ;
   - « cloud » : en plus, des questions libres posées à une IA (API Anthropic) avec la clé PERSONNELLE de l'utilisateur.

   Confidentialité (mode « cloud » seulement). Ce qui part est un EXTRAIT de chiffres (buildSnapshot), jamais la base :
   - niveau « anonymous » (défaut) : totaux du mois, du mois précédent, dépenses par catégorie (les noms de catégories créées par
     l'utilisateur sont regroupés sous « Autres catégories » : seuls les noms des catégories d'origine de l'application sont envoyés),
     budgets (mêmes règles de noms), reste à vivre, soldes globaux. Pas de portefeuille, pas de personne ;
   - niveau « labels » : en plus, les noms de TOUTES les catégories et les noms des portefeuilles avec leur solde.
   Dans les deux niveaux : JAMAIS de notes, d'étiquettes, de noms de personnes (dettes, créances, partages, tontines), de justificatifs,
   ni de liste d'opérations. L'envoi exige un consentement explicite (`aiConsent`, lié au niveau) et l'extrait exact est montré avant.
   La clé API (`aiApiKey`) et le consentement restent sur l'appareil : jamais dans une sauvegarde (DEVICE_LOCAL_SETTING_KEYS, db.js).

   Les fonctions de ce fichier sont pures (extrait, texte, requête, réponse) ou prennent leurs dépendances en paramètre (`fetchImpl`) :
   testées sans réseau. L'interface est dans ai-assistant-ui.js.
   ========================================================================== */

import { STORES, dbGetAll, getSetting, DEFAULT_CATEGORIES } from './db.js';
import { computeMonthSummary, computeExpensesByCategory, computeBudgetVsActual, computeEndOfMonthForecast, computeSafeToSpend, computeNetWorthComposition, getAllWalletBalances } from './ledger.js';
import { currentMonthKey, monthKeyOffset } from './utils.js';

export const AI_ENDPOINT = 'https://api.anthropic.com/v1/messages'; // aussi dans la CSP (connect-src, index.html)
export const AI_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Rapide et économique (Haiku 5.5)' },
  { id: 'claude-sonnet-5-5', label: 'Plus soigné, plus cher (Sonnet 5.5)' },
];
export const AI_DEFAULT_MODEL = 'claude-haiku-5-5';
export const AI_DATA_LEVELS = ['anonymous', 'labels'];
export const AI_MODES = ['off', 'local', 'cloud'];

/** Noms de catégories d'origine (français + anglais) : les seuls envoyés au niveau « anonymous ». */
const KNOWN_CATEGORY_NAMES = new Set([
  ...DEFAULT_CATEGORIES.map((c) => c.name.toLowerCase()),
  'salary', 'other income', 'food', 'housing', 'transport', 'leisure', 'health', 'subscriptions', 'other expenses', 'uncategorized', 'others',
  'sans catégorie', 'autres',
]);

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ---------- Réglages ---------- */
export async function getAiSettings() {
  const [mode, level, model, consent, apiKey] = await Promise.all([
    getSetting('aiMode', 'off'), getSetting('aiDataLevel', 'anonymous'), getSetting('aiModel', AI_DEFAULT_MODEL),
    getSetting('aiConsent', null), getSetting('aiApiKey', ''),
  ]);
  return {
    mode: AI_MODES.includes(mode) ? mode : 'off',
    level: AI_DATA_LEVELS.includes(level) ? level : 'anonymous',
    model: AI_MODELS.some((m) => m.id === model) ? model : AI_DEFAULT_MODEL,
    consent, // niveau pour lequel l'utilisateur a donné son accord, ou null
    apiKey: typeof apiKey === 'string' ? apiKey : '',
  };
}

/** Peut-on envoyer ? mode « cloud », clé présente, ET consentement donné pour LE niveau de données actuel. */
export function cloudReadiness({ mode, level, consent, apiKey }) {
  if (mode !== 'cloud') return { ok: false, reason: 'mode' };
  if (!apiKey) return { ok: false, reason: 'key' };
  if (consent !== level) return { ok: false, reason: 'consent' };
  return { ok: true, reason: null };
}

/* ---------- Extrait de chiffres (pur) ---------- */
/** `input` : { level, monthKey, currency, summary, previousSummary, categories:[{label,value}], budgets:[{label,budget,actual}],
    safeToSpend, upcomingBillsTotal, composition:{liquid,savings,blocked,invested,receivables,debts}, wallets:[{name,balance,currency}] }.
    Renvoie l'objet envoyé (et montré à l'utilisateur) — rien d'autre ne sort de l'appareil. */
export function buildSnapshot(input) {
  const level = input.level === 'labels' ? 'labels' : 'anonymous';
  const keepName = (label) => level === 'labels' || KNOWN_CATEGORY_NAMES.has(String(label || '').trim().toLowerCase());
  const groupNames = (rows, valueKey) => {
    const out = new Map();
    for (const r of rows || []) {
      const name = keepName(r.label) ? String(r.label) : 'Other categories';
      const prev = out.get(name) || { name, amount: 0, limit: 0 };
      if (valueKey === 'value') prev.amount += Number(r.value) || 0;
      else { prev.amount += Number(r.actual) || 0; prev.limit += Number(r.budget) || 0; }
      out.set(name, prev);
    }
    return [...out.values()];
  };
  const snapshot = {
    data_level: level,
    month: input.monthKey,
    currency: input.currency,
    income: round(input.summary?.income),
    expenses: round(input.summary?.expenses),
    net_saving: round(input.summary?.netSavings),
    previous_month: { income: round(input.previousSummary?.income), expenses: round(input.previousSummary?.expenses) },
    expenses_by_category: groupNames(input.categories, 'value').map((r) => ({ name: r.name, amount: round(r.amount) })).sort((a, b) => b.amount - a.amount),
    budgets: groupNames(input.budgets, 'budget').map((r) => ({ name: r.name, limit: round(r.limit), spent: round(r.amount) })),
    safe_to_spend_this_month: input.safeToSpend == null ? null : round(input.safeToSpend),
    upcoming_bills_total: round(input.upcomingBillsTotal),
    balances: {
      spendable: round(input.composition?.liquid), savings: round(input.composition?.savings), invested: round(input.composition?.invested),
      owed_to_me_total: round(input.composition?.receivables), i_owe_total: round(input.composition?.debts),
    },
  };
  if (level === 'labels') snapshot.wallets = (input.wallets || []).map((w) => ({ name: String(w.name), balance: round(w.balance), currency: w.currency }));
  return snapshot;
}

/** Réunit les chiffres depuis la base (ledger.js) — le seul endroit qui lit les données pour l'assistant. */
export async function gatherAssistantInput(level = 'anonymous', monthKey = currentMonthKey()) {
  const [summary, previousSummary, categories, budgets, forecast, composition, wallets] = await Promise.all([
    computeMonthSummary(monthKey), computeMonthSummary(monthKeyOffset(monthKey, -1)), computeExpensesByCategory(monthKey),
    computeBudgetVsActual(monthKey), computeEndOfMonthForecast(), computeNetWorthComposition(), level === 'labels' ? getAllWalletBalances() : Promise.resolve([]),
  ]);
  const safe = computeSafeToSpend(forecast, budgets);
  return {
    level, monthKey, currency: summary.currency, summary, previousSummary, categories, budgets,
    safeToSpend: safe.safeToSpend, upcomingBillsTotal: safe.upcomingBillsTotal, composition,
    wallets: wallets.filter((w) => !w.archived),
  };
}

/* ---------- Bilan local (pur) : des phrases courtes, en mots simples ---------- */
/** `t` = fonction de traduction (clé = texte français, avec {paramètres}) ; `fmt(montant)` = montant formaté dans la devise. */
export function buildLocalReport(snapshot, t, fmt) {
  const lines = [];
  lines.push(t('Ce mois-ci vous avez reçu {income} et dépensé {expenses}.', { income: fmt(snapshot.income), expenses: fmt(snapshot.expenses) }));
  const prev = snapshot.previous_month?.expenses || 0;
  if (prev > 0 && snapshot.expenses > 0) {
    const pct = Math.round(((snapshot.expenses - prev) / prev) * 100);
    if (pct >= 10) lines.push(t("Vous dépensez {pct} % de plus que le mois dernier.", { pct }));
    else if (pct <= -10) lines.push(t('Vous dépensez {pct} % de moins que le mois dernier.', { pct: Math.abs(pct) }));
    else lines.push(t('Vos dépenses sont stables par rapport au mois dernier.'));
  }
  const top = (snapshot.expenses_by_category || [])[0];
  if (top && top.amount > 0) lines.push(t('Votre plus grosse dépense : {name} ({amount}).', { name: top.name === 'Other categories' ? t('Autres catégories') : top.name, amount: fmt(top.amount) }));
  const over = (snapshot.budgets || []).filter((b) => b.limit > 0 && b.spent > b.limit).sort((a, b) => (b.spent - b.limit) - (a.spent - a.limit)).slice(0, 2);
  for (const b of over) lines.push(t('Attention : le budget « {name} » est dépassé de {amount}.', { name: b.name === 'Other categories' ? t('Autres catégories') : b.name, amount: fmt(b.spent - b.limit) }));
  const near = (snapshot.budgets || []).filter((b) => b.limit > 0 && b.spent <= b.limit && b.spent / b.limit >= 0.85).slice(0, 1);
  for (const b of near) lines.push(t('Le budget « {name} » est presque atteint.', { name: b.name === 'Other categories' ? t('Autres catégories') : b.name }));
  if (snapshot.safe_to_spend_this_month != null) {
    lines.push(snapshot.safe_to_spend_this_month > 0
      ? t('Il vous reste {amount} à dépenser jusqu\'à la fin du mois.', { amount: fmt(snapshot.safe_to_spend_this_month) })
      : t('Attention : vos dépenses prévues dépassent l\'argent dont vous disposez ce mois-ci.'));
  }
  if (snapshot.balances.owed_to_me_total > 0) lines.push(t('On vous doit {amount} en tout.', { amount: fmt(snapshot.balances.owed_to_me_total) }));
  if (snapshot.balances.i_owe_total > 0) lines.push(t('Vous devez {amount} en tout.', { amount: fmt(snapshot.balances.i_owe_total) }));
  if (snapshot.income === 0 && snapshot.expenses === 0) return [t("Rien n'est encore noté ce mois-ci : ajoutez vos entrées et vos dépenses pour avoir un bilan.")];
  return lines;
}

/* ---------- Requête vers l'IA (pur) et lecture de la réponse ---------- */
export const AI_SYSTEM_PROMPT = [
  'You are a calm, plain-language money assistant inside a personal finance app. Many users read little: use short sentences, everyday words, no jargon.',
  'Use ONLY the figures in the JSON provided. Never invent a number, a date or a transaction. If the figures do not answer the question, say so simply.',
  'Amounts are in the currency given. Keep the answer under 120 words. Do not give investment, tax or legal advice; for those, suggest asking a qualified person.',
  'Never mention "JSON" or technical keys; speak about "your spending", "your budget", "what is left to spend".',
].join(' ');

export function buildAiRequest({ snapshot, question, language = 'fr', model = AI_DEFAULT_MODEL }) {
  const q = String(question || '').trim().slice(0, 300);
  const asked = q || 'Give me a short, friendly summary of my month and one useful tip.';
  return {
    url: AI_ENDPOINT,
    // Aucun en-tête d'authentification ici : la clé est ajoutée au dernier moment par askAssistant, jamais stockée dans une requête.
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: {
      model,
      max_tokens: 500,
      system: `${AI_SYSTEM_PROMPT} Answer in ${language === 'en' ? 'English' : 'French'}.`,
      messages: [{ role: 'user', content: `My figures (for the month ${snapshot.month}):\n${JSON.stringify(snapshot)}\n\nQuestion: ${asked}` }],
    },
  };
}

export function parseAiResponse(data) {
  const text = Array.isArray(data?.content) ? data.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim() : '';
  return text;
}

/** Message d'erreur lisible selon le code HTTP (le texte du service n'est jamais affiché tel quel : il pourrait contenir la clé). */
export function explainAiError(status, t) {
  if (status === 401 || status === 403) return t("La clé API est refusée. Vérifiez-la dans Paramètres, section Assistant.");
  if (status === 429) return t('Trop de demandes en peu de temps. Réessayez dans une minute.');
  if (status === 400) return t("Le service n'a pas accepté la demande (crédit insuffisant ou modèle indisponible). Vérifiez votre compte.");
  if (status >= 500) return t("Le service d'IA est momentanément indisponible. Réessayez plus tard.");
  return t('La demande a échoué. Réessayez.');
}

/** Envoie la question. Rejette avec une Error au message lisible. `fetchImpl` : injectable pour les tests. */
export async function askAssistant({ apiKey, snapshot, question, language, model, t, fetchImpl = (...a) => fetch(...a), timeoutMs = 40000 }) {
  if (!apiKey) throw new Error(t('Aucune clé API : ajoutez-la dans Paramètres, section Assistant.'));
  const req = buildAiRequest({ snapshot, question, language, model });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(req.url, { method: 'POST', headers: { ...req.headers, 'x-api-key': apiKey }, body: JSON.stringify(req.body), signal: controller.signal });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? t("Le service n'a pas répondu à temps. Réessayez.") : t('Pas de connexion à Internet, ou service injoignable.'));
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(explainAiError(response.status, t));
  let data;
  try { data = await response.json(); } catch { throw new Error(t('Réponse illisible du service.')); }
  const text = parseAiResponse(data);
  if (!text) throw new Error(t("Le service n'a rien répondu. Reformulez votre question."));
  return text;
}

/** Test de la clé : une demande minuscule SANS aucune donnée de l'utilisateur. */
export async function testAiKey({ apiKey, model, t, fetchImpl }) {
  const probe = { data_level: 'anonymous', month: '', currency: '', income: 0, expenses: 0, net_saving: 0, previous_month: { income: 0, expenses: 0 }, expenses_by_category: [], budgets: [], safe_to_spend_this_month: null, upcoming_bills_total: 0, balances: { spendable: 0, savings: 0, invested: 0, owed_to_me_total: 0, i_owe_total: 0 } };
  await askAssistant({ apiKey, snapshot: probe, question: 'Reply with the single word: ok', language: 'en', model, t, fetchImpl, timeoutMs: 20000 });
  return true;
}
