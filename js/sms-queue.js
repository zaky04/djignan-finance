/* ==========================================================================
   Djignan Financial System — File d'attente des SMS Mobile Money
   Un SMS de confirmation arrive n'importe quand ; on n'a pas toujours le temps de le valider sur le moment. L'utilisateur le
   PARTAGE vers l'appli (Android : menu Partager du SMS → Djignan) : au lieu de forcer l'import immédiat, il est gardé ici, et
   le tableau de bord rappelle « N SMS à valider » jusqu'à ce qu'ils soient importés ou ignorés. Un SMS partagé deux fois n'est
   gardé qu'une fois, et un import ne retire de la file que les SMS réellement présents dans le texte validé.

   Ce que ce module NE fait PAS : lire les SMS de l'appareil. Cela exigerait du code Android natif et la permission « lire les
   SMS », et les vrais formats d'Orange, Wave, MTN et Moov n'ont jamais été vérifiés (voir CLAUDE.md) : lire en continu des
   messages qu'on analyse mal serait pire que de ne rien lire. L'utilisateur garde la main : partager, puis valider.

   Réglage `smsInbox` : propre à l'appareil, jamais exporté (DEVICE_LOCAL_SETTING_KEYS, db.js) — un SMS contient des numéros de
   téléphone. Entrées gardées 30 jours au plus, 50 au maximum.
   ========================================================================== */

import { getSetting, setSetting } from './db.js';
import { uuid } from './utils.js';

const KEY = 'smsInbox';
export const SMS_INBOX_MAX = 50;
export const SMS_INBOX_KEEP_DAYS = 30;
const MAX_TEXT_LENGTH = 4000;

/** SMS en attente, du plus ancien au plus récent ; les entrées de plus de 30 jours sont ignorées (et disparaissent à la prochaine écriture). */
export async function getSmsInbox(now = Date.now()) {
  const stored = await getSetting(KEY, []);
  const cutoff = now - SMS_INBOX_KEEP_DAYS * 24 * 60 * 60 * 1000;
  return (Array.isArray(stored) ? stored : []).filter((e) => e && typeof e.text === 'string' && e.text && Number(e.receivedAt) > cutoff);
}

export async function getSmsInboxCount() {
  return (await getSmsInbox()).length;
}

/** Ajoute un texte partagé à la file. Renvoie l'entrée (nouvelle, ou celle déjà présente avec le même texte), ou null si le texte est vide. */
export async function queueSharedSms(text, now = Date.now()) {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT_LENGTH);
  if (!clean) return null;
  const list = await getSmsInbox(now);
  const existing = list.find((e) => e.text === clean);
  if (existing) return existing;
  const entry = { id: uuid(), text: clean, receivedAt: now };
  list.push(entry);
  await setSetting(KEY, list.slice(-SMS_INBOX_MAX));
  return entry;
}

/** Texte à mettre dans la zone d'import : tous les SMS en attente, séparés par une ligne vide (le séparateur que l'analyseur attend). */
export function smsInboxText(list) {
  return list.map((e) => e.text).join('\n\n');
}

/** Retire de la file les SMS dont le texte figure dans `importedText` (ce que l'utilisateur vient de valider). Ceux qu'il n'avait pas
    sous les yeux restent. Renvoie le nombre retiré. */
export async function removeImportedFromInbox(importedText, now = Date.now()) {
  const haystack = String(importedText || '').replace(/\r\n/g, '\n');
  const list = await getSmsInbox(now);
  const kept = list.filter((e) => !haystack.includes(e.text));
  if (kept.length !== list.length) await setSetting(KEY, kept);
  return list.length - kept.length;
}

/** Retire de la file les SMS pour lesquels `isResolved(entrée)` est vrai (tous leurs messages importés, ou déjà connus). Les autres restent :
    un SMS décoché, refusé pour sa devise ou absent de l'écran n'est jamais perdu. Renvoie le nombre retiré. */
export async function removeFromInboxWhere(isResolved, now = Date.now()) {
  const list = await getSmsInbox(now);
  const kept = list.filter((e) => !isResolved(e));
  if (kept.length !== list.length) await setSetting(KEY, kept);
  return list.length - kept.length;
}

export async function clearSmsInbox() {
  await setSetting(KEY, []);
}
