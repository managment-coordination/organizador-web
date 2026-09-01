import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");

const requiredMarkers = [
  "center_contract: \"ai_center_v1\"",
  "function answerAiCenterMessage",
  "function buildAiCenterText",
  "url.pathname === \"/api/ai/center\"",
  "id=\"aiUnifiedText\"",
  "id=\"aiUnifiedFiles\"",
  "id=\"aiCenterDrop\"",
  "function askUnifiedAi",
  "function renderAiUnifiedAttachments",
  "startAiUnifiedDictation",
  "renderAgentDecision(response, \"aiUnifiedResult\")",
  "Herramientas avanzadas y bandejas internas",
  "screen_context: context || \"\"",
];

const missing = requiredMarkers.filter((marker) => !source.includes(marker));
if (missing.length) {
  console.error("Faltan marcadores del Centro IA unificado:");
  for (const marker of missing) console.error("- " + marker);
  process.exit(1);
}

console.log("Centro IA unificado: OK");
