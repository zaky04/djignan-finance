# Djignan Financial System — Notes de suivi du projet

> Ce fichier sert de mémoire du projet pour toute personne (ou IA) qui reprend le développement.
> À tenir à jour à chaque session de travail significative : ce qui a été fait, pourquoi, et ce qui reste ouvert.
> Dernière mise à jour : **11 septembre 2026**.

## 1. C'est quoi ce projet

**Djignan Financial System** (anciennement « GeoFinance », renommé le 16 août 2026 — voir l'entrée du
journal correspondante) — une PWA de gestion financière personnelle, tout-en-un : portefeuilles multi-devises,
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
  backup.js                — Export/import JSON (clair + chiffré AES-GCM), import CSV (Djignan + générique
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
| 1 | ~~Pas de tests automatisés~~ | **Résolu le 14 août 2026** — voir §11 (`test/ledger.test.html`). | — |
| 2 | Arithmétique flottante | Les montants sont des `Number` JS sommés directement, pas de représentation en centimes entiers. L'affichage arrondit (masque la plupart des cas). **Comparaisons de seuil corrigées le 14 août 2026** (tolérance 0.005, voir §6) — reste vrai pour toute future comparaison exacte à ajouter : y penser. | Faible |
| 3 | PIN : limite inhérente au 100% client-side | PBKDF2 150k itérations protège contre un accès "casual", pas contre une extraction forensique de l'IndexedDB brute (pas de coffre matériel disponible sans backend). Ce n'est pas un bug corrigible facilement, juste une limite du modèle à garder en tête. | Info (pas actionnable) |
| 4 | ~~Import CSV générique silencieux sur montant invalide~~ | **Résolu le 14 août 2026** — voir §6. | — |
| 5 | Pas de doc de vision/roadmap versionnée | Avant ce fichier, aucun README/CLAUDE.md n'existait — la vision produit ne se lisait que dans les messages de commit. | Résolu par ce fichier (à maintenir) |

**Trouvé lors de la revue de bugs du 15 août 2026 (au-delà du diff du jour, voir §6) — corrigé sur-le-champ :**

| # | Sujet | Détail | Sévérité |
|---|---|---|---|
| 6 | ~~XSS via `currencySelectHtml()`~~ | **Corrigé** — `utils.js` interpolait un code devise non échappé dans un attribut HTML ; un import CSV/JSON pouvait y injecter du HTML/JS arbitraire (contournait la limite de 3 caractères que la saisie normale impose). | Résolu |
| 7 | ~~`formatCurrency()` affichait des décimales pour XOF/XAF~~ | **Corrigé** — `"1 234,5 F CFA"` au lieu de `"1 235 F CFA"` sur tout montant non entier, alors que ce sont des devises sans sous-unité usuelle (marché cible de l'app). | Résolu |
| 8 | ~~Export CSV : double échappement~~ | **Corrigé** — `exportTransactionsCsv` appelait `csvEscape` deux fois sur 4 colonnes ; un nom contenant `;` ressortait avec des guillemets quadruplés, cassant le ré-import. | Résolu |
| 9 | ~~`detectRecurringCandidates` n'excluait jamais les récurrences actives~~ | **Corrigé** — comparait la note brute (`"Récurrence : Loyer"`) au nom de la récurrence (`"loyer"`), qui ne correspondent jamais ; re-proposait en boucle des récurrences déjà déclarées. | Résolu |
| 10 | ~~`computeEnvelopeCarryover` incluait les mouvements de dette/créance~~ | **Corrigé** — seul agrégat mensuel du fichier sans le filtre `!t.debtId` que tous ses voisins appliquent ; divergeait de l'"actual" réellement affiché. | Résolu |
| 11 | ~~Course critique sur le compteur d'échecs PIN~~ | **Corrigé** (`auth.js`) — deux `verifyPin()` concurrents (backspace + nouveau chiffre pendant qu'un calcul PBKDF2 est en cours) pouvaient sous-compter `failedAttempts`, retardant le blocage anti-brute-force. Verrou `verifying` ajouté. | Résolu |
| 12 | ~~Déverrouillage biométrique ne levait pas le blocage PIN~~ | **Corrigé** (`auth.js`) — un utilisateur throttlé après 5 échecs de PIN qui se déverrouillait par empreinte restait bloqué au PIN au verrouillage suivant. | Résolu |
| 13 | ~~Rappel de sauvegarde (local ET cloud) : 3e report annulé par lui-même~~ | **Corrigé** (`backup.js`, `firebase-sync.js`) — `>=` au lieu de `>` faisait passer le mode "urgent" avant que le répit de 24h du 3e clic "Plus tard" n'ait eu la moindre chance de s'écouler. | Résolu |

**Trouvé mais volontairement pas corrigé cette session — à prioriser avec l'auteur :**

| # | Sujet | Détail | Sévérité |
|---|---|---|---|
| 14 | `parseFlexibleNumber` (import CSV générique) mélit un séparateur de milliers pour une décimale | `"1,234,567"` (US, sans point) devient `1.234` — perte de magnitude silencieuse. Nécessite une vraie heuristique (ou un choix explicite du format par l'utilisateur), pas un correctif d'une ligne. | Moyenne-Haute |
| 15 | `dbBulkPut`/`importAllData` non atomiques entre stores | Une ligne malformée en cours d'import (backup forgé/corrompu) peut laisser la base dans un état "moitié ancien, moitié nouveau" jamais voulu, sans indiquer à l'utilisateur quels stores ont réussi. | Moyenne |
| 16 | `isDuplicateTransaction` (dédoublonnage import) : clé = portefeuille+date+type+montant | Deux dépenses identiques et légitimes le même jour (ex: deux cafés à 3,50€) sont silencieusement fusionnées à l'import ; les virements ne comparent pas `targetWalletId`. | Moyenne |
| 17 | `upgrade()` (`db.js`) n'ajoute jamais un index à un store déjà existant | Si une future version ajoute un index sur un store existant, les utilisateurs déjà installés ne l'obtiendront jamais (`createIndex` n'est appelé que dans la branche "store tout neuf") — bombe à retardement, pas un bug actif aujourd'hui. | Info (à surveiller) |
| 18 | `computeEnvelopeCarryover` casse la chaîne sur un mois intermédiaire sans budget | Si janvier a un budget mais février non (bien que dépensé), le report de mars ignore complètement les dépenses de février. | Faible-Moyenne |
| 19 | Réception d'un justificatif corrompu abandonne tout l'import | `deserializeReceiptsForImport` (`backup.js`) n'a pas de `try/catch` par ligne — une seule photo corrompue fait échouer toute la restauration au lieu de sauter ce justificatif. | Faible-Moyenne |
| 20 | Échec de sauvegarde automatique (File System Access) jamais signalé | `runAutoBackupIfConfigured` avale les erreurs d'écriture (dossier supprimé, quota) avec un simple `console.warn` — l'utilisateur peut croire être protégé alors que rien n'est écrit depuis longtemps. | Moyenne |
| 21 | `openModal()` : une touche Échap ferme TOUTES les modales empilées, pas juste la dernière | Chaque modale enregistre son propre listener sans notion de pile — deux `confirmDialog` accidentellement superposées se ferment ensemble sur un seul Échap. | Faible |
| 22 | `parseFlexibleDate` suppose toujours JJ/MM/AAAA | Un relevé au format US (MM/DD/YYYY) est mal interprété silencieusement pour toute date où jour et mois sont tous deux ≤ 12 — limite documentée dans le code, mais aucun signalement si un fichier non européen est importé. | Faible |
| 23 | `verifyPin()` n'a pas de limite anti-brute-force intégrée | Le blocage de 30s n'existe que côté clavier de l'écran de verrouillage (`auth.js`, UI) — `changePin()` (Paramètres → Changer le code PIN) appelle `verifyPin()` directement, sans aucune limite sur les tentatives d'"ancien code". | Faible-Moyenne |


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

### 13 août 2026 (suite) — 4 améliorations issues d'une analyse concurrentielle (commit à venir)

1. **Raccourcis PWA cassés, corrigés** (`app.js`) — `manifest.json` déclare `?action=quick-add` et
   `?view=X` (appui long sur l'icône) depuis le début, mais rien ne lisait jamais `location.search`. Ajout de
   `applyShortcutParams()`, appelée après déverrouillage, qui nettoie l'URL ensuite (`history.replaceState`)
   pour ne pas rejouer l'action à chaque re-déverrouillage.
2. **`navigator.storage.persist()`** (`app.js`, au boot) — réduit le risque d'éviction de l'IndexedDB par le
   navigateur sous pression de stockage (best-effort, silencieux si refusé — dépend de l'heuristique du
   navigateur, ex: PWA installée + usage engagé favorisent l'octroi).
3. **Taux de change en un clic, optionnel** (`wallets.js`) — bouton "Actualiser via internet" dans le panneau
   Portefeuilles, `open.er-api.com` (gratuit, sans clé). Best-effort explicite : tout échec (hors-ligne,
   devise absente de la réponse) se dégrade en toast, jamais en blocage — la saisie manuelle reste toujours
   possible. Marque les taux `confirmed: true` à la récupération (résout l'alerte §6.1).
4. **Onboarding au premier lancement** (`app.js`, `openWalletModal` exporté de `wallets.js`) — juste après la
   création du PIN sur une installation neuve : choix de la devise principale (à faire AVANT tout taux de
   change existant, la changer plus tard les réinitialise) puis enchaîne directement sur la création du
   premier portefeuille. Garde double (`onboardingCompleted` ET aucun portefeuille existant) pour ne jamais
   se déclencher sur une install déjà en usage qui met à jour vers cette version.

`CACHE_VERSION` : `v27` → `v28`.

Testé en conditions réelles : raccourcis `?view=` et `?action=quick-add` fonctionnels, taux USD/XOF récupéré
en ligne (568,83, cohérent avec un vrai taux de marché) et alerte "non confirmé" levée automatiquement,
onboarding déclenché sur base de données neuve et absent sur une base existante avec portefeuilles.

**Note** : la piste "capture SMS mobile money via Web Share Target" (évoquée dans la même analyse) a été
volontairement laissée de côté à la demande de l'auteur — elle reste une bonne idée mais nécessite son
propre cadrage (`manifest.json` share_target, nouveau parseur, `sw.js`) avant d'être attaquée.

### 13 août 2026 (suite) — Audit de sécurité (commit à venir)

**Faille corrigée — la sauvegarde JSON exportait le hash et le sel du PIN.** `exportAllData()` (`db.js`)
itérait tous les stores sans exception, y compris `SETTINGS`, qui contient `pinHash`/`pinSalt`
(PBKDF2), `biometricPublicKeySpki`/`biometricCredentialId`. Concrètement : exporter une sauvegarde JSON
**en clair** (bouton "Exporter (JSON)", pas la variante chiffrée) faisait sortir de l'appareil, sans
aucune protection supplémentaire, exactement le matériel nécessaire pour attaquer le PIN hors-ligne — un
PIN à 4-6 chiffres tombe en quelques secondes/minutes une fois le hash+sel en main, malgré les 150k
itérations PBKDF2 (l'espace de recherche est trop petit, pas la fonction de hachage qui est en cause).
→ Nouvelle liste `DEVICE_LOCAL_SETTING_KEYS` dans `db.js`, filtrée hors de `exportAllData()` — donc hors
des DEUX variantes d'export (chiffré compris, par défense en profondeur) et de la sauvegarde auto. Effet de
bord assumé : restaurer une sauvegarde en mode "remplacer tout" oblige désormais à recréer un code PIN sur
l'appareil de destination au lieu d'hériter silencieusement de celui de la sauvegarde — c'est le comportement
correct (comparable à n'importe quel gestionnaire de mots de passe). Le mode "fusionner" n'est pas affecté
(le PIN actuel de l'appareil n'est jamais touché). Au passage, `autoBackupDirHandle` (un
`FileSystemDirectoryHandle`, objet natif non sérialisable) est exclu aussi — il produisait une entrée cassée
sans intérêt dans l'export.

Autres correctifs, plus mineurs, trouvés en creusant :
- **Injection de formule CSV (OWASP CSV Injection)** — `csvEscape()` dans `backup.js` ne neutralisait pas un
  champ commençant par `=`, `+`, `-` ou `@`, qu'Excel/Sheets peut interpréter comme une formule à
  l'ouverture. Risque réel via l'import de relevé bancaire générique (note/libellé venant d'un tiers) puis
  ré-export. Préfixe désormais ces champs d'une apostrophe.
- **Robustesse du fetch de taux en ligne** (§6.3 ci-dessus) — une réponse malformée du service externe
  pouvait produire `NaN`/`Infinity` stocké comme taux. Validation `isFinite(...) && > 0` ajoutée avant
  écriture.

Zones vérifiées et jugées saines (déjà auditées le 12 août, revérifiées avec le code ajouté depuis) :
échappement HTML systématique (`escapeHtml`) sur tout le nouveau code (dettes/partage/comptes gardés),
WebAuthn (challenge aléatoire, vérification ECDSA locale correcte), pas d'`eval`/`Function`/`document.write`
dans le code propre à l'app (seulement dans les libs vendorisées, attendu), pas de `target="_blank"` non
protégé.

`CACHE_VERSION` : `v28` → `v29`.

### 13 août 2026 (suite) — Audit de sécurité avancé, 2e passe (commit à venir)

**Faille la plus sérieuse trouvée cette passe — l'import pouvait injecter un PIN choisi par un
attaquant.** Le filtre `DEVICE_LOCAL_SETTING_KEYS` posé lors du premier audit (§ précédente) protégeait
l'EXPORT, mais pas l'IMPORT : `importAllData()` faisait un `dbBulkPut` direct des lignes du fichier fourni,
sans filtre. Un fichier de "sauvegarde" forgé contenant `{key:'pinHash', value: <hash choisi par
l'attaquant>}` (+ `pinSalt` assorti), importé via "Importer (JSON) → Fusionner", **remplaçait
silencieusement le PIN de l'appareil** — l'utilisateur légitime se retrouve verrouillé dehors, ou pire,
l'attaquant connaît déjà le PIN correspondant au hash qu'il a fourni et peut déverrouiller l'app plus tard.
Vecteur réaliste : ingénierie sociale ("voici un budget partagé, importe ce fichier"). → Le même filtre
`DEVICE_LOCAL_SETTING_KEYS` s'applique maintenant aussi côté import (`db.js`), donc ces clés ne peuvent
JAMAIS être posées autrement que par les flux internes d'`auth.js` (`setupPin`, `changePin`,
`registerBiometric`). Vérifié par une attaque simulée : import d'un `pinHash` forgé → hash réel inchangé,
PIN d'origine toujours fonctionnel après reload.

**Autres correctifs de cette passe :**
- **`Number(x) || 0` ne filtre pas `Infinity`** (il est "truthy", contrairement à `NaN`/`0`/`undefined`) —
  idiome utilisé partout dans `ledger.js`. Une valeur `"Infinity"` dans un CSV/JSON importé s'y propageait
  donc telle quelle. Ajoute `safeNumber()` dans `utils.js` (rejette aussi Infinity/-Infinity), utilisée à
  l'import CSV format Djignan ; ajoute un sanitizer générique dans `importAllData()` qui ramène à 0 tout
  champ `number` non fini sur les lignes importées, tous stores confondus. Vérifié par attaque simulée
  (portefeuille importé avec `initialBalance: Infinity` → stocké à `0`).
- **Content-Security-Policy ajoutée** (`index.html`) — défense en profondeur : aucune faille XSS connue,
  mais si une apparaissait, `script-src 'self'` bloque tout script distant/injecté. A nécessité de sortir le
  `<script>` inline d'enregistrement du Service Worker vers un fichier externe (`js/sw-register.js`), sinon
  incompatible avec `script-src` sans `'unsafe-inline'`. `style-src` garde `'unsafe-inline'` (le CSS de
  l'app repose largement sur des attributs `style=""` — un refactor en classes CSS est un chantier séparé,
  pas une urgence sécurité vu que XSS-via-CSS est un vecteur bien plus faible que XSS-via-JS, déjà bloqué
  par `script-src`). `connect-src` autorise `open.er-api.com` (taux de change en ligne) ; `worker-src 'self'
  blob:` nécessaire pour le Worker Tesseract (OCR). Testé : PDF (jsPDF), OCR (Worker Tesseract, blob PNG de
  test), fetch de taux en ligne, et les 11 vues de l'app — tout fonctionne sous la nouvelle politique.
  `frame-ancestors` volontairement absent (n'a aucun effet via `<meta>`, exige un en-tête HTTP — hors de
  portée d'un hébergement statique GitHub Pages).

`CACHE_VERSION` : `v29` → `v30`. Nouveau fichier `js/sw-register.js` ajouté au précache de `sw.js`.

### 13 août 2026 (suite) — Assistant de configuration multi-étapes (commit à venir)

À la demande de l'utilisateur : après le code PIN, avant le tableau de bord, un assistant en **7 étapes**
guide la première configuration au lieu du mini-flow à 2 étapes précédent (devise + portefeuille). Chaque
étape a un bouton "Passer cette étape" — rien n'est obligatoire au-delà du PIN lui-même (validé avec
l'utilisateur : décourager un premier lancement trop long serait pire que l'inverse), tout reste modifiable
ensuite dans Paramètres. Étapes, dans l'ordre : devise principale → premier portefeuille → profil → panneaux
du tableau de bord → modules optionnels → sécurité (verrouillage auto + biométrie) → notifications.

**Réutilisation plutôt que duplication** (`app.js` importe directement de `settings.js`/`dashboard.js`/
`auth.js`/`notifications.js`, aucune logique redéfinie) :
- `PROFILE_FIELDS`, `AUTO_LOCK_OPTIONS`, `DASHBOARD_PANEL_LABELS` exportés depuis `settings.js` (n'étaient
  que des consts locales avant).
- **`OPTIONAL_MODULES`** (`settings.js`) : la case "Comptes gardés" isolée est devenue une liste
  `[{key, label, description, navId, view}]` — actuellement un seul élément, mais l'ajout d'un futur module
  optionnel ne demandera qu'une entrée ici (ni `renderFeaturesSection()`, ni l'étape "Modules" de
  l'onboarding, ni `openMoreSheet()` dans `app.js` n'ont à changer). `applyOptionalModuleVisibility()`
  (exportée, remplace l'ancienne `applyKeptAccountsVisibility()` propre aux comptes gardés) boucle sur cette
  liste pour afficher/masquer les boutons de nav correspondants.
- `openWalletModal()` (`wallets.js`) accepte désormais `{ onDone }`, threadé vers le `onClose` déjà supporté
  par `openModal()` — l'étape "portefeuille" masque la modale de l'assistant (`style.display='none'`) pendant
  que la modale de création de portefeuille (réutilisée telle quelle) est ouverte par-dessus, puis la
  réaffiche et avance à l'étape suivante quand celle-ci se ferme (créée ou annulée, peu importe).

Testé en conditions réelles, deux fois : parcours complet en remplissant chaque étape (devise XOF, portefeuille
créé avec la bonne devise pré-sélectionnée, profil, panneaux dashboard, module Comptes gardés activé — nav
visible immédiatement en cours de parcours —, verrouillage auto, notifications) puis vérification en base que
tout est bien enregistré ; et parcours complet en appuyant sur "Passer" à chaque étape (aucune erreur, aucun
portefeuille créé, fermeture propre). La page Paramètres elle-même re-testée après le refactor des exports —
toujours fonctionnelle. Le rappel de sauvegarde hebdomadaire (modal indépendant, 4s après déverrouillage) peut
apparaître par-dessus l'assistant sur un tout premier lancement — comportement de pile de modales déjà toléré
ailleurs dans l'app, pas une régression.

### 13 août 2026 (suite) — Tentative de sync cloud Firebase, ajoutée puis annulée (hors session Claude)

Deux commits sont apparus entre deux sessions, faits en dehors de cette conversation (probablement une autre
session/outil sur ce même dossier local) : `feat: ajout synchronisation cloud Firebase (Firestore + Google
Auth)` puis son revert complet juste après (35 min plus tard). Résultat net : **aucun changement de code**
(diff vide entre avant/après les deux commits). Personne n'a expliqué le pourquoi de l'annulation dans cette
conversation — si la sync multi-appareil est reprise un jour (voir §7), redemander le contexte de cette
tentative avant de relancer, plutôt que de repartir de zéro à l'aveugle.

### 13 août 2026 (suite) — Historique de commits réécrit pour corriger l'identité auteur

Les commits faits sur ce projet depuis `7f5943b` (toute cette série de sessions, y compris la tentative
Firebase ci-dessus) portaient l'identité `GeoFinance <karidja810@gmail.com>` (config git locale à ce dépôt,
distincte de la config globale de la machine) au lieu de `zaky04` (auteur de tous les commits précédents et
propriétaire du dépôt GitHub). Réécrit via `git filter-branch --env-filter` sur la plage `3ae34a2..HEAD` (7
commits, contenu strictement identique — seuls auteur/committer/hash ont changé) vers
`zaky04 <zaky04@users.noreply.github.com>` (même format que l'historique existant), puis
`git push --force-with-lease`. **Tous les hash de commits ont donc changé** — un `git log` gardé d'avant
cette date ne correspondra plus. La config git locale du dépôt n'a PAS été touchée (hors de portée d'une
session Claude) : sans correction manuelle par l'utilisateur (`git config user.name/user.email` dans ce
dossier), le PROCHAIN commit repartira avec la mauvaise identité.

### 13 août 2026 (suite) — Recherche globale + catégorisation automatique (commit à venir)

1. **Recherche globale n'indexait pas Comptes gardés ni Partage de dépenses** (`search.js`) — oubli mécanique,
   ces deux modules sont arrivés après l'écriture du module de recherche. Ajouté (comptes gardés seulement si
   `keptAccountsEnabled`, cohérent avec le fait que la nav elle-même reste masquée sinon).

2. **Catégorisation automatique unifiée et améliorée** — deux implémentations quasi-identiques dupliquées
   existaient : `suggestCategoryFromNote()` (`transactions.js`, Saisie express) et `guessCategory()`
   (`backup.js`, import CSV générique). Cette dernière **ne consultait jamais** `STORES.CATEGORIZATION_RULES`
   (les règles définies dans Budgets > Règles) — un import CSV de plusieurs dizaines de lignes de relevé
   bancaire ignorait donc silencieusement les règles que l'utilisateur avait pourtant configurées, alors que
   c'est exactement le scénario où l'auto-catégorisation compte le plus.
   → Nouvelle fonction partagée `guessCategoryId(note, type)` dans `ledger.js` (précédent explicite d'un tel
   partage : `detectRecurringCandidates()` dans le même fichier). Garde le même prédicat de correspondance
   qu'avant (égalité ou inclusion dans un sens ou l'autre — pas de régression sur ce qui matchait déjà), mais
   **choisit la catégorie la plus fréquente parmi les correspondances plutôt que celle de la transaction la
   plus récente** — une catégorisation ponctuellement erronée sur un achat récurrent ne fausse plus toutes
   les suggestions suivantes. Étend aussi la vérification des règles aux notes de type `income` (limitée à
   `expense` auparavant, sans raison technique).
   Vérifié par test réaliste : 2 transactions "Boulangerie du coin" catégorisées Alimentation + 1 plus
   récente catégorisée par erreur Autres dépenses → la suggestion renvoie bien Alimentation (majorité), pas
   la plus récente. Règle explicite "essence" → Transport testée sur l'import CSV générique → catégorie
   correctement appliquée (ne l'aurait jamais été avant ce fix).

`CACHE_VERSION` : `v31` → `v32`.

### 13 août 2026 (suite) — Les transactions de dette/créance n'étaient jamais catégorisées (commit à venir)

Signalé par l'utilisateur avec une capture de l'app déployée : les transactions créées par le lien
dettes↔portefeuilles (§ "13 août 2026 (suite) — 3 fonctionnalités...") avaient `categoryId: null` en dur,
volontaire à l'époque (pas de catégorie dédiée prévue) mais affichant "Sans catégorie" dans la liste des
transactions — repéré en prod (`zaky04.github.io/geofinance`) sur deux vraies transactions ("Prêt reçu de
gouv", "Prêt accordé à Sali").
→ `debts.js` : nouvelle `ensureDebtCategoryId(type)` (exportée), retrouve ou crée une catégorie "Prêt et
créance" — une par type (`income`/`expense`, les catégories sont scindées par type dans ce store) — utilisée
à la fois pour la transaction d'ouverture et celle de remboursement. Reste exclue des agrégats budgétaires
comme avant : ce fix ne touche que l'affichage (categoryId), pas le filtre `debtId` de `ledger.js`.
**Migration au boot** (`app.js`, `migrateDebtTransactionCategories()`, appelée à chaque démarrage — coût nul
une fois les lignes historiques corrigées) : rattrape automatiquement les transactions déjà en base avec
`debtId` mais sans `categoryId`, donc les transactions de l'utilisateur visibles sur la capture se corrigent
au prochain chargement de l'app, sans action de sa part.
Vérifié : transaction "cassée" (categoryId null) injectée manuellement → réapparaît "Prêt et créance" après
reload ; nouvelle dette créée → catégorisée immédiatement ; "Entrées (mois)" du dashboard reste à 0 malgré
2150€ de transactions "Prêt et créance" (l'exclusion budgétaire n'a pas été affectée par ce changement).

`CACHE_VERSION` : `v32` → `v33`.

### 13 août 2026 (suite) — "Prêt et créance" scindé en "Prêt" et "Créance" (commit à venir)

Retour utilisateur juste après le fix précédent : catégorie unique pas assez précise, voulait "Prêt" pour les
dettes et "Créance" pour les créances, distincts.
→ `debts.js` : `DEBT_CATEGORY_NAMES = { debt: 'Prêt', receivable: 'Créance' }` (exporté), `LEGACY_DEBT_CATEGORY_NAME
= 'Prêt et créance'` (exporté, gardé pour la migration). `ensureDebtCategoryId(debtType, txType)` prend
maintenant le type de la DETTE (`debt`/`receivable`) en plus du type de transaction (`income`/`expense`) — le
nom dépend du sens de la dette, pas du sens du mouvement d'argent, donc une dette (Prêt) garde "Prêt" aussi
bien à l'ouverture (income) qu'au remboursement (expense).
`app.js` `migrateDebtTransactionCategories()` étendue pour rattraper aussi les transactions déjà catégorisées
"Prêt et créance" (pas seulement `categoryId` null) en retrouvant la dette liée via `debtId` pour déterminer
Prêt vs Créance, **puis supprime les catégories "Prêt et créance" orphelines** (plus référencées ni par une
transaction ni par un budget) pour ne pas laisser de catégorie morte dans Budgets > Catégories.
Vérifié en conditions réelles : dette (Sali) + son remboursement → "Prêt" dans les deux cas ; créance (Awa) +
son remboursement → "Créance" dans les deux cas ; exclusion budgétaire toujours intacte ("Entrées/Sorties du
mois" à 0 malgré ~650€ de mouvements catégorisés) ; une transaction orpheline (debtId sans dette réelle
correspondante, artefact d'un test précédent) correctement laissée de côté par la migration plutôt que de
deviner — comportement défensif voulu, pas un bug.

`CACHE_VERSION` : `v33` → `v34`.

### 13 août 2026 (suite) — Sauvegarde cloud optionnelle via Google (Firebase Auth + Firestore)

Reprise cadrée de la tentative Firebase annulée plus tôt (§ "Tentative de sync cloud Firebase, ajoutée puis
annulée"). **Diagnostic confirmé** (horodatages git) : la CSP a été ajoutée à 12h34, Firebase à 15h51 —
`script-src`/`connect-src` bloquaient tous les domaines Google/Firebase, personne ne les avait ajoutés en
même temps. Reconstruit proprement cette fois, avec deux choix validés avec l'utilisateur avant de coder :

1. **Chiffré, pas en clair** — réutilise `buildEncryptedPayload`/`decryptPayload` (voir ci-dessous), le même
   chiffrement AES-GCM/PBKDF2 que l'export chiffré local, déjà éprouvé. Le mot de passe ne quitte jamais
   l'appareil ; même une mauvaise configuration des règles Firestore ne rendrait rien lisible.
2. **Sauvegarder/Restaurer à la demande, pas de synchro continue** — un seul document Firestore par
   utilisateur (clé = UID Google), contenant le blob chiffré. Aucun moteur de résolution de conflits à
   construire.

**Fichiers** :
- `backup.js` — extrait `buildEncryptedPayload(passphrase)`/`decryptPayload(payload, passphrase)` (exportées)
  du cœur d'`exportEncryptedBackup`/`importEncryptedBackup`, qui les appellent maintenant au lieu de dupliquer
  le chiffrement. `deserializeReceiptsForImport` et `markBackupDone` exportées aussi (réutilisées côté cloud).
- `js/firebase-config.js` (nouveau) — objet `firebaseConfig`, valeurs `'REPLACE_ME'` tant que l'utilisateur
  n'a pas créé son projet Firebase et fourni les vraies clés (pas secrètes — la sécurité vient des règles
  Firestore, pas de la confidentialité de l'apiKey). `isFirebaseConfigured` détecte l'état non configuré.
- `js/firebase-sync.js` (nouveau) — SDK Firebase (modular, CDN ESM, pas de build/npm) chargé **paresseusement**
  via `import()` dynamique, uniquement si une connexion précédente est connue (setting
  `cloudBackupWasSignedIn`) ou au clic sur "Se connecter" — jamais sur le chemin par défaut. `waitForAuthReady()`
  attend la première notification `onAuthStateChanged` plutôt que de lire `auth.currentUser` immédiatement
  après `getAuth()` (la restauration de session est asynchrone, lire trop tôt peut renvoyer null à tort).
  `signInWithGoogle`, `signOutGoogle`, `pushBackupToCloud`, `pullBackupFromCloud`, `renderCloudBackupSection`
  (UI montée dans Paramètres, nouveau conteneur `#settings-cloud-backup`).
- `index.html` — CSP étendue : `script-src` += gstatic/apis.google/googleapis, `connect-src` +=
  firestore/identitytoolkit/securetoken/firebaseio (+ `wss://`), nouvelle directive `frame-src` pour la
  fenêtre de connexion Google. Domaines confirmés par recherche externe avant d'écrire le code.

**Testé sans les vraies clés Firebase** (limite assumée — voir plan) : app fonctionnelle sans jamais charger
le SDK tant que non sollicité (zéro requête réseau gstatic/googleapis vérifiée) ; le SDK réel (les 3 sous-
modules) se charge sans violation CSP via `import()` direct de l'URL gstatic — **le point exact qui cassait
tout la dernière fois est confirmé corrigé** ; `buildEncryptedPayload`/`decryptPayload` : aller-retour
chiffrement/déchiffrement correct, mauvais mot de passe correctement rejeté (non-régression du refactor).

`CACHE_VERSION` : `v34` → `v35`.

### 13 août 2026 (suite) — Projet Firebase réel créé et branché

L'utilisateur a suivi le guide pas à pas (console.firebase.google.com : projet `geofinance-backup`, connexion
Google activée, Firestore créé en mode production avec les règles de sécurité restreignant chaque utilisateur
à son propre document, domaine `zaky04.github.io` autorisé) et fourni la config réelle → `js/firebase-config.js`
mis à jour (`REPLACE_ME` remplacés par les vraies valeurs — pas secrètes, sécurité assurée par les règles
Firestore, pas par la confidentialité de l'apiKey).

**Test supplémentaire avec la vraie config** (toujours sans pouvoir compléter une vraie connexion Google —
ça nécessite l'interaction humaine de l'utilisateur dans son propre navigateur) : `signInWithGoogle()` appelé
directement → échoue avec `auth/popup-blocked`, **pas** une erreur de config (`auth/invalid-api-key` etc.) ni
une violation CSP. Ça confirme que Firebase accepte la config réelle et atteint l'étape d'ouverture de la
fenêtre de connexion — seul le bloqueur de popup du navigateur automatisé (sans geste utilisateur "de
confiance") arrête le flux à ce stade précis, ce qui n'arrivera pas pour l'utilisateur cliquant normalement.

**Reste à faire par l'utilisateur** : tester réellement "Se connecter avec Google" dans son navigateur (popup
devrait s'ouvrir normalement), "Sauvegarder maintenant" (vérifier dans la console Firebase → Firestore
Database qu'un document apparaît sous `backups/{son-UID}`), puis simuler une réinstallation (vider les
données de site ou utiliser un autre appareil/profil) → se reconnecter → "Restaurer depuis le cloud" → vérifier
que les données reviennent.

Petite lacune connue, non bloquante : les messages d'erreur Firebase remontés dans les toasts (ex.
`Firebase: Error (auth/popup-blocked).`) sont les codes techniques bruts du SDK, pas traduits en français
convivial. À améliorer si ça se révèle confus en usage réel, pas une urgence.

### 13 août 2026 (suite) — Connexion Google cassée sur mobile, corrigée (repli sur signInWithRedirect)

Signalé par l'utilisateur en testant sur mobile : le bouton "Se connecter avec Google" reste bloqué sur
"Connexion…" sans rien faire. Cause connue et bien documentée de l'écosystème Firebase : `signInWithPopup`
est peu fiable sur mobile et **ne fonctionne carrément pas** dans une PWA installée en plein écran
(`display-mode: standalone`) — il n'y a pas de fenêtre de navigateur où ouvrir la popup.

→ `firebase-sync.js` : `shouldPreferRedirect()` (réutilise `isStandalone`/`isIOS`/`isAndroid` déjà exportées
par `install-prompt.js`, pas de détection dupliquée) — sur mobile/PWA installée, `signInWithGoogle()` appelle
directement `signInWithRedirect()` (navigation de page complète vers Google puis retour) au lieu de
`signInWithPopup()` ; sur desktop, popup tentée en premier, avec repli automatique sur la redirection si elle
échoue (`auth/popup-blocked`, `auth/popup-closed-by-user`, `auth/operation-not-supported-in-this-environment`,
`auth/cancelled-popup-request`). Un flag `cloudRedirectPending` (settings) est posé juste avant la navigation
(elle interrompt toute exécution JS en cours, donc rien après `signInWithRedirect()` ne s'exécute) et lu au
retour par `handlePendingRedirect()`, appelée dans `renderCloudBackupSection()` avant `waitForAuthReady()`.
Conséquence acceptée : le retour de redirection recharge toute la page, donc l'utilisateur retombe sur l'écran
de code PIN (comportement normal de l'app à chaque chargement) avant de pouvoir revoir son état de connexion
dans Paramètres — pas un bug, effet secondaire attendu d'un flux de connexion par redirection.

Testé en émulant un contexte mobile (user-agent Android) : `shouldPreferRedirect()` détecte correctement
`isAndroid: true`, le clic sur "Se connecter" déclenche directement une vraie navigation vers
`accounts.google.com` (titre d'onglet vérifié) sans jamais tenter la popup cassée ; `cloudRedirectPending`
correctement posé à `true` avant la navigation, persiste après retour sur l'app, et se remet à `false`
proprement même sans connexion réellement complétée (annulée volontairement — compléter une vraie connexion
Google nécessite les identifiants de l'utilisateur, hors de portée d'une session Claude). Avertissement
console bénin et connu de l'écosystème Firebase+Chrome (`Cross-Origin-Opener-Policy policy would block the
window.closed call`) observé lors du test popup sur desktop — n'affecte pas le flux réel, disparaît de toute
façon sur mobile/PWA installée puisque la popup n'y est plus jamais tentée.

`CACHE_VERSION` : `v35` → `v36`.

### 13 août 2026 (suite) — Bug réel trouvé : le mot de passe de chiffrement était toujours perdu

Signalé par l'utilisateur : connecté avec succès, clique "Sauvegarder maintenant", saisit le mot de passe de
chiffrement, puis... rien. Cause : dans `promptPassphrase()` (dupliquée à l'identique dans `firebase-sync.js`
et **déjà présente avant, dans `settings.js`**), l'ordre des deux appels était `modal.close(); resolve(p);`.
Or `openModal()`'s `close()` (`utils.js`) déclenche `onClose()` **synchroniquement**, et l'`onClose` fourni ici
est `() => resolve(null)` — donc `resolve(null)` s'exécutait avant `resolve(p)`, et comme une Promise ignore
toute résolution après la première, le mot de passe réel était **systématiquement perdu**, silencieusement
(`if (!p) return;` côté appelant). Reproduit et confirmé en isolant exactement ce motif dans le navigateur.

**Portée du bug** : pas nouveau avec Firebase — `promptPassphrase()` dans `settings.js` (export/import "JSON
chiffré" en local, boutons présents depuis longtemps) avait exactement le même défaut. Autrement dit
l'export/import chiffré local ne fonctionnait probablement jamais non plus depuis ce menu, bug pré-existant
non lié à cette session, découvert par ricochet en développant la sauvegarde cloud.
`confirmDialog()` (`utils.js`), qui suit un motif similaire, n'est PAS concerné : son auteur original avait
mis le bon ordre (`resolve(true); modal.close();`) — seul `promptPassphrase` (écrit séparément) avait
l'ordre inversé. Recherché dans tout le projet (`grep`) : aucune autre occurrence du motif fautif.

→ Corrigé aux deux endroits (`settings.js` et `firebase-sync.js`) : `resolve(p)` avant `modal.close()`.
Testé : export JSON chiffré local (`settings.js`) → `lastBackupAt` correctement mis à jour immédiatement
après soumission du mot de passe (avant le fix, il ne l'était jamais, confirmé par comparaison avant/après).

`CACHE_VERSION` : `v36` → `v37`.

### 13 août 2026 (suite) — Dépassement de la limite de taille Firestore (1 Mo/document)

Signalé par l'utilisateur, mot de passe cette fois correctement transmis (fix précédent) : erreur
`the value property payload is longer than 1048487 bytes`. Cause : Firestore refuse tout document de plus de
~1 Mo — la sauvegarde complète (historique de transactions + justificatifs photo convertis en data URL
base64 dans le payload, voir `serializeReceiptsForExport()` dans `backup.js`) dépasse vite cette limite en
usage réel, stockée jusqu'ici dans un seul champ d'un seul document.

→ `firebase-sync.js` : le JSON chiffré est découpé en morceaux de 900 000 caractères (`CHUNK_SIZE`, marge
sous la limite exacte), stockés dans une sous-collection `backups/{uid}/chunks/{i}` plutôt qu'un seul champ.
Le document `backups/{uid}` lui-même ne garde qu'un `chunkCount` + `updatedAt`. `pushBackupToCloud()` supprime
d'abord les anciens morceaux (leur nombre varie d'une sauvegarde à l'autre) avant d'écrire les nouveaux, le
tout dans un seul `writeBatch` (atomique — soit tout s'écrit, soit rien). `pullBackupFromCloud()` lit
`chunkCount`, récupère tous les morceaux en parallèle, les concatène, puis déchiffre comme avant.
**Nécessite une mise à jour des règles de sécurité Firestore** (nouvelle sous-collection à couvrir) :
```
match /backups/{userId} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
  match /chunks/{chunkId} {
    allow read, write: if request.auth != null && request.auth.uid == userId;
  }
}
```
Testé : découpage/réassemblage d'une chaîne de 2,3 Mo simulée (proche d'une sauvegarde avec plusieurs
justificatifs photo) → 3 morceaux, tous sous la limite, réassemblage strictement identique à l'original.
Écriture/lecture Firestore réelles à confirmer par l'utilisateur (règles mises à jour requises côté console).

`CACHE_VERSION` : `v37` → `v38`.

### 14 août 2026 — Restauration cassée par la CSP : `fetch(data:...)` bloqué (commit à venir)

Signalé par l'utilisateur après avoir franchi les étapes précédentes (connexion, mot de passe, découpage) :
`Failed to fetch` en cliquant "Restaurer depuis le cloud". Reproduit directement dans le navigateur pour
confirmer la cause exacte avant de corriger : `fetch('data:text/plain;base64,...')` échouait avec
`TypeError: Failed to fetch`, et la console révélait le vrai coupable — la CSP (`connect-src`), pas un bug
réseau ou Firestore.

Cause : `dataUrlToBlob()` (`backup.js`), utilisée par `deserializeReceiptsForImport()` pour reconstituer les
photos de justificatifs (`receiptBlob`) à partir de leur forme sérialisée en data URL base64, appelle
`fetch(dataUrl)` — un usage détourné mais standard de `fetch()` pour convertir une data URL en `Blob`. La CSP
`connect-src` ajoutée pour Firebase (§13 août, Firebase) n'incluait pas `data:`, donc tout navigateur qui
respecte la CSP pour les data URLs (Chrome le fait) bloquait cette conversion.

**Portée plus large que la restauration cloud seule** : `deserializeReceiptsForImport()` est aussi le chemin
utilisé par l'import local de sauvegarde chiffrée (`importEncryptedBackup()` dans `backup.js`, bouton
"Importer (JSON chiffré)" des Paramètres) — toute sauvegarde locale ou cloud contenant au moins un
justificatif photo échouait à l'import, silencieusement liée à ce même bug, pas seulement au cloud.

→ `index.html` : ajout de `data:` à `connect-src` dans la CSP. Commentaire explicatif mis à jour pour
documenter pourquoi (éviter qu'un futur audit sécurité le retire en pensant à une faille).

Testé : `fetch('data:text/plain;base64,aGVsbG8=')` échouait avant le correctif (`Failed to fetch`, erreur CSP
visible dans la console), réussit après (reload complet + vidage du cache SW pour prendre en compte la
nouvelle CSP du `index.html`).

`CACHE_VERSION` : `v38` → `v39`.

### 14 août 2026 (suite) — Après restauration, "Comptes gardés" restait invisible dans le menu desktop

Signalé par l'utilisateur juste après avoir restauré sa sauvegarde cloud sur un second appareil
(desktop) : les transactions étaient bien revenues, mais l'onglet "Comptes gardés" — activé côté
mobile avant la sauvegarde — n'apparaissait pas dans le menu latéral, alors que le réglage aurait
dû suivre.

Cause : le réglage `keptAccountsEnabled` (comme tout `STORES.SETTINGS`) est bien inclus dans
`exportAllData()`/`importAllData()` et revient donc correctement en base après import/restauration.
Mais la visibilité du bouton de nav (`#nav-kept-accounts`, `hidden` géré par
`applyOptionalModuleVisibility()` dans `settings.js`) n'était recalculée qu'au démarrage de l'app
(`app.js`) et quand l'utilisateur cochait la case lui-même dans Paramètres — jamais après un import
JSON local, un import chiffré local, ou une restauration cloud, qui écrivent pourtant ce même
réglage. Le bouton restait figé dans l'état d'avant l'import jusqu'au prochain rechargement complet
de la page.

→ `app.js` : le listener déjà abonné à `EVENTS.DATA_CHANGED` (qui re-rend la vue courante) appelle
maintenant aussi `applyOptionalModuleVisibility()` quand le scope est `'all'` — le scope utilisé par
les 3 chemins d'import/restauration (`importJsonBackup`, `importEncryptedBackup`,
`pullBackupFromCloud`), sans avoir à modifier ces 3 fonctions individuellement.

Testé : réglage `keptAccountsEnabled` remis à `false` puis bouton de nav forcé `hidden` (simulant
l'état au boot avant import) → réglage remis à `true` en base + `notifyDataChanged('all')` (ce que
fait exactement un import) → bouton passe à `hidden = false` immédiatement, sans rechargement.

`CACHE_VERSION` : `v39` → `v40`.

### 14 août 2026 (suite) — Selects/inputs restaient blancs en thème sombre en dehors de `.form-row`

Signalé par l'utilisateur (capture d'écran) : en thème sombre, le `<select>` "Verrouillage
automatique après inactivité" (Paramètres) restait rendu en clair (fond blanc natif du navigateur),
détonnant visuellement au milieu d'une page sombre.

Cause : seule la règle `.form-row input, .form-row select, .form-row textarea` (styles.css)
applique un fond/bordure suivant les variables de thème. Or de nombreux `<select>`/`<input>` de
l'app sont rendus hors d'un `.form-row` (listes déroulantes courtes dans des lignes `stat-row`,
filtres, sélecteurs inline) — pour ceux-là, seule la règle de reset minimal `input, select, textarea
{ font: inherit; color: inherit; }` s'appliquait, qui ne touche ni au fond ni à la bordure : le
navigateur retombe alors sur son rendu natif (fond blanc), quel que soit le thème de la page. Un
audit du reste de l'app a montré que ce n'était pas un cas isolé : `#base-currency-select`,
`#ef-months`/`#pi-mode` (Outils), `#tx-filter-*` (Transactions, bien que déjà couverts par
`.filters-bar` dans ce cas précis), les selects de type de transaction fractionnée, etc. — tous
potentiellement concernés selon leur emplacement dans le markup.

→ `styles.css` : la règle de reset globale `input, select, textarea` porte maintenant elle-même
`background: var(--surface-alt)`, `border`, `border-radius` et le focus outline — donc tout
select/input texte respecte le thème quel que soit son wrapper, sans dépendre de `.form-row`.
Explicitement exclu de cette règle : `checkbox`/`radio`/`range`/`color`/`file`/`image`, dont le
rendu natif (case à cocher, etc.) n'a pas besoin de fond/bordure custom et serait déformé par ces
propriétés. Les règles plus spécifiques déjà en place (`.form-row select`, `.filters-bar select`,
`.search-input-row input`) restent inchangées et continuent de gagner par spécificité CSS — pas de
régression sur leurs styles existants (padding/fond légèrement différents, intentionnels).

Testé : fond calculé (`getComputedStyle`) de plusieurs selects pris dans des vues différentes
(Paramètres, Transactions, Outils) en thème sombre → tous sombres (`rgb(23,28,51)` / `rgb(18,22,43)`
selon la variable utilisée) ; repassé en thème clair → tous clairs à nouveau, sans changement pour
les cases à cocher (fond transparent inchangé).

`CACHE_VERSION` : `v40` → `v41`.

### 14 août 2026 (suite) — Import CSV générique : les lignes invalides disparaissaient sans avertissement

Dette technique identifiée depuis l'audit du 12 août (§5.4, §7.3) : dans `importGenericCsvRows`
(`backup.js`, import d'un relevé bancaire générique via mapping de colonnes), une ligne dont la date
ou le montant ne pouvait pas être lu (colonne vide, format inattendu, mauvaise colonne choisie dans
le mapping) était silencieusement ignorée (`continue`) — sans incrémenter le moindre compteur.
L'utilisateur voyait juste "X transaction(s) importée(s)" sans jamais savoir qu'il manquait des
lignes de son relevé, ni pourquoi.

→ Ajout d'un troisième compteur `invalid` (aux côtés de `imported`/`skipped`), incrémenté à chaque
ligne ignorée pour date ou montant illisible. Toast mis à jour dans `settings.js` pour afficher ce
décompte : *"X transaction(s) importée(s). Y doublon(s) ignoré(s). Z ligne(s) invalide(s)
ignorée(s) (date ou montant illisible — vérifiez le mapping des colonnes)."*

`importDjignanCsvRows` (ré-import du propre format d'export CSV de Djignan) n'a volontairement
pas été touché : c'est un format fixe et fiable généré par l'app elle-même, contrairement au CSV
générique dont le mapping est manuel et sujet à erreur — le risque de ligne mal formée y est
structurellement bien plus faible.

Testé : import de 5 lignes fictives (1 date invalide, 1 montant vide, 1 montant non numérique, 2
valides) → `{ imported: 2, skipped: 0, invalid: 3 }`, conforme.

`CACHE_VERSION` : `v42` → `v43`.

### 14 août 2026 (suite) — Tolérance de dérive flottante sur les comparaisons de seuil exact

Dette technique §5.2 : les montants sont des `Number` JS sommés directement (pas de centimes
entiers), donc une somme peut ponctuellement dériver de quelques millièmes de centime (classique :
`0.1 + 0.2 === 0.30000000000000004` en JS). Deux endroits comparaient un total à un seuil de façon
**exacte**, sans marge : un budget respecté "pile" au centime près pouvait donc apparaître, à tort,
comme dépassé.

→ Appliqué la même convention de tolérance qu'utilise déjà `debts.js` ailleurs dans le code (marge de
`0.005`, soit un demi-centime) aux deux points identifiés :
- `ledger.js` (`computeFinancialHealthScore`) : `r.actual <= r.budget` → `r.actual <= r.budget + 0.005`
  pour le calcul du taux de respect du budget (composante du score de santé financière).
- `dashboard.js` : `monthlyBudget.remaining >= 0` → `monthlyBudget.remaining >= -0.005` pour choisir
  entre l'affichage "Reste X €" et "Dépassé de X €" sur le tableau de bord.

Une vraie migration vers des centimes entiers en stockage reste volontairement hors scope — voir
§7.4 pour le raisonnement (chantier disproportionné pour un problème jamais rapporté en pratique).

Testé : ajout d'un scénario dédié dans `test/ledger.test.html` (§11) — un budget de 0.3 € consommé
par deux dépenses de 0.1 € et 0.2 € (qui dérive réellement à `0.30000000000000004` en JS, vérifié
explicitement) reste compté comme respecté (`budgetAdherencePct === 100`) grâce à la tolérance.

`CACHE_VERSION` : `v43` → `v44`.

### 14 août 2026 (suite) — Rappel périodique pour la sauvegarde cloud

La sauvegarde cloud (§6, 13 août) n'existait qu'à la demande — rien ne rappelait à l'utilisateur de
l'utiliser, contrairement à l'export local qui a son propre rappel hebdomadaire avec escalade
(`checkWeeklyBackupReminder`, §6.2). Proposé par l'auteur, implémenté à sa demande.

→ `firebase-sync.js` : `checkWeeklyCloudBackupReminder()`, même principe que le rappel local — report
par tranches de 24h (`cloudBackupSnoozedUntil`), mode "urgent" au-delà de 3 reports
(`cloudBackupSnoozeCount`, bouton "Plus tard" retiré), remis à 0 après toute sauvegarde cloud réussie
(déplacé dans `pushBackupToCloud()` elle-même — pas seulement le chemin du rappel — pour qu'une
sauvegarde manuelle depuis Paramètres compte aussi). Ne s'affiche que si `cloudBackupWasSignedIn`
(réglage local) est vrai : un utilisateur qui n'a jamais connecté son compte Google ne voit jamais ce
rappel, et surtout **ne déclenche jamais le chargement du SDK Firebase** rien que pour la vérification
— seul un clic sur "Sauvegarder maintenant" dans le rappel charge le SDK, même principe de paresse que
le reste du fichier. Appelé au boot (`app.js`) via `setTimeout` à 6s, décalé après le rappel local (4s)
pour ne pas empiler les deux invites si les deux tombent le même jour.

Testé dans le navigateur (base IndexedDB isolée) : aucune modale ni appel réseau pour un utilisateur
jamais connecté ; modale correcte après 7 jours pour un utilisateur connecté ; clic "Plus tard" pose
bien le report et le rappel ne se réaffiche pas immédiatement après ; 3 reports + snooze expiré →
mode urgent (pas de bouton "Plus tard", message adapté) ; clic "Sauvegarder maintenant" ferme le
rappel et ouvre bien l'invite de mot de passe de chiffrement.

`CACHE_VERSION` : `v44` → `v45`.

### 14 août 2026 (suite) — Audit accessibilité : boutons icône sans nom accessible

Jamais fait à ce jour sur l'app (§7.6, demandé par l'auteur). Constat principal : la quasi-totalité
des boutons "icône seule" (modifier, supprimer, archiver, pointer une transaction, etc. — présents
dans presque tous les modules) utilisaient uniquement `title="..."` pour indiquer leur fonction.
`title` s'affiche en infobulle à la souris, mais n'est fiable ni au clavier (pas de tooltip visible
au focus dans la plupart des navigateurs) ni pour un lecteur d'écran (support inégal, certains
l'ignorent complètement pour le nom accessible d'un `<button>` sans texte) — un bouton "icône seule"
sans `aria-label` est essentiellement un bouton sans nom pour ces utilisateurs.

→ Ajouté `aria-label` (même texte que le `title` existant, y compris pour les libellés dynamiques
comme "Archiver"/"Désarchiver") à tous les boutons `icon-btn` qui n'en avaient pas : `debts.js`,
`kept-accounts.js`, `budgets.js`, `investments.js`, `savings.js`, `shared.js`, `transactions.js`,
`wallets.js` (~25 boutons). Ceux qui avaient déjà `aria-label` (navigation mois/année, fermeture de
modale, filtres de recherche) n'ont pas été touchés.

**Trouvé mais volontairement pas corrigé, à valider avec l'auteur** : `--text-faint` (utilisé pour
les états vides, les libellés du calendrier, les tendances des cartes résumé — pas juste décoratif)
a un contraste insuffisant contre son fond dans les deux thèmes : ≈2.6:1 en clair (`#9aa0b4` sur
`#ffffff`), ≈3.7:1 en sombre (`#6b7096` sur `#12162b`) — sous le seuil WCAG AA de 4.5:1 pour du texte
normal. Non corrigé ici car resserrer ce contraste implique de foncer la teinte, ce qui la
rapprocherait visuellement de `--text-muted` (déjà à la limite, ≈4.9:1) et réduirait la hiérarchie
visuelle à 2 niveaux au lieu de 3 — un choix de design, pas un simple bug, à trancher avec l'auteur
avant de toucher une variable utilisée dans une dizaine d'endroits.

`CACHE_VERSION` : `v45` → `v46`.

### 14 août 2026 (suite) — Mesuré et corrigé : computeNetWorthHistory 7x plus lent que ses jumelles

Suite de l'audit demandé par l'auteur (§7.7 listait le risque comme "non mesuré, à profiler si un
jour rapporté" — mesuré tout de suite plutôt que de laisser la piste ouverte sans données). Généré un
jeu de données synthétique réaliste (14 600 transactions, 5 ans, ~8/jour) dans une base IndexedDB de
test isolée, puis chronométré chaque agrégat de `ledger.js` utilisé par le tableau de bord.

Résultat : la plupart des calculs prennent 200-700ms sur ce volume (pas instantané, mais pas
gênant — le tableau de bord les exécute en parallèle via `Promise.all`, voir `dashboard.js`).
`computeNetWorthHistory(6)` sortait du lot à **1555ms**, contre ~215-235ms pour
`computeInvestmentValueHistory`/`computeDebtHistory` qui calculent pourtant un historique similaire
sur la même période. Cause : ces deux dernières appellent `ctx()` (10 lectures IndexedDB) **une
seule fois** puis bouclent en mémoire sur les données déjà chargées — `computeNetWorthHistory`,
elle, délègue à `computeNetWorth(cutoff)` à chaque itération, qui rappelle `ctx()` à chaque fois : un
historique sur 6 mois relit donc l'intégralité des portefeuilles/transactions/investissements/dettes
6 fois de suite pour un résultat identique à chaque relecture (seule la date de coupure change).

→ Extrait le cœur pur de `computeNetWorth` dans `netWorthAt(cutoffDate, data)` (aucun accès DB) ;
`computeNetWorth()` et `computeNetWorthHistory()` appellent chacune `ctx()` une seule fois puis
l'utilisent — même principe que `computeInvestmentValueHistory`/`computeDebtHistory`, qui n'avaient
jamais eu ce problème.

Testé : les 24 assertions de `test/ledger.test.html` (§11) passent toujours après le refactor (le
comportement observable est strictement identique, seul le nombre de lectures DB change) ;
rechronométré sur le même jeu de données de 14 600 transactions → **1555ms → 473ms** (≈3,3x).

Piste plus large volontairement pas traitée ici (§7.7 mise à jour) : `ctx()` lui-même charge tout un
store en mémoire à chaque appel (`dbGetAll`, pas de requête IndexedDB bornée par date/index) — les
~300-500ms restants sur ce jeu de données synthétique viennent de là. Non touché : chantier plus
large (requêtes indexées par date, éventuellement un cache de session) disproportionné tant qu'aucun
utilisateur réel n'a signalé de lenteur perceptible.

`CACHE_VERSION` : `v46` → `v47`.

### 14 août 2026 (suite) — Vérification de fraîcheur cloud au démarrage (multi-appareils)

Proposé par l'auteur : avec plusieurs appareils partageant le même compte cloud, rien n'empêchait
un appareil resté sur une version ancienne de commencer à y saisir de nouvelles transactions sans
savoir qu'un autre appareil avait déjà avancé le cloud pendant ce temps — risque de doublons, ou de
données écrasées à la prochaine sauvegarde de l'appareil en retard. Question explicitement posée
par l'auteur et traitée avant l'implémentation : que se passe-t-il hors-ligne au démarrage ? Réponse
donnée puis honorée dans le code : l'app démarre normalement, la vérification échoue silencieusement
et sans bloquer si le réseau n'est pas là, comme le fait déjà `renderCloudBackupSection`.

→ `firebase-sync.js` : `checkCloudStaleness()`, appelée au boot (`app.js`, 2s après déverrouillage —
avant les rappels de sauvegarde, cette alerte étant plus urgente). Ne charge le SDK Firebase que
pour un utilisateur déjà connecté au cloud (`cloudBackupWasSignedIn`) — jamais par défaut. Compare
l'horodatage serveur de la dernière sauvegarde cloud (`updatedAt` du document `backups/{uid}`, une
seule petite lecture, pas les morceaux chiffrés) à `cloudLastKnownSyncAt` (nouveau réglage local, mis
à jour par `pushBackupToCloud()` ET `pullBackupFromCloud()` — contrairement à `lastCloudBackupAt` qui
ne compte que les envois, affiché tel quel en Paramètres). Si le cloud est plus récent, une modale
propose de restaurer maintenant (réutilise `promptPassphrase`/`confirmDialog`/`pullBackupFromCloud`,
mêmes briques que le bouton "Restaurer" existant) ou de continuer quand même.
Timeout défensif de 8s (variable `cancelled`, pas d'annulation réseau réelle mais empêche la modale
de surgir tardivement sur une connexion très lente) ; toute erreur (hors-ligne, service indisponible)
est avalée silencieusement — jamais de blocage ni de message d'erreur au démarrage.

Ne résout pas le cas où les deux appareils ont chacun des changements non synchronisés EN MÊME
TEMPS (vrai conflit bidirectionnel) — nécessiterait le moteur de résolution de conflits
délibérément évité dès la conception de la sauvegarde cloud (13 août). Couvre le cas courant :
un appareil simplement en retard, prévenu avant de commencer à diverger.

Testé : aucune requête réseau ni modale pour un utilisateur jamais connecté au cloud (règle du
chargement paresseux respectée) ; aucun plantage pour un utilisateur "connu connecté"
(`cloudBackupWasSignedIn`) mais sans session Firebase active réelle (retombe proprement sur "pas
d'utilisateur", ne montre rien) — le round-trip complet avec un vrai compte cloud (comparaison
réelle des horodatages, restauration déclenchée) reste à confirmer par l'auteur avec son compte
réel, comme pour le reste des fonctionnalités Firebase de cette session.

### 14 août 2026 (suite) — Détection de dépense inhabituelle

Proposé par l'auteur : signaler une dépense nettement plus élevée que l'habitude pour sa catégorie,
utile surtout pour rattraper une erreur de saisie (ex: 45 000 tapé au lieu de 4 500).

→ `ledger.js` : `checkUnusualExpense(categoryId, amount, walletId, excludeId)` — compare le montant
(converti en devise de base, une catégorie pouvant recevoir des dépenses de portefeuilles en devises
différentes) à la moyenne des dépenses passées de cette catégorie. Renvoie `null` si la catégorie a
moins de 3 dépenses passées (pas assez d'historique pour qu'une moyenne veuille dire quelque chose)
ou si le montant ne dépasse pas 2,5x cette moyenne. `excludeId` ignore la transaction elle-même lors
d'une modification. Appelée dans `transactions.js` après l'enregistrement d'une dépense (création ET
modification) ; purement informatif via un second toast empilé sur celui de confirmation
(`showToast` empile déjà, pas de conflit) — n'empêche jamais l'enregistrement. Pas branché sur le
chemin des transactions scindées (`splitMode`) : plusieurs lignes de petits montants dans des
catégories peu utilisées auraient pu déclencher plusieurs avertissements empilés pour une seule
action utilisateur — hors scope volontairement, pas demandé.

Testé : historique de 5 dépenses ~50€ (moyenne 50) → un montant proche (55€) ne déclenche rien, un
montant à 300€ (6x) déclenche l'avertissement avec la bonne moyenne/ratio, une catégorie neuve sans
historique ne déclenche jamais rien (garde-fou anti-faux-positifs respecté).

### 14 août 2026 (suite) — Mode démo pour l'onboarding

Proposé par l'auteur : permettre d'explorer l'app avec des données réalistes avant d'y entrer ses
propres finances.

→ Nouveau `js/demo-data.js` : `seedDemoData()` crée un jeu de données XOF cohérent sur ~2 mois
(3 portefeuilles — mobile money/banque/espèces —, ~19 transactions revenus/dépenses variées,
3 budgets du mois, un objectif d'épargne, un investissement avec historique de valorisation, une
créance) ; `clearDemoData()` efface tout et remet l'app dans l'état "jamais utilisée" (l'onboarding
se réaffichera au prochain démarrage). Piège rencontré : `seedDemoData()` appelle `wipeAllData()` en
premier, qui vide AUSSI `STORES.CATEGORIES` — impossible de compter sur les catégories par défaut
déjà créées par `seedDefaultsIfNeeded()` au premier boot (elles n'existent plus après le wipe), donc
`seedDemoData()` recrée elle-même le même jeu de catégories par défaut plutôt que d'en dépendre.

Bouton "Découvrir avec des données d'exemple" ajouté à la toute première étape de l'onboarding
(`app.js`) : ferme l'assistant entièrement (pas juste l'étape) plutôt que de l'enchaîner — créer SON
portefeuille/profil n'a plus de sens une fois des données fictives en place. Un bandeau permanent
(`#demo-mode-banner`, nouveau conteneur dans `index.html` juste sous la barre du haut, visible sur
toutes les vues) reste affiché tant que `isDemoModeActive` est vrai, avec un bouton pour tout effacer
et repartir de zéro — pour qu'il soit impossible de mélanger sans s'en rendre compte des données
fictives avec de vraies finances.

Testé : `seedDemoData()` crée bien 3 portefeuilles / 19 transactions / 9 catégories / 3 budgets / 1
objectif d'épargne / 1 investissement (2 valorisations) / 1 créance, aucune transaction avec
`categoryId` non résolu (bug initial corrigé — voir piège ci-dessus) ; `renderDashboard()` appelée
directement après le seed s'exécute sans erreur et affiche les vrais montants XOF calculés
(120 000 / 471 000 / 823 500 F CFA sur les cartes du tableau de bord) ; `clearDemoData()` remet bien
`isDemoModeActive`/`onboardingCompleted` à `false`. Le clic UI de bout en bout (bouton → bandeau →
effacer) n'a pas pu être rejoué au clavier virtuel dans cette session (le clavier PIN de l'app,
préalable obligatoire même en mode démo, s'est montré capricieux aux clics synthétiques du
navigateur de test) — vérifié à la place via les fonctions réelles directement, mêmes chemins de
code que ceux que l'UI appelle.

`CACHE_VERSION` : `v47` → `v48` (nouveau fichier `js/demo-data.js` ajouté à `APP_SHELL`).

### 15 août 2026 — Revue de sécurité + bugs sur les 3 fonctionnalités ci-dessus, avant push

Demandé par l'auteur avant de pousser : vérifier tout le diff en attente (les 3 fonctionnalités
ci-dessus) pour bugs, incohérences, failles de sécurité. Revue de sécurité (aucune faille trouvée —
l'app est 100% client-side, pas de surface d'injection classique ; le seul point réseau est
Firestore, déjà borné par les règles de sécurité existantes par `uid`) puis revue de correction
multi-angles (scan ligne à ligne, comportement supprimé, traçage inter-fichiers, réutilisation,
simplification, efficacité, altitude, conventions CLAUDE.md), avec vérification indépendante de
chaque piste retenue. **10 bugs/incohérences confirmés, tous corrigés avant push** :

1. **[Le plus grave] `seedDemoData()`/`clearDemoData()` effaçaient le PIN que l'utilisateur venait
   de créer.** `wipeAllData()` (`db.js`) vide `STORES.SETTINGS` sans le filtre `DEVICE_LOCAL_SETTING_KEYS`
   qu'`exportAllData()`/`importAllData()` appliquent pourtant scrupuleusement (voir §6, 13 août). Le
   bouton "Découvrir avec des données d'exemple" est sur la toute première étape de l'onboarding,
   juste après la création du PIN — un clic dessus effaçait `pinHash`/`pinSalt`/identifiants
   biométriques. Recharger la page réparait la situation (redétecte l'absence de PIN, repasse en
   mode création), mais verrouiller sans recharger ("Verrouiller maintenant" ou verrouillage
   automatique) enfermait l'utilisateur dans un écran de déverrouillage qu'aucun PIN ne pouvait
   jamais satisfaire (`verifyPin()` renvoie `false` dès que `pinSalt`/`pinHash` sont absents).
   → Nouvelle fonction `wipeUserData()` (`db.js`) : identique à `wipeAllData()` mais préserve les
   réglages propres à l'appareil (même `DEVICE_LOCAL_SETTING_KEYS`). `demo-data.js` l'utilise
   maintenant à la place de `wipeAllData()`. `wipeAllData()` elle-même reste inchangée et continue
   d'être le bon outil pour le vrai "Tout supprimer" de `settings.js` (réinitialisation complète
   explicitement voulue par l'utilisateur, PIN compris).
2. **Aucune confirmation avant ce wipe** (contrairement au "Tout supprimer" de `settings.js`, gardé
   par deux `confirmDialog(danger:true)`) — **pas de changement nécessaire une fois #1 corrigé** :
   le bouton n'apparaît que sur un premier lancement sans aucune donnée (garde `hasWallets` dans
   `maybeShowOnboarding()`), et le PIN est maintenant préservé — il n'y a plus rien à perdre.
