"""Acceptance of the plan extension on a copy of the ERP 2 40/16 fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'server'))
from erp_core.dispatcher import execute_command,execute_query
from erp_core.errors import ConflictError,ContractError
from erp_core.migrations import apply_all
from erp_core.budget_engine import simulate_budget
from erp_core.receivables_service import ReceivablesService
from access_control import profile
from erp_core.banking_crypto import BankVault
from erp_core.banking_service import BankingService
from erp_core.contracts import CommandEnvelope
from erp_core.database import connect
from datetime import date,datetime,timezone
from unittest.mock import patch

parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);args=parser.parse_args()
work=Path(tempfile.mkdtemp(prefix='organizador-quota-plans-'));database=work/'database.db'
src=sqlite3.connect('file:'+str(args.fixture.resolve())+'?mode=ro',uri=True);dst=sqlite3.connect(database);src.backup(dst);src.close();dst.close()
conn=sqlite3.connect(database);conn.row_factory=sqlite3.Row;apply_all(conn)
community=conn.execute("SELECT id_comunidad FROM comunidades WHERE codigo='ERP2-INTEGRAL'").fetchone()[0]
actor=conn.execute("SELECT * FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()
session={'id_usuario':actor['id_usuario'],'nombre':actor['nombre'],'rol':'Superusuario','auth_version':actor['auth_version']}
session['comunidades']=[{'id_comunidad':community,'nombre':'ERP2 Integral','puede_ver':1,'puede_actualizar':1}]
exercise=conn.execute("SELECT id_ejercicio FROM erp_ejercicios WHERE id_comunidad=? AND codigo='2028'",(community,)).fetchone()[0]
general=conn.execute("SELECT id_grupo FROM erp_grupos_reparto WHERE id_comunidad=? AND codigo='GENERAL'",(community,)).fetchone()[0]
special=conn.execute("SELECT id_grupo FROM erp_grupos_reparto WHERE id_comunidad=? AND finalidad='jardines'",(community,)).fetchone()[0]
properties=[r[0] for r in conn.execute('SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=? ORDER BY id_propiedad',(community,))]
owner=conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=?',(community,)).fetchone()[0]
conn.close();checks=[]

def command(name,payload,version=None,key=None,evidence=None):
    return execute_command(str(database),session,{'command':name,'id_comunidad':community,'payload':payload,
        'expected_version':version,'idempotency_key':key or uuid.uuid4().hex,'reason':'Aceptacion sintetica de planes',
        'origin':'test','evidence':evidence})

def query(name,filters=None):
    return execute_query(str(database),session,{'query':name,'id_comunidad':community,'filters':filters or {}})

def plan(payload,version=0):
    preview=command('erp2.quota_plan.preview',payload,version)['entity']
    result=command('erp2.quota_plan.confirm',{'proposal_id':preview['id'],'configuration_version':version},preview['version'])['entity']
    return result,preview

def coverage(concept):
    command('erp3.coverage.confirm',{'concept_key':concept,'effective_from':'2028-01-01','effective_until':'2028-12-31','authority':'erp3'},
        evidence={'type':'external_reference','id':'SYNTHETIC-CUTOVER'})

b=command('erp2.budget.create',{'id_ejercicio':exercise,'denominacion':'Presupuesto de referencia planes','periodicidad':'mensual'})['entity']
b=command('erp2.budget.save',{'id_presupuesto':b['id_presupuesto'],'chapters':[{'key':'G','name':'General','items':[{'key':'G','name':'Gastos generales',
    'amount_cents':'100000000','assignments':[{'key':'G','group_id':general,'rule_type':'coeficiente','series_purpose':'general','series_unit':'porcentaje','mode':'porcentaje','value':'100'}]}]}]},b['version_concurrencia'])['entity']
command('erp2.budget.simulate',{'id_presupuesto':b['id_presupuesto']})
b=command('erp2.budget.propose',{'id_presupuesto':b['id_presupuesto']},b['version_concurrencia'])['entity']
approved=command('erp2.budget.approve',{'id_presupuesto':b['id_presupuesto'],'date':'2027-12-15'},b['version_concurrencia'])['entity']
a,pa=plan({'name':'Cuota ordinaria','concept':'Cuota ordinaria','exercise_id':exercise,'origin_type':'presupuesto','budget_id':b['id_presupuesto'],'effective_from':'2028-01-01'})
assert a['id']==approved['id_plan'];coverage('ordinario');checks.append('presupuesto aprobado reutilizado sin duplicar plan/snapshot')
manual={'name':'Derrama ascensor','concept':'Derrama ascensor','exercise_id':exercise,'origin_type':'importe_manual',
    'effective_from':'2028-01-01','amount_cents':'4000000','amount_mode':'total_anual','frequency':'mensual','group_id':special,
    'rule_type':'porcentaje_especial','series_purpose':'jardines','series_unit':'porcentaje'}
m,pm=plan(manual);coverage('cuota_plan:'+str(m['id']))
assert len(pm['preview']['result']['property_totals'])==16
assert sum(int(x['annual_cents']) for x in pm['preview']['result']['property_totals'])==4000000
assert sum(int(q['cents']) for x in pm['preview']['result']['property_totals'] for q in x['periods'])==4000000
checks.append('manual anual 40000 EUR, 16 miembros, residuos exactos y coeficiente especial')
for pid in properties:
    command('erp3.responsibility.confirm',{'property_id':pid,'effective_from':'2028-01-01','subjects':[{'type':'owner','id':owner}]},0,
        evidence={'type':'external_reference','id':'SYNTHETIC-OBLIGATED'})
p=command('erp3.period.emission.preview',{'exercise_id':exercise,'period_from':'2028-01-01','issued_on':'2028-01-03'})['entity']
assert not p['preview']['errors'],p['preview']['errors'];assert p['preview']['receipt_count']==56
assert len(p['preview']['plans'])==2
key=uuid.uuid4().hex;request={'proposal_id':p['id']}
conn=sqlite3.connect(database)
baseline=conn.execute('SELECT COUNT(*) FROM erp_recibos').fetchone()[0]
conn.execute("CREATE TRIGGER quota_acceptance_failure BEFORE INSERT ON erp_recibos WHEN NEW.concept_key='cuota_plan:"+str(m['id'])+"' BEGIN SELECT RAISE(ABORT,'Synthetic second-plan failure'); END")
conn.commit();conn.close()
try:command('erp3.period.emission.confirm',request,p['version'],key)
except sqlite3.IntegrityError:pass
else:raise AssertionError('The injected failure did not block issuance')
conn=sqlite3.connect(database)
assert conn.execute('SELECT COUNT(*) FROM erp_recibos').fetchone()[0]==baseline
assert conn.execute('SELECT state FROM erp_emisiones_lotes WHERE id=?',(p['id'],)).fetchone()[0]=='draft'
conn.execute('DROP TRIGGER quota_acceptance_failure');conn.commit();conn.close()
checks.append('fallo en el segundo plan revierte recibos, eventos y confirmacion completa')
issued=command('erp3.period.emission.confirm',request,p['version'],key)
again=command('erp3.period.emission.confirm',request,p['version'],key)
assert again['idempotent_replay'] and again['entity']==issued['entity']
receipts=issued['entity']['receipt_ids'];assert len(receipts)==56
checks.append('enero: 40 ordinarias +16 derramas independientes; idempotencia')
p=command('erp3.period.emission.preview',{'exercise_id':exercise,'period_from':'2028-01-01','issued_on':'2028-01-04'})['entity']
assert p['preview']['receipt_count']==0 and len(p['preview']['already_issued'])==56
checks.append('nueva ejecucion muestra lo emitido sin duplicados')
conn=sqlite3.connect(database);conn.row_factory=sqlite3.Row
before=hashlib.sha256(repr([tuple(r) for r in conn.execute('SELECT * FROM erp_recibos WHERE id_comunidad=? ORDER BY id',(community,))]).encode()).hexdigest()
snapshot=json.loads(conn.execute('SELECT snapshot_json FROM erp_recibos WHERE id=?',(receipts[-1],)).fetchone()[0]);assert snapshot['quota_plan']['id']==m['id']
assert conn.execute('SELECT COUNT(*) FROM erp_plan_emision_vinculos WHERE id_comunidad=?',(community,)).fetchone()[0]==56
assert conn.execute("SELECT COUNT(*) FROM erp_coeficiente_versiones WHERE id_comunidad=? AND valor_decimal='2.5'",(community,)).fetchone()[0]==40
conn.close();checks.append('snapshot del plan, vinculos, cuota general y especial independientes')
command('erp2.quota_plan.activity',{'plan_id':m['id'],'active':False,'effective_from':'2028-02-01'},1)
p=command('erp3.period.emission.preview',{'exercise_id':exercise,'period_from':'2028-02-01','issued_on':'2028-02-03'})['entity']
assert p['preview']['receipt_count']==40 and len(p['preview']['plans'])==1
command('erp3.period.emission.confirm',{'proposal_id':p['id']},p['version']);checks.append('febrero: desactivacion elimina nuevas derramas, conserva enero')
conn=sqlite3.connect(database);after=hashlib.sha256(repr(conn.execute('SELECT * FROM erp_recibos WHERE id IN ('+','.join('?' for _ in receipts)+') ORDER BY id',receipts).fetchall()).encode()).hexdigest();assert after==before;conn.close()
checks.append('historico anterior intacto tras desactivar')
for frequency,count in [('mensual',12),('trimestral',4),('semestral',2),('anual',1)]:
    payload={**manual,'name':'Por periodo '+frequency,'amount_mode':'por_periodo','amount_cents':'10000','frequency':frequency,'group_id':general,'rule_type':'partes_iguales'}
    result,preview=plan(payload)
    calculation=preview['preview']['result'];assert len(calculation['periods'])==count
    assert sum(int(x['annual_cents']) for x in calculation['property_totals'])==10000*count
    assert all(sum(int(q['cents']) for x in calculation['property_totals'] for q in x['periods'] if q['key']==period['key'])==10000 for period in calculation['periods'])
    for x in calculation['property_totals']:assert sum(int(q['cents']) for q in x['periods'])==int(x['annual_cents'])
checks.append('importe por periodo: mensual/trimestral/semestral/anual exactos')
for frequency,count in [('mensual',12),('trimestral',4),('semestral',2),('anual',1)]:
    _,preview=plan({**manual,'name':'Annual acceptance '+frequency,'frequency':frequency,'amount_cents':'10001','group_id':general,'rule_type':'partes_iguales'})
    calculation=preview['preview']['result']
    assert len(calculation['periods'])==count and sum(int(x['annual_cents']) for x in calculation['property_totals'])==10001
    assert sum(int(p['cents']) for x in calculation['property_totals'] for p in x['periods'])==10001
for mode,rule,params in [('total_anual','importe_fijo',{'fixed_cents':'250'}),('por_periodo','importe_fijo',{'fixed_cents':'250'}),
                         ('total_anual','unidades',{'tariff_decimal':'2.5','quantities':{str(pid):'1' for pid in properties}})]:
    _,preview=plan({**manual,'name':'Rule acceptance '+rule+' '+mode,'group_id':general,'rule_type':rule,'rule_parameters':params,'amount_mode':mode,'amount_cents':'10000'})
    assert sum(int(x['annual_cents']) for x in preview['preview']['result']['property_totals'])==(120000 if mode=='por_periodo' else 10000)
checks.append('total anual con residuos en cuatro frecuencias; importe fijo y unidades exactas')
small=json.loads(json.dumps(pm['preview']['manifest']))
small.update(plan_amount_mode='por_periodo',period_target_cents='10000')
small['items'][0]['amount_cents']='120000';assignment=small['items'][0]['assignments'][0];assignment['value']='120000'
assignment['group'].update(base='sin_coeficiente',expected_total=None);assignment['rule']['type']='partes_iguales';assignment['rule']['parameters']={};assignment['members']=assignment['members'][:3]
calculation=simulate_budget(small);assert calculation['status']=='completa',calculation
assert sorted(int(x['periods'][0]['cents']) for x in calculation['property_totals'])==[3333,3333,3334]
for line in calculation['lines']:assert int(line['base_cents'])+int(line['adjustment_cents'])==int(line['final_cents'])
checks.append('100 EUR por periodo entre tres: 33.34/33.33/33.33 y traza anual coherente')
new={**manual,'plan_id':m['id'],'amount_cents':'4800000'}
version,preview=plan(new,1);assert version['version']==2 and version['regularization_required']
assert ReceivablesService._wire(simulate_budget(preview['preview']['manifest']))==preview['preview']['result']
checks.append('nueva version retroactiva, reproduccion exacta, no reescribe enero')
reg=command('erp2.regularization.preview',{'id_plan':m['id'],'emitted_source':'erp3','coverage_start':'2028-01-01','coverage_end':'2028-01-31',
    'cutoff_date':'2028-03-03','reason':'Cambio aprobado desde enero'})['entity']
assert sum(int(x['difference_cents']) for x in reg['lines'])>0
assert all(int(x['net_emitted_cents'])>0 for x in reg['lines'])
checks.append('regularizacion contra enero emitido e impagado, no vuelve a cargar la cuota')
evidence={'type':'external_reference','id':'SYNTHETIC-REGULARIZATION'}
command('erp2.regularization.approve',{'id_regularizacion':reg['id_regularizacion'],'confirm_pending_recipients':True},1,evidence=evidence)
conn=sqlite3.connect(database)
decisions=[{'line_id':r[0],'subjects':[{'type':'owner','id':owner}]} for r in conn.execute('SELECT id_linea FROM erp_regularizacion_lineas WHERE id_regularizacion=?',(reg['id_regularizacion'],))]
conn.close()
preview=command('erp3.regularization.emission.preview',{'regularization_id':reg['id_regularizacion'],'effective_on':'2028-03-03','decisions':decisions},evidence=evidence)['entity']
adjust=command('erp3.regularization.emission.confirm',{'proposal_id':preview['id']},preview['version'],evidence=evidence)['entity']
assert len(adjust['receipt_ids'])==16 and not adjust['original_receipts_changed']
checks.append('regularizacion aprobada y materializada mediante ERP3, originales intactos')
future={**manual,'plan_id':m['id'],'effective_from':'2028-04-01','amount_cents':'5000000'}
future_version,_=plan(future,2);assert not future_version['regularization_required']
checks.append('version futura no exige regularizacion de recibos anteriores')
unissued=command('erp2.regularization.preview',{'id_plan':m['id'],'emitted_source':'erp3','coverage_start':'2028-04-01','coverage_end':'2028-04-30','cutoff_date':'2028-04-05','reason':'Synthetic unissued period'})['entity']
assert all(int(l['net_emitted_cents'])==0 for l in unissued['lines'])
command('erp2.regularization.approve',{'id_regularizacion':unissued['id_regularizacion'],'confirm_pending_recipients':True},1,evidence=evidence)
conn=sqlite3.connect(database)
period=conn.execute('SELECT clave_periodo FROM erp_plan_periodos WHERE id_plan_version=? AND fecha_inicio=\'2028-04-01\'',(future_version['calculation_version_id'],)).fetchone()[0]
conn.close()
try:command('erp3.emission.preview',{'plan_version_id':future_version['calculation_version_id'],'period_keys':[period],'property_ids':[unissued['lines'][0]['property_id']],'issued_on':'2028-04-05'})
except ConflictError as error:assert 'regularizacion' in str(error)
else:raise AssertionError('A regularized unissued period was charged again')
checks.append('regularizacion de periodo no emitido bloquea un nuevo cargo completo duplicado')
listed=query('erp2.quota_plan.list',{'effective_at':'2028-01-01'})['entity']
assert listed['references']['groups'] and any(x['id']==m['id'] and x['active'] for x in listed['items'])
conn=sqlite3.connect(database);conn.row_factory=sqlite3.Row
other=conn.execute("SELECT id_usuario FROM usuarios WHERE rol<>'Superusuario' AND activo=1 LIMIT 1").fetchone()
if other:
    denied=profile(conn,other[0])
    try:execute_command(str(database),denied,{'command':'erp2.quota_plan.preview','id_comunidad':community,'payload':manual,'expected_version':0,'idempotency_key':uuid.uuid4().hex,'reason':'Permission test','origin':'test'})
    except PermissionError:pass
    else:raise AssertionError('An ungranted user configured another community')
foreign=conn.execute('SELECT id_ejercicio FROM erp_ejercicios WHERE id_comunidad<>? LIMIT 1',(community,)).fetchone()
conn.close()
if foreign:
    try:command('erp3.period.emission.preview',{'exercise_id':foreign[0],'period_from':'2028-01-01','issued_on':'2028-01-03'})
    except ContractError:pass
    else:raise AssertionError('A foreign exercise was accepted')
checks.append('permisos backend y ejercicio de otra comunidad rechazado')
stale=command('erp3.period.emission.preview',{'exercise_id':exercise,'period_from':'2028-05-01','issued_on':'2028-05-03'})['entity']
activity=next(x for x in query('erp2.quota_plan.list',{'effective_at':'2028-05-01'})['entity']['items'] if x['id']==a['id'])['activity_version']
command('erp2.quota_plan.activity',{'plan_id':a['id'],'active':False,'effective_from':'2028-05-01'},activity)
try:command('erp3.period.emission.confirm',{'proposal_id':stale['id']},stale['version'])
except ConflictError:pass
else:raise AssertionError('A stale multi-plan preview was confirmed')
command('erp2.quota_plan.activity',{'plan_id':a['id'],'active':True,'effective_from':'2028-06-01'},activity+1)
checks.append('propuesta desactualizada bloqueada; reactivacion conserva historial')
bank=BankingService(database,vault=BankVault(BankVault.create_key_file(work/'synthetic-bank-key.json')))
session['banking_reauthenticated_at']=datetime.now(timezone.utc).isoformat()
def banking(name,payload,version=None):
    return bank.__getattribute__(name.replace('.','_'))(session,CommandEnvelope.from_value({'command':'erp4.'+name,'id_comunidad':community,'payload':payload,
        'expected_version':version,'idempotency_key':uuid.uuid4().hex,'reason':'SYNTHETIC BANK ACCEPTANCE','origin':'test','evidence':{'type':'external_reference','id':'TEST-ONLY'}}))['entity']
for cap in ('manage_accounts','configure_creditor','manage_mandates','prepare','present_cancel'):
    banking('permissions.save',{'user_id':session['id_usuario'],'capability':cap,'allowed':True},0)
iban='ES9121000418450200051332'
account=banking('account.create',{'iban':iban})
suffix='M12345678';digits=''.join(str(ord(c)-55) if c.isalpha() else c for c in suffix+'ES00');creditor_code='ES'+str(98-int(digits)%97).zfill(2)+'000'+suffix
creditor=banking('creditor.create',{'name':'SYNTHETIC COMMUNITY','creditor_identifier':creditor_code,'iban':iban,'address':{'country':'ES','town':'Madrid'},'effective_from':'2028-01-01'})
banking('profile.configure',{'creditor_id':creditor['id'],'config':{'bank_name':'Synthetic','timezone':'Europe/Madrid','cutoff':'14:00','lead_business_days':1,'holidays':[],
    'countries':['ES'],'max_lines':10000,'max_total_cents':'100000000','recurrent_sequence':'RCUR','mode':'test','bank_profile_accepted':False,'external_instructions_reviewed':False}},0)
conn=connect(database)
chosen=[dict(r) for r in conn.execute('SELECT r.* FROM erp_recibos r JOIN erp_recibo_sujetos s ON s.receipt_id=r.id AND s.role=\'payer\' AND s.owner_id=? WHERE r.id_comunidad=? AND r.id IN('+','.join('?' for _ in receipts)+') ORDER BY r.id DESC LIMIT 2',[owner,community,*receipts])]
assert len(chosen)==2
scope=list({r['id_propiedad'] for r in chosen})
mandate=banking('mandate.create',{'creditor_id':creditor['id'],'kind':'recurrente','account_id':account['id'],'debtor':{'type':'owner','id':owner},'debtor_name':'Synthetic payer',
    'address':{'country':'ES','town':'Madrid'},'signers':[{'subject':{'type':'owner','id':owner},'capacity':'Synthetic signer'}],
    'signed_on':date.today().isoformat(),'effective_from':date.today().isoformat(),'property_ids':scope,'rum':'SYNTHETIC-QUOTA-PLANS'})
banking('mandate.transition',{'id':mandate['id'],'state':'activo','effective_on':date.today().isoformat()},1)
configs=[]
for pid in scope:
    configs.append(conn.execute('''INSERT INTO erp_config_recibo_versiones(id_comunidad,id_propiedad,alcance,version,efectiva_desde,registrada_en,registrada_por,estado,
        destinatario_propietario_id,pagador_propietario_id,medio_previsto,origen) VALUES (?,?,'synthetic-bank-plan',1,'2028-01-01','2028-01-01',?,'confirmada',?,?,'domiciliacion_pendiente','test')''',
        (community,pid,session['id_usuario'],owner,owner)).lastrowid)
conn.close()
banking('direct_debit.confirm',{'mandate_id':mandate['id'],'billing_config_ids':configs,'effective_from':'2028-01-01'},2)
requested='2028-02-01'
notice=banking('notification.record',{'sent_on':date.today().isoformat(),'lines':[{'receipt_id':r['id'],'amount_cents':str(r['amount_cents']),'requested_on':requested,'mandate_id':mandate['id']} for r in chosen]})
payload={'creditor_id':creditor['id'],'requested_on':requested,'receipt_ids':[r['id'] for r in chosen],'notification_id':notice['id']}
with patch('erp_core.receivables_projection.date') as clock:
    clock.today.return_value=date(2028,2,1)
    preview=banking('remittance.preview',payload)
    remittance=banking('remittance.prepare',{**payload,'preview_hash':preview['preview_hash']})
assert remittance['total_cents']==str(sum(r['amount_cents'] for r in chosen))
checks.append('recibos de planes elegibles y reservados en remesa ERP4, sin reconocer cobro')
conn=sqlite3.connect(database)
assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok';assert not conn.execute('PRAGMA foreign_key_check').fetchall()
assert conn.execute("SELECT COUNT(*) FROM erp_audit_events WHERE id_comunidad=? AND action LIKE 'erp2.quota_plan.%'",(community,)).fetchone()[0]>0
conn.close();checks.append('auditoria, integridad y FK')
print(json.dumps({'ok':True,'checks':checks,'workspace':str(work),'database':str(database),'community':community,'exercise':exercise,'ordinary_plan':a['id'],'manual_plan':m['id'],'jan_cents':issued['entity']['total_cents']},indent=2))
