/**
 * hidrometeorologia.js
 * -----------------------------------------------------------------------
 * Módulo de Hidrometeorología, dividido en dos secciones independientes:
 *  - FLUVIOMETRÍA: uno o más ríos (catálogo `rios`), cada uno con su
 *    propio nivel, variación (calculada, no se carga a mano) y lluvia
 *    diaria, y sus propios umbrales de alerta (Normal/Advertencia/Alerta
 *    Roja).
 *  - PLUVIOMETRÍA: estaciones de lluvia INDEPENDIENTES de los ríos
 *    (catálogo `estacionesPluviometricas`), cada una con su propio
 *    registro diario de milímetros de lluvia — no tiene nivel ni
 *    variación, eso es exclusivo de los ríos.
 * -----------------------------------------------------------------------
 */
import { db, doc, getDocs, setDoc, updateDoc, deleteDoc, serverTimestamp, collection, writeBatch } from "./firebase.js";
import { COLLECTIONS, UMBRALES_HIDRO_DEFAULT, NIVEL_HIDRO_MIN, NIVEL_HIDRO_MAX, DEFAULT_RIO_ID, DEFAULT_RIO_NOMBRE, WINDY_API_KEY } from "./config.js";
import { subscribeCollection, createRecord } from "./data.js";
import { createHistorial, formatDate, parseLocalDate, toDate, escapeHTML, toast, confirmDialog, printAdHoc } from "./ui.js";
import { isAdmin, isHidro, getCurrentUser, getResponsableLabel } from "./auth.js";
import { quitarAcentos } from "./importUtils.js";

/* ======================================================================= */
/* Estado compartido                                                        */
/* ======================================================================= */
let rios = [];
let rioSeleccionadoId = null;
let lecturas = []; // TODAS las lecturas de fluviometría, de todos los ríos
let chart = null;
let chartModo = "diario"; // "diario" | "especifico" (un mes puntual) | "mes" (promedio por mes) | "picos" (máximo por mes)
let seedRiosIntentado = false;
let historialFluvio = null;

let estaciones = [];
let estacionSeleccionadaId = null;
let lluvias = []; // TODAS las lecturas de pluviometría, de todas las estaciones
let chartPluvio = null;
let seedEstacionesIntentado = false;
let historialPluvio = null;
let mapaPluvio = null;
let capaMarcadoresPluvio = null;

const COLOR_HEX_ESTADO = {
  emerald: "#059669",
  amber: "#d97706",
  red: "#dc2626",
  slate: "#94a3b8",
};

/* ======================================================================= */
/* Utilidades de fecha compartidas                                          */
/* ======================================================================= */
function claveMes(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
// "YYYY-MM-DDTHH:MM" en hora LOCAL, tal como lo espera un input
// datetime-local (evita el corrimiento de zona horaria de toISOString()).
function fechaHoraLocalInput(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// "YYYY-MM-DD" en hora LOCAL (la lluvia se registra por día, sin hora).
function fechaSoloLocalInput(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ======================================================================= */
/* FLUVIOMETRÍA                                                             */
/* ======================================================================= */

// Las lecturas cargadas ANTES de que existiera más de un río no tienen
// campo `rioId` — se tratan como del río por defecto (Río Limón, id fijo
// "limon") sin tener que migrar cada documento viejo uno por uno.
function rioIdDeLectura(l) {
  return l.rioId || DEFAULT_RIO_ID;
}
function rioActual() {
  return rios.find((r) => r.id === rioSeleccionadoId) || null;
}
function umbralesRioActual() {
  const r = rioActual();
  const advertencia = r && !isNaN(Number(r.advertencia)) ? Number(r.advertencia) : UMBRALES_HIDRO_DEFAULT.advertencia;
  const alerta = r && !isNaN(Number(r.alerta)) ? Number(r.alerta) : UMBRALES_HIDRO_DEFAULT.alerta;
  return { advertencia, alerta };
}
function calcularEstado(nivel, umbralesUsar) {
  const u = umbralesUsar || umbralesRioActual();
  if (nivel === null || nivel === undefined || isNaN(nivel)) return { label: "Sin datos", color: "slate" };
  if (nivel >= u.alerta) return { label: "ALERTA ROJA", color: "red" };
  if (nivel >= u.advertencia) return { label: "ADVERTENCIA", color: "amber" };
  return { label: "NORMAL", color: "emerald" };
}
function lecturasDelRio() {
  return lecturas.filter((l) => rioIdDeLectura(l) === rioSeleccionadoId);
}

// Variación = diferencia con la lectura INMEDIATAMENTE anterior de ese
// mismo río (en la práctica, con una lectura diaria a las 7am como marca
// la planilla, esto equivale a la variación de 24 horas; con varias
// lecturas el mismo día simplemente compara con la anterior más cercana).
// Se calcula siempre al vuelo, nunca se guarda en Firestore, para que siga
// siendo correcta aunque se elimine algún registro intermedio.
function lecturasDelRioAscConVariacion() {
  const asc = lecturasDelRio()
    .slice()
    .sort((a, b) => toDate(a.fecha).getTime() - toDate(b.fecha).getTime());
  let anterior = null;
  return asc.map((l) => {
    const nivel = Number(l.nivel);
    const variacion = anterior !== null && !isNaN(nivel) ? Math.round((nivel - anterior) * 100) / 100 : null;
    if (!isNaN(nivel)) anterior = nivel;
    return { ...l, variacion };
  });
}
function lecturasDelRioConVariacion() {
  return lecturasDelRioAscConVariacion().slice().reverse(); // más reciente primero, para la tabla
}

async function registrarLectura(rioId, rioNombre, nivel, lluvia, fecha) {
  const estado = calcularEstado(nivel, umbralesRioActual());
  await createRecord(COLLECTIONS.HIDRO_LECTURAS, {
    rioId,
    rioNombre,
    fecha,
    nivel,
    lluvia: lluvia === null || lluvia === undefined || isNaN(lluvia) ? null : lluvia,
    estado: estado.label,
    responsable: getResponsableLabel(),
  });
}

/* ---------------------------- Catálogo de ríos ------------------------- */

// La primera vez que la colección `rios` está vacía, se siembra con Río
// Limón (id fijo, para que calce con las lecturas viejas sin rioId) y Río
// Guasare. Solo lo intenta un administrador (coincide con la regla de
// Firestore) y solo una vez por carga de página.
async function seedRiosSiVacio(rowsActuales) {
  if (seedRiosIntentado || rowsActuales.length > 0 || !isAdmin()) return;
  seedRiosIntentado = true;
  try {
    const base = { activo: true, createdAt: serverTimestamp(), createdBy: getCurrentUser()?.uid || null };
    await setDoc(doc(db, COLLECTIONS.RIOS, DEFAULT_RIO_ID), {
      ...base,
      nombre: DEFAULT_RIO_NOMBRE,
      advertencia: UMBRALES_HIDRO_DEFAULT.advertencia,
      alerta: UMBRALES_HIDRO_DEFAULT.alerta,
    });
    await setDoc(doc(db, COLLECTIONS.RIOS, "guasare"), {
      ...base,
      nombre: "Río Guasare",
      advertencia: UMBRALES_HIDRO_DEFAULT.advertencia,
      alerta: UMBRALES_HIDRO_DEFAULT.alerta,
    });
  } catch (err) {
    console.error("No se pudo sembrar el catálogo de ríos:", err);
  }
}

function renderRioSelector() {
  const sel = document.getElementById("fluvio-rio-selector");
  if (!sel) return;
  const activos = rios.filter((r) => r.activo !== false);
  sel.innerHTML = activos.map((r) => `<option value="${r.id}">${escapeHTML(r.nombre)}</option>`).join("");
  if (rioSeleccionadoId && activos.find((r) => r.id === rioSeleccionadoId)) sel.value = rioSeleccionadoId;
}

function renderRiosAdminTable() {
  const tbody = document.getElementById("tabla-rios-body");
  if (!tbody) return;
  const admin = isAdmin();
  tbody.innerHTML =
    rios
      .map(
        (r) => `
    <tr class="border-t border-slate-100">
      <td class="px-3 py-1.5">${escapeHTML(r.nombre)}</td>
      <td class="px-3 py-1.5">${
        admin
          ? `<input type="number" step="any" value="${r.advertencia ?? ""}" data-id="${r.id}" data-campo="advertencia" class="w-20 border border-slate-300 rounded px-1.5 py-1 text-xs input-umbral-rio" />`
          : r.advertencia ?? "—"
      }</td>
      <td class="px-3 py-1.5">${
        admin
          ? `<input type="number" step="any" value="${r.alerta ?? ""}" data-id="${r.id}" data-campo="alerta" class="w-20 border border-slate-300 rounded px-1.5 py-1 text-xs input-umbral-rio" />`
          : r.alerta ?? "—"
      }</td>
      <td class="px-3 py-1.5">${r.activo === false ? '<span class="text-red-600">Inactivo</span>' : '<span class="text-emerald-600">Activo</span>'}</td>
      <td class="px-3 py-1.5">${admin ? `<button data-id="${r.id}" data-act="toggle" class="text-navy-700 hover:underline text-xs">${r.activo === false ? "Activar" : "Desactivar"}</button>` : "—"}</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="5" class="px-3 py-4 text-center text-slate-400 text-xs">Sin ríos registrados.</td></tr>`;

  if (admin) {
    tbody.querySelectorAll(".input-umbral-rio").forEach((input) => {
      input.addEventListener("change", async () => {
        const valor = Number(input.value);
        if (isNaN(valor)) return;
        try {
          await updateDoc(doc(db, COLLECTIONS.RIOS, input.dataset.id), { [input.dataset.campo]: valor });
          toast("Umbral actualizado.", "success");
        } catch (err) {
          console.error(err);
          toast("No se pudo actualizar el umbral.", "error");
        }
      });
    });
    tbody.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
      btn.onclick = () => {
        const r = rios.find((x) => x.id === btn.dataset.id);
        updateDoc(doc(db, COLLECTIONS.RIOS, r.id), { activo: r.activo === false });
      };
    });
  }
}

function setupRioForm() {
  const form = document.getElementById("form-nuevo-rio");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin()) return;
    const nombre = form.elements["nombre"].value.trim();
    const advertencia = Number(form.elements["advertencia"].value) || UMBRALES_HIDRO_DEFAULT.advertencia;
    const alerta = Number(form.elements["alerta"].value) || UMBRALES_HIDRO_DEFAULT.alerta;
    if (!nombre) return;
    try {
      await createRecord(COLLECTIONS.RIOS, { nombre, advertencia, alerta, activo: true });
      toast(`Río "${nombre}" agregado.`, "success");
      form.reset();
    } catch (err) {
      console.error(err);
      toast("No se pudo agregar el río.", "error");
    }
  });
}

