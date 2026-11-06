/**
 * reportes.js
 * -----------------------------------------------------------------------
 * Centro de Reportes: permite seleccionar cualquier módulo operativo,
 * filtrar por rango de fechas y generar un reporte imprimible/exportable
 * (Excel/PDF) con formato institucional, además de un "Resumen General"
 * consolidado de todos los módulos para un rango de fechas dado.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS } from "./config.js";
import { subscribeCollection, createRecord } from "./data.js";
import {
  createHistorial,
  formatDate,
  toDate,
  parseLocalDate,
  exportToExcel,
  exportToPDF,
  printElement,
  printAdHoc,
  printHeaderHTML,
  printFooterHTML,
  toast,
} from "./ui.js";
import { getResponsableLabel } from "./auth.js";

const REPORTS = {
  pacientes: {
    label: "Lista Diaria de Pacientes",
    collection: COLLECTIONS.PACIENTES,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "ninos", label: "Niños" },
      { key: "adolescentes", label: "Adolescentes" },
      { key: "adultos", label: "Adultos" },
      { key: "cantidadTraslados", label: "Traslados" },
      { key: "cantidadFallecidos", label: "Fallecidos" },
    ],
    totals: ["ninos", "adolescentes", "adultos", "cantidadTraslados", "cantidadFallecidos"],
    firmas: ["Jefe de Departamento", "Director"],
    // El campo `cantidadTraslados` de la planilla se escribe a mano por
    // día y casi nunca se mantenía actualizado (independiente del módulo
    // de Traslados, por diseño original) — reportaba muchos menos
    // traslados de los que en verdad hay registrados. Se reemplaza por el
    // conteo real de Traslados en esa misma fecha (ver renderReport()).
    mapRows: (rows, dataCache) => {
      const traslados = dataCache[COLLECTIONS.TRASLADOS] || [];
      return rows.map((r) => ({ ...r, cantidadTraslados: traslados.filter((t) => sameDate(t, "fecha", r.fecha)).length }));
    },
  },
  traslados: {
    label: "Traslados",
    collection: COLLECTIONS.TRASLADOS,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha/Hora", format: (r) => formatDate(r.fecha, true) },
      { key: "tipo", label: "Tipo" },
      { key: "nombrePaciente", label: "Paciente" },
      { key: "cedulaPaciente", label: "Cédula" },
      { key: "centroDestino", label: "Centro destino", format: (r) => r.institucionNombre || r.centroDestino || "—" },
      { key: "unidad", label: "Unidad" },
      { key: "responsable", label: "Responsable" },
    ],
  },
  fallecidos: {
    label: "Fallecidos",
    collection: COLLECTIONS.FALLECIDOS,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "hora", label: "Hora" },
      { key: "nombre", label: "Nombre" },
      { key: "cedula", label: "Cédula" },
      { key: "edad", label: "Edad" },
      { key: "sexo", label: "Sexo" },
      { key: "lugar", label: "Lugar" },
      { key: "causa", label: "Causa / Circunstancia" },
      { key: "responsable", label: "Responsable" },
    ],
  },
  guardias: {
    label: "Guardias de Prevención",
    collection: COLLECTIONS.GUARDIAS,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "parroquia", label: "Parroquia" },
      { key: "lugar", label: "Lugar / Sector" },
      { key: "cantidadPersonas", label: "Personas" },
      { key: "responsable", label: "Responsable" },
    ],
  },
  combustible: {
    label: "Despacho de Combustible",
    collection: COLLECTIONS.DESPACHOS_COMBUSTIBLE,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "institucionNombre", label: "Institución" },
      { key: "tipoCombustible", label: "Tipo" },
      { key: "litros", label: "Litros" },
      { key: "unidadVehicular", label: "Unidad" },
      { key: "responsable", label: "Responsable" },
    ],
    totals: ["litros"],
    firmas: ["Despachador", "Director"],
  },
  educacion: {
    label: "Educación",
    collection: COLLECTIONS.EDUCACION,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "nombre", label: "Institución / Comunidad" },
      { key: "poblacionBeneficiada", label: "Población" },
      { key: "tema", label: "Tema" },
      { key: "responsable", label: "Responsable" },
    ],
  },
  inspeccion: {
    label: "Gestión de Riesgo (Inspección)",
    collection: COLLECTIONS.INSPECCIONES,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "institucion", label: "Institución" },
      { key: "solicitante", label: "Solicitante" },
      { key: "cedulaRif", label: "C.I. / RIF" },
      { key: "responsable", label: "Responsable" },
    ],
  },
};

// Secciones extra (Hidrometeorología) que no están en el selector de reportes
// pero sí van en el Cierre Mensual General.
const nivelTxt = (r) => (r.nivel === null || r.nivel === undefined || r.nivel === "" || isNaN(Number(r.nivel)) ? "—" : r.nivel);
const lluviaTxt = (r) => (r.lluvia === null || r.lluvia === undefined || r.lluvia === "" ? "—" : r.lluvia);
const SECCIONES_EXTRA = {
  hidroFlu: {
    label: "Fluviometría (niveles de ríos)",
    collection: COLLECTIONS.HIDRO_LECTURAS,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha y hora", format: (r) => formatDate(r.fecha, true) },
      { key: "rioNombre", label: "Río", format: (r) => r.rioNombre || "—" },
      { key: "nivel", label: "Nivel", format: nivelTxt },
      { key: "lluvia", label: "Lluvia (mm/m²)", format: lluviaTxt },
      { key: "estado", label: "Estado", format: (r) => r.estado || "—" },
    ],
    totals: ["lluvia"],
  },
  hidroPluv: {
    label: "Pluviometría (estaciones)",
    collection: COLLECTIONS.PLUVIOMETRIA_LECTURAS,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "estacionNombre", label: "Estación", format: (r) => r.estacionNombre || "—" },
      { key: "lluvia", label: "Lluvia (mm/m²)", format: lluviaTxt },
    ],
    totals: ["lluvia"],
  },
};

// Departamentos del Cierre Mensual General, en el orden de impresión.
const DEPARTAMENTOS_CIERRE = [
  { nombre: "Emergencias", secciones: ["pacientes", "traslados", "fallecidos"] },
  { nombre: "Guardias de Prevención", secciones: ["guardias"] },
  { nombre: "Combustible", secciones: ["combustible"] },
  { nombre: "Hidrometeorología", secciones: ["hidroFlu", "hidroPluv"] },
  { nombre: "Educación", secciones: ["educacion"] },
  { nombre: "Gestión de Riesgo", secciones: ["inspeccion"] },
];

const dataCache = {}; // collectionName -> rows[]
let currentHistorial = null;
let initialized = false;

function ensureSubscribed(collectionName, dateField) {
  if (dataCache[collectionName]) return;
  dataCache[collectionName] = [];
  subscribeCollection(collectionName, dateField, (rows) => {
    dataCache[collectionName] = rows;
    if (currentHistorial) currentHistorial.render();
    renderResumenGeneral();
  });
}

function renderReport(key) {
  const cfg = REPORTS[key];
  const root = document.getElementById("reportes-tabla-container");
  if (!cfg || !root) return;
  ensureSubscribed(cfg.collection, cfg.dateField);
  currentHistorial = createHistorial({
    root,
    title: `Reporte: ${cfg.label}`,
    columns: cfg.columns,
    dateField: cfg.dateField,
    getRows: () => {
      const raw = dataCache[cfg.collection] || [];
      return cfg.mapRows ? cfg.mapRows(raw, dataCache) : raw;
    },
    isAdmin: () => false, // los reportes son de solo consulta (sin editar/eliminar desde este panel)
    exportFileName: `Reporte_${cfg.label}`,
    totals: cfg.totals,
    firmas: cfg.firmas,
  });
}

function renderResumenGeneral() {
  const root = document.getElementById("reportes-resumen-general");
  if (!root) return;
  const desde = document.getElementById("resumen-desde")?.value;
  const hasta = document.getElementById("resumen-hasta")?.value;
  const desdeD = desde ? new Date(desde + "T00:00:00") : null;
  const hastaD = hasta ? new Date(hasta + "T23:59:59") : null;

  const filas = Object.entries(REPORTS).map(([key, cfg]) => {
    const rows = dataCache[cfg.collection] || [];
    const filtered = rows.filter((r) => {
      const d = toDate(r[cfg.dateField]);
      if (!d) return false;
      if (desdeD && d < desdeD) return false;
      if (hastaD && d > hastaD) return false;
      return true;
    });
    const totalUnidades =
      key === "combustible" ? filtered.reduce((s, r) => s + (Number(r.litros) || 0), 0) : filtered.length;
    return { key, label: cfg.label, cantidad: filtered.length, unidad: key === "combustible" ? `${totalUnidades} L` : `${filtered.length} registro(s)` };
  });

  root.innerHTML = `
    <div class="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div class="print-header hidden">${printHeaderHTML("Resumen General de Operaciones")}</div>
      <table class="min-w-full text-sm">
        <thead class="bg-slate-50 text-slate-600">
          <tr><th class="text-left px-4 py-2">Módulo</th><th class="text-left px-4 py-2">Total del periodo</th></tr>
        </thead>
        <tbody>
          ${filas.map((f) => `<tr class="border-t border-slate-100"><td class="px-4 py-2">${f.label}</td><td class="px-4 py-2 font-semibold">${f.unidad}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="print-footer hidden">${printFooterHTML(["Departamento de Sistema", "Director"])}</div>
    </div>`;

  const exportBtn = document.getElementById("btn-resumen-print");
  if (exportBtn) exportBtn.onclick = () => printElement(root, "Resumen General de Operaciones");
  const xlsxBtn = document.getElementById("btn-resumen-xlsx");
  if (xlsxBtn)
    xlsxBtn.onclick = () =>
      exportToExcel("Resumen_General", [
        { key: "label", label: "Módulo" },
        { key: "unidad", label: "Total del periodo" },
      ], filas);
  const pdfBtn = document.getElementById("btn-resumen-pdf");
  if (pdfBtn)
    pdfBtn.onclick = () =>
      exportToPDF("Resumen_General", [
        { key: "label", label: "Módulo" },
        { key: "unidad", label: "Total del periodo" },
      ], filas);
}

/* ---------------------------------------------------------------------- */
/* Cierre Mensual General (todos los departamentos juntos)                  */
/* ---------------------------------------------------------------------- */
const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const CELDA = "border:1px solid #94a3b8;padding:3px 6px;font-size:10px;vertical-align:top;";
const CABECERA = "border:1px solid #94a3b8;padding:3px 6px;font-size:10px;background:#f1f5f9;text-align:left;";

