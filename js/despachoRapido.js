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
import { ALMACENES, INSTITUCION } from "./config.js";
import { getInsumos, getStock, getTransferencias, registrarTransferencia } from "./inventario.js";
import { getResponsableLabel, puedeVerVista } from "./auth.js";
import { navigateTo } from "./router.js";
import { toast, escapeHTML, toDate, printAdHoc } from "./ui.js";
import { normalizarBusqueda } from "./busqueda.js";
import { montarLotes } from "./lotesRapidos.js";

const DESTINO_POR_DEFECTO = "Módulo";
const ORIGEN_POR_DEFECTO = "Oficina";
const ORIGENES = ["Oficina", "Depósito"]; // el despacho solo sale de estos almacenes

/* ------------------------------- Intérprete ------------------------------ */

// Palabras que no identifican a un insumo (ni a un almacén).
const PALABRAS_VACIAS = new Set([
  "despacho", "despachado", "despachados", "despachar", "modulo", "emergencia", "emergencias", "hoy", "ayer", "de", "del", "la", "el", "los", "las",
  "para", "al", "a", "y", "se", "con", "en", "un", "una", "unidad", "unidades", "und", "unds", "unid", "uds", "ud", "pza", "pzas", "pieza", "piezas",
  "entrega", "entregue", "entregamos", "salio", "salieron", "salida", "envio", "enviado", "enviados", "total", "insumos", "insumo", "favor", "buenos", "dias",
  "buenas", "tardes", "noches", "saludos", "gracias", "x", "par", "pares", "no", "n",
]);

