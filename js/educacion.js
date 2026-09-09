/**
 * educacion.js
 * -----------------------------------------------------------------------
 * Módulo de Educación.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS } from "./config.js";
import { createCrudModule } from "./moduleFactory.js";
import { formatDate, escapeHTML, toast } from "./ui.js";
import { createRecord } from "./data.js";
import { getResponsableLabel } from "./auth.js";
import { quitarAcentos, leerArchivoTabular, mapearFila, parsearFechaLegado } from "./importUtils.js";

let moduleRef = null;

export function initEducacion() {
  moduleRef = createCrudModule({
    collectionName: COLLECTIONS.EDUCACION,
    form: document.getElementById("form-educacion"),
    historialRoot: document.getElementById("historial-educacion"),
    dateField: "fecha",
    historialTitle: "Historial de Educación",
    firmas: ["Jefe de Departamento", "Director"],
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "tipoInstitucion", label: "Tipo" },
      { key: "nombre", label: "Institución / Comunidad" },
      { key: "poblacionBeneficiada", label: "Población beneficiada" },
      { key: "tema", label: "Tema impartido" },
      { key: "simulacro", label: "Simulacro" },
      { key: "responsable", label: "Responsable" },
    ],
    beforeSave: (data) => {
      data.poblacionBeneficiada = Number(data.poblacionBeneficiada) || 0;
      return data;
    },
  });
  setupImportacionEducacion();
  return moduleRef;
}

export function getEducacionModule() {
  return moduleRef;
}

/* ---------------------------------------------------------------------- */
/* Importación masiva de Educación desde Excel/CSV                         */
/* ---------------------------------------------------------------------- */
const EDUCACION_ALIAS = {
  fecha: ["fecha"],
  tipoInstitucion: ["tipo", "tipoinstitucion", "tipo de institucion"],
  nombre: ["nombre", "institucion", "comunidad", "nombre de la institucion/comunidad", "nombre de la institucion comunidad"],
  poblacionBeneficiada: ["poblacion", "poblacionbeneficiada", "poblacion beneficiada"],
  tema: ["tema", "formacion", "tema o formacion impartida"],
  simulacro: ["simulacro", "incluyo simulacro"],
  responsable: ["responsable"],
  observaciones: ["observaciones", "observacion", "notas"],
};

function mapearFilaEducacion(rawRow) {
  const found = mapearFila(rawRow, EDUCACION_ALIAS);
  return {
    fecha: found.fecha,
    tipoInstitucion: String(found.tipoInstitucion ?? "").trim(),
    nombre: String(found.nombre ?? "").trim(),
    poblacionBeneficiada: found.poblacionBeneficiada === undefined || found.poblacionBeneficiada === "" ? "" : Number(found.poblacionBeneficiada),
    tema: String(found.tema ?? "").trim(),
    simulacro: String(found.simulacro ?? "").trim(),
    responsable: String(found.responsable ?? "").trim(),
    observaciones: String(found.observaciones ?? "").trim(),
  };
}

function formatFechaLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validarFilaEducacion(fila, responsableDefecto) {
  const errores = [];
  if (!fila.nombre) errores.push("falta el nombre de la institución/comunidad");

  let tipoResuelto = "";
  if (fila.tipoInstitucion) {
    const norm = quitarAcentos(fila.tipoInstitucion).trim().toLowerCase();
    if (norm === "institucion") tipoResuelto = "Institución";
    else if (norm === "comunidad") tipoResuelto = "Comunidad";
    else errores.push(`tipo "${fila.tipoInstitucion}" no reconocido (use Institución o Comunidad)`);
  } else {
    errores.push("falta el tipo");
  }

  // La población beneficiada es opcional al importar (archivos de sistemas
  // viejos suelen no traerla para todas las filas); si viene, sí debe ser
  // un número válido.
  if (fila.poblacionBeneficiada !== "" && (isNaN(fila.poblacionBeneficiada) || fila.poblacionBeneficiada < 0)) {
    errores.push("población beneficiada inválida");
  }

  let simulacroResuelto = "";
  if (fila.simulacro) {
    const norm = quitarAcentos(fila.simulacro).trim().toLowerCase();
    if (norm === "si" || norm === "sí") simulacroResuelto = "Sí";
    else if (norm === "no") simulacroResuelto = "No";
    else errores.push(`simulacro "${fila.simulacro}" no reconocido (use Sí o No)`);
  } else {
    errores.push("falta indicar si incluyó simulacro");
  }

  let fechaResuelta = null;
  if (fila.fecha instanceof Date && !isNaN(fila.fecha.getTime())) {
    fechaResuelta = fila.fecha;
  } else if (fila.fecha) {
    fechaResuelta = parsearFechaLegado(fila.fecha);
    if (!fechaResuelta) {
      const d = new Date(fila.fecha);
      if (!isNaN(d.getTime())) fechaResuelta = d;
    }
  }
  if (!fechaResuelta) errores.push("fecha inválida");

  const responsableResuelto = fila.responsable || responsableDefecto;
  if (!responsableResuelto) errores.push("falta el responsable");

  return {
    ...fila,
    tipoResuelto,
    simulacroResuelto,
    fechaResuelta,
    fechaTexto: fechaResuelta ? formatFechaLocal(fechaResuelta) : "",
    responsableResuelto,
    errores,
  };
}

