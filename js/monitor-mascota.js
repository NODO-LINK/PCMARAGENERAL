/**
 * monitor-mascota.js
 * -----------------------------------------------------------------------
 * Mascota decorativa: un perrito K9 (estilo Protección Civil) que recorre
 * toda la pantalla del monitor todo el día, entrando y saliendo por
 * cualquier borde, con más de 20 comportamientos distintos (caminar,
 * correr, trotar, sentarse, dormir, rascarse, olfatear, ladrar, saltar,
 * girar, sacudirse, estirarse, cavar, saludar, bostezar, ladear la
 * cabeza, jadear, menear la cola, negar con la cabeza, revolcarse,
 * impacientarse, mover una oreja).
 *
 * Archivo SEPARADO de monitor.js a propósito: si algo falla aquí (es
 * puramente decorativo) no debe afectar nunca a los datos reales del
 * monitor. Escrito en JavaScript clásico (ES5), igual que monitor.js, por
 * el mismo motivo: el navegador del Smart TV de destino no soporta
 * <script type="module"> ni sintaxis moderna.
 *
 * Nota sobre el sonido: los navegadores (incluidos los de Smart TV)
 * suelen bloquear el audio hasta que haya una interacción real del
 * usuario (clic, toque). Como esta pantalla no tiene ninguna interacción
 * nunca, es posible que el ladrido nunca llegue a sonar en ese TV en
 * particular — el resto de la mascota (todo lo visual) funciona igual.
 * -----------------------------------------------------------------------
 */
