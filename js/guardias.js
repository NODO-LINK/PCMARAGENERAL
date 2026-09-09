/**
 * guardias.js
 * -----------------------------------------------------------------------
 * Módulo de Guardias de Prevención.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS } from "./config.js";
import { createCrudModule } from "./moduleFactory.js";
import { formatDate, escapeHTML, toast } from "./ui.js";
import { createRecord } from "./data.js";
import { getResponsableLabel } from "./auth.js";
import { quitarAcentos, leerArchivoTabular, mapearFila, parsearFechaLegado } from "./importUtils.js";

let moduleRef = null;

export function initGuardias() {
  moduleRef = createCrudModule({
    collectionName: COLLECTIONS.GUARDIAS,
    form: document.getElementById("form-guardias"),
    historialRoot: document.getElementById("historial-guardias"),
    dateField: "fecha",
    historialTitle: "Historial de Guardias de Prevención",
    columns: [
      { key: "fecha", label: "Fecha", format: (r) => formatDate(r.fecha) },
      { key: "parroquia", label: "Parroquia" },
      { key: "lugar", label: "Lugar / Sector" },
      { key: "cantidadPersonas", label: "Personas atendidas" },
      { key: "descripcion", label: "Actividad" },
      { key: "responsable", label: "Responsable" },
    ],
    beforeSave: (data) => {
      data.cantidadPersonas = Number(data.cantidadPersonas) || 0;
      return data;
    },
  });
  setupImportacionGuardias();
  return moduleRef;
}

export function getGuardiasModule() {
  return moduleRef;
}

/* ---------------------------------------------------------------------- */
/* Importación masiva de Guardias de Prevención desde Excel/CSV            */
/* ---------------------------------------------------------------------- */
const GUARDIA_ALIAS = {
  fecha: ["fecha"],
  parroquia: ["parroquia"],
  lugar: ["lugar", "lugarosectorespecifico", "lugar o sector especifico", "sector"],
  descripcion: ["actividad", "descripcion", "descripciondetalladadelaactividad", "descripcion detallada de la actividad"],
  cantidadPersonas: ["poblacion", "cantidaddepersonas", "cantidad de personas", "cantidad de personas abarcadas", "personas atendidas"],
  responsable: ["responsable", "responsabledelaguardia", "responsable de la guardia"],
  observaciones: ["observaciones", "observacion", "notas"],
};

function mapearFilaGuardia(rawRow) {
  const found = mapearFila(rawRow, GUARDIA_ALIAS);
  return {
    fecha: found.fecha,
    parroquia: String(found.parroquia ?? "").trim(),
    lugar: String(found.lugar ?? "").trim(),
    descripcion: String(found.descripcion ?? "").trim(),
    cantidadPersonas: found.cantidadPersonas === undefined || found.cantidadPersonas === "" ? "" : Number(found.cantidadPersonas),
    responsable: String(found.responsable ?? "").trim(),
    observaciones: String(found.observaciones ?? "").trim(),
  };
}

