# GeoFinance System — Notes de suivi du projet

> Ce fichier sert de mémoire du projet pour toute personne (ou IA) qui reprend le développement.
> À tenir à jour à chaque session de travail significative : ce qui a été fait, pourquoi, et ce qui reste ouvert.
> Dernière mise à jour : **13 août 2026**.

## 1. C'est quoi ce projet

**GeoFinance System** — une PWA de gestion financière personnelle, tout-en-un : portefeuilles multi-devises,
transactions, budgets (mode enveloppe façon YNAB), épargne, investissements (financiers + biens physiques),
dettes/créances, partage de dépenses, rapports, outils de simulation (achat important, fonds d'urgence,
remboursement de dette), OCR de justificatifs.

**Dépôt** : https://github.com/zaky04/geofinance (déployé sur GitHub Pages).
**Auteur** : Adtcheko 5T/ · contact : ronywest01@gmail.com (voir signature dans Paramètres).

### Vision produit (déduite du code — non documentée ailleurs, à confirmer avec l'auteur si besoin)

- **Local-first et privé** : toutes les données vivent exclusivement dans l'IndexedDB du navigateur, jamais
  sur un serveur. Pas de compte, pas de backend, pas de télémétrie.
- **Hors-ligne d'abord** : Service Worker en cache-first, l'app doit rester 100% utilisable sans réseau.
- **Cible internationale, accent Afrique de l'Ouest/Centrale** : devises XOF/XAF natives, type de portefeuille
  "Mobile Money" dédié, autres devises courantes de la zone (MAD, NGN, GHS) en plus des devises classiques
  (EUR, USD, GBP...).
- Positionnement donc clairement **différent d'un SaaS cloud classique** (type YNAB/Mint) : pas de sync
  multi-appareil, en échange d'une confidentialité totale.

## 2. Architecture technique

**Aucun framework, aucun build step.** JS vanilla en modules ES (`<script type="module">`), chargés
directement par le navigateur. Pas de `package.json`, pas de bundler, pas de TypeScript.

```
index.html              — SPA à vues multiples (une <div class="view"> par onglet, affichée/masquée en JS)
sw.js                    — Service Worker : precache complet de l'app shell, cache-first + purge à l'activation
manifest.json            — Manifest PWA (installable)
css/styles.css           — Tout le style, un seul fichier
js/
  app.js                 — Bootstrap + routeur SPA (navigateTo), verrouillage auto, bus d'événements global
  state.js                — Store applicatif minimal : EventBus (pub/sub) + appState partagé
  db.js                    — Couche IndexedDB : CRUD génériques, STORES, export/import complet
  ledger.js                — Moteur de calcul financier partagé (soldes, patrimoine net, agrégats mensuels...)
                              → TOUTE la logique de calcul vit ici, les modules de vue ne font qu'afficher
  auth.js                  — PIN (PBKDF2-SHA256) + biométrie WebAuthn + écran de verrouillage (machine à états)
  backup.js                — Export/import JSON (clair + chiffré AES-GCM), import CSV (GeoFinance + générique
                              avec mapping de colonnes), rappel hebdomadaire de sauvegarde
  utils.js                 — Formatage devises/dates, conversion multi-devises, helpers UI (modal, toast...)
  charts.js                — Wrapper autour de Chart.js (vendorisé)
  ocr.js                    — Wrapper autour de Tesseract.js (vendorisé) pour scanner les justificatifs
  notifications.js         — Notifications proactives (budgets dépassés, échéances...)
  install-prompt.js        — Invite d'installation PWA (beforeinstallprompt + fallback iOS)
  modules/                 — Un fichier par onglet de navigation : dashboard, wallets, transactions, budgets,
                              savings, investments, debts, tools, reports (+reports-extras), shared,
                              kept-accounts (optionnel, activable dans Paramètres), search, settings.
                              Chaque module exporte render*() et init*Module().
vendor/                    — Chart.js, jsPDF, Tesseract.js vendorisés (pas de CDN, tout doit marcher hors-ligne)
```

