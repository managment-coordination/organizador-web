"""Operational evidence which never substitutes the ERP 3 economic ledger."""

from .banking_schema import table, immutable, STAMP

STATEMENTS = (
    table('erp_banca_instrucciones_externas', f"""
        receipt_id INTEGER NOT NULL, secret_id TEXT NOT NULL, cutoff_on TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'activa' CHECK(state IN ('activa','cerrada')),
        version INTEGER NOT NULL DEFAULT 1, {STAMP},
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    "CREATE UNIQUE INDEX erp_banca_external_active ON erp_banca_instrucciones_externas(id_comunidad,receipt_id) WHERE state='activa'",
    table('erp_banca_control_eventos', f"""
        external_id INTEGER, line_id INTEGER, conflict_event_id INTEGER,
        kind TEXT NOT NULL CHECK(kind IN ('external_closed','conflict_reviewed','terminal_history_gap','reversal_requested','oneoff_retry_authorized')),
        secret_id TEXT NOT NULL, effective_on TEXT NOT NULL, {STAMP},
        FOREIGN KEY(id_comunidad,external_id) REFERENCES erp_banca_instrucciones_externas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,line_id) REFERENCES erp_remesa_lineas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,conflict_event_id) REFERENCES erp_banca_linea_eventos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    "CREATE UNIQUE INDEX erp_banca_conflict_review ON erp_banca_control_eventos(conflict_event_id) WHERE kind='conflict_reviewed'",
    table('erp_mandato_sucesiones', f"""
        predecessor_id INTEGER NOT NULL, successor_id INTEGER NOT NULL UNIQUE,
        secret_id TEXT NOT NULL, effective_on TEXT NOT NULL, {STAMP},
        CHECK(predecessor_id!=successor_id), UNIQUE(predecessor_id),
        FOREIGN KEY(id_comunidad,predecessor_id) REFERENCES erp_mandatos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,successor_id) REFERENCES erp_mandatos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    """CREATE TRIGGER erp_banca_external_blocks_reservation BEFORE INSERT ON erp_remesa_reservas
        WHEN NEW.state='activa' AND EXISTS (SELECT 1 FROM erp_banca_instrucciones_externas
            WHERE id_comunidad=NEW.id_comunidad AND receipt_id=NEW.receipt_id AND state='activa')
        BEGIN SELECT RAISE(ABORT,'external bank instruction reserved'); END""",
    """CREATE TRIGGER erp_banca_reservation_blocks_external BEFORE INSERT ON erp_banca_instrucciones_externas
        WHEN NEW.state='activa' AND EXISTS (SELECT 1 FROM erp_remesa_reservas
            WHERE id_comunidad=NEW.id_comunidad AND receipt_id=NEW.receipt_id AND state='activa')
        BEGIN SELECT RAISE(ABORT,'local bank instruction reserved'); END""",
    """CREATE TRIGGER erp4_void_external_guard BEFORE INSERT ON erp_rectificaciones
        WHEN NEW.kind='void' AND EXISTS (SELECT 1 FROM erp_banca_instrucciones_externas r
            WHERE r.id_comunidad=NEW.id_comunidad AND r.receipt_id=NEW.receipt_id AND r.state='activa')
        BEGIN SELECT RAISE(ABORT,'El recibo tiene una instruccion externa activa'); END""",
) + tuple(sql for name in ('erp_banca_control_eventos','erp_mandato_sucesiones') for sql in immutable(name))
