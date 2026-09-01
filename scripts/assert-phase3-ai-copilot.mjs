import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "server", "index.js"), "utf8");

const required = [
  'id="copilotFab"',
  'id="copilotPanel"',
  'id="copilotContextBox"',
  'data-copilot-preset="summary"',
  'function screenContextForCopilot()',
  'function updateCopilotContext()',
  'function openCopilot(preset = "")',
  'function copilotContextualText()',
  'function renderCopilotResponse(response)',
  'function openCopilotResultInCenter(response, originalText)',
  'function askCopilot()',
  '$("copilotSend").addEventListener("click", askCopilot);',
  '$("copilotFab").addEventListener("click", () => openCopilot());',
  '$("entityCopilotButton").addEventListener("click", () => openCopilot("ask"));',
  'Contexto de pantalla actual para el copiloto:',
  'Revisar en Centro IA',
  'Propuesta cargada desde Copiloto IA.',
  'Lote cargado desde Copiloto IA.',
  '$("copilotFab").classList.toggle("hidden", !["Superusuario", "Administrador", "Usuario"].includes((state.usuario || {}).rol));',
];

const missing = required.filter((needle) => !source.includes(needle));

if (missing.length) {
  console.error("Phase 3 AI copilot assertions failed:");
  for (const needle of missing) console.error("- Missing:", needle);
  process.exit(1);
}

console.log("Phase 3 AI copilot assertions passed.");
