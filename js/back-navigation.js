/* ==========================================================================
   Djignan Financial System — Bouton « Retour » partout (module pur, sans DOM : testé hors interface)

   Avant : l'application ne touchait jamais à l'historique du navigateur. Le bouton Retour du téléphone (ou le geste de retour) ne
   fermait pas une fenêtre ouverte et ne revenait pas à l'écran précédent : il QUITTAIT l'application, ou ne faisait rien. Chaque
   écran ouvert depuis « Plus » était une impasse.

   Principe : l'historique du navigateur ne sert que de PIÈGE (une entrée « top » toujours présente au-dessus de l'entrée « base »).
   Un retour dépile « top » ; l'application décide alors, avec ce contrôleur, ce que « retour » veut dire, puis réarme le piège :
     1. une fenêtre est ouverte → on la ferme (la plus récente d'abord) ;
     2. l'application est affichée → on revient à l'écran précédent (pile tenue ici), sinon à l'accueil ;
     3. sur l'accueil (ou sur l'écran de verrouillage / de démarrage) → un premier retour affiche « Appuyez encore pour quitter »,
        un second retour rapproché (2,5 s) laisse le navigateur quitter l'application.
   ========================================================================== */

export function createBackController({
  currentView,          // () => nom de l'écran affiché
  goToView,             // (nom) => affiche l'écran SANS l'ajouter à la pile
  closeTopModal,        // () => true si une fenêtre a été fermée
  isAppVisible,         // () => false sur l'écran de verrouillage ou de démarrage
  onExitWarning,        // () => affiche « Appuyez encore sur Retour pour quitter »
  homeView = 'dashboard',
  now = () => Date.now(),
  exitWindowMs = 2500,
  maxStack = 30,
}) {
  const stack = [];
  let lastWarningAt = null;

  return {
    /** À appeler à chaque changement d'écran voulu par l'utilisateur (pas pour un retour). */
    visit(from, to) {
      if (from === to) return;
      stack.push(from);
      if (stack.length > maxStack) stack.shift();
    },
    /** Vrai quand « retour » ramène à un autre écran (sert à montrer ou cacher la flèche de la barre du haut). */
    canGoBack() { return currentView() !== homeView; },
    /** Vrai = retour géré, l'application reste ouverte. Faux = rien à faire de plus : on la laisse se fermer. */
    handleBack() {
      if (closeTopModal()) { lastWarningAt = null; return true; }
      if (isAppVisible()) {
        while (stack.length) {
          const view = stack.pop();
          if (view !== currentView()) { goToView(view); lastWarningAt = null; return true; }
        }
        if (currentView() !== homeView) { goToView(homeView); lastWarningAt = null; return true; }
      }
      if (lastWarningAt !== null && now() - lastWarningAt < exitWindowMs) return false;
      lastWarningAt = now();
      onExitWarning();
      return true;
    },
    stackSize() { return stack.length; },
  };
}
