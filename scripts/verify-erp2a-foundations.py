"""Verify ERP 2A contracts and migration on an isolated database copy."""

from pathlib import Path
import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from access_control import budget_defaults, budget_permission, profile, save_permissions
from erp_core.budget_contracts import (
    CONTRACT_VERSION, Money, PLANNED_COMMANDS, ROUNDING_VERSION,
    contract_catalog, exact_decimal,
)
from erp_core.dispatcher import catalog, execute_command
from erp_core.errors import ContractError, NotFoundError
from erp_core.migrations import apply_all


parser = argparse.ArgumentParser()
parser.add_argument("database", type=Path)
parser.add_argument("--keep", action="store_true")
args = parser.parse_args()
source = args.database.resolve()
if not source.is_file():
    raise SystemExit("Indica una base SQLite de origen.")

work = Path(tempfile.mkdtemp(prefix="organizador-erp2a-foundations-"))
database = work / "database.db"
source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
target_connection = sqlite3.connect(database)
source_connection.backup(target_connection)
source_connection.close()
target_connection.close()


def table_hash(conn, table):
    rows = [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
    return hashlib.sha256(repr(rows).encode()).hexdigest()


checks = []
try:
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    protected = ("cf_propiedades", "cf_propietarios", "cf_propietario_propiedad", "cf_recibos", "asamblea_censo")
    before_counts = {table: conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] for table in protected}
    before_hashes = {table: table_hash(conn, table) for table in protected}

    first = apply_all(conn)
    migrations = list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    second = apply_all(conn)
    assert first["schema_version"] == 3 and second["schema_version"] == 3
    assert migrations == list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(conn.execute("PRAGMA foreign_key_check"))
    for table in protected:
        assert conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == before_counts[table]
        assert table_hash(conn, table) == before_hashes[table]
    checks.append("migracion 3 aditiva, reentrante e integra; maestros, recibos y asambleas intactos")

    expected_tables = {
        "erp_presupuesto_permisos", "erp_presupuestos", "erp_presupuesto_versiones",
        "erp_presupuesto_capitulos", "erp_presupuesto_partidas", "erp_partida_repartos",
        "erp_partida_financiaciones", "erp_partida_exenciones", "erp_reglas_reparto",
        "erp_regla_versiones", "erp_regla_componentes", "erp_simulaciones",
        "erp_simulacion_entradas", "erp_calculo_lineas", "erp_calculo_periodos",
        "erp_calculo_incidencias", "erp_planes_cuota", "erp_plan_versiones",
        "erp_plan_periodos", "erp_presupuesto_actos", "erp_presupuesto_correspondencias",
        "erp_plan_sucesiones", "erp_derramas", "erp_derrama_repartos",
        "erp_regularizaciones", "erp_regularizacion_lineas", "erp_regularizacion_origenes",
        "erp_ajustes_plan", "erp_personas_cobro", "erp_persona_cobro_contactos",
        "erp_ocupaciones", "erp_ocupacion_versiones", "erp_ocupacion_personas",
        "erp_config_recibo_versiones", "erp_plan_destinatarios_snapshot",
        "erp_importaciones_presupuesto", "erp_importacion_presupuesto_filas",
    }
    actual_tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert expected_tables <= actual_tables
    for table in expected_tables:
        for column in conn.execute(f'PRAGMA table_info("{table}")'):
            assert str(column[2]).upper() not in {"REAL", "FLOAT", "DOUBLE"}, (table, column[1])
    checks.append("modelo ERP 2A completo sin columnas economicas REAL/FLOAT/DOUBLE")

    superuser = conn.execute("SELECT id_usuario,nombre FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()
    if not superuser:
        superuser = conn.execute("SELECT id_usuario,nombre FROM usuarios WHERE activo=1 LIMIT 1").fetchone()
    actor_id = int(superuser[0])
    now = "2026-09-10T15:30:00Z"
    with conn:
        community = conn.execute("""INSERT INTO comunidades
            (nombre,descripcion,activo,codigo,denominacion,moneda,estado_operativo,version)
            VALUES ('ERP2A Prueba','Solo fixture aislado',1,'ERP2A-TEST','ERP2A Prueba','EUR','activa',1)""").lastrowid
        other = conn.execute("""INSERT INTO comunidades
            (nombre,descripcion,activo,codigo,denominacion,moneda,estado_operativo,version)
            VALUES ('ERP2A Otra','Solo fixture aislado',1,'ERP2A-OTHER','ERP2A Otra','EUR','activa',1)""").lastrowid
        worker = conn.execute("INSERT INTO usuarios(nombre,rol,activo) VALUES ('ERP2A Worker','Usuario',1)").lastrowid
        conn.execute("INSERT INTO usuario_comunidad(id_usuario,id_comunidad) VALUES (?,?)", (worker, community))
        save_permissions(conn, worker, community, "Usuario", {
            "puede_ver": 1, "puede_crear": 1, "puede_actualizar": 1,
            "puede_ver_documentos": 1, "puede_generar_informes": 1,
            "puede_gestionar_asambleas": 0, "puede_gestionar_seguridad": 0,
        })
    worker_session = profile(conn, worker)
    assert budget_permission(conn, worker_session, community, "puede_ver")
    assert budget_permission(conn, worker_session, community, "puede_preparar")
    assert not budget_permission(conn, worker_session, community, "puede_aprobar")
    assert not budget_permission(conn, worker_session, other, "puede_ver")
    assert budget_defaults("Administrador")["puede_aprobar"] == 1
    checks.append("capacidades economicas explicitas y aisladas por usuario/comunidad")

    with conn:
        exercise = conn.execute("""INSERT INTO erp_ejercicios
            (id_comunidad,codigo,fecha_inicio,fecha_fin,moneda,estado,creado_en,creado_por,origen)
            VALUES (?,?,?,?,?,'preparacion',?,?,?)""",
            (community, "2027", "2027-01-01", "2027-12-31", "EUR", now, actor_id, "test")).lastrowid
        type_id = conn.execute("""INSERT INTO erp_tipos_propiedad
            (id_comunidad,codigo,nombre,creado_en,origen) VALUES (?,?,?,?,?)""",
            (community, "vivienda", "Vivienda", now, "test")).lastrowid
        properties = []
        for index in range(1, 4):
            properties.append(conn.execute("""INSERT INTO cf_propiedades
                (id_comunidad,codigo_propiedad,codigo_normalizado,id_tipo_propiedad,tipo_propiedad,
                 activa,estado,calidad_dato,version,fecha_creacion,fecha_ultima_actualizacion,origen_dato)
                VALUES (?,?,?,?,?,1,'activa','validada',1,?,?,?)""",
                (community, f"P-{index}", f"P {index}", type_id, "vivienda", now, now, "test")).lastrowid)
        group = conn.execute("""INSERT INTO erp_grupos_reparto
            (id_comunidad,codigo,nombre,finalidad,estado,creado_en,creado_por,origen)
            VALUES (?,?,?,?,'activo',?,?,?)""",
            (community, "GENERAL", "General", "Prueba exacta", now, actor_id, "test")).lastrowid
        group_version = conn.execute("""INSERT INTO erp_grupo_versiones
            (id_comunidad,id_grupo,version,base,suma_esperada_decimal,estado,
             registrada_en,registrada_por,origen)
            VALUES (?,?,1,'porcentaje','100','aprobada',?,?,?)""",
            (community, group, now, actor_id, "test")).lastrowid
        for prop, value in zip(properties, ("33.333333333333", "33.333333333333", "33.333333333334")):
            member = conn.execute("""INSERT INTO erp_grupo_miembros
                (id_comunidad,id_grupo,id_propiedad,creado_en,creado_por,origen)
                VALUES (?,?,?,?,?,?)""", (community, group, prop, now, actor_id, "test")).lastrowid
            member_version = conn.execute("""INSERT INTO erp_grupo_miembro_versiones
                (id_comunidad,id_miembro,version,participa,excluida,registrada_en,registrada_por,origen)
                VALUES (?,?,1,1,0,?,?,?)""", (community, member, now, actor_id, "test")).lastrowid
            series = conn.execute("""INSERT INTO erp_coeficiente_series
                (id_comunidad,id_propiedad,id_grupo,finalidad,unidad,escala,estado,creada_en,creada_por,origen)
                VALUES (?,?,?,'general','porcentaje',12,'activa',?,?,?)""",
                (community, prop, group, now, actor_id, "test")).lastrowid
            coefficient_version = conn.execute("""INSERT INTO erp_coeficiente_versiones
                (id_comunidad,id_serie,version,valor_decimal,valor_original,precision_original,
                 calidad,estado,registrada_en,registrada_por,origen)
                VALUES (?,?,1,?,?,12,'validada','aprobada',?,?,?)""",
                (community, series, value, value, now, actor_id, "test")).lastrowid
        rule = conn.execute("""INSERT INTO erp_reglas_reparto
            (id_comunidad,codigo,nombre,tipo,estado,creada_en,creada_por,origen)
            VALUES (?,?,?,'coeficiente','activa',?,?,?)""",
            (community, "COEF-GENERAL", "Por coeficiente general", now, actor_id, "test")).lastrowid
        rule_version = conn.execute("""INSERT INTO erp_regla_versiones
            (id_comunidad,id_regla,version,codigo_motor,version_motor,parametros_json,
             esquema_parametros_json,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,'coefficient','erp2-rational-v1',?,?,'aprobada',?,?,?)""",
            (community, rule, json.dumps({"group_id": group, "series_purpose": "general", "series_unit": "porcentaje"}),
             json.dumps({"type": "object"}), now, actor_id, "test")).lastrowid
        budget = conn.execute("""INSERT INTO erp_presupuestos
            (id_comunidad,id_ejercicio,codigo,denominacion,tipo,moneda,estado,creado_en,creado_por,origen)
            VALUES (?,?,?,?,'ordinario','EUR','borrador',?,?,?)""",
            (community, exercise, "P-2027", "Presupuesto 2027", now, actor_id, "test")).lastrowid
        budget_version = conn.execute("""INSERT INTO erp_presupuesto_versiones
            (id_comunidad,id_presupuesto,version,fecha_inicio,fecha_fin,periodicidad,
             dia_emision_previsto,dia_vencimiento,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,'2027-01-01','2027-12-31','mensual',3,10,'borrador',?,?,?)""",
            (community, budget, now, actor_id, "test")).lastrowid
        chapter = conn.execute("""INSERT INTO erp_presupuesto_capitulos
            (id_comunidad,id_presupuesto_version,clave_continuidad,codigo,nombre,orden)
            VALUES (?,?,'CAP-MANT','MANT','Mantenimiento',1)""", (community, budget_version)).lastrowid
        item = conn.execute("""INSERT INTO erp_presupuesto_partidas
            (id_comunidad,id_presupuesto_version,id_capitulo,clave_continuidad,codigo,concepto,importe_centimos,orden)
            VALUES (?,?,?,'ITEM-GEN','GEN','Mantenimiento general',10000,1)""",
            (community, budget_version, chapter)).lastrowid
        assignment = conn.execute("""INSERT INTO erp_partida_repartos
            (id_comunidad,id_partida,clave_linea,id_grupo,id_grupo_version,finalidad_serie,
             unidad_serie,id_regla_version,modo,valor_decimal,orden)
            VALUES (?,?,?, ?,?,'general','porcentaje',?,'importe','10000',1)""",
            (community, item, "DIST-GENERAL", group, group_version, rule_version)).lastrowid
        simulation = conn.execute("""INSERT INTO erp_simulaciones
            (id_comunidad,id_presupuesto_version,origen_tipo,origen_id,hash_entradas,version_motor,
             version_redondeo,fecha_referencia,conocida_en,moneda,estado,importe_objetivo_centimos,
             importe_resultado_centimos,creada_en,creada_por,completada_en,origen)
            VALUES (?,?,'presupuesto',?,'fixture-hash','erp2-rational-v1','largest-remainder-v1',
                    '2027-01-01',?,'EUR','completa',10000,10000,?,?,?,'test')""",
            (community, budget_version, str(budget), now, now, actor_id, now)).lastrowid
        conn.execute("""INSERT INTO erp_simulacion_entradas
            (id_comunidad,id_simulacion,tipo,clave,referencia_id,version_referencia,valor_json,hash_valor)
            VALUES (?,?,'budget','revision',?,1,?,'input-hash')""",
            (community, simulation, str(budget_version), json.dumps({"amount_cents": "10000"})))
        plan = conn.execute("""INSERT INTO erp_planes_cuota
            (id_comunidad,tipo,origen_tipo,origen_id,moneda,estado,creado_en,creado_por,origen)
            VALUES (?,'ordinario','presupuesto',?,'EUR','borrador',?,?,?)""",
            (community, str(budget_version), now, actor_id, "test")).lastrowid
        plan_version = conn.execute("""INSERT INTO erp_plan_versiones
            (id_comunidad,id_plan,version,id_simulacion,fecha_inicio,fecha_fin,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,?,'2027-01-01','2027-12-31','borrador',?,?,?)""",
            (community, plan, simulation, now, actor_id, "test")).lastrowid
        period = conn.execute("""INSERT INTO erp_plan_periodos
            (id_comunidad,id_plan_version,clave_periodo,fecha_inicio,fecha_fin,fecha_emision_prevista,
             fecha_vencimiento,peso_decimal,id_ejercicio,orden)
            VALUES (?,?,'2027-01','2027-01-01','2027-01-31','2027-01-03','2027-01-10','1',?,1)""",
            (community, plan_version, exercise)).lastrowid
        calculation = conn.execute("""INSERT INTO erp_calculo_lineas
            (id_comunidad,id_simulacion,id_propiedad,id_capitulo,id_partida,id_asignacion,
             id_grupo_version,id_regla_version,valor_decimal,denominador_decimal,numerador_exacto,
             denominador_exacto,importe_base_centimos,ajuste_redondeo_centimos,
             importe_final_centimos,orden_desempate)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,3333,1,3334,?)""",
            (community, simulation, properties[0], chapter, item, assignment, group_version,
             rule_version, "33.333333333333", "100", "100000000000000", "30000000000", str(properties[0]))).lastrowid
        conn.execute("""INSERT INTO erp_calculo_periodos
            (id_comunidad,id_calculo_linea,id_periodo_plan,numerador_exacto,denominador_exacto,
             importe_base_centimos,ajuste_redondeo_centimos,importe_final_centimos)
            VALUES (?,?,?,'3334','1',3334,0,3334)""", (community, calculation, period))
    assert not list(conn.execute("PRAGMA foreign_key_check"))
    assert conn.execute("SELECT SUM(importe_final_centimos) FROM erp_calculo_periodos").fetchone()[0] == 3334
    checks.append("fixture sintetico enlaza comunidad, ejercicio, presupuesto, grupo, regla, snapshot, plan y periodo")

    original_count = conn.execute("SELECT COUNT(*) FROM erp_presupuesto_partidas").fetchone()[0]
    try:
        with conn:
            conn.execute("""INSERT INTO erp_presupuesto_partidas
                (id_comunidad,id_presupuesto_version,id_capitulo,clave_continuidad,concepto,importe_centimos,orden)
                VALUES (?,?,?,?,?,?,?)""", (other, budget_version, chapter, "CROSS", "Cruce", 1, 2))
        raise AssertionError("Se admitio una FK transversal entre comunidades.")
    except sqlite3.IntegrityError:
        pass
    assert conn.execute("SELECT COUNT(*) FROM erp_presupuesto_partidas").fetchone()[0] == original_count
    checks.append("FK compuestas impiden cruces y el fallo revierte sin escritura parcial")

    assert Money.from_contract("10000").to_contract() == {"cents": "10000", "currency": "EUR"}
    assert exact_decimal("33.333333333333", "valor") == "33.333333333333"
    for invalid in ("1e2", "NaN", "1,25", "1.1234567890123456789012345678901"):
        try:
            exact_decimal(invalid, "valor")
            raise AssertionError(f"Se admitio decimal no canonico: {invalid}")
        except ContractError:
            pass
    budget_catalog = contract_catalog()
    assert budget_catalog["contract_version"] == CONTRACT_VERSION
    assert budget_catalog["rounding_version"] == ROUNDING_VERSION
    assert not budget_catalog["arbitrary_formulas"] and not budget_catalog["receipt_emission"]
    assert catalog()["erp2a"]["commands_planned_not_enabled"] == sorted(PLANNED_COMMANDS)
    checks.append("contratos exactos, tipados, sin formulas ejecutables ni emision ERP 3")

    super_session = profile(conn, actor_id)
    try:
        execute_command(str(database), super_session, {
            "command": "erp2.budget.create", "id_comunidad": community,
            "payload": {}, "idempotency_key": "not-enabled", "origin": "test",
        })
        raise AssertionError("Un comando ERP 2 incompleto quedo ejecutable.")
    except NotFoundError:
        pass
    checks.append("contratos ERP 2 visibles pero no ejecutables antes del servicio determinista")

    restored = work / "restored.db"
    target = sqlite3.connect(restored)
    conn.backup(target)
    target.close()
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    conn.close()
    restored_conn = sqlite3.connect(restored)
    assert restored_conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(restored_conn.execute("PRAGMA foreign_key_check"))
    assert restored_conn.execute("SELECT name FROM erp_schema_migrations WHERE version=3").fetchone()[0] == "erp2a_budget_foundations"
    restored_conn.close()
    checks.append("backup posterior sintetico restaurado con migracion 3 e integridad completa")

    print(json.dumps({
        "ok": True, "schema_version": 3, "checks": checks,
        "fixture": str(work), "production_modified": False,
    }, ensure_ascii=False))
finally:
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