function filasDelMes(cfg, mes) {
  const crudas = dataCache[cfg.collection] || [];
  const base = cfg.mapRows ? cfg.mapRows(crudas, dataCache) : crudas;
  return base
    .filter((r) => {
      const d = toDate(r[cfg.dateField]);
      return d && d.toLocaleDateString("en-CA").startsWith(mes);
    })
    .sort((a, b) => toDate(a[cfg.dateField]) - toDate(b[cfg.dateField]));
}

function tablaSeccion(cfg, filas) {
  if (!filas.length) return `<p style="font-size:11px;color:#64748b;margin:4px 0 10px;">Sin registros en este mes.</p>`;
  const totales = (cfg.totals || []).length
    ? `<tr style="font-weight:bold;background:#f8fafc;">${cfg.columns.map((c, i) => `<td style="${CELDA}">${cfg.totals.includes(c.key) ? filas.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) : i === 0 ? "TOTAL" : ""}</td>`).join("")}</tr>`
    : "";
  return `<table style="width:100%;border-collapse:collapse;margin:4px 0 12px;">
    <thead><tr>${cfg.columns.map((c) => `<th style="${CABECERA}">${escapeCierre(c.label)}</th>`).join("")}</tr></thead>
    <tbody>${filas.map((r) => `<tr style="page-break-inside:avoid;">${cfg.columns.map((c) => `<td style="${CELDA}">${escapeCierre(c.format ? c.format(r) : r[c.key] ?? "")}</td>`).join("")}</tr>`).join("")}${totales}</tbody>
  </table>`;
}
const escapeCierre = (t) => String(t ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function imprimirCierreMensual(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes || "")) return toast("Elija el mes del cierre.", "error");
  const [anio, nroMes] = mes.split("-");
  const nombreMes = `${MESES_ES[Number(nroMes) - 1].replace(/^./, (c) => c.toUpperCase())} ${anio}`;
  const cfgDe = (k) => REPORTS[k] || SECCIONES_EXTRA[k];

  const resumen = [];
  const secciones = DEPARTAMENTOS_CIERRE.map((dep) => {
    const partes = dep.secciones.map((k) => {
      const cfg = cfgDe(k);
      const filas = filasDelMes(cfg, mes);
      const lit = k === "combustible" ? ` — ${filas.reduce((s, r) => s + (Number(r.litros) || 0), 0)} L` : "";
      resumen.push({ dep: dep.nombre, modulo: cfg.label, total: `${filas.length} registro(s)${lit}` });
      return `<h3 style="font-size:12px;margin:10px 0 2px;color:#0b2545;">${escapeCierre(cfg.label)} <span style="font-weight:normal;color:#64748b;">(${filas.length})</span></h3>${tablaSeccion(cfg, filas)}`;
    });
    const firmas = (REPORTS[dep.secciones[0]] || {}).firmas;
    return `<div style="padding:8px 20px;font-family:Arial,Helvetica,sans-serif;color:#1e293b;page-break-before:always;break-before:page;">
      <h2 style="text-align:center;font-size:14px;margin:6px 0 2px;">DEPARTAMENTO: ${escapeCierre(dep.nombre.toUpperCase())}</h2>
      <p style="text-align:center;font-size:11px;margin:0 0 8px;color:#475569;">Cierre mensual — ${nombreMes}</p>
      ${partes.join("")}
      <div class="print-footer">${printFooterHTML(firmas || ["Jefe de Departamento", "Director"], 3)}</div>
    </div>`;
  });

  const portada = `<div style="padding:8px 20px;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
    <h2 style="text-align:center;font-size:15px;margin:6px 0 2px;">CIERRE MENSUAL GENERAL DE OPERACIONES</h2>
    <p style="text-align:center;font-size:12px;margin:0 0 12px;color:#475569;">${nombreMes} — todos los departamentos</p>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr><th style="${CABECERA}">Departamento</th><th style="${CABECERA}">Módulo</th><th style="${CABECERA}">Total del mes</th></tr></thead>
      <tbody>${resumen.map((f) => `<tr><td style="${CELDA}">${escapeCierre(f.dep)}</td><td style="${CELDA}">${escapeCierre(f.modulo)}</td><td style="${CELDA}font-weight:bold;">${escapeCierre(f.total)}</td></tr>`).join("")}</tbody>
    </table>
    <div class="print-footer">${printFooterHTML(["Departamento de Sistema", "Director"], 3)}</div>
  </div>`;

  printAdHoc(`Cierre Mensual General — ${nombreMes}`, portada + secciones.join(""), null);
}

