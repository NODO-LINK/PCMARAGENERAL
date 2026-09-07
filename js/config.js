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
  HIDRO_LECTURAS: "hidroLecturas",
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

// Umbrales por defecto del nivel del Río Limón. La escala institucional es
// un índice de 0 a 9 (no metros): 0-9 pueden ser sobrescritos por el
// documento config/hidrometeorologia en Firestore desde la interfaz de
// administración.
export const UMBRALES_HIDRO_DEFAULT = {
  advertencia: 4,
  alerta: 7,
  // Endpoint/API externo que nutre automáticamente el nivel (lo alimenta
  // otra aplicación). Se deja vacío por defecto; el admin puede
  // configurarlo desde el módulo de Hidrometeorología.
  apiEndpoint: "",
  apiKey: "",
};
export const NIVEL_HIDRO_MIN = 0;
export const NIVEL_HIDRO_MAX = 9;

// Tipos de combustible fijos para el módulo de Despacho de Combustible.
export const TIPOS_COMBUSTIBLE = ["Gasolina", "Diesel"];

// Motivos fijos para un débito (salida/consumo) de inventario.
export const MOTIVOS_DEBITO_INVENTARIO = [
  "Uso operativo / Consumo",
  "Vencimiento",
  "Daño / Pérdida",
  "Donación saliente",
  "Otro",
];

// Datos institucionales usados en encabezados de pantalla e impresión.
export const INSTITUCION = {
  nombre: "Protección Civil y Administración de Desastres",
  sistema: "Sistema Integral de Gestión Operativa",
  lema: "Prevenir para proteger",
};
