import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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

function queryOverview() {
  return new Promise((resolve, reject) => {
    const script = `
import json
import sqlite3

path = r'''${databasePath.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'''
conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row

def rows(sql, params=()):
    return [dict(row) for row in conn.execute(sql, params).fetchall()]

def one(sql, params=()):
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else {}

counts = {
    "usuarios": one("SELECT COUNT(*) AS total FROM usuarios").get("total", 0),
    "comunidades": one("SELECT COUNT(*) AS total FROM comunidades WHERE COALESCE(activo, 1) = 1").get("total", 0),
    "proyectos_activos": one("SELECT COUNT(*) AS total FROM proyectos WHERE COALESCE(activo, 1) = 1").get("total", 0),
    "tareas_activas": one("SELECT COUNT(*) AS total FROM tareas WHERE COALESCE(activa, 1) = 1 AND COALESCE(archivada, 0) = 0").get("total", 0),
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
    ORDER BY
      CASE p.prioridad WHEN 'Urgente' THEN 1 WHEN 'Alta' THEN 2 WHEN 'Media' THEN 3 ELSE 4 END,
      COALESCE(p.fecha_objetivo_proximo_paso, '') ASC,
      p.nombre ASC
    LIMIT 80
""")

tareas = rows("""
    SELECT t.id_tarea, t.titulo, t.categoria, t.estado, t.prioridad,
           t.responsable, t.responsable_proximo_paso, t.proximo_paso,
           t.fecha_proxima_revision, t.fecha_objetivo_proximo_paso,
           t.fecha_ultima_actualizacion, p.nombre AS proyecto, c.nombre AS comunidad
    FROM tareas t
    LEFT JOIN proyectos p ON p.id_proyecto = t.id_proyecto
    LEFT JOIN comunidades c ON c.id_comunidad = t.id_comunidad
    WHERE COALESCE(t.activa, 1) = 1 AND COALESCE(t.archivada, 0) = 0
    ORDER BY
      CASE t.prioridad WHEN 'Urgente' THEN 1 WHEN 'Alta' THEN 2 WHEN 'Media' THEN 3 ELSE 4 END,
      COALESCE(t.fecha_proxima_revision, t.fecha_objetivo_proximo_paso, '') ASC,
      t.titulo ASC
    LIMIT 120
""")

estados_tareas = rows("SELECT COALESCE(estado, 'Sin estado') AS estado, COUNT(*) AS total FROM tareas WHERE COALESCE(activa, 1) = 1 AND COALESCE(archivada, 0) = 0 GROUP BY COALESCE(estado, 'Sin estado') ORDER BY total DESC")
estados_proyectos = rows("SELECT COALESCE(estado_general, 'Sin estado') AS estado, COUNT(*) AS total FROM proyectos WHERE COALESCE(activo, 1) = 1 GROUP BY COALESCE(estado_general, 'Sin estado') ORDER BY total DESC")

conn.close()
print(json.dumps({
    "counts": counts,
    "proyectos": proyectos,
    "tareas": tareas,
    "estados_tareas": estados_tareas,
    "estados_proyectos": estados_proyectos,
}, ensure_ascii=False))
`;
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

function homePage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${appName}</title>
  <style>
    :root { --bg:#eef2f7; --ink:#111827; --muted:#64748b; --line:#dbe3ef; --blue:#1d4ed8; --green:#15803d; --amber:#b45309; --red:#b91c1c; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: var(--bg); color: var(--ink); }
    header { background:#0f172a; color:white; padding:18px 22px; display:flex; justify-content:space-between; gap:16px; align-items:center; }
    header h1 { margin:0; font-size:24px; }
    main { max-width: 1440px; margin: 0 auto; padding: 18px; }
    section { background: white; border: 1px solid var(--line); border-radius: 8px; padding: 14px; }
    h2 { margin: 0 0 10px; font-size: 20px; }
    .muted { color: var(--muted); }
    .grid { display:grid; gap:12px; }
    .counts { grid-template-columns: repeat(6, minmax(120px, 1fr)); margin-bottom:12px; }
    .count { background:white; border:1px solid var(--line); border-radius:8px; padding:12px; }
    .count strong { display:block; font-size:26px; }
    .split { grid-template-columns: 1fr 1fr; align-items:start; }
    .toolbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px; }
    input, select { border:1px solid #cbd5e1; border-radius:6px; padding:9px 10px; font:14px Segoe UI, Arial, sans-serif; min-width: 170px; }
    .cards { display:grid; grid-template-columns: repeat(auto-fill, minmax(285px, 1fr)); gap:10px; }
    .card { border:1px solid var(--line); border-left:5px solid #94a3b8; border-radius:8px; padding:11px; background:#fff; min-height:142px; }
    .card h3 { margin:0 0 6px; font-size:16px; line-height:1.25; }
    .meta { display:flex; gap:6px; flex-wrap:wrap; margin:8px 0; }
    .pill { border-radius:999px; padding:4px 8px; font-size:12px; font-weight:700; background:#eef2f7; color:#334155; }
    .prioridad-Urgente { border-left-color:#b91c1c; }
    .prioridad-Alta { border-left-color:#ea580c; }
    .prioridad-Media { border-left-color:#b45309; }
    .prioridad-Baja { border-left-color:#15803d; }
    .estado-Pendiente { background:#fef3c7; color:#78350f; }
    .estado-En-curso { background:#dbeafe; color:#1e3a8a; }
    .estado-Pendiente-de-tercero { background:#ffedd5; color:#7c2d12; }
    .estado-Bloqueada, .estado-Bloqueado { background:#fee2e2; color:#7f1d1d; }
    .estado-Terminada, .estado-Finalizado { background:#dcfce7; color:#14532d; }
    .line { font-size:13px; color:#334155; margin-top:5px; }
    .empty { padding:16px; color:var(--muted); border:1px dashed #cbd5e1; border-radius:8px; }
    button { border:0; border-radius:6px; background:var(--blue); color:white; padding:10px 13px; font-weight:700; cursor:pointer; }
    @media (max-width: 1000px) { .split, .counts { grid-template-columns:1fr; } header { align-items:flex-start; flex-direction:column; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${appName}</h1>
      <div class="muted" style="color:#cbd5e1">Paso 4 · lectura de datos reales · sin edicion</div>
    </div>
    <div id="status">Cargando...</div>
  </header>
  <main>
    <div class="grid counts" id="counts"></div>
    <div class="grid split">
      <section>
        <h2>Proyectos</h2>
        <div class="toolbar">
          <input id="projectSearch" placeholder="Buscar proyecto..." />
          <select id="projectState"><option value="">Todos los estados</option></select>
          <button id="reload">Actualizar</button>
        </div>
        <div class="cards" id="projects"></div>
      </section>
      <section>
        <h2>Tareas</h2>
        <div class="toolbar">
          <input id="taskSearch" placeholder="Buscar tarea..." />
          <select id="taskState"><option value="">Todos los estados</option></select>
        </div>
        <div class="cards" id="tasks"></div>
      </section>
    </div>
  </main>
  <script>
    let state = { proyectos: [], tareas: [] };
    const $ = (id) => document.getElementById(id);
    const safe = (value) => String(value || "").trim();
    const slug = (value) => safe(value).replaceAll(" ", "-").replaceAll("/", "-");

    function countCard(label, value) {
      return '<div class="count"><span class="muted">' + label + '</span><strong>' + value + '</strong></div>';
    }

    function fillSelect(select, rows, field) {
      const current = select.value;
      const values = [...new Set(rows.map(row => safe(row[field])).filter(Boolean))].sort();
      select.innerHTML = '<option value="">Todos los estados</option>' + values.map(value => '<option>' + value + '</option>').join('');
      select.value = values.includes(current) ? current : "";
    }

    function card(row, type) {
      const title = type === "project" ? row.nombre : row.titulo;
      const stateText = type === "project" ? row.estado_general : row.estado;
      const owner = type === "project" ? row.responsable_principal : row.responsable;
      const nextOwner = row.responsable_proximo_paso || "";
      const date = row.fecha_objetivo_proximo_paso || row.fecha_proxima_revision || "";
      const next = row.proximo_paso || "";
      const project = type === "task" && row.proyecto ? '<div class="line"><strong>Proyecto:</strong> ' + row.proyecto + '</div>' : "";
      return '<article class="card prioridad-' + slug(row.prioridad) + '">' +
        '<h3>' + title + '</h3>' +
        '<div class="meta">' +
          '<span class="pill estado-' + slug(stateText) + '">' + stateText + '</span>' +
          '<span class="pill">' + safe(row.prioridad || "Sin prioridad") + '</span>' +
          '<span class="pill">' + safe(row.comunidad || "Sin comunidad") + '</span>' +
        '</div>' +
        project +
        '<div class="line"><strong>Responsable:</strong> ' + safe(owner || "Sin responsable") + '</div>' +
        '<div class="line"><strong>Proximo:</strong> ' + safe(nextOwner || "Sin asignar") + (date ? " · " + date : "") + '</div>' +
        (next ? '<div class="line"><strong>Paso:</strong> ' + next + '</div>' : '') +
        '</article>';
    }

    function render() {
      const ps = safe($("projectSearch").value).toLowerCase();
      const ts = safe($("taskSearch").value).toLowerCase();
      const pState = $("projectState").value;
      const tState = $("taskState").value;
      const projects = state.proyectos.filter(row =>
        (!pState || row.estado_general === pState) &&
        (!ps || [row.nombre, row.categoria, row.responsable_principal, row.comunidad].join(" ").toLowerCase().includes(ps))
      );
      const tasks = state.tareas.filter(row =>
        (!tState || row.estado === tState) &&
        (!ts || [row.titulo, row.categoria, row.responsable, row.proyecto, row.proximo_paso, row.comunidad].join(" ").toLowerCase().includes(ts))
      );
      $("projects").innerHTML = projects.length ? projects.map(row => card(row, "project")).join("") : '<div class="empty">No hay proyectos con ese filtro.</div>';
      $("tasks").innerHTML = tasks.length ? tasks.map(row => card(row, "task")).join("") : '<div class="empty">No hay tareas con ese filtro.</div>';
    }

    async function load() {
      $("status").textContent = "Cargando datos...";
      const response = await fetch("/api/overview", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudieron cargar datos.");
      state = data;
      $("counts").innerHTML =
        countCard("Usuarios", data.counts.usuarios) +
        countCard("Comunidades", data.counts.comunidades) +
        countCard("Proyectos activos", data.counts.proyectos_activos) +
        countCard("Tareas activas", data.counts.tareas_activas) +
        countCard("Asambleas", data.counts.asambleas) +
        countCard("Propiedades", data.counts.propiedades_contabilidad);
      fillSelect($("projectState"), data.proyectos, "estado_general");
      fillSelect($("taskState"), data.tareas, "estado");
      $("status").textContent = "Solo lectura · " + new Date().toLocaleString();
      render();
    }

    $("projectSearch").addEventListener("input", render);
    $("taskSearch").addEventListener("input", render);
    $("projectState").addEventListener("change", render);
    $("taskState").addEventListener("change", render);
    $("reload").addEventListener("click", load);
    load().catch(error => {
      $("status").textContent = "Error";
      $("counts").innerHTML = '<section class="empty">' + error.message + '</section>';
    });
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    return sendHtml(res, 200, homePage());
  }
  if (req.method === "GET" && url.pathname === "/api/overview") {
    if (!fs.existsSync(databasePath)) {
      return sendJson(res, 404, { ok: false, error: "Todavia no existe base de datos migrada." });
    }
    queryOverview()
      .then((overview) => sendJson(res, 200, overview))
      .catch((error) => sendJson(res, 500, { ok: false, error: error.message }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    const databaseExists = fs.existsSync(databasePath);
    return sendJson(res, 200, {
      ok: true,
      app: appName,
      step: databaseExists ? 3 : 1,
      port,
      dataDir,
      databasePath,
      databaseConfigured: databaseExists,
      databaseSize: databaseExists ? fs.statSync(databasePath).size : 0,
      migratedRealData: databaseExists,
      timestamp: new Date().toISOString()
    });
  }
  return sendJson(res, 404, { ok: false, error: "Ruta no encontrada." });
});

server.listen(port, host, () => {
  console.log(`${appName} escuchando en http://${host}:${port}`);
});
