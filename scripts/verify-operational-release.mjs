import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
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
previous_migrations=set(tuple(r) for r in target.execute('SELECT * FROM web_migrations')) if 'web_migrations' in before else set()
previous_erp_migrations=set(tuple(r) for r in target.execute('SELECT * FROM erp_schema_migrations')) if 'erp_schema_migrations' in before else set()
migrate(target)
for table,count in before.items():
    if table=='web_migrations':
        assert previous_migrations.issubset(set(tuple(r) for r in target.execute('SELECT * FROM web_migrations')))
        continue
    if table=='erp_schema_migrations':
        assert previous_erp_migrations.issubset(set(tuple(r) for r in target.execute('SELECT * FROM erp_schema_migrations')))
        continue
    assert target.execute('SELECT COUNT(*) FROM "'+table+'"').fetchone()[0]==count, table
assert target.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
salt='release-fixture'; digest=hashlib.pbkdf2_hmac('sha256',sys.argv[3].encode(),salt.encode(),260000).hex()
with target:
    target.execute("UPDATE usuarios SET password_hash=?,password_configurada=1,requiere_cambio_password=0,bloqueado=0 WHERE id_usuario=1",('pbkdf2_sha256$260000$'+salt+'$'+digest,))
print('Migration: data counts and integrity preserved')
`, [fixture,database,password]);
results.push('Migration preserves rows, relationships and integrity');
const erpFoundations = spawnSync(python,[path.join(root,'scripts/verify-erp0-foundations.py'),database],{encoding:'utf8',env,maxBuffer:4*1024*1024});
assert.equal(erpFoundations.status,0,erpFoundations.stderr || erpFoundations.stdout);
assert.equal(JSON.parse(erpFoundations.stdout).ok,true);
results.push('ERP0 rollback, audit, outbox, migration replay, backup-ready schema and SQLite integrity');

const socket = net.createServer();
await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port = socket.address().port;
await new Promise(resolve=>socket.close(resolve));
let serverLog = '';
const child = spawn(process.execPath, [path.join(root,'server/index.js')], {cwd:root,env:{...env,PORT:String(port),HOST:'127.0.0.1',DATABASE_PATH:database,DATA_DIR:path.join(temp,'files'),PYTHON_BIN:python,AI_PROVIDER:'local',AI_API_KEY:'',NVIDIA_API_KEY:'',OPENAI_API_KEY:'',ERP0_REFERENCE_COMMANDS:'1'},stdio:['ignore','pipe','pipe']});
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
  const wrongPassword=(await request('/api/login','',{usuario:rootName,password:'incorrect-password'},401)).value;
  const unknownUser=(await request('/api/login','',{usuario:'Nonexistent-login-fixture',password:'incorrect-password'},401)).value;
  assert.deepEqual(wrongPassword,unknownUser);
  assert.equal(wrongPassword.code,'INVALID_CREDENTIALS');
  assert.equal(wrongPassword.error,'Usuario o contrasena incorrectos.');
  assert.equal((await request('/api/me','',undefined,401)).value.code,'SESSION_MISSING');
  assert.equal((await request('/api/me','organizador_web_session=bad.signature',undefined,401)).value.code,'SESSION_INVALID');
  const originalPayload=JSON.parse(Buffer.from(admin.split('=')[1].split('.')[0],'base64url').toString());
  const expiredPayload=Buffer.from(JSON.stringify({...originalPayload,exp:1})).toString('base64url');
  const expiredSignature=crypto.createHmac('sha256',fs.readFileSync(path.join(temp,'files/session_secret'),'utf8').trim()).update(expiredPayload).digest('base64url');
  const expired=(await request('/api/me','organizador_web_session='+expiredPayload+'.'+expiredSignature,undefined,401)).value;
  assert.equal(expired.code,'SESSION_EXPIRED');
  assert.equal(expired.error,'Sesion caducada. Vuelve a entrar con tu usuario.');
  results.push('Login: incorrect credentials without user enumeration; missing, signed-expired and invalid sessions distinguished');
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
  const deniedUpload=await fetch(`${base}/api/erp/onboarding/upload?id_comunidad=${communityA}&tipo=propietarios`,{
    method:'POST',headers:{Cookie:read.cookie,'x-file-name':'propietarios.csv','content-type':'text/csv'},body:'Codigo,Nombre\n1,Prueba',signal:AbortSignal.timeout(10000),
  });
  assert.equal(deniedUpload.status,403,await deniedUpload.text());
  results.push('Onboarding upload is rejected before storage for read-only community access');
  const erpCommand={command:'erp0.foundation.set_status',id_comunidad:communityA,payload:{status:'prepared'},idempotency_key:'release-erp0-foundation',expected_version:0,reason:'Release reference path',origin:'test'};
  const erpFirst=(await request('/api/erp/command',worker.cookie,erpCommand)).value;
  assert.equal(erpFirst.entity.version,1);
  assert.equal((await request('/api/erp/command',worker.cookie,erpCommand)).value.idempotent_replay,true);
  await request('/api/erp/command',worker.cookie,{...erpCommand,payload:{status:'verified'}},409);
  await request('/api/erp/command',worker.cookie,{...erpCommand,idempotency_key:'release-erp0-stale',payload:{status:'verified'}},409);
  await request('/api/erp/command',worker.cookie,{...erpCommand,role:'Superusuario'},400);
  await request('/api/erp/command',worker.cookie,{...erpCommand,id_comunidad:communityB,idempotency_key:'release-erp0-forbidden'},403);
  await request('/api/erp/command',read.cookie,{...erpCommand,idempotency_key:'release-erp0-role-forbidden'},403);
  await request(`/api/erp/query?query=erp0.foundation.get_status&id_comunidad=${communityA}`,worker.cookie);
  await request(`/api/erp/query?query=erp0.foundation.get_status&id_comunidad=${communityA}`,other.cookie,undefined,403);
  await request('/api/erp/command',worker.cookie,{...erpCommand,command:'sql.execute',idempotency_key:'release-no-sql'},404);
  results.push('ERP0 internal contract: backend scope, strict actor, idempotency and optimistic conflict');
  for(const u of [worker,other,president,presidentB,guard,read]) await request('/api/admin',u.cookie,undefined,403);
  await request('/api/overview',guard.cookie,undefined,403);
  for(const url of ['/api/reports-center','/api/daily-operations','/api/assemblies','/api/options','/api/global-search?q=Verification']) await request(url,president.cookie,undefined,403);
  for(const u of [admin,worker.cookie,other.cookie,read.cookie]) for(const url of ['/api/overview','/api/workflow','/api/daily-operations','/api/options','/api/reports-center','/api/assemblies']) await request(url,u);
  await request('/api/overview',president.cookie);
  results.push('Role boundaries and all primary read endpoints');
  const create = async (u,type,cid,title)=> (await request('/api/entity/create',u,{type,payload:{id_comunidad:cid,titulo:title,comentario:'Initial context',responsable:worker.name,categoria:'Mantenimiento',estado_nuevo:'Pendiente',prioridad_nueva:'Media',extra:null,flag:false}})).value.id;
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
  const autoDecision=(await write({comentario:'Request a decision',proximo_paso:'Confirm the estimate',responsable_proximo_paso:president.name,estado_nuevo:'En curso',motivo_bloqueo:'',confirmation_key:'named-president-record'})).value;
  assert.ok((await request('/api/workflow',president.cookie)).value.president_requests.some(r=>r.id_solicitud===autoDecision.request_id));
  const workflow=(await request('/api/workflow',president.cookie)).value;
  const decision=workflow.president_requests.find(row=>Number(row.id_proyecto)===project);
  assert.ok(decision,'Named president did not receive request');
  assert.ok(!(await request('/api/workflow',presidentB.cookie)).value.president_requests.some(row=>row.id_solicitud===decision.id_solicitud));
  await request(`/api/entity/detail?type=project&id=${project}`,president.cookie);
  await request(`/api/entity/detail?type=task&id=${task}`,president.cookie,undefined,403);
  await request('/api/president/respond',presidentB.cookie,{id:decision.id_solicitud,version:0,decision:'Aprobada',comment:'Wrong president'},403);
  await request('/api/president/respond',president.cookie,{id:decision.id_solicitud,version:0,decision:'Aprobada',comment:''},400);
  await request('/api/president/respond',president.cookie,{id:decision.id_solicitud,version:0,decision:'Aprobada',comment:'Approved with estimate review'});
  await request('/api/president/respond',president.cookie,{id:decision.id_solicitud,decision:'Aprobada',comment:'Duplicate'},400);
  const detail=(await request(`/api/entity/detail?type=project&id=${project}`,worker.cookie)).value;
  assert.equal(detail.requests[0].siguiente_responsable,worker.name);
  assert.equal(detail.item.responsable_principal,worker.name);
  assert.ok(detail.history.some(row=>row.comentario.includes('Approved with estimate review')));
  results.push('Presidency routing, mandatory comment, one decision, return responsibility and audit');
  for(const kind of ['task','project']){
    const id=await create(worker.cookie,kind,communityA,'Automatic request '+kind);
    const data={type:kind,id,payload:{comentario:'Inspection supplied for review',proximo_paso:'Approve the proposed repair',responsable_proximo_paso:'Presidente',confirmation_key:'auto-followup-'+kind}};
    await request('/api/entity/record',other.cookie,data,403);
    await request('/api/entity/record',read.cookie,data,403);
    const normal=(await request('/api/entity/record',worker.cookie,{...data,payload:{...data.payload,responsable_proximo_paso:worker.name,confirmation_key:'normal-'+kind}})).value;
    assert.equal(normal.request_id,null);
    const saved=(await request('/api/entity/record',worker.cookie,data)).value;
    assert.ok(saved.request_id);
    assert.deepEqual((await request('/api/entity/record',worker.cookie,data)).value,saved);
    await request('/api/entity/record',worker.cookie,{...data,payload:{...data.payload,comentario:'Different confirmed content'}},400);
    const current=(await request(`/api/entity/detail?type=${kind}&id=${id}`,worker.cookie)).value;
    assert.equal(current.requests.length,1);
    const linked=current.requests[0];
    assert.equal(linked[kind==='task'?'id_registro_tarea':'id_registro_proyecto'],saved.record_id);
    assert.equal(linked[kind==='task'?'id_tarea':'id_proyecto'],id);
    assert.equal(linked.id_comunidad,communityA);
    assert.equal(linked.id_usuario_solicitante,worker.id);
    assert.equal(linked.id_usuario_presidente,president.id);
    assert.equal(linked.proximo_paso_solicitado,'Approve the proposed repair');
    assert.equal(linked.detalle,'Inspection supplied for review');
    const reused=JSON.parse(pythonRun(`import sqlite3,json,sys
