document.addEventListener("DOMContentLoaded", () => {
  const ORGANIZER_PIN = "2026";

  const pinOverlay = document.getElementById("pinOverlay");
  const adminApp = document.getElementById("adminApp");
  const pinForm = document.getElementById("pinForm");
  const pinInput = document.getElementById("pinInput");
  const pinError = document.getElementById("pinError");
  const lockBtn = document.getElementById("lockBtn");

  function unlockDashboard() {
    sessionStorage.setItem("gasa_admin_unlocked", "true");
    pinOverlay.style.display = "none";
    adminApp.style.display = "grid";
    renderAllDashboard();
  }

  if (sessionStorage.getItem("gasa_admin_unlocked") === "true") {
    unlockDashboard();
  }

  if (pinForm) {
    pinForm.addEventListener("submit", (e) => {
      e.preventDefault();
      if (pinInput.value.trim() === ORGANIZER_PIN) {
        pinError.textContent = "";
        unlockDashboard();
      } else {
        pinError.textContent = "Code PIN incorrect. Essayez 2026.";
        pinInput.value = "";
      }
    });
  }

  if (lockBtn) {
    lockBtn.addEventListener("click", () => {
      sessionStorage.removeItem("gasa_admin_unlocked");
      adminApp.style.display = "none";
      pinOverlay.style.display = "flex";
      pinInput.value = "";
    });
  }

  /* --- DONNÉES PARTAGÉES AVEC MAINPAGE.HTML --- */
  const activityLabels = new Array(
    "Séance Cinéma Éducatif",
    "Conférence & Débat",
    "Hackathon Campus",
    "Atelier Carrière & Leadership"
  );

  const themeLabelsMap = {
    cinema: new Array("Documentaire & Innovation", "Biopic & Entrepreneuriat", "Histoire & Enjeux de Société"),
    conference: new Array("Intelligence Artificielle & Métiers", "Entrepreneuriat Étudiant au Bénin", "Cybersécurité & Protection des Données"),
    hackathon: new Array("Application utile pour le campus GASA", "Solution de paiement mobile simplifiée", "Gestion intelligente des déchets à Cotonou"),
    atelier: new Array("CV percutant, LinkedIn & Entretien", "Prise de parole en public & Pitch", "Gestion de projet Agile en équipe"),
    esport: new Array("EA Sports FC (FIFA) 1v1", "Tekken 8 / Mortal Kombat", "Blur / Mario Kart en réseau"),
    scene: new Array("Chant Acoustique, Rap & Slam", "Stand-up & Improvisation", "Chorégraphies & Battles"),
    sport: new Array("Tournoi de Football Petit Camp", "Basketball 3x3 sur le campus", "Volleyball Mixte Inter-Promotions")
  };

  const defaultContextVotes = {
    cinema: new Array(52, 31, 17),
    conference: new Array(49, 33, 18),
    hackathon: new Array(50, 29, 21),
    atelier: new Array(46, 34, 20),
    esport: new Array(56, 25, 19),
    scene: new Array(47, 33, 20),
    sport: new Array(55, 28, 17)
  };

  const defaultComments = new Array(
    { author: "Marc • L2 SIL", text: "La première projection était incroyable, super ambiance sur le campus le soir !" },
    { author: "Aïcha • L3 RIT", text: "Merci pour l'organisation, on veut des séances cinéma éducatif encore plus souvent." },
    { author: "Jean-Luc • L1 SI", text: "Le débat après le film était très enrichissant, vivement l'édition #2." }
  );

  function getActivityVotes() {
    return JSON.parse(localStorage.getItem("gasa_act_votes")) || new Array(42, 24, 19, 15);
  }

  function getContextVotes() {
    const saved = JSON.parse(localStorage.getItem("gasa_context_votes")) || {};
    return Object.assign({}, defaultContextVotes, saved);
  }

  function getComments() {
    return JSON.parse(localStorage.getItem("gasa_past_comments")) || defaultComments;
  }

  /* --- RENDU DES GRAPHIQUES & KPIS --- */
  function renderAllDashboard() {
    const actVotes = getActivityVotes();
    const ctxVotes = getContextVotes();
    const comments = getComments();

    // 1. KPIs
    const totalAct = actVotes.reduce((a, b) => a + b, 0);
    let maxIdx = 0;
    actVotes.forEach((v, idx) => {
      if (v > actVotes.at(maxIdx)) maxIdx = idx;
    });
    const topPct = totalAct > 0 ? Math.round((actVotes.at(maxIdx) / totalAct) * 100) : 0;

    document.getElementById("kpiTopActivity").textContent = activityLabels.at(maxIdx);
    document.getElementById("kpiTopActivityPct").textContent = `${topPct}% des intentions (${actVotes.at(maxIdx)} voix)`;
    document.getElementById("kpiTotalActVotes").textContent = totalAct;

    let totalThemes = 0;
    Object.values(ctxVotes).forEach((arr) => {
      totalThemes += arr.reduce((a, b) => a + b, 0);
    });
    document.getElementById("kpiTotalThemeVotes").textContent = totalThemes;
    document.getElementById("kpiCommentsCount").textContent = comments.length;

    // 2. Barres Sondage Global
    const actBarsEl = document.getElementById("adminActivityBars");
    actBarsEl.innerHTML = "";
    activityLabels.forEach((label, i) => {
      const count = actVotes.at(i);
      const pct = totalAct > 0 ? Math.round((count / totalAct) * 100) : 0;
      actBarsEl.innerHTML += `
        <div class="bar-row">
          <div class="bar-meta">
            <span>${label}</span>
            <strong>${pct}% (${count} voix)</strong>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width: ${pct}%"></div></div>
        </div>
      `;
    });

    // 3. Barres Détail Thématique
    const selector = document.getElementById("activitySelector");
    renderThemeDetail(selector ? selector.value : "cinema");

    // 4. Table Modération Commentaires
    const tbody = document.getElementById("adminCommentsBody");
    const modBadge = document.getElementById("modCountBadge");
    modBadge.textContent = `${comments.length} commentaire(s)`;
    tbody.innerHTML = "";

    comments.forEach((c, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${c.author}</strong></td>
        <td>« ${c.text} »</td>
        <td style="text-align: right;">
          <button type="button" class="btn-delete-row" data-idx="${idx}">Supprimer</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll(".btn-delete-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        const list = getComments();
        list.splice(idx, 1);
        localStorage.setItem("gasa_past_comments", JSON.stringify(list));
        renderAllDashboard();
      });
    });

    // 5. Résumé Profil Étudiant
    const user = JSON.parse(localStorage.getItem("gasa_user"));
    const profileBox = document.getElementById("studentProfileSummary");
    if (user) {
      profileBox.innerHTML = `<strong>${user.name}</strong> — Niveau : <strong style="color:#f59e0b">${user.niveau} ${user.filiere}</strong> • Date de naissance : ${user.dob}`;
    } else {
      profileBox.textContent = "Aucun profil étudiant connecté sur ce navigateur pour le moment.";
    }
  }

  function renderThemeDetail(key) {
    const ctxVotes = getContextVotes();
    const labels = themeLabelsMap[key] || themeLabelsMap.cinema;
    const votes = ctxVotes[key] || new Array(1, 1, 1);
    const total = votes.reduce((a, b) => a + b, 0);
    const container = document.getElementById("adminThemeBars");

    container.innerHTML = "";
    labels.forEach((lbl, i) => {
      const count = votes.at(i);
      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
      container.innerHTML += `
        <div class="bar-row">
          <div class="bar-meta">
            <span>${lbl}</span>
            <strong>${pct}% (${count} voix)</strong>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width: ${pct}%"></div></div>
        </div>
      `;
    });
  }

  const activitySelector = document.getElementById("activitySelector");
  if (activitySelector) {
    activitySelector.addEventListener("change", (e) => {
      renderThemeDetail(e.target.value);
    });
  }

  /* --- ACTIONS ORGANISATEUR --- */
  const resetVotesBtn = document.getElementById("resetVotesBtn");
  if (resetVotesBtn) {
    resetVotesBtn.addEventListener("click", () => {
      if (!confirm("Voulez-vous vraiment remettre tous les compteurs de votes à zéro ?")) return;
      localStorage.setItem("gasa_act_votes", JSON.stringify(new Array(1, 1, 1, 1)));
      localStorage.removeItem("gasa_voted_act");
      localStorage.removeItem("gasa_context_votes");
      localStorage.removeItem("gasa_user_context_choices");
      renderAllDashboard();
    });
  }

  const copyWhatsappReport = document.getElementById("copyWhatsappReport");
  if (copyWhatsappReport) {
    copyWhatsappReport.addEventListener("click", () => {
      const actVotes = getActivityVotes();
      const total = actVotes.reduce((a, b) => a + b, 0);
      let report = "*BILAN SONDAGES UATM GASA*\n\n";
      activityLabels.forEach((lbl, i) => {
        const pct = Math.round((actVotes.at(i) / total) * 100);
        report += `• ${lbl} : *${pct}%* (${actVotes.at(i)} voix)\n`;
      });
      report += `\nTotal participants : ${total}`;

      navigator.clipboard.writeText(report).then(() => {
        const orig = copyWhatsappReport.textContent;
        copyWhatsappReport.textContent = "Bilan copié !";
        setTimeout(() => { copyWhatsappReport.textContent = orig; }, 2000);
      });
    });
  }
});
