import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const failures = [];

function requireIncludes(fragment, label) {
  if (!source.includes(fragment)) failures.push(label);
}

requireIncludes("function splitGuidedAutomationText", "falta separador de asuntos por lote");
requireIncludes("async function analyzeGuidedAutomationBatch", "falta analisis de automatizacion guiada");
requireIncludes("guided_batch_v1", "falta contrato de lote guiado");
requireIncludes("guided_batch_item_v1", "falta contrato por propuesta de lote");
requireIncludes("/api/ai/batch-operate", "falta endpoint batch-operate");
requireIncludes("Automatizacion guiada", "falta seccion visible de automatizacion guiada");
requireIncludes("aiBatchAnalyze", "falta boton de preparar lote");
requireIncludes("function renderAiBatchProposal", "falta render de tarjeta de propuesta");
requireIncludes("data-ai-batch-selected", "falta seleccion por propuesta");
requireIncludes("function collectAiBatchItem", "falta recogida de campos editados");
requireIncludes("function applyAiBatch", "falta aplicacion de lote");
requireIncludes("confirm(\"Se aplicaran \" + selected.length + \" propuesta(s) editadas. ¿Confirmas guardar el lote?\")", "falta confirmacion final de lote");
requireIncludes("No hay propuestas seleccionadas aplicables", "falta bloqueo de lote vacio");
requireIncludes("aiBatchLearnCorrections", "falta aprendizaje opcional en lote");
requireIncludes("writes_data: false", "el lote debe declararse sin escritura durante analisis");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "guided_batch_v1",
  editable_batch: true,
}, null, 2));
