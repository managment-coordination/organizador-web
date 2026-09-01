import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../server/index.js", import.meta.url), "utf8");

const required = [
  "function isLongMeetingTranscript",
  "function looksLikePastedOperationalConversation",
  "function shouldUseAgentPreviousContext",
  "const MEETING_TOPIC_RULES",
  "function splitLongMeetingText",
  "function normalizeMeetingProposal",
  "local_transcript_safety",
  "sin arrastrar contexto anterior",
  "Iluminacion Rafadona y farolas pendientes",
  "prefer_existing_followup",
  "uncertain_items: \"no_importar_pendiente_aclarar\"",
  "president_decision_only_if_explicit",
  "default_unclear_responsible: \"Administracion\"",
  "source_document_should_be_linked: true",
  "batch_mode: meetingMode ? \"long_meeting_transcript\"",
  "Reunion larga detectada",
  "Asunto detectado de reunion",
  "Fragmento fuente",
  "Si no hay destino claro, usa revisar_manual",
  "Si no se deduce responsable, usa Administracion",
];

const missing = required.filter((text) => !source.includes(text));

if (missing.length) {
  console.error("Missing long meeting agent markers:");
  for (const text of missing) console.error("- " + text);
  process.exit(1);
}

console.log("Long meeting agent assertions passed.");
