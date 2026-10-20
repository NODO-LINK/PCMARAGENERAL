/**
 * correcciones.js
 * -----------------------------------------------------------------------
 * Herramienta de administrador (Catálogos → "Corregir nombres") para
 * cambiar un nombre mal escrito o equivocado en TODOS los registros ya
 * guardados — por ejemplo "CDI EL MOJAN" → "CDI SAN RAFAEL".
 *
 * Cómo se guarda una institución: cada registro (combustible, traslados...)
 * tiene el nombre escrito (institucionNombre, centroDestino...) Y el id de
 * la institución del catálogo (institucionId). Por eso no basta con cambiar
 * texto: si la institución correcta ya existe en el catálogo, los registros
 * se reasignan a ella (id y nombre); si no existe, se renombra la entrada
 * vieja del catálogo y todo queda enlazado igual que antes.
 *
 * Siempre muestra una vista previa y no cambia nada hasta que el
 * administrador confirma.
 * -----------------------------------------------------------------------
 */
import { db, collection, doc, getDocs, writeBatch, serverTimestamp } from "./firebase.js";
import { COLLECTIONS } from "./config.js";
import { toast, confirmDialog, escapeHTML } from "./ui.js";
import { isAdmin, getCurrentUser } from "./auth.js";
import { normalizarBusqueda, reemplazarBusqueda } from "./busqueda.js";

// Colecciones donde puede aparecer un nombre de institución o lugar. No
// incluye hidrometeorología (sus lecturas no se pueden editar por diseño).
const COLECCIONES = [
  { col: COLLECTIONS.DESPACHOS_COMBUSTIBLE, etiqueta: "Despacho de Combustible" },
  { col: COLLECTIONS.TRASLADOS, etiqueta: "Traslados" },
  { col: COLLECTIONS.PACIENTES, etiqueta: "Lista Diaria de Pacientes" },
  { col: COLLECTIONS.FALLECIDOS, etiqueta: "Fallecidos" },
  { col: COLLECTIONS.GUARDIAS, etiqueta: "Guardias de Prevención" },
  { col: COLLECTIONS.EDUCACION, etiqueta: "Educación" },
  { col: COLLECTIONS.INSPECCIONES, etiqueta: "Gestión de Riesgo" },
  { col: COLLECTIONS.INSTITUCIONES, etiqueta: "Catálogo de Instituciones" },
];

// Campos que nunca se tocan (ids y datos de auditoría).
const INTERNOS = /^(id|createdBy|createdByEmail|updatedBy)$/;
const LOTE = 400; // Firestore admite 500 operaciones por lote

let plan = null; // resultado de la última búsqueda, pendiente de confirmar

const contiene = (texto, buscado) => normalizarBusqueda(texto).includes(normalizarBusqueda(buscado).trim());

/** Cambios de UN documento: { campo: valorNuevo } o null si no hay nada que cambiar. */
function cambiosDeDocumento(data, viejo, nuevo, reasignar) {
  const cambios = {};
  Object.entries(data).forEach(([campo, valor]) => {
    if (INTERNOS.test(campo) || typeof valor !== "string") return;
    const r = reemplazarBusqueda(valor, viejo, nuevo);
    if (r.cambios) cambios[campo] = r.texto;
  });
  // Registros enlazados a la institución vieja del catálogo: pasan a la correcta.
  if (reasignar && data.institucionId && reasignar.idsViejos.has(data.institucionId)) {
    cambios.institucionId = reasignar.destino.id;
    if ("institucionNombre" in data) cambios.institucionNombre = reasignar.destino.nombre;
  }
  return Object.keys(cambios).length ? cambios : null;
}

