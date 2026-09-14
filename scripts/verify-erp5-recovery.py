"""ERP 0 checkpoint/restore with separate synthetic key custody; never production."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))
from erp_core.banking_crypto import BankVault
from erp_core.database import connect

parser=argparse.ArgumentParser();parser.add_argument('fixture',type=Path);parser.add_argument('commit');args=parser.parse_args()
fixture=args.fixture.resolve(strict=True)
if not any(p.name.startswith('organizador-erp5-foundations-') for p in fixture.parents):
    raise SystemExit('A synthetic ERP5 foundation fixture is required.')
key=fixture/'custody.key';source=fixture/'database.db'
if not key.is_file() or not source.is_file():raise SystemExit('Incomplete synthetic fixture.')
work=Path(tempfile.mkdtemp(prefix='organizador-erp5-recovery-'));work.chmod(0o700)
app=work/'app';app.mkdir();(app/'data').mkdir()
for name in ('server','scripts','docs'):
    shutil.copytree(ROOT/name,app/name,ignore=shutil.ignore_patterns('node_modules','__pycache__'))
with closing(sqlite3.connect(source)) as src,closing(sqlite3.connect(app/'data/organizador_tareas.db')) as dst:src.backup(dst)
custody=work/'custody';custody.mkdir(mode=0o700);recovered=custody/'custody.key'
fd=os.open(recovered,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'wb') as stream:stream.write(key.read_bytes())

def run(script,*params):
    result=subprocess.run([sys.executable,str(ROOT/'scripts'/script),*map(str,params)],cwd=ROOT,text=True,capture_output=True,check=True)
    return json.loads(result.stdout.strip().splitlines()[-1])

backup=run('erp0-backup.py','--app',app,'--output-root',work/'backups','--code-commit',args.commit)
restore=run('verify-erp0-backup.py',backup['backup'],'--keep','--runtime-node-modules',ROOT/'server/node_modules','--startup-timeout',30)
vault=BankVault(recovered)
with closing(connect(source,readonly=True)) as before,closing(connect(Path(restore['restore'])/'database.db',readonly=True)) as after:
    def secrets(conn):
        return {r['id']:hashlib.sha256(json.dumps(vault.get(conn,r['id_comunidad'],r['id'],r['purpose']),sort_keys=True).encode()).hexdigest()
            for r in conn.execute('SELECT * FROM erp_banca_secretos')}
    original=secrets(before);assert original and original==secrets(after)
    assert after.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not after.execute('PRAGMA foreign_key_check').fetchall()
    assert before.execute('SELECT count(*) FROM erp_banco_movimientos').fetchone()[0]==after.execute('SELECT count(*) FROM erp_banco_movimientos').fetchone()[0]
proof={'ok':True,'work':str(work),'backup':backup['backup'],'restore':restore['restore'],
    'runtime_accessible':restore['runtime_accessible'],'encrypted_records_restored':len(original),'separate_key_custody':True,
    'key_sha256':hashlib.sha256(recovered.read_bytes()).hexdigest(),'commit':args.commit,'production_modified':False}
(work/'recovery-proof.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
print(json.dumps(proof))
