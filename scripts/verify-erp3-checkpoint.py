"""Back up a committed build plus an isolated ERP 3 fixture; never production data."""

import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('fixture',type=Path)
parser.add_argument('--output-root',type=Path,required=True)
args=parser.parse_args()
source=args.fixture.resolve()
if not source.parent.name.startswith(('organizador-erp3-emission-','organizador-erp3-foundations-')):
    raise SystemExit('Se requiere un fixture sintetico ERP 3 aislado.')
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
work=Path(tempfile.mkdtemp(prefix='erp3-checkpoint-build-'))
archive=work/'checkpoint.tar'
subprocess.run(['git','archive','--format=tar','--output='+str(archive),commit],cwd=ROOT,check=True)
app=work/'app';app.mkdir()
with tarfile.open(archive) as bundle:bundle.extractall(app,filter='data')
(app/'data').mkdir(exist_ok=True)
with closing(sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)) as src:
    with closing(sqlite3.connect(app/'data'/'organizador_tareas.db')) as dst:src.backup(dst)
result=subprocess.check_output([sys.executable,str(ROOT/'scripts'/'erp0-backup.py'),'--app',str(app),
    '--output-root',str(args.output_root.resolve()),'--code-commit',commit],text=True)
backup=json.loads(result)['backup']
restored=json.loads(subprocess.check_output([sys.executable,str(ROOT/'scripts'/'verify-erp0-backup.py'),backup,'--keep'],text=True))
sys.path.insert(0,str(ROOT/'server'))
from erp_core.database import connect
from erp_core.receivables_projection import receipt_balance,collection_balance,credit_balance,opening_balance

def signature(path):
    conn=connect(path,readonly=True)
    try:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
        balances={}
        for table,project in [('erp_recibos',receipt_balance),('erp_cobros',collection_balance),('erp_creditos',credit_balance),('erp_saldos_apertura',opening_balance)]:
            balances[table]=[{k:v for k,v in project(conn,r['id_comunidad'],r['id'],'9999-12-31').items() if k!='known_at'}
                for r in conn.execute('SELECT * FROM '+table+' ORDER BY id')]
        originals={}
        for table in ('erp_recibos','erp_recibo_sujetos','erp_saldos_apertura','erp_imputaciones','erp_devoluciones','erp_rectificaciones','erp_reasignaciones_obligacion'):
            originals[table]=hashlib.sha256(repr([tuple(r) for r in conn.execute('SELECT * FROM '+table+' ORDER BY id')]).encode()).hexdigest()
        return {'balances':balances,'originals':originals}
    finally:conn.close()

before=signature(source);after=signature(Path(restored['restore'])/'database.db')
assert before==after,'La restauracion no conserva saldos y originales.'
proof={'ok':True,'synthetic_only':True,'production_backup':False,'commit':commit,'backup':backup,
       'restore':restored,'financial_projections_identical':True,'original_hashes_identical':True}
(Path(backup)/'erp3-restore-proof.json').write_text(json.dumps(proof,indent=2),encoding='utf-8')
print(json.dumps(proof))
