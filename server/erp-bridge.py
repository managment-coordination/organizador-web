"""Process boundary for the internal ERP contracts."""

import json
import sqlite3
import sys

from erp_core.dispatcher import catalog, execute_command, execute_query
from erp_core.migrations import apply_all


def main():
    request = json.load(sys.stdin)
    action = str(request.get("action") or "")
    database_path = sys.argv[1]
    if action == "migrate":
        conn = sqlite3.connect(database_path, timeout=30, isolation_level=None)
        try:
            return {"ok": True, **apply_all(conn)}
        finally:
            conn.close()
    if action == "catalog":
        return {"ok": True, **catalog()}
    if action == "command":
        return execute_command(database_path, request.get("session"), request.get("envelope"))
    if action == "query":
        return execute_query(database_path, request.get("session"), request.get("envelope"))
    raise ValueError("Operacion ERP interna no admitida.")


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"error": str(exc), "error_type": type(exc).__name__}, ensure_ascii=False))
    sys.exit(1)