(function () {
  "use strict";

  var el = document.getElementById("perrito");
  if (!el) return;

  var raf =
    window.requestAnimationFrame ||
    window.webkitRequestAnimationFrame ||
    function (cb) {
      return setTimeout(function () {
        cb(new Date().getTime());
      }, 16);
    };

  /* ------------------------- Sonido (ladrido sintetizado) ----------------- */
  var audioCtx = null;
  function obtenerAudioCtx() {
    if (audioCtx) return audioCtx;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
      audioCtx = new Ctx();
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }
  function ladrar() {
    var ctx = obtenerAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === "suspended" && ctx.resume) ctx.resume();
      var ahora = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(900, ahora);
      osc.frequency.exponentialRampToValueAtTime(180, ahora + 0.12);
      gain.gain.setValueAtTime(0.0001, ahora);
      gain.gain.exponentialRampToValueAtTime(0.25, ahora + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ahora + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ahora);
      osc.stop(ahora + 0.2);
    } catch (e) {
      // Silencioso: el sonido es un extra, nunca debe romper la mascota.
    }
  }

  /* ------------------------- Catálogo de comportamientos ------------------- */
  // "mover": el perrito se desplaza hacia un punto aleatorio (que puede
  // estar fuera de la pantalla). "quieto": se queda en su sitio jugando
  // una animación por un rato y luego elige el siguiente comportamiento.
  var ESTADOS = {
    caminar: { tipo: "mover", velocidad: 5.5, peso: 24, clases: ["mov-caminar"] },
    correr: { tipo: "mover", velocidad: 13, peso: 10, clases: ["mov-correr"] },
    trotar: { tipo: "mover", velocidad: 8.5, peso: 10, clases: ["mov-trotar"] },

    sentado: { tipo: "quieto", peso: 7, duracion: [2500, 5000], clases: ["estado-sentado", "cola-lenta"] },
    dormir: { tipo: "quieto", peso: 3, duracion: [9000, 18000], clases: ["estado-dormir"] },
    rascarse: { tipo: "quieto", peso: 5, duracion: [1200, 1900], clases: ["estado-sentado", "accion-rascar"] },
    olfatear: { tipo: "quieto", peso: 7, duracion: [1800, 2800], clases: ["accion-oler"] },
    ladrar: { tipo: "quieto", peso: 4, duracion: [1000, 1300], clases: ["accion-ladrar"], sonido: true },
    estirarse: { tipo: "quieto", peso: 4, duracion: [1300, 1300], clases: ["accion-estirar"] },
    saltar: { tipo: "quieto", peso: 4, duracion: [650, 650], clases: ["accion-salto"] },
    girar: { tipo: "quieto", peso: 4, duracion: [850, 850], clases: ["accion-girar", "cola-rapida"] },
    sacudirse: { tipo: "quieto", peso: 4, duracion: [550, 550], clases: ["accion-sacudir"] },
    alerta: { tipo: "quieto", peso: 4, duracion: [1300, 1300], clases: ["accion-alerta"] },
    cavar: { tipo: "quieto", peso: 4, duracion: [1800, 2600], clases: ["accion-cavar"] },
    saludo: { tipo: "quieto", peso: 3, duracion: [1700, 1700], clases: ["estado-sentado", "accion-saludo"] },
    bostezar: { tipo: "quieto", peso: 3, duracion: [1300, 1300], clases: ["accion-bostezo"] },
    ladear: { tipo: "quieto", peso: 5, duracion: [1500, 2200], clases: ["accion-ladear"] },
    jadear: { tipo: "quieto", peso: 5, duracion: [1500, 2500], clases: ["accion-jadeo", "cola-lenta"] },
    colaFeliz: { tipo: "quieto", peso: 5, duracion: [1200, 2000], clases: ["cola-rapida"] },
    negar: { tipo: "quieto", peso: 3, duracion: [550, 550], clases: ["accion-negar"] },
    revolcarse: { tipo: "quieto", peso: 3, duracion: [1500, 1500], clases: ["accion-revolcar"] },
    impaciente: { tipo: "quieto", peso: 3, duracion: [1300, 1300], clases: ["accion-impaciente"] },
    oreja: { tipo: "quieto", peso: 4, duracion: [900, 900], clases: ["accion-oreja"] },
  };

  var TODAS_LAS_CLASES = (function () {
    var set = {};
    var nombre;
    for (nombre in ESTADOS) {
      if (!ESTADOS.hasOwnProperty(nombre)) continue;
      var clases = ESTADOS[nombre].clases || [];
      for (var i = 0; i < clases.length; i++) set[clases[i]] = true;
    }
    return Object.keys(set);
  })();

  function limpiarClases() {
    for (var i = 0; i < TODAS_LAS_CLASES.length; i++) el.classList.remove(TODAS_LAS_CLASES[i]);
  }
  function aplicarClases(nombreEstado) {
    limpiarClases();
    var clases = ESTADOS[nombreEstado].clases || [];
    for (var i = 0; i < clases.length; i++) el.classList.add(clases[i]);
  }

  /* ------------------------- Ritmo según la hora del día ------------------- */
  // Un perrito de verdad no está igual de activo a las 3am que a las 10am —
  // esto hace que de noche/madrugada duerma y descanse mucho más, que al
  // mediodía le gane el sueño más seguido (siesta), y que de noche esté más
  // "alerta" (como corresponde a un perro de guardia) en vez de corriendo.
  function franjaHoraria() {
    var h = new Date().getHours();
    if (h < 6) return "madrugada";
    if (h < 8) return "despertar";
    if (h < 12) return "manana";
    if (h < 14) return "siesta";
    if (h < 18) return "tarde";
    if (h < 22) return "noche";
    return "tardeNoche";
  }
  var MULTIPLICADORES_HORA = {
    madrugada: { dormir: 7, sentado: 2, correr: 0.15, trotar: 0.3, girar: 0.15, saltar: 0.15, revolcarse: 0.15, colaFeliz: 0.3, impaciente: 0.2, default: 0.35 },
    despertar: { dormir: 1.2, bostezar: 3.5, estirarse: 3.5, sacudirse: 2, oreja: 2, alerta: 1.8, default: 1 },
    manana: { default: 1, correr: 1.3, girar: 1.2, saltar: 1.2, cavar: 1.2, colaFeliz: 1.2, impaciente: 1.3 },
    siesta: { dormir: 5, sentado: 2.5, bostezar: 1.6, jadear: 1.3, correr: 0.25, trotar: 0.4, girar: 0.25, saltar: 0.25, revolcarse: 0.3, default: 0.55 },
    tarde: { default: 1, olfatear: 1.3, cavar: 1.2, caminar: 1.1 },
    noche: { alerta: 2.2, ladrar: 1.6, olfatear: 1.2, correr: 0.5, saltar: 0.5, girar: 0.6, default: 0.85 },
    tardeNoche: { dormir: 3, sentado: 2, bostezar: 2, correr: 0.25, trotar: 0.4, saltar: 0.25, girar: 0.25, default: 0.45 },
  };
  function multiplicadorHora(nombre) {
    var tabla = MULTIPLICADORES_HORA[franjaHoraria()];
    if (!tabla) return 1;
    if (tabla.hasOwnProperty(nombre)) return tabla[nombre];
    return tabla.hasOwnProperty("default") ? tabla["default"] : 1;
  }

  // Después de ciertos comportamientos, hay una continuación que tiene más
  // sentido que un sorteo totalmente al azar (ej. después de dormir, lo
  // normal es bostezar/estirarse antes de ponerse a caminar; después de
  // correr, jadear; después de cavar, sacudirse la tierra).
  var SIGUE_BIEN = {
    dormir: ["bostezar", "estirarse"],
    bostezar: ["estirarse"],
    correr: ["jadear"],
    trotar: ["jadear"],
    cavar: ["sacudirse"],
    olfatear: ["cavar", "alerta", "ladrar"],
    revolcarse: ["sacudirse"],
    saltar: ["colaFeliz"],
    alerta: ["ladrar"],
    rascarse: ["sacudirse"],
  };

  function elegirAleatorioPonderado(filtroTipo) {
    var nombres = [];
    var pesos = [];
    var totalPeso = 0;
    var nombre;
    for (nombre in ESTADOS) {
      if (!ESTADOS.hasOwnProperty(nombre)) continue;
      if (filtroTipo && ESTADOS[nombre].tipo !== filtroTipo) continue;
      var peso = ESTADOS[nombre].peso * multiplicadorHora(nombre);
      nombres.push(nombre);
      pesos.push(peso);
      totalPeso += peso;
    }
    var r = Math.random() * totalPeso;
    var acumulado = 0;
    for (var i = 0; i < nombres.length; i++) {
      acumulado += pesos[i];
      if (r <= acumulado) return nombres[i];
    }
    return nombres[nombres.length - 1];
  }
  function aleatorioEntre(rango) {
    return rango[0] + Math.random() * (rango[1] - rango[0]);
  }

  /* ------------------------- Líneas sobre las que camina -------------------- */
  // El perrito NUNCA camina por el aire: solo se desplaza en horizontal, con
  // las patas siempre apoyadas sobre el borde superior de una fila de
  // tarjetas reales (.card) — igual que caminar sobre el borde de una
  // repisa. Cambiar de "repisa" (de una fila de tarjetas a otra) se hace
  // con un salto corto, nunca deslizando en diagonal por el vacío.
  var lineas = []; // [{y, x1, x2}, ...] uno por cada fila de tarjetas detectada
  function recalcularLineas() {
    var tarjetas = document.querySelectorAll(".card");
    var grupos = {};
    for (var i = 0; i < tarjetas.length; i++) {
      var r = tarjetas[i].getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      var clave = String(Math.round(r.top));
      if (!grupos[clave]) grupos[clave] = { y: r.top, x1: r.left, x2: r.right };
      else {
        if (r.left < grupos[clave].x1) grupos[clave].x1 = r.left;
        if (r.right > grupos[clave].x2) grupos[clave].x2 = r.right;
      }
    }
    var nuevas = [];
    for (var clave2 in grupos) {
      if (grupos.hasOwnProperty(clave2)) nuevas.push(grupos[clave2]);
    }
    if (nuevas.length) lineas = nuevas;
  }

  /* ------------------------- Posición y movimiento -------------------------- */
  var direccion = 1; // 1 = mira a la derecha, -1 = mira a la izquierda
  var estadoActual = null;
  var finEstadoQuieto = 0;
  var lineaActual = null; // {y,x1,x2} — la repisa donde están paradas las patas ahora
  var posX = window.innerWidth / 2;
  var posY = window.innerHeight / 2;
  // Puntos a recorrer en orden [{x,y,saltar}, ...] — cuando cambia de
  // repisa SIEMPRE son dos puntos: primero un salto vertical corto (misma
  // X) y después el recorrido horizontal por la repisa nueva. Así nunca
  // cruza en diagonal "a través" de tarjetas que están en el medio.
  var colaDestinos = [];

  // Arranca ya parado sobre una repisa real (nunca en el centro de la
  // pantalla "al aire"), si para cuando corre este script las tarjetas ya
  // tienen tamaño — si no, se corrige solo apenas elija su primer destino.
  (function posicionInicial() {
    recalcularLineas();
    if (!lineas.length) return;
    var linea = lineas[Math.floor(Math.random() * lineas.length)];
    lineaActual = linea;
    posX = linea.x1 + Math.random() * Math.max(1, linea.x2 - linea.x1);
    posY = linea.y - piePerritoPx();
  })();

  function medidaPerrito() {
    // Debe coincidir con .perrito (ancho/alto) en el CSS.
    return { w: (window.innerHeight * 10) / 100, h: (window.innerHeight * 8) / 100 };
  }
  // Distancia entre la esquina superior izquierda de .perrito y la línea
  // donde se apoyan las patas (.p-pata: top 5.5vh + height 2.3vh = 7.8vh).
  function piePerritoPx() {
    return (window.innerHeight * 7.8) / 100;
  }

  function armarRutaMovimiento() {
    colaDestinos = [];
    if (!lineas.length) recalcularLineas();
    if (!lineas.length) {
      // Aún no hay tarjetas medibles (no debería pasar) — se queda quieto
      // donde está en vez de arriesgarse a "flotar".
      colaDestinos.push({ x: posX, y: posY, saltar: false });
      return;
    }
    var m = medidaPerrito();
    // La mayoría de las veces sigue en la MISMA línea (camina de un lado a
    // otro de esa repisa); de vez en cuando cambia a otra fila de tarjetas.
    var cambiarLinea = !lineaActual || Math.random() < 0.3;
    var linea = cambiarLinea ? lineas[Math.floor(Math.random() * lineas.length)] : lineaActual;
    var huboSalto = cambiarLinea && !!lineaActual && linea.y !== lineaActual.y;

    // Y de vez en cuando, en vez de quedarse dentro del ancho de las
    // tarjetas de esa fila, sigue de largo más allá del borde de la
    // pantalla — así "sale de los límites" y reaparece luego por otro lado,
    // pero siempre manteniéndose sobre la altura de una repisa real.
    var sale = Math.random() < 0.25;
    var xFinal;
    if (sale) {
      var margenSalida = m.w * 2 + Math.random() * m.w * 3;
      xFinal = Math.random() < 0.5 ? linea.x1 - margenSalida : linea.x2 + margenSalida;
    } else {
      xFinal = linea.x1 + Math.random() * Math.max(1, linea.x2 - linea.x1);
    }

    if (huboSalto) {
      // Primero sube/baja DERECHO (misma X de donde está parado) a la
      // repisa nueva, y recién después camina en horizontal — nunca cruza
      // en diagonal por encima/a través de lo que haya en el medio.
      var xDeSalto = Math.max(linea.x1, Math.min(linea.x2, posX));
      colaDestinos.push({ x: xDeSalto, y: linea.y - piePerritoPx(), saltar: true });
    }
    colaDestinos.push({ x: xFinal, y: linea.y - piePerritoPx(), saltar: false });
    lineaActual = linea;
  }

  function iniciarEstado(nombreEstado) {
    estadoActual = nombreEstado;
    var cfg = ESTADOS[nombreEstado];
    aplicarClases(nombreEstado);
    if (cfg.sonido) ladrar();
    if (cfg.tipo === "mover") {
      armarRutaMovimiento();
    } else {
      finEstadoQuieto = new Date().getTime() + aleatorioEntre(cfg.duracion);
    }
  }

  function siguienteEstado() {
    if (estadoActual && ESTADOS[estadoActual].tipo === "mover") {
      iniciarEstado(elegirAleatorioPonderado("quieto"));
      return;
    }
    // Después de un comportamiento quieto, a veces encadena directamente
    // con una continuación que tiene sentido (ver SIGUE_BIEN) en vez de
    // siempre volver a caminar — se ve más "vivo".
    var sugeridos = estadoActual ? SIGUE_BIEN[estadoActual] : null;
    if (sugeridos && sugeridos.length && Math.random() < 0.45) {
      iniciarEstado(sugeridos[Math.floor(Math.random() * sugeridos.length)]);
    } else {
      iniciarEstado(elegirAleatorioPonderado("mover"));
    }
  }

  function aplicarTransform() {
    el.style.transform = "translate(" + posX + "px," + posY + "px) scaleX(" + direccion + ")";
  }

  var ultimoTs = null;
  function cuadro(ts) {
    if (ultimoTs === null) ultimoTs = ts;
    var dt = (ts - ultimoTs) / 1000;
    if (dt > 0.2) dt = 0.2; // evita saltos grandes si la pestaña estuvo en segundo plano
    ultimoTs = ts;

    if (!estadoActual) {
      iniciarEstado(elegirAleatorioPonderado("mover"));
    }

    var cfg = ESTADOS[estadoActual];
    if (cfg.tipo === "mover") {
      if (!colaDestinos.length) {
        siguienteEstado();
      } else {
        var meta = colaDestinos[0];
        var dx = meta.x - posX;
        var dy = meta.y - posY;
        var dist = Math.sqrt(dx * dx + dy * dy);
        // Si es un salto entre repisas, va rápido y con pose de salto — un
        // salto corto se ve intencional; arrastrarse despacio en diagonal
        // por el vacío es justamente lo que se veía mal antes.
        var velocidadVhSeg = meta.saltar ? 22 : cfg.velocidad;
        var pasoMax = velocidadVhSeg * window.innerHeight * 0.01 * dt;
        if (meta.saltar) el.classList.add("accion-salto");
        else el.classList.remove("accion-salto");
        if (dist <= pasoMax || dist === 0) {
          posX = meta.x;
          posY = meta.y;
          aplicarTransform();
          colaDestinos.shift();
          if (meta.saltar) el.classList.remove("accion-salto");
          if (!colaDestinos.length) siguienteEstado();
        } else {
          if (Math.abs(dx) > 2) direccion = dx > 0 ? 1 : -1;
          posX += (dx / dist) * pasoMax;
          posY += (dy / dist) * pasoMax;
          aplicarTransform();
        }
      }
    } else {
      if (new Date().getTime() >= finEstadoQuieto) siguienteEstado();
    }

    raf(cuadro);
  }

  window.addEventListener("resize", function () {
    recalcularLineas();
  });

  aplicarTransform();
  raf(cuadro);
})();
