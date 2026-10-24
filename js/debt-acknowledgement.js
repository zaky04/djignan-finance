/* ==========================================================================
   Djignan Financial System — Reconnaissance de dette (PDF à signer et à partager)
   Génère, pour une dette ou une créance, le document que le DÉBITEUR signe : montant en chiffres ET en toutes
   lettres, parties, modalités de remboursement (échéance ou mensualités), intérêts, mention manuscrite
   « Bon pour reconnaissance de dette », signatures du débiteur et du créancier, et — au choix — deux témoins.
   Distinct de la fiche « preuve » (proof-export.js), qui est un relevé de ce qui s'est passé : celui-ci est
   l'ENGAGEMENT lui-même, à faire signer.

   Les fonctions de conversion en lettres sont pures et testées hors navigateur.
   Ce document sert de preuve entre les parties ; il ne remplace ni un acte notarié ni un conseil juridique.
   ========================================================================== */

import { formatCurrency, formatDate, escapeHtml, openModal, showToast, todayISO, ZERO_DECIMAL_CURRENCIES } from './utils.js';
import { getSetting } from './db.js';
import { getLanguage, t } from './i18n.js';
import { buildSchedule } from './loan-schedule.js';

/* ---------- Nombres en lettres ---------- */
const FR_UNITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
const FR_TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

function frBelow100(n) {
  if (n < 20) return FR_UNITS[n];
  const tens = Math.floor(n / 10); const u = n % 10;
  if (tens <= 6) return u === 0 ? FR_TENS[tens] : (u === 1 ? `${FR_TENS[tens]} et un` : `${FR_TENS[tens]}-${FR_UNITS[u]}`);
  if (tens === 7) return u === 1 ? 'soixante et onze' : `soixante-${FR_UNITS[10 + u]}`;
  if (tens === 8) return u === 0 ? 'quatre-vingts' : `quatre-vingt-${FR_UNITS[u]}`;
  return `quatre-vingt-${FR_UNITS[10 + u]}`;
}

/** `final` : le groupe termine le nombre ou précède un nom (« deux cents millions ») → « cents », « quatre-vingts »
    prennent leur s ; devant « mille » ils ne le prennent pas (« deux cent mille »). */
function frBelow1000(n, final) {
  const h = Math.floor(n / 100); const r = n % 100;
  let s = '';
  if (h > 0) {
    s = h === 1 ? 'cent' : `${FR_UNITS[h]} cent`;
    if (r === 0) return h > 1 && final ? `${s}s` : s;
    s += ' ';
  }
  let rest = frBelow100(r);
  if (r === 80 && !final) rest = 'quatre-vingt';
  return s + rest;
}

export function numberToWordsFr(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'zéro';
  const parts = [];
  for (const [size, name] of [[1e9, 'milliard'], [1e6, 'million'], [1e3, 'mille']]) {
    const q = Math.floor(n / size);
    if (q <= 0) continue;
    n -= q * size;
    if (name === 'mille') parts.push(q === 1 ? 'mille' : `${frBelow1000(q, false)} mille`);
    else parts.push(`${frBelow1000(q, true)} ${name}${q > 1 ? 's' : ''}`);
  }
  if (n > 0) parts.push(frBelow1000(n, true));
  return parts.join(' ');
}

const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function enBelow1000(n) {
  const h = Math.floor(n / 100); const r = n % 100;
  const parts = [];
  if (h > 0) parts.push(`${EN_UNITS[h]} hundred`);
  if (r > 0) parts.push(r < 20 ? EN_UNITS[r] : `${EN_TENS[Math.floor(r / 10)]}${r % 10 ? `-${EN_UNITS[r % 10]}` : ''}`);
  return parts.join(' and ');
}
export function numberToWordsEn(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'zero';
  const parts = [];
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    const q = Math.floor(n / size);
    if (q <= 0) continue;
    n -= q * size;
    parts.push(`${enBelow1000(q)} ${name}`);
  }
  if (n > 0) parts.push(enBelow1000(n));
  return parts.join(' ');
}

const CURRENCY_NAMES_FR = { XOF: ['franc CFA', 'francs CFA'], XAF: ['franc CFA', 'francs CFA'], EUR: ['euro', 'euros'], USD: ['dollar américain', 'dollars américains'], GBP: ['livre sterling', 'livres sterling'], MAD: ['dirham', 'dirhams'], NGN: ['naira', 'nairas'], GHS: ['cédi', 'cédis'], JPY: ['yen', 'yens'] };
const CURRENCY_NAMES_EN = { XOF: ['CFA franc', 'CFA francs'], XAF: ['CFA franc', 'CFA francs'], EUR: ['euro', 'euros'], USD: ['US dollar', 'US dollars'], GBP: ['pound sterling', 'pounds sterling'], MAD: ['dirham', 'dirhams'], NGN: ['naira', 'naira'], GHS: ['cedi', 'cedis'], JPY: ['yen', 'yen'] };

