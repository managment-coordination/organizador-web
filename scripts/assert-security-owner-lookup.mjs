import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridge = path.join(root, "server", "security-bridge.py");
const database = path.resolve(root, process.env.DATABASE_PATH || "./data/ai-audit.db");

const pythonCandidates = [
  process.env.PYTHON_BIN,
  process.env.PYTHON,
  process.platform === "win32" ? "C:\\Users\\EQUIPO\\AppData\\Local\\Programs\\Python\\Python314\\python.exe" : "",
  "python3",
  "python",
].filter(Boolean);

function runBridge(action, data, session = { id_usuario: 999, nombre: "Seguridad", rol: "Seguridad" }) {
  const request = JSON.stringify({ session, action, data, pc: "test" });
  const errors = [];
  for (const candidate of pythonCandidates) {
    const result = spawnSync(candidate, [bridge, database, request], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    const output = String(result.stdout || "").trim();
    if (result.status === 0 && output) return JSON.parse(output);
    errors.push(`${candidate}: ${result.stderr || result.stdout || result.error?.message || "error desconocido"}`);
  }
  throw new Error(errors.join("\n---\n"));
}

const failures = [];

try {
  const emailLookup = runBridge("owner_lookup", { query: "icogo23@hotmail.com" });
  if (!emailLookup.ok) failures.push("email: respuesta no ok");
  if (!emailLookup.matches?.some((row) => String(row.nombre || "").includes("CLEVERIS RANK INMO"))) failures.push("email: no encuentra propietario esperado");
  if (!emailLookup.matches?.some((row) => (row.contacts || []).some((contact) => String(contact.valor || "").toLowerCase() === "icogo23@hotmail.com"))) failures.push("email: no devuelve contacto localizado");
} catch (error) {
  failures.push(`email: ${error.message}`);
}

try {
  const propertyLookup = runBridge("owner_lookup", { query: "bloque 1 alboaire 1 a" });
  if (!propertyLookup.ok) failures.push("alboaire: respuesta no ok");
  if (!String(propertyLookup.normalized_query || "").includes("ALB")) failures.push("alboaire: no normaliza alias ALB");
  if (!propertyLookup.matches?.length) failures.push("alboaire: no devuelve coincidencias");
} catch (error) {
  failures.push(`alboaire: ${error.message}`);
}

try {
  const compactLookup = runBridge("owner_lookup", { query: "alboaire1º a" });
  if (!compactLookup.ok) failures.push("alboaire compacto: respuesta no ok");
  if (!String(compactLookup.normalized_query || "").includes("ALB")) failures.push("alboaire compacto: no normaliza alias ALB");
  if (!compactLookup.matches?.length) failures.push("alboaire compacto: no devuelve coincidencias");
} catch (error) {
  failures.push(`alboaire compacto: ${error.message}`);
}

try {
  runBridge("owner_lookup", { query: "CB 2 derecha" }, { id_usuario: 998, nombre: "Presidente", rol: "Presidente" });
  failures.push("presidente: deberia denegar permiso");
} catch (error) {
  if (!String(error.message || "").includes("PermissionError")) failures.push(`presidente: error inesperado ${error.message}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, checks: 4 }, null, 2));
