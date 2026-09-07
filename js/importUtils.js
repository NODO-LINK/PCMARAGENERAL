/**
 * importUtils.js
 * -----------------------------------------------------------------------
 * Lectura robusta de archivos Excel/CSV, compartida por las importaciones
 * masivas de la app (insumos, traslados, ...). Centraliza:
 *  - Detección del separador en CSV (coma o punto y coma — muy común en
 *    exportes con configuración regional en español).
 *  - Recuperación cuando el texto quedó pegado en una sola columna (típico
 *    de un CSV con ";" abierto con la configuración regional en ",").
 *  - Localización de la fila de encabezados real cuando el archivo trae
 *    título/subtítulo antes de la tabla (ej. reportes exportados con un
 *    encabezado descriptivo arriba).
 *  - Conversión de fechas de Excel a objetos Date reales (`cellDates`).
 * -----------------------------------------------------------------------
 */

export function quitarAcentos(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Busca la fila de encabezados real dentro de `filasCrudas` (arreglo de
 * arreglos, tal como lo devuelve sheet_to_json con {header:1}): la primera
 * fila con al menos 2 celdas que coincidan con algún alias de columna
 * conocido. Devuelve también, como texto, las filas anteriores al
 * encabezado — por si el llamador quiere extraer algo de ahí (ej. el
 * almacén desde el título de un reporte de un solo almacén).
 */
function extraerFilas(filasCrudasOriginal, aliasMap) {
  let filasCrudas = filasCrudasOriginal;
  if (!filasCrudas.length) return { filas: [], filasTitulo: [] };

  // Cada fila vino como una sola celda con texto delimitado (CSV mal separado).
  if (filasCrudas[0].length === 1) {
    const primeraCelda = String(filasCrudas[0][0] || "");
    const nComas = (primeraCelda.match(/,/g) || []).length;
    const nPuntoYComa = (primeraCelda.match(/;/g) || []).length;
    if (nComas || nPuntoYComa) {
      const FS = nPuntoYComa > nComas ? ";" : ",";
      filasCrudas = filasCrudas.map((fila) => String(fila[0] ?? "").split(FS));
    }
  }

  const todosLosAlias = Object.values(aliasMap).flat();
  let indiceEncabezado = -1;
  for (let i = 0; i < filasCrudas.length; i++) {
    const celdas = filasCrudas[i].map((c) => quitarAcentos(String(c)).trim().toLowerCase());
    const coincidencias = celdas.filter((c) => todosLosAlias.includes(c)).length;
    if (coincidencias >= 2) {
      indiceEncabezado = i;
      break;
    }
  }
  if (indiceEncabezado === -1) return { filas: [], filasTitulo: [] };

  const filasTitulo = filasCrudas.slice(0, indiceEncabezado).map((f) => f.join(" "));
  const encabezados = filasCrudas[indiceEncabezado].map((h) => String(h).trim());
  const filas = filasCrudas
    .slice(indiceEncabezado + 1)
    .filter((fila) => fila.some((c) => String(c).trim() !== ""))
    .map((fila) => {
      const obj = {};
      encabezados.forEach((h, i) => {
        if (h) obj[h] = fila[i] ?? "";
      });
      return obj;
    });

  return { filas, filasTitulo };
}

function leerCSV(file, aliasMap) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) {
      reject(new Error("La librería para leer Excel no está disponible."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const texto = e.target.result;
        const primeraLinea = texto.split(/\r?\n/)[0] || "";
        const nComas = (primeraLinea.match(/,/g) || []).length;
        const nPuntoYComa = (primeraLinea.match(/;/g) || []).length;
        const FS = nPuntoYComa > nComas ? ";" : ",";
        const wb = window.XLSX.read(texto, { type: "string", FS, cellDates: true });
        const hoja = wb.Sheets[wb.SheetNames[0]];
        const filasCrudas = window.XLSX.utils.sheet_to_json(hoja, { header: 1, defval: "" });
        resolve(extraerFilas(filasCrudas, aliasMap));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
    reader.readAsText(file, "utf-8");
  });
}

function leerBinario(file, aliasMap) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) {
      reject(new Error("La librería para leer Excel no está disponible."));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = window.XLSX.read(data, { type: "array", cellDates: true });
        const hoja = wb.Sheets[wb.SheetNames[0]];
        const filasCrudas = window.XLSX.utils.sheet_to_json(hoja, { header: 1, defval: "" });
        resolve(extraerFilas(filasCrudas, aliasMap));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error("No se pudo leer el archivo."));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Lee un archivo .csv/.xlsx/.xls y devuelve { filas, filasTitulo }.
 * `aliasMap` es un objeto {campo: [posiblesEncabezados...]} (sin tildes ni
 * mayúsculas) usado para reconocer cuál fila es el encabezado real.
 */
export function leerArchivoTabular(file, aliasMap) {
  return /\.csv$/i.test(file.name) ? leerCSV(file, aliasMap) : leerBinario(file, aliasMap);
}

/**
 * Mapea una fila cruda ({EncabezadoOriginal: valor}) a los campos definidos
 * en `aliasMap`, usando el primer encabezado que coincida con cada alias
 * (sin tildes/mayúsculas). No hace conversión de tipos: cada importador
 * decide cómo interpretar/validar sus propios campos.
 */
export function mapearFila(rawRow, aliasMap) {
  const found = {};
  for (const key of Object.keys(rawRow)) {
    const norm = quitarAcentos(key).trim().toLowerCase();
    for (const [campo, aliases] of Object.entries(aliasMap)) {
      if (aliases.includes(norm) && found[campo] === undefined) {
        found[campo] = rawRow[key];
      }
    }
  }
  return found;
}
