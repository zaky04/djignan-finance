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
     data-i18n-aria-label / data-i18n-title / data-i18n-placeholder / data-i18n-alt
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
  document.querySelectorAll('[data-i18n-alt]').forEach((el) => { el.setAttribute('alt', t(el.dataset.i18nAlt)); });
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
  'Comptes gardés': 'Managed accounts',
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

  // ---------- Catégories par défaut (DEFAULT_CATEGORIES, db.js) ----------
  // Traduites au moment de la CRÉATION (seedDefaultsIfNeeded/seedDemoData), jamais après coup : une
  // catégorie déjà créée par un utilisateur (par défaut ou renommée) reste telle quelle même s'il
  // change de langue ensuite — seule l'interface se traduit, jamais les données déjà en place.
  'Salaire': 'Salary',
  'Autres revenus': 'Other income',
  'Alimentation': 'Food',
  'Logement': 'Housing',
  'Transport': 'Transport',
  'Loisirs': 'Leisure',
  'Santé': 'Health',
  'Abonnements': 'Subscriptions',
  'Autres dépenses': 'Other expenses',

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

  // ---------- Transactions (transactions.js + template Saisie express, index.html) ----------
  'Sélection multiple': 'Multi-select',
  'Rapprochement': 'Reconciliation',
  '+ Nouvelle transaction': '+ New transaction',
  'Fermer': 'Close',
  'Dépense': 'Expense',
  'Recette': 'Income',
  'Transfert': 'Transfer',
  'Montant': 'Amount',
  'Portefeuille': 'Wallet',
  'Vers le portefeuille': 'To wallet',
  'Catégorie': 'Category',
  'Diviser en plusieurs catégories': 'Split into multiple categories',
  '+ Ajouter une catégorie': '+ Add a category',
  'Total : 0.00': 'Total: 0.00',
  'Date': 'Date',
  'Note (optionnel)': 'Note (optional)',
  'Ex: Courses supermarché': 'E.g. Grocery shopping',
  'Étiquettes (optionnel, séparées par des virgules)': 'Tags (optional, comma-separated)',
  'Ex: pro, remboursable': 'E.g. work, reimbursable',
  'Justificatif photo (optionnel)': 'Receipt photo (optional)',
  'Aperçu du justificatif': 'Receipt preview',
  'Scanner le montant': 'Scan amount',
  'Retirer le justificatif': 'Remove receipt',
  'Enregistrer': 'Save',
  'Analyse en cours…': 'Scanning…',
  "Montant détecté : {amount} — vérifiez avant d'enregistrer.": 'Detected amount: {amount} — check it before saving.',
  'Montant détecté : {amount} — ajoutez-le manuellement à une ligne (mode scindé).': 'Detected amount: {amount} — add it manually to a line (split mode).',
  'Aucun montant détecté sur cette photo, saisissez-le manuellement.': 'No amount detected on this photo, enter it manually.',
  'Échec de la lecture automatique. Saisissez le montant manuellement.': 'Automatic reading failed. Enter the amount manually.',
  'Total : {sum}': 'Total: {sum}',
  'Retirer': 'Remove',
  'Revenir à une seule catégorie': 'Back to a single category',
  "Créez un portefeuille d'abord": 'Create a wallet first',
  'Aucune catégorie (créez-en dans Budgets)': 'No category (create one in Budgets)',
  'Modifier la transaction': 'Edit transaction',
  'Transfert entre portefeuilles': 'Transfer between wallets',
  'Créez au moins un portefeuille avant de saisir une transaction.': 'Create at least one wallet before entering a transaction.',
  'Choisissez deux portefeuilles différents.': 'Choose two different wallets.',
  'Ajoutez au moins deux lignes avec un montant.': 'Add at least two lines with an amount.',
  'Transaction scindée': 'Split transaction',
  '{count} transactions créées (scindées).': '{count} transactions created (split).',
  'Transaction modifiée.': 'Transaction updated.',
  'Transaction enregistrée.': 'Transaction saved.',
  'Dépense {ratio}x plus élevée que votre moyenne habituelle pour {catName} (~{average}).': 'Expense {ratio}x higher than your usual average for {catName} (~{average}).',
  'Dépense {ratio}x plus élevée que votre moyenne habituelle (~{average}).': 'Expense {ratio}x higher than your usual average (~{average}).',
  'Pointer': 'Reconcile',
  'Date du relevé': 'Statement date',
  'Solde de clôture du relevé': 'Statement closing balance',
  "Calculer l'écart": 'Calculate the difference',
  'Rapprochement bancaire': 'Bank reconciliation',
  'Solde pointé (app)': 'Reconciled balance (app)',
  'Solde du relevé': 'Statement balance',
  'Écart': 'Difference',
  'Rapprochement exact, aucun écart.': 'Exact match, no difference.',
  "{count} transaction(s) non pointée(s) jusqu'à cette date — pointez celles qui apparaissent sur le relevé pour résorber l'écart :":
    "{count} unreconciled transaction(s) up to this date — reconcile the ones that appear on your statement to resolve the difference:",
  "Aucune transaction non pointée sur cette période — l'écart provient peut-être d'une transaction manquante ou d'une date de relevé incorrecte.":
    'No unreconciled transactions in this period — the difference may come from a missing transaction or an incorrect statement date.',
  'Pointée (rapprochement assisté)': 'Reconciled (assisted reconciliation)',
  'Voir le justificatif': 'View receipt',
  'Pointée (cliquer pour annuler)': 'Reconciled (click to undo)',
  'Marquer comme pointée': 'Mark as reconciled',
  'Modifier': 'Edit',
  'Supprimer': 'Delete',
  'Aucune transaction pour ces filtres.': 'No transactions for these filters.',
  'Nouvelle catégorie pour {count} transaction(s)': 'New category for {count} transaction(s)',
  'Appliquer': 'Apply',
  'Changer la catégorie': 'Change category',
  'Catégorisation groupée': 'Bulk categorization',
  '{count} transaction(s) recatégorisée(s).': '{count} transaction(s) recategorized.',
  'Pointée (groupé)': 'Reconciled (bulk)',
  'Dépointée (groupé)': 'Unreconciled (bulk)',
  '{count} transaction(s) mise(s) à jour.': '{count} transaction(s) updated.',
  'Supprimer {count} transaction(s) sélectionnée(s) ?': 'Delete {count} selected transaction(s)?',
  'Suppression groupée': 'Bulk deletion',
  '{count} transaction(s) supprimée(s).': '{count} transaction(s) deleted.',
  // 'Annuler' sert à la fois de bouton "Annuler" (confirmDialog, utils.js — pas encore traduit) et de
  // libellé "Annuler" sur les toasts d'annulation après suppression (ici et dans plusieurs autres
  // modules) — le même mot français couvre naturellement Cancel et Undo, mais la clé de traduction est
  // unique. Choix fait ici : 'Undo', car c'est l'usage qu'on câble activement dans ce lot (toasts de
  // restauration). Si confirmDialog est traduit un jour, NE PAS le faire passer par cette même clé
  // 'Annuler' (il lui faudrait 'Cancel') — utiliser un mécanisme séparé pour son cancelText.
  'Annuler': 'Undo',
  'Restaurée (annulation groupée)': 'Restored (bulk undo)',
  '{count} transaction(s) restaurée(s).': '{count} transaction(s) restored.',
  '{count} sélectionnée(s)': '{count} selected',
  'Tout désélectionner': 'Deselect all',
  'Tout sélectionner': 'Select all',
  'Marquer pointées': 'Mark as reconciled',
  'Marquer non pointées': 'Mark as unreconciled',
  'Mois précédent': 'Previous month',
  'Mois suivant': 'Next month',
  'Tous les portefeuilles': 'All wallets',
  'Toutes catégories': 'All categories',
  'Tous types': 'All types',
  'Recettes': 'Income',
  'Dépenses': 'Expenses',
  'Transferts': 'Transfers',
  'Rapprochement : toutes': 'Reconciliation: all',
  'Pointées': 'Reconciled',
  'Non pointées': 'Unreconciled',
  'Justificatif': 'Receipt',
  'Pointée': 'Reconciled',
  'Dépointée': 'Unreconciled',
  'Supprimer cette transaction ?': 'Delete this transaction?',
  'Transaction supprimée.': 'Transaction deleted.',
  'Transaction restaurée.': 'Transaction restored.',
  'Restaurée (annulation)': 'Restored (undo)',
};
