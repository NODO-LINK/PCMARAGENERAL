import { COLLECTIONS, CATEGORIAS_INSTITUCIONES } from "./config.js";
import { createCrudModule } from "./moduleFactory.js";
import { formatDate, escapeHTML, toast, toDate, printAdHoc, printFooterHTML, exportToExcelMulti, exportToPDFMulti } from "./ui.js";
import { createRecord, updateRecord } from "./data.js";
import { getResponsableLabel } from "./auth.js";
import { quitarAcentos, leerArchivoTabular, mapearFila, parsearFechaLegado } from "./importUtils.js";
import { getInstituciones } from "./catalogos.js";

let moduleRef = null;

export function initCombustible() {
  const form = document.getElementById("form-combustible");

  moduleRef = createCrudModule({
    collectionName: COLLECTIONS.DESPACHOS_COMBUSTIBLE,
    form,
    historialRoot: document.getElementById("historial-combustible"),
    dateField: "fecha",
    historialTitle: "Historial de Despachos de Combustible",
    firmas: ["Despachador", "Director"],
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "institucionNombre", label: "Institución" },
      { key: "tipoCombustible", label: "Tipo" },
      { key: "litros", label: "Litros" },
      { key: "unidadVehicular", label: "Unidad / Placa" },
      { key: "responsable", label: "Responsable" },
    ],
    beforeSave: (data) => {
      const select = form.elements["institucionId"];
      const opt = select.options[select.selectedIndex];
      if (!opt || !opt.value) {
        toast("Debe seleccionar una institución del catálogo.", "error");
        return null;
      }
      data.institucionNombre = opt.dataset.nombre;
      data.litros = Number(data.litros) || 0;
      return data;
    },
  });

  setupImportacionCombustible();
  setupReporteMensual();

  return moduleRef;
}

/* ---------------------------------------------------------------------- */
/* Reporte por mes e institución (imprimir / Excel / PDF)                   */
/* ---------------------------------------------------------------------- */
const MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const T_CELDA = "border:1px solid #94a3b8;padding:4px 8px;font-size:11px;";
const T_CAB = "border:1px solid #94a3b8;padding:4px 8px;font-size:11px;background:#f1f5f9;text-align:left;";
const num = (n) => String(Math.round(n * 100) / 100);

