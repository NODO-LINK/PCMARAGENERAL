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
  // Un rol por departamento: cada trabajador solo ve y usa el suyo (ver
  // DEPARTAMENTOS más abajo). Igual que HIDRO, la restricción se aplica
  // también en firestore.rules, no solo en la interfaz.
  DEP_EMERGENCIAS: "dep_emergencias",
  DEP_GUARDIAS: "dep_guardias",
  DEP_COMBUSTIBLE: "dep_combustible",
  DEP_EDUCACION: "dep_educacion",
  DEP_INSPECCION: "dep_inspeccion",
  DEP_INVENTARIO: "dep_inventario",
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

// Departamentos con acceso restringido. Para cada rol de departamento:
//  - vistas:  pantallas (data-view del menú) que puede abrir; la primera es
//             la que se muestra al entrar.
//  - modulos: módulos de js/app.js que se inicializan para ese usuario.
//  - leer:    colecciones que la interfaz le deja suscribirse. DEBE coincidir
//             con lo que firestore.rules le permite leer (las reglas son la
//             barrera real; esto evita pedir datos que el servidor rechazaría
//             y llenar la pantalla de errores de permisos).
// Emergencias necesita además el inventario (insumos usados en la lista
// diaria descuentan existencias), y Emergencias/Combustible leen el catálogo
// de instituciones para sus listas desplegables.
export const DEPARTAMENTOS = {
  [ROLES.DEP_EMERGENCIAS]: {
    nombre: "Emergencias",
    vistas: ["emergencias"],
    modulos: ["catalogos", "inventario", "emergencias"],
    leer: [
      COLLECTIONS.PACIENTES,
      COLLECTIONS.TRASLADOS,
      COLLECTIONS.FALLECIDOS,
      COLLECTIONS.INSTITUCIONES,
      COLLECTIONS.CATEGORIAS_INSUMOS,
      COLLECTIONS.INSUMOS,
      COLLECTIONS.INSUMO_STOCK,
      COLLECTIONS.DEBITOS_INVENTARIO,
    ],
  },
  [ROLES.DEP_GUARDIAS]: {
    nombre: "Guardias de Prevención",
    vistas: ["guardias"],
    modulos: ["guardias"],
    leer: [COLLECTIONS.GUARDIAS],
  },
  [ROLES.DEP_COMBUSTIBLE]: {
    nombre: "Combustible",
    vistas: ["combustible"],
    modulos: ["catalogos", "combustible"],
    leer: [COLLECTIONS.DESPACHOS_COMBUSTIBLE, COLLECTIONS.INSTITUCIONES],
  },
  [ROLES.DEP_EDUCACION]: {
    nombre: "Educación",
    vistas: ["educacion"],
    modulos: ["educacion"],
    leer: [COLLECTIONS.EDUCACION],
  },
  [ROLES.DEP_INSPECCION]: {
    nombre: "Gestión de Riesgo",
    vistas: ["inspeccion"],
    modulos: ["inspeccion"],
    leer: [COLLECTIONS.INSPECCIONES],
  },
  [ROLES.DEP_INVENTARIO]: {
    nombre: "Inventario",
    vistas: ["inventario"],
    modulos: ["catalogos", "inventario"],
    leer: [
      COLLECTIONS.CATEGORIAS_INSUMOS,
      COLLECTIONS.INSUMOS,
      COLLECTIONS.INSUMO_STOCK,
      COLLECTIONS.ENTRADAS_INVENTARIO,
      COLLECTIONS.TRANSFERENCIAS_INVENTARIO,
      COLLECTIONS.DEBITOS_INVENTARIO,
    ],
  },
  // Hidrometeorología tiene su propia página (rio-limon.html); se lista aquí
  // para que el control de lectura por colección sea uniforme.
  [ROLES.HIDRO]: {
    nombre: "Hidrometeorología",
    vistas: ["hidro"],
    modulos: ["hidro"],
    leer: [COLLECTIONS.HIDRO_LECTURAS, COLLECTIONS.RIOS, COLLECTIONS.ESTACIONES_PLUVIOMETRICAS, COLLECTIONS.PLUVIOMETRIA_LECTURAS],
  },
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

// Clave de la API "Map Forecast" de Windy.com — necesaria para que el mapa
// de estaciones de Pluviometría sea un mapa real de Windy (con la capa de
// lluvia) y a la vez pueda mostrar los marcadores propios de cada estación
// (esto NO es posible con el widget <iframe> de Windy usado en "Pronóstico
// del tiempo", porque un iframe de otro dominio no se puede modificar desde
// afuera). Es gratuita para uso no comercial: se obtiene creando una cuenta
// en https://api.windy.com → sección "API keys" → generar una clave de tipo
// "Map Forecast API" → pegarla aquí. Sin esta clave, ese mapa no carga.
export const WINDY_API_KEY = "wzuVbMacnel0H6legMe7UmmY5C6tK8bz";

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