from presidency_domain import from_followup
c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row
with c:
 r=from_followup(c,json.loads(sys.argv[2]),sys.argv[3],int(sys.argv[4]),int(sys.argv[5]))
print(json.dumps(r))
`,[database,JSON.stringify((await request('/api/me',worker.cookie)).value.usuario),kind,String(id),String(saved.record_id)]));
    assert.equal(reused.id_solicitud,saved.request_id);
    assert.equal((await request(`/api/entity/detail?type=${kind}&id=${id}`,worker.cookie)).value.requests.length,1);
    const before=pythonRun("import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['registros','registros_proyectos','solicitudes_presidente','auditoria','notificaciones']]))",[database]);
    pythonRun("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"CREATE TRIGGER fixture_notify_fail BEFORE INSERT ON notificaciones WHEN NEW.tipo='Solicitud presidente' BEGIN SELECT RAISE(ABORT,'fixture notification failure'); END\"); c.commit()",[database]);
    try {await request('/api/entity/record',worker.cookie,{...data,payload:{...data.payload,confirmation_key:'rollback-'+kind}},500);}
    finally {pythonRun("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('DROP TRIGGER fixture_notify_fail'); c.commit()",[database]);}
    assert.equal(pythonRun("import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps([c.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['registros','registros_proyectos','solicitudes_presidente','auditoria','notificaciones']]))",[database]),before);
    await request('/api/entity/record',worker.cookie,{...data,payload:{...data.payload,responsable_proximo_paso:presidentB.name,confirmation_key:'wrong-president-'+kind}},403);
    const fallback={...data,payload:{...data.payload,proximo_paso:'',confirmation_key:'concurrent-'+kind}};
    const [first,second]=await Promise.all([request('/api/entity/record',worker.cookie,fallback),request('/api/entity/record',worker.cookie,fallback)]);
    assert.deepEqual(first.value,second.value);
    const last=(await request(`/api/entity/detail?type=${kind}&id=${id}`,worker.cookie)).value;
    assert.equal(last.requests.length,2);
    assert.equal(last.requests[0].proximo_paso_solicitado,data.payload.comentario);
    assert.ok(Number(pythonRun("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(\"SELECT COUNT(*) FROM auditoria WHERE entidad='solicitud_presidente' AND id_entidad=?\",(int(sys.argv[2]),)).fetchone()[0])",[database,String(first.value.request_id)]))>0);
  }
  results.push('Automatic presidency task/project followups: final owner, origin link, exact replay, existing-request reuse, audit, wrong-community protection and full rollback on notification failure');
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
  assert.equal(attached.categoria_documental,'Sin clasificar');
  await request('/api/attachment/classify',other.cookie,{id:attached.id_anexo,category:'Factura'},403);
  await request('/api/attachment/classify',read.cookie,{id:attached.id_anexo,category:'Factura'},403);
  await request('/api/attachment/classify',worker.cookie,{id:attached.id_anexo,category:'Inventada'},400);
  await request('/api/attachment/classify',worker.cookie,{id:attached.id_anexo,category:'Presupuesto'});
  let documentsDetail=(await request(`/api/entity/detail?type=task&id=${task}`,worker.cookie)).value;
  assert.equal(documentsDetail.attachments[0].categoria_documental,'Presupuesto');
  assert.equal(documentsDetail.attachments[0].id_registro,attached.id_registro);
  assert.ok(documentsDetail.reports.some(r=>r.id_informe===report.report_id),'Individual task reports appear in the task file');
  const executive=(await request('/api/report/generate',worker.cookie,{type:'task',id:task,mode:'ejecutivo',attachment_ids:[]})).value;
  const collection=(await request('/api/report/collection',worker.cookie,{selections:[{type:'task',id:task},{type:'project',id:project}],mode:'completo',attachment_ids:[attached.id_anexo]})).value;
  assert.notEqual(executive.filename,report.filename);
  documentsDetail=(await request(`/api/entity/detail?type=task&id=${task}`,worker.cookie)).value;
  assert.ok(documentsDetail.reports.some(r=>r.id_informe===executive.report_id && r.mode==='ejecutivo'));
  assert.ok(documentsDetail.reports.some(r=>r.id_informe===collection.report_id));
  assert.equal(documentsDetail.attachments.length,1,'Excluding annexes does not delete documents');
  await request('/api/report/generate',worker.cookie,{type:'project',id:project,attachment_ids:[attached.id_anexo]},403);
  await request('/api/report/generate',worker.cookie,{type:'task',id:task,mode:'pdf'},400);
  await request('/api/report/generate',president.cookie,{type:'task',id:task},403);
  await request('/api/report/collection',admin,{selections:[{type:'task',id:task},{type:'project',id:projectB}]},400);
  pythonRun(`import sqlite3,sys,json,hashlib
