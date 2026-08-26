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

const args = process.argv.slice(2);
const question = args.join(" ").trim() || "dame listado de deudores";
const databasePath = path.resolve(root, process.env.DATABASE_PATH || "./data/ai-audit.db");
const role = process.env.AI_SMOKE_ROLE || "Superusuario";
const allowedIds = (process.env.AI_SMOKE_COMMUNITIES || "1")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter(Boolean);

const templateSource = match[1].replace(/\\\\/g, "\\");

const pythonSource = templateSource
  .replace(/path = \$\{JSON\.stringify\(databasePath\)\}/, `path = ${JSON.stringify(databasePath)}`)
  .replace(/question = \$\{JSON\.stringify\(text\)\}/, `question = ${JSON.stringify(question)}`)
  .replace(/role = \$\{JSON\.stringify\(session\?\.rol \|\| ""\)\}/, `role = ${JSON.stringify(role)}`)
  .replace(/allowed_ids = \$\{JSON\.stringify\(\(session\?\.comunidades \|\| \[\]\)\.map\(\(community\) => Number\(community\.id_comunidad\)\)\.filter\(Boolean\)\)\}/, `allowed_ids = ${JSON.stringify(allowedIds)}`);

const outputPath = path.join(os.tmpdir(), `organizador_query_smart_assistant_smoke_${process.pid}.py`);
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
  const result = spawnSync(candidate, [outputPath], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status === 0) {
    console.log(result.stdout.trim());
    process.exit(0);
  }
  lastError = `${candidate}: ${result.stderr || result.stdout || result.error?.message || "error desconocido"}`;
}

console.error(lastError);
process.exit(1);
