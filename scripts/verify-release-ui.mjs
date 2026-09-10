import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const database = process.env.UI_FIXTURE_DB;
assert.ok(database && fs.existsSync(database), 'Use the isolated fixture from KEEP_VERIFY_FIXTURE=1, never the live database.');
assert.ok(path.basename(path.dirname(database)).startsWith('organizador-release-'), 'Only a release-test fixture is accepted.');
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'organizador-ui-release-'));
const socket = net.createServer();
await new Promise(resolve=>socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve=>socket.close(resolve));
const child = spawn(process.execPath, [path.join(root, 'server/index.js')], {cwd:root, env:{...process.env,
  DATABASE_PATH:database, DATA_DIR:path.join(path.dirname(database),'files'), PORT:String(port), HOST:'127.0.0.1',
  AI_PROVIDER:'local', AI_API_KEY:'', NVIDIA_API_KEY:'', OPENAI_API_KEY:'',
}, stdio:['ignore','pipe','pipe']});
let serverLog='';
child.stderr.on('data',data=>serverLog+=data);
child.stdout.on('data',data=>serverLog+=data);
let browser;
try {
  const base=`http://127.0.0.1:${port}`;
  let ready=false;
  for(let i=0;i<50;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await delay(200);}
  assert.ok(ready, serverLog);
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || 'msedge', headless:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    const context=await browser.newContext({viewport});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    await page.locator('#loginUser option').first().waitFor({state:'attached'});
    await page.locator('#loginUser').selectOption({label:'SuperUsuario'});
    await page.locator('#loginPassword').fill('Only-local-fixture-629');
    const [loginResponse]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/login')),page.locator('#loginButton').click()]);
    assert.equal(loginResponse.status(),200,await loginResponse.text());
    await page.locator('#appView').waitFor({state:'visible'});
    for(const view of ['home','tasks','projects','master-data','admin','ai']){
      if(viewport.width<600){
        await page.locator('#mobileMenuToggle').click();
        await page.locator(`#mobileDrawerNav [data-mobile-view="${view}"]`).click();
      }else{
        const tab=page.locator(`#tabs [data-view="${view}"]`);
        if(!await tab.count()){
          await page.locator(`[id$="Tab"][data-view="${view}"]`).evaluate(el=>el.click());
        }else await tab.evaluate(el=>el.click());
      }
      await page.waitForTimeout(800);
      assert.equal(await page.locator('#appView').getAttribute('data-view'),view);
      const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);
      assert.ok(!overflow, `Horizontal overflow in ${view} at ${viewport.width}`);
      await page.screenshot({path:path.join(output,`${viewport.width}-${view}.png`),fullPage:true});
      if(view==='master-data') {
        await page.locator('#masterCommunity').waitFor();
        await page.locator('[data-master-section="properties"]').waitFor();
        await page.locator('#masterNewProperty').click();
        assert.equal(await page.locator('#masterPropertyForm [name="estado"]').count(),0);
        assert.equal(await page.locator('#masterPropertyForm [name="calidad_dato"]').count(),0);
        const propertyCode=`ERP1-UX-${viewport.width}-${Date.now()}`;
        await page.locator('#masterPropertyForm [name="codigo_propiedad"]').fill(propertyCode);
        const [propertyCreatedResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterPropertyForm button').click(),
        ]);
        const propertyCreated=await propertyCreatedResponse.json();
        assert.equal(propertyCreated.entity.estado,'activa');
        assert.equal(propertyCreated.entity.calidad_dato,'validada');
        await page.locator(`#masterPropertyForm [name="codigo_propiedad"][value="${propertyCode}"]`).waitFor();
        await page.locator('#masterPropertyForm [name="descripcion_direccion"]').fill('Descripcion UX editada');
        const [propertyEditedResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterPropertyForm button').click(),
        ]);
        const propertyEdited=await propertyEditedResponse.json();
        assert.equal(propertyEdited.entity.estado,'activa');
        assert.equal(propertyEdited.entity.calidad_dato,'validada');
        assert.equal(propertyEdited.entity.descripcion_direccion,'Descripcion UX editada');
        await page.locator('#masterPropertyForm [name="descripcion_direccion"][value="Descripcion UX editada"]').waitFor();
        assert.ok(await page.locator('.masterPropertyFlags').getByText('Datos validados').isVisible());
        await page.screenshot({path:path.join(output,`${viewport.width}-master-property-edit.png`),fullPage:true});
        await page.locator('#masterSearchForm input').fill('ERP');
        await page.locator('#masterSearchForm button').click();
        await page.waitForTimeout(500);
        assert.ok(await page.locator('.masterShell').isVisible());
        assert.ok(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)),'Master data horizontal overflow');
        await page.locator('[data-master-section="owners"]').click();
        await page.locator('[data-master-owner]').first().click();
        const email=page.locator('[data-common-contact-type="email"]').first();
        await email.waitFor();
        const changedEmail=`erp1.ui.${viewport.width}.${Date.now()}@example.invalid`;
        await email.fill(changedEmail);
        const [contactResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterCommonContactsForm button').click(),
        ]);
        assert.equal(contactResponse.status(),200,await contactResponse.text());
        await page.locator(`[data-common-contact-type="email"][value="${changedEmail}"]`).waitFor();
        assert.ok(await page.locator('.masterAddContact summary').filter({hasText:'+ Añadir contacto'}).isVisible());
        assert.ok(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)),'Master contacts horizontal overflow');
        await page.evaluate(()=>window.scrollTo(0,0));
        await page.screenshot({path:path.join(output,`${viewport.width}-master-contacts.png`),fullPage:true});

        assert.equal(await page.locator('[data-master-section="ownership"]').count(),0);
        await page.locator('[data-master-section="properties"]').click();
        await page.locator(`[data-master-property="${propertyCreated.entity.id_propiedad}"]`).click();
        await page.locator('#masterStartOwnership').click();
        await page.locator('#masterOwnershipForm [name="efectiva_desde"]').fill(new Date().toISOString().slice(0,10));
        await page.locator('#masterOwnershipForm .ownershipOwner').first().selectOption({index:1});
        await page.locator('#masterOwnershipForm .ownershipPct').first().fill('100');
        const [ownershipProposalResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterOwnershipForm button.green').click(),
        ]);
        assert.equal(ownershipProposalResponse.status(),200,await ownershipProposalResponse.text());
        await page.locator('#masterConfirmOwnership').waitFor();
        const [ownershipConfirmResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterConfirmOwnership').click(),
          page.once('dialog',dialog=>dialog.accept()),
        ]);
        assert.equal(ownershipConfirmResponse.status(),200,await ownershipConfirmResponse.text());
        await page.locator('[data-master-owner-link]').first().waitFor();
        const ownerName=await page.locator('[data-master-owner-link]').first().innerText();
        await page.locator('[data-master-owner-link]').first().click();
        await page.locator('[data-master-section="owners"].active').waitFor();
        await page.locator(`[data-master-property-link="${propertyCreated.entity.id_propiedad}"]`).waitFor();
        await page.locator(`[data-master-property-link="${propertyCreated.entity.id_propiedad}"]`).click();
        await page.locator('[data-master-section="properties"].active').waitFor();
        assert.match(await page.locator('.masterOwnershipCard').first().innerText(),new RegExp(ownerName.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
        await page.screenshot({path:path.join(output,`${viewport.width}-master-ownership.png`),fullPage:true});

        await page.locator('[data-master-section="structures"]').click();
        await page.locator('.masterStructureIntro').getByText(/no determina por si misma/i).waitFor();
        await page.locator('.masterAddContact summary').filter({hasText:'+ Crear estructura'}).click();
        const phaseCode=`UX-PHASE-${viewport.width}-${Date.now()}`;
        await page.locator('#masterStructureCreateForm [name="codigo"]').fill(phaseCode);
        await page.locator('#masterStructureCreateForm [name="nombre"]').fill('Fase UX');
        await page.locator('#masterStructureCreateForm [name="tipo"]').selectOption('fase');
        const [phaseResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterStructureCreateForm button').click(),
        ]);
        const phaseCreated=await phaseResponse.json();
        assert.equal(phaseResponse.status(),200,JSON.stringify(phaseCreated));
        await page.locator('.masterAddContact summary').filter({hasText:'+ Crear estructura'}).click();
        const blockCode=`UX-BLOCK-${viewport.width}-${Date.now()}`;
        await page.locator('#masterStructureCreateForm [name="codigo"]').fill(blockCode);
        await page.locator('#masterStructureCreateForm [name="nombre"]').fill('Bloque UX');
        await page.locator('#masterStructureCreateForm [name="tipo"]').selectOption('bloque');
        await page.locator('#masterStructureCreateForm [name="id_padre"]').selectOption(String(phaseCreated.entity.id_agrupacion));
        const [blockResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterStructureCreateForm button').click(),
        ]);
        const blockCreated=await blockResponse.json();
        assert.equal(blockResponse.status(),200,JSON.stringify(blockCreated));
        await page.locator('#masterManageStructure').click();
        await page.locator('#masterStructureSearch').fill(propertyCode.toLowerCase());
        const structureRows=page.locator('.masterStructureMember:not([hidden])');
        await structureRows.first().waitFor();
        assert.equal(await structureRows.count(),1);
        await structureRows.first().locator('.masterStructureCheck').check();
        await page.locator('#masterReviewStructure').click();
        await page.locator('#masterConfirmStructure').waitFor();
        const [structureConfigureResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterConfirmStructure').click(),
          page.once('dialog',dialog=>dialog.accept()),
        ]);
        assert.equal(structureConfigureResponse.status(),200,await structureConfigureResponse.text());
        await page.locator('#masterManageStructure').waitFor();
        assert.match(await page.locator('.masterGroupSummary').first().innerText(),/Propiedades directas\s+1/);
        await page.locator(`[data-master-property-link="${propertyCreated.entity.id_propiedad}"]`).click();
        await page.locator('[data-master-section="properties"].active').waitFor();
        assert.match(await page.locator('.masterStructurePath').innerText(),/Fase UX > Bloque UX/);
        await page.locator('[data-master-structure-link]').click();
        await page.locator('[data-master-section="structures"].active').waitFor();
        assert.ok(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)),'Master structure horizontal overflow');
        await page.screenshot({path:path.join(output,`${viewport.width}-master-structures.png`),fullPage:true});

        await page.locator('[data-master-section="groups"]').click();
        await page.locator('.masterAddContact summary').filter({hasText:'+ Crear grupo'}).click();
        const groupCode=`UX-GROUP-${viewport.width}-${Date.now()}`;
        await page.locator('#masterGroupForm [name="codigo"]').fill(groupCode);
        await page.locator('#masterGroupForm [name="nombre"]').fill('Jardines privados UX');
        await page.locator('#masterGroupForm [name="finalidad"]').fill('Prueba de seleccion masiva');
        const [groupCreateResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterGroupForm button.green').click(),
        ]);
        assert.equal(groupCreateResponse.status(),200,await groupCreateResponse.text());
        await page.locator('#masterManageGroup').waitFor();
        await page.locator('#masterManageGroup').click();
        const memberRows=page.locator('.masterMemberRow');
        await memberRows.first().waitFor();
        for(const [index,value] of [['0','40'],['1','60']]){
          const row=memberRows.nth(Number(index));
          await row.locator('.masterMemberCheck').check();
          await row.locator('.masterMemberValue').fill(value);
        }
        await page.locator('#masterGroupLiveSummary').getByText('100 %').waitFor();
        await page.locator('#masterReviewGroup').click();
        await page.locator('#masterConfirmGroup').waitFor();
        assert.ok(await page.locator('#masterConfirmGroup').isEnabled());
        const [groupConfigureResponse]=await Promise.all([
          page.waitForResponse(r=>r.url().endsWith('/api/erp/command')),
          page.locator('#masterConfirmGroup').click(),
          page.once('dialog',dialog=>dialog.accept()),
        ]);
        assert.equal(groupConfigureResponse.status(),200,await groupConfigureResponse.text());
        await page.locator('#masterManageGroup').waitFor();
        assert.match(await page.locator('.masterGroupSummary').first().innerText(),/100 %/);
        await page.locator('#masterManageGroup').click();
        await page.locator('#masterGroupAggregation').selectOption(String(blockCreated.entity.id_agrupacion));
        const filteredStructureRows=page.locator('.masterMemberRow:not([hidden])');
        assert.equal(await filteredStructureRows.count(),1);
        assert.match(await filteredStructureRows.first().innerText(),new RegExp(propertyCode));
        await page.locator('#masterGroupAggregation').selectOption('');
        const firstCode=await page.locator('.masterMemberRow').first().locator('strong').innerText();
        await page.locator('.masterAddContact summary').filter({hasText:'Pegar datos desde Excel'}).click();
        await page.locator('#masterGroupPaste').fill(`${firstCode}\t100\nNO-EXISTE\t5\n${firstCode}\t2`);
        await page.locator('#masterPreviewPaste').click();
        await page.locator('#masterPastePreview').getByText(/propiedad no encontrada/i).waitFor();
        await page.locator('#masterPastePreview').getByText(/codigo duplicado/i).waitFor();
        assert.ok(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)),'Master groups horizontal overflow');
        await page.screenshot({path:path.join(output,`${viewport.width}-master-groups.png`),fullPage:true});
      }
      if(view==='ai') {
        await page.locator('#aiUnifiedText').fill('quien es el propietario MARCHITO PRUEBA');
        const [lookupResponse]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/ai/center')),page.locator('#aiUnifiedSend').click()]);
        const lookup=await lookupResponse.json();
        assert.equal(lookup.intent,'consulta');
        assert.match(lookup.result.answer,/MARCHITO PRUEBA/);
        await page.locator('#aiUnifiedResult').getByText(/MARCHITO PRUEBA/).first().waitFor();
        await page.screenshot({path:path.join(output,`${viewport.width}-owner-query.png`),fullPage:true});
        const meeting={ok:true,meeting_id:'ui-meeting',status:'revision',progress:100,message:'Propuestas listas',
          communities:[{id_comunidad:1,nombre:'Comunidad de prueba'}],catalog:[],
          proposals:[0,1].map(i=>({meeting_item_id:'ui-item-'+i,revision:1,action:'crear_tarea',selected:true,entity:{type:'task',id:null},
            payload:{titulo:'Revision de instalacion '+i,comentario:'El proveedor confirma disponibilidad para revisar la instalacion.',proximo_paso:'Revisar el material una vez aprobado el presupuesto.',responsable_proximo_paso:'Administracion',estado_nuevo:'Pendiente'},
            warnings:['Responsable pendiente de confirmar: Administracion.'],source_text:'Texto sintetico de reunion.'}))};
        await page.route('**/api/ai/meetings',async route=>{
          const body=route.request().postDataJSON();
          if(body.action==='save'){
            const item=meeting.proposals.find(p=>p.meeting_item_id===body.item.meeting_item_id);
            Object.assign(item,{payload:body.item.payload,revision:item.revision+1});
          }
          if(body.action==='apply')for(const id of body.item_ids)meeting.proposals.find(p=>p.meeting_item_id===id).confirmed=true;
          await route.fulfill({status:body.action==='start'?202:200,json:meeting});
        });
        await page.locator('#aiUnifiedText').fill('Reunion de prueba con dos asuntos independientes.');
        await page.locator('#meetingAnalyze').click();
        await page.locator('[data-meeting-card="0"]').waitFor();
        await page.locator('[data-meeting-card="1"] [data-field="comment"]').fill('Edicion humana conservada al confirmar el otro asunto.');
        page.once('dialog',dialog=>dialog.accept());
        await page.locator('[data-meeting-confirm="0"]').click();
        await page.locator('#meetingReviewMessage').getByText(/Confirmacion terminada/).waitFor();
        assert.equal(await page.locator('[data-meeting-card="1"] [data-field="comment"]').inputValue(),'Edicion humana conservada al confirmar el otro asunto.');
        assert.ok(await page.locator('[data-meeting-card="0"] [data-field="comment"]').isDisabled());
        assert.ok(!await page.locator('[data-meeting-card="1"] [data-field="comment"]').isDisabled());
        assert.ok(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)),'Meeting mobile overflow');
        await page.screenshot({path:path.join(output,`${viewport.width}-meeting-review.png`),fullPage:true});
        await page.unroute('**/api/ai/meetings');
      }
      if(['tasks','projects'].includes(view)){
        await page.locator(view==='tasks'?'#newTaskButton':'#newProjectButton').click();
        await page.locator('#createName').fill(`UI ${view} ${viewport.width}`);
        await page.locator('#createDescription').fill('Reviewed operational description');
        const community=await page.locator('#createCommunity option').evaluateAll(rows=>rows.find(r=>r.textContent==='Verification A')?.value);
        await page.locator('#createCommunity').selectOption(community);
        await page.locator('#createNextStep').fill('Supplier to inspect installation');
        await page.locator('#createNextOwner').fill('External supplier');
        const [createdResponse]=await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/create')),page.locator('#saveCreateEntity').click()]);
        assert.equal(createdResponse.status(),200,JSON.stringify({response:await createdResponse.text(),input:createdResponse.request().postDataJSON()}));
        await page.locator('#entityModal').waitFor({state:'visible'});
        assert.equal(await page.locator('#commitmentList [data-resolution="Resuelta"]').count(),1);
        await page.route('**/api/ai/analyze',async route=>{
          const {target}=route.request().postDataJSON();
          await route.fulfill({json:{entity:target,source:'test-provider',draft_id:'ui-only-fixture',draft_revision:1,
            answer:'Propuesta de seguimiento revisable.',warnings:['Responsable no identificado: Administracion.'],
            payload:{tipo_registro:'Seguimiento',comentario:'El proveedor confirma disponibilidad fuera del horario habitual.',
              estado_nuevo:'Pendiente',prioridad_nueva:'Media',responsable_nuevo:'SuperUsuario',responsable_proximo_paso:'Administracion',
              proximo_paso:'Revisar el material una vez aprobado el presupuesto.',fecha_objetivo_proximo_paso:'',motivo_bloqueo:''}}});
        });
        await page.locator('#quickRecordText').fill('El proveedor puede venir fuera de horario. Si aprobamos presupuesto revisamos el material.');
        await page.locator('#recordNextDate').fill('2026-12-31');
        await page.locator('#quickRecordAnalyze').click();
        await page.locator('#quickRecordMessage').getByText('Responsable no identificado: Administracion.').waitFor();
        assert.equal(await page.locator('#recordNextDate').inputValue(),'');
        assert.equal(await page.locator('#recordNextOwner').inputValue(),'Administracion');
        assert.match(await page.locator('#recordNextStep').inputValue(),/una vez aprobado/);
        await page.locator('#quickRecordBox').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(output,`${viewport.width}-${view}-ai-followup.png`)});
        assert.ok(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2)));
        await page.locator('#quickRecordClear').click();
        await page.unroute('**/api/ai/analyze');
        await page.locator('#recordNextStep').fill('');
        await page.locator('#recordComment').fill('Additional information without a new commitment.');
        await page.locator('#recordNextOwner').fill('Administration');
        page.once('dialog',dialog=>dialog.accept());
        await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/detail') && r.status()===200),page.locator('#saveRecord').click()]);
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#commitmentList [data-resolution="Resuelta"]').count(),1);
        assert.equal(await page.locator('#recordNextStep').inputValue(),'');
        await page.locator('#commitmentSection').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(output,`${viewport.width}-${view}-commitments.png`),fullPage:true});
        page.once('dialog',dialog=>dialog.accept('Inspection completed and checked.'));
        await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/detail') && r.status()===200),page.locator('#commitmentList [data-resolution="Resuelta"]').click()]);
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#commitmentList [data-resolution="Resuelta"]').count(),0);
        await page.locator('#newPresidentRequest').click();
        await page.locator('#requestQuestion').fill('Approve the inspection estimate');
        await page.locator('#requestContext').fill('Please review the proposal and confirm whether we should proceed.');
        await page.locator('#requestDue').fill('2026-10-15');
        page.once('dialog',dialog=>dialog.accept());
        await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/detail') && r.status()===200),page.locator('#sendPresidentRequest').click()]);
        await page.locator('#requestList [data-request-open]').waitFor();
        await page.locator('#requestList [data-request-open]').click();
        await page.locator('#presidentDecisionModal').waitFor({state:'visible'});
        assert.ok((await page.locator('#presidentDecisionContext').innerText()).includes('Verification President A'));
        assert.equal(await page.locator('#presidentApprove').isVisible(),false);
        await page.screenshot({path:path.join(output,`${viewport.width}-${view}-request.png`)});
        if(view==='projects'){
          const rid=await page.locator('#requestList [data-request-open]').getAttribute('data-request-open');
          await page.locator('#closePresidentDecision').click();
          const pc=await browser.newContext({viewport});
          const pp=await pc.newPage();
          await pp.goto(base);
          await pp.locator('#loginUser option').first().waitFor({state:'attached'});
          await pp.locator('#loginUser').selectOption({label:'Verification President A'});
          await pp.locator('#loginPassword').fill('Only-local-fixture-629');
          await pp.locator('#loginButton').click();
          await pp.locator('#appView').waitFor({state:'visible'});
          await pp.locator(`[data-work-action="president"][data-request-id="${rid}"]`).first().click();
          await pp.locator('#presidentDecisionComment').fill('Please confirm whether VAT is included.');
          await pp.screenshot({path:path.join(output,`${viewport.width}-president-respond.png`)});
          pp.once('dialog',dialog=>dialog.accept());
          await Promise.all([pp.waitForResponse(r=>r.url().includes('/api/president/respond') && r.status()===200),pp.locator('#presidentClarify').click()]);
          await page.locator('#requestList [data-request-open]').click();
          await page.locator('#requestReply').waitFor({state:'visible'});
          await page.locator('#presidentDecisionComment').fill('VAT is included in the estimate.');
          page.once('dialog',dialog=>dialog.accept());
          await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/detail') && r.status()===200),page.locator('#requestReply').click()]);
          await pp.reload();
          await pp.locator(`[data-work-action="president"][data-request-id="${rid}"]`).first().click();
          await pp.locator('#presidentDecisionComment').fill('Approved on this basis.');
          pp.once('dialog',dialog=>dialog.accept());
          await Promise.all([pp.waitForResponse(r=>r.url().includes('/api/president/respond') && r.status()===200),pp.locator('#presidentApprove').click()]);
          await page.locator('#requestList [data-request-open]').click();
          await page.locator('#requestManage').waitFor({state:'visible'});
          assert.ok((await page.locator('#presidentDecisionContext').innerText()).includes('VAT is included'));
          await page.locator('#presidentDecisionComment').fill('Approval communicated to the supplier.');
          await page.screenshot({path:path.join(output,`${viewport.width}-request-manage.png`)});
          page.once('dialog',dialog=>dialog.accept());
          await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/detail') && r.status()===200),page.locator('#requestManage').click()]);
          await pc.close();
        } else {
          await page.locator('#presidentDecisionComment').fill('Withdrawn after review.');
          page.once('dialog',dialog=>dialog.accept());
          await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/detail') && r.status()===200),page.locator('#requestCancel').click()]);
        }
        await page.waitForTimeout(300);
        assert.ok((await page.locator('#requestList').innerText()).includes(view==='projects'?'Gestionada':'Cancelada'));
        await page.locator('#attachmentFiles').setInputFiles({name:'presupuesto-prueba.txt',mimeType:'text/plain',buffer:Buffer.from('Presupuesto de prueba, sin efectos reales.')});
        await page.locator('#attachmentCategory').selectOption('Presupuesto');
        await Promise.all([page.waitForResponse(r=>r.url().includes('/api/entity/detail') && r.status()===200),page.locator('#uploadAttachmentsButton').click()]);
        await page.locator('#attachmentFilter').selectOption('Presupuesto');
        assert.equal(await page.locator('#attachmentsList .attachmentCard').count(),1);
        await page.locator('#attachmentSearch').fill('no-existe');
        assert.equal(await page.locator('#attachmentsList .attachmentCard').count(),0);
        await page.locator('#attachmentSearch').fill('presupuesto');
        await page.locator('#attachmentsList').scrollIntoViewIfNeeded();
        await page.screenshot({path:path.join(output,`${viewport.width}-${view}-documents.png`)});
        await page.locator('#generateReportButton').click();
        await page.locator('#reportConfirm:enabled').waitFor();
        await page.locator('#reportMode').selectOption('ejecutivo');
        assert.equal(await page.locator('#reportConfiguration [data-annex-id]').count(),1);
        await page.locator('#annexNone').click();
        assert.equal(await page.locator('#reportConfiguration [data-annex-id]:checked').count(),0);
        await page.screenshot({path:path.join(output,`${viewport.width}-${view}-report-options.png`)});
        await page.locator('#reportConfirm').click();
        await page.locator('#reportConfigurationStatus a').waitFor();
        const wordUrl=await page.locator('#reportConfigurationStatus a').getAttribute('href');
        const word=await context.request.get(base+wordUrl);
        assert.equal(word.status(),200);
        assert.equal((await word.body()).subarray(0,2).toString(),'PK');
        await page.locator('#reportConfiguration [aria-label="Cerrar"]').click();
        await page.locator('#entityReportsList').getByText(/ejecutivo/).first().waitFor();
        await page.locator('#closeModal').click();
      }
    }
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log(JSON.stringify({ok:true,viewports:2,views:5,screenshots:output},null,2));
}finally{
  await browser?.close();
  child.kill();
  await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
}
