"""Zero obligations are processed identities, not fictitious zero receipts."""

from .receivables_schema import immutable

STATEMENTS=(
    """CREATE TABLE erp_cuotas_cero_procesadas (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, id_propiedad INTEGER NOT NULL,
        obligation_key TEXT NOT NULL, event_id INTEGER NOT NULL, source_key TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,obligation_key), UNIQUE(id_comunidad,source_key),
        FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
)+immutable('erp_cuotas_cero_procesadas')
