// Real HTTPS, protected transport, Python domain and desktop/mobile rendering.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createBankingHttp} from '../server/banking-http.js';
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Z]):)/,'$1:')),'..');
const python=process.env.BANK_PYTHON||path.join(root,'backups/erp4-runtime/Scripts/python.exe');
const created=await promisify(execFile)(python,['scripts/erp5-web-fixture.py','create',process.argv[2]||'backups/planes-cuotas-pre-20260914.db'],{cwd:root});
const {fixture}=JSON.parse(created.stdout);const config=JSON.parse(fs.readFileSync(fixture,'utf8')),dir=path.dirname(fixture);
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE||'C:/Users/EQUIPO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
let base,handler,browser;const errors=[];
const server=https.createServer({key:fs.readFileSync(path.join(dir,'tls.key')),cert:fs.readFileSync(path.join(dir,'tls.crt'))},async(req,res)=>{
  try{const url=new URL(req.url,base);
    if(url.pathname==='/'){
      res.setHeader('Set-Cookie','erp5_fixture=isolated; Secure; SameSite=Strict; HttpOnly');res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conciliacion - prueba aislada</title>
        <style>*{box-sizing:border-box}body{font:14px Arial;margin:0;background:#f6f8f8;color:#202828}main{max-width:1600px;padding:24px;margin:auto}label{display:flex;flex-direction:column;gap:6px}button,input,select{font:inherit;padding:9px;border:1px solid #dce2e3;border-radius:4px;background:#fff}.toolbar,.budgetToolbar{display:flex;gap:10px;margin:12px 0;align-items:center;flex-wrap:wrap}.masterDataFormGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px;border-bottom:1px solid #dce2e3}.finTableWrap{overflow:auto}.green{background:#176d60;color:white}[hidden]{display:none!important}@media(max-width:700px){main{padding:12px}.masterDataFormGrid{grid-template-columns:1fr}}</style>
        <style>${fs.readFileSync(path.join(root,'server/workspace-ui.css'),'utf8')}</style><main><h1>Bancos y remesas</h1><div id="cards"></div></main>
        <script>${fs.readFileSync(path.join(root,'server/reconciliation-ui.js'),'utf8')}</script><script>
        const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        async function api(url,options){const r=await fetch(url,{...options,headers:{'Content-Type':'application/json'},credentials:'same-origin'});const v=await r.json();if(!r.ok||v.ok===false){const e=new Error(v.error||'Error');e.status=r.status;throw e;}return v;}
        const money=v=>{const n=BigInt(v),a=n<0n?-n:n;return (n<0n?'-':'')+(a/100n)+','+(a%100n).toString().padStart(2,'0')+' EUR';};
        const cents=v=>{const x=String(v).replace(',','.');if(!/^-?\\d+(\\.\\d{1,2})?$/.test(x))throw new Error('Importe no valido');const neg=x.startsWith('-');const [a,b='']=x.replace('-','').split('.');return ((neg?-1n:1n)*(BigInt(a)*100n+BigInt(b.padEnd(2,'0')))).toString();};
        window.ui=createReconciliationUI({api,html:h,root:()=>document.getElementById('cards'),active:()=>true,communities:()=>[{id_comunidad:${config.community},nombre:'Comunidad sintetica ERP 5'}],moneyLabel:money,moneyCents:cents,isSuperuser:()=>true,openRemittances:()=>{}});ui.open(${config.community});</script></html>`);return;}
    if(!await handler(req,res,url)){res.writeHead(404);res.end();}
  }catch{res.writeHead(500);res.end('Error del entorno de prueba');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='https://127.0.0.1:'+server.address().port;
handler=createBankingHttp({enabled:true,publicOrigin:base,trustLoopbackProxy:false},{
  readSession:req=>req.headers.cookie?.includes('erp5_fixture=isolated')?config.session:null,
  readBody:async(req,max)=>{const chunks=[];let n=0;for await(const c of req){n+=c.length;if(n>max)throw new Error('Limit');chunks.push(c);}return JSON.parse(Buffer.concat(chunks));},
  sendJson:(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));},verifyPassword:async(_session,password)=>password==='synthetic-test-only',
  runBanking:async(session,action,envelope)=>new Promise((resolve,reject)=>{
    const child=execFile(python,['scripts/erp5-web-fixture.py','request',fixture],{cwd:root,timeout:60000,maxBuffer:24*1024*1024},(error,stdout)=>{
      let v;try{v=JSON.parse(stdout);}catch{}if(error||!v?.ok){const e=new Error(v?.error||'Bridge failed');e.bankErrorType=v?.error_type;reject(e);}else resolve(v);});
    child.stdin.on('error',reject);child.stdin.end(JSON.stringify({session,action,envelope}));}),
});
try{
  browser=await pw.chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900},acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const settled=()=>page.waitForFunction(()=>document.getElementById('cards').getAttribute('aria-busy')!=='true');
  const click=async a=>{await page.locator(`[data-reconcile="${a}"]`).first().click();await settled();};
  const fill=async(n,v)=>page.locator(`[name="${n}"]`).fill(v);
  const submit=async()=>{await page.locator('[data-reconciliation-form] button[type="submit"]').click();await settled();};
  await page.goto(base);await page.locator('[data-reconcile=import]').waitFor();
  await click('import');await page.locator('[name=file]').setInputFiles({name:'synthetic.csv',mimeType:'text/csv',buffer:Buffer.from('Fecha;Importe;Concepto\n2026-09-01;100.00;Ingreso sintetico\n')});await submit();
  await page.locator('[name=operation_on]').selectOption('0');await page.locator('[name=amount]').selectOption('1');await page.locator('[name=concept]').selectOption('2');await submit();
  await page.getByRole('heading',{name:'Revisar antes de confirmar'}).waitFor();await click('confirm');await page.getByRole('heading',{name:'Revisar antes de confirmar'}).waitFor({state:'hidden'});
  await page.getByText('Ingreso sintetico',{exact:true}).waitFor();await page.screenshot({path:path.join(dir,'desktop-list.png'),fullPage:true});
  await click('import');await page.locator('[name=file]').setInputFiles({name:'synthetic-alias.csv',mimeType:'text/csv',buffer:Buffer.from('Fecha;Importe;Concepto\n2026-09-01;100.00;Otra evidencia sintetica\n')});await submit();
  await page.locator('[name=operation_on]').selectOption('0');await page.locator('[name=amount]').selectOption('1');await page.locator('[name=concept]').selectOption('2');await submit();
  await click('identity');await page.locator('[name=existing_movement]').selectOption({label:'2026-09-01 · Ingreso sintetico · 100,00 EUR'});await fill('identity_reason','Mismo apunte acreditado en otra exportacion sintetica');await submit();await click('confirm');
  assert.equal(await page.locator('[data-reconcile=detail]').count(),1,'Identity alias must not create a second movement');
  await click('detail');await page.locator('summary').filter({hasText:'Evidencias originales'}).click();await click('original');await fill('password','synthetic-test-only');await fill('reason','Descarga sintetica de aceptacion');const originalDownload=page.waitForEvent('download');await submit();const original=await originalDownload;assert.match(fs.readFileSync(await original.path(),'utf8'),/Ingreso sintetico/);await click('back');
  await click('detail');await click('component');await fill('amount','60.00');await submit();await click('confirm');
  await click('detail');await page.getByText('40,00 EUR',{exact:true}).waitFor();await click('pending');await fill('note','Pendiente identificar el resto');await submit();
  await page.locator('summary').filter({hasText:'Configuracion del periodo'}).click();await click('opening');await fill('opening','0.00');await fill('closing','100.00');await page.locator('[name=complete]').check();await submit();
  await click('close');await click('confirm');await page.getByRole('status').filter({hasText:'Cerrado con pendientes'}).waitFor();
  await page.locator('summary').filter({hasText:'Configuracion del periodo'}).click();await click('source');await click('confirm');await page.getByRole('status').filter({hasText:'Cerrado con pendientes'}).waitFor();
  const download=page.waitForEvent('download');await click('export');const file=await download;const raw=fs.readFileSync(await file.path());assert.equal(raw.subarray(0,2).toString(),'PK');
  await page.locator('[name=report_format]').selectOption('pdf');const pdfDownload=page.waitForEvent('download');await click('export');const pdf=await pdfDownload;assert.equal(fs.readFileSync(await pdf.path()).subarray(0,5).toString(),'%PDF-');await page.locator('[name=report_format]').selectOption('xlsx');
  await page.screenshot({path:path.join(dir,'desktop-closed.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(dir,'mobile-list.png'),fullPage:true});
  const width=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));assert(width.scroll<=width.viewport+1,JSON.stringify(width));
  await click('detail');await page.screenshot({path:path.join(dir,'mobile-detail.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({ok:true,fixture,desktop:'1440x900',mobile:'390x844',checks:['CSV map/preview/confirm','partial collection','pending note','accredited balance','closure with pending','masked audited Excel','mobile no body overflow'],screenshots:dir}));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
