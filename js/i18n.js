/* ==========================================================================
   GeoFinance System — Internationalisation (FR/EN)
   Pas de framework i18n : la clé de traduction EST le texte français
   d'origine (pas d'identifiants artificiels à inventer/maintenir). t(fr)
   renvoie la traduction anglaise si la langue courante est 'en' ET qu'une
   entrée existe dans EN, sinon renvoie le français tel quel — donc un écran
   pas encore converti (chantier "par étapes", voir CLAUDE.md) reste
   simplement en français au lieu de planter ou d'afficher une clé brute.

   Deux façons de traduire :
   - Contenu généré par JS (innerHTML/textContent construits dans les
     modules) : envelopper chaque chaîne dans t('...').
   - Texte statique dans index.html (menu, barre du haut, écran de
     verrouillage) : attributs data-i18n="texte français" (contenu texte),
     data-i18n-aria-label / data-i18n-title / data-i18n-placeholder
     (attributs) — appliqués par applyStaticTranslations() au démarrage.
   ========================================================================== */

import { getSetting, setSetting } from './db.js';

let currentLang = 'fr';

export function getLanguage() {
  return currentLang;
}

/** Change la langue et recharge la page : le moyen le plus simple d'obtenir
    une traduction cohérente partout (chaque vue reconstruit déjà tout son
    HTML depuis zéro à chaque rendu — un rechargement complet évite d'avoir
    à rendre CHAQUE écran de l'app réactif à un changement de langue en
    cours de session, pour un gain quasi nul : changer de langue est rare). */
export async function setLanguage(lang) {
  await setSetting('language', lang);
  window.location.reload();
}

/** À appeler tôt au démarrage (avant tout rendu) : lit la langue choisie et
    traduit immédiatement le HTML statique (menu, écran de verrouillage...). */
export async function initI18n() {
  currentLang = await getSetting('language', 'fr');
  document.documentElement.lang = currentLang;
  applyStaticTranslations();
}

export function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.dataset.i18nTitle)); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder)); });
}

/** Traduit une chaîne française, avec substitution optionnelle de
    variables ({clé} dans la chaîne). Renvoie l'entrée si la langue courante
    est 'en' et qu'une traduction existe, sinon renvoie fr tel quel (repli
    sûr pour tout texte pas encore traduit) — les {clé} sont substitués dans
    les deux cas, pour ne pas avoir à dupliquer cette logique côté appelant.
    Le gabarit ({clé}) plutôt qu'une concaténation de fragments traduits
    séparément : le français et l'anglais n'ordonnent pas toujours leurs mots
    pareil ("Budget X à 90% de la limite" vs "Budget X at 90% of limit" — ça
    marche ici, mais rien ne le garantit en général), un gabarit entier par
    langue est la seule façon de le garantir. */
