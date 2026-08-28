import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const failures = [];

function requireIncludes(fragment, label) {
  if (!source.includes(fragment)) failures.push(label);
}

requireIncludes("function buildAgentGuidance", "falta constructor de respuesta guiada");
requireIncludes("agent_guidance_v1", "falta contrato agent_guidance_v1");
requireIncludes("confirmed_data", "falta bloque de dato confirmado");
requireIncludes("inferences", "falta bloque de inferencias");
requireIncludes("risks", "falta bloque de riesgos");
requireIncludes("review_focus", "falta bloque de revision");
requireIncludes("suggested_actions", "falta bloque de acciones sugeridas");
requireIncludes("response.guidance = buildAgentGuidance(response)", "finalize no adjunta guia antes de guardar contexto");
requireIncludes("function renderAgentGuidance", "falta render de guia del agente");
requireIncludes("renderAgentGuidance(response.guidance)", "la respuesta del agente no muestra guia");
requireIncludes("Confirmado", "falta tarjeta Confirmado");
requireIncludes("Inferencia", "falta tarjeta Inferencia");
requireIncludes("Riesgos", "falta tarjeta Riesgos");
requireIncludes("Dudas", "falta tarjeta Dudas");
requireIncludes("Siguientes acciones", "falta tarjeta Siguientes acciones");
requireIncludes("Preparar recordatorio o certificado como flujo guiado", "falta accion sugerida para deuda");
requireIncludes("No ejecutar esta peticion como una tarea comun", "falta proteccion para herramientas planificadas");
requireIncludes("Comprueba que el contexto anterior corresponde realmente al asunto actual", "falta riesgo de contexto");

const guidanceStart = source.indexOf("function buildAgentGuidance");
const guidanceEnd = source.indexOf("async function answerAgentMessage", guidanceStart);
const guidanceBlock = source.slice(guidanceStart, guidanceEnd);
if (!guidanceBlock.includes("result.data_status")) failures.push("la guia no interpreta estado de dato");
if (!guidanceBlock.includes("result.sources")) failures.push("la guia no muestra fuentes");
if (!guidanceBlock.includes("result.warning")) failures.push("la guia no eleva avisos a riesgos");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  contract: "agent_guidance_v1",
  sections: 6,
}, null, 2));
