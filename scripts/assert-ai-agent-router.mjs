import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const failures = [];

function requireIncludes(fragment, label) {
  if (!source.includes(fragment)) failures.push(label);
}

function routeBlock(route, nextRoute) {
  const start = source.indexOf(`url.pathname === "${route}"`);
  if (start === -1) {
    failures.push(`falta endpoint ${route}`);
    return "";
  }
  const end = nextRoute ? source.indexOf(`url.pathname === "${nextRoute}"`, start + route.length) : source.indexOf("if (req.method === \"GET\" && url.pathname === \"/api/admin\")", start);
  return source.slice(start, end === -1 ? undefined : end);
}

requireIncludes("function detectAgentIntent", "falta detector de intencion del agente");
requireIncludes("async function answerAgentMessage", "falta nucleo de respuesta del agente");
requireIncludes("agent_router_v1", "falta contrato agent_router_v1");
requireIncludes("/api/agent/message", "falta endpoint del agente");
requireIncludes("Agente IA", "falta caja visible de Agente IA");
requireIncludes("agentSend", "falta boton de envio al agente");
requireIncludes("renderAgentDecision", "falta render de decision del agente");
requireIncludes("askAgent", "falta llamada de interfaz al agente");
requireIncludes("tool: selectedTool?.endpoint || \"/api/ai/query\"", "el agente no declara ruta de consulta");
requireIncludes("tool: selectedTool?.endpoint || \"/api/ai/operate\"", "el agente no declara ruta de accion");
requireIncludes("tool: selectedTool?.endpoint || \"/api/ai/batch-operate\"", "el agente no declara ruta de lote");
requireIncludes("tool: selectedTool?.endpoint || \"/api/agent/email/draft\"", "el agente no declara ruta de borrador de email");
requireIncludes("requires_confirmation: [\"accion\", \"lote\", \"informe\", \"email\"].includes(decision.intent)", "falta confirmacion para acciones/lotes/informes/email");

const agentRoute = routeBlock("/api/agent/message", "/api/ai/query");
if (!agentRoute.includes("answerAgentMessage(session, body.text || \"\")")) failures.push("el endpoint no llama al nucleo del agente");
if (!agentRoute.includes("Superusuario") || !agentRoute.includes("Administrador") || !agentRoute.includes("Usuario")) failures.push("el endpoint no restringe roles operativos");
if (/\b(writeEntityRecord|createEntity|updateEntity|INSERT INTO|UPDATE\s+\w+|DELETE FROM|applyImportBatch)\b/.test(agentRoute)) {
  failures.push("el endpoint del agente contiene escritura operativa directa");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "agent_router_v1",
  guarded_endpoint: "/api/agent/message",
}, null, 2));
