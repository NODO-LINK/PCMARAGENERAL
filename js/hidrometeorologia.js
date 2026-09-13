/**
 * hidrometeorologia.js
 * -----------------------------------------------------------------------
 * Módulo de Hidrometeorología — Monitoreo del Río Limón.
 *
 * La estadística institucional es un índice de 0 a 9 (no metros). El nivel
 * se carga manualmente desde este módulo (Fecha/Hora + Nivel). El módulo
 * ofrece:
 *  - Un dashboard en tiempo real (numérico + gráfico) con estados de
 *    alerta visual (Normal / Advertencia / Alerta Roja) según umbrales
 *    configurables por el administrador.
 *  - Un formulario de carga manual de lecturas.
 *  - Historial de lecturas (trazabilidad) con impresión formal firmada
 *    por el Responsable y el Director.
 * -----------------------------------------------------------------------
 */
import { db, doc, getDoc, setDoc, serverTimestamp } from "./firebase.js";
import { COLLECTIONS, UMBRALES_HIDRO_DEFAULT, NIVEL_HIDRO_MIN, NIVEL_HIDRO_MAX } from "./config.js";
import { subscribeCollection, createRecord } from "./data.js";
import { createHistorial, formatDate, toast } from "./ui.js";
import { isAdmin, getCurrentUser, getResponsableLabel } from "./auth.js";

let lecturas = [];
let umbrales = { ...UMBRALES_HIDRO_DEFAULT };
let chart = null;

function calcularEstado(nivel) {
  if (nivel === null || nivel === undefined || isNaN(nivel)) return { label: "Sin datos", color: "slate" };
  if (nivel >= umbrales.alerta) return { label: "ALERTA ROJA", color: "red" };
  if (nivel >= umbrales.advertencia) return { label: "ADVERTENCIA", color: "amber" };
  return { label: "NORMAL", color: "emerald" };
}

// Formato "YYYY-MM-DDThh:mm" en hora LOCAL, tal como lo espera un input
// datetime-local (evita el corrimiento de zona horaria de toISOString()).
function fechaHoraLocalInput(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function registrarLectura(nivel, fecha) {
  const estado = calcularEstado(nivel);
  await createRecord(COLLECTIONS.HIDRO_LECTURAS, {
    fecha,
    nivel,
    estado: estado.label,
    responsable: getResponsableLabel(),
  });
}

function renderDashboard() {
  const ultima = lecturas[0];
  const nivel = ultima ? Number(ultima.nivel) : null;
  const estado = calcularEstado(nivel);

  const nivelEl = document.getElementById("hidro-nivel-actual");
  const badgeEl = document.getElementById("hidro-estado-badge");
  const fechaEl = document.getElementById("hidro-fecha-lectura");
  if (nivelEl) nivelEl.textContent = nivel !== null ? `${nivel} / 9` : "—";
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

function renderChart() {
  const canvas = document.getElementById("chart-hidro");
  if (!canvas || !window.Chart) return;
  const ultimos = [...lecturas].slice(0, 20).reverse();
  const labels = ultimos.map((l) => formatDate(l.fecha, true));
  const data = ultimos.map((l) => Number(l.nivel));

  if (chart) chart.destroy();
  chart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Nivel del Río Limón (0-9)",
          data,
          borderColor: "#C81E1E",
          backgroundColor: "rgba(200,30,30,0.1)",
          tension: 0.3,
          fill: true,
          pointRadius: 3,
          stepped: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          beginAtZero: true,
          min: NIVEL_HIDRO_MIN,
          max: NIVEL_HIDRO_MAX,
          ticks: { stepSize: 1 },
          title: { display: true, text: "Nivel (0-9)" },
        },
      },
    },
  });
}

