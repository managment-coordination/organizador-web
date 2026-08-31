import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = path.join(root, "scripts", "smoke-ai-query.mjs");
const indexSource = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const expectedHandlers = [
  "propietarios_contacto",
  "seguridad",
  "asambleas",
  "presupuesto",
  "contabilidad",
  "deuda",
  "propiedad",
  "trabajo",
];

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
    question: "deuda de florea giuliana",
    domain: "deuda",
    status: "confirmado",
    contains: "2.681,39 EUR",
    minSources: 2,
    expectedFacts: {
      deuda: 2681.39,
      deuda_propiedades_otros_titulares: 2948.85,
    },
    notContains: "tiene deuda pendiente por 5.630,24 EUR",
  },
  {
    question: "deuda de ATERRAZADA 15 -6",
    domain: "deuda",
    status: "confirmado",
    contains: "Desglose por titular/deudor",
    minSources: 2,
    expectedFacts: {
      deuda: 5630.24,
    },
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
    question: "cual es la deuda de inversiones senada",
    domain: "deuda",
    status: "confirmado",
    contains: "INVERSIONES SENADA",
    minSources: 2,
  },
  {
    question: "que propietarios tienen deuda superior a 1000 euros",
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
const mojibakePattern = /[\u00c3\u00c2\ufffd\u00be\u00bc\u00bd]/;

for (const domain of expectedHandlers) {
  if (!indexSource.includes(`"${domain}"`)) failures.push(`estructura: falta handler para ${domain}`);
}
if (/\n\s+elif query_domain ==/.test(indexSource)) {
  failures.push("estructura: queda un bloque condicional antiguo de query_domain");
}

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
  if (testCase.notContains && String(payload.answer || "").toLowerCase().includes(testCase.notContains.toLowerCase())) failures.push(`${testCase.question}: contiene texto prohibido ${testCase.notContains}`);
  if (testCase.expectedFacts) {
    for (const [key, expectedValue] of Object.entries(testCase.expectedFacts)) {
      const actualValue = Number(payload.facts?.[key]);
      if (!Number.isFinite(actualValue) || Math.abs(actualValue - Number(expectedValue)) > 0.01) {
        failures.push(`${testCase.question}: facts.${key}=${payload.facts?.[key]}, esperado ${expectedValue}`);
      }
    }
  }
  if (!Array.isArray(payload.sources) || payload.sources.length < testCase.minSources) failures.push(`${testCase.question}: fuentes insuficientes`);
  if (mojibakePattern.test(JSON.stringify(payload))) failures.push(`${testCase.question}: contiene caracteres mojibake`);
  if (["deuda", "contabilidad", "presupuesto"].includes(testCase.domain)) {
    if (!payload.freshness?.summary) failures.push(`${testCase.question}: falta aviso de vigencia economica`);
    if (!String(payload.answer || "").includes("Aviso de vigencia")) failures.push(`${testCase.question}: la respuesta no avisa de la fecha de datos`);
    const accountingSources = (payload.sources || []).filter((source) => source.module === "contabilidad");
    if (accountingSources.length && !accountingSources.some((source) => source.freshness)) failures.push(`${testCase.question}: fuentes contables sin fecha de cobertura`);
  }
  if (testCase.domain === "trabajo" && payload.freshness) failures.push(`${testCase.question}: no debe incluir vigencia economica`);
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
