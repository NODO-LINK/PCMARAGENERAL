/**
 * despachoRapido.js
 * -----------------------------------------------------------------------
 * "Despacho rápido" (Inventario → Transferencias): arma la transferencia
 * diaria de insumos hacia el Módulo de Emergencia sin escribirla a mano.
 *
 *  - Pegar o COMPARTIR desde WhatsApp el mensaje del despacho (ej. "20
 *    gasas, 5 guantes, suero x3"): se interpreta y se muestra una vista
 *    previa; nada se descuenta hasta confirmar.
 *  - "Repetir el último despacho": copia el del día anterior.
 *  - Por defecto sale de Oficina; si Oficina no alcanza para una línea y
 *    Depósito sí, se propone Depósito (y se avisa).
 *  - Registra con la misma función del formulario de Transferencias
 *    (registrarTransferencia), o sea con las mismas validaciones de
 *    existencia y el mismo historial.
 *
 * El texto compartido llega por la URL (?title=&text=&url=) gracias al
 * "share_target" de manifest.json: solo funciona con la app INSTALADA en el
 * teléfono (Agregar a pantalla de inicio).
 * -----------------------------------------------------------------------
 */
import { ALMACENES } from "./config.js";
import { getInsumos, getStock, getTransferencias, registrarTransferencia } from "./inventario.js";
import { getResponsableLabel, puedeVerVista } from "./auth.js";
import { navigateTo } from "./router.js";
import { toast, escapeHTML, toDate } from "./ui.js";
import { normalizarBusqueda } from "./busqueda.js";

const DESTINO_POR_DEFECTO = "Módulo";
const ORIGEN_POR_DEFECTO = "Oficina";

/* ------------------------------- Intérprete ------------------------------ */

// Palabras que no identifican a un insumo (ni a un almacén).
const PALABRAS_VACIAS = new Set([
  "despacho", "despachado", "despachados", "despachar", "modulo", "emergencia", "emergencias", "hoy", "ayer", "de", "del", "la", "el", "los", "las",
  "para", "al", "a", "y", "se", "con", "en", "un", "una", "unidad", "unidades", "und", "unds", "unid", "uds", "ud", "pza", "pzas", "pieza", "piezas",
  "entrega", "entregue", "entregamos", "salio", "salieron", "salida", "envio", "enviado", "enviados", "total", "insumos", "insumo", "favor", "buenos", "dias",
  "buenas", "tardes", "noches", "saludos", "gracias", "x",
]);