function initCierreMensual() {
  const input = document.getElementById("cierre-mes");
  if (input && !input.value) input.value = new Date().toLocaleDateString("en-CA").slice(0, 7);
  Object.values(SECCIONES_EXTRA).forEach((cfg) => ensureSubscribed(cfg.collection, cfg.dateField));
  document.getElementById("btn-cierre-mensual")?.addEventListener("click", () => imprimirCierreMensual(input?.value));
}

/* ---------------------------------------------------------------------- */
/* Cierre Diario                                                            */
/* ---------------------------------------------------------------------- */
const cellStyle = "border:1px solid #cbd5e1;padding:5px 8px;";
const headStyle = `${cellStyle}background:#f1f5f9;font-weight:bold;`;
let cierresHistorial = null;

function sameDate(row, field, dateStr) {
  const d = toDate(row[field]);
  return d ? d.toLocaleDateString("en-CA") === dateStr : false;
}

function computeCierreCounts(dateStr) {
  const pacientes = (dataCache[COLLECTIONS.PACIENTES] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const traslados = (dataCache[COLLECTIONS.TRASLADOS] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const fallecidos = (dataCache[COLLECTIONS.FALLECIDOS] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const guardias = (dataCache[COLLECTIONS.GUARDIAS] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const combustible = (dataCache[COLLECTIONS.DESPACHOS_COMBUSTIBLE] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const educacion = (dataCache[COLLECTIONS.EDUCACION] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const inspeccion = (dataCache[COLLECTIONS.INSPECCIONES] || []).filter((r) => sameDate(r, "fecha", dateStr));

  // La Lista Diaria de Pacientes es una planilla por día (no un registro
  // por paciente): las cantidades ya vienen guardadas como campos
  // numéricos en cada documento; se suman por si hubiera más de una
  // planilla para la misma fecha.
  const sumField = (rows, field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
  const ninos = sumField(pacientes, "ninos");
  const adolescentes = sumField(pacientes, "adolescentes");
  const adultos = sumField(pacientes, "adultos");

  return {
    pacientesTotal: ninos + adolescentes + adultos,
    ninos,
    adolescentes,
    adultos,
    traslados: traslados.length,
    fallecidos: fallecidos.length,
    guardias: guardias.length,
    combustibleDespachos: combustible.length,
    combustibleLitros: combustible.reduce((s, r) => s + (Number(r.litros) || 0), 0),
    educacion: educacion.length,
    inspeccion: inspeccion.length,
  };
}

function buildCierreBodyHTML(fechaFmt, c) {
  const row = (label, value) => `
    <tr><td style="${cellStyle}">${label}</td><td style="${cellStyle}text-align:center;font-weight:bold;">${value}</td></tr>`;
  return `
    <div style="padding:12px 20px 4px;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
      <h2 style="text-align:center;font-size:15px;margin:6px 0 4px;">CIERRE DIARIO DE OPERACIONES</h2>
      <p style="text-align:center;font-size:11px;margin:0 0 14px;color:#475569;">Fecha del cierre: ${fechaFmt}</p>
      <table style="width:100%;border-collapse:collapse;font-size:11px;">
        <thead><tr><th style="${headStyle}">Concepto</th><th style="${headStyle}">Total</th></tr></thead>
        <tbody>
          ${row("Pacientes atendidos (lista diaria)", c.pacientesTotal)}
          ${row("&nbsp;&nbsp;— Niños", c.ninos)}
          ${row("&nbsp;&nbsp;— Adolescentes", c.adolescentes)}
          ${row("&nbsp;&nbsp;— Adultos", c.adultos)}
          ${row("Traslados", c.traslados)}
          ${row("Fallecidos", c.fallecidos)}
          ${row("Guardias de Prevención", c.guardias)}
          ${row("Despachos de combustible", c.combustibleDespachos)}
          ${row("Litros de combustible despachados", c.combustibleLitros)}
          ${row("Educación (actividades)", c.educacion)}
          ${row("Gestión de Riesgo (inspecciones)", c.inspeccion)}
        </tbody>
      </table>
    </div>`;
}

async function generarCierreDiario(dateStr) {
  if (!dateStr) {
    toast("Seleccione la fecha del cierre.", "error");
    return;
  }
  const counts = computeCierreCounts(dateStr);
  const fechaFmt = new Date(dateStr + "T00:00:00").toLocaleDateString("es-VE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const bodyHTML = buildCierreBodyHTML(fechaFmt, counts);

  const preview = document.getElementById("cierre-preview");
  if (preview) {
    preview.innerHTML = `<div class="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">${bodyHTML}</div>`;
  }

  try {
    await createRecord(COLLECTIONS.CIERRES_DIARIOS, {
      fecha: parseLocalDate(dateStr),
      fechaStr: dateStr,
      counts,
      responsable: getResponsableLabel(),
    });
    toast("Cierre diario registrado.", "success");
  } catch (err) {
    console.error("No se pudo registrar el cierre diario:", err);
    toast("No se pudo registrar el cierre diario en el sistema.", "error");
  }

  printAdHoc(`Cierre Diario — ${fechaFmt}`, bodyHTML, ["Departamento de Sistema", "Director"]);
}

function initCierreDiario() {
  const fechaInput = document.getElementById("cierre-fecha");
  const btn = document.getElementById("btn-generar-cierre");
  if (fechaInput) fechaInput.value = new Date().toLocaleDateString("en-CA");
  if (btn) btn.addEventListener("click", () => generarCierreDiario(fechaInput?.value));

  ensureSubscribed(COLLECTIONS.CIERRES_DIARIOS, "fecha");
  const root = document.getElementById("historial-cierres");
  if (!root) return;
  cierresHistorial = createHistorial({
    root,
    title: "Historial de Cierres Diarios",
    dateField: "fecha",
    getRows: () => dataCache[COLLECTIONS.CIERRES_DIARIOS] || [],
    isAdmin: () => false,
    exportFileName: "Cierres_Diarios",
    firmas: ["Departamento de Sistema", "Director"],
    columns: [
      { key: "fechaStr", label: "Fecha del cierre" },
      { key: "pacientes", label: "Pacientes", format: (r) => r.counts?.pacientesTotal ?? 0 },
      { key: "traslados", label: "Traslados", format: (r) => r.counts?.traslados ?? 0 },
      { key: "fallecidos", label: "Fallecidos", format: (r) => r.counts?.fallecidos ?? 0 },
      { key: "litros", label: "Litros combustible", format: (r) => r.counts?.combustibleLitros ?? 0 },
      { key: "responsable", label: "Generado por" },
      { key: "createdAt", label: "Registrado", format: (r) => formatDate(r.createdAt, true) },
    ],
  });
}

export function initReportes() {
  const select = document.getElementById("reportes-select-modulo");
  if (select) {
    select.innerHTML = Object.entries(REPORTS).map(([key, cfg]) => `<option value="${key}">${cfg.label}</option>`).join("");
    select.addEventListener("change", () => renderReport(select.value));
  }

  if (!initialized) {
    initialized = true;
    Object.values(REPORTS).forEach((cfg) => ensureSubscribed(cfg.collection, cfg.dateField));
    document.getElementById("resumen-desde")?.addEventListener("change", renderResumenGeneral);
    document.getElementById("resumen-hasta")?.addEventListener("change", renderResumenGeneral);
    initCierreDiario();
    initCierreMensual();
  }

  renderReport(select ? select.value : "pacientes");
  renderResumenGeneral();
  if (cierresHistorial) cierresHistorial.render();
}
