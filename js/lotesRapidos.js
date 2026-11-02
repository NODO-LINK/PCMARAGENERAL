/**
 * lotesRapidos.js
 * -----------------------------------------------------------------------
 * "Despachos anteriores" / "Débitos anteriores": lista cada despacho (o
 * reporte de débito) por separado —no mezclados por día— y permite abrirlo,
 * ver su recibo y, si es administrador, corregirlo línea por línea
 * (cantidad, origen/almacén, cambiar de insumo o eliminar).
 *
 * Los registros hechos con el Despacho/Débito rápido llevan un `loteId`.
 * Los antiguos (sin loteId) se agrupan por usuario + día + cercanía en el
 * tiempo (menos de 5 min entre uno y otro).
 * -----------------------------------------------------------------------
 */
import { isAdmin } from "./auth.js";
import { toast, escapeHTML, toDate } from "./ui.js";
import {
  getInsumos, getTransferencias, getDebitos, editarTransferencia, corregirInsumoTransferencia, deleteTransferencia, editarDebito, corregirInsumoDebito, deleteDebito,
} from "./inventario.js";

const ORIGENES = ["Oficina", "Depósito"];
const ALMACENES_DEBITO = ["Módulo", "Ambulancia"];
const VENTANA_MS = 5 * 60 * 1000;

const dia = (v) => toDate(v)?.toLocaleDateString("en-CA") || "";
const hora = (v) => toDate(v)?.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }) || "";

/** Agrupa filas en lotes (despachos), del más reciente al más antiguo. */
export function agruparLotes(rows, claveAlmacen) {
  const ms = (r) => toDate(r.createdAt)?.getTime() || 0;
  const orden = [...rows].sort((a, b) => ms(a) - ms(b));
  const porLote = new Map();
  const grupos = [];
  let ultimo = null; // último grupo "antiguo" (sin loteId)
  orden.forEach((r) => {
    if (r.loteId) {
      let g = porLote.get(r.loteId);
      if (!g) grupos.push((g = { filas: [] })), porLote.set(r.loteId, g);
      g.filas.push(r);
      return;
    }
    const quien = r.createdByEmail || r.createdBy || "";
    const sigue = ultimo && ultimo.quien === quien && ultimo.dia === dia(r.fecha) && ultimo.almacen === r[claveAlmacen] && ms(r) - ultimo.t <= VENTANA_MS;
    if (sigue) {
      ultimo.filas.push(r);
      ultimo.t = ms(r);
    } else {
      ultimo = { filas: [r], quien, dia: dia(r.fecha), almacen: r[claveAlmacen], t: ms(r) };
      grupos.push(ultimo);
    }
  });
  return grupos
    .map((g) => {
      const primera = g.filas[0];
      return {
        filas: g.filas,
        ids: new Set(g.filas.map((f) => f.id)),
        fecha: dia(primera.fecha),
        hora: hora(primera.createdAt),
        t: Math.max(...g.filas.map(ms)),
        responsable: primera.responsable || "",
        total: g.filas.reduce((a, f) => a + (Number(f.cantidad) || 0), 0),
      };
    })
    .sort((a, b) => (b.fecha === a.fecha ? b.t - a.t : b.fecha.localeCompare(a.fecha)));
}

/**
 * @param {HTMLElement} cont - contenedor donde se pinta.
 * @param {"despacho"|"debito"} tipo
 * @param {(grupo) => void} verRecibo - callback para mostrar el recibo de un lote.
 */
