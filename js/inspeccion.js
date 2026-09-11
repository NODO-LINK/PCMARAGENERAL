/**
 * inspeccion.js
 * -----------------------------------------------------------------------
 * Módulo de Gestión de Riesgo (Inspección).
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS } from "./config.js";
import { createCrudModule } from "./moduleFactory.js";
import { formatDate, escapeHTML, toast } from "./ui.js";
import { createRecord } from "./data.js";
import { getResponsableLabel } from "./auth.js";
import { quitarAcentos, leerArchivoTabular, mapearFila, parsearFechaLegado } from "./importUtils.js";

let moduleRef = null;

export function initInspeccion() {
  moduleRef = createCrudModule({
    collectionName: COLLECTIONS.INSPECCIONES,
    form: document.getElementById("form-inspeccion"),
    historialRoot: document.getElementById("historial-inspeccion"),
    dateField: "fecha",
    historialTitle: "Historial de Gestión de Riesgo (Inspección)",
    firmas: ["Inspector", "Director"],
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "institucion", label: "Institución" },
      { key: "solicitante", label: "Solicitante" },
      { key: "cedulaRif", label: "C.I. / RIF" },
      { key: "responsable", label: "Responsable" },
    ],
  });
  setupImportacionInspeccion();
  return moduleRef;
}

export function getInspeccionModule() {
  return moduleRef;
}

/* ---------------------------------------------------------------------- */
/* Importación masiva de Gestión de Riesgo (Inspección) desde Excel/CSV    */
/* ---------------------------------------------------------------------- */
const INSPECCION_ALIAS = {
  fecha: ["fecha"],
  institucion: ["institucion", "institución"],
  solicitante: ["solicitante"],
  cedulaRif: ["cedula", "rif", "cedularif", "cedula/rif", "ci", "cedula o rif", "cedula rif"],
  responsable: ["responsable"],
  observacion: ["observaciones", "observacion", "notas"],
};

function mapearFilaInspeccion(rawRow) {
  const found = mapearFila(rawRow, INSPECCION_ALIAS);
  return {
    fecha: found.fecha,
    institucion: String(found.institucion ?? "").trim(),
    solicitante: String(found.solicitante ?? "").trim(),
    cedulaRif: String(found.cedulaRif ?? "").trim(),
    responsable: String(found.responsable ?? "").trim(),
    observacion: String(found.observacion ?? "").trim(),
  };
}

function formatFechaLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validarFilaInspeccion(fila, responsableDefecto) {
  const errores = [];
  if (!fila.institucion) errores.push("falta la institución");
  if (!fila.solicitante) errores.push("falta el solicitante");
  if (!fila.cedulaRif) errores.push("falta la cédula/RIF");

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
    fechaResuelta,
    fechaTexto: fechaResuelta ? formatFechaLocal(fechaResuelta) : "",
    responsableResuelto,
    errores,
  };
}

let filasImportacionInspeccionValidas = [];

function renderPreviewImportacionInspeccion(filas) {
  const root = document.getElementById("importar-inspeccion-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-inspeccion");
  if (!root) return;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Seleccione un archivo para ver la vista previa.</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    filasImportacionInspeccionValidas = [];
    return;
  }

  const validas = filas.filter((f) => f.errores.length === 0);
  filasImportacionInspeccionValidas = validas;

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${validas.length} de ${filas.length} fila(s) lista(s) para importar.</p>
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Fecha</th>
            <th class="text-left px-2 py-1.5">Institución</th>
            <th class="text-left px-2 py-1.5">Solicitante</th>
            <th class="text-left px-2 py-1.5">C.I. / RIF</th>
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
            <td class="px-2 py-1.5">${escapeHTML(f.institucion) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.solicitante) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.cedulaRif) || "—"}</td>
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

function setupImportacionInspeccion() {
  const fileInput = document.getElementById("importar-inspeccion-archivo");
  const respField = document.getElementById("importar-inspeccion-responsable");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-inspeccion");
  if (!fileInput || !btnConfirmar) return;

  if (respField) respField.value = getResponsableLabel();

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      renderPreviewImportacionInspeccion([]);
      return;
    }
    try {
      const { filas: rows } = await leerArchivoTabular(file, INSPECCION_ALIAS);
      const mapeadas = rows.map((r) => mapearFilaInspeccion(r)).filter((f) => f.institucion || f.solicitante || f.cedulaRif);
      const validadas = mapeadas.map((f) => validarFilaInspeccion(f, respField?.value || ""));
      renderPreviewImportacionInspeccion(validadas);
      if (!mapeadas.length) {
        toast("No se encontraron filas reconocibles. Verifique los encabezados de las columnas.", "warning");
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) o CSV válido.", "error");
      renderPreviewImportacionInspeccion([]);
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionInspeccionValidas.length) return;

    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    let registrados = 0;
    let fallidos = 0;

    for (const fila of filasImportacionInspeccionValidas) {
      try {
        await createRecord(COLLECTIONS.INSPECCIONES, {
          fecha: fila.fechaTexto,
          institucion: fila.institucion,
          solicitante: fila.solicitante,
          cedulaRif: fila.cedulaRif,
          responsable: fila.responsableResuelto,
          observacion: fila.observacion,
        });
        registrados++;
      } catch (err) {
        console.error("Error importando inspección", fila, err);
        fallidos++;
      }
    }

    toast(
      `Importación completa: ${registrados} inspección(es) registrada(s)${fallidos ? `, ${fallidos} fila(s) con error` : ""}.`,
      fallidos ? "warning" : "success"
    );

    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionInspeccionValidas = [];
    fileInput.value = "";
    renderPreviewImportacionInspeccion([]);
  });
}
