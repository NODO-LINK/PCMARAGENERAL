/**
 * usuarios.js
 * -----------------------------------------------------------------------
 * Administración de usuarios del sistema (solo Administrador):
 *  - Alta de nuevas cuentas (Administrador, Operador o de 1 a 3 departamentos).
 *  - Cambio de rol y activación/desactivación de cuentas existentes.
 *
 * La creación de usuarios usa una instancia secundaria de Firebase Auth
 * (ver firebase.js / auth.js) para no perder la sesión del administrador.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS, ROLES, DEPARTAMENTOS, MAX_DEPARTAMENTOS, departamentosDePerfil } from "./config.js";
import { subscribeCollection, updateRecord, deleteRecord } from "./data.js";
import { toast, confirmDialog, escapeHTML } from "./ui.js";
import { adminCreateUser, isAdmin, getCurrentUser } from "./auth.js";

let usuarios = [];
// Usuarios a los que el administrador acaba de cambiar a "Departamentos" y
// aún no marcó ninguno: se les muestran las casillas, pero no se guarda
// nada hasta que marque el primero (un usuario sin departamentos no vería
// nada).
const eligiendoDepartamentos = new Set();

// Los tres tipos de cuenta que se pueden elegir. Los roles de un solo
// departamento creados antes (dep_*, hidro) se muestran como "Departamentos"
// con su departamento marcado.
const TIPOS = [
  { valor: ROLES.ADMIN, label: "Administrador" },
  { valor: ROLES.OPERADOR, label: "Operador (todos los módulos)" },
  { valor: ROLES.DEPARTAMENTOS, label: `Departamentos (hasta ${MAX_DEPARTAMENTOS})` },
];
const ROL_BADGE_CLASS = {
  [ROLES.ADMIN]: "bg-navy-100 text-navy-800",
  [ROLES.OPERADOR]: "bg-slate-100 text-slate-700",
};
const BADGE_DEPARTAMENTO = "bg-sky-100 text-sky-800";

const tipoDe = (perfil) => (departamentosDePerfil(perfil).length || perfil.rol === ROLES.DEPARTAMENTOS ? ROLES.DEPARTAMENTOS : perfil.rol);

function opcionesDeTipo(seleccionado) {
  return TIPOS.map((t) => `<option value="${t.valor}" ${t.valor === seleccionado ? "selected" : ""}>${t.label}</option>`).join("");
}

function etiquetaDeAcceso(perfil) {
  if (perfil.rol === ROLES.ADMIN) return "Administrador";
  if (perfil.rol === ROLES.OPERADOR) return "Operador (todos los módulos)";
  const deps = departamentosDePerfil(perfil);
  return deps.length ? deps.map((r) => DEPARTAMENTOS[r].nombre).join(" · ") : perfil.rol;
}

/** Casillas de departamentos (máximo MAX_DEPARTAMENTOS). `nombre` agrupa las casillas. */
function casillasDepartamentos(nombre, marcados, extraAttrs = "") {
  const lleno = marcados.length >= MAX_DEPARTAMENTOS;
  return Object.entries(DEPARTAMENTOS)
    .map(([rol, d]) => {
      const on = marcados.includes(rol);
      return `<label class="inline-flex items-center gap-1.5 text-xs text-slate-700 mr-3 whitespace-nowrap">
        <input type="checkbox" name="${nombre}" value="${rol}" ${on ? "checked" : ""} ${!on && lleno ? "disabled" : ""} ${extraAttrs} />${escapeHTML(d.nombre)}
      </label>`;
    })
    .join("");
}

/** Mantiene el tope: con MAX marcadas se deshabilitan las demás. */
function aplicarTope(contenedor) {
  const cajas = [...contenedor.querySelectorAll('input[type="checkbox"]')];
  const marcadas = cajas.filter((c) => c.checked).length;
  cajas.forEach((c) => {
    c.disabled = !c.checked && marcadas >= MAX_DEPARTAMENTOS;
  });
}

const marcadosEn = (contenedor) => [...contenedor.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);

