"""Ubuntu-only release gate. Never operates on other applications."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.request
import urllib.error

APP = Path('/home/coordinador/apps/organizador-web')
SERVICE = 'organizador-web.service'
parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('--publish', action='store_true')
parser.add_argument('--code-commit', default='')
args = parser.parse_args()
assert APP.is_dir() and args.archive.is_file()
stamp = time.strftime('%Y%m%d-%H%M%S')
stage = APP / 'backups' / ('stage-operational-' + stamp)
stage.mkdir(mode=0o700)
with tarfile.open(args.archive) as bundle:
    for entry in bundle.getmembers():
        parts = Path(entry.name).parts
        assert parts and parts[0] in {'server','scripts','docs','web','README.md'}
        assert '..' not in parts and not Path(entry.name).is_absolute()
        assert not entry.issym() and not entry.islnk()
    bundle.extractall(stage, filter='data')
subprocess.run(['npm','ci','--omit=dev','--no-audit','--no-fund'],cwd=stage/'server',check=True)
subprocess.run(['python3',str(stage/'scripts/prepare-erp3-python.py')],cwd=stage,check=True)
source_fixture=stage/'verification-source.db'
with sqlite3.connect('file:'+str(APP/'data/organizador_tareas.db')+'?mode=ro',uri=True) as source:
    with sqlite3.connect(source_fixture) as target:source.backup(target)
env = {**os.environ, 'VERIFY_SOURCE_DB':str(source_fixture), 'PYTHON_BIN':'python3'}
subprocess.run(['python3',str(stage/'scripts/verify-erp1-master-data.py'),
    str(source_fixture)],cwd=stage,env=env,check=True)
subprocess.run(['python3',str(stage/'scripts/verify-erp-ux-onboarding.py'),
    str(source_fixture)],cwd=stage,env=env,check=True)
subprocess.run(['python3',str(stage/'scripts/verify-erp2a-foundations.py'),
    str(source_fixture)],cwd=stage,env=env,check=True)
subprocess.run(['python3',str(stage/'scripts/verify-erp2b-engine.py'),
    str(source_fixture)],cwd=stage,env=env,check=True)
erp2 = subprocess.check_output(['python3',str(stage/'scripts/verify-erp2-complete.py'),
    str(source_fixture),'--keep'],cwd=stage,env=env,text=True)
print(erp2,flush=True)
fixture = Path(next(line.removeprefix('workspace=') for line in erp2.splitlines() if line.startswith('workspace='))) / 'database.db'
subprocess.run(['python3',str(stage/'scripts/verify-erp3-foundations.py'),
    str(source_fixture)],cwd=stage,env=env,check=True)
subprocess.run(['python3',str(stage/'scripts/verify-erp3-legacy.py'),
    str(source_fixture)],cwd=stage,env=env,check=True)
for script in ('verify-erp3-emission.py','verify-erp3-activation.py'):
    subprocess.run(['python3',str(stage/'scripts'/script),str(fixture)],cwd=stage,env=env,check=True)
subprocess.run(['node',str(stage/'scripts/verify-operational-release.mjs')],cwd=stage,env=env,check=True)
print(json.dumps({'staging_verified':str(stage)}),flush=True)
if not args.publish:
    raise SystemExit(0)

def checkpoint(current=False):
    command=['python3',str(stage/'scripts/erp0-backup.py'),'--app',str(APP),'--output-root',str(APP/'backups')]
    if current and args.code_commit:command += ['--code-commit',args.code_commit]
    result=json.loads(subprocess.check_output(command,text=True))
    restored=json.loads(subprocess.check_output(['python3',str(stage/'scripts/verify-erp0-backup.py'),result['backup'],
        '--keep','--runtime-node-modules',str(stage/'server/node_modules')],text=True))
    assert restored['runtime_accessible']
    return {'backup':result['backup'],'restore':restored}

def historical_signature(database):
    conn=sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True)
    try:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
        result={}
        for table in ('cf_recibos','cf_movimientos_deuda','cf_propietarios','cf_propiedades','asambleas'):
            rows=conn.execute('SELECT * FROM '+table+' ORDER BY rowid').fetchall()
            result[table]=hashlib.sha256(repr(rows).encode()).hexdigest()
        return result
    finally:conn.close()

subprocess.run(['systemctl','--user','stop',SERVICE],check=True)
backup=None
try:
    before=historical_signature(APP/'data/organizador_tareas.db')
    backup=checkpoint()
    with tarfile.open(args.archive) as bundle:
        bundle.extractall(APP,filter='data')
    # Staged dependencies have already passed the release gates, without global installation.
    shutil.copytree(stage/'server/node_modules',APP/'server/node_modules',dirs_exist_ok=True)
    shutil.copytree(stage/'server/_python_packages',APP/'server/_python_packages',dirs_exist_ok=True)
    subprocess.run(['node','--check',str(APP/'server/index.js')],check=True)
    migrated=json.loads(subprocess.check_output(['python3',str(APP/'server/access-bridge.py'),str(APP/'data/organizador_tareas.db')],
        input='{"action":"migrate"}',text=True,env=env))
    assert migrated['ok']
    assert before==historical_signature(APP/'data/organizador_tareas.db'),'Historical data changed'
except Exception:
    if backup:
        with tarfile.open(Path(backup['backup'])/'application-and-documents.tar.gz') as bundle:
            bundle.extractall(APP,filter='data')
        with sqlite3.connect(Path(backup['backup'])/'database.db') as source:
            with sqlite3.connect(APP/'data/organizador_tareas.db') as target:source.backup(target)
    raise
finally:
    subprocess.run(['systemctl','--user','start',SERVICE],check=True)

healthy=False
for _ in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8771/',timeout=3) as response:
            healthy=response.status==200
        if healthy:break
    except OSError:
        pass
    time.sleep(1)
assert healthy, 'Service health failed; inspect logs. Backup retained; no later data overwritten.'
with urllib.request.urlopen('http://127.0.0.1:8771/health',timeout=5) as response:
    assert json.load(response)['databaseConfigured']
try:
    urllib.request.urlopen('http://127.0.0.1:8771/api/erp/query?query=erp3.receipt.list&id_comunidad=1',timeout=5)
    raise AssertionError('Unauthenticated financial query was accepted')
except urllib.error.HTTPError as error:
    assert error.code==401
historical_signature(APP/'data/organizador_tareas.db')
subprocess.run(['node',str(APP/'scripts/verify-operational-release.mjs')],cwd=APP,env={**env,'VERIFY_SOURCE_DB':str(APP/'data/organizador_tareas.db')},check=True)
subprocess.run(['python3',str(APP/'scripts/verify-erp3-foundations.py'),str(APP/'data/organizador_tareas.db')],cwd=APP,env=env,check=True)
subprocess.run(['systemctl','--user','stop',SERVICE],check=True)
try:after=checkpoint(current=True)
finally:subprocess.run(['systemctl','--user','start',SERVICE],check=True)
for attempt in range(30):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8771/health',timeout=3) as response:
            assert json.load(response)['databaseConfigured']
        break
    except OSError:
        if attempt==29:raise
        time.sleep(1)
proof={'published':True,'before':backup,'after':after,'stage':str(stage),'commit':args.code_commit,
       'historical_hashes_preserved':True,'integrity':'ok','foreign_keys':'ok','unauthenticated_finance':401}
(Path(after['backup'])/'erp3-publication-proof.json').write_text(json.dumps(proof,indent=2))
print(json.dumps(proof),flush=True)
