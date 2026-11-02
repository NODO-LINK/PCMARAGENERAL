/**
 * unificarInsumos.js
 * -----------------------------------------------------------------------
 * Herramienta (solo administrador) para dejar UNA sola lista con UN solo
 * nombre por producto: detecta insumos del catálogo duplicados por estar
 * escritos distinto ("SOLUCION 5%", "Solución Dextrosa 5%"...), propone
 * grupos y, al confirmar, une cada grupo en un solo insumo:
 *   - suma las existencias de cada almacén en un único registro,
 *   - apunta Entradas / Transferencias / Débitos al insumo unificado,
 *   - renombra el insumo con el nombre elegido y elimina los duplicados.
 * Antes de aplicar descarga un respaldo (JSON) del catálogo y las existencias.
 * -----------------------------------------------------------------------
 */
import { db, doc, writeBatch } from "./firebase.js";
import { COLLECTIONS, ALMACENES } from "./config.js";
import { getInsumos, getStock, getEntradas, getTransferencias, getDebitos } from "./inventario.js";
import { isAdmin } from "./auth.js";
import { toast, escapeHTML, confirmDialog } from "./ui.js";
import { normalizarBusqueda } from "./busqueda.js";

/* ------------------------------ Detección -------------------------------- */

const VACIAS = new Set(["de", "del", "la", "el", "al", "con", "y", "en", "para", "los", "las", "un", "una", "x"]);
const ABREVIATURAS = { amp: "ampolla", ampollas: "ampolla", tab: "tableta", tabs: "tableta", comp: "comprimido", sol: "solucion", jbe: "jarabe", sup: "supositorio", caps: "capsula", cap: "capsula", iny: "inyectable", inyec: "inyectable", cc: "ml", mls: "ml", mililitro: "ml", mililitros: "ml" };
const singular = (t) => (t.length > 4 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

function tokens(nombre) {
  return normalizarBusqueda(nombre)
    .replace(/%/g, " ")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/(\d)(?=[a-zñ])/g, "$1 ")
    .replace(/([a-zñ])(?=\d)/g, "$1 ")
    .split(/\s+/)
    .filter((t) => t && !VACIAS.has(t))
    .map((t) => ABREVIATURAS[t] || singular(t))
    .map((t) => ABREVIATURAS[t] || t);
}

function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const esNumero = (t) => /^\d+$/.test(t);
const numerosDe = (set) => [...set].filter(esNumero).sort().join(",");

/** Agrupa insumos probablemente iguales. Devuelve [{ tipo: "exacto"|"revisar", miembros: [insumo] }] */
export function detectarGrupos(insumos) {
  const lista = insumos.map((i) => ({ i, toks: tokens(i.nombre) }));
  // Corrige errores de tipeo: un token raro (≥6 letras) a 1 letra de otro más frecuente.
  const frecuencia = new Map();
  lista.forEach((x) => x.toks.forEach((t) => frecuencia.set(t, (frecuencia.get(t) || 0) + 1)));
  const vocab = [...frecuencia.keys()].filter((t) => t.length >= 6 && !esNumero(t));
  const corregir = (t) => {
    if (t.length < 6 || esNumero(t)) return t;
    let mejor = t;
    vocab.forEach((c) => {
      if (c !== t && Math.abs(c.length - t.length) <= 1 && (frecuencia.get(c) > frecuencia.get(mejor) || (frecuencia.get(c) === frecuencia.get(mejor) && c < mejor)) && distancia(t, c) <= 1) mejor = c;
    });
    return mejor;
  };
  lista.forEach((x) => (x.set = new Set(x.toks.map(corregir))));

  // 1) mismo conjunto de palabras = mismo producto escrito distinto
  const porClave = new Map();
  lista.forEach((x) => {
    const k = [...x.set].sort().join(" ");
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push(x);
  });
  // 2) claves parecidas (mismas cifras, ≥60% de palabras en común) se proponen "para revisar"
  const clusters = [...porClave.values()].sort((a, b) => a[0].i.nombre.localeCompare(b[0].i.nombre, "es"));
  const grupos = [];
  clusters.forEach((c) => {
    const set = c[0].set;
    const g = grupos.find((g) => {
      const inter = [...set].filter((t) => g.set.has(t)).length;
      const union = new Set([...set, ...g.set]).size;
      const n1 = numerosDe(set);
      const n2 = numerosDe(g.set);
      return union && inter / union >= 0.6 && (n1 === n2 || !n1 || !n2);
    });
    if (g) {
      g.clusters.push(c);
    } else grupos.push({ set, clusters: [c] });
  });
  return grupos
    .map((g) => ({ tipo: g.clusters.length > 1 ? "revisar" : "exacto", miembros: g.clusters.flat().map((x) => x.i) }))
    .filter((g) => g.miembros.length > 1)
    .sort((a, b) => (a.tipo === b.tipo ? a.miembros[0].nombre.localeCompare(b.miembros[0].nombre, "es") : a.tipo === "exacto" ? -1 : 1));
}