3. **`checkCloudStaleness()` avertissait à tort tout utilisateur cloud mono-appareil déjà existant**,
   au premier démarrage suivant cette mise à jour : `cloudLastKnownSyncAt` (nouveau réglage) n'était
   jamais renseigné pour qui avait utilisé la sauvegarde cloud avant l'ajout de ce réglage,
   l'absence était traitée comme "en retard par défaut" (`localMs = 0`).
   → Absence de repère traitée comme "pas d'historique fiable" : établit silencieusement un repère
   sur l'état actuel du cloud sans alarmer, plutôt que de considérer par défaut que le cloud a
   avancé.
4. **La modale de fraîcheur cloud n'avait aucun répit** : "Continuer quand même" ne posait aucun
   réglage, donc la modale identique réapparaissait à chaque démarrage tant que le cloud ne bougeait
   pas.
   → Le clic avance `cloudLastKnownSyncAt` jusqu'à l'état du cloud déjà vu — la modale ne revient
   que si le cloud avance ENCORE après ce constat.
5. **Décalage d'horloge possible** : `pushBackupToCloud()` posait l'horodatage cloud via
   `serverTimestamp()` (horloge serveur) mais le repère local via `new Date().toISOString()`
   (horloge de l'appareil) pour le même instant — un appareil dont l'horloge retarde aurait pu voir
   son PROPRE push relu comme "plus récent que son propre repère" au prochain démarrage.
   → Relit le document juste après l'écriture pour récupérer l'horodatage réellement résolu côté
   serveur, comme le fait déjà `pullBackupFromCloud()` — horloge serveur comparée à horloge serveur,
   jamais mélangée à l'horloge locale.
6. **Aucune coordination entre la modale de fraîcheur (2s) et le rappel hebdomadaire cloud (6s)** :
   restaurer via la première ne mettait à jour ni `lastCloudBackupAt` ni `cloudBackupSnoozeCount`,
   donc le second pouvait se déclencher 4 secondes plus tard pour réclamer une sauvegarde juste
   après une restauration.
   → `pullBackupFromCloud()` pose maintenant un répit de 24h (`cloudBackupSnoozedUntil`) après toute
   restauration réussie — sans toucher `lastCloudBackupAt`, qui reste honnête sur la dernière fois
   qu'on a réellement *poussé* une sauvegarde (affiché tel quel en Paramètres).
7. **Liste de catégories par défaut dupliquée** entre `seedDefaultsIfNeeded()` (`app.js`) et
   `seedDemoData()` (`demo-data.js`) — risque de dérive silencieuse (une catégorie renommée d'un
   côté sans l'autre aurait reproduit le bug `categoryId: null` déjà rencontré une fois).
   → Extraite en `DEFAULT_CATEGORIES` (nouvelle constante exportée de `db.js`), utilisée par les
   deux.
8. **`checkUnusualExpense()` ignorait les taux de change non confirmés** (valeur 1:1 par défaut,
   documentée ailleurs comme "presque certainement fausse", voir §12 août) — pouvait produire un
   avertissement trompeur (déclenché à tort ou manqué) sur une catégorie mêlant des devises dont
   l'une a un taux jamais confirmé.
   → Renvoie `null` si une devise impliquée dans la comparaison a un taux non confirmé, plutôt que
   de comparer avec un taux probablement faux sans le signaler.
9. **`checkUnusualExpense()` appelait `ctx()`** (10 lectures IndexedDB) alors qu'elle n'utilise que
   4 des stores chargées — payé à *chaque* enregistrement de dépense (création ET modification), pas
   occasionnellement.
   → Chargement ciblé (`wallets`, `transactions`, `rates`, `baseCurrency` seulement) au lieu de
   `ctx()`.
10. **`investment.createdAt` (mode démo) construit via `daysAgo(58) + 'T00:00:00.000Z'`** — une
    date calendaire locale étiquetée comme minuit UTC, exactement le type de dérive que la
    convention §3 de ce fichier existe pour éviter (`localISODate()`/`todayISO()`, jamais
    `.toISOString()` bricolé sur une date locale). Latent (aucun consommateur actuel n'en souffrait
    réellement), mais aurait pu décaler la date d'un jour pour un futur code lisant ce champ avec
    `new Date(...)` dans un fuseau à l'ouest de l'UTC.
    → Nouvelle fonction `daysAgoTimestamp()` : construit un vrai `Date`, puis appelle `.toISOString()`
    dessus (usage correct de la fonction, qui produit un instant réel — contrairement à la
    concaténation de chaîne qu'elle remplace).

Bonus (pas un bug, une simplification en passant) : les ~30 `dbAdd()` séquentiels de
`seedDemoData()` remplacés par `dbBulkPut()` (une transaction par store au lieu d'une par ligne),
déjà utilisé ailleurs dans le codebase mais pas exploité par ce nouveau fichier.

Testé : les 24 assertions de `test/ledger.test.html` passent toujours après tous ces changements ;
`wipeUserData()` vérifié isolément (préserve `pinHash`/`pinSalt`/`biometricCredentialId`, efface le
reste) ; `seedDemoData()` rejoué avec un PIN factice préexistant → PIN intact après le seed, jeu de
données identique à avant (3/19/9/3/1/1/2/1, aucun `categoryId` non résolu) ;
`checkUnusualExpense()` avec un taux USD non confirmé → `null`, puis confirmé → avertissement
correct (moyenne 45, montant 270, ratio 6). Le round-trip complet de `checkCloudStaleness()`/
`pushBackupToCloud()` avec un vrai compte cloud reste à confirmer par l'auteur (limite déjà connue
de cette session pour tout ce qui touche Firebase).

`CACHE_VERSION` : `v48` → `v49`.

### 15 août 2026 (suite) — Revue de bugs étendue au reste de l'app (au-delà du diff du jour)

Demandé par l'auteur après la revue précédente (limitée au diff du jour) : "ya til des choses encore
à ce niveau" → étendre la chasse aux bugs aux fichiers les plus critiques jamais passés par une revue
multi-agents comme celle qui vient d'avoir lieu — `auth.js` (PIN/biométrie), `db.js` (couche de
données), `backup.js` (chiffrement/import/export/CSV), `ledger.js` (calculs financiers), `utils.js`
(helpers partagés par presque tout le reste de l'app). Un agent dédié par fichier, chacun lisant le
fichier en entier + ses appelants, sans filtrer par confiance (recall maximal). **9 bugs réels
corrigés** (détail technique ci-dessous), **10 autres identifiés et documentés en dette technique
§5** (voir tableau ci-dessus) pour arbitrage avec l'auteur plutôt que corrigés à l'aveugle — certains
nécessitent un vrai choix de conception (ex: heuristique de séparateur de milliers), d'autres sont
des correctifs plus risqués à appliquer sans plus de contexte (atomicité `importAllData`).

**Corrigés :**

1. **XSS via `currencySelectHtml()`** (`utils.js`) — le code devise sélectionné était interpolé sans
   `escapeHtml()` dans un attribut HTML. La saisie normale est bornée à 3 caractères
   (`readCurrencyValue`), mais un import CSV/JSON contourne cette contrainte entièrement
   (`findOrCreateWallet`, `backup.js`, stockait la colonne devise telle quelle). → `escapeHtml()`
   ajouté sur chaque valeur interpolée dans `currencySelectHtml()` ; `findOrCreateWallet` borne
   maintenant aussi la devise importée à 3 caractères majuscules (même contrainte que la saisie
   normale, défense en profondeur).
2. **`formatCurrency()` affichait des décimales pour XOF/XAF** — `maximumFractionDigits: 2` fixé pour
   toutes les devises sans distinction ; un montant non entier (conversion, partage entre
   participants) affichait `"1 234,5 F CFA"` au lieu de `"1 235 F CFA"`, la convention pour des
   devises sans sous-unité usuelle — direct pour le marché cible de l'app. → `ZERO_DECIMAL_CURRENCIES`
   (XOF, XAF, JPY) : `minimumFractionDigits`/`maximumFractionDigits` fixés à 0 pour ces devises.
3. **Export CSV : double échappement** — `exportTransactionsCsv` appelait `csvEscape` individuellement
   sur 4 colonnes PUIS sur la ligne entière via `.map(csvEscape)`. Un nom de catégorie contenant `;`
   ressortait entouré de guillemets quadruplés (`""""nom""""`), et se ré-important avec des guillemets
   littéraux au lieu du nom d'origine. → Un seul passage par `.map(csvEscape)`, les appels individuels
   retirés.
4. **`detectRecurringCandidates` n'excluait jamais les récurrences déjà déclarées** — comparait la
   note brute d'une transaction générée automatiquement (`"Récurrence : Loyer"`) au nom de la
   récurrence (`"loyer"`), qui ne correspondent jamais avec un `===`/`.has()` exact — la fonction
   re-proposait en permanence des récurrences déjà actives comme si elles ne l'étaient pas,
   contredisant directement son propre docstring ("Exclut ce qui correspond déjà à une récurrence
   active"). → Le préfixe `"récurrence : "` est retiré avant comparaison.
5. **`computeEnvelopeCarryover` incluait les mouvements de dette/créance** — seul agrégat mensuel du
   fichier sans le filtre `!t.debtId` que `computeMonthSummary`/`computeBudgetVsActual`/
   `computeCategoryActuals` appliquent tous. Un remboursement de dette catégorisé "Prêt"/"Créance"
   avec `envelopeMode` activé faisait diverger le report d'enveloppe de l'"actual" réellement affiché
   à l'écran pour ce même mois/catégorie. → Filtre `!t.debtId` ajouté, cohérent avec ses voisins.
6. **Course critique sur le compteur d'échecs PIN** (`auth.js`) — `verifyPin()` est un calcul PBKDF2
   de plusieurs dizaines/centaines de ms ; rien n'empêchait un second appel concurrent (backspace +
   nouveau chiffre pendant que le premier calcul tourne encore) de lire le même `failedAttempts`
   avant que l'un ou l'autre n'écrive sa mise à jour — l'incrément se perdait, sous-comptant les
   échecs réels et retardant le blocage anti-brute-force. → Verrou `verifying` (variable locale à
   `initLockScreen`) empêchant tout second appel à `verifyPin()`/`verifyBiometric()` tant qu'un
   premier est en cours.
7. **Déverrouillage biométrique ne levait jamais le blocage PIN** (`auth.js`) — un utilisateur
   throttlé après 5 échecs de PIN (`pinThrottledUntil` posé) qui se déverrouillait ensuite avec succès
   par empreinte restait bloqué au PIN dès le verrouillage suivant : seul le chemin PIN réinitialisait
   `pinThrottledUntil`/`failedAttempts`, jamais le chemin biométrique. → Le succès biométrique
   réinitialise maintenant les deux, au même titre qu'un PIN correct.
8. **Rappel de sauvegarde (local ET cloud) : le 3e report s'annulait lui-même** (`backup.js`,
   `firebase-sync.js`) — `snoozeCount >= BACKUP_SNOOZE_LIMIT` (3) faisait passer le rappel en mode
   "urgent" (sans bouton "Plus tard") dès que le compteur atteignait 3 — c'est-à-dire immédiatement
   après le clic "Plus tard" qui vient justement de poser un répit de 24h. Le répit n'avait donc
   jamais la moindre chance de s'écouler : le rappel réapparaissait en mode urgent au tout prochain
   démarrage. Bug copié à l'identique dans les deux fichiers (le rappel cloud a été construit sur le
   modèle du rappel local, voir §6 du 14 août). → `>` au lieu de `>=` dans les deux fichiers — "au-delà
   de 3 reports" (le docstring du code) laisse maintenant le 3e lui-même bénéficier de son répit.

Testé : les 24 assertions de `test/ledger.test.html` passent toujours ; `formatCurrency` vérifié pour
XOF/XAF (entier et non entier) et EUR (décimales inchangées) ; `currencySelectHtml` vérifié avec une
charge XSS explicite (`"><img src=x onerror=alert(1)>`) → correctement échappée ; `detectRecurringCandidates`
vérifié avec une récurrence "Loyer" ayant généré 2 transactions → n'apparaît plus dans les candidats ;
`computeEnvelopeCarryover` vérifié avec une transaction liée à une dette dans la catégorie testée →
exclue du calcul (report `-300` au lieu de `-350` sans le fix, cohérent avec le montant attendu).

Non re-testé en conditions réelles faute d'environnement adapté : le verrou `verifying` (nécessite de
déclencher une vraie course sur le clavier PIN de l'app, le clavier virtuel s'étant déjà montré
capricieux aux clics synthétiques cette session — voir §6 du 14 août) et la levée du blocage PIN par
biométrie (nécessite un appareil avec capteur biométrique réel). Les deux corrections sont ciblées et
de faible risque (ajout d'un verrou/reset, pas de changement de logique existante) ; à confirmer par
l'auteur en usage réel.

`CACHE_VERSION` : `v49` → `v50`.

### 15 août 2026 (suite) — Recherche globale : plafond silencieux + filtres avancés incomplets

Signalé par l'utilisateur : "la recherche ne fonctionne pas comme je veux." Presque tout ce qu'il
listait était déjà cherché (notes, tags, descriptions, portefeuilles, dettes/créances, comptes
gardés — voir `search.js` déjà en place depuis le §6 du 13 août), donc le vrai problème n'était pas
"quoi" chercher mais deux limites concrètes non documentées :

1. **`collectSearchIndex()` plafonnait à 500 transactions** (`getEnrichedTransactions({ limit: 500 })`)
   — au-delà, les transactions les plus anciennes (et leurs notes) devenaient introuvables sans
   aucun signal à l'utilisateur. Silencieux et facile à atteindre pour un usage de plusieurs années
   (voir le jeu de test de 14 600 transactions déjà utilisé cette session, CLAUDE.md §6, 14 août).
   → Retiré (`getEnrichedTransactions()` sans limite). Coût mesuré : un seul chargement à l'ouverture
   de la modale de recherche, pas un chemin chaud — acceptable même à grande échelle.
2. **Aucun filtre par portefeuille, catégorie ou type**, alors que "montant/dates" existaient déjà
   (§6, 13 août) — c'est précisément ce que l'auteur demandait explicitement en plus.
   → Trois `<select>` ajoutés à la barre de filtres avancés (`#search-filter-wallet`,
   `#search-filter-category`, `#search-filter-type`), peuplés depuis `STORES.WALLETS`/
   `STORES.CATEGORIES` à l'ouverture de la modale, même logique "ne s'applique qu'aux transactions"
   que les filtres montant/date existants. Les éléments d'index transaction portent maintenant
   `walletId`/`categoryId`/`txType` (pas seulement leurs noms dans le texte cherché) pour permettre
   ce filtrage exact.

Testé : jeu de données de 520 transactions (dont une note unique à la position 520, au-delà de
l'ancien plafond de 500) → trouvée après le retrait de la limite ; filtre type=transfer sur une
recherche large → ne garde que le virement ; filtre portefeuille croisé avec le même virement →
disparaît/réapparaît selon le bon/mauvais portefeuille ; filtre catégorie testé de la même façon.
Les 24 assertions de `test/ledger.test.html` passent toujours (non concerné, mais vérifié par
habitude après tout changement touchant `ledger.js`/`db.js` indirectement via les imports partagés).

`CACHE_VERSION` : `v50` → `v51`.

### 15 août 2026 (suite) — Le message d'accueil disait toujours "Bonjour", même le soir

Signalé par l'utilisateur (capture d'écran, tableau de bord consulté en soirée). `renderDashboard()`
(`dashboard.js`) écrivait `Bonjour, ${prénom}` en dur, sans jamais regarder l'heure.

→ Nouvelle fonction `greetingWord()` : "Bonjour" de 5h à 18h, "Bonsoir" de 18h à 5h (convention
française usuelle), basée sur l'heure locale de l'appareil (`new Date().getHours()`, jamais UTC —
un salut affiché au mauvais moment de la journée n'aurait aucun sens).

Testé : à l'heure réelle actuelle (17h) → "Bonjour" (correct, sous le seuil) ; bornes vérifiées pour
0h/4h/5h/6h/9h/12h/17h/18h/19h/22h/23h → bascule exactement à 5h et 18h comme prévu. Les 24
assertions de `test/ledger.test.html` passent toujours (non concerné, vérifié par habitude).

`CACHE_VERSION` : `v51` → `v52`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 1/N : infrastructure + châssis + tableau de bord)

Demandé par l'auteur : rendre l'app bilingue français/anglais. Chantier accepté **par étapes,
écran par écran, sur plusieurs sessions** (décision explicite de l'auteur face à l'ampleur — ~8600
lignes de JS avec le français en dur partout, pas un système de traduction centralisé à activer).
Ce lot pose l'infrastructure et convertit le châssis de l'app + le tableau de bord ; le reste des
écrans (Transactions, Budgets, Épargne, Investissements, Dettes, Outils, Rapports, Partage, Comptes
gardés, Paramètres hors sélecteur de langue) **reste en français pour l'instant** — pas un bug, un
chantier pas encore fait à ces endroits (voir "État d'avancement" ci-dessous).

**Conception (`js/i18n.js`, nouveau fichier)** :
- Pas de framework i18n, pas de clés artificielles à inventer/maintenir : **la clé de traduction EST
  le texte français lui-même**. `t(fr)` (aliasé `tr` dans les fichiers qui utilisent déjà `t` comme
  nom de variable, voir piège ci-dessous) renvoie la traduction anglaise si la langue courante est
  `'en'` ET qu'une entrée existe dans le dictionnaire `EN`, sinon renvoie le français tel quel. Une
  chaîne pas encore ajoutée au dictionnaire ne casse jamais rien — elle reste juste en français, ce
  qui est exactement le comportement voulu pour un chantier "par étapes".
- Substitution de variables façon gabarit (`{clé}` dans la chaîne, ex: `t('Budget "{label}" à {pct}%
  de la limite', { label, pct })`) plutôt que concaténer des fragments traduits séparément : le
  français et l'anglais n'ordonnent pas toujours leurs mots pareil, un gabarit entier par langue est
  la seule façon de le garantir en général (même si dans les cas traités ici l'ordre coïncidait).
- Deux mécanismes de traduction :
  - JS dynamique (contenu construit dans les modules) : envelopper chaque chaîne dans `t('...')`.
  - HTML statique (`index.html` : menu, barre du haut, écran de verrouillage, tableau de bord) :
    attributs `data-i18n="texte français"` (contenu texte), `data-i18n-aria-label`/`data-i18n-title`/
    `data-i18n-placeholder` (attributs) — appliqués par `applyStaticTranslations()`.
- **Changer de langue recharge la page** (`setLanguage()`) plutôt que de rendre chaque écran
  réactif à la volée : chaque vue reconstruit déjà tout son HTML depuis zéro à chaque rendu, un
  rechargement complet garantit une traduction cohérente partout d'un coup pour un gain de réactivité
  quasi nul (changer de langue est rare). `initI18n()` s'exécute tout au début du boot (`app.js`,
  avant même `seedDefaultsIfNeeded()`) pour traduire le châssis statique avant le premier rendu —
  évite un flash de français pour un utilisateur en anglais.
- **Formatage des nombres/dates rendu dépendant de la langue, pas seulement les libellés** :
  `formatCurrency()`/`formatDate()`/`formatMonthLabel()` (`utils.js`) utilisaient `Intl` figé sur
  `'fr-FR'` — un montant en mode anglais se serait quand même affiché `"300,00 €"` (virgule
  décimale) au lieu de `"€300.00"`. Passés à une locale dépendante de `getLanguage()`
  (`'en-US'`/`'fr-FR'`), avec le cache de formatters de devise reclé par locale+devise (pas
  seulement devise) pour ne jamais mélanger un formatter français et un formatter anglais. `utils.js`
  importe `getLanguage` depuis `i18n.js`, qui n'importe rien de `utils.js` en retour — pas de cycle.

**Piège rencontré** : `dashboard.js` utilise déjà `t` comme nom de paramètre pour une transaction
(`function txRowHtml(t) {...}`). Importer la fonction de traduction sous le même nom l'aurait
silencieusement masquée à l'intérieur de cette fonction précise — `t('Sans catégorie')` aurait
tenté d'appeler la transaction comme une fonction (`TypeError` immédiat au premier rendu avec des
transactions). Import aliasé `import { t as tr } from '../i18n.js';` dans ce fichier ; à vérifier
au cas par cas dans les prochains fichiers convertis (`grep` le nom `t` utilisé comme variable
avant d'importer tel quel).

**Sélecteur de langue** : nouvelle section dans Paramètres (`renderLanguageSection`, `settings.js`),
entre "Fonctionnalités optionnelles" et "Devise de base" — un simple `<select>` FR/EN, prévient déjà
que certains écrans resteront en français le temps du reste du chantier.

**État d'avancement** (à tenir à jour à chaque lot suivant) :
- ✅ Infrastructure (`i18n.js`), châssis de l'app (menu, barre du haut, bas de page mobile, écran de
  verrouillage), tableau de bord complet, formatage devises/dates/mois.
