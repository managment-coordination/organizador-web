"""Additive ERP 3 schema; legacy balances are deliberately not converted here."""


def immutable(table, columns=None):
    update = 'UPDATE' if columns is None else 'UPDATE OF ' + ','.join(columns)
    return (
        f"CREATE TRIGGER {table}_immutable_update BEFORE {update} ON {table} BEGIN SELECT RAISE(ABORT,'Historia economica inmutable'); END",
        f"CREATE TRIGGER {table}_immutable_delete BEFORE DELETE ON {table} BEGIN SELECT RAISE(ABORT,'Historia economica inmutable'); END",
    )


STATEMENTS = (
    """CREATE TABLE erp_recibo_permisos (
        id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        capability TEXT NOT NULL, allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        PRIMARY KEY(id_comunidad,id_usuario,capability)
    )""",
    """CREATE TABLE erp_recibo_politicas (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        version INTEGER NOT NULL CHECK(version>0), effective_from TEXT NOT NULL,
        return_fee_mode TEXT NOT NULL CHECK(return_fee_mode IN ('none','actual','fixed')),
        fixed_cents INTEGER NOT NULL CHECK(typeof(fixed_cents)='integer' AND fixed_cents BETWEEN 0 AND 9000000000000000),
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        UNIQUE(id_comunidad,version), UNIQUE(id_comunidad,id)
    )""",
    """CREATE TABLE erp_obligacion_config_versiones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL,
        id_propiedad INTEGER NOT NULL, concept_key TEXT NOT NULL DEFAULT '*',
        version INTEGER NOT NULL CHECK(version>0), effective_from TEXT NOT NULL, effective_until TEXT,
        subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json)),
        mode TEXT NOT NULL CHECK(mode IN ('individual','shared')),
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), reason TEXT NOT NULL,
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,id_propiedad,concept_key,version),
        CHECK(effective_until IS NULL OR effective_until>effective_from),
        FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad)
    )""",
    """CREATE TABLE erp_emisiones_lotes (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        operation TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','confirmed','discarded')),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        preview_json TEXT NOT NULL CHECK(json_valid(preview_json)), preview_hash TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        confirmed_at TEXT, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        UNIQUE(id_comunidad,id)
    )""",
    """CREATE TABLE erp_recibos (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, id_propiedad INTEGER NOT NULL,
        id_ejercicio INTEGER NOT NULL, number TEXT NOT NULL, concept_key TEXT NOT NULL,
        description TEXT NOT NULL, period_key TEXT NOT NULL, period_from TEXT NOT NULL, period_until TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('plan','regularization','return_fee')),
        source_key TEXT NOT NULL, obligation_key TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000000),
        currency TEXT NOT NULL CHECK(length(currency)=3), issued_on TEXT NOT NULL, due_on TEXT,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), snapshot_hash TEXT NOT NULL,
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,number), UNIQUE(id_comunidad,source_type,source_key),
        CHECK(period_until>=period_from),
        FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
        FOREIGN KEY(id_comunidad,id_ejercicio) REFERENCES erp_ejercicios(id_comunidad,id_ejercicio)
    )""",
    "CREATE INDEX idx_erp3_receipt_obligation ON erp_recibos(id_comunidad,obligation_key)",
    """CREATE TABLE erp_recibo_sujetos (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, receipt_id INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('obligated','recipient','payer','owner_reference')),
        owner_id INTEGER, person_id INTEGER, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        CHECK((owner_id IS NULL)<>(person_id IS NULL)),
        UNIQUE(receipt_id,role,owner_id), UNIQUE(receipt_id,role,person_id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,person_id) REFERENCES erp_personas_cobro(id_comunidad,id_persona_cobro)
    )""",
    """CREATE TABLE erp_recibo_detalles (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, receipt_id INTEGER NOT NULL,
        line_key TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer'),
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), UNIQUE(receipt_id,line_key),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_cobros (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000000),
        currency TEXT NOT NULL CHECK(length(currency)=3), effective_on TEXT NOT NULL, value_on TEXT,
        method TEXT NOT NULL, treasury_reference TEXT, payer_owner_id INTEGER, payer_person_id INTEGER,
        external_source TEXT NOT NULL, external_key TEXT NOT NULL,
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        CHECK(payer_owner_id IS NULL OR payer_person_id IS NULL),
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,external_source,external_key),
        FOREIGN KEY(id_comunidad,payer_owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,payer_person_id) REFERENCES erp_personas_cobro(id_comunidad,id_persona_cobro)
    )""",
    """CREATE TABLE erp_hechos_economicos (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        event_key TEXT NOT NULL, event_type TEXT NOT NULL, schema_version TEXT NOT NULL,
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_hash TEXT NOT NULL,
        reason TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
        reverses_id INTEGER, UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,event_key),
        FOREIGN KEY(id_comunidad,reverses_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_imputaciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, collection_id INTEGER NOT NULL,
        receipt_id INTEGER NOT NULL, event_id INTEGER NOT NULL, reverses_id INTEGER,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 9000000000000000),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,reverses_id) REFERENCES erp_imputaciones(id_comunidad,id)
    )""",
    """CREATE TABLE erp_devoluciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, collection_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        free_cents INTEGER NOT NULL CHECK(typeof(free_cents)='integer' AND free_cents>=0),
        details_json TEXT NOT NULL CHECK(json_valid(details_json)), effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        external_key TEXT NOT NULL, UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,external_key),
        FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_rectificaciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, receipt_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('credit','void','reverse_credit')),
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL, reverses_id INTEGER,
        UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,reverses_id) REFERENCES erp_rectificaciones(id_comunidad,id)
    )""",
    """CREATE TABLE erp_creditos (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, event_id INTEGER NOT NULL,
        owner_id INTEGER, person_id INTEGER,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        CHECK((owner_id IS NULL)<>(person_id IS NULL)), UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,person_id) REFERENCES erp_personas_cobro(id_comunidad,id_persona_cobro),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_credito_aplicaciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, credit_id INTEGER NOT NULL,
        receipt_id INTEGER NOT NULL, event_id INTEGER NOT NULL, reverses_id INTEGER,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL, UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,credit_id) REFERENCES erp_creditos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,reverses_id) REFERENCES erp_credito_aplicaciones(id_comunidad,id)
    )""",
    """CREATE TABLE erp_reintegros (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, event_id INTEGER NOT NULL,
        collection_id INTEGER, credit_id INTEGER,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL,
        CHECK((collection_id IS NULL)<>(credit_id IS NULL)), UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,credit_id) REFERENCES erp_creditos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_recibo_gestion_eventos (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, receipt_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, classification TEXT NOT NULL,
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL, UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_reasignaciones_obligacion (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, receipt_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        source_json TEXT NOT NULL CHECK(json_valid(source_json)), target_json TEXT NOT NULL CHECK(json_valid(target_json)),
        economic_impact_json TEXT NOT NULL CHECK(json_valid(economic_impact_json)),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL, UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_saldos_apertura (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, id_propiedad INTEGER,
        owner_id INTEGER, event_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN -9000000000000000 AND 9000000000000000),
        effective_on TEXT NOT NULL, registered_at TEXT NOT NULL, coverage_key TEXT NOT NULL,
        source_json TEXT NOT NULL CHECK(json_valid(source_json)), limitations TEXT NOT NULL,
        quality TEXT NOT NULL CHECK(quality IN ('observada','validada')),
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,coverage_key),
        FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
        FOREIGN KEY(id_comunidad,owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_hechos_economicos(id_comunidad,id)
    )""",
    """CREATE TABLE erp_importaciones_economicas (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        source TEXT NOT NULL, file_hash TEXT NOT NULL, source_json TEXT NOT NULL CHECK(json_valid(source_json)),
        state TEXT NOT NULL CHECK(state IN ('draft','confirmed')), version INTEGER NOT NULL CHECK(version>0),
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,source,file_hash)
    )""",
    """CREATE TABLE erp_importaciones_economicas_filas (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, import_id INTEGER NOT NULL,
        row_number INTEGER NOT NULL, source_key TEXT NOT NULL,
        original_json TEXT NOT NULL CHECK(json_valid(original_json)),
        preview_json TEXT NOT NULL CHECK(json_valid(preview_json)), state TEXT NOT NULL,
        UNIQUE(import_id,row_number), UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad,import_id) REFERENCES erp_importaciones_economicas(id_comunidad,id)
    )""",
    """CREATE TABLE erp_importaciones_economicas_vinculos (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, source TEXT NOT NULL,
        source_key TEXT NOT NULL, row_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
        UNIQUE(id_comunidad,source,source_key),
        FOREIGN KEY(id_comunidad,row_id) REFERENCES erp_importaciones_economicas_filas(id_comunidad,id)
    )""",
    "CREATE INDEX idx_erp3_allocations_cut ON erp_imputaciones(id_comunidad,receipt_id,effective_on,registered_at)",
    "CREATE INDEX idx_erp3_events_cut ON erp_hechos_economicos(id_comunidad,effective_on,registered_at,id)",
)

for _table in ('erp_recibo_politicas', 'erp_obligacion_config_versiones', 'erp_recibo_sujetos',
               'erp_recibo_detalles', 'erp_hechos_economicos', 'erp_imputaciones', 'erp_devoluciones',
               'erp_rectificaciones', 'erp_creditos', 'erp_credito_aplicaciones', 'erp_reintegros',
               'erp_recibo_gestion_eventos', 'erp_reasignaciones_obligacion', 'erp_saldos_apertura',
               'erp_importaciones_economicas_vinculos'):
    STATEMENTS += immutable(_table)

STATEMENTS += immutable('erp_recibos', (
    'id','id_comunidad','id_propiedad','id_ejercicio','number','concept_key','description','period_key',
    'period_from','period_until','source_type','source_key','obligation_key','amount_cents','currency',
    'issued_on','due_on','snapshot_json','snapshot_hash','registered_at','actor_id',
))
STATEMENTS += immutable('erp_cobros', (
    'id','id_comunidad','amount_cents','currency','effective_on','value_on','method','treasury_reference',
    'payer_owner_id','payer_person_id','external_source','external_key','registered_at','actor_id','evidence_json',
))
