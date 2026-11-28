"use strict";

const $ = (id) => document.getElementById(id);
const views = {
  vue: { title: "Vue d’ensemble", intro: "Suivez les votes et les retours par séance." },
  prioritaire: { title: "Sondage prioritaire", intro: "Quelle fréquence d’activités et quel jour conviennent aux étudiants ?" },
  sondages: { title: "Séances et sondages", intro: "Choisissez les activités, pilotez les votes et préparez chaque séance." },
  activites: { title: "Catalogue d’activités", intro: "Personnalisez les noms, descriptions, images et questions proposées aux étudiants." },
  participations: { title: "Participations et étudiants", intro: "Retrouvez qui a répondu, à quel sondage et à quel moment." },
  parametres: { title: "Paramètres et diffusion", intro: "Préparez les annonces, partagez les QR codes et exportez les résultats." },
  avis: { title: "Avis étudiants", intro: "Consultez les retours sur la séance sélectionnée." },
  annonce: { title: "Annonces", intro: "Préparez la prochaine séance ou programmez une activité mystère." },
  partage: { title: "Partage et exports", intro: "Diffusez les liens de participation et téléchargez les résultats." },
};
const assetChoices = {
  "/images/cinema.jpg": "Cinéma",
  "/images/conference.jpeg": "Conférence",
  "/images/hackathon.jpg": "Hackathon",
  "/images/tenutradi.jpg": "Tenue traditionnelle",
  "/images/sport.jpg": "Sport",
  "/images/tournoi.jpeg": "Tournoi",
  "/images/scene.jpg": "Scène ouverte",
  "/images/culinaire.jpg": "Foire culinaire",
  "/images/im5.jpeg": "Photo du campus",
};
const numberFormat = new Intl.NumberFormat("fr-FR");
const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Porto-Novo",
});
const state = {
  sessions: [], activities: [], sessionId: "", view: "vue", results: null,
  resultsFailed: false, baseUrl: location.origin, customBaseUrl: false, admin: null, legacy: false,
  priority: null, priorityResults: null, priorityFailed: false, settingsTab: "annonce",
  records: { tab: "trace", q: "", kind: "", sessionId: "", page: 1 }, recordResult: null, recordsFailed: false,
};
let requestVersion = 0;
let priorityVersion = 0;
let recordsVersion = 0;
let authenticated = false;
let editorAction;

const roleLabels = { owner: "Responsable", organizer: "Organisation", viewer: "Consultation" };

function can(capability) {
  return state.admin?.capabilities?.includes(capability) === true;
}

function canEditSession(session) {
  return can("edit") && (session.status !== "archived" || can("archive"));
}

