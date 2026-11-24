# Audit i18n — clés de traduction FR → EN

**Date** : 24 novembre 2026
**Périmètre** : `js/**/*.js` (67 fichiers, `js/modules/` inclus) et `index.html`
**Mode** : audit en lecture seule. Seul ce rapport a été créé, puis, sur demande explicite de l'auteur, la clé du §2 a été ajoutée à `js/i18n.js` et `CACHE_VERSION` est passé de `v208` à `v209` dans `sw.js`. Rien n'a été commité.

**Mise à jour (même jour)** : la clé `Remboursement (annulation)` est ajoutée. Relance de l'audit : 0 clé réellement manquante. Les chiffres du §1 ci-dessous sont ceux du moment de l'audit ; entre-temps, d'autres modifications du dépôt ont ajouté quelques clés (dictionnaire passé à 2 063 entrées, 1 962 clés utilisées).
**Méthode** : script Node temporaire (`scratchpad/audit-i18n.js`). Il extrait les arguments littéraux de `t(…)` / `tr(…)` et des attributs `data-i18n*`, lit le dictionnaire `EN` de `js/i18n.js` comme un flux de jetons (y compris les entrées sur deux lignes), puis compare.

---

## 1. Résumé

| Indicateur | Valeur |
|---|---|
| Appels `t()` / `tr()` à clé littérale vérifiés | **2 657** (hors 1 exemple de documentation, voir §4) |
| Attributs `data-i18n*` dans `index.html` vérifiés | **114** |
| `data-i18n*` dans des chaînes JS vérifiés | **1** |
| Occurrences réelles vérifiées au total | **2 772** |
| Clés uniques vérifiées | **1 951** |
| Entrées du dictionnaire `EN` lues | **2 053** (1 821 sur une ligne + 232 sur deux lignes), 0 non lue |
| **Clés MANQUANTES** | **1** (2 occurrences, 1 fichier) |
| **Doublons** dans le dictionnaire | **0** |
| Appels non vérifiables (argument non littéral) | 77 |
| Appels ignorés car dans un commentaire | 38 |

Le dictionnaire est propre : aucune clé déclarée deux fois, donc aucune traduction perdue en silence. Il ne manque qu'une seule clé réelle.

---

## 2. Clés manquantes

| Fichier:ligne | Texte FR (clé) | Traduction EN proposée |
|---|---|---|
| `js/modules/debts.js:310` | `Remboursement (annulation)` | `Repayment (cancelled)` |
| `js/modules/debts.js:311` | `Remboursement (annulation)` | `Repayment (cancelled)` |

**Contexte** : ce libellé est la `note` passée à `logAudit()` lors de l'annulation d'un remboursement de dette. Il s'affiche dans **Outils > Journal d'audit** (`tools.js`). En mode anglais, cette entrée resterait donc en français. Selon la convention du projet (notes traduites à la création), une fois la clé ajoutée, les nouvelles entrées seront en anglais et les anciennes resteront telles quelles.

**Ligne à ajouter** dans le dictionnaire `EN` de `js/i18n.js`, section « Dettes & créances » (non appliquée, pour décision) :

```js
  'Remboursement (annulation)': 'Repayment (cancelled)',
```

---

## 3. Doublons

**Aucun.** Les 2 053 clés du dictionnaire `EN` sont distinctes.

---

## 4. Faux positifs écartés

Deux occurrences signalées par le script sont des **exemples dans le commentaire d'en-tête** de `js/i18n.js`, pas de vrais appels :

| Fichier:ligne | Occurrence | Raison |
|---|---|---|
| `js/i18n.js:12` | `t('...')` | Exemple de documentation (« envelopper chaque chaîne dans t('...') ») |
| `js/i18n.js:14` | `data-i18n="texte français"` | Exemple de documentation |

Ces deux occurrences sont exclues des chiffres du §1. Elles n'ont aucune incidence sur le code.

---

## 5. Limites de l'audit (ce qui n'a pas pu être vérifié)

