/**
 * router.js
 * -----------------------------------------------------------------------
 * Enrutador simple basado en hash (#vista) para alternar entre los
 * módulos de la aplicación sin recargar la página. También controla la
 * visibilidad de los enlaces de navegación restringidos a administrador.
 * -----------------------------------------------------------------------
 */
import { isAdmin } from "./auth.js";

const registry = new Map(); // viewName -> { onEnter }

export function registerView(name, { onEnter } = {}) {
  registry.set(name, { onEnter });
}

export function navigateTo(name) {
  if (!registry.has(name)) name = "dashboard";
  window.location.hash = `#${name}`;
}

// Una vista es "solo administrador" si su botón de navegación está marcado
// así (o dentro de un bloque marcado así). Ocultar el botón no basta: sin
// esta comprobación un operador podría abrir la pantalla escribiendo
// #usuarios en la dirección.
function esVistaSoloAdmin(name) {
  const btn = document.querySelector(`.nav-link[data-view="${name}"]`);
  return !!btn && (btn.classList.contains("nav-admin-only") || !!btn.closest(".nav-admin-only"));
}

function applyView(name) {
  if (esVistaSoloAdmin(name) && !isAdmin()) {
    name = "dashboard";
    if (window.location.hash !== "#dashboard") window.location.hash = "#dashboard";
  }
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.classList.toggle("nav-active", btn.dataset.view === name);
  });
  const section = document.getElementById(`view-${name}`);
  if (section) section.classList.remove("hidden");

  document.querySelectorAll(".nav-admin-only").forEach((el) => {
    el.classList.toggle("hidden", !isAdmin());
  });

  const entry = registry.get(name);
  if (entry?.onEnter) entry.onEnter();
}

export function initRouter() {
  window.addEventListener("hashchange", () => {
    const name = (window.location.hash || "#dashboard").replace("#", "");
    applyView(name);
  });

  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.view));
  });

  const initial = (window.location.hash || "#dashboard").replace("#", "");
  applyView(registry.has(initial) ? initial : "dashboard");
  if (!window.location.hash) window.location.hash = "#dashboard";
}
