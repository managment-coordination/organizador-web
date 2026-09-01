import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { buildCollectionReport, buildEntityReport } from "./report-generator.js";
import { buildAssemblyMinutes } from "./assembly-minutes-generator.js";
import { analyzeSecurityText, extractSecurityDocument } from "./security-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

loadEnv(path.join(rootDir, ".env"));

const port = Number(process.env.PORT || 8771);
const host = process.env.HOST || "0.0.0.0";
const appName = process.env.APP_NAME || "Organizador Web";
const pythonBin = process.env.PYTHON_BIN || "python3";
const aiProvider = (process.env.AI_PROVIDER || "local").toLowerCase();
const aiApiKey = process.env.AI_API_KEY || process.env.NVIDIA_API_KEY || process.env.ORGANIZADOR_NVIDIA_API_KEY || process.env.OPENAI_API_KEY || "";
const aiBaseUrl = process.env.AI_BASE_URL || (aiProvider === "nvidia" ? "https://integrate.api.nvidia.com/v1" : "https://api.openai.com/v1");
const aiModel = process.env.AI_MODEL || (aiProvider === "nvidia" ? "nvidia/nemotron-3-super-120b-a12b" : "gpt-4.1-mini");
const dataDir = path.join(rootDir, "data");
const logsDir = path.join(rootDir, "logs");
const backupsDir = path.join(rootDir, "backups");
const uploadsDir = path.join(dataDir, "uploads");
const legacyAttachmentsDir = path.join(dataDir, "legacy-attachments");
const reportsDir = path.join(dataDir, "reports");
const assemblyDocumentsDir = path.join(dataDir, "assembly-documents");
const securityDocumentsDir = path.join(dataDir, "security-documents");
const databasePath = path.resolve(rootDir, process.env.DATABASE_PATH || "./data/organizador_tareas.db");
const assemblyBridgePath = path.join(__dirname, "assembly-bridge.py");
const adminBridgePath = path.join(__dirname, "admin-bridge.py");
const securityBridgePath = path.join(__dirname, "security-bridge.py");
const aiHistoryBridgePath = path.join(__dirname, "ai-history.py");

for (const dir of [dataDir, logsDir, backupsDir, uploadsDir, legacyAttachmentsDir, reportsDir, assemblyDocumentsDir, securityDocumentsDir]) {
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

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain; charset=utf-8"
  }[extension] || "application/octet-stream";
}

function sendFile(res, filePath, displayName, inline = false) {
  const name = String(displayName || path.basename(filePath)).replace(/[\r\n"]/g, "_");
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": stat.size,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(filePath).pipe(res);
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
      if (body.length > 1000000) {
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

function readRawBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("El archivo supera el limite de 25 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
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
      comunidades_asignadas: user.comunidades_asignadas || user.comunidades || [],
      alcance_comunidades: user.alcance_comunidades || "todas",
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
    data.comunidades = Array.isArray(data.comunidades) ? data.comunidades : [];
    data.comunidades_asignadas = Array.isArray(data.comunidades_asignadas) ? data.comunidades_asignadas : data.comunidades;
    data.alcance_comunidades = data.alcance_comunidades || "todas";
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
    const child = execFile(pythonBin, ["-"], { timeout: 30000, maxBuffer: 12 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } }, (error, stdout, stderr) => {
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
    child.stdin.on("error", () => {});
    child.stdin.end(script);
  });
}

function runAssemblyCommand(session, action, data = {}, pc = "web") {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ session, action, data, pc });
    execFile(pythonBin, [assemblyBridgePath, databasePath, request], { timeout: 30000, maxBuffer: 12 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } }, (error, stdout, stderr) => {
      let result;
      try {
        result = JSON.parse(String(stdout || "{}").trim() || "{}");
      } catch {
        reject(new Error(stderr || error?.message || "No se pudo leer la operacion de asamblea."));
        return;
      }
      if (error || result?.error) {
        reject(new Error(`${result?.error_type || "ValueError"}: ${result?.error || stderr || error?.message}`));
        return;
      }
      resolve(result);
    });
  });
}

function runAdminCommand(session, action, data = {}, pc = "web") {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ session, action, data, pc });
    execFile(pythonBin, [adminBridgePath, databasePath, request], { timeout: 30000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } }, (error, stdout, stderr) => {
      let result;
      try {
        result = JSON.parse(String(stdout || "{}").trim() || "{}");
      } catch {
        reject(new Error(stderr || error?.message || "No se pudo leer la operacion de administracion."));
        return;
      }
      if (error || result?.error) {
        reject(new Error(`${result?.error_type || "ValueError"}: ${result?.error || stderr || error?.message}`));
        return;
      }
      resolve(result);
    });
  });
}

function runAiHistoryCommand(session, action, data = {}) {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ session, action, data });
    execFile(pythonBin, [aiHistoryBridgePath, databasePath, request], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } }, (error, stdout, stderr) => {
      let result;
      try {
        result = JSON.parse(String(stdout || "{}").trim() || "{}");
      } catch {
        reject(new Error(stderr || error?.message || "No se pudo leer el historial de consultas."));
        return;
      }
      if (error || result?.error) {
        reject(new Error((result?.error_type || "ValueError") + ": " + (result?.error || stderr || error?.message)));
        return;
      }
      resolve(result);
    });
  });
}

function runAiMemoryCommand(session, action, data = {}, pc = "web") {
  const script = `
import json
import re
import sqlite3
from datetime import datetime

path = ${JSON.stringify(databasePath)}
session = json.loads(${JSON.stringify(JSON.stringify(session || {}))})
action = ${JSON.stringify(action)}
data = json.loads(${JSON.stringify(JSON.stringify(data || {}))})
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
user_id = int(session.get("id_usuario") or 0)

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def clean(value, limit=4000):
    return str(value or "").strip()[:limit]

def can_use_memory():
    return bool(user) and role in {"Superusuario", "Administrador", "Usuario"}

def can_manage_rule(row=None):
    if role in {"Superusuario", "Administrador"}:
        return True
    if row and int(row["id_usuario_creacion"] or 0) == user_id:
        return True
    return False

def ensure_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ia_reglas (
            id_regla INTEGER PRIMARY KEY AUTOINCREMENT,
            modulo TEXT NOT NULL,
            tipo_regla TEXT NOT NULL,
            descripcion TEXT NOT NULL,
            valor_detectado TEXT,
            valor_propuesto TEXT NOT NULL,
            patron TEXT,
            confianza REAL NOT NULL DEFAULT 0.7,
            activa INTEGER NOT NULL DEFAULT 1,
            confirmada INTEGER NOT NULL DEFAULT 1,
            origen TEXT,
            usos INTEGER NOT NULL DEFAULT 0,
            fecha_ultimo_uso TEXT,
            id_usuario_creacion INTEGER,
            usuario_creacion TEXT,
            fecha_creacion TEXT NOT NULL,
            usuario_confirmacion TEXT,
            fecha_confirmacion TEXT,
            pc_creacion TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ia_reglas_modulo_tipo ON ia_reglas(modulo, tipo_regla, activa)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ia_reglas_usuario ON ia_reglas(id_usuario_creacion, fecha_creacion DESC)")

def audit(conn, action_name, entity="", entity_id=None, detail=""):
    conn.execute(
        "INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)",
        (now_iso(), user, pc, action_name, entity, entity_id, clean(detail, 1000)),
    )

def row_dict(row):
    return dict(row) if row else None

def meaningful_words(value):
    words = re.findall(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]{4,}", str(value or "").lower())
    skip = {"para","sobre","desde","hasta","como","esta","este","estos","estas","debe","deben","tiene","tienen","hacer","revisar","coordinar","seguimiento","proximo","paso"}
    result = []
    for word in words:
        if word not in skip and word not in result:
            result.append(word)
    return " ".join(result[:14])

def create_rule(conn, tipo, field_label, original, final, source_text, origin):
    original = clean(original, 4000)
    final = clean(final, 4000)
    if not final or original == final:
        return None
    pattern = meaningful_words(source_text) or meaningful_words(original) or meaningful_words(final)
    description = f"Preferencia confirmada para {field_label}: usar una redaccion mas ajustada cuando el contexto sea similar."
    cursor = conn.execute(
        """
        INSERT INTO ia_reglas
        (modulo,tipo_regla,descripcion,valor_detectado,valor_propuesto,patron,confianza,activa,confirmada,
         origen,id_usuario_creacion,usuario_creacion,fecha_creacion,usuario_confirmacion,fecha_confirmacion,pc_creacion)
        VALUES ('redaccion',?,?,?,?,?,0.72,1,1,?,?,?,?,?,?)
        """,
        (tipo, description, original, final, pattern, origin, user_id, user, now_iso(), user, now_iso(), pc),
    )
    rule_id = int(cursor.lastrowid)
    audit(conn, "Crear regla IA", "ia_regla", rule_id, f"{tipo}: {final[:160]}")
    return rule_id

if not can_use_memory():
    raise PermissionError("Tu perfil no puede gestionar memoria IA.")

conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
try:
    with conn:
        ensure_schema(conn)
        if action == "list":
            include_inactive = bool(data.get("include_inactive"))
            sql = """
                SELECT *
                FROM ia_reglas
                WHERE 1=1
            """
            params = []
            module = clean(data.get("modulo"), 80)
            if module:
                sql += " AND modulo = ?"
                params.append(module)
            if not include_inactive:
                sql += " AND activa = 1"
            sql += " ORDER BY activa DESC, fecha_creacion DESC, id_regla DESC LIMIT ?"
            params.append(max(1, min(int(data.get("limit") or 80), 200)))
            rules = [dict(row) for row in conn.execute(sql, params)]
            print(json.dumps({"ok": True, "rules": rules}, ensure_ascii=False))
        elif action == "learn_redaction":
            original = data.get("original_payload") or {}
            final = data.get("final_payload") or {}
            source_text = clean(data.get("source_text"), 6000)
            origin = clean(data.get("origin") or data.get("action") or "entrada_inteligente", 200)
            created = []
            mapping = [
                ("redaccion_titulo", "titulo", "titulo"),
                ("redaccion_comentario", "comentario", "comentario"),
                ("redaccion_proximo_paso", "proximo paso", "proximo_paso"),
            ]
            for tipo, label, key in mapping:
                rule_id = create_rule(conn, tipo, label, original.get(key), final.get(key), source_text, origin)
                if rule_id:
                    created.append(rule_id)
            print(json.dumps({"ok": True, "created": created, "count": len(created)}, ensure_ascii=False))
        elif action == "update":
            rule_id = int(data.get("id_regla") or 0)
            row = conn.execute("SELECT * FROM ia_reglas WHERE id_regla=?", (rule_id,)).fetchone()
            if not row:
                raise ValueError("La regla no existe.")
            if not can_manage_rule(row):
                raise PermissionError("No tienes permiso para modificar esta regla.")
            fields = []
            params = []
            for column in ["descripcion", "valor_propuesto", "patron"]:
                if column in data:
                    fields.append(f"{column}=?")
                    params.append(clean(data.get(column), 4000))
            if "confianza" in data:
                fields.append("confianza=?")
                params.append(float(data.get("confianza") or 0.7))
            if "activa" in data:
                fields.append("activa=?")
                params.append(1 if data.get("activa") else 0)
            if not fields:
                raise ValueError("No hay cambios que guardar.")
            params.append(rule_id)
            conn.execute(f"UPDATE ia_reglas SET {', '.join(fields)} WHERE id_regla=?", params)
            audit(conn, "Actualizar regla IA", "ia_regla", rule_id, json.dumps({k:data.get(k) for k in data.keys() if k != "id_regla"}, ensure_ascii=False))
            print(json.dumps({"ok": True, "id_regla": rule_id}, ensure_ascii=False))
        elif action == "mark_used":
            ids = [int(value) for value in data.get("ids") or [] if int(value or 0)]
            if ids:
                marks = ",".join("?" for _ in ids)
                conn.execute(f"UPDATE ia_reglas SET usos=COALESCE(usos,0)+1, fecha_ultimo_uso=? WHERE id_regla IN ({marks})", [now_iso()] + ids)
            print(json.dumps({"ok": True, "count": len(ids)}, ensure_ascii=False))
        else:
            raise ValueError("Accion de memoria IA no valida.")
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function runAgentContextCommand(session, action, data = {}, pc = "web") {
  const script = `
import json
import sqlite3
from datetime import datetime

path = ${JSON.stringify(databasePath)}
session = json.loads(${JSON.stringify(JSON.stringify(session || {}))})
action = ${JSON.stringify(action)}
data = json.loads(${JSON.stringify(JSON.stringify(data || {}))})
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
user_id = int(session.get("id_usuario") or 0)

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def clean(value, limit=8000):
    return str(value or "").strip()[:limit]

def can_use_context():
    return bool(user) and role in {"Superusuario", "Administrador", "Usuario"}

def ensure_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ia_contexto_conversacion (
            id_contexto INTEGER PRIMARY KEY AUTOINCREMENT,
            id_usuario INTEGER,
            usuario TEXT,
            rol TEXT,
            pc TEXT,
            texto_usuario TEXT NOT NULL,
            texto_contextual TEXT,
            intent TEXT,
            herramienta_id TEXT,
            herramienta_modulo TEXT,
            herramienta_estado TEXT,
            resumen_respuesta TEXT,
            payload_json TEXT,
            fecha_creacion TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ia_contexto_usuario_fecha ON ia_contexto_conversacion(id_usuario, fecha_creacion DESC, id_contexto DESC)")

def row_dict(row):
    result = dict(row)
    try:
        result["payload"] = json.loads(result.get("payload_json") or "{}")
    except Exception:
        result["payload"] = {}
    result.pop("payload_json", None)
    return result

if not can_use_context():
    raise PermissionError("Tu perfil no puede usar contexto conversacional IA.")

conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
try:
    with conn:
        ensure_schema(conn)
        if action == "list":
            limit = max(1, min(int(data.get("limit") or 12), 40))
            rows = [
                row_dict(row)
                for row in conn.execute(
                    """
                    SELECT *
                    FROM ia_contexto_conversacion
                    WHERE id_usuario=?
                    ORDER BY fecha_creacion DESC, id_contexto DESC
                    LIMIT ?
                    """,
                    (user_id, limit),
                )
            ]
            print(json.dumps({"ok": True, "context": rows}, ensure_ascii=False))
        elif action == "save":
            payload = data.get("payload") or {}
            selected_tool = data.get("selected_tool") or {}
            cursor = conn.execute(
                """
                INSERT INTO ia_contexto_conversacion
                (id_usuario,usuario,rol,pc,texto_usuario,texto_contextual,intent,herramienta_id,
                 herramienta_modulo,herramienta_estado,resumen_respuesta,payload_json,fecha_creacion)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    user_id,
                    user,
                    role,
                    clean(pc, 200),
                    clean(data.get("texto_usuario"), 8000),
                    clean(data.get("texto_contextual"), 10000),
                    clean(data.get("intent"), 80),
                    clean(selected_tool.get("id"), 160),
                    clean(selected_tool.get("module"), 120),
                    clean(selected_tool.get("status"), 80),
                    clean(data.get("resumen_respuesta"), 2000),
                    json.dumps(payload, ensure_ascii=False)[:12000],
                    now_iso(),
                ),
            )
            keep = max(8, min(int(data.get("keep") or 24), 60))
            conn.execute(
                """
                DELETE FROM ia_contexto_conversacion
                WHERE id_usuario=?
                  AND id_contexto NOT IN (
                    SELECT id_contexto
                    FROM ia_contexto_conversacion
                    WHERE id_usuario=?
                    ORDER BY fecha_creacion DESC, id_contexto DESC
                    LIMIT ?
                  )
                """,
                (user_id, user_id, keep),
            )
            print(json.dumps({"ok": True, "id_contexto": int(cursor.lastrowid)}, ensure_ascii=False))
        elif action == "clear":
            conn.execute("DELETE FROM ia_contexto_conversacion WHERE id_usuario=?", (user_id,))
            print(json.dumps({"ok": True}, ensure_ascii=False))
        else:
            raise ValueError("Accion de contexto IA no valida.")
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function runAgentActionsCommand(session, action, data = {}, pc = "web") {
  const script = `
import json
import sqlite3
from datetime import datetime

path = ${JSON.stringify(databasePath)}
session = json.loads(${JSON.stringify(JSON.stringify(session || {}))})
action = ${JSON.stringify(action)}
data = json.loads(${JSON.stringify(JSON.stringify(data || {}))})
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
user_id = int(session.get("id_usuario") or 0)

def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def clean(value, limit=8000):
    return str(value or "").strip()[:limit]

def can_use_actions():
    return bool(user) and role in {"Superusuario", "Administrador", "Usuario"}

def ensure_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ia_propuestas_pendientes (
            id_propuesta INTEGER PRIMARY KEY AUTOINCREMENT,
            id_usuario INTEGER,
            usuario TEXT,
            rol TEXT,
            pc TEXT,
            intent TEXT,
            titulo TEXT,
            estado TEXT NOT NULL DEFAULT 'Pendiente',
            texto_usuario TEXT,
            resumen TEXT,
            propuesta_json TEXT,
            fecha_creacion TEXT NOT NULL,
            fecha_actualizacion TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ia_propuestas_usuario_estado ON ia_propuestas_pendientes(id_usuario, estado, fecha_creacion DESC)")

def row_dict(row):
    result = dict(row)
    try:
        result["propuesta"] = json.loads(result.get("propuesta_json") or "{}")
    except Exception:
        result["propuesta"] = {}
    result.pop("propuesta_json", None)
    return result

if not can_use_actions():
    raise PermissionError("Tu perfil no puede gestionar propuestas del agente.")

conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
try:
    with conn:
        ensure_schema(conn)
        if action == "list":
            limit = max(1, min(int(data.get("limit") or 40), 120))
            status = clean(data.get("estado"), 40)
            sql = """
                SELECT *
                FROM ia_propuestas_pendientes
                WHERE id_usuario=?
            """
            params = [user_id]
            if status:
                sql += " AND estado=?"
                params.append(status)
            sql += " ORDER BY CASE estado WHEN 'Pendiente' THEN 0 ELSE 1 END, fecha_creacion DESC, id_propuesta DESC LIMIT ?"
            params.append(limit)
            rows = [row_dict(row) for row in conn.execute(sql, params)]
            print(json.dumps({"ok": True, "actions": rows}, ensure_ascii=False))
        elif action == "save":
            proposal = data.get("proposal") or {}
            intent = clean(data.get("intent") or proposal.get("intent") or "", 60)
            if intent not in {"accion", "lote", "informe", "email"}:
                print(json.dumps({"ok": True, "skipped": True}, ensure_ascii=False))
            else:
                payload = proposal.get("payload") or {}
                entity = proposal.get("entity") or {}
                title = clean(
                    data.get("titulo")
                    or payload.get("titulo")
                    or entity.get("title")
                    or proposal.get("answer")
                    or intent,
                    180,
                )
                summary = clean(data.get("resumen") or proposal.get("answer") or "", 1600)
                cursor = conn.execute(
                    """
                    INSERT INTO ia_propuestas_pendientes
                    (id_usuario,usuario,rol,pc,intent,titulo,estado,texto_usuario,resumen,propuesta_json,fecha_creacion,fecha_actualizacion)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        user_id,
                        user,
                        role,
                        clean(pc, 200),
                        intent,
                        title,
                        "Pendiente",
                        clean(data.get("texto_usuario"), 8000),
                        summary,
                        json.dumps(proposal, ensure_ascii=False)[:60000],
                        now_iso(),
                        now_iso(),
                    ),
                )
                print(json.dumps({"ok": True, "id_propuesta": int(cursor.lastrowid)}, ensure_ascii=False))
        elif action == "update":
            proposal_id = int(data.get("id_propuesta") or 0)
            status = clean(data.get("estado"), 40)
            if status not in {"Pendiente", "Gestionada", "Descartada"}:
                raise ValueError("Estado de propuesta no valido.")
            cursor = conn.execute(
                "UPDATE ia_propuestas_pendientes SET estado=?, fecha_actualizacion=? WHERE id_propuesta=? AND id_usuario=?",
                (status, now_iso(), proposal_id, user_id),
            )
            if cursor.rowcount < 1:
                raise ValueError("No se ha encontrado la propuesta o no pertenece a tu usuario.")
            print(json.dumps({"ok": True, "id_propuesta": proposal_id, "estado": status}, ensure_ascii=False))
        elif action == "delete":
            proposal_id = int(data.get("id_propuesta") or 0)
            cursor = conn.execute("DELETE FROM ia_propuestas_pendientes WHERE id_propuesta=? AND id_usuario=?", (proposal_id, user_id))
            if cursor.rowcount < 1:
                raise ValueError("No se ha encontrado la propuesta o no pertenece a tu usuario.")
            print(json.dumps({"ok": True, "id_propuesta": proposal_id}, ensure_ascii=False))
        else:
            raise ValueError("Accion de propuestas IA no valida.")
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function runSecurityCommand(session, action, data = {}, pc = "web") {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ session, action, data, pc });
    execFile(pythonBin, [securityBridgePath, databasePath, request], { timeout: 45000, maxBuffer: 18 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } }, (error, stdout, stderr) => {
      let result;
      try {
        result = JSON.parse(String(stdout || "{}").trim() || "{}");
      } catch {
        reject(new Error(stderr || error?.message || "No se pudo leer la operacion de Seguridad."));
        return;
      }
      if (error || result?.error) {
        reject(new Error(`${result?.error_type || "ValueError"}: ${result?.error || stderr || error?.message}`));
        return;
      }
      resolve(result);
    });
  });
}

function securityOnlyForbidden(session) {
  return session?.rol === "Seguridad";
}

function reportsForbidden(session) {
  return session?.rol === "Presidente";
}

function redactSecurityText(value) {
  return String(value || "")
    .replace(/\b(?:DNI|NIE)\s*[:.]?\s*[A-Z0-9 -]{6,16}\b/gi, "[identificacion protegida]")
    .replace(/\b[XYZ]\s?\d{7,8}[A-Z]\b/gi, "[identificacion protegida]")
    .replace(/\b\d{7,10}[A-Z]?\b/g, "[dato protegido]")
    .replace(/\b\d{4}\s?[A-Z]{3}\b/gi, "[matricula protegida]")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function allowedCommunity(session, communityId) {
  if (session?.rol === "Superusuario") return true;
  const allowed = (session?.comunidades || []).map((row) => Number(row.id_comunidad)).filter(Boolean);
  return allowed.includes(Number(communityId));
}

function safeUploadName(value) {
  const decoded = (() => {
    try { return decodeURIComponent(String(value || "")); } catch { return String(value || ""); }
  })();
  const base = path.basename(decoded.replaceAll("\\", "/"));
  return base.replace(/[^A-Za-z0-9._() -]/g, "_").replace(/\s+/g, " ").trim().slice(0, 150) || "archivo";
}

function legacyPathFromStored(storedPath) {
  const normalized = String(storedPath || "").replaceAll("\\", "/");
  const marker = "/Organizador_Tareas/anexos/";
  const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return null;
  const relative = normalized.slice(index + marker.length).split("/").filter(Boolean);
  return path.join(legacyAttachmentsDir, ...relative);
}

function pathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveAttachmentPath(storedPath) {
  const direct = path.resolve(String(storedPath || ""));
  if (fs.existsSync(direct) && pathInside(direct, dataDir)) return direct;
  const legacy = legacyPathFromStored(storedPath);
  if (legacy && fs.existsSync(legacy) && pathInside(legacy, legacyAttachmentsDir)) return legacy;
  return null;
}

async function generateEntityReport(session, type, id, pc) {
  if (reportsForbidden(session)) throw new Error("El perfil Presidente no tiene acceso a informes.");
  const detail = await queryEntityDetail(session, type, id);
  if (detail?.error || !detail?.item) throw new Error(detail?.error || "Elemento no encontrado.");
  const folder = path.join(reportsDir, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(folder, { recursive: true });
  const attachments = (detail.attachments || []).map((row) => ({ ...row, resolvedPath: resolveAttachmentPath(row.ruta_archivo) || "" }));
  const report = await buildEntityReport({ type, item: detail.item, history: [...(detail.history || [])].reverse(), attachments });
  const outputPath = path.join(folder, report.filename);
  fs.writeFileSync(outputPath, report.buffer, { flag: "wx" });
  try {
    const projectId = type === "task" ? Number(detail.item.id_proyecto || 0) : Number(id);
    const communityId = Number(detail.item.id_comunidad || 0);
    const script = `
import json
import sqlite3
from datetime import datetime
path = ${JSON.stringify(databasePath)}
entity_type = ${JSON.stringify(type)}
entity_id = int(${JSON.stringify(id)})
project_id = int(${JSON.stringify(projectId)})
community_id = int(${JSON.stringify(communityId)})
output_path = ${JSON.stringify(outputPath)}
filename = ${JSON.stringify(report.filename)}
user = ${JSON.stringify(session?.nombre || "web")}
pc = ${JSON.stringify(pc || "web")}
now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
details = json.dumps({"tipo_entidad": entity_type, "id_entidad": entity_id, "anexos": ${JSON.stringify(attachments.length)}}, ensure_ascii=False)
conn = sqlite3.connect(path)
with conn:
    cursor = conn.execute("""
        INSERT INTO informes
        (fecha_generacion, tipo_informe, periodo_desde, periodo_hasta, id_proyecto,
         archivo_word, observaciones, usuario, pc, id_comunidad)
        VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?)
    """, (now, "Tarea" if entity_type == "task" else "Proyecto", project_id or None,
          output_path, details, user, pc, community_id))
    report_id = int(cursor.lastrowid)
    conn.execute("INSERT INTO auditoria (fecha_hora, usuario, pc, accion, entidad, id_entidad, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (now, user, pc, "Generar informe Word web", "tarea" if entity_type == "task" else "proyecto", entity_id, filename))
conn.close()
print(json.dumps({"ok": True, "report_id": report_id, "filename": filename}, ensure_ascii=False))
`;
    return await runPythonJson(script);
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw error;
  }
}

function queryReportsCenter(session) {
  const script = `
import json,sqlite3
path=${JSON.stringify(databasePath)}
session=${JSON.stringify(session || {})}
role=str(session.get("rol") or "")
allowed_ids=[int(c.get("id_comunidad")) for c in session.get("comunidades",[]) if c.get("id_comunidad")]
conn=sqlite3.connect(f"file:{path}?mode=ro",uri=True); conn.row_factory=sqlite3.Row
def rows(sql,params=()): return [dict(r) for r in conn.execute(sql,params).fetchall()]
def scope(alias):
    if role=="Superusuario": return "",[]
    if not allowed_ids: return " AND 1=0",[]
    return f" AND {alias}.id_comunidad IN ({','.join('?' for _ in allowed_ids)})",allowed_ids
rf,rp=scope("i")
reports=[] if role=="Presidente" else rows("""SELECT i.id_informe,i.fecha_generacion,i.tipo_informe,i.periodo_desde,i.periodo_hasta,
    i.id_proyecto,i.archivo_word,i.observaciones,i.usuario,i.id_comunidad,c.nombre AS comunidad,p.nombre AS proyecto
    FROM informes i LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad LEFT JOIN proyectos p ON p.id_proyecto=i.id_proyecto
    WHERE COALESCE(i.archivo_word,'')<>''"""+rf+" ORDER BY i.fecha_generacion DESC,i.id_informe DESC LIMIT 350",tuple(rp))
for report in reports:
    report["nombre_archivo"]=str(report.get("archivo_word") or "").replace("\\\\","/").split("/")[-1]
    report["entity_type"]="project"; report["entity_id"]=report.get("id_proyecto")
    try: metadata=json.loads(report.get("observaciones") or "{}")
    except (TypeError,ValueError): metadata={}
    if metadata.get("tipo_entidad") in {"task","tarea"} and metadata.get("id_entidad"):
        report["entity_type"]="task"; report["entity_id"]=int(metadata["id_entidad"])
    report.pop("archivo_word",None); report.pop("observaciones",None)
pf,pp=scope("p"); tf,tp=scope("t")
projects=rows("""SELECT 'project' AS entity_type,p.id_proyecto AS entity_id,p.id_comunidad,p.nombre AS titulo,
    p.estado_general AS estado,p.prioridad,p.responsable_principal AS responsable,p.fecha_ultima_actualizacion,c.nombre AS comunidad
    FROM proyectos p LEFT JOIN comunidades c ON c.id_comunidad=p.id_comunidad WHERE 1=1"""+pf+" ORDER BY p.nombre",tuple(pp))
tasks=[] if role=="Presidente" else rows("""SELECT 'task' AS entity_type,t.id_tarea AS entity_id,t.id_comunidad,t.titulo,
    t.estado,t.prioridad,t.responsable,t.fecha_ultima_actualizacion,c.nombre AS comunidad
    FROM tareas t LEFT JOIN comunidades c ON c.id_comunidad=t.id_comunidad WHERE 1=1"""+tf+" ORDER BY t.titulo",tuple(tp))
communities=rows("SELECT id_comunidad AS id,nombre FROM comunidades WHERE COALESCE(activo,1)=1 ORDER BY nombre") if role=="Superusuario" else list(session.get("comunidades") or [])
conn.close()
print(json.dumps({"reports":reports,"entities":projects+tasks,"communities":communities},ensure_ascii=False))
`;
  return runPythonJson(script);
}

async function generateCollectionReport(session, selections, title, pc) {
  if (!Array.isArray(selections) || !selections.length) throw new Error("Selecciona al menos un elemento.");
  if (selections.length > 40) throw new Error("El informe conjunto admite un maximo de 40 elementos.");
  const normalized = selections.map(row => ({ type: String(row.type || ""), id: Number(row.id || 0) }));
  if (normalized.some(row => !["task", "project"].includes(row.type) || !row.id)) throw new Error("La seleccion contiene elementos no validos.");
  if (reportsForbidden(session)) throw new Error("El perfil Presidente no tiene acceso a informes.");
  const details = await Promise.all(normalized.map(row => queryEntityDetail(session, row.type, row.id)));
  if (details.some(detail => !detail?.item || detail.error)) throw new Error("No se pudo acceder a uno de los elementos seleccionados.");
  const communityIds = [...new Set(details.map(detail => Number(detail.item.id_comunidad || 0)).filter(Boolean))];
  if (communityIds.length !== 1) throw new Error("Para mantener los permisos del archivo, selecciona elementos de una sola comunidad.");
  const entries = details.map((detail, index) => ({
    type: normalized[index].type,
    item: detail.item,
    history: [...(detail.history || [])].reverse(),
    attachments: (detail.attachments || []).map(row => ({ ...row, resolvedPath: resolveAttachmentPath(row.ruta_archivo) || "" }))
  }));
  const report = await buildCollectionReport({ title: String(title || "Informe conjunto").trim(), entries });
  const folder = path.join(reportsDir, new Date().toISOString().slice(0, 7));
  fs.mkdirSync(folder, { recursive: true });
  const outputPath = path.join(folder, report.filename);
  fs.writeFileSync(outputPath, report.buffer, { flag: "wx" });
  try {
    const script = `
import json,sqlite3
from datetime import datetime
path=${JSON.stringify(databasePath)}; output=${JSON.stringify(outputPath)}; filename=${JSON.stringify(report.filename)}
title=${JSON.stringify(String(title || "Informe conjunto").trim())}; community_id=int(${JSON.stringify(communityIds[0])})
selection=${JSON.stringify(normalized)}; user=${JSON.stringify(session?.nombre || "web")}; pc=${JSON.stringify(pc || "web")}
now=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
conn=sqlite3.connect(path)
with conn:
    cur=conn.execute("""INSERT INTO informes (fecha_generacion,tipo_informe,periodo_desde,periodo_hasta,id_proyecto,archivo_word,observaciones,usuario,pc,id_comunidad)
        VALUES (?,'Informe conjunto','','',NULL,?,?,?,?,?)""",(now,output,json.dumps({"titulo":title,"seleccion":selection},ensure_ascii=False),user,pc,community_id))
    report_id=int(cur.lastrowid)
    conn.execute("INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)",(now,user,pc,"Generar informe conjunto web","informe",report_id,f"{len(selection)} elementos | {filename}"))
conn.close(); print(json.dumps({"ok":True,"report_id":report_id,"filename":filename},ensure_ascii=False))
`;
    return await runPythonJson(script);
  } catch (error) {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    throw error;
  }
}

function queryReportFile(session, reportId) {
  const script = `
import json
import sqlite3
path = ${JSON.stringify(databasePath)}
report_id = int(${JSON.stringify(reportId)})
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
row = conn.execute("SELECT id_informe, archivo_word, tipo_informe, id_comunidad FROM informes WHERE id_informe=?", (report_id,)).fetchone()
conn.close()
print(json.dumps(dict(row) if row else {}, ensure_ascii=False))
`;
  return runPythonJson(script).then((row) => {
    if (!row?.id_informe || !allowedCommunity(session, row.id_comunidad)) throw new Error("Informe no encontrado o sin permiso.");
    if (reportsForbidden(session)) throw new Error("El perfil Presidente no tiene acceso a informes.");
    const filePath = path.resolve(String(row.archivo_word || ""));
    if (!fs.existsSync(filePath) || !pathInside(filePath, reportsDir)) throw new Error("El archivo del informe no esta disponible.");
    return { ...row, filePath, filename: path.basename(filePath) };
  });
}

function queryAttachmentFile(session, attachmentId) {
  const script = `
import json
import sqlite3
path = ${JSON.stringify(databasePath)}
attachment_id = int(${JSON.stringify(attachmentId)})
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
row = conn.execute("""
    SELECT a.*, COALESCE(a.id_comunidad, t.id_comunidad, p.id_comunidad) AS comunidad_real
    FROM anexos_registros a
    LEFT JOIN tareas t ON t.id_tarea=a.id_tarea
    LEFT JOIN proyectos p ON p.id_proyecto=a.id_proyecto
    WHERE a.id_anexo=?
""", (attachment_id,)).fetchone()
conn.close()
print(json.dumps(dict(row) if row else {}, ensure_ascii=False))
`;
  return runPythonJson(script).then((row) => {
    if (!row?.id_anexo || !allowedCommunity(session, row.comunidad_real)) throw new Error("Anexo no encontrado o sin permiso.");
    const filePath = resolveAttachmentPath(row.ruta_archivo);
    if (!filePath) throw new Error("Este anexo historico aun no esta disponible en el servidor.");
    return { ...row, filePath };
  });
}

async function saveEntityAttachment(session, type, id, fileName, mimeType, bytes, pc) {
  if (!["Superusuario", "Administrador", "Usuario"].includes(session?.rol)) {
    throw new Error("Tu perfil no tiene permiso para adjuntar archivos.");
  }
  if (!bytes?.length) throw new Error("El archivo esta vacio.");
  const detail = await queryEntityDetail(session, type, id);
  if (detail?.error || !detail?.item) throw new Error(detail?.error || "Elemento no encontrado.");
  const cleanName = safeUploadName(fileName);
  const blocked = new Set([".exe", ".bat", ".cmd", ".com", ".msi", ".ps1", ".scr", ".js", ".vbs"]);
  if (blocked.has(path.extname(cleanName).toLowerCase())) throw new Error("Este tipo de archivo no esta permitido.");
  const communityId = Number(detail.item.id_comunidad || 0);
  const entityFolder = path.join(uploadsDir, String(communityId || "sin-comunidad"), type, String(id));
  fs.mkdirSync(entityFolder, { recursive: true });
  const storedName = `${Date.now()}_${crypto.randomBytes(5).toString("hex")}_${cleanName}`;
  const storedPath = path.join(entityFolder, storedName);
  fs.writeFileSync(storedPath, bytes, { flag: "wx" });
  try {
    const script = `
import json
import sqlite3
from datetime import datetime
path = ${JSON.stringify(databasePath)}
entity_type = ${JSON.stringify(type === "task" ? "tarea" : "proyecto")}
entity_id = int(${JSON.stringify(id)})
community_id = int(${JSON.stringify(communityId)})
name = ${JSON.stringify(cleanName)}
stored_path = ${JSON.stringify(storedPath)}
user = ${JSON.stringify(session?.nombre || "web")}
pc = ${JSON.stringify(pc || "web")}
now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
conn = sqlite3.connect(path)
with conn:
    cursor = conn.execute("""
        INSERT INTO anexos_registros
        (id_comunidad, tipo_entidad, id_registro, id_tarea, id_proyecto,
         nombre_archivo, ruta_archivo, fecha_adjuntado, usuario, pc)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    """, (community_id, entity_type, entity_id if entity_type == "tarea" else None,
          entity_id if entity_type == "proyecto" else None, name, stored_path, now, user, pc))
    attachment_id = int(cursor.lastrowid)
    conn.execute("INSERT INTO auditoria (fecha_hora, usuario, pc, accion, entidad, id_entidad, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (now, user, pc, "Adjuntar archivo web", entity_type, entity_id, name))
conn.close()
print(json.dumps({"ok": True, "attachment_id": attachment_id, "name": name}, ensure_ascii=False))
`;
    return await runPythonJson(script);
  } catch (error) {
    if (fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
    throw error;
  }
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
    "usuario": {"nombre": user_name, "rol": role, "comunidades": ${JSON.stringify(session?.comunidades || [])},
                "comunidades_asignadas": ${JSON.stringify(session?.comunidades_asignadas || session?.comunidades || [])},
                "alcance_comunidades": ${JSON.stringify(session?.alcance_comunidades || "todas")}},
    "counts": counts,
    "proyectos": proyectos,
    "tareas": tareas,
    "estados_tareas": estados_tareas,
    "estados_proyectos": estados_proyectos,
}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function queryWorkflow(session) {
  const script = `
import json
import sqlite3
from datetime import date, datetime, timedelta

path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
role = str(session.get("rol") or "")
user_name = str(session.get("nombre") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def rows(sql, params=()):
    return [dict(row) for row in conn.execute(sql, params).fetchall()]

def community_filter(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1 = 0", []
    marks = ",".join("?" for _ in allowed_ids)
    return f" AND {alias}.id_comunidad IN ({marks})", allowed_ids

aliases = [user_name]
if user_name.lower() == "luis gallardo": aliases.append("Luis")
if user_name.lower() == "elena cuenca": aliases.append("Elena")
aliases = list(dict.fromkeys([a for a in aliases if a]))
alias_marks = ",".join("?" for _ in aliases) or "?"

action_filter, action_community_params = community_filter("a")
action_user_sql = "" if role == "Superusuario" else f" AND a.usuario_destino IN ({alias_marks})"
action_user_params = [] if role == "Superusuario" else aliases
actions = rows("""
    SELECT a.*, c.nombre AS comunidad,
           COALESCE(t.titulo, p.nombre, a.titulo) AS elemento,
           CASE WHEN a.id_tarea IS NOT NULL THEN 'task' ELSE 'project' END AS entity_type,
           COALESCE(a.id_tarea, a.id_proyecto) AS entity_id,
           COALESCE(t.estado, p.estado_general, '') AS estado_entidad,
           COALESCE(t.prioridad, p.prioridad, '') AS prioridad_entidad,
           COALESCE(t.responsable_proximo_paso, p.responsable_proximo_paso, a.usuario_destino) AS responsable_proximo_paso,
           COALESCE(t.fecha_objetivo_proximo_paso, t.fecha_proxima_revision, p.fecha_objetivo_proximo_paso, '') AS fecha_objetivo
    FROM acciones_pendientes a
    LEFT JOIN tareas t ON t.id_tarea=a.id_tarea
    LEFT JOIN proyectos p ON p.id_proyecto=a.id_proyecto
    LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
    WHERE a.estado='Pendiente'
""" + action_user_sql + action_filter + " ORDER BY a.fecha_creacion, a.id_accion", tuple(action_user_params + action_community_params))

notification_filter, notification_community_params = community_filter("n")
notification_user_sql = "" if role == "Superusuario" else f" AND n.usuario_destino IN ({alias_marks})"
notification_user_params = [] if role == "Superusuario" else aliases
notifications = rows("""
    SELECT n.*, c.nombre AS comunidad,
           CASE WHEN n.id_tarea IS NOT NULL THEN 'task' WHEN n.id_proyecto IS NOT NULL THEN 'project' ELSE '' END AS entity_type,
           COALESCE(n.id_tarea, n.id_proyecto) AS entity_id
    FROM notificaciones n
    LEFT JOIN comunidades c ON c.id_comunidad=n.id_comunidad
    WHERE 1=1
""" + notification_user_sql + notification_filter + " ORDER BY n.leida, n.fecha_creacion DESC, n.id_notificacion DESC LIMIT 100", tuple(notification_user_params + notification_community_params))

president_filter, president_params = community_filter("s")
president_requests = []
if role == "Presidente":
    president_requests = rows("""
        SELECT s.*, c.nombre AS comunidad,
               CASE WHEN s.id_tarea IS NOT NULL THEN 'task' ELSE 'project' END AS entity_type,
               COALESCE(s.id_tarea, s.id_proyecto) AS entity_id,
               COALESCE(t.titulo, p.nombre, s.titulo) AS elemento,
               COALESCE(t.estado, p.estado_general, '') AS estado_entidad,
               COALESCE(t.prioridad, p.prioridad, '') AS prioridad_entidad
        FROM solicitudes_presidente s
        LEFT JOIN tareas t ON t.id_tarea=s.id_tarea
        LEFT JOIN proyectos p ON p.id_proyecto=s.id_proyecto
        LEFT JOIN comunidades c ON c.id_comunidad=s.id_comunidad
        WHERE s.estado='Pendiente'
    """ + president_filter + " ORDER BY s.fecha_creacion, s.id_solicitud", tuple(president_params))

task_filter, task_params = community_filter("t")
project_filter, project_params = community_filter("p")
review_tasks = []
review_projects = []
if role != "Presidente":
    review_tasks = rows("""
        SELECT 'task' AS entity_type, t.id_tarea AS entity_id, t.id_comunidad,
               t.titulo AS elemento, t.estado, t.prioridad, t.responsable,
               t.responsable_proximo_paso, t.proximo_paso,
               COALESCE(t.fecha_objetivo_proximo_paso, t.fecha_proxima_revision, '') AS fecha_objetivo,
               t.fecha_ultima_actualizacion, p.nombre AS proyecto, c.nombre AS comunidad,
               (SELECT r.comentario FROM registros r WHERE r.id_tarea=t.id_tarea ORDER BY r.fecha_hora DESC, r.id_registro DESC LIMIT 1) AS ultimo_comentario
        FROM tareas t
        LEFT JOIN proyectos p ON p.id_proyecto=t.id_proyecto
        LEFT JOIN comunidades c ON c.id_comunidad=t.id_comunidad
        WHERE COALESCE(t.activa,1)=1 AND COALESCE(t.archivada,0)=0
          AND COALESCE(t.estado,'') NOT IN ('Terminada','Finalizada','Archivada','Cancelada')
    """ + task_filter, tuple(task_params))
    review_projects = rows("""
        SELECT 'project' AS entity_type, p.id_proyecto AS entity_id, p.id_comunidad,
               p.nombre AS elemento, p.estado_general AS estado, p.prioridad,
               p.responsable_principal AS responsable, p.responsable_proximo_paso,
               p.observaciones AS proximo_paso, COALESCE(p.fecha_objetivo_proximo_paso,'') AS fecha_objetivo,
               p.fecha_ultima_actualizacion, '' AS proyecto, c.nombre AS comunidad,
               (SELECT r.comentario FROM registros_proyectos r WHERE r.id_proyecto=p.id_proyecto ORDER BY r.fecha_hora DESC, r.id_registro_proyecto DESC LIMIT 1) AS ultimo_comentario
        FROM proyectos p
        LEFT JOIN comunidades c ON c.id_comunidad=p.id_comunidad
        WHERE COALESCE(p.activo,1)=1
          AND COALESCE(p.estado_general,'') NOT IN ('Finalizado','Finalizada','Archivado','Cancelado')
    """ + project_filter, tuple(project_params))

active_users = [str(r[0]).strip().lower() for r in conn.execute("SELECT nombre FROM usuarios WHERE COALESCE(activo,1)=1") if r[0]]
today = date.today()
stale_limit = today - timedelta(days=7)

def parse_day(value):
    text = str(value or "").strip()[:10]
    try: return date.fromisoformat(text)
    except ValueError: return None

def enrich(item):
    reasons = []
    state = str(item.get("estado") or "").lower()
    next_owner = str(item.get("responsable_proximo_paso") or "").strip()
    due = parse_day(item.get("fecha_objetivo"))
    updated = parse_day(item.get("fecha_ultima_actualizacion"))
    if due and due < today: reasons.append("Vencida")
    if "bloque" in state: reasons.append("Bloqueada")
    if "tercero" in state or (next_owner and next_owner.lower() not in active_users and next_owner.lower() not in [a.lower() for a in aliases]): reasons.append("Pendiente de tercero")
    if next_owner.lower() in [a.lower() for a in aliases] or str(item.get("responsable") or "").lower() in [a.lower() for a in aliases]: reasons.append("Pendiente de mi")
    if not updated or updated < stale_limit: reasons.append("Sin actualizar")
    item["review_reasons"] = reasons or ["Seguimiento ordinario"]
    item["review_score"] = (100 if "Bloqueada" in reasons else 0) + (80 if "Vencida" in reasons else 0) + (50 if "Pendiente de mi" in reasons else 0) + (30 if "Sin actualizar" in reasons else 0)
    return item

review_items = [enrich(item) for item in review_tasks + review_projects]
review_items.sort(key=lambda x: (-x["review_score"], str(x.get("fecha_objetivo") or "9999-12-31"), str(x.get("elemento") or "")))
summary = {
    "total": len(review_items),
    "vencidas": sum("Vencida" in x["review_reasons"] for x in review_items),
    "mias": sum("Pendiente de mi" in x["review_reasons"] for x in review_items),
    "terceros": sum("Pendiente de tercero" in x["review_reasons"] for x in review_items),
    "bloqueadas": sum("Bloqueada" in x["review_reasons"] for x in review_items),
    "sin_actualizar": sum("Sin actualizar" in x["review_reasons"] for x in review_items),
}
communities = rows("SELECT id_comunidad AS id, nombre FROM comunidades WHERE COALESCE(activo,1)=1 ORDER BY nombre") if role == "Superusuario" else list(session.get("comunidades") or [])
conn.close()
print(json.dumps({
    "actions": actions,
    "notifications": notifications,
    "unread_notifications": sum(not bool(n.get("leida")) for n in notifications),
    "president_requests": president_requests,
    "review": {"items": review_items, "summary": summary, "communities": communities},
}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function queryDailyOperations(session) {
  const script = `
import json
import sqlite3
from datetime import date, datetime, timedelta

path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
role = str(session.get("rol") or "")
user_name = str(session.get("nombre") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def rows(sql, params=()):
    return [dict(row) for row in conn.execute(sql, params).fetchall()]

def community_filter(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1=0", []
    marks = ",".join("?" for _ in allowed_ids)
    return f" AND {alias}.id_comunidad IN ({marks})", allowed_ids

aliases = [user_name]
if user_name.lower() == "luis gallardo": aliases.append("Luis")
if user_name.lower() == "elena cuenca": aliases.append("Elena")
aliases = list(dict.fromkeys([a for a in aliases if a]))
alias_lower = {a.lower() for a in aliases}
alias_marks = ",".join("?" for _ in aliases) or "?"
responsible_types = {str(r["nombre"] or "").strip().lower(): str(r["tipo"] or "Otro") for r in rows("SELECT nombre,tipo FROM responsables WHERE COALESCE(activo,1)=1")}
active_users = {str(r["nombre"] or "").strip().lower() for r in rows("SELECT nombre FROM usuarios WHERE COALESCE(activo,1)=1")}

def owner_group(owner):
    name = str(owner or "").strip()
    normalized = name.lower()
    if not name: return "Sin responsable"
    if normalized in alias_lower: return "Usuario activo"
    kind = responsible_types.get(normalized, "")
    if kind == "Tercero / Institución": return "Tercero"
    if kind: return kind
    if normalized in active_users: return "Usuario interno"
    if "president" in normalized: return "Presidente"
    if normalized in {"proveedor", "proveedores", "costilla", "securitas", "licuas", "administracion", "administración"}: return "Proveedor"
    if normalized in {"ayuntamiento", "junta", "endesa", "arcgisa"}: return "Tercero"
    return "Otro"

today = date.today()
stale_limit = today - timedelta(days=7)
week_start = today - timedelta(days=today.weekday())

def parse_day(value):
    text = str(value or "").strip()[:10]
    try: return date.fromisoformat(text)
    except ValueError: return None

def classify(state, priority, owner, target_date, updated_at, has_action):
    target = parse_day(target_date)
    updated = parse_day(updated_at)
    group = owner_group(owner)
    if str(state or "") in {"Bloqueada", "Bloqueado"}: return "Bloqueado / riesgo", 0
    if has_action or group == "Usuario activo":
        return ("Necesita acción", 0 if target and target < today else 1)
    if group in {"Presidente", "Proveedor", "Tercero", "Otro"}:
        return ("Bloqueado / riesgo", 2) if target and target < today else ("Pendiente de terceros", 3)
    if str(priority or "") == "Urgente": return "Necesita acción", 4
    if updated and updated < stale_limit: return "Bloqueado / riesgo", 5
    return "En seguimiento", 6

task_filter, task_params = community_filter("t")
project_filter, project_params = community_filter("p")
action_user_sql = "" if role == "Superusuario" else f" AND a.usuario_destino IN ({alias_marks})"
action_user_params = [] if role == "Superusuario" else aliases
tasks = []
if role != "Presidente":
    tasks = rows("""
        SELECT t.id_tarea AS entity_id, 'task' AS entity_type, t.id_comunidad,
               t.titulo, t.descripcion, t.categoria, t.estado, t.prioridad,
               t.responsable, t.responsable_proximo_paso,
               COALESCE(t.fecha_objetivo_proximo_paso,t.fecha_proxima_revision,'') AS fecha_objetivo,
               t.fecha_ultima_actualizacion, t.proximo_paso, c.nombre AS comunidad,
               (SELECT r.comentario FROM registros r WHERE r.id_tarea=t.id_tarea ORDER BY r.fecha_hora DESC,r.id_registro DESC LIMIT 1) AS ultimo_comentario,
               EXISTS(SELECT 1 FROM acciones_pendientes a WHERE a.id_tarea=t.id_tarea AND a.estado='Pendiente'""" + action_user_sql + """) AS has_action
        FROM tareas t
        LEFT JOIN comunidades c ON c.id_comunidad=t.id_comunidad
        WHERE COALESCE(t.activa,1)=1 AND COALESCE(t.archivada,0)=0
          AND COALESCE(t.estado,'') NOT IN ('Terminada','Finalizada','Archivada','Cancelada')
    """ + task_filter, tuple(action_user_params + task_params))

projects = rows("""
    SELECT p.id_proyecto AS entity_id, 'project' AS entity_type, p.id_comunidad,
           p.nombre AS titulo, p.descripcion, p.categoria, p.estado_general AS estado, p.prioridad,
           p.responsable_principal AS responsable, p.responsable_proximo_paso,
           COALESCE(p.fecha_objetivo_proximo_paso,p.fecha_prevista_finalizacion,'') AS fecha_objetivo,
           p.fecha_ultima_actualizacion, p.observaciones AS proximo_paso, c.nombre AS comunidad,
           (SELECT r.comentario FROM registros_proyectos r WHERE r.id_proyecto=p.id_proyecto ORDER BY r.fecha_hora DESC,r.id_registro_proyecto DESC LIMIT 1) AS ultimo_comentario,
           EXISTS(SELECT 1 FROM acciones_pendientes a WHERE a.id_proyecto=p.id_proyecto AND a.estado='Pendiente'""" + action_user_sql + """) AS has_action
    FROM proyectos p
    LEFT JOIN comunidades c ON c.id_comunidad=p.id_comunidad
    WHERE COALESCE(p.activo,1)=1 AND COALESCE(p.estado_general,'') NOT IN ('Finalizado','Finalizada','Archivado','Cancelado')
""" + project_filter, tuple(action_user_params + project_params))

items = []
for item in tasks + projects:
    owner = item.get("responsable_proximo_paso") or item.get("responsable") or ""
    section, order = classify(item.get("estado"), item.get("prioridad"), owner, item.get("fecha_objetivo"), item.get("fecha_ultima_actualizacion"), bool(item.get("has_action")))
    item["seccion"] = section
    item["orden"] = order
    item["grupo_responsable"] = owner_group(owner)
    item["detalle"] = item.get("proximo_paso") or item.get("ultimo_comentario") or item.get("descripcion") or ""
    items.append(item)

priority_order = {"Urgente":0,"Alta":1,"Media":2,"Baja":3}
items.sort(key=lambda x: (x.get("orden",9), priority_order.get(x.get("prioridad"),9), x.get("fecha_objetivo") or "9999-99-99", x.get("titulo") or ""))
all_items = tasks + projects
metrics = {
    "activos": len(all_items),
    "tareas_activas": len(tasks),
    "proyectos_activos": len(projects),
    "urgentes": sum(str(x.get("prioridad") or "") == "Urgente" for x in all_items),
    "bloqueados": sum(str(x.get("estado") or "") in {"Bloqueada","Bloqueado"} for x in all_items),
    "terceros": sum("tercero" in str(x.get("estado") or "").lower() or owner_group(x.get("responsable_proximo_paso") or x.get("responsable")) in {"Presidente","Proveedor","Tercero","Otro"} for x in all_items),
    "sin_revisar": sum(not parse_day(x.get("fecha_ultima_actualizacion")) or parse_day(x.get("fecha_ultima_actualizacion")) < stale_limit for x in all_items),
}
section_counts = {name: sum(x.get("seccion") == name for x in items) for name in ["Necesita acción","Pendiente de terceros","En seguimiento","Bloqueado / riesgo"]}

attachment_filter, attachment_params = community_filter("a")
attachment_extra = " AND a.id_tarea IS NULL" if role == "Presidente" else ""
attachments = rows("""
    SELECT a.id_anexo AS id, 'attachment' AS document_type, a.id_comunidad,
           a.nombre_archivo AS nombre, a.ruta_archivo AS ruta, a.fecha_adjuntado AS fecha,
           a.id_tarea, a.id_proyecto, c.nombre AS comunidad,
           t.titulo AS tarea, p.nombre AS proyecto,
           CASE WHEN a.id_tarea IS NOT NULL THEN 'task' ELSE 'project' END AS entity_type,
           COALESCE(a.id_tarea,a.id_proyecto) AS entity_id
    FROM anexos_registros a
    LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
    LEFT JOIN tareas t ON t.id_tarea=a.id_tarea
    LEFT JOIN proyectos p ON p.id_proyecto=a.id_proyecto
    WHERE 1=1
""" + attachment_extra + attachment_filter + " ORDER BY a.fecha_adjuntado DESC,a.id_anexo DESC LIMIT 160", tuple(attachment_params))

report_filter, report_params = community_filter("i")
reports = [] if role == "Presidente" else rows("""
    SELECT i.id_informe AS id, 'report' AS document_type, i.id_comunidad,
           COALESCE(NULLIF(i.tipo_informe,''),'Informe') AS nombre, i.archivo_word AS ruta,
           i.fecha_generacion AS fecha, NULL AS id_tarea, i.id_proyecto,
           c.nombre AS comunidad, '' AS tarea, p.nombre AS proyecto,
           'project' AS entity_type, i.id_proyecto AS entity_id, i.observaciones, i.tipo_informe
    FROM informes i
    LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad
    LEFT JOIN proyectos p ON p.id_proyecto=i.id_proyecto
    WHERE COALESCE(i.archivo_word,'')<>''
""" + report_filter + " ORDER BY i.fecha_generacion DESC,i.id_informe DESC LIMIT 100", tuple(report_params))

for report in reports:
    stored_name = str(report.get("ruta") or "").replace("\\\\", "/").split("/")[-1]
    if stored_name: report["nombre"] = stored_name
    try:
        metadata = json.loads(report.get("observaciones") or "{}")
    except (TypeError, ValueError):
        metadata = {}
    if metadata.get("tipo_entidad") in {"task", "tarea"} and metadata.get("id_entidad"):
        report["entity_type"] = "task"
        report["entity_id"] = int(metadata["id_entidad"])
        report["id_tarea"] = int(metadata["id_entidad"])
    report.pop("observaciones", None)
    report.pop("tipo_informe", None)
    report.pop("ruta", None)

documents = attachments + reports
documents.sort(key=lambda x: str(x.get("fecha") or ""), reverse=True)
for document in documents:
    document.pop("ruta", None)
communities = rows("SELECT id_comunidad AS id,nombre FROM comunidades WHERE COALESCE(activo,1)=1 ORDER BY nombre") if role == "Superusuario" else list(session.get("comunidades") or [])
conn.close()
print(json.dumps({"metrics":metrics,"map":{"items":items,"counts":section_counts},"documents":documents[:220],"communities":communities}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function queryGlobalSearch(session, term, typeFilter, communityId) {
  const cleanTerm = String(term || "").trim().slice(0, 160);
  if (!cleanTerm) return Promise.resolve({ results: [], term: "" });
  const script = `
import json
import sqlite3

path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
term = ${JSON.stringify(cleanTerm)}
type_filter = ${JSON.stringify(typeFilter || "all")}
requested_community = int(${JSON.stringify(Number(communityId) || 0)})
role = str(session.get("rol") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
if requested_community and role != "Superusuario" and requested_community not in allowed_ids:
    raise PermissionError("No tienes permiso para buscar en esa comunidad.")
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
like = f"%{term}%"
results = []

def rows(sql, params=()): return [dict(r) for r in conn.execute(sql, params).fetchall()]
def scope(alias):
    ids = [requested_community] if requested_community else allowed_ids
    if role == "Superusuario" and not requested_community: return "", []
    if not ids: return " AND 1=0", []
    return f" AND {alias}.id_comunidad IN ({','.join('?' for _ in ids)})", ids
def include(*kinds): return type_filter in {"", "all", *kinds}

project_scope, project_params = scope("p")
if include("project", "entity"):
    for r in rows("""SELECT p.id_proyecto AS id,'project' AS entity_type,p.id_comunidad,p.nombre AS titulo,
                    COALESCE((SELECT rp.comentario FROM registros_proyectos rp WHERE rp.id_proyecto=p.id_proyecto ORDER BY rp.fecha_hora DESC,rp.id_registro_proyecto DESC LIMIT 1),p.descripcion,'') AS detalle,
                    c.nombre AS comunidad,p.estado_general AS estado,p.prioridad
                    FROM proyectos p LEFT JOIN comunidades c ON c.id_comunidad=p.id_comunidad
                    WHERE (p.nombre LIKE ? OR p.descripcion LIKE ? OR p.categoria LIKE ? OR p.responsable_principal LIKE ? OR p.responsable_proximo_paso LIKE ?)""" + project_scope + " ORDER BY p.fecha_ultima_actualizacion DESC LIMIT 60", tuple([like]*5 + project_params)):
        r["tipo"]="Proyecto"; r["result_type"]="entity"; results.append(r)

task_scope, task_params = scope("t")
if role != "Presidente" and include("task", "entity"):
    for r in rows("""SELECT t.id_tarea AS id,'task' AS entity_type,t.id_comunidad,t.titulo,
                    COALESCE((SELECT rr.comentario FROM registros rr WHERE rr.id_tarea=t.id_tarea ORDER BY rr.fecha_hora DESC,rr.id_registro DESC LIMIT 1),t.proximo_paso,t.descripcion,'') AS detalle,
                    c.nombre AS comunidad,t.estado,t.prioridad
                    FROM tareas t LEFT JOIN comunidades c ON c.id_comunidad=t.id_comunidad
                    WHERE (t.titulo LIKE ? OR t.descripcion LIKE ? OR t.categoria LIKE ? OR t.responsable LIKE ? OR t.responsable_proximo_paso LIKE ? OR t.proximo_paso LIKE ?)""" + task_scope + " ORDER BY t.fecha_ultima_actualizacion DESC LIMIT 60", tuple([like]*6 + task_params)):
        r["tipo"]="Tarea"; r["result_type"]="entity"; results.append(r)

record_project_scope, record_project_params = scope("rp")
if include("record", "project_record"):
    for r in rows("""SELECT rp.id_proyecto AS id,'project' AS entity_type,rp.id_comunidad,p.nombre AS titulo,
                    COALESCE(rp.comentario,rp.proximo_paso,'') AS detalle,c.nombre AS comunidad,rp.fecha_hora AS fecha
                    FROM registros_proyectos rp JOIN proyectos p ON p.id_proyecto=rp.id_proyecto
                    LEFT JOIN comunidades c ON c.id_comunidad=rp.id_comunidad
                    WHERE (rp.comentario LIKE ? OR rp.proximo_paso LIKE ? OR rp.usuario LIKE ?)""" + record_project_scope + " ORDER BY rp.fecha_hora DESC LIMIT 60", tuple([like]*3 + record_project_params)):
        r["tipo"]="Seguimiento de proyecto"; r["result_type"]="entity"; results.append(r)

record_task_scope, record_task_params = scope("r")
if role != "Presidente" and include("record", "task_record"):
    for r in rows("""SELECT r.id_tarea AS id,'task' AS entity_type,r.id_comunidad,t.titulo,
                    COALESCE(r.comentario,r.proximo_paso,'') AS detalle,c.nombre AS comunidad,r.fecha_hora AS fecha
                    FROM registros r JOIN tareas t ON t.id_tarea=r.id_tarea
                    LEFT JOIN comunidades c ON c.id_comunidad=r.id_comunidad
                    WHERE (r.comentario LIKE ? OR r.proximo_paso LIKE ? OR r.usuario LIKE ?)""" + record_task_scope + " ORDER BY r.fecha_hora DESC LIMIT 60", tuple([like]*3 + record_task_params)):
        r["tipo"]="Seguimiento de tarea"; r["result_type"]="entity"; results.append(r)

attachment_scope, attachment_params = scope("a")
attachment_extra = " AND a.id_tarea IS NULL" if role == "Presidente" else ""
if include("attachment", "document"):
    for r in rows("""SELECT a.id_anexo AS id,a.id_comunidad,a.nombre_archivo AS titulo,
                    COALESCE(t.titulo,p.nombre,'Archivo adjunto') AS detalle,
                    c.nombre AS comunidad,CASE WHEN a.id_tarea IS NOT NULL THEN 'task' ELSE 'project' END AS entity_type,
                    COALESCE(a.id_tarea,a.id_proyecto) AS entity_id,a.fecha_adjuntado AS fecha
                    FROM anexos_registros a LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
                    LEFT JOIN tareas t ON t.id_tarea=a.id_tarea LEFT JOIN proyectos p ON p.id_proyecto=a.id_proyecto
                    WHERE (a.nombre_archivo LIKE ? OR a.ruta_archivo LIKE ?)""" + attachment_extra + attachment_scope + " ORDER BY a.fecha_adjuntado DESC LIMIT 60", tuple([like,like] + attachment_params)):
        r["tipo"]="Anexo"; r["result_type"]="attachment"; results.append(r)

report_scope, report_params = scope("i")
if role != "Presidente" and include("report", "document"):
    for r in rows("""SELECT i.id_informe AS id,i.id_comunidad,COALESCE(NULLIF(i.tipo_informe,''),'Informe') AS titulo,
                    COALESCE(p.nombre,'Informe generado') AS detalle,c.nombre AS comunidad,'project' AS entity_type,
                    i.id_proyecto AS entity_id,i.fecha_generacion AS fecha,i.archivo_word,i.observaciones
                    FROM informes i LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad
                    LEFT JOIN proyectos p ON p.id_proyecto=i.id_proyecto
                    WHERE (i.tipo_informe LIKE ? OR i.archivo_word LIKE ? OR p.nombre LIKE ?)""" + report_scope + " ORDER BY i.fecha_generacion DESC LIMIT 60", tuple([like,like,like] + report_params)):
        stored_name = str(r.get("archivo_word") or "").replace("\\\\", "/").split("/")[-1]
        if stored_name: r["titulo"] = stored_name
        try: metadata = json.loads(r.get("observaciones") or "{}")
        except (TypeError, ValueError): metadata = {}
        if metadata.get("tipo_entidad") in {"task", "tarea"} and metadata.get("id_entidad"):
            r["entity_type"] = "task"; r["entity_id"] = int(metadata["id_entidad"])
        r.pop("archivo_word", None); r.pop("observaciones", None)
        r["tipo"]="Informe"; r["result_type"]="report"; results.append(r)

action_scope, action_params = scope("a")
if role != "Presidente" and include("action"):
    for r in rows("""SELECT a.id_accion AS id,a.id_comunidad,COALESCE(t.titulo,p.nombre,a.titulo) AS titulo,
                    COALESCE(a.detalle,'') AS detalle,c.nombre AS comunidad,
                    CASE WHEN a.id_tarea IS NOT NULL THEN 'task' ELSE 'project' END AS entity_type,
                    COALESCE(a.id_tarea,a.id_proyecto) AS entity_id,a.fecha_creacion AS fecha,a.estado
                    FROM acciones_pendientes a LEFT JOIN tareas t ON t.id_tarea=a.id_tarea
                    LEFT JOIN proyectos p ON p.id_proyecto=a.id_proyecto LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
                    WHERE (a.titulo LIKE ? OR a.detalle LIKE ? OR a.usuario_destino LIKE ? OR a.solicitante LIKE ?)""" + action_scope + " ORDER BY a.fecha_creacion DESC LIMIT 50", tuple([like]*4 + action_params)):
        r["tipo"]="Acción pendiente"; r["result_type"]="entity"; results.append(r)

results.sort(key=lambda r: str(r.get("fecha") or ""), reverse=True)
conn.close()
print(json.dumps({"term":term,"results":results[:200]}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function markNotifications(session, notificationId, markAll, pc) {
  const script = `
import json
import sqlite3
from datetime import datetime
path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
notification_id = int(${JSON.stringify(notificationId || 0)})
mark_all = ${markAll ? "True" : "False"}
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
aliases = [user]
if user.lower() == "luis gallardo": aliases.append("Luis")
if user.lower() == "elena cuenca": aliases.append("Elena")
now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
conn = sqlite3.connect(path)
with conn:
    conditions = ["leida=0"]
    params = []
    if not mark_all:
        conditions.append("id_notificacion=?")
        params.append(notification_id)
    if role != "Superusuario":
        conditions.append("usuario_destino IN (" + ",".join("?" for _ in aliases) + ")")
        params.extend(aliases)
        if allowed_ids:
            conditions.append("id_comunidad IN (" + ",".join("?" for _ in allowed_ids) + ")")
            params.extend(allowed_ids)
        else:
            conditions.append("1=0")
    cursor = conn.execute("UPDATE notificaciones SET leida=1, fecha_lectura=? WHERE " + " AND ".join(conditions), tuple([now] + params))
    changed = cursor.rowcount
    conn.execute("INSERT INTO auditoria (fecha_hora, usuario, pc, accion, entidad, id_entidad, detalle) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 (now, user, pc, "Marcar notificaciones leidas web", "notificacion", notification_id or None, f"Marcadas: {changed}"))
conn.close()
print(json.dumps({"ok": True, "changed": changed}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function saveReviewSummary(session, payload, pc) {
  const script = `
import json
import sqlite3
from datetime import date, datetime
path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
data = ${JSON.stringify(payload || {})}
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
if role == "Presidente": raise PermissionError("El perfil Presidente no realiza revisiones operativas.")
community_id = int(data.get("id_comunidad") or 0) or None
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
if community_id and role != "Superusuario" and community_id not in allowed_ids: raise PermissionError("No tienes permiso para esa comunidad.")
tasks = int(data.get("tasks") or 0)
projects = int(data.get("projects") or 0)
skipped = int(data.get("skipped") or 0)
notes = str(data.get("observaciones") or "").strip()
details = json.dumps({"proyectos_revisados": projects, "observaciones": notes}, ensure_ascii=False)
now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
conn = sqlite3.connect(path)
with conn:
    cursor = conn.execute("""
        INSERT INTO revisiones_diarias
        (fecha,tareas_creadas,tareas_revisadas,tareas_terminadas,tareas_bloqueadas,tareas_saltadas,observaciones,usuario,pc,id_comunidad)
        VALUES (?,0,?,0,0,?,?,?,?,?)
    """, (date.today().isoformat(), tasks, skipped, details, user, pc, community_id))
    review_id = int(cursor.lastrowid)
    conn.execute("INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)",
                 (now,user,pc,"Cerrar revision diaria web","revision_diaria",review_id,details))
conn.close()
print(json.dumps({"ok": True, "review_id": review_id}, ensure_ascii=False))
`;
  return runPythonJson(script);
}

function respondPresidentRequest(session, requestId, decision, comment, pc) {
  const script = `
import json
import sqlite3
from datetime import datetime
path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
request_id = int(${JSON.stringify(requestId)})
decision = ${JSON.stringify(decision)}
comment = ${JSON.stringify(comment)}.strip()
pc = ${JSON.stringify(pc || "web")}
user = str(session.get("nombre") or "")
role = str(session.get("rol") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
if role != "Presidente": raise PermissionError("Solo el perfil Presidente puede responder estas solicitudes.")
if decision not in {"Aprobada", "Rechazada", "Solicita aclaracion"}: raise ValueError("Respuesta no valida.")
if not comment: raise ValueError("El comentario es obligatorio.")
now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
try:
    with conn:
        req = conn.execute("SELECT * FROM solicitudes_presidente WHERE id_solicitud=?", (request_id,)).fetchone()
        if not req or req["estado"] != "Pendiente": raise ValueError("La solicitud ya no esta pendiente.")
        if not allowed_ids or int(req["id_comunidad"] or 0) not in allowed_ids: raise PermissionError("No tienes permiso para esta comunidad.")
        return_owner = str(req["responsable_retorno"] or req["solicitante"] or "").strip()
        requested_step = str(req["proximo_paso_solicitado"] or "").strip()
        if decision == "Aprobada": next_step = requested_step or "Continuar con la actuacion aprobada por el presidente."
        elif decision == "Rechazada": next_step = "Revisar una alternativa tras el rechazo del presidente."
        else: next_step = "Preparar y remitir la aclaracion solicitada por el presidente."
        conn.execute("""
            UPDATE solicitudes_presidente
            SET estado=?, fecha_respuesta=?, usuario_respuesta=?, comentario_respuesta=?
            WHERE id_solicitud=?
        """, (decision, now, user, comment, request_id))
        record_id = None
        if req["id_tarea"]:
            item = conn.execute("SELECT * FROM tareas WHERE id_tarea=?", (req["id_tarea"],)).fetchone()
            cur = conn.execute("""
                INSERT INTO registros
                (id_tarea,id_proyecto,fecha_hora,tipo_registro,comentario,estado_anterior,estado_nuevo,
                 prioridad_anterior,prioridad_nueva,responsable_anterior,responsable_nuevo,proximo_paso,
                 fecha_proxima_revision,motivo_bloqueo,usuario,pc,id_comunidad,responsable_proximo_paso,fecha_objetivo_proximo_paso)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (item["id_tarea"],item["id_proyecto"],now,"Decision de presidencia",f"{decision}: {comment}",
                  item["estado"],item["estado"],item["prioridad"],item["prioridad"],item["responsable"],return_owner,
                  next_step,item["fecha_proxima_revision"],"",user,pc,item["id_comunidad"],return_owner,item["fecha_objetivo_proximo_paso"]))
            record_id = int(cur.lastrowid)
            conn.execute("UPDATE tareas SET responsable=?, responsable_proximo_paso=?, proximo_paso=?, fecha_ultima_actualizacion=?, usuario_ultima_actualizacion=?, pc_ultima_actualizacion=? WHERE id_tarea=?",
                         (return_owner,return_owner,next_step,now,user,pc,item["id_tarea"]))
            entity_type, entity_id, title = "tarea", int(item["id_tarea"]), str(item["titulo"])
        else:
            item = conn.execute("SELECT * FROM proyectos WHERE id_proyecto=?", (req["id_proyecto"],)).fetchone()
            cur = conn.execute("""
                INSERT INTO registros_proyectos
                (id_proyecto,fecha_hora,tipo_registro,comentario,estado_anterior,estado_nuevo,prioridad_anterior,
                 prioridad_nueva,responsable_anterior,responsable_nuevo,proximo_paso,fecha_proxima_revision,
                 motivo_bloqueo,usuario,pc,id_comunidad,responsable_proximo_paso,fecha_objetivo_proximo_paso)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (item["id_proyecto"],now,"Decision de presidencia",f"{decision}: {comment}",item["estado_general"],
                  item["estado_general"],item["prioridad"],item["prioridad"],item["responsable_principal"],return_owner,
                  next_step,item["fecha_objetivo_proximo_paso"],"",user,pc,item["id_comunidad"],return_owner,item["fecha_objetivo_proximo_paso"]))
            record_id = int(cur.lastrowid)
            conn.execute("UPDATE proyectos SET responsable_principal=?, responsable_proximo_paso=?, observaciones=?, fecha_ultima_actualizacion=?, usuario_ultima_actualizacion=?, pc_ultima_actualizacion=? WHERE id_proyecto=?",
                         (return_owner,return_owner,next_step,now,user,pc,item["id_proyecto"]))
            entity_type, entity_id, title = "proyecto", int(item["id_proyecto"]), str(item["nombre"])
        requester = str(req["solicitante"] or return_owner).strip()
        conn.execute("""
            INSERT INTO notificaciones
            (id_comunidad,usuario_destino,tipo,titulo,mensaje,id_solicitud,id_tarea,id_proyecto,leida,fecha_creacion)
            VALUES (?,?,?,?,?,?,?,?,0,?)
        """, (req["id_comunidad"],requester,"Respuesta presidente",f"{decision}: {title}",comment,request_id,
              req["id_tarea"],req["id_proyecto"],now))
        if requester:
            existing = conn.execute("SELECT id_accion FROM acciones_pendientes WHERE tipo_entidad=? AND COALESCE(id_tarea,0)=? AND COALESCE(id_proyecto,0)=? AND usuario_destino=? AND estado='Pendiente' LIMIT 1",
                                    (entity_type, int(req["id_tarea"] or 0), int(req["id_proyecto"] or 0), requester)).fetchone()
            if not existing:
                conn.execute("""
                    INSERT INTO acciones_pendientes
                    (id_comunidad,tipo_entidad,id_tarea,id_proyecto,id_registro_origen,tipo_accion,usuario_destino,
                     solicitante,titulo,detalle,estado,fecha_creacion,pc_creacion)
                    VALUES (?,?,?,?,?,?,?,?,?,?,'Pendiente',?,?)
                """, (req["id_comunidad"],entity_type,req["id_tarea"],req["id_proyecto"],record_id,
                      "Gestionar respuesta de presidencia",requester,user,title,next_step,now,pc))
        conn.execute("UPDATE notificaciones SET leida=1, fecha_lectura=? WHERE id_solicitud=? AND usuario_destino='Presidente' AND leida=0", (now,request_id))
        conn.execute("INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)",
                     (now,user,pc,"Responder solicitud presidente web","solicitud_presidente",request_id,f"{decision}: {comment}"))
    print(json.dumps({"ok": True, "decision": decision, "type": "task" if req["id_tarea"] else "project", "id": entity_id}, ensure_ascii=False))
finally:
    conn.close()
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

function scoreAiRuleMatch(text, rule) {
  const source = normalizeText(text);
  const words = normalizeText([rule?.patron, rule?.valor_detectado, rule?.descripcion].filter(Boolean).join(" "))
    .split(" ")
    .filter((token) => token.length > 3);
  const unique = [...new Set(words)].slice(0, 20);
  if (!source || !unique.length) return 0;
  return unique.reduce((score, token) => score + (source.includes(token) ? 1 : 0), 0);
}

function applyRedactionRulesToProposal(proposal, rules, sourceText) {
  if (!proposal?.payload || !AI_ACTIONS_REQUIRING_CONFIRMATION.has(proposal.action)) return proposal;
  const fieldMap = {
    redaccion_titulo: "titulo",
    redaccion_comentario: "comentario",
    redaccion_proximo_paso: "proximo_paso",
  };
  const usedRules = [];
  const payload = { ...proposal.payload };
  for (const [ruleType, field] of Object.entries(fieldMap)) {
    if (field === "titulo" && !["crear_tarea", "crear_proyecto"].includes(proposal.action)) continue;
    const candidates = (rules || [])
      .filter((rule) => rule.tipo_regla === ruleType && rule.valor_propuesto)
      .map((rule) => ({ ...rule, match_score: scoreAiRuleMatch(sourceText, rule) }))
      .filter((rule) => rule.match_score >= 2 || Number(rule.confianza || 0) >= 0.9)
      .sort((a, b) => (b.match_score - a.match_score) || (Number(b.confianza || 0) - Number(a.confianza || 0)));
    const selected = candidates[0];
    if (!selected) continue;
    const proposed = String(selected.valor_propuesto || "").trim();
    if (proposed && proposed !== String(payload[field] || "").trim()) {
      payload[field] = proposed;
      usedRules.push({
        id_regla: selected.id_regla,
        tipo_regla: selected.tipo_regla,
        descripcion: selected.descripcion,
        confianza: selected.confianza,
        match_score: selected.match_score,
      });
    }
  }
  if (!usedRules.length) return proposal;
  return {
    ...proposal,
    payload,
    used_rules: [...(proposal.used_rules || []), ...usedRules],
    memory_note: "Se han aplicado reglas de redaccion confirmadas por usuarios autorizados.",
  };
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
    const summary = summarizeOperationalText(clean, 5);
    return [
      `Se registra comunicacion relacionada con ${subject}.`,
      summary.length
        ? "Hechos relevantes:\n" + summary.map((line) => `- ${line}`).join("\n")
        : "Se aporta informacion operativa pendiente de revisar.",
      inferOperationalConclusion(clean),
    ].filter(Boolean).join("\n\n");
  }

  return summarizeOperationalText(clean, 6).join("\n").slice(0, 4000) || clean.slice(0, 4000);
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

function stripSpeechNoise(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:Speaker|Interlocutor|Persona)\s*\d+/gi, " ")
    .replace(/\b(?:Speaker|Interlocutor|Persona)\s*\d+\b/gi, " ")
    .replace(/\b(?:vale|venga|mira|bueno|eh|ehm|mmm|porfi|por favor|hijo|luisillo|hasta ahora|muchas gracias|adios|gracias)\b[,. ]*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function polishSentence(value) {
  let text = stripSpeechNoise(value)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,.;:])([^\s])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^[,.;:\-\s]+/, "").replace(/\s+$/, "");
  if (!text) return "";
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!/[.!?]$/.test(text)) text += ".";
  return text;
}

function splitOperationalSentences(text) {
  const clean = String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:Speaker|Interlocutor|Persona)\s*\d+/gi, "\n")
    .replace(/\b(?:Resumen ejecutivo|Puntos clave|Decisiones \/ acuerdos|Decisiones|Acuerdos|Tareas con responsables y plazos|Riesgos \/ dudas abiertas|Pr[oó]ximos pasos)\b\s*/gi, "\n")
    .replace(/[\u2022•]/g, "\n- ");
  const parts = clean
    .split(/\n+|(?<=[.!?])\s+|;\s+|\s+-\s+/)
    .flatMap((part) => part.length > 260 ? part.split(/\s+(?:pero|entonces|por lo que|ademas|tambien|se confirma que|se solicita que)\s+/i) : [part])
    .map(polishSentence)
    .filter((part) => part.length >= 18 && !/^Speaker\s+\d/i.test(part));
  const seen = new Set();
  return parts.filter((part) => {
    const key = normalizeText(part).slice(0, 120);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeOperationalText(text, limit = 5) {
  const priority = [
    "pendiente", "solicita", "confirma", "acuerda", "revis", "presupuesto", "incidencia",
    "obstru", "atasc", "raiz", "riesgo", "document", "factura", "proveedor", "presidente",
    "ejecut", "instal", "repar", "modific", "deuda", "email", "correo"
  ];
  const sentences = splitOperationalSentences(text);
  return sentences
    .map((sentence, index) => {
      const normalized = normalizeText(sentence);
      const score = priority.reduce((total, token) => total + (normalized.includes(token) ? 2 : 0), 0) + Math.max(0, 4 - index);
      return { sentence, score, index };
    })
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
}

function inferOperationalConclusion(text) {
  const t = normalizeText(text);
  if (t.includes("bloque") || t.includes("riesgo") || t.includes("urgente") || t.includes("obstru") || t.includes("atasc")) {
    return "Situacion actual: requiere seguimiento operativo por posible riesgo o bloqueo.";
  }
  if (t.includes("presupuesto") || t.includes("pendiente de tercero") || t.includes("proveedor")) {
    return "Situacion actual: queda pendiente de respuesta o actuacion por parte de tercero/proveedor.";
  }
  if (t.includes("finaliz") || t.includes("terminad") || t.includes("resuelto")) {
    return "Situacion actual: actuacion informada como finalizada, pendiente de validacion si procede.";
  }
  return "Situacion actual: informacion registrada para seguimiento.";
}

function extractExplicitNextSteps(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const match = source.match(/(?:pr[oó]ximos pasos?|siguiente paso|tareas con responsables y plazos)\s*:?\s*([\s\S]{0,1400})/i);
  if (!match) return [];
  return splitOperationalSentences(match[1]).slice(0, 4);
}

function professionalNextStep(text, fallback = "") {
  const explicit = extractExplicitNextSteps(text);
  if (explicit.length) return explicit.join(" ");
  const built = buildFormalNextStep(text, fallback);
  return polishSentence(built || fallback || "Revisar la informacion aportada y definir el siguiente paso operativo.");
}

function professionalizeText(kind, value, sourceText = "", context = {}) {
  const mode = String(kind || "").toLowerCase();
  const base = String(value || "").trim();
  const source = String(sourceText || "").trim();
  const input = base || source;
  if (mode === "comentario") {
    const contextItem = context.item || context.entity || null;
    return buildFormalComment(input || source, contextItem).slice(0, 8000);
  }
  if (mode === "proximo_paso") {
    return professionalNextStep(input || source, context.fallback || "").slice(0, 2000);
  }
  if (mode === "titulo") {
    return polishTitle(input || extractIssueTitle(source)).slice(0, 140);
  }
  if (mode === "email") {
    return normalizeEmailSummaryText(input || source).slice(0, 12000);
  }
  return splitOperationalSentences(input || source).join("\n").slice(0, 8000) || input.slice(0, 8000);
}

function shouldPolishProposalText(value, sourceText) {
  const text = String(value || "");
  const source = String(sourceText || "");
  if (!text.trim()) return true;
  if (/\bSpeaker\s*\d+\b|\d{1,2}:\d{2}(?::\d{2})?/.test(text)) return true;
  if (text.includes(source.trim().slice(0, Math.min(120, source.trim().length))) && source.length > 160) return true;
  if (/\b(?:mira|vale|venga|porfi|luisillo|hijo|adios)\b/i.test(text)) return true;
  if (text.length > 700 && !/Hechos relevantes|Situacion actual|Se registra|Se recibe|Se informa/i.test(text)) return true;
  return false;
}

function polishAiProposal(proposal, sourceText) {
  if (!proposal?.payload || !AI_ACTIONS_REQUIRING_CONFIRMATION.has(proposal.action)) return proposal;
  const payload = { ...proposal.payload };
  const contextItem = proposal.entity?.title ? { title: proposal.entity.title } : null;
  if (shouldPolishProposalText(payload.comentario, sourceText)) {
    payload.comentario = professionalizeText("comentario", payload.comentario, sourceText, { item: contextItem });
  } else {
    payload.comentario = professionalizeText("comentario", payload.comentario, sourceText, { item: contextItem }) || payload.comentario;
  }
  if (shouldPolishProposalText(payload.proximo_paso, sourceText)) {
    payload.proximo_paso = professionalizeText("proximo_paso", payload.proximo_paso, sourceText, { fallback: payload.proximo_paso });
  } else {
    payload.proximo_paso = professionalizeText("proximo_paso", payload.proximo_paso, sourceText, { fallback: payload.proximo_paso });
  }
  if (["crear_tarea", "crear_proyecto"].includes(proposal.action) && shouldPolishProposalText(payload.titulo, sourceText)) {
    payload.titulo = professionalizeText("titulo", payload.titulo, sourceText);
  }
  return {
    ...proposal,
    payload,
    redaction_note: "Comentario y proximo paso normalizados para registro operativo.",
  };
}

function polishTitle(value) {
  const clean = polishSentence(value).replace(/[.!?]$/, "");
  return clean.length > 120 ? clean.slice(0, 117).trim() + "..." : clean;
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

const AI_ACTIONS_REQUIRING_CONFIRMATION = new Set([
  "seguimiento_tarea",
  "seguimiento_proyecto",
  "crear_tarea",
  "crear_proyecto",
]);

const AI_EDITABLE_FIELDS = {
  seguimiento_tarea: [
    "entity",
    "tipo_registro",
    "comentario",
    "estado_nuevo",
    "prioridad_nueva",
    "responsable_nuevo",
    "responsable_proximo_paso",
    "fecha_objetivo_proximo_paso",
    "fecha_proxima_revision",
    "proximo_paso",
    "motivo_bloqueo",
  ],
  seguimiento_proyecto: [
    "entity",
    "tipo_registro",
    "comentario",
    "estado_nuevo",
    "prioridad_nueva",
    "responsable_nuevo",
    "responsable_proximo_paso",
    "fecha_objetivo_proximo_paso",
    "fecha_proxima_revision",
    "proximo_paso",
    "motivo_bloqueo",
  ],
  crear_tarea: [
    "id_proyecto",
    "titulo",
    "categoria",
    "comentario",
    "estado_nuevo",
    "prioridad_nueva",
    "responsable_nuevo",
    "responsable_proximo_paso",
    "fecha_objetivo_proximo_paso",
    "fecha_proxima_revision",
    "proximo_paso",
    "motivo_bloqueo",
  ],
  crear_proyecto: [
    "titulo",
    "categoria",
    "comentario",
    "estado_nuevo",
    "prioridad_nueva",
    "responsable_nuevo",
    "responsable_proximo_paso",
    "fecha_objetivo_proximo_paso",
    "fecha_proxima_revision",
    "proximo_paso",
    "motivo_bloqueo",
  ],
};

function aiWriteEndpointForAction(action) {
  if (action === "seguimiento_tarea" || action === "seguimiento_proyecto") return "/api/entity/record";
  if (action === "crear_tarea" || action === "crear_proyecto") return "/api/entity/create";
  return "";
}

function aiImpactSummary(result, action) {
  const payload = result?.payload || {};
  const entity = result?.entity || {};
  const title = payload.titulo || entity.title || "";
  const targetLabel = entity.type === "task" ? "tarea" : entity.type === "project" ? "proyecto" : "elemento";
  if (action === "seguimiento_tarea" || action === "seguimiento_proyecto") {
    return {
      title: `Anadir seguimiento a ${targetLabel}${title ? `: ${title}` : ""}`,
      lines: [
        payload.estado_nuevo ? `Estado propuesto: ${payload.estado_nuevo}` : "",
        payload.responsable_nuevo ? `Responsable actual propuesto: ${payload.responsable_nuevo}` : "",
        payload.responsable_proximo_paso ? `Proximo responsable propuesto: ${payload.responsable_proximo_paso}` : "",
        payload.proximo_paso ? `Proximo paso propuesto: ${payload.proximo_paso}` : "",
      ].filter(Boolean),
    };
  }
  if (action === "crear_tarea" || action === "crear_proyecto") {
    return {
      title: `Crear ${action === "crear_tarea" ? "tarea" : "proyecto"}${title ? `: ${title}` : ""}`,
      lines: [
        payload.categoria ? `Categoria: ${payload.categoria}` : "",
        payload.estado_nuevo ? `Estado inicial: ${payload.estado_nuevo}` : "",
        payload.responsable_nuevo ? `Responsable inicial: ${payload.responsable_nuevo}` : "",
        payload.proximo_paso ? `Proximo paso: ${payload.proximo_paso}` : "",
      ].filter(Boolean),
    };
  }
  return null;
}

function aiValue(value) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function aiBeforeAfterRows(result, action) {
  const payload = result?.payload || {};
  const entity = result?.entity || {};
  if (action === "seguimiento_tarea" || action === "seguimiento_proyecto") {
    const current = result?.current_snapshot || {};
    const rows = [
      ["Estado", current.estado, payload.estado_nuevo],
      ["Prioridad", current.prioridad, payload.prioridad_nueva],
      ["Responsable actual", current.responsable, payload.responsable_nuevo],
      ["Responsable proximo paso", current.responsable_proximo_paso, payload.responsable_proximo_paso],
      ["Fecha proximo paso", current.fecha_objetivo_proximo_paso, payload.fecha_objetivo_proximo_paso],
      ["Proximo paso", current.proximo_paso, payload.proximo_paso],
    ];
    return {
      mode: "update",
      title: entity.title || current.titulo || "Elemento seleccionado",
      rows: rows.map(([field, before, after]) => ({ field, before: aiValue(before), after: aiValue(after) })),
    };
  }
  if (action === "crear_tarea" || action === "crear_proyecto") {
    const rows = [
      ["Titulo", "", payload.titulo],
      ["Categoria", "", payload.categoria],
      ["Estado", "", payload.estado_nuevo || payload.estado],
      ["Prioridad", "", payload.prioridad_nueva || payload.prioridad],
      ["Responsable actual", "", payload.responsable_nuevo || payload.responsable],
      ["Responsable proximo paso", "", payload.responsable_proximo_paso],
      ["Fecha proximo paso", "", payload.fecha_objetivo_proximo_paso || payload.fecha_proxima_revision],
      ["Proximo paso", "", payload.proximo_paso],
    ];
    return {
      mode: "create",
      title: payload.titulo || "Nuevo elemento",
      rows: rows.map(([field, before, after]) => ({ field, before: aiValue(before), after: aiValue(after) })),
    };
  }
  return null;
}

function withAiProposalContract(result) {
  const action = String(result?.action || "revisar_manual");
  const requiresConfirmation = AI_ACTIONS_REQUIRING_CONFIRMATION.has(action);
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const firstScore = Number(candidates[0]?.score || 0);
  const secondScore = Number(candidates[1]?.score || 0);
  const needsEntityConfirmation = requiresConfirmation
    && candidates.length > 1
    && firstScore > 0
    && (firstScore - secondScore <= 2 || !result?.entity?.id);
  if (requiresConfirmation) {
    return {
      ...result,
      proposal_contract: "editable_confirmation_v1",
      requires_confirmation: true,
      writes_data: false,
      audit_required: true,
      needs_entity_confirmation: needsEntityConfirmation,
      entity_confirmation_message: needsEntityConfirmation
        ? "Hay varios destinos posibles. Selecciona expresamente la tarea o proyecto correcto antes de guardar."
        : "",
      allowed_write_endpoint: aiWriteEndpointForAction(action),
      editable_fields: AI_EDITABLE_FIELDS[action] || [],
      impact_summary: aiImpactSummary(result, action),
      before_after_preview: aiBeforeAfterRows(result, action),
      confirmation_required_message: "Nada se ha guardado todavia. Revisa y edita la propuesta antes de aplicarla.",
    };
  }
  return {
    ...result,
    proposal_contract: action === "consulta" ? "query_v1" : "manual_review_v1",
    requires_confirmation: false,
    writes_data: false,
    audit_required: false,
    allowed_write_endpoint: "",
    editable_fields: [],
  };
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
  const shortText = String(text || "").length <= 320;
  const debtQuery = /\b(deuda|morosidad|saldo pendiente|importe pendiente|recibos? pendientes?)\b|^\s*(cuanto|cuando|que cantidad|que importe|importe|saldo)?\s*(debe|adeuda)\s+\S+/i.test(text);
  const queryish = shortText
    && (/[?¿]|\b(cual|cuanto|cuando|quien|dime|consulta|estado de|busca|listado)\b/i.test(text) || debtQuery);
  const projectMatches = (context.projects || []).map((item) => ({ ...item, kind: "project", score: scoreTextMatch(text, item.titulo) })).sort((a, b) => b.score - a.score);
  const taskMatches = (context.tasks || []).map((item) => ({ ...item, kind: "task", score: scoreTextMatch(text, item.titulo) })).sort((a, b) => b.score - a.score);
  const best = [...projectMatches.slice(0, 3), ...taskMatches.slice(0, 3)].sort((a, b) => b.score - a.score)[0];
  const operational = hasOperationalSignal(text);
  if (!queryish && !operational && (!best || best.score === 0)) {
    return outOfScopeProposal(text, projectMatches, taskMatches);
  }
  if (queryish) {
    const matches = [...projectMatches, ...taskMatches].filter((item) => item.score > 0).slice(0, 6);
    return {
      source: "local",
      confidence: matches.length ? 0.55 : 0.25,
      action: "consulta",
      query_domain: "trabajo",
      answer: matches.length
        ? "He encontrado posibles coincidencias:\n" + matches.map((m) => `- ${m.kind === "project" ? "Proyecto" : "Tarea"} ${m.id}: ${m.titulo} | Estado: ${m.estado || ""} | Responsable: ${m.responsable || ""}`).join("\n")
        : "No he encontrado una coincidencia clara en proyectos o tareas visibles.",
      data_status: matches.length ? "confirmado" : "incompleto",
      sources: [
        { module: "proyectos", table: "proyectos", description: "Catalogo de proyectos visible segun permisos" },
        { module: "tareas", table: "tareas", description: "Catalogo de tareas visible segun permisos" },
      ],
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
      current_snapshot: {
        titulo: best.titulo || "",
        categoria: best.categoria || "",
        estado: best.estado || "",
        prioridad: best.prioridad || "",
        responsable: best.responsable || "",
        responsable_proximo_paso: best.responsable_proximo_paso || "",
        fecha_objetivo_proximo_paso: best.fecha_objetivo_proximo_paso || "",
        proximo_paso: best.proximo_paso || "",
        comunidad: best.comunidad || "",
      },
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

function cleanImportText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replaceAll("\u00a0", " ")
    .replace(/[\u2000-\u200b\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

async function extractImportDocument(fileName, bytes) {
  const name = safeUploadName(fileName);
  const extension = path.extname(name).toLowerCase();
  if (!bytes?.length) throw new Error("El documento esta vacio.");
  if (bytes.length > 12 * 1024 * 1024) throw new Error("El documento supera el limite de 12 MB.");
  if ([".txt", ".md"].includes(extension)) {
    return { name, text: cleanImportText(bytes.toString("utf8")), format: extension.slice(1) };
  }
  if (extension === ".docx") {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { name, text: cleanImportText(result.value), format: "docx", warnings: (result.messages || []).map(message => message.message).filter(Boolean) };
  }
  throw new Error("Formato no compatible. Usa DOCX, TXT o MD.");
}

const IMPORT_FIELD_LABELS = new Map([
  ["tipo de entrada", "entry_type"], ["tipo", "entry_type"],
  ["elemento relacionado", "related"], ["proyecto o tarea relacionada", "related"],
  ["titulo propuesto", "title"], ["titulo", "title"],
  ["categoria", "category"], ["estado sugerido", "state"], ["estado", "state"],
  ["prioridad sugerida", "priority"], ["prioridad", "priority"],
  ["responsable actual", "owner"], ["responsable", "owner"],
  ["responsable proximo paso", "next_owner"], ["proximo responsable", "next_owner"],
  ["comentario actualizacion", "comment"], ["comentario o actualizacion", "comment"], ["comentario", "comment"], ["actualizacion", "comment"],
  ["proximo paso", "next_step"], ["fecha objetivo", "target_date"],
  ["anexos mencionados", "attachments"], ["justificacion", "justification"]
]);

function splitStructuredImport(text) {
  const source = cleanImportText(text);
  const matches = [...source.matchAll(/^\s*ELEMENTO\s+\d+\s*$/gim)];
  if (!matches.length) return [];
  return matches.slice(0, 20).map((match, index) => source.slice(match.index, matches[index + 1]?.index ?? source.length).trim());
}

function parseStructuredImportBlock(block) {
  const fields = {};
  let current = "";
  for (const rawLine of String(block || "").split("\n")) {
    const line = rawLine.trim().replace(/^[-*#]+\s*/, "");
    if (!line || /^elemento\s+\d+$/i.test(line)) continue;
    const separator = line.indexOf(":");
    const label = normalizeText(separator >= 0 ? line.slice(0, separator) : line);
    const key = IMPORT_FIELD_LABELS.get(label);
    if (key) {
      current = key;
      fields[key] = separator >= 0 ? line.slice(separator + 1).trim() : "";
    } else if (current) {
      fields[current] = [fields[current], line].filter(Boolean).join("\n");
    }
  }
  return fields;
}

function importEntityMatches(text, context, kind) {
  const rows = kind === "task" ? (context.tasks || []) : (context.projects || []);
  const wanted = normalizeText(text);
  return rows.map(item => {
    const exact = wanted && normalizeText(item.titulo) === wanted;
    return { ...item, type: kind, score: exact ? 100 : scoreTextMatch(text, item.titulo) };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
}

function normalizedImportAction(entryType) {
  const value = normalizeText(entryType);
  if (value.includes("seguimiento") && value.includes("tarea")) return "seguimiento_tarea";
  if ((value.includes("seguimiento") || value.includes("actualizacion")) && value.includes("proyecto")) return "seguimiento_proyecto";
  if (value.includes("nueva") && value.includes("tarea")) return "crear_tarea";
  if (value.includes("nuevo") && value.includes("proyecto")) return "crear_proyecto";
  if (value.includes("tarea")) return "crear_tarea";
  if (value.includes("proyecto")) return "crear_proyecto";
  return "revisar_manual";
}

function normalizeImportState(kind, value, fallback) {
  let state = String(value || fallback || "").trim();
  if (kind === "task") {
    state = state.replace(/^Bloqueado$/i, "Bloqueada").replace(/^Finalizado$/i, "Terminada").replace(/^Archivado$/i, "Archivada");
  } else {
    state = state.replace(/^Bloqueada$/i, "Bloqueado").replace(/^Terminada$/i, "Finalizado").replace(/^Archivada$/i, "Archivado");
  }
  return state || fallback;
}

function structuredImportProposal(block, context, index) {
  const fields = parseStructuredImportBlock(block);
  let action = normalizedImportAction(fields.entry_type);
  const wanted = fields.related || fields.title || "";
  const wantedKind = action.includes("tarea") ? "task" : "project";
  const matches = importEntityMatches(wanted, context, wantedKind);
  const best = matches[0];
  if (action === "seguimiento_tarea" && (!best || best.score < 2)) action = "crear_tarea";
  if (action === "seguimiento_proyecto" && (!best || best.score < 2)) action = "crear_proyecto";
  const kind = action.includes("tarea") ? "task" : "project";
  const fallbackState = kind === "task" ? "Pendiente" : "En curso";
  const commentParts = [fields.comment, fields.attachments && `Anexos mencionados:\n${fields.attachments}`].filter(Boolean);
  return polishAiProposal({
    client_id: index + 1,
    selected: action !== "revisar_manual",
    action,
    confidence: best ? (best.score === 100 ? 0.98 : Math.min(0.9, 0.35 + best.score / 10)) : 0.45,
    entity: action.startsWith("seguimiento") && best ? { type: kind, id: best.id, title: best.titulo } : null,
    candidates: matches.map(item => ({ type: kind, id: item.id, title: item.titulo, score: item.score })),
    payload: {
      titulo: fields.title || fields.related || `Elemento importado ${index + 1}`,
      categoria: fields.category || "Otro",
      tipo_registro: detectRecordType(fields.comment || block),
      comentario: cleanImportText(commentParts.join("\n\n") || block).slice(0, 8000),
      estado_nuevo: normalizeImportState(kind, detectState(fields.state || fields.comment || "", fallbackState), fallbackState),
      prioridad_nueva: detectPriority(fields.priority || fields.comment || "", "Media"),
      responsable_nuevo: fields.owner || "Luis Gallardo",
      responsable_proximo_paso: fields.next_owner || fields.owner || "Luis Gallardo",
      fecha_objetivo_proximo_paso: normalizeImportDate(fields.target_date),
      fecha_proxima_revision: normalizeImportDate(fields.target_date),
      proximo_paso: fields.next_step || extractNextStep(fields.comment || "") || "Revisar la actuación propuesta.",
      motivo_bloqueo: normalizeText(fields.state).includes("bloque") ? (fields.justification || fields.comment || "") : ""
    },
    original: block
  }, block);
}

function detectRecordType(text) {
  const value = normalizeText(text);
  if (value.includes("reunion") || value.includes("acta")) return "Reunión";
  if (value.includes("llamada") || value.includes("telefono")) return "Llamada";
  if (value.includes("correo") || value.includes("email")) return "Email";
  if (value.includes("presupuesto") || value.includes("oferta")) return "Presupuesto";
  if (value.includes("decision") || value.includes("acuerda") || value.includes("aprueba")) return "Decisión";
  if (value.includes("incidencia") || value.includes("bloque") || value.includes("problema")) return "Incidencia";
  return "Seguimiento";
}

function normalizeImportDate(value) {
  const text = String(value || "").trim();
  let match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }
  match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : "";
}

function historicalImportProposal(text) {
  const source = cleanImportText(text);
  const title = source.match(/^(?:T[IÍ]TULO|PROYECTO|TAREA)\s*:\s*(.+)$/im)?.[1]?.trim() || source.split("\n").find(line => line.trim())?.replace(/^#+\s*/, "").slice(0, 140) || "Elemento histórico";
  const typeLabel = source.match(/^TIPO\s*:\s*(.+)$/im)?.[1] || "Proyecto";
  const kind = normalizeText(typeLabel).includes("tarea") ? "task" : "project";
  const category = source.match(/^CATEGOR[IÍ]A\s*:\s*(.+)$/im)?.[1]?.trim() || "Otro";
  const priority = detectPriority(source.match(/^PRIORIDAD\s*:\s*(.+)$/im)?.[1] || source, "Media");
  const owner = source.match(/^RESPONSABLE\s*:\s*(.+)$/im)?.[1]?.trim() || "Luis Gallardo";
  const datePattern = /(?:actualizaci[oó]n|seguimiento|reuni[oó]n|llamada|entrada|fecha)?(?:\s+de\s+seguimiento)?(?:\s+del|\s+de)?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})/gim;
  const matches = [...source.matchAll(datePattern)].slice(0, 40);
  const records = matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    const comment = cleanImportText(source.slice((match.index || 0) + match[0].length, end).replace(/^[\s:\-]+/, ""));
    const formalComment = buildFormalComment(comment || source).slice(0, 8000);
    return {
      fecha: normalizeImportDate(match[1]),
      tipo_registro: detectRecordType(`${match[0]} ${comment}`),
      comentario: formalComment || "Actuacion historica pendiente de completar.",
      estado_nuevo: normalizeImportState(kind, detectState(comment, kind === "task" ? "Pendiente" : "En curso"), kind === "task" ? "Pendiente" : "En curso"),
      prioridad_nueva: detectPriority(comment, priority),
      responsable_nuevo: owner,
      responsable_proximo_paso: owner,
      proximo_paso: professionalNextStep(comment, "Revisar la siguiente actuacion.")
    };
  }).filter(record => record.comentario);
  if (!records.length) records.push({ fecha: new Date().toISOString().slice(0, 10), tipo_registro: detectRecordType(source), comentario: buildFormalComment(source).slice(0, 8000), estado_nuevo: kind === "task" ? "Pendiente" : "En curso", prioridad_nueva: priority, responsable_nuevo: owner, responsable_proximo_paso: owner, proximo_paso: professionalNextStep(source, "Revisar la siguiente actuacion.") });
  const last = records.at(-1);
  return polishAiProposal({
    client_id: 1, selected: true, action: kind === "task" ? "crear_tarea" : "crear_proyecto", confidence: 0.8,
    entity: null, candidates: [], historical: true, records,
    payload: {
      titulo: title, categoria: category, tipo_registro: "Creación", comentario: records[0].comentario,
      estado_nuevo: last.estado_nuevo, prioridad_nueva: priority, responsable_nuevo: owner,
      responsable_proximo_paso: last.responsable_proximo_paso, fecha_objetivo_proximo_paso: "",
      fecha_proxima_revision: "", proximo_paso: last.proximo_paso, motivo_bloqueo: "", descripcion: source.slice(0, 8000)
    }, original: source
  }, source);
}

async function analyzeImportBatch(session, text, mode = "updates") {
  if (!["Superusuario", "Administrador", "Usuario"].includes(session?.rol)) throw new Error("Tu perfil no puede importar información.");
  const source = cleanImportText(text);
  if (source.length < 12) throw new Error("El texto es demasiado corto para analizarlo.");
  if (source.length > 120000) throw new Error("El texto supera el limite de 120.000 caracteres.");
  const context = await queryAiContext(session);
  if (mode === "historical") return { mode, source: "local", proposals: [historicalImportProposal(source)] };
  const blocks = splitStructuredImport(source);
  const proposals = blocks.length
    ? blocks.map((block, index) => structuredImportProposal(block, context, index))
    : [{ ...localAiProposal(source, context), client_id: 1, selected: true, original: source }];
  return { mode, source: "local", structured: Boolean(blocks.length), proposals };
}

function writeHistoricalRecords(session, type, id, records, pc) {
  const script = `
import json
import sqlite3
from datetime import datetime, timedelta
path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
entity_type = ${JSON.stringify(type)}
entity_id = int(${JSON.stringify(id)})
records = json.loads(${JSON.stringify(JSON.stringify(records || []))})
user = str(session.get("nombre") or "web")
role = str(session.get("rol") or "")
pc = ${JSON.stringify(pc || "web")}
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
table = "tareas" if entity_type == "task" else "proyectos"
id_column = "id_tarea" if entity_type == "task" else "id_proyecto"
item = conn.execute(f"SELECT * FROM {table} WHERE {id_column}=?", (entity_id,)).fetchone()
if not item: raise ValueError("El elemento historico no existe.")
if role != "Superusuario" and int(item["id_comunidad"] or 0) not in allowed_ids: raise PermissionError("Comunidad no permitida.")

def timestamp(value, index):
    text = str(value or "").strip()[:10]
    try: day = datetime.strptime(text, "%Y-%m-%d")
    except ValueError: day = datetime.now()
    return (day + timedelta(minutes=index)).strftime("%Y-%m-%d %H:%M:%S")

valid = [r for r in records[:50] if str(r.get("comentario") or "").strip()]
if not valid: raise ValueError("No hay seguimientos historicos validos.")
first_ts = timestamp(valid[0].get("fecha"), 0)
last = valid[-1]
with conn:
    if entity_type == "task":
        conn.execute("UPDATE registros SET fecha_hora=?, comentario=? WHERE id_registro=(SELECT id_registro FROM registros WHERE id_tarea=? AND tipo_registro='Creación' ORDER BY id_registro DESC LIMIT 1)",
                     (first_ts, "Ficha incorporada mediante importacion historica revisada.", entity_id))
        for index, row in enumerate(valid, 1):
            conn.execute("""INSERT INTO registros
                (id_tarea,id_proyecto,fecha_hora,tipo_registro,comentario,estado_nuevo,prioridad_nueva,responsable_nuevo,proximo_paso,fecha_proxima_revision,motivo_bloqueo,usuario,pc,id_comunidad,responsable_proximo_paso,fecha_objetivo_proximo_paso)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (entity_id,item["id_proyecto"],timestamp(row.get("fecha"),index),str(row.get("tipo_registro") or "Seguimiento"),str(row.get("comentario") or ""),str(row.get("estado_nuevo") or "Pendiente"),str(row.get("prioridad_nueva") or "Media"),str(row.get("responsable_nuevo") or user),str(row.get("proximo_paso") or ""),str(row.get("fecha") or ""),str(row.get("motivo_bloqueo") or ""),user,pc,item["id_comunidad"],str(row.get("responsable_proximo_paso") or row.get("responsable_nuevo") or user),str(row.get("fecha_objetivo_proximo_paso") or "")))
        conn.execute("""UPDATE tareas SET estado=?,prioridad=?,responsable=?,responsable_proximo_paso=?,proximo_paso=?,fecha_ultima_actualizacion=?,usuario_ultima_actualizacion=?,pc_ultima_actualizacion=? WHERE id_tarea=?""",
                     (str(last.get("estado_nuevo") or "Pendiente"),str(last.get("prioridad_nueva") or "Media"),str(last.get("responsable_nuevo") or user),str(last.get("responsable_proximo_paso") or last.get("responsable_nuevo") or user),str(last.get("proximo_paso") or ""),timestamp(last.get("fecha"),len(valid)),user,pc,entity_id))
    else:
        conn.execute("UPDATE registros_proyectos SET fecha_hora=?, comentario=? WHERE id_registro_proyecto=(SELECT id_registro_proyecto FROM registros_proyectos WHERE id_proyecto=? AND tipo_registro='Creación' ORDER BY id_registro_proyecto DESC LIMIT 1)",
                     (first_ts, "Ficha incorporada mediante importacion historica revisada.", entity_id))
        for index, row in enumerate(valid, 1):
            state = str(row.get("estado_nuevo") or "En curso").replace("Bloqueada","Bloqueado").replace("Terminada","Finalizado")
            conn.execute("""INSERT INTO registros_proyectos
                (id_proyecto,fecha_hora,tipo_registro,comentario,estado_nuevo,prioridad_nueva,responsable_nuevo,proximo_paso,fecha_proxima_revision,motivo_bloqueo,usuario,pc,id_comunidad,responsable_proximo_paso,fecha_objetivo_proximo_paso)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (entity_id,timestamp(row.get("fecha"),index),str(row.get("tipo_registro") or "Seguimiento"),str(row.get("comentario") or ""),state,str(row.get("prioridad_nueva") or "Media"),str(row.get("responsable_nuevo") or user),str(row.get("proximo_paso") or ""),str(row.get("fecha") or ""),str(row.get("motivo_bloqueo") or ""),user,pc,item["id_comunidad"],str(row.get("responsable_proximo_paso") or row.get("responsable_nuevo") or user),str(row.get("fecha_objetivo_proximo_paso") or "")))
        final_state = str(last.get("estado_nuevo") or "En curso").replace("Bloqueada","Bloqueado").replace("Terminada","Finalizado")
        conn.execute("""UPDATE proyectos SET estado_general=?,prioridad=?,responsable_principal=?,responsable_proximo_paso=?,observaciones=?,fecha_ultima_actualizacion=?,usuario_ultima_actualizacion=?,pc_ultima_actualizacion=? WHERE id_proyecto=?""",
                     (final_state,str(last.get("prioridad_nueva") or "Media"),str(last.get("responsable_nuevo") or user),str(last.get("responsable_proximo_paso") or last.get("responsable_nuevo") or user),str(last.get("proximo_paso") or ""),timestamp(last.get("fecha"),len(valid)),user,pc,entity_id))
    conn.execute("INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)",
                 (datetime.now().strftime("%Y-%m-%d %H:%M:%S"),user,pc,"Importar historico web",entity_type,entity_id,f"{len(valid)} seguimientos historicos"))
conn.close()
print(json.dumps({"ok":True,"records":len(valid)},ensure_ascii=False))
`;
  return runPythonJson(script);
}

function saveImportTrace(session, sourceName, sourceText, communityId, proposals, results, pc) {
  const script = `
import json,sqlite3
from datetime import datetime
path=${JSON.stringify(databasePath)}
session=${JSON.stringify(session || {})}
name=${JSON.stringify(String(sourceName || "Texto pegado").slice(0, 180))}
text=${JSON.stringify(String(sourceText || "").slice(0, 120000))}
community_id=int(${JSON.stringify(Number(communityId) || 0)}) or None
proposals=json.loads(${JSON.stringify(JSON.stringify(proposals || []))})
results=json.loads(${JSON.stringify(JSON.stringify(results || []))})
user=str(session.get("nombre") or "web"); pc=${JSON.stringify(pc || "web")}
now=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
conn=sqlite3.connect(path)
with conn:
    cur=conn.execute("""INSERT INTO documentos_importados
        (nombre_archivo,ruta_archivo,tipo_archivo,fecha_importacion,fecha_documento,asunto_documento,texto_extraido,proyecto_sugerido,observaciones,usuario,pc,id_comunidad)
        VALUES (?,'','texto_web',?,'',?,?,?, ?,?,?,?)""",
        (name,now,name,text,"",json.dumps({"origen":"web","resultados":results},ensure_ascii=False),user,pc,community_id))
    document_id=int(cur.lastrowid)
    for index,item in enumerate(proposals):
        payload=item.get("payload") or {}; entity=item.get("entity") or {}; result=results[index] if index < len(results) else {}
        conn.execute("""INSERT INTO detecciones_documento
            (id_documento,texto_original,texto_validado,tipo_detectado,accion_elegida,id_proyecto_asociado,id_tarea_asociada,titulo_propuesto,comentario,estado_propuesto,prioridad_propuesta,responsable_propuesto,proximo_paso,fecha_proxima_revision,motivo_bloqueo,categoria_propuesta,puntuacion_coincidencia,validado,descartado,fecha_validacion,id_tarea_creada,id_proyecto_creado,id_comunidad)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (document_id,str(item.get("original") or ""),str(item.get("original") or ""),str(payload.get("tipo_registro") or "Seguimiento"),str(item.get("action") or ""),entity.get("id") if entity.get("type")=="project" else None,entity.get("id") if entity.get("type")=="task" else None,str(payload.get("titulo") or ""),str(payload.get("comentario") or ""),str(payload.get("estado_nuevo") or ""),str(payload.get("prioridad_nueva") or ""),str(payload.get("responsable_nuevo") or ""),str(payload.get("proximo_paso") or ""),str(payload.get("fecha_proxima_revision") or ""),str(payload.get("motivo_bloqueo") or ""),str(payload.get("categoria") or ""),str(round(float(item.get("confidence") or 0)*100)),1 if item.get("selected",True) else 0,0 if item.get("selected",True) else 1,now,result.get("id") if result.get("type")=="task" and result.get("created") else None,result.get("id") if result.get("type")=="project" and result.get("created") else None,community_id))
    conn.execute("INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)",(now,user,pc,"Aplicar importacion web","documento_importado",document_id,f"{len(results)} operaciones"))
conn.close()
print(json.dumps({"ok":True,"document_id":document_id},ensure_ascii=False))
`;
  return runPythonJson(script);
}

async function applyImportBatch(session, body, pc) {
  if (!["Superusuario", "Administrador", "Usuario"].includes(session?.rol)) throw new Error("Tu perfil no puede aplicar importaciones.");
  const proposals = Array.isArray(body?.proposals) ? body.proposals.slice(0, 25) : [];
  const selected = proposals.filter(item => item?.selected !== false && item?.action !== "descartar");
  if (!selected.length) throw new Error("No hay propuestas seleccionadas para guardar.");
  const communityId = Number(body.id_comunidad || 0);
  if (!communityId) throw new Error("Selecciona la comunidad de la importacion.");
  if (!allowedCommunity(session, communityId)) throw new Error("No tienes permiso para esa comunidad.");
  for (const item of selected) {
    const action = String(item.action || "");
    if (!["seguimiento_tarea", "seguimiento_proyecto", "crear_tarea", "crear_proyecto"].includes(action)) {
      throw new Error(`Revisa la accion de la propuesta ${item.client_id || ""}.`);
    }
    if (action.startsWith("seguimiento")) {
      const type = action === "seguimiento_tarea" ? "task" : "project";
      const id = Number(item.entity?.id || item.entity_id || 0);
      if (!id) throw new Error(`Falta seleccionar el elemento de la propuesta ${item.client_id || ""}.`);
      const detail = await queryEntityDetail(session, type, id);
      if (!detail?.item || detail.error) throw new Error(`No se puede acceder al elemento de la propuesta ${item.client_id || ""}.`);
      if (Number(detail.item.id_comunidad || 0) !== communityId) throw new Error(`La propuesta ${item.client_id || ""} pertenece a otra comunidad.`);
    } else {
      const payload = item.payload || {};
      if (!String(payload.titulo || "").trim()) throw new Error(`Falta el titulo de la propuesta ${item.client_id || ""}.`);
      if (action === "crear_tarea" && payload.id_proyecto) {
        const detail = await queryEntityDetail(session, "project", Number(payload.id_proyecto));
        if (!detail?.item || Number(detail.item.id_comunidad || 0) !== communityId) throw new Error(`El proyecto contenedor de la propuesta ${item.client_id || ""} no pertenece a la comunidad seleccionada.`);
      }
    }
  }
  const results = [];
  for (const item of selected) {
    const action = String(item.action || "");
    const payload = { ...(item.payload || {}), id_comunidad: communityId };
    let result;
    if (["seguimiento_tarea", "seguimiento_proyecto"].includes(action)) {
      const type = action === "seguimiento_tarea" ? "task" : "project";
      const id = Number(item.entity?.id || item.entity_id || 0);
      if (!id) throw new Error(`Falta seleccionar el elemento de la propuesta ${item.client_id || ""}.`);
      result = await writeEntityRecord(session, type, id, payload, pc);
      results.push({ ...result, created: false });
    } else if (["crear_tarea", "crear_proyecto"].includes(action)) {
      const type = action === "crear_tarea" ? "task" : "project";
      if (!String(payload.titulo || "").trim()) throw new Error(`Falta el titulo de la propuesta ${item.client_id || ""}.`);
      result = await createEntity(session, type, payload, pc);
      if (item.historical && Array.isArray(item.records)) await writeHistoricalRecords(session, type, result.id, item.records, pc);
      results.push({ ...result, created: true });
    } else {
      throw new Error(`Revisa la accion de la propuesta ${item.client_id || ""}.`);
    }
  }
  const trace = await saveImportTrace(session, body.source_name || "Importacion web", body.source_text || "", communityId, selected, results, pc);
  return { ok: true, applied: results.length, results, document_id: trace.document_id };
}

function cleanAiJson(content) {
  const text = String(content || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
  return JSON.parse(text);
}

function aiExternalAvailable() {
  return Boolean(aiApiKey && aiProvider !== "local");
}

function aiExternalLabel() {
  return aiExternalAvailable() ? aiProvider : "local";
}

function aiChatCompletionsUrl() {
  return `${aiBaseUrl.replace(/\/$/, "")}/chat/completions`;
}

async function callExternalAiJson({ system, user, purpose = "general", temperature = 0.1, maxTokens = 4096, timeoutMs = 150000 }) {
  if (!aiExternalAvailable()) throw new Error("IA externa no configurada.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(aiChatCompletionsUrl(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${aiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: aiModel,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
  } catch (error) {
    const reason = error?.name === "AbortError" ? `tiempo agotado en ${purpose}` : error.message;
    throw new Error(`IA externa no disponible: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 500);
    } catch {}
    throw new Error(`IA externa no disponible (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  const data = await response.json();
  const parsed = cleanAiJson(data.choices?.[0]?.message?.content || "{}");
  parsed.source = aiProvider;
  parsed.ai_model = aiModel;
  parsed.ai_purpose = purpose;
  return parsed;
}

async function externalAiProposal(text, context) {
  if (!aiExternalAvailable()) return null;
  const catalog = {
    projects: (context.projects || []).slice(0, 80),
    tasks: (context.tasks || []).slice(0, 100),
  };
  const system = [
    "Eres el clasificador operativo de una aplicacion de gestion de comunidades.",
    "Devuelve solo JSON valido.",
    "Nunca ordenes guardar directamente. Solo propones.",
    "Si el texto procede de una reunion larga, analiza solo el asunto recibido en ese bloque, no toda la reunion.",
    "En reuniones largas prefiere siempre seguimiento de tarea/proyecto existente frente a crear algo nuevo si hay coincidencia razonable.",
    "Si no hay destino claro, usa revisar_manual y explica que queda pendiente de aclarar/no importar.",
    "Solo marca tipo_registro Decision si hay acuerdo o decision explicita del presidente o de los asistentes.",
    "Si no se deduce responsable, usa Administracion como proximo responsable.",
    "No copies transcripciones literalmente en comentario ni proximo_paso.",
    "Redacta comentario como registro administrativo claro: hechos relevantes, decisiones o riesgos, y situacion actual.",
    "Redacta proximo_paso como accion concreta, breve, con responsable/plazo si se deduce.",
    "Acciones permitidas: fuera_de_alcance, consulta, seguimiento_proyecto, seguimiento_tarea, crear_proyecto, crear_tarea, revisar_manual.",
    "Si dudas entre varias entidades, usa revisar_manual y rellena candidates.",
    "Usa ids existentes solo si la coincidencia es clara.",
    "Formato: {action, confidence, answer, entity:{type,id,title}, candidates:[{type,id,title,score}], payload:{tipo_registro,comentario,estado_nuevo,prioridad_nueva,responsable_nuevo,responsable_proximo_paso,fecha_objetivo_proximo_paso,fecha_proxima_revision,proximo_paso,motivo_bloqueo,titulo,categoria,id_proyecto}}"
  ].join("\\n");
  return callExternalAiJson({
    system,
    purpose: "operational_proposal",
    maxTokens: 5000,
    user: `Catalogo visible:\n${JSON.stringify(catalog)}\n\nTexto recibido:\n${text}`,
  });
}

async function externalRefineOperationalProposal(proposal, sourceText, context = {}) {
  if (!aiExternalAvailable() || !proposal?.payload || !AI_ACTIONS_REQUIRING_CONFIRMATION.has(proposal.action)) return proposal;
  const safeProposal = {
    action: proposal.action,
    entity: proposal.entity || null,
    current_snapshot: proposal.current_snapshot || {},
    candidates: (proposal.candidates || []).slice(0, 6),
    payload: proposal.payload || {},
  };
  const system = [
    "Eres el redactor operativo experto de una aplicacion de gestion de comunidades.",
    "Devuelve solo JSON valido.",
    "No cambies la accion ni el destino seleccionado. No inventes datos, fechas, importes, acuerdos ni responsables.",
    "Tu tarea es mejorar la calidad administrativa de comentario, proximo paso y titulo si procede.",
    "El comentario debe ser formal, claro, ordenado y util para un expediente.",
    "El proximo paso debe ser una accion concreta, sin repetir historico ni transcripcion.",
    "Si el texto contiene una transcripcion o dictado informal, conviertelo en registro profesional.",
    "Si hay dudas, mantenlas como riesgo o aclaracion dentro del comentario, no las conviertas en hechos.",
    "Formato exacto: {payload:{titulo,categoria,tipo_registro,comentario,estado_nuevo,prioridad_nueva,responsable_nuevo,responsable_proximo_paso,fecha_objetivo_proximo_paso,fecha_proxima_revision,proximo_paso,motivo_bloqueo},notes:[string]}",
  ].join("\n");
  try {
    const parsed = await callExternalAiJson({
      system,
      purpose: "operational_redaction",
      maxTokens: 5000,
      user: `Propuesta interna revisable:\n${JSON.stringify(safeProposal)}\n\nCatalogo resumido visible:\n${JSON.stringify({ projects: (context.projects || []).slice(0, 40), tasks: (context.tasks || []).slice(0, 50) })}\n\nTexto original:\n${String(sourceText || "").slice(0, 20000)}`,
    });
    const incoming = parsed.payload || {};
    const allowed = new Set([
      "titulo", "categoria", "tipo_registro", "comentario", "estado_nuevo", "prioridad_nueva",
      "responsable_nuevo", "responsable_proximo_paso", "fecha_objetivo_proximo_paso",
      "fecha_proxima_revision", "proximo_paso", "motivo_bloqueo",
    ]);
    const payload = { ...(proposal.payload || {}) };
    for (const [key, value] of Object.entries(incoming)) {
      if (!allowed.has(key)) continue;
      const clean = String(value ?? "").trim();
      if (clean) payload[key] = clean;
    }
    return {
      ...proposal,
      payload,
      source: [proposal.source, parsed.source].filter(Boolean).join("+"),
      ai_model: parsed.ai_model,
      external_redaction: true,
      external_notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 5) : [],
    };
  } catch (error) {
    return {
      ...proposal,
      external_warning: `${error.message}. Se mantiene redaccion local.`,
    };
  }
}

async function externalMeetingAnalysis(text, context) {
  if (!aiExternalAvailable()) return null;
  const catalog = {
    projects: (context.projects || []).slice(0, 120).map((item) => ({
      type: "project", id: item.id, title: item.titulo, estado: item.estado, responsable: item.responsable, proximo_paso: item.proximo_paso || item.responsable_proximo_paso || "", comunidad: item.comunidad || "",
    })),
    tasks: (context.tasks || []).slice(0, 160).map((item) => ({
      type: "task", id: item.id, title: item.titulo, estado: item.estado, responsable: item.responsable, proximo_paso: item.proximo_paso || "", comunidad: item.comunidad || "",
    })),
  };
  const system = [
    "Eres un analista operativo experto de reuniones de administracion de comunidades.",
    "Devuelve solo JSON valido.",
    "Analiza la reunion completa y separa asuntos reales. No mezcles varios asuntos en una sola propuesta.",
    "Cada asunto debe ser una sola tarea/proyecto/seguimiento posible. Si corresponde a un elemento existente, indica su tipo, id y titulo.",
    "No crees tareas por crear. Si el asunto amplia un proyecto/tarea existente, usa seguimiento.",
    "Si no hay elemento claro pero el asunto es operativo, propon nuevo proyecto o nueva tarea solo si es defendible.",
    "Si no esta claro, marca revisar_manual.",
    "Las decisiones solo son decisiones si se expresan acuerdos claros; las opiniones o dudas son seguimiento.",
    "Cuando no se deduzca responsable, usa Administracion.",
    "Redacta como registro administrativo: categoria, estado sugerido, prioridad, responsables, comentario formal, puntos clave y proximo paso.",
    "Formato exacto: {meeting_contract:'meeting_analysis_v1',items:[{action,confidence,entity:{type,id,title},candidates:[{type,id,title,score}],titulo,categoria,estado_sugerido,prioridad,responsable_actual,responsable_proximo_paso,responsable_externo,tipo_registro,comentario,puntos_clave:[string],proximo_paso,fecha_objetivo,pendiente_aclarar,justificacion}]}",
  ].join("\n");
  return callExternalAiJson({
    system,
    purpose: "meeting_analysis_v1",
    maxTokens: 14000,
    timeoutMs: 180000,
    user: `Catalogo visible de tareas y proyectos:\n${JSON.stringify(catalog)}\n\nTranscripcion o resumen de reunion:\n${String(text || "").slice(0, 220000)}`,
  });
}

function proposalFromMeetingItem(item, context, index) {
  const rawAction = String(item?.action || "").trim();
  const entityType = item?.entity?.type === "task" || item?.entity?.type === "project" ? item.entity.type : "";
  const requestedAction = ["seguimiento_tarea", "seguimiento_proyecto", "crear_tarea", "crear_proyecto", "revisar_manual"].includes(rawAction)
    ? rawAction
    : entityType === "task"
      ? "seguimiento_tarea"
      : entityType === "project"
        ? "seguimiento_proyecto"
        : normalizeText(item?.titulo || item?.comentario || "").includes("proyecto")
          ? "crear_proyecto"
          : "crear_tarea";
  let action = requestedAction;
  const kind = action.includes("tarea") ? "task" : "project";
  const candidates = Array.isArray(item?.candidates) ? item.candidates : [];
  let entity = item?.entity && item.entity.id ? { type: entityType || kind, id: Number(item.entity.id), title: item.entity.title || "" } : null;
  if (!entity && ["seguimiento_tarea", "seguimiento_proyecto"].includes(action)) {
    const sourceRows = kind === "task" ? (context.tasks || []) : (context.projects || []);
    const text = [item?.titulo, item?.comentario, item?.proximo_paso, item?.justificacion].filter(Boolean).join(" ");
    const best = sourceRows
      .map((row) => ({ type: kind, id: row.id, title: row.titulo, score: scoreTextMatch(text, row.titulo) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 2) entity = best;
  }
  if (["seguimiento_tarea", "seguimiento_proyecto"].includes(action) && !entity?.id) action = "revisar_manual";
  const points = Array.isArray(item?.puntos_clave) ? item.puntos_clave.map((line) => String(line || "").trim()).filter(Boolean).slice(0, 6) : [];
  const comment = [
    String(item?.comentario || "").trim(),
    points.length ? "Puntos clave:\n" + points.map((line) => `- ${line}`).join("\n") : "",
    String(item?.responsable_externo || "").trim() ? `Responsable externo/proveedor mencionado: ${String(item.responsable_externo).trim()}` : "",
    String(item?.justificacion || "").trim() ? `Criterio de interpretacion: ${String(item.justificacion).trim()}` : "",
  ].filter(Boolean).join("\n\n");
  const proposal = {
    client_id: index + 1,
    source: aiExternalLabel(),
    confidence: Math.max(0.2, Math.min(0.98, Number(item?.confidence || 0.72))),
    action,
    answer: action === "revisar_manual"
      ? "Asunto detectado por IA externa, pendiente de confirmar destino antes de guardar."
      : "Asunto detectado por IA externa y preparado como propuesta revisable.",
    entity,
    candidates: entity ? [entity, ...candidates.filter((candidate) => Number(candidate.id) !== Number(entity.id)).slice(0, 5)] : candidates.slice(0, 6),
    payload: {
      titulo: String(item?.titulo || entity?.title || `Asunto de reunion ${index + 1}`).slice(0, 160),
      categoria: String(item?.categoria || "Gestión").trim(),
      tipo_registro: String(item?.tipo_registro || "").trim() || (normalizeText(item?.comentario || "").includes("decide") ? "Decisión" : "Seguimiento"),
      comentario: comment || String(item?.titulo || "").trim(),
      estado_nuevo: String(item?.estado_sugerido || (kind === "task" ? "Pendiente" : "En curso")).trim(),
      prioridad_nueva: String(item?.prioridad || "Media").trim(),
      responsable_nuevo: String(item?.responsable_actual || item?.responsable_proximo_paso || "Administracion").trim(),
      responsable_proximo_paso: String(item?.responsable_proximo_paso || item?.responsable_actual || "Administracion").trim(),
      fecha_objetivo_proximo_paso: normalizeImportDate(item?.fecha_objetivo || ""),
      fecha_proxima_revision: normalizeImportDate(item?.fecha_objetivo || ""),
      proximo_paso: String(item?.proximo_paso || "Revisar el asunto y confirmar la siguiente actuacion.").trim(),
      motivo_bloqueo: normalizeText(item?.estado_sugerido || "").includes("bloque") ? String(item?.justificacion || "").trim() : "",
    },
    meeting_analysis: true,
    external_meeting_item: true,
    meeting_source_excerpt: String(item?.comentario || item?.titulo || "").slice(0, 1600),
    questions: item?.pendiente_aclarar ? ["Confirmar destino y alcance antes de guardar."] : [],
  };
  return withAiProposalContract(polishAiProposal(proposal, comment || item?.titulo || ""));
}

function fallbackAssemblyMinutes(detail) {
  const item = detail.assembly || {};
  return {
    introduccion_es: `En el lugar, fecha y hora indicados se constituye la asamblea ${item.nombre || ""}. La Presidencia declara abierta la sesion y se procede al examen del orden del dia.`,
    introduccion_en: `At the place, date and time stated, the meeting ${item.nombre || ""} is constituted. The President opens the session and the agenda is considered.`,
    cierre_es: "No habiendo mas asuntos que tratar, se levanta la sesion a la hora indicada, quedando el acta pendiente de revision y firma.",
    cierre_en: "There being no further business, the meeting is closed at the stated time, with the minutes pending review and signature.",
    puntos: (detail.points || []).map((point) => ({
      id_punto: Number(point.id_punto),
      debate_es: `Se examina el punto relativo a: ${point.titulo}. El contenido concreto debe revisarse con la transcripcion antes de cerrar el acta.`,
      acuerdo_es: `Resultado registrado por la aplicacion: ${point.result?.approved ? "APROBADO" : "NO APROBADO"}.`,
      debate_en: `The meeting considers the agenda item: ${point.titulo}. The specific content must be checked against the transcript before the minutes are closed.`,
      acuerdo_en: `Result recorded by the application: ${point.result?.approved ? "APPROVED" : "NOT APPROVED"}.`,
    })),
    advertencias: ["Borrador base creado sin IA externa. Revise la transcripcion y complete el desarrollo de cada punto."],
    source: "local",
  };
}

async function externalAssemblyMinutes(detail, minutes) {
  if (!aiExternalAvailable()) return fallbackAssemblyMinutes(detail);
  const item = detail.assembly || {};
  const points = (detail.points || []).map((point, index) => ({
    id_punto: Number(point.id_punto),
    numero: index + 1,
    titulo: point.titulo,
    resultado_registrado: point.result?.base_votes ? (point.result.approved ? "APROBADO" : "NO APROBADO") : "SIN VOTACION",
  }));
  const system = [
    "Eres un asistente de redaccion de actas de comunidades de propietarios en Espana.",
    "Devuelve exclusivamente JSON valido y bilingue espanol/ingles.",
    "Redacta de forma formal, objetiva, clara y concisa. Resume el debate; no transcribas literalmente.",
    "No inventes intervenciones, acuerdos, cifras, asistentes, votos, coeficientes ni fundamentos legales.",
    "Los resultados registrados son inalterables. Nunca recalcules ni contradigas APROBADO, NO APROBADO o SIN VOTACION.",
    "Distingue exposicion/debate de acuerdo. Si falta informacion, indicalo en advertencias.",
    "Estructura exacta: {introduccion_es,introduccion_en,cierre_es,cierre_en,puntos:[{id_punto,debate_es,acuerdo_es,debate_en,acuerdo_en}],advertencias:[string]}.",
  ].join("\n");
  const privateFreeContext = {
    asamblea: item.nombre,
    comunidad: item.comunidad,
    fecha: item.fecha,
    convocatoria: item.convocatoria,
    lugar: item.lugar_celebracion || item.ubicacion,
    puntos,
  };
  const parsed = await callExternalAiJson({
    system,
    purpose: "assembly_minutes",
    maxTokens: 12000,
    timeoutMs: 150000,
    user: `Datos generales y resultados bloqueados:\n${JSON.stringify(privateFreeContext)}\n\nTranscripcion para resumir:\n${String(minutes.transcripcion || "").slice(0, 400000)}`,
  });
  const validIds = new Set(points.map((point) => Number(point.id_punto)));
  parsed.puntos = Array.isArray(parsed.puntos) ? parsed.puntos.filter((point) => validIds.has(Number(point.id_punto))).map((point) => ({
    id_punto: Number(point.id_punto),
    debate_es: String(point.debate_es || "").trim(), acuerdo_es: String(point.acuerdo_es || "").trim(),
    debate_en: String(point.debate_en || "").trim(), acuerdo_en: String(point.acuerdo_en || "").trim(),
  })) : [];
  parsed.advertencias = Array.isArray(parsed.advertencias) ? parsed.advertencias.map((warning) => String(warning).slice(0, 1000)) : [];
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
session_user_id = ${JSON.stringify(Number(session?.id_usuario || 0))}
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

def fix_text(value):
    text = str(value or "")
    mojibake_codes = {0x00C3, 0x00C2, 0xFFFD, 0x00BE, 0x00BC, 0x00BD}
    if not any(ord(ch) in mojibake_codes for ch in text):
        return text
    candidates = [text]
    for encoding in ("latin1", "cp1252"):
        try:
            candidates.append(text.encode(encoding).decode("utf-8"))
        except Exception:
            pass
    replacements = {
        "¾": "ó",
        "¼": "ü",
        "½": "ñ",
        "Â": "",
        chr(0xFFFD): "",
    }
    replaced = text
    for old, new in replacements.items():
        replaced = replaced.replace(old, new)
    candidates.append(replaced)
    def penalty(candidate):
        return sum(1 for ch in candidate if ord(ch) in mojibake_codes)
    return min(candidates, key=lambda candidate: (penalty(candidate), len(candidate)))

def clean_value(value):
    if isinstance(value, str):
        return fix_text(value)
    if isinstance(value, list):
        return [clean_value(item) for item in value]
    if isinstance(value, dict):
        return {clean_value(key) if isinstance(key, str) else key: clean_value(item) for key, item in value.items()}
    return value

AI_SOURCES = {
    "owners": {"module": "propietarios", "table": "cf_propietarios", "description": "Propietarios activos importados"},
    "properties": {"module": "propiedades", "table": "cf_propiedades", "description": "Propiedades activas importadas"},
    "owner_properties": {"module": "propiedades", "table": "cf_propietario_propiedad", "description": "Relacion actual propietario-propiedad"},
    "contacts": {"module": "propietarios", "table": "cf_contactos_propietario", "description": "Contactos activos de propietarios"},
    "receipts": {"module": "contabilidad", "table": "cf_recibos", "description": "Recibos actualmente importados"},
    "debt_movements": {"module": "contabilidad", "table": "cf_movimientos_deuda", "description": "Movimientos de deuda y cobros importados"},
    "accounting_reports": {"module": "contabilidad", "table": "informes_contables", "description": "Ultimos informes contables calculados"},
    "expense_invoices": {"module": "contabilidad", "table": "cf_gastos_facturas", "description": "Gastos/facturas importados con fecha de alta y pago"},
    "bank_lines": {"module": "contabilidad", "table": "cf_extractos_banco_lineas", "description": "Lineas de extractos bancarios importadas"},
    "tasks": {"module": "tareas", "table": "tareas", "description": "Tareas visibles segun permisos"},
    "task_records": {"module": "tareas", "table": "registros", "description": "Seguimientos de tareas visibles segun permisos"},
    "projects": {"module": "proyectos", "table": "proyectos", "description": "Proyectos visibles segun permisos"},
    "project_records": {"module": "proyectos", "table": "registros_proyectos", "description": "Seguimientos de proyectos visibles segun permisos"},
    "assemblies": {"module": "asambleas", "table": "asambleas", "description": "Asambleas visibles segun permisos"},
    "assembly_points": {"module": "asambleas", "table": "asamblea_puntos", "description": "Puntos del orden del dia"},
    "assembly_attendance": {"module": "asambleas", "table": "asamblea_asistencia", "description": "Asistencia, representaciones y quorum"},
    "assembly_votes": {"module": "asambleas", "table": "asamblea_votos", "description": "Votos registrados por punto"},
    "security_incidents": {"module": "seguridad", "table": "seguridad_incidencias", "description": "Incidencias extraidas de partes de Seguridad"},
    "security_documents": {"module": "seguridad", "table": "seguridad_documentos", "description": "Partes de Seguridad importados"},
}

def source_refs(*keys):
    return [dict(AI_SOURCES[key]) for key in keys if key in AI_SOURCES]

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

def response(answer, confidence=0.75, candidates=None, questions=None, facts=None, display=None, sources=None, data_status=None, query_domain=None):
    status = data_status or ("incompleto" if questions else "confirmado")
    domain = query_domain or globals().get("query_domain", "general")
    source_list = sources or []
    freshness = economic_freshness(domain, source_list)
    if freshness:
        answer = str(answer or "").rstrip() + "\\n\\n" + freshness["summary"]
        display = dict(display or {})
        existing_note = str(display.get("note") or "").strip()
        display["note"] = (existing_note + "\\n\\n" if existing_note else "") + freshness["summary"]
        for source in source_list:
            matching = [item for item in freshness.get("details", []) if item.get("table") == source.get("table")]
            if matching:
                source["freshness"] = "; ".join(f"{item['label']}: {item['date_label']}" for item in matching)
    payload = {
        "handled": True,
        "source": "local-db",
        "confidence": confidence,
        "action": "consulta",
        "query_domain": domain,
        "answer": answer,
        "data_status": status,
        "sources": source_list,
        "candidates": candidates or [],
        "questions": questions or [],
        "facts": facts or {},
        "display": display or {},
    }
    if freshness:
        payload["freshness"] = freshness
    return clean_value(payload)

def community_scope(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1=0", []
    marks = ",".join("?" for _ in allowed_ids)
    return f" AND {alias}.id_comunidad IN ({marks})", allowed_ids

def table_exists(name):
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    return bool(row)

def table_columns(name):
    if not table_exists(name):
        return set()
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({name})").fetchall()}

def max_source_date(table, column, where=""):
    if column not in table_columns(table):
        return ""
    sql = f"SELECT MAX(date({column})) AS value FROM {table} WHERE COALESCE({column}, '') <> ''"
    if where:
        sql += " AND " + where
    row = first(sql)
    return str((row or {}).get("value") or "")

def human_date(value):
    value = str(value or "").strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(value[:19], fmt).strftime("%d/%m/%Y")
        except Exception:
            pass
    return value

def economic_freshness(query_domain, sources):
    economic_domains = {"deuda", "contabilidad", "presupuesto"}
    uses_accounting = any(str(source.get("module") or "") == "contabilidad" for source in (sources or []))
    if query_domain not in economic_domains and not uses_accounting:
        return None
    source_dates = {
        "cf_recibos": [
            ("Recibos Netfincas emitidos", max_source_date("cf_recibos", "fecha_emision")),
            ("Recibos Netfincas actualizados/importados", max_source_date("cf_recibos", "fecha_ultima_actualizacion") or max_source_date("cf_recibos", "fecha_creacion")),
        ],
        "cf_movimientos_deuda": [
            ("Cobros/movimientos de deuda Netfincas", max_source_date("cf_movimientos_deuda", "fecha")),
        ],
        "cf_gastos_facturas": [
            ("Gastos Netfincas por fecha de alta", max_source_date("cf_gastos_facturas", "fecha_alta")),
            ("Gastos Netfincas por fecha de pago", max_source_date("cf_gastos_facturas", "fecha_pago")),
            ("Gastos Netfincas actualizados/importados", max_source_date("cf_gastos_facturas", "fecha_ultima_actualizacion") or max_source_date("cf_gastos_facturas", "fecha_creacion")),
        ],
        "cf_extractos_banco_lineas": [
            ("Extractos bancarios importados", max_source_date("cf_extractos_banco_lineas", "fecha")),
        ],
        "informes_contables": [
            ("Informes contables calculados", max_source_date("informes_contables", "fecha_hasta")),
            ("Informes contables actualizados", max_source_date("informes_contables", "fecha_ultima_actualizacion") or max_source_date("informes_contables", "fecha_creacion")),
        ],
    }
    details = []
    for table, table_dates in source_dates.items():
        for label, value in table_dates:
            if value:
                details.append({"table": table, "label": label, "date": value, "date_label": human_date(value)})
    if not details:
        return {
            "applies": True,
            "data_until": "",
            "summary": "Aviso de vigencia: esta respuesta usa datos economicos importados, pero no hay una fecha de cobertura suficiente registrada en la base.",
            "details": [],
        }
    used_tables = {str(source.get("table") or "") for source in (sources or [])}
    scoped_details = [item for item in details if item["table"] in used_tables] or details
    scoped_latest = max(item["date"] for item in scoped_details if item.get("date"))
    global_latest = max(item["date"] for item in details if item.get("date"))
    return {
        "applies": True,
        "data_until": scoped_latest,
        "data_until_label": human_date(scoped_latest),
        "global_data_until": global_latest,
        "global_data_until_label": human_date(global_latest),
        "summary": f"Aviso de vigencia: la informacion economica disponible en la app llega hasta {human_date(scoped_latest)} segun las fuentes usadas. Comprueba si despues de esa fecha se han descargado nuevos documentos de Netfincas o banco.",
        "details": scoped_details,
        "detail_text": "; ".join(f"{item['label']}: {item['date_label']}" for item in scoped_details[:6]),
    }

def can_query_security():
    if role in ("Superusuario", "Seguridad"):
        return True
    if not session_user_id or not table_exists("usuario_permisos"):
        return False
    row = conn.execute("SELECT gestionar_seguridad FROM usuario_permisos WHERE id_usuario=?", (session_user_id,)).fetchone()
    return bool(row and row["gestionar_seguridad"])

def not_handled():
    return {"handled": False}

def detect_query_domain(email_query, is_budget_question, is_finance_question, is_debt_question, is_owner_question, is_work_question, is_assembly_question, is_security_question):
    if email_query:
        return "propietarios_contacto"
    if is_security_question:
        return "seguridad"
    if is_assembly_question:
        return "asambleas"
    if is_budget_question:
        return "presupuesto"
    if is_finance_question:
        return "contabilidad"
    if is_debt_question:
        return "deuda"
    if is_owner_question:
        return "propiedad"
    if is_work_question:
        return "trabajo"
    return "general"

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

def extract_email_query(value):
    match = re.search(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+[.][A-Z]{2,}", str(value or ""), re.I)
    return match.group(0).strip().lower() if match else ""

def rows(sql, params=()):
    return [dict(r) for r in conn.execute(sql, params)]

def first(sql, params=()):
    r = conn.execute(sql, params).fetchone()
    return dict(r) if r else None

def score_tokens(query, value):
    stop = {
        "A", "AL", "DE", "DEL", "EL", "LA", "LAS", "LOS", "QUE", "QUIEN", "CUAL", "CUANTO", "CUANDO",
        "CANTIDAD", "IMPORTE", "SALDO", "PERTENECE", "TIENE", "DEBE", "DEBEN", "ADEUDA", "ADEUDAN",
        "DEUDA", "MOROSIDAD", "PENDIENTE", "PENDIENTES", "RECIBO", "RECIBOS", "PROPIETARIO", "PROPIEDAD",
        "DEUDOR", "DEUDORES", "MOROSO", "MOROSOS", "LISTA", "LISTADO", "RELACION", "DETALLE", "DESGLOSE",
        "DAME", "MUESTRA", "SACA", "CON", "VIVIENDA", "GARAJE", "LOCAL", "ES", "EN", "POR", "PARA",
        "ACTUAL", "ACTUALMENTE", "HOY"
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
        r"(?:listado|lista|relacion|detalle|desglose)\\s+(?:de\\s+)?(?:los\\s+)?recibos?\\s+pendientes?\\s+de\\s+(.+)$",
        r"(?:listado|lista|relacion|detalle|desglose)\\s+(?:de\\s+)?(?:la\\s+)?deuda\\s+de\\s+(.+?)(?:\\s+de\\s+20\\d{2})?$",
        r"(?:cuanto|cuando|que\\s+cantidad|que\\s+importe|importe|saldo)\\s+(?:dinero\\s+)?(?:debe|adeuda)\\s+(.+)$",
        r"(?:debe|adeuda)\\s+(.+)$",
        r"recibos?\\s+pendientes?\\s+de\\s+(.+)$",
        r"(?:importe|saldo)\\s+pendiente\\s+de\\s+(.+)$",
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
    m = re.search(r"\\b(?:ATERRAZADA|MANSION|UNIFAMILIAR)\\s+\\d+(?:\\s*[-/]\\s*\\d+)?\\b", text, re.I)
    if m:
        return m.group(0).strip()
    m = re.search(r"\\b((?:CB|17H|PLZ|P1F1|P1F2|PM|EG|ALB|FG|SRC|VILLA|LOCAL|L\\d+|ATERRAZADA|MANSION|UNIFAMILIAR)[A-Z0-9\\s\\-\\/\\.]*(?:DERECHA|DCHA|IZQUIERDA|IZQ|ATICO|AT|\\d)?)\\b", text, re.I)
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

def owners_for_email(email):
    return rows("""
        SELECT DISTINCT o.id_propietario, o.codigo_netfincas, o.nombre, o.nif,
               c.tipo, c.valor, c.principal
        FROM cf_contactos_propietario c
        JOIN cf_propietarios o ON o.id_propietario = c.id_propietario
        WHERE LOWER(TRIM(c.valor)) = LOWER(TRIM(?))
          AND COALESCE(c.activo, 1) = 1
          AND COALESCE(o.activo, 1) = 1
        ORDER BY COALESCE(c.principal, 0) DESC, o.nombre
    """, (email,))

def properties_for_owner(owner_id):
    return rows("""
        SELECT p.id_propiedad, p.codigo_propiedad, p.zona, p.subzona, p.coeficiente
        FROM cf_propietario_propiedad pp
        JOIN cf_propiedades p ON p.id_propiedad = pp.id_propiedad
        WHERE pp.id_propietario = ?
          AND COALESCE(pp.activo, 1) = 1
          AND COALESCE(p.activa, 1) = 1
        ORDER BY p.codigo_propiedad
    """, (owner_id,))

def debt_conditions(owner=None, year=None, property_id=None):
    clauses = ["COALESCE(r.deuda,0) > 0"]
    params = []
    if owner:
        owner_id = owner.get("id_propietario") if isinstance(owner, dict) else owner
        owner_name = owner.get("nombre") if isinstance(owner, dict) else ""
        owner_name_norm = norm(owner_name)
        if owner_name_norm:
            clauses.append("(r.id_propietario = ? AND (COALESCE(TRIM(r.propietario_texto),'') = '' OR NORMTXT(r.propietario_texto) = ?))")
            params.extend([owner_id, owner_name_norm])
        else:
            clauses.append("r.id_propietario = ?")
            params.append(owner_id)
    if year:
        clauses.append("COALESCE(r.ejercicio, CAST(substr(r.fecha_emision,1,4) AS INTEGER)) = ?")
        params.append(year)
    if property_id:
        clauses.append("r.id_propiedad = ?")
        params.append(property_id)
    return " AND ".join(clauses), tuple(params)

def debt_for_owner(owner_id, year=None, property_id=None):
    owner = owner_id if isinstance(owner_id, dict) else {"id_propietario": owner_id, "nombre": ""}
    where_sql, params = debt_conditions(owner, year, property_id)
    total = first("SELECT COALESCE(SUM(r.deuda),0) AS total FROM cf_recibos r WHERE " + where_sql, params)["total"]
    by_year = rows("""
        SELECT COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER)) AS ejercicio,
               COALESCE(SUM(deuda),0) AS deuda,
               COUNT(*) AS recibos
        FROM cf_recibos r
        WHERE """ + where_sql + """
        GROUP BY COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER))
        ORDER BY ejercicio
    """, params)
    by_property = rows("""
        SELECT COALESCE(p.codigo_propiedad, r.propiedad_texto, 'Sin propiedad') AS propiedad,
               COALESCE(SUM(r.deuda),0) AS deuda,
               COUNT(*) AS recibos
        FROM cf_recibos r
        LEFT JOIN cf_propiedades p ON p.id_propiedad = r.id_propiedad
        WHERE """ + where_sql + """
        GROUP BY COALESCE(p.codigo_propiedad, r.propiedad_texto, 'Sin propiedad')
        ORDER BY deuda DESC
    """, params)
    receipts = rows("""
        SELECT COALESCE(r.referencia, '') AS referencia,
               COALESCE(r.fecha_emision, '') AS fecha_emision,
               COALESCE(r.ejercicio, CAST(substr(r.fecha_emision,1,4) AS INTEGER)) AS ejercicio,
               COALESCE(p.codigo_propiedad, r.propiedad_texto, 'Sin propiedad') AS propiedad,
               COALESCE(r.tipo_recibo, '') AS tipo_recibo,
               COALESCE(r.importe, 0) AS importe,
               COALESCE(r.cobrado, 0) AS cobrado,
               COALESCE(r.deuda, 0) AS deuda,
               COALESCE(r.estado, '') AS estado
        FROM cf_recibos r
        LEFT JOIN cf_propiedades p ON p.id_propiedad = r.id_propiedad
        WHERE """ + where_sql + """
        ORDER BY r.fecha_emision, propiedad, r.referencia
        LIMIT 250
    """, params)
    return total, by_year, by_property, receipts

def debt_for_property(property_id, year=None):
    where_sql, params = debt_conditions(None, year, property_id)
    total = first("SELECT COALESCE(SUM(r.deuda),0) AS total FROM cf_recibos r WHERE " + where_sql, params)["total"]
    by_year = rows("""
        SELECT COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER)) AS ejercicio,
               COALESCE(SUM(deuda),0) AS deuda,
               COUNT(*) AS recibos
        FROM cf_recibos r
        WHERE """ + where_sql + """
        GROUP BY COALESCE(ejercicio, CAST(substr(fecha_emision,1,4) AS INTEGER))
        ORDER BY ejercicio
    """, params)
    by_debtor = rows("""
        SELECT COALESCE(NULLIF(TRIM(r.propietario_texto), ''), o.nombre, 'Sin propietario') AS propietario,
               COALESCE(SUM(r.deuda),0) AS deuda,
               COUNT(*) AS recibos
        FROM cf_recibos r
        LEFT JOIN cf_propietarios o ON o.id_propietario = r.id_propietario
        WHERE """ + where_sql + """
        GROUP BY NORMTXT(COALESCE(NULLIF(TRIM(r.propietario_texto), ''), o.nombre, 'Sin propietario')),
                 COALESCE(NULLIF(TRIM(r.propietario_texto), ''), o.nombre, 'Sin propietario')
        ORDER BY deuda DESC, propietario
    """, params)
    receipts = rows("""
        SELECT COALESCE(r.referencia, '') AS referencia,
               COALESCE(r.fecha_emision, '') AS fecha_emision,
               COALESCE(r.ejercicio, CAST(substr(r.fecha_emision,1,4) AS INTEGER)) AS ejercicio,
               COALESCE(r.propietario_texto, '') AS propietario,
               COALESCE(r.tipo_recibo, '') AS tipo_recibo,
               COALESCE(r.importe, 0) AS importe,
               COALESCE(r.cobrado, 0) AS cobrado,
               COALESCE(r.deuda, 0) AS deuda,
               COALESCE(r.estado, '') AS estado
        FROM cf_recibos r
        WHERE """ + where_sql + """
        ORDER BY r.fecha_emision, r.referencia
        LIMIT 250
    """, params)
    return total, by_year, by_debtor, receipts

def other_property_debt_for_owner(owner, year=None):
    owner_norm = norm(owner.get("nombre") or "")
    if not owner_norm:
        return []
    property_rows = properties_for_owner(owner["id_propietario"])
    property_ids = [int(row["id_propiedad"]) for row in property_rows if row.get("id_propiedad")]
    if not property_ids:
        return []
    qmarks = ",".join("?" for _ in property_ids)
    clauses = [
        "COALESCE(r.deuda,0) > 0",
        f"r.id_propiedad IN ({qmarks})",
        "COALESCE(TRIM(r.propietario_texto),'') <> ''",
        "NORMTXT(r.propietario_texto) <> ?",
    ]
    params = property_ids + [owner_norm]
    if year:
        clauses.append("COALESCE(r.ejercicio, CAST(substr(r.fecha_emision,1,4) AS INTEGER)) = ?")
        params.append(year)
    where_sql = " AND ".join(clauses)
    return rows("""
        SELECT COALESCE(NULLIF(TRIM(r.propietario_texto), ''), 'Sin propietario') AS propietario,
               COALESCE(p.codigo_propiedad, r.propiedad_texto, 'Sin propiedad') AS propiedad,
               COALESCE(SUM(r.deuda),0) AS deuda,
               COUNT(*) AS recibos
        FROM cf_recibos r
        LEFT JOIN cf_propiedades p ON p.id_propiedad = r.id_propiedad
        WHERE """ + where_sql + """
        GROUP BY NORMTXT(COALESCE(NULLIF(TRIM(r.propietario_texto), ''), 'Sin propietario')),
                 COALESCE(NULLIF(TRIM(r.propietario_texto), ''), 'Sin propietario'),
                 COALESCE(p.codigo_propiedad, r.propiedad_texto, 'Sin propiedad')
        ORDER BY deuda DESC, propietario
    """, tuple(params))

def debtor_listing(year=None, minimum=0):
    where_sql, params = debt_conditions(None, year, None)
    listing = rows("""
        SELECT COALESCE(NULLIF(TRIM(r.propietario_texto), ''), o.nombre, 'Sin propietario') AS propietario,
               COALESCE(o.codigo_netfincas, '') AS codigo,
               COUNT(DISTINCT COALESCE(CAST(r.id_propiedad AS TEXT), r.propiedad_texto, '')) AS propiedades,
               COUNT(*) AS recibos,
               COALESCE(SUM(r.deuda),0) AS deuda
        FROM cf_recibos r
        LEFT JOIN cf_propietarios o ON o.id_propietario = r.id_propietario
        WHERE """ + where_sql + """
        GROUP BY NORMTXT(COALESCE(NULLIF(TRIM(r.propietario_texto), ''), o.nombre, 'Sin propietario')),
                 COALESCE(NULLIF(TRIM(r.propietario_texto), ''), o.nombre, 'Sin propietario'),
                 COALESCE(o.codigo_netfincas, '')
        ORDER BY deuda DESC, propietario
    """, params)
    return [item for item in listing if float(item.get("deuda") or 0) >= float(minimum or 0)]

def handle_contact_query(email):
    owners = owners_for_email(email)
    if not owners:
        answer = f"No he encontrado ningun propietario activo vinculado al correo {email}."
        display = {
            "title": "Correo sin coincidencias",
            "subtitle": email,
            "note": "La busqueda se ha realizado por coincidencia exacta entre los contactos activos de propietarios.",
        }
        return response(answer, 0.92, facts={"email": email, "propietarios": 0}, display=display, sources=source_refs("contacts", "owners"), data_status="confirmado", query_domain="propietarios_contacto")
    owner_rows = []
    all_properties = []
    for owner in owners:
        properties = properties_for_owner(owner["id_propietario"])
        property_codes = [p["codigo_propiedad"] for p in properties]
        owner_rows.append({
            "Propietario": owner["nombre"],
            "Codigo Netfincas": owner.get("codigo_netfincas") or "",
            "Propiedades": ", ".join(property_codes) or "Sin propiedades activas",
        })
        all_properties.extend(properties)
    if len(owners) == 1:
        owner = owners[0]
        property_text = ", ".join(p["codigo_propiedad"] for p in all_properties) or "ninguna propiedad activa"
        answer = f"El correo {email} pertenece a {owner['nombre']} (codigo Netfincas {owner.get('codigo_netfincas') or 'sin codigo'}). Propiedades activas: {property_text}."
    else:
        answer = f"El correo {email} esta vinculado a {len(owners)} propietarios activos. Revisa el detalle mostrado."
    display = {
        "title": "Propietario por correo electronico" if len(owners) == 1 else "Propietarios vinculados al correo",
        "subtitle": email,
        "cards": [
            {"label": "Propietarios", "value": str(len(owners))},
            {"label": "Propiedades activas", "value": str(len(all_properties))},
            {"label": "Contacto principal", "value": "Si" if any(bool(o.get("principal")) for o in owners) else "No"},
        ],
        "tables": [{
            "title": "Coincidencias",
            "columns": ["Propietario", "Codigo Netfincas", "Propiedades"],
            "rows": owner_rows,
        }],
        "note": "Coincidencia exacta obtenida de los contactos activos importados.",
    }
    return response(answer, 0.98, facts={"email": email, "propietarios": len(owners), "propiedades": len(all_properties)}, display=display, sources=source_refs("contacts", "owners", "owner_properties", "properties"), data_status="confirmado", query_domain="propietarios_contacto")

def handle_security_query():
    if not table_exists("seguridad_incidencias") or not table_exists("seguridad_documentos"):
        return response("El modulo de Seguridad aun no tiene tablas inicializadas en esta base.", 0.45, questions=["Inicializar modulo Seguridad"], sources=source_refs("security_incidents", "security_documents"), data_status="incompleto", query_domain="seguridad")
    if not can_query_security():
        return response("Tu perfil no tiene permiso para consultar incidencias de Seguridad.", 0.99, sources=[], data_status="incompleto", query_domain="seguridad")
    pending_statuses = ("Pendiente de revision", "En revision")
    total_docs = first("SELECT COUNT(*) AS total, COALESCE(SUM(incidencias_detectadas),0) AS incidencias FROM seguridad_documentos")
    counts = rows("SELECT estado_revision AS estado, COUNT(*) AS total FROM seguridad_incidencias GROUP BY estado_revision ORDER BY total DESC")
    categories = rows("SELECT categoria_normalizada AS categoria, COUNT(*) AS total FROM seguridad_incidencias WHERE estado_revision<>'Descartada' GROUP BY categoria_normalizada ORDER BY total DESC LIMIT 10")
    incidents = rows("""
        SELECT id_incidencia,titulo,gravedad,estado_revision,zona,ubicacion,fecha_hora_suceso,categoria_normalizada
        FROM seguridad_incidencias
        WHERE estado_revision IN (?,?)
        ORDER BY CASE gravedad WHEN 'Critica' THEN 1 WHEN 'Alta' THEN 2 WHEN 'Media' THEN 3 ELSE 4 END,
                 COALESCE(fecha_hora_suceso,fecha_creacion) DESC
        LIMIT 20
    """, pending_statuses)
    pending = sum(int(row.get("total") or 0) for row in counts if row.get("estado") in pending_statuses)
    answer = f"Seguridad tiene {pending} incidencia(s) pendiente(s) o en revision. Hay {int(total_docs.get('total') or 0)} parte(s) importado(s) y {int(total_docs.get('incidencias') or 0)} incidencia(s) detectada(s) en documentos."
    display = {
        "title": "Resumen de Seguridad",
        "subtitle": "Incidencias pendientes y clasificacion",
        "cards": [
            {"label": "Pendientes / en revision", "value": str(pending)},
            {"label": "Partes importados", "value": str(int(total_docs.get("total") or 0))},
            {"label": "Incidencias detectadas", "value": str(int(total_docs.get("incidencias") or 0))},
            {"label": "Categorias con incidencias", "value": str(len(categories))},
        ],
        "tables": [
            {
                "title": "Estados de revision",
                "columns": ["Estado", "Total"],
                "rows": [{"Estado": row.get("estado") or "Sin estado", "Total": str(row.get("total") or 0)} for row in counts],
            },
            {
                "title": "Categorias",
                "columns": ["Categoria", "Total"],
                "rows": [{"Categoria": row.get("categoria") or "Otros", "Total": str(row.get("total") or 0)} for row in categories],
            },
            {
                "title": "Incidencias pendientes",
                "columns": ["ID", "Titulo", "Gravedad", "Estado", "Zona", "Ubicacion", "Fecha"],
                "rows": [{
                    "ID": str(row.get("id_incidencia") or ""),
                    "Titulo": row.get("titulo") or "",
                    "Gravedad": row.get("gravedad") or "",
                    "Estado": row.get("estado_revision") or "",
                    "Zona": row.get("zona") or "",
                    "Ubicacion": row.get("ubicacion") or "",
                    "Fecha": row.get("fecha_hora_suceso") or "",
                } for row in incidents],
            },
        ],
        "note": "Consulta de solo lectura. Para crear tareas o proyectos desde una incidencia hay que entrar al modulo Seguridad y confirmar la accion.",
    }
    return response(answer, 0.86, facts={"pendientes": pending, "partes": total_docs.get("total"), "incidencias_detectadas": total_docs.get("incidencias")}, display=display, sources=source_refs("security_incidents", "security_documents"), data_status="confirmado", query_domain="seguridad")

def handle_work_query():
    term = re.sub(r"(?i)\\b(como|va|van|estado|del|de|la|el|proyecto|tarea|quien|responsable|proximo|paso|lista|busca|pendientes?)\\b", " ", question)
    term = re.sub(r"[?¿]", " ", term).strip()
    like = "%" + norm(term).replace(" ", "%") + "%"
    project_scope, project_params = community_scope("p")
    task_scope, task_params = community_scope("t")
    project_matches = rows("""
        SELECT 'Proyecto' AS tipo, p.id_proyecto AS id, p.nombre AS titulo, p.estado_general AS estado,
               p.responsable_principal AS responsable, p.responsable_proximo_paso, p.fecha_objetivo_proximo_paso,
               p.fecha_ultima_actualizacion, COALESCE(p.observaciones,'') AS contexto
        FROM proyectos p
        WHERE COALESCE(p.activo,1)=1 AND (? = '%%' OR UPPER(p.nombre) LIKE ? OR UPPER(COALESCE(p.descripcion,'')) LIKE ?)
    """ + project_scope + " ORDER BY fecha_ultima_actualizacion DESC LIMIT 6", tuple([like, like, like] + project_params))
    task_matches = rows("""
        SELECT 'Tarea' AS tipo, t.id_tarea AS id, t.titulo, t.estado,
               t.responsable, t.responsable_proximo_paso, t.fecha_objetivo_proximo_paso,
               t.fecha_ultima_actualizacion, COALESCE(t.proximo_paso,'') AS contexto
        FROM tareas t
        WHERE COALESCE(t.activa,1)=1 AND COALESCE(t.archivada,0)=0 AND (? = '%%' OR UPPER(t.titulo) LIKE ? OR UPPER(COALESCE(t.descripcion,'')) LIKE ?)
    """ + task_scope + " ORDER BY fecha_ultima_actualizacion DESC LIMIT 6", tuple([like, like, like] + task_params))
    matches = project_matches + task_matches
    if matches:
        answer = "He encontrado estos elementos operativos:\\n" + "\\n".join([f"- {m['tipo']} {m['id']}: {m['titulo']} | Estado: {m['estado'] or 'sin estado'} | Responsable: {m['responsable'] or 'sin responsable'} | Proximo: {m['responsable_proximo_paso'] or 'sin dato'} | Paso: {(m['contexto'] or 'sin proximo paso')[:220]}" for m in matches[:8]])
        return response(answer, 0.72, candidates=[{"type":"project" if m["tipo"]=="Proyecto" else "task","id":m["id"],"title":m["titulo"],"score":1} for m in matches[:8]], sources=source_refs("projects", "tasks", "project_records", "task_records"), data_status="confirmado", query_domain="trabajo")
    return response("No he encontrado tareas o proyectos con esa referencia. Dame alguna palabra clave del titulo o responsable.", 0.45, questions=["Referencia de tarea/proyecto"], sources=source_refs("projects", "tasks"), data_status="incompleto", query_domain="trabajo")

def handle_assembly_query():
    required = ["asambleas", "asamblea_puntos", "asamblea_asistencia", "asamblea_votos"]
    if not all(table_exists(name) for name in required):
        return response("El modulo de Asambleas aun no tiene todas las tablas inicializadas en esta base.", 0.45, questions=["Inicializar modulo Asambleas"], sources=source_refs("assemblies", "assembly_points", "assembly_attendance", "assembly_votes"), data_status="incompleto", query_domain="asambleas")
    scope, params = community_scope("a")
    assembly = first("""
        SELECT a.*, COALESCE(c.nombre,'') AS comunidad,
               (SELECT COUNT(*) FROM asamblea_puntos p WHERE p.id_asamblea=a.id_asamblea AND p.activo=1) AS total_puntos,
               (SELECT COUNT(*) FROM asamblea_asistencia s WHERE s.id_asamblea=a.id_asamblea) AS total_asistencia,
               (SELECT COUNT(*) FROM asamblea_proxys x WHERE x.id_asamblea=a.id_asamblea AND COALESCE(x.estado,'')<>'Eliminado') AS total_proxys
        FROM asambleas a
        LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
        WHERE 1=1
    """ + scope + " ORDER BY COALESCE(a.fecha,'') DESC,a.id_asamblea DESC LIMIT 1", tuple(params))
    if not assembly:
        return response("No he encontrado asambleas visibles para tu usuario.", 0.5, questions=["Asamblea o comunidad"], sources=source_refs("assemblies"), data_status="incompleto", query_domain="asambleas")
    assembly_id = int(assembly["id_asamblea"])
    point_match = re.search(r"\\bPUNTO\\s+(\\d+)\\b", q_norm)
    if point_match:
        point_order = int(point_match.group(1))
        point = first("SELECT * FROM asamblea_puntos WHERE id_asamblea=? AND activo=1 AND orden=?", (assembly_id, point_order))
        if not point:
            return response(f"La ultima asamblea visible no tiene punto {point_order}.", 0.55, questions=["Numero de punto correcto"], sources=source_refs("assemblies", "assembly_points"), data_status="incompleto", query_domain="asambleas")
        votes = rows("""
            SELECT voto, COUNT(*) AS votos
            FROM asamblea_votos
            WHERE id_asamblea=? AND id_punto=?
            GROUP BY voto
        """, (assembly_id, int(point["id_punto"])))
        vote_map = {str(row.get("voto") or "sin"): int(row.get("votos") or 0) for row in votes}
        answer = f"En la asamblea {assembly['nombre']}, el punto {point['orden']} es: {point['titulo']}. Votos registrados: si {vote_map.get('si',0)}, no {vote_map.get('no',0)}, abstencion {vote_map.get('abs',0)}, sin voto registrado {vote_map.get('sin',0)}."
        display = {
            "title": f"Punto {point['orden']} - {point['titulo']}",
            "subtitle": f"{assembly['nombre']} | {assembly['fecha'] or 'sin fecha'}",
            "cards": [
                {"label": "Tipo mayoria", "value": point.get("tipo_mayoria") or "simple"},
                {"label": "A favor", "value": str(vote_map.get("si", 0))},
                {"label": "En contra", "value": str(vote_map.get("no", 0))},
                {"label": "Abstenciones", "value": str(vote_map.get("abs", 0))},
            ],
            "tables": [{
                "title": "Resultado registrado",
                "columns": ["Voto", "Total"],
                "rows": [{"Voto": label, "Total": str(vote_map.get(key, 0))} for key, label in [("si", "A favor"), ("no", "En contra"), ("abs", "Abstencion"), ("sin", "Sin registrar")]],
            }],
            "note": "Resumen de votos registrados. Para validez formal debe revisarse con quorum, coeficientes y acta.",
        }
        return response(answer, 0.82, facts={"id_asamblea": assembly_id, "id_punto": point["id_punto"], "votos": vote_map}, display=display, sources=source_refs("assemblies", "assembly_points", "assembly_votes"), data_status="confirmado", query_domain="asambleas")
    attendance = rows("""
        SELECT tipo, COUNT(*) AS votos, COALESCE(SUM(CASE WHEN COALESCE(sin_voto,0)=0 THEN 1 ELSE 0 END),0) AS con_voto
        FROM asamblea_asistencia
        WHERE id_asamblea=?
        GROUP BY tipo
    """, (assembly_id,))
    points = rows("SELECT orden,titulo,tipo_mayoria FROM asamblea_puntos WHERE id_asamblea=? AND activo=1 ORDER BY orden,id_punto", (assembly_id,))
    without_vote = first("SELECT COUNT(*) AS total FROM asamblea_asistencia WHERE id_asamblea=? AND COALESCE(sin_voto,0)=1", (assembly_id,))
    total_attendance = sum(int(row.get("votos") or 0) for row in attendance)
    answer = f"La ultima asamblea visible es {assembly['nombre']} ({assembly['fecha'] or 'sin fecha'}), estado {assembly['estado'] or 'sin estado'}. Tiene {assembly['total_puntos']} punto(s), {total_attendance} asistente(s)/representado(s) y {assembly['total_proxys']} proxy(s) importado(s)."
    display = {
        "title": assembly["nombre"],
        "subtitle": f"{assembly['comunidad']} | {assembly['fecha'] or 'sin fecha'} | {assembly['estado'] or 'sin estado'}",
        "cards": [
            {"label": "Puntos", "value": str(assembly.get("total_puntos") or 0)},
            {"label": "Asistencia", "value": str(total_attendance)},
            {"label": "Proxys", "value": str(assembly.get("total_proxys") or 0)},
            {"label": "Sin derecho a voto", "value": str(without_vote.get("total") or 0)},
        ],
        "tables": [
            {
                "title": "Asistencia",
                "columns": ["Tipo", "Total", "Con derecho a voto"],
                "rows": [{"Tipo": row.get("tipo") or "Sin tipo", "Total": str(row.get("votos") or 0), "Con derecho a voto": str(row.get("con_voto") or 0)} for row in attendance],
            },
            {
                "title": "Orden del dia",
                "columns": ["Punto", "Titulo", "Mayoria"],
                "rows": [{"Punto": str(row.get("orden") or ""), "Titulo": row.get("titulo") or "", "Mayoria": row.get("tipo_mayoria") or ""} for row in points],
            },
        ],
        "note": "Consulta de la ultima asamblea visible para tu usuario. Indica un numero de punto para consultar sus votos registrados.",
    }
    return response(answer, 0.84, facts={"id_asamblea": assembly_id}, display=display, sources=source_refs("assemblies", "assembly_points", "assembly_attendance", "assembly_votes"), data_status="confirmado", query_domain="asambleas")

def handle_budget_query():
    report = first("SELECT titulo, fecha_desde, fecha_hasta, resultado_json FROM informes_contables WHERE resultado_json IS NOT NULL AND resultado_json <> '' ORDER BY fecha_ultima_actualizacion DESC, id_informe_contable DESC LIMIT 1")
    if not report:
        return response("No hay todavia un informe contable con presupuesto calculado. Necesito que generes o recalcules el informe economico para poder comparar presupuesto frente a real.", 0.55, sources=source_refs("accounting_reports"), data_status="incompleto", query_domain="presupuesto")
    data = json.loads(report["resultado_json"] or "{}")
    budget = data.get("presupuesto") or []
    if not budget:
        return response("El ultimo informe contable no contiene bloque de presupuesto calculado.", 0.55, sources=source_refs("accounting_reports"), data_status="incompleto", query_domain="presupuesto")
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
    return response(answer, 0.82, facts={"periodo": [report["fecha_desde"], report["fecha_hasta"]]}, display=display, sources=source_refs("accounting_reports"), data_status="confirmado", query_domain="presupuesto")

def handle_accounting_query():
    start, end = dates_from_question(question)
    if not start or not end:
        return response("Para preparar el balance financiero necesito que indiques fecha desde y fecha hasta. Ejemplo: balance financiero desde 01/01/2026 hasta 30/08/2026.", 0.5, questions=["Fecha desde", "Fecha hasta"], sources=source_refs("receipts", "debt_movements", "expense_invoices", "bank_lines"), data_status="incompleto", query_domain="contabilidad")
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
    return response(answer, 0.83, facts={"fecha_desde": start, "fecha_hasta": end}, display=display, sources=source_refs("receipts", "debt_movements", "expense_invoices", "bank_lines"), data_status="inferido", query_domain="contabilidad")

def handle_property_query():
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
        return response(answer, 0.88, facts={"id_propiedad": prop["id_propiedad"]}, sources=source_refs("properties", "owner_properties", "owners"), data_status="confirmado", query_domain="propiedad")
    if len(props) > 1:
        answer = "He encontrado varias propiedades posibles. Necesito que concretes cual es:\\n" + "\\n".join([f"- {p['codigo_propiedad']} ({p['zona']}, coef. {p['coeficiente']})" for p in props[:10]])
        return response(answer, 0.55, candidates=[{"type":"property","id":p["id_propiedad"],"title":p["codigo_propiedad"],"score":1} for p in props[:10]], questions=["Propiedad exacta"], sources=source_refs("properties"), data_status="incompleto", query_domain="propiedad")
    return response("No he encontrado esa propiedad. Prueba con el codigo exacto de Netfincas, por ejemplo CB 2 -1 DCH.", 0.45, questions=["Codigo de propiedad"], sources=source_refs("properties"), data_status="incompleto", query_domain="propiedad")

def handle_global_debt_year(year):
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
    return response(answer, 0.84, facts={"ejercicio": year, "deuda": total["total"]}, display=display, sources=source_refs("receipts"), data_status="confirmado", query_domain="deuda")

def handle_debt_query():
    years = re.findall(r"\\b(20\\d{2})\\b", question)
    requested_year = int(years[0]) if years else None
    minimum_debt = 0
    minimum_match = re.search(r"(?:mayor|superior|mas)\\s+(?:de|a)?\\s*([\\d\\.]+(?:,\\d{1,2})?)", str(question or ""), re.I)
    if minimum_match:
        try:
            minimum_debt = float(minimum_match.group(1).replace(".", "").replace(",", "."))
        except ValueError:
            minimum_debt = 0
    global_list_pattern = bool(re.search(
        r"(?:LISTA|LISTADO|RELACION|DETALLE|DESGLOSE).*(?:DEUDORES|MOROSOS|PROPIETARIOS (?:CON DEUDA|QUE DEBEN)|DEUDA POR PROPIETARIO|DEUDA DE TODOS|TODOS LOS QUE DEBEN)",
        q_norm
    )) or bool(re.match(r"^(?:DAME |MUESTRA |SACA )?(?:UN )?(?:LISTA|LISTADO|RELACION|DESGLOSE) DE (?:LA )?DEUDA(?: PENDIENTE)?(?: 20\\d{2})?$", q_norm))
    global_list_pattern = global_list_pattern or ("PROPIETARIOS" in q_norm and "DEUDA" in q_norm and any(token in q_norm for token in ["TIENEN", "CON", "SUPERIOR", "MAYOR", "MAS"]))
    asks_global_year = bool(years) and not any(token in q_norm for token in ["TIENE DEUDA", "DEUDA DE", "MOROSIDAD DE", "PROPIETARIO"])
    if asks_global_year and not is_list_request:
        return handle_global_debt_year(int(years[0]))
    owner_query = extract_owner_query(question)
    prop_query = extract_property_query(question)
    owners = []
    debt_property_id = None
    debt_property = None
    property_debt_mode = False
    if prop_query:
        props = find_properties(prop_query)
        if len(props) == 1:
            debt_property = props[0]
            debt_property_id = props[0]["id_propiedad"]
            if is_debt_question:
                property_debt_mode = True
            else:
                owners = owner_for_property(props[0]["id_propiedad"])
        elif len(props) > 1 and "PROPIETARIO" in q_norm:
            answer = "He encontrado varias propiedades posibles. Necesito que concretes cual es:\\n" + "\\n".join([f"- {p['codigo_propiedad']} ({p['zona']}, coef. {p['coeficiente']})" for p in props[:8]])
            return response(answer, 0.52, candidates=[{"type":"property","id":p["id_propiedad"],"title":p["codigo_propiedad"],"score":1} for p in props[:8]], questions=["Propiedad exacta"], sources=source_refs("properties"), data_status="incompleto", query_domain="deuda")
    if not owners and owner_query and is_debt_question:
        owners = find_owners(owner_query)
    if property_debt_mode and debt_property_id:
        total, by_year, by_debtor, receipts = debt_for_property(debt_property_id, requested_year)
        pending_receipts = sum(int(item.get("recibos") or 0) for item in by_year)
        period_text = f" en {requested_year}" if requested_year else ""
        property_name = debt_property["codigo_propiedad"] if debt_property else "la propiedad indicada"
        if total <= 0:
            answer = f"{property_name} no tiene deuda pendiente registrada{period_text}."
        else:
            year_text = ", ".join([f"{r['ejercicio']}: {money(r['deuda'])}" for r in by_year]) or "sin desglose"
            debtor_text = "\\n".join([f"- {r['propietario']}: {money(r['deuda'])} ({r['recibos']} recibos)" for r in by_debtor[:8]])
            answer = f"{property_name} tiene deuda pendiente total por {money(total)} en {pending_receipts} recibos.\\nDesglose por ejercicio: {year_text}.\\nDesglose por titular/deudor del recibo:\\n{debtor_text}"
        debt_tables = [
            {
                "title": "Desglose por ejercicio",
                "columns": ["Ejercicio", "Deuda", "Recibos"],
                "rows": [{"Ejercicio": str(r["ejercicio"]), "Deuda": money(r["deuda"]), "Recibos": str(r["recibos"])} for r in by_year],
            },
            {
                "title": "Desglose por titular/deudor",
                "columns": ["Titular/deudor", "Deuda", "Recibos"],
                "rows": [{"Titular/deudor": r["propietario"], "Deuda": money(r["deuda"]), "Recibos": str(r["recibos"])} for r in by_debtor],
            },
        ]
        if is_list_request:
            debt_tables.append({
                "title": "Relacion de recibos pendientes",
                "columns": ["Referencia", "Fecha", "Ejercicio", "Titular/deudor", "Tipo", "Importe", "Cobrado", "Pendiente", "Estado"],
                "rows": [{
                    "Referencia": r.get("referencia") or "",
                    "Fecha": r.get("fecha_emision") or "",
                    "Ejercicio": str(r.get("ejercicio") or ""),
                    "Titular/deudor": r.get("propietario") or "",
                    "Tipo": r.get("tipo_recibo") or "",
                    "Importe": money(r.get("importe")),
                    "Cobrado": money(r.get("cobrado")),
                    "Pendiente": money(r.get("deuda")),
                    "Estado": r.get("estado") or "",
                } for r in receipts],
            })
        display = {
            "title": property_name,
            "subtitle": ("Listado detallado" if is_list_request else "Consulta de deuda de propiedad") + (f" | Ejercicio {requested_year}" if requested_year else ""),
            "cards": [
                {"label": "Deuda total propiedad", "value": money(total)},
                {"label": "Recibos pendientes", "value": str(pending_receipts)},
                {"label": "Titulares/deudores", "value": str(len(by_debtor))},
            ],
            "tables": debt_tables,
            "note": "Consulta por propiedad: la deuda se muestra completa, separada por el titular/deudor que figura en cada recibo.",
        }
        return response(answer, 0.9 if is_list_request else 0.86, facts={"tipo_resultado": "deuda_propiedad", "id_propiedad": debt_property_id, "ejercicio": requested_year, "deuda": total, "recibos": pending_receipts}, display=display, sources=source_refs("receipts", "properties", "owners"), data_status="confirmado", query_domain="deuda")
    if global_list_pattern and not owners:
        listing = debtor_listing(requested_year, minimum_debt)
        total_listed = sum(float(item.get("deuda") or 0) for item in listing)
        period_text = f" del ejercicio {requested_year}" if requested_year else ""
        minimum_text = f" con deuda igual o superior a {money(minimum_debt)}" if minimum_debt else ""
        answer = f"He encontrado {len(listing)} propietarios{period_text}{minimum_text}. La deuda pendiente incluida en el listado asciende a {money(total_listed)}."
        display = {
            "title": "Listado de propietarios con deuda",
            "subtitle": (f"Ejercicio {requested_year}" if requested_year else "Todos los ejercicios") + (f" | Minimo {money(minimum_debt)}" if minimum_debt else ""),
            "cards": [
                {"label": "Propietarios", "value": str(len(listing))},
                {"label": "Deuda incluida", "value": money(total_listed)},
                {"label": "Recibos pendientes", "value": str(sum(int(item.get("recibos") or 0) for item in listing))},
            ],
            "tables": [{
                "title": "Relacion de deudores",
                "columns": ["Propietario", "Codigo", "Propiedades", "Recibos", "Deuda"],
                "rows": [{
                    "Propietario": item["propietario"],
                    "Codigo": item.get("codigo") or "",
                    "Propiedades": str(item.get("propiedades") or 0),
                    "Recibos": str(item.get("recibos") or 0),
                    "Deuda": money(item.get("deuda")),
                } for item in listing],
            }],
            "note": "Listado ordenado de mayor a menor deuda pendiente segun los recibos actualmente importados.",
        }
        return response(answer, 0.9, facts={"tipo_resultado": "listado_deudores", "ejercicio": requested_year, "deudores": len(listing), "deuda": total_listed}, display=display, sources=source_refs("receipts", "owners"), data_status="confirmado", query_domain="deuda")
    if years and not owners:
        return handle_global_debt_year(int(years[0]))
    if len(owners) == 1:
        owner = owners[0]
        total, by_year, by_property, receipts = debt_for_owner(owner, requested_year, debt_property_id)
        other_debt = other_property_debt_for_owner(owner, requested_year)
        other_total = sum(float(item.get("deuda") or 0) for item in other_debt)
        pending_receipts = sum(int(item.get("recibos") or 0) for item in by_year)
        if total <= 0:
            filter_text = f" en {requested_year}" if requested_year else ""
            answer = f"{owner['nombre']} no tiene deuda pendiente registrada{filter_text}."
            display = {
                "title": owner["nombre"],
                "subtitle": "Consulta de deuda",
                "cards": [{"label": "Deuda pendiente", "value": money(0)}],
            }
        else:
            year_text = ", ".join([f"{r['ejercicio']}: {money(r['deuda'])}" for r in by_year]) or "sin desglose"
            prop_text = "\\n".join([f"- {r['propiedad']}: {money(r['deuda'])} ({r['recibos']} recibos)" for r in by_property[:8]])
            answer = f"{owner['nombre']} tiene deuda pendiente por {money(total)} en {pending_receipts} recibos.\\nDesglose por ejercicio: {year_text}.\\nDesglose por propiedad:\\n{prop_text}"
            debt_tables = [
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
            ]
            if is_list_request:
                debt_tables.append({
                    "title": "Relacion de recibos pendientes",
                    "columns": ["Referencia", "Fecha", "Ejercicio", "Propiedad", "Tipo", "Importe", "Cobrado", "Pendiente", "Estado"],
                    "rows": [{
                        "Referencia": r.get("referencia") or "",
                        "Fecha": r.get("fecha_emision") or "",
                        "Ejercicio": str(r.get("ejercicio") or ""),
                        "Propiedad": r.get("propiedad") or "",
                        "Tipo": r.get("tipo_recibo") or "",
                        "Importe": money(r.get("importe")),
                        "Cobrado": money(r.get("cobrado")),
                        "Pendiente": money(r.get("deuda")),
                        "Estado": r.get("estado") or "",
                    } for r in receipts],
                })
            if other_total > 0:
                debt_tables.append({
                    "title": "Deuda vinculada a sus propiedades a nombre de otros titulares/deudores",
                    "columns": ["Titular/deudor", "Propiedad", "Deuda", "Recibos"],
                    "rows": [{
                        "Titular/deudor": r.get("propietario") or "",
                        "Propiedad": r.get("propiedad") or "",
                        "Deuda": money(r.get("deuda")),
                        "Recibos": str(r.get("recibos") or 0),
                    } for r in other_debt],
                })
                answer += f"\\n\\nAviso: las propiedades vinculadas actualmente a {owner['nombre']} tienen ademas {money(other_total)} de deuda registrada a nombre de otros titulares/deudores del recibo. No la sumo como deuda personal de {owner['nombre']}."
            subtitle_parts = ["Listado detallado" if is_list_request else "Consulta de deuda"]
            if requested_year:
                subtitle_parts.append(f"Ejercicio {requested_year}")
            if debt_property_id and by_property:
                subtitle_parts.append(by_property[0]["propiedad"])
            display = {
                "title": owner["nombre"],
                "subtitle": " | ".join(subtitle_parts),
                "cards": [
                    {"label": "Deuda total", "value": money(total)},
                    {"label": "Recibos pendientes", "value": str(pending_receipts)},
                    {"label": "Ejercicios con deuda", "value": str(len(by_year))},
                    {"label": "Propiedades afectadas", "value": str(len(by_property))},
                ],
                "tables": debt_tables,
                "note": (f"Se muestran los primeros {len(receipts)} de {pending_receipts} recibos." if is_list_request and pending_receipts > len(receipts) else "Consulta personal: solo se suma la deuda cuyo recibo figura a nombre del propietario consultado. La deuda antigua de otro titular se muestra aparte cuando afecta a una propiedad actualmente vinculada."),
            }
        return response(answer, 0.9 if is_list_request else 0.86, facts={"tipo_resultado": "listado_recibos" if is_list_request else "resumen_deuda", "id_propietario": owner["id_propietario"], "ejercicio": requested_year, "deuda": total, "recibos": pending_receipts, "deuda_propiedades_otros_titulares": other_total}, display=display, sources=source_refs("receipts", "owners", "properties", "owner_properties"), data_status="confirmado", query_domain="deuda")
    if len(owners) > 1:
        answer = "He encontrado varios propietarios posibles. Necesito que elijas uno:\\n" + "\\n".join([f"- {o['nombre']} (codigo {o.get('codigo_netfincas') or 'sin codigo'})" for o in owners[:8]])
        return response(answer, 0.52, candidates=[{"type":"owner","id":o["id_propietario"],"title":o["nombre"],"score":1} for o in owners[:8]], questions=["Propietario exacto"], sources=source_refs("owners"), data_status="incompleto", query_domain="deuda")
    return response("No he encontrado un propietario o propiedad claro para consultar deuda. Indica el nombre completo o el codigo de propiedad.", 0.45, questions=["Propietario o propiedad"], sources=source_refs("receipts", "owners", "properties"), data_status="incompleto", query_domain="deuda")

QUERY_HANDLERS = {
    "propietarios_contacto": lambda: handle_contact_query(email_query),
    "seguridad": handle_security_query,
    "asambleas": handle_assembly_query,
    "presupuesto": handle_budget_query,
    "contabilidad": handle_accounting_query,
    "deuda": handle_debt_query,
    "propiedad": handle_property_query,
    "trabajo": handle_work_query,
}

conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
conn.create_function("NORMTXT", 1, norm)
q_norm = norm(question)

try:
    is_finance_question = any(token in q_norm for token in ["BALANCE", "FINANCIERO", "TESORERIA", "RESULTADO ECONOMICO"])
    is_budget_question = any(token in q_norm for token in ["PRESUPUEST", "PARTIDA", "DESVIACION"]) and not is_finance_question
    explicit_debt_verb = bool(re.match(r"^(?:CUANTO|CUANDO|QUE CANTIDAD|QUE IMPORTE|IMPORTE|SALDO)?\\s*(?:DEBE|ADEUDA)\\s+.+$", q_norm))
    is_list_request = any(token in q_norm for token in ["LISTA", "LISTADO", "RELACION", "DETALLE", "DESGLOSE"])
    is_debt_question = any(token in q_norm for token in ["DEUDA", "DEUDOR", "MOROS", "RECIBO PENDIENTE", "RECIBOS PENDIENTES", "SALDO PENDIENTE", "IMPORTE PENDIENTE"]) or explicit_debt_verb or (is_list_request and "DEBEN" in q_norm)
    is_owner_question = "PROPIETARIO" in q_norm and any(token in q_norm for token in ["QUIEN", "CUAL", "DE "])
    is_work_question = any(token in q_norm for token in ["TAREA", "PROYECTO", "PENDIENTE", "RESPONSABLE", "PROXIMO PASO"]) and any(token in q_norm for token in ["COMO", "ESTADO", "QUIEN", "CUAL", "LISTA", "BUSCA"])
    is_assembly_question = any(token in q_norm for token in ["ASAMBLEA", "JUNTA", "QUORUM", "VOTACION", "VOTOS", "ACTA"]) or bool(re.search(r"\\bPUNTO\\s+\\d+\\b", q_norm))
    is_security_question = any(token in q_norm for token in ["SEGURIDAD", "VIGILANCIA", "INCIDENCIA", "INCIDENCIAS", "PARTE", "PARTES"]) and not is_work_question
    email_query = extract_email_query(question)
    query_domain = detect_query_domain(email_query, is_budget_question, is_finance_question, is_debt_question, is_owner_question, is_work_question, is_assembly_question, is_security_question)

    if query_domain in QUERY_HANDLERS:
        print(json.dumps(QUERY_HANDLERS[query_domain](), ensure_ascii=False))
        raise SystemExit

    print(json.dumps(not_handled(), ensure_ascii=False))
finally:
    conn.close()
`;
  return runPythonJson(script);
}

function extractDebtEmailTarget(text) {
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  const patterns = [
    /(?:deuda|recibos?\s+pendientes?|saldo\s+pendiente)\s+(?:de|del|a|para)\s+(.+?)(?:\s+con\s+(?:listado|detalle|relacion|desglose)|\s+para\s+enviar|\s+por\s+email|\s+por\s+correo|$)/i,
    /(?:reclamar|recordar|comunicar)\s+(?:la\s+)?deuda\s+(?:de|a)\s+(.+?)(?:\s+con\s+(?:listado|detalle|relacion|desglose)|\s+por\s+email|\s+por\s+correo|$)/i,
    /(?:texto|borrador|correo|email)\s+(?:para\s+)?(?:enviar\s+)?(?:a|para)\s+(.+?)(?:\s+por\s+(?:su\s+)?deuda|\s+con\s+deuda|$)/i,
  ];
  for (const pattern of patterns) {
    const match = cleanText.match(pattern);
    if (match?.[1]) {
      return match[1].replace(/[?¿.,;:]+$/g, "").trim();
    }
  }
  return cleanText;
}

function emailDraftLooksLikeDebtNotice(text) {
  const normalized = normalizeText(text);
  return /\b(deuda|debe|adeuda|morosidad|recibos? pendientes?|saldo pendiente|reclamacion|recordatorio)\b/i.test(normalized);
}

function emailDraftLooksLikeExecutiveSummary(text) {
  const normalized = normalizeText(text);
  const asksEmail = /\b(email|correo|enviar|mandar|copiar|borrador|texto)\b/i.test(normalized);
  const asksSummary = /\b(resumen|resumen ejecutivo|situacion|estado actual|historico|historial|seguimiento)\b/i.test(normalized);
  const hasEntity = /\b(tarea|proyecto)\b/i.test(normalized);
  return asksEmail && asksSummary && hasEntity && !emailDraftLooksLikeDebtNotice(text);
}

function extractExecutiveSummaryTarget(text) {
  const cleanText = String(text || "").replace(/\s+/g, " ").trim();
  const typeMatch = cleanText.match(/\b(tarea|proyecto)\b/i);
  const type = typeMatch ? (normalizeText(typeMatch[1]).includes("tarea") ? "task" : "project") : "";
  const patterns = [
    /(?:resumen(?:\s+ejecutivo)?|situacion|estado(?:\s+actual)?|historico|historial)\s+(?:de|del|de la)\s+(?:tarea|proyecto)\s+(.+?)(?:\s+para\s+(?:email|correo|enviar|mandar)|\s+por\s+(?:email|correo)|\s+con\s+(?:historico|historial)|$)/i,
    /(?:email|correo|borrador|texto)\s+(?:de|del|sobre|para)\s+(?:la\s+)?(?:tarea|proyecto)\s+(.+?)(?:\s+con\s+(?:historico|historial)|$)/i,
    /(?:tarea|proyecto)\s+(.+?)(?:\s+para\s+(?:email|correo|enviar|mandar)|\s+por\s+(?:email|correo)|$)/i,
  ];
  let target = "";
  for (const pattern of patterns) {
    const match = cleanText.match(pattern);
    if (match?.[1]) {
      target = match[1].replace(/[?¿.,;:]+$/g, "").trim();
      break;
    }
  }
  if (!target) {
    target = cleanText
      .replace(/\b(?:hazme|prepara|redacta|crear|genera|un|una|el|la|para|por|email|correo|borrador|texto|resumen|ejecutivo|historico|historial|seguimiento|situacion|estado|actual|tarea|proyecto|enviar|mandar|copiar|incluyendo|con)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  return { type, target };
}

function findExecutiveSummaryEntity(context, text) {
  const request = extractExecutiveSummaryTarget(text);
  const wantedTypes = request.type ? [request.type] : ["project", "task"];
  const rows = [];
  for (const type of wantedTypes) {
    const source = type === "task" ? (context.tasks || []) : (context.projects || []);
    for (const item of source) {
      const title = item.titulo || "";
      const haystack = [title, item.categoria, item.proyecto, item.comunidad, item.responsable, item.proximo_paso].filter(Boolean).join(" ");
      const targetNorm = normalizeText(request.target);
      const titleNorm = normalizeText(title);
      let score = Math.max(scoreTextMatch(request.target, title), scoreTextMatch(title, request.target), scoreTextMatch(text, title));
      if (targetNorm && titleNorm.includes(targetNorm)) score += 8;
      if (targetNorm && normalizeText(haystack).includes(targetNorm)) score += 4;
      rows.push({ type, item, score });
    }
  }
  return rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
}

function itemTitle(detail, type) {
  const item = detail?.item || {};
  return type === "task" ? (item.titulo || "") : (item.nombre || item.titulo || "");
}

function itemState(detail, type) {
  const item = detail?.item || {};
  return type === "task" ? (item.estado || "") : (item.estado_general || item.estado || "");
}

function itemOwner(detail, type) {
  const item = detail?.item || {};
  return type === "task" ? (item.responsable || "") : (item.responsable_principal || item.responsable || "");
}

function itemNextStep(detail, type) {
  const item = detail?.item || {};
  return item.proximo_paso || item.observaciones || "";
}

function historyComment(row) {
  return String(row?.comentario || row?.descripcion || row?.detalle || "").trim();
}

function historyNextStep(row) {
  return String(row?.proximo_paso || "").trim();
}

function formatHistoryDate(row) {
  return String(row?.fecha_hora || row?.fecha || "").slice(0, 10) || "Sin fecha";
}

function normalizeEmailSummaryText(value) {
  return polishSentence(value)
    .replace(/^[A-Za-z ]{2,60}\s+dice:\s*/i, "Se informa de que ")
    .replace(/^Correo de\s+/i, "Se registra correo de fecha ")
    .replace(/\bdecdimnos\b/gi, "se decide")
    .replace(/\blagravilla\b/gi, "la gravilla")
    .replace(/\bno s epone\b/gi, "no se coloca")
    .replace(/\bno s e\b/gi, "no se ")
    .replace(/\bd elos\b/gi, "de los")
    .replace(/\bd elas\b/gi, "de las")
    .replace(/\bcomprara\b/gi, "comprar")
    .replace(/\bpropuetas\b/gi, "propuestas")
    .replace(/\banti luz\b/gi, "antihierbas")
    .replace(/\bde las chiquitas\b/gi, "plantas de menor porte")
    .replace(/\bgrava no\s+(\d+)/gi, "grava numero $1")
    .replace(/\bgravilla no\s+(\d+)/gi, "gravilla numero $1")
    .replace(/(\d)\.\s+(\d{3}\b)/g, "$1.$2")
    .replace(/(\d),\s+(\d{2})/g, "$1,$2")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulHistoryRows(history) {
  const seen = new Set();
  return (history || [])
    .filter((row) => historyComment(row) || historyNextStep(row))
    .filter((row) => !/ficha incorporada mediante importacion historica/i.test(historyComment(row)))
    .filter((row) => {
      const key = normalizeText([formatHistoryDate(row), row.tipo_registro, historyComment(row), historyNextStep(row)].join(" ")).slice(0, 220);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function summarizeHistoryLine(row) {
  const comment = normalizeEmailSummaryText(summarizeOperationalText(historyComment(row), 1)[0] || historyComment(row)).slice(0, 260);
  return `- ${formatHistoryDate(row)} | ${row.tipo_registro || "Seguimiento"}: ${comment}`.slice(0, 360);
}

function findLatestUsefulNextStep(detail, type, currentState) {
  if (/finaliz|terminad|archivad/i.test(normalizeText(currentState))) {
    return `No consta ninguna actuacion pendiente; ${type === "task" ? "la tarea" : "el proyecto"} figura como ${currentState}.`;
  }
  const history = Array.isArray(detail.history) ? detail.history : [];
  const seen = new Set();
  for (const row of history) {
    const next = normalizeEmailSummaryText(historyNextStep(row));
    const key = normalizeText(next);
    if (!next || seen.has(key)) continue;
    seen.add(key);
    if (/proximo paso/i.test(next) || next.length > 350) continue;
    return next;
  }
  const itemStep = normalizeEmailSummaryText(itemNextStep(detail, type));
  if (itemStep && itemStep.length <= 350 && !/proximo paso/i.test(itemStep)) return itemStep;
  return "Pendiente de definir el siguiente paso operativo.";
}

function buildExecutiveBullets(detail, type, currentState) {
  const history = meaningfulHistoryRows([...(detail.history || [])].reverse());
  const combined = history.map((row) => historyComment(row)).join(" ");
  const summary = summarizeOperationalText(combined, 8).map(normalizeEmailSummaryText);
  const selected = [];
  const push = (text) => {
    const clean = normalizeEmailSummaryText(text);
    const key = normalizeText(clean).slice(0, 120);
    if (clean && !selected.some((item) => normalizeText(item).slice(0, 120) === key)) selected.push(clean);
  };
  const first = history.find((row) => historyComment(row));
  if (first) push(summarizeOperationalText(historyComment(first), 1)[0] || historyComment(first));
  for (const line of summary) {
    if (selected.length >= 4) break;
    if (/proximo paso|fecha objetivo/i.test(line)) continue;
    push(line);
  }
  const latestNonFinal = [...history].reverse().find((row) => historyComment(row) && !/finalizad/i.test(historyComment(row)));
  if (selected.length < 4 && latestNonFinal) push(summarizeOperationalText(historyComment(latestNonFinal), 1)[0] || historyComment(latestNonFinal));
  if (/finaliz|terminad/i.test(normalizeText(currentState))) {
    push(`${type === "task" ? "La tarea" : "El proyecto"} consta actualmente como ${currentState}.`);
  }
  return selected.slice(0, 4);
}

function buildExecutiveIntro(detail, type, currentState, nextStep) {
  const typeLabel = type === "task" ? "La tarea" : "El proyecto";
  const title = itemTitle(detail, type);
  const state = currentState || "sin estado indicado";
  const history = meaningfulHistoryRows([...(detail.history || [])].reverse());
  const latestRelevant = [...history].reverse().find((row) => historyComment(row) && !/finalizad/i.test(historyComment(row)));
  const latestText = latestRelevant ? normalizeEmailSummaryText(summarizeOperationalText(historyComment(latestRelevant), 1)[0] || historyComment(latestRelevant)) : "";
  const latestBody = latestText
    .replace(/^\s*se informa de que\s*/i, "")
    .replace(/\.$/, "");
  const finalText = /finaliz|terminad/i.test(normalizeText(state))
    ? ` Actualmente figura como ${state}, por lo que no se recoge ninguna actuacion pendiente salvo revision posterior.`
    : ` Actualmente figura como ${state}, con el siguiente paso pendiente: ${normalizeEmailSummaryText(nextStep)}`;
  return `${typeLabel} "${title}" cuenta con ${history.length} seguimiento(s) registrados en la app.${latestBody ? ` La ultima actuacion relevante indica que ${latestBody}.` : ""}${finalText}`;
}

function buildExecutiveSummaryEmailBody(detail, type) {
  const item = detail.item || {};
  const history = Array.isArray(detail.history) ? detail.history : [];
  const latest = history[0] || {};
  const title = itemTitle(detail, type);
  const typeLabel = type === "task" ? "tarea" : "proyecto";
  const currentState = itemState(detail, type) || latest.estado_nuevo || "No indicado";
  const owner = itemOwner(detail, type) || latest.responsable_nuevo || "No indicado";
  const nextOwner = item.responsable_proximo_paso || latest.responsable_proximo_paso || owner;
  const nextStep = findLatestUsefulNextStep(detail, type, currentState);
  const relevantHistory = meaningfulHistoryRows([...history].reverse())
    .slice(-6)
    .map(summarizeHistoryLine);
  const executive = buildExecutiveBullets(detail, type, currentState);
  const executiveIntro = buildExecutiveIntro(detail, type, currentState, nextStep);
  const community = item.comunidad || "";
  const attachments = Array.isArray(detail.attachments) ? detail.attachments.length : 0;

  return [
    "Buenos días,",
    "",
    `En relación con ${typeLabel === "tarea" ? "la tarea" : "el proyecto"} "${title}", traslado un resumen ejecutivo de situación:`,
    "",
    "Resumen ejecutivo:",
    executiveIntro,
    "",
    "Puntos principales:",
    executive.length ? executive.map((line) => `- ${line}`).join("\n") : "- No consta historico suficiente para elaborar un resumen amplio.",
    "",
    "Situación actual:",
    `- Comunidad: ${community || "No indicada"}`,
    `- Estado: ${currentState}`,
    `- Responsable actual: ${owner}`,
    `- Responsable del próximo paso: ${nextOwner || "No indicado"}`,
    `- Próximo paso: ${normalizeEmailSummaryText(nextStep)}`,
    "",
    "Historial resumido:",
    relevantHistory.length ? relevantHistory.join("\n") : "- No constan seguimientos registrados.",
    "",
    attachments ? `Anexos vinculados en la app: ${attachments}.` : "No constan anexos vinculados en la app.",
    "",
    "Quedo pendiente de cualquier indicación o comentario adicional.",
    "",
    "Un saludo,",
  ].join("\n");
}

async function prepareAgentExecutiveSummaryEmailDraft(session, text) {
  const context = await queryAiContext(session);
  const matches = findExecutiveSummaryEntity(context, text);
  const best = matches[0];
  if (!best || best.score < 2) {
    return {
      handled: true,
      source: "local-db",
      confidence: 0.35,
      action: "borrador_email",
      draft_contract: "email_draft_v1",
      query_domain: "email",
      data_status: "incompleto",
      requires_confirmation: true,
      writes_data: false,
      outlook_ready: false,
      answer: "No he podido localizar con seguridad la tarea o proyecto para preparar el resumen ejecutivo.",
      questions: ["Indica el nombre exacto de la tarea o proyecto."],
      candidates: matches.slice(0, 6).map((row) => ({ type: row.type, id: row.item.id, title: row.item.titulo, score: row.score })),
      payload: { to: "", subject: "", body: "" },
      sources: [],
    };
  }
  const detail = await queryEntityDetail(session, best.type, best.item.id);
  const title = itemTitle(detail, best.type);
  const typeLabel = best.type === "task" ? "tarea" : "proyecto";
  const subject = `Resumen ejecutivo - ${title}`;
  const body = buildExecutiveSummaryEmailBody(detail, best.type);
  return {
    handled: true,
    source: "local-db",
    confidence: Math.min(0.92, 0.55 + best.score / 20),
    action: "borrador_email",
    draft_contract: "email_draft_v1",
    query_domain: "email",
    data_status: "confirmado",
    requires_confirmation: true,
    writes_data: false,
    outlook_ready: false,
    answer: `He preparado un resumen ejecutivo del ${typeLabel} "${title}" para copiarlo en un email. No se ha enviado nada.`,
    payload: {
      to: "",
      to_status: "pendiente_de_completar",
      recipient_name: "",
      subject,
      body,
      source_query: text,
    },
    display: {
      title,
      cards: [
        { label: "Tipo", value: best.type === "task" ? "Tarea" : "Proyecto" },
        { label: "Estado", value: itemState(detail, best.type) || "No indicado" },
        { label: "Responsable", value: itemOwner(detail, best.type) || "No indicado" },
        { label: "Seguimientos", value: String((detail.history || []).length) },
      ],
    },
    sources: [
      { module: best.type === "task" ? "tareas" : "proyectos", table: best.type === "task" ? "tareas/registros" : "proyectos/registros_proyectos", description: "Ficha e historico visible segun permisos del usuario" },
    ],
    facts: {
      entity_type: best.type,
      entity_id: best.item.id,
      historial_registros: (detail.history || []).length,
      anexos: (detail.attachments || []).length,
    },
    questions: [],
    impact_summary: {
      title: "Resumen ejecutivo para email",
      lines: [
        `Elemento: ${title}`,
        `Historico incorporado: ${(detail.history || []).length} registro(s)`,
        "No se crea borrador en Outlook ni se envia correo en esta fase.",
      ],
    },
  };
}

function tableRows(display, titleIncludes) {
  const tables = Array.isArray(display?.tables) ? display.tables : [];
  const table = tables.find((item) => normalizeText(item.title || "").includes(normalizeText(titleIncludes)));
  return Array.isArray(table?.rows) ? table.rows : [];
}

function displayCardValue(display, label) {
  const cards = Array.isArray(display?.cards) ? display.cards : [];
  const card = cards.find((item) => normalizeText(item.label || "") === normalizeText(label));
  return card?.value || "";
}

function buildDebtEmailBody(debtResult, ownerName, requestedList) {
  const display = debtResult.display || {};
  const total = displayCardValue(display, "Deuda total") || `${debtResult.facts?.deuda || 0} EUR`;
  const receiptsCount = displayCardValue(display, "Recibos pendientes") || String(debtResult.facts?.recibos || "");
  const byYearRows = tableRows(display, "ejercicio");
  const receiptRows = tableRows(display, "recibos pendientes");
  const freshness = debtResult.freshness?.summary || "Los datos proceden de la informacion actualmente importada en la app.";
  const yearLines = byYearRows.length
    ? byYearRows.map((row) => `- ${row.Ejercicio}: ${row.Deuda} (${row.Recibos} recibo(s))`).join("\n")
    : "- Sin desglose por ejercicio disponible.";
  const receiptLines = requestedList && receiptRows.length
    ? receiptRows.slice(0, 60).map((row) => [
        row.Fecha || "",
        row.Propiedad ? `Propiedad ${row.Propiedad}` : "",
        row.Tipo || "",
        row.Referencia ? `Ref. ${row.Referencia}` : "",
        row.Pendiente ? `pendiente ${row.Pendiente}` : "",
      ].filter(Boolean).join(" | ")).join("\n")
    : "";
  const receiptNote = requestedList
    ? receiptRows.length
      ? `\nDetalle de recibos pendientes:\n${receiptLines}${receiptRows.length > 60 ? `\n\nSe incluyen los primeros 60 recibos. El listado completo consta de ${receiptRows.length} recibos y debe adjuntarse o revisarse desde la app.` : ""}`
      : "\nNo se ha podido incorporar un listado individual de recibos en el borrador. Revise el detalle desde la app antes de enviar."
    : "";
  return [
    `Estimado/a ${ownerName}:`,
    "",
    "Le informamos de que, segun los datos actualmente disponibles en la administracion de la comunidad, consta una deuda pendiente asociada a su titularidad.",
    "",
    `Importe total pendiente: ${total}`,
    receiptsCount ? `Numero de recibos pendientes: ${receiptsCount}` : "",
    "",
    "Desglose por ejercicio:",
    yearLines,
    receiptNote,
    "",
    freshness,
    "",
    "Si usted hubiera realizado algun pago no reflejado en esta relacion, le rogamos nos remita el justificante bancario para poder comprobarlo y actualizar la situacion.",
    "",
    "Quedamos a su disposicion para cualquier aclaracion.",
    "",
    "Atentamente,",
    "Administracion de la comunidad",
  ].filter((line) => line !== null && line !== undefined).join("\n");
}

async function queryOwnerEmailForDraft(ownerId) {
  if (!ownerId) return {};
  const script = `
import json
import sqlite3

path = ${JSON.stringify(databasePath)}
owner_id = int(${JSON.stringify(Number(ownerId) || 0)})
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
try:
    row = conn.execute("""
        SELECT valor, principal
        FROM cf_contactos_propietario
        WHERE id_propietario=?
          AND COALESCE(activo,1)=1
          AND INSTR(valor, '@') > 0
        ORDER BY COALESCE(principal,0) DESC, valor
        LIMIT 1
    """, (owner_id,)).fetchone()
    print(json.dumps({"email": row["valor"] if row else "", "principal": bool(row["principal"]) if row else False}, ensure_ascii=False))
finally:
    conn.close()
`;
  return runPythonJson(script);
}

async function externalPolishEmailDraft(result, sourceText) {
  if (!aiExternalAvailable() || !result?.payload?.body) return result;
  const system = [
    "Eres un redactor profesional para administracion de comunidades de propietarios.",
    "Devuelve solo JSON valido.",
    "Reescribe el email para que sea claro, formal, conciso y util.",
    "No inventes destinatarios, importes, recibos, fechas, estados, acuerdos ni anexos.",
    "No elimines advertencias de vigencia de datos ni referencias a revision.",
    "Si hay listado de recibos o tabla, mantenlo ordenado y legible.",
    "No envies nada. Solo devuelve asunto y cuerpo.",
    "Formato exacto: {subject,body,notes:[string]}",
  ].join("\n");
  try {
    const parsed = await callExternalAiJson({
      system,
      purpose: "email_draft_redaction",
      maxTokens: 7000,
      user: `Borrador generado por datos internos:\n${JSON.stringify({
        subject: result.payload.subject || "",
        body: result.payload.body || "",
        facts: result.facts || {},
        display: result.display || {},
        freshness: result.freshness || null,
      })}\n\nPeticion original:\n${String(sourceText || "").slice(0, 12000)}`,
    });
    return {
      ...result,
      source: [result.source, parsed.source].filter(Boolean).join("+"),
      ai_model: parsed.ai_model,
      external_redaction: true,
      payload: {
        ...(result.payload || {}),
        subject: String(parsed.subject || result.payload.subject || "").trim(),
        body: String(parsed.body || result.payload.body || "").trim(),
      },
      external_notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 5) : [],
    };
  } catch (error) {
    return { ...result, warning: [result.warning, `${error.message}. Se mantiene borrador local.`].filter(Boolean).join(" ") };
  }
}

async function prepareAgentEmailDraft(session, text) {
  const cleanText = String(text || "").trim();
  if (emailDraftLooksLikeExecutiveSummary(cleanText)) {
    return externalPolishEmailDraft(await prepareAgentExecutiveSummaryEmailDraft(session, cleanText), cleanText);
  }
  if (!emailDraftLooksLikeDebtNotice(cleanText)) {
    return {
      handled: true,
      source: "local",
      confidence: 0.45,
      action: "borrador_email",
      draft_contract: "email_draft_v1",
      query_domain: "email",
      data_status: "incompleto",
      requires_confirmation: true,
      writes_data: false,
      outlook_ready: false,
      answer: "Puedo preparar el borrador, pero necesito que indiques el asunto concreto. Ahora estan cubiertos los emails de deuda y los resumenes ejecutivos de tareas/proyectos.",
      questions: ["Indica si quieres un email de deuda o un resumen ejecutivo de una tarea/proyecto concreto."],
      payload: { to: "", subject: "", body: "" },
      sources: [],
    };
  }
  const target = extractDebtEmailTarget(cleanText);
  const requestedList = /\b(listado|detalle|relacion|desglose|recibos?)\b/i.test(normalizeText(cleanText));
  const debtQuery = `listado de recibos pendientes de ${target}`;
  const debtResult = await querySmartAssistant(session, debtQuery);
  const ownerName = debtResult?.display?.title || target;
  const ownerId = Number(debtResult?.facts?.id_propietario || 0);
  const contact = await queryOwnerEmailForDraft(ownerId);
  const hasDebt = Number(debtResult?.facts?.deuda || 0) > 0;
  const subject = hasDebt
    ? `Deuda pendiente - ${ownerName}`
    : `Situacion de deuda - ${ownerName}`;
  const body = hasDebt
    ? buildDebtEmailBody(debtResult, ownerName, requestedList)
    : [
        `Estimado/a ${ownerName}:`,
        "",
        "Le informamos de que, segun los datos actualmente disponibles en la administracion de la comunidad, no consta deuda pendiente registrada a su nombre.",
        "",
        debtResult?.freshness?.summary || "Los datos proceden de la informacion actualmente importada en la app.",
        "",
        "Quedamos a su disposicion para cualquier aclaracion.",
        "",
        "Atentamente,",
        "Administracion de la comunidad",
      ].join("\n");
  const result = {
    handled: true,
    source: "local-db",
    confidence: debtResult?.data_status === "confirmado" ? 0.86 : 0.54,
    action: "borrador_email",
    draft_contract: "email_draft_v1",
    query_domain: "email",
    data_status: debtResult?.data_status || "incompleto",
    requires_confirmation: true,
    writes_data: false,
    outlook_ready: false,
    answer: hasDebt
      ? `He preparado un borrador de email para comunicar la deuda pendiente de ${ownerName}. No se ha enviado nada.`
      : `He preparado un borrador de email para ${ownerName}, pero revisa el resultado porque no consta deuda pendiente en la consulta.`,
    payload: {
      to: contact.email || "",
      to_status: contact.email ? "email_detectado" : "email_no_detectado",
      recipient_name: ownerName,
      subject,
      body,
      source_query: debtQuery,
    },
    display: debtResult?.display || {},
    freshness: debtResult?.freshness || null,
    sources: debtResult?.sources || [],
    facts: {
      ...(debtResult?.facts || {}),
      email_detectado: contact.email || "",
      listado_incluido: requestedList,
    },
    questions: contact.email ? [] : ["No he encontrado email principal del propietario. Revisa o completa el destinatario antes de copiar/enviar."],
    impact_summary: {
      title: "Borrador de email sin envio",
      lines: [
        `Destinatario: ${contact.email || "pendiente de completar"}`,
        `Asunto: ${subject}`,
        "No se crea borrador en Outlook ni se envia correo en esta fase.",
      ],
    },
  };
  return externalPolishEmailDraft(result, cleanText);
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
    current_snapshot: {
      titulo: item.titulo || target?.title || "",
      categoria: item.categoria || "",
      estado: item.estado || "",
      prioridad: item.prioridad || "",
      responsable: item.responsable || "",
      responsable_proximo_paso: item.responsable_proximo_paso || "",
      fecha_objetivo_proximo_paso: item.fecha_objetivo_proximo_paso || "",
      proximo_paso: item.proximo_paso || "",
      comunidad: item.comunidad || "",
    },
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
  let redactionRules = [];
  try {
    redactionRules = (await runAiMemoryCommand(session, "list", { modulo: "redaccion", limit: 120 })).rules || [];
  } catch {
    redactionRules = [];
  }
  const finalizeProposal = async (proposal) => {
    const polished = polishAiProposal(proposal, cleanText);
    const externallyRefined = await externalRefineOperationalProposal(polished, cleanText, context);
    const improved = applyRedactionRulesToProposal(externallyRefined, redactionRules, cleanText);
    const ids = (improved.used_rules || []).map((rule) => Number(rule.id_regla)).filter(Boolean);
    if (ids.length) {
      try {
        await runAiMemoryCommand(session, "mark_used", { ids });
      } catch {}
    }
    return withAiProposalContract(improved);
  };
  const targeted = targetedRecordProposal(cleanText, context, target);
  if (targeted) return finalizeProposal(targeted);
  const smart = await querySmartAssistant(session, cleanText);
  if (smart?.handled) return finalizeProposal(smart);
  const fallback = localAiProposal(cleanText, context);
  try {
    const external = await externalAiProposal(cleanText, context);
    if (fallback.action === "consulta" && external?.action && external.action !== "consulta") {
      return finalizeProposal({ ...fallback, warning: "La IA externa interpreto la consulta como una accion. Se ha mantenido el modo de consulta para evitar crear o modificar datos por error." });
    }
    return finalizeProposal(external ? { ...fallback, ...external, fallbackSource: fallback.source } : fallback);
  } catch (error) {
    return finalizeProposal({ ...fallback, warning: `${error.message}. Se ha usado analisis local sin consumo externo.` });
  }
}

async function externalPolishQueryAnswer(result, question) {
  if (!aiExternalAvailable() || !result?.handled || !result?.answer) return result;
  if (!["consulta", "fuera_de_alcance"].includes(String(result.action || "consulta"))) return result;
  const system = [
    "Eres el copiloto de consulta de una aplicacion de gestion de comunidades.",
    "Devuelve solo JSON valido.",
    "Reformula la respuesta para que sea clara, escaneable y profesional.",
    "Usa exclusivamente los datos internos recibidos. No inventes importes, propietarios, emails, fechas, comunidades, recibos ni conclusiones.",
    "Si hay muchas filas, resume el criterio y conserva que la tabla/listado completo esta en display.",
    "Mantén avisos de vigencia de datos cuando existan.",
    "Distingue dato confirmado, inferencia y pendiente de comprobar.",
    "Formato exacto: {answer,summary,notes:[string]}",
  ].join("\n");
  try {
    const parsed = await callExternalAiJson({
      system,
      purpose: "query_answer_redaction",
      maxTokens: 5000,
      timeoutMs: 90000,
      user: `Pregunta:\n${question}\n\nRespuesta y datos internos:\n${JSON.stringify({
        answer: result.answer,
        query_domain: result.query_domain,
        data_status: result.data_status,
        facts: result.facts || {},
        display: result.display || {},
        freshness: result.freshness || null,
        sources: result.sources || [],
      }).slice(0, 70000)}`,
    });
    return {
      ...result,
      source: [result.source, parsed.source].filter(Boolean).join("+"),
      ai_model: parsed.ai_model,
      answer: String(parsed.answer || result.answer || "").trim(),
      external_summary: String(parsed.summary || "").trim(),
      external_notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 5) : [],
    };
  } catch (error) {
    return { ...result, warning: [result.warning, `${error.message}. Se mantiene respuesta local.`].filter(Boolean).join(" ") };
  }
}

async function answerAiQuery(session, text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("Escribe una pregunta para consultar.");

  let result = await querySmartAssistant(session, cleanText);
  if (!result?.handled) {
    const context = await queryAiContext(session);
    const local = localAiProposal(cleanText, context);
    if (local.action === "consulta") {
      result = local;
    } else {
      result = {
        handled: true,
        source: "local",
        confidence: 0.2,
        action: "consulta",
        query_domain: "general",
        answer: "No he podido identificar con seguridad los datos que necesitas. Formula la pregunta indicando el propietario, propiedad, tarea, proyecto, periodo o partida presupuestaria.",
        candidates: local.candidates || [],
        questions: ["Dato o elemento exacto que quieres consultar"],
        display: {},
      };
    }

    if (aiApiKey && aiProvider !== "local" && Number(result.confidence || 0) < 0.5) {
      try {
        const external = await externalAiProposal(cleanText, context);
        if (external?.action === "consulta") {
          result = { ...result, ...external, fallbackSource: result.source };
        }
      } catch (error) {
        result.warning = error.message + ". Se ha mantenido la respuesta local.";
      }
    }
  }

  result = {
    ...result,
    handled: true,
    action: "consulta",
    query_domain: result.query_domain || "general",
    data_status: result.data_status || ((result.questions || []).length ? "incompleto" : "inferido"),
    sources: Array.isArray(result.sources) ? result.sources : [],
  };
  result = await externalPolishQueryAnswer(result, cleanText);
  result = withAiProposalContract(result);
  try {
    const saved = await runAiHistoryCommand(session, "save", { pregunta: cleanText, respuesta: result });
    result.history_id = saved.id_consulta;
    result.history_date = saved.fecha_creacion;
  } catch (error) {
    result.warning = [result.warning, "La respuesta se ha generado, pero no se pudo guardar en el historial: " + error.message].filter(Boolean).join(" ");
  }
  return result;
}

async function analyzeOperationalWithAi(session, text) {
  const result = await analyzeWithAi(session, text);
  if (result.action !== "consulta") return result;
  return withAiProposalContract({
    ...result,
    action: "revisar_manual",
    queryDetected: true,
    answer: "Este texto parece una consulta y no se ha preparado ninguna creacion ni modificacion. Utiliza la caja Consultas IA para obtener y conservar la respuesta.",
  });
}

function isLongMeetingTranscript(text) {
  const value = String(text || "");
  const normalized = normalizeText(value);
  const lineCount = value.split(/\r?\n/).filter((line) => line.trim()).length;
  const speakerMarks = (value.match(/\b(?:speaker|interlocutor|persona)\s*\d+\b/gi) || []).length;
  const meetingWords = ["reunion", "seguimiento", "presidente", "elena", "repasar", "puntos", "asuntos", "presupuesto", "proveedor"];
  const meetingScore = meetingWords.reduce((total, token) => total + (normalized.includes(token) ? 1 : 0), 0);
  return value.length > 9000 || speakerMarks >= 5 || (lineCount > 90 && meetingScore >= 3);
}

const MEETING_TOPIC_RULES = [
  { id: "reciclaje_contenedores", title: "Punto de reciclaje y contenedores", keywords: ["contenedor", "contenedores", "reciclaje", "basura", "grua", "camion", "muro", "puerta", "camara"] },
  { id: "rotura_agua_drenaje", title: "Rotura de agua y drenaje", keywords: ["rotura", "agua", "drenaje", "tanque", "contador", "llenado", "limpian con agua", "presion"] },
  { id: "pintura_isleta", title: "Pintura de isleta de entrada", keywords: ["pintura", "isleta", "arcen", "arcén", "spray", "vial", "entrada"] },
  { id: "trabajos_witter", title: "Plan de trabajos de Witter", keywords: ["witter", "bitter", "camion", "jardinero", "tareas simples", "mapa de trabajo", "papeleras"] },
  { id: "seguridad_barrera", title: "Seguridad, barrera y camaras", keywords: ["securitas", "seguridad", "barrera", "camara", "fibra", "poste", "zanja", "juan antonio", "jose antonio"] },
  { id: "contrato_jardineria", title: "Contrato de jardineria y Licuas", keywords: ["licua", "licuas", "jardineria", "contrato", "prorroga", "febrero", "reduccion"] },
  { id: "proveedores_valoracion", title: "Panel y valoracion de proveedores", keywords: ["proveedor", "proveedores", "valoracion", "evaluar", "semaforo", "licitacion", "certificacion", "referencias"] },
  { id: "oficina", title: "Nueva oficina", keywords: ["oficina", "grego", "luz", "internet", "router", "5g", "fianza", "alquiler", "recibo", "compensacion"] },
  { id: "fianza_arboles", title: "Fianza de arboles y Ayuntamiento", keywords: ["fianza", "arbol", "arboles", "ayuntamiento", "medio ambiente", "alberto lopez", "compensacion"] },
  { id: "presupuesto", title: "Presupuesto y planificacion economica", keywords: ["presupuesto", "partida", "gasto", "cuota", "contribucion", "balance"] },
];

function classifyMeetingTopic(text) {
  const normalized = normalizeText(text);
  let selected = null;
  for (const rule of MEETING_TOPIC_RULES) {
    const score = rule.keywords.reduce((total, keyword) => total + (normalized.includes(normalizeText(keyword)) ? 1 : 0), 0);
    if (!selected || score > selected.score) selected = { ...rule, score };
  }
  if (!selected || selected.score <= 0) return null;
  return selected;
}

function cleanMeetingTurn(line) {
  return String(line || "")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:Speaker|Interlocutor|Persona)\s*\d+/gi, " ")
    .replace(/\b(?:Speaker|Interlocutor|Persona)\s*\d+\b/gi, " ")
    .trim();
}

function compactMeetingSegment(lines) {
  return lines
    .map(cleanMeetingTurn)
    .filter((line) => line.length > 8)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongMeetingText(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const turns = source.split(/\n+/).map(cleanMeetingTurn).filter((line) => line.length > 6);
  const segments = [];
  let currentTopic = null;
  let current = [];
  let neutral = 0;

  function flush(reason = "") {
    const body = compactMeetingSegment(current);
    if (body.length >= 180 && currentTopic) {
      segments.push({
        topic: currentTopic,
        reason,
        text: body.slice(0, 6500),
      });
    }
    current = [];
    currentTopic = null;
    neutral = 0;
  }

  for (const turn of turns) {
    const topic = classifyMeetingTopic(turn);
    const signal = hasOperationalSignal(turn);
    if (topic) {
      if (currentTopic && topic.id !== currentTopic.id && compactMeetingSegment(current).length >= 450) flush("cambio de asunto");
      currentTopic = currentTopic || topic;
      neutral = 0;
    } else if (!signal && currentTopic) {
      neutral += 1;
    }
    if (!currentTopic && topic) currentTopic = topic;
    if (currentTopic || signal) current.push(turn);
    if (currentTopic && neutral >= 9 && compactMeetingSegment(current).length >= 500) flush("bloque cerrado por tramo neutro");
    if (currentTopic && compactMeetingSegment(current).length >= 4200 && topic && topic.id === currentTopic.id) flush("bloque largo del mismo asunto");
  }
  if (current.length) flush("fin de reunion");

  const merged = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && previous.topic.id === segment.topic.id && previous.text.length + segment.text.length < 6800) {
      previous.text = [previous.text, segment.text].join("\n").trim();
    } else {
      merged.push(segment);
    }
  }
  return merged.slice(0, 18).map((segment, index) => [
    "TIPO DE ORIGEN: Reunion larga",
    "ASUNTO DETECTADO: " + segment.topic.title,
    "CRITERIO: Preferir seguimiento sobre creacion. Si no hay destino claro, dejar pendiente de aclarar/no importar.",
    "ORDEN EN REUNION: " + String(index + 1),
    "",
    segment.text,
  ].join("\n"));
}

function hasExplicitResponsible(text) {
  const normalized = normalizeText(text);
  return ["elena", "luis", "presidente", "rudy", "proveedor", "empresa", "jardinero", "securitas", "licua", "licuas", "costilla", "juanmi", "juan antonio"].some((token) => normalized.includes(token));
}

function normalizeMeetingProposal(proposal, sourceText) {
  const normalized = normalizeText(sourceText);
  const payload = { ...(proposal.payload || {}) };
  const hasDecision = /\b(se acuerda|queda aprobado|queda decidido|decidimos|el presidente confirma|el presidente aprueba|rudy confirma|rudy aprueba)\b/i.test(sourceText);
  const hasClearEntity = Boolean(proposal.entity?.id);
  const hasStrongCandidate = Number((proposal.candidates || [])[0]?.score || 0) >= 3;
  const isAction = AI_ACTIONS_REQUIRING_CONFIRMATION.has(proposal.action);

  if (isAction && !hasExplicitResponsible(sourceText)) {
    payload.responsable_proximo_paso = payload.responsable_proximo_paso || "Administracion";
    if (["crear_tarea", "crear_proyecto"].includes(proposal.action)) payload.responsable_nuevo = payload.responsable_nuevo || "Administracion";
  }
  if ((payload.responsable_proximo_paso || "").toLowerCase() === "luis gallardo" && !hasExplicitResponsible(sourceText)) {
    payload.responsable_proximo_paso = "Administracion";
  }
  if ((payload.responsable_nuevo || "").toLowerCase() === "luis gallardo" && !hasExplicitResponsible(sourceText) && ["crear_tarea", "crear_proyecto"].includes(proposal.action)) {
    payload.responsable_nuevo = "Administracion";
  }

  const shouldHold = !hasClearEntity && !hasStrongCandidate && (
    normalized.includes("a lo mejor") ||
    normalized.includes("no se") ||
    normalized.includes("habria que ver") ||
    normalized.includes("lo vemos") ||
    normalized.includes("barajamos") ||
    normalized.includes("preguntarle") ||
    normalized.includes("pendiente aclarar")
  );

  let next = { ...proposal, payload, meeting_analysis: true, meeting_source_excerpt: sourceText.slice(0, 1600) };
  if (hasDecision) {
    next = {
      ...next,
      payload: { ...next.payload, tipo_registro: "Decision" },
      meeting_decision_detected: true,
    };
  }
  if (shouldHold) {
    next = withAiProposalContract({
      ...next,
      action: "revisar_manual",
      requires_confirmation: false,
      answer: "Asunto detectado en reunion, pero necesita aclaracion antes de guardar. Puedes cambiarlo manualmente a seguimiento, tarea o proyecto si procede.",
      questions: [...(next.questions || []), "Confirmar si este asunto debe guardarse y en que tarea/proyecto."],
    });
  }
  return next;
}

function splitGuidedAutomationText(text) {
  const cleanText = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!cleanText) return [];
  const explicit = cleanText
    .split(/\n\s*(?:-{3,}|={3,})\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, 20);
  const headed = [];
  let current = [];
  for (const line of cleanText.split("\n")) {
    const trimmed = line.trim();
    const startsNew = /^(?:asunto|incidencia|tarea|proyecto|seguimiento|accion)\s*[:#-]/i.test(trimmed) || /^\d+\.\s+\S+/.test(trimmed);
    if (startsNew && current.length) {
      headed.push(current.join("\n").trim());
      current = [];
    }
    current.push(line);
  }
  if (current.length) headed.push(current.join("\n").trim());
  if (headed.length > 1) return headed.slice(0, 20);
  if (isLongMeetingTranscript(cleanText)) {
    const meetingSegments = splitLongMeetingText(cleanText);
    if (meetingSegments.length > 1) return meetingSegments;
  }
  const paragraphs = cleanText.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length > 1 && paragraphs.every((part) => part.length <= 1800)) return paragraphs.slice(0, 20);
  return [cleanText.slice(0, 8000)];
}

async function analyzeGuidedAutomationBatch(session, text) {
  const segments = splitGuidedAutomationText(text);
  if (!segments.length) throw new Error("Pega primero uno o varios asuntos para automatizar.");
  const meetingMode = isLongMeetingTranscript(text);
  if (meetingMode && aiExternalAvailable()) {
    const context = await queryAiContext(session);
    try {
      const external = await externalMeetingAnalysis(text, context);
      const items = Array.isArray(external?.items) ? external.items.slice(0, 30) : [];
      if (items.length) {
        const proposals = items.map((item, index) => {
          const proposal = proposalFromMeetingItem(item, context, index);
          return {
            ...proposal,
            batch_item: index + 1,
            batch_contract: "guided_batch_item_v1",
            source_text: [item.titulo, item.comentario, item.proximo_paso].filter(Boolean).join("\n\n"),
            selected: AI_ACTIONS_REQUIRING_CONFIRMATION.has(proposal.action) && !proposal.needs_entity_confirmation,
          };
        });
        return {
          ok: true,
          source: external.source || aiProvider,
          ai_model: external.ai_model || aiModel,
          batch_contract: "guided_batch_v1",
          batch_mode: "external_long_meeting",
          meeting_contract: "meeting_analysis_v1",
          meeting_rules: {
            prefer_existing_followup: true,
            uncertain_items: "no_importar_pendiente_aclarar",
            president_decision_only_if_explicit: true,
            default_unclear_responsible: "Administracion",
            source_document_should_be_linked: true,
          },
          requires_confirmation: true,
          writes_data: false,
          total: proposals.length,
          actionable: proposals.filter((proposal) => proposal.selected).length,
          proposals,
        };
      }
    } catch (error) {
      // Si la IA externa falla, mantenemos el flujo local para no bloquear el trabajo diario.
    }
  }
  const proposals = [];
  for (let index = 0; index < segments.length; index += 1) {
    const sourceText = segments[index];
    let proposal = await analyzeOperationalWithAi(session, sourceText);
    if (meetingMode) proposal = normalizeMeetingProposal(proposal, sourceText);
    proposals.push({
      ...proposal,
      batch_item: index + 1,
      batch_contract: "guided_batch_item_v1",
      source_text: sourceText,
      selected: AI_ACTIONS_REQUIRING_CONFIRMATION.has(proposal.action) && !proposal.needs_entity_confirmation,
    });
  }
  return {
    ok: true,
    batch_contract: "guided_batch_v1",
    batch_mode: meetingMode ? "long_meeting_transcript" : "guided_batch",
    meeting_rules: meetingMode ? {
      prefer_existing_followup: true,
      uncertain_items: "no_importar_pendiente_aclarar",
      president_decision_only_if_explicit: true,
      default_unclear_responsible: "Administracion",
      source_document_should_be_linked: true,
    } : null,
    requires_confirmation: true,
    writes_data: false,
    total: proposals.length,
    actionable: proposals.filter((proposal) => proposal.selected).length,
    proposals,
  };
}

const AGENT_TOOL_CATALOG = [
  {
    id: "ai.query.general",
    module: "centro_ia",
    label: "Consulta general de datos internos",
    status: "active",
    endpoint: "/api/ai/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["consulta", "dime", "busca", "quien", "cual", "cuanto", "listado", "lista", "muestra"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "owners.lookup",
    module: "propietarios",
    label: "Buscar propietario, propiedad, email o contacto",
    status: "active",
    endpoint: "/api/ai/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["propietario", "titular", "propiedad", "vivienda", "villa", "cb", "email", "correo", "telefono"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "accounting.debt.lookup",
    module: "contabilidad",
    label: "Consultar deuda, morosidad y recibos pendientes",
    status: "active",
    endpoint: "/api/ai/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["deuda", "debe", "adeuda", "morosidad", "recibo", "pendiente", "cobro", "deudor", "deudores"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "accounting.balance.lookup",
    module: "contabilidad",
    label: "Consultar balance, presupuesto y partidas",
    status: "active",
    endpoint: "/api/ai/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["balance", "presupuesto", "partida", "gasto", "ingreso", "disponible", "mantenimiento general"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "work.project.task.query",
    module: "trabajo",
    label: "Consultar tareas, proyectos, estados y responsables",
    status: "active",
    endpoint: "/api/ai/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["tarea", "proyecto", "estado", "responsable", "proximo paso", "seguimiento", "presupuestos"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "work.single.proposal",
    module: "trabajo",
    label: "Preparar seguimiento o alta de tarea/proyecto",
    status: "active",
    endpoint: "/api/ai/operate",
    intents: ["accion"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["actualiza", "actualizar", "seguimiento", "crea", "crear", "incidencia", "registra", "anade", "añade"],
    writesData: false,
    requiresConfirmation: true,
  },
  {
    id: "work.batch.proposal",
    module: "trabajo",
    label: "Preparar lote de seguimientos o altas",
    status: "active",
    endpoint: "/api/ai/batch-operate",
    intents: ["lote"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["lote", "---", "varios asuntos", "varias tareas", "varios proyectos"],
    writesData: false,
    requiresConfirmation: true,
  },
  {
    id: "assemblies.lookup",
    module: "asambleas",
    label: "Consultar asambleas, puntos y votaciones",
    status: "active",
    endpoint: "/api/ai/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["asamblea", "junta", "votacion", "votos", "coeficiente", "punto", "acta"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "security.lookup",
    module: "seguridad",
    label: "Consultar partes e incidencias de seguridad",
    status: "active",
    endpoint: "/api/ai/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["seguridad", "parte", "incidencia", "vigilante", "turno", "alarma"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "documents.lookup",
    module: "documentos",
    label: "Consultar documentos y anexos registrados",
    status: "active",
    endpoint: "/api/agent/documents/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["documento", "documentos", "anexo", "anexos", "archivo", "contrato", "pdf", "adjunto"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "reports.lookup",
    module: "informes",
    label: "Consultar informes Word generados",
    status: "active",
    endpoint: "/api/agent/documents/query",
    intents: ["consulta"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["informe", "informes", "word", "generado", "descargar informe", "abrir informe"],
    writesData: false,
    requiresConfirmation: false,
  },
  {
    id: "reports.generate.entity",
    module: "informes",
    label: "Preparar informe Word de tarea o proyecto",
    status: "active",
    endpoint: "/api/report/generate",
    intents: ["informe"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["generar informe", "sacar informe", "crear informe", "preparar informe", "informe de tarea", "informe de proyecto"],
    writesData: true,
    requiresConfirmation: true,
  },
  {
    id: "email.draft.proposal",
    module: "email",
    label: "Preparar borrador de email",
    status: "active",
    endpoint: "/api/agent/email/draft",
    intents: ["email"],
    roles: ["Superusuario", "Administrador", "Usuario"],
    keywords: ["email", "correo", "borrador", "texto para enviar", "redacta", "redactar", "recordatorio", "reclamacion", "deuda", "resumen ejecutivo", "historico", "historial", "seguimiento"],
    writesData: false,
    requiresConfirmation: true,
  },
  {
    id: "email.inbox.proposals",
    module: "email",
    label: "Revisar bandeja y proponer acciones",
    status: "planned",
    endpoint: "",
    intents: ["consulta", "accion"],
    roles: ["Superusuario", "Administrador"],
    keywords: ["email", "correo", "outlook", "bandeja", "responder", "enviar", "recordatorio"],
    writesData: false,
    requiresConfirmation: true,
    limitation: "Pendiente de conector Outlook y confirmacion de borradores antes de enviar.",
  },
  {
    id: "accounting.bank.reconcile",
    module: "contabilidad",
    label: "Conciliar extractos bancarios",
    status: "planned",
    endpoint: "",
    intents: ["accion"],
    roles: ["Superusuario", "Administrador"],
    keywords: ["extracto", "banco", "conciliar", "movimiento", "a revisar"],
    writesData: false,
    requiresConfirmation: true,
    limitation: "Pendiente de flujo web completo de importacion bancaria revisable.",
  },
  {
    id: "owners.ownership.change",
    module: "propietarios",
    label: "Preparar cambio de titularidad",
    status: "planned",
    endpoint: "",
    intents: ["accion"],
    roles: ["Superusuario", "Administrador"],
    keywords: ["cambio de titularidad", "escritura", "nuevo propietario", "traspasar deuda"],
    writesData: false,
    requiresConfirmation: true,
    limitation: "Pendiente de flujo legal guiado con deuda, documentos y auditoria.",
  },
];

function agentToolCanBeShown(session, tool) {
  return (tool.roles || []).includes(session?.rol || "");
}

function getAgentToolCatalog(session) {
  return AGENT_TOOL_CATALOG
    .filter((tool) => agentToolCanBeShown(session, tool))
    .map((tool) => ({
      id: tool.id,
      module: tool.module,
      label: tool.label,
      status: tool.status,
      endpoint: tool.endpoint,
      intents: tool.intents,
      writes_data: tool.writesData,
      requires_confirmation: tool.requiresConfirmation,
      limitation: tool.limitation || "",
    }));
}

function scoreAgentTool(text, intent, tool) {
  if (!(tool.intents || []).includes(intent)) return -1;
  const normalized = normalizeText(text);
  let score = 0;
  for (const keyword of tool.keywords || []) {
    const token = normalizeText(keyword);
    if (token && normalized.includes(token)) score += Math.max(1, Math.min(5, token.length / 4));
  }
  if (tool.status === "active") score += 0.4;
  if (tool.id === "ai.query.general" && intent === "consulta") score += 0.2;
  if (tool.id === "work.single.proposal" && intent === "accion") score += 0.2;
  if (tool.id === "work.batch.proposal" && intent === "lote") score += 2.5;
  if (tool.id === "reports.generate.entity" && intent === "informe") score += 2.5;
  if (tool.id === "email.draft.proposal" && intent === "email") score += 2.5;
  return score;
}

function selectAgentTool(session, text, intent) {
  const tools = AGENT_TOOL_CATALOG
    .filter((tool) => agentToolCanBeShown(session, tool))
    .map((tool) => ({ ...tool, score: scoreAgentTool(text, intent, tool) }))
    .filter((tool) => tool.score >= 0)
    .sort((a, b) => b.score - a.score);
  const best = tools[0] || null;
  if (!best) return null;
  const selected = {
    id: best.id,
    module: best.module,
    label: best.label,
    status: best.status,
    endpoint: best.endpoint,
    writes_data: best.writesData,
    requires_confirmation: best.requiresConfirmation,
    limitation: best.limitation || "",
    score: Number(best.score.toFixed(2)),
  };
  if (selected.status === "planned" && tools.find((tool) => tool.status === "active")) {
    const activeFallback = tools.find((tool) => tool.status === "active");
    selected.fallback = {
      id: activeFallback.id,
      module: activeFallback.module,
      label: activeFallback.label,
      endpoint: activeFallback.endpoint,
    };
  }
  return selected;
}

function queryAgentDocumentsReports(session, text) {
  const script = `
import json
import os
import sqlite3

path = ${JSON.stringify(databasePath)}
session = ${JSON.stringify(session || {})}
question = ${JSON.stringify(text || "")}
role = str(session.get("rol") or "")
allowed_ids = [int(c.get("id_comunidad")) for c in session.get("comunidades", []) if c.get("id_comunidad")]
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def rows(sql, params=()):
    return [dict(row) for row in conn.execute(sql, params).fetchall()]

def table_exists(name):
    return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())

def scope(alias):
    if role == "Superusuario":
        return "", []
    if not allowed_ids:
        return " AND 1=0", []
    return f" AND {alias}.id_comunidad IN ({','.join('?' for _ in allowed_ids)})", allowed_ids

def norm(value):
    return str(value or "").lower()

terms = [part for part in norm(question).replace("/", " ").replace("-", " ").split() if len(part) >= 3]
like_terms = terms[:8]
results = []

if table_exists("anexos_registros"):
    af, ap = scope("a")
    raw = rows("""
        SELECT a.id_anexo AS id, 'Anexo' AS tipo, a.nombre_archivo AS nombre, a.fecha_adjuntado AS fecha,
               a.id_comunidad, c.nombre AS comunidad, t.titulo AS tarea, p.nombre AS proyecto,
               CASE WHEN a.id_tarea IS NOT NULL THEN 'task' ELSE 'project' END AS entity_type,
               COALESCE(a.id_tarea, a.id_proyecto) AS entity_id
        FROM anexos_registros a
        LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
        LEFT JOIN tareas t ON t.id_tarea=a.id_tarea
        LEFT JOIN proyectos p ON p.id_proyecto=a.id_proyecto
        WHERE 1=1
    """ + af + " ORDER BY a.fecha_adjuntado DESC, a.id_anexo DESC LIMIT 250", tuple(ap))
    for row in raw:
        haystack = norm(" ".join(str(row.get(k) or "") for k in ["nombre", "comunidad", "tarea", "proyecto"]))
        score = sum(1 for term in like_terms if term in haystack)
        if not like_terms or score:
            row["score"] = score
            results.append(row)

if role != "Presidente" and table_exists("informes"):
    rf, rp = scope("i")
    raw = rows("""
        SELECT i.id_informe AS id, 'Informe' AS tipo,
               COALESCE(NULLIF(i.tipo_informe,''),'Informe') AS subtipo,
               i.archivo_word AS nombre, i.fecha_generacion AS fecha, i.observaciones,
               i.id_comunidad, c.nombre AS comunidad, p.nombre AS proyecto,
               'project' AS entity_type, i.id_proyecto AS entity_id
        FROM informes i
        LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad
        LEFT JOIN proyectos p ON p.id_proyecto=i.id_proyecto
        WHERE COALESCE(i.archivo_word,'')<>''
    """ + rf + " ORDER BY i.fecha_generacion DESC, i.id_informe DESC LIMIT 250", tuple(rp))
    for row in raw:
        row["nombre"] = os.path.basename(str(row.get("nombre") or "").replace("\\\\", "/"))
        try:
            metadata = json.loads(row.get("observaciones") or "{}")
        except (TypeError, ValueError):
            metadata = {}
        if metadata.get("tipo_entidad") in ("task", "tarea") and metadata.get("id_entidad"):
            row["entity_type"] = "task"
            row["entity_id"] = int(metadata.get("id_entidad") or 0)
            task = conn.execute("SELECT titulo FROM tareas WHERE id_tarea=?", (row["entity_id"],)).fetchone()
            if task:
                row["tarea"] = task["titulo"]
        haystack = norm(" ".join(str(row.get(k) or "") for k in ["nombre", "subtipo", "comunidad", "proyecto", "tarea"]))
        score = sum(1 for term in like_terms if term in haystack)
        if not like_terms or score:
            row["score"] = score
            results.append(row)

results.sort(key=lambda item: (int(item.get("score") or 0), str(item.get("fecha") or "")), reverse=True)
results = results[:60]
columns = ["Tipo", "Nombre", "Comunidad", "Relacionado", "Fecha"]
table_rows = []
for row in results:
    related = row.get("tarea") or row.get("proyecto") or ""
    table_rows.append({
        "Tipo": row.get("tipo") or "",
        "Nombre": row.get("nombre") or "",
        "Comunidad": row.get("comunidad") or "",
        "Relacionado": related,
        "Fecha": row.get("fecha") or "",
    })

answer = f"He encontrado {len(results)} documento(s) o informe(s) visibles para tu usuario."
if not results:
    answer = "No he encontrado documentos o informes visibles con esos criterios. Prueba con el nombre del archivo, proyecto, tarea o comunidad."

display = {
    "title": "Documentos e informes",
    "subtitle": "Resultados visibles segun tus permisos",
    "cards": [
        {"label": "Resultados", "value": str(len(results))},
        {"label": "Anexos", "value": str(sum(1 for row in results if row.get("tipo") == "Anexo"))},
        {"label": "Informes", "value": str(sum(1 for row in results if row.get("tipo") == "Informe"))},
    ],
    "tables": [{"title": "Resultados", "columns": columns, "rows": table_rows}],
}
conn.close()
print(json.dumps({
    "handled": True,
    "source": "local",
    "confidence": 0.82 if results else 0.48,
    "action": "consulta",
    "query_domain": "documentos_informes",
    "data_status": "confirmado" if results else "incompleto",
    "answer": answer,
    "display": display,
    "sources": [
        {"module": "documentos", "table": "anexos_registros", "description": "Anexos registrados en tareas y proyectos"},
        {"module": "informes", "table": "informes", "description": "Informes Word generados"},
    ],
    "facts": {"resultados": len(results)},
}, ensure_ascii=False))
`;
  return runPythonJson(script).then((result) => withAiProposalContract(result));
}

async function prepareAgentEntityReport(session, text) {
  if (reportsForbidden(session)) throw new Error("El perfil Presidente no tiene acceso a informes.");
  const center = await queryReportsCenter(session);
  const cleanText = String(text || "").trim();
  const normalized = normalizeText(cleanText);
  const typeHint = /\btarea\b/i.test(normalized) && !/\bproyecto\b/i.test(normalized) ? "task" : /\bproyecto\b/i.test(normalized) && !/\btarea\b/i.test(normalized) ? "project" : "";
  const entities = (center.entities || []).filter((row) => !typeHint || row.entity_type === typeHint);
  const candidates = entities
    .map((row) => ({
      type: row.entity_type,
      id: Number(row.entity_id),
      title: row.titulo,
      comunidad: row.comunidad || "",
      estado: row.estado || "",
      responsable: row.responsable || "",
      score: scoreTextMatch(cleanText, row.titulo),
    }))
    .filter((row) => row.id)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const best = candidates[0] || null;
  const confident = best && (best.score >= 2 || candidates.length === 1);
  const payload = confident ? {
    type: best.type,
    id: best.id,
    title: best.title,
    comunidad: best.comunidad,
    estado: best.estado,
    responsable: best.responsable,
  } : {};
  return {
    handled: true,
    source: "local",
    confidence: confident ? 0.82 : 0.46,
    action: "generar_informe_entidad",
    report_contract: "agent_report_prepare_v1",
    requires_confirmation: true,
    writes_data: false,
    allowed_write_endpoint: "/api/report/generate",
    query_domain: "documentos_informes",
    data_status: confident ? "confirmado" : "incompleto",
    answer: confident
      ? `He preparado la generacion del informe Word de ${best.type === "task" ? "la tarea" : "el proyecto"}: ${best.title}.`
      : "No he identificado con seguridad la tarea o proyecto del que quieres generar informe.",
    payload,
    candidates,
    questions: confident ? [] : ["Selecciona la tarea o proyecto exacto antes de generar el informe."],
    sources: [
      { module: "informes", table: "informes", description: "Registro de informes generados" },
      { module: "trabajo", table: "tareas/proyectos", description: "Elementos visibles para generar informe" },
    ],
    impact_summary: confident ? {
      title: `Generar informe Word: ${best.title}`,
      lines: [
        `Tipo: ${best.type === "task" ? "Tarea" : "Proyecto"}`,
        best.comunidad ? `Comunidad: ${best.comunidad}` : "",
        "El archivo se creara solo despues de confirmar.",
      ].filter(Boolean),
    } : null,
  };
}

function detectAgentIntent(text) {
  const cleanText = String(text || "").trim();
  if (!cleanText) {
    return {
      intent: "aclaracion",
      confidence: 0,
      reason: "No hay texto suficiente.",
      questions: ["Escribe una consulta, una actualizacion operativa o varios asuntos para preparar."],
    };
  }
  const normalized = normalizeText(cleanText);
  const segments = splitGuidedAutomationText(cleanText);
  if (segments.length > 1) {
    return {
      intent: "lote",
      confidence: 0.82,
      reason: "El texto contiene varios bloques o asuntos separados.",
      questions: [],
    };
  }
  const shortText = cleanText.length <= 420;
  const reportGeneration = /\b(generar|genera|sacar|saca|crear|crea|preparar|prepara)\b/i.test(normalized) && /\binforme\b/i.test(normalized);
  if (reportGeneration) {
    return {
      intent: "informe",
      confidence: 0.82,
      reason: "El mensaje solicita preparar o generar un informe.",
      questions: [],
    };
  }
  const emailDraft = /\b(email|correo|mail|outlook)\b/i.test(normalized)
    && /\b(texto|redacta|redactar|prepara|preparar|borrador|escribe|enviar|mandar|recordatorio|reclamacion|reclamar|comunicar|resumen|historico|historial|situacion|seguimiento)\b/i.test(normalized);
  if (emailDraft) {
    return {
      intent: "email",
      confidence: 0.84,
      reason: "El mensaje solicita preparar un borrador de comunicacion por email.",
      questions: [],
    };
  }
  const hasQuestion = /[?¿]/.test(cleanText) || /\b(cual|cuanto|cuando|quien|dime|busca|listado|lista|consulta|ensename|muestrame|muestra|balance|deuda|debe|adeuda|propietario|email|correo|presupuesto)\b/i.test(normalized);
  const debtOrOwnerQuery = /\b(deuda|morosidad|saldo pendiente|recibos? pendientes?|propietario|titular|email|correo|presupuesto|balance|disponible)\b/i.test(normalized);
  const operationalVerb = /\b(crea|crear|anade|anadir|añade|añadir|actualiza|actualizar|registra|registrar|seguimiento|incidencia|prepara accion|guardar|alta tarea|alta proyecto)\b/i.test(cleanText);
  const destructiveOrExternal = /\b(elimina|eliminar|borra|borrar|cambia titularidad|envia|enviar correo|manda correo|remesa|xml|certificado)\b/i.test(normalized);
  const operational = hasOperationalSignal(cleanText);
  if (destructiveOrExternal) {
    return {
      intent: "aclaracion",
      confidence: 0.58,
      reason: "La peticion parece sensible o todavia no tiene herramienta segura completa.",
      questions: ["Indica si quieres solo una consulta o que prepare una propuesta revisable sin guardar nada."],
    };
  }
  if ((shortText && hasQuestion) || debtOrOwnerQuery) {
    return {
      intent: "consulta",
      confidence: debtOrOwnerQuery ? 0.78 : 0.68,
      reason: "El mensaje parece pedir datos internos sin solicitar una escritura.",
      questions: [],
    };
  }
  if (operationalVerb || operational || cleanText.length > 700) {
    return {
      intent: "accion",
      confidence: operationalVerb ? 0.76 : 0.62,
      reason: "El texto parece describir una actuacion, incidencia o seguimiento operativo.",
      questions: [],
    };
  }
  return {
    intent: "aclaracion",
    confidence: 0.35,
    reason: "No se distingue con seguridad si es consulta o accion.",
    questions: ["Aclara si quieres consultar datos o preparar una accion revisable."],
  };
}

function normalizeAgentIntentDecision(raw, fallback) {
  const valid = new Set(["consulta", "accion", "lote", "informe", "email", "aclaracion"]);
  const intent = valid.has(String(raw?.intent || "")) ? String(raw.intent) : fallback.intent;
  const confidence = Math.max(0, Math.min(0.98, Number(raw?.confidence ?? fallback.confidence ?? 0.4)));
  return {
    intent,
    confidence,
    reason: String(raw?.reason || fallback.reason || "Clasificacion del agente.").slice(0, 1000),
    questions: Array.isArray(raw?.questions) ? raw.questions.map((question) => String(question || "").trim()).filter(Boolean).slice(0, 6) : (fallback.questions || []),
    source: raw?.source || aiExternalLabel(),
    ai_model: raw?.ai_model || "",
  };
}

async function externalAgentIntent(text, localDecision, tools) {
  if (!aiExternalAvailable()) return null;
  const system = [
    "Eres el router central de un agente de gestion de comunidades.",
    "Devuelve solo JSON valido.",
    "Clasifica la intencion del usuario, no ejecutes nada.",
    "Intenciones permitidas: consulta, accion, lote, informe, email, aclaracion.",
    "consulta: preguntas sobre propietarios, deuda, recibos, presupuesto, tareas, proyectos, documentos, seguridad, asambleas o datos internos.",
    "accion: crear/actualizar tarea/proyecto/incidencia o registrar seguimiento individual.",
    "lote: reunion, transcripcion larga o texto con muchos asuntos para dividir en propuestas revisables.",
    "informe: preparar o generar informe Word/acta/documento interno.",
    "email: redactar un texto o borrador para copiar/enviar por correo.",
    "aclaracion: cuando sea sensible, destructivo, externo o falten datos criticos.",
    "Nunca clasifiques como accion una pregunta del tipo cuanto debe, quien es propietario, listado de deuda, balance o presupuesto.",
    "Si el usuario pega una reunion larga con varios asuntos, usa lote.",
    "Formato exacto: {intent,confidence,reason,questions:[string]}",
  ].join("\n");
  return callExternalAiJson({
    system,
    purpose: "agent_router",
    maxTokens: 1200,
    timeoutMs: 60000,
    user: `Decision local inicial:\n${JSON.stringify(localDecision)}\n\nHerramientas disponibles:\n${JSON.stringify(tools)}\n\nMensaje del usuario:\n${String(text || "").slice(0, 30000)}`,
  });
}

async function decideAgentIntent(text, tools) {
  const local = detectAgentIntent(text);
  if (!aiExternalAvailable()) return { ...local, source: "local" };
  try {
    const external = normalizeAgentIntentDecision(await externalAgentIntent(text, local, tools), local);
    const localStrongQuery = local.intent === "consulta" && Number(local.confidence || 0) >= 0.72;
    if (localStrongQuery && external.intent !== "consulta") {
      return {
        ...local,
        source: "local_safety",
        external_intent_ignored: external,
        reason: `${local.reason} La IA externa proponia ${external.intent}, pero se mantiene consulta por seguridad.`,
      };
    }
    if (external.confidence >= 0.58 || local.confidence < 0.6) return external;
  } catch (error) {
    return {
      ...local,
      source: "local",
      external_router_warning: `${error.message}. Se usa router local.`,
    };
  }
  return { ...local, source: "local" };
}

function agentNeedsPreviousContext(text) {
  const normalized = normalizeText(text);
  return /\b(eso|ese|esa|este|esta|estos|estas|lo anterior|anterior|continua|sigue|sigamos|tambien|ademas|añadele|anadele|sumale|actualizalo|modificalo|hazlo|preparalo|incluye esto|sobre lo mismo)\b/i.test(normalized);
}

function agentContextExcerpt(value, limit = 1200) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.length > limit ? text.slice(0, limit - 3) + "..." : text;
}

function buildAgentContextualText(text, recentContext) {
  const cleanText = String(text || "").trim();
  const recent = Array.isArray(recentContext) ? recentContext : [];
  if (!cleanText || !agentNeedsPreviousContext(cleanText) || !recent.length) {
    return { text: cleanText, used: false, source: null };
  }
  const last = recent[0];
  const baseText = last.texto_contextual || last.texto_usuario || "";
  const contextual = [
    "Contexto conversacional anterior del usuario:",
    baseText,
    "",
    "Nueva instruccion del usuario:",
    cleanText,
  ].join("\n").slice(0, 10000);
  return { text: contextual, used: true, source: last };
}

function summarizeAgentResult(response) {
  const result = response?.result || {};
  const tool = response?.selected_tool || {};
  const bits = [
    response?.intent ? `Intencion: ${response.intent}` : "",
    tool.label ? `Herramienta: ${tool.label}` : "",
    result.action ? `Accion: ${result.action}` : "",
    result.answer ? agentContextExcerpt(result.answer, 700) : "",
  ].filter(Boolean);
  return bits.join(" | ").slice(0, 1800);
}

function compactAgentList(values, limit = 5) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function agentDataStatusLabel(status) {
  return {
    confirmado: "Dato confirmado",
    inferido: "Inferencia",
    incompleto: "Dato incompleto",
  }[status] || "Dato no clasificado";
}

function buildAgentGuidance(response) {
  const result = response?.result || {};
  const tool = response?.selected_tool || {};
  const payload = result.payload || {};
  const guidance = {
    contract: "agent_guidance_v1",
    summary: response?.message || result.answer || "Respuesta preparada.",
    confirmed_data: [],
    inferences: [],
    risks: [],
    questions: compactAgentList([...(response?.questions || []), ...(result.questions || [])], 8),
    review_focus: [],
    suggested_actions: [],
  };

  if (tool.label) {
    guidance.confirmed_data.push(`Herramienta seleccionada: ${tool.label}.`);
  }
  if (tool.status === "planned") {
    guidance.risks.push(tool.limitation || "La herramienta adecuada todavia esta planificada.");
    guidance.review_focus.push("No ejecutar esta peticion como una tarea comun hasta construir la herramienta segura.");
  }
  if (response?.conversation_context?.used) {
    guidance.inferences.push("Se ha usado el contexto reciente de la conversacion para interpretar la instruccion.");
    guidance.review_focus.push("Comprueba que el contexto anterior corresponde realmente al asunto actual.");
  }
  if (result.data_status) {
    const label = agentDataStatusLabel(result.data_status);
    if (result.data_status === "confirmado") guidance.confirmed_data.push(`${label}: la respuesta se basa en fuentes internas visibles para tu usuario.`);
    if (result.data_status === "inferido") guidance.inferences.push(`${label}: la respuesta combina datos internos y calculo o interpretacion.`);
    if (result.data_status === "incompleto") guidance.risks.push(`${label}: faltan datos para responder con plena seguridad.`);
  }
  if (Array.isArray(result.sources) && result.sources.length) {
    guidance.confirmed_data.push(`Fuentes internas usadas: ${result.sources.map((source) => source.module || source.table || "fuente").filter(Boolean).slice(0, 4).join(", ")}.`);
  }
  if (Number(response?.confidence || result.confidence || 0) < 0.55) {
    guidance.risks.push("Confianza baja: conviene concretar el propietario, propiedad, tarea, proyecto, periodo o documento.");
  }
  if (result.warning) {
    guidance.risks.push(String(result.warning));
  }

  if (response?.intent === "consulta") {
    guidance.review_focus.push("Verifica si la respuesta es un dato confirmado o una inferencia antes de usarla en una comunicacion externa.");
    if (result.display?.tables?.length) guidance.suggested_actions.push({ label: "Descargar tabla CSV", type: "export", enabled: true });
    if (result.query_domain === "deuda") guidance.suggested_actions.push({ label: "Preparar recordatorio o certificado como flujo guiado", type: "planned_email_or_document", enabled: false, reason: "Pendiente de herramienta segura de email/documentos." });
    if (result.query_domain === "trabajo") guidance.suggested_actions.push({ label: "Abrir ficha o preparar seguimiento revisable", type: "work_followup", enabled: true });
    if (result.query_domain === "documentos_informes") guidance.suggested_actions.push({ label: "Abrir documento o generar informe desde su modulo", type: "documents_reports", enabled: true });
    if (!guidance.suggested_actions.length) guidance.suggested_actions.push({ label: "Hacer una consulta mas concreta si necesitas detalle", type: "clarify", enabled: true });
  } else if (response?.intent === "accion") {
    const target = result.entity?.title || payload.titulo || "";
    if (target) guidance.confirmed_data.push(`Elemento propuesto: ${target}.`);
    if (result.action) guidance.confirmed_data.push(`Accion propuesta: ${result.action}.`);
    if (payload.comentario) guidance.review_focus.push("Revisa el comentario antes de guardar; debe quedar formal, claro y sin transcripcion literal innecesaria.");
    if (payload.proximo_paso) guidance.review_focus.push("Revisa que el proximo paso tenga responsable, accion concreta y fecha si procede.");
    if ((result.candidates || []).length > 1) guidance.risks.push("Hay varios candidatos posibles; confirma que la tarea o proyecto elegido es correcto.");
    guidance.suggested_actions.push({ label: "Revisar propuesta editable", type: "review_proposal", enabled: true });
    guidance.suggested_actions.push({ label: "Aplicar solo tras confirmacion", type: "confirm_write", enabled: true });
  } else if (response?.intent === "lote") {
    const total = result.total || (result.proposals || []).length || 0;
    const actionable = result.actionable || 0;
    guidance.confirmed_data.push(`Lote detectado: ${total} propuesta(s), ${actionable} aplicable(s).`);
    guidance.review_focus.push("Revisa cada tarjeta por separado y deja desmarcado lo dudoso.");
    guidance.risks.push("Un lote puede mezclar asuntos distintos; no apliques en bloque sin comprobar cada destino.");
    guidance.suggested_actions.push({ label: "Aplicar solo las tarjetas seleccionadas", type: "confirm_batch", enabled: true });
  } else if (response?.intent === "informe") {
    const target = payload.title || result.impact_summary?.title || "";
    if (target) guidance.confirmed_data.push(`Informe preparado para: ${target}.`);
    guidance.review_focus.push("Comprueba que el elemento, comunidad y tipo son correctos antes de generar el Word.");
    guidance.suggested_actions.push({ label: "Generar Word solo tras confirmacion", type: "confirm_report", enabled: true });
    if (!payload.id || !payload.type) guidance.risks.push("No hay un elemento unico identificado; selecciona una tarea o proyecto antes de generar.");
    if ((result.candidates || []).length > 1) guidance.risks.push("Hay varios candidatos posibles; revisa la lista antes de confirmar.");
  } else if (response?.intent === "email") {
    if (payload.recipient_name) guidance.confirmed_data.push(`Destinatario propuesto: ${payload.recipient_name}.`);
    if (payload.to) guidance.confirmed_data.push(`Email detectado: ${payload.to}.`);
    if (payload.subject) guidance.confirmed_data.push(`Asunto propuesto: ${payload.subject}.`);
    guidance.review_focus.push("Revisa el texto del email completo antes de copiarlo a Outlook.");
    guidance.review_focus.push("Comprueba importes, listado de recibos y fecha de vigencia antes de enviarlo.");
    guidance.suggested_actions.push({ label: "Copiar borrador revisado", type: "copy_email_draft", enabled: true });
    guidance.suggested_actions.push({ label: "Crear borrador real en Outlook", type: "outlook_draft", enabled: false, reason: "Siguiente capa: conector Outlook con confirmacion." });
  } else {
    guidance.review_focus.push("Aclara si quieres consultar datos, preparar una accion o esperar a una herramienta pendiente.");
    guidance.suggested_actions.push({ label: "Reformular instruccion", type: "clarify", enabled: true });
  }

  if (!guidance.confirmed_data.length) guidance.confirmed_data.push("No se ha guardado ningun cambio operativo.");
  if (!guidance.questions.length && result.data_status === "incompleto") guidance.questions.push("Dato exacto necesario para completar la respuesta.");
  return guidance;
}

async function answerAgentMessage(session, text) {
  const cleanText = String(text || "").trim();
  let recentContext = [];
  try {
    recentContext = (await runAgentContextCommand(session, "list", { limit: 8 })).context || [];
  } catch {
    recentContext = [];
  }
  const contextual = buildAgentContextualText(cleanText, recentContext);
  const effectiveText = contextual.text || cleanText;
  const availableTools = getAgentToolCatalog(session);
  const decision = await decideAgentIntent(effectiveText, availableTools);
  const selectedTool = selectAgentTool(session, effectiveText, decision.intent);
  const base = {
    ok: true,
    agent_contract: "agent_router_v1",
    context_contract: "agent_context_v1",
    intent: decision.intent,
    confidence: decision.confidence,
    reason: decision.reason,
    decision_source: decision.source || "local",
    decision_model: decision.ai_model || "",
    external_router_warning: decision.external_router_warning || "",
    external_intent_ignored: decision.external_intent_ignored || null,
    requires_confirmation: ["accion", "lote", "informe", "email"].includes(decision.intent),
    writes_data: false,
    tool: selectedTool?.endpoint || "",
    selected_tool: selectedTool,
    available_tools: availableTools,
    conversation_context: {
      used: contextual.used,
      recent_count: recentContext.length,
      source_id: contextual.source?.id_contexto || null,
      source_intent: contextual.source?.intent || "",
      source_summary: contextual.source?.resumen_respuesta || "",
    },
    questions: decision.questions || [],
    message: "",
    result: null,
  };
  const finalize = async (response) => {
    response.guidance = buildAgentGuidance(response);
    if (["accion", "lote", "informe", "email"].includes(response.intent) && response.result) {
      try {
        const savedAction = await runAgentActionsCommand(session, "save", {
          texto_usuario: cleanText,
          intent: response.intent,
          titulo: response.result?.payload?.titulo || response.result?.entity?.title || response.result?.answer || response.intent,
          resumen: summarizeAgentResult(response),
          proposal: response.result,
        });
        if (savedAction?.id_propuesta) response.action_center_id = savedAction.id_propuesta;
      } catch (error) {
        response.action_warning = "La propuesta se ha preparado, pero no se pudo guardar en la bandeja de acciones: " + error.message;
      }
    }
    try {
      await runAgentContextCommand(session, "save", {
        texto_usuario: cleanText,
        texto_contextual: effectiveText,
        intent: response.intent,
        selected_tool: response.selected_tool || selectedTool || {},
        resumen_respuesta: summarizeAgentResult(response),
        payload: {
          message: response.message || "",
          reason: response.reason || "",
          result_action: response.result?.action || "",
          result_answer: agentContextExcerpt(response.result?.answer || "", 1200),
          context_used: response.conversation_context?.used || false,
        },
      });
    } catch (error) {
      response.context_warning = "La respuesta se ha generado, pero no se pudo guardar el contexto conversacional: " + error.message;
    }
    return response;
  };
  if (selectedTool?.status === "planned" && !selectedTool.endpoint) {
    return finalize({
      ...base,
      intent: "aclaracion",
      requires_confirmation: false,
      message: "He identificado la herramienta adecuada, pero todavia esta planificada y no se puede ejecutar con seguridad.",
      result: {
        action: "revisar_manual",
        answer: `${selectedTool.label}. ${selectedTool.limitation || "Pendiente de implementacion segura."}`,
        questions: ["Quieres que lo dejemos anotado como siguiente herramienta interna del agente?"],
      },
    });
  }
  if (decision.intent === "consulta" && ["documents.lookup", "reports.lookup"].includes(selectedTool?.id || "")) {
    const result = await queryAgentDocumentsReports(session, effectiveText);
    return finalize({
      ...base,
      tool: selectedTool?.endpoint || "/api/agent/documents/query",
      message: contextual.used
        ? "He consultado documentos e informes usando el contexto reciente. No se ha guardado ningun cambio."
        : "He consultado documentos e informes visibles para tu usuario. No se ha guardado ningun cambio.",
      result,
    });
  }
  if (decision.intent === "consulta") {
    const result = await answerAiQuery(session, effectiveText);
    return finalize({
      ...base,
      tool: selectedTool?.endpoint || "/api/ai/query",
      message: contextual.used
        ? "He tratado el mensaje como consulta usando el contexto reciente. La respuesta queda guardada en el historial de consultas IA."
        : "He tratado el mensaje como consulta. La respuesta queda guardada en el historial de consultas IA.",
      result,
    });
  }
  if (decision.intent === "informe") {
    const result = await prepareAgentEntityReport(session, effectiveText);
    return finalize({
      ...base,
      tool: selectedTool?.endpoint || "/api/report/generate",
      message: result.data_status === "confirmado"
        ? "He preparado el informe Word. Revisa el elemento detectado y confirma antes de generarlo."
        : "Necesito que selecciones la tarea o proyecto exacto antes de generar el informe.",
      result,
    });
  }
  if (decision.intent === "email") {
    const result = await prepareAgentEmailDraft(session, effectiveText);
    return finalize({
      ...base,
      tool: selectedTool?.endpoint || "/api/agent/email/draft",
      message: "He preparado un borrador de email revisable. No se ha enviado nada ni se ha creado ningun borrador en Outlook.",
      result,
    });
  }
  if (decision.intent === "accion") {
    const result = await analyzeOperationalWithAi(session, effectiveText);
    return finalize({
      ...base,
      tool: selectedTool?.endpoint || "/api/ai/operate",
      message: result.queryDetected
        ? "El agente ha detectado que parece una consulta. No se ha guardado nada."
        : contextual.used
          ? "He preparado una propuesta editable usando el contexto reciente. Revisa y confirma antes de guardar."
          : "He preparado una propuesta editable. Revisa y confirma antes de guardar.",
      result,
    });
  }
  if (decision.intent === "lote") {
    const result = await analyzeGuidedAutomationBatch(session, effectiveText);
    return finalize({
      ...base,
      tool: selectedTool?.endpoint || "/api/ai/batch-operate",
      message: "He preparado un lote revisable. Nada se guarda hasta que confirmes las tarjetas seleccionadas.",
      result,
    });
  }
  return finalize({
    ...base,
    message: "Necesito una aclaracion antes de preparar una accion o consulta.",
    result: {
      action: "revisar_manual",
      answer: "No se ha guardado nada. Indica si quieres consultar informacion o preparar una propuesta editable.",
      questions: decision.questions || [],
    },
  });
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

async function queryEntityDetail(session, type, id) {
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
reports = []
if role != "Presidente":
    report_rows = [dict(r) for r in conn.execute("""
        SELECT id_informe, fecha_generacion, tipo_informe, id_proyecto, archivo_word, observaciones, usuario
        FROM informes
        WHERE COALESCE(archivo_word,'') <> ''
        ORDER BY fecha_generacion DESC, id_informe DESC
        LIMIT 500
    """)]
    for report in report_rows:
        metadata = {}
        try:
            metadata = json.loads(report.get("observaciones") or "{}")
        except Exception:
            metadata = {}
        direct_project = entity_type == "project" and int(report.get("id_proyecto") or 0) == entity_id
        metadata_match = (
            str(metadata.get("tipo_entidad") or "") == ("tarea" if entity_type == "task" else "proyecto")
            and int(metadata.get("id_entidad") or 0) == entity_id
        )
        if direct_project or metadata_match:
            report["metadata"] = metadata
            reports.append(report)
        if len(reports) >= 12:
            break
conn.close()
print(json.dumps({"item": dict(item), "history": history, "attachments": attachments, "reports": reports}, ensure_ascii=False))
`;
  const result = await runPythonJson(script);
  result.attachments = (result.attachments || []).map((row) => {
    const filePath = resolveAttachmentPath(row.ruta_archivo);
    const extension = path.extname(row.nombre_archivo || row.ruta_archivo || "").toLowerCase();
    return {
      ...row,
      available: Boolean(filePath),
      previewable: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt"].includes(extension)
    };
  });
  return result;
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
    .navGroup { border:1px solid var(--line); border-radius:8px; background:var(--surface-soft); padding:6px; }
    .navGroup summary { cursor:pointer; font-weight:800; color:#1f2937; padding:8px 9px; list-style:none; }
    .navGroup summary::-webkit-details-marker { display:none; }
    .navGroup summary::after { content:"+"; float:right; font-weight:900; }
    .navGroup[open] summary::after { content:"-"; }
    .navGroupBody { display:grid; gap:7px; margin-top:5px; }
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
    .communityScopeChoices { display:grid; gap:8px; }
    .communityScopeChoice { border:1px solid var(--line); border-radius:8px; padding:11px; display:flex; gap:10px; align-items:flex-start; cursor:pointer; background:white; }
    .communityScopeChoice:has(input:checked) { border-color:#2563eb; background:#eff6ff; box-shadow:inset 4px 0 #2563eb; }
    .communityScopeChoice input { width:19px; min-height:19px; margin-top:2px; }
    .detailGrid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:8px; }
    .detailBox { background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:9px; font-size:13px; }
    .detailBox strong { display:block; margin-bottom:3px; }
    .entityBrief { display:grid; gap:12px; border-left:6px solid var(--blue); }
    .entityBriefTop { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; }
    .entityBriefTop h2 { font-size:20px; }
    .entityBriefNext { background:#f8fafc; border:1px solid #dbe3ee; border-radius:8px; padding:11px; display:grid; gap:7px; }
    .entityBriefNext strong { display:block; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.02em; }
    .entityBriefNext p { margin:0; line-height:1.45; white-space:pre-wrap; }
    .entityBriefStats { display:grid; grid-template-columns:repeat(3,minmax(110px,1fr)); gap:8px; }
    .entityBriefStat { border:1px solid #e2e8f0; border-radius:8px; padding:9px; background:white; }
    .entityBriefStat span { display:block; color:var(--muted); font-size:12px; font-weight:700; }
    .entityBriefStat strong { display:block; margin-top:3px; font-size:16px; overflow-wrap:anywhere; }
    textarea { width:100%; min-height:110px; resize:vertical; border:1px solid #cbd5e1; border-radius:6px; padding:10px 11px; font:14px Segoe UI, Arial, sans-serif; }
    .quickRecord { background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:12px; margin:10px 0 12px; }
    .quickRecord h3 { margin:0 0 6px; font-size:16px; }
    .quickRecord textarea { min-height:170px; background:white; }
    .formGrid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:9px; }
    .history { display:grid; gap:8px; }
    .historyItem { position:relative; border:1px solid #e2e8f0; border-left:5px solid #94a3b8; border-radius:8px; padding:10px; background:#fff; }
    .historyItem h4 { margin:0 0 6px; font-size:14px; display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; }
    .historyItem p { margin:5px 0 0; white-space:pre-wrap; line-height:1.35; }
    .historyItem.decision { border-left-color:#b45309; background:#fffbeb; }
    .historyItem.risk { border-left-color:#b91c1c; background:#fff5f5; }
    .historyComment { font-size:14px; }
    .historyNext { background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:8px; }
    .attachmentGrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:9px; }
    .attachmentCard { border:1px solid #e2e8f0; border-radius:8px; padding:10px; background:white; display:grid; gap:8px; min-width:0; }
    .attachmentCard h4 { margin:0; font-size:14px; overflow-wrap:anywhere; }
    .attachmentPreview { width:100%; height:128px; object-fit:cover; border-radius:6px; background:#f1f5f9; border:1px solid #e2e8f0; }
    .attachmentIcon { height:86px; display:grid; place-items:center; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; color:#475569; font-weight:800; font-size:13px; }
    .uploadBox { border:2px dashed #94a3b8; border-radius:8px; padding:12px; background:#f8fafc; display:grid; gap:9px; }
    .uploadBox input { width:100%; }
    .entityReportList { display:grid; gap:8px; }
    .entityReportItem { border:1px solid #e2e8f0; border-radius:8px; background:white; padding:10px; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; }
    .entityReportItem h4 { margin:0 0 4px; font-size:14px; overflow-wrap:anywhere; }
    .reportMessage { min-height:20px; }
    .tabBadge { min-width:24px; text-align:center; border-radius:999px; padding:2px 7px; background:#dbeafe; color:#1e3a8a; font-size:12px; font-weight:800; }
    .tabBadge.alert { background:#fee2e2; color:#991b1b; }
    .workflowCard { border-left-color:#2563eb; }
    .workflowCard.overdue { border-left-color:#b91c1c; }
    .workflowCard.thirdParty { border-left-color:#c2410c; }
    .automationPanel { border:1px solid var(--line); border-radius:8px; background:white; padding:12px; margin-bottom:12px; }
    .automationList { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:9px; }
    .automationCard { border:1px solid #e2e8f0; border-left:5px solid #2563eb; border-radius:8px; background:#fff; padding:11px; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:start; min-width:0; }
    .automationCard.risk { border-left-color:#b91c1c; background:#fffafa; }
    .automationCard.warning { border-left-color:#c2410c; background:#fff7ed; }
    .automationCard.info { border-left-color:#2563eb; background:#f8fbff; }
    .automationCard.success { border-left-color:#15803d; background:#f0fdf4; }
    .automationCard h3 { margin:0 0 5px; font-size:15px; overflow-wrap:anywhere; }
    .automationCard .line { font-size:13px; line-height:1.35; overflow-wrap:anywhere; }
    .automationCardActions { display:grid; gap:7px; justify-items:end; align-content:start; }
    .automationCardActions button { min-height:34px; padding:7px 10px; white-space:nowrap; }
    .notificationCard { min-height:0; }
    .notificationCard.unread { border-left-color:#2563eb; background:#f8fbff; }
    .notificationCard.read { opacity:.78; }
    .reviewSummary { display:grid; grid-template-columns:repeat(5,minmax(120px,1fr)); gap:8px; margin-bottom:12px; }
    .reviewSummary .count { min-height:82px; }
    .workflowControls { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; margin-bottom:12px; }
    .specialPanel { display:block; min-width:0; }
    .decisionBox { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px; }
    .dangerText { color:#991b1b; font-weight:700; }
    .aiHub { display:grid; gap:16px; grid-column:1 / -1; }
    .aiQueryLayout { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(280px,.65fr); gap:14px; align-items:start; }
    .aiBox { display:grid; gap:12px; border:1px solid var(--line); border-radius:8px; padding:16px; background:var(--surface); }
    .aiAgentBox { border-left:6px solid #7c3aed; background:#fbfaff; }
    .aiQueryBox { border-left:6px solid var(--blue); }
    .aiOperationBox { border-left:6px solid var(--green); }
    .aiSectionHead { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; flex-wrap:wrap; }
    .aiSectionHead h2 { margin:0; }
    .aiSectionHead p { margin:4px 0 0; color:var(--muted); font-size:13px; }
    .aiInput { min-height:180px; resize:vertical; }
    .aiAgentInput { min-height:132px; }
    .aiQueryInput { min-height:105px; }
    .agentDecision { background:white; border:1px solid #ddd6fe; border-radius:8px; padding:12px; display:grid; gap:8px; }
    .agentDecisionHead { display:flex; justify-content:space-between; gap:10px; align-items:center; flex-wrap:wrap; }
    .agentDecisionHead h3 { margin:0; font-size:18px; }
    .agentDecision p { margin:0; color:var(--muted); }
    .agentToolsList { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; }
    .agentToolCard { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:10px; display:grid; gap:5px; }
    .agentToolCard.planned { background:#fff7ed; border-color:#fed7aa; }
    .agentToolCard strong { overflow-wrap:anywhere; }
    .agentToolMeta { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .agentContextList { display:grid; gap:8px; }
    .agentContextItem { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:10px; display:grid; gap:5px; }
    .agentContextItem strong { overflow-wrap:anywhere; }
    .agentGuidanceGrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:8px; }
    .agentGuidanceCard { background:white; border:1px solid #e2e8f0; border-radius:8px; padding:10px; display:grid; gap:6px; }
    .agentGuidanceCard h4 { margin:0; font-size:14px; }
    .agentGuidanceCard ul { margin:0; padding-left:18px; display:grid; gap:4px; }
    .agentGuidanceCard li { line-height:1.35; overflow-wrap:anywhere; }
    .agentGuidanceCard.risk { border-color:#fecaca; background:#fffafa; }
    .agentGuidanceCard.inference { border-color:#fde68a; background:#fffbeb; }
    .agentGuidanceCard.confirmed { border-color:#bbf7d0; background:#f0fdf4; }
    .proposalUnderstanding { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:8px; }
    .proposalUnderstandingCard { background:white; border:1px solid #dbeafe; border-radius:8px; padding:10px; display:grid; gap:5px; }
    .proposalUnderstandingCard strong { font-size:13px; color:#1e3a8a; }
    .proposalUnderstandingCard span { font-size:13px; line-height:1.35; overflow-wrap:anywhere; }
    .candidateSelector { background:white; border:1px solid #fde68a; border-radius:8px; padding:10px; display:grid; gap:8px; }
    .candidateSelectorList { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:8px; }
    .candidateOption { border:1px solid var(--line); border-left:5px solid #f59e0b; border-radius:8px; background:#fff; padding:10px; display:grid; gap:6px; text-align:left; color:var(--ink); }
    .candidateOption.active { border-color:#2563eb; border-left-color:#2563eb; background:#eff6ff; }
    .candidateOption h4 { margin:0; font-size:14px; overflow-wrap:anywhere; }
    .candidateOption button { justify-self:start; padding:7px 10px; min-height:32px; }
    .agentActionsList { display:grid; gap:8px; }
    .agentActionItem { background:white; border:1px solid var(--line); border-left:5px solid #7c3aed; border-radius:8px; padding:10px; display:grid; gap:6px; }
    .agentActionItem.managed { opacity:.65; border-left-color:#94a3b8; }
    .agentActionItem h4 { margin:0; font-size:15px; overflow-wrap:anywhere; }
    .agentActionMeta { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
    .aiHistoryPanel { border:1px solid var(--line); border-radius:8px; background:var(--surface); overflow:hidden; }
    .aiHistoryHead { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:13px 14px; border-bottom:1px solid var(--line); }
    .aiHistoryHead h2 { margin:0; font-size:17px; }
    .aiHistoryList { max-height:520px; overflow:auto; }
    .aiHistoryRow { display:block; width:100%; padding:12px 14px; border:0; border-bottom:1px solid var(--line); border-radius:0; background:transparent; color:var(--ink); text-align:left; }
    .aiHistoryRow:hover, .aiHistoryRow.active { background:#eef5f7; }
    .aiHistoryQuestion { display:block; font-weight:800; line-height:1.3; overflow-wrap:anywhere; }
    .aiHistoryMeta { display:flex; justify-content:space-between; gap:8px; margin-top:5px; color:var(--muted); font-size:11px; }
    .aiHistoryEmpty { padding:18px 14px; color:var(--muted); }
    .aiHistoryActions { display:flex; gap:6px; }
    .aiHistoryActions button { padding:7px 9px; min-height:34px; }
    .aiRulesList { display:grid; gap:10px; }
    .aiRuleCard { background:white; border:1px solid var(--line); border-radius:8px; padding:12px; display:grid; gap:8px; }
    .aiRuleCard.inactive { opacity:.65; background:#f8fafc; }
    .aiRuleHead { display:flex; justify-content:space-between; gap:8px; align-items:center; }
    .aiRuleMeta { display:flex; flex-wrap:wrap; gap:8px; color:var(--muted); font-size:12px; }
    .aiMemoryApplied { background:#eefdf5; border-color:#bbf7d0; color:#14532d; }
    .checkLine { display:flex; gap:8px; align-items:center; font-weight:700; color:#334155; }
    .checkLine input { width:18px; height:18px; }
    .aiBatchList { display:grid; gap:12px; }
    .aiBatchCard { border:1px solid var(--line); border-radius:8px; background:white; padding:12px; display:grid; gap:10px; }
    .aiBatchCard.disabled { opacity:.62; background:#f8fafc; }
    .aiBatchHead { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
    .aiBatchHead h3 { margin:0 0 4px; font-size:17px; overflow-wrap:anywhere; }
    .aiBatchHead p { margin:0; max-width:920px; }
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
    .answerTableWrap summary { cursor:pointer; display:flex; justify-content:space-between; gap:8px; align-items:center; font-weight:800; }
    .answerTableWrap[open] summary { margin-bottom:9px; }
    .answerTableWrap summary h3 { margin:0; }
    .answerTableTools { display:flex; justify-content:space-between; gap:8px; align-items:center; margin:8px 0; flex-wrap:wrap; }
    .answerTableTools button { padding:7px 10px; min-height:34px; }
    .answerTable { width:100%; border-collapse:collapse; font-size:13px; min-width:560px; }
    .answerTable th, .answerTable td { border-bottom:1px solid #e2e8f0; padding:8px; text-align:left; vertical-align:top; }
    .answerTable th { background:#f8fafc; color:#334155; font-size:12px; }
    .answerNote { background:#fff7ed; border:1px solid #fed7aa; border-radius:8px; padding:10px; color:#7c2d12; }
    .copilotFab { position:fixed; right:18px; bottom:18px; z-index:26; border-radius:999px; padding:12px 16px; box-shadow:0 16px 36px rgba(15,23,42,.22); display:flex; gap:8px; align-items:center; }
    .copilotFab.hidden { display:none; }
    .copilotBackdrop { position:fixed; inset:0; background:rgba(15,23,42,.26); z-index:35; opacity:1; transition:opacity .16s ease; }
    .copilotBackdrop.hidden { display:none; }
    .copilotPanel { position:fixed; top:0; right:0; height:100vh; width:min(520px,100%); background:white; border-left:1px solid var(--line); z-index:36; box-shadow:-22px 0 52px rgba(15,23,42,.2); display:grid; grid-template-rows:auto 1fr; }
    .copilotPanel.hidden { display:none; }
    .copilotHead { padding:15px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .copilotHead h2 { font-size:20px; }
    .copilotBody { padding:14px; overflow:auto; display:grid; gap:12px; align-content:start; }
    .copilotContext { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px; font-size:13px; color:#334155; white-space:pre-wrap; max-height:155px; overflow:auto; }
    .copilotInput { min-height:150px; }
    .copilotQuickActions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
    .copilotQuickActions button { min-height:40px; padding:8px 9px; }
    .copilotResult { display:grid; gap:10px; }
    .copilotResult .answerHero h3 { font-size:18px; }
    .copilotResultActions { display:flex; gap:8px; flex-wrap:wrap; }
    .copilotResultActions button { flex:1 1 150px; }
    .navDivider { height:1px; background:#dbe3ee; margin:3px 0; grid-column:1 / -1; }
    .homeHero { border:1px solid #bfdbfe; border-left:6px solid var(--blue); background:#f8fbff; border-radius:8px; padding:16px; margin-bottom:12px; display:flex; justify-content:space-between; gap:16px; align-items:center; }
    .homeHero h2 { font-size:23px; }
    .homeHero p { margin:5px 0 0; color:var(--muted); }
    .homeActions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .homeMetrics { grid-template-columns:repeat(4,minmax(130px,1fr)); margin-bottom:14px; }
    .attentionList { display:grid; gap:8px; }
    .attentionRow { display:grid; grid-template-columns:minmax(190px,1.4fr) minmax(140px,.8fr) minmax(130px,.7fr) auto; gap:10px; align-items:center; border-bottom:1px solid #e2e8f0; padding:10px 2px; }
    .attentionRow:last-child { border-bottom:0; }
    .attentionTitle { font-weight:800; overflow-wrap:anywhere; }
    .mapBoard { display:grid; gap:13px; }
    .mapSection { border:1px solid var(--line); border-radius:8px; background:#f8fafc; overflow:hidden; }
    .mapSectionHead { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:11px 13px; background:white; border-bottom:1px solid var(--line); }
    .mapSectionHead h3 { margin:0; font-size:17px; }
    .mapSectionBody { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; padding:10px; }
    .mapCard { min-height:0; cursor:pointer; }
    .mapCard.selected { border-color:#2563eb; box-shadow:0 0 0 2px #bfdbfe; }
    .mapCardActions { display:none; padding-top:8px; border-top:1px solid #e2e8f0; }
    .mapCard.selected .mapCardActions { display:flex; }
    .workTodayShell { display:grid; gap:14px; }
    .workTodayHero {
      border:1px solid #cbd5e1;
      border-left:6px solid var(--green);
      background:white;
      border-radius:8px;
      padding:15px;
      display:flex;
      justify-content:space-between;
      gap:14px;
      align-items:center;
    }
    .workTodayHero h2 { margin:0; font-size:22px; }
    .workTodayHero p { margin:5px 0 0; color:var(--muted); }
    .workTodaySummary { display:grid; grid-template-columns:repeat(4,minmax(130px,1fr)); gap:10px; }
    .workTodayGrid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; align-items:start; }
    .workTodayPanel {
      border:1px solid var(--line);
      border-radius:8px;
      background:white;
      padding:12px;
      min-width:0;
      display:grid;
      gap:10px;
    }
    .workTodayPanel .contentHead { margin-bottom:0; }
    .workTodayPanel h2 { margin:0; font-size:17px; }
    .workTodayList { display:grid; gap:9px; }
    .searchControls { display:grid; grid-template-columns:minmax(260px,1fr) 190px 230px auto; gap:9px; align-items:end; margin-bottom:12px; }
    .resultList { display:grid; gap:9px; }
    .resultCard { min-height:0; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; }
    .resultCard h3 { margin:0 0 6px; }
    .documentControls { display:grid; grid-template-columns:minmax(220px,1fr) 190px 230px; gap:9px; margin-bottom:12px; }
    .documentGrid { display:grid; grid-template-columns:repeat(auto-fill,minmax(255px,1fr)); gap:10px; }
    .documentCard { border:1px solid var(--line); border-radius:8px; background:white; padding:10px; display:grid; gap:8px; min-width:0; }
    .documentCard h3 { margin:0; font-size:15px; overflow-wrap:anywhere; }
    .documentPreview { width:100%; height:145px; object-fit:cover; border:1px solid #e2e8f0; border-radius:6px; background:#f8fafc; }
    .documentFileIcon { height:104px; display:grid; place-items:center; border:1px solid #e2e8f0; border-radius:6px; background:#f8fafc; font-weight:900; font-size:18px; color:#475569; }
    .importShell { display:grid; gap:12px; }
    .importControls { display:grid; grid-template-columns:220px 240px minmax(220px,1fr); gap:9px; }
    .importSource { min-height:240px; }
    .importProposalList { display:grid; gap:11px; }
    .importProposal { border:1px solid var(--line); border-left:6px solid var(--blue); border-radius:8px; background:white; padding:12px; display:grid; gap:10px; }
    .importProposal.disabled { opacity:.58; border-left-color:#94a3b8; }
    .importProposalHead { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .importProposalHead h3 { margin:0; }
    .importProposalGrid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
    .historicalRows { display:grid; gap:8px; }
    .historicalRow { display:grid; grid-template-columns:135px 150px minmax(260px,1fr) minmax(220px,.8fr); gap:8px; border-top:1px solid #e2e8f0; padding-top:8px; }
    .reportLayout { display:grid; gap:12px; }
    .reportControls { display:grid; grid-template-columns:minmax(220px,1fr) 200px 230px; gap:9px; }
    .reportList { display:grid; gap:8px; }
    .reportRow { border:1px solid var(--line); border-radius:8px; padding:10px; background:white; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; }
    .reportRow h3 { margin:0 0 5px; font-size:15px; overflow-wrap:anywhere; }
    .entitySelector { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:8px; max-height:520px; overflow:auto; padding:2px; }
    .entityChoice { border:1px solid var(--line); border-radius:8px; padding:10px; background:white; display:grid; grid-template-columns:auto 1fr; gap:9px; align-items:start; cursor:pointer; }
    .entityChoice.selected { border-color:#2563eb; background:#eff6ff; }
    .entityChoice input { width:18px; min-height:18px; margin:2px 0 0; }
    .assemblyList { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:10px; }
    .assemblyCard { border:1px solid var(--line); border-left:6px solid #0f766e; border-radius:8px; padding:12px; background:white; cursor:pointer; display:grid; gap:8px; }
    .assemblyCard h3 { margin:0; font-size:17px; }
    .assemblyShell { display:grid; gap:12px; }
    .assemblyHeader { border:1px solid #a7f3d0; border-left:6px solid #047857; border-radius:8px; padding:14px; background:#f0fdf4; display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .assemblyHeader h2 { margin:0; font-size:22px; }
    .assemblyTabs { display:flex; gap:6px; flex-wrap:wrap; border-bottom:1px solid var(--line); padding-bottom:9px; }
    .assemblyTabs button { background:#e2e8f0; color:#334155; }
    .assemblyTabs button.active { background:#0f766e; color:white; }
    .assemblyMetrics { display:grid; grid-template-columns:repeat(6,minmax(115px,1fr)); gap:8px; }
    .assemblyMetrics .count { min-height:78px; }
    .assemblySplit { display:grid; grid-template-columns:minmax(280px,.8fr) minmax(0,1.4fr); gap:12px; align-items:start; }
    .assemblyPane { border:1px solid var(--line); border-radius:8px; padding:12px; background:white; min-width:0; }
    .assemblyPane h3 { margin:0 0 10px; }
    .minutesLayout { display:grid; gap:12px; }
    .minutesReadiness { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px; }
    .minutesCheck { display:flex; align-items:flex-start; gap:8px; padding:9px 10px; border:1px solid var(--line); border-radius:6px; background:#f8fafc; }
    .minutesCheck.ok { border-color:#a7d7c5; background:#f0fdf4; }
    .minutesCheck.warn { border-color:#f2c48d; background:#fff7ed; }
    .minutesCheck strong { display:block; font-size:13px; }
    .minutesCheck span { font-size:12px; color:var(--muted); }
    .minutesSourceGrid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(280px,.75fr); gap:12px; align-items:start; }
    .minutesTranscript { min-height:260px; resize:vertical; }
    .minutesPoint { border:1px solid var(--line); border-left:5px solid var(--teal); border-radius:7px; padding:12px; background:#fff; display:grid; gap:10px; }
    .minutesPointHead { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
    .minutesPointHead h3 { margin:0; font-size:16px; }
    .minutesLocked { padding:8px 10px; border-radius:6px; background:#eef5f7; color:#164e63; font-size:12px; font-weight:700; }
    .minutesLanguages { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .minutesLanguages textarea { min-height:120px; }
    .minutesWarningList { margin:0; padding-left:20px; color:#92400e; }
    .agendaList, .attendanceList, .voteGroups { display:grid; gap:8px; }
    .agendaItem { border:1px solid var(--line); border-radius:8px; padding:10px; background:white; display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:10px; align-items:start; }
    .agendaNumber { width:30px; height:30px; border-radius:50%; background:#0f766e; color:white; display:grid; place-items:center; font-weight:900; }
    .attendanceRow { border-bottom:1px solid #e2e8f0; padding:9px 0; display:grid; grid-template-columns:minmax(190px,1.2fr) minmax(120px,.6fr) minmax(150px,.8fr) auto; gap:8px; align-items:center; }
    .attendanceRow:last-child { border-bottom:0; }
    .ownerResults { max-height:340px; overflow:auto; border:1px solid var(--line); border-radius:8px; }
    .ownerChoice { display:flex; gap:8px; align-items:flex-start; padding:8px; border-bottom:1px solid #e2e8f0; }
    .ownerChoice:last-child { border-bottom:0; }
    .ownerChoice input { width:18px; min-height:18px; }
    .votePointSelect { display:grid; grid-template-columns:minmax(260px,1fr) auto; gap:10px; align-items:end; }
    .voteSummary { display:grid; grid-template-columns:repeat(4,minmax(120px,1fr)); gap:8px; }
    .voteSummary .answerCard strong { font-size:18px; }
    .voteGroup { border:1px solid var(--line); border-radius:8px; background:white; overflow:hidden; }
    .voteGroupHead { padding:10px; background:#f8fafc; display:flex; justify-content:space-between; gap:10px; align-items:center; }
    .voteMember { display:grid; grid-template-columns:minmax(200px,1fr) 110px minmax(280px,auto); gap:10px; align-items:center; padding:9px 10px; border-top:1px solid #e2e8f0; }
    .voteActions { display:flex; gap:5px; flex-wrap:wrap; }
    .voteActions button { min-width:56px; padding:7px 9px; background:#e2e8f0; color:#334155; }
    .voteActions button.active-si { background:#15803d; color:white; }
    .voteActions button.active-no { background:#b91c1c; color:white; }
    .voteActions button.active-abs { background:#a16207; color:white; }
    .voteActions button.active-sin { background:#64748b; color:white; }
    .lockedVote { color:#7c3aed; font-weight:800; font-size:12px; }
    .pointEditor { display:grid; grid-template-columns:42px minmax(240px,1fr) 170px auto; gap:8px; align-items:end; border-bottom:1px solid #e2e8f0; padding:8px 0; }
    .adminMetrics { display:grid; grid-template-columns:repeat(4,minmax(130px,1fr)); gap:8px; }
    .adminLayout { display:grid; grid-template-columns:minmax(280px,.8fr) minmax(420px,1.3fr); gap:12px; align-items:start; }
    .adminList { display:grid; gap:7px; max-height:560px; overflow:auto; }
    .adminUserListItem { display:grid; gap:6px; }
    .adminRow { width:100%; text-align:left; border:1px solid var(--line); background:white; color:var(--text); padding:10px; display:grid; gap:5px; }
    .adminRow.selected { border-color:#2563eb; background:#eff6ff; box-shadow:inset 4px 0 #2563eb; }
    .adminRow.inactive { opacity:.6; }
    .adminInlineActions { display:flex; flex-wrap:wrap; gap:7px; padding:0 4px 7px 8px; border-left:4px solid var(--blue); }
    .communityChecks { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; border:1px solid var(--line); border-radius:8px; padding:9px; max-height:230px; overflow:auto; }
    .communityCheck { display:flex; gap:8px; align-items:flex-start; padding:6px; }
    .communityCheck input { width:18px; min-height:18px; }
    .temporaryKey { border:2px solid #16a34a; background:#f0fdf4; border-radius:8px; padding:12px; display:grid; gap:7px; }
    .temporaryKey code { font-size:20px; font-weight:900; letter-spacing:1px; }
    .securityShell { display:grid; gap:12px; }
    .securityLookup { border:1px solid var(--line); border-radius:8px; padding:14px; background:white; display:grid; gap:10px; }
    .securityLookupBar { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; }
    .securityLookupResults { display:grid; grid-template-columns:repeat(auto-fill,minmax(290px,1fr)); gap:9px; }
    .securityLookupCard { border:1px solid #dbe3ee; border-radius:8px; padding:11px; display:grid; gap:9px; background:#f8fafc; min-width:0; }
    .securityLookupCardHead { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
    .securityLookupCard h3 { margin:0; font-size:16px; overflow-wrap:anywhere; }
    .securityPropertyList { display:flex; flex-wrap:wrap; gap:6px; }
    .securityPropertyChip { border:1px solid #cbd5e1; background:white; border-radius:999px; padding:4px 8px; font-size:12px; color:#334155; }
    .securityContactList { display:grid; gap:4px; font-size:13px; }
    .securityUploader { border:2px dashed #64748b; border-radius:8px; padding:16px; background:#f8fafc; display:grid; gap:10px; }
    .securityUploader h3 { margin:0; font-size:18px; }
    .securityUploader input { background:white; }
    .securityReceipts { display:grid; gap:7px; }
    .securityReceipt { border:1px solid #cbd5e1; border-left:5px solid #15803d; border-radius:7px; padding:9px; background:white; font-size:13px; }
    .securityReceipt.error { border-left-color:#b91c1c; }
    .securityMetrics { display:grid; grid-template-columns:repeat(5,minmax(125px,1fr)); gap:8px; }
    .securityDashboard { display:grid; grid-template-columns:minmax(260px,.72fr) minmax(0,1.5fr); gap:12px; align-items:start; }
    .securityAnalytics { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(250px,.6fr); gap:12px; align-items:stretch; }
    .securityCharts { display:grid; gap:12px; }
    .securityChart { border:1px solid var(--line); border-radius:8px; padding:11px; background:white; }
    .securityChart h3 { margin:0 0 9px; font-size:15px; }
    .securityBarRow { display:grid; grid-template-columns:minmax(105px,.8fr) minmax(100px,1fr) 34px 48px; gap:7px; align-items:center; margin:7px 0; font-size:12px; }
    .securityBarTrack { height:9px; border-radius:4px; overflow:hidden; background:#e2e8f0; }
    .securityBarFill { height:100%; background:#2563eb; }
    .securityBarPct { color:var(--muted); text-align:right; }
    .securityBreakdown { border:1px solid var(--line); border-radius:8px; padding:11px; background:white; display:grid; align-content:start; gap:8px; }
    .securityBreakdown h3 { margin:0; font-size:15px; }
    .securityBreakdownRow { display:flex; justify-content:space-between; gap:10px; padding:8px 0; border-bottom:1px solid var(--line); }
    .securityBreakdownRow:last-child { border-bottom:0; }
    .securityFilters { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-bottom:10px; }
    .securityIncidentList { display:grid; grid-template-columns:repeat(auto-fill,minmax(285px,1fr)); gap:9px; }
    .securityIncident { border:1px solid var(--line); border-left:6px solid #64748b; border-radius:8px; background:white; padding:11px; display:grid; gap:7px; cursor:pointer; min-width:0; }
    .securityIncident h3 { margin:0; font-size:16px; overflow-wrap:anywhere; }
    .securityIncident.severity-Critica { border-left-color:#991b1b; }
    .securityIncident.severity-Alta { border-left-color:#ea580c; }
    .securityIncident.severity-Media { border-left-color:#ca8a04; }
    .securityIncident.severity-Informativa { border-left-color:#64748b; }
    .securityQueue { display:grid; gap:10px; }
    .securityQueue + .securityQueue { border-top:1px solid var(--line); padding-top:14px; }
    .securityQueueHead { display:flex; justify-content:space-between; gap:12px; align-items:flex-end; }
    .securityQueueHead h2 { margin:0; font-size:19px; }
    .securityQueueHead p { margin:3px 0 0; }
    .securityReviewed .securityIncident { background:#f8fafc; }
    .securitySourceBox { border:1px solid var(--line); border-radius:8px; padding:10px; background:#f8fafc; display:grid; gap:7px; }
    .securityCandidate { border:1px solid var(--line); border-radius:7px; padding:9px; background:white; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:center; }
    .securityOriginal { background:#f8fafc; border:1px solid #e2e8f0; border-radius:7px; padding:10px; white-space:pre-wrap; line-height:1.4; }
    .security-only .workbench { grid-template-columns:1fr; }
    .security-only .sidebar { display:none; }
    .hidden { display:none !important; }
    @media (max-width: 1100px) {
      .counts { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .workbench { grid-template-columns: 1fr; }
      .sidebar { position:static; }
      .tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .mapSectionBody { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .assemblyMetrics { grid-template-columns:repeat(3,minmax(115px,1fr)); }
      .assemblySplit { grid-template-columns:1fr; }
      .minutesSourceGrid, .minutesLanguages { grid-template-columns:1fr; }
      .adminLayout { grid-template-columns:1fr; }
      .securityDashboard, .securityAnalytics { grid-template-columns:1fr; }
      .securityMetrics { grid-template-columns:repeat(3,minmax(0,1fr)); }
    }
    @media (max-width: 700px) {
      header { padding:14px; }
      .topbar { align-items:flex-start; flex-direction:column; }
      main { padding:10px; }
      section { padding:12px; }
      .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .filters { grid-template-columns:1fr; }
      .sidebar > h2 { display:none; }
      .tabs { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); max-height:108px; overflow-y:auto; overflow-x:hidden; gap:6px; padding:2px 4px 2px 0; scrollbar-width:thin; }
      .tabs .tab { min-height:46px; padding:7px; gap:4px; font-size:12px; }
      #homeTab span:last-child, #globalSearchTab span:last-child, #importTab span:last-child, #aiTab span:last-child { display:none; }
      .navDivider { display:none; }
      .cards { grid-template-columns:1fr; }
      .contentHead { flex-direction:column; }
      .toolbar button { flex:1 1 auto; }
      .detailGrid, .formGrid { grid-template-columns:1fr; }
      .workflowControls { grid-template-columns:1fr; }
      .reviewSummary { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .securityMetrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .securityFilters { grid-template-columns:1fr; }
      .securityIncidentList { grid-template-columns:1fr; }
      .securityLookupBar { grid-template-columns:1fr; }
      .securityLookupResults { grid-template-columns:1fr; }
      .homeHero { align-items:flex-start; flex-direction:column; }
      .homeActions { justify-content:flex-start; width:100%; }
      .homeActions button { flex:1 1 140px; }
      .homeMetrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .automationList { grid-template-columns:1fr; }
      .automationCard { grid-template-columns:1fr; }
      .automationCardActions { justify-items:start; }
      .attentionRow { grid-template-columns:1fr; gap:4px; }
      .mapSectionBody { grid-template-columns:1fr; }
      .searchControls, .documentControls { grid-template-columns:1fr; }
      .aiBatchHead { flex-direction:column; }
      .resultCard { grid-template-columns:1fr; }
      .importControls, .importProposalGrid, .historicalRow, .reportControls { grid-template-columns:1fr; }
      .reportRow { grid-template-columns:1fr; }
      .assemblyHeader { flex-direction:column; }
      .assemblyMetrics, .voteSummary { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .attendanceRow, .voteMember, .pointEditor, .votePointSelect { grid-template-columns:1fr; }
      .attendanceRow { grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
      .attendanceRow > div:first-child, .attendanceRow > .toolbar { grid-column:1 / -1; }
      .attendanceRow > .toolbar { margin-top:0; }
      .adminMetrics, .communityChecks { grid-template-columns:1fr; }
      .answerTable { min-width:0; }
      .answerTable thead { display:none; }
      .answerTable, .answerTable tbody, .answerTable tr, .answerTable td { display:block; width:100%; }
      .answerTable tr { border:1px solid #e2e8f0; border-radius:8px; margin-bottom:8px; background:white; }
      .answerTable td { border-bottom:1px solid #eef2f7; display:flex; justify-content:space-between; gap:12px; }
      .answerTable td::before { content:attr(data-label); color:#64748b; font-weight:700; }
    }

    /* Professional workspace theme. Visual only: no routes, data or permissions change. */
    :root {
      --bg:#eef1f3;
      --surface:#fffdfa;
      --surface-soft:#f5f6f6;
      --ink:#20201e;
      --text:#20201e;
      --muted:#686b6d;
      --line:#d8d9d7;
      --blue:#305f7f;
      --blue-soft:#e2ebf1;
      --green:#28745d;
      --amber:#9a641c;
      --red:#a53b43;
      --teal:#246f70;
      --gold:#b59a66;
      --charcoal:#191a19;
      --shadow:0 18px 44px rgba(25,26,25,.12);
    }
    html { background:var(--bg); }
    body { min-height:100vh; background:var(--bg); color:var(--ink); line-height:1.45; letter-spacing:0; }
    header {
      position:sticky;
      top:0;
      z-index:20;
      padding:12px 22px;
      color:var(--ink);
      background:rgba(255,253,250,.97);
      border-bottom:1px solid var(--line);
      box-shadow:0 4px 16px rgba(25,26,25,.05);
      backdrop-filter:blur(10px);
    }
    .topbar { max-width:none; min-height:52px; }
    .brand { position:relative; padding-left:55px; min-height:44px; display:flex; flex-direction:column; justify-content:center; }
    .brandMark {
      position:absolute;
      inset:0 auto 0 0;
      width:43px;
      height:43px;
      display:grid;
      place-items:center;
      border-radius:6px;
      background:var(--charcoal);
      color:#fff;
      font-size:13px;
      font-weight:900;
      border-bottom:3px solid var(--gold);
      padding:0;
      cursor:default;
    }
    .brandMark:hover { filter:none; box-shadow:none; }
    .brandMark:disabled { opacity:1; color:#fff; }
    .brand h1 { font-size:20px; font-weight:800; letter-spacing:0; }
    .brand p { margin-top:2px; color:var(--muted); font-size:12px; }
    .session { color:var(--muted); }
    .session > span { font-weight:650; }
    .session button { min-height:38px; padding:8px 12px; }
    main { max-width:none; margin:0; padding:18px 22px 28px; }
    section { background:var(--surface); border-color:var(--line); box-shadow:0 1px 0 rgba(25,26,25,.02); }
    h2 { color:var(--ink); font-size:18px; font-weight:800; letter-spacing:0; }
    h3, h4 { letter-spacing:0; }
    label { color:#3f4243; font-size:12px; font-weight:750; letter-spacing:0; }
    .muted { color:var(--muted); }

    .counts { gap:10px; margin-bottom:16px; }
    .count {
      position:relative;
      min-height:82px;
      padding:13px 14px;
      border-color:var(--line);
      background:var(--surface);
      box-shadow:0 5px 16px rgba(25,26,25,.045);
      overflow:hidden;
    }
    .count::before { content:""; position:absolute; inset:0 auto 0 0; width:3px; background:var(--gold); }
    .count:nth-child(3n+2)::before { background:var(--teal); }
    .count:nth-child(3n+3)::before { background:var(--blue); }
    .count strong { margin-top:3px; font-size:24px; font-weight:800; }

    .workbench { grid-template-columns:258px minmax(0,1fr); gap:18px; }
    .sidebar {
      top:94px;
      max-height:calc(100vh - 112px);
      overflow:auto;
      padding:17px;
      border:1px solid #2d2f2e;
      background:var(--charcoal);
      color:#fff;
      box-shadow:0 14px 34px rgba(25,26,25,.14);
      scrollbar-width:thin;
      scrollbar-color:#555 transparent;
    }
    .sidebar h2 { color:#fff; font-size:13px; text-transform:uppercase; letter-spacing:0; margin:0 0 11px; }
    .tabs { gap:4px; }
    .tab {
      min-height:42px;
      padding:9px 10px;
      border:1px solid transparent;
      background:transparent;
      color:rgba(255,255,255,.74);
      font-weight:650;
    }
    .tab:hover { background:rgba(255,255,255,.07); color:#fff; border-color:rgba(255,255,255,.08); }
    .tab.active {
      color:#fff;
      background:rgba(181,154,102,.2);
      border-color:rgba(181,154,102,.34);
      box-shadow:inset 3px 0 var(--gold);
    }
    .tab span:last-child { color:rgba(255,255,255,.58); font-size:11px; }
    .tab.active span:last-child { color:#fff; }
    .tabBadge { background:rgba(48,95,127,.35); color:#dcebf5; }
    .tabBadge.alert { background:rgba(165,59,67,.35); color:#ffdfe1; }
    .navDivider { background:rgba(255,255,255,.13); margin:7px 2px; }
    .navGroup {
      border-color:rgba(255,255,255,.12);
      background:rgba(255,255,255,.045);
    }
    .navGroup summary { color:rgba(255,255,255,.82); }
    .navGroupBody .tab { background:transparent; }
    .filters { margin-top:16px; padding-top:12px; border-top:1px solid rgba(255,255,255,.13); gap:7px; }
    .sidebar label { color:rgba(255,255,255,.67); }
    .sidebar input, .sidebar select {
      min-height:38px;
      padding:8px 9px;
      color:#fff;
      background:#252726;
      border-color:#464846;
    }
    .sidebar input::placeholder { color:#9b9d9c; }
    .sidebar option { color:#20201e; background:#fff; }
    .sidebar .toolbar button { flex:1; min-width:92px; background:var(--gold); color:#221f18; }
    .sidebar .toolbar button.ghost { background:#2b2d2c; color:#fff; border-color:#4a4c4b; }
    .mobileNav { display:none; }
    .mobileDrawer, .mobileDrawerBackdrop { display:none; }
    body:has(.modalBackdrop:not(.hidden)) { overflow:hidden; }

    .workspaceContent { min-width:0; padding:2px 0 20px; border:0; background:transparent; box-shadow:none; }
    .contentHead { min-height:58px; align-items:center; margin:0 0 14px; padding-bottom:12px; border-bottom:1px solid var(--line); }
    .contentHead h2 { font-size:22px; }
    .contentHead p { margin-top:3px; }
    .contentHead > div:last-child { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
    .contentHead > div:last-child .toolbar { margin-top:0; }
    #visibleCount { font-size:12px; font-weight:700; }

    input, select, textarea {
      border-color:#c7cac8;
      border-radius:6px;
      background:#fff;
      color:var(--ink);
      transition:border-color .15s ease, box-shadow .15s ease, background .15s ease;
    }
    input:hover, select:hover, textarea:hover { border-color:#a9adaa; }
    input:focus, select:focus, textarea:focus {
      outline:none;
      border-color:var(--gold);
      box-shadow:0 0 0 3px rgba(181,154,102,.18);
    }
    input[type="checkbox"], input[type="radio"] {
      width:18px;
      height:18px;
      min-height:18px;
      padding:0;
      flex:0 0 18px;
      accent-color:var(--teal);
      box-shadow:none;
    }
    input[type="file"] { padding:6px; background:#f7f8f7; }
    input[type="file"]::file-selector-button {
      min-height:30px;
      margin-right:9px;
      border:1px solid #c8cbc8;
      border-radius:5px;
      padding:5px 10px;
      background:#fff;
      color:#343736;
      font-weight:700;
      cursor:pointer;
    }
    textarea { line-height:1.5; }
    button {
      min-height:40px;
      border:1px solid transparent;
      border-radius:6px;
      background:var(--blue);
      font-weight:750;
      letter-spacing:0;
      transition:background .15s ease, border-color .15s ease, box-shadow .15s ease, transform .08s ease;
    }
    button:hover { filter:brightness(.94); box-shadow:0 5px 14px rgba(25,26,25,.11); }
    button:active { transform:translateY(1px); }
    button:focus-visible { outline:3px solid rgba(181,154,102,.35); outline-offset:2px; }
    button.secondary { background:var(--charcoal); color:#fff; }
    button.ghost { background:#fff; color:#343736; border-color:#cfd1cf; }
    button.green { background:var(--green); }
    button.red { background:var(--red); }

    .cards { gap:12px; }
    .card {
      min-height:160px;
      padding:14px;
      border-width:1px 1px 1px 4px;
      border-color:var(--line) var(--line) var(--line) #929795;
      background:var(--surface);
      box-shadow:0 7px 20px rgba(25,26,25,.055);
      transition:border-color .15s ease, box-shadow .15s ease, transform .15s ease;
    }
    .card:hover { border-top-color:#bbbdbb; border-right-color:#bbbdbb; border-bottom-color:#bbbdbb; box-shadow:0 12px 28px rgba(25,26,25,.1); transform:translateY(-1px); }
    .card h3 { font-size:16px; font-weight:800; color:#1d1e1d; }
    .line { color:#505453; line-height:1.45; }
    .line strong { color:#252726; }
    .pill { background:#eceeec; color:#404443; }
    .nextStep { background:#f5f5f2; border-color:#dedfdb; padding:9px 10px; }
    .cardActions { padding-top:9px; border-top:1px solid #e3e4e1; }
    .cardActions button { min-height:36px; }
    .empty { background:rgba(255,255,255,.55); border-color:#bec2bf; }
    .mapCard.selected { border-color:var(--blue); box-shadow:0 0 0 2px rgba(48,95,127,.2), 0 12px 28px rgba(25,26,25,.08); }

    .homeHero {
      min-height:104px;
      border:1px solid var(--line);
      border-left:5px solid var(--gold);
      background:var(--surface);
      box-shadow:0 8px 24px rgba(25,26,25,.055);
    }
    .homeHero h2 { font-size:22px; }
    .workTodayHero {
      min-height:96px;
      border-color:var(--line);
      border-left-color:var(--green);
      background:var(--surface);
      box-shadow:0 8px 24px rgba(25,26,25,.055);
    }
    .workTodayPanel,
    .mapSection, .assemblyPane, .answerTableWrap, .proposal, .reportRow, .documentCard, .importProposal, .voteGroup {
      border-color:var(--line);
      background:var(--surface);
      box-shadow:0 5px 16px rgba(25,26,25,.04);
    }
    .mapSection { background:#f4f5f4; }
    .mapSectionHead { background:var(--surface); }
    .mapSectionHead h3 { font-size:16px; }
    .specialPanel, .assemblyPane { box-shadow:0 5px 16px rgba(25,26,25,.04); }
    .quickRecord { background:#edf3f5; border-color:#c6d8df; }
    .entityBrief { background:var(--surface); border-color:var(--line); border-left-color:var(--blue); box-shadow:0 5px 16px rgba(25,26,25,.04); }
    .entityBriefNext { background:#f4f5f4; border-color:#dedfdd; }
    .entityBriefStat, .entityReportItem { background:var(--surface); border-color:var(--line); }
    .decisionBox { background:#f6f5f1; border-color:#ddd9cf; }
    .answerHero { border-color:#ccdce6; border-left-color:var(--blue); background:var(--surface); }
    .answerCard { background:var(--surface); border-color:var(--line); }
    .answerTable th { background:#eeefed; color:#424645; }
    .answerTable th, .answerTable td { border-bottom-color:#dedfdd; }
    .notificationCard.unread { background:#f2f7f9; border-left-color:var(--blue); }
    .assemblyCard { border-left-color:var(--teal); }
    .assemblyHeader { border-color:#bfd8d3; border-left-color:var(--teal); background:#edf6f3; }
    .assemblyTabs button { background:#e4e6e4; color:#3e4240; }
    .assemblyTabs button.active { background:var(--teal); }
    .agendaNumber { background:var(--teal); }
    .adminRow.selected { border-color:var(--blue); background:#edf3f7; box-shadow:inset 4px 0 var(--blue); }
    .temporaryKey { border-color:var(--green); background:#eff7f2; }

    .modalBackdrop { background:rgba(17,18,17,.67); backdrop-filter:blur(4px); }
    .modal { border-color:#bfc1be; background:#f1f2f1; box-shadow:0 28px 75px rgba(0,0,0,.28); }
    .modalHead { padding:15px 18px; background:var(--surface); border-bottom-color:var(--line); }
    .modalHead h2 { font-size:20px; }
    .modalBody { padding:16px; gap:14px; }
    .modalBody > section { box-shadow:0 5px 16px rgba(25,26,25,.04); }

    .login {
      position:relative;
      max-width:470px;
      margin:72px auto;
      padding:26px;
      border-top:4px solid var(--gold);
      background:var(--surface);
      box-shadow:0 24px 60px rgba(25,26,25,.16);
    }
    .login h2 { font-size:25px; }
    .login > p { margin:6px 0 18px; }
    .login details { background:#f5f4f0; box-shadow:none; }
    .login summary { cursor:pointer; }

    @media (max-width:1100px) {
      main { padding:15px; }
      .workbench { grid-template-columns:1fr; gap:13px; }
      .sidebar { position:static; max-height:none; }
      .tabs { grid-template-columns:repeat(4,minmax(0,1fr)); }
      .filters { grid-template-columns:repeat(4,minmax(0,1fr)); }
      .sidebar .toolbar { justify-content:flex-end; }
      .sidebar .toolbar button { flex:0 1 150px; }
      .workTodayHero { align-items:flex-start; }
      .workTodayGrid { grid-template-columns:1fr; }
      .aiQueryLayout { grid-template-columns:1fr; }
      .aiHistoryList { max-height:300px; }
    }
    @media (max-width:700px) {
      html, body { max-width:100%; overflow-x:hidden; }
      header { padding:8px 10px; }
      .topbar { min-height:46px; gap:7px; flex-direction:row; align-items:center; }
      .brand { min-height:39px; padding-left:49px; }
      .brandMark { width:39px; height:39px; cursor:pointer; }
      .brand h1 { font-size:17px; }
      .brand p { display:none; }
      .session { width:auto; margin-left:auto; justify-content:flex-end; flex-wrap:nowrap; }
      .session > span { display:none; }
      button, input, select { min-height:44px; }
      .aiHub { gap:10px; }
      .aiBox { padding:12px; }
      .aiInput { min-height:160px; }
      .aiQueryInput { min-height:96px; }
      .aiSectionHead { display:block; }
      .aiHistoryPanel { border-radius:7px; }
      .aiHistoryList { max-height:250px; }
      .session button { min-height:44px; padding:8px 10px; }
      main { padding:10px 9px 20px; }
      #appView:not([data-view="home"]) > .counts { display:none; }
      .counts { gap:7px; margin-bottom:9px; grid-template-columns:repeat(3,minmax(0,1fr)); }
      .count { min-height:72px; padding:10px 11px; }
      .workTodayHero { display:grid; gap:11px; padding:12px; }
      .workTodayHero h2 { font-size:20px; }
      .workTodaySummary { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
      .workTodayPanel { padding:10px; }
      .workTodayPanel .contentHead { display:flex; align-items:flex-start; }
      .entityBriefTop { grid-template-columns:1fr; }
      .entityBriefStats { grid-template-columns:repeat(3,minmax(0,1fr)); }
      .entityReportItem { grid-template-columns:1fr; }
      .copilotFab { right:12px; bottom:12px; padding:11px 13px; }
      .copilotPanel { width:100%; }
      .copilotQuickActions { grid-template-columns:1fr 1fr; }
      .count strong { font-size:21px; }
      .count span { font-size:11px; line-height:1.2; }
      .workbench { gap:9px; }
      #appView:not([data-view="tasks"]):not([data-view="projects"]) .sidebar { display:none; }
      .sidebar {
        position:sticky;
        top:63px;
        z-index:16;
        max-height:calc(100dvh - 72px);
        overflow:auto;
        padding:9px;
        border:1px solid #c8cac8;
        border-radius:7px;
        background:rgba(255,253,250,.98);
        color:var(--ink);
        box-shadow:0 8px 22px rgba(25,26,25,.12);
      }
      .sidebar > h2, .tabs, .navDivider { display:none; }
      .mobileNav { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; }
      .mobileNav button { padding:8px 10px; background:#fff; color:#303331; border-color:#c7c9c7; font-size:12px; }
      .filters { display:none; grid-template-columns:1fr; margin-top:9px; padding-top:9px; border-top:1px solid #dedfdd; }
      .filters.mobile-open { display:grid; }
      .sidebar label { color:#4b4e4c; }
      .sidebar input, .sidebar select { min-height:44px; color:var(--ink); background:#fff; border-color:#c7cac8; }
      .sidebar > .toolbar { display:none; }
      .sidebar.filters-open > .toolbar { display:flex; margin-top:8px; }
      .sidebar .toolbar button { flex:1; }
      .contentHead { align-items:flex-start; }
      .contentHead > div:last-child { width:100%; justify-content:space-between; }
      .contentHead h2 { font-size:20px; }
      .cards { gap:9px; }
      .card { min-height:0; padding:12px; }
      .cardActions button, .toolbar button { min-height:44px; }
      .nextStep .line { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; }
      .contentHead > div:last-child .toolbar { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); width:100%; }
      .contentHead > div:last-child .toolbar button { width:100%; }
      .modalBackdrop { padding:0; align-items:stretch; }
      .modal {
        width:100% !important;
        height:100dvh;
        max-height:100dvh;
        margin:0;
        border:0;
        border-radius:0;
        display:flex;
        flex-direction:column;
        overflow:hidden;
      }
      .modalHead { position:static; flex:0 0 auto; padding:10px 11px; align-items:flex-start; }
      .modalHead > div:first-child { min-width:0; }
      .modalHead h2 { font-size:18px; overflow-wrap:anywhere; }
      .modalHead p { margin:3px 0 0; font-size:12px; }
      #entityModal .modalHead { display:grid; grid-template-columns:1fr; gap:8px; }
      #entityModal .modalActions { width:100%; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; }
      #entityModal .modalActions button { min-width:0; min-height:42px; padding:6px 4px; font-size:11px; line-height:1.15; }
      .modalHead > button { flex:0 0 auto; }
      .modalBody { min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:9px; gap:10px; }
      .modalBody section { padding:11px; }
      .detailGrid, .formGrid { grid-template-columns:1fr; }
      .attachmentGrid, .documentGrid, .assemblyList, .securityIncidentList { grid-template-columns:1fr; }
      .attachmentPreview, .documentPreview { height:auto; max-height:190px; object-fit:contain; }
      .homeHero { padding:13px; }
      .homeHero h2 { font-size:20px; }
      .homeMetrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .attentionRow, .resultCard, .reportRow, .securityCandidate { grid-template-columns:1fr; }
      .mapSectionBody { padding:7px; }
      .mapSectionHead { padding:10px; }
      .reviewSummary, .securityMetrics, .assemblyMetrics, .voteSummary { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .searchControls, .documentControls, .importControls, .importProposalGrid, .historicalRow, .reportControls, .workflowControls { grid-template-columns:1fr; }
      .assemblyHeader { padding:11px; }
      .assemblyHeader h2 { font-size:19px; }
      .assemblyTabs { flex-wrap:nowrap; overflow-x:auto; padding-bottom:7px; scrollbar-width:thin; }
      .assemblyTabs button { flex:0 0 auto; }
      .agendaItem { grid-template-columns:32px minmax(0,1fr); }
      .agendaItem > :last-child { grid-column:1 / -1; width:100%; }
      .attendanceRow, .voteMember, .pointEditor, .votePointSelect { grid-template-columns:1fr; }
      .voteGroupHead { align-items:flex-start; flex-direction:column; }
      .voteActions { width:100%; }
      .voteActions button { flex:1 1 62px; }
      .adminMetrics, .communityChecks { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .adminLayout { gap:9px; }
      .adminList { max-height:360px; }
      .securityDashboard { gap:9px; }
      .securityBarRow { grid-template-columns:minmax(82px,.8fr) minmax(80px,1fr) 28px 42px; }
      .securityQueueHead { align-items:flex-start; }
      .answerCards { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .answerCard strong { font-size:18px; }
      .login { margin:18px auto; padding:17px 14px; }
      pre, code, .securityOriginal { overflow-wrap:anywhere; word-break:break-word; }
      .mobileMoreWrap { grid-column:1 / -1; padding:2px 0; }
      .mobileMore { width:100%; min-height:46px; background:#fff; color:#303331; border-color:#bfc2bf; }
      .login { margin:28px auto; padding:20px 16px; }

      .mobileDrawerBackdrop {
        display:block;
        position:fixed;
        inset:0;
        z-index:69;
        background:rgba(10,11,10,.58);
        opacity:0;
        visibility:hidden;
        pointer-events:none;
        transition:opacity .2s ease, visibility .2s ease;
      }
      .mobileDrawer {
        display:flex;
        position:fixed;
        inset:0 auto 0 0;
        z-index:70;
        width:min(86vw,330px);
        height:100dvh;
        padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0);
        flex-direction:column;
        background:var(--charcoal);
        color:#fff;
        box-shadow:18px 0 50px rgba(0,0,0,.3);
        transform:translateX(-105%);
        visibility:hidden;
        transition:transform .22s ease, visibility .22s ease;
      }
      body.mobile-drawer-open { overflow:hidden; }
      body.mobile-drawer-open .mobileDrawerBackdrop { opacity:1; visibility:visible; pointer-events:auto; }
      body.mobile-drawer-open .mobileDrawer { transform:translateX(0); visibility:visible; }
      .mobileDrawerHead { min-height:68px; padding:11px 12px; display:flex; align-items:center; gap:10px; border-bottom:1px solid rgba(255,255,255,.13); }
      .mobileDrawerMark { width:40px; height:40px; flex:0 0 40px; display:grid; place-items:center; border-radius:6px; border-bottom:3px solid var(--gold); background:#272927; font-size:13px; font-weight:900; }
      .mobileDrawerTitle { min-width:0; flex:1; }
      .mobileDrawerTitle strong { display:block; font-size:16px; }
      .mobileDrawerTitle span { display:block; margin-top:2px; color:rgba(255,255,255,.6); font-size:11px; }
      .mobileDrawerClose { width:44px; min-width:44px; padding:0; background:transparent; color:#fff; border-color:rgba(255,255,255,.2); font-size:25px; line-height:1; }
      .mobileDrawerNav { min-height:0; flex:1; overflow-y:auto; padding:9px; display:grid; align-content:start; gap:4px; overscroll-behavior:contain; }
      .mobileDrawerItem { width:100%; min-height:48px; padding:10px 11px; display:flex; justify-content:space-between; align-items:center; gap:10px; text-align:left; background:transparent; color:rgba(255,255,255,.78); border-color:transparent; }
      .mobileDrawerItem.active { color:#fff; background:rgba(181,154,102,.2); border-color:rgba(181,154,102,.4); box-shadow:inset 3px 0 var(--gold); }
      .mobileDrawerItem:hover { color:#fff; background:rgba(255,255,255,.07); }
      .mobileDrawerBadge { min-width:28px; padding:3px 7px; border-radius:999px; text-align:center; background:rgba(48,95,127,.38); color:#e2eff7; font-size:11px; font-weight:850; }
      .mobileDrawerDivider { height:1px; margin:7px 3px; background:rgba(255,255,255,.13); }
      .mobileDrawerFoot { padding:10px 12px; border-top:1px solid rgba(255,255,255,.13); display:grid; gap:7px; color:rgba(255,255,255,.55); font-size:11px; }
      .mobileDrawerRefresh { width:100%; min-height:44px; background:#2b2d2c; color:#fff; border-color:#4a4c4b; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div class="brand">
        <button class="brandMark" id="mobileMenuToggle" type="button" aria-label="Abrir menu de navegacion" aria-expanded="false" title="Abrir menu">OT</button>
        <h1>${appName}</h1>
        <p>Entorno de gestion compartido</p>
      </div>
      <div class="session">
        <span id="sessionStatus">Comprobando acceso...</span>
        <button class="secondary hidden" id="changeCommunityTop">Cambiar comunidad</button>
        <button class="secondary hidden" id="logoutTop">Salir</button>
      </div>
    </div>
  </header>
  <div class="mobileDrawerBackdrop" id="mobileDrawerBackdrop"></div>
  <aside class="mobileDrawer" id="mobileDrawer" aria-hidden="true" aria-label="Navegacion principal">
    <div class="mobileDrawerHead">
      <div class="mobileDrawerMark">OT</div>
      <div class="mobileDrawerTitle"><strong>Organizador</strong><span>Selecciona una seccion</span></div>
      <button class="mobileDrawerClose" id="mobileDrawerClose" type="button" aria-label="Cerrar menu" title="Cerrar">&times;</button>
    </div>
    <nav class="mobileDrawerNav" id="mobileDrawerNav"></nav>
    <div class="mobileDrawerFoot"><button class="mobileDrawerRefresh" id="mobileDrawerReload" type="button">Actualizar datos</button><span>Las secciones se muestran segun tus permisos.</span></div>
  </aside>
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
      <details class="assemblyPane" style="margin-top:12px">
        <summary><strong>Primer acceso o contrasena reseteada</strong></summary>
        <p class="muted">Usa la clave temporal facilitada por el Superusuario para crear tu contrasena definitiva.</p>
        <label>Clave temporal</label><input id="firstAccessKey" autocomplete="one-time-code" />
        <label>Nueva contrasena</label><input id="firstAccessPassword" type="password" autocomplete="new-password" />
        <label>Confirmar contrasena</label><input id="firstAccessConfirm" type="password" autocomplete="new-password" />
        <button class="green" id="firstAccessButton">Configurar y entrar</button>
        <div id="firstAccessMessage" class="muted"></div>
      </details>
    </section>
    <div id="appView" class="hidden">
      <div class="grid counts" id="counts"></div>
      <div class="workbench">
        <section class="sidebar">
          <h2>Vista</h2>
          <div class="mobileNav">
            <button class="ghost hidden" id="mobileFiltersToggle" type="button">Filtros</button>
            <button class="ghost" id="mobileReload" type="button">Actualizar</button>
          </div>
          <div class="tabs">
            <button class="tab active" id="homeTab" data-view="home"><span>Inicio</span><span>Resumen</span></button>
            <button class="tab" id="mapTab" data-view="map"><span>Trabajo Hoy</span><span id="mapTabCount">0</span></button>
            <button class="tab" id="taskTab" data-view="tasks"><span>Tareas</span><span id="taskTabCount">0</span></button>
            <button class="tab" id="projectTab" data-view="projects"><span>Proyectos</span><span id="projectTabCount">0</span></button>
            <button class="tab" id="assemblyTab" data-view="assemblies"><span>Asambleas</span><span id="assemblyTabCount">0</span></button>
            <button class="tab hidden" id="securityTab" data-view="security"><span>Seguridad</span><span class="tabBadge" id="securityTabCount">0</span></button>
            <div class="navDivider"></div>
            <button class="tab hidden" id="workTab" data-view="work"><span>Acciones</span><span class="tabBadge" id="workTabCount">0</span></button>
            <button class="tab hidden" id="reviewTab" data-view="review"><span>Revision</span><span class="tabBadge" id="reviewTabCount">0</span></button>
            <details class="navGroup">
              <summary>Herramientas</summary>
              <div class="navGroupBody">
                <button class="tab" id="globalSearchTab" data-view="global-search"><span>Buscar</span><span id="globalSearchTabCount">Todo</span></button>
                <button class="tab" id="documentsTab" data-view="documents"><span>Documentos</span><span id="documentsTabCount">0</span></button>
                <button class="tab" id="reportsTab" data-view="reports"><span>Informes</span><span id="reportsTabCount">0</span></button>
                <button class="tab" id="importTab" data-view="imports"><span>Importar</span><span>Revisar</span></button>
                <button class="tab" id="notificationTab" data-view="notifications"><span>Notificaciones</span><span class="tabBadge alert" id="notificationTabCount">0</span></button>
                <button class="tab" id="aiTab" data-view="ai"><span>IA</span><span id="aiTabStatus">OK</span></button>
                <button class="tab hidden" id="adminTab" data-view="admin"><span>Administracion</span><span>Usuarios</span></button>
              </div>
            </details>
          </div>
          <div class="filters" id="listFilters">
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
        <section class="workspaceContent">
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
            <button id="generateReportButton">Generar informe</button>
            <button id="entityCopilotButton">Copiloto</button>
            <button class="green" id="focusRecordButton">Actualizar</button>
            <button class="ghost" id="toggleEditEntity">Editar ficha</button>
            <button class="red" id="archiveEntityButton">Archivar</button>
            <button class="ghost" id="closeModal">Cerrar</button>
          </div>
        </div>
        <div class="modalBody">
          <section class="entityBrief" id="entityBrief"></section>
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
            <h2>Actualizar seguimiento</h2>
            <div id="quickRecordBox" class="quickRecord hidden">
              <h3>Actualizar con IA</h3>
              <p class="muted">Pega o dicta lo ocurrido. La app propondrá comentario, estado, responsable, fecha y próximo paso para que lo revises antes de guardar.</p>
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
            <div id="attachmentUploadBox" class="uploadBox">
              <strong>Anadir archivos a la ficha</strong>
              <span class="muted">Puedes seleccionar varios. Se guardaran en el servidor y estaran disponibles desde PC y movil.</span>
              <input id="attachmentFiles" type="file" multiple />
              <div class="toolbar">
                <button class="green" id="uploadAttachmentsButton">Subir seleccionados</button>
                <span class="muted" id="attachmentMessage"></span>
              </div>
            </div>
            <div class="attachmentGrid" id="attachmentsList"></div>
          </section>
          <section id="entityReportsLogSection">
            <h2>Informes generados</h2>
            <div class="entityReportList" id="entityReportsList"></div>
          </section>
          <section id="entityReportSection">
            <h2>Informe Word</h2>
            <p class="muted">Incluye resumen ejecutivo, situacion actual, actuaciones cronologicas, proximos pasos, conclusion y relacion de anexos.</p>
            <div class="toolbar">
              <button id="generateReportBottom">Generar y abrir informe</button>
              <span class="muted reportMessage" id="reportMessage"></span>
            </div>
          </section>
        </div>
      </div>
    </div>
    <button class="copilotFab hidden" id="copilotFab" type="button"><span>IA</span><strong>Copiloto</strong></button>
    <div class="copilotBackdrop hidden" id="copilotBackdrop"></div>
    <aside class="copilotPanel hidden" id="copilotPanel" aria-label="Copiloto IA contextual">
      <div class="copilotHead">
        <div>
          <h2>Copiloto IA</h2>
          <p class="muted">Trabaja con el contexto de la pantalla actual. Nada se guarda sin confirmacion.</p>
        </div>
        <button class="ghost" id="closeCopilot" type="button">Cerrar</button>
      </div>
      <div class="copilotBody">
        <div>
          <label>Contexto detectado</label>
          <div class="copilotContext" id="copilotContextBox">Sin contexto cargado.</div>
        </div>
        <div class="copilotQuickActions">
          <button class="ghost" data-copilot-preset="ask">Preguntar</button>
          <button class="ghost" data-copilot-preset="update">Actualizar</button>
          <button class="ghost" data-copilot-preset="summary">Resumen email</button>
          <button class="ghost" data-copilot-preset="risks">Riesgos</button>
        </div>
        <textarea id="copilotText" class="copilotInput" placeholder="Ejemplo: resume esta ficha para enviar por email / que necesita accion aqui / registra que he hablado con el proveedor..."></textarea>
        <div class="toolbar">
          <button class="green" id="copilotSend">Enviar al copiloto</button>
          <button class="ghost" id="copilotOpenCenter">Abrir Centro IA</button>
          <span class="muted" id="copilotMessage"></span>
        </div>
        <div class="copilotResult" id="copilotResult"></div>
      </div>
    </aside>
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
    <div id="presidentDecisionModal" class="modalBackdrop hidden">
      <div class="modal" style="width:min(680px,100%)">
        <div class="modalHead">
          <div><h2 id="presidentDecisionTitle">Responder solicitud</h2><p class="muted" id="presidentDecisionSubtitle"></p></div>
          <button class="ghost" id="closePresidentDecision">Cerrar</button>
        </div>
        <div class="modalBody">
          <div class="decisionBox" id="presidentDecisionContext"></div>
          <label>Comentario obligatorio</label>
          <textarea id="presidentDecisionComment" placeholder="Explica brevemente la decision o la aclaracion necesaria..."></textarea>
          <div class="toolbar">
            <button class="green" id="presidentApprove">Aprobar</button>
            <button class="red" id="presidentReject">Rechazar</button>
            <button class="secondary" id="presidentClarify">Solicitar aclaracion</button>
          </div>
          <div class="muted" id="presidentDecisionMessage"></div>
        </div>
      </div>
    </div>
    <div id="communityScopeModal" class="modalBackdrop hidden">
      <div class="modal" style="width:min(620px,100%)">
        <div class="modalHead">
          <div><h2>Elige donde quieres trabajar</h2><p class="muted">La seleccion se aplicara a toda la sesion.</p></div>
          <button class="ghost hidden" id="closeCommunityScope">Cerrar</button>
        </div>
        <div class="modalBody">
          <div class="communityScopeChoices" id="communityScopeChoices"></div>
          <div class="toolbar"><button class="green" id="confirmCommunityScope">Entrar</button><span class="muted" id="communityScopeMessage"></span></div>
        </div>
      </div>
    </div>
    <div id="securityModal" class="modalBackdrop hidden">
      <div class="modal" style="width:min(1080px,100%)">
        <div class="modalHead">
          <div><h2 id="securityModalTitle">Incidencia de Seguridad</h2><p class="muted" id="securityModalSubtitle"></p></div>
          <button class="ghost" id="closeSecurityModal">Cerrar</button>
        </div>
        <div class="modalBody" id="securityModalBody"></div>
      </div>
    </div>
    <datalist id="responsiblesList"></datalist>
  </main>
  <script>
    let state = { usuario: null, proyectos: [], tareas: [], workflow: { actions: [], notifications: [], president_requests: [], review: { items: [], summary: {}, communities: [] } }, daily: { metrics: {}, map: { items: [], counts: {} }, documents: [], communities: [] } };
    let options = { responsables: [], estados_tarea: [], estados_proyecto: [], prioridades: [], tipos_registro: [], comunidades: [], proyectos: [] };
    let currentView = "home";
    let mobileVisibleLimits = {};
    let pendingCommunityUser = null;
    let communityScopeRequired = false;
    let selectedEntity = null;
    let selectedPresidentRequest = null;
    let reviewProgress = { tasks: new Set(), projects: new Set() };
    let reviewCommunity = "";
    let reviewType = "all";
    let selectedMapKey = "";
    let globalSearchResults = [];
    let documentQuery = "";
    let documentType = "all";
    let documentCommunity = "";
    let aiProposal = null;
    let aiHistory = [];
    let aiHistoryLoaded = false;
    let aiRules = [];
    let aiRulesLoaded = false;
    let aiBatch = null;
    let agentTools = [];
    let agentToolsLoaded = false;
    let agentContext = [];
    let agentContextLoaded = false;
    let agentActions = [];
    let agentActionsLoaded = false;
    let agentReportProposal = null;
    let importAnalysis = null;
    let importSourceName = "Texto pegado";
    let importSourceText = "";
    let importCommunity = "";
    let reportsCenter = { reports: [], entities: [], communities: [], loaded: false };
    let selectedReportEntities = new Set();
    let reportQuery = "";
    let reportType = "all";
    let reportCommunity = "";
    let reportEntityQuery = "";
    let reportEntityType = "all";
    let reportEntityCommunity = "";
    let collectionReportTitle = "";
    let assembliesData = { assemblies: [], loaded: false };
    let selectedAssemblyId = 0;
    let assemblyDetail = null;
    let assemblyMinutes = null;
    let assemblySection = "summary";
    let assemblyOwnerQuery = "";
    let selectedAssemblyPoint = 0;
    let adminData = { users: [], communities: [], roles: [], loaded: false };
    let selectedAdminUserId = 0;
    let selectedAdminCommunityId = 0;
    let lastTemporaryKey = null;
    let securityData = { access:null, overview:null, receipts:[], selected:null, lookup:null, filters:{ status:"", severity:"", category:"", query:"" } };
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
      if (!["projects", "tasks"].includes(currentView)) return [];
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
          (canWrite() ? '<button data-action="attach" data-title="' + html(title) + '" data-type="' + (currentView === "projects" ? "project" : "task") + '" data-id="' + html(id) + '">Adjuntar</button>' : '') +
          ((state.usuario || {}).rol !== "Presidente" ? '<button data-action="report" data-type="' + (currentView === "projects" ? "project" : "task") + '" data-id="' + html(id) + '">Informe</button>' : '') +
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
      closeMobileDrawer();
      $("mobileMenuToggle").disabled = true;
      $("mobileMenuToggle").setAttribute("aria-label", "Organizador");
      $("loginView").classList.remove("hidden");
      $("appView").classList.add("hidden");
      $("logoutTop").classList.add("hidden");
      $("changeCommunityTop").classList.add("hidden");
      $("copilotFab").classList.add("hidden");
      closeCopilot();
      $("communityScopeModal").classList.add("hidden");
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
        const result = await api("/api/login", {
          method: "POST",
          body: JSON.stringify({ usuario: $("loginUser").value, password: $("loginPassword").value })
        });
        $("loginPassword").value = "";
        const user = result.usuario || {};
        const assigned = user.comunidades_asignadas || user.comunidades || [];
        if (!["Superusuario", "Seguridad"].includes(user.rol) && assigned.length > 1) {
          openCommunityScope(user, true);
        } else if (user.rol === "Seguridad") {
          await loadSecurityOnly(user);
        } else {
          await loadOverview();
        }
      } catch (error) {
        $("loginMessage").textContent = error.message;
      }
    }

    function openCommunityScope(user, required = false) {
      pendingCommunityUser = user || state.usuario;
      communityScopeRequired = required;
      const assigned = pendingCommunityUser?.comunidades_asignadas || pendingCommunityUser?.comunidades || [];
      const current = pendingCommunityUser?.alcance_comunidades === "seleccion" ? Number((pendingCommunityUser.comunidades || [])[0]?.id_comunidad || 0) : 0;
      $("communityScopeChoices").innerHTML = '<label class="communityScopeChoice"><input type="radio" name="communityScope" value="all"' + (!current ? " checked" : "") + ' /><span><strong>Todas mis comunidades</strong><small class="muted" style="display:block">' + html(assigned.length + " comunidades asignadas") + '</small></span></label>' + assigned.map(community => '<label class="communityScopeChoice"><input type="radio" name="communityScope" value="' + community.id_comunidad + '"' + (Number(community.id_comunidad) === current ? " checked" : "") + ' /><span><strong>' + html(community.nombre) + '</strong><small class="muted" style="display:block">Trabajar solo con esta comunidad</small></span></label>').join("");
      $("communityScopeMessage").textContent = "";
      $("closeCommunityScope").classList.toggle("hidden", required);
      $("confirmCommunityScope").textContent = required ? "Entrar" : "Aplicar seleccion";
      $("communityScopeModal").classList.remove("hidden");
    }

    function closeCommunityScope() {
      if (communityScopeRequired) return;
      $("communityScopeModal").classList.add("hidden");
      pendingCommunityUser = null;
    }

    async function confirmCommunityScope() {
      const selected = document.querySelector('input[name="communityScope"]:checked');
      if (!selected) { $("communityScopeMessage").textContent="Selecciona una opcion."; return; }
      $("communityScopeMessage").textContent = "Cargando contexto...";
      try {
        await api("/api/session/community-scope", {
          method:"POST",
          body:JSON.stringify(selected.value === "all" ? { scope:"all" } : { scope:"community", id_comunidad:Number(selected.value) })
        });
        $("communityScopeModal").classList.add("hidden");
        pendingCommunityUser = null;
        communityScopeRequired = false;
        selectedEntity = null;
        assembliesData = { assemblies:[], loaded:false };
        reportsCenter = { reports:[], entities:[], communities:[], loaded:false };
        currentView = "home";
        await loadOverview();
      } catch (error) {
        $("communityScopeMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    async function configureFirstAccess() {
      const password = $("firstAccessPassword").value;
      const confirmation = $("firstAccessConfirm").value;
      $("firstAccessMessage").textContent = "Comprobando clave temporal...";
      try {
        await api("/api/auth/first-access", {
          method:"POST",
          body:JSON.stringify({ usuario:$("loginUser").value, clave_temporal:$("firstAccessKey").value, password, confirmacion:confirmation })
        });
        $("firstAccessKey").value = "";
        $("firstAccessPassword").value = "";
        $("firstAccessConfirm").value = "";
        $("loginPassword").value = password;
        $("firstAccessMessage").textContent = "Contrasena configurada. Iniciando sesion...";
        await login();
      } catch (error) {
        $("firstAccessMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    async function logout() {
      await api("/api/logout", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
      state = { usuario: null, proyectos: [], tareas: [], workflow: { actions: [], notifications: [], president_requests: [], review: { items: [], summary: {}, communities: [] } }, daily: { metrics: {}, map: { items: [], counts: {} }, documents: [], communities: [] } };
      importAnalysis = null;
      importSourceText = "";
      importCommunity = "";
      reportsCenter = { reports: [], entities: [], communities: [], loaded: false };
      selectedReportEntities = new Set();
      assembliesData = { assemblies: [], loaded: false };
      selectedAssemblyId = 0;
      assemblyDetail = null;
      adminData = { users: [], communities: [], roles: [], loaded: false };
      selectedAdminUserId = 0;
      selectedAdminCommunityId = 0;
      lastTemporaryKey = null;
      pendingCommunityUser = null;
      communityScopeRequired = false;
      currentView = "home";
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

    function briefStat(label, value) {
      return '<div class="entityBriefStat"><span>' + html(label) + '</span><strong>' + html(value || "0") + '</strong></div>';
    }

    function entityBriefHtml(item, type, history, attachments, reports, reportsAllowed) {
      const stateText = itemState(item, type) || "Sin estado";
      const title = itemTitle(item, type) || "Sin titulo";
      const nextOwner = item.responsable_proximo_paso || itemOwner(item, type) || "Sin asignar";
      const date = item.fecha_objetivo_proximo_paso || item.fecha_proxima_revision || "";
      const nextStep = item.proximo_paso || item.observaciones || "Sin proximo paso definido.";
      const last = (history || [])[0] || {};
      const lastComment = safe(last.comentario);
      const reportCount = reportsAllowed ? String((reports || []).length) : "No visible";
      return '<div class="entityBriefTop"><div><div class="meta"><span class="pill">' + html(type === "project" ? "Proyecto" : "Tarea") + '</span><span class="pill state-' + slug(stateText) + '">' + html(stateText) + '</span><span class="pill">' + html(item.prioridad || "Sin prioridad") + '</span><span class="pill">' + html(item.comunidad || "Sin comunidad") + '</span></div><h2>' + html(title) + '</h2></div><div class="entityBriefStats">' +
          briefStat("Seguimientos", String((history || []).length)) +
          briefStat("Anexos", String((attachments || []).length)) +
          briefStat("Informes", reportCount) +
        '</div></div>' +
        '<div class="entityBriefNext"><strong>Proximo paso</strong><p>' + html(nextStep) + '</p><div class="meta"><span class="pill">Responsable: ' + html(nextOwner) + '</span><span class="pill">Fecha: ' + html(date || "Sin fecha") + '</span></div>' +
        (lastComment ? '<div class="line"><strong>Ultimo comentario:</strong> ' + html(lastComment) + '</div>' : '') + '</div>';
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
        const nextOwner = row.responsable_proximo_paso ? '<span class="pill">Proximo: ' + html(row.responsable_proximo_paso) + '</span>' : '';
        const nextDate = row.fecha_objetivo_proximo_paso ? '<span class="pill">Fecha: ' + html(row.fecha_objetivo_proximo_paso) + '</span>' : '';
        const typeText = row.tipo_registro || "Seguimiento";
        const itemClass = /decision|aprob|rechaz/i.test(typeText + " " + (row.comentario || "")) ? " decision" : (/bloque/i.test(String(row.estado_nuevo || "")) ? " risk" : "");
        return '<article class="historyItem' + itemClass + '">' +
          '<h4><span>' + html(typeText) + '</span><span class="muted">' + html(row.fecha_hora || "") + '</span></h4>' +
          '<div class="meta">' +
            (stateChange ? '<span class="pill">' + html(stateChange) + '</span>' : '') +
            (ownerChange ? '<span class="pill">' + html(ownerChange) + '</span>' : '') +
            nextOwner +
            nextDate +
            (row.usuario ? '<span class="pill">' + html(row.usuario) + '</span>' : '') +
          '</div>' +
          '<p class="historyComment">' + html(row.comentario || "") + '</p>' +
          (row.proximo_paso ? '<p class="historyNext"><strong>Proximo paso:</strong> ' + html(row.proximo_paso) + '</p>' : '') +
        '</article>';
      }).join("") : '<div class="empty">No hay historial.</div>';
    }

    function renderEntityReports(reports, reportsAllowed) {
      $("entityReportsLogSection").classList.toggle("hidden", !reportsAllowed);
      if (!reportsAllowed) return;
      $("entityReportsList").innerHTML = reports.length ? reports.map(row => {
        const url = "/api/report/download?id=" + encodeURIComponent(row.id_informe) + "&inline=1";
        return '<article class="entityReportItem"><div><h4>' + html(row.archivo_word || "Informe") + '</h4><div class="meta"><span class="pill">' + html(row.tipo_informe || "Informe") + '</span><span class="pill">' + html(row.fecha_generacion || "") + '</span>' + (row.usuario ? '<span class="pill">' + html(row.usuario) + '</span>' : '') + '</div></div><a href="' + url + '" target="_blank" rel="noopener"><button class="ghost">Abrir</button></a></article>';
      }).join("") : '<div class="empty">Todavia no se han generado informes de esta ficha.</div>';
    }

    function renderAttachments(attachments) {
      $("attachmentsList").innerHTML = attachments.length ? attachments.map(row => {
        const name = row.nombre_archivo || "Anexo";
        const extension = name.includes(".") ? name.split(".").pop().toUpperCase() : "ARCHIVO";
        const url = "/api/attachment?id=" + encodeURIComponent(row.id_anexo);
        const isImage = /\.(png|jpe?g|gif|webp)$/i.test(name);
        const preview = row.available && isImage
          ? '<img class="attachmentPreview" loading="lazy" src="' + url + '&inline=1" alt="' + html(name) + '" />'
          : '<div class="attachmentIcon">' + html(extension) + '</div>';
        const actions = row.available
          ? '<div class="cardActions"><a href="' + url + '&inline=1" target="_blank" rel="noopener"><button class="ghost">Abrir</button></a><a href="' + url + '&download=1"><button>Descargar</button></a></div>'
          : '<span class="dangerText">Pendiente de migrar al servidor</span>';
        return '<article class="attachmentCard">' + preview + '<h4>' + html(name) + '</h4><span class="muted">' + html(row.fecha_adjuntado || "") + '</span>' + actions + '</article>';
      }).join("") : '<div class="empty">No hay anexos.</div>';
    }

    async function uploadSelectedAttachments() {
      if (!selectedEntity) return;
      const files = [...$("attachmentFiles").files];
      if (!files.length) {
        $("attachmentMessage").textContent = "Selecciona al menos un archivo.";
        return;
      }
      $("uploadAttachmentsButton").disabled = true;
      let uploaded = 0;
      try {
        for (const file of files) {
          $("attachmentMessage").textContent = "Subiendo " + (uploaded + 1) + " de " + files.length + ": " + file.name;
          const response = await fetch(
            "/api/entity/attachment?type=" + encodeURIComponent(selectedEntity.type) + "&id=" + encodeURIComponent(selectedEntity.id),
            {
              method: "POST",
              credentials: "same-origin",
              headers: { "X-File-Name": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" },
              body: file
            }
          );
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "No se pudo subir " + file.name);
          uploaded += 1;
        }
        $("attachmentFiles").value = "";
        $("attachmentMessage").textContent = uploaded + " archivo(s) guardado(s).";
        await openEntity(selectedEntity.type, selectedEntity.id, false);
        $("attachmentMessage").textContent = uploaded + " archivo(s) guardado(s).";
      } catch (error) {
        $("attachmentMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      } finally {
        $("uploadAttachmentsButton").disabled = false;
      }
    }

    async function uploadEntityFiles(type, id, files, statusCallback) {
      let uploaded = 0;
      for (const file of files) {
        if (statusCallback) statusCallback("Subiendo " + (uploaded + 1) + " de " + files.length + ": " + file.name);
        const response = await fetch(
          "/api/entity/attachment?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id),
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "X-File-Name": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" },
            body: file
          }
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "No se pudo subir " + file.name);
        uploaded += 1;
      }
      return uploaded;
    }

    function quickAttachEntityFiles(type, id, title = "") {
      if (!canWrite()) {
        alert("Tu perfil no tiene permiso para adjuntar archivos.");
        return;
      }
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.style.display = "none";
      input.addEventListener("change", async () => {
        const files = [...(input.files || [])];
        if (!files.length) {
          input.remove();
          return;
        }
        const names = files.slice(0, 12).map(file => "- " + file.name).join("\\n");
        const extra = files.length > 12 ? "\\n- ... y " + (files.length - 12) + " archivo(s) mas" : "";
        const target = safe(title) || (type === "project" ? "proyecto seleccionado" : "tarea seleccionada");
        if (!confirm("Se adjuntaran " + files.length + " archivo(s) a:\\n\\n" + target + "\\n\\n" + names + extra + "\\n\\nConfirmas?")) {
          input.remove();
          return;
        }
        try {
          await uploadEntityFiles(type, id, files);
          await loadOverview();
          if (selectedEntity && selectedEntity.type === type && String(selectedEntity.id) === String(id)) {
            await openEntity(type, id, false);
          }
          alert(files.length + " archivo(s) adjuntado(s) correctamente.");
        } catch (error) {
          alert(error.message);
        } finally {
          input.remove();
        }
      });
      document.body.appendChild(input);
      input.click();
    }

    async function generateReport(type, id, targetWindow = null) {
      const reportWindow = targetWindow || window.open("", "_blank");
      if (reportWindow) reportWindow.opener = null;
      $("reportMessage").textContent = "Generando informe...";
      $("generateReportButton").disabled = true;
      $("generateReportBottom").disabled = true;
      try {
        const result = await api("/api/report/generate", {
          method: "POST",
          body: JSON.stringify({ type, id })
        });
        const url = "/api/report/download?id=" + encodeURIComponent(result.report_id) + "&inline=1";
        $("reportMessage").innerHTML = 'Informe creado. <a href="' + url + '" target="_blank" rel="noopener">Abrir o descargar</a>';
        if (reportWindow) reportWindow.location.href = url;
      } catch (error) {
        if (reportWindow && !reportWindow.closed) reportWindow.close();
        $("reportMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
        throw error;
      } finally {
        $("generateReportButton").disabled = false;
        $("generateReportBottom").disabled = false;
      }
    }

    function generateSelectedReport() {
      if (!selectedEntity) return;
      generateReport(selectedEntity.type, selectedEntity.id, window.open("", "_blank")).catch(() => {});
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
      const reportsAllowed = (state.usuario || {}).rol !== "Presidente";
      $("entityBrief").innerHTML = entityBriefHtml(item, type, detail.history || [], detail.attachments || [], detail.reports || [], reportsAllowed);
      $("generateReportButton").classList.toggle("hidden", !reportsAllowed);
      $("entityReportSection").classList.toggle("hidden", !reportsAllowed);
      $("focusRecordButton").classList.toggle("hidden", !writable || (state.usuario || {}).rol === "Presidente");
      $("entityCopilotButton").classList.toggle("hidden", !["Superusuario", "Administrador", "Usuario"].includes((state.usuario || {}).rol));
      $("toggleEditEntity").classList.toggle("hidden", !writable);
      $("archiveEntityButton").classList.toggle("hidden", !writable);
      $("attachmentUploadBox").classList.toggle("hidden", !writable);
      $("attachmentFiles").value = "";
      $("attachmentMessage").textContent = "";
      $("reportMessage").textContent = "";
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
      $("quickRecordBox").classList.toggle("hidden", !canWrite());
      updateBlockReasonVisibility();
      $("recordSection").classList.toggle("hidden", (state.usuario || {}).rol === "Presidente");
      renderHistory(detail.history || []);
      renderAttachments(detail.attachments || []);
      renderEntityReports(detail.reports || [], reportsAllowed);
      $("entityModal").classList.remove("hidden");
      if (focusRecord) setTimeout(focusRecordSection, 50);
    }

    function focusRecordSection() {
      $("recordSection").scrollIntoView({ behavior: "smooth", block: "start" });
      $("quickRecordText").focus();
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
        const reviewedType = selectedEntity.type;
        const reviewedId = selectedEntity.id;
        await api("/api/entity/record", {
          method: "POST",
          body: JSON.stringify({ type: selectedEntity.type, id: selectedEntity.id, payload })
        });
        if (currentView === "review") {
          (reviewedType === "task" ? reviewProgress.tasks : reviewProgress.projects).add(Number(reviewedId));
        }
        $("recordMessage").textContent = "Seguimiento guardado.";
        await loadOverview();
        await openEntity(reviewedType, reviewedId, false);
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

    function setActiveNavigation(view) {
      ["homeTab", "projectTab", "taskTab", "assemblyTab", "securityTab", "mapTab", "workTab", "reviewTab", "globalSearchTab", "documentsTab", "reportsTab", "importTab", "notificationTab", "aiTab", "adminTab"].forEach(id => $(id).classList.remove("active"));
      const target = ({ home: "homeTab", projects: "projectTab", tasks: "taskTab", assemblies: "assemblyTab", security: "securityTab", map: "mapTab", work: "workTab", review: "reviewTab", "global-search": "globalSearchTab", documents: "documentsTab", reports: "reportsTab", imports: "importTab", notifications: "notificationTab", ai: "aiTab", admin: "adminTab" })[view];
      if (target) $(target).classList.add("active");
      const navGroup = document.querySelector(".navGroup");
      if (navGroup && target && navGroup.contains($(target))) navGroup.open = true;
      $("appView").dataset.view = view;
      syncMobileNavigation();
    }

    function syncMobileNavigation() {
      const drawer = $("mobileDrawerNav");
      if (!drawer) return;
      const visibleTabs = [...document.querySelectorAll(".tabs .tab:not(.hidden)")];
      drawer.innerHTML = visibleTabs.map(tab => {
        const view = tab.dataset.view;
        const spans = [...tab.querySelectorAll("span")];
        const label = safe(spans[0]?.textContent) || view;
        const count = safe(spans[spans.length - 1]?.textContent);
        const divider = ["map", "global-search"].includes(view) ? '<div class="mobileDrawerDivider" aria-hidden="true"></div>' : "";
        const showBadge = /^\\d+$/.test(count) || view === "ai";
        return divider + '<button class="mobileDrawerItem' + (view === currentView ? " active" : "") + '" type="button" data-mobile-view="' + html(view) + '"' + (view === currentView ? ' aria-current="page"' : "") + '><span>' + html(label) + '</span>' + (showBadge ? '<span class="mobileDrawerBadge">' + html(count) + '</span>' : "") + '</button>';
      }).join("");
      const filtersAvailable = ["tasks", "projects"].includes(currentView);
      $("mobileFiltersToggle").classList.toggle("hidden", !filtersAvailable);
      if (!filtersAvailable) {
        $("listFilters").classList.remove("mobile-open");
        document.querySelector(".sidebar")?.classList.remove("filters-open");
      }
    }

    function openMobileDrawer() {
      if (!window.matchMedia("(max-width: 700px)").matches || $("appView").classList.contains("hidden") || (state.usuario || {}).rol === "Seguridad") return;
      syncMobileNavigation();
      document.body.classList.add("mobile-drawer-open");
      $("mobileDrawer").setAttribute("aria-hidden", "false");
      $("mobileMenuToggle").setAttribute("aria-expanded", "true");
      setTimeout(() => document.querySelector(".mobileDrawerItem.active")?.focus(), 30);
    }

    function closeMobileDrawer() {
      document.body.classList.remove("mobile-drawer-open");
      $("mobileDrawer").setAttribute("aria-hidden", "true");
      $("mobileMenuToggle").setAttribute("aria-expanded", "false");
    }

    function screenContextForCopilot() {
      const title = safe($("contentTitle")?.textContent);
      const subtitle = safe($("contentSubtitle")?.textContent);
      const visible = safe($("visibleCount")?.textContent);
      const context = [
        "Vista actual: " + (title || currentView),
        subtitle ? "Descripcion: " + subtitle : "",
        visible ? "Conteo visible: " + visible : "",
      ];
      if (!$("entityModal").classList.contains("hidden") && selectedEntity) {
        context.push("Ficha abierta: " + (selectedEntity.type === "project" ? "Proyecto" : "Tarea"));
        context.push("Titulo: " + itemTitle(selectedEntity.item, selectedEntity.type));
        context.push("Estado: " + itemState(selectedEntity.item, selectedEntity.type));
        context.push("Responsable actual: " + itemOwner(selectedEntity.item, selectedEntity.type));
        context.push("Proximo responsable: " + safe(selectedEntity.item.responsable_proximo_paso || ""));
        context.push("Proximo paso: " + safe(selectedEntity.item.proximo_paso || selectedEntity.item.observaciones || ""));
        const briefText = safe($("entityBrief")?.innerText).slice(0, 1200);
        if (briefText) context.push("Resumen visible de ficha: " + briefText);
      } else if (currentView === "map") {
        const map = (state.daily || {}).map || {};
        context.push("Bloques de Trabajo Hoy: " + Object.entries(map.counts || {}).map(([key, value]) => key + " " + value).join(", "));
      } else if (["tasks", "projects"].includes(currentView)) {
        const rows = activeRows();
        context.push("Listado: " + rows.length + " elemento(s) accesibles.");
        context.push("Filtros: busqueda=" + safe($("search")?.value || "sin filtro") + ", estado=" + safe($("stateFilter")?.value || "todos") + ", comunidad=" + safe($("communityFilter")?.value || "todas"));
        context.push("Primeros elementos visibles: " + rows.slice(0, 8).map(row => rowTitle(row)).filter(Boolean).join(" | "));
      } else if (currentView === "security") {
        const overview = securityData.overview || {};
        context.push("Seguridad: pendientes=" + safe(overview.pending || 0) + ", incidencias=" + safe(overview.total || 0));
      } else if (currentView === "assemblies") {
        context.push(selectedAssemblyId ? "Asamblea abierta ID: " + selectedAssemblyId : "Listado de asambleas.");
      }
      const automation = automationInsights().filter(row => row.kind !== "success").slice(0, 5);
      if (automation.length) context.push("Alertas automaticas: " + automation.map(row => row.title + " (" + row.count + ")").join(" | "));
      return context.filter(Boolean).join("\\n");
    }

    function updateCopilotContext() {
      const text = screenContextForCopilot();
      $("copilotContextBox").textContent = text || "Sin contexto cargado.";
      return text;
    }

    function openCopilot(preset = "") {
      if (!["Superusuario", "Administrador", "Usuario"].includes((state.usuario || {}).rol)) return;
      updateCopilotContext();
      $("copilotPanel").classList.remove("hidden");
      $("copilotBackdrop").classList.remove("hidden");
      applyCopilotPreset(preset);
      setTimeout(() => $("copilotText").focus(), 30);
    }

    function closeCopilot() {
      $("copilotPanel").classList.add("hidden");
      $("copilotBackdrop").classList.add("hidden");
    }

    function applyCopilotPreset(preset) {
      const prompts = {
        ask: "Responde usando el contexto de esta pantalla: ",
        update: "Prepara una actualizacion revisable para esta ficha con lo siguiente: ",
        summary: "Prepara un resumen ejecutivo profesional para copiar en un email sobre esta ficha o pantalla.",
        risks: "Analiza esta pantalla y dime que asuntos requieren atencion, riesgos o siguientes pasos.",
      };
      if (prompts[preset]) $("copilotText").value = prompts[preset];
    }

    function copilotContextualText() {
      const userText = safe($("copilotText").value);
      const context = updateCopilotContext();
      return [
        "Contexto de pantalla actual para el copiloto:",
        context || "Sin contexto de pantalla.",
        "",
        "Instruccion del usuario:",
        userText,
      ].join("\\n");
    }

    function mobilePage(rows, key, pageSize = 8) {
      if (!window.matchMedia("(max-width: 700px)").matches) return { rows, footer: "" };
      const limit = mobileVisibleLimits[key] || pageSize;
      const visible = rows.slice(0, limit);
      const remaining = Math.max(0, rows.length - visible.length);
      const footer = remaining
        ? '<div class="mobileMoreWrap"><button class="mobileMore" data-mobile-more="' + html(key) + '" data-mobile-total="' + rows.length + '" data-mobile-step="' + pageSize + '">Mostrar ' + Math.min(pageSize, remaining) + ' mas (' + remaining + ' pendientes)</button></div>'
        : "";
      return { rows: visible, footer };
    }

    function automationInsights() {
      const workflow = state.workflow || {};
      const daily = state.daily || {};
      const isPresident = (state.usuario || {}).rol === "Presidente";
      const reviewItems = ((workflow.review || {}).items || []);
      const mapItems = ((daily.map || {}).items || []);
      const notifications = workflow.notifications || [];
      const actions = workflow.actions || [];
      const presidentRequests = workflow.president_requests || [];
      const unread = Number(workflow.unread_notifications || 0);
      const insights = [];

      function sampleTitles(rows, limit = 3) {
        return (rows || []).slice(0, limit).map(row => row.elemento || row.titulo || "").filter(Boolean).join(" | ");
      }
      function add(kind, title, detail, count, action, view, rows) {
        if (Number(count) > 0 || count === "OK") insights.push({ kind, title, detail, count, action, view, rows: rows || [], sample: sampleTitles(rows || []) });
      }

      if (isPresident) {
        add("risk", "Decisiones pendientes", "Hay solicitudes que necesitan aprobacion, rechazo o aclaracion.", presidentRequests.length, "Ver decisiones", "work", presidentRequests);
        add("info", "Notificaciones sin leer", "Hay avisos recientes relacionados con tus solicitudes.", unread, "Abrir notificaciones", "notifications", notifications.filter(row => !row.leida));
        if (!insights.length) add("success", "Sin alertas pendientes", "No hay decisiones ni notificaciones pendientes ahora.", "OK", "Ver decisiones", "work", []);
        return insights.slice(0, 8);
      }

      const overdue = reviewItems.filter(row => (row.review_reasons || []).includes("Vencida"));
      const blocked = reviewItems.filter(row => (row.review_reasons || []).includes("Bloqueada"));
      const stale = reviewItems.filter(row => (row.review_reasons || []).includes("Sin actualizar"));
      const thirdParty = reviewItems.filter(row => (row.review_reasons || []).includes("Pendiente de tercero"));
      const mine = reviewItems.filter(row => (row.review_reasons || []).includes("Pendiente de mi"));
      const riskMap = mapItems.filter(row => row.seccion === "Bloqueado / riesgo");
      const needsAction = mapItems.filter(row => row.seccion === "Necesita acción");

      add("risk", "Vencimientos vencidos", "Hay asuntos con fecha objetivo superada que conviene revisar hoy.", overdue.length, "Revisar vencidas", "review", overdue);
      add("risk", "Bloqueos o riesgos", "Elementos marcados como bloqueados o situados en zona de riesgo.", Math.max(blocked.length, riskMap.length), "Abrir Trabajo Hoy", "map", riskMap.length ? riskMap : blocked);
      add("warning", "Sin seguimiento reciente", "Hay elementos activos sin actualizacion en mas de 7 dias.", stale.length, "Revisar seguimiento", "review", stale);
      add("warning", "Pendiente de terceros", "Conviene reclamar, registrar espera o fijar siguiente fecha de control.", thirdParty.length, "Ver terceros", "map", thirdParty);
      add("info", "Acciones para mi", "Tu bandeja contiene proximos pasos asignados a tu usuario.", Math.max(actions.length, mine.length, needsAction.length), "Ver mi bandeja", "map", actions.length ? actions : mine.length ? mine : needsAction);
      add("info", "Notificaciones sin leer", "Hay aprobaciones, rechazos, aclaraciones o avisos pendientes.", unread, "Abrir notificaciones", "notifications", notifications.filter(row => !row.leida));
      if (!insights.length) add("success", "Trabajo bajo control", "No hay alertas automaticas criticas en este momento.", "OK", "Abrir Trabajo Hoy", "map", []);
      return insights.slice(0, 8);
    }

    function automationCardHtml(item) {
      return '<article class="automationCard ' + html(item.kind || "info") + '">' +
        '<div><h3>' + html(item.title) + '</h3><div class="line">' + html(item.detail) + '</div>' +
        (item.sample ? '<div class="line muted">Ejemplos: ' + html(item.sample) + '</div>' : '') + '</div>' +
        '<div class="automationCardActions"><span class="tabBadge">' + html(item.count) + '</span><button class="ghost" data-automation-view="' + html(item.view || "map") + '">' + html(item.action || "Abrir") + '</button></div>' +
      '</article>';
    }

    function automationPanelHtml(limit = 6) {
      const insights = automationInsights().slice(0, limit);
      return '<section class="automationPanel"><div class="contentHead"><div><h2>Alertas automaticas</h2><p class="muted">Senales calculadas sin modificar datos: vencimientos, bloqueos, terceros, notificaciones y asuntos sin seguimiento.</p></div><span class="pill">No destructivo</span></div><div class="automationList">' +
        (insights.length ? insights.map(automationCardHtml).join("") : '<div class="empty">Sin alertas automaticas.</div>') +
      '</div></section>';
    }

    function homePanelHtml() {
      const daily = state.daily || {};
      const metrics = daily.metrics || {};
      const president = (state.usuario || {}).rol === "Presidente";
      const attention = ((daily.map || {}).items || []).filter(row => ["Necesita acción", "Bloqueado / riesgo"].includes(row.seccion)).slice(0, 8);
      const actions = president
        ? '<button data-home-view="work">Ver decisiones</button><button class="ghost" data-home-view="projects">Consultar proyectos</button>'
        : '<button data-home-view="map">Abrir Trabajo Hoy</button><button class="green" data-home-view="ai">Actualizar con IA</button><button class="ghost" data-home-create="task">Nueva tarea</button><button class="ghost" data-home-create="project">Nuevo proyecto</button>';
      const attentionRows = attention.length ? attention.map(row =>
        '<div class="attentionRow"><div><div class="attentionTitle">' + html(row.titulo) + '</div><div class="muted">' + html(row.entity_type === "task" ? "Tarea" : "Proyecto") + ' · ' + html(row.comunidad || "") + '</div></div>' +
        '<div><span class="pill state-' + slug(row.estado) + '">' + html(row.estado || "Sin estado") + '</span></div>' +
        '<div><strong>' + html(row.responsable_proximo_paso || row.responsable || "Sin responsable") + '</strong><div class="muted">' + html(row.fecha_objetivo || "Sin fecha") + '</div></div>' +
        '<button class="ghost" data-daily-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir</button></div>'
      ).join("") : '<div class="empty">No hay elementos críticos en este momento.</div>';
      return '<div class="homeHero"><div><h2>Buenos días, ' + html((state.usuario || {}).nombre || "") + '</h2><p>Resumen operativo actualizado para tus comunidades.</p></div><div class="homeActions">' + actions + '</div></div>' +
        '<div class="grid homeMetrics">' +
          countCard("Trabajo activo", metrics.activos || 0) +
          countCard(president ? "Decisiones pendientes" : "Acciones para mi", president ? (state.workflow.president_requests || []).length : (state.workflow.actions || []).length) +
          countCard("Necesitan acción", ((daily.map || {}).counts || {})["Necesita acción"] || 0) +
          countCard("Bloqueados / riesgo", ((daily.map || {}).counts || {})["Bloqueado / riesgo"] || 0) +
        '</div>' +
        automationPanelHtml(4) +
        '<section><div class="contentHead"><div><h2>Atención prioritaria</h2><p class="muted">Elementos que requieren actuación o presentan riesgo.</p></div></div><div class="attentionList">' + attentionRows + '</div></section>';
    }

    function dailyMapCard(row) {
      const key = row.entity_type + "-" + row.entity_id;
      const selected = selectedMapKey === key;
      return '<article class="card mapCard priority-' + slug(row.prioridad) + (selected ? ' selected' : '') + '" data-map-key="' + html(key) + '">' +
        '<h3>' + html(row.titulo) + '</h3>' +
        '<div class="meta"><span class="pill">' + html(row.entity_type === "task" ? "Tarea" : "Proyecto") + '</span><span class="pill state-' + slug(row.estado) + '">' + html(row.estado || "Sin estado") + '</span><span class="pill">' + html(row.comunidad || "") + '</span></div>' +
        '<div class="line"><strong>Próximo responsable:</strong> ' + html(row.responsable_proximo_paso || row.responsable || "Sin asignar") + ' · ' + html(row.grupo_responsable || "") + '</div>' +
        '<div class="line"><strong>Fecha:</strong> ' + html(row.fecha_objetivo || "Sin fecha") + '</div>' +
        '<div class="nextStep"><div class="line"><strong>Próximo paso:</strong> ' + html(row.detalle || "Sin definir") + '</div>' + (row.ultimo_comentario ? '<div class="line"><strong>Último comentario:</strong> ' + html(row.ultimo_comentario) + '</div>' : '') + '</div>' +
        '<div class="cardActions mapCardActions"><button class="ghost" data-daily-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir ficha</button>' +
        (canWrite() ? '<button class="green" data-daily-action="record" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Seguimiento</button>' : '') +
        (canWrite() ? '<button data-daily-action="attach" data-title="' + html(row.titulo) + '" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Adjuntar</button>' : '') +
        ((state.usuario || {}).rol !== "Presidente" ? '<button data-daily-action="report" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Informe</button>' : '') + '</div>' +
      '</article>';
    }

    function mapPanelHtml() {
      const map = (state.daily || {}).map || { items: [], counts: {} };
      const workflow = state.workflow || {};
      const actions = workflow.actions || [];
      const reviewItems = ((workflow.review || {}).items || []).slice(0, 6);
      const sections = [
        ["Necesita acción", "#065f46"],
        ["Pendiente de terceros", "#92400e"],
        ["En seguimiento", "#1d4ed8"],
        ["Bloqueado / riesgo", "#991b1b"]
      ];
      const actionCards = actions.length
        ? actions.slice(0, 6).map(workflowActionCard).join("")
        : '<div class="empty">No tienes acciones pendientes asignadas directamente.</div>';
      const reviewCards = reviewItems.length
        ? reviewItems.map(reviewCard).join("")
        : '<div class="empty">No hay revisiones prioritarias en este momento.</div>';
      return '<div class="workTodayShell">' +
        '<section class="workTodayHero"><div><h2>Trabajo Hoy</h2><p>Una vista unica para decidir que atender, actualizar y revisar sin cambiar de pantalla.</p></div>' +
          '<div class="homeActions"><button class="green" data-home-view="ai">Actualizar con IA</button><button data-home-create="task">Nueva tarea</button><button data-home-create="project">Nuevo proyecto</button><button class="ghost" data-home-view="notifications">Notificaciones</button></div></section>' +
        '<div class="workTodaySummary">' +
          countCard("Acciones para mi", actions.length) +
          countCard("Necesitan accion", (map.counts || {})["Necesita acción"] || 0) +
          countCard("Pendiente terceros", (map.counts || {})["Pendiente de terceros"] || 0) +
          countCard("Bloqueo / riesgo", (map.counts || {})["Bloqueado / riesgo"] || 0) +
        '</div>' +
        automationPanelHtml(6) +
        '<div class="workTodayGrid">' +
          '<section class="workTodayPanel"><div class="contentHead"><div><h2>Mi bandeja</h2><p class="muted">Elementos cuyo siguiente paso depende de ti.</p></div><span class="tabBadge">' + actions.length + '</span></div><div class="workTodayList">' + actionCards + '</div></section>' +
          '<section class="workTodayPanel"><div class="contentHead"><div><h2>Revision prioritaria</h2><p class="muted">Vencidas, bloqueadas o sin movimiento relevante.</p></div><span class="tabBadge">' + reviewItems.length + '</span></div><div class="workTodayList">' + reviewCards + '</div></section>' +
        '</div>' +
        '<div class="mapBoard">' + sections.map(([name, color]) => {
        const rows = (map.items || []).filter(row => row.seccion === name);
        const page = mobilePage(rows, "map-" + slug(name), 4);
        return '<section class="mapSection"><div class="mapSectionHead"><h3 style="color:' + color + '">' + html(name) + '</h3><span class="tabBadge">' + rows.length + '</span></div><div class="mapSectionBody">' +
          (rows.length ? page.rows.map(dailyMapCard).join("") + page.footer : '<div class="empty">Sin elementos.</div>') + '</div></section>';
      }).join("") + '</div></div>';
    }

    function searchResultCard(row) {
      const openAction = row.result_type === "attachment" ? "attachment" : row.result_type === "report" ? "report-file" : "open";
      const openLabel = row.result_type === "attachment" ? "Abrir anexo" : row.result_type === "report" ? "Abrir informe" : "Abrir ficha";
      return '<article class="card resultCard"><div><h3>' + html(row.titulo || "Sin título") + '</h3>' +
        '<div class="meta"><span class="pill">' + html(row.tipo || "Resultado") + '</span><span class="pill">' + html(row.comunidad || "") + '</span>' + (row.fecha ? '<span class="pill">' + html(row.fecha) + '</span>' : '') + '</div>' +
        '<div class="line" style="margin-top:8px">' + html(row.detalle || "") + '</div></div>' +
        '<button class="ghost" data-search-action="' + openAction + '" data-id="' + html(row.id) + '" data-type="' + html(row.entity_type || "") + '" data-entity-id="' + html(row.entity_id || row.id || "") + '">' + openLabel + '</button></article>';
    }

    function globalSearchPanelHtml() {
      const communities = ((state.daily || {}).communities || []).map(row => '<option value="' + html(row.id || row.id_comunidad) + '">' + html(row.nombre) + '</option>').join("");
      return '<div class="searchControls"><div><label>Buscar</label><input id="globalSearchInput" placeholder="Proyecto, tarea, comentario, responsable, anexo..." /></div>' +
        '<div><label>Tipo</label><select id="globalSearchType"><option value="all">Todo</option><option value="entity">Tareas y proyectos</option><option value="record">Seguimientos</option><option value="document">Documentos e informes</option><option value="action">Acciones</option></select></div>' +
        '<div><label>Comunidad</label><select id="globalSearchCommunity"><option value="">Todas las comunidades</option>' + communities + '</select></div>' +
        '<button id="runGlobalSearch">Buscar</button></div><div class="muted" id="globalSearchMessage">Escribe una palabra o nombre para buscar en toda la información permitida.</div><div class="resultList" id="globalSearchResults"></div>';
    }

    function bindGlobalSearchPanel() {
      $("runGlobalSearch").addEventListener("click", runGlobalSearch);
      $("globalSearchInput").addEventListener("keydown", event => { if (event.key === "Enter") runGlobalSearch(); });
      $("globalSearchResults").innerHTML = globalSearchResults.map(searchResultCard).join("");
    }

    async function runGlobalSearch() {
      const term = safe($("globalSearchInput").value);
      if (!term) { $("globalSearchMessage").textContent = "Introduce un texto para buscar."; return; }
      $("globalSearchMessage").textContent = "Buscando...";
      try {
        const query = new URLSearchParams({ q: term, type: $("globalSearchType").value, community: $("globalSearchCommunity").value });
        const data = await api("/api/global-search?" + query.toString());
        globalSearchResults = data.results || [];
        $("globalSearchMessage").textContent = globalSearchResults.length + " resultados.";
        $("globalSearchResults").innerHTML = globalSearchResults.length ? globalSearchResults.map(searchResultCard).join("") : '<div class="empty">No se encontraron coincidencias.</div>';
      } catch (error) {
        $("globalSearchMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    function documentUrl(row, inline = true) {
      return row.document_type === "attachment"
        ? "/api/attachment?id=" + encodeURIComponent(row.id) + (inline ? "&inline=1" : "&download=1")
        : "/api/report/download?id=" + encodeURIComponent(row.id);
    }

    function documentCard(row) {
      const extension = safe(row.nombre || row.ruta).split(".").pop().toUpperCase().slice(0, 8) || "DOC";
      const imageFile = /\.(png|jpe?g|gif|webp|bmp)$/i.test(row.nombre || row.ruta || "");
      const preview = row.document_type === "attachment" && imageFile
        ? '<img class="documentPreview" loading="lazy" src="' + documentUrl(row, true) + '" alt="' + html(row.nombre) + '" />'
        : '<div class="documentFileIcon">' + html(row.document_type === "report" ? "WORD" : extension) + '</div>';
      return '<article class="documentCard">' + preview + '<h3>' + html(row.nombre || "Documento") + '</h3>' +
        '<div class="meta"><span class="pill">' + html(row.document_type === "report" ? "Informe" : "Anexo") + '</span><span class="pill">' + html(row.comunidad || "") + '</span></div>' +
        '<div class="line"><strong>Relacionado:</strong> ' + html(row.tarea || row.proyecto || "Sin relación") + '</div><div class="muted">' + html(row.fecha || "") + '</div>' +
        '<div class="cardActions"><button class="ghost" data-document-action="open" data-id="' + html(row.id) + '">Abrir</button><button data-document-action="download" data-id="' + html(row.id) + '">Descargar</button>' +
        (row.entity_id ? '<button class="green" data-document-action="related" data-type="' + html(row.entity_type) + '" data-entity-id="' + html(row.entity_id) + '">Ver ficha</button>' : '') + '</div></article>';
    }

    function filteredDocuments() {
      const query = documentQuery.toLowerCase();
      return ((state.daily || {}).documents || []).filter(row =>
        (documentType === "all" || row.document_type === documentType) &&
        (!documentCommunity || String(row.id_comunidad) === String(documentCommunity)) &&
        (!query || [row.nombre,row.comunidad,row.tarea,row.proyecto,row.fecha].join(" ").toLowerCase().includes(query))
      );
    }

    function documentsPanelHtml() {
      const communities = ((state.daily || {}).communities || []).map(row => '<option value="' + html(row.id || row.id_comunidad) + '"' + (String(row.id || row.id_comunidad) === String(documentCommunity) ? " selected" : "") + '>' + html(row.nombre) + '</option>').join("");
      return '<div class="documentControls"><div><label>Filtrar documentos</label><input id="documentQuery" value="' + html(documentQuery) + '" placeholder="Nombre, proyecto, tarea..." /></div>' +
        '<div><label>Tipo</label><select id="documentType"><option value="all">Todos</option><option value="attachment"' + (documentType === "attachment" ? " selected" : "") + '>Anexos</option><option value="report"' + (documentType === "report" ? " selected" : "") + '>Informes</option></select></div>' +
        '<div><label>Comunidad</label><select id="documentCommunity"><option value="">Todas las comunidades</option>' + communities + '</select></div></div>' +
        '<div class="muted" id="documentCount"></div><div class="documentGrid" id="documentResults"></div>';
    }

    function renderDocumentResults() {
      const rows = filteredDocuments();
      const page = mobilePage(rows, "documents", 8);
      $("documentCount").textContent = page.rows.length === rows.length ? rows.length + " documentos visibles." : "Mostrando " + page.rows.length + " de " + rows.length + " documentos.";
      $("documentResults").innerHTML = rows.length ? page.rows.map(documentCard).join("") + page.footer : '<div class="empty">No hay documentos con estos filtros.</div>';
    }

    function bindDocumentsPanel() {
      $("documentQuery").addEventListener("input", event => { documentQuery = event.target.value; renderDocumentResults(); });
      $("documentType").addEventListener("change", event => { documentType = event.target.value; renderDocumentResults(); });
      $("documentCommunity").addEventListener("change", event => { documentCommunity = event.target.value; renderDocumentResults(); });
      renderDocumentResults();
    }

    function assemblyStatusClass(value) {
      return safe(value).toLowerCase().includes("celebr") ? "state-En-curso" : safe(value).toLowerCase().includes("cerr") ? "state-Finalizado" : "state-Pendiente";
    }

    function assemblyCardHtml(row) {
      return '<article class="assemblyCard" data-assembly-open="' + html(row.id_asamblea) + '">' +
        '<div class="meta"><span class="pill ' + assemblyStatusClass(row.estado) + '">' + html(row.estado || "Preparacion") + '</span><span class="pill">' + html(row.comunidad || "") + '</span></div>' +
        '<h3>' + html(row.nombre || row.codigo) + '</h3>' +
        '<div class="line"><strong>Fecha:</strong> ' + html(row.fecha || "Sin fecha") + ' | <strong>Convocatoria:</strong> ' + html(row.convocatoria || "") + '</div>' +
        '<div class="meta"><span class="pill">' + html(String(row.total_puntos ?? 0)) + ' puntos</span><span class="pill">' + html(String(row.total_asistencia ?? 0)) + ' asistentes</span><span class="pill">' + html(String(row.total_proxys ?? 0)) + ' proxys</span></div>' +
      '</article>';
    }

    function newAssemblyFormHtml() {
      if (!canWrite()) return "";
      const communities = ((state.daily || {}).communities || []).map(row => '<option value="' + html(row.id || row.id_comunidad) + '">' + html(row.nombre) + '</option>').join("");
      return '<details class="assemblyPane"><summary><strong>Nueva asamblea</strong></summary><div class="formGrid" style="margin-top:10px">' +
        '<div><label>Comunidad</label><select id="newAssemblyCommunity">' + communities + '</select></div><div><label>Codigo</label><input id="newAssemblyCode" placeholder="JGO-2026" /></div>' +
        '<div><label>Nombre</label><input id="newAssemblyName" placeholder="Junta General Ordinaria 2026" /></div><div><label>Fecha</label><input id="newAssemblyDate" type="date" /></div>' +
        '<div><label>Convocatoria</label><select id="newAssemblyCall"><option value="segunda">Segunda</option><option value="primera">Primera</option></select></div>' +
        '<div><label>Estado</label><select id="newAssemblyState"><option>Preparacion</option><option>Convocada</option><option>En celebracion</option><option>Cerrada</option><option>Archivada</option></select></div></div>' +
        '<div class="toolbar"><button class="green" id="createAssemblyButton">Crear asamblea</button><span class="muted" id="createAssemblyMessage"></span></div></details>';
    }

    function assemblyListHtml() {
      const rows = assembliesData.assemblies || [];
      return '<div class="assemblyShell">' + newAssemblyFormHtml() + '<div class="assemblyList">' + (rows.length ? rows.map(assemblyCardHtml).join("") : '<div class="empty">No hay asambleas visibles.</div>') + '</div></div>';
    }

    function assemblyTabsHtml() {
      const tabs = [["summary","Resumen"],["registration","Registro"],["voting","Votacion"],["documents","Documentos y proxys"],["minutes","Acta"],["history","Historial"]];
      if (canWrite()) tabs.push(["configuration", "Configuracion"]);
      return '<div class="assemblyTabs">' + tabs.map(row => '<button data-assembly-section="' + row[0] + '" class="' + (assemblySection === row[0] ? "active" : "") + '">' + row[1] + '</button>').join("") + '</div>';
    }

    function assemblyMetricsHtml(detail) {
      const totals = detail.totals || {};
      return '<div class="assemblyMetrics">' + countCard("Censo", (totals.owners || 0) + " votos") + countCard("Propiedades", totals.properties || 0) +
        countCard("Total asistencia", totals.attended_owners || 0) + countCard("Coef. asistencia", Number(totals.attended_coef || 0).toFixed(4)) +
        countCard("Quorum legal", (totals.eligible_votes || 0) + " votos") + countCard("Coef. quorum", Number(totals.eligible_coef || 0).toFixed(4)) + '</div>';
    }

    function resultLabel(result) {
      if (!result || !result.base_votes) return "Sin votacion";
      return result.approved ? "Aprobado" : "No aprobado";
    }

    function agendaItemHtml(point, index) {
      const result = point.result || {};
      return '<article class="agendaItem"><div class="agendaNumber">' + (index + 1) + '</div><div><strong>' + html(point.titulo) + '</strong><div class="muted">Mayoria: ' + html(point.tipo_mayoria || "simple") + '</div></div>' +
        '<span class="pill ' + (result.approved ? "state-Finalizado" : "state-Pendiente") + '">' + resultLabel(result) + '</span></article>';
    }

    function assemblyEditHtml(detail) {
      if (!canWrite()) return "";
      const item = detail.assembly || {};
      const communities = ((state.daily || {}).communities || []).map(row => { const id = row.id || row.id_comunidad; return '<option value="' + html(id) + '"' + (String(id) === String(item.id_comunidad) ? " selected" : "") + '>' + html(row.nombre) + '</option>'; }).join("");
      const states = ["Preparacion","Convocada","En celebracion","Cerrada","Archivada"];
      return '<div class="assemblyPane"><h3>Datos generales</h3><div class="formGrid">' +
        '<div><label>Comunidad</label><select id="assemblyEditCommunity">' + communities + '</select></div><div><label>Codigo</label><input id="assemblyEditCode" value="' + html(item.codigo) + '" /></div>' +
        '<div><label>Nombre</label><input id="assemblyEditName" value="' + html(item.nombre) + '" /></div><div><label>Fecha</label><input id="assemblyEditDate" type="date" value="' + html((item.fecha || "").slice(0,10)) + '" /></div>' +
        '<div><label>Convocatoria</label><select id="assemblyEditCall"><option value="primera"' + (item.convocatoria === "primera" ? " selected" : "") + '>Primera</option><option value="segunda"' + (item.convocatoria !== "primera" ? " selected" : "") + '>Segunda</option></select></div>' +
        '<div><label>Estado</label><select id="assemblyEditState">' + states.map(value => '<option' + (value === item.estado ? " selected" : "") + '>' + value + '</option>').join("") + '</select></div>' +
        '<div><label>Presidente</label><input id="assemblyEditPresident" value="' + html(item.presidente) + '" /></div><div><label>Administrador</label><input id="assemblyEditAdministrator" value="' + html(item.administrador) + '" /></div>' +
        '<div><label>Hora de inicio</label><input id="assemblyEditTime" type="time" value="' + html(item.hora_inicio) + '" /></div><div><label>Lugar</label><input id="assemblyEditPlace" value="' + html(item.lugar_celebracion || item.ubicacion) + '" /></div></div>' +
        '<label>Junta directiva</label><textarea id="assemblyEditBoard">' + html(item.junta_directiva) + '</textarea><label>Observaciones</label><textarea id="assemblyEditNotes">' + html(item.observaciones) + '</textarea>' +
        '<div class="toolbar"><button class="green" id="saveAssemblyEdit">Guardar datos</button><span class="muted" id="assemblyEditMessage"></span></div>' +
        '<h3>Orden del dia</h3><div id="assemblyPointEditors">' + (detail.points || []).map((point,index) => pointEditorHtml(point,index)).join("") + '</div>' +
        '<div class="toolbar"><button class="ghost" id="addAssemblyPoint">Anadir punto</button><button id="saveAssemblyPoints">Guardar orden y mayorias</button><span class="muted" id="assemblyPointsMessage"></span></div></div>';
    }

    function pointEditorHtml(point, index) {
      const majorities = [["simple","Simple"],["3/5","3/5"],["2/3","2/3"],["unanimidad","Unanimidad"]];
      return '<div class="pointEditor" data-point-index="' + index + '" data-point-id="' + html(point.id_punto || "") + '"><strong>P' + (index + 1) + '</strong><div><label>Texto del punto</label><input data-point-title value="' + html(point.titulo || "") + '" /></div>' +
        '<div><label>Mayoria</label><select data-point-majority>' + majorities.map(row => '<option value="' + row[0] + '"' + (row[0] === point.tipo_mayoria ? " selected" : "") + '>' + row[1] + '</option>').join("") + '</select></div>' +
        '<div class="toolbar"><button class="ghost" data-point-move="up" title="Subir">&#8593;</button><button class="ghost" data-point-move="down" title="Bajar">&#8595;</button><button class="red" data-point-remove title="Eliminar">X</button></div></div>';
    }

    function assemblySummaryHtml(detail) {
      const item = detail.assembly || {};
      return assemblyMetricsHtml(detail) + '<div class="assemblySplit"><div class="assemblyPane"><h3>Datos de celebracion</h3>' +
        detailValue("Presidente", item.presidente) + detailValue("Administrador", item.administrador) + detailValue("Junta directiva", item.junta_directiva) + detailValue("Inicio", [item.fecha,item.hora_inicio].filter(Boolean).join(" ")) + detailValue("Lugar", item.lugar_celebracion || item.ubicacion) + '</div>' +
        '<div class="assemblyPane"><h3>Orden del dia y situacion</h3><div class="agendaList">' + ((detail.points || []).length ? detail.points.map(agendaItemHtml).join("") : '<div class="empty">No hay puntos configurados.</div>') + '</div></div></div>';
    }

    function filteredAssemblyOwners(detail) {
      const query = safe(assemblyOwnerQuery).toLowerCase();
      const registered = new Set((detail.attendance || []).map(row => row.propietario));
      return (detail.owners || []).filter(row => !registered.has(row.propietario) && (!query || [row.propietario,row.propiedad_ids].join(" ").toLowerCase().includes(query))).slice(0, 120);
    }

    function assemblyRegistrationHtml(detail) {
      const owners = filteredAssemblyOwners(detail);
      const picker = owners.length ? owners.map(row => '<label class="ownerChoice"><input type="checkbox" data-owner-select="' + html(row.propietario) + '" /><span><strong>' + html(row.propietario) + '</strong><span class="muted" style="display:block">' + html(row.propiedades + " propiedades | coef. " + Number(row.coeficiente || 0).toFixed(4)) + '</span><small>' + html(row.propiedad_ids || "") + '</small></span></label>').join("") : '<div class="empty">No hay coincidencias sin registrar.</div>';
      const attendance = detail.attendance || [];
      const attendancePage = mobilePage(attendance, "assembly-attendance-" + safe((detail.assembly || {}).id_asamblea), 8);
      const rows = attendancePage.rows.map(row => '<div class="attendanceRow"><div><strong>' + html(row.propietario) + '</strong><div class="muted">' + html(row.propiedad_ids || "") + '</div></div><div><span class="pill">' + html(row.tipo) + '</span>' + ((row.sin_voto || row.moroso) ? '<span class="pill state-Bloqueado">Sin voto</span>' : '') + '</div><div>' + (row.tipo === "representado" ? 'Representa: <strong>' + html(row.representante) + '</strong>' : 'Coef. ' + Number(row.coeficiente || 0).toFixed(4)) + '</div>' +
        (canWrite() ? '<div class="toolbar"><button class="ghost" data-attendance-moroso="' + html(row.propietario) + '" data-moroso="' + (row.moroso ? "0" : "1") + '">' + (row.moroso ? "Dar voto" : "Sin voto") + '</button><button class="red" data-attendance-remove="' + html(row.propietario) + '">Quitar</button></div>' : '') + '</div>').join("") + attendancePage.footer;
      return assemblyMetricsHtml(detail) + '<div class="assemblySplit"><div class="assemblyPane"><h3>Registrar asistencia</h3><label>Buscar por propietario o propiedad</label><input id="assemblyOwnerSearch" value="' + html(assemblyOwnerQuery) + '" placeholder="Nombre, CB, villa, plaza..." />' +
        '<div class="ownerResults" id="assemblyOwnerResults">' + picker + '</div><div class="formGrid" style="margin-top:10px"><div><label>Tipo</label><select id="attendanceType"><option value="presente">Presente</option><option value="representado">Representado</option></select></div><div><label>Representante</label><input id="attendanceRepresentative" placeholder="Nombre del representante" /></div></div>' +
        '<label><input id="attendanceWithoutVote" type="checkbox" /> Sin derecho a voto por otra causa</label><div class="toolbar"><button class="green" id="saveAssemblyAttendance">Registrar seleccionados</button><span class="muted" id="attendanceMessage"></span></div></div>' +
        '<div class="assemblyPane"><h3>Presentes y representados (' + (detail.attendance || []).length + ')</h3><div class="attendanceList">' + (rows || '<div class="empty">No hay asistencia registrada.</div>') + '</div></div></div>';
    }

    function voteButton(owner, vote, current, disabled) {
      const label = {si:"SI",no:"NO",abs:"ABS",sin:"SIN"}[vote];
      return '<button data-vote-owner="' + html(owner) + '" data-vote="' + vote + '" class="' + (current === vote ? "active-" + vote : "") + '"' + (disabled ? " disabled" : "") + '>' + label + '</button>';
    }

    function assemblyVotingHtml(detail) {
      const points = detail.points || [];
      if (!points.length) return '<div class="empty">Configura primero los puntos del orden del dia.</div>';
      if (!selectedAssemblyPoint || !points.some(row => Number(row.id_punto) === Number(selectedAssemblyPoint))) selectedAssemblyPoint = Number(points[0].id_punto);
      const point = points.find(row => Number(row.id_punto) === Number(selectedAssemblyPoint));
      const result = point.result || {};
      const summary = '<div class="voteSummary">' + ["si","no","abs","sin"].map(vote => '<div class="answerCard"><span>' + ({si:"A favor",no:"En contra",abs:"Abstencion",sin:"Sin emitir"}[vote]) + '</span><strong>' + html((result[vote]?.votes || 0) + " votos") + '</strong><small>Coef. ' + Number(result[vote]?.coef || 0).toFixed(4) + '</small></div>').join("") + '</div>';
      const groups = (detail.groups || []).map(group => {
        const members = group.members || [];
        const bulk = canWrite() && members.length > 1 ? '<div class="voteActions"><span class="muted">Todos:</span>' + ["si","no","abs"].map(vote => '<button data-vote-group="' + html(group.representante) + '" data-vote="' + vote + '">' + ({si:"SI",no:"NO",abs:"ABS"}[vote]) + '</button>').join("") + '</div>' : '';
        const memberRows = members.map(member => {
          const meta = member.votes?.[String(point.id_punto)] || { voto:"sin", bloqueado:false };
          const disabled = !canWrite() || meta.bloqueado || member.sin_voto || member.moroso;
          return '<div class="voteMember"><div><strong>' + html(member.propietario) + '</strong><div class="muted">' + html(member.tipo === "representado" ? "Representado por " + member.representante : "Voto propio") + '</div></div><div>' + (meta.bloqueado ? '<span class="lockedVote">Proxy instruido</span>' : (member.sin_voto || member.moroso) ? '<span class="dangerText">Sin derecho</span>' : '<span class="pill">' + html((meta.voto || "sin").toUpperCase()) + '</span>') + '</div><div class="voteActions">' + ["si","no","abs","sin"].map(vote => voteButton(member.propietario,vote,meta.voto,disabled)).join("") + '</div></div>';
        }).join("");
        return '<article class="voteGroup"><div class="voteGroupHead"><div><strong>' + html(group.representante) + '</strong><div class="muted">' + members.length + ' voto(s) agrupados</div></div>' + bulk + '</div>' + memberRows + '</article>';
      }).join("");
      return '<div class="votePointSelect"><div><label>Punto en votacion</label><select id="assemblyVotePoint">' + points.map((row,index) => '<option value="' + row.id_punto + '"' + (Number(row.id_punto) === Number(selectedAssemblyPoint) ? " selected" : "") + '>P' + (index + 1) + ' - ' + html(row.titulo) + '</option>').join("") + '</select></div><div><span class="pill ' + (result.approved ? "state-Finalizado" : "state-Pendiente") + '">' + resultLabel(result) + ' | Mayoria ' + html(point.tipo_mayoria) + '</span></div></div>' + summary + '<div class="muted" id="assemblyVoteMessage"></div><div class="voteGroups">' + (groups || '<div class="empty">No hay asistentes registrados.</div>') + '</div>';
    }

    function assemblyDocumentsHtml(detail) {
      const documents = detail.documents || [];
      const proxys = detail.proxys || [];
      const documentRows = documents.length ? documents.map(row => '<article class="reportRow"><div><h3>' + html(row.nombre_archivo) + '</h3><div class="meta"><span class="pill">' + html(row.carpeta || "General") + '</span><span class="pill">' + html(row.fecha_adjuntado || "") + '</span></div><div class="muted">' + html(row.descripcion || "") + '</div></div><div class="toolbar"><button data-assembly-document-open="' + row.id_documento_asamblea + '">Abrir</button>' + (canWrite() ? '<button class="red" data-assembly-document-delete="' + row.id_documento_asamblea + '">Eliminar</button>' : '') + '</div></article>').join("") : '<div class="empty">No hay documentos cargados en el servidor.</div>';
      const proxyRows = proxys.length ? proxys.map(row => '<article class="reportRow"><div><h3>' + html(row.propietario || "Proxy") + '</h3><div class="line"><strong>Representante:</strong> ' + html(row.representante || "") + '</div><div class="muted">' + html(row.fecha_importacion || "") + ' | ' + html(row.nombre_archivo || "") + '</div></div><span class="pill">' + html(row.estado || "Importado") + '</span></article>').join("") : '<div class="empty">No hay proxys importados.</div>';
      return '<div class="assemblySplit"><div class="assemblyPane"><h3>Anadir documentos</h3><label>Carpeta</label><input id="assemblyDocumentFolder" value="General" /><label>Descripcion</label><input id="assemblyDocumentDescription" /><label>Archivos</label><input id="assemblyDocumentFiles" type="file" multiple /><div class="toolbar"><button class="green" id="uploadAssemblyDocuments">Subir seleccionados</button><span class="muted" id="assemblyDocumentMessage"></span></div><h3 style="margin-top:16px">Documentos</h3><div class="reportList">' + documentRows + '</div></div><div class="assemblyPane"><h3>Proxys recibidos (' + proxys.length + ')</h3><p class="muted">Las instrucciones de voto importadas permanecen bloqueadas durante la votacion.</p><div class="reportList">' + proxyRows + '</div></div></div>';
    }

    function assemblyHistoryHtml(detail) {
      const rows = detail.updates || [];
      const content = rows.length ? rows.map(row => '<article class="historyItem"><h4>' + html(row.fecha_hora) + ' - ' + html(row.tipo) + '</h4><p>' + html(row.comentario) + '</p><div class="muted">' + html(row.usuario || "") + '</div></article>').join("") : '<div class="empty">No hay actualizaciones.</div>';
      return (canWrite() ? '<div class="assemblyPane"><h3>Anadir seguimiento de asamblea</h3><div class="formGrid"><div><label>Tipo</label><input id="assemblyUpdateType" value="Seguimiento" /></div></div><label>Comentario</label><textarea id="assemblyUpdateComment"></textarea><div class="toolbar"><button class="green" id="saveAssemblyUpdate">Guardar seguimiento</button><span class="muted" id="assemblyUpdateMessage"></span></div></div>' : '') + '<div class="history">' + content + '</div>';
    }

    function assemblyMinutesHtml(detail) {
      const item = detail.assembly || {};
      const minutes = assemblyMinutes || {};
      const draftMap = new Map((minutes.puntos || []).map(row => [Number(row.id_punto), row]));
      const checks = [
        [Boolean(item.fecha), "Fecha", item.fecha || "Pendiente"],
        [Boolean(item.lugar_celebracion || item.ubicacion), "Lugar", item.lugar_celebracion || item.ubicacion || "Pendiente"],
        [Boolean(item.hora_inicio), "Hora de inicio", item.hora_inicio || "Pendiente"],
        [Boolean(item.presidente), "Presidente", item.presidente || "Pendiente"],
        [Boolean(minutes.secretario || item.administrador), "Secretario / Administrador", minutes.secretario || item.administrador || "Pendiente"],
        [Boolean(minutes.hora_cierre), "Hora de cierre", minutes.hora_cierre || "Pendiente"],
        [(detail.attendance || []).length > 0, "Asistencia", (detail.attendance || []).length + " registros"],
        [(detail.points || []).length > 0, "Orden del dia", (detail.points || []).length + " puntos"],
      ];
      const readiness = checks.map(row => '<div class="minutesCheck ' + (row[0] ? "ok" : "warn") + '"><strong>' + (row[0] ? "OK" : "Falta") + '</strong><div><strong>' + html(row[1]) + '</strong><span>' + html(row[2]) + '</span></div></div>').join("");
      const warnings = (minutes.advertencias || []).length ? '<div class="assemblyPane"><h3>Observaciones del borrador</h3><ul class="minutesWarningList">' + minutes.advertencias.map(value => '<li>' + html(value) + '</li>').join("") + '</ul></div>' : '';
      const qualifiedMajorities = (detail.points || []).filter(point => !["", "simple"].includes(safe(point.tipo_mayoria).toLowerCase()));
      const majorityNotice = qualifiedMajorities.length ? '<div class="assemblyPane"><h3>Control de mayorias cualificadas</h3><p class="answerNote">Antes de cerrar el acta, revisa la base legal y el posible computo de propietarios ausentes en: ' + qualifiedMajorities.map((point,index) => "P" + ((detail.points || []).indexOf(point)+1) + " (" + point.tipo_mayoria + ")").join(", ") + '.</p></div>' : '';
      const states = ["Borrador","Revisada","Cerrada"].map(value => '<option' + (value === (minutes.estado || "Borrador") ? " selected" : "") + '>' + value + '</option>').join("");
      const points = (detail.points || []).map((point,index) => {
        const draft = draftMap.get(Number(point.id_punto)) || {};
        const result = point.result || {};
        const locked = result.base_votes ? (result.approved ? "APROBADO" : "NO APROBADO") + " | " + (result.si?.votes || 0) + " a favor, " + (result.no?.votes || 0) + " en contra, " + (result.abs?.votes || 0) + " abstenciones" : "SIN VOTACION REGISTRADA";
        return '<article class="minutesPoint" data-minutes-point="' + point.id_punto + '"><div class="minutesPointHead"><div><h3>P' + (index+1) + '. ' + html(point.titulo) + '</h3><div class="muted">Mayoria configurada: ' + html(point.tipo_mayoria || "simple") + '</div></div><span class="pill ' + (result.approved ? "state-Finalizado" : "state-Pendiente") + '">' + html(resultLabel(result)) + '</span></div><div class="minutesLocked">Resultado bloqueado desde el registro: ' + html(locked) + '</div><div class="minutesLanguages"><div><label>Exposicion y debate (ES)</label><textarea data-minutes-field="debate_es">' + html(draft.debate_es || "") + '</textarea><label>Acuerdo (ES)</label><textarea data-minutes-field="acuerdo_es">' + html(draft.acuerdo_es || "") + '</textarea></div><div><label>Discussion (EN)</label><textarea data-minutes-field="debate_en">' + html(draft.debate_en || "") + '</textarea><label>Resolution (EN)</label><textarea data-minutes-field="acuerdo_en">' + html(draft.acuerdo_en || "") + '</textarea></div></div></article>';
      }).join("");
      return '<div class="minutesLayout"><div class="assemblyPane"><div class="contentHead"><div><h3>Control previo del acta</h3><p class="muted">Datos que formaran parte del documento.</p></div><span class="pill ' + ((minutes.estado || "Borrador") === "Cerrada" ? "state-Finalizado" : "state-Pendiente") + '">' + html(minutes.estado || "Borrador") + '</span></div><div class="minutesReadiness">' + readiness + '</div></div>' +
        '<div class="minutesSourceGrid"><div class="assemblyPane"><h3>Transcripcion de la sesion</h3><input id="minutesTranscriptFile" type="file" accept=".txt,.md,text/plain" /><textarea id="minutesTranscript" class="minutesTranscript" placeholder="Pega aqui la transcripcion completa">' + html(minutes.transcripcion || "") + '</textarea><div class="muted" id="minutesTranscriptName">' + html(minutes.fuente_transcripcion || "") + '</div></div><div class="assemblyPane"><h3>Datos de cierre</h3><label>Estado del acta</label><select id="minutesState">' + states + '</select><label>Convocante</label><input id="minutesConvener" value="' + html(minutes.convocante || item.presidente || "") + '" /><label>Secretario / Administrador</label><input id="minutesSecretary" value="' + html(minutes.secretario || item.administrador || "") + '" /><label>Hora de cierre</label><input id="minutesClosingTime" type="time" value="' + html(minutes.hora_cierre || "") + '" /><div class="toolbar"><button class="green" id="saveAssemblyMinutes">Guardar borrador</button><span class="muted" id="minutesMessage"></span></div></div></div>' +
        '<details class="assemblyPane" open><summary><strong>Apertura y cierre bilingues</strong></summary><div class="minutesLanguages" style="margin-top:10px"><div><label>Introduccion (ES)</label><textarea id="minutesIntroEs">' + html(minutes.introduccion_es || "") + '</textarea><label>Cierre (ES)</label><textarea id="minutesCloseEs">' + html(minutes.cierre_es || "") + '</textarea></div><div><label>Introduction (EN)</label><textarea id="minutesIntroEn">' + html(minutes.introduccion_en || "") + '</textarea><label>Closing (EN)</label><textarea id="minutesCloseEn">' + html(minutes.cierre_en || "") + '</textarea></div></div></details>' + majorityNotice + warnings +
        '<div class="minutesLayout">' + (points || '<div class="empty">No hay puntos configurados.</div>') + '</div>' +
        '<div class="assemblyPane"><div class="toolbar"><button class="green" id="generateAssemblyMinutes">Preparar borrador con IA</button><button id="saveAssemblyMinutesBottom">Guardar cambios</button><button class="ghost" id="exportAssemblyMinutes">Exportar Word</button><span class="muted" id="minutesBottomMessage"></span></div></div></div>';
    }

    function assemblyDetailHtml(detail) {
      const item = detail.assembly || {};
      const content = assemblySection === "registration" ? assemblyRegistrationHtml(detail) : assemblySection === "voting" ? assemblyVotingHtml(detail) : assemblySection === "documents" ? assemblyDocumentsHtml(detail) : assemblySection === "minutes" ? assemblyMinutesHtml(detail) : assemblySection === "history" ? assemblyHistoryHtml(detail) : assemblySection === "configuration" ? assemblyEditHtml(detail) : assemblySummaryHtml(detail);
      return '<div class="assemblyShell"><div class="assemblyHeader"><div><div class="meta"><span class="pill ' + assemblyStatusClass(item.estado) + '">' + html(item.estado) + '</span><span class="pill">' + html(item.comunidad) + '</span></div><h2>' + html(item.nombre) + '</h2><p>' + html([item.fecha,item.hora_inicio,item.lugar_celebracion || item.ubicacion].filter(Boolean).join(" | ")) + '</p></div><div class="toolbar"><button class="ghost" id="backAssemblies">Volver</button>' + (canWrite() ? '<button class="green" id="assemblyEditShortcut">Editar</button><button id="assemblyWebHtmlExport">Generar HTML web</button>' : '') + '<button id="reloadAssembly">Actualizar</button></div></div>' + assemblyTabsHtml() + '<div id="assemblySectionContent">' + content + '</div></div>';
    }

    function assembliesPanelHtml() {
      if (!assembliesData.loaded) return '<div class="empty">Cargando asambleas...</div>';
      if (!selectedAssemblyId) return assemblyListHtml();
      if (!assemblyDetail) return '<div class="empty">Cargando ficha de asamblea...</div>';
      return assemblyDetailHtml(assemblyDetail);
    }

    async function assemblyApi(action, data) {
      return api("/api/assembly/action", { method:"POST", body:JSON.stringify({ action, data }) });
    }

    async function loadAssemblies() {
      try {
        assembliesData = { ...(await api("/api/assemblies")), loaded:true };
        $("assemblyTabCount").textContent = assembliesData.assemblies.length;
        if (currentView === "assemblies") render();
      } catch (error) { assembliesData = { assemblies:[], loaded:true, error:error.message }; if (currentView === "assemblies") { render(); alert(error.message); } }
    }

    async function loadAssemblyDetail(id = selectedAssemblyId) {
      selectedAssemblyId = Number(id || 0);
      assemblyDetail = null;
      assemblyMinutes = null;
      render();
      try {
        const [detail, minutesResponse] = await Promise.all([
          api("/api/assembly/detail?id=" + encodeURIComponent(selectedAssemblyId)),
          api("/api/assembly/minutes?id=" + encodeURIComponent(selectedAssemblyId)),
        ]);
        assemblyDetail = detail;
        assemblyMinutes = minutesResponse.minutes || {};
        if (!selectedAssemblyPoint && assemblyDetail.points?.length) selectedAssemblyPoint = Number(assemblyDetail.points[0].id_punto);
        render();
      } catch (error) { selectedAssemblyId = 0; render(); alert(error.message); }
    }

    function collectPointEditors() {
      return [...document.querySelectorAll("[data-point-index]")].map(row => ({ id_punto:Number(row.dataset.pointId || 0) || null, titulo:row.querySelector("[data-point-title]").value, tipo_mayoria:row.querySelector("[data-point-majority]").value }));
    }

    function bindAssembliesPanel() {
      document.querySelectorAll("[data-assembly-open]").forEach(card => card.addEventListener("click", () => { assemblySection="summary"; selectedAssemblyPoint=0; loadAssemblyDetail(card.dataset.assemblyOpen); }));
      if ($("createAssemblyButton")) $("createAssemblyButton").addEventListener("click", createAssemblyFromForm);
      if (!selectedAssemblyId || !assemblyDetail) return;
      $("backAssemblies").addEventListener("click", () => { selectedAssemblyId=0; assemblyDetail=null; assemblyMinutes=null; assemblySection="summary"; render(); });
      $("reloadAssembly").addEventListener("click", () => loadAssemblyDetail());
      if ($("assemblyEditShortcut")) $("assemblyEditShortcut").addEventListener("click", () => { assemblySection="configuration"; render(); });
      if ($("assemblyWebHtmlExport")) $("assemblyWebHtmlExport").addEventListener("click", exportAssemblyWebHtml);
      document.querySelectorAll("[data-assembly-section]").forEach(button => button.addEventListener("click", () => { assemblySection=button.dataset.assemblySection; render(); }));
      if ($("saveAssemblyEdit")) $("saveAssemblyEdit").addEventListener("click", saveAssemblyEdit);
      if ($("addAssemblyPoint")) $("addAssemblyPoint").addEventListener("click", () => { assemblyDetail.points.push({ titulo:"", tipo_mayoria:"simple" }); render(); });
      if ($("saveAssemblyPoints")) $("saveAssemblyPoints").addEventListener("click", saveAssemblyPoints);
      document.querySelectorAll("[data-point-move]").forEach(button => button.addEventListener("click", () => moveAssemblyPoint(button)));
      document.querySelectorAll("[data-point-remove]").forEach(button => button.addEventListener("click", () => { const points=collectPointEditors(); points.splice(Number(button.closest("[data-point-index]").dataset.pointIndex),1); assemblyDetail.points=points; render(); }));
      if ($("assemblyOwnerSearch")) { $("assemblyOwnerSearch").addEventListener("change", event => { assemblyOwnerQuery=event.target.value; render(); }); $("assemblyOwnerSearch").addEventListener("keydown", event => { if(event.key==="Enter"){assemblyOwnerQuery=event.target.value;render();} }); }
      if ($("saveAssemblyAttendance")) $("saveAssemblyAttendance").addEventListener("click", saveAssemblyAttendance);
      document.querySelectorAll("[data-attendance-remove]").forEach(button => button.addEventListener("click", () => removeAssemblyAttendance(button.dataset.attendanceRemove)));
      document.querySelectorAll("[data-attendance-moroso]").forEach(button => button.addEventListener("click", () => toggleAssemblyMoroso(button.dataset.attendanceMoroso, button.dataset.moroso === "1")));
      if ($("assemblyVotePoint")) $("assemblyVotePoint").addEventListener("change", event => { selectedAssemblyPoint=Number(event.target.value); render(); });
      document.querySelectorAll("[data-vote-owner]").forEach(button => button.addEventListener("click", () => saveAssemblyVote(button.dataset.voteOwner,button.dataset.vote)));
      document.querySelectorAll("[data-vote-group]").forEach(button => button.addEventListener("click", () => saveAssemblyGroupVote(button.dataset.voteGroup,button.dataset.vote)));
      if ($("uploadAssemblyDocuments")) $("uploadAssemblyDocuments").addEventListener("click", uploadAssemblyDocuments);
      document.querySelectorAll("[data-assembly-document-open]").forEach(button => button.addEventListener("click", () => window.open("/api/assembly/document?id=" + encodeURIComponent(button.dataset.assemblyDocumentOpen) + "&inline=1","_blank")));
      document.querySelectorAll("[data-assembly-document-delete]").forEach(button => button.addEventListener("click", () => deleteAssemblyDocument(button.dataset.assemblyDocumentDelete)));
      if ($("saveAssemblyUpdate")) $("saveAssemblyUpdate").addEventListener("click", saveAssemblyUpdate);
      if ($("minutesTranscriptFile")) $("minutesTranscriptFile").addEventListener("change", loadMinutesTranscriptFile);
      if ($("saveAssemblyMinutes")) $("saveAssemblyMinutes").addEventListener("click", () => saveAssemblyMinutes(false));
      if ($("saveAssemblyMinutesBottom")) $("saveAssemblyMinutesBottom").addEventListener("click", () => saveAssemblyMinutes(false));
      if ($("generateAssemblyMinutes")) $("generateAssemblyMinutes").addEventListener("click", generateAssemblyMinutes);
      if ($("exportAssemblyMinutes")) $("exportAssemblyMinutes").addEventListener("click", exportAssemblyMinutes);
    }

    async function createAssemblyFromForm() {
      $("createAssemblyMessage").textContent="Creando...";
      try { const result=await assemblyApi("create",{id_comunidad:$("newAssemblyCommunity").value,codigo:$("newAssemblyCode").value,nombre:$("newAssemblyName").value,fecha:$("newAssemblyDate").value,convocatoria:$("newAssemblyCall").value,estado:$("newAssemblyState").value}); await loadAssemblies(); await loadAssemblyDetail(result.id); }
      catch(error){$("createAssemblyMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>';}
    }

    async function saveAssemblyEdit() {
      const data={id:selectedAssemblyId,id_comunidad:$("assemblyEditCommunity").value,codigo:$("assemblyEditCode").value,nombre:$("assemblyEditName").value,fecha:$("assemblyEditDate").value,convocatoria:$("assemblyEditCall").value,estado:$("assemblyEditState").value,presidente:$("assemblyEditPresident").value,administrador:$("assemblyEditAdministrator").value,junta_directiva:$("assemblyEditBoard").value,hora_inicio:$("assemblyEditTime").value,lugar_celebracion:$("assemblyEditPlace").value,observaciones:$("assemblyEditNotes").value};
      try{$("assemblyEditMessage").textContent="Guardando...";await assemblyApi("update",data);await loadAssemblies();await loadAssemblyDetail();}catch(error){$("assemblyEditMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>';}
    }

    function moveAssemblyPoint(button) { const points=collectPointEditors(); const index=Number(button.closest("[data-point-index]").dataset.pointIndex); const target=button.dataset.pointMove==="up"?index-1:index+1; if(target<0||target>=points.length)return; [points[index],points[target]]=[points[target],points[index]]; assemblyDetail.points=points; render(); }
    async function saveAssemblyPoints(){try{$("assemblyPointsMessage").textContent="Guardando...";await assemblyApi("save_points",{id:selectedAssemblyId,points:collectPointEditors()});selectedAssemblyPoint=0;await loadAssemblyDetail();}catch(error){$("assemblyPointsMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>';}}

    async function saveAssemblyAttendance(){const owners=[...document.querySelectorAll("[data-owner-select]:checked")].map(row=>row.dataset.ownerSelect);if(!owners.length){$("attendanceMessage").textContent="Selecciona propietarios.";return;}try{$("attendanceMessage").textContent="Registrando...";await assemblyApi(owners.length>1?"attendance_batch":"attendance_set",{id:selectedAssemblyId,propietarios:owners,propietario:owners[0],tipo:$("attendanceType").value,representante:$("attendanceRepresentative").value,sin_voto:$("attendanceWithoutVote").checked});assemblyOwnerQuery="";await loadAssemblyDetail();}catch(error){$("attendanceMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>';}}
    async function removeAssemblyAttendance(owner){if(!confirm("Quitar del registro a "+owner+"?"))return;try{await assemblyApi("attendance_remove",{id:selectedAssemblyId,propietario:owner});await loadAssemblyDetail();}catch(error){alert(error.message);}}
    async function toggleAssemblyMoroso(owner,moroso){const reason=prompt(moroso?"Motivo para dejarlo sin derecho a voto:":"Motivo para devolverle el derecho a voto:");if(!safe(reason))return;try{await assemblyApi("moroso_set",{id:selectedAssemblyId,propietario:owner,moroso,motivo:reason});await loadAssemblyDetail();}catch(error){alert(error.message);}}
    async function saveAssemblyVote(owner,vote){try{$("assemblyVoteMessage").textContent="Guardando voto...";const result=await assemblyApi("vote_set",{id:selectedAssemblyId,id_punto:selectedAssemblyPoint,propietario:owner,voto:vote});if(result.locked)alert("El voto tiene instruccion de proxy y permanece bloqueado.");await loadAssemblyDetail();}catch(error){alert(error.message);}}
    async function saveAssemblyGroupVote(representative,vote){try{$("assemblyVoteMessage").textContent="Aplicando al grupo...";const result=await assemblyApi("vote_bulk",{id:selectedAssemblyId,id_punto:selectedAssemblyPoint,representante,voto:vote});await loadAssemblyDetail();if(result.locked)alert(result.locked+" voto(s) con instruccion de proxy no se han modificado.");}catch(error){alert(error.message);}}

    async function uploadAssemblyDocuments(){const files=[...($("assemblyDocumentFiles").files||[])];if(!files.length){$("assemblyDocumentMessage").textContent="Selecciona archivos.";return;}$("assemblyDocumentMessage").textContent="Subiendo 0 de "+files.length+"...";try{for(let index=0;index<files.length;index++){const query=new URLSearchParams({id:selectedAssemblyId,folder:$("assemblyDocumentFolder").value||"General",description:$("assemblyDocumentDescription").value||""});const response=await fetch("/api/assembly/document/upload?"+query.toString(),{method:"POST",body:files[index],credentials:"same-origin",headers:{"x-file-name":encodeURIComponent(files[index].name)}});const body=await response.json();if(!response.ok)throw new Error(body.error||"Error subiendo archivo.");$("assemblyDocumentMessage").textContent="Subiendo "+(index+1)+" de "+files.length+"...";}await loadAssemblyDetail();}catch(error){$("assemblyDocumentMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>';}}
    async function deleteAssemblyDocument(id){if(!confirm("Eliminar este documento de la asamblea?"))return;try{await api("/api/assembly/document/delete",{method:"POST",body:JSON.stringify({id})});await loadAssemblyDetail();}catch(error){alert(error.message);}}
    async function saveAssemblyUpdate(){try{$("assemblyUpdateMessage").textContent="Guardando...";await assemblyApi("add_update",{id:selectedAssemblyId,tipo:$("assemblyUpdateType").value,comentario:$("assemblyUpdateComment").value});await loadAssemblyDetail();}catch(error){$("assemblyUpdateMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>';}}

    function collectAssemblyMinutes() {
      const points = [...document.querySelectorAll("[data-minutes-point]")].map(row => {
        const value = (field) => row.querySelector('[data-minutes-field="' + field + '"]').value;
        return { id_punto:Number(row.dataset.minutesPoint), debate_es:value("debate_es"), acuerdo_es:value("acuerdo_es"), debate_en:value("debate_en"), acuerdo_en:value("acuerdo_en") };
      });
      return {
        id:selectedAssemblyId, estado:$("minutesState").value, transcripcion:$("minutesTranscript").value,
        fuente_transcripcion:safe($("minutesTranscriptName").textContent), convocante:$("minutesConvener").value,
        secretario:$("minutesSecretary").value, hora_cierre:$("minutesClosingTime").value,
        introduccion_es:$("minutesIntroEs").value, introduccion_en:$("minutesIntroEn").value,
        cierre_es:$("minutesCloseEs").value, cierre_en:$("minutesCloseEn").value,
        puntos, advertencias:assemblyMinutes?.advertencias || [], generado_ia:Boolean(assemblyMinutes?.generado_ia),
      };
    }

    async function loadMinutesTranscriptFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!/\.(txt|md)$/i.test(file.name)) { alert("Selecciona una transcripcion TXT o Markdown."); return; }
      const text = await file.text();
      $("minutesTranscript").value = text;
      $("minutesTranscriptName").textContent = file.name;
    }

    async function saveAssemblyMinutes(quiet = false) {
      const message = $("minutesMessage") || $("minutesBottomMessage");
      try {
        if (message && !quiet) message.textContent = "Guardando...";
        const result = await api("/api/assembly/minutes/save", { method:"POST", body:JSON.stringify(collectAssemblyMinutes()) });
        assemblyMinutes = result.minutes || {};
        if (!quiet) render();
        return true;
      } catch (error) {
        if (message) message.innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
        return false;
      }
    }

    async function generateAssemblyMinutes() {
      const payload = collectAssemblyMinutes();
      if (safe(payload.transcripcion).length < 80) { alert("Incluye primero la transcripcion de la sesion."); return; }
      if (!confirm("Se enviaran al proveedor de IA la transcripcion, los datos generales y los titulos de los puntos. Los nombres de asistentes, votos y coeficientes no se enviaran. Continuar?")) return;
      const message = $("minutesBottomMessage") || $("minutesMessage");
      try {
        message.textContent = "Preparando el borrador bilingue...";
        const result = await api("/api/assembly/minutes/generate", { method:"POST", body:JSON.stringify(payload) });
        assemblyMinutes = result.minutes || {};
        render();
      } catch (error) { message.innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    async function exportAssemblyMinutes() {
      const saved = await saveAssemblyMinutes(true);
      if (!saved) return;
      window.location.href = "/api/assembly/minutes/export?id=" + encodeURIComponent(selectedAssemblyId);
    }

    async function exportAssemblyWebHtml() {
      try {
        const response = await fetch("/api/assembly/web-html/export?id=" + encodeURIComponent(selectedAssemblyId), { credentials:"same-origin" });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "No se pudo generar el HTML web.");
        }
        const blob = await response.blob();
        const disposition = response.headers.get("content-disposition") || "";
        const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        const filename = match ? decodeURIComponent(match[1]) : "html_proxy_asamblea.txt";
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        alert(error.message);
      }
    }

    async function adminApi(action, data = {}) {
      return api("/api/admin/action", { method:"POST", body:JSON.stringify({ action, data }) });
    }

    async function loadAdmin() {
      try {
        adminData = { ...(await api("/api/admin")), loaded:true };
        if (currentView === "admin") render();
      } catch (error) {
        adminData = { users:[], communities:[], roles:[], loaded:true, error:error.message };
        if (currentView === "admin") { render(); alert(error.message); }
      }
    }

    function adminUserRow(user) {
      const communities = (user.community_ids || []).map(id => adminData.communities.find(row => Number(row.id_comunidad) === Number(id))?.nombre).filter(Boolean);
      const selected = Number(user.id_usuario) === Number(selectedAdminUserId);
      const actions = selected ? '<div class="adminInlineActions"><button class="ghost" data-admin-user-edit="' + user.id_usuario + '">Editar usuario</button><button data-admin-user-quick-reset="' + user.id_usuario + '">Generar nueva clave temporal</button></div>' : '';
      return '<div class="adminUserListItem"><button class="adminRow ' + (selected ? "selected " : "") + (user.activo ? "" : "inactive") + '" data-admin-user="' + user.id_usuario + '"><div><strong>' + html(user.nombre) + '</strong> <span class="pill">' + html(user.rol) + '</span></div><div class="muted">' + html(communities.length ? communities.join(", ") : (user.rol === "Superusuario" ? "Todas las comunidades" : "Sin comunidades asignadas")) + '</div><div class="meta"><span>' + html(user.password_status) + '</span>' + (user.bloqueado ? '<span class="dangerText">Bloqueado</span>' : '') + (user.activo ? '' : '<span>Inactivo</span>') + '</div></button>' + actions + '</div>';
    }

    function adminCommunityRow(community) {
      return '<button class="adminRow ' + (Number(community.id_comunidad) === Number(selectedAdminCommunityId) ? "selected " : "") + (community.activo ? "" : "inactive") + '" data-admin-community="' + community.id_comunidad + '"><div><strong>' + html(community.nombre) + '</strong>' + (community.activo ? '' : ' <span class="pill">Inactiva</span>') + '</div><div class="muted">' + html(community.descripcion || "Sin descripcion") + '</div><div class="meta"><span>' + html(String(community.total_usuarios || 0)) + ' usuarios</span><span>' + html(String(community.total_proyectos || 0)) + ' proyectos</span><span>' + html(String(community.total_tareas || 0)) + ' tareas</span></div></button>';
    }

    function temporaryKeyHtml() {
      if (!lastTemporaryKey) return "";
      return '<div class="temporaryKey"><strong>Clave temporal de primer acceso para ' + html(lastTemporaryKey.nombre) + '</strong><code>' + html(lastTemporaryKey.key) + '</code><div>Esta clave solo se muestra ahora. El usuario debera crear su contrasena definitiva al acceder.</div><div class="toolbar"><button class="green" id="copyTemporaryKey">Copiar clave</button><button class="ghost" id="hideTemporaryKey">Ocultar</button><span class="muted" id="temporaryKeyMessage"></span></div></div>';
    }

    function adminUserEditorHtml() {
      const user = adminData.users.find(row => Number(row.id_usuario) === Number(selectedAdminUserId)) || null;
      const roles = (adminData.roles || []).map(role => '<option value="' + html(role) + '"' + ((user?.rol || "Usuario") === role ? " selected" : "") + '>' + html(role) + '</option>').join("");
      const assigned = new Set((user?.community_ids || []).map(Number));
      const checks = (adminData.communities || []).map(community => '<label class="communityCheck"><input type="checkbox" data-admin-user-community="' + community.id_comunidad + '"' + (assigned.has(Number(community.id_comunidad)) ? " checked" : "") + ' /><span><strong>' + html(community.nombre) + '</strong>' + (community.activo ? '' : '<small class="dangerText" style="display:block">Inactiva</small>') + '</span></label>').join("");
      return '<div class="assemblyPane" id="adminUserEditor"><h3>' + (user ? "Editar usuario" : "Nuevo usuario") + '</h3>' + temporaryKeyHtml() + '<div class="formGrid"><div><label>Nombre</label><input id="adminUserName" value="' + html(user?.nombre || "") + '" /></div><div><label>Rol</label><select id="adminUserRole">' + roles + '</select></div></div><label><input type="checkbox" id="adminUserActive"' + (user ? (user.activo ? " checked" : "") : " checked") + ' /> Usuario activo</label><label><input type="checkbox" id="adminUserSecurity"' + (user?.gestionar_seguridad ? " checked" : "") + ' /> Gestionar Seguridad: revisar partes, ver documentos protegidos y convertir incidencias</label><h3>Comunidades asignadas</h3><div class="communityChecks">' + (checks || '<div class="empty">Crea primero una comunidad.</div>') + '</div><p class="muted">El perfil Seguridad solo carga partes. El permiso Gestionar Seguridad se reserva para Luis, Elena y usuarios autorizados expresamente.</p><div class="toolbar"><button class="green" id="saveAdminUser">Guardar usuario y asignaciones</button>' + (user ? '<button class="ghost" id="resetAdminPassword">Generar nueva clave temporal</button>' : '') + (user?.bloqueado ? '<button id="unlockAdminUser">Desbloquear</button>' : '') + '<span class="muted" id="adminUserMessage"></span></div></div>';
    }

    function adminCommunityEditorHtml() {
      const community = adminData.communities.find(row => Number(row.id_comunidad) === Number(selectedAdminCommunityId)) || null;
      return '<div class="assemblyPane"><h3>' + (community ? "Editar comunidad" : "Nueva comunidad") + '</h3><label>Nombre</label><input id="adminCommunityName" value="' + html(community?.nombre || "") + '" /><label>Descripcion</label><textarea id="adminCommunityDescription">' + html(community?.descripcion || "") + '</textarea><label><input type="checkbox" id="adminCommunityActive"' + (community ? (community.activo ? " checked" : "") : " checked") + ' /> Comunidad activa</label><p class="muted">Desactivar no elimina datos. La comunidad deja de estar disponible para el trabajo habitual.</p><div class="toolbar"><button class="green" id="saveAdminCommunity">Guardar comunidad</button><span class="muted" id="adminCommunityMessage"></span></div></div>';
    }

    function adminPanelHtml() {
      if (!adminData.loaded) return '<div class="empty">Cargando administracion...</div>';
      if (adminData.error) return '<div class="empty dangerText">' + html(adminData.error) + '</div>';
      const activeUsers = adminData.users.filter(row => row.activo).length;
      const activeCommunities = adminData.communities.filter(row => row.activo).length;
      const blocked = adminData.users.filter(row => row.bloqueado).length;
      const pendingPasswords = adminData.users.filter(row => row.requiere_cambio_password || !row.password_configurada).length;
      return '<div class="assemblyShell"><div class="adminMetrics">' + countCard("Usuarios activos", String(activeUsers)) + countCard("Comunidades activas", String(activeCommunities)) + countCard("Accesos bloqueados", String(blocked)) + countCard("Primer acceso pendiente", String(pendingPasswords)) + '</div><div class="adminLayout"><div class="assemblyPane"><div class="contentHead"><div><h3>Usuarios</h3><p class="muted">Roles, acceso y comunidades.</p></div><button class="green" id="newAdminUser">Nuevo</button></div><div class="adminList">' + (adminData.users.map(adminUserRow).join("") || '<div class="empty">No hay usuarios.</div>') + '</div></div>' + adminUserEditorHtml() + '</div><div class="adminLayout"><div class="assemblyPane"><div class="contentHead"><div><h3>Comunidades</h3><p class="muted">Alta, descripcion y estado.</p></div><button class="green" id="newAdminCommunity">Nueva</button></div><div class="adminList">' + (adminData.communities.map(adminCommunityRow).join("") || '<div class="empty">No hay comunidades.</div>') + '</div></div>' + adminCommunityEditorHtml() + '</div></div>';
    }

    function bindAdminPanel() {
      if (!adminData.loaded || adminData.error) return;
      document.querySelectorAll("[data-admin-user]").forEach(button => button.addEventListener("click", () => { selectedAdminUserId=Number(button.dataset.adminUser); lastTemporaryKey=null; render(); }));
      document.querySelectorAll("[data-admin-user-edit]").forEach(button => button.addEventListener("click", () => document.querySelector("#adminUserEditor")?.scrollIntoView({ behavior:"smooth", block:"start" })));
      document.querySelectorAll("[data-admin-user-quick-reset]").forEach(button => button.addEventListener("click", () => { selectedAdminUserId=Number(button.dataset.adminUserQuickReset); resetAdminPassword(); }));
      document.querySelectorAll("[data-admin-community]").forEach(button => button.addEventListener("click", () => { selectedAdminCommunityId=Number(button.dataset.adminCommunity); render(); }));
      $("newAdminUser").addEventListener("click", () => { selectedAdminUserId=0; lastTemporaryKey=null; render(); });
      $("newAdminCommunity").addEventListener("click", () => { selectedAdminCommunityId=0; render(); });
      $("saveAdminUser").addEventListener("click", saveAdminUser);
      $("saveAdminCommunity").addEventListener("click", saveAdminCommunity);
      if ($("resetAdminPassword")) $("resetAdminPassword").addEventListener("click", resetAdminPassword);
      if ($("unlockAdminUser")) $("unlockAdminUser").addEventListener("click", unlockAdminUser);
      if ($("copyTemporaryKey")) $("copyTemporaryKey").addEventListener("click", async () => { try { await navigator.clipboard.writeText(lastTemporaryKey.key); $("temporaryKeyMessage").textContent="Copiada."; } catch { $("temporaryKeyMessage").textContent="No se pudo copiar automaticamente."; } });
      if ($("hideTemporaryKey")) $("hideTemporaryKey").addEventListener("click", () => { lastTemporaryKey=null; render(); });
    }

    async function saveAdminUser() {
      const communityIds = [...document.querySelectorAll("[data-admin-user-community]:checked")].map(row => Number(row.dataset.adminUserCommunity));
      const data = { id_usuario:selectedAdminUserId || null, nombre:$("adminUserName").value, rol:$("adminUserRole").value, activo:$("adminUserActive").checked, gestionar_seguridad:$("adminUserSecurity").checked, community_ids:communityIds };
      if (!safe(data.nombre)) { $("adminUserMessage").textContent="El nombre es obligatorio."; return; }
      if (!confirm((selectedAdminUserId ? "Guardar los cambios del usuario" : "Crear el nuevo usuario") + "?")) return;
      try {
        $("adminUserMessage").textContent="Guardando...";
        const result = await adminApi("save_user", data);
        selectedAdminUserId = Number(result.id_usuario);
        lastTemporaryKey = result.temporary_key ? { nombre:data.nombre, key:result.temporary_key } : null;
        await loadAdmin();
      } catch (error) { $("adminUserMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>'; }
    }

    async function saveAdminCommunity() {
      const data = { id_comunidad:selectedAdminCommunityId || null, nombre:$("adminCommunityName").value, descripcion:$("adminCommunityDescription").value, activo:$("adminCommunityActive").checked };
      if (!safe(data.nombre)) { $("adminCommunityMessage").textContent="El nombre es obligatorio."; return; }
      if (!confirm((selectedAdminCommunityId ? "Guardar los cambios de la comunidad" : "Crear la nueva comunidad") + "?")) return;
      try {
        $("adminCommunityMessage").textContent="Guardando...";
        const result = await adminApi("save_community", data);
        selectedAdminCommunityId = Number(result.id_comunidad);
        await loadAdmin();
        await loadOverview();
        currentView="admin";
        render();
      } catch (error) { $("adminCommunityMessage").innerHTML='<span class="dangerText">'+html(error.message)+'</span>'; }
    }

    async function resetAdminPassword() {
      const user = adminData.users.find(row => Number(row.id_usuario) === Number(selectedAdminUserId));
      if (!user || !confirm("Se invalidara la contrasena actual de " + user.nombre + " y se generara una clave temporal nueva. Continuar?")) return;
      try {
        const result = await adminApi("reset_password", { id_usuario:selectedAdminUserId });
        lastTemporaryKey = { nombre:result.nombre, key:result.temporary_key };
        await loadAdmin();
      } catch (error) { alert(error.message); }
    }

    async function unlockAdminUser() {
      try { await adminApi("unlock_user", { id_usuario:selectedAdminUserId }); await loadAdmin(); }
      catch (error) { alert(error.message); }
    }

    function importCommunityOptions() {
      const communities = (state.daily || {}).communities || [];
      return communities.map(row => {
        const id = row.id || row.id_comunidad;
        return '<option value="' + html(id) + '"' + (String(id) === String(importCommunity || "") ? " selected" : "") + '>' + html(row.nombre) + '</option>';
      }).join("");
    }

    function importActionOptions(selected) {
      const rows = [
        ["seguimiento_proyecto", "Actualizar proyecto"], ["seguimiento_tarea", "Actualizar tarea"],
        ["crear_proyecto", "Crear proyecto"], ["crear_tarea", "Crear tarea"], ["descartar", "Descartar"]
      ];
      return rows.map(row => '<option value="' + row[0] + '"' + (row[0] === selected ? " selected" : "") + '>' + row[1] + '</option>').join("");
    }

    function importProposalEntityOptions(action, selectedId) {
      const task = action.includes("tarea");
      const rows = task ? state.tareas : state.proyectos;
      return '<option value="">Seleccionar...</option>' + rows.map(row => {
        const id = task ? row.id_tarea : row.id_proyecto;
        const title = task ? row.titulo : row.nombre;
        return '<option value="' + html(id) + '"' + (String(id) === String(selectedId || "") ? " selected" : "") + '>' + html(id + " - " + title) + '</option>';
      }).join("");
    }

    function importStateOptions(action, selected) {
      const task = action.includes("tarea");
      const values = task ? (options.estados_tarea || ["Pendiente", "En curso", "Pendiente de tercero", "Bloqueada", "Terminada", "Archivada"]) : (options.estados_proyecto || ["Pendiente", "En curso", "Pendiente de tercero", "Bloqueado", "Finalizado", "Archivado"]);
      return values.map(value => '<option value="' + html(value) + '"' + (value === selected ? " selected" : "") + '>' + html(value) + '</option>').join("");
    }

    function historicalRowsHtml(proposal, index) {
      if (!proposal.historical) return "";
      const rows = proposal.records || [];
      return '<details open><summary><strong>Seguimientos historicos (' + rows.length + ')</strong></summary><div class="historicalRows">' + rows.map((row, recordIndex) =>
        '<div class="historicalRow" data-import-record="' + recordIndex + '">' +
          '<div><label>Fecha</label><input type="date" data-field="fecha" value="' + html(row.fecha || "") + '" /></div>' +
          '<div><label>Tipo</label><input data-field="tipo_registro" value="' + html(row.tipo_registro || "Seguimiento") + '" /></div>' +
          '<div><label>Actuacion</label><textarea data-field="comentario">' + html(row.comentario || "") + '</textarea></div>' +
          '<div><label>Proximo paso</label><textarea data-field="proximo_paso">' + html(row.proximo_paso || "") + '</textarea></div>' +
        '</div>'
      ).join("") + '</div></details>';
    }

    function importProposalHtml(proposal, index) {
      const payload = proposal.payload || {};
      const action = proposal.action || "descartar";
      const selectedId = proposal.entity?.id || proposal.entity_id || "";
      const createTask = action === "crear_tarea";
      return '<article class="importProposal' + (proposal.selected === false ? " disabled" : "") + '" data-import-index="' + index + '">' +
        '<div class="importProposalHead"><div><h3>Propuesta ' + (index + 1) + ': ' + html(payload.titulo || proposal.entity?.title || "Sin titulo") + '</h3><span class="muted">Confianza ' + Math.round((proposal.confidence || 0) * 100) + '%</span></div>' +
        '<label><input type="checkbox" data-field="selected"' + (proposal.selected === false ? "" : " checked") + ' /> Incluir</label></div>' +
        '<div class="importProposalGrid">' +
          '<div><label>Accion</label><select data-field="action">' + importActionOptions(action) + '</select></div>' +
          '<div><label>Elemento existente</label><select data-field="entity_id"' + (action.startsWith("seguimiento") ? "" : " disabled") + '>' + importProposalEntityOptions(action, selectedId) + '</select></div>' +
          '<div><label>Titulo</label><input data-field="titulo" value="' + html(payload.titulo || "") + '" /></div>' +
          '<div><label>Categoria</label><input data-field="categoria" value="' + html(payload.categoria || "Otro") + '" /></div>' +
          '<div><label>Estado</label><select data-field="estado_nuevo">' + importStateOptions(action, payload.estado_nuevo) + '</select></div>' +
          '<div><label>Prioridad</label><select data-field="prioridad_nueva">' + (options.prioridades || ["Baja", "Media", "Alta", "Urgente"]).map(value => '<option value="' + html(value) + '"' + (value === payload.prioridad_nueva ? " selected" : "") + '>' + html(value) + '</option>').join("") + '</select></div>' +
          '<div><label>Responsable actual</label><input data-field="responsable_nuevo" list="responsiblesList" value="' + html(payload.responsable_nuevo || "") + '" /></div>' +
          '<div><label>Proximo responsable</label><input data-field="responsable_proximo_paso" list="responsiblesList" value="' + html(payload.responsable_proximo_paso || "") + '" /></div>' +
          '<div><label>Fecha objetivo</label><input data-field="fecha_objetivo_proximo_paso" type="date" value="' + html((payload.fecha_objetivo_proximo_paso || "").slice(0, 10)) + '" /></div>' +
          '<div' + (createTask ? "" : ' class="hidden"') + '><label>Proyecto contenedor</label><select data-field="id_proyecto">' + projectContainerOptions(payload.id_proyecto) + '</select></div>' +
        '</div>' +
        '<label>Comentario que se guardara</label><textarea data-field="comentario">' + html(payload.comentario || "") + '</textarea>' +
        '<label>Proximo paso</label><textarea data-field="proximo_paso">' + html(payload.proximo_paso || "") + '</textarea>' +
        historicalRowsHtml(proposal, index) +
      '</article>';
    }

    function importPanelHtml() {
      const mode = importAnalysis?.mode || "updates";
      const proposals = importAnalysis?.proposals || [];
      return '<div class="importShell"><section>' +
        '<div class="importControls">' +
          '<div><label>Tipo de importacion</label><select id="importMode"><option value="updates"' + (mode === "updates" ? " selected" : "") + '>Varias actualizaciones</option><option value="historical"' + (mode === "historical" ? " selected" : "") + '>Nuevo elemento con historico</option></select></div>' +
          '<div><label>Comunidad</label><select id="importCommunity"><option value="">Seleccionar comunidad...</option>' + importCommunityOptions() + '</select></div>' +
          '<div><label>Documento DOCX, TXT o MD</label><input id="importFile" type="file" accept=".docx,.txt,.md" /></div>' +
        '</div>' +
        '<label>Texto a analizar</label><textarea id="importSource" class="importSource" placeholder="Pega el resumen estructurado, la reunion o el historico completo...">' + html(importSourceText) + '</textarea>' +
        '<div class="toolbar"><button id="importAnalyze">Analizar y mostrar vista previa</button><button class="ghost" id="importClear">Limpiar</button><span class="muted" id="importMessage"></span></div>' +
      '</section>' +
      (proposals.length ? '<section><div class="contentHead"><div><h2>Vista previa editable</h2><p class="muted">Cada tarjeta indica exactamente lo que se creara o actualizara.</p></div><button class="green" id="importApply">Confirmar seleccionadas</button></div><div class="importProposalList">' + proposals.map(importProposalHtml).join("") + '</div><div class="muted" id="importApplyMessage"></div></section>' : '') + '</div>';
    }

    function collectImportProposals() {
      return [...document.querySelectorAll("[data-import-index]")].map(card => {
        const index = Number(card.dataset.importIndex);
        const original = importAnalysis.proposals[index];
        const value = name => card.querySelector('[data-field="' + name + '"]')?.value || "";
        const action = value("action");
        const type = action.includes("tarea") ? "task" : "project";
        const records = [...card.querySelectorAll("[data-import-record]")].map(row => ({
          ...(original.records?.[Number(row.dataset.importRecord)] || {}),
          fecha: row.querySelector('[data-field="fecha"]').value,
          tipo_registro: row.querySelector('[data-field="tipo_registro"]').value,
          comentario: row.querySelector('[data-field="comentario"]').value,
          proximo_paso: row.querySelector('[data-field="proximo_paso"]').value
        }));
        return {
          ...original,
          selected: card.querySelector('[data-field="selected"]').checked,
          action,
          entity: value("entity_id") ? { type, id: Number(value("entity_id")) } : null,
          records,
          payload: {
            ...(original.payload || {}), titulo: value("titulo"), categoria: value("categoria"),
            estado_nuevo: value("estado_nuevo"), prioridad_nueva: value("prioridad_nueva"),
            responsable_nuevo: value("responsable_nuevo"), responsable_proximo_paso: value("responsable_proximo_paso"),
            fecha_objetivo_proximo_paso: value("fecha_objetivo_proximo_paso"), fecha_proxima_revision: value("fecha_objetivo_proximo_paso"),
            comentario: value("comentario"), proximo_paso: value("proximo_paso"), id_proyecto: value("id_proyecto")
          }
        };
      });
    }

    function bindImportPanel() {
      const communities = (state.daily || {}).communities || [];
      if (!importCommunity && communities.length === 1) importCommunity = String(communities[0].id || communities[0].id_comunidad);
      $("importCommunity").value = importCommunity;
      $("importCommunity").addEventListener("change", event => { importCommunity = event.target.value; });
      $("importSource").addEventListener("input", event => { importSourceText = event.target.value; });
      $("importFile").addEventListener("change", extractImportFile);
      $("importAnalyze").addEventListener("click", analyzeImportSource);
      $("importClear").addEventListener("click", () => { importAnalysis = null; importSourceText = ""; importSourceName = "Texto pegado"; render(); });
      if ($("importApply")) $("importApply").addEventListener("click", applyImportProposals);
      document.querySelectorAll('.importProposal [data-field="selected"]').forEach(input => input.addEventListener("change", event => event.target.closest(".importProposal").classList.toggle("disabled", !event.target.checked)));
      document.querySelectorAll('.importProposal [data-field="action"]').forEach(select => select.addEventListener("change", () => {
        importAnalysis.proposals = collectImportProposals();
        render();
      }));
    }

    async function extractImportFile(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      $("importMessage").textContent = "Leyendo " + file.name + "...";
      try {
        const response = await fetch("/api/import/extract", { method: "POST", body: file, credentials: "same-origin", headers: { "x-file-name": encodeURIComponent(file.name) } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "No se pudo leer el documento.");
        importSourceName = data.name || file.name;
        importSourceText = data.text || "";
        $("importSource").value = importSourceText;
        $("importMessage").textContent = "Documento leido. Revisa el texto y pulsa Analizar.";
      } catch (error) { $("importMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    async function analyzeImportSource() {
      importSourceText = $("importSource").value;
      if (!safe(importSourceText)) { $("importMessage").textContent = "Pega un texto o selecciona un documento."; return; }
      $("importMessage").textContent = "Analizando sin guardar cambios...";
      try {
        if (!options.estados_tarea.length) await loadOptions();
        importAnalysis = await api("/api/import/analyze", { method: "POST", body: JSON.stringify({ text: importSourceText, mode: $("importMode").value }) });
        render();
      } catch (error) { $("importMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    async function applyImportProposals() {
      const proposals = collectImportProposals();
      const selected = proposals.filter(row => row.selected && row.action !== "descartar");
      if (!selected.length) { $("importApplyMessage").textContent = "Selecciona al menos una propuesta."; return; }
      importCommunity = $("importCommunity").value;
      const community = importCommunity;
      if (!community) { $("importApplyMessage").textContent = "Selecciona la comunidad."; return; }
      if (!confirm("Se guardaran " + selected.length + " operaciones revisadas. Confirmas?")) return;
      $("importApplyMessage").textContent = "Guardando operaciones...";
      try {
        const result = await api("/api/import/apply", { method: "POST", body: JSON.stringify({ id_comunidad: community, source_name: importSourceName, source_text: importSourceText, proposals }) });
        importAnalysis = null; importSourceText = ""; importSourceName = "Texto pegado";
        await loadOverview();
        alert(result.applied + " operaciones guardadas correctamente.");
        switchView("work");
      } catch (error) { $("importApplyMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    function reportCommunityOptions(selected) {
      return (reportsCenter.communities || []).map(row => {
        const id = row.id || row.id_comunidad;
        return '<option value="' + html(id) + '"' + (String(id) === String(selected || "") ? " selected" : "") + '>' + html(row.nombre) + '</option>';
      }).join("");
    }

    function filteredReportRows() {
      const query = reportQuery.toLowerCase();
      return (reportsCenter.reports || []).filter(row =>
        (reportType === "all" || safe(row.tipo_informe).toLowerCase().includes(reportType)) &&
        (!reportCommunity || String(row.id_comunidad) === String(reportCommunity)) &&
        (!query || [row.nombre_archivo,row.tipo_informe,row.comunidad,row.proyecto,row.usuario].join(" ").toLowerCase().includes(query))
      );
    }

    function filteredReportEntities() {
      const query = reportEntityQuery.toLowerCase();
      return (reportsCenter.entities || []).filter(row =>
        (reportEntityType === "all" || row.entity_type === reportEntityType) &&
        (!reportEntityCommunity || String(row.id_comunidad) === String(reportEntityCommunity)) &&
        (!query || [row.titulo,row.comunidad,row.estado,row.responsable].join(" ").toLowerCase().includes(query))
      );
    }

    function reportsPanelHtml() {
      if (!reportsCenter.loaded) return '<div class="empty">Cargando centro de informes...</div>';
      const reports = filteredReportRows();
      const entities = filteredReportEntities();
      const reportPage = mobilePage(reports, "reports-existing", 8);
      const entityPage = mobilePage(entities, "reports-entities", 8);
      const reportRows = reports.length ? reportPage.rows.map(row => '<article class="reportRow"><div><h3>' + html(row.nombre_archivo || "Informe") + '</h3><div class="meta"><span class="pill">' + html(row.tipo_informe || "Informe") + '</span><span class="pill">' + html(row.comunidad || "") + '</span></div><div class="muted">' + html(row.fecha_generacion || "") + ' | ' + html(row.usuario || "") + '</div></div><div class="toolbar"><button class="ghost" data-report-open="' + html(row.id_informe) + '">Abrir</button>' + (row.entity_id ? '<button data-report-related="' + html(row.entity_id) + '" data-report-type="' + html(row.entity_type) + '">Ficha</button>' : '') + '</div></article>').join("") + reportPage.footer : '<div class="empty">No hay informes con estos filtros.</div>';
      const entityRows = entities.length ? entityPage.rows.map(row => {
        const key = row.entity_type + ":" + row.entity_id;
        const checked = selectedReportEntities.has(key);
        return '<label class="entityChoice' + (checked ? " selected" : "") + '"><input type="checkbox" data-report-entity="' + html(key) + '"' + (checked ? " checked" : "") + ' /><span><strong>' + html(row.titulo) + '</strong><span class="muted" style="display:block">' + html((row.entity_type === "task" ? "Tarea" : "Proyecto") + " | " + (row.comunidad || "") + " | " + (row.estado || "")) + '</span><span style="display:block;margin-top:4px">' + html(row.responsable || "Sin responsable") + '</span></span></label>';
      }).join("") + entityPage.footer : '<div class="empty">No hay elementos disponibles.</div>';
      return '<div class="reportLayout">' +
        '<section><h2>Informes existentes</h2><div class="reportControls"><div><label>Buscar</label><input id="reportQuery" value="' + html(reportQuery) + '" placeholder="Nombre, proyecto, usuario..." /></div><div><label>Tipo</label><select id="reportType"><option value="all">Todos</option><option value="proyecto">Proyectos</option><option value="tarea">Tareas</option><option value="conjunto">Conjuntos</option></select></div><div><label>Comunidad</label><select id="reportCommunity"><option value="">Todas</option>' + reportCommunityOptions(reportCommunity) + '</select></div></div><div class="reportList" id="reportRows">' + reportRows + '</div></section>' +
        '<section><div class="contentHead"><div><h2>Crear informe conjunto</h2><p class="muted">Selecciona hasta 40 elementos de una misma comunidad. Cada ficha incluye su historico completo.</p></div><span class="tabBadge" id="reportSelectedCount">' + selectedReportEntities.size + ' seleccionados</span></div>' +
        '<div class="reportControls"><div><label>Titulo del informe</label><input id="collectionReportTitle" value="' + html(collectionReportTitle) + '" placeholder="Informe ejecutivo de seguimiento" /></div><div><label>Tipo</label><select id="reportEntityType"><option value="all">Tareas y proyectos</option><option value="project">Solo proyectos</option><option value="task">Solo tareas</option></select></div><div><label>Comunidad</label><select id="reportEntityCommunity"><option value="">Todas</option>' + reportCommunityOptions(reportEntityCommunity) + '</select></div></div>' +
        '<div class="reportControls"><div><label>Buscar elementos</label><input id="reportEntityQuery" value="' + html(reportEntityQuery) + '" placeholder="Titulo, responsable, estado..." /></div><div class="toolbar"><button class="ghost" id="reportSelectVisible">Seleccionar visibles</button><button class="ghost" id="reportClearSelection">Quitar seleccion</button></div><div><button class="green" id="generateCollectionReport">Generar y abrir Word</button></div></div>' +
        '<div class="entitySelector" id="reportEntityRows">' + entityRows + '</div><div class="muted" id="collectionReportMessage"></div></section></div>';
    }

    function bindReportsPanel() {
      if (!reportsCenter.loaded) return;
      $("reportType").value = reportType; $("reportCommunity").value = reportCommunity;
      $("reportEntityType").value = reportEntityType; $("reportEntityCommunity").value = reportEntityCommunity;
      const rerender = () => render();
      $("reportQuery").addEventListener("change", event => { reportQuery = event.target.value; rerender(); });
      $("reportQuery").addEventListener("keydown", event => { if (event.key === "Enter") { reportQuery = event.target.value; rerender(); } });
      $("reportType").addEventListener("change", event => { reportType = event.target.value; rerender(); });
      $("reportCommunity").addEventListener("change", event => { reportCommunity = event.target.value; rerender(); });
      $("reportEntityQuery").addEventListener("change", event => { reportEntityQuery = event.target.value; rerender(); });
      $("reportEntityQuery").addEventListener("keydown", event => { if (event.key === "Enter") { reportEntityQuery = event.target.value; rerender(); } });
      $("collectionReportTitle").addEventListener("input", event => { collectionReportTitle = event.target.value; });
      $("reportEntityType").addEventListener("change", event => { reportEntityType = event.target.value; rerender(); });
      $("reportEntityCommunity").addEventListener("change", event => { reportEntityCommunity = event.target.value; rerender(); });
      document.querySelectorAll("[data-report-open]").forEach(button => button.addEventListener("click", () => window.open("/api/report/download?id=" + encodeURIComponent(button.dataset.reportOpen), "_blank")));
      document.querySelectorAll("[data-report-related]").forEach(button => button.addEventListener("click", () => openEntity(button.dataset.reportType, button.dataset.reportRelated, false).catch(error => alert(error.message))));
      document.querySelectorAll("[data-report-entity]").forEach(input => input.addEventListener("change", event => {
        if (event.target.checked) selectedReportEntities.add(event.target.dataset.reportEntity); else selectedReportEntities.delete(event.target.dataset.reportEntity);
        event.target.closest(".entityChoice").classList.toggle("selected", event.target.checked);
        $("reportSelectedCount").textContent = selectedReportEntities.size + " seleccionados";
      }));
      $("reportSelectVisible").addEventListener("click", () => { filteredReportEntities().forEach(row => selectedReportEntities.add(row.entity_type + ":" + row.entity_id)); render(); });
      $("reportClearSelection").addEventListener("click", () => { selectedReportEntities.clear(); render(); });
      $("generateCollectionReport").addEventListener("click", generateSelectedReport);
    }

    async function loadReportsCenter() {
      try {
        reportsCenter = { ...(await api("/api/reports-center")), loaded: true };
        $("reportsTabCount").textContent = reportsCenter.reports.length;
        if (currentView === "reports") render();
      } catch (error) {
        reportsCenter = { reports: [], entities: [], communities: [], loaded: true, error: error.message };
        if (currentView === "reports") { render(); alert(error.message); }
      }
    }

    async function generateSelectedReport() {
      const selections = [...selectedReportEntities].map(key => { const parts = key.split(":"); return { type: parts[0], id: Number(parts[1]) }; });
      if (!selections.length) { $("collectionReportMessage").textContent = "Selecciona al menos un elemento."; return; }
      if (selections.length > 40) { $("collectionReportMessage").textContent = "El maximo es de 40 elementos."; return; }
      const selectedRows = (reportsCenter.entities || []).filter(row => selectedReportEntities.has(row.entity_type + ":" + row.entity_id));
      if (new Set(selectedRows.map(row => row.id_comunidad)).size > 1) { $("collectionReportMessage").textContent = "Selecciona elementos de una sola comunidad."; return; }
      if (!confirm("Se generara un informe Word con " + selections.length + " fichas completas. Confirmas?")) return;
      const reportWindow = window.open("", "_blank");
      $("collectionReportMessage").textContent = "Generando informe...";
      try {
        collectionReportTitle = $("collectionReportTitle").value;
        const result = await api("/api/report/collection", { method: "POST", body: JSON.stringify({ title: collectionReportTitle || "Informe conjunto", selections }) });
        if (reportWindow) reportWindow.location = "/api/report/download?id=" + encodeURIComponent(result.report_id);
        await loadReportsCenter();
      } catch (error) {
        if (reportWindow) reportWindow.close();
        $("collectionReportMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    function workflowActionCard(row) {
      const overdue = row.fecha_objetivo && row.fecha_objetivo.slice(0, 10) < new Date().toISOString().slice(0, 10);
      const thirdParty = safe(row.estado_entidad).toLowerCase().includes("tercero");
      return '<article class="card workflowCard ' + (overdue ? "overdue " : "") + (thirdParty ? "thirdParty" : "") + '">' +
        '<h3>' + html(row.elemento || row.titulo) + '</h3>' +
        '<div class="meta"><span class="pill">' + html(row.tipo_entidad === "tarea" ? "Tarea" : "Proyecto") + '</span><span class="pill">' + html(row.tipo_accion || "Accion") + '</span><span class="pill">' + html(row.comunidad || "") + '</span></div>' +
        '<div class="line"><strong>Para:</strong> ' + html(row.usuario_destino || "") + (row.solicitante ? ' | <strong>Solicita:</strong> ' + html(row.solicitante) : '') + '</div>' +
        '<div class="line"><strong>Desde:</strong> ' + html(row.fecha_creacion || "") + '</div>' +
        (row.fecha_objetivo ? '<div class="line"><strong>Fecha objetivo:</strong> ' + html(row.fecha_objetivo) + '</div>' : '') +
        '<div class="nextStep"><div class="line"><strong>Accion solicitada:</strong> ' + html(row.detalle || "Sin detalle") + '</div></div>' +
        '<div class="cardActions"><button class="ghost" data-work-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir ficha</button><button class="green" data-work-action="record" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Resolver / actualizar</button><button data-work-action="attach" data-title="' + html(row.elemento || row.titulo) + '" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Adjuntar</button></div>' +
      '</article>';
    }

    function presidentRequestCard(row) {
      return '<article class="card workflowCard overdue">' +
        '<h3>' + html(row.elemento || row.titulo) + '</h3>' +
        '<div class="meta"><span class="pill">Decision pendiente</span><span class="pill">' + html(row.comunidad || "") + '</span><span class="pill">' + html(row.fecha_creacion || "") + '</span></div>' +
        '<div class="line"><strong>Solicitante:</strong> ' + html(row.solicitante || row.usuario_creacion || "") + '</div>' +
        '<div class="nextStep"><div class="line"><strong>Solicitud:</strong> ' + html(row.ultimo_comentario || row.detalle || "") + '</div>' +
        '<div class="line"><strong>Proximo paso solicitado:</strong> ' + html(row.proximo_paso_solicitado || "") + '</div></div>' +
        '<div class="cardActions"><button class="ghost" data-work-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Ver contexto completo</button><button data-work-action="president" data-request-id="' + html(row.id_solicitud) + '">Responder</button></div>' +
      '</article>';
    }

    function workPanelHtml() {
      const isPresident = (state.usuario || {}).rol === "Presidente";
      const rows = isPresident ? (state.workflow.president_requests || []) : (state.workflow.actions || []);
      const content = rows.length ? rows.map(isPresident ? presidentRequestCard : workflowActionCard).join("") : '<div class="empty">No tienes acciones pendientes.</div>';
      return '<div class="cards">' + content + '</div>';
    }

    function reviewCard(row) {
      const reasons = (row.review_reasons || []).map(reason => '<span class="pill">' + html(reason) + '</span>').join("");
      return '<article class="card workflowCard ' + ((row.review_reasons || []).includes("Vencida") ? "overdue" : "") + '">' +
        '<h3>' + html(row.elemento) + '</h3>' +
        '<div class="meta"><span class="pill">' + html(row.entity_type === "task" ? "Tarea" : "Proyecto") + '</span>' + reasons + '</div>' +
        '<div class="line"><strong>Comunidad:</strong> ' + html(row.comunidad || "") + '</div>' +
        (row.proyecto ? '<div class="line"><strong>Proyecto:</strong> ' + html(row.proyecto) + '</div>' : '') +
        '<div class="line"><strong>Estado:</strong> ' + html(row.estado || "") + ' | <strong>Prioridad:</strong> ' + html(row.prioridad || "") + '</div>' +
        '<div class="line"><strong>Responsable:</strong> ' + html(row.responsable || "") + '</div>' +
        '<div class="nextStep"><div class="line"><strong>Proximo paso:</strong> ' + html(row.proximo_paso || "Sin definir") + '</div>' +
        (row.ultimo_comentario ? '<div class="line"><strong>Ultimo comentario:</strong> ' + html(row.ultimo_comentario) + '</div>' : '') + '</div>' +
        '<div class="cardActions"><button class="ghost" data-work-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir ficha</button><button class="green" data-work-action="review" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Revisar ahora</button><button data-work-action="attach" data-title="' + html(row.elemento) + '" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Adjuntar</button></div>' +
      '</article>';
    }

    function reviewPanelHtml() {
      const review = state.workflow.review || { items: [], summary: {}, communities: [] };
      const items = (review.items || []).filter(row =>
        (!reviewCommunity || String(row.id_comunidad) === String(reviewCommunity)) &&
        (reviewType === "all" || row.entity_type === reviewType)
      );
      const summary = {
        vencidas: items.filter(row => (row.review_reasons || []).includes("Vencida")).length,
        mias: items.filter(row => (row.review_reasons || []).includes("Pendiente de mi")).length,
        terceros: items.filter(row => (row.review_reasons || []).includes("Pendiente de tercero")).length,
        bloqueadas: items.filter(row => (row.review_reasons || []).includes("Bloqueada")).length,
        sin_actualizar: items.filter(row => (row.review_reasons || []).includes("Sin actualizar")).length
      };
      const page = mobilePage(items, "review", 6);
      const communities = (review.communities || []).map(row => '<option value="' + html(row.id || row.id_comunidad) + '"' + (String(row.id || row.id_comunidad) === String(reviewCommunity) ? " selected" : "") + '>' + html(row.nombre) + '</option>').join("");
      return '<div class="reviewSummary">' +
          countCard("Vencidas", summary.vencidas || 0) + countCard("Pendientes de mi", summary.mias || 0) + countCard("Pendientes de terceros", summary.terceros || 0) + countCard("Bloqueadas", summary.bloqueadas || 0) + countCard("Sin actualizar", summary.sin_actualizar || 0) +
        '</div>' +
        '<div class="workflowControls"><div><label>Comunidad</label><select id="reviewCommunity"><option value="">Todas las comunidades</option>' + communities + '</select></div>' +
        '<div><label>Tipo</label><select id="reviewType"><option value="all"' + (reviewType === "all" ? " selected" : "") + '>Tareas y proyectos</option><option value="task"' + (reviewType === "task" ? " selected" : "") + '>Solo tareas</option><option value="project"' + (reviewType === "project" ? " selected" : "") + '>Solo proyectos</option></select></div>' +
        '<div><label>Progreso de esta revision</label><div class="detailBox">' + (reviewProgress.tasks.size + reviewProgress.projects.size) + ' revisados</div></div></div>' +
        '<div class="cards">' + (items.length ? page.rows.map(reviewCard).join("") + page.footer : '<div class="empty">No hay elementos para este filtro.</div>') + '</div>' +
        '<section style="margin-top:12px"><h2>Cerrar revision de hoy</h2><textarea id="reviewNotes" placeholder="Observaciones generales opcionales..."></textarea><div class="toolbar"><button class="green" id="finishReview">Guardar resumen de revision</button><span class="muted" id="reviewMessage"></span></div></section>';
    }

    function notificationCard(row) {
      const hasEntity = row.entity_type && row.entity_id;
      return '<article class="card notificationCard ' + (row.leida ? "read" : "unread") + '">' +
        '<h3>' + html(row.titulo) + '</h3>' +
        '<div class="meta"><span class="pill">' + html(row.tipo || "Notificacion") + '</span><span class="pill">' + html(row.usuario_destino || "") + '</span><span class="pill">' + html(row.comunidad || "") + '</span></div>' +
        '<div class="line">' + html(row.mensaje || "") + '</div><div class="line muted">' + html(row.fecha_creacion || "") + '</div>' +
        '<div class="cardActions">' + (hasEntity ? '<button class="ghost" data-work-action="notification-open" data-notification-id="' + html(row.id_notificacion) + '" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir elemento</button>' : '') + (!row.leida ? '<button data-work-action="notification-read" data-notification-id="' + html(row.id_notificacion) + '">Marcar leida</button>' : '') + '</div>' +
      '</article>';
    }

    function notificationsPanelHtml() {
      const rows = state.workflow.notifications || [];
      const page = mobilePage(rows, "notifications", 8);
      return '<div class="toolbar"><button class="ghost" id="markAllNotifications">Marcar todas como leidas</button><span class="muted" id="notificationMessage"></span></div><div class="cards">' +
        (rows.length ? page.rows.map(notificationCard).join("") + page.footer : '<div class="empty">No hay notificaciones.</div>') + '</div>';
    }

    function bindReviewPanel() {
      $("reviewCommunity").addEventListener("change", event => { reviewCommunity = event.target.value; render(); });
      $("reviewType").addEventListener("change", event => { reviewType = event.target.value; render(); });
      $("finishReview").addEventListener("click", finishDailyReview);
    }

    function bindNotificationsPanel() {
      $("markAllNotifications").addEventListener("click", () => markNotification(0, true));
    }

    async function markNotification(id, all = false) {
      try {
        await api("/api/notifications/read", { method: "POST", body: JSON.stringify({ id, all }) });
        await loadOverview();
      } catch (error) {
        alert(error.message);
      }
    }

    async function finishDailyReview() {
      const total = reviewProgress.tasks.size + reviewProgress.projects.size;
      if (!total && !confirm("No has guardado seguimientos durante esta revision. Quieres registrar igualmente el cierre?")) return;
      $("reviewMessage").textContent = "Guardando resumen...";
      try {
        await api("/api/review/complete", { method: "POST", body: JSON.stringify({
          id_comunidad: reviewCommunity || null,
          tasks: reviewProgress.tasks.size,
          projects: reviewProgress.projects.size,
          skipped: 0,
          observaciones: $("reviewNotes").value
        }) });
        reviewProgress = { tasks: new Set(), projects: new Set() };
        $("reviewMessage").textContent = "Revision guardada.";
        await loadOverview();
      } catch (error) {
        $("reviewMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    function openPresidentDecision(requestId) {
      selectedPresidentRequest = (state.workflow.president_requests || []).find(row => String(row.id_solicitud) === String(requestId));
      if (!selectedPresidentRequest) return;
      $("presidentDecisionTitle").textContent = selectedPresidentRequest.elemento || selectedPresidentRequest.titulo;
      $("presidentDecisionSubtitle").textContent = selectedPresidentRequest.comunidad || "";
      $("presidentDecisionContext").innerHTML = '<strong>Solicitud</strong><p>' + html(selectedPresidentRequest.ultimo_comentario || selectedPresidentRequest.detalle || "") + '</p><strong>Proximo paso solicitado</strong><p>' + html(selectedPresidentRequest.proximo_paso_solicitado || "") + '</p>';
      $("presidentDecisionComment").value = "";
      $("presidentDecisionMessage").textContent = "";
      $("presidentDecisionModal").classList.remove("hidden");
    }

    function closePresidentDecision() {
      $("presidentDecisionModal").classList.add("hidden");
      selectedPresidentRequest = null;
    }

    async function submitPresidentDecision(decision) {
      if (!selectedPresidentRequest) return;
      const comment = $("presidentDecisionComment").value;
      if (!safe(comment)) {
        $("presidentDecisionMessage").innerHTML = '<span class="dangerText">El comentario es obligatorio.</span>';
        return;
      }
      if (!confirm("Se registrara la decision \\"" + decision + "\\" y se devolvera la responsabilidad al solicitante. Confirmas?")) return;
      $("presidentDecisionMessage").textContent = "Guardando decision...";
      try {
        await api("/api/president/respond", { method: "POST", body: JSON.stringify({ id: selectedPresidentRequest.id_solicitud, decision, comment }) });
        closePresidentDecision();
        await loadOverview();
      } catch (error) {
        $("presidentDecisionMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    function securityUploaderHtml() {
      return '<section class="securityUploader"><h3>Cargar partes de Seguridad</h3><input id="securityFiles" type="file" multiple accept=".pdf,.doc,.docx,.txt" /><div class="toolbar"><button class="green" id="securityUploadButton">Subir documentos</button><span class="muted" id="securityUploadMessage"></span></div><div class="securityReceipts" id="securityReceipts">' + (securityData.receipts || []).map(row => '<div class="securityReceipt ' + (row.error ? 'error' : '') + '"><strong>' + html(row.name) + '</strong><div>' + html(row.message) + '</div></div>').join('') + '</div></section>';
    }

    function securityLookupCardHtml(row) {
      const matched = row.matched_property || {};
      const properties = (row.properties || []).slice(0, 5).map(prop => '<span class="securityPropertyChip">' + html(prop.codigo_propiedad || '') + (prop.zona ? ' · ' + html(prop.zona) : '') + '</span>').join('');
      const contacts = (row.contacts || []).slice(0, 5).map(contact => '<div><strong>' + html(contact.tipo || 'Contacto') + ':</strong> ' + html(contact.valor || '') + (contact.principal ? ' <span class="pill">Principal</span>' : '') + '</div>').join('');
      return '<article class="securityLookupCard"><div class="securityLookupCardHead"><div><h3>' + html(row.nombre || 'Sin nombre') + '</h3><div class="muted">' + html(row.codigo_netfincas ? 'Codigo Netfincas ' + row.codigo_netfincas : 'Sin codigo Netfincas') + ' · coincidencia por ' + html(row.match_type || 'busqueda') + '</div></div><span class="pill">' + html(String(Math.round(Number(row.score || 0)))) + '</span></div>' + (matched.codigo_propiedad ? '<div class="detailBox"><strong>Propiedad localizada</strong>' + html(matched.codigo_propiedad || '') + (matched.zona ? ' · ' + html(matched.zona) : '') + (matched.subzona ? ' · ' + html(matched.subzona) : '') + '</div>' : '') + '<div class="securityPropertyList">' + (properties || '<span class="muted">Sin propiedades activas vinculadas.</span>') + '</div><div class="securityContactList">' + (contacts || '<span class="muted">Sin contactos cargados.</span>') + '</div></article>';
    }

    function securityLookupHtml() {
      const lookup = securityData.lookup;
      const result = lookup ? (lookup.matches || []).map(securityLookupCardHtml).join('') : '';
      const empty = lookup && !(lookup.matches || []).length ? '<div class="empty">No he encontrado coincidencias claras. Prueba con nombre, vivienda, telefono o email.</div>' : '';
      return '<section class="securityLookup"><div class="contentHead"><div><h2>Consulta rápida de propietarios</h2><p class="muted">Busca por propietario, vivienda, email o telefono. Entiende abreviaturas como ALB, Alboaire, CB, PLZ, 17H o Emerald.</p></div></div><div class="securityLookupBar"><input id="securityOwnerLookupQuery" placeholder="Ejemplo: bloque 1 alboaire 1 A, CB 2 derecha, email o telefono" value="' + html(lookup?.query || '') + '" /><button id="securityOwnerLookupButton">Buscar</button></div><div class="muted" id="securityOwnerLookupMessage">' + (lookup ? html(String(lookup.total || 0)) + ' coincidencia(s). Busqueda normalizada: ' + html(lookup.normalized_query || '') : 'Consulta de solo lectura auditada.') + '</div><div class="securityLookupResults">' + result + empty + '</div></section>';
    }

    function securityChartHtml(title, rows) {
      const values = rows || [];
      const maximum = Math.max(1, ...values.map(row => Number(row.total || 0)));
      const total = Math.max(1, values.reduce((sum,row) => sum + Number(row.total || 0), 0));
      const colors = ['#2563eb','#0f766e','#d97706','#be123c','#7c3aed','#15803d','#c2410c','#475569'];
      return '<div class="securityChart"><h3>' + html(title) + '</h3>' + (values.map((row,index) => {
        const value = Number(row.total || 0);
        const percentage = Math.round(value * 100 / total);
        return '<div class="securityBarRow"><span title="' + html(row.label || '') + '">' + html(row.label || 'Sin determinar') + '</span><div class="securityBarTrack"><div class="securityBarFill" style="width:' + Math.max(3, Math.round(value * 100 / maximum)) + '%;background:' + colors[index % colors.length] + '"></div></div><strong>' + html(String(value)) + '</strong><span class="securityBarPct">' + percentage + '%</span></div>';
      }).join('') || '<div class="muted">Sin datos.</div>') + '</div>';
    }

    function securityIncidentCardHtml(row) {
      return '<article class="securityIncident severity-' + slug(row.gravedad) + '" data-security-incident="' + row.id_incidencia + '"><h3>' + html(row.titulo) + '</h3><div class="meta"><span class="pill">' + html(row.gravedad) + '</span><span class="pill">' + html(row.estado_revision) + '</span><span class="pill">' + html(row.categoria_normalizada) + '</span></div><div class="line"><strong>Zona:</strong> ' + html(row.zona || row.ubicacion || 'Sin determinar') + '</div><div class="line"><strong>Fecha:</strong> ' + html(row.fecha_hora_suceso || 'Sin fecha') + '</div>' + (row.numero_reporte ? '<div class="line"><strong>Reporte:</strong> #' + html(row.numero_reporte) + '</div>' : '') + (row.revisor ? '<div class="line"><strong>Revisi&oacute;n:</strong> ' + html(row.revisor) + '</div>' : '') + '</article>';
    }

    function filteredSecurityIncidents() {
      const rows = (securityData.overview || {}).incidents || [];
      const filters = securityData.filters || {};
      const query = safe(filters.query).toLowerCase();
      return rows.filter(row =>
        (!filters.status || row.estado_revision === filters.status) &&
        (!filters.severity || row.gravedad === filters.severity) &&
        (!filters.category || row.categoria_normalizada === filters.category) &&
        (!query || [row.titulo,row.descripcion,row.zona,row.ubicacion,row.numero_reporte,row.categoria_origen].join(' ').toLowerCase().includes(query))
      );
    }

    function securityPanelHtml() {
      const access = securityData.access || {};
      if (!access.can_manage) return '<div class="securityShell">' + securityLookupHtml() + securityUploaderHtml() + '</div>';
      const data = securityData.overview;
      if (!data) return '<div class="empty">Cargando Seguridad...</div>';
      const incidents = filteredSecurityIncidents();
      const statusOptions = [...new Set((data.incidents || []).map(row => row.estado_revision).filter(Boolean))];
      const categoryOptions = data.category_options || [];
      const filters = securityData.filters || {};
      const pendingStates = new Set(['Pendiente de revision','En revision']);
      const pendingRows = incidents.filter(row => pendingStates.has(row.estado_revision));
      const reviewedRows = incidents.filter(row => !pendingStates.has(row.estado_revision));
      const pendingCards = pendingRows.map(securityIncidentCardHtml).join('');
      const reviewedCards = reviewedRows.map(securityIncidentCardHtml).join('');
      const documentSummary = data.document_summary || {};
      const reviewCounts = [
        ['Pendientes de revisi&oacute;n', data.counts['Pendiente de revision'] || 0],
        ['En revisi&oacute;n', data.counts['En revision'] || 0],
        ['Revisadas / gestionadas', data.reviewed || 0],
        ['Descartadas', data.counts.Descartada || 0],
      ];
      const reviewBreakdown = '<div class="securityBreakdown"><h3>Estado de la revisi&oacute;n</h3>' + reviewCounts.map(row => '<div class="securityBreakdownRow"><span>' + row[0] + '</span><strong>' + html(String(row[1])) + '</strong></div>').join('') + '<p class="muted">' + html(String(documentSummary.total || 0)) + ' documentos cargados' + (Number(documentSummary.errors || 0) ? ' &middot; ' + html(String(documentSummary.errors)) + ' con error' : '') + '.</p></div>';
      const documents = (data.documents || []).slice(0, 20).map(row => '<div class="reportRow"><div><h3>' + html(row.nombre_original) + '</h3><div class="muted">' + html(row.tipo_documento || 'Documento') + ' · ' + html(row.fecha_carga || '') + ' · ' + html(String(row.incidencias_nuevas || 0)) + ' nuevas / ' + html(String(row.incidencias_duplicadas || 0)) + ' repetidas</div></div><a href="/api/security/document?id=' + row.id_documento + '&inline=1" target="_blank"><button class="ghost">Abrir</button></a></div>').join('');
      return '<div class="securityShell"><div class="securityMetrics">' + countCard('Partes examinados',String(documentSummary.examined || 0)) + countCard('Incidencias detectadas',String(data.total || 0)) + countCard('Pendientes de revisar',String(data.pending || 0)) + countCard('Revisadas',String(data.reviewed || 0)) + countCard('Tipos de incidencia',String((data.categories || []).length)) + '</div><div class="securityAnalytics">' + securityChartHtml('Incidencias por clasificación',data.categories) + reviewBreakdown + '</div>' + securityLookupHtml() + securityUploaderHtml() + '<div class="securityFilters"><input id="securityQuery" placeholder="Buscar incidencia, zona o reporte" value="' + html(filters.query || '') + '" /><select id="securityStatus"><option value="">Todos los estados</option>' + statusOptions.map(value => '<option' + (value === filters.status ? ' selected' : '') + '>' + html(value) + '</option>').join('') + '</select><select id="securitySeverity"><option value="">Todas las gravedades</option>' + (data.severity_options || []).map(value => '<option' + (value === filters.severity ? ' selected' : '') + '>' + html(value === 'Critica' ? 'Crítica' : value) + '</option>').join('') + '</select><select id="securityCategory"><option value="">Todas las categorías</option>' + categoryOptions.map(value => '<option' + (value === filters.category ? ' selected' : '') + '>' + html(value) + '</option>').join('') + '</select></div><section class="securityQueue"><div class="securityQueueHead"><div><h2>Pendientes de revisar</h2><p class="muted">Incidencias que requieren validaci&oacute;n de Luis o Elena.</p></div><span class="pill">' + html(String(pendingRows.length)) + '</span></div><div class="securityIncidentList">' + (pendingCards || '<div class="empty">No hay incidencias pendientes con estos filtros.</div>') + '</div></section><section class="securityQueue securityReviewed"><div class="securityQueueHead"><div><h2>Partes revisados</h2><p class="muted">Hist&oacute;rico de incidencias ya clasificadas o gestionadas.</p></div><span class="pill">' + html(String(reviewedRows.length)) + '</span></div><div class="securityIncidentList">' + (reviewedCards || '<div class="empty">No hay partes revisados con estos filtros.</div>') + '</div></section><section><div class="contentHead"><div><h2>Documentos protegidos</h2><p class="muted">Aperturas y descargas quedan auditadas.</p></div></div><div class="reportList">' + (documents || '<div class="empty">No hay documentos cargados.</div>') + '</div></section></div>';
    }

    function bindSecurityPanel() {
      if ($('securityUploadButton')) $('securityUploadButton').addEventListener('click', uploadSecurityFiles);
      if ($('securityOwnerLookupButton')) $('securityOwnerLookupButton').addEventListener('click', runSecurityOwnerLookup);
      if ($('securityOwnerLookupQuery')) $('securityOwnerLookupQuery').addEventListener('keydown', event => { if(event.key === 'Enter') runSecurityOwnerLookup(); });
      ['securityStatus','securitySeverity','securityCategory'].forEach(id => {
        if (!$(id)) return;
        $(id).addEventListener('change', event => {
          const key = ({securityQuery:'query',securityStatus:'status',securitySeverity:'severity',securityCategory:'category'})[id];
          securityData.filters[key] = event.target.value;
          render();
        });
      });
      if ($('securityQuery')) {
        $('securityQuery').addEventListener('change', event => { securityData.filters.query=event.target.value; render(); });
        $('securityQuery').addEventListener('keydown', event => { if(event.key==='Enter'){securityData.filters.query=event.target.value;render();} });
      }
      document.querySelectorAll('[data-security-incident]').forEach(card => card.addEventListener('click', () => openSecurityIncident(Number(card.dataset.securityIncident))));
    }

    async function runSecurityOwnerLookup() {
      const query = safe(($('securityOwnerLookupQuery') || {}).value);
      if (!query) { $('securityOwnerLookupMessage').textContent = 'Escribe una vivienda, propietario, email o telefono.'; return; }
      $('securityOwnerLookupButton').disabled = true;
      $('securityOwnerLookupMessage').textContent = 'Buscando...';
      try {
        securityData.lookup = await api('/api/security/lookup',{method:'POST',body:JSON.stringify({query})});
      } catch (error) {
        securityData.lookup = { query, total:0, matches:[], normalized_query:'', error:error.message };
      }
      render();
      if (securityData.lookup?.error && $('securityOwnerLookupMessage')) $('securityOwnerLookupMessage').innerHTML = '<span class="dangerText">' + html(securityData.lookup.error) + '</span>';
    }

    async function uploadSecurityFiles() {
      const files = [...(($('securityFiles') || {}).files || [])];
      if (!files.length) { $('securityUploadMessage').textContent = 'Selecciona al menos un documento.'; return; }
      $('securityUploadButton').disabled = true;
      for (let index=0; index<files.length; index++) {
        const file = files[index];
        $('securityUploadMessage').textContent = 'Procesando ' + (index + 1) + ' de ' + files.length + ': ' + file.name;
        try {
          const response = await fetch('/api/security/upload',{method:'POST',body:file,credentials:'same-origin',headers:{'x-file-name':encodeURIComponent(file.name),'content-type':file.type || 'application/octet-stream'}});
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'No se pudo cargar el documento.');
          const message = result.duplicate_document ? 'Ya estaba cargado; no se ha duplicado.' : (result.new_incidents || 0) + ' incidencia(s) nueva(s), ' + (result.duplicate_incidents || 0) + ' repetida(s).';
          securityData.receipts.unshift({name:file.name,message});
        } catch (error) {
          securityData.receipts.unshift({name:file.name,message:error.message,error:true});
        }
        render();
      }
      $('securityUploadButton').disabled = false;
      $('securityUploadMessage').textContent = 'Carga finalizada.';
      if ((securityData.access || {}).can_manage) await loadSecurityData(false);
    }

    async function loadSecurityData(renderAfter = true) {
      securityData.overview = await api('/api/security/overview');
      if ($('securityTabCount')) $('securityTabCount').textContent = securityData.overview.pending || 0;
      if (renderAfter && currentView === 'security') render();
    }

    async function loadSecurityOnly(user) {
      securityData.access = await api('/api/security/access');
      state = { usuario:user, proyectos:[], tareas:[], workflow:{actions:[],notifications:[],president_requests:[],review:{items:[],summary:{},communities:[]}}, daily:{metrics:{},map:{items:[],counts:{}},documents:[],communities:[]} };
      currentView = 'security';
      showApp();
      $("mobileMenuToggle").disabled = true;
      $("mobileMenuToggle").setAttribute("aria-label", "Organizador");
      $("appView").classList.add("security-only");
      $('counts').classList.add('hidden');
      $('sessionStatus').textContent = (user.nombre || '') + ' - Seguridad';
      $('changeCommunityTop').classList.add('hidden');
      document.querySelectorAll('.tabs .tab').forEach(button => button.classList.add('hidden'));
      $('securityTab').classList.remove('hidden');
      $('securityTabCount').textContent = '';
      render();
    }

    async function openSecurityIncident(id) {
      let detail = await api('/api/security/incident?id=' + encodeURIComponent(id));
      let lockMessage = '';
      if (['Pendiente de revision','En revision'].includes(detail.incident.estado_revision)) {
        try {
          await api('/api/security/action',{method:'POST',body:JSON.stringify({action:'claim',data:{id}})});
          detail = await api('/api/security/incident?id=' + encodeURIComponent(id));
        } catch (error) { lockMessage = error.message; }
      }
      securityData.selected = detail;
      renderSecurityModal(lockMessage);
      $('securityModal').classList.remove('hidden');
    }

    function renderSecurityModal(lockMessage) {
      const detail = securityData.selected || {};
      const item = detail.incident || {};
      const finalState = ['Confirmada','Informativa','Resuelta','Descartada','Vinculada'].includes(item.estado_revision);
      const locked = Boolean(lockMessage) || (item.revisor && item.revisor !== (state.usuario || {}).nombre && item.estado_revision === 'En revision');
      const readonly = finalState || locked;
      $('securityModalTitle').textContent = item.titulo || 'Incidencia de Seguridad';
      $('securityModalSubtitle').textContent = (item.numero_reporte ? '#' + item.numero_reporte + ' · ' : '') + (item.fecha_hora_suceso || 'Sin fecha') + (locked ? ' · En revision por ' + item.revisor : '');
      const disabled = readonly ? ' disabled' : '';
      const categories = ((securityData.overview || {}).category_options || []).map(value => '<option' + (value === item.categoria_normalizada ? ' selected' : '') + '>' + html(value) + '</option>').join('');
      const severities = ((securityData.overview || {}).severity_options || ['Critica','Alta','Media','Informativa']).map(value => '<option' + (value === item.gravedad ? ' selected' : '') + '>' + html(value) + '</option>').join('');
      const sources = (detail.sources || []).map(row => '<div class="securitySourceBox"><strong>' + html(row.nombre_original) + '</strong><div class="muted">' + html(row.tipo_documento || '') + ' · ' + html(row.fecha_carga || '') + '</div><div class="toolbar"><a href="/api/security/document?id=' + row.id_documento + '&inline=1" target="_blank"><button class="ghost">Abrir protegido</button></a></div></div>').join('');
      const candidates = (detail.candidates || []).map(row => '<div class="securityCandidate"><div><strong>' + html(row.title) + '</strong><div class="muted">' + html(row.entity_type === 'task' ? 'Tarea' : 'Proyecto') + ' · coincidencia ' + Math.round(Number(row.score || 0) * 100) + '%</div></div><div class="toolbar"><button class="ghost" data-security-link="' + row.entity_type + ':' + row.entity_id + '">Vincular</button><button data-security-followup="' + row.entity_type + ':' + row.entity_id + '">Añadir seguimiento</button></div></div>').join('');
      const projectOptions = (state.proyectos || []).map(row => '<option value="' + row.id_proyecto + '">' + html(row.nombre) + '</option>').join('');
      $('securityModalBody').innerHTML = (lockMessage ? '<div class="answerNote">' + html(lockMessage) + ' Puedes consultar la ficha, pero no editarla.</div>' : '') + '<section><div class="formGrid"><div><label>Fecha y hora</label><input id="securityDate" value="' + html(item.fecha_hora_suceso || '') + '"' + disabled + ' /></div><div><label>Zona</label><input id="securityZone" value="' + html(item.zona || '') + '"' + disabled + ' /></div><div><label>Ubicacion</label><input id="securityLocation" value="' + html(item.ubicacion || '') + '"' + disabled + ' /></div><div><label>Categoria normalizada</label><select id="securityNormalizedCategory"' + disabled + '>' + categories + '</select></div><div><label>Gravedad</label><select id="securityIncidentSeverity"' + disabled + '>' + severities + '</select></div><div><label>Estado de revision</label><input value="' + html(item.estado_revision || '') + '" disabled /></div></div><label>Titulo</label><input id="securityIncidentTitle" value="' + html(item.titulo || '') + '"' + disabled + ' /><label>Descripcion</label><textarea id="securityDescription"' + disabled + '>' + html(item.descripcion || '') + '</textarea><label>Actuacion de Seguridad</label><textarea id="securityActionTaken"' + disabled + '>' + html(item.actuacion_seguridad || '') + '</textarea><label>Resultado</label><textarea id="securityResult"' + disabled + '>' + html(item.resultado || '') + '</textarea><label>Notas de revision</label><textarea id="securityReviewNotes"' + disabled + '>' + html(item.notas_revision || '') + '</textarea>' + (!readonly ? '<div class="toolbar"><button class="green" id="securitySaveIncident">Guardar cambios</button><button id="securityConfirmIncident">Confirmar</button><button class="secondary" id="securityInformationIncident">Informativa</button><button class="secondary" id="securityResolveIncident">Resuelta</button><button class="red" id="securityDiscardIncident">Descartar</button><span class="muted" id="securityIncidentMessage"></span></div>' : '') + '</section><section><h2>Clasificacion original</h2><div class="securityOriginal"><strong>Incidencia:</strong> ' + html(item.categoria_origen || 'No indicada') + '\\n<strong>Tipo:</strong> ' + html(item.tipo_origen || 'No indicado') + '\\n<strong>Situacion:</strong> ' + html(item.situacion_origen || 'No indicada') + '</div></section><section><h2>Documentos fuente</h2><div class="attachmentGrid">' + (sources || '<div class="empty">Sin documento asociado.</div>') + '</div></section>' + (!readonly ? '<section><h2>Relacion con el trabajo operativo</h2><div class="history">' + (candidates || '<div class="empty">No hay coincidencias claras. Puedes crear un elemento nuevo.</div>') + '</div><div class="formGrid"><div><label>Crear</label><select id="securityCreateType"><option value="project">Proyecto</option><option value="task">Tarea</option></select></div><div><label>Proyecto contenedor para tarea</label><select id="securityCreateProject"><option value="">Seleccionar...</option>' + projectOptions + '</select></div><div><label>Responsable</label><input id="securityCreateOwner" list="responsiblesList" value="' + html((state.usuario || {}).nombre || '') + '" /></div></div><label>Titulo</label><input id="securityCreateTitle" value="' + html(item.titulo || '') + '" /><label>Proximo paso</label><textarea id="securityCreateNextStep">Revisar la incidencia, determinar la actuacion necesaria y dejar constancia del resultado.</textarea><div class="toolbar"><button class="green" id="securityCreateWork">Crear y vincular</button><span class="muted" id="securityConvertMessage"></span></div></section>' : '');
      if (!readonly) {
        $('securitySaveIncident').addEventListener('click', saveSecurityIncident);
        $('securityConfirmIncident').addEventListener('click', () => resolveSecurityIncident('Confirmada'));
        $('securityInformationIncident').addEventListener('click', () => resolveSecurityIncident('Informativa'));
        $('securityResolveIncident').addEventListener('click', () => resolveSecurityIncident('Resuelta'));
        $('securityDiscardIncident').addEventListener('click', () => resolveSecurityIncident('Descartada'));
        $('securityCreateWork').addEventListener('click', createSecurityWork);
        document.querySelectorAll('[data-security-link]').forEach(button => button.addEventListener('click', () => securityConvert('link',button.dataset.securityLink)));
        document.querySelectorAll('[data-security-followup]').forEach(button => button.addEventListener('click', () => securityConvert('followup',button.dataset.securityFollowup)));
      }
    }

    function securityEditPayload() {
      return { id:securityData.selected.incident.id_incidencia, fecha_hora_suceso:$('securityDate').value, zona:$('securityZone').value, ubicacion:$('securityLocation').value, categoria_normalizada:$('securityNormalizedCategory').value, gravedad:$('securityIncidentSeverity').value, titulo:$('securityIncidentTitle').value, descripcion:$('securityDescription').value, actuacion_seguridad:$('securityActionTaken').value, resultado:$('securityResult').value, notas_revision:$('securityReviewNotes').value };
    }

    async function saveSecurityIncident() {
      $('securityIncidentMessage').textContent = 'Guardando...';
      try { await api('/api/security/action',{method:'POST',body:JSON.stringify({action:'save',data:securityEditPayload()})}); await loadSecurityData(false); await openSecurityIncident(securityData.selected.incident.id_incidencia); }
      catch(error){ $('securityIncidentMessage').innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    async function resolveSecurityIncident(status) {
      if (!confirm('Marcar la incidencia como ' + status + '?')) return;
      try { await api('/api/security/action',{method:'POST',body:JSON.stringify({action:'save',data:securityEditPayload()})}); await api('/api/security/action',{method:'POST',body:JSON.stringify({action:'resolve',data:{id:securityData.selected.incident.id_incidencia,status,notes:$('securityReviewNotes').value}})}); $('securityModal').classList.add('hidden'); await loadSecurityData(); }
      catch(error){ $('securityIncidentMessage').innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    async function securityConvert(mode, encoded) {
      const parts = encoded.split(':');
      if (!confirm((mode === 'link' ? 'Vincular sin modificar' : 'Añadir un seguimiento resumido a') + ' este elemento?')) return;
      try { const result=await api('/api/security/convert',{method:'POST',body:JSON.stringify({id_incidencia:securityData.selected.incident.id_incidencia,mode,type:parts[0],entity_id:Number(parts[1]),proximo_paso:$('securityCreateNextStep').value,responsable:$('securityCreateOwner').value})}); $('securityModal').classList.add('hidden'); await loadSecurityData(); if(result.id) await openEntity(result.type,result.id,false); }
      catch(error){ $('securityConvertMessage').innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    async function createSecurityWork() {
      const type = $('securityCreateType').value;
      if (type === 'task' && !$('securityCreateProject').value) { $('securityConvertMessage').textContent='Selecciona el proyecto contenedor de la tarea.'; return; }
      if (!confirm('Crear y vincular este ' + (type === 'task' ? 'tarea' : 'proyecto') + '?')) return;
      try { const result=await api('/api/security/convert',{method:'POST',body:JSON.stringify({id_incidencia:securityData.selected.incident.id_incidencia,mode:'create',type,id_proyecto:Number($('securityCreateProject').value || 0),titulo:$('securityCreateTitle').value,proximo_paso:$('securityCreateNextStep').value,responsable:$('securityCreateOwner').value})}); $('securityModal').classList.add('hidden'); await loadSecurityData(); if(result.id) await openEntity(result.type,result.id,false); }
      catch(error){ $('securityConvertMessage').innerHTML = '<span class="dangerText">' + html(error.message) + '</span>'; }
    }

    function render() {
      const specialView = ["home", "assemblies", "security", "map", "work", "review", "global-search", "documents", "reports", "imports", "notifications", "ai", "admin"].includes(currentView);
      $("copilotFab").classList.toggle("hidden", !["Superusuario", "Administrador", "Usuario"].includes((state.usuario || {}).rol));
      $("listFilters").classList.toggle("hidden", specialView);
      $("cards").className = specialView ? "specialPanel" : "cards";
      setActiveNavigation(currentView);
      if (currentView === "home") {
        $("contentTitle").textContent = "Inicio";
        $("contentSubtitle").textContent = "Situación operativa y prioridades del día.";
        $("visibleCount").textContent = "Actualizado ahora";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = homePanelHtml();
        return;
      }
      if (currentView === "map") {
        $("contentTitle").textContent = "Trabajo Hoy";
        $("contentSubtitle").textContent = "Bandeja central para acciones, revisiones y asuntos clasificados por prioridad operativa.";
        $("visibleCount").textContent = (((state.daily || {}).map || {}).items || []).length + " elementos";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = mapPanelHtml();
        return;
      }
      if (currentView === "assemblies") {
        $("contentTitle").textContent = selectedAssemblyId ? "Ficha de asamblea" : "Asambleas";
        $("contentSubtitle").textContent = selectedAssemblyId ? "Registro, quorum y votaciones con la misma logica de la aplicacion de escritorio." : "Preparacion y operativa de las asambleas de tus comunidades.";
        $("visibleCount").textContent = assembliesData.loaded ? assembliesData.assemblies.length + " asambleas" : "Cargando...";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = assembliesPanelHtml();
        bindAssembliesPanel();
        return;
      }
      if (currentView === "security") {
        $("contentTitle").textContent = (securityData.access || {}).can_manage ? "Seguridad" : "Carga de partes";
        $("contentSubtitle").textContent = (securityData.access || {}).can_manage ? "Incidencias, revision compartida y documentos protegidos." : "Envio de partes al equipo de gestion.";
        $("visibleCount").textContent = (securityData.access || {}).can_manage && securityData.overview ? securityData.overview.pending + " pendientes" : "";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = securityPanelHtml();
        bindSecurityPanel();
        return;
      }
      if (currentView === "work") {
        const president = (state.usuario || {}).rol === "Presidente";
        $("contentTitle").textContent = president ? "Decisiones de presidencia" : "Acciones pendientes";
        $("contentSubtitle").textContent = president ? "Solicitudes que requieren aprobar, rechazar o pedir aclaracion." : "Trabajo dirigido a ti que requiere seguimiento o respuesta.";
        $("visibleCount").textContent = president ? (state.workflow.president_requests || []).length + " pendientes" : (state.workflow.actions || []).length + " pendientes";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = workPanelHtml();
        return;
      }
      if (currentView === "review") {
        $("contentTitle").textContent = "Revision diaria ejecutiva";
        $("contentSubtitle").textContent = "Prioriza vencidas, pendientes de ti, terceros, bloqueadas y elementos sin actualizar.";
        $("visibleCount").textContent = ((((state.workflow.review || {}).summary || {}).total) || 0) + " elementos activos";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = reviewPanelHtml();
        bindReviewPanel();
        return;
      }
      if (currentView === "notifications") {
        $("contentTitle").textContent = "Centro de notificaciones";
        $("contentSubtitle").textContent = "Respuestas, aprobaciones, aclaraciones y nuevas acciones en una sola bandeja.";
        $("visibleCount").textContent = (state.workflow.unread_notifications || 0) + " sin leer";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = notificationsPanelHtml();
        bindNotificationsPanel();
        return;
      }
      if (currentView === "global-search") {
        $("contentTitle").textContent = "Buscador global";
        $("contentSubtitle").textContent = "Busca en fichas, seguimientos, responsables, acciones, informes y anexos.";
        $("visibleCount").textContent = globalSearchResults.length ? globalSearchResults.length + " resultados" : "";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = globalSearchPanelHtml();
        bindGlobalSearchPanel();
        return;
      }
      if (currentView === "documents") {
        $("contentTitle").textContent = "Documentos e informes";
        $("contentSubtitle").textContent = "Archivos centralizados de las comunidades a las que tienes acceso.";
        $("visibleCount").textContent = ((state.daily || {}).documents || []).length + " disponibles";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = documentsPanelHtml();
        bindDocumentsPanel();
        return;
      }
      if (currentView === "reports") {
        $("contentTitle").textContent = "Centro de informes";
        $("contentSubtitle").textContent = "Consulta informes existentes o crea uno conjunto con los elementos que elijas.";
        $("visibleCount").textContent = reportsCenter.loaded ? reportsCenter.reports.length + " informes" : "Cargando...";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = reportsPanelHtml();
        bindReportsPanel();
        return;
      }
      if (currentView === "imports") {
        $("contentTitle").textContent = "Importacion inteligente";
        $("contentSubtitle").textContent = "Detecta varias actuaciones o reconstruye un historico completo antes de guardar.";
        $("visibleCount").textContent = importAnalysis ? (importAnalysis.proposals || []).length + " propuestas" : "Sin analizar";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = importPanelHtml();
        bindImportPanel();
        return;
      }
      if (currentView === "ai") {
        $("contentTitle").textContent = "Centro IA";
        $("contentSubtitle").textContent = "Consulta informacion sin modificar datos o prepara acciones operativas con confirmacion.";
        $("visibleCount").textContent = "";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = aiPanelHtml();
        bindAiPanel();
        return;
      }
      if (currentView === "admin") {
        $("contentTitle").textContent = "Usuarios y comunidades";
        $("contentSubtitle").textContent = "Gestion exclusiva del Superusuario: permisos, asignaciones y acceso.";
        $("visibleCount").textContent = adminData.loaded ? adminData.users.length + " usuarios | " + adminData.communities.length + " comunidades" : "Cargando...";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = adminPanelHtml();
        bindAdminPanel();
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
      const page = mobilePage(rows, currentView, 6);
      $("contentTitle").textContent = title;
      $("contentSubtitle").textContent = currentView === "projects"
        ? "Proyectos visibles segun tus comunidades y permisos."
        : "Tareas visibles segun tus comunidades y permisos.";
      $("visibleCount").textContent = rows.length + " de " + activeRows().length + " visibles";
      $("viewActions").classList.toggle("hidden", !canWrite());
      $("newProjectButton").classList.toggle("hidden", currentView !== "projects");
      $("newTaskButton").classList.toggle("hidden", currentView !== "tasks");
      $("cards").innerHTML = rows.length ? page.rows.map(card).join("") + page.footer : '<div class="empty">No hay elementos con esos filtros.</div>';
    }

    function aiPanelHtml() {
      return '<div class="aiHub">' +
        '<section class="aiBox aiAgentBox">' +
          '<div class="aiSectionHead"><div><h2>Agente IA</h2><p>Escribe de forma natural. La app decide si debe consultar, preparar una accion individual o dividirlo en un lote revisable.</p></div><span class="pill">Router seguro</span></div>' +
          '<textarea id="agentText" class="aiInput aiAgentInput" placeholder="Ejemplos: ¿Cuanto debe PROMAGA? / Actualiza el proyecto de arquetas... / Pega varios asuntos separados por ---"></textarea>' +
          '<div class="toolbar">' +
            '<button class="green" id="agentSend">Enviar al agente</button>' +
            '<button class="ghost" id="agentClear">Limpiar agente</button>' +
            '<span class="muted" id="agentMessage"></span>' +
          '</div>' +
          '<div id="agentResult"></div>' +
          '<details class="detailBox" open><summary><strong>Herramientas internas</strong></summary><div id="agentToolsList" class="agentToolsList"><div class="aiHistoryEmpty">Cargando herramientas...</div></div></details>' +
          '<details class="detailBox"><summary><strong>Contexto de conversacion</strong></summary>' +
            '<div class="toolbar"><button class="ghost" id="agentContextRefresh">Actualizar contexto</button><button class="ghost" id="agentContextClear">Vaciar contexto</button><span class="muted" id="agentContextMessage"></span></div>' +
            '<div id="agentContextList" class="agentContextList"><div class="aiHistoryEmpty">Cargando contexto...</div></div>' +
          '</details>' +
          '<details class="detailBox" open><summary><strong>Centro de acciones del agente</strong></summary>' +
            '<div class="toolbar"><button class="ghost" id="agentActionsRefresh">Actualizar acciones</button><span class="muted" id="agentActionsMessage"></span></div>' +
            '<div id="agentActionsList" class="agentActionsList"><div class="aiHistoryEmpty">Cargando acciones pendientes...</div></div>' +
          '</details>' +
        '</section>' +
        '<div class="aiQueryLayout">' +
          '<section class="aiBox aiQueryBox">' +
            '<div class="aiSectionHead"><div><h2>Consultas IA</h2><p>Pregunta sobre propietarios, deuda, contabilidad, presupuestos, tareas o proyectos.</p></div><span class="pill">Solo lectura</span></div>' +
            '<textarea id="aiQueryText" class="aiInput aiQueryInput" placeholder="Ejemplo: ¿Cuanto debe PROMAGA?"></textarea>' +
            '<div class="toolbar">' +
              '<button id="aiAsk">Consultar</button>' +
              '<button class="ghost" id="aiQueryClear">Nueva consulta</button>' +
              '<span class="muted" id="aiQueryMessage"></span>' +
            '</div>' +
            '<div id="aiQueryResult"></div>' +
          '</section>' +
          '<aside class="aiHistoryPanel">' +
            '<div class="aiHistoryHead"><h2>Historial</h2><div class="aiHistoryActions"><button class="ghost" id="aiHistoryRefresh" title="Actualizar historial">Actualizar</button><button class="ghost" id="aiHistoryClear" title="Eliminar mi historial">Vaciar</button></div></div>' +
            '<div class="aiHistoryList" id="aiHistoryList"><div class="aiHistoryEmpty">Cargando consultas...</div></div>' +
          '</aside>' +
        '</div>' +
        '<section class="aiBox aiOperationBox">' +
          '<div class="aiSectionHead"><div><h2>Entrada inteligente</h2><p>Crea o actualiza trabajo a partir de una llamada, reunion, correo o nota. Nada se guarda sin confirmacion.</p></div><span class="pill">Accion revisable</span></div>' +
          '<textarea id="aiText" class="aiInput" placeholder="Pega aqui una transcripcion, resumen de llamada, correo o nota operativa..."></textarea>' +
          '<div class="toolbar">' +
            '<button class="green" id="aiAnalyze">Preparar accion</button>' +
            '<button class="ghost" id="aiClear">Limpiar</button>' +
            '<span class="muted" id="aiMessage"></span>' +
          '</div>' +
          '<div id="aiOperationResult"></div>' +
        '</section>' +
        '<section class="aiBox aiBatchBox">' +
          '<div class="aiSectionHead"><div><h2>Automatizacion guiada</h2><p>Pega varios asuntos separados por --- o una transcripcion larga de reunion. La app la divide en asuntos revisables y tu decides que aplicar.</p></div><span class="pill">Lote / reunion</span></div>' +
          '<textarea id="aiBatchText" class="aiInput" placeholder="Pega aqui varios asuntos o una transcripcion completa de reunion. La app intentara separar temas, seguimientos, decisiones, dudas y proximos pasos..."></textarea>' +
          '<div class="toolbar">' +
            '<button id="aiBatchAnalyze">Preparar lote</button>' +
            '<button class="ghost" id="aiBatchClear">Limpiar lote</button>' +
            '<span class="muted" id="aiBatchMessage"></span>' +
          '</div>' +
          '<div id="aiBatchResult"></div>' +
        '</section>' +
        '<section class="aiBox aiMemoryBox">' +
          '<div class="aiSectionHead"><div><h2>Memoria IA</h2><p>Reglas confirmadas que ayudan a redactar y clasificar mejor. Puedes desactivarlas si una no encaja.</p></div><span class="pill">Controlada</span></div>' +
          '<div class="toolbar"><button class="ghost" id="aiRulesRefresh">Actualizar memoria</button><span class="muted" id="aiRulesMessage"></span></div>' +
          '<div id="aiRulesList" class="aiRulesList"><div class="aiHistoryEmpty">Cargando memoria...</div></div>' +
        '</section>' +
      '</div>';
    }

    function bindAiPanel() {
      $("agentSend").addEventListener("click", askAgent);
      $("agentText").addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          askAgent();
        }
      });
      $("agentClear").addEventListener("click", () => {
        $("agentText").value = "";
        $("agentResult").innerHTML = "";
        $("agentMessage").textContent = "";
        $("agentText").focus();
      });
      $("agentContextRefresh").addEventListener("click", () => loadAgentContext(true));
      $("agentContextClear").addEventListener("click", clearAgentContext);
      $("agentActionsRefresh").addEventListener("click", () => loadAgentActions(true));
      $("aiAsk").addEventListener("click", askAiQuery);
      $("aiQueryText").addEventListener("keydown", event => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          askAiQuery();
        }
      });
      $("aiQueryClear").addEventListener("click", () => {
        $("aiQueryText").value = "";
        $("aiQueryResult").innerHTML = "";
        $("aiQueryMessage").textContent = "";
        document.querySelectorAll(".aiHistoryRow").forEach(row => row.classList.remove("active"));
        $("aiQueryText").focus();
      });
      $("aiHistoryRefresh").addEventListener("click", () => loadAiHistory(true));
      $("aiHistoryClear").addEventListener("click", clearAiHistory);
      $("aiRulesRefresh").addEventListener("click", () => loadAiRules(true));
      $("aiAnalyze").addEventListener("click", analyzeAiText);
      $("aiBatchAnalyze").addEventListener("click", analyzeAiBatch);
      $("aiBatchClear").addEventListener("click", () => {
        $("aiBatchText").value = "";
        $("aiBatchResult").innerHTML = "";
        $("aiBatchMessage").textContent = "";
        aiBatch = null;
      });
      $("aiClear").addEventListener("click", () => {
        $("aiText").value = "";
        $("aiOperationResult").innerHTML = "";
        $("aiMessage").textContent = "";
        aiProposal = null;
      });
      loadAiHistory();
      loadAiRules();
      loadAgentTools();
      loadAgentContext();
      loadAgentActions();
    }

    function aiHistoryDate(value) {
      if (!value) return "";
      const date = new Date(String(value).replace(" ", "T"));
      return Number.isNaN(date.getTime())
        ? String(value)
        : date.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });
    }

    function renderAiHistory(activeId = 0) {
      if (!$("aiHistoryList")) return;
      if (!aiHistory.length) {
        $("aiHistoryList").innerHTML = '<div class="aiHistoryEmpty">Todavia no has realizado consultas.</div>';
        return;
      }
      $("aiHistoryList").innerHTML = aiHistory.map(item => {
        const answer = safe(item.respuesta?.answer || "");
        const summary = answer.length > 105 ? answer.slice(0, 102) + "..." : answer;
        return '<button class="aiHistoryRow' + (Number(activeId) === Number(item.id_consulta) ? " active" : "") + '" type="button" data-ai-history="' + html(item.id_consulta) + '">' +
          '<span class="aiHistoryQuestion">' + html(item.pregunta || "Consulta") + '</span>' +
          '<span class="line muted">' + html(summary || "Respuesta estructurada") + '</span>' +
          '<span class="aiHistoryMeta"><span>' + html(aiHistoryDate(item.fecha_creacion)) + '</span><span>Ver respuesta</span></span>' +
        '</button>';
      }).join("");
      document.querySelectorAll("[data-ai-history]").forEach(button => button.addEventListener("click", () => openAiHistory(Number(button.dataset.aiHistory))));
    }

    async function loadAiHistory(force = false, activeId = 0) {
      if (aiHistoryLoaded && !force) {
        renderAiHistory(activeId);
        return;
      }
      if ($("aiHistoryList")) $("aiHistoryList").innerHTML = '<div class="aiHistoryEmpty">Cargando consultas...</div>';
      try {
        const data = await api("/api/ai/history?limit=40");
        aiHistory = data.history || [];
        aiHistoryLoaded = true;
        renderAiHistory(activeId);
      } catch (error) {
        if ($("aiHistoryList")) $("aiHistoryList").innerHTML = '<div class="aiHistoryEmpty dangerText">' + html(error.message) + '</div>';
      }
    }

    function openAiHistory(id) {
      const item = aiHistory.find(row => Number(row.id_consulta) === Number(id));
      if (!item) return;
      $("aiQueryText").value = item.pregunta || "";
      $("aiQueryMessage").textContent = "Consulta del " + aiHistoryDate(item.fecha_creacion);
      renderAiProposal(item.respuesta || {}, "aiQueryResult");
      renderAiHistory(id);
      $("aiQueryResult").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    async function clearAiHistory() {
      if (!aiHistory.length) return;
      if (!confirm("Se eliminara tu historial personal de consultas IA. ¿Continuar?")) return;
      try {
        await api("/api/ai/history/action", { method: "POST", body: JSON.stringify({ action: "clear" }) });
        aiHistory = [];
        aiHistoryLoaded = true;
        renderAiHistory();
        $("aiQueryResult").innerHTML = "";
        $("aiQueryMessage").textContent = "Historial eliminado.";
      } catch (error) {
        $("aiQueryMessage").textContent = error.message;
      }
    }

    function ruleTypeLabel(type) {
      return {
        redaccion_titulo: "Titulo",
        redaccion_comentario: "Comentario",
        redaccion_proximo_paso: "Proximo paso",
      }[type] || type || "Regla";
    }

    function renderAiRules() {
      if (!$("aiRulesList")) return;
      if (!aiRules.length) {
        $("aiRulesList").innerHTML = '<div class="aiHistoryEmpty">Todavia no hay reglas aprendidas. Se crearan cuando apliques una propuesta IA editada y marques aprender.</div>';
        return;
      }
      $("aiRulesList").innerHTML = aiRules.map(rule =>
        '<article class="aiRuleCard' + (rule.activa ? '' : ' inactive') + '">' +
          '<div class="aiRuleHead"><strong>' + html(ruleTypeLabel(rule.tipo_regla)) + '</strong><span class="pill">' + html(rule.activa ? "Activa" : "Inactiva") + '</span></div>' +
          '<div class="line">' + html(rule.descripcion || "") + '</div>' +
          '<div class="detailBox"><strong>Redaccion preferida</strong><div>' + html(rule.valor_propuesto || "") + '</div></div>' +
          (rule.patron ? '<div class="line muted">Patron: ' + html(rule.patron) + '</div>' : '') +
          '<div class="aiRuleMeta"><span>Usos: ' + html(rule.usos || 0) + '</span><span>Confianza: ' + html(Math.round((rule.confianza || 0) * 100)) + '%</span><span>' + html(rule.usuario_creacion || "") + '</span></div>' +
          '<div class="toolbar"><button class="ghost" data-ai-rule-toggle="' + html(rule.id_regla) + '" data-ai-rule-active="' + html(rule.activa ? 0 : 1) + '">' + html(rule.activa ? "Desactivar" : "Activar") + '</button></div>' +
        '</article>'
      ).join("");
      document.querySelectorAll("[data-ai-rule-toggle]").forEach(button => button.addEventListener("click", () => updateAiRule(Number(button.dataset.aiRuleToggle), button.dataset.aiRuleActive === "1")));
    }

    async function loadAiRules(force = false) {
      if (aiRulesLoaded && !force) {
        renderAiRules();
        return;
      }
      if ($("aiRulesList")) $("aiRulesList").innerHTML = '<div class="aiHistoryEmpty">Cargando memoria...</div>';
      try {
        const data = await api("/api/ai/rules?limit=80&include_inactive=1");
        aiRules = data.rules || [];
        aiRulesLoaded = true;
        renderAiRules();
        if ($("aiRulesMessage")) $("aiRulesMessage").textContent = aiRules.length ? aiRules.length + " reglas en memoria." : "Sin reglas todavia.";
      } catch (error) {
        if ($("aiRulesList")) $("aiRulesList").innerHTML = '<div class="aiHistoryEmpty dangerText">' + html(error.message) + '</div>';
      }
    }

    async function updateAiRule(id, active) {
      if (!id) return;
      try {
        await api("/api/ai/rules/action", { method: "POST", body: JSON.stringify({ action: "update", data: { id_regla: id, activa: active } }) });
        aiRulesLoaded = false;
        await loadAiRules(true);
      } catch (error) {
        if ($("aiRulesMessage")) $("aiRulesMessage").textContent = error.message;
      }
    }

    function agentIntentLabel(intent) {
      return {
        consulta: "Consulta",
        accion: "Accion revisable",
        lote: "Lote revisable",
        informe: "Informe revisable",
        email: "Email revisable",
        aclaracion: "Aclaracion necesaria",
      }[intent] || "Agente";
    }

    function renderAgentTools() {
      if (!$("agentToolsList")) return;
      if (!agentTools.length) {
        $("agentToolsList").innerHTML = '<div class="aiHistoryEmpty">No hay herramientas disponibles para este perfil.</div>';
        return;
      }
      const moduleLabels = {
        centro_ia: "Centro IA",
        propietarios: "Propietarios",
        contabilidad: "Contabilidad",
        trabajo: "Trabajo",
        asambleas: "Asambleas",
        seguridad: "Seguridad",
        documentos: "Documentos",
        informes: "Informes",
        email: "Email",
      };
      $("agentToolsList").innerHTML = agentTools.map(tool =>
        '<article class="agentToolCard ' + html(tool.status || "") + '">' +
          '<strong>' + html(tool.label || tool.id) + '</strong>' +
          '<div class="agentToolMeta">' +
            '<span class="pill">' + html(moduleLabels[tool.module] || tool.module || "Modulo") + '</span>' +
            '<span class="pill">' + html(tool.status === "active" ? "Activa" : "Planificada") + '</span>' +
            (tool.requires_confirmation ? '<span class="pill">Confirmacion</span>' : '<span class="pill">Solo lectura</span>') +
          '</div>' +
          (tool.limitation ? '<div class="line muted">' + html(tool.limitation) + '</div>' : '') +
        '</article>'
      ).join("");
    }

    async function loadAgentTools(force = false) {
      if (agentToolsLoaded && !force) {
        renderAgentTools();
        return;
      }
      if ($("agentToolsList")) $("agentToolsList").innerHTML = '<div class="aiHistoryEmpty">Cargando herramientas...</div>';
      try {
        const data = await api("/api/agent/tools");
        agentTools = data.tools || [];
        agentToolsLoaded = true;
        renderAgentTools();
      } catch (error) {
        if ($("agentToolsList")) $("agentToolsList").innerHTML = '<div class="aiHistoryEmpty dangerText">' + html(error.message) + '</div>';
      }
    }

    function renderSelectedAgentTool(tool) {
      if (!tool) return "";
      return '<div class="detailBox"><strong>Herramienta elegida</strong>' +
        '<div>' + html(tool.label || tool.id) + '</div>' +
        '<div class="agentToolMeta">' +
          '<span class="pill">' + html(tool.module || "modulo") + '</span>' +
          '<span class="pill">' + html(tool.status === "active" ? "Activa" : "Planificada") + '</span>' +
          (tool.requires_confirmation ? '<span class="pill">Requiere confirmacion</span>' : '<span class="pill">Solo lectura</span>') +
        '</div>' +
        (tool.limitation ? '<div class="line muted">' + html(tool.limitation) + '</div>' : '') +
        (tool.endpoint ? '<div class="line muted">Ruta interna: ' + html(tool.endpoint) + '</div>' : '') +
      '</div>';
    }

    function renderGuidanceList(items) {
      const rows = (items || []).filter(Boolean);
      if (!rows.length) return '<div class="line muted">Sin elementos relevantes.</div>';
      return '<ul>' + rows.map(item => {
        if (typeof item === "string") return '<li>' + html(item) + '</li>';
        const label = item.label || item.type || "Accion";
        const suffix = item.enabled === false && item.reason ? " - " + item.reason : "";
        return '<li>' + html(label + suffix) + '</li>';
      }).join("") + '</ul>';
    }

    function renderAgentGuidance(guidance) {
      if (!guidance) return "";
      return '<section class="agentGuidance">' +
        '<div class="agentGuidanceGrid">' +
          '<article class="agentGuidanceCard confirmed"><h4>Confirmado</h4>' + renderGuidanceList(guidance.confirmed_data) + '</article>' +
          '<article class="agentGuidanceCard inference"><h4>Inferencia</h4>' + renderGuidanceList(guidance.inferences) + '</article>' +
          '<article class="agentGuidanceCard risk"><h4>Riesgos</h4>' + renderGuidanceList(guidance.risks) + '</article>' +
          '<article class="agentGuidanceCard"><h4>Dudas</h4>' + renderGuidanceList(guidance.questions) + '</article>' +
          '<article class="agentGuidanceCard"><h4>Revisar</h4>' + renderGuidanceList(guidance.review_focus) + '</article>' +
          '<article class="agentGuidanceCard"><h4>Siguientes acciones</h4>' + renderGuidanceList(guidance.suggested_actions) + '</article>' +
        '</div>' +
      '</section>';
    }

    function renderAgentContext() {
      if (!$("agentContextList")) return;
      if (!agentContext.length) {
        $("agentContextList").innerHTML = '<div class="aiHistoryEmpty">Todavia no hay contexto reciente. Se ira creando con tus mensajes al agente.</div>';
        if ($("agentContextMessage")) $("agentContextMessage").textContent = "Sin contexto reciente.";
        return;
      }
      $("agentContextList").innerHTML = agentContext.map(item => {
        const summary = safe(item.resumen_respuesta || "");
        const shortSummary = summary.length > 260 ? summary.slice(0, 257) + "..." : summary;
        return '<article class="agentContextItem">' +
          '<strong>' + html(item.texto_usuario || "Mensaje") + '</strong>' +
          '<div class="agentToolMeta">' +
            '<span class="pill">' + html(agentIntentLabel(item.intent || "")) + '</span>' +
            (item.herramienta_modulo ? '<span class="pill">' + html(item.herramienta_modulo) + '</span>' : '') +
            (item.herramienta_estado ? '<span class="pill">' + html(item.herramienta_estado === "active" ? "Activa" : "Planificada") + '</span>' : '') +
          '</div>' +
          (shortSummary ? '<div class="line muted">' + html(shortSummary) + '</div>' : '') +
          '<div class="line muted">' + html(aiHistoryDate(item.fecha_creacion)) + '</div>' +
        '</article>';
      }).join("");
      if ($("agentContextMessage")) $("agentContextMessage").textContent = agentContext.length + " turno(s) recientes.";
    }

    async function loadAgentContext(force = false) {
      if (agentContextLoaded && !force) {
        renderAgentContext();
        return;
      }
      if ($("agentContextList")) $("agentContextList").innerHTML = '<div class="aiHistoryEmpty">Cargando contexto...</div>';
      try {
        const data = await api("/api/agent/context?limit=12");
        agentContext = data.context || [];
        agentContextLoaded = true;
        renderAgentContext();
      } catch (error) {
        if ($("agentContextList")) $("agentContextList").innerHTML = '<div class="aiHistoryEmpty dangerText">' + html(error.message) + '</div>';
      }
    }

    async function clearAgentContext() {
      if (!confirm("Se vaciara solo el contexto conversacional reciente del Agente IA. No se borran reglas permanentes ni datos de la app. ¿Continuar?")) return;
      try {
        await api("/api/agent/context/clear", { method: "POST", body: JSON.stringify({}) });
        agentContext = [];
        agentContextLoaded = true;
        renderAgentContext();
      } catch (error) {
        if ($("agentContextMessage")) $("agentContextMessage").textContent = error.message;
      }
    }

    function proposalActionLabel(action) {
      return {
        seguimiento_proyecto: "Actualizar proyecto existente",
        seguimiento_tarea: "Actualizar tarea existente",
        crear_proyecto: "Crear proyecto nuevo",
        crear_tarea: "Crear tarea nueva",
        consulta: "Consulta sin cambios",
        revisar_manual: "Revisar manualmente",
        fuera_de_alcance: "Descartar",
      }[action] || action || "Sin clasificar";
    }

    function proposalEntityLabel(type) {
      return { task: "Tarea", project: "Proyecto", owner: "Propietario", property: "Propiedad" }[type] || "Elemento";
    }

    function renderProposalUnderstanding(proposal) {
      const payload = proposal?.payload || {};
      const entity = proposal?.entity || {};
      const action = proposalActionLabel(proposal?.action || "");
      const title = payload.titulo || entity.title || proposal?.before_after_preview?.title || "Pendiente de confirmar";
      const target = entity.id ? proposalEntityLabel(entity.type) + " " + entity.id : (proposal?.action || "").includes("crear") ? "Nuevo elemento" : "Destino pendiente";
      const data = [
        proposal?.source ? "Origen: " + proposal.source : "",
        proposal?.data_status ? "Dato: " + proposal.data_status : "",
        (proposal?.candidates || []).length ? (proposal.candidates.length + " candidato(s) detectado(s)") : "",
        (proposal?.used_rules || []).length ? (proposal.used_rules.length + " regla(s) de memoria aplicada(s)") : "",
      ].filter(Boolean).join(" | ") || "Datos internos y texto aportado.";
      const saveState = proposal?.requires_confirmation
        ? "No se guarda nada hasta pulsar Aplicar propuesta."
        : "Solo lectura, sin escritura de datos.";
      const question = (proposal?.questions || [])[0] || (proposal?.needs_entity_confirmation ? proposal.entity_confirmation_message : "Sin dudas obligatorias.");
      return '<div class="proposalUnderstanding">' +
        '<article class="proposalUnderstandingCard"><strong>Que he entendido</strong><span>' + html(action) + '</span></article>' +
        '<article class="proposalUnderstandingCard"><strong>Destino</strong><span>' + html(target + " - " + title) + '</span></article>' +
        '<article class="proposalUnderstandingCard"><strong>Datos usados</strong><span>' + html(data) + '</span></article>' +
        '<article class="proposalUnderstandingCard"><strong>Control</strong><span>' + html(saveState) + '</span></article>' +
        '<article class="proposalUnderstandingCard"><strong>Duda principal</strong><span>' + html(question) + '</span></article>' +
      '</div>';
    }

    function renderCandidateSelector(proposal) {
      const candidates = proposal?.candidates || [];
      if (!candidates.length) return "";
      const activeType = proposal?.entity?.type || "";
      const activeId = String(proposal?.entity?.id || "");
      return '<div class="candidateSelector">' +
        '<strong>' + html(proposal?.needs_entity_confirmation ? "Selecciona el destino exacto antes de guardar" : "Candidatos detectados") + '</strong>' +
        (proposal?.entity_confirmation_message ? '<div class="muted">' + html(proposal.entity_confirmation_message) + '</div>' : '') +
        '<div class="candidateSelectorList">' + candidates.map(candidate => {
          const type = candidate.type || "";
          const id = String(candidate.id || "");
          const active = type === activeType && id === activeId;
          return '<article class="candidateOption' + (active ? ' active' : '') + '" data-ai-candidate-card="' + html(type + ":" + id) + '">' +
            '<h4>' + html(proposalEntityLabel(type) + " " + id + " - " + (candidate.title || "")) + '</h4>' +
            '<div class="agentActionMeta"><span class="pill">' + html(proposalEntityLabel(type)) + '</span>' +
              (candidate.score !== undefined ? '<span class="pill">Coincidencia ' + html(candidate.score) + '</span>' : '') +
              (candidate.comunidad ? '<span class="pill">' + html(candidate.comunidad) + '</span>' : '') +
            '</div>' +
            '<button class="ghost" type="button" data-ai-candidate-type="' + html(type) + '" data-ai-candidate-id="' + html(id) + '">Usar este destino</button>' +
          '</article>';
        }).join("") + '</div>' +
      '</div>';
    }

    function bindCandidateSelector(container) {
      if (!container) return;
      container.querySelectorAll("[data-ai-candidate-type]").forEach(button => button.addEventListener("click", () => {
        const type = button.dataset.aiCandidateType;
        const id = button.dataset.aiCandidateId;
        if (!type || !id || !$("aiEntity") || !$("aiAction")) return;
        $("aiAction").value = type === "task" ? "seguimiento_tarea" : "seguimiento_proyecto";
        $("aiEntity").innerHTML = entityOptionsHtml(type, id);
        $("aiEntity").value = id;
        container.querySelectorAll(".candidateOption").forEach(card => card.classList.remove("active"));
        button.closest(".candidateOption")?.classList.add("active");
        bindAiBeforeAfterPreview(container);
      }));
    }

    function renderAgentActions() {
      const container = $("agentActionsList");
      if (!container) return;
      if (!agentActions.length) {
        container.innerHTML = '<div class="aiHistoryEmpty">No hay propuestas pendientes del agente.</div>';
        if ($("agentActionsMessage")) $("agentActionsMessage").textContent = "Sin acciones pendientes.";
        return;
      }
      container.innerHTML = agentActions.map(item => {
        const managed = item.estado !== "Pendiente";
        return '<article class="agentActionItem' + (managed ? ' managed' : '') + '">' +
          '<h4>' + html(item.titulo || "Propuesta del agente") + '</h4>' +
          '<div class="agentActionMeta"><span class="pill">' + html(agentIntentLabel(item.intent || "")) + '</span><span class="pill">' + html(item.estado || "") + '</span><span class="pill">' + html(aiHistoryDate(item.fecha_creacion)) + '</span></div>' +
          (item.resumen ? '<div class="line muted">' + html(item.resumen.length > 260 ? item.resumen.slice(0, 257) + "..." : item.resumen) + '</div>' : '') +
          '<div class="toolbar"><button class="ghost" data-agent-action-open="' + html(item.id_propuesta) + '">Abrir propuesta</button>' +
            (item.estado === "Pendiente" ? '<button data-agent-action-status="' + html(item.id_propuesta) + '" data-status="Gestionada">Marcar gestionada</button>' : '<button class="ghost" data-agent-action-status="' + html(item.id_propuesta) + '" data-status="Pendiente">Reabrir</button>') +
            '<button class="red" data-agent-action-delete="' + html(item.id_propuesta) + '">Eliminar</button></div>' +
        '</article>';
      }).join("");
      if ($("agentActionsMessage")) $("agentActionsMessage").textContent = agentActions.filter(item => item.estado === "Pendiente").length + " pendiente(s).";
      container.querySelectorAll("[data-agent-action-open]").forEach(button => button.addEventListener("click", () => openAgentAction(button.dataset.agentActionOpen)));
      container.querySelectorAll("[data-agent-action-status]").forEach(button => button.addEventListener("click", () => updateAgentAction(button.dataset.agentActionStatus, button.dataset.status)));
      container.querySelectorAll("[data-agent-action-delete]").forEach(button => button.addEventListener("click", () => deleteAgentAction(button.dataset.agentActionDelete)));
    }

    async function loadAgentActions(force = false) {
      if (agentActionsLoaded && !force) {
        renderAgentActions();
        return;
      }
      if ($("agentActionsList")) $("agentActionsList").innerHTML = '<div class="aiHistoryEmpty">Cargando acciones pendientes...</div>';
      try {
        const data = await api("/api/agent/actions?limit=50");
        agentActions = data.actions || [];
        agentActionsLoaded = true;
        renderAgentActions();
      } catch (error) {
        if ($("agentActionsList")) $("agentActionsList").innerHTML = '<div class="aiHistoryEmpty dangerText">' + html(error.message) + '</div>';
      }
    }

    function openAgentAction(id) {
      const item = agentActions.find(row => String(row.id_propuesta) === String(id));
      if (!item) return;
      const proposal = item.propuesta || {};
      if (item.intent === "email") {
        renderAgentEmailDraft(proposal, "agentResult");
      } else if (item.intent === "informe") {
        renderAgentReportProposal(proposal, "agentResult");
      } else if (item.intent === "lote") {
        aiBatch = proposal;
        renderAiBatch();
        $("aiBatchResult")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      } else {
        aiProposal = proposal;
        renderAiProposal(proposal, "agentResult");
      }
      $("agentResult")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    async function updateAgentAction(id, status) {
      try {
        await api("/api/agent/actions", { method: "POST", body: JSON.stringify({ action: "update", data: { id_propuesta: id, estado: status } }) });
        agentActionsLoaded = false;
        await loadAgentActions(true);
      } catch (error) {
        if ($("agentActionsMessage")) $("agentActionsMessage").textContent = error.message;
      }
    }

    async function deleteAgentAction(id) {
      if (!confirm("Se eliminara esta propuesta pendiente del agente. No se borran tareas, proyectos ni datos reales. ¿Continuar?")) return;
      try {
        await api("/api/agent/actions", { method: "POST", body: JSON.stringify({ action: "delete", data: { id_propuesta: id } }) });
        agentActionsLoaded = false;
        await loadAgentActions(true);
      } catch (error) {
        if ($("agentActionsMessage")) $("agentActionsMessage").textContent = error.message;
      }
    }

    function renderAgentDecision(response) {
      const container = $("agentResult");
      if (!container) return;
      const confidence = Math.round((response.confidence || 0) * 100);
      const targetLabel = response.intent === "accion"
        ? "Ver propuesta en Entrada inteligente"
        : response.intent === "lote"
          ? "Ver lote preparado"
          : response.intent === "informe"
            ? "Ver propuesta de informe"
          : response.intent === "email"
            ? "Ver borrador de email"
          : "";
      container.innerHTML = '<div class="agentDecision">' +
        '<div class="agentDecisionHead"><h3>' + html(agentIntentLabel(response.intent)) + '</h3><span class="confidence">Confianza: ' + html(confidence) + '%</span></div>' +
        '<p>' + html(response.message || response.reason || "") + '</p>' +
        (response.reason ? '<div class="line muted">' + html(response.reason) + '</div>' : '') +
        (response.conversation_context?.used ? '<div class="answerNote">Se ha usado contexto reciente de esta conversacion para interpretar el mensaje.</div>' : '') +
        (response.context_warning ? '<div class="dangerText">' + html(response.context_warning) + '</div>' : '') +
        (response.action_warning ? '<div class="dangerText">' + html(response.action_warning) + '</div>' : '') +
        (response.action_center_id ? '<div class="answerNote">Propuesta guardada en el centro de acciones con ID ' + html(response.action_center_id) + '.</div>' : '') +
        renderSelectedAgentTool(response.selected_tool) +
        renderAgentGuidance(response.guidance) +
        (targetLabel ? '<div class="toolbar"><button id="agentOpenPrepared" class="ghost">' + html(targetLabel) + '</button></div>' : '') +
        (response.intent === "consulta" ? '<div id="agentQueryPreview"></div>' : '') +
        (response.intent === "informe" ? '<div id="agentReportPreview"></div>' : '') +
        (response.intent === "email" ? '<div id="agentEmailPreview"></div>' : '') +
        (response.intent === "aclaracion" && (response.questions || []).length ? '<div class="detailBox"><strong>Para seguir</strong>' + response.questions.map(q => '<div>- ' + html(q) + '</div>').join("") + '</div>' : '') +
      '</div>';
      if (response.intent === "consulta" && response.result) {
        renderAiProposal(response.result, "agentQueryPreview");
      }
      if (response.intent === "informe" && response.result) {
        agentReportProposal = response.result;
        renderAgentReportProposal(response.result, "agentReportPreview");
      }
      if (response.intent === "email" && response.result) {
        renderAgentEmailDraft(response.result, "agentEmailPreview");
      }
      if ($("agentOpenPrepared")) {
        $("agentOpenPrepared").addEventListener("click", () => {
          const target = response.intent === "lote" ? $("aiBatchResult") : response.intent === "informe" ? $("agentReportPreview") : response.intent === "email" ? $("agentEmailPreview") : $("aiOperationResult");
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      }
    }

    function renderCopilotResponse(response) {
      const result = response?.result || {};
      const guidance = response?.guidance || {};
      const answer = result.answer || response.message || "Respuesta preparada.";
      const confidence = Math.round((response.confidence || result.confidence || 0) * 100);
      const actionable = ["accion", "lote", "informe", "email"].includes(response.intent);
      $("copilotResult").innerHTML =
        '<div class="answerHero"><h3>' + html(agentIntentLabel(response.intent)) + '</h3><p>' + html(answer) + '</p></div>' +
        '<div class="meta"><span class="pill">Confianza ' + html(confidence) + '%</span><span class="pill">' + html(actionable ? "Revisable" : "Solo lectura") + '</span>' + (result.data_status ? '<span class="pill">' + html(agentDataStatusLabel(result.data_status)) + '</span>' : '') + '</div>' +
        (response.message && response.message !== answer ? '<div class="line">' + html(response.message) + '</div>' : '') +
        (result.freshness?.summary ? '<div class="answerNote">' + html(result.freshness.summary) + '</div>' : '') +
        renderAgentGuidance(guidance) +
        '<div class="copilotResultActions">' +
          '<button class="ghost" id="copyCopilotAnswer">Copiar respuesta</button>' +
          (actionable ? '<button class="green" id="sendCopilotToCenter">Revisar en Centro IA</button>' : '<button class="ghost" id="sendCopilotToCenter">Abrir Centro IA</button>') +
        '</div>';
      $("copyCopilotAnswer").addEventListener("click", () => copyTextToClipboard(answer, "copilotMessage"));
      $("sendCopilotToCenter").addEventListener("click", () => {
        const original = safe($("copilotText").value);
        closeCopilot();
        switchView("ai");
        setTimeout(() => openCopilotResultInCenter(response, original), 60);
      });
    }

    function openCopilotResultInCenter(response, originalText) {
      if ($("agentText")) $("agentText").value = originalText || "";
      if (response?.intent === "accion") {
        aiProposal = response.result;
        if ($("aiText")) $("aiText").value = originalText || "";
        if ($("aiMessage")) $("aiMessage").textContent = "Propuesta cargada desde Copiloto IA.";
        renderAiProposal(aiProposal, "aiOperationResult");
      } else if (response?.intent === "lote") {
        aiBatch = response.result;
        if ($("aiBatchText")) $("aiBatchText").value = originalText || "";
        if ($("aiBatchMessage")) $("aiBatchMessage").textContent = "Lote cargado desde Copiloto IA.";
        renderAiBatch();
      } else if (response?.intent === "consulta") {
        if ($("aiQueryText")) $("aiQueryText").value = originalText || "";
        renderAiProposal(response.result || {}, "aiQueryResult");
      } else if (response?.intent === "email") {
        renderAgentEmailDraft(response.result || {}, "agentResult");
      } else if (response?.intent === "informe") {
        agentReportProposal = response.result;
        renderAgentReportProposal(response.result || {}, "agentResult");
      } else {
        renderAgentDecision(response);
      }
      $("agentText")?.focus();
    }

    async function askCopilot() {
      if (!safe($("copilotText").value)) {
        $("copilotMessage").textContent = "Escribe primero que necesitas.";
        return;
      }
      $("copilotSend").disabled = true;
      $("copilotMessage").textContent = "Analizando con contexto...";
      $("copilotResult").innerHTML = "";
      try {
        if (!options.responsables.length) await loadOptions();
        const response = await api("/api/agent/message", { method: "POST", body: JSON.stringify({ text: copilotContextualText() }) });
        $("copilotMessage").textContent = response.message || "Respuesta preparada.";
        agentContextLoaded = false;
        agentActionsLoaded = false;
        renderCopilotResponse(response);
      } catch (error) {
        $("copilotMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      } finally {
        $("copilotSend").disabled = false;
      }
    }

    async function copyTextToClipboard(text, messageId) {
      try {
        await navigator.clipboard.writeText(text || "");
        if ($(messageId)) $(messageId).textContent = "Copiado.";
      } catch {
        if ($(messageId)) $(messageId).textContent = "No se pudo copiar automaticamente.";
      }
    }

    function renderAgentEmailDraft(proposal, resultId = "agentEmailPreview") {
      const container = $(resultId);
      if (!container) return;
      const payload = proposal.payload || {};
      container.innerHTML = '<div class="proposal agentEmailBox">' +
        '<div class="proposalHead"><h2>Borrador de email</h2><span class="confidence">Sin envio</span></div>' +
        '<p>' + html(proposal.answer || "Borrador preparado para revisar.") + '</p>' +
        '<div class="detailBox"><strong>Modo propuesta</strong><div>No se ha enviado nada y no se ha creado ningun borrador en Outlook. Revisa, ajusta y copia el texto.</div></div>' +
        (proposal.freshness?.summary ? '<div class="answerNote"><strong>Vigencia de datos</strong><div>' + html(proposal.freshness.summary) + '</div></div>' : '') +
        '<div class="formGrid">' +
          '<div><label>Para</label><input id="agentEmailTo" value="' + html(payload.to || "") + '" placeholder="Completar destinatario..." /></div>' +
          '<div><label>Destinatario</label><input id="agentEmailName" value="' + html(payload.recipient_name || "") + '" /></div>' +
        '</div>' +
        '<label>Asunto</label><input id="agentEmailSubject" value="' + html(payload.subject || "") + '" />' +
        '<label>Cuerpo del email</label><textarea id="agentEmailBody" style="min-height:360px">' + html(payload.body || "") + '</textarea>' +
        renderAiEvidence(proposal) +
        '<div class="toolbar"><button class="green" id="copyAgentEmailBody">Copiar cuerpo</button><button class="ghost" id="copyAgentEmailAll">Copiar email completo</button><span class="muted" id="agentEmailMessage"></span></div>' +
      '</div>';
      $("copyAgentEmailBody").addEventListener("click", () => copyTextToClipboard($("agentEmailBody").value, "agentEmailMessage"));
      $("copyAgentEmailAll").addEventListener("click", () => {
        const lines = [
          $("agentEmailTo").value ? "Para: " + $("agentEmailTo").value : "",
          "Asunto: " + $("agentEmailSubject").value,
          "",
          $("agentEmailBody").value,
        ].filter((line, index) => index === 2 || safe(line));
        copyTextToClipboard(lines.join("\\n"), "agentEmailMessage");
      });
    }

    function renderAgentReportProposal(proposal, resultId = "agentReportPreview") {
      const container = $(resultId);
      if (!container) return;
      const payload = proposal.payload || {};
      const candidates = proposal.candidates || [];
      const selectedValue = payload.type && payload.id ? payload.type + ":" + payload.id : (candidates[0] ? candidates[0].type + ":" + candidates[0].id : "");
      const rows = payload.id
        ? [payload].concat(candidates.filter(candidate => String(candidate.type + ":" + candidate.id) !== selectedValue))
        : candidates;
      const uniqueRows = [];
      const seen = new Set();
      rows.forEach(row => {
        const value = row.type + ":" + row.id;
        if (!row.type || !row.id || seen.has(value)) return;
        seen.add(value);
        uniqueRows.push(row);
      });
      const optionsHtml = uniqueRows.length
        ? uniqueRows.map(row => {
            const value = row.type + ":" + row.id;
            const label = (row.type === "task" ? "Tarea" : "Proyecto") + " " + row.id + " - " + (row.title || "") + (row.comunidad ? " | " + row.comunidad : "");
            return '<option value="' + html(value) + '"' + (value === selectedValue ? " selected" : "") + '>' + html(label) + '</option>';
          }).join("")
        : '<option value="">Sin candidatos</option>';
      container.innerHTML = '<div class="proposal agentReportBox">' +
        '<div class="proposalHead"><h2>Informe Word preparado</h2><span class="confidence">Confirmacion necesaria</span></div>' +
        '<p>' + html(proposal.answer || "Selecciona el elemento exacto antes de generar el informe.") + '</p>' +
        (proposal.impact_summary ? '<div class="detailBox"><strong>Impacto previsto</strong>' + (proposal.impact_summary.lines || []).map(line => '<div>- ' + html(line) + '</div>').join("") + '</div>' : '') +
        '<div class="formGrid">' +
          '<div><label>Tarea o proyecto</label><select id="agentReportEntity">' + optionsHtml + '</select></div>' +
        '</div>' +
        '<div class="detailBox"><strong>Seguridad</strong><div>Nada se ha generado todavia. El Word se creara solo al pulsar el boton verde.</div></div>' +
        '<div class="toolbar"><button class="green" id="agentGenerateReport">Generar y abrir Word</button><span class="muted" id="agentReportMessage"></span></div>' +
      '</div>';
      const button = $("agentGenerateReport");
      if (button) {
        button.disabled = !uniqueRows.length;
        button.addEventListener("click", generateAgentPreparedReport);
      }
    }

    async function generateAgentPreparedReport() {
      const value = $("agentReportEntity")?.value || "";
      const [type, id] = value.split(":");
      if (!["task", "project"].includes(type) || !id) {
        $("agentReportMessage").textContent = "Selecciona una tarea o proyecto valido.";
        return;
      }
      const selectedText = $("agentReportEntity")?.selectedOptions?.[0]?.textContent || "el elemento seleccionado";
      if (!confirm("Se generara un informe Word de " + selectedText + ". ¿Confirmas?")) return;
      $("agentGenerateReport").disabled = true;
      $("agentReportMessage").textContent = "Generando informe...";
      try {
        const result = await api("/api/report/generate", { method: "POST", body: JSON.stringify({ type, id }) });
        $("agentReportMessage").textContent = "Informe generado.";
        if (typeof loadReportsCenter === "function") {
          reportsCenter.loaded = false;
          await loadReportsCenter(true);
        }
        window.open("/api/report/download?id=" + encodeURIComponent(result.report_id) + "&inline=1", "_blank");
      } catch (error) {
        $("agentReportMessage").textContent = error.message;
      } finally {
        $("agentGenerateReport").disabled = false;
      }
    }

    async function askAgent() {
      const text = $("agentText").value;
      if (!safe(text)) {
        $("agentMessage").textContent = "Escribe primero una consulta o instruccion.";
        return;
      }
      $("agentSend").disabled = true;
      $("agentMessage").textContent = "Analizando intencion...";
      $("agentResult").innerHTML = "";
      try {
        if (!options.responsables.length) await loadOptions();
        const response = await api("/api/agent/message", { method: "POST", body: JSON.stringify({ text }) });
        $("agentMessage").textContent = response.message || "Respuesta preparada.";
        if (Array.isArray(response.available_tools)) {
          agentTools = response.available_tools;
          agentToolsLoaded = true;
          renderAgentTools();
        }
        if (response.intent === "accion") {
          aiProposal = response.result;
          $("aiText").value = text;
          $("aiMessage").textContent = response.result?.queryDetected ? "No se ha preparado ningun cambio." : "Propuesta generada desde Agente IA.";
          renderAiProposal(aiProposal, "aiOperationResult");
        } else if (response.intent === "lote") {
          aiBatch = response.result;
          $("aiBatchText").value = text;
          $("aiBatchMessage").textContent = "Lote generado desde Agente IA.";
          renderAiBatch();
        } else if (response.intent === "informe") {
          agentReportProposal = response.result;
        } else if (response.intent === "consulta" && response.result?.history_id) {
          aiHistoryLoaded = false;
          await loadAiHistory(true, response.result.history_id || 0);
        }
        agentContextLoaded = false;
        agentActionsLoaded = false;
        await loadAgentContext(true);
        await loadAgentActions(true);
        renderAgentDecision(response);
      } catch (error) {
        $("agentMessage").textContent = error.message;
      } finally {
        $("agentSend").disabled = false;
      }
    }

    async function askAiQuery() {
      const text = $("aiQueryText").value;
      if (!safe(text)) {
        $("aiQueryMessage").textContent = "Escribe primero una pregunta.";
        return;
      }
      $("aiAsk").disabled = true;
      $("aiQueryMessage").textContent = "Consultando datos...";
      $("aiQueryResult").innerHTML = "";
      try {
        const response = await api("/api/ai/query", { method: "POST", body: JSON.stringify({ text }) });
        $("aiQueryMessage").textContent = "Respuesta generada y guardada en tu historial.";
        renderAiProposal(response, "aiQueryResult");
        aiHistoryLoaded = false;
        await loadAiHistory(true, response.history_id || 0);
      } catch (error) {
        $("aiQueryMessage").textContent = error.message;
      } finally {
        $("aiAsk").disabled = false;
      }
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
      const tables = (display.tables || []).map((table, tableIndex) => {
        const columns = table.columns || [];
        const rows = table.rows || [];
        const visibleRows = rows.slice(0, 250);
        const tableHtml = '<table class="answerTable"><thead><tr>' + columns.map(col => '<th>' + html(col) + '</th>').join("") + '</tr></thead>' +
          '<tbody>' + visibleRows.map(row => '<tr>' + columns.map(col => '<td data-label="' + html(col) + '">' + html(row[col] || "") + '</td>').join("") + '</tr>').join("") + '</tbody></table>' +
        '';
        const tools = '<div class="answerTableTools"><span class="muted">' + html(rows.length > visibleRows.length ? "Mostrando 250 de " + rows.length + " filas" : rows.length + " filas") + '</span><button class="ghost" type="button" data-answer-export="' + tableIndex + '">Descargar CSV</button></div>';
        if (rows.length > 12) {
          return '<details class="answerTableWrap"><summary><h3>' + html(table.title || "Detalle") + '</h3><span class="pill">' + html(rows.length) + ' filas</span></summary>' + tools + tableHtml + '</details>';
        }
        return '<div class="answerTableWrap"><h3>' + html(table.title || "Detalle") + '</h3>' + tools + tableHtml + '</div>';
      }).join("");
      return '<div class="answerView">' +
        ((display.title || display.subtitle) ? '<div class="answerHero"><h3>' + html(display.title || "Respuesta") + '</h3>' + (display.subtitle ? '<p>' + html(display.subtitle) + '</p>' : '') + '</div>' : '') +
        cards +
        tables +
        (display.note ? '<div class="answerNote">' + html(display.note) + '</div>' : '') +
      '</div>';
    }

    function renderAiEvidence(proposal) {
      const status = proposal.data_status || "";
      const statusLabel = { confirmado: "Dato confirmado", inferido: "Dato inferido", incompleto: "Dato incompleto" }[status] || status;
      const domain = proposal.query_domain || "";
      const domainLabel = {
        propietarios_contacto: "Propietarios / contacto",
        propiedad: "Propiedad",
        deuda: "Deuda",
        contabilidad: "Contabilidad",
        presupuesto: "Presupuesto",
        trabajo: "Tareas / proyectos",
        asambleas: "Asambleas",
        seguridad: "Seguridad",
        documentos_informes: "Documentos / informes",
        general: "General",
      }[domain] || domain;
      const sources = proposal.sources || [];
      const freshness = proposal.freshness || null;
      if (!statusLabel && !domainLabel && !sources.length && !freshness) return "";
      const freshnessHtml = freshness?.summary
        ? '<div class="answerNote"><strong>Vigencia de datos</strong><div>' + html(freshness.summary) + '</div>' + (freshness.detail_text ? '<div class="muted">' + html(freshness.detail_text) + '</div>' : '') + '</div>'
        : "";
      const sourcesHtml = sources.length
        ? '<div><strong>Fuentes internas</strong>' + sources.map(source =>
            '<div class="line"><span class="pill">' + html(source.module || "fuente") + '</span> ' +
            html((source.table || "") + (source.description ? " - " + source.description : "") + (source.freshness ? " | " + source.freshness : "")) + '</div>'
          ).join("") + '</div>'
        : "";
      return '<div class="detailBox">' +
        (domainLabel ? '<div><strong>Dominio detectado:</strong> ' + html(domainLabel) + '</div>' : '') +
        (statusLabel ? '<div><strong>Estado del dato:</strong> ' + html(statusLabel) + '</div>' : '') +
        freshnessHtml +
        sourcesHtml +
      '</div>';
    }

    function downloadAnswerTable(display, tableIndex) {
      const table = (display?.tables || [])[Number(tableIndex)];
      if (!table) return;
      const columns = table.columns || [];
      const quote = value => {
        let text = String(value ?? "");
        if (/^[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
      };
      const lines = [
        columns.map(quote).join(";"),
        ...(table.rows || []).map(row => columns.map(column => quote(row[column])).join(";")),
      ];
      const blob = new Blob([String.fromCharCode(65279) + lines.join(String.fromCharCode(13, 10))], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const baseName = safe(table.title || "consulta").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "consulta";
      link.href = url;
      link.download = baseName + ".csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function bindAnswerTableExports(display, container) {
      if (!container) return;
      container.querySelectorAll("[data-answer-export]").forEach(button => button.addEventListener("click", () => downloadAnswerTable(display, button.dataset.answerExport)));
    }

    function aiPreviewInputValue(field) {
      const fieldInputs = {
        Titulo: "aiTitle",
        Categoria: "aiCategory",
        Estado: "aiState",
        Prioridad: "aiPriority",
        "Responsable actual": "aiOwner",
        "Responsable proximo paso": "aiNextOwner",
        "Fecha proximo paso": "aiNextDate",
        "Proximo paso": "aiNextStep",
      };
      const id = fieldInputs[field];
      if (!id || !$(id)) return null;
      return safe($(id).value) || "-";
    }

    function bindAiBeforeAfterPreview(container) {
      if (!container) return;
      const update = () => {
        container.querySelectorAll("[data-ai-after]").forEach(cell => {
          const value = aiPreviewInputValue(cell.dataset.aiAfter);
          if (value !== null) cell.textContent = value;
        });
      };
      ["aiTitle", "aiCategory", "aiState", "aiPriority", "aiOwner", "aiNextOwner", "aiNextDate", "aiNextStep"].forEach(id => {
        if ($(id)) {
          $(id).addEventListener("input", update);
          $(id).addEventListener("change", update);
        }
      });
      update();
    }

    function renderAiProposal(proposal, resultId = "aiOperationResult") {
      const resultContainer = $(resultId);
      if (!resultContainer) return;
      const payload = proposal.payload || {};
      const entityType = proposal.entity?.type || (proposal.action === "seguimiento_tarea" ? "task" : "project");
      const entityId = proposal.entity?.id || "";
      const states = entityType === "task" ? options.estados_tarea : options.estados_proyecto;
      const understandingHtml = renderProposalUnderstanding(proposal);
      const candidateSelectorHtml = renderCandidateSelector(proposal);
      const candidatesTextHtml = (proposal.candidates || []).length
        ? '<div class="detailBox"><strong>Candidatos detectados</strong>' + proposal.candidates.map(c => '<div>' + html(proposalEntityLabel(c.type) + " " + c.id + " - " + c.title + (c.score !== undefined ? " | score " + c.score : "")) + '</div>').join("") + '</div>'
        : "";
      const questionsHtml = (proposal.questions || []).length
        ? '<div class="detailBox"><strong>Necesito aclarar</strong>' + proposal.questions.map(q => '<div>- ' + html(q) + '</div>').join("") + '</div>'
        : "";
      const actionContractHtml = proposal.requires_confirmation
        ? '<div class="detailBox"><strong>Confirmacion necesaria</strong><div>' + html(proposal.confirmation_required_message || "Nada se ha guardado todavia. Revisa la propuesta antes de aplicarla.") + '</div><div class="muted">La escritura se hara solo desde ' + html(proposal.allowed_write_endpoint || "el endpoint permitido") + ' despues de confirmar.</div></div>'
        : "";
      const impactHtml = proposal.impact_summary
        ? '<div class="detailBox"><strong>Impacto previsto</strong><div>' + html(proposal.impact_summary.title || "") + '</div>' + (proposal.impact_summary.lines || []).map(line => '<div>- ' + html(line) + '</div>').join("") + '</div>'
        : "";
      const beforeAfterHtml = proposal.before_after_preview
        ? '<div class="detailBox"><strong>Antes / despues</strong><div class="muted">' + html(proposal.before_after_preview.mode === "create" ? "Elemento nuevo. No existe valor anterior." : proposal.before_after_preview.title || "Elemento existente") + '</div><table class="answerTable"><thead><tr><th>Campo</th><th>Actual</th><th>Propuesto</th></tr></thead><tbody>' + (proposal.before_after_preview.rows || []).map(row => '<tr><td>' + html(row.field) + '</td><td>' + html(row.before) + '</td><td data-ai-after="' + html(row.field) + '">' + html(row.after) + '</td></tr>').join("") + '</tbody></table></div>'
        : "";
      const usedRulesHtml = (proposal.used_rules || []).length
        ? '<div class="detailBox aiMemoryApplied"><strong>Memoria aplicada</strong>' + proposal.used_rules.map(rule => '<div>- ' + html(ruleTypeLabel(rule.tipo_regla)) + ' | confianza ' + html(Math.round((rule.confianza || 0) * 100)) + '%</div>').join("") + '</div>'
        : "";
      if (proposal.queryDetected) {
        resultContainer.innerHTML = '<div class="proposal">' +
          '<div class="proposalHead"><h2>Esto parece una consulta</h2><span class="pill">Sin cambios</span></div>' +
          '<p>' + html(proposal.answer || "Utiliza la caja Consultas IA.") + '</p>' +
          '<div class="toolbar"><button id="moveToAiQuery">Mover a Consultas IA</button></div>' +
        '</div>';
        $("moveToAiQuery").addEventListener("click", () => {
          $("aiQueryText").value = $("aiText").value;
          $("aiText").value = "";
          resultContainer.innerHTML = "";
          $("aiMessage").textContent = "";
          $("aiQueryText").focus();
          $("aiQueryText").scrollIntoView({ behavior: "smooth", block: "center" });
        });
        return;
      }
      if (proposal.action === "consulta" && !payload.comentario && !payload.titulo) {
        const displayHtml = renderDisplay(proposal.display || {});
        const evidenceHtml = renderAiEvidence(proposal);
        const copyButtonId = resultId + "CopyAnswer";
        const copyMessageId = resultId + "CopyMessage";
        resultContainer.innerHTML = '<div class="proposal">' +
          '<div class="proposalHead"><h2>Respuesta de consulta</h2><span class="confidence">Confianza: ' + html(Math.round((proposal.confidence || 0) * 100)) + '%</span></div>' +
          (proposal.warning ? '<p class="dangerText">' + html(proposal.warning) + '</p>' : '') +
          displayHtml +
          evidenceHtml +
          (proposal.answer ? '<details class="detailBox"><summary><strong>Ver respuesta en texto</strong></summary><pre style="white-space:pre-wrap;margin:8px 0 0">' + html(proposal.answer) + '</pre></details>' : '') +
          questionsHtml +
          candidatesTextHtml +
          (proposal.answer ? '<div class="toolbar"><button class="ghost" id="' + copyButtonId + '">Copiar respuesta</button><span class="muted" id="' + copyMessageId + '"></span></div>' : '') +
        '</div>';
        bindAnswerTableExports(proposal.display || {}, resultContainer);
        if ($(copyButtonId)) {
          $(copyButtonId).addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(proposal.answer || "");
              $(copyMessageId).textContent = "Copiado.";
            } catch {
              $(copyMessageId).textContent = "No se pudo copiar automaticamente.";
            }
          });
        }
        return;
      }
      resultContainer.innerHTML = '<div class="proposal">' +
        '<div class="proposalHead"><h2>Propuesta revisable</h2><span class="confidence">Confianza: ' + html(Math.round((proposal.confidence || 0) * 100)) + '%</span></div>' +
        (proposal.warning ? '<p class="dangerText">' + html(proposal.warning) + '</p>' : '') +
        understandingHtml +
        actionContractHtml +
        impactHtml +
        beforeAfterHtml +
        usedRulesHtml +
        (proposal.answer ? '<div class="detailBox"><strong>Respuesta / lectura</strong><pre style="white-space:pre-wrap;margin:0">' + html(proposal.answer) + '</pre></div>' : '') +
        questionsHtml +
        candidateSelectorHtml +
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
        '<label class="checkLine"><input type="checkbox" id="aiLearnCorrections" checked /> Aprender de mis correcciones de titulo, comentario y proximo paso</label>' +
        '<div class="toolbar"><button class="green" id="aiApply">Aplicar propuesta</button><span class="muted" id="aiApplyMessage"></span></div>' +
      '</div>';
      $("aiApply").addEventListener("click", applyAiProposal);
      $("aiAction").addEventListener("change", () => {
        const action = $("aiAction").value;
        const kind = action.includes("tarea") ? "task" : "project";
        $("aiEntity").innerHTML = entityOptionsHtml(kind, "");
      });
      bindCandidateSelector(resultContainer);
      bindAiBeforeAfterPreview(resultContainer);
    }

    async function analyzeAiText() {
      const text = $("aiText").value;
      if (!safe(text)) {
        $("aiMessage").textContent = "Pega primero un texto.";
        return;
      }
      $("aiMessage").textContent = "Analizando...";
      $("aiOperationResult").innerHTML = "";
      $("aiAnalyze").disabled = true;
      try {
        if (!options.responsables.length) await loadOptions();
        aiProposal = await api("/api/ai/operate", { method: "POST", body: JSON.stringify({ text }) });
        $("aiMessage").textContent = aiProposal.queryDetected
          ? "No se ha preparado ningun cambio."
          : "Propuesta generada. Revisala antes de aplicar.";
        renderAiProposal(aiProposal, "aiOperationResult");
      } catch (error) {
        $("aiMessage").textContent = error.message;
      } finally {
        $("aiAnalyze").disabled = false;
      }
    }

    function aiBatchFieldId(index, field) {
      return "aiBatch_" + index + "_" + field;
    }

    function aiBatchActionEntityType(action, fallback = "project") {
      if (String(action || "").includes("tarea")) return "task";
      if (String(action || "").includes("proyecto")) return "project";
      return fallback;
    }

    function renderAiBatchProposal(proposal, index) {
      const payload = proposal.payload || {};
      const action = proposal.action || "revisar_manual";
      const entityType = proposal.entity?.type || aiBatchActionEntityType(action);
      const states = entityType === "task" ? options.estados_tarea : options.estados_proyecto;
      const selected = proposal.selected !== false && proposal.requires_confirmation;
      const blocked = proposal.action === "consulta" || proposal.action === "fuera_de_alcance" ? " disabled" : "";
      const sourcePreview = safe(proposal.source_text || "");
      const shortSource = sourcePreview.length > 360 ? sourcePreview.slice(0, 357) + "..." : sourcePreview;
      const meetingHtml = proposal.meeting_analysis
        ? '<div class="detailBox"><strong>Asunto detectado de reunion</strong><div>Regla aplicada: se prioriza seguimiento de tarea/proyecto existente. Si no hay destino claro, queda desmarcado para aclarar o convertir manualmente.</div>' +
          (proposal.meeting_decision_detected ? '<div><span class="pill">Decision explicita detectada</span></div>' : '') +
          (proposal.meeting_source_excerpt ? '<details><summary><strong>Fragmento fuente</strong></summary><pre style="white-space:pre-wrap;margin:8px 0 0">' + html(proposal.meeting_source_excerpt) + '</pre></details>' : '') +
        '</div>'
        : "";
      return '<article class="aiBatchCard' + (selected ? '' : ' disabled') + '" data-ai-batch-card="' + index + '">' +
        '<div class="aiBatchHead">' +
          '<div><h3>Propuesta ' + html(index + 1) + ': ' + html(payload.titulo || proposal.entity?.title || action) + '</h3><p class="muted">' + html(shortSource) + '</p></div>' +
          '<label class="checkLine"><input type="checkbox" data-ai-batch-selected="' + index + '"' + (selected ? " checked" : "") + blocked + ' /> Aplicar</label>' +
        '</div>' +
        meetingHtml +
        (proposal.queryDetected ? '<div class="detailBox"><strong>Sin accion</strong>' + html(proposal.answer || "Parece una consulta.") + '</div>' : '') +
        ((proposal.used_rules || []).length ? '<div class="detailBox aiMemoryApplied"><strong>Memoria aplicada</strong>' + proposal.used_rules.map(rule => '<div>- ' + html(ruleTypeLabel(rule.tipo_regla)) + '</div>').join("") + '</div>' : '') +
        '<div class="formGrid">' +
          '<div><label>Accion</label><select id="' + aiBatchFieldId(index, "action") + '">' + proposalActionOptions(action) + '</select></div>' +
          '<div><label>Elemento existente</label><select id="' + aiBatchFieldId(index, "entity") + '">' + entityOptionsHtml(entityType, proposal.entity?.id || "") + '</select></div>' +
          '<div><label>Proyecto contenedor</label><select id="' + aiBatchFieldId(index, "project") + '">' + projectContainerOptions(payload.id_proyecto) + '</select></div>' +
          '<div><label>Titulo</label><input id="' + aiBatchFieldId(index, "title") + '" value="' + html(payload.titulo || proposal.entity?.title || "") + '" /></div>' +
          '<div><label>Categoria</label><input id="' + aiBatchFieldId(index, "category") + '" value="' + html(payload.categoria || "General") + '" /></div>' +
          '<div><label>Estado</label><select id="' + aiBatchFieldId(index, "state") + '">' + (states || []).map(v => '<option value="' + html(v) + '"' + (v === payload.estado_nuevo ? " selected" : "") + '>' + html(v) + '</option>').join("") + '</select></div>' +
          '<div><label>Prioridad</label><select id="' + aiBatchFieldId(index, "priority") + '">' + (options.prioridades || []).map(v => '<option value="' + html(v) + '"' + (v === payload.prioridad_nueva ? " selected" : "") + '>' + html(v) + '</option>').join("") + '</select></div>' +
          '<div><label>Responsable</label><input id="' + aiBatchFieldId(index, "owner") + '" list="responsiblesList" value="' + html(payload.responsable_nuevo || "") + '" /></div>' +
          '<div><label>Proximo responsable</label><input id="' + aiBatchFieldId(index, "nextOwner") + '" list="responsiblesList" value="' + html(payload.responsable_proximo_paso || "") + '" /></div>' +
          '<div><label>Fecha proximo paso</label><input id="' + aiBatchFieldId(index, "nextDate") + '" type="date" value="' + html((payload.fecha_objetivo_proximo_paso || "").slice(0, 10)) + '" /></div>' +
        '</div>' +
        '<label>Comentario</label><textarea id="' + aiBatchFieldId(index, "comment") + '">' + html(payload.comentario || "") + '</textarea>' +
        '<label>Proximo paso</label><textarea id="' + aiBatchFieldId(index, "nextStep") + '">' + html(payload.proximo_paso || "") + '</textarea>' +
        '<label>Motivo bloqueo</label><textarea id="' + aiBatchFieldId(index, "blockReason") + '">' + html(payload.motivo_bloqueo || "") + '</textarea>' +
        '<div class="muted" id="' + aiBatchFieldId(index, "message") + '"></div>' +
      '</article>';
    }

    function renderAiBatch() {
      const container = $("aiBatchResult");
      if (!container || !aiBatch) return;
      const proposals = aiBatch.proposals || [];
      const meetingNote = aiBatch.batch_mode === "long_meeting_transcript"
        ? '<div class="answerNote"><strong>Reunion larga detectada</strong><div>La transcripcion se ha dividido por asuntos. Revisa cada tarjeta: las dudosas quedan desmarcadas y se pueden convertir manualmente en seguimiento, tarea o proyecto.</div></div>'
        : "";
      container.innerHTML = '<div class="proposal">' +
        '<div class="proposalHead"><h2>Lote preparado</h2><span class="confidence">' + html(aiBatch.actionable || 0) + ' accion(es) aplicables de ' + html(aiBatch.total || proposals.length) + '</span></div>' +
        meetingNote +
        '<div class="detailBox"><strong>Confirmacion necesaria</strong>Nada se ha guardado todavia. Revisa cada tarjeta y deja marcadas solo las que quieras aplicar.</div>' +
        '<label class="checkLine"><input type="checkbox" id="aiBatchLearnCorrections" checked /> Aprender de las correcciones del lote</label>' +
        '<div class="toolbar"><button class="green" id="aiBatchApply">Aplicar seleccionadas</button><span class="muted" id="aiBatchApplyMessage"></span></div>' +
        '<div class="aiBatchList">' + proposals.map(renderAiBatchProposal).join("") + '</div>' +
      '</div>';
      document.querySelectorAll("[data-ai-batch-selected]").forEach(input => input.addEventListener("change", event => {
        event.target.closest(".aiBatchCard").classList.toggle("disabled", !event.target.checked);
      }));
      proposals.forEach((_proposal, index) => {
        const actionSelect = $(aiBatchFieldId(index, "action"));
        if (actionSelect) actionSelect.addEventListener("change", () => {
          const kind = aiBatchActionEntityType(actionSelect.value);
          const entitySelect = $(aiBatchFieldId(index, "entity"));
          if (entitySelect) entitySelect.innerHTML = entityOptionsHtml(kind, "");
        });
      });
      $("aiBatchApply").addEventListener("click", applyAiBatch);
    }

    function collectAiBatchItem(index) {
      const action = $(aiBatchFieldId(index, "action")).value;
      const payload = {
        titulo: $(aiBatchFieldId(index, "title")).value,
        categoria: $(aiBatchFieldId(index, "category")).value,
        tipo_registro: "Seguimiento",
        estado_nuevo: $(aiBatchFieldId(index, "state")).value,
        prioridad_nueva: $(aiBatchFieldId(index, "priority")).value,
        responsable_nuevo: $(aiBatchFieldId(index, "owner")).value,
        responsable_proximo_paso: $(aiBatchFieldId(index, "nextOwner")).value,
        fecha_objetivo_proximo_paso: $(aiBatchFieldId(index, "nextDate")).value,
        fecha_proxima_revision: $(aiBatchFieldId(index, "nextDate")).value,
        comentario: $(aiBatchFieldId(index, "comment")).value,
        proximo_paso: $(aiBatchFieldId(index, "nextStep")).value,
        motivo_bloqueo: $(aiBatchFieldId(index, "blockReason")).value,
        id_proyecto: $(aiBatchFieldId(index, "project")).value,
      };
      return {
        action,
        selected: document.querySelector('[data-ai-batch-selected="' + index + '"]')?.checked,
        entity_id: $(aiBatchFieldId(index, "entity")).value,
        payload,
      };
    }

    async function analyzeAiBatch() {
      const text = $("aiBatchText").value;
      if (!safe(text)) {
        $("aiBatchMessage").textContent = "Pega primero varios asuntos.";
        return;
      }
      $("aiBatchAnalyze").disabled = true;
      $("aiBatchMessage").textContent = "Preparando lote...";
      $("aiBatchResult").innerHTML = "";
      try {
        if (!options.responsables.length) await loadOptions();
        aiBatch = await api("/api/ai/batch-operate", { method: "POST", body: JSON.stringify({ text }) });
        $("aiBatchMessage").textContent = "Lote preparado. Revisa antes de aplicar.";
        renderAiBatch();
      } catch (error) {
        $("aiBatchMessage").textContent = error.message;
      } finally {
        $("aiBatchAnalyze").disabled = false;
      }
    }

    async function applyAiBatch() {
      if (!aiBatch?.proposals?.length) return;
      const selected = aiBatch.proposals
        .map((proposal, index) => ({ proposal, index, item: collectAiBatchItem(index) }))
        .filter(entry => entry.item.selected && !["consulta", "revisar_manual", "fuera_de_alcance"].includes(entry.item.action));
      if (!selected.length) {
        $("aiBatchApplyMessage").textContent = "No hay propuestas seleccionadas aplicables.";
        return;
      }
      if (!confirm("Se aplicaran " + selected.length + " propuesta(s) editadas. ¿Confirmas guardar el lote?")) return;
      $("aiBatchApply").disabled = true;
      $("aiBatchApplyMessage").textContent = "Aplicando lote...";
      let saved = 0;
      let failed = 0;
      for (const entry of selected) {
        const message = $(aiBatchFieldId(entry.index, "message"));
        try {
          let result;
          if (entry.item.action === "seguimiento_proyecto" || entry.item.action === "seguimiento_tarea") {
            const type = entry.item.action === "seguimiento_tarea" ? "task" : "project";
            if (!entry.item.entity_id) throw new Error("Selecciona el elemento existente.");
            result = await api("/api/entity/record", { method: "POST", body: JSON.stringify({ type, id: entry.item.entity_id, payload: entry.item.payload }) });
          } else {
            const type = entry.item.action === "crear_tarea" ? "task" : "project";
            result = await api("/api/entity/create", { method: "POST", body: JSON.stringify({ type, payload: entry.item.payload }) });
          }
          saved += 1;
          if (message) message.textContent = "Guardado correctamente.";
          if ($("aiBatchLearnCorrections")?.checked) {
            try {
              await api("/api/ai/rules/action", {
                method: "POST",
                body: JSON.stringify({
                  action: "learn_redaction",
                  data: {
                    action: entry.item.action,
                    source_text: entry.proposal.source_text || "",
                    original_payload: entry.proposal.payload || {},
                    final_payload: entry.item.payload,
                    entity: entry.proposal.entity || null,
                    origin: "automatizacion_guiada",
                  },
                }),
              });
            } catch {}
          }
          if (result?.type && result?.id) {
            aiBatch.proposals[entry.index].saved_result = result;
          }
        } catch (error) {
          failed += 1;
          if (message) message.innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
        }
      }
      aiRulesLoaded = false;
      await loadAiRules(true);
      await loadOverview();
      $("aiBatchApply").disabled = false;
      $("aiBatchApplyMessage").textContent = "Lote finalizado. Guardadas: " + saved + ". Fallidas: " + failed + ".";
    }

    async function applyAiProposal() {
      const action = $("aiAction").value;
      const originalPayload = { ...(aiProposal?.payload || {}) };
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
        let memoryMessage = "";
        if ($("aiLearnCorrections")?.checked) {
          try {
            const learned = await api("/api/ai/rules/action", {
              method: "POST",
              body: JSON.stringify({
                action: "learn_redaction",
                data: {
                  action,
                  source_text: $("aiText").value,
                  original_payload: originalPayload,
                  final_payload: payload,
                  entity: aiProposal?.entity || null,
                  origin: "entrada_inteligente",
                },
              }),
            });
            if (learned.count) {
              memoryMessage = " Memoria actualizada con " + learned.count + " regla(s).";
              aiRulesLoaded = false;
              await loadAiRules(true);
            }
          } catch (memoryError) {
            memoryMessage = " No se pudo actualizar la memoria: " + memoryError.message;
          }
        }
        $("aiApplyMessage").textContent = "Guardado correctamente." + memoryMessage;
        await loadOverview();
        if (result?.type && result?.id) await openEntity(result.type, result.id, false);
      } catch (error) {
        $("aiApplyMessage").innerHTML = '<span class="dangerText">' + html(error.message) + '</span>';
      }
    }

    async function loadOverview() {
      $("sessionStatus").textContent = "Cargando datos...";
      try {
        const sessionInfo = await api("/api/me");
        if ((sessionInfo.usuario || {}).rol === "Seguridad") {
          await loadSecurityOnly(sessionInfo.usuario);
          return;
        }
        const firstSessionLoad = !state.usuario;
        const [data, workflow, daily, securityAccess] = await Promise.all([api("/api/overview"), api("/api/workflow"), api("/api/daily-operations"), api("/api/security/access")]);
        data.workflow = workflow;
        data.daily = daily;
        state = data;
        securityData.access = securityAccess;
        if (securityAccess.can_manage) await loadSecurityData(false);
        showApp();
        $("mobileMenuToggle").disabled = false;
        $("mobileMenuToggle").setAttribute("aria-label", "Abrir menu de navegacion");
        $("appView").classList.remove("security-only");
        $("counts").classList.remove("hidden");
        ["homeTab","projectTab","taskTab","assemblyTab","mapTab","workTab","reviewTab","globalSearchTab","documentsTab","reportsTab","importTab","notificationTab","aiTab"].forEach(id => $(id).classList.remove("hidden"));
        const user = data.usuario || {};
        const assignedCommunities = user.comunidades_asignadas || user.comunidades || [];
        const activeCommunities = user.comunidades || [];
        const scopeLabel = user.rol === "Superusuario" || user.alcance_comunidades !== "seleccion" ? "Todas mis comunidades" : (activeCommunities[0]?.nombre || "Sin comunidad");
        $("sessionStatus").innerHTML = html(user.nombre || "") + " - " + html(user.rol || "") + " - " + html(scopeLabel);
        $("changeCommunityTop").classList.toggle("hidden", user.rol === "Superusuario" || assignedCommunities.length <= 1);
        if (user.rol === "Presidente" && (firstSessionLoad || ["tasks", "assemblies", "review", "imports", "ai"].includes(currentView))) currentView = "work";
        if (currentView === "admin" && user.rol !== "Superusuario") currentView = user.rol === "Presidente" ? "work" : "home";
        $("taskTab").classList.toggle("hidden", user.rol === "Presidente");
        $("mapTab").classList.toggle("hidden", user.rol === "Presidente");
        $("assemblyTab").classList.toggle("hidden", user.rol === "Presidente");
        $("workTab").classList.toggle("hidden", user.rol !== "Presidente");
        $("reviewTab").classList.add("hidden");
        $("aiTab").classList.toggle("hidden", user.rol === "Presidente");
        $("reportsTab").classList.toggle("hidden", user.rol === "Presidente");
        $("importTab").classList.toggle("hidden", !canWrite());
        $("adminTab").classList.toggle("hidden", user.rol !== "Superusuario");
        $("securityTab").classList.toggle("hidden", !securityAccess.can_manage);
        $("securityTabCount").textContent = securityAccess.can_manage ? ((securityData.overview || {}).pending || 0) : 0;
        $("workTab").querySelector("span").textContent = user.rol === "Presidente" ? "Decisiones" : "Acciones";
        $("counts").innerHTML =
          countCard(user.rol === "Presidente" ? "Decisiones pendientes" : "Acciones pendientes", user.rol === "Presidente" ? workflow.president_requests.length : workflow.actions.length) +
          countCard("Alertas automaticas", automationInsights().filter(row => row.kind !== "success").length) +
          countCard("Notificaciones sin leer", workflow.unread_notifications || 0) +
          countCard("Proyectos activos", data.counts.proyectos_activos) +
          countCard("Tareas activas", data.counts.tareas_activas) +
          countCard("Necesitan accion", (daily.map.counts || {})["Necesita acción"] || 0) +
          countCard("Bloqueados / riesgo", (daily.map.counts || {})["Bloqueado / riesgo"] || 0);
        $("projectTabCount").textContent = data.proyectos.length;
        $("taskTabCount").textContent = data.tareas.length;
        $("assemblyTabCount").textContent = assembliesData.loaded ? assembliesData.assemblies.length : 0;
        $("workTabCount").textContent = user.rol === "Presidente" ? workflow.president_requests.length : workflow.actions.length;
        $("mapTabCount").textContent = (daily.map.items || []).length;
        $("reviewTabCount").textContent = (workflow.review.summary || {}).total || 0;
        $("documentsTabCount").textContent = (daily.documents || []).length;
        $("reportsTabCount").textContent = reportsCenter.loaded ? reportsCenter.reports.length : (daily.documents || []).filter(row => row.document_type === "report").length;
        $("notificationTabCount").textContent = workflow.unread_notifications || 0;
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
      if (view === "reports" && (state.usuario || {}).rol === "Presidente") view = "work";
      currentView = view;
      closeMobileDrawer();
      $("listFilters").classList.remove("mobile-open");
      document.querySelector(".sidebar")?.classList.remove("filters-open");
      $("mobileFiltersToggle").textContent = "Filtros";
      $("mobileFiltersToggle").setAttribute("aria-expanded", "false");
      $("search").value = "";
      $("stateFilter").value = "";
      $("communityFilter").value = "";
      $("priorityFilter").value = "";
      refreshFilterOptions();
      render();
      if (view === "reports" && !reportsCenter.loaded) loadReportsCenter();
      if (view === "assemblies" && !assembliesData.loaded) loadAssemblies();
      if (view === "admin" && !adminData.loaded) loadAdmin();
      if (view === "security" && (securityData.access || {}).can_manage && !securityData.overview) loadSecurityData();
    }

    $("homeTab").addEventListener("click", () => switchView("home"));
    $("projectTab").addEventListener("click", () => switchView("projects"));
    $("taskTab").addEventListener("click", () => switchView("tasks"));
    $("assemblyTab").addEventListener("click", () => switchView("assemblies"));
    $("securityTab").addEventListener("click", () => switchView("security"));
    $("mapTab").addEventListener("click", () => switchView("map"));
    $("workTab").addEventListener("click", () => switchView("work"));
    $("reviewTab").addEventListener("click", () => switchView("review"));
    $("globalSearchTab").addEventListener("click", () => switchView("global-search"));
    $("documentsTab").addEventListener("click", () => switchView("documents"));
    $("reportsTab").addEventListener("click", () => switchView("reports"));
    $("importTab").addEventListener("click", () => switchView("imports"));
    $("notificationTab").addEventListener("click", () => switchView("notifications"));
    $("aiTab").addEventListener("click", () => switchView("ai"));
    $("adminTab").addEventListener("click", () => switchView("admin"));
    $("mobileMenuToggle").addEventListener("click", openMobileDrawer);
    $("mobileDrawerClose").addEventListener("click", closeMobileDrawer);
    $("mobileDrawerBackdrop").addEventListener("click", closeMobileDrawer);
    $("mobileDrawerReload").addEventListener("click", () => { closeMobileDrawer(); loadOverview(); });
    $("mobileDrawerNav").addEventListener("click", event => {
      const button = event.target.closest("button[data-mobile-view]");
      if (button) switchView(button.dataset.mobileView);
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape") closeMobileDrawer(); });
    $("mobileFiltersToggle").addEventListener("click", () => {
      const filters = $("listFilters");
      const open = !filters.classList.contains("mobile-open");
      filters.classList.toggle("mobile-open", open);
      document.querySelector(".sidebar")?.classList.toggle("filters-open", open);
      $("mobileFiltersToggle").textContent = open ? "Ocultar" : "Filtros";
      $("mobileFiltersToggle").setAttribute("aria-expanded", String(open));
    });
    $("mobileReload").addEventListener("click", () => loadOverview());
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
      const mobileMore = event.target.closest("button[data-mobile-more]");
      if (mobileMore) {
        const key = mobileMore.dataset.mobileMore;
        const current = mobileVisibleLimits[key] || Number(mobileMore.dataset.step || 8);
        mobileVisibleLimits[key] = Math.min(Number(mobileMore.dataset.mobileTotal || current), current + Number(mobileMore.dataset.step || 8));
        render();
        return;
      }
      const homeView = event.target.closest("button[data-home-view]");
      if (homeView) { switchView(homeView.dataset.homeView); return; }
      const homeCreate = event.target.closest("button[data-home-create]");
      if (homeCreate) { openCreateModal(homeCreate.dataset.homeCreate).catch(error => alert(error.message)); return; }
      const automationButton = event.target.closest("button[data-automation-view]");
      if (automationButton) { switchView(automationButton.dataset.automationView || "map"); return; }
      const dailyButton = event.target.closest("button[data-daily-action]");
      if (dailyButton) {
        const action = dailyButton.dataset.dailyAction;
        if (action === "report") {
          const reportWindow = window.open("", "_blank");
          generateReport(dailyButton.dataset.type, dailyButton.dataset.id, reportWindow).catch(error => alert(error.message));
        } else if (action === "attach") {
          quickAttachEntityFiles(dailyButton.dataset.type, dailyButton.dataset.id, dailyButton.dataset.title || "");
        } else {
          openEntity(dailyButton.dataset.type, dailyButton.dataset.id, action === "record").catch(error => alert(error.message));
        }
        return;
      }
      const searchButton = event.target.closest("button[data-search-action]");
      if (searchButton) {
        const action = searchButton.dataset.searchAction;
        if (action === "attachment") window.open("/api/attachment?id=" + encodeURIComponent(searchButton.dataset.id) + "&inline=1", "_blank");
        else if (action === "report-file") window.open("/api/report/download?id=" + encodeURIComponent(searchButton.dataset.id), "_blank");
        else openEntity(searchButton.dataset.type, searchButton.dataset.entityId, false).catch(error => alert(error.message));
        return;
      }
      const documentButton = event.target.closest("button[data-document-action]");
      if (documentButton) {
        const row = ((state.daily || {}).documents || []).find(item => String(item.id) === String(documentButton.dataset.id));
        if (!row) return;
        const action = documentButton.dataset.documentAction;
        if (action === "related") openEntity(documentButton.dataset.type, documentButton.dataset.entityId, false).catch(error => alert(error.message));
        else window.open(documentUrl(row, action === "open"), "_blank");
        return;
      }
      const mapCard = event.target.closest("[data-map-key]");
      if (mapCard) {
        selectedMapKey = selectedMapKey === mapCard.dataset.mapKey ? "" : mapCard.dataset.mapKey;
        render();
        return;
      }
      const workflowButton = event.target.closest("button[data-work-action]");
      if (workflowButton) {
        const action = workflowButton.dataset.workAction;
        if (action === "president") {
          openPresidentDecision(workflowButton.dataset.requestId);
          return;
        }
        if (action === "notification-read") {
          markNotification(workflowButton.dataset.notificationId, false);
          return;
        }
        if (action === "notification-open") {
          markNotification(workflowButton.dataset.notificationId, false).then(() => openEntity(workflowButton.dataset.type, workflowButton.dataset.id, false)).catch(error => alert(error.message));
          return;
        }
        if (action === "attach") {
          quickAttachEntityFiles(workflowButton.dataset.type, workflowButton.dataset.id, workflowButton.dataset.title || "");
          return;
        }
        if (["open", "record", "review"].includes(action)) {
          openEntity(workflowButton.dataset.type, workflowButton.dataset.id, action !== "open").catch(error => alert(error.message));
          return;
        }
      }
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      if (button.dataset.action === "report") {
        const reportWindow = window.open("", "_blank");
        generateReport(button.dataset.type, button.dataset.id, reportWindow).catch(error => alert(error.message));
        return;
      }
      if (button.dataset.action === "attach") {
        quickAttachEntityFiles(button.dataset.type, button.dataset.id, button.dataset.title || "");
        return;
      }
      openEntity(button.dataset.type, button.dataset.id, button.dataset.action === "record").catch(error => alert(error.message));
    });
    $("closeModal").addEventListener("click", closeModal);
    $("entityModal").addEventListener("click", event => { if (event.target.id === "entityModal") closeModal(); });
    $("toggleEditEntity").addEventListener("click", () => toggleEditSection());
    $("cancelEntityEdit").addEventListener("click", () => toggleEditSection(false));
    $("saveEntityEdit").addEventListener("click", saveEntityEdit);
    $("archiveEntityButton").addEventListener("click", archiveSelectedEntity);
    $("generateReportButton").addEventListener("click", generateSelectedReport);
    $("generateReportBottom").addEventListener("click", generateSelectedReport);
    $("focusRecordButton").addEventListener("click", focusRecordSection);
    $("entityCopilotButton").addEventListener("click", () => openCopilot("ask"));
    $("uploadAttachmentsButton").addEventListener("click", uploadSelectedAttachments);
    $("copilotFab").addEventListener("click", () => openCopilot());
    $("closeCopilot").addEventListener("click", closeCopilot);
    $("copilotBackdrop").addEventListener("click", closeCopilot);
    $("copilotSend").addEventListener("click", askCopilot);
    $("copilotText").addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        askCopilot();
      }
    });
    $("copilotOpenCenter").addEventListener("click", () => {
      closeCopilot();
      switchView("ai");
    });
    document.querySelectorAll("[data-copilot-preset]").forEach(button => button.addEventListener("click", () => applyCopilotPreset(button.dataset.copilotPreset)));
    $("newProjectButton").addEventListener("click", () => openCreateModal("project").catch(error => alert(error.message)));
    $("newTaskButton").addEventListener("click", () => openCreateModal("task").catch(error => alert(error.message)));
    $("closeCreateModal").addEventListener("click", closeCreateModal);
    $("createModal").addEventListener("click", event => { if (event.target.id === "createModal") closeCreateModal(); });
    $("createType").addEventListener("change", updateCreateForm);
    $("saveCreateEntity").addEventListener("click", saveCreateEntity);
    $("closePresidentDecision").addEventListener("click", closePresidentDecision);
    $("presidentDecisionModal").addEventListener("click", event => { if (event.target.id === "presidentDecisionModal") closePresidentDecision(); });
    $("presidentApprove").addEventListener("click", () => submitPresidentDecision("Aprobada"));
    $("presidentReject").addEventListener("click", () => submitPresidentDecision("Rechazada"));
    $("presidentClarify").addEventListener("click", () => submitPresidentDecision("Solicita aclaracion"));
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
    $("firstAccessButton").addEventListener("click", configureFirstAccess);
    $("firstAccessConfirm").addEventListener("keydown", event => { if (event.key === "Enter") configureFirstAccess(); });
    $("changeCommunityTop").addEventListener("click", () => openCommunityScope(state.usuario, false));
    $("confirmCommunityScope").addEventListener("click", confirmCommunityScope);
    $("closeCommunityScope").addEventListener("click", closeCommunityScope);
    $("communityScopeModal").addEventListener("click", event => { if (event.target.id === "communityScopeModal") closeCommunityScope(); });
    $("closeSecurityModal").addEventListener("click", () => $("securityModal").classList.add("hidden"));
    $("securityModal").addEventListener("click", event => { if(event.target.id === "securityModal") $("securityModal").classList.add("hidden"); });
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
      return sendJson(res, 401, { ok: false, error: "Usa Primer acceso o contrasena reseteada para crear tu contrasena." });
    }
    if (!verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { ok: false, error: "Contrasena incorrecta." });
    }
    const publicUser = {
      id_usuario: user.id_usuario,
      nombre: user.nombre,
      rol: user.rol,
      comunidades: auth.comunidades || [],
      comunidades_asignadas: auth.comunidades || [],
      alcance_comunidades: "todas"
    };
    setSessionCookie(res, publicUser);
    return sendJson(res, 200, { ok: true, usuario: publicUser });
  }
  if (req.method === "POST" && url.pathname === "/api/auth/first-access") {
    const body = await readBody(req);
    const result = await runAdminCommand({}, "first_access", {
      nombre: body.usuario,
      clave_temporal: body.clave_temporal,
      password: body.password,
      confirmacion: body.confirmacion
    }, String(req.socket.remoteAddress || "web"));
    return sendJson(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/session/community-scope") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const assigned = Array.isArray(session.comunidades_asignadas) ? session.comunidades_asignadas : session.comunidades || [];
    let selected = assigned;
    let scope = "todas";
    if (session.rol !== "Superusuario" && body.scope !== "all" && assigned.length > 1) {
      const communityId = Number(body.id_comunidad || 0);
      const match = assigned.find(row => Number(row.id_comunidad) === communityId);
      if (!match) return sendJson(res, 403, { ok: false, error: "La comunidad seleccionada no esta asignada a tu usuario." });
      selected = [match];
      scope = "seleccion";
    }
    const updated = {
      ...session,
      comunidades: selected,
      comunidades_asignadas: assigned,
      alcance_comunidades: scope
    };
    setSessionCookie(res, updated);
    return sendJson(res, 200, {
      ok: true,
      comunidades: selected,
      comunidades_asignadas: assigned,
      alcance_comunidades: scope
    });
  }
  if (req.method === "POST" && url.pathname === "/api/logout") {
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/security/access") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    return sendJson(res, 200, await runSecurityCommand(session, "access", {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "GET" && url.pathname === "/api/security/overview") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    return sendJson(res, 200, await runSecurityCommand(session, "overview", {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "GET" && url.pathname === "/api/security/incident") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    return sendJson(res, 200, await runSecurityCommand(session, "detail", { id: url.searchParams.get("id") }, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/security/lookup") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const access = await runSecurityCommand(session, "access", {}, String(req.socket.remoteAddress || "web"));
    if (!access.can_upload) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede consultar propietarios desde Seguridad." });
    const body = await readBody(req);
    return sendJson(res, 200, await runSecurityCommand(session, "owner_lookup", { query: body.query }, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/security/upload") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const access = await runSecurityCommand(session, "access", {}, String(req.socket.remoteAddress || "web"));
    if (!access.can_upload) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede subir partes de Seguridad." });
    const fileName = safeUploadName(req.headers["x-file-name"] || "parte");
    const bytes = await readRawBody(req);
    if (!bytes.length) return sendJson(res, 400, { ok: false, error: "El archivo esta vacio." });
    const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const existing = await runSecurityCommand(session, "file_exists", { hash_archivo: fileHash }, String(req.socket.remoteAddress || "web"));
    if (existing.exists) return sendJson(res, 200, { ok: true, duplicate_document: true, document: existing.document });
    const extraction = await extractSecurityDocument(fileName, bytes);
    const analysis = analyzeSecurityText(fileName, extraction.text);
    const folder = path.join(securityDocumentsDir, new Date().toISOString().slice(0, 7));
    fs.mkdirSync(folder, { recursive: true });
    let target = path.join(folder, `${Date.now()}_${fileName}`);
    let counter = 2;
    while (fs.existsSync(target)) {
      target = path.join(folder, `${Date.now()}_${counter}_${fileName}`);
      counter += 1;
    }
    fs.writeFileSync(target, bytes, { flag: "wx" });
    try {
      const result = await runSecurityCommand(session, "register_upload", {
        document: {
          hash_archivo: fileHash,
          nombre_original: fileName,
          ruta_archivo: target,
          tipo_mime: req.headers["content-type"] || contentTypeFor(fileName),
          extension: extraction.extension,
          tamano_bytes: bytes.length,
          estado_procesamiento: "Procesado",
          advertencias: analysis.warnings,
          texto_extraido: extraction.text,
          tipo_documento: analysis.tipo_documento,
          inicio_turno: analysis.inicio_turno,
          fin_turno: analysis.fin_turno,
          operativos: analysis.operativos
        },
        incidents: analysis.incidents
      }, String(req.socket.remoteAddress || "web"));
      return sendJson(res, 200, result);
    } catch (error) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      throw error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/security/action") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const allowedActions = new Set(["claim", "save", "resolve", "link"]);
    if (!allowedActions.has(String(body.action || ""))) return sendJson(res, 400, { ok: false, error: "Accion de Seguridad no permitida." });
    return sendJson(res, 200, await runSecurityCommand(session, body.action, body.data || {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/security/convert") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const incidentId = Number(body.id_incidencia || 0);
    const mode = String(body.mode || "");
    const type = String(body.type || "");
    const entityId = Number(body.entity_id || 0);
    if (!incidentId || !["link", "followup", "create"].includes(mode) || !["task", "project"].includes(type)) {
      return sendJson(res, 400, { ok: false, error: "Operacion de vinculacion no valida." });
    }
    const pc = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web");
    const detail = await runSecurityCommand(session, "detail", { id: incidentId }, pc);
    const incident = detail.incident || {};
    let targetId = entityId;
    const comment = incident.sensible
      ? `${redactSecurityText(incident.titulo || "Incidencia de Seguridad")}. El parte contiene datos personales protegidos. El detalle y el documento original solo pueden consultarse desde el modulo de Seguridad. Resultado: ${redactSecurityText(incident.resultado || "Pendiente")}.`
      : redactSecurityText(`${incident.titulo || "Incidencia de Seguridad"}. ${incident.descripcion || ""} Actuacion de Seguridad: ${incident.actuacion_seguridad || "No indicada"}. Resultado: ${incident.resultado || "Pendiente"}.`);
    const nextStep = redactSecurityText(String(body.proximo_paso || "Revisar la incidencia, determinar la actuacion necesaria y dejar constancia del resultado."));
    if (mode === "followup") {
      if (!targetId) return sendJson(res, 400, { ok: false, error: "Selecciona una tarea o proyecto existente." });
      await writeEntityRecord(session, type, targetId, {
        tipo_registro: "Incidencia de Seguridad",
        comentario: comment,
        proximo_paso: nextStep,
        responsable_nuevo: String(body.responsable || session.nombre || ""),
        responsable_proximo_paso: String(body.responsable || session.nombre || "")
      }, pc);
    } else if (mode === "create") {
      const severityPriority = { Critica: "Urgente", Alta: "Alta", Media: "Media", Informativa: "Baja" };
      const result = await createEntity(session, type, {
        id_comunidad: Number(incident.id_comunidad || 0),
        id_proyecto: Number(body.id_proyecto || 0),
        titulo: redactSecurityText(String(body.titulo || incident.titulo || "Incidencia de Seguridad")),
        descripcion: comment,
        categoria: `Seguridad - ${incident.categoria_normalizada || "Otros"}`,
        estado_nuevo: "En curso",
        prioridad_nueva: severityPriority[incident.gravedad] || "Media",
        responsable_nuevo: String(body.responsable || session.nombre || ""),
        responsable_proximo_paso: String(body.responsable || session.nombre || ""),
        proximo_paso: nextStep
      }, pc);
      targetId = Number(result.id || 0);
    }
    await runSecurityCommand(session, "link", {
      id: incidentId,
      entity_type: type,
      entity_id: targetId,
      relation: mode === "link" ? "Solo contexto" : mode === "followup" ? "Seguimiento" : "Creacion"
    }, pc);
    return sendJson(res, 200, { ok: true, type, id: targetId, mode });
  }
  if (req.method === "GET" && url.pathname === "/api/security/document") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const info = await runSecurityCommand(session, "document_info", { id_documento: url.searchParams.get("id") }, String(req.socket.remoteAddress || "web"));
    const filePath = path.resolve(String(info.ruta_archivo || ""));
    if (!fs.existsSync(filePath) || !pathInside(filePath, securityDocumentsDir)) throw new Error("El parte protegido no esta disponible en el servidor.");
    return sendFile(res, filePath, info.nombre_original, url.searchParams.get("inline") === "1");
  }
  {
    const session = readSession(req);
    if (session && securityOnlyForbidden(session) && url.pathname.startsWith("/api/")) {
      return sendJson(res, 403, { ok: false, error: "El perfil Seguridad solo puede cargar documentos." });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/overview") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryOverview(session));
  }
  if (req.method === "GET" && url.pathname === "/api/workflow") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryWorkflow(session));
  }
  if (req.method === "GET" && url.pathname === "/api/daily-operations") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryDailyOperations(session));
  }
  if (req.method === "GET" && url.pathname === "/api/assemblies") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    return sendJson(res, 200, await runAssemblyCommand(session, "list", {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "GET" && url.pathname === "/api/assembly/detail") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    return sendJson(res, 200, await runAssemblyCommand(session, "detail", { id: url.searchParams.get("id") }, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "GET" && url.pathname === "/api/assembly/minutes") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    return sendJson(res, 200, await runAssemblyCommand(session, "minutes_get", { id: url.searchParams.get("id") }, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/assembly/minutes/save") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede editar el acta." });
    const body = await readBody(req);
    return sendJson(res, 200, await runAssemblyCommand(session, "minutes_save", body, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/assembly/minutes/generate") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede generar el borrador." });
    const body = await readBody(req);
    const assemblyId = Number(body.id || 0);
    const detail = await runAssemblyCommand(session, "detail", { id: assemblyId }, String(req.socket.remoteAddress || "web"));
    const current = (await runAssemblyCommand(session, "minutes_get", { id: assemblyId }, String(req.socket.remoteAddress || "web"))).minutes || {};
    const source = { ...current, ...body, id: assemblyId };
    if (String(source.transcripcion || "").trim().length < 80) return sendJson(res, 400, { ok: false, error: "Incluye una transcripcion suficiente antes de preparar el borrador." });
    const proposal = await externalAssemblyMinutes(detail, source);
    const byId = new Map((proposal.puntos || []).map((point) => [Number(point.id_punto), point]));
    const existingById = new Map((current.puntos || []).map((point) => [Number(point.id_punto), point]));
    const points = (detail.points || []).map((point) => ({
      ...(existingById.get(Number(point.id_punto)) || {}),
      ...(byId.get(Number(point.id_punto)) || {}),
      id_punto: Number(point.id_punto),
    }));
    const saved = await runAssemblyCommand(session, "minutes_save", {
      ...source,
      estado: "Borrador",
      introduccion_es: proposal.introduccion_es || current.introduccion_es || "",
      introduccion_en: proposal.introduccion_en || current.introduccion_en || "",
      cierre_es: proposal.cierre_es || current.cierre_es || "",
      cierre_en: proposal.cierre_en || current.cierre_en || "",
      puntos: points,
      advertencias: proposal.advertencias || [],
      generado_ia: proposal.source !== "local",
    }, String(req.socket.remoteAddress || "web"));
    return sendJson(res, 200, { ok: true, minutes: saved.minutes, source: proposal.source || "local" });
  }
  if (req.method === "GET" && url.pathname === "/api/assembly/minutes/export") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const assemblyId = Number(url.searchParams.get("id") || 0);
    const detail = await runAssemblyCommand(session, "detail", { id: assemblyId }, String(req.socket.remoteAddress || "web"));
    const minutes = (await runAssemblyCommand(session, "minutes_get", { id: assemblyId }, String(req.socket.remoteAddress || "web"))).minutes || {};
    const report = await buildAssemblyMinutes({ detail, minutes });
    const target = path.join(reportsDir, report.filename);
    fs.writeFileSync(target, report.buffer);
    return sendFile(res, target, report.filename, false);
  }
  if (req.method === "GET" && url.pathname === "/api/assembly/web-html/export") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede generar el HTML web." });
    const assemblyId = Number(url.searchParams.get("id") || 0);
    const result = await runAssemblyCommand(session, "web_html", { id: assemblyId }, String(req.socket.remoteAddress || "web"));
    const filename = safeUploadName(result.filename || `html_proxy_asamblea_${assemblyId}.txt`);
    const target = path.join(reportsDir, filename);
    fs.writeFileSync(target, String(result.html || ""), "utf8");
    return sendFile(res, target, filename, false);
  }
  if (req.method === "POST" && url.pathname === "/api/assembly/action") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const allowedActions = new Set(["create", "update", "save_points", "add_update", "attendance_set", "attendance_batch", "attendance_remove", "moroso_set", "vote_set", "vote_bulk"]);
    if (!allowedActions.has(String(body.action || ""))) return sendJson(res, 400, { ok: false, error: "Accion de asamblea no permitida." });
    return sendJson(res, 200, await runAssemblyCommand(session, body.action, body.data || {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/assembly/document/upload") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede anadir documentos." });
    const assemblyId = Number(url.searchParams.get("id") || 0);
    await runAssemblyCommand(session, "detail", { id: assemblyId }, String(req.socket.remoteAddress || "web"));
    const fileName = safeUploadName(req.headers["x-file-name"] || "documento");
    const folderName = safeUploadName(url.searchParams.get("folder") || "General").replace(/^\.+$/, "General");
    const bytes = await readRawBody(req);
    if (!bytes.length) return sendJson(res, 400, { ok: false, error: "El archivo esta vacio." });
    const folder = path.join(assemblyDocumentsDir, String(assemblyId), folderName);
    fs.mkdirSync(folder, { recursive: true });
    let target = path.join(folder, fileName);
    let counter = 2;
    while (fs.existsSync(target)) {
      target = path.join(folder, `${counter}_${fileName}`);
      counter += 1;
    }
    fs.writeFileSync(target, bytes, { flag: "wx" });
    try {
      const result = await runAssemblyCommand(session, "document_add", {
        id: assemblyId, ruta_archivo: target, nombre_archivo: path.basename(target),
        carpeta: folderName, descripcion: url.searchParams.get("description") || ""
      }, String(req.socket.remoteAddress || "web"));
      return sendJson(res, 200, result);
    } catch (error) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      throw error;
    }
  }
  if (req.method === "GET" && url.pathname === "/api/assembly/document") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const info = await runAssemblyCommand(session, "document_info", { id_documento: url.searchParams.get("id") }, String(req.socket.remoteAddress || "web"));
    const filePath = path.resolve(String(info.ruta_archivo || ""));
    if (!fs.existsSync(filePath) || !pathInside(filePath, assemblyDocumentsDir)) throw new Error("El documento historico aun no esta disponible en el servidor.");
    return sendFile(res, filePath, info.nombre_archivo, url.searchParams.get("inline") === "1");
  }
  if (req.method === "POST" && url.pathname === "/api/assembly/document/delete") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const result = await runAssemblyCommand(session, "document_delete", { id_documento: body.id }, String(req.socket.remoteAddress || "web"));
    const filePath = path.resolve(String(result.ruta_archivo || ""));
    if (fs.existsSync(filePath) && pathInside(filePath, assemblyDocumentsDir)) fs.unlinkSync(filePath);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/global-search") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await queryGlobalSearch(
      session,
      url.searchParams.get("q") || "",
      url.searchParams.get("type") || "all",
      url.searchParams.get("community") || ""
    ));
  }
  if (req.method === "POST" && url.pathname === "/api/import/extract") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede importar documentos." });
    const fileName = String(req.headers["x-file-name"] || "").trim();
    if (!fileName) return sendJson(res, 400, { ok: false, error: "Falta el nombre del documento." });
    const bytes = await readRawBody(req);
    return sendJson(res, 200, { ok: true, ...(await extractImportDocument(fileName, bytes)) });
  }
  if (req.method === "POST" && url.pathname === "/api/import/analyze") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede importar informacion." });
    const body = await readBody(req);
    return sendJson(res, 200, await analyzeImportBatch(session, body.text || "", body.mode || "updates"));
  }
  if (req.method === "POST" && url.pathname === "/api/import/apply") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede aplicar importaciones." });
    const body = await readBody(req);
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await applyImportBatch(session, body, String(pc)));
  }
  if (req.method === "GET" && url.pathname === "/api/reports-center") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (reportsForbidden(session)) return sendJson(res, 403, { ok: false, error: "El perfil Presidente no tiene acceso a informes." });
    return sendJson(res, 200, await queryReportsCenter(session));
  }
  if (req.method === "POST" && url.pathname === "/api/report/collection") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (reportsForbidden(session)) return sendJson(res, 403, { ok: false, error: "El perfil Presidente no tiene acceso a informes." });
    const body = await readBody(req);
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await generateCollectionReport(session, body.selections || [], body.title || "Informe conjunto", String(pc)));
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
  if (req.method === "POST" && url.pathname === "/api/notifications/read") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const id = Number(body.id || 0);
    const markAll = Boolean(body.all);
    if (!markAll && !id) return sendJson(res, 400, { ok: false, error: "Notificacion no valida." });
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await markNotifications(session, id, markAll, String(pc)));
  }
  if (req.method === "POST" && url.pathname === "/api/review/complete") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await saveReviewSummary(session, body || {}, String(pc)));
  }
  if (req.method === "POST" && url.pathname === "/api/president/respond") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const id = Number(body.id || 0);
    if (!id) return sendJson(res, 400, { ok: false, error: "Solicitud no valida." });
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await respondPresidentRequest(session, id, String(body.decision || ""), String(body.comment || ""), String(pc)));
  }
  if (req.method === "POST" && url.pathname === "/api/entity/attachment") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const type = String(url.searchParams.get("type") || "").trim();
    const id = Number(url.searchParams.get("id") || 0);
    if (!["task", "project"].includes(type) || !id) return sendJson(res, 400, { ok: false, error: "Entidad no valida." });
    const fileName = String(req.headers["x-file-name"] || "").trim();
    if (!fileName) return sendJson(res, 400, { ok: false, error: "Falta el nombre del archivo." });
    const bytes = await readRawBody(req);
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await saveEntityAttachment(session, type, id, fileName, req.headers["content-type"], bytes, String(pc)));
  }
  if (req.method === "GET" && url.pathname === "/api/attachment") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return sendJson(res, 400, { ok: false, error: "Anexo no valido." });
    const attachment = await queryAttachmentFile(session, id);
    const inline = url.searchParams.get("inline") === "1" && url.searchParams.get("download") !== "1";
    return sendFile(res, attachment.filePath, attachment.nombre_archivo, inline);
  }
  if (req.method === "POST" && url.pathname === "/api/report/generate") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (reportsForbidden(session)) return sendJson(res, 403, { ok: false, error: "El perfil Presidente no tiene acceso a informes." });
    const body = await readBody(req);
    const type = String(body.type || "").trim();
    const id = Number(body.id || 0);
    if (!["task", "project"].includes(type) || !id) return sendJson(res, 400, { ok: false, error: "Entidad no valida." });
    const pc = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
    return sendJson(res, 200, await generateEntityReport(session, type, id, String(pc)));
  }
  if (req.method === "GET" && url.pathname === "/api/report/download") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (reportsForbidden(session)) return sendJson(res, 403, { ok: false, error: "El perfil Presidente no tiene acceso a informes." });
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return sendJson(res, 400, { ok: false, error: "Informe no valido." });
    const report = await queryReportFile(session, id);
    const inline = url.searchParams.get("inline") === "1";
    return sendFile(res, report.filePath, report.filename, inline);
  }
  if (req.method === "GET" && url.pathname === "/api/ai/history") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await runAiHistoryCommand(session, "list", { limit: Number(url.searchParams.get("limit") || 40) }));
  }
  if (req.method === "POST" && url.pathname === "/api/ai/history/action") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const action = String(body.action || "");
    if (!["delete", "clear"].includes(action)) return sendJson(res, 400, { ok: false, error: "Accion de historial no permitida." });
    return sendJson(res, 200, await runAiHistoryCommand(session, action, { id_consulta: body.id_consulta }));
  }
  if (req.method === "POST" && url.pathname === "/api/agent/message") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede usar el agente operativo." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    return sendJson(res, 200, await answerAgentMessage(session, body.text || ""));
  }
  if (req.method === "GET" && url.pathname === "/api/agent/tools") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede consultar herramientas del agente." });
    return sendJson(res, 200, { ok: true, tools: getAgentToolCatalog(session) });
  }
  if (req.method === "GET" && url.pathname === "/api/agent/actions") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede consultar acciones del agente." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await runAgentActionsCommand(session, "list", {
      estado: url.searchParams.get("estado") || "",
      limit: Number(url.searchParams.get("limit") || 40),
    }, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/agent/actions") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede gestionar acciones del agente." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    const action = String(body.action || "");
    if (!["update", "delete"].includes(action)) return sendJson(res, 400, { ok: false, error: "Accion de propuestas no permitida." });
    return sendJson(res, 200, await runAgentActionsCommand(session, action, body.data || {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/agent/documents/query") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede consultar documentos e informes." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    return sendJson(res, 200, await queryAgentDocumentsReports(session, body.text || ""));
  }
  if (req.method === "POST" && url.pathname === "/api/agent/report/prepare") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede preparar informes." });
    if (reportsForbidden(session)) return sendJson(res, 403, { ok: false, error: "El perfil Presidente no tiene acceso a informes." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    return sendJson(res, 200, await prepareAgentEntityReport(session, body.text || ""));
  }
  if (req.method === "POST" && url.pathname === "/api/agent/email/draft") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede preparar borradores de email." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    return sendJson(res, 200, await prepareAgentEmailDraft(session, body.text || ""));
  }
  if (req.method === "GET" && url.pathname === "/api/agent/context") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede consultar contexto IA." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await runAgentContextCommand(session, "list", { limit: Number(url.searchParams.get("limit") || 12) }, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/agent/context/clear") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede borrar contexto IA." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await runAgentContextCommand(session, "clear", {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/ai/query") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    return sendJson(res, 200, await answerAiQuery(session, body.text || ""));
  }
  if (req.method === "POST" && url.pathname === "/api/ai/operate") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede preparar cambios operativos." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    return sendJson(res, 200, await analyzeOperationalWithAi(session, body.text || ""));
  }
  if (req.method === "POST" && url.pathname === "/api/ai/batch-operate") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede preparar automatizaciones guiadas." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    return sendJson(res, 200, await analyzeGuidedAutomationBatch(session, body.text || ""));
  }
  if (req.method === "POST" && url.pathname === "/api/ai/analyze") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede preparar cambios operativos." });
    const body = await readBody(req);
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await analyzeWithAi(session, body.text || "", body.target || null));
  }
  if (req.method === "GET" && url.pathname === "/api/ai/rules") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede consultar memoria IA." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    return sendJson(res, 200, await runAiMemoryCommand(session, "list", {
      modulo: url.searchParams.get("modulo") || "",
      include_inactive: url.searchParams.get("include_inactive") === "1",
      limit: Number(url.searchParams.get("limit") || 80),
    }, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/ai/rules/action") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    if (!["Superusuario", "Administrador", "Usuario"].includes(session.rol)) return sendJson(res, 403, { ok: false, error: "Tu perfil no puede gestionar memoria IA." });
    if (!fs.existsSync(databasePath)) return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    const body = await readBody(req);
    const action = String(body.action || "");
    if (!["learn_redaction", "update"].includes(action)) return sendJson(res, 400, { ok: false, error: "Accion de memoria IA no permitida." });
    return sendJson(res, 200, await runAiMemoryCommand(session, action, body.data || {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "GET" && url.pathname === "/api/admin") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    return sendJson(res, 200, await runAdminCommand(session, "list", {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "POST" && url.pathname === "/api/admin/action") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
    const body = await readBody(req);
    const allowedActions = new Set(["save_user", "save_community", "reset_password", "unlock_user"]);
    if (!allowedActions.has(String(body.action || ""))) return sendJson(res, 400, { ok: false, error: "Accion de administracion no permitida." });
    return sendJson(res, 200, await runAdminCommand(session, body.action, body.data || {}, String(req.socket.remoteAddress || "web")));
  }
  if (req.method === "GET" && url.pathname === "/health") {
    const databaseExists = fs.existsSync(databasePath);
    return sendJson(res, 200, {
      ok: true,
      app: appName,
      step: databaseExists ? 16 : 1,
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
      aiProvider: aiExternalLabel(),
      aiExternalConfigured: aiExternalAvailable(),
      aiModel: aiExternalAvailable() ? aiModel : "",
      aiBaseUrl: aiExternalAvailable() ? aiBaseUrl.replace(/\/$/, "") : "",
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
