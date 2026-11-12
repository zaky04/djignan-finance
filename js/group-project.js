/* ==========================================================================
   Djignan Financial System — Projet collectif (calculs purs, aucun accès à la base)
   Une dépense à plusieurs (le voyage d'un parent, un mariage, un deuil…) dont chacun paie ce qu'il peut, sans part
   fixée d'avance. Le projet n'est qu'un SUIVI : « qui a payé combien, et combien reste-t-il à couvrir ».
   Une participation est de trois sortes (`kind`) :
   - `other`  : quelqu'un d'autre a payé. Suivi seulement : aucun de mes portefeuilles ne bouge, rien dans mon patrimoine ;
   - `wallet` : j'ai payé depuis un de mes portefeuilles (une vraie dépense exceptionnelle y a été créée, `transactionId`) ;
   - `loan`   : j'ai payé avec un prêt (le prêt, `debtId`, et sa dépense exceptionnelle, `transactionId`, ont été créés).
   Données : { id, name, target, currency, categoryId, createdAt, contributions: [{ id, who, isMe, kind, amount, date, note,
   transactionId?, debtId? }] }, rangées dans le réglage `groupProjects` (voir group-projects.js).
   ========================================================================== */

const norm = (s) => String(s || '').trim().toLowerCase();

/** Totaux d'un projet : collecté, reste à couvrir (négatif = objectif dépassé), qui a payé combien (le plus gros
    d'abord) et ma participation, séparée entre portefeuille et prêt. */
export function projectTotals(project) {
  const contributions = Array.isArray(project?.contributions) ? project.contributions : [];
  const target = Number(project?.target) || 0;
  const people = new Map();
  const mine = { wallet: 0, loan: 0, total: 0 };
  let collected = 0;
  for (const c of contributions) {
    const amount = Number(c.amount) || 0;
    collected += amount;
    const key = c.isMe ? '\u0000me' : norm(c.who);
    const row = people.get(key) || { name: c.isMe ? (c.who || '') : String(c.who || '').trim(), isMe: !!c.isMe, total: 0, count: 0 };
    row.total += amount;
    row.count += 1;
    people.set(key, row);
    if (c.isMe) {
      mine.total += amount;
      if (c.kind === 'loan') mine.loan += amount; else mine.wallet += amount;
    }
  }
  const byPerson = [...people.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    target, collected, remaining: target - collected,
    percent: target > 0 ? Math.min(100, (collected / target) * 100) : 0,
    byPerson, mine,
  };
}

/** Noms déjà utilisés dans tous les projets (hors moi), pour la saisie rapide d'une participation. */
export function knownContributors(projects) {
  const seen = new Map();
  for (const p of projects || []) {
    for (const c of p.contributions || []) {
      if (c.isMe) continue;
      const key = norm(c.who);
      if (key && !seen.has(key)) seen.set(key, String(c.who).trim());
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
