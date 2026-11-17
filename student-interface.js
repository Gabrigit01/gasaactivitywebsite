"use strict";

(() => {
  const presentations = new Set(["light", "dark"]);
  const preferenceKey = "gasa_student_theme";
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

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
  let mode = "login";
  let pending = null;
  let authorization = null;
  let accountRevision = 0;

  function syncAccount(data) {
    accountRevision += 1;
    student = data.student;
    signupCodeRequired = data.signupCodeRequired;
    renderAccount();
  }

  const ready = request("student/session").then(syncAccount).catch(() => {});

  function accountError(message) {
    const error = $("student-error");
    error.textContent = message;
    error.hidden = !message;
  }

  function renderAccount() {
    const account = $("student-account");
    if (!account) return;
    account.textContent = student ? "Mon compte étudiant" : "Connexion étudiante";
    $("student-profile").hidden = !student;
    $("student-form").hidden = Boolean(student);
    $("student-dialog-title").textContent = student ? "Mon compte étudiant"
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
  }

  function openAccount(forResponse) {
    mode = "login";
    $("student-dialog-context").hidden = !forResponse;
    accountError("");
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
    $("student-account").addEventListener("click", async () => {
      await ready;
      openAccount(false);
    });
    $("student-dialog-close").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      pending?.(false);
      pending = null;
      form.reset();
      accountError("");
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
