/**
 * service-worker.js
 * -----------------------------------------------------------------------
 * Service Worker mínimo para habilitar las capacidades de PWA (instalación
 * y disponibilidad del "app shell" sin conexión). Los datos operativos
 * dependen de Firebase/Firestore en línea; este SW solo cachea los
 * archivos estáticos necesarios para que la interfaz cargue offline.
 * -----------------------------------------------------------------------
 */
// IMPORTANTE: subir este número cada vez que se publique una actualización
// de los archivos del app shell (cualquier .js/.css/.html listado abajo).
// Es lo que fuerza al navegador a descartar el caché viejo — si no se sube,
// los usuarios pueden seguir viendo código desactualizado por días, incluso
// después de recargar la página, hasta que limpien el caché a mano.
const CACHE_NAME = "pc-gestion-shell-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/app.js",
  "./js/config.js",
  "./js/firebase.js",
  "./js/auth.js",
  "./js/ui.js",
  "./js/icons.js",
  "./js/router.js",
  "./js/data.js",
  "./js/moduleFactory.js",
  "./js/importUtils.js",
  "./js/dashboard.js",
  "./js/emergencias.js",
  "./js/guardias.js",
  "./js/combustible.js",
  "./js/hidrometeorologia.js",
  "./js/educacion.js",
  "./js/inspeccion.js",
  "./js/inventario.js",
  "./js/catalogos.js",
  "./js/reportes.js",
  "./js/usuarios.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch((err) => console.warn("SW install:", err))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Estrategia: red primero para peticiones a Firebase/Firestore/Google APIs
// (los datos deben ser siempre en tiempo real); "cache first" con
// actualización en segundo plano para el resto del app shell estático.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isRemoteApi = url.origin.includes("googleapis.com") || url.origin.includes("firebaseio.com") || url.origin.includes("gstatic.com") || url.origin.includes("cdn.");

  if (event.request.method !== "GET" || isRemoteApi) return; // dejar pasar sin interceptar

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // "cache: no-store" evita que esta petición de fondo se resuelva con
      // el caché HTTP del propio navegador (que podría estar tan viejo como
      // el del Service Worker) — así la actualización en segundo plano
      // siempre trae los bytes más recientes del servidor.
      const fetchPromise = fetch(event.request, { cache: "no-store" })
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
