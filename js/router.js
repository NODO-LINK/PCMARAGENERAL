/**
 * router.js
 * -----------------------------------------------------------------------
 * Enrutador simple basado en hash (#vista) para alternar entre los
 * módulos de la aplicación sin recargar la página. También controla la
 * visibilidad de los enlaces de navegación restringidos a administrador.
 * -----------------------------------------------------------------------
 */
import { isAdmin, puedeVerVista, vistaInicial } from "./auth.js";

const registry = new Map(); // viewName -> { onEnter }

export function registerView(name, { onEnter } = {}) {
  registry.set(name, { onEnter });
}

export function navigateTo(name) {
  if (!registry.has(name)) name = vistaInicial();
  window.location.hash = `#${name}`;
}

function applyView(name) {
  // Ocultar el botón del menú no basta: sin esta comprobación se podría abrir
  // la pantalla escribiendo #usuarios (o la de otro departamento) en la
  // dirección. Lo que no le corresponde al usuario lo manda a su pantalla
  // inicial.
  if (!puedeVerVista(name)) {
    name = vistaInicial();
    if (window.location.hash !== `#${name}`) window.location.hash = `#${name}`;
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
  // Cada botón del menú solo se muestra si el usuario puede abrir esa vista.
  document.querySelectorAll(".nav-link[data-view]").forEach((btn) => {
    if (!puedeVerVista(btn.dataset.view)) btn.classList.add("hidden");
    else if (!btn.classList.contains("nav-admin-only")) btn.classList.remove("hidden");
  });

  const entry = registry.get(name);
  if (entry?.onEnter) entry.onEnter();
}

export function initRouter() {
  window.addEventListener("hashchange", () => {
    const name = (window.location.hash || `#${vistaInicial()}`).replace("#", "");
    applyView(name);
  });

  document.querySelectorAll(".nav-link").forEach((btn) => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.view));
  });

  const initial = (window.location.hash || `#${vistaInicial()}`).replace("#", "");
  applyView(registry.has(initial) ? initial : vistaInicial());
  if (!window.location.hash) window.location.hash = `#${vistaInicial()}`;
}