function canShareView() {
  return can("share") || can("export");
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

function icon(name) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(namespace, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

function button(label, action, options = {}) {
  return element("button", {
    class: "button " + (options.style || "outline"), type: "button", onclick: action,
  }, options.icon && icon(options.icon), label);
}

function link(label, href, options = {}) {
  return element("a", {
    class: "button outline", href, download: options.download, target: options.external ? "_blank" : null,
    rel: options.external ? "noopener" : null,
  }, options.icon && icon(options.icon), label);
}

function empty(title, message) {
  return element("div", { class: "empty" }, element("strong", {}, title), message && element("p", {}, message));
}

function panel(title, subtitle, ...content) {
  return element("article", { class: "panel" },
    element("header", { class: "panel-head" }, element("div", {},
      element("h2", {}, title), subtitle && element("p", {}, subtitle))),
    content);
}

function showMessage(target, message, isError = false) {
  target.textContent = message || "";
  target.hidden = !message;
  target.classList.toggle("error", isError);
}

async function api(url, method = "GET", data) {
  const response = await fetch(url, {
    method, headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(result.error || "Le service est momentanément indisponible."), { status: response.status });
  }
  return result;
}

function hideDashboard() {
  authenticated = false;
  state.admin = null;
  $("committee-identity").hidden = true;
  requestVersion += 1;
  state.sessions = [];
  state.activities = [];
  state.sessionId = "";
  state.results = null;
  state.priority = null;
  state.priorityResults = null;
  state.recordResult = null;
  priorityVersion += 1;
  recordsVersion += 1;
  $("content").replaceChildren();
  if ($("editor").open) $("editor").close();
  $("skip-link").hidden = true;
  $("app").hidden = true;
  $("boot").hidden = true;
  $("login").hidden = false;
}

function reportError(error, target = $("app-message")) {
  if (error.status === 401 && authenticated) {
    hideDashboard();
    showMessage($("login-error"), "Votre session a expiré. Connectez-vous de nouveau.", true);
    focusLogin();
    return;
  }
  showMessage(target, error.message, true);
}

function currentSession() {
  return state.sessions.find((session) => session.id === state.sessionId);
}

function status(session) {
  if (!session) return ["Aucune séance", "subtle"];
  if (session.status === "archived") return ["Archivée", ""];
  if (session.status === "draft") return ["Brouillon", "active"];
  if (session.voteOpen) return ["Vote ouvert", "live"];
  if (session.feedbackOpen) return ["Avis ouverts", "live"];
  return session.activityIds?.length ? ["Vote en pause", "active"] : ["Publiée", "live"];
}

function tag(label, style = "") {
  return element("span", { class: "tag " + style }, label);
}

function formatDate(value) {
  return value && Number.isFinite(Date.parse(value)) ? dateFormat.format(new Date(value)) : "—";
}

function sessionApi(id, suffix = "") {
  return "/api/admin/sessions/" + encodeURIComponent(id) + suffix;
}

function syncSelection() {
  const select = $("session-select");
  const options = [...state.sessions].sort((a, b) => {
    const rank = (session) => session.status === "archived" ? 2 : session.status === "draft" ? 1 : 0;
    return rank(a) - rank(b);
  });
  select.replaceChildren(...options.map((session) => element("option", {
    value: session.id, selected: session.id === state.sessionId,
  }, session.title)));
  if (!options.length) select.replaceChildren(element("option", {}, "Aucune séance"));
  select.disabled = !options.length;
}

async function loadResults() {
  const version = ++requestVersion;
  const id = state.sessionId;
  const content = $("content");
  content.setAttribute("aria-busy", "true");
  state.results = null;
  state.resultsFailed = false;
  render();
  try {
    const results = id && await api(sessionApi(id, "/results"));
    if (version === requestVersion) {
      state.results = results || null;
      render();
    }
  } catch (error) {
    if (version === requestVersion) {
      state.resultsFailed = true;
      reportError(error);
      if (authenticated) render();
    }
  } finally {
    if (version === requestVersion) content.setAttribute("aria-busy", "false");
  }
}

async function loadDashboard(preferred = state.sessionId) {
  const { activities, sessions, publicUrl } = await api("/api/admin/dashboard");
  if (!authenticated) return;
  if (!state.customBaseUrl && publicUrl) state.baseUrl = publicUrl;
  state.activities = activities;
  state.sessions = sessions;
  const defaultSession = sessions.find((session) => session.status === "published" && session.voteOpen)
    || sessions.find((session) => session.status === "published") || sessions[0];
  state.sessionId = sessions.some((session) => session.id === preferred) ? preferred : defaultSession?.id || "";
  syncSelection();
  await Promise.all([loadResults(), loadPriority(), state.view === "participations" && can("trace") ? loadRecords() : Promise.resolve()]);
}

function updateView() {
  const requested = location.hash.slice(1);
  const available = Object.hasOwn(views, requested) && (requested !== "partage" || canShareView())
    && (requested !== "participations" || can("trace"));
  state.view = available ? requested : "vue";
  if (authenticated) {
    render();
    if (state.view === "participations" && !state.recordResult) loadRecords();
  }
}

function navigate(view) {
  if (location.hash !== "#" + view) location.hash = view;
  else updateView();
}

function tile(name, value, iconName) {
  return element("div", { class: "metric" },
    element("span", { class: "icon-tile" }, icon(iconName)),
    element("strong", {}, value), element("span", {}, name));
}

function voteBars(entries, name, total) {
  return element("ul", { class: "bar-list" }, entries.map((entry) => {
    const percent = total ? Math.round(entry.count * 100 / total) : 0;
    const label = name(entry);
    return element("li", {}, element("div", { class: "bar-label" },
      element("span", {}, label),
      element("strong", {}, numberFormat.format(entry.count) + " · " + percent + " %")),
    element("progress", { value: percent, max: 100, "aria-label": label }));
  }));
}

const priorityStatuses = { draft: "Brouillon", active: "Actif", paused: "En pause", closed: "Arrêté" };
const responseKinds = { vote: "Vote", feedback: "Avis", guess: "Devinette", "priority-survey": "Fréquence et jour",
  "student.login": "Connexion étudiant", "student.register": "Inscription étudiant", "student.logout": "Déconnexion étudiant",
  "student.password-change": "Mot de passe modifié", "student.password-reset": "Mot de passe réinitialisé",
  "student.birthdate-share": "Date de naissance partagée",
  "admin.activity-create": "Activité créée", "admin.activity-update": "Activité modifiée", "admin.session-create": "Séance créée",
  "admin.session-update": "Séance modifiée", "admin.survey-update": "Sondage prioritaire modifié", "admin.image-upload": "Image importée",
  "admin.cinema-update": "Extrait cinéma modifié", "admin.feedback-moderation": "Avis modéré" };

async function loadPriority() {
  const version = ++priorityVersion;
  state.priorityFailed = false;
  try {
    const [config, results] = await Promise.all([api("/api/admin/priority-survey"), api("/api/admin/priority-survey/results")]);
    if (version !== priorityVersion || !authenticated) return;
    state.priority = config.survey || config;
    state.priorityResults = results;
  } catch (error) {
    if (version !== priorityVersion) return;
    state.priorityFailed = true;
    reportError(error);
  }
  if (authenticated) render();
}

function prioritySummary() {
  const survey = state.priority;
  return panel("À la une · fréquence des activités", "Le sondage à traiter en priorité avant de programmer les séances.",
    element("div", { class: "priority-summary" }, element("div", {},
      tag(priorityStatuses[survey?.status] || (state.priorityFailed ? "Indisponible" : "Chargement…"), survey?.status === "active" ? "live" : "active"),
      element("h3", { class: "spaced" }, survey?.title || "Fréquence et jour des activités"),
      element("p", { class: "muted spaced" }, numberFormat.format(state.priorityResults?.total || 0) + " réponses reçues")),
    button(can("edit") ? "Piloter ce sondage" : "Consulter les résultats", () => navigate("prioritaire"), { style: "primary", icon: "chart" })));
}

function priorityView() {
  const survey = state.priority;
  if (!survey) return [panel("Fréquence et jour des activités", null, empty(state.priorityFailed ? "Sondage indisponible" : "Chargement du sondage…"))];
  const result = state.priorityResults;
  const actions = element("div", { class: "button-row spaced" },
    can("edit") && button("Modifier le contenu", () => editPriority(survey)),
    can("edit") && survey.status !== "active" && button(survey.status === "paused" ? "Reprendre" : "Activer", () => changePriorityStatus("active"), { style: "primary" }),
    can("edit") && survey.status === "active" && button("Mettre en pause", () => changePriorityStatus("paused")),
    can("edit") && !["closed", "draft"].includes(survey.status) && button("Arrêter le sondage", () => stopPriority(survey), { style: "danger" }));
  const frequencyLabels = new Map((result?.frequency || []).map((item) => [item.value, item.label]));
  const weekdayLabels = new Map((result?.weekdays || []).map((item) => [item.value, item.label]));
  const rows = (result?.responses || []).map((item) => [item.name || "Étudiant", item.email || "—", item.frequencyLabel || frequencyLabels.get(item.frequency) || item.frequency,
    item.weekdayLabel || weekdayLabels.get(item.weekday) || item.weekday, ...(can("export") ? [formatBirthdate(item.birthdate)] : []), formatDate(item.createdAt)]);
  return [panel(survey.title, survey.description,
    tag(priorityStatuses[survey.status] || survey.status, survey.status === "active" ? "live" : "active"),
    element("h3", { class: "spaced" }, survey.question),
    element("p", { class: "muted spaced" }, survey.status === "active" ? "Les étudiants peuvent répondre. Une réponse est conservée par étudiant."
      : survey.status === "paused" ? "Le formulaire est temporairement suspendu. Les réponses sont conservées."
      : survey.status === "closed" ? "La collecte est arrêtée. Les réponses restent consultables." : "Le formulaire sera visible aux étudiants après activation."),
    survey.collectBirthdate && element("p", { class: "muted spaced" }, "Date de naissance demandée avec consentement : " + (survey.birthdatePurpose || "À préciser")), actions),
  element("div", { class: "metrics" }, tile("Réponses reçues", numberFormat.format(result?.total || 0), "chart"),
    tile("État de la collecte", priorityStatuses[survey.status] || survey.status, "broadcast"),
    tile("Jour préféré", "Du lundi au dimanche", "calendar")),
  element("div", { class: "results-grid" },
    panel("Fréquence souhaitée", null, result?.frequency?.length ? voteBars(result.frequency, (item) => item.label, result.total) : empty("Aucune réponse")),
    panel("Jour préféré", null, result?.weekdays?.length ? voteBars(result.weekdays, (item) => item.label, result.total) : empty("Aucune réponse"))),
  ...(can("trace") ? [panel("Réponses des étudiants", "Dates et heures affichées à Cotonou.",
    dataTable(["Étudiant", "Email", "Fréquence", "Jour", ...(can("export") ? ["Naissance"] : []), "Répondu le"], rows),
    (result?.total || 0) > rows.length && element("div", { class: "button-row spaced" },
      element("p", { class: "muted" }, "Les " + rows.length + " dernières réponses sont affichées."),
      button("Voir tout l’historique", () => {
        state.records = { tab: "trace", q: "", kind: "priority-survey", sessionId: "", page: 1 };
        state.recordResult = null;
        navigate("participations");
      })))] : []),
  ...(can("export") ? [panel("Exporter le sondage prioritaire", "Fréquence, jour préféré et réponses des étudiants.", element("div", { class: "button-row" },
    link("Excel (.xlsx)", "/api/admin/priority-survey/export/xlsx", { icon: "download", download: "" }),
    link("Word (.docx)", "/api/admin/priority-survey/export/docx", { icon: "download", download: "" })))] : [])];
}

function editPriority(survey) {
  const birthdate = checkbox("Demander la date de naissance (facultative, avec consentement)", "collectBirthdate", survey.collectBirthdate);
  const purpose = field("Pourquoi demander cette date ?", "textarea", { name: "birthdatePurpose", maxlength: 500 }, survey.birthdatePurpose,
    "Cette explication sera visible avant le consentement de l’étudiant.");
  const toggle = () => { purpose.hidden = !birthdate.querySelector("input").checked; };
  birthdate.addEventListener("change", toggle);
  toggle();
  editor("Configurer le sondage prioritaire", "Enregistrer", [
    field("Titre", "input", { name: "title", required: true, maxlength: 120 }, survey.title),
    field("Question", "input", { name: "question", required: true, maxlength: 180 }, survey.question),
    field("Présentation", "textarea", { name: "description", maxlength: 500 }, survey.description),
    element("p", { class: "muted" }, "Deux questions sont proposées : fréquence des activités et jour préféré dans la semaine."), birthdate, purpose,
  ], async (data) => {
    const collectBirthdate = data.has("collectBirthdate");
    if (collectBirthdate && String(data.get("birthdatePurpose")).trim().length < 12) throw new Error("Expliquez l’usage de la date de naissance en au moins 12 caractères avant d’activer cette collecte.");
    await api("/api/admin/priority-survey", "PUT", { title: data.get("title"), question: data.get("question"),
      description: data.get("description"), collectBirthdate, birthdatePurpose: data.get("birthdatePurpose"), status: survey.status });
    return { message: "Sondage prioritaire mis à jour." };
  });
}

async function changePriorityStatus(statusValue) {
  try {
    await api("/api/admin/priority-survey", "PUT", { status: statusValue });
    await loadPriority();
    showMessage($("app-message"), "Sondage " + (priorityStatuses[statusValue] || statusValue).toLocaleLowerCase("fr") + ".");
  } catch (error) { reportError(error); }
}

function stopPriority(survey) {
  editor("Arrêter le sondage prioritaire", "Arrêter", [element("p", { class: "muted" },
    "La collecte sera fermée. Les " + numberFormat.format(state.priorityResults?.total || 0) + " réponses reçues seront conservées.")], async () => {
    await api("/api/admin/priority-survey", "PUT", { status: "closed" });
    return { message: "Collecte arrêtée. Réponses conservées." };
  }, "danger");
}

function dataTable(headers, rows) {
  if (!rows.length) return empty("Aucune donnée pour le moment", "Les participations apparaîtront ici après leur enregistrement.");
  return element("div", { class: "table-scroll", tabindex: "0", role: "region", "aria-label": "Tableau des réponses" },
    element("table", { class: "data-table" }, element("thead", {}, element("tr", {}, headers.map((header) => element("th", { scope: "col" }, header)))),
      element("tbody", {}, rows.map((row) => element("tr", {}, row.map((cell) => element("td", {}, cell == null || cell === "" ? "—" : String(cell))))))));
}

function formatBirthdate(value) {
  if (!value) return "Non renseignée";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("fr-FR", { timeZone: "UTC" }) : "—";
}

function responsePanel(responses) {
  return panel("Qui a répondu à cette séance ?", "Votes, avis et devinettes, avec identité et date de participation.",
    dataTable(["Étudiant", "Email", "Type", "Réponse", "Participé le"], (responses || []).map((item) => [item.name || "Étudiant", item.email,
      responseKinds[item.kind] || item.kind, item.detail || [item.activityName, item.optionLabel, Number.isFinite(item.rating) ? item.rating + " / 5" : "", item.comment].filter(Boolean).join(" · "), formatDate(item.createdAt)])));
}

async function loadRecords() {
  if (!authenticated || !can("trace")) return;
  const version = ++recordsVersion;
  const filters = state.records;
  state.recordsFailed = false;
  state.recordResult = null;
  render();
  const query = new URLSearchParams({ q: filters.q, page: String(filters.page) });
  if (filters.tab === "trace") { query.set("kind", filters.kind); query.set("sessionId", filters.sessionId); }
  try {
    const result = await api("/api/admin/" + (filters.tab === "students" ? "students" : "trace") + "?" + query);
    if (version !== recordsVersion || !authenticated) return;
    state.recordResult = result;
  } catch (error) {
    if (version !== recordsVersion) return;
    state.recordsFailed = true;
    reportError(error);
  }
  if (authenticated) render();
}

function recordsView() {
  const filters = state.records;
  const tabs = tabBar([["trace", "Participations"], ["students", "Étudiants inscrits"]], filters.tab, (tab) => {
    state.records = { ...filters, tab, page: 1 }; loadRecords();
  });
  const search = field("Nom ou email", "input", { name: "q", type: "search", maxlength: 150, placeholder: "Rechercher un étudiant…" }, filters.q);
  const allSessions = [["", "Toutes les séances"], ...state.sessions.map((session) => [session.id, session.title])];
  const form = element("form", { class: "record-filters", onsubmit: (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    state.records = { ...filters, q: data.get("q").trim(), kind: data.get("kind") || "", sessionId: data.get("sessionId") || "", page: 1 };
    loadRecords();
  }}, search,
  ...(filters.tab === "trace" ? [selectField("Participation", "kind", [["", "Tous les types"], ...Object.entries(responseKinds)], filters.kind),
    selectField("Séance", "sessionId", allSessions, filters.sessionId)] : []),
  element("button", { class: "button primary", type: "submit" }, "Rechercher"));
  form.querySelectorAll("select").forEach((select) => { select.required = false; });
  const result = state.recordResult;
  const headers = filters.tab === "students" ? ["Nom", "Email", ...(can("export") ? ["Naissance"] : []), "Inscrit le"]
    : ["Étudiant", "Email", "Participation", "Séance / sondage", "Réponse", "Date et heure"];
  const rows = (result?.items || []).map((item) => filters.tab === "students"
    ? [item.name, item.email, ...(can("export") ? [formatBirthdate(item.birthdate)] : []), item.createdAt ? formatDate(item.createdAt) : "Non renseignée"]
    : [item.name || "Étudiant", item.email, responseKinds[item.kind] || item.kind,
      item.sessionTitle || (item.kind === "priority-survey" || item.kind === "admin.survey-update" ? state.priority?.title || "Sondage prioritaire" : item.kind?.startsWith("student.") ? "Compte étudiant" : "Administration"),
      typeof item.detail === "object" ? Object.values(item.detail || {}).filter(Boolean).join(" · ") : item.detail, formatDate(item.createdAt)]);
  return [tabs, panel(filters.tab === "students" ? "Annuaire étudiant" : "Historique des réponses", "Dates et heures à Cotonou (UTC+1).", form,
    result ? [element("p", { class: "muted spaced" }, numberFormat.format(result.total || 0) + " résultats"), dataTable(headers, rows), pagination(result)]
      : empty(state.recordsFailed ? "Chargement impossible" : "Chargement des participations…"))];
}

function pagination(result) {
  const page = Number(result.page) || 1;
  const pages = Math.max(1, Math.ceil((result.total || 0) / (result.pageSize || 50)));
  const previous = button("Précédent", () => { state.records.page = page - 1; loadRecords(); });
  const next = button("Suivant", () => { state.records.page = page + 1; loadRecords(); });
  previous.disabled = page <= 1;
  next.disabled = page >= pages;
  return element("div", { class: "pagination" }, previous, element("span", { class: "muted" }, "Page " + page + " sur " + pages), next);
}

function tabBar(options, current, action) {
  return element("nav", { class: "view-tabs", "aria-label": "Sous-rubriques" }, options.map(([value, label]) => {
    const control = button(label, () => action(value));
    if (value === current) control.setAttribute("aria-current", "page");
    return control;
  }));
}

function settingsView(session) {
  const options = [["annonce", "Annonce de la séance"], ...(canShareView() ? [["partage", can("export") ? "Liens, QR et exports" : "Liens et QR"]] : []), ["compte", "Mon accès"]];
  const tab = options.some(([id]) => id === state.settingsTab) ? state.settingsTab : "annonce";
  const tabs = tabBar(options, tab, (value) => { state.settingsTab = value; render(); });
  if (tab === "compte") return [tabs, panel("Accès au comité", null,
    element("dl", { class: "details" }, element("div", {}, element("dt", {}, "Compte"), element("dd", {}, state.admin?.username || "—")),
      element("div", {}, element("dt", {}, "Rôle"), element("dd", {}, roleLabels[state.admin?.role] || "—"))),
    element("p", { class: "muted" }, "Responsable : gestion complète et exports. Organisation : séances, activités et suivi des participations. Consultation : résultats agrégés."))];
  if (!session) return [tabs, empty("Aucune séance sélectionnée", "Créez une séance pour préparer les annonces et les liens de diffusion.")];
  return [tabs, ...(tab === "partage" ? shareView(session) : announcementView(session))];
}

function sessionControls(session) {
  const activities = (session.activityIds || []).map((id) => state.activities.find((activity) => activity.id === id)).filter(Boolean);
  return panel("Pilotage de la séance", "Les activités ci-dessous constituent les choix du sondage étudiant.",
    element("div", { class: "activity-tags" }, activities.map((activity) => tag(activity.name + (activity.archived ? " · archivée" : "")))),
    canEditSession(session) && element("div", { class: "button-row spaced" },
      button("Modifier la séance et ses activités", () => editSession(session)),
      session.status !== "archived" && button(session.voteOpen && session.status === "published" ? "Mettre le vote en pause" : "Activer le vote", () => changeSessionVote(session),
        { style: session.voteOpen && session.status === "published" ? "outline" : "primary" }),
      can("archive") && session.status !== "archived" && button("Arrêter et archiver", () => stopSession(session), { style: "danger" }),
      button("Préparer l’annonce", () => { state.settingsTab = "annonce"; navigate("parametres"); })));
}

async function changeSessionVote(session) {
  const opening = session.status !== "published" || !session.voteOpen;
  if (opening && !session.activityIds.some((id) => state.activities.some((activity) => activity.id === id && !activity.archived))) {
    showMessage($("app-message"), "Sélectionnez au moins une activité active avant d’ouvrir le vote.", true);
    editSession(session);
    return;
  }
  try {
    await api(sessionApi(session.id), "PUT", { status: "published", voteOpen: opening });
    await loadDashboard(session.id);
    showMessage($("app-message"), opening ? "Vote actif : les étudiants peuvent répondre." : "Vote en pause. Les réponses sont conservées.");
  } catch (error) { reportError(error); }
}

function stopSession(session) {
  editor("Arrêter et archiver la séance", "Arrêter et archiver", [element("p", { class: "muted" },
    "Le vote, les avis et la diffusion de cette séance seront fermés. Les réponses et exports seront conservés.")], async () => {
    await api(sessionApi(session.id), "PUT", { status: "archived", voteOpen: false, feedbackOpen: false });
    return { message: "Séance arrêtée et archivée.", sessionId: session.id };
  }, "danger");
}

function cinemaPanel(session) {
  const cinema = session.cinema;
  return panel("Projection cinéma", "Un extrait de 25 à 30 minutes et, si souhaité, un lien pour voir le film complet.",
    cinema ? [tag(cinema.enabled ? "Projection activée" : "Projection en pause", cinema.enabled ? "live" : "active"),
      element("h3", { class: "spaced" }, cinema.title),
      element("p", { class: "muted spaced" }, cinema.durationSeconds > 0 ? "Durée vérifiée : " + Math.round(cinema.durationSeconds / 60) + " min" : "Durée contrôlée lors de l’activation"),
      element("video", { class: "cinema-preview", controls: true, preload: "none", src: cinema.clipUrl, "aria-label": cinema.title }),
      cinema.fullUrl && link("Voir le film complet", cinema.fullUrl, { external: true, icon: "external" })]
      : empty("Aucun extrait configuré", "Ajoutez l’URL directe d’un fichier MP4 pour proposer la projection sur la page étudiante."),
    canEditSession(session) && element("div", { class: "button-row spaced" }, button(cinema ? "Modifier l’extrait" : "Configurer un extrait", () => editCinema(session)),
      cinema && button(cinema.enabled ? "Désactiver" : "Activer", () => toggleCinema(session)),
      cinema && button("Retirer l’extrait", () => removeCinema(session), { style: "danger" })));
}

function removeCinema(session) {
  editor("Retirer l’extrait de cette séance", "Retirer", [element("p", { class: "muted" },
    "La projection et le lien du film complet seront retirés de la page étudiante.")], async () => {
    await api(sessionApi(session.id), "PUT", { cinema: null });
    return { message: "Extrait retiré de la séance.", sessionId: session.id };
  }, "danger");
}

function editCinema(session) {
  const cinema = session.cinema;
  editor("Configurer la projection cinéma", "Vérifier et enregistrer", [
    field("Titre de la projection", "input", { name: "title", required: true, maxlength: 160 }, cinema?.title || "Projection cinéma"),
    field("URL HTTPS directe du fichier MP4", "input", { name: "clipUrl", type: "url", required: true, maxlength: 2000 }, cinema?.clipUrl,
      "Hébergez l’extrait sur votre service vidéo. La durée réelle est vérifiée à l’enregistrement : 30 minutes maximum."),
    field("Lien du film complet (facultatif)", "input", { name: "fullUrl", type: "url", maxlength: 2000 }, cinema?.fullUrl),
    checkbox("Rendre la projection disponible aux étudiants", "enabled", cinema?.enabled ?? true),
    element("p", { class: "muted" }, "Prévoyez un extrait de 25 à 30 minutes dont vous pouvez diffuser le contenu."),
  ], async (data) => {
    await api(sessionApi(session.id), "PUT", { cinema: { title: data.get("title"), clipUrl: data.get("clipUrl"), fullUrl: data.get("fullUrl"), enabled: data.has("enabled") } });
    return { message: "Projection vérifiée et enregistrée.", sessionId: session.id };
  });
}

async function toggleCinema(session) {
  try {
    await api(sessionApi(session.id), "PUT", { cinema: { ...session.cinema, enabled: !session.cinema.enabled } });
    await loadDashboard(session.id);
    showMessage($("app-message"), session.cinema.enabled ? "Projection désactivée." : "Projection activée.");
  } catch (error) { reportError(error); }
}

function overallPanel(results) {
  const votes = results?.votes || [];
  const total = votes.reduce((sum, vote) => sum + vote.count, 0);
  const content = !results
    ? empty(state.resultsFailed ? "Résultats indisponibles" : "Chargement des résultats…")
    : total
      ? voteBars([...votes].sort((a, b) => b.count - a.count), (vote) => vote.name, total)
      : empty("Aucun vote pour cette séance", "Les réponses apparaîtront ici dès le premier vote.");
  return panel("Choix de la prochaine activité", null, content);
}

function overview(session, results) {
  const priority = prioritySummary();
  const [statusLabel, statusStyle] = status(session);
  let primaryAction;
  if (session) {
    if (session.status === "draft" && canEditSession(session)) primaryAction = ["Modifier le brouillon", () => editSession(session), "chart"];
    else if (session.status === "published" && session.voteOpen && can("share")) primaryAction = ["Partager le sondage", () => navigate("partage"), "share"];
    else if (session.status === "published" && session.feedbackOpen) primaryAction = ["Consulter les avis", () => navigate("avis"), "comment"];
    else if (session.status !== "published" || (session.voteOpen && !can("share"))) primaryAction = ["Voir les résultats", () => navigate("sondages"), "chart"];
    else {
      const label = canEditSession(session) ? (session.announcement ? "Gérer l’annonce" : "Préparer l’annonce") : "Consulter les annonces";
      primaryAction = [label, () => navigate("annonce"), "broadcast"];
    }
  }
  const lead = session
    ? element("div", { class: "focus-card" }, element("div", {},
      tag(statusLabel, statusStyle), element("h2", {}, session.title),
      session.description && element("p", {}, session.description),
      element("div", { class: "button-row" },
        button(primaryAction[0], primaryAction[1], { style: "primary", icon: primaryAction[2] }),
        !["draft", "archived"].includes(session.status) && primaryAction[2] !== "chart"
          && button(canEditSession(session) ? "Gérer le sondage" : "Consulter le sondage", () => navigate("sondages"), { icon: "chart" }))))
    : element("div", { class: "focus-card" }, element("div", {}, tag("Aucune séance", "subtle"),
      element("h2", {}, can("edit") ? "Préparez votre première séance" : "Aucune séance à consulter"),
      can("edit") && element("p", {}, "Choisissez les activités que vous souhaitez proposer au vote.")));
  if (!session) return [priority, lead];
  const votes = results?.votes.reduce((sum, vote) => sum + vote.count, 0);
  const count = (value) => value === undefined ? "—" : numberFormat.format(value);
  return [
    priority,
    lead,
    element("div", { class: "metrics" },
      tile("Votes reçus", count(votes), "chart"),
      tile("Avis reçus", count(results?.feedback.length), "comment"),
      tile("Tentatives de devinette", count(results?.guesses), "broadcast")),
    overallPanel(results),
  ];
}

function surveyView(session, results) {
  const list = element("div", { class: "session-list" }, state.sessions.map((entry) => {
    const [label, style] = status(entry);
    return element("div", { class: "session-row" },
      element("div", {}, element("h3", {}, entry.title), tag(label, style),
        element("p", { class: "muted spaced" }, (entry.activityIds || []).map((id) => state.activities.find((activity) => activity.id === id)?.name).filter(Boolean).join(" · ") || "Aucune activité sélectionnée")),
      element("div", { class: "button-row" },
        entry.id === state.sessionId ? null : button("Consulter", () => selectSession(entry.id)),
        canEditSession(entry) && button("Modifier", () => editSession(entry))));
  }));
  const items = [panel("Toutes les séances", null, state.sessions.length ? list : empty("Aucun sondage créé"))];
  if (!session) return items;
  items.push(sessionControls(session), overallPanel(results));
  const detailed = results?.votes.filter((entry) => entry.options.length) || [];
  if (detailed.length) {
    const selector = element("select", { "aria-label": "Activité à détailler" }, detailed.map((entry) =>
      element("option", { value: entry.activityId }, entry.name)));
    const detail = element("div");
    function showDetails() {
      const selected = detailed.find((entry) => entry.activityId === selector.value) || detailed[0];
      const total = selected.options.reduce((sum, option) => sum + option.count, 0);
      detail.replaceChildren(total ? voteBars(selected.options, (option) => option.label, total)
        : empty("Aucune réponse à cette question"));
    }
    selector.addEventListener("change", showDetails);
    showDetails();
    items.push(panel("Détail par activité", null, element("label", {}, "Activité", selector), detail));
  }
  items.push(cinemaPanel(session));
  if (can("trace")) items.push(responsePanel(results?.responses));
  items.push(...feedbackView(results));
  return items;
}

function activitiesView() {
  if (!state.activities.length) return [panel("Catalogue des activités", null, empty("Aucune activité", can("edit") ? "Créez votre première activité pour la proposer dans un sondage." : null))];
  const cards = [...state.activities].sort((a, b) => Number(a.archived) - Number(b.archived)).map((activity) =>
    element("article", { class: "catalog-card" },
      element("img", { src: activity.image || "/images/im5.jpeg", alt: "", loading: "lazy", width: 500, height: 225 }),
      element("div", {}, activity.archived && tag("Archivée"),
        element("h2", {}, activity.name), activity.description && element("p", {}, activity.description),
        activity.question && element("p", { class: "catalog-question" }, activity.question),
        element("span", { class: "muted" }, activity.options.length + " réponses proposées")),
      (can("edit") || can("archive")) && element("footer", { class: "button-row" },
        can("edit") && (!activity.archived || can("archive")) && button("Modifier", () => editActivity(activity)),
        can("archive") && button(activity.archived ? "Réactiver" : "Archiver", () => archiveActivity(activity), { style: "ghost" }))));
  return [element("div", { class: "catalog" }, cards)];
}

function feedbackView(results) {
  if (!results) return [panel("Retours de la séance", null,
    empty(state.resultsFailed ? "Avis indisponibles" : "Chargement des avis…"))];
  const feedback = results.feedback;
  if (!feedback.length) return [panel("Retours de la séance", null, empty("Aucun avis reçu"))];
  const scores = feedback.filter((item) => Number.isFinite(item.rating));
  const average = scores.length && (scores.reduce((sum, item) => sum + item.rating, 0) / scores.length);
  return [panel("Retours de la séance", average ? numberFormat.format(Number(average.toFixed(1))) + " / 5 en moyenne" : null,
    element("div", { class: "response-list" }, feedback.map((item) => element("article", { class: "response" },
      element("div", { class: "response-content" },
        Number.isFinite(item.rating) && element("span", { class: "response-rating" }, item.rating + " / 5"),
        element("time", { class: "muted response-date", datetime: item.createdAt }, formatDate(item.createdAt)),
        item.comment && element("p", { class: "response-comment" }, item.comment)),
      element("div", { class: "button-row" },
        item.hidden && tag("Masqué"),
        can("moderate") && button(item.hidden ? "Rétablir" : "Masquer", (event) => moderateFeedback(event.currentTarget, item)))))))];
}

async function moderateFeedback(control, item) {
  const id = state.sessionId;
  control.disabled = true;
  try {
    await api(sessionApi(id, "/feedback/" + encodeURIComponent(item.id)), "PUT", { hidden: !item.hidden });
    if (state.sessionId === id) await loadResults();
    showMessage($("app-message"), item.hidden ? "Avis rétabli." : "Avis masqué.");
  } catch (error) {
    reportError(error);
  } finally {
    control.disabled = false;
  }
}

function announcementView(session) {
  const announcement = session.announcement;
  if (!announcement) return [panel("Annonce de la séance", null,
    empty("Aucune annonce préparée", canEditSession(session) ? "Ajoutez l’activité retenue, sa date et son lieu." : null),
    canEditSession(session) && element("div", { class: "button-row spaced" }, button("Préparer l’annonce", () => editAnnouncement(session),
      { style: "primary", icon: "broadcast" })))];
  const activity = state.activities.find((entry) => entry.id === announcement.activityId);
  const mystery = announcement.mode === "surprise";
  const hidden = mystery && (!announcement.revealAt || Date.parse(announcement.revealAt) > Date.now());
  const headline = hidden ? "Activité mystère" : activity?.name || "Prochaine séance";
  const [statusLabel, mood] = session.status === "published" ? ["Annonce publiée", "live"] : ["Annonce préparée", "active"];
  const details = [
    ["Activité retenue", activity?.name || "—"],
    ["Date et heure", formatDate(announcement.date)],
    ["Lieu", announcement.location || "—"],
    ["Mode", mystery ? "Surprise" : "Standard"],
  ];
  if (mystery) details.push(["Indice", announcement.hint || "—"], ["Révélation", formatDate(announcement.revealAt)]);
  return [
    element("div", { class: "focus-card" }, element("div", {}, tag(statusLabel, mood),
      element("h2", {}, headline), element("p", {}, formatDate(announcement.date) + " · " + (announcement.location || "Lieu à préciser")),
      hidden && announcement.hint && element("p", {}, announcement.hint))),
    panel("Paramètres de l’annonce", null,
      element("dl", { class: "details" }, details.map(([label, value]) =>
        element("div", {}, element("dt", {}, label), element("dd", {}, value)))),
      canEditSession(session) && element("div", { class: "button-row" },
        button("Modifier l’annonce", () => editAnnouncement(session), { style: "primary" }),
        button("Retirer l’annonce", () => removeAnnouncement(session), { style: "danger" }))),
  ];
}

const shareLinks = [
  ["vote", "Sondage", "Ouvre le vote pour la prochaine activité."],
  ["avis", "Avis sur la séance", "Ouvre le formulaire de retour étudiant."],
  ["annonce", "Annonce", "Ouvre la page de la séance annoncée."],
];

function publicUrl(kind, sessionId) {
  const url = new URL("/", state.baseUrl);
  url.searchParams.set("vue", kind);
  url.searchParams.set("seance", sessionId);
  return url.href;
}

function shareView(session) {
  const exportPanel = can("export") ? [panel("Exporter les réponses", "Les fichiers contiennent les résultats de la séance sélectionnée.",
    element("div", { class: "button-row" },
      link("Excel (.xlsx)", sessionApi(session.id, "/export/xlsx"), { icon: "download", download: "" }),
      link("Word (.docx)", sessionApi(session.id, "/export/docx"), { icon: "download", download: "" })))] : [];
  if (!can("share")) return exportPanel;
  if (session.status !== "published") {
    return [panel("Liens et QR codes", null,
      empty("Cette séance n’est pas publiée", "Publiez-la depuis Sondages pour partager les liens avec les étudiants.")), ...exportPanel];
  }
  const origin = element("input", { type: "url", value: state.baseUrl, name: "origin", required: true });
  const originForm = element("form", { class: "flat-form", onsubmit: (event) => {
    event.preventDefault();
    try {
      const url = new URL(origin.value.trim());
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.pathname !== "/" || url.search || url.hash) throw new Error("origin");
      state.baseUrl = url.origin;
      state.customBaseUrl = true;
      render();
      showMessage($("app-message"), "Adresse de partage actualisée.");
      $("share-origin").focus();
    } catch {
      showMessage($("app-message"), "Saisissez l’adresse du site, sans chemin ni paramètres.", true);
      origin.focus();
    }
  }}, element("label", { for: "share-origin" }, "Adresse du site accessible aux étudiants", origin),
  element("button", { class: "button outline", type: "submit" }, "Mettre à jour"));
  origin.id = "share-origin";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(state.baseUrl).hostname);
  const qrCards = shareLinks.map(([kind, title, description]) => {
    const valid = kind === "vote" ? session.voteOpen : kind === "avis" ? session.feedbackOpen : Boolean(session.announcement);
    const qrUrl = sessionApi(session.id, "/qr/" + kind) + "?baseUrl=" + encodeURIComponent(state.baseUrl);
    const href = publicUrl(kind, session.id);
    const urlInput = element("input", { type: "url", readonly: true, value: href, "aria-label": "Lien " + title });
    return element("article", { class: "qr-card" }, element("h2", {}, title),
      element("p", {}, description), valid ? [
        element("img", { src: qrUrl, alt: "QR code " + title, width: 154, height: 154, loading: "lazy" }), urlInput,
        element("div", { class: "button-row" },
          button("Copier le lien", () => copyLink(urlInput)),
          link("PNG", qrUrl, { icon: "download", download: kind + "-" + session.id + ".png" })),
      ] : empty("Indisponible", kind === "annonce" ? "Préparez l’annonce de cette séance." : "Ouvrez ce formulaire depuis Sondages."));
  });
  return [
    panel("Adresse de diffusion", local ? "Une adresse locale ne s’ouvre pas sur les téléphones. Indiquez l’adresse réseau ou publique du site." : null, originForm),
    element("div", { class: "qr-grid" }, qrCards),
    ...exportPanel,
  ];
}

