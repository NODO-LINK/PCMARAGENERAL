/**
 * monitor.js
 * -----------------------------------------------------------------------
 * Lógica del Monitor de estadísticas (pantalla fija pensada para TV, sin
 * scroll ni zoom). Es una página independiente de la app principal: no
 * importa data.js/auth.js/ui.js/router.js para mantenerse lo más liviana
 * posible (debe correr en el navegador de un Smart TV modesto).
 *
 * Acceso sin inicio de sesión manual: inicia una sesión ANÓNIMA de Firebase
 * Auth. Las reglas de Firestore (firestore.rules) solo exigen
 * `request.auth != null` para leer las colecciones operativas que usa este
 * monitor, así que basta con estar autenticado (aunque sea anónimamente)
 * para que las lecturas funcionen. Esto requiere que el método de inicio de
 * sesión "Anónimo" esté habilitado en Firebase Console → Authentication →
 * Sign-in method.
 * -----------------------------------------------------------------------
 */
import { firebaseConfig, COLLECTIONS, NIVEL_HIDRO_MAX } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

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

/* ------------------------- Utilidades de fecha -------------------------- */
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

function renderHidro() {
  const ordenadas = [...state.hidro].sort((a, b) => (toDate(b.fecha)?.getTime() || 0) - (toDate(a.fecha)?.getTime() || 0));
  const ultima = ordenadas[0];
  const nivelActual = ultima ? Number(ultima.nivel) : null;

  const now = new Date();
  const nivelesHoy = state.hidro
    .filter((r) => {
      const d = toDate(r.fecha);
      return d && isSameDay(d, now);
    })
    .map((r) => Number(r.nivel))
    .filter((n) => !isNaN(n));
  const maxHoy = nivelesHoy.length ? Math.max(...nivelesHoy) : null;

  const grandeEl = document.getElementById("m-hidro-grande");
  const chicoEl = document.getElementById("m-hidro-chico");
  const estadoEl = document.getElementById("m-hidro-estado");
  if (grandeEl) grandeEl.textContent = nivelActual !== null ? `${nivelActual} / ${NIVEL_HIDRO_MAX}` : "—";
  if (chicoEl) chicoEl.textContent = maxHoy !== null ? `${maxHoy} / ${NIVEL_HIDRO_MAX}` : "—";
  if (estadoEl) estadoEl.textContent = ultima?.estado || "Sin datos";
}

function renderAll() {
  const p = sumByPeriod(pacientesValidos(), personasPlanilla);
  setCard("pacientes", p.total, p.hoy);

  const t = countByPeriod(state.traslados);
  setCard("traslados", t.total, t.hoy);

  const f = countByPeriod(state.fallecidos);
  setCard("fallecidos", f.total, f.hoy);

  const c = sumByPeriod(state.combustible, (r) => Number(r.litros) || 0);
  setCard("combustible", c.total, c.hoy);

  const g = countByPeriod(state.guardias);
  setCard("guardias", g.mes, g.anio);

  const i = countByPeriod(state.inspecciones);
  setCard("inspeccion", i.mes, i.anio);

  const e = sumByPeriod(state.educacion, (r) => Number(r.poblacionBeneficiada) || 0);
  setCard("educacion", e.total, e.hoy);

  renderHidro();
}

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
  console.error("Monitor: falló el inicio de sesión anónimo", err);
  const el = document.getElementById("m-error");
  if (el) {
    el.textContent =
      "No se pudo conectar. Verifique que el método de inicio de sesión Anónimo esté habilitado en Firebase (Authentication → Sign-in method) y que haya conexión a internet.";
  }
});

onAuthStateChanged(auth, (user) => {
  if (user) iniciarSuscripciones();
});
