/**
 * emergencias.js
 * -----------------------------------------------------------------------
 * Módulo Unificado de Operaciones de Emergencia: agrupa las tres
 * sub-secciones que alimentan las estadísticas diarias del sistema:
 *   - Lista Diaria de Pacientes: UNA planilla por día (no un registro por
 *     paciente). Se escriben directamente las cantidades atendidas (Niños,
 *     Adolescentes, Adultos, Traslados, Fallecidos) y el responsable del
 *     día (ej. "Doctora Isbelia"). Las cantidades de Traslados y
 *     Fallecidos aquí son un conteo manual propio de esta planilla — son
 *     independientes de los módulos de Traslados y Fallecidos (que llevan
 *     su propio registro detallado, sin relación con esta lista).
 *   - Traslados (con cédula, edad y nombre del paciente trasladado).
 *   - Fallecidos (nombre, cédula, edad, sexo, fecha, hora, lugar, causa).
 * La Lista Diaria también permite registrar los Insumos utilizados el día
 * (se descuentan del inventario como un débito — ver inventario.js — y se
 * incluyen en el documento impreso de la lista).
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS, CATEGORIAS_INSTITUCIONES } from "./config.js";
import { createCrudModule } from "./moduleFactory.js";
import { formatDate, toDate, escapeHTML, printAdHoc, toast } from "./ui.js";
import { subscribeCollection, createRecord, updateRecord } from "./data.js";
import { registrarDebito, deleteDebito } from "./inventario.js";
import { isAdmin, getResponsableLabel } from "./auth.js";
import { quitarAcentos, leerArchivoTabular, mapearFila } from "./importUtils.js";
import { getInstituciones } from "./catalogos.js";

let modules = null;

export function initEmergencias() {
  // Sub-pestañas internas del módulo unificado.
  const tabs = document.querySelectorAll("#view-emergencias .subtab-btn");
  tabs.forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#view-emergencias .subtab-panel").forEach((p) => p.classList.add("hidden"));
      document.getElementById(`panel-${btn.dataset.subtab}`).classList.remove("hidden");
      tabs.forEach((b) => b.classList.toggle("subtab-active", b === btn));
    });
  });

  const pacientes = createCrudModule({
    collectionName: COLLECTIONS.PACIENTES,
    form: document.getElementById("form-pacientes"),
    historialRoot: document.getElementById("historial-pacientes"),
    dateField: "fecha",
    historialTitle: "Listas Diarias de Pacientes Atendidos",
    firmas: ["Jefe de Departamento", "Director"],
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "ninos", label: "Niños" },
      { key: "adolescentes", label: "Adolescentes" },
      { key: "adultos", label: "Adultos" },
      { key: "cantidadTraslados", label: "Traslados" },
      { key: "cantidadFallecidos", label: "Fallecidos" },
      { key: "responsable", label: "Responsable del día" },
    ],
    beforeSave: (data) => {
      data.ninos = Number(data.ninos) || 0;
      data.adolescentes = Number(data.adolescentes) || 0;
      data.adultos = Number(data.adultos) || 0;
      data.cantidadTraslados = Number(data.cantidadTraslados) || 0;
      data.cantidadFallecidos = Number(data.cantidadFallecidos) || 0;
      return data;
    },
  });

  const trasladosForm = document.getElementById("form-traslados");
  const traslados = createCrudModule({
    collectionName: COLLECTIONS.TRASLADOS,
    form: trasladosForm,
    historialRoot: document.getElementById("historial-traslados"),
    dateField: "fecha",
    historialTitle: "Historial de Traslados",
    firmas: ["Médico", "Jefe de Departamento"],
    columns: [
      { key: "fecha", label: "Fecha/Hora", format: (r) => formatDate(r.fecha, true) },
      { key: "tipo", label: "Tipo" },
      { key: "nombrePaciente", label: "Nombre del paciente" },
      { key: "cedulaPaciente", label: "Cédula" },
      { key: "edadPaciente", label: "Edad" },
      { key: "centroDestino", label: "Institución", format: (r) => r.institucionNombre || r.centroDestino || "—" },
      { key: "unidad", label: "Unidad" },
      { key: "responsable", label: "Responsable" },
    ],
    beforeSave: (data) => {
      // La "Institución" se selecciona del catálogo maestro (igual que en
      // Combustible) para poder contar cuántos traslados se le hicieron a
      // cada institución registrada. Es obligatoria para todo traslado,
      // sin importar el tipo (Apoyo o Interhospitalario).
      const select = trasladosForm.elements["institucionId"];
      const opt = select ? select.options[select.selectedIndex] : null;
      data.institucionNombre = opt && opt.value ? opt.dataset.nombre : "";
      return data;
    },
  });

  const fallecidos = createCrudModule({
    collectionName: COLLECTIONS.FALLECIDOS,
    form: document.getElementById("form-fallecidos"),
    historialRoot: document.getElementById("historial-fallecidos"),
    dateField: "fecha",
    historialTitle: "Historial de Fallecidos",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "hora", label: "Hora" },
      { key: "nombre", label: "Nombre" },
      { key: "cedula", label: "Cédula" },
      { key: "edad", label: "Edad" },
      { key: "sexo", label: "Sexo" },
      { key: "lugar", label: "Lugar de fallecimiento" },
      { key: "causa", label: "Causa / Circunstancia" },
      { key: "responsable", label: "Responsable" },
    ],
    beforeSave: (data) => {
      data.edad = Number(data.edad) || 0;
      return data;
    },
  });

  modules = { pacientes, traslados, fallecidos };
  setupListaDiaria(pacientes);
  setupInsumosUsados();
  setupImportacionTraslados();
  return modules;
}

export function getEmergenciasModules() {
  return modules;
}

/* ---------------------------------------------------------------------- */
/* Lista Diaria de Pacientes: impresión formal de la planilla del día      */
/* ---------------------------------------------------------------------- */
function setupListaDiaria(pacientes) {
  const fechaInput = document.getElementById("lista-diaria-fecha");
  const btn = document.getElementById("btn-imprimir-lista-diaria");
  if (!fechaInput || !btn) return;

  // en-CA produce YYYY-MM-DD en hora LOCAL (evita el corrimiento UTC).
  fechaInput.value = new Date().toLocaleDateString("en-CA");

  btn.addEventListener("click", () => {
    const dateStr = fechaInput.value;
    if (!dateStr) {
      toast("Seleccione la fecha de la lista a imprimir.", "error");
      return;
    }
    const sameDay = (row) => toDate(row.fecha)?.toLocaleDateString("en-CA") === dateStr;

    const registro = pacientes.getRows().find(sameDay);
    if (!registro) {
      toast("No hay una lista diaria guardada para esa fecha. Agréguela primero en el formulario de arriba.", "error");
      return;
    }
    const insumosDia = insumosUsados.filter((r) => r.motivo === MOTIVO_USO_DIARIO && sameDay(r));

    const fechaFmt = new Date(dateStr + "T00:00:00").toLocaleDateString("es-VE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    printAdHoc(
      `Lista Diaria de Pacientes — ${fechaFmt}`,
      buildListaDiariaBodyHTML(fechaFmt, registro, insumosDia),
      ["Jefe de Departamento", "Director"]
    );
  });
}

