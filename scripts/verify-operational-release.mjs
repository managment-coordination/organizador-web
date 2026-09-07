import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const python = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'C:/Users/EQUIPO/AppData/Local/Programs/Python/Python314/python.exe' : 'python3');
const fixture = path.resolve(process.env.VERIFY_SOURCE_DB || path.join(root, 'data/ai-audit.db'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'organizador-release-'));
const database = path.join(temp, 'test.db');
const env = { ...process.env, PYTHONPATH:path.join(root,'server'), PYTHONUTF8:'1', PYTHONIOENCODING:'utf-8' };
const results = [];
const password = 'Only-local-fixture-629';
function pythonRun(code, args=[]) {
  const run = spawnSync(python, ['-', ...args], { input:code, encoding:'utf8', env, maxBuffer:4*1024*1024 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return run.stdout.trim();
}
pythonRun(`import sqlite3,sys,hashlib
from access_control import migrate
source=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
target=sqlite3.connect(sys.argv[2]); target.row_factory=sqlite3.Row
source.backup(target); source.close()
before={r[0]:target.execute('SELECT COUNT(*) FROM "'+r[0]+'"').fetchone()[0] for r in target.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()}
migrate(target)
for table,count in before.items():
    assert target.execute('SELECT COUNT(*) FROM "'+table+'"').fetchone()[0]==count, table
assert target.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
salt='release-fixture'; digest=hashlib.pbkdf2_hmac('sha256',sys.argv[3].encode(),salt.encode(),260000).hex()
with target:
    target.execute("UPDATE usuarios SET password_hash=?,password_configurada=1,requiere_cambio_password=0,bloqueado=0 WHERE id_usuario=1",('pbkdf2_sha256$260000$'+salt+'$'+digest,))
print('Migration: data counts and integrity preserved')
`, [fixture,database,password]);
results.push('Migration preserves rows, relationships and integrity');

const socket = net.createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port = socket.address().port;
await new Promise(resolve=>socket.close(resolve));
let serverLog = '';
const child = spawn(process.execPath, [path.join(root,'server/index.js')], {cwd:root,env:{...env,PORT:String(port),HOST:'127.0.0.1',DATABASE_PATH:database,DATA_DIR:path.join(temp,'files'),PYTHON_BIN:python,AI_PROVIDER:'local',AI_API_KEY:'',NVIDIA_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',d=>serverLog+=d);
child.stderr.on('data',d=>serverLog+=d);
const base = `http://127.0.0.1:${port}`;
async function request(url, cookie='', body, status=200, method=body===undefined?'GET':'POST') {
  const response = await fetch(base+url,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const value = await response.json();
  assert.equal(response.status,status,`${method} ${url}: ${JSON.stringify(value)}`);
  return {value,cookie:response.headers.get('set-cookie')?.split(';')[0] || cookie};
}
async function login(name, pass=password) {return (await request('/api/login','',{usuario:name,password:pass})).cookie;}
try {
  for (let i=0;i<100;i++) {
    if(child.exitCode!==null) throw new Error(serverLog);
    try {await request('/health'); break;}catch(error){if(i===99)throw error; await delay(100);}
  }
  const rootName = pythonRun("import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('SELECT nombre FROM usuarios WHERE id_usuario=1').fetchone()[0])",[database]);
  let admin = await login(rootName);
  const adminAction = async (action,data)=> (await request('/api/admin/action',admin,{action,data})).value;
  const communityA = (await adminAction('save_community',{nombre:'Verification A',activo:true})).id_comunidad;
  const communityB = (await adminAction('save_community',{nombre:'Verification B',activo:true})).id_comunidad;
  async function user(name,rol,community_ids,extra={}) {
    const record = await adminAction('save_user',{nombre:name,rol,activo:true,community_ids,...extra});
    await request('/api/auth/first-access','',{usuario:name,clave_temporal:record.temporary_key,password,confirmacion:password});
    return {id:record.id_usuario,name,cookie:await login(name)};
  }
  const worker=await user('Verification Worker','Usuario',[communityA,communityB],{community_permissions:[{id_comunidad:communityA,rol_en_comunidad:'Usuario'},{id_comunidad:communityB,rol_en_comunidad:'Consulta'}]});
  const other=await user('Verification Other','Usuario',[communityB]);
  const president=await user('Verification President A','Presidente',[communityA]);
  const presidentB=await user('Verification President B','Presidente',[communityB]);
  const guard=await user('Verification Security A','Seguridad',[communityA]);
  const guardB=await user('Verification Security B','Seguridad',[communityB]);
  const read=await user('Verification Read','Consulta',[communityA]);
  const reviewer=await user('Verification Reviewer','Usuario',[communityA],{gestionar_seguridad:true,community_permissions:[{id_comunidad:communityA,rol_en_comunidad:'Usuario',puede_gestionar_seguridad:1}]});
  results.push('First access with temporary key and real named roles');
  for(const u of [worker,other,president,presidentB,guard,read]) await request('/api/admin',u.cookie,undefined,403);
  await request('/api/overview',guard.cookie,undefined,403);
  for(const url of ['/api/reports-center','/api/daily-operations','/api/assemblies','/api/options','/api/global-search?q=Verification']) await request(url,president.cookie,undefined,403);
  for(const u of [admin,worker.cookie,other.cookie,read.cookie]) for(const url of ['/api/overview','/api/workflow','/api/daily-operations','/api/options','/api/reports-center','/api/assemblies']) await request(url,u);
  await request('/api/overview',president.cookie);
  results.push('Role boundaries and all primary read endpoints');
  const create = async (u,type,cid,title)=> (await request('/api/entity/create',u,{type,payload:{id_comunidad:cid,titulo:title,comentario:'Initial context',categoria:'Mantenimiento',estado_nuevo:'Pendiente',prioridad_nueva:'Media',extra:null,flag:false}})).value.id;
  const task=await create(worker.cookie,'task',communityA,'Independent verification task');
  const project=await create(worker.cookie,'project',communityA,'Verification project A');
  const projectB=await create(other.cookie,'project',communityB,'Verification project B');
  const initial = (await request(`/api/entity/detail?type=task&id=${task}`,worker.cookie)).value;
  assert.equal(initial.item.id_proyecto,null);
  await request('/api/entity/create',worker.cookie,{type:'task',payload:{id_comunidad:communityB,titulo:'Forbidden'}},403);
  await request('/api/entity/create',read.cookie,{type:'task',payload:{id_comunidad:communityA,titulo:'Forbidden'}},403);
  await request('/api/entity/record',worker.cookie,{type:'project',id:projectB,payload:{comentario:'Forbidden update'}},403);
  await request(`/api/entity/detail?type=project&id=${project}`,other.cookie,undefined,403);
  results.push('Independent tasks, JSON booleans/nulls, per-community read/write access');
  const write = (payload)=>request('/api/entity/record',worker.cookie,{type:'project',id:project,payload});
  await write({comentario:'Request a decision',proximo_paso:'Confirm the estimate',responsable_proximo_paso:president.name,estado_nuevo:'En curso',motivo_bloqueo:''});
  const workflow=(await request('/api/workflow',president.cookie)).value;
  const decision=workflow.president_requests.find(row=>Number(row.id_proyecto)===project);
  assert.ok(decision,'Named president did not receive request');
  assert.ok(!(await request('/api/workflow',presidentB.cookie)).value.president_requests.some(row=>row.id_solicitud===decision.id_solicitud));
  await request(`/api/entity/detail?type=project&id=${project}`,president.cookie);
  await request(`/api/entity/detail?type=task&id=${task}`,president.cookie,undefined,403);
  await request('/api/president/respond',presidentB.cookie,{id:decision.id_solicitud,decision:'Aprobada',comment:'Wrong president'},403);
  await request('/api/president/respond',president.cookie,{id:decision.id_solicitud,decision:'Aprobada',comment:''},400);
  await request('/api/president/respond',president.cookie,{id:decision.id_solicitud,decision:'Aprobada',comment:'Approved with estimate review'});
  await request('/api/president/respond',president.cookie,{id:decision.id_solicitud,decision:'Aprobada',comment:'Duplicate'},400);
  const detail=(await request(`/api/entity/detail?type=project&id=${project}`,worker.cookie)).value;
  assert.equal(detail.item.responsable_proximo_paso,worker.name);
  assert.ok(detail.history.some(row=>row.comentario.includes('Approved with estimate review')));
  results.push('Presidency routing, mandatory comment, one decision, return responsibility and audit');
  const upload=await fetch(base+`/api/entity/attachment?type=task&id=${task}`,{method:'POST',headers:{Cookie:worker.cookie,'X-File-Name':'evidence.txt','Content-Type':'text/plain'},body:'Verification attachment, independently from follow-up.'});
  assert.equal(upload.status,200,await upload.clone().text());
  const attached=(await request(`/api/entity/detail?type=task&id=${task}`,worker.cookie)).value.attachments.at(0);
  assert.ok(attached);
  const download=await fetch(base+`/api/attachment?id=${attached.id_anexo}`,{headers:{Cookie:worker.cookie}});
  assert.equal(download.status,200);
  assert.ok((await download.text()).includes('Verification attachment'));
  await request(`/api/attachment?id=${attached.id_anexo}`,other.cookie,undefined,403);
  const report=(await request('/api/report/generate',worker.cookie,{type:'task',id:task})).value;
  const word=await fetch(base+`/api/report/download?id=${report.report_id}`,{headers:{Cookie:worker.cookie}});
  assert.equal(word.status,200);
  assert.equal(Buffer.from(await word.arrayBuffer()).subarray(0,2).toString(),'PK');
  results.push('Attachment upload/open and Word generation/download');
  const guardAccess=(await request('/api/security/access',guard.cookie)).value;
  assert.ok(guardAccess.can_upload && !guardAccess.can_manage);
  const securityUpload=async(cookie,cid)=> {
    const response=await fetch(base+`/api/security/upload?community=${cid}`,{method:'POST',headers:{Cookie:cookie,'X-File-Name':'verification.txt','Content-Type':'text/plain'},body:'Informe diario de Seguridad. Fecha 07/09/2026. Ronda sin incidencias. Revision de accesos completada.'});
    const payload=await response.json();assert.equal(response.status,200,JSON.stringify(payload));return payload;
  };
  const securityDoc=await securityUpload(guard.cookie,communityA);
  const otherSecurityDoc=await securityUpload(guardB.cookie,communityB);
  assert.notEqual(securityDoc.document_id,otherSecurityDoc.document_id);
  assert.ok((await securityUpload(guard.cookie,communityA)).duplicate_document);
  const securityOverview=(await request('/api/security/overview',reviewer.cookie)).value;
  assert.ok(securityOverview.documents.some(row=>row.id_documento===securityDoc.document_id));
  assert.ok(!securityOverview.documents.some(row=>row.id_documento===otherSecurityDoc.document_id));
  const part=await fetch(base+`/api/security/document?id=${securityDoc.document_id}`,{headers:{Cookie:reviewer.cookie}});
  assert.equal(part.status,200);
  await request('/api/security/overview',guard.cookie,undefined,403);
  const lookup=(await request('/api/security/lookup',guard.cookie,{query:'villa 98'})).value;
  assert.equal(lookup.total,0,'Legacy Macrocomunidad owner data leaked to another community');
  results.push('Security upload, deduplication and documents isolated by community');
  const scoped = await request('/api/session/community-scope',worker.cookie,{scope:'one',id_comunidad:communityB});
  const scopedOverview=(await request('/api/overview',scoped.cookie)).value;
  assert.ok(!scopedOverview.proyectos.some(row=>row.id_proyecto===project));
  const debt=(await request('/api/ai/query',other.cookie,{text:'dame listado de deudores'})).value;
  assert.ok(!JSON.stringify(debt).includes('FLOREA'),'Cross-community accounting leak');
  results.push('Community selector and accounting query isolation');
  const assemblyAction=(cookie,action,data)=>request('/api/assembly/action',cookie,{action,data});
  const assembly=(await assemblyAction(worker.cookie,'create',{id_comunidad:communityA,codigo:'VERIFY-RELEASE',nombre:'Verification assembly',fecha:'2026-09-09'})).value.id;
  await assemblyAction(worker.cookie,'update',{id:assembly,hora_inicio:'18:00',presidente:president.name,administrador:worker.name,lugar_celebracion:'Office'});
  await assemblyAction(worker.cookie,'save_points',{id:assembly,points:[{titulo:'Verification point',tipo_mayoria:'simple'}]});
  const assemblyDetail=(await request(`/api/assembly/detail?id=${assembly}`,worker.cookie)).value;
  assert.ok(JSON.stringify(assemblyDetail).includes('Verification point'));
  assert.ok(JSON.stringify(assemblyDetail).includes('18:00'));
  await request(`/api/assembly/detail?id=${assembly}`,other.cookie,undefined,403);
  await request('/api/assembly/action',read.cookie,{action:'update',data:{id:assembly,nombre:'Forbidden'}},403);
  await request('/api/assembly/action',worker.cookie,{action:'create',data:{id_comunidad:communityB,codigo:'FORBIDDEN',nombre:'Forbidden'}},403);
  results.push('Assembly creation, editing, agenda and community/write restrictions');
  const ai=(await request('/api/ai/center',worker.cookie,{text:'que tareas tengo pendientes',mode:'consulta'})).value;
  assert.ok(ai.ok !== false,JSON.stringify(ai));
  for(const url of ['/api/agent/context','/api/ai/history','/api/ai/rules']) await request(url,worker.cookie);
  await request('/api/ai/rules/action',worker.cookie,{action:'learn_redaction',data:{source_text:'Private community A preference',original_payload:{comentario:'old'},final_payload:{comentario:'Private community A preference'}}});
  const ownMemory=(await request('/api/ai/rules',worker.cookie)).value;
  assert.ok(JSON.stringify(ownMemory).includes('Private community A preference'));
  assert.ok(!JSON.stringify((await request('/api/ai/rules',other.cookie)).value).includes('Private community A preference'));
  results.push('AI center response, JSON history persistence and private memory isolation');
  await adminAction('save_user',{id_usuario:worker.id,nombre:worker.name,rol:'Usuario',activo:false,community_ids:[communityA,communityB]});
  await request('/api/me',worker.cookie,undefined,401);
  await adminAction('reset_password',{id_usuario:other.id});
  await request('/api/me',other.cookie,undefined,401);
  const failedKey=await adminAction('save_user',{nombre:'Verification Temporary','rol':'Usuario',activo:true,community_ids:[communityA]});
  for(let i=0;i<6;i++)await request('/api/auth/first-access','',{usuario:'Verification Temporary',clave_temporal:'bad-key',password,confirmacion:password},400);
  await request('/api/auth/first-access','',{usuario:'Verification Temporary',clave_temporal:failedKey.temporary_key,password,confirmacion:password});
  results.push('Immediate revocation after deactivation/reset; failed attempts do not lock account');
  console.log(JSON.stringify({ok:true,checks:results,fixture:temp},null,2));
} finally {
  child.kill();
  await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
  if(process.env.KEEP_VERIFY_FIXTURE!=='1') fs.rmSync(temp,{recursive:true,force:true});
}
