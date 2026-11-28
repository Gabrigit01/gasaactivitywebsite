"use strict";

(() => {
  let configuration;
  let dialog;
  let opened = false;
  let sending = false;
  let revision = 0;
  let chosen = { frequency: "", weekday: "" };
  const $ = id => document.getElementById(id);

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  async function request(path, body) {
    const response = await fetch("/api/priority-survey" + path, {
      method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || "Le sondage est momentanément indisponible."); error.status = response.status; throw error; }
    return data;
  }

  function notice(message) {
    $("priority-error").textContent = message;
    $("priority-error").hidden = !message;
  }

  function pageNotice(message) {
    $("priority-invitation-status").textContent = message;
    $("priority-invitation-status").hidden = !message;
  }

  function openSurvey() {
    if (!dialog || configuration?.survey?.status !== "active") return;
    if (document.querySelector("dialog[open]") && !dialog.open) return;
    opened = true;
    if (!dialog.open) dialog.showModal();
  }

  function radioGroup(items, name, legendText) {
    const fieldset = node("fieldset", "priority-fieldset priority-" + name);
    fieldset.append(node("legend", "", legendText));
    const choices = node("div", "priority-choices");
    for (const item of items) {
      const label = node("label", "priority-choice");
      const input = document.createElement("input");
      input.type = "radio"; input.name = name; input.value = item.value; input.required = true;
      input.checked = chosen[name] === item.value;
      label.append(input, node("span", "", item.label));
      choices.append(label);
    }
    fieldset.append(choices);
    return fieldset;
  }

  function render() {
    const survey = configuration.survey;
    $("priority-title").textContent = survey.title;
    $("priority-question").textContent = survey.question;
    $("priority-description").textContent = survey.description;
    const panel = $("priority-form-panel");
    panel.replaceChildren();
    const form = node("form", "priority-form");
    form.id = "priority-form";
    if (configuration.responded) {
      const summary = node("div", "priority-received");
      summary.append(node("p", "priority-label", "Votre participation"), node("h3", "", "Votre choix a été transmis au comité."));
      const response = configuration.response;
      if (response) summary.append(node("p", "", [survey.frequencies.find(item => item.value === response.frequency)?.label,
        survey.weekdays.find(item => item.value === response.weekday)?.label].filter(Boolean).join(" · ")));
      if (survey.collectBirthdate && !configuration.birthdateProvided) {
        const addBirthdate = node("button", "button button-outline", "Ajouter ma date de naissance (facultatif)");
        addBirthdate.type = "button";
        addBirthdate.addEventListener("click", () => { notice(""); renderBirthdate(); });
        summary.append(addBirthdate);
      }
      const close = node("button", "button button-dark", "Revenir au site");
      close.type = "button"; close.addEventListener("click", () => dialog.close());
      summary.append(close); panel.append(summary); return;
    }
    form.append(node("p", "priority-step", "01 / Vos préférences"),
      radioGroup(survey.frequencies, "frequency", "Quel rythme préférez-vous ?"),
      radioGroup(survey.weekdays, "weekday", "Quel jour vous conviendrait le mieux ?"));
    const actions = node("div", "priority-actions");
    const submit = node("button", "button button-dark", survey.collectBirthdate ? "Continuer" : "Envoyer ma réponse");
    submit.type = "submit";
    const later = node("button", "priority-later", "Plus tard");
    later.type = "button"; later.addEventListener("click", () => dialog.close());
    actions.append(submit, later);
    form.append(actions, node("p", "priority-identity-note", "Une participation par compte. Votre nom, votre e-mail et votre réponse sont visibles par les membres autorisés du comité."));
    form.addEventListener("submit", async event => {
      event.preventDefault(); notice("");
      const data = new FormData(form);
      chosen = { frequency: data.get("frequency"), weekday: data.get("weekday") };
      if (survey.collectBirthdate && survey.birthdatePurpose) renderBirthdate();
      else await sendResponse();
    });
    panel.append(form);
  }

  function renderBirthdate() {
    const survey = configuration.survey;
    const consentPurpose = survey.birthdatePurpose;
    const alreadyResponded = Boolean(configuration.responded);
    const form = node("form", "priority-form");
    form.id = "priority-birthdate-form";
    form.append(node("p", "priority-step", alreadyResponded ? "Un renseignement facultatif" : "02 / Un renseignement facultatif"),
      node("h3", "priority-birthdate-title", "Souhaitez-vous partager votre date de naissance ?"),
      node("p", "priority-purpose", consentPurpose));
    const label = node("label", "priority-birthdate-label", "Date de naissance (facultatif)");
    const input = document.createElement("input");
    input.type = "date"; input.name = "birthdate"; input.id = "priority-birthdate";
    input.min = "1900-01-01"; input.max = new Date().toISOString().slice(0, 10); input.autocomplete = "bday";
    label.append(input); form.append(label);
    const consentLabel = node("label", "priority-consent");
    const consent = document.createElement("input"); consent.type = "checkbox"; consent.id = "priority-birthdate-consent";
    consentLabel.append(consent, node("span", "", "J’accepte que le comité utilise cette date pour la finalité indiquée ci-dessus."));
    form.append(consentLabel);
    const actions = node("div", "priority-actions");
    const submit = node("button", "button button-dark", alreadyResponded ? "Enregistrer ma date de naissance" : "Envoyer ma réponse"); submit.type = "submit";
    const back = node("button", "priority-later", alreadyResponded ? "Retour à ma participation" : "Retour aux préférences"); back.type = "button";
    back.addEventListener("click", () => { notice(""); render(); });
    actions.append(submit, back); form.append(actions,
      node("p", "priority-identity-note", alreadyResponded
        ? "Votre participation est déjà enregistrée. Vous pouvez laisser cette date vide."
        : "Vous pouvez envoyer votre réponse sans partager cette date."));
    form.addEventListener("submit", async event => {
      event.preventDefault(); notice("");
      if (input.value && !consent.checked) { notice("Confirmez votre accord ou laissez la date vide."); return; }
      await sendResponse(input.value || undefined, input.value ? consent.checked : undefined,
        input.value ? consentPurpose : undefined);
    });
    $("priority-form-panel").replaceChildren(form);
    input.focus();
  }

  async function sendResponse(birthdate, birthdateConsent, birthdatePurpose) {
    if (sending) return;
    ++revision;
    const updatingBirthdate = Boolean(configuration.responded);
    const existingResponse = configuration.response;
    if (updatingBirthdate && !birthdate) {
      notice("");
      render();
      dialog.close();
      return;
    }
    sending = true;
    pageNotice("");
    const submit = $("priority-form-panel").querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      // Close this dialog before opening authentication, preserving the draft.
      dialog.close();
      if (!await window.gasaStudent.authorize()) { openSurvey(); return; }
      let result;
      const body = { surveyId: configuration.survey.id, ...(updatingBirthdate ? {} : chosen),
        birthdate, birthdateConsent, birthdatePurpose };
      const endpoint = updatingBirthdate ? "/birthdate" : "/responses";
      try { result = await request(endpoint, body); }
      catch (error) {
        if (error.status !== 401) throw error;
        window.gasaStudent.invalidate();
        if (!await window.gasaStudent.authorize()) { openSurvey(); return; }
        result = await request(endpoint, body);
      }
      if (result.ok) {
        configuration = { ...configuration, responded: true,
          response: updatingBirthdate ? existingResponse : { frequency: body.frequency, weekday: body.weekday },
          birthdateProvided: Boolean(birthdate) || Boolean(configuration.birthdateProvided) };
        render(); renderInvitation(); openSurvey();
        const updated = await request("").catch(() => null);
        if (updated) {
          configuration = updated;
          render(); renderInvitation();
          if (configuration?.survey?.status !== "active") pageNotice("Votre réponse a été enregistrée.");
        }
      }
    } catch (error) {
      if (error.status === 409) {
        configuration = await request("").catch(() => configuration);
        renderInvitation();
        if (configuration?.survey) render();
      }
      if (configuration?.survey?.status === "active") { openSurvey(); notice(error.message); }
      else {
        pageNotice(error.message);
      }
    } finally { sending = false; if (submit.isConnected) submit.disabled = false; }
  }

  function renderInvitation() {
    const survey = configuration?.survey;
    const invitation = $("priority-invitation");
    invitation.hidden = !survey || survey.status !== "active";
    if (invitation.hidden) { if (dialog.open) dialog.close(); return; }
    $("priority-invitation-title").textContent = survey.title;
    $("priority-invitation-copy").textContent = configuration.responded ? "Vous avez participé à la consultation du campus." : "Fréquence et jour : donnez votre préférence pour les prochaines activités.";
    $("priority-invitation-button").textContent = configuration.responded ? "Voir ma participation" : "Participer au sondage";
  }

  async function refresh(auto = false) {
    if (sending) return;
    const version = ++revision;
    try {
      const data = await request("");
      if (version !== revision || sending) return;
      const previousId = configuration?.survey?.id;
      const previousResponded = configuration?.responded;
      const previousBirthdateProvided = configuration?.birthdateProvided;
      const previousCollectBirthdate = configuration?.survey?.collectBirthdate;
      const previousBirthdatePurpose = configuration?.survey?.birthdatePurpose;
      configuration = data;
      renderInvitation();
      if (!data.survey) return;
      if (!dialog.open || previousId !== data.survey.id || previousResponded !== data.responded
        || data.responded && (previousBirthdateProvided !== data.birthdateProvided
          || previousCollectBirthdate !== data.survey.collectBirthdate || previousBirthdatePurpose !== data.survey.birthdatePurpose)) render();
      if (auto && !opened && !data.responded && data.survey.status === "active") openSurvey();
    } catch {
      // The main site stays available during a temporary survey network failure.
    }
  }

  function initialize() {
    const invitation = node("section", "shell priority-invitation");
    invitation.id = "priority-invitation"; invitation.hidden = true;
    const copy = node("div", "");
    const title = node("h2", ""); title.id = "priority-invitation-title";
    const description = node("p", ""); description.id = "priority-invitation-copy";
    const button = node("button", "button button-dark", "Participer au sondage"); button.id = "priority-invitation-button";
    button.type = "button"; button.addEventListener("click", openSurvey);
    const status = node("p", "shell form-error"); status.id = "priority-invitation-status"; status.hidden = true; status.setAttribute("role", "status");
    copy.append(title, description); invitation.append(copy, button);
    $("accueil-classique").after(invitation);
    invitation.after(status);
    dialog = node("dialog", "priority-dialog"); dialog.id = "priority-dialog";
    dialog.setAttribute("aria-labelledby", "priority-title");
    dialog.innerHTML = `<div class="priority-layout">
      <div class="priority-form-panel" id="priority-form-panel"></div>
      <aside class="priority-editorial">
        <p class="priority-label">UATM GASA AKPAKPA</p>
        <h2 id="priority-title"></h2><p class="priority-editorial-question" id="priority-question"></p>
        <p id="priority-description"></p><p class="priority-editorial-note">Vos préférences dessinent les prochaines rencontres.</p>
      </aside><button type="button" class="priority-close" id="priority-close" aria-label="Fermer le sondage">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
      </button></div><p class="priority-error" id="priority-error" role="alert" hidden></p>`;
    document.body.append(dialog);
    $("priority-close").addEventListener("click", () => dialog.close());
    refresh(true);
    window.addEventListener("gasa:account-change", () => refresh());
    window.addEventListener("focus", () => refresh());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize);
  else initialize();
})();
