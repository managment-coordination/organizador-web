import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const failures = [];

function requireIncludes(fragment, label) {
  if (!source.includes(fragment)) failures.push(label);
}

requireIncludes("function polishAiProposal", "falta pulidor comun de propuestas IA");
requireIncludes("function summarizeOperationalText", "falta resumen operativo formal");
requireIncludes("function professionalNextStep", "falta redaccion profesional del proximo paso");
requireIncludes("Comentario y proximo paso normalizados para registro operativo.", "falta trazabilidad de redaccion aplicada");
requireIncludes("const polished = polishAiProposal(proposal, cleanText);", "entrada inteligente no pasa por pulidor");
requireIncludes("return polishAiProposal({", "importadores no pasan por pulidor");
requireIncludes("No copies transcripciones literalmente", "prompt externo no evita texto literal");
requireIncludes("Hechos relevantes:", "comentario no estructura hechos relevantes");

if (source.includes("Informacion recibida: ${summary}")) {
  failures.push("sigue existiendo el patron de copiar texto bruto como informacion recibida");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "ai_redaction_polish_v1",
  paths: ["entrada_inteligente", "importacion_estructurada", "historico"],
}, null, 2));
