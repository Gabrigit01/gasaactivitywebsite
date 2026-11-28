"use strict";

(() => {
  const maxDuration = 30 * 60;
  let generation = 0;
  let items = [];
  let section;
  let list;
  let status;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function request(path) {
    const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Le visionnage est indisponible. Réessayez dans un instant.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function clearPlayers() {
    for (const video of list?.querySelectorAll("video") || []) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }

  async function watch(item, button, player, message) {
    const revision = generation;
    button.disabled = true;
    message.hidden = true;
    try {
      if (!window.gasaStudent?.authorize) throw new Error("Actualisez la page pour vous connecter.");
      if (!await window.gasaStudent.authorize() || revision !== generation) return;
      let result;
      try {
        result = await request("/api/sessions/" + encodeURIComponent(item.sessionId) + "/cinema");
      } catch (error) {
        if (error.status !== 401) throw error;
        window.gasaStudent.invalidate();
        if (!await window.gasaStudent.authorize() || revision !== generation) return;
        result = await request("/api/sessions/" + encodeURIComponent(item.sessionId) + "/cinema");
      }
      if (revision !== generation) return;
      const cinema = result.cinema;
      if (!cinema?.enabled || !cinema.clipUrl) throw new Error("Cet extrait n’est plus disponible.");
      const video = element("video", "cinema-video");
      video.controls = true;
      video.tabIndex = 0;
      video.playsInline = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", "Suite du film : " + cinema.title);
      video.src = cinema.clipUrl;
      function stopUnavailable(text) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        player.replaceChildren();
        player.hidden = true;
        button.hidden = false;
        message.textContent = text;
        message.hidden = false;
      }
      video.addEventListener("loadedmetadata", () => {
        if (!Number.isFinite(video.duration) || video.duration > maxDuration) {
          stopUnavailable("L’extrait a changé et dépasse 30 minutes. Le comité doit vérifier son fichier.");
        }
      }, { once: true });
      video.addEventListener("error", () => {
        if (video.getAttribute("src")) stopUnavailable("La vidéo ne peut pas être lue. Réessayez plus tard ou consultez le lien du film intégral.");
      });
      for (const other of list.querySelectorAll("video")) other.pause();
      video.addEventListener("play", () => {
        for (const other of list.querySelectorAll("video")) if (other !== video) other.pause();
      });
      player.replaceChildren(video);
      player.hidden = false;
      button.hidden = true;
      video.focus();
    } catch (error) {
      if (revision === generation) {
        message.textContent = error.message;
        message.hidden = false;
      }
    } finally { button.disabled = false; }
  }

  function render() {
    clearPlayers();
    list.replaceChildren();
    for (const item of items) {
      const card = element("article", "cinema-card");
      const copy = element("div", "cinema-card-copy");
      copy.append(element("p", "cinema-session", item.sessionTitle));
      copy.append(element("h3", "", item.title));
      const minutes = Math.max(1, Math.ceil(Number(item.durationSeconds) / 60));
      copy.append(element("p", "cinema-duration", `${minutes} min · La suite de la projection`));
      const actions = element("div", "cinema-actions");
      const button = element("button", "button button-dark", "Voir la suite");
      button.type = "button";
      const player = element("div", "cinema-player");
      player.hidden = true;
      const message = element("p", "cinema-error");
      message.setAttribute("role", "status");
      message.hidden = true;
      button.addEventListener("click", () => watch(item, button, player, message));
      actions.append(button);
      if (item.fullUrl) {
        const link = element("a", "cinema-full-link", "Voir le film intégral ↗");
        link.href = item.fullUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        actions.append(link);
      }
      copy.append(actions);
      card.append(copy, player, message);
      list.append(card);
    }
    section.hidden = items.length === 0;
  }

  async function load() {
    status.hidden = true;
    try {
      const data = await request("/api/cinema");
      const linkedSession = new URLSearchParams(location.search).get("session");
      items = (data.items || []).filter(item => item.available && (!linkedSession || item.sessionId === linkedSession));
      render();
    } catch {
      section.hidden = false;
      status.replaceChildren(document.createTextNode("Les suites de films sont momentanément indisponibles. "));
      const retry = element("button", "cinema-retry", "Réessayer");
      retry.type = "button";
      retry.addEventListener("click", load, { once: true });
      status.append(retry);
      status.hidden = false;
    }
  }

  function initialize() {
    const target = document.getElementById("edition") || document.querySelector("main");
    if (!target) return;
    section = element("section", "shell page-section cinema-section");
    section.id = "apres-la-seance";
    section.hidden = true;
    section.setAttribute("aria-labelledby", "cinema-title");
    const heading = element("div", "section-heading");
    const copy = element("div");
    copy.append(element("p", "section-kicker", "Le cinéma continue"));
    const title = element("h2", "", "Après la séance");
    title.id = "cinema-title";
    copy.append(title, element("p", "cinema-intro", "Terminez le film avec la suite proposée par le comité : 30 minutes maximum. Connectez-vous avec votre compte étudiant pour lancer la vidéo."));
    heading.append(copy);
    list = element("div", "cinema-list");
    status = element("p", "cinema-status");
    status.setAttribute("role", "status");
    status.hidden = true;
    section.append(heading, list, status);
    target.append(section);
    window.addEventListener("gasa:account-change", () => {
      generation += 1;
      render();
    });
    window.addEventListener("pagehide", clearPlayers);
    window.addEventListener("pageshow", event => {
      if (event.persisted) {
        generation += 1;
        render();
      }
    });
    load();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();
