import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { buildCollectionReport, buildEntityReport } from "./report-generator.js";

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
const uploadsDir = path.join(dataDir, "uploads");
const legacyAttachmentsDir = path.join(dataDir, "legacy-attachments");
const reportsDir = path.join(dataDir, "reports");
const assemblyDocumentsDir = path.join(dataDir, "assembly-documents");
const databasePath = path.resolve(rootDir, process.env.DATABASE_PATH || "./data/organizador_tareas.db");
const assemblyBridgePath = path.join(__dirname, "assembly-bridge.py");

for (const dir of [dataDir, logsDir, backupsDir, uploadsDir, legacyAttachmentsDir, reportsDir, assemblyDocumentsDir]) {
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

function runAssemblyCommand(session, action, data = {}, pc = "web") {
  return new Promise((resolve, reject) => {
    const request = JSON.stringify({ session, action, data, pc });
    execFile(pythonBin, [assemblyBridgePath, databasePath, request], { timeout: 30000, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => {
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
president_report=" AND COALESCE(i.tipo_informe,'') NOT LIKE '%Tarea%'" if role=="Presidente" else ""
reports=rows("""SELECT i.id_informe,i.fecha_generacion,i.tipo_informe,i.periodo_desde,i.periodo_hasta,
    i.id_proyecto,i.archivo_word,i.observaciones,i.usuario,i.id_comunidad,c.nombre AS comunidad,p.nombre AS proyecto
    FROM informes i LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad LEFT JOIN proyectos p ON p.id_proyecto=i.id_proyecto
    WHERE COALESCE(i.archivo_word,'')<>''"""+president_report+rf+" ORDER BY i.fecha_generacion DESC,i.id_informe DESC LIMIT 350",tuple(rp))
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
  if (session?.rol === "Presidente" && normalized.some(row => row.type === "task")) throw new Error("El Presidente no puede generar informes generales de tareas.");
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
    if (session?.rol === "Presidente" && String(row.tipo_informe || "").toLowerCase().includes("tarea")) {
      throw new Error("El perfil Presidente no tiene acceso general a informes de tareas.");
    }
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
report_extra = " AND COALESCE(i.tipo_informe,'') NOT LIKE '%Tarea%'" if role == "Presidente" else ""
reports = rows("""
    SELECT i.id_informe AS id, 'report' AS document_type, i.id_comunidad,
           COALESCE(NULLIF(i.tipo_informe,''),'Informe') AS nombre, i.archivo_word AS ruta,
           i.fecha_generacion AS fecha, NULL AS id_tarea, i.id_proyecto,
           c.nombre AS comunidad, '' AS tarea, p.nombre AS proyecto,
           'project' AS entity_type, i.id_proyecto AS entity_id, i.observaciones, i.tipo_informe
    FROM informes i
    LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad
    LEFT JOIN proyectos p ON p.id_proyecto=i.id_proyecto
    WHERE COALESCE(i.archivo_word,'')<>''
""" + report_extra + report_filter + " ORDER BY i.fecha_generacion DESC,i.id_informe DESC LIMIT 100", tuple(report_params))

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
report_extra = " AND COALESCE(i.tipo_informe,'') NOT LIKE '%Tarea%'" if role == "Presidente" else ""
if include("report", "document"):
    for r in rows("""SELECT i.id_informe AS id,i.id_comunidad,COALESCE(NULLIF(i.tipo_informe,''),'Informe') AS titulo,
                    COALESCE(p.nombre,'Informe generado') AS detalle,c.nombre AS comunidad,'project' AS entity_type,
                    i.id_proyecto AS entity_id,i.fecha_generacion AS fecha,i.archivo_word,i.observaciones
                    FROM informes i LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad
                    LEFT JOIN proyectos p ON p.id_proyecto=i.id_proyecto
                    WHERE (i.tipo_informe LIKE ? OR i.archivo_word LIKE ? OR p.nombre LIKE ?)""" + report_extra + report_scope + " ORDER BY i.fecha_generacion DESC LIMIT 60", tuple([like,like,like] + report_params)):
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
  return {
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
  };
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
    return {
      fecha: normalizeImportDate(match[1]),
      tipo_registro: detectRecordType(`${match[0]} ${comment}`),
      comentario: comment || "Actuación histórica pendiente de completar.",
      estado_nuevo: normalizeImportState(kind, detectState(comment, kind === "task" ? "Pendiente" : "En curso"), kind === "task" ? "Pendiente" : "En curso"),
      prioridad_nueva: detectPriority(comment, priority),
      responsable_nuevo: owner,
      responsable_proximo_paso: owner,
      proximo_paso: extractNextStep(comment) || "Revisar la siguiente actuación."
    };
  }).filter(record => record.comentario);
  if (!records.length) records.push({ fecha: new Date().toISOString().slice(0, 10), tipo_registro: detectRecordType(source), comentario: source, estado_nuevo: kind === "task" ? "Pendiente" : "En curso", prioridad_nueva: priority, responsable_nuevo: owner, responsable_proximo_paso: owner, proximo_paso: extractNextStep(source) || "Revisar la siguiente actuación." });
  const last = records.at(-1);
  return {
    client_id: 1, selected: true, action: kind === "task" ? "crear_tarea" : "crear_proyecto", confidence: 0.8,
    entity: null, candidates: [], historical: true, records,
    payload: {
      titulo: title, categoria: category, tipo_registro: "Creación", comentario: records[0].comentario,
      estado_nuevo: last.estado_nuevo, prioridad_nueva: priority, responsable_nuevo: owner,
      responsable_proximo_paso: last.responsable_proximo_paso, fecha_objetivo_proximo_paso: "",
      fecha_proxima_revision: "", proximo_paso: last.proximo_paso, motivo_bloqueo: "", descripcion: source.slice(0, 8000)
    }, original: source
  };
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
conn.close()
print(json.dumps({"item": dict(item), "history": history, "attachments": attachments}, ensure_ascii=False))
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
    .attachmentGrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:9px; }
    .attachmentCard { border:1px solid #e2e8f0; border-radius:8px; padding:10px; background:white; display:grid; gap:8px; min-width:0; }
    .attachmentCard h4 { margin:0; font-size:14px; overflow-wrap:anywhere; }
    .attachmentPreview { width:100%; height:128px; object-fit:cover; border-radius:6px; background:#f1f5f9; border:1px solid #e2e8f0; }
    .attachmentIcon { height:86px; display:grid; place-items:center; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; color:#475569; font-weight:800; font-size:13px; }
    .uploadBox { border:2px dashed #94a3b8; border-radius:8px; padding:12px; background:#f8fafc; display:grid; gap:9px; }
    .uploadBox input { width:100%; }
    .reportMessage { min-height:20px; }
    .tabBadge { min-width:24px; text-align:center; border-radius:999px; padding:2px 7px; background:#dbeafe; color:#1e3a8a; font-size:12px; font-weight:800; }
    .tabBadge.alert { background:#fee2e2; color:#991b1b; }
    .workflowCard { border-left-color:#2563eb; }
    .workflowCard.overdue { border-left-color:#b91c1c; }
    .workflowCard.thirdParty { border-left-color:#c2410c; }
    .notificationCard { min-height:0; }
    .notificationCard.unread { border-left-color:#2563eb; background:#f8fbff; }
    .notificationCard.read { opacity:.78; }
    .reviewSummary { display:grid; grid-template-columns:repeat(5,minmax(120px,1fr)); gap:8px; margin-bottom:12px; }
    .reviewSummary .count { min-height:82px; }
    .workflowControls { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; margin-bottom:12px; }
    .specialPanel { display:block; min-width:0; }
    .decisionBox { background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px; }
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
      .homeHero { align-items:flex-start; flex-direction:column; }
      .homeActions { justify-content:flex-start; width:100%; }
      .homeActions button { flex:1 1 140px; }
      .homeMetrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .attentionRow { grid-template-columns:1fr; gap:4px; }
      .mapSectionBody { grid-template-columns:1fr; }
      .searchControls, .documentControls { grid-template-columns:1fr; }
      .resultCard { grid-template-columns:1fr; }
      .importControls, .importProposalGrid, .historicalRow, .reportControls { grid-template-columns:1fr; }
      .reportRow { grid-template-columns:1fr; }
      .assemblyHeader { flex-direction:column; }
      .assemblyMetrics, .voteSummary { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .attendanceRow, .voteMember, .pointEditor, .votePointSelect { grid-template-columns:1fr; }
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
        <p>Paso 13 - Asambleas web</p>
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
            <button class="tab active" id="homeTab" data-view="home"><span>Inicio</span><span>Resumen</span></button>
            <button class="tab" id="taskTab" data-view="tasks"><span>Tareas</span><span id="taskTabCount">0</span></button>
            <button class="tab" id="projectTab" data-view="projects"><span>Proyectos</span><span id="projectTabCount">0</span></button>
            <button class="tab" id="assemblyTab" data-view="assemblies"><span>Asambleas</span><span id="assemblyTabCount">0</span></button>
            <div class="navDivider"></div>
            <button class="tab" id="mapTab" data-view="map"><span>Mapa de trabajo</span><span id="mapTabCount">0</span></button>
            <button class="tab" id="workTab" data-view="work"><span>Acciones</span><span class="tabBadge" id="workTabCount">0</span></button>
            <button class="tab" id="reviewTab" data-view="review"><span>Revision</span><span class="tabBadge" id="reviewTabCount">0</span></button>
            <div class="navDivider"></div>
            <button class="tab" id="globalSearchTab" data-view="global-search"><span>Buscar</span><span id="globalSearchTabCount">Todo</span></button>
            <button class="tab" id="documentsTab" data-view="documents"><span>Documentos</span><span id="documentsTabCount">0</span></button>
            <button class="tab" id="reportsTab" data-view="reports"><span>Informes</span><span id="reportsTabCount">0</span></button>
            <button class="tab" id="importTab" data-view="imports"><span>Importar</span><span>Revisar</span></button>
            <button class="tab" id="notificationTab" data-view="notifications"><span>Notificaciones</span><span class="tabBadge alert" id="notificationTabCount">0</span></button>
            <button class="tab" id="aiTab" data-view="ai"><span>IA</span><span id="aiTabStatus">OK</span></button>
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
            <button id="generateReportButton">Generar informe</button>
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
          <section>
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
    <datalist id="responsiblesList"></datalist>
  </main>
  <script>
    let state = { usuario: null, proyectos: [], tareas: [], workflow: { actions: [], notifications: [], president_requests: [], review: { items: [], summary: {}, communities: [] } }, daily: { metrics: {}, map: { items: [], counts: {} }, documents: [], communities: [] } };
    let options = { responsables: [], estados_tarea: [], estados_proyecto: [], prioridades: [], tipos_registro: [], comunidades: [], proyectos: [] };
    let currentView = "home";
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
    let assemblySection = "summary";
    let assemblyOwnerQuery = "";
    let selectedAssemblyPoint = 0;
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
          '<button data-action="report" data-type="' + (currentView === "projects" ? "project" : "task") + '" data-id="' + html(id) + '">Informe</button>' +
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
      state = { usuario: null, proyectos: [], tareas: [], workflow: { actions: [], notifications: [], president_requests: [], review: { items: [], summary: {}, communities: [] } }, daily: { metrics: {}, map: { items: [], counts: {} }, documents: [], communities: [] } };
      importAnalysis = null;
      importSourceText = "";
      importCommunity = "";
      reportsCenter = { reports: [], entities: [], communities: [], loaded: false };
      selectedReportEntities = new Set();
      assembliesData = { assemblies: [], loaded: false };
      selectedAssemblyId = 0;
      assemblyDetail = null;
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
      ["homeTab", "projectTab", "taskTab", "assemblyTab", "mapTab", "workTab", "reviewTab", "globalSearchTab", "documentsTab", "reportsTab", "importTab", "notificationTab", "aiTab"].forEach(id => $(id).classList.remove("active"));
      const target = ({ home: "homeTab", projects: "projectTab", tasks: "taskTab", assemblies: "assemblyTab", map: "mapTab", work: "workTab", review: "reviewTab", "global-search": "globalSearchTab", documents: "documentsTab", reports: "reportsTab", imports: "importTab", notifications: "notificationTab", ai: "aiTab" })[view];
      if (target) $(target).classList.add("active");
    }

    function homePanelHtml() {
      const daily = state.daily || {};
      const metrics = daily.metrics || {};
      const president = (state.usuario || {}).rol === "Presidente";
      const attention = ((daily.map || {}).items || []).filter(row => ["Necesita acción", "Bloqueado / riesgo"].includes(row.seccion)).slice(0, 8);
      const actions = president
        ? '<button data-home-view="work">Ver decisiones</button><button class="ghost" data-home-view="projects">Consultar proyectos</button>'
        : '<button data-home-view="map">Abrir mapa de trabajo</button><button class="green" data-home-view="work">Mi bandeja</button><button class="ghost" data-home-create="project">Nuevo proyecto</button><button class="ghost" data-home-create="task">Nueva tarea</button>';
      const attentionRows = attention.length ? attention.map(row =>
        '<div class="attentionRow"><div><div class="attentionTitle">' + html(row.titulo) + '</div><div class="muted">' + html(row.entity_type === "task" ? "Tarea" : "Proyecto") + ' · ' + html(row.comunidad || "") + '</div></div>' +
        '<div><span class="pill state-' + slug(row.estado) + '">' + html(row.estado || "Sin estado") + '</span></div>' +
        '<div><strong>' + html(row.responsable_proximo_paso || row.responsable || "Sin responsable") + '</strong><div class="muted">' + html(row.fecha_objetivo || "Sin fecha") + '</div></div>' +
        '<button class="ghost" data-daily-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir</button></div>'
      ).join("") : '<div class="empty">No hay elementos críticos en este momento.</div>';
      return '<div class="homeHero"><div><h2>Buenos días, ' + html((state.usuario || {}).nombre || "") + '</h2><p>Resumen operativo actualizado para tus comunidades.</p></div><div class="homeActions">' + actions + '</div></div>' +
        '<div class="grid homeMetrics">' +
          countCard("Elementos activos", metrics.activos || 0) +
          countCard("Necesitan acción", ((daily.map || {}).counts || {})["Necesita acción"] || 0) +
          countCard("Pendientes de terceros", ((daily.map || {}).counts || {})["Pendiente de terceros"] || 0) +
          countCard("Bloqueados / riesgo", ((daily.map || {}).counts || {})["Bloqueado / riesgo"] || 0) +
          countCard("Urgentes", metrics.urgentes || 0) +
          countCard("Sin revisar > 7 días", metrics.sin_revisar || 0) +
          countCard("Documentos", (daily.documents || []).length) +
          countCard(president ? "Decisiones pendientes" : "Notificaciones sin leer", president ? (state.workflow.president_requests || []).length : (state.workflow.unread_notifications || 0)) +
        '</div>' +
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
        '<button data-daily-action="report" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Informe</button></div>' +
      '</article>';
    }

    function mapPanelHtml() {
      const map = (state.daily || {}).map || { items: [], counts: {} };
      const sections = [
        ["Necesita acción", "#065f46"],
        ["Pendiente de terceros", "#92400e"],
        ["En seguimiento", "#1d4ed8"],
        ["Bloqueado / riesgo", "#991b1b"]
      ];
      return '<div class="mapBoard">' + sections.map(([name, color]) => {
        const rows = (map.items || []).filter(row => row.seccion === name);
        return '<section class="mapSection"><div class="mapSectionHead"><h3 style="color:' + color + '">' + html(name) + '</h3><span class="tabBadge">' + rows.length + '</span></div><div class="mapSectionBody">' +
          (rows.length ? rows.map(dailyMapCard).join("") : '<div class="empty">Sin elementos.</div>') + '</div></section>';
      }).join("") + '</div>';
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
      $("documentCount").textContent = rows.length + " documentos visibles.";
      $("documentResults").innerHTML = rows.length ? rows.map(documentCard).join("") : '<div class="empty">No hay documentos con estos filtros.</div>';
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
      const tabs = [["summary","Resumen"],["registration","Registro"],["voting","Votacion"],["documents","Documentos y proxys"],["history","Historial"]];
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
      return '<details class="assemblyPane"><summary><strong>Editar datos y orden del dia</strong></summary><div class="formGrid" style="margin-top:10px">' +
        '<div><label>Comunidad</label><select id="assemblyEditCommunity">' + communities + '</select></div><div><label>Codigo</label><input id="assemblyEditCode" value="' + html(item.codigo) + '" /></div>' +
        '<div><label>Nombre</label><input id="assemblyEditName" value="' + html(item.nombre) + '" /></div><div><label>Fecha</label><input id="assemblyEditDate" type="date" value="' + html((item.fecha || "").slice(0,10)) + '" /></div>' +
        '<div><label>Convocatoria</label><select id="assemblyEditCall"><option value="primera"' + (item.convocatoria === "primera" ? " selected" : "") + '>Primera</option><option value="segunda"' + (item.convocatoria !== "primera" ? " selected" : "") + '>Segunda</option></select></div>' +
        '<div><label>Estado</label><select id="assemblyEditState">' + states.map(value => '<option' + (value === item.estado ? " selected" : "") + '>' + value + '</option>').join("") + '</select></div>' +
        '<div><label>Presidente</label><input id="assemblyEditPresident" value="' + html(item.presidente) + '" /></div><div><label>Administrador</label><input id="assemblyEditAdministrator" value="' + html(item.administrador) + '" /></div>' +
        '<div><label>Hora de inicio</label><input id="assemblyEditTime" type="time" value="' + html(item.hora_inicio) + '" /></div><div><label>Lugar</label><input id="assemblyEditPlace" value="' + html(item.lugar_celebracion || item.ubicacion) + '" /></div></div>' +
        '<label>Junta directiva</label><textarea id="assemblyEditBoard">' + html(item.junta_directiva) + '</textarea><label>Observaciones</label><textarea id="assemblyEditNotes">' + html(item.observaciones) + '</textarea>' +
        '<div class="toolbar"><button class="green" id="saveAssemblyEdit">Guardar datos</button><span class="muted" id="assemblyEditMessage"></span></div>' +
        '<h3>Orden del dia</h3><div id="assemblyPointEditors">' + (detail.points || []).map((point,index) => pointEditorHtml(point,index)).join("") + '</div>' +
        '<div class="toolbar"><button class="ghost" id="addAssemblyPoint">Anadir punto</button><button id="saveAssemblyPoints">Guardar orden y mayorias</button><span class="muted" id="assemblyPointsMessage"></span></div></details>';
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
        '<div class="assemblyPane"><h3>Orden del dia y situacion</h3><div class="agendaList">' + ((detail.points || []).length ? detail.points.map(agendaItemHtml).join("") : '<div class="empty">No hay puntos configurados.</div>') + '</div></div></div>' + assemblyEditHtml(detail);
    }

    function filteredAssemblyOwners(detail) {
      const query = safe(assemblyOwnerQuery).toLowerCase();
      const registered = new Set((detail.attendance || []).map(row => row.propietario));
      return (detail.owners || []).filter(row => !registered.has(row.propietario) && (!query || [row.propietario,row.propiedad_ids].join(" ").toLowerCase().includes(query))).slice(0, 120);
    }

    function assemblyRegistrationHtml(detail) {
      const owners = filteredAssemblyOwners(detail);
      const picker = owners.length ? owners.map(row => '<label class="ownerChoice"><input type="checkbox" data-owner-select="' + html(row.propietario) + '" /><span><strong>' + html(row.propietario) + '</strong><span class="muted" style="display:block">' + html(row.propiedades + " propiedades | coef. " + Number(row.coeficiente || 0).toFixed(4)) + '</span><small>' + html(row.propiedad_ids || "") + '</small></span></label>').join("") : '<div class="empty">No hay coincidencias sin registrar.</div>';
      const rows = (detail.attendance || []).map(row => '<div class="attendanceRow"><div><strong>' + html(row.propietario) + '</strong><div class="muted">' + html(row.propiedad_ids || "") + '</div></div><div><span class="pill">' + html(row.tipo) + '</span>' + ((row.sin_voto || row.moroso) ? '<span class="pill state-Bloqueado">Sin voto</span>' : '') + '</div><div>' + (row.tipo === "representado" ? 'Representa: <strong>' + html(row.representante) + '</strong>' : 'Coef. ' + Number(row.coeficiente || 0).toFixed(4)) + '</div>' +
        (canWrite() ? '<div class="toolbar"><button class="ghost" data-attendance-moroso="' + html(row.propietario) + '" data-moroso="' + (row.moroso ? "0" : "1") + '">' + (row.moroso ? "Dar voto" : "Sin voto") + '</button><button class="red" data-attendance-remove="' + html(row.propietario) + '">Quitar</button></div>' : '') + '</div>').join("");
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

    function assemblyDetailHtml(detail) {
      const item = detail.assembly || {};
      const content = assemblySection === "registration" ? assemblyRegistrationHtml(detail) : assemblySection === "voting" ? assemblyVotingHtml(detail) : assemblySection === "documents" ? assemblyDocumentsHtml(detail) : assemblySection === "history" ? assemblyHistoryHtml(detail) : assemblySummaryHtml(detail);
      return '<div class="assemblyShell"><div class="assemblyHeader"><div><div class="meta"><span class="pill ' + assemblyStatusClass(item.estado) + '">' + html(item.estado) + '</span><span class="pill">' + html(item.comunidad) + '</span></div><h2>' + html(item.nombre) + '</h2><p>' + html([item.fecha,item.hora_inicio,item.lugar_celebracion || item.ubicacion].filter(Boolean).join(" | ")) + '</p></div><div class="toolbar"><button class="ghost" id="backAssemblies">Volver</button><button id="reloadAssembly">Actualizar</button></div></div>' + assemblyTabsHtml() + '<div id="assemblySectionContent">' + content + '</div></div>';
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
      render();
      try {
        assemblyDetail = await api("/api/assembly/detail?id=" + encodeURIComponent(selectedAssemblyId));
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
      $("backAssemblies").addEventListener("click", () => { selectedAssemblyId=0; assemblyDetail=null; assemblySection="summary"; render(); });
      $("reloadAssembly").addEventListener("click", () => loadAssemblyDetail());
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
      const reportRows = reports.length ? reports.map(row => '<article class="reportRow"><div><h3>' + html(row.nombre_archivo || "Informe") + '</h3><div class="meta"><span class="pill">' + html(row.tipo_informe || "Informe") + '</span><span class="pill">' + html(row.comunidad || "") + '</span></div><div class="muted">' + html(row.fecha_generacion || "") + ' | ' + html(row.usuario || "") + '</div></div><div class="toolbar"><button class="ghost" data-report-open="' + html(row.id_informe) + '">Abrir</button>' + (row.entity_id ? '<button data-report-related="' + html(row.entity_id) + '" data-report-type="' + html(row.entity_type) + '">Ficha</button>' : '') + '</div></article>').join("") : '<div class="empty">No hay informes con estos filtros.</div>';
      const entityRows = entities.length ? entities.map(row => {
        const key = row.entity_type + ":" + row.entity_id;
        const checked = selectedReportEntities.has(key);
        return '<label class="entityChoice' + (checked ? " selected" : "") + '"><input type="checkbox" data-report-entity="' + html(key) + '"' + (checked ? " checked" : "") + ' /><span><strong>' + html(row.titulo) + '</strong><span class="muted" style="display:block">' + html((row.entity_type === "task" ? "Tarea" : "Proyecto") + " | " + (row.comunidad || "") + " | " + (row.estado || "")) + '</span><span style="display:block;margin-top:4px">' + html(row.responsable || "Sin responsable") + '</span></span></label>';
      }).join("") : '<div class="empty">No hay elementos disponibles.</div>';
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
        '<div class="cardActions"><button class="ghost" data-work-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir ficha</button><button class="green" data-work-action="record" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Resolver / actualizar</button></div>' +
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
        '<div class="cardActions"><button class="ghost" data-work-action="open" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Abrir ficha</button><button class="green" data-work-action="review" data-type="' + html(row.entity_type) + '" data-id="' + html(row.entity_id) + '">Revisar ahora</button></div>' +
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
      const communities = (review.communities || []).map(row => '<option value="' + html(row.id || row.id_comunidad) + '"' + (String(row.id || row.id_comunidad) === String(reviewCommunity) ? " selected" : "") + '>' + html(row.nombre) + '</option>').join("");
      return '<div class="reviewSummary">' +
          countCard("Vencidas", summary.vencidas || 0) + countCard("Pendientes de mi", summary.mias || 0) + countCard("Pendientes de terceros", summary.terceros || 0) + countCard("Bloqueadas", summary.bloqueadas || 0) + countCard("Sin actualizar", summary.sin_actualizar || 0) +
        '</div>' +
        '<div class="workflowControls"><div><label>Comunidad</label><select id="reviewCommunity"><option value="">Todas las comunidades</option>' + communities + '</select></div>' +
        '<div><label>Tipo</label><select id="reviewType"><option value="all"' + (reviewType === "all" ? " selected" : "") + '>Tareas y proyectos</option><option value="task"' + (reviewType === "task" ? " selected" : "") + '>Solo tareas</option><option value="project"' + (reviewType === "project" ? " selected" : "") + '>Solo proyectos</option></select></div>' +
        '<div><label>Progreso de esta revision</label><div class="detailBox">' + (reviewProgress.tasks.size + reviewProgress.projects.size) + ' revisados</div></div></div>' +
        '<div class="cards">' + (items.length ? items.map(reviewCard).join("") : '<div class="empty">No hay elementos para este filtro.</div>') + '</div>' +
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
      return '<div class="toolbar"><button class="ghost" id="markAllNotifications">Marcar todas como leidas</button><span class="muted" id="notificationMessage"></span></div><div class="cards">' +
        (rows.length ? rows.map(notificationCard).join("") : '<div class="empty">No hay notificaciones.</div>') + '</div>';
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

    function render() {
      const specialView = ["home", "assemblies", "map", "work", "review", "global-search", "documents", "reports", "imports", "notifications", "ai"].includes(currentView);
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
        $("contentTitle").textContent = "Mapa de trabajo";
        $("contentSubtitle").textContent = "Todos los elementos clasificados por la acción que requieren.";
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
        $("contentTitle").textContent = "IA operativa";
        $("contentSubtitle").textContent = "Pega una llamada, reunion o consulta. La IA propone y tu confirmas antes de guardar.";
        $("visibleCount").textContent = "";
        $("viewActions").classList.add("hidden");
        $("cards").innerHTML = aiPanelHtml();
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
        const firstSessionLoad = !state.usuario;
        const [data, workflow, daily] = await Promise.all([api("/api/overview"), api("/api/workflow"), api("/api/daily-operations")]);
        data.workflow = workflow;
        data.daily = daily;
        state = data;
        showApp();
        const user = data.usuario || {};
        $("sessionStatus").innerHTML = html(user.nombre || "") + " - " + html(user.rol || "") + " - acciones con confirmacion";
        if (user.rol === "Presidente" && (firstSessionLoad || ["tasks", "assemblies", "review", "imports", "ai"].includes(currentView))) currentView = "work";
        $("taskTab").classList.toggle("hidden", user.rol === "Presidente");
        $("mapTab").classList.toggle("hidden", user.rol === "Presidente");
        $("assemblyTab").classList.toggle("hidden", user.rol === "Presidente");
        $("reviewTab").classList.toggle("hidden", user.rol === "Presidente");
        $("aiTab").classList.toggle("hidden", user.rol === "Presidente");
        $("importTab").classList.toggle("hidden", !canWrite());
        $("workTab").querySelector("span").textContent = user.rol === "Presidente" ? "Decisiones" : "Acciones";
        $("counts").innerHTML =
          countCard(user.rol === "Presidente" ? "Decisiones pendientes" : "Acciones pendientes", user.rol === "Presidente" ? workflow.president_requests.length : workflow.actions.length) +
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
      currentView = view;
      $("search").value = "";
      $("stateFilter").value = "";
      $("communityFilter").value = "";
      $("priorityFilter").value = "";
      refreshFilterOptions();
      render();
      if (view === "reports" && !reportsCenter.loaded) loadReportsCenter();
      if (view === "assemblies" && !assembliesData.loaded) loadAssemblies();
    }

    $("homeTab").addEventListener("click", () => switchView("home"));
    $("projectTab").addEventListener("click", () => switchView("projects"));
    $("taskTab").addEventListener("click", () => switchView("tasks"));
    $("assemblyTab").addEventListener("click", () => switchView("assemblies"));
    $("mapTab").addEventListener("click", () => switchView("map"));
    $("workTab").addEventListener("click", () => switchView("work"));
    $("reviewTab").addEventListener("click", () => switchView("review"));
    $("globalSearchTab").addEventListener("click", () => switchView("global-search"));
    $("documentsTab").addEventListener("click", () => switchView("documents"));
    $("reportsTab").addEventListener("click", () => switchView("reports"));
    $("importTab").addEventListener("click", () => switchView("imports"));
    $("notificationTab").addEventListener("click", () => switchView("notifications"));
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
      const homeView = event.target.closest("button[data-home-view]");
      if (homeView) { switchView(homeView.dataset.homeView); return; }
      const homeCreate = event.target.closest("button[data-home-create]");
      if (homeCreate) { openCreateModal(homeCreate.dataset.homeCreate).catch(error => alert(error.message)); return; }
      const dailyButton = event.target.closest("button[data-daily-action]");
      if (dailyButton) {
        const action = dailyButton.dataset.dailyAction;
        if (action === "report") {
          const reportWindow = window.open("", "_blank");
          generateReport(dailyButton.dataset.type, dailyButton.dataset.id, reportWindow).catch(error => alert(error.message));
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
    $("uploadAttachmentsButton").addEventListener("click", uploadSelectedAttachments);
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
    return sendJson(res, 200, await queryReportsCenter(session));
  }
  if (req.method === "POST" && url.pathname === "/api/report/collection") {
    const session = readSession(req);
    if (!session) return sendJson(res, 401, { ok: false, error: "No autenticado." });
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
    const id = Number(url.searchParams.get("id") || 0);
    if (!id) return sendJson(res, 400, { ok: false, error: "Informe no valido." });
    const report = await queryReportFile(session, id);
    const inline = url.searchParams.get("inline") === "1";
    return sendFile(res, report.filePath, report.filename, inline);
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
      step: databaseExists ? 13 : 1,
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
