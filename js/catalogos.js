/**
 * catalogos.js
 * -----------------------------------------------------------------------
 * Catálogos maestros gestionados exclusivamente por el Administrador:
 *   - Instituciones aliadas (para el módulo de Despacho de Combustible),
 *     agrupadas por categorías fijas.
 *   - Categorías de Insumos (para el módulo de Inventario).
 *
 * Estos catálogos evitan la duplicidad de nombres y errores de tipeo en
 * los registros operativos diarios: en los formularios correspondientes
 * el usuario solo puede SELECCIONAR de estas listas, nunca escribir un
 * valor libre.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS, CATEGORIAS_INSTITUCIONES } from "./config.js";
import { subscribeCollection, createRecord, updateRecord, deleteRecord } from "./data.js";
import { toast, confirmDialog } from "./ui.js";
import { isAdmin } from "./auth.js";

let instituciones = [];
let categoriasInsumos = [];
// Conteos por institución (despachos de combustible y traslados hechos a
// instituciones registradas), usados solo para la columna informativa de
// la tabla del catálogo — no requieren su propio módulo de suscripción.
let despachosCombustible = [];
let trasladosInstitucion = [];
const listeners = { instituciones: [], categoriasInsumos: [] };

export function getInstituciones() {
  return instituciones;
}
export function getCategoriasInsumos() {
  return categoriasInsumos;
}
export function onInstitucionesChange(cb) {
  listeners.instituciones.push(cb);
}
export function onCategoriasInsumosChange(cb) {
  listeners.categoriasInsumos.push(cb);
}

export function initCatalogos() {
  subscribeCollection(COLLECTIONS.INSTITUCIONES, "nombre", (rows) => {
    instituciones = rows;
    listeners.instituciones.forEach((cb) => cb(rows));
    renderInstitucionesTable();
    renderInstitucionesSelects();
  });

  // Solo para calcular la columna de conteo por institución en la tabla del
  // catálogo (cuántos despachos de combustible y traslados se le hicieron).
  subscribeCollection(COLLECTIONS.DESPACHOS_COMBUSTIBLE, "fecha", (rows) => {
    despachosCombustible = rows;
    renderInstitucionesTable();
  });
  subscribeCollection(COLLECTIONS.TRASLADOS, "fecha", (rows) => {
    trasladosInstitucion = rows;
    renderInstitucionesTable();
  });

  subscribeCollection(COLLECTIONS.CATEGORIAS_INSUMOS, "nombre", (rows) => {
    categoriasInsumos = rows;
    listeners.categoriasInsumos.forEach((cb) => cb(rows));
    renderCategoriasInsumosTable();
    renderCategoriasInsumosSelects();
  });

  // Tabs internos de la vista Catálogos.
  const tabs = document.querySelectorAll("#view-catalogos .subtab-btn");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#view-catalogos .subtab-panel").forEach((p) => p.classList.add("hidden"));
      document.getElementById(`panel-${btn.dataset.subtab}`).classList.remove("hidden");
      tabs.forEach((b) => b.classList.toggle("subtab-active", b === btn));
    });
  });

  setupInstitucionForm();
  setupCategoriaInsumoForm();
}

/* ------------------------- Instituciones ------------------------------ */

function setupInstitucionForm() {
  const form = document.getElementById("form-institucion");
  if (!form) return;
  const catSelect = form.elements["categoria"];
  catSelect.innerHTML = CATEGORIAS_INSTITUCIONES.map((c) => `<option value="${c}">${c}</option>`).join("");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = form.elements["nombre"].value.trim();
    const categoria = form.elements["categoria"].value;
    if (!nombre) return;
    try {
      await createRecord(COLLECTIONS.INSTITUCIONES, { nombre, categoria, activo: true });
      toast("Institución agregada al catálogo.", "success");
      form.reset();
    } catch (err) {
      console.error(err);
    }
  });
}

