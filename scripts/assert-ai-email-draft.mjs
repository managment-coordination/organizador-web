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

requireIncludes("function emailDraftLooksLikeDebtNotice", "falta detector de borrador de deuda");
requireIncludes("function emailDraftLooksLikeExecutiveSummary", "falta detector de resumen ejecutivo por email");
requireIncludes("function extractDebtEmailTarget", "falta extractor de destinatario/propietario");
requireIncludes("function extractExecutiveSummaryTarget", "falta extractor de tarea/proyecto para resumen ejecutivo");
requireIncludes("function prepareAgentExecutiveSummaryEmailDraft", "falta preparador de resumen ejecutivo por email");
requireIncludes("buildExecutiveSummaryEmailBody", "falta constructor del cuerpo de resumen ejecutivo");
requireIncludes("function buildDebtEmailBody", "falta constructor del cuerpo del email");
requireIncludes("async function queryOwnerEmailForDraft", "falta busqueda de email del propietario");
requireIncludes("async function prepareAgentEmailDraft", "falta preparacion de borrador");
requireIncludes("email_draft_v1", "falta contrato email_draft_v1");
requireIncludes("action: \"borrador_email\"", "falta accion de borrador de email");
requireIncludes("outlook_ready: false", "el borrador no declara que Outlook aun no esta activo");
requireIncludes("listado de recibos pendientes de", "el borrador no reutiliza la consulta fiable de deuda");
requireIncludes("Historial resumido:", "el resumen ejecutivo no incluye historico");
requireIncludes("Resumen ejecutivo:", "el resumen ejecutivo no incluye bloque ejecutivo");
requireIncludes("Situacion actual:", "el resumen ejecutivo no incluye situacion actual");
requireIncludes("No se ha enviado nada", "falta aviso de no envio");
requireIncludes("renderAgentEmailDraft", "falta vista previa editable del email");
requireIncludes("copyAgentEmailBody", "falta boton de copiar cuerpo");
requireIncludes("copyAgentEmailAll", "falta boton de copiar email completo");
requireIncludes("agentEmailPreview", "falta contenedor de vista previa de email");
requireIncludes("/api/agent/email/draft", "falta endpoint de borrador");
requireIncludes("decision.intent === \"email\"", "el agente no enruta intencion email");
requireIncludes("email: \"Email revisable\"", "falta etiqueta visible de email");

const emailRoute = routeBlock("/api/agent/email/draft", "/api/agent/context");
if (!emailRoute.includes("prepareAgentEmailDraft(session, body.text || \"\")")) failures.push("el endpoint no llama al preparador de email");
if (!emailRoute.includes("Superusuario") || !emailRoute.includes("Administrador") || !emailRoute.includes("Usuario")) failures.push("el endpoint no restringe roles operativos");
if (/\b(_draft_email|reply_to_email|send_mail|sendEmail|transport\.send|UPDATE\s+\w+|DELETE FROM|INSERT INTO)\b/.test(emailRoute)) {
  failures.push("el endpoint de email contiene envio o escritura directa");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "email_draft_v1",
  endpoint: "/api/agent/email/draft",
  mode: "proposal_only",
}, null, 2));
