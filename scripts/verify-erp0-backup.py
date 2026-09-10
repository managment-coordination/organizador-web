"""Restore an ERP 0 backup into an isolated directory and verify compatibility."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request


parser = argparse.ArgumentParser()
parser.add_argument("backup", type=Path)
parser.add_argument("--keep", action="store_true")
parser.add_argument("--runtime-node-modules", type=Path)
args = parser.parse_args()
backup = args.backup.resolve()
manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
if manifest.get("format") not in {None, "erp0-backup-v1"}:
    raise SystemExit("Formato de backup no compatible.")
for name, expected in manifest["sha256"].items():
    with (backup / name).open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise SystemExit(f"Checksum incorrecto: {name}")

restore = Path(tempfile.mkdtemp(prefix="organizador-erp0-restore-"))
try:
    shutil.copy2(backup / "database.db", restore / "database.db")
    with tarfile.open(backup / "application-and-documents.tar.gz", "r:gz") as bundle:
        for member in bundle.getmembers():
            target = (restore / member.name).resolve()
            if restore not in target.parents and target != restore:
                raise SystemExit("El backup contiene una ruta no segura.")
            if member.issym() or member.islnk():
                raise SystemExit("El backup contiene enlaces no admitidos.")
        bundle.extractall(restore, filter="data")
    conn = sqlite3.connect(restore / "database.db")
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    counts = {row[0]: conn.execute(f'SELECT COUNT(*) FROM "{row[0]}"').fetchone()[0]
              for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    all_table_count = conn.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
    conn.close()
    expected_counts = manifest.get("table_counts")
    counts_match = counts == expected_counts if expected_counts is not None else all_table_count == int(manifest.get("tables") or -1)
    if integrity != "ok" or not counts_match:
        raise SystemExit("La restauracion no conserva integridad y recuentos.")
    required = [restore / "server" / "index.js", restore / "server" / "access_control.py"]
    if not all(item.is_file() for item in required):
        raise SystemExit("La restauracion no contiene una version ejecutable compatible.")
    migration = subprocess.run(
        [sys.executable, str(restore / "server" / "access-bridge.py"), str(restore / "database.db")],
        input='{"action":"migrate"}', text=True, capture_output=True,
        env={**__import__("os").environ, "PYTHONPATH": str(restore / "server"), "PYTHONUTF8": "1"},
    )
    if migration.returncode or not json.loads(migration.stdout or "{}").get("ok"):
        raise SystemExit("El codigo restaurado no puede abrir/migrar la base restaurada.")
    node_check = subprocess.run(["node", "--check", str(restore / "server" / "index.js")], capture_output=True)
    if node_check.returncode:
        raise SystemExit("El servidor restaurado no supera la validacion de sintaxis.")
    accessible = False
    if args.runtime_node_modules:
        modules = args.runtime_node_modules.resolve()
        if not modules.is_dir():
            raise SystemExit("La carpeta de dependencias indicada no existe.")
        (restore / "server" / "node_modules").symlink_to(modules, target_is_directory=True)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        environment = {
            **__import__("os").environ, "PORT": str(port), "HOST": "127.0.0.1",
            "DATABASE_PATH": str(restore / "database.db"), "DATA_DIR": str(restore / "data"),
            "PYTHON_BIN": sys.executable, "AI_PROVIDER": "local", "AI_API_KEY": "",
            "NVIDIA_API_KEY": "", "OPENAI_API_KEY": "", "ERP0_REFERENCE_COMMANDS": "",
        }
        process = subprocess.Popen(["node", str(restore / "server" / "index.js")], cwd=restore,
                                   env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(60):
                if process.poll() is not None:
                    break
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                        accessible = response.status == 200 and json.load(response).get("databaseConfigured") is True
                    if accessible:
                        break
                except OSError:
                    time.sleep(0.1)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        if not accessible:
            raise SystemExit("La aplicacion restaurada no responde en el puerto aislado.")
    print(json.dumps({"ok": True, "restore": str(restore), "integrity": integrity,
                      "tables": len(counts), "code_commit": manifest.get("code_commit"),
                      "runtime_accessible": accessible}))
finally:
    if not args.keep:
        shutil.rmtree(restore)
