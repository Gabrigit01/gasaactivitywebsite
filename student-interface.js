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
    if (!response.ok) throw new Error(data.error || "Impossible de joindre le site.");
    return data;
  }

  let student = null;
  let signupCodeRequired = false;
  let passwordRecoveryEnabled = false;
  let recoveryMode = null;
  let recoveryBusy = false;
  let mode = "login";
  let pending = null;
  let authorization = null;
  let accountRevision = 0;

  function syncAccount(data) {
    accountRevision += 1;
    student = data.student;
    signupCodeRequired = data.signupCodeRequired;
    passwordRecoveryEnabled = Boolean(data.passwordRecoveryEnabled);
    renderAccount();
  }

  const ready = request("student/session").then(syncAccount).catch(() => {});

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
    $("student-name").required = registering;
    $("student-code-row").hidden = !registering || !signupCodeRequired;
    $("student-access-code").required = registering && signupCodeRequired;
    $("student-password").minLength = registering ? 12 : 0;
    $("student-password").autocomplete = registering ? "new-password" : "current-password";
    $("student-submit").textContent = registering ? "Créer mon compte" : "Se connecter";
    $("student-mode").textContent = registering ? "J’ai déjà un compte" : "Créer un compte";
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
      $("student-recovery-note").textContent = forgot
        ? passwordRecoveryEnabled
          ? "Indiquez l’adresse de votre compte étudiant. Le lien reçu sera valable 30 minutes."
          : "La récupération par e-mail est indisponible. Contactez le responsable du site."
        : "Choisissez un mot de passe de 12 à 128 caractères. Vos sessions sur tous les appareils seront fermées.";
    }
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
    student = null;
    renderAccount();
  }

  function connectAccount() {
    const dialog = $("student-dialog");
    const form = $("student-form");
    $("student-dialog-context").textContent = "Connectez-vous pour participer aux activités et accéder aux vidéos étudiantes.";
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

    function showRecovery(nextMode) {
      recoveryMode = nextMode;
      recovery.reset();
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
      accountError("");
      accountStatus("");
      renderAccount();
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
      pending?.(false);
      pending = null;
      form.reset();
      recovery.reset();
      recoveryMode = null;
      accountError("");
      accountStatus("");
    });
    $("student-mode").addEventListener("click", () => {
      mode = mode === "login" ? "register" : "login";
      $("student-password").value = "";
      accountError("");
      renderAccount();
      $(mode === "register" ? "student-name" : "student-email").focus();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = $("student-submit");
      if (submit.disabled) return;
      submit.disabled = true;
      accountError("");
      try {
        const data = Object.fromEntries(new FormData(form));
        syncAccount(await request("student/" + mode, "POST", data));
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
        submit.disabled = false;
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