/** Montant en toutes lettres, devise comprise : « trois cent mille francs CFA ». Les centimes sont ajoutés pour
    les devises qui en ont (« … euros et cinquante centimes »). */
export function amountInWords(amount, currency, lang = getLanguage()) {
  const fr = lang !== 'en';
  const whole = Math.floor(Math.abs(amount) + 1e-9);
  const cents = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : Math.round((Math.abs(amount) - whole) * 100);
  const names = (fr ? CURRENCY_NAMES_FR : CURRENCY_NAMES_EN)[currency] || [currency, currency];
  const wordsOf = fr ? numberToWordsFr : numberToWordsEn;
  const plural = whole > 1 && !(fr && whole === 1);
  const unit = plural ? names[1] : names[0];
  // « un million de francs », « deux milliards d'euros » : de/d' quand le nombre se termine par million(s)/milliard(s).
  const needsDe = fr && whole > 0 && whole % 1e6 === 0;
  const de = needsDe ? (/^[aeiouyhéèêâ]/i.test(unit) ? " d'" : ' de ') : ' ';
  let text = `${wordsOf(whole)}${de}${unit}`.replace(/ d' /, " d'");
  if (cents > 0) text += fr ? ` et ${wordsOf(cents)} ${cents > 1 ? 'centimes' : 'centime'}` : ` and ${wordsOf(cents)} ${cents > 1 ? 'cents' : 'cent'}`;
  return text;
}

/* ---------- Le document ---------- */
const PDF_UNSAFE_SPACES_RE = new RegExp('[' + [0x202f, 0x00a0, 0x2009, 0x2007].map((c) => String.fromCharCode(c)).join('') + ']', 'g');
const money = (amount, currency) => formatCurrency(amount, currency).replace(PDF_UNSAFE_SPACES_RE, ' ');

/** Construit le texte (articles) du document : pur, testable. `parts` = { debtor, creditor } (objets
    { name, line }), `debt` = la dette, `opts` = { place, date, reason, terms, schedule, paid }. */
export function buildAcknowledgementText({ debt, debtorName, creditorName, place, date, reason, terms, schedule, paid, remaining }) {
  const cur = debt.currency;
  const words = amountInWords(debt.principal, cur);
  const articles = [];
  articles.push({
    title: t('Article 1 — Reconnaissance de dette'),
    text: t('{debtor} reconnaît devoir à {creditor} la somme de {amount} ({words}){reason}, mise à disposition le {date}.', {
      debtor: debtorName, creditor: creditorName, amount: money(debt.principal, cur), words,
      reason: reason ? t(', au titre de : {reason}', { reason }) : '', date: formatDate(debt.startDate),
    }),
  });
  let repayment;
  if (schedule?.rows?.length) {
    repayment = t('La somme est remboursable en {n} mensualités de {payment}, la première le {first} et la dernière le {last}.', {
      n: schedule.rows.length, payment: money(schedule.payment, cur), first: formatDate(schedule.rows[0].date), last: formatDate(schedule.rows[schedule.rows.length - 1].date),
    });
  } else if (debt.dueDate) {
    repayment = t("La somme est remboursable au plus tard le {date}.", { date: formatDate(debt.dueDate) });
  } else {
    repayment = t("La somme est remboursable selon les modalités convenues entre les parties.");
  }
  if (terms) repayment += ` ${terms}`;
  articles.push({ title: t('Article 2 — Remboursement'), text: repayment });
  articles.push({
    title: t('Article 3 — Intérêts'),
    text: debt.interestRate > 0
      ? t("Le prêt est consenti au taux d'intérêt annuel de {rate} %.{extra}", { rate: String(debt.interestRate).replace('.', ','), extra: schedule?.rows?.length ? ` ${t('Total des intérêts prévus : {amount}.', { amount: money(schedule.totalInterest, cur) })}` : '' })
      : t('Le prêt est consenti sans intérêt.'),
  });
  if (paid > 0.005) {
    articles.push({
      title: t('Article 4 — Sommes déjà remboursées'),
      text: t('À la date du {date}, {paid} ont déjà été remboursés ; il reste {remaining} à rembourser.', { date: formatDate(date), paid: money(paid, cur), remaining: money(remaining, cur) }),
    });
  }
  return {
    title: t('RECONNAISSANCE DE DETTE'),
    articles,
    closing: t('Fait en deux exemplaires originaux, à {place}, le {date}.', { place: place || '____________________', date: formatDate(date) }),
    handwritten: t('Mention manuscrite du débiteur : « Bon pour reconnaissance de dette de la somme de {amount} ({words}) ».', { amount: money(debt.principal, cur), words }),
    disclaimer: t("Document établi pour servir de preuve entre les parties. Il ne remplace ni un acte notarié ni un conseil juridique."),
  };
}

export function buildAcknowledgementPdf({ debt, debtor, creditor, place, date, reason, terms, schedule, paid, remaining, witnesses }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const PAGE_W = 210; const M = 18; const W = PAGE_W - 2 * M; const BOTTOM = 280;
  let y = 22;
  const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 22; } };
  const model = buildAcknowledgementText({ debt, debtorName: debtor.name, creditorName: creditor.name, place, date, reason, terms, schedule, paid, remaining });

  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(25, 28, 45);
  doc.text(model.title, PAGE_W / 2, y, { align: 'center' }); y += 12;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text(t('Entre les soussignés :'), M, y); y += 7;
  const party = (label, p) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
    doc.text(`${label} : ${p.name}`, M, y); y += 5.2;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(95, 100, 125);
    for (const line of p.lines.filter(Boolean)) { doc.text(doc.splitTextToSize(line, W - 4), M + 4, y); y += 4.6; }
    doc.setTextColor(25, 28, 45); y += 2.5;
  };
  party(t('Le débiteur'), debtor);
  party(t('Le créancier'), creditor);
  y += 2;

  doc.setFontSize(10.5);
  for (const article of model.articles) {
    const lines = doc.splitTextToSize(article.text, W);
    ensure(8 + lines.length * 5.2);
    doc.setFont('helvetica', 'bold'); doc.text(article.title, M, y); y += 5.4;
    doc.setFont('helvetica', 'normal'); doc.text(lines, M, y); y += lines.length * 5.2 + 3.5;
  }
  const closing = doc.splitTextToSize(model.closing, W);
  ensure(closing.length * 5.2 + 70);
  y += 2; doc.setFont('helvetica', 'normal'); doc.text(closing, M, y); y += closing.length * 5.2 + 6;

  const hand = doc.splitTextToSize(model.handwritten, W);
  doc.setFont('helvetica', 'italic'); doc.setFontSize(9.5); doc.setTextColor(95, 100, 125);
  doc.text(hand, M, y); y += hand.length * 4.6 + 4;
  doc.setTextColor(25, 28, 45);

  const boxW = (W - 10) / 2;
  const box = (x, label, sub, h = 30) => {
    doc.setDrawColor(150, 155, 180); doc.rect(x, y, boxW, h);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(doc.splitTextToSize(label, boxW - 4), x + 2, y + 5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110, 115, 140);
    doc.text(doc.splitTextToSize(sub, boxW - 4), x + 2, y + 10.5); doc.setTextColor(25, 28, 45);
  };
  ensure(34);
  box(M, `${t('Le débiteur')} — ${debtor.name}`, t('Signature précédée de la mention manuscrite'));
  box(M + boxW + 10, `${t('Le créancier')} — ${creditor.name}`, t('Lu et approuvé — signature'));
  y += 34;
  if (witnesses) {
    ensure(34);
    box(M, t('Témoin 1 — nom et signature'), '');
    box(M + boxW + 10, t('Témoin 2 — nom et signature'), '');
    y += 34;
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(120, 124, 145);
  const disclaimer = doc.splitTextToSize(model.disclaimer, W);
  ensure(disclaimer.length * 4 + 2);
  doc.text(disclaimer, M, y + 2);

  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120, 124, 145);
    doc.text('Djignan Financial System', M, 290);
    doc.text(t('Page {page} / {total}', { page: i, total }), PAGE_W - M, 290, { align: 'right' });
  }
  return doc;
}

