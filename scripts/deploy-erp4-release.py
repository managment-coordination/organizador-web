"""Scoped ERP4 release gate; existing ERP0 backup and restoration stay authoritative."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request
import urllib.error

APP=Path('/home/coordinador/apps/organizador-web')
SERVICE='organizador-web.service'
parser=argparse.ArgumentParser()
parser.add_argument('archive',type=Path)
parser.add_argument('--commit',required=True)
parser.add_argument('--bank-python',type=Path,required=True)
parser.add_argument('--recovery-key-sha256',required=True)
parser.add_argument('--publish',action='store_true')
parser.add_argument('--quota-plans',action='store_true',help='Verify the additive ERP 2/3 active-plan extension.')
parser.add_argument('--full-bank-regression',action='store_true',help='Run every ERP 4 case, rather than the critical economic regression gate.')
parser.add_argument('--validated-stage',type=Path,help='Reuse the explicitly verified domain gate from a previous attempt; only banking UI/docs/test tooling may differ.')
args=parser.parse_args()
assert os.name=='posix' and Path.home()==Path('/home/coordinador') and APP.is_dir()
assert re.fullmatch('[0-9a-f]{40}',args.commit)
runtime=args.bank_python.absolute()
assert runtime==Path('/home/coordinador/.local/share/organizador-web/erp4-runtime/bin/python') and runtime.is_file()
key=Path.home()/'.config/organizador-web/erp4-keys.json'
assert hashlib.sha256(key.read_bytes()).hexdigest()==args.recovery_key_sha256
assert not key.is_symlink() and not key.stat().st_mode&0o077
stage=APP/'backups'/('stage-erp4-'+time.strftime('%Y%m%d-%H%M%S'))
stage.mkdir(mode=0o700)
with tarfile.open(args.archive) as bundle:
    for member in bundle.getmembers():
        parts=Path(member.name).parts
        assert parts and parts[0] in {'server','scripts','docs','web','README.md'}
        assert not Path(member.name).is_absolute() and '..' not in parts
        assert not member.issym() and not member.islnk()
    bundle.extractall(stage,filter='data')
if args.validated_stage:
    prior=args.validated_stage.resolve(strict=True)
    assert prior.parent==APP/'backups' and prior.name.startswith('stage-erp4-') and (prior/'source.db').is_file()
    def domain_files(folder):
        ui_names={'banking-ui.js','receivables-ui.js'} if args.quota_plans else {'banking-ui.js'}
        return {str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.rglob('*') if p.is_file()
            and not any(x in p.relative_to(folder).parts for x in ('node_modules','_python_packages','__pycache__')) and p.name not in ui_names}
    assert domain_files(stage/'server')==domain_files(prior/'server'),'Domain changed: run the complete gate again'
    shutil.copytree(prior/'server/node_modules',stage/'server/node_modules')
else:subprocess.run(['npm','ci','--omit=dev','--no-audit','--no-fund'],cwd=stage/'server',check=True)
if (APP/'server/_python_packages').exists():shutil.copytree(APP/'server/_python_packages',stage/'server/_python_packages')
env={**os.environ,'PYTHONUTF8':'1','PYTHON_BIN':str(runtime),'ERP4_BANKING_ENABLED':'0','ERP4_HTTPS_READY':'0','ERP4_LIVE_BANKING_ENABLED':'0'}
scratch=stage/'verification';scratch.mkdir(mode=0o700);env['TMPDIR']=str(scratch)
source=stage/'source.db'
with closing(sqlite3.connect('file:'+str(APP/'data/organizador_tareas.db')+'?mode=ro',uri=True)) as src,closing(sqlite3.connect(source)) as dst:src.backup(dst)

def signature(database):
    with closing(sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True)) as conn:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
        return {table:hashlib.sha256(repr(conn.execute('SELECT * FROM "'+table+'" ORDER BY rowid').fetchall()).encode()).hexdigest()
            for (table,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('erp_schema_migrations','web_migrations')")}

def migrate(database):
    result=json.loads(subprocess.check_output([str(runtime),str(stage/'server/access-bridge.py'),str(database)],
        input='{"action":"migrate"}',text=True,env=env))
    assert result['ok']

before=signature(source);migrate(source);after=signature(source)
assert all(after[t]==value for t,value in before.items()),'Migration changed existing business data'
for script,parameters in (
    ('verify-erp4-adapter.py',[]),
    ('verify-erp0-foundations.py',[str(source)]),('verify-erp1-master-data.py',[str(source)]),
    ('verify-erp2-complete.py',[str(source)]),('verify-erp3-foundations.py',[str(source)]),
    ('verify-erp4-foundations.py',[str(source),'BankingTests.test_36_settlement_uses_erp3_and_replay_is_safe',
        'BankingTests.test_39_return_uses_erp3_once','BankingTests.test_42_failure_after_erp3_rolls_back_everything',
        'BankingTests.test_82_bank_documents_reuse_catalogue_without_plaintext_or_generic_path',
        'BankingTests.test_83_bulk_200_domain_notifications_and_result_confirmation',
        'BankingTests.test_86_bank_partial_return_and_locked_exercise_keep_economic_boundary'])):
    if not args.validated_stage:
        if args.quota_plans and script=='verify-erp2-complete.py':
            report=subprocess.check_output([str(runtime),str(stage/'scripts'/script),*parameters,'--keep'],cwd=stage,env=env,text=True)
            print(report,flush=True)
            fixture=Path(next(line.removeprefix('workspace=') for line in report.splitlines() if line.startswith('workspace=')))/'database.db'
            subprocess.run([str(runtime),str(stage/'scripts/verify-quota-plans.py'),str(fixture)],cwd=stage,env=env,check=True)
            subprocess.run([str(runtime),str(stage/'scripts/verify-erp2b-engine.py'),str(source)],cwd=stage,env=env,check=True)
        else:
            if args.full_bank_regression and script=='verify-erp4-foundations.py':parameters=[str(source)]
            subprocess.run([str(runtime),str(stage/'scripts'/script),*parameters],cwd=stage,env=env,check=True)
subprocess.run(['node',str(stage/'scripts/verify-erp4-http.mjs')],cwd=stage,check=True)
print(json.dumps({'stage_validated':str(stage),'migration_preserves_existing_tables':len(before)}),flush=True)
if not args.publish:raise SystemExit(0)

def checkpoint(commit=None):
    command=[str(runtime),str(stage/'scripts/erp0-backup.py'),'--app',str(APP),'--output-root',str(APP/'backups')]
    if commit:command+=['--code-commit',commit]
    result=json.loads(subprocess.check_output(command,text=True,env=env))
    restored=json.loads(subprocess.check_output([str(runtime),str(stage/'scripts/verify-erp0-backup.py'),result['backup'],
        '--keep','--startup-timeout','60','--runtime-node-modules',str(stage/'server/node_modules')],text=True,env=env))
    assert restored['runtime_accessible']
    assert signature(Path(result['backup'])/'database.db')==signature(Path(restored['restore'])/'database.db')
    return {'backup':result['backup'],'restore':restored}

backup=None
subprocess.run(['systemctl','--user','stop',SERVICE],check=True)
try:
    original=signature(APP/'data/organizador_tareas.db');backup=checkpoint()
    with tarfile.open(args.archive) as bundle:bundle.extractall(APP,filter='data')
    shutil.copytree(stage/'server/node_modules',APP/'server/node_modules',dirs_exist_ok=True)
    config=APP/'.env';content=config.read_text() if config.exists() else ''
    settings={'ERP4_BANKING_ENABLED':'0','ERP4_LIVE_BANKING_ENABLED':'0','ERP4_HTTPS_READY':'0',
        'ERP4_KEY_FILE':str(key),'ERP4_PYTHON_BIN':str(args.bank_python)}
    lines=[line for line in content.splitlines() if line.partition('=')[0].strip() not in settings]
    temporary=APP/'.env.erp4-pending'
    with os.fdopen(os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:
        f.write('\n'.join(lines+[k+'='+v for k,v in settings.items()])+'\n')
    temporary.replace(config)
    migrate(APP/'data/organizador_tareas.db')
    migrated=signature(APP/'data/organizador_tareas.db')
    assert all(migrated[t]==value for t,value in original.items()),'Existing data changed during publication'
except Exception:
    if backup:
        with tarfile.open(Path(backup['backup'])/'application-and-documents.tar.gz') as bundle:bundle.extractall(APP,filter='data')
        with closing(sqlite3.connect(Path(backup['backup'])/'database.db')) as src,closing(sqlite3.connect(APP/'data/organizador_tareas.db')) as dst:src.backup(dst)
    raise
finally:subprocess.run(['systemctl','--user','start',SERVICE],check=True)

for attempt in range(40):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8771/health',timeout=3) as response:assert json.load(response)['databaseConfigured']
        break
    except OSError:
        if attempt==39:raise
        time.sleep(1)
with urllib.request.urlopen('http://127.0.0.1:8771/',timeout=5) as response:
    assert b'createBankingUI' in response.read()
for route in ('/api/erp/banking/status','/api/erp/query?query=erp3.receipt.list&id_comunidad=1'):
    try:
        urllib.request.urlopen('http://127.0.0.1:8771'+route,timeout=5)
        raise AssertionError('Unauthenticated operation accepted')
    except urllib.error.HTTPError as error:assert error.code==401
signature(APP/'data/organizador_tareas.db')
final=checkpoint(args.commit)
proof={'published':True,'commit':args.commit,'before':backup,'after':final,'stage':str(stage),
    'integrity':'ok','foreign_keys':'ok','historical_data_preserved':True,'banking_enabled':False,'live_enabled':False,
    'custody_key_sha256':args.recovery_key_sha256,'https_activation_pending':True}
if args.quota_plans:proof['active_quota_plans']=True
(Path(final['backup'])/'erp4-publication-proof.json').write_text(json.dumps(proof,indent=2))
print(json.dumps(proof),flush=True)
