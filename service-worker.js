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
const CACHE_NAME = "pc-gestion-shell-v79";
const APP_SHELL = [
  "./",
  "./index.html",
  "./rio-limon.html",
  "./js/rio-limon-app.js",
  "./manifest.json",
  "./manifest-rio-limon.json",
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

// Estrategia: las peticiones a Firebase/Google APIs/CDN/Windy no se
// interceptan (los datos deben ser siempre en tiempo real). Para los
// archivos de la propia app se usa "red primero": con conexión siempre se
// descarga la versión más reciente (y se guarda copia); si no hay red, o el
// servidor tarda más de 4 s, se sirve la copia guardada para que la app siga
// abriendo sin internet. Antes era "caché primero", y por eso después de cada
// actualización el navegador seguía mostrando código viejo hasta que el
// usuario borraba los datos del sitio a mano.
const TIEMPO_MAX_RED_MS = 4000;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isRemoteApi = url.origin.includes("googleapis.com") || url.origin.includes("firebaseio.com") || url.origin.includes("gstatic.com") || url.origin.includes("cdn.") || url.origin.includes("windy.com");

  if (event.request.method !== "GET" || isRemoteApi) return; // dejar pasar sin interceptar

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const desdeRed = fetch(event.request, { cache: "no-store" }).then((response) => {
        if (response && response.status === 200) cache.put(event.request, response.clone());
        return response;
      });
      desdeRed.catch(() => {}); // evita aviso de promesa sin atender si la red falla después del límite
      try {
        const limite = new Promise((_, rechazar) => setTimeout(() => rechazar(new Error("red lenta")), TIEMPO_MAX_RED_MS));
        return await Promise.race([desdeRed, limite]);
      } catch (err) {
        const guardada = await cache.match(event.request);
        if (guardada) return guardada;
        return desdeRed; // sin copia guardada: esperar a la red lo que haga falta
      }
    })()
  );
});