const singular = (t) => (t.length > 4 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
const tokensDe = (texto) =>
  normalizarBusqueda(texto)
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Quita lo que WhatsApp agrega al copiar un mensaje: "[10:32, 3/11/2026] Nombre:" y marcas de formato. */
function limpiarMensaje(texto) {
  return String(texto ?? "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}[,\s]+\d{1,2}:\d{2}[^\]\-:]*[\]\-]\s*[^:]{1,40}:\s*/, "")
        .replace(/^\s*\[\d{1,2}:\d{2}[^\]]*\]\s*[^:]{1,40}:\s*/, "")
        .replace(/[*_~`•✅✔️☑️▪️●]/g, " ")
        .replace(/^\s*[-–—]\s+/, "")
    )
    .join("\n");
}

function puntuar(tokensLinea, insumo) {
  const tokensInsumo = tokensDe(insumo.nombre).map(singular);
  if (!tokensLinea.length || !tokensInsumo.length) return 0;
  let aciertos = 0;
  tokensLinea.forEach((t) => {
    const s = singular(t);
    if (tokensInsumo.some((i) => i === s || (s.length >= 3 && (i.startsWith(s) || s.startsWith(i))))) aciertos++;
  });
  return aciertos / tokensLinea.length;
}

/**
 * Interpreta el texto y devuelve las líneas del despacho:
 * [{ original, cantidad (número o null), insumoId (o null), origen (o null), dudoso }]
 */
export function interpretarDespacho(texto, insumosCatalogo) {
  const activos = insumosCatalogo.filter((i) => i.activo !== false);
  const fragmentos = limpiarMensaje(texto)
    .split(/\n|;|,\s|\sy\s/i)
    .map((f) => f.trim())
    .filter(Boolean);
  const lineas = [];
  let origenGlobal = null;

  fragmentos.forEach((frag) => {
    const norm = normalizarBusqueda(frag);
    let origen = null;
    if (/\boficina\b/.test(norm)) origen = "Oficina";
    else if (/\bdeposito\b/.test(norm)) origen = "Depósito";

    // cantidad: "20 gasas", "gasas x20", "gasas: 20", "gasas 20 und"
    const m = norm.match(/(?:^|[\sx:])(\d+(?:[.,]\d+)?)(?=\s|$|[a-z])/);
    const cantidad = m ? Number(m[1].replace(",", ".")) : null;
    const tokens = tokensDe(frag.replace(/\d+(?:[.,]\d+)?/g, " ")).filter((t) => !PALABRAS_VACIAS.has(t) && t !== "oficina" && t !== "deposito");

    if (!tokens.length) {
      // línea de encabezado tipo "de oficina": define el origen de todo el despacho
      if (origen) origenGlobal = origen;
      return;
    }
    let mejor = null;
    let mejorPuntaje = 0;
    activos.forEach((i) => {
      const p = puntuar(tokens, i);
      if (p > mejorPuntaje || (p === mejorPuntaje && p > 0 && mejor && i.nombre.length < mejor.nombre.length)) {
        mejor = i;
        mejorPuntaje = p;
      }
    });
    const acepta = mejor && mejorPuntaje >= 0.5;
    lineas.push({ original: frag, cantidad, insumoId: acepta ? mejor.id : null, origen, dudoso: !acepta || mejorPuntaje < 1 });
  });
  if (origenGlobal) lineas.forEach((l) => (l.origen = l.origen || origenGlobal));
  return lineas;
}

/* --------------------------- Datos de apoyo ------------------------------ */

const existenciaDe = (insumoId, almacen) => Number(getStock().find((s) => s.insumoId === insumoId && s.almacen === almacen)?.existencia) || 0;

/** Origen sugerido: el indicado, si no Oficina; si no alcanza y Depósito sí, Depósito. */
function origenSugerido(linea) {
  const base = linea.origen || ORIGEN_POR_DEFECTO;
  if (!linea.insumoId || !linea.cantidad) return { origen: base, nota: "" };
  if (existenciaDe(linea.insumoId, base) >= linea.cantidad) return { origen: base, nota: "" };
  if (!linea.origen) {
    const otro = ALMACENES.find((a) => a === "Depósito");
    if (otro && existenciaDe(linea.insumoId, otro) >= linea.cantidad) return { origen: otro, nota: `${base} no alcanza; se propone ${otro}` };
  }
  return { origen: base, nota: "" };
}

/** Líneas del último despacho al destino hecho ANTES de hoy. */
function lineasDelUltimoDespacho(destino) {
  const hoy = new Date().toLocaleDateString("en-CA");
  const porDia = new Map();
  getTransferencias()
    .filter((t) => t.stockDestino === destino)
    .forEach((t) => {
      const d = toDate(t.fecha);
      if (!d) return;
      const k = d.toLocaleDateString("en-CA");
      if (k >= hoy) return;
      if (!porDia.has(k)) porDia.set(k, []);
      porDia.get(k).push(t);
    });
  if (!porDia.size) return { fecha: null, lineas: [] };
  const dia = [...porDia.keys()].sort().pop();
  const agrupadas = new Map();
  porDia.get(dia).forEach((t) => {
    const k = `${t.insumoId}__${t.stockOrigen}`;
    const previa = agrupadas.get(k);
    if (previa) previa.cantidad += Number(t.cantidad) || 0;
    else agrupadas.set(k, { original: t.insumoNombre, cantidad: Number(t.cantidad) || 0, insumoId: t.insumoId, origen: t.stockOrigen, dudoso: false });
  });
  return { fecha: dia, lineas: [...agrupadas.values()] };
}

/* ---------------------------------- UI ----------------------------------- */

let lineas = []; // [{ original, cantidad, insumoId, origen, dudoso, nota }]

export function initDespachoRapido() {
  const raiz = document.getElementById("despacho-rapido");
  if (!raiz) return;
  const opcionesAlmacen = (sel) => ALMACENES.map((a) => `<option value="${escapeHTML(a)}" ${a === sel ? "selected" : ""}>${escapeHTML(a)}</option>`).join("");

  raiz.innerHTML = `
    <div class="form-card">
      <h3 class="font-semibold text-slate-700 mb-1">Despacho rápido</h3>
      <p class="text-xs text-slate-500 mb-3 max-w-3xl">
        Pegue aquí el mensaje del despacho (por ejemplo copiado de WhatsApp: "20 gasas, 5 guantes, suero x3") o repita el último. Se muestra una vista previa y
        <strong>no se descuenta nada hasta que confirme</strong>. Sale de Oficina; si Oficina no alcanza y Depósito sí, se propone Depósito.
      </p>
      <textarea id="dr-texto" rows="4" class="form-input" placeholder="Pegue el mensaje del despacho aquí..."></textarea>
      <div class="flex flex-wrap gap-2 mt-2">
        <button type="button" id="dr-interpretar" class="btn-primary">Interpretar mensaje</button>
        <button type="button" id="dr-repetir" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Repetir el último despacho</button>
        <button type="button" id="dr-limpiar" class="px-4 py-2 text-sm rounded-md text-slate-500 hover:underline">Limpiar</button>
      </div>
      <div id="dr-aviso" class="text-xs text-slate-500 mt-2"></div>
      <div id="dr-vista" class="mt-3"></div>
    </div>`;

  const el = (id) => raiz.querySelector(id);
  const aviso = (t) => (el("#dr-aviso").textContent = t || "");
  const hoy = () => new Date().toLocaleDateString("en-CA");

  function pintar(infoFecha) {
    const vista = el("#dr-vista");
    if (!lineas.length) {
      vista.innerHTML = "";
      return;
    }
    const activos = getInsumos().filter((i) => i.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const opcionesInsumo = (sel) => `<option value="">— elegir insumo —</option>` + activos.map((i) => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${escapeHTML(i.nombre)}</option>`).join("");
    vista.innerHTML = `
      <div class="grid gap-3 md:grid-cols-4 mb-3">
        <div><label class="form-label">Fecha</label><input id="dr-fecha" type="date" class="form-input" value="${hoy()}" /></div>
        <div><label class="form-label">Destino</label><select id="dr-destino" class="form-input">${opcionesAlmacen(DESTINO_POR_DEFECTO)}</select></div>
        <div class="md:col-span-2"><label class="form-label">Responsable</label><input id="dr-responsable" type="text" class="form-input" value="${escapeHTML(getResponsableLabel())}" /></div>
      </div>
      ${infoFecha ? `<p class="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-md p-2 mb-2">${escapeHTML(infoFecha)}</p>` : ""}
      <div class="overflow-x-auto border border-slate-200 rounded-md">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50 text-slate-600"><tr>
            <th class="text-left px-2 py-1.5">Texto original</th><th class="text-left px-2 py-1.5">Insumo</th><th class="text-left px-2 py-1.5 w-24">Cantidad</th>
            <th class="text-left px-2 py-1.5">Sale de</th><th class="text-left px-2 py-1.5">Disponible</th><th class="px-2 py-1.5"></th>
          </tr></thead>
          <tbody>
            ${lineas
              .map((l, i) => {
                const disp = l.insumoId ? ALMACENES.filter((a) => existenciaDe(l.insumoId, a) > 0).map((a) => `${a}: ${existenciaDe(l.insumoId, a)}`).join(" · ") || "sin existencia" : "—";
                const falta = l.insumoId && l.cantidad && existenciaDe(l.insumoId, l.origen) < l.cantidad;
                return `<tr class="border-t border-slate-100 ${l.dudoso && !l.insumoId ? "bg-red-50" : l.dudoso ? "bg-amber-50" : ""}" data-i="${i}">
                  <td class="px-2 py-1.5 text-xs text-slate-500 max-w-[10rem] truncate" title="${escapeHTML(l.original)}">${escapeHTML(l.original)}</td>
                  <td class="px-2 py-1.5"><select data-campo="insumo" class="form-input !py-1 min-w-[12rem]">${opcionesInsumo(l.insumoId)}</select></td>
                  <td class="px-2 py-1.5"><input data-campo="cantidad" type="number" min="0" step="any" class="form-input !py-1" value="${l.cantidad ?? ""}" /></td>
                  <td class="px-2 py-1.5"><select data-campo="origen" class="form-input !py-1">${opcionesAlmacen(l.origen)}</select>${l.nota ? `<div class="text-[11px] text-amber-700">${escapeHTML(l.nota)}</div>` : ""}</td>
                  <td class="px-2 py-1.5 text-xs ${falta ? "text-red-700 font-semibold" : "text-slate-500"}">${escapeHTML(disp)}${falta ? " — no alcanza" : ""}</td>
                  <td class="px-2 py-1.5"><button type="button" data-campo="quitar" class="text-red-700 hover:underline text-xs">Quitar</button></td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 mt-3">
        <p class="text-xs text-slate-500">Revise las filas en amarillo (coincidencia dudosa) o rojo (sin insumo) antes de confirmar.</p>
        <button type="button" id="dr-confirmar" class="btn-primary">Registrar despacho (${lineas.length})</button>
      </div>`;

    vista.querySelectorAll("tr[data-i]").forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('[data-campo="insumo"]').onchange = (e) => {
        lineas[i].insumoId = e.target.value || null;
        lineas[i].dudoso = false;
        Object.assign(lineas[i], { origen: lineas[i].origen || ORIGEN_POR_DEFECTO });
        pintar(infoFecha);
      };
      tr.querySelector('[data-campo="cantidad"]').onchange = (e) => {
        lineas[i].cantidad = e.target.value === "" ? null : Number(e.target.value);
        pintar(infoFecha);
      };
      tr.querySelector('[data-campo="origen"]').onchange = (e) => {
        lineas[i].origen = e.target.value;
        lineas[i].nota = "";
        pintar(infoFecha);
      };
      tr.querySelector('[data-campo="quitar"]').onclick = () => {
        lineas.splice(i, 1);
        pintar(infoFecha);
      };
    });
    el("#dr-confirmar").onclick = confirmar;
  }

  async function confirmar() {
    const fecha = el("#dr-fecha").value;
    const destino = el("#dr-destino").value;
    const responsable = el("#dr-responsable").value.trim();
    if (!fecha || !responsable) {
      toast("Complete la fecha y el responsable.", "error");
      return;
    }
    const invalidas = lineas.filter((l) => !l.insumoId || !l.cantidad || l.cantidad <= 0);
    if (invalidas.length) {
      toast(`Hay ${invalidas.length} fila(s) sin insumo o sin cantidad. Corríjalas o quítelas.`, "error");
      return;
    }
    if (lineas.some((l) => l.origen === destino)) {
      toast("El almacén de origen y el destino no pueden ser el mismo.", "error");
      return;
    }
    const boton = el("#dr-confirmar");
    boton.disabled = true;
    boton.textContent = "Registrando...";
    const pendientes = [];
    let hechas = 0;
    for (const l of lineas) {
      const insumo = getInsumos().find((i) => i.id === l.insumoId);
      try {
        await registrarTransferencia({ insumoId: l.insumoId, insumoNombre: insumo?.nombre || l.original, origen: l.origen, destino, cantidad: l.cantidad, responsable, fecha });
        hechas++;
      } catch (err) {
        console.error(err);
        pendientes.push({ ...l, nota: err.message || "No se pudo registrar" });
      }
    }
    lineas = pendientes;
    if (pendientes.length) {
      toast(`${hechas} registrada(s); ${pendientes.length} con error (siguen en la lista, vea el detalle).`, "error");
      aviso(pendientes.map((p) => `${p.original}: ${p.nota}`).join(" | "));
      pintar();
    } else {
      toast(`Despacho registrado: ${hechas} transferencia(s) a ${destino}.`, "success");
      el("#dr-texto").value = "";
      aviso("");
      pintar();
    }
  }

  function interpretar(texto) {
    if (!getInsumos().length) {
      toast("El catálogo de insumos todavía está cargando. Intente de nuevo en un momento.", "warning");
      return;
    }
    lineas = interpretarDespacho(texto, getInsumos()).map((l) => ({ ...l, ...origenSugeridoPara(l) }));
    aviso(lineas.length ? `${lineas.length} línea(s) interpretada(s). Revise antes de registrar.` : "No se reconoció ningún insumo en el texto. Escriba, por ejemplo: 20 gasas, 5 guantes.");
    pintar();
  }
  const origenSugeridoPara = (l) => {
    const { origen, nota } = origenSugerido(l);
    return { origen, nota };
  };

  el("#dr-interpretar").onclick = () => interpretar(el("#dr-texto").value);
  el("#dr-limpiar").onclick = () => {
    lineas = [];
    el("#dr-texto").value = "";
    aviso("");
    pintar();
  };
  el("#dr-repetir").onclick = () => {
    const { fecha, lineas: previas } = lineasDelUltimoDespacho(DESTINO_POR_DEFECTO);
    if (!previas.length) {
      toast(`No hay un despacho anterior al ${DESTINO_POR_DEFECTO} para repetir.`, "warning");
      return;
    }
    lineas = previas.map((l) => ({ ...l, ...origenSugeridoPara(l) }));
    aviso("");
    pintar(`Basado en el despacho del ${fecha.split("-").reverse().join("/")}. Ajuste cantidades si hoy son otras.`);
  };

  // ¿Llegó texto compartido desde WhatsApp? (ver share_target en manifest.json)
  const params = new URLSearchParams(window.location.search);
  const compartido = ["title", "text", "url"].map((k) => params.get(k)).filter(Boolean).join("\n").trim();
  if (compartido) {
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    if (!puedeVerVista("inventario")) {
      toast("Su usuario no tiene acceso a Inventario, no se puede registrar el despacho compartido.", "error");
      return;
    }
    let intentos = 0;
    const abrir = () => {
      if (!getInsumos().length && intentos++ < 40) return setTimeout(abrir, 250);
      navigateTo("inventario");
      setTimeout(() => {
        document.querySelector('#view-inventario .subtab-btn[data-subtab="transferencias"]')?.click();
        el("#dr-texto").value = compartido;
        interpretar(compartido);
        raiz.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    };
    setTimeout(abrir, 500);
  }
}
