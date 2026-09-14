"""Reuse the guarded full-application gateway on a synthetic ERP 5 acceptance copy."""
from contextlib import closing
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
source=Path(sys.argv[1]).resolve(strict=True)
runtime=Path(sys.argv[2]).resolve(strict=True)
if os.name!='posix':raise SystemExit('The full-shell fixture requires isolated Linux storage.')
sys.path.insert(0,str(ROOT/'server'))
sys.argv=[sys.argv[0],str(source)]
tests=runpy.run_path(str(ROOT/'scripts/verify-erp5-foundations.py'))
fixture=tests['ReconciliationTests']('test_01_migration_reentrant_history')
fixture._testMethodName='shell';fixture.setUp()
from erp_core.banking_service import BankingService
bank=BankingService(fixture.db,vault=fixture.vault)
for cap in ('read_masked','results','export','reveal'):
    bank.permissions_save(fixture.session,fixture.e4('permissions.save',{'user_id':fixture.uid,'capability':cap,'allowed':True},0))
mid=fixture.imported([fixture.row()])[0]
collection=fixture.collection()
fixture.match([{'movement_id':mid,'action':'link_collection','fact_id':collection,'amount_cents':'10000'}])
config={'session':fixture.session,'community':fixture.community,'account':fixture.account,'movement_id':mid,'collection_id':collection}
fixture.conn.close()
base=Path(tempfile.mkdtemp(prefix='organizador-web-erp4-validation-'));base.chmod(0o700)
app=base/'app';app.mkdir()
for name in ('server','scripts','docs'):
    shutil.copytree(ROOT/name,app/name,ignore=shutil.ignore_patterns('node_modules','__pycache__','*.pyc'))
(app/'server/node_modules').symlink_to((ROOT/'server/node_modules').resolve(),target_is_directory=True)
(base/'runtime').symlink_to(runtime,target_is_directory=True)
shutil.copyfile(fixture.db,base/'database.db')
shutil.copyfile(fixture.work/'custody.key',base/'test-custody.key')
(base/'browser-fixture.json').write_text(json.dumps(config))
prepared=subprocess.run([str(runtime/'bin/python'),str(app/'scripts/verify-erp4-linux.py'),str(base)],capture_output=True,text=True)
if prepared.returncode:raise RuntimeError(prepared.stdout+prepared.stderr)
(base/'erp5-shell.json').write_text(json.dumps(config))
print(json.dumps({'ok':True,'base':str(base),'community':fixture.community,'account':fixture.account,'production_modified':False}))
