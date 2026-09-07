/**
 * inventario.js
 * -----------------------------------------------------------------------
 * Módulo de Inventario e Insumos con cuatro ubicaciones/stocks
 * independientes (Depósito, Módulo, Oficina, Ambulancia) que NUNCA se
 * mezclan entre sí.
 *
 * Estructura de datos en Firestore:
 *  - insumos/{id}            → catálogo maestro de insumos (nombre + categoría fija)
 *  - insumoStock/{insumoId__almacen} → existencia y mínimo crítico POR insumo y POR almacén
 *  - entradasInventario/{id} → ingresos (donación/compra) hacia un almacén
 *  - transferenciasInventario/{id} → movimientos entre dos almacenes
 *  - debitosInventario/{id} → salidas/consumo de un almacén (uso operativo,
 *    vencimiento, daño, donación saliente, etc.) — a diferencia de una
 *    transferencia, el insumo sale del sistema por completo, no se mueve a
 *    otro almacén.
 *
 * Las entradas, transferencias y débitos actualizan `insumoStock` de forma
 * atómica mediante transacciones de Firestore para evitar condiciones de
 * carrera cuando varios operadores registran movimientos simultáneamente.
 *
 * Edición y eliminación (solo administrador): por tratarse de movimientos
 * de existencias, editar o eliminar un registro no solo cambia el
 * documento sino que además ajusta `insumoStock` para mantenerlo
 * consistente — al eliminar, revierte el efecto original; al editar,
 * revierte el efecto viejo y aplica el nuevo en la misma transacción (para
 * no dejar el stock a medio actualizar si algo falla a mitad de camino).
 * Para simplificar esa aritmética y evitar ambigüedad, el INSUMO de un
 * movimiento ya registrado no se puede cambiar al editarlo (solo cantidad,
 * almacén(es), motivo, fecha, responsable u observaciones, según el tipo de
 * movimiento) — si el insumo estaba equivocado, se elimina y se registra
 * de nuevo con el insumo correcto.
 * -----------------------------------------------------------------------
 */
import {
  db,
  doc,
  runTransaction,
  serverTimestamp,
  collection,
  addDoc,
  updateDoc,
} from "./firebase.js";
import { COLLECTIONS, ALMACENES, MOTIVOS_DEBITO_INVENTARIO } from "./config.js";
import { subscribeCollection, createRecord, updateRecord, deleteRecord } from "./data.js";
import { getCategoriasInsumos, onCategoriasInsumosChange } from "./catalogos.js";
import { toast, confirmDialog, createHistorial, formatDate, parseLocalDate, toDate, escapeHTML } from "./ui.js";
import { getIcon } from "./icons.js";
import { isAdmin, getCurrentUser, getResponsableLabel } from "./auth.js";
import { quitarAcentos, leerArchivoTabular, mapearFila } from "./importUtils.js";

let insumos = [];
let stock = []; // filas de insumoStock
let entradas = [];
let transferencias = [];
let debitos = [];

function stockDocId(insumoId, almacen) {
  return `${insumoId}__${encodeURIComponent(almacen)}`;
}

export function getInsumos() {
  return insumos;
}
export function getStock() {
  return stock;
}

export function initInventario() {
  // Tabs internos.
  const tabs = document.querySelectorAll("#view-inventario .subtab-btn");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#view-inventario .subtab-panel").forEach((p) => p.classList.add("hidden"));
      document.getElementById(`panel-${btn.dataset.subtab}`).classList.remove("hidden");
      tabs.forEach((b) => b.classList.toggle("subtab-active", b === btn));
    });
  });

  populateAlmacenSelects();
  populateMotivoDebitoSelect();
  setupInsumoSearchInputs();
  setupAlmacenFiltroInsumo();
  setupInsumoForm();
  const entradaFormApi = setupEntradaForm();
  const transferenciaFormApi = setupTransferenciaForm();
  const debitoFormApi = setupDebitoForm();
  setupImportacion();

  document.getElementById("stock-buscar")?.addEventListener("input", renderStockTable);
  document.getElementById("stock-solo-criticos")?.addEventListener("change", renderStockTable);
  document.getElementById("insumos-catalogo-buscar")?.addEventListener("input", renderInsumosTable);

  subscribeCollection(COLLECTIONS.INSUMOS, "nombre", (rows) => {
    insumos = rows;
    renderInsumosTable();
    populateInsumoSelects();
  });

  subscribeCollection(COLLECTIONS.INSUMO_STOCK, "insumoNombre", (rows) => {
    stock = rows;
    renderStockTable();
    // La lista de insumos del formulario de Débito depende de la existencia
    // por almacén: si cambia (p. ej. una entrada agrega stock nuevo a un
    // almacén), hay que refrescarla para que aparezca sin recargar la página.
    populateInsumoSelects();
  });

  entradasHistorial = subscribeCollection(COLLECTIONS.ENTRADAS_INVENTARIO, "fecha", (rows) => {
    entradas = rows;
    entradasHistorialCmp.render();
  });

  transferenciasHistorial = subscribeCollection(COLLECTIONS.TRANSFERENCIAS_INVENTARIO, "fecha", (rows) => {
    transferencias = rows;
    transferenciasHistorialCmp.render();
  });

  debitosHistorial = subscribeCollection(COLLECTIONS.DEBITOS_INVENTARIO, "fecha", (rows) => {
    debitos = rows;
    debitosHistorialCmp.render();
  });

  entradasHistorialCmp = createHistorial({
    root: document.getElementById("historial-entradas"),
    title: "Historial de Entradas de Inventario",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "insumoNombre", label: "Insumo" },
      { key: "cantidad", label: "Cantidad" },
      { key: "almacenDestino", label: "Destino" },
      { key: "responsable", label: "Responsable" },
    ],
    dateField: "fecha",
    getRows: () => entradas,
    isAdmin,
    exportFileName: "Entradas_Inventario",
    onEdit: (row) => entradaFormApi?.startEdit(row),
    onDelete: (row) => deleteEntrada(row),
  });

  transferenciasHistorialCmp = createHistorial({
    root: document.getElementById("historial-transferencias"),
    title: "Historial de Transferencias entre Stocks",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "insumoNombre", label: "Insumo" },
      { key: "stockOrigen", label: "Origen" },
      { key: "stockDestino", label: "Destino" },
      { key: "cantidad", label: "Cantidad" },
      { key: "responsable", label: "Responsable" },
    ],
    dateField: "fecha",
    getRows: () => transferencias,
    isAdmin,
    exportFileName: "Transferencias_Inventario",
    onEdit: (row) => transferenciaFormApi?.startEdit(row),
    onDelete: (row) => deleteTransferencia(row),
  });

  debitosHistorialCmp = createHistorial({
    root: document.getElementById("historial-debitos"),
    title: "Historial de Débitos (Salidas) de Inventario",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "insumoNombre", label: "Insumo" },
      { key: "almacenOrigen", label: "Almacén" },
      { key: "cantidad", label: "Cantidad" },
      { key: "motivo", label: "Motivo" },
      { key: "responsable", label: "Responsable" },
    ],
    dateField: "fecha",
    getRows: () => debitos,
    isAdmin,
    exportFileName: "Debitos_Inventario",
    onEdit: (row) => debitoFormApi?.startEdit(row),
    onDelete: (row) => deleteDebito(row),
  });

  onCategoriasInsumosChange(() => populateCategoriaInsumoSelect());
  populateCategoriaInsumoSelect();
}

let entradasHistorial, transferenciasHistorial, debitosHistorial;
let entradasHistorialCmp, transferenciasHistorialCmp, debitosHistorialCmp;

/* --------------------------- Selects auxiliares ------------------------ */

function populateAlmacenSelects() {
  document.querySelectorAll("select.select-almacen").forEach((sel) => {
    sel.innerHTML = ALMACENES.map((a) => `<option value="${a}">${a}</option>`).join("");
  });
  const filtroAlmacen = document.getElementById("stock-filtro-almacen");
  if (filtroAlmacen) {
    filtroAlmacen.innerHTML = `<option value="">Todos los almacenes</option>` + ALMACENES.map((a) => `<option value="${a}">${a}</option>`).join("");
    filtroAlmacen.addEventListener("change", renderStockTable);
  }
}

