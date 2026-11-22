"use strict";

const parameters = new URLSearchParams(location.search);
const linkedSession = parameters.get("seance");
const views = ["vote", "avis", "annonce"];
const linkedView = views.includes(parameters.get("vue")) ? parameters.get("vue") : null;
const isDirectLink = Boolean(linkedSession && linkedView);
const $ = (id) => document.getElementById(id);

const panels = {
  vote: { content: $("vote-content"), status: $("vote-status") },
  avis: { content: $("feedback-content"), status: $("feedback-status") },
  annonce: { content: $("announcement-content"), status: $("announcement-status") },
};

const dateFormat = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Africa/Porto-Novo",
});

let home = null;
let revealTimer;
let homeRequest = 0;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function element(tag, properties = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(properties)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === "class") node.className = value;
    else node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined));
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", "#i-" + name);
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.append(use);
  return svg;
}

async function api(path, payload) {
  const options = payload === undefined
    ? { cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || "La connexion au site a échoué. Veuillez réessayer.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function status(view, label, mode = "") {
  const badge = panels[view].status;
  badge.hidden = !label;
  badge.textContent = label || "";
  badge.className = "status-tag " + (mode ? "status-" + mode : "");
}

function replace(view, ...children) {
  const content = panels[view].content;
  content.replaceChildren(...children);
  content.setAttribute("aria-busy", "false");
}

function notice(title, detail, symbol) {
  return element("div", {
    class: "notice" + (symbol === "check" ? " notice-success" : ""),
    tabindex: "-1",
  }, symbol ? element("span", { class: "notice-icon" }, icon(symbol)) : null,
  element("div", {}, element("strong", {}, title), element("p", {}, detail)));
}


function errorMessage() {
  return element("p", { class: "form-error", role: "alert", hidden: true });
}

async function submit(button, error, send, onSuccess) {
  if (button.disabled) return;
  const label = [...button.childNodes];
  error.hidden = true;
  button.disabled = true;

  try {
    if (!await window.gasaStudent.authorize()) return;
    button.textContent = "Envoi en cours…";
    await send();
    onSuccess();
  } catch (failure) {
    if (failure.status === 401) window.gasaStudent.invalidate();
    if (failure.status === 409 && /déjà/.test(failure.message)) { loadHome(); return; }
    error.textContent = failure instanceof TypeError
      ? "Impossible de joindre le site. Votre réponse est toujours dans le formulaire."
      : failure.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.replaceChildren(...label);
  }
}

function image(source, props = {}) {
  return source ? element("img", { src: source, alt: "", loading: "lazy", decoding: "async", ...props }) : null;
}

function radioChoice(group, value, label) {
  return element("label", { class: "radio-choice" },
    element("input", { type: "radio", name: group, value, required: true }),
    element("span", {}, label));
}

function renderVote() {
  const poll = home.poll;
  status("vote", "");
  $("vote-intro").textContent = poll
    ? [poll.title, poll.description].filter(Boolean).join(" · ")
    : "Choisissez une activité pour découvrir sa question.";

  if (!poll) {
    replace("vote", notice("Aucun sondage à afficher", "Le prochain sondage sera disponible ici dès sa publication."));
    return;
  }
  if (poll.responded) {
    const confirmation = element("div", { class: "response-confirmation", tabindex: "-1", role: "status" },
      element("p", {}, "Votre participation a été prise en compte."),
      element("span", {}, "Le comité annoncera prochainement l’activité retenue."));
    replace("vote", confirmation);
    return confirmation;
  }
  if (!poll.open) {
    replace("vote", notice("Les votes sont terminés", "L’activité retenue sera affichée dans « Prochaine séance »."));
    return;
  }
  if (!poll.activities.length) {
    replace("vote", notice("Aucune activité disponible", "Revenez ici pour découvrir les choix du prochain sondage."));
    return;
  }

  const grid = element("div", { class: "poll-card-grid" });
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const entries = new Map();
  let active = null;
  let activeIsPreview = false;

  function cancelHover() {
    for (const entry of entries.values()) {
      window.clearTimeout(entry.hoverTimer);
      entry.hoverTimer = 0;
    }
  }

  function showActivity(entry, preview = false) {
    cancelHover();
    active = entry;
    activeIsPreview = Boolean(entry && preview);
    for (const item of entries.values()) {
      const selected = item === active;
      item.form.hidden = !selected;
      item.button.setAttribute("aria-expanded", String(selected));
      item.card.classList.toggle("is-expanded", selected);
    }
    return entry?.button || null;
  }

  function draftInProgress() {
    return active && (active.form.contains(document.activeElement) || active.form.querySelector("input:checked"));
  }

  for (const [index, activity] of poll.activities.entries()) {
    const questionId = "poll-question-" + index;
    const titleId = "poll-activity-title-" + index;
    const title = element("span", { class: "poll-card-name", id: titleId }, activity.name);
    const button = element("button", {
      class: "poll-card-trigger",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": questionId,
      "aria-labelledby": titleId,
    },
    element("span", { class: "poll-card-photo" }, image(activity.image)),
    element("span", { class: "poll-card-copy" },
      title,
      activity.description ? element("span", { class: "poll-card-description" }, activity.description) : null));
    const error = errorMessage();
    const confirm = element("button", { type: "submit", class: "button button-dark poll-card-submit" }, "Confirmer mon choix");
    const form = element("form", { class: "poll-card-survey", id: questionId, hidden: true },
      element("fieldset", {},
        element("legend", {}, activity.question),
        element("div", { class: "poll-card-options" }, activity.options.map((option) =>
          radioChoice(questionId, option.id, option.label)))),
      error,
      confirm);
    const card = element("article", { class: "poll-card", "aria-labelledby": titleId }, button, form);
    const entry = { activity, card, button, form, hoverTimer: 0 };
    entries.set(activity.id, entry);

    button.addEventListener("click", () => {
      if (button.disabled) return;
      showActivity(active === entry && !activeIsPreview ? null : entry);
    });
    card.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse" || !finePointer.matches || active === entry || draftInProgress()) return;
      cancelHover();
      entry.hoverTimer = window.setTimeout(() => {
        entry.hoverTimer = 0;
        if (card.isConnected && !button.disabled && !draftInProgress()) showActivity(entry, true);
      }, 180);
    });
    card.addEventListener("pointerleave", () => {
      window.clearTimeout(entry.hoverTimer);
      entry.hoverTimer = 0;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const optionId = new FormData(form).get(questionId);
      if (!optionId) return;
      cancelHover();
      entries.forEach((item) => { item.button.disabled = true; });
      submit(confirm, error, () => api("/api/sessions/" + encodeURIComponent(poll.id) + "/vote", {
        activityId: activity.id, optionId,
      }), () => {
        poll.responded = true;
        renderVote()?.focus();
        renderCampusCover();
      }).finally(() => entries.forEach((item) => { item.button.disabled = false; }));
    });
    grid.append(card);
  }

  replace("vote", grid);
}

