/**
 * ui.js
 * -----------------------------------------------------------------------
 * Utilidades de interfaz reutilizables por todos los módulos:
 *  - Notificaciones tipo "toast".
 *  - Modal de confirmación genérico.
 *  - Renderizador de tablas de historial con filtros (fecha + texto) y
 *    control dinámico de botones Editar/Eliminar según el rol.
 *  - Exportación a Excel (SheetJS) y PDF (jsPDF + autotable).
 *  - Impresión de una vista específica con cintillo institucional.
 * -----------------------------------------------------------------------
 */
import { INSTITUCION } from "./config.js";
import { getIcon } from "./icons.js";

/* ---------------------------------------------------------------------- */
/* Toasts                                                                  */
/* ---------------------------------------------------------------------- */
export function toast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const colors = {
    info: "bg-slate-700",
    success: "bg-emerald-600",
    error: "bg-red-700",
    warning: "bg-amber-600",
  };
  const el = document.createElement("div");
  el.className = `text-white px-4 py-3 rounded-md shadow-lg text-sm font-medium ${colors[type] || colors.info} animate-fade-in`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add("opacity-0", "transition-opacity", "duration-300");
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

/* ---------------------------------------------------------------------- */
/* Modal de confirmación                                                   */
/* ---------------------------------------------------------------------- */
export function confirmDialog({ title = "Confirmar", message, confirmText = "Confirmar", danger = true }) {
  return new Promise((resolve) => {
    const modalRoot = document.getElementById("modal-root");
    modalRoot.innerHTML = `
      <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4" id="confirm-backdrop">
        <div class="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
          <h3 class="text-lg font-semibold text-slate-800 mb-2">${title}</h3>
          <p class="text-sm text-slate-600 mb-6">${message}</p>
          <div class="flex justify-end gap-3">
            <button id="confirm-cancel" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Cancelar</button>
            <button id="confirm-ok" class="px-4 py-2 text-sm rounded-md text-white ${danger ? "bg-red-700 hover:bg-red-800" : "bg-navy-700 hover:bg-navy-800"}">${confirmText}</button>
          </div>
        </div>
      </div>`;
    modalRoot.querySelector("#confirm-cancel").onclick = () => {
      modalRoot.innerHTML = "";
      resolve(false);
    };
    modalRoot.querySelector("#confirm-ok").onclick = () => {
      modalRoot.innerHTML = "";
      resolve(true);
    };
  });
}

/* ---------------------------------------------------------------------- */
/* Formato de fechas                                                       */
/* ---------------------------------------------------------------------- */
/**
 * Convierte de forma segura un valor de fecha proveniente de Firestore o de
 * un <input type="date"> a un objeto Date en hora LOCAL.
 *
 * Nota importante: un string "YYYY-MM-DD" (sin componente de hora) es
 * interpretado por el motor de JavaScript como medianoche UTC, no como
 * medianoche local. En zonas horarias con offset negativo (p. ej.
 * Venezuela, UTC-4) esto provoca que la fecha se muestre/guarde un día
 * antes del real. Por eso este helper construye la fecha con
 * `new Date(año, mes, día)`, que sí usa la zona horaria local.
 */
export function parseLocalDate(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (dateOnly) {
      const [, y, m, d] = dateOnly;
      return new Date(Number(y), Number(m) - 1, Number(d));
    }
  }
  return new Date(value);
}

export function toDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate(); // Firestore Timestamp
  if (value instanceof Date) return value;
  return parseLocalDate(value);
}

export function formatDate(value, withTime = false) {
  const d = toDate(value);
  if (!d || isNaN(d.getTime())) return "—";
  const opts = withTime
    ? { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "2-digit", year: "numeric" };
  return d.toLocaleString("es-VE", opts);
}