function setupRioSelector() {
  const sel = document.getElementById("fluvio-rio-selector");
  if (!sel) return;
  sel.addEventListener("change", () => {
    rioSeleccionadoId = sel.value;
    renderUmbralesUI();
    renderDashboard();
    construirHistorialFluvio();
  });
}

/* ------------------------------- Dashboard ------------------------------ */

function renderDashboard() {
  const deEsteRio = lecturasDelRio();
  const ultima = [...deEsteRio].sort((a, b) => toDate(b.fecha).getTime() - toDate(a.fecha).getTime())[0];
  const nivel = ultima ? Number(ultima.nivel) : null;
  const estado = calcularEstado(nivel);

  const nivelEl = document.getElementById("hidro-nivel-actual");
  const badgeEl = document.getElementById("hidro-estado-badge");
  const fechaEl = document.getElementById("hidro-fecha-lectura");
  if (nivelEl) nivelEl.textContent = nivel !== null ? `${nivel}` : "—";
  if (fechaEl) fechaEl.textContent = ultima ? `Última lectura: ${formatDate(ultima.fecha, true)}` : "Sin lecturas registradas";

  const colorClasses = {
    emerald: "bg-emerald-100 text-emerald-800 border-emerald-300",
    amber: "bg-amber-100 text-amber-800 border-amber-300",
    red: "bg-red-100 text-red-800 border-red-300 animate-pulse",
    slate: "bg-slate-100 text-slate-600 border-slate-300",
  };
  if (badgeEl) {
    badgeEl.className = `inline-block px-4 py-1.5 rounded-full border text-sm font-bold tracking-wide ${colorClasses[estado.color]}`;
    badgeEl.textContent = estado.label;
  }

  renderChart();
}

function renderUmbralesUI() {
  const u = umbralesRioActual();
  document.getElementById("hidro-umbral-normal-label")?.replaceChildren(document.createTextNode(`0 – ${u.advertencia - 1}`));
  document.getElementById("hidro-umbral-advertencia-label")?.replaceChildren(document.createTextNode(`${u.advertencia} – ${u.alerta - 1}`));
  document.getElementById("hidro-umbral-alerta-label")?.replaceChildren(document.createTextNode(`${u.alerta} – 9`));
}

/* --------------------------------- Gráfico ------------------------------- */

