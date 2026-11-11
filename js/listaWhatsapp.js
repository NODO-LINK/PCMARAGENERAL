/**
 * listaWhatsapp.js
 * -----------------------------------------------------------------------
 * "Lista diaria desde WhatsApp": interpreta el reporte diario que el
 * Módulo de Emergencia publica en el grupo (pacientes atendidos por
 * diagnóstico, estadística, personal de guardia) y lo convierte en la
 * planilla de la Lista Diaria, con vista previa y confirmación.
 * Si ya existe la lista de esa fecha (el reporte se editó y se vuelve a
 * pegar) se ACTUALIZA en vez de duplicarla.
 * -----------------------------------------------------------------------
 */
import { db, doc, updateDoc, serverTimestamp } from "./firebase.js";
import { COLLECTIONS } from "./config.js";
import { subscribeCollection, createRecord } from "./data.js";
import { getResponsableLabel, isAdmin, isOperador, getCurrentUser } from "./auth.js";
import { toast, escapeHTML, toDate, parseLocalDate } from "./ui.js";
import { normalizarBusqueda } from "./busqueda.js";

/* ------------------------------- Intérprete ------------------------------ */

const EMOJIS = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

function quitarPrefijoWhatsApp(linea) {
  return linea
    .replace(/^\s*\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}[,\s]+\d{1,2}:\d{2}[^\]\-:]*[\]\-]\s*[^:]{1,40}:\s*/, "")
    .replace(/^\s*\[\d{1,2}:\d{2}[^\]]*\]\s*[^:]{1,40}:\s*/, "");
}

