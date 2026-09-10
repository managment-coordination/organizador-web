"""Ordered, checksummed and transactional migrations for ERP foundations."""

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    statements: tuple[str, ...]
    foreign_keys_off: bool = False

    @property
    def checksum(self):
        source = f"{self.version}:{self.name}\n" + "\n".join(self.statements)
        if self.foreign_keys_off:
            source += "\n#foreign_keys_off"
        return hashlib.sha256(source.encode("utf-8")).hexdigest()


MIGRATIONS = (
    Migration(1, "erp0_foundations", (
        """CREATE TABLE IF NOT EXISTS erp_command_log (
            id_command INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            command_name TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('processing','completed')),
            response_json TEXT,
            actor_id INTEGER NOT NULL,
            actor_snapshot TEXT NOT NULL,
            origin TEXT NOT NULL,
            created_at_utc TEXT NOT NULL,
            completed_at_utc TEXT,
            UNIQUE(id_comunidad, command_name, idempotency_key),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(actor_id) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_audit_events (
            id_audit_event INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            id_comunidad INTEGER NOT NULL,
            actor_id INTEGER NOT NULL,
            actor_snapshot TEXT NOT NULL,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            before_json TEXT,
            after_json TEXT,
            reason TEXT,
            origin TEXT NOT NULL,
            request_id TEXT NOT NULL,
            entity_version INTEGER,
            occurred_at_utc TEXT NOT NULL,
            evidence_type TEXT,
            evidence_id TEXT,
            metadata_json TEXT,
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(actor_id) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_outbox (
            id_outbox INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            id_comunidad INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            aggregate_type TEXT NOT NULL,
            aggregate_id TEXT,
            payload_json TEXT NOT NULL,
            dedupe_key TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','processed','failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            available_at_utc TEXT NOT NULL,
            created_at_utc TEXT NOT NULL,
            processed_at_utc TEXT,
            last_error TEXT,
            UNIQUE(id_comunidad, event_type, dedupe_key),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_community_foundation (
            id_comunidad INTEGER PRIMARY KEY,
            foundation_status TEXT NOT NULL CHECK(foundation_status IN ('prepared','verified')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            updated_at_utc TEXT NOT NULL,
            updated_by INTEGER NOT NULL,
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(updated_by) REFERENCES usuarios(id_usuario)
        )""",
        "CREATE INDEX IF NOT EXISTS idx_erp_audit_community_entity ON erp_audit_events(id_comunidad,entity_type,entity_id,occurred_at_utc)",
        "CREATE INDEX IF NOT EXISTS idx_erp_audit_request ON erp_audit_events(request_id)",
        "CREATE INDEX IF NOT EXISTS idx_erp_outbox_pending ON erp_outbox(state,available_at_utc,id_outbox)",
        "CREATE INDEX IF NOT EXISTS idx_erp_command_actor ON erp_command_log(actor_id,created_at_utc)",
    )),
    Migration(2, "erp1_master_data", (
        "ALTER TABLE comunidades ADD COLUMN codigo TEXT",
        "ALTER TABLE comunidades ADD COLUMN denominacion TEXT",
        "ALTER TABLE comunidades ADD COLUMN nif TEXT",
        "ALTER TABLE comunidades ADD COLUMN domicilio TEXT",
        "ALTER TABLE comunidades ADD COLUMN contacto_administrativo TEXT",
        "ALTER TABLE comunidades ADD COLUMN zona_horaria TEXT NOT NULL DEFAULT 'Europe/Madrid'",
        "ALTER TABLE comunidades ADD COLUMN moneda TEXT NOT NULL DEFAULT 'EUR'",
        "ALTER TABLE comunidades ADD COLUMN estado_operativo TEXT NOT NULL DEFAULT 'activa' CHECK(estado_operativo IN ('preparacion','activa','suspendida','baja'))",
        "ALTER TABLE comunidades ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)",
        "UPDATE comunidades SET codigo='COM-'||id_comunidad WHERE codigo IS NULL OR trim(codigo)=''",
        "UPDATE comunidades SET denominacion=nombre WHERE denominacion IS NULL OR trim(denominacion)=''",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_comunidades_codigo ON comunidades(codigo) WHERE codigo IS NOT NULL",
        """CREATE TABLE IF NOT EXISTS erp_comunidad_config_versiones (
            id_config_version INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            version INTEGER NOT NULL CHECK(version > 0),
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            configuracion_json TEXT NOT NULL DEFAULT '{}',
            estado TEXT NOT NULL DEFAULT 'vigente' CHECK(estado IN ('borrador','vigente','sustituida','anulada')),
            origen TEXT NOT NULL,
            registrada_en TEXT NOT NULL,
            registrada_por INTEGER NOT NULL,
            UNIQUE(id_comunidad,version),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_ejercicios (
            id_ejercicio INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            codigo TEXT NOT NULL,
            fecha_inicio TEXT NOT NULL,
            fecha_fin TEXT NOT NULL,
            moneda TEXT NOT NULL DEFAULT 'EUR',
            estado TEXT NOT NULL DEFAULT 'preparacion' CHECK(estado IN ('preparacion','abierto','cerrado')),
            fecha_apertura TEXT,
            abierto_por INTEGER,
            fecha_cierre TEXT,
            cerrado_por INTEGER,
            motivo TEXT,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            creado_en TEXT NOT NULL,
            creado_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,codigo),
            UNIQUE(id_comunidad,id_ejercicio),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(abierto_por) REFERENCES usuarios(id_usuario),
            FOREIGN KEY(cerrado_por) REFERENCES usuarios(id_usuario),
            FOREIGN KEY(creado_por) REFERENCES usuarios(id_usuario),
            CHECK(fecha_fin >= fecha_inicio)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_bloqueos_periodo (
            id_bloqueo INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_ejercicio INTEGER,
            dominio TEXT NOT NULL,
            fecha_inicio TEXT NOT NULL,
            fecha_fin TEXT NOT NULL,
            motivo TEXT NOT NULL,
            activo INTEGER NOT NULL DEFAULT 1 CHECK(activo IN (0,1)),
            creado_en TEXT NOT NULL,
            creado_por INTEGER NOT NULL,
            levantado_en TEXT,
            levantado_por INTEGER,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            FOREIGN KEY(id_comunidad,id_ejercicio) REFERENCES erp_ejercicios(id_comunidad,id_ejercicio),
            FOREIGN KEY(creado_por) REFERENCES usuarios(id_usuario),
            FOREIGN KEY(levantado_por) REFERENCES usuarios(id_usuario),
            CHECK(fecha_fin >= fecha_inicio)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_agrupaciones (
            id_agrupacion INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_padre INTEGER,
            codigo TEXT NOT NULL,
            nombre TEXT NOT NULL,
            tipo TEXT NOT NULL,
            estado TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('preparacion','activa','inactiva')),
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            creada_en TEXT NOT NULL,
            creada_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,codigo),
            UNIQUE(id_comunidad,id_agrupacion),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(id_comunidad,id_padre) REFERENCES erp_agrupaciones(id_comunidad,id_agrupacion),
            FOREIGN KEY(creada_por) REFERENCES usuarios(id_usuario),
            CHECK(id_padre IS NULL OR id_padre <> id_agrupacion),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_tipos_propiedad (
            id_tipo_propiedad INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            codigo TEXT NOT NULL,
            nombre TEXT NOT NULL,
            activo INTEGER NOT NULL DEFAULT 1 CHECK(activo IN (0,1)),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            creado_en TEXT NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,codigo),
            UNIQUE(id_comunidad,id_tipo_propiedad),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad)
        )""",
        "INSERT INTO erp_tipos_propiedad(id_comunidad,codigo,nombre,creado_en,origen) SELECT id_comunidad,'vivienda','Vivienda',CURRENT_TIMESTAMP,'erp1_migration' FROM comunidades",
        "INSERT INTO erp_tipos_propiedad(id_comunidad,codigo,nombre,creado_en,origen) SELECT id_comunidad,'local','Local',CURRENT_TIMESTAMP,'erp1_migration' FROM comunidades",
        "INSERT INTO erp_tipos_propiedad(id_comunidad,codigo,nombre,creado_en,origen) SELECT id_comunidad,'parcela','Parcela',CURRENT_TIMESTAMP,'erp1_migration' FROM comunidades",
        "INSERT INTO erp_tipos_propiedad(id_comunidad,codigo,nombre,creado_en,origen) SELECT id_comunidad,'garaje','Garaje',CURRENT_TIMESTAMP,'erp1_migration' FROM comunidades",
        "INSERT INTO erp_tipos_propiedad(id_comunidad,codigo,nombre,creado_en,origen) SELECT id_comunidad,'trastero','Trastero',CURRENT_TIMESTAMP,'erp1_migration' FROM comunidades",
        "INSERT INTO erp_tipos_propiedad(id_comunidad,codigo,nombre,creado_en,origen) SELECT id_comunidad,'otro','Otro',CURRENT_TIMESTAMP,'erp1_migration' FROM comunidades",
        "PRAGMA legacy_alter_table=ON",
        "ALTER TABLE cf_propiedades RENAME TO cf_propiedades_erp1_legacy",
        """CREATE TABLE cf_propiedades (
            id_propiedad INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo_propiedad TEXT NOT NULL,
            codigo_normalizado TEXT NOT NULL,
            tipo_propiedad TEXT,
            zona TEXT,
            subzona TEXT,
            grupo TEXT,
            coeficiente REAL DEFAULT 0,
            activa INTEGER DEFAULT 1,
            fecha_creacion TEXT,
            fecha_ultima_actualizacion TEXT,
            id_importacion_origen INTEGER,
            id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
            id_tipo_propiedad INTEGER,
            bloque TEXT,
            portal TEXT,
            planta TEXT,
            puerta TEXT,
            descripcion_direccion TEXT,
            referencia_registral TEXT,
            referencia_catastral TEXT,
            estado TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('preparacion','activa','inactiva','baja')),
            fecha_baja TEXT,
            motivo_baja TEXT,
            calidad_dato TEXT NOT NULL DEFAULT 'observada' CHECK(calidad_dato IN ('observada','pendiente_revision','validada')),
            origen_dato TEXT NOT NULL DEFAULT 'legacy',
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            UNIQUE(id_comunidad,codigo_normalizado),
            UNIQUE(id_comunidad,id_propiedad),
            FOREIGN KEY(id_importacion_origen) REFERENCES cf_importaciones_netfincas(id_importacion),
            FOREIGN KEY(id_comunidad,id_tipo_propiedad) REFERENCES erp_tipos_propiedad(id_comunidad,id_tipo_propiedad)
        )""",
        """INSERT INTO cf_propiedades(
            id_propiedad,codigo_propiedad,codigo_normalizado,tipo_propiedad,zona,subzona,grupo,coeficiente,
            activa,fecha_creacion,fecha_ultima_actualizacion,id_importacion_origen,id_comunidad,id_tipo_propiedad,
            estado,calidad_dato,origen_dato,version)
            SELECT p.id_propiedad,p.codigo_propiedad,p.codigo_normalizado,p.tipo_propiedad,p.zona,p.subzona,p.grupo,
            p.coeficiente,p.activa,p.fecha_creacion,p.fecha_ultima_actualizacion,p.id_importacion_origen,p.id_comunidad,
            COALESCE((SELECT t.id_tipo_propiedad FROM erp_tipos_propiedad t WHERE t.id_comunidad=p.id_comunidad AND t.codigo=CASE
                WHEN lower(COALESCE(p.tipo_propiedad,'')) LIKE '%garaj%' OR upper(p.codigo_propiedad) LIKE 'PLZ%' THEN 'garaje'
                WHEN lower(COALESCE(p.tipo_propiedad,'')) LIKE '%local%' THEN 'local'
                WHEN lower(COALESCE(p.tipo_propiedad,'')) LIKE '%parcela%' THEN 'parcela'
                WHEN lower(COALESCE(p.tipo_propiedad,'')) LIKE '%traster%' THEN 'trastero'
                WHEN lower(COALESCE(p.tipo_propiedad,'')) LIKE '%vivi%' THEN 'vivienda' ELSE 'otro' END),
            (SELECT t.id_tipo_propiedad FROM erp_tipos_propiedad t WHERE t.id_comunidad=p.id_comunidad AND t.codigo='otro')),
            CASE WHEN COALESCE(p.activa,1)=1 THEN 'activa' ELSE 'inactiva' END,'observada','legacy',1
            FROM cf_propiedades_erp1_legacy p""",
        "DROP TABLE cf_propiedades_erp1_legacy",
        "ALTER TABLE cf_propietarios RENAME TO cf_propietarios_erp1_legacy",
        """CREATE TABLE cf_propietarios (
            id_propietario INTEGER PRIMARY KEY AUTOINCREMENT,
            codigo_netfincas TEXT,
            nombre TEXT NOT NULL,
            nombre_normalizado TEXT,
            nif TEXT,
            direccion TEXT,
            cp TEXT,
            poblacion TEXT,
            provincia TEXT,
            activo INTEGER DEFAULT 1,
            fecha_creacion TEXT,
            fecha_ultima_actualizacion TEXT,
            id_importacion_origen INTEGER,
            id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
            tipo_persona TEXT NOT NULL DEFAULT 'desconocida' CHECK(tipo_persona IN ('fisica','juridica','desconocida')),
            nombres TEXT,
            apellidos TEXT,
            razon_social TEXT,
            tipo_identificacion TEXT,
            pais_emisor TEXT,
            idioma_preferido TEXT,
            estado TEXT NOT NULL DEFAULT 'activo' CHECK(estado IN ('preparacion','activo','inactivo','baja')),
            calidad_identidad TEXT NOT NULL DEFAULT 'observada' CHECK(calidad_identidad IN ('observada','pendiente_desglosar','pendiente_revision','validada')),
            origen_dato TEXT NOT NULL DEFAULT 'legacy',
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            UNIQUE(id_comunidad,codigo_netfincas),
            UNIQUE(id_comunidad,id_propietario),
            FOREIGN KEY(id_importacion_origen) REFERENCES cf_importaciones_netfincas(id_importacion)
        )""",
        """INSERT INTO cf_propietarios(
            id_propietario,codigo_netfincas,nombre,nombre_normalizado,nif,direccion,cp,poblacion,provincia,activo,
            fecha_creacion,fecha_ultima_actualizacion,id_importacion_origen,id_comunidad,tipo_persona,estado,
            calidad_identidad,origen_dato,version)
            SELECT id_propietario,codigo_netfincas,nombre,nombre_normalizado,nif,direccion,cp,poblacion,provincia,activo,
            fecha_creacion,fecha_ultima_actualizacion,id_importacion_origen,id_comunidad,'desconocida',
            CASE WHEN COALESCE(activo,1)=1 THEN 'activo' ELSE 'inactivo' END,
            CASE WHEN instr(nombre,' / ')>0 OR instr(nombre,' & ')>0 THEN 'pendiente_desglosar' ELSE 'observada' END,
            'legacy',1 FROM cf_propietarios_erp1_legacy""",
        "DROP TABLE cf_propietarios_erp1_legacy",
        "PRAGMA legacy_alter_table=OFF",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN valor_normalizado TEXT",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN etiqueta TEXT",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN verificado INTEGER NOT NULL DEFAULT 0 CHECK(verificado IN (0,1))",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN uso_preferido TEXT",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN efectiva_desde TEXT",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN efectiva_hasta TEXT",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN procedencia TEXT NOT NULL DEFAULT 'legacy'",
        "ALTER TABLE cf_contactos_propietario ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)",
        "UPDATE cf_contactos_propietario SET valor_normalizado=lower(trim(valor)) WHERE valor_normalizado IS NULL",
        "ALTER TABLE cf_propietario_propiedad ADD COLUMN porcentaje_titularidad_decimal TEXT",
        "ALTER TABLE cf_propietario_propiedad ADD COLUMN calidad TEXT NOT NULL DEFAULT 'observada' CHECK(calidad IN ('propuesta','pendiente_documentacion','observada','validada'))",
        "ALTER TABLE cf_propietario_propiedad ADD COLUMN procedencia TEXT NOT NULL DEFAULT 'legacy'",
        "ALTER TABLE cf_propietario_propiedad ADD COLUMN id_documento_evidencia INTEGER",
        "ALTER TABLE cf_propietario_propiedad ADD COLUMN fecha_conocimiento TEXT",
        "ALTER TABLE cf_propietario_propiedad ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)",
        "UPDATE cf_propietario_propiedad SET porcentaje_titularidad_decimal=CAST(porcentaje_titularidad AS TEXT) WHERE porcentaje_titularidad_decimal IS NULL",
        "UPDATE cf_propietario_propiedad SET fecha_conocimiento=COALESCE(fecha_desde,CURRENT_TIMESTAMP) WHERE fecha_conocimiento IS NULL",
        "CREATE UNIQUE INDEX IF NOT EXISTS ux_cf_relacion_tenant_id ON cf_propietario_propiedad(id_comunidad,id_relacion)",
        """CREATE TABLE IF NOT EXISTS erp_propiedad_aliases (
            id_alias INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_propiedad INTEGER NOT NULL,
            alias TEXT NOT NULL,
            alias_normalizado TEXT NOT NULL,
            tipo TEXT NOT NULL DEFAULT 'busqueda',
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            activo INTEGER NOT NULL DEFAULT 1 CHECK(activo IN (0,1)),
            origen TEXT NOT NULL,
            creado_en TEXT NOT NULL,
            creado_por INTEGER,
            UNIQUE(id_comunidad,id_propiedad,alias_normalizado),
            FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(creado_por) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_propiedad_relaciones (
            id_relacion_propiedad INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_propiedad_origen INTEGER NOT NULL,
            id_propiedad_destino INTEGER NOT NULL,
            tipo TEXT NOT NULL CHECK(tipo IN ('anexo','segregacion','agrupacion','otra')),
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            estado TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('propuesta','activa','inactiva')),
            motivo TEXT,
            evidencia_tipo TEXT,
            evidencia_id TEXT,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            creada_en TEXT NOT NULL,
            creada_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,id_propiedad_origen,id_propiedad_destino,tipo,efectiva_desde),
            FOREIGN KEY(id_comunidad,id_propiedad_origen) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(id_comunidad,id_propiedad_destino) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(creada_por) REFERENCES usuarios(id_usuario),
            CHECK(id_propiedad_origen <> id_propiedad_destino),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_propiedad_agrupaciones (
            id_pertenencia INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_propiedad INTEGER NOT NULL,
            id_agrupacion INTEGER NOT NULL,
            rol TEXT NOT NULL DEFAULT 'estructural',
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            origen TEXT NOT NULL,
            creada_en TEXT NOT NULL,
            creada_por INTEGER NOT NULL,
            UNIQUE(id_comunidad,id_propiedad,id_agrupacion,rol,efectiva_desde),
            FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(id_comunidad,id_agrupacion) REFERENCES erp_agrupaciones(id_comunidad,id_agrupacion),
            FOREIGN KEY(creada_por) REFERENCES usuarios(id_usuario),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_preferencias_comunicacion (
            id_preferencia INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_propietario INTEGER NOT NULL,
            canal TEXT NOT NULL,
            idioma TEXT,
            id_contacto INTEGER,
            alcance TEXT,
            base_autorizacion TEXT,
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            estado TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('propuesta','activa','inactiva')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            origen TEXT NOT NULL,
            creada_en TEXT NOT NULL,
            creada_por INTEGER NOT NULL,
            FOREIGN KEY(id_comunidad,id_propietario) REFERENCES cf_propietarios(id_comunidad,id_propietario),
            FOREIGN KEY(id_contacto) REFERENCES cf_contactos_propietario(id_contacto),
            FOREIGN KEY(creada_por) REFERENCES usuarios(id_usuario),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_titularidad_versiones (
            id_titularidad_version INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_relacion INTEGER NOT NULL,
            id_propiedad INTEGER NOT NULL,
            id_propietario INTEGER NOT NULL,
            porcentaje_decimal TEXT,
            porcentaje_original TEXT,
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            calidad TEXT NOT NULL CHECK(calidad IN ('propuesta','pendiente_documentacion','observada','validada')),
            composicion_completa INTEGER NOT NULL DEFAULT 0 CHECK(composicion_completa IN (0,1)),
            anulada INTEGER NOT NULL DEFAULT 0 CHECK(anulada IN (0,1)),
            motivo TEXT,
            registrada_en TEXT NOT NULL,
            registrada_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            evidencia_tipo TEXT,
            evidencia_id TEXT,
            id_importacion INTEGER,
            fila_origen TEXT,
            id_version_sustituida INTEGER,
            id_operacion TEXT NOT NULL,
            version_concurrencia INTEGER NOT NULL DEFAULT 1 CHECK(version_concurrencia > 0),
            UNIQUE(id_relacion,version_concurrencia),
            UNIQUE(id_comunidad,id_titularidad_version),
            FOREIGN KEY(id_comunidad,id_relacion) REFERENCES cf_propietario_propiedad(id_comunidad,id_relacion),
            FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(id_comunidad,id_propietario) REFERENCES cf_propietarios(id_comunidad,id_propietario),
            FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario),
            FOREIGN KEY(id_importacion) REFERENCES cf_importaciones_netfincas(id_importacion),
            FOREIGN KEY(id_version_sustituida) REFERENCES erp_titularidad_versiones(id_titularidad_version),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """INSERT INTO erp_titularidad_versiones(
            id_comunidad,id_relacion,id_propiedad,id_propietario,porcentaje_decimal,porcentaje_original,
            efectiva_desde,efectiva_hasta,calidad,composicion_completa,motivo,registrada_en,registrada_por,
            origen,id_importacion,id_operacion,version_concurrencia)
            SELECT r.id_comunidad,r.id_relacion,r.id_propiedad,r.id_propietario,r.porcentaje_titularidad_decimal,
            CAST(r.porcentaje_titularidad AS TEXT),NULLIF(trim(r.fecha_desde),''),NULLIF(trim(r.fecha_hasta),''),'observada',
            CASE WHEN r.porcentaje_titularidad_decimal='100.0' OR r.porcentaje_titularidad_decimal='100' THEN 1 ELSE 0 END,
            r.motivo,COALESCE(r.fecha_conocimiento,CURRENT_TIMESTAMP),
            COALESCE((SELECT MIN(id_usuario) FROM usuarios WHERE activo=1),1),'legacy',r.id_importacion_origen,
            'ERP1-MIGRATION-'||r.id_relacion,1 FROM cf_propietario_propiedad r""",
        """CREATE TABLE IF NOT EXISTS erp_titularidad_propuestas (
            id_propuesta INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_propiedad INTEGER NOT NULL,
            efectiva_desde TEXT,
            fecha_conocimiento TEXT NOT NULL,
            calidad TEXT NOT NULL CHECK(calidad IN ('pendiente_documentacion','observada','validada')),
            composicion_completa INTEGER NOT NULL CHECK(composicion_completa IN (0,1)),
            estado TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','confirmada','cancelada')),
            motivo TEXT,
            evidencia_tipo TEXT,
            evidencia_id TEXT,
            creada_en TEXT NOT NULL,
            creada_por INTEGER NOT NULL,
            confirmada_en TEXT,
            confirmada_por INTEGER,
            id_operacion TEXT,
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(creada_por) REFERENCES usuarios(id_usuario),
            FOREIGN KEY(confirmada_por) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_titularidad_propuesta_lineas (
            id_linea INTEGER PRIMARY KEY AUTOINCREMENT,
            id_propuesta INTEGER NOT NULL,
            id_propietario INTEGER NOT NULL,
            porcentaje_decimal TEXT,
            porcentaje_original TEXT,
            calidad TEXT NOT NULL CHECK(calidad IN ('pendiente_documentacion','observada','validada')),
            UNIQUE(id_propuesta,id_propietario),
            FOREIGN KEY(id_propuesta) REFERENCES erp_titularidad_propuestas(id_propuesta) ON DELETE CASCADE,
            FOREIGN KEY(id_propietario) REFERENCES cf_propietarios(id_propietario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_grupos_reparto (
            id_grupo INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            codigo TEXT NOT NULL,
            nombre TEXT NOT NULL,
            finalidad TEXT,
            estado TEXT NOT NULL DEFAULT 'preparacion' CHECK(estado IN ('preparacion','activo','inactivo')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            creado_en TEXT NOT NULL,
            creado_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,codigo),
            UNIQUE(id_comunidad,id_grupo),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(creado_por) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_grupo_versiones (
            id_grupo_version INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_grupo INTEGER NOT NULL,
            version INTEGER NOT NULL CHECK(version > 0),
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            base TEXT NOT NULL CHECK(base IN ('porcentaje','peso','sin_coeficiente','otra')),
            suma_esperada_decimal TEXT,
            tolerancia_importacion_decimal TEXT,
            criterio_documental TEXT,
            estado TEXT NOT NULL DEFAULT 'borrador' CHECK(estado IN ('borrador','observada','aprobada','sustituida','anulada')),
            evidencia_tipo TEXT,
            evidencia_id TEXT,
            registrada_en TEXT NOT NULL,
            registrada_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_grupo,version),
            FOREIGN KEY(id_comunidad,id_grupo) REFERENCES erp_grupos_reparto(id_comunidad,id_grupo),
            FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_grupo_miembros (
            id_miembro INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_grupo INTEGER NOT NULL,
            id_propiedad INTEGER NOT NULL,
            creado_en TEXT NOT NULL,
            creado_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,id_grupo,id_propiedad),
            UNIQUE(id_comunidad,id_miembro),
            FOREIGN KEY(id_comunidad,id_grupo) REFERENCES erp_grupos_reparto(id_comunidad,id_grupo),
            FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(creado_por) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_grupo_miembro_versiones (
            id_miembro_version INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_miembro INTEGER NOT NULL,
            version INTEGER NOT NULL CHECK(version > 0),
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            participa INTEGER NOT NULL CHECK(participa IN (0,1)),
            excluida INTEGER NOT NULL DEFAULT 0 CHECK(excluida IN (0,1)),
            motivo TEXT,
            evidencia_tipo TEXT,
            evidencia_id TEXT,
            registrada_en TEXT NOT NULL,
            registrada_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_miembro,version),
            FOREIGN KEY(id_comunidad,id_miembro) REFERENCES erp_grupo_miembros(id_comunidad,id_miembro),
            FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario),
            CHECK(NOT(participa=1 AND excluida=1)),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_coeficiente_series (
            id_serie INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_propiedad INTEGER NOT NULL,
            id_grupo INTEGER,
            finalidad TEXT NOT NULL,
            unidad TEXT NOT NULL CHECK(unidad IN ('porcentaje','tanto_por_uno','peso','otra')),
            escala INTEGER NOT NULL DEFAULT 12 CHECK(escala >= 0 AND escala <= 30),
            estado TEXT NOT NULL DEFAULT 'activa' CHECK(estado IN ('preparacion','activa','inactiva')),
            version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
            creada_en TEXT NOT NULL,
            creada_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,id_propiedad,id_grupo,finalidad,unidad),
            UNIQUE(id_comunidad,id_serie),
            FOREIGN KEY(id_comunidad,id_propiedad) REFERENCES cf_propiedades(id_comunidad,id_propiedad),
            FOREIGN KEY(id_comunidad,id_grupo) REFERENCES erp_grupos_reparto(id_comunidad,id_grupo),
            FOREIGN KEY(creada_por) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_coeficiente_versiones (
            id_coeficiente_version INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            id_serie INTEGER NOT NULL,
            version INTEGER NOT NULL CHECK(version > 0),
            efectiva_desde TEXT,
            efectiva_hasta TEXT,
            valor_decimal TEXT NOT NULL,
            valor_original TEXT,
            precision_original INTEGER,
            calidad TEXT NOT NULL CHECK(calidad IN ('pendiente_documentacion','observada','validada')),
            estado TEXT NOT NULL DEFAULT 'observada' CHECK(estado IN ('borrador','observada','aprobada','sustituida','anulada')),
            registrada_en TEXT NOT NULL,
            registrada_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            evidencia_tipo TEXT,
            evidencia_id TEXT,
            id_importacion INTEGER,
            fila_origen TEXT,
            id_version_sustituida INTEGER,
            UNIQUE(id_serie,version),
            FOREIGN KEY(id_comunidad,id_serie) REFERENCES erp_coeficiente_series(id_comunidad,id_serie),
            FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario),
            FOREIGN KEY(id_importacion) REFERENCES cf_importaciones_netfincas(id_importacion),
            FOREIGN KEY(id_version_sustituida) REFERENCES erp_coeficiente_versiones(id_coeficiente_version),
            CHECK(efectiva_hasta IS NULL OR efectiva_desde IS NULL OR efectiva_hasta > efectiva_desde)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_fuente_registros (
            id_fuente_registro INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            sistema_origen TEXT NOT NULL,
            entidad_origen TEXT NOT NULL,
            codigo_origen TEXT,
            id_importacion INTEGER,
            fila_origen TEXT,
            campo_origen TEXT,
            valor_original TEXT,
            entidad_destino TEXT NOT NULL,
            id_destino TEXT NOT NULL,
            decision TEXT NOT NULL,
            incidencia TEXT,
            resolucion TEXT,
            hash_hecho TEXT NOT NULL,
            registrada_en TEXT NOT NULL,
            registrada_por INTEGER NOT NULL,
            UNIQUE(id_comunidad,sistema_origen,hash_hecho),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(id_importacion) REFERENCES cf_importaciones_netfincas(id_importacion),
            FOREIGN KEY(registrada_por) REFERENCES usuarios(id_usuario)
        )""",
        """CREATE TABLE IF NOT EXISTS erp_master_document_links (
            id_enlace INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            entidad_tipo TEXT NOT NULL,
            entidad_id TEXT NOT NULL,
            documento_tipo TEXT NOT NULL,
            documento_id TEXT NOT NULL,
            finalidad TEXT,
            creado_en TEXT NOT NULL,
            creado_por INTEGER NOT NULL,
            origen TEXT NOT NULL,
            UNIQUE(id_comunidad,entidad_tipo,entidad_id,documento_tipo,documento_id,finalidad),
            FOREIGN KEY(id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY(creado_por) REFERENCES usuarios(id_usuario)
        )""",
        """INSERT INTO erp_grupos_reparto(id_comunidad,codigo,nombre,finalidad,estado,creado_en,creado_por,origen)
            SELECT DISTINCT p.id_comunidad,'LEGACY_GENERAL','Coeficiente general importado (sin validar)',
            'compatibilidad de coeficientes históricos','preparacion',CURRENT_TIMESTAMP,
            COALESCE((SELECT MIN(id_usuario) FROM usuarios WHERE activo=1),1),'erp1_migration'
            FROM cf_propiedades p WHERE p.coeficiente IS NOT NULL""",
        """INSERT INTO erp_grupo_versiones(id_comunidad,id_grupo,version,base,suma_esperada_decimal,
            estado,criterio_documental,registrada_en,registrada_por,origen)
            SELECT g.id_comunidad,g.id_grupo,1,'porcentaje',NULL,'observada',
            'Origen REAL legacy; requiere contraste con documento fuente',CURRENT_TIMESTAMP,g.creado_por,'erp1_migration'
            FROM erp_grupos_reparto g WHERE g.codigo='LEGACY_GENERAL'""",
        """INSERT INTO erp_grupo_miembros(id_comunidad,id_grupo,id_propiedad,creado_en,creado_por,origen)
            SELECT p.id_comunidad,g.id_grupo,p.id_propiedad,CURRENT_TIMESTAMP,g.creado_por,'erp1_migration'
            FROM cf_propiedades p JOIN erp_grupos_reparto g ON g.id_comunidad=p.id_comunidad AND g.codigo='LEGACY_GENERAL'""",
        """INSERT INTO erp_grupo_miembro_versiones(id_comunidad,id_miembro,version,participa,excluida,
            registrada_en,registrada_por,origen)
            SELECT m.id_comunidad,m.id_miembro,1,1,0,CURRENT_TIMESTAMP,m.creado_por,'erp1_migration'
            FROM erp_grupo_miembros m""",
        """INSERT INTO erp_coeficiente_series(id_comunidad,id_propiedad,id_grupo,finalidad,unidad,escala,
            estado,creada_en,creada_por,origen)
            SELECT p.id_comunidad,p.id_propiedad,g.id_grupo,'general_legacy','porcentaje',12,'preparacion',
            CURRENT_TIMESTAMP,g.creado_por,'erp1_migration'
            FROM cf_propiedades p JOIN erp_grupos_reparto g ON g.id_comunidad=p.id_comunidad AND g.codigo='LEGACY_GENERAL'
            WHERE p.coeficiente IS NOT NULL""",
        """INSERT INTO erp_coeficiente_versiones(id_comunidad,id_serie,version,valor_decimal,valor_original,
            precision_original,calidad,estado,registrada_en,registrada_por,origen,id_importacion)
            SELECT s.id_comunidad,s.id_serie,1,CAST(p.coeficiente AS TEXT),CAST(p.coeficiente AS TEXT),NULL,
            'observada','observada',CURRENT_TIMESTAMP,s.creada_por,'legacy',p.id_importacion_origen
            FROM erp_coeficiente_series s JOIN cf_propiedades p ON p.id_propiedad=s.id_propiedad""",
        "CREATE INDEX IF NOT EXISTS idx_erp_ejercicios_periodo ON erp_ejercicios(id_comunidad,fecha_inicio,fecha_fin,estado)",
        "CREATE INDEX IF NOT EXISTS idx_erp_agrupaciones_padre ON erp_agrupaciones(id_comunidad,id_padre)",
        "CREATE INDEX IF NOT EXISTS idx_cf_propiedades_busqueda ON cf_propiedades(id_comunidad,codigo_normalizado,estado)",
        "CREATE INDEX IF NOT EXISTS idx_cf_propietarios_busqueda ON cf_propietarios(id_comunidad,nombre_normalizado,estado)",
        "CREATE INDEX IF NOT EXISTS idx_cf_contactos_normalizado ON cf_contactos_propietario(id_comunidad,tipo,valor_normalizado)",
        "CREATE INDEX IF NOT EXISTS idx_erp_titularidad_temporal ON erp_titularidad_versiones(id_comunidad,id_propiedad,efectiva_desde,efectiva_hasta,registrada_en)",
        "CREATE INDEX IF NOT EXISTS idx_erp_coeficiente_temporal ON erp_coeficiente_versiones(id_comunidad,id_serie,efectiva_desde,efectiva_hasta)",
        "CREATE INDEX IF NOT EXISTS idx_erp_grupo_miembro_temporal ON erp_grupo_miembro_versiones(id_comunidad,id_miembro,efectiva_desde,efectiva_hasta)",
        "CREATE INDEX IF NOT EXISTS idx_erp_fuente_destino ON erp_fuente_registros(id_comunidad,entidad_destino,id_destino)",
    ), True),
)


def _bootstrap(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS erp_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at_utc TEXT NOT NULL
    )""")


def apply_all(conn, migrations=MIGRATIONS):
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    _bootstrap(conn)
    applied = {int(row[0]): (row[1], row[2]) for row in conn.execute(
        "SELECT version,name,checksum FROM erp_schema_migrations"
    )}
    last = 0
    for migration in migrations:
        if migration.version <= last:
            raise RuntimeError("Las migraciones ERP no tienen un orden creciente unico.")
        last = migration.version
        previous = applied.get(migration.version)
        if previous:
            if previous != (migration.name, migration.checksum):
                raise RuntimeError(f"La migracion ERP {migration.version} no coincide con la aplicada.")
            continue
        if migration.foreign_keys_off:
            conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN IMMEDIATE")
        try:
            for statement in migration.statements:
                conn.execute(statement)
            if migration.foreign_keys_off:
                violations = list(conn.execute("PRAGMA foreign_key_check"))
                if violations:
                    raise RuntimeError(
                        f"La migracion ERP {migration.version} deja {len(violations)} relaciones invalidas."
                    )
            conn.execute(
                "INSERT INTO erp_schema_migrations(version,name,checksum,applied_at_utc) VALUES (?,?,?,?)",
                (migration.version, migration.name, migration.checksum, utc_now()),
            )
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()
        finally:
            if migration.foreign_keys_off:
                conn.execute("PRAGMA foreign_keys=ON")
    return {"schema_version": max(applied.keys() | {m.version for m in migrations}, default=0)}