/** Nombre sugerido: el que ya esté en mayúscula/minúscula mixta (más largo); si no, "Frase en minúsculas". */
function nombreSugerido(miembros) {
  const mixtos = miembros.map((m) => m.nombre || "").filter((n) => /[a-záéíóúñ]/.test(n) && /[A-ZÁÉÍÓÚÑ]/.test(n));
  if (mixtos.length) return mixtos.sort((a, b) => b.length - a.length)[0];
  const base = (miembros.map((m) => m.nombre || "").sort((a, b) => b.length - a.length)[0] || "").trim().toLowerCase();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/* -------------------------------- Aplicar -------------------------------- */

const resumenStock = (id) => {
  const porAlm = new Map();
  getStock().filter((s) => s.insumoId === id).forEach((s) => porAlm.set(s.almacen, (porAlm.get(s.almacen) || 0) + (Number(s.existencia) || 0)));
  return [...porAlm.entries()].map(([a, n]) => `${a}: ${n}`).join(" · ") || "sin existencias";
};
const movimientosDe = (id) => [...getEntradas(), ...getTransferencias(), ...getDebitos()].filter((r) => r.insumoId === id).length;

/** Arma todas las operaciones de escritura de los grupos aprobados. */
function construirOperaciones(grupos) {
  const ops = [];
  const insumos = getInsumos();
  let existenciasMovidas = 0;
  let registrosReapuntados = 0;
  grupos.forEach((g) => {
    const canon = insumos.find((i) => i.id === g.canonId);
    const otros = g.miembros.filter((id) => id !== g.canonId);
    const todos = new Set([g.canonId, ...otros]);
    const nombre = g.nombre.trim();

    // Registros históricos → insumo unificado
    [[COLLECTIONS.ENTRADAS_INVENTARIO, getEntradas()], [COLLECTIONS.TRANSFERENCIAS_INVENTARIO, getTransferencias()], [COLLECTIONS.DEBITOS_INVENTARIO, getDebitos()]].forEach(([col, rows]) => {
      rows.filter((r) => todos.has(r.insumoId)).forEach((r) => {
        if (r.insumoId !== g.canonId || r.insumoNombre !== nombre) {
          ops.push({ t: "update", ref: doc(db, col, r.id), data: { insumoId: g.canonId, insumoNombre: nombre } });
          registrosReapuntados++;
        }
      });
    });

    // Existencias: una sola por almacén
    const porAlm = new Map();
    getStock().filter((s) => todos.has(s.insumoId)).forEach((s) => {
      const a = porAlm.get(s.almacen) || { existencia: 0, minimo: 0 };
      a.existencia += Number(s.existencia) || 0;
      a.minimo = Math.max(a.minimo, Number(s.minimo) || 0);
      porAlm.set(s.almacen, a);
    });
    porAlm.forEach((v, almacen) => {
      ops.push({ t: "set", ref: doc(db, COLLECTIONS.INSUMO_STOCK, `${g.canonId}__${encodeURIComponent(almacen)}`), data: { insumoId: g.canonId, insumoNombre: nombre, categoriaId: canon?.categoriaId || "", categoriaNombre: canon?.categoriaNombre || "", almacen, existencia: v.existencia, minimo: v.minimo } });
      existenciasMovidas += v.existencia;
    });
    getStock().filter((s) => otros.includes(s.insumoId)).forEach((s) => ops.push({ t: "delete", ref: doc(db, COLLECTIONS.INSUMO_STOCK, s.id) }));

    // Catálogo: renombrar el que queda y borrar los duplicados
    const algunoActivo = [canon, ...otros.map((id) => insumos.find((i) => i.id === id))].some((i) => i && i.activo !== false);
    ops.push({ t: "update", ref: doc(db, COLLECTIONS.INSUMOS, g.canonId), data: { nombre, activo: algunoActivo } });
    otros.forEach((id) => ops.push({ t: "delete", ref: doc(db, COLLECTIONS.INSUMOS, id) }));
  });
  // Orden seguro: primero actualizar/crear, al final borrar.
  const orden = { update: 0, set: 0, delete: 1 };
  ops.sort((a, b) => orden[a.t] - orden[b.t]);
  return { ops, existenciasMovidas, registrosReapuntados };
}

async function ejecutar(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const lote = writeBatch(db);
    ops.slice(i, i + 400).forEach((o) => (o.t === "set" ? lote.set(o.ref, o.data) : o.t === "update" ? lote.update(o.ref, o.data) : lote.delete(o.ref)));
    await lote.commit();
  }
}

