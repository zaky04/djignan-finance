/* ==========================================================================
   GeoFinance System — Configuration Firebase (sauvegarde cloud optionnelle)
   Ces valeurs ne sont PAS secrètes : elles identifient le projet Firebase,
   elles n'authentifient rien. La sécurité réelle vient des règles Firestore
   (accès restreint à chaque utilisateur pour son propre document, voir
   CLAUDE.md) et de Firebase Authentication, pas de la confidentialité de cet
   objet — il est normal et attendu qu'il soit visible dans le code source
   public d'une app cliente. À remplacer par les valeurs de ton projet :
   console.firebase.google.com > Paramètres du projet > Général > Vos
   applications > Ajouter une app Web.
   ========================================================================== */

export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};

/** true tant que la config n'a pas été renseignée : permet à firebase-sync.js d'afficher un
    message clair ("fonctionnalité pas encore configurée") plutôt que d'échouer silencieusement
    ou avec une erreur réseau confuse au moment de la connexion. */
export const isFirebaseConfigured = Object.values(firebaseConfig).every((v) => v && v !== 'REPLACE_ME');