async function buscarCoincidencias(viejo, nuevo) {
  const datos = {};
  for (const { col } of COLECCIONES) {
    const snap = await getDocs(collection(db, col));
    datos[col] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const catalogo = datos[COLLECTIONS.INSTITUCIONES];
  const viejas = catalogo.filter((i) => contiene(i.nombre, viejo));
  const destino = catalogo.find((i) => normalizarBusqueda(i.nombre).trim() === normalizarBusqueda(nuevo).trim());

  // Si la institución correcta ya existe en el catálogo, los registros se
  // reasignan a ella y la vieja se desactiva (no se renombra: quedarían dos
  // iguales). Si no existe, se renombra la vieja y los enlaces siguen válidos.
  const reasignar = destino && viejas.length && !viejas.includes(destino) ? { destino, idsViejos: new Set(viejas.map((i) => i.id)) } : null;

  const grupos = [];
  COLECCIONES.forEach(({ col, etiqueta }) => {
    if (col === COLLECTIONS.INSTITUCIONES && reasignar) return;
    const filas = [];
    datos[col].forEach((row) => {
      const cambios = cambiosDeDocumento(row, viejo, nuevo, col === COLLECTIONS.INSTITUCIONES ? null : reasignar);
      if (cambios) filas.push({ col, id: row.id, antes: row, cambios });
    });
    if (filas.length) grupos.push({ col, etiqueta, filas });
  });
  // Solo se ofrece desactivar las viejas que todavía están activas.
  const porDesactivar = reasignar ? viejas.filter((i) => i.activo !== false) : [];
  return { viejo, nuevo, grupos, reasignar, viejas, porDesactivar };
}

function resumenCambio(fila) {
  return Object.entries(fila.cambios)
    .map(([campo, nuevoValor]) => {
      const antes = fila.antes[campo];
      return `<span class="text-slate-500">${escapeHTML(campo)}:</span> <span class="line-through text-red-600">${escapeHTML(antes ?? "—")}</span> → <span class="text-emerald-700 font-medium">${escapeHTML(nuevoValor)}</span>`;
    })
    .join("<br/>");
}

function pintarVistaPrevia(raiz) {
  if (!plan) {
    raiz.innerHTML = "";
    return;
  }
  const total = plan.grupos.reduce((s, g) => s + g.filas.length, 0);
  if (!total && !plan.porDesactivar.length) {
    raiz.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 p-4 text-sm text-slate-500">No se encontró "<strong>${escapeHTML(plan.viejo)}</strong>" en ningún registro. Revise cómo está escrito (no importan tildes ni mayúsculas).</div>`;
    return;
  }
  const aviso = plan.reasignar
    ? `<p class="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-md p-2 mb-3">"<strong>${escapeHTML(plan.reasignar.destino.nombre)}</strong>" ya existe en el catálogo: los registros se reasignan a esa institución${plan.porDesactivar.length ? ` y se desactiva ${plan.porDesactivar.length === 1 ? "la vieja" : "las viejas"} (${plan.porDesactivar.map((i) => escapeHTML(i.nombre)).join(", ")}).` : "."}</p>`
    : plan.viejas.length
      ? `<p class="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-md p-2 mb-3">La institución del catálogo "<strong>${escapeHTML(plan.viejas[0].nombre)}</strong>" se renombra a "<strong>${escapeHTML(plan.nuevo)}</strong>"; los registros que ya la usan quedan enlazados a ella.</p>`
      : "";
  raiz.innerHTML = `
    <div class="bg-white rounded-lg border border-slate-200 shadow-sm p-4 space-y-3">
      <h4 class="font-semibold text-slate-700">Vista previa: ${total} registro(s) se corregirían${plan.porDesactivar.length ? ` + ${plan.porDesactivar.length} institución(es) del catálogo se desactivan` : ""}</h4>
      ${aviso}
      ${plan.grupos
        .map(
          (g) => `
        <details class="border border-slate-200 rounded-md" ${plan.grupos.length === 1 ? "open" : ""}>
          <summary class="px-3 py-2 cursor-pointer text-sm font-medium text-slate-700 bg-slate-50">${g.etiqueta} — ${g.filas.length} registro(s)</summary>
          <div class="p-3 space-y-2 text-xs max-h-64 overflow-y-auto">
            ${g.filas.slice(0, 8).map((f) => `<div class="border-b border-slate-100 pb-1">${resumenCambio(f)}</div>`).join("")}
            ${g.filas.length > 8 ? `<div class="text-slate-400">… y ${g.filas.length - 8} más</div>` : ""}
          </div>
        </details>`
        )
        .join("")}
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" id="btn-corr-cancelar" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Cancelar</button>
        <button type="button" id="btn-corr-aplicar" class="btn-primary">Aplicar ${total + plan.porDesactivar.length} corrección(es)</button>
      </div>
    </div>`;
}

async function aplicar(raiz) {
  if (!plan) return;
  const usuario = getCurrentUser();
  const operaciones = [];
  plan.grupos.forEach((g) => g.filas.forEach((f) => operaciones.push({ ref: doc(db, f.col, f.id), datos: { ...f.cambios, updatedAt: serverTimestamp(), updatedBy: usuario?.uid || null } })));
  plan.porDesactivar.forEach((i) => operaciones.push({ ref: doc(db, COLLECTIONS.INSTITUCIONES, i.id), datos: { activo: false, updatedAt: serverTimestamp(), updatedBy: usuario?.uid || null } }));

  const ok = await confirmDialog({
    title: "Aplicar correcciones",
    message: `Se modificarán ${operaciones.length} documento(s): "${plan.viejo}" pasará a "${plan.nuevo}". Esta acción cambia datos ya guardados y no se puede deshacer automáticamente (puede volver a usar esta herramienta al revés).`,
    confirmText: "Aplicar",
    danger: false,
  });
  if (!ok) return;

  const boton = raiz.querySelector("#btn-corr-aplicar");
  if (boton) {
    boton.disabled = true;
    boton.textContent = "Aplicando...";
  }
  try {
    for (let i = 0; i < operaciones.length; i += LOTE) {
      const lote = writeBatch(db);
      operaciones.slice(i, i + LOTE).forEach((op) => lote.update(op.ref, op.datos));
      await lote.commit();
    }
    toast(`Listo: ${operaciones.length} documento(s) corregidos.`, "success");
    raiz.innerHTML = `<div class="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-md p-3">Se corrigieron ${operaciones.length} documento(s): "${escapeHTML(plan.viejo)}" → "${escapeHTML(plan.nuevo)}".</div>`;
    plan = null;
  } catch (err) {
    console.error(err);
    toast("No se pudieron aplicar todas las correcciones. Puede volver a buscar: solo quedarán las pendientes.", "error");
    if (boton) {
      boton.disabled = false;
      boton.textContent = "Reintentar";
    }
  }
}

export function initCorrecciones() {
  const viejoInput = document.getElementById("corr-viejo");
  const nuevoInput = document.getElementById("corr-nuevo");
  const botonBuscar = document.getElementById("btn-corr-buscar");
  const raiz = document.getElementById("corr-resultado");
  if (!viejoInput || !nuevoInput || !botonBuscar || !raiz) return;

  viejoInput.value = "CDI EL MOJAN";
  nuevoInput.value = "CDI SAN RAFAEL";

  botonBuscar.addEventListener("click", async () => {
    if (!isAdmin()) return;
    const viejo = viejoInput.value.trim();
    const nuevo = nuevoInput.value.trim();
    if (!viejo || !nuevo) {
      toast("Escriba el texto actual y cómo debe decir.", "error");
      return;
    }
    if (normalizarBusqueda(viejo) === normalizarBusqueda(nuevo) && viejo === nuevo) {
      toast("Los dos textos son iguales.", "error");
      return;
    }
    botonBuscar.disabled = true;
    botonBuscar.textContent = "Buscando...";
    try {
      plan = await buscarCoincidencias(viejo, nuevo);
      pintarVistaPrevia(raiz);
      raiz.querySelector("#btn-corr-aplicar")?.addEventListener("click", () => aplicar(raiz));
      raiz.querySelector("#btn-corr-cancelar")?.addEventListener("click", () => {
        plan = null;
        pintarVistaPrevia(raiz);
      });
    } catch (err) {
      console.error(err);
      toast("No se pudo buscar en los registros. Verifique su conexión o permisos.", "error");
    } finally {
      botonBuscar.disabled = false;
      botonBuscar.textContent = "Buscar coincidencias";
    }
  });
  viejoInput.addEventListener("input", () => {
    plan = null;
    raiz.innerHTML = "";
  });
  nuevoInput.addEventListener("input", () => {
    plan = null;
    raiz.innerHTML = "";
  });
}
