/**
 * icons.js
 * -----------------------------------------------------------------------
 * Set de íconos vectoriales (SVG, solo silueta — trazo, sin relleno,
 * `currentColor`) que reemplaza los emojis en toda la interfaz. Un emoji
 * se ve distinto según el sistema operativo/navegador (Windows, macOS,
 * Android, iOS...) y rompe la imagen sobria institucional; estos íconos
 * son idénticos en cualquier dispositivo y heredan el color del texto que
 * los rodea (incluido el modo oscuro/hover, sin CSS adicional).
 *
 * Dos formas de uso:
 *  1. HTML estático: <span class="icon" data-icon="dashboard"></span>
 *     y luego llamar a renderIcons() una vez al iniciar (ver app.js).
 *  2. HTML generado por JS (plantillas de historial, botones dinámicos):
 *     importar getIcon("dashboard") e interpolarlo en el template literal.
 * -----------------------------------------------------------------------
 */

// Cada entrada es el contenido interno de un <svg viewBox="0 0 24 24">
// (trazos únicamente, sin relleno salvo donde se indique explícitamente).
const RAW = {
  dashboard: `<line x1="3" y1="21" x2="21" y2="21"/><rect x="5" y="12" width="3" height="8"/><rect x="10.5" y="7" width="3" height="13"/><rect x="16" y="15" width="3" height="5"/>`,
  emergencia: `<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>`,
  escudo: `<path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z"/>`,
  combustible: `<path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15"/><path d="M4 11h8"/><path d="M14 8h2.5l2.5 2.5V17a1.5 1.5 0 0 1-3 0v-3"/><path d="M2 21h14"/>`,
  ola: `<path d="M2 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>`,
  graduacion: `<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-5.5"/><path d="M22 8v6"/>`,
  buscar: `<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  caja: `<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>`,
  impresora: `<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1"/><path d="M6 17v4h12v-4"/>`,
  carpeta: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>`,
  usuario: `<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/>`,
  mas: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  check: `<polyline points="20 6 9 17 4 12"/>`,
  refrescar: `<path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/>`,
  descargar: `<path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><path d="M5 21h14"/>`,
  portapapeles: `<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="15" y2="15"/>`,
  alerta: `<path d="M12 3 2 20h20L12 3z"/><line x1="12" y1="9" x2="12" y2="13.5"/><circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none"/>`,
};

/** Devuelve el <svg> como string, listo para interpolar en un template literal. */
export function getIcon(name, { size = 16, className = "" } = {}) {
  const paths = RAW[name];
  if (!paths) return "";
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon-svg ${className}" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** Rellena todos los <span data-icon="..."> dentro de `root` con su SVG. */
export function renderIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const size = Number(el.dataset.iconSize) || 16;
    el.innerHTML = getIcon(el.dataset.icon, { size });
  });
}
