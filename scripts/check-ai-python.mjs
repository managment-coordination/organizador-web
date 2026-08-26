import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "server", "index.js");
const source = fs.readFileSync(indexPath, "utf8");
const match = source.match(/function querySmartAssistant\(session, text\) \{\s+const script = `([\s\S]*?)`;\s+return runPythonJson\(script\);/);

if (!match) {
  console.error("No se ha encontrado el bloque Python de querySmartAssistant.");
  process.exit(1);
}

const pythonSource = match[1]
  .replace(/path = \$\{JSON\.stringify\(databasePath\)\}/, 'path = "data/organizador_tareas.db"')
  .replace(/question = \$\{JSON\.stringify\(text\)\}/, 'question = "consulta de prueba"')
  .replace(/role = \$\{JSON\.stringify\(session\?\.rol \|\| ""\)\}/, 'role = "Superusuario"')
  .replace(/allowed_ids = \$\{JSON\.stringify\(\(session\?\.comunidades \|\| \[\]\)\.map\(\(community\) => Number\(community\.id_comunidad\)\)\.filter\(Boolean\)\)\}/, "allowed_ids = [1]");

const outputPath = path.join(os.tmpdir(), "organizador_query_smart_assistant_check.py");
fs.writeFileSync(outputPath, pythonSource, "utf8");

const candidates = [
  process.env.PYTHON_BIN,
  process.env.PYTHON,
  process.platform === "win32" ? "C:\\Users\\EQUIPO\\AppData\\Local\\Programs\\Python\\Python314\\python.exe" : "",
  process.platform === "win32" ? "C:\\Users\\EQUIPO\\AppData\\Local\\Programs\\Python\\Python312\\python.exe" : "",
  "python3",
  "python",
].filter(Boolean);

let lastError = "";
for (const candidate of candidates) {
  const result = spawnSync(candidate, ["-m", "py_compile", outputPath], { encoding: "utf8" });
  if (result.status === 0) {
    console.log(JSON.stringify({ ok: true, python: candidate, checked: outputPath }, null, 2));
    process.exit(0);
  }
  lastError = `${candidate}: ${result.stderr || result.stdout || result.error?.message || "error desconocido"}`;
}

console.error(lastError);
process.exit(1);
