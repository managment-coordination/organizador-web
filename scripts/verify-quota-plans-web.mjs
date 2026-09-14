// Full shell and real authenticated ERP bridge; synthetic database copies only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(import.meta.dirname,'..'),source=process.argv[2];
const remote=process.env.QUOTA_WEB_BASE;
assert(remote||(source&&path.basename(path.dirname(source)).startsWith('organizador-quota-plans-')));
const out=fs.mkdtempSync(path.join(os.tmpdir(),'organizador-quota-web-')),db=path.join(out,'database.db');
const python=process.env.PYTHON_BIN||path.join(root,'backups/erp4-runtime/Scripts/python.exe');
const seeded=remote?{status:0,stdout:JSON.stringify({user:process.env.QUOTA_WEB_USER,community:Number(process.env.QUOTA_WEB_COMMUNITY)})}:spawnSync(python,['-',source,db],{encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(root,'server')},input:`
import sqlite3,sys,hashlib,json,uuid
from access_control import profile
from erp_core.dispatcher import execute_command
src=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);dst=sqlite3.connect(sys.argv[2]);src.backup(dst);src.close();dst.close()
c=sqlite3.connect(sys.argv[2]);c.row_factory=sqlite3.Row
u=c.execute("SELECT * FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()
salt='quota-web';digest=hashlib.pbkdf2_hmac('sha256',b'Only-quota-fixture',salt.encode(),260000).hex()
c.execute('UPDATE usuarios SET password_hash=?,password_configurada=1,requiere_cambio_password=0,bloqueado=0 WHERE id_usuario=?',('pbkdf2_sha256$260000$'+salt+'$'+digest,u['id_usuario']));c.commit()
session=profile(c,u['id_usuario']);community=c.execute("SELECT id_comunidad FROM comunidades WHERE codigo='ERP2-INTEGRAL'").fetchone()[0]
plans=list(c.execute("SELECT id_plan,origen_tipo FROM erp_planes_cuota WHERE id_comunidad=? AND id_plan IN(SELECT id_plan FROM erp_plan_operativo_versiones)",(community,)))
for p in plans:
 name=c.execute('SELECT nombre FROM erp_plan_operativo_versiones WHERE id_plan=? ORDER BY version DESC LIMIT 1',(p['id_plan'],)).fetchone()[0]
 if p['origen_tipo']=='importe_manual' and name!='Derrama ascensor':
  version=c.execute('SELECT MAX(version) FROM erp_plan_actividad WHERE id_plan=?',(p['id_plan'],)).fetchone()[0]
  execute_command(sys.argv[2],session,{'command':'erp2.quota_plan.activity','id_comunidad':community,'expected_version':version,'idempotency_key':uuid.uuid4().hex,'reason':'Isolated UI fixture','origin':'test','payload':{'plan_id':p['id_plan'],'active':False,'effective_from':'2028-01-01'}})
print(json.dumps({'user':u['nombre'],'community':community}));c.close()
`});assert.equal(seeded.status,0,seeded.stderr);const fixture=JSON.parse(seeded.stdout);
const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
const app=remote?null:spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,env:{...process.env,PYTHON_BIN:python,DATABASE_PATH:db,DATA_DIR:path.join(out,'data'),HOST:'127.0.0.1',PORT:String(port),AI_PROVIDER:'local',ERP4_BANKING_ENABLED:'0',ERP4_LIVE_BANKING_ENABLED:'0'},stdio:['ignore','pipe','pipe']});
let log='';app?.stdout.on('data',d=>log+=d);app?.stderr.on('data',d=>log+=d);
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/EQUIPO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
let browser;const errors=[];
try{
 const base=remote||'http://127.0.0.1:'+port;
 const period=process.env.QUOTA_WEB_PERIOD||'2028-07-01',issuedOn=period.slice(0,8)+'03',dueOn=period.slice(0,8)+'10',planName='Plan navegador '+Date.now();
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}if(app&&app.exitCode!==null)throw Error(log);await delay(200);}
 browser=await pw.chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('#loginUser').selectOption({label:fixture.user});await page.locator('#loginPassword').fill('Only-quota-fixture');await page.locator('#loginButton').click();
 await page.locator('#appView:visible,#communityScopeModal:visible').first().waitFor();if(await page.locator('#communityScopeModal').isVisible())await page.locator('#confirmCommunityScope').click();
 await page.locator('#appView').waitFor({state:'visible'});await page.locator('[data-workspace-area=management]').first().click();await page.locator('#receivablesTab').click();
 await page.locator('.finWorkspace [name=community]').selectOption(String(fixture.community));await page.locator('.finWorkspace [name=cut]').fill('2028-07-01');await page.locator('.finWorkspace [name=cut]').dispatchEvent('change');
 const click=async name=>page.locator(`[data-fin-action="${name}"]`).first().click();
 const fill=async(name,value)=>page.locator(`[data-fin-form=operation] [name="${name}"]`).fill(value);
 const review=async()=>{await fill('reason','Aceptacion de planes en navegador');await page.locator('[data-fin-form=operation]').getByRole('button',{name:'Revisar',exact:true}).click();};
 const confirm=async()=>{await page.locator('#finAck').check();await click('confirm');await page.getByRole('status').filter({hasText:'Operacion confirmada'}).waitFor();await page.getByText('Cargando recibos y saldos...', {exact:true}).waitFor({state:'hidden'});};
 await page.locator('[data-fin-action=section][data-section=plans]').click();await page.getByRole('heading',{name:'Planes de cuotas',exact:true}).waitFor();
 await click('plan-new');await fill('name',planName);await fill('concept','Prueba de concepto');await page.locator('[name=exercise_id]').selectOption({label:'2028'});
 await fill('effective_from','2028-01-01');await fill('amount','100,00');await page.locator('[name=rule_type]').selectOption('partes_iguales');await page.locator('[name=amount_mode]').selectOption('por_periodo');
 await review();await page.locator('#finAck').waitFor();await click('cancel');await fill('concept','Concepto corregido');await review();await confirm();
 const row=page.getByRole('row').filter({hasText:planName});await row.getByRole('button',{name:'Fuente de emision',exact:true}).click();await fill('evidence','SYNTHETIC-SOURCE');await review();
 assert(!(await page.locator('.finReview').innerText()).includes('cuota_plan:'));await confirm();
 await page.getByRole('row').filter({hasText:planName}).getByRole('button',{name:'Desactivar',exact:true}).click();await fill('effective_from','2028-01-01');await review();await confirm();
 await click('period-emission');await page.locator('[name=exercise_id]').selectOption({label:'2028'});await fill('period_from',period);await fill('issued_on',issuedOn);await fill('due_on',dueOn);await review();
 await page.locator('.finReview td[data-label="Recibos nuevos"]').filter({hasText:/^56$/}).waitFor();await page.screenshot({path:path.join(out,'desktop-preview.png'),fullPage:true});await confirm();
 await click('period-emission');await page.locator('[name=exercise_id]').selectOption({label:'2028'});await fill('period_from',period);await fill('issued_on',issuedOn);await fill('due_on',dueOn);await review();await page.locator('.finReview td[data-label="Recibos nuevos"]').filter({hasText:/^0$/}).waitFor();await click('cancel');await click('close');
 for(const width of [1440,1920,390,360]){
  await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page overflows at '+width);
  await page.screenshot({path:path.join(out,'plans-'+width+'.png'),fullPage:true});await click('plan-new');await page.locator('[name=name]').waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Form overflows at '+width);await page.screenshot({path:path.join(out,'form-'+width+'.png'),fullPage:true});await click('close');
 }
 assert.deepEqual(errors,[]);assert.equal(await page.locator('.finWarning[role=alert]').count(),0,await page.locator('#cards').innerText());
 console.log(JSON.stringify({ok:true,flows:['authenticated-full-shell','create','edit-before-confirm','deactivate','56-receipt-emission','no-duplicates'],viewports:[1440,1920,390,360],screenshots:out,database:db}));
}catch(e){if(browser?.contexts()[0]?.pages()[0])await browser.contexts()[0].pages()[0].screenshot({path:path.join(out,'failure.png'),fullPage:true});console.error(JSON.stringify({ok:false,error:String(e),errors,output:out,server:log.slice(-3000)}));process.exitCode=1;}
finally{await browser?.close();if(app){app.kill();await new Promise(r=>{if(app.exitCode!==null)r();else app.once('exit',r);});}}
