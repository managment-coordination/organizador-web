"""Consume the isolated ERP 2 40/16 fixture without recalculating quotas."""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))
from access_control import profile
from erp_core.contracts import CommandEnvelope,QueryEnvelope
from erp_core.database import connect
from erp_core.errors import ConflictError
from erp_core.receivables_service import ReceivablesService
from erp_core.receivables_projection import receipt_balance
from erp_core.migrations import apply_all

source=Path(sys.argv[1]).resolve()
assert source.parent.name.startswith('organizador-erp2-complete-'), 'Only the isolated ERP 2 test fixture is accepted.'
work=Path(tempfile.mkdtemp(prefix='organizador-erp3-emission-'));db=work/'database.db'
with closing(sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)) as s:
    with closing(sqlite3.connect(db)) as t:s.backup(t)
conn=connect(db)
apply_all(conn)
uid=conn.execute("SELECT id_usuario FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()[0]
session=profile(conn,uid)
community=conn.execute("SELECT id_comunidad FROM comunidades WHERE nombre='ERP2 Integral'").fetchone()[0]
owner=conn.execute("SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? AND nombre='Titular ERP2'",(community,)).fetchone()[0]
service=ReceivablesService(db)

def command(name,payload,version=None,key=None):
    return getattr(service,name.replace('.','_'))(session,CommandEnvelope.from_value({
        'command':'erp3.'+name,'id_comunidad':community,'payload':payload,'expected_version':version,
        'idempotency_key':key or str(uuid.uuid4()),'origin':'test','reason':'Prueba sintetica 40/16',
        'evidence':{'type':'external_reference','id':'synthetic:40-16'}}))['entity']

try:
    command('coverage.confirm',{'concept_key':'ordinario','effective_from':'2027-01-01','effective_until':'2027-12-31','authority':'erp3'})
    properties=[r[0] for r in conn.execute('SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=?',(community,))]
    for pid in properties:command('responsibility.confirm',{'property_id':pid,'effective_from':'2027-01-01','subjects':[{'type':'owner','id':owner}]},0)
    plan=conn.execute("SELECT v.* FROM erp_plan_versiones v JOIN erp_planes_cuota p ON p.id_plan=v.id_plan WHERE p.id_comunidad=? AND p.tipo='ordinario' AND p.estado='aprobado' LIMIT 1",(community,)).fetchone()
    periods=[r[0] for r in conn.execute('SELECT clave_periodo FROM erp_plan_periodos WHERE id_plan_version=? ORDER BY orden',(plan['id_plan_version'],))]
    proposal=command('emission.preview',{'plan_version_id':plan['id_plan_version'],'period_keys':[periods[0]],'issued_on':'2027-01-03'})
    assert len(proposal['preview']['lines'])==40
    expected=sum(int(x['amount_cents']) for x in proposal['preview']['lines'])
    result=command('emission.confirm',{'proposal_id':proposal['id']},1,key='emit-once')
    replay=command('emission.confirm',{'proposal_id':proposal['id']},1,key='emit-once')
    assert result['receipt_ids']==replay['receipt_ids']
    assert conn.execute('SELECT COUNT(*) FROM erp_recibos WHERE id_comunidad=?',(community,)).fetchone()[0]==40
    assert sum(int(receipt_balance(conn,community,rid,'2027-01-31')['pending_cents']) for rid in result['receipt_ids'])==expected
    try:
        command('emission.preview',{'plan_version_id':plan['id_plan_version'],'period_keys':[periods[0]],'issued_on':'2027-01-04'})
        raise AssertionError('Duplicate obligation accepted')
    except ConflictError:pass
    # Recipient changes are resolved at actual emission, not the natural period start.
    from erp_core.dispatcher import execute_query,execute_command
    def erp_command(name,payload,expected=None,evidence=None):
        return execute_command(db,session,{'command':name,'id_comunidad':community,'payload':payload,
            'expected_version':expected,'idempotency_key':str(uuid.uuid4()),'origin':'test','reason':'Cambio documentado de propiedad',
            'evidence':evidence})['entity']
    new_owner=erp_command('erp1.owner.save',{'nombre':'Nuevo titular ERP3 sintetico','tipo_persona':'fisica'})['id_propietario']
    selected=properties[1:3]
    july=periods[6]
    earlier=command('emission.preview',{'plan_version_id':plan['id_plan_version'],'period_keys':[july],'property_ids':[selected[0]],'issued_on':'2027-07-03'})
    earlier_ids=command('emission.confirm',{'proposal_id':earlier['id']},1)['receipt_ids']
    for pid in selected:
        ownership=erp_command('erp1.ownership.propose',{'id_propiedad':pid,'efectiva_desde':'2027-07-10','calidad':'validada',
            'composicion_completa':True,'lineas':[{'id_propietario':new_owner,'porcentaje_decimal':'100'}],'motivo':'Transmision documentada'},
            evidence={'type':'test_document','id':'ERP3-SALE'})
        erp_command('erp1.ownership.confirm',{'id_propuesta':ownership['id_propuesta']},ownership['version'])
        command('responsibility.confirm',{'property_id':pid,'effective_from':'2027-07-10','effective_until':'2027-09-01',
            'subjects':[{'type':'owner','id':new_owner}]},1)
    late=command('emission.preview',{'plan_version_id':plan['id_plan_version'],'period_keys':[july],'property_ids':[selected[1]],'issued_on':'2027-07-12'})
    assert late['preview']['lines'][0]['recipient']['id']==new_owner
    from erp_core.budget_simulation import _load_by_id
    quota=next(q for q in _load_by_id(conn,community,plan['id_simulacion'])['property_totals'] if int(q['property_id'])==selected[1])
    assert int(late['preview']['lines'][0]['amount_cents'])==int(next(p['cents'] for p in quota['periods'] if p['key']==july))
    command('emission.confirm',{'proposal_id':late['id']},1)
    recipient=json.loads(conn.execute("SELECT snapshot_json FROM erp_recibo_sujetos WHERE receipt_id=? AND role='recipient'",(earlier_ids[0],)).fetchone()[0])
    assert recipient['id']==owner, 'A later ownership change must not rewrite an issued recipient'
    old_debt=execute_query(db,session,{'query':'erp3.account.statement','id_comunidad':community,
        'filters':{'owner_id':owner,'property_id':selected[0],'effective_at':'2027-08-01'}})['entity']
    assert any(r.get('receipt_id')==earlier_ids[0] for r in old_debt['items'])
    new_debt=execute_query(db,session,{'query':'erp3.account.statement','id_comunidad':community,
        'filters':{'owner_id':new_owner,'property_id':selected[0],'effective_at':'2027-08-01'}})['entity']
    assert not any(r.get('receipt_id')==earlier_ids[0] for r in new_debt['items'])
    try:
        command('emission.preview',{'plan_version_id':plan['id_plan_version'],'period_keys':[periods[8]],'property_ids':[selected[0]],'issued_on':'2027-09-03'})
        raise AssertionError('Expired responsibility silently revived an earlier owner')
    except ConflictError:pass
    for line in proposal['preview']['lines']:
        assert sum(int(d['amount_cents']) for d in line['details'])==int(line['amount_cents'])
    def coverage():
        return service.emitted_coverage(session,QueryEnvelope.from_value({'query':'erp3.emitted.coverage',
            'id_comunidad':community,'filters':{'plan_id':plan['id_plan'],'effective_at':'2027-12-31','period_keys':[periods[0]]}}))['entity']
    before=coverage()
    reg=conn.execute("SELECT id_regularizacion FROM erp_regularizaciones WHERE id_comunidad=? AND estado='aprobada' LIMIT 1",(community,)).fetchone()[0]
    decisions=[{'line_id':r[0],'subjects':[{'type':'owner','id':owner}],
                **({'credit_beneficiary':{'type':'owner','id':owner}} if r[1]<0 else {})}
        for r in conn.execute('SELECT id_linea,diferencia_centimos FROM erp_regularizacion_lineas WHERE id_comunidad=? AND id_regularizacion=?',(community,reg))]
    regularization=command('regularization.emission.preview',{'regularization_id':reg,'effective_on':'2027-02-01','decisions':decisions})
    original_hashes=list(conn.execute('SELECT id,snapshot_hash,amount_cents FROM erp_recibos WHERE id_comunidad=? ORDER BY id',(community,)))
    adjustment=command('regularization.emission.confirm',{'proposal_id':regularization['id']},1,key='adjust-once')
    assert adjustment['receipt_ids'] and adjustment['credit_ids']
    assert command('regularization.emission.confirm',{'proposal_id':regularization['id']},1,key='adjust-once')==adjustment
    for rid,sha,amount in original_hashes:
        assert tuple(conn.execute('SELECT snapshot_hash,amount_cents FROM erp_recibos WHERE id=?',(rid,)).fetchone())==(sha,amount)
    after=coverage()
    for a,b in zip(before['emitted'],after['emitted']):
        assert a['net_emitted_cents']==b['net_emitted_cents'], 'Materialized adjustments must not be counted twice'
        assert int(b['net_emitted_cents'])+int(b['approved_adjustments_cents'])==int(b['total_net_emitted_cents'])+int(b['reserved_adjustments_cents'])
    assert not conn.execute('SELECT 1 FROM erp_credito_aplicaciones WHERE id_comunidad=?',(community,)).fetchone(), 'No automatic application of credits'
    from erp_core.dispatcher import execute_command
    def budget_command(name,payload):
        return execute_command(db,session,{'command':'erp2.'+name,'id_comunidad':community,'payload':payload,
            'idempotency_key':str(uuid.uuid4()),'origin':'test','reason':'Verificacion del emitido neto rector'})['entity']
    recalculation={'id_plan':plan['id_plan'],'cutoff_date':'2027-12-31','coverage_start':'2027-01-01','coverage_end':'2027-01-31',
                   'reason':'Regularizacion contra emitido, incluido impagado','emitted_source':'erp3'}
    next_reg=budget_command('regularization.preview',recalculation)
    budget_command('regularization.approve',{'id_regularizacion':next_reg['id_regularizacion'],'confirm_pending_recipients':True})
    zero=budget_command('regularization.preview',recalculation)
    assert all(int(line['difference_cents'])==0 for line in zero['lines']), 'Approved adjustments must be reserved once, even when unpaid'
    again=budget_command('regularization.preview',recalculation)
    assert again['id_regularizacion']==zero['id_regularizacion'] and again['lines']==zero['lines']
    # An explicit replacement receives a new number, retaining the annulled original.
    original=result['receipt_ids'][-1]
    original_row=dict(conn.execute('SELECT * FROM erp_recibos WHERE id=?',(original,)).fetchone())
    annul=command('void.preview',{'receipt_id':original,'effective_on':'2027-02-02'})
    command('void.confirm',{'proposal_id':annul['id']},1)
    replace_request={'plan_version_id':plan['id_plan_version'],'property_ids':[original_row['id_propiedad']],
                     'period_keys':[periods[0]],'issued_on':'2027-02-03','replaces_receipt_ids':[original]}
    replacement=command('emission.preview',replace_request)
    replaced=command('emission.confirm',{'proposal_id':replacement['id']},1)
    new_row=dict(conn.execute('SELECT * FROM erp_recibos WHERE id=?',(replaced['receipt_ids'][0],)).fetchone())
    assert new_row['number']!=original_row['number'] and new_row['amount_cents']==original_row['amount_cents']
    assert receipt_balance(conn,community,original,'2027-02-03')['state']=='anulado'
    assert conn.execute('SELECT snapshot_hash FROM erp_recibos WHERE id=?',(original,)).fetchone()[0]==original_row['snapshot_hash']
    # A staged ERP 3-backed regularization cannot approve after an additional abono.
    staged=budget_command('regularization.preview',{**recalculation,'reason':'Comprobar obsolescencia'})
    credit=command('credit.preview',{'receipt_id':new_row['id'],'effective_on':'2027-02-04','amount_cents':'1'})
    command('credit.confirm',{'proposal_id':credit['id']},1)
    try:
        budget_command('regularization.approve',{'id_regularizacion':staged['id_regularizacion'],'confirm_pending_recipients':True})
        raise AssertionError('Stale emitted coverage accepted')
    except ConflictError:pass
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not conn.execute('PRAGMA foreign_key_check').fetchall()
    print(json.dumps({'ok':True,'properties':40,'special_group_members':16,'total_cents':str(expected),'snapshot_emission':True,'idempotency':True,'workspace':str(work)}))
finally:conn.close()
