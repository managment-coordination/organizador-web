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
    .empty { padding:16px; color:var(--muted); border:1px dashed #cbd5e1; border-radius:8px; }
    button { border:0; border-radius:6px; background:var(--blue); color:white; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#64748b; }
    button.ghost { background:#e2e8f0; color:#1f2937; }
    .login { max-width:440px; margin:44px auto; box-shadow:var(--shadow); }
    .login h2 { font-size:24px; }
    .login input, .login select, .login button { width:100%; margin-bottom:8px; }
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
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <div class="brand">
        <h1>${appName}</h1>
        <p>Paso 6 - lectura optimizada para movil y escritorio</p>
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
  </main>
  <script>
    let state = { usuario: null, proyectos: [], tareas: [] };
    let currentView = "projects";
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
  if (req.method === "GET" && url.pathname === "/health") {
    const databaseExists = fs.existsSync(databasePath);
    return sendJson(res, 200, {
      ok: true,
      app: appName,
      step: databaseExists ? 6 : 1,
      port,
      dataDir,
      databasePath,
      databaseConfigured: databaseExists,
      databaseSize: databaseExists ? fs.statSync(databasePath).size : 0,
      migratedRealData: databaseExists,
      authRequired: true,
      readonly: true,
      timestamp: new Date().toISOString()
    });
  }
  return sendJson(res, 404, { ok: false, error: "Ruta no encontrada." });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
});

server.listen(port, host, () => {
  console.log(`${appName} escuchando en http://${host}:${port}`);
});