function fileNameFor(debt) {
  const slug = String(debt.personName).normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dette';
  return `djignan-reconnaissance-de-dette-${slug}-${todayISO()}.pdf`;
}

/** Fenêtre de préparation : lieu, motif, modalités, témoins — puis télécharger / partager / imprimer le PDF. */
export async function openDebtAcknowledgementModal(debt, payments = []) {
  if (!window.jspdf) { showToast(t("La bibliothèque PDF n'est pas chargée (vendor/jspdf.umd.min.js manquant).")); return null; }
  const profile = await getSetting('userProfile', {});
  const meName = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || t('Utilisateur');
  const meLines = [profile.address, profile.phone].filter(Boolean);
  const isDebt = debt.type === 'debt';
  const other = { name: debt.personName, lines: [] };
  const me = { name: meName, lines: meLines };
  // Le DÉBITEUR est celui qui signe l'engagement : moi si c'est une dette, la personne si c'est une créance.
  const debtor = isDebt ? me : other;
  const creditor = isDebt ? other : me;
  const own = payments.filter((p) => p.debtId === debt.id);
  const paid = own.reduce((s, p) => s + p.amount, 0);
  const remaining = Math.max(0, (debt.principal || 0) - paid);
  const decimals = ZERO_DECIMAL_CURRENCIES.has(debt.currency) ? 0 : 2;
  const schedule = debt.termMonths ? buildSchedule({ principal: debt.principal, annualRatePct: debt.interestRate || 0, termMonths: debt.termMonths, startDate: debt.startDate, decimals }) : null;

  const modal = openModal(`
    <p class="fs-13 c-muted mb-12">${escapeHtml(isDebt
      ? t("Vous devez cette somme : c'est vous qui signez, {name} contresigne.", { name: debt.personName })
      : t("{name} vous doit cette somme : c'est {name} qui doit signer, vous contresignez.", { name: debt.personName }))}</p>
    <div class="stat-row"><span class="stat-row-label">${t('Montant')}</span><strong>${escapeHtml(formatCurrency(debt.principal, debt.currency))}</strong></div>
    <div class="fs-13 c-muted mb-12" id="ack-words">${escapeHtml(amountInWords(debt.principal, debt.currency))}</div>
    <div class="form-row"><label for="ack-place">${t('Fait à (ville)')}</label><input type="text" id="ack-place" maxlength="60" autocomplete="off"></div>
    <div class="form-row"><label for="ack-date">${t('Date du document')}</label><input type="date" id="ack-date" value="${todayISO()}"></div>
    <div class="form-row"><label for="ack-reason">${t('Motif du prêt (optionnel)')}</label><input type="text" id="ack-reason" maxlength="120" value="${escapeHtml(debt.note || '')}"></div>
    <div class="form-row"><label for="ack-terms">${t('Modalités de remboursement supplémentaires (optionnel)')}</label><textarea id="ack-terms" rows="2" maxlength="300"></textarea></div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;" class="fs-14 mb-12"><input type="checkbox" id="ack-witnesses"> ${t('Ajouter deux espaces pour des témoins')}</label>
    <div class="modal-actions" style="flex-wrap:wrap;">
      <button type="button" class="btn btn-primary" id="ack-download">${t('Télécharger le PDF')}</button>
      <button type="button" class="btn btn-ghost" id="ack-share">${t('Partager')}</button>
      <button type="button" class="btn btn-ghost" id="ack-print">${t('Imprimer')}</button>
    </div>`, { title: t('Reconnaissance de dette — {name}', { name: debt.personName }) });

  const el = (id) => modal.el.querySelector(id);
  const makeDoc = () => buildAcknowledgementPdf({
    debt, debtor, creditor, place: el('#ack-place').value.trim(), date: el('#ack-date').value || todayISO(),
    reason: el('#ack-reason').value.trim(), terms: el('#ack-terms').value.trim(), schedule, paid, remaining, witnesses: el('#ack-witnesses').checked,
  });
  el('#ack-download').addEventListener('click', () => { makeDoc().save(fileNameFor(debt)); });
  el('#ack-print').addEventListener('click', () => {
    const doc = makeDoc();
    doc.autoPrint();
    const url = URL.createObjectURL(doc.output('blob'));
    const w = window.open(url, '_blank');
    if (!w) { doc.save(fileNameFor(debt)); showToast(t('Impression bloquée : le PDF a été téléchargé, ouvrez-le pour l\'imprimer.')); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  el('#ack-share').addEventListener('click', async () => {
    const doc = makeDoc();
    const file = new File([doc.output('blob')], fileNameFor(debt), { type: 'application/pdf' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: t('Reconnaissance de dette') }); return; } catch (err) { if (err?.name === 'AbortError') return; }
    }
    doc.save(file.name);
    showToast(t('Partage indisponible ici : le PDF a été téléchargé, envoyez-le depuis vos fichiers.'));
  });
  return modal;
}
