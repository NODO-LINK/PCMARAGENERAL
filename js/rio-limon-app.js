/**
 * rio-limon-app.js
 * -----------------------------------------------------------------------
 * Punto de entrada de rio-limon.html: una página INDEPENDIENTE del resto
 * del sistema, pensada para entregarle a un trabajador acceso SOLO al
 * módulo de Hidrometeorología (Río Limón) — sin menú ni acceso a ningún
 * otro módulo. A diferencia de monitor.js (que corre en Smart TV y por eso
 * está escrito en ES5 sin módulos), esta página corre en el navegador
 * normal de un trabajador, así que reutiliza los módulos ES6 reales de la
 * app (mismo login, misma lógica de Hidrometeorología) en vez de
 * duplicarlos.
 *
 * El bloqueo real a los demás módulos NO está aquí (esto es solo la
 * interfaz) — está en firestore.rules, rol "hidro": ese usuario no puede
 * leer ni escribir nada fuera de hidroLecturas aunque intente entrar a
 * index.html con las mismas credenciales (de hecho, index.html lo
 * redirige automáticamente a esta página — ver js/app.js).
 * -----------------------------------------------------------------------
 */
import { initAuth, onAuthReady, login, logout, isAdmin, getCurrentProfile, loginErrorMessage } from "./auth.js";
import { initHidrometeorologia } from "./hidrometeorologia.js";
import { renderIcons } from "./icons.js";

function renderUserBadge() {
  const profile = getCurrentProfile();
  const nameEl = document.getElementById("user-name");
  const roleEl = document.getElementById("user-role");
  if (nameEl) nameEl.textContent = profile?.nombre || profile?.email || "";
  if (roleEl) {
    const admin = isAdmin();
    roleEl.textContent = admin ? "Administrador" : "Hidrometeorología";
    roleEl.className = `text-xs font-semibold px-2 py-0.5 rounded-full ${admin ? "bg-red-100 text-red-700" : "bg-sky-100 text-sky-800"}`;
  }
  document.querySelectorAll(".role-admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin()));
}

function wireLoginForm() {
  const form = document.getElementById("login-form");
  const errorEl = document.getElementById("login-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    const email = form.elements["email"].value.trim();
    const password = form.elements["password"].value;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Ingresando...";
    try {
      await login(email, password);
    } catch (err) {
      console.error(err);
      errorEl.textContent = loginErrorMessage(err);
      errorEl.classList.remove("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "Ingresar";
    }
  });
}

function wireLogout() {
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await logout();
  });
}

let moduleStarted = false;

function boot() {
  renderIcons();
  wireLoginForm();
  wireLogout();

  onAuthReady(({ user, profile }) => {
    const loginScreen = document.getElementById("login-screen");
    const appShell = document.getElementById("app-shell");
    if (user && profile) {
      loginScreen.classList.add("hidden");
      appShell.classList.remove("hidden");
      renderUserBadge();
      if (!moduleStarted) {
        moduleStarted = true;
        initHidrometeorologia();
      }
    } else {
      appShell.classList.add("hidden");
      loginScreen.classList.remove("hidden");
    }
  });

  initAuth();

  // Requisito técnico para que el navegador ofrezca "Agregar a pantalla de
  // inicio" (instalación como app, con su propio ícono y sin barra de
  // navegador) — reutiliza el mismo service worker que la app principal,
  // que ya incluye esta página en su lista de archivos (ver APP_SHELL en
  // service-worker.js).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((err) => console.warn("Service worker no registrado:", err));
    });
  }
}

boot();
