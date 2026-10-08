/**
 * hidrometeorologia.js
 * -----------------------------------------------------------------------
 * Módulo de Hidrometeorología — Monitoreo del Río Limón.
 *
 * El nivel se mide en msnm (metros sobre el nivel del mar), admite
 * decimales (ej. 2.5), y se carga manualmente desde este módulo (Fecha +
 * Nivel, sin hora). El módulo ofrece:
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
import { createHistorial, formatDate, parseLocalDate, escapeHTML, toast } from "./ui.js";
import { isAdmin, getCurrentUser, getResponsableLabel } from "./auth.js";
import { leerArchivoTabular, mapearFila, parsearFechaLegado } from "./importUtils.js";

let lecturas = [];
let umbrales = { ...UMBRALES_HIDRO_DEFAULT };
let chart = null;

function calcularEstado(nivel) {
  if (nivel === null || nivel === undefined || isNaN(nivel)) return { label: "Sin datos", color: "slate" };
  if (nivel >= umbrales.alerta) return { label: "ALERTA ROJA", color: "red" };
  if (nivel >= umbrales.advertencia) return { label: "ADVERTENCIA", color: "amber" };
  return { label: "NORMAL", color: "emerald" };
}

// Formato "YYYY-MM-DD" en hora LOCAL, tal como lo espera un input date
// (evita el corrimiento de zona horaria de toISOString()).
function fechaLocalInput(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  if (nivelEl) nivelEl.textContent = nivel !== null ? `${nivel} msnm` : "—";
  if (fechaEl) fechaEl.textContent = ultima ? `Última lectura: ${formatDate(ultima.fecha)}` : "Sin lecturas registradas";

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
  const labels = ultimos.map((l) => formatDate(l.fecha));
  const data = ultimos.map((l) => Number(l.nivel));

  if (chart) chart.destroy();
  chart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Nivel del Río Limón (msnm)",
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
          title: { display: true, text: "Nivel (msnm)" },
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
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "nivel", label: "Nivel (msnm)" },
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
    // Precarga la fecha de hoy para que el operador normalmente solo tenga
    // que escribir el nivel.
    lecturaForm.elements["fecha"].value = fechaLocalInput();

    lecturaForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nivel = Number(lecturaForm.elements["nivel"].value);
      const fechaStr = lecturaForm.elements["fecha"].value;
      if (isNaN(nivel) || nivel < NIVEL_HIDRO_MIN || nivel > NIVEL_HIDRO_MAX) {
        toast(`Ingrese un nivel válido entre ${NIVEL_HIDRO_MIN} y ${NIVEL_HIDRO_MAX}.`, "error");
        return;
      }
      const fecha = fechaStr ? parseLocalDate(fechaStr) : new Date();
      if (!fecha || isNaN(fecha.getTime())) {
        toast("Ingrese una fecha válida.", "error");
        return;
      }
      try {
        await registrarLectura(nivel, fecha);
        toast("Lectura registrada correctamente.", "success");
        lecturaForm.reset();
        lecturaForm.elements["fecha"].value = fechaLocalInput();
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

  setupImportacionHidro();
}

/* ---------------------------------------------------------------------- */
/* Importación masiva de lecturas desde Excel/CSV                          */
/* ---------------------------------------------------------------------- */
const HIDRO_ALIAS = {
  fecha: ["fecha"],
  nivel: ["nivel", "msnm", "nivelmsnm", "nivel msnm"],
};

function mapearFilaHidro(rawRow) {
  const found = mapearFila(rawRow, HIDRO_ALIAS);
  return {
    fecha: found.fecha,
    nivel: found.nivel === undefined || found.nivel === "" ? "" : Number(found.nivel),
  };
}

function validarFilaHidro(fila) {
  const errores = [];
  if (fila.nivel === "" || isNaN(fila.nivel)) errores.push("falta el nivel");
  else if (fila.nivel < NIVEL_HIDRO_MIN || fila.nivel > NIVEL_HIDRO_MAX) errores.push(`nivel fuera de rango (${NIVEL_HIDRO_MIN}-${NIVEL_HIDRO_MAX})`);

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

  return { ...fila, fechaResuelta, errores };
}

let filasImportacionHidroValidas = [];

function renderPreviewImportacionHidro(filas) {
  const root = document.getElementById("importar-hidro-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-hidro");
  if (!root) return;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Seleccione un archivo para ver la vista previa.</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    filasImportacionHidroValidas = [];
    return;
  }

  const validas = filas.filter((f) => f.errores.length === 0);
  filasImportacionHidroValidas = validas;

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${validas.length} de ${filas.length} fila(s) lista(s) para importar.</p>
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Fecha</th>
            <th class="text-left px-2 py-1.5">Nivel (msnm)</th>
            <th class="text-left px-2 py-1.5">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${filas
            .map(
              (f) => `
          <tr class="border-t border-slate-100 ${f.errores.length ? "bg-red-50" : ""}">
            <td class="px-2 py-1.5">${f.fechaResuelta ? escapeHTML(formatDate(f.fechaResuelta)) : "—"}</td>
            <td class="px-2 py-1.5">${f.nivel === "" || isNaN(f.nivel) ? "—" : f.nivel}</td>
            <td class="px-2 py-1.5">${f.errores.length ? `<span class="text-red-700">${escapeHTML(f.errores.join(", "))}</span>` : '<span class="text-emerald-700">OK</span>'}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;

  if (btnConfirmar) btnConfirmar.disabled = validas.length === 0;
}

function setupImportacionHidro() {
  const fileInput = document.getElementById("importar-hidro-archivo");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-hidro");
  if (!fileInput || !btnConfirmar) return;

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      renderPreviewImportacionHidro([]);
      return;
    }
    try {
      const { filas: rows } = await leerArchivoTabular(file, HIDRO_ALIAS);
      const mapeadas = rows.map((r) => mapearFilaHidro(r)).filter((f) => f.fecha || f.nivel !== "");
      const validadas = mapeadas.map((f) => validarFilaHidro(f));
      renderPreviewImportacionHidro(validadas);
      if (!mapeadas.length) {
        toast("No se encontraron filas reconocibles. Verifique los encabezados de las columnas.", "warning");
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) o CSV válido.", "error");
      renderPreviewImportacionHidro([]);
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionHidroValidas.length) return;

    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    let registradas = 0;
    let fallidas = 0;

    for (const fila of filasImportacionHidroValidas) {
      try {
        await registrarLectura(fila.nivel, fila.fechaResuelta);
        registradas++;
      } catch (err) {
        console.error("Error importando lectura de Hidrometeorología", fila, err);
        fallidas++;
      }
    }

    toast(
      `Importación completa: ${registradas} lectura(s) registrada(s)${fallidas ? `, ${fallidas} fila(s) con error` : ""}.`,
      fallidas ? "warning" : "success"
    );

    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionHidroValidas = [];
    fileInput.value = "";
    renderPreviewImportacionHidro([]);
  });
}