- ✅ Transactions (lot 2, voir entrée du 15 août 2026 ci-dessous) : modale Saisie express (y compris
  mode scindé, scan de justificatif), rapprochement bancaire, liste + filtres, sélection multiple.
- ✅ Budgets (lot 3, voir entrée ci-dessous) : les 5 onglets (Budgets du mois, Budgets annuels,
  Catégories, Récurrences, Règles) et leurs modales.
- ✅ Épargne (lot 4, voir entrée ci-dessous) : objectifs, contributions, archivage.
- ✅ Investissements (lot 5, voir entrée ci-dessous) : cartes, historique, comparatif de rendement.
- ✅ Dettes & créances (lot 6, voir entrée ci-dessous) : cartes, formulaires, simulateur
  Avalanche/Boule de neige.
- ✅ Outils (lot 7, voir entrée ci-dessous) : les 8 outils stratégiques.
- ✅ Rapports (lot 8, voir entrée ci-dessous) : bilans PDF (mensuel + annuel), export CSV, score de
  santé financière, calendrier des dépenses.
- ✅ Partage de dépenses (lot 9, voir entrée ci-dessous) : participants, dépenses partagées, soldes.
- ✅ Comptes gardés (lot 10, voir entrée ci-dessous) : comptes, mouvements, archivage.
- ✅ Paramètres (lot 11, voir entrée ci-dessous) : profil, sécurité, notifications, installation,
  mise à jour, tableau de bord, fonctionnalités optionnelles, devise de base, sauvegarde/restauration
  (hors sauvegarde cloud, voir `firebase-sync.js` — pas encore traduit, section distincte).
- ✅ Sauvegarde cloud (lot 12, voir entrée ci-dessous) : `firebase-sync.js` complet (connexion,
  push/pull, rappels, vérification de fraîcheur).
- ✅ Recherche globale (lot 13, voir entrée ci-dessous) : `search.js` complet (index, filtres
  avancés, résultats).
- ✅ Mode démo et assistant de configuration (lot 14, voir entrée ci-dessous) : bandeau, contenu du
  jeu de données de démonstration, assistant d'onboarding complet (7 étapes).

**⚠️ Le lot 14 avait été annoncé à tort comme la fin du chantier.** L'auteur a demandé une
vérification directe ("tu es sûr que l'app est totalement bilingue jusque là?") — un audit
systématique (recherche de `import.*i18n` manquant + recherche de chaînes accentuées hors
commentaires) a révélé plusieurs trous réels, corrigés dans les lots 15-18 ci-dessous :
- **`wallets.js` (écran Portefeuilles) n'avait jamais été touché** — absent de la checklist depuis le
  début du chantier, alors que c'est un des écrans les plus utilisés de l'app. Corrigé au lot 15.
- `notifications.js` (notifications système OS), `backup.js` (erreurs d'import/export), le
  `cancelText` par défaut de `confirmDialog()` (`utils.js` — affectait TOUTES les boîtes de
  confirmation de l'app), et deux labels de graphiques (`ledger.js`, `charts.js`) — corrigés aux
  lots 16-18.

Cette mésaventure est documentée ici volontairement : la bonne méthode pour vérifier qu'un chantier
de traduction est complet n'est pas de se fier à une checklist construite au fil de l'eau (celle du
lot 1, écrite de mémoire en listant les éléments du menu, avait simplement omis Portefeuilles), mais
de lister tous les fichiers du projet et vérifier lesquels importent (ou devraient importer)
`i18n.js` — c'est exactement l'audit (`grep` sur chaque fichier `js/**/*.js`) qui a débusqué
`wallets.js` ainsi que les autres trous listés ci-dessus, en quelques minutes.

Testé : bascule FR→EN puis EN→FR (aller-retour complet) — menu latéral, titre de la barre du haut,
navigation mobile, écran de verrouillage (titre/sous-titre/aria-labels) et tableau de bord entier
(salutation, alertes de budget dépassé, tendances, montants, dates) vérifiés traduits correctement
dans les deux sens ; formatage confirmé : `"300,00 €"`/`"05 août 2026"` en français devient
`"€300.00"`/`"Aug 05, 2026"` en anglais pour les mêmes données. Sélecteur de langue dans Paramètres
rendu et vérifié (options FR/EN, la bonne présélectionnée). Les 24 assertions de
`test/ledger.test.html` passent toujours.

`CACHE_VERSION` : `v52` → `v53` (nouveau fichier `js/i18n.js` ajouté à `APP_SHELL`).

**Deux clarifications tranchées avec l'auteur avant ce lot** (question posée, réponse explicite) :
- « Comptes gardés » → traduit **« Managed accounts »** (pas de traduction littérale plus
  maladroite envisagée un temps).
- Les catégories par défaut doivent-elles se créer en anglais pour une toute nouvelle installation
  déjà en anglais ? → **Oui, uniquement à la création, jamais rétroactivement** pour une catégorie
  déjà existante (confirme le choix déjà fait par construction dans `t(c.name)` à l'insertion).

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 2/N : Transactions)

Suite du chantier « par étapes, écran par écran » (l'auteur a explicitement demandé de continuer la
traduction avant de pousser le lot 1, avec invitation à poser des questions de clarification en cours
de route). Écran converti cette fois : **Transactions**, dans son ensemble — modale Saisie express
(y compris mode scindé et scan de justificatif), rapprochement bancaire, liste filtrée, sélection
multiple, journal d'audit associé.

**Piège `t`/variable déjà connu, reproduit à l'identique** (voir lot 1) : `transactions.js` utilise
`t` comme nom de paramètre pour une transaction dans plusieurs fonctions (`txRowHtml(t)`,
`reconTxRowHtml(t, currency)`, une `const t` locale dans le handler de clic de
`initTransactionsModule`). Vérifié par `grep` avant d'écrire l'import, import aliasé directement
`import { t as tr, applyStaticTranslations } from '../i18n.js';` — pas eu besoin de repasser derrière
cette fois (contrairement au lot 1 sur `dashboard.js`, où l'erreur avait été commise puis corrigée).

**`<template>` et traduction statique** : `tpl-modal-quick-add` (`index.html`) a reçu ses attributs
`data-i18n`/`data-i18n-aria-label`/`data-i18n-placeholder` comme n'importe quel HTML statique — mais
le contenu d'un `<template>` n'existe pas dans le `document` avant clonage, donc le passage unique
d'`applyStaticTranslations()` au boot ne les touche jamais. `openQuickAdd()` (déjà correct depuis
avant ce lot) rappelle `applyStaticTranslations()` juste après avoir inséré le clone dans le DOM.

**Nouveau : `data-i18n-alt`** — le justificatif photo prévisualisé (`<img id="qa-receipt-preview-img"
alt="...">`) est le premier cas de texte statique traduisible porté par un attribut `alt`, que les
trois mécanismes existants (`data-i18n`, `-aria-label`, `-title`, `-placeholder`) ne couvraient pas.
Ajouté `data-i18n-alt` à `applyStaticTranslations()` (`i18n.js`), même principe que les autres.

**Décision de traduction notable : le mot « Annuler » sert à deux rôles distincts dans l'app** — le
bouton Annuler par défaut de `confirmDialog()` (`utils.js`, pas encore traduit à ce stade du chantier)
ET le libellé d'action « annuler » sur les toasts de restauration après suppression (ce fichier, et au
moins `kept-accounts.js`/`debts.js` à convertir plus tard). Comme la clé de traduction est le texte
français lui-même, les deux usages partagent inévitablement la même entrée de dictionnaire. Choix fait
ici : `'Annuler': 'Undo'` (le rôle activement câblé dans ce lot). **Piège posé pour la suite** : si
`confirmDialog()` est traduit un jour, ne PAS le faire passer par cette même clé `'Annuler'` (il lui
faudrait `'Cancel'`) — prévoir un mécanisme séparé pour son `cancelText` par défaut. Commentaire laissé
en place dans `i18n.js` à côté de l'entrée pour ne pas se faire piéger.

**Notes d'audit traduites à la création, comme les catégories par défaut** — les chaînes passées à
`logAudit({..., note: ...})` dans ce fichier (« Transaction scindée », « Catégorisation groupée »,
« Pointée (groupé) », etc.) sont lues et affichées telles quelles par l'écran Outils > Journal d'audit
(`tools.js`, pas encore converti). Enveloppées dans `tr(...)` au même titre que le reste : une note
créée en anglais reste en anglais dans le journal même après un retour au français, exactement le même
principe que les catégories par défaut (traduction au moment de l'écriture, jamais de ré-traduction
rétroactive d'une donnée déjà en base).

**Nouvelles entrées de dictionnaire** : ~95 nouvelles clés (`i18n.js`), section « Transactions »
— vérifié par script qu'aucune ne duplique une clé existante (`js/i18n.js`, dictionnaire à plat,
188 clés au total après ce lot).

Testé dans le navigateur, bascule FR→EN→FR complète : modale Saisie express (labels, segmented
Dépense/Recette/Transfert, mode scindé, placeholders, bouton Enregistrer), rapprochement bancaire
(formulaire, résultat calculé avec écart réel, liste de transactions non pointées, action « Pointer »),
liste + filtres (mois au format anglais « August 2026 », sélecteurs, état vide), sélection multiple
(barre d'actions, modale de recatégorisation groupée, suppression groupée avec confirmation + toast
« Undo »), et le journal d'audit (`STORES.AUDIT_LOG` lu directement) confirmant que les notes créées en
anglais (« Bulk deletion », « Reconciled (assisted reconciliation)) y restent affichées telles quelles.
Retour en français vérifié à la fois par re-vérouillage (écran de PIN redevenu « Déverrouiller
GeoFinance ») et par rendu direct des fonctions du module (`renderTransactions()`, `openQuickAdd()`) :
tout le texte français d'origine, y compris le formatage de date (« Août 2026 »), identique à avant le
chantier — aucune régression sur le chemin non traduit.

`CACHE_VERSION` : `v53` → `v54`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 3/N : Budgets)

Suite du chantier (l'auteur a explicitement demandé de continuer sans s'arrêter pour pousser :
« non je veux qu'on continues la traduction. je veux faire le push une fois le translate fini pour
tous les modules »). Écran converti : **Budgets**, dans son ensemble — les 5 onglets (Budgets du
mois, Budgets annuels, Catégories, Récurrences, Règles de catégorisation automatique) et leurs
modales (formulaire de catégorie avec sélecteur d'icône/couleur/mode enveloppe, formulaire de
récurrence). Aucun `t`/variable en collision dans ce fichier (vérifié par `grep` avant d'importer) —
import direct `import { t } from '../i18n.js';`, pas d'alias nécessaire cette fois.

**Bug latent trouvé et corrigé en cours de route, avant qu'il ne devienne réel** : la note posée sur
chaque transaction générée automatiquement par une récurrence (`generateDueRecurring()`, budgets.js)
suit le gabarit `"Récurrence : {nom}"`. `detectRecurringCandidates()` (`ledger.js`, corrigée le 15
août plus tôt cette session — voir le bug #4 de la revue étendue) compare ce préfixe **en dur** pour
exclure ces transactions de ses suggestions. Traduire naïvement cette note via `t()` aurait produit
`"Recurrence: {nom}"` en mode anglais — un préfixe que `ledger.js` n'aurait plus reconnu, réintroduisant
exactement le bug déjà corrigé une fois (les récurrences déjà déclarées auraient été re-proposées en
boucle comme si elles ne l'étaient pas, mais seulement pour les utilisateurs en anglais, un régression
silencieuse et difficile à repérer). → `RECURRING_NOTE_PREFIX` (`ledger.js`) devient
`RECURRING_NOTE_PREFIXES` (tableau des deux variantes FR/EN), les deux vérifiées à la lecture — une
note existante ne se retraduit jamais rétroactivement, donc les deux formes doivent rester reconnues
indéfiniment, pas seulement pendant une période de transition.

**Nouvelles entrées de dictionnaire** : ~85 nouvelles clés (section « Budgets »), 0 doublon (vérifié
par script, 264 clés au total après ce lot). `+ Catégorie de budget` (en-tête `index.html`) inclus.

Testé dans le navigateur, bascule FR→EN→FR complète (rendu direct des fonctions du module, le clavier
PIN restant peu fiable aux clics synthétiques — même limite que les lots précédents) : les 5 onglets
et leurs libellés (dont l'entité `&amp;` de « Recurring expenses &amp; income », vérifiée décodée
correctement en `&` à l'affichage), le formulaire Nouvelle catégorie (nom/icône/couleur/mode
enveloppe/type/catégorie parente), le formulaire Nouvelle récurrence, et surtout **le point sensible
du lot** : une récurrence créée en anglais génère bien une transaction notée « Recurrence: {nom} »,
ET `detectRecurringCandidates()` l'exclut correctement de ses suggestions (vérifié explicitement,
avant et après le fix de `ledger.js` — reproduisait le problème puis confirmé résolu). Catégories par
défaut affichées en anglais (`Housing`, `Food`...) confirmant une fois de plus que la traduction à la
création (lot 1) reste cohérente ici aussi.

`CACHE_VERSION` : `v54` → `v55`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 4/N : Épargne)

Écran converti : **Épargne** (`savings.js`) — cartes d'objectif avec jauge circulaire, formulaire
objectif (création/édition), modale de contribution, archivage/désarchivage, suppression. Petit
module (157 lignes), aucun piège `t`/variable, converti en un seul passage. Confirmation de
suppression (`confirmDialog`) vérifiée : message et bouton "Delete" traduits, bouton "Annuler" par
défaut de `confirmDialog()` toujours en français comme prévu (`utils.js` pas encore converti — même
limite déjà notée aux lots précédents).

~30 nouvelles entrées de dictionnaire, 0 doublon (290 clés au total).

Testé FR→EN→FR : cartes d'objectif (jauge, échéance formatée en anglais « Jan 01, 2027 »), modale
Nouvel objectif d'épargne (tous les champs, le sélecteur de devise partagé restant en français comme
attendu), modale de contribution (titre interpolé avec le nom de l'objectif), confirmation +
suppression réelle testée de bout en bout (toast "Goal deleted." confirmé), retour en français vérifié
sans régression.

`CACHE_VERSION` : `v55` → `v56`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 5/N : Investissements)

Écran converti : **Investissements** (`investments.js`) — cartes (capital net, valeur actuelle,
dividendes, ROI, rendement annualisé), formulaire investissement, modale historique
(apports/retraits/dividendes/valorisations), comparatif de rendement par classe d'actif, filtre
Tous/Actifs financiers/Biens physiques. `ASSET_CLASSES`/`ENTRY_TYPE_LABELS` : les **clés** de ces
deux objets sont des valeurs stockées en base (`inv.assetClass`, `entry.type`), jamais traduites —
seules leurs **valeurs** (libellés affichés) passent par `t(...)`, à l'usage, jamais à la déclaration
de l'objet (même distinction que `DEFAULT_CATEGORIES`/`FREQ_LABELS` des lots précédents).

**Oubli du lot 1 corrigé au passage** : `renderNetWorthTrendChart()` (`charts.js`) prend un libellé de
jeu de données Chart.js (visible en infobulle) avec un défaut `'Valeur nette'` codé en dur — jamais
traduit, y compris depuis `dashboard.js` (déjà converti au lot 1). Le tableau de bord passait par ce
défaut sans jamais le surcharger. → `dashboard.js` passe maintenant explicitement `tr('Valeur nette')`
au lieu de compter sur le défaut de `charts.js` (qui reste en français par défaut — `charts.js`
lui-même n'est pas encore dans le périmètre du chantier, mais chaque appelant peut déjà passer un
libellé traduit).

~50 nouvelles entrées de dictionnaire, 0 doublon (335 clés au total).

Testé FR→EN→FR : cartes d'investissement (classe d'actif traduite en badge, ex. "Stocks", montants),
modale Nouvel investissement (toutes les classes d'actif), modale Historique (titre interpolé avec le
nom de l'investissement, types d'entrée traduits dans la liste et le formulaire), tableau de
comparatif de rendement, filtres, aucune erreur console.

`CACHE_VERSION` : `v56` → `v57`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 6/N : Dettes & créances)

Écran converti : **Dettes & créances** (`debts.js`) — cartes, formulaire dette/créance (avec le
mouvement de portefeuille optionnel à la création), modale de remboursement, simulateur stratégique
Avalanche/Boule de neige, historique du désendettement. Piège `t`/variable reproduit à l'identique
(voir lots précédents) : `t` utilisé comme nom de variable pour une transaction dans le handler de
suppression de `initDebtsModule()` — import aliasé `tr` dès le départ.

**Bug potentiel identifié et corrigé avant qu'il ne se produise, le plus important de ce lot** :
`ensureDebtCategoryId()` retrouve-ou-crée la catégorie "Prêt"/"Créance" réservée aux mouvements de
dette (voir §6, 13 août — ces catégories existaient déjà avant l'i18n) par **égalité exacte de nom**.
Traduire naïvement le nom passé à la création (`t('Prêt')` = `'Loan'` en anglais) aurait cassé cette
recherche : un utilisateur ayant déjà une catégorie "Prêt" (créée en français) qui passe l'app en
anglais et enregistre une nouvelle dette se serait retrouvé avec une **catégorie "Loan" dupliquée**
créée à côté de son "Prêt" existant, au lieu de le réutiliser — fragmentant silencieusement ses
dettes entre deux catégories selon la langue active à chaque création. Exactement le même type de
piège que `RECURRING_NOTE_PREFIX` (lot 3), mais sur une clé de recherche par nom plutôt qu'un préfixe.
→ `DEBT_CATEGORY_NAME_VARIANTS` (nouveau, `debts.js`) : toutes les traductions connues (FR + EN) des
deux noms canoniques, vérifiées à la recherche ; seule la création choisit la traduction courante via
`tr(...)`. Vérifié explicitement par test : une catégorie "Prêt" injectée avant le passage en anglais
est bien retrouvée par `ensureDebtCategoryId('debt', 'income')` en mode anglais (aucune catégorie
"Loan" dupliquée créée).

~55 nouvelles entrées de dictionnaire, 1 doublon détecté et corrigé (`'Créer'`, déjà présent depuis le
lot Budgets — réutilisé au lieu d'être redéclaré), 384 clés au total après ce lot.

Testé FR→EN→FR : cartes (badge Dette/Créance, montants, échéance), formulaire Nouvelle dette/créance
(bascule Dette/Créance, case "argent bouge aujourd'hui", sélection de portefeuille), modale de
remboursement, simulateur (résultat normal avec ordre de remboursement traduit y compris le "(month
{n})" imbriqué, et message d'alerte quand le budget mensuel ne couvre pas les intérêts), et surtout le
test explicite de non-régression sur `ensureDebtCategoryId` décrit ci-dessus. Aucune erreur console.

`CACHE_VERSION` : `v57` → `v58`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 7/N : Outils)

Écran converti : **Outils** (`tools.js`) — les 8 outils stratégiques (simulateur de trajectoire
patrimoniale, calculateur d'inflation, fonds d'urgence, impact d'un achat important, enveloppes
50/30/20, abonnements non déclarés, détection d'anomalies, journal d'audit). Piège `t`/variable
reproduit à l'identique : `t` utilisé comme nom de variable pour un outil (`{html, wire}`) dans
`renderTools()` et pour une transaction dans `renderAnomalyTool()` — import aliasé `tr` dès le début.
`ACTION_LABELS`/`ENTRY_TYPE_LABELS`-style : mêmes conventions que les lots précédents (clés
non traduites, valeurs traduites à l'usage).

**Oubli distinct trouvé et corrigé au passage** : `formatDateTime()` (journal d'audit) appelait
`new Intl.DateTimeFormat('fr-FR', ...)` en dur — jamais passé par `getLanguage()`, contrairement à
`formatDate()`/`formatCurrency()`/`formatMonthLabel()` (`utils.js`, déjà corrigés au lot 1). Les
horodatages du journal d'audit restaient donc au format français même en mode anglais.
→ `intlLocale()` (`utils.js`) — jusqu'ici une fonction privée non exportée — est maintenant exportée
et réutilisée ici plutôt que de dupliquer sa logique. Vérifié : horodatage affiché en `8/15/26, 10:22
PM` (anglais) puis `15/08/2026 22:22` (français) pour la même entrée, aller-retour correct.

~65 nouvelles entrées de dictionnaire, 0 doublon (447 clés au total).

Testé FR→EN→FR : les 8 panneaux (titres, labels, résultats calculés en direct pour chacun — dont le
mode crédit du simulateur d'achat avec taux d'intérêt non nul, vérifiant l'interpolation imbriquée
« (including {amount} in interest) »), le journal d'audit (libellés d'action + horodatages
bilingues), aucune erreur console.

`CACHE_VERSION` : `v58` → `v59`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 8/N : Rapports)

Écran converti : **Rapports** (`reports.js` + `reports-extras.js`) — bilan PDF mensuel et annuel
(génération jsPDF), export CSV, score de santé financière, calendrier des dépenses (heatmap). Piège
`t`/variable reproduit à l'identique dans `reports-extras.js` (`wireCalendarPanel` utilise `t` comme
nom de transaction) — import aliasé `tr` dès le départ ; `reports.js` lui-même n'a aucune collision
(import direct `t`).

**Décision de ce lot, différente des précédents : le contenu généré du PDF est traduit aussi**, pas
seulement l'écran qui le déclenche — cohérent avec l'objectif « toute l'app bilingue » de l'auteur.
Chaque `doc.text(...)` passe maintenant par `t(...)`, y compris les titres de section, les libellés
de synthèse et le texte des états vides.

**Piège distinct rencontré, propre à ce fichier** : `WEEKDAY_LABELS` (initiales des jours de la
semaine dans le calendrier) était un tableau à une seule lettre par jour (`['L','M','M','J','V','S',
'D']`) — le français a deux "M" (Mardi/Mercredi) à des positions différentes. Un simple `t('M')` par
lettre n'aurait pas pu distinguer ces deux usages ni produire les bonnes initiales anglaises
(`M,T,W,T,F,S,S`, qui a son propre doublon de "T" à des positions différentes). → Deux tableaux
complets (`WEEKDAY_LABELS_FR`/`WEEKDAY_LABELS_EN`), sélectionnés via `getLanguage()` plutôt que
traduits lettre par lettre.

**Deux oublis trouvés et corrigés pendant les tests de ce lot, avant le commit** (le titre du panneau
"Score de santé financière" et la ponctuation "{date} : {montant}" de l'infobulle du calendrier
restaient en français en mode anglais — clés manquantes au premier passage) : preuve que le test
bidirectionnel systématique après chaque lot vaut la peine, pas juste une formalité.

~50 nouvelles entrées de dictionnaire, 2 doublons détectés et corrigés (`'Dépenses par catégorie'`,
`'Budget vs réel'`, déjà présents depuis le lot Tableau de bord — réutilisés), 492 clés au total.

