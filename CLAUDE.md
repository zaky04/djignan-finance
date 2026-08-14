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
  l'import CSV format GeoFinance ; ajoute un sanitizer générique dans `importAllData()` qui ramène à 0 tout
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
