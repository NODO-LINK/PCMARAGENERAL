/**
 * usuarios.js
 * -----------------------------------------------------------------------
 * Administración de usuarios del sistema (solo Administrador):
 *  - Alta de nuevas cuentas (Operador o Administrador).
 *  - Cambio de rol y activación/desactivación de cuentas existentes.
 *
 * La creación de usuarios usa una instancia secundaria de Firebase Auth
 * (ver firebase.js / auth.js) para no perder la sesión del administrador.
 * -----------------------------------------------------------------------
 */
import { COLLECTIONS, ROLES } from "./config.js";
import { subscribeCollection, updateRecord } from "./data.js";
import { toast } from "./ui.js";
import { adminCreateUser, isAdmin, getCurrentUser } from "./auth.js";

let usuarios = [];

const ROL_LABEL = {
  [ROLES.ADMIN]: "Administrador",
  [ROLES.OPERADOR]: "Operador",
  [ROLES.HIDRO]: "Hidrometeorología",
};
const ROL_BADGE_CLASS = {
  [ROLES.ADMIN]: "bg-navy-100 text-navy-800",
  [ROLES.OPERADOR]: "bg-slate-100 text-slate-700",
  [ROLES.HIDRO]: "bg-sky-100 text-sky-800",
};

export function initUsuarios() {
  subscribeCollection(COLLECTIONS.USUARIOS, "nombre", (rows) => {
    usuarios = rows;
    renderTabla();
  });

  const form = document.getElementById("form-nuevo-usuario");
  if (form) {
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
        toast(err.message?.includes("email-already") ? "Ese correo ya está registrado." : "No se pudo crear el usuario.", "error");
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
              ? `<select data-id="${u.id}" data-act="rol" class="text-xs border border-slate-300 rounded-md px-1.5 py-1">
                   <option value="${ROLES.OPERADOR}" ${u.rol === ROLES.OPERADOR ? "selected" : ""}>Operador</option>
                   <option value="${ROLES.ADMIN}" ${u.rol === ROLES.ADMIN ? "selected" : ""}>Administrador</option>
                   <option value="${ROLES.HIDRO}" ${u.rol === ROLES.HIDRO ? "selected" : ""}>Hidrometeorología</option>
                 </select>`
              : `<span class="px-2 py-0.5 rounded-full text-xs font-semibold ${ROL_BADGE_CLASS[u.rol] || "bg-slate-100 text-slate-700"}">${ROL_LABEL[u.rol] || u.rol}</span>`
          }
        </td>
        <td class="px-4 py-2">${u.activo === false ? '<span class="text-red-600">Inactivo</span>' : '<span class="text-emerald-600">Activo</span>'}</td>
        <td class="px-4 py-2">
          ${
            admin && u.id !== myUid
              ? `<button data-id="${u.id}" data-act="estado" class="text-red-700 hover:underline">${u.activo === false ? "Activar" : "Desactivar"}</button>`
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
    tbody.querySelectorAll('[data-act="estado"]').forEach((btn) => {
      btn.onclick = () => {
        const u = usuarios.find((x) => x.id === btn.dataset.id);
        updateRecord(COLLECTIONS.USUARIOS, u.id, { activo: u.activo === false });
      };
    });
  }
}
