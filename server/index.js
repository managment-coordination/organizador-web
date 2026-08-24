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
conn.close()
print(json.dumps({
    "estados_tarea": ["Pendiente", "En curso", "Pendiente de tercero", "Bloqueada", "Terminada", "Archivada"],
    "estados_proyecto": ["Pendiente", "En curso", "Pendiente de tercero", "Bloqueado", "Finalizado", "Archivado"],
    "prioridades": ["Urgente", "Alta", "Media", "Baja"],
    "tipos_registro": ["Seguimiento", "Decision", "Llamada", "Correo", "Reunion", "Incidencia", "Cierre"],
    "responsables": responsables,
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
    .formGrid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:9px; }
    .history { display:grid; gap:8px; }
    .historyItem { border:1px solid #e2e8f0; border-left:5px solid #94a3b8; border-radius:8px; padding:10px; background:#fff; }
    .historyItem h4 { margin:0 0 6px; font-size:14px; }
    .historyItem p { margin:5px 0 0; white-space:pre-wrap; line-height:1.35; }
    .dangerText { color:#991b1b; font-weight:700; }
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
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div class="brand">
        <h1>${appName}</h1>
        <p>Paso 7 - acciones controladas con historial y auditoria</p>
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
            <div class="muted" id="visibleCount"></div>
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
          <button class="ghost" id="closeModal">Cerrar</button>
        </div>
        <div class="modalBody">
          <section>
            <h2>Resumen</h2>
            <div class="detailGrid" id="detailGrid"></div>
          </section>
          <section id="recordSection">
            <h2>Añadir seguimiento</h2>
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
    <datalist id="responsiblesList"></datalist>
  </main>
  <script>
    let state = { usuario: null, proyectos: [], tareas: [] };
    let options = { responsables: [], estados_tarea: [], estados_proyecto: [], prioridades: [], tipos_registro: [] };
    let currentView = "projects";
    let selectedEntity = null;
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
      fillOptions($("recordType"), options.tipos_registro || ["Seguimiento"], "Seguimiento");
      fillOptions($("recordState"), states || [], itemState(item, type));
      fillOptions($("recordPriority"), options.prioridades || [], item.prioridad);
      $("recordOwner").value = itemOwner(item, type) || "";
      $("recordNextOwner").value = item.responsable_proximo_paso || itemOwner(item, type) || "";
      $("recordNextDate").value = (item.fecha_objetivo_proximo_paso || item.fecha_proxima_revision || "").slice(0, 10);
      $("recordComment").value = "";
      $("recordNextStep").value = item.proximo_paso || "";
      $("recordBlockReason").value = "";
      updateBlockReasonVisibility();
      $("recordSection").classList.toggle("hidden", (state.usuario || {}).rol === "Presidente");
      renderHistory(detail.history || []);
      renderAttachments(detail.attachments || []);
      $("entityModal").classList.remove("hidden");
      if (focusRecord) setTimeout(() => $("recordComment").focus(), 50);
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
      $("cards").innerHTML = rows.length ? rows.map(card).join("") : '<div class="empty">No hay elementos con esos filtros.</div>';
      $("projectTab").classList.toggle("active", currentView === "projects");
      $("taskTab").classList.toggle("active", currentView === "tasks");
    }

    async function loadOverview() {
      $("sessionStatus").textContent = "Cargando datos...";
      try {
        const data = await api("/api/overview");
        state = data;
        showApp();
        const user = data.usuario || {};
        $("sessionStatus").innerHTML = html(user.nombre || "") + " - " + html(user.rol || "") + " - solo lectura";
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
    $("recordState").addEventListener("change", updateBlockReasonVisibility);
    $("saveRecord").addEventListener("click", saveRecord);
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
  if (req.method === "GET" && url.pathname === "/health") {
    const databaseExists = fs.existsSync(databasePath);
    return sendJson(res, 200, {
      ok: true,
      app: appName,
      step: databaseExists ? 7 : 1,
      port,
      dataDir,
      databasePath,
      databaseConfigured: databaseExists,
      databaseSize: databaseExists ? fs.statSync(databasePath).size : 0,
      migratedRealData: databaseExists,
      authRequired: true,
      readonly: false,
      actionsEnabled: true,
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
