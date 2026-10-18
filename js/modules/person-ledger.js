/* ==========================================================================
   Djignan Financial System — Fiche par personne (le « carnet de crédit »)
   Regroupe toutes les dettes et créances d'une même personne en UN relevé : qui doit quoi, depuis
   quand, ce qui a déjà été remboursé, et le solde net. C'est la page du cahier où l'on note
   « Moussa me doit 15 000 » — avec, en plus, une relance WhatsApp prête à envoyer.

   La logique de calcul (buildPersonStatement, buildReminderMessage, whatsappUrl) est pure et testée
   hors navigateur. L'écran ne dépend PAS de debts.js (qui l'ouvre) : les actions « rembourser » et
   « nouvelle dette » lui sont passées en paramètres, pour éviter un import circulaire.
   ========================================================================== */

import { getSetting, setSetting } from '../db.js';
import { formatCurrency, formatDate, escapeHtml, openModal, showToast, openExternalUrl } from '../utils.js';
import { t } from '../i18n.js';

/** Clé de regroupement : « Moussa  Diop », « moussa diop » et « Moussá Diop » sont la même personne. */
export function normalizeName(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function remainingOf(debt, payments) {
  const paid = payments.filter((p) => p.debtId === debt.id).reduce((s, p) => s + p.amount, 0);
  return Math.max(0, (debt.principal || 0) - paid);
}

/** Relevé d'une personne.
    Sens des montants (`signed`) : positif = cette personne me doit, négatif = je lui dois.
    Renvoie { name, events (avec solde cumulé par devise), balances { devise: net }, debts (avec restant dû),
    nextDueDate }. Un solde proche de zéro (< 0,005) est ramené à 0. */
export function buildPersonStatement(personName, debts, payments) {
  const key = normalizeName(personName);
  const own = debts.filter((d) => normalizeName(d.personName) === key);
  const events = [];
  for (const d of own) {
    const sign = d.type === 'receivable' ? 1 : -1;
    events.push({ date: d.startDate || '', order: 0, kind: 'open', debtId: d.id, type: d.type, currency: d.currency, amount: d.principal || 0, signed: sign * (d.principal || 0), note: d.note || '' });
    for (const p of payments.filter((x) => x.debtId === d.id)) {
      events.push({ date: p.date || '', order: 1, kind: 'payment', debtId: d.id, type: d.type, currency: d.currency, amount: p.amount, signed: -sign * p.amount, note: p.note || '' });
    }
  }
  events.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.order - b.order);
  const running = {};
  for (const ev of events) {
    running[ev.currency] = (running[ev.currency] || 0) + ev.signed;
    ev.balanceAfter = running[ev.currency];
  }
  const balances = {};
  for (const [cur, value] of Object.entries(running)) balances[cur] = Math.abs(value) < 0.005 ? 0 : value;
  const withRemaining = own.map((d) => ({ ...d, remaining: remainingOf(d, payments) }));
  const dueDates = withRemaining.filter((d) => d.status !== 'paid' && d.remaining > 0.005 && d.dueDate).map((d) => d.dueDate).sort();
  return { name: own[0]?.personName || personName, events, balances, debts: withRemaining, nextDueDate: dueDates[0] || null };
}

/** Message de relance. Ne mentionne que ce que la personne doit (créances actives), par devise. */
export function buildReminderMessage({ name, amounts, dueDate, senderName }, translate = t, format = formatCurrency, formatDay = formatDate) {
  const amountText = amounts.map(({ currency, value }) => format(value, currency)).join(' + ');
  const due = dueDate ? translate(' (échéance : {date})', { date: formatDay(dueDate) }) : '';
  const sign = senderName ? `\n— ${senderName}` : '';
  return translate('Bonjour {name}, petit rappel : il reste {amount} à régler{due}. Merci beaucoup !', { name, amount: amountText, due }) + sign;
}

