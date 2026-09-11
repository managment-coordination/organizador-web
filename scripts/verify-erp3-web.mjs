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
assert.ok(source&&['organizador-release-','organizador-erp2-complete-'].some(prefix=>path.basename(path.dirname(source)).startsWith(prefix)),'Use an isolated release/ERP2 fixture with its synthetic login.');
const output=fs.mkdtempSync(path.join(os.tmpdir(),'organizador-erp3-web-'));
const db=path.join(output,'test.db');
const python=process.env.PYTHON_BIN||'python3';
const seed=spawnSync(python,['-',source,db],{encoding:'utf8',env:{...process.env,PYTHONPATH:path.join(root,'server')},input:`
import sqlite3,sys,json,hashlib
from access_control import migrate,profile
from erp_core.database import connect
from erp_core.dispatcher import execute_command
src=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);dst=sqlite3.connect(sys.argv[2]);src.backup(dst);src.close();dst.close()
c=connect(sys.argv[2]);migrate(c)
user=c.execute("SELECT id_usuario,nombre FROM usuarios WHERE rol='Superusuario' AND activo=1 ORDER BY id_usuario LIMIT 1").fetchone()
salt='erp3-web-fixture';digest=hashlib.pbkdf2_hmac('sha256',b'Only-local-fixture-629',salt.encode(),260000).hex()
c.execute("UPDATE usuarios SET password_hash=?,password_configurada=1,requiere_cambio_password=0,bloqueado=0 WHERE id_usuario=?",('pbkdf2_sha256$260000$'+salt+'$'+digest,user[0]))
pid,community,code=c.execute('SELECT id_propiedad,id_comunidad,codigo_propiedad FROM cf_propiedades ORDER BY id_propiedad LIMIT 1').fetchone()
owner=c.execute('SELECT id_propietario,nombre FROM cf_propietarios WHERE id_comunidad=? LIMIT 1',(community,)).fetchone()
exercise=c.execute("INSERT INTO erp_ejercicios(id_comunidad,codigo,fecha_inicio,fecha_fin,estado,creado_en,creado_por,origen) VALUES (?,'WEB-ERP3','2026-01-01','2026-12-31','abierto','2026-01-01',?,'test')",(community,user[0])).lastrowid
rid=c.execute("""INSERT INTO erp_recibos(id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id) VALUES (?,?,?,'WEB-ERP3-001','test','Cuota sintetica de prueba','P01','2026-01-01','2026-01-31','plan','WEB-ERP3','WEB-ERP3',10000,'EUR','2026-01-01','2026-01-10','{}','test','2026-01-01T00:00:00.000000Z',?)""",(community,pid,exercise,user[0])).lastrowid
for role in ['obligated','recipient','payer']:
 c.execute('INSERT INTO erp_recibo_sujetos(id_comunidad,receipt_id,role,owner_id,snapshot_json) VALUES (?,?,?,?,?)',(community,rid,role,owner[0],json.dumps({'type':'owner','id':owner[0],'name':owner[1]})))
for i in range(60):
 c.execute("""INSERT INTO erp_recibos(id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id) VALUES (?,?,?,?,'test','Recibo sintetico paginado','P01','2026-01-01','2026-01-31','plan',?,?,10000,'EUR','2026-01-01','2026-01-10','{}','test','2026-01-01T00:00:00.000000Z',?)""",(community,pid,exercise,'PAGED-'+str(i),'PAGED-'+str(i),'PAGED-'+str(i),user[0]))
activations={};n=0
def command(name,payload,version=None):
 global n
 n+=1
 return execute_command(sys.argv[2],profile(c,user[0]),{'command':'erp3.'+name,'id_comunidad':community,'payload':payload,'expected_version':version,'idempotency_key':'web-seed-'+str(n),'origin':'test','reason':'Preparacion sintetica','evidence':{'type':'external_reference','id':'SYNTHETIC'}})['entity']
for width,month in [(1440,'01'),(390,'03'),(360,'05')]:
 start='2030-'+month+'-01';end='2030-'+month+'-31'
 old=c.execute("INSERT INTO cf_recibos(referencia,fecha_emision,id_propiedad,id_comunidad,importe,cobrado,deuda) VALUES (?,?,?,?,100,25,75)",('HIST-'+str(width),start,pid,community)).lastrowid
 draft=command('history.import.preview',{'source':'web-activation','file_hash':str(width).zfill(64),'file_name':'synthetic.csv','rows':[{'reference':'ACT-'+str(width),'amount_cents':'7500','cutoff_date':end,'coverage_from':start,'coverage_until':end,'scope':'receipt','property_id':pid,'legacy_receipt_ids':[old],'limitations':'Saldo observado sintetico'}]})
 command('history.import.confirm',{'import_id':draft['id']},draft['version'])
 coverage=command('coverage.confirm',{'concept_key':'ordinario','effective_from':start,'effective_until':end,'authority':'legacy_observed'})
 activations[str(width)]={'coverage':coverage['id'],'start':start,'end':end}
integral=None
if c.execute("SELECT 1 FROM comunidades WHERE nombre='ERP2 Integral'").fetchone():
 original_community=community
 community=c.execute("SELECT id_comunidad FROM comunidades WHERE nombre='ERP2 Integral'").fetchone()[0]
 integral_owner=c.execute("SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? AND nombre='Titular ERP2'",(community,)).fetchone()[0]
 command('coverage.confirm',{'concept_key':'ordinario','effective_from':'2027-01-01','effective_until':'2027-12-31','authority':'erp3'})
 for item in c.execute('SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=?',(community,)).fetchall():
  command('responsibility.confirm',{'property_id':item[0],'effective_from':'2027-01-01','subjects':[{'type':'owner','id':integral_owner}]},0)
 plan=c.execute("SELECT v.id_plan_version FROM erp_plan_versiones v JOIN erp_planes_cuota p ON p.id_plan=v.id_plan AND p.id_comunidad=v.id_comunidad WHERE p.id_comunidad=? AND p.tipo='ordinario' AND p.estado='aprobado' LIMIT 1",(community,)).fetchone()[0]
 integral={'community':community,'plan':plan}
 community=original_community
print(json.dumps({'community':community,'property':pid,'code':code,'owner':owner[0],'user':user[1],'receipt':rid,'activations':activations,'integral':integral}))
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
    await page.locator('#appView:visible, #communityScopeModal:visible').first().waitFor().catch(async error=>{await page.screenshot({path:path.join(output,'login-failure.png'),fullPage:true});throw new Error(error.message+'; Login: '+await page.locator('#loginMessage').innerText()+'; JS: '+JSON.stringify(errors)+'; server: '+log);});
    if(await page.locator('#communityScopeModal').isVisible())await page.locator('#confirmCommunityScope').click();
    await page.locator('#appView').waitFor({state:'visible'});
    assert.ok((await context.cookies()).every(cookie=>cookie.value.length<3800),'Session cookie must fit browser limits');
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
    await page.locator('[name=receipt_0]').fill('WEB-ERP3-001');await page.locator('[name=amount_0]').fill('10,00');
    await page.getByRole('button',{name:'Anadir recibo',exact:true}).click();
    await page.locator('[name=receipt_1]').fill('PAGED-59');await page.locator('[name=amount_1]').fill('1,00');
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
    await page.locator('.finWorkspace summary').filter({hasText:'Exportar'}).click();
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Excel',exact:true}).click();
    const download=await downloading;assert.ok(download.suggestedFilename().endsWith('.xlsx'));await download.saveAs(path.join(output,`${width}-statement.xlsx`));
    await page.screenshot({path:path.join(output,`${width}-debt.png`),fullPage:true});
    for(const section of ['Importacion historica','Configuracion']) {
      await page.getByRole('button',{name:section,exact:true}).click();
      if(section==='Configuracion') {
        const a=fixture.activations[String(width)];
        await page.getByText('Fuente de emision y corte de puesta en marcha',{exact:true}).click();
        await page.locator(`[data-fin-action=activate-coverage][data-id="${a.coverage}"]`).click();
        await page.locator('[name=from_0]').fill(a.start);await page.locator('[name=until_0]').fill(a.end);
        await page.locator('[name=reason]').fill('Revision expresa de correspondencia de recibo y saldo');
        await page.locator('[name=evidence]').fill('SYNTHETIC-COVERAGE-'+width);
        await page.getByRole('button',{name:'Revisar',exact:true}).click();
        await page.getByText('No se crean cobros ni se vuelven a emitir recibos. La calidad de las fuentes historicas se conserva.',{exact:true}).waitFor();
        await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
        await page.getByText('Fuente de emision y corte de puesta en marcha',{exact:true}).click();
        await page.getByRole('row').filter({hasText:a.start}).getByText('Historico revisado',{exact:true}).waitFor();
      }
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
  if(fixture.integral) {
    const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
    await page.goto(base);await page.locator('#loginUser option').first().waitFor({state:'attached'});
    await page.locator('#loginUser').selectOption({label:fixture.user});await page.locator('#loginPassword').fill('Only-local-fixture-629');await page.locator('#loginButton').click();
    await page.locator('#appView:visible, #communityScopeModal:visible').first().waitFor();
    if(await page.locator('#communityScopeModal').isVisible())await page.locator('#confirmCommunityScope').click();
    await page.locator('#appView').waitFor({state:'visible'});await page.locator('[data-workspace-area=management]').click();await page.locator('#receivablesTab').click();
    await page.locator('.finWorkspace [name=community]').selectOption(String(fixture.integral.community));
    await page.getByRole('button',{name:'Preparar emision',exact:true}).waitFor();
    await page.locator('.finWorkspace [name=cut]').fill('2027-01-31');await page.locator('.finWorkspace [name=cut]').blur();
    await page.getByRole('button',{name:'Preparar emision',exact:true}).click();
    await page.locator('[name=plan]').selectOption(String(fixture.integral.plan));await page.locator('[name=period]').first().check();
    assert.equal(await page.locator('[name=emission-property]:checked').count(),40);
    await page.locator('[name=issued_on]').fill('2027-01-03');await page.locator('[name=reason]').fill('Emision integral sintetica desde cuotas aprobadas');
    await page.getByRole('button',{name:'Revisar',exact:true}).click();await page.locator('#finAck').waitFor();
    await page.screenshot({path:path.join(output,'1440-emission-review.png'),fullPage:true});
    await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
    await page.locator('[data-fin-action=receipt]').first().waitFor();assert.equal(await page.locator('[data-fin-action=receipt]').count(),40);
    await page.locator('[data-fin-action=receipt]').first().click();await page.getByRole('heading',{name:'Desglose del recibo'}).waitFor();
    await page.getByRole('button',{name:'Anular',exact:true}).click();await page.locator('[name=reason]').fill('Prueba de sustitucion explicita');
    await page.getByRole('button',{name:'Revisar',exact:true}).click();await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
    await page.locator('[data-fin-action=receipt]').first().click();await page.getByRole('button',{name:'Emitir sustitucion',exact:true}).click();
    await page.locator('[name=reason]').fill('Sustitucion documentada conservando el original');await page.locator('[name=evidence]').fill('SYNTHETIC-SUBSTITUTION');
    await page.getByRole('button',{name:'Revisar',exact:true}).click();await page.locator('#finAck').check();await page.getByRole('button',{name:'Confirmar',exact:true}).click();
    await page.locator('[data-fin-action=receipt]').first().waitFor();assert.equal(await page.locator('[data-fin-action=receipt]').count(),41);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await context.close();
  }
  console.log(JSON.stringify({ok:true,output,integral_emission:Boolean(fixture.integral),checks:['1440/390/360 navigation','collection review and confirmation','multi-receipt allocation beyond first page','return and explicit reversal without automatic reallocation','Excel upload/mapping/preview/confirmation/reimport','historical coverage activation','audited Excel export','debt coverage warnings','no JS errors or global overflow']},null,2));
} finally {
  if(browser)await browser.close();server.kill();await new Promise(resolve=>server.exitCode!==null?resolve():server.once('exit',resolve));
  fs.writeFileSync(path.join(output,'server.log'),log);
}
