"""Additive ERP 4 storage. No existing receipt, subject or balance is rewritten."""


def table(name, body):
    return f"""CREATE TABLE {name} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_comunidad INTEGER NOT NULL,
        {body},
        UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad)
    )"""


def immutable(name):
    return tuple(f"""CREATE TRIGGER {name}_no_{verb.lower()} BEFORE {verb} ON {name}
        BEGIN SELECT RAISE(ABORT,'Historico bancario inmutable'); END""" for verb in ('UPDATE', 'DELETE'))


STAMP = "registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario)"
STATEMENTS = (
    """CREATE TABLE erp_banca_claves (
        id_comunidad INTEGER PRIMARY KEY REFERENCES comunidades(id_comunidad),
        wrapped_key TEXT NOT NULL, key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version>0)
    )""",
    """CREATE TABLE erp_banca_permisos (
        id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        capability TEXT NOT NULL CHECK(capability IN (
            'read_masked','manage_accounts','manage_mandates','configure_creditor',
            'prepare','export','reveal','present_cancel','results','audit')),
        allowed INTEGER NOT NULL CHECK(allowed IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario), registered_at TEXT NOT NULL,
        PRIMARY KEY(id_comunidad,id_usuario,capability)
    )""",
    """CREATE TABLE erp_banca_secretos (
        id TEXT NOT NULL, id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
        purpose TEXT NOT NULL, sealed TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        registered_at TEXT NOT NULL, PRIMARY KEY(id_comunidad,id)
    )""",
    table('erp_cuentas_pagador', f"""
        secret_id TEXT NOT NULL, country TEXT NOT NULL, last_four TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'activa' CHECK(state IN ('activa','bloqueada','cerrada')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP},
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    """CREATE TABLE erp_cuenta_huellas (
        id_comunidad INTEGER NOT NULL, account_id INTEGER NOT NULL,
        key_id TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(id_comunidad,key_id,digest),
        FOREIGN KEY(id_comunidad,account_id) REFERENCES erp_cuentas_pagador(id_comunidad,id)
    )""",
    table('erp_cuenta_pagador_versiones', f"""
        account_id INTEGER NOT NULL, version INTEGER NOT NULL CHECK(version>0),
        secret_id TEXT NOT NULL, {STAMP}, UNIQUE(account_id,version),
        FOREIGN KEY(id_comunidad,account_id) REFERENCES erp_cuentas_pagador(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_cuenta_personas', f"""
        account_id INTEGER NOT NULL, owner_id INTEGER, person_id INTEGER,
        role TEXT NOT NULL CHECK(role IN ('titular','cotitular','autorizado','pagador')),
        effective_from TEXT NOT NULL, effective_until TEXT,
        evidence_secret_id TEXT NOT NULL, {STAMP},
        CHECK((owner_id IS NOT NULL)!=(person_id IS NOT NULL)),
        CHECK(effective_until IS NULL OR effective_until>effective_from),
        FOREIGN KEY(id_comunidad,account_id) REFERENCES erp_cuentas_pagador(id_comunidad,id),
        FOREIGN KEY(id_comunidad,owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,person_id) REFERENCES erp_personas_cobro(id_comunidad,id_persona_cobro),
        FOREIGN KEY(id_comunidad,evidence_secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_cuentas_tesoreria', f"""
        kind TEXT NOT NULL CHECK(kind IN ('banco','caja')), currency TEXT NOT NULL DEFAULT 'EUR',
        secret_id TEXT, state TEXT NOT NULL DEFAULT 'activa' CHECK(state IN ('activa','cerrada')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP},
        CHECK((kind='banco' AND secret_id IS NOT NULL) OR (kind='caja' AND secret_id IS NULL)),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_acreedor_versiones', f"""
        treasury_id INTEGER NOT NULL, secret_id TEXT NOT NULL, profile_id TEXT NOT NULL,
        effective_from TEXT NOT NULL, effective_until TEXT, version INTEGER NOT NULL CHECK(version>0),
        supersedes_id INTEGER, {STAMP},
        CHECK(effective_until IS NULL OR effective_until>effective_from),
        FOREIGN KEY(id_comunidad,treasury_id) REFERENCES erp_cuentas_tesoreria(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,supersedes_id) REFERENCES erp_acreedor_versiones(id_comunidad,id)
    """),
    table('erp_mandatos', f"""
        creditor_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('recurrente','puntual')),
        scheme TEXT NOT NULL CHECK(scheme='CORE'),
        state TEXT NOT NULL CHECK(state IN ('borrador','pendiente','activo','suspendido','revocado','caducado','agotado')),
        rum_secret_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP},
        FOREIGN KEY(id_comunidad,creditor_id) REFERENCES erp_acreedor_versiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,rum_secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    """CREATE TABLE erp_mandato_huellas (
        key_id TEXT NOT NULL, digest TEXT NOT NULL, id_comunidad INTEGER NOT NULL,
        mandate_id INTEGER NOT NULL, PRIMARY KEY(key_id,digest),
        FOREIGN KEY(id_comunidad,mandate_id) REFERENCES erp_mandatos(id_comunidad,id)
    )""",
    table('erp_mandato_versiones', f"""
        mandate_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
        debtor_owner_id INTEGER, debtor_person_id INTEGER, secret_id TEXT NOT NULL,
        signed_on TEXT NOT NULL, effective_from TEXT NOT NULL, effective_until TEXT,
        version INTEGER NOT NULL CHECK(version>0), supersedes_id INTEGER, {STAMP},
        CHECK((debtor_owner_id IS NOT NULL)!=(debtor_person_id IS NOT NULL)),
        CHECK(effective_until IS NULL OR effective_until>effective_from),
        UNIQUE(mandate_id,version),
        FOREIGN KEY(id_comunidad,mandate_id) REFERENCES erp_mandatos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,account_id) REFERENCES erp_cuentas_pagador(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,debtor_owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,debtor_person_id) REFERENCES erp_personas_cobro(id_comunidad,id_persona_cobro),
        FOREIGN KEY(id_comunidad,supersedes_id) REFERENCES erp_mandato_versiones(id_comunidad,id)
    """),
    table('erp_mandato_firmantes', """
        mandate_version_id INTEGER NOT NULL, owner_id INTEGER, person_id INTEGER,
        evidence_secret_id TEXT NOT NULL,
        CHECK((owner_id IS NOT NULL)!=(person_id IS NOT NULL)),
        FOREIGN KEY(id_comunidad,mandate_version_id) REFERENCES erp_mandato_versiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,owner_id) REFERENCES cf_propietarios(id_comunidad,id_propietario),
        FOREIGN KEY(id_comunidad,person_id) REFERENCES erp_personas_cobro(id_comunidad,id_persona_cobro),
        FOREIGN KEY(id_comunidad,evidence_secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_mandato_eventos', f"""
        mandate_id INTEGER NOT NULL, event_type TEXT NOT NULL, effective_on TEXT NOT NULL,
        secret_id TEXT NOT NULL, {STAMP},
        FOREIGN KEY(id_comunidad,mandate_id) REFERENCES erp_mandatos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_domiciliaciones', f"""
        property_id INTEGER NOT NULL, scope TEXT NOT NULL, concept_key TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP},
        UNIQUE(id_comunidad,property_id,scope,concept_key),
        FOREIGN KEY(id_comunidad,property_id) REFERENCES cf_propiedades(id_comunidad,id_propiedad)
    """),
    table('erp_domiciliacion_versiones', f"""
        direct_debit_id INTEGER NOT NULL, billing_config_id INTEGER NOT NULL, mandate_id INTEGER NOT NULL,
        effective_from TEXT NOT NULL, effective_until TEXT, state TEXT NOT NULL CHECK(state IN ('activa','suspendida','finalizada')),
        version INTEGER NOT NULL CHECK(version>0), supersedes_id INTEGER, evidence_secret_id TEXT NOT NULL, {STAMP},
        CHECK(effective_until IS NULL OR effective_until>effective_from), UNIQUE(direct_debit_id,version),
        FOREIGN KEY(id_comunidad,direct_debit_id) REFERENCES erp_domiciliaciones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,billing_config_id) REFERENCES erp_config_recibo_versiones(id_comunidad,id_config_recibo),
        FOREIGN KEY(id_comunidad,mandate_id) REFERENCES erp_mandatos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,supersedes_id) REFERENCES erp_domiciliacion_versiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,evidence_secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_prenotificaciones', f"""
        secret_id TEXT NOT NULL, sent_on TEXT, state TEXT NOT NULL CHECK(state IN ('borrador','enviada')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP},
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_remesas', f"""
        creditor_id INTEGER NOT NULL, requested_on TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='EUR'),
        state TEXT NOT NULL CHECK(state IN ('borrador','preparada','validada','fichero_disponible','exportada','presentada',
            'seguimiento','cancelacion_solicitada','cancelada','finalizada')),
        needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP},
        FOREIGN KEY(id_comunidad,creditor_id) REFERENCES erp_acreedor_versiones(id_comunidad,id)
    """),
    table('erp_remesa_revisiones', f"""
        remittance_id INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
        secret_id TEXT NOT NULL, fingerprint TEXT NOT NULL, {STAMP}, UNIQUE(remittance_id,revision),
        FOREIGN KEY(id_comunidad,remittance_id) REFERENCES erp_remesas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_remesa_lineas', f"""
        revision_id INTEGER NOT NULL, receipt_id INTEGER NOT NULL, attempt_key TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        mandate_version_id INTEGER NOT NULL, notification_id INTEGER NOT NULL,
        secret_id TEXT NOT NULL, retry_of_id INTEGER, {STAMP},
        UNIQUE(id_comunidad,attempt_key), UNIQUE(revision_id,receipt_id),
        FOREIGN KEY(id_comunidad,revision_id) REFERENCES erp_remesa_revisiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,mandate_version_id) REFERENCES erp_mandato_versiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,notification_id) REFERENCES erp_prenotificaciones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,retry_of_id) REFERENCES erp_remesa_lineas(id_comunidad,id)
    """),
    table('erp_remesa_reservas', f"""
        receipt_id INTEGER NOT NULL, line_id INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents>0),
        state TEXT NOT NULL CHECK(state IN ('activa','liberada','consumida')),
        finished_at TEXT, reason TEXT, {STAMP}, UNIQUE(line_id),
        CHECK((state='activa' AND finished_at IS NULL) OR (state!='activa' AND finished_at IS NOT NULL)),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,line_id) REFERENCES erp_remesa_lineas(id_comunidad,id)
    """),
    "CREATE UNIQUE INDEX erp_reserva_recibo_activo ON erp_remesa_reservas(id_comunidad,receipt_id) WHERE state='activa'",
    table('erp_remesa_ficheros', f"""
        revision_id INTEGER NOT NULL, secret_id TEXT NOT NULL, message_id TEXT NOT NULL,
        profile_id TEXT NOT NULL, content_hash TEXT NOT NULL, {STAMP},
        UNIQUE(revision_id), UNIQUE(message_id),
        FOREIGN KEY(id_comunidad,revision_id) REFERENCES erp_remesa_revisiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_remesa_presentaciones', f"""
        file_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('exportada','presentada','retirada_solicitada','retirada_confirmada','inversion_solicitada')),
        effective_on TEXT NOT NULL, secret_id TEXT NOT NULL, {STAMP},
        FOREIGN KEY(id_comunidad,file_id) REFERENCES erp_remesa_ficheros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_resultados_bancarios', f"""
        source_hash TEXT NOT NULL, profile_id TEXT NOT NULL, secret_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pendiente','confirmado','conflicto')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP}, UNIQUE(id_comunidad,source_hash),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_resultado_lineas', f"""
        result_id INTEGER NOT NULL, line_id INTEGER, secret_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pendiente','confirmada','conflicto')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP},
        FOREIGN KEY(id_comunidad,result_id) REFERENCES erp_resultados_bancarios(id_comunidad,id),
        FOREIGN KEY(id_comunidad,line_id) REFERENCES erp_remesa_lineas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_banco_operaciones', f"""
        treasury_id INTEGER NOT NULL, event_type TEXT NOT NULL,
        secret_id TEXT NOT NULL, collection_id INTEGER, return_id INTEGER, {STAMP},
        FOREIGN KEY(id_comunidad,treasury_id) REFERENCES erp_cuentas_tesoreria(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
        FOREIGN KEY(id_comunidad,return_id) REFERENCES erp_devoluciones(id_comunidad,id)
    """),
    """CREATE TABLE erp_banco_identidades (
        id_comunidad INTEGER NOT NULL, key_id TEXT NOT NULL, digest TEXT NOT NULL,
        operation_id INTEGER NOT NULL, PRIMARY KEY(id_comunidad,key_id,digest),
        FOREIGN KEY(id_comunidad,operation_id) REFERENCES erp_banco_operaciones(id_comunidad,id)
    )""",
    table('erp_banca_importaciones', f"""
        secret_id TEXT NOT NULL, source_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pendiente','confirmada','conflicto')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), {STAMP}, UNIQUE(id_comunidad,source_hash),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_banca_importacion_filas', f"""
        import_id INTEGER NOT NULL, row_number INTEGER NOT NULL, secret_id TEXT NOT NULL,
        account_id INTEGER, mandate_id INTEGER, {STAMP}, UNIQUE(import_id,row_number),
        FOREIGN KEY(id_comunidad,import_id) REFERENCES erp_banca_importaciones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,account_id) REFERENCES erp_cuentas_pagador(id_comunidad,id),
        FOREIGN KEY(id_comunidad,mandate_id) REFERENCES erp_mandatos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    "CREATE INDEX erp_banca_mandatos_estado ON erp_mandatos(id_comunidad,state)",
    "CREATE INDEX erp_banca_remesas_estado ON erp_remesas(id_comunidad,state)",
    "CREATE INDEX erp_banca_lineas_recibo ON erp_remesa_lineas(id_comunidad,receipt_id)",
    """CREATE TRIGGER erp_reserva_match_line BEFORE INSERT ON erp_remesa_reservas
        WHEN NOT EXISTS (SELECT 1 FROM erp_remesa_lineas l WHERE l.id_comunidad=NEW.id_comunidad
            AND l.id=NEW.line_id AND l.receipt_id=NEW.receipt_id AND l.amount_cents=NEW.amount_cents)
        BEGIN SELECT RAISE(ABORT,'La reserva no corresponde a su linea'); END""",
    """CREATE TRIGGER erp_reserva_no_rewrite BEFORE UPDATE ON erp_remesa_reservas
        WHEN OLD.id!=NEW.id OR OLD.id_comunidad!=NEW.id_comunidad OR OLD.receipt_id!=NEW.receipt_id
        OR OLD.line_id!=NEW.line_id OR OLD.amount_cents!=NEW.amount_cents OR OLD.registered_at!=NEW.registered_at
        OR OLD.actor_id!=NEW.actor_id OR OLD.state!='activa' OR NEW.state='activa'
        BEGIN SELECT RAISE(ABORT,'No se puede reescribir una reserva'); END""",
    """CREATE TRIGGER erp_reserva_no_delete BEFORE DELETE ON erp_remesa_reservas
        BEGIN SELECT RAISE(ABORT,'No se puede borrar una reserva'); END""",
    """CREATE TRIGGER erp_cuenta_no_change_identity BEFORE UPDATE OF secret_id,country,last_four,id_comunidad ON erp_cuentas_pagador
        BEGIN SELECT RAISE(ABORT,'Un nuevo IBAN requiere una cuenta nueva'); END""",
)

for name in ('erp_cuenta_pagador_versiones', 'erp_acreedor_versiones', 'erp_mandato_versiones',
             'erp_mandato_firmantes', 'erp_mandato_eventos', 'erp_domiciliacion_versiones',
             'erp_remesa_revisiones', 'erp_remesa_lineas', 'erp_remesa_ficheros', 'erp_remesa_presentaciones'):
    STATEMENTS += immutable(name)