const cellStyle = "border:1px solid #cbd5e1;padding:5px 7px;";
const headStyle = `${cellStyle}background:#f1f5f9;font-weight:bold;`;

function buildListaDiariaBodyHTML(fechaFmt, registro, insumosDia = []) {
  const insumosRows =
    insumosDia
      .map(
        (r, i) => `
      <tr>
        <td style="${cellStyle}">${i + 1}</td>
        <td style="${cellStyle}">${escapeHTML(r.insumoNombre)}</td>
        <td style="${cellStyle}">${escapeHTML(r.almacenOrigen)}</td>
        <td style="${cellStyle}">${r.cantidad}</td>
        <td style="${cellStyle}">${escapeHTML(r.responsable)}</td>
      </tr>`
      )
      .join("") ||
    `<tr><td colspan="5" style="${cellStyle}text-align:center;color:#94a3b8;">Sin insumos utilizados registrados en esta fecha.</td></tr>`;

  return `
    <div style="padding:12px 20px 4px;font-family:Arial,Helvetica,sans-serif;color:#1e293b;">
      <h2 style="text-align:center;font-size:15px;margin:6px 0 4px;">LISTA DIARIA DE PACIENTES ATENDIDOS</h2>
      <p style="text-align:center;font-size:11px;margin:0 0 4px;color:#475569;">Fecha: ${fechaFmt}</p>
      <p style="text-align:center;font-size:11px;margin:0 0 14px;color:#475569;">Responsable del día: <strong>${escapeHTML(registro.responsable)}</strong></p>

      <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:10.5px;text-align:center;">
        <thead>
          <tr>
            <th style="${headStyle}">Niños</th>
            <th style="${headStyle}">Adolescentes</th>
            <th style="${headStyle}">Adultos</th>
            <th style="${headStyle}">Traslados</th>
            <th style="${headStyle}">Fallecidos</th>
          </tr>
        </thead>
        <tbody>
          <tr style="font-weight:bold;">
            <td style="${cellStyle}">${registro.ninos ?? 0}</td>
            <td style="${cellStyle}">${registro.adolescentes ?? 0}</td>
            <td style="${cellStyle}">${registro.adultos ?? 0}</td>
            <td style="${cellStyle}">${registro.cantidadTraslados ?? 0}</td>
            <td style="${cellStyle}">${registro.cantidadFallecidos ?? 0}</td>
          </tr>
        </tbody>
      </table>

      <h3 style="font-size:12px;margin:18px 0 6px;">Insumos utilizados</h3>
      <table style="width:100%;border-collapse:collapse;font-size:10px;">
        <thead>
          <tr>
            <th style="${headStyle}">#</th>
            <th style="${headStyle}">Insumo</th>
            <th style="${headStyle}">Almacén</th>
            <th style="${headStyle}">Cantidad</th>
            <th style="${headStyle}">Responsable</th>
          </tr>
        </thead>
        <tbody>${insumosRows}</tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------------------------------- */
/* Insumos utilizados el día de hoy (débito automático de inventario)      */
/* ---------------------------------------------------------------------- */
const MOTIVO_USO_DIARIO = "Uso operativo / Consumo";
let insumosUsados = [];
// Lista temporal ("carrito") de insumos que se van agregando antes de
// registrarlos todos juntos de una vez — así el operador no tiene que
// repetir Fecha/Almacén/Responsable por cada insumo cuando usa muchos en
// el día.
let carritoInsumosUsados = []; // [{ insumoId, insumoNombre, cantidad }]

function setupInsumosUsados() {
  const fechaField = document.getElementById("insumo-usado-fecha");
  const almacenSelect = document.getElementById("insumo-usado-almacen");
  const respField = document.getElementById("insumo-usado-responsable");
  const insumoSelect = document.getElementById("insumo-usado-select");
  const cantidadField = document.getElementById("insumo-usado-cantidad");
  const btnAgregar = document.getElementById("btn-agregar-insumo-usado");
  const btnRegistrar = document.getElementById("btn-registrar-insumos-usados");
  if (!fechaField || !btnAgregar || !btnRegistrar) return;

  fechaField.value = new Date().toLocaleDateString("en-CA");
  respField.value = getResponsableLabel();

  // Agrega el insumo seleccionado a la lista pendiente (no toca Firestore
  // todavía). Si el insumo ya estaba en la lista, suma la cantidad en vez
  // de duplicar la fila.
  btnAgregar.addEventListener("click", () => {
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

    const existente = carritoInsumosUsados.find((it) => it.insumoId === opt.value);
    if (existente) {
      existente.cantidad += cantidad;
    } else {
      carritoInsumosUsados.push({ insumoId: opt.value, insumoNombre: opt.dataset.nombre, cantidad });
    }
    renderCarritoInsumosUsados();

    // Limpia el campo de cantidad y el buscador para agregar el siguiente
    // insumo rápido, sin perder Fecha/Almacén/Responsable ya escritos.
    cantidadField.value = "";
    const searchInput = insumoSelect.parentElement?.querySelector(".insumo-search");
    if (searchInput) {
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input"));
    }
    insumoSelect.value = "";
    (searchInput || insumoSelect).focus();
  });

  // Registra TODOS los insumos de la lista pendiente de una sola vez.
  btnRegistrar.addEventListener("click", async () => {
    if (!carritoInsumosUsados.length) {
      toast("Agregue al menos un insumo a la lista antes de registrar.", "error");
      return;
    }
    const almacen = almacenSelect.value;
    const responsable = respField.value.trim();
    const fecha = fechaField.value;
    if (!almacen) {
      toast("Seleccione el almacén.", "error");
      return;
    }
    if (!responsable) {
      toast("Escriba el responsable.", "error");
      return;
    }

    const defaultLabel = btnRegistrar.textContent;
    btnRegistrar.disabled = true;
    btnRegistrar.textContent = "Registrando...";
    try {
      for (const item of carritoInsumosUsados) {
        await registrarDebito({
          insumoId: item.insumoId,
          insumoNombre: item.insumoNombre,
          almacen,
          cantidad: item.cantidad,
          motivo: MOTIVO_USO_DIARIO,
          responsable,
          observaciones: "Insumo utilizado — Lista Diaria de Pacientes",
          fecha,
        });
      }
      toast(`${carritoInsumosUsados.length} insumo(s) registrados y descontados del inventario.`, "success");
      carritoInsumosUsados = [];
      renderCarritoInsumosUsados();
      fechaField.value = new Date().toLocaleDateString("en-CA");
      respField.value = getResponsableLabel();
    } catch (err) {
      console.error(err);
      toast(err.message || "Ocurrió un error registrando los insumos. Revise la lista e intente de nuevo.", "error");
    } finally {
      btnRegistrar.disabled = false;
      btnRegistrar.textContent = defaultLabel;
    }
  });

  renderCarritoInsumosUsados();

  subscribeCollection(COLLECTIONS.DEBITOS_INVENTARIO, "fecha", (rows) => {
    insumosUsados = rows;
    renderInsumosUsadosTable();
  });
}

function renderCarritoInsumosUsados() {
  const root = document.getElementById("carrito-insumos-usados");
  if (!root) return;

  if (!carritoInsumosUsados.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Aún no ha agregado insumos a la lista.</p>`;
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
        ${carritoInsumosUsados
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
      carritoInsumosUsados.splice(Number(btn.dataset.idx), 1);
      renderCarritoInsumosUsados();
    };
  });
}