/** Lien WhatsApp. Sans numéro valide, `wa.me/?text=` laisse choisir le contact dans WhatsApp. */
export function whatsappUrl(phone, message) {
  let digits = String(phone || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  digits = digits.replace(/\D/g, '');
  const text = encodeURIComponent(message);
  return digits.length >= 8 ? `https://wa.me/${digits}?text=${text}` : `https://wa.me/?text=${text}`;
}

/** Texte brut du relevé, pour le partager. */
export function statementAsText(statement, translate = t, format = formatCurrency, formatDay = formatDate) {
  const lines = [translate('Relevé — {name}', { name: statement.name })];
  for (const ev of statement.events) {
    const label = ev.kind === 'open'
      ? (ev.type === 'receivable' ? translate('Prêt accordé') : translate('Prêt reçu'))
      : translate('Remboursement');
    lines.push(`${formatDay(ev.date)} · ${label}${ev.note ? ` (${ev.note})` : ''} : ${format(ev.amount, ev.currency)}`);
  }
  for (const [currency, value] of Object.entries(statement.balances)) {
    if (value > 0) lines.push(translate('Solde : {name} me doit {amount}', { name: statement.name, amount: format(value, currency) }));
    else if (value < 0) lines.push(translate('Solde : je dois {amount} à {name}', { name: statement.name, amount: format(-value, currency) }));
    else lines.push(translate('Solde : réglé ({currency})', { currency }));
  }
  return lines.join('\n');
}

async function loadPhones() {
  const map = await getSetting('personPhones', {});
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

export async function getPersonPhone(personName) {
  return (await loadPhones())[normalizeName(personName)] || '';
}

export async function setPersonPhone(personName, phone) {
  const map = await loadPhones();
  const key = normalizeName(personName);
  if (phone) map[key] = String(phone).trim().slice(0, 30); else delete map[key];
  await setSetting('personPhones', map);
}

/** Liste « par personne » (écran Dettes & créances) : [{ key, name, balances }] triée par montant. */
export function summarizePeople(debts, payments) {
  const names = new Map();
  for (const d of debts) if (!names.has(normalizeName(d.personName))) names.set(normalizeName(d.personName), d.personName);
  return [...names.values()]
    .map((name) => buildPersonStatement(name, debts, payments))
    .filter((s) => Object.values(s.balances).some((v) => v !== 0))
    .map((s) => ({ key: normalizeName(s.name), name: s.name, balances: s.balances }));
}

/** Ouvre la fiche. `actions` = { onPay(debt), onNew(personName) } fournis par debts.js. */
export async function openPersonLedger(personName, debts, payments, actions = {}) {
  const statement = buildPersonStatement(personName, debts, payments);
  const phone = await getPersonPhone(statement.name);
  const profile = await getSetting('userProfile', {});

  const owedToMe = Object.entries(statement.balances).filter(([, v]) => v > 0).map(([currency, value]) => ({ currency, value }));
  const iOwe = Object.entries(statement.balances).filter(([, v]) => v < 0).map(([currency, value]) => ({ currency, value: -value }));
  const settled = !owedToMe.length && !iOwe.length;

  const summaryLines = [
    ...owedToMe.map((a) => `<div class="stat-row"><span class="stat-row-label">${escapeHtml(t('{name} me doit', { name: statement.name }))}</span><strong class="pos">${escapeHtml(formatCurrency(a.value, a.currency))}</strong></div>`),
    ...iOwe.map((a) => `<div class="stat-row"><span class="stat-row-label">${escapeHtml(t('Je dois à {name}', { name: statement.name }))}</span><strong class="neg">${escapeHtml(formatCurrency(a.value, a.currency))}</strong></div>`),
    settled ? `<div class="stat-row"><span class="stat-row-label">${t('Tout est réglé')}</span><strong>✓</strong></div>` : '',
  ].join('');

  const activeDebts = statement.debts.filter((d) => d.status !== 'paid' && d.remaining > 0.005);
  const eventsHtml = statement.events.map((ev) => {
    const label = ev.kind === 'open' ? (ev.type === 'receivable' ? t('Prêt accordé') : t('Prêt reçu')) : t('Remboursement');
    const cls = ev.signed >= 0 ? 'pos' : 'neg';
    return `<div class="tx-row">
      <div class="tx-main"><div class="tx-title">${escapeHtml(label)}</div><div class="tx-sub">${formatDate(ev.date)}${ev.note ? ' · ' + escapeHtml(ev.note) : ''}</div></div>
      <div class="tx-amount amount ${cls}">${ev.signed >= 0 ? '+' : '−'}${escapeHtml(formatCurrency(ev.amount, ev.currency))}</div>
    </div>`;
  }).join('');

  const modal = openModal(`
    <div class="person-summary">${summaryLines}</div>
    <div class="form-row" style="margin-top:12px;">
      <label>${t('Téléphone WhatsApp (avec indicatif pays, ex : +225 07 00 00 00 00)')}</label>
      <input type="tel" id="person-phone" value="${escapeHtml(phone)}" maxlength="30" inputmode="tel" autocomplete="off">
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 14px;">
      <button type="button" class="btn btn-primary" id="person-remind-btn" ${owedToMe.length ? '' : 'disabled'}>${t('Relancer sur WhatsApp')}</button>
      <button type="button" class="btn btn-ghost" id="person-share-btn" ${statement.events.length ? '' : 'disabled'}>${t('Partager le relevé')}</button>
      ${actions.onNew ? `<button type="button" class="btn btn-ghost" id="person-new-btn">${t('+ Nouvelle dette / créance')}</button>` : ''}
    </div>
    ${activeDebts.length && actions.onPay ? `
      <div class="panel-header" style="margin-top:6px;"><h3>${t('En cours')}</h3></div>
      ${activeDebts.map((d) => `<div class="tx-row">
        <div class="tx-main"><div class="tx-title">${escapeHtml(d.type === 'receivable' ? t('Créance') : t('Dette'))} · ${escapeHtml(formatCurrency(d.remaining, d.currency))}</div><div class="tx-sub">${escapeHtml(d.note || '')}${d.dueDate ? (d.note ? ' · ' : '') + t('Échéance : {date}', { date: formatDate(d.dueDate) }) : ''}</div></div>
        <button type="button" class="btn btn-ghost" data-person-pay="${d.id}">${t('Rembourser')}</button>
      </div>`).join('')}` : ''}
    <div class="panel-header" style="margin-top:14px;"><h3>${t('Historique')}</h3></div>
    <div class="tx-list">${eventsHtml || `<div class="tx-empty">${t('Aucun mouvement.')}</div>`}</div>
  `, { title: statement.name });

  const phoneInput = modal.el.querySelector('#person-phone');
  const savePhone = async () => { await setPersonPhone(statement.name, phoneInput.value); };
  phoneInput.addEventListener('change', savePhone);

  modal.el.querySelector('#person-remind-btn').addEventListener('click', async () => {
    await savePhone();
    const sender = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    const message = buildReminderMessage({ name: statement.name, amounts: owedToMe, dueDate: statement.nextDueDate, senderName: sender });
    if (phoneInput.value.replace(/\D/g, '').length < 8) showToast(t("Pas de numéro valide : WhatsApp vous laissera choisir le contact."));
    openExternalUrl(whatsappUrl(phoneInput.value, message));
  });

  modal.el.querySelector('#person-share-btn').addEventListener('click', async () => {
    const text = statementAsText(statement);
    try {
      if (navigator.share) { await navigator.share({ title: t('Relevé — {name}', { name: statement.name }), text }); return; }
      await navigator.clipboard.writeText(text);
      showToast(t('Relevé copié : collez-le dans votre messagerie.'));
    } catch (err) {
      if (err?.name !== 'AbortError') showToast(t("Impossible de partager : copiez le relevé à la main."));
    }
  });

  modal.el.querySelector('#person-new-btn')?.addEventListener('click', () => { modal.close(); actions.onNew(statement.name); });
  modal.el.querySelectorAll('[data-person-pay]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const debt = activeDebts.find((d) => d.id === btn.dataset.personPay);
      if (debt) { modal.close(); actions.onPay(debt); }
    });
  });
}
