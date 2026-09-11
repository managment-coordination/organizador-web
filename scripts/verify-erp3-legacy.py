"""Compare the retained historical observations on a consistent copy, without activation."""
from contextlib import closing
from datetime import date
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))
from access_control import profile
from erp_core.database import connect
from erp_core.dispatcher import execute_query
from erp_core.migrations import apply_all
work=Path(tempfile.mkdtemp(prefix='organizador-erp3-legacy-'));db=work/'database.db'
with closing(sqlite3.connect('file:'+str(Path(sys.argv[1]).resolve())+'?mode=ro',uri=True)) as src:
    with closing(sqlite3.connect(db)) as dst:src.backup(dst)
conn=connect(db)
def signature():
    return {t:hashlib.sha256(repr([tuple(r) for r in conn.execute('SELECT * FROM '+t+' ORDER BY rowid')]).encode()).hexdigest()
        for t in ('cf_recibos','cf_movimientos_deuda','cf_propiedades','cf_propietarios')}
before=signature();apply_all(conn)
uid=conn.execute("SELECT id_usuario FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()[0]
session=profile(conn,uid);results=[];cut=date.today().isoformat()
for community in session['comunidades']:
    cid=community['id_comunidad'];expected=0;valid=0;invalid=set()
    covered=set()
    for r in conn.execute('SELECT source_json FROM erp_saldos_apertura WHERE id_comunidad=?',(cid,)):
        covered.update(json.loads(r[0]).get('normalized',{}).get('legacy_receipt_ids',[]))
    for r in conn.execute('SELECT * FROM cf_recibos WHERE id_comunidad=?',(cid,)):
        if r['id_recibo'] in covered:continue
        try:
            observed=date.fromisoformat(str(r['fecha_ultima_actualizacion'] or r['fecha_creacion'] or '')[:10]).isoformat()
            assert observed<=cut
            values=[Decimal(str(r[k]))*100 for k in ('importe','cobrado','deuda')]
            assert all(v.is_finite() and v==v.to_integral_value() and abs(v)<=9000000000000000 for v in values)
            assert values[0]-values[1]==values[2] and values[2]>=0
            expected+=int(values[2]);valid+=1
        except (ValueError,AssertionError,ArithmeticError):invalid.add(r['id_recibo'])
    def query(name):return execute_query(db,session,{'query':name,'id_comunidad':cid,'filters':{'effective_at':cut}})['entity']
    summary=query('erp3.debt.summary');statement=query('erp3.account.statement')
    assert int(summary['observed_legacy_debt_cents'])==expected
    assert summary['observed_legacy_count']==valid
    assert invalid=={i['legacy_receipt_id'] for i in summary['issues'] if 'legacy_receipt_id' in i}
    assert summary['documented_subtotal_cents']==statement['documented_subtotal_cents']
    if invalid:assert summary['total_pending_cents'] is None
    results.append({'community_id':cid,'valid_observations':valid,'review_required':len(invalid),'projection_matches':True})
assert before==signature();assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
assert not conn.execute('PRAGMA foreign_key_check').fetchall();conn.close()
print(json.dumps({'ok':True,'workspace':str(work),'historical_hashes_unchanged':True,'communities':results}))