**Stockage** : IndexedDB (`geofinance-db`, version actuelle `4`), 19 object stores (voir `STORES` dans `db.js`).
Identifiants applicatifs en UUID (pas d'auto-increment) pour permettre l'import/merge sans collision.
`keptAccounts`/`keptAccountEntries` sont volontairement isolés : aucune fonction de `ledger.js` ne doit
jamais les lire (argent de tiers, pas de l'utilisateur — ne doit jamais entrer dans le patrimoine net).

**Communication entre modules** : bus d'événements (`state.js`). Toute écriture en base doit être suivie d'un
`notifyDataChanged(scope)` pour que la vue active se re-rende.

## 3. Conventions à respecter impérativement

1. **⚠️ Bump `CACHE_VERSION` dans `sw.js` à CHAQUE modification d'un fichier JS/CSS/HTML.** Le Service Worker
   est cache-first strict : sans bump, les utilisateurs déjà installés ne verront JAMAIS les changements
   (même après refresh). C'est la source de bug la plus facile à oublier sur ce projet.
2. **Tout texte utilisateur inséré via `innerHTML` doit passer par `escapeHtml()`** (`utils.js`). Le projet est
   rigoureux là-dessus (audité, aucune faille XSS trouvée) — à maintenir.
3. **Dates** : toujours `localISODate()` / `todayISO()` (`utils.js`), jamais `.toISOString()` directement sur
   une date locale — `.toISOString()` convertit en UTC et peut faire dériver la date d'un jour selon le fuseau.
4. **Argent** : `Number` JS classique, pas de représentation en centimes entiers (voir dette technique §5).
   Toujours passer par les fonctions de `ledger.js` pour les agrégats — ne pas resommer des transactions
   à la main dans un module de vue.
5. **UI entièrement en français**, y compris les commentaires de code. Rester cohérent.
6. **Commits** : messages en français, descriptifs, un commit = un lot de fonctionnalités/correctifs cohérent
   (voir `git log` pour le style). Toujours terminer par le bump de `CACHE_VERSION` si du JS a changé.

## 4. Lancer le projet en local

Pas de build. Servir les fichiers statiques (les modules ES ne fonctionnent pas en `file://`) :

```bash
powershell -ExecutionPolicy Bypass -File geofinance/serve.ps1 -Port 8123
```

Ou via `.claude/launch.json` (config `geofinance`, port 8123) avec les outils de preview.

**Aucun test automatisé, aucun lint, aucune CI configurée** (voir dette technique).

## 5. Dette technique connue (identifiée par audit, 12 août 2026)

| # | Sujet | Détail | Sévérité |
|---|---|---|---|
| 1 | Pas de tests automatisés | `ledger.js` (~500 lignes de calculs financiers interconnectés) n'a aucun filet de sécurité — un refactor peut casser un calcul silencieusement. Pas de `package.json`/CI non plus. | Moyenne (pas bloquant, mais risque croissant avec la taille du projet) |
| 2 | Arithmétique flottante | Les montants sont des `Number` JS sommés directement, pas de représentation en centimes entiers. L'affichage arrondit (masque la plupart des cas), mais des comparaisons comme `actual <= budget` peuvent ponctuellement dériver d'un centime. | Faible |
| 3 | PIN : limite inhérente au 100% client-side | PBKDF2 150k itérations protège contre un accès "casual", pas contre une extraction forensique de l'IndexedDB brute (pas de coffre matériel disponible sans backend). Ce n'est pas un bug corrigible facilement, juste une limite du modèle à garder en tête. | Info (pas actionnable) |
| 4 | Import CSV générique silencieux sur montant invalide | `backup.js` (`importGenericCsvRows`) : un montant non parsable devient `0` sans avertir l'utilisateur qu'une ligne a été mal importée. | Faible-Moyenne |
| 5 | Pas de doc de vision/roadmap versionnée | Avant ce fichier, aucun README/CLAUDE.md n'existait — la vision produit ne se lisait que dans les messages de commit. | Résolu par ce fichier (à maintenir) |

## 6. Journal des correctifs

### 12 août 2026 — 3 correctifs de fiabilité (commit à venir)

Suite à un audit complet (statique + tests en conditions réelles dans le navigateur), 3 problèmes concrets
ont été identifiés et corrigés :

1. **Taux de change à 1:1 silencieusement faux** (`wallets.js`, `ledger.js`, `dashboard.js`)
   Un nouveau taux de change (créé automatiquement au 1er portefeuille/investissement/dette dans une devise
   étrangère) était enregistré à `rateToBase: 1` sans que l'utilisateur en soit informé — ce qui fausse
   silencieusement le patrimoine net (grave pour la cible XOF/XAF où 1 EUR ≈ 656 XOF, pas 1).
   → Ajout d'un champ `confirmed: false` sur les taux non validés par l'utilisateur, avec alerte visible sur
   le tableau de bord (`#dashboard-alerts`) et mise en évidence dans le panneau Portefeuilles tant que le
   taux n'a pas été corrigé manuellement (passe à `confirmed: true` à la saisie).

2. **Rappel de sauvegarde hebdomadaire repoussable indéfiniment** (`backup.js`, `index.html` template)
   Le bouton "Plus tard" permettait de repousser le rappel par tranches de 24h sans limite, ce qui va à
   l'encontre de l'unique protection contre la perte de données (tout vit en local, sans sync cloud).
   → Ajout d'un compteur `backupSnoozeCount`. Au-delà de 3 reports, le rappel passe en mode "urgent" :
   le bouton "Plus tard" est retiré (seul "Exporter maintenant" reste), et le compteur n'est remis à zéro
   qu'après un export réellement effectué (`markBackupDone()`, appelé par les 3 chemins d'export/backup auto).

3. **Blocage anti-brute-force du PIN annulé par un simple rechargement de page** (`auth.js`)
   Après 5 échecs, un délai de 30s (`throttledUntil`) était prévu mais stocké uniquement en variable JS
   locale — recharger la page l'annulait instantanément alors que le compteur d'échecs, lui, était persisté.
   → `pinThrottledUntil` est maintenant persisté en base et relu à l'entrée en mode déverrouillage ; un
   message de décompte s'affiche pendant le blocage au lieu d'ignorer silencieusement les frappes.

`CACHE_VERSION` : `v25` → `v26`.

Les 3 correctifs ont été testés en conditions réelles dans le navigateur (création de portefeuille en devise
étrangère, simulation de 5 échecs de PIN + reload, simulation de 3 reports de sauvegarde + export) — voir
détails de session si besoin de les rejouer.

### 13 août 2026 — 3 fonctionnalités demandées par l'utilisateur après usage réel (commit à venir)

1. **Dettes & créances liées aux portefeuilles** (`debts.js`, `ledger.js`, `db.js`)
   Créer/rembourser une dette ne touchait aucun portefeuille (aucun `walletId` dans le schéma).
   → À la création (uniquement, pas en édition) : case "Cet argent bouge aujourd'hui" cochée par défaut +
   portefeuille (filtré à la devise de la dette) ; si cochée, crée une transaction liée (`debtId`) sur ce
   portefeuille. Le remboursement exige toujours un portefeuille. Les transactions liées à une dette sont
   **exclues** des agrégats mensuels de `ledger.js` (`computeMonthSummary` et 6 autres fonctions filtrent
   `if (t.debtId) continue`) — emprunter/rembourser n'est pas une dépense/recette discrétionnaire, seul le
   solde du portefeuille doit bouger. Vérifié : emprunter 200€ ne change pas le patrimoine net (portefeuille
   +200, dette −200) et n'apparaît pas dans "Entrées (mois)".
   Suppression d'une dette supprime aussi ses transactions liées (ouverture + remboursements), restaurées si
   "Annuler".

2. **Partage de dépenses → transaction "ma part"** (`shared.js`)
   Le module était totalement isolé des portefeuilles/transactions (par design initial, pour ne pas fausser
   le patrimoine net). L'utilisateur voulait que sa part réelle apparaisse dans son budget.
   → `PARTICIPANTS` gagne un flag `isMe` (un seul participant à la fois, bouton "Définir comme moi"). Si le
   participant "Moi" fait partie du partage, `montant ÷ nb participants` (sa part, PAS le montant total, quel
   que soit le payeur) devient une vraie transaction dépense (`sharedExpenseId` sur la transaction, catégorie
   + portefeuille choisis dans le formulaire, portefeuille filtré à la devise de la dépense). Contrairement
   aux dettes, cette transaction compte normalement dans les agrégats (c'est une vraie dépense personnelle).
   Suppression de la dépense partagée supprime aussi la transaction liée.

3. **Comptes gardés** (nouveau, `js/modules/kept-accounts.js`)
   Nouvelle fonctionnalité : suivre l'argent de tiers (petit frère, conjointe, mère...) que l'utilisateur
   garde/gère, avec ses propres entrées/sorties. Activable/désactivable dans Paramètres (`keptAccountsEnabled`,
   décoché par défaut) — masque/affiche le bouton de nav `#nav-kept-accounts`.
   → 2 nouveaux stores IndexedDB (`KEPT_ACCOUNTS`, `KEPT_ACCOUNT_ENTRIES`, DB_VERSION `3` → `4`), module calqué
   sur `wallets.js` mais **totalement autonome** : `ledger.js` ne les lit jamais, aucun impact sur le
   patrimoine net (vérifié : créer un compte gardé + mouvements ne change pas "Patrimoine net global").

`CACHE_VERSION` : `v26` → `v27`. Nouveau fichier `js/modules/kept-accounts.js` ajouté au précache de `sw.js`.

Les 3 fonctionnalités ont été testées de bout en bout dans le navigateur (dette avec/sans mouvement de
portefeuille + remboursement, dépense partagée avec transaction liée + suppression en cascade, activation/
usage/désactivation des comptes gardés) — aucune erreur console à aucune étape.

## 7. Pistes prioritaires non traitées

Par ordre d'impact estimé, à valider avec l'auteur avant de s'y attaquer :

1. **Rendre la sauvegarde vraiment robuste** — le fix §6.2 rend le rappel plus insistant mais ne résout pas
   le risque de fond : pas de sauvegarde cloud automatique. Pistes possibles sans trahir le positionnement
   "local/privé" : auto-backup local plus proactif (déjà partiellement possible via File System Access API,
   mais Chromium desktop uniquement), export automatique périodique vers le Téléchargements du navigateur.
2. **Tests de non-régression légers pour `ledger.js`** — pas besoin d'un framework complet vu l'absence de
   build ; un script Node (ou une page de test HTML dédiée) qui rejoue quelques scénarios de calcul connus
   suffirait à sécuriser les futurs refactors.
3. **Avertir l'utilisateur sur les imports CSV avec montants invalides** (dette technique §5.4).
4. **Arrondi en centimes entiers dans `ledger.js`** si des écarts d'affichage sont un jour rapportés par
   l'utilisateur (pas urgent tant que ça n'arrive pas).

## 8. Comment reprendre le travail

- Lire ce fichier en premier.
- `git log --oneline` pour l'historique complet (messages en français, très descriptifs).
- Le code est commenté en français aux endroits non-évidents (le *pourquoi*, pas le *quoi*) — les lire avant
  de modifier une fonction, ils expliquent souvent une décision non intuitive (ex: pourquoi `fetch({cache:
  'reload'})` plutôt que `cache.add()` dans `sw.js`, pourquoi les dates locales et pas `.toISOString()`...).
- Avant tout commit touchant du JS/CSS/HTML : penser au bump de `CACHE_VERSION` (§3.1).