function populateMotivoDebitoSelect() {
  document.querySelectorAll("select.select-motivo-debito").forEach((sel) => {
    sel.innerHTML =
      `<option value="">Seleccione motivo...</option>` + MOTIVOS_DEBITO_INVENTARIO.map((m) => `<option value="${m}">${m}</option>`).join("");
  });
}

function populateCategoriaInsumoSelect() {
  const sel = document.getElementById("insumo-categoria");
  if (!sel) return;
  const cats = getCategoriasInsumos().filter((c) => c.activo !== false);
  sel.innerHTML = `<option value="">Seleccione categoría...</option>` + cats.map((c) => `<option value="${c.id}" data-nombre="${c.nombre}">${c.nombre}</option>`).join("");
}

/**
 * Arma las <option> de un <select> de insumo, agrupadas por categoría
 * (<optgroup>) y opcionalmente filtradas por texto (nombre o categoría) —
 * así la lista es manejable aunque haya muchísimos insumos y se usen
 * decenas al día.
 *
 * Si se indica `almacenFiltro`, además se limita la lista a los insumos
 * que tienen existencia mayor a 0 en ese almacén (usado en el formulario de
 * Débito, para no poder elegir por error un insumo que no hay en el
 * almacén de donde se está sacando).
 */
function buildInsumoOptionsHTML(filterText = "", almacenFiltro = "") {
  const term = filterText.trim().toLowerCase();
  let activos = insumos.filter((i) => i.activo !== false);
  if (almacenFiltro) {
    const conExistencia = new Set(
      stock.filter((s) => s.almacen === almacenFiltro && Number(s.existencia) > 0).map((s) => s.insumoId)
    );
    activos = activos.filter((i) => conExistencia.has(i.id));
  }
  const coincide = (i) => i.nombre.toLowerCase().includes(term) || (i.categoriaNombre || "").toLowerCase().includes(term);
  const visibles = term ? activos.filter(coincide) : activos;

  const porCategoria = {};
  visibles.forEach((i) => {
    const cat = i.categoriaNombre || "Sin categoría";
    (porCategoria[cat] = porCategoria[cat] || []).push(i);
  });
  const categorias = Object.keys(porCategoria).sort((a, b) => a.localeCompare(b));

  let html = `<option value="">Seleccione insumo...</option>`;
  categorias.forEach((cat) => {
    html += `<optgroup label="${escapeHTML(cat)}">`;
    html += porCategoria[cat]
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .map((i) => `<option value="${i.id}" data-nombre="${escapeHTML(i.nombre)}">${escapeHTML(i.nombre)}</option>`)
      .join("");
    html += `</optgroup>`;
  });
  if (term && !visibles.length) {
    html += `<option value="" disabled>Sin coincidencias para "${escapeHTML(filterText)}"</option>`;
  } else if (almacenFiltro && !visibles.length) {
    html += `<option value="" disabled>Sin insumos con existencia en ${escapeHTML(almacenFiltro)}</option>`;
  }
  return html;
}

/** Si el <select> de insumo trae `data-filtrar-por-almacen`, devuelve el
 * valor actual del campo de almacén que lo acompaña (o "" si no aplica ese
 * filtro). El campo se busca primero por `name` dentro del mismo
 * formulario, y si no está en un formulario (p. ej. "Insumos utilizados
 * el día de hoy", que vive dentro de un <details>), por su `id`. */
function getAlmacenFiltroDeSelect(sel) {
  const campo = sel.dataset.filtrarPorAlmacen;
  if (!campo) return "";
  const form = sel.closest("form");
  const campoEl = form?.elements[campo] || document.getElementById(campo);
  return campoEl?.value || "";
}

function populateInsumoSelects() {
  document.querySelectorAll("select.select-insumo").forEach((sel) => {
    const searchInput = sel.parentElement?.querySelector(".insumo-search");
    sel.innerHTML = buildInsumoOptionsHTML(searchInput ? searchInput.value : "", getAlmacenFiltroDeSelect(sel));
  });
}

/**
 * Garantiza que el <select> de insumo tenga una <option> para el insumo
 * indicado, aunque el filtro por almacén lo hubiera excluido (p. ej. al
 * editar un débito que dejó la existencia en 0 en ese almacén) — así al
 * entrar en modo edición el insumo del registro se sigue viendo, aunque el
 * campo quede deshabilitado (no se puede cambiar el insumo al editar).
 */
function asegurarOpcionInsumo(sel, insumoId, insumoNombre) {
  if (![...sel.options].some((o) => o.value === insumoId)) {
    const opt = document.createElement("option");
    opt.value = insumoId;
    opt.textContent = insumoNombre;
    opt.dataset.nombre = insumoNombre;
    sel.appendChild(opt);
  }
}

/** Convierte un valor de fecha (Timestamp de Firestore, Date o string) al
 * formato "YYYY-MM-DD" que espera un <input type="date">. */
function formatFechaInput(value) {
  const d = toDate(value);
  return d ? d.toLocaleDateString("en-CA") : "";
}

/** Conecta cada buscador de insumo con el <select> que le sigue. */
function setupInsumoSearchInputs() {
  document.querySelectorAll(".insumo-search").forEach((input) => {
    input.addEventListener("input", () => {
      const sel = input.parentElement?.querySelector("select.select-insumo");
      if (sel) sel.innerHTML = buildInsumoOptionsHTML(input.value, getAlmacenFiltroDeSelect(sel));
    });
  });
}

/**
 * Para los <select> de insumo marcados con `data-filtrar-por-almacen`,
 * refresca la lista de insumos cada vez que cambia el almacén asociado en
 * el mismo formulario.
 */
function setupAlmacenFiltroInsumo() {
  document.querySelectorAll("select.select-insumo[data-filtrar-por-almacen]").forEach((sel) => {
    const campo = sel.dataset.filtrarPorAlmacen;
    const almacenSelect = sel.closest("form")?.elements[campo] || document.getElementById(campo);
    if (!almacenSelect) return;
    almacenSelect.addEventListener("change", () => {
      const searchInput = sel.parentElement?.querySelector(".insumo-search");
      sel.innerHTML = buildInsumoOptionsHTML(searchInput ? searchInput.value : "", almacenSelect.value);
    });
  });
}

/* ------------------------------ Insumos -------------------------------- */

function setupInsumoForm() {
  const form = document.getElementById("form-insumo");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = form.elements["nombre"].value.trim();
    const catSelect = form.elements["categoriaId"];
    const opt = catSelect.options[catSelect.selectedIndex];
    if (!nombre || !opt?.value) {
      toast("Complete el nombre y la categoría del insumo.", "error");
      return;
    }
    try {
      await createRecord(COLLECTIONS.INSUMOS, {
        nombre,
        categoriaId: opt.value,
        categoriaNombre: opt.dataset.nombre,
        activo: true,
      });
      toast("Insumo agregado al catálogo.", "success");
      form.reset();
    } catch (err) {
      console.error(err);
    }
  });
}

function renderInsumosTable() {
  const tbody = document.getElementById("tabla-insumos-body");
  if (!tbody) return;
  const admin = isAdmin();
  const buscar = (document.getElementById("insumos-catalogo-buscar")?.value || "").trim().toLowerCase();
  const filtrados = buscar
    ? insumos.filter((i) => i.nombre.toLowerCase().includes(buscar) || (i.categoriaNombre || "").toLowerCase().includes(buscar))
    : insumos;

  const countEl = document.getElementById("insumos-catalogo-count");
  if (countEl) countEl.textContent = buscar ? `${filtrados.length} de ${insumos.length}` : `${insumos.length} insumo(s)`;

  tbody.innerHTML =
    filtrados
      .map(
        (i) => `
      <tr class="border-t border-slate-100">
        <td class="px-4 py-2">${escapeHTML(i.nombre)}</td>
        <td class="px-4 py-2">${escapeHTML(i.categoriaNombre)}</td>
        <td class="px-4 py-2">${i.activo === false ? '<span class="text-red-600">Inactivo</span>' : '<span class="text-emerald-600">Activo</span>'}</td>
        <td class="px-4 py-2">${admin ? `<button data-id="${i.id}" class="text-red-700 hover:underline" data-act="del">Eliminar</button>` : "—"}</td>
      </tr>`
      )
      .join("") ||
    `<tr><td colspan="4" class="px-4 py-6 text-center text-slate-400">${buscar ? "Sin coincidencias." : "Catálogo vacío."}</td></tr>`;

  if (admin) {
    tbody.querySelectorAll('[data-act="del"]').forEach((btn) => {
      btn.onclick = async () => {
        const ok = await confirmDialog({ title: "Eliminar insumo", message: "¿Eliminar este insumo del catálogo? Las existencias registradas no se verán afectadas." });
        if (ok) deleteRecord(COLLECTIONS.INSUMOS, btn.dataset.id);
      };
    });
  }
}