async function copyLink(input) {
  try {
    if (!navigator.clipboard) throw new Error("Clipboard");
    await navigator.clipboard.writeText(input.value);
    showMessage($("app-message"), "Lien copié.");
  } catch {
    input.focus();
    input.select();
    showMessage($("app-message"), "Lien sélectionné. Copiez-le avec le raccourci habituel.");
  }
}

function render() {
  const view = state.view;
  const session = currentSession();
  const { title, intro } = views[view];
  const pageTitle = view === "partage" && !can("export") ? "Partage" : title;
  const readOnlyIntro = { sondages: "Consultez les séances et le détail des réponses.",
    activites: "Consultez les activités proposées et leurs questions.", annonce: "Consultez les annonces des séances." };
  $("current-page").textContent = pageTitle;
  $("page-title").textContent = pageTitle;
  $("page-intro").textContent = view === "partage" && !can("export") ? "Diffusez les liens de participation."
    : (!can("edit") && readOnlyIntro[view]) || intro;
  $("session-bar").hidden = ["activites", "prioritaire", "participations"].includes(view);
  $("new-button").hidden = !can("edit") || !["vue", "sondages", "activites"].includes(view);
  $("new-button-label").textContent = view === "activites" ? "Nouvelle activité" : "Nouveau sondage";
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.hidden = (link.dataset.view === "partage" && !canShareView()) || (link.dataset.view === "participations" && !can("trace"));
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const renderers = {
    vue: () => overview(session, state.results),
    sondages: () => surveyView(session, state.results),
    activites: activitiesView,
    prioritaire: priorityView,
    participations: recordsView,
    parametres: () => settingsView(session),
    avis: () => feedbackView(state.results),
    annonce: () => announcementView(session),
    partage: () => shareView(session),
  };
  const content = !session && ["avis", "annonce", "partage"].includes(view)
    ? [empty("Aucune séance sélectionnée", can("edit") ? "Créez une séance dans Sondages pour accéder à cette rubrique." : null)]
    : renderers[view]();
  $("content").replaceChildren(...content);
}