function renderUmbralesUI() {
  document.getElementById("hidro-umbral-normal-label")?.replaceChildren(document.createTextNode(`0 – ${umbrales.advertencia - 1}`));
  document.getElementById("hidro-umbral-advertencia-label")?.replaceChildren(document.createTextNode(`${umbrales.advertencia} – ${umbrales.alerta - 1}`));
  document.getElementById("hidro-umbral-alerta-label")?.replaceChildren(document.createTextNode(`${umbrales.alerta} – 9`));

  const configForm = document.getElementById("form-hidro-config");
  if (configForm) {
    configForm.elements["advertencia"].value = umbrales.advertencia;
    configForm.elements["alerta"].value = umbrales.alerta;
    configForm.classList.toggle("hidden", !isAdmin());
  }
  const configNote = document.getElementById("hidro-config-readonly-note");
  if (configNote) configNote.classList.toggle("hidden", isAdmin());
}

export function refreshHidrometeorologia() {
  renderDashboard();
}

export async function initHidrometeorologia() {
  // Cargar configuración de umbrales desde Firestore.
  try {
    const snap = await getDoc(doc(db, COLLECTIONS.CONFIG, "hidrometeorologia"));
    if (snap.exists()) umbrales = { ...UMBRALES_HIDRO_DEFAULT, ...snap.data() };
  } catch (err) {
    console.error("No se pudo cargar configuración hidrometeorológica:", err);
  }
  renderUmbralesUI();

  subscribeCollection(COLLECTIONS.HIDRO_LECTURAS, "fecha", (rows) => {
    lecturas = rows;
    renderDashboard();
    historial.render();
  });

  const historial = createHistorial({
    root: document.getElementById("historial-hidro"),
    title: "Historial de Lecturas — Río Limón",
    columns: [
      { key: "fecha", label: "Fecha/Hora", format: (r) => formatDate(r.fecha, true) },
      { key: "nivel", label: "Nivel (0-9)" },
      { key: "estado", label: "Estado" },
      { key: "responsable", label: "Responsable" },
    ],
    dateField: "fecha",
    getRows: () => lecturas,
    isAdmin,
    exportFileName: "Lecturas_Rio_Limon",
    firmas: ["Responsable", "Director"],
    // Las lecturas hidrometeorológicas son de solo lectura una vez
    // guardadas (registro instrumental); no se ofrece edición/eliminación
    // para preservar la integridad de la serie histórica.
  });

  const lecturaForm = document.getElementById("form-hidro-lectura");
  if (lecturaForm) {
    // Precarga la fecha/hora actual para que el operador normalmente solo
    // tenga que escribir el nivel.
    lecturaForm.elements["fecha"].value = fechaHoraLocalInput();

    lecturaForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nivel = Number(lecturaForm.elements["nivel"].value);
      const fechaStr = lecturaForm.elements["fecha"].value;
      if (isNaN(nivel) || nivel < NIVEL_HIDRO_MIN || nivel > NIVEL_HIDRO_MAX) {
        toast(`Ingrese un nivel válido entre ${NIVEL_HIDRO_MIN} y ${NIVEL_HIDRO_MAX}.`, "error");
        return;
      }
      const fecha = fechaStr ? new Date(fechaStr) : new Date();
      if (isNaN(fecha.getTime())) {
        toast("Ingrese una fecha/hora válida.", "error");
        return;
      }
      try {
        await registrarLectura(nivel, fecha);
        toast("Lectura registrada correctamente.", "success");
        lecturaForm.reset();
        lecturaForm.elements["fecha"].value = fechaHoraLocalInput();
      } catch (err) {
        console.error("Error registrando lectura de Hidrometeorología:", err);
        toast("Ocurrió un error al registrar la lectura.", "error");
      }
    });
  }

  const configForm = document.getElementById("form-hidro-config");
  if (configForm) {
    configForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!isAdmin()) return;
      umbrales = {
        ...umbrales,
        advertencia: Number(configForm.elements["advertencia"].value) || umbrales.advertencia,
        alerta: Number(configForm.elements["alerta"].value) || umbrales.alerta,
      };
      await setDoc(doc(db, COLLECTIONS.CONFIG, "hidrometeorologia"), {
        ...umbrales,
        updatedAt: serverTimestamp(),
        updatedBy: getCurrentUser()?.uid || null,
      });
      toast("Configuración de Hidrometeorología actualizada.", "success");
      renderUmbralesUI();
      renderDashboard();
    });
  }
}
