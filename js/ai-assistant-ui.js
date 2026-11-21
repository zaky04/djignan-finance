/* ==========================================================================
   Djignan Financial System — Assistant : interface (réglages, panneau du tableau de bord, fenêtre « Mon bilan »)
   La logique (extrait de chiffres, bilan local, appel à l'IA) est dans ai-assistant.js.
   ========================================================================== */

import { setSetting } from './db.js';
import { openModal, escapeHtml, showToast, formatCurrency } from './utils.js';
import { t, getLanguage } from './i18n.js';
import { appState, notifyDataChanged } from './state.js';
import { isSpeechSupported, primeSpeech, speak, stopSpeaking } from './speech-out.js';
import {
  AI_MODELS, getAiSettings, cloudReadiness, gatherAssistantInput, buildSnapshot, buildLocalReport, askAssistant, testAiKey,
} from './ai-assistant.js';

const isHelper = () => appState.role === 'helper';

/** Mode réellement utilisable : l'aidant n'envoie jamais rien vers l'IA (c'est la clé et les données du propriétaire). */
function effectiveMode(settings) {
  return isHelper() && settings.mode === 'cloud' ? 'local' : settings.mode;
}

async function loadSnapshot(level) {
  const input = await gatherAssistantInput(level);
  return buildSnapshot(input);
}

/* ---------- Aperçu de ce qui part ---------- */
function openPreview(snapshot) {
  openModal(`
    <p class="fs-13 c-muted" style="margin:0 0 10px;">${escapeHtml(t("Voici EXACTEMENT ce qui est envoyé à l'IA avec chaque question. Rien d'autre : ni notes, ni noms de personnes, ni liste d'opérations."))}</p>
    <pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:50vh;overflow:auto;font-size:12px;background:var(--surface-alt);padding:10px;border-radius:8px;margin:0;">${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre>`,
  { title: t('Ce qui est envoyé') });
}

/** Demande le consentement, en montrant l'extrait exact. Renvoie true si l'utilisateur accepte. */
function askConsent(level, snapshot) {
  return new Promise((resolve) => {
    let decided = false;
    const modal = openModal(`
      <p class="fs-14" style="margin:0 0 10px;">${escapeHtml(level === 'labels'
        ? t("Avec chaque question, ces chiffres, les noms de vos catégories et de vos portefeuilles sont envoyés au service d'IA (Anthropic), qui les traite pour répondre.")
        : t("Avec chaque question, ces totaux sont envoyés au service d'IA (Anthropic), qui les traite pour répondre. Les catégories que vous avez créées sont regroupées sous « Autres catégories »."))}</p>
      <pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:36vh;overflow:auto;font-size:12px;background:var(--surface-alt);padding:10px;border-radius:8px;margin:0 0 12px;">${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre>
      <p class="fs-12 c-muted" style="margin:0 0 12px;">${escapeHtml(t("Jamais envoyés : notes, étiquettes, noms de personnes, justificatifs, liste d'opérations. Chaque question utilise le crédit de votre propre compte. Vous pouvez retirer cet accord à tout moment."))}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button type="button" class="btn btn-primary" id="ai-consent-yes">${escapeHtml(t("J'accepte"))}</button>
        <button type="button" class="btn btn-ghost" id="ai-consent-no">${escapeHtml(t('Refuser'))}</button>
      </div>`, { title: t("Autoriser l'envoi à l'IA ?"), onClose: () => { if (!decided) { decided = true; resolve(false); } } });
    modal.el.querySelector('#ai-consent-yes').addEventListener('click', () => { decided = true; resolve(true); modal.close(); });
    modal.el.querySelector('#ai-consent-no').addEventListener('click', () => modal.close());
  });
}

