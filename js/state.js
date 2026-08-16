/* ==========================================================================
   Djignan Financial System — Store applicatif léger (pub/sub)
   Pas de framework : un bus d'événements + un état partagé suffisent pour
   coordonner les modules (ex: une transaction ajoutée doit rafraîchir le
   dashboard s'il est visible).
   ========================================================================== */

export const EVENTS = {
  DATA_CHANGED: 'data:changed',
  VIEW_CHANGED: 'view:changed',
  PRIVACY_CHANGED: 'privacy:changed',
  THEME_CHANGED: 'theme:changed',
};

class EventBus {
  constructor() { this.handlers = new Map(); }
  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this.handlers.get(event)?.delete(fn); }
  emit(event, payload) { this.handlers.get(event)?.forEach((fn) => fn(payload)); }
}

export const bus = new EventBus();

export const appState = {
  currentView: 'dashboard',
  privacyHidden: false,
  theme: 'auto',
  baseCurrency: 'EUR',
  unlocked: false,
};

/** À appeler après toute écriture en base pour que les vues concernées se rafraîchissent. */
export function notifyDataChanged(scope = 'all') {
  bus.emit(EVENTS.DATA_CHANGED, scope);
}
