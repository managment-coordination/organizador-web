import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const failures = [];

function requireIncludes(fragment, label) {
  if (!source.includes(fragment)) failures.push(label);
}

requireIncludes("function renderProposalUnderstanding", "falta vista previa de entendimiento de propuestas IA");
requireIncludes("Que he entendido", "la propuesta no muestra lectura de entendimiento");
requireIncludes("Datos usados", "la propuesta no muestra datos usados");
requireIncludes("No se guarda nada hasta pulsar Aplicar propuesta.", "falta aviso visible de no escritura");
requireIncludes("function renderCandidateSelector", "falta selector visual de candidatos");
requireIncludes("data-ai-candidate-type", "los candidatos no son seleccionables");
requireIncludes("needs_entity_confirmation", "backend no marca ambiguedad de destino");
requireIncludes("function runAgentActionsCommand", "falta persistencia de propuestas pendientes");
requireIncludes("ia_propuestas_pendientes", "falta tabla de centro de acciones del agente");
requireIncludes("/api/agent/actions", "falta endpoint del centro de acciones");
requireIncludes("function renderAgentActions", "falta interfaz del centro de acciones");
requireIncludes("Centro de acciones del agente", "falta seccion visible de acciones del agente");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "ai_agent_actions_preview_v1",
  checks: ["preview", "candidate_selector", "pending_actions"],
}, null, 2));
