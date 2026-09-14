// Full application acceptance via an SSH-forwarded isolated Linux gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_PATH||'C:/Users/EQUIPO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const base='https://127.0.0.1:18874';
const out=fs.mkdtempSync(path.join(os.tmpdir(),'erp4-full-app-'));
const browser=await pw.chromium.launch({channel:'msedge',headless:true});
const errors=[];
try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('#loginUser').selectOption({label:'ERP4 Acceptance'});
  await page.locator('#loginPassword').fill('synthetic-linux-acceptance-only');await page.locator('#loginButton').click();
  await page.waitForFunction(()=>!document.getElementById('communityScopeModal').classList.contains('hidden')||!document.getElementById('appView').classList.contains('hidden'));
  if(await page.locator('#confirmCommunityScope').isVisible())await page.locator('#confirmCommunityScope').click();
  await page.locator('#appView').waitFor({state:'visible'});
  const cookies=await context.cookies();assert(cookies.length&&cookies.every(c=>c.secure),'Secure session required');
  const click=async action=>page.locator(`[data-bank-action="${action}"]`).first().click();
  const fill=async(name,value)=>page.locator(`[name="${name}"]`).fill(value);
  const review=async()=>{await fill('reason','Aceptacion sintetica completa');await fill('evidence','ISOLATED-APP-ACCEPTANCE');await page.locator('[data-bank-form="operation"] button:not([type="button"])').click();};
  const confirm=async()=>{await page.locator('[name="bankAck"]').check();await click('confirm');};
  const query=async(name,filters={})=>page.evaluate(async({name,filters})=>(await (await fetch('/api/erp/banking/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id_comunidad:7,query:'erp4.'+name,filters})})).json()).entity,{name,filters});
  await page.locator('[data-workspace-area="management"]').first().click();await page.locator('#masterDataTab').click();
  await page.locator('#masterCommunity').selectOption('7');await page.locator('[data-master-section="properties"]').click();
  const mandate=(await query('mandate.list')).items[0];
  let property;for(let offset=0;!property&&offset<20000;offset+=200){const refs=await query('reference.list',{kind:'properties',limit:200,offset});property=refs.items.find(r=>r.id===mandate.property_ids[0]);if(offset+200>=refs.total)break;}
  assert(property,'Fixture mandate property available');
  await page.locator('#masterSearchForm [name="search"]').fill(property.label);await page.locator('#masterSearchForm button').click();
  await page.locator(`[data-master-property="${property.id}"]`).click();
  await page.locator('#masterPropertyForm').waitFor();
  await page.getByRole('button',{name:'Domiciliaciones y remesas',exact:true}).click();
  await page.locator('.finScope').waitFor();assert((await page.locator('.finScope').textContent()).includes(property.label));
  await click('mandate-detail');await page.getByRole('button',{name:'Gestionar propiedades',exact:true}).waitFor();await click('close');
  await page.locator('[data-bank-action="section"][data-section="remittances"]').click();
  await click('prepare');const creditor=(await query('creditor.list')).items[0];
  const existing=(await query('remittance.list')).items[0];
  await page.locator('[name="creditor"]').selectOption(String(creditor.id));await fill('requested',existing.requested_on);await review();
  await page.getByRole('heading',{name:'Seleccionar recibos',exact:true}).waitFor();await click('select-visible');
  assert.equal(await page.locator('[data-bank-select]:checked').count(),1);
  await page.locator('[name="sent_ack"]').check();await click('selection-review');await confirm();
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');await click('build');await review();await confirm();
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');await click('export');await fill('password','synthetic-linux-acceptance-only');await review();
  const exported=page.waitForEvent('download');await confirm();assert(fs.readFileSync(await (await exported).path(),'utf8').includes('pain.008.001.08'));
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');
  await page.getByRole('heading',{name:'Remesa · '+existing.requested_on,exact:true}).waitFor();
  await page.waitForFunction(()=>document.getElementById('cards').getAttribute('aria-busy')!=='true');
  for(const width of [1440,1920,390]){
    await page.setViewportSize({width,height:1000});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page overflows at '+width);
    await page.screenshot({path:path.join(out,`full-app-${width}.png`),fullPage:true});
  }
  await click('result-manual');await page.locator('[name="kind"]').selectOption('rejected');await page.locator('[name="terminal"]').check();await review();await confirm();
  await page.getByRole('heading',{name:'Revision de resultado',exact:true}).waitFor();await page.locator('[name="result_row"]').check();await click('result-batch');await review();await confirm();
  await page.locator('[data-bank-action="section"][data-section="remittances"]').click();await click('prepare');
  await page.locator('[name="creditor"]').selectOption(String(creditor.id));await fill('requested',existing.requested_on);await review();
  await page.getByRole('heading',{name:'Seleccionar recibos',exact:true}).waitFor();await click('select-visible');await page.locator('[name="sent_ack"]').check();await click('selection-review');await confirm();
  await page.locator('[data-bank-action="remittance"]').first().waitFor();await click('remittance');await click('cancel-local');await review();await confirm();
  await page.setViewportSize({width:1440,height:1000});await page.locator('#masterDataTab').click();
  await page.locator('[data-master-section="owners"]').click();await page.locator('[data-master-owner]').first().click();
  await page.getByRole('button',{name:'Domiciliaciones y remesas',exact:true}).click();await page.locator('.finScope').waitFor();
  await page.locator('#masterDataTab').click();await page.locator('[data-master-section="community"]').click();
  await page.getByRole('button',{name:'Domiciliaciones y remesas',exact:true}).click();await page.getByRole('button',{name:'Preparar remesa',exact:true}).waitFor();
  let returnedRemittance;
  for(const rem of (await query('remittance.list')).items){const detail=await query('remittance.get',{id:rem.id});if(detail.lines.some(l=>l.state==='returned'&&l.events.some(e=>e.return_id))){returnedRemittance=rem.id;break;}}
  assert(returnedRemittance,'An isolated return exists for the ERP3 contextual fee');
  await page.locator(`[data-bank-action="remittance"][data-id="${returnedRemittance}"]`).click();await click('return-fee');
  await page.getByRole('heading',{name:'Gasto independiente de devolucion',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,fullShell:true,posixRuntime:true,secureCookie:true,viewports:[1440,1920,390],screenshots:out,flows:['property-context','mandate','selection','export','batch-rejection','confirmed-retry','cancel','owner-context','community-context','erp3-return-fee-context']}));
}catch(error){
  const page=browser.contexts()[0]?.pages()[0];
  if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});
  console.error(JSON.stringify({ok:false,error:String(error),pageErrors:errors,screenshots:out}));process.exitCode=1;
}finally{await browser.close();}