function renderFeedback() {
  const feedback = home.feedback;
  status("avis", "");
  $("feedback-intro").textContent = feedback
    ? feedback.title + " · Votre retour est partagé avec le comité."
    : "Partagez vos impressions sur la dernière séance.";

  if (!feedback) {
    replace("avis", notice("Aucune séance à évaluer", "Le formulaire sera disponible après une séance."));
    return;
  }
  if (feedback.responded) {
    const confirmation = element("div", { class: "response-confirmation", tabindex: "-1" },
      element("h3", {}, "Votre avis a été transmis"),
      element("p", {}, "Le comité le retrouvera dans le bilan de cette séance."));
    replace("avis", confirmation);
    return confirmation;
  }
  if (!feedback.open) {
    replace("avis", notice("La collecte est terminée", "Le comité a clôturé les avis pour cette séance."));
    return;
  }

  const levels = ["Très décevante", "Décevante", "Correcte", "Réussie", "Excellente"];
  const error = errorMessage();
  const send = element("button", { type: "submit", class: "button button-dark" }, "Envoyer mon avis");
  const selection = element("div", { class: "experience-options" }, levels.map((label, index) =>
    element("label", { class: "experience-option" },
      element("input", { type: "radio", name: "rating", value: index + 1, required: true }),
      element("span", { class: "experience-radio", "aria-hidden": "true" }),
      element("span", {}, label))));
  const details = element("div", { class: "feedback-detail", id: "feedback-detail", hidden: true },
    element("label", { for: "feedback-comment" }, "Qu’aimeriez-vous partager avec le comité ?",
      element("span", { class: "optional-label" }, "Facultatif")),
    element("textarea", {
      name: "comment", id: "feedback-comment", rows: "3", maxlength: "1000",
      placeholder: "Un moment apprécié, une idée ou un point à améliorer…",
    }),
    element("div", { class: "feedback-actions" },
      element("p", {}, "Votre nom n’apparaît pas dans le bilan des avis."),
      send));
  selection.addEventListener("change", () => {
    details.hidden = false;
    selection.closest("form").classList.add("has-rating");
  });

  const form = element("form", { class: "experience-form" },
    element("fieldset", {},
      element("legend", {}, "Comment s’est passée la séance ?"),
      selection),
    details,
    error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = new FormData(form);
    submit(send, error, () => api("/api/sessions/" + encodeURIComponent(feedback.id) + "/feedback", {
      rating: Number(values.get("rating")), comment: String(values.get("comment")).trim(),
    }), () => {
      feedback.responded = true;
      renderFeedback()?.focus();
      renderCampusCover();
    });
  });
  replace("avis", form);
}


