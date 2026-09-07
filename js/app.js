/**
 * app.js
 * -----------------------------------------------------------------------
 * Punto de entrada de la aplicación. Orquesta:
 *  - El flujo de autenticación (pantalla de login ↔ shell de la app).
 *  - La inicialización de todos los módulos operativos.
 *  - El enrutador de vistas.
 *  - El registro del Service Worker para capacidades PWA.
 * -----------------------------------------------------------------------
 */
import { initAuth, onAuthReady, login, logout, isAdmin, getCurrentProfile } from "./auth.js";
import { initRouter, registerView, navigateTo } from "./router.js";
import { toast } from "./ui.js";
import { renderIcons } from "./icons.js";

import { initCatalogos } from "./catalogos.js";
import { initDashboard, refreshDashboard } from "./dashboard.js";
import { initEmergencias } from "./emergencias.js";
import { initGuardias } from "./guardias.js";
import { initCombustible } from "./combustible.js";
import { initHidrometeorologia, refreshHidrometeorologia } from "./hidrometeorologia.js";
import { initEducacion } from "./educacion.js";
import { initInspeccion } from "./inspeccion.js";
import { initInventario } from "./inventario.js";
import { initReportes } from "./reportes.js";
import { initUsuarios } from "./usuarios.js";

let modulesStarted = false;

function startModules() {
  if (modulesStarted) return;
  modulesStarted = true;
  // El orden importa: catálogos e inventario deben inicializarse antes que
  // los módulos que dependen de sus <select> (combustible → instituciones).
  initCatalogos();
  initInventario();
  initEmergencias();
  initGuardias();
  initCombustible();
  initHidrometeorologia();
  initEducacion();
  initInspeccion();
  initDashboard();
  initReportes();
  initUsuarios();
}

function registerRoutes() {
  registerView("dashboard", { onEnter: refreshDashboard });
  registerView("emergencias");
  registerView("guardias");
  registerView("combustible");
  registerView("hidro", { onEnter: refreshHidrometeorologia });
  registerView("educacion");
  registerView("inspeccion");
  registerView("inventario");
  registerView("reportes", { onEnter: () => initReportes() });
  registerView("catalogos");
  registerView("usuarios");
}

function renderUserBadge() {
  const profile = getCurrentProfile();
  const nameEl = document.getElementById("user-name");
  const roleEl = document.getElementById("user-role");
  if (nameEl) nameEl.textContent = profile?.nombre || profile?.email || "";
  if (roleEl) {
    const admin = isAdmin();
    roleEl.textContent = admin ? "Administrador" : "Operador";
    roleEl.className = `text-xs font-semibold px-2 py-0.5 rounded-full ${admin ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-700"}`;
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
      errorEl.textContent = "Credenciales inválidas o usuario no registrado.";
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
    window.location.hash = "";
  });
}

/**
 * Indicador de conectividad. La app sigue funcionando sin internet gracias
 * a la persistencia offline de Firestore (ver firebase.js): los datos ya
 * sincronizados se pueden seguir consultando y lo que se guarde queda
 * encolado y se envía solo al reconectar. Este indicador solo avisa el
 * estado — no bloquea nada.
 */
function updateConnStatus(isOnline) {
  const el = document.getElementById("conn-status");
  if (!el) return;
  el.classList.remove("hidden");
  el.classList.toggle("flex", true);
  if (isOnline) {
    // Vuelve a un estado neutro/oculto tras avisar brevemente que sincronizó.
    el.className = "flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-100";
    el.innerHTML = '<span class="status-dot"></span>En línea';
    setTimeout(() => el.classList.add("hidden"), 4000);
  } else {
    el.className = "flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full bg-red-500/90 text-white animate-pulse";
    el.innerHTML = '<span class="status-dot"></span>Sin conexión — guardando localmente';
  }
}

function wireConnectivity() {
  window.addEventListener("offline", () => {
    updateConnStatus(false);
    toast("Se perdió la conexión a internet. Puede seguir trabajando: los cambios se guardan localmente y se sincronizan al reconectar.", "warning");
  });
  window.addEventListener("online", () => {
    updateConnStatus(true);
    toast("Conexión restablecida. Sincronizando los cambios pendientes...", "success");
  });
  if (!navigator.onLine) updateConnStatus(false);
}

function boot() {
  renderIcons(); // reemplaza los <span data-icon="..."> del HTML estático (nav, botones) por SVG
  wireLoginForm();
  wireLogout();
  wireConnectivity();
  registerRoutes();

  onAuthReady(({ user, profile }) => {
    const loginScreen = document.getElementById("login-screen");
    const appShell = document.getElementById("app-shell");
    if (user && profile) {
      loginScreen.classList.add("hidden");
      appShell.classList.remove("hidden");
      renderUserBadge();
      startModules();
      initRouter();
      if (!window.location.hash) navigateTo("dashboard");
    } else {
      appShell.classList.add("hidden");
      loginScreen.classList.remove("hidden");
    }
  });

  initAuth();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((err) => console.warn("Service worker no registrado:", err));
    });
  }
}

boot();
