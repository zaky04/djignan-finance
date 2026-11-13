/* ==========================================================================
   Djignan Financial System — Prêt partagé (calculs purs, aucun accès à la base)
   Un prêt pris À MON NOM SEUL mais partagé avec d'autres (un frère, un ami, toute une classe…) : la dette envers
   le prêteur est entière (c'est moi qui réponds), et chaque participant me doit SA part, qu'il règle de deux façons :
   - il paie le prêteur directement (remboursement `source: 'participant'`, aucun de mes portefeuilles ne bouge) ;
   - il me remet l'argent (`debt.handedIn`, avec une entrée dans un de mes portefeuilles), puis c'est moi qui rembourse.
   Ce que chaque participant n'a pas encore réglé est une créance sur lui (comptée dans le patrimoine net, voir
   ledger.js) : tant que tout le monde paie, seule MA part pèse sur mon patrimoine.
   Données portées par la dette : `participants: [{ id, name, share }]` (les autres, sans moi) et
   `handedIn: [{ id, participantId, amount, date, transactionId }]`. Ma part = montant du prêt − Σ parts des autres.
   ========================================================================== */

const norm = (s) => String(s || '').trim().toLowerCase();

export const MAX_PARTICIPANTS = 300;

/** Montant écrit à la main : « 50000 », « 50 000 », « 50.000 » (séparateur de milliers à la française, groupes de 3 chiffres),
    « 1,234,567 » ou « 12,5 » (virgule décimale). Avant, « 50.000 » donnait 50 — une perte de magnitude silencieuse. */
export function parseAmountText(raw) {
  const s = String(raw || '').replace(/\s/g, '');
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, '')); // groupes de milliers
  return Number(s.replace(',', '.'));
}

/** Analyse la liste saisie (une personne par ligne : « Nom » ou « Nom : montant ») et répartit le prêt.
    Les lignes sans montant se partagent, avec moi, ce qui reste après les montants fixés ; ma part est donc
    égale à la leur. `existing` (participants déjà enregistrés) permet de garder le même identifiant à un nom
    inchangé, pour ne pas perdre ce qu'il a déjà versé. Renvoie { participants, myShare } ou { error }. */
export function parseParticipants(text, principal, decimals = 2, existing = []) {
  // Une ligne ne dépasse jamais 200 caractères (un nom + un montant) : au-delà, l'analyse ci-dessous deviendrait lente sur un
  // collage énorme (mesuré : 415 ms pour 40 000 espaces, croissance quadratique). Et au plus MAX_PARTICIPANTS lignes.
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim().slice(0, 200)).filter(Boolean);
  if (!lines.length) return { participants: [], myShare: principal };
  if (lines.length > MAX_PARTICIPANTS) return { error: 'too-many' };
  const factor = Math.pow(10, decimals);
  const round = (v) => Math.round(v * factor) / factor;
  const rows = [];
  for (const line of lines) {
    // « Nom : montant » — le dernier « : » ou « = » sépare le nom du montant (un nom peut contenir d'autres signes).
    const m = line.match(/^(.*?)\s*[:=]\s*([0-9][0-9\s.,]*)$/);
    if (!m && /[:=]/.test(line)) return { error: 'amount', line }; // « Awa : abc » : une faute de frappe, pas un nom
    const name = (m ? m[1] : line).trim().slice(0, 60);
    if (!name) return { error: 'name' };
    const fixed = m ? parseAmountText(m[2]) : null;
    if (m && !Number.isFinite(fixed)) return { error: 'amount', line };
    rows.push({ name, fixed });
  }
  const fixedTotal = rows.reduce((s, r) => s + (r.fixed || 0), 0);
  if (fixedTotal > principal + 0.005) return { error: 'too-much', fixedTotal };
  const floating = rows.filter((r) => r.fixed == null);
  // Moi + chaque ligne sans montant se partagent le reste.
  const equal = round((principal - fixedTotal) / (floating.length + 1));
  const used = new Set();
  const participants = rows.map((r) => {
    const prior = existing.find((p) => norm(p.name) === norm(r.name) && !used.has(p.id));
    if (prior) used.add(prior.id);
    return { id: prior?.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, name: r.name, share: r.fixed != null ? round(r.fixed) : equal };
  });
  const others = participants.reduce((s, p) => s + p.share, 0);
  return { participants, myShare: round(principal - others) };
}

/** Texte de saisie correspondant à des participants déjà enregistrés (pour rouvrir le formulaire). */
export function participantsToText(participants) {
  return (participants || []).map((p) => `${p.name} : ${p.share}`).join('\n');
}

/** Situation de chaque participant à une date : part, versé (direct au prêteur + remis à moi), reste à verser.
    `payments` = remboursements de la dette (seuls ceux de source « participant » comptent ici). */
export function participantStatuses(debt, payments, cutoffDate = null) {
  const list = Array.isArray(debt?.participants) ? debt.participants : [];
  if (!list.length) return [];
  const direct = payments.filter((p) => p.debtId === debt.id && p.source === 'participant' && (!cutoffDate || p.date <= cutoffDate));
  const handed = (debt.handedIn || []).filter((h) => !cutoffDate || h.date <= cutoffDate);
  // Parts abandonnées (`debt.waived`) : le participant ne paiera pas (tout ou partie). La créance sur lui baisse sans qu'aucun
  // argent ne bouge — c'est une perte pour moi, qui reste redevable de la dette entière envers le prêteur. Sans cela, la seule
  // façon de ne plus compter une part impayée était d'annuler TOUTE la dette (qui efface toutes les parts d'un coup).
  const waived = (debt.waived || []).filter((h) => !cutoffDate || h.date <= cutoffDate);
  const sum = (arr, id) => arr.filter((x) => x.participantId === id).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return list.map((p) => {
    const share = Number(p.share) || 0;
    const paidDirect = sum(direct, p.id);
    const paidHanded = sum(handed, p.id);
    const paid = paidDirect + paidHanded;
    const waivedAmount = sum(waived, p.id);
    return { id: p.id, name: p.name, share, paidDirect, paidHanded, paid, waived: waivedAmount, owed: Math.max(0, share - paid - waivedAmount) };
  });
}

/** Ce que les participants me doivent encore sur ce prêt, à une date (0 si le prêt n'a pas de participants, n'est
    pas encore commencé, ou a été annulé : la remise de dette efface aussi leur part). Alimente le patrimoine net. */
export function participantReceivablesAsOf(debt, payments, cutoffDate = null) {
  if (debt?.type !== 'debt' || !Array.isArray(debt.participants) || !debt.participants.length) return 0;
  if (cutoffDate && debt.startDate && debt.startDate > cutoffDate) return 0;
  if (debt.status === 'cancelled' && (!cutoffDate || !debt.cancelledAt || debt.cancelledAt <= cutoffDate)) return 0;
  return participantStatuses(debt, payments, cutoffDate).reduce((s, x) => s + x.owed, 0);
}
