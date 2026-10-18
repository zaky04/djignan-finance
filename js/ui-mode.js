/* ==========================================================================
   Djignan Financial System — Mode d'affichage : simple (« comme un cahier ») ou complet
   Quelqu'un qui vient d'un cahier veut noter ce qui rentre et ce qui sort, voir son solde et qui lui
   doit de l'argent — pas des enveloppes, des investissements ni des simulateurs. Le mode simple
   masque ces écrans (ils restent à un réglage de distance) ; le mode complet est l'appli entière.

   Réglage `uiMode` : absent = « complet » (une installation existante ne change JAMAIS toute seule),
   « simple » est posé au tout premier lancement (assistant de configuration, app.js).
   L'affichage est piloté en CSS par body[data-ui-mode] — voir la fin de styles.css.
   ========================================================================== */

import { getSetting, setSetting } from './db.js';
import { t } from './i18n.js';

/** Écrans proposés dans le menu « Plus » en mode simple (le reste est masqué). */
export const SIMPLE_MORE_VIEWS = ['wallets', 'debts', 'settings'];

export async function getUiMode() {
  return (await getSetting('uiMode', 'full')) === 'simple' ? 'simple' : 'full';
}

/** Applique le mode courant : attribut CSS + 4e bouton de la barre mobile (Budgets ↔ Dettes). */
export async function applyUiMode() {
  const mode = await getUiMode();
  document.body.dataset.uiMode = mode;
  const slot = document.querySelector('.bottom-nav-item[data-slot="budgets"]');
  if (slot) {
    const label = slot.querySelector('span');
    const target = mode === 'simple' ? 'debts' : 'budgets';
    const text = mode === 'simple' ? 'Dettes' : 'Budgets';
    slot.dataset.viewTarget = target;
    if (label) { label.dataset.i18n = text; label.textContent = t(text); }
  }
  return mode;
}

export async function setUiMode(mode) {
  await setSetting('uiMode', mode === 'simple' ? 'simple' : 'full');
  return applyUiMode();
}
