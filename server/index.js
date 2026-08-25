import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

loadEnv(path.join(rootDir, ".env"));

const port = Number(process.env.PORT || 8771);
const host = process.env.HOST || "0.0.0.0";
const appName = process.env.APP_NAME || "Organizador Web";
const pythonBin = process.env.PYTHON_BIN || "python3";
const aiProvider = (process.env.AI_PROVIDER || "local").toLowerCase();
const aiApiKey = process.env.AI_API_KEY || process.env.NVIDIA_API_KEY || process.env.OPENAI_API_KEY || "";
const aiBaseUrl = process.env.AI_BASE_URL || (aiProvider === "nvidia" ? "https://integrate.api.nvidia.com/v1" : "https://api.openai.com/v1");
const aiModel = process.env.AI_MODEL || (aiProvider === "nvidia" ? "meta/llama-3.1-70b-instruct" : "gpt-4.1-mini");
const dataDir = path.join(rootDir, "data");
const logsDir = path.join(rootDir, "logs");
const backupsDir = path.join(rootDir, "backups");
const databasePath = path.resolve(rootDir, process.env.DATABASE_PATH || "./data/organizador_tareas.db");

for (const dir of [dataDir, logsDir, backupsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const sessionSecretPath = path.join(dataDir, "session_secret");
const sessionSecret = loadOrCreateSessionSecret();
const sessionCookieName = "organizador_web_session";
const sessionMaxAgeSeconds = 8 * 60 * 60;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadOrCreateSessionSecret() {
  if (fs.existsSync(sessionSecretPath)) {
    return fs.readFileSync(sessionSecretPath, "utf8").trim();
  }
  const secret = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(sessionSecretPath, secret, { mode: 0o600 });
  return secret;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, error) {
  const raw = String(error?.message || error || "Error de servidor");
  const permission = raw.match(/PermissionError:\s*([^\r\n]+)/);
  const value = raw.match(/ValueError:\s*([^\r\n]+)/);
  const message = (permission?.[1] || value?.[1] || raw.split(/\r?\n/).filter(Boolean).at(-1) || raw).trim();
  const status = permission ? 403 : value ? 400 : 500;
  return sendJson(res, status, { ok: false, error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 200000) {
        reject(new Error("Solicitud demasiado grande."));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON no valido."));
      }
    });
    req.on("error", reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    cookies[trimmed.slice(0, index)] = decodeURIComponent(trimmed.slice(index + 1));
  }
  return cookies;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", sessionSecret).update(payload).digest("base64url");
}

function makeSessionCookie(user) {
  const payload = base64url(
    JSON.stringify({
      id_usuario: user.id_usuario,
      nombre: user.nombre,
      rol: user.rol,
      comunidades: user.comunidades,
      exp: Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds
    })
  );
  return `${payload}.${signPayload(payload)}`;
}

function readSession(req) {
  const cookie = parseCookies(req)[sessionCookieName];
  if (!cookie || !cookie.includes(".")) return null;
  const [payload, signature] = cookie.split(".", 2);
  const expected = signPayload(payload);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function setSessionCookie(res, user) {
  const value = makeSessionCookie(user);
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionMaxAgeSeconds}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const digest = parts[3];
  if (!iterations || !salt || !digest) return false;
  const expected = Buffer.from(digest, "hex");
  const actual = crypto.pbkdf2Sync(String(password || ""), salt, iterations, expected.length, "sha256");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function runPythonJson(script) {
  return new Promise((resolve, reject) => {
    execFile(pythonBin, ["-c", script], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`No se pudo leer la respuesta de la base: ${parseError.message}`));
      }
    });
  });
}