export function initUsuarios() {
  subscribeCollection(COLLECTIONS.USUARIOS, "nombre", (rows) => {
    usuarios = rows;
    renderTabla();
  });

  const form = document.getElementById("form-nuevo-usuario");
  if (form) {
    const selectRol = form.elements["rol"];
    if (selectRol) selectRol.innerHTML = opcionesDeTipo(ROLES.OPERADOR);

    // Bloque de casillas (solo visible si el tipo es "Departamentos"),
    // insertado antes de los botones del formulario.
    const bloque = document.createElement("div");
    bloque.className = "hidden mt-2";
    bloque.innerHTML = `<div class="form-label">Departamentos a los que tendrá acceso (1 a ${MAX_DEPARTAMENTOS})</div><div id="nuevo-usuario-departamentos" class="flex flex-wrap gap-y-1">${casillasDepartamentos("dep", [])}</div>`;
    form.querySelector(".form-actions")?.before(bloque);
    const zonaCasillas = bloque.querySelector("#nuevo-usuario-departamentos");
    zonaCasillas.addEventListener("change", () => aplicarTope(zonaCasillas));
    selectRol?.addEventListener("change", () => bloque.classList.toggle("hidden", selectRol.value !== ROLES.DEPARTAMENTOS));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!isAdmin()) return;
      const nombre = form.elements["nombre"].value.trim();
      const email = form.elements["email"].value.trim();
      const password = form.elements["password"].value;
      const rol = form.elements["rol"].value;
      const departamentos = rol === ROLES.DEPARTAMENTOS ? marcadosEn(zonaCasillas) : undefined;
      if (!nombre || !email || password.length < 6) {
        toast("Complete nombre, correo y una contraseña de al menos 6 caracteres.", "error");
        return;
      }
      if (departamentos && (departamentos.length < 1 || departamentos.length > MAX_DEPARTAMENTOS)) {
        toast(`Marque de 1 a ${MAX_DEPARTAMENTOS} departamentos.`, "error");
        return;
      }
      try {
        await adminCreateUser({ email, password, nombre, rol, departamentos });
        toast(`Usuario "${nombre}" creado (${etiquetaDeAcceso({ rol, departamentos })}).`, "success");
        form.reset();
        bloque.classList.add("hidden");
        zonaCasillas.innerHTML = casillasDepartamentos("dep", []);
        if (selectRol) selectRol.innerHTML = opcionesDeTipo(ROLES.OPERADOR);
      } catch (err) {
        console.error(err);
        // Los errores de correo repetido traen su explicación después de "email-already-in-use:".
        const detalle = err.message?.startsWith("email-already-in-use:") ? err.message.slice("email-already-in-use:".length).trim() : null;
        toast(detalle || (err.code === "auth/email-already-in-use" ? "Ese correo ya está registrado." : "No se pudo crear el usuario."), "error");
      }
    });
  }
}

