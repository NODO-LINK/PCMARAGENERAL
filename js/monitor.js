/**
 * monitor.js
 * -----------------------------------------------------------------------
 * Lógica del Monitor de estadísticas (pantalla fija pensada para TV, sin
 * scroll ni zoom). Es una página independiente de la app principal: no
 * importa data.js/auth.js/ui.js/router.js para mantenerse lo más liviana
 * posible (debe correr en el navegador de un Smart TV modesto).
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
 * exactamente con lo que esa app muestra: trabajadores activos programados
 * hoy según su horario (rotativo de grupo, rotativo individual, calendario
 * específico u horario semanal), restando adelantos ya compensados y
 * sumando coberturas de cambios de guardia — SIN restar quienes están de
 * reposo/permiso/vacaciones/sancionados (esa app tampoco los resta del
 * conteo, solo los marca como conflicto en la tarjeta de cada persona).
 * -----------------------------------------------------------------------
 */
import { firebaseConfig, COLLECTIONS, NIVEL_HIDRO_MAX } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

/* ------------------------- Proyecto Protección Civil --------------------- */
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ------------------------- Proyecto Gestión Humana (RRHH) ----------------- */
// App Firebase SEPARADA (otro proyecto): se inicializa con un nombre propio
// ("rrhh") para no chocar con la app principal de arriba.
const rrhhFirebaseConfig = {
  apiKey: "AIzaSyAEAsudVzGY30TpQ2MATMX8T2YyFAHmuF8",
  authDomain: "proteccion-civil-24fee.firebaseapp.com",
  databaseURL: "https://proteccion-civil-24fee-default-rtdb.firebaseio.com",
  projectId: "proteccion-civil-24fee",
  storageBucket: "proteccion-civil-24fee.firebasestorage.app",
  messagingSenderId: "438564269926",
  appId: "1:438564269926:web:a67b73a12baadbd45662a7",
  measurementId: "G-JKR7T85JZ9",
};
const rrhhApp = initializeApp(rrhhFirebaseConfig, "rrhh");
const rrhhAuth = getAuth(rrhhApp);
const rrhhDb = getFirestore(rrhhApp);

const state = {
  pacientes: [],
  traslados: [],
  fallecidos: [],
  guardias: [],
  combustible: [],
  educacion: [],
  inspecciones: [],
  hidro: [],
};
const rrhhState = { trabajadores: [], grupos: [], cambiosGuardia: [] };

/* ------------------------- Utilidades generales --------------------------- */
function toDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate(); // Firestore Timestamp
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
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
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function sumByPeriod(rows, valueFn, dateField = "fecha") {
  const now = new Date();
  let hoy = 0,
    mes = 0,
    anio = 0;
  rows.forEach((r) => {
    const d = toDate(r[dateField]);
    const v = valueFn(r);
    if (d && isSameDay(d, now)) hoy += v;
    if (d && isSameMonth(d, now)) mes += v;
    if (d && isSameYear(d, now)) anio += v;
  });
  const total = rows.reduce((s, r) => s + valueFn(r), 0);
  return { hoy, mes, anio, total };
}
function countByPeriod(rows, dateField = "fecha") {
  return sumByPeriod(rows, () => 1, dateField);
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
  return state.pacientes.filter((r) => r.registroLegado !== "si");
}

const fmt = (n) => Number(n || 0).toLocaleString("es-VE");

function setCard(id, grande, chico) {
  const grandeEl = document.getElementById(`m-${id}-grande`);
  const chicoEl = document.getElementById(`m-${id}-chico`);
  if (grandeEl) grandeEl.textContent = fmt(grande);
  if (chicoEl) chicoEl.textContent = fmt(chico);
}
function setTotalSolo(id, total) {
  const el = document.getElementById(`m-${id}-total`);
  if (el) el.textContent = fmt(total);
}

/* ------------------------- Gráfica de barras: Educación -------------------- */
// Simulacros vs. Formación (actividades sin simulacro), del año en curso.
function renderEducacionChart() {
  const now = new Date();
  const esteAnio = state.educacion.filter((r) => {
    const d = toDate(r.fecha);
    return d && isSameYear(d, now);
  });
  const simulacros = esteAnio.filter((r) => /^s[ií]$/i.test(String(r.simulacro || "").trim())).length;
  const formacion = esteAnio.length - simulacros;
  const max = Math.max(simulacros, formacion, 1);

  const barra = (label, value) => `
    <div class="bar-col">
      <div class="bar-value">${fmt(value)}</div>
      <div class="bar-track"><div class="bar-fill" style="height:${(value / max) * 100}%"></div></div>
      <div class="bar-label">${label}</div>
    </div>`;

  const root = document.getElementById("m-educacion-chart");
  if (root) root.innerHTML = barra("Simulacros", simulacros) + barra("Formación", formacion);
}

