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

/** Le point du projet en texte, à envoyer sur WhatsApp ou par SMS à la famille : objectif, collecté, reste à couvrir et
    « qui a payé combien ». `translate`, `format` (montant) et `formatDay` (date) sont fournis par l'appelant : le calcul reste
    pur et testable. Ne contient que ce que l'utilisateur a saisi dans le projet. */
export function projectAsText(project, { translate, format, formatDay, senderName = '', today = '' }) {
  const totals = projectTotals(project);
  const cur = project.currency;
  const lines = [String(project.name || '')];
  lines.push(translate('Objectif : {amount}', { amount: format(totals.target, cur) }));
  lines.push(translate('Collecté : {amount} ({pct} %)', { amount: format(totals.collected, cur), pct: Math.round(totals.percent) }));
  if (totals.remaining < -0.005) lines.push(translate('Objectif dépassé de {amount}', { amount: format(Math.abs(totals.remaining), cur) }));
  else if (totals.remaining <= 0.005) lines.push(translate('Objectif atteint.'));
  else lines.push(translate('Reste à couvrir : {amount}', { amount: format(totals.remaining, cur) }));
  if (totals.byPerson.length) {
    lines.push('', translate('Qui a payé combien'));
    for (const p of totals.byPerson) lines.push(`• ${p.name || translate('Moi')} : ${format(p.total, cur)}`);
  }
  const footer = [today ? translate('Point au {date}', { date: formatDay(today) }) : '', senderName ? `— ${senderName}` : ''].filter(Boolean).join(' ');
  if (footer) lines.push('', footer);
  return lines.join('\n');
}

/** Liste de projets lisible quoi qu'il y ait dans le réglage (sauvegarde corrompue ou forgée) : les éléments qui ne sont
    pas des objets à identifiant texte sont ignorés, et `contributions` est toujours un tableau d'objets. Sans cela, un seul
    élément nul faisait planter tout l'écran « Partage de dépenses ». */
export function sanitizeProjects(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p) => p && typeof p === 'object' && !Array.isArray(p) && typeof p.id === 'string' && p.id)
    .map((p) => ({ ...p, contributions: (Array.isArray(p.contributions) ? p.contributions : []).filter((c) => c && typeof c === 'object' && typeof c.id === 'string') }));
}

/** Fusion de deux listes de projets (import en mode « fusionner ») : les projets sont réunis par identifiant. Pour un
    projet présent des deux côtés, la version locale (nom, objectif) est gardée et on y ajoute les participations qu'elle
    n'avait pas encore. Avant, la sauvegarde importée REMPLAÇAIT toute la liste locale (un seul réglage = tout écrasé). */
export function mergeProjectLists(local, imported) {
  const mine = sanitizeProjects(local);
  const theirs = sanitizeProjects(imported);
  const byId = new Map(mine.map((p) => [p.id, p]));
  for (const p of theirs) {
    const existing = byId.get(p.id);
    if (!existing) { byId.set(p.id, p); continue; }
    const known = new Set(existing.contributions.map((c) => c.id));
    const extra = p.contributions.filter((c) => !known.has(c.id));
    if (extra.length) byId.set(p.id, { ...existing, contributions: [...existing.contributions, ...extra] });
  }
  return [...byId.values()];
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
