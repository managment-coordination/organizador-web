import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAssemblyMinutes } from "../server/assembly-minutes-generator.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const sourceDb = path.resolve(process.env.TEST_DATABASE || path.join(root, "data", "organizador_tareas.db"));
const python = process.env.PYTHON_BIN || "python3";
const bridge = path.join(root, "server", "assembly-bridge.py");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "organizador-acta-"));
const database = path.join(temp, "test.db");
fs.copyFileSync(sourceDb, database);

const session = { nombre: "Prueba automatica", rol: "Superusuario", comunidades: [] };
function command(action, data = {}) {
  const result = spawnSync(python, [bridge, database, JSON.stringify({ session, action, data, pc: "smoke-test" })], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `Fallo en ${action}`);
  return JSON.parse(result.stdout);
}

const list = command("list").assemblies || [];
if (!list.length) throw new Error("No hay una asamblea disponible para la prueba.");
const id = Number(list[0].id_asamblea);
const detailBefore = command("detail", { id });
const voteFingerprint = JSON.stringify(detailBefore.votes || {});
const current = command("minutes_get", { id }).minutes;
const points = (detailBefore.points || []).map((point) => ({
  id_punto: Number(point.id_punto),
  debate_es: `Texto de prueba para ${point.titulo}.`,
  acuerdo_es: `Resultado: ${point.result?.approved ? "APROBADO" : "NO APROBADO"}.`,
  debate_en: `Test text for ${point.titulo}.`,
  acuerdo_en: `Result: ${point.result?.approved ? "APPROVED" : "NOT APPROVED"}.`,
}));
const saved = command("minutes_save", {
  ...current, id, estado: "Borrador", convocante: "Prueba", secretario: "Prueba",
  hora_cierre: "20:00", transcripcion: "Transcripcion de prueba suficientemente extensa para verificar el almacenamiento del borrador del acta sin modificar la votacion.",
  introduccion_es: "Introduccion de prueba.", introduccion_en: "Test introduction.",
  cierre_es: "Cierre de prueba.", cierre_en: "Test closing.", puntos: points,
});
if ((saved.minutes?.puntos || []).length !== points.length) throw new Error("No se recuperaron todos los puntos del borrador.");
const detailAfter = command("detail", { id });
if (JSON.stringify(detailAfter.votes || {}) !== voteFingerprint) throw new Error("La prueba ha detectado una alteracion de votos.");
const report = await buildAssemblyMinutes({ detail: detailAfter, minutes: saved.minutes });
if (!report.buffer?.length || report.buffer.subarray(0, 2).toString() !== "PK") throw new Error("El Word generado no es un DOCX valido.");
const output = path.join(temp, report.filename);
fs.writeFileSync(output, report.buffer);
console.log(JSON.stringify({ ok: true, assembly: detailAfter.assembly?.nombre, points: points.length, attendees: detailAfter.attendance?.length || 0, bytes: report.buffer.length, output }, null, 2));
