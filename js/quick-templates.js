/* ==========================================================================
   Djignan Financial System — Favoris (modèles de saisie à un geste)
   Un favori = une dépense/recette qu'on refait souvent (le taxi du matin, le pain, le forfait…) :
   type, portefeuille, catégorie, libellé et, si fixe, le montant. Stockés dans les réglages
   (clé « quickTemplates ») : aucun nouveau store IndexedDB, et ils suivent donc les sauvegardes.

   Deux usages (UI dans transactions.js et dashboard.js) :
   - Saisie express : un favori pré-remplit le formulaire ;
   - Tableau de bord : un favori AVEC montant s'enregistre en un seul toucher (annulable).

   « Suggestions » : opérations répétées trouvées dans l'historique, proposées sans configuration.
   ========================================================================== */

import { STORES, dbGetAll, dbAdd, dbDelete, getSetting, setSetting, logAudit } from './db.js';
import { isDailyWallet, isInvestmentMovementExcluded } from './ledger.js';
import { uuid, todayISO, safeNumber, localISODate } from './utils.js';

const KEY = 'quickTemplates';
const MAX_TEMPLATES = 12;

export async function getTemplates() {
  const list = await getSetting(KEY, []);
  return Array.isArray(list) ? list.filter((x) => x && typeof x === 'object' && x.id) : [];
}

function sameShape(a, b) {
  return a.type === b.type && a.walletId === b.walletId && (a.categoryId || '') === (b.categoryId || '')
    && (a.note || '').trim().toLowerCase() === (b.note || '').trim().toLowerCase();
}

/** Ajoute un favori (ou met à jour le montant/libellé du même favori s'il existe déjà).
    Renvoie `{ template, created }`, ou `null` si la liste est pleine. */
export async function addTemplate({ type, walletId, categoryId, amount, note, label }) {
  const list = await getTemplates();
  const candidate = {
    id: uuid(), type, walletId, categoryId: categoryId || null,
    amount: amount > 0 ? safeNumber(amount) : null,
    note: (note || '').trim().slice(0, 140),
    label: ((label || note || '').trim() || '—').slice(0, 40),
  };
  const existing = list.find((x) => sameShape(x, candidate));
  if (existing) {
    existing.amount = candidate.amount;
    existing.label = candidate.label;
    await setSetting(KEY, list);
    return { template: existing, created: false };
  }
  if (list.length >= MAX_TEMPLATES) return null;
  list.push(candidate);
  await setSetting(KEY, list);
  return { template: candidate, created: true };
}

export async function removeTemplate(id) {
  await setSetting(KEY, (await getTemplates()).filter((x) => x.id !== id));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Opérations répétées (≥ 3 fois en 120 jours, même libellé/catégorie/portefeuille), classées par
    fréquence. Montant proposé = médiane (insensible à une valeur aberrante). Exclut ce qui est déjà
    un favori. */
export async function computeFrequentSuggestions({ limit = 4, today = new Date() } = {}) {
  const [transactions, wallets, categories, templates] = await Promise.all([
    dbGetAll(STORES.TRANSACTIONS), dbGetAll(STORES.WALLETS), dbGetAll(STORES.CATEGORIES), getTemplates(),
  ]);
  const usable = new Set(wallets.filter(isDailyWallet).map((w) => w.id));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 120);
  const sinceIso = localISODate(since);
  const groups = new Map();
  for (const tx of transactions) {
    if ((tx.type !== 'expense' && tx.type !== 'income') || tx.debtId || isInvestmentMovementExcluded(tx)) continue;
    if (!tx.note || !tx.note.trim() || !usable.has(tx.walletId) || !(tx.amount > 0) || (tx.date || '') < sinceIso) continue;
    const key = [tx.type, tx.walletId, tx.categoryId || '', tx.note.trim().toLowerCase()].join('|');
    const g = groups.get(key) || { type: tx.type, walletId: tx.walletId, categoryId: tx.categoryId || null, note: tx.note.trim(), amounts: [] };
    g.amounts.push(tx.amount);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.amounts.length >= 3)
    .map((g) => ({
      id: `suggestion-${uuid()}`, suggestion: true, type: g.type, walletId: g.walletId, categoryId: g.categoryId,
      note: g.note, label: (g.note || categoryName.get(g.categoryId) || '—').slice(0, 40),
      amount: median(g.amounts), count: g.amounts.length,
    }))
    .filter((s) => !templates.some((x) => sameShape(x, s)))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Enregistre un favori comme transaction d'aujourd'hui, en un geste. Renvoie l'enregistrement créé,
    ou `null` si le favori n'a pas de montant ou si son portefeuille n'existe plus / n'est plus courant. */
export async function recordTemplateNow(template) {
  if (!(template.amount > 0)) return null;
  const wallet = (await dbGetAll(STORES.WALLETS)).find((w) => w.id === template.walletId);
  if (!wallet || !isDailyWallet(wallet)) return null;
  const record = {
    id: uuid(), type: template.type, walletId: template.walletId, targetWalletId: null,
    categoryId: template.categoryId || null, amount: template.amount, date: todayISO(),
    note: template.note || '', tags: [], reconciled: false, createdAt: new Date().toISOString(),
  };
  await dbAdd(STORES.TRANSACTIONS, record);
  await logAudit({ entityType: 'transaction', entityId: record.id, action: 'create', after: record, note: 'favori' });
  return record;
}

/** Annule un enregistrement créé par recordTemplateNow(). */
export async function undoRecordedTemplate(record) {
  await dbDelete(STORES.TRANSACTIONS, record.id);
  await logAudit({ entityType: 'transaction', entityId: record.id, action: 'delete', before: record, note: 'favori (annulation)' });
}