function queryAuthUsers() {
  const script = `
import json
import sqlite3
path = ${JSON.stringify(databasePath)}
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
users = [dict(row) for row in conn.execute("""
    SELECT id_usuario, nombre
    FROM usuarios
    WHERE COALESCE(activo, 1) = 1
    ORDER BY nombre
""")]
conn.close()
print(json.dumps({"usuarios": users}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function queryUserForLogin(userName) {
  const script = `
import json
import sqlite3
path = ${JSON.stringify(databasePath)}
name = ${JSON.stringify(userName)}
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
user = conn.execute("""
    SELECT id_usuario, nombre, rol, activo, password_hash, password_configurada,
           requiere_cambio_password, bloqueado
    FROM usuarios
    WHERE nombre = ?
""", (name,)).fetchone()
payload = {"user": None, "comunidades": []}
if user:
    payload["user"] = dict(user)
    payload["comunidades"] = [
        dict(row)
        for row in conn.execute("""
            SELECT c.id_comunidad, c.nombre
            FROM usuario_comunidad uc
            JOIN comunidades c ON c.id_comunidad = uc.id_comunidad
            WHERE uc.id_usuario = ? AND COALESCE(c.activo, 1) = 1
            ORDER BY c.nombre
        """, (user["id_usuario"],))
    ]
conn.close()
print(json.dumps(payload, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function queryOverview(session) {
  const script = `
import json
import sqlite3

path = ${JSON.stringify(databasePath)}
role = ${JSON.stringify(session?.rol || "")}
user_name = ${JSON.stringify(session?.nombre || "")}
allowed_ids = ${JSON.stringify((session?.comunidades || []).map((community) => Number(community.id_comunidad)).filter(Boolean))}
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def rows(sql, params=()):
    return [dict(row) for row in conn.execute(sql, params).fetchall()]

def one(sql, params=()):
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else {}

def community_filter(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1 = 0", []
    prefix = f"{alias}." if alias else ""
    marks = ",".join("?" for _ in allowed_ids)
    return f" AND {prefix}id_comunidad IN ({marks})", allowed_ids

project_filter, project_params = community_filter("p")
task_filter, task_params = community_filter("t")
hide_tasks = role == "Presidente"

counts = {
    "usuarios": one("SELECT COUNT(*) AS total FROM usuarios WHERE COALESCE(activo, 1) = 1").get("total", 0),
    "comunidades": len(allowed_ids) if role != "Superusuario" else one("SELECT COUNT(*) AS total FROM comunidades WHERE COALESCE(activo, 1) = 1").get("total", 0),
    "proyectos_activos": one("SELECT COUNT(*) AS total FROM proyectos p WHERE COALESCE(p.activo, 1) = 1" + project_filter, project_params).get("total", 0),
    "tareas_activas": 0 if hide_tasks else one("SELECT COUNT(*) AS total FROM tareas t WHERE COALESCE(t.activa, 1) = 1 AND COALESCE(t.archivada, 0) = 0" + task_filter, task_params).get("total", 0),
    "asambleas": one("SELECT COUNT(*) AS total FROM asambleas").get("total", 0),
    "propiedades_contabilidad": one("SELECT COUNT(*) AS total FROM cf_propiedades").get("total", 0),
}

proyectos = rows("""
    SELECT p.id_proyecto, p.nombre, p.categoria, p.estado_general, p.prioridad,
           p.responsable_principal, p.responsable_proximo_paso,
           p.fecha_objetivo_proximo_paso, p.fecha_ultima_actualizacion,
           c.nombre AS comunidad
    FROM proyectos p
    LEFT JOIN comunidades c ON c.id_comunidad = p.id_comunidad
    WHERE COALESCE(p.activo, 1) = 1
""" + project_filter + """
    ORDER BY
      CASE p.prioridad WHEN 'Urgente' THEN 1 WHEN 'Alta' THEN 2 WHEN 'Media' THEN 3 ELSE 4 END,
      COALESCE(p.fecha_objetivo_proximo_paso, '') ASC,
      p.nombre ASC
    LIMIT 80
""", project_params)

tareas = [] if hide_tasks else rows("""
    SELECT t.id_tarea, t.titulo, t.categoria, t.estado, t.prioridad,
           t.responsable, t.responsable_proximo_paso, t.proximo_paso,
           t.fecha_proxima_revision, t.fecha_objetivo_proximo_paso,
           t.fecha_ultima_actualizacion, p.nombre AS proyecto, c.nombre AS comunidad
    FROM tareas t
    LEFT JOIN proyectos p ON p.id_proyecto = t.id_proyecto
    LEFT JOIN comunidades c ON c.id_comunidad = t.id_comunidad
    WHERE COALESCE(t.activa, 1) = 1 AND COALESCE(t.archivada, 0) = 0
""" + task_filter + """
    ORDER BY
      CASE t.prioridad WHEN 'Urgente' THEN 1 WHEN 'Alta' THEN 2 WHEN 'Media' THEN 3 ELSE 4 END,
      COALESCE(t.fecha_proxima_revision, t.fecha_objetivo_proximo_paso, '') ASC,
      t.titulo ASC
    LIMIT 120
""", task_params)

estados_tareas = [] if hide_tasks else rows("SELECT COALESCE(estado, 'Sin estado') AS estado, COUNT(*) AS total FROM tareas t WHERE COALESCE(t.activa, 1) = 1 AND COALESCE(t.archivada, 0) = 0" + task_filter + " GROUP BY COALESCE(estado, 'Sin estado') ORDER BY total DESC", task_params)
estados_proyectos = rows("SELECT COALESCE(estado_general, 'Sin estado') AS estado, COUNT(*) AS total FROM proyectos p WHERE COALESCE(p.activo, 1) = 1" + project_filter + " GROUP BY COALESCE(estado_general, 'Sin estado') ORDER BY total DESC", project_params)

conn.close()
print(json.dumps({
    "usuario": {"nombre": user_name, "rol": role, "comunidades": ${JSON.stringify(session?.comunidades || [])}},
    "counts": counts,
    "proyectos": proyectos,
    "tareas": tareas,
    "estados_tareas": estados_tareas,
    "estados_proyectos": estados_proyectos,
}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function queryAiContext(session) {
  const script = `
import json
import sqlite3

path = ${JSON.stringify(databasePath)}
role = ${JSON.stringify(session?.rol || "")}
allowed_ids = ${JSON.stringify((session?.comunidades || []).map((community) => Number(community.id_comunidad)).filter(Boolean))}
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def community_filter(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1 = 0", []
    marks = ",".join("?" for _ in allowed_ids)
    prefix = f"{alias}." if alias else ""
    return f" AND {prefix}id_comunidad IN ({marks})", allowed_ids

pf, pp = community_filter("p")
tf, tp = community_filter("t")
projects = [dict(r) for r in conn.execute("""
    SELECT p.id_proyecto AS id, p.nombre AS titulo, p.categoria, p.estado_general AS estado,
           p.prioridad, p.responsable_principal AS responsable, p.responsable_proximo_paso,
           p.fecha_objetivo_proximo_paso, c.nombre AS comunidad
    FROM proyectos p
    LEFT JOIN comunidades c ON c.id_comunidad = p.id_comunidad
    WHERE COALESCE(p.activo, 1) = 1
""" + pf + " ORDER BY p.fecha_ultima_actualizacion DESC, p.id_proyecto DESC LIMIT 120", pp)]
tasks = [dict(r) for r in conn.execute("""
    SELECT t.id_tarea AS id, t.titulo, t.categoria, t.estado, t.prioridad,
           t.responsable, t.responsable_proximo_paso, t.fecha_objetivo_proximo_paso,
           t.proximo_paso, p.nombre AS proyecto, c.nombre AS comunidad
    FROM tareas t
    LEFT JOIN proyectos p ON p.id_proyecto = t.id_proyecto
    LEFT JOIN comunidades c ON c.id_comunidad = t.id_comunidad
    WHERE COALESCE(t.activa, 1) = 1 AND COALESCE(t.archivada, 0) = 0
""" + tf + " ORDER BY t.fecha_ultima_actualizacion DESC, t.id_tarea DESC LIMIT 160", tp)]
communities = [dict(r) for r in conn.execute("SELECT id_comunidad AS id, nombre FROM comunidades WHERE COALESCE(activo, 1) = 1 ORDER BY nombre")]
conn.close()
print(json.dumps({"projects": projects, "tasks": tasks, "communities": communities}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreTextMatch(text, title) {
  const source = normalizeText(text);
  const tokens = normalizeText(title).split(" ").filter((token) => token.length > 2);
  return tokens.reduce((score, token) => score + (source.includes(token) ? 1 : 0), 0);
}

function detectState(text, fallback = "En curso") {
  const t = normalizeText(text);
  if (t.includes("bloque")) return fallback === "Bloqueada" ? "Bloqueada" : "Bloqueado";
  if (t.includes("finaliz") || t.includes("terminad") || t.includes("cerrad")) return fallback === "Terminada" ? "Terminada" : "Finalizado";
  if (t.includes("tercero") || t.includes("proveedor") || t.includes("pendiente de")) return "Pendiente de tercero";
  if (t.includes("pendiente")) return "Pendiente";
  return fallback;
}

function detectResponsible(text, fallback = "") {
  const t = normalizeText(text);
  if (t.includes("elena")) return "Elena Cuenca";
  if (t.includes("luis")) return "Luis Gallardo";
  if (t.includes("presidente") || t.includes("rudy")) return "Presidente";
  if (t.includes("proveedor") || t.includes("empresa") || t.includes("jardinero")) return "Proveedor";
  return fallback;
}

function detectPriority(text, fallback = "Media") {
  const t = normalizeText(text);
  if (t.includes("urgente") || t.includes("inmediato")) return "Urgente";
  if (t.includes("alta prioridad") || t.includes("importante") || t.includes("obstruid") || t.includes("atasc")) return "Alta";
  if (t.includes("baja prioridad")) return "Baja";
  return fallback || "Media";
}

function extractNextStep(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => normalizeText(line).includes("proximo") || normalizeText(line).includes("siguiente"));
  if (index >= 0) return lines.slice(index, index + 4).join("\n").slice(0, 1200);
  return lines.slice(-3).join("\n").slice(0, 1200);
}

function cleanTranscriptText(text) {
  return String(text || "")
    .replace(/\d{2}:\d{2}:\d{2}\s+Speaker\s+\d+/gi, " ")
    .replace(/\bSpeaker\s+\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFormalComment(text, contextItem = null) {
  const clean = cleanTranscriptText(text);
  const t = normalizeText(clean);
  const location = extractLocation(clean);
  const zone = t.includes("pueblo") && location !== "zona Pueblo" ? "zona Pueblo" : "";
  const place = [location, zone].filter(Boolean).join(", ");

  if (t.includes("arqueta") && (t.includes("obstru") || t.includes("atasc") || t.includes("raiz") || t.includes("raices") || t.includes("tubo"))) {
    return [
      `Se recibe aviso sobre una arqueta${place ? ` situada en ${place}` : ""}, que presenta riesgo de obstruccion.`,
      "Segun la informacion trasladada, se observan raices procedentes de un tubo que estan bloqueando parcialmente la arqueta.",
      "Se indica que el jardinero ha revisado la situacion, pero no ha intervenido por el riesgo de que el material retirado caiga al fondo y provoque una obstruccion aguas abajo.",
    ].join(" ");
  }

  if (hasOperationalSignal(clean)) {
    const subject = contextItem?.titulo || contextItem?.title || "la actuacion indicada";
    const summary = clean ? clean.slice(0, 900) : "Se aporta informacion operativa pendiente de revisar.";
    return `Se registra comunicacion relacionada con ${subject}. Informacion recibida: ${summary}`;
  }

  return clean.slice(0, 4000);
}

function buildFormalNextStep(text, fallback = "") {
  const clean = cleanTranscriptText(text);
  const t = normalizeText(clean);

  if (t.includes("arqueta") && (t.includes("obstru") || t.includes("atasc") || t.includes("raiz") || t.includes("raices") || t.includes("tubo"))) {
    return "Coordinar revision sobre el terreno con el proveedor/jardinero, valorar la retirada controlada de las raices y confirmar si es necesaria una intervencion especializada para evitar la obstruccion de la red.";
  }

  if (hasOperationalSignal(clean)) {
    const steps = [];
    if (t.includes("revis") || t.includes("terreno") || t.includes("incidencia")) {
      steps.push("revisar la incidencia sobre el terreno y confirmar el alcance de la actuacion necesaria");
    }
    if (t.includes("presupuesto")) {
      steps.push("confirmar o solicitar el presupuesto correspondiente");
    }
    if (t.includes("inform")) {
      const responsible = detectResponsible(clean, "");
      steps.push(responsible ? `informar a ${responsible} con el resultado de la revision` : "informar del resultado de la revision");
    }
    if (steps.length) {
      return steps.map((step, index) => (index === 0 ? step.charAt(0).toUpperCase() + step.slice(1) : step)).join("; ") + ".";
    }
    return "Revisar la incidencia sobre el terreno, confirmar el alcance de la actuacion necesaria y asignar responsable y plazo para su resolucion.";
  }

  return extractNextStep(clean) || fallback || "Revisar la informacion aportada y definir el siguiente paso operativo.";
}

function hasOperationalSignal(text) {
  const t = normalizeText(text);
  return [
    "arqueta", "raiz", "raices", "obstru", "atasc", "tubo", "jardinero", "jardineria",
    "puerta", "villa", "calle", "zona", "pueblo", "alumbrado", "farola", "agua",
    "electric", "seguridad", "contenedor", "basura", "pintura", "baden", "obra",
    "mantenimiento", "reparacion", "incidencia", "proveedor", "presupuesto",
    "presidente", "comunidad", "propietario", "administracion", "oficina"
  ].some((token) => t.includes(token));
}

function extractLocation(text) {
  const raw = String(text || "");
  const normalized = normalizeText(raw);
  const puerta = raw.match(/puerta\s+(?:de\s+la\s+)?([0-9]{1,3}(?:\s*[-/]\s*[0-9]{1,3})?)/i);
  if (puerta) return `puerta ${puerta[1].replace(/\s+/g, "")}`;
  const villa = raw.match(/villa\s+([0-9]{1,3}(?:\s*[-/]\s*[0-9]{1,3})?)/i);
  if (villa) return `villa ${villa[1].replace(/\s+/g, "")}`;
  if (normalized.includes("pueblo")) return "zona Pueblo";
  return "";
}

function extractIssueTitle(text) {
  const t = normalizeText(text);
  const location = extractLocation(text);
  let issue = "Incidencia operativa";
  if (t.includes("arqueta") && (t.includes("obstru") || t.includes("atasc"))) issue = "Arqueta obstruida";
  else if (t.includes("arqueta")) issue = "Revision de arqueta";
  else if (t.includes("raiz") || t.includes("raices")) issue = "Raices afectando instalacion";
  else if (t.includes("tubo")) issue = "Revision de tubo";
  else if (t.includes("jardinero")) issue = "Actuacion de jardineria";
  return location ? `${issue} en ${location}` : issue;
}

function outOfScopeProposal(text, projectMatches, taskMatches) {
  return {
    source: "local",
    confidence: 0.2,
    action: "fuera_de_alcance",
    answer: "El texto no parece corresponder a una tarea, proyecto, incidencia, consulta o actuacion de la comunidad. No se propone guardar nada.",
    candidates: [...projectMatches.slice(0, 3), ...taskMatches.slice(0, 3)].filter((m) => m.score > 0).map((m) => ({ type: m.kind, id: m.id, title: m.titulo, score: m.score })),
    payload: {
      tipo_registro: "Seguimiento",
      comentario: String(text || "").trim().slice(0, 4000),
      estado_nuevo: "Pendiente",
      prioridad_nueva: "Media",
      responsable_nuevo: "",
      responsable_proximo_paso: "",
      fecha_objetivo_proximo_paso: "",
      fecha_proxima_revision: "",
      proximo_paso: "",
      motivo_bloqueo: "",
    },
  };
}

function localAiProposal(text, context) {
  const queryish = /[?¿]|\b(cual|cuanto|quien|dime|consulta|estado de|busca|listado)\b/i.test(text);
  const projectMatches = (context.projects || []).map((item) => ({ ...item, kind: "project", score: scoreTextMatch(text, item.titulo) })).sort((a, b) => b.score - a.score);
  const taskMatches = (context.tasks || []).map((item) => ({ ...item, kind: "task", score: scoreTextMatch(text, item.titulo) })).sort((a, b) => b.score - a.score);
  const best = [...projectMatches.slice(0, 3), ...taskMatches.slice(0, 3)].sort((a, b) => b.score - a.score)[0];
  const operational = hasOperationalSignal(text);
  if (!queryish && !operational && (!best || best.score === 0)) {
    return outOfScopeProposal(text, projectMatches, taskMatches);
  }
  if (queryish && !operational) {
    const matches = [...projectMatches, ...taskMatches].filter((item) => item.score > 0).slice(0, 6);
    return {
      source: "local",
      confidence: matches.length ? 0.55 : 0.25,
      action: "consulta",
      answer: matches.length
        ? "He encontrado posibles coincidencias:\n" + matches.map((m) => `- ${m.kind === "project" ? "Proyecto" : "Tarea"} ${m.id}: ${m.titulo} | Estado: ${m.estado || ""} | Responsable: ${m.responsable || ""}`).join("\n")
        : "No he encontrado una coincidencia clara en proyectos o tareas visibles.",
      candidates: matches.map((m) => ({ type: m.kind, id: m.id, title: m.titulo, score: m.score })),
    };
  }
  const allMatches = [...projectMatches, ...taskMatches].sort((a, b) => b.score - a.score);
  const nextBestScore = allMatches[1]?.score || 0;
  if (best && ((operational && best.score >= 3) || (!operational && (best.score >= 2 || (best.score >= 1 && nextBestScore === 0))))) {
    const isTask = best.kind === "task";
    return {
      source: "local",
      confidence: Math.min(0.85, 0.35 + best.score / 10),
      action: isTask ? "seguimiento_tarea" : "seguimiento_proyecto",
      entity: { type: best.kind, id: best.id, title: best.titulo },
      candidates: [best, ...(best.kind === "task" ? taskMatches : projectMatches).filter((item) => item.id !== best.id).slice(0, 4)].map((m) => ({ type: m.kind, id: m.id, title: m.titulo, score: m.score })),
      payload: {
        tipo_registro: "Seguimiento",
        comentario: buildFormalComment(text, best).slice(0, 4000),
        estado_nuevo: detectState(text, isTask ? (best.estado || "Pendiente") : (best.estado || "En curso")),
        prioridad_nueva: detectPriority(text, best.prioridad || "Media"),
        responsable_nuevo: best.responsable || "",
        responsable_proximo_paso: detectResponsible(text, best.responsable_proximo_paso || best.responsable || ""),
        fecha_objetivo_proximo_paso: "",
        fecha_proxima_revision: "",
        proximo_paso: buildFormalNextStep(text, extractNextStep(text)),
        motivo_bloqueo: "",
      },
    };
  }
  if (operational) {
    const title = extractIssueTitle(text);
    const owner = detectResponsible(text, "Luis Gallardo");
    const nextOwner = normalizeText(text).includes("jardinero") ? "Proveedor" : owner;
    return {
      source: "local",
      confidence: 0.62,
      action: "crear_tarea",
      answer: "No he encontrado una tarea/proyecto existente con coincidencia suficiente, pero el texto si parece una incidencia operativa de la comunidad. Propongo crear una tarea nueva y revisar el proyecto contenedor antes de guardar.",
      candidates: [...projectMatches.slice(0, 3), ...taskMatches.slice(0, 3)].filter((m) => m.score > 0).map((m) => ({ type: m.kind, id: m.id, title: m.titulo, score: m.score })),
      payload: {
        titulo: title,
        categoria: "Mantenimiento",
        tipo_registro: "Seguimiento",
        comentario: buildFormalComment(text).slice(0, 4000),
        estado_nuevo: "Pendiente",
        prioridad_nueva: detectPriority(text, "Alta"),
        responsable_nuevo: owner,
        responsable_proximo_paso: nextOwner,
        fecha_objetivo_proximo_paso: "",
        fecha_proxima_revision: "",
        proximo_paso: buildFormalNextStep(text, "Revisar la incidencia sobre el terreno y definir actuacion."),
        motivo_bloqueo: "",
      },
    };
  }
  return {
    source: "local",
    confidence: 0.35,
    action: "revisar_manual",
    answer: "No hay coincidencia suficientemente clara. Revisa si corresponde crear un proyecto o tarea nueva, o selecciona manualmente un elemento existente.",
    candidates: [...projectMatches.slice(0, 3), ...taskMatches.slice(0, 3)].filter((m) => m.score > 0).map((m) => ({ type: m.kind, id: m.id, title: m.titulo, score: m.score })),
    payload: {
      tipo_registro: "Seguimiento",
      comentario: buildFormalComment(text).slice(0, 4000),
      estado_nuevo: "En curso",
      prioridad_nueva: "Media",
      responsable_nuevo: "",
      responsable_proximo_paso: "",
      fecha_objetivo_proximo_paso: "",
      fecha_proxima_revision: "",
      proximo_paso: buildFormalNextStep(text, extractNextStep(text)),
      motivo_bloqueo: "",
    },
  };
}

function cleanAiJson(content) {
  const text = String(content || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  return JSON.parse(text);
}

async function externalAiProposal(text, context) {
  if (!aiApiKey || aiProvider === "local") return null;
  const catalog = {
    projects: (context.projects || []).slice(0, 80),
    tasks: (context.tasks || []).slice(0, 100),
  };
  const system = [
    "Eres el clasificador operativo de una aplicacion de gestion de comunidades.",
    "Devuelve solo JSON valido.",
    "Nunca ordenes guardar directamente. Solo propones.",
    "Acciones permitidas: fuera_de_alcance, consulta, seguimiento_proyecto, seguimiento_tarea, crear_proyecto, crear_tarea, revisar_manual.",
    "Si dudas entre varias entidades, usa revisar_manual y rellena candidates.",
    "Usa ids existentes solo si la coincidencia es clara.",
    "Formato: {action, confidence, answer, entity:{type,id,title}, candidates:[{type,id,title,score}], payload:{tipo_registro,comentario,estado_nuevo,prioridad_nueva,responsable_nuevo,responsable_proximo_paso,fecha_objetivo_proximo_paso,fecha_proxima_revision,proximo_paso,motivo_bloqueo,titulo,categoria,id_proyecto}}"
  ].join("\\n");
  const response = await fetch(`${aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${aiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: aiModel,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Catalogo visible:\n${JSON.stringify(catalog)}\n\nTexto recibido:\n${text}` },
      ],
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    throw new Error(`IA externa no disponible (${response.status})`);
  }
  const data = await response.json();
  const parsed = cleanAiJson(data.choices?.[0]?.message?.content || "{}");
  parsed.source = aiProvider;
  return parsed;
}

function querySmartAssistant(session, text) {
  const script = `
import json
import re
import sqlite3
import unicodedata
from datetime import datetime

path = ${JSON.stringify(databasePath)}
question = ${JSON.stringify(text)}
role = ${JSON.stringify(session?.rol || "")}
allowed_ids = ${JSON.stringify((session?.comunidades || []).map((community) => Number(community.id_comunidad)).filter(Boolean))}

def norm(value):
    text = str(value or "").upper()
    text = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    text = re.sub(r"[^A-Z0-9]+", " ", text)
    return re.sub(r"\\s+", " ", text).strip()

def money(value):
    n = float(value or 0)
    s = f"{n:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return s + " EUR"

def pct(value):
    return f"{float(value or 0):.2f}%".replace(".", ",")

def parse_date(value):
    value = str(value or "").strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).strftime("%Y-%m-%d")
        except Exception:
            pass
    return ""

def dates_from_question(q):
    raw = str(q or "")
    found = re.findall(r"\\b\\d{1,2}[/-]\\d{1,2}[/-]\\d{4}\\b|\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b", raw)
    parsed = [parse_date(x) for x in found]
    parsed = [x for x in parsed if x]
    if len(parsed) >= 2:
        return parsed[0], parsed[1]
    years = re.findall(r"\\b(20\\d{2})\\b", raw)
    if years:
        return f"{years[0]}-01-01", f"{years[0]}-12-31"
    return "", ""

def response(answer, confidence=0.75, candidates=None, questions=None, facts=None, display=None):
    return {
        "handled": True,
        "source": "local-db",
        "confidence": confidence,
        "action": "consulta",
        "answer": answer,
        "candidates": candidates or [],
        "questions": questions or [],
        "facts": facts or {},
        "display": display or {},
    }

def not_handled():
    return {"handled": False}

def normalize_property_query(value):
    q = norm(value)
    replacements = {
        "CONDOMINIO B": "CB",
        "DERECHA": "DCH",
        "DCHA": "DCH",
        "IZQUIERDA": "IZQ",
        "ATICO": "AT",
        "ATC": "AT",
        "PLAZA": "PLZ",
        "GARAJE": "PLZ",
    }
    for old, new in replacements.items():
        q = q.replace(old, new)
    q = re.sub(r"\\bCB\\s*(\\d+)\\b", r"CB \\1", q)
    return re.sub(r"\\s+", " ", q).strip()

def rows(sql, params=()):
    return [dict(r) for r in conn.execute(sql, params)]

def first(sql, params=()):
    r = conn.execute(sql, params).fetchone()
    return dict(r) if r else None

def score_tokens(query, value):
    stop = {
        "A", "AL", "DE", "DEL", "EL", "LA", "LAS", "LOS", "QUE", "QUIEN", "CUAL", "CUANTO",
        "CANTIDAD", "PERTENECE", "TIENE", "DEUDA", "MOROSIDAD", "PROPIETARIO", "PROPIEDAD",
        "VIVIENDA", "GARAJE", "LOCAL", "ES", "EN", "POR", "PARA", "ACTUAL"
    }
    q_tokens = [t for t in norm(query).split() if t and t not in stop]
    v_tokens = set(norm(value).split())
    v = norm(value)
    if not q_tokens:
        return 0
    score = sum(2 for t in q_tokens if t in v_tokens)
    score += sum(1 for t in q_tokens if len(t) >= 4 and t not in v_tokens and t in v)
    if norm(query) and norm(query) in v:
        score += 4
    return score

def find_properties(query):
    q = normalize_property_query(query)
    base_match = re.match(r"^(CB|PLZ|17H|P1F1|P1F2|PM|EG|ALB|FG|SRC)\\s+(\\d+)", q)
    props = rows("""
        SELECT id_propiedad, codigo_propiedad, zona, subzona, coeficiente
        FROM cf_propiedades
        WHERE COALESCE(activa, 1) = 1
    """)
    scored = []
    for p in props:
        code_norm = normalize_property_query(p.get("codigo_propiedad") or "")
        code_tokens = code_norm.split()
        if base_match and not (len(code_tokens) >= 2 and code_tokens[0] == base_match.group(1) and code_tokens[1] == base_match.group(2)):
            continue
        hay = " ".join([p.get("codigo_propiedad") or "", p.get("zona") or "", p.get("subzona") or ""])
        s = score_tokens(q, hay)
        if s > 0:
            scored.append((s, p))
    scored.sort(key=lambda item: (-item[0], item[1]["codigo_propiedad"]))
    best_score = scored[0][0] if scored else 0
    return [p for s, p in scored if s >= max(1, best_score - 1)][:12]

def find_owners(query):
    q = norm(query)
    owners = rows("""
        SELECT id_propietario, codigo_netfincas, nombre, nif
        FROM cf_propietarios
        WHERE COALESCE(activo, 1) = 1
    """)
    scored = []
    for owner in owners:
        hay = " ".join([owner.get("nombre") or "", owner.get("nif") or "", owner.get("codigo_netfincas") or ""])
        s = score_tokens(q, hay)
        if s > 0:
            scored.append((s, owner))
    scored.sort(key=lambda item: (-item[0], item[1]["nombre"]))
    best_score = scored[0][0] if scored else 0
    return [p for s, p in scored if s >= max(1, best_score - 1)][:12]

def extract_owner_query(q):
    text = str(q or "")
    patterns = [
        r"propietario\\s+(.+?)\\s+tiene\\s+deuda",
        r"(.+?)\\s+tiene\\s+deuda",
        r"deuda\\s+de\\s+(.+)$",
        r"morosidad\\s+de\\s+(.+)$",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.I)
        if m:
            return re.sub(r"[?¿]", "", m.group(1)).strip()
    return re.sub(r"[?¿]", "", text).strip()

def extract_property_query(q):
    text = str(q or "")
    m = re.search(r"\\bCB\\s*\\d+(?:\\s*[-/]\\s*\\d+)?(?:\\s*(?:DERECHA|DCHA|DCH|IZQUIERDA|IZQ|ATICO|AT))?\\b", text, re.I)
    if m:
        return m.group(0).strip()
    m = re.search(r"\\b((?:CB|17H|PLZ|P1F1|P1F2|PM|EG|ALB|FG|SRC|VILLA|LOCAL|L\\d+)[A-Z0-9\\s\\-\\/\\.]*?(?:DERECHA|DCHA|IZQUIERDA|IZQ|ATICO|AT|\\d)?)\\b", text, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r"(?:propiedad|vivienda|garaje|local|villa)\\s+(?:de\\s+)?(.+)$", text, re.I)
    if m:
        return re.sub(r"[?¿]", "", m.group(1)).strip()
    return ""

def owner_for_property(prop_id):
    return rows("""
        SELECT o.id_propietario, o.codigo_netfincas, o.nombre, o.nif,
               p.codigo_propiedad, p.zona, p.coeficiente
        FROM cf_propietario_propiedad pp
        JOIN cf_propietarios o ON o.id_propietario = pp.id_propietario
        JOIN cf_propiedades p ON p.id_propiedad = pp.id_propiedad
        WHERE pp.id_propiedad = ? AND COALESCE(pp.activo, 1) = 1
        ORDER BY o.nombre
    """, (prop_id,))

def debt_for_owner(owner_id):
    total = first("SELECT COALESCE(SUM(deuda),0) AS total FROM cf_recibos WHERE id_propietario = ? AND COALESCE(deuda,0) > 0", (owner_id,))["total"]
    by_year = rows("""
        SELECT COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER)) AS ejercicio,
               COALESCE(SUM(deuda),0) AS deuda,
               COUNT(*) AS recibos
        FROM cf_recibos
        WHERE id_propietario = ? AND COALESCE(deuda,0) > 0
        GROUP BY COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER))
        ORDER BY ejercicio
    """, (owner_id,))
    by_property = rows("""
        SELECT COALESCE(p.codigo_propiedad, r.propiedad_texto, 'Sin propiedad') AS propiedad,
               COALESCE(SUM(r.deuda),0) AS deuda,
               COUNT(*) AS recibos
        FROM cf_recibos r
        LEFT JOIN cf_propiedades p ON p.id_propiedad = r.id_propiedad
        WHERE r.id_propietario = ? AND COALESCE(r.deuda,0) > 0
        GROUP BY COALESCE(p.codigo_propiedad, r.propiedad_texto, 'Sin propiedad')
        ORDER BY deuda DESC
    """, (owner_id,))
    return total, by_year, by_property

conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
q_norm = norm(question)

try:
    is_finance_question = any(token in q_norm for token in ["BALANCE", "FINANCIERO", "TESORERIA", "RESULTADO ECONOMICO"])
    is_budget_question = any(token in q_norm for token in ["PRESUPUEST", "PARTIDA", "DESVIACION"]) and not is_finance_question
    is_debt_question = any(token in q_norm for token in ["DEUDA", "MOROS", "RECIBO PENDIENTE"])
    is_owner_question = "PROPIETARIO" in q_norm and any(token in q_norm for token in ["QUIEN", "CUAL", "DE "])
    is_work_question = any(token in q_norm for token in ["TAREA", "PROYECTO", "PENDIENTE", "RESPONSABLE", "PROXIMO PASO"]) and any(token in q_norm for token in ["COMO", "ESTADO", "QUIEN", "CUAL", "LISTA", "BUSCA"])

    if is_budget_question:
        report = first("SELECT titulo, fecha_desde, fecha_hasta, resultado_json FROM informes_contables WHERE resultado_json IS NOT NULL AND resultado_json <> '' ORDER BY fecha_ultima_actualizacion DESC, id_informe_contable DESC LIMIT 1")
        if not report:
            print(json.dumps(response("No hay todavia un informe contable con presupuesto calculado. Necesito que generes o recalcules el informe economico para poder comparar presupuesto frente a real.", 0.55), ensure_ascii=False))
        else:
            data = json.loads(report["resultado_json"] or "{}")
            budget = data.get("presupuesto") or []
            if not budget:
                print(json.dumps(response("El ultimo informe contable no contiene bloque de presupuesto calculado.", 0.55), ensure_ascii=False))
            else:
                rows_text = []
                budget_rows = sorted(budget, key=lambda x: abs(float(x.get("variacion_pct") or 0)), reverse=True)[:12]
                for item in budget_rows[:8]:
                    rows_text.append(f"- {item.get('codigo','')} {item.get('categoria','')}: real {money(item.get('real'))} / presupuesto periodo {money(item.get('presupuesto'))} / desviacion {money(item.get('variacion'))} ({pct(item.get('variacion_pct'))})")
                answer = "\\n".join([
                    f"Presupuesto segun ultimo informe: {report['titulo']} ({report['fecha_desde']} a {report['fecha_hasta']}).",
                    "Principales partidas:",
                    *rows_text,
                    "Si quieres un periodo distinto, indicame fecha desde y fecha hasta."
                ])
                display = {
                    "title": "Estado de presupuestos",
                    "subtitle": f"{report['titulo']} · {report['fecha_desde']} a {report['fecha_hasta']}",
                    "cards": [
                        {"label": "Partidas revisadas", "value": str(len(budget))},
                        {"label": "Mayor desviacion", "value": f"{budget_rows[0].get('codigo','')} {budget_rows[0].get('categoria','')}" if budget_rows else "Sin dato"},
                        {"label": "Desviacion mayor", "value": money(budget_rows[0].get("variacion")) if budget_rows else "0,00 EUR"},
                    ],
                    "tables": [{
                        "title": "Principales desviaciones",
                        "columns": ["Codigo", "Categoria", "Presupuesto", "Real", "Desviacion", "%"],
                        "rows": [
                            {
                                "Codigo": item.get("codigo", ""),
                                "Categoria": item.get("categoria", ""),
                                "Presupuesto": money(item.get("presupuesto")),
                                "Real": money(item.get("real")),
                                "Desviacion": money(item.get("variacion")),
                                "%": pct(item.get("variacion_pct")),
                            }
                            for item in budget_rows
                        ],
                    }],
                    "note": "Si quieres un periodo distinto, indica fecha desde y fecha hasta.",
                }
                print(json.dumps(response(answer, 0.82, facts={"periodo": [report["fecha_desde"], report["fecha_hasta"]]}, display=display), ensure_ascii=False))

    elif is_finance_question:
        start, end = dates_from_question(question)
        if not start or not end:
            print(json.dumps(response("Para preparar el balance financiero necesito que indiques fecha desde y fecha hasta. Ejemplo: balance financiero desde 01/01/2026 hasta 30/08/2026.", 0.5, questions=["Fecha desde", "Fecha hasta"]), ensure_ascii=False))
        else:
            ingresos_emitidos = first("SELECT COALESCE(SUM(importe),0) AS total FROM cf_recibos WHERE date(fecha_emision) BETWEEN date(?) AND date(?)", (start, end))["total"]
            cobros = first("SELECT COALESCE(SUM(-importe),0) AS total FROM cf_movimientos_deuda WHERE tipo_movimiento = 'Cobro' AND date(fecha) BETWEEN date(?) AND date(?)", (start, end))["total"]
            deuda_periodo = first("SELECT COALESCE(SUM(deuda),0) AS total FROM cf_recibos WHERE date(fecha_emision) BETWEEN date(?) AND date(?) AND COALESCE(deuda,0) > 0", (start, end))["total"]
            gastos_devengados = first("SELECT COALESCE(SUM(importe),0) AS total FROM cf_gastos_facturas WHERE COALESCE(cuenta_resumen,'') <> '610' AND date(fecha_alta) BETWEEN date(?) AND date(?)", (start, end))["total"]
            mejoras = first("SELECT COALESCE(SUM(importe),0) AS total FROM cf_gastos_facturas WHERE COALESCE(cuenta_resumen,'') = '610' AND date(fecha_alta) BETWEEN date(?) AND date(?)", (start, end))["total"]
            gastos_pagados = first("SELECT COALESCE(SUM(pagado),0) AS total FROM cf_gastos_facturas WHERE COALESCE(cuenta_resumen,'') <> '610' AND date(fecha_pago) BETWEEN date(?) AND date(?)", (start, end))["total"]
            pendientes = first("SELECT COALESCE(SUM(pendiente),0) AS total FROM cf_gastos_facturas WHERE COALESCE(cuenta_resumen,'') <> '610' AND date(fecha_alta) BETWEEN date(?) AND date(?)", (start, end))["total"]
            saldo_ini = first("SELECT saldo FROM cf_extractos_banco_lineas WHERE date(fecha) < date(?) AND saldo IS NOT NULL ORDER BY date(fecha) DESC, id_linea_banco DESC LIMIT 1", (start,))
            saldo_fin = first("SELECT saldo FROM cf_extractos_banco_lineas WHERE date(fecha) <= date(?) AND saldo IS NOT NULL ORDER BY date(fecha) DESC, id_linea_banco DESC LIMIT 1", (end,))
            answer = "\\n".join([
                f"Balance financiero provisional del {start} al {end}:",
                f"- Ingresos/recibos emitidos: {money(ingresos_emitidos)}",
                f"- Cobros registrados en deuda/recibos: {money(cobros)}",
                f"- Deuda pendiente generada en el periodo: {money(deuda_periodo)}",
                f"- Gastos devengados ordinarios: {money(gastos_devengados)}",
                f"- Gastos pagados ordinarios: {money(gastos_pagados)}",
                f"- Gastos ordinarios pendientes de pago: {money(pendientes)}",
                f"- Mejoras/inversiones grupo 610: {money(mejoras)}",
                f"- Saldo banco inicial disponible: {money(saldo_ini['saldo']) if saldo_ini else 'no disponible'}",
                f"- Saldo banco final disponible: {money(saldo_fin['saldo']) if saldo_fin else 'no disponible'}",
                "Nota: es una lectura automatica de la base actual. Para valor de acta conviene generar el informe economico completo y revisar descuadres."
            ])
            display = {
                "title": "Balance financiero provisional",
                "subtitle": f"{start} a {end}",
                "cards": [
                    {"label": "Recibos emitidos", "value": money(ingresos_emitidos)},
                    {"label": "Cobros registrados", "value": money(cobros)},
                    {"label": "Gastos devengados", "value": money(gastos_devengados)},
                    {"label": "Saldo final banco", "value": money(saldo_fin["saldo"]) if saldo_fin else "No disponible"},
                ],
                "tables": [{
                    "title": "Magnitudes del periodo",
                    "columns": ["Concepto", "Importe"],
                    "rows": [
                        {"Concepto": "Ingresos/recibos emitidos", "Importe": money(ingresos_emitidos)},
                        {"Concepto": "Cobros registrados en deuda/recibos", "Importe": money(cobros)},
                        {"Concepto": "Deuda pendiente generada en el periodo", "Importe": money(deuda_periodo)},
                        {"Concepto": "Gastos devengados ordinarios", "Importe": money(gastos_devengados)},
                        {"Concepto": "Gastos pagados ordinarios", "Importe": money(gastos_pagados)},
                        {"Concepto": "Gastos ordinarios pendientes de pago", "Importe": money(pendientes)},
                        {"Concepto": "Mejoras/inversiones grupo 610", "Importe": money(mejoras)},
                        {"Concepto": "Saldo banco inicial disponible", "Importe": money(saldo_ini["saldo"]) if saldo_ini else "No disponible"},
                        {"Concepto": "Saldo banco final disponible", "Importe": money(saldo_fin["saldo"]) if saldo_fin else "No disponible"},
                    ],
                }],
                "note": "Lectura automatica de la base actual. Para valor de acta conviene generar el informe economico completo y revisar descuadres.",
            }
            print(json.dumps(response(answer, 0.83, facts={"fecha_desde": start, "fecha_hasta": end}, display=display), ensure_ascii=False))

    elif is_debt_question:
        years = re.findall(r"\\b(20\\d{2})\\b", question)
        asks_global_year = bool(years) and not any(token in q_norm for token in ["TIENE DEUDA", "DEUDA DE", "MOROSIDAD DE", "PROPIETARIO"])
        if asks_global_year:
            year = int(years[0])
            total = first("SELECT COALESCE(SUM(deuda),0) AS total, COUNT(*) AS recibos FROM cf_recibos WHERE COALESCE(deuda,0) > 0 AND COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER)) = ?", (year,))
            overall = first("SELECT COALESCE(SUM(deuda),0) AS total FROM cf_recibos WHERE COALESCE(deuda,0) > 0")
            answer = f"La deuda pendiente correspondiente a {year} asciende a {money(total['total'])} en {total['recibos']} recibos. La deuda total pendiente registrada en la base es {money(overall['total'])}."
            display = {
                "title": f"Deuda pendiente {year}",
                "cards": [
                    {"label": "Deuda del ejercicio", "value": money(total["total"])},
                    {"label": "Recibos pendientes", "value": str(total["recibos"])},
                    {"label": "Deuda total registrada", "value": money(overall["total"])},
                ],
            }
            print(json.dumps(response(answer, 0.84, facts={"ejercicio": year, "deuda": total["total"]}, display=display), ensure_ascii=False))
            raise SystemExit
        owner_query = extract_owner_query(question)
        prop_query = extract_property_query(question)
        owners = []
        if prop_query:
            props = find_properties(prop_query)
            if len(props) == 1:
                owners = owner_for_property(props[0]["id_propiedad"])
            elif len(props) > 1 and "PROPIETARIO" in q_norm:
                answer = "He encontrado varias propiedades posibles. Necesito que concretes cual es:\\n" + "\\n".join([f"- {p['codigo_propiedad']} ({p['zona']}, coef. {p['coeficiente']})" for p in props[:8]])
                print(json.dumps(response(answer, 0.52, candidates=[{"type":"property","id":p["id_propiedad"],"title":p["codigo_propiedad"],"score":1} for p in props[:8]], questions=["Propiedad exacta"]), ensure_ascii=False))
                raise SystemExit
        if not owners and owner_query and "DEUDA" in q_norm:
            owners = find_owners(owner_query)
        if years and not owners:
            year = int(years[0])
            total = first("SELECT COALESCE(SUM(deuda),0) AS total, COUNT(*) AS recibos FROM cf_recibos WHERE COALESCE(deuda,0) > 0 AND COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER)) = ?", (year,))
            overall = first("SELECT COALESCE(SUM(deuda),0) AS total FROM cf_recibos WHERE COALESCE(deuda,0) > 0")
            answer = f"La deuda pendiente correspondiente a {year} asciende a {money(total['total'])} en {total['recibos']} recibos. La deuda total pendiente registrada en la base es {money(overall['total'])}."
            display = {
                "title": f"Deuda pendiente {year}",
                "cards": [
                    {"label": "Deuda del ejercicio", "value": money(total["total"])},
                    {"label": "Recibos pendientes", "value": str(total["recibos"])},
                    {"label": "Deuda total registrada", "value": money(overall["total"])},
                ],
            }
            print(json.dumps(response(answer, 0.84, facts={"ejercicio": year, "deuda": total["total"]}, display=display), ensure_ascii=False))
        elif len(owners) == 1:
            owner = owners[0]
            total, by_year, by_property = debt_for_owner(owner["id_propietario"])
            if total <= 0:
                answer = f"{owner['nombre']} no tiene deuda pendiente registrada actualmente."
                display = {
                    "title": owner["nombre"],
                    "subtitle": "Consulta de deuda",
                    "cards": [{"label": "Deuda pendiente", "value": money(0)}],
                }
            else:
                year_text = ", ".join([f"{r['ejercicio']}: {money(r['deuda'])}" for r in by_year]) or "sin desglose"
                prop_text = "\\n".join([f"- {r['propiedad']}: {money(r['deuda'])} ({r['recibos']} recibos)" for r in by_property[:8]])
                answer = f"{owner['nombre']} tiene deuda pendiente por {money(total)}.\\nDesglose por ejercicio: {year_text}.\\nDesglose por propiedad:\\n{prop_text}"
                display = {
                    "title": owner["nombre"],
                    "subtitle": "Consulta de deuda",
                    "cards": [
                        {"label": "Deuda total", "value": money(total)},
                        {"label": "Ejercicios con deuda", "value": str(len(by_year))},
                        {"label": "Propiedades afectadas", "value": str(len(by_property))},
                    ],
                    "tables": [
                        {
                            "title": "Desglose por ejercicio",
                            "columns": ["Ejercicio", "Deuda", "Recibos"],
                            "rows": [{"Ejercicio": str(r["ejercicio"]), "Deuda": money(r["deuda"]), "Recibos": str(r["recibos"])} for r in by_year],
                        },
                        {
                            "title": "Desglose por propiedad",
                            "columns": ["Propiedad", "Deuda", "Recibos"],
                            "rows": [{"Propiedad": r["propiedad"], "Deuda": money(r["deuda"]), "Recibos": str(r["recibos"])} for r in by_property],
                        },
                    ],
                }
            print(json.dumps(response(answer, 0.86, facts={"id_propietario": owner["id_propietario"], "deuda": total}, display=display), ensure_ascii=False))
        elif len(owners) > 1:
            answer = "He encontrado varios propietarios posibles. Necesito que elijas uno:\\n" + "\\n".join([f"- {o['nombre']} (codigo {o.get('codigo_netfincas') or 'sin codigo'})" for o in owners[:8]])
            print(json.dumps(response(answer, 0.52, candidates=[{"type":"owner","id":o["id_propietario"],"title":o["nombre"],"score":1} for o in owners[:8]], questions=["Propietario exacto"]), ensure_ascii=False))
        else:
            print(json.dumps(response("No he encontrado un propietario o propiedad claro para consultar deuda. Indica el nombre completo o el codigo de propiedad.", 0.45, questions=["Propietario o propiedad"]), ensure_ascii=False))

    elif is_owner_question:
        prop_query = extract_property_query(question)
        props = find_properties(prop_query or question)
        if len(props) == 1:
            prop = props[0]
            owners = owner_for_property(prop["id_propiedad"])
            if owners:
                answer = "\\n".join([
                    f"Propiedad {prop['codigo_propiedad']} ({prop['zona']}).",
                    f"Coeficiente: {prop['coeficiente']}.",
                    "Propietario actual:",
                    *[f"- {o['nombre']} (codigo Netfincas {o.get('codigo_netfincas') or 'sin codigo'}, NIF {o.get('nif') or 'sin dato'})" for o in owners],
                ])
            else:
                answer = f"La propiedad {prop['codigo_propiedad']} existe, pero no tiene propietario activo vinculado."
            print(json.dumps(response(answer, 0.88, facts={"id_propiedad": prop["id_propiedad"]}), ensure_ascii=False))
        elif len(props) > 1:
            answer = "He encontrado varias propiedades posibles. Necesito que concretes cual es:\\n" + "\\n".join([f"- {p['codigo_propiedad']} ({p['zona']}, coef. {p['coeficiente']})" for p in props[:10]])
            print(json.dumps(response(answer, 0.55, candidates=[{"type":"property","id":p["id_propiedad"],"title":p["codigo_propiedad"],"score":1} for p in props[:10]], questions=["Propiedad exacta"]), ensure_ascii=False))
        else:
            print(json.dumps(response("No he encontrado esa propiedad. Prueba con el codigo exacto de Netfincas, por ejemplo CB 2 -1 DCH.", 0.45, questions=["Codigo de propiedad"]), ensure_ascii=False))

    elif is_work_question:
        term = re.sub(r"(?i)\\b(como|va|van|estado|del|de|la|el|proyecto|tarea|quien|responsable|proximo|paso|lista|busca|pendientes?)\\b", " ", question)
        term = re.sub(r"[?¿]", " ", term).strip()
        like = "%" + norm(term).replace(" ", "%") + "%"
        project_matches = rows("""
            SELECT 'Proyecto' AS tipo, id_proyecto AS id, nombre AS titulo, estado_general AS estado,
                   responsable_principal AS responsable, responsable_proximo_paso, fecha_objetivo_proximo_paso,
                   fecha_ultima_actualizacion, COALESCE(observaciones,'') AS contexto
            FROM proyectos
            WHERE COALESCE(activo,1)=1 AND (? = '%%' OR UPPER(nombre) LIKE ? OR UPPER(COALESCE(descripcion,'')) LIKE ?)
            ORDER BY fecha_ultima_actualizacion DESC LIMIT 6
        """, (like, like, like))
        task_matches = rows("""
            SELECT 'Tarea' AS tipo, id_tarea AS id, titulo, estado,
                   responsable, responsable_proximo_paso, fecha_objetivo_proximo_paso,
                   fecha_ultima_actualizacion, COALESCE(proximo_paso,'') AS contexto
            FROM tareas
            WHERE COALESCE(activa,1)=1 AND COALESCE(archivada,0)=0 AND (? = '%%' OR UPPER(titulo) LIKE ? OR UPPER(COALESCE(descripcion,'')) LIKE ?)
            ORDER BY fecha_ultima_actualizacion DESC LIMIT 6
        """, (like, like, like))
        matches = project_matches + task_matches
        if matches:
            answer = "He encontrado estos elementos operativos:\\n" + "\\n".join([f"- {m['tipo']} {m['id']}: {m['titulo']} | Estado: {m['estado'] or 'sin estado'} | Responsable: {m['responsable'] or 'sin responsable'} | Proximo: {m['responsable_proximo_paso'] or 'sin dato'} | Paso: {(m['contexto'] or 'sin proximo paso')[:220]}" for m in matches[:8]])
            print(json.dumps(response(answer, 0.72, candidates=[{"type":"project" if m["tipo"]=="Proyecto" else "task","id":m["id"],"title":m["titulo"],"score":1} for m in matches[:8]]), ensure_ascii=False))
        else:
            print(json.dumps(response("No he encontrado tareas o proyectos con esa referencia. Dame alguna palabra clave del titulo o responsable.", 0.45, questions=["Referencia de tarea/proyecto"]), ensure_ascii=False))
    else:
        print(json.dumps(not_handled(), ensure_ascii=False))
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function targetedRecordProposal(text, context, target) {
  const type = String(target?.type || "").trim();
  const id = Number(target?.id || 0);
  if (!["task", "project"].includes(type) || !id) return null;
  const rows = type === "task" ? (context.tasks || []) : (context.projects || []);
  const item = rows.find((row) => Number(row.id) === id) || { id, titulo: target?.title || "", estado: "", prioridad: "Media", responsable: "" };
  const isTask = type === "task";
  const currentState = item.estado || (isTask ? "Pendiente" : "En curso");
  const currentOwner = item.responsable || "";
  return {
    source: "local-db",
    confidence: 0.9,
    action: isTask ? "seguimiento_tarea" : "seguimiento_proyecto",
    answer: "Seguimiento preparado sobre el elemento seleccionado. Revisa los campos antes de guardar.",
    entity: { type, id, title: item.titulo || target?.title || "" },
    candidates: [{ type, id, title: item.titulo || target?.title || "", score: 10 }],
    payload: {
      tipo_registro: "Seguimiento",
      comentario: buildFormalComment(text, item).slice(0, 4000),
      estado_nuevo: detectState(text, currentState),
      prioridad_nueva: detectPriority(text, item.prioridad || "Media"),
      responsable_nuevo: currentOwner,
      responsable_proximo_paso: detectResponsible(text, item.responsable_proximo_paso || currentOwner),
      fecha_objetivo_proximo_paso: "",
      fecha_proxima_revision: "",
      proximo_paso: buildFormalNextStep(text, item.proximo_paso || ""),
      motivo_bloqueo: "",
    },
  };
}

async function analyzeWithAi(session, text, target = null) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("El texto para analizar es obligatorio.");
  const context = await queryAiContext(session);
  const targeted = targetedRecordProposal(cleanText, context, target);
  if (targeted) return targeted;
  const smart = await querySmartAssistant(session, cleanText);
  if (smart?.handled) return smart;
  const fallback = localAiProposal(cleanText, context);
  try {
    const external = await externalAiProposal(cleanText, context);
    return external ? { ...fallback, ...external, fallbackSource: fallback.source } : fallback;
  } catch (error) {
    return { ...fallback, warning: `${error.message}. Se ha usado analisis local sin consumo externo.` };
  }
}

function queryActionOptions(session) {
  const script = `
import json
import sqlite3

path = ${JSON.stringify(databasePath)}
role = ${JSON.stringify(session?.rol || "")}
allowed_ids = ${JSON.stringify((session?.comunidades || []).map((community) => Number(community.id_comunidad)).filter(Boolean))}
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row

def values(sql, params=()):
    return [row[0] for row in conn.execute(sql, params).fetchall() if row[0]]

def community_filter(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1 = 0", []
    marks = ",".join("?" for _ in allowed_ids)
    prefix = f"{alias}." if alias else ""
    return f" AND {prefix}id_comunidad IN ({marks})", allowed_ids

project_filter, project_params = community_filter("p")
task_filter, task_params = community_filter("t")
responsables = values("SELECT nombre FROM responsables WHERE COALESCE(activo, 1) = 1 ORDER BY tipo, nombre")
for source in [
    values("SELECT DISTINCT responsable FROM tareas t WHERE COALESCE(t.activa, 1) = 1" + task_filter, task_params),
    values("SELECT DISTINCT responsable_principal FROM proyectos p WHERE COALESCE(p.activo, 1) = 1" + project_filter, project_params),
    values("SELECT DISTINCT responsable_proximo_paso FROM tareas t WHERE COALESCE(t.activa, 1) = 1" + task_filter, task_params),
    values("SELECT DISTINCT responsable_proximo_paso FROM proyectos p WHERE COALESCE(p.activo, 1) = 1" + project_filter, project_params),
]:
    responsables.extend(source)
responsables = sorted(dict.fromkeys([str(v).strip() for v in responsables if str(v).strip()]))
community_filter_sql, community_params = community_filter("c")
communities = [dict(row) for row in conn.execute("""
    SELECT c.id_comunidad AS id, c.nombre
    FROM comunidades c
    WHERE COALESCE(c.activo, 1) = 1
""" + community_filter_sql + " ORDER BY c.nombre", community_params)]
projects_for_create = [dict(row) for row in conn.execute("""
    SELECT p.id_proyecto AS id, p.nombre, p.id_comunidad
    FROM proyectos p
    WHERE COALESCE(p.activo, 1) = 1
""" + project_filter + " ORDER BY p.nombre", project_params)]
conn.close()
print(json.dumps({
    "estados_tarea": ["Pendiente", "En curso", "Pendiente de tercero", "Bloqueada", "Terminada", "Archivada"],
    "estados_proyecto": ["Pendiente", "En curso", "Pendiente de tercero", "Bloqueado", "Finalizado", "Archivado"],
    "prioridades": ["Urgente", "Alta", "Media", "Baja"],
    "tipos_registro": ["Seguimiento", "Decision", "Llamada", "Correo", "Reunion", "Incidencia", "Cierre"],
    "responsables": responsables,
    "comunidades": communities,
    "proyectos": projects_for_create,
}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function queryEntityDetail(session, type, id) {
  const script = `
import json
import sqlite3

path = ${JSON.stringify(databasePath)}
role = ${JSON.stringify(session?.rol || "")}
allowed_ids = ${JSON.stringify((session?.comunidades || []).map((community) => Number(community.id_comunidad)).filter(Boolean))}
entity_type = ${JSON.stringify(type)}
entity_id = int(${JSON.stringify(id)})
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def allowed(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1 = 0", []
    marks = ",".join("?" for _ in allowed_ids)
    return f" AND {alias}.id_comunidad IN ({marks})", allowed_ids

if entity_type == "task":
    f, params = allowed("t")
    item = conn.execute("""
        SELECT t.*, p.nombre AS proyecto, c.nombre AS comunidad
        FROM tareas t
        LEFT JOIN proyectos p ON p.id_proyecto = t.id_proyecto
        LEFT JOIN comunidades c ON c.id_comunidad = t.id_comunidad
        WHERE t.id_tarea = ?
    """ + f, tuple([entity_id] + params)).fetchone()
    if not item:
        raise SystemExit(json.dumps({"error": "No encontrado o sin permiso."}, ensure_ascii=False))
    history = [dict(r) for r in conn.execute("""
        SELECT *
        FROM registros
        WHERE id_tarea = ?
        ORDER BY fecha_hora DESC, id_registro DESC
        LIMIT 80
    """, (entity_id,))]
    attachments = [dict(r) for r in conn.execute("""
        SELECT *
        FROM anexos_registros
        WHERE tipo_entidad = 'tarea' AND id_tarea = ?
        ORDER BY fecha_adjuntado DESC, id_anexo DESC
    """, (entity_id,))]
else:
    f, params = allowed("p")
    item = conn.execute("""
        SELECT p.*, c.nombre AS comunidad
        FROM proyectos p
        LEFT JOIN comunidades c ON c.id_comunidad = p.id_comunidad
        WHERE p.id_proyecto = ?
    """ + f, tuple([entity_id] + params)).fetchone()
    if not item:
        raise SystemExit(json.dumps({"error": "No encontrado o sin permiso."}, ensure_ascii=False))
    history = [dict(r) for r in conn.execute("""
        SELECT *
        FROM registros_proyectos
        WHERE id_proyecto = ?
        ORDER BY fecha_hora DESC, id_registro_proyecto DESC
        LIMIT 80
    """, (entity_id,))]
    attachments = [dict(r) for r in conn.execute("""
        SELECT *
        FROM anexos_registros
        WHERE tipo_entidad = 'proyecto' AND id_proyecto = ?
        ORDER BY fecha_adjuntado DESC, id_anexo DESC
    """, (entity_id,))]
conn.close()
print(json.dumps({"item": dict(item), "history": history, "attachments": attachments}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function writeEntityRecord(session, type, id, payload, pc) {
  const script = `
import json
import sqlite3
from datetime import datetime, date

path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
entity_type = ${JSON.stringify(type)}
entity_id = int(${JSON.stringify(id)})
data = ${JSON.stringify(payload || {})}
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def today_iso():
    return date.today().isoformat()

def is_superuser():
    return role == "Superusuario"

def check_can_write():
    if not user:
        raise PermissionError("No autenticado.")
    if role == "Presidente":
        raise PermissionError("El perfil Presidente solo puede responder solicitudes, no modificar tareas ni proyectos.")
    if role not in {"Superusuario", "Administrador", "Usuario"}:
        raise PermissionError("Tu perfil no tiene permiso de escritura.")

def ensure_allowed(cid):
    if is_superuser():
        return
    if not allowed_ids or int(cid or 0) not in allowed_ids:
        raise PermissionError("No tienes permiso para modificar esta comunidad.")

def row_to_dict(row):
    return dict(row) if row else None

def audit(conn, action, entity="", entity_id_value=None, detail=""):
    conn.execute(
        "INSERT INTO auditoria (fecha_hora, usuario, pc, accion, entidad, id_entidad, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (now_iso(), user, pc, action, entity, entity_id_value, str(detail or "")[:1000]),
    )

def active_users(conn):
    return [r["nombre"] for r in conn.execute("SELECT nombre FROM usuarios WHERE COALESCE(activo, 1) = 1 ORDER BY nombre")]

def responsible_aliases(name):
    return {
        "Luis Gallardo": ["Luis Gallardo", "Luis"],
        "Elena Cuenca": ["Elena Cuenca"],
        "Presidente": ["Presidente"],
    }.get(name, [name])

def user_for_responsible(conn, value):
    target = str(value or "").strip().lower()
    if not target:
        return ""
    for candidate in active_users(conn):
        if target in {alias.lower() for alias in responsible_aliases(candidate)}:
            return candidate
    return ""

def is_president_responsible(value):
    return str(value or "").strip().lower() in {"presidente", "presidencia"}

def create_notification(conn, usuario_destino, tipo, titulo, mensaje, id_comunidad, id_tarea=None, id_proyecto=None, id_solicitud=None):
    conn.execute(
        """
        INSERT INTO notificaciones
        (id_comunidad, usuario_destino, tipo, titulo, mensaje, id_solicitud, id_tarea, id_proyecto, leida, fecha_creacion)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        """,
        (id_comunidad, usuario_destino, tipo, titulo, mensaje, id_solicitud, id_tarea, id_proyecto, now_iso()),
    )

def close_pending_actions_for_entity(conn, tipo_entidad, entity_id_value, comment):
    aliases = responsible_aliases(user)
    if not aliases:
        return
    task_id = entity_id_value if tipo_entidad == "tarea" else None
    project_id = entity_id_value if tipo_entidad == "proyecto" else None
    marks = ",".join("?" for _ in aliases)
    conn.execute(
        f"""
        UPDATE acciones_pendientes
        SET estado = 'Completada',
            fecha_cierre = ?,
            usuario_cierre = ?,
            comentario_cierre = ?,
            pc_cierre = ?
        WHERE estado = 'Pendiente'
          AND tipo_entidad = ?
          AND COALESCE(id_tarea, 0) = COALESCE(?, 0)
          AND COALESCE(id_proyecto, 0) = COALESCE(?, 0)
          AND usuario_destino IN ({marks})
        """,
        tuple([now_iso(), user, str(comment or "")[:500], pc, tipo_entidad, task_id, project_id] + aliases),
    )

def cancel_stale_pending_actions(conn, tipo_entidad, entity_id_value, keep_user, comment):
    task_id = entity_id_value if tipo_entidad == "tarea" else None
    project_id = entity_id_value if tipo_entidad == "proyecto" else None
    params = [now_iso(), user, str(comment or "")[:500], pc, tipo_entidad, task_id, project_id]
    extra = ""
    if keep_user:
        extra = " AND usuario_destino <> ?"
        params.append(keep_user)
    conn.execute(
        f"""
        UPDATE acciones_pendientes
        SET estado = 'Cancelada',
            fecha_cierre = ?,
            usuario_cierre = ?,
            comentario_cierre = ?,
            pc_cierre = ?
        WHERE estado = 'Pendiente'
          AND tipo_entidad = ?
          AND COALESCE(id_tarea, 0) = COALESCE(?, 0)
          AND COALESCE(id_proyecto, 0) = COALESCE(?, 0)
          {extra}
        """,
        tuple(params),
    )

def create_pending_action(conn, tipo_entidad, entity_id_value, usuario_destino, titulo, detalle, id_comunidad, record_id, tipo_accion):
    if not usuario_destino or usuario_destino == user:
        return None
    if usuario_destino not in active_users(conn):
        return None
    task_id = entity_id_value if tipo_entidad == "tarea" else None
    project_id = entity_id_value if tipo_entidad == "proyecto" else None
    existing = conn.execute(
        """
        SELECT id_accion
        FROM acciones_pendientes
        WHERE estado = 'Pendiente'
          AND tipo_entidad = ?
          AND COALESCE(id_tarea, 0) = COALESCE(?, 0)
          AND COALESCE(id_proyecto, 0) = COALESCE(?, 0)
          AND usuario_destino = ?
        ORDER BY fecha_creacion DESC, id_accion DESC
        LIMIT 1
        """,
        (tipo_entidad, task_id, project_id, usuario_destino),
    ).fetchone()
    if existing:
        return int(existing["id_accion"])
    cur = conn.execute(
        """
        INSERT INTO acciones_pendientes
        (id_comunidad, tipo_entidad, id_tarea, id_proyecto, id_registro_origen,
         tipo_accion, usuario_destino, solicitante, titulo, detalle, estado,
         fecha_creacion, pc_creacion)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?)
        """,
        (id_comunidad, tipo_entidad, task_id, project_id, record_id, tipo_accion, usuario_destino, user, titulo, detalle, now_iso(), pc),
    )
    action_id = int(cur.lastrowid)
    create_notification(conn, usuario_destino, "Accion pendiente", f"{tipo_accion} pendiente: {titulo}", detalle, id_comunidad, task_id, project_id)
    audit(conn, "Crear accion pendiente", "accion_pendiente", action_id, f"{usuario_destino}: {titulo}")
    return action_id

def create_president_request(conn, entity_kind, item, record_id, comentario, proximo_paso):
    if entity_kind == "tarea":
        cur = conn.execute(
            """
            INSERT INTO solicitudes_presidente
            (id_comunidad, tipo_origen, id_tarea, id_proyecto, id_registro_tarea,
             titulo, detalle, solicitante, ultimo_comentario, proximo_paso_solicitado,
             responsable_original, responsable_retorno, estado, fecha_creacion, usuario_creacion, pc_creacion)
            VALUES (?, 'tarea', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?, ?)
            """,
            (
                item["id_comunidad"], item["id_tarea"], item["id_proyecto"], record_id,
                f"Aprobacion solicitada: {item['titulo']}", comentario, user, comentario, proximo_paso,
                item["responsable_proximo_paso"] or item["responsable"] or user, user, now_iso(), user, pc,
            ),
        )
        request_id = int(cur.lastrowid)
        create_notification(conn, "Presidente", "Solicitud presidente", f"Aprobacion pendiente: {item['titulo']}", comentario, item["id_comunidad"], item["id_tarea"], item["id_proyecto"], request_id)
    else:
        cur = conn.execute(
            """
            INSERT INTO solicitudes_presidente
            (id_comunidad, tipo_origen, id_proyecto, id_registro_proyecto,
             titulo, detalle, solicitante, ultimo_comentario, proximo_paso_solicitado,
             responsable_original, responsable_retorno, estado, fecha_creacion, usuario_creacion, pc_creacion)
            VALUES (?, 'proyecto', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente', ?, ?, ?)
            """,
            (
                item["id_comunidad"], item["id_proyecto"], record_id,
                f"Aprobacion solicitada: {item['nombre']}", comentario, user, comentario, proximo_paso,
                item["responsable_proximo_paso"] or item["responsable_principal"] or user, user, now_iso(), user, pc,
            ),
        )
        request_id = int(cur.lastrowid)
        create_notification(conn, "Presidente", "Solicitud presidente", f"Aprobacion pendiente: {item['nombre']}", comentario, item["id_comunidad"], None, item["id_proyecto"], request_id)
    audit(conn, "Crear solicitud para presidente", "solicitud_presidente", request_id, comentario)
    return request_id

check_can_write()
comentario = str(data.get("comentario") or "").strip()
if not comentario:
    raise ValueError("El comentario es obligatorio.")
tipo_registro = str(data.get("tipo_registro") or "Seguimiento").strip() or "Seguimiento"
motivo_bloqueo = str(data.get("motivo_bloqueo") or "").strip()
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA foreign_keys = ON")
    with conn:
        if entity_type == "task":
            task = conn.execute("""
                SELECT t.*, p.nombre AS proyecto
                FROM tareas t
                LEFT JOIN proyectos p ON p.id_proyecto = t.id_proyecto
                WHERE t.id_tarea = ?
            """, (entity_id,)).fetchone()
            if not task:
                raise ValueError("La tarea no existe.")
            ensure_allowed(task["id_comunidad"])
            estado_nuevo = str(data.get("estado_nuevo") or task["estado"] or "Pendiente").strip()
            if estado_nuevo == "Bloqueada" and not motivo_bloqueo:
                raise ValueError("El motivo del bloqueo es obligatorio.")
            prioridad_nueva = str(data.get("prioridad_nueva") or task["prioridad"] or "Media").strip()
            responsable_nuevo = str(data.get("responsable_nuevo") or task["responsable"] or user).strip()
            proximo_paso = str(data.get("proximo_paso") or task["proximo_paso"] or "").strip()
            fecha_revision = str(data.get("fecha_proxima_revision") or task["fecha_proxima_revision"] or "").strip()
            next_owner = str(data.get("responsable_proximo_paso") or responsable_nuevo).strip()
            next_date = str(data.get("fecha_objetivo_proximo_paso") or fecha_revision).strip()
            ts = now_iso()
            cur = conn.execute(
                """
                INSERT INTO registros
                (id_comunidad, id_tarea, id_proyecto, fecha_hora, tipo_registro, comentario,
                 estado_anterior, estado_nuevo, prioridad_anterior, prioridad_nueva,
                 responsable_anterior, responsable_nuevo, proximo_paso, responsable_proximo_paso,
                 fecha_objetivo_proximo_paso, fecha_proxima_revision, motivo_bloqueo, usuario, pc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (task["id_comunidad"], entity_id, task["id_proyecto"], ts, tipo_registro, comentario,
                 task["estado"], estado_nuevo, task["prioridad"], prioridad_nueva, task["responsable"],
                 responsable_nuevo, proximo_paso, next_owner, next_date, fecha_revision, motivo_bloqueo, user, pc),
            )
            record_id = int(cur.lastrowid)
            activa = 0 if estado_nuevo in ("Terminada", "Cancelada", "Archivada") else 1
            archivada = 1 if estado_nuevo == "Archivada" else int(task["archivada"] or 0)
            conn.execute(
                """
                UPDATE tareas
                SET estado = ?, prioridad = ?, responsable = ?, proximo_paso = ?,
                    responsable_proximo_paso = ?, fecha_objetivo_proximo_paso = ?,
                    fecha_proxima_revision = ?, fecha_ultima_actualizacion = ?,
                    activa = ?, archivada = ?, usuario_ultima_actualizacion = ?, pc_ultima_actualizacion = ?
                WHERE id_tarea = ?
                """,
                (estado_nuevo, prioridad_nueva, responsable_nuevo, proximo_paso, next_owner, next_date,
                 fecha_revision, ts, activa, archivada, user, pc, entity_id),
            )
            close_pending_actions_for_entity(conn, "tarea", entity_id, comentario)
            target_user = user_for_responsible(conn, next_owner)
            if is_president_responsible(next_owner):
                create_president_request(conn, "tarea", task, record_id, comentario, proximo_paso)
            elif target_user:
                create_pending_action(conn, "tarea", entity_id, target_user, task["titulo"], proximo_paso or comentario, task["id_comunidad"], record_id, str(data.get("tipo_accion") or "Actualizacion"))
            cancel_stale_pending_actions(conn, "tarea", entity_id, target_user, f"Responsable proximo paso: {next_owner}")
            audit(conn, "Seguimiento de tarea web", "tarea", entity_id, f"{task['estado']} -> {estado_nuevo}")
        else:
            project = conn.execute("SELECT * FROM proyectos WHERE id_proyecto = ?", (entity_id,)).fetchone()
            if not project:
                raise ValueError("El proyecto no existe.")
            ensure_allowed(project["id_comunidad"])
            estado_nuevo = str(data.get("estado_nuevo") or project["estado_general"] or "En curso").strip()
            if estado_nuevo == "Bloqueado" and not motivo_bloqueo:
                raise ValueError("El motivo del bloqueo es obligatorio.")
            prioridad_nueva = str(data.get("prioridad_nueva") or project["prioridad"] or "Media").strip()
            responsable_nuevo = str(data.get("responsable_nuevo") or project["responsable_principal"] or user).strip()
            proximo_paso = str(data.get("proximo_paso") or "").strip()
            fecha_revision = str(data.get("fecha_proxima_revision") or "").strip()
            next_owner = str(data.get("responsable_proximo_paso") or responsable_nuevo).strip()
            next_date = str(data.get("fecha_objetivo_proximo_paso") or fecha_revision).strip()
            ts = now_iso()
            cur = conn.execute(
                """
                INSERT INTO registros_proyectos
                (id_comunidad, id_proyecto, fecha_hora, tipo_registro, comentario, estado_anterior,
                 estado_nuevo, prioridad_anterior, prioridad_nueva, responsable_anterior,
                 responsable_nuevo, proximo_paso, responsable_proximo_paso, fecha_objetivo_proximo_paso,
                 fecha_proxima_revision, motivo_bloqueo, usuario, pc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (project["id_comunidad"], entity_id, ts, tipo_registro, comentario, project["estado_general"],
                 estado_nuevo, project["prioridad"], prioridad_nueva, project["responsable_principal"] or "",
                 responsable_nuevo, proximo_paso, next_owner, next_date, fecha_revision, motivo_bloqueo, user, pc),
            )
            record_id = int(cur.lastrowid)
            activo = 0 if estado_nuevo in ("Cancelado", "Archivado") else int(project["activo"] or 1)
            final_date = today_iso() if estado_nuevo == "Finalizado" and not project["fecha_real_finalizacion"] else project["fecha_real_finalizacion"]
            conn.execute(
                """
                UPDATE proyectos
                SET estado_general = ?, prioridad = ?, responsable_principal = ?,
                    responsable_proximo_paso = ?, fecha_objetivo_proximo_paso = ?,
                    activo = ?, fecha_real_finalizacion = ?, fecha_ultima_actualizacion = ?,
                    usuario_ultima_actualizacion = ?, pc_ultima_actualizacion = ?
                WHERE id_proyecto = ?
                """,
                (estado_nuevo, prioridad_nueva, responsable_nuevo, next_owner, next_date, activo, final_date, ts, user, pc, entity_id),
            )
            close_pending_actions_for_entity(conn, "proyecto", entity_id, comentario)
            target_user = user_for_responsible(conn, next_owner)
            if is_president_responsible(next_owner):
                create_president_request(conn, "proyecto", project, record_id, comentario, proximo_paso)
            elif target_user:
                create_pending_action(conn, "proyecto", entity_id, target_user, project["nombre"], proximo_paso or comentario, project["id_comunidad"], record_id, str(data.get("tipo_accion") or "Actualizacion"))
            cancel_stale_pending_actions(conn, "proyecto", entity_id, target_user, f"Responsable proximo paso: {next_owner}")
            audit(conn, "Seguimiento de proyecto web", "proyecto", entity_id, f"{project['estado_general']} -> {estado_nuevo}")
    print(json.dumps({"ok": True, "record_id": record_id}, ensure_ascii=False))
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function createEntity(session, type, payload, pc) {
  const script = `
import json
import sqlite3
from datetime import datetime, date

path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
entity_type = ${JSON.stringify(type)}
data = ${JSON.stringify(payload || {})}
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def today_iso():
    return date.today().isoformat()

def is_superuser():
    return role == "Superusuario"

def audit(conn, action, entity="", entity_id_value=None, detail=""):
    conn.execute(
        "INSERT INTO auditoria (fecha_hora, usuario, pc, accion, entidad, id_entidad, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (now_iso(), user, pc, action, entity, entity_id_value, str(detail or "")[:1000]),
    )

def check_can_write():
    if not user:
        raise PermissionError("No autenticado.")
    if role == "Presidente":
        raise PermissionError("El perfil Presidente no puede crear tareas ni proyectos.")
    if role not in {"Superusuario", "Administrador", "Usuario"}:
        raise PermissionError("Tu perfil no tiene permiso de escritura.")

def choose_community(conn):
    requested = data.get("id_comunidad")
    if requested:
        cid = int(requested)
    elif not is_superuser() and len(allowed_ids) == 1:
        cid = allowed_ids[0]
    else:
        row = conn.execute("SELECT id_comunidad FROM comunidades WHERE nombre = 'Macrocomunidad San Roque Club' AND COALESCE(activo, 1) = 1").fetchone()
        cid = int(row["id_comunidad"]) if row else (allowed_ids[0] if allowed_ids else 0)
    if not cid:
        raise ValueError("No hay comunidad disponible para crear el elemento.")
    if not is_superuser() and cid not in allowed_ids:
        raise PermissionError("No tienes permiso para crear en esta comunidad.")
    return cid

check_can_write()
titulo = str(data.get("titulo") or data.get("nombre") or "").strip()
if not titulo:
    raise ValueError("El titulo es obligatorio.")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA foreign_keys = ON")
    with conn:
        cid = choose_community(conn)
        if entity_type == "project":
            cur = conn.execute(
                """
                INSERT INTO proyectos
                (id_comunidad, nombre, descripcion, categoria, estado_general, prioridad,
                 responsable_principal, responsable_proximo_paso, fecha_objetivo_proximo_paso,
                 fecha_inicio, observaciones, activo, fecha_creacion, fecha_ultima_actualizacion,
                 usuario_creacion, pc_creacion, usuario_ultima_actualizacion, pc_ultima_actualizacion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
                """,
                (
                    cid, titulo, str(data.get("descripcion") or data.get("comentario") or "").strip(),
                    str(data.get("categoria") or "General").strip(),
                    str(data.get("estado_nuevo") or data.get("estado") or "En curso").strip(),
                    str(data.get("prioridad_nueva") or data.get("prioridad") or "Media").strip(),
                    str(data.get("responsable_nuevo") or data.get("responsable") or user).strip(),
                    str(data.get("responsable_proximo_paso") or data.get("responsable_nuevo") or data.get("responsable") or user).strip(),
                    str(data.get("fecha_objetivo_proximo_paso") or data.get("fecha_proxima_revision") or "").strip(),
                    today_iso(), str(data.get("proximo_paso") or "").strip(),
                    now_iso(), now_iso(), user, pc, user, pc,
                ),
            )
            new_id = int(cur.lastrowid)
            audit(conn, "Crear proyecto web IA", "proyecto", new_id, titulo)
            print(json.dumps({"ok": True, "type": "project", "id": new_id}, ensure_ascii=False))
        elif entity_type == "task":
            project_id = int(data.get("id_proyecto") or 0)
            if not project_id:
                raise ValueError("Para crear una tarea desde la web debes seleccionar un proyecto contenedor.")
            project = conn.execute("SELECT * FROM proyectos WHERE id_proyecto = ?", (project_id,)).fetchone()
            if not project:
                raise ValueError("El proyecto seleccionado no existe.")
            if not is_superuser() and int(project["id_comunidad"] or 0) not in allowed_ids:
                raise PermissionError("No tienes permiso para usar ese proyecto.")
            cur = conn.execute(
                """
                INSERT INTO tareas
                (id_comunidad, id_proyecto, titulo, descripcion, categoria, estado, prioridad,
                 responsable, responsable_proximo_paso, fecha_objetivo_proximo_paso,
                 fecha_proxima_revision, proximo_paso, activa, archivada,
                 fecha_creacion, fecha_ultima_actualizacion, usuario_creacion, pc_creacion,
                 usuario_ultima_actualizacion, pc_ultima_actualizacion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)
                """,
                (
                    int(project["id_comunidad"]), project_id, titulo,
                    str(data.get("descripcion") or data.get("comentario") or "").strip(),
                    str(data.get("categoria") or "General").strip(),
                    str(data.get("estado_nuevo") or data.get("estado") or "Pendiente").strip(),
                    str(data.get("prioridad_nueva") or data.get("prioridad") or "Media").strip(),
                    str(data.get("responsable_nuevo") or data.get("responsable") or user).strip(),
                    str(data.get("responsable_proximo_paso") or data.get("responsable_nuevo") or data.get("responsable") or user).strip(),
                    str(data.get("fecha_objetivo_proximo_paso") or data.get("fecha_proxima_revision") or "").strip(),
                    str(data.get("fecha_proxima_revision") or data.get("fecha_objetivo_proximo_paso") or "").strip(),
                    str(data.get("proximo_paso") or "").strip(),
                    now_iso(), now_iso(), user, pc, user, pc,
                ),
            )
            new_id = int(cur.lastrowid)
            audit(conn, "Crear tarea web IA", "tarea", new_id, titulo)
            print(json.dumps({"ok": True, "type": "task", "id": new_id}, ensure_ascii=False))
        else:
            raise ValueError("Tipo de entidad no valido.")
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function updateEntity(session, type, id, payload, pc, archive = false) {
  const script = `
import json
import sqlite3
from datetime import datetime, date

path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
entity_type = ${JSON.stringify(type)}
entity_id = int(${JSON.stringify(id)})
data = ${JSON.stringify(payload || {})}
pc = ${JSON.stringify(pc || "web")}
archive = ${archive ? "True" : "False"}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def today_iso():
    return date.today().isoformat()

def is_superuser():
    return role == "Superusuario"

def check_can_write():
    if not user:
        raise PermissionError("No autenticado.")
    if role == "Presidente":
        raise PermissionError("El perfil Presidente no puede editar tareas ni proyectos.")
    if role not in {"Superusuario", "Administrador", "Usuario"}:
        raise PermissionError("Tu perfil no tiene permiso de escritura.")

def ensure_allowed(cid):
    if not is_superuser() and int(cid or 0) not in allowed_ids:
        raise PermissionError("No tienes permiso para modificar esta comunidad.")

def audit(conn, action, entity="", entity_id_value=None, detail=""):
    conn.execute(
        "INSERT INTO auditoria (fecha_hora, usuario, pc, accion, entidad, id_entidad, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (now_iso(), user, pc, action, entity, entity_id_value, str(detail or "")[:1000]),
    )

check_can_write()
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
try:
    conn.execute("PRAGMA foreign_keys = ON")
    with conn:
        ts = now_iso()
        if entity_type == "task":
            item = conn.execute("SELECT * FROM tareas WHERE id_tarea = ?", (entity_id,)).fetchone()
            if not item:
                raise ValueError("La tarea no existe.")
            ensure_allowed(item["id_comunidad"])
            if archive:
                conn.execute("""
                    UPDATE tareas
                    SET archivada = 1, activa = 0, estado = 'Archivada',
                        fecha_ultima_actualizacion = ?, usuario_ultima_actualizacion = ?, pc_ultima_actualizacion = ?
                    WHERE id_tarea = ?
                """, (ts, user, pc, entity_id))
                audit(conn, "Archivar tarea web", "tarea", entity_id, item["titulo"])
                print(json.dumps({"ok": True, "type": "task", "id": entity_id, "archived": True}, ensure_ascii=False))
            else:
                title = str(data.get("titulo") or item["titulo"] or "").strip()
                if not title:
                    raise ValueError("El titulo es obligatorio.")
                conn.execute("""
                    UPDATE tareas
                    SET titulo = ?, descripcion = ?, categoria = ?, estado = ?, prioridad = ?,
                        responsable = ?, responsable_proximo_paso = ?, fecha_objetivo_proximo_paso = ?,
                        fecha_proxima_revision = ?, proximo_paso = ?, dependencia_bloqueo = ?,
                        observaciones_internas = ?, fecha_ultima_actualizacion = ?,
                        usuario_ultima_actualizacion = ?, pc_ultima_actualizacion = ?
                    WHERE id_tarea = ?
                """, (
                    title,
                    str(data.get("descripcion") or "").strip(),
                    str(data.get("categoria") or "General").strip(),
                    str(data.get("estado") or item["estado"] or "Pendiente").strip(),
                    str(data.get("prioridad") or item["prioridad"] or "Media").strip(),
                    str(data.get("responsable") or item["responsable"] or user).strip(),
                    str(data.get("responsable_proximo_paso") or data.get("responsable") or item["responsable_proximo_paso"] or item["responsable"] or user).strip(),
                    str(data.get("fecha_objetivo_proximo_paso") or "").strip(),
                    str(data.get("fecha_proxima_revision") or data.get("fecha_objetivo_proximo_paso") or "").strip(),
                    str(data.get("proximo_paso") or "").strip(),
                    str(data.get("dependencia_bloqueo") or "").strip(),
                    str(data.get("observaciones_internas") or "").strip(),
                    ts, user, pc, entity_id,
                ))
                audit(conn, "Editar tarea web", "tarea", entity_id, f"{item['titulo']} -> {title}")
                print(json.dumps({"ok": True, "type": "task", "id": entity_id}, ensure_ascii=False))
        elif entity_type == "project":
            item = conn.execute("SELECT * FROM proyectos WHERE id_proyecto = ?", (entity_id,)).fetchone()
            if not item:
                raise ValueError("El proyecto no existe.")
            ensure_allowed(item["id_comunidad"])
            if archive:
                conn.execute("""
                    UPDATE proyectos
                    SET activo = 0, estado_general = 'Archivado',
                        fecha_ultima_actualizacion = ?, usuario_ultima_actualizacion = ?, pc_ultima_actualizacion = ?
                    WHERE id_proyecto = ?
                """, (ts, user, pc, entity_id))
                audit(conn, "Archivar proyecto web", "proyecto", entity_id, item["nombre"])
                print(json.dumps({"ok": True, "type": "project", "id": entity_id, "archived": True}, ensure_ascii=False))
            else:
                title = str(data.get("titulo") or data.get("nombre") or item["nombre"] or "").strip()
                if not title:
                    raise ValueError("El nombre del proyecto es obligatorio.")
                state = str(data.get("estado") or item["estado_general"] or "En curso").strip()
                final_date = item["fecha_real_finalizacion"]
                if state == "Finalizado" and not final_date:
                    final_date = today_iso()
                conn.execute("""
                    UPDATE proyectos
                    SET nombre = ?, descripcion = ?, categoria = ?, estado_general = ?, prioridad = ?,
                        responsable_principal = ?, responsable_proximo_paso = ?, fecha_objetivo_proximo_paso = ?,
                        fecha_prevista_finalizacion = ?, fecha_real_finalizacion = ?, observaciones = ?,
                        fecha_ultima_actualizacion = ?, usuario_ultima_actualizacion = ?, pc_ultima_actualizacion = ?
                    WHERE id_proyecto = ?
                """, (
                    title,
                    str(data.get("descripcion") or "").strip(),
                    str(data.get("categoria") or "General").strip(),
                    state,
                    str(data.get("prioridad") or item["prioridad"] or "Media").strip(),
                    str(data.get("responsable") or item["responsable_principal"] or user).strip(),
                    str(data.get("responsable_proximo_paso") or data.get("responsable") or item["responsable_proximo_paso"] or item["responsable_principal"] or user).strip(),
                    str(data.get("fecha_objetivo_proximo_paso") or "").strip(),
                    str(data.get("fecha_prevista_finalizacion") or "").strip(),
                    str(data.get("fecha_real_finalizacion") or final_date or "").strip(),
                    str(data.get("proximo_paso") or data.get("observaciones") or "").strip(),
                    ts, user, pc, entity_id,
                ))
                audit(conn, "Editar proyecto web", "proyecto", entity_id, f"{item['nombre']} -> {title}")
                print(json.dumps({"ok": True, "type": "project", "id": entity_id}, ensure_ascii=False))
        else:
            raise ValueError("Tipo de entidad no valido.")
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function homePage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${appName}</title>
  <style>
    :root {
      --bg:#f3f6fb; --surface:#ffffff; --surface-soft:#f8fafc; --ink:#111827; --muted:#64748b;
      --line:#d9e2ee; --blue:#1d4ed8; --blue-soft:#dbeafe; --green:#15803d; --amber:#b45309;
      --red:#b91c1c; --shadow:0 10px 30px rgba(15,23,42,.08);
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: var(--bg); color: var(--ink); }
    header { background:#0f172a; color:white; padding:16px 22px; }
    .topbar { max-width:1480px; margin:0 auto; display:flex; justify-content:space-between; gap:16px; align-items:center; }
    .brand h1 { margin:0; font-size:22px; line-height:1.1; }
    .brand p { margin:5px 0 0; color:#cbd5e1; font-size:13px; }
    .session { display:flex; gap:10px; align-items:center; justify-content:flex-end; flex-wrap:wrap; font-size:13px; color:#dbeafe; }
    main { max-width: 1480px; margin: 0 auto; padding: 16px; }
    section { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    h2 { margin: 0; font-size: 19px; }
    label { display:block; font-weight:700; font-size:13px; color:#334155; margin:10px 0 4px; }
    .muted { color: var(--muted); }
    .grid { display:grid; gap:12px; }
    .counts { grid-template-columns: repeat(6, minmax(130px, 1fr)); margin-bottom:12px; }
    .count { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:12px; box-shadow:0 1px 0 rgba(15,23,42,.03); }
    .count strong { display:block; font-size:25px; margin-top:4px; }
    .workbench { display:grid; grid-template-columns: 270px 1fr; gap:12px; align-items:start; }
    .sidebar { position:sticky; top:12px; }
    .sidebar h2 { margin-bottom:10px; }
    .tabs { display:grid; gap:8px; }
    .tab { width:100%; display:flex; justify-content:space-between; align-items:center; text-align:left; background:var(--surface-soft); color:#1f2937; border:1px solid var(--line); }
    .tab.active { background:var(--blue); color:white; border-color:var(--blue); }
    .tab span:last-child { font-weight:800; }
    .filters { display:grid; gap:9px; margin-top:12px; }
    input, select { border:1px solid #cbd5e1; border-radius:6px; padding:10px 11px; font:14px Segoe UI, Arial, sans-serif; width:100%; min-height:40px; background:white; color:var(--ink); }
    .toolbar { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
    .contentHead { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:12px; }
    .contentHead p { margin:5px 0 0; font-size:13px; }
    .cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(315px, 1fr)); gap:11px; }
    .card { border:1px solid var(--line); border-left:6px solid #94a3b8; border-radius:8px; padding:12px; background:#fff; min-height:154px; box-shadow:0 1px 0 rgba(15,23,42,.04); display:flex; flex-direction:column; gap:8px; }
    .card h3 { margin:0; font-size:16px; line-height:1.25; overflow-wrap:anywhere; }
    .meta { display:flex; gap:6px; flex-wrap:wrap; }
    .pill { border-radius:999px; padding:4px 8px; font-size:12px; font-weight:700; background:#eef2f7; color:#334155; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .priority-Urgente { border-left-color:#b91c1c; }
    .priority-Alta { border-left-color:#ea580c; }
    .priority-Media { border-left-color:#b45309; }
    .priority-Baja { border-left-color:#15803d; }
    .state-Pendiente { background:#fef3c7; color:#78350f; }
    .state-En-curso { background:#dbeafe; color:#1e3a8a; }
    .state-Pendiente-de-tercero { background:#ffedd5; color:#7c2d12; }
    .state-Bloqueada, .state-Bloqueado { background:#fee2e2; color:#7f1d1d; }
    .state-Terminada, .state-Finalizado, .state-Finalizada { background:#dcfce7; color:#14532d; }
    .line { font-size:13px; color:#334155; line-height:1.35; overflow-wrap:anywhere; }
    .line strong { color:#111827; }
    .nextStep { background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:8px; margin-top:auto; }
    .cardActions { display:flex; gap:8px; flex-wrap:wrap; }
    .cardActions button { flex:1 1 120px; padding:8px 10px; }
    .empty { padding:16px; color:var(--muted); border:1px dashed #cbd5e1; border-radius:8px; }
    button { border:0; border-radius:6px; background:var(--blue); color:white; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#64748b; }
    button.ghost { background:#e2e8f0; color:#1f2937; }
    button.green { background:#15803d; }
    button.red { background:#b91c1c; }
    .modalActions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .login { max-width:440px; margin:44px auto; box-shadow:var(--shadow); }
    .login h2 { font-size:24px; }
    .login input, .login select, .login button { width:100%; margin-bottom:8px; }
    .modalBackdrop { position:fixed; inset:0; background:rgba(15,23,42,.55); display:flex; align-items:center; justify-content:center; padding:16px; z-index:30; }
    .modal { background:white; border-radius:8px; border:1px solid var(--line); width:min(980px, 100%); max-height:92vh; overflow:auto; box-shadow:var(--shadow); }
    .modalHead { position:sticky; top:0; background:white; border-bottom:1px solid var(--line); padding:14px; display:flex; justify-content:space-between; gap:12px; align-items:flex-start; z-index:1; }
    .modalBody { padding:14px; display:grid; gap:12px; }
    .detailGrid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:8px; }
    .detailBox { background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:9px; font-size:13px; }
    .detailBox strong { display:block; margin-bottom:3px; }
    textarea { width:100%; min-height:110px; resize:vertical; border:1px solid #cbd5e1; border-radius:6px; padding:10px 11px; font:14px Segoe UI, Arial, sans-serif; }
    .quickRecord { background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:12px; margin:10px 0 12px; }
    .quickRecord h3 { margin:0 0 6px; font-size:16px; }
    .quickRecord textarea { min-height:170px; background:white; }
    .formGrid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:9px; }
    .history { display:grid; gap:8px; }
    .historyItem { border:1px solid #e2e8f0; border-left:5px solid #94a3b8; border-radius:8px; padding:10px; background:#fff; }
    .historyItem h4 { margin:0 0 6px; font-size:14px; }
    .historyItem p { margin:5px 0 0; white-space:pre-wrap; line-height:1.35; }
    .dangerText { color:#991b1b; font-weight:700; }
    .aiBox { display:grid; gap:12px; }
    .aiInput { min-height:220px; }
    .proposal { border:1px solid var(--line); border-radius:8px; padding:12px; background:#f8fafc; display:grid; gap:10px; }
    .proposalHead { display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:center; }
    .confidence { font-weight:800; color:#1d4ed8; }
    .answerView { display:grid; gap:12px; }
    .answerHero { background:white; border:1px solid #dbeafe; border-left:6px solid var(--blue); border-radius:8px; padding:14px; }
    .answerHero h3 { margin:0; font-size:21px; }
    .answerHero p { margin:5px 0 0; color:var(--muted); }
    .answerCards { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:9px; }
    .answerCard { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:11px; }
    .answerCard span { display:block; color:var(--muted); font-size:12px; font-weight:700; }
    .answerCard strong { display:block; margin-top:4px; font-size:20px; overflow-wrap:anywhere; }
    .answerTableWrap { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:10px; overflow:auto; }
    .answerTableWrap h3 { margin:0 0 8px; font-size:16px; }
    .answerTable { width:100%; border-collapse:collapse; font-size:13px; min-width:560px; }
    .answerTable th, .answerTable td { border-bottom:1px solid #e2e8f0; padding:8px; text-align:left; vertical-align:top; }
    .answerTable th { background:#f8fafc; color:#334155; font-size:12px; }
    .answerNote { background:#fff7ed; border:1px solid #fed7aa; border-radius:8px; padding:10px; color:#7c2d12; }
    .hidden { display:none !important; }
    @media (max-width: 1100px) {
      .counts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .workbench { grid-template-columns: 1fr; }
      .sidebar { position:static; }
      .tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 700px) {
      header { padding:14px; }
      .topbar { align-items:flex-start; flex-direction:column; }
      main { padding:10px; }
      section { padding:12px; }
      .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filters, .tabs { grid-template-columns:1fr; }
      .cards { grid-template-columns:1fr; }
      .contentHead { flex-direction:column; }
      .toolbar button { flex:1 1 auto; }
      .detailGrid, .formGrid { grid-template-columns:1fr; }
      .answerTable { min-width:0; }
      .answerTable thead { display:none; }
      .answerTable, .answerTable tbody, .answerTable tr, .answerTable td { display:block; width:100%; }
      .answerTable tr { border:1px solid #e2e8f0; border-radius:8px; margin-bottom:8px; background:white; }
      .answerTable td { border-bottom:1px solid #eef2f7; display:flex; justify-content:space-between; gap:12px; }
      .answerTable td::before { content:attr(data-label); color:#64748b; font-weight:700; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div class="brand">
        <h1>${appName}</h1>
        <p>Paso 8 - IA con propuesta editable y confirmacion</p>
      </div>
      <div class="session">
        <span id="sessionStatus">Comprobando acceso...</span>
        <button class="secondary hidden" id="logoutTop">Salir</button>
      </div>
    </div>
  </header>
  <main>
    <section id="loginView" class="login hidden">
      <h2>Acceso</h2>
      <p class="muted">Usa el mismo usuario y contrasena del Organizador.</p>
      <label>Usuario</label>
      <select id="loginUser"></select>
      <label>Contrasena</label>
      <input id="loginPassword" type="password" autocomplete="current-password" />
      <button id="loginButton">Entrar</button>
      <div id="loginMessage" class="muted"></div>
    </section>
    <div id="appView" class="hidden">
      <div class="grid counts" id="counts"></div>
      <div class="workbench">
        <section class="sidebar">
          <h2>Vista</h2>
          <div class="tabs">
            <button class="tab active" id="projectTab" data-view="projects"><span>Proyectos</span><span id="projectTabCount">0</span></button>
            <button class="tab" id="taskTab" data-view="tasks"><span>Tareas</span><span id="taskTabCount">0</span></button>
            <button class="tab" id="aiTab" data-view="ai"><span>IA</span><span id="aiTabStatus">OK</span></button>
          </div>
          <div class="filters">
            <div>
              <label>Busqueda</label>
              <input id="search" placeholder="Nombre, responsable, comentario..." />
            </div>
            <div>
              <label>Estado</label>
              <select id="stateFilter"><option value="">Todos los estados</option></select>
            </div>
            <div>
              <label>Comunidad</label>
              <select id="communityFilter"><option value="">Todas las comunidades</option></select>
            </div>
            <div>
              <label>Prioridad</label>
              <select id="priorityFilter"><option value="">Todas las prioridades</option></select>
            </div>
          </div>
          <div class="toolbar">
            <button id="reload">Actualizar</button>
            <button class="ghost" id="clearFilters">Limpiar</button>
          </div>
        </section>
        <section>
          <div class="contentHead">
            <div>
              <h2 id="contentTitle">Proyectos</h2>
              <p class="muted" id="contentSubtitle">Vista de lectura.</p>
            </div>
            <div>
              <div class="muted" id="visibleCount"></div>
              <div class="toolbar" id="viewActions">
                <button id="newProjectButton">Nuevo proyecto</button>
                <button class="green" id="newTaskButton">Nueva tarea</button>
              </div>
            </div>
          </div>
          <div class="cards" id="cards"></div>
        </section>
      </div>
    </div>
    <div id="entityModal" class="modalBackdrop hidden">
      <div class="modal">
        <div class="modalHead">
          <div>
            <h2 id="modalTitle">Ficha</h2>
            <p class="muted" id="modalSubtitle"></p>
          </div>
          <div class="modalActions">
            <button class="ghost" id="toggleEditEntity">Editar ficha</button>
            <button class="red" id="archiveEntityButton">Archivar</button>
            <button class="ghost" id="closeModal">Cerrar</button>
          </div>
        </div>
        <div class="modalBody">
          <section>
            <h2>Resumen</h2>
            <div class="detailGrid" id="detailGrid"></div>
          </section>
          <section id="editSection" class="hidden">
            <h2>Editar datos principales</h2>
            <div class="formGrid">
              <div><label>Titulo / nombre</label><input id="editTitle" /></div>
              <div><label>Categoria</label><input id="editCategory" /></div>
              <div><label>Estado</label><select id="editState"></select></div>
              <div><label>Prioridad</label><select id="editPriority"></select></div>
              <div><label>Responsable</label><input id="editOwner" list="responsiblesList" /></div>
              <div><label>Proximo responsable</label><input id="editNextOwner" list="responsiblesList" /></div>
              <div><label>Fecha proximo paso</label><input id="editNextDate" type="date" /></div>
              <div id="editProjectDateWrap"><label>Fecha prevista fin</label><input id="editProjectDate" type="date" /></div>
            </div>
            <label>Descripcion</label>
            <textarea id="editDescription"></textarea>
            <label>Proximo paso / observaciones</label>
            <textarea id="editNextStep"></textarea>
            <div class="toolbar">
              <button class="green" id="saveEntityEdit">Guardar cambios</button>
              <button class="ghost" id="cancelEntityEdit">Cancelar</button>
              <span class="muted" id="editMessage"></span>
            </div>
          </section>
          <section id="recordSection">
            <h2>Añadir seguimiento</h2>
            <div id="quickRecordBox" class="quickRecord hidden">
              <h3>Entrada inteligente de seguimiento</h3>
              <p class="muted">Pega una transcripcion, escribe una nota rapida o usa el dictado del teclado del movil. La app lo ordenara en comentario y proximo paso antes de guardar.</p>
              <textarea id="quickRecordText" placeholder="Ejemplo: He hablado con el proveedor. Queda pendiente revisar la arqueta, confirmar presupuesto y volver a informar..."></textarea>
              <div class="toolbar">
                <button id="quickRecordAnalyze">Analizar y rellenar</button>
                <button class="ghost" id="quickRecordDictate">Dictar</button>
                <button class="ghost" id="quickRecordClear">Limpiar</button>
                <span class="muted" id="quickRecordMessage"></span>
              </div>
            </div>
            <div class="formGrid">
              <div>
                <label>Tipo</label>
                <select id="recordType"></select>
              </div>
              <div>
                <label>Nuevo estado</label>
                <select id="recordState"></select>
              </div>
              <div>
                <label>Nueva prioridad</label>
                <select id="recordPriority"></select>
              </div>
              <div>
                <label>Responsable actual</label>
                <input id="recordOwner" list="responsiblesList" />
              </div>
              <div>
                <label>Proximo responsable</label>
                <input id="recordNextOwner" list="responsiblesList" />
              </div>
              <div>
                <label>Fecha proximo paso</label>
                <input id="recordNextDate" type="date" />
              </div>
            </div>
            <label>Comentario</label>
            <textarea id="recordComment" placeholder="Resumen claro de la actualizacion realizada..."></textarea>
            <label>Proximo paso</label>
            <textarea id="recordNextStep" placeholder="Que debe pasar ahora y quien debe hacerlo..."></textarea>
            <div id="blockReasonWrap" class="hidden">
              <label>Motivo del bloqueo</label>
              <textarea id="recordBlockReason" placeholder="Obligatorio cuando el estado sea Bloqueado/Bloqueada"></textarea>
            </div>
            <div class="toolbar">
              <button class="green" id="saveRecord">Guardar seguimiento</button>
              <span class="muted" id="recordMessage"></span>
            </div>
            <p class="muted">Al guardar se actualiza la ficha, se crea historial, auditoria y accion pendiente si el proximo responsable es otro usuario.</p>
          </section>
          <section>
            <h2>Historial</h2>
            <div class="history" id="historyList"></div>
          </section>
          <section>
            <h2>Anexos</h2>
            <div class="history" id="attachmentsList"></div>
          </section>
        </div>
      </div>
    </div>
    <div id="createModal" class="modalBackdrop hidden">
      <div class="modal">
        <div class="modalHead">
          <div>
            <h2 id="createTitle">Nuevo elemento</h2>
            <p class="muted" id="createSubtitle"></p>
          </div>
          <button class="ghost" id="closeCreateModal">Cerrar</button>
        </div>
        <div class="modalBody">
          <section>
            <div class="formGrid">
              <div><label>Tipo</label><select id="createType"><option value="project">Proyecto</option><option value="task">Tarea</option></select></div>
              <div><label>Comunidad</label><select id="createCommunity"></select></div>
              <div id="createProjectWrap"><label>Proyecto contenedor</label><select id="createProject"></select></div>
              <div><label>Titulo / nombre</label><input id="createName" /></div>
              <div><label>Categoria</label><input id="createCategory" value="General" /></div>
              <div><label>Estado</label><select id="createState"></select></div>
              <div><label>Prioridad</label><select id="createPriority"></select></div>
              <div><label>Responsable</label><input id="createOwner" list="responsiblesList" /></div>
              <div><label>Proximo responsable</label><input id="createNextOwner" list="responsiblesList" /></div>
              <div><label>Fecha proximo paso</label><input id="createNextDate" type="date" /></div>
            </div>
            <label>Descripcion / comentario inicial</label>
            <textarea id="createDescription"></textarea>
            <label>Proximo paso</label>
            <textarea id="createNextStep"></textarea>
            <div class="toolbar">
              <button class="green" id="saveCreateEntity">Crear</button>
              <span class="muted" id="createMessage"></span>
            </div>
          </section>
        </div>
      </div>
    </div>
    <datalist id="responsiblesList"></datalist>
  </main>
  <script>
    let state = { usuario: null, proyectos: [], tareas: [] };
    let options = { responsables: [], estados_tarea: [], estados_proyecto: [], prioridades: [], tipos_registro: [], comunidades: [], proyectos: [] };
    let currentView = "projects";
    let selectedEntity = null;
    let aiProposal = null;
    const $ = (id) => document.getElementById(id);
    const safe = (value) => String(value || "").trim();
    const html = (value) => safe(value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    const slug = (value) => safe(value).replaceAll(" ", "-").replaceAll("/", "-");

    function countCard(label, value) {
      return '<div class="count"><span class="muted">' + html(label) + '</span><strong>' + html(value) + '</strong></div>';
    }

    function rowTitle(row) {
      return currentView === "projects" ? row.nombre : row.titulo;
    }

    function rowState(row) {
      return currentView === "projects" ? row.estado_general : row.estado;
    }

    function rowOwner(row) {
      return currentView === "projects" ? row.responsable_principal : row.responsable;
    }

    function activeRows() {
      if (currentView === "ai") return [];
      return currentView === "projects" ? state.proyectos : state.tareas;
    }

    function fillSelect(select, rows, getter, allText) {
      const current = select.value;
      const values = [...new Set(rows.map(getter).map(safe).filter(Boolean))].sort();
      select.innerHTML = '<option value="">' + html(allText) + '</option>' + values.map(value => '<option>' + html(value) + '</option>').join('');
      select.value = values.includes(current) ? current : "";
    }

    function card(row) {
      const title = rowTitle(row);
      const stateText = rowState(row);
      const owner = rowOwner(row);
      const nextOwner = row.responsable_proximo_paso || "";
      const date = row.fecha_objetivo_proximo_paso || row.fecha_proxima_revision || "";
      const next = row.proximo_paso || "";
      const id = currentView === "projects" ? row.id_proyecto : row.id_tarea;
      const project = currentView === "tasks" && row.proyecto ? '<div class="line"><strong>Proyecto:</strong> ' + html(row.proyecto) + '</div>' : "";
      const updated = row.fecha_ultima_actualizacion ? '<div class="line"><strong>Ultima actualizacion:</strong> ' + html(row.fecha_ultima_actualizacion) + '</div>' : "";
      return '<article class="card priority-' + slug(row.prioridad) + '">' +
        '<h3>' + html(title) + '</h3>' +
        '<div class="meta">' +
          '<span class="pill state-' + slug(stateText) + '">' + html(stateText || "Sin estado") + '</span>' +
          '<span class="pill">' + html(row.prioridad || "Sin prioridad") + '</span>' +
          '<span class="pill">' + html(row.comunidad || "Sin comunidad") + '</span>' +
        '</div>' +
        project +
        '<div class="line"><strong>Responsable:</strong> ' + html(owner || "Sin responsable") + '</div>' +
        updated +
        '<div class="nextStep">' +
          '<div class="line"><strong>Proximo responsable:</strong> ' + html(nextOwner || "Sin asignar") + '</div>' +
          '<div class="line"><strong>Fecha:</strong> ' + html(date || "Sin fecha") + '</div>' +
          (next ? '<div class="line"><strong>Proximo paso:</strong> ' + html(next) + '</div>' : '') +
        '</div>' +
        '<div class="cardActions">' +
          '<button class="ghost" data-action="detail" data-type="' + (currentView === "projects" ? "project" : "task") + '" data-id="' + html(id) + '">Abrir ficha</button>' +
          '<button class="green" data-action="record" data-type="' + (currentView === "projects" ? "project" : "task") + '" data-id="' + html(id) + '">Seguimiento</button>' +
        '</div>' +
        '</article>';
    }

    async function api(path, options = {}) {
      const response = await fetch(path, {
        cache: "no-store",
        headers: options.body ? { "Content-Type": "application/json" } : {},
        credentials: "same-origin",
        ...options
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || "Error de servidor");
        error.status = response.status;
        throw error;
      }
      return data;
    }

    function showLogin(message = "") {
      $("loginView").classList.remove("hidden");
      $("appView").classList.add("hidden");
      $("logoutTop").classList.add("hidden");
      $("sessionStatus").textContent = "Sin sesion";
      $("loginMessage").textContent = message;
      loadUsers();
    }

    function showApp() {
      $("loginView").classList.add("hidden");
      $("appView").classList.remove("hidden");
      $("logoutTop").classList.remove("hidden");
    }

    function canWrite() {
      const role = (state.usuario || {}).rol;
      return ["Superusuario", "Administrador", "Usuario"].includes(role);
    }

    async function loadUsers() {
      const data = await api("/api/auth/users");
      $("loginUser").innerHTML = data.usuarios.map(user => '<option>' + html(user.nombre) + '</option>').join("");
    }

    async function login() {
      $("loginMessage").textContent = "Comprobando...";
      try {
        await api("/api/login", {
          method: "POST",
          body: JSON.stringify({ usuario: $("loginUser").value, password: $("loginPassword").value })
        });
        $("loginPassword").value = "";
        await loadOverview();
      } catch (error) {
        $("loginMessage").textContent = error.message;
      }
    }

    async function logout() {
      await api("/api/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      showLogin("Sesion cerrada.");
    }

    function fillOptions(select, values, current) {
      select.innerHTML = values.map(value => '<option value="' + html(value) + '">' + html(value) + '</option>').join("");
      if (current) select.value = current;
    }

    function setSelectValue(select, value) {
      const clean = safe(value);
      if (!clean) return;
      if (![...select.options].some(option => option.value === clean)) {
        select.insertAdjacentHTML("beforeend", '<option value="' + html(clean) + '">' + html(clean) + '</option>');
      }
      select.value = clean;
    }

    function detailValue(label, value) {
      return '<div class="detailBox"><strong>' + html(label) + '</strong>' + html(value || "Sin dato") + '</div>';
    }

    function entityId(item, type) {
      return type === "project" ? item.id_proyecto : item.id_tarea;
    }

    function itemTitle(item, type) {
      return type === "project" ? item.nombre : item.titulo;
    }

    function itemState(item, type) {
      return type === "project" ? item.estado_general : item.estado;
    }

    function itemOwner(item, type) {
      return type === "project" ? item.responsable_principal : item.responsable;
    }

    async function loadOptions() {
      options = await api("/api/options");
      $("responsiblesList").innerHTML = (options.responsables || []).map(value => '<option value="' + html(value) + '"></option>').join("");
    }

    function optionRows(rows, valueKey, labelKey, selected) {
      return (rows || []).map(row => {
        const value = row[valueKey];
        const label = row[labelKey];
        return '<option value="' + html(value) + '"' + (String(value) === String(selected || "") ? " selected" : "") + '>' + html(label) + '</option>';
      }).join("");
    }

    function projectOptions(selectedId) {
      return '<option value="">Seleccionar proyecto...</option>' + (options.proyectos || []).map(row =>
        '<option value="' + html(row.id) + '"' + (String(row.id) === String(selectedId || "") ? " selected" : "") + '>' + html(row.id + " - " + row.nombre) + '</option>'
      ).join("");
    }

    function renderHistory(history) {
      $("historyList").innerHTML = history.length ? history.map(row => {
        const stateChange = [row.estado_anterior, row.estado_nuevo].filter(Boolean).join(" -> ");
        const ownerChange = [row.responsable_anterior, row.responsable_nuevo].filter(Boolean).join(" -> ");
        return '<article class="historyItem">' +
          '<h4>' + html(row.fecha_hora || "") + ' - ' + html(row.tipo_registro || "Seguimiento") + '</h4>' +
          '<div class="meta">' +
            (stateChange ? '<span class="pill">' + html(stateChange) + '</span>' : '') +
            (ownerChange ? '<span class="pill">' + html(ownerChange) + '</span>' : '') +
            (row.usuario ? '<span class="pill">' + html(row.usuario) + '</span>' : '') +
          '</div>' +
          '<p>' + html(row.comentario || "") + '</p>' +
          (row.proximo_paso ? '<p><strong>Proximo paso:</strong> ' + html(row.proximo_paso) + '</p>' : '') +
        '</article>';
      }).join("") : '<div class="empty">No hay historial.</div>';
    }

    function renderAttachments(attachments) {
      $("attachmentsList").innerHTML = attachments.length ? attachments.map(row =>
        '<article class="historyItem"><h4>' + html(row.nombre_archivo) + '</h4><p class="muted">' + html(row.fecha_adjuntado || "") + '</p><p>' + html(row.ruta_archivo || "") + '</p></article>'
      ).join("") : '<div class="empty">No hay anexos.</div>';
    }

    async function openEntity(type, id, focusRecord = false) {
      $("recordMessage").textContent = "";
      await loadOptions();
      const detail = await api("/api/entity/detail?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id));
      selectedEntity = { type, id, item: detail.item };
      const item = detail.item;
      $("modalTitle").textContent = itemTitle(item, type);
      $("modalSubtitle").textContent = (type === "project" ? "Proyecto" : "Tarea") + " - " + safe(item.comunidad);
      $("detailGrid").innerHTML =
        detailValue("Comunidad", item.comunidad) +
        detailValue("Estado", itemState(item, type)) +
        detailValue("Prioridad", item.prioridad) +
        detailValue("Responsable", itemOwner(item, type)) +
        detailValue("Proximo responsable", item.responsable_proximo_paso) +
        detailValue("Fecha proximo paso", item.fecha_objetivo_proximo_paso || item.fecha_proxima_revision) +
        detailValue("Categoria", item.categoria) +
        detailValue("Ultima actualizacion", item.fecha_ultima_actualizacion) +
        detailValue(type === "task" ? "Proyecto" : "Inicio", type === "task" ? item.proyecto : item.fecha_inicio);
      const states = type === "project" ? options.estados_proyecto : options.estados_tarea;
      const writable = canWrite();
      $("toggleEditEntity").classList.toggle("hidden", !writable);
      $("archiveEntityButton").classList.toggle("hidden", !writable);
      $("editSection").classList.add("hidden");
      $("editMessage").textContent = "";
      $("editTitle").value = itemTitle(item, type) || "";
      $("editCategory").value = item.categoria || "";
      fillOptions($("editState"), states || [], itemState(item, type));
      fillOptions($("editPriority"), options.prioridades || [], item.prioridad);
      $("editOwner").value = itemOwner(item, type) || "";
      $("editNextOwner").value = item.responsable_proximo_paso || itemOwner(item, type) || "";
      $("editNextDate").value = (item.fecha_objetivo_proximo_paso || item.fecha_proxima_revision || "").slice(0, 10);
      $("editProjectDateWrap").classList.toggle("hidden", type !== "project");
      $("editProjectDate").value = (item.fecha_prevista_finalizacion || "").slice(0, 10);
      $("editDescription").value = item.descripcion || "";
      $("editNextStep").value = type === "project" ? (item.observaciones || "") : (item.proximo_paso || "");
      fillOptions($("recordType"), options.tipos_registro || ["Seguimiento"], "Seguimiento");
      fillOptions($("recordState"), states || [], itemState(item, type));
      fillOptions($("recordPriority"), options.prioridades || [], item.prioridad);
      $("recordOwner").value = itemOwner(item, type) || "";
      $("recordNextOwner").value = item.responsable_proximo_paso || itemOwner(item, type) || "";
      $("recordNextDate").value = (item.fecha_objetivo_proximo_paso || item.fecha_proxima_revision || "").slice(0, 10);
      $("recordComment").value = "";
      $("recordNextStep").value = item.proximo_paso || "";
      $("recordBlockReason").value = "";
      $("quickRecordText").value = "";
      $("quickRecordMessage").textContent = "";
      $("quickRecordBox").classList.toggle("hidden", !focusRecord);
      updateBlockReasonVisibility();
      $("recordSection").classList.toggle("hidden", (state.usuario || {}).rol === "Presidente");
      renderHistory(detail.history || []);
      renderAttachments(detail.attachments || []);
      $("entityModal").classList.remove("hidden");
      if (focusRecord) setTimeout(() => $("quickRecordText").focus(), 50);
    }

    function fillRecordFromProposal(proposal) {
      const payload = proposal.payload || {};
      setSelectValue($("recordType"), payload.tipo_registro || "Seguimiento");
      setSelectValue($("recordState"), payload.estado_nuevo);
      setSelectValue($("recordPriority"), payload.prioridad_nueva);
      $("recordOwner").value = payload.responsable_nuevo || $("recordOwner").value;
      $("recordNextOwner").value = payload.responsable_proximo_paso || $("recordNextOwner").value;
      $("recordNextDate").value = (payload.fecha_objetivo_proximo_paso || payload.fecha_proxima_revision || $("recordNextDate").value || "").slice(0, 10);
      $("recordComment").value = payload.comentario || $("recordComment").value;
      $("recordNextStep").value = payload.proximo_paso || $("recordNextStep").value;
      $("recordBlockReason").value = payload.motivo_bloqueo || "";
      updateBlockReasonVisibility();
    }

    async function analyzeQuickRecord() {
      if (!selectedEntity) return;
      const text = $("quickRecordText").value;
      if (!safe(text)) {
        $("quickRecordMessage").textContent = "Pega o dicta primero el seguimiento.";
        return;
      }
      $("quickRecordMessage").textContent = "Analizando...";
      try {
        const proposal = await api("/api/ai/analyze", {
          method: "POST",
          body: JSON.stringify({ text, target: { type: selectedEntity.type, id: selectedEntity.id, title: itemTitle(selectedEntity.item, selectedEntity.type) } })
        });
        fillRecordFromProposal(proposal);
        $("quickRecordMessage").textContent = "Campos rellenados. Revisa y guarda el seguimiento.";
      } catch (error) {
        $("quickRecordMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    function startQuickDictation() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        $("quickRecordMessage").textContent = "Si el navegador no permite dictado directo, usa el microfono del teclado del movil en esta caja.";
        $("quickRecordText").focus();
        return;
      }
      const recognition = new SpeechRecognition();
      recognition.lang = "es-ES";
      recognition.interimResults = false;
      recognition.continuous = false;
      $("quickRecordMessage").textContent = "Escuchando...";
      recognition.onresult = event => {
        const transcript = Array.from(event.results).map(result => result[0].transcript).join(" ");
        $("quickRecordText").value = [safe($("quickRecordText").value), transcript].filter(Boolean).join("\\n");
        $("quickRecordMessage").textContent = "Dictado añadido. Puedes analizar cuando quieras.";
      };
      recognition.onerror = () => {
        $("quickRecordMessage").textContent = "No se pudo usar el dictado del navegador. Usa el microfono del teclado del movil.";
      };
      recognition.onend = () => {
        if ($("quickRecordMessage").textContent === "Escuchando...") $("quickRecordMessage").textContent = "Dictado finalizado.";
      };
      recognition.start();
    }

    function toggleEditSection(show) {
      $("editSection").classList.toggle("hidden", show === undefined ? !$("editSection").classList.contains("hidden") : !show);
      if (!$("editSection").classList.contains("hidden")) setTimeout(() => $("editTitle").focus(), 30);
    }

    async function saveEntityEdit() {
      if (!selectedEntity) return;
      const payload = {
        titulo: $("editTitle").value,
        nombre: $("editTitle").value,
        descripcion: $("editDescription").value,
        categoria: $("editCategory").value,
        estado: $("editState").value,
        prioridad: $("editPriority").value,
        responsable: $("editOwner").value,
        responsable_proximo_paso: $("editNextOwner").value,
        fecha_objetivo_proximo_paso: $("editNextDate").value,
        fecha_proxima_revision: $("editNextDate").value,
        fecha_prevista_finalizacion: $("editProjectDate").value,
        proximo_paso: $("editNextStep").value,
        observaciones: $("editNextStep").value
      };
      if (!safe(payload.titulo)) {
        $("editMessage").innerHTML = '<span class="dangerText">El titulo es obligatorio.</span>';
        return;
      }
      $("editMessage").textContent = "Guardando...";
      try {
        await api("/api/entity/update", {
          method: "POST",
          body: JSON.stringify({ type: selectedEntity.type, id: selectedEntity.id, payload })
        });
        $("editMessage").textContent = "Cambios guardados.";
        await loadOverview();
        await openEntity(selectedEntity.type, selectedEntity.id, false);
      } catch (error) {
        $("editMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    async function archiveSelectedEntity() {
      if (!selectedEntity) return;
      const label = selectedEntity.type === "project" ? "proyecto" : "tarea";
      if (!confirm("Se archivara esta " + label + " y dejara de aparecer en los paneles activos.\\n\\n¿Continuar?")) return;
      try {
        await api("/api/entity/archive", {
          method: "POST",
          body: JSON.stringify({ type: selectedEntity.type, id: selectedEntity.id })
        });
        closeModal();
        await loadOverview();
      } catch (error) {
        alert(error.message);
      }
    }

    async function openCreateModal(type) {
      await loadOptions();
      $("createType").value = type;
      $("createName").value = "";
      $("createCategory").value = "General";
      $("createOwner").value = (state.usuario || {}).nombre || "";
      $("createNextOwner").value = (state.usuario || {}).nombre || "";
      $("createNextDate").value = "";
      $("createDescription").value = "";
      $("createNextStep").value = "";
      $("createMessage").textContent = "";
      $("createCommunity").innerHTML = '<option value="">Automatico / Macrocomunidad</option>' + optionRows(options.comunidades || [], "id", "nombre", "");
      $("createProject").innerHTML = projectOptions("");
      updateCreateForm();
      $("createModal").classList.remove("hidden");
      setTimeout(() => $("createName").focus(), 30);
    }

    function updateCreateForm() {
      const type = $("createType").value;
      $("createTitle").textContent = type === "project" ? "Nuevo proyecto" : "Nueva tarea";
      $("createSubtitle").textContent = type === "project" ? "Crea un proyecto operativo." : "Crea una tarea vinculada a un proyecto.";
      $("createProjectWrap").classList.toggle("hidden", type !== "task");
      fillOptions($("createState"), type === "project" ? options.estados_proyecto : options.estados_tarea, type === "project" ? "En curso" : "Pendiente");
      fillOptions($("createPriority"), options.prioridades || [], "Media");
    }

    function closeCreateModal() {
      $("createModal").classList.add("hidden");
    }

    async function saveCreateEntity() {
      const type = $("createType").value;
      const payload = {
        titulo: $("createName").value,
        nombre: $("createName").value,
        id_comunidad: $("createCommunity").value,
        id_proyecto: $("createProject").value,
        descripcion: $("createDescription").value,
        comentario: $("createDescription").value,
        categoria: $("createCategory").value,
        estado: $("createState").value,
        estado_nuevo: $("createState").value,
        prioridad: $("createPriority").value,
        prioridad_nueva: $("createPriority").value,
        responsable: $("createOwner").value,
        responsable_nuevo: $("createOwner").value,
        responsable_proximo_paso: $("createNextOwner").value,
        fecha_objetivo_proximo_paso: $("createNextDate").value,
        fecha_proxima_revision: $("createNextDate").value,
        proximo_paso: $("createNextStep").value
      };
      if (!safe(payload.titulo)) {
        $("createMessage").innerHTML = '<span class="dangerText">El titulo es obligatorio.</span>';
        return;
      }
      if (type === "task" && !safe(payload.id_proyecto)) {
        $("createMessage").innerHTML = '<span class="dangerText">Selecciona el proyecto contenedor.</span>';
        return;
      }
      $("createMessage").textContent = "Creando...";
      try {
        const result = await api("/api/entity/create", { method: "POST", body: JSON.stringify({ type, payload }) });
        closeCreateModal();
        await loadOverview();
        if (result?.type && result?.id) await openEntity(result.type, result.id, false);
      } catch (error) {
        $("createMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    function closeModal() {
      $("entityModal").classList.add("hidden");
      selectedEntity = null;
    }

    function updateBlockReasonVisibility() {
      const value = $("recordState").value;
      $("blockReasonWrap").classList.toggle("hidden", value !== "Bloqueada" && value !== "Bloqueado");
    }

    async function saveRecord() {
      if (!selectedEntity) return;
      const payload = {
        tipo_registro: $("recordType").value,
        estado_nuevo: $("recordState").value,
        prioridad_nueva: $("recordPriority").value,
        responsable_nuevo: $("recordOwner").value,
        responsable_proximo_paso: $("recordNextOwner").value,
        fecha_objetivo_proximo_paso: $("recordNextDate").value,
        fecha_proxima_revision: $("recordNextDate").value,
        comentario: $("recordComment").value,
        proximo_paso: $("recordNextStep").value,
        motivo_bloqueo: $("recordBlockReason").value
      };
      if (!safe(payload.comentario)) {
        $("recordMessage").innerHTML = '<span class="dangerText">El comentario es obligatorio.</span>';
        return;
      }
      const summary = "Se guardara un seguimiento y se actualizara la ficha.\\n\\nEstado: " + payload.estado_nuevo + "\\nResponsable: " + payload.responsable_nuevo + "\\nProximo responsable: " + payload.responsable_proximo_paso;
      if (!confirm(summary)) return;
      $("recordMessage").textContent = "Guardando...";
      try {
        await api("/api/entity/record", {
          method: "POST",
          body: JSON.stringify({ type: selectedEntity.type, id: selectedEntity.id, payload })
        });
        $("recordMessage").textContent = "Seguimiento guardado.";
        await loadOverview();
        await openEntity(selectedEntity.type, selectedEntity.id, false);
      } catch (error) {
        $("recordMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    function matchesSearch(row, text) {
      const haystack = [
        rowTitle(row), row.categoria, rowState(row), rowOwner(row), row.responsable_proximo_paso,
        row.proximo_paso, row.proyecto, row.comunidad, row.prioridad
      ].join(" ").toLowerCase();
      return !text || haystack.includes(text);
    }

    function refreshFilterOptions() {
      const rows = activeRows();
      fillSelect($("stateFilter"), rows, rowState, "Todos los estados");
      fillSelect($("communityFilter"), rows, row => row.comunidad, "Todas las comunidades");
      fillSelect($("priorityFilter"), rows, row => row.prioridad, "Todas las prioridades");
    }

    function render() {
      if (currentView === "ai") {
        $("contentTitle").textContent = "IA operativa";
        $("contentSubtitle").textContent = "Pega una llamada, reunion o consulta. La IA propone y tu confirmas antes de guardar.";
        $("visibleCount").textContent = "";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = aiPanelHtml();
        $("projectTab").classList.remove("active");
        $("taskTab").classList.remove("active");
        $("aiTab").classList.add("active");
        bindAiPanel();
        return;
      }
      const search = safe($("search").value).toLowerCase();
      const selectedState = $("stateFilter").value;
      const selectedCommunity = $("communityFilter").value;
      const selectedPriority = $("priorityFilter").value;
      const rows = activeRows().filter(row =>
        (!selectedState || rowState(row) === selectedState) &&
        (!selectedCommunity || row.comunidad === selectedCommunity) &&
        (!selectedPriority || row.prioridad === selectedPriority) &&
        matchesSearch(row, search)
      );
      const title = currentView === "projects" ? "Proyectos" : "Tareas";
      $("contentTitle").textContent = title;
      $("contentSubtitle").textContent = currentView === "projects"
        ? "Proyectos visibles segun tus comunidades y permisos."
        : "Tareas visibles segun tus comunidades y permisos.";
      $("visibleCount").textContent = rows.length + " de " + activeRows().length + " visibles";
      $("viewActions").classList.toggle("hidden", !canWrite());
      $("cards").innerHTML = rows.length ? rows.map(card).join("") : '<div class="empty">No hay elementos con esos filtros.</div>';
      $("projectTab").classList.toggle("active", currentView === "projects");
      $("taskTab").classList.toggle("active", currentView === "tasks");
      $("aiTab").classList.remove("active");
    }

    function aiPanelHtml() {
      return '<section class="aiBox">' +
        '<h2>Entrada inteligente</h2>' +
        '<textarea id="aiText" class="aiInput" placeholder="Pega aqui una transcripcion, resumen de llamada, correo o pregunta..."></textarea>' +
        '<div class="toolbar">' +
          '<button id="aiAnalyze">Analizar</button>' +
          '<button class="ghost" id="aiClear">Limpiar</button>' +
          '<span class="muted" id="aiMessage"></span>' +
        '</div>' +
        '<div id="aiResult"></div>' +
      '</section>';
    }

    function bindAiPanel() {
      $("aiAnalyze").addEventListener("click", analyzeAiText);
      $("aiClear").addEventListener("click", () => {
        $("aiText").value = "";
        $("aiResult").innerHTML = "";
        $("aiMessage").textContent = "";
        aiProposal = null;
      });
    }

    function entityOptionsHtml(kind, selectedId) {
      const rows = kind === "project" ? state.proyectos : state.tareas;
      return '<option value="">Seleccionar...</option>' + rows.map(row => {
        const id = kind === "project" ? row.id_proyecto : row.id_tarea;
        const title = kind === "project" ? row.nombre : row.titulo;
        return '<option value="' + html(id) + '"' + (String(id) === String(selectedId || "") ? " selected" : "") + '>' + html(id + " - " + title) + '</option>';
      }).join("");
    }

    function projectContainerOptions(selectedId) {
      return '<option value="">Selecciona proyecto contenedor...</option>' + state.proyectos.map(row =>
        '<option value="' + html(row.id_proyecto) + '"' + (String(row.id_proyecto) === String(selectedId || "") ? " selected" : "") + '>' + html(row.id_proyecto + " - " + row.nombre) + '</option>'
      ).join("");
    }

    function proposalActionOptions(action) {
      const actions = [
        ["fuera_de_alcance", "Fuera de alcance / descartar"],
        ["consulta", "Consulta"],
        ["seguimiento_proyecto", "Seguimiento de proyecto"],
        ["seguimiento_tarea", "Seguimiento de tarea"],
        ["crear_proyecto", "Crear proyecto"],
        ["crear_tarea", "Crear tarea"],
        ["revisar_manual", "Revisar manualmente"]
      ];
      return actions.map(([value, label]) => '<option value="' + value + '"' + (value === action ? " selected" : "") + '>' + label + '</option>').join("");
    }

    function renderDisplay(display) {
      if (!display || !Object.keys(display).length) return "";
      const cards = (display.cards || []).length
        ? '<div class="answerCards">' + display.cards.map(card =>
            '<div class="answerCard"><span>' + html(card.label || "") + '</span><strong>' + html(card.value || "") + '</strong>' +
            (card.muted ? '<small class="muted">' + html(card.muted) + '</small>' : '') + '</div>'
          ).join("") + '</div>'
        : "";
      const tables = (display.tables || []).map(table => {
        const columns = table.columns || [];
        const rows = table.rows || [];
        return '<div class="answerTableWrap">' +
          '<h3>' + html(table.title || "Detalle") + '</h3>' +
          '<table class="answerTable"><thead><tr>' + columns.map(col => '<th>' + html(col) + '</th>').join("") + '</tr></thead>' +
          '<tbody>' + rows.map(row => '<tr>' + columns.map(col => '<td data-label="' + html(col) + '">' + html(row[col] || "") + '</td>').join("") + '</tr>').join("") + '</tbody></table>' +
        '</div>';
      }).join("");
      return '<div class="answerView">' +
        ((display.title || display.subtitle) ? '<div class="answerHero"><h3>' + html(display.title || "Respuesta") + '</h3>' + (display.subtitle ? '<p>' + html(display.subtitle) + '</p>' : '') + '</div>' : '') +
        cards +
        tables +
        (display.note ? '<div class="answerNote">' + html(display.note) + '</div>' : '') +
      '</div>';
    }

    function renderAiProposal(proposal) {
      const payload = proposal.payload || {};
      const entityType = proposal.entity?.type || (proposal.action === "seguimiento_tarea" ? "task" : "project");
      const entityId = proposal.entity?.id || "";
      const states = entityType === "task" ? options.estados_tarea : options.estados_proyecto;
      const candidateLabel = (type) => ({ task: "Tarea", project: "Proyecto", owner: "Propietario", property: "Propiedad" }[type] || "Elemento");
      const candidatesHtml = (proposal.candidates || []).length
        ? '<div class="detailBox"><strong>Candidatos detectados</strong>' + proposal.candidates.map(c => '<div>' + html(candidateLabel(c.type) + " " + c.id + " - " + c.title + (c.score !== undefined ? " | score " + c.score : "")) + '</div>').join("") + '</div>'
        : "";
      const questionsHtml = (proposal.questions || []).length
        ? '<div class="detailBox"><strong>Necesito aclarar</strong>' + proposal.questions.map(q => '<div>- ' + html(q) + '</div>').join("") + '</div>'
        : "";
      if (proposal.action === "consulta" && !payload.comentario && !payload.titulo) {
        const displayHtml = renderDisplay(proposal.display || {});
        $("aiResult").innerHTML = '<div class="proposal">' +
          '<div class="proposalHead"><h2>Respuesta de consulta</h2><span class="confidence">Confianza: ' + html(Math.round((proposal.confidence || 0) * 100)) + '%</span></div>' +
          (proposal.warning ? '<p class="dangerText">' + html(proposal.warning) + '</p>' : '') +
          displayHtml +
          (proposal.answer ? '<details class="detailBox"><summary><strong>Ver respuesta en texto</strong></summary><pre style="white-space:pre-wrap;margin:8px 0 0">' + html(proposal.answer) + '</pre></details>' : '') +
          questionsHtml +
          candidatesHtml +
          (proposal.answer ? '<div class="toolbar"><button class="ghost" id="copyAiAnswer">Copiar respuesta</button><span class="muted" id="copyAiMessage"></span></div>' : '') +
        '</div>';
        if ($("copyAiAnswer")) {
          $("copyAiAnswer").addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(proposal.answer || "");
              $("copyAiMessage").textContent = "Copiado.";
            } catch {
              $("copyAiMessage").textContent = "No se pudo copiar automaticamente.";
            }
          });
        }
        return;
      }
      $("aiResult").innerHTML = '<div class="proposal">' +
        '<div class="proposalHead"><h2>Propuesta revisable</h2><span class="confidence">Confianza: ' + html(Math.round((proposal.confidence || 0) * 100)) + '%</span></div>' +
        (proposal.warning ? '<p class="dangerText">' + html(proposal.warning) + '</p>' : '') +
        (proposal.answer ? '<div class="detailBox"><strong>Respuesta / lectura</strong><pre style="white-space:pre-wrap;margin:0">' + html(proposal.answer) + '</pre></div>' : '') +
        questionsHtml +
        candidatesHtml +
        '<div class="formGrid">' +
          '<div><label>Accion</label><select id="aiAction">' + proposalActionOptions(proposal.action || "revisar_manual") + '</select></div>' +
          '<div><label>Elemento existente</label><select id="aiEntity">' + entityOptionsHtml(entityType, entityId) + '</select></div>' +
          '<div><label>Proyecto contenedor para tarea nueva</label><select id="aiProjectContainer">' + projectContainerOptions(payload.id_proyecto) + '</select></div>' +
          '<div><label>Titulo nuevo</label><input id="aiTitle" value="' + html(payload.titulo || proposal.entity?.title || "") + '" /></div>' +
          '<div><label>Categoria</label><input id="aiCategory" value="' + html(payload.categoria || "General") + '" /></div>' +
          '<div><label>Estado</label><select id="aiState">' + (states || []).map(v => '<option value="' + html(v) + '"' + (v === payload.estado_nuevo ? " selected" : "") + '>' + html(v) + '</option>').join("") + '</select></div>' +
          '<div><label>Prioridad</label><select id="aiPriority">' + (options.prioridades || []).map(v => '<option value="' + html(v) + '"' + (v === payload.prioridad_nueva ? " selected" : "") + '>' + html(v) + '</option>').join("") + '</select></div>' +
          '<div><label>Responsable</label><input id="aiOwner" list="responsiblesList" value="' + html(payload.responsable_nuevo || "") + '" /></div>' +
          '<div><label>Proximo responsable</label><input id="aiNextOwner" list="responsiblesList" value="' + html(payload.responsable_proximo_paso || "") + '" /></div>' +
          '<div><label>Fecha proximo paso</label><input id="aiNextDate" type="date" value="' + html((payload.fecha_objetivo_proximo_paso || "").slice(0, 10)) + '" /></div>' +
        '</div>' +
        '<label>Comentario</label><textarea id="aiComment">' + html(payload.comentario || "") + '</textarea>' +
        '<label>Proximo paso</label><textarea id="aiNextStep">' + html(payload.proximo_paso || "") + '</textarea>' +
        '<label>Motivo bloqueo</label><textarea id="aiBlockReason">' + html(payload.motivo_bloqueo || "") + '</textarea>' +
        '<div class="toolbar"><button class="green" id="aiApply">Aplicar propuesta</button><span class="muted" id="aiApplyMessage"></span></div>' +
      '</div>';
      $("aiApply").addEventListener("click", applyAiProposal);
      $("aiAction").addEventListener("change", () => {
        const action = $("aiAction").value;
        const kind = action.includes("tarea") ? "task" : "project";
        $("aiEntity").innerHTML = entityOptionsHtml(kind, "");
      });
    }

    async function analyzeAiText() {
      const text = $("aiText").value;
      if (!safe(text)) {
        $("aiMessage").textContent = "Pega primero un texto.";
        return;
      }
      $("aiMessage").textContent = "Analizando...";
      $("aiResult").innerHTML = "";
      try {
        if (!options.responsables.length) await loadOptions();
        aiProposal = await api("/api/ai/analyze", { method: "POST", body: JSON.stringify({ text }) });
        $("aiMessage").textContent = "Propuesta generada. Revisala antes de aplicar.";
        renderAiProposal(aiProposal);
      } catch (error) {
        $("aiMessage").textContent = error.message;
      }
    }

    async function applyAiProposal() {
      const action = $("aiAction").value;
      const payload = {
        titulo: $("aiTitle").value,
        categoria: $("aiCategory").value,
        tipo_registro: "Seguimiento",
        estado_nuevo: $("aiState").value,
        prioridad_nueva: $("aiPriority").value,
        responsable_nuevo: $("aiOwner").value,
        responsable_proximo_paso: $("aiNextOwner").value,
        fecha_objetivo_proximo_paso: $("aiNextDate").value,
        fecha_proxima_revision: $("aiNextDate").value,
        comentario: $("aiComment").value,
        proximo_paso: $("aiNextStep").value,
        motivo_bloqueo: $("aiBlockReason").value,
        id_proyecto: $("aiProjectContainer").value
      };
      if (action === "consulta" || action === "revisar_manual" || action === "fuera_de_alcance") {
        $("aiApplyMessage").textContent = "Esta propuesta no guarda cambios. Cambia la accion si quieres aplicar algo.";
        return;
      }
      if (!confirm("Se aplicara la propuesta editada. ¿Confirmas guardar el cambio?")) return;
      $("aiApplyMessage").textContent = "Aplicando...";
      try {
        let result;
        if (action === "seguimiento_proyecto" || action === "seguimiento_tarea") {
          const type = action === "seguimiento_tarea" ? "task" : "project";
          const id = $("aiEntity").value;
          if (!id) throw new Error("Selecciona el elemento existente.");
          result = await api("/api/entity/record", { method: "POST", body: JSON.stringify({ type, id, payload }) });
        } else {
          const type = action === "crear_tarea" ? "task" : "project";
          result = await api("/api/entity/create", { method: "POST", body: JSON.stringify({ type, payload }) });
        }
        $("aiApplyMessage").textContent = "Guardado correctamente.";
        await loadOverview();
        if (result?.type && result?.id) await openEntity(result.type, result.id, false);
      } catch (error) {
        $("aiApplyMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    async function loadOverview() {
      $("sessionStatus").textContent = "Cargando datos...";
      try {
        const data = await api("/api/overview");
        state = data;
        showApp();
        const user = data.usuario || {};
        $("sessionStatus").innerHTML = html(user.nombre || "") + " - " + html(user.rol || "") + " - acciones con confirmacion";
        if (user.rol === "Presidente") currentView = "projects";
        $("taskTab").classList.toggle("hidden", user.rol === "Presidente");
        $("counts").innerHTML =
          countCard("Usuarios", data.counts.usuarios) +
          countCard("Comunidades", data.counts.comunidades) +
          countCard("Proyectos activos", data.counts.proyectos_activos) +
          countCard("Tareas activas", data.counts.tareas_activas) +
          countCard("Asambleas", data.counts.asambleas) +
          countCard("Propiedades", data.counts.propiedades_contabilidad);
        $("projectTabCount").textContent = data.proyectos.length;
        $("taskTabCount").textContent = data.tareas.length;
        refreshFilterOptions();
        render();
      } catch (error) {
        if (error.status === 401) {
          showLogin("Introduce tus credenciales.");
        } else {
          showLogin(error.message);
        }
      }
    }

    function switchView(view) {
      currentView = view;
      $("search").value = "";
      $("stateFilter").value = "";
      $("communityFilter").value = "";
      $("priorityFilter").value = "";
      refreshFilterOptions();
      render();
    }

    $("projectTab").addEventListener("click", () => switchView("projects"));
    $("taskTab").addEventListener("click", () => switchView("tasks"));
    $("aiTab").addEventListener("click", () => switchView("ai"));
    $("search").addEventListener("input", render);
    $("stateFilter").addEventListener("change", render);
    $("communityFilter").addEventListener("change", render);
    $("priorityFilter").addEventListener("change", render);
    $("clearFilters").addEventListener("click", () => {
      $("search").value = "";
      $("stateFilter").value = "";
      $("communityFilter").value = "";
      $("priorityFilter").value = "";
      render();
    });
    $("cards").addEventListener("click", event => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      openEntity(button.dataset.type, button.dataset.id, button.dataset.action === "record").catch(error => alert(error.message));
    });
    $("closeModal").addEventListener("click", closeModal);
    $("entityModal").addEventListener("click", event => { if (event.target.id === "entityModal") closeModal(); });
    $("toggleEditEntity").addEventListener("click", () => toggleEditSection());
    $("cancelEntityEdit").addEventListener("click", () => toggleEditSection(false));
    $("saveEntityEdit").addEventListener("click", saveEntityEdit);
    $("archiveEntityButton").addEventListener("click", archiveSelectedEntity);
    $("newProjectButton").addEventListener("click", () => openCreateModal("project").catch(error => alert(error.message)));
    $("newTaskButton").addEventListener("click", () => openCreateModal("task").catch(error => alert(error.message)));
    $("closeCreateModal").addEventListener("click", closeCreateModal);
    $("createModal").addEventListener("click", event => { if (event.target.id === "createModal") closeCreateModal(); });
    $("createType").addEventListener("change", updateCreateForm);
    $("saveCreateEntity").addEventListener("click", saveCreateEntity);
    $("recordState").addEventListener("change", updateBlockReasonVisibility);
    $("saveRecord").addEventListener("click", saveRecord);
    $("quickRecordAnalyze").addEventListener("click", analyzeQuickRecord);
    $("quickRecordDictate").addEventListener("click", startQuickDictation);
    $("quickRecordClear").addEventListener("click", () => {
      $("quickRecordText").value = "";
      $("quickRecordMessage").textContent = "";
      $("quickRecordText").focus();
    });
    $("reload").addEventListener("click", loadOverview);
    $("loginButton").addEventListener("click", login);
    $("loginPassword").addEventListener("keydown", event => { if (event.key === "Enter") login(); });
    $("logoutTop").addEventListener("click", logout);
    loadOverview();
  </script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    return sendHtml(res, 200, homePage());
  }
  if (req.method === "GET" && url.pathname === "/api/auth/users") {
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryAuthUsers());
  }
  if (req.method === "GET" && url.pathname === "/api/me") {
    const session = readSession(req);
    return sendJson(res, session ? 200 : 401, session ? { authenticated: true, usuario: session } : { authenticated: false });
  }
  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(req);
    const usuario = String(body.usuario || "").trim();
    const password = String(body.password || "");
    const auth = await queryUserForLogin(usuario);
    const user = auth.user;
    if (!user || !user.activo || user.bloqueado) {
      return sendJson(res, 401, { ok: false, error: "Usuario no disponible." });
    }
    if (!user.password_configurada || user.requiere_cambio_password) {
      return sendJson(res, 401, { ok: false, error: "Este usuario debe configurar o cambiar la contrasena desde la app principal." });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { ok: false, error: "Contrasena incorrecta." });
    }
    const publicUser = {
      id_usuario: user.id_usuario,
      nombre: user.nombre,
      rol: user.rol,
      comunidades: auth.comunidades || []
    };
    setSessionCookie(res, publicUser);
    return sendJson(res, 200, { ok: true, usuario: publicUser });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/overview") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryOverview(session));
  }
  if (req.method === "GET" && url.pathname === "/api/options") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryActionOptions(session));
  }
  if (req.method === "GET" && url.pathname === "/api/entity/detail") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const type = String(url.searchParams.get("type") || "").trim();
    const id = Number(url.searchParams.get("id") || 0);
    if (!["task", "project"].includes(type) || !id) return sendJson(res, 400, { ok: false, error: "Entidad no valida." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryEntityDetail(session, type, id));
  }
  if (req.method === "POST" && url.pathname === "/api/entity/record") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const type = String(body.type || "").trim();
    const id = Number(body.id || 0);
    if (!["task", "project"].includes(type) || !id) return sendJson(res, 400, { ok: false, error: "Entidad no valida." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await writeEntityRecord(session, type, id, body.payload || {}, String(pc)));
  }
  if (req.method === "POST" && url.pathname === "/api/entity/create") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const type = String(body.type || "").trim();
    if (!["task", "project"].includes(type)) return sendJson(res, 400, { ok: false, error: "Tipo no valido." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await createEntity(session, type, body.payload || {}, String(pc)));
  }
  if (req.method === "POST" && url.pathname === "/api/entity/update") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const type = String(body.type || "").trim();
    const id = Number(body.id || 0);
    if (!["task", "project"].includes(type) || !id) return sendJson(res, 400, { ok: false, error: "Entidad no valida." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await updateEntity(session, type, id, body.payload || {}, String(pc), false));
  }
  if (req.method === "POST" && url.pathname === "/api/entity/archive") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const type = String(body.type || "").trim();
    const id = Number(body.id || 0);
    if (!["task", "project"].includes(type) || !id) return sendJson(res, 400, { ok: false, error: "Entidad no valida." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await updateEntity(session, type, id, {}, String(pc), true));
  }
  if (req.method === "POST" && url.pathname === "/api/ai/analyze") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await analyzeWithAi(session, body.text || "", body.target || null));
  }
  if (req.method === "GET" && url.pathname === "/health") {
    const databaseExists = fs.existsSync(databasePath);
    return sendJson(res, 200, {
      ok: true,
      app: appName,
      step: databaseExists ? 8 : 1,
      port,
      dataDir,
      databasePath,
      databaseConfigured: databaseExists,
      databaseSize: databaseExists ? fs.statSync(databasePath).size : 0,
      migratedRealData: databaseExists,
      authRequired: true,
      readonly: false,
      actionsEnabled: true,
      aiEnabled: true,
      aiProvider: aiApiKey && aiProvider !== "local" ? aiProvider : "local",
      aiExternalConfigured: Boolean(aiApiKey && aiProvider !== "local"),
      timestamp: new Date().toISOString()
    });
  }
  return sendJson(res, 404, { ok: false, error: "Ruta no encontrada." });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => sendError(res, error));
});

server.listen(port, host, () => {
  console.log(`${appName} escuchando en http://${host}:${port}`);
});
