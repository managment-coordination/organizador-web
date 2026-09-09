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
    await page.locator('#loginButton').click();
    await page.locator('#appView').waitFor({state:'visible'});
    for(const view of ['home','tasks','projects','admin','ai']){
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
      if(['tasks','projects'].includes(view)){
        await page.locator(view==='tasks'?'#newTaskButton':'#newProjectButton').click();
        await page.locator('#createName').fill(`UI ${view} ${viewport.width}`);
        await page.locator('#createDescription').fill('Reviewed operational description');
        const community=await page.locator('#createCommunity option').evaluateAll(rows=>rows.find(r=>r.textContent==='Verification A')?.value);
        await page.locator('#createCommunity').selectOption(community);
        await page.locator('#createNextStep').fill('Supplier to inspect installation');
        await page.locator('#createNextOwner').fill('External supplier');
        await page.locator('#saveCreateEntity').click();
        await page.locator('#entityModal').waitFor({state:'visible'});
        assert.equal(await page.locator('#commitmentList [data-resolution="Resuelta"]').count(),1);
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