function renderInsumosUsadosTable() {
  const root = document.getElementById("tabla-insumos-usados");
  if (!root) return;
  const hoy = new Date().toLocaleDateString("en-CA");
  const rows = insumosUsados.filter(
    (r) => r.motivo === MOTIVO_USO_DIARIO && toDate(r.fecha)?.toLocaleDateString("en-CA") === hoy
  );
  const admin = isAdmin();

  const countBadge = document.getElementById("insumos-usados-count");
  if (countBadge) countBadge.textContent = rows.length ? `${rows.length} hoy` : "sin registros hoy";

  root.innerHTML = `
    <table class="min-w-full text-sm">
      <thead class="bg-slate-50 text-slate-600">
        <tr>
          <th class="text-left font-medium px-3 py-1.5">Insumo</th>
          <th class="text-left font-medium px-3 py-1.5">Almacén</th>
          <th class="text-left font-medium px-3 py-1.5">Cantidad</th>
          <th class="text-left font-medium px-3 py-1.5">Responsable</th>
          <th class="text-left font-medium px-3 py-1.5 no-print">Acciones</th>
        </tr>
      </thead>
      <tbody>
        ${
          rows
            .map(
              (r) => `
          <tr class="border-t border-slate-100">
            <td class="px-3 py-1.5">${escapeHTML(r.insumoNombre)}</td>
            <td class="px-3 py-1.5">${escapeHTML(r.almacenOrigen)}</td>
            <td class="px-3 py-1.5">${r.cantidad}</td>
            <td class="px-3 py-1.5">${escapeHTML(r.responsable)}</td>
            <td class="px-3 py-1.5 no-print">${admin ? `<button data-id="${r.id}" data-act="del" class="text-red-700 hover:underline">Eliminar</button>` : "—"}</td>
          </tr>`
            )
            .join("") ||
          `<tr><td colspan="5" class="px-3 py-4 text-center text-slate-400">Sin insumos utilizados registrados hoy.</td></tr>`
        }
      </tbody>
    </table>`;

  if (admin) {
    root.querySelectorAll('[data-act="del"]').forEach((btn) => {
      btn.onclick = () => deleteDebito(rows.find((r) => r.id === btn.dataset.id));
    });
  }
}