let filasImportacionEducacionValidas = [];

function renderPreviewImportacionEducacion(filas) {
  const root = document.getElementById("importar-educacion-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-educacion");
  if (!root) return;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Seleccione un archivo para ver la vista previa.</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    filasImportacionEducacionValidas = [];
    return;
  }

  const validas = filas.filter((f) => f.errores.length === 0);
  filasImportacionEducacionValidas = validas;

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${validas.length} de ${filas.length} fila(s) lista(s) para importar.</p>
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Fecha</th>
            <th class="text-left px-2 py-1.5">Tipo</th>
            <th class="text-left px-2 py-1.5">Nombre</th>
            <th class="text-left px-2 py-1.5">Población</th>
            <th class="text-left px-2 py-1.5">Tema</th>
            <th class="text-left px-2 py-1.5">Simulacro</th>
            <th class="text-left px-2 py-1.5">Responsable</th>
            <th class="text-left px-2 py-1.5">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${filas
            .map(
              (f) => `
          <tr class="border-t border-slate-100 ${f.errores.length ? "bg-red-50" : ""}">
            <td class="px-2 py-1.5">${f.fechaResuelta ? escapeHTML(formatDate(f.fechaTexto)) : "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.tipoResuelto || f.tipoInstitucion) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.nombre) || "—"}</td>
            <td class="px-2 py-1.5">${f.poblacionBeneficiada === "" ? "—" : f.poblacionBeneficiada}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.tema) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.simulacroResuelto || f.simulacro) || "—"}</td>
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

function setupImportacionEducacion() {
  const fileInput = document.getElementById("importar-educacion-archivo");
  const respField = document.getElementById("importar-educacion-responsable");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-educacion");
  if (!fileInput || !btnConfirmar) return;

  if (respField) respField.value = getResponsableLabel();

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      renderPreviewImportacionEducacion([]);
      return;
    }
    try {
      const { filas: rows } = await leerArchivoTabular(file, EDUCACION_ALIAS);
      const mapeadas = rows.map((r) => mapearFilaEducacion(r)).filter((f) => f.nombre || f.tema);
      const validadas = mapeadas.map((f) => validarFilaEducacion(f, respField?.value || ""));
      renderPreviewImportacionEducacion(validadas);
      if (!mapeadas.length) {
        toast("No se encontraron filas reconocibles. Verifique los encabezados de las columnas.", "warning");
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) o CSV válido.", "error");
      renderPreviewImportacionEducacion([]);
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionEducacionValidas.length) return;

    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    let registrados = 0;
    let fallidos = 0;

    for (const fila of filasImportacionEducacionValidas) {
      try {
        await createRecord(COLLECTIONS.EDUCACION, {
          fecha: fila.fechaTexto,
          tipoInstitucion: fila.tipoResuelto,
          nombre: fila.nombre,
          // Si el archivo no traía población, se omite el campo (en vez de
          // guardar "") para que el historial la muestre como "—".
          ...(fila.poblacionBeneficiada !== "" ? { poblacionBeneficiada: fila.poblacionBeneficiada } : {}),
          tema: fila.tema,
          simulacro: fila.simulacroResuelto,
          responsable: fila.responsableResuelto,
          observaciones: fila.observaciones,
        });
        registrados++;
      } catch (err) {
        console.error("Error importando registro de Educación", fila, err);
        fallidos++;
      }
    }

    toast(
      `Importación completa: ${registrados} registro(s) de Educación registrado(s)${fallidos ? `, ${fallidos} fila(s) con error` : ""}.`,
      fallidos ? "warning" : "success"
    );

    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionEducacionValidas = [];
    fileInput.value = "";
    renderPreviewImportacionEducacion([]);
  });
}
