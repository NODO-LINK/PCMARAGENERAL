/**
 * auth.js
 * -----------------------------------------------------------------------
 * Gestión de autenticación y control de acceso basado en roles (RBAC).
 * - Inicia/cierra sesión con Firebase Authentication (email/password).
 * - Carga el perfil del usuario (rol) desde Firestore: usuarios/{uid}.
 * - Expone helpers `isAdmin()` / `isOperador()` usados por toda la UI para
 *   mostrar/ocultar controles de edición y eliminación.
 * - Permite a un administrador crear nuevas cuentas (Operador/Admin) sin
 *   perder su propia sesión, usando una instancia secundaria de Firebase.
 * -----------------------------------------------------------------------
 */
import {
  auth,
  db,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  getSecondaryAuth,
} from "./firebase.js";
import { COLLECTIONS, ROLES, DEPARTAMENTOS } from "./config.js";
import { signOut as fbSignOut } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { toast } from "./ui.js";

let currentUser = null; // { uid, email }
let currentProfile = null; // { nombre, rol, activo }

const listeners = [];

export function onAuthReady(cb) {
  listeners.push(cb);
}

function notify() {
  listeners.forEach((cb) => cb({ user: currentUser, profile: currentProfile }));
}

export function getCurrentUser() {
  return currentUser;
}
export function getCurrentProfile() {
  return currentProfile;
}
export function isAdmin() {
  return currentProfile?.rol === ROLES.ADMIN;
}
export function isOperador() {
  return currentProfile?.rol === ROLES.OPERADOR;
}
export function isHidro() {
  return currentProfile?.rol === ROLES.HIDRO;
}

/** Configuración del departamento del usuario actual, o null si es Admin/Operador. */
export function getDepartamento() {
  return DEPARTAMENTOS[currentProfile?.rol] || null;
}

/** ¿Puede la interfaz abrir esta colección? (las reglas de Firestore son la barrera real). */
export function puedeLeerColeccion(nombre) {
  const dep = getDepartamento();
  return !dep || dep.leer.includes(nombre);
}

/** ¿Puede abrir esta pantalla del menú? Admin ve todo; Operador todo menos las de administración. */
export function puedeVerVista(vista) {
  const dep = getDepartamento();
  if (dep) return dep.vistas.includes(vista);
  if (isAdmin()) return true;
  return vista !== "usuarios" && vista !== "catalogos";
}

/** Pantalla a mostrar al entrar (o si intenta abrir una que no le corresponde). */
export function vistaInicial() {
  return getDepartamento()?.vistas[0] || "dashboard";
}
export function getResponsableLabel() {
  return currentProfile?.nombre || currentUser?.email || "Usuario";
}

export async function login(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/**
 * Traduce un código de error de Firebase Auth a un mensaje concreto en
 * español, en vez de un genérico "credenciales inválidas" que mezcla
 * causas muy distintas (contraseña incorrecta, usuario no existe, dominio
 * no autorizado, cuenta deshabilitada, sin conexión...) y dificulta
 * diagnosticar qué pasó realmente.
 */
export function loginErrorMessage(err) {
  switch (err?.code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Contraseña incorrecta. Verifique que no tenga espacios ni mayúsculas de más.";
    case "auth/user-not-found":
      return "No existe una cuenta con ese correo. Verifique que esté bien escrito.";
    case "auth/invalid-email":
      return "El correo ingresado no tiene un formato válido.";
    case "auth/user-disabled":
      return "Esta cuenta fue desactivada. Contacte al administrador.";
    case "auth/too-many-requests":
      return "Demasiados intentos fallidos. Espere unos minutos e intente de nuevo.";
    case "auth/network-request-failed":
      return "Sin conexión a internet. Verifique la red e intente de nuevo.";
    case "auth/unauthorized-domain":
      return "Este sitio (" + window.location.hostname + ") no está autorizado para iniciar sesión. Avise al administrador para que lo agregue en Firebase Console → Authentication → Settings → Authorized domains.";
    default:
      return "No se pudo iniciar sesión" + (err?.code ? " (" + err.code + ")" : "") + ". Intente de nuevo o avise al administrador.";
  }
}

export async function logout() {
  await signOut(auth);
}

/** Crea un nuevo usuario (solo administradores) sin cerrar la sesión actual. */
export async function adminCreateUser({ email, password, nombre, rol }) {
  if (!isAdmin()) throw new Error("Solo un administrador puede crear usuarios.");
  const secondaryAuth = getSecondaryAuth();
  const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
  const uid = cred.user.uid;
  await setDoc(doc(db, COLLECTIONS.USUARIOS, uid), {
    email,
    nombre,
    rol,
    activo: true,
    createdAt: serverTimestamp(),
    createdBy: currentUser?.uid || null,
  });
  await fbSignOut(secondaryAuth);
  return uid;
}

/** Suscribe listeners de estado de auth y carga el perfil desde Firestore. */
export function initAuth() {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUser = null;
      currentProfile = null;
      notify();
      return;
    }
    currentUser = { uid: user.uid, email: user.email };
    try {
      const snap = await getDoc(doc(db, COLLECTIONS.USUARIOS, user.uid));
      if (snap.exists()) {
        currentProfile = snap.data();
        if (currentProfile.activo === false) {
          toast("Su cuenta se encuentra desactivada. Contacte al administrador.", "error");
          await signOut(auth);
          return;
        }
      } else {
        // Sin perfil no hay acceso: antes se creaba solo como Operador, lo
        // que le daba acceso a todo a cualquiera que lograra crear una
        // cuenta en Firebase Auth (la clave pública de la app lo permite).
        // Los perfiles los crea únicamente el administrador desde "Usuarios".
        toast("Su cuenta no tiene un perfil asignado. Contacte al administrador.", "error");
        currentUser = null;
        currentProfile = null;
        await signOut(auth);
        return;
      }
    } catch (err) {
      console.error("Error cargando perfil de usuario:", err);
      toast("No se pudo cargar el perfil del usuario.", "error");
    }
    notify();
  });
}