/* ---------------------------------------------------------------------- */
/* Importación masiva de traslados desde Excel/CSV                         */
/* ---------------------------------------------------------------------- */
// Encabezados aceptados por columna (sin distinguir tildes/mayúsculas).
const TRASLADO_ALIAS = {
  fecha: ["fecha", "fechahora", "fecha/hora", "fecha y hora"],
  tipo: ["tipo", "tipodetraslado", "tipo de traslado"],
  centroDestino: ["centrodestino", "centro destino", "centro", "destino", "institucion", "centrodesalud", "centro de salud de destino", "centro de salud", "centro de salud destino"],
  nombrePaciente: ["nombre", "paciente", "nombrepaciente", "nombre del paciente"],
  cedulaPaciente: ["cedula", "ci", "cedulapaciente", "cedula del paciente"],
  edadPaciente: ["edad", "edadpaciente"],
  unidad: ["unidad", "unidadvehicular", "vehiculo", "unidad vehicular asignada"],
  responsable: ["responsable"],
  observaciones: ["observaciones", "observacion", "notas"],
};

function mapearFilaTraslado(rawRow) {
  const found = mapearFila(rawRow, TRASLADO_ALIAS);
  return {
    fecha: found.fecha,
    tipo: String(found.tipo ?? "").trim(),
    centroDestino: String(found.centroDestino ?? "").trim(),
    nombrePaciente: String(found.nombrePaciente ?? "").trim(),
    cedulaPaciente: String(found.cedulaPaciente ?? "").trim(),
    edadPaciente: found.edadPaciente === undefined || found.edadPaciente === "" ? "" : Number(found.edadPaciente),
    unidad: String(found.unidad ?? "").trim(),
    responsable: String(found.responsable ?? "").trim(),
    observaciones: String(found.observaciones ?? "").trim(),
  };
}

function formatFechaHoraLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Formato típico de sistemas viejos: "DD/MM/AAAA hh:mm a. m./p. m."
// (día/mes/año a la venezolana, con la hora en formato de 12h en español).
// El constructor Date() nativo no entiende ese formato (y para "DD/MM"
// podría llegar a interpretarlo mal como MM/DD si algún motor fuera
// permisivo), así que se resuelve explícitamente antes de intentar
// new Date(...) como respaldo genérico.
function parsearFechaHoraLegado(str) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?\s*\.?\s*m\.?)?$/i.exec(
    String(str).trim()
  );
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss, ampm] = m;
  let hora = hh ? Number(hh) : 0;
  if (ampm) {
    const esPM = ampm.toLowerCase() === "p";
    if (hora === 12) hora = esPM ? 12 : 0;
    else if (esPM) hora += 12;
  }
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), hora, min ? Number(min) : 0, ss ? Number(ss) : 0);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Busca la institución del catálogo que corresponde a un texto libre (p.
 * ej. "Centro destino" de un archivo importado), en tres pasadas de mayor
 * a menor precisión:
 *  1. Nombre exacto (sin tildes/mayúsculas).
 *  2. Algún alias/abreviatura registrado para esa institución (separados
 *     por coma en el catálogo — p. ej. "H1SR", "SAHUM").
 *  3. Coincidencia parcial: el texto está contenido en el nombre de la
 *     institución o viceversa (para casos como "Adolfo Pons" cuando el
 *     nombre completo es "Hospital Adolfo Pons").
 * Se hacen tres pasadas completas (en vez de una sola con el mejor
 * criterio por institución) para que un nombre exacto en OTRA institución
 * siempre gane sobre una coincidencia parcial más floja.
 */
function resolverInstitucionPorTexto(texto) {
  const normalizado = quitarAcentos(texto).trim().toLowerCase();
  if (!normalizado) return null;
  const instituciones = getInstituciones();

  const porNombreExacto = instituciones.find((i) => quitarAcentos(i.nombre).trim().toLowerCase() === normalizado);
  if (porNombreExacto) return porNombreExacto;

  const porAlias = instituciones.find((i) =>
    (i.alias || "")
      .split(",")
      .map((a) => quitarAcentos(a).trim().toLowerCase())
      .filter(Boolean)
      .includes(normalizado)
  );
  if (porAlias) return porAlias;

  const porCoincidenciaParcial = instituciones.find((i) => {
    const nombreNorm = quitarAcentos(i.nombre).trim().toLowerCase();
    return nombreNorm.includes(normalizado) || normalizado.includes(nombreNorm);
  });
  return porCoincidenciaParcial || null;
}

// Instituciones que el administrador acaba de resolver manualmente durante
// esta misma sesión de importación (texto del archivo -> {id, nombre}),
// para no depender del round-trip de Firestore al revalidar la vista
// previa justo después de crear/vincular una institución.
const resolucionesManualesInstitucion = new Map();

function normalizarTexto(s) {
  return quitarAcentos(s).trim().toLowerCase();
}

