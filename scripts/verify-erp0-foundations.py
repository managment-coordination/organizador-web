"""Critical ERP 0 tests. Always run against an isolated database copy."""

import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from access_control import migrate, profile, save_permissions
from erp_core.contracts import CommandEnvelope, QueryEnvelope
from erp_core.audit import write_event
from erp_core.contracts import Actor
from erp_core.database import connect, write_transaction
from erp_core.dispatcher import execute_command, execute_query
from erp_core.errors import ConflictError, ContractError
from erp_core.migrations import Migration, apply_all
from erp_core.outbox import claim_pending, mark_processed


source = Path(sys.argv[1]).resolve()
if not source.is_file():
    raise SystemExit("Indica una base SQLite de origen.")
temporary = Path(tempfile.mkdtemp(prefix="organizador-erp0-foundations-"))
database = temporary / "test.db"
source_conn = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
target_conn = sqlite3.connect(database)
source_conn.backup(target_conn)
source_conn.close()
target_conn.row_factory = sqlite3.Row
before = {row[0]: target_conn.execute(f'SELECT COUNT(*) FROM "{row[0]}"').fetchone()[0]
          for row in target_conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
migrate(target_conn)
first_versions = list(target_conn.execute("SELECT version,name,checksum FROM erp_schema_migrations"))
migrate(target_conn)
assert first_versions == list(target_conn.execute("SELECT version,name,checksum FROM erp_schema_migrations"))
for table, count in before.items():
    if table not in {"web_migrations", "erp_schema_migrations"}:
        assert target_conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == count, table

with target_conn:
    suffix = str(os.getpid())
    community_a = target_conn.execute("INSERT INTO comunidades(nombre,activo) VALUES (?,1)", ("ERP0 Test A " + suffix,)).lastrowid
    community_b = target_conn.execute("INSERT INTO comunidades(nombre,activo) VALUES (?,1)", ("ERP0 Test B " + suffix,)).lastrowid
    user_id = target_conn.execute("INSERT INTO usuarios(nombre,rol,activo) VALUES (?,'Usuario',1)", ("ERP0 Worker " + suffix,)).lastrowid
    target_conn.execute("INSERT INTO usuario_comunidad(id_usuario,id_comunidad) VALUES (?,?)", (user_id, community_a))
    save_permissions(target_conn, user_id, community_a, "Usuario", {
        "puede_ver": 1, "puede_crear": 1, "puede_actualizar": 1,
        "puede_ver_documentos": 1, "puede_generar_informes": 1,
        "puede_gestionar_asambleas": 0, "puede_gestionar_seguridad": 0,
    })
session = profile(target_conn, user_id)
target_conn.close()

os.environ["ERP0_REFERENCE_COMMANDS"] = "1"
base = {
    "command": "erp0.foundation.set_status", "id_comunidad": community_a,
    "payload": {"status": "prepared"}, "idempotency_key": "erp0-test-success",
    "expected_version": 0, "reason": "Prueba estructural", "origin": "test",
}
result = execute_command(str(database), session, base)
assert result["entity"]["version"] == 1 and not result["idempotent_replay"]
replay = execute_command(str(database), session, base)
assert replay["entity"]["version"] == 1 and replay["idempotent_replay"]

try:
    execute_command(str(database), session, {**base, "payload": {"status": "verified"}})
    raise AssertionError("La reutilizacion distinta debio fallar")
except ConflictError:
    pass
try:
    execute_command(str(database), session, {**base, "idempotency_key": "stale", "payload": {"status": "verified"}})
    raise AssertionError("La version obsoleta debio fallar")
except ConflictError:
    pass
try:
    CommandEnvelope.from_value({**base, "role": "Superusuario"})
    raise AssertionError("El rol del cliente no debe aceptarse")
except ContractError:
    pass
try:
    execute_command(str(database), session, {
        **base, "id_comunidad": community_b, "idempotency_key": "forbidden",
    })
    raise AssertionError("El aislamiento de comunidad debio impedir la escritura")
except PermissionError:
    pass
try:
    execute_query(str(database), session, {
        "query": "erp0.foundation.get_status", "id_comunidad": community_b, "filters": {},
    })
    raise AssertionError("El aislamiento de comunidad debio impedir la lectura")
except PermissionError:
    pass

try:
    execute_command(str(database), session, {
        **base, "payload": {"status": "verified", "simulate_failure": True},
        "idempotency_key": "rollback", "expected_version": 1,
    })
    raise AssertionError("El fallo simulado debio propagarse")
except RuntimeError:
    pass

conn = sqlite3.connect(database)
conn.row_factory = sqlite3.Row
current = conn.execute("SELECT * FROM erp_community_foundation WHERE id_comunidad=?", (community_a,)).fetchone()
assert current["foundation_status"] == "prepared" and current["version"] == 1
assert conn.execute("SELECT COUNT(*) FROM erp_command_log WHERE idempotency_key='rollback'").fetchone()[0] == 0
assert conn.execute("SELECT COUNT(*) FROM erp_command_log WHERE idempotency_key='erp0-test-success'").fetchone()[0] == 1
assert conn.execute("SELECT COUNT(*) FROM erp_audit_events WHERE request_id='erp0-test-success'").fetchone()[0] == 1
assert conn.execute("SELECT COUNT(*) FROM erp_outbox WHERE dedupe_key='erp0-test-success'").fetchone()[0] == 1
event_id = conn.execute("SELECT event_id FROM erp_outbox WHERE dedupe_key='erp0-test-success'").fetchone()[0]
assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"

# A bad migration leaves neither its table nor its version behind.
bad = Migration(999, "failure_probe", (
    "CREATE TABLE erp0_migration_rollback_probe(id INTEGER)",
    "INSERT INTO table_that_does_not_exist VALUES (1)",
))
try:
    apply_all(conn, (bad,))
    raise AssertionError("La migracion defectuosa debio fallar")
except sqlite3.OperationalError:
    pass
assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='erp0_migration_rollback_probe'").fetchone()
assert not conn.execute("SELECT 1 FROM erp_schema_migrations WHERE version=999").fetchone()
conn.close()

safe_conn = connect(str(database))
try:
    previous_audit = safe_conn.execute("SELECT COUNT(*) FROM erp_audit_events").fetchone()[0]
    try:
        with write_transaction(safe_conn):
            write_event(
                safe_conn, community_id=community_a, actor=Actor.from_session(session),
                action="secret probe", entity_type="probe", entity_id="1",
                before=None, after={"api_key": "must-not-be-written"}, reason="",
                origin="test", request_id="secret-probe", entity_version=1,
            )
        raise AssertionError("El dato sensible debio rechazarse")
    except ValueError:
        pass
    assert safe_conn.execute("SELECT COUNT(*) FROM erp_audit_events").fetchone()[0] == previous_audit
finally:
    safe_conn.close()

claimed = claim_pending(str(database))
assert event_id in [row["event_id"] for row in claimed]
mark_processed(str(database), event_id)
conn = sqlite3.connect(database)
assert conn.execute("SELECT state FROM erp_outbox WHERE event_id=?", (event_id,)).fetchone()[0] == "processed"
conn.close()

query = execute_query(str(database), session, {
    "query": "erp0.foundation.get_status", "id_comunidad": community_a, "filters": {},
})
assert query["entity"]["version"] == 1
print(json.dumps({"ok": True, "checks": [
    "ordered reentrant migration", "community backend permission", "strict actor contract",
    "serialized transaction rollback", "idempotent replay", "optimistic version conflict",
    "structured audit atomicity", "persistent outbox claim outside business transaction", "migration rollback",
    "sensitive audit field rejection", "SQLite integrity",
], "fixture": str(temporary)}))
shutil.rmtree(temporary)
