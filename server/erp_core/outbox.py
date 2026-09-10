"""Persistent events; external calls are intentionally outside business transactions."""

import uuid
import re
import json

from .audit import _assert_safe
from .contracts import canonical_json
from .database import connect, write_transaction
from .migrations import utc_now


def enqueue(conn, *, community_id, event_type, aggregate_type, aggregate_id,
            payload, dedupe_key):
    _assert_safe(payload, "outbox")
    event_id = str(uuid.uuid4())
    now = utc_now()
    conn.execute("""INSERT INTO erp_outbox
        (event_id,id_comunidad,event_type,aggregate_type,aggregate_id,payload_json,
         dedupe_key,state,attempts,available_at_utc,created_at_utc)
        VALUES (?,?,?,?,?,?,?,'pending',0,?,?)""",
        (event_id, community_id, event_type, aggregate_type,
         None if aggregate_id is None else str(aggregate_id), canonical_json(payload),
         dedupe_key, now, now))
    return event_id


def claim_pending(database_path, limit=25):
    """Claim quickly, then close the transaction before any external call."""
    limit = max(1, min(int(limit), 100))
    conn = connect(database_path)
    try:
        with write_transaction(conn):
            rows = conn.execute("""SELECT * FROM erp_outbox
                WHERE state IN ('pending','failed') AND available_at_utc<=?
                ORDER BY id_outbox LIMIT ?""", (utc_now(), limit)).fetchall()
            ids = [int(row["id_outbox"]) for row in rows]
            if ids:
                placeholders = ",".join("?" for _ in ids)
                conn.execute(f"""UPDATE erp_outbox SET state='processing',attempts=attempts+1
                    WHERE id_outbox IN ({placeholders})""", ids)
            return [{**dict(row), "payload": json.loads(row["payload_json"])} for row in rows]
    finally:
        conn.close()


def mark_processed(database_path, event_id):
    conn = connect(database_path)
    try:
        with write_transaction(conn):
            changed = conn.execute("""UPDATE erp_outbox
                SET state='processed',processed_at_utc=?,last_error=NULL
                WHERE event_id=? AND state='processing'""", (utc_now(), event_id)).rowcount
            if changed != 1:
                raise ValueError("El evento outbox no esta reclamado o no existe.")
    finally:
        conn.close()


def mark_failed(database_path, event_id, error_code, available_at_utc):
    """Store only a controlled code. Raw provider errors may contain credentials."""
    error_code = str(error_code or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,120}", error_code):
        raise ValueError("El codigo de error outbox no es seguro.")
    conn = connect(database_path)
    try:
        with write_transaction(conn):
            changed = conn.execute("""UPDATE erp_outbox
                SET state='failed',last_error=?,available_at_utc=?
                WHERE event_id=? AND state='processing'""",
                (error_code, str(available_at_utc), event_id)).rowcount
            if changed != 1:
                raise ValueError("El evento outbox no esta reclamado o no existe.")
    finally:
        conn.close()