function validarFilaTraslado(fila, responsableDefecto) {
  const errores = [];
  if (!fila.nombrePaciente) errores.push("falta el nombre del paciente");
  // La cédula y la edad son opcionales al importar (archivos de sistemas
  // viejos suelen no traerlas para todos los pacientes); si faltan, el
  // traslado se importa igual y el historial las muestra como "—".
  if (fila.edadPaciente !== "" && (isNaN(fila.edadPaciente) || fila.edadPaciente < 0)) errores.push("edad inválida");
  if (!fila.unidad) errores.push("falta la unidad");

  let tipoResuelto = "";
  if (fila.tipo) {
    const norm = quitarAcentos(fila.tipo).trim().toLowerCase();
    // Sinónimos usados por sistemas viejos: "Emergencia" ~ Apoyo (sin
    // centro de destino específico); "Traslado programado" ~
    // Interhospitalario (normalmente trae una institución de destino
    // específica, igual que los interhospitalarios).
    if (norm === "apoyo" || norm === "emergencia") tipoResuelto = "Apoyo";
    else if (norm === "interhospitalario" || norm === "traslado programado") tipoResuelto = "Interhospitalario";
    else errores.push(`tipo "${fila.tipo}" no reconocido (use Apoyo o Interhospitalario)`);
  } else {
    errores.push("falta el tipo");
  }

  let fechaResuelta = null;
  if (fila.fecha instanceof Date && !isNaN(fila.fecha.getTime())) {
    fechaResuelta = fila.fecha;
  } else if (fila.fecha) {
    fechaResuelta = parsearFechaHoraLegado(fila.fecha);
    if (!fechaResuelta) {
      const d = new Date(fila.fecha);
      if (!isNaN(d.getTime())) fechaResuelta = d;
    }
  }
  if (!fechaResuelta) errores.push("fecha inválida");

  const responsableResuelto = fila.responsable || responsableDefecto;
  if (!responsableResuelto) errores.push("falta el responsable");

  // La institución es obligatoria para todo traslado (igual que en el
  // formulario manual). Si el texto de "Centro destino" coincide con el
  // nombre (o algún alias/abreviatura) de una institución del catálogo, el
  // traslado queda vinculado a ella (cuenta en su estadística); si no
  // coincide con ninguna, se guarda igual como texto libre, solo que sin
  // vínculo con el catálogo.
  let institucionId = "";
  let institucionNombreResuelto = "";
  if (fila.centroDestino) {
    // Prioridad: si el administrador ya resolvió este texto manualmente en
    // esta misma importación (creó la institución o lo vinculó como alias
    // hace un momento), se usa eso directo sin esperar a que el catálogo
    // en tiempo real termine de sincronizar.
    const resueltoManual = resolucionesManualesInstitucion.get(normalizarTexto(fila.centroDestino));
    const candidato = resueltoManual || resolverInstitucionPorTexto(fila.centroDestino);
    if (candidato) {
      institucionId = candidato.id;
      institucionNombreResuelto = candidato.nombre;
    } else {
      institucionNombreResuelto = fila.centroDestino;
    }
  } else {
    errores.push("falta la institución");
  }

  return {
    ...fila,
    tipoResuelto,
    fechaResuelta,
    fechaTexto: fechaResuelta ? formatFechaHoraLocal(fechaResuelta) : "",
    responsableResuelto,
    institucionId,
    institucionNombreResuelto,
    errores,
  };
}

let filasImportacionTrasladosValidas = [];
let ultimasFilasImportacionTraslados = []; // filas mapeadas (sin validar) de la última lectura, para poder revalidar sin releer el archivo

/**
 * Muestra, arriba de la vista previa, las instituciones del archivo que NO
 * coincidieron con ninguna del catálogo (ni por nombre ni por alias) —
 * para poder resolverlas ahí mismo (crear la institución o vincularlas
 * como alias de una existente) en vez de tener que ir a Catálogos,
 * agregarlas, y volver a leer el archivo desde cero.
 */
