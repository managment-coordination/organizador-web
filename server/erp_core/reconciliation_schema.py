"""Additive ERP 5 records. Bank evidence and economic facts remain distinct."""

STATEMENTS = []


def table(name, fields):
    STATEMENTS.append(f'''CREATE TABLE {name} (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL,
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL,
        {fields},
        UNIQUE(id_comunidad,id),
        FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
        FOREIGN KEY(actor_id) REFERENCES usuarios(id_usuario))''')


def account_fk():
    return 'FOREIGN KEY(id_comunidad,treasury_id) REFERENCES erp_cuentas_tesoreria(id_comunidad,id)'


table('erp_conciliacion_permisos', '''user_id INTEGER NOT NULL, capability TEXT NOT NULL,
    allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), version INTEGER NOT NULL CHECK(version>0),
    UNIQUE(id_comunidad,user_id,capability), FOREIGN KEY(user_id) REFERENCES usuarios(id_usuario)''')
table('erp_extractos_importaciones', f'''treasury_id INTEGER NOT NULL, source_hash TEXT NOT NULL,
    secret_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pendiente','confirmada')),
    version INTEGER NOT NULL DEFAULT 1, UNIQUE(id_comunidad,treasury_id,source_hash), {account_fk()},
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_banco_movimientos', f'''treasury_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0),
    currency TEXT NOT NULL, operation_on TEXT NOT NULL, value_on TEXT,
    source_state TEXT NOT NULL CHECK(source_state IN ('booked','pending')),
    secret_id TEXT NOT NULL, fingerprint TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    {account_fk()}, FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_banco_movimiento_identidades', '''movement_id INTEGER NOT NULL, key_id TEXT NOT NULL,
    digest TEXT NOT NULL, UNIQUE(id_comunidad,key_id,digest),
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id)''')
table('erp_banco_movimiento_evidencias', '''movement_id INTEGER NOT NULL, import_id INTEGER NOT NULL,
    row_number INTEGER NOT NULL, UNIQUE(import_id,row_number),
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id),
    FOREIGN KEY(id_comunidad,import_id) REFERENCES erp_extractos_importaciones(id_comunidad,id)''')
table('erp_banco_movimiento_correcciones', '''movement_id INTEGER NOT NULL, replacement_id INTEGER,
    kind TEXT NOT NULL CHECK(kind IN ('duplicate','substitute')), secret_id TEXT NOT NULL,
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id),
    FOREIGN KEY(id_comunidad,replacement_id) REFERENCES erp_banco_movimientos(id_comunidad,id),
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_extractos_coberturas', f'''treasury_id INTEGER NOT NULL, import_id INTEGER,
    start_on TEXT NOT NULL, end_on TEXT NOT NULL CHECK(end_on>=start_on),
    opening_cents INTEGER, closing_cents INTEGER, balance_type TEXT NOT NULL CHECK(balance_type IN ('booked','available','value')),
    complete INTEGER NOT NULL CHECK(complete IN (0,1)), secret_id TEXT NOT NULL,
    {account_fk()}, FOREIGN KEY(id_comunidad,import_id) REFERENCES erp_extractos_importaciones(id_comunidad,id),
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_conciliacion_propuestas', '''kind TEXT NOT NULL, secret_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pendiente' CHECK(state IN ('pendiente','confirmada')),
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_tesoreria_salidas', f'''treasury_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
    effective_on TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('payment','commission','other')),
    secret_id TEXT NOT NULL, external_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
    UNIQUE(id_comunidad,external_key), {account_fk()},
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_tesoreria_transferencias', '''source_id INTEGER NOT NULL, destination_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0), secret_id TEXT NOT NULL,
    CHECK(source_id!=destination_id),
    FOREIGN KEY(id_comunidad,source_id) REFERENCES erp_cuentas_tesoreria(id_comunidad,id),
    FOREIGN KEY(id_comunidad,destination_id) REFERENCES erp_cuentas_tesoreria(id_comunidad,id),
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_conciliaciones', '''proposal_id INTEGER, secret_id TEXT NOT NULL,
    FOREIGN KEY(id_comunidad,proposal_id) REFERENCES erp_conciliacion_propuestas(id_comunidad,id),
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_tesoreria_transferencia_extremos', '''transfer_id INTEGER NOT NULL, match_id INTEGER NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('source','destination')), treasury_id INTEGER NOT NULL,
    movement_id INTEGER, amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0),
    effective_on TEXT NOT NULL, secret_id TEXT NOT NULL,
    FOREIGN KEY(id_comunidad,transfer_id) REFERENCES erp_tesoreria_transferencias(id_comunidad,id),
    FOREIGN KEY(id_comunidad,match_id) REFERENCES erp_conciliaciones(id_comunidad,id),
    FOREIGN KEY(id_comunidad,treasury_id) REFERENCES erp_cuentas_tesoreria(id_comunidad,id),
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id),
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_conciliacion_componentes', '''match_id INTEGER NOT NULL, movement_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('collection','return','refund','outflow','transfer')),
    collection_id INTEGER, return_id INTEGER, refund_id INTEGER, outflow_id INTEGER, transfer_id INTEGER,
    amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0), reverses_id INTEGER UNIQUE,
    CHECK((collection_id IS NOT NULL)+(return_id IS NOT NULL)+(refund_id IS NOT NULL)+(outflow_id IS NOT NULL)+(transfer_id IS NOT NULL)=1),
    CHECK((kind='collection' AND collection_id IS NOT NULL) OR (kind='return' AND return_id IS NOT NULL)
        OR (kind='refund' AND refund_id IS NOT NULL) OR (kind='outflow' AND outflow_id IS NOT NULL)
        OR (kind='transfer' AND transfer_id IS NOT NULL)),
    FOREIGN KEY(id_comunidad,match_id) REFERENCES erp_conciliaciones(id_comunidad,id),
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id),
    FOREIGN KEY(id_comunidad,collection_id) REFERENCES erp_cobros(id_comunidad,id),
    FOREIGN KEY(id_comunidad,return_id) REFERENCES erp_devoluciones(id_comunidad,id),
    FOREIGN KEY(id_comunidad,refund_id) REFERENCES erp_reintegros(id_comunidad,id),
    FOREIGN KEY(id_comunidad,outflow_id) REFERENCES erp_tesoreria_salidas(id_comunidad,id),
    FOREIGN KEY(id_comunidad,transfer_id) REFERENCES erp_tesoreria_transferencias(id_comunidad,id),
    FOREIGN KEY(id_comunidad,reverses_id) REFERENCES erp_conciliacion_componentes(id_comunidad,id)''')
table('erp_banco_operacion_vinculos', '''movement_id INTEGER NOT NULL, operation_id INTEGER NOT NULL,
    UNIQUE(id_comunidad,movement_id,operation_id),
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id),
    FOREIGN KEY(id_comunidad,operation_id) REFERENCES erp_banco_operaciones(id_comunidad,id)''')
table('erp_conciliacion_cierres', f'''treasury_id INTEGER NOT NULL, start_on TEXT NOT NULL,
    end_on TEXT NOT NULL CHECK(end_on>=start_on), secret_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('cerrado','cerrado_pendientes','reabierto')),
    version INTEGER NOT NULL DEFAULT 1, {account_fk()},
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_conciliacion_cierre_eventos', '''closure_id INTEGER NOT NULL, kind TEXT NOT NULL,
    secret_id TEXT NOT NULL,
    FOREIGN KEY(id_comunidad,closure_id) REFERENCES erp_conciliacion_cierres(id_comunidad,id),
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_conciliacion_pendientes', '''movement_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    review_on TEXT NOT NULL, secret_id TEXT NOT NULL,
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id),
    FOREIGN KEY(user_id) REFERENCES usuarios(id_usuario),
    FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_banco_legacy_correspondencias', '''legacy_table TEXT NOT NULL, legacy_id TEXT NOT NULL,
    movement_id INTEGER NOT NULL, UNIQUE(id_comunidad,legacy_table,legacy_id),
    FOREIGN KEY(id_comunidad,movement_id) REFERENCES erp_banco_movimientos(id_comunidad,id)''')
table('erp_banco_fuentes_activaciones', f'''treasury_id INTEGER NOT NULL, start_on TEXT NOT NULL,
    end_on TEXT NOT NULL CHECK(end_on>=start_on), secret_id TEXT NOT NULL,
    {account_fk()}, FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')
