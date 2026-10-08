/**
 * monitor.js
 * -----------------------------------------------------------------------
 * Lógica del Monitor de estadísticas (pantalla fija pensada para TV, sin
 * scroll ni zoom).
 *
 * IMPORTANTE — escrito deliberadamente en JavaScript "clásico" (ES5: var,
 * function(), concatenación de strings, sin arrow functions, sin
 * let/const, sin template literals, sin optional chaining/nullish
 * coalescing, sin "type=module"): el navegador de algunos Smart TV es tan
 * viejo que ni siquiera ejecuta un <script type="module"> (lo ignora en
 * silencio, sin error) ni entiende sintaxis de JavaScript moderna. Por eso
 * este archivo se carga como script normal y usa el SDK "compat" de
 * Firebase (firebase-app-compat.js / firebase-auth-compat.js /
 * firebase-firestore-compat.js, cargados en monitor.html), que expone un
 * único objeto global `firebase` en vez de imports ES6. No se importa
 * nada de config.js/icons.js (eso también requeriría módulos): los pocos
 * valores que hacen falta de ahí están copiados aquí abajo a propósito.
 *
 * Conecta a DOS proyectos Firebase:
 *  - El de Protección Civil (pcmarageneral): pacientes, traslados,
 *    fallecidos, guardias, combustible, educación, inspección, hidro.
 *  - El de Gestión Humana (proteccion-civil-24fee), proyecto SEPARADO:
 *    solo para la sección "Talento Humano — quién trabaja hoy".
 *
 * Acceso sin inicio de sesión manual: ambos proyectos usan una sesión
 * ANÓNIMA de Firebase Auth. Sus reglas de Firestore solo exigen estar
 * autenticado (no un rol específico) para leer estas colecciones, así que
 * basta con tener habilitado el método de inicio de sesión "Anónimo" en
 * cada proyecto (Firebase Console → Authentication → Sign-in method).
 *
 * La sección de Talento Humano REPLICA la lógica de "¿Quién trabaja hoy?"
 * de la app Gestión Humana (NODO-LINK/Gestionhumana, función
 * calcularQuienTrabajaHoy() en su index.html) para que el conteo coincida
 * exactamente con lo que esa app muestra.
 * -----------------------------------------------------------------------
 */
