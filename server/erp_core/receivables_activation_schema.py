"""Reviewed historical coverage, retaining original observations and obligations."""

from .receivables_schema import immutable

STATEMENTS=(
    """CREATE TABLE erp_cobertura_activaciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, coverage_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        registered_at TEXT NOT NULL,
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,coverage_id),
        FOREIGN KEY(id_comunidad,coverage_id) REFERENCES erp_recibos_coberturas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_historico_obligaciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, activation_id INTEGER NOT NULL,
        legacy_receipt_id INTEGER NOT NULL, opening_id INTEGER NOT NULL, id_propiedad INTEGER NOT NULL,
        concept_key TEXT NOT NULL, period_from TEXT NOT NULL, period_until TEXT NOT NULL,
        net_emitted_cents INTEGER NOT NULL CHECK(typeof(net_emitted_cents)='integer' AND net_emitted_cents BETWEEN 0 AND 9000000000000000),
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), registered_at TEXT NOT NULL,
        CHECK(period_until>=period_from), UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,legacy_receipt_id),
        FOREIGN KEY(legacy_receipt_id) REFERENCES cf_recibos(id_recibo),
        FOREIGN KEY(id_comunidad,activation_id) REFERENCES erp_cobertura_activaciones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,opening_id) REFERENCES erp_saldos_apertura(id_comunidad,id),
        FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad)
    )""",
    'CREATE INDEX idx_historico_obligacion_periodo ON erp_historico_obligaciones(id_comunidad,id_propiedad,concept_key,period_from,period_until)',
)+immutable('erp_cobertura_activaciones')+immutable('erp_historico_obligaciones')