function formatFechaLocal(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validarFilaGuardia(fila, responsableDefecto) {
  const errores = [];
  if (!fila.parroquia) errores.push("falta la parroquia");
  if (!fila.lugar) errores.push("falta el lugar / sector");
  if (!fila.descripcion) errores.push("falta la descripción de la actividad");

  // La cantidad de personas es opcional al importar (archivos de sistemas
  // viejos suelen no traerla para todas las filas); si viene, sí debe ser
  // un número válido.
  if (fila.cantidadPersonas !== "" && (isNaN(fila.cantidadPersonas) || fila.cantidadPersonas < 0)) {
    errores.push("cantidad de personas inválida");
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
    fechaResuelta,
    fechaTexto: fechaResuelta ? formatFechaLocal(fechaResuelta) : "",
    responsableResuelto,
    errores,
  };
}

let filasImportacionGuardiasValidas = [];

function renderPreviewImportacionGuardias(filas) {
  const root = document.getElementById("importar-guardias-preview");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-guardias");
  if (!root) return;

  if (!filas.length) {
    root.innerHTML = `<p class="text-xs text-slate-400 italic">Seleccione un archivo para ver la vista previa.</p>`;
    if (btnConfirmar) btnConfirmar.disabled = true;
    filasImportacionGuardiasValidas = [];
    return;
  }

  const validas = filas.filter((f) => f.errores.length === 0);
  filasImportacionGuardiasValidas = validas;

  root.innerHTML = `
    <p class="text-xs text-slate-500 mb-2">${validas.length} de ${filas.length} fila(s) lista(s) para importar.</p>
    <div class="max-h-72 overflow-y-auto border border-slate-200 rounded-md">
      <table class="min-w-full text-xs">
        <thead class="bg-slate-50 text-slate-600 sticky top-0">
          <tr>
            <th class="text-left px-2 py-1.5">Fecha</th>
            <th class="text-left px-2 py-1.5">Parroquia</th>
            <th class="text-left px-2 py-1.5">Lugar</th>
            <th class="text-left px-2 py-1.5">Actividad</th>
            <th class="text-left px-2 py-1.5">Personas</th>
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
            <td class="px-2 py-1.5">${escapeHTML(f.parroquia) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.lugar) || "—"}</td>
            <td class="px-2 py-1.5">${escapeHTML(f.descripcion) || "—"}</td>
            <td class="px-2 py-1.5">${f.cantidadPersonas === "" ? "—" : f.cantidadPersonas}</td>
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

function setupImportacionGuardias() {
  const fileInput = document.getElementById("importar-guardias-archivo");
  const respField = document.getElementById("importar-guardias-responsable");
  const btnConfirmar = document.getElementById("btn-confirmar-importacion-guardias");
  if (!fileInput || !btnConfirmar) return;

  if (respField) respField.value = getResponsableLabel();

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) {
      renderPreviewImportacionGuardias([]);
      return;
    }
    try {
      const { filas: rows } = await leerArchivoTabular(file, GUARDIA_ALIAS);
      const mapeadas = rows.map((r) => mapearFilaGuardia(r)).filter((f) => f.parroquia || f.lugar || f.descripcion);
      const validadas = mapeadas.map((f) => validarFilaGuardia(f, respField?.value || ""));
      renderPreviewImportacionGuardias(validadas);
      if (!mapeadas.length) {
        toast("No se encontraron filas reconocibles. Verifique los encabezados de las columnas.", "warning");
      }
    } catch (err) {
      console.error(err);
      toast("No se pudo leer el archivo. Verifique que sea un Excel (.xlsx/.xls) o CSV válido.", "error");
      renderPreviewImportacionGuardias([]);
    }
  });

  btnConfirmar.addEventListener("click", async () => {
    if (!filasImportacionGuardiasValidas.length) return;

    btnConfirmar.disabled = true;
    const textoOriginal = btnConfirmar.textContent;
    btnConfirmar.textContent = "Importando...";

    let registrados = 0;
    let fallidos = 0;

    for (const fila of filasImportacionGuardiasValidas) {
      try {
        await createRecord(COLLECTIONS.GUARDIAS, {
          fecha: fila.fechaTexto,
          parroquia: fila.parroquia,
          lugar: fila.lugar,
          descripcion: fila.descripcion,
          // Si el archivo no traía la cantidad de personas, se omite el
          // campo (en vez de guardar "") para que el historial la muestre
          // como "—".
          ...(fila.cantidadPersonas !== "" ? { cantidadPersonas: fila.cantidadPersonas } : {}),
          responsable: fila.responsableResuelto,
          observaciones: fila.observaciones,
        });
        registrados++;
      } catch (err) {
        console.error("Error importando guardia de prevención", fila, err);
        fallidos++;
      }
    }

    toast(
      `Importación completa: ${registrados} guardia(s) registrada(s)${fallidos ? `, ${fallidos} fila(s) con error` : ""}.`,
      fallidos ? "warning" : "success"
    );

    btnConfirmar.textContent = textoOriginal;
    btnConfirmar.disabled = true;
    filasImportacionGuardiasValidas = [];
    fileInput.value = "";
    renderPreviewImportacionGuardias([]);
  });
}
