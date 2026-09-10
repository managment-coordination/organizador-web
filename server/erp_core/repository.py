"""Repositories contain SQL; services own permissions, rules and transaction boundaries."""

import json

from .contracts import canonical_json
from .errors import ConflictError
from .migrations import utc_now


class FoundationRepository:
    def __init__(self, conn):
        self.conn = conn

    def require_active_community(self, community_id):
        row = self.conn.execute(
            "SELECT id_comunidad,nombre FROM comunidades WHERE id_comunidad=? AND activo=1",
            (community_id,),
        ).fetchone()
        if not row:
            raise ValueError("La comunidad no existe o esta inactiva.")
        return dict(row)

    def get(self, community_id):
        row = self.conn.execute(
            "SELECT * FROM erp_community_foundation WHERE id_comunidad=?", (community_id,)
        ).fetchone()
        return dict(row) if row else None

    def set_status(self, community_id, status, actor_id):
        before = self.get(community_id)
        now = utc_now()
        if before:
            self.conn.execute("""UPDATE erp_community_foundation
                SET foundation_status=?,version=version+1,updated_at_utc=?,updated_by=?
                WHERE id_comunidad=?""", (status, now, actor_id, community_id))
        else:
            self.conn.execute("""INSERT INTO erp_community_foundation
                (id_comunidad,foundation_status,version,updated_at_utc,updated_by)
                VALUES (?,?,1,?,?)""", (community_id, status, now, actor_id))
        return before, self.get(community_id)


class CommandRepository:
    def __init__(self, conn):
        self.conn = conn

    def replay_or_start(self, envelope, actor):
        if not envelope.idempotency_key:
            return None
        row = self.conn.execute("""SELECT * FROM erp_command_log
            WHERE id_comunidad=? AND command_name=? AND idempotency_key=?""",
            (envelope.community_id, envelope.command, envelope.idempotency_key)).fetchone()
        request_hash = envelope.request_hash()
        if row:
            if row["request_hash"] != request_hash:
                raise ConflictError("La clave de idempotencia ya se uso con otro contenido.")
            if row["status"] != "completed" or not row["response_json"]:
                raise ConflictError("El comando con esa clave sigue en proceso.")
            result = json.loads(row["response_json"])
            result["idempotent_replay"] = True
            return result
        self.conn.execute("""INSERT INTO erp_command_log
            (id_comunidad,command_name,idempotency_key,request_hash,status,actor_id,
             actor_snapshot,origin,created_at_utc)
            VALUES (?,?,?,?,?,?,?,?,?)""",
            (envelope.community_id, envelope.command, envelope.idempotency_key,
             request_hash, "processing", actor.user_id, actor.name, envelope.origin, utc_now()))
        return None

    def complete(self, envelope, response):
        if not envelope.idempotency_key:
            return
        self.conn.execute("""UPDATE erp_command_log SET status='completed',response_json=?,completed_at_utc=?
            WHERE id_comunidad=? AND command_name=? AND idempotency_key=?""",
            (canonical_json(response), utc_now(), envelope.community_id,
             envelope.command, envelope.idempotency_key))