c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row
row=c.execute('SELECT * FROM informes WHERE id_informe=?',(sys.argv[2],)).fetchone()
m=json.loads(row['observaciones']); assert m['snapshot']['mode']=='ejecutivo'
assert m['snapshot']['entries'][0]['attachments']==[]
assert m['snapshot']['author']==row['usuario']
assert len(m['snapshot_sha256'])==64
assert c.execute("SELECT count(*) FROM auditoria WHERE accion='Clasificar documento'").fetchone()[0]>=1
`,[database,String(executive.report_id)]);
  results.push('Module05: document categories audited/scoped, both Word formats, immutable snapshots, selected annexes, task/collection versions');
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
  assert.equal(ai.intent,'consulta');
  pythonRun(`import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1])
with c:
    c.execute('INSERT INTO cf_propietarios(nombre,activo,id_comunidad) VALUES(?,1,?)',('MARCHITO PRUEBA',int(sys.argv[2])))
    c.execute('INSERT INTO ia_contexto_conversacion(id_usuario,usuario,rol,texto_usuario,texto_contextual,intent,fecha_creacion,comunidades_json) VALUES(?,?,?,?,?,?,?,?)',
        (int(sys.argv[3]),sys.argv[4],'Usuario','Speaker 1: Reunion de proyectos. '*500,'Reunion extensa anterior. '*500,'lote','2099-01-01',json.dumps([int(sys.argv[2]),int(sys.argv[5])])))
