"""Ordered, checksummed and transactional migrations for ERP foundations."""

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    statements: tuple[str, ...]

    @property
    def checksum(self):
        source = f"{self.version}:{self.name}\n" + "\n".join(self.statements)
        return hashlib.sha256(source.encode("utf-8")).hexdigest()


MIGRATIONS = (
    Migration(1, "erp0_foundations", (
        """CREATE TABLE IF NOT EXISTS erp_command_log (
            id_command INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            command_name TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('processing','completed')),
            response_json TEXT,
            actor_id INTEGER NOT NULL,
            actor_snapshot TEXT NOT NULL,
            origin TEXT NOT NULL,
            created_at_utc TEXT NOT NULL,
            completed_at_utc TEXT,
            UNIQUE(id_comunidad, command_name, idempotency_key),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(actor_id) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_audit_events (
            id_audit_event INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            id_comunidad INTEGER NOT NULL,
            actor_id INTEGER NOT NULL,
            actor_snapshot TEXT NOT NULL,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            before_json TEXT,
            after_json TEXT,
            reason TEXT,
            origin TEXT NOT NULL,
            request_id TEXT NOT NULL,
            entity_version INTEGER,
            occurred_at_utc TEXT NOT NULL,
            evidence_type TEXT,
            evidence_id TEXT,
            metadata_json TEXT,
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(actor_id) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_outbox (
            id_outbox INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            id_comunidad INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            aggregate_type TEXT NOT NULL,
            aggregate_id TEXT,
            payload_json TEXT NOT NULL,
            dedupe_key TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','processed','failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            available_at_utc TEXT NOT NULL,
            created_at_utc TEXT NOT NULL,
            processed_at_utc TEXT,
            last_error TEXT,
            UNIQUE(id_comunidad, event_type, dedupe_key),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_community_foundation (
            id_comunidad INTEGER PRIMARY KEY,
            foundation_status TEXT NOT NULL CHECK(foundation_status IN ('prepared','verified')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            updated_at_utc TEXT NOT NULL,
            updated_by INTEGER NOT NULL,
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(updated_by) REFERENCES usuarios(id_usuario)
        )""",
        "CREATE INDEX IF NOT EXISTS idx_erp_audit_community_entity ON erp_audit_events(id_comunidad,entity_type,entity_id,occurred_at_utc)",
        "CREATE INDEX IF NOT EXISTS idx_erp_audit_request ON erp_audit_events(request_id)",
        "CREATE INDEX IF NOT EXISTS idx_erp_outbox_pending ON erp_outbox(state,available_at_utc,id_outbox)",
        "CREATE INDEX IF NOT EXISTS idx_erp_command_actor ON erp_command_log(actor_id,created_at_utc)",
    )),
)


def _bootstrap(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS erp_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at_utc TEXT NOT NULL
    )""")


def apply_all(conn, migrations=MIGRATIONS):
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    _bootstrap(conn)
    applied = {int(row[0]): (row[1], row[2]) for row in conn.execute(
        "SELECT version,name,checksum FROM erp_schema_migrations"
    )}
    last = 0
    for migration in migrations:
        if migration.version <= last:
            raise RuntimeError("Las migraciones ERP no tienen un orden creciente unico.")
        last = migration.version
        previous = applied.get(migration.version)
        if previous:
            if previous != (migration.name, migration.checksum):
                raise RuntimeError(f"La migracion ERP {migration.version} no coincide con la aplicada.")
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in migration.statements:
                conn.execute(statement)
            conn.execute(
                "INSERT INTO erp_schema_migrations(version,name,checksum,applied_at_utc) VALUES (?,?,?,?)",
                (migration.version, migration.name, migration.checksum, utc_now()),
            )
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()
    return {"schema_version": max(applied.keys() | {m.version for m in migrations}, default=0)}
