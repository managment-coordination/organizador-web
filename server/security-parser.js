import path from "node:path";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import pdf from "pdf-parse/lib/pdf-parse.js";

const wordExtractor = new WordExtractor();

const CATEGORY_RULES = [
  ["Agua y saneamiento", /agua|fecal|alcantarill|saneamiento|inund|fuga/i],
  ["Accesos e identificaciones", /identific|operario|acceso|intrusi[oó]n|autorizaci[oó]n/i],
  ["Alarmas y sistemas de seguridad", /alarma|sistema de seguridad|control de acceso/i],
  ["Instalaciones, puertas y barreras", /puerta|garaje|barrera|ventana|estructural|instalaci[oó]n/i],
  ["Convivencia y normas internas", /m[uú]sica|ruido|normas internas|convivencia|queja/i],
  ["Daños, vandalismo o robo", /robo|vandal|da[nñ]o|rotura/i],
  ["Tráfico y vehículos", /tr[aá]fico|veh[ií]culo|aparcamiento|matr[ií]cula/i],
  ["Emergencias, incendios y asistencia sanitaria", /incendio|humo|ambulancia|sanitari|emergencia/i],
  ["Animales y medioambiente", /animal|perro|gato|medioambiente|vertido/i]
];

export async function extractSecurityDocument(fileName, bytes) {
  const extension = path.extname(fileName).toLowerCase();
  let text = "";
  if (extension === ".pdf") {
    text = String((await pdf(bytes)).text || "");
  } else if (extension === ".docx") {
    text = String((await mammoth.extractRawText({ buffer: bytes })).value || "");
  } else if (extension === ".doc") {
    text = String((await wordExtractor.extract(bytes)).getBody() || "");
  } else if ([".txt", ".log", ".csv"].includes(extension)) {
    text = bytes.toString("utf8");
  } else {
    throw new Error("Formato no admitido. Usa PDF, DOC, DOCX o TXT.");
  }
  text = cleanExtractedText(text);
  if (!text.trim()) throw new Error("No se ha podido extraer texto. El documento puede ser una imagen y requerir OCR.");
  return { extension, text };
}

export function analyzeSecurityText(fileName, sourceText) {
  const text = cleanExtractedText(sourceText);
  const warnings = [];
  const incidentSections = splitIncidentSections(text);
  let incidents = incidentSections.map(parseSecuritasIncident).filter(Boolean);
  if (!incidents.length && /informe de incidencias/i.test(text)) {
    const legacy = parseLegacyIncident(text);
    if (legacy) incidents = [legacy];
  }
  const unique = new Map();
  for (const incident of incidents) {
    const key = incident.numero_reporte || normalize(`${incident.fecha_hora_suceso}|${incident.titulo}|${incident.ubicacion}`);
    if (!unique.has(key)) unique.set(key, incident);
  }
  incidents = [...unique.values()];
  const internalDates = incidents.map(row => String(row.fecha_hora_suceso || "").slice(0, 10)).filter(Boolean);
  const fileDate = parseDateFromFilename(fileName);
  if (fileDate && internalDates.length && !internalDates.includes(fileDate)) {
    warnings.push(`La fecha del nombre (${fileDate}) no coincide con la fecha interna. Se conserva la fecha interna del parte.`);
  }
  if (/daily activity report|informe diario|inicio, fin y relevo|puntos de control/i.test(text)) {
    warnings.push("Las rondas, relevos y controles se guardan como documentacion, pero no se crean como incidencias.");
  }
  return {
    tipo_documento: /daily activity report|informe diario/i.test(text) ? "Informe diario" : incidents.length ? "Parte de incidencia" : "Documento de Seguridad",
    inicio_turno: extractDateTime(text, /Started on:\s*/i),
    fin_turno: extractDateTime(text, /Ended on:\s*/i),
    operativos: extractOperatives(text),
    incidents,
    warnings
  };
}

