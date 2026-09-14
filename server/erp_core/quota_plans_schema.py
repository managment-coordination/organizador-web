"""Operational metadata for existing ERP 2 plans; no parallel quota ledger."""

STATEMENTS = (
    '''CREATE TABLE erp_plan_operativo_versiones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_comunidad INTEGER NOT NULL,
        id_plan INTEGER NOT NULL,
        id_plan_version INTEGER NOT NULL,
        id_ejercicio INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),
        nombre TEXT NOT NULL,
        concepto TEXT NOT NULL,
        descripcion TEXT,
        origen_tipo TEXT NOT NULL CHECK(origen_tipo IN ('presupuesto','importe_manual')),
        modo_importe TEXT NOT NULL CHECK(modo_importe IN ('total_anual','por_periodo')),
        importe_centimos INTEGER NOT NULL CHECK(importe_centimos>=0),
        periodicidad TEXT NOT NULL CHECK(periodicidad IN ('mensual','trimestral','semestral','anual')),
        efectiva_desde TEXT NOT NULL,
        efectiva_hasta TEXT,
        configuracion_json TEXT NOT NULL,
        registrada_en TEXT NOT NULL,
        registrada_por INTEGER NOT NULL,
        motivo TEXT NOT NULL,
        origen TEXT NOT NULL,
        UNIQUE(id_plan,version),
        UNIQUE(id_comunidad,id),
        CHECK(efectiva_hasta IS NULL OR efectiva_hasta>efectiva_desde),
        FOREIGN KEY(id_comunidad,id_plan) REFERENCES erp_planes_cuota(id_comunidad,id_plan),
        FOREIGN KEY(id_comunidad,id_plan_version) REFERENCES erp_plan_versiones(id_comunidad,id_plan_version),
        FOREIGN KEY(id_comunidad,id_ejercicio) REFERENCES erp_ejercicios(id_comunidad,id_ejercicio),
        FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario)
    )''',
    '''CREATE TABLE erp_plan_actividad (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        id_comunidad INTEGER NOT NULL,
        id_plan INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),
        activa INTEGER NOT NULL CHECK(activa IN (0,1)),
        efectiva_desde TEXT NOT NULL,
        registrada_en TEXT NOT NULL,
        registrada_por INTEGER NOT NULL,
        motivo TEXT NOT NULL,
        UNIQUE(id_plan,version),
        FOREIGN KEY(id_comunidad,id_plan) REFERENCES erp_planes_cuota(id_comunidad,id_plan),
        FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario)
    )''',
    '''CREATE TABLE erp_plan_emision_vinculos (
        id_comunidad INTEGER NOT NULL,
        id_plan INTEGER NOT NULL,
        id_plan_operativo INTEGER NOT NULL,
        receipt_id INTEGER NOT NULL,
        PRIMARY KEY(id_comunidad,receipt_id),
        FOREIGN KEY(id_comunidad,id_plan) REFERENCES erp_planes_cuota(id_comunidad,id_plan),
        FOREIGN KEY(id_comunidad,id_plan_operativo) REFERENCES erp_plan_operativo_versiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,receipt_id) REFERENCES erp_recibos(id_comunidad,id)
    )''',
    'CREATE INDEX idx_plan_operativo_fecha ON erp_plan_operativo_versiones(id_comunidad,id_ejercicio,efectiva_desde)',
    *tuple(f'''CREATE TRIGGER {table}_{action.lower()}_immutable BEFORE {action} ON {table}
        BEGIN SELECT RAISE(ABORT,'El historico de planes no se reescribe'); END'''
        for table in ('erp_plan_operativo_versiones','erp_plan_actividad','erp_plan_emision_vinculos') for action in ('UPDATE','DELETE')),
)
