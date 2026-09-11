import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.resolve(import.meta.dirname,'..'), database=process.env.UI_FIXTURE_DB;
assert.ok(database&&fs.existsSync(database)&&path.basename(path.dirname(database)).startsWith('organizador-release-'),'Isolated release fixture required');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output=fs.mkdtempSync(path.join(os.tmpdir(),'navigation-structure-'));
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const child=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,DATABASE_PATH:database,DATA_DIR:path.join(path.dirname(database),'files'),PORT:String(port),HOST:'127.0.0.1',AI_PROVIDER:'local',NVIDIA_API_KEY:'',OPENAI_API_KEY:'',AI_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='',browser;child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
try{
  for(let i=0;i<100&&!log.match(/http:\/\/127.0.0.1:\d+/);i++)await delay(200);
  const base=log.match(/http:\/\/127.0.0.1:\d+/)?.[0];assert.ok(base,log);
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const width of [390,360,1920]){
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('#loginUser').selectOption({label:'SuperUsuario'});
    await page.locator('#loginPassword').fill('Only-local-fixture-629');await page.locator('#loginButton').click();await page.locator('#appView').waitFor();
    const views=await page.locator('.tabs .tab:not(.hidden)').evaluateAll(ns=>ns.map(n=>n.dataset.view));
    assert.equal(await page.locator('.tabs .tab').count(),17);
    assert.ok(views.includes('master-data')&&views.includes('budgets')&&views.includes('assemblies'));
    for(const view of views){
      const mobile=width<700;
      const area=await page.locator(`.tabs [data-view="${view}"]`).evaluate(n=>n.closest('[data-nav-area]').dataset.navArea);
      if(area!=='global')await page.locator(`[data-workspace-area="${area}"]`).click();
      if(mobile)await page.locator('#mobileMenuToggle').click();
      const target=page.locator(mobile?`#mobileDrawerNav [data-mobile-view="${view}"]`:`.tabs [data-view="${view}"]`);
      for(const group of await target.locator('xpath=ancestor::details').all())if(!await group.evaluate(n=>n.open))await group.locator(':scope > summary').click();
      await target.click();await page.waitForTimeout(350);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('#appView').getAttribute('data-view'),view);
      assert.ok(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),`Overflow ${view}/${width}`);
      if(view==='master-data')assert.match(await page.locator('#navigationTrail').innerText(),/Gestion/);
      await page.screenshot({path:path.join(output,`${width}-${view}.png`)});
    }
    await page.locator('#homeTab').evaluate(n=>n.click());
    await page.locator('[data-home-view="map"]').click();
    assert.equal(await page.locator('#appView').getAttribute('data-view'),'map');
    const open=page.locator('[data-daily-action="open"]').first();
    if(await open.count()){
      for(const group of await open.locator('xpath=ancestor::details').all())if(!await group.evaluate(n=>n.open))await group.locator(':scope > summary').click();
      await open.locator('xpath=ancestor::*[@data-map-key]').click();
      await open.click();await page.locator('#entityModal').waitFor();await page.keyboard.press('Escape');
    }
    // Explicitly close the existing modal through its own close control if Escape is not supported.
    if(await page.locator('#entityModal').isVisible())await page.locator('#closeModal').click();
    await page.evaluate(()=>window.scrollTo(0,0));
    if(width<700){
      await page.locator('#mobileMenuToggle').click();
      await page.waitForFunction(()=>Math.abs(document.querySelector('#mobileDrawer').getBoundingClientRect().left)<1);
      const bounds=await page.locator('#mobileDrawer').boundingBox();assert.ok(bounds.x>=-1&&bounds.x+bounds.width<=width+1);
    }
    await page.screenshot({path:path.join(output,`${width}-navigation.png`)});
    assert.deepEqual(errors,[]);console.log(JSON.stringify({width,views:views.length,contextualMap:true,errors:0}));
    await context.close();
  }
  for(const name of ['Verification President A','Verification Read','Verification Security A']){
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
    await page.goto(base);await page.locator('#loginUser').selectOption({label:name});
    await page.locator('#loginPassword').fill('Only-local-fixture-629');await page.locator('#loginButton').click();await page.locator('#appView').waitFor();
    if(name.includes('Security')){assert.ok(await page.locator('#mobileMenuToggle').isDisabled());}
    else{
      await page.locator('#mobileMenuToggle').click();
      assert.equal(await page.locator('#mobileDrawerNav [data-mobile-view="admin"]').count(),0);
      if(name.includes('President')){
        assert.equal(await page.locator('#mobileDrawerNav [data-mobile-view="reports"]').count(),0);
        assert.equal(await page.locator('#mobileDrawerNav [data-nav-group="management"]').count(),0);
      }
      if(name.includes('Read'))assert.equal(await page.locator('#mobileDrawerNav [data-mobile-view="master-data"]').count(),0);
    }
    console.log(JSON.stringify({role:name,visibility:true}));await context.close();
  }
  console.log(JSON.stringify({ok:true,screenshots:output}));
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));}
