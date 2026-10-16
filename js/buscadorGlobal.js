/**
 * buscadorGlobal.js
 * -----------------------------------------------------------------------
 * Buscador de la barra superior: busca en TODOS los módulos a los que el
 * usuario tiene acceso (según su rol/departamentos) y muestra los
 * resultados agrupados por módulo. Al elegir uno, abre ese módulo en la
 * pestaña correcta y deja escrita la búsqueda en su historial, para que
 * aparezca el registro filtrado.
 *
 *  - Mismo criterio de búsqueda que el resto de la página (js/busqueda.js):
 *    sin tildes ni mayúsculas, varias palabras en cualquier orden.
 *  - Atajos: "/" o Ctrl+K enfocan el cuadro; ↑ ↓ Enter para elegir; Esc cierra.
 *  - Los datos se piden la primera vez que se usa (no al abrir la app) y
 *    solo de las colecciones que el usuario puede leer.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS } from "./config.js";
import { subscribeCollection } from "./data.js";
import { puedeVerVista, puedeLeerColeccion } from "./auth.js";
import { navigateTo } from "./router.js";
import { formatDate, toDate } from "./ui.js";
import { coincideBusqueda, resaltarBusqueda, terminosDeBusqueda } from "./busqueda.js";

const MIN_CARACTERES = 2;
const MAX_POR_MODULO = 5;
const MAX_TOTAL = 40;

const f = (v, hora = false) => formatDate(v, hora);
const unir = (...partes) => partes.filter((p) => p !== undefined && p !== null && String(p).trim() !== "" && p !== "—").join(" · ");

/**
 * Qué se busca y cómo se muestra cada colección.
 *  - vista / subtab: a dónde se navega al elegir el resultado.
 *  - campoBusqueda: id del cuadro de búsqueda del destino si no es el del
 *    historial estándar (que se localiza solo dentro de la pestaña).
 */
const FUENTES = [
  { col: COLLECTIONS.PACIENTES, orden: "fecha", modulo: "Lista Diaria de Pacientes", vista: "emergencias", subtab: "pacientes",
    titulo: (r) => `Lista diaria del ${f(r.fecha)}`, detalle: (r) => unir(`${r.ninos || 0} niños`, `${r.adolescentes || 0} adolescentes`, `${r.adultos || 0} adultos`, r.responsable) },
  { col: COLLECTIONS.TRASLADOS, orden: "fecha", modulo: "Traslados", vista: "emergencias", subtab: "traslados",
    titulo: (r) => r.nombrePaciente || "Traslado", detalle: (r) => unir(f(r.fecha, true), r.tipo, r.institucionNombre || r.centroDestino, r.unidad) },
  { col: COLLECTIONS.FALLECIDOS, orden: "fecha", modulo: "Fallecidos", vista: "emergencias", subtab: "fallecidos",
    titulo: (r) => r.nombre || "Fallecido", detalle: (r) => unir(f(r.fecha), r.causa, r.lugar) },
  { col: COLLECTIONS.GUARDIAS, orden: "fecha", modulo: "Guardias de Prevención", vista: "guardias",
    titulo: (r) => unir(r.parroquia, r.lugar) || "Guardia", detalle: (r) => unir(f(r.fecha), r.descripcion, r.responsable) },
  { col: COLLECTIONS.DESPACHOS_COMBUSTIBLE, orden: "fecha", modulo: "Combustible", vista: "combustible",
    titulo: (r) => r.institucionNombre || "Despacho", detalle: (r) => unir(f(r.fecha), `${r.litros ?? ""} L ${r.tipoCombustible || ""}`.trim(), r.unidadVehicular) },
  { col: COLLECTIONS.EDUCACION, orden: "fecha", modulo: "Educación", vista: "educacion",
    titulo: (r) => r.nombre || "Actividad", detalle: (r) => unir(f(r.fecha), r.tema, r.tipoInstitucion) },
  { col: COLLECTIONS.INSPECCIONES, orden: "fecha", modulo: "Gestión de Riesgo", vista: "inspeccion",
    titulo: (r) => unir(r.codigoInspeccion, r.institucion) || "Inspección", detalle: (r) => unir(f(r.fecha), r.solicitante, r.observacion) },
  { col: COLLECTIONS.HIDRO_LECTURAS, orden: "fecha", modulo: "Fluviometría", vista: "hidro", subtab: "fluviometria",
    titulo: (r) => `${r.rioNombre || "Río"} — nivel ${r.nivel}`, detalle: (r) => unir(f(r.fecha, true), r.lluvia ? `${r.lluvia} mm/m²` : "", r.responsable) },
  { col: COLLECTIONS.PLUVIOMETRIA_LECTURAS, orden: "fecha", modulo: "Pluviometría", vista: "hidro", subtab: "pluviometria",
    titulo: (r) => `${r.estacionNombre || "Estación"} — ${r.lluvia} mm/m²`, detalle: (r) => unir(f(r.fecha), r.responsable) },
  { col: COLLECTIONS.INSUMOS, orden: "nombre", modulo: "Catálogo de Insumos", vista: "inventario", subtab: "catalogo", campoBusqueda: "insumos-catalogo-buscar",
    titulo: (r) => r.nombre || "Insumo", detalle: (r) => r.categoriaNombre || "" },
  { col: COLLECTIONS.INSUMO_STOCK, orden: "insumoNombre", modulo: "Existencias", vista: "inventario", subtab: "existencias", campoBusqueda: "stock-buscar",
    titulo: (r) => r.insumoNombre || "Existencia", detalle: (r) => unir(r.almacen, `existencia ${r.existencia ?? 0}`, r.categoriaNombre) },
  { col: COLLECTIONS.INSTITUCIONES, orden: "nombre", modulo: "Instituciones", vista: "catalogos", subtab: "instituciones",
    titulo: (r) => r.nombre || "Institución", detalle: (r) => r.categoria || "" },
  { col: COLLECTIONS.USUARIOS, orden: "nombre", modulo: "Usuarios", vista: "usuarios",
    titulo: (r) => r.nombre || r.email, detalle: (r) => r.email || "" },
];

