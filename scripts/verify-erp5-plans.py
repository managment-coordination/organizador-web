"""Conciliate certified ordinary/special plan receipts without changing their snapshots."""
import argparse
from contextlib import closing
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import uuid

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'server'))
from erp_core.banking_crypto import BankVault
from erp_core.contracts import CommandEnvelope
from erp_core.database import connect
from erp_core.migrations import apply_all
from erp_core.reconciliation_service import ReconciliationService,CAPABILITIES
from erp_core.receivables_projection import receipt_balance
from access_control import profile

parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);args=parser.parse_args()
source=args.fixture.resolve()
if not source.parent.name.startswith('organizador-quota-plans-'):raise SystemExit('Only isolated certified plan fixtures are allowed')
work=Path(tempfile.mkdtemp(prefix='organizador-erp5-plans-'));db=work/'database.db'
with closing(sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)) as src,closing(sqlite3.connect(db)) as dst:src.backup(dst)
with closing(connect(db)) as conn:
    apply_all(conn);community=conn.execute("SELECT id_comunidad FROM comunidades WHERE codigo='ERP2-INTEGRAL'").fetchone()[0]
    uid=conn.execute("SELECT id_usuario FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()[0]
    account=conn.execute('SELECT treasury_id FROM erp_acreedor_versiones WHERE id_comunidad=? LIMIT 1',(community,)).fetchone()[0]
    receipts=[dict(r) for r in conn.execute("SELECT * FROM erp_recibos WHERE id_comunidad=? AND period_from='2028-01-01' ORDER BY id",(community,))]
    ordinary=next(r for r in receipts if r['concept_key']=='ordinario')
    special=next(r for r in receipts if r['concept_key'].startswith('cuota_plan:') and r['id_propiedad']==ordinary['id_propiedad'])
    tables=('erp_recibos','erp_coeficiente_versiones','erp_plan_versiones','erp_plan_operativo_versiones','erp_plan_emision_vinculos')
    def hashes():
        result={}
        for table in tables:
            columns=[r['name'] for r in conn.execute('PRAGMA table_info('+table+')') if not (table=='erp_recibos' and r['name']=='version')]
            rows=sorted(repr(tuple(r)) for r in conn.execute('SELECT '+','.join(columns)+' FROM '+table))
            result[table]=hashlib.sha256('\n'.join(rows).encode()).hexdigest()
        return result
    before=hashes()
    session=profile(conn,uid);session['banking_reauthenticated_at']=datetime.now(timezone.utc).isoformat()
    service=ReconciliationService(db,vault=BankVault(source.parent/'synthetic-bank-key.json'))
    def command(name,payload,version=None):
        envelope=CommandEnvelope.from_value({'command':'erp5.'+name,'id_comunidad':community,'payload':payload,
            'expected_version':version,'idempotency_key':uuid.uuid4().hex,'reason':'Synthetic plan reconciliation',
            'origin':'test','evidence':{'type':'external_reference','id':'ERP5-PLAN-ACCEPTANCE'}})
        return getattr(service,name.replace('.','_'))(session,envelope)['entity']
    for capability in CAPABILITIES:command('permissions.save',{'user_id':uid,'capability':capability,'allowed':True},0)
    review=command('statement.preview',{'treasury_id':account,'profile':'manual-v1','rows':[
        {'operation_on':'2028-01-03','amount_cents':str(r['amount_cents']),'reference':r['number'],'external_id':'PLAN-RECEIPT-'+str(r['id']),
         'namespace':'synthetic-plans','concept':'Synthetic '+r['concept_key']} for r in (ordinary,special)]})
    ids=command('statement.confirm',{'id':review['id']},review['version'])['movement_ids']
    match=command('match.preview',{'components':[{'movement_id':mid,'action':'record_collection','amount_cents':str(r['amount_cents']),
        'allocations':[{'receipt_id':r['id'],'amount_cents':str(r['amount_cents'])}]} for mid,r in zip(ids,(ordinary,special))]})
    command('match.confirm',{'proposal_id':match['id']},match['version'])
    assert all(receipt_balance(conn,community,r['id'],'2028-01-31')['pending_cents']=='0' for r in (ordinary,special))
    assert hashes()==before,'Receipt, coefficient or plan snapshot changed'
    assert conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp5'").fetchone()[0]==2
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok';assert not conn.execute('PRAGMA foreign_key_check').fetchall()
proof={'ok':True,'workspace':str(work),'ordinary_special_same_property':True,'snapshots_unchanged':before,'new_collections':2}
(work/'proof.json').write_text(json.dumps(proof),encoding='utf8');print(json.dumps(proof))
