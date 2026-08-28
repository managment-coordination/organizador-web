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

requireIncludes("function queryAgentDocumentsReports", "falta consulta documental del agente");
requireIncludes("async function prepareAgentEntityReport", "falta preparacion de informe por agente");
requireIncludes('id: "documents.lookup"', "falta herramienta de documentos");
requireIncludes('id: "reports.lookup"', "falta herramienta de consulta de informes");
requireIncludes('id: "reports.generate.entity"', "falta herramienta de generacion de informe");
requireIncludes('intent: "informe"', "falta intencion informe");
requireIncludes("agent_report_prepare_v1", "falta contrato de preparacion de informe");
requireIncludes('query_domain": "documentos_informes"', "falta dominio documental en consulta");
requireIncludes('query_domain: "documentos_informes"', "falta dominio documental en preparacion");
requireIncludes('allowed_write_endpoint: "/api/report/generate"', "falta endpoint permitido para escritura");
requireIncludes("renderAgentReportProposal", "falta render de propuesta de informe");
requireIncludes("generateAgentPreparedReport", "falta accion confirmada de informe");
requireIncludes("Generar y abrir Word", "falta boton de generacion de Word");
requireIncludes("confirm(\"Se generara un informe Word", "falta confirmacion antes de generar informe");
requireIncludes('window.open("/api/report/download?id="', "falta apertura de informe generado");
requireIncludes("documentos_informes: \"Documentos / informes\"", "falta etiqueta de dominio documental");

const documentRoute = routeBlock("/api/agent/documents/query", "/api/agent/report/prepare");
if (!documentRoute.includes("queryAgentDocumentsReports(session")) failures.push("endpoint documental no usa consulta documental");
if (!documentRoute.includes("Superusuario") || !documentRoute.includes("Administrador") || !documentRoute.includes("Usuario")) failures.push("endpoint documental no restringe roles");

const prepareRoute = routeBlock("/api/agent/report/prepare", "/api/agent/context");
if (!prepareRoute.includes("prepareAgentEntityReport(session")) failures.push("endpoint preparar informe no usa preparador");
if (prepareRoute.includes("generateEntityReport(")) failures.push("preparar informe no debe generar archivo directamente");

const generateRoute = routeBlock("/api/report/generate", "/api/report/download");
if (!generateRoute.includes("generateEntityReport(session")) failures.push("endpoint final no genera informe");
if (!generateRoute.includes("reportsForbidden(session)")) failures.push("endpoint final no bloquea presidente");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "agent_documents_reports_v1",
  checks: 22,
}, null, 2));
