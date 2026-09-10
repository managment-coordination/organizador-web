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

APP = Path('/home/coordinador/apps/organizador-web')
SERVICE = 'organizador-web.service'
parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('--publish', action='store_true')
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
(stage/'server/node_modules').symlink_to(APP/'server/node_modules', target_is_directory=True)
env = {**os.environ, 'VERIFY_SOURCE_DB':str(APP/'data/organizador_tareas.db'), 'PYTHON_BIN':'python3'}
subprocess.run(['python3',str(stage/'scripts/verify-erp1-master-data.py'),
    str(APP/'data/organizador_tareas.db')],cwd=stage,env=env,check=True)
subprocess.run(['python3',str(stage/'scripts/verify-erp2a-foundations.py'),
    str(APP/'data/organizador_tareas.db')],cwd=stage,env=env,check=True)
subprocess.run(['python3',str(stage/'scripts/verify-erp2b-engine.py'),
    str(APP/'data/organizador_tareas.db')],cwd=stage,env=env,check=True)
subprocess.run(['python3',str(stage/'scripts/verify-erp2-complete.py'),
    str(APP/'data/organizador_tareas.db')],cwd=stage,env=env,check=True)
subprocess.run(['node',str(stage/'scripts/verify-operational-release.mjs')],cwd=stage,env=env,check=True)
print(json.dumps({'staging_verified':str(stage)}),flush=True)
if not args.publish:
    raise SystemExit(0)

backup = APP/'backups'/('before-operational-publish-'+stamp)
backup.mkdir(mode=0o700)
subprocess.run(['systemctl','--user','stop',SERVICE],check=True)
try:
    source=sqlite3.connect(APP/'data/organizador_tareas.db')
    target=sqlite3.connect(backup/'database.db')
    source.backup(target)
    assert target.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    target.close()
    source.close()
    subprocess.run(['tar','-czf',str(backup/'application-and-documents.tar.gz'),
        '--exclude=server/node_modules','--exclude=__pycache__',
        '--exclude=data/organizador_tareas.db','--exclude=data/organizador_tareas.db-wal',
        '--exclude=data/organizador_tareas.db-shm',
        'server','scripts','docs','web','README.md','.env','data'],cwd=APP,check=True)
    hashes={p.name:hashlib.file_digest(p.open('rb'),'sha256').hexdigest() for p in backup.iterdir() if p.is_file()}
    (backup/'SHA256SUMS.json').write_text(json.dumps(hashes,indent=2))
    with tarfile.open(args.archive) as bundle:
        bundle.extractall(APP,filter='data')
    subprocess.run(['node','--check',str(APP/'server/index.js')],check=True)
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
print(json.dumps({'published':healthy,'backup':str(backup),'stage':str(stage)}),flush=True)
assert healthy, 'Service health failed; inspect logs. Backup retained; no later data overwritten.'
