"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let configuration, dialog, sending = false, opened = false, revision = 0, flipped = false;
  let chosen = { frequency: '', weekday: '' }, advanceTimer, autoTimer;
  const node = (tag, className, text) => {
    const el = document.createElement(tag); if (className) el.className = className;
    if (text !== undefined) el.textContent = text; return el;
  };
  async function request(path, body) {
    const res = await fetch('/api/priority-survey' + path, { method: body ? 'POST' : 'GET',
      credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const error = new Error(data.error || 'Le sondage est momentanément indisponible.'); error.status = res.status; throw error; }
    return data;
  }
  function notice(message) { $('priority-error').textContent = message; $('priority-error').hidden = !message; }
  function pageNotice(message) { $('priority-invitation-status').textContent = message; $('priority-invitation-status').hidden = !message; }
  function openSurvey() {
    if (configuration?.survey?.status !== 'active') return;
    if (document.querySelector('dialog[open]') && !dialog.open) return false;
    opened = true;
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(resizeStage);
    return true;
  }
  function resizeStage() {
    if (!dialog?.open) return;
    const face = $('priority-stage').querySelector('[aria-hidden="false"]');
    if (face) $('priority-stage').style.height = Math.max(345,face.scrollHeight)+'px';
  }
  function autoOpen() {
    clearTimeout(autoTimer);
    if (opened || configuration?.responded || configuration?.survey?.status !== 'active') return;
    if (!openSurvey()) autoTimer = setTimeout(autoOpen, 800);
  }
  function button(text, action, secondary = false) {
    const el = node('button', secondary ? 'priority-text-button' : 'priority-primary', text);
    el.type = 'button'; el.addEventListener('click', action); return el;
  }
  function display(content, step, focus = true) {
    clearTimeout(advanceTimer); notice('');
    const stage = $('priority-stage');
    const previous = stage.querySelector('[aria-hidden="false"]');
    const next = previous ? stage.querySelector(previous.classList.contains('priority-face-front') ? '.priority-face-back' : '.priority-face-front') : stage.querySelector('.priority-face-front');
    previous?.setAttribute('aria-hidden', 'true'); if (previous) previous.inert = true;
    next.replaceChildren(content); next.setAttribute('aria-hidden', 'false'); next.inert = false;
    if (previous) flipped = !flipped;
    stage.classList.toggle('is-flipped', flipped);
    stage.style.height = Math.max(345, next.scrollHeight) + 'px';
    const total = configuration.survey.collectBirthdate ? 3 : 2;
    $('priority-progress').style.setProperty('--progress', Math.min(step + 1, total) / total * 100 + '%');
    $('priority-step-label').textContent = configuration.responded ? 'Participation enregistrée' : `Étape ${Math.min(step + 1, total)} sur ${total}`;
    if (focus && dialog.open) setTimeout(() => { if (next.isConnected && !next.inert) next.querySelector('h3')?.focus({ preventScroll: true }); }, reduced.matches ? 0 : 480);
  }
  function formBase(title, copy) {
    const form = node('form', 'priority-form');
    const heading = node('h3', '', title); heading.tabIndex = -1; form.append(heading);
    if (copy) form.append(node('p', 'priority-helper', copy));
    return form;
  }
  function choices(form, items, key, step, nextStep) {
    const fieldset = node('fieldset', 'priority-fieldset');
    fieldset.append(node('legend', 'visually-hidden', key === 'frequency' ? 'Fréquence des activités' : 'Jour de la semaine'));
    const grid = node('div', 'priority-choices priority-' + key);
    let keyboardChoice = false;
    for (const [index, item] of items.entries()) {
      const label = node('label', 'priority-choice');
      const input = document.createElement('input'); input.type = 'radio'; input.name = key; input.value = item.value;
      input.checked = chosen[key] === item.value; input.required = true;
      const content = node('span', 'priority-choice-content'); content.append(node('span', '', item.label));
      if (key === 'frequency') content.append(node('small', '', index === 0 ? 'Un rendez-vous chaque semaine' : 'Un rendez-vous tous les quinze jours'));
      label.style.setProperty('--choice-index', index); label.append(input, content); grid.append(label);
      label.addEventListener('pointerdown', () => { keyboardChoice = false; });
      input.addEventListener('keydown', () => { keyboardChoice = true; clearTimeout(advanceTimer); });
      input.addEventListener('change', () => {
        chosen[key] = input.value; clearTimeout(advanceTimer);
        if (!keyboardChoice) advanceTimer = setTimeout(nextStep, reduced.matches ? 0 : 380);
      });
    }
    fieldset.append(grid); form.append(fieldset);
    const actions = node('div', 'priority-actions');
    if (step) actions.append(button('Retour', () => renderPreferences(0), true));
    const next = node('button', 'priority-primary', 'Continuer'); next.type = 'submit'; actions.append(next);
    form.append(actions);
    form.addEventListener('submit', event => { event.preventDefault(); if (chosen[key]) nextStep(); });
  }
  function renderPreferences(step = 0) {
    const survey = configuration.survey;
    if (configuration.responded) return renderReceived();
    const form = formBase(step ? 'Quel jour vous convient ?' : 'À quel rythme se retrouver ?',
      step ? 'Choisissez le jour que vous préférez pour nos activités.' : 'Votre préférence aide le comité à préparer les prochaines séances.');
    choices(form, step ? survey.weekdays : survey.frequencies, step ? 'weekday' : 'frequency', step,
      () => step ? (survey.collectBirthdate ? renderBirthdate() : renderReview()) : renderPreferences(1));
    form.append(node('p', 'priority-identity-note', 'Une réponse par compte étudiant. Votre réponse et votre identité sont visibles par les membres autorisés du comité.'));
    display(form, step);
  }
  function summary() {
    const response = configuration.responded ? configuration.response : chosen;
    const survey = configuration.survey;
    return [survey.frequencies.find(x => x.value === response?.frequency)?.label, survey.weekdays.find(x => x.value === response?.weekday)?.label || response?.weekdayLabel].filter(Boolean).join(' · ');
  }
  function renderReview() {
    const form = formBase('Votre préférence est prête.', summary());
    const submit = node('button', 'priority-primary', 'Envoyer ma réponse'); submit.type = 'submit'; form.append(submit,
      button('Modifier mes choix', () => renderPreferences(0), true));
    form.addEventListener('submit', event => { event.preventDefault(); sendResponse(); }); display(form, 2);
  }
  function renderBirthdate() {
    const purpose = configuration.survey.birthdatePurpose;
    const form = formBase('Et votre anniversaire ?', 'Ce renseignement est facultatif. Vous pouvez continuer sans le partager.');
    form.append(node('p', 'priority-purpose', purpose));
    const label = node('label', 'priority-birthdate-label', 'Date de naissance');
    const input = document.createElement('input'); input.type = 'date'; input.name = 'birthdate'; input.autocomplete = 'bday';
    input.min = '1900-01-01'; input.max = new Date().toISOString().slice(0, 10); label.append(input); form.append(label);
    const consentRow = node('label', 'priority-consent'), consent = document.createElement('input'); consent.type = 'checkbox';
    consentRow.append(consent, node('span', '', 'J’accepte l’utilisation de cette date pour la finalité indiquée ci-dessus.'));
    const publicationRow = node('label', 'priority-consent'), publication = document.createElement('input'); publication.type = 'checkbox';
    publicationRow.append(publication, node('span', '', 'J’accepte aussi les publications de mon anniversaire avec mon nom et le jour/mois, sans mon année de naissance.'));
    form.append(consentRow, publicationRow);
    const submit = node('button', 'priority-primary', configuration.responded ? 'Enregistrer' : 'Envoyer ma réponse'); submit.type = 'submit';
    form.append(submit, button(configuration.responded ? 'Retour' : 'Retour au choix du jour', () => configuration.responded ? renderReceived() : renderPreferences(1), true));
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (input.value && !consent.checked) { notice('Donnez votre accord ou laissez la date vide.'); return; }
      sendResponse(input.value || undefined, input.value ? consent.checked : undefined, input.value ? purpose : undefined, Boolean(input.value && publication.checked));
    });
    display(form, 2);
  }
  function renderReceived() {
    const form = formBase('Votre voix compte.', 'Votre préférence a été transmise au comité.');
    form.append(node('p', 'priority-summary', summary()));
    if (configuration.survey.collectBirthdate && !configuration.birthdateProvided) form.append(button('Renseigner mon anniversaire', renderBirthdate, true));
    form.append(button('Revenir au site', () => dialog.close())); display(form, 2);
  }
  async function sendResponse(birthdate, birthdateConsent, birthdatePurpose, publicationConsent = false) {
    if (sending) return;
    ++revision;
    const updating = Boolean(configuration.responded);
    if (updating && !birthdate) { renderReceived(); return; }
    sending = true; clearTimeout(advanceTimer); pageNotice('');
    const controls = [...$('priority-stage').querySelectorAll('button,input')]; controls.forEach(el => { el.disabled = true; });
    try {
      dialog.close();
      if (!await window.gasaStudent.authorize()) { openSurvey(); return; }
      const body = { surveyId: configuration.survey.id, ...(updating ? {} : chosen), birthdate, birthdateConsent, birthdatePurpose, publicationConsent };
      const endpoint = updating ? '/birthdate' : '/responses';
      let result;
      try { result = await request(endpoint, body); }
      catch (error) {
        if (error.status !== 401) throw error;
        window.gasaStudent.invalidate();
        if (!await window.gasaStudent.authorize()) { openSurvey(); return; }
        result = await request(endpoint, body);
      }
      if (result.ok) {
        configuration = { ...configuration, responded: true, response: updating ? configuration.response : { ...chosen }, birthdateProvided: Boolean(birthdate) || configuration.birthdateProvided };
        renderReceived(); renderInvitation(); openSurvey();
      }
    } catch (error) {
      if (error.status === 409) {
        const updated = await request('').catch(() => null);
        if (updated) { configuration = updated; renderInvitation(); configuration.responded ? renderReceived() : renderPreferences(0); }
      }
      if (configuration.survey.status === 'active') { openSurvey(); notice(error.message); }
      else pageNotice(error.message);
    } finally { sending = false; controls.forEach(el => { el.disabled = false; }); }
  }
  function renderInvitation() {
    const survey = configuration?.survey;
    $('priority-invitation').hidden = !survey || survey.status !== 'active';
    if ($('priority-invitation').hidden) { if (dialog.open) dialog.close(); return; }
    $('priority-title').textContent = survey.title;
    $('priority-question').textContent = survey.question;
    $('priority-description').textContent = survey.description;
    $('priority-invitation-title').textContent = survey.title;
    $('priority-invitation-copy').textContent = configuration.responded ? 'Retrouvez votre participation à la consultation du campus.' : 'Deux choix pour organiser les prochaines rencontres.';
    $('priority-invitation-button').textContent = configuration.responded ? 'Ma participation' : 'Participer au sondage';
  }
  async function refresh(auto = false) {
    if (sending) return;
    const version = ++revision;
    try {
      const data = await request(''); if (version !== revision || sending) return;
      const changed = JSON.stringify(configuration?.survey) !== JSON.stringify(data.survey) || configuration?.responded !== data.responded || configuration?.birthdateProvided !== data.birthdateProvided;
      configuration = data; renderInvitation(); pageNotice('');
      if (!data.survey) return;
      if (changed || !$('priority-stage').querySelector('form')) configuration.responded ? renderReceived() : renderPreferences(0);
      if (auto) autoOpen();
    } catch {
      if (version !== revision || sending) return;
      pageNotice('Le sondage ne peut pas être chargé pour le moment. Réessayez en revenant sur cette page.');
    }
  }
  function initialize() {
    const invitation = node('section', 'shell priority-invitation'); invitation.id = 'priority-invitation'; invitation.hidden = true;
    invitation.innerHTML = '<div><p class="priority-eyebrow">La vie du campus se prépare avec vous</p><h2 id="priority-invitation-title"></h2><p id="priority-invitation-copy"></p></div>';
    const open = button('Participer au sondage', openSurvey); open.id = 'priority-invitation-button'; invitation.append(open);
    const status = node('p', 'shell form-error'); status.id = 'priority-invitation-status'; status.hidden = true; status.setAttribute('role', 'status');
    ($('accueil-classique') || document.querySelector('main > section')).after(invitation); invitation.after(status);
    dialog = node('dialog', 'priority-dialog'); dialog.id = 'priority-dialog'; dialog.setAttribute('aria-labelledby', 'priority-title');
    dialog.innerHTML = `<div class="priority-layout"><div class="priority-form-panel"><div class="priority-progress" id="priority-progress"><span></span></div><p class="priority-step" id="priority-step-label" aria-live="polite"></p><div class="priority-perspective"><div class="priority-stage" id="priority-stage"><div class="priority-face priority-face-front" aria-hidden="true" inert></div><div class="priority-face priority-face-back" aria-hidden="true" inert></div></div></div></div><aside class="priority-editorial"><div class="priority-orbit" aria-hidden="true"></div><div class="priority-particles" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p class="priority-label">UATM GASA AKPAKPA</p><h2 id="priority-title"></h2><p id="priority-question" class="priority-editorial-question"></p><p id="priority-description"></p><span class="priority-editorial-note">Des idées. Des rencontres. Notre campus.</span></aside><button type="button" class="priority-close" id="priority-close" aria-label="Fermer le sondage"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button></div><p class="priority-error" id="priority-error" role="alert" hidden></p>`;
    const toolbar = node('div','priority-toolbar');
    toolbar.append(dialog.querySelector('.priority-close'));
    dialog.prepend(toolbar);
    document.body.append(dialog); $('priority-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => clearTimeout(advanceTimer));
    const layout = dialog.querySelector('.priority-layout');
    layout.addEventListener('pointermove', event => {
      if (reduced.matches || event.pointerType !== 'mouse') return;
      const r = layout.getBoundingClientRect(); layout.style.setProperty('--tilt-x', ((event.clientY-r.top)/r.height-.5)*-3+'deg'); layout.style.setProperty('--tilt-y', ((event.clientX-r.left)/r.width-.5)*3+'deg');
    }, { passive: true });
    layout.addEventListener('pointerleave', () => { layout.style.setProperty('--tilt-x','0deg'); layout.style.setProperty('--tilt-y','0deg'); });
    window.addEventListener('gasa:account-change', () => refresh());
    window.addEventListener('focus', () => refresh(true));
    window.addEventListener('resize', resizeStage);
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(resizeStage);
      dialog.querySelectorAll('.priority-face').forEach(face => observer.observe(face));
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
    setInterval(() => { if (!document.hidden) refresh(true); }, 60000);
    refresh(true);
  }
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', initialize) : initialize();
})();
