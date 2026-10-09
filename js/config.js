/**
 * config.js
 * -----------------------------------------------------------------------
 * Configuración central de la aplicación.
 *
 * Conectado al proyecto Firebase "pcmarageneral". La `apiKey` de un SDK web
 * de Firebase no es un secreto (identifica el proyecto, no autoriza por sí
 * sola); el control de acceso real lo aplican las reglas de seguridad en
 * `firestore.rules` y, opcionalmente, la restricción por dominio HTTP de
 * esta key en Google Cloud Console → APIs & Services → Credentials.
 * -----------------------------------------------------------------------
 */

// Configuración del proyecto Firebase.
export const firebaseConfig = {
  apiKey: "AIzaSyBvv3wz0bpuDJgBFZO9FLJpK094SlCSXY8",
  authDomain: "pcmarageneral.firebaseapp.com",
  projectId: "pcmarageneral",
  storageBucket: "pcmarageneral.firebasestorage.app",
  messagingSenderId: "515128369762",
  appId: "1:515128369762:web:3e4ce50b81ed96e075e73b",
  measurementId: "G-P13KHK9M0H",
};

// Roles soportados por el sistema.
export const ROLES = {
  ADMIN: "admin",
  OPERADOR: "operador",
  // Rol restringido: solo puede leer/escribir en Hidrometeorología
  // (Fluviometría — todos los ríos — y Pluviometría). Pensado para dar
  // acceso a un trabajador externo a ese único departamento sin exponerle
  // el resto de los módulos — la restricción se aplica también en
  // firestore.rules, no solo en la interfaz.
  HIDRO: "hidro",
};

// Nombres de colecciones de Firestore (única fuente de verdad para evitar
// errores de tipeo en el resto de los módulos).
export const COLLECTIONS = {
  USUARIOS: "usuarios",
  PACIENTES: "pacientes", // Lista diaria de pacientes atendidos
  TRASLADOS: "traslados",
  FALLECIDOS: "fallecidos",
  GUARDIAS: "guardias",
  INSTITUCIONES: "instituciones",
  DESPACHOS_COMBUSTIBLE: "despachosCombustible",
  // Hidrometeorología / Fluviometría: lecturas de nivel por río (el campo
  // rioId distingue a cuál pertenece cada una). Se mantiene este nombre de
  // colección por compatibilidad con los registros ya cargados antes de
  // que existiera más de un río — ver DEFAULT_RIO_ID más abajo.
  HIDRO_LECTURAS: "hidroLecturas",
  RIOS: "rios",
  // Hidrometeorología / Pluviometría: estaciones de lluvia INDEPENDIENTES
  // de los ríos (no comparten datos con Fluviometría, aunque vivan en el
  // mismo módulo de la interfaz).
  ESTACIONES_PLUVIOMETRICAS: "estacionesPluviometricas",
  PLUVIOMETRIA_LECTURAS: "pluviometriaLecturas",
  CONFIG: "config",
  EDUCACION: "educacion",
  INSPECCIONES: "gestionRiesgoInspeccion",
  CATEGORIAS_INSUMOS: "categoriasInsumos",
  INSUMOS: "insumos",
  INSUMO_STOCK: "insumoStock",
  ENTRADAS_INVENTARIO: "entradasInventario",
  TRANSFERENCIAS_INVENTARIO: "transferenciasInventario",
  DEBITOS_INVENTARIO: "debitosInventario",
  CIERRES_DIARIOS: "cierresDiarios",
};

// Almacenes / ubicaciones de inventario independientes entre sí.
export const ALMACENES = ["Depósito", "Módulo", "Oficina", "Ambulancia"];

// Categorías fijas del catálogo maestro de instituciones para el módulo de
// combustible (evita duplicidad y errores de tipeo).
export const CATEGORIAS_INSTITUCIONES = [
  "Organismos de seguridad",
  "Hospitales / Centros de salud",
  "Entes municipales",
  "Entes estadales / nacionales",
  "Organismos de socorro",
  "Otros",
];

// Umbrales por defecto para un río NUEVO (0 a 9, admite decimales). Cada
// río guarda sus propios umbrales de advertencia/alerta en su documento de
// rios/{id} (pueden ser distintos entre ríos); esto es solo el valor
// inicial que se precarga al crear uno.
export const UMBRALES_HIDRO_DEFAULT = {
  advertencia: 4,
  alerta: 7,
};
export const NIVEL_HIDRO_MIN = 0;
export const NIVEL_HIDRO_MAX = 9;

// Id FIJO (no autogenerado) del río "Río Limón" en la colección `rios`: se
// sembró con este id a propósito para que las lecturas ya cargadas ANTES
// de que existiera más de un río (que no tienen campo `rioId`) se puedan
// seguir tratando como suyas sin tener que migrar cada documento viejo uno
// por uno — ver `rioIdDeLectura()` en hidrometeorologia.js.
export const DEFAULT_RIO_ID = "limon";
export const DEFAULT_RIO_NOMBRE = "Río Limón";

// Tipos de combustible fijos para el módulo de Despacho de Combustible.
export const TIPOS_COMBUSTIBLE = ["Gasolina", "Diesel"];

// Motivos fijos para un débito (salida/consumo) de inventario.
export const MOTIVOS_DEBITO_INVENTARIO = [
  "Uso operativo / Consumo",
  "Vencimiento",
  "Daño / Pérdida",
  "Donación saliente",
  "Ajuste de inventario (conteo físico)",
  "Otro",
];

// Datos institucionales usados en encabezados de pantalla e impresión.
export const INSTITUCION = {
  nombre: "Protección Civil y Administración de Desastres",
  sistema: "Sistema Integral de Gestión Operativa",
  lema: "Prevenir para proteger",
};