function renderTabla() {
  const tbody = document.getElementById("tabla-usuarios-body");
  if (!tbody) return;
  const admin = isAdmin();
  const myUid = getCurrentUser()?.uid;

  tbody.innerHTML =
    usuarios
      .map((u) => {
        const editable = admin && u.id !== myUid;
        const tipo = eligiendoDepartamentos.has(u.id) ? ROLES.DEPARTAMENTOS : tipoDe(u);
        const marcados = departamentosDePerfil(u);
        const celdaRol = editable
          ? `<select data-id="${u.id}" data-act="rol" class="text-xs border border-slate-300 rounded-md px-1.5 py-1">${opcionesDeTipo(tipo)}</select>
             ${tipo === ROLES.DEPARTAMENTOS ? `<div data-id="${u.id}" data-act="departamentos" class="mt-1.5 max-w-md">${casillasDepartamentos("dep-" + u.id, marcados)}</div>` : ""}`
          : `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${ROL_BADGE_CLASS[u.rol] || (marcados.length ? BADGE_DEPARTAMENTO : "bg-slate-100 text-slate-700")}">${escapeHTML(etiquetaDeAcceso(u))}</span>`;
        return `
      <tr class="border-t border-slate-100 align-top">
        <td class="px-4 py-2">${escapeHTML(u.nombre || "—")}</td>
        <td class="px-4 py-2">${escapeHTML(u.email)}</td>
        <td class="px-4 py-2">${celdaRol}</td>
        <td class="px-4 py-2">${u.activo === false ? '<span class="text-red-600">Inactivo</span>' : '<span class="text-emerald-600">Activo</span>'}</td>
        <td class="px-4 py-2 whitespace-nowrap">
          ${
            editable
              ? `<button data-id="${u.id}" data-act="estado" class="text-slate-700 hover:underline mr-3">${u.activo === false ? "Activar" : "Desactivar"}</button><button data-id="${u.id}" data-act="eliminar" class="text-red-700 hover:underline">Eliminar</button>`
              : `<span class="text-slate-300">—</span>`
          }
        </td>
      </tr>`;
      })
      .join("") || `<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">Sin usuarios registrados.</td></tr>`;

  if (!admin) return;

  tbody.querySelectorAll('[data-act="rol"]').forEach((select) => {
    select.onchange = async () => {
      const u = usuarios.find((x) => x.id === select.dataset.id);
      if (!u) return;
      if (select.value === ROLES.DEPARTAMENTOS) {
        // Hasta que marque un departamento no se guarda nada (ver arriba).
        if (!departamentosDePerfil(u).length) {
          eligiendoDepartamentos.add(u.id);
          renderTabla();
          return;
        }
        eligiendoDepartamentos.delete(u.id);
        await updateRecord(COLLECTIONS.USUARIOS, u.id, { rol: ROLES.DEPARTAMENTOS, departamentos: departamentosDePerfil(u) });
        return;
      }
      eligiendoDepartamentos.delete(u.id);
      await updateRecord(COLLECTIONS.USUARIOS, u.id, { rol: select.value, departamentos: [] });
    };
  });

  tbody.querySelectorAll('[data-act="departamentos"]').forEach((zona) => {
    zona.onchange = async () => {
      const u = usuarios.find((x) => x.id === zona.dataset.id);
      if (!u) return;
      const marcados = marcadosEn(zona);
      if (!marcados.length) {
        toast("Debe quedar al menos un departamento marcado. Para quitarle el acceso use Desactivar.", "error");
        renderTabla();
        return;
      }
      aplicarTope(zona);
      eligiendoDepartamentos.delete(u.id);
      try {
        await updateRecord(COLLECTIONS.USUARIOS, u.id, { rol: ROLES.DEPARTAMENTOS, departamentos: marcados });
        toast(`Acceso de "${u.nombre || u.email}": ${marcados.map((r) => DEPARTAMENTOS[r].nombre).join(", ")}.`, "success");
      } catch (err) {
        console.error(err);
        toast("No se pudo guardar el cambio.", "error");
      }
    };
  });

  tbody.querySelectorAll('[data-act="eliminar"]').forEach((btn) => {
    btn.onclick = async () => {
      const u = usuarios.find((x) => x.id === btn.dataset.id);
      if (!u || u.id === myUid) return;
      const ok = await confirmDialog({
        title: "Eliminar usuario",
        message: `¿Eliminar a "${u.nombre || u.email}"? Pierde el acceso al sistema de inmediato. Sus registros ya guardados se conservan. Si solo quiere suspenderlo temporalmente, use "Desactivar".`,
        confirmText: "Eliminar",
      });
      if (!ok) return;
      try {
        await deleteRecord(COLLECTIONS.USUARIOS, u.id);
        toast(`Usuario "${u.nombre || u.email}" eliminado.`, "success");
      } catch (err) {
        console.error(err);
        toast("No se pudo eliminar el usuario.", "error");
      }
    };
  });
  tbody.querySelectorAll('[data-act="estado"]').forEach((btn) => {
    btn.onclick = () => {
      const u = usuarios.find((x) => x.id === btn.dataset.id);
      updateRecord(COLLECTIONS.USUARIOS, u.id, { activo: u.activo === false });
    };
  });
}
