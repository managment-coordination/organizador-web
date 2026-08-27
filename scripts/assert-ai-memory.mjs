import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const failures = [];

function requireIncludes(fragment, label) {
  if (!source.includes(fragment)) failures.push(label);
}

requireIncludes("CREATE TABLE IF NOT EXISTS ia_reglas", "falta tabla ia_reglas");
requireIncludes("redaccion_titulo", "falta regla de redaccion de titulo");
requireIncludes("redaccion_comentario", "falta regla de redaccion de comentario");
requireIncludes("redaccion_proximo_paso", "falta regla de redaccion de proximo paso");
requireIncludes("function runAiMemoryCommand", "falta bridge de memoria IA");
requireIncludes("function applyRedactionRulesToProposal", "falta aplicacion de reglas a propuestas");
requireIncludes("AI_ACTIONS_REQUIRING_CONFIRMATION.has(proposal.action)", "las reglas podrian aplicarse fuera de acciones confirmables");
requireIncludes("used_rules", "falta trazabilidad de reglas usadas");
requireIncludes("memory_note", "falta nota de memoria aplicada");
requireIncludes("/api/ai/rules", "falta endpoint de listado de reglas");
requireIncludes("/api/ai/rules/action", "falta endpoint de acciones de reglas");
requireIncludes("learn_redaction", "falta aprendizaje de correcciones de redaccion");
requireIncludes("aiLearnCorrections", "falta control visible para aprender correcciones");
requireIncludes("Memoria IA", "falta panel visible de memoria IA");
requireIncludes("Desactivar", "falta opcion de desactivar reglas");
requireIncludes("mark_used", "falta contador de uso de reglas");
requireIncludes("role in {\"Superusuario\", \"Administrador\", \"Usuario\"}", "falta restriccion de rol en memoria IA");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  memory_table: "ia_reglas",
  redaction_rules: 3,
  visible_panel: true,
}, null, 2));