1. **77 appels à argument non littéral** (`t(variable)`, `t(c.name)`, `tr(greetingWord())`, etc.) : leur clé n'existe qu'à l'exécution, donc non vérifiable statiquement.
2. **Appels dans des commentaires** (38 cas, lignes commençant par `//`, `/*` ou `*`) : volontairement ignorés.
3. **Présence de l'import** : le script ne vérifie pas que chaque fichier qui appelle `t()` / `tr()` importe bien la fonction depuis `i18n.js`. Un appel sans import provoque une `ReferenceError` au premier passage. Vérification à faire séparément.
4. **Texte français non enveloppé** : l'audit ne vérifie que les clés *existantes*. Il ne détecte pas un texte français en dur qui n'est jamais passé par `t()`. Les audits précédents (lots 15-18 du `CLAUDE.md`) l'ont fait par `grep` sur les accents, mais ce n'est pas reproduit ici.
5. **Contenu du `index.html`** : seuls les attributs `data-i18n*` ont été vérifiés. Le texte nu sans attribut n'est pas contrôlé.
6. **Qualité des traductions** : l'audit vérifie la présence des clés, pas leur justesse. Une clé dont la traduction EN est identique au français n'est pas signalée.
7. **Clés du dictionnaire non utilisées** : 103 clés n'apparaissent dans aucun appel littéral (voir l'annexe). La plupart sont atteintes par un appel dynamique (noms de catégories par défaut, classes d'actifs, salutation, etc.). **Ne pas les supprimer sans vérification manuelle.**

---

## Annexe — clés du dictionnaire non trouvées dans un appel littéral (103)

Ligne du dictionnaire entre parenthèses. Liste indicative, pas une liste de suppression.

- `Partage de dépenses` (98)
- `Choisissez un code à 4-6 chiffres pour protéger vos données locales.` (115)
- `Salaire`, `Autres revenus`, `Alimentation`, `Logement`, `Transport`, `Loisirs`, `Santé`, `Abonnements`, `Autres dépenses` (134-142, noms de catégories par défaut)
- `Bonjour` (145), `Bonsoir` (146)
- `Créances & dettes` (150)
- `Bilans` (175), `Dépenses et revenus` (176), `Budget et patrimoine` (177), `Santé et calendrier` (178), `Voir le détail des budgets` (179)
- `une dette ou créance` (486), `un investissement` (488), `une tontine` (490), `une dépense partagée` (492), `un projet collectif` (494)
- `Intérêts de prêt` (568)
- `par semaine` (578), `par mois` (580), `par an` (582)
- `Tabaski` (632), `Korité` (634), `Rentrée scolaire` (636), `Fêtes de fin d'année` (638), `Cérémonie (mariage, baptême, deuil…)` (640), `Autre événement` (642)
- `Courant` (849)
- `Immobilier` (884), `Actions` (885), `Flotte / Transport` (886), `Business` (887), `Obligations` (888), `Cryptomonnaies` (889), `Autre` (890) — classes d'actifs
- `Apport` (891), `Retrait` (892), `Dividende` (893), `Valorisation` (894) — types d'entrée
- `Supprimer l'investissement "{name}" et tout son historique ?` (928)
- `Dividende — {name}` (977), `Apport — {name}` (978)
- `Prêt` (996)
- `Outils stratégiques` (1049)
- `Création` (1111), `Modification` (1112), `Suppression` (1113)
- `Jamais` (1273), `1 minute` (1274), `5 minutes` (1275), `15 minutes` (1276), `30 minutes` (1277)
- `Prénom` (1305), `Numéro de téléphone` (1306), `Adresse` (1307), `Fonction` (1308), `Nom de famille` (1311)
- `Graphiques` (1409), `Solde créances & dettes` (1410)
- `Ajoute un onglet dédié pour suivre l'argent d'un proche que vous gérez (petit frère, conjointe, mère…), totalement séparé de vos portefeuilles et de votre patrimoine net.` (1412)
- `Dépense partagée` (1485), `Rechercher une transaction, un portefeuille, une dette…` (1487)
- `Compte bancaire` (1572), `Portefeuille d'investissement` (1573), `Épargne spécifique` (1574)
- `Vers portefeuille` (1623)
- `Automatique` (1663), `Clair` (1664), `Sombre` (1665)
- `Connecté à Google ({email}).` (1699), `La connexion à Google n'a pas abouti (aucun utilisateur retourné). Réessayez depuis Paramètres.` (1700), `Échec de la connexion Google : {message}` (1702)
- `Téléphone WhatsApp (avec indicatif pays, ex : +225 07 00 00 00 00)` (1745), `Relancer sur WhatsApp` (1746)
- `Bonjour {name}, petit rappel : il reste {amount} à régler{due}. Merci beaucoup !` (1756), ` (échéance : {date})` (1757), `Solde : {name} me doit {amount}` (1758), `Solde : je dois {amount} à {name}` (1759), `Solde : réglé ({currency})` (1760)
- `Ajoute un onglet pour suivre une tontine (cotisation)…` (1814)
- `Récurrent` (1906), `Dette à rembourser` (1907), `Créance à encaisser` (1908), `Cotisation de tontine` (1909)
- `Combien ai-je dépensé ce mois ?` (1964), `Qui me doit de l'argent ?` (1965), `Quel est mon solde ?` (1966), `Ma plus grosse dépense ce mois ?` (1967)
- `Objectif atteint.` (2124), `Point au {date}` (2125), `Collecté : {amount} ({pct} %)` (2126)
- `Attention : {wallet} ne contient que {balance}. Ce déplacement le ferait passer en négatif.` (2224)
- `Afficher les montants` (2286)
- `Rapide et économique (Haiku 5.5)` (2333), `Plus soigné, plus cher (Sonnet 5.5)` (2334)
- `Attention : {wallet} ne contient que {balance}. Cette dépense le ferait passer en négatif.` (2431)
