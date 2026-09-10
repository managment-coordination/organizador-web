"""Structured audit written in the same transaction as the business change."""

import json
import uuid

from .contracts import canonical_json
from .migrations import utc_now


SENSITIVE_KEYS = {"password", "password_hash", "token", "secret", "api_key", "clave_temporal", "iban"}


def _assert_safe(value, path="value"):
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in SENSITIVE_KEYS:
                raise ValueError(f"El campo sensible {path}.{key} no puede registrarse en auditoria.")
            _assert_safe(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _assert_safe(child, f"{path}[{index}]")


def write_event(conn, *, community_id, actor, action, entity_type, entity_id,
                before, after, reason, origin, request_id, entity_version,
                evidence=None, metadata=None):
    for value in (before, after, metadata):
        _assert_safe(value)
    event_id = str(uuid.uuid4())
    occurred = utc_now()
    before_json = None if before is None else canonical_json(before)
    after_json = None if after is None else canonical_json(after)
    metadata_json = None if metadata is None else canonical_json(metadata)
    evidence_type = evidence.entity_type if evidence else None
    evidence_id = evidence.entity_id if evidence else None
    conn.execute("""INSERT INTO erp_audit_events
        (event_id,id_comunidad,actor_id,actor_snapshot,action,entity_type,entity_id,
         before_json,after_json,reason,origin,request_id,entity_version,occurred_at_utc,
         evidence_type,evidence_id,metadata_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (event_id, community_id, actor.user_id, actor.name, action, entity_type,
         None if entity_id is None else str(entity_id), before_json, after_json,
         reason or None, origin, request_id, entity_version, occurred,
         evidence_type, evidence_id, metadata_json))
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='auditoria'").fetchone():
        detail = canonical_json({
            "erp_event_id": event_id, "request_id": request_id,
            "id_comunidad": community_id, "version": entity_version,
        })
        conn.execute("""INSERT INTO auditoria
            (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle)
            VALUES (?,?,?,?,?,?,?)""",
            (occurred, actor.name, origin, action, entity_type,
             int(entity_id) if str(entity_id or "").isdigit() else None, detail))
    return event_id