(function () {
  "use strict";

  if (typeof firebase === "undefined") {
    var errEl0 = document.getElementById("m-error");
    if (errEl0) errEl0.textContent = "No se pudo cargar Firebase (revise la conexión a internet del TV).";
    return;
  }

  /* ------------------------- Proyecto Protección Civil ------------------- */
  // Copiado de js/config.js (no se puede usar import aquí).
  var firebaseConfig = {
    apiKey: "AIzaSyBvv3wz0bpuDJgBFZO9FLJpK094SlCSXY8",
    authDomain: "pcmarageneral.firebaseapp.com",
    projectId: "pcmarageneral",
    storageBucket: "pcmarageneral.firebasestorage.app",
    messagingSenderId: "515128369762",
    appId: "1:515128369762:web:3e4ce50b81ed96e075e73b",
    measurementId: "G-P13KHK9M0H",
  };
  var COLLECTIONS = {
    PACIENTES: "pacientes",
    TRASLADOS: "traslados",
    FALLECIDOS: "fallecidos",
    GUARDIAS: "guardias",
    DESPACHOS_COMBUSTIBLE: "despachosCombustible",
    EDUCACION: "educacion",
    INSPECCIONES: "gestionRiesgoInspeccion",
    HIDRO_LECTURAS: "hidroLecturas",
  };
  var NIVEL_HIDRO_MAX = 9;

  var app = firebase.initializeApp(firebaseConfig);
  var auth = app.auth();
  var db = app.firestore();

  /* ------------------------- Proyecto Gestión Humana (RRHH) -------------- */
  var rrhhFirebaseConfig = {
    apiKey: "AIzaSyAEAsudVzGY30TpQ2MATMX8T2YyFAHmuF8",
    authDomain: "proteccion-civil-24fee.firebaseapp.com",
    databaseURL: "https://proteccion-civil-24fee-default-rtdb.firebaseio.com",
    projectId: "proteccion-civil-24fee",
    storageBucket: "proteccion-civil-24fee.firebasestorage.app",
    messagingSenderId: "438564269926",
    appId: "1:438564269926:web:a67b73a12baadbd45662a7",
    measurementId: "G-JKR7T85JZ9",
  };
  var rrhhApp = firebase.initializeApp(rrhhFirebaseConfig, "rrhh");
  var rrhhAuth = rrhhApp.auth();
  var rrhhDb = rrhhApp.firestore();

  /* ------------------------- Proyecto de Asistencia (marcaciones) ---------- */
  // Un TERCER proyecto Firebase: la app que registra las marcaciones reales
  // de entrada/salida (huella/tarjeta). Gestión Humana lo usa para detectar
  // a alguien que trabajó hoy "por arreglo" sin quedar programado
  // formalmente (ni por horario, ni por cambio de guardia, ni agregado a
  // mano) — si no se cruza con esto, esas personas no aparecen en el
  // monitor aunque sí salgan en la pantalla de Gestión Humana. Config
  // copiada de NODO-LINK/Gestionhumana (asistenciaConfig en su index.html).
  var asistenciaFirebaseConfig = {
    apiKey: "AIzaSyCY3IS6fS21gdOWXfCYU7IJOyq-GcNQg8Q",
    authDomain: "asistencias-6f64c.firebaseapp.com",
    databaseURL: "https://asistencias-6f64c-default-rtdb.firebaseio.com",
    projectId: "asistencias-6f64c",
    storageBucket: "asistencias-6f64c.firebasestorage.app",
    messagingSenderId: "307076098538",
    appId: "1:307076098538:web:ff4dc6e775dcfb3f312a93",
  };
  var asistenciaApp = firebase.initializeApp(asistenciaFirebaseConfig, "asistencia");
  var asistenciaAuth = asistenciaApp.auth();
  var asistenciaDb = asistenciaApp.firestore();

  var state = {
    pacientes: [],
    traslados: [],
    fallecidos: [],
    guardias: [],
    combustible: [],
    educacion: [],
    inspecciones: [],
    hidro: [],
  };
  var rrhhState = { trabajadores: [], grupos: [], cambiosGuardia: [], asistenciaManual: [], asistExternasHoy: [] };

  /* ------------------------- Utilidades generales ------------------------- */
  function toDate(value) {
    if (!value) return null;
    if (typeof value.toDate === "function") return value.toDate(); // Firestore Timestamp
    if (value instanceof Date) return value;
    if (typeof value === "string") {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    }
    var d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d;
  }
  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function isSameMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }
  function isSameYear(a, b) {
    return a.getFullYear() === b.getFullYear();
  }
  function escapeHTML(str) {
    if (str === undefined || str === null) str = "";
    str = String(str);
    return str.replace(/[&<>"']/g, function (c) {
      if (c === "&") return "&amp;";
      if (c === "<") return "&lt;";
      if (c === ">") return "&gt;";
      if (c === '"') return "&quot;";
      return "&#39;";
    });
  }

  function sumByPeriod(rows, valueFn, dateField) {
    dateField = dateField || "fecha";
    var now = new Date();
    var hoy = 0,
      mes = 0,
      anio = 0,
      total = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var d = toDate(r[dateField]);
      var v = valueFn(r);
      total += v;
      if (d && isSameDay(d, now)) hoy += v;
      if (d && isSameMonth(d, now)) mes += v;
      if (d && isSameYear(d, now)) anio += v;
    }
    return { hoy: hoy, mes: mes, anio: anio, total: total };
  }
  function countByPeriod(rows, dateField) {
    return sumByPeriod(
      rows,
      function () {
        return 1;
      },
      dateField
    );
  }
  // La Lista Diaria de Pacientes guarda cantidades por planilla, no un
  // registro por persona: hay que sumar los campos, igual que en el
  // Dashboard principal (js/dashboard.js).
  function personasPlanilla(r) {
    return (Number(r.ninos) || 0) + (Number(r.adolescentes) || 0) + (Number(r.adultos) || 0);
  }
  // Los registros marcados como conteo histórico/manual antiguo se excluyen,
  // igual que en el Dashboard.
  function pacientesValidos() {
    var out = [];
    for (var i = 0; i < state.pacientes.length; i++) {
      if (state.pacientes[i].registroLegado !== "si") out.push(state.pacientes[i]);
    }
    return out;
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString("es-VE");
  }

  /* ------------------------- Animación de conteo en los números ----------- */
  var pedirCuadro =
    window.requestAnimationFrame ||
    window.webkitRequestAnimationFrame ||
    function (cb) {
      return setTimeout(function () {
        cb(new Date().getTime());
      }, 16);
    };
  var ANIMACION_MS = 700;
  var valoresAnimados = {}; // id del elemento -> último valor numérico mostrado
  function animarNumero(el, valorNuevo) {
    if (!el) return;
    valorNuevo = Number(valorNuevo) || 0;
    var idKey = el.id;
    var yaTenia = Object.prototype.hasOwnProperty.call(valoresAnimados, idKey);
    var valorAnterior = yaTenia ? valoresAnimados[idKey] : 0;
    if (!yaTenia) {
      // Primera vez que se pinta esta tarjeta: sin animación, solo mostrar.
      valoresAnimados[idKey] = valorNuevo;
      el.textContent = fmt(valorNuevo);
      return;
    }
    if (valorAnterior === valorNuevo) return;
    var inicio = null;
    function paso(marcaTiempo) {
      if (inicio === null) inicio = marcaTiempo;
      var progreso = Math.min(1, (marcaTiempo - inicio) / ANIMACION_MS);
      var valorActual = valorAnterior + (valorNuevo - valorAnterior) * progreso;
      el.textContent = fmt(Math.round(valorActual));
      if (progreso < 1) {
        pedirCuadro(paso);
      } else {
        el.textContent = fmt(valorNuevo);
        valoresAnimados[idKey] = valorNuevo;
      }
    }
    pedirCuadro(paso);
  }

  function setCard(id, grande, chico) {
    animarNumero(document.getElementById("m-" + id + "-grande"), grande);
    animarNumero(document.getElementById("m-" + id + "-chico"), chico);
  }
  function setTotalSolo(id, total) {
    animarNumero(document.getElementById("m-" + id + "-total"), total);
  }

  /* ------------------------- Íconos (copiados de icons.js) ---------------- */
  var RAW_ICONS = {
    emergencia: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
    combustible:
      '<path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15"/><path d="M4 11h8"/><path d="M14 8h2.5l2.5 2.5V17a1.5 1.5 0 0 1-3 0v-3"/><path d="M2 21h14"/>',
    ola: '<path d="M2 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M2 20c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
    graduacion: '<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="M6 10.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-5.5"/><path d="M22 8v6"/>',
    buscar: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    usuario: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
    escudo: '<path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z"/>',
    traslados: '<path d="M3 7h13"/><path d="m12 3 4 4-4 4"/><path d="M21 17H8"/><path d="m12 21-4-4 4-4"/>',
    fallecidos:
      '<path d="M12 2c1.2 1.6 1.8 2.8 1.8 4a1.8 1.8 0 1 1-3.6 0c0-1.2.6-2.4 1.8-4z" fill="currentColor" stroke="none"/><rect x="10" y="8" width="4" height="13" rx="1"/>',
  };
  function iconoMonitor(nombre, size) {
    size = size || 18;
    var paths = RAW_ICONS[nombre];
    if (!paths) return "";
    return (
      '<svg width="' +
      size +
      '" height="' +
      size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      paths +
      "</svg>"
    );
  }
  function pintarIconos() {
    var els = document.querySelectorAll("[data-micon]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var size = Number(el.getAttribute("data-micon-size")) || 18;
      el.innerHTML = iconoMonitor(el.getAttribute("data-micon"), size);
    }
  }

  /* ------------------------- Abreviación de nombres largos ----------------- */
  var MAPA_ACENTOS = { á: "a", é: "e", í: "i", ó: "o", ú: "u", Á: "A", É: "E", Í: "I", Ó: "O", Ú: "U", ñ: "n", Ñ: "N", ü: "u", Ü: "U" };
  function quitarAcentosLocal(s) {
    s = String(s || "");
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      out += MAPA_ACENTOS[c] || c;
    }
    return out;
  }
  // Prefijos genéricos que no distinguen una institución de otra en la TV
  // (si hay 5 "Hospital X", mostrar solo "Hospital" no ayuda a nadie) — se
  // quitan dejando el nombre propio. Ordenados del más largo/específico al
  // más corto para no cortar de más.
  var PREFIJOS_INSTITUCION = [
    "hospital universitario",
    "hospital general",
    "hospital central",
    "hospital",
    "centro de salud integral",
    "centro de diagnostico integral",
    "centro de salud",
    "centro clinico",
    "centro medico",
    "ambulatorio urbano",
    "ambulatorio rural",
    "ambulatorio",
    "instituto autonomo",
    "instituto",
    "policlinica",
    "clinica",
    "maternidad",
  ];
  var LARGO_MAX_ABREVIATURA = 20;
  function abreviarInstitucion(nombreOriginal) {
    var nombre = String(nombreOriginal || "").replace(/^\s+|\s+$/g, "");
    if (!nombre) return nombre;
    var plano = quitarAcentosLocal(nombre).toLowerCase();
    for (var i = 0; i < PREFIJOS_INSTITUCION.length; i++) {
      var pref = PREFIJOS_INSTITUCION[i];
      if (plano.indexOf(pref) === 0) {
        var resto = nombre.substring(pref.length).replace(/^[\s.,:-]+/, "");
        if (resto) nombre = resto;
        break;
      }
    }
    if (nombre.length > LARGO_MAX_ABREVIATURA) nombre = nombre.substring(0, LARGO_MAX_ABREVIATURA - 1) + "…";
    return nombre;
  }

  /* ------------------------- Gráfica: Traslados por institución ----------- */
  function renderTrasladosChart() {
    setTotalSolo("traslados", state.traslados.length);
    var counts = {};
    var orden = [];
    for (var i = 0; i < state.traslados.length; i++) {
      var r = state.traslados[i];
      var nombre = r.institucionNombre || r.centroDestino || "Sin institución";
      if (!(nombre in counts)) {
        counts[nombre] = 0;
        orden.push(nombre);
      }
      counts[nombre] += 1;
    }
    var root = document.getElementById("m-traslados-chart");
    if (!root) return;
    if (orden.length === 0) {
      root.innerHTML = '<p class="th-empty">Sin traslados registrados</p>';
      return;
    }
    orden.sort(function (a, b) {
      return counts[b] - counts[a];
    });
    var TOP_N = 6;
    var max = counts[orden[0]];
    var limite = Math.min(TOP_N, orden.length);
    var html = "";
    for (var j = 0; j < limite; j++) {
      var nombre2 = orden[j];
      var total = counts[nombre2];
      var pct = (total / max) * 100;
      html +=
        '<div class="hbar-row">' +
        '<div class="hbar-label" title="' +
        escapeHTML(nombre2) +
        '">' +
        escapeHTML(abreviarInstitucion(nombre2)) +
        "</div>" +
        '<div class="hbar-track"><div class="hbar-fill" style="width:' +
        pct +
        '%"></div></div>' +
        '<div class="hbar-value">' +
        fmt(total) +
        "</div>" +
        "</div>";
    }
    var restantes = orden.length - limite;
    if (restantes > 0) html += '<div class="hbar-more">+ ' + restantes + " institución(es) más</div>";
    root.innerHTML = html;
  }

  /* ------------------------- Gráfica: Educación (barras) ------------------ */
  function renderEducacionChart() {
    var now = new Date();
    var simulacros = 0,
      totalAnio = 0;
    for (var i = 0; i < state.educacion.length; i++) {
      var r = state.educacion[i];
      var d = toDate(r.fecha);
      if (d && isSameYear(d, now)) {
        totalAnio += 1;
        if (/^s[ií]$/i.test(String(r.simulacro || "").replace(/^\s+|\s+$/g, ""))) simulacros += 1;
      }
    }
    var formacion = totalAnio - simulacros;
    var max = Math.max(simulacros, formacion, 1);
    function barra(label, value) {
      return (
        '<div class="bar-col">' +
        '<div class="bar-value">' +
        fmt(value) +
        "</div>" +
        '<div class="bar-track"><div class="bar-fill" style="height:' +
        (value / max) * 100 +
        '%"></div></div>' +
        '<div class="bar-label">' +
        label +
        "</div>" +
        "</div>"
      );
    }
    var root = document.getElementById("m-educacion-chart");
    if (root) root.innerHTML = barra("Simulacros", simulacros) + barra("Formación", formacion);
  }

  /* ------------------------- Gráfica: Río Limón (línea) -------------------- */
  function renderHidroChart() {
    var now = new Date();
    var esteMes = [];
    for (var i = 0; i < state.hidro.length; i++) {
      var r = state.hidro[i];
      var d = toDate(r.fecha);
      if (d && isSameMonth(d, now)) esteMes.push(r);
    }
    esteMes.sort(function (a, b) {
      var da = toDate(a.fecha);
      var db2 = toDate(b.fecha);
      var ta = da ? da.getTime() : 0;
      var tb = db2 ? db2.getTime() : 0;
      return ta - tb;
    });
    var root = document.getElementById("m-hidro-svg");
    if (!root) return;
    if (esteMes.length === 0) {
      root.innerHTML = '<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#9fb0c9" font-size="13">Sin lecturas este mes</text>';
      return;
    }
    var W = 600,
      H = 220,
      PAD = 28;
    var n = esteMes.length;
    var puntos = [];
    for (var k = 0; k < n; k++) {
      var x = n === 1 ? W / 2 : PAD + (k * (W - 2 * PAD)) / (n - 1);
      var nivel = Number(esteMes[k].nivel) || 0;
      if (nivel < 0) nivel = 0;
      if (nivel > NIVEL_HIDRO_MAX) nivel = NIVEL_HIDRO_MAX;
      var y = H - PAD - (nivel / NIVEL_HIDRO_MAX) * (H - 2 * PAD);
      puntos.push(x.toFixed(1) + "," + y.toFixed(1));
    }
    var guias = [0, 3, 6, 9];
    var lineasGuia = "";
    for (var g = 0; g < guias.length; g++) {
      var n0 = guias[g];
      if (n0 > NIVEL_HIDRO_MAX) continue;
      var yGuia = H - PAD - (n0 / NIVEL_HIDRO_MAX) * (H - 2 * PAD);
      lineasGuia +=
        '<line x1="' +
        PAD +
        '" y1="' +
        yGuia +
        '" x2="' +
        (W - PAD) +
        '" y2="' +
        yGuia +
        '" stroke="#25476f" stroke-width="1"/><text x="4" y="' +
        (yGuia - 3) +
        '" fill="#9fb0c9" font-size="11">' +
        n0 +
        "</text>";
    }
    root.innerHTML =
      '<svg viewBox="0 0 ' +
      W +
      " " +
      H +
      '" preserveAspectRatio="none" style="width:100%;height:100%">' +
      lineasGuia +
      '<polyline points="' +
      puntos.join(" ") +
      '" fill="none" stroke="#e5484d" stroke-width="2.5" />' +
      "</svg>";
  }

  /* ------------------------- Talento Humano (proyecto RRHH) --------------- */
  // Fecha local (nunca toISOString/UTC: en Venezuela, UTC-4, eso adelanta el
  // día desde las 8:00pm hora local) — igual que todayISO() en Gestión Humana.
  function todayISOLocal() {
    var d = new Date();
    function pad(x) {
      x = String(x);
      return x.length < 2 ? "0" + x : x;
    }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function diasEntre(fechaInicioISO, fechaHoyISO) {
    var inicio = new Date(fechaInicioISO + "T00:00:00");
    var hoy = new Date(fechaHoyISO + "T00:00:00");
    return Math.floor((hoy.getTime() - inicio.getTime()) / 86400000);
  }
  function posicionEnCiclo(grupo, fechaHoyISO) {
    var cicloDias = (Number(grupo.diasTrabajo) || 0) + (Number(grupo.diasDescanso) || 0);
    if (cicloDias <= 0 || !grupo.fechaInicio) return { posicion: 0, cicloDias: 0 };
    var diff = diasEntre(grupo.fechaInicio, fechaHoyISO);
    var posicion = ((diff % cicloDias) + cicloDias) % cicloDias;
    return { posicion: posicion, cicloDias: cicloDias };
  }
  function grupoTrabajaHoy(grupo, fechaHoyISO) {
    if (grupo.tipoCiclo === "sin_horario") return false;
    if (grupo.tipoCiclo === "semanal") {
      var diaSemana = new Date(fechaHoyISO + "T00:00:00").getDay();
      var dias = grupo.diasSemana || [];
      return dias.indexOf(diaSemana) !== -1;
    }
    var res = posicionEnCiclo(grupo, fechaHoyISO);
    if (res.cicloDias === 0) return false;
    return res.posicion < Number(grupo.diasTrabajo);
  }
  function fechaEnRango(fechaISO, inicioISO, finISO) {
    return fechaISO >= inicioISO && fechaISO <= finISO;
  }
  function trabajadorTieneAdelantoHoy(t, hoy) {
    var lista = t.adelantos || [];
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].fechaCompensada === hoy) return lista[i];
    }
    return null;
  }
  function buscarPorId(lista, id) {
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].id === id) return lista[i];
    }
    return null;
  }
  function trabajadorCubiertoEnFecha(trabajadorId, fechaISO) {
    var lista = rrhhState.cambiosGuardia;
    for (var i = 0; i < lista.length; i++) {
      var c = lista[i];
      if (c.cubiertoId === trabajadorId && c.fecha === fechaISO) return c;
      if (c.tipo === "cambio" && c.cubreId === trabajadorId && c.fechaReciproca === fechaISO) return c;
    }
    return null;
  }
  function trabajadorCubreEnFecha(trabajadorId, fechaISO) {
    var lista = rrhhState.cambiosGuardia;
    for (var i = 0; i < lista.length; i++) {
      var c = lista[i];
      if (c.cubreId === trabajadorId && c.fecha === fechaISO) return c;
      if (c.tipo === "cambio" && c.cubiertoId === trabajadorId && c.fechaReciproca === fechaISO) return c;
    }
    return null;
  }
  function trabajadorAsignadoHoy(t, hoy) {
    if (t.tipoAsignacion === "rotativo") {
      var grupo = buscarPorId(rrhhState.grupos, t.grupoId);
      return grupo ? grupoTrabajaHoy(grupo, hoy) : false;
    }
    if (t.tipoAsignacion === "rotativo_individual") {
      if (!t.fechaInicioCiclo) return false;
      var res = posicionEnCiclo({ diasTrabajo: t.diasTrabajo, diasDescanso: t.diasDescanso, fechaInicio: t.fechaInicioCiclo }, hoy);
      if (res.cicloDias === 0) return false;
      return res.posicion < Number(t.diasTrabajo);
    }
    if (t.tipoAsignacion === "calendario") {
      var dias = t.diasCalendario || [];
      return dias.indexOf(hoy) !== -1;
    }
    if (t.tipoAsignacion === "horario_semanal") {
      var diaSemana = new Date(hoy + "T00:00:00").getDay();
      var diasS = t.diasSemana || [];
      return diasS.indexOf(diaSemana) !== -1;
    }
    return false;
  }
  // Normaliza cédulas para poder comparar aunque vengan con puntos, guiones
  // o espacios distintos entre apps (ej: "V-12.345.678" vs "12345678"), y
  // quita el prefijo de nacionalidad (V/E) — igual que normalizarCedula()
  // en Gestión Humana.
  function normalizarCedula(valor) {
    var s = String(valor || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    return s.replace(/^[VE]/, "");
  }
  function buscarTrabajadorPorCedula(cedulaNormalizada) {
    for (var i = 0; i < rrhhState.trabajadores.length; i++) {
      var t = rrhhState.trabajadores[i];
      if (t.estatus === "activo" && normalizarCedula(t.cedula) === cedulaNormalizada) return t;
    }
    return null;
  }
  // Cédulas de quienes marcaron asistencia real hoy (app de marcaciones +
  // correcciones/agregados manuales de RRHH), replicando recomputarAsistencia()
  // de Gestión Humana lo suficiente para esta sola pregunta: "¿esta cédula
  // marcó hoy?" — no hace falta reconstruir hora de entrada/salida aquí.
  function cedulasQueMarcaronHoy() {
    var hoyISO = todayISOLocal();
    var now = new Date();
    var ocultas = {};
    var correcciones = {};
    var i;
    for (i = 0; i < rrhhState.asistenciaManual.length; i++) {
      var m = rrhhState.asistenciaManual[i];
      if (m.corrigeId && m.oculta) ocultas[m.corrigeId] = true;
      else if (m.corrigeId) correcciones[m.corrigeId] = true;
    }
    var set = {};
    for (i = 0; i < rrhhState.asistExternasHoy.length; i++) {
      var a = rrhhState.asistExternasHoy[i];
      if (ocultas[a.id] || correcciones[a.id]) continue;
      var ced = normalizarCedula(a.cedula);
      if (ced) set[ced] = true;
    }
    for (i = 0; i < rrhhState.asistenciaManual.length; i++) {
      var m2 = rrhhState.asistenciaManual[i];
      if (m2.corrigeId) continue; // es una corrección/ocultamiento, no una marca nueva
      if (m2.fecha !== hoyISO) continue;
      var ced2 = normalizarCedula(m2.cedula);
      if (ced2) set[ced2] = true;
    }
    return set;
  }
  // Réplica fiel de calcularQuienTrabajaHoy() de Gestión Humana: programación
  // por horario + coberturas + inclusiones manuales + quien marcó asistencia
  // real hoy sin estar programado (ej. personal de otro grupo "por arreglo").
  function calcularQuienTrabajaHoy(fechaISO) {
    var hoy = fechaISO || todayISOLocal();
    var resultado = [];
    var idsIncluidos = {};
    var i;
    for (i = 0; i < rrhhState.trabajadores.length; i++) {
      var t = rrhhState.trabajadores[i];
      if (t.estatus !== "activo") continue;
      var cubierto = trabajadorCubiertoEnFecha(t.id, hoy);
      var cubreInfo = trabajadorCubreEnFecha(t.id, hoy);
      var programadoNormal = trabajadorAsignadoHoy(t, hoy) && !trabajadorTieneAdelantoHoy(t, hoy) && !cubierto;
      if (!programadoNormal && !cubreInfo) continue;
      var grupo = buscarPorId(rrhhState.grupos, t.grupoId);
      resultado.push({ trabajador: t, grupo: grupo });
      idsIncluidos[t.id] = true;
    }

    // Segunda pasada: quien marcó asistencia real hoy aunque no le tocaba ni
    // cubría a nadie formalmente (ej. paramédico/personal de otro grupo que
    // viene "por arreglo" sin quedar registrado como cobertura ni inclusión
    // manual) — sin esto, esas personas faltan en el monitor aunque sí
    // aparezcan en la pantalla "¿Quién trabaja hoy?" de Gestión Humana.
    var marcaronHoy = cedulasQueMarcaronHoy();
    for (var cedulaMarcada in marcaronHoy) {
      if (!marcaronHoy.hasOwnProperty(cedulaMarcada)) continue;
      var tMarcado = buscarTrabajadorPorCedula(cedulaMarcada);
      if (!tMarcado || idsIncluidos[tMarcado.id]) continue;
      var grupoMarcado = buscarPorId(rrhhState.grupos, tMarcado.grupoId);
      resultado.push({ trabajador: tMarcado, grupo: grupoMarcado });
      idsIncluidos[tMarcado.id] = true;
    }

    for (i = 0; i < rrhhState.trabajadores.length; i++) {
      var t2 = rrhhState.trabajadores[i];
      if (t2.estatus !== "activo" || idsIncluidos[t2.id]) continue;
      var inclusiones = t2.inclusionesManuales || [];
      var inclusion = null;
      for (var k = 0; k < inclusiones.length; k++) {
        if (inclusiones[k].fecha === hoy) {
          inclusion = inclusiones[k];
          break;
        }
      }
      if (!inclusion) continue;
      var grupo2 = buscarPorId(rrhhState.grupos, t2.grupoId);
      resultado.push({ trabajador: t2, grupo: grupo2 });
    }
    return resultado;
  }
  function renderTalentoHumano() {
    var root = document.getElementById("m-th-grid");
    if (!root) return;
    if (rrhhState.trabajadores.length === 0) {
      root.innerHTML = '<p class="th-empty">Cargando Talento Humano…</p>';
      return;
    }
    var hoyList = calcularQuienTrabajaHoy();
    var buckets = {};
    var orden = [];
    for (var i = 0; i < hoyList.length; i++) {
      var item = hoyList[i];
      var nombre = (item.grupo && item.grupo.nombre) || "Sin grupo";
      if (!(nombre in buckets)) {
        buckets[nombre] = 0;
        orden.push(nombre);
      }
      buckets[nombre] += 1;
    }
    if (orden.length === 0) {
      root.innerHTML = '<p class="th-empty">Nadie tiene guardia asignada para hoy.</p>';
      return;
    }
    orden.sort(function (a, b) {
      if (a === "Sin grupo") return 1;
      if (b === "Sin grupo") return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var html = "";
    for (var j = 0; j < orden.length; j++) {
      var cat = orden[j];
      html += '<div class="th-card"><div class="th-numero">' + fmt(buckets[cat]) + '</div><div class="th-nombre">' + escapeHTML(cat) + "</div></div>";
    }
    root.innerHTML = html;
  }

  /* ------------------------- Render general (Protección Civil) ------------ */
  function renderAll() {
    var p = sumByPeriod(pacientesValidos(), personasPlanilla);
    setCard("pacientes", p.total, p.hoy);

    var c = sumByPeriod(state.combustible, function (r) {
      return Number(r.litros) || 0;
    });
    setCard("combustible", c.total, c.hoy);

    var f = countByPeriod(state.fallecidos);
    setCard("fallecidos", f.total, f.hoy);

    var g = countByPeriod(state.guardias);
    setTotalSolo("guardias", g.total);

    var insp = countByPeriod(state.inspecciones);
    setTotalSolo("inspeccion", insp.total);

    renderTrasladosChart();
    renderEducacionChart();
    renderHidroChart();
  }

  /* ------------------------- Suscripciones --------------------------------- */
  function suscribir(nombreColeccion, key) {
    db.collection(nombreColeccion).onSnapshot(
      function (snap) {
        var rows = [];
        snap.forEach(function (doc) {
          rows.push(doc.data());
        });
        state[key] = rows;
        renderAll();
      },
      function (err) {
        console.error('Monitor: error leyendo "' + nombreColeccion + '":', err);
      }
    );
  }
  function iniciarSuscripciones() {
    suscribir(COLLECTIONS.PACIENTES, "pacientes");
    suscribir(COLLECTIONS.TRASLADOS, "traslados");
    suscribir(COLLECTIONS.FALLECIDOS, "fallecidos");
    suscribir(COLLECTIONS.GUARDIAS, "guardias");
    suscribir(COLLECTIONS.DESPACHOS_COMBUSTIBLE, "combustible");
    suscribir(COLLECTIONS.EDUCACION, "educacion");
    suscribir(COLLECTIONS.INSPECCIONES, "inspecciones");
    suscribir(COLLECTIONS.HIDRO_LECTURAS, "hidro");
  }

  function suscribirRRHH(nombreColeccion, key) {
    rrhhDb.collection(nombreColeccion).onSnapshot(
      function (snap) {
        var rows = [];
        snap.forEach(function (doc) {
          var data = doc.data();
          data.id = doc.id;
          rows.push(data);
        });
        rrhhState[key] = rows;
        renderTalentoHumano();
      },
      function (err) {
        console.error('Monitor: error leyendo RRHH "' + nombreColeccion + '":', err);
        var el = document.getElementById("m-th-error");
        if (el) el.textContent = "No se pudo leer Talento Humano (verifique el inicio de sesión anónimo y los permisos en el proyecto proteccion-civil-24fee).";
      }
    );
  }
  function iniciarSuscripcionesRRHH() {
    suscribirRRHH("rrhh_trabajadores", "trabajadores");
    suscribirRRHH("rrhh_grupos", "grupos");
    suscribirRRHH("rrhh_cambios_guardia", "cambiosGuardia");

    var hoyISO = todayISOLocal();
    rrhhDb
      .collection("rrhh_asistencia_manual")
      .where("fecha", "==", hoyISO)
      .onSnapshot(
        function (snap) {
          var rows = [];
          snap.forEach(function (doc) {
            var data = doc.data();
            data.id = doc.id;
            rows.push(data);
          });
          rrhhState.asistenciaManual = rows;
          renderTalentoHumano();
        },
        function (err) {
          console.error('Monitor: error leyendo RRHH "rrhh_asistencia_manual":', err);
        }
      );
  }

  function iniciarSuscripcionAsistencia() {
    var inicioHoy = new Date();
    inicioHoy.setHours(0, 0, 0, 0);
    asistenciaDb
      .collection("attendance")
      .where("timestamp", ">=", inicioHoy)
      .onSnapshot(
        function (snap) {
          var rows = [];
          snap.forEach(function (doc) {
            var data = doc.data();
            data.id = doc.id;
            rows.push(data);
          });
          rrhhState.asistExternasHoy = rows;
          renderTalentoHumano();
        },
        function (err) {
          console.error('Monitor: error leyendo asistencia ("attendance"):', err);
          var el = document.getElementById("m-th-error");
          if (el) el.textContent = "No se pudo leer la asistencia real (verifique el inicio de sesión anónimo en el proyecto asistencias-6f64c).";
        }
      );
  }

  /* ------------------------- Reloj y estado de conexión --------------------- */
  function iniciarReloj() {
    var horaEl = document.getElementById("m-hora");
    var fechaEl = document.getElementById("m-fecha");
    function pad2(n) {
      n = String(n);
      return n.length < 2 ? "0" + n : n;
    }
    function tick() {
      var now = new Date();
      if (horaEl) {
        horaEl.innerHTML =
          pad2(now.getHours()) +
          '<span class="separador">:</span>' +
          pad2(now.getMinutes()) +
          '<span class="separador">:</span>' +
          pad2(now.getSeconds());
      }
      if (fechaEl) {
        var txt = now.toLocaleDateString("es-VE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
        fechaEl.textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
      }
    }
    tick();
    setInterval(tick, 1000);
    // También recalcula Talento Humano y las gráficas por periodo cada
    // minuto, para que crucen la medianoche/el cambio de mes sin necesitar
    // un nuevo evento de Firestore.
    setInterval(function () {
      renderTalentoHumano();
      renderAll();
    }, 60000);
  }

  function iniciarEstadoConexion() {
    var el = document.getElementById("m-conexion");
    function actualizar() {
      if (!el) return;
      el.textContent = navigator.onLine ? "" : "SIN CONEXIÓN — mostrando los últimos datos recibidos";
    }
    window.addEventListener("online", actualizar);
    window.addEventListener("offline", actualizar);
    actualizar();
  }

  pintarIconos();
  iniciarReloj();
  iniciarEstadoConexion();

  auth.signInAnonymously().catch(function (err) {
    console.error("Monitor: falló el inicio de sesión anónimo (Protección Civil)", err);
    var el = document.getElementById("m-error");
    if (el) {
      el.textContent =
        "No se pudo conectar. Verifique que el inicio de sesión Anónimo esté habilitado en Firebase (Authentication → Sign-in method) y que haya conexión a internet.";
    }
  });
  auth.onAuthStateChanged(function (user) {
    if (user) iniciarSuscripciones();
  });

  rrhhAuth.signInAnonymously().catch(function (err) {
    console.error("Monitor: falló el inicio de sesión anónimo (RRHH)", err);
    var el = document.getElementById("m-th-error");
    if (el) el.textContent = "No se pudo conectar con Talento Humano. Verifique el inicio de sesión Anónimo en el proyecto proteccion-civil-24fee.";
  });
  rrhhAuth.onAuthStateChanged(function (user) {
    if (user) iniciarSuscripcionesRRHH();
  });

  asistenciaAuth.signInAnonymously().catch(function (err) {
    console.error("Monitor: falló el inicio de sesión anónimo (asistencia)", err);
    var el = document.getElementById("m-th-error");
    if (el) el.textContent = "No se pudo conectar con la asistencia real. Verifique el inicio de sesión Anónimo en el proyecto asistencias-6f64c.";
  });
  asistenciaAuth.onAuthStateChanged(function (user) {
    if (user) iniciarSuscripcionAsistencia();
  });
})();
