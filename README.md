# Protección Civil — Sistema Integral de Gestión Operativa (PWA)

Aplicación Web Progresiva de nivel institucional para la gestión operativa
diaria de Protección Civil: emergencias, guardias de prevención, despacho
de combustible, hidrometeorología del Río Limón, educación y gestión de
riesgo, e inventario multi-almacén — con control de acceso por roles,
trazabilidad completa y reportes imprimibles/exportables.

## Stack técnico

- **Frontend:** HTML5 semántico + Tailwind CSS (CDN) + JavaScript Vanilla ES6 modular (sin build step: se ejecuta abriendo `index.html` en un servidor estático).
- **Backend:** Firebase Authentication (email/contraseña) + Cloud Firestore (tiempo real).
- **Librerías:** Chart.js (gráficos), SheetJS/xlsx (exportación Excel), jsPDF + jspdf-autotable (exportación PDF).
- **PWA:** `manifest.json` + `service-worker.js` (app shell offline; los datos requieren conexión a Firestore).

## Estructura del proyecto

```
index.html                 Shell de la aplicación (login + todas las vistas)
manifest.json               Manifiesto PWA
service-worker.js           Cache del app shell para instalación/offline
firestore.rules             Reglas de seguridad (RBAC) de Firestore
css/styles.css               Componentes UI + reglas @media print
icons/icon-192.png            Escudo oficial de Protección Civil (192x192)
icons/icon-512.png            Escudo oficial de Protección Civil (512x512)
icons/escudo_original.png     Imagen original del escudo (fuente de icon-*.png)
js/
  config.js                  Configuración Firebase, colecciones, catálogos fijos
  firebase.js                 Inicialización de Firebase (App/Auth/Firestore)
  auth.js                     Login/logout, perfil y rol del usuario, alta de usuarios
  data.js                      Capa genérica de acceso a Firestore (CRUD + trazabilidad)
  moduleFactory.js             Fábrica reutilizable "formulario + historial"
  ui.js                        Toasts, modal, tabla de historial, impresión, export Excel/PDF
  router.js                    Enrutador por hash entre vistas
  dashboard.js                  Métricas y gráficos analíticos en tiempo real
  emergencias.js                Lista Diaria de Pacientes / Traslados / Fallecidos
  guardias.js                   Guardias de Prevención
  combustible.js                 Despacho de Combustible
  hidrometeorologia.js           Monitoreo del Río Limón (escala 0-9) + integración API externa
  educacion.js                   Educación
  inspeccion.js                  Gestión de Riesgo (Inspección)
  inventario.js                  Insumos, existencias por almacén, entradas, transferencias
  catalogos.js                   Catálogos maestros (instituciones, categorías de insumos)
  usuarios.js                    Administración de usuarios y roles
  reportes.js                    Centro de reportes por módulo + Resumen General + Cierre Diario
  app.js                         Bootstrap de la aplicación
```

## 1. Configuración de Firebase

`js/config.js` ya está conectado al proyecto **pcmarageneral**. Pasos
pendientes en la consola de Firebase de ese proyecto:

1. Habilite **Authentication → Sign-in method → Correo electrónico/contraseña** (si aún no está activo).
2. Cree la base de datos **Cloud Firestore** (modo producción) si aún no existe.
3. Despliegue las reglas de seguridad incluidas en `firestore.rules`:
   ```bash
   npm install -g firebase-tools
   firebase login
   firebase init firestore   # seleccione el proyecto y use firestore.rules existente
   firebase deploy --only firestore:rules
   ```

## 2. Creación del primer Administrador (bootstrap)

El sistema **no permite auto-registro con rol de administrador** (por
seguridad, todo usuario nuevo entra como *Operador* por defecto). Para
crear el primer administrador:

1. Abra la aplicación e inicie sesión con una cuenta creada manualmente en
   **Firebase Console → Authentication → Add user** (correo + contraseña).
2. Al iniciar sesión por primera vez, el sistema crea automáticamente su
   perfil en `Firestore → usuarios/{uid}` con `rol: "operador"`.
3. En Firestore Console, edite ese documento y cambie `rol` a `"admin"`.
4. Recargue la aplicación: ahora tendrá privilegios totales, incluyendo el
   módulo **Usuarios**, desde donde podrá crear el resto de las cuentas
   (Operadores y Administradores) sin repetir este proceso manual.

## 3. Ejecución local

No requiere build ni `npm install`: es HTML/JS estático. Sírvalo con
cualquier servidor estático (los módulos ES requieren `http(s)://`, no
funcionan con `file://`):

