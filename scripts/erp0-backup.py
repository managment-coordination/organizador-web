"""Create a consistent, checksummed application backup without stopping the service."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tarfile
import time


parser = argparse.ArgumentParser()
parser.add_argument("--app", type=Path, required=True)
parser.add_argument("--output-root", type=Path, required=True)
args = parser.parse_args()
app = args.app.resolve()
output_root = args.output_root.resolve()
database = app / "data" / "organizador_tareas.db"
if not database.is_file() or app == Path(app.anchor):
    raise SystemExit("La carpeta indicada no parece una instalacion valida.")
output_root.mkdir(parents=True, exist_ok=True)
destination = output_root / ("erp0-backup-" + time.strftime("%Y%m%d-%H%M%S"))
destination.mkdir(mode=0o700)

source = sqlite3.connect(database)
target = sqlite3.connect(destination / "database.db")
source.backup(target)
integrity = target.execute("PRAGMA integrity_check").fetchone()[0]
counts = {row[0]: target.execute(f'SELECT COUNT(*) FROM "{row[0]}"').fetchone()[0]
          for row in target.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
target.close()
source.close()
if integrity != "ok":
    raise SystemExit("La copia SQLite no supera integrity_check.")

archive = destination / "application-and-documents.tar.gz"
with tarfile.open(archive, "w:gz") as bundle:
    for root in ("server", "scripts", "docs", "web", "README.md", ".env", "data"):
        item = app / root
        if not item.exists():
            continue
        candidates = [item] if item.is_file() else item.rglob("*")
        for candidate in candidates:
            if not candidate.is_file():
                continue
            relative = candidate.relative_to(app)
            if "node_modules" in relative.parts or "__pycache__" in relative.parts:
                continue
            if str(relative).replace("\\", "/") in {
                "data/organizador_tareas.db", "data/organizador_tareas.db-wal",
                "data/organizador_tareas.db-shm",
            }:
                continue
            bundle.add(candidate, arcname=str(relative))

commit = "unknown"
try:
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=app, text=True,
                            capture_output=True, check=True).stdout.strip()
except (OSError, subprocess.CalledProcessError):
    pass
hashes = {}
for item in (destination / "database.db", archive):
    with item.open("rb") as stream:
        hashes[item.name] = hashlib.file_digest(stream, "sha256").hexdigest()
manifest = {
    "format": "erp0-backup-v1", "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "code_commit": commit, "database_integrity": integrity, "table_counts": counts,
    "sha256": hashes,
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
for item in destination.iterdir():
    if item.is_file():
        os.chmod(item, 0o600)
print(json.dumps({"ok": True, "backup": str(destination), "integrity": integrity,
                  "tables": len(counts), "code_commit": commit}))
