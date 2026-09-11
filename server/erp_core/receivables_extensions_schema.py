"""Append-only ERP 3 coverage and links; preserves migration 7 checkpoints."""

from .receivables_schema import immutable

STATEMENTS=(
    "ALTER TABLE erp_imputaciones ADD COLUMN responsibility_json TEXT CHECK(responsibility_json IS NULL OR json_valid(responsibility_json))",
    "ALTER TABLE erp_rectificaciones ADD COLUMN responsibility_json TEXT CHECK(responsibility_json IS NULL OR json_valid(responsibility_json))",
    "ALTER TABLE erp_credito_aplicaciones ADD COLUMN responsibility_json TEXT CHECK(responsibility_json IS NULL OR json_valid(responsibility_json))",
    """CREATE TABLE erp_recibos_coberturas (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        concept_key TEXT NOT NULL, effective_from TEXT NOT NULL, effective_until TEXT NOT NULL,
        authority TEXT NOT NULL CHECK(authority IN ('erp3','legacy_observed')),
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        reason TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        CHECK(effective_until>=effective_from), UNIQUE(id_comunidad,id),
        UNIQUE(id_comunidad,concept_key,effective_from,effective_until)
    )""",
    """CREATE TABLE erp_regularizaciones_materializadas (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, line_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, receipt_id INTEGER, credit_id INTEGER,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer'),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        UNIQUE(id_comunidad,line_id), UNIQUE(id_comunidad,id),
        CHECK(NOT(receipt_id IS NOT NULL AND credit_id IS NOT NULL)),
        FOREIGN KEY(id_comunidad,line_id) REFERENCES erp_regularizacion_lineas(id_comunidad,id_linea),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,credit_id) REFERENCES erp_creditos(id_comunidad,id)
    )""",
    """CREATE TRIGGER erp3_confirmed_proposal_update BEFORE UPDATE ON erp_emisiones_lotes
        WHEN OLD.state IN ('confirmed','discarded') BEGIN SELECT RAISE(ABORT,'Propuesta cerrada inmutable'); END""",
    """CREATE TRIGGER erp3_proposal_delete BEFORE DELETE ON erp_emisiones_lotes
        BEGIN SELECT RAISE(ABORT,'Conserva el historial de propuestas'); END""",
    """CREATE TRIGGER erp3_import_closed_update BEFORE UPDATE ON erp_importaciones_economicas
        WHEN OLD.state='confirmed' BEGIN SELECT RAISE(ABORT,'Importacion confirmada inmutable'); END""",
    """CREATE TRIGGER erp3_import_row_closed_update BEFORE UPDATE ON erp_importaciones_economicas_filas
        WHEN EXISTS (SELECT 1 FROM erp_importaciones_economicas WHERE id=OLD.import_id AND state='confirmed')
        BEGIN SELECT RAISE(ABORT,'Origen confirmado inmutable'); END""",
    """CREATE TRIGGER erp3_import_row_closed_delete BEFORE DELETE ON erp_importaciones_economicas_filas
        WHEN EXISTS (SELECT 1 FROM erp_importaciones_economicas WHERE id=OLD.import_id AND state='confirmed')
        BEGIN SELECT RAISE(ABORT,'Origen confirmado inmutable'); END""",
)
for table in ('erp_recibos_coberturas','erp_regularizaciones_materializadas'):
    STATEMENTS+=immutable(table)
