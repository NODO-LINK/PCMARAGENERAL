/**
 * dashboard.js
 * -----------------------------------------------------------------------
 * Panel analítico principal: calcula en tiempo real resúmenes diarios,
 * mensuales y anuales a partir de los datos reales de Firestore, y
 * despliega gráficos (Chart.js) de tendencia y distribución.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS } from "./config.js";
import { subscribeCollection } from "./data.js";
import { toDate } from "./ui.js";
import { getStock } from "./inventario.js";

const state = {
  pacientes: [],
  traslados: [],
  fallecidos: [],
  guardias: [],
  combustible: [],
  educacion: [],
};

let charts = {};
let started = false;

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}
function isSameMonth(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth();
}
function isSameYear(d1, d2) {
  return d1.getFullYear() === d2.getFullYear();
}

function countByPeriod(rows, dateField = "fecha") {
  const now = new Date();
  let hoy = 0,
    mes = 0,
    anio = 0;
  rows.forEach((r) => {
    const d = toDate(r[dateField]);
    if (!d) return;
    if (isSameDay(d, now)) hoy++;
    if (isSameMonth(d, now)) mes++;
    if (isSameYear(d, now)) anio++;
  });
  // "total" es de todos los tiempos (todos los años, incluidos registros
  // viejos importados) — no depende de que la fecha sea válida ni del año
  // actual, a diferencia de hoy/mes/año.
  return { hoy, mes, anio, total: rows.length };
}

function setMetric(prefix, counts) {
  const hoyEl = document.getElementById(`dash-${prefix}-hoy`);
  const mesEl = document.getElementById(`dash-${prefix}-mes`);
  const anioEl = document.getElementById(`dash-${prefix}-anio`);
  const totalEl = document.getElementById(`dash-${prefix}-total`);
  if (hoyEl) hoyEl.textContent = counts.hoy;
  if (mesEl) mesEl.textContent = counts.mes;
  if (anioEl) anioEl.textContent = counts.anio;
  if (totalEl) totalEl.textContent = counts.total;
}

function sumByPeriod(rows, valueFn, dateField = "fecha") {
  const now = new Date();
  let hoy = 0,
    mes = 0,
    anio = 0;
  rows.forEach((r) => {
    const d = toDate(r[dateField]);
    if (!d) return;
    const v = valueFn(r);
    if (isSameDay(d, now)) hoy += v;
    if (isSameMonth(d, now)) mes += v;
    if (isSameYear(d, now)) anio += v;
  });
  const total = rows.reduce((s, r) => s + valueFn(r), 0);
  return { hoy, mes, anio, total };
}

function litrosByPeriod(rows) {
  return sumByPeriod(rows, (r) => Number(r.litros) || 0);
}

// La Lista Diaria de Pacientes es UNA planilla por día (no un registro por
// paciente): las cantidades ya vienen guardadas como campos numéricos, hay
// que sumarlas en vez de contar documentos.
function personasPlanilla(r) {
  return (Number(r.ninos) || 0) + (Number(r.adolescentes) || 0) + (Number(r.adultos) || 0);
}
function pacientesPorPeriodo(rows) {
  return sumByPeriod(rows, personasPlanilla);
}

function renderMetrics() {
  setMetric("pacientes", pacientesPorPeriodo(state.pacientes));
  setMetric("traslados", countByPeriod(state.traslados));
  setMetric("fallecidos", countByPeriod(state.fallecidos));
  setMetric("guardias", countByPeriod(state.guardias));
  setMetric("educacion", countByPeriod(state.educacion));
  setMetric("combustible", litrosByPeriod(state.combustible));

  const criticos = getStock().filter((s) => Number(s.existencia) <= Number(s.minimo ?? 0));
  const criticosEl = document.getElementById("dash-inventario-criticos");
  if (criticosEl) criticosEl.textContent = criticos.length;
}

function last6MonthsLabels() {
  const labels = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString("es-VE", { month: "short", year: "2-digit" }) });
  }
  return labels;
}

function monthlySeries(rows, dateField = "fecha", valueFn = () => 1) {
  const months = last6MonthsLabels();
  const counts = Object.fromEntries(months.map((m) => [m.key, 0]));
  rows.forEach((r) => {
    const d = toDate(r[dateField]);
    if (!d) return;
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key in counts) counts[key] += valueFn(r);
  });
  return { labels: months.map((m) => m.label), data: months.map((m) => counts[m.key]) };
}

function renderCharts() {
  if (!window.Chart) return;

  const trendCanvas = document.getElementById("chart-tendencia");
  if (trendCanvas) {
    const p = monthlySeries(state.pacientes, "fecha", personasPlanilla);
    const t = monthlySeries(state.traslados);
    const g = monthlySeries(state.guardias);
    charts.tendencia?.destroy();
    charts.tendencia = new window.Chart(trendCanvas.getContext("2d"), {
      type: "line",
      data: {
        labels: p.labels,
        datasets: [
          { label: "Pacientes", data: p.data, borderColor: "#0B2545", backgroundColor: "rgba(11,37,69,0.08)", tension: 0.3, fill: true },
          { label: "Traslados", data: t.data, borderColor: "#64748B", backgroundColor: "rgba(100,116,139,0.08)", tension: 0.3, fill: true },
          { label: "Guardias", data: g.data, borderColor: "#C81E1E", backgroundColor: "rgba(200,30,30,0.08)", tension: 0.3, fill: true },
        ],
      },
      options: { responsive: true, plugins: { legend: { position: "bottom" } } },
    });
  }

  const distCanvas = document.getElementById("chart-distribucion");
  if (distCanvas) {
    charts.distribucion?.destroy();
    charts.distribucion = new window.Chart(distCanvas.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: ["Pacientes", "Traslados", "Fallecidos", "Guardias", "Educación"],
        datasets: [
          {
            data: [
              state.pacientes.reduce((s, r) => s + personasPlanilla(r), 0),
              state.traslados.length,
              state.fallecidos.length,
              state.guardias.length,
              state.educacion.length,
            ],
            backgroundColor: ["#0B2545", "#64748B", "#C81E1E", "#1D4E89", "#94A3B8"],
          },
        ],
      },
      options: { responsive: true, plugins: { legend: { position: "bottom" } } },
    });
  }
}

function renderAll() {
  renderMetrics();
  renderCharts();
}

export function initDashboard() {
  if (started) {
    renderAll();
    return;
  }
  started = true;
  subscribeCollection(COLLECTIONS.PACIENTES, "fecha", (rows) => {
    state.pacientes = rows;
    renderAll();
  });
  subscribeCollection(COLLECTIONS.TRASLADOS, "fecha", (rows) => {
    state.traslados = rows;
    renderAll();
  });
  subscribeCollection(COLLECTIONS.FALLECIDOS, "fecha", (rows) => {
    state.fallecidos = rows;
    renderAll();
  });
  subscribeCollection(COLLECTIONS.GUARDIAS, "fecha", (rows) => {
    state.guardias = rows;
    renderAll();
  });
  subscribeCollection(COLLECTIONS.DESPACHOS_COMBUSTIBLE, "fecha", (rows) => {
    state.combustible = rows;
    renderAll();
  });
  subscribeCollection(COLLECTIONS.EDUCACION, "fecha", (rows) => {
    state.educacion = rows;
    renderAll();
  });
}

export function refreshDashboard() {
  renderAll();
}
