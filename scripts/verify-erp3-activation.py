"""Exercise historical activation against an approved ERP 2 plan on a new copy."""
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
from erp_core.database import connect
from erp_core.dispatcher import execute_command,execute_query
from erp_core.migrations import apply_all
from erp_core.errors import ConflictError

source=Path(sys.argv[1]).resolve()
assert source.parent.name.startswith('organizador-erp2-complete-')
work=Path(tempfile.mkdtemp(prefix='organizador-erp3-activation-'));db=work/'database.db'
with closing(sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)) as src:
    with closing(sqlite3.connect(db)) as dst:src.backup(dst)
conn=connect(db);apply_all(conn)
uid=conn.execute("SELECT id_usuario FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()[0]
session=profile(conn,uid)
community=conn.execute("SELECT id_comunidad FROM comunidades WHERE nombre='ERP2 Integral'").fetchone()[0]
pid=conn.execute('SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=? ORDER BY id_propiedad LIMIT 1',(community,)).fetchone()[0]
owner=conn.execute("SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? AND nombre='Titular ERP2'",(community,)).fetchone()[0]
def command(name,payload,version=None):
    return execute_command(db,session,{'command':'erp3.'+name,'id_comunidad':community,'payload':payload,'expected_version':version,
        'idempotency_key':str(uuid.uuid4()),'origin':'test','reason':'Correspondencia sintetica acreditada',
        'evidence':{'type':'external_reference','id':'SYNTHETIC-HISTORY'}})['entity']
try:
    rid=conn.execute("INSERT INTO cf_recibos(referencia,fecha_emision,id_propiedad,id_comunidad,importe,cobrado,deuda) VALUES ('LEGACY-ISSUED','2027-01-03',?,?,100,25,75)",(pid,community)).lastrowid
    draft=command('history.import.preview',{'source':'synthetic','file_hash':'a'*64,'file_name':'synthetic.csv','rows':[
        {'reference':'OPEN-LEGACY','amount_cents':'7500','cutoff_date':'2027-01-31','coverage_from':'2027-01-01','coverage_until':'2027-01-31',
         'property_id':pid,'legacy_receipt_ids':[rid],'scope':'receipt','limitations':'Saldo observado, cobros no reconstruidos'}]})
    opened=command('history.import.confirm',{'import_id':draft['id']},draft['version'])
    coverage=command('coverage.confirm',{'concept_key':'ordinario','effective_from':'2027-01-01','effective_until':'2027-12-31','authority':'legacy_observed'})
    activation=command('coverage.activation.preview',{'coverage_id':coverage['id'],'mappings':[{'legacy_receipt_id':rid,'opening_id':opened['opening_ids'][0],
        'period_from':'2027-01-01','period_until':'2027-01-31'}]})
    command('coverage.activation.confirm',{'proposal_id':activation['id']},activation['version'])
    plan=conn.execute("SELECT v.* FROM erp_plan_versiones v JOIN erp_planes_cuota p ON p.id_plan=v.id_plan AND p.id_comunidad=v.id_comunidad WHERE p.id_comunidad=? AND p.tipo='ordinario' AND p.estado='aprobado' LIMIT 1",(community,)).fetchone()
    period=conn.execute('SELECT clave_periodo FROM erp_plan_periodos WHERE id_plan_version=? ORDER BY orden LIMIT 1',(plan['id_plan_version'],)).fetchone()[0]
    query={'query':'erp3.emitted.coverage','id_comunidad':community,'filters':{'plan_id':plan['id_plan'],'period_keys':[period],'effective_at':'2027-12-31'}}
    result=execute_query(db,session,query)['entity']
    historic=next(r for r in result['emitted'] if r['property_id']==pid)
    assert historic['net_emitted_cents']=='10000' and historic['collected_cents']=='0'
    assert historic['references'][0]['type']=='activated_history'
    command('responsibility.confirm',{'property_id':pid,'effective_from':'2027-01-01','subjects':[{'type':'owner','id':owner}]},0)
    try:
        command('emission.preview',{'plan_version_id':plan['id_plan_version'],'property_ids':[pid],'period_keys':[period],'issued_on':'2027-02-01'})
        raise AssertionError('Historical obligation was emitted twice')
    except ConflictError:pass
    assert conn.execute('SELECT COUNT(*) FROM erp_cobros WHERE id_comunidad=?',(community,)).fetchone()[0]==0
    conn.execute('UPDATE cf_recibos SET deuda=74,cobrado=26 WHERE id_recibo=?',(rid,))
    try:
        execute_query(db,session,query)
        raise AssertionError('Changed historical source was silently accepted')
    except ConflictError:pass
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not conn.execute('PRAGMA foreign_key_check').fetchall()
    print(json.dumps({'ok':True,'workspace':str(work),'emitted_not_collected':True,'duplicate_emission_blocked':True,'source_change_blocked':True}))
finally:conn.close()