Testé FR→EN→FR : les deux panneaux de bilan (labels, boutons), score de santé financière (jauge +
3 indicateurs), calendrier (initiales de semaine, infobulles, détail d'un jour cliqué avec une
transaction injectée), export CSV (toast), et les chaînes exactes injectées dans le PDF vérifiées
directement via `t(...)` (titre, période, résumé, patrimoine net, bilan annuel, détail mensuel) —
aucune erreur console à aucune étape.

`CACHE_VERSION` : `v59` → `v60`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 9/N : Partage de dépenses)

Écran converti : **Partage de dépenses** (`shared.js`) — participants (dont le marquage "Moi"),
dépenses partagées avec répartition à parts égales, soldes nets par devise, part personnelle
automatique dans les transactions quand "Moi" fait partie du partage. Aucune collision `t`/variable
dans ce fichier (vérifié par `grep`) — import direct.

~40 nouvelles entrées de dictionnaire, 0 doublon (526 clés au total).

Testé FR→EN→FR de bout en bout avec un scénario réaliste : deux participants créés (Bob, Alice),
Alice marquée "Moi" (badge traduit), modale Nouvelle dépense partagée (tous les champs, y compris les
sections conditionnelles "ma part"), dépense enregistrée avec toast, panneau Soldes recalculé et
affiché ("Settled up" pour les deux participants — résultat mathématiquement correct pour le scénario
testé), ligne de dépense partagée avec le gabarit "Paid by {payer} · {date} · Split among {names}",
nettoyage des données de test puis retour en français vérifié identique à l'original. Aucune erreur
console.

`CACHE_VERSION` : `v60` → `v61`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 10/N : Comptes gardés)

Écran converti : **Comptes gardés** (`kept-accounts.js`) — comptes (avec solde initial et devise),
mouvements (entrées/sorties), archivage, suppression avec restauration. Aucune collision `t`/variable
(vérifié par `grep`) — import direct. Module optionnel (activable dans Paramètres,
`keptAccountsEnabled`) : testé directement via les fonctions du module (même limite déjà notée aux
lots précédents pour tout ce qui nécessite de naviguer via le clavier PIN), la visibilité du bouton de
nav lui-même n'étant pas concernée par ce chantier de traduction.

~28 nouvelles entrées de dictionnaire, 0 doublon (553 clés au total).

Testé FR→EN→FR de bout en bout : création d'un compte (via injection directe, formulaire vérifié
séparément), carte de compte (devise + badge "archived"), modale de détail avec ajout d'un mouvement
("In"/"Out", montant, note), archivage, confirmation de suppression + suppression réelle avec toast
"Undo", nettoyage des données de test, retour en français vérifié (état vide correctement affiché).
Aucune erreur console.

`CACHE_VERSION` : `v61` → `v62`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 11/N : Paramètres)

Écran converti : **Paramètres** (`settings.js`, 643 lignes — le plus gros fichier converti jusqu'ici),
hors sauvegarde cloud (`firebase-sync.js`, fichier distinct, prévu en lot séparé juste après). Onze
sections : profil, sécurité (PIN + biométrie + verrouillage auto), notifications, installation PWA,
mise à jour, configuration du tableau de bord, fonctionnalités optionnelles, langue (déjà fait au lot
1, non retouché), devise de base, sauvegarde/restauration (JSON/JSON chiffré/CSV + import générique
avec mapping de colonnes), zone dangereuse. Aucune collision `t`/variable dans `settings.js` — import
direct.

**`auth.js` retouché dans ce lot** (déjà converti partiellement au lot 1 pour l'écran de
verrouillage) : les messages d'erreur renvoyés par `changePin()`/`registerBiometric()`/
`verifyBiometric()` remontent tels quels jusqu'à l'écran Paramètres (`err.message`) — jamais traduits
jusqu'ici alors qu'ils s'affichent bien à l'utilisateur. Traduits au passage, ainsi que les notes
d'audit associées (« Code PIN configuré », « Biométrie activée/désactivée »), cohérent avec le
principe déjà appliqué ailleurs (notes traduites à la création).

**Deux collisions de clé réelles détectées et corrigées avant duplication** (sur 6 doublons au total,
les 4 autres de simples réutilisations légitimes de clés déjà correctes) :
- `'Nom'` existait déjà (« Name », formulaire de catégorie Budgets) mais le champ profil `Nom` désigne
  ici précisément le nom de famille (à côté de `Prénom`) — réutiliser la traduction générique aurait
  affiché « Name » / « First name », une asymétrie confuse. → Texte source changé en **`Nom de
  famille`** (`PROFILE_FIELDS`, `settings.js` — constante partagée avec l'assistant de configuration
  dans `app.js`, toujours pas converti mais qui héritera de ce libellé plus précis quand son tour
  viendra), nouvelle clé dédiée « Last name ».
- `'À jour'` existait déjà (« Settled up », soldes de Partage de dépenses) mais le badge de statut de
  mise à jour logicielle utilise le même mot français pour un sens totalement différent. → Texte
  source changé en **`Version à jour`** (`renderUpdateSection`), plus précis de toute façon hors
  contexte, nouvelle clé dédiée « Up to date ».

**Oubli trouvé et corrigé pendant les tests** : la description du module optionnel "Comptes gardés"
(`OPTIONAL_MODULES[0].description`) était bien passée à `tr(...)` à l'usage, mais aucune entrée
correspondante n'avait été ajoutée au dictionnaire — restait donc en français en mode anglais malgré
l'appel `tr()` en place (le mécanisme de repli silencieux de `t()` masque ce genre d'oubli sans
erreur, d'où l'importance du test bidirectionnel systématique).

**Constantes partagées avec l'assistant de configuration (`app.js`, onboarding — toujours pas
converti)** : `AUTO_LOCK_OPTIONS`, `PROFILE_FIELDS`, `DASHBOARD_PANEL_LABELS`, `OPTIONAL_MODULES`
gardent leurs libellés bruts en français à la déclaration (jamais traduits sur place), traduits
uniquement à l'usage dans `settings.js` — `app.js` continuera de les afficher en français jusqu'à son
propre lot, sans aucune régression entre-temps (comportement "pas encore traduit" normal).

~150 nouvelles entrées de dictionnaire (le plus gros lot), 6 doublons détectés et résolus (4 réutilisés,
2 corrigés en source comme détaillé ci-dessus), 705 clés au total.

Testé FR→EN→FR : les 11 panneaux traduits, formulaire profil (labels désambiguïsés), section sécurité
(changement de PIN avec message d'erreur réel testé — "Incorrect old PIN code." confirmé via une
tentative avec un ancien PIN volontairement faux), confirmation de réinitialisation complète
**annulée volontairement sans jamais confirmer** (pour ne pas effacer les données de test), section
notifications/installation/mise à jour, configuration du tableau de bord, fonctionnalités optionnelles
(description corrigée), et les chaînes de la modale de mapping CSV vérifiées directement via `t(...)`.
Aucune erreur console.

`CACHE_VERSION` : `v62` → `v63`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 12/N : Sauvegarde cloud)

Écran/fichier converti : **Sauvegarde cloud** (`firebase-sync.js`) — section restée hors du lot 11
(fichier distinct du reste de Paramètres). Connexion/déconnexion Google, sauvegarde/restauration à la
demande, rappel hebdomadaire (mode normal + urgent), modale de fraîcheur multi-appareils, tous les
messages d'erreur remontés depuis Firestore/Firebase Auth (`err.message` non traduit lui-même, comme
pour les autres SDK tiers déjà rencontrés — seul le texte autour est traduit). Aucune collision
`t`/variable — import direct.

~30 nouvelles entrées de dictionnaire, 0 doublon (735 clés au total). Avec ce lot, **toutes les vues
listées dans le menu de navigation ainsi que la totalité de l'écran Paramètres sont converties** —
reste : recherche globale, mode démo, assistant de configuration (onboarding).

Testé FR→EN→FR : état "non connecté" (bouton "Sign in with Google" avec le texte de confidentialité
du mot de passe), **déclenchement réel du flux de connexion Google testé** (le clic a effectivement
navigué vers `accounts.google.com` avec les bons paramètres OAuth — confirme que `signInWithRedirect`
se déclenche correctement en environnement automatisé où la popup est bloquée, exactement le
comportement documenté à la conception de cette fonctionnalité le 13 août) — **aucune tentative de
connexion réelle n'a été faite** (hors de portée d'une session automatisée, et interdit par les
règles de sécurité de cette session), retour immédiat à l'app puis nettoyage du réglage
`cloudRedirectPending` resté à `true` suite à la navigation. Messages des modales de rappel et de
fraîcheur cloud vérifiés directement via `t(...)` (ces flux nécessitent un compte connecté pour se
déclencher normalement). Aucune erreur console.

`CACHE_VERSION` : `v63` → `v64`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 13/N : Recherche globale)

Écran converti : **Recherche globale** (`search.js`) — modale de recherche (Ctrl/Cmd+K), index en
mémoire (transactions, portefeuilles, dettes/créances, épargne, investissements, comptes gardés,
dépenses partagées), filtres avancés (portefeuille/catégorie/type/montant/dates). Piège `t`/variable
reproduit à l'identique (`for (const t of transactions)` dans `collectSearchIndex()`) — import aliasé
`tr` dès le départ. `TYPE_LABELS` : mêmes conventions que `ASSET_CLASSES`/`ENTRY_TYPE_LABELS`
(investments.js) — clés (identifiants de type internes) jamais traduites, valeurs traduites à l'usage.

~18 nouvelles entrées de dictionnaire, 1 doublon détecté et corrigé (`'Portefeuille'`, déjà présent
depuis transactions.js — réutilisé), 750 clés au total.

Testé FR→EN→FR : filtres avancés (portefeuilles/catégories peuplés dynamiquement, types), placeholder
et aria-labels, recherche avec résultats (badges de type vérifiés pour Transaction/Wallet/Receivable/
Investment), recherche sans résultat ("No results."), état vide initial, gabarit "Paid by {payer} ·
{date}" vérifié directement via `t(...)`. Aucune erreur console.

`CACHE_VERSION` : `v64` → `v65`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 14/N, dernier lot : mode démo + onboarding)

Dernier lot du chantier. Fusionné volontairement en un seul lot les deux derniers éléments de la
checklist (« mode démo » et « onboarding ») car ils sont imbriqués dans le code : le bouton
"Découvrir avec des données d'exemple" qui déclenche le mode démo vit à l'intérieur de la toute
première étape de l'assistant de configuration (`maybeShowOnboarding()`, `app.js`), les séparer
proprement aurait été artificiel.

**Convertis** :
- `renderDemoModeBanner()` (`app.js`) — bandeau permanent affiché tant que `isDemoModeActive` est vrai.
- `maybeShowOnboarding()` (`app.js`, ~205 lignes) — les 7 étapes de l'assistant (devise + bouton démo,
  premier portefeuille, profil, tableau de bord, modules optionnels, sécurité, notifications), le
  compteur "Étape X / Y", tous les libellés des constantes partagées (`PROFILE_FIELDS`,
  `AUTO_LOCK_OPTIONS`, `DASHBOARD_PANEL_LABELS`, `OPTIONAL_MODULES`) désormais traduits à l'usage ici
  aussi (elles l'étaient déjà côté `settings.js` depuis le lot 11, `app.js` était le seul appelant
  encore en attente).
- **`demo-data.js` — décision de ce lot** : le contenu généré (pas seulement l'écran qui le
  déclenche) est traduit aussi, cohérent avec la décision prise pour le contenu des PDF au lot 8. Noms
  de portefeuilles génériques (« Compte courant » → « Checking account », « Espèces » → « Cash »),
  toutes les notes de transaction (loyer, marché, essence, etc.), le nom de l'objectif d'épargne, le
  nom de l'investissement, la note de la créance. **Volontairement PAS traduits** : « Orange Money »
  (vraie marque, pas un libellé générique) et « Cousin Amadou » (nom de personne) — même principe que
  les noms propres jamais traduits ailleurs dans l'app.

Aucune collision `t`/variable dans `demo-data.js` (le seul `t` local, un paramètre de callback
`.map((t) => ...)`, n'appelle jamais la fonction de traduction dans son propre corps — vérifié).

~50 nouvelles entrées de dictionnaire, 0 doublon (plusieurs réutilisations vérifiées et confirmées
correctes : `'Continuer'`, `'Sécurité'`, `'Verrouillage automatique après inactivité'`, `'Biométrie
activée.'`, `"Échec de l'activation biométrique."`, `'Notifications'`, `'Notifications activées.'`,
`'Effacer'` — tous déjà justes dans ce nouveau contexte), 794 clés au total.

Testé FR→EN→FR : toutes les chaînes de l'assistant vérifiées directement via `t(...)` (le clavier PIN
rendant la navigation UI complète peu fiable, comme documenté depuis le tout premier lot — même limite
constante sur toute la session) ; **`seedDemoData()`/`clearDemoData()` testées de bout en bout en
conditions réelles** (pas seulement via `t()`) : jeu de données généré en anglais puis vérifié
(portefeuilles, notes de transaction, objectif d'épargne, investissement, créance — noms propres
« Orange Money »/« Cousin Amadou » confirmés intacts), bandeau et confirmation de suppression
vérifiés, `clearDemoData()` confirmée (réinitialise bien `isDemoModeActive`/`onboardingCompleted`),
puis même parcours complet rejoué en français pour confirmer l'absence de régression. Aucune erreur
console.

`CACHE_VERSION` : `v65` → `v66`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 15/N : Portefeuilles, trou comblé)

Écran converti : **Portefeuilles** (`wallets.js`) — cartes patrimoine (reste à vivre, patrimoine net,
composition), cartes de portefeuille, formulaire, panneau des taux de change (récupération en ligne
incluse). Ce module avait été **complètement oublié** de la checklist depuis le lot 1 — voir la note
d'avertissement plus haut dans ce fichier pour le contexte de sa découverte. Aucune collision
`t`/variable (vérifié par `grep`) — import direct. `WALLET_TYPES` : mêmes conventions que
`ASSET_CLASSES` (investments.js) — clés jamais traduites, valeurs traduites à l'usage. Beaucoup de
réutilisation de clés déjà posées par les lots précédents (Reste à vivre, Patrimoine net global,
Composition du patrimoine, Créances, Dettes, Investissements, Portefeuilles, tous depuis le lot 1 ou
les lots Budgets/Dettes/Comptes gardés).

~40 nouvelles entrées de dictionnaire, 0 doublon (828 clés au total).

Testé FR→EN→FR de bout en bout avec des données réelles (mode démo re-semé) : cartes patrimoine et
portefeuille, formulaire (tous les types de portefeuille traduits, « Mobile Money » gardé tel quel —
marque, pas un libellé générique), panneau des taux avec un portefeuille EUR ajouté pour forcer
l'affichage du panneau (badge "unconfirmed", saisie manuelle testée avec toast "EUR rate updated."
confirmé), suppression réelle d'un portefeuille de test (confirmation + toast "Wallet deleted."
vérifiés), nettoyage puis retour en français confirmé sans régression. Aucune erreur console.

`CACHE_VERSION` : `v66` → `v67`.

### 15 août 2026 (suite) — Internationalisation FR/EN (lot 16/N : notifications système, trou comblé)

