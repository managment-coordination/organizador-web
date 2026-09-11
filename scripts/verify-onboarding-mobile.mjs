import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from '../server/node_modules/exceljs/excel.js';

const root=path.resolve(import.meta.dirname,'..');
const database=process.env.UI_FIXTURE_DB;
assert.ok(database && path.basename(path.dirname(database)).startsWith('organizador-release-'));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output=fs.mkdtempSync(path.join(os.tmpdir(),'onboarding-mobile-'));
const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const child=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,env:{...process.env,
  HOST:'127.0.0.1',PORT:String(port),DATABASE_PATH:database,DATA_DIR:path.join(output,'files'),AI_PROVIDER:'local',
},stdio:['ignore','pipe','pipe']});
let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
let browser;
try {
  for(let i=0;i<50 && !/http:\/\/127.0.0.1:\d+/.test(log);i++)await delay(200);
  const base=log.match(/http:\/\/127.0.0.1:\d+/)?.[0];assert.ok(base,log);
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const width of [390,360,1440]) {
    const context=await browser.newContext({viewport:{width,height:844}});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);
    await page.locator('#loginUser').selectOption({label:'SuperUsuario'});
    await page.locator('#loginPassword').fill('Only-local-fixture-629');
    await page.locator('#loginButton').click();await page.locator('#appView').waitFor({state:'visible'});
    await page.locator('#masterDataTab').evaluate(el=>el.click());
    await page.locator('[data-master-section="setup"]').click();
    await page.locator('#masterOnboardingUpload').waitFor();
    const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('Hoja1');
    sheet.addRow(['PROPIEDAD','PROPIETARIO','COEFICIENTE']);
    for(let i=1;i<=40;i++)sheet.addRow(['V-'+i,'Persona de prueba '+i,'2,5']);
    const buffer=Buffer.from(await workbook.xlsx.writeBuffer());
    await page.locator('#masterOnboardingFile').setInputFiles({name:'exportacion.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
    const [response]=await Promise.all([page.waitForResponse(r=>r.url().includes('/onboarding/upload')),page.locator('#masterOnboardingUpload').click()]);
    assert.equal(response.status(),200,await response.text());
    await page.getByRole('heading',{name:'Relacionar columnas'}).waitFor();
    assert.equal(await page.locator('.masterOnboardingMap').count(),3);
    await page.screenshot({path:path.join(output,`${width}-analysis.png`),fullPage:true});
    const bounds=await page.locator('.masterShell,.masterPane,.onboardingMap').evaluateAll(nodes=>nodes.map(n=>({class:n.className,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,width:n.getBoundingClientRect().width})));
    assert.ok(bounds.every(b=>b.left>=-1 && b.right<=width+1),'Clipped content, even if body hides horizontal overflow');
    assert.match(await page.locator('#masterOnboardingResult').innerText(),/Persona de prueba 1/);
    await page.locator('#masterOnboardingAsProperties').click();
    await page.locator('[data-onboarding-kind="propiedades"].active').waitFor();
    await page.locator('.masterOnboardingMap').first().waitFor();
    assert.equal(await page.locator('.masterOnboardingMap').first().inputValue(),'codigo_propiedad');
    // A name must not silently become an owner code. Missing mappings remain explicit.
    assert.equal(await page.locator('.masterOnboardingMap').nth(1).inputValue(),'');
    await page.locator('.masterOnboardingMap').nth(2).selectOption('descripcion');
    await page.locator('#masterOnboardingPreview').click();
    await page.locator('#masterOnboardingMessage[role="alert"]').waitFor();
    assert.match(await page.locator('#masterOnboardingMessage').innerText(),/Codigo de propietario/);
    assert.equal(await page.locator('.masterOnboardingMap').nth(2).inputValue(),'descripcion');
    assert.equal(await page.locator('#masterOnboardingConfirm').count(),0);
    assert.ok(await page.locator('#masterOnboardingFile').evaluate(el=>el.files.length===1));
    // Errors are visible and retryable, not an empty result or an indefinitely busy button.
    await page.route('**/api/erp/onboarding/upload?*',route=>route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'No autenticado.'})}));
    await page.locator('#masterOnboardingUpload').click();
    await page.locator('#masterOnboardingMessage[role="alert"]').waitFor();
    assert.match(await page.locator('#masterOnboardingMessage').innerText(),/Sesion caducada/);
    assert.equal(await page.locator('#masterOnboardingResult').count(),0);
    assert.ok(await page.locator('#masterOnboardingUpload').isEnabled());
    await page.unroute('**/api/erp/onboarding/upload?*');
    await page.locator('#masterOnboardingFile').setInputFiles({name:'exportacion.xls',mimeType:'application/vnd.ms-excel',buffer:Buffer.from('unsupported')});
    await page.locator('#masterOnboardingUpload').click();
    assert.match(await page.locator('#masterOnboardingMessage').innerText(),/Guarda una copia/);
    await page.locator('#masterOnboardingFile').setInputFiles({name:'exportacion.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
    await page.locator('#masterOnboardingUpload').click();
    await page.locator('#masterOnboardingResult').waitFor();
    if(width===390 && process.env.VERIFY_UPLOAD_FILE){
      const sourceFile=process.env.VERIFY_UPLOAD_FILE;
      const community=await page.locator('#masterCommunity').inputValue();
      const uploaded=await context.request.post(base+'/api/erp/onboarding/upload?id_comunidad='+community+'&tipo=propiedades',{
        headers:{'x-file-name':encodeURIComponent(path.basename(sourceFile)),'content-type':'application/octet-stream'},data:fs.readFileSync(sourceFile),
      });
      assert.equal(uploaded.status(),200);const parsed=await uploaded.json();
      assert.ok(parsed.headers.length && parsed.row_count);
      console.log(JSON.stringify({actualFileParsed:true,columns:parsed.headers.length,rows:parsed.row_count,importConfirmed:false}));
    }
    if(await page.locator('#masterCommunity option').count()>1){
      await page.locator('#masterCommunity').selectOption({index:1});
      await page.locator('#masterOnboardingUpload').waitFor();
      assert.equal(await page.locator('#masterOnboardingResult').count(),0);
      assert.ok(await page.locator('#masterOnboardingFile').evaluate(el=>el.files.length===0));
    }
    console.log(JSON.stringify({width,columns:3,rows:40,contained:true,mappingRetained:true,errorsVisible:true}));
    assert.deepEqual(errors,[]);
    await context.close();
  }
  console.log(JSON.stringify({ok:true,screenshots:output}));
}finally {
  await browser?.close();child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
}
