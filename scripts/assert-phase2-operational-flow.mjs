import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "server", "index.js"), "utf8");

const required = [
  'class="entityBrief" id="entityBrief"',
  'function entityBriefHtml(item, type, history, attachments, reports, reportsAllowed)',
  'function renderEntityReports(reports, reportsAllowed)',
  'id="entityReportsLogSection"',
  'id="entityReportsList"',
  'id="focusRecordButton"',
  '$("focusRecordButton").addEventListener("click", focusRecordSection);',
  'function focusRecordSection()',
  'reports = []',
  '"reports": reports',
  'class="historyItem',
  'historyNext',
  'Proximo paso',
];

const missing = required.filter((needle) => !source.includes(needle));

if (missing.length) {
  console.error("Phase 2 operational flow assertions failed:");
  for (const needle of missing) console.error("- Missing:", needle);
  process.exit(1);
}

console.log("Phase 2 operational flow assertions passed.");