function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

function eventDetails(announcement) {
  const date = dateLabel(announcement.date);
  return element("ul", { class: "event-details" },
    date ? element("li", {}, icon("calendar"), element("time", { datetime: announcement.date }, date)) : null,
    announcement.location ? element("li", {}, icon("pin"), announcement.location) : null);
}

function renderAnnouncement() {
  const announcement = home.announcement;
  $("announcement-intro").textContent = announcement?.title || "Retrouvez ici l’activité retenue par le comité.";
  if (!announcement) {
    status("annonce", "");
    replace("annonce", notice("Annonce à venir", "L’activité et la date s’afficheront ici dès publication.", "calendar"));
    return;
  }

  if (announcement.revealed && announcement.activity) {
    status("annonce", "Séance confirmée", "success");
    const activity = announcement.activity;
    replace("annonce", element("article", { class: "event-card" },
      element("div", { class: "event-copy" },
        element("h3", {}, activity.name),
        eventDetails(announcement),
        activity.description ? element("p", {}, activity.description) : null),
      element("div", { class: "event-photo" }, image(activity.image) || icon("calendar"))));
    return;
  }

  status("annonce", "Mode surprise", "live");
  const reveal = dateLabel(announcement.revealAt);
  const guess = announcement.responded
    ? notice("Proposition enregistrée", "Revenez au moment de la révélation pour découvrir l’activité.", "check")
    : null;
  let form = null;

  if (!guess && announcement.choices.length) {
    const error = errorMessage();
    const send = element("button", { class: "button button-dark", type: "submit" }, "Envoyer ma proposition");
    form = element("form", { class: "guess-form" },
      element("fieldset", {},
        element("legend", {}, "Quelle activité se cache derrière cet indice ?"),
        element("div", { class: "radio-list guess-options" },
          announcement.choices.map((choice) => radioChoice("guess", choice.id, choice.name)))),
      error,
      send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const activityId = new FormData(form).get("guess");
      submit(send, error, () => api("/api/sessions/" + encodeURIComponent(announcement.id) + "/guess", { activityId }), () => {
        announcement.responded = true;
        renderAnnouncement()?.focus();
      });
    });
  }

  replace("annonce", element("div", { class: "mystery-panel" },
    element("div", { class: "event-card" },
      element("div", { class: "event-copy" },
        element("h3", {}, "Devinez l’activité"),
        eventDetails(announcement),
        announcement.hint ? element("p", { class: "event-hint" },
          element("strong", {}, "L’indice"), announcement.hint) : null,
        reveal ? element("p", { class: "reveal-date" },
          "Révélation le ", element("time", { datetime: announcement.revealAt }, reveal)) : null),
      element("div", { class: "event-photo mystery-art", "aria-hidden": "true" })),
    guess || form));
  return guess;
}


