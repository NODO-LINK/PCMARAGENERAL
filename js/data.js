/**
 * data.js
 * -----------------------------------------------------------------------
 * Capa genérica de acceso a datos sobre Firestore, utilizada por todos los
 * módulos operativos para evitar repetir lógica de creación, edición,
 * eliminación y suscripción en tiempo real.
 *
 * Reglas de negocio aplicadas aquí (y reforzadas en firestore.rules):
 *  - CREATE: permitido a Operador y Administrador. Se agrega trazabilidad
 *    automática (createdAt, createdBy, createdByEmail).
 *  - UPDATE / DELETE: exclusivo de Administrador. Un Operador que intente
 *    invocar estas funciones recibe un error de la capa de aplicación (y
 *    sería igualmente rechazado por las reglas de seguridad de Firestore).
 * -----------------------------------------------------------------------
 */
import {
  db,
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "./firebase.js";
import { isAdmin, getCurrentUser, getResponsableLabel, puedeLeerColeccion } from "./auth.js";
import { toast } from "./ui.js";

/**
 * Suscribe una colección completa ordenada por un campo (desc) y notifica
 * cada cambio en tiempo real.
 * @returns {Function} función para cancelar la suscripción.
 */
export function subscribeCollection(collectionName, orderField, cb) {
  // Un usuario de departamento solo lee sus propias colecciones (ver
  // DEPARTAMENTOS en config.js): para el resto no se pide nada al servidor
  // (que lo rechazaría) y el módulo recibe simplemente una lista vacía.
  if (!puedeLeerColeccion(collectionName)) {
    setTimeout(() => cb([]), 0);
    return () => {};
  }
  const q = query(collection(db, collectionName), orderBy(orderField, "desc"));
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      cb(rows);
    },
    (err) => {
      console.error(`Error al escuchar ${collectionName}:`, err);
      toast(`No se pudo cargar "${collectionName}". Verifique su conexión o permisos.`, "error");
    }
  );
}

export async function createRecord(collectionName, data) {
  const user = getCurrentUser();
  return addDoc(collection(db, collectionName), {
    ...data,
    createdAt: serverTimestamp(),
    createdBy: user?.uid || null,
    createdByEmail: user?.email || null,
  });
}

export async function updateRecord(collectionName, id, data) {
  if (!isAdmin()) {
    toast("Solo un administrador puede editar registros históricos.", "error");
    throw new Error("Permiso denegado: se requiere rol administrador.");
  }
  return updateDoc(doc(db, collectionName, id), {
    ...data,
    updatedAt: serverTimestamp(),
    updatedBy: getCurrentUser()?.uid || null,
  });
}

export async function deleteRecord(collectionName, id) {
  if (!isAdmin()) {
    toast("Solo un administrador puede eliminar registros.", "error");
    throw new Error("Permiso denegado: se requiere rol administrador.");
  }
  return deleteDoc(doc(db, collectionName, id));
}

export { getResponsableLabel };
