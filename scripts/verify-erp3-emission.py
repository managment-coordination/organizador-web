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
from erp_core.contracts import CommandEnvelope
from erp_core.database import connect
from erp_core.errors import ConflictError
from erp_core.receivables_service import ReceivablesService
from erp_core.receivables_projection import receipt_balance

source=Path(sys.argv[1]).resolve()
assert source.parent.name.startswith('organizador-erp2-complete-'), 'Only the isolated ERP 2 test fixture is accepted.'
work=Path(tempfile.mkdtemp(prefix='organizador-erp3-emission-'));db=work/'database.db'
with closing(sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)) as s:
    with closing(sqlite3.connect(db)) as t:s.backup(t)
conn=connect(db)
uid=conn.execute("SELECT id_usuario FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()[0]
session=profile(conn,uid)
community=conn.execute("SELECT id_comunidad FROM comunidades WHERE nombre='ERP2 Integral'").fetchone()[0]
owner=conn.execute("SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? AND nombre='Titular ERP2'",(community,)).fetchone()[0]
service=ReceivablesService(db)

def command(name,payload,version=None,key=None):
    return getattr(service,name.replace('.','_'))(session,CommandEnvelope.from_value({
        'command':'erp3.'+name,'id_comunidad':community,'payload':payload,'expected_version':version,
        'idempotency_key':key or str(uuid.uuid4()),'origin':'test','reason':'Prueba sintetica 40/16',
        'evidence':{'type':'test_fixture','id':'40-16'}}))['entity']

try:
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
    for line in proposal['preview']['lines']:
        assert sum(int(d['amount_cents']) for d in line['details'])==int(line['amount_cents'])
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not conn.execute('PRAGMA foreign_key_check').fetchall()
    print(json.dumps({'ok':True,'properties':40,'special_group_members':16,'total_cents':str(expected),'snapshot_emission':True,'idempotency':True,'workspace':str(work)}))
finally:conn.close()