/* ------------------------------ Existencias ----------------------------- */

function renderStockTable() {
  const tbody = document.getElementById("tabla-stock-body");
  if (!tbody) return;
  const filtro = document.getElementById("stock-filtro-almacen")?.value || "";
  const buscar = (document.getElementById("stock-buscar")?.value || "").trim().toLowerCase();
  const soloCriticos = document.getElementById("stock-solo-criticos")?.checked || false;
  const admin = isAdmin();

  let rows = stock.filter((s) => !filtro || s.almacen === filtro);
  if (buscar) {
    rows = rows.filter(
      (s) => (s.insumoNombre || "").toLowerCase().includes(buscar) || (s.categoriaNombre || "").toLowerCase().includes(buscar)
    );
  }
  if (soloCriticos) {
    rows = rows.filter((s) => Number(s.existencia) <= Number(s.minimo ?? 0));
  }
  rows = rows.sort((a, b) => (a.insumoNombre || "").localeCompare(b.insumoNombre || ""));

  tbody.innerHTML =
    rows
      .map((s) => {
        const critico = Number(s.existencia) <= Number(s.minimo ?? 0);
        return `
      <tr class="border-t border-slate-100 ${critico ? "bg-red-50" : ""}">
        <td class="px-4 py-2">${escapeHTML(s.insumoNombre)}</td>
        <td class="px-4 py-2">${escapeHTML(s.categoriaNombre)}</td>
        <td class="px-4 py-2 font-medium">${escapeHTML(s.almacen)}</td>
        <td class="px-4 py-2 ${critico ? "text-red-700 font-semibold" : ""}">${s.existencia}</td>
        <td class="px-4 py-2">
          ${admin ? `<input type="number" min="0" value="${s.minimo ?? 0}" data-id="${s.id}" class="w-20 border border-slate-300 rounded px-2 py-1 text-sm input-minimo" />` : (s.minimo ?? 0)}
        </td>
        <td class="px-4 py-2">${critico ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-semibold">${getIcon("alerta")}Bajo mínimo</span>` : '<span class="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-semibold">OK</span>'}</td>
      </tr>`;
      })
      .join("") ||
    `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400">${buscar || soloCriticos ? "Sin coincidencias para el filtro aplicado." : "Sin existencias registradas."}</td></tr>`;

  if (admin) {
    tbody.querySelectorAll(".input-minimo").forEach((input) => {
      input.addEventListener("change", async () => {
        try {
          await updateDoc(doc(db, COLLECTIONS.INSUMO_STOCK, input.dataset.id), { minimo: Number(input.value) || 0 });
          toast("Nivel mínimo actualizado.", "success");
        } catch (err) {
          console.error(err);
          toast("No se pudo actualizar el mínimo.", "error");
        }
      });
    });
  }
}

/* ------------------------------- Entradas -------------------------------- */

function setupEntradaForm() {
  const form = document.getElementById("form-entrada");
  if (!form) return;
  const respField = form.elements["responsable"];
  if (respField) respField.value = getResponsableLabel();

  const insumoSelect = form.elements["insumoId"];
  const cancelBtn = form.querySelector('[data-role="cancel-edit"]');
  const submitBtn = form.querySelector('[type="submit"]');
  const defaultSubmitLabel = submitBtn ? submitBtn.textContent : "Registrar entrada";

  const editBanner = document.createElement("div");
  editBanner.className = "hidden mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-300 text-amber-800 text-sm";
  editBanner.textContent = 'Editando una entrada existente: el insumo no se puede cambiar (si era otro insumo, elimine este registro y cree uno nuevo). Pulse "Cancelar edición" para registrar una entrada nueva en su lugar.';
  form.prepend(editBanner);

  let editingRow = null;

  function exitEditMode() {
    editingRow = null;
    form.reset();
    insumoSelect.disabled = false;
    if (respField) respField.value = getResponsableLabel();
    if (submitBtn) submitBtn.textContent = defaultSubmitLabel;
    if (cancelBtn) cancelBtn.classList.add("hidden");
    editBanner.classList.add("hidden");
  }

  if (cancelBtn) {
    cancelBtn.classList.add("hidden");
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      exitEditMode();
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const insumoOpt = insumoSelect.options[insumoSelect.selectedIndex];
    const almacen = form.elements["almacenDestino"].value;
    const cantidad = Number(form.elements["cantidad"].value);
    const responsable = form.elements["responsable"].value.trim();
    const observaciones = form.elements["observaciones"]?.value || "";
    const fecha = form.elements["fecha"].value;

    if (!insumoOpt?.value || !almacen || !cantidad || cantidad <= 0) {
      toast("Complete insumo, almacén destino y una cantidad válida.", "error");
      return;
    }

    try {
      if (editingRow) {
        await editarEntrada(editingRow, { almacen, cantidad, responsable, observaciones, fecha });
        toast("Entrada actualizada y existencia ajustada.", "success");
        exitEditMode();
      } else {
        await registrarEntrada({
          insumoId: insumoOpt.value,
          insumoNombre: insumoOpt.dataset.nombre,
          almacen,
          cantidad,
          responsable,
          observaciones,
          fecha,
        });
        toast("Entrada registrada y existencia actualizada.", "success");
        form.reset();
        if (respField) respField.value = getResponsableLabel();
      }
    } catch (err) {
      console.error(err);
      toast(err.message || "No se pudo registrar la entrada.", "error");
    }
  });

  function startEdit(row) {
    if (!row) return;
    editingRow = row;
    asegurarOpcionInsumo(insumoSelect, row.insumoId, row.insumoNombre);
    insumoSelect.value = row.insumoId;
    insumoSelect.disabled = true;
    form.elements["fecha"].value = formatFechaInput(row.fecha);
    form.elements["almacenDestino"].value = row.almacenDestino;
    form.elements["cantidad"].value = row.cantidad;
    form.elements["responsable"].value = row.responsable || "";
    if (form.elements["observaciones"]) form.elements["observaciones"].value = row.observaciones || "";
    if (submitBtn) submitBtn.textContent = "Guardar cambios";
    if (cancelBtn) cancelBtn.classList.remove("hidden");
    editBanner.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Editando registro. Realice los cambios y guarde.", "info");
  }

  return { startEdit };
}

