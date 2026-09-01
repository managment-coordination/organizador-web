import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");

const required = [
  'id="mapTab" data-view="map"><span>Trabajo Hoy</span>',
  'id="workTab" data-view="work"',
  'id="reviewTab" data-view="review"',
  'function mapPanelHtml()',
  'class="workTodayShell"',
  'Mi bandeja',
  'Revision prioritaria',
  'data-home-view="ai">Actualizar con IA',
  '$("contentTitle").textContent = "Trabajo Hoy";',
  '$("workTab").classList.toggle("hidden", user.rol !== "Presidente");',
  '$("reviewTab").classList.add("hidden");',
  '<h3>Actualizar con IA</h3>',
  '$("quickRecordBox").classList.toggle("hidden", !canWrite());',
];

const missing = required.filter((needle) => !source.includes(needle));

if (missing.length) {
  console.error("Central workflow redesign assertions failed:");
  for (const needle of missing) console.error("- Missing:", needle);
  process.exit(1);
}

console.log("Central workflow redesign assertions passed.");
