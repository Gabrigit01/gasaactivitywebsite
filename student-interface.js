"use strict";

(() => {
  const presentations = new Set(["light", "dark"]);
  const preferenceKey = "gasa_student_theme";
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const incomingUrl = new URL(window.location.href);
  let resetToken = incomingUrl.searchParams.has("reset") ? incomingUrl.searchParams.get("reset") : null;
  if (resetToken !== null) {
    incomingUrl.searchParams.delete("reset");
    window.history.replaceState(window.history.state, "", incomingUrl.pathname + incomingUrl.search + incomingUrl.hash);
    let referrer = document.querySelector('meta[name="referrer"]');
    if (!referrer) {
      referrer = document.createElement("meta");
      referrer.name = "referrer";
      document.head.append(referrer);
    }
    referrer.content = "no-referrer";
  }
  const recoveryStyles = document.createElement("link");
  recoveryStyles.rel = "stylesheet";
  recoveryStyles.href = "/account-recovery.css";
  document.head.append(recoveryStyles);

  let theme = "light";
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (presentations.has(saved)) theme = saved;
  } catch {
    // Navigation reste possible lorsque le stockage du navigateur est indisponible.
  }
  root.dataset.studentTheme = theme;

  async function request(route, method = "GET", body) {
    const response = await fetch("/api/" + route, {
      method,
      cache: "no-store",
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || "Impossible de joindre le site.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  let student = null;
  let signupCodeRequired = false;
  let passwordRecoveryEnabled = false;
  let recoveryMode = null;
  let recoveryBusy = false;
  let authenticationBusy = false;
  let mode = "login";
  let pending = null;
  let authorization = null;
  let accountRevision = 0;
  let programCatalog = null;
  let programPromise = null;
  let programsLoading = false;
  let programsError = "";
  let academicProfile = null;
  let academicStudentId = null;
  let academicPendingFor = null;
  let academicLoading = false;
  let academicBusy = false;
  let academicError = "";
  let academicRevision = 0;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let accountAnimation = null;
  let previousAccountFace = null;
  let cancelAccountFlip = null;
  let accountFocusAfterTransition = null;

  function syncAccount(data) {
    accountRevision += 1;
    if ((student?.id || null) !== (data.student?.id || null)) {
      academicRevision += 1;
      academicProfile = null;
      academicStudentId = null;
      academicPendingFor = null;
      academicLoading = false;
      academicBusy = false;
      academicError = "";
    }
    student = data.student;
    signupCodeRequired = data.signupCodeRequired;
    passwordRecoveryEnabled = Boolean(data.passwordRecoveryEnabled);
    renderAccount();
  }

  const ready = request("student/session").then(syncAccount).catch(() => {});

  function populatePrograms() {
    if (!programCatalog) return;
    for (const [id, items, placeholder] of [
      ["student-program", programCatalog.programs.map(item => ({ value: String(item.id), label: item.name })), "Filière"],
      ["student-study-year", programCatalog.years.map(year => ({ value: String(year), label: year + (year === 1 ? "re année" : "e année") })), "Année"],
      ["student-academic-program", programCatalog.programs.map(item => ({ value: String(item.id), label: item.name })), "Filière"],
      ["student-academic-year", programCatalog.years.map(year => ({ value: String(year), label: year + (year === 1 ? "re année" : "e année") })), "Année"],
    ]) {
      const select = $(id);
      if (!select) continue;
      const selected = select.value;
      select.replaceChildren();
      for (const item of [{ value: "", label: placeholder }, ...items]) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        select.append(option);
      }
      select.value = selected;
    }
  }

  async function loadPrograms(force = false) {
    if (programPromise) return programPromise;
    if (programCatalog && !force) return programCatalog;
    programsLoading = true;
    programsError = "";
    renderAccount();
    programPromise = request("programs").then(data => {
      const programs = Array.isArray(data.programs) ? data.programs.filter(item => item
        && ["string", "number"].includes(typeof item.id) && String(item.id).length && typeof item.name === "string" && item.name.trim()) : [];
      const years = Array.isArray(data.years) ? [...new Set(data.years.filter(year => Number.isInteger(year) && year > 0))] : [];
      if (!Array.isArray(data.programs) || !years.length) throw new Error("Les programmes sont momentanément indisponibles.");
      programCatalog = { programs, years };
      programsError = programs.length ? "" : "Aucun programme n’est disponible pour le moment. Contactez le responsable du site.";
      populatePrograms();
      return programCatalog;
    }).catch(error => {
      programsError = error.message;
      return null;
    }).finally(() => {
      programsLoading = false;
      programPromise = null;
      renderAccount();
    });
    return programPromise;
  }

  function setAcademicValues() {
    if (!$("student-academic-program")) return;
    for (const option of $("student-academic-program").querySelectorAll("option[data-current-program]")) option.remove();
    if (academicProfile?.programId && !programCatalog?.programs.some(item => String(item.id) === String(academicProfile.programId))) {
      const option = document.createElement("option");
      option.value = String(academicProfile.programId);
      option.textContent = (academicProfile.programName || "Mon programme actuel") + (academicProfile.programArchived ? " (archivé)" : "");
      option.dataset.currentProgram = "true";
      $("student-academic-program").append(option);
    }
    $("student-academic-program").value = academicProfile?.programId == null ? "" : String(academicProfile.programId);
    $("student-academic-year").value = academicProfile?.studyYear == null ? "" : String(academicProfile.studyYear);
  }

  function renderAcademic() {
    if (!$("student-academic-form")) return;
    const unavailable = !programCatalog || programsLoading || !programCatalog.programs.length && !academicProfile?.programId;
    const busy = academicLoading || academicBusy;
    $("student-academic-fields").disabled = unavailable || busy || !student;
    $("student-academic-submit").disabled = unavailable || busy || !student;
    $("student-academic-submit").textContent = academicBusy ? "Enregistrement…" : "Enregistrer mon parcours";
    const message = programsError || academicError || (busy ? academicBusy ? "Enregistrement de votre parcours…" : "Chargement de votre parcours…" : "");
    $("student-academic-status").textContent = message;
    $("student-academic-status").hidden = !message;
    $("student-academic-retry").hidden = !(programsError || academicError);
    $("student-academic-retry").disabled = busy || programsLoading;
  }

  async function loadAcademicProfile(force = false) {
    const studentId = student?.id;
    if (!studentId || academicPendingFor === studentId || !force && academicStudentId === studentId) return;
    const version = ++academicRevision;
    academicPendingFor = studentId;
    academicLoading = true;
    academicError = "";
    renderAcademic();
    try {
      const [, data] = await Promise.all([loadPrograms(), request("student/academic-profile")]);
      if (version !== academicRevision || student?.id !== studentId) return;
      academicProfile = data.academicProfile ?? data.profile ?? data;
      academicStudentId = studentId;
      setAcademicValues();
    } catch (error) {
      if (version !== academicRevision || student?.id !== studentId) return;
      academicError = error.message;
      if (error.status === 401) invalidate();
    } finally {
      if (version === academicRevision) {
        academicLoading = false;
        academicPendingFor = null;
        renderAcademic();
      }
    }
  }

  function accountPresentation(view) {
    const dialog = $("student-dialog");
    if (!$("student-auth-body")) return;
    const previous = dialog.dataset.accountView;
    if (cancelAccountFlip && previous !== view) cancelAccountFlip();
    dialog.dataset.accountView = view;
    const copy = {
      login: ["Retrouvons-nous sur le campus.", "Vos idées, vos séances, vos prochaines rencontres. Tout commence dans votre espace étudiant."],
      register: ["Prenez votre place.", "Rejoignez la vie du campus et retrouvez les activités qui vous ressemblent."],
      profile: ["Votre campus, votre rythme.", "Un parcours à jour, des activités à partager et un espace qui vous suit."],
      forgot: ["Gardons le lien.", "Retrouvez votre compte pour continuer à faire vivre le campus."],
      reset: ["Un nouveau départ.", "Choisissez un nouveau mot de passe pour retrouver votre espace."],
      change: ["Votre espace, en confiance.", "Mettez votre mot de passe à jour depuis votre compte étudiant."],
    }[view];
    $("student-auth-heading").textContent = copy[0];
    $("student-auth-copy").textContent = copy[1];
    $("student-auth-kicker").textContent = view === "profile" ? "VOTRE ESPACE" : view === "register" ? "BIENVENUE AU CAMPUS" : "ESPACE ÉTUDIANT";
    if (previousAccountFace && previous !== view && ["login", "register"].includes(previous)
      && ["login", "register"].includes(view) && dialog.open && !reducedMotion.matches) {
      const face = previousAccountFace;
      previousAccountFace = null;
      flipAccount(face, previous === "register" ? -180 : 180);
      return;
    }
    previousAccountFace = null;
    if (previous && previous !== view && dialog.open && !reducedMotion.matches) {
      accountAnimation?.cancel();
      accountAnimation = $("student-auth-body").animate?.([
        { opacity: .2, transform: "perspective(1000px) rotateY(-9deg) translateX(15px)" },
        { opacity: 1, transform: "perspective(1000px) rotateY(0deg) translateX(0)" },
      ], { duration: 420, easing: "cubic-bezier(.22,1,.36,1)" });
    }
  }

  function captureAccountFace() {
    cancelAccountFlip?.();
    const body = $("student-auth-body");
    if (!body || !$("student-dialog").open || reducedMotion.matches) return;
    const clone = body.cloneNode(true);
    clone.querySelector("#student-form")?.classList.add("student-auth-form-copy");
    for (const element of [clone, ...clone.querySelectorAll("[id]")]) element.removeAttribute("id");
    for (const label of clone.querySelectorAll("label[for]")) label.removeAttribute("for");
    for (const element of clone.querySelectorAll("input, select, textarea, button")) {
      element.removeAttribute("name");
      element.removeAttribute("autofocus");
      if (element.tagName.toLowerCase() === "input" && (element.type === "password" || element.closest(".student-password-field"))) {
        element.type = "password";
        element.value = "";
        element.removeAttribute("value");
        element.placeholder = "••••••••";
      }
    }
    clone.inert = true;
    clone.setAttribute("aria-hidden", "true");
    previousAccountFace = { clone, height: body.getBoundingClientRect().height };
  }

  function focusAccountField(id) {
    if ($("student-auth-body")?.inert) accountFocusAfterTransition = id;
    else $(id)?.focus();
  }

  function flipAccount(previous, angle) {
    const body = $("student-auth-body");
    const stage = document.createElement("div");
    stage.className = "student-auth-flip-stage";
    stage.style.height = Math.max(previous.height, body.getBoundingClientRect().height) + "px";
    previous.clone.classList.add("student-auth-flip-front");
    body.before(stage);
    stage.append(previous.clone, body);
    body.classList.add("student-auth-flip-back");
    body.inert = true;
    const title = $("student-dialog-title");
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
    let finished = false;
    let flipAnimation;
    function finish() {
      if (finished) return;
      finished = true;
      body.inert = false;
      body.classList.remove("student-auth-flip-back");
      stage.before(body);
      stage.remove();
      flipAnimation?.cancel();
      if (accountAnimation === flipAnimation) accountAnimation = null;
      const focus = accountFocusAfterTransition;
      accountFocusAfterTransition = null;
      cancelAccountFlip = null;
      if (focus && $("student-dialog").open) $(focus)?.focus();
    }
    accountAnimation?.cancel();
    flipAnimation = stage.animate?.([{ transform: "rotateY(0deg)" }, { transform: "rotateY(" + angle + "deg)" }],
      { duration: 650, easing: "cubic-bezier(.45,0,.2,1)", fill: "forwards" });
    accountAnimation = flipAnimation;
    cancelAccountFlip = () => { flipAnimation?.cancel(); finish(); };
    if (flipAnimation?.finished) flipAnimation.finished.then(finish, finish);
    else finish();
  }

  function accountError(message) {
    const error = $("student-error");
    error.textContent = message;
    error.hidden = !message;
  }

  function accountStatus(message) {
    const status = $("student-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  }

  function renderAccount() {
    const account = $("student-account");
    if (!account) return;
    account.textContent = student ? "Mon compte étudiant" : "Connexion étudiante";
    $("student-profile").hidden = !student || Boolean(recoveryMode);
    $("student-form").hidden = Boolean(student) || Boolean(recoveryMode);
    $("student-dialog-title").textContent = recoveryMode ? {
      forgot: "Mot de passe oublié", reset: "Nouveau mot de passe", change: "Changer mon mot de passe",
    }[recoveryMode] : student ? "Mon compte étudiant"
      : mode === "register" ? "Créer mon compte étudiant" : "Connexion étudiante";
    $("student-profile-name").textContent = student?.name || "";
    $("student-profile-email").textContent = student?.email || "";

    const registering = mode === "register";
    $("student-name-row").hidden = !registering;
    $("student-name").required = false;
    for (const id of ["student-first-name", "student-last-name", "student-program", "student-study-year"]) {
      if (!$(id)) continue;
      const academicField = id === "student-program" || id === "student-study-year";
      $(id).required = registering;
      $(id).disabled = !registering || authenticationBusy || academicField && !programCatalog;
    }
    if ($("student-registration-academic")) $("student-registration-academic").hidden = !registering;
    if ($("student-password-hint")) $("student-password-hint").hidden = !registering;
    if ($("student-program-status")) {
      const message = programsError || (programsLoading ? "Chargement des programmes…" : "");
      $("student-program-status").textContent = message;
      $("student-program-status").hidden = !message;
      $("student-program-retry").hidden = !programsError;
      $("student-program-retry").disabled = programsLoading;
    }
    $("student-code-row").hidden = !registering || !signupCodeRequired;
    $("student-access-code").required = registering && signupCodeRequired;
    $("student-password").minLength = registering ? 12 : 0;
    $("student-password").autocomplete = registering ? "new-password" : "current-password";
    $("student-submit").textContent = authenticationBusy ? "Un instant…" : registering ? "Créer mon compte" : "Se connecter";
    $("student-submit").disabled = authenticationBusy || registering && (!programCatalog?.programs.length || programsLoading);
    $("student-mode").textContent = registering ? "J’ai déjà un compte" : "Créer un compte";
    $("student-mode").disabled = authenticationBusy || recoveryBusy;
    $("student-form").setAttribute("aria-busy", String(authenticationBusy));
    if ($("student-registration-privacy")) $("student-registration-privacy").hidden = !registering;
    if ($("student-forgot")) $("student-forgot").hidden = registering;
    if ($("student-recovery-form")) {
      $("student-recovery-form").hidden = !recoveryMode;
      const forgot = recoveryMode === "forgot";
      const changing = recoveryMode === "change";
      $("student-recovery-email-row").hidden = !forgot;
      $("student-recovery-email").required = forgot;
      $("student-current-password-row").hidden = !changing;
      $("student-current-password").required = changing;
      $("student-new-password-row").hidden = forgot;
      $("student-new-password").required = !forgot;
      $("student-confirm-password-row").hidden = forgot;
      $("student-confirm-password").required = !forgot;
      $("student-recovery-submit").textContent = forgot ? "Recevoir le lien" : "Enregistrer le mot de passe";
      $("student-recovery-submit").disabled = recoveryBusy || forgot && !passwordRecoveryEnabled;
      $("student-recovery-back").disabled = recoveryBusy;
      $("student-recovery-form").setAttribute("aria-busy", String(recoveryBusy));
      $("student-recovery-note").textContent = forgot
        ? passwordRecoveryEnabled
          ? "Indiquez l’adresse de votre compte étudiant. Le lien reçu sera valable 30 minutes."
          : "La récupération par e-mail est indisponible. Contactez le responsable du comité pour obtenir un lien de réinitialisation temporaire."
        : "Choisissez un mot de passe de 12 à 128 caractères. Vos sessions sur tous les appareils seront fermées.";
    }
    accountPresentation(recoveryMode || (student ? "profile" : registering ? "register" : "login"));
    renderAcademic();
  }

  function openAccount(forResponse) {
    mode = "login";
    recoveryMode = resetToken !== null ? "reset" : null;
    $("student-dialog-context").hidden = !forResponse;
    accountError("");
    accountStatus("");
    renderAccount();
    const dialog = $("student-dialog");
    if (!dialog.open) dialog.showModal();
    if (student && !recoveryMode) {
      setAcademicValues();
      loadAcademicProfile();
    } else {
      focusAccountField(recoveryMode === "reset" ? "student-new-password" : "student-email");
    }
  }

  function accountChanged() {
    window.dispatchEvent(new Event("gasa:account-change"));
  }

  function broadcastAccountChange() {
    try {
      localStorage.setItem("gasa_account_change", String(Date.now()));
    } catch {
      // La session reste disponible lorsque le stockage local est désactivé.
    }
  }

  async function refreshAccount() {
    if (authorization) return;
    const revision = accountRevision;
    try {
      const data = await request("student/session");
      if (revision !== accountRevision) return;
      const changed = (student?.id || null) !== (data.student?.id || null);
      syncAccount(data);
      if (changed) accountChanged();
    } catch {
      // Une coupure réseau ne réinitialise pas un formulaire en cours.
    }
  }

  function authorize() {
    if (authorization) return authorization;
    authorization = ready.then(() => {
      if (student) return true;
      return new Promise((resolve) => {
        pending = resolve;
        openAccount(true);
      });
    }).finally(() => { authorization = null; });
    return authorization;
  }

  function invalidate() {
    accountRevision += 1;
    academicRevision += 1;
    academicStudentId = null;
    academicPendingFor = null;
    academicLoading = false;
    academicBusy = false;
    academicProfile = null;
    student = null;
    renderAccount();
  }

  function hidePasswords() {
    for (const input of $("student-dialog").querySelectorAll(".student-password-field input")) {
      input.type = "password";
      const toggle = $(input.id + "-visibility");
      if (!toggle) continue;
      toggle.setAttribute("aria-pressed", "false");
      toggle.setAttribute("aria-label", "Afficher " + toggle.dataset.passwordLabel);
      toggle.title = "Afficher " + toggle.dataset.passwordLabel;
    }
  }

  function addPasswordControls() {
    const labels = {
      "student-password": "le mot de passe", "student-current-password": "le mot de passe actuel",
      "student-new-password": "le nouveau mot de passe", "student-confirm-password": "la confirmation du mot de passe",
    };
    for (const input of $("student-dialog").querySelectorAll('input[type="password"]')) {
      const wrapper = document.createElement("span");
      wrapper.className = "student-password-field";
      input.before(wrapper);
      wrapper.append(input);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.id = input.id + "-visibility";
      toggle.className = "student-password-toggle";
      toggle.dataset.passwordLabel = labels[input.id] || "le mot de passe";
      toggle.setAttribute("aria-controls", input.id);
      toggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="student-eye-slash" d="m3 3 18 18"/></svg>';
      toggle.addEventListener("click", () => {
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        toggle.setAttribute("aria-pressed", String(visible));
        const label = (visible ? "Masquer " : "Afficher ") + toggle.dataset.passwordLabel;
        toggle.setAttribute("aria-label", label);
        toggle.title = label;
      });
      wrapper.append(toggle);
    }
    hidePasswords();
  }

  function mountAccountChrome() {
    const dialog = $("student-dialog");
    const children = [...dialog.children];
    const shell = document.createElement("div");
    shell.className = "student-auth-shell";
    const aside = document.createElement("aside");
    aside.className = "student-auth-aside";
    aside.innerHTML = `
      <p class="student-auth-brand">UATM <span>GASA</span></p>
      <div class="student-auth-orbit" aria-hidden="true">
        <svg viewBox="0 0 200 200" fill="none" focusable="false"><circle cx="100" cy="100" r="75"/><ellipse cx="100" cy="100" rx="75" ry="30" transform="rotate(-35 100 100)"/><ellipse cx="100" cy="100" rx="75" ry="30" transform="rotate(35 100 100)"/><circle cx="100" cy="100" r="26"/><circle class="student-orbit-dot" cx="158" cy="52" r="7"/><circle class="student-orbit-dot" cx="38" cy="142" r="5"/></svg>
      </div>
      <div class="student-auth-editorial"><p class="student-auth-kicker" id="student-auth-kicker"></p>
        <h3 id="student-auth-heading"></h3><p id="student-auth-copy"></p>
        <p class="student-auth-footnote">Des idées. Des rencontres. Du lien.</p>
      </div>`;
    const particles = document.createElement("div");
    particles.className = "student-auth-particles";
    particles.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 8; index++) {
      const particle = document.createElement("span");
      particle.style.setProperty("--particle", String(index));
      particles.append(particle);
    }
    aside.prepend(particles);
    const content = document.createElement("div");
    content.className = "student-auth-content";
    const body = document.createElement("div");
    body.id = "student-auth-body";
    body.className = "student-auth-body";
    for (const child of children) {
      if (child.classList.contains("student-dialog-head")) content.append(child);
      else body.append(child);
    }
    content.append(body);
    shell.append(aside, content);
    dialog.append(shell);
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let tiltFrame = 0;
    function resetTilt() {
      cancelAnimationFrame(tiltFrame);
      tiltFrame = 0;
      dialog.style.setProperty("--auth-tilt-x", "0deg");
      dialog.style.setProperty("--auth-tilt-y", "0deg");
    }
    dialog.addEventListener("pointermove", event => {
      if (!dialog.open || reducedMotion.matches || !finePointer.matches || event.pointerType !== "mouse" || tiltFrame) return;
      tiltFrame = requestAnimationFrame(() => {
        tiltFrame = 0;
        const bounds = dialog.getBoundingClientRect();
        const x = Math.max(-.5, Math.min(.5, (event.clientX - bounds.left) / bounds.width - .5));
        const y = Math.max(-.5, Math.min(.5, (event.clientY - bounds.top) / bounds.height - .5));
        dialog.style.setProperty("--auth-tilt-x", (-y * 2).toFixed(2) + "deg");
        dialog.style.setProperty("--auth-tilt-y", (x * 2).toFixed(2) + "deg");
      });
    });
    dialog.addEventListener("pointerleave", resetTilt);
    dialog.addEventListener("close", resetTilt);
    reducedMotion.addEventListener("change", () => { resetTilt(); cancelAccountFlip?.(); accountAnimation?.cancel(); });
  }

  function connectAccount() {
    const dialog = $("student-dialog");
    const form = $("student-form");
    $("student-dialog-context").textContent = "Connectez-vous pour participer aux activités et accéder aux vidéos étudiantes.";
    const previousName = $("student-name");
    previousName.type = "hidden";
    previousName.required = false;
    const nameFields = document.createElement("div");
    nameFields.id = "student-name-row";
    nameFields.className = "student-auth-field-grid";
    nameFields.hidden = true;
    nameFields.innerHTML = `
      <label for="student-first-name">Prénom<input id="student-first-name" name="firstName" autocomplete="given-name" maxlength="50"></label>
      <label for="student-last-name">Nom<input id="student-last-name" name="lastName" autocomplete="family-name" maxlength="50"></label>`;
    $("student-name-row").replaceWith(nameFields);
    nameFields.append(previousName);
    const registrationAcademic = document.createElement("fieldset");
    registrationAcademic.id = "student-registration-academic";
    registrationAcademic.className = "student-registration-academic";
    registrationAcademic.hidden = true;
    registrationAcademic.innerHTML = `
      <legend>Votre parcours</legend>
      <div class="student-auth-field-grid">
        <label for="student-program">Filière<select id="student-program" name="programId"><option value="">Filière</option></select></label>
        <label for="student-study-year">Année<select id="student-study-year" name="studyYear"><option value="">Année</option></select></label>
      </div>
      <p class="student-dialog-note" id="student-program-status" role="status" hidden></p>
      <button type="button" class="student-password-link" id="student-program-retry" hidden>Réessayer le chargement</button>`;
    nameFields.after(registrationAcademic);
    const passwordHint = document.createElement("span");
    passwordHint.id = "student-password-hint";
    passwordHint.className = "student-auth-hint";
    passwordHint.textContent = "12 caractères minimum";
    passwordHint.hidden = true;
    $("student-password").closest("label").append(passwordHint);
    $("student-password").setAttribute("aria-describedby", passwordHint.id);
    const recovery = document.createElement("form");
    recovery.id = "student-recovery-form";
    recovery.hidden = true;
    recovery.innerHTML = `
      <p class="student-dialog-note" id="student-recovery-note"></p>
      <label id="student-recovery-email-row" for="student-recovery-email">Adresse e-mail
        <input type="email" id="student-recovery-email" name="email" autocomplete="username" maxlength="254">
      </label>
      <label id="student-current-password-row" for="student-current-password">Mot de passe actuel
        <input type="password" id="student-current-password" name="currentPassword" autocomplete="current-password" maxlength="128">
      </label>
      <label id="student-new-password-row" for="student-new-password">Nouveau mot de passe
        <input type="password" id="student-new-password" name="password" autocomplete="new-password" minlength="12" maxlength="128">
      </label>
      <label id="student-confirm-password-row" for="student-confirm-password">Confirmer le nouveau mot de passe
        <input type="password" id="student-confirm-password" autocomplete="new-password" minlength="12" maxlength="128">
      </label>
      <div class="student-dialog-actions">
        <button type="submit" class="button button-dark" id="student-recovery-submit">Recevoir le lien</button>
        <button type="button" class="button button-outline" id="student-recovery-back">Retour</button>
      </div>`;
    form.after(recovery);
    const status = document.createElement("p");
    status.id = "student-status";
    status.className = "student-account-status";
    status.setAttribute("role", "status");
    status.hidden = true;
    recovery.after(status);
    const forgot = document.createElement("button");
    forgot.id = "student-forgot";
    forgot.type = "button";
    forgot.className = "student-password-link";
    forgot.textContent = "Mot de passe oublié ?";
    form.append(forgot);
    const privacy = document.createElement("p");
    privacy.id = "student-registration-privacy";
    privacy.className = "student-dialog-note";
    privacy.hidden = true;
    privacy.textContent = "Votre nom, votre e-mail et vos participations sont accessibles aux membres autorisés du comité.";
    $("student-code-row").after(privacy);
    const change = document.createElement("button");
    change.id = "student-password-change";
    change.type = "button";
    change.className = "button button-outline";
    change.textContent = "Changer mon mot de passe";
    $("student-logout").before(change);
    const academic = document.createElement("form");
    academic.id = "student-academic-form";
    academic.className = "student-academic-form";
    academic.setAttribute("aria-labelledby", "student-academic-title");
    academic.innerHTML = `
      <h3 id="student-academic-title">Mon parcours</h3>
      <p class="student-dialog-note">Retrouvez et mettez à jour votre programme et votre année d’études.</p>
      <fieldset id="student-academic-fields" class="student-auth-field-grid">
        <legend class="student-auth-sr-only">Scolarité</legend>
        <label for="student-academic-program">Filière<select id="student-academic-program" name="programId" required><option value="">Filière</option></select></label>
        <label for="student-academic-year">Année<select id="student-academic-year" name="studyYear" required><option value="">Année</option></select></label>
      </fieldset>
      <p id="student-academic-status" class="student-dialog-note" role="status" hidden></p>
      <div class="student-dialog-actions">
        <button class="button button-dark" id="student-academic-submit" type="submit">Enregistrer mon parcours</button>
        <button class="student-password-link" id="student-academic-retry" type="button" hidden>Réessayer</button>
      </div>`;
    $("student-profile-email").after(academic);
    $("student-program-retry").addEventListener("click", () => loadPrograms(true));
    $("student-academic-retry").addEventListener("click", () => {
      if (programsError) loadPrograms(true);
      loadAcademicProfile(true);
    });
    academic.addEventListener("submit", async event => {
      event.preventDefault();
      if ($("student-academic-submit").disabled || !student) return;
      const studentId = student.id;
      const data = Object.fromEntries(new FormData(academic));
      const payload = { programId: data.programId, studyYear: Number(data.studyYear) };
      if (!(programCatalog?.programs.some(item => String(item.id) === payload.programId) || academicProfile?.programId === payload.programId)
        || !programCatalog.years.includes(payload.studyYear)) {
        academicError = "Choisissez votre programme et votre année.";
        renderAcademic();
        return;
      }
      const version = ++academicRevision;
      academicBusy = true;
      academicError = "";
      accountStatus("");
      renderAcademic();
      try {
        const result = await request("student/academic-profile", "PUT", payload);
        if (version !== academicRevision || student?.id !== studentId) return;
        academicProfile = { ...payload, ...(result.academicProfile ?? result.profile ?? result) };
        academicStudentId = studentId;
        setAcademicValues();
        accountStatus("Votre parcours a été mis à jour.");
        broadcastAccountChange();
        accountChanged();
      } catch (error) {
        if (version !== academicRevision || student?.id !== studentId) return;
        academicError = error.message;
        if (error.status === 401) {
          invalidate();
          accountError("Votre session a expiré. Reconnectez-vous pour modifier votre parcours.");
        }
      } finally {
        if (version === academicRevision) {
          academicBusy = false;
          renderAcademic();
        }
      }
    });
    addPasswordControls();
    mountAccountChrome();

    function showRecovery(nextMode) {
      if (authenticationBusy || recoveryBusy) return;
      recoveryMode = nextMode;
      recovery.reset();
      hidePasswords();
      accountError("");
      accountStatus("");
      renderAccount();
      $(nextMode === "forgot" ? "student-recovery-email"
        : nextMode === "change" ? "student-current-password" : "student-new-password").focus();
    }
    forgot.addEventListener("click", () => showRecovery("forgot"));
    change.addEventListener("click", () => showRecovery("change"));
    $("student-recovery-back").addEventListener("click", () => {
      recoveryMode = null;
      resetToken = null;
      recovery.reset();
      hidePasswords();
      accountError("");
      accountStatus("");
      renderAccount();
      focusAccountField(student ? "student-password-change" : "student-email");
    });
    recovery.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = $("student-recovery-submit");
      if (submit.disabled) return;
      const action = recoveryMode;
      const data = Object.fromEntries(new FormData(recovery));
      if (action !== "forgot" && data.password !== $("student-confirm-password").value) {
        accountError("Les deux nouveaux mots de passe ne correspondent pas.");
        $("student-confirm-password").focus();
        return;
      }
      submit.disabled = true;
      recoveryBusy = true;
      $("student-recovery-back").disabled = true;
      accountError("");
      accountStatus("");
      try {
        const payload = action === "forgot" ? { email: data.email }
          : action === "reset" ? { token: resetToken, password: data.password }
          : { currentPassword: data.currentPassword, password: data.password };
        const result = await request("student/password/" + action, "POST", payload);
        recovery.reset();
        hidePasswords();
        if (action !== "forgot") {
          resetToken = null;
          recoveryMode = null;
          mode = "login";
          syncAccount(result);
          broadcastAccountChange();
          accountChanged();
          $("student-email").focus();
        }
        accountStatus(result.message);
      } catch (error) {
        accountError(error.message);
      } finally {
        recoveryBusy = false;
        renderAccount();
      }
    });
    $("student-account").addEventListener("click", async () => {
      await ready;
      openAccount(false);
    });
    $("student-dialog-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      cancelAccountFlip?.();
      previousAccountFace = null;
      pending?.(false);
      pending = null;
      form.reset();
      recovery.reset();
      academic.reset();
      hidePasswords();
      accountAnimation?.cancel();
      recoveryMode = null;
      accountError("");
      accountStatus("");
    });
    $("student-mode").addEventListener("click", () => {
      captureAccountFace();
      mode = mode === "login" ? "register" : "login";
      $("student-password").value = "";
      hidePasswords();
      accountError("");
      accountStatus("");
      if (mode === "register") loadPrograms();
      renderAccount();
      focusAccountField(mode === "register" ? "student-first-name" : "student-email");
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = $("student-submit");
      if (submit.disabled) return;
      const data = Object.fromEntries(new FormData(form));
      authenticationBusy = true;
      renderAccount();
      accountError("");
      accountStatus("");
      try {
        let payload = { email: data.email, password: data.password };
        if (mode === "register") {
          const firstName = String(data.firstName || "").trim().replace(/\s+/gu, " ");
          const lastName = String(data.lastName || "").trim().replace(/\s+/gu, " ");
          const name = [firstName, lastName].join(" ");
          if (!firstName || !lastName || name.length > 100) throw new Error("Saisissez votre prénom et votre nom, avec 100 caractères maximum au total.");
          const studyYear = Number(data.studyYear);
          if (!programCatalog?.programs.some(item => String(item.id) === data.programId) || !programCatalog.years.includes(studyYear)) {
            throw new Error("Choisissez votre programme et votre année.");
          }
          payload = { ...payload, firstName, lastName, name, programId: data.programId, studyYear,
            ...(signupCodeRequired ? { accessCode: data.accessCode } : {}) };
        }
        syncAccount(await request("student/" + mode, "POST", payload));
        broadcastAccountChange();
        if (pending) {
          pending(true);
          pending = null;
        } else {
          accountChanged();
        }
        dialog.close();
      } catch (error) {
        accountError(error.message);
      } finally {
        authenticationBusy = false;
        renderAccount();
      }
    });
    $("student-logout").addEventListener("click", async () => {
      const logout = $("student-logout");
      logout.disabled = true;
      accountError("");
      try {
        syncAccount(await request("student/logout", "POST", {}));
        broadcastAccountChange();
        dialog.close();
        accountChanged();
      } catch (error) {
        accountError(error.message);
      } finally {
        logout.disabled = false;
      }
    });
    renderAccount();
    if (resetToken !== null) ready.then(() => {
      openAccount(false);
      $("student-new-password").focus();
    });
  }

  function base64Key(value) {
    const padded = value + "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  }

  async function connectNotifications() {
    const button = $("student-push");
    const status = $("student-push-status");
    const report = (message) => {
      status.textContent = message;
      status.hidden = !message;
    };

    let config;
    try {
      config = await request("push/config");
    } catch {
      return;
    }
    if (!config.enabled) return;
    const supported = window.isSecureContext && "serviceWorker" in navigator && "Notification" in window && "PushManager" in window;
    if (!supported) {
      if (/iPhone|iPad/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
        report("Sur iPhone et iPad, ajoutez le site à l’écran d’accueil pour activer les notifications.");
      }
      return;
    }

    let registration;
    let subscription;
    try {
      await navigator.serviceWorker.register("/service-worker.js");
      registration = await navigator.serviceWorker.ready;
      subscription = await registration.pushManager.getSubscription();
    } catch {
      report("Les notifications sont indisponibles dans ce navigateur.");
      return;
    }

    function updateButton() {
      button.textContent = subscription ? "Désactiver les notifications" : "Activer les notifications";
      button.setAttribute("aria-pressed", String(Boolean(subscription)));
    }
    button.hidden = false;
    updateButton();
    if (subscription && Notification.permission === "granted") {
      request("push/subscriptions", "POST", subscription.toJSON()).catch(() => {
        report("La synchronisation des notifications a échoué. Réessayez en actualisant la page.");
      });
    }
    button.addEventListener("click", async () => {
      button.disabled = true;
      report("");
      try {
        if (subscription) {
          const oldSubscription = subscription.toJSON();
          await subscription.unsubscribe();
          subscription = null;
          await request("push/subscriptions", "DELETE", oldSubscription);
          report("Notifications désactivées sur cet appareil.");
        } else {
          const permission = Notification.permission === "default"
            ? await Notification.requestPermission() : Notification.permission;
          if (permission !== "granted") {
            report("Autorisez les notifications dans les réglages du navigateur pour les recevoir.");
            return;
          }
          const candidate = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64Key(config.publicKey),
          });
          try {
            await request("push/subscriptions", "POST", candidate.toJSON());
            subscription = candidate;
            report("Notifications activées sur cet appareil.");
          } catch (error) {
            await candidate.unsubscribe().catch(() => {});
            throw error;
          }
        }
      } catch (error) {
        report(error.message || "Activation impossible. Réessayez dans un instant.");
      } finally {
        updateButton();
        button.disabled = false;
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = $("student-theme");
    const color = document.querySelector('meta[name="theme-color"]');
    function applyTheme() {
      root.dataset.studentTheme = theme;
      color.content = theme === "light" ? "#f7f5ef" : "#0b0d13";
      const label = theme === "light" ? "Activer le thème sombre" : "Activer le thème clair";
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
    }
    applyTheme();
    toggle.addEventListener("click", () => {
      theme = theme === "light" ? "dark" : "light";
      applyTheme();
      try {
        localStorage.setItem(preferenceKey, theme);
      } catch {
        // Le thème est déjà appliqué pour cette visite.
      }
    });
    connectAccount();
    connectNotifications();
  });
  window.addEventListener("pageshow", (event) => { if (event.persisted) refreshAccount(); });
  window.addEventListener("focus", refreshAccount);
  window.addEventListener("storage", (event) => {
    if (event.key === "gasa_account_change") refreshAccount();
  });
  window.gasaStudent = { authorize, invalidate };
})();