function editor(title, buttonText, fields, action, style = "primary") {
  $("editor-title").textContent = title;
  $("editor-submit").textContent = buttonText;
  $("editor-submit").className = "button " + style;
  $("editor-fields").replaceChildren(...fields);
  showMessage($("editor-error"), "");
  editorAction = action;
  $("editor").showModal();
}

function field(label, tagName, attributes, value, help) {
  const input = element(tagName, attributes, tagName === "textarea" ? value || "" : null);
  if (tagName === "input" && value != null) input.value = value;
  return element("label", {}, label, input, help && element("small", {}, help));
}

function selectField(label, name, options, value, help) {
  const select = element("select", { name, required: true }, options.map(([key, title]) =>
    element("option", { value: key, selected: key === value }, title)));
  return element("label", {}, label, select, help && element("small", {}, help));
}

function checkbox(label, name, checked, value) {
  return element("label", { class: "checkbox" },
    element("input", { type: "checkbox", name, checked, value }), label);
}

function assetField(activity) {
  const initial = activity?.image || "/images/im5.jpeg";
  const imageUrl = field("Chemin ou URL HTTPS de l’image", "input", { name: "image", required: true, maxlength: 2000 }, initial,
    "Collez une adresse d’image ou choisissez un fichier ci-dessous.");
  const library = selectField("Images du campus", "imageChoice", [["", "Choisir une image…"], ...Object.entries(assetChoices)], "");
  library.querySelector("select").required = false;
  const upload = field("Importer une image", "input", { name: "imageFile", type: "file", accept: "image/jpeg,image/png,image/webp" }, null,
    "JPG, PNG ou WebP · 5 Mo maximum. L’image sera conservée sur le serveur.");
  const preview = element("img", { class: "image-preview", src: initial, alt: "Aperçu du visuel de l’activité", width: 460, height: 180 });
  let objectUrl;
  const release = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined; };
  $("editor").addEventListener("close", release, { once: true });
  imageUrl.querySelector("input").addEventListener("change", (event) => {
    release();
    upload.querySelector("input").value = "";
    upload.querySelector("input").setCustomValidity("");
    preview.src = event.currentTarget.value.trim();
  });
  library.addEventListener("change", () => {
    const value = library.querySelector("select").value;
    if (!value) return;
    imageUrl.querySelector("input").value = value;
    imageUrl.querySelector("input").dispatchEvent(new Event("change"));
  });
  upload.addEventListener("change", () => {
    const input = upload.querySelector("input");
    const file = input.files[0];
    input.setCustomValidity("");
    if (!file) return;
    if (file.size > 5 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      input.setCustomValidity("Choisissez une image JPG, PNG ou WebP de 5 Mo maximum.");
      input.reportValidity();
      return;
    }
    release();
    objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
  });
  return element("fieldset", { class: "image-field stack" }, element("legend", {}, "Visuel de l’activité"), preview, library, imageUrl, upload);
}

