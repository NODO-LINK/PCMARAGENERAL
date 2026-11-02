/**
 * debitoRapido.js
 * -----------------------------------------------------------------------
 * "Débito rápido": descuenta del Módulo (o de la Ambulancia) los insumos
 * gastados, a partir de un mensaje de texto (p. ej. copiado de WhatsApp),
 * con vista previa y confirmación. Al registrar genera un recibo (texto para
 * WhatsApp + impresión). Usa el mismo intérprete y las mismas equivalencias
 * aprendidas que el Despacho rápido (js/despachoRapido.js).
 * -----------------------------------------------------------------------
 */
import { INSTITUCION, MOTIVOS_DEBITO_INVENTARIO } from "./config.js";
import { getInsumos, getDebitos, registrarDebito } from "./inventario.js";
import { getResponsableLabel } from "./auth.js";
import { toast, escapeHTML, toDate, printAdHoc } from "./ui.js";
import { interpretarDespacho, leerAlias, guardarAlias, fechaLarga, existenciaDe, plantillaMensaje, mostrarPlantilla } from "./despachoRapido.js";

const ALMACENES_DEBITO = ["Módulo", "Ambulancia"];
const MOTIVO_POR_DEFECTO = "Uso operativo / Consumo";

function textoRecibo(r) {
  const total = r.items.reduce((a, i) => a + i.cantidad, 0);
  return [
    `*REPORTE DE INSUMOS UTILIZADOS*`,
    `${INSTITUCION.nombre}`,
    ``,
    `📅 Fecha: ${fechaLarga(r.fecha)}`,
    `📦 Almacén: ${r.almacen}`,
    `📝 Motivo: ${r.motivo}`,
    `👤 Registró: ${r.responsable}`,
    ``,
    ...r.items.map((i) => `• ${i.cantidad} – ${i.nombre}`),
    ``,
    `Total: ${r.items.length} insumo(s), ${total} unidad(es) descontadas.`,
    ...(r.observaciones ? [`Obs.: ${r.observaciones}`] : []),
  ].join("\n");
}

function imprimirRecibo(r) {
  const celda = "border:1px solid #94a3b8;padding:4px 8px;font-size:12px;";
  const cuerpo = `
    <div style="padding:12px 16px;font-size:13px;">
      <h2 style="text-align:center;font-size:16px;font-weight:800;margin:6px 0 12px;color:#0b2545;">REPORTE DE INSUMOS UTILIZADOS</h2>
      <p style="margin:2px 0;"><strong>Fecha:</strong> ${escapeHTML(fechaLarga(r.fecha))} &nbsp;&nbsp; <strong>Almacén:</strong> ${escapeHTML(r.almacen)} &nbsp;&nbsp; <strong>Motivo:</strong> ${escapeHTML(r.motivo)}</p>
      <p style="margin:2px 0;"><strong>Registró:</strong> ${escapeHTML(r.responsable)}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:10px;">
        <thead><tr style="background:#f1f5f9;"><th style="${celda}text-align:left;">Insumo</th><th style="${celda}width:80px;">Cantidad</th></tr></thead>
        <tbody>${r.items.map((i) => `<tr><td style="${celda}">${escapeHTML(i.nombre)}</td><td style="${celda}text-align:center;">${i.cantidad}</td></tr>`).join("")}</tbody>
      </table>
      <p style="margin-top:8px;font-size:12px;">Total: ${r.items.length} insumo(s), ${r.items.reduce((a, i) => a + i.cantidad, 0)} unidad(es).${r.observaciones ? ` Obs.: ${escapeHTML(r.observaciones)}` : ""}</p>
    </div>`;
  printAdHoc(`Insumos utilizados — ${fechaLarga(r.fecha)}`, cuerpo, ["Responsable", "Director"], 4);
}

/** Último día con débitos en el almacén (incluye hoy). */
function ultimoDebito(almacen) {
  const porDia = new Map();
  getDebitos()
    .filter((d) => d.almacenOrigen === almacen)
    .forEach((d) => {
      const f = toDate(d.fecha);
      if (!f) return;
      const k = f.toLocaleDateString("en-CA");
      if (!porDia.has(k)) porDia.set(k, []);
      porDia.get(k).push(d);
    });
  if (!porDia.size) return null;
  const dia = [...porDia.keys()].sort().pop();
  const filas = porDia.get(dia);
  const agrupadas = new Map();
  filas.forEach((d) => {
    const previa = agrupadas.get(d.insumoId);
    if (previa) previa.cantidad += Number(d.cantidad) || 0;
    else agrupadas.set(d.insumoId, { nombre: d.insumoNombre, cantidad: Number(d.cantidad) || 0 });
  });
  return { fecha: dia, almacen, motivo: filas[0].motivo || MOTIVO_POR_DEFECTO, responsable: filas.find((d) => d.responsable)?.responsable || getResponsableLabel(), observaciones: "", items: [...agrupadas.values()] };
}