const singular = (t) => (t.length > 4 && t.endsWith("es") ? t.slice(0, -2) : t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
const tokensDe = (texto) =>
  normalizarBusqueda(texto)
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/(\d)(?=[a-zñ])/g, "$1 ")
    .replace(/([a-zñ])(?=\d)/g, "$1 ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === "cc" || t === "mililitros" || t === "mililitro" ? "ml" : t));

// Distancia de edición (para tolerar errores de tipeo: "fernobarbital" ≈ "fenobarbital").
function distancia(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const parecidas = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && distancia(a, b) <= 2);

// Líneas "Etiqueta: valor" de las plantillas (Responsable, Turno, Observaciones...): no son insumos.
const ETIQUETAS = new Set([
  "responsable", "solicitado por", "solicita", "pedido por", "registrado por", "registro", "despachado por", "despacho", "recibido por", "recibe", "entregado por",
  "turno", "fecha", "hora", "guardia", "unidad", "servicio", "observaciones", "observacion", "obs", "nota", "notas", "destino", "motivo", "almacen", "jefe de modulo", "entrega",
]);
const esLineaEtiqueta = (linea) => {
  const m = normalizarBusqueda(linea).match(/^\s*([a-z ]{2,25}?)\s*:/);
  return !!m && ETIQUETAS.has(m[1].trim());
};

/**
 * Lee las líneas "Etiqueta: valor" del mensaje (Responsable, Turno, Observaciones...)
 * para usarlas al registrar. Devuelve solo las que tienen valor escrito.
 */
export function extraerDatos(texto) {
  const claves = {
    "despachado por": "despachadoPor", "entregado por": "despachadoPor", "solicitado por": "solicitadoPor", "solicita": "solicitadoPor", "pedido por": "solicitadoPor",
    "recibido por": "recibidoPor", "recibe": "recibidoPor", "responsable": "responsable", "registrado por": "responsable", "registro": "responsable",
    "turno": "turno", "unidad": "unidad", "servicio": "servicio", "observaciones": "observaciones", "observacion": "observaciones", "obs": "observaciones", "nota": "observaciones", "notas": "observaciones",
  };
  const datos = {};
  limpiarMensaje(texto).split("\n").forEach((linea) => {
    const m = linea.match(/^\s*([^:]{2,25}?)\s*:\s*(.*)$/);
    if (!m) return;
    const clave = claves[normalizarBusqueda(m[1]).trim()];
    const valor = m[2].replace(/[_]+/g, "").trim();
    if (clave && valor) datos[clave] = valor;
  });
  return datos;
}

/** Quita lo que WhatsApp agrega al copiar un mensaje: "[10:32, 3/11/2026] Nombre:" y marcas de formato. */
function limpiarMensaje(texto) {
  return String(texto ?? "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}[,\s]+\d{1,2}:\d{2}[^\]\-:]*[\]\-]\s*[^:]{1,40}:\s*/, "")
        .replace(/^\s*\[\d{1,2}:\d{2}[^\]]*\]\s*[^:]{1,40}:\s*/, "")
        .replace(/[*_~`•✅✔️☑️▪️●]/g, " ")
        .replace(/^\s*[(\[]\s*(\d+(?:[.,]\d+)?)\s*[)\]]\s*/, "$1 ") // "(04) lancetas" → "04 lancetas"
        .replace(/[(\[]\s*(\d+(?:[.,]\d+)?)\s*[)\]]/g, " $1 ") // "lancetas (04)" → "lancetas 04"
        .replace(/^\s*(\d+(?:[.,]\d+)?)\s*[).\-–:]\s+/, "$1 ") // "04) lancetas", "04. lancetas", "04 - lancetas"
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
    const esNumero = /^\d+$/.test(s);
    if (tokensInsumo.some((i) => i === s || (!esNumero && ((s.length >= 2 && !/^\d/.test(i) && (i.startsWith(s) || (i.length >= 3 && s.startsWith(i)))) || parecidas(s, i))))) aciertos++;
  });
  return aciertos / tokensLinea.length;
}

/**
 * Interpreta el texto y devuelve las líneas del despacho:
 * [{ original, cantidad (número o null), insumoId (o null), origen (o null), dudoso }]
 */
export const claveAlias = (tokens) => [...new Set(tokens.map(singular))].sort().join(" ");

export function interpretarDespacho(texto, insumosCatalogo, alias = {}) {
  const activos = insumosCatalogo.filter((i) => i.activo !== false);
  const fragmentos = limpiarMensaje(texto)
    .split("\n")
    .filter((l) => !esLineaEtiqueta(l))
    .join("\n")
    .replace(/,\s*(\d+(?:[.,]\d+)?)\s*(?=$|\n|;)/gm, " $1") // "lancetas, 4" → "lancetas 4"
    .split(/\n|;|,\s|\sy\s/i)
    .map((f) => f.trim())
    .filter(Boolean);
  const lineas = [];
  let origenGlobal = null;

  fragmentos.forEach((frag) => {
    const norm = normalizarBusqueda(frag);
    // Encabezados con fecha ("DESPACHO AL MÓDULO – 02/11/2026") no son insumos.
    if (/\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/.test(frag)) return;
    let origen = null;
    if (/\boficina\b/.test(norm)) origen = "Oficina";
    else if (/\bdeposito\b/.test(norm)) origen = "Depósito";

    // cantidad: al inicio ("02 jeringas"), "x20", o el último número ("gasas 20"). Los demás
    // números forman parte del nombre (medidas: "yelco 18", "jeringa 10ml").
    let cantidad = null;
    let resto = frag;
    const lider = frag.match(/^\s*(\d+(?:[.,]\d+)?)(?![\d.,]*\s*(?:ml|cc|mg|gr?|%|mm|cm|lt?)\b)\s*(.*)$/i);
    const conX = !lider && norm.match(/(?:^|\s)x\s*(\d+(?:[.,]\d+)?)\b|\b(\d+(?:[.,]\d+)?)\s*x(?:\s|$)/);
    if (lider) {
      cantidad = Number(lider[1].replace(",", "."));
      resto = lider[2];
    } else if (conX) {
      cantidad = Number((conX[1] || conX[2]).replace(",", "."));
      resto = frag.replace(/\bx\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*x\b/i, " ");
    } else {
      const todos = [...norm.matchAll(/(?:^|[\s:])(\d+(?:[.,]\d+)?)(?=\s|$)/g)];
      const ult = todos.length ? todos[todos.length - 1] : null;
      if (ult) {
        cantidad = Number(ult[1].replace(",", "."));
        const pos = frag.lastIndexOf(ult[1]);
        resto = pos >= 0 ? frag.slice(0, pos) + " " + frag.slice(pos + ult[1].length) : frag;
      }
    }
    // Cantidad 0 = "no se usó / no se despachó" (así se llenan las plantillas): se omite.
    if (cantidad === 0) return;
    const tokens = tokensDe(resto).filter((t) => !PALABRAS_VACIAS.has(t) && t !== "oficina" && t !== "deposito");

    if (!tokens.length) {
      // línea de encabezado tipo "de oficina": define el origen de todo el despacho
      if (origen) origenGlobal = origen;
      return;
    }
    const clave = claveAlias(tokens);
    const aprendido = alias[clave] && activos.find((i) => i.id === alias[clave]);
    if (aprendido) {
      lineas.push({ original: frag, cantidad, insumoId: aprendido.id, origen, dudoso: false, clave, aprendido: true });
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
    lineas.push({ original: frag, cantidad, insumoId: acepta ? mejor.id : null, origen, dudoso: !acepta || mejorPuntaje < 1, clave });
  });
  if (origenGlobal) lineas.forEach((l) => (l.origen = l.origen || origenGlobal));
  return lineas;
}

/* ---------------- Equivalencias aprendidas (nombre informal → insumo) ---------------- */
// Se guardan en este navegador (no requieren cambios en las reglas de Firebase).
const CLAVE_ALIAS = "pc_despacho_alias";
export const leerAlias = () => {
  try {
    return JSON.parse(localStorage.getItem(CLAVE_ALIAS) || "{}") || {};
  } catch {
    return {};
  }
};
export const guardarAlias = (a) => {
  try {
    localStorage.setItem(CLAVE_ALIAS, JSON.stringify(a));
  } catch {
    /* sin almacenamiento: simplemente no se recuerda */
  }
};

/* --------------------------- Datos de apoyo ------------------------------ */

export const existenciaDe = (insumoId, almacen) => Number(getStock().find((s) => s.insumoId === insumoId && s.almacen === almacen)?.existencia) || 0;

/** Origen sugerido: el indicado, si no Oficina; si no alcanza y Depósito sí, Depósito. */
function origenSugerido(linea) {
  const base = linea.origen || ORIGEN_POR_DEFECTO;
  if (!linea.insumoId || !linea.cantidad) return { origen: base, nota: "" };
  if (existenciaDe(linea.insumoId, base) >= linea.cantidad) return { origen: base, nota: "" };
  if (!linea.origen) {
    const otro = "Depósito";
    if (otro && existenciaDe(linea.insumoId, otro) >= linea.cantidad) return { origen: otro, nota: `${base} no alcanza; se propone ${otro}` };
  }
  return { origen: base, nota: "" };
}

/** Líneas del último despacho al destino hecho ANTES de hoy. */
function lineasDelUltimoDespacho(destino, incluirHoy = false) {
  const hoy = new Date().toLocaleDateString("en-CA");
  const porDia = new Map();
  getTransferencias()
    .filter((t) => t.stockDestino === destino && ORIGENES.includes(t.stockOrigen))
    .forEach((t) => {
      const d = toDate(t.fecha);
      if (!d) return;
      const k = d.toLocaleDateString("en-CA");
      if (!incluirHoy && k >= hoy) return;
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
    else agrupadas.set(k, { original: t.insumoNombre, cantidad: Number(t.cantidad) || 0, insumoId: t.insumoId, origen: t.stockOrigen, dudoso: false, responsable: t.responsable });
  });
  return { fecha: dia, lineas: [...agrupadas.values()] };
}

/* ------------------------- Plantillas de mensaje ------------------------- */

/**
 * Arma el mensaje "para editar": los insumos que más se usan, con cantidad 00,
 * para que quien lo llena solo cambie los números (las líneas en 00 se
 * ignoran al interpretar). `filas` son transferencias/débitos recientes.
 */
export function plantillaMensaje({ titulo, campos = [], cierre = ["Observaciones:"], filas, almacenStock, maximo = 25 }) {
  const hoy = new Date().toLocaleDateString("en-CA");
  const cuenta = new Map();
  filas.forEach((f) => cuenta.set(f.insumoId, (cuenta.get(f.insumoId) || 0) + 1));
  const activos = new Map(getInsumos().filter((i) => i.activo !== false).map((i) => [i.id, i.nombre]));
  let ids = [...cuenta.entries()].filter(([id]) => activos.has(id)).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  if (ids.length < 8) {
    getStock()
      .filter((s) => s.almacen === almacenStock && Number(s.existencia) > 0 && activos.has(s.insumoId))
      .forEach((s) => !ids.includes(s.insumoId) && ids.push(s.insumoId));
  }
  if (!ids.length) [...activos.keys()].forEach((id) => ids.push(id)); // sin historial ni existencias: el catálogo
  const nombres = ids.slice(0, maximo).map((id) => activos.get(id)).sort((a, b) => a.localeCompare(b));
  return [`*${titulo}* – ${fechaLarga(hoy)}`, ...campos, ``, ...nombres.map((n) => `00 ${n}`), ``, ...cierre].join("\n");
}

/** Caja con la plantilla y botón para copiarla (se reutiliza en despacho y débito). */
export function mostrarPlantilla(cont, texto, ayuda) {
  cont.innerHTML = `
    <div class="border border-sky-200 bg-sky-50 rounded-md p-3">
      <div class="font-semibold text-sky-900 text-sm mb-1">Mensaje predeterminado para editar</div>
      <p class="text-xs text-sky-900 mb-2">${ayuda}</p>
      <textarea class="form-input font-mono text-xs" rows="${Math.min(18, texto.split("\n").length + 1)}">${escapeHTML(texto)}</textarea>
      <div class="flex flex-wrap gap-2 mt-2">
        <button type="button" data-p="copiar" class="btn-primary">Copiar mensaje</button>
        <button type="button" data-p="cerrar" class="px-4 py-2 text-sm rounded-md text-slate-500 hover:underline">Cerrar</button>
      </div>
    </div>`;
  const ta = cont.querySelector("textarea");
  cont.querySelector('[data-p="copiar"]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(ta.value);
    } catch {
      ta.select();
      document.execCommand("copy");
    }
    toast("Mensaje copiado. Péguelo en el grupo de WhatsApp (Ctrl+V).", "success");
  };
  cont.querySelector('[data-p="cerrar"]').onclick = () => (cont.innerHTML = "");
}

/* -------------------------------- Recibo --------------------------------- */

export const fechaLarga = (iso) => {
  const [y, m, d] = String(iso).split("-");
  return y && m && d ? `${d}/${m}/${y}` : String(iso);
};

/** Texto listo para pegar en WhatsApp (el *asterisco* da negrita allí). */
function textoRecibo({ fecha, destino, responsable, items, observaciones }) {
  const mezcla = new Set(items.map((i) => i.origen)).size > 1;
  const total = items.reduce((a, i) => a + i.cantidad, 0);
  return [
    `*RECIBO DE DESPACHO DE INSUMOS*`,
    `${INSTITUCION.nombre}`,
    ``,
    `📅 Fecha: ${fechaLarga(fecha)}`,
    `📦 Destino: ${destino}`,
    `👤 Despachó: ${responsable}`,
    ``,
    ...items.map((i) => `• ${i.cantidad} – ${i.nombre}${mezcla ? ` (${i.origen})` : ""}`),
    ``,
    `Total: ${items.length} insumo(s), ${total} unidad(es).`,
    ...(observaciones ? [`Obs.: ${observaciones}`] : []),
    `Favor confirmar recepción. ✅`,
  ].join("\n");
}

function imprimirRecibo(r) {
  const celda = "border:1px solid #94a3b8;padding:4px 8px;font-size:12px;";
  const cuerpo = `
    <div style="padding:12px 16px;font-size:13px;">
      <h2 style="text-align:center;font-size:16px;font-weight:800;margin:6px 0 12px;color:#0b2545;">RECIBO DE DESPACHO DE INSUMOS</h2>
      <p style="margin:2px 0;"><strong>Fecha:</strong> ${escapeHTML(fechaLarga(r.fecha))} &nbsp;&nbsp; <strong>Destino:</strong> ${escapeHTML(r.destino)} &nbsp;&nbsp; <strong>Despachó:</strong> ${escapeHTML(r.responsable)}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;">
        <thead><tr style="background:#f1f5f9;"><th style="${celda}text-align:left;">Insumo</th><th style="${celda}width:70px;">Cantidad</th><th style="${celda}width:90px;">Sale de</th></tr></thead>
        <tbody>${r.items.map((i) => `<tr><td style="${celda}">${escapeHTML(i.nombre)}</td><td style="${celda}text-align:center;">${i.cantidad}</td><td style="${celda}text-align:center;">${escapeHTML(i.origen)}</td></tr>`).join("")}</tbody>
      </table>
      <p style="margin-top:8px;font-size:12px;">Total: ${r.items.length} insumo(s), ${r.items.reduce((a, i) => a + i.cantidad, 0)} unidad(es).${r.observaciones ? ` Obs.: ${escapeHTML(r.observaciones)}` : ""}</p>
    </div>`;
  printAdHoc(`Recibo de despacho — ${fechaLarga(r.fecha)}`, cuerpo, ["Despachó", "Recibió"], 4);
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
        Copie el mensaje del despacho en WhatsApp Web/Escritorio (clic derecho → Copiar, o Ctrl+C) y pulse "Pegar del portapapeles e interpretar" (o pegue con Ctrl+V en la caja: se interpreta solo). También puede repetir el último. Se muestra una vista previa y
        <strong>no se descuenta nada hasta que confirme</strong>. Sale de Oficina; si Oficina no alcanza y Depósito sí, se propone Depósito.
      </p>
      <textarea id="dr-texto" rows="4" class="form-input" placeholder="Pegue el mensaje del despacho aquí..."></textarea>
      <div class="flex flex-wrap gap-2 mt-2">
        <button type="button" id="dr-pegar" class="btn-primary">Pegar del portapapeles e interpretar</button>
        <button type="button" id="dr-interpretar" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Interpretar texto</button>
        <button type="button" id="dr-repetir" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Repetir el último despacho</button>
        <button type="button" id="dr-plantilla" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Mensaje de pedido</button>
        <button type="button" id="dr-plantilla-despacho" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Mensaje de despacho</button>
        <button type="button" id="dr-ver-recibo" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Despachos anteriores</button>
        <button type="button" id="dr-limpiar" class="px-4 py-2 text-sm rounded-md text-slate-500 hover:underline">Limpiar</button>
      </div>
      <div id="dr-aviso" class="text-xs text-slate-500 mt-2"></div>
      <div id="dr-plantilla-caja" class="mt-3"></div>
      <div id="dr-lotes" class="mt-3"></div>
      <div id="dr-recibo" class="mt-3"></div>
      <div id="dr-alias" class="mt-2"></div>
      <div id="dr-vista" class="mt-3"></div>
    </div>`;

  const el = (id) => raiz.querySelector(id);
  const aviso = (t) => (el("#dr-aviso").textContent = t || "");
  const hoy = () => new Date().toLocaleDateString("en-CA");
  // Lo escrito en el formulario se conserva al corregir filas (antes se reiniciaba).
  const form = { fecha: hoy(), destino: DESTINO_POR_DEFECTO, responsable: getResponsableLabel(), obs: "" };
  const obsDe = (d) => [d.observaciones, d.solicitadoPor && `Solicitó: ${d.solicitadoPor}`, d.recibidoPor && `Recibió: ${d.recibidoPor}`, d.turno && `Turno: ${d.turno}`].filter(Boolean).join(" · ");

  function pintar(infoFecha) {
    const vista = el("#dr-vista");
    if (!lineas.length) {
      vista.innerHTML = "";
      return;
    }
    const activos = getInsumos().filter((i) => i.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre));
    // Solo insumos con existencia en el almacén de origen de la fila (más el ya elegido).
    const opcionesInsumo = (sel, origen) => `<option value="">— elegir insumo —</option>` + activos.filter((i) => i.id === sel || existenciaDe(i.id, origen) > 0).map((i) => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${escapeHTML(i.nombre)}</option>`).join("");
    vista.innerHTML = `
      <div class="grid gap-3 md:grid-cols-4 mb-3">
        <div><label class="form-label">Fecha</label><input id="dr-fecha" type="date" class="form-input" value="${form.fecha}" /></div>
        <div><label class="form-label">Destino</label><select id="dr-destino" class="form-input">${opcionesAlmacen(form.destino)}</select></div>
        <div class="md:col-span-2"><label class="form-label">Responsable</label><input id="dr-responsable" type="text" class="form-input" value="${escapeHTML(form.responsable)}" /></div>
        <div class="md:col-span-4"><label class="form-label">Observaciones (opcional)</label><input id="dr-obs" type="text" class="form-input" value="${escapeHTML(form.obs)}" /></div>
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
                const disp = l.insumoId ? ORIGENES.map((a) => `${a}: ${existenciaDe(l.insumoId, a)}`).join(" · ") : "—";
                const falta = l.insumoId && l.cantidad && existenciaDe(l.insumoId, l.origen) < l.cantidad;
                return `<tr class="border-t border-slate-100 ${l.dudoso && !l.insumoId ? "bg-red-50" : l.dudoso ? "bg-amber-50" : ""}" data-i="${i}">
                  <td class="px-2 py-1.5 text-xs text-slate-500 max-w-[10rem] truncate" title="${escapeHTML(l.original)}">${escapeHTML(l.original)}</td>
                  <td class="px-2 py-1.5"><select data-campo="insumo" class="form-input !py-1 min-w-[12rem]">${opcionesInsumo(l.insumoId, l.origen)}</select></td>
                  <td class="px-2 py-1.5"><input data-campo="cantidad" type="number" min="0" step="any" class="form-input !py-1" value="${l.cantidad ?? ""}" /></td>
                  <td class="px-2 py-1.5"><select data-campo="origen" class="form-input !py-1">${ORIGENES.map((a) => `<option value="${escapeHTML(a)}" ${a === l.origen ? "selected" : ""}>${escapeHTML(a)}</option>`).join("")}</select>${l.nota ? `<div class="text-[11px] text-amber-700">${escapeHTML(l.nota)}</div>` : ""}</td>
                  <td class="px-2 py-1.5 text-xs ${falta ? "text-red-700 font-semibold" : "text-slate-500"}">${escapeHTML(disp)}${falta ? " — no alcanza" : ""}</td>
                  <td class="px-2 py-1.5"><button type="button" data-campo="quitar" class="text-red-700 hover:underline text-xs">Quitar</button></td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 mt-3">
        <p class="text-xs text-slate-500">Revise las filas en amarillo (coincidencia dudosa) o rojo (sin insumo) antes de confirmar. La lista de insumos de cada fila solo muestra los que tienen existencia en "Sale de": cambie el origen para ver los del otro almacén.</p>
        <button type="button" id="dr-confirmar" class="btn-primary">Registrar despacho (${lineas.length})</button>
      </div>`;

    el("#dr-fecha").oninput = (e) => (form.fecha = e.target.value);
    el("#dr-destino").onchange = (e) => (form.destino = e.target.value);
    el("#dr-responsable").oninput = (e) => (form.responsable = e.target.value);
    el("#dr-obs").oninput = (e) => (form.obs = e.target.value);
    vista.querySelectorAll("tr[data-i]").forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('[data-campo="insumo"]').onchange = (e) => {
        lineas[i].insumoId = e.target.value || null;
        lineas[i].dudoso = false;
        lineas[i].corregido = true;
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
    const observaciones = el("#dr-obs").value.trim();
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
    const registradas = [];
    const loteId = `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let hechas = 0;
    for (const l of lineas) {
      const insumo = getInsumos().find((i) => i.id === l.insumoId);
      try {
        await registrarTransferencia({ insumoId: l.insumoId, insumoNombre: insumo?.nombre || l.original, origen: l.origen, destino, cantidad: l.cantidad, responsable, fecha, observaciones, loteId });
        hechas++;
        registradas.push({ nombre: insumo?.nombre || l.original, cantidad: l.cantidad, origen: l.origen });
        if (l.clave && (l.corregido || l.dudoso)) {
          const a = leerAlias();
          a[l.clave] = l.insumoId;
          guardarAlias(a);
        }
      } catch (err) {
        console.error(err);
        pendientes.push({ ...l, nota: err.message || "No se pudo registrar" });
      }
    }
    pintarAlias();
    if (registradas.length) mostrarRecibo({ fecha, destino, responsable, observaciones, items: registradas });
    lineas = pendientes;
    if (pendientes.length) {
      toast(`${hechas} registrada(s); ${pendientes.length} con error (siguen en la lista, vea el detalle).`, "error");
      aviso(pendientes.map((p) => `${p.original}: ${p.nota}`).join(" | "));
      pintar();
    } else {
      toast(`Despacho registrado: ${hechas} transferencia(s) a ${destino}.`, "success");
      el("#dr-texto").value = "";
      aviso("");
      form.obs = "";
      pintar();
    }
  }

  function interpretar(texto) {
    if (!getInsumos().length) {
      toast("El catálogo de insumos todavía está cargando. Intente de nuevo en un momento.", "warning");
      return;
    }
    mostrarRecibo(null);
    const datos = extraerDatos(texto);
    if (datos.despachadoPor) form.responsable = datos.despachadoPor;
    form.obs = obsDe(datos);
    lineas = interpretarDespacho(texto, getInsumos(), leerAlias()).map((l) => ({ ...l, ...origenSugeridoPara(l) }));
    aviso(lineas.length ? `${lineas.length} línea(s) interpretada(s). Revise antes de registrar.` : "No se reconoció ningún insumo en el texto. Escriba, por ejemplo: 20 gasas, 5 guantes.");
    pintar();
  }
  const origenSugeridoPara = (l) => {
    const { origen, nota } = origenSugerido(l);
    return { origen, nota };
  };

  function mostrarRecibo(r) {
    const cont = el("#dr-recibo");
    if (!r) {
      cont.innerHTML = "";
      return;
    }
    cont.innerHTML = `
      <div class="border border-emerald-200 bg-emerald-50 rounded-md p-3">
        <div class="font-semibold text-emerald-900 text-sm mb-1">Recibo del despacho — listo para enviar al grupo</div>
        <textarea id="dr-recibo-texto" rows="${Math.min(16, r.items.length + 9)}" class="form-input font-mono text-xs" readonly>${escapeHTML(textoRecibo(r))}</textarea>
        <div class="flex flex-wrap gap-2 mt-2">
          <button type="button" id="dr-copiar" class="btn-primary">Copiar para WhatsApp</button>
          <button type="button" id="dr-imprimir" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 bg-white hover:bg-slate-50">Imprimir / guardar PDF</button>
          <button type="button" id="dr-cerrar-recibo" class="px-4 py-2 text-sm rounded-md text-slate-500 hover:underline">Cerrar</button>
        </div>
      </div>`;
    el("#dr-copiar").onclick = async () => {
      const ta = el("#dr-recibo-texto");
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch {
        ta.select();
        document.execCommand("copy");
      }
      toast("Recibo copiado. Péguelo en el grupo de WhatsApp (Ctrl+V).", "success");
    };
    el("#dr-imprimir").onclick = () => imprimirRecibo(r);
    el("#dr-cerrar-recibo").onclick = () => mostrarRecibo(null);
  }

  function pintarAlias() {
    const a = leerAlias();
    const claves = Object.keys(a);
    const cont = el("#dr-alias");
    if (!claves.length) {
      cont.innerHTML = "";
      return;
    }
    cont.innerHTML = `<details class="text-xs text-slate-600"><summary class="cursor-pointer">Equivalencias aprendidas (${claves.length}) — nombres que usted escribe y a qué insumo corresponden</summary>
      <ul class="mt-1 space-y-1">${claves
        .map((k) => `<li class="flex items-center gap-2"><span>"${escapeHTML(k)}" → <strong>${escapeHTML(getInsumos().find((i) => i.id === a[k])?.nombre || "(insumo eliminado)")}</strong></span><button type="button" data-k="${escapeHTML(k)}" class="text-red-700 hover:underline">Olvidar</button></li>`)
        .join("")}</ul></details>`;
    cont.querySelectorAll("button[data-k]").forEach((b) => {
      b.onclick = () => {
        const x = leerAlias();
        delete x[b.dataset.k];
        guardarAlias(x);
        pintarAlias();
      };
    });
  }
  pintarAlias();
  el("#dr-interpretar").onclick = () => interpretar(el("#dr-texto").value);
  el("#dr-texto").addEventListener("paste", () => setTimeout(() => interpretar(el("#dr-texto").value), 0));
  el("#dr-pegar").onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return toast("El portapapeles está vacío. Copie primero el mensaje de WhatsApp.", "warning");
      el("#dr-texto").value = t;
      interpretar(t);
    } catch {
      toast("El navegador no permitió leer el portapapeles. Pegue el texto en la caja con Ctrl+V.", "warning");
      el("#dr-texto").focus();
    }
  };
  el("#dr-ver-recibo").onclick = () => {
    mostrarRecibo(null);
    montarLotes(el("#dr-lotes"), "despacho", (g) => {
      const f = g.filas;
      mostrarRecibo({
        fecha: g.fecha,
        destino: f[0].stockDestino,
        responsable: g.responsable,
        observaciones: f.find((x) => x.observaciones)?.observaciones || "",
        items: f.map((x) => ({ nombre: x.insumoNombre, cantidad: Number(x.cantidad) || 0, origen: x.stockOrigen })),
      });
      el("#dr-recibo").scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  };
  const filasDespacho = () => getTransferencias().filter((t) => t.stockDestino === DESTINO_POR_DEFECTO && ORIGENES.includes(t.stockOrigen));
  el("#dr-plantilla").onclick = () => {
    const texto = plantillaMensaje({
      titulo: "PEDIDO DE INSUMOS – MÓDULO DE EMERGENCIA",
      campos: ["Solicitado por:", "Turno:"],
      filas: filasDespacho(),
      almacenStock: "Oficina",
    });
    mostrarPlantilla(el("#dr-plantilla-caja"), texto, "Lo usa el Módulo para <strong>pedir</strong> insumos: cambian los <strong>00</strong> por lo que necesitan y lo envían al grupo. Quien despacha copia el pedido, lo pega aquí (Pegar del portapapeles e interpretar) y lo registra. Las líneas en 00 y los datos de Solicitado por / Turno / Observaciones se ignoran.");
  };
  el("#dr-plantilla-despacho").onclick = () => {
    const texto = plantillaMensaje({
      titulo: "DESPACHO AL MÓDULO",
      campos: ["Despachado por:", "Recibido por:"],
      filas: filasDespacho(),
      almacenStock: "Oficina",
    });
    mostrarPlantilla(el("#dr-plantilla-caja"), texto, "Mensaje para <strong>informar</strong> lo despachado: cambian los 00 por las cantidades. Escriba \"de depósito\" al final de una línea si ese insumo salió de Depósito. Las líneas en 00 se ignoran.");
  };
  el("#dr-limpiar").onclick = () => {
    mostrarRecibo(null);
    lineas = [];
    el("#dr-texto").value = "";
    aviso("");
    pintar();
  };
  el("#dr-repetir").onclick = () => {
    mostrarRecibo(null);
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
