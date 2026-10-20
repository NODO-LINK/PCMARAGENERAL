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
import { coincideBusqueda, resaltarBusqueda, terminosDeBusqueda } from "./busqueda.js";
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

/**
 * Modal con un campo de texto. Resuelve con el texto escrito (ya sin espacios
 * sobrantes) o con null si se cancela. `message` admite HTML.
 */
export function promptDialog({ title = "Escriba un valor", message = "", label = "", value = "", placeholder = "", confirmText = "Guardar" }) {
  return new Promise((resolve) => {
    const modalRoot = document.getElementById("modal-root");
    modalRoot.innerHTML = `
      <div class="fixed inset-0 bg-slate-900/60 flex items-center justify-center z-50 p-4">
        <form id="prompt-form" class="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
          <h3 class="text-lg font-semibold text-slate-800 mb-2">${title}</h3>
          ${message ? `<p class="text-sm text-slate-600 mb-4">${message}</p>` : ""}
          ${label ? `<label class="form-label">${label}</label>` : ""}
          <input id="prompt-input" type="text" class="form-input mb-6" autocomplete="off" placeholder="${escapeHTML(placeholder)}" />
          <div class="flex justify-end gap-3">
            <button type="button" id="prompt-cancel" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Cancelar</button>
            <button type="submit" class="px-4 py-2 text-sm rounded-md text-white bg-navy-700 hover:bg-navy-800">${confirmText}</button>
          </div>
        </form>
      </div>`;
    const input = modalRoot.querySelector("#prompt-input");
    input.value = value;
    input.focus();
    input.select();
    modalRoot.querySelector("#prompt-cancel").onclick = () => {
      modalRoot.innerHTML = "";
      resolve(null);
    };
    modalRoot.querySelector("#prompt-form").onsubmit = (e) => {
      e.preventDefault();
      const texto = input.value.trim();
      modalRoot.innerHTML = "";
      resolve(texto);
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
 * @param {Function} [opts.onEdit] - (row) => void. Siempre requiere isAdmin().
 * @param {Function} [opts.onDelete] - (row) => void.
 * @param {Function} [opts.canDelete] - (row) => boolean. Controla, POR FILA, si se muestra "Eliminar" — útil para permitir borrar solo registros propios a un rol no-admin. Si se omite, se usa isAdmin() para todas las filas (comportamiento de antes).
 * @param {string} [opts.exportFileName] - nombre base para exportaciones.
 * @param {[string,string]} [opts.firmas] - etiquetas de las dos firmas del pie de impresión.
 */
export function createHistorial(opts) {
  const { root, title, columns, getRows, dateField, isAdmin, onEdit, onDelete, canDelete, exportFileName, firmas, totals, firmaEspacio } = opts;
  const uid = "h_" + Math.random().toString(36).slice(2, 9);

  root.innerHTML = `
    <div class="bg-white rounded-lg border border-slate-200 shadow-sm">
      <div class="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-slate-200 no-print">
        <h4 class="font-semibold text-slate-700">${title}</h4>
        <div class="flex flex-wrap items-end gap-2">
          <div>
            <label class="block text-xs text-slate-500">Mes</label>
            <div class="flex items-center gap-1">
              <button type="button" id="${uid}-mes-prev" title="Mes anterior" class="px-2 py-1 text-sm border border-slate-300 rounded-md hover:bg-slate-50">‹</button>
              <input type="month" id="${uid}-mes" class="border border-slate-300 rounded-md px-2 py-1 text-sm" />
              <button type="button" id="${uid}-mes-next" title="Mes siguiente" class="px-2 py-1 text-sm border border-slate-300 rounded-md hover:bg-slate-50">›</button>
            </div>
          </div>
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
            <div class="relative">
              <input type="search" id="${uid}-q" placeholder="Varias palabras..." title="Busca en todos los campos, sin importar tildes ni mayúsculas; varias palabras en cualquier orden" autocomplete="off" class="border border-slate-300 rounded-md pl-2 pr-6 py-1 text-sm w-44" />
              <button type="button" id="${uid}-q-clear" title="Limpiar búsqueda" class="hidden absolute right-1 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-base leading-none px-1">×</button>
            </div>
          </div>
          <button id="${uid}-print" class="px-3 py-1.5 text-xs rounded-md bg-navy-800 text-white hover:bg-navy-900">${getIcon("impresora")}Imprimir</button>
          <button id="${uid}-print-sel" disabled class="px-3 py-1.5 text-xs rounded-md bg-slate-600 text-white hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed">${getIcon("impresora")}Imprimir selección</button>
          <button id="${uid}-xlsx" class="px-3 py-1.5 text-xs rounded-md bg-emerald-700 text-white hover:bg-emerald-800">${getIcon("descargar")}Excel</button>
          <button id="${uid}-pdf" class="px-3 py-1.5 text-xs rounded-md bg-red-700 text-white hover:bg-red-800">${getIcon("descargar")}PDF</button>
        </div>
      </div>
      <div class="print-header hidden">${printHeaderHTML(title)}</div>
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50 text-slate-600">
            <tr>
              <th class="px-4 py-2 no-print"><input type="checkbox" id="${uid}-check-all" title="Seleccionar todos los visibles" /></th>
              ${columns.map((c) => `<th class="text-left font-medium px-4 py-2 whitespace-nowrap">${c.label}</th>`).join("")}
              <th class="text-left font-medium px-4 py-2 no-print">Acciones</th>
            </tr>
          </thead>
          <tbody id="${uid}-body"></tbody>
          ${totals && totals.length ? `<tfoot><tr id="${uid}-totals" class="border-t-2 border-slate-300 bg-slate-50 font-semibold"></tr></tfoot>` : ""}
        </table>
      </div>
      <div class="p-3 text-xs text-slate-400 border-t border-slate-100 no-print" id="${uid}-count"></div>
      <div class="print-footer hidden">${printFooterHTML(firmas, firmaEspacio)}</div>
    </div>`;

  const el = (sel) => root.querySelector(sel);

  function filteredRows() {
    const desde = el(`#${uid}-desde`).value ? new Date(el(`#${uid}-desde`).value + "T00:00:00") : null;
    const hasta = el(`#${uid}-hasta`).value ? new Date(el(`#${uid}-hasta`).value + "T23:59:59") : null;
    const q = el(`#${uid}-q`).value;
    return getRows().filter((row) => {
      if (dateField && (desde || hasta)) {
        const d = toDate(row[dateField]);
        if (!d) return false;
        if (desde && d < desde) return false;
        if (hasta && d > hasta) return false;
      }
      if (q && !coincideBusqueda(textoBuscable(row), q)) return false;
      return true;
    });
  }

  // Todo el texto en el que se busca un registro: lo que muestran las
  // columnas (ya formateado: fechas dd/mm/aaaa, etc.) más los demás campos
  // de texto y números del registro (responsable, observaciones...), menos
  // los internos (ids y datos de auditoría).
  function textoBuscable(row) {
    const visibles = columns.map((c) => (c.format ? c.format(row) : row[c.key]));
    const ocultos = Object.entries(row)
      .filter(([k, v]) => (typeof v === "string" || typeof v === "number") && !/^(id|createdBy|createdByEmail|updatedBy)$|Id$/.test(k))
      .map(([, v]) => v);
    return [...visibles, ...ocultos].join(" ");
  }

  // Conjunto de ids marcados con el checkbox de cada fila, para "Imprimir
  // selección" (imprimir varios registros elegidos a la vez, sin tener que
  // hacerlo uno por uno ni imprimir la tabla completa).
  const selectedIds = new Set();

  function registroTableHTML(row) {
    return `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tbody>
          ${columns
            .map(
              (c) => `
          <tr>
            <td style="padding:7px 10px;font-weight:bold;width:220px;border:1px solid #cbd5e1;background:#f8fafc;">${escapeHTML(c.label)}</td>
            <td style="padding:7px 10px;border:1px solid #cbd5e1;">${escapeHTML(c.format ? c.format(row) : row[c.key] ?? "—")}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  // Imprime UN solo registro como documento institucional (cintillo + una
  // ficha con todos sus campos + firmas), reutilizando printAdHoc — así,
  // además de imprimir la tabla completa, cualquier registro puede
  // imprimirse individualmente (disponible para Operador y Administrador).
  function printRegistro(row) {
    if (!row) return;
    printAdHoc(`${title} — Registro Individual`, `<div style="margin-top:8px;">${registroTableHTML(row)}</div>`, firmas, firmaEspacio);
  }

  // Imprime SOLO los registros marcados con el checkbox, cada uno como su
  // propia ficha dentro de un mismo documento (con cintillo y firmas una
  // sola vez) — para imprimir, por ejemplo, 3 o 6 registros puntuales sin
  // sacar la tabla completa ni repetir la impresión una por una.
  function printSeleccionados() {
    const rows = getRows().filter((r) => selectedIds.has(r.id));
    if (!rows.length) return;
    const bodyHTML = rows
      .map(
        (row, idx) => `
      <div style="${idx > 0 ? "margin-top:22px;page-break-inside:avoid;" : "margin-top:8px;"}">
        <div style="font-weight:bold;font-size:12px;color:#475569;margin-bottom:4px;">Registro ${idx + 1} de ${rows.length}</div>
        ${registroTableHTML(row)}
      </div>`
      )
      .join("");
    printAdHoc(`${title} — ${rows.length} Registro(s) Seleccionado(s)`, bodyHTML, firmas, firmaEspacio);
  }

  // Texto del periodo filtrado ("octubre de 2026" o "del 01/10/2026 al ..."),
  // que se agrega al título de la hoja impresa para que se sepa de qué mes es.
  function periodoTexto() {
    const mes = el(`#${uid}-mes`).value;
    if (mes) {
      const [a, m] = mes.split("-").map(Number);
      return new Date(a, m - 1, 1).toLocaleDateString("es-VE", { month: "long", year: "numeric" });
    }
    const d = el(`#${uid}-desde`).value;
    const h = el(`#${uid}-hasta`).value;
    const fmt = (v) => v.split("-").reverse().join("/");
    if (d && h) return `del ${fmt(d)} al ${fmt(h)}`;
    if (d) return `desde ${fmt(d)}`;
    if (h) return `hasta ${fmt(h)}`;
    return "";
  }

  function render() {
    const rows = filteredRows();
    const admin = isAdmin();
    const consulta = el(`#${uid}-q`).value;
    el(`#${uid}-q-clear`).classList.toggle("hidden", !consulta);
    const celdaHTML = (valor, q) => {
      const texto = valor === null || valor === undefined ? "—" : String(valor);
      return terminosDeBusqueda(q).length ? resaltarBusqueda(texto, q) : escapeHTML(texto);
    };

    const periodo = periodoTexto();
    el(".print-header").innerHTML = printHeaderHTML(periodo ? `${title} — ${periodo}` : title);

    // Depura la selección: descarta ids de registros que ya no existen
    // (p. ej. porque un administrador los eliminó).
    const idsVigentes = new Set(getRows().map((r) => r.id));
    [...selectedIds].forEach((id) => {
      if (!idsVigentes.has(id)) selectedIds.delete(id);
    });

    el(`#${uid}-body`).innerHTML = rows
      .map(
        (row) => `
      <tr class="border-t border-slate-100 hover:bg-slate-50">
        <td class="px-4 py-2 no-print"><input type="checkbox" class="row-check" data-id="${row.id}" ${selectedIds.has(row.id) ? "checked" : ""} /></td>
        ${columns.map((c) => `<td class="px-4 py-2 align-top">${celdaHTML(c.format ? c.format(row) : row[c.key], consulta)}</td>`).join("")}
        <td class="px-4 py-2 no-print whitespace-nowrap">
          <button data-act="print" data-id="${row.id}" class="text-slate-600 hover:underline mr-3">Imprimir</button>
          ${admin && onEdit ? `<button data-act="edit" data-id="${row.id}" class="text-navy-700 hover:underline mr-3">Editar</button>` : ""}
          ${onDelete && (canDelete ? canDelete(row) : admin) ? `<button data-act="del" data-id="${row.id}" class="text-red-700 hover:underline">Eliminar</button>` : ""}
        </td>
      </tr>`
      )
      .join("") || `<tr><td colspan="${columns.length + 2}" class="px-4 py-6 text-center text-slate-400">Sin registros para los filtros aplicados.</td></tr>`;

    el(`#${uid}-count`).textContent = `${rows.length} registro(s) mostrados de ${getRows().length} total(es).`;

    // Fila de totales al pie de la tabla (en pantalla e impresión): suma,
    // sobre las filas actualmente filtradas (respeta Desde/Hasta/Buscar),
    // las columnas numéricas indicadas en `totals` — por ejemplo, para el
    // cierre mensual de Pacientes: niños, adolescentes, adultos, traslados
    // y fallecidos.
    if (totals && totals.length) {
      const totalsEl = el(`#${uid}-totals`);
      if (totalsEl) {
        const sumas = {};
        totals.forEach((key) => {
          sumas[key] = rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
        });
        let etiquetaPuesta = false;
        const celdas = columns.map((c) => {
          if (totals.includes(c.key)) {
            return `<td class="px-4 py-2">${sumas[c.key]}</td>`;
          }
          if (!etiquetaPuesta) {
            etiquetaPuesta = true;
            return `<td class="px-4 py-2 text-right">Total:</td>`;
          }
          return `<td class="px-4 py-2"></td>`;
        });
        totalsEl.innerHTML = `<td class="px-4 py-2 no-print"></td>${celdas.join("")}<td class="px-4 py-2 no-print"></td>`;
      }
    }

    el(`#${uid}-body`)
      .querySelectorAll(".row-check")
      .forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) selectedIds.add(cb.dataset.id);
          else selectedIds.delete(cb.dataset.id);
          render();
        };
      });

    const checkAll = el(`#${uid}-check-all`);
    if (checkAll) {
      const seleccionadosVisibles = rows.filter((r) => selectedIds.has(r.id)).length;
      checkAll.checked = rows.length > 0 && seleccionadosVisibles === rows.length;
      checkAll.indeterminate = seleccionadosVisibles > 0 && seleccionadosVisibles < rows.length;
    }
    const printSelBtn = el(`#${uid}-print-sel`);
    if (printSelBtn) printSelBtn.disabled = selectedIds.size === 0;

    el(`#${uid}-body`)
      .querySelectorAll('[data-act="print"]')
      .forEach((btn) => {
        btn.onclick = () => printRegistro(rows.find((r) => r.id === btn.dataset.id));
      });

    // El cableado no necesita repetir las condiciones de arriba: los
    // botones "Editar"/"Eliminar" solo existen en el DOM cuando ya se
    // decidió mostrarlos, así que querySelectorAll simplemente no
    // encuentra nada si no corresponden a esta fila/usuario.
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

  // "Mes" y "Desde/Hasta" son dos formas de elegir el mismo filtro: al
  // elegir un mes se rellenan Desde/Hasta con su primer y último día, y al
  // tocar Desde/Hasta a mano se limpia el mes.
  function ponerMes(valor) {
    el(`#${uid}-mes`).value = valor;
    if (!valor) {
      el(`#${uid}-desde`).value = "";
      el(`#${uid}-hasta`).value = "";
    } else {
      const [a, m] = valor.split("-").map(Number);
      const pad = (n) => String(n).padStart(2, "0");
      el(`#${uid}-desde`).value = `${a}-${pad(m)}-01`;
      el(`#${uid}-hasta`).value = `${a}-${pad(m)}-${pad(new Date(a, m, 0).getDate())}`;
    }
    render();
  }
  function moverMes(delta) {
    let base = el(`#${uid}-mes`).value;
    if (!base) {
      const hoy = new Date();
      base = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}`;
    }
    const [a, m] = base.split("-").map(Number);
    const f = new Date(a, m - 1 + delta, 1);
    ponerMes(`${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}`);
  }
  el(`#${uid}-mes`).addEventListener("change", (e) => ponerMes(e.target.value));
  el(`#${uid}-mes-prev`).addEventListener("click", () => moverMes(-1));
  el(`#${uid}-mes-next`).addEventListener("click", () => moverMes(1));
  const alCambiarRango = () => {
    el(`#${uid}-mes`).value = "";
    render();
  };
  el(`#${uid}-desde`).addEventListener("change", alCambiarRango);
  el(`#${uid}-hasta`).addEventListener("change", alCambiarRango);
  el(`#${uid}-q`).addEventListener("input", render);
  el(`#${uid}-q-clear`).addEventListener("click", () => {
    el(`#${uid}-q`).value = "";
    el(`#${uid}-q`).focus();
    render();
  });
  el(`#${uid}-check-all`).addEventListener("change", (e) => {
    const checked = e.target.checked;
    filteredRows().forEach((r) => (checked ? selectedIds.add(r.id) : selectedIds.delete(r.id)));
    render();
  });
  el(`#${uid}-print`).addEventListener("click", () => printElement(root, title));
  el(`#${uid}-print-sel`).addEventListener("click", printSeleccionados);
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
      <img class="print-letterhead-crest" src="./icons/icon-512.png" alt="Escudo de Protección Civil" />
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

/**
 * @param {[string,string]} [firmas]
 * @param {number} [espacioRem] - separación extra (en rem) antes de la
 *   firma, para documentos cortos donde conviene dejar más espacio en
 *   blanco para firmar a mano (el margen por defecto del CSS es compacto,
 *   pensado para que reportes largos no empujen la firma a otra hoja).
 */
export function printFooterHTML(firmas, espacioRem) {
  const labels = firmas && firmas.length === 2 ? firmas : ["Jefe de Departamento", "Director"];
  const estiloExtra = espacioRem ? ` style="margin-top:${espacioRem}rem"` : "";
  return `
    <div class="print-signatures"${estiloExtra}>
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
export function printAdHoc(title, bodyHTML, firmas, espacioFirmaRem) {
  if (!printScratchEl) {
    printScratchEl = document.createElement("div");
    printScratchEl.className = "print-only-staging";
    document.body.appendChild(printScratchEl);
  }
  printScratchEl.innerHTML = `
    <div style="background:#fff;">
      <div class="print-header">${printHeaderHTML(title)}</div>
      ${bodyHTML}
      <div class="print-footer">${printFooterHTML(firmas, espacioFirmaRem)}</div>
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