let lineas = [];

export function initDebitoRapido() {
  const raiz = document.getElementById("debito-rapido");
  if (!raiz) return;
  const motivos = MOTIVOS_DEBITO_INVENTARIO.filter((m) => !/^Ajuste/.test(m));

  raiz.innerHTML = `
    <div class="form-card">
      <h3 class="font-semibold text-slate-700 mb-1">Débito rápido — insumos gastados del Módulo o la Ambulancia</h3>
      <p class="text-xs text-slate-500 mb-3 max-w-3xl">
        Copie el reporte de lo gastado (por ejemplo "02 guantes, 01 yelco 18, 01 dipirona amp") y pulse "Pegar del portapapeles e interpretar" (o pegue con Ctrl+V en la caja).
        Se muestra una vista previa y <strong>no se descuenta nada hasta que confirme</strong>. Al terminar se genera el recibo para el grupo.
      </p>
      <textarea id="db-texto" rows="4" class="form-input" placeholder="Pegue aquí el reporte de insumos gastados..."></textarea>
      <div class="flex flex-wrap gap-2 mt-2">
        <button type="button" id="db-pegar" class="btn-primary">Pegar del portapapeles e interpretar</button>
        <button type="button" id="db-interpretar" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Interpretar texto</button>
        <button type="button" id="db-plantilla" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Mensaje Módulo</button>
        <button type="button" id="db-plantilla-amb" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Mensaje Ambulancia</button>
        <button type="button" id="db-ver-recibo" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Recibo del último débito</button>
        <button type="button" id="db-limpiar" class="px-4 py-2 text-sm rounded-md text-slate-500 hover:underline">Limpiar</button>
      </div>
      <div id="db-aviso" class="text-xs text-slate-500 mt-2"></div>
      <div id="db-plantilla-caja" class="mt-3"></div>
      <div id="db-recibo" class="mt-3"></div>
      <div id="db-vista" class="mt-3"></div>
    </div>`;

  const el = (id) => raiz.querySelector(id);
  const aviso = (t) => (el("#db-aviso").textContent = t || "");
  const hoy = () => new Date().toLocaleDateString("en-CA");
  let almacenActual = ALMACENES_DEBITO[0];
  let motivoActual = MOTIVO_POR_DEFECTO;
  let obsActual = "";

  function pintar() {
    const vista = el("#db-vista");
    if (!lineas.length) {
      vista.innerHTML = "";
      return;
    }
    const activos = getInsumos().filter((i) => i.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre));
    const opcionesInsumo = (sel) => `<option value="">— elegir insumo —</option>` + activos.map((i) => `<option value="${i.id}" ${i.id === sel ? "selected" : ""}>${escapeHTML(i.nombre)}</option>`).join("");
    const prevFecha = el("#db-fecha")?.value || hoy();
    const prevResp = el("#db-responsable")?.value ?? getResponsableLabel();
    vista.innerHTML = `
      <div class="grid gap-3 md:grid-cols-4 mb-3">
        <div><label class="form-label">Fecha</label><input id="db-fecha" type="date" class="form-input" value="${prevFecha}" /></div>
        <div><label class="form-label">Almacén</label><select id="db-almacen" class="form-input">${ALMACENES_DEBITO.map((a) => `<option ${a === almacenActual ? "selected" : ""}>${a}</option>`).join("")}</select></div>
        <div><label class="form-label">Motivo</label><select id="db-motivo" class="form-input">${motivos.map((m) => `<option ${m === motivoActual ? "selected" : ""}>${escapeHTML(m)}</option>`).join("")}</select></div>
        <div><label class="form-label">Responsable</label><input id="db-responsable" type="text" class="form-input" value="${escapeHTML(prevResp)}" /></div>
        <div class="md:col-span-4"><label class="form-label">Observaciones (opcional)</label><input id="db-obs" type="text" class="form-input" value="${escapeHTML(obsActual)}" /></div>
      </div>
      <div class="overflow-x-auto border border-slate-200 rounded-md">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50 text-slate-600"><tr>
            <th class="text-left px-2 py-1.5">Texto original</th><th class="text-left px-2 py-1.5">Insumo</th><th class="text-left px-2 py-1.5 w-24">Cantidad</th>
            <th class="text-left px-2 py-1.5">Disponible en ${escapeHTML(almacenActual)}</th><th class="px-2 py-1.5"></th>
          </tr></thead>
          <tbody>
            ${lineas
              .map((l, i) => {
                const disp = l.insumoId ? existenciaDe(l.insumoId, almacenActual) : null;
                const falta = l.insumoId && l.cantidad && disp < l.cantidad;
                return `<tr class="border-t border-slate-100 ${l.dudoso && !l.insumoId ? "bg-red-50" : l.dudoso ? "bg-amber-50" : ""}" data-i="${i}">
                  <td class="px-2 py-1.5 text-xs text-slate-500 max-w-[10rem] truncate" title="${escapeHTML(l.original)}">${escapeHTML(l.original)}</td>
                  <td class="px-2 py-1.5"><select data-campo="insumo" class="form-input !py-1 min-w-[12rem]">${opcionesInsumo(l.insumoId)}</select></td>
                  <td class="px-2 py-1.5"><input data-campo="cantidad" type="number" min="0" step="any" class="form-input !py-1" value="${l.cantidad ?? ""}" />${l.nota ? `<div class="text-[11px] text-red-700">${escapeHTML(l.nota)}</div>` : ""}</td>
                  <td class="px-2 py-1.5 text-xs ${falta ? "text-red-700 font-semibold" : "text-slate-500"}">${disp === null ? "—" : `${disp}${falta ? " — no alcanza" : ""}`}</td>
                  <td class="px-2 py-1.5"><button type="button" data-campo="quitar" class="text-red-700 hover:underline text-xs">Quitar</button></td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2 mt-3">
        <p class="text-xs text-slate-500">Revise las filas en amarillo (coincidencia dudosa) o rojo (sin insumo) antes de confirmar.</p>
        <button type="button" id="db-confirmar" class="btn-primary">Registrar débito (${lineas.length})</button>
      </div>`;
    el("#db-almacen").onchange = (e) => {
      almacenActual = e.target.value;
      pintar();
    };
    el("#db-motivo").onchange = (e) => (motivoActual = e.target.value);
    el("#db-obs").onchange = (e) => (obsActual = e.target.value);
    vista.querySelectorAll("tr[data-i]").forEach((tr) => {
      const i = Number(tr.dataset.i);
      tr.querySelector('[data-campo="insumo"]').onchange = (e) => {
        lineas[i].insumoId = e.target.value || null;
        lineas[i].dudoso = false;
        lineas[i].corregido = true;
        pintar();
      };
      tr.querySelector('[data-campo="cantidad"]').onchange = (e) => {
        lineas[i].cantidad = e.target.value === "" ? null : Number(e.target.value);
        pintar();
      };
      tr.querySelector('[data-campo="quitar"]').onclick = () => {
        lineas.splice(i, 1);
        pintar();
      };
    });
    el("#db-confirmar").onclick = confirmar;
  }

  async function confirmar() {
    const fecha = el("#db-fecha").value;
    const almacen = el("#db-almacen").value;
    const motivo = el("#db-motivo").value;
    const responsable = el("#db-responsable").value.trim();
    const observaciones = el("#db-obs").value.trim();
    if (!fecha || !responsable) return toast("Complete la fecha y el responsable.", "error");
    const invalidas = lineas.filter((l) => !l.insumoId || !l.cantidad || l.cantidad <= 0);
    if (invalidas.length) return toast(`Hay ${invalidas.length} fila(s) sin insumo o sin cantidad. Corríjalas o quítelas.`, "error");
    const boton = el("#db-confirmar");
    boton.disabled = true;
    boton.textContent = "Registrando...";
    const pendientes = [];
    const registradas = [];
    for (const l of lineas) {
      const insumo = getInsumos().find((i) => i.id === l.insumoId);
      try {
        await registrarDebito({ insumoId: l.insumoId, insumoNombre: insumo?.nombre || l.original, almacen, cantidad: l.cantidad, motivo, responsable, observaciones, fecha });
        registradas.push({ nombre: insumo?.nombre || l.original, cantidad: l.cantidad });
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
    if (registradas.length) mostrarRecibo({ fecha, almacen, motivo, responsable, observaciones, items: registradas });
    lineas = pendientes;
    if (pendientes.length) {
      toast(`${registradas.length} registrado(s); ${pendientes.length} con error (siguen en la lista, vea el detalle).`, "error");
      aviso(pendientes.map((p) => `${p.original}: ${p.nota}`).join(" | "));
    } else {
      toast(`Débito registrado: ${registradas.length} insumo(s) de ${almacen}.`, "success");
      el("#db-texto").value = "";
      aviso("");
      obsActual = "";
    }
    pintar();
  }

  function mostrarRecibo(r) {
    const cont = el("#db-recibo");
    if (!r) {
      cont.innerHTML = "";
      return;
    }
    cont.innerHTML = `
      <div class="border border-emerald-200 bg-emerald-50 rounded-md p-3">
        <div class="font-semibold text-emerald-900 text-sm mb-1">Reporte de insumos utilizados — listo para enviar al grupo</div>
        <textarea id="db-recibo-texto" rows="${Math.min(16, r.items.length + 10)}" class="form-input font-mono text-xs" readonly>${escapeHTML(textoRecibo(r))}</textarea>
        <div class="flex flex-wrap gap-2 mt-2">
          <button type="button" id="db-copiar" class="btn-primary">Copiar para WhatsApp</button>
          <button type="button" id="db-imprimir" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 bg-white hover:bg-slate-50">Imprimir / guardar PDF</button>
          <button type="button" id="db-cerrar-recibo" class="px-4 py-2 text-sm rounded-md text-slate-500 hover:underline">Cerrar</button>
        </div>
      </div>`;
    el("#db-copiar").onclick = async () => {
      const ta = el("#db-recibo-texto");
      try {
        await navigator.clipboard.writeText(ta.value);
      } catch {
        ta.select();
        document.execCommand("copy");
      }
      toast("Reporte copiado. Péguelo en el grupo de WhatsApp (Ctrl+V).", "success");
    };
    el("#db-imprimir").onclick = () => imprimirRecibo(r);
    el("#db-cerrar-recibo").onclick = () => mostrarRecibo(null);
  }

  function interpretar(texto) {
    if (!getInsumos().length) return toast("El catálogo de insumos todavía está cargando. Intente de nuevo en un momento.", "warning");
    mostrarRecibo(null);
    lineas = interpretarDespacho(texto, getInsumos(), leerAlias());
    aviso(lineas.length ? `${lineas.length} línea(s) interpretada(s). Revise antes de registrar.` : "No se reconoció ningún insumo en el texto. Escriba, por ejemplo: 02 guantes, 01 yelco 18.");
    pintar();
  }

  el("#db-interpretar").onclick = () => interpretar(el("#db-texto").value);
  el("#db-texto").addEventListener("paste", () => setTimeout(() => interpretar(el("#db-texto").value), 0));
  el("#db-pegar").onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return toast("El portapapeles está vacío. Copie primero el mensaje.", "warning");
      el("#db-texto").value = t;
      interpretar(t);
    } catch {
      toast("El navegador no permitió leer el portapapeles. Pegue el texto en la caja con Ctrl+V.", "warning");
      el("#db-texto").focus();
    }
  };
  el("#db-ver-recibo").onclick = () => {
    const r = ultimoDebito(almacenActual) || ultimoDebito(ALMACENES_DEBITO.find((a) => ultimoDebito(a)) || "");
    if (!r) return toast("Aún no hay débitos del Módulo o la Ambulancia.", "warning");
    mostrarRecibo(r);
  };
  const plantillaDebito = (almacen) => {
    const esAmb = almacen === "Ambulancia";
    const texto = plantillaMensaje({
      titulo: `INSUMOS UTILIZADOS – ${esAmb ? "AMBULANCIA" : "MÓDULO DE EMERGENCIA"}`,
      campos: esAmb ? ["Responsable:", "Unidad:", "Servicio:", "Turno:"] : ["Responsable:", "Turno:"],
      filas: getDebitos().filter((d) => d.almacenOrigen === almacen),
      almacenStock: almacen,
    });
    mostrarPlantilla(el("#db-plantilla-caja"), texto, `Para reportar lo <strong>gastado</strong> en ${esAmb ? "la Ambulancia" : "el Módulo"}: cambian los <strong>00</strong> por las cantidades usadas y lo envían al grupo. Luego se pega aquí para descontarlo (elija el almacén ${almacen}). Las líneas en 00 y los datos de Responsable / Turno / Observaciones se ignoran.`);
    almacenActual = almacen;
  };
  el("#db-plantilla").onclick = () => plantillaDebito("Módulo");
  el("#db-plantilla-amb").onclick = () => plantillaDebito("Ambulancia");
  el("#db-limpiar").onclick = () => {
    mostrarRecibo(null);
    lineas = [];
    el("#db-texto").value = "";
    aviso("");
    pintar();
  };
}
