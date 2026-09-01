import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

const required = [
  "function automationInsights()",
  "function automationPanelHtml",
  "class=\"automationPanel\"",
  "data-automation-view",
  "Alertas automaticas",
  "No destructivo",
  "Vencimientos vencidos",
  "Sin seguimiento reciente",
  "Pendiente de terceros",
  "automationInsights().filter(row => row.kind !== \"success\").slice(0, 5)",
  "Alertas automaticas: ",
  "automationPanelHtml(4)",
  "automationPanelHtml(6)",
];

const missing = required.filter((text) => !source.includes(text));

if (missing.length) {
  console.error("Missing phase 4 automation markers:");
  for (const text of missing) console.error("- " + text);
  process.exit(1);
}

console.log("Phase 4 automation assertions passed.");