export function cleanExtractedText(value) {
  const raw = String(value || "").replace(/\u0000/g, "").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n");
  const repaired = raw.split("\n").map(line => repairDoubledCharacters(line)).join("\n");
  return repaired.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function repairDoubledCharacters(line) {
  const compact = String(line || "").trim();
  if (compact.length < 12 || compact.length % 2) return line;
  let pairs = 0;
  for (let index = 0; index < compact.length; index += 2) if (compact[index] === compact[index + 1]) pairs += 1;
  if (pairs / (compact.length / 2) < 0.82) return line;
  return compact.split("").filter((_char, index) => index % 2 === 0).join("");
}

function splitIncidentSections(text) {
  const pattern = /(?:Reporte\s*)?#(\d{6,})\s+Formulario de incidencias/gi;
  const matches = [...text.matchAll(pattern)].filter(match => !/informe consolidado\s*$/i.test(text.slice(Math.max(0, match.index - 40), match.index)));
  if (!matches.length) {
    const report = (text.match(/Reporte\s*#(\d{6,})/i) || [])[1];
    return report ? [{ report, text }] : [];
  }
  return matches.map((match, index) => {
    const next = matches[index + 1]?.index ?? text.length;
    return { report: match[1], text: text.slice(match.index, next) };
  });
}

function parseSecuritasIncident(section) {
  const text = section.text;
  const eventDate = extractDateTime(text, /D[ií]a y hora\s*/i);
  const reportDate = extractReportDateTime(text);
  const category = field(text, "Incidencia", ["Tipo", "Situación", "¿Hay personas", "Observaciones", "Firma"]);
  const type = field(text, "Tipo", ["Situación", "¿Hay personas", "Observaciones", "Firma"]);
  const situation = field(text, "Situación", ["¿Hay personas", "¿Necesitas", "Observaciones", "Firma"]);
  const observations = field(text, "Observaciones", ["Firma", "Daily Activity Report", "Escaneos de los Puntos", "Formulario de inicio"]);
  const location = extractIncidentLocation(text);
  const combined = `${category} ${type} ${situation} ${location} ${observations}`;
  const normalizedCategory = classifyCategory(combined);
  const result = classifyResult(combined);
  return {
    numero_reporte: section.report,
    fecha_hora_suceso: eventDate,
    fecha_hora_reporte: reportDate,
    zona: inferZone(location, observations),
    ubicacion: location,
    categoria_origen: category,
    tipo_origen: type,
    situacion_origen: situation,
    categoria_normalizada: normalizedCategory,
    gravedad: classifySeverity(normalizedCategory, combined, result),
    titulo: buildTitle(normalizedCategory, location, observations),
    descripcion: observations,
    actuacion_seguridad: inferAction(observations),
    resultado: result,
    sensible: /\bDNI\b|matr[ií]cula|personas involucradas\?\s*s[ií]/i.test(text),
    confianza: observations ? 0.94 : 0.7,
    fragmento: text.slice(0, 10000)
  };
}

function parseLegacyIncident(text) {
  const subject = field(text, "ASUNTO", ["Escribe por orden", "COMENTARIOS", "VIGILANTES"]);
  const descriptionMatch = text.match(/Especifica cual ha sido tu intervención y cómo se ha solucionado\s+([\s\S]*?)(?:COMENTARIOS|VIGILANTES:)/i);
  const description = cleanField(descriptionMatch?.[1] || "");
  const date = (text.match(/Fecha\s*(\d{2}-\d{2}-\d{4})/i) || [])[1] || "";
  const time = (text.match(/Hora\s*(\d{1,2}:\d{2})/i) || [])[1] || "";
  if (!subject && !description) return null;
  const combined = `${subject} ${description}`;
  const normalizedCategory = classifyCategory(combined);
  return {
    numero_reporte: "",
    fecha_hora_suceso: toIsoDateTime(date, time),
    fecha_hora_reporte: toIsoDateTime(date, time),
    zona: inferZone(subject, description),
    ubicacion: inferLocation(combined),
    categoria_origen: "Informe de incidencias",
    tipo_origen: subject,
    situacion_origen: "Pendiente de revision",
    categoria_normalizada: normalizedCategory,
    gravedad: classifySeverity(normalizedCategory, combined, "Pendiente de revision"),
    titulo: sentence(subject || "Incidencia de Seguridad"),
    descripcion: description,
    actuacion_seguridad: inferAction(description),
    resultado: "Pendiente de revision",
    sensible: /\bDNI\b|\b[NXYZ]?\s?\d{7,9}[A-Z]?\b|veh[ií]culo/i.test(text),
    confianza: 0.86,
    fragmento: text.slice(0, 10000)
  };
}

function field(text, label, stopLabels) {
  const labelPattern = new RegExp(`(?:^|\\n)${escapeRegex(label)}\\s*`, "i");
  const start = text.search(labelPattern);
  if (start < 0) return "";
  const after = text.slice(start).replace(labelPattern, "");
  let end = after.length;
  for (const stop of stopLabels) {
    const index = after.search(new RegExp(`(?:^|\\n)${escapeRegex(stop)}`, "i"));
    if (index >= 0) end = Math.min(end, index);
  }
  return cleanField(after.slice(0, end));
}

function cleanField(value) {
  const lines = String(value || "").split("\n").map(row => row.trim()).filter(Boolean);
  const deduped = lines.filter((line, index) => index === 0 || normalize(line) !== normalize(lines[index - 1]));
  return deduped.join(" ").replace(/\s+/g, " ").trim();
}

function extractIncidentLocation(text) {
  const eventIndex = text.search(/D[ií]a y hora/i);
  const section = eventIndex >= 0 ? text.slice(eventIndex) : text;
  const match = section.match(/T\.I\.P\.\s*\S+[\s\S]{0,120}?Ubicaci[oó]n\s*\n?([^\n]+)/i);
  return cleanField(match?.[1] || "");
}

function extractDateTime(text, prefix) {
  const after = text.slice(Math.max(0, text.search(prefix))).replace(prefix, "");
  const match = after.match(/(\d{2}-\d{2}-\d{4})\s+(\d{1,2}:\d{2})/);
  return match ? toIsoDateTime(match[1], match[2]) : "";
}

function extractReportDateTime(text) {
  const date = (text.match(/Fecha de Reporte\s*(\d{2}-\d{2}-\d{4})/i) || [])[1] || "";
  const time = (text.match(/Hora de Reporte\s*(\d{1,2}:\d{2})/i) || [])[1] || "";
  return toIsoDateTime(date, time);
}

function extractOperatives(text) {
  const values = [];
  for (const pattern of [/Empleado\s+([^\n]+)/gi, /Operativo (?:entrante|saliente)\s+([^\n#]+)/gi, /VIGILANTES:\s*([^\n]+)/gi]) {
    for (const match of text.matchAll(pattern)) {
      const value = cleanField(match[1]);
      if (value && !values.some(row => normalize(row) === normalize(value))) values.push(value);
    }
  }
  return values;
}

function classifyCategory(value) {
  if (/identific|operario|intrusi[oó]n|sin autorizaci[oó]n/i.test(value)) return "Accesos e identificaciones";
  if (/alarma|sistema de seguridad/i.test(value)) return "Alarmas y sistemas de seguridad";
  return CATEGORY_RULES.find(([_label, pattern]) => pattern.test(value))?.[0] || "Otros";
}

function classifySeverity(category, value, result) {
  if (/incendio|\barma\b|agresi[oó]n|robo en curso|emergencia sanitaria|peligro inmediato/i.test(value)) return "Critica";
  if (/fecal|intrusi[oó]n|sin autorizaci[oó]n|identificaci[oó]n operarios|vandal/i.test(value)) return "Alta";
  if (result === "Resuelta" || /falsa alarma|m[uú]sica|ruido/i.test(value)) return "Informativa";
  if (["Agua y saneamiento", "Daños, vandalismo o robo"].includes(category)) return "Alta";
  return "Media";
}

function classifyResult(value) {
  if (/quedando .*operativ|queda .*operativ|solucionad|resuelt/i.test(value)) return "Resuelta";
  if (/falsa alarma|no observando anomal[ií]as|sin novedad/i.test(value)) return "Informativa";
  return "Pendiente de revision";
}

function buildTitle(category, location, observations) {
  if (/aguas fecales/i.test(observations)) return `Salida de aguas fecales${location ? ` en ${location}` : ""}`;
  if (/puerta.*garaje|garaje.*puerta/i.test(observations)) return `Incidencia en puerta de garaje${location ? ` de ${location}` : ""}`;
  if (/m[uú]sica|volumen/i.test(observations)) return "Aviso por música alta en Casa Club";
  if (/alarma/i.test(observations)) return `Alarma${location ? ` en ${location}` : ""}`;
  if (/identific/i.test(observations)) return `Identificacion de operarios${location ? ` en ${location}` : ""}`;
  const first = observations.split(/(?<=[.!?])\s+/)[0];
  return sentence((first || `${category}${location ? ` - ${location}` : ""}`).slice(0, 140));
}

function inferAction(observations) {
  const sentences = String(observations || "").split(/(?<=[.!?])\s+/).filter(row => /comunic|comprueb|proced|informa|identific|desplaz|activa|inspecci/i.test(row));
  return sentences.join(" ").slice(0, 1500);
}

function inferZone(...values) {
  const value = values.join(" ");
  const rules = [
    ["Alboaire Golf", /alboaire/i], ["Hoyo 17", /hoyo\s*17|17h/i], ["Condominio B", /condominio\s*b|\bcb\b/i],
    ["Pueblo 1", /pueblo\s*1|mansi[oó]n|aterrazada/i], ["Emerald Green", /emerald|\beg\b/i],
    ["Casa Club", /casa club/i], ["Hotel San Roque Sport", /san roque sport/i]
  ];
  return rules.find(([_zone, pattern]) => pattern.test(value))?.[0] || "San Roque Club";
}

function inferLocation(value) {
  const match = String(value || "").match(/(?:villa|bloque|blq\.?|garaje|parcela)\s*[A-Za-z0-9 -]+/i);
  return cleanField(match?.[0] || "San Roque Club");
}

function parseDateFromFilename(fileName) {
  const match = path.basename(fileName).match(/(\d{2})-(\d{2})-(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function toIsoDateTime(date, time) {
  const match = String(date || "").match(/(\d{2})-(\d{2})-(\d{4})/);
  return match ? `${match[3]}-${match[2]}-${match[1]} ${String(time || "00:00").padStart(5, "0")}:00` : "";
}

function sentence(value) {
  const text = cleanField(value);
  return text ? text.charAt(0).toUpperCase() + text.slice(1).replace(/[.,;:]+$/, "") : "Incidencia de Seguridad";
}

function normalize(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
