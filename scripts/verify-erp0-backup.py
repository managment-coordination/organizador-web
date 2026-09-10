"""Restore an ERP 0 backup into an isolated directory and verify compatibility."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import tarfile
import tempfile


parser = argparse.ArgumentParser()
parser.add_argument("backup", type=Path)
parser.add_argument("--keep", action="store_true")
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
    print(json.dumps({"ok": True, "restore": str(restore), "integrity": integrity,
                      "tables": len(counts), "code_commit": manifest.get("code_commit")}))
finally:
    if not args.keep:
        shutil.rmtree(restore)