function optionsField(activity) {
  const container = element("div", { class: "option-editor" });
  const add = button("Ajouter une réponse", () => appendOption(""), { icon: "plus" });
  const summary = element("p", { class: "muted" });
  function sync() {
    const rows = [...container.children];
    summary.textContent = rows.length + " réponses sur 8 · minimum 2";
    add.disabled = rows.length >= 8;
    rows.forEach((row, index) => {
      row.querySelector("label span").textContent = "Réponse " + (index + 1);
      row.querySelector("button").disabled = rows.length <= 2;
    });
  }
  function appendOption(value) {
    if (container.children.length >= 8) return;
    const label = element("label", {}, element("span"), element("input", { name: "options", value, required: true, maxlength: 120 }));
    const row = element("div", { class: "option-row" }, label,
      button("Retirer", () => { row.remove(); sync(); }, { style: "ghost" }));
    container.append(row);
    sync();
  }
  const labels = activity?.options.map((option) => option.label) || ["", ""];
  labels.forEach(appendOption);
  return element("fieldset", { class: "stack" }, element("legend", {}, "Réponses au sondage"), container, summary,
    element("div", { class: "button-row" }, add));
}

async function activityImage(data) {
  const file = data.get("imageFile");
  if (!(file instanceof File) || !file.size) return data.get("image");
  if (file.size > 5 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choisissez une image JPG, PNG ou WebP de 5 Mo maximum.");
  const response = await fetch("/api/admin/uploads/images", { method: "POST", headers: { "Content-Type": file.type }, body: file });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || "L’image n’a pas pu être importée."), { status: response.status });
  return result.url;
}