/* ---------- Réglages ---------- */
export async function renderAssistantSettings(container) {
  const s = await getAiSettings();
  const keyHint = s.apiKey ? `•••• ${escapeHtml(s.apiKey.slice(-4))}` : t('aucune clé');
  const radio = (name, value, checked, label, hint = '') => `
    <label style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;cursor:pointer;" class="fs-14">
      <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} style="margin-top:3px;">
      <span>${escapeHtml(label)}${hint ? `<span class="fs-12 c-muted" style="display:block;">${escapeHtml(hint)}</span>` : ''}</span>
    </label>`;
  const consented = s.consent === s.level;
  container.innerHTML = `
    <div class="panel mb-16">
      <div class="panel-header"><h3>${escapeHtml(t('Assistant'))}</h3></div>
      <p class="fs-13 c-muted mb-12">${escapeHtml(t("Un bilan de votre mois en mots simples, que l'appli peut lire à voix haute, et si vous le souhaitez, des questions libres à une IA."))}</p>
      ${radio('ai-mode', 'off', s.mode === 'off', t('Désactivé'))}
      ${radio('ai-mode', 'local', s.mode === 'local', t('Bilan en mots simples (sur cet appareil)'), t("Rédigé par l'application, sans Internet, rien n'est envoyé."))}
      ${radio('ai-mode', 'cloud', s.mode === 'cloud', t('IA en ligne (votre clé personnelle)'), t("En plus du bilan : vous posez vos questions à une IA. Des chiffres de votre mois sont alors envoyés, avec votre accord."))}
      ${s.mode === 'cloud' ? `
        <div style="border-top:1px solid var(--border);margin-top:10px;padding-top:10px;">
          <p class="fs-13" style="margin:0 0 4px;"><strong>${escapeHtml(t('Quelles données peuvent partir ?'))}</strong></p>
          ${radio('ai-level', 'anonymous', s.level === 'anonymous', t('Totaux anonymisés'), t("Montants du mois et par catégorie (les catégories que vous avez créées sont regroupées), solde, reste à dépenser. Ni portefeuilles, ni personnes, ni notes."))}
          ${radio('ai-level', 'labels', s.level === 'labels', t('Totaux avec les noms de mes catégories et portefeuilles'), t("Réponses plus précises, mais vos propres libellés sont envoyés. Toujours ni personnes, ni notes."))}
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;cursor:pointer;" class="fs-14">
            <input type="checkbox" id="ai-consent" ${consented ? 'checked' : ''} style="margin-top:3px;">
            <span>${escapeHtml(t("J'accepte l'envoi de ces chiffres à l'IA"))}</span>
          </label>
          <button type="button" class="btn btn-ghost" id="ai-preview-btn">${escapeHtml(t('Voir ce qui serait envoyé'))}</button>
          <div class="form-row mt-12">
            <label for="ai-key-input">${escapeHtml(t('Clé API Anthropic'))} <span class="c-muted fs-12">(${keyHint})</span></label>
            <input type="password" id="ai-key-input" autocomplete="off" spellcheck="false" placeholder="sk-ant-…">
            <p class="fs-12 c-muted" style="margin:6px 0 0;">${escapeHtml(t("La clé reste sur cet appareil : elle n'est jamais dans une sauvegarde. Chaque question consomme le crédit de votre compte Anthropic."))}</p>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <button type="button" class="btn btn-primary" id="ai-key-save">${escapeHtml(t('Enregistrer la clé'))}</button>
            <button type="button" class="btn btn-ghost" id="ai-key-test" ${s.apiKey ? '' : 'disabled'}>${escapeHtml(t('Tester la clé'))}</button>
            ${s.apiKey ? `<button type="button" class="btn btn-ghost" id="ai-key-remove">${escapeHtml(t('Retirer la clé'))}</button>` : ''}
          </div>
          <div class="form-row mt-12">
            <label for="ai-model-select">${escapeHtml(t('Modèle'))}</label>
            <select id="ai-model-select">${AI_MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${escapeHtml(t(m.label))}</option>`).join('')}</select>
          </div>
        </div>` : ''}
    </div>`;

  const refresh = async () => { await renderAssistantSettings(container); notifyDataChanged('settings'); };
  container.querySelectorAll('input[name="ai-mode"]').forEach((el) => el.addEventListener('change', async () => { await setSetting('aiMode', el.value); await refresh(); }));
  container.querySelectorAll('input[name="ai-level"]').forEach((el) => el.addEventListener('change', async () => {
    await setSetting('aiDataLevel', el.value); // le consentement donné pour l'autre niveau ne vaut plus : la case se décoche d'elle-même
    await refresh();
  }));
  container.querySelector('#ai-consent')?.addEventListener('change', async (e) => {
    if (!e.target.checked) { await setSetting('aiConsent', null); showToast(t('Accord retiré : plus rien ne sera envoyé.')); await refresh(); return; }
    e.target.checked = false; // ne se coche qu'après un accord explicite, extrait sous les yeux
    const ok = await askConsent(s.level, await loadSnapshot(s.level));
    if (ok) { await setSetting('aiConsent', s.level); showToast(t('Accord enregistré.')); }
    await refresh();
  });
  container.querySelector('#ai-preview-btn')?.addEventListener('click', async () => openPreview(await loadSnapshot(s.level)));
  container.querySelector('#ai-key-save')?.addEventListener('click', async () => {
    const value = container.querySelector('#ai-key-input').value.trim();
    if (!value) { showToast(t("Collez d'abord votre clé API.")); return; }
    await setSetting('aiApiKey', value);
    showToast(/^sk-ant-/.test(value) ? t('Clé enregistrée.') : t("Clé enregistrée, mais elle ne ressemble pas à une clé Anthropic (sk-ant-…)."));
    await refresh();
  });
  container.querySelector('#ai-key-remove')?.addEventListener('click', async () => { await setSetting('aiApiKey', ''); showToast(t('Clé retirée.')); await refresh(); });
  container.querySelector('#ai-key-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { await testAiKey({ apiKey: s.apiKey, model: s.model, t }); showToast(t('La clé fonctionne.')); }
    catch (err) { showToast(err.message, { duration: 8000 }); }
    finally { btn.disabled = false; }
  });
  container.querySelector('#ai-model-select')?.addEventListener('change', async (e) => { await setSetting('aiModel', e.target.value); showToast(t('Modèle enregistré.')); });
}

/* ---------- Panneau du tableau de bord ---------- */
export async function renderAssistantPanel() {
  const box = document.getElementById('dash-assistant');
  if (!box) return;
  const s = await getAiSettings();
  if (s.mode === 'off') { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
      <div><strong>${escapeHtml(t('Mon bilan'))}</strong><div class="fs-13 c-muted">${escapeHtml(effectiveMode(s) === 'cloud' ? t('Le point sur votre mois, et vos questions.') : t('Le point sur votre mois, en mots simples.'))}</div></div>
      <button type="button" class="btn btn-primary" id="dash-assistant-btn">${escapeHtml(t('Ouvrir'))}</button>
    </div>`;
  box.querySelector('#dash-assistant-btn').addEventListener('click', () => openAssistant());
}