/* ---------------------------------------------------------------------- */
/* Tabla de historial genérica con filtros                                 */
/* ---------------------------------------------------------------------- */
/**
 * Crea un componente de historial reutilizable.
 * @param {Object} opts
 * @param {HTMLElement} opts.root - contenedor donde se inyecta el HTML.
 * @param {string} opts.title - título del historial.
 * @param {Array} opts.columns - [{key,label,format?(row)=>string}]
 * @param {Function} opts.getRows - () => array de datos actuales (ya cargados en memoria).
 * @param {string} opts.dateField - nombre del campo fecha usado para filtrar.
 * @param {Function} opts.isAdmin - () => boolean.
 * @param {Function} [opts.onEdit] - (row) => void.
 * @param {Function} [opts.onDelete] - (row) => void.
 * @param {string} [opts.exportFileName] - nombre base para exportaciones.
 * @param {[string,string]} [opts.firmas] - etiquetas de las dos firmas del pie de impresión.
 */
export function createHistorial(opts) {
  const { root, title, columns, getRows, dateField, isAdmin, onEdit, onDelete, exportFileName, firmas } = opts;
  const uid = "h_" + Math.random().toString(36).slice(2, 9);

  root.innerHTML = `
    <div class="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-200 no-print">
        <h4 class="font-semibold text-slate-700">${title}</h4>
        <div class="flex flex-wrap items-end gap-2">
          <div>
            <label class="block text-xs text-slate-500">Desde</label>
            <input type="date" id="${uid}-desde" class="border border-slate-300 rounded-md px-2 py-1 text-sm" />
          </div>
          <div>
            <label class="block text-xs text-slate-500">Hasta</label>
            <input type="date" id="${uid}-hasta" class="border border-slate-300 rounded-md px-2 py-1 text-sm" />
          </div>
          <div>
            <label class="block text-xs text-slate-500">Buscar</label>
            <input type="text" id="${uid}-q" placeholder="Texto..." class="border border-slate-300 rounded-md px-2 py-1 text-sm" />
          </div>
          <button id="${uid}-print" class="px-3 py-1.5 text-xs rounded-md bg-navy-800 text-white hover:bg-navy-900">${getIcon("impresora")}Imprimir</button>
          <button id="${uid}-xlsx" class="px-3 py-1.5 text-xs rounded-md bg-emerald-700 text-white hover:bg-emerald-800">${getIcon("descargar")}Excel</button>
          <button id="${uid}-pdf" class="px-3 py-1.5 text-xs rounded-md bg-red-700 text-white hover:bg-red-800">${getIcon("descargar")}PDF</button>
        </div>
      </div>
      <div class="print-header hidden">${printHeaderHTML(title)}</div>
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50 text-slate-600">
            <tr>
              ${columns.map((c) => `<th class="text-left font-medium px-4 py-2 whitespace-nowrap">${c.label}</th>`).join("")}
              <th class="text-left font-medium px-4 py-2 no-print">Acciones</th>
            </tr>
          </thead>
          <tbody id="${uid}-body"></tbody>
        </table>
      </div>
      <div class="p-3 text-xs text-slate-400 border-t border-slate-100" id="${uid}-count"></div>
      <div class="print-footer hidden">${printFooterHTML(firmas)}</div>
    </div>`;

  const el = (sel) => root.querySelector(sel);

  function filteredRows() {
    const desde = el(`#${uid}-desde`).value ? new Date(el(`#${uid}-desde`).value + "T00:00:00") : null;
    const hasta = el(`#${uid}-hasta`).value ? new Date(el(`#${uid}-hasta`).value + "T23:59:59") : null;
    const q = el(`#${uid}-q`).value.trim().toLowerCase();
    return getRows().filter((row) => {
      if (dateField && (desde || hasta)) {
        const d = toDate(row[dateField]);
        if (!d) return false;
        if (desde && d < desde) return false;
        if (hasta && d > hasta) return false;
      }
      if (q) {
        const haystack = columns.map((c) => (c.format ? c.format(row) : row[c.key])).join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  function render() {
    const rows = filteredRows();
    const admin = isAdmin();
    el(`#${uid}-body`).innerHTML = rows
      .map(
        (row) => `
      <tr class="border-t border-slate-100 hover:bg-slate-50">
        ${columns.map((c) => `<td class="px-4 py-2 align-top">${escapeHTML(c.format ? c.format(row) : row[c.key] ?? "—")}</td>`).join("")}
        <td class="px-4 py-2 no-print whitespace-nowrap">
          ${
            admin
              ? `<button data-act="edit" data-id="${row.id}" class="text-navy-700 hover:underline mr-3">Editar</button>
                 <button data-act="del" data-id="${row.id}" class="text-red-700 hover:underline">Eliminar</button>`
              : `<span class="text-slate-300">—</span>`
          }
        </td>
      </tr>`
      )
      .join("") || `<tr><td colspan="${columns.length + 1}" class="px-4 py-6 text-center text-slate-400">Sin registros para los filtros aplicados.</td></tr>`;

    el(`#${uid}-count`).textContent = `${rows.length} registro(s) mostrados de ${getRows().length} total(es).`;

    if (admin) {
      el(`#${uid}-body`)
        .querySelectorAll('[data-act="edit"]')
        .forEach((btn) => {
          btn.onclick = () => onEdit && onEdit(rows.find((r) => r.id === btn.dataset.id));
        });
      el(`#${uid}-body`)
        .querySelectorAll('[data-act="del"]')
        .forEach((btn) => {
          btn.onclick = () => onDelete && onDelete(rows.find((r) => r.id === btn.dataset.id));
        });
    }
  }

  el(`#${uid}-desde`).addEventListener("change", render);
  el(`#${uid}-hasta`).addEventListener("change", render);
  el(`#${uid}-q`).addEventListener("input", render);
  el(`#${uid}-print`).addEventListener("click", () => printElement(root, title));
  el(`#${uid}-xlsx`).addEventListener("click", () =>
    exportToExcel(exportFileName || title, columns, filteredRows())
  );
  el(`#${uid}-pdf`).addEventListener("click", () =>
    exportToPDF(exportFileName || title, columns, filteredRows())
  );

  return { render };
}

export function escapeHTML(str) {
  if (str === null || str === undefined) return "—";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/* ---------------------------------------------------------------------- */
/* Impresión                                                                */
/* ---------------------------------------------------------------------- */
export function printHeaderHTML(subtitle) {
  const fecha = new Date().toLocaleString("es-VE");
  return `
    <div class="print-letterhead">
      <img class="print-letterhead-crest" src="./icons/icon.svg" alt="Escudo de Protección Civil" />
      <div>
        <div class="print-letterhead-title">${INSTITUCION.nombre}</div>
        <div class="print-letterhead-sub">${INSTITUCION.sistema}</div>
      </div>
      <div class="print-letterhead-meta">
        <div>${subtitle}</div>
        <div>Generado: ${fecha}</div>
      </div>
    </div>`;
}

export function printFooterHTML(firmas) {
  const labels = firmas && firmas.length === 2 ? firmas : ["Responsable", "Departamento"];
  return `
    <div class="print-signatures">
      ${labels
        .map(
          (label) => `
      <div class="print-signature">
        <div class="print-signature-line"></div>
        <div>${label}</div>
      </div>`
        )
        .join("")}
    </div>`;
}

export function printElement(root, title) {
  // Estrategia robusta: en lugar de depender de reglas CSS que oculten
  // ancestros (lo cual no puede "revertirse" en un descendiente una vez
  // que un padre tiene display:none), se traslada temporalmente el nodo a
  // imprimir para que sea hijo directo de <body>. Así, la regla de
  // impresión solo necesita ocultar el resto de los hijos directos de
  // <body>, sin importar en qué vista/pestaña estaba anidado el nodo.
  root.querySelectorAll(".print-header, .print-footer").forEach((n) => n.classList.remove("hidden"));
  root.classList.add("print-target");

  const placeholder = document.createComment("print-placeholder");
  root.parentNode.insertBefore(placeholder, root);
  document.body.appendChild(root);
  document.body.classList.add("printing-single");

  const previousTitle = document.title;
  document.title = `PC - ${title}`;

  window.print();

  const restore = () => {
    if (placeholder.parentNode) {
      placeholder.parentNode.insertBefore(root, placeholder);
      placeholder.remove();
    }
    document.body.classList.remove("printing-single");
    root.classList.remove("print-target");
    root.querySelectorAll(".print-header, .print-footer").forEach((n) => n.classList.add("hidden"));
    document.title = previousTitle;
  };
  // afterprint cubre el cierre del diálogo en la mayoría de navegadores;
  // el timeout es un respaldo para navegadores que no lo disparan.
  window.addEventListener("afterprint", restore, { once: true });
  setTimeout(restore, 2000);
}

/**
 * Imprime un documento institucional "ad-hoc" que no proviene de un
 * historial (p. ej. la Lista Diaria de Pacientes o el Cierre Diario): arma
 * cintillo + cuerpo + firmas en un contenedor reutilizable oculto en
 * pantalla (`.print-only-staging`, ver css/styles.css) y lo imprime con la
 * misma estrategia de printElement().
 * @param {string} title
 * @param {string} bodyHTML - HTML del cuerpo del documento (con estilos inline, no depende de Tailwind).
 * @param {[string,string]} [firmas]
 */
let printScratchEl = null;
export function printAdHoc(title, bodyHTML, firmas) {
  if (!printScratchEl) {
    printScratchEl = document.createElement("div");
    printScratchEl.className = "print-only-staging";
    document.body.appendChild(printScratchEl);
  }
  printScratchEl.innerHTML = `
    <div style="background:#fff;">
      <div class="print-header">${printHeaderHTML(title)}</div>
      ${bodyHTML}
      <div class="print-footer">${printFooterHTML(firmas)}</div>
    </div>`;
  printElement(printScratchEl, title);
}

/* ---------------------------------------------------------------------- */
/* Exportación Excel / PDF                                                 */
/* ---------------------------------------------------------------------- */
export function exportToExcel(filename, columns, rows) {
  if (!window.XLSX) {
    toast("Librería de Excel no disponible.", "error");
    return;
  }
  const data = rows.map((row) => {
    const obj = {};
    columns.forEach((c) => (obj[c.label] = c.format ? c.format(row) : row[c.key] ?? ""));
    return obj;
  });
  const ws = window.XLSX.utils.json_to_sheet(data);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Datos");
  window.XLSX.writeFile(wb, `${sanitizeFilename(filename)}.xlsx`);
}

// Carga perezosa (y en caché) del escudo institucional como data URL, para
// poder incrustarlo en los PDF generados con jsPDF (que no soporta SVG
// directamente, solo imágenes ráster).
let crestDataUrlPromise = null;
function getCrestDataUrl() {
  if (!crestDataUrlPromise) {
    crestDataUrlPromise = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext("2d").drawImage(img, 0, 0);
          resolve(canvas.toDataURL("image/png"));
        } catch (err) {
          console.warn("No se pudo preparar el escudo para el PDF:", err);
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = "./icons/icon-192.png";
    });
  }
  return crestDataUrlPromise;
}

export async function exportToPDF(title, columns, rows) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) {
    toast("Librería de PDF no disponible.", "error");
    return;
  }
  const docPdf = new jsPDF({ orientation: "landscape" });
  const crest = await getCrestDataUrl();
  const textX = crest ? 26 : 14;
  if (crest) docPdf.addImage(crest, "PNG", 12, 8, 16, 16);
  docPdf.setFontSize(13);
  docPdf.text(INSTITUCION.nombre, textX, 14);
  docPdf.setFontSize(9);
  docPdf.text(`${INSTITUCION.sistema} — ${title}`, textX, 20);
  docPdf.text(`Generado: ${new Date().toLocaleString("es-VE")}`, textX, 25);
  docPdf.autoTable({
    startY: 32,
    head: [columns.map((c) => c.label)],
    body: rows.map((row) => columns.map((c) => String(c.format ? c.format(row) : row[c.key] ?? ""))),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [11, 37, 69] },
  });
  docPdf.save(`${sanitizeFilename(title)}.pdf`);
}

function sanitizeFilename(name) {
  return String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9-_]+/g, "_");
}

/* ---------------------------------------------------------------------- */
/* Helpers de formulario                                                    */
/* ---------------------------------------------------------------------- */
export function formToObject(form) {
  const data = new FormData(form);
  const obj = {};
  for (const [k, v] of data.entries()) obj[k] = v;
  return obj;
}

export function setFormValues(form, values) {
  Object.entries(values || {}).forEach(([k, v]) => {
    const field = form.elements[k];
    if (!field) return;
    if (field instanceof RadioNodeList) {
      [...field].forEach((r) => (r.checked = r.value === String(v)));
    } else {
      field.value = v ?? "";
    }
  });
}