function editActivity(activity) {
  const fields = [
    field("Nom", "input", { name: "name", required: true, maxlength: 90 }, activity?.name),
    field("Description", "textarea", { name: "description", maxlength: 350 }, activity?.description),
    assetField(activity),
    field("Question affichée après le choix", "input", { name: "question", required: true, maxlength: 160 }, activity?.question),
    optionsField(activity),
  ];
  editor(activity ? "Modifier l’activité" : "Nouvelle activité", activity ? "Enregistrer" : "Créer l’activité", fields, async (data) => {
    const labels = data.getAll("options").map((label) => label.trim()).filter(Boolean);
    if (labels.length < 2 || labels.length > 8
      || new Set(labels.map((label) => label.toLocaleLowerCase("fr"))).size !== labels.length) {
      throw new Error("Ajoutez de deux à huit réponses différentes.");
    }
    const existing = new Map(activity?.options.map((option) => [option.label, option.id]) || []);
    const values = {
      name: data.get("name"),
      description: data.get("description"),
      image: await activityImage(data),
      question: data.get("question"),
      options: labels.map((label) => ({ id: existing.get(label), label })),
    };
    await api("/api/admin/activities" + (activity ? "/" + encodeURIComponent(activity.id) : ""), activity ? "PUT" : "POST", values);
    return { message: activity ? "Activité mise à jour." : "Activité créée." };
  });
}