function picosPorMes(lecturasTodas) {
  const porMes = new Map();
  lecturasTodas.forEach((l) => {
    const d = toDate(l.fecha);
    const nivel = Number(l.nivel);
    if (!d || isNaN(d.getTime()) || isNaN(nivel)) return;
    const clave = claveMes(d);
    const actual = porMes.get(clave);
    if (!actual || nivel > actual.nivel) porMes.set(clave, { fecha: d, nivel });
  });
  return [...porMes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
}
function promediosPorMes(lecturasTodas) {
  const porMes = new Map();
  lecturasTodas.forEach((l) => {
    const d = toDate(l.fecha);
    const nivel = Number(l.nivel);
    if (!d || isNaN(d.getTime()) || isNaN(nivel)) return;
    const clave = claveMes(d);
    const actual = porMes.get(clave);
    if (actual) {
      actual.suma += nivel;
      actual.cantidad += 1;
    } else {
      porMes.set(clave, { fecha: d, suma: nivel, cantidad: 1 });
    }
  });
  return [...porMes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => ({ fecha: v.fecha, nivel: Math.round((v.suma / v.cantidad) * 100) / 100 }));
}
function lecturasDeHoy(lecturasTodas) {
  const hoy = new Date();
  return lecturasTodas
    .filter((l) => {
      const d = toDate(l.fecha);
      return d && !isNaN(d.getTime()) && d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth() && d.getDate() === hoy.getDate();
    })
    .sort((a, b) => toDate(a.fecha).getTime() - toDate(b.fecha).getTime());
}
function clavesMesesDisponibles(lecturasTodas) {
  const claves = new Set();
  lecturasTodas.forEach((l) => {
    const d = toDate(l.fecha);
    if (d && !isNaN(d.getTime())) claves.add(claveMes(d));
  });
  return [...claves].sort().reverse();
}
function lecturasDeMes(lecturasTodas, clave) {
  return lecturasTodas
    .filter((l) => {
      const d = toDate(l.fecha);
      return d && !isNaN(d.getTime()) && claveMes(d) === clave;
    })
    .sort((a, b) => toDate(a.fecha).getTime() - toDate(b.fecha).getTime());
}

function poblarSelectorMeses(selectEl, claves) {
  const valorPrevio = selectEl.value;
  selectEl.innerHTML = claves
    .map((clave) => {
      const [anio, mes] = clave.split("-");
      const etiqueta = new Date(Number(anio), Number(mes) - 1, 1).toLocaleString("es-VE", { month: "long", year: "numeric" });
      return `<option value="${clave}">${etiqueta.charAt(0).toUpperCase()}${etiqueta.slice(1)}</option>`;
    })
    .join("");
  selectEl.value = claves.includes(valorPrevio) ? valorPrevio : claves[0] || "";
}

function renderChart() {
  const canvas = document.getElementById("chart-hidro");
  if (!canvas || !window.Chart) return;

  const nombreRio = rioActual()?.nombre || "Río";
  const selectorEl = document.getElementById("hidro-chart-mes-selector");
  const resumenEl = document.getElementById("hidro-chart-mes-resumen");
  if (selectorEl) selectorEl.classList.toggle("hidden", chartModo !== "especifico");
  if (resumenEl) resumenEl.classList.toggle("hidden", chartModo !== "especifico");

  const lecturasRio = lecturasDelRio();

  let labels, data, coloresPuntos, datasetLabel, fechasCompletas;
  if (chartModo === "especifico") {
    const claves = clavesMesesDisponibles(lecturasRio);
    if (selectorEl) poblarSelectorMeses(selectorEl, claves);
    const claveSeleccionada = selectorEl?.value || "";
    const delMes = claveSeleccionada ? lecturasDeMes(lecturasRio, claveSeleccionada) : [];
    const [anio, mes] = claveSeleccionada ? claveSeleccionada.split("-") : [];
    const nombreMes = claveSeleccionada ? new Date(Number(anio), Number(mes) - 1, 1).toLocaleString("es-VE", { month: "long", year: "numeric" }) : "";

    labels = delMes.map((_, i) => String(i + 1));
    fechasCompletas = delMes.map((l) => formatDate(l.fecha, true));
    data = delMes.map((l) => Number(l.nivel));
    coloresPuntos = delMes.map((l) => COLOR_HEX_ESTADO[calcularEstado(Number(l.nivel)).color]);
    datasetLabel = nombreMes ? `Nivel en ${nombreMes}` : `Nivel de ${nombreRio}`;

    if (resumenEl) {
      if (!claveSeleccionada) {
        resumenEl.textContent = "Sin lecturas registradas todavía.";
      } else if (!delMes.length) {
        resumenEl.textContent = `Sin lecturas en ${nombreMes}.`;
      } else {
        const niveles = data;
        const minimo = Math.min(...niveles);
        const maximo = Math.max(...niveles);
        const promedio = Math.round((niveles.reduce((a, b) => a + b, 0) / niveles.length) * 100) / 100;
        resumenEl.textContent = `${delMes.length} lectura(s) en ${nombreMes} — Mínimo: ${minimo} · Máximo: ${maximo} · Promedio: ${promedio}`;
      }
    }
  } else if (chartModo === "picos") {
    const picos = picosPorMes(lecturasRio);
    labels = picos.map((p) => p.fecha.toLocaleString("es-VE", { month: "short", year: "numeric" }));
    data = picos.map((p) => p.nivel);
    coloresPuntos = picos.map((p) => COLOR_HEX_ESTADO[calcularEstado(p.nivel).color]);
    datasetLabel = "Pico máximo mensual";
  } else if (chartModo === "mes") {
    const promedios = promediosPorMes(lecturasRio);
    labels = promedios.map((p) => p.fecha.toLocaleString("es-VE", { month: "short", year: "numeric" }));
    data = promedios.map((p) => p.nivel);
    coloresPuntos = promedios.map((p) => COLOR_HEX_ESTADO[calcularEstado(p.nivel).color]);
    datasetLabel = "Nivel promedio mensual";
  } else {
    const deHoy = lecturasDeHoy(lecturasRio);
    labels = deHoy.map((_, i) => String(i + 1));
    fechasCompletas = deHoy.map((l) => formatDate(l.fecha, true));
    data = deHoy.map((l) => Number(l.nivel));
    coloresPuntos = deHoy.map((l) => COLOR_HEX_ESTADO[calcularEstado(Number(l.nivel)).color]);
    datasetLabel = `Nivel de ${nombreRio} — Hoy`;
  }

  if (chart) chart.destroy();
  chart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: datasetLabel,
          data,
          borderColor: "#13315C",
          backgroundColor: "rgba(19,49,92,0.08)",
          tension: 0.3,
          fill: true,
          pointRadius: 5,
          pointBackgroundColor: coloresPuntos,
          pointBorderColor: coloresPuntos,
          stepped: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: fechasCompletas ? { callbacks: { title: (items) => fechasCompletas[items[0]?.dataIndex] || "" } } : undefined,
        zoom: window.ChartZoom
          ? { zoom: { pinch: { enabled: true }, wheel: { enabled: true }, mode: "x" }, pan: { enabled: true, mode: "x" } }
          : undefined,
      },
      scales: {
        x: fechasCompletas ? { title: { display: true, text: "N.º de lectura (toque un punto para ver la fecha)" } } : {},
        y: { beginAtZero: true, min: NIVEL_HIDRO_MIN, max: NIVEL_HIDRO_MAX, ticks: { stepSize: 1 }, title: { display: true, text: "Nivel" } },
      },
    },
  });
}

function setupModoChart() {
  const botones = {
    diario: document.getElementById("hidro-chart-modo-diario"),
    especifico: document.getElementById("hidro-chart-modo-especifico"),
    mes: document.getElementById("hidro-chart-modo-mes"),
    picos: document.getElementById("hidro-chart-modo-picos"),
  };
  const selectorMes = document.getElementById("hidro-chart-mes-selector");
  if (!Object.values(botones).some(Boolean)) return;

  const ACTIVO = "px-3 py-1.5 bg-navy-700 text-white";
  const INACTIVO = "px-3 py-1.5 bg-white text-slate-600 hover:bg-slate-50";
  function actualizarBotones() {
    Object.entries(botones).forEach(([modo, btn]) => {
      if (btn) btn.className = chartModo === modo ? ACTIVO : INACTIVO;
    });
  }
  function elegirModo(modo) {
    chartModo = modo;
    actualizarBotones();
    renderChart();
  }
  Object.entries(botones).forEach(([modo, btn]) => btn?.addEventListener("click", () => elegirModo(modo)));
  selectorMes?.addEventListener("change", () => renderChart());
  actualizarBotones();

  document.getElementById("btn-reset-zoom-hidro")?.addEventListener("click", () => chart?.resetZoom?.());
  document.getElementById("btn-imprimir-mes-fluvio")?.addEventListener("click", imprimirMesFluviometria);
}

/* ------------------------------- Impresión ------------------------------- */

function imprimirMesFluviometria() {
  const selectorMes = document.getElementById("hidro-chart-mes-selector");
  const claveSeleccionada = chartModo === "especifico" ? selectorMes?.value : "";
  if (!claveSeleccionada) {
    toast('Elija el modo "Un mes" y seleccione un mes para poder imprimirlo.', "warning");
    return;
  }
  const [anio, mesNum] = claveSeleccionada.split("-");
  const nombreMesRaw = new Date(Number(anio), Number(mesNum) - 1, 1).toLocaleString("es-VE", { month: "long", year: "numeric" });
  const nombreMes = nombreMesRaw.charAt(0).toUpperCase() + nombreMesRaw.slice(1);
  const delMes = lecturasDelRioAscConVariacion().filter((l) => {
    const d = toDate(l.fecha);
    return d && claveMes(d) === claveSeleccionada;
  });
  if (!delMes.length) {
    toast(`Sin lecturas en ${nombreMes} para imprimir.`, "warning");
    return;
  }

  const cellStyle = "border:1px solid #cbd5e1;padding:5px 8px;text-align:center;";
  const headStyle = `${cellStyle}background:#f1f5f9;font-weight:bold;`;
  const filasHTML = delMes
    .map((l) => {
      const d = toDate(l.fecha);
      const variacionTxt = l.variacion === null || l.variacion === undefined ? "—" : l.variacion > 0 ? `+${l.variacion}` : `${l.variacion}`;
      const lluviaTxt = l.lluvia === null || l.lluvia === undefined || l.lluvia === "" ? "—" : l.lluvia;
      return `<tr><td style="${cellStyle}">${d.getDate()}</td><td style="${cellStyle}">${l.nivel}</td><td style="${cellStyle}">${variacionTxt}</td><td style="${cellStyle}">${lluviaTxt}</td></tr>`;
    })
    .join("");
  const lluviaTotal = Math.round(delMes.reduce((s, l) => s + (Number(l.lluvia) || 0), 0) * 100) / 100;

  const bodyHTML = `
    <div style="padding:12px 20px 4px;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
      <h2 style="text-align:center;font-size:15px;margin:6px 0 2px;">${escapeHTML(rioActual()?.nombre || "Río")}</h2>
      <p style="text-align:center;font-size:11px;margin:0 0 14px;color:#475569;">${nombreMes}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <thead><tr>
          <th style="${headStyle}">Día</th>
          <th style="${headStyle}">Nivel</th>
          <th style="${headStyle}">Variación</th>
          <th style="${headStyle}">Lluvia (mm/m²)</th>
        </tr></thead>
        <tbody>${filasHTML}</tbody>
        <tfoot><tr>
          <td style="${cellStyle}font-weight:bold;" colspan="3">LLUVIA TOTAL</td>
          <td style="${cellStyle}font-weight:bold;">${lluviaTotal}</td>
        </tr></tfoot>
      </table>
    </div>`;

  printAdHoc(`${rioActual()?.nombre || "Río"} — ${nombreMes}`, bodyHTML, ["Responsable", "Director"]);
}

