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

requireIncludes("const AGENT_TOOL_CATALOG = [", "falta catalogo de herramientas");
requireIncludes("function getAgentToolCatalog", "falta funcion de catalogo por sesion");
requireIncludes("function selectAgentTool", "falta selector de herramienta");
requireIncludes("function scoreAgentTool", "falta puntuacion de herramientas");
requireIncludes("selected_tool: selectedTool", "el agente no devuelve herramienta seleccionada");
requireIncludes("available_tools: getAgentToolCatalog(session)", "el agente no devuelve herramientas disponibles");
requireIncludes("/api/agent/tools", "falta endpoint de herramientas del agente");
requireIncludes("Herramientas internas", "falta panel visible de herramientas");
requireIncludes("renderAgentTools", "falta render del catalogo");
requireIncludes("loadAgentTools", "falta carga del catalogo");
requireIncludes("renderSelectedAgentTool", "falta explicacion de herramienta elegida");

for (const toolId of [
  "ai.query.general",
  "owners.lookup",
  "accounting.debt.lookup",
  "accounting.balance.lookup",
  "work.project.task.query",
  "work.single.proposal",
  "work.batch.proposal",
  "assemblies.lookup",
  "security.lookup",
  "documents.lookup",
  "reports.lookup",
  "reports.generate.entity",
  "email.draft.proposal",
  "email.inbox.proposals",
  "accounting.bank.reconcile",
  "owners.ownership.change",
]) {
  requireIncludes(`id: "${toolId}"`, `falta herramienta ${toolId}`);
}

requireIncludes('status: "active"', "falta estado active");
requireIncludes('status: "planned"', "falta estado planned");
requireIncludes("Pendiente de conector Outlook", "falta limitacion de email");
requireIncludes("Pendiente de flujo legal guiado", "falta limitacion de titularidad");
requireIncludes("Pendiente de flujo web completo de importacion bancaria", "falta limitacion de conciliacion bancaria");
requireIncludes('/api/agent/documents/query', "falta endpoint documental activo");
requireIncludes('/api/agent/email/draft', "falta endpoint de borrador de email");
requireIncludes('/api/report/generate', "falta endpoint de generacion de informes");
requireIncludes('intents: ["informe"]', "falta intencion informe en catalogo");
requireIncludes('intents: ["email"]', "falta intencion email en catalogo");

const toolsRoute = routeBlock("/api/agent/tools", "/api/ai/query");
if (!toolsRoute.includes("getAgentToolCatalog(session)")) failures.push("endpoint de herramientas no usa catalogo filtrado");
if (!toolsRoute.includes("Superusuario") || !toolsRoute.includes("Administrador") || !toolsRoute.includes("Usuario")) failures.push("endpoint de herramientas no restringe roles");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  catalog: "agent_tool_catalog_v1",
  tools_checked: 16,
}, null, 2));
