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
 * Nota de diseño: por tratarse de movimientos de existencias (no de datos
 * descriptivos), la edición de un movimiento ya registrado no está
 * disponible ni para el administrador, ya que alteraría el historial de
 * trazabilidad de las cantidades. El administrador sí puede ELIMINAR un
 * movimiento; al hacerlo, el sistema revierte automáticamente el efecto
 * sobre las existencias para mantener la consistencia del stock.
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
import { subscribeCollection, createRecord, deleteRecord } from "./data.js";
import { getCategoriasInsumos, onCategoriasInsumosChange } from "./catalogos.js";
import { toast, confirmDialog, createHistorial, formatDate, parseLocalDate, escapeHTML } from "./ui.js";
import { getIcon } from "./icons.js";
import { isAdmin, getCurrentUser, getResponsableLabel } from "./auth.js";

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
  setupInsumoForm();
  setupEntradaForm();
  setupTransferenciaForm();
  setupDebitoForm();
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
 */
function buildInsumoOptionsHTML(filterText = "") {
  const term = filterText.trim().toLowerCase();
  const activos = insumos.filter((i) => i.activo !== false);
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
  if (term && !visibles.length) html += `<option value="" disabled>Sin coincidencias para "${escapeHTML(filterText)}"</option>`;
  return html;
}

function populateInsumoSelects() {
  document.querySelectorAll("select.select-insumo").forEach((sel) => {
    const searchInput = sel.parentElement?.querySelector(".insumo-search");
    sel.innerHTML = buildInsumoOptionsHTML(searchInput ? searchInput.value : "");
  });
}

/** Conecta cada buscador de insumo con el <select> que le sigue. */
function setupInsumoSearchInputs() {
  document.querySelectorAll(".insumo-search").forEach((input) => {
    input.addEventListener("input", () => {
      const sel = input.parentElement?.querySelector("select.select-insumo");
      if (sel) sel.innerHTML = buildInsumoOptionsHTML(input.value);
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const insumoSelect = form.elements["insumoId"];
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
    } catch (err) {
      console.error(err);
      toast("No se pudo registrar la entrada.", "error");
    }
  });
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const insumoSelect = form.elements["insumoId"];
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
    } catch (err) {
      console.error(err);
      toast(err.message || "No se pudo registrar la transferencia.", "error");
    }
  });
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

function setupDebitoForm() {
  const form = document.getElementById("form-debito");
  if (!form) return;
  const respField = form.elements["responsable"];
  if (respField) respField.value = getResponsableLabel();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const insumoSelect = form.elements["insumoId"];
    const insumoOpt = insumoSelect.options[insumoSelect.selectedIndex];
    const almacen = form.elements["almacenOrigen"].value;
    const cantidad = Number(form.elements["cantidad"].value);
    const motivo = form.elements["motivo"].value;
    const responsable = form.elements["responsable"].value.trim();
    const observaciones = form.elements["observaciones"]?.value || "";
    const fecha = form.elements["fecha"].value;

    if (!insumoOpt?.value || !almacen || !motivo || !cantidad || cantidad <= 0) {
      toast("Complete insumo, almacén, motivo y una cantidad válida.", "error");
      return;
    }

    try {
      await registrarDebito({
        insumoId: insumoOpt.value,
        insumoNombre: insumoOpt.dataset.nombre,
        almacen,
        cantidad,
        motivo,
        responsable,
        observaciones,
        fecha,
      });
      toast("Débito registrado y existencia actualizada.", "success");
      form.reset();
      if (respField) respField.value = getResponsableLabel();
    } catch (err) {
      console.error(err);
      toast(err.message || "No se pudo registrar el débito.", "error");
    }
  });
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

function quitarAcentos(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function mapearFilaImportada(rawRow) {
  const found = {};
  for (const key of Object.keys(rawRow)) {
    const norm = quitarAcentos(key).trim().toLowerCase();
    for (const [campo, aliases] of Object.entries(IMPORT_ALIAS)) {
      if (aliases.includes(norm) && found[campo] === undefined) {
        found[campo] = rawRow[key];
      }
    }
  }
  return {
    nombre: String(found.nombre ?? "").trim(),
    categoria: String(found.categoria ?? "").trim(),
    cantidad: found.cantidad === undefined || found.cantidad === "" ? 0 : Number(found.cantidad),
    almacen: String(found.almacen ?? "").trim(),
    minimo: found.minimo === undefined || found.minimo === "" ? undefined : Number(found.minimo),
  };
}

/**
 * Lee un .csv como texto y detecta si el separador de columnas es coma o
 * punto y coma (muy común en exportes en español/configuración regional
 * latinoamericana) contando cuál aparece más veces en la línea de
 * encabezado, en vez de asumir siempre coma.
 */
function leerCSV(file) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) {
      reject(new Error("La librería para leer Excel no está disponible."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const texto = e.target.result;
        const primeraLinea = texto.split(/\r?\n/)[0] || "";
        const nComas = (primeraLinea.match(/,/g) || []).length;
        const nPuntoYComa = (primeraLinea.match(/;/g) || []).length;
        const FS = nPuntoYComa > nComas ? ";" : ",";
        const wb = window.XLSX.read(texto, { type: "string", FS });
        const hoja = wb.Sheets[wb.SheetNames[0]];
        resolve(window.XLSX.utils.sheet_to_json(hoja, { defval: "" }));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
    reader.readAsText(file, "utf-8");
  });
}

function leerBinario(file) {
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
        resolve(window.XLSX.utils.sheet_to_json(hoja, { defval: "" }));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
    reader.readAsArrayBuffer(file);
  });
}

function leerArchivoImportacion(file) {
  return /\.csv$/i.test(file.name) ? leerCSV(file) : leerBinario(file);
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
      const rows = await leerArchivoImportacion(file);
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