/* ---------- Fenêtre « Mon bilan » ---------- */
export async function openAssistant() {
  primeSpeech(); // dans le geste du clic (voir speech-out.js)
  const settings = await getAiSettings();
  const mode = effectiveMode(settings);
  const fmtFor = (currency) => (n) => formatCurrency(n, currency || 'EUR');
  const snapshot = await loadSnapshot(settings.level);
  const lines = buildLocalReport(snapshot, t, fmtFor(snapshot.currency));
  const speechOk = isSpeechSupported();
  const readiness = cloudReadiness(settings);
  const chips = [t('Résume mon mois'), t("Où part le plus d'argent ?"), t("Ai-je dépensé plus que d'habitude ?")];

  let cloudHtml = '';
  if (mode === 'cloud') {
    if (!readiness.ok) {
      cloudHtml = `<p class="fs-13 c-muted" style="margin:14px 0 0;">${escapeHtml(readiness.reason === 'key'
        ? t("Pour poser des questions à l'IA, ajoutez votre clé API dans Paramètres, section Assistant.")
        : t("Pour poser des questions à l'IA, autorisez l'envoi de vos chiffres dans Paramètres, section Assistant."))}</p>`;
    } else {
      cloudHtml = `
        <div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px;">
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${chips.map((c) => `<button type="button" class="qa-chip" data-ai-chip="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}</div>
          <div style="display:flex;gap:8px;">
            <input type="text" id="ai-question" maxlength="300" placeholder="${escapeHtml(t('Posez votre question…'))}" style="flex:1;min-width:0;">
            <button type="button" class="btn btn-primary" id="ai-ask-btn">${escapeHtml(t('Demander'))}</button>
          </div>
          <div id="ai-answer" aria-live="polite" class="fs-14" style="margin-top:10px;overflow-wrap:anywhere;white-space:pre-wrap;"></div>
          <div id="ai-answer-tools" hidden style="margin-top:8px;"></div>
          <p class="fs-12 c-faint" style="margin:10px 0 0;">${escapeHtml(t("Réponse générée par une IA à partir des chiffres envoyés : elle peut se tromper. Ce n'est pas un conseil financier."))}
            <a href="#" id="ai-show-sent" style="margin-left:6px;">${escapeHtml(t('Voir ce qui est envoyé'))}</a></p>
        </div>`;
    }
  }

  const modal = openModal(`
    <div id="ai-report" class="fs-15" style="line-height:1.5;">${lines.map((l) => `<p style="margin:0 0 8px;">${escapeHtml(l)}</p>`).join('')}</div>
    ${speechOk ? `<button type="button" class="btn btn-ghost" id="ai-listen-btn">${escapeHtml(t('Écouter le bilan'))}</button>` : ''}
    ${cloudHtml}`, { title: t('Mon bilan'), onClose: () => stopSpeaking() });

  modal.el.querySelector('#ai-listen-btn')?.addEventListener('click', () => { primeSpeech(); speak(lines.join(' ')); });
  if (mode !== 'cloud' || !readiness.ok) return;

  const input = modal.el.querySelector('#ai-question');
  const answerEl = modal.el.querySelector('#ai-answer');
  const tools = modal.el.querySelector('#ai-answer-tools');
  const ask = async (question) => {
    const btn = modal.el.querySelector('#ai-ask-btn');
    btn.disabled = true; tools.hidden = true;
    answerEl.textContent = t('Réflexion en cours…');
    try {
      const fresh = await loadSnapshot(settings.level); // chiffres du moment, au cas où quelque chose a changé
      const text = await askAssistant({ apiKey: settings.apiKey, snapshot: fresh, question, language: getLanguage(), model: settings.model, t });
      answerEl.textContent = text; // textContent : la réponse n'est jamais interprétée comme du HTML
      if (speechOk) {
        tools.hidden = false;
        tools.innerHTML = `<button type="button" class="btn btn-ghost" id="ai-listen-answer">${escapeHtml(t('Écouter la réponse'))}</button>`;
        tools.querySelector('#ai-listen-answer').addEventListener('click', () => { primeSpeech(); speak(text); });
      }
    } catch (err) {
      answerEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  };
  modal.el.querySelector('#ai-ask-btn').addEventListener('click', () => ask(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(input.value); });
  modal.el.querySelectorAll('[data-ai-chip]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.aiChip; ask(b.dataset.aiChip); }));
  modal.el.querySelector('#ai-show-sent').addEventListener('click', async (e) => { e.preventDefault(); openPreview(await loadSnapshot(settings.level)); });
}