const datos = {}; // colección -> registros
let fuentesActivas = [];
let iniciado = false;
let resultados = []; // [{ fuente, row, titulo, detalle }] en el orden mostrado
let activo = -1;

const INTERNOS = /^(id|createdBy|createdByEmail|updatedBy)$|Id$/;

// Todo el texto de un registro: campos de texto/número (menos ids y datos
// de auditoría) y las fechas ya formateadas, para poder buscar "10/2026".
function textoDe(row) {
  return Object.entries(row)
    .map(([k, v]) => {
      if (INTERNOS.test(k)) return "";
      if (typeof v === "string" || typeof v === "number") return v;
      if (v && typeof v.toDate === "function" && toDate(v)) return f(v, true);
      return "";
    })
    .join(" ");
}

function buscar(consulta) {
  const salida = [];
  let total = 0;
  fuentesActivas.forEach((fuente) => {
    const filas = (datos[fuente.col] || []).filter((r) => coincideBusqueda(textoDe(r), consulta));
    total += filas.length;
    filas.slice(0, MAX_POR_MODULO).forEach((row) => salida.push({ fuente, row, titulo: fuente.titulo(row), detalle: fuente.detalle(row), totalModulo: filas.length }));
  });
  return { salida: salida.slice(0, MAX_TOTAL), total };
}

function iniciarSuscripciones(alCambiar) {
  if (iniciado) return;
  iniciado = true;
  fuentesActivas = FUENTES.filter((fu) => puedeVerVista(fu.vista) && puedeLeerColeccion(fu.col));
  fuentesActivas.forEach((fu) => {
    subscribeCollection(fu.col, fu.orden, (rows) => {
      datos[fu.col] = rows;
      alCambiar();
    });
  });
}

