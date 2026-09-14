// Real browser + HTTPS boundary + isolated Python domain. No production writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createBankingHttp} from '../server/banking-http.js';
const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const python=path.join(root,'backups/erp4-runtime/Scripts/python.exe');
const bulk=process.argv.includes('--bulk');
const created=await exec(python,['scripts/erp4-web-fixture.py','create',process.argv[2]&&!process.argv[2].startsWith('--')?process.argv[2]:'backups/erp4-pre-20260911.db',...(bulk?['--bulk']:[])],{cwd:root});
const {fixture}=JSON.parse(created.stdout),config=JSON.parse(fs.readFileSync(fixture,'utf8')),dir=path.dirname(fixture);
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/EQUIPO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const pageErrors=[];let browser,base,handler;
const server=https.createServer({key:fs.readFileSync(path.join(dir,'tls.key')),cert:fs.readFileSync(path.join(dir,'tls.crt'))},async(req,res)=>{
  try{
    const url=new URL(req.url,base);
    if(url.pathname==='/'){
      res.setHeader('Set-Cookie','erp4_fixture=isolated; Secure; SameSite=Strict; HttpOnly');res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bancos y remesas - prueba aislada</title>
        <style>:root{--line:#dce2e3;--muted:#5b6767;--ink:#202828;--surface:#fff}*{box-sizing:border-box}body{font:14px Arial;margin:0;color:var(--ink);background:#f6f8f8}main{padding:24px;max-width:1600px;margin:auto}button,input,select,textarea{font:inherit;padding:9px;border:1px solid var(--line);border-radius:4px;background:white}button{cursor:pointer}label{display:flex;flex-direction:column;gap:6px}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:9px;border-bottom:1px solid var(--line)}.toolbar,.budgetToolbar{display:flex;gap:10px;align-items:center;margin:12px 0}.budgetTabs{display:flex;gap:4px;margin:16px 0}.active,.green{background:#176d60;color:white}.masterFormGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.finEditor,.finReview{max-width:960px}h3{font-size:18px}.finTableWrap{overflow:auto}@media(max-width:700px){main{padding:12px}}</style>
        <style>${fs.readFileSync(path.join(root,'server/workspace-ui.css'),'utf8')}</style><main><h1>Bancos y remesas</h1><div id="cards"></div></main>
        <script>${fs.readFileSync(path.join(root,'server/banking-ui.js'),'utf8')}</script><script>
        const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        async function api(url,options){const r=await fetch(url,options?{...options,headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store'}:{});const value=await r.json();if(!r.ok||value.ok===false)throw new Error(value.error||'Error');return value;}
        const cents=v=>{const x=String(v).replace(',','.');if(!/^\\d+(\\.\\d{1,2})?$/.test(x))throw new Error('Importe no valido');const [a,b='']=x.split('.');return (BigInt(a)*100n+BigInt(b.padEnd(2,'0'))).toString();};
        const money=v=>{const n=BigInt(v);return (n/100n).toString()+','+(n%100n).toString().padStart(2,'0')+' EUR';};
        window.ui=createBankingUI({api,html:h,root:()=>document.getElementById('cards'),active:()=>true,communities:()=>[{id_comunidad:${config.community},nombre:'Comunidad sintetica ERP 4'}],moneyLabel:money,moneyCents:cents,isSuperuser:()=>true,navigate:()=>ui.ensure()});ui.ensure();</script></html>`);return;
    }
    if(!await handler(req,res,url)){res.writeHead(404);res.end();}
  }catch{res.writeHead(500);res.end('Error del entorno de prueba');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='https://127.0.0.1:'+server.address().port;
handler=createBankingHttp({enabled:true,publicOrigin:base,trustLoopbackProxy:false},{
  readSession:req=>req.headers.cookie?.includes('erp4_fixture=isolated')?config.session:null,
  readBody:async(req,max)=>{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw new Error('Body limit');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks));},
  sendJson:(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));},
  verifyPassword:async(_,password)=>password==='synthetic-browser-password',
  runBanking:async(session,action,envelope)=>new Promise((resolve,reject)=>{
    const child=execFile(python,['scripts/erp4-web-fixture.py','request',fixture],{cwd:root,timeout:90000,maxBuffer:34*1024*1024},(error,stdout)=>{
      let value;try{value=JSON.parse(stdout);}catch{}
      if(error||!value?.ok){const e=new Error(value?.error||'Bridge failed');e.bankErrorType=value?.error_type;reject(e);}else resolve(value);
    });child.stdin.on('error',reject);child.stdin.end(JSON.stringify({session,action,envelope}));
  }),
});
try{
  browser=await pw.chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(base);await page.getByRole('button',{name:'Preparar remesa',exact:true}).waitFor();
  const click=async action=>page.locator(`[data-bank-action="${action}"]`).first().click();
  const fill=async(name,value)=>page.locator(`[name="${name}"]`).fill(value);
  const review=async()=>{await fill('reason','Evidencia sintetica revisada');await fill('evidence','TEST-DOCUMENT-ONLY');await page.locator('[data-bank-form="operation"] button:not([type="button"])').click();};
  const confirm=async()=>{await page.locator('[name="bankAck"]').check();await click('confirm');};
  await click('prepare');await page.locator('[name="creditor"]').selectOption(String(config.creditor_id));await fill('requested',config.requested_on);await review();
  await page.getByRole('heading',{name:'Seleccionar recibos'}).waitFor();await click('select-visible');
  if(bulk){await click('selection-next');await click('select-visible');await page.getByText('200 seleccionadas',{exact:false}).waitFor();}
  await page.screenshot({path:path.join(dir,'desktop-selection.png'),fullPage:true});
  await click('notice-draft');await page.locator('[name="sent_ack"]').check();
  await click('selection-review');await page.locator('[name="bankAck"]').waitFor();await confirm();
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');await click('build');await review();await confirm();
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');await click('export');await fill('password','synthetic-browser-password');await review();
  const downloaded=page.waitForEvent('download');await confirm();const file=await downloaded;const xml=fs.readFileSync(await file.path(),'utf8');
  assert(xml.includes('pain.008.001.08'));assert.equal((xml.match(/<DrctDbtTxInf>/g)||[]).length,config.receipt_ids.length);
  const pending=await page.evaluate(async community=>{
    const query=async(name,filters={})=>(await (await fetch('/api/erp/banking/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_comunidad:community,query:'erp4.'+name,filters})})).json()).entity;
    const list=await query('remittance.list');return (await query('remittance.get',{id:list.items[0].id})).lines.map(l=>l.receipt_balance.pending_cents);
  },config.community);
  assert.deepEqual(pending,config.receipt_ids.map(()=>'10000'));
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');
  await page.getByRole('heading',{name:'Remesa · '+config.requested_on,exact:true}).waitFor();
  await page.screenshot({path:path.join(dir,'desktop-remittance.png'),fullPage:!bulk});
  for(const width of [1920,390]){
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal page overflow '+width);
    await page.screenshot({path:path.join(dir,'remittance-'+width+'.png'),fullPage:!bulk});
  }
  await click('present');await fill('date',new Date().toLocaleDateString('sv-SE'));await fill('reference','TEST-BANK-PRESENTATION');await review();await confirm();
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');await click('result-manual');await review();await confirm();
  await page.getByRole('heading',{name:'Revision de resultado',exact:true}).waitFor();await click('result-line');await review();await confirm();
  await page.locator('[data-bank-action="section"][data-section="mandates"]').click();
  await page.locator('[data-bank-action="mandate-detail"]').first().waitFor();await click('mandate-detail');
  await page.screenshot({path:path.join(dir,'mobile-mandate.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await click('close');await page.locator('[data-bank-action="account"]').waitFor();await click('account');
  await fill('iban','ES9121000418450200051332');await fill('alias','Cuenta compartida de prueba');await review();
  assert(!await page.locator('.finReview').textContent().then(t=>t.includes('ES9121000418450200051332')));
  await click('edit');assert.equal(await page.locator('[name="alias"]').inputValue(),'Cuenta compartida de prueba');
  await click('close-form');
  await click('import');await fill('source','CSV bancario de prueba');
  await page.locator('[name="file"]').setInputFiles({name:'cuentas.csv',mimeType:'text/csv',buffer:Buffer.from('Propiedad;Cuenta;Alias\nVILLA-TEST;ES9121000418450200051332;Cuenta compartida')});
  await review();await page.getByRole('heading',{name:'Relacionar columnas',exact:true}).waitFor();
  await page.locator('[name="iban"]').selectOption('1');await page.locator('[name="alias"]').selectOption('2');await review();await confirm();
  await page.getByRole('heading',{name:'Importacion de cuentas',exact:true}).waitFor();await click('import-confirm');await review();await confirm();
  await page.locator('[data-bank-action="account"]').waitFor();
  await page.locator('[data-bank-action="section"][data-section="settings"]').click();
  await page.getByText('Documentos bancarios protegidos',{exact:true}).click();
  await click('bank-document-upload');
  const protectedBytes=Buffer.from('%PDF-1.7\nSynthetic bank mandate ES9121000418450200051332\n%%EOF');
  await page.locator('[name="file"]').setInputFiles({name:'mandato.pdf',mimeType:'application/pdf',buffer:protectedBytes});
  await review();await confirm();
  await page.getByText('Documentos bancarios protegidos',{exact:true}).click();
  await click('bank-document-download');await fill('password','synthetic-browser-password');await review();
  const documentDownload=page.waitForEvent('download');await confirm();
  assert.deepEqual(fs.readFileSync(await (await documentDownload).path()),protectedBytes);
  await page.locator('[data-bank-action="section"][data-section="remittances"]').click();
  for(const kind of ['settlement','returned']){
    await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');await click('result-manual');
    await page.locator('[name="kind"]').selectOption(kind);await page.getByText('Movimiento de fondos',{exact:true}).click();
    await fill('amount','100.00');await fill('bank_event','SYNTHETIC-WEB-'+kind);await fill('psp','TEST-PSP');await page.locator('[name="funds"]').check();
    await page.locator('[name="terminal"]').check();await review();await confirm();
    await page.getByRole('heading',{name:'Revision de resultado',exact:true}).waitFor();await click('result-line');
    if(kind==='settlement')await fill('allocate','100.00');
    else{await page.locator('[name="collection"]').selectOption({index:1});await page.locator('[name^="reverse_"]').first().fill('100.00');}
    await review();await confirm();
  }
  const afterReturn=await page.evaluate(async community=>{
    const query=async(name,filters={})=>(await (await fetch('/api/erp/banking/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_comunidad:community,query:'erp4.'+name,filters})})).json()).entity;
    const list=await query('remittance.list');return (await query('remittance.get',{id:list.items[0].id})).lines[0];
  },config.community);
  assert.equal(afterReturn.state,'returned');assert.equal(afterReturn.receipt_balance.pending_cents,'10000');
  await page.locator('[data-bank-action="section"][data-section="remittances"]').click();
  await click('prepare');await page.locator('[name="creditor"]').selectOption(String(config.creditor_id));await fill('requested',config.requested_on);await review();
  await page.getByRole('heading',{name:'Seleccionar recibos',exact:true}).waitFor();await click('select-visible');
  if(bulk){await click('selection-next');await click('select-visible');}
  assert.equal(await page.locator('[data-bank-select]:checked').count(),1,'Only returned receipt is eligible for the new attempt');
  await page.locator('[name="sent_ack"]').check();await click('selection-review');await confirm();
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');
  await click('cancel-local');await review();await confirm();
  await page.locator('[data-bank-action="section"][data-section="external"]').click();await click('external');
  await fill('source','Programa anterior sintetico');await fill('reference','EXT-WEB-TEST');await review();
  await page.getByRole('heading',{name:'Seleccionar recibos con instruccion externa',exact:true}).waitFor();await click('select-visible');
  if(bulk){await click('selection-next');await click('select-visible');}
  assert.equal(await page.locator('[data-bank-select]:checked').count(),1);
  await click('selection-review');await confirm();await page.locator('[data-bank-action="external-close"]').waitFor();
  await click('external-close');await review();await confirm();
  await page.locator('[data-bank-form="external-search"]').waitFor();
  assert.equal(await page.locator('[data-bank-action="external-close"]').count(),0);
  await page.locator('[data-bank-action="section"][data-section="mandates"]').click();await click('mandate-detail');
  await click('mandate-account');await review();await confirm();
  await page.locator('[data-bank-action="mandate-detail"]').first().waitFor();await click('mandate-detail');
  await page.getByText('Pendiente de revision',{exact:true}).first().waitFor();
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({ok:true,fixture,https:true,domain:'isolated-real-services',viewports:[1440,1920,390],screenshots:dir,
    exportDoesNotCollect:true,flows:['bulk-selection','prepare','build','export','present','technical-result-confirm','mandate','masked-account-review','edit-before-confirm','file-import-map-preview-confirm','protected-document-upload-download','collection-allocation-return-erp3','confirmed-retry','cancel-retry','external-cutover-selection-close','mandate-amendment-review']}));
}catch(error){
  const page=browser?.contexts()[0]?.pages()[0];
  if(page){await page.screenshot({path:path.join(dir,'failure.png'),fullPage:true});console.error(JSON.stringify({fixture,alerts:await page.locator('[role="alert"]').allTextContents()}));}
  throw error;
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