function renderInstitucionesSinVincular(filasValidadas) {
  const root = document.getElementById("importar-traslados-instituciones-sin-vincular");
  if (!root) return;

  // Textos únicos sin vincular (case/tilde-insensible), con un texto de
  // muestra "bonito" (el primero que apareció) para mostrar en pantalla.
  const porTexto = new Map();
  filasValidadas.forEach((f) => {
    if (f.institucionNombreResuelto && !f.institucionId) {
      const clave = normalizarTexto(f.institucionNombreResuelto);
      if (!porTexto.has(clave)) porTexto.set(clave, f.institucionNombreResuelto);
    }
  });

  if (!porTexto.size) {
    root.innerHTML = "";
    return;
  }

  const instituciones = getInstituciones();
  const opcionesExistentes = instituciones
    .slice()
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .map((i) => `<option value="${i.id}">Vincular como alias de: ${escapeHTML(i.nombre)}</option>`)
    .join("");

  root.innerHTML = `
    <div class="border border-amber-300 bg-amber-50 rounded-md p-3">
      <p class="text-sm font-semibold text-amber-800 mb-1">${porTexto.size} institución(es) del archivo no coinciden con el catálogo</p>
      <p class="text-xs text-amber-700 mb-3">Para cada una, elija si se crea como institución nueva o se vincula como alias de una ya existente, y pulse "Aplicar" — así no hace falta ir a Catálogos por separado.</p>
      <div class="space-y-2">
        ${[...porTexto.values()]
          .map(
            (texto) => `
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium text-slate-700 min-w-[10rem]">"${escapeHTML(texto)}"</span>
          <select class="form-input !w-auto flex-1 min-w-[16rem] resolucion-institucion" data-texto="${escapeHTML(texto)}">
            <option value="__nueva__" selected>➕ Crear institución nueva: "${escapeHTML(texto)}"</option>
            ${opcionesExistentes}
          </select>
        </div>`
          )
          .join("")}
      </div>
      <div class="form-actions !mt-3">
        <button type="button" id="btn-aplicar-resoluciones-institucion" class="btn-secondary">Aplicar y revisar de nuevo</button>
      </div>
    </div>`;

  document.getElementById("btn-aplicar-resoluciones-institucion")?.addEventListener("click", aplicarResolucionesInstitucion);
}

async function aplicarResolucionesInstitucion() {
  const btn = document.getElementById("btn-aplicar-resoluciones-institucion");
  const selects = [...document.querySelectorAll(".resolucion-institucion")];
  if (!selects.length) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Aplicando...";
  }

  let creadas = 0;
  let vinculadas = 0;
  let fallidas = 0;

  for (const sel of selects) {
    const texto = sel.dataset.texto;
    const valor = sel.value;
    try {
      if (valor === "__nueva__") {
        const ref = await createRecord(COLLECTIONS.INSTITUCIONES, {
          nombre: texto,
          // La mayoría de los destinos de traslado son centros de salud;
          // si no corresponde, se puede corregir después en Catálogos.
          categoria: CATEGORIAS_INSTITUCIONES.includes("Hospitales / Centros de salud")
            ? "Hospitales / Centros de salud"
            : CATEGORIAS_INSTITUCIONES[0],
          alias: "",
          activo: true,
        });
        resolucionesManualesInstitucion.set(normalizarTexto(texto), { id: ref.id, nombre: texto });
        creadas++;
      } else {
        const inst = getInstituciones().find((i) => i.id === valor);
        if (!inst) throw new Error("Institución no encontrada.");
        const aliasActuales = (inst.alias || "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean);
        if (!aliasActuales.some((a) => normalizarTexto(a) === normalizarTexto(texto))) {
          aliasActuales.push(texto);
          await updateRecord(COLLECTIONS.INSTITUCIONES, inst.id, { alias: aliasActuales.join(", ") });
        }
        resolucionesManualesInstitucion.set(normalizarTexto(texto), { id: inst.id, nombre: inst.nombre });
        vinculadas++;
      }
    } catch (err) {
      console.error("Error resolviendo institución", texto, err);
      fallidas++;
    }
  }

  toast(
    `${creadas ? `${creadas} institución(es) creada(s). ` : ""}${vinculadas ? `${vinculadas} vinculada(s) como alias. ` : ""}${fallidas ? `${fallidas} con error.` : ""}`.trim() ||
      "Sin cambios.",
    fallidas ? "warning" : "success"
  );

  // Revalida las filas ya leídas (sin releer el archivo) con las
  // resoluciones recién aplicadas.
  const respField = document.getElementById("importar-traslados-responsable");
  const validadas = ultimasFilasImportacionTraslados.map((f) => validarFilaTraslado(f, respField?.value || ""));
  renderPreviewImportacionTraslados(validadas);
  renderInstitucionesSinVincular(validadas);
}