/** Despachos del mes agrupados por institución: [{ nombre, filas, gasolina, diesel, total }] */
function gruposDelMes(mes, soloInstitucion) {
  const filas = (moduleRef?.getRows() || []).filter((r) => {
    const d = toDate(r.fecha);
    return d && d.toLocaleDateString("en-CA").startsWith(mes);
  });
  const porInst = new Map();
  filas.forEach((r) => {
    const nombre = r.institucionNombre || "(sin institución)";
    if (soloInstitucion && nombre !== soloInstitucion) return;
    if (!porInst.has(nombre)) porInst.set(nombre, []);
    porInst.get(nombre).push(r);
  });
  return [...porInst.entries()]
    .map(([nombre, f]) => {
      f.sort((a, b) => toDate(a.fecha) - toDate(b.fecha));
      const suma = (tipo) => f.filter((r) => String(r.tipoCombustible || "").toLowerCase().startsWith(tipo)).reduce((s, r) => s + (Number(r.litros) || 0), 0);
      const gasolina = suma("gasolina");
      const diesel = suma("diesel") + suma("diésel");
      return { nombre, filas: f, gasolina, diesel, total: f.reduce((s, r) => s + (Number(r.litros) || 0), 0) };
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

const nombreMesTxt = (mes) => `${MESES[Number(mes.split("-")[1]) - 1]} ${mes.split("-")[0]}`;
const filasTabla = (g) => g.filas.map((r) => [formatDate(r.fecha), r.tipoCombustible || "", num(Number(r.litros) || 0), r.unidadVehicular || "", r.responsable || ""]);
const CABECERA_INST = ["Fecha", "Tipo", "Litros", "Unidad / Placa", "Responsable"];
const resumenInst = (g) => `Gasolina: ${num(g.gasolina)} L — Diésel: ${num(g.diesel)} L — Total: ${num(g.total)} L`;

function imprimirReporteMensual(mes, institucion) {
  const grupos = gruposDelMes(mes, institucion);
  if (!grupos.length) return toast("No hay despachos de combustible en ese mes" + (institucion ? " para esa institución." : "."), "warning");
  const titulo = nombreMesTxt(mes);
  const tabla = (g) => `<table style="width:100%;border-collapse:collapse;margin-top:8px;">
      <thead><tr>${CABECERA_INST.map((h) => `<th style="${T_CAB}">${h}</th>`).join("")}</tr></thead>
      <tbody>${filasTabla(g).map((f) => `<tr style="page-break-inside:avoid;">${f.map((c) => `<td style="${T_CELDA}">${escapeHTML(c)}</td>`).join("")}</tr>`).join("")}
      <tr style="font-weight:bold;background:#f8fafc;"><td style="${T_CELDA}" colspan="2">TOTAL (${g.filas.length} despacho(s))</td><td style="${T_CELDA}">${num(g.total)}</td><td style="${T_CELDA}" colspan="2">Gasolina ${num(g.gasolina)} L · Diésel ${num(g.diesel)} L</td></tr></tbody>
    </table>`;
  const seccion = (g, primera) => `<div style="padding:8px 20px;font-family:Arial,Helvetica,sans-serif;color:#1e293b;${primera ? "" : "page-break-before:always;break-before:page;"}">
      <h2 style="text-align:center;font-size:15px;margin:6px 0 2px;">DESPACHO DE COMBUSTIBLE — ${escapeHTML(g.nombre.toUpperCase())}</h2>
      <p style="text-align:center;font-size:11px;margin:0 0 6px;color:#475569;">Mes: ${titulo}</p>
      ${tabla(g)}
      <div class="print-footer">${printFooterHTML(["Despachador", "Director"], 3)}</div>
    </div>`;

  let cuerpo = "";
  if (grupos.length > 1) {
    const tg = grupos.reduce((s, g) => s + g.total, 0);
    cuerpo += `<div style="padding:8px 20px;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
      <h2 style="text-align:center;font-size:15px;margin:6px 0 2px;">RESUMEN DE DESPACHOS DE COMBUSTIBLE POR INSTITUCIÓN</h2>
      <p style="text-align:center;font-size:11px;margin:0 0 6px;color:#475569;">Mes: ${titulo}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:8px;">
        <thead><tr>${["Institución", "Despachos", "Gasolina (L)", "Diésel (L)", "Total (L)"].map((h) => `<th style="${T_CAB}">${h}</th>`).join("")}</tr></thead>
        <tbody>${grupos.map((g) => `<tr><td style="${T_CELDA}">${escapeHTML(g.nombre)}</td><td style="${T_CELDA}">${g.filas.length}</td><td style="${T_CELDA}">${num(g.gasolina)}</td><td style="${T_CELDA}">${num(g.diesel)}</td><td style="${T_CELDA}font-weight:bold;">${num(g.total)}</td></tr>`).join("")}
        <tr style="font-weight:bold;background:#f8fafc;"><td style="${T_CELDA}">TOTAL GENERAL</td><td style="${T_CELDA}">${grupos.reduce((s, g) => s + g.filas.length, 0)}</td><td style="${T_CELDA}">${num(grupos.reduce((s, g) => s + g.gasolina, 0))}</td><td style="${T_CELDA}">${num(grupos.reduce((s, g) => s + g.diesel, 0))}</td><td style="${T_CELDA}">${num(tg)}</td></tr></tbody>
      </table>
      <div class="print-footer">${printFooterHTML(["Despachador", "Director"], 3)}</div>
    </div>`;
  }
  cuerpo += grupos.map((g, i) => seccion(g, grupos.length === 1 && i === 0)).join("");
  printAdHoc(`Despacho de Combustible — ${titulo}`, cuerpo, null);
}

function descargarReporteMensual(mes, institucion, formato) {
  const grupos = gruposDelMes(mes, institucion);
  if (!grupos.length) return toast("No hay despachos de combustible en ese mes" + (institucion ? " para esa institución." : "."), "warning");
  const titulo = nombreMesTxt(mes);
  const archivo = `Combustible_${mes}${institucion ? "_" + institucion.replace(/[^\w]+/g, "_").slice(0, 30) : "_todas"}`;
  const resumen = grupos.map((g) => [g.nombre, String(g.filas.length), num(g.gasolina), num(g.diesel), num(g.total)]);
  if (formato === "xlsx") {
    const hojas = [];
    if (grupos.length > 1) hojas.push({ nombre: "Resumen", head: ["Institución", "Despachos", "Gasolina (L)", "Diésel (L)", "Total (L)"], body: resumen });
    grupos.forEach((g) => hojas.push({ nombre: g.nombre, head: CABECERA_INST, body: [...filasTabla(g), ["TOTAL", "", num(g.total), `Gasolina ${num(g.gasolina)} L · Diésel ${num(g.diesel)} L`, ""]] }));
    exportToExcelMulti(archivo, hojas);
  } else {
    const bloques = [];
    if (grupos.length > 1) bloques.push({ titulo: "RESUMEN DE DESPACHOS DE COMBUSTIBLE POR INSTITUCIÓN", subtitulo: `Mes: ${titulo}`, secciones: [{ head: ["Institución", "Despachos", "Gasolina (L)", "Diésel (L)", "Total (L)"], body: resumen }], firmas: ["Despachador", "Director"] });
    grupos.forEach((g) => bloques.push({ titulo: `DESPACHO DE COMBUSTIBLE — ${g.nombre.toUpperCase()}`, subtitulo: `Mes: ${titulo}`, secciones: [{ head: CABECERA_INST, body: [...filasTabla(g), ["TOTAL", "", num(g.total), resumenInst(g), ""]] }], firmas: ["Despachador", "Director"] }));
    exportToPDFMulti(archivo, `Despacho de Combustible — ${titulo}`, bloques);
  }
}

function setupReporteMensual() {
  const mesInput = document.getElementById("comb-rep-mes");
  const instSel = document.getElementById("comb-rep-inst");
  if (!mesInput || !instSel) return;
  if (!mesInput.value) mesInput.value = new Date().toLocaleDateString("en-CA").slice(0, 7);
  // El selector lista las instituciones que tienen despachos en el mes elegido.
  const llenar = () => {
    const actual = instSel.value;
    const nombres = gruposDelMes(mesInput.value).map((g) => g.nombre);
    instSel.innerHTML = `<option value="">Todas las instituciones (una hoja por institución)</option>` + nombres.map((n) => `<option value="${escapeHTML(n)}">${escapeHTML(n)}</option>`).join("");
    if (nombres.includes(actual)) instSel.value = actual;
  };
  mesInput.addEventListener("change", llenar);
  instSel.addEventListener("focus", llenar);
  instSel.addEventListener("mousedown", llenar);
  llenar();
  setTimeout(llenar, 1500); // los despachos cargan de forma asíncrona
  document.getElementById("comb-rep-print")?.addEventListener("click", () => imprimirReporteMensual(mesInput.value, instSel.value));
  document.getElementById("comb-rep-xlsx")?.addEventListener("click", () => descargarReporteMensual(mesInput.value, instSel.value, "xlsx"));
  document.getElementById("comb-rep-pdf")?.addEventListener("click", () => descargarReporteMensual(mesInput.value, instSel.value, "pdf"));
}

export function getCombustibleModule() {
  return moduleRef;
}

/* ---------------------------------------------------------------------- */
/* Importación masiva de despachos de combustible desde Excel/CSV          */
/* ---------------------------------------------------------------------- */
// Encabezados aceptados por columna (sin distinguir tildes/mayúsculas).
const COMBUSTIBLE_ALIAS = {
  fecha: ["fecha"],
  institucion: ["institucion", "institución", "centro", "destino", "centrodestino", "centro destino"],
  tipoCombustible: ["tipo", "tipocombustible", "tipo de combustible"],
  litros: ["litros", "cantidad", "cantidaddelitros", "cantidad de litros", "cantidad de litros despachados"],
  unidadVehicular: ["vehiculo", "unidad", "unidadvehicular", "placa", "unidad vehicular", "unidad / placa", "unidad vehicular / placa"],
  responsable: ["responsable"],
  observaciones: ["observaciones", "observacion", "notas"],
};

function mapearFilaCombustible(rawRow) {
  const found = mapearFila(rawRow, COMBUSTIBLE_ALIAS);
  return {
    fecha: found.fecha,
    institucion: String(found.institucion ?? "").trim(),
    tipoCombustible: String(found.tipoCombustible ?? "").trim(),
    litros: found.litros === undefined || found.litros === "" ? "" : Number(found.litros),
    unidadVehicular: String(found.unidadVehicular ?? "").trim(),
    responsable: String(found.responsable ?? "").trim(),
    observaciones: String(found.observaciones ?? "").trim(),
  };
}

function formatFechaLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Igual que la de Traslados (ver emergencias.js): busca la institución del
 * catálogo que corresponde a un texto libre, en tres pasadas de mayor a
 * menor precisión (nombre exacto, alias/abreviatura, coincidencia parcial).
 * Se duplica aquí (en vez de importarla de emergencias.js) porque cada
 * importador del sistema es autocontenido — solo se comparte la lectura de
 * archivos vía importUtils.js.
 */
function resolverInstitucionPorTexto(texto) {
  const normalizado = quitarAcentos(texto).trim().toLowerCase();
  if (!normalizado) return null;
  const instituciones = getInstituciones();

  const porNombreExacto = instituciones.find((i) => quitarAcentos(i.nombre).trim().toLowerCase() === normalizado);
  if (porNombreExacto) return porNombreExacto;

  const porAlias = instituciones.find((i) =>
    (i.alias || "")
      .split(",")
      .map((a) => quitarAcentos(a).trim().toLowerCase())
      .filter(Boolean)
      .includes(normalizado)
  );
  if (porAlias) return porAlias;

  const porCoincidenciaParcial = instituciones.find((i) => {
    const nombreNorm = quitarAcentos(i.nombre).trim().toLowerCase();
    return nombreNorm.includes(normalizado) || normalizado.includes(nombreNorm);
  });
  return porCoincidenciaParcial || null;
}

// Instituciones que el administrador acaba de resolver manualmente durante
// esta misma sesión de importación (texto del archivo -> {id, nombre}).
const resolucionesManualesInstitucion = new Map();

function normalizarTexto(s) {
  return quitarAcentos(s).trim().toLowerCase();
}

function validarFilaCombustible(fila, responsableDefecto) {
  const errores = [];

  if (fila.litros === "" || isNaN(fila.litros) || fila.litros <= 0) errores.push("cantidad de litros inválida");
  if (!fila.unidadVehicular) errores.push("falta la unidad vehicular / placa");

  let tipoResuelto = "";
  if (fila.tipoCombustible) {
    const norm = quitarAcentos(fila.tipoCombustible).trim().toLowerCase();
    if (norm === "gasolina") tipoResuelto = "Gasolina";
    else if (norm === "diesel") tipoResuelto = "Diesel";
    else errores.push(`tipo "${fila.tipoCombustible}" no reconocido (use Gasolina o Diesel)`);
  } else {
    errores.push("falta el tipo de combustible");
  }

  let fechaResuelta = null;
  if (fila.fecha instanceof Date && !isNaN(fila.fecha.getTime())) {
    fechaResuelta = fila.fecha;
  } else if (fila.fecha) {
    fechaResuelta = parsearFechaLegado(fila.fecha);
    if (!fechaResuelta) {
      const d = new Date(fila.fecha);
      if (!isNaN(d.getTime())) fechaResuelta = d;
    }
  }
  if (!fechaResuelta) errores.push("fecha inválida");

  const responsableResuelto = fila.responsable || responsableDefecto;
  if (!responsableResuelto) errores.push("falta el responsable");

  // La institución es obligatoria (igual que en el formulario manual — no
  // existe un campo de texto libre de respaldo), así que una fila cuyo
  // texto no coincida con ninguna institución del catálogo queda marcada
  // como "sin vincular" y no se puede importar hasta resolverla.
  let institucionId = "";
  let institucionNombreResuelto = "";
  if (fila.institucion) {
    const resueltoManual = resolucionesManualesInstitucion.get(normalizarTexto(fila.institucion));
    const candidato = resueltoManual || resolverInstitucionPorTexto(fila.institucion);
    if (candidato) {
      institucionId = candidato.id;
      institucionNombreResuelto = candidato.nombre;
    } else {
      institucionNombreResuelto = fila.institucion;
      errores.push("institución sin vincular al catálogo");
    }
  } else {
    errores.push("falta la institución");
  }

  return {
    ...fila,
    tipoResuelto,
    fechaResuelta,
    fechaTexto: fechaResuelta ? formatFechaLocal(fechaResuelta) : "",
    responsableResuelto,
    institucionId,
    institucionNombreResuelto,
    errores,
  };
}

let filasImportacionCombustibleValidas = [];
let ultimasFilasImportacionCombustible = [];

function renderInstitucionesSinVincular(filasValidadas) {
  const root = document.getElementById("importar-combustible-instituciones-sin-vincular");
  if (!root) return;

  const porTexto = new Map();
  filasValidadas.forEach((f) => {
    if (f.institucionNombreResuelto && !f.institucionId) {
      const clave = normalizarTexto(f.institucionNombreResuelto);
      if (!porTexto.has(clave)) porTexto.set(clave, f.institucionNombreResuelto);
    }
  });

  if (!porTexto.size) {
    root.innerHTML = "";
    return;
  }

  const instituciones = getInstituciones();
  const opcionesExistentes = instituciones
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((i) => `<option value="${i.id}">Vincular como alias de: ${escapeHTML(i.nombre)}</option>`)
    .join("");

  root.innerHTML = `
    <div class="border border-amber-300 bg-amber-50 rounded-md p-3">
      <p class="text-sm font-semibold text-amber-800 mb-1">${porTexto.size} institución(es) del archivo no coinciden con el catálogo</p>
      <p class="text-xs text-amber-700 mb-3">Para cada una, elija si se crea como institución nueva o se vincula como alias de una ya existente, y pulse "Aplicar" — la institución es obligatoria en Combustible, así que estas filas no se pueden importar hasta resolverlas.</p>
      <div class="space-y-2">
        ${[...porTexto.values()]
          .map(
            (texto) => `
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium text-slate-700 min-w-[10rem]">"${escapeHTML(texto)}"</span>
          <select class="form-input !w-auto flex-1 min-w-[16rem] resolucion-institucion-combustible" data-texto="${escapeHTML(texto)}">
            <option value="__nueva__" selected>➕ Crear institución nueva: "${escapeHTML(texto)}"</option>
            ${opcionesExistentes}
          </select>
        </div>`
          )
          .join("")}
      </div>
      <div class="form-actions !mt-3">
        <button type="button" id="btn-aplicar-resoluciones-institucion-combustible" class="btn-secondary">Aplicar y revisar de nuevo</button>
      </div>
    </div>`;

  document
    .getElementById("btn-aplicar-resoluciones-institucion-combustible")
    ?.addEventListener("click", aplicarResolucionesInstitucion);
}

async function aplicarResolucionesInstitucion() {
  const btn = document.getElementById("btn-aplicar-resoluciones-institucion-combustible");
  const selects = [...document.querySelectorAll(".resolucion-institucion-combustible")];
  if (!selects.length) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Aplicando...";
  }

  let creadas = 0;
  let vinculadas = 0;
  let fallidas = 0;

  for (const sel of selects) {
    const texto = sel.dataset.texto;
    const valor = sel.value;
    try {
      if (valor === "__nueva__") {
        const ref = await createRecord(COLLECTIONS.INSTITUCIONES, {
          nombre: texto,
          categoria: CATEGORIAS_INSTITUCIONES.includes("Hospitales / Centros de salud")
            ? "Hospitales / Centros de salud"
            : CATEGORIAS_INSTITUCIONES[0],
          alias: "",
          activo: true,
        });
        resolucionesManualesInstitucion.set(normalizarTexto(texto), { id: ref.id, nombre: texto });
        creadas++;
      } else {
        const inst = getInstituciones().find((i) => i.id === valor);
        if (!inst) throw new Error("Institución no encontrada.");
        const aliasActuales = (inst.alias || "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean);
        if (!aliasActuales.some((a) => normalizarTexto(a) === normalizarTexto(texto))) {
          aliasActuales.push(texto);
          await updateRecord(COLLECTIONS.INSTITUCIONES, inst.id, { alias: aliasActuales.join(", ") });
        }
        resolucionesManualesInstitucion.set(normalizarTexto(texto), { id: inst.id, nombre: inst.nombre });
        vinculadas++;
      }
    } catch (err) {
      console.error("Error resolviendo institución", texto, err);
      fallidas++;
    }
  }

  toast(
    `${creadas ? `${creadas} institución(es) creada(s). ` : ""}${vinculadas ? `${vinculadas} vinculada(s) como alias. ` : ""}${fallidas ? `${fallidas} con error.` : ""}`.trim() ||
      "Sin cambios.",
    fallidas ? "warning" : "success"
  );

  const respField = document.getElementById("importar-combustible-responsable");
  const validadas = ultimasFilasImportacionCombustible.map((f) => validarFilaCombustible(f, respField?.value || ""));
  renderPreviewImportacionCombustible(validadas);
  renderInstitucionesSinVincular(validadas);
}

function renderPreviewImportacionCombustible(filas) {
  const root = document.getElementById("importar-combustible-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-combustible");
  if (!root) return;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Seleccione un archivo para ver la vista previa.</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    filasImportacionCombustibleValidas = [];
    return;
  }

  const validas = filas.filter((f) => f.errores.length === 0);
  filasImportacionCombustibleValidas = validas;

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${validas.length} de ${filas.length} fila(s) lista(s) para importar.</p>
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Fecha</th>
            <th class="text-left px-2 py-1.5">Institución</th>
            <th class="text-left px-2 py-1.5">Tipo</th>
            <th class="text-left px-2 py-1.5">Litros</th>
            <th class="text-left px-2 py-1.5">Unidad / Placa</th>
            <th class="text-left px-2 py-1.5">Responsable</th>
            <th class="text-left px-2 py-1.5">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${filas
            .map(
              (f) => `
          <tr class="border-t border-slate-100 ${f.errores.length ? "bg-red-50" : ""}">
            <td class="px-2 py-1.5">${f.fechaResuelta ? escapeHTML(formatDate(f.fechaTexto)) : "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.institucionNombreResuelto) || "—"}${f.institucionNombreResuelto && !f.institucionId ? ' <span class="text-amber-600">(sin vincular)</span>' : ""}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.tipoResuelto || f.tipoCombustible) || "—"}</td>
            <td class="px-2 py-1.5">${f.litros === "" ? "—" : f.litros}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.unidadVehicular) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.responsableResuelto) || "—"}</td>
            <td class="px-2 py-1.5">${f.errores.length ? `<span class="text-red-700">${escapeHTML(f.errores.join(", "))}</span>` : '<span class="text-emerald-700">OK</span>'}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;

  if (btnConfirmar) btnConfirmar.disabled = validas.length === 0;
}

function setupImportacionCombustible() {
  const fileInput = document.getElementById("importar-combustible-archivo");
  const respField = document.getElementById("importar-combustible-responsable");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-combustible");
  if (!fileInput || !btnConfirmar) return;

  if (respField) respField.value = getResponsableLabel();

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      ultimasFilasImportacionCombustible = [];
      renderPreviewImportacionCombustible([]);
      renderInstitucionesSinVincular([]);
      return;
    }
    try {
      const { filas: rows } = await leerArchivoTabular(file, COMBUSTIBLE_ALIAS);
      const mapeadas = rows.map((r) => mapearFilaCombustible(r)).filter((f) => f.institucion || f.unidadVehicular || f.litros !== "");
      ultimasFilasImportacionCombustible = mapeadas;
      const validadas = mapeadas.map((f) => validarFilaCombustible(f, respField?.value || ""));
      renderPreviewImportacionCombustible(validadas);
      renderInstitucionesSinVincular(validadas);
      if (!mapeadas.length) {
        toast("No se encontraron filas reconocibles. Verifique los encabezados de las columnas.", "warning");
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) o CSV válido.", "error");
      renderPreviewImportacionCombustible([]);
      renderInstitucionesSinVincular([]);
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionCombustibleValidas.length) return;

    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    let registrados = 0;
    let fallidos = 0;

    for (const fila of filasImportacionCombustibleValidas) {
      try {
        await createRecord(COLLECTIONS.DESPACHOS_COMBUSTIBLE, {
          fecha: fila.fechaTexto,
          institucionId: fila.institucionId,
          institucionNombre: fila.institucionNombreResuelto,
          tipoCombustible: fila.tipoResuelto,
          litros: fila.litros,
          unidadVehicular: fila.unidadVehicular,
          responsable: fila.responsableResuelto,
          observaciones: fila.observaciones,
        });
        registrados++;
      } catch (err) {
        console.error("Error importando despacho de combustible", fila, err);
        fallidos++;
      }
    }

    toast(
      `Importación completa: ${registrados} despacho(s) registrado(s)${fallidos ? `, ${fallidos} fila(s) con error` : ""}.`,
      fallidos ? "warning" : "success"
    );

    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionCombustibleValidas = [];
    ultimasFilasImportacionCombustible = [];
    fileInput.value = "";
    renderPreviewImportacionCombustible([]);
    renderInstitucionesSinVincular([]);
  });
}