async function registrarEntrada({ insumoId, insumoNombre, almacen, cantidad, responsable, observaciones, fecha, minimo }) {
  const stockId = stockDocId(insumoId, almacen);
  const insumo = insumos.find((i) => i.id === insumoId);

  await runTransaction(db, async (tx) => {
    const stockRef = doc(db, COLLECTIONS.INSUMO_STOCK, stockId);
    const stockSnap = await tx.get(stockRef);
    const existenciaActual = stockSnap.exists() ? Number(stockSnap.data().existencia) || 0 : 0;
    // `minimo` solo se sobrescribe si se pasó explícitamente (p. ej. desde la
    // importación masiva); el alta manual normal no lo toca.
    const minimoFinal = minimo !== undefined ? minimo : stockSnap.exists() ? stockSnap.data().minimo ?? 0 : 0;
    tx.set(
      stockRef,
      {
        insumoId,
        insumoNombre,
        categoriaId: insumo?.categoriaId || "",
        categoriaNombre: insumo?.categoriaNombre || "",
        almacen,
        existencia: existenciaActual + cantidad,
        minimo: minimoFinal,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });

  const user = getCurrentUser();
  await addDoc(collection(db, COLLECTIONS.ENTRADAS_INVENTARIO), {
    insumoId,
    insumoNombre,
    almacenDestino: almacen,
    cantidad,
    responsable,
    observaciones,
    fecha: fecha ? parseLocalDate(fecha) : new Date(),
    createdAt: serverTimestamp(),
    createdBy: user?.uid || null,
    createdByEmail: user?.email || null,
  });
}

/**
 * Edita una entrada ya registrada. El insumo no cambia (ver nota de diseño
 * al inicio del archivo); solo almacén, cantidad, responsable,
 * observaciones y fecha. Revierte el efecto viejo sobre `insumoStock` y
 * aplica el nuevo en la misma transacción (un solo documento si el
 * almacén no cambió, o dos si cambió) antes de actualizar el registro.
 */
async function editarEntrada(row, { almacen, cantidad, responsable, observaciones, fecha }) {
  const insumoId = row.insumoId;
  const insumoNombre = row.insumoNombre;
  const insumo = insumos.find((i) => i.id === insumoId);
  const stockIdViejo = stockDocId(insumoId, row.almacenDestino);
  const stockIdNuevo = stockDocId(insumoId, almacen);

  await runTransaction(db, async (tx) => {
    if (stockIdViejo === stockIdNuevo) {
      const stockRef = doc(db, COLLECTIONS.INSUMO_STOCK, stockIdViejo);
      const snap = await tx.get(stockRef);
      const existenciaActual = snap.exists() ? Number(snap.data().existencia) || 0 : 0;
      const nuevaExistencia = existenciaActual - Number(row.cantidad) + cantidad;
      if (nuevaExistencia < 0) {
        throw new Error(`La existencia resultante en ${almacen} sería negativa (${nuevaExistencia}).`);
      }
      tx.set(stockRef, { existencia: nuevaExistencia, updatedAt: serverTimestamp() }, { merge: true });
    } else {
      const stockRefViejo = doc(db, COLLECTIONS.INSUMO_STOCK, stockIdViejo);
      const stockRefNuevo = doc(db, COLLECTIONS.INSUMO_STOCK, stockIdNuevo);
      const [snapViejo, snapNuevo] = await Promise.all([tx.get(stockRefViejo), tx.get(stockRefNuevo)]);
      const existenciaViejaActual = snapViejo.exists() ? Number(snapViejo.data().existencia) || 0 : 0;
      const existenciaNuevaActual = snapNuevo.exists() ? Number(snapNuevo.data().existencia) || 0 : 0;
      tx.set(stockRefViejo, { existencia: Math.max(0, existenciaViejaActual - Number(row.cantidad)), updatedAt: serverTimestamp() }, { merge: true });
      tx.set(
        stockRefNuevo,
        {
          insumoId,
          insumoNombre,
          categoriaId: insumo?.categoriaId || "",
          categoriaNombre: insumo?.categoriaNombre || "",
          almacen,
          existencia: existenciaNuevaActual + cantidad,
          minimo: snapNuevo.exists() ? snapNuevo.data().minimo ?? 0 : 0,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }
  });

  await updateRecord(COLLECTIONS.ENTRADAS_INVENTARIO, row.id, {
    almacenDestino: almacen,
    cantidad,
    responsable,
    observaciones,
    fecha: fecha ? parseLocalDate(fecha) : new Date(),
  });
}

/**
 * Fija el nivel mínimo crítico de un insumo en un almacén sin generar un
 * movimiento de existencias (para cuando la importación trae el mínimo
 * pero no trae cantidad que ingresar). Si el documento de stock aún no
 * existe, lo crea con existencia 0.
 */
async function establecerMinimoStock({ insumoId, insumoNombre, almacen, minimo }) {
  const stockId = stockDocId(insumoId, almacen);
  const insumo = insumos.find((i) => i.id === insumoId);
  const stockRef = doc(db, COLLECTIONS.INSUMO_STOCK, stockId);
  await updateDoc(stockRef, { minimo, updatedAt: serverTimestamp() }).catch(async () => {
    // El documento todavía no existe (insumo sin existencias en este
    // almacén): se crea con existencia 0.
    await runTransaction(db, async (tx) => {
      tx.set(
        stockRef,
        {
          insumoId,
          insumoNombre,
          categoriaId: insumo?.categoriaId || "",
          categoriaNombre: insumo?.categoriaNombre || "",
          almacen,
          existencia: 0,
          minimo,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    });
  });
}

async function deleteEntrada(row) {
  if (!row) return;
  const ok = await confirmDialog({
    title: "Eliminar entrada",
    message: `Se eliminará el ingreso de ${row.cantidad} unidad(es) de "${row.insumoNombre}" y se revertirá la existencia en ${row.almacenDestino}. ¿Continuar?`,
  });
  if (!ok) return;
  try {
    const stockId = stockDocId(row.insumoId, row.almacenDestino);
    await runTransaction(db, async (tx) => {
      const stockRef = doc(db, COLLECTIONS.INSUMO_STOCK, stockId);
      const stockSnap = await tx.get(stockRef);
      const existenciaActual = stockSnap.exists() ? Number(stockSnap.data().existencia) || 0 : 0;
      tx.update(stockRef, { existencia: Math.max(0, existenciaActual - Number(row.cantidad)), updatedAt: serverTimestamp() });
    });
    await deleteRecord(COLLECTIONS.ENTRADAS_INVENTARIO, row.id);
    toast("Entrada eliminada y existencia revertida.", "success");
  } catch (err) {
    console.error(err);
    toast("No se pudo eliminar la entrada.", "error");
  }
}

/* --------------------------- Transferencias ------------------------------ */

function setupTransferenciaForm() {
  const form = document.getElementById("form-transferencia");
  if (!form) return;
  const respField = form.elements["responsable"];
  if (respField) respField.value = getResponsableLabel();

  const insumoSelect = form.elements["insumoId"];
  const cancelBtn = form.querySelector('[data-role="cancel-edit"]');
  const submitBtn = form.querySelector('[type="submit"]');
  const defaultSubmitLabel = submitBtn ? submitBtn.textContent : "Registrar transferencia";

  const editBanner = document.createElement("div");
  editBanner.className = "hidden mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-300 text-amber-800 text-sm";
  editBanner.textContent = 'Editando una transferencia existente: el insumo no se puede cambiar. Pulse "Cancelar edición" para registrar una transferencia nueva en su lugar.';
  form.prepend(editBanner);

  let editingRow = null;

  function exitEditMode() {
    editingRow = null;
    form.reset();
    insumoSelect.disabled = false;
    if (respField) respField.value = getResponsableLabel();
    if (submitBtn) submitBtn.textContent = defaultSubmitLabel;
    if (cancelBtn) cancelBtn.classList.add("hidden");
    editBanner.classList.add("hidden");
  }

  if (cancelBtn) {
    cancelBtn.classList.add("hidden");
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      exitEditMode();
    });
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const insumoOpt = insumoSelect.options[insumoSelect.selectedIndex];
    const origen = form.elements["stockOrigen"].value;
    const destino = form.elements["stockDestino"].value;
    const cantidad = Number(form.elements["cantidad"].value);
    const responsable = form.elements["responsable"].value.trim();
    const fecha = form.elements["fecha"].value;

    if (!insumoOpt?.value || !origen || !destino || !cantidad || cantidad <= 0) {
      toast("Complete insumo, stock origen, stock destino y una cantidad válida.", "error");
      return;
    }
    if (origen === destino) {
      toast("El stock de origen y destino no pueden ser el mismo.", "error");
      return;
    }

    try {
      if (editingRow) {
        await editarTransferencia(editingRow, { origen, destino, cantidad, responsable, fecha });
        toast("Transferencia actualizada y existencias ajustadas.", "success");
        exitEditMode();
      } else {
        await registrarTransferencia({
          insumoId: insumoOpt.value,
          insumoNombre: insumoOpt.dataset.nombre,
          origen,
          destino,
          cantidad,
          responsable,
          fecha,
        });
        toast("Transferencia registrada correctamente.", "success");
        form.reset();
        if (respField) respField.value = getResponsableLabel();
      }
    } catch (err) {
      console.error(err);
      toast(err.message || "No se pudo registrar la transferencia.", "error");
    }
  });

  function startEdit(row) {
    if (!row) return;
    editingRow = row;
    asegurarOpcionInsumo(insumoSelect, row.insumoId, row.insumoNombre);
    insumoSelect.value = row.insumoId;
    insumoSelect.disabled = true;
    form.elements["fecha"].value = formatFechaInput(row.fecha);
    form.elements["stockOrigen"].value = row.stockOrigen;
    form.elements["stockDestino"].value = row.stockDestino;
    form.elements["cantidad"].value = row.cantidad;
    form.elements["responsable"].value = row.responsable || "";
    if (submitBtn) submitBtn.textContent = "Guardar cambios";
    if (cancelBtn) cancelBtn.classList.remove("hidden");
    editBanner.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Editando registro. Realice los cambios y guarde.", "info");
  }

  return { startEdit };
}

async function registrarTransferencia({ insumoId, insumoNombre, origen, destino, cantidad, responsable, fecha }) {
  const origenId = stockDocId(insumoId, origen);
  const destinoId = stockDocId(insumoId, destino);
  const insumo = insumos.find((i) => i.id === insumoId);

  await runTransaction(db, async (tx) => {
    const origenRef = doc(db, COLLECTIONS.INSUMO_STOCK, origenId);
    const destinoRef = doc(db, COLLECTIONS.INSUMO_STOCK, destinoId);
    const [origenSnap, destinoSnap] = await Promise.all([tx.get(origenRef), tx.get(destinoRef)]);

    const existenciaOrigen = origenSnap.exists() ? Number(origenSnap.data().existencia) || 0 : 0;
    if (existenciaOrigen < cantidad) {
      throw new Error(`Existencia insuficiente en ${origen}. Disponible: ${existenciaOrigen}.`);
    }
    const existenciaDestino = destinoSnap.exists() ? Number(destinoSnap.data().existencia) || 0 : 0;

    tx.update(origenRef, { existencia: existenciaOrigen - cantidad, updatedAt: serverTimestamp() });
    tx.set(
      destinoRef,
      {
        insumoId,
        insumoNombre,
        categoriaId: insumo?.categoriaId || "",
        categoriaNombre: insumo?.categoriaNombre || "",
        almacen: destino,
        existencia: existenciaDestino + cantidad,
        minimo: destinoSnap.exists() ? destinoSnap.data().minimo ?? 0 : 0,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  });

  const user = getCurrentUser();
  await addDoc(collection(db, COLLECTIONS.TRANSFERENCIAS_INVENTARIO), {
    insumoId,
    insumoNombre,
    stockOrigen: origen,
    stockDestino: destino,
    cantidad,
    responsable,
    fecha: fecha ? parseLocalDate(fecha) : new Date(),
    createdAt: serverTimestamp(),
    createdBy: user?.uid || null,
    createdByEmail: user?.email || null,
  });
}

/**
 * Edita una transferencia ya registrada. El insumo no cambia; origen,
 * destino, cantidad, responsable y fecha sí. Como origen/destino pueden
 * cambiar de forma independiente, se calcula el delta neto por cada
 * documento de stock afectado (hasta 4: origen/destino viejos y nuevos,
 * que pueden coincidir entre sí) y se aplican todos en una sola
 * transacción — revierte el movimiento viejo y aplica el nuevo a la vez,
 * sin dejar el stock a medio actualizar si algo falla.
 */
async function editarTransferencia(row, { origen, destino, cantidad, responsable, fecha }) {
  if (origen === destino) throw new Error("El stock de origen y destino no pueden ser el mismo.");
  const insumoId = row.insumoId;
  const insumoNombre = row.insumoNombre;
  const insumo = insumos.find((i) => i.id === insumoId);

  const idOrigenViejo = stockDocId(insumoId, row.stockOrigen);
  const idDestinoViejo = stockDocId(insumoId, row.stockDestino);
  const idOrigenNuevo = stockDocId(insumoId, origen);
  const idDestinoNuevo = stockDocId(insumoId, destino);

  const deltas = new Map(); // stockId -> { delta, almacen }
  const addDelta = (id, almacen, monto) => {
    const previo = deltas.get(id) || { delta: 0, almacen };
    previo.delta += monto;
    deltas.set(id, previo);
  };
  addDelta(idOrigenViejo, row.stockOrigen, Number(row.cantidad)); // revertir: vuelve al origen viejo
  addDelta(idDestinoViejo, row.stockDestino, -Number(row.cantidad)); // revertir: sale del destino viejo
  addDelta(idOrigenNuevo, origen, -cantidad); // aplicar: sale del nuevo origen
  addDelta(idDestinoNuevo, destino, cantidad); // aplicar: entra al nuevo destino

  await runTransaction(db, async (tx) => {
    const ids = [...deltas.keys()];
    const refs = ids.map((id) => doc(db, COLLECTIONS.INSUMO_STOCK, id));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    ids.forEach((id, i) => {
      const { delta, almacen } = deltas.get(id);
      const snap = snaps[i];
      const existenciaActual = snap.exists() ? Number(snap.data().existencia) || 0 : 0;
      const nuevaExistencia = existenciaActual + delta;
      if (nuevaExistencia < 0) {
        throw new Error(`Existencia insuficiente en ${almacen} para aplicar este cambio.`);
      }
      tx.set(
        refs[i],
        {
          insumoId,
          insumoNombre,
          categoriaId: insumo?.categoriaId || "",
          categoriaNombre: insumo?.categoriaNombre || "",
          almacen,
          existencia: nuevaExistencia,
          minimo: snap.exists() ? snap.data().minimo ?? 0 : 0,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    });
  });

  await updateRecord(COLLECTIONS.TRANSFERENCIAS_INVENTARIO, row.id, {
    stockOrigen: origen,
    stockDestino: destino,
    cantidad,
    responsable,
    fecha: fecha ? parseLocalDate(fecha) : new Date(),
  });
}

async function deleteTransferencia(row) {
  if (!row) return;
  const ok = await confirmDialog({
    title: "Eliminar transferencia",
    message: `Se revertirá el movimiento de ${row.cantidad} unidad(es) de "${row.insumoNombre}" (${row.stockOrigen} → ${row.stockDestino}). ¿Continuar?`,
  });
  if (!ok) return;
  try {
    const origenId = stockDocId(row.insumoId, row.stockOrigen);
    const destinoId = stockDocId(row.insumoId, row.stockDestino);
    await runTransaction(db, async (tx) => {
      const origenRef = doc(db, COLLECTIONS.INSUMO_STOCK, origenId);
      const destinoRef = doc(db, COLLECTIONS.INSUMO_STOCK, destinoId);
      const [origenSnap, destinoSnap] = await Promise.all([tx.get(origenRef), tx.get(destinoRef)]);
      const existenciaOrigen = origenSnap.exists() ? Number(origenSnap.data().existencia) || 0 : 0;
      const existenciaDestino = destinoSnap.exists() ? Number(destinoSnap.data().existencia) || 0 : 0;
      tx.set(origenRef, { existencia: existenciaOrigen + Number(row.cantidad), updatedAt: serverTimestamp() }, { merge: true });
      tx.set(destinoRef, { existencia: Math.max(0, existenciaDestino - Number(row.cantidad)), updatedAt: serverTimestamp() }, { merge: true });
    });
    await deleteRecord(COLLECTIONS.TRANSFERENCIAS_INVENTARIO, row.id);
    toast("Transferencia eliminada y existencias revertidas.", "success");
  } catch (err) {
    console.error(err);
    toast("No se pudo eliminar la transferencia.", "error");
  }
}

/* ------------------------------- Débitos ---------------------------------- */
/* Salida/consumo de un insumo: el insumo sale del sistema (no se mueve a    */
/* otro almacén, a diferencia de una transferencia).                        */

// Lista temporal ("carrito") de insumos a debitar, todos del mismo
// almacén/motivo/fecha/responsable — así se pueden sacar varios productos
// de una vez sin repetir esos campos comunes por cada uno.
let carritoDebitos = []; // [{ insumoId, insumoNombre, cantidad }]

function setupDebitoForm() {
  const form = document.getElementById("form-debito");
  if (!form) return;
  const respField = form.elements["responsable"];
  if (respField) respField.value = getResponsableLabel();

  const fechaField = form.elements["fecha"];
  const almacenSelect = form.elements["almacenOrigen"];
  const motivoSelect = form.elements["motivo"];
  const insumoSelect = document.getElementById("debito-insumo-select");
  const cantidadField = document.getElementById("debito-cantidad");
  const btnAgregar = document.getElementById("btn-agregar-debito");
  const avisoBloqueo = document.getElementById("debito-campos-bloqueados-aviso");
  const cancelBtn = form.querySelector('[data-role="cancel-edit"]');
  const submitBtn = form.querySelector('[type="submit"]');
  const defaultSubmitLabel = submitBtn ? submitBtn.textContent : "Registrar todos los débitos";
  if (!insumoSelect || !cantidadField || !btnAgregar) return;

  const editBanner = document.createElement("div");
  editBanner.className = "hidden mb-3 px-3 py-2 rounded-md bg-amber-50 border border-amber-300 text-amber-800 text-sm";
  editBanner.textContent = 'Editando un débito existente: el insumo no se puede cambiar. Pulse "Cancelar edición" para volver a la lista de insumos pendientes.';
  form.prepend(editBanner);

  let editingRow = null;

  // Fecha, Almacén y Motivo aplican a TODOS los insumos de la lista: se
  // bloquean mientras haya algo pendiente para que no se pueda cambiar el
  // almacén (o el motivo) a medio armar la lista y terminar registrando un
  // insumo agregado bajo un contexto distinto al que se ve al confirmar —
  // el mismo riesgo que ya se corrigió para la edición de registros.
  function actualizarBloqueoCamposComunes() {
    const bloquear = carritoDebitos.length > 0;
    [fechaField, almacenSelect, motivoSelect].forEach((f) => {
      if (f) f.disabled = bloquear;
    });
    if (avisoBloqueo) avisoBloqueo.hidden = !bloquear;
  }

  function exitEditMode() {
    editingRow = null;
    insumoSelect.disabled = false;
    insumoSelect.value = "";
    cantidadField.value = "";
    if (submitBtn) submitBtn.textContent = defaultSubmitLabel;
    if (cancelBtn) cancelBtn.classList.add("hidden");
    editBanner.classList.add("hidden");
    btnAgregar.classList.remove("hidden");
    actualizarBloqueoCamposComunes();
  }

  if (cancelBtn) {
    cancelBtn.classList.add("hidden");
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      exitEditMode();
    });
  }

  function renderCarritoDebitos() {
    const root = document.getElementById("carrito-debitos");
    if (!root) return;
    if (!carritoDebitos.length) {
      root.innerHTML = `<p class="text-xs text-slate-400 italic">Aún no ha agregado insumos a la lista.</p>`;
      actualizarBloqueoCamposComunes();
      return;
    }
    root.innerHTML = `
      <table class="min-w-full text-sm border border-slate-200 rounded-md overflow-hidden">
        <thead class="bg-slate-50 text-slate-600">
          <tr>
            <th class="text-left font-medium px-3 py-1.5">Insumo</th>
            <th class="text-left font-medium px-3 py-1.5">Cantidad</th>
            <th class="px-3 py-1.5"></th>
          </tr>
        </thead>
        <tbody>
          ${carritoDebitos
            .map(
              (item, i) => `
          <tr class="border-t border-slate-100">
            <td class="px-3 py-1.5">${escapeHTML(item.insumoNombre)}</td>
            <td class="px-3 py-1.5">${item.cantidad}</td>
            <td class="px-3 py-1.5 text-right"><button type="button" data-idx="${i}" class="text-red-700 hover:underline text-xs">Quitar</button></td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
    root.querySelectorAll("[data-idx]").forEach((btn) => {
      btn.onclick = () => {
        carritoDebitos.splice(Number(btn.dataset.idx), 1);
        renderCarritoDebitos();
      };
    });
    actualizarBloqueoCamposComunes();
  }

  // Agrega el insumo seleccionado a la lista pendiente (no toca Firestore
  // todavía). Si el insumo ya estaba en la lista, suma la cantidad en vez
  // de duplicar la fila.
  btnAgregar.addEventListener("click", () => {
    if (!almacenSelect.value) {
      toast("Seleccione el almacén.", "error");
      return;
    }
    const opt = insumoSelect.options[insumoSelect.selectedIndex];
    const cantidad = Number(cantidadField.value);
    if (!opt?.value) {
      toast("Seleccione un insumo.", "error");
      return;
    }
    if (!cantidad || cantidad <= 0) {
      toast("Ingrese una cantidad válida.", "error");
      return;
    }

    const existente = carritoDebitos.find((it) => it.insumoId === opt.value);
    if (existente) {
      existente.cantidad += cantidad;
    } else {
      carritoDebitos.push({ insumoId: opt.value, insumoNombre: opt.dataset.nombre, cantidad });
    }
    renderCarritoDebitos();

    cantidadField.value = "";
    const searchInput = insumoSelect.parentElement?.querySelector(".insumo-search");
    if (searchInput) {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input"));
    }
    insumoSelect.value = "";
    (searchInput || insumoSelect).focus();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // Modo edición: el formulario representa UN solo débito ya registrado
    // (no la lista pendiente), así que se actualiza directo en vez de
    // procesar el carrito.
    if (editingRow) {
      const almacen = almacenSelect.value;
      const motivo = motivoSelect.value;
      const cantidad = Number(cantidadField.value);
      const responsable = form.elements["responsable"].value.trim();
      const observaciones = form.elements["observaciones"]?.value || "";
      const fecha = fechaField.value;

      if (!almacen || !motivo || !cantidad || cantidad <= 0) {
        toast("Complete almacén, motivo y una cantidad válida.", "error");
        return;
      }
      if (!responsable) {
        toast("Escriba el responsable.", "error");
        return;
      }

      submitBtn.disabled = true;
      const textoOriginal = submitBtn.textContent;
      submitBtn.textContent = "Guardando...";
      try {
        await editarDebito(editingRow, { almacen, cantidad, motivo, responsable, observaciones, fecha });
        toast("Débito actualizado y existencia ajustada.", "success");
        exitEditMode();
      } catch (err) {
        console.error("Error editando débito", err);
        toast(err.message || "No se pudo actualizar el débito.", "error");
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = textoOriginal;
      }
      return;
    }

    if (!carritoDebitos.length) {
      toast("Agregue al menos un insumo a la lista antes de registrar.", "error");
      return;
    }
    const almacen = almacenSelect.value;
    const motivo = motivoSelect.value;
    const responsable = form.elements["responsable"].value.trim();
    const observaciones = form.elements["observaciones"]?.value || "";
    const fecha = fechaField.value;

    if (!almacen || !motivo) {
      toast("Complete almacén y motivo.", "error");
      return;
    }
    if (!responsable) {
      toast("Escriba el responsable.", "error");
      return;
    }

    submitBtn.disabled = true;
    const defaultLabel = submitBtn.textContent;
    submitBtn.textContent = "Registrando...";

    let registrados = 0;
    try {
      // Va sacando de la lista cada insumo YA registrado (no solo al final):
      // si uno falla a medio camino, un reintento solo procesa los que
      // quedan pendientes, sin volver a debitar los que ya se aplicaron.
      while (carritoDebitos.length) {
        const item = carritoDebitos[0];
        await registrarDebito({
          insumoId: item.insumoId,
          insumoNombre: item.insumoNombre,
          almacen,
          cantidad: item.cantidad,
          motivo,
          responsable,
          observaciones,
          fecha,
        });
        registrados++;
        carritoDebitos.shift();
      }
      toast(`${registrados} débito(s) registrado(s) y existencias actualizadas.`, "success");
      renderCarritoDebitos();
      form.reset();
      if (respField) respField.value = getResponsableLabel();
      form.querySelectorAll("select").forEach((s) => s.dispatchEvent(new Event("change")));
    } catch (err) {
      console.error("Error registrando débito", err);
      renderCarritoDebitos();
      toast(
        `${registrados ? `${registrados} débito(s) registrados. ` : ""}${err.message || "Ocurrió un error registrando un insumo."} Revise la lista e intente de nuevo.`,
        "error"
      );
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = defaultLabel;
      actualizarBloqueoCamposComunes();
    }
  });

  function startEdit(row) {
    if (!row) return;
    if (carritoDebitos.length) {
      toast("Termine de registrar los insumos pendientes en la lista antes de editar otro registro.", "error");
      return;
    }
    editingRow = row;
    fechaField.value = formatFechaInput(row.fecha);
    almacenSelect.value = row.almacenOrigen;
    motivoSelect.value = row.motivo;
    form.elements["responsable"].value = row.responsable || "";
    if (form.elements["observaciones"]) form.elements["observaciones"].value = row.observaciones || "";
    asegurarOpcionInsumo(insumoSelect, row.insumoId, row.insumoNombre);
    insumoSelect.value = row.insumoId;
    insumoSelect.disabled = true;
    cantidadField.value = row.cantidad;
    if (submitBtn) submitBtn.textContent = "Guardar cambios";
    if (cancelBtn) cancelBtn.classList.remove("hidden");
    editBanner.classList.remove("hidden");
    btnAgregar.classList.add("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    toast("Editando registro. Realice los cambios y guarde.", "info");
  }

  renderCarritoDebitos();
  return { startEdit };
}

// Exportado para que otros módulos (p. ej. la Lista Diaria de Pacientes en
// emergencias.js, "Insumos utilizados el día de hoy") puedan generar un
// débito de inventario sin duplicar la lógica de transacción atómica.
export async function registrarDebito({ insumoId, insumoNombre, almacen, cantidad, motivo, responsable, observaciones, fecha }) {
  const stockId = stockDocId(insumoId, almacen);

  await runTransaction(db, async (tx) => {
    const stockRef = doc(db, COLLECTIONS.INSUMO_STOCK, stockId);
    const stockSnap = await tx.get(stockRef);
    const existenciaActual = stockSnap.exists() ? Number(stockSnap.data().existencia) || 0 : 0;
    if (existenciaActual < cantidad) {
      throw new Error(`Existencia insuficiente en ${almacen}. Disponible: ${existenciaActual}.`);
    }
    tx.update(stockRef, { existencia: existenciaActual - cantidad, updatedAt: serverTimestamp() });
  });

  const user = getCurrentUser();
  await addDoc(collection(db, COLLECTIONS.DEBITOS_INVENTARIO), {
    insumoId,
    insumoNombre,
    almacenOrigen: almacen,
    cantidad,
    motivo,
    responsable,
    observaciones,
    fecha: fecha ? parseLocalDate(fecha) : new Date(),
    createdAt: serverTimestamp(),
    createdBy: user?.uid || null,
    createdByEmail: user?.email || null,
  });
}

/**
 * Edita un débito ya registrado. El insumo no cambia; almacén, cantidad,
 * motivo, responsable, observaciones y fecha sí. Revierte el efecto viejo
 * sobre `insumoStock` y aplica el nuevo en la misma transacción.
 */
async function editarDebito(row, { almacen, cantidad, motivo, responsable, observaciones, fecha }) {
  const insumoId = row.insumoId;
  const stockIdViejo = stockDocId(insumoId, row.almacenOrigen);
  const stockIdNuevo = stockDocId(insumoId, almacen);

  await runTransaction(db, async (tx) => {
    if (stockIdViejo === stockIdNuevo) {
      const stockRef = doc(db, COLLECTIONS.INSUMO_STOCK, stockIdViejo);
      const snap = await tx.get(stockRef);
      const existenciaActual = snap.exists() ? Number(snap.data().existencia) || 0 : 0;
      // Revierte la salida vieja (+row.cantidad) y aplica la nueva (-cantidad).
      const nuevaExistencia = existenciaActual + Number(row.cantidad) - cantidad;
      if (nuevaExistencia < 0) {
        throw new Error(`Existencia insuficiente en ${almacen}. Disponible tras revertir el original: ${existenciaActual + Number(row.cantidad)}.`);
      }
      tx.set(stockRef, { existencia: nuevaExistencia, updatedAt: serverTimestamp() }, { merge: true });
    } else {
      const stockRefViejo = doc(db, COLLECTIONS.INSUMO_STOCK, stockIdViejo);
      const stockRefNuevo = doc(db, COLLECTIONS.INSUMO_STOCK, stockIdNuevo);
      const [snapViejo, snapNuevo] = await Promise.all([tx.get(stockRefViejo), tx.get(stockRefNuevo)]);
      const existenciaViejaActual = snapViejo.exists() ? Number(snapViejo.data().existencia) || 0 : 0;
      const existenciaNuevaActual = snapNuevo.exists() ? Number(snapNuevo.data().existencia) || 0 : 0;
      const existenciaNuevaFinal = existenciaNuevaActual - cantidad;
      if (existenciaNuevaFinal < 0) {
        throw new Error(`Existencia insuficiente en ${almacen}. Disponible: ${existenciaNuevaActual}.`);
      }
      tx.set(stockRefViejo, { existencia: existenciaViejaActual + Number(row.cantidad), updatedAt: serverTimestamp() }, { merge: true });
      tx.set(stockRefNuevo, { existencia: existenciaNuevaFinal, updatedAt: serverTimestamp() }, { merge: true });
    }
  });

  await updateRecord(COLLECTIONS.DEBITOS_INVENTARIO, row.id, {
    almacenOrigen: almacen,
    cantidad,
    motivo,
    responsable,
    observaciones,
    fecha: fecha ? parseLocalDate(fecha) : new Date(),
  });
}

export async function deleteDebito(row) {
  if (!row) return;
  const ok = await confirmDialog({
    title: "Eliminar débito",
    message: `Se eliminará la salida de ${row.cantidad} unidad(es) de "${row.insumoNombre}" y se restituirá la existencia en ${row.almacenOrigen}. ¿Continuar?`,
  });
  if (!ok) return;
  try {
    const stockId = stockDocId(row.insumoId, row.almacenOrigen);
    await runTransaction(db, async (tx) => {
      const stockRef = doc(db, COLLECTIONS.INSUMO_STOCK, stockId);
      const stockSnap = await tx.get(stockRef);
      const existenciaActual = stockSnap.exists() ? Number(stockSnap.data().existencia) || 0 : 0;
      tx.set(stockRef, { existencia: existenciaActual + Number(row.cantidad), updatedAt: serverTimestamp() }, { merge: true });
    });
    await deleteRecord(COLLECTIONS.DEBITOS_INVENTARIO, row.id);
    toast("Débito eliminado y existencia restituida.", "success");
  } catch (err) {
    console.error(err);
    toast("No se pudo eliminar el débito.", "error");
  }
}

/* ---------------------------------------------------------------------- */
/* Importación masiva de insumos desde Excel/CSV                           */
/* ---------------------------------------------------------------------- */
// Encabezados aceptados por columna (sin distinguir tildes/mayúsculas), para
// tolerar variaciones razonables en cómo alguien nombró las columnas.
const IMPORT_ALIAS = {
  nombre: ["nombre", "insumo", "producto", "articulo"],
  categoria: ["categoria"],
  cantidad: ["cantidad", "cant", "existencia", "stock"],
  almacen: ["almacen", "ubicacion", "destino"],
  minimo: ["minimo", "minimocritico", "min"],
};

function mapearFilaImportada(rawRow) {
  const found = mapearFila(rawRow, IMPORT_ALIAS);
  return {
    nombre: String(found.nombre ?? "").trim(),
    categoria: String(found.categoria ?? "").trim(),
    cantidad: found.cantidad === undefined || found.cantidad === "" ? 0 : Number(found.cantidad),
    almacen: String(found.almacen ?? "").trim(),
    minimo: found.minimo === undefined || found.minimo === "" ? undefined : Number(found.minimo),
  };
}

/**
 * Intenta detectar el almacén desde alguna fila de título anterior al
 * encabezado real (ej. "...UBICACIÓN: OFICINA" o "...ALMACÉN: DEPÓSITO"),
 * para reportes de un solo almacén que no traen columna Ubicación/Almacén
 * por fila.
 */
function detectarAlmacenDesdeTitulo(filasTitulo) {
  for (const textoOriginal of filasTitulo) {
    const texto = quitarAcentos(textoOriginal).toLowerCase();
    const m = /(?:ubicacion|almacen)\s*:?\s*([a-z]+)/.exec(texto);
    if (m) {
      const candidato = ALMACENES.find((a) => quitarAcentos(a).toLowerCase() === m[1]);
      if (candidato) return candidato;
    }
  }
  return "";
}

/**
 * Lee un .csv/.xlsx/.xls (usando la lectura compartida de importUtils.js) y
 * de paso intenta detectar el almacén desde las filas de título, si el
 * reporte trae la ubicación en un encabezado descriptivo en vez de una
 * columna propia por fila.
 */
async function leerArchivoImportacion(file) {
  const { filas, filasTitulo } = await leerArchivoTabular(file, IMPORT_ALIAS);
  return { filas, almacenDetectado: detectarAlmacenDesdeTitulo(filasTitulo) };
}

let filasImportacionValidas = []; // filas listas para procesar tras la vista previa

function validarFilaImportacion(fila, almacenDefecto) {
  const errores = [];
  if (!fila.nombre) errores.push("falta el nombre");
  const cantidad = isNaN(fila.cantidad) ? 0 : fila.cantidad;
  if (cantidad < 0) errores.push("cantidad inválida");

  let almacenResuelto = fila.almacen;
  if (almacenResuelto) {
    const match = ALMACENES.find((a) => quitarAcentos(a).toLowerCase() === quitarAcentos(almacenResuelto).toLowerCase());
    if (!match) errores.push(`almacén "${fila.almacen}" no reconocido`);
    almacenResuelto = match || "";
  } else {
    almacenResuelto = almacenDefecto;
  }
  const requiereAlmacen = cantidad > 0 || fila.minimo !== undefined;
  if (requiereAlmacen && !almacenResuelto) errores.push("falta almacén");
  if (!fila.categoria) errores.push("falta la categoría");

  const categoriaExiste = getCategoriasInsumos().some((c) => c.nombre.toLowerCase() === fila.categoria.toLowerCase());

  return {
    ...fila,
    cantidad,
    almacenResuelto,
    categoriaNueva: !!fila.categoria && !categoriaExiste,
    errores,
  };
}

function renderPreviewImportacion(filas) {
  const root = document.getElementById("importar-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion");
  if (!root) return;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Seleccione un archivo para ver la vista previa.</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    filasImportacionValidas = [];
    return;
  }

  const validas = filas.filter((f) => f.errores.length === 0);
  filasImportacionValidas = validas;

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${validas.length} de ${filas.length} fila(s) lista(s) para importar.</p>
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Nombre</th>
            <th class="text-left px-2 py-1.5">Categoría</th>
            <th class="text-left px-2 py-1.5">Cantidad</th>
            <th class="text-left px-2 py-1.5">Mínimo</th>
            <th class="text-left px-2 py-1.5">Almacén</th>
            <th class="text-left px-2 py-1.5">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${filas
            .map(
              (f) => `
          <tr class="border-t border-slate-100 ${f.errores.length ? "bg-red-50" : ""}">
            <td class="px-2 py-1.5">${escapeHTML(f.nombre) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.categoria) || "—"}${f.categoriaNueva && !f.errores.length ? ' <span class="text-amber-600">(nueva)</span>' : ""}</td>
            <td class="px-2 py-1.5">${f.cantidad}</td>
            <td class="px-2 py-1.5">${f.minimo ?? "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.almacenResuelto) || "—"}</td>
            <td class="px-2 py-1.5">${f.errores.length ? `<span class="text-red-700">${escapeHTML(f.errores.join(", "))}</span>` : '<span class="text-emerald-700">OK</span>'}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;

  if (btnConfirmar) btnConfirmar.disabled = validas.length === 0;
}

function setupImportacion() {
  const fileInput = document.getElementById("importar-archivo");
  const almacenDefectoSelect = document.getElementById("importar-almacen-defecto");
  const respField = document.getElementById("importar-responsable");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion");
  if (!fileInput || !btnConfirmar) return;

  if (respField) respField.value = getResponsableLabel();

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      renderPreviewImportacion([]);
      return;
    }
    try {
      const { filas: rows, almacenDetectado } = await leerArchivoImportacion(file);
      // Si el reporte trae el almacén en el título (ej. "...UBICACIÓN:
      // OFICINA") y no hay una columna de Almacén por fila, se preselecciona
      // automáticamente para que todas las filas lo usen como destino.
      if (almacenDetectado && almacenDefectoSelect) {
        almacenDefectoSelect.value = almacenDetectado;
        toast(`Almacén detectado en el archivo: ${almacenDetectado}.`, "info");
      }
      const mapeadas = rows.map((r) => mapearFilaImportada(r)).filter((f) => f.nombre || f.categoria || f.cantidad);
      const validadas = mapeadas.map((f) => validarFilaImportacion(f, almacenDefectoSelect?.value || ""));
      renderPreviewImportacion(validadas);
      if (!mapeadas.length) {
        toast("No se encontraron filas reconocibles. Verifique los encabezados de las columnas.", "warning");
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) o CSV válido.", "error");
      renderPreviewImportacion([]);
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionValidas.length) return;
    const responsable = (respField?.value || "").trim() || getResponsableLabel();

    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    // Copias de trabajo locales de los catálogos: evita crear duplicados
    // entre filas del mismo archivo aunque la suscripción en tiempo real de
    // Firestore todavía no haya reflejado lo recién creado en esta misma
    // corrida de importación.
    const categoriasCache = new Map(getCategoriasInsumos().map((c) => [c.nombre.toLowerCase(), c]));
    const insumosCache = new Map(insumos.map((i) => [i.nombre.toLowerCase(), i]));

    let insumosCreados = 0;
    let entradasRegistradas = 0;
    let categoriasCreadas = 0;
    let minimosActualizados = 0;
    let fallidas = 0;

    for (const fila of filasImportacionValidas) {
      try {
        // 1) Categoría: reutilizar o crear.
        let categoria = categoriasCache.get(fila.categoria.toLowerCase());
        if (!categoria) {
          const ref = await createRecord(COLLECTIONS.CATEGORIAS_INSUMOS, { nombre: fila.categoria, activo: true });
          categoria = { id: ref.id, nombre: fila.categoria };
          categoriasCache.set(fila.categoria.toLowerCase(), categoria);
          categoriasCreadas++;
        }

        // 2) Insumo: reutilizar o crear.
        let insumo = insumosCache.get(fila.nombre.toLowerCase());
        if (!insumo) {
          const ref = await createRecord(COLLECTIONS.INSUMOS, {
            nombre: fila.nombre,
            categoriaId: categoria.id,
            categoriaNombre: categoria.nombre,
            activo: true,
          });
          insumo = { id: ref.id, nombre: fila.nombre, categoriaId: categoria.id, categoriaNombre: categoria.nombre };
          insumosCache.set(fila.nombre.toLowerCase(), insumo);
          insumosCreados++;
        }

        // 3) Existencia y/o mínimo crítico en el almacén resuelto.
        if (fila.cantidad > 0 && fila.almacenResuelto) {
          // Trae cantidad: se registra como una Entrada real (con
          // trazabilidad), y de paso se fija el mínimo si vino en el archivo.
          await registrarEntrada({
            insumoId: insumo.id,
            insumoNombre: insumo.nombre,
            almacen: fila.almacenResuelto,
            cantidad: fila.cantidad,
            responsable,
            observaciones: "Importación masiva desde archivo",
            fecha: new Date().toLocaleDateString("en-CA"),
            minimo: fila.minimo,
          });
          entradasRegistradas++;
        } else if (fila.minimo !== undefined && fila.almacenResuelto) {
          // Cantidad 0 pero trae mínimo: solo fija el umbral crítico, sin
          // generar un movimiento de entrada (no hay nada que mover).
          await establecerMinimoStock({ insumoId: insumo.id, insumoNombre: insumo.nombre, almacen: fila.almacenResuelto, minimo: fila.minimo });
          minimosActualizados++;
        }
      } catch (err) {
        console.error("Error importando fila", fila, err);
        fallidas++;
      }
    }

    toast(
      `Importación completa: ${insumosCreados} insumo(s) nuevo(s), ${categoriasCreadas} categoría(s) nueva(s), ${entradasRegistradas} entrada(s) registrada(s)${minimosActualizados ? `, ${minimosActualizados} mínimo(s) actualizado(s)` : ""}${fallidas ? `, ${fallidas} fila(s) con error` : ""}.`,
      fallidas ? "warning" : "success"
    );

    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionValidas = [];
    fileInput.value = "";
    renderPreviewImportacion([]);
  });
}
