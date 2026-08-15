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

  // ---------- Budgets (budgets.js + en-tête index.html) ----------
  '+ Catégorie de budget': '+ Budget category',
  'Budgets du mois': 'Monthly budgets',
  'Budgets annuels': 'Annual budgets',
  'Catégories': 'Categories',
  'Récurrences': 'Recurring',
  'Règles': 'Rules',
  'Enveloppe : {sign}{amount} reporté du mois dernier · budget effectif {effective}':
    'Envelope: {sign}{amount} carried over from last month · effective budget {effective}',
  'Enveloppe : {sign}{amount} reporté du mois dernier': 'Envelope: {sign}{amount} carried over from last month',
  'Enveloppe': 'Envelope',
  'Budget': 'Budget',
  'Pas de limite': 'No limit',
  'Reprendre les budgets du mois dernier': 'Reuse last month\'s budgets',
  'Solde prévisionnel de fin de mois': 'Projected end-of-month balance',
  'Solde actuel : {amount} · {count} échéance(s) à venir ce mois-ci': 'Current balance: {amount} · {count} upcoming bill(s) this month',
  'Solde actuel : {amount}': 'Current balance: {amount}',
  "Aucune catégorie de dépense. Créez-en dans l'onglet Catégories.": 'No expense category. Create one in the Categories tab.',
  '{count} budget(s) repris du mois dernier.': '{count} budget(s) reused from last month.',
  'Budget mis à jour.': 'Budget updated.',
  'Année précédente': 'Previous year',
  'Année suivante': 'Next year',
  '{spent} dépensé sur {pct} du budget annuel total attribué ({total}).': '{spent} spent, {pct} of the total annual budget allocated ({total}).',
  'Budget annuel mis à jour.': 'Annual budget updated.',
  'Nom': 'Name',
  'Icône': 'Icon',
  'Couleur': 'Color',
  'Mode enveloppe : reporter le solde non dépensé (ou le dépassement) sur le mois suivant':
    'Envelope mode: carry the unspent balance (or overspend) over to the next month',
  'Type': 'Type',
  'Catégorie parente (optionnel)': 'Parent category (optional)',
  '— Catégorie principale —': '— Main category —',
  'Créer': 'Create',
  'Modifier la catégorie': 'Edit category',
  'Nouvelle sous-catégorie': 'New subcategory',
  'Nouvelle catégorie': 'New category',
  'Catégorie mise à jour.': 'Category updated.',
  'Catégorie créée.': 'Category created.',
  'Ajouter une sous-catégorie': 'Add a subcategory',
  'Aucune catégorie.': 'No category.',
  'Catégories de dépenses': 'Expense categories',
  'Catégories de recettes': 'Income categories',
  "Supprimez d'abord les sous-catégories.": 'Delete the subcategories first.',
  'Supprimer la catégorie "{name}" ? Les transactions déjà enregistrées resteront mais afficheront "Sans catégorie".':
    'Delete category "{name}"? Transactions already recorded will remain but will show "No category".',
  'Catégorie supprimée.': 'Category deleted.',
  'Ex: Loyer, Netflix, Salaire…': 'E.g. Rent, Netflix, Salary…',
  'Fréquence': 'Frequency',
  'Mensuelle': 'Monthly',
  'Hebdomadaire': 'Weekly',
  'Annuelle': 'Yearly',
  'Prochaine échéance': 'Next due date',
  'Créer la récurrence': 'Create the recurring entry',
  'Modifier la récurrence': 'Edit recurring entry',
  'Nouvelle récurrence': 'New recurring entry',
  'Aucune catégorie': 'No category',
  "Créez au moins un portefeuille avant d'ajouter une récurrence.": 'Create at least one wallet before adding a recurring entry.',
  'Récurrence mise à jour.': 'Recurring entry updated.',
  'Récurrence créée.': 'Recurring entry created.',
  'Inactif': 'Inactive',
  'Prochaine échéance : {date}': 'Next due date: {date}',
  'Désactiver': 'Deactivate',
  'Activer': 'Activate',
  'Dépenses &amp; recettes récurrentes': 'Recurring expenses &amp; income',
  '+ Nouvelle récurrence': '+ New recurring entry',
  'Aucune récurrence. Ajoutez vos abonnements et factures régulières pour anticiper votre solde de fin de mois.':
    'No recurring entries. Add your subscriptions and regular bills to anticipate your end-of-month balance.',
  'Supprimer la récurrence "{name}" ? Les transactions déjà générées seront conservées.':
    'Delete recurring entry "{name}"? Transactions already generated will be kept.',
  'Récurrence supprimée.': 'Recurring entry deleted.',
  'Catégorie supprimée': 'Deleted category',
  'Nouvelle règle': 'New rule',
  "Quand la note d'une dépense contient ce texte, la catégorie est présélectionnée automatiquement en Saisie express.":
    'When an expense note contains this text, the category is automatically preselected in Quick add.',
  'Texte à repérer': 'Text to match',
  'Ex: netflix': 'E.g. netflix',
  'Ajouter': 'Add',
  'Règles actives': 'Active rules',
  'Aucune règle. Ajoutez-en une ci-dessus pour automatiser la catégorisation.': 'No rules. Add one above to automate categorization.',
  'Règle créée.': 'Rule created.',
  'Règle supprimée.': 'Rule deleted.',
  // 'Récurrence : {name}' est le préfixe posé sur la note de chaque transaction générée
  // automatiquement — RECURRING_NOTE_PREFIXES (ledger.js) reconnaît les deux variantes (FR/EN) au
  // moment de la lecture, une transaction déjà créée ne se retraduit jamais rétroactivement.
  'Récurrence : {name}': 'Recurrence: {name}',
  'Générée automatiquement (récurrence)': 'Automatically generated (recurring)',

  // ---------- Épargne (savings.js + en-tête index.html) ----------
  "+ Objectif d'épargne": '+ Savings goal',
  'Échéance : {date}': 'Due date: {date}',
  'Ajouter une contribution': 'Add a contribution',
  'Désarchiver': 'Unarchive',
  'Archiver': 'Archive',
  "Nom de l'objectif": 'Goal name',
  "Ex: Fonds d'urgence, Voyage, Apport immobilier…": 'E.g. Emergency fund, Trip, Down payment…',
  'Montant cible': 'Target amount',
  'Montant déjà épargné': 'Amount already saved',
  'Devise': 'Currency',
  'Date cible (optionnel)': 'Target date (optional)',
  "Créer l'objectif": 'Create the goal',
  "Modifier l'objectif": 'Edit goal',
  "Nouvel objectif d'épargne": 'New savings goal',
  'Objectif mis à jour.': 'Goal updated.',
  'Objectif créé.': 'Goal created.',
  'Montant à ajouter': 'Amount to add',
  'Contribution — {name}': 'Contribution — {name}',
  'Contribution de {amount}': 'Contribution of {amount}',
  'Contribution ajoutée.': 'Contribution added.',
  'ARCHIVÉS': 'ARCHIVED',
  "Aucun objectif d'épargne. Créez-en un pour visualiser votre progression.": 'No savings goal. Create one to visualize your progress.',
  'Objectif archivé.': 'Goal archived.',
  'Objectif désarchivé.': 'Goal unarchived.',
  'Supprimer définitivement l\'objectif "{name}" ?': 'Permanently delete goal "{name}"?',
  'Objectif supprimé.': 'Goal deleted.',
  'Valeur nette': 'Net worth',

  // ---------- Investissements (investments.js + en-tête index.html) ----------
  '+ Investissement': '+ Investment',
  'Immobilier': 'Real estate',
  'Actions': 'Stocks',
  'Flotte / Transport': 'Fleet / Transport',
  'Business': 'Business',
  'Obligations': 'Bonds',
  'Cryptomonnaies': 'Cryptocurrencies',
  'Autre': 'Other',
  'Apport': 'Contribution',
  'Retrait': 'Withdrawal',
  'Dividende': 'Dividend',
  'Valorisation': 'Valuation',
  'Historique / Ajouter': 'History / Add',
  'Capital net investi': 'Net capital invested',
  'Valeur actuelle': 'Current value',
  'Dividendes perçus': 'Dividends received',
  'Plus/moins-value + revenus': 'Gain/loss + income',
  'ROI global': 'Overall ROI',
  'Rendement annualisé': 'Annualized yield',
  'Ex: Appartement Cocody, Actions Total…': 'E.g. Downtown apartment, Stock shares…',
  "Classe d'actif": 'Asset class',
  'Capital investi initial': 'Initial capital invested',
  "Créer l'investissement": 'Create the investment',
  "Modifier l'investissement": 'Edit investment',
  'Nouvel investissement': 'New investment',
  'Investissement mis à jour.': 'Investment updated.',
  'Investissement créé.': 'Investment created.',
  'Historique — {name}': 'History — {name}',
  'Aucun historique pour le moment.': 'No history yet.',
  'Entrée ajoutée.': 'Entry added.',
  "Supprimer cette entrée d'historique ?": 'Delete this history entry?',
  'Entrée supprimée.': 'Entry deleted.',
  'Capital net': 'Net capital',
  'Ajoutez des investissements pour voir le comparatif de rendement.': 'Add investments to see the yield comparison.',
  'Aucun investissement suivi. Ajoutez votre premier actif (immobilier, actions, business…).': 'No investment tracked. Add your first asset (real estate, stocks, business…).',
  'Tous': 'All',
  'Actifs financiers': 'Financial assets',
  'Biens physiques': 'Physical assets',
  'Aucun actif dans cette catégorie.': 'No asset in this category.',
  'Évolution de la valeur du portefeuille': 'Portfolio value trend',
  "Comparatif de rendement par classe d'actif": 'Yield comparison by asset class',
  'Valeur du portefeuille': 'Portfolio value',
  'Supprimer l\'investissement "{name}" et tout son historique ?': 'Delete investment "{name}" and all its history?',
  'Investissement supprimé.': 'Investment deleted.',

  // ---------- Dettes & créances (debts.js + en-tête index.html) ----------
  '+ Dette / créance': '+ Debt / receivable',
  // Prêt/Créance : noms canoniques des catégories réservées aux mouvements de dette/créance
  // (ensureDebtCategoryId, debts.js) — traduites au moment de la CRÉATION de la catégorie
  // uniquement, comme les catégories par défaut (voir DEFAULT_CATEGORIES). La recherche d'une
  // catégorie déjà créée, elle, vérifie toutes les variantes FR/EN connues (DEBT_CATEGORY_NAME_VARIANTS
  // dans debts.js), jamais seulement la traduction courante.
  'Prêt': 'Loan',
  'Créance': 'Receivable',
  'Dette': 'Debt',
  'Enregistrer un remboursement': 'Record a repayment',
  'Remboursé : {amount}': 'Repaid: {amount}',
  'Montant initial': 'Initial amount',
  'Restant dû': 'Remaining balance',
  "Taux d'intérêt annuel": 'Annual interest rate',
  'Aucun portefeuille en {currency}': 'No wallet in {currency}',
  'Dette (je dois)': 'Debt (I owe)',
  'Créance (on me doit)': 'Receivable (owed to me)',
  'Nom de la personne / organisme': 'Person / organization name',
  "Cet argent bouge aujourd'hui": 'This money is moving today',
  "Décochez si c'est une dette déjà existante avant d'utiliser l'app (aucun mouvement de portefeuille ne sera créé).":
    "Uncheck if this is a debt that already existed before using the app (no wallet movement will be created).",
  "Taux d'intérêt annuel % (optionnel)": 'Annual interest rate % (optional)',
  'Date de départ': 'Start date',
  'Échéance (optionnel)': 'Due date (optional)',
  'Nouvelle dette / créance': 'New debt / receivable',
  'Choisissez un portefeuille, ou décochez "Cet argent bouge aujourd\'hui".': 'Choose a wallet, or uncheck "This money is moving today".',
  'Prêt reçu de {name}': 'Loan received from {name}',
  'Prêt accordé à {name}': 'Loan given to {name}',
  'Mouvement de dette/créance': 'Debt/receivable movement',
  'Mis à jour.': 'Updated.',
  'Créé.': 'Created.',
  'Montant remboursé': 'Amount repaid',
  'Remboursement — {name}': 'Repayment — {name}',
  "Créez d'abord un portefeuille en {currency}.": 'First create a wallet in {currency}.',
  'Remboursement de dette/créance': 'Debt/receivable repayment',
  'Soldée': 'Paid off',
  'Remboursement enregistré.': 'Repayment recorded.',
  'Avec ce budget mensuel, les intérêts dépassent votre capacité de remboursement ({method}). Augmentez le montant mensuel.':
    'With this monthly budget, interest exceeds your repayment capacity ({method}). Increase the monthly amount.',
  "Avalanche (taux le plus élevé d'abord)": 'Avalanche (highest rate first)',
  "Boule de neige (plus petit montant d'abord)": 'Snowball (smallest amount first)',
  'Durée totale estimée': 'Estimated total duration',
  '{months} mois (~{years} ans)': '{months} months (~{years} years)',
  'Intérêts totaux payés': 'Total interest paid',
  'Ordre de remboursement : {list}': 'Repayment order: {list}',
  'mois {n}': 'month {n}',
  'Simulateur de remboursement stratégique': 'Strategic repayment simulator',
  'Budget mensuel disponible (en {currency}) pour rembourser vos dettes': 'Monthly budget available (in {currency}) to repay your debts',
  'Comparer Avalanche vs Boule de neige': 'Compare Avalanche vs Snowball',
  'Aucune dette ni créance active.': 'No active debt or receivable.',
  'Évolution du désendettement': 'Debt payoff trend',
  'Soldées': 'Paid off',
  'Dette restante': 'Remaining debt',
  'Supprimer "{name}" et tout son historique de remboursement (et les mouvements de portefeuille associés) ?':
    'Delete "{name}" and all its repayment history (and associated wallet movements)?',
  'Supprimé.': 'Deleted.',
  'Restauré.': 'Restored.',

  // ---------- Outils (tools.js + en-tête index.html) ----------
  'Outils stratégiques': 'Strategic tools',
  'Chargement des outils…': 'Loading tools…',
  'Épargne mensuelle ({currency})': 'Monthly savings ({currency})',
  'Rendement annuel attendu (%)': 'Expected annual return (%)',
  'Projection à partir du patrimoine net actuel ({amount}), en supposant un rendement composé constant et une épargne mensuelle régulière.':
    'Projection based on your current net worth ({amount}), assuming constant compound growth and regular monthly savings.',
  'Simulateur de trajectoire patrimoniale (1, 3, 5 ans)': 'Net worth trajectory simulator (1, 3, 5 years)',
  'Dans {years} an': 'In {years} year',
  'Dans {years} ans': 'In {years} years',
  'Montant ({currency})': 'Amount ({currency})',
  'Inflation annuelle (%)': 'Annual inflation (%)',
  'Durée (années)': 'Duration (years)',
  "Calculateur d'inflation & pouvoir d'achat": 'Inflation & purchasing power calculator',
  "Pouvoir d'achat réel dans {years} an(s)": 'Real purchasing power in {years} year(s)',
  'Perte de valeur': 'Value lost',
  'Dépenses mensuelles moyennes ({currency})': 'Average monthly expenses ({currency})',
  'Mois de couverture souhaités': 'Desired months of coverage',
  '{n} mois': '{n} months',
  "Calculateur de fonds d'urgence": 'Emergency fund calculator',
  'Liquidités actuelles (portefeuilles)': 'Current cash (wallets)',
  'Objectif ({months} mois)': 'Target ({months} months)',
  'Autonomie actuelle': 'Current autonomy',
  "Montant à épargner pour atteindre l'objectif": 'Amount to save to reach the target',
  "Objectif de fonds d'urgence atteint !": 'Emergency fund target reached!',
  "Montant de l'achat ({currency})": 'Purchase amount ({currency})',
  'Mode de financement': 'Financing method',
  'Comptant (sur liquidités)': 'Cash (from wallets)',
  'Crédit / paiement échelonné': 'Credit / installment plan',
  'Durée (mois)': 'Duration (months)',
  "Simulateur d'impact d'un achat important": 'Major purchase impact simulator',
  'Liquidités actuelles': 'Current cash',
  'Liquidités après achat': 'Cash after purchase',
  "Autonomie du fonds d'urgence": 'Emergency fund autonomy',
  'Cet achat dépasserait vos liquidités actuelles.': 'This purchase would exceed your current cash.',
  "Votre fonds d'urgence passerait sous 3 mois de couverture.": 'Your emergency fund would drop below 3 months of coverage.',
  'Mensualité': 'Monthly payment',
  'Coût total': 'Total cost',
  "(dont {amount} d'intérêts)": '(including {amount} in interest)',
  'Épargne nette mensuelle actuelle': 'Current monthly net savings',
  'Épargne nette mensuelle après mensualité': 'Monthly net savings after payment',
  'Cette mensualité dépasserait votre épargne nette actuelle : vos dépenses excéderaient vos revenus.':
    'This payment would exceed your current net savings: your expenses would exceed your income.',
  'Revenu mensuel ({currency})': 'Monthly income ({currency})',
  '% Besoins essentiels': '% Essential needs',
  '% Envies / loisirs': '% Wants / leisure',
  '% Épargne / dettes': '% Savings / debt',
  'Les pourcentages ne totalisent pas 100%.': 'The percentages do not add up to 100%.',
  'Système de budgets par enveloppes (méthode 50/30/20)': 'Envelope budgeting system (50/30/20 method)',
  'Besoins essentiels': 'Essential needs',
  'Envies / loisirs': 'Wants / leisure',
  'Épargne / remboursement dettes': 'Savings / debt repayment',
  'Détectés par similarité de note + montant sur au moins 2 mois distincts — vérifiez avant de les déclarer en Récurrences (Budgets &gt; Récurrences) pour un suivi précis.':
    'Detected by note + amount similarity over at least 2 distinct months — check before declaring them in Recurring (Budgets &gt; Recurring) for accurate tracking.',
  '{amount}/mois': '{amount}/month',
  'Total mensuel estimé': 'Estimated monthly total',
  'Aucun abonnement non déclaré détecté pour le moment.': 'No undeclared subscription detected yet.',
  'Abonnements & paiements récurrents détectés': 'Detected subscriptions & recurring payments',
  '+{pct}% vs moyenne': '+{pct}% vs average',
  'Aucune anomalie détectée sur les 90 derniers jours.': 'No anomaly detected in the last 90 days.',
  "Analyse des habitudes & détection d'anomalies (90 derniers jours)": 'Habit analysis & anomaly detection (last 90 days)',
  'Moyenne journalière : {mean} · Écart-type : {stdev}. Un jour est signalé si ses dépenses dépassent la moyenne + 2 écarts-types.':
    'Daily average: {mean} · Standard deviation: {stdev}. A day is flagged if its expenses exceed the average + 2 standard deviations.',
  'Création': 'Creation',
  'Modification': 'Update',
  'Suppression': 'Deletion',
  'Aucune activité enregistrée pour le moment.': 'No activity recorded yet.',
  "Journal d'audit (150 dernières actions)": 'Audit log (last 150 actions)',

  // ---------- Rapports (reports.js + reports-extras.js + en-tête index.html) ----------
  "La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant).": 'The PDF library is not loaded (vendor/jspdf.umd.min.js missing).',
  'GeoFinance System — Bilan financier': 'GeoFinance System — Financial statement',
  'Période : {month}': 'Period: {month}',
  'Résumé': 'Summary',
  'Patrimoine net global : {amount}': 'Total net worth: {amount}',
  'Entrées du mois : {amount}': 'Income (month): {amount}',
  'Sorties du mois : {amount}': 'Expenses (month): {amount}',
  'Épargne nette : {amount}': 'Net savings: {amount}',
  'Aucune dépense ce mois-ci.': 'No expenses this month.',
  'Aucun budget défini ce mois-ci.': 'No budget set this month.',
  'Bilan PDF généré.': 'PDF statement generated.',
  'GeoFinance System — Bilan annuel': 'GeoFinance System — Annual statement',
  'Année {year}': 'Year {year}',
  'Résumé annuel': 'Annual summary',
  'Revenus totaux : {amount}': 'Total income: {amount}',
  'Dépenses totales : {amount}': 'Total expenses: {amount}',
  'Épargne nette totale : {amount}': 'Total net savings: {amount}',
  'Patrimoine net au 1er janvier : {amount}': 'Net worth on January 1st: {amount}',
  'Patrimoine net au 31 décembre : {amount}': 'Net worth on December 31st: {amount}',
  "Variation du patrimoine sur l'année : {amount}": 'Net worth change over the year: {amount}',
  'Détail mensuel': 'Monthly detail',
  'Mois': 'Month',
  'Entrées': 'Income',
  'Sorties': 'Expenses',
  'Dépenses par catégorie (cumul annuel)': 'Expenses by category (annual total)',
  'Aucune dépense cette année.': 'No expenses this year.',
  'Bilan annuel PDF généré.': 'Annual PDF statement generated.',
  'Bilan financier mensuel': 'Monthly financial statement',
  'Générer le bilan PDF': 'Generate PDF statement',
  'Exporter les transactions du mois (CSV)': 'Export this month\'s transactions (CSV)',
  "Exporter tout l'historique (CSV)": 'Export entire history (CSV)',
  'Bilan annuel': 'Annual statement',
  'Générer le bilan annuel PDF': 'Generate annual PDF statement',
  'Export CSV généré.': 'CSV export generated.',
  'Score de santé financière': 'Financial health score',
  'Bonne santé financière': 'Good financial health',
  'À surveiller': 'To watch',
  'Fragile': 'Fragile',
  'Indicateur composite indicatif, pas un conseil personnalisé.': 'Indicative composite score, not personalized advice.',
  "Taux d'épargne (mois)": 'Savings rate (month)',
  "Ratio d'endettement": 'Debt ratio',
  'Respect du budget': 'Budget adherence',
  'Calendrier des dépenses': 'Spending calendar',
  'Aucune dépense le {date}.': 'No expenses on {date}.',
  '{date} : {amount}': '{date}: {amount}',
};