export function t(fr, vars) {
  let s = currentLang === 'en' ? (EN[fr] || fr) : fr;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

/** Dictionnaire FR → EN, construit écran par écran (voir CLAUDE.md pour
    l'état d'avancement). Une entrée absente = ce texte reste en français
    même en mode anglais — jamais une erreur, juste un chantier pas encore
    fait à cet endroit précis. */
const EN = {
  // ---------- Châssis de l'app (index.html : menu, barre du haut, bas) ----------
  'Tableau de bord': 'Dashboard',
  'Portefeuilles': 'Wallets',
  'Transactions': 'Transactions',
  'Budgets': 'Budgets',
  'Épargne': 'Savings',
  'Investissements': 'Investments',
  'Dettes & créances': 'Debts & receivables',
  'Outils': 'Tools',
  'Rapports': 'Reports',
  'Partage': 'Shared expenses',
  'Partage de dépenses': 'Shared expenses',
  'Comptes gardés': 'Kept accounts',
  'Paramètres': 'Settings',
  'Verrouiller': 'Lock',
  'Contribuer / contact': 'Contribute / contact',
  'Rechercher': 'Search',
  'Rechercher (Ctrl+K)': 'Search (Ctrl+K)',
  'Masquer les montants': 'Hide amounts',
  'Masquer/afficher les montants': 'Hide/show amounts',
  'Changer de thème': 'Change theme',
  'Mode sombre/clair': 'Dark/light mode',
  'Saisie express': 'Quick add',
  'Accueil': 'Home',
  'Plus': 'More',

  // ---------- Écran de verrouillage (auth.js) ----------
  'Créer votre code PIN': 'Create your PIN code',
  'Choisissez un code à 4-6 chiffres pour protéger vos données locales.': 'Choose a 4-6 digit code to protect your local data.',
  'Confirmez votre code PIN': 'Confirm your PIN code',
  'Ressaisissez le même code pour confirmer.': 'Re-enter the same code to confirm.',
  'Déverrouiller GeoFinance': 'Unlock GeoFinance',
  'Saisissez votre code PIN.': 'Enter your PIN code.',
  'Déverrouillage biométrique': 'Biometric unlock',
  'Valider le code': 'Confirm code',
  'Effacer': 'Clear',
  'Les codes ne correspondent pas. Recommencez.': "Codes don't match. Try again.",
  'Code PIN incorrect.': 'Incorrect PIN code.',
  'Échec de la vérification biométrique.': 'Biometric verification failed.',
  'Biométrie indisponible ou annulée.': 'Biometrics unavailable or cancelled.',
  'Trop de tentatives. Réessayez dans {s}s.': 'Too many attempts. Try again in {s}s.',

  // ---------- Tableau de bord (dashboard.js) ----------
  'Bonjour': 'Good morning',
  'Bonsoir': 'Good evening',
  'Budget mensuel alloué': 'Monthly budget allocated',
  'Reste à vivre': 'Safe to spend',
  'Patrimoine net global': 'Total net worth',
  'Créances & dettes': 'Receivables & debts',
  'Créances': 'Receivables',
  'Dettes': 'Debts',
  'Entrées (mois)': 'Income (month)',
  'Sorties (mois)': 'Expenses (month)',
  'Épargne nette': 'Net savings',
  'Cash-flow': 'Cash flow',
  'Catégories à surveiller': 'Categories to watch',
  'Prochaines échéances': 'Upcoming bills',
  'Dépenses par catégorie': 'Expenses by category',
  'Évolution de la valeur nette': 'Net worth trend',
  'Budget vs réel': 'Budget vs actual',
  'Répartition des revenus du mois': 'This month’s income breakdown',
  'Transactions récentes': 'Recent transactions',
  'Voir tout': 'See all',
  'Voir le détail des budgets →': 'See budget details →',
  'Composition du patrimoine': 'Net worth composition',
  'Solde net :': 'Net balance:',
  'Aucune échéance à venir ce mois-ci.': 'No upcoming bills this month.',
  '{amount} vs mois dernier': '{amount} vs last month',
  'Taux de change non confirmé pour {codes} (valeur 1:1 par défaut) — le patrimoine net affiché est probablement faux. À corriger dans Portefeuilles.':
    'Unconfirmed exchange rate for {codes} (defaulted to 1:1) — the net worth shown is probably wrong. Fix it in Wallets.',
  'Budget "{label}" dépassé ({pct}% utilisé)': 'Budget "{label}" exceeded ({pct}% used)',
  'Budget "{label}" à {pct}% de la limite': 'Budget "{label}" at {pct}% of limit',
  'Sans catégorie': 'No category',
  'Scindée': 'Split',
  'Aucune transaction pour le moment. Utilisez « Saisie express » pour commencer.': 'No transactions yet. Use "Quick add" to get started.',
  "Aucun budget défini pour l'instant.": 'No budget set yet.',
  'Après budgets réservés et échéances à venir': 'After reserved budgets and upcoming bills',
  '⚠ Dépenses prévues supérieures aux liquidités disponibles': '⚠ Planned expenses exceed available cash',
  "Pas encore assez d'historique": 'Not enough history yet',
  'Reste {amount} ce mois-ci': '{amount} left this month',
  'Dépassé de {amount}': 'Over by {amount}',
  '{spent} dépensé sur catégories budgétées · {remainingLabel}': '{spent} spent on budgeted categories · {remainingLabel}',
  'Aucun budget défini pour ce mois — allez dans Budgets pour en attribuer': 'No budget set for this month — go to Budgets to allocate one',
  '{amount} non affecté': '{amount} unallocated',
  'Budgets > revenu de {amount}': 'Budgets exceed income by {amount}',
};
