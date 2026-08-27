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
  const end = nextRoute ? source.indexOf(`url.pathname === "${nextRoute}"`, start + route.length) : source.indexOf("return notFound", start);
  return source.slice(start, end === -1 ? undefined : end);
}

const noWritePattern = /\b(writeEntityRecord|createEntity|updateEntity|delete|INSERT INTO|UPDATE\s+\w+|DELETE FROM|applyImportBatch)\b/;
for (const [route, nextRoute] of [
  ["/api/ai/query", "/api/ai/operate"],
  ["/api/ai/operate", "/api/ai/analyze"],
  ["/api/ai/analyze", "/api/ai/history"],
]) {
  const block = routeBlock(route, nextRoute);
  if (noWritePattern.test(block)) failures.push(`${route}: contiene una llamada o sentencia de escritura directa`);
}

for (const action of ["seguimiento_tarea", "seguimiento_proyecto", "crear_tarea", "crear_proyecto"]) {
  requireIncludes(`"${action}"`, `falta accion ${action}`);
}

requireIncludes("const AI_ACTIONS_REQUIRING_CONFIRMATION = new Set", "falta lista de acciones que requieren confirmacion");
requireIncludes("proposal_contract: \"editable_confirmation_v1\"", "falta contrato editable_confirmation_v1");
requireIncludes("proposal_contract: action === \"consulta\" ? \"query_v1\" : \"manual_review_v1\"", "falta contrato query/manual");
requireIncludes("requires_confirmation: true", "falta marca requires_confirmation true");
requireIncludes("writes_data: false", "falta marca writes_data false");
requireIncludes("allowed_write_endpoint: aiWriteEndpointForAction(action)", "falta endpoint permitido por accion");
requireIncludes("editable_fields: AI_EDITABLE_FIELDS[action] || []", "falta listado de campos editables");
requireIncludes("impact_summary: aiImpactSummary(result, action)", "falta resumen de impacto de la accion");
requireIncludes("before_after_preview: aiBeforeAfterRows(result, action)", "falta previsualizacion antes/despues");
requireIncludes("current_snapshot", "falta snapshot actual del elemento existente");
requireIncludes("result = withAiProposalContract(result);", "answerAiQuery no normaliza contrato");
requireIncludes("if (targeted) return finalizeProposal(targeted);", "analyzeWithAi no normaliza propuesta dirigida");
requireIncludes("return withAiProposalContract(improved);", "finalizeProposal no aplica contrato final");
requireIncludes("return withAiProposalContract({", "analyzeOperationalWithAi no normaliza consultas mal ubicadas");
requireIncludes("proposal.requires_confirmation", "la UI no muestra el estado de confirmacion");
requireIncludes("proposal.impact_summary", "la UI no muestra el resumen de impacto");
requireIncludes("proposal.before_after_preview", "la UI no muestra antes/despues");
requireIncludes("bindAiBeforeAfterPreview(resultContainer)", "la UI no actualiza antes/despues tras editar");
requireIncludes("Nada se ha guardado todavia", "la UI no avisa de que no se ha guardado nada");
requireIncludes("confirm(\"Se aplicara la propuesta editada. ¿Confirmas guardar el cambio?\")", "la UI no pide confirmacion antes de aplicar");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  protected_routes: 3,
  confirmed_actions: 4,
  contract: "editable_confirmation_v1",
}, null, 2));