`,[database,String(communityA),String(worker.id),worker.name,String(communityB)]);
  for (const url of ['/api/ai/center','/api/agent/message']) {
    const ownerReply=(await request(url,worker.cookie,{text:'quien es el propietario marchito',context:{screen_context:'Reunion larga, proyectos y presupuestos. '.repeat(500)},attachments:[{name:'anterior.txt',text:'Speaker 1: Reunion anterior sobre proyectos.\n'.repeat(500)}]})).value;
    assert.equal(ownerReply.intent,'consulta',JSON.stringify(ownerReply));
    assert.equal(ownerReply.conversation_context.used,false);
    assert.equal(ownerReply.result.query_domain,'propietario_identidad');
    assert.match(ownerReply.result.answer,/MARCHITO PRUEBA/);
    assert.equal(ownerReply.requires_confirmation,false);
    assert.ok(!ownerReply.result.meeting_id);
  }
  const hiddenOwner=(await request('/api/ai/center',other.cookie,{text:'quien es el propietario marchito'})).value;
  assert.equal(hiddenOwner.intent,'consulta');
  assert.ok(!JSON.stringify(hiddenOwner).includes('MARCHITO PRUEBA'));
  const absent=(await request('/api/ai/center',worker.cookie,{text:'quien es el propietario ZZZNOEXISTE'})).value;
  assert.equal(absent.intent,'consulta');
  assert.match(absent.result.answer,/No he encontrado/);
  for(const url of ['/api/agent/context','/api/ai/history','/api/ai/rules']) await request(url,worker.cookie);
  await request('/api/ai/rules/action',worker.cookie,{action:'learn_redaction',data:{source_text:'Private community A preference',original_payload:{comentario:'old'},final_payload:{comentario:'Private community A preference'}}});
  const ownMemory=(await request('/api/ai/rules',worker.cookie)).value;
  assert.ok(JSON.stringify(ownMemory).includes('Private community A preference'));
  assert.ok(!JSON.stringify((await request('/api/ai/rules',other.cookie)).value).includes('Private community A preference'));
  results.push('AI center response, JSON history persistence and private memory isolation');
  for (const kind of ['task','project']) {
    const payload={id_comunidad:communityA,titulo:'Module02 '+kind,descripcion:'Operational definition',responsable:worker.name,estado_nuevo:'Pendiente'};
    for(const field of ['titulo','descripcion','responsable']){
      await request('/api/entity/create',worker.cookie,{type:kind,payload:{...payload,[field]:''}},400);
    }
    const id=(await request('/api/entity/create',worker.cookie,{type:kind,payload})).value.id;
    const readDetail=async()=> (await request(`/api/entity/detail?type=${kind}&id=${id}`,worker.cookie)).value;
    const record=async(data,status=200)=>request('/api/entity/record',worker.cookie,{type:kind,id,payload:{comentario:'Context note',responsable_proximo_paso:'Supplier fixture',...data}},status);
    assert.ok((await readDetail()).history.some(r=>r.tipo_registro==='Creacion'));
    if(kind==='project'){
      assert.equal((await readDetail()).item.fase_aprobacion,'Propuesta');
      await request('/api/entity/update',worker.cookie,{type:kind,id,payload:{fase_aprobacion:'Aprobado'}});
      assert.equal((await readDetail()).item.descripcion,'Operational definition');
    }
    await record({responsable_proximo_paso:''},400);
    await record({comentario:''},400);
    await record({proximo_paso:'Estimate',fecha_objetivo_proximo_paso:'2026-02-30'},400);
    await record({proximo_paso:'Send estimate',fecha_objetivo_proximo_paso:'2026-09-15'});
    await record({proximo_paso:'Visit installation'});
    await record({proximo_paso:'Review specification',responsable_proximo_paso:worker.name});
    await record({proximo_paso:'',responsable_proximo_paso:'Administration'});
    let current=await readDetail();
    assert.equal(current.commitments.filter(r=>r.estado==='Pendiente').length,3);
    assert.equal(current.item[kind==='task'?'responsable':'responsable_principal'],worker.name);
    assert.equal(current.history[0].proximo_paso,'');
    if(kind==='project')assert.equal(current.item.fase_aprobacion,'Aprobado');
    const closed=kind==='task'?'Terminada':'Finalizado';
    await record({estado_nuevo:closed},400);
    await request('/api/entity/update',worker.cookie,{type:kind,id,payload:{estado:closed,comentario:'Completed'}},400);
    await request('/api/entity/archive',worker.cookie,{type:kind,id,payload:{comentario:'Archived'}},400);
    for(const action of current.commitments.filter(r=>r.estado==='Pendiente')){
      const body={type:kind,id,payload:{id:action.id,kind:action.kind,estado:'Resuelta',comentario:'Result verified'}};
      await request('/api/entity/commitment/resolve',other.cookie,body,403);
      await request('/api/entity/commitment/resolve',read.cookie,body,403);
      await request('/api/entity/commitment/resolve',worker.cookie,{...body,payload:{...body.payload,comentario:''}},400);
      await request('/api/entity/commitment/resolve',worker.cookie,body);
      await request('/api/entity/commitment/resolve',worker.cookie,body,400);
    }
    await record({estado_nuevo:closed,comentario:'Work completed'});
    current=await readDetail();
    assert.ok(current.commitments.every(r=>r.estado!=='Pendiente'));
    await record({estado_nuevo:'En curso'},400);
    await request('/api/entity/update',worker.cookie,{type:kind,id,payload:{estado:'En curso'}},400);
    await record({estado_nuevo:'En curso',motivo_reapertura:'New issue confirmed'});
    await request('/api/entity/archive',worker.cookie,{type:kind,id,payload:{comentario:'Archive after review'}});
    const overview=(await request('/api/overview?include_closed=1',worker.cookie)).value;
    assert.ok(overview[kind==='task'?'tareas':'proyectos'].some(r=>r[kind==='task'?'id_tarea':'id_proyecto']===id));
    await request('/api/entity/update',worker.cookie,{type:kind,id,payload:{estado:'En curso',motivo_reapertura:'Resume works'}});
    current=await readDetail();
    if(kind==='task')assert.equal(current.item.archivada,0);
    assert.ok(current.history.some(r=>r.tipo_registro==='Reapertura'));
  }
  results.push('Module02: required fields, independent approval, multiple commitments, explicit resolution, closing and reopening');
  for(const kind of ['task','project']){
    const payload={titulo:'Historical '+kind,descripcion:'Reviewed source',responsable:worker.name,
      id_comunidad:communityA,estado:'En curso',proximo_paso:'Current estimate',responsable_proximo_paso:'External supplier',
      historical_records:[{fecha:'2026-01-02',comentario:'Site inspected',proximo_paso:'Old step'},
        {fecha:'',comentario:'Undated historical event'}]};
    const created=(await request('/api/entity/create',worker.cookie,{type:kind,payload})).value;
    const detail=(await request(`/api/entity/detail?type=${kind}&id=${created.id}`,worker.cookie)).value;
    assert.equal(detail.commitments.filter(r=>r.estado==='Pendiente').length,1);
    assert.ok(detail.history.some(r=>r.fecha_hora.startsWith('2026-01-02') && r.comentario==='Site inspected'));
    assert.ok(detail.history.some(r=>r.comentario.includes('Fecha de la actuacion no indicada')));
    await request('/api/entity/create',worker.cookie,{type:kind,payload:{...payload,historical_records:[{fecha:'2026-02-30',comentario:'Invalid'}]}},400);
    const decision=(await request('/api/entity/create',worker.cookie,{type:kind,payload:{...payload,
      historical_records:[],proximo_paso:'Approve specification',responsable_proximo_paso:'Presidente'}})).value;
    const decisions=(await request(`/api/entity/detail?type=${kind}&id=${decision.id}`,worker.cookie)).value.commitments;
    assert.ok(!decisions.some(r=>r.kind==='decision'));
  }
  results.push('Module02: atomic historical creation, explicit undated evidence; creating an entity is not a confirmed presidency followup');
  const requestData={action:'create',type:'task',id:task,decision:'Approve the repair',contexto:'Estimate and inspection attached',fecha_objetivo:'2026-10-01',adjuntos:[attached.id_anexo]};
  await request('/api/president/request',read.cookie,requestData,403);
  await request('/api/president/request',other.cookie,requestData,403);
  await request('/api/president/request',worker.cookie,{...requestData,contexto:''},400);
  await request('/api/president/request',worker.cookie,{...requestData,adjuntos:[999999999]},403);
  const a=(await request('/api/president/request',worker.cookie,requestData)).value.request;
  const b=(await request('/api/president/request',worker.cookie,{...requestData,decision:'Approve an independent specification',adjuntos:[]})).value.request;
  const inspect=async(cookie,id)=>(await request('/api/president/request?id='+id,cookie)).value.request;
  await request('/api/president/request?id='+a.id_solicitud,presidentB.cookie,undefined,403);
  assert.equal((await inspect(president.cookie,a.id_solicitud)).siguiente_responsable,president.name);
  await request('/api/president/respond',president.cookie,{id:a.id_solicitud,version:0,decision:'Solicita aclaracion',comment:'Does the estimate include VAT?'});
  let r=await inspect(worker.cookie,a.id_solicitud);
  assert.equal(r.siguiente_responsable,worker.name);
  assert.equal(r.estado,'Solicita aclaracion');
  await request('/api/notifications/read',worker.cookie,{all:true});
  assert.equal((await inspect(worker.cookie,a.id_solicitud)).estado,'Solicita aclaracion');
  const answer={action:'clarify',id:a.id_solicitud,version:r.version,comentario:'Yes, VAT is included.'};
  await request('/api/president/request',reviewer.cookie,answer,403);
  await request('/api/president/request',worker.cookie,{...answer,comentario:''},400);
  await request('/api/president/request',worker.cookie,answer);
  await request('/api/president/request',worker.cookie,answer,400);
  r=await inspect(president.cookie,a.id_solicitud);
  assert.equal(r.siguiente_responsable,president.name);
  assert.equal(r.conversacion.length,3);
  await request('/api/president/respond',president.cookie,{id:a.id_solicitud,version:r.version,decision:'Aprobada',comment:'Proceed at the stated amount.'});
  r=await inspect(worker.cookie,a.id_solicitud);
  assert.equal(r.conversacion.length,4);
  assert.equal(r.siguiente_responsable,worker.name);
  await request('/api/president/request',worker.cookie,{action:'manage',id:a.id_solicitud,version:r.version,comentario:'Supplier informed and appointment arranged.'});
  assert.equal((await inspect(worker.cookie,a.id_solicitud)).siguiente_responsable,'');
  assert.equal((await inspect(worker.cookie,b.id_solicitud)).estado,'Pendiente');
  await request('/api/president/request',worker.cookie,{action:'cancel',id:b.id_solicitud,version:0,comentario:'Specification withdrawn.'});
  await request('/api/entity/record',worker.cookie,{type:'task',id:task,payload:{comentario:'Please review the inspection.',responsable_proximo_paso:worker.name,menciones:[reviewer.id]}});
  const mentions=(await request('/api/workflow',reviewer.cookie)).value.notifications;
  assert.ok(mentions.some(n=>n.tipo==='Mencion directa' && n.id_tarea===task));
  await request('/api/entity/record',worker.cookie,{type:'task',id:task,payload:{comentario:'Forbidden mention',responsable_proximo_paso:worker.name,menciones:[other.id]}},403);
  results.push('Module04: explicit requests, attachments, independent decisions, clarification thread, read vs managed, ownership, scoped mentions');
  // Isolated drafts are prepared without an external provider or business-data writes.
  const draftTask = await create(worker.cookie,'task',communityA,'Module06 draft fixture');
  const draftPayload={comentario:'Disponibilidad confirmada, condicionada a aprobar el presupuesto.',responsable_proximo_paso:'Administracion',proximo_paso:'Revisar material una vez aprobado el presupuesto.',estado_nuevo:'Pendiente'};
  function makeDraft(){return JSON.parse(pythonRun(`import json,sqlite3,sys
