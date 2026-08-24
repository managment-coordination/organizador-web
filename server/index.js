import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

loadEnv(path.join(rootDir, ".env"));

const port = Number(process.env.PORT || 8771);
const host = process.env.HOST || "0.0.0.0";
const appName = process.env.APP_NAME || "Organizador Web";
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

function homePage() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${appName}</title>
  <style>
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #eef2f7; color: #111827; }
    main { max-width: 920px; margin: 0 auto; padding: 28px; }
    section { background: white; border: 1px solid #dbe3ef; border-radius: 8px; padding: 20px; }
    h1 { margin: 0 0 8px; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${appName}</h1>
      <p>Base web creada. Paso 1 activo, sin datos reales migrados.</p>
      <p>Estado tecnico: <code>/health</code></p>
    </section>
  </main>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") {
    return sendHtml(res, 200, homePage());
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