export function montarLotes(cont, tipo, verRecibo) {
  const esDespacho = tipo === "despacho";
  const filas = () => (esDespacho ? getTransferencias().filter((t) => t.stockDestino === "Módulo" && ORIGENES.includes(t.stockOrigen)) : getDebitos().filter((d) => ALMACENES_DEBITO.includes(d.almacenOrigen)));
  const lotes = () => agruparLotes(filas(), esDespacho ? "stockDestino" : "almacenOrigen");
  const palabra = esDespacho ? "despacho" : "débito";
  let mes = "";
  let abiertoIds = null; // ids del lote abierto (para volver a encontrarlo tras editar)

  const refrescarTras = () => setTimeout(() => (abiertoIds ? pintarDetalle() : pintarLista()), 700);

  function pintarLista() {
    const todos = lotes().filter((g) => !mes || g.fecha.startsWith(mes));
    const visibles = mes ? todos : todos.slice(0, 40);
    cont.innerHTML = `
      <div class="border border-slate-200 rounded-md p-3 bg-white">
        <div class="flex flex-wrap items-end justify-between gap-2 mb-2">
          <div class="font-semibold text-slate-700 text-sm">${esDespacho ? "Despachos anteriores al Módulo" : "Débitos anteriores (Módulo y Ambulancia)"} <span class="text-xs font-normal text-slate-400">(cada uno por separado)</span></div>
          <div class="flex items-end gap-2">
            <div><label class="form-label !mb-0 text-xs">Mes</label><input type="month" data-f="mes" class="form-input !py-1" value="${mes}" /></div>
            <button type="button" data-f="cerrar" class="px-3 py-1.5 text-xs rounded-md text-slate-500 hover:underline">Cerrar</button>
          </div>
        </div>
        ${visibles.length
          ? `<div class="divide-y divide-slate-100 border border-slate-100 rounded-md">${visibles
              .map(
                (g, i) => `<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span><strong>${escapeHTML(g.fecha.split("-").reverse().join("/"))}</strong> ${escapeHTML(g.hora)} · ${escapeHTML(g.responsable)} · ${g.filas[0][esDespacho ? "stockDestino" : "almacenOrigen"]} · ${g.filas.length} insumo(s), ${g.total} unid.</span>
                  <button type="button" data-i="${i}" class="text-navy-700 hover:underline text-xs font-semibold">Ver${isAdmin() ? " / editar" : ""}</button>
                </div>`
              )
              .join("")}</div>
            ${!mes && todos.length > visibles.length ? `<p class="text-xs text-slate-400 mt-1">Se muestran los 40 más recientes. Elija un mes para ver los anteriores.</p>` : ""}`
          : `<p class="text-xs text-slate-400">No hay ${palabra}s registrados${mes ? " en ese mes" : ""}.</p>`}
      </div>`;
    cont.querySelector('[data-f="mes"]').onchange = (e) => {
      mes = e.target.value;
      pintarLista();
    };
    cont.querySelector('[data-f="cerrar"]').onclick = () => {
      cont.innerHTML = "";
    };
    cont.querySelectorAll("[data-i]").forEach((b) => {
      b.onclick = () => {
        abiertoIds = visibles[Number(b.dataset.i)].ids;
        pintarDetalle();
      };
    });
  }

  function pintarDetalle() {
    const g = lotes().find((x) => [...abiertoIds].some((id) => x.ids.has(id)));
    if (!g) {
      abiertoIds = null;
      return pintarLista();
    }
    abiertoIds = g.ids;
    const admin = isAdmin();
    const cabecera = `${g.fecha.split("-").reverse().join("/")} ${g.hora} · ${g.responsable}`;
    cont.innerHTML = `
      <div class="border border-slate-300 rounded-md p-3 bg-white">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div class="font-semibold text-slate-700 text-sm">${esDespacho ? "Despacho" : "Débito"} del ${escapeHTML(cabecera)} — ${g.filas.length} insumo(s), ${g.total} unid.</div>
          <div class="flex gap-2">
            <button type="button" data-f="recibo" class="btn-secondary !py-1 !text-xs">Ver recibo (copiar / imprimir)</button>
            <button type="button" data-f="volver" class="px-3 py-1.5 text-xs rounded-md text-slate-500 hover:underline">← Volver a la lista</button>
          </div>
        </div>
        ${admin ? "" : `<p class="text-xs text-slate-500 mb-2">Solo un administrador puede corregir registros.</p>`}
        <div class="overflow-x-auto border border-slate-200 rounded-md">
          <table class="min-w-full text-sm">
            <thead class="bg-slate-50 text-slate-600"><tr>
              <th class="text-left px-2 py-1.5">Insumo</th><th class="text-left px-2 py-1.5 w-24">Cantidad</th><th class="text-left px-2 py-1.5">${esDespacho ? "Sale de" : "Almacén"}</th>${admin ? '<th class="px-2 py-1.5"></th>' : ""}
            </tr></thead>
            <tbody>
              ${g.filas
                .map((r) => {
                  const lista = esDespacho ? ORIGENES : ALMACENES_DEBITO;
                  const actual = esDespacho ? r.stockOrigen : r.almacenOrigen;
                  return `<tr class="border-t border-slate-100" data-id="${r.id}">
                    <td class="px-2 py-1.5 font-medium">${escapeHTML(r.insumoNombre)}</td>
                    <td class="px-2 py-1.5">${admin ? `<input type="number" min="1" step="any" data-f="cant" class="form-input !py-1" value="${r.cantidad}" />` : r.cantidad}</td>
                    <td class="px-2 py-1.5">${admin ? `<select data-f="alm" class="form-input !py-1">${lista.map((a) => `<option ${a === actual ? "selected" : ""}>${a}</option>`).join("")}</select>` : escapeHTML(actual)}</td>
                    ${admin ? `<td class="px-2 py-1.5 whitespace-nowrap">
                      <button type="button" data-f="guardar" class="text-emerald-700 hover:underline text-xs font-semibold mr-3">Guardar</button>
                      <button type="button" data-f="insumo" class="text-amber-700 hover:underline text-xs mr-3">Cambiar insumo</button>
                      <button type="button" data-f="eliminar" class="text-red-700 hover:underline text-xs">Eliminar</button></td>` : ""}
                  </tr>`;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`;
    cont.querySelector('[data-f="volver"]').onclick = () => {
      abiertoIds = null;
      pintarLista();
    };
    cont.querySelector('[data-f="recibo"]').onclick = () => verRecibo(g);
    cont.querySelectorAll("tr[data-id]").forEach((tr) => {
      const fila = g.filas.find((f) => f.id === tr.dataset.id);
      const fechaIso = dia(fila.fecha);
      tr.querySelector('[data-f="guardar"]')?.addEventListener("click", async () => {
        const cantidad = Number(tr.querySelector('[data-f="cant"]').value);
        const alm = tr.querySelector('[data-f="alm"]').value;
        if (!cantidad || cantidad <= 0) return toast("Escriba una cantidad válida.", "error");
        try {
          if (esDespacho) await editarTransferencia(fila, { origen: alm, destino: fila.stockDestino, cantidad, responsable: fila.responsable, fecha: fechaIso });
          else await editarDebito(fila, { almacen: alm, cantidad, motivo: fila.motivo, responsable: fila.responsable, observaciones: fila.observaciones || "", fecha: fechaIso });
          toast("Registro corregido y existencias ajustadas.", "success");
        } catch (err) {
          console.error(err);
          toast(err.message || "No se pudo corregir el registro.", "error");
        }
        refrescarTras();
      });
      tr.querySelector('[data-f="insumo"]')?.addEventListener("click", async () => {
        await (esDespacho ? corregirInsumoTransferencia(fila) : corregirInsumoDebito(fila));
        refrescarTras();
      });
      tr.querySelector('[data-f="eliminar"]')?.addEventListener("click", async () => {
        await (esDespacho ? deleteTransferencia(fila) : deleteDebito(fila));
        refrescarTras();
      });
    });
  }

  void getInsumos;
  pintarLista();
}
