"use strict";

const $ = (id) => document.getElementById(id);
const views = {
  vue: { title: "Vue d’ensemble", intro: "Suivez les votes et les retours par séance." },
  sondages: { title: "Sondages", intro: "Créez les sondages et consultez le détail des réponses." },
  activites: { title: "Activités", intro: "Gérez les activités proposées et leurs questions." },
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
};
let requestVersion = 0;
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
  return ["Publiée", "live"];
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
  await loadResults();
}

function updateView() {
  const requested = location.hash.slice(1);
  const available = Object.hasOwn(views, requested) && (requested !== "partage" || canShareView());
  state.view = available ? requested : "vue";
  if (authenticated) render();
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
  if (!session) return [lead];
  const votes = results?.votes.reduce((sum, vote) => sum + vote.count, 0);
  const count = (value) => value === undefined ? "—" : numberFormat.format(value);
  return [
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
      element("div", {}, element("h3", {}, entry.title), tag(label, style)),
      element("div", { class: "button-row" },
        entry.id === state.sessionId ? null : button("Consulter", () => selectSession(entry.id)),
        canEditSession(entry) && button("Modifier", () => editSession(entry))));
  }));
  const items = [panel("Toutes les séances", null, state.sessions.length ? list : empty("Aucun sondage créé"))];
  if (!session) return items;
  items.push(overallPanel(results));
  const detailed = results?.votes.filter((entry) => entry.options.length) || [];
  if (detailed.length) {
    const selector = element("select", { "aria-label": "Activité à détailler" }, detailed.map((entry) =>
      element("option", { value: entry.activityId }, entry.name)));
    const detail = element("div");
    function showDetails() {
      const selected = detailed.find((entry) => entry.activityId === selector.value);
      const total = selected.options.reduce((sum, option) => sum + option.count, 0);
      detail.replaceChildren(total ? voteBars(selected.options, (option) => option.label, total)
        : empty("Aucune réponse à cette question"));
    }
    selector.addEventListener("change", showDetails);
    showDetails();
    items.push(panel("Détail par activité", null, element("label", {}, "Activité", selector), detail));
  }
  return items;
}

function activitiesView() {
  if (!state.activities.length) return [panel("Catalogue des activités", null, empty("Aucune activité", can("edit") ? "Créez votre première activité pour la proposer dans un sondage." : null))];
  const cards = [...state.activities].sort((a, b) => Number(a.archived) - Number(b.archived)).map((activity) =>
    element("article", { class: "catalog-card" },
      element("img", { src: activity.image || "/images/im5.jpeg", alt: "", loading: "lazy", width: 500, height: 225 }),
      element("div", {}, activity.archived && tag("Archivée"),
        element("h2", {}, activity.name), activity.question && element("p", {}, activity.question)),
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
  $("share-nav-label").textContent = can("export") ? "Partage et exports" : "Partage";
  $("session-bar").hidden = view === "activites";
  $("new-button").hidden = !can("edit") || !["vue", "sondages", "activites"].includes(view);
  $("new-button-label").textContent = view === "activites" ? "Nouvelle activité" : "Nouveau sondage";
  document.querySelectorAll("[data-view]").forEach((link) => {
    link.hidden = link.dataset.view === "partage" && !canShareView();
    if (link.dataset.view === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const renderers = {
    vue: () => overview(session, state.results),
    sondages: () => surveyView(session, state.results),
    activites: activitiesView,
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
  const choices = Object.entries(assetChoices);
  if (activity?.image && !Object.hasOwn(assetChoices, activity.image)) {
    choices.unshift([activity.image, "Visuel actuel"]);
  }
  return selectField("Photo de l’activité", "image", choices, activity?.image || "/images/im5.jpeg");
}

function editActivity(activity) {
  const fields = [
    field("Nom", "input", { name: "name", required: true, maxlength: 90 }, activity?.name),
    field("Description", "textarea", { name: "description", maxlength: 350 }, activity?.description),
    assetField(activity),
    field("Question affichée après le choix", "input", { name: "question", required: true, maxlength: 160 }, activity?.question),
    field("Options de réponse", "textarea", { name: "options", required: true, rows: 4, maxlength: 1600 },
      activity?.options.map((option) => option.label).join("\n"), "Saisissez de deux à huit options différentes, une par ligne."),
  ];
  editor(activity ? "Modifier l’activité" : "Nouvelle activité", activity ? "Enregistrer" : "Créer l’activité", fields, async (data) => {
    const labels = data.get("options").split(/\r?\n/).map((label) => label.trim()).filter(Boolean);
    if (labels.length < 2 || labels.length > 8
      || new Set(labels.map((label) => label.toLocaleLowerCase("fr"))).size !== labels.length) {
      throw new Error("Ajoutez de deux à huit options différentes, une par ligne.");
    }
    const existing = new Map(activity?.options.map((option) => [option.label, option.id]) || []);
    const values = {
      name: data.get("name"),
      description: data.get("description"),
      image: data.get("image"),
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
  const selected = new Set(session?.activityIds || []);
  const eligible = state.activities.filter((activity) => !activity.archived || selected.has(activity.id));
  const activities = element("fieldset", {},
    element("legend", {}, "Activités proposées"),
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