```bash
npx serve .
# o
python3 -m http.server 8080
```

Luego abra `http://localhost:8080` (o el puerto indicado).

## 4. Despliegue

Cualquier hosting estático funciona (Firebase Hosting recomendado por
integrarse de forma nativa):

```bash
firebase init hosting   # public directory: "." 
firebase deploy --only hosting
```

## 5. Control de acceso (RBAC)

| Acción                                    | Operador | Administrador |
|--------------------------------------------|:--------:|:--------------:|
| Crear y consultar registros operativos      | ✅       | ✅             |
| Editar/eliminar registros ya guardados      | ❌       | ✅             |
| Gestionar catálogos (instituciones, categorías, insumos) | ❌ (solo lectura) | ✅ |
| Configurar umbrales/API de Hidrometeorología | ❌ (solo lectura) | ✅ |
| Crear usuarios y asignar roles              | ❌       | ✅             |
| Ajustar nivel mínimo crítico de inventario  | ❌       | ✅             |

Esto se aplica en **dos capas**: la interfaz oculta dinámicamente los
controles de edición/eliminación (`js/ui.js`, `isAdmin()`), y
`firestore.rules` lo reafirma a nivel de base de datos — un operador no
puede editar/eliminar aunque manipule las peticiones directamente.

Un Operador que detecte un error en un registro guardado debe notificar
al Administrador para que este realice la corrección (según lo
especificado): la interfaz no ofrece ruta alguna para que un operador
edite o borre historiales.

## 6. Módulo de Hidrometeorología — integración externa

`js/hidrometeorologia.js` expone `consultarNivelExterno()`, una función
`async` que hace `fetch()` a un endpoint configurable desde la UI (panel
**Río Limón → Configuración de umbrales**, solo Administrador). Acepta
cualquier API que responda JSON con un campo numérico `nivel`, `level` o
`value`. Si no se configura ningún endpoint, el sistema opera con
registro manual de lecturas por parte de personal de guardia, sin perder
funcionalidad.

## 7. Inventario — reglas de negocio

- Cuatro almacenes **independientes**: Depósito, Módulo, Oficina, Ambulancia — las existencias nunca se mezclan (se modelan como un documento por par insumo+almacén).
- Categorías e insumos se seleccionan de catálogos fijos (gestionados por el Administrador); nunca se escriben libremente en los formularios operativos.
- Entradas y transferencias actualizan las existencias mediante **transacciones atómicas de Firestore**, evitando condiciones de carrera con múltiples operadores simultáneos.
- Una transferencia valida que exista stock suficiente en el origen antes de confirmarse.
- Por tratarse de movimientos de cantidades (no de datos descriptivos), las entradas/transferencias no se editan una vez creadas; el Administrador puede **eliminarlas**, y el sistema **revierte automáticamente** el efecto sobre las existencias para mantener la integridad del stock.
- Filas por debajo del nivel mínimo crítico se resaltan en rojo automáticamente en la vista de Existencias y se cuentan en el Dashboard.

## 8. Impresión y reportes institucionales

Todo historial y el Resumen General cuentan con botones **Imprimir /
Excel / PDF**. La impresión usa `@media print` (`css/styles.css`) con
cintillo institucional y espacios de firma (cargo/departamento
configurable por módulo, ver `firmas` en `js/moduleFactory.js` y
`js/ui.js`) en formato carta, listos para archivo físico.

## 9. Persistencia offline

Firestore está configurado con caché local persistente (IndexedDB,
`js/firebase.js`), compartida entre pestañas abiertas
(`persistentMultipleTabManager`). Si se pierde la conexión a internet:

- La app sigue mostrando los datos ya sincronizados.
- Los formularios se pueden seguir guardando: las escrituras quedan
  encoladas localmente y se envían solas en cuanto vuelve la señal.
- Un indicador en la barra superior ("🔴 Sin conexión — guardando
  localmente") avisa el estado; desaparece unos segundos después de
  reconectar.

Si el navegador no soporta IndexedDB (p. ej. algunos modos privados),
la app cae automáticamente a Firestore en memoria — sigue funcionando,
solo sin caché offline.

## 10. Personalización pendiente antes de producción

- Ajustar `INSTITUCION` en `js/config.js` (nombre exacto del organismo/regional).
- Configurar `firebaseConfig` en `js/config.js` con las credenciales reales.
- Definir el endpoint real de la API de nivel del Río Limón, si existe.
