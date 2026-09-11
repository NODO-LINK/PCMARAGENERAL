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
      { key: "centroDestino", label: "Centro destino" },
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
  entradasInventario: {
    label: "Inventario — Entradas",
    collection: COLLECTIONS.ENTRADAS_INVENTARIO,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "insumoNombre", label: "Insumo" },
      { key: "cantidad", label: "Cantidad" },
      { key: "almacenDestino", label: "Destino" },
      { key: "responsable", label: "Responsable" },
    ],
  },
  transferenciasInventario: {
    label: "Inventario — Transferencias",
    collection: COLLECTIONS.TRANSFERENCIAS_INVENTARIO,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "insumoNombre", label: "Insumo" },
      { key: "stockOrigen", label: "Origen" },
      { key: "stockDestino", label: "Destino" },
      { key: "cantidad", label: "Cantidad" },
      { key: "responsable", label: "Responsable" },
    ],
  },
  debitosInventario: {
    label: "Inventario — Débitos",
    collection: COLLECTIONS.DEBITOS_INVENTARIO,
    dateField: "fecha",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "insumoNombre", label: "Insumo" },
      { key: "almacenOrigen", label: "Almacén" },
      { key: "cantidad", label: "Cantidad" },
      { key: "motivo", label: "Motivo" },
      { key: "responsable", label: "Responsable" },
    ],
  },
};

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
    getRows: () => dataCache[cfg.collection] || [],
    isAdmin: () => false, // los reportes son de solo consulta (sin editar/eliminar desde este panel)
    exportFileName: `Reporte_${cfg.label}`,
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
      <div class="print-footer hidden">${printFooterHTML()}</div>
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
  const entradas = (dataCache[COLLECTIONS.ENTRADAS_INVENTARIO] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const transferencias = (dataCache[COLLECTIONS.TRANSFERENCIAS_INVENTARIO] || []).filter((r) => sameDate(r, "fecha", dateStr));
  const debitos = (dataCache[COLLECTIONS.DEBITOS_INVENTARIO] || []).filter((r) => sameDate(r, "fecha", dateStr));

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
    entradasInventario: entradas.length,
    transferenciasInventario: transferencias.length,
    debitosInventario: debitos.length,
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
          ${row("Inventario — entradas", c.entradasInventario)}
          ${row("Inventario — transferencias", c.transferenciasInventario)}
          ${row("Inventario — débitos", c.debitosInventario)}
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
  }

  renderReport(select ? select.value : "pacientes");
  renderResumenGeneral();
  if (cierresHistorial) cierresHistorial.render();
}
