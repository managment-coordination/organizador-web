import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const databaseCandidates = [
  process.env.TEST_DATABASE,
  process.env.DATABASE_PATH,
  path.join(root, "data", "organizador_tareas.db"),
  path.join(root, "data", "ai-audit.db"),
  path.join(root, "data", "mobile-audit.db"),
  path.join(root, "data", "visual-stage.db"),
].filter(Boolean);
const sourceDb = databaseCandidates.map((item) => path.resolve(item)).find((item) => fs.existsSync(item));
if (!sourceDb) throw new Error("No se encontro una base de datos para probar el generador HTML.");

const pythonCandidates = [
  process.env.PYTHON_BIN,
  process.env.PYTHON,
  "C:\\Users\\EQUIPO\\AppData\\Local\\Programs\\Python\\Python314\\python.exe",
  "python3",
  "python",
].filter(Boolean);

function runPython(args, env = {}) {
  let last = null;
  for (const python of pythonCandidates) {
    const result = spawnSync(python, args, {
      encoding: "utf8",
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...env },
    });
    if (!result.error || result.error.code !== "ENOENT") return result;
    last = result.error;
  }
  throw last || new Error("No se encontro Python.");
}

const bridge = path.join(root, "server", "assembly-bridge.py");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "organizador-assembly-html-"));
const database = path.join(temp, "test.db");
fs.copyFileSync(sourceDb, database);

const session = { nombre: "Prueba automatica", rol: "Superusuario", comunidades: [] };
function command(action, data = {}) {
  const result = runPython([bridge, database, JSON.stringify({ session, action, data, pc: "assert-assembly-web-html" })]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Fallo en ${action}`);
  return JSON.parse(result.stdout);
}

const assemblies = command("list").assemblies || [];
let generated = null;
let selected = null;
let lastError = "";
for (const assembly of assemblies) {
  try {
    generated = command("web_html", { id: Number(assembly.id_asamblea) });
    selected = assembly;
    break;
  } catch (error) {
    lastError = error.message;
  }
}

if (!generated) throw new Error(`No se pudo generar HTML para ninguna asamblea. Ultimo error: ${lastError}`);
if (!generated.filename?.endsWith(".txt")) throw new Error("El generador no devuelve un nombre .txt.");
if (!generated.html?.includes("proxyData:")) throw new Error("El HTML no contiene la marca proxyData para el PDF.");
if (!generated.html?.includes("proxy-config")) throw new Error("El HTML no contiene la configuracion embebida.");
if (!generated.html?.includes("Sin instrucci")) throw new Error("El HTML no conserva la opcion de voto sin instruccion.");
if (Number(generated.points || 0) <= 0) throw new Error("El HTML no incluye puntos de votacion.");
if (Number(generated.properties || 0) <= 0) throw new Error("El HTML no incluye propiedades del censo.");

console.log(JSON.stringify({
  ok: true,
  database: sourceDb,
  assembly: selected?.nombre || selected?.codigo,
  filename: generated.filename,
  points: generated.points,
  properties: generated.properties,
  bytes: Buffer.byteLength(generated.html, "utf8"),
}, null, 2));
