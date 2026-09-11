import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.resolve(import.meta.dirname,'..');
const source=process.env.UI_FIXTURE_DB;
assert.ok(source && path.basename(path.dirname(source)).startsWith('organizador-release-'),'Use an isolated operational-release fixture');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'organizador-login-description-'));
const database=path.join(output,'test.db');
const python=process.env.PYTHON_BIN || (process.platform==='win32'?'C:/Users/EQUIPO/AppData/Local/Programs/Python/Python314/python.exe':'python3');
function sql(code,args=[]) {
  const result=spawnSync(python,['-',...args],{input:code,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
  assert.equal(result.status,0,result.stderr); return result.stdout.trim();
}
const rootName=sql(`import sqlite3,sys
s=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); c=sqlite3.connect(sys.argv[2]); s.backup(c); s.close()
print(c.execute('SELECT nombre FROM usuarios WHERE id_usuario=1').fetchone()[0]); c.close()
`,[source,database]);
const socket=net.createServer();
await new Promise(r=>socket.listen(0,'127.0.0.1',r)); const port=socket.address().port;
await new Promise(r=>socket.close(r));
const child=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,env:{...process.env,
  DATABASE_PATH:database,DATA_DIR:path.join(output,'files'),PYTHON_BIN:python,PORT:String(port),HOST:'127.0.0.1',AI_PROVIDER:'local',AI_API_KEY:'',NVIDIA_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';child.stderr.on('data',d=>log+=d); child.stdout.on('data',d=>log+=d);
const base=`http://127.0.0.1:${port}`;
const password='Only-local-fixture-629';
const checks=[];let browser;
try {
  for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}assert.equal(child.exitCode,null,log);await delay(100);}
  // Simulate unavailable authentication storage only inside this disposable database.
  sql("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('ALTER TABLE usuarios RENAME TO usuarios_fault_fixture'); c.commit(); c.close()",[database]);
  try {
    const fault=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usuario:rootName,password})});
    assert.equal(fault.status,500);
    const data=await fault.json();assert.equal(data.code,'AUTH_UNAVAILABLE');
    assert.equal(data.error,'Error tecnico del servidor. Vuelve a intentarlo mas tarde.');
  } finally {
    sql("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('ALTER TABLE usuarios_fault_fixture RENAME TO usuarios'); c.commit(); c.close()",[database]);
  }
  checks.push('Backend authentication failure returns generic technical error without internals');
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge',headless:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const context=await browser.newContext({viewport});const page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('#loginUser option').first().waitFor({state:'attached'});
    await page.locator('#loginUser').selectOption({label:rootName});
    await page.locator('#loginPassword').fill('wrong-password');await page.locator('#loginButton').click();
    await page.getByText('Usuario o contrasena incorrectos.',{exact:true}).waitFor();
    await page.locator('#loginPassword').fill(password);await page.locator('#loginButton').click();
    await page.locator('#appView').waitFor({state:'visible'});
    const community=await page.evaluate(()=>state.usuario.comunidades[0].id_comunidad);
    const short='Reparar la puerta del acceso peatonal.';
    const long=('Revisar el acceso y conservar las condiciones acordadas con el proveedor.\n').repeat(18)+'FIN DEL CONTEXTO';
    const comment=('Inspeccion realizada y comprobaciones registradas. ').repeat(40)+'FIN DEL SEGUIMIENTO';
    const next=('Comprobar la reparacion con el proveedor. ').repeat(18)+'FIN DEL PROXIMO PASO';
    for(const [type,description] of [['task',short],['task',long],['project',long]]){
      const record=await page.evaluate(async({type,description,community,comment,next})=>{
        const created=await api('/api/entity/create',{method:'POST',body:JSON.stringify({type,payload:{id_comunidad:community,titulo:'Descripcion UX '+type,descripcion:description,responsable:state.usuario.nombre,estado:'En curso',fecha_creacion:'2026-09-11'}})});
        await api('/api/entity/record',{method:'POST',body:JSON.stringify({type,id:created.id,payload:{comentario:comment,proximo_paso:next,responsable_proximo_paso:state.usuario.nombre}})});
        await openEntity(type,created.id);return created;
      },{type,description,community,comment,next});
      assert.ok(record.id);
      const text=page.locator('#entityDescriptionText');const toggle=page.locator('#entityDescriptionToggle');
      await text.waitFor({state:'visible'});assert.equal(await text.textContent(),description);
      if(description===short){
        assert.equal(await toggle.isVisible(),false);
        assert.ok(await text.evaluate(n=>n.scrollHeight<=n.clientHeight+1));
      } else {
        await toggle.waitFor({state:'visible'});
        assert.equal(await toggle.getAttribute('aria-expanded'),'false');
        assert.ok(await text.evaluate(n=>n.scrollHeight>n.clientHeight));
        await page.screenshot({path:path.join(output,`${viewport.width}-${type}-compact.png`)});
        await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');
        assert.ok(await text.evaluate(n=>n.scrollHeight<=n.clientHeight+1));
        await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      }
      const history=page.locator('.historyComment').filter({hasText:'FIN DEL SEGUIMIENTO'});
      assert.equal(await history.textContent(),comment);
      assert.equal(await history.evaluate(n=>getComputedStyle(n).webkitLineClamp),'none');
      const historyNext=page.locator('.historyNext').filter({hasText:'FIN DEL PROXIMO PASO'});
      assert.ok((await historyNext.textContent()).endsWith(next));
      assert.equal(await historyNext.evaluate(n=>getComputedStyle(n).webkitLineClamp),'none');
      const outside=await page.locator('#entityModal .modal,.entityDescription').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect()).filter(b=>b.left < -1 || b.right > innerWidth+1).length);
      assert.equal(outside,0);
      await page.locator('#closeModal').click();
    }
    await page.evaluate(async({community})=>{
      const created=await api('/api/entity/create',{method:'POST',body:JSON.stringify({type:'task',payload:{id_comunidad:community,titulo:'Responsive description',descripcion:'Una descripcion de longitud intermedia que se adapta al espacio disponible. '.repeat(4),responsable:state.usuario.nombre}})});
      await openEntity('task',created.id);
    },{community});
    await page.setViewportSize({width:1440,height:1000});
    await page.locator('#entityDescriptionToggle').waitFor({state:'hidden'});
    await page.setViewportSize({width:390,height:844});
    await page.locator('#entityDescriptionToggle').waitFor({state:'visible'});
    await page.locator('#entityDescriptionToggle').click();
    assert.ok(await page.locator('#entityDescriptionText').evaluate(n=>n.scrollHeight<=n.clientHeight+1));
    await page.locator('#closeModal').click();await page.setViewportSize(viewport);
    checks.push(`${viewport.width}px: short task and long task/project; expand/collapse and resize; full histories and next steps; no clipped panels`);
    const session=(await context.cookies()).find(c=>c.name==='organizador_web_session');
    const payload=JSON.parse(Buffer.from(session.value.split('.')[0],'base64url').toString());
    const expired=Buffer.from(JSON.stringify({...payload,exp:1})).toString('base64url');
    const signature=crypto.createHmac('sha256',fs.readFileSync(path.join(output,'files/session_secret'),'utf8').trim()).update(expired).digest('base64url');
    await context.addCookies([{...session,value:expired+'.'+signature}]);
    await page.evaluate(()=>loadOverview());
    await page.getByText('Sesion caducada. Vuelve a entrar con tu usuario.',{exact:true}).waitFor();
    await context.clearCookies();
    assert.equal(await page.evaluate(async()=>{try{await api('/api/me');}catch(e){return e.message;}}),'No se ha recibido tu sesion. Vuelve a entrar con tu usuario.');
    for(const body of [JSON.stringify({error:'Traceback: private technical details'}),'<h1>upstream unavailable</h1>']){
      await page.route('**/api/login',route=>route.fulfill({status:500,body}));
      await page.locator('#loginPassword').fill(password);await page.locator('#loginButton').click();
      await page.getByText('Error tecnico del servidor. Vuelve a intentarlo mas tarde.',{exact:true}).waitFor();
      await page.unroute('**/api/login');
    }
    checks.push(`${viewport.width}px: wrong credentials, expired/missing session, JSON and non-JSON server failures displayed correctly`);
    assert.deepEqual(errors,[]);await context.close();
  }
  assert.equal(sql("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert not c.execute('PRAGMA foreign_key_check').fetchall(); print(c.execute('PRAGMA integrity_check').fetchone()[0])",[database]),'ok');
  console.log(JSON.stringify({ok:true,checks,output},null,2));
} finally {
  if(browser)await browser.close();child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));
}
