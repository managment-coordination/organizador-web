"""Reference command proving the complete ERP 0 write path."""

import uuid

from access_control import require_permission

from .audit import write_event
from .contracts import Actor
from .database import connect, write_transaction
from .errors import ConflictError
from .outbox import enqueue
from .repository import CommandRepository, FoundationRepository


class FoundationService:
    def __init__(self, database_path):
        self.database_path = database_path

    def set_status(self, session, envelope):
        actor = Actor.from_session(session)
        require_permission(session, envelope.community_id, "puede_actualizar")
        status = str(envelope.payload.get("status") or "").strip().lower()
        unknown = set(envelope.payload) - {"status", "simulate_failure"}
        if unknown or status not in {"prepared", "verified"}:
            raise ValueError("El estado de fundamento ERP no es valido.")
        request_id = envelope.idempotency_key or str(uuid.uuid4())
        conn = connect(self.database_path)
        try:
            with write_transaction(conn):
                repo = FoundationRepository(conn)
                repo.require_active_community(envelope.community_id)
                commands = CommandRepository(conn)
                replay = commands.replay_or_start(envelope, actor)
                if replay is not None:
                    return replay
                current = repo.get(envelope.community_id)
                current_version = int(current["version"]) if current else 0
                if envelope.expected_version is not None and envelope.expected_version != current_version:
                    raise ConflictError(
                        f"Conflicto de version: esperada {envelope.expected_version}, actual {current_version}. Relee antes de confirmar."
                    )
                before, after = repo.set_status(envelope.community_id, status, actor.user_id)
                if envelope.payload.get("simulate_failure"):
                    raise RuntimeError("Fallo simulado despues de la escritura.")
                event_id = write_event(
                    conn, community_id=envelope.community_id, actor=actor,
                    action="ERP0 foundation status updated", entity_type="erp_community_foundation",
                    entity_id=envelope.community_id, before=before, after=after,
                    reason=envelope.reason, origin=envelope.origin, request_id=request_id,
                    entity_version=after["version"], evidence=envelope.evidence,
                    metadata={"contract": "erp_command_v1"},
                )
                outbox_id = enqueue(
                    conn, community_id=envelope.community_id,
                    event_type="erp0.foundation.status_changed",
                    aggregate_type="erp_community_foundation",
                    aggregate_id=envelope.community_id,
                    payload={"id_comunidad": envelope.community_id, "status": status,
                             "version": after["version"], "audit_event_id": event_id},
                    dedupe_key=request_id,
                )
                response = {"ok": True, "command": envelope.command,
                            "entity": after, "audit_event_id": event_id,
                            "outbox_event_id": outbox_id, "idempotent_replay": False}
                commands.complete(envelope, response)
                return response
        finally:
            conn.close()

    def get_status(self, session, query):
        Actor.from_session(session)
        require_permission(session, query.community_id, "puede_ver")
        conn = connect(self.database_path, readonly=True)
        try:
            FoundationRepository(conn).require_active_community(query.community_id)
            return {"ok": True, "query": query.query,
                    "entity": FoundationRepository(conn).get(query.community_id)}
        finally:
            conn.close()
