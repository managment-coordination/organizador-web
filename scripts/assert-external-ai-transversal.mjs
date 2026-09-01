import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");

const failures = [];

function requireIncludes(text, needle, message) {
  if (!text.includes(needle)) failures.push(message);
}

requireIncludes(server, "function aiExternalAvailable", "falta detector comun de IA externa");
requireIncludes(server, "async function callExternalAiJson", "falta cliente comun JSON para IA externa");
requireIncludes(server, "async function externalAgentIntent", "falta router externo del agente");
requireIncludes(server, "async function decideAgentIntent", "falta decision combinada local/externa");
requireIncludes(server, "external_intent_ignored", "falta proteccion contra reclasificar consultas como acciones");
requireIncludes(server, "async function externalMeetingAnalysis", "falta analisis externo de reuniones largas");
requireIncludes(server, "meeting_analysis_v1", "falta contrato de reunion IA externa");
requireIncludes(server, "function proposalFromMeetingItem", "falta conversion de asunto externo a propuesta revisable");
requireIncludes(server, "async function externalRefineOperationalProposal", "falta pulido externo de propuestas operativas");
requireIncludes(server, "async function externalPolishEmailDraft", "falta pulido externo de emails");
requireIncludes(server, "async function externalPolishQueryAnswer", "falta pulido externo de consultas");
requireIncludes(server, "decision_source", "el agente no expone origen de decision");
requireIncludes(server, "aiExternalConfigured", "health no informa si la IA externa esta activa");
requireIncludes(server, "ORGANIZADOR_NVIDIA_API_KEY", "falta compatibilidad con variable NVIDIA historica");

requireIncludes(envExample, "AI_PROVIDER=nvidia", ".env.example no documenta proveedor NVIDIA");
requireIncludes(envExample, "AI_BASE_URL=https://integrate.api.nvidia.com/v1", ".env.example no documenta base URL NVIDIA");
requireIncludes(envExample, "AI_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5", ".env.example no documenta modelo NVIDIA recomendado");
requireIncludes(envExample, "AI_API_KEY=", ".env.example no documenta AI_API_KEY");

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("OK external-ai-transversal");
