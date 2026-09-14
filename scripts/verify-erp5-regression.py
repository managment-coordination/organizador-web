"""Independent migration evidence and the existing certified regression suites."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))
from erp_core.database import connect
from erp_core.migrations import apply_all

parser=argparse.ArgumentParser();parser.add_argument('source',type=Path);parser.add_argument('--migration-only',action='store_true');args=parser.parse_args()
work=Path(tempfile.mkdtemp(prefix='organizador-erp5-regression-'));db=work/'migration.db'
with closing(sqlite3.connect('file:'+str(args.source.resolve())+'?mode=ro',uri=True)) as source,closing(sqlite3.connect(db)) as target:source.backup(target)

def signature(conn):
    result={}
    for table, in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        if table=='erp_schema_migrations':continue
        rows=sorted(json.dumps(list(r),ensure_ascii=False,default=str,separators=(',',':')) for r in conn.execute('SELECT * FROM "'+table.replace('"','""')+'"'))
        result[table]=hashlib.sha256('\n'.join(rows).encode()).hexdigest()
    return result

with closing(connect(db)) as conn:
    before=signature(conn);apply_all(conn);after=signature(conn)
    assert all(after.get(t)==h for t,h in before.items()),'Existing table changed during migration'
    assert conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not conn.execute('PRAGMA foreign_key_check').fetchall()
print(json.dumps({'workspace':str(work),'migration_existing_tables_unchanged':len(before)}),flush=True)
if args.migration_only:
    (work/'migration-proof.json').write_text(json.dumps({'ok':True,'existing_tables':before,'integrity':'ok','foreign_key_errors':0}),encoding='utf8')
    raise SystemExit(0)
results=[]
suite=[('verify-erp5-adapters.py',[]),('verify-erp0-foundations.py',[str(db)]),('verify-erp1-master-data.py',[str(db)]),
       ('verify-erp2-complete.py',[str(db),'--keep']),('verify-erp2b-engine.py',[str(db)]),
       ('verify-erp3-foundations.py',[str(db)]),('verify-erp4-adapter.py',[]),('verify-erp4-foundations.py',[str(db)])]
for script,params in suite:
    print('BEGIN '+script,flush=True)
    result=subprocess.run([sys.executable,str(ROOT/'scripts'/script),*params],cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (work/(script+'.log')).write_text(result.stdout,encoding='utf8');print(result.stdout,flush=True)
    results.append({'script':script,'exit_code':result.returncode})
    if result.returncode:
        (work/'results.json').write_text(json.dumps(results),encoding='utf8');raise SystemExit(result.returncode)
    if script=='verify-erp2-complete.py':
        fixture=Path(next(x.removeprefix('workspace=') for x in result.stdout.splitlines() if x.startswith('workspace=')))/'database.db'
        extra=subprocess.run([sys.executable,str(ROOT/'scripts/verify-quota-plans.py'),str(fixture)],cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (work/'verify-quota-plans.py.log').write_text(extra.stdout,encoding='utf8');print(extra.stdout,flush=True)
        results.append({'script':'verify-quota-plans.py','exit_code':extra.returncode})
        if extra.returncode:raise SystemExit(extra.returncode)
for script in ('verify-erp4-http.mjs','verify-erp4-ui-state.mjs','verify-erp5-ui-state.mjs'):
    subprocess.run(['node',str(ROOT/'scripts'/script)],cwd=ROOT,check=True)
(work/'results.json').write_text(json.dumps(results),encoding='utf8')
print(json.dumps({'regression_passed':True,'workspace':str(work),'suites':results}),flush=True)
