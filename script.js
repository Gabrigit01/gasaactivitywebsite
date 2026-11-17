document.addEventListener("DOMContentLoaded", () => {
  const header = document.getElementById("carousel");
  const slides = document.querySelectorAll(".slide");
  const dots = document.querySelectorAll(".dot");
  const bgCurrent = document.getElementById("bgCurrent");
  const bgNext = document.getElementById("bgNext");
  const nextTrigger = document.getElementById("nextTrigger");
  const ringFill = document.getElementById("ringFill");

  let currentIndex = 0;
  let isTransitioning = false;
  const SLIDE_DURATION = 6500;
  let progressStart = performance.now();

  if (slides.length > 0 && bgCurrent) {
    bgCurrent.style.backgroundImage = `url('${slides.item(0).getAttribute("data-bg")}')`;
  }

  /* --- 1. COMPTE À REBOURS EN DIRECT --- */
  const targetDate = new Date("2026-11-27T18:30:00").getTime();
  const countdownEl = document.getElementById("countdown");

  function updateCountdown() {
    if (!countdownEl) return;
    const diff = targetDate - Date.now();
    if (diff <= 0) {
      countdownEl.textContent = "• Ce soir !";
      return;
    }
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    countdownEl.textContent = `• J-${String(days).padStart(2, "0")} : ${String(hours).padStart(2, "0")}H`;
  }
  updateCountdown();
  setInterval(updateCountdown, 60000);

  /* --- 2. DONNÉES DU SONDAGE CONTEXTUEL SELON L'ACTIVITÉ --- */
  const activityPolls = {
    cinema: {
      kicker: "01 • ACTIVITÉ PROGRAMMÉE : CINÉMA",
      title: "Quel genre éducatif pour la projection ?",
      options: new Array(
        { tag: "Sciences & Technologie", label: "Documentaire & Innovation", votes: 52, img: "images/cinema.jpg" },
        { tag: "Parcours & Réussite", label: "Biopic & Entrepreneuriat", votes: 31, img: "images/im18.jpeg" },
        { tag: "Culture & Réflexion", label: "Histoire & Enjeux de Société", votes: 17, img: "images/im19.jpeg" }
      )
    },
    conference: {
      kicker: "01 • ACTIVITÉ : CONFÉRENCE & DÉBAT",
      title: "Quel thème souhaitez-vous aborder ?",
      options: new Array(
        { tag: "Numérique & Futur", label: "Intelligence Artificielle & Métiers", votes: 49, img: "images/im18.jpeg" },
        { tag: "Économie Locale", label: "Entrepreneuriat Étudiant au Bénin", votes: 33, img: "images/im19.jpeg" },
        { tag: "Sécurité Numérique", label: "Cybersécurité & Protection des Données", votes: 18, img: "images/innovation.png" }
      )
    },
    hackathon: {
      kicker: "01 • ACTIVITÉ : HACKATHON CAMPUS",
      title: "Quel défi technique relever en équipe ?",
      options: new Array(
        { tag: "Vie Étudiante", label: "Application utile pour le campus GASA", votes: 50, img: "images/innovation.png" },
        { tag: "FinTech", label: "Solution de paiement mobile simplifiée", votes: 29, img: "images/im5.jpeg" },
        { tag: "Ville Durable", label: "Gestion intelligente des déchets à Cotonou", votes: 21, img: "images/im18.jpeg" }
      )
    },
    atelier: {
      kicker: "01 • ACTIVITÉ : ATELIER CARRIÈRE",
      title: "Quel module pratique privilégier ?",
      options: new Array(
        { tag: "Insertion Pro", label: "CV percutant, LinkedIn & Entretien", votes: 46, img: "images/im19.jpeg" },
        { tag: "Communication", label: "Prise de parole en public & Pitch", votes: 34, img: "images/scene.jpg" },
        { tag: "Organisation", label: "Gestion de projet Agile en équipe", votes: 20, img: "images/innovation.png" }
      )
    },
    esport: {
      kicker: "01 • ACTIVITÉ : TOURNOI E-SPORT",
      title: "Sur quel jeu organiser la compétition ?",
      options: new Array(
        { tag: "Football", label: "EA Sports FC (FIFA) 1v1", votes: 56, img: "images/cinema.jpg" },
        { tag: "Combat", label: "Tekken 8 / Mortal Kombat", votes: 25, img: "images/im4.jpeg" },
        { tag: "Course", label: "Blur / Mario Kart en réseau", votes: 19, img: "images/im6.jpeg" }
      )
    },
    scene: {
      kicker: "01 • ACTIVITÉ : SCÈNE OUVERTE",
      title: "Quel format artistique mettre en avant ?",
      options: new Array(
        { tag: "Musique & Voix", label: "Chant Acoustique, Rap & Slam", votes: 47, img: "images/scene.jpg" },
        { tag: "Humour & Théâtre", label: "Stand-up & Improvisation", votes: 33, img: "images/im1.jpeg" },
        { tag: "Danse", label: "Chorégraphies & Battles", votes: 20, img: "images/im2.jpeg" }
      )
    },
    sport: {
      kicker: "01 • ACTIVITÉ : TOURNOI INTER-FILIÈRES",
      title: "Quelle discipline sportive lancer ?",
      options: new Array(
        { tag: "Collectif", label: "Tournoi de Football Petit Camp", votes: 55, img: "images/im4.jpeg" },
        { tag: "Intensité", label: "Basketball 3x3 sur le campus", votes: 28, img: "images/im3.jpeg" },
        { tag: "Endurance", label: "Volleyball Mixte Inter-Promotions", votes: 17, img: "images/im5.jpeg" }
      )
    }
  };

  let currentActivityKey = "cinema";
  let storedContextVotes = JSON.parse(localStorage.getItem("gasa_context_votes")) || {};
  let userContextChoices = JSON.parse(localStorage.getItem("gasa_user_context_choices")) || {};

  const dynamicKicker = document.getElementById("dynamicPollKicker");
  const dynamicTitle = document.getElementById("dynamicPollTitle");
  const cinemaRows = document.querySelectorAll(".cinema-row");

  function renderContextualPoll(key) {
    currentActivityKey = activityPolls[key] ? key : "cinema";
    const config = activityPolls[currentActivityKey];

    if (dynamicKicker) dynamicKicker.textContent = config.kicker;
    if (dynamicTitle) dynamicTitle.textContent = config.title;

    if (!storedContextVotes[currentActivityKey]) {
      storedContextVotes[currentActivityKey] = config.options.map((o) => o.votes);
    }

    const votesArr = storedContextVotes[currentActivityKey];
    const total = votesArr.reduce((a, b) => a + b, 0);
    const chosenIdx = userContextChoices[currentActivityKey];

    cinemaRows.forEach((row, i) => {
      const opt = config.options.at(i);
      if (!opt) return;

      const pct = Math.round((votesArr.at(i) / total) * 100);
      const imgEl = row.querySelector("img");
      const tagEl = document.getElementById(`optTag${i}`);
      const titleEl = document.getElementById(`optTitle${i}`);
      const scoreEl = document.getElementById(`optScore${i}`);
      const barEl = document.getElementById(`optBar${i}`);

      if (imgEl && opt.img) imgEl.src = opt.img;
      if (tagEl) tagEl.textContent = opt.tag;
      if (titleEl) titleEl.textContent = opt.label;
      if (scoreEl) scoreEl.textContent = `${pct}%`;
      if (barEl) barEl.style.width = `${pct}%`;

      row.classList.toggle("selected", chosenIdx !== undefined && chosenIdx === i);
    });
  }

  renderContextualPoll("cinema");

  cinemaRows.forEach((row) => {
    row.addEventListener("click", () => {
      if (userContextChoices[currentActivityKey] !== undefined) return;
      const idx = parseInt(row.getAttribute("data-opt"), 10);
      const votesArr = storedContextVotes[currentActivityKey];
      votesArr.splice(idx, 1, votesArr.at(idx) + 1);
      userContextChoices[currentActivityKey] = idx;
      localStorage.setItem("gasa_context_votes", JSON.stringify(storedContextVotes));
      localStorage.setItem("gasa_user_context_choices", JSON.stringify(userContextChoices));
      renderContextualPoll(currentActivityKey);
    });
  });
  /* --- 3. CARROUSEL, RIDEAU & SYNCHRONISATION --- */
  function goToSlide(targetIndex) {
    if (isTransitioning || targetIndex === currentIndex) return;
    isTransitioning = true;

    const targetSlide = slides.item(targetIndex);
    const nextBgUrl = targetSlide.getAttribute("data-bg");
    const actKey = targetSlide.getAttribute("data-activity-key");

    bgNext.style.backgroundImage = `url('${nextBgUrl}')`;
    bgNext.classList.add("revealing");

    slides.item(currentIndex).classList.remove("active");
    targetSlide.classList.add("active");
    dots.forEach((d, i) => d.classList.toggle("active", i === targetIndex));

    if (actKey) renderContextualPoll(actKey);

    setTimeout(() => {
      bgCurrent.style.backgroundImage = `url('${nextBgUrl}')`;
      bgNext.classList.remove("revealing");
      currentIndex = targetIndex;
      isTransitioning = false;
      progressStart = performance.now();
    }, 900);
  }

  function nextSlide() {
    goToSlide((currentIndex + 1) % slides.length);
  }

  function prevSlide() {
    goToSlide((currentIndex - 1 + slides.length) % slides.length);
  }

  if (nextTrigger) {
    nextTrigger.addEventListener("click", () => {
      nextSlide();
      progressStart = performance.now();
    });
  }

  dots.forEach((dot) => {
    dot.addEventListener("click", () => {
      goToSlide(parseInt(dot.getAttribute("data-index"), 10));
      progressStart = performance.now();
    });
  });

  document.querySelectorAll(".select-activity-trigger").forEach((link) => {
    link.addEventListener("click", () => {
      const actKey = link.getAttribute("data-activity-key");
      if (actKey) renderContextualPoll(actKey);
    });
  });

  let touchStartX = 0;
  if (header) {
    header.addEventListener("touchstart", (e) => {
      touchStartX = e.changedTouches.item(0).screenX;
    }, { passive: true });

    header.addEventListener("touchend", (e) => {
      const touchEndX = e.changedTouches.item(0).screenX;
      if (touchStartX - touchEndX > 50) { nextSlide(); progressStart = performance.now(); }
      if (touchEndX - touchStartX > 50) { prevSlide(); progressStart = performance.now(); }
    }, { passive: true });
  }

  const CIRCUMFERENCE = 176;
  function updateRing(now) {
    if (!isTransitioning && ringFill) {
      const elapsed = now - progressStart;
      const ratio = Math.min(elapsed / SLIDE_DURATION, 1);
      ringFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - ratio);
      if (ratio >= 1) nextSlide();
    }
    requestAnimationFrame(updateRing);
  }
  requestAnimationFrame(updateRing);

  /* --- 4. PARALLAXE SPATIALE --- */
  let targetX = 0, targetY = 0, currentX = 0, currentY = 0;

  if (header) {
    header.addEventListener("mousemove", (e) => {
      const rect = header.getBoundingClientRect();
      targetX = (e.clientX - rect.left) / rect.width - 0.5;
      targetY = (e.clientY - rect.top) / rect.height - 0.5;
    });

    header.addEventListener("mouseleave", () => {
      targetX = 0;
      targetY = 0;
    });
  }

  function animateParallax() {
    currentX += (targetX - currentX) * 0.07;
    currentY += (targetY - currentY) * 0.07;

    const bgTransform = `translate3d(${-currentX * 35}px, ${-currentY * 35}px, 0) scale(1.08)`;
    if (bgCurrent) bgCurrent.style.transform = bgTransform;
    if (bgNext) bgNext.style.transform = bgTransform;

    const activeContent = document.querySelector(".slide.active .slide-content");
    if (activeContent) {
      activeContent.style.transform = `translate3d(${currentX * 25}px, ${currentY * 25}px, 0) rotateX(${-currentY * 6}deg) rotateY(${currentX * 6}deg)`;
    }
    requestAnimationFrame(animateParallax);
  }
  animateParallax();

  /* --- 5. SONDAGE DE DROITE (ACTIVITÉS À PROGRAMMER) --- */
  const pollItems = document.querySelectorAll(".studio-option");
  let activityVotes = JSON.parse(localStorage.getItem("gasa_act_votes")) || new Array(42, 24, 19, 15);
  let votedActivity = localStorage.getItem("gasa_voted_act");

  function renderPoll() {
    const total = activityVotes.reduce((a, b) => a + b, 0);
    pollItems.forEach((btn, i) => {
      const pct = Math.round((activityVotes.at(i) / total) * 100);
      btn.querySelector(".studio-fill").style.width = `${pct}%`;
      btn.querySelector(".poll-percent").textContent = `${pct}%`;
      if (votedActivity !== null && parseInt(votedActivity, 10) === i) {
        btn.classList.add("voted");
      } else if (votedActivity !== null) {
        btn.classList.remove("voted");
      }
    });
  }
  renderPoll();

  pollItems.forEach((item) => {
    item.addEventListener("click", () => {
      const actKey = item.getAttribute("data-activity-key");
      if (actKey) renderContextualPoll(actKey);

      if (votedActivity !== null) return;
      const idx = parseInt(item.getAttribute("data-option"), 10);
      activityVotes.splice(idx, 1, activityVotes.at(idx) + 1);
      votedActivity = idx;
      localStorage.setItem("gasa_act_votes", JSON.stringify(activityVotes));
      localStorage.setItem("gasa_voted_act", idx);
      renderPoll();
    });
  });
  /* --- 6. MODALE PROFIL / CONNEXION ÉTUDIANT --- */
  const authBtn = document.getElementById("authBtn");
  const authBtnLabel = document.getElementById("authBtnLabel");
  const authModalBackdrop = document.getElementById("authModalBackdrop");
  const closeAuthBtn = document.getElementById("closeAuthBtn");
  const loginForm = document.getElementById("loginForm");
  const loginName = document.getElementById("loginName");
  const loginDob = document.getElementById("loginDob");
  const loginNiveau = document.getElementById("loginNiveau");
  const loginFiliere = document.getElementById("loginFiliere");
  const profileView = document.getElementById("profileView");
  const profileInitials = document.getElementById("profileInitials");
  const profileDisplayName = document.getElementById("profileDisplayName");
  const profileDisplayFiliere = document.getElementById("profileDisplayFiliere");
  const profileDisplayDob = document.getElementById("profileDisplayDob");
  const logoutBtn = document.getElementById("logoutBtn");
  const commentAuthorInput = document.getElementById("commentAuthorInput");

  let currentUser = JSON.parse(localStorage.getItem("gasa_user")) || null;

  function formatDateFr(isoDate) {
    if (!isoDate) return "";
    const parts = isoDate.split("-");
    if (parts.length !== 3) return isoDate;
    return `${parts.at(2)}/${parts.at(1)}/${parts.at(0)}`;
  }

  function updateAuthUI() {
    if (currentUser) {
      const firstName = currentUser.name.split(" ").at(0);
      const initials = currentUser.name
        .split(" ")
        .map((part) => part.charAt(0))
        .join("")
        .substring(0, 2)
        .toUpperCase();

      authBtn.classList.add("connected");
      authBtnLabel.textContent = `${firstName} (${currentUser.niveau} ${currentUser.filiere})`;
      loginForm.style.display = "none";
      profileView.style.display = "block";
      profileInitials.textContent = initials || "ET";
      profileDisplayName.textContent = currentUser.name;
      profileDisplayFiliere.textContent = `${currentUser.niveau} • ${currentUser.filiere}`;
      if (profileDisplayDob) {
        profileDisplayDob.textContent = `Né(e) le ${formatDateFr(currentUser.dob)}`;
      }
      if (commentAuthorInput) {
        commentAuthorInput.value = `${currentUser.name} • ${currentUser.niveau} ${currentUser.filiere}`;
      }
    } else {
      authBtn.classList.remove("connected");
      authBtnLabel.textContent = "Se connecter";
      loginForm.style.display = "flex";
      profileView.style.display = "none";
    }
  }
  updateAuthUI();

  function openAuthModal() {
    authModalBackdrop.classList.add("open");
  }

  function closeAuthModal() {
    authModalBackdrop.classList.remove("open");
  }

  if (authBtn) authBtn.addEventListener("click", openAuthModal);
  if (closeAuthBtn) closeAuthBtn.addEventListener("click", closeAuthModal);
  if (authModalBackdrop) {
    authModalBackdrop.addEventListener("click", (e) => {
      if (e.target === authModalBackdrop) closeAuthModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAuthModal();
  });

  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      currentUser = {
        name: loginName.value.trim(),
        dob: loginDob.value,
        niveau: loginNiveau.value,
        filiere: loginFiliere.value
      };
      localStorage.setItem("gasa_user", JSON.stringify(currentUser));
      updateAuthUI();
      closeAuthModal();
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      currentUser = null;
      localStorage.removeItem("gasa_user");
      updateAuthUI();
      closeAuthModal();
    });
  }

  /* --- 7. SECTION COMMENTAIRES ÉDITORIALE (SÉANCE PASSÉE) --- */
  const commentForm = document.getElementById("commentForm");
  const commentTextInput = document.getElementById("commentTextInput");
  const commentsGrid = document.getElementById("commentsGrid");
  const commentsCounter = document.getElementById("commentsCounter");

  const defaultComments = new Array(
    { author: "Marc • L2 SIL", text: "La première projection était incroyable, super ambiance sur le campus le soir !" },
    { author: "Aïcha • L3 RIT", text: "Merci pour l'organisation, on veut des séances cinéma éducatif encore plus souvent." },
    { author: "Jean-Luc • L1 SI", text: "Le débat après le film était très enrichissant, vivement l'édition #2." }
  );

  let pastComments = JSON.parse(localStorage.getItem("gasa_past_comments")) || defaultComments;

  function renderComments() {
    if (!commentsGrid) return;
    commentsGrid.innerHTML = "";
    pastComments.forEach((c) => {
      const card = document.createElement("div");
      card.className = "comment-card";
      card.innerHTML = `
        <p>« ${c.text} »</p>
        <span class="comment-author">— ${c.author}</span>
      `;
      commentsGrid.appendChild(card);
    });
    if (commentsCounter) {
      commentsCounter.textContent = `${pastComments.length} avis`;
    }
  }
  renderComments();

  if (commentForm) {
    commentForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = commentTextInput.value.trim();
      const fallbackAuthor = currentUser ? `${currentUser.name} • ${currentUser.niveau} ${currentUser.filiere}` : "Étudiant UATM GASA";
      const author = (commentAuthorInput && commentAuthorInput.value.trim()) ? commentAuthorInput.value.trim() : fallbackAuthor;
      if (!text) return;

      pastComments.unshift({ author, text });
      localStorage.setItem("gasa_past_comments", JSON.stringify(pastComments));
      renderComments();
      commentTextInput.value = "";
    });
  }
});