function archiveActivity(activity) {
  const restore = activity.archived;
  const closesVote = !restore && state.sessions.some((session) => session.status === "published" && session.voteOpen
    && session.activityIds.includes(activity.id) && !state.activities.some((entry) => entry.id !== activity.id
      && !entry.archived && session.activityIds.includes(entry.id)));
  editor((restore ? "Réactiver " : "Archiver ") + activity.name, restore ? "Réactiver" : "Archiver",
    [element("p", { class: "muted" }, restore
      ? "L’activité pourra de nouveau être ajoutée aux sondages."
      : "L’activité quittera les sondages. Les réponses déjà reçues resteront consultables."),
    closesVote && element("p", { class: "form-message error" }, "Les votes où elle est le seul choix actif seront fermés.")].filter(Boolean),
    async () => {
      await api("/api/admin/activities/" + encodeURIComponent(activity.id), "PUT", { archived: !restore });
      return { message: restore ? "Activité réactivée." : "Activité archivée." };
    }, restore ? "primary" : "danger");
}

function editSession(session) {
  const selected = new Set(session?.activityIds || state.activities.filter((activity) => !activity.archived).map((activity) => activity.id));
  const eligible = state.activities.filter((activity) => !activity.archived || selected.has(activity.id));
  const activities = element("fieldset", {},
    element("legend", {}, "Activités proposées au vote"),
    element("p", { class: "muted" }, "Chaque activité cochée apparaît comme un choix sur le site étudiant."),
    eligible.length > 0 && element("div", { class: "button-row spaced" }, button("Tout sélectionner", () => activities.querySelectorAll("input").forEach((input) => { input.checked = true; })),
      button("Tout désélectionner", () => activities.querySelectorAll("input").forEach((input) => { input.checked = false; }))),
    eligible.length ? eligible.map((activity) =>
      checkbox(activity.name + (activity.archived ? " (archivée)" : ""), "activityIds", selected.has(activity.id), activity.id))
      : element("p", { class: "muted" }, "Ajoutez une activité au catalogue pour ouvrir le vote."));
  const availability = element("fieldset", {}, element("legend", {}, "Formulaires de la séance"),
    checkbox("Ouvrir le vote", "voteOpen", session?.voteOpen ?? eligible.length > 0),
    checkbox("Recueillir les avis", "feedbackOpen", session?.feedbackOpen ?? false));
  const fields = [
    field("Titre de la séance", "input", { name: "title", required: true, maxlength: 120 }, session?.title),
    field("Texte visible par les étudiants", "textarea", { name: "description", maxlength: 500 }, session?.description),
    selectField("Publication", "status", [
      (session?.status !== "published" || can("archive")) && ["draft", "Brouillon"],
      ["published", "Publiée"],
      can("archive") && ["archived", "Archivée"],
    ].filter(Boolean), session?.status || "draft", "Une séance publiée est accessible sur le site étudiant et par ses liens de partage."),
    activities, availability,
  ];
  editor(session ? "Modifier le sondage" : "Nouveau sondage", session ? "Enregistrer" : "Créer la séance", fields, async (data) => {
    const activityIds = data.getAll("activityIds");
    const voteOpen = data.has("voteOpen");
    if (voteOpen && !activityIds.length) throw new Error("Sélectionnez une activité pour ouvrir le vote.");
    const values = {
      title: data.get("title"), description: data.get("description"), status: data.get("status"),
      activityIds, voteOpen, feedbackOpen: data.has("feedbackOpen"),
    };
    const saved = await api(session ? sessionApi(session.id) : "/api/admin/sessions", session ? "PUT" : "POST", values);
    return { message: session ? "Sondage mis à jour." : "Séance créée.", sessionId: saved.id || session?.id };
  });
}

function campusInputDate(iso) {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return new Date(Date.parse(iso) + 60 * 60 * 1000).toISOString().slice(0, 16);
}

