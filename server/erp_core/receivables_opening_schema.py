"""Financial movements against evidenced opening balances, without fabricated receipts."""

from .receivables_schema import immutable

STATEMENTS=(
    """CREATE TABLE erp_apertura_movimientos (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, opening_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, collection_id INTEGER, receipt_id INTEGER, reverses_id INTEGER,
        kind TEXT NOT NULL CHECK(kind IN ('allocation','reverse_allocation','credit_apply','reverse_credit_apply','refund','credit','reverse_credit')),
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0 AND amount_cents<=9000000000000000),
        responsibility_json TEXT CHECK(responsibility_json IS NULL OR json_valid(responsibility_json)),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        UNIQUE(id_comunidad,id),
        CHECK((kind IN ('allocation','reverse_allocation') AND collection_id IS NOT NULL AND receipt_id IS NULL)
           OR (kind IN ('credit_apply','reverse_credit_apply') AND receipt_id IS NOT NULL AND collection_id IS NULL)
           OR (kind IN ('refund','credit','reverse_credit') AND receipt_id IS NULL AND collection_id IS NULL)),
        CHECK((kind LIKE 'reverse_%' AND reverses_id IS NOT NULL) OR (kind NOT LIKE 'reverse_%' AND reverses_id IS NULL)),
        FOREIGN KEY(id_comunidad,opening_id) REFERENCES erp_saldos_apertura(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,reverses_id) REFERENCES erp_apertura_movimientos(id_comunidad,id)
    )""",
    'CREATE INDEX erp_apertura_projection ON erp_apertura_movimientos(id_comunidad,opening_id,effective_on,registered_at)',
)+immutable('erp_apertura_movimientos')
