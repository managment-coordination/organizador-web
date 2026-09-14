// Execute the actual embedded query, not a parallel reimplementation of its bank router.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pythonScript} from '../server/python-template.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixture=path.resolve(process.argv[2]);
assert(fixture.split(path.sep).some(p=>p.startsWith('organizador-erp5-foundations-')),'Independent synthetic fixture required');
const config=JSON.parse(fs.readFileSync(fixture,'utf8'));
assert.equal(path.dirname(config.db),path.dirname(fixture));
const source=fs.readFileSync(path.join(root,'server/index.js'),'utf8');
const begin=source.indexOf('function querySmartAssistant(session, text) {');
const end=source.indexOf('\nfunction extractDebtEmailTarget(',begin);
assert(begin>0&&end>begin);
const context=vm.createContext({pythonScript,databasePath:config.db,runPythonJson:script=>{
  const result=spawnSync(process.env.PYTHON_BIN||'python',['-c',script],{cwd:path.join(root,'server'),encoding:'utf8',maxBuffer:8*1024*1024,
    env:{...process.env,PYTHONPATH:path.join(root,'server')+path.delimiter+(process.env.PYTHONPATH||'')}});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim());
}});
vm.runInContext(source.slice(begin,end),context);
const answer=context.querySmartAssistant(config.session,'Balance financiero desde 01/09/2026 hasta 30/09/2026');
const card=answer.display.cards.find(c=>c.label==='Saldo final banco');
assert(card,'Bank summary card must be present');
assert.equal(card.value,config.expected);
assert(answer.sources.some(s=>s.table==='erp5.bank.period'));
assert(!answer.sources.some(s=>s.table==='cf_extractos_banco_lineas'));
assert(answer.display.note.includes('ERP 5')||answer.display.note.includes('ERP5'));
console.log(JSON.stringify({ok:true,consumer:'querySmartAssistant',bankValue:card.value,legacySourceJoined:false}));
