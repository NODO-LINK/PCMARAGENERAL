/**
 * usuarios.js
 * -----------------------------------------------------------------------
 * Administración de usuarios del sistema (solo Administrador):
 *  - Alta de nuevas cuentas (Administrador, Operador o un departamento).
 *  - Cambio de rol y activación/desactivación de cuentas existentes.
 *
 * La creación de usuarios usa una instancia secundaria de Firebase Auth
 * (ver firebase.js / auth.js) para no perder la sesión del administrador.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS, ROLES, DEPARTAMENTOS } from "./config.js";
import { subscribeCollection, updateRecord, deleteRecord } from "./data.js";
import { toast, confirmDialog } from "./ui.js";
import { adminCreateUser, isAdmin, getCurrentUser } from "./auth.js";

let usuarios = [];

// Etiqueta y color de cada rol; los de departamento salen de DEPARTAMENTOS.
const ROL_LABEL = {
  [ROLES.ADMIN]: "Administrador",
  [ROLES.OPERADOR]: "Operador (todos los módulos)",
  ...Object.fromEntries(Object.entries(DEPARTAMENTOS).map(([rol, d]) => [rol, d.nombre === "Hidrometeorología" ? "Hidrometeorología" : `Dpto. ${d.nombre}`])),
};
const ROL_BADGE_CLASS = {
  [ROLES.ADMIN]: "bg-navy-100 text-navy-800",
  [ROLES.OPERADOR]: "bg-slate-100 text-slate-700",
};
const BADGE_DEPARTAMENTO = "bg-sky-100 text-sky-800";

function opcionesDeRol(seleccionado) {
  return Object.entries(ROL_LABEL)
    .map(([rol, label]) => `<option value="${rol}" ${rol === seleccionado ? "selected" : ""}>${label}</option>`)
    .join("");
}

export function initUsuarios() {
  subscribeCollection(COLLECTIONS.USUARIOS, "nombre", (rows) => {
    usuarios = rows;
    renderTabla();
  });

  const form = document.getElementById("form-nuevo-usuario");
  if (form) {
    const selectRol = form.elements["rol"];
    if (selectRol) selectRol.innerHTML = opcionesDeRol(ROLES.OPERADOR);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!isAdmin()) return;
      const nombre = form.elements["nombre"].value.trim();
      const email = form.elements["email"].value.trim();
      const password = form.elements["password"].value;
      const rol = form.elements["rol"].value;
      if (!nombre || !email || password.length < 6) {
        toast("Complete nombre, correo y una contraseña de al menos 6 caracteres.", "error");
        return;
      }
      try {
        await adminCreateUser({ email, password, nombre, rol });
        toast(`Usuario "${nombre}" creado como ${ROL_LABEL[rol] || rol}.`, "success");
        form.reset();
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
      .map(
        (u) => `
      <tr class="border-t border-slate-100">
        <td class="px-4 py-2">${u.nombre || "—"}</td>
        <td class="px-4 py-2">${u.email}</td>
        <td class="px-4 py-2">
          ${
            admin && u.id !== myUid
              ? `<select data-id="${u.id}" data-act="rol" class="text-xs border border-slate-300 rounded-md px-1.5 py-1">${opcionesDeRol(u.rol)}</select>`
              : `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${ROL_BADGE_CLASS[u.rol] || (DEPARTAMENTOS[u.rol] ? BADGE_DEPARTAMENTO : "bg-slate-100 text-slate-700")}">${ROL_LABEL[u.rol] || u.rol}</span>`
          }
        </td>
        <td class="px-4 py-2">${u.activo === false ? '<span class="text-red-600">Inactivo</span>' : '<span class="text-emerald-600">Activo</span>'}</td>
        <td class="px-4 py-2">
          ${
            admin && u.id !== myUid
              ? `<button data-id="${u.id}" data-act="estado" class="text-slate-700 hover:underline mr-3">${u.activo === false ? "Activar" : "Desactivar"}</button><button data-id="${u.id}" data-act="eliminar" class="text-red-700 hover:underline">Eliminar</button>`
              : `<span class="text-slate-300">—</span>`
          }
        </td>
      </tr>`
      )
      .join("") || `<tr><td colspan="5" class="px-4 py-6 text-center text-slate-400">Sin usuarios registrados.</td></tr>`;

  if (admin) {
    tbody.querySelectorAll('[data-act="rol"]').forEach((select) => {
      select.onchange = () => {
        const u = usuarios.find((x) => x.id === select.dataset.id);
        updateRecord(COLLECTIONS.USUARIOS, u.id, { rol: select.value });
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
}