function descargarRespaldo() {
  const datos = { generado: new Date().toISOString(), insumos: getInsumos(), insumoStock: getStock() };
  const blob = new Blob([JSON.stringify(datos, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  a.download = `respaldo-insumos-${d.toLocaleDateString("en-CA")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

/* ----------------------------------- UI ---------------------------------- */

let grupos = []; // [{ id, tipo, miembros:[id], incluidos:Set, canonId, nombre, aplicar }]
let contador = 0;

export function initUnificarInsumos() {
  const raiz = document.getElementById("unificar-insumos");
  if (!raiz) return;
  raiz.innerHTML = `
    <div class="form-card">
      <h3 class="font-semibold text-slate-700 mb-1">Unificar insumos duplicados</h3>
      <p class="text-xs text-slate-500 mb-3 max-w-3xl">
        Deja <strong>un solo insumo con un solo nombre</strong> por producto. Detecta los que están repetidos por estar escritos distinto, usted revisa cada grupo (elige el nombre final y desmarca lo que no sea igual)
        y al confirmar se <strong>suman las existencias de cada almacén</strong>, se corrigen las entradas, transferencias y débitos antiguos y se eliminan los duplicados.
        Antes de aplicar se descarga un respaldo. <strong>Pida que nadie registre movimientos mientras se unifica.</strong>
      </p>
      <div class="flex flex-wrap gap-2">
        <button type="button" id="un-buscar" class="btn-primary">Buscar duplicados</button>
      </div>
      <div id="un-resumen" class="text-sm text-slate-600 mt-3"></div>
      <div id="un-grupos" class="mt-3 space-y-3"></div>
      <div id="un-manual" class="mt-4"></div>
      <div id="un-acciones" class="mt-4"></div>
    </div>`;
  const el = (s) => raiz.querySelector(s);
  const catalogo = () => getInsumos().filter((i) => i.nombre);
  const porId = (id) => getInsumos().find((i) => i.id === id);

  function buscar() {
    const usados = new Set();
    grupos = detectarGrupos(catalogo()).map((g) => {
      g.miembros.forEach((m) => usados.add(m.id));
      const conStock = [...g.miembros].sort((a, b) => (movimientosDe(b.id) + getStock().filter((s) => s.insumoId === b.id).length) - (movimientosDe(a.id) + getStock().filter((s) => s.insumoId === a.id).length));
      return { id: ++contador, tipo: g.tipo, miembros: g.miembros.map((m) => m.id), incluidos: new Set(g.miembros.map((m) => m.id)), canonId: conStock[0].id, nombre: nombreSugerido(g.miembros), aplicar: g.tipo === "exacto" };
    });
    pintar();
  }

  function pintar() {
    const total = catalogo().length;
    el("#un-resumen").innerHTML = grupos.length
      ? `${total} insumos en el catálogo. Se encontraron <strong>${grupos.length}</strong> grupo(s) con posibles duplicados: <span class="text-emerald-700">${grupos.filter((g) => g.tipo === "exacto").length} con el mismo nombre escrito distinto (marcados)</span> y <span class="text-amber-700">${grupos.filter((g) => g.tipo === "revisar").length} parecidos para revisar (sin marcar)</span>.`
      : `${total} insumos en el catálogo. No se encontraron duplicados evidentes. Puede unir insumos a mano abajo.`;
    el("#un-grupos").innerHTML = grupos
      .map(
        (g) => `
      <div class="border rounded-md ${g.tipo === "exacto" ? "border-emerald-200" : "border-amber-200"}" data-g="${g.id}">
        <div class="flex flex-wrap items-center gap-3 px-3 py-2 ${g.tipo === "exacto" ? "bg-emerald-50" : "bg-amber-50"}">
          <label class="inline-flex items-center gap-2 text-sm font-semibold"><input type="checkbox" data-f="aplicar" ${g.aplicar ? "checked" : ""} /> Unificar este grupo</label>
          <span class="text-xs text-slate-500">${g.tipo === "exacto" ? "Mismo producto, escrito distinto" : "Parecidos: revise antes de marcar"}</span>
          <input type="text" data-f="nombre" class="form-input !py-1 flex-1 min-w-[14rem]" value="${escapeHTML(g.nombre)}" title="Nombre final del insumo" />
          <button type="button" data-f="quitar-grupo" class="text-xs text-slate-500 hover:underline">Descartar grupo</button>
        </div>
        <table class="min-w-full text-xs"><tbody>
          ${g.miembros
            .map((id) => {
              const i = porId(id);
              if (!i) return "";
              return `<tr class="border-t border-slate-100">
                <td class="px-3 py-1"><input type="checkbox" data-f="incluir" data-id="${id}" ${g.incluidos.has(id) ? "checked" : ""} title="Incluir en la unión" /></td>
                <td class="px-2 py-1"><label class="inline-flex items-center gap-1"><input type="radio" name="canon-${g.id}" data-f="canon" data-id="${id}" ${g.canonId === id ? "checked" : ""} /> conservar</label></td>
                <td class="px-2 py-1 font-medium">${escapeHTML(i.nombre)}</td>
                <td class="px-2 py-1 text-slate-500">${escapeHTML(i.categoriaNombre || "")}</td>
                <td class="px-2 py-1 text-slate-500">${escapeHTML(resumenStock(id))}</td>
                <td class="px-2 py-1 text-slate-400">${movimientosDe(id)} mov.</td>
              </tr>`;
            })
            .join("")}
        </tbody></table>
      </div>`
      )
      .join("");

    el("#un-grupos").querySelectorAll("[data-g]").forEach((cuadro) => {
      const g = grupos.find((x) => x.id === Number(cuadro.dataset.g));
      cuadro.querySelector('[data-f="aplicar"]').onchange = (e) => {
        g.aplicar = e.target.checked;
        pintarAcciones();
      };
      cuadro.querySelector('[data-f="nombre"]').oninput = (e) => (g.nombre = e.target.value);
      cuadro.querySelector('[data-f="quitar-grupo"]').onclick = () => {
        grupos = grupos.filter((x) => x !== g);
        pintar();
      };
      cuadro.querySelectorAll('[data-f="incluir"]').forEach((c) => {
        c.onchange = () => {
          c.checked ? g.incluidos.add(c.dataset.id) : g.incluidos.delete(c.dataset.id);
          if (!g.incluidos.has(g.canonId)) g.canonId = [...g.incluidos][0] || g.canonId;
          pintarAcciones();
        };
      });
      cuadro.querySelectorAll('[data-f="canon"]').forEach((r) => {
        r.onchange = () => {
          g.canonId = r.dataset.id;
          g.incluidos.add(g.canonId);
          pintar();
        };
      });
    });
    pintarManual();
    pintarAcciones();
  }

  function pintarManual() {
    const cont = el("#un-manual");
    cont.innerHTML = `
      <details class="border border-slate-200 rounded-md">
        <summary class="px-3 py-2 text-sm font-semibold cursor-pointer">Unir insumos a mano (los que el sistema no detectó)</summary>
        <div class="p-3">
          <input type="text" id="un-manual-buscar" class="form-input input-search mb-2" placeholder="Busque por nombre y marque los insumos que son el mismo producto..." autocomplete="off" />
          <div id="un-manual-lista" class="max-h-64 overflow-y-auto border border-slate-100 rounded-md"></div>
          <button type="button" id="un-manual-crear" class="btn-secondary mt-2">Crear grupo con los marcados</button>
        </div>
      </details>`;
    const marcados = new Set();
    const lista = cont.querySelector("#un-manual-lista");
    const listar = () => {
      const q = normalizarBusqueda(cont.querySelector("#un-manual-buscar").value).split(/\s+/).filter(Boolean);
      const items = catalogo()
        .filter((i) => marcados.has(i.id) || (q.length && q.every((t) => normalizarBusqueda(i.nombre).includes(t))))
        .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
        .slice(0, 60);
      lista.innerHTML = items.length
        ? items.map((i) => `<label class="flex items-center gap-2 px-2 py-1 text-xs border-b border-slate-50"><input type="checkbox" data-id="${i.id}" ${marcados.has(i.id) ? "checked" : ""} /> <span class="font-medium">${escapeHTML(i.nombre)}</span> <span class="text-slate-400">${escapeHTML(resumenStock(i.id))}</span></label>`).join("")
        : `<p class="p-2 text-xs text-slate-400">Escriba para buscar.</p>`;
      lista.querySelectorAll("input").forEach((c) => (c.onchange = () => (c.checked ? marcados.add(c.dataset.id) : marcados.delete(c.dataset.id))));
    };
    cont.querySelector("#un-manual-buscar").oninput = listar;
    listar();
    cont.querySelector("#un-manual-crear").onclick = () => {
      if (marcados.size < 2) return toast("Marque al menos 2 insumos para unir.", "warning");
      const miembros = [...marcados].map(porId).filter(Boolean);
      const mejor = [...miembros].sort((a, b) => movimientosDe(b.id) - movimientosDe(a.id))[0];
      grupos.unshift({ id: ++contador, tipo: "exacto", miembros: miembros.map((m) => m.id), incluidos: new Set(miembros.map((m) => m.id)), canonId: mejor.id, nombre: nombreSugerido(miembros), aplicar: true });
      pintar();
    };
  }

  const gruposAplicables = () =>
    grupos
      .filter((g) => g.aplicar && g.incluidos.size > 1 && g.nombre.trim())
      .map((g) => ({ canonId: g.canonId, miembros: [...g.incluidos], nombre: g.nombre }));

  function pintarAcciones() {
    const sel = gruposAplicables();
    const cont = el("#un-acciones");
    if (!grupos.length) {
      cont.innerHTML = "";
      return;
    }
    const quitaran = sel.reduce((a, g) => a + g.miembros.length - 1, 0);
    cont.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3">
        <p class="text-sm text-slate-600">${sel.length} grupo(s) marcado(s): quedarán ${sel.length} insumo(s) y se eliminarán ${quitaran} duplicado(s).</p>
        <div class="flex gap-2">
          <button type="button" id="un-respaldo" class="btn-secondary">Descargar respaldo</button>
          <button type="button" id="un-aplicar" class="btn-primary" ${sel.length ? "" : "disabled"}>Unificar grupos marcados</button>
        </div>
      </div>`;
    cont.querySelector("#un-respaldo").onclick = descargarRespaldo;
    cont.querySelector("#un-aplicar").onclick = aplicar;
  }

  async function aplicar() {
    if (!isAdmin()) return toast("Solo un administrador puede unificar insumos.", "error");
    const sel = gruposAplicables();
    if (!sel.length) return;
    const { ops, existenciasMovidas, registrosReapuntados } = construirOperaciones(sel);
    const ok = await confirmDialog({
      title: "Unificar insumos",
      message: `Se unirán ${sel.length} grupo(s): se eliminarán ${sel.reduce((a, g) => a + g.miembros.length - 1, 0)} insumo duplicado(s), se sumarán sus existencias (${existenciasMovidas} unidades en total) y se corregirán ${registrosReapuntados} registro(s) antiguos. <strong>No se puede deshacer</strong> (se descargará un respaldo). ¿Continuar?`,
      confirmText: "Unificar",
    });
    if (!ok) return;
    const boton = el("#un-aplicar");
    boton.disabled = true;
    boton.textContent = "Unificando...";
    try {
      descargarRespaldo();
      await ejecutar(ops);
      toast(`Listo: ${sel.length} grupo(s) unificado(s).`, "success");
      grupos = [];
      el("#un-grupos").innerHTML = "";
      el("#un-acciones").innerHTML = "";
      setTimeout(buscar, 1200); // las listas se refrescan solas desde Firebase; se vuelve a analizar
    } catch (err) {
      console.error(err);
      toast(`Se interrumpió la unificación: ${err.message || err}. Pulse "Buscar duplicados" para ver qué quedó pendiente y repita.`, "error");
      boton.disabled = false;
      boton.textContent = "Unificar grupos marcados";
    }
  }

  el("#un-buscar").onclick = () => {
    if (!getInsumos().length) return toast("El catálogo todavía está cargando. Intente de nuevo en un momento.", "warning");
    buscar();
  };
  void ALMACENES;
}