function renderCampusCover() {
  if (isDirectLink) return;
  const { poll, announcement, feedback } = home;
  const voteOpen = poll?.open && !poll.responded;
  const needsFeedback = feedback?.open && !feedback.responded;
  const action = $("campus-cover-cta");
  action.href = voteOpen ? "#vote" : announcement ? "#annonce" : needsFeedback ? "#avis" : "#vote";
  action.textContent = voteOpen ? "Voter pour une activité"
    : announcement ? (announcement.revealed ? "Voir la prochaine séance" : "Deviner l’activité")
    : needsFeedback ? "Donner mon avis" : "Voir le sondage";
}


function activeNavigation() {
  const section = isDirectLink ? linkedView : location.hash.slice(1);
  const active = views.includes(section) ? section : "vote";
  document.querySelectorAll("[data-nav]").forEach((link) => {
    if (link.dataset.nav === active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
}

const apiHome = "/api/home" + (linkedSession ? "?session=" + encodeURIComponent(linkedSession) : "");

function scheduleReveal() {
  window.clearTimeout(revealTimer);
  const liveAnnouncement = home?.announcement;
  if (!liveAnnouncement?.revealAt || liveAnnouncement.revealed) return;
  const time = new Date(liveAnnouncement.revealAt).getTime();
  if (!Number.isFinite(time)) return;

  revealTimer = window.setTimeout(async () => {
    try {
      const updated = await api(apiHome);
      home.announcement = updated.announcement;
      if (updated.announcement?.revealed) {
        renderAnnouncement();
        renderCampusCover();
      }
    } catch {
      // Le prochain rafraîchissement réessaiera si la connexion est coupée.
    }
    scheduleReveal();
  }, Math.min(Math.max(8000, time - Date.now() + 500), 2147483647));
}

async function loadHome() {
  const request = ++homeRequest;
  $("load-error").hidden = true;
  for (const { content } of Object.values(panels)) content.setAttribute("aria-busy", "true");
  try {
    const updated = await api(apiHome);
    if (request !== homeRequest) return;
    home = updated;
    if (!isDirectLink || linkedView === "vote") renderVote();
    if (!isDirectLink || linkedView === "avis") renderFeedback();
    if (!isDirectLink || linkedView === "annonce") renderAnnouncement();
    renderCampusCover();
    scheduleReveal();
  } catch {
    if (request !== homeRequest) return;
    $("load-error-text").textContent = location.protocol === "file:"
      ? "Ouvrez cette page à partir du serveur du projet pour charger les séances."
      : "Les séances n’ont pas pu être chargées. Veuillez réessayer.";
    $("load-error").hidden = false;
    for (const view of views) replace(view);
  }
}

if (isDirectLink) {
  $("accueil-classique").hidden = true;
  $("galerie").hidden = true;
  $("edition").hidden = linkedView !== "avis";
  document.body.classList.add("is-direct");
  for (const view of views) $(view).hidden = view !== linkedView;
  const sectionHeading = $(linkedView).querySelector("h2");
  sectionHeading.replaceWith(element("h1", {
    id: sectionHeading.id,
    tabindex: "-1",
  }, sectionHeading.textContent));
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const ownView = link.dataset.nav;
    link.href = ownView === linkedView ? "#" + linkedView : "/#" + link.dataset.nav;
  });
} else {
  const previousAnchors = { "#espace-vote": "#vote", "#edition-passee": "#galerie", "#carousel": "#accueil" };
  const hash = previousAnchors[location.hash] || location.hash;
  const target = hash === "#accueil" ? "#accueil-classique" : hash;
  if (target !== location.hash) location.replace(target);
}

$("retry-load").addEventListener("click", loadHome);
window.addEventListener("hashchange", activeNavigation);
window.addEventListener("gasa:account-change", loadHome);
activeNavigation();
loadHome();


function setupParallax(hero) {
  if (hero.hidden) return;

  const finePointer = window.matchMedia("(any-hover: hover) and (any-pointer: fine)");
  const neutral = { x: 0, y: 0, scroll: 0 };
  const current = { ...neutral };
  const properties = ["--image-x", "--image-y", "--atmosphere-x", "--atmosphere-y", "--copy-x", "--copy-y"];
  let visible = false;
  let point = null;
  let frame = 0;
  const canMove = () => visible && !reducedMotion.matches;

  function requestFrame() {
    if (!frame && canMove()) frame = requestAnimationFrame(renderFrame);
  }

  function renderFrame() {
    frame = 0;
    if (!canMove()) return;

    const bounds = hero.getBoundingClientRect();
    const inside = point && point.x >= bounds.left && point.x <= bounds.right
      && point.y >= bounds.top && point.y <= bounds.bottom;
    const lightX = inside ? point.x - bounds.left - bounds.width / 2 : 0;
    const lightY = inside ? point.y - bounds.top - bounds.height / 2 : 0;
    const targets = {
      x: inside ? 2 * lightX / bounds.width : 0,
      y: inside ? 2 * lightY / bounds.height : 0,
      scroll: Math.max(-22, Math.min(37, (window.innerHeight * .15 - bounds.top) * .16)),
    };

    let moving = false;
    for (const key of Object.keys(current)) {
      const difference = targets[key] - current[key];
      if (Math.abs(difference) < .015) {
        current[key] = targets[key];
      } else {
        current[key] += difference * .15;
        moving = true;
      }
    }

    const { x, y, scroll } = current;
    const layers = [-x * 26, scroll - y * 23, -x * 8, scroll * .32 - y * 7, x * 12.5, y * 12.5];
    properties.forEach((property, index) => hero.style.setProperty(property, layers[index].toFixed(2) + "px"));
    if (moving) requestFrame();
  }

  function refreshMotion() {
    const enabled = canMove();
    hero.toggleAttribute("data-motion", enabled);
    if (enabled) {
      requestFrame();
    } else {
      cancelAnimationFrame(frame);
      frame = 0;
      point = null;
      Object.assign(current, neutral);
      properties.forEach((property) => hero.style.removeProperty(property));
    }
  }

  hero.addEventListener("pointermove", (event) => {
    if (!canMove() || event.pointerType === "touch") return;
    point = { x: event.clientX, y: event.clientY };
    requestFrame();
  }, { passive: true });
  hero.addEventListener("pointerleave", () => {
    point = null;
    requestFrame();
  });
  window.addEventListener("scroll", requestFrame, { passive: true });
  window.addEventListener("resize", requestFrame, { passive: true });
  finePointer.addEventListener("change", refreshMotion);
  reducedMotion.addEventListener("change", refreshMotion);

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    refreshMotion();
  }).observe(hero);
}

