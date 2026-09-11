"""Recover an isolated ERP 4 checkpoint, keeping key custody outside the app backup."""

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
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('fixture', type=Path)
parser.add_argument('--key-file', type=Path, required=True)
parser.add_argument('--output-root', type=Path, required=True)
args = parser.parse_args()
source = args.fixture.resolve(strict=True)
if not source.parent.parent.name.startswith('organizador-erp4-foundations-'):
    raise SystemExit('Se requiere una copia aislada de pruebas ERP 4, no datos productivos.')
key_source = args.key_file.resolve(strict=True)
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
work = Path(tempfile.mkdtemp(prefix='erp4-checkpoint-build-'))
custody = Path(tempfile.mkdtemp(prefix='erp4-checkpoint-custody-'))
archive = work / 'checkpoint.tar'
subprocess.run(['git', 'archive', '--format=tar', '--output=' + str(archive), commit], cwd=ROOT, check=True)
app = work / 'app'
app.mkdir()
with tarfile.open(archive) as bundle:
    bundle.extractall(app, filter='data')
(app / 'data').mkdir(exist_ok=True)
with closing(sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True)) as src:
    with closing(sqlite3.connect(app / 'data' / 'organizador_tareas.db')) as dst:
        src.backup(dst)
key_backup = custody / 'custody.key'
fd = os.open(key_backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'wb') as target, key_source.open('rb') as original:
    shutil.copyfileobj(original, target)
created = json.loads(subprocess.check_output([sys.executable, str(ROOT / 'scripts/erp0-backup.py'), '--app', str(app),
    '--output-root', str(args.output_root.resolve()), '--code-commit', commit], text=True))
restored = json.loads(subprocess.check_output([sys.executable, str(ROOT / 'scripts/verify-erp0-backup.py'), created['backup'], '--keep'], text=True))
adapter_test = Path(restored['restore']) / 'scripts' / 'verify-erp4-adapter.py'
adapter_verified = False
if adapter_test.exists():
    validation = subprocess.run([sys.executable, str(adapter_test)], capture_output=True, text=True)
    if validation.returncode:
        raise SystemExit('Fallo de validacion del adaptador restaurado: ' + validation.stderr)
    adapter_verified = True
sys.path.insert(0, str(Path(restored['restore']) / 'server'))
from erp_core.banking_crypto import BankVault
from erp_core.database import connect


def signature(path, vault):
    conn = connect(path, readonly=True)
    try:
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
        tables = {}
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
            name = row[0]
            quoted = '"' + name.replace('"', '""') + '"'
            tables[name] = hashlib.sha256(repr([tuple(r) for r in conn.execute('SELECT * FROM ' + quoted + ' ORDER BY rowid')]).encode()).hexdigest()
        decrypted = []
        for row in conn.execute('SELECT id,id_comunidad,purpose FROM erp_banca_secretos ORDER BY id'):
            value = vault.get(conn, row['id_comunidad'], row['id'], row['purpose'])
            decrypted.append(hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest())
        return tables, decrypted
    finally:
        conn.close()


before = signature(source, BankVault(key_source))
after = signature(Path(restored['restore']) / 'database.db', BankVault(key_backup))
assert before == after, 'No coinciden la base o los secretos recuperados.'
assert before[1], 'El fixture debe contener datos bancarios sinteticos cifrados.'
with tarfile.open(Path(created['backup']) / 'application-and-documents.tar.gz') as bundle:
    assert not any('custody.key' in m.name or 'test-custody.key' in m.name for m in bundle.getmembers())
proof = {'ok': True, 'synthetic_only': True, 'production_bank_activation': False, 'commit': commit,
         'backup': created['backup'], 'restore': restored['restore'], 'separate_custody': str(custody),
         'tables': len(before[0]), 'all_table_hashes_identical': True, 'decrypted_values_identical': True,
         'keys_excluded_from_application_archive': True, 'restored_adapter_tests_passed': adapter_verified}
(Path(created['backup']) / 'erp4-restore-proof.json').write_text(json.dumps(proof, indent=2), encoding='utf-8')
print(json.dumps(proof))
