import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const failures = [];

function requireIncludes(fragment, label) {
  if (!source.includes(fragment)) failures.push(label);
}

requireIncludes("async function saveEntityAttachment", "falta guardado seguro de anexos");
requireIncludes("/api/entity/attachment", "falta endpoint de anexo de entidad");
requireIncludes("function quickAttachEntityFiles", "falta subida rapida desde tarjetas");
requireIncludes("async function uploadEntityFiles", "falta funcion comun de subida de archivos");
requireIncludes('data-action="attach"', "falta boton adjuntar en tarjetas de tareas/proyectos");
requireIncludes('data-daily-action="attach"', "falta boton adjuntar en mapa de trabajo");
requireIncludes('data-work-action="attach"', "falta boton adjuntar en bandejas/revision");
requireIncludes("Se adjuntaran", "falta confirmacion previa de archivos");
requireIncludes("archivo(s) adjuntado(s) correctamente", "falta confirmacion de subida correcta");
requireIncludes("Tu perfil no tiene permiso para adjuntar archivos.", "falta proteccion visual de permisos");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  feature: "web_quick_attachments",
  surfaces: ["tasks", "projects", "work_map", "pending_actions", "daily_review"],
}, null, 2));