import ai_drafts as d
conn=sqlite3.connect(sys.argv[1]);conn.row_factory=sqlite3.Row
s=json.loads(sys.argv[2]);kind='task';eid=int(sys.argv[3]);row=d.entity(conn,s,kind,eid)
with conn: result=d.create(conn,s,kind,eid,'Synthetic fixture input','',{'payload':json.loads(sys.argv[4])},d.version(conn,kind,row))
print(json.dumps(result))
`,[database,JSON.stringify({id_usuario:worker.id,nombre:worker.name,rol:'Usuario',comunidades:[{id_comunidad:communityA,puede_actualizar:1}]}),String(draftTask),JSON.stringify(draftPayload)]));}
  const draft=makeDraft();
  assert.equal((await request(`/api/ai/followup-draft?type=task&id=${draftTask}`,worker.cookie)).value.draft.id,draft.id);
  await request(`/api/ai/followup-draft?type=task&id=${draftTask}`,other.cookie,undefined,403);
  await request(`/api/ai/followup-draft?type=task&id=${draftTask}`,read.cookie,undefined,403);
  await request('/api/ai/followup-draft',other.cookie,{draft_id:draft.id,revision:1,payload:draftPayload},403);
  const updated=(await request('/api/ai/followup-draft',worker.cookie,{draft_id:draft.id,revision:1,payload:{...draftPayload,comentario:'Comentario revisado manualmente.'}})).value;
  assert.equal(updated.revision,2);
  await request('/api/ai/followup-draft',worker.cookie,{draft_id:draft.id,revision:1,payload:draftPayload},400);
  await request('/api/entity/record',worker.cookie,{type:'task',id:task,payload:{...draftPayload,draft_id:draft.id,draft_revision:2}},403);
  const confirmation={type:'task',id:draftTask,payload:{...updated.proposal.payload,draft_id:draft.id,draft_revision:2}};
  const applied=(await request('/api/entity/record',worker.cookie,confirmation)).value;
  const repeated=(await request('/api/entity/record',worker.cookie,confirmation)).value;
  assert.equal(applied.record_id,repeated.record_id);
  assert.equal((await request(`/api/ai/followup-draft?type=task&id=${draftTask}`,worker.cookie)).value.draft,null);
  const stale=makeDraft();
  await request('/api/entity/record',worker.cookie,{type:'task',id:draftTask,payload:{comentario:'Otra actuacion posterior',responsable_proximo_paso:'Administracion'}});
  const conflict=(await request('/api/entity/record',worker.cookie,{type:'task',id:draftTask,payload:{...draftPayload,draft_id:stale.id,draft_revision:1}},400)).value;
  assert.match(conflict.error,/ficha ha cambiado/);
  await request('/api/ai/analyze',worker.cookie,{text:'Nueva actuacion',target:{type:'project',id:projectB}},403);
  const offline=(await request('/api/ai/analyze',worker.cookie,{text:'Nueva actuacion',target:{type:'task',id:draftTask}},500)).value;
  assert.match(offline.error,/IA externa no esta disponible/);
  results.push('Module06: private editable drafts, community write scope, stale-proposal protection, idempotent audited confirmation and explicit AI unavailability');
  const meetingTask=await create(worker.cookie,'task',communityA,'Meeting existing fixture');
  const meetingSession={id_usuario:worker.id,nombre:worker.name,rol:'Usuario',comunidades:[{id_comunidad:communityA,puede_actualizar:1,puede_crear:1}]};
  const meeting=JSON.parse(pythonRun(`import json,sqlite3,sys