function setupGallery() {
  const gallery = $("galerie");
  if (gallery.hidden) return;

  const rail = $("gallery-rail");
  const controls = $("gallery-controls");
  const toggle = $("gallery-play");
  const slides = [...rail.children];
  const video = rail.querySelector("video");
  const videoSlide = video.closest(".gallery-slide");
  let visible = false;
  let hovering = false;
  let paused = false;
  let resumedFromToggle = false;
  let current = 0;
  let target = null;
  let animationFrame = 0;
  let autoTimer = 0;
  let settledTimer = 0;

  function slideOffset(index) {
    return Math.min(slides[index].offsetLeft, rail.scrollWidth - rail.clientWidth);
  }

  function lastPosition() {
    const end = rail.scrollWidth - rail.clientWidth;
    const last = slides.findIndex((_, index) => slideOffset(index) >= end - 1);
    return last < 0 ? slides.length - 1 : last;
  }

  function updatePosition() {
    animationFrame = 0;
    current = slides.reduce((nearest, _, index) =>
      Math.abs(rail.scrollLeft - slideOffset(index)) < Math.abs(rail.scrollLeft - slideOffset(nearest))
        ? index : nearest, 0);
  }

  function scheduleAdvance() {
    window.clearTimeout(autoTimer);
    const focused = document.activeElement;
    const hasFocus = gallery.contains(focused) && !(focused === toggle && resumedFromToggle);
    if (!visible || hovering || paused || reducedMotion.matches || document.hidden
      || hasFocus || !video.paused || settledTimer) return;
    autoTimer = window.setTimeout(() => advance(1, false), 6000);
  }

  function showSlide(index, announce) {
    target = index;
    rail.scrollTo({
      left: slideOffset(index),
      behavior: reducedMotion.matches || Math.abs(index - current) > 1 ? "instant" : "smooth",
    });
    if (announce) {
      const title = slides[index].querySelector("figcaption").textContent;
      $("gallery-update").textContent = title;
    }
    scheduleAdvance();
  }

  function advance(step, announce) {
    const length = lastPosition() + 1;
    if (length < 2) return;
    const index = (length + Math.min(target ?? current, length - 1) + step) % length;
    showSlide(index, announce);
  }

  function updatePlaybackButton() {
    toggle.hidden = reducedMotion.matches;
    toggle.textContent = paused ? "Reprendre" : "Pause";
    toggle.setAttribute("aria-label", paused ? "Reprendre le défilement" : "Mettre le défilement en pause");
    scheduleAdvance();
  }

  $("gallery-prev").addEventListener("click", () => advance(-1, true));
  $("gallery-next").addEventListener("click", () => advance(1, true));
  toggle.addEventListener("click", () => {
    paused = !paused;
    resumedFromToggle = !paused;
    updatePlaybackButton();
  });
  rail.addEventListener("keydown", (event) => {
    if (event.target !== rail || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") showSlide(0, true);
    else if (event.key === "End") showSlide(lastPosition(), true);
    else advance(event.key === "ArrowRight" ? 1 : -1, true);
  });
  rail.addEventListener("scroll", () => {
    window.clearTimeout(autoTimer);
    if (!animationFrame) animationFrame = requestAnimationFrame(updatePosition);
    window.clearTimeout(settledTimer);
    settledTimer = window.setTimeout(() => {
      settledTimer = 0;
      target = null;
      const videoBounds = video.getBoundingClientRect();
      const railBounds = rail.getBoundingClientRect();
      if (videoBounds.right <= railBounds.left + 2 || videoBounds.left >= railBounds.right - 2) video.pause();
      scheduleAdvance();
    }, 160);
  }, { passive: true });
  rail.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") hovering = true;
    scheduleAdvance();
  });
  rail.addEventListener("pointerleave", () => {
    hovering = false;
    scheduleAdvance();
  });
  gallery.addEventListener("focusin", scheduleAdvance);
  gallery.addEventListener("focusout", (event) => {
    if (event.target === toggle) resumedFromToggle = false;
    queueMicrotask(scheduleAdvance);
  });
  for (const event of ["play", "pause", "ended"]) {
    video.addEventListener(event, () => {
      videoSlide.classList.toggle("is-playing", !video.paused && !video.ended);
      scheduleAdvance();
    });
  }
  document.addEventListener("visibilitychange", scheduleAdvance);
  window.addEventListener("resize", updatePosition, { passive: true });
  reducedMotion.addEventListener("change", updatePlaybackButton);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    scheduleAdvance();
  }, { threshold: .25 }).observe(rail);

  controls.hidden = false;
  updatePosition();
  updatePlaybackButton();
}

setupParallax($("accueil-classique"));
setupGallery();
