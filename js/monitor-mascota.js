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

  function elegirAleatorioPonderado(excluir) {
    var nombres = [];
    var pesos = [];
    var totalPeso = 0;
    var nombre;
    for (nombre in ESTADOS) {
      if (!ESTADOS.hasOwnProperty(nombre) || nombre === excluir) continue;
      nombres.push(nombre);
      pesos.push(ESTADOS[nombre].peso);
      totalPeso += ESTADOS[nombre].peso;
    }
    var r = Math.random() * totalPeso;
    var acumulado = 0;
    for (var i = 0; i < nombres.length; i++) {
      acumulado += pesos[i];
      if (r <= acumulado) return nombres[i];
    }
    return nombres[nombres.length - 1];
  }
  function elegirSiguienteMovimiento() {
    var opciones = ["caminar", "caminar", "caminar", "correr", "trotar"];
    return opciones[Math.floor(Math.random() * opciones.length)];
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
  var destinoX = posX;
  var destinoY = posY;
  var saltandoEntreLineas = false;

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
    destinoX = posX;
    destinoY = posY;
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

  function elegirNuevoDestino() {
    if (!lineas.length) recalcularLineas();
    if (!lineas.length) {
      // Aún no hay tarjetas medibles (no debería pasar) — se queda quieto
      // donde está en vez de arriesgarse a "flotar".
      destinoX = posX;
      destinoY = posY;
      return;
    }
    var m = medidaPerrito();
    // La mayoría de las veces sigue en la MISMA línea (camina de un lado a
    // otro de esa repisa); de vez en cuando cambia a otra fila de tarjetas
    // (con un salto corto, ver más abajo).
    var cambiarLinea = !lineaActual || Math.random() < 0.3;
    var linea = cambiarLinea ? lineas[Math.floor(Math.random() * lineas.length)] : lineaActual;
    saltandoEntreLineas = cambiarLinea && !!lineaActual && linea.y !== lineaActual.y;

    // Y de vez en cuando, en vez de quedarse dentro del ancho de las
    // tarjetas de esa fila, sigue de largo más allá del borde de la
    // pantalla — así "sale de los límites" y reaparece luego por otro lado,
    // pero siempre manteniéndose sobre la altura de una repisa real.
    var sale = Math.random() < 0.25;
    var x;
    if (sale) {
      var margenSalida = m.w * 2 + Math.random() * m.w * 3;
      x = Math.random() < 0.5 ? linea.x1 - margenSalida : linea.x2 + margenSalida;
    } else {
      x = linea.x1 + Math.random() * Math.max(1, linea.x2 - linea.x1);
    }

    lineaActual = linea;
    destinoX = x;
    destinoY = linea.y - piePerritoPx();
  }

  function iniciarEstado(nombreEstado) {
    estadoActual = nombreEstado;
    var cfg = ESTADOS[nombreEstado];
    aplicarClases(nombreEstado);
    if (cfg.sonido) ladrar();
    if (cfg.tipo === "mover") {
      elegirNuevoDestino();
    } else {
      finEstadoQuieto = new Date().getTime() + aleatorioEntre(cfg.duracion);
    }
  }

  function siguienteEstado() {
    if (estadoActual && ESTADOS[estadoActual].tipo === "mover") {
      iniciarEstado(elegirComportamientoQuieto());
    } else {
      iniciarEstado(elegirSiguienteMovimiento());
    }
  }
  // Tras un movimiento, el siguiente estado SIEMPRE es uno "quieto"
  // (comportamiento); tras un comportamiento quieto, el siguiente SIEMPRE
  // es un movimiento — así se alterna caminar/correr/trotar con las demás
  // acciones, en vez de poder encadenar dos desplazamientos seguidos sin
  // pausa ni dos acciones quietas seguidas.
  function elegirComportamientoQuieto() {
    var nombre;
    do {
      nombre = elegirAleatorioPonderado();
    } while (ESTADOS[nombre].tipo === "mover");
    return nombre;
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
      iniciarEstado(elegirSiguienteMovimiento());
    }

    var cfg = ESTADOS[estadoActual];
    if (cfg.tipo === "mover") {
      var dx = destinoX - posX;
      var dy = destinoY - posY;
      var dist = Math.sqrt(dx * dx + dy * dy);
      // Si está cambiando de repisa (dy != 0), va rápido y con pose de
      // salto — un salto corto se ve intencional; arrastrarse despacio en
      // diagonal por el vacío es justamente lo que se veía mal antes.
      var velocidadVhSeg = saltandoEntreLineas ? 22 : cfg.velocidad;
      var pasoMax = velocidadVhSeg * window.innerHeight * 0.01 * dt;
      if (saltandoEntreLineas) el.classList.add("accion-salto");
      if (dist <= pasoMax || dist === 0) {
        posX = destinoX;
        posY = destinoY;
        aplicarTransform();
        if (saltandoEntreLineas) {
          saltandoEntreLineas = false;
          el.classList.remove("accion-salto");
        }
        siguienteEstado();
      } else {
        if (Math.abs(dx) > 2) direccion = dx > 0 ? 1 : -1;
        posX += (dx / dist) * pasoMax;
        posY += (dy / dist) * pasoMax;
        aplicarTransform();
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
