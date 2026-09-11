"""Append-only cancellation of returns and accreditation of previously unknown payers."""

from .receivables_schema import immutable

STATEMENTS=(
    """CREATE TABLE erp_devolucion_reversiones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, return_id INTEGER NOT NULL,
        collection_id INTEGER NOT NULL, event_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000000),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,return_id),
        FOREIGN KEY(id_comunidad,return_id) REFERENCES erp_devoluciones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_cobro_acreditaciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, collection_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, payer_owner_id INTEGER, payer_person_id INTEGER,
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        CHECK((payer_owner_id IS NOT NULL)+(payer_person_id IS NOT NULL)=1),
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,collection_id),
        FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,payer_owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,payer_person_id) REFERENCES erp_personas_cobro(id_comunidad,id_persona_cobro)
    )""",
)+immutable('erp_devolucion_reversiones')+immutable('erp_cobro_acreditaciones')
