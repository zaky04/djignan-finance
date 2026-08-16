/* ==========================================================================
   Djignan Financial System — Configuration du code d'activation
   CE DÉPÔT (djignan-finance) est la version "pro" : le code d'activation est actif. Le dépôt
   "gratuit" (ancien "geofinance", conservé séparément) a sa PROPRE copie de ce fichier avec
   REQUIRE_ACTIVATION_CODE = false et ACTIVATION_CODE_HASH = '' — les deux dépôts divergent
   volontairement sur ce seul fichier, tout le reste du code reste partagé.

   ACTIVATION_CODE_HASH n'est PAS une sécurité réelle — c'est un hash SHA-256 visible dans le code
   source, donc en théorie retrouvable par une personne déterminée à lire le JS. C'est un filtre de
   distribution pratique (savoir qui a reçu le code), pas une protection cryptographique contre un
   accès non autorisé. Voir CLAUDE.md pour le contexte de cette décision.
   ========================================================================== */

export const REQUIRE_ACTIVATION_CODE = true;

// Hash SHA-256 du code valide (hexadécimal, minuscules). Généré via :
//   crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
export const ACTIVATION_CODE_HASH = '0fda0ca249dab626300b56dcfec0945eded4f569c5d43d1832564702448746ce';
