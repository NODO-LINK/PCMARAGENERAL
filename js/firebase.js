/**
 * firebase.js
 * -----------------------------------------------------------------------
 * Inicialización centralizada de Firebase (App, Auth, Firestore).
 * Todos los demás módulos importan las instancias `auth` y `db` desde aquí
 * en lugar de inicializar Firebase por su cuenta.
 * -----------------------------------------------------------------------
 */
import { firebaseConfig } from "./config.js";

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  writeBatch,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

// App principal (sesión del usuario autenticado en la UI).
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

/**
 * Firestore con persistencia offline (IndexedDB): la app sigue funcionando
 * sin conexión — puede leer los datos ya sincronizados y encolar
 * creaciones/ediciones, que se envían solas en cuanto vuelve internet. Es
 * crítico para Protección Civil: una emergencia no espera a que vuelva la
 * señal. `persistentMultipleTabManager` permite tener la app abierta en
 * varias pestañas/ventanas compartiendo el mismo caché local.
 *
 * Si el navegador no soporta IndexedDB (modo privado en algunos
 * navegadores, versiones muy antiguas), se cae de forma segura a Firestore
 * en memoria: la app sigue funcionando igual, solo sin caché offline.
 */
function createFirestore() {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (err) {
    console.warn("No se pudo habilitar la persistencia offline de Firestore; se usará solo memoria.", err);
    return getFirestore(app);
  }
}
export const db = createFirestore();

// App secundaria: se usa exclusivamente para que un administrador pueda
// crear cuentas de nuevos usuarios (Operador/Administrador) sin que la
// sesión del administrador actual se cierre o sea reemplazada por la del
// usuario recién creado (limitación conocida de Firebase Auth en cliente).
export function getSecondaryAuth() {
  const name = "secondary";
  const existing = getApps().find((a) => a.name === name);
  const secondaryApp = existing || initializeApp(firebaseConfig, name);
  return getAuth(secondaryApp);
}

// Re-exportamos utilidades de Firestore/Auth para que el resto de los
// módulos solo necesiten importar desde "./firebase.js".
export {
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction,
  writeBatch,
  Timestamp,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
};