function renderInstitucionesTable() {
  const tbody = document.getElementById("tabla-instituciones-body");
  if (!tbody) return;
  const admin = isAdmin();
  tbody.innerHTML =
    instituciones
      .map((i) => {
        const cantCombustible = despachosCombustible.filter((d) => d.institucionId === i.id).length;
        const cantTraslados = trasladosInstitucion.filter((t) => t.institucionId === i.id).length;
        return `
      <tr class="border-t border-slate-100">
        <td class="px-4 py-2">${i.nombre}</td>
        <td class="px-4 py-2">${i.categoria}</td>
        <td class="px-4 py-2 text-center">${cantCombustible}</td>
        <td class="px-4 py-2 text-center">${cantTraslados}</td>
        <td class="px-4 py-2">${i.activo === false ? '<span class="text-red-600">Inactiva</span>' : '<span class="text-emerald-600">Activa</span>'}</td>
        <td class="px-4 py-2">
          ${
            admin
              ? `<button data-id="${i.id}" data-act="toggle" class="text-navy-700 hover:underline mr-3">${i.activo === false ? "Activar" : "Desactivar"}</button>
                 <button data-id="${i.id}" data-act="del" class="text-red-700 hover:underline">Eliminar</button>`
              : "—"
          }
        </td>
      </tr>`;
      })
      .join("") || `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-400">Catálogo vacío.</td></tr>`;

  if (admin) {
    tbody.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
      btn.onclick = () => {
        const inst = instituciones.find((i) => i.id === btn.dataset.id);
        updateRecord(COLLECTIONS.INSTITUCIONES, inst.id, { activo: inst.activo === false });
      };
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((btn) => {
      btn.onclick = async () => {
        const ok = await confirmDialog({ title: "Eliminar institución", message: "¿Eliminar esta institución del catálogo?" });
        if (ok) deleteRecord(COLLECTIONS.INSTITUCIONES, btn.dataset.id);
      };
    });
  }
}

function renderInstitucionesSelects() {
  document.querySelectorAll("select.select-institucion").forEach((sel) => {
    const current = sel.value;
    // Se incluyen también las inactivas (marcadas) para no romper la
    // edición de despachos ya registrados que las referencian; solo se
    // excluyen de los NUEVOS registros mediante el orden/etiqueta visual.
    sel.innerHTML =
      `<option value="">Seleccione institución...</option>` +
      instituciones
        .map(
          (i) =>
            `<option value="${i.id}" data-nombre="${i.nombre}">${i.nombre} (${i.categoria})${i.activo === false ? " — Inactiva" : ""}</option>`
        )
        .join("");
    if (current) sel.value = current;
  });
}

/* --------------------------- Categorías de Insumos --------------------- */

function setupCategoriaInsumoForm() {
  const form = document.getElementById("form-categoria-insumo");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const nombre = form.elements["nombre"].value.trim();
    if (!nombre) return;
    try {
      await createRecord(COLLECTIONS.CATEGORIAS_INSUMOS, { nombre, activo: true });
      toast("Categoría de insumo agregada.", "success");
      form.reset();
    } catch (err) {
      console.error(err);
    }
  });
}

function renderCategoriasInsumosTable() {
  const tbody = document.getElementById("tabla-categorias-insumos-body");
  if (!tbody) return;
  const admin = isAdmin();
  tbody.innerHTML =
    categoriasInsumos
      .map(
        (c) => `
      <tr class="border-t border-slate-100">
        <td class="px-4 py-2">${c.nombre}</td>
        <td class="px-4 py-2">${c.activo === false ? '<span class="text-red-600">Inactiva</span>' : '<span class="text-emerald-600">Activa</span>'}</td>
        <td class="px-4 py-2">
          ${
            admin
              ? `<button data-id="${c.id}" data-act="toggle" class="text-navy-700 hover:underline mr-3">${c.activo === false ? "Activar" : "Desactivar"}</button>
                 <button data-id="${c.id}" data-act="del" class="text-red-700 hover:underline">Eliminar</button>`
              : "—"
          }
        </td>
      </tr>`
      )
      .join("") || `<tr><td colspan="3" class="px-4 py-6 text-center text-slate-400">Catálogo vacío.</td></tr>`;

  if (admin) {
    tbody.querySelectorAll('[data-act="toggle"]').forEach((btn) => {
      btn.onclick = () => {
        const cat = categoriasInsumos.find((c) => c.id === btn.dataset.id);
        updateRecord(COLLECTIONS.CATEGORIAS_INSUMOS, cat.id, { activo: cat.activo === false });
      };
    });
    tbody.querySelectorAll('[data-act="del"]').forEach((btn) => {
      btn.onclick = async () => {
        const ok = await confirmDialog({ title: "Eliminar categoría", message: "¿Eliminar esta categoría del catálogo?" });
        if (ok) deleteRecord(COLLECTIONS.CATEGORIAS_INSUMOS, btn.dataset.id);
      };
    });
  }
}

function renderCategoriasInsumosSelects() {
  document.querySelectorAll("select.select-categoria-insumo").forEach((sel) => {
    const current = sel.value;
    const activas = categoriasInsumos.filter((c) => c.activo !== false);
    sel.innerHTML =
      `<option value="">Seleccione categoría...</option>` +
      activas.map((c) => `<option value="${c.id}" data-nombre="${c.nombre}">${c.nombre}</option>`).join("");
    if (current) sel.value = current;
  });
}