function renderPreviewImportacionTraslados(filas) {
  const root = document.getElementById("importar-traslados-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-traslados");
  if (!root) return;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Seleccione un archivo para ver la vista previa.</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    filasImportacionTrasladosValidas = [];
    return;
  }

  const validas = filas.filter((f) => f.errores.length === 0);
  filasImportacionTrasladosValidas = validas;

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${validas.length} de ${filas.length} fila(s) lista(s) para importar.</p>
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Fecha/Hora</th>
            <th class="text-left px-2 py-1.5">Tipo</th>
            <th class="text-left px-2 py-1.5">Paciente</th>
            <th class="text-left px-2 py-1.5">Cédula</th>
            <th class="text-left px-2 py-1.5">Edad</th>
            <th class="text-left px-2 py-1.5">Unidad</th>
            <th class="text-left px-2 py-1.5">Institución</th>
            <th class="text-left px-2 py-1.5">Responsable</th>
            <th class="text-left px-2 py-1.5">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${filas
            .map(
              (f) => `
          <tr class="border-t border-slate-100 ${f.errores.length ? "bg-red-50" : ""}">
            <td class="px-2 py-1.5">${f.fechaResuelta ? escapeHTML(formatDate(f.fechaTexto, true)) : "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.tipoResuelto || f.tipo) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.nombrePaciente) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.cedulaPaciente) || "—"}</td>
            <td class="px-2 py-1.5">${f.edadPaciente === "" ? "—" : f.edadPaciente}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.unidad) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.institucionNombreResuelto) || "—"}${f.institucionNombreResuelto && !f.institucionId ? ' <span class="text-amber-600">(sin vincular)</span>' : ""}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.responsableResuelto) || "—"}</td>
            <td class="px-2 py-1.5">${f.errores.length ? `<span class="text-red-700">${escapeHTML(f.errores.join(", "))}</span>` : '<span class="text-emerald-700">OK</span>'}</td>
          </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;

  if (btnConfirmar) btnConfirmar.disabled = validas.length === 0;
}

function setupImportacionTraslados() {
  const fileInput = document.getElementById("importar-traslados-archivo");
  const respField = document.getElementById("importar-traslados-responsable");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-traslados");
  if (!fileInput || !btnConfirmar) return;

  if (respField) respField.value = getResponsableLabel();

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      ultimasFilasImportacionTraslados = [];
      renderPreviewImportacionTraslados([]);
      renderInstitucionesSinVincular([]);
      return;
    }
    try {
      const { filas: rows } = await leerArchivoTabular(file, TRASLADO_ALIAS);
      const mapeadas = rows.map((r) => mapearFilaTraslado(r)).filter((f) => f.nombrePaciente || f.cedulaPaciente || f.unidad);
      ultimasFilasImportacionTraslados = mapeadas;
      const validadas = mapeadas.map((f) => validarFilaTraslado(f, respField?.value || ""));
      renderPreviewImportacionTraslados(validadas);
      renderInstitucionesSinVincular(validadas);
      if (!mapeadas.length) {
        toast("No se encontraron filas reconocibles. Verifique los encabezados de las columnas.", "warning");
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) o CSV válido.", "error");
      renderPreviewImportacionTraslados([]);
      renderInstitucionesSinVincular([]);
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionTrasladosValidas.length) return;

    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    let registrados = 0;
    let fallidos = 0;

    for (const fila of filasImportacionTrasladosValidas) {
      try {
        await createRecord(COLLECTIONS.TRASLADOS, {
          fecha: fila.fechaTexto,
          tipo: fila.tipoResuelto,
          institucionId: fila.institucionId,
          institucionNombre: fila.institucionNombreResuelto,
          nombrePaciente: fila.nombrePaciente,
          // Si el archivo no traía cédula y/o edad, se omite el campo (en
          // vez de guardar "") para que el historial las muestre como "—".
          ...(fila.cedulaPaciente ? { cedulaPaciente: fila.cedulaPaciente } : {}),
          ...(fila.edadPaciente !== "" ? { edadPaciente: fila.edadPaciente } : {}),
          unidad: fila.unidad,
          responsable: fila.responsableResuelto,
          observaciones: fila.observaciones,
        });
        registrados++;
      } catch (err) {
        console.error("Error importando traslado", fila, err);
        fallidos++;
      }
    }

    toast(
      `Importación completa: ${registrados} traslado(s) registrado(s)${fallidos ? `, ${fallidos} fila(s) con error` : ""}.`,
      fallidos ? "warning" : "success"
    );

    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionTrasladosValidas = [];
    ultimasFilasImportacionTraslados = [];
    fileInput.value = "";
    renderPreviewImportacionTraslados([]);
    renderInstitucionesSinVincular([]);
  });
}
