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
  const end = nextRoute ? source.indexOf(`url.pathname === "${nextRoute}"`, start + route.length) : source.indexOf("if (req.method === \"POST\" && url.pathname === \"/api/ai/query\")", start);
  return source.slice(start, end === -1 ? undefined : end);
}

requireIncludes("function runAgentContextCommand", "falta comando de contexto conversacional");
requireIncludes("ia_contexto_conversacion", "falta tabla independiente de contexto");
requireIncludes("agent_context_v1", "falta contrato de contexto");
requireIncludes("function agentNeedsPreviousContext", "falta detector de dependencia de contexto");
requireIncludes("function buildAgentContextualText", "falta constructor de texto contextual");
requireIncludes("function summarizeAgentResult", "falta resumen de resultado para contexto");
requireIncludes("conversation_context", "el agente no devuelve metadatos de contexto");
requireIncludes("/api/agent/context", "falta endpoint de listar contexto");
requireIncludes("/api/agent/context/clear", "falta endpoint de vaciar contexto");
requireIncludes("Contexto de conversacion", "falta panel visible de contexto");
requireIncludes("agentContextList", "falta lista visible de contexto");
requireIncludes("clearAgentContext", "falta accion de vaciar contexto");
requireIncludes("loadAgentContext", "falta carga de contexto");
requireIncludes("No se borran reglas permanentes", "falta aviso de separacion entre contexto y memoria permanente");

const contextRoute = routeBlock("/api/agent/context", "/api/agent/context/clear");
if (!contextRoute.includes("runAgentContextCommand(session, \"list\"")) failures.push("endpoint de contexto no lista con comando dedicado");
if (!contextRoute.includes("Superusuario") || !contextRoute.includes("Administrador") || !contextRoute.includes("Usuario")) failures.push("endpoint de contexto no restringe roles");

const clearRoute = routeBlock("/api/agent/context/clear", "/api/ai/query");
if (!clearRoute.includes("runAgentContextCommand(session, \"clear\"")) failures.push("endpoint de vaciado no usa comando dedicado");
if (!clearRoute.includes("Superusuario") || !clearRoute.includes("Administrador") || !clearRoute.includes("Usuario")) failures.push("endpoint de vaciado no restringe roles");

const contextCommandStart = source.indexOf("function runAgentContextCommand");
const contextCommandEnd = source.indexOf("function runSecurityCommand", contextCommandStart);
const contextCommand = source.slice(contextCommandStart, contextCommandEnd);
if (contextCommand.includes("ia_reglas")) failures.push("el contexto se ha mezclado con memoria permanente ia_reglas");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "agent_context_v1",
  table: "ia_contexto_conversacion",
}, null, 2));
