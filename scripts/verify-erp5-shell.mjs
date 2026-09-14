// Full application acceptance through the guarded, SSH-forwarded synthetic gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const pw=await import(pathToFileURL(process.env.PLAYWRIGHT_PATH||'C:/Users/EQUIPO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'));
const out=fs.mkdtempSync(path.join(os.tmpdir(),'erp5-full-shell-'));
const browser=await pw.chromium.launch({channel:'msedge',headless:true});
const errors=[];
let step='login';
try{
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:900}});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('https://127.0.0.1:18874');
  await page.locator('#loginUser').selectOption({label:'ERP4 Acceptance'});
  await page.locator('#loginPassword').fill('synthetic-linux-acceptance-only');await page.locator('#loginButton').click();
  await page.waitForFunction(()=>!document.getElementById('communityScopeModal').classList.contains('hidden')||!document.getElementById('appView').classList.contains('hidden'));
  if(await page.locator('#confirmCommunityScope').isVisible())await page.locator('#confirmCommunityScope').click();
  await page.locator('#appView').waitFor({state:'visible'});
  assert((await context.cookies()).every(c=>c.secure));
  await page.locator('[data-workspace-area="management"]').first().click();await page.locator('#bankingTab').click();
  await page.locator('[name=bankCommunity]').selectOption('7');
  await page.locator('[data-bank-action="section"][data-section="reconciliation"]').click();
  await page.getByRole('heading',{name:'Conciliacion bancaria',exact:true}).waitFor();
  const settled=async()=>page.waitForFunction(()=>document.getElementById('cards').getAttribute('aria-busy')!=='true');
  await settled();
  const click=async name=>{step=name;await page.locator(`[data-reconcile="${name}"]`).first().click();await settled();};
  const submit=async()=>{step='submit';await page.locator('[data-reconciliation-form] button[type=submit]').click();await settled();};
  const detail=async concept=>{step='detail '+concept;await page.locator('tr').filter({has:page.getByText(concept,{exact:true})}).locator('[data-reconcile=detail]').click();await settled();};
  await page.locator('.reconcileWorkspace [name=start]').fill('2026-09-01');
  await page.locator('.reconcileWorkspace [name=end]').fill('2026-09-30');await click('reload');
  await page.locator('[data-reconcile=detail]').first().waitFor();await click('detail');
  await page.getByRole('heading',{name:'Historico de correspondencias',exact:true}).waitFor();
  await page.locator('[name=window_days]').fill('14');await click('proposals');
  await page.waitForFunction(()=>document.querySelector('[name=window_days]')?.value==='14');await click('back');
  if(process.env.ERP5_NET_ONLY==='1'){
    await page.locator('summary').filter({hasText:'Cierres anteriores'}).click();page.once('dialog',dialog=>dialog.accept('Revision sintetica del desglose neto'));await click('reopen');
    await click('manual');await page.locator('[name=on]').fill('2026-09-01');await page.locator('[name=amount]').fill('98.00');await page.locator('[name=concept]').fill('Neto de aceptacion integral');await submit();await click('confirm');
    await detail('Neto de aceptacion integral');await click('component');
    let economicConfirmations=0;page.on('request',request=>{if(request.url().endsWith('/api/erp/banking/command')&&request.postDataJSON()?.command==='erp5.match.confirm')economicConfirmations++;});
    await page.locator('[name=amount]').fill('100.00');await page.locator('summary').filter({hasText:'Desglose bruto / neto'}).click();await page.locator('[name=net_evidence]').fill('SYNTHETIC-NET-100-MINUS-2');await click('stage-component');
    await page.locator('[name=action]').selectOption('record_outflow');await page.locator('[name=kind]').selectOption('commission');await page.locator('[name=amount]').fill('2.00');await click('stage-component');
    assert.equal(economicConfirmations,0,'Preparing a breakdown must not persist money');
    await click('review-components');assert.equal(economicConfirmations,0,'Preview must not persist money');
    await page.screenshot({path:path.join(out,'net-review.png'),fullPage:true});await click('confirm');assert.equal(economicConfirmations,1);
    await detail('Neto de aceptacion integral');assert.match(await page.locator('td[data-label="Pendiente"]').textContent(),/^0,00 (?:EUR|\u20ac)$/);await click('back');
  }else{
  await click('manual');await page.locator('[name=on]').fill('2026-09-01');await page.locator('[name=amount]').fill('100.00');await page.locator('[name=concept]').fill('Cobro de aceptacion integral');await submit();await click('confirm');
  await detail('Cobro de aceptacion integral');await click('component');await page.locator('[name=amount]').fill('60.00');await submit();await click('confirm');
  await detail('Cobro de aceptacion integral');await page.getByText(/^40,00 (?:EUR|\u20ac)$/).waitFor();await click('pending');await page.locator('[name=note]').fill('Pendiente identificar remanente acreditado');await submit();
  await click('manual');await page.locator('[name=on]').fill('2026-09-01');await page.locator('[name=amount]').fill('-20.00');await page.locator('[name=concept]').fill('Salida de aceptacion integral');await submit();await click('confirm');
  await detail('Salida de aceptacion integral');await click('component');await page.locator('[name=action]').selectOption('record_outflow');await page.locator('[name=amount]').fill('15.00');await submit();await click('confirm');
  await detail('Salida de aceptacion integral');await page.getByText('Pendiente de documento',{exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.accept());await click('reverse');await detail('Salida de aceptacion integral');
  await page.getByText('Enlace revertido',{exact:true}).waitFor();await click('fact-reversal');await page.locator('[name=effective_on]').fill('2026-09-02');
  await page.locator('summary').filter({hasText:'Motivo y documento'}).click();await page.locator('[name=reason]').fill('Rectificar salida registrada por error, manteniendo el apunte');await page.locator('[name=evidence]').fill('SYNTHETIC-RECTIFICATION');await submit();
  await page.getByText(/^15,00 (?:EUR|\u20ac)$/).waitFor();await click('confirm');
  await detail('Salida de aceptacion integral');await click('pending');await page.locator('[name=note]').fill('Identificar cargo bancario sin salida artificial');await submit();
  await page.locator('summary').filter({hasText:'Configuracion del periodo'}).click();await click('opening');await page.locator('[name=opening]').fill('0.00');await page.locator('[name=closing]').fill('180.00');await page.locator('[name=complete]').check();await submit();
  await click('close');await click('confirm');await page.getByRole('status').filter({hasText:'Cerrado con pendientes'}).waitFor();
  }
  for(const width of [1440,1920,390]){
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Global overflow at '+width);
    assert(await page.locator('.reconcileWorkspace>.budgetToolbar :is(input,select)').evaluateAll(nodes=>nodes.every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})),'Clipped account/date control at '+width);
    await page.screenshot({path:path.join(out,'bank-'+width+'.png'),fullPage:true});
  }
  await page.setViewportSize({width:1440,height:900});await click('remittances');await page.locator('[data-bank-action="section"][data-section="remittances"]').waitFor();
  await page.locator('#receivablesTab').click();await page.locator('[data-fin-action="section"][data-section="collections"]').click();
  await page.locator('[data-fin-action=collection]').first().waitFor();await page.locator('[data-fin-action=collection]').first().click();
  await page.getByRole('button',{name:'Movimientos bancarios vinculados',exact:true}).click();
  await page.getByRole('heading',{name:'Conciliacion bancaria',exact:true}).waitFor();await settled();
  await page.screenshot({path:path.join(out,'collection-context.png'),fullPage:true});assert.deepEqual(errors,[]);
  const contextualQueries=[];
  page.on('request',request=>{
    if(request.url().endsWith('/api/erp/banking/query')&&request.postDataJSON()?.query==='erp5.movement.list')contextualQueries.push(request.postDataJSON());
  });
  for(const section of ['properties','owners','community']){
    step='master context '+section;
    await page.locator('#masterDataTab').click();await page.locator('#masterCommunity').selectOption('7');
    await page.locator(`[data-master-section="${section}"]`).click();
    let expected;
    if(section!=='community'){
      const attr=section==='properties'?'data-master-property':'data-master-owner';
      const row=page.locator(`[${attr}]`).first();await row.waitFor();expected=Number(await row.getAttribute(attr));await row.click();
      await page.waitForFunction(()=>document.querySelector('.masterRow.selected'));
    }
    const before=contextualQueries.length;
    await page.getByRole('button',{name:'Domiciliaciones y remesas',exact:true}).click();
    await page.locator('[data-bank-action="section"][data-section="reconciliation"]').click();
    await page.getByRole('heading',{name:'Conciliacion bancaria',exact:true}).waitFor();await settled();
    await page.waitForFunction(()=>document.getElementById('cards').getAttribute('aria-busy')!=='true');
    assert(contextualQueries.length>before,'Context must call the bank domain');
    const query=contextualQueries.at(-1);assert.equal(query.id_comunidad,7);
    if(section!=='community')assert.equal(query.filters[section==='properties'?'property_id':'owner_id'],expected);
    else assert(!query.filters.property_id&&!query.filters.owner_id,'Community must not inherit another record context');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await page.setViewportSize({width:1440,height:900});
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,fullShell:true,netBreakdown:process.env.ERP5_NET_ONLY==='1',secureSession:true,viewports:[1440,1920,390],screenshots:out,
    contextualMasterRecords:['property','owner','community'],
    flows:process.env.ERP5_NET_ONLY==='1'?['login','reopen','manual-import','net-breakdown-draft-no-effects','net-human-preview-confirm','exact-zero-remanent','remittance-return','collection-context']:['login','navigation','reconciliation','movement-history','visible-date-window','manual-import','partial-collection','document-pending-outflow','unlink-preserves-outflow','explicit-outflow-rectification','closure-with-documented-pending','remittance-return','collection-context']}));
}catch(error){
  const page=browser.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true});
  console.error(JSON.stringify({ok:false,step,error:String(error),pageErrors:errors,screenshots:out}));process.exitCode=1;
}finally{await browser.close();}