from ai_meetings import command
conn=sqlite3.connect(sys.argv[1]);conn.row_factory=sqlite3.Row
s=json.loads(sys.argv[2]);eid=int(sys.argv[3])
with conn:
    cat=command(conn,s,'catalog',{})
    b=command(conn,s,'create',{'text':'Synthetic meeting','catalog':cat})
    current=next(r for r in cat if r['type']=='task' and r['id']==eid)
    p={'action':'seguimiento_tarea','entity':{'type':'task','id':eid},'baseline_version':current['version'],'selected':True,'payload':{'comentario':'Synthetic reviewed comment','responsable_proximo_paso':'Administracion','proximo_paso':'','id_comunidad':current['id_comunidad']}}
    n={'action':'crear_proyecto','entity':{'type':'project','id':None},'selected':True,'payload':{'titulo':'Meeting new project','comentario':'Reviewed extraordinary works','responsable_nuevo':'Administracion','responsable_proximo_paso':'Administracion','proximo_paso':'','id_comunidad':current['id_comunidad']}}
    result=command(conn,s,'finish',{'meeting_id':b['meeting_id'],'proposals':[p,n]})
print(json.dumps(result))
`,[database,JSON.stringify(meetingSession),String(meetingTask)]));
  const meetingPath='/api/ai/meetings';
  await request(meetingPath+'?id='+meeting.meeting_id,other.cookie,undefined,403);
  await request(meetingPath+'?id='+meeting.meeting_id,read.cookie,undefined,403);
  assert.equal((await request(meetingPath+'?id='+meeting.meeting_id,worker.cookie)).value.proposals.length,2);
  const first=meeting.proposals[0];
  const edited={...first,entity_id:meetingTask,payload:{...first.payload,comentario:'Human reviewed meeting comment'}};
  await request(meetingPath,worker.cookie,{action:'save',item:edited});
  await request(meetingPath,worker.cookie,{action:'save',item:edited},400);
  const appliedMeeting=(await request(meetingPath,worker.cookie,{action:'apply',meeting_id:meeting.meeting_id,item_ids:[first.meeting_item_id]})).value;
  assert.equal(appliedMeeting.results[0].ok,true,JSON.stringify(appliedMeeting.results));
  assert.equal(appliedMeeting.proposals[1].confirmed,false);
  const once=(await request(`/api/entity/detail?type=task&id=${meetingTask}`,worker.cookie)).value.history.length;
  await request(meetingPath,worker.cookie,{action:'apply',meeting_id:meeting.meeting_id,item_ids:meeting.proposals.map(p=>p.meeting_item_id)});
  await request(meetingPath,worker.cookie,{action:'apply',meeting_id:meeting.meeting_id,item_ids:meeting.proposals.map(p=>p.meeting_item_id)});
  assert.equal((await request(`/api/entity/detail?type=task&id=${meetingTask}`,worker.cookie)).value.history.length,once);
  const completeMeeting=(await request(meetingPath+'?id='+meeting.meeting_id,worker.cookie)).value;
  assert.ok(completeMeeting.proposals.every(p=>p.confirmed),JSON.stringify(completeMeeting));
  assert.equal(Number(pythonRun("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(\"SELECT COUNT(*) FROM proyectos WHERE nombre='Meeting new project'\").fetchone()[0])",[database])),1);
  const staleMeeting=JSON.parse(pythonRun(`import json,sqlite3,sys