function aISO(d, m, a) {
  const anio = a.length === 2 ? 2000 + Number(a) : Number(a);
  const mes = Number(m);
  const dia = Number(d);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

export function interpretarListaDiaria(texto) {
  const crudo = String(texto ?? "");
  const lineas = crudo
    .split("\n")
    .map((l) => quitarPrefijoWhatsApp(l).replace(EMOJIS, "").replace(/[*_~`]/g, "").trim());
  const r = { fecha: null, ninos: null, adolescentes: null, adultos: null, traslados: null, fallecidos: null, femeninos: null, masculinos: null, oficiales: null, totalDeclarado: null, diagnosticos: [], personalGuardia: "", personalRecibe: "", avisos: [] };

  // Fecha: "Fecha: dd/mm/aaaa"; si no, la del encabezado de WhatsApp "[hh:mm, d/m/aaaa]"; si no, cualquier fecha del encabezado.
  const reFecha = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})/;
  const lineaFecha = lineas.find((l) => /^fecha\b/i.test(normalizarBusqueda(l)) && reFecha.test(l));
  const mLinea = lineaFecha && lineaFecha.match(reFecha);
  const mPrefijo = crudo.match(/^\s*\[?\s*\d{1,2}:\d{2}[^\]\n]*?(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})/m) || crudo.match(/^\s*\[?(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2}),?\s+\d{1,2}:\d{2}/m);
  const mCabecera = lineas.slice(0, 8).join("\n").match(reFecha);
  const m = mLinea || mPrefijo || mCabecera;
  if (m) r.fecha = aISO(m[1], m[2], m[3]);

  const primerNumero = (l) => {
    const n = l.replace(/^[^:]*:/, " ").match(/\d+/) || l.match(/\d+/);
    return n ? Number(n[0]) : null;
  };

  let seccion = "";
  lineas.forEach((linea, i) => {
    const n = normalizarBusqueda(linea);
    if (!n) return;
    if (/^pacientes atendidos/.test(n)) {
      seccion = "pacientes";
      r.totalDeclarado = primerNumero(linea);
      return;
    }
    if (/^estadistica/.test(n)) {
      seccion = "estadistica";
      return;
    }
    if (/^personal de guardia/.test(n)) seccion = "guardia";
    else if (/^personal que recibe/.test(n)) seccion = "recibe";
    else if (/^descripcion del evento/.test(n)) seccion = "descripcion";

    if (seccion === "pacientes") {
      const d = linea.match(/^\s*(.+?)\s*\(\s*(\d+)\s*\)\s*$/);
      if (d) r.diagnosticos.push({ nombre: d[1].trim(), cantidad: Number(d[2]) });
      return;
    }
    if (seccion === "estadistica") {
      const regs = [
        ["ninos", /^(ninos?|ninas?)\b/],
        ["adolescentes", /^adolescentes?\b/],
        ["adultos", /^adultos?\b/],
        ["oficiales", /^oficiales?\b/],
        ["femeninos", /^femeninos?\b/],
        ["masculinos", /^masculinos?\b/],
        ["fallecidos", /^fallecid[oa]s?\b/],
        ["traslados", /^traslados?\b/],
      ];
      for (const [k, re] of regs) if (re.test(n)) { r[k] = primerNumero(linea); return; }
      return;
    }
    if (seccion === "guardia") r.personalGuardia += (r.personalGuardia ? " | " : "") + linea.replace(/^personal de guardia\s*:?\s*/i, "");
    if (seccion === "recibe") r.personalRecibe += (r.personalRecibe ? " | " : "") + linea.replace(/^personal que recibe\s*:?\s*/i, "");
    // "Personal que recibe" termina la guardia; una línea vacía corta el bloque (se maneja arriba al ignorar vacías)
    void i;
  });

  // Responsable sugerido: primer médico mencionado en el personal de guardia.
  const med = r.personalGuardia.match(/\b(Dra?\.?|Doctora?)\s*:?\s*((?:[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s?){1,3})/);
  r.responsableSugerido = med ? `${/^Dra|Doctora/.test(med[1]) ? "Dra." : "Dr."} ${med[2].trim()}` : "";

  // Coherencia (solo avisos: lo que se registra es la estadística, editable en la vista previa)
  const personas = (r.ninos || 0) + (r.adolescentes || 0) + (r.adultos || 0);
  const porDiag = r.diagnosticos.reduce((s, d) => s + d.cantidad, 0);
  if (r.diagnosticos.length && porDiag !== personas) r.avisos.push(`La suma de los diagnósticos (${porDiag}) no coincide con Niños + Adolescentes + Adultos (${personas}).`);
  if (r.totalDeclarado !== null && r.totalDeclarado !== personas) r.avisos.push(`El mensaje dice "Pacientes atendidos: ${r.totalDeclarado}" pero la estadística suma ${personas}.`);
  if (r.femeninos !== null && r.masculinos !== null && r.femeninos + r.masculinos !== personas) r.avisos.push(`Femeninos + Masculinos (${r.femeninos + r.masculinos}) no coincide con el total de pacientes (${personas}).`);
  if (r.ninos === null && r.adolescentes === null && r.adultos === null) r.avisos.push("No se encontró la estadística (Niños / Adolescentes / Adultos). ¿Pegó el mensaje completo?");
  return r;
}

/* ----------------------------------- UI ---------------------------------- */

let planillas = []; // lista diaria ya registrada

export function initListaWhatsapp() {
  const raiz = document.getElementById("lista-whatsapp");
  if (!raiz) return;
  subscribeCollection(COLLECTIONS.PACIENTES, "fecha", (rows) => {
    planillas = rows;
    if (datos) pintar();
  });

  raiz.innerHTML = `
    <div class="form-card">
      <h3 class="font-semibold text-slate-700 mb-1">Lista diaria desde el reporte de WhatsApp</h3>
      <p class="text-xs text-slate-500 mb-3 max-w-3xl">
        Copie el reporte del Módulo de Emergencia del grupo (mantenga pulsado/clic derecho → Copiar) y pulse <strong>Pegar del portapapeles e interpretar</strong>
        (o pegue con Ctrl+V en la caja). Se llena la planilla del día con la estadística, los diagnósticos y el personal de guardia; usted revisa y confirma.
        Si el reporte se edita después, vuelva a pegarlo: se <strong>actualiza</strong> la lista de esa fecha en vez de duplicarla.
      </p>
      <textarea id="lw-texto" rows="4" class="form-input" placeholder="Pegue aquí el reporte diario del grupo..."></textarea>
      <div class="flex flex-wrap gap-2 mt-2">
        <button type="button" id="lw-pegar" class="btn-primary">Pegar del portapapeles e interpretar</button>
        <button type="button" id="lw-interpretar" class="px-4 py-2 text-sm rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50">Interpretar texto</button>
        <button type="button" id="lw-limpiar" class="px-4 py-2 text-sm rounded-md text-slate-500 hover:underline">Limpiar</button>
      </div>
      <div id="lw-vista" class="mt-3"></div>
    </div>`;
  const el = (s) => raiz.querySelector(s);
  let textoActual = "";
  datos = null;

  const existente = (fechaISO) => planillas.find((p) => toDate(p.fecha)?.toLocaleDateString("en-CA") === fechaISO && p.registroLegado !== "si");
  const hoy = () => new Date().toLocaleDateString("en-CA");
  const num = (v) => (v === null || v === undefined ? 0 : v);
  const puedeActualizar = () => isAdmin() || isOperador();

  function pintar() {
    const d = datos;
    const cont = el("#lw-vista");
    if (!d) {
      cont.innerHTML = "";
      return;
    }
    const f = d.fecha || hoy();
    const previa = existente(f);
    const campo = (k, etiqueta) => `<div><label class="form-label">${etiqueta}</label><input type="number" min="0" data-k="${k}" class="form-input" value="${num(d[k])}" /></div>`;
    cont.innerHTML = `
      ${d.avisos.map((a) => `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2 mb-2">⚠ ${escapeHTML(a)}</p>`).join("")}
      ${previa ? `<p class="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-md p-2 mb-2">Ya existe una lista diaria con fecha ${f.split("-").reverse().join("/")} (Niños ${previa.ninos}, Adolescentes ${previa.adolescentes}, Adultos ${previa.adultos}). Al confirmar se <strong>actualizará</strong> esa lista${puedeActualizar() ? "" : ", pero su usuario no puede modificar listas existentes: pida a un administrador"}.</p>` : ""}
      <div class="grid gap-3 md:grid-cols-4 mb-3">
        <div><label class="form-label">Fecha</label><input type="date" data-k="fecha" class="form-input" value="${f}" /></div>
        ${campo("ninos", "Niños")}${campo("adolescentes", "Adolescentes")}${campo("adultos", "Adultos")}
        ${campo("traslados", "Traslados")}${campo("fallecidos", "Fallecidos")}${campo("femeninos", "Femeninos")}${campo("masculinos", "Masculinos")}
        ${campo("oficiales", "Oficiales")}
        <div class="md:col-span-3"><label class="form-label">Responsable del día</label><input type="text" data-k="responsable" class="form-input" value="${escapeHTML(d.responsable ?? d.responsableSugerido ?? getResponsableLabel())}" /></div>
      </div>
      ${d.diagnosticos.length ? `<div class="mb-3"><div class="text-xs font-semibold text-slate-600 mb-1">Diagnósticos (${d.diagnosticos.reduce((s, x) => s + x.cantidad, 0)} atenciones)</div><div class="flex flex-wrap gap-1">${d.diagnosticos.map((x) => `<span class="text-xs bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">${escapeHTML(x.nombre)} (${x.cantidad})</span>`).join("")}</div></div>` : ""}
      ${d.personalGuardia || d.personalRecibe ? `<div class="text-xs text-slate-600 mb-3">${d.personalGuardia ? `<div><strong>Personal de guardia:</strong> ${escapeHTML(d.personalGuardia)}</div>` : ""}${d.personalRecibe ? `<div><strong>Personal que recibe:</strong> ${escapeHTML(d.personalRecibe)}</div>` : ""}</div>` : ""}
      <div class="flex justify-end"><button type="button" id="lw-confirmar" class="btn-primary" ${previa && !puedeActualizar() ? "disabled" : ""}>${previa ? "Actualizar lista del día" : "Registrar lista del día"}</button></div>`;
    cont.querySelectorAll("[data-k]").forEach((i) => {
      i.addEventListener("input", () => {
        d[i.dataset.k] = i.type === "number" ? (i.value === "" ? 0 : Number(i.value)) : i.value;
      });
      if (i.dataset.k === "fecha") i.addEventListener("change", pintar);
    });
    el("#lw-confirmar").onclick = confirmar;
  }

  async function confirmar() {
    const d = datos;
    const fechaISO = d.fecha || hoy();
    const responsable = String(d.responsable ?? d.responsableSugerido ?? "").trim() || getResponsableLabel();
    const campos = {
      fecha: parseLocalDate(fechaISO),
      ninos: num(d.ninos),
      adolescentes: num(d.adolescentes),
      adultos: num(d.adultos),
      cantidadTraslados: num(d.traslados),
      cantidadFallecidos: num(d.fallecidos),
      femeninos: num(d.femeninos),
      masculinos: num(d.masculinos),
      oficiales: num(d.oficiales),
      diagnosticos: d.diagnosticos,
      personalGuardia: d.personalGuardia,
      personalRecibe: d.personalRecibe,
      responsable,
      registroLegado: "no",
      origen: "whatsapp",
    };
    const boton = el("#lw-confirmar");
    boton.disabled = true;
    try {
      const previa = existente(fechaISO);
      if (previa) {
        if (!puedeActualizar()) throw new Error("Su usuario no puede modificar listas existentes.");
        await updateDoc(doc(db, COLLECTIONS.PACIENTES, previa.id), { ...campos, updatedAt: serverTimestamp(), updatedBy: getCurrentUser()?.uid || null });
        toast(`Lista diaria del ${fechaISO.split("-").reverse().join("/")} actualizada.`, "success");
      } else {
        await createRecord(COLLECTIONS.PACIENTES, campos);
        toast(`Lista diaria del ${fechaISO.split("-").reverse().join("/")} registrada.`, "success");
      }
      datos = null;
      el("#lw-texto").value = "";
      pintar();
    } catch (err) {
      console.error(err);
      toast(err.message || "No se pudo guardar la lista diaria.", "error");
      boton.disabled = false;
    }
  }

  function interpretar(texto) {
    textoActual = texto;
    if (!String(texto).trim()) return toast("No hay texto para interpretar.", "warning");
    datos = interpretarListaDiaria(textoActual);
    pintar();
  }
  el("#lw-interpretar").onclick = () => interpretar(el("#lw-texto").value);
  el("#lw-texto").addEventListener("paste", () => setTimeout(() => interpretar(el("#lw-texto").value), 0));
  el("#lw-pegar").onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return toast("El portapapeles está vacío. Copie primero el reporte del grupo.", "warning");
      el("#lw-texto").value = t;
      interpretar(t);
    } catch {
      toast("El navegador no permitió leer el portapapeles. Pegue el texto en la caja con Ctrl+V.", "warning");
      el("#lw-texto").focus();
    }
  };
  el("#lw-limpiar").onclick = () => {
    datos = null;
    el("#lw-texto").value = "";
    pintar();
  };
}

let datos = null;