/** Abre el módulo del resultado y deja escrita la búsqueda en su historial. */
function abrirResultado(item, consulta) {
  const { vista, subtab, campoBusqueda } = item.fuente;
  navigateTo(vista);
  setTimeout(() => {
    if (subtab) document.querySelector(`#view-${vista} .subtab-btn[data-subtab="${subtab}"]`)?.click();
    const contenedor = subtab ? document.getElementById(`panel-${subtab}`) : document.getElementById(`view-${vista}`);
    const caja = campoBusqueda ? document.getElementById(campoBusqueda) : contenedor?.querySelector('input[type="search"][id$="-q"]');
    if (caja) {
      caja.value = consulta;
      caja.dispatchEvent(new Event("input", { bubbles: true }));
      caja.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, 80);
}

export function initBuscadorGlobal() {
  const raiz = document.getElementById("busqueda-global");
  const caja = document.getElementById("busqueda-global-input");
  const panel = document.getElementById("busqueda-global-panel");
  if (!raiz || !caja || !panel) return;

  const cerrar = () => {
    panel.classList.add("hidden");
    activo = -1;
  };
  const marcarActivo = () => {
    panel.querySelectorAll("[data-i]").forEach((el) => {
      const on = Number(el.dataset.i) === activo;
      el.classList.toggle("bg-sky-50", on);
      if (on) el.scrollIntoView({ block: "nearest" });
    });
  };

  function pintar() {
    const consulta = caja.value;
    if (terminosDeBusqueda(consulta).join("").length < MIN_CARACTERES) {
      cerrar();
      return;
    }
    const { salida, total } = buscar(consulta);
    resultados = salida;
    activo = salida.length ? 0 : -1;
    panel.classList.remove("hidden");

    if (!salida.length) {
      panel.innerHTML = `<div class="px-4 py-6 text-center text-sm text-slate-400">${iniciado && !Object.keys(datos).length ? "Cargando…" : "Sin resultados para esa búsqueda."}</div>`;
      return;
    }
    let html = "";
    let moduloActual = null;
    salida.forEach((it, i) => {
      if (it.fuente.modulo !== moduloActual) {
        moduloActual = it.fuente.modulo;
        const extra = it.totalModulo > MAX_POR_MODULO ? ` · ${it.totalModulo} resultados` : "";
        html += `<div class="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 bg-slate-50 sticky top-0">${moduloActual}${extra}</div>`;
      }
      html += `<button type="button" data-i="${i}" class="w-full text-left px-4 py-2 hover:bg-sky-50 border-b border-slate-100 block">
          <div class="text-sm font-medium text-slate-800 truncate">${resaltarBusqueda(it.titulo, consulta)}</div>
          <div class="text-xs text-slate-500 truncate">${resaltarBusqueda(it.detalle, consulta)}</div>
        </button>`;
    });
    html += `<div class="px-4 py-1.5 text-[11px] text-slate-400 bg-slate-50">${total} coincidencia(s) en total · ↑ ↓ para moverse, Enter para abrir</div>`;
    panel.innerHTML = html;
    marcarActivo();
  }

  const elegir = (i) => {
    const item = resultados[i];
    if (!item) return;
    const consulta = caja.value;
    cerrar();
    caja.blur();
    abrirResultado(item, consulta);
  };

  let temporizador;
  caja.addEventListener("focus", () => {
    iniciarSuscripciones(() => {
      if (document.activeElement === caja && !panel.classList.contains("hidden")) pintar();
    });
    if (caja.value) pintar();
  });
  caja.addEventListener("input", () => {
    iniciarSuscripciones(pintar);
    clearTimeout(temporizador);
    temporizador = setTimeout(pintar, 120);
  });
  caja.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      cerrar();
      caja.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!resultados.length || panel.classList.contains("hidden")) return;
      e.preventDefault();
      activo = (activo + (e.key === "ArrowDown" ? 1 : -1) + resultados.length) % resultados.length;
      marcarActivo();
    } else if (e.key === "Enter") {
      e.preventDefault();
      elegir(activo >= 0 ? activo : 0);
    }
  });
  panel.addEventListener("mousedown", (e) => {
    // mousedown (no click): se ejecuta antes de que el cuadro pierda el foco.
    const btn = e.target.closest("[data-i]");
    if (btn) {
      e.preventDefault();
      elegir(Number(btn.dataset.i));
    }
  });
  document.addEventListener("mousedown", (e) => {
    if (!raiz.contains(e.target)) cerrar();
  });
  document.getElementById("busqueda-global-limpiar")?.addEventListener("click", () => {
    caja.value = "";
    cerrar();
    caja.focus();
  });

  // Atajos: "/" o Ctrl/Cmd+K desde cualquier parte (si no se está escribiendo en otro campo).
  document.addEventListener("keydown", (e) => {
    const escribiendo = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "") || document.activeElement?.isContentEditable;
    if ((e.key === "/" && !escribiendo && !e.ctrlKey && !e.metaKey) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      caja.focus();
      caja.select();
    }
  });
}