from ai_meetings import command
c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row;s=json.loads(sys.argv[2]);eid=int(sys.argv[3])
with c:
    cat=command(c,s,'catalog',{});r=next(x for x in cat if x['type']=='task' and x['id']==eid)
    b=command(c,s,'create',{'text':'Stale and partial fixture','catalog':cat})
    p={'action':'seguimiento_tarea','entity':{'type':'task','id':eid},'baseline_version':r['version'],'payload':{'comentario':'Old proposal','responsable_proximo_paso':'Administracion','id_comunidad':r['id_comunidad']}}
    n={'action':'crear_tarea','entity':{'type':'task','id':None},'payload':{'titulo':'Independent partial fixture','comentario':'New ordinary incident','responsable_nuevo':'Administracion','responsable_proximo_paso':'Administracion','id_comunidad':r['id_comunidad']}}
    result=command(c,s,'finish',{'meeting_id':b['meeting_id'],'proposals':[p,n]})
print(json.dumps(result))
`,[database,JSON.stringify(meetingSession),String(meetingTask)]));
  await request('/api/entity/record',worker.cookie,{type:'task',id:meetingTask,payload:{comentario:'Concurrent update',responsable_proximo_paso:'Administracion'}});
  const partial=(await request(meetingPath,worker.cookie,{action:'apply',meeting_id:staleMeeting.meeting_id,item_ids:staleMeeting.proposals.map(p=>p.meeting_item_id)})).value;
  assert.equal(partial.results[0].ok,false);
  assert.match(partial.results[0].error,/ha cambiado/);
  assert.equal(partial.results[1].ok,true);
  await request(meetingPath,worker.cookie,{action:'apply',meeting_id:staleMeeting.meeting_id,item_ids:staleMeeting.proposals.map(p=>p.meeting_item_id)});
  assert.equal(Number(pythonRun("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute(\"SELECT COUNT(*) FROM tareas WHERE titulo='Independent partial fixture'\").fetchone()[0])",[database])),1);
  results.push('Module06 meetings: private resumable proposals, editable revisions, individual and selected confirmation, new projects and retry without duplicate records');
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