Deuxième trou comblé de l'audit : `notifications.js` — titres et corps de **toutes** les notifications
système proactives (échéances récurrentes proches, dettes/créances à échéance, solde de portefeuille
bas, budget bientôt atteint, résumé hebdomadaire). Ces notifications s'affichent via l'API
Notification native du navigateur (pas de serveur, voir le commentaire d'en-tête du fichier) —
totalement invisibles depuis l'écran Paramètres où j'avais pourtant déjà traduit le bouton "Activer
les notifications" (lot 11) sans jamais ouvrir ce fichier. Aucune collision `t`/variable — import
direct.

~14 nouvelles entrées de dictionnaire, 0 doublon (841 clés au total).

Testé : **limite connue** — `Notification.permission` est `denied` par défaut dans le navigateur
automatisé de cette session (pas d'octroi possible sans geste utilisateur réel), donc `checkAndNotify()`
ne peut pas être déclenché de bout en bout ici (même limite déjà rencontrée pour la connexion Google
réelle). Chaque gabarit vérifié directement via `t(...)` avec des valeurs réalistes à la place, dans
les deux langues (aller-retour FR→EN→FR confirmé après un appel explicite à `initI18n()` pour
recharger le réglage — `setLanguage()` déclenchant un vrai rechargement de page que `javascript_exec`
ne peut pas attendre de façon fiable). Round-trip complet à confirmer par l'auteur en usage réel, sur
un appareil où les notifications sont autorisées.

`CACHE_VERSION` : `v67` → `v68`.

### 16 août 2026 — Internationalisation FR/EN (lot 17/N : sauvegarde, trou comblé)

Troisième trou comblé de l'audit : `backup.js` — messages d'erreur (sauvegarde chiffrée invalide, mot
de passe incorrect, CSV vide, portefeuille introuvable, navigateur non compatible), export CSV (en-tête
+ valeurs "Oui"/"Non" + suffixe de nom de fichier), toast de sauvegarde automatique, et surtout la
**modale de rappel hebdomadaire** (`tpl-modal-backup-reminder` dans `index.html`) qui n'avait jamais
reçu d'attributs `data-i18n` — mode normal et mode urgent (au-delà de 3 reports), plus le formulaire
d'export chiffré inline (mot de passe / confirmation / bouton) qu'elle affiche. Collision `t`/variable
trouvée (transactions nommées `t` dans plusieurs fonctions) — import aliasé `t as tr`, comme
dashboard.js/transactions.js/debts.js/tools.js/reports-extras.js/search.js.

Détection de format CSV rendue bilingue : `GEOFINANCE_CSV_HEADER_FR` (renommé depuis
`GEOFINANCE_CSV_HEADER`) sert toujours de clé i18n pour l'en-tête exporté, mais `analyzeTransactionsCsv`
compare désormais l'en-tête lu aux deux variantes (FR canonique et EN traduite) au lieu d'une seule —
même principe que `RECURRING_NOTE_PREFIXES` (ledger.js, lot 3) et `DEBT_CATEGORY_NAME_VARIANTS`
(debts.js, lot 6) : un CSV exporté par cette app en anglais doit se réimporter correctement. Idem pour
la colonne "Pointée/Reconciled" : `importDjignanCsvRows` accepte désormais `['oui', 'yes']` au lieu
de `.startsWith('oui')` seul. Le gabarit `tpl-modal-backup-reminder` étant un `<template>` (donc inerte
tant que non cloné), `showBackupReminderModal()` relance `applyStaticTranslations()` juste après
l'insertion du clone — même pattern que `openQuickAdd()` (transactions.js, lot 2).

**Bug pré-existant trouvé et corrigé en cours de route** (pas un bug d'i18n, effet de bord de la
réécriture de la détection de format) : `analyzeTransactionsCsv()` retournait `rows` sans que cette
variable soit définie — `const rows = lines.slice(1).map(...)` avait été perdue pendant la réécriture.
Repéré immédiatement au test (import CSV plantait avec `ReferenceError: rows is not defined`), corrigé
avant commit.

~24 nouvelles entrées de dictionnaire, 0 doublon (862 clés au total). Réutilise `'Pointée'` →
`'Reconciled'` et `'Sauvegarde chiffrée exportée.'` → `'Encrypted backup exported.'`, déjà posées par
des lots précédents.

Testé FR→EN→FR de bout en bout via appels directs aux fonctions exportées de `backup.js` (SW/caches
vidés avant chaque test) : `analyzeTransactionsCsv` avec un CSV d'en-tête français et un CSV d'en-tête
anglais, tous deux correctement détectés comme format `geofinance` ; message d'erreur CSV vide ;
message d'erreur `decryptPayload` sur un payload invalide ; modale de rappel en mode normal et en mode
urgent (bouton "Plus tard" bien absent, titre et message d'alerte traduits) ; formulaire d'export
chiffré inline (paragraphe, libellés, bouton) et son toast de mots de passe non correspondants. Aucune
erreur console sur l'ensemble du test.

`CACHE_VERSION` : `v68` → `v69`.

### 16 août 2026 (suite) — Internationalisation FR/EN (lot 18/N, dernier lot : corrections transverses)

Dernière passe : au lieu de traiter un écran, un audit **systématique** de tout le dépôt pour vérifier
l'affirmation « l'app est totalement bilingue » avant de la refaire au auteur — méthode : `grep`
combiné (import i18n manquant par fichier + recherche de tout texte accentué français non enveloppé
dans `t(`/`tr(` à travers **tous** les fichiers, pas seulement ceux touchés récemment) plutôt que de se
fier à la liste des lots déjà faits. Trouvés et corrigés :

- **`utils.js`** (`confirmDialog`) : les valeurs par défaut `title`/`confirmText`/`cancelText` n'étaient
  jamais traduites — impacte QUASIMENT toutes les boîtes de confirmation de l'app (suppression d'une
  transaction, d'un portefeuille, d'un objectif, etc.), la plupart ne passant pas `cancelText`
  explicitement. Piège évité : la clé `'Annuler'` existe déjà dans le dictionnaire mais mappée à
  `'Undo'` (toasts d'annulation après suppression, lot 2) — un commentaire posé à l'époque avertissait
  justement de ne pas la réutiliser ici. Solution : contournement direct par `getLanguage()` (comme
  `intlLocale()` dans le même fichier) plutôt que par le dictionnaire, pour ce cas précis. `'Confirmer'`
  déjà traduit, `'Confirmation'` ajouté. `currencySelectHtml()` : l'option "Autre devise…" et son
  placeholder n'étaient pas non plus traduits — présents sur quasiment tous les formulaires impliquant
  une devise.
- **`ledger.js`** : les deux libellés de repli `'Sans catégorie'` (donut de dépenses par catégorie,
  budget vs réel) n'étaient pas enveloppés — clé déjà existante, juste manquait le `tr()`.
- **`charts.js`** : le libellé `'Réel'` du graphique Budget vs réel n'était pas traduit ; le diagramme
  de flux des revenus (`renderIncomeFlowSankey`, page Tableau de bord) était **entièrement oublié** —
  état vide, libellé "Revenus" du nœud source, et légende "Revenus du mois : {montant}".
- **`install-prompt.js`** — module **complètement oublié**, comme `wallets.js` au lot 15 : la bannière
  d'invitation à l'installation PWA (bouton Chrome/Edge natif, instructions iOS Safari "Partager > Sur
  l'écran d'accueil"), affichée après chaque déverrouillage tant que l'app n'est pas installée. Aucune
  collision `t` (import direct).
- **`app.js`** : le toast affiché en basculant le thème ("Thème : Automatique/Clair/Sombre") n'était pas
  traduit ; l'écran d'erreur affiché en cas d'échec critique au démarrage non plus — vérifié que `t()`
  reste utilisable même si `initI18n()` lui-même a échoué (`currentLang` vaut `'fr'` par défaut au
  chargement du module, donc pas de risque d'erreur en cascade dans ce chemin d'erreur).
- **`settings.js`** : suppression d'un avertissement bilingue devenu obsolète dans la section
  Langue/Language ("Certains écrans pas encore traduits resteront en français. / Some screens not yet
  translated will stay in French.") — posé au tout début du chantier (lot 1) quand c'était encore vrai,
  jamais retiré depuis. Laissé en place aurait été un mensonge actif envers l'utilisateur final une fois
  ce lot terminé.

~30 nouvelles entrées de dictionnaire, 0 doublon (880 clés au total).

Testé FR→EN→FR de bout en bout (SW/caches vidés avant chaque test) : `confirmDialog()` par défaut
("Confirmation" / "Annuler"↔"Cancel" / "Confirmer"↔"Confirm", `'Annuler'`→`'Undo'` du toast d'annulation
vérifié inchangé en parallèle) ; `currencySelectHtml()` (option "Autre devise…" + placeholder) ;
`renderBudgetVsActualChart` (libellés des deux séries) ; `renderIncomeFlowSankey` (état vide + nœud +
légende, avec des données réalistes) ; bannière d'installation simulée via un faux événement
`beforeinstallprompt` (branche Chrome/Edge testée en direct dans les deux langues ; branche iOS Safari
vérifiée via `t()` direct, même limite que la connexion Google réelle — UA non simulable de façon fiable
dans ce navigateur automatisé) ; toast de changement de thème (3 valeurs) ; écran d'erreur de démarrage ;
section Langue/Language de Paramètres rendue en direct pour confirmer la disparition de l'avertissement
obsolète. Aucune erreur console sur l'ensemble du test.

**Bug pré-existant trouvé et corrigé en cours de route (lot 17, avant son commit)** : voir l'entrée du
lot 17 ci-dessus — `analyzeTransactionsCsv()` retournait une variable `rows` jamais définie.

`CACHE_VERSION` : `v69` → `v70`.

**Bilan de l'audit final (lots 15-18)** : après cette passe, tous les fichiers `.js` du dépôt contenant
du texte destiné à l'utilisateur importent `i18n.js`, à l'exception de `db.js` (définit
`DEFAULT_CATEGORIES`, traduit à l'usage lors de la création, jamais rétroactivement — voir le principe
documenté plus haut), `firebase-config.js` (config technique, pas de texte affiché), `ocr.js`/`state.js`
(aucun texte utilisateur), et `sw-register.js` (un seul `console.error` de diagnostic). Recherche
supplémentaire de tout texte français non enveloppé (accents non suivis de `t(`/`tr(`) à travers
l'ensemble du dépôt (JS + `index.html`) : aucun résultat restant en dehors de commentaires, de données
utilisateur (noms de catégories/portefeuilles/transactions, volontairement non retraduites) et de
dictionnaires clé/valeur déjà traduits à l'usage.

### 16 août 2026 (suite) — 3 bugs signalés par l'auteur après relecture visuelle

L'auteur a testé l'app en direct (mode anglais + export PDF) et remonté deux captures d'écran montrant
des problèmes réels, non liés au fond du chantier i18n mais découverts grâce à lui :

1. **Bouton natif de sélection de fichier bloqué en français** (Ajout rapide → Justificatif photo),
   même en mode anglais. Diagnostic : le libellé natif du navigateur pour `<input type="file">`
   ("Choisir un fichier"/"Aucun fichier choisi") suit la langue d'AFFICHAGE du navigateur lui-même
   (`chrome://settings/languages`), **pas** l'attribut `lang` de la page ni notre i18n — contrairement
   aux autres textes générés par le navigateur (validation de formulaire, sélecteur de date), ce bouton
   précis ignore `document.documentElement.lang`. Confirmé par recherche externe (comportement Chromium
   documenté, ex. Firefox bug 1538027). Aucun changement de `lang`/i18n ne peut le corriger. **Fix** :
   remplacement par un bouton stylé traduisible (`#qa-receipt-trigger`, `data-i18n="Choisir un
   fichier"`) qui déclenche `input.click()` sur le vrai `<input type="file">`, désormais rendu
   visuellement invisible (`clip:rect(0,0,0,0)`) mais fonctionnellement intact (capture photo mobile,
   accessibilité, `capture="environment"` préservés). `index.html` (template Ajout rapide) +
   `js/modules/transactions.js` (câblage du clic).
2. **Export PDF ("Bilan financier") : séparateur de milliers affiché en "/"** au lieu d'un espace
   (ex: "823/500 F/CFA" au lieu de "823 500 F CFA"). Diagnostic : `formatCurrency()` (utils.js), en
   locale `fr-FR`, produit des espaces Unicode fines/insécables (U+202F, U+00A0) comme séparateur —
   correct à l'écran (police web normale), mais la police intégrée de jsPDF (Helvetica, encodage
   WinAnsi 1 octet) n'a pas ces glyphes et affiche un caractère de repli qui ressemble à "/". Aucune
   sanitisation n'existait pour le contexte PDF. **Fix** : nouvelle fonction `pdfAmount(amount,
   currency)` dans `js/modules/reports.js`, qui appelle `formatCurrency()` puis remplace ces espaces
   Unicode par un espace normal — utilisée à la place de `formatCurrency()` dans TOUS les appels
   `doc.text(...)` des deux générateurs PDF (mensuel et annuel). L'affichage à l'écran (hors PDF) garde
   le formatage Intl d'origine, inchangé.
3. **Bug non lié, trouvé pendant les tests de vérification** (pas dans le diff de session, remonte au
   commit `6e6db5a`, bien avant le chantier i18n) : le flux "Découvrir avec des données d'exemple" de
   l'assistant d'onboarding (`app.js`, étape 1) appelait `notifyDataChanged('all')` sans jamais
   l'importer — `ReferenceError` silencieuse en pleine navigation, empêchant le rafraîchissement de
   l'UI après le chargement des données de démo. **Fix** : ajout de `notifyDataChanged` à l'import
   groupé depuis `./state.js` en tête de `app.js`.

Testé : bouton fichier vérifié dans les deux langues (FR "Choisir un fichier" / EN "Choose file"),
clic confirmé déclenchant bien le vrai `<input type="file">` sous-jacent ; PDF vérifié en interceptant
tous les appels `doc.text(...)` d'un vrai `generatePdfReport()` (jsPDF patché pour capturer le texte au
lieu de télécharger) — confirmé par code de caractère (`charCodeAt`) que le texte envoyé au PDF ne
contient plus ni U+202F ni U+00A0, alors que `formatCurrency()` brut les contient toujours (l'affichage
écran n'est pas dégradé) ; `notifyDataChanged` vérifié résolu et fonctionnel via le bus d'événements
réel. Un `console.error` `notifyDataChanged is not defined` avait été observé une fois en cours de
test — confirmé stale (onglet précédent, avant le fix) via un onglet neuf sans historique. Aucune
nouvelle entrée de dictionnaire pour ce lot hormis `'Choisir un fichier'` → `'Choose file'`.

`CACHE_VERSION` : `v70` → `v71`.

### 16 août 2026 (suite) — Vérification post-push : demo-data.js perdait la catégorie en anglais

Après le push, l'auteur a demandé une vérification explicite de la traduction et du thème sombre/clair.
Méthode (le rendu visuel du panneau Browser n'était pas affiché dans cette session, donc pas de
captures d'écran possibles) : rendu direct de chaque module (`renderDashboard`, `renderWallets`,
`renderTransactions`, `renderBudgets`, `renderSavings`, `renderInvestments`, `renderDebts`,
`renderTools`, `renderReports`, `renderShared`, `renderKeptAccounts`, `renderSettings`) avec de
vraies données de démo, extraction du texte réel de chaque section via `textContent`, en français
d'abord puis en anglais après re-semis des données de démo en anglais — plus une vérification
programmatique des variables CSS de thème (contraste WCAG) et du bouton de bascule de thème.

**Bug trouvé, invisible à l'audit statique précédent** (celui-ci cherchait du texte français non
traduit dans le code source — ce bug-ci est une erreur de LOGIQUE, pas de texte manquant) :
`demo-data.js`, fonction `cat(name)` (ligne ~56) — comparait le nom français canonique passé en
argument (ex: `cat('Alimentation')`) directement à `categories[i].name`, qui contient en réalité le nom
DÉJÀ TRADUIT (`t(c.name)`, donc `"Food"` en anglais). Résultat : en anglais, **toutes** les transactions
et tous les budgets de démonstration perdaient leur catégorie (`categoryId: null` → affiché "No
category" partout : tableau de bord, transactions, budgets, "Categories to watch"), alors que les
catégories elles-mêmes ÉTAIENT correctement nommées en anglais. Repéré en comparant le texte rendu :
"Transport" restait correctement assigné (le seul nom identique en FR/EN) tandis que "Alimentation"/
"Loisirs"/etc. donnaient tous "No category". **Fix** : `cat()` retraduit maintenant aussi son argument
avant comparaison (`categories.find((c) => c.name === t(name))`), pour matcher la même transformation
appliquée aux catégories à leur création. Comportement inchangé en français (`t()` renvoie l'entrée telle
quelle quand `currentLang !== 'en'`).

Reste du bilan de vérification, **rien d'autre trouvé** :
- Tout le texte des 12 écrans testés (Dashboard, Portefeuilles, Transactions, Budgets, Épargne,
  Investissements, Dettes & créances, Outils, Rapports, Partage de dépenses, Comptes gardés,
  Paramètres) s'affiche intégralement en anglais après le correctif ci-dessus — plus aucune occurrence
  de "No category"/"Sans catégorie" injustifiée, plus aucun texte français résiduel repéré dans le
  texte extrait.
- Thème sombre/clair : architecture CSS saine (`:root` = palette claire par défaut, `[data-theme="dark"]`
  = surcharge explicite, `body[data-theme="auto"]` sous `@media (prefers-color-scheme: dark)` = détection
  système, cohérent avec les conventions Artifact). Contrastes WCAG calculés sur les vraies valeurs de
  variables CSS : texte principal sur fond 16.5:1 (clair) / 16.9:1 (sombre), texte atténué 4.5:1 / 7.5:1,
  couleurs de statut (accent/positif/négatif) 3.3–5.4:1 — cohérent avec un usage sur éléments larges/
  icônes/boutons, pas de texte de contenu. Bouton de bascule (`#theme-toggle`) testé sur 4 clics
  consécutifs : `appState.theme` et `document.body.dataset.theme` restent parfaitement synchronisés à
  chaque clic, cycle correct `auto → dark → light → auto → ...`, persistance en base confirmée
  (`getSetting('theme')` reflète chaque changement).

`CACHE_VERSION` : `v71` → `v72`.

### 16 août 2026 (suite) — Choix de la langue en tout premier, avant même la création du code PIN

Demande explicite de l'auteur : la langue devait pouvoir être choisie dès l'installation, pas
seulement découverte plus tard dans Paramètres. Avant ce lot, l'appli démarrait toujours en français
par défaut (`getSetting('language', 'fr')`, aucune détection de la langue du navigateur) — un
utilisateur anglophone voyait tout le premier lancement (écran de création du PIN inclus) en français
sans le savoir, jusqu'à trouver lui-même le sélecteur dans Paramètres.

**Nouveau : écran de choix de langue affiché avant l'écran de création du PIN**, sur une toute première
installation uniquement (même garde que `maybeShowOnboarding()` : `!isPinConfigured()` — un PIN déjà
configuré signifie que ce n'est pas une première installation ; jamais réaffiché à un utilisateur
existant après coup).

- `index.html` : nouveau `<div id="language-screen" class="lock-screen" hidden>` juste avant
  `#lock-screen`, réutilisant les classes `.lock-screen`/`.lock-card`/`.lock-logo` pour un rendu visuel
  identique. Deux boutons `#language-choice-fr` ("Français") / `#language-choice-en` ("English").
  Volontairement **sans** `data-i18n` sur ce libellé ni sur les boutons : chaque langue s'auto-désigne
  dans sa propre écriture, choisir l'une des deux langues pour traduire l'écran de CHOIX de la langue
  n'aurait pas de sens.
- `js/app.js` : nouvelle fonction `showLanguageChoiceScreen()`, appelée dans `boot()` juste après
  `initI18n()` et avant `seedDefaultsIfNeeded()` (l'ordre est important : les catégories par défaut
  doivent être créées APRÈS que la langue soit connue, sinon elles seraient semées dans la mauvaise
  langue). Masque `#lock-screen`, affiche `#language-screen`, attend un clic sur l'un des deux boutons,
  enregistre la langue (`setSetting('language', lang)`), rappelle `initI18n()` (retraduit tout le
  châssis statique déjà présent dans le DOM, y compris l'écran de PIN caché en dessous) — **sans
  recharger la page**, contrairement à `setLanguage()` (Paramètres) qui fait un rechargement complet.

Testé de bout en bout, base de données entièrement vidée avant chaque scénario (simulateur
d'installation neuve) :
- Écran de langue bien affiché en tout premier (avant le PIN), les deux seuls boutons interactifs à ce
  stade sont "Français"/"English" (confirmé via l'arbre d'accessibilité).
- Clic "English" → écran de langue disparaît, écran de PIN apparaît directement en anglais ("Create
  your PIN code" / "Choose a 4-6 digit code..."), châssis latéral (menu) confirmé entièrement en
  anglais (Dashboard, Wallets, Transactions, Budgets, Savings, Investments, Debts & receivables, Tools,
  Reports, Shared expenses, Managed accounts) sans recharger la page.
- Rejoué en français ("Français") : écran de PIN bien en français, catégories par défaut vérifiées
  semées en français (Transport, Logement, Alimentation, Salaire…).
- Rejoué en anglais avec les catégories par défaut vérifiées semées directement en anglais (Housing,
  Food, Salary, Leisure…) — confirme que `seedDefaultsIfNeeded()` s'exécute bien après la résolution du
  choix de langue.
- **Non-régression** : un PIN configuré au préalable (simulateur d'installation existante) fait
  sauter entièrement l'écran de choix de langue, passage direct à l'écran de déverrouillage — un
  utilisateur existant n'est jamais interrompu par ce nouvel écran.
- Aucune erreur console sur l'ensemble des scénarios.

`CACHE_VERSION` : `v72` → `v73`.

### 16 août 2026 (suite) — Graphique "Répartition des revenus du mois" illisible en production

Signalé par l'auteur avec une capture d'écran du site en production (`zaky04.github.io/geofinance`) :
le graphique en bas du tableau de bord ("Répartition des revenus du mois") s'affichait comme un
amas de bandes colorées illisibles, sans rapport avec un diagramme de flux lisible. Pas un bug
d'internationalisation — un défaut de conception préexistant dans `renderIncomeFlowSankey`
(`charts.js`), révélé par des données réelles avec beaucoup de catégories de dépenses de valeurs très
disparates (14 catégories visibles sur la capture de l'auteur).

**Diagnostic confirmé par reproduction exacte** : ce graphique construit en réalité la répartition du
revenu du mois entre chaque catégorie de DÉPENSE (pas les sources de revenus) plus l'épargne nette
(`dashboard.js` : `flows = expensesByCategory.map(...)`, puis `flows.push({label: 'Épargne nette', ...})`).
La hauteur de chaque bande était calculée strictement proportionnelle à sa valeur, sans plancher. Avec
un jeu de test reproduisant fidèlement la capture (13 petites catégories + une "Épargne nette"
dominante représentant ~88% du revenu), les bandes des 13 catégories se retrouvaient compressées dans
23 px de hauteur cumulée — avec une police de 12 px, 8 étiquettes de texte se chevauchaient
intégralement, exactement le résultat vu par l'auteur. `computeExpensesByCategory` (`ledger.js`)
limite déjà à 7 catégories + "Autres" au-delà de 8, mais ça ne protège pas contre ce cas précis : une
poignée de petites catégories à côté d'une valeur dominante (l'épargne nette, ou une grosse dépense
isolée) suffit à réduire les autres bandes à quelques pixels.

**Fix** : hauteur minimale (`MIN_ROW_H = 20`) imposée à chaque flux avant le calcul proportionnel — un
flux ne descend jamais en dessous de cette hauteur, même si ça dépasse la hauteur "naturelle"
(nombre de flux × 30px) ; les flux réellement dominants gardent leur proportion normale au-dessus de
ce plancher. Le graphique grandit plutôt que de sacrifier la lisibilité — cohérent avec le `viewBox`
+ `height:auto` déjà en place, qui absorbe une hauteur variable sans rien casser côté mise en page.

Testé : reproduction exacte du scénario de la capture (13 catégories disparates + épargne nette
dominante) — tous les écarts verticaux entre étiquettes consécutives valent maintenant 20px minimum
(vérifié par le calcul des positions `y` réelles du SVG rendu), plus aucun chevauchement possible.
Hauteur totale du graphique passée de 420 px à ~631 px pour ce jeu de données — attendu et acceptable,
le conteneur suit via `height:auto`.

`CACHE_VERSION` : `v73` → `v74`.

### 16 août 2026 (suite) — Suppression du graphique de flux, ajout de 2 courbes de variation mensuelle

Suite à la discussion sur le graphique "Répartition des revenus du mois" (voir entrée ci-dessus) :
l'auteur, après explication, a jugé le graphique redondant avec le donut "Dépenses par catégorie"
juste à côté (même source de données, `computeExpensesByCategory`) et a demandé sa suppression pure
et simple, remplacé par deux nouvelles courbes plus utiles : variation mensuelle des dépenses et des
entrées, chacune filtrable par année et par catégorie.

**Suppression** : `renderIncomeFlowSankey()` (dernière fonction SVG-à-la-main du fichier,
`charts.js`), son appel dans `dashboard.js`, son conteneur `#dashboard-income-flow` (`index.html`),
et les 3 entrées de dictionnaire devenues orphelines (`'Pas assez de données...'`, `'Revenus'`,
`'Revenus du mois : {amount}'`) — plus aucun graphique de ce module n'est fait main, tous passent
maintenant par Chart.js.

**Ajout** : deux nouveaux panneaux sur le tableau de bord, à la place de l'ancien, chacun avec un
sélecteur d'année (‹ › comme le "Bilan annuel" de Rapports) et un filtre de catégorie
("Toutes catégories" ou une catégorie précise) :
- `ledger.js` : nouvelle fonction `computeMonthlyTypeHistory(year, type, categoryId)` — total par mois
  (12 points) d'un type de transaction (income/expense) sur une année donnée, filtré à une catégorie
  si fournie. Contrairement aux fonctions d'historique existantes (`computeNetWorthHistory` etc.), les
  libellés de mois utilisent `intlLocale()` (déjà exporté depuis `utils.js`) au lieu d'un `'fr-FR'`
  câblé en dur — pas de nouveau trou i18n introduit. Nouvelle fonction `getCategoriesByType(type)`
  pour peupler les filtres.
- `js/modules/dashboard.js` : `renderNetWorthTrendChart()` (déjà générique, `charts.js`) réutilisée
  telle quelle pour les deux courbes — aucun nouveau code de rendu Chart.js nécessaire. État des
  filtres (année/catégorie) au niveau module, comme `reportYear`/`reportMonthKey` dans `reports.js`,
  pour persister entre les re-rendus du tableau de bord. Nouveau `initDashboardModule()` (jusqu'ici
  absent, dashboard.js n'avait aucun câblage à faire une seule fois) pour les boutons année précédente/
  suivante et le `<select>` de catégorie — appelé une fois depuis `boot()` (`app.js`), comme les autres
  modules.

~2 nouvelles entrées de dictionnaire (`'Variation mensuelle des dépenses'`, `'Variation mensuelle des
entrées'`) — `'Toutes catégories'`, `'Dépenses'`, `'Entrées'` déjà existantes, réutilisées telles
quelles.

Testé FR→EN de bout en bout avec des transactions réparties sur plusieurs mois de l'année (ajoutées
manuellement pour valider la variation, les données de démo ne couvrant que les ~2 derniers mois) :
- Total "Toutes catégories" vs filtré à "Alimentation" : les deux courbes affichent des valeurs
  différentes et correctes mois par mois.
- Navigation année précédente/suivante : le label d'année et les données du graphique se mettent à
  jour ensemble, testé sur une instance de module propre (un premier test avec des instances mélangées
  — import direct vs import avec `?v=` de cache-busting — a donné un résultat trompeur : chaque import
  différemment paramétré crée sa PROPRE instance de module avec son PROPRE état, alors que les
  écouteurs réels ne sont attachés qu'à l'instance chargée par `app.js` au démarrage ; reproduit
  proprement avec un seul import cohérent, comportement confirmé correct).
- Anglais : titres des deux panneaux, première option du filtre ("All categories"), libellés de mois
  ("Jan 26" au lieu de "janv. 26") et libellé de la série ("Expenses") tous corrects.
- Aucune erreur console.

`CACHE_VERSION` : `v74` → `v75`.

### 16 août 2026 (suite) — Analyse des graphiques + nouvelle section "Graphiques" sur Rapports

Suite à une demande de l'auteur d'analyser l'utilité de tous les graphiques du tableau de bord et de
proposer des améliorations. Constat : aucune vraie redondance entre les 5 graphiques existants
(chacun répond à une question différente — composition du mois / trajectoire du patrimoine /
discipline budgétaire du mois / tendance annuelle dépenses / tendance annuelle revenus), mais un vrai
trou : rien ne combine visuellement revenus et dépenses dans le temps pour montrer l'épargne
résultante. Proposé et validé avec l'auteur : garder le tableau de bord tel quel (seule exception :
étendre "Évolution de la valeur nette" de 6 à 12 mois glissants) et construire une section
"Graphiques" complète sur la page **Rapports**, réunissant tous les graphiques déjà présents (recalculés
sur `reportMonthKey`/`reportYear` plutôt que dupliqués visuellement) **plus** 4 nouveautés.

**Dashboard (changement minimal)** : `computeNetWorthHistory(6)` → `computeNetWorthHistory(12)`
(`dashboard.js`) — un seul appel changé, pas de nouvelle navigation ajoutée sur cette page.

**Nouvelles fonctions `ledger.js`** :
- `computeNetWorthHistoryForYear(year)` — variante calendaire (Jan-Déc) de `computeNetWorthHistory()`
  (qui est glissante), pour partager le sélecteur d'année de Rapports plutôt que d'avoir sa propre
  navigation.
- `computeMonthlyNetSavingsHistory(year)` — épargne nette (revenus - dépenses) ET taux d'épargne (%)
  associé, mois par mois, en un seul appel (les deux vues du même graphique, bascule côté UI).
- `computeMonthlyBudgetVsActualHistory(year, categoryId)` — équivalent annuel de
  `computeBudgetVsActual()` (qui ne couvre qu'un mois) ; même convention que
  `computeMonthlyBudgetSummary()` pour "toutes catégories" (seules les catégories budgétées ce
  mois-là entrent dans le total agrégé).

**Nouvelles fonctions `charts.js`** :
- `renderMultiTrendChart(canvasId, series, currency)` — généralise `renderNetWorthTrendChart()` à
  plusieurs séries (ex: année courante en trait plein + année précédente en pointillé). Laissée
  comme fonction séparée exprès : ne touche à aucun appel existant (dashboard, dettes,
  investissements) qui n'a besoin que d'une seule série. Le remplissage sous la courbe ne s'active
  que si une seule série est affichée — avec 2 séries, une zone remplie sous une seule des deux
  suggérerait à tort une signification.
- `renderNetSavingsBarChart(canvasId, points, currency, asPercent)` — barres vertes si le mois est
  positif, rouges sinon ; `asPercent` bascule l'affichage entre montant et taux d'épargne.

**Section "Graphiques" (`reports.js`, nouvelle, sous "Bilan annuel")** — 7 graphiques : les 3 déjà
présents sur le tableau de bord (dépenses par catégorie, valeur nette, budget vs réel) + 2 courbes de
variation mensuelle (dépenses/entrées, réutilisant `computeMonthlyTypeHistory()` du lot précédent,
chacune avec une case "Comparer à l'année précédente" qui superpose l'année N-1 en pointillé) + 2
nouvelles (épargne nette mensuelle avec bascule €/%, budget vs réel en tendance annuelle avec filtre
catégorie). Tous les graphiques annuels partagent le sélecteur d'année déjà présent pour le "Bilan
annuel" (`reportYear`, boutons `#rep-prev-year`/`#rep-next-year`) plutôt que d'avoir chacun leur
propre navigation — un seul réglage d'année cohérent sur toute la page. Filtres de catégorie/cases à
cocher en état module (comme `reportYear`), re-générés à chaque `renderReports()` (le conteneur est
entièrement reconstruit à chaque navigation mois/année, donc pas de risque de doublons
d'écouteurs — même convention que le reste du fichier).

~4 nouvelles entrées de dictionnaire (`"Comparer à l'année précédente"`, `'Épargne nette
mensuelle'`, `'Afficher en %'`, `'Budget vs réel — tendance annuelle'`) ; `'Graphiques'`, `'Budget'`,
`'Réel'`, `'Toutes catégories'` déjà existantes, réutilisées.

Testé FR→EN de bout en bout avec des transactions et budgets répartis sur 2 années (année courante +
année précédente à 60% des montants, pour valider la comparaison) : les 7 graphiques s'affichent avec
les bons titres et les bonnes données ; comparaison année sur année vérifiée par inspection directe
des datasets Chart.js (série pleine vs pointillée, valeurs N-1 correctement à 60% de N) ; filtre de
catégorie vérifié à la fois seul et combiné à la comparaison année sur année ; bascule €/% de l'épargne
nette vérifiée sur des valeurs positives (ratio cohérent avant/après changement d'année, confirmant le
calcul) et sur un cas synthétique négatif (barre rouge confirmée) ; navigation d'année confirmée
propager le changement à TOUS les graphiques annuels simultanément (dépenses, entrées, épargne nette),
y compris le filtre de catégorie déjà sélectionné qui persiste correctement à travers le changement
d'année ; extension du tableau de bord à 12 mois glissants confirmée (`sept. 25` → `août 26`) ; anglais
vérifié sur les 7 titres, les 2 cases à cocher et la première option des filtres de catégorie. Aucune
erreur console sur l'ensemble du test.

`CACHE_VERSION` : `v75` → `v76`.

### 16 août 2026 (suite) — Barre du haut inutilisable sur iPhone à encoche/île dynamique

Signalé par l'auteur : sur iPhone 14, les boutons de la barre du haut (recherche, masquer les
montants, thème, "Saisie express") ne sont pas cliquables sans zoomer.

**Diagnostic** : `index.html` a bien `viewport-fit=cover` (nécessaire pour que `env(safe-area-inset-*)`
prenne effet), mais **seule** la barre du bas (`.bottom-nav`) et certains éléments (modales, écran de
PIN) compensaient l'encoche/l'île dynamique/la barre d'accueil via `env(safe-area-inset-bottom)`. La
barre du HAUT (`.topbar`) n'avait aucun `padding-top` de ce type — pire, elle utilisait `height:
var(--topbar-h)` (64px, fixe) au lieu de `min-height`. Avec `box-sizing:border-box` (règle globale du
projet), ajouter un `padding-top` à une hauteur FIXE aurait mangé cette hauteur au lieu d'en ajouter —
sur un iPhone 14 (îlot dynamique ≈ 59px d'insécable), les boutons (cercles 38px de diamètre) se
seraient retrouvés compressés dans les ~5px restants de la boîte de 64px, débordant hors de leur
conteneur et devenant impossibles à taper au bon endroit. Le même défaut existait en double sur
`.bottom-nav` (qui AVAIT déjà le `padding-bottom`, mais toujours avec `height` fixe au lieu de
`min-height` — bug latent moins visible côté bas car la barre d'accueil, ≈34px, est plus petite que
l'îlot dynamique du haut, ≈59px, donc moins susceptible d'écraser complètement les icônes, mais
potentiellement déjà compressées).

**Fix** (`css/styles.css`) :
- `.topbar` : `height` → `min-height`, `padding: 0 28px` → `padding: env(safe-area-inset-top) 28px
  0` (+ même correction dans la surcharge mobile `@media (max-width:900px)` qui écrasait
  complètement ce padding).
- `.bottom-nav` : `height` → `min-height` (le `padding-bottom: env(safe-area-inset-bottom)` existait
  déjà, il lui manquait juste une boîte capable de grandir).
- `.view-root` (mobile) : le padding bas fixe (`100px`, pour dégager le contenu défilant de la barre
  du bas) devient `calc(100px + env(safe-area-inset-bottom))` — sinon le dernier contenu resterait
  caché derrière la barre du bas désormais plus haute sur un écran à barre d'accueil.
- `.toast-container` / `.install-banner` : leur position (`bottom: calc(var(--bottom-nav-h) + 16px)`)
  intègre maintenant `+ env(safe-area-inset-bottom)`, sinon ils se seraient superposés au sommet de
  la barre du bas désormais plus haute.
- `.lock-screen` (écran de PIN) vérifié SANS changement nécessaire : contenu centré verticalement
  (`align-items:center`), rien d'actionnable ne se trouve physiquement sous l'encoche.

Testé : ce dépôt de test n'a pas d'appareil réellement encoché disponible, donc `env(safe-area-inset-*)`
s'y résout systématiquement à `0px` — confirmé que ça ne change RIEN au rendu sur un écran normal (pas
de régression). Pour prouver que le correctif fonctionne réellement avec une encoche non nulle, valeur
forcée manuellement en `padding-top: 59px` (îlot dynamique iPhone 14 Pro) sur `.topbar` en direct dans
le navigateur : la barre grandit de 64px à ~98px (au lieu de rester bloquée à 64px), et le bouton
recherche se retrouve entièrement sous la zone simulée (y=59 à y=97, hauteur 38px intacte) au lieu
d'être compressé/débordant — comportement AVANT/APRÈS comparé directement, confirme le mécanisme.
Vérification plus large de l'adaptation mobile demandée par l'auteur : aucun débordement horizontal
détecté (scan automatique de tous les éléments de Dashboard/Transactions/Budgets/Rapports à 375px de
large, y compris la nouvelle section Graphiques du lot précédent — 0 élément dépassant le viewport) ;
contrôles de la section Graphiques (sélecteurs, cases à cocher) confirmés lisibles et correctement
repliés sur leur propre ligne à cette largeur. Aucune erreur console.

`CACHE_VERSION` : `v76` → `v77`.

### 16 août 2026 (suite) — Audit responsive complet (confirmé par l'auteur sur iPhone 14 réel)

L'auteur a confirmé que le correctif de la barre du haut (entrée ci-dessus) fonctionne bien sur son
iPhone 14 réel, et a demandé d'en profiter pour vérifier le mode responsive de toute l'app. Méthode :
les 12 vues (Dashboard, Portefeuilles, Transactions, Budgets, Épargne, Investissements, Dettes &
créances, Outils, Rapports, Partage, Comptes gardés, Paramètres) parcourues par **vraie navigation**
(clic sur `[data-view-target]`, pas juste appel direct de `renderX()` qui laisse la vue `hidden` et
fausse toute mesure de largeur — piège rencontré une fois pendant cet audit : un premier script de
scan annonçait 0 débordement partout alors qu'une vraie régression existait, parce qu'il scannait des
vues restées cachées). Trois largeurs testées : 375px (mobile), 768px (tablette), 1280px (desktop) —
scan automatique (élément dont le bord droit dépasse le viewport) + inspection visuelle par capture
d'écran sur chaque vue à 375px.

**Bug trouvé et corrigé** : `index.html`, en-tête de la vue Transactions — le groupe de 3 boutons
("Sélection multiple", "Rapprochement", "+ Nouvelle transaction") était dans un conteneur
`display:flex;gap:8px` **sans** `flex-wrap:wrap`. Sur un écran étroit, les 3 boutons ne pouvaient pas
passer à la ligne et débordaient horizontalement — le dernier bouton ("+ Nouvelle transaction") se
retrouvait coupé, avec une barre de défilement horizontale sur toute la page. Une règle
`@media (max-width:480px) { .view-header .btn { flex: 1 1 100%; } }` existait déjà pour forcer chaque
bouton en pleine largeur, mais ne pouvait rien faire tant que son parent immédiat refusait
explicitement le retour à la ligne. Fix : ajout de `flex-wrap:wrap` sur ce conteneur (seul endroit du
fichier avec ce motif précis — les autres vues n'ont qu'un seul bouton dans leur en-tête, donc pas
concernées).

**Reste du bilan, rien d'autre trouvé** : après correctif, 0 débordement horizontal sur les 12 vues ×
3 largeurs (scan automatique par vraie navigation, cette fois fiable). Inspection visuelle à 375px
confirmée propre sur toutes les vues, y compris les cas les plus denses (formulaire Paramètres avec
tous ses boutons de sauvegarde, section Graphiques de Rapports avec ses sélecteurs/cases à cocher,
nom de participant long dans Partage de dépenses qui passe correctement à la ligne sans pousser les
boutons d'action hors champ). 768px et 1280px vérifiés uniquement par scan automatique (pas
d'anomalie visuelle attendue à ces largeurs, moins contraintes).

`CACHE_VERSION` : `v77` → `v78`.

### 16 août 2026 (suite) — Renommage complet : GeoFinance → Djignan Financial System

Demande de l'auteur : renommer l'app et son logo. Nom principal affiché : **Djignan** (court) /
**Djignan Finance**, sous-titre/branding complet : **Djignan Financial System**. Logo fourni par
l'auteur (`C:\Users\djaka\Downloads\djignan Finance.jpg`, 2832×1504) — un motif géométrique en fil de
fer façon coquillage cauri, dégradé bleu→vert→or, sur fond bleu marine (#111226).

**Icônes** — aucun outil de traitement d'image (ImageMagick/PIL/sharp) installé sur la machine ;
utilisé PowerShell + `System.Drawing` (.NET, natif Windows, zéro dépendance à installer). Recadrage de
l'icône seule (sans le texte "Djignan FINANCE" à droite) à x=445,y=305,800×800px dans l'image source,
validé visuellement avant de continuer (un premier essai à 860px de large mordait sur le texte,
resserré à 800px). Fichiers régénérés dans `icons/` :
- `icon-192.png` / `icon-512.png` ("any") : recadrage direct redimensionné.
- `icon-maskable-192.png` / `icon-maskable-512.png` : glyphe replacé sur un canevas 1120×1120 (fond
  #111226 échantillonné directement sur l'image source, pour une jonction invisible) avant
  redimensionnement — le glyphe touche presque les bords de son cadre naturel, sans cette marge il
  aurait été rogné par le masque circulaire/squircle qu'Android applique aux icônes "maskable".
- `icon.svg` : image source photographique (dégradés/lueurs), pas raisonnablement vectorisable à la
  main — remplacé par un wrapper SVG encapsulant `icon-192.png` en base64 (`<image href="data:...">`),
  191 Ko (le choix du PNG 192px plutôt que 512px pour cet encapsulage réduit le poids d'un favicon qui
  ne s'affiche jamais au-delà de ~48px). `icon-maskable.svg` (fichier orphelin, jamais référencé nulle
  part) supprimé.
- 3 logos vectoriels dessinés à la main dans `index.html` (`.lock-logo` ×2, `.sidebar-brand`)
  remplacés par des `<img src="icons/icon-192.png">` — `.lock-logo` étiré en `object-fit:cover` pour
  remplir entièrement son badge arrondi (le fond bleu marine du logo masque totalement l'ancien fond
  `var(--accent)` violet du badge, sans transition visible).

**Renommage textuel** — script Node : remplacement ordonné (`"GeoFinance System"` →
`"Djignan Financial System"` D'ABORD, puis `"GeoFinance"` → `"Djignan"` ensuite, sur tout le dépôt
`.js`/`.html`/`.json` — l'ordre compte, sinon la phrase composée aurait été mutilée par la règle du mot
seul en premier). 93 remplacements sur 34 fichiers. Cette seule règle a aussi renommé automatiquement
les identifiants de code contenant "GeoFinance" en sous-chaîne exacte (`isGeoFinanceFormat` →
`isDjignanFormat`, `importGeoFinanceCsvRows` → `importDjignanCsvRows`, dans `backup.js`/`settings.js`)
— cohérent puisque le script a traité tous les sites d'appel et l'export en une seule passe atomique,
vérifié après coup par `node --check` sur tous les fichiers + zéro doublon dans `i18n.js` (883 clés).

**Identifiants techniques VOLONTAIREMENT préservés** (tous en minuscules, donc naturellement épargnés
par le remplacement sensible à la casse, mais vérifiés un par un pour confirmer que c'était le bon
choix) :
- `DB_NAME = 'geofinance-db'` (`db.js`) — le nom de la base IndexedDB. Le changer aurait fait
  disparaître aux yeux de l'appli TOUTES les données existantes des utilisateurs déjà actifs (l'ancienne
  base resterait sur leur appareil, orpheline, mais l'appli ouvrirait une base différente et vide).
  Ne JAMAIS renommer cet identifiant, même dans un futur rebranding.
- `payload.geofinanceEncryptedBackup` (`backup.js`) — marqueur de format dans les sauvegardes
  chiffrées déjà exportées par des utilisateurs. Le renommer aurait rendu illisibles toutes les
  sauvegardes chiffrées existantes (le contrôle `if (!payload?.geofinanceEncryptedBackup)` aurait
  échoué sur d'anciens fichiers).
- `CACHE_NAME` / filtre de nettoyage (`sw.js`) — nom du cache Service Worker, jamais vu par
  l'utilisateur ; renommer le préfixe aurait laissé les anciens caches `geofinance-vNN` orphelins
  (jamais nettoyés par le filtre s'il avait aussi changé de préfixe) — zéro bénéfice utilisateur pour ce
  risque, laissé tel quel.
- `firebase-config.js` (`authDomain`/`projectId`/`storageBucket` = `geofinance-backup...`) — identité
  d'un vrai projet Firebase existant. Renommer le texte ici ne renomme pas le projet Firebase
  lui-même (ça se fait dans la console Firebase) — l'aurait juste cassé (pointerait vers un projet
  inexistant). Non touché.

**Renommés pour cohérence** (visibles par l'utilisateur, sans risque de compatibilité) :
`manifest.json` (`name`/`short_name`), noms des fichiers exportés (`geofinance-backup-*.json` →
`djignan-backup-*.json`, idem transactions CSV et bilans PDF), le marqueur de format CSV interne
`'geofinance'`/`'djignan'` (cohérent avec le renommage de `isDjignanFormat`).

**`CLAUDE.md` lui-même** : titre et intro mis à jour, plus les 2 références à
`importGeoFinanceCsvRows` dans le texte (function réellement renommée en code). **2 mentions
laissées intactes délibérément** : la citation de l'identité git historique
`GeoFinance <karidja810@gmail.com>` (§ 13 août, fait historique exact — le renommer réécrirait
silencieusement un fait), et une phrase de test datée du 15 août citant "Déverrouiller GeoFinance"
comme résultat observé à l'époque (idem, exactitude historique).

Testé FR→EN de bout en bout : titre d'onglet, écran de choix de langue, logo sur les 2 écrans de
verrouillage et la sidebar (icône 192px, lisible même réduite à 28px), `manifest.json`
(`name`/`short_name`), chargement des 4 PNG + SVG confirmé (`fetch().ok`), traductions FR/EN de
plusieurs chaînes clés (`Bienvenue sur Djignan`, `Déverrouiller Djignan`, écran d'installation,
confirmation de suppression totale). Aucune erreur console.

**Pas encore fait** : renommage du dépôt GitHub et de l'URL d'hébergement (`zaky04.github.io/geofinance`)
— demandé par l'auteur, mais traité comme une étape séparée (voir entrée suivante) car GitHub ne
redirige PAS automatiquement les Pages d'un dépôt renommé (contrairement au dépôt lui-même) : ça casse
l'ancienne URL pour de bon, contrairement à ce qu'on pourrait attendre par analogie avec le
comportement de redirection classique de GitHub.

`CACHE_VERSION` : `v78` → `v79`.

### 16 août 2026 (suite) — Stratégie à 2 dépôts (gratuit / pro) + code d'activation

Suite à la discussion sur le renommage du dépôt GitHub (voir entrée précédente) : l'auteur a choisi la
migration propre plutôt qu'un renommage sec — **deux dépôts distincts désormais**, pas un seul renommé :
- **`geofinance`** (existant, inchangé) : reste la version **gratuite**, toujours sous l'ancienne marque
  GeoFinance, toujours à `zaky04.github.io/geofinance` — aucune interruption pour les utilisateurs déjà
  actifs. Une bannière "cette app a une nouvelle version" y sera ajoutée séparément (pas encore fait),
  SANS toucher au reste du code de ce dépôt (pas de rebranding, pas de nouvelle fonctionnalité).
- **`djignan-finance`** (nouveau, pas encore créé sur GitHub) : la version **pro**, sous la marque
  Djignan, avec le code d'activation ci-dessous. C'est CE dépôt local qui en devient la base.

**Pourquoi Firebase ne casse pas** : le domaine autorisé pour Firebase Auth est `zaky04.github.io` (le
nom d'hôte seul, voir §"Config Firebase" plus haut) — GitHub Pages sert tous les dépôts d'un même
compte sous ce même nom d'hôte, seul le chemin change (`/geofinance/` vs `/djignan-finance/`). Le
projet Firebase, `authDomain`/`projectId`/`storageBucket` et les règles Firestore (basées sur l'UID,
pas le domaine) restent valides sans aucun changement pour la nouvelle URL.

**Code d'activation** (nouveau `js/activation-config.js`) : l'auteur veut réserver la version pro à des
personnes choisies, à qui il donnera un code. **Ce n'est pas une sécurité réelle** — le hash de
référence est visible dans le code source livré au navigateur, donc en théorie retrouvable par une
personne déterminée à lire le JS (view-source). C'est un filtre de distribution pratique (savoir qui a
reçu le code), explicitement accepté comme tel par l'auteur après explication, pas une protection
cryptographique contre un accès non autorisé — cohérent avec l'architecture 100% cliente de l'appli
(aucun serveur pour valider quoi que ce soit).

- Écran `#activation-screen` (`index.html`), affiché AVANT même le choix de la langue, sur une toute
  première installation uniquement (`!isPinConfigured()`, même garde que
  `showLanguageChoiceScreen()`) et seulement si `REQUIRE_ACTIVATION_CODE` est actif. Libellés bilingues
  en dur (pas de `data-i18n`) — même raison que l'écran de langue : la langue n'est pas encore choisie
  à ce stade.
- Vérification par hash SHA-256 (`crypto.subtle.digest`, natif navigateur, aucune dépendance) : le code
  saisi est normalisé (`trim().toUpperCase()`) puis haché et comparé à `ACTIVATION_CODE_HASH`. Bonne
  saisie → `setSetting('activated', true)` (persiste, jamais redemandé sur cet appareil) puis enchaîne
  sur le choix de la langue. Mauvaise saisie → message d'erreur bilingue, champ vidé, ressaisie
  possible sans limite (pas de throttle anti-bruteforce type PIN — inutile pour un simple filtre de
  distribution, pas une vraie barrière de sécurité).
- `js/activation-config.js` est le SEUL fichier qui divergera entre les deux dépôts : ici (pro),
  `REQUIRE_ACTIVATION_CODE = true` + le hash réel. Dans le dépôt gratuit, une copie séparée du fichier
  avec `REQUIRE_ACTIVATION_CODE = false` et un hash vide — tout le reste du code reste partagé/commun.
- **Le code en clair n'est écrit NULLE PART dans ce dépôt** (ni ici, ni dans le code, ni dans l'historique
  git) — seul son hash SHA-256 est committé. Généré aléatoirement (10 caractères, alphabet excluant les
  caractères ambigus 0/O/1/I/L, formaté en `XXXXX-XXXXX`) et communiqué à l'auteur uniquement via le
  chat de cette session — à lui de le distribuer et de le conserver en lieu sûr : s'il le perd, il
  faudra en régénérer un nouveau (donc republier `ACTIVATION_CODE_HASH`) puisqu'aucune copie en clair
  n'existe ailleurs.

Testé de bout en bout (config temporairement activée le temps du test, remise à l'état définitif
`true`+hash réel juste après puisque CE dépôt est bien la version pro) : mauvais code → erreur affichée,
champ vidé ; bon code saisi en minuscules → accepté (confirme la normalisation `toUpperCase()`),
`activated` persisté, enchaîne correctement sur l'écran de langue puis la création du PIN ; rechargement
après PIN configuré → écrans d'activation ET de langue tous deux sautés, va directement à l'écran de
déverrouillage. Aucune erreur console.

Suite (voir entrée du 16 août ci-dessous) : le dépôt `djignan-finance` a bien été créé et poussé, la
bannière ajoutée au dépôt `geofinance` (branche `free-migration-banner`, basée sur `b6fcf93` comme prévu).

`CACHE_VERSION` : `v79` → `v80`.

### 16 août 2026 (suite) — Migration guidée GeoFinance → Djignan (pont de sauvegarde, écran de restauration)

Signalé par l'auteur : "la connexion Google pour restaurer les données ne marche pas" sur Djignan.
Investigation en direct sur `https://zaky04.github.io/djignan-finance/` (Browser pane) : CSP et
`firebase-config.js` confirmés intacts après le rebranding (seuls les commentaires d'en-tête avaient
changé) ; clic réel sur "Se connecter avec Google" → navigation correcte vers un écran de connexion
Google valide (`accounts.google.com`, client_id et `redirect_uri` corrects), aucune erreur CSP ni
domaine non autorisé. **La connexion elle-même n'a jamais été cassée.**

Le vrai problème, clarifié avec l'auteur après ce constat : sur PC, les données de GeoFinance
apparaissent automatiquement dans Djignan sans la moindre action — pas une vraie restauration, mais le
fait que les deux dépôts sont servis sous le même hôte GitHub Pages (`zaky04.github.io`, chemins
différents seulement) et donc partagent la même IndexedDB (`geofinance-db`, volontairement conservé au
rebranding, voir § 16 août plus haut) : le stockage navigateur est partitionné par **origine**, pas par
chemin. **Sur iPhone, rien n'est partagé** : iOS donne à chaque PWA "Ajoutée à l'écran d'accueil" un bac
à sable de stockage totalement isolé PAR APP, même si les deux pointent vers la même origine — limite de
plateforme WebKit, aucun contournement possible côté code. C'est ce qui obligeait l'auteur à tout
reconfigurer à la main sur mobile.

Demande de l'auteur suite à cette explication : obliger une sauvegarde (locale prioritaire, ou cloud)
avant de basculer, puis la restaurer automatiquement à l'installation de Djignan. **Nuance communiquée à
l'auteur** : "tous les paramètres" ne peut pas inclure le code PIN par conception —
`DEVICE_LOCAL_SETTING_KEYS` (`db.js`) exclut délibérément `pinHash`/`pinSalt`/les identifiants
biométriques de tout export/import (voir le correctif de sécurité du 13 août : un fichier de sauvegarde
ne doit jamais pouvoir poser un PIN sur un nouvel appareil). Un nouveau PIN reste donc toujours à créer
sur Djignan après restauration — seul geste manuel qui subsiste, voulu.

**Côté `djignan-finance` (ce dépôt, `main`)** — nouvel écran affiché après le choix de la langue, avant
la création du PIN, sur une toute première installation (`showRestoreScreenIfNeeded()`, `app.js`,
nouveau `#restore-screen` dans `index.html`, calqué sur `#activation-screen`/`#language-screen`) :
- **Importer une sauvegarde locale** (prioritaire) — réutilise directement `importEncryptedBackup()`
  (`backup.js`, déjà exporté), `merge: false` (installation neuve, rien à fusionner).
- **Restaurer depuis le cloud (Google)** — réutilise `signInWithGoogle()`/`pullBackupFromCloud()`
  (`firebase-sync.js`, déjà exportées). Gère le retour d'une redirection Google
  (`signInWithRedirect`, mobile/PWA installée) : `boot()` repart de zéro après la navigation de retour,
  retombe forcément sur cet écran (PIN toujours pas créé) — un flag `cloudRedirectPending` déjà existant
  est détecté en tout début d'écran pour enchaîner directement sur la demande de mot de passe, sans
  re-proposer les 3 choix depuis le début.
- **Configurer un nouveau compte** — comportement actuel inchangé (onboarding normal).
- Petit refactor de dédoublonnage en passant : `resolveCloudUser()` (nouvelle export,
  `firebase-sync.js`) regroupe la séquence `ensureFirebase()` + `handlePendingRedirect()` +
  `waitForAuthReady()`, déjà dupliquée 2 fois (`renderCloudBackupSection()`, `checkCloudStaleness()`) —
  les deux l'utilisent maintenant, plus le nouvel écran.
- `showLanguageChoiceScreen()` gagne une garde `!(await getSetting('language'))` : ce nouvel écran rend
  le rechargement de `boot()` avant PIN réellement atteignable en pratique (retour de redirection
  Google) — sans la garde, la langue aurait été redemandée à chaque retour.

**Côté `geofinance` (branche `free-migration-banner`, dépôt `origin`, PAS de rebase sur `main`)** —
`renderMigrationBanner()` (`app.js`) : le simple lien "La découvrir" devient un bouton "Sauvegarder puis
découvrir Djignan" qui demande un mot de passe, appelle `exportEncryptedBackup()` (déjà exporté,
`backup.js`), puis ouvre `djignan-finance` dans un nouvel onglet une fois l'export réellement terminé
(jamais "à vide"). Lien discret "J'ai déjà une sauvegarde" pour qui utilise déjà la sauvegarde cloud —
pas besoin de repasser par l'export local, juste se reconnecter avec le même compte Google sur Djignan.

Testé de bout en bout dans le navigateur (Browser pane, IndexedDB/SW/caches vidés avant chaque scénario) :
- **Import local** : sauvegarde chiffrée générée (`buildEncryptedPayload`, données de démo — 3
  portefeuilles/19 transactions), IndexedDB videe pour simuler une installation neuve, fichier assigné à
  l'`<input type="file">` via `DataTransfer` (le vrai sélecteur de fichier OS n'est pas pilotable par
  l'automatisation). Mauvais mot de passe → message d'erreur affiché, ressaisie possible sans plantage ;
  bon mot de passe → les 3 portefeuilles/19 transactions restaurés à l'identique, `pinHash` absent
  (confirmé exclu comme prévu), écran passe correctement à la création du PIN ; PIN créé puis
  déverrouillage réel → tableau de bord affiche les vraies données restaurées (patrimoine net 823 500 F
  CFA, budget "Loisirs" à 86%, cohérent avec le jeu de données de démo documenté ailleurs dans ce
  fichier).
- **Cloud** : clic réel sur "Restaurer depuis le cloud" → navigation réelle vers `accounts.google.com`
  confirmée (comme le test initial de diagnostic), aucune tentative de connexion réelle effectuée (hors
  de portée d'une session automatisée). Retour simulé sur l'app (sans connexion complétée) → détecté
  `cloudRedirectPending`, tente `resolveCloudUser()`, aucun utilisateur trouvé (normal, rien n'a été
  complété) → repli propre sur l'écran de choix initial, langue non re-demandée (garde vérifiée), aucune
  erreur console.
- **Bannière GeoFinance** : clic sur "Sauvegarder puis découvrir Djignan" → formulaire de mot de passe,
  export réellement déclenché (`lastBackupAt` mis à jour, confirmant `markBackupDone()` exécuté),
  `window.open` appelé avec la bonne URL Djignan seulement après l'export terminé.
- `test/ledger.test.html` : 24/24 assertions toujours vertes (aucun changement direct à `ledger.js`,
  vérifié par habitude).

Commits séparés sur chaque dépôt/branche (`main` pour `djignan-finance`, `free-migration-banner` pour
`geofinance`), pas encore poussés — en attente de confirmation de l'auteur comme pour tout push cette
session.

`CACHE_VERSION` (`djignan-finance`, `main`) : `v80` → `v81`. `CACHE_VERSION` (`geofinance`,
`free-migration-banner`) : `v78` → `v79`.

### 23-24 août 2026 — Investissements liés aux portefeuilles (achat, apport, dividende, retrait)

Demande de l'auteur : un achat d'investissement doit débiter un portefeuille, un apport/dividende/
retrait doit débiter/créditer un portefeuille — jamais traité comme une dépense/recette
discrétionnaire (même logique que les dettes/créances, §6 du 13 août).

**DB** : `walletId` ajouté sur `Investment` (portefeuille de l'achat initial, informatif — ne
verrouille rien pour la suite, chaque apport/dividende/retrait choisit librement son propre
portefeuille) et sur `InvestmentEntry` (apport/dividende/retrait). Aucune migration `DB_VERSION`
nécessaire (IndexedDB sans schéma).
**Logique** (`ledger.js`) : nouveau champ `investmentMovementType` sur les transactions liées
(`purchase`/`contribution`/`dividend`/`withdrawal`), consommé par un helper unique
`isInvestmentMovementExcluded(t)` qui remplace toutes les vérifications `investmentId` dispersées —
achat/apport/retrait exclus des agrégats de dépenses/revenus (transfert de capital), mais un
**dividende reste compté en revenu** (contrairement à `debtId`, exclu symétriquement des deux côtés :
un prêt reçu n'est pas un revenu, un dividende si).
**UI** (`investments.js`) : sélecteur de portefeuille pour achat/apport/dividende/retrait, avec
**répartition sur plusieurs portefeuilles** en une seule saisie (même principe que le mode scindé par
catégorie de `transactions.js`, mais scindé par portefeuille — chaque ligne devient sa propre
transaction, toutes partageant un `splitGroupId`). Suppression en cascade (investissement ou entrée)
déjà couverte par un simple filtre sur `investmentId`/`investmentEntryId`.
**Apports récurrents (DCA)** (`budgets.js`) : réutilise entièrement le moteur `STORES.RECURRING`/
`generateDueRecurring()` existant plutôt qu'un système parallèle — troisième option "Apport
investissement" dans le formulaire de récurrence.
**Alerte de dérive d'allocation** : seuil configurable (défaut 70%), panneau "Comparatif de rendement
par classe d'actif".
**Rapports** : section "Investissements" dans les bilans PDF mensuel/annuel (nouvelle
`computeInvestmentEntryTotals()` dans `ledger.js`), export CSV dédié (`exportInvestmentEntriesCsv()`,
`backup.js`).
**Notifications** : rappel après 30 jours de pause d'une récurrence DCA, et après 90 jours sans
réévaluation d'un investissement (`investmentValueAsOf()` retombe silencieusement sur le capital
investi sans entrée `valuation` récente — même logique que l'alerte de taux de change non confirmé).

**Revue de bugs + sécurité avant push** (3 agents indépendants + revue de sécurité dédiée), **7
problèmes trouvés et corrigés** :
1. **XSS stocké** dans la bannière d'alerte d'allocation — le nom de classe d'actif n'était pas
   échappé (contrairement à la cellule du tableau juste à côté), exploitable via un fichier de
   sauvegarde trafiqué (`sanitizeImportedRow()` ne valide aucun champ texte à l'import).
2. Alerte d'allocation **permanente** pour un portefeuille à une seule classe d'actif (100% > tout
   seuil).
3. Alerte calculée sur l'**onglet filtré** (Actifs financiers/Biens physiques) au lieu du portefeuille
   entier, tout en prétendant le décrire.
4. Sélecteur d'investissement du formulaire de récurrence **sans option vide** → le navigateur
   présélectionnait silencieusement le premier investissement, rendant la validation inopérante — un
   apport automatique récurrent pouvait se lier au mauvais investissement, indéfiniment.
5. `computeInvestmentEntryTotals()` traitait une entrée orpheline (investissement supprimé) comme si
   son montant était déjà en devise de base.
6. Le PDF affichait "Aucun investissement suivi" dès que les totaux du mois étaient à zéro, même
   quand un investissement existait réellement (valeur nette à 0, ou simplement pas de mouvement ce
   mois précis).
7. **Le plus sérieux** : supprimer un investissement ne désactivait pas sa récurrence DCA liée — elle
   restait active et continuait à débiter le portefeuille indéfiniment à chaque déverrouillage,
   créant des entrées orphelines invisibles nulle part dans l'UI. Corrigé par suppression en cascade
   (`investments.js`) + filet de sécurité dans `generateDueRecurring()` pour toute récurrence
   orpheline restante (fusion/restauration future).

Tous les correctifs vérifiés en conditions réelles (clics/imports simulés, pas seulement en logique) ;
`test/ledger.test.html` 24/24 après chaque lot de changements.

`CACHE_VERSION` : `v91` → `v95` (plusieurs lots successifs le même jour).

### 11 septembre 2026 — Sauvegarde cloud bloquée : limite de taille par REQUÊTE (pas par document)

Signalé par l'auteur (capture d'écran, Paramètres) : `Erreur : Request payload size exceeds the
limit: 11534336 bytes` — la sauvegarde cloud, qui fonctionnait auparavant, échouait systématiquement
depuis plusieurs jours. `11534336` = très exactement **11 Mio**.

**Diagnostic** : le découpage en morceaux (`CHUNK_SIZE`, §6 du 13 août) résout bien la limite
Firestore PAR DOCUMENT (~1 Mo), mais `pushBackupToCloud()` écrivait TOUS les morceaux (plus les
suppressions des anciens) dans un **seul `writeBatch()` atomique** — qui a sa propre limite de
taille totale, tous les documents du lot combinés (~10-11 Mo). La sauvegarde de l'auteur (plusieurs
mois de transactions + justificatifs photo accumulés) a fini par dépasser ce second plafond, jamais
anticipé lors de la conception initiale du découpage en morceaux.

**Fix** (`firebase-sync.js`) : écriture en **plusieurs lots successifs**, chacun borné par
`BATCH_BYTE_BUDGET` (8 Mo, marge confortable sous le plafond observé), au lieu d'un lot géant unique.
Pattern en 3 phases pour ne jamais risquer de sauvegarde à moitié écrite :
1. **Écrit tous les nouveaux morceaux** par lots sous `BATCH_BYTE_BUDGET`, sans toucher au document
   parent (`backups/{uid}`, champ `chunkCount`).
2. **Seulement une fois TOUS les lots de morceaux confirmés écrits**, met à jour `chunkCount` sur le
   document parent — c'est ce champ que `pullBackupFromCloud()` utilise pour savoir combien de
   morceaux lire (`0..chunkCount-1`), jamais au-delà.
3. Nettoie les anciens morceaux devenus superflus (index ≥ nouveau `chunkCount`), par lots de 400
   (limite Firestore de 500 opérations/lot) — purement cosmétique, sans risque pour la sauvegarde
   déjà validée en phase 2.

Grâce à ce séquencement, une coupure réseau en cours de route (ex: lot 2 sur 3) laisse le document
parent pointer vers l'**ancienne sauvegarde complète et valide** — jamais vers une sauvegarde à
moitié écrite. Un nouvel essai repart proprement (les morceaux déjà écrits sont juste réécrits à
l'identique).

**Testé** : logique de répartition en lots vérifiée isolément (script Node reproduisant exactement
l'algorithme du fichier réel, comparé ligne à ligne pour écarter toute divergence) — un payload de
taille comparable au bug original (~13 Mo) se répartit bien sur plusieurs lots sous
`BATCH_BYTE_BUDGET`, tous les morceaux écrits exactement une fois dans le bon ordre, et un échec
simulé sur un lot intermédiaire empêche bien d'atteindre la phase 2 (pointeur jamais mis à jour vers
une sauvegarde incomplète). `firebase-sync.js` vérifié syntaxiquement valide et chargeable sans
erreur ; `test/ledger.test.html` 24/24 (fichier non concerné, vérifié par habitude). Le round-trip
complet avec un vrai compte Google/Firestore reste à confirmer par l'auteur (hors de portée d'une
session automatisée, comme pour le reste des fonctionnalités Firebase de ce projet) — mais l'auteur
peut maintenant réessayer "Sauvegarder maintenant" directement.

`CACHE_VERSION` : `v95` → `v96`.

### 16 septembre 2026 — Trois bugs de calcul causant une dérive lente du solde vs la réalité

Signalé par l'auteur : après plusieurs mois d'usage, malgré "tout enregistré", le solde de l'app
finit par diverger du solde réel et nécessite un redressement manuel périodique. Recherche ciblée
sur tout ce qui touche au calcul de solde (`walletBalancesAsOf` lui-même s'est révélé correct — il
ne filtre par aucun champ ajouté depuis, dettes/investissements/partage inclus). Trois bugs distincts
trouvés et corrigés, chacun capable de créer une dérive silencieuse et cumulative sur plusieurs mois :

**1. `advanceDate()` (`budgets.js`) — récurrences ancrées en fin de mois qui sautaient des
occurrences.** `setMonth()`/`setFullYear()` débordent silencieusement sur le mois suivant quand le
jour d'origine (29/30/31) n'existe pas dans le mois cible : une récurrence mensuelle posée le 31
janvier donnait le 3 mars au lieu du 28 février — **février était intégralement sauté**, puis le
jour restait décalé en permanence (verrouillé sur "le 3" pour toujours, plus jamais le 31 même les
mois qui en ont un). Pour un loyer/abonnement payé en fin de mois (cas très courant), ça veut dire
une vraie dépense réelle jamais générée dans l'app — exactement le type d'écart silencieux qui
s'accumule sur plusieurs mois avant d'être remarqué. **Fix** : nouveau champ `anchorDay` sur
`RECURRING` (fixé à la création/modification depuis la date choisie, auto-guéri pour les
enregistrements existants à la première génération après mise à jour) ; `advanceDate()` avance
maintenant en mois/année calendaires puis clampe seulement au dernier jour du mois cible si besoin,
en revenant au jour d'ancrage dès que le mois suivant le permet à nouveau (comportement d'une vraie
échéance de facturation, pas de dérive permanente). Testé isolément (script Node reproduisant
l'algorithme) : 14 mois consécutifs à partir du 31 janvier ne sautent ni ne dupliquent aucun mois
calendaire, redescendent à 28/30 sur les mois courts et reviennent à 31 dès que possible ; cas
bissextile (29 février annuel → 28 février une année non bissextile) et passage d'année couverts.

**2. Transfert entre portefeuilles de devises différentes traité comme 1:1 (`transactions.js`).**
`walletBalancesAsOf` applique le même montant brut aux deux côtés d'un virement (`-amt` source,
`+amt` cible, voir `ledger.js`) — sans aucune conversion. Le formulaire de virement listait TOUS
les portefeuilles comme cible potentielle, y compris ceux dans une autre devise que la source :
virer "100" d'un portefeuille EUR vers un portefeuille USD aurait silencieusement créé/détruit de
la valeur (100 EUR ≠ 100 USD), un écart invisible tant que l'utilisateur n'a pas fait le
rapprochement dans chaque devise séparément. Le projet a bien la notion de devises multiples
(`EXCHANGE_RATES`/`EXCHANGE_RATE_HISTORY` existent pour l'agrégation du patrimoine net), donc ce
n'est pas un cas théorique pour un utilisateur multi-devises. **Fix** : la liste "Vers le
portefeuille" ne propose plus que les portefeuilles de la **même devise** que la source, rafraîchie
dynamiquement si la source change ; un virement multi-devises existant (saisi avant ce correctif,
ou dont un portefeuille a changé de devise depuis) reste éditable — sa cible d'origine est ajoutée
explicitement à la liste au lieu d'être masquée, pour ne pas vider silencieusement la sélection à
l'ouverture. Un déplacement de valeur entre devises différentes doit désormais être saisi comme deux
transactions (dépense + recette) avec le montant réellement converti de chaque côté. Vérifié dans le
navigateur (3 portefeuilles créés : 2 EUR + 1 USD — la cible se limite bien aux portefeuilles EUR
quand la source est EUR, "Aucun autre portefeuille dans cette devise" s'affiche correctement quand
aucune cible compatible n'existe).

**3. Modifier une ligne d'une transaction scindée perdait silencieusement `splitGroupId`
(`transactions.js`).** Le formulaire d'édition reconstruit `record` en repartant de zéro puis
`dbPut` **remplace** intégralement l'ancien enregistrement (pas de fusion) — `splitGroupId` n'était
jamais recopié depuis `editTransaction`. Modifier ne serait-ce que la note ou la date d'une ligne
scindée la détachait donc silencieusement de son groupe (label "Scindée" disparu, plus regroupée
nulle part dans l'UI). N'affecte pas directement le calcul du solde (le montant reste inchangé), mais
peut pousser l'utilisateur à ressaisir "la partie manquante" qu'il croit avoir perdue — donc une
dérive indirecte par doublon. **Fix** : `splitGroupId` est maintenant préservé depuis
`editTransaction` lors de la reconstruction du record.

**4. Dédoublonnage à l'import CSV trop agressif (`backup.js`), dette technique connue depuis
l'audit du 12 août (§5) mais jamais corrigée.** `isDuplicateTransaction` ne comparait que
portefeuille + date + type + montant — **jamais la note/description**. Deux dépenses réelles et
distinctes mais de même montant le même jour (ex : deux déjeuners à 15 €) étaient donc silencieusement
fusionnées lors d'un réimport de relevé bancaire sur une période chevauchante : la 2e ligne
disparaissait, sous-comptant les dépenses réelles — le solde de l'app dérive alors au-dessus du
solde bancaire réel, de plus en plus à chaque réimport mensuel. **Fix** : la note est maintenant
incluse dans la comparaison (un vrai doublon réimporté a une description identique — c'est la même
ligne source — alors que deux transactions différentes n'ont presque jamais la même note).

**Vérifié correct, non modifié** :
- `walletBalancesAsOf` (`ledger.js`) lui-même — parcourt tous les types de transactions sans
  filtrage par champ ajouté depuis (dette, investissement, partage), donc aucune catégorie de
  transaction n'est silencieusement exclue du calcul de solde. Pas de solde mis en cache nulle part
  (`w.balance` est toujours recalculé à la volée depuis les transactions, jamais stocké/incrémenté
  — voir `ledger.js:89`) : aucun risque de désynchronisation entre un solde affiché et un solde réel
  recalculé.
- Cascade dette/créance (`debts.js`, suppression + annulation) et cascade investissement
  (`investments.js`, suppression d'entrée/d'investissement) : les transactions liées sont
  retrouvées via `debtId`/`investmentEntryId`/`investmentId` et supprimées en bloc de façon
  symétrique à leur création, sans résidu ni double suppression repérés.
- Fusion de sauvegarde cloud multi-appareils (`firebase-sync.js`, `pullBackupFromCloud`) : pas de
  déduplication par contenu en mode fusion, mais c'est une limitation **déjà documentée et
  assumée** dans le code (commentaire explicite sur l'absence volontaire d'un moteur de résolution
  de conflits) — pas une régression découverte ici, pertinent seulement si l'auteur utilise
  plusieurs appareils avec des saisies non synchronisées.

**Piste identifiée mais NON corrigée — nécessite une décision produit avant d'y toucher :**
**dépenses partagées (`shared.js`) sans mécanisme de règlement.** Quand `paidBy` est un tiers, ma
part (`myShare = montant / nb participants`) est débitée de mon portefeuille **immédiatement à la
création** de la dépense partagée — alors qu'en réalité l'argent ne quitte mon portefeuille que plus
tard, quand je rembourse cette personne. Le solde "Doit recevoir"/"Doit au groupe" affiché
(`computeBalances`) est purement informatif : aucune action "marquer comme réglé" n'existe nulle
part dans l'UI, et le champ `settled` du modèle de données est écrit une fois à `false` puis **jamais
relu ni modifié ailleurs dans tout le code** (`grep` confirmé) — un vestige d'un flux de règlement
qui semble avoir été prévu mais jamais terminé. Concrètement, deux scénarios réels créent une dérive
permanente si l'utilisateur enregistre aussi le mouvement réel correspondant (comportement naturel
pour quelqu'un qui veut "tout enregistrer") :
- **paidBy = moi** (j'avance l'argent pour le groupe) : l'app ne débite que ma part (ex: 25 € sur
  100 € payés), jamais le montant réel sorti de mon portefeuille. Si je saisis ensuite en plus les
  remboursements reçus de mes amis comme des recettes séparées, l'app finit par afficher PLUS
  d'argent que je n'en ai réellement (double comptage du côté recette).
- **paidBy = un tiers** (un ami avance, je lui dois ma part) : l'app me débite ma part *immédiatement*,
  avant même que je l'aie réellement remboursé. Si je saisis ensuite le remboursement réel (cash/mobile
  money) comme une dépense séparée quand je paie vraiment mon ami, l'app me débite **deux fois** la
  même somme — l'app finit par afficher MOINS d'argent que je n'en ai réellement.
Les deux cas sont plausibles pour un usage courant (repas de groupe, loyer partagé, voyage) et
s'accumulent silencieusement sur plusieurs mois. Non corrigé ici car la bonne solution dépend de
l'usage réel de l'auteur (relance-t-il "Partage de dépenses" régulièrement ? attend-il un vrai flux
de règlement avec transaction générée automatiquement, ou juste une clarification du comportement
actuel dans l'UI pour éviter le double comptage ?) — à trancher avec lui avant d'y toucher.

Testé : les quatre fichiers modifiés passent `node --check` sans erreur. Le fix #1 (logique pure,
pas d'UI) vérifié par script Node isolé. Le fix #2 vérifié dans le navigateur (voir ci-dessus, code
d'activation temporairement désactivé en local pour le test puis restauré via `git checkout`, jamais
commité). Les fix #3 et #4 non vérifiés dans le navigateur (changements ciblés à faible risque —
un seul champ préservé pour #3, un critère de comparaison ajouté pour #4) —
`test/ledger.test.html` non concerné (ces bugs sont hors de `ledger.js`, la suite existante ne les
couvre pas).

`CACHE_VERSION` : `v96` → `v97`.

### 16 septembre 2026 (suite) — Vrai flux de règlement pour le partage de dépenses

L'auteur utilise "Partage de dépenses" régulièrement et a demandé, suite à la découverte ci-dessus,
que le reliquat devienne une vraie dette/créance dans le module Dettes & créances plutôt qu'un solde
purement informatif.

**Nouveau modèle** (`shared.js`, en-tête du fichier détaillé) :
- **"Moi" est le payeur** : le **montant total** (pas ma part) est enregistré tout de suite comme
  une vraie dépense personnelle — c'est cet argent-là qui quitte réellement mon portefeuille.
  Chaque AUTRE participant inclus dans la répartition devient une **créance** ("on me doit"), créée
  sans transaction d'ouverture (l'argent a déjà bougé via la dépense totale ci-dessus — une
  transaction d'ouverture en plus aurait doublé le montant compté).
- **"Moi" fait partie de la répartition mais n'est pas le payeur** : rien ne bouge dans mon
  portefeuille tout de suite (je n'ai encore rien payé en réalité) ; ma part devient une **dette**
  ("je dois") envers le payeur, sans transaction ni à la création.
- Le remboursement, dans les deux cas, passe par le flux **existant** de `debts.js`
  (bouton "Rembourser" sur la carte dette/créance) : c'est LÀ qu'une vraie transaction est créée
  (recette si on me rembourse, dépense si je rembourse), pas dans `shared.js`. Ce découpage —
  argent réel enregistré une seule fois, au bon moment — élimine le double comptage identifié dans
  l'entrée précédente.

**`debts.js`** : deux nouvelles fonctions exportées, réutilisables ailleurs et utilisées par
`shared.js` :
- `createLinkedDebt({ type, personName, principal, currency, startDate, note, sharedExpenseId })` —
  crée une dette/créance SANS transaction d'ouverture (`openingTransactionId: null`), pour les cas
  où le mouvement réel est déjà couvert par une transaction créée ailleurs.
- `deleteDebtCascade(debtId)` — extrait de la suppression déjà existante (remboursements + toutes
  les transactions liées, ouverture et remboursements), maintenant réutilisée par le bouton
  "Supprimer" de Dettes & créances ET par la suppression en cascade d'une dépense partagée.
  Nouveau champ `sharedExpenseId` sur `DEBTS` (comme `debtId`/`investmentEntryId` ailleurs) pour
  relier une dette/créance à la dépense partagée qui l'a générée.

**Affichage** : le statut de règlement de chaque dépense partagée (`sharedExpenseRowHtml`) est
calculé EN DIRECT depuis les dettes/créances liées (remboursements déjà faits inclus) — pas stocké
séparément, pour ne jamais pouvoir diverger si une dette est réglée ou supprimée directement depuis
Dettes & créances. Pour la même raison, la ligne "Moi" du panneau "Soldes" n'affiche plus un solde
brut calculé sur toutes les dépenses (qui ignorait les remboursements, donc redevenait trompeur dès
le premier règlement partiel) mais un simple renvoi "→ voir Dettes & créances", où le reliquat exact
et à jour se lit sur chaque dette/créance individuelle. Les autres participants (pas "Moi") gardent
l'ancien solde informatif agrégé — l'app ne suit pas leurs vrais portefeuilles, donc pas de
remboursement réel à soustraire pour eux.

**Suppression en cascade** : supprimer une dépense partagée retire aussi sa transaction personnelle
liée (ancien style, `myTransactionId`) ET toutes les dettes/créances qu'elle a générées, avec leurs
remboursements et transactions liées — via `deleteDebtCascade` pour chacune. "Annuler" restaure tout
symétriquement (dépense, transaction, dettes, remboursements).

**Compatibilité** : les dépenses partagées créées AVANT ce changement gardent leur ancien
comportement figé (transaction "ma part" seule, `myTransactionId`) — rien n'est migré
rétroactivement, mais leur suppression reste gérée correctement par l'ancien chemin (toujours
présent dans le handler de suppression).

**Non traité, tradeoff assumé** : le montant total payé (ex: 100 € restaurant) reste catégorisé
intégralement dans le budget de la catégorie choisie (ex: "Restaurant"), même si seule "ma part" en
est le coût réel final — le remboursement reçu plus tard est exclu des agrégats budgétaires (comme
tout mouvement `debtId`, cohérent avec le reste de l'app) donc ne vient jamais réduire ce total a
posteriori. Accepté comme tradeoff raisonnable : la priorité de cette demande était l'exactitude du
**solde**, pas l'attribution budgétaire par catégorie.

Testé dans le navigateur de bout en bout (3 participants, Moi/Boubacar/Awa) : dépense payée par
"Moi" → transaction du montant TOTAL (pas la part) débitée du bon portefeuille + 2 créances créées ;
dépense payée par un tiers avec "Moi" dans la répartition → 1 dette créée, AUCUNE transaction
fantôme ; remboursement partiel d'une créance depuis Dettes & créances → transaction de recette
créée, solde du portefeuille mis à jour correctement, badge de statut recalculé ; suppression d'une
dépense partagée avec dette liée → la dette disparaît bien de Dettes & créances, les dettes/créances
des AUTRES dépenses restent intactes. Aucune erreur console à aucune étape.

`CACHE_VERSION` : `v97` → `v98`.

### 16 septembre 2026 (suite 2) — Audit du stockage et filet de sécurité anti-corruption

Demande explicite de l'auteur après les deux passes précédentes : creuser encore, explorer la
couche de stockage (`db.js`) et toute la logique, "aucune erreur n'est tolérée". Quatre choses
trouvées et corrigées, une limitation architecturale identifiée et partiellement compensée.

**1. `computeDailySpending` (`ledger.js`) — seule fonction d'agrégation du fichier à ne pas exclure
les mouvements d'investissement.** Toutes les autres (`computeMonthSummary`,
`computeBudgetVsActual`, `computeExpensesByCategory`...) excluent `isInvestmentMovementExcluded(t)`
en plus de `t.debtId` — celle-ci (vue calendrier de Rapports) ne filtrait que `debtId`. Un achat/
apport d'investissement gonflait donc la vue calendrier alors que le total "Dépenses" du même mois,
affiché ailleurs, l'exclut déjà : la somme des jours du calendrier ne correspondait plus au total du
résumé mensuel. **Fix** : ajout du même filtre que partout ailleurs.

**2. `investmentValueAsOf` (`ledger.js`) — un apport après la création sans nouvelle valorisation
faisait apparaître une perte fictive.** Tant qu'aucune entrée `type: 'valuation'` n'a été saisie, la
fonction retombait sur `investment.capitalInvested` (le capital **initial**, figé à la création) —
jamais mis à jour par les apports ultérieurs (`computeMetrics()`, investments.js, calcule lui
correctement `capitalInvested + contributions - retraits` pour "Capital net investi", mais
`investmentValueAsOf` divergeait de ce calcul). Concrètement : investissement créé à 1000, apport de
500 plus tard (transaction réelle, portefeuille bien débité) → "Valeur actuelle" restait à 1000,
"Plus/moins-value" affichait -500 € de perte immédiate et injustifiée, et le patrimoine net total
semblait avoir perdu 500 € qui pourtant n'avaient fait que changer de forme (liquide → investi).
Vérifié par script isolé : avant le fix, apport de 500 → valeur actuelle 1000 (perte apparente
-500) ; après le fix → valeur actuelle 1500 (gain 0, correct) ; comportement avec valorisation
postérieure et avec cutoffDate antérieur à l'apport tous deux inchangés (non-régression confirmée).
**Fix** : à défaut de valorisation, reconstruit le capital NET investi à la date donnée (capital
initial + apports - retraits jusqu'à cutoffDate) au lieu du capital initial seul.

**3. Filet de sécurité `Infinity`/`NaN` à chaque point de saisie d'un montant.** `db.js` protège
déjà les imports de sauvegarde contre `Infinity`/`NaN` (`sanitizeImportedRow`, avec le commentaire
explicite : `Number(x) || 0` ne filtre PAS `Infinity`, qui est "truthy") — mais ~20 points de saisie
normale (transactions, dettes, investissements, épargne, comptes gardés, dépenses partagées, taux de
change, seuil de solde bas) utilisaient exactement cet idiome non protégé (`parseFloat(...) || 0`).
Un montant tapé en notation scientifique qui déborde (ex: `1e400`) aurait produit `Infinity`,
propagé tel quel dans `walletBalancesAsOf` et toute conversion de devise en aval — un seul
portefeuille ou taux de change contaminé aurait fait afficher "Infinity"/"NaN" partout où il
intervient. **Vérifié à l'usage** : un `<input type="number">` standard refuse déjà nativement
`1e400` comme valeur (testé dans le navigateur — la valeur reste vide), donc ce vecteur précis
n'était pas exploitable via l'UI normale d'un navigateur moderne compatible. Le correctif
(`safeNumber(parseFloat(...))`, réutilisant l'utilitaire existant plutôt que juste `|| 0`, à chaque
site identifié dans `budgets.js`/`debts.js`/`investments.js`/`kept-accounts.js`/`savings.js`/
`shared.js`/`transactions.js`/`wallets.js`) reste appliqué par prudence : défense en profondeur pour
tout environnement moins strict (ancien WebView Android packagé en APK, navigateur non conforme) et
cohérence avec le traitement déjà appliqué aux imports.

**4. Écritures multi-stores non atomiques (`db.js`).** Chaque `dbAdd`/`dbPut`/`dbDelete` "isolé"
ouvre SA PROPRE transaction IndexedDB. Un enchaînement de plusieurs appels séparés pour une seule
opération logique (ex: un remboursement de dette = ligne `DEBT_PAYMENTS` + transaction de
portefeuille + parfois passage de la dette à "soldée", trois écritures dans `openPaymentModal`)
pouvait laisser un état partiellement écrit si l'onglet/l'appareil meurt exactement entre deux
appels (fermeture forcée, coupure de courant, l'OS qui tue l'onglet en arrière-plan sur mobile) — la
dette paraîtrait remboursée sans que l'argent n'ait bougé. Improbable par occurrence (fenêtre de
quelques millisecondes), mais jamais acceptable pour un solde financier selon le principe posé pour
cette passe. **Fix** : nouvelle fonction `dbWriteBatch(operations)` (db.js) qui regroupe plusieurs
écritures (add/put/delete, un ou plusieurs stores) dans une seule transaction IndexedDB — soit
toutes appliquées, soit aucune. Appliquée aux deux chemins les plus fréquents/à plus fort enjeu :
`openPaymentModal` (debts.js, remboursement) et `deleteDebtCascade` (debts.js, réutilisée par la
suppression directe ET par la suppression en cascade d'une dépense partagée). Vérifié dans le
navigateur : remboursement d'une créance de 10 € faisant passer la dette à "soldée" (donc les 3
écritures du lot) → dette bien déplacée en "Soldées", transaction de recette bien créée, aucune
erreur console.

**Non traité, limitation documentée, pas une régression :**
- Les AUTRES chemins d'écriture multi-stores (création de dépense partagée avec plusieurs créances,
  génération de récurrence investissement, mode scindé de transactions.js) restent non atomiques —
  moins prioritaires : leur pire scénario d'interruption laisse le portefeuille correct (l'argent
  déjà comptabilisé) avec au pire une créance/ligne manquante à rajouter à la main, pas une dette
  faussement soldée. À généraliser avec `dbWriteBatch` dans une passe future si souhaité.
- Pas de `db.onversionchange` (fermeture propre de la connexion quand un autre onglet a besoin de
  monter la base en version supérieure après un déploiement) : un onglet resté ouvert pourrait bloquer
  la mise à niveau d'un autre onglet/appareil du même utilisateur (juste un blocage/gel, pas une
  corruption de données — `onblocked` existe déjà et logue en console). Pas corrigé ici, risque
  UX/fiabilité mineur pour un usage multi-onglets rare, pas un risque financier.

**Vérifié correct, non modifié** : le reste de `db.js` (schéma additif uniquement depuis `DB_VERSION
4`, pas de migration structurelle nécessitant une réécriture d'index) ; `savings.js` et
`kept-accounts.js` — tous deux entièrement décorrélés de `ledger.js`/des portefeuilles par design
(confirmé par lecture complète), donc structurellement incapables de créer une dérive de solde ;
`convertAmount`/la convention `rateToBase` (`utils.js`) et son édition (`wallets.js`, saisie manuelle
et récupération live) — cohérents et corrects, aucune inversion de taux repérée.

Testé : les 13 fichiers touchés dans cette passe passent `node --check`. Vérifié dans le navigateur :
protection Infinity (native au navigateur + filet applicatif), remboursement atomique menant une
dette à "soldée", entrée normale toujours fonctionnelle après le filet de sécurité — aucune erreur
console à aucune étape.

`CACHE_VERSION` : `v98` → `v99`.

### 16 septembre 2026 (suite 3) — Audit élargi bugs/crashs sur le reste de l'app

Demande explicite de l'auteur : élargir la recherche au-delà des calculs financiers, y compris les
petits bugs/incohérences, sur tout ce qui n'avait pas encore été lu en profondeur —
`app.js` (bootstrap/routeur), `auth.js` (PIN/biométrie), `dashboard.js`, `charts.js`,
`reports.js`/`reports-extras.js`, `search.js`, `settings.js`, `notifications.js`, `utils.js`,
`state.js`, `tools.js`, `install-prompt.js`. Deux bugs réels trouvés et corrigés :

1. **Crash confirmé dans la recherche globale** (`search.js`). `index` (le résultat de
   `collectSearchIndex()`, 8 lectures IndexedDB en parallèle — potentiellement lent sur un historique
   de plusieurs milliers de transactions depuis que son plafond de 500 a été retiré, voir lot 13 de
   l'internationalisation) démarre à `null` et n'est peuplé qu'une fois la promesse résolue, mais les
   écouteurs de saisie sont câblés immédiatement à l'ouverture de la modale. Taper vite juste après
   avoir ouvert la recherche (Ctrl/Cmd+K, un geste très naturel) avant que l'index soit prêt
   déclenchait `index.filter(...)` sur `null` → reproduit et confirmé isolément :
   `TypeError: Cannot read properties of null (reading 'filter')`, non rattrapée (le handler `input`
   n'a pas de try/catch), cassant la recherche pour ce cycle de rendu. **Fix** : garde `if (!index)
   return;` dans `runSearch()`, et le `.then()` qui peuple `index` relance `runSearch()` une fois
   prêt — la requête déjà tapée n'est donc pas perdue, juste retardée.

2. **Incohérence dans le calendrier des dépenses** (`reports-extras.js`). Le total/l'intensité de
   chaque case du calendrier (`computeDailySpending`, `ledger.js`) exclut déjà les mouvements de
   dette/créance et d'investissement, comme tous les autres agrégats du fichier — mais cliquer sur
   une case pour afficher le détail du jour (`wireCalendarPanel`) ne filtrait que par
   `type === 'expense'`, sans exclure ces mêmes mouvements. Concrètement : un remboursement de dette
   apparaissait dans la liste comme une dépense ordinaire, et la somme des lignes affichées ne
   correspondait plus au total déjà affiché sur la case cliquée. **Fix** : `isInvestmentMovementExcluded`
   (`ledger.js`) exportée (elle ne l'était pas), réutilisée dans `wireCalendarPanel` avec le même
   filtre `!t.debtId` que `computeDailySpending`.

**Vérifié, pas de bug retenu** :
- `signInWithGoogle()` (`firebase-sync.js`) : `pendingSignIn` (état module partagé entre appels) est
  écrasé sans garde si la fonction est appelée deux fois en concurrence — orpheline la première
  promesse. Non exploitable actuellement : les deux points d'appel (`app.js` écran de restauration,
  `settings.js` section cloud) désactivent/remplacent synchroniquement l'élément déclencheur avant
  l'appel, empêchant un double-clic d'atteindre ce chemin. Noté comme fragile pour un futur 3e point
  d'appel qui n'aurait pas la même discipline, pas corrigé (rien à corriger sans un vrai symptôme).
- `changePin()` (`settings.js`) sans limite anti-brute-force sur les tentatives d'ancien PIN — déjà
  connu (dette technique du dépôt `geofinance`, jamais portée ici faute d'avoir été redemandée),
  faible sévérité (nécessite déjà un accès physique à l'appareil déverrouillé).
- `auth.js`, `charts.js`, `utils.js` (`openModal`/`confirmDialog`/formatage), `state.js` (bus
  d'événements), `dashboard.js`, `tools.js`, `install-prompt.js`, `notifications.js` : lus en entier,
  rien trouvé — déjà bien durcis par les correctifs de sessions précédentes (gardes null
  systématiques, verrous anti-concurrence documentés, filets try/catch explicites).

Testé : les 3 fichiers modifiés passent `node --check`. Le crash de `search.js` reproduit et
confirmé par un script Node isolé avant correction (`TypeError` confirmée sur le code du bug, absent
après le fix). L'incohérence du calendrier n'a pas pu être revérifiée dans le navigateur cette
session (nécessite des transactions liées à une dette/un investissement sur le mois courant, pas de
jeu de données de test adapté sous la main) — changement ciblé et à faible risque (un filtre
supplémentaire, déjà utilisé ailleurs dans le même fichier `ledger.js`).

`CACHE_VERSION` : `v99` → `v100`.

### 16 septembre 2026 (suite 4) — Revue ciblée de `firebase-sync.js` + bug trouvé dans `ocr.js`

Demande de l'auteur : revue de `firebase-sync.js`, avec une prudence explicite vu l'historique de
soucis passés sur ce fichier précis. Lecture complète (741 lignes) croisée avec tout l'historique
ci-dessus (découpage en lots §11 sept, horloge serveur/répit §15 août, etc.) — **rien touché dans ce
fichier** : les deux cas limites identifiés (morceau Firestore manquant → `TypeError` au lieu d'un
message propre, mais déjà rattrapé par le `try/catch` de chaque appelant ; absence de verrou
distribué entre appareils, limitation déjà documentée et assumée depuis la conception) ne
justifiaient pas un changement risqué sur un fichier aussi sensible sans bug reproductible.

Poursuite sur les fichiers encore jamais audités en profondeur (`ocr.js`, `i18n.js`, `demo-data.js`,
`sw-register.js`) — **1 bug réel trouvé et corrigé** :

**`ensureTesseractScript()` (`ocr.js`) mettait en cache une promesse rejetée pour toujours.** La
promesse de chargement de `vendor/tesseract.min.js` est mémorisée dans une variable de module
(`scriptLoadPromise`) pour éviter de réinjecter le `<script>` à chaque scan de justificatif — mais en
cas d'échec (Service Worker pas encore fini de précacher le vendor au tout premier lancement, réseau
capricieux), la promesse **rejetée** restait en cache indéfiniment : toute tentative d'OCR suivante,
même après que la cause transitoire ait disparu, échouait instantanément avec la même erreur, sans
jamais retenter le chargement — jusqu'à un rechargement complet de la page. → Le `.catch()` ajouté
réinitialise `scriptLoadPromise = null` avant de repropager l'erreur, pour qu'un appel suivant
retente réellement le chargement au lieu de rejouer l'échec en cache.

Testé isolément (script Node reproduisant exactement le motif promesse-mise-en-cache-au-niveau-module
du fichier réel) : un premier appel simulé en échec confirme `scriptLoadPromise` remis à `null`
immédiatement après, puis un second appel (retry) réussit — comportement cassé avant le correctif
(un script de contrôle sans le `.catch()` aurait rejoué l'échec indéfiniment), confirmé corrigé après.
Pas re-testé dans le navigateur avec le vrai worker Tesseract (nécessiterait de simuler un vendor
manquant puis restauré en cours de session, hors de portée pratique) — changement ciblé et à faible
risque (une seule ligne de reset, aucun changement du chemin normal quand le chargement réussit du
premier coup).

`CACHE_VERSION` : `v100` → `v101`.

### 16 septembre 2026 (suite 5) — Section « À propos du développeur » dans Paramètres

Demande de l'auteur : une vraie section avec son nom/email (numéro de téléphone pas encore fourni,
à ajouter plus tard). Avant ce lot, seul un discret lien `mailto:` existait à deux endroits — bas de
la barre latérale (`index.html`) et une ligne centrée en petits caractères en bas de Paramètres
(`settings.js`, `#settings-credit`) — sous le nom « Adtcheko 5T/ ».

→ `settings.js` : `#settings-credit` remplacé par `renderDeveloperSection()`, un vrai panneau
(`.panel`/`.panel-header`, même convention que les autres sections de Paramètres) avec deux
`stat-row` (Nom, Email — lien `mailto:` cliquable). Constantes `DEVELOPER_NAME`/`DEVELOPER_EMAIL` en
tête de fichier, avec un commentaire indiquant où ajouter une ligne Téléphone le jour où l'auteur le
fournit. Nom mis à jour partout (barre latérale comprise) : **Bibiê Adtcheko**, email inchangé
(`ronywest01@gmail.com`). Clé `'Par {author}'` (devenue orpheline, plus utilisée que par l'ancienne
ligne) retirée du dictionnaire ; deux nouvelles clés ajoutées (`'À propos du développeur'`, `'Email'`).

Testé par rendu direct de `renderSettings()` dans le navigateur (le clavier PIN restant peu fiable
aux clics synthétiques, même limite que d'habitude) : panneau correctement affiché en français
(« À propos du développeur » / Nom / Email) puis en anglais (« About the developer » / Name /
Email) après bascule de langue, lien `mailto:` intact dans les deux cas ; crédit de la barre
latérale confirmé mis à jour au nouveau nom.

`CACHE_VERSION` : `v101` → `v102`.

### 16 septembre 2026 (suite 6) — OCR : extraction du commerçant et de la date, pas seulement le montant

Demandé par l'auteur suite à une discussion sur des pistes d'amélioration compétitives (voir aussi
la piste tontine, discutée mais pas encore implémentée) : gain rapide côté saisie, sans nouveau
chantier — Tesseract est déjà en place, seul le parsing du texte OCR était limité au montant.

→ `ocr.js` : `extractAmountFromImage()` devient `extractReceiptDataFromImage()`, renvoie
`{ amount, merchant, date }` (chacun `null` si rien de fiable détecté) au lieu d'un simple nombre.
- `parseMerchantFromText()` : prend la première ligne parmi les 5 premières qui ressemble à un nom
  (majorité de lettres, ≤ 40 caractères) — l'en-tête d'un ticket (nom du commerçant) est presque
  toujours en toute première ligne.
- `parseDateFromText()` : cherche un motif JJ/MM/AAAA (ou `-`/`.`, année sur 2 ou 4 chiffres) — même
  convention JJ/MM que `parseFlexibleDate` (`backup.js`), jamais MM/JJ. Rejette toute date dans le
  futur ou à plus de 2 ans dans le passé (fenêtre plausible pour un ticket de caisse) : un faux
  positif OCR (numéro de ticket/téléphone mal lu comme une date) tombe presque toujours hors de
  cette fenêtre.
- `transactions.js` (Saisie express) : commerçant → champ Note, date → champ Date, mais **seulement
  si le champ est encore à sa valeur par défaut** (note vide, date = aujourd'hui) — contrairement au
  montant (toujours écrasé, le toast invite explicitement à le vérifier), on ne veut jamais effacer
  une saisie que l'utilisateur a déjà faite lui-même. La note préremplie déclenche aussi
  `suggestCategoryFromNote()` (événement `input` envoyé manuellement) — un commerçant reconnu peut
  donc aussi présélectionner la bonne catégorie, bénéfice secondaire gratuit de la même modification.

Testé : logique de parsing vérifiée isolément (script Node, 5 cas dont date invalide `31/02`
correctement ignorée au profit d'une seconde date valide, date future et date de plus de 2 ans
toutes deux rejetées) ; puis **pipeline OCR réel de bout en bout dans le navigateur** (image de
synthèse générée via `<canvas>`, vraie reconnaissance Tesseract) : commerçant et date extraits
correctement du texte OCR réel ; le montant est resté `null` sur ce test précis parce que Tesseract
a mal lu "5500,00" en "5500,080" sur ce rendu synthétique — comportement déjà voulu du parseur de
montant existant (rejette un nombre à 3 décimales plutôt que d'en proposer un faux), pas une
régression introduite ici.

`CACHE_VERSION` : `v102` → `v103`.

### 16 septembre 2026 (suite 7) — 3 améliorations compétitives (Djignan uniquement, pas geofinance-free)

Suite à une discussion sur des pistes pour rendre l'app plus compétitive : une piste plus lourde
(suivi de tontine) discutée puis volontairement écartée pour l'instant (l'auteur a jugé, à raison,
que ça ajouterait un module entier à maintenir pour un besoin pas encore confirmé par de vrais
utilisateurs — mieux vaut attendre une vraie demande). Trois améliorations plus légères retenues à
la place, chacune un calcul pur sur des données déjà chargées ou une petite extension d'un
mécanisme déjà en place — aucun nouvel écran :

1. **« Reste à vivre » quotidien** (`dashboard.js`) — le panneau "Reste à vivre" affiche maintenant
   aussi une ligne secondaire (`#dash-safe-to-spend-daily`) : le montant divisé par les jours
   restants du mois (aujourd'hui inclus), façon Monzo/Cleo. N'apparaît que si le solde est positif
   (un "reste à vivre" négatif divisé en montant/jour n'a pas de sens à afficher, déjà couvert par
   le message d'alerte existant juste en dessous).
2. **Alerte de dépassement prédictive** (`dashboard.js`, `renderAlerts()`) — en plus des alertes
   existantes (déclenchées une fois le seuil de 70%/90% déjà atteint), une nouvelle passe projette
   chaque catégorie encore sous le seuil (`actual ÷ joursÉcoulés × joursDansLeMois`) et prévient
   *avant* le fait si la projection dépasse le budget : *"Au rythme actuel, le budget X sera dépassé
   de {montant} vers le {jour}."* Ignore les 4 premiers jours du mois (projection trop instable sur
   1-4 jours de données, même garde-fou que `checkUnusualExpense` dans `ledger.js`) et les
   catégories déjà signalées par l'alerte de seuil (pas de double alerte sur la même catégorie).
3. **Partage entrant (Web Share Target) → OCR** (`manifest.json`, `sw.js`, `app.js`,
   `transactions.js`) — l'utilisateur peut maintenant partager une photo (capture d'écran d'une
   confirmation Mobile Money, photo de ticket) directement depuis sa galerie/messagerie vers
   Djignan : `manifest.json` déclare `share_target` (`action: "share-target"`, POST,
   `multipart/form-data`, champ `receipt`) ; `sw.js` intercepte ce POST (nouveau bloc au tout début
   du handler `fetch`, avant le cache-first GET existant — aucune interférence, méthodes
   différentes), met le fichier en cache (`SHARE_TARGET_CACHE = 'share-target-cache'`, **nom
   volontairement sans le préfixe `geofinance-`** pour ne jamais être balayé par le nettoyage de
   `activate` qui supprime tout cache `geofinance-*` différent de `CACHE_NAME` à chaque déploiement),
   puis redirige vers `?share-target=1` ; `app.js` (`applyShareTarget()`, même endroit que
   `applyShortcutParams()` dans `boot()`, donc toujours après déverrouillage — la photo n'est jamais
   touchée avant que l'utilisateur ait saisi son PIN) lit le cache, l'efface (usage unique), et
   ouvre Saisie express (`openQuickAdd({ sharedReceiptBlob })`, nouveau paramètre) avec la photo
   injectée dans le vrai `<input type="file">` via `DataTransfer` (réutilise tout le circuit
   existant : aperçu, résolution du `receiptBlob` à l'enregistrement — rien dupliqué) et le scan OCR
   déclenché automatiquement (`receiptScanBtn.click()`) : l'utilisateur retrouve directement montant/
   commerçant/date pré-remplis (bénéficie de l'amélioration OCR de l'entrée précédente). Capitalise
   directement sur l'OCR étendu plutôt que de construire un parseur de SMS séparé (piste plus lourde,
   spécifique Android, mise de côté depuis le 13 août).

**Piège rencontré en testant** : le Service Worker cache-first sert la version précédemment
installée tant que `CACHE_VERSION` n'est pas rebumpé — un premier test après ces changements a
montré l'ancien tableau de bord (sans la ligne quotidienne) malgré les fichiers à jour sur disque,
piège déjà documenté ailleurs dans ce fichier (§11) mais qui vaut la peine d'être rappelé : après un
`unregister()`+vidage des caches en test local, la page rechargée qui a DÉCLENCHÉ l'enregistrement
n'est pas automatiquement "contrôlée" par le nouveau SW (`navigator.serviceWorker.controller` reste
`null` sur ce premier chargement, même une fois le SW `activated` grâce à `clients.claim()`) — il
faut un second rechargement pour que le contrôle prenne effet, sans quoi les appels `fetch()` type
`share-target` ne sont jamais interceptés par le SW.

Testé dans le navigateur (mode démo re-semé + une transaction de test injectée en Alimentation pour
forcer une projection sous le seuil de 70%) : ligne quotidienne calculée correctement (501 000 F CFA
÷ 15 jours restants = 33 400 F CFA/jour, vérifié à la main) et masquée quand non pertinente ; alerte
prédictive déclenchée avec les bons chiffres (Alimentation 38 000/60 000, projection 71 250 →
dépassement de 11 250 F CFA vers le jour 26, vérifié à la main), absente pour une catégorie déjà
signalée par le seuil (Loisirs, 86%) ; les deux traduits correctement en anglais. Partage entrant
testé de bout en bout avec le **vrai** pipeline (POST multipart simulé vers `/share-target`, fichier
confirmé en cache, `openQuickAdd({ sharedReceiptBlob })` appelé directement — aperçu affiché, scan
OCR réel déclenché automatiquement, champs Note/Date/Montant correctement pré-remplis depuis une
image de synthèse). Le vrai geste de partage OS (galerie → "Partager" → Djignan dans la liste) n'a
pas pu être déclenché depuis cette session automatisée (nécessite un vrai geste utilisateur sur un
appareil réel) — le mécanisme sous-jacent (interception SW, cache, lecture au boot, ouverture Saisie
express) est lui entièrement vérifié.

**Pas porté sur `geofinance-free`** — demande explicite de l'auteur limitée à Djignan cette fois.

`CACHE_VERSION` : `v103` → `v104`.

### 12 octobre 2026 — Suggestions de budget d'après les habitudes de dépense (Djignan uniquement)

Demandé par l'auteur après un usage prolongé : que l'app propose un budget par catégorie d'après ses
habitudes réelles, et s'adapte quand elles changent. Faisabilité analysée avant d'écrire du code
(tout existait déjà : `STORES.BUDGETS` au format `{categoryId, month, limit}`, dépenses par catégorie
déjà converties en devise de base), puis deux choix tranchés avec l'auteur : **(1)** deux façons
d'appliquer — remplir seulement les catégories sans budget, OU tout appliquer en remplaçant les
budgets existants ; **(2)** un rappel en début de mois en plus du bouton.

**Calcul** (`ledger.js`, aucun état mémorisé : tout est recalculé à chaque appel, donc l'adaptation
est automatique) :
- `suggestBudgetFromHistory(amounts, floor)` — cœur **pur** (exporté, testable sans base) sur les
  montants mensuels d'UNE catégorie, du plus ancien au plus récent. Moyenne pondérée à décroissance
  exponentielle (demi-vie 2 mois : les mois récents comptent davantage), +5 % de marge, arrondi à
  2 chiffres significatifs (17 340 → 17 000 ; 8 230 → 8 200). Trois garde-fous :
  1. *Pic isolé* (un seul mois > 2× la médiane) → remplacé par la médiane, **avant** toute autre
     analyse (sinon il faussait aussi la détection de changement et la flèche de tendance : un pic
     ancien faisait afficher « en baisse »). Deux mois élevés = nouvelle habitude, jamais neutralisée.
  2. *Changement de régime* : si les 2 derniers mois sont tous deux nettement au-dessus (>+20 %) ou en
     dessous (<−20 %) de la moyenne antérieure, on s'aligne directement dessus au lieu d'attendre que
     la pondération rattrape — sinon un loyer qui monte resterait sous-estimé des mois.
  3. *Catégorie irrégulière* (dépense < 1 mois sur 2) : signalée, décochée par défaut, sans flèche.
- Plancher fixe : récurrences actives de dépense de la catégorie (mensuelles ; hebdomadaires ×52/12 ;
  annuelles ignorées — elles ont leur onglet « Budgets annuels » ; apports d'investissement exclus
  comme partout). Une récurrence sans aucun historique suffit à produire une suggestion.
- `computeBudgetSuggestions(monthKey)` — une seule passe sur les transactions (un seul `ctx()`, pas un
  par mois). Fenêtre : 6 mois COMPLETS avant le mois visé (le mois en cours, partiel, n'est jamais
  compté). Mois antérieurs à la toute première transaction ignorés (ce sont des mois sans historique,
  pas des mois à 0 dépense) ; premier mois d'utilisation ignoré aussi s'il reste ≥ 3 autres mois
  (souvent partiel). < 2 mois utilisables → `insufficient`. Mêmes exclusions que tous les agrégats
  (mouvements de dette et d'investissement). Renvoie aussi le revenu mensuel moyen et les taux de
  change non confirmés (affichés en avertissement dans la modale).

**Interface** (`budgets.js`, `dashboard.js`, aucun nouvel écran) :
- Bouton « Suggérer des budgets » dans l'en-tête de l'onglet Budgets du mois → `openBudgetSuggestions()`
  (exportée) : modale avec, par catégorie, case à cocher, moyenne des 3 derniers mois, budget actuel
  éventuel, montant suggéré **modifiable**, badges « récurrent »/« irrégulier » et flèche ▲/▼ de
  tendance ; total des lignes cochées comparé au revenu moyen (avertissement si dépassé).
  « Remplir les budgets vides » (ne touche jamais un budget déjà saisi) ou « Tout appliquer (remplace
  les budgets existants) ». Écriture **atomique** (`dbWriteBatch`) et **annulable** depuis le toast
  (restaure les anciennes limites / supprime les budgets créés).
- Rappel (`maybeShowBudgetSuggestionReminder`, `dashboard.js`) : si aucun budget n'est défini pour le
  mois en cours et qu'il y a assez d'historique, une alerte « Vos budgets pour {mois} ne sont pas
  encore définis — Voir les suggestions » s'ajoute à la pile du tableau de bord. **Asynchrone, non
  bloquant** (le calcul relit tout l'historique : ne retarde pas le rendu) ; `✕` l'ignore pour le mois
  en cours (`budgetSuggestionDismissedMonth`), elle réapparaît le mois suivant ; le garde
  `data-budget-suggest` évite un doublon si deux rendus se chevauchent.
- En-tête du mois passé en `flex-wrap` (deux boutons côte à côte débordaient à 375 px — leçon déjà
  documentée sur l'en-tête de Transactions).

~21 nouvelles clés i18n (968 clés au total, 0 doublon).

**Testé** : 14 cas du cœur pur en script Node isolé ; **11 nouvelles assertions** dans
`test/ledger.test.html` (6 sur le cœur pur, 5 d'intégration : fenêtre de 6 mois, remboursement de
dette de 9 999 exclu, récurrence active retenue/inactive ignorée, revenu moyen, historique
insuffisant) — **35/35** (24 existantes + 11). Dans le navigateur, sur un historique synthétique de 6
mois : Logement 45→60 k suivi à 63 000 (▲), Loisirs avec un pic de 95 k neutralisé à 21 000 (sans
fausse flèche), Abonnements remonté au plancher de la récurrence (8 000, badge), Santé irrégulière
décochée ; « Remplir les vides » avec un budget Alimentation préexistant à 40 000 → 4 budgets créés,
Alimentation intacte ; annulation → état initial ; « Tout appliquer » → Alimentation à 54 000 ;
annulation → retour à 40 000 ; rappel du tableau de bord affiché, sans doublon sur un second rendu,
persistant à l'ignorer, absent dès qu'un budget existe ; message d'historique insuffisant ; FR et EN.
Contrôle visuel à 375 px (carte modale sans double défilement, deux boutons alignés sans débordement)
et sur bureau. Deux défauts visuels trouvés et corrigés en route : flèche « ↗ » rendue en emoji bleu
(remplacée par ▲/▼ colorés), second bouton débordant de 14 px (`white-space: normal`).

**Piège de test** : `100 × 1,05` tombe à 104,999… en flottant selon l'ordre des opérations et
s'arrondit à 100 au lieu de 110 — d'où des assertions en plage (100–110) plutôt qu'une valeur exacte.

**Volontairement pas fait** (à rediscuter si besoin) : option « viser −10 % » (objectif d'économie) —
suggérer d'après le passé peut figer de mauvaises habitudes, mais c'est une décision produit à part ;
non porté sur `geofinance-free` (demande limitée à Djignan).

`CACHE_VERSION` : `v104` → `v105`.

### 12 octobre 2026 (suite) — Export « preuve » PDF / Excel + description d'investissement obligatoire

Demandé par l'auteur : pouvoir imprimer/sauvegarder ailleurs, comme **preuve physique**, un rapport PDF
et Excel de chaque investissement, compte gardé et dette/créance ; et, pour les investissements, un
champ **description obligatoire**.

- **`js/proof-export.js`** (nouveau, ajouté à `APP_SHELL`) — module d'export commun, **sans aucune logique
  métier** : chaque module construit son propre « modèle de document » (`buildInvestmentProof`,
  `buildDebtProof`, `buildKeptAccountProof`, dans leur module respectif — ils connaissent leurs données
  et leurs calculs, pas de dépendance circulaire) et le passe à `openProofExportModal()` (petite modale :
  Télécharger le PDF / Imprimer / Excel). Chaque fiche : informations, synthèse chiffrée, historique
  complet, date et heure de génération, coordonnées du profil, **zone(s) de signature** (une pour un
  investissement ; deux pour une dette — débiteur/créancier — et un compte gardé — gardien/propriétaire
  de l'argent), pied de page paginé. Le tableau répète son en-tête à chaque saut de page.
- **PDF** : jsPDF déjà vendorisé ; mêmes espaces fines/insécables remplacées que `reports.js`
  (`pdfAmount`), sinon « 823/500 F/CFA ».
- **Excel = vrai .xlsx écrit à la main** (ZIP « stocké » sans compression + XML minimal, ~150 lignes) :
  le projet n'a ni bundler ni dépendance npm, donc pas de bibliothèque Excel. Dates et montants sont de
  **vrais nombres/dates** (triables, sommables) avec formats `#,##0` (XOF/XAF/JPY) ou `#,##0.00` et
  `jj/mm/aaaa` ; feuille « Résumé » + une feuille par tableau ; mise en page « ajuster à la largeur » pour
  l'impression. Nom de feuille limité à 31 caractères (limite Excel). `ZERO_DECIMAL_CURRENCIES` exporté
  depuis `utils.js` pour ça.
- **Imprimer** : `doc.autoPrint()` + ouverture dans un onglet ; repli sur un téléchargement si
  `window.open` est refusé (bloqueur, WebViews natives).
- **Investissement : `description` obligatoire** (textarea, + `reference` optionnelle : n° de titre,
  plaque…). Affichée sur la carte ; un ancien investissement sans description porte un badge
  « Description manquante » et l'export prévient (sans bloquer).
- **Bug trouvé en passant et corrigé** : `kept-accounts.js` (suppression d'un mouvement) référençait une
  variable `entityId` inexistante → `ReferenceError` après la suppression (mouvement effacé mais ni
  toast ni rafraîchissement). Même bug dans `investments.js` (suppression d'une entrée d'historique).

**Testé avec le vrai Excel** (installé sur la machine, ouvert par automatisation COM) : les 3 fichiers
s'ouvrent sans réparation, dates et montants sont des `Double`, soldes recalculés corrects (20 000 →
50 000 → 37 500 ; dette 400 k → 350 k → 300 k) ; archives vérifiées (`unzip -t`, CRC OK). PDF rendus en
images (API Windows.Data.Pdf) et relus : mise en page, retour à la ligne, signatures. **Pièges de test** :
la CSP de l'app bloque `fetch(blob:)` (donc capturer les blobs via `URL.createObjectURL`) ; jsPDF
télécharge via `dispatchEvent`, pas `.click()` ; un nom comme « ure.pdf » dans Téléchargements est un
artefact du navigateur de test lors de téléchargements rapprochés, le nom transmis est correct.

### 12 octobre 2026 (suite 2) — Portefeuilles Courant/Épargne/Bloqué, épargne liée, prêt et dividende réinvesti

Demandé par l'auteur (4 besoins liés). Questions posées avant de coder (réponses retenues) : l'argent
d'une épargne vit dans un **portefeuille d'épargne dédié** ; **Bloqué = date de déblocage** (Épargne =
retrait libre depuis la fiche du portefeuille) ; un portefeuille Épargne/Bloqué est **invisible
partout au quotidien** ; un prêt peut financer **tout ou partie** d'un investissement.

**1. Rôle d'un portefeuille** (`wallet.usage` : `current` par défaut — tous les anciens — | `savings` |
`blocked` + `unlockDate`). `ledger.js` : `walletUsage()`, `isDailyWallet()` (actif ET courant),
`withdrawalLockedUntil()`.
- **Invisible au quotidien** : filtré (`isDailyWallet`) de Saisie express (portefeuille et cible de
  virement), formulaire de récurrence, création et remboursement de dette, dépense partagée, achat /
  apport / dividende / retrait d'investissement. **Volontairement laissés à tous les portefeuilles** :
  rapprochement bancaire, filtres de liste, import CSV (relevé d'un compte d'épargne). Exception : en
  MODIFIANT une transaction/récurrence déjà liée à un portefeuille non courant, ce portefeuille reste
  proposé (sinon l'édition viderait la sélection).
- **Fiche du portefeuille** (`openWalletDetailModal`/`openWalletMoveModal`, `wallets.js`) : bouton
  « Ouvrir » sur les cartes Épargne/Bloqué ; **Verser** (depuis un courant, même devise), **Retirer des
  fonds** (vers un courant ; refusé avant la date de déblocage d'un Bloqué, et si le solde est
  insuffisant), **Intérêts / gain** (revenu, catégorie « Intérêts » retrouvée/créée FR/EN). Ce sont des
  virements (`type: 'transfer'`) — jamais comptés en dépense/revenu, patrimoine inchangé — sauf les
  intérêts (vrai revenu).
- **Garde-fous du formulaire portefeuille** : Bloqué exige une date ; on ne peut pas rendre non courant
  un portefeuille utilisé par une **récurrence active** (elle continuerait à le débiter en silence sans
  qu'on puisse la voir) ni repasser en courant un portefeuille **lié à un objectif d'épargne actif**.
- **Calculs** : le **patrimoine net compte tous les portefeuilles**. `computeEndOfMonthForecast`
  (donc « Reste à vivre » et solde prévisionnel) ne compte **que les courants** — épargner fait baisser
  le reste à vivre, c'est voulu. `computeLiquidBalance` (outils : fonds d'urgence, impact d'un achat) =
  courants + épargne, **pas le bloqué**. `computeNetWorthComposition` renvoie maintenant `liquid`
  (courant) + `savings` + `blocked` (le donut a deux nouvelles parts) ; le score de santé les compte
  dans les actifs.
- **Distinct du `type` de portefeuille** (banque/espèces/mobile money/investissement/« Épargne
  spécifique », ce que c'est) — `usage` dit à QUOI il sert. Aucune migration : un champ absent = courant.

**2. Épargne liée à des portefeuilles** (`savings.js` réécrit). Un objectif est lié à 1+ portefeuilles
Épargne/Bloqué (`goal.walletIds`, même devise). **⚠️ Version corrigée le jour même (voir « suite 3 »
ci-dessous) : un portefeuille PEUT servir plusieurs objectifs à la fois** (voiture + maison sur le même
livret) — la première version, « un portefeuille = un seul objectif actif », était fausse.
L'argent reste dans le patrimoine, aucun double comptage. **Épargner / Récupérer** = virements via la
fiche du portefeuille (choix du portefeuille si plusieurs). Un formulaire propose de créer un
portefeuille d'épargne à la volée. **Anciens objectifs** (suivi manuel) : badge « Non lié », ancien
montant conservé à l'affichage, boutons remplacés par « Lier à un portefeuille » ; en liant, l'ancien
montant est remis à 0 (il n'a jamais été de l'argent du ledger). Les transactions portent
`savingsGoalId` (traçabilité).

**3. Investissement financé par un prêt** (`investments.js`, `debts.js`). Case « Financer une partie (ou la
totalité) par un prêt » : montant, prêteur, taux, échéance ; **seule la part restante est débitée des
portefeuilles**. Le prêt = une dette liée (`createLinkedDebt` étendu : `investmentId`, taux, échéance,
note d'audit) **sans transaction d'ouverture** (l'argent va de la banque au vendeur sans passer par un
portefeuille) ; `inv.loanDebtId`. À l'achat le patrimoine net ne bouge pas (actif +, dette +). La fiche
affiche le restant dû et la **valeur nette (valeur − prêt restant)**, avec un bouton **Rembourser le
prêt** (réutilise `openPaymentModal`, désormais exporté, débit d'un portefeuille courant). La carte de
dette indique « Finance l'investissement X ». Supprimer l'investissement **détache** le prêt sans
l'effacer (on doit toujours l'argent à la banque). L'export de l'investissement ajoute le financement et
le tableau des remboursements. Intérêts du prêt non comptés dans le ROI (les remboursements de dette
sont en principal seulement dans l'app) — limite assumée.

**4. Dividende réinvesti.** Destinations d'un dividende : un portefeuille courant, **cet investissement**
ou **un autre de la même devise**, avec répartition possible entre plusieurs destinations. Une part
réinvestie ne passe par aucun portefeuille : le dividende reste compté comme **perçu** (ROI) et crée un
**apport** sur la destination (`sourceEntryId` vers le dividende d'origine, **supprimé en cascade** avec
lui, avec confirmation qui le dit). Seules les parts portefeuille créent une recette.

**Testé** : `test/ledger.test.html` **47/47** (35 + 12 : rôle par défaut, `isDailyWallet`, composition
épargne/bloqué, virement courant→épargne sans effet sur le patrimoine, reste à vivre = courants
seulement, liquidités sans le bloqué, progression d'un objectif lié, ancien objectif non lié, verrou
avant/après la date, Épargne jamais verrouillée). **Dans le navigateur** (démo + portefeuille bloqué) :
sélecteurs du quotidien limités aux 3 courants (Saisie express, récurrence, dette, remboursement,
investissement, dividende) ; versement/retrait/solde insuffisant/verrou/intérêts ; objectif lié,
exclusivité, « Épargner » ; achat 1 M avec prêt de 600 k (400 k débités, aucune transaction d'ouverture,
patrimoine inchangé), remboursement de 100 k depuis la fiche (restant 500 k, patrimoine inchangé) ;
dividende 10 000 → 4 000 portefeuille + 6 000 réinvestis, 5 000 vers un autre investissement sans
transaction de portefeuille, suppression en cascade ; garde-fous (récurrence active, objectif lié, date
manquante) ; édition d'un virement d'épargne ; reste à vivre = soldes courants seulement ; FR/EN.

**Non fait / à rediscuter** : portage sur `geofinance-free` ; intérêts d'un prêt dans le ROI ;
rapprochement bancaire et filtres de liste listent encore tous les portefeuilles (choix délibéré).
(« Prêt à la création seulement » : levé le jour même, voir « suite 3 ».)

`CACHE_VERSION` : `v104` → `v107` (v105 suggestions de budget, v106 export, v107 portefeuilles/épargne/prêt).

### 12 octobre 2026 (suite 3) — Un portefeuille d'épargne, plusieurs objectifs ; prêts en cours de vie

Deux corrections de l'auteur sur la suite 2 : « un portefeuille épargne peut contenir plusieurs
objectifs » et « le prêt peut être choisi en cours (augmenter mon capital, faire une réparation, et je
n'ai pas de fonds) ».

**Épargne : parts par objectif** (`ledger.js`, `savings.js`, `wallets.js`). `computeSavingsGoalProgress`
est **supprimée**, remplacée par `computeSavingsAllocations()` →
`{ goals: Map(goalId → {linked, saved, wallets:[…allocated]}), wallets: Map(walletId → {balance,
allocated, free, goals:[…]}) }`. Modèle : `goal.walletIds` + `goal.allocations {walletId: base}` ; les
virements d'épargne portent `savingsGoalId`. **Part d'un objectif dans un portefeuille = base + dépôts
étiquetés − retraits étiquetés** ; **« libre » = solde − Σ parts des objectifs actifs** (un objectif
archivé libère sa part). Le formulaire d'objectif propose, par portefeuille, une case et une « Part de
cet objectif » (plafonnée à libre + sa part actuelle). `openWalletMoveModal(wallet, mode, {goal})` :
un retrait refuse le verrou de date, le solde, puis **la part de l'objectif** (ou le montant libre quand
on retire depuis la fiche sans objectif) ; la fiche du portefeuille détaille les parts et le libre.
Garde-fou : un portefeuille lié à un objectif actif ne peut pas repasser en « courant ».

**Prêts en cours de vie** (`investments.js`, `debts.js`). Un investissement peut avoir **plusieurs prêts**
(`loansFor(inv, debts, payments)`, qui lit aussi l'ancien `inv.loanDebtId`). Dans l'historique, un
**apport** peut être financé par un prêt (« augmentation de capital, réparation… ») : montant, prêteur,
taux, échéance ; seule la part restante est débitée d'un portefeuille (entièrement financé → pas de
ligne portefeuille, aucune transaction), la dette est créée via `createLinkedDebt` (sans transaction
d'ouverture) et `entry.loanDebtId` la relie à l'apport. La carte affiche « Prêts (n) — X restant » ;
« Rembourser » ouvre un sélecteur quand plusieurs prêts sont ouverts ; la preuve exportée liste tous
les prêts et remboursements ; supprimer l'investissement les détache tous.

**Bug de calcul corrigé au passage — `investmentValueAsOf` (`ledger.js`).** Avec au moins une
valorisation, la valeur restait figée à la dernière valorisation : un apport saisi ENSUITE ne montait
jamais la valeur, et faisait donc baisser le patrimoine net du montant apporté (un apport de 280 000
financé par prêt donnait −280 000 de patrimoine et une moins-value fictive). Désormais **valeur = dernière
valorisation + apports − retraits datés STRICTEMENT après elle** (un apport du jour même de la
valorisation y est déjà compris). Cela corrigeait aussi tous les apports faits sans prêt.

**Bug pré-existant corrigé** (`transactions.js`) : modifier une transaction depuis la liste reconstruisait
l'enregistrement à zéro et perdait `debtId`, `investmentId`, `investmentMovementType`, `savingsGoalId`
(un remboursement de dette devenait une dépense ordinaire). L'enregistrement part maintenant de
`{ ...editTransaction }`.

**Testé** : `test/ledger.test.html` **55/55** (47 + 6 allocations partagées + 2 valeur après apport).
Dans le navigateur : deux objectifs sur un même livret (sur-part refusée, retrait au-delà de la part
refusé, retrait libre refusé à 0 libre) ; apport de 200 000 dont 150 000 par prêt (50 000 débités) puis
80 000 entièrement par un second prêt (aucune transaction) → « Prêts (2) 230 000 restant », patrimoine
net inchangé à 943 500 ; sélecteur de remboursement ; modification de la note d'un remboursement conserve
`debtId` ; export Excel avec deux prêts.

`CACHE_VERSION` : `v107` → `v109` (v108 allocations/prêts en cours, v109 valeur d'investissement).

### 12 octobre 2026 (suite 4) — Audit complet : fonctionnalités, bugs, sécurité

Demandé par l'auteur : « teste toutes les fonctionnalités, les bugs et la sécurité ». Méthode : tests
dynamiques dans le navigateur sur des données de démo (vérificateur d'invariants : références orphelines,
NaN, montants ≤ 0, patrimoine net avant/après chaque flux), pas seulement une relecture de code.

**Sécurité — vérifié sain** : XSS stocké (charge `"><img onerror>` injectée dans TOUS les champs texte de
tous les stores, 12 vues, 9 onglets, ~30 modales, formulaires d'édition, recherche, exports : 0 injection,
0 erreur) ; XLSX (XML échappé) ; CSP (pas de `unsafe-inline` côté script, `object-src 'none'`) ; blocage
anti-brute-force du PIN (5 échecs → 30 s, y compris avec le BON code, persistant après rechargement) ;
écran d'activation (mauvais codes refusés) ; sauvegarde chiffrée (mauvais mot de passe, fichier altéré
refusés, aucune donnée en clair dans le fichier) ; aller-retour avec justificatif photo ; `pinHash` forgé
ignoré à l'import ; formules CSV neutralisées.

**Bugs trouvés et corrigés** :
1. **Modifier une transaction changeait sa catégorie en silence** (`transactions.js`) — `setType()`
   remplit les catégories en asynchrone sans que personne n'attende : en édition, la valeur d'origine était
   posée sur un `<select>` encore vide, puis les options arrivaient et sélectionnaient la 1re. Toute
   modification (même d'une note) passait la catégorie à « Santé ». `setType` renvoie maintenant sa promesse
   et l'ouverture l'attend.
2. **Montants à 0 acceptés** (`min="0"` laisse passer 0) : transaction, dette/créance, apport/dividende/retrait
   d'investissement, mouvement de compte gardé, dépense partagée, récurrence. Gardes JS ajoutées (une
   valorisation à 0 reste permise : perte totale).
3. **Remboursement supérieur au restant dû** (`debts.js`) : acceptait de rembourser plus que dû (transaction
   de portefeuille sans contrepartie, dette négative). Refusé avec message.
4. **Limite de budget vidée, nulle ou négative** (`budgets.js`) : le champ déclenche `change` même pour
   « -100 » ; un budget négatif ou à 0 était enregistré. ≤ 0 = pas de budget (enregistrement supprimé),
   mensuel et annuel.
5. **Import de sauvegarde non atomique** (`db.js`) : chaque store était vidé puis rempli séparément ; une ligne
   invalide faisait échouer l'import au milieu et laissait une base à moitié ancienne / à moitié nouvelle.
   Désormais : validation complète d'abord (clé primaire, champs critiques via `REQUIRED_FIELDS` : date ISO,
   montant fini, devise…), puis UNE transaction IndexedDB multi-stores (tout ou rien). Un fichier forgé avec
   une transaction à date `null` faisait aussi planter le tableau de bord — refusé maintenant.
   ⚠️ Les nouveaux stores ou champs obligatoires ajoutés plus tard doivent rester cohérents avec
   `REQUIRED_FIELDS`, sinon un import légitime serait refusé.
6. **Import CSV** (`backup.js`) : dates impossibles (`31/02/2026`, `2026-13-45`) enregistrées telles quelles ;
   `1e999` lu comme 1999 ; montant `99999999999999999999` accepté (plafond `MAX_IMPORTED_AMOUNT` = 1e12) ; le
   format Djignan acceptait date illisible, montant 0 et virement sans portefeuille cible.
7. **Devise par défaut = EUR en dur** (`shared.js`, `kept-accounts.js`) : une dépense partagée payée par
   « moi » échouait (« Créez d'abord un portefeuille en EUR ») pour tout utilisateur en XOF. Devise de base
   maintenant.
8. **Rappel de sauvegarde hebdomadaire sur une base vide** (`backup.js`) : s'empilait sur l'assistant de
   configuration dès le tout premier lancement. Ignoré s'il n'y a ni portefeuille ni transaction.
9. **Partage entrant** (`sw.js`) : n'importe quel site peut poster un formulaire vers `/share-target`. Le SW
   ne garde plus qu'une image raster (pas de SVG/HTML), ≤ 15 Mo, non vide.
10. **Données de démo** : soldes initiaux relevés (Espèces 40 000, Orange Money 80 000) — la démo affichait
    des portefeuilles en négatif.

**Vérifié correct** : cycle complet d'une dette (création avec mouvement, refus du surpaiement, remboursements,
passage à « soldée », patrimoine inchangé) ; investissement (création avec prêt, apports financés par prêt,
dividende réparti portefeuille + réinvesti, valorisation, retrait, remboursement d'un prêt parmi deux,
suppression d'une entrée en cascade, suppression de l'investissement qui détache les prêts) ; récurrences
(ancrage fin de mois 31/07 → 31/08 → 30/09 → 31/10, hebdomadaire, inactive ignorée, apport automatique,
orpheline désactivée) ; partage de dépenses (je paie / un tiers paie / cascade) ; comptes gardés (jamais dans
le patrimoine) ; portefeuilles Bloqué/Épargne (date obligatoire, retrait verrouillé, solde insuffisant) ;
rapports (2 PDF + 3 CSV) ; vues avec base VIDE (12 vues, aucun NaN) ; traduction EN (toutes les vues et
modales, 0 résidu français hors données de démo) ; assistant de premier lancement (langue → restauration →
PIN avec confirmation différente refusée → 7 étapes) ; CSV aller-retour sans doublons.

**Tests** : `test/ledger.test.html` **64/64** (55 + 9 : import sain, ligne sans id, date null, montant non
numérique, nom non texte, atomicité, stores non tableau, `pinHash` forgé). Les fixtures de dettes ont
maintenant un `personName` (requis par la validation d'import).

**Non traité / à savoir** : un participant « Moi » supprimé laisse ses dépenses partagées avec un nom
inconnu (comportement documenté dans la confirmation) ; `firebase-sync.js` non modifié (revu, sain) ; le
code d'activation reste un filtre de distribution, pas une sécurité cryptographique ; non porté sur
`geofinance-free`.

`CACHE_VERSION` : `v109` → `v118`.

## 7. Pistes prioritaires non traitées

Par ordre d'impact estimé, à valider avec l'auteur avant de s'y attaquer :

1. ~~**Rendre la sauvegarde vraiment robuste**~~ — **fait, voir §6** (sauvegarde cloud Google + rappel
   périodique dédié, entrées du 14 août 2026).
2. ~~**Tests de non-régression légers pour `ledger.js`**~~ — **fait, voir §11** (`test/ledger.test.html`).
3. ~~**Avertir l'utilisateur sur les imports CSV avec montants invalides**~~ — **fait, voir §6** (entrée
   du 14 août 2026).
4. ~~**Arrondi en centimes entiers dans `ledger.js`**~~ — **tolérance appliquée aux 2 comparaisons de
   seuil exact identifiées, voir §6** (14 août 2026). Une vraie migration vers des centimes entiers en
   stockage (au lieu de `Number` en unités monétaires) reste délibérément **hors scope** : chantier de
   grande ampleur touchant tout le modèle de données existant (migration IndexedDB pour tous les
   utilisateurs déjà installés) pour un problème qui n'a jamais été rapporté en pratique — à ne
   reconsidérer que si un écart réel et visible remonte un jour.
5. **Digital Asset Links pour l'APK** (§9) — plein écran natif sans barre d'adresse Chrome. Nécessite
   d'héberger `.well-known/assetlinks.json` à la racine de `zaky04.github.io`, donc dans le dépôt
   `zaky04.github.io` (page utilisateur GitHub) — **pas ce dépôt-ci**, qui ne sert que `/geofinance/`.
6. ~~**Audit accessibilité**~~ — **fait pour les boutons icône, voir §6** (14 août 2026). Reste ouvert,
   **décision de design à prendre avec l'auteur** : contraste de `--text-faint` sous le seuil WCAG AA
   dans les deux thèmes (détails §6) — corriger impliquerait de resserrer la hiérarchie visuelle à 2
   niveaux de gris au lieu de 3.
7. **Comportement à grande échelle** — *mesuré et partiellement corrigé le 14 août 2026, voir §6*
   (jeu de données synthétique de 14 600 transactions/5 ans ; `computeNetWorthHistory` était le point
   noir isolé, corrigé, 1555ms → 473ms). Reste ouvert, non traité volontairement : `ctx()`
   (`ledger.js`) charge un store entier en mémoire à chaque calcul (`dbGetAll()`, pas de requête
   IndexedDB bornée par date/index) — sur ce même jeu de données, ~300-500ms résiduels par calcul en
   viennent. Des requêtes indexées par date réduiraient ça, mais c'est un chantier plus large,
   disproportionné tant qu'aucun utilisateur réel n'a signalé de lenteur perceptible.

## 8. Comment reprendre le travail

- Lire ce fichier en premier.
- `git log --oneline` pour l'historique complet (messages en français, très descriptifs).
- Le code est commenté en français aux endroits non-évidents (le *pourquoi*, pas le *quoi*) — les lire avant
  de modifier une fonction, ils expliquent souvent une décision non intuitive (ex: pourquoi `fetch({cache:
  'reload'})` plutôt que `cache.add()` dans `sw.js`, pourquoi les dates locales et pas `.toISOString()`...).
- Avant tout commit touchant du JS/CSS/HTML : penser au bump de `CACHE_VERSION` (§3.1).

## 9. Empaquetage Android (APK / TWA)

### 14 août 2026 — Première génération d'un APK (Trusted Web Activity)

Demandé par l'utilisateur : une version APK installable sur Android. Généré via **TWA (Trusted Web
Activity)**, la méthode standard pour empaqueter une PWA — pas une copie figée du code : l'APK est
une coquille native qui affiche l'app en plein écran en pointant vers l'URL déployée
(`https://zaky04.github.io/geofinance/`).

**Important — la logique de mise à jour ne change pas.** L'APK charge le contenu réel depuis
GitHub Pages à chaque lancement ; le Service Worker (`sw.js`, `CACHE_VERSION`) continue de gérer le
cache et les mises à jour exactement comme pour la PWA web. Déployer sur `main` met à jour l'app pour
tout le monde (web ET APK) sans avoir à régénérer l'APK. Seul un changement natif (icône, nom,
format d'empaquetage) nécessiterait un nouvel APK — jamais une évolution normale du code.

**Générée localement** (pas de compte développeur externe requis, contrairement à Firebase) via
`@bubblewrap/cli` (Google), avec :
- `packageId` : `com.zaky04.geofinance` (quasi permanent si publié un jour — choisi avec l'utilisateur).
- Usage prévu : sideload / partage direct pour l'instant (pas de Play Store).

**Détails techniques pour reproduire/mettre à jour l'APK plus tard :**
- Le projet TWA (`twa-manifest.json`, projet Gradle généré, keystore) vit **hors du dépôt Git**, dans
  un répertoire de travail local temporaire — à recréer si besoin (voir ci-dessous), il n'est pas
  versionné.
- Bubblewrap exige un JDK **exactement 17.x** (vérifie littéralement `JAVA_VERSION="17.0` dans le
  fichier `release` du JDK) — un JDK 21 (ex: celui livré avec Android Studio) est explicitement
  rejeté, malgré la doc qui suggère juste "17+". Téléchargé Temurin 17 (adoptium.net) séparément pour
  contourner ça.
- Le SDK Android local (`%LOCALAPPDATA%\Android\Sdk`, installé via Android Studio/Flutter) utilise la
  structure moderne (`cmdline-tools/latest/`) — la validation de Bubblewrap cherche un dossier
  `tools/` ou `bin/` directement à la racine du SDK (structure historique). Contourné en créant une
  jonction NTFS `Sdk\tools` → `Sdk\cmdline-tools\latest` (`New-Item -ItemType Junction`), sans toucher
  au SDK réel.
- Mots de passe du keystore passés via les variables d'environnement
  `BUBBLEWRAP_KEYSTORE_PASSWORD`/`BUBBLEWRAP_KEY_PASSWORD` (évite les prompts interactifs, qui plantent
  dans un terminal non-interactif).
- `bubblewrap build` échouait systématiquement sur `gradlew.bat` ("n'est pas reconnu") à cause d'un
  souci d'interopérabilité entre le sous-processus lancé par Node (npx via Git Bash/MSYS) et
  `cmd.exe` sur Windows. Contourné en lançant `gradlew.bat assembleRelease` directement depuis
  PowerShell (hors de l'orchestration de Bubblewrap), puis en signant l'APK manuellement avec
  `zipalign`/`apksigner` (build-tools `36.1.0`) et le keystore généré par `keytool`.
- Certificat de signature (empreinte SHA-256, à connaître si un jour Digital Asset Links ou Play
  Console sont configurés) :
  `BA:BC:56:75:B6:02:57:24:C3:3F:64:F3:C7:9F:A5:F9:CC:65:97:4F:5A:5A:F3:33:7D:86:11:F4:50:A2:9D:FE`

**Le fichier `android.keystore` et son mot de passe ont été remis directement à l'utilisateur** (pas
committés dans ce dépôt — un keystore est un secret, sa perte empêcherait de republier une mise à jour
signée de la même app). **À sauvegarder par l'utilisateur dans un endroit sûr, durablement** —
nécessaire pour toute regénération future de l'APK sous le même `packageId`.

### 17 août 2026 — APK remplacé par une version 100% autonome (Capacitor)

L'auteur a explicitement rejeté la logique de la TWA décrite ci-dessus : *"je veux que ce soit des
applications autonomes pas des coquilles qui vont aller chercher sur le repo git"*. L'APK
`com.zaky04.geofinance` (§ ci-dessus) reste tel quel dans son historique (documentation de ce qui a
été fait à l'époque), mais **n'est plus le modèle suivi pour Djignan** — remplacé par un APK
construit avec **Capacitor**, qui embarque réellement tous les fichiers (`index.html`, `css/`, `js/`,
`vendor/`, `icons/`, `sw.js`) dans l'archive elle-même. Le WebView Android les charge en local
(`https://localhost`, scheme interne de Capacitor) — confirmé par inspection directe de l'APK signé
(`unzip -l`) : les fichiers de l'app sont bien sous `assets/public/`, et `capacitor.config.json`
embarqué ne contient aucune `server.url`. IndexedDB fonctionne normalement dans ce contexte (stockage
local à l'app, isolé par `packageId` — pas de différence de comportement avec la PWA web pour
`db.js`).

**packageId** : `com.zaky04.djignanfinance` (distinct de `com.zaky04.geofinance`, nouvelle app,
nouveau keystore de signature dédié — voir plus bas).

**Reproduire/mettre à jour l'APK** (le projet Capacitor vit hors du dépôt, comme la TWA avant lui) :
1. `npm init -y && npm install @capacitor/core @capacitor/cli @capacitor/android`
2. `npx cap init "Djignan Financial System" com.zaky04.djignanfinance --web-dir=www`, puis copier les
   fichiers statiques du dépôt (`index.html`, `manifest.json`, `sw.js`, `css/`, `js/`, `vendor/`,
   `icons/` — pas `CLAUDE.md`/`test/`/`serve.ps1`) dans `www/`.
3. `npx cap add android` — copie automatiquement `www/` vers
   `android/app/src/main/assets/public`.
4. Icônes : `npx @capacitor/assets generate --android` depuis un `assets/icon.png` (source
   `icons/icon-512.png`) — nécessite `sharp` en dépendance native, qui déclenche un avertissement
   `npm` sur les scripts d'installation non approuvés (`npm approve-scripts`) : légitime ici (lib
   d'image bien connue), mais à vérifier au cas par cas si le même avertissement apparaît pour un
   autre paquet un jour.
5. **Piège JDK, différent de celui documenté pour Bubblewrap** : Capacitor génère un
   `capacitor.build.gradle` qui exige **Java 21** (`sourceCompatibility`/`targetCompatibility
   JavaVersion.VERSION_21`), pas 17 — inverse exact de la contrainte Bubblewrap ci-dessus. Utiliser le
   JBR fourni avec Android Studio (`C:\Program Files\Android\Android Studio\jbr`, déjà en JDK 21)
   comme `JAVA_HOME` pour ce build précis. Ce fichier `capacitor.build.gradle` est régénéré à chaque
   `npx cap sync`, ne pas essayer de le patcher à la main.
6. Build : `.\gradlew.bat assembleRelease --no-daemon` **directement depuis PowerShell** (même
   contournement que pour Bubblewrap — `gradlew.bat` invoqué depuis un sous-processus Node via
   Git Bash/MSYS échoue) → `android\app\build\outputs\apk\release\app-release-unsigned.apk`.
7. Keystore dédié généré via `keytool -genkeypair` (RSA 2048, validité 10000 jours, alias `djignan`) —
   **différent de celui de GeoFinance**, une app = un keystore, cohérent avec l'usage de deux
   `packageId` distincts.
8. Signature manuelle (`build-tools 36.1.0`) : `zipalign -v -p 4` puis `apksigner sign` — même
   séquence que pour l'APK GeoFinance.

**Vérifié avant livraison** : `unzip -l` sur l'APK signé confirme la présence de
`assets/public/index.html`/`manifest.json`/`sw.js` (donc bien embarqués, pas une coquille) ;
`apksigner verify --print-certs` confirme la signature avec le nouveau certificat dédié à Djignan.

**Le fichier `djignan.keystore` et son mot de passe ont été remis directement à l'utilisateur** (même
politique que pour GeoFinance — jamais committé, secret nécessaire à toute mise à jour future signée
sous le même `packageId`).

### 17 août 2026 (suite) — Connexion Google cassée sur les deux builds natifs, corrigée (flux navigateur système + PKCE)

Signalé par l'utilisateur après avoir testé les deux premiers builds : "la connexion google est
cassee sur les builds". Diagnostic mené par test direct (jamais de supposition non vérifiée, voir
la même exigence posée par l'auteur le 16 août pour la connexion Google web) :

- **Android** : requête vers `accounts.google.com/gsi/client` avec le User-Agent exact d'une WebView
  Android (contient `; wv`) → **HTTP 403**, confirmé par `curl` direct. Google bloque
  délibérément toute requête OAuth émise depuis une WebView embarquée (politique anti-hameçonnage
  documentée par Google elle-même) — s'applique à *n'importe quelle* app Capacitor/Cordova utilisant
  ce mécanisme, pas un bug corrigible côté app.
- **Windows** : reproduction en direct via le protocole CDP (port de debug WebView2,
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>`) montre que le script GSI
  se charge en fait normalement (`window.google` bien peuplé) — donc pas le même blocage qu'Android.
  Cause réelle : l'origine de la page (`http://tauri.localhost`, propre à Tauri) n'est de toute façon
  pas une origine autorisée pour `googleClientId` (type "Web", limité à `https://zaky04.github.io`).

**Fix retenu, identique en esprit sur les deux plateformes** : flux OAuth "autorisation par code +
PKCE" ouvert dans le **vrai navigateur du système** (jamais la WebView de l'app), conformément à la
RFC 8252 (recommandation officielle de Google pour les apps natives/de bureau). Toute la logique
partagée (PKCE, échange du code) vit dans `firebase-sync.js` ; `signInWithGoogle()` détecte la
plateforme (`window.__TAURI__` / `Capacitor.isNativePlatform()`) et bascule vers le bon flux — le
flux GSI existant (16 août) reste inchangé et continue de servir la PWA web normale.

**Windows (Tauri)** — redirection en boucle locale (`127.0.0.1:<port aléatoire>`, RFC 8252 §7.3) :
- `src-tauri/src/lib.rs` : nouvelle commande `start_oauth_loopback` — ouvre un `TcpListener` sur
  `127.0.0.1:0` (port libre attribué par l'OS), renvoie le port au frontend, puis dans un thread
  séparé attend UNE requête HTTP (celle de la redirection Google), en extrait `code`/`error` de la
  query string (parsing minimal fait à la main, pas de dépendance HTTP serveur complète — un seul
  usage, pas besoin d'un framework), répond avec une page HTML de confirmation, puis émet
  l'événement Tauri `oauth-callback` vers le frontend. Nouvelle commande `open_external` (crate
  `open`) pour ouvrir l'URL d'autorisation dans le navigateur par défaut — jamais dans la WebView de
  l'app.
- `tauri.conf.json` : `app.withGlobalTauri: true` ajouté — nécessaire pour que le frontend (JS
  vanilla, sans bundler ni `@tauri-apps/api` en dépendance npm) puisse appeler `invoke`/`event.listen`
  via le global `window.__TAURI__` injecté par Tauri, plutôt que d'importer le paquet npm de l'API
  (aurait exigé une étape de build que ce projet n'a pas, voir §3).
- **Vérifié de bout en bout, mécanique complète, sans le vrai client OAuth** (celui-ci reste
  `REPLACE_ME`, voir plus bas) : via le port de debug WebView2 (CDP), appel direct de
  `start_oauth_loopback` → port obtenu (ex: 45536) → requête HTTP simulée
  (`http://127.0.0.1:<port>/?code=FAKE_TEST_CODE_123`) → réponse HTTP 200 avec la page de
  confirmation → événement `oauth-callback` bien reçu côté JS avec `{code: 'FAKE_TEST_CODE_123',
  error: null}`. Toute la chaîne Rust → HTTP → événement Tauri → JS fonctionne ; seule l'étape
  Google elle-même (client OAuth réel) reste à tester par l'auteur une fois le client créé (voir
  ci-dessous — nécessite une action Google Cloud Console que je ne peux pas faire à sa place).

**Android (Capacitor)** — Custom Tabs + schéma d'URL personnalisé :
- `npm install @capacitor/browser @capacitor/app` + `npx cap sync android` (2 nouveaux plugins
  détectés et enregistrés automatiquement par Capacitor — pas de câblage JS supplémentaire requis
  côté app : `window.Capacitor.Plugins.Browser`/`.App` sont exposés directement par le pont
  générique de Capacitor, sans avoir à vendoriser le JS des paquets npm).
- `AndroidManifest.xml` : nouvel `<intent-filter>` sur `MainActivity` (déjà `launchMode="singleTask"`,
  essentiel : garantit que la redirection réutilise l'instance déjà ouverte au lieu d'en relancer
  une nouvelle) avec `<data android:scheme="com.zaky04.djignanfinance" />` — capte la redirection
  `com.zaky04.djignanfinance:/oauth2redirect?code=...` renvoyée par Google après consentement.
- `firebase-sync.js` : `Browser.open()` (Custom Tabs, **pas** la WebView — c'est précisément ce qui
  évite le blocage HTTP 403 puisque Custom Tabs utilise le vrai processus Chrome) pour l'étape de
  consentement, `App.addListener('appUrlOpen', ...)` pour capter le retour, extraction manuelle de
  `code`/`error` de la query string (`new URL()` évité ici : comportement pas garanti fiable sur un
  schéma personnalisé non "spécial" selon la spec URL — parsing par `indexOf('?')` +
  `URLSearchParams` à la place).
- **Testé uniquement à la compilation** (`gradlew assembleRelease` → succès, signature vérifiée) —
  contrairement au flux Windows, impossible de simuler un Custom Tab + deep link retour sans un
  vrai appareil/émulateur Android connecté. Round-trip complet à confirmer par l'auteur.

**`index.html`** : CSP `connect-src` += `https://oauth2.googleapis.com` (échange du code
d'autorisation contre les jetons, `fetch()` direct depuis le JS de l'app — gouverné par
`connect-src`, pas `script-src`).

**`js/firebase-config.js`** : deux nouveaux exports, `googleDesktopClientId`/`googleAndroidClientId`,
tous deux `REPLACE_ME.apps.googleusercontent.com` en attendant que l'auteur crée les clients
correspondants dans Google Cloud Console (projet `geofinance-backup`) :
- Type **"Application de bureau"** pour Windows — aucune URI de redirection à déclarer (le flux
  loopback est autorisé nativement pour ce type de client, n'importe quel port).
- Type **"Android"** pour l'APK — nom du package `com.zaky04.djignanfinance`, empreinte SHA-1
  `9E:0E:35:CA:6B:A4:42:74:FC:88:48:A7:1D:20:0F:87:BD:E6:A5:6F` (celle du nouveau keystore Capacitor,
  §9 ci-dessus — à regénérer si le keystore change un jour). Aucune URI de redirection à déclarer
  non plus (schéma `<packageId>:/oauth2redirect` autorisé par défaut pour ce type de client).

Ces deux nouveaux clients sont des clients **publics** (flux PKCE, pas de client secret) — même
niveau de confidentialité que `googleClientId` existant (voir le commentaire déjà en place dans
`firebase-config.js`).

`CACHE_VERSION` : `v87` → `v88`.

**Suite, une fois les deux clients créés par l'auteur** — deux points supplémentaires découverts en
finalisant :

1. **Piège Google Cloud Console non documenté ailleurs** : un client de type "Android" refuse par
   défaut la redirection par schéma d'URI personnalisé (`invalid_request` / "Custom URI scheme is
   not enabled for your Android client"), confirmé en chargeant l'URL d'autorisation réelle dans un
   navigateur. Il faut explicitement cocher **"Paramètres avancés" → "Schéma d'URI personnalisé" →
   "Activer le schéma d'URI personnalisé"** sur la page du client Android dans Google Cloud Console
   (Google déconseille ce mode pour les nouveaux clients Android, poussant vers les App Links
   vérifiés — mais l'active quand même si explicitement demandé). Sans ça, aucune version du code
   ne peut faire fonctionner ce flux.
2. **Piège local, propre à ce projet** : après avoir modifié `firebase-sync.js`/`firebase-config.js`
   pour ce correctif, un premier test réel (via le port de debug WebView2) est retombé sur l'ancien
   flux GSI cassé (`popup_failed_to_open`) au lieu du nouveau flux desktop — pas un bug du nouveau
   code, mais `sw.js` n'avait pas été resynchronisé dans le dossier `dist/` du projet Tauri (seuls
   `index.html`/`firebase-sync.js`/`firebase-config.js` l'avaient été) : le Service Worker
   cache-first embarqué servait donc encore l'ancien `firebase-sync.js` depuis le premier lancement
   de test. Après synchronisation de `sw.js` (donc du nouveau `CACHE_VERSION`) et remise à zéro du
   profil WebView2 (`%LOCALAPPDATA%\com.zaky04.djignanfinance`, supprimé entièrement — équivalent du
   "vider le cache" habituel en local, voir §3.1), le flux desktop s'est déclenché correctement.
   **À retenir pour tout futur correctif sur ces builds natifs** : les TROIS fichiers
   (`index.html`, tout `.js` modifié, ET `sw.js`) doivent être resynchronisés ensemble dans
   `dist`/`www` avant chaque rebuild — oublier `sw.js` seul ne fait rien planter à la compilation,
   juste servir silencieusement une version obsolète au runtime.

**Vérifié de bout en bout côté Windows avec les vrais clients** (toujours sans compléter de
connexion réelle, interdite dans cette session — voir limite déjà documentée le 15 août) :
`signInWithGoogle()` déclenché via le port de debug WebView2 → `start_oauth_loopback` exécuté avec
succès (port assigné confirmé en LISTEN via `Get-NetTCPConnection`) → promesse de connexion restée
correctement en attente (pas d'erreur immédiate, contrairement au tout premier test avec les IDs
`REPLACE_ME`) → URL d'autorisation avec le vrai `googleDesktopClientId` déjà confirmée acceptée par
Google (écran de connexion normal, aucune erreur) lors du test de validation des deux clients.
Round-trip Android (Custom Tabs → redirection → échange du code) non testable sans appareil/émulateur
connecté à cette session — à confirmer par l'auteur.

`CACHE_VERSION` : `v88` → `v89` (mise à jour des deux ID client réels dans `firebase-config.js`).

## 10. Exécutables installables multi-plateformes

### 17 août 2026 — Windows : premier build réel (Tauri)

Suite de la piste discutée le 16 août (ci-dessous) : l'auteur a demandé les deux builds (APK + Windows)
en insistant sur le caractère **autonome** — aucune requête réseau vers GitHub Pages au démarrage.
Premier exécutable Windows jamais construit pour ce projet, via **Tauri** (comme recommandé par
l'analyse du 16 août). Contrairement à l'APK ci-dessus (§9, 17 août) qui charge les fichiers via un
WebView Android, Tauri utilise **WebView2** (déjà présent sur Windows 10/11) et embarque les fichiers
statiques directement dans l'exécutable au moment du build (`frontendDist`) — pas de serveur local, pas
de `file://` vers un dossier externe.

**Outillage déjà présent sur la machine** (installé lors d'une session précédente, non documenté
avant aujourd'hui) : Rust/Cargo 1.97.1 et `@tauri-apps/cli` 2.11.x — contrairement à ce qu'anticipait
l'entrée du 16 août ("rien construit"), le gros du setup était en fait déjà prêt.

**Reproduire/mettre à jour ce build** (le projet Tauri vit hors du dépôt, même politique que l'APK) :
1. `npm init -y`, puis `npx @tauri-apps/cli init --ci --app-name "Djignan Financial System"
   --window-title "Djignan Financial System" --frontend-dist "./dist"` — génère `src-tauri/` (Rust)
   à côté d'un dossier `dist/` où copier les mêmes fichiers statiques que pour l'APK Capacitor
   (`index.html`, `manifest.json`, `sw.js`, `css/`, `js/`, `vendor/`, `icons/`).
2. **Piège de chemin** : `frontendDist` dans `tauri.conf.json` est résolu relativement à
   `src-tauri/`, pas à la racine du projet — `"./dist"` pointait donc vers `src-tauri/dist`
   (inexistant) au lieu de `../dist`. Corrigé en `"../dist"`. Premier essai de build échoué avec un
   message d'erreur explicite et clair ("Unable to find your web assets") — pas un piège silencieux,
   juste à corriger avant de relancer.
3. `tauri.conf.json` : `identifier` changé du défaut `com.tauri.dev` vers
   `com.zaky04.djignanfinance` (même `packageId` que l'APK — cohérent, seule la plateforme change) ;
   `beforeDevCommand`/`beforeBuildCommand` retirés (générés par défaut avec `npm run dev`/`npm run
   build`, qui n'existent pas — le projet n'a aucune étape de build, JS vanilla pur, voir §3) ;
   fenêtre par défaut 1280×860 avec `minWidth`/`minHeight` 375×600 (l'app reste utilisable en
   fenêtre étroite, layout responsive déjà éprouvé sur mobile).
4. Icônes : `npx @tauri-apps/cli icon dist/icons/icon-512.png` — génère automatiquement `.ico`
   (Windows), `.icns` (macOS, inutilisé ici) et les tailles PNG nécessaires, plus des jeux d'icônes
   iOS/Android non utilisés pour ce build mais sans conséquence (ignorés par le bundler Windows).
5. Build : `npx @tauri-apps/cli build` — compile le binaire Rust en mode release (**~7-8 minutes**,
   la première fois — dépendances Rust compilées depuis zéro) puis génère deux installeurs Windows :
   un `.msi` (WiX) et un `.exe` NSIS (`Djignan Financial System_1.0.0_x64-setup.exe`), plus le binaire
   nu `app.exe`.

**Vérifié avant livraison** : l'exécutable (`app.exe`) lancé directement (`Start-Process`), fenêtre
bien titrée "Djignan Financial System" — puis `Get-NetTCPConnection` sur son PID pendant qu'il tourne :
**aucune connexion réseau sortante** (liste vide), confirmant qu'aucune requête n'est faite vers
`zaky04.github.io` ou ailleurs au démarrage — l'app est bien autonome, tout est chargé depuis les
ressources embarquées dans l'exécutable.

**Pas de keystore de signature de code Windows** (Authenticode) — l'exécutable/l'installeur ne sont
pas signés numériquement (nécessiterait un certificat payant d'une autorité de confiance,
indépendant du keystore Android). Conséquence concrète : Windows SmartScreen affichera probablement
un avertissement "Éditeur inconnu" au premier lancement — l'utilisateur devra cliquer "Plus
d'infos" → "Exécuter quand même". Pas bloquant pour un usage personnel/sideload, mais à garder en
tête si une distribution plus large est envisagée un jour.

`packageId`/`identifier` partagé avec l'APK (`com.zaky04.djignanfinance`) — cohérence entre
plateformes pour la même app, mais chaque plateforme a son propre mécanisme de signature
indépendant (keystore Android vs Authenticode Windows, ce dernier absent ici).

### 16 août 2026 — Objectif : pouvoir installer l'app sans dépendre de GitHub

Discuté avec l'auteur suite à une question sur la résilience du projet en cas de disparition du
dépôt GitHub : que se passerait-il pour les utilisateurs déjà actifs ? Réponse détaillée dans le
journal de conversation, résumé ici pour référence future. Cette section est **une piste à
implémenter plus tard**, rien n'a encore été construit — l'auteur compilera lui-même les
installables quand il sera prêt.

**Point de départ important — l'APK actuel ne résout PAS ce besoin.** L'APK généré via TWA/Bubblewrap
(§9 ci-dessus) est une coquille native qui charge le contenu en direct depuis
`https://zaky04.github.io/geofinance/` à chaque lancement. Si l'hébergement GitHub Pages disparaît,
cet APK casse aussi (sauf ce qui était déjà en cache localement sur l'appareil via le Service Worker).
Un vrai exécutable "autonome" doit embarquer TOUS les fichiers de l'app à l'intérieur de l'installeur
lui-même, sans jamais dépendre d'une URL réseau au runtime.

**Par plateforme :**

| Plateforme | Faisable ? | Outil recommandé | Notes |
|---|---|---|---|
| Windows | Oui | **Tauri** (léger, utilise WebView2 déjà présent sur Win10/11) ou Electron (plus lourd ~150-200 Mo, mais plus mature/documenté) | Produit un `.exe` autonome, tout embarqué, zéro dépendance réseau |
| macOS | Oui | **Tauri** (utilise WebKit natif) ou Electron | Produit un `.app`/`.dmg`, distribuable hors App Store (notarisation Apple recommandée pour éviter l'avertissement Gatekeeper, pas strictement obligatoire pour une distribution directe/personnelle) |
| Android | Oui, mais **changement d'approche nécessaire** | Capacitor (Ionic) ou Tauri 2.0 | Remplace la TWA actuelle : les fichiers sont embarqués dans l'APK et chargés en `file://` (ou équivalent), plus jamais en `https://` vers GitHub Pages |
| iOS | **Non, pas de vrai équivalent** — limite de plateforme Apple, pas technique | — | Impossible de distribuer un simple fichier à installer comme sur Android sans passer par l'App Store (compte développeur Apple, 99 $/an, review) ou du sideloading qui expire périodiquement (AltStore, TestFlight — nécessite un Apple ID et une re-signature régulière). La seule option sans compte payant reste "Ajouter à l'écran d'accueil" depuis Safari (déjà disponible aujourd'hui) — mais ça nécessite d'atteindre l'URL au moins une fois pour l'installation initiale, contrairement à un vrai exécutable |

**Compromis à garder en tête avant de se lancer :** Tauri/Electron/Capacitor sont tous de **nouveaux
outils de build** — le projet n'en a aujourd'hui aucun (JS vanilla pur, zéro étape de build, voir §3).
Passer à l'un de ces outils est un changement d'architecture pour la distribution (pas pour le code
applicatif lui-même, qui reste le même HTML/CSS/JS servi tel quel), pas juste une commande à lancer.

**Ordre suggéré si l'auteur se lance** : commencer par **Windows avec Tauri** — la demande initiale la
plus concrète, l'outil le plus léger, et ça valide l'approche avant de dupliquer l'effort sur macOS et
Android (dont la config Tauri se réutilise en grande partie une fois la première plateforme en place).

## 11. Tests automatisés

### 14 août 2026 — Tests de non-régression pour `ledger.js`

Dette technique identifiée depuis l'audit du 12 août (§7.2) : le cœur des calculs financiers
(`ledger.js`) n'avait aucune protection contre une régression de calcul lors d'un futur refactor.

`test/ledger.test.html` — page HTML autonome (pas de framework, pas de build, conforme à la
philosophie du projet) qui :
- pose `window.__GEOFINANCE_TEST_DB_NAME__ = 'geofinance-ledger-test-db'` **avant** d'importer
  `db.js`, ce qui redirige toutes les opérations vers une base IndexedDB isolée — jamais celle de
  l'utilisateur. Nécessite un changement d'une ligne dans `db.js` (`DB_NAME` lit ce global s'il
  existe, sinon comportement inchangé — voir commentaire sur place) : le seul point d'extension
  ajouté pour permettre ce test.
- vide cette base et y insère des données connues (portefeuilles multi-devises, transactions
  revenu/dépense/virement, budget, dette + créance + paiement, investissement + historique de
  valorisations, règle de catégorisation) via les vraies fonctions de `db.js`.
- appelle les vraies fonctions de `ledger.js` (`walletBalancesAsOf`, `investmentValueAsOf`,
  `computeNetWorth`, `computeMonthSummary`, `computeBudgetVsActual`, `computeExpensesByCategory`,
  `computeFinancialHealthScore`, `guessCategoryId`) et compare au résultat attendu, calculé à la main.
- affiche un résumé pass/fail directement sur la page (titre de l'onglet inclus, pour un coup d'œil
  rapide) — pas de dépendance à la console.

**Pour l'utiliser** : ouvrir `test/ledger.test.html` dans un navigateur (ex: servi par `serve.ps1`
comme le reste de l'app) après tout changement dans `ledger.js`. 64 assertions, toutes vertes
actuellement (2 ajoutées le 14 août pour couvrir la tolérance de dérive flottante, voir §6).

**Piège rencontré en l'écrivant, à connaître pour la suite** : le Service Worker met en cache
n'importe quelle requête GET same-origin après une première visite — y compris `test/*`, qui n'est
pourtant pas dans `APP_SHELL`. Un premier run a montré 3 échecs (résultat contaminé par des
transactions de fixture mal isolées, corrigé), puis après correction du fichier de test, le
*second* run affichait encore les anciens résultats : le Service Worker servait la version du
fichier HTML mise en cache lors du premier chargement, pas la version corrigée sur disque. Il faut
vider `caches`/désinscrire le Service Worker (comme d'habitude en local, §3.1) avant de rejouer les
tests après une modification de `test/ledger.test.html` lui-même.

`CACHE_VERSION` : `v41` → `v42` (changement dans `db.js`, précaché dans `APP_SHELL`, même si sans
effet pour un utilisateur réel — `window.__GEOFINANCE_TEST_DB_NAME__` n'est jamais posé en dehors de
cette page de test).

**Non fait à ce stade (pas demandé, pertinent seulement pour Play Store ou expérience 100% sans
barre d'adresse)** : `.well-known/assetlinks.json` (Digital Asset Links) — doit être hébergé à la
racine du domaine `zaky04.github.io`, donc dans le dépôt spécial `zaky04.github.io` (page utilisateur
GitHub), **pas dans ce dépôt `geofinance`** qui ne sert que le sous-chemin `/geofinance/`. Sans ce
fichier, l'APK fonctionne normalement mais affiche une fine barre d'adresse Chrome (Custom Tabs) au
lieu d'un plein écran natif — cosmétique, pas bloquant pour un usage sideload.