table('erp_conciliacion_perfiles', f'''treasury_id INTEGER NOT NULL, profile_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('mapping','matching')), version INTEGER NOT NULL CHECK(version>0),
    secret_id TEXT NOT NULL, UNIQUE(id_comunidad,treasury_id,profile_key,kind,version),
    {account_fk()}, FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)''')

STATEMENTS += [
    'CREATE INDEX erp5_movement_account_date ON erp_banco_movimientos(id_comunidad,treasury_id,operation_on)',
    'CREATE INDEX erp5_movement_fingerprint ON erp_banco_movimientos(id_comunidad,treasury_id,fingerprint)',
    'CREATE INDEX erp5_match_movement ON erp_conciliacion_componentes(id_comunidad,movement_id)',
]
for name in ('erp_banco_movimientos','erp_banco_movimiento_identidades','erp_banco_movimiento_evidencias',
             'erp_banco_movimiento_correcciones','erp_extractos_coberturas','erp_tesoreria_salidas',
             'erp_tesoreria_transferencias','erp_tesoreria_transferencia_extremos','erp_conciliaciones','erp_conciliacion_componentes',
             'erp_banco_operacion_vinculos','erp_conciliacion_cierre_eventos','erp_banco_legacy_correspondencias','erp_banco_fuentes_activaciones','erp_conciliacion_perfiles'):
    for operation in ('UPDATE','DELETE'):
        STATEMENTS.append(f"CREATE TRIGGER {name}_no_{operation.lower()} BEFORE {operation} ON {name} BEGIN SELECT RAISE(ABORT,'ERP5 history is immutable'); END")
STATEMENTS = tuple(STATEMENTS)

RECTIFICATION_STATEMENTS = (
    '''CREATE TABLE erp_tesoreria_rectificaciones (
        id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL,
        outflow_id INTEGER, leg_id INTEGER, effective_on TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents!=0),
        secret_id TEXT NOT NULL, registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL,
        CHECK((outflow_id IS NOT NULL)+(leg_id IS NOT NULL)=1),
        UNIQUE(id_comunidad,id), UNIQUE(id_comunidad,outflow_id), UNIQUE(id_comunidad,leg_id),
        FOREIGN KEY(id_comunidad,outflow_id) REFERENCES erp_tesoreria_salidas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,leg_id) REFERENCES erp_tesoreria_transferencia_extremos(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id),
        FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
        FOREIGN KEY(actor_id) REFERENCES usuarios(id_usuario))''',
    "CREATE TRIGGER erp_tesoreria_rectificaciones_no_update BEFORE UPDATE ON erp_tesoreria_rectificaciones BEGIN SELECT RAISE(ABORT,'ERP5 history is immutable'); END",
    "CREATE TRIGGER erp_tesoreria_rectificaciones_no_delete BEFORE DELETE ON erp_tesoreria_rectificaciones BEGIN SELECT RAISE(ABORT,'ERP5 history is immutable'); END",
)