/* ------------------------- Gráfica de línea: Río Limón ---------------------- */
// Nivel (0 a NIVEL_HIDRO_MAX) de todas las lecturas del mes en curso.
function renderHidroChart() {
  const now = new Date();
  const esteMes = state.hidro
    .filter((r) => {
      const d = toDate(r.fecha);
      return d && isSameMonth(d, now);
    })
    .sort((a, b) => (toDate(a.fecha)?.getTime() || 0) - (toDate(b.fecha)?.getTime() || 0));

  const root = document.getElementById("m-hidro-svg");
  if (!root) return;

  if (!esteMes.length) {
    root.innerHTML = `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#9fb0c9" font-size="13">Sin lecturas este mes</text>`;
    return;
  }

  const W = 600,
    H = 220,
    PAD = 28;
  const n = esteMes.length;
  const puntos = esteMes.map((r, idx) => {
    const x = n === 1 ? W / 2 : PAD + (idx * (W - 2 * PAD)) / (n - 1);
    const nivel = Math.max(0, Math.min(NIVEL_HIDRO_MAX, Number(r.nivel) || 0));
    const y = H - PAD - (nivel / NIVEL_HIDRO_MAX) * (H - 2 * PAD);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lineasGuia = [0, 3, 6, 9]
    .filter((n0) => n0 <= NIVEL_HIDRO_MAX)
    .map((n0) => {
      const y = H - PAD - (n0 / NIVEL_HIDRO_MAX) * (H - 2 * PAD);
      return `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#25476f" stroke-width="1"/><text x="4" y="${y - 3}" fill="#9fb0c9" font-size="11">${n0}</text>`;
    })
    .join("");

  root.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%">
      ${lineasGuia}
      <polyline points="${puntos.join(" ")}" fill="none" stroke="#e5484d" stroke-width="2.5" />
    </svg>`;
}

/* ------------------------- Talento Humano (proyecto RRHH) ------------------ */
// Fecha local (nunca toISOString/UTC: en Venezuela, UTC-4, eso adelanta el
// día desde las 8:00pm hora local) — igual que todayISO() en Gestión Humana.
function todayISOLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function diasEntre(fechaInicioISO, fechaHoyISO) {
  const inicio = new Date(fechaInicioISO + "T00:00:00");
  const hoy = new Date(fechaHoyISO + "T00:00:00");
  return Math.floor((hoy - inicio) / 86400000);
}
function posicionEnCiclo(grupo, fechaHoyISO) {
  const cicloDias = (Number(grupo.diasTrabajo) || 0) + (Number(grupo.diasDescanso) || 0);
  if (cicloDias <= 0 || !grupo.fechaInicio) return { posicion: 0, cicloDias: 0 };
  const diff = diasEntre(grupo.fechaInicio, fechaHoyISO);
  const posicion = ((diff % cicloDias) + cicloDias) % cicloDias;
  return { posicion, cicloDias };
}
function grupoTrabajaHoy(grupo, fechaHoyISO) {
  if (grupo.tipoCiclo === "sin_horario") return false;
  if (grupo.tipoCiclo === "semanal") {
    const diaSemana = new Date(fechaHoyISO + "T00:00:00").getDay();
    return (grupo.diasSemana || []).includes(diaSemana);
  }
  const { posicion, cicloDias } = posicionEnCiclo(grupo, fechaHoyISO);
  if (cicloDias === 0) return false;
  return posicion < Number(grupo.diasTrabajo);
}
function fechaEnRango(fechaISO, inicioISO, finISO) {
  return fechaISO >= inicioISO && fechaISO <= finISO;
}
function trabajadorEnReposoHoy(t, hoy) {
  return (t.reposos || []).find((r) => fechaEnRango(hoy, r.fechaInicio, r.fechaFin));
}
function trabajadorEnPermisoHoy(t, hoy) {
  return (t.permisos || []).find((p) => fechaEnRango(hoy, p.fechaInicio, p.fechaFin));
}
function trabajadorEnVacacionesHoy(t, hoy) {
  return (t.vacaciones || []).find((v) => fechaEnRango(hoy, v.fechaInicio, v.fechaFin));
}
function trabajadorTieneAdelantoHoy(t, hoy) {
  return (t.adelantos || []).find((a) => a.fechaCompensada === hoy);
}
function trabajadorCubiertoEnFecha(trabajadorId, fechaISO) {
  return rrhhState.cambiosGuardia.find(
    (c) => (c.cubiertoId === trabajadorId && c.fecha === fechaISO) || (c.tipo === "cambio" && c.cubreId === trabajadorId && c.fechaReciproca === fechaISO)
  );
}
function trabajadorCubreEnFecha(trabajadorId, fechaISO) {
  return rrhhState.cambiosGuardia.find(
    (c) => (c.cubreId === trabajadorId && c.fecha === fechaISO) || (c.tipo === "cambio" && c.cubiertoId === trabajadorId && c.fechaReciproca === fechaISO)
  );
}
function trabajadorAsignadoHoy(t, hoy) {
  if (t.tipoAsignacion === "rotativo") {
    const grupo = rrhhState.grupos.find((g) => g.id === t.grupoId);
    return grupo ? grupoTrabajaHoy(grupo, hoy) : false;
  }
  if (t.tipoAsignacion === "rotativo_individual") {
    if (!t.fechaInicioCiclo) return false;
    const { posicion, cicloDias } = posicionEnCiclo({ diasTrabajo: t.diasTrabajo, diasDescanso: t.diasDescanso, fechaInicio: t.fechaInicioCiclo }, hoy);
    if (cicloDias === 0) return false;
    return posicion < Number(t.diasTrabajo);
  }
  if (t.tipoAsignacion === "calendario") return (t.diasCalendario || []).includes(hoy);
  if (t.tipoAsignacion === "horario_semanal") {
    const diaSemana = new Date(hoy + "T00:00:00").getDay();
    return (t.diasSemana || []).includes(diaSemana);
  }
  return false;
}
// Réplica fiel de calcularQuienTrabajaHoy() de Gestión Humana (solo la parte
// de programación por horario + coberturas + inclusiones manuales; se omite
// a propósito la parte de "marcó asistencia sin estar programado", ya que no
// leemos aquí los registros de asistencia real, solo la programación).
function calcularQuienTrabajaHoy(fechaISO = todayISOLocal()) {
  const hoy = fechaISO;
  const resultado = [];
  const idsIncluidos = new Set();

  rrhhState.trabajadores
    .filter((t) => t.estatus === "activo")
    .forEach((t) => {
      const cubierto = trabajadorCubiertoEnFecha(t.id, hoy);
      const cubreInfo = trabajadorCubreEnFecha(t.id, hoy);
      const programadoNormal = trabajadorAsignadoHoy(t, hoy) && !trabajadorTieneAdelantoHoy(t, hoy) && !cubierto;
      if (!programadoNormal && !cubreInfo) return;
      const grupo = rrhhState.grupos.find((g) => g.id === t.grupoId);
      resultado.push({ trabajador: t, grupo });
      idsIncluidos.add(t.id);
    });

  rrhhState.trabajadores
    .filter((t) => t.estatus === "activo" && !idsIncluidos.has(t.id))
    .forEach((t) => {
      const inclusion = (t.inclusionesManuales || []).find((i) => i.fecha === hoy);
      if (!inclusion) return;
      const grupo = rrhhState.grupos.find((g) => g.id === t.grupoId);
      resultado.push({ trabajador: t, grupo });
    });

  return resultado;
}

function renderTalentoHumano() {
  const root = document.getElementById("m-th-grid");
  if (!root) return;
  if (!rrhhState.trabajadores.length) {
    root.innerHTML = `<p class="th-empty">Cargando Talento Humano…</p>`;
    return;
  }
  const hoyList = calcularQuienTrabajaHoy();
  const buckets = {};
  hoyList.forEach((item) => {
    const nombre = item.grupo?.nombre || "Sin grupo";
    buckets[nombre] = (buckets[nombre] || 0) + 1;
  });
  const categorias = Object.keys(buckets).sort((a, b) => {
    if (a === "Sin grupo") return 1;
    if (b === "Sin grupo") return -1;
    return a.localeCompare(b, "es");
  });
  if (!categorias.length) {
    root.innerHTML = `<p class="th-empty">Nadie tiene guardia asignada para hoy.</p>`;
    return;
  }
  root.innerHTML = categorias
    .map(
      (cat) => `
    <div class="th-card">
      <div class="th-numero">${fmt(buckets[cat])}</div>
      <div class="th-nombre">${escapeHTML(cat)}</div>
    </div>`
    )
    .join("");
}

/* ------------------------- Render general (Protección Civil) --------------- */
function renderAll() {
  const p = sumByPeriod(pacientesValidos(), personasPlanilla);
  setCard("pacientes", p.total, p.hoy);

  const t = countByPeriod(state.traslados);
  setCard("traslados", t.total, t.hoy);

  const c = sumByPeriod(state.combustible, (r) => Number(r.litros) || 0);
  setCard("combustible", c.total, c.hoy);

  const f = countByPeriod(state.fallecidos);
  setTotalSolo("fallecidos", f.total);

  const g = countByPeriod(state.guardias);
  setTotalSolo("guardias", g.total);

  const i = countByPeriod(state.inspecciones);
  setTotalSolo("inspeccion", i.total);

  renderEducacionChart();
  renderHidroChart();
}

/* ------------------------- Suscripciones ------------------------------------ */
function suscribir(nombreColeccion, key) {
  onSnapshot(
    collection(db, nombreColeccion),
    (snap) => {
      state[key] = snap.docs.map((d) => d.data());
      renderAll();
    },
    (err) => console.error(`Monitor: error leyendo "${nombreColeccion}":`, err)
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
  onSnapshot(
    collection(rrhhDb, nombreColeccion),
    (snap) => {
      rrhhState[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderTalentoHumano();
    },
    (err) => {
      console.error(`Monitor: error leyendo RRHH "${nombreColeccion}":`, err);
      const el = document.getElementById("m-th-error");
      if (el) el.textContent = "No se pudo leer Talento Humano (verifique el inicio de sesión anónimo y los permisos en el proyecto proteccion-civil-24fee).";
    }
  );
}
function iniciarSuscripcionesRRHH() {
  suscribirRRHH("rrhh_trabajadores", "trabajadores");
  suscribirRRHH("rrhh_grupos", "grupos");
  suscribirRRHH("rrhh_cambios_guardia", "cambiosGuardia");
}

/* ------------------------- Reloj y estado de conexión ----------------------- */
function iniciarReloj() {
  const horaEl = document.getElementById("m-hora");
  const fechaEl = document.getElementById("m-fecha");
  function tick() {
    const now = new Date();
    if (horaEl) horaEl.textContent = now.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (fechaEl) {
      const txt = now.toLocaleDateString("es-VE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
      fechaEl.textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
    }
  }
  tick();
  setInterval(tick, 1000);
  // El reloj también dispara el recálculo de Talento Humano y de las
  // gráficas por periodo, para que crucen la medianoche/el cambio de mes
  // sin necesitar un nuevo evento de Firestore.
  setInterval(() => {
    renderTalentoHumano();
    renderAll();
  }, 60000);
}

function iniciarEstadoConexion() {
  const el = document.getElementById("m-conexion");
  function actualizar() {
    if (!el) return;
    el.textContent = navigator.onLine ? "" : "SIN CONEXIÓN — mostrando los últimos datos recibidos";
  }
  window.addEventListener("online", actualizar);
  window.addEventListener("offline", actualizar);
  actualizar();
}

iniciarReloj();
iniciarEstadoConexion();

signInAnonymously(auth).catch((err) => {
  console.error("Monitor: falló el inicio de sesión anónimo (Protección Civil)", err);
  const el = document.getElementById("m-error");
  if (el) {
    el.textContent =
      "No se pudo conectar. Verifique que el inicio de sesión Anónimo esté habilitado en Firebase (Authentication → Sign-in method) y que haya conexión a internet.";
  }
});
onAuthStateChanged(auth, (user) => {
  if (user) iniciarSuscripciones();
});

signInAnonymously(rrhhAuth).catch((err) => {
  console.error("Monitor: falló el inicio de sesión anónimo (RRHH)", err);
  const el = document.getElementById("m-th-error");
  if (el) el.textContent = "No se pudo conectar con Talento Humano. Verifique el inicio de sesión Anónimo en el proyecto proteccion-civil-24fee.";
});
onAuthStateChanged(rrhhAuth, (user) => {
  if (user) iniciarSuscripcionesRRHH();
});
