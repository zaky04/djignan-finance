/* ==========================================================================
   Djignan Financial System — Intégrité des sauvegardes (fonctions pures)
   Deux protections complémentaires, sans aucun accès à la base :
   - une EMPREINTE (SHA-256) du contenu, écrite dans chaque export (`integrity`) et recalculée à l'import : un fichier abîmé,
     tronqué ou modifié à la main est repéré AVANT d'écraser quoi que ce soit ;
   - une « signature » de contenu (nombre de lignes par table, somme des transactions) qui permet de comparer ce qui est en base
     avec ce qu'on retrouverait en restaurant la sauvegarde (voir backup-verify.js).

   Limite à connaître : l'empreinte détecte l'accident et la modification maladroite, pas un faussaire déterminé — celui-ci peut
   recalculer l'empreinte, car il n'y a ni secret ni serveur. Les sauvegardes CHIFFRÉES sont, elles, authentifiées par AES-GCM : une
   modification du fichier fait échouer le déchiffrement. Les données importées restent de toute façon validées ligne par ligne
   (db.js, importAllData).
   ========================================================================== */

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Empreinte du contenu d'un export : calculée sur `JSON.stringify(stores)`, donc indépendante de la mise en forme du fichier
    (espaces, retours à la ligne) — le fichier relu puis re-sérialisé redonne exactement la même chaîne. */
export async function computeIntegrity(stores) {
  return { algo: 'SHA-256', checksum: await sha256Hex(JSON.stringify(stores)) };
}

/** 'ok' (empreinte présente et correcte), 'mismatch' (présente mais différente : fichier abîmé ou modifié) ou 'missing'
    (ancienne sauvegarde d'avant l'empreinte : rien à vérifier, on ne bloque pas). */
export async function checkIntegrity(data) {
  const integrity = data && data.integrity;
  if (!integrity || typeof integrity.checksum !== 'string') return 'missing';
  if (integrity.algo !== 'SHA-256') return 'missing'; // algorithme inconnu (version future) : on ne conclut rien
  const actual = (await computeIntegrity(data.stores)).checksum;
  return actual === integrity.checksum ? 'ok' : 'mismatch';
}

const cents = (n) => Math.round((Number(n) || 0) * 100);

/** Signature de contenu d'un ensemble de tables { nomDeTable: lignes[] } : nombre de lignes de chaque table, plus — pour les
    transactions — la somme de leurs montants en centimes (une somme entière : pas de dérive flottante). Les tables listées dans
    `skip` (réglages : ceux propres à l'appareil ne sont jamais exportés) sont ignorées. Pure. */
export function fingerprintStores(stores, { skip = [] } = {}) {
  const fingerprint = {};
  for (const name of Object.keys(stores || {}).sort()) {
    const rows = stores[name];
    if (skip.includes(name) || !Array.isArray(rows)) continue;
    fingerprint[name] = { rows: rows.length };
    if (name === 'transactions') fingerprint[name].amountCents = rows.reduce((sum, r) => sum + cents(r && r.amount), 0);
  }
  return fingerprint;
}

/** Différences entre deux signatures, sous forme de phrases courtes (vide = identiques). `labels` : nom de table → libellé. */
export function diffFingerprints(live, restored, labels = {}) {
  const issues = [];
  for (const name of [...new Set([...Object.keys(live), ...Object.keys(restored)])].sort()) {
    const a = live[name] || { rows: 0 };
    const b = restored[name] || { rows: 0 };
    const label = labels[name] || name;
    if (a.rows !== b.rows) issues.push(`${label} : ${a.rows} → ${b.rows}`);
    else if ((a.amountCents ?? 0) !== (b.amountCents ?? 0)) issues.push(`${label} : ${((a.amountCents ?? 0) / 100).toFixed(2)} → ${((b.amountCents ?? 0) / 100).toFixed(2)}`);
  }
  return issues;
}
