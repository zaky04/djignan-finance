/* ==========================================================================
   GeoFinance System — Fonctions utilitaires partagées
   Formatage devises/dates, conversion multi-devises, helpers UI génériques.
   ========================================================================== */

export function uuid() {
  return crypto.randomUUID();
}

export const CURRENCIES = ['XOF', 'XAF', 'EUR', 'USD', 'GBP', 'CAD', 'CHF', 'MAD', 'NGN', 'GHS', 'CNY', 'JPY'];

/**
 * Sélecteur de devise fiable sur PC/Android/iOS. Un <input list="datalist">
 * a été utilisé initialement mais Safari iOS ignore largement <datalist>,
 * ce qui rendait le champ non modifiable dans les faits. Un <select> natif
 * fonctionne partout, avec une option "Autre" en repli pour un code libre.
 */
export function currencySelectHtml(selected = 'EUR', name = 'currency') {
  const codes = CURRENCIES.includes(selected) || !selected ? CURRENCIES : [selected, ...CURRENCIES];
  return `
    <select name="${name}" data-currency-select>
      ${codes.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('')}
      <option value="__other__">Autre devise…</option>
    </select>
    <input type="text" name="${name}Other" maxlength="3" placeholder="Code devise (ex: BRL)" data-currency-other
      style="display:none;margin-top:8px;text-transform:uppercase;">`;
}

/** À appeler une fois le formulaire inséré dans le DOM pour activer le repli "Autre". */
export function wireCurrencySelect(root) {
  root.querySelectorAll('[data-currency-select]').forEach((select) => {
    const other = select.nextElementSibling;
    const sync = () => {
      const isOther = select.value === '__other__';
      other.style.display = isOther ? 'block' : 'none';
      other.required = isOther;
    };
    select.addEventListener('change', sync);
    sync();
  });
}

/** Lit la devise choisie dans un formulaire construit avec currencySelectHtml(). */
export function readCurrencyValue(form, name = 'currency') {
  const select = form.elements[name];
  if (select.value === '__other__') {
    return (form.elements[`${name}Other`]?.value || '').toUpperCase().slice(0, 3);
  }
  return select.value;
}

/** Convertit une Date en "YYYY-MM-DD" à partir de ses composantes LOCALES
 *  (jamais .toISOString(), qui convertit en UTC et peut faire dériver la
 *  date d'un jour selon le fuseau horaire de l'utilisateur). */
export function localISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayISO() {
  return localISODate();
}

export function currentMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function monthKeyOffset(monthKey, offset) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + offset, 1);
  return currentMonthKey(d);
}

const MONTHS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
export function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return `${MONTHS_FR[m - 1]} ${y}`;
}

export function formatDate(dateStr, options = { day: '2-digit', month: 'short', year: 'numeric' }) {
  if (!dateStr) return '';
  let d;
  if (typeof dateStr === 'string') {
    // "YYYY-MM-DD" doit être lu comme une date locale, pas minuit UTC
    // (sinon Intl peut afficher la veille selon le fuseau de l'utilisateur).
    const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateStr);
  } else {
    d = dateStr;
  }
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('fr-FR', options).format(d);
}

const currencyFormatters = new Map();
export function formatCurrency(amount, currency = 'EUR') {
  const key = currency;
  if (!currencyFormatters.has(key)) {
    try {
      currencyFormatters.set(key, new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }));
    } catch {
      currencyFormatters.set(key, new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }));
    }
  }
  const n = Number(amount) || 0;
  return currencyFormatters.get(key).format(n);
}

export function formatPercent(value, digits = 1) {
  const n = Number(value);
  if (!isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Convertit en nombre fini, sinon `fallback`. Contrairement à l'idiome `Number(x) || 0` utilisé
    ailleurs dans le code, ceci rejette aussi Infinity/-Infinity (qui sont "truthy" et passent donc
    au travers de `|| 0` sans y être ramenés à 0) — utile aux frontières d'entrée non fiables
    (import CSV/JSON) où une valeur comme la chaîne "Infinity" doit être neutralisée plutôt que de
    se propager dans les calculs de ledger.js. */
export function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function percentage(part, total) {
  if (!total) return 0;
  return clamp((part / total) * 100, 0, 999);
}

/** Classe CSS de progression budgétaire selon seuils 70% / 90%. */
export function budgetProgressClass(pct) {
  if (pct >= 90) return 'is-danger';
  if (pct >= 70) return 'is-warn';
  return '';
}

/**
 * Convertit un montant d'une devise à une autre.
 * `rates` est un tableau de lignes { code, rateToBase } où rateToBase = valeur
 * d'une unité de `code` exprimée dans la devise de base (ex: base=EUR,
 * USD.rateToBase=0.92 signifie 1 USD = 0.92 EUR).
 */
export function convertAmount(amount, fromCode, toCode, rates, baseCode = 'EUR') {
  if (fromCode === toCode) return amount;
  const rateMap = Object.fromEntries((rates || []).map((r) => [r.code, r.rateToBase]));
  const toBase = fromCode === baseCode ? amount : amount * (rateMap[fromCode] ?? 1);
  if (toCode === baseCode) return toBase;
  const rate = rateMap[toCode] ?? 1;
  return rate ? toBase / rate : toBase;
}

export function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Échappe le texte utilisateur avant insertion dans du innerHTML (protection XSS). */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Toast simple, auto-disparaissant. */
/** Toast simple, ou avec une action (ex: "Annuler") si actionLabel/onAction sont fournis. */
export function showToast(message, { duration = 3000, actionLabel = null, onAction = null } = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  const textEl = document.createElement('span');
  textEl.textContent = message;
  el.appendChild(textEl);

  let timer;
  if (actionLabel && onAction) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      clearTimeout(timer);
      el.remove();
      onAction();
    });
    el.appendChild(btn);
    duration = Math.max(duration, 5000);
  }
  container.appendChild(el);
  timer = setTimeout(() => el.remove(), duration);
}

/** Déclenche le téléchargement d'un fichier texte/JSON/CSV généré côté client. */
export function downloadFile(filename, content, mimeType = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Lit un fichier <input type="file"> comme texte. */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6Z"/></svg>';

/**
 * Ouvre une modale générique dans #modal-root. Retourne { el, close }.
 * Fermeture via clic sur le fond, bouton "×" ou touche Échap.
 */
export function openModal(bodyHtml, { title = '', onClose = null } = {}) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true">
      ${title ? `<div class="modal-header"><h3>${escapeHtml(title)}</h3><button type="button" class="icon-btn modal-close" aria-label="Fermer">${CLOSE_SVG}</button></div>` : ''}
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  root.appendChild(wrap);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-close')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey);

  return { el: wrap, close };
}

/** Boîte de confirmation stylée (remplace window.confirm). Résout un booléen. */
export function confirmDialog(message, { title = 'Confirmation', confirmText = 'Confirmer', cancelText = 'Annuler', danger = false } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    const modal = openModal(`
      <p style="margin:0 0 18px;">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="confirm">${escapeHtml(confirmText)}</button>
      </div>
    `, { title, onClose: () => { if (!decided) { decided = true; resolve(false); } } });
    modal.el.querySelector('[data-act="cancel"]').addEventListener('click', () => { decided = true; resolve(false); modal.close(); });
    modal.el.querySelector('[data-act="confirm"]').addEventListener('click', () => { decided = true; resolve(true); modal.close(); });
  });
}