/* -------------------------------- Historial ------------------------------ */

function construirHistorialFluvio() {
  const nombreRio = rioActual()?.nombre || "Fluviometría";
  historialFluvio = createHistorial({
    root: document.getElementById("historial-hidro"),
    title: `Historial de Lecturas — ${nombreRio}`,
    columns: [
      { key: "fecha", label: "Fecha y hora", format: (r) => formatDate(r.fecha, true) },
      { key: "nivel", label: "Nivel" },
      { key: "variacion", label: "Variación", format: (r) => (r.variacion === null || r.variacion === undefined ? "—" : r.variacion > 0 ? `+${r.variacion}` : `${r.variacion}`) },
      { key: "lluvia", label: "Lluvia (mm/m²)", format: (r) => (r.lluvia === null || r.lluvia === undefined || r.lluvia === "" ? "—" : r.lluvia) },
      { key: "estado", label: "Estado" },
      { key: "responsable", label: "Responsable" },
    ],
    dateField: "fecha",
    getRows: () => lecturasDelRioConVariacion(),
    isAdmin,
    exportFileName: `Lecturas_${nombreRio.replace(/\s+/g, "_")}`,
    firmas: ["Responsable", "Director"],
    // Las lecturas no se EDITAN una vez guardadas (preserva la serie
    // histórica), pero SÍ se pueden eliminar: el administrador borra
    // cualquiera; el rol Hidro solo las que él mismo cargó (coincide con
    // firestore.rules del lado del servidor).
    canDelete: (row) => isAdmin() || (isHidro() && row.createdBy === getCurrentUser()?.uid),
    onDelete: async (row) => {
      if (!row) return;
      const ok = await confirmDialog({
        title: "Eliminar lectura",
        message: `Se eliminará la lectura de ${formatDate(row.fecha, true)} (nivel ${row.nivel}). Esta acción es permanente y no se puede deshacer. ¿Desea continuar?`,
      });
      if (!ok) return;
      try {
        await deleteDoc(doc(db, COLLECTIONS.HIDRO_LECTURAS, row.id));
        toast("Lectura eliminada.", "success");
      } catch (err) {
        console.error("Error eliminando lectura de Fluviometría:", err);
        toast("No se pudo eliminar la lectura. Verifique sus permisos.", "error");
      }
    },
  });
  historialFluvio.render();
}

/* ----------------------------- Formulario carga --------------------------- */

function refrescarFechaPorDefecto() {
  const lecturaForm = document.getElementById("form-hidro-lectura");
  if (lecturaForm) lecturaForm.elements["fecha"].value = fechaHoraLocalInput();
}

function setupLecturaForm() {
  const lecturaForm = document.getElementById("form-hidro-lectura");
  if (!lecturaForm) return;
  lecturaForm.elements["fecha"].value = fechaHoraLocalInput();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refrescarFechaPorDefecto();
  });

  lecturaForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!rioSeleccionadoId) {
      toast("Seleccione un río primero.", "error");
      return;
    }
    const nivel = Number(lecturaForm.elements["nivel"].value);
    const fechaStr = lecturaForm.elements["fecha"].value;
    const lluviaStr = lecturaForm.elements["lluvia"]?.value;
    if (isNaN(nivel) || nivel < NIVEL_HIDRO_MIN || nivel > NIVEL_HIDRO_MAX) {
      toast(`Ingrese un nivel válido entre ${NIVEL_HIDRO_MIN} y ${NIVEL_HIDRO_MAX}.`, "error");
      return;
    }
    const fecha = fechaStr ? parseLocalDate(fechaStr) : new Date();
    if (!fecha || isNaN(fecha.getTime())) {
      toast("Ingrese una fecha válida.", "error");
      return;
    }
    const lluvia = lluviaStr === "" || lluviaStr === undefined ? null : Number(lluviaStr);
    try {
      await registrarLectura(rioSeleccionadoId, rioActual()?.nombre || "", nivel, lluvia, fecha);
      toast("Lectura registrada correctamente.", "success");
      lecturaForm.reset();
      lecturaForm.elements["fecha"].value = fechaHoraLocalInput();
    } catch (err) {
      console.error("Error registrando lectura de Fluviometría:", err);
      toast("Ocurrió un error al registrar la lectura.", "error");
    }
  });
}

/* ------------------------- Vaciar historial (por río) --------------------- */

async function borrarLecturasDelRioActual() {
  const snap = await getDocs(collection(db, COLLECTIONS.HIDRO_LECTURAS));
  const docs = snap.docs.filter((d) => rioIdDeLectura(d.data()) === rioSeleccionadoId);
  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return docs.length;
}

function setupVaciarHidro() {
  const input = document.getElementById("confirmar-vaciado-hidro");
  const btn = document.getElementById("btn-vaciar-hidro");
  if (!input || !btn) return;

  const FRASE = "BORRAR TODO";
  input.addEventListener("input", () => {
    btn.disabled = input.value.trim().toUpperCase() !== FRASE;
  });

  btn.addEventListener("click", async () => {
    const nombreRio = rioActual()?.nombre || "este río";
    const ok = await confirmDialog({
      title: `¿Vaciar TODO el historial de ${nombreRio}?`,
      message: `Esto borra permanentemente TODAS las lecturas de ${nombreRio} registradas hasta ahora (los demás ríos no se tocan). No hay forma de deshacer esta acción. Úselo solo si va a volver a importar el Excel corregido de inmediato. ¿Está completamente seguro?`,
      confirmText: "Sí, vaciar todo permanentemente",
      danger: true,
    });
    if (!ok) return;

    btn.disabled = true;
    const textoOriginal = btn.textContent;
    btn.textContent = "Vaciando...";
    try {
      const total = await borrarLecturasDelRioActual();
      toast(`Se borraron ${total} lectura(s) de ${nombreRio}. Ya puede volver a importar el Excel.`, "success");
      input.value = "";
    } catch (err) {
      console.error("Error vaciando el historial:", err);
      toast(err.message || "Ocurrió un error vaciando el historial. Revise e intente de nuevo.", "error");
    } finally {
      btn.textContent = textoOriginal;
      btn.disabled = input.value.trim().toUpperCase() !== FRASE;
    }
  });
}

/* ---------------------------------------------------------------------- */
/* Importación masiva desde Excel (planilla real: varios ríos lado a lado) */
/* ---------------------------------------------------------------------- */
const MESES_IMPORT = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, abrir: 4,
  mayo: 5, may: 5, junio: 6, jun: 6, julio: 7, jul: 7, agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};

function normalizarTexto(s) {
  return quitarAcentos(String(s ?? "")).trim().toLowerCase();
}

