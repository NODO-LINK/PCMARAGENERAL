/**
 * busqueda.js
 * -----------------------------------------------------------------------
 * Buscador común a toda la aplicación (historiales de cada módulo,
 * existencias, catálogo de insumos, listas de insumos...):
 *  - No distingue mayúsculas ni tildes ("educacion" encuentra "Educación").
 *  - Varias palabras: se buscan todas, en cualquier orden y en cualquier
 *    parte del texto ("guasare 2026" encuentra "Río Guasare — 12/10/2026").
 *  - Puede resaltar lo encontrado.
 * No depende de otros módulos para poder usarse desde cualquiera sin ciclos.
 * -----------------------------------------------------------------------
 */
const MARCAS_DIACRITICAS = /[̀-ͯ]/g;

/** Minúsculas y sin tildes; "ñ" se conserva como "n" para tolerar teclados sin ella. */
export function normalizarBusqueda(texto) {
  return String(texto ?? "").normalize("NFD").replace(MARCAS_DIACRITICAS, "").toLowerCase();
}

/** Palabras de la consulta ya normalizadas, sin vacías ni repetidas. */
export function terminosDeBusqueda(consulta) {
  return [...new Set(normalizarBusqueda(consulta).split(/\s+/).filter(Boolean))];
}

/** ¿El texto contiene TODAS las palabras de la consulta? (consulta vacía = sí) */
export function coincideBusqueda(texto, consulta) {
  const terminos = terminosDeBusqueda(consulta);
  if (!terminos.length) return true;
  const pajar = normalizarBusqueda(texto);
  return terminos.every((t) => pajar.includes(t));
}

const escapar = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Texto ya escapado para HTML, con lo encontrado envuelto en <mark>. */
export function resaltarBusqueda(texto, consulta) {
  const original = String(texto ?? "");
  const terminos = terminosDeBusqueda(consulta);
  if (!terminos.length || !original) return escapar(original);

  // Texto normalizado + a qué posición del original corresponde cada letra
  // (quitar tildes puede acortar el texto, por eso no basta con buscar directo).
  let normalizado = "";
  const posicion = [];
  [...original].forEach((ch, i) => {
    const n = normalizarBusqueda(ch);
    for (let k = 0; k < n.length; k++) posicion.push(i);
    normalizado += n;
  });
  const caracteres = [...original];

  const marcado = new Array(caracteres.length).fill(false);
  terminos.forEach((t) => {
    let desde = 0;
    for (;;) {
      const idx = normalizado.indexOf(t, desde);
      if (idx === -1) break;
      for (let k = idx; k < idx + t.length; k++) marcado[posicion[k]] = true;
      desde = idx + t.length;
    }
  });

  let html = "";
  let abierto = false;
  caracteres.forEach((ch, i) => {
    if (marcado[i] && !abierto) html += "<mark>";
    if (!marcado[i] && abierto) html += "</mark>";
    abierto = marcado[i];
    html += escapar(ch);
  });
  if (abierto) html += "</mark>";
  return html;
}
