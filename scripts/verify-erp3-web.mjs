import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.resolve(import.meta.dirname,'..');
const source=process.env.UI_FIXTURE_DB;
assert.ok(source&&path.basename(path.dirname(source)).startsWith('organizador-release-'),'Use an isolated release fixture.');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'organizador-erp3-web-'));
const db=path.join(output,'test.db');
const python=process.env.PYTHON_BIN||'python3';
const seed=spawnSync(python,['-',source,db],{encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(root,'server')},input:`
import sqlite3,sys,json
from access_control import migrate,profile
from erp_core.database import connect
src=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);dst=sqlite3.connect(sys.argv[2]);src.backup(dst);src.close();dst.close()
c=connect(sys.argv[2]);migrate(c)
user=c.execute("SELECT id_usuario,nombre FROM usuarios WHERE rol='Superusuario' AND activo=1 ORDER BY id_usuario LIMIT 1").fetchone()
pid,community,code=c.execute('SELECT id_propiedad,id_comunidad,codigo_propiedad FROM cf_propiedades ORDER BY id_propiedad LIMIT 1').fetchone()
owner=c.execute('SELECT id_propietario,nombre FROM cf_propietarios WHERE id_comunidad=? LIMIT 1',(community,)).fetchone()
exercise=c.execute("INSERT INTO erp_ejercicios(id_comunidad,codigo,fecha_inicio,fecha_fin,estado,creado_en,creado_por,origen) VALUES (?,'WEB-ERP3','2026-01-01','2026-12-31','abierto','2026-01-01',?,'test')",(community,user[0])).lastrowid
rid=c.execute("""INSERT INTO erp_recibos(id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id) VALUES (?,?,?,'WEB-ERP3-001','test','Cuota sintetica de prueba','P01','2026-01-01','2026-01-31','plan','WEB-ERP3','WEB-ERP3',10000,'EUR','2026-01-01','2026-01-10','{}','test','2026-01-01T00:00:00.000000Z',?)""",(community,pid,exercise,user[0])).lastrowid
for role in ['obligated','recipient','payer']:
 c.execute('INSERT INTO erp_recibo_sujetos(id_comunidad,receipt_id,role,owner_id,snapshot_json) VALUES (?,?,?,?,?)',(community,rid,role,owner[0],json.dumps({'type':'owner','id':owner[0],'name':owner[1]})))
print(json.dumps({'community':community,'property':pid,'code':code,'owner':owner[0],'user':user[1],'receipt':rid}))
c.close()
`});
assert.equal(seed.status,0,seed.stderr);const fixture=JSON.parse(seed.stdout.trim());
const pw=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const {chromium}=pw.default||pw;
const sock=net.createServer();await new Promise(r=>sock.listen(0,'127.0.0.1',r));const port=sock.address().port;await new Promise(r=>sock.close(r));
const server=spawn(process.execPath,[path.join(root,'server/index.js')],{cwd:root,env:{...process.env,DATABASE_PATH:db,DATA_DIR:path.join(output,'files'),HOST:'127.0.0.1',PORT:String(port),AI_PROVIDER:'local'},stdio:['ignore','pipe','pipe']});
let log='';server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d);
let browser;
try {
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<70;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}if(server.exitCode!==null)throw new Error(log);await delay(200);}
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  for(const width of [1440,390,360]) {
    const context=await browser.newContext({viewport:{width,height:900}});const page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('#loginUser option').first().waitFor({state:'attached'});
    await page.locator('#loginUser').selectOption({label:fixture.user});await page.locator('#loginPassword').fill('Only-local-fixture-629');await page.locator('#loginButton').click();
    await page.locator('#appView').waitFor({state:'visible'});
    await page.locator('[data-workspace-area=management]').click();
    if(width<700){await page.locator('#mobileMenuToggle').click();await page.locator('[data-mobile-view=receivables]').click();}
    else await page.locator('#receivablesTab').click();
    await page.locator('.finWorkspace [name=community]').selectOption(String(fixture.community));
    await page.getByRole('button',{name:'Preparar emision',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    assert.equal(await page.locator('.finWarning[role=alert]').count(),0,await page.locator('#cards').innerText());
    await page.screenshot({path:path.join(output,`${width}-receipts.png`),fullPage:true});
    await page.getByRole('button',{name:'Registrar cobro',exact:true}).click();
    await page.locator('[name=amount]').fill('120,00');await page.locator('[name=reference]').fill('WEB-COLLECTION-'+width);
    await page.locator('[name=payer]').selectOption('owner:'+fixture.owner);
    await page.locator('[name=reason]').fill('Verificacion de cobro sintetico');
    await page.locator('[data-fin-form=operation]').getByRole('button',{name:'Revisar',exact:true}).click();
    await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
    await page.getByRole('status').filter({hasText:'Operacion confirmada'}).waitFor();
    await page.getByRole('button',{name:'Cobros y saldos',exact:true}).click();
    await page.getByRole('row').filter({hasText:'WEB-COLLECTION-'+width}).getByRole('button',{name:'Abrir'}).click();
    await page.getByRole('button',{name:'Imputar a recibos'}).click();
    await page.locator('[name=receipt]').selectOption(String(fixture.receipt));await page.locator('[name=amount]').fill('10,00');
    await page.locator('[name=reason]').fill('Aplicacion parcial revisada');await page.locator('[data-fin-form=operation]').getByRole('button',{name:'Revisar',exact:true}).click();
    await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
    await page.getByRole('button',{name:'Registrar cobro',exact:true}).waitFor();
    await page.getByRole('row').filter({hasText:'WEB-COLLECTION-'+width}).getByRole('button',{name:'Abrir'}).click();
    await page.getByRole('button',{name:'Registrar devolucion',exact:true}).click();
    await page.locator('[name^=reversal_]').first().fill('2,00');
    await page.locator('[name=reference]').fill('WEB-RETURN-'+width);
    await page.locator('[name=reason]').fill('Devolucion parcial sintetica');
    await page.locator('[data-fin-form=operation]').getByRole('button',{name:'Revisar',exact:true}).click();
    await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
    await page.getByRole('button',{name:'Ajustes y gastos',exact:true}).click();
    await page.getByRole('row').filter({hasText:'WEB-RETURN-'+width}).getByRole('button',{name:'Rectificar devolucion'}).click();
    await page.locator('[name=reason]').fill('Rectificacion documentada sin reimputacion automatica');
    await page.locator('[name=evidence]').fill('JUSTIFICANTE-WEB-'+width);
    await page.locator('[data-fin-form=operation]').getByRole('button',{name:'Revisar',exact:true}).click();
    await page.getByText('Los fondos quedan libres. No se imputan automaticamente.',{exact:true}).waitFor();
    await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
    await page.getByRole('row').filter({hasText:'WEB-RETURN-'+width}).getByText('Revertida',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Deuda e historico',exact:true}).click();
    await page.screenshot({path:path.join(output,`${width}-debt.png`),fullPage:true});
    for(const section of ['Importacion historica','Configuracion']) {
      await page.getByRole('button',{name:section,exact:true}).click();
      if(section==='Importacion historica') {
        const ExcelJS=(await import(pathToFileURL(path.join(root,'server/node_modules/exceljs/excel.js')).href)).default;
        const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('Saldos');
        sheet.addRow(['Referencia','Propiedad','Saldo']);sheet.addRow(['SALDO-WEB-'+width,fixture.code,'53,00']);
        const buffer=Buffer.from(await workbook.xlsx.writeBuffer());
        await page.locator('[name=file]').setInputFiles({name:'saldos-'+width+'.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
        await page.getByRole('button',{name:'Analizar columnas',exact:true}).click();
        await page.locator('[name=source]').fill('Prueba web');
        await page.locator('[name=cutoff_date]').fill('2020-12-31');await page.locator('[name=coverage_from]').fill('2020-01-01');await page.locator('[name=coverage_until]').fill('2020-12-31');
        await page.locator('[name=scope]').selectOption('receipt');
        await page.locator('[name=map_0]').selectOption('reference');await page.locator('[name=map_1]').selectOption('property_code');await page.locator('[name=map_2]').selectOption('amount');
        await page.getByRole('button',{name:'Revisar importacion',exact:true}).click();
        await page.locator('#finImportAck').check();await page.getByRole('button',{name:'Confirmar importacion',exact:true}).click();
        await page.getByText('Importacion ya confirmada.',{exact:true}).waitFor();
        const before=await context.request.get(base+'/api/erp/query?'+new URLSearchParams({query:'erp3.debt.summary',id_comunidad:String(fixture.community),filters:'{}'}));
        assert.equal(before.status(),200);assert.equal((await before.json()).entity.openings.filter(o=>o.source.normalized.reference==='SALDO-WEB-'+width).length,1);
        await page.getByRole('button',{name:'Revisar importacion',exact:true}).click();
        await page.getByText('Importacion ya confirmada.',{exact:true}).waitFor();
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'Global overflow');
      const clipped=await page.locator('.finWorkspace,.workspaceContent').evaluateAll(ns=>ns.filter(n=>n.getClientRects().length).some(n=>n.getBoundingClientRect().right>innerWidth+1||n.getBoundingClientRect().left< -1));
      assert.equal(clipped,false,'Clipped finance surface');
      await page.screenshot({path:path.join(output,`${width}-${section==='Configuracion'?'settings':'import'}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);await context.close();
  }
  console.log(JSON.stringify({ok:true,output,checks:['1440/390/360 navigation','collection review and confirmation','partial allocation','return and explicit reversal without automatic reallocation','Excel upload/mapping/preview/confirmation/reimport','debt coverage warnings','no JS errors or global overflow']},null,2));
} finally {
  if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));
  fs.writeFileSync(path.join(output,'server.log'),log);
}