function identificarRioPorNombre(textoCrudo) {
  const n = normalizarTexto(textoCrudo).replace(/^r[ií]o[:\s]*/, "").trim();
  if (!n) return null;
  return rios.find((r) => {
    const nombreRio = normalizarTexto(r.nombre).replace(/^r[ií]o\s*/, "");
    return n.includes(nombreRio) || nombreRio.includes(n);
  });
}

function leerGridExcel(file) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) {
      reject(new Error("La librería para leer Excel no está disponible."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = window.XLSX.read(data, { type: "array" });
        const hoja = wb.Sheets[wb.SheetNames[0]];
        resolve(window.XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: "" }));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Parsea el formato real de la planilla de Fluviometría: bloques
 * mensuales apilados, cada uno con "Mes: <nombre> <año>" y, debajo, DOS (o
 * más) tablas de río lado a lado con columnas DIA | NIVEL | Variación |
 * Lluvia repetidas por cada bloque. La columna Variación del Excel se
 * IGNORA (se recalcula siempre); solo se usan Fecha (Mes + Día), Nivel y
 * Lluvia. Cada bloque se identifica buscando el texto "Río <algo>" un par
 * de filas arriba del encabezado "DIA", y se empareja contra el catálogo
 * de ríos ya cargado — un río que no exista en el catálogo (nombre no
 * reconocido) se reporta como advertencia y se omite.
 */
function parsearGridFluviometria(grid) {
  const filas = [];
  const advertencias = [];
  let mesActual = null;
  let anioActual = null;

  for (let f = 0; f < grid.length; f++) {
    const celdas = grid[f] || [];

    const idxMes = celdas.findIndex((c) => /^mes\s*[:.]?$/.test(normalizarTexto(c)));
    if (idxMes !== -1) {
      const resto = normalizarTexto(celdas.slice(idxMes + 1).join(" "));
      const mesEncontrado = Object.keys(MESES_IMPORT).find((k) => new RegExp(`\\b${k}\\b`).test(resto));
      const anioEncontrado = resto.match(/(20\d{2})/);
      if (mesEncontrado) mesActual = MESES_IMPORT[mesEncontrado];
      if (anioEncontrado) anioActual = Number(anioEncontrado[1]);
      continue;
    }

    const columnasDia = [];
    celdas.forEach((c, i) => {
      if (/^dias?$/.test(normalizarTexto(c))) columnasDia.push(i);
    });
    if (!columnasDia.length) continue;

    columnasDia.forEach((colDia) => {
      let textoRio = null;
      for (let f2 = f - 1; f2 >= Math.max(0, f - 5) && !textoRio; f2--) {
        const filaArriba = grid[f2] || [];
        for (let c2 = Math.max(0, colDia - 1); c2 < Math.min(filaArriba.length, colDia + 4); c2++) {
          if (/r[ií]o/i.test(String(filaArriba[c2] || ""))) {
            textoRio = String(filaArriba[c2]);
            break;
          }
        }
      }
      const rio = textoRio ? identificarRioPorNombre(textoRio) : null;
      if (!rio) {
        advertencias.push(`No se reconoció el río del bloque en la fila ${f + 1}${textoRio ? ` ("${textoRio}")` : ""} — agréguelo primero en "Ríos registrados".`);
        return;
      }

      for (let f3 = f + 1; f3 < grid.length; f3++) {
        const filaDatos = grid[f3] || [];
        const diaValor = filaDatos[colDia];
        const dia = Number(diaValor);
        if (diaValor === "" || isNaN(dia) || dia < 1 || dia > 31) break;
        if (!mesActual || !anioActual) {
          advertencias.push(`Fila ${f3 + 1}: día ${dia} sin un "Mes:" detectado antes, se omite.`);
          continue;
        }
        const nivelValor = filaDatos[colDia + 1];
        const nivel = Number(nivelValor);
        if (nivelValor === "" || isNaN(nivel)) continue;
        const lluviaValor = filaDatos[colDia + 3];
        const lluvia = Number(lluviaValor);
        filas.push({
          rioId: rio.id,
          rioNombre: rio.nombre,
          fecha: new Date(anioActual, mesActual - 1, dia),
          nivel,
          lluvia: lluviaValor === "" || isNaN(lluvia) ? null : lluvia,
        });
      }
    });
  }

  return { filas, advertencias };
}

let filasImportacionFluvioValidas = [];

function renderPreviewImportacionFluvio(resultado) {
  const root = document.getElementById("importar-hidro-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-hidro");
  if (!root) return;
  const { filas, advertencias } = resultado;
  filasImportacionFluvioValidas = filas;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">${advertencias.length ? escapeHTML(advertencias[0]) : "Seleccione un archivo para ver la vista previa."}</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    return;
  }

  const porRio = {};
  filas.forEach((f) => {
    porRio[f.rioNombre] = (porRio[f.rioNombre] || 0) + 1;
  });

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${filas.length} lectura(s) detectada(s): ${Object.entries(porRio)
      .map(([n, c]) => `${escapeHTML(n)}: ${c}`)
      .join(" · ")}.</p>
    ${advertencias.length ? `<p class="text-xs text-amber-600 mb-2">${advertencias.length} advertencia(s) — ${escapeHTML(advertencias.slice(0, 5).join(" | "))}${advertencias.length > 5 ? "…" : ""}</p>` : ""}
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Río</th>
            <th class="text-left px-2 py-1.5">Fecha</th>
            <th class="text-left px-2 py-1.5">Nivel</th>
            <th class="text-left px-2 py-1.5">Lluvia</th>
          </tr>
        </thead>
        <tbody>
          ${filas
            .map(
              (f) => `
          <tr class="border-t border-slate-100">
            <td class="px-2 py-1.5">${escapeHTML(f.rioNombre)}</td>
            <td class="px-2 py-1.5">${escapeHTML(formatDate(f.fecha))}</td>
            <td class="px-2 py-1.5">${f.nivel}</td>
            <td class="px-2 py-1.5">${f.lluvia ?? "—"}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;

  if (btnConfirmar) btnConfirmar.disabled = filas.length === 0;
}

function setupImportacionFluvio() {
  const fileInput = document.getElementById("importar-hidro-archivo");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-hidro");
  if (!fileInput || !btnConfirmar) return;

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      renderPreviewImportacionFluvio({ filas: [], advertencias: [] });
      return;
    }
    try {
      const grid = await leerGridExcel(file);
      const resultado = parsearGridFluviometria(grid);
      renderPreviewImportacionFluvio(resultado);
      if (!resultado.filas.length) toast("No se encontraron lecturas reconocibles en el archivo.", "warning");
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) válido.", "error");
      renderPreviewImportacionFluvio({ filas: [], advertencias: [] });
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionFluvioValidas.length) return;
    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    let registradas = 0;
    let fallidas = 0;
    for (const f of filasImportacionFluvioValidas) {
      try {
        await registrarLectura(f.rioId, f.rioNombre, f.nivel, f.lluvia, f.fecha);
        registradas++;
      } catch (err) {
        console.error("Error importando lectura de Fluviometría", f, err);
        fallidas++;
      }
    }

    toast(`Importación completa: ${registradas} lectura(s) registrada(s)${fallidas ? `, ${fallidas} fila(s) con error` : ""}.`, fallidas ? "warning" : "success");
    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionFluvioValidas = [];
    fileInput.value = "";
    renderPreviewImportacionFluvio({ filas: [], advertencias: [] });
  });
}

/* ======================================================================= */
/* PLUVIOMETRÍA (estaciones de lluvia independientes de los ríos)          */
/* ======================================================================= */

function estacionActual() {
  return estaciones.find((e) => e.id === estacionSeleccionadaId) || null;
}
function lluviasDeEstacion() {
  return lluvias.filter((l) => l.estacionId === estacionSeleccionadaId);
}

// Estadísticas de CUALQUIER estación (no solo la seleccionada) — usado por
// el mapa, que muestra un resumen de cada una en su propio marcador.
function estadisticasEstacion(estacionId) {
  const deEstacion = lluvias.filter((l) => l.estacionId === estacionId);
  const hoy = new Date();
  const esHoy = (l) => {
    const d = toDate(l.fecha);
    return d && d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth() && d.getDate() === hoy.getDate();
  };
  const esEsteMes = (l) => {
    const d = toDate(l.fecha);
    return d && d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth();
  };
  const lluviaHoy = Math.round(deEstacion.filter(esHoy).reduce((s, l) => s + (Number(l.lluvia) || 0), 0) * 100) / 100;
  const lluviaMes = Math.round(deEstacion.filter(esEsteMes).reduce((s, l) => s + (Number(l.lluvia) || 0), 0) * 100) / 100;
  const ultima = [...deEstacion].sort((a, b) => toDate(b.fecha).getTime() - toDate(a.fecha).getTime())[0];
  return { lluviaHoy, lluviaMes, ultima };
}

async function seedEstacionEjemploSiVacio(rowsActuales) {
  // A diferencia de los ríos, no hay un nombre "obvio" para una estación
  // de lluvia por defecto — se deja vacío y el administrador crea las que
  // correspondan desde "Estaciones registradas". Esta función solo evita
  // reintentarlo en cada snapshot.
  if (seedEstacionesIntentado) return;
  seedEstacionesIntentado = true;
  void rowsActuales;
}

function renderEstacionSelector() {
  const sel = document.getElementById("pluvio-estacion-selector");
  if (!sel) return;
  const activas = estaciones.filter((e) => e.activo !== false);
  sel.innerHTML = activas.map((e) => `<option value="${e.id}">${escapeHTML(e.nombre)}</option>`).join("");
  if (estacionSeleccionadaId && activas.find((e) => e.id === estacionSeleccionadaId)) sel.value = estacionSeleccionadaId;
}

function renderEstacionesAdminTable() {
  const tbody = document.getElementById("tabla-estaciones-pluvio-body");
  if (!tbody) return;
  const admin = isAdmin();
  tbody.innerHTML =
    estaciones
      .map(
        (e) => `
    <tr class="border-t border-slate-100">
      <td class="px-3 py-1.5">${escapeHTML(e.nombre)}</td>
      <td class="px-3 py-1.5">${
        admin
          ? `<input type="number" step="any" value="${e.lat ?? ""}" data-id="${e.id}" data-campo="lat" placeholder="Latitud" class="w-24 border border-slate-300 rounded px-1.5 py-1 text-xs input-coord-estacion" />`
          : e.lat ?? "—"
      }</td>
      <td class="px-3 py-1.5">${
        admin
          ? `<input type="number" step="any" value="${e.lon ?? ""}" data-id="${e.id}" data-campo="lon" placeholder="Longitud" class="w-24 border border-slate-300 rounded px-1.5 py-1 text-xs input-coord-estacion" />`
          : e.lon ?? "—"
      }</td>
      <td class="px-3 py-1.5">${e.activo === false ? '<span class="text-red-600">Inactiva</span>' : '<span class="text-emerald-600">Activa</span>'}</td>
      <td class="px-3 py-1.5">${admin ? `<button data-id="${e.id}" data-act="toggle" class="text-navy-700 hover:underline text-xs">${e.activo === false ? "Activar" : "Desactivar"}</button>` : "—"}</td>
    </tr>`
      )
      .join("") || `<tr><td colspan="5" class="px-3 py-4 text-center text-slate-400 text-xs">Sin estaciones registradas.</td></tr>`;

  if (admin) {
    tbody.querySelectorAll(".input-coord-estacion").forEach((input) => {
      input.addEventListener("change", async () => {
        const valor = input.value === "" ? null : Number(input.value);
        if (input.value !== "" && isNaN(valor)) return;
        try {
          await updateDoc(doc(db, COLLECTIONS.ESTACIONES_PLUVIOMETRICAS, input.dataset.id), { [input.dataset.campo]: valor });
          toast("Ubicación actualizada.", "success");
        } catch (err) {
          console.error(err);
          toast("No se pudo actualizar la ubicación.", "error");
        }
      });
    });
    tbody.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
      btn.onclick = () => {
        const e = estaciones.find((x) => x.id === btn.dataset.id);
        updateDoc(doc(db, COLLECTIONS.ESTACIONES_PLUVIOMETRICAS, e.id), { activo: e.activo === false });
      };
    });
  }
}

function setupEstacionForm() {
  const form = document.getElementById("form-nueva-estacion-pluvio");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isAdmin()) return;
    const nombre = form.elements["nombre"].value.trim();
    const latStr = form.elements["lat"]?.value;
    const lonStr = form.elements["lon"]?.value;
    if (!nombre) return;
    try {
      await createRecord(COLLECTIONS.ESTACIONES_PLUVIOMETRICAS, {
        nombre,
        lat: latStr === "" || latStr === undefined ? null : Number(latStr),
        lon: lonStr === "" || lonStr === undefined ? null : Number(lonStr),
        activo: true,
      });
      toast(`Estación "${nombre}" agregada.`, "success");
      form.reset();
      if (marcadorTemporalNuevaEstacion) {
        mapaPluvio?.removeLayer(marcadorTemporalNuevaEstacion);
        marcadorTemporalNuevaEstacion = null;
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo agregar la estación.", "error");
    }
  });
}

function setupEstacionSelector() {
  const sel = document.getElementById("pluvio-estacion-selector");
  if (!sel) return;
  sel.addEventListener("change", () => {
    estacionSeleccionadaId = sel.value;
    renderPluviometriaDashboard();
    construirHistorialPluvio();
  });
}

function renderPluviometriaDashboard() {
  const deEstacion = lluviasDeEstacion();
  const hoy = new Date();
  const esHoy = (l) => {
    const d = toDate(l.fecha);
    return d && d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth() && d.getDate() === hoy.getDate();
  };
  const esEsteMes = (l) => {
    const d = toDate(l.fecha);
    return d && d.getFullYear() === hoy.getFullYear() && d.getMonth() === hoy.getMonth();
  };
  const lluviaHoy = Math.round(deEstacion.filter(esHoy).reduce((s, l) => s + (Number(l.lluvia) || 0), 0) * 100) / 100;
  const lluviaMes = Math.round(deEstacion.filter(esEsteMes).reduce((s, l) => s + (Number(l.lluvia) || 0), 0) * 100) / 100;

  document.getElementById("pluvio-lluvia-hoy")?.replaceChildren(document.createTextNode(`${lluviaHoy}`));
  document.getElementById("pluvio-lluvia-mes")?.replaceChildren(document.createTextNode(`${lluviaMes}`));

  renderChartPluvio();
}

function renderChartPluvio() {
  const canvas = document.getElementById("chart-pluvio");
  if (!canvas || !window.Chart) return;
  const deEstacion = lluviasDeEstacion();
  const porMes = new Map();
  deEstacion.forEach((l) => {
    const d = toDate(l.fecha);
    if (!d) return;
    const clave = claveMes(d);
    porMes.set(clave, (porMes.get(clave) || 0) + (Number(l.lluvia) || 0));
  });
  const claves = [...porMes.keys()].sort();
  const labels = claves.map((c) => {
    const [a, m] = c.split("-");
    return new Date(Number(a), Number(m) - 1, 1).toLocaleString("es-VE", { month: "short", year: "numeric" });
  });
  const data = claves.map((c) => Math.round(porMes.get(c) * 100) / 100);

  if (chartPluvio) chartPluvio.destroy();
  chartPluvio = new window.Chart(canvas.getContext("2d"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Lluvia total mensual (mm/m²)", data, backgroundColor: "#0ea5e9" }] },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: "mm/m²" } } },
    },
  });
}

// Envoltorio con diagnóstico alrededor de window.windyInit: una clave
// inválida o con el dominio no autorizado (ver api.windy.com → esa clave →
// lápiz de editar → "restriction") puede dejar el mapa en blanco SIN
// llamar de vuelta y sin lanzar ningún error visible — y como este entorno
// no tiene acceso a windy.com para probarlo en vivo, hace falta que el
// propio usuario vea el motivo exacto. Esto deja un aviso en el recuadro
// del mapa (y en la consola del navegador, F12) si Windy no responde a
// tiempo o lanza un error, en vez de quedar en blanco sin pista alguna.
//
// Windy busca su contenedor por un id FIJO ("windy"), no por el que
// nosotros le pongamos: sin él falla con 'Missing <div id="windy"> in the
// BODY of the page'. Esa búsqueda ocurre DESPUÉS de validar la clave (un
// paso asíncrono), así que el id se le presta al contenedor hasta que Windy
// responde (o se agota el tiempo), no solo durante la llamada. Como no puede
// haber dos elementos con ese id a la vez, los arranques se encolan: el
// siguiente mapa espera a que el anterior termine de arrancar.
let windyColaInit = Promise.resolve();

function windyInitConDiagnostico(contenedor, opciones, alListo) {
  windyColaInit = windyColaInit.then(
    () =>
      new Promise((terminar) => {
        const idOriginal = contenedor.id;
        let resuelto = false;
        const liberar = () => {
          contenedor.id = idOriginal;
          terminar();
        };
        const avisoTimeout = setTimeout(() => {
          if (resuelto) return;
          resuelto = true;
          console.error("[mapa-windy v70] Windy no respondió a tiempo con estas opciones (revise la clave y su restricción de dominio en api.windy.com):", opciones);
          contenedor.innerHTML =
            '<p class="text-sm text-red-600 p-3">El mapa de Windy no cargó (tiempo agotado). Abra la consola del navegador (F12 → pestaña "Console") para ver el error exacto, y revise en api.windy.com que la clave tenga autorizado el dominio correcto.</p>';
          liberar();
        }, 8000);

        contenedor.id = "windy";
        try {
          window.windyInit(opciones, (windyAPI) => {
            if (resuelto) return;
            resuelto = true;
            clearTimeout(avisoTimeout);
            try {
              alListo(windyAPI);
            } finally {
              liberar();
            }
          });
        } catch (err) {
          resuelto = true;
          clearTimeout(avisoTimeout);
          console.error("[mapa-windy v70] Error al iniciar el mapa de Windy:", err);
          contenedor.innerHTML = `<p class="text-sm text-red-600 p-3">Error al iniciar el mapa de Windy: ${escapeHTML(err?.message || String(err))}</p>`;
          liberar();
        }
      })
  );
}

/* ---------------- Mapa de pronóstico (Fluviometría) — Windy --------------- */
// Reemplaza al viejo <iframe> de Windy: mismo motivo que el mapa de
// estaciones (ver más abajo) — un iframe de otro dominio no se puede tocar
// desde esta página, así que no había forma real de ocultarle su barra de
// línea de tiempo/reproducción. Este panel de Fluviometría está visible
// desde que carga la página (no hay que esperar a un clic de pestaña), así
// que se inicializa directo.
let mapaPronosticoFluvio = null;

function inicializarMapaPronosticoFluvioSiHaceFalta() {
  const contenedor = document.getElementById("mapa-pronostico-fluvio");
  if (!contenedor || mapaPronosticoFluvio) return;

  if (!WINDY_API_KEY) {
    contenedor.innerHTML =
      '<p class="text-sm text-red-600 p-3">Falta configurar la clave de la API de Windy (WINDY_API_KEY en js/config.js) para mostrar este mapa. Ver instrucciones en ese archivo.</p>';
    return;
  }
  if (!window.windyInit) {
    setTimeout(inicializarMapaPronosticoFluvioSiHaceFalta, 500);
    return;
  }

  windyInitConDiagnostico(contenedor, { key: WINDY_API_KEY, lat: 10.064, lon: -72.568, zoom: 8, overlay: "satellite" }, (windyAPI) => {
    mapaPronosticoFluvio = windyAPI.map;
    setTimeout(() => mapaPronosticoFluvio?.invalidateSize(), 150);
  });
}

// Usado por rio-limon.html, donde este mapa vive dentro de una sección
// plegable que arranca oculta (a diferencia de index.html, donde la
// subpestaña Fluviometría ya está visible al entrar a Hidrometeorología) —
// se llama recién cuando el usuario despliega esa sección.
export function mostrarMapaPronosticoFluvio() {
  inicializarMapaPronosticoFluvioSiHaceFalta();
  mapaPronosticoFluvio?.invalidateSize();
}

/* --------------------------- Mapa de estaciones -------------------------- */
// Se inicializa recién la primera vez que se entra a la pestaña Pluviometría
// (no al cargar la página): Leaflet calcula mal el tamaño de un mapa que
// arranca oculto (display:none), por eso no se crea de una vez.
// Modo "tocar el mapa para ubicar una estación nueva" (ver
// setupMarcarEstacionBtn): se arma con un botón, se usa una sola vez por
// clic y se desarma solo.
let modoUbicarEstacionArmado = false;
let marcadorTemporalNuevaEstacion = null;

// Mapa Leaflet normal (OpenStreetMap) para las estaciones: no usa Windy.
// Windy solo se usa en el mapa de pronóstico de Fluviometría — su librería
// no está pensada para varios mapas en la misma página, así que se decidió
// dejarla en un solo lugar.
function inicializarMapaPluvioSiHaceFalta() {
  const contenedor = document.getElementById("mapa-pluvio");
  if (!contenedor || mapaPluvio || !window.L) return;

  mapaPluvio = window.L.map(contenedor).setView([10.064, -72.568], 8);
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 18,
  }).addTo(mapaPluvio);
  capaMarcadoresPluvio = window.L.layerGroup().addTo(mapaPluvio);
  renderMarcadoresPluvio();
  setTimeout(() => mapaPluvio?.invalidateSize(), 150);

  // Clic en el mapa: solo hace algo si el modo "ubicar estación nueva" está
  // armado (botón "📍 Marcar..."); un clic normal para ver/arrastrar un
  // marcador existente no dispara esto.
  mapaPluvio.on("click", (evento) => {
    if (!modoUbicarEstacionArmado) return;
    modoUbicarEstacionArmado = false;
    const { lat, lng } = evento.latlng;
    if (marcadorTemporalNuevaEstacion) mapaPluvio.removeLayer(marcadorTemporalNuevaEstacion);
    marcadorTemporalNuevaEstacion = window.L.marker([lat, lng], { opacity: 0.75 }).addTo(mapaPluvio).bindPopup("Ubicación de la nueva estación — complete el nombre abajo.").openPopup();
    const form = document.getElementById("form-nueva-estacion-pluvio");
    if (form) {
      form.elements["lat"].value = lat.toFixed(6);
      form.elements["lon"].value = lng.toFixed(6);
      form.elements["nombre"]?.focus();
    }
    toast('Ubicación marcada. Escriba el nombre y presione "Agregar estación".', "success");
  });
}

// Un marcador por estación con coordenadas cargadas; al tocarlo muestra un
// recuadro con sus datos Y además selecciona esa estación en el resto de
// la pantalla (dashboard, gráfico, historial de abajo). El administrador
// puede además ARRASTRAR el punto para reubicarlo (se guarda solo al
// soltar, sin pedir confirmación aparte — igual que los demás campos
// editables en línea de este módulo).
function renderMarcadoresPluvio() {
  if (!mapaPluvio || !capaMarcadoresPluvio) return;
  capaMarcadoresPluvio.clearLayers();
  const admin = isAdmin();
  estaciones.forEach((e) => {
    const lat = Number(e.lat);
    const lon = Number(e.lon);
    if (e.lat === null || e.lat === undefined || e.lon === null || e.lon === undefined || isNaN(lat) || isNaN(lon)) return;
    const stats = estadisticasEstacion(e.id);
    const marcador = window.L.marker([lat, lon], { draggable: admin }).addTo(capaMarcadoresPluvio);
    marcador.bindPopup(
      `<strong>${escapeHTML(e.nombre)}</strong><br/>` +
        `Lluvia de hoy: ${stats.lluviaHoy} mm/m²<br/>` +
        `Lluvia del mes: ${stats.lluviaMes} mm/m²<br/>` +
        `Última lectura: ${
          stats.ultima
            ? `${stats.ultima.lluvia} mm/m² (${escapeHTML(formatDate(stats.ultima.fecha))})`
            : "Sin lecturas"
        }` +
        (admin ? '<br/><span style="color:#64748b;font-size:11px;">Arrastre el punto para reubicar.</span>' : "")
    );
    marcador.on("click", () => {
      estacionSeleccionadaId = e.id;
      renderEstacionSelector();
      renderPluviometriaDashboard();
      construirHistorialPluvio();
      marcador.openPopup();
    });
    if (admin) {
      marcador.on("dragend", async () => {
        const pos = marcador.getLatLng();
        try {
          await updateDoc(doc(db, COLLECTIONS.ESTACIONES_PLUVIOMETRICAS, e.id), { lat: pos.lat, lon: pos.lng });
          toast(`Ubicación de "${e.nombre}" actualizada.`, "success");
        } catch (err) {
          console.error(err);
          toast("No se pudo actualizar la ubicación.", "error");
        }
      });
    }
  });
}

function setupMarcarEstacionBtn() {
  const btn = document.getElementById("btn-marcar-estacion-mapa");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!mapaPluvio) return;
    modoUbicarEstacionArmado = true;
    toast("Toque un punto del mapa para ubicar la nueva estación.", "info");
  });
}

function construirHistorialPluvio() {
  const nombreEstacion = estacionActual()?.nombre || "Pluviometría";
  historialPluvio = createHistorial({
    root: document.getElementById("historial-pluvio"),
    title: `Historial de Lluvia — ${nombreEstacion}`,
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "lluvia", label: "Lluvia (mm/m²)" },
      { key: "responsable", label: "Responsable" },
    ],
    dateField: "fecha",
    getRows: () => lluviasDeEstacion(),
    isAdmin,
    exportFileName: `Lluvia_${nombreEstacion.replace(/\s+/g, "_")}`,
    firmas: ["Responsable", "Director"],
    canDelete: (row) => isAdmin() || (isHidro() && row.createdBy === getCurrentUser()?.uid),
    onDelete: async (row) => {
      if (!row) return;
      const ok = await confirmDialog({
        title: "Eliminar registro de lluvia",
        message: `Se eliminará el registro de ${formatDate(row.fecha)} (${row.lluvia} mm/m²). Esta acción es permanente y no se puede deshacer. ¿Desea continuar?`,
      });
      if (!ok) return;
      try {
        await deleteDoc(doc(db, COLLECTIONS.PLUVIOMETRIA_LECTURAS, row.id));
        toast("Registro eliminado.", "success");
      } catch (err) {
        console.error("Error eliminando registro de Pluviometría:", err);
        toast("No se pudo eliminar el registro. Verifique sus permisos.", "error");
      }
    },
  });
  historialPluvio.render();
}

function setupLluviaForm() {
  const form = document.getElementById("form-pluvio-lectura");
  if (!form) return;
  form.elements["fecha"].value = fechaSoloLocalInput();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!estacionSeleccionadaId) {
      toast("Seleccione una estación primero.", "error");
      return;
    }
    const lluvia = Number(form.elements["lluvia"].value);
    if (isNaN(lluvia) || lluvia < 0) {
      toast("Ingrese un valor de lluvia válido.", "error");
      return;
    }
    const fechaStr = form.elements["fecha"].value;
    const fecha = fechaStr ? parseLocalDate(fechaStr) : new Date();
    if (!fecha || isNaN(fecha.getTime())) {
      toast("Ingrese una fecha válida.", "error");
      return;
    }
    try {
      await createRecord(COLLECTIONS.PLUVIOMETRIA_LECTURAS, {
        estacionId: estacionSeleccionadaId,
        estacionNombre: estacionActual()?.nombre || "",
        fecha,
        lluvia,
        responsable: getResponsableLabel(),
      });
      toast("Lluvia registrada correctamente.", "success");
      form.reset();
      form.elements["fecha"].value = fechaSoloLocalInput();
    } catch (err) {
      console.error("Error registrando lluvia de Pluviometría:", err);
      toast("Ocurrió un error al registrar la lluvia.", "error");
    }
  });
}

/* ======================================================================= */
/* Subtabs Fluviometría / Pluviometría                                     */
/* ======================================================================= */
function setupSubtabsHidro() {
  const tabs = document.querySelectorAll("#view-hidro .subtab-btn");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#view-hidro .subtab-panel").forEach((p) => p.classList.add("hidden"));
      document.getElementById(`panel-${btn.dataset.subtab}`)?.classList.remove("hidden");
      tabs.forEach((b) => b.classList.toggle("subtab-active", b === btn));
      if (btn.dataset.subtab === "pluviometria") {
        inicializarMapaPluvioSiHaceFalta();
        // El mapa ya puede existir de una visita anterior a esta pestaña,
        // pero mientras estuvo oculto Leaflet no sabe su tamaño real.
        mapaPluvio?.invalidateSize();
      }
    });
  });
}

/* ======================================================================= */
/* Arranque del módulo                                                      */
/* ======================================================================= */
export function refreshHidrometeorologia() {
  renderDashboard();
  refrescarFechaPorDefecto();
  // El mapa de pronóstico vive en la subpestaña Fluviometría, que es la que
  // se ve por defecto — pero la SECCIÓN "Hidrometeorología" completa está
  // oculta (display:none) hasta que el usuario entra por el menú, y un mapa
  // de Windy/Leaflet calcula mal su tamaño si se crea mientras está oculto.
  // Por eso se inicializa aquí (cuando la sección ya se mostró) y no antes.
  inicializarMapaPronosticoFluvioSiHaceFalta();
  mapaPronosticoFluvio?.invalidateSize();
}

export async function initHidrometeorologia() {
  setupSubtabsHidro();

  /* ----------------------------- Fluviometría --------------------------- */
  subscribeCollection(COLLECTIONS.RIOS, "nombre", (rows) => {
    rios = rows;
    seedRiosSiVacio(rows);
    if (!rioSeleccionadoId || !rows.find((r) => r.id === rioSeleccionadoId)) {
      rioSeleccionadoId = rows.find((r) => r.activo !== false)?.id || rows[0]?.id || null;
    }
    renderRiosAdminTable();
    renderRioSelector();
    renderUmbralesUI();
    renderDashboard();
    construirHistorialFluvio();
  });

  subscribeCollection(COLLECTIONS.HIDRO_LECTURAS, "fecha", (rows) => {
    lecturas = rows;
    renderDashboard();
    historialFluvio?.render();
  });

  setupRioForm();
  setupRioSelector();
  setupLecturaForm();
  setupModoChart();
  setupImportacionFluvio();
  setupVaciarHidro();

  /* ----------------------------- Pluviometría ---------------------------- */
  subscribeCollection(COLLECTIONS.ESTACIONES_PLUVIOMETRICAS, "nombre", (rows) => {
    estaciones = rows;
    seedEstacionEjemploSiVacio(rows);
    if (!estacionSeleccionadaId || !rows.find((e) => e.id === estacionSeleccionadaId)) {
      estacionSeleccionadaId = rows.find((e) => e.activo !== false)?.id || rows[0]?.id || null;
    }
    renderEstacionesAdminTable();
    renderEstacionSelector();
    renderPluviometriaDashboard();
    construirHistorialPluvio();
    renderMarcadoresPluvio();
  });

  subscribeCollection(COLLECTIONS.PLUVIOMETRIA_LECTURAS, "fecha", (rows) => {
    lluvias = rows;
    renderPluviometriaDashboard();
    historialPluvio?.render();
    renderMarcadoresPluvio();
  });

  setupEstacionForm();
  setupEstacionSelector();
  setupLluviaForm();
  setupMarcarEstacionBtn();
}
