import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(import.meta.dirname,'..'),source=process.env.UI_FIXTURE_DB;
assert.ok(source&&path.basename(path.dirname(source)).startsWith('organizador-erp3-web-'));
const output=fs.mkdtempSync(path.join(os.tmpdir(),'organizador-erp3-roles-')),db=path.join(output,'test.db');
const python=process.env.PYTHON_BIN||'python3';
const seeded=spawnSync(python,['-',source,db],{encoding:'utf8',input:`
import sqlite3,sys,json
s=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);c=sqlite3.connect(sys.argv[2]);s.backup(c);s.close()
c.row_factory=sqlite3.Row
r=dict(c.execute("SELECT * FROM erp_recibos WHERE number='WEB-ERP3-001'").fetchone())
community=r['id_comunidad'];r.pop('id');r['description']='Exportacion sintetica extensa '+('x'*1800)
for i in range(1600):
 r['number']=r['source_key']=r['obligation_key']='LARGE-EXPORT-'+str(i)
 c.execute('INSERT INTO erp_recibos ('+','.join(r)+') VALUES ('+','.join('?' for _ in r)+')',list(r.values()))
c.commit()
print(json.dumps({'community':community,'root':c.execute("SELECT nombre FROM usuarios WHERE rol='Superusuario' LIMIT 1").fetchone()[0]}));c.close()
`});assert.equal(seeded.status,0,seeded.stderr);const fixture=JSON.parse(seeded.stdout);
const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
const child=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,env:{...process.env,DATABASE_PATH:db,DATA_DIR:path.join(output,'files'),HOST:'127.0.0.1',PORT:String(port),AI_PROVIDER:'local'},stdio:['ignore','pipe','pipe']});
let log='',browser;child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
try {
 const base=`http://127.0.0.1:${port}`;
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await delay(100);}
 const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);browser=await (pw.default||pw).chromium.launch({channel:'msedge',headless:true});
 const admin=await browser.newContext();
 const login=await admin.request.post(base+'/api/login',{data:{usuario:fixture.root,password:'Only-local-fixture-629'}});assert.equal(login.status(),200);
 const save=await admin.request.post(base+'/api/admin/action',{data:{action:'save_user',data:{nombre:'ERP3 Financial Reviewer',rol:'Usuario',activo:true,community_ids:[fixture.community]}}});
 assert.equal(save.status(),200);const user=await save.json();
 const setup=await admin.request.post(base+'/api/auth/first-access',{data:{usuario:'ERP3 Financial Reviewer',clave_temporal:user.temporary_key,password:'Only-local-fixture-629',confirmacion:'Only-local-fixture-629'}});assert.equal(setup.status(),200);
 const grant=await admin.request.post(base+'/api/erp/command',{data:{command:'erp3.permissions.save',id_comunidad:fixture.community,payload:{user_id:user.id_usuario,capabilities:{read:true,sensitive_read:true,record_collection:true}},expected_version:0,idempotency_key:'role-grant',reason:'Permisos sinteticos explicitos',origin:'test'}});assert.equal(grant.status(),200,await grant.text());
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#loginUser option').first().waitFor({state:'attached'});
  await page.locator('#loginUser').selectOption({label:'ERP3 Financial Reviewer'});await page.locator('#loginPassword').fill('Only-local-fixture-629');await page.locator('#loginButton').click();await page.locator('#appView').waitFor({state:'visible'});
  await page.locator('[data-workspace-area=management]').click();
  if(width<700){await page.locator('#mobileMenuToggle').click();await page.locator('[data-mobile-view=receivables]').click();}else await page.locator('#receivablesTab').click();
  await page.getByRole('button',{name:'Registrar cobro',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Preparar emision',exact:true}).count(),0);
  await page.getByRole('button',{name:'Registrar cobro',exact:true}).click();await page.locator('[name=amount]').fill('15,25');await page.locator('[name=reference]').fill('FINANCIAL-'+width);await page.locator('[name=reason]').fill('Cobro revisado por usuario financiero');
  await page.getByRole('button',{name:'Revisar',exact:true}).click();await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();await page.getByRole('status').filter({hasText:'Operacion confirmada'}).waitFor();
  await page.getByRole('button',{name:'Registrar cobro',exact:true}).waitFor();
  await page.screenshot({path:path.join(output,`${width}-financial-user.png`),fullPage:false});
  const denied=await context.request.get(base+'/api/erp/query?'+new URLSearchParams({query:'erp3.receipt.list',id_comunidad:'999999',filters:'{}'}));assert.equal(denied.status(),403);
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if(width===1440){
   const request={command:'erp3.export.prepare',id_comunidad:fixture.community,payload:{kind:'receipts',format:'csv',filters:{}},expected_version:null,idempotency_key:'large-export-http',reason:'Exportacion completa verificada',origin:'test'};
   const response=await context.request.post(base+'/api/erp/command',{data:request,timeout:90000});assert.equal(response.status(),200);
   const body=await response.json();assert.ok(body.entity.content_base64.length>2*1024*1024);assert.ok(body.entity.row_count>=1661);
   const replay=await context.request.post(base+'/api/erp/command',{data:request,timeout:90000});assert.equal(replay.status(),200);assert.equal((await replay.json()).entity.sha256,body.entity.sha256);
  }
  await context.close();
 }
 await admin.close();console.log(JSON.stringify({ok:true,output,checks:['non-root financial 1440/390','explicit permissions','cross-community rejected','large CSV over 2MB and idempotent replay','no JavaScript errors or overflow']}));
} finally {if(browser)await browser.close();child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));fs.writeFileSync(path.join(output,'server.log'),log);}