function campusIsoDate(value) {
  if (!value) return null;
  const parsed = Date.parse(value + ":00+01:00");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function editAnnouncement(session) {
  const current = session.announcement;
  const catalog = state.activities.filter((activity) => !activity.archived || current?.activityId === activity.id)
    .sort((a, b) => Number(session.activityIds.includes(b.id)) - Number(session.activityIds.includes(a.id)));
  if (!catalog.length) {
    showMessage($("app-message"), "Ajoutez d’abord une activité dans le catalogue.", true);
    return;
  }
  const choice = selectField("Activité retenue", "activityId", catalog.map((activity) => [activity.id, activity.name]),
    current?.activityId || catalog[0].id);
  const mode = selectField("Mode d’annonce", "mode", [["normal", "Standard"], ["surprise", "Activité mystère"]], current?.mode || "normal");
  const date = field("Date et heure à Cotonou", "input", {
    type: "datetime-local", name: "date", required: true, min: "1000-01-01T00:00", max: "9999-12-31T23:59",
  },
    campusInputDate(current?.date));
  const venue = field("Lieu", "input", { name: "location", required: true, maxlength: 180 }, current?.location);
  const surpriseDetails = element("div", { class: "stack" },
    field("Indice visible par les étudiants", "textarea", { name: "hint", maxlength: 300 }, current?.hint),
    field("Révélation à Cotonou", "input", {
      type: "datetime-local", name: "revealAt", min: "1000-01-01T00:00", max: "9999-12-31T23:59",
    },
      campusInputDate(current?.revealAt), "Sans date de révélation, l’activité reste masquée jusqu’à la modification de l’annonce."));
  const preview = element("article", { class: "announcement-preview" }, element("p", {}, "Aperçu étudiant"),
    element("strong"), element("span"));
  const [previewTitle, previewDetails] = preview.querySelectorAll("strong, span");
  const updatePreview = () => {
    const mystery = mode.querySelector("select").value === "surprise";
    const revealAt = campusIsoDate(surpriseDetails.querySelector("[name=revealAt]").value);
    const hidesActivity = mystery && (!revealAt || Date.parse(revealAt) > Date.now());
    const clue = surpriseDetails.querySelector("[name=hint]").value.trim();
    const starts = campusIsoDate(date.querySelector("input").value);
    const location = venue.querySelector("input").value.trim();
    const selected = choice.querySelector("select").value;
    surpriseDetails.hidden = !mystery;
    previewTitle.textContent = hidesActivity ? "Activité mystère" : catalog.find((entry) => entry.id === selected)?.name || "Prochaine séance";
    const parts = [starts && formatDate(starts), location, hidesActivity && clue].filter(Boolean);
    previewDetails.textContent = parts.join(" · ");
  };
  for (const field of [choice, mode, date, venue, surpriseDetails]) field.addEventListener("input", updatePreview);
  updatePreview();
  const canPublish = session.status === "published";
  editor("Préparer l’annonce", canPublish ? "Publier l’annonce" : "Enregistrer l’annonce",
    [choice, element("div", { class: "form-pair" }, date, venue), mode, surpriseDetails, preview],
    async (data) => {
      const mystery = data.get("mode") === "surprise";
      const values = {
        activityId: data.get("activityId"),
        date: campusIsoDate(data.get("date")),
        location: data.get("location"),
        mode: data.get("mode"),
        hint: mystery ? data.get("hint") : "",
        revealAt: mystery ? campusIsoDate(data.get("revealAt")) : null,
      };
      if (values.revealAt && values.revealAt > values.date) {
        throw new Error("La révélation doit être prévue avant la séance ou à l’heure de celle-ci.");
      }
      await api(sessionApi(session.id), "PUT", { announcement: values });
      return {
        message: canPublish ? "Annonce publiée." : "Annonce enregistrée. Publiez la séance depuis Sondages pour la diffuser.",
        sessionId: session.id,
      };
    });
}

function removeAnnouncement(session) {
  editor("Retirer l’annonce", "Retirer", [
    element("p", { class: "muted" }, "Le lien d’annonce de cette séance n’affichera plus l’activité ni la date."),
  ], async () => {
    await api(sessionApi(session.id), "PUT", { announcement: null });
    return { message: "Annonce retirée.", sessionId: session.id };
  }, "danger");
}

async function selectSession(id) {
  state.sessionId = id;
  $("session-select").value = id;
  showMessage($("app-message"), "");
  await loadResults();
}

function configureLogin(session) {
  state.legacy = session.legacy === true;
  $("admin-login-user").hidden = state.legacy;
  const input = $("login-form").elements.username;
  input.disabled = state.legacy;
  input.required = !state.legacy;
}

function focusLogin() {
  const inputs = $("login-form").elements;
  (state.legacy ? inputs.password : inputs.username).focus();
}

async function showDashboard(admin) {
  state.admin = admin || null;
  $("committee-user").textContent = admin?.username || "";
  $("committee-role").textContent = roleLabels[admin?.role] || "";
  $("committee-identity").hidden = !admin;
  authenticated = true;
  $("skip-link").hidden = false;
  $("app").hidden = false;
  $("login").hidden = true;
  $("boot").hidden = true;
  updateView();
  try {
    await loadDashboard();
  } catch (error) {
    reportError(error);
  }
}

async function start() {
  try {
    const session = await api("/api/admin/session");
    configureLogin(session);
    if (session.authenticated) await showDashboard(session.admin);
    else {
      hideDashboard();
      if (!session.configured) {
        showMessage($("login-error"), "Configurez les comptes du comité sur le serveur.", true);
      }
      focusLogin();
    }
  } catch {
    $("boot").replaceChildren("Connexion au serveur impossible. ",
      button("Réessayer", start));
  }
}

$("editor").setAttribute("aria-labelledby", "editor-title");
$("skip-link").addEventListener("click", (event) => {
  event.preventDefault();
  $("dashboard").focus();
  $("dashboard").scrollIntoView();
});
$("editor-close").addEventListener("click", () => $("editor").close());
$("editor-cancel").addEventListener("click", () => $("editor").close());
$("editor").addEventListener("cancel", (event) => {
  if ($("editor-submit").disabled) event.preventDefault();
});
$("editor").addEventListener("close", () => { editorAction = undefined; });
$("editor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editorAction) return;
  const submit = $("editor-submit");
  if (submit.disabled) return;
  submit.disabled = true;
  $("editor-close").disabled = true;
  $("editor-cancel").disabled = true;
  showMessage($("editor-error"), "");
  try {
    const { message, sessionId } = await editorAction(new FormData(event.currentTarget));
    $("editor").close();
    showMessage($("app-message"), message);
    await loadDashboard(sessionId);
  } catch (error) {
    reportError(error, $("editor").open ? $("editor-error") : $("app-message"));
  } finally {
    submit.disabled = false;
    $("editor-close").disabled = false;
    $("editor-cancel").disabled = false;
  }
});
$("new-button").addEventListener("click", () => {
  if (state.view === "activites") editActivity();
  else editSession();
});
$("session-select").addEventListener("change", (event) => selectSession(event.currentTarget.value));
$("refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    showMessage($("app-message"), "");
    await loadDashboard();
  } catch (error) {
    reportError(error);
  } finally {
    button.disabled = false;
  }
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button");
  submit.disabled = true;
  showMessage($("login-error"), "");
  try {
    const session = await api("/api/admin/login", "POST", {
      username: state.legacy ? undefined : form.elements.username.value.trim(),
      password: form.elements.password.value,
    });
    form.reset();
    configureLogin(session);
    await showDashboard(session.admin);
    if (authenticated) $("dashboard").focus();
  } catch (error) {
    showMessage($("login-error"), error.message, true);
  } finally {
    submit.disabled = false;
  }
});
$("logout").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const session = await api("/api/admin/logout", "POST", {});
    hideDashboard();
    configureLogin(session);
    showMessage($("login-error"), "");
    focusLogin();
  } catch (error) {
    reportError(error);
  } finally {
    button.disabled = false;
  }
});
window.addEventListener("hashchange", () => {
  updateView();
  if (!authenticated) return;
  $("dashboard").focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

function initializeTheme() {
  const storageKey = "gasa-admin-theme";
  const pickers = document.querySelectorAll("[data-admin-theme]");
  const themeColor = document.querySelector('meta[name="theme-color"]');

  function applyTheme(value) {
    const theme = value === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    themeColor.content = theme === "dark" ? "#0b0d13" : "#121b2c";
    pickers.forEach((picker) => { picker.value = theme; });
  }

  try {
    applyTheme(localStorage.getItem(storageKey));
  } catch {
    applyTheme("light");
  }

  pickers.forEach((picker) => picker.addEventListener("change", () => {
    applyTheme(picker.value);
    try {
      localStorage.setItem(storageKey, picker.value);
    } catch {
      // The current page still uses the selected theme when storage is unavailable.
    }
  }));
}

initializeTheme();
start();
