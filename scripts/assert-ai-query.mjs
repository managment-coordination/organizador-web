import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = path.join(root, "scripts", "smoke-ai-query.mjs");

const cases = [
  {
    question: "quien es el propietario con email icogo23@hotmail.com",
    domain: "propietarios_contacto",
    status: "confirmado",
    contains: "CLEVERIS RANK INMO",
    minSources: 2,
  },
  {
    question: "que deuda tiene PROMAGA",
    domain: "deuda",
    status: "confirmado",
    contains: "PROMAGA",
    minSources: 2,
  },
  {
    question: "quien es el propietario de CB 2 -1 DCH",
    domain: "propiedad",
    status: "confirmado",
    contains: "REAL ESTATE INVESTMENT CAPITAL",
    minSources: 2,
  },
  {
    question: "dame listado de deudores",
    domain: "deuda",
    status: "confirmado",
    contains: "propietarios",
    minSources: 1,
  },
  {
    question: "estado del proyecto isletas",
    domain: "trabajo",
    status: "confirmado",
    contains: "Isletas",
    minSources: 2,
  },
  {
    question: "como van los presupuestos",
    domain: "presupuesto",
    status: "confirmado",
    contains: "Presupuesto",
    minSources: 1,
  },
  {
    question: "balance financiero desde 01/01/2026 hasta 30/08/2026",
    domain: "contabilidad",
    status: "inferido",
    contains: "Balance financiero",
    minSources: 3,
  },
  {
    question: "resumen de la ultima asamblea",
    domain: "asambleas",
    status: "confirmado",
    contains: "asamblea",
    minSources: 3,
  },
  {
    question: "resultado del punto 3 de la ultima asamblea",
    domain: "asambleas",
    status: "confirmado",
    contains: "punto 3",
    minSources: 2,
  },
  {
    question: "que incidencias de seguridad estan pendientes",
    domain: "seguridad",
    status: "confirmado",
    contains: "Seguridad",
    minSources: 2,
  },
];

const failures = [];

function runQuery(question, env = {}) {
  const result = spawnSync(process.execPath, [smokeScript, question], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 12 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "fallo sin salida");
  }
  return JSON.parse(result.stdout);
}

for (const testCase of cases) {
  let payload;
  try {
    payload = runQuery(testCase.question, { AI_SMOKE_ROLE: "Superusuario", AI_SMOKE_USER_ID: "1" });
  } catch (error) {
    failures.push(`${testCase.question}: ${error.message}`);
    continue;
  }
  if (payload.action !== "consulta") failures.push(`${testCase.question}: action ${payload.action}`);
  if (payload.query_domain !== testCase.domain) failures.push(`${testCase.question}: domain ${payload.query_domain}, esperado ${testCase.domain}`);
  if (payload.data_status !== testCase.status) failures.push(`${testCase.question}: status ${payload.data_status}, esperado ${testCase.status}`);
  if (!String(payload.answer || "").toLowerCase().includes(testCase.contains.toLowerCase())) failures.push(`${testCase.question}: no contiene ${testCase.contains}`);
  if (!Array.isArray(payload.sources) || payload.sources.length < testCase.minSources) failures.push(`${testCase.question}: fuentes insuficientes`);
}

try {
  const payload = runQuery("que incidencias de seguridad estan pendientes", {
    AI_SMOKE_ROLE: "Presidente",
    AI_SMOKE_USER_ID: "999",
  });
  if (payload.query_domain !== "seguridad") failures.push("seguridad sin permiso: dominio incorrecto");
  if (!String(payload.answer || "").includes("no tiene permiso")) failures.push("seguridad sin permiso: no deniega acceso");
  if (Array.isArray(payload.sources) && payload.sources.length) failures.push("seguridad sin permiso: expone fuentes");
} catch (error) {
  failures.push(`seguridad sin permiso: ${error.message}`);
}

try {
  const payload = runQuery("estado del proyecto isletas", {
    AI_SMOKE_ROLE: "Usuario",
    AI_SMOKE_USER_ID: "999",
    AI_SMOKE_COMMUNITIES: "7",
  });
  if (payload.query_domain !== "trabajo") failures.push("comunidad limitada trabajo: dominio incorrecto");
  if (payload.data_status !== "incompleto") failures.push("comunidad limitada trabajo: deberia quedar incompleto");
  if (!String(payload.answer || "").includes("No he encontrado")) failures.push("comunidad limitada trabajo: no oculta proyecto no permitido");
} catch (error) {
  failures.push(`comunidad limitada trabajo: ${error.message}`);
}

try {
  const payload = runQuery("resumen de la ultima asamblea", {
    AI_SMOKE_ROLE: "Usuario",
    AI_SMOKE_USER_ID: "999",
    AI_SMOKE_COMMUNITIES: "7",
  });
  if (payload.query_domain !== "asambleas") failures.push("comunidad limitada asambleas: dominio incorrecto");
  if (payload.data_status !== "incompleto") failures.push("comunidad limitada asambleas: deberia quedar incompleto");
  if (!String(payload.answer || "").includes("No he encontrado asambleas")) failures.push("comunidad limitada asambleas: no oculta asamblea no permitida");
} catch (error) {
  failures.push(`comunidad limitada asambleas: ${error.message}`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, cases: cases.length, permission_checks: 3 }, null, 2));
