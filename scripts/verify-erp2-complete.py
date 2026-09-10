"""Verify the complete ERP 2 workflow on an isolated copy of a compatible database."""

from pathlib import Path
import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from erp_core.dispatcher import execute_command, execute_query
from erp_core.errors import ConflictError, ContractError
from erp_core.migrations import MIGRATIONS, apply_all


parser = argparse.ArgumentParser()
parser.add_argument("database", type=Path)
parser.add_argument("--keep", action="store_true")
args = parser.parse_args()
source = args.database.resolve()
if not source.is_file():
    raise SystemExit("Indica una base SQLite de origen.")

work = Path(tempfile.mkdtemp(prefix="organizador-erp2-complete-"))
database = work / "database.db"
source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
target_connection = sqlite3.connect(database)
source_connection.backup(target_connection)
source_connection.close()
target_connection.close()


def command(session, name, community, payload, *, expected=None, key=None, evidence=None):
    return execute_command(str(database), session, {
        "command": name,
        "id_comunidad": community,
        "payload": payload,
        "idempotency_key": key or str(uuid.uuid4()),
        "expected_version": expected,
        "reason": "Prueba integral ERP 2",
        "origin": "test",
        "evidence": evidence,
    })


def query(session, name, community, filters=None):
    return execute_query(str(database), session, {
        "query": name,
        "id_comunidad": community,
        "filters": filters or {},
    })


def make_group(conn, community, actor, properties, code, purpose, values):
    now = "2026-09-10T12:00:00Z"
    group = conn.execute("""INSERT INTO erp_grupos_reparto
        (id_comunidad,codigo,nombre,finalidad,estado,creado_en,creado_por,origen)
        VALUES (?,?,?,?, 'activo',?,?, 'test')""",
        (community, code, code.replace("_", " ").title(), purpose, now, actor)).lastrowid
    conn.execute("""INSERT INTO erp_grupo_versiones
        (id_comunidad,id_grupo,version,efectiva_desde,base,suma_esperada_decimal,
         estado,registrada_en,registrada_por,origen)
        VALUES (?,?,1,'2027-01-01','porcentaje','100','aprobada',?,?,'test')""",
        (community, group, now, actor))
    for property_id, value in zip(properties, values):
        member = conn.execute("""INSERT INTO erp_grupo_miembros
            (id_comunidad,id_grupo,id_propiedad,creado_en,creado_por,origen)
            VALUES (?,?,?,?,?,'test')""", (community, group, property_id, now, actor)).lastrowid
        conn.execute("""INSERT INTO erp_grupo_miembro_versiones
            (id_comunidad,id_miembro,version,efectiva_desde,participa,excluida,
             registrada_en,registrada_por,origen)
            VALUES (?,?,1,'2027-01-01',1,0,?,?,'test')""", (community, member, now, actor))
        series = conn.execute("""INSERT INTO erp_coeficiente_series
            (id_comunidad,id_propiedad,id_grupo,finalidad,unidad,escala,estado,
             creada_en,creada_por,origen)
            VALUES (?,?,?,?, 'porcentaje',12,'activa',?,?,'test')""",
            (community, property_id, group, purpose, now, actor)).lastrowid
        conn.execute("""INSERT INTO erp_coeficiente_versiones
            (id_comunidad,id_serie,version,efectiva_desde,valor_decimal,valor_original,
             precision_original,calidad,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,'2027-01-01',?,?,12,'validada','aprobada',?,?,'test')""",
            (community, series, value, value, now, actor))
    return group


checks = []
try:
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    before = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
              for table in ("comunidades", "cf_propiedades", "cf_propietarios", "cf_recibos", "asamblea_censo")}
    first = apply_all(conn, MIGRATIONS)
    migrations = list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    second = apply_all(conn, MIGRATIONS)
    expected_schema = MIGRATIONS[-1].version
    assert first["schema_version"] == expected_schema and second["schema_version"] == expected_schema
    assert migrations == list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(conn.execute("PRAGMA foreign_key_check"))
    for table, count in before.items():
        assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == count
    checks.append(f"migracion {expected_schema} aditiva, reentrante e integra")

    actor_row = conn.execute("SELECT id_usuario,nombre FROM usuarios WHERE activo=1 ORDER BY CASE rol WHEN 'Superusuario' THEN 0 ELSE 1 END,id_usuario LIMIT 1").fetchone()
    actor, actor_name = int(actor_row[0]), str(actor_row[1])
    now = "2026-09-10T12:00:00Z"
    community = conn.execute("""INSERT INTO comunidades
        (nombre,descripcion,activo,codigo,denominacion,moneda,estado_operativo,version)
        VALUES ('ERP2 Integral','Fixture aislado',1,'ERP2-INTEGRAL','ERP2 Integral','EUR','activa',1)""").lastrowid
    other = conn.execute("""INSERT INTO comunidades
        (nombre,descripcion,activo,codigo,denominacion,moneda,estado_operativo,version)
        VALUES ('ERP2 Aislada','Fixture aislado',1,'ERP2-OTRA','ERP2 Aislada','EUR','activa',1)""").lastrowid
    exercises = []
    for year in (2027, 2028):
        exercises.append(conn.execute("""INSERT INTO erp_ejercicios
            (id_comunidad,codigo,fecha_inicio,fecha_fin,moneda,estado,version,creado_en,creado_por,origen)
            VALUES (?,?,?,?, 'EUR','preparacion',1,?,?, 'test')""",
            (community, str(year), f"{year}-01-01", f"{year}-12-31", now, actor)).lastrowid)
    type_id = conn.execute("""INSERT INTO erp_tipos_propiedad
        (id_comunidad,codigo,nombre,creado_en,origen) VALUES (?,'vivienda','Vivienda',?,'test')""",
        (community, now)).lastrowid
    owner = conn.execute("""INSERT INTO cf_propietarios
        (id_comunidad,codigo_netfincas,nombre,nombre_normalizado,activo,fecha_creacion,
         fecha_ultima_actualizacion,tipo_persona,estado,calidad_identidad,origen_dato,version)
        VALUES (?,'ERP2-TITULAR','Titular ERP2','titular erp2',1,?,?,'fisica','activo','validada','test',1)""",
        (community, now, now)).lastrowid
    properties = []
    for index in range(1, 41):
        property_id = conn.execute("""INSERT INTO cf_propiedades
            (id_comunidad,codigo_propiedad,codigo_normalizado,id_tipo_propiedad,tipo_propiedad,
             descripcion_direccion,activa,estado,calidad_dato,version,fecha_creacion,
             fecha_ultima_actualizacion,origen_dato)
            VALUES (?,?,?,?,?,?,1,'activa','validada',1,?,?, 'test')""",
            (community, f"V-{index:02d}", f"V {index:02d}", type_id, "vivienda",
             f"Vivienda {index:02d}", now, now)).lastrowid
        relation = conn.execute("""INSERT INTO cf_propietario_propiedad
            (id_comunidad,id_propietario,id_propiedad,fecha_desde,activo,
             porcentaje_titularidad,porcentaje_titularidad_decimal,calidad,procedencia,
             fecha_conocimiento,version)
            VALUES (?,?,?,'2026-01-01',1,100,'100','validada','test',?,1)""",
            (community, owner, property_id, now)).lastrowid
        conn.execute("""INSERT INTO erp_titularidad_versiones
            (id_comunidad,id_relacion,id_propiedad,id_propietario,porcentaje_decimal,
             porcentaje_original,efectiva_desde,calidad,composicion_completa,anulada,
             registrada_en,registrada_por,origen,id_operacion,version_concurrencia)
            VALUES (?,?,?,?, '100','100','2026-01-01','validada',1,0,?,?,'test',?,1)""",
            (community, relation, property_id, owner, now, actor, f"ERP2-OWN-{index}") )
        properties.append(property_id)
    general = make_group(conn, community, actor, properties, "GENERAL", "general", ["2.5"] * 40)
    gardens = make_group(conn, community, actor, properties[:16], "JARDINES_PRIVADOS", "jardines", ["6.25"] * 16)
    conn.execute("""INSERT INTO erp_presupuesto_permisos
        (id_usuario,id_comunidad,puede_ver,puede_preparar,puede_aprobar,
         puede_configurar_cobro,activo,version,actualizado_en,actualizado_por)
        VALUES (?,?,1,1,0,0,1,1,?,?)""", (actor, community, now, actor))
    conn.commit()
    conn.close()

    session = {"id_usuario": actor, "nombre": actor_name, "rol": "Superusuario", "comunidades": [
        {"id_comunidad": community, "nombre": "ERP2 Integral", "puede_ver": 1, "puede_actualizar": 1},
        {"id_comunidad": other, "nombre": "ERP2 Aislada", "puede_ver": 1, "puede_actualizar": 1},
    ]}
    preparer = {"id_usuario": actor, "nombre": actor_name, "rol": "Usuario", "comunidades": [
        {"id_comunidad": community, "nombre": "ERP2 Integral", "puede_ver": 1, "puede_actualizar": 1},
    ]}
    permissions = query(preparer, "erp2.reference.get", community)["permissions"]
    assert permissions == {"puede_ver": True, "puede_preparar": True,
                           "puede_aprobar": False, "puede_configurar_cobro": False}
    try:
        command(preparer, "erp2.budget.create", community, {
            "id_ejercicio": 999999999, "denominacion": "No debe crearse", "periodicidad": "mensual",
        })
        raise AssertionError("El ejercicio inexistente no fue rechazado")
    except ContractError as exc:
        assert "ejercicio" in str(exc).lower()
    checks.append("perfil preparador consulta permisos y alcanza la validacion de creacion sin poder aprobar")

    create_key = str(uuid.uuid4())
    created = command(session, "erp2.budget.create", community, {
        "id_ejercicio": exercises[0], "codigo": "P-2027", "denominacion": "Presupuesto 2027",
        "periodicidad": "mensual", "dia_emision_previsto": 3, "dia_vencimiento": 10,
    }, key=create_key)
    replay = command(session, "erp2.budget.create", community, {
        "id_ejercicio": exercises[0], "codigo": "P-2027", "denominacion": "Presupuesto 2027",
        "periodicidad": "mensual", "dia_emision_previsto": 3, "dia_vencimiento": 10,
    }, key=create_key)
    assert replay["idempotent_replay"] and replay["entity"]["id_presupuesto"] == created["entity"]["id_presupuesto"]
    budget_id = created["entity"]["id_presupuesto"]
    draft = {
        "id_presupuesto": budget_id,
        "chapters": [
            {"key": "MANT", "code": "01", "name": "Mantenimiento", "items": [
                {"key": "GENERAL", "name": "Gastos generales", "amount_cents": "400000", "assignments": [
                    {"key": "GENERAL", "group_id": general, "rule_type": "coeficiente",
                     "series_purpose": "general", "series_unit": "porcentaje", "mode": "porcentaje", "value": "100"}
                ]},
                {"key": "JARDINES", "name": "Jardines privados", "amount_cents": "160000", "assignments": [
                    {"key": "JARDINES", "group_id": gardens, "rule_type": "porcentaje_especial",
                     "series_purpose": "jardines", "series_unit": "porcentaje", "mode": "porcentaje", "value": "100"}
                ]},
            ]},
        ],
    }
    saved = command(session, "erp2.budget.save", community, draft, expected=1)
    version = saved["entity"]["version_concurrencia"]
    simulation = command(session, "erp2.budget.simulate", community, {"id_presupuesto": budget_id})["entity"]
    assert simulation["status"] == "completa" and simulation["result_total_cents"] == "560000"
    detail = query(session, "erp2.budget.get", community, {"id_presupuesto": budget_id})["entity"]
    item_ids = {item["concepto"]: item["id_partida"] for chapter in detail["chapters"] for item in chapter["items"]}
    garden_lines = [line for line in simulation["lines"] if line["item_id"] == item_ids["Jardines privados"]]
    assert len(garden_lines) == 16 and {line["property_id"] for line in garden_lines} == set(properties[:16])
    assert all(line["value_decimal"] == "6.25" for line in garden_lines)
    assert all(line["value_decimal"] == "2.5" for line in simulation["lines"] if line["item_id"] == item_ids["Gastos generales"])
    assert all(sum(int(period["final_cents"]) for period in line["periods"]) == int(line["final_cents"])
               for line in simulation["lines"])
    explanation = query(session, "erp2.quota.explain", community, {
        "id_simulacion": simulation["simulation_id"], "id_propiedad": properties[0],
    })["entity"]
    assert len(explanation["details"]) == 2 and explanation["total_cents"] == "20000"
    checks.append("40 viviendas/16 bajos, coeficientes independientes, simulacion y explicacion exactas")

    try:
        bad = json.loads(json.dumps(draft))
        bad["chapters"][0]["items"][1]["assignments"][0]["group_id"] = 999999999
        command(session, "erp2.budget.save", community, bad, expected=version)
        raise AssertionError("El guardado invalido no fallo")
    except ContractError:
        pass
    after_rollback = query(session, "erp2.budget.get", community, {"id_presupuesto": budget_id})["entity"]
    assert after_rollback["version_concurrencia"] == version and len(after_rollback["chapters"][0]["items"]) == 2
    checks.append("rollback completo y control de version del borrador")

    proposed = command(session, "erp2.budget.propose", community, {"id_presupuesto": budget_id}, expected=version)
    approved = command(session, "erp2.budget.approve", community, {
        "id_presupuesto": budget_id, "date": "2026-12-15", "reason": "Aprobacion sintetica",
    }, expected=proposed["entity"]["version_concurrencia"], evidence={"type": "acta", "id": "TEST-ACTA-2027"})
    plan_id = approved["entity"]["id_plan"]
    plan = query(session, "erp2.plan.export.preview", community, {"id_plan": plan_id})["entity"]
    assert len(plan["periods"]) == 12 and len(plan["quotas"]) == 40 and not plan["receipt_emission"]
    conn = sqlite3.connect(database)
    before_hash = conn.execute("SELECT hash_resultado FROM erp_simulacion_resultados WHERE id_simulacion=?", (simulation["simulation_id"],)).fetchone()[0]
    coefficient = conn.execute("SELECT id_coeficiente_version FROM erp_coeficiente_versiones WHERE id_comunidad=? ORDER BY id_coeficiente_version LIMIT 1", (community,)).fetchone()[0]
    conn.execute("UPDATE erp_coeficiente_versiones SET valor_decimal='99' WHERE id_coeficiente_version=?", (coefficient,))
    conn.commit()
    assert query(session, "erp2.simulation.get", community, {"id_simulacion": simulation["simulation_id"]})["entity"]["result_hash"] == before_hash
    conn.execute("UPDATE erp_coeficiente_versiones SET valor_decimal='2.5' WHERE id_coeficiente_version=?", (coefficient,))
    conn.commit()
    try:
        conn.execute("UPDATE erp_presupuesto_versiones SET periodicidad='anual' WHERE id_presupuesto_version=?", (created["entity"]["id_presupuesto_version"],))
        conn.commit()
        raise AssertionError("La version aprobada fue editable")
    except sqlite3.IntegrityError:
        conn.rollback()
    conn.close()
    checks.append("aprobacion, plan sin recibos, snapshot congelado e inmutabilidad verificadas")

    copied = command(session, "erp2.budget.copy", community, {
        "source_budget_id": budget_id, "id_ejercicio": exercises[1], "codigo": "P-2028",
        "denominacion": "Presupuesto 2028",
    })["entity"]
    comparison = query(session, "erp2.budget.compare", community, {
        "id_presupuesto": copied["id_presupuesto"], "previous_budget_id": budget_id,
    })
    assert comparison["previous"]["id"] == budget_id and comparison["summary"]["difference_cents"] == 0
    assert comparison["chapters"] and all(line["difference_cents"] == 0 for line in comparison["lines"])
    preview = command(session, "erp2.budget.import.preview", community, {
        "filename": "presupuesto.tsv", "text": "Mantenimiento\tElectricidad\t1200,50\nAdministracion\tOficina\t300,00",
    })["entity"]
    duplicate_preview = command(session, "erp2.budget.import.preview", community, {
        "filename": "presupuesto.tsv", "text": "Mantenimiento\tElectricidad\t1200,50\nAdministracion\tOficina\t300,00",
    })["entity"]
    assert duplicate_preview.get("duplicate") is True
    imported = command(session, "erp2.budget.import.confirm", community, {
        "id_importacion": preview["id_importacion"], "id_ejercicio": exercises[1],
        "codigo": "IMP-2028", "denominacion": "Importado 2028", "periodicidad": "mensual",
    })["entity"]
    assert imported["id_presupuesto"]
    checks.append("copia con continuidad, comparativa e importacion staging sin duplicados")

    occupancy = command(session, "erp2.occupancy.save", community, {
        "id_propiedad": properties[0], "has_tenant": True, "name": "Inquilino ERP2",
        "email": "inquilino@example.invalid", "date_start": "2027-01-01", "language": "en",
    })["entity"]
    tenant_id = occupancy["id_persona_cobro"]
    proposal = command(session, "erp2.billing.propose", community, {
        "id_propiedad": properties[0], "date_start": "2027-01-01",
        "recipient_type": "propietario", "recipient_id": owner,
        "payer_type": "inquilino", "payer_id": tenant_id,
        "payment_method": "domiciliacion_pendiente", "payment_reference": "CUENTA-PENDIENTE-ERP4",
    })["entity"]
    command(session, "erp2.billing.confirm", community, {"id_config_recibo": proposal["id_config_recibo"]})
    billing = query(session, "erp2.billing.preview", community, {
        "id_propiedad": properties[0], "effective_date": "2027-02-03",
    })["entity"]
    assert billing["tenant"]["nombre"] == "Inquilino ERP2"
    assert billing["billing"]["recipient"]["id_propietario"] == owner
    assert billing["billing"]["payer"]["id_persona_cobro"] == tenant_id
    checks.append("inquilino, destinatario y pagador separados sin anticipar SEPA")

    assessment = command(session, "erp2.assessment.save", community, {
        "code": "D-2027", "concept": "Reparacion extraordinaria", "amount_cents": "100000",
        "assignments": [{"group_id": general, "rule_type": "coeficiente", "series_purpose": "general",
                         "series_unit": "porcentaje", "mode": "porcentaje", "value": "100"}],
        "schedules": [
            {"key": "PLAZO-1", "date_start": "2027-04-01", "date_end": "2027-04-30", "issue_date": "2027-04-03", "weight": "1"},
            {"key": "PLAZO-2", "date_start": "2028-01-01", "date_end": "2028-01-31", "issue_date": "2028-01-03", "weight": "1"},
        ],
    })["entity"]
    assessment_simulation = command(session, "erp2.assessment.simulate", community, {"id_derrama": assessment["id_derrama"]})["entity"]
    assert assessment_simulation["status"] == "completa" and assessment_simulation["result_total_cents"] == "100000"
    assessment_approved = command(session, "erp2.assessment.approve", community, {"id_derrama": assessment["id_derrama"]})["entity"]
    assert assessment_approved["estado"] == "aprobada"
    conn = sqlite3.connect(database)
    assert conn.execute("SELECT COUNT(DISTINCT id_ejercicio) FROM erp_plan_periodos WHERE id_plan_version=?", (assessment_approved["id_plan_version"],)).fetchone()[0] == 2
    try:
        conn.execute("UPDATE erp_derramas SET concepto='Alterada' WHERE id_derrama=?", (assessment["id_derrama"],))
        conn.commit()
        raise AssertionError("La derrama aprobada fue editable")
    except sqlite3.IntegrityError:
        conn.rollback()
    conn.close()
    checks.append("derrama plurianual, destinatarios previstos, aprobacion inmutable y plan sin recibos")

    emitted = []
    for prop in simulation["property_totals"]:
        for period in prop["periods"]:
            amount = int(period["cents"])
            if prop["property_id"] == properties[0] and period["key"] == "P01":
                amount -= 100
            if prop["property_id"] == properties[1] and period["key"] == "P01":
                amount += 50
            emitted.append({"property_id": prop["property_id"], "period_key": period["key"],
                            "net_emitted_cents": amount, "collected_cents": 0, "confirmed": True,
                            "system": "fixture", "type": "recibo_emitido", "reference": f"E-{prop['property_id']}-{period['key']}"})
    regularization = command(session, "erp2.regularization.preview", community, {
        "id_plan": plan_id, "cutoff_date": "2027-12-31", "coverage_start": "2027-01-01",
        "coverage_end": "2027-12-31", "reason": "Diferencia contra importes emitidos", "emitted": emitted,
    })["entity"]
    assert regularization["summary"]["charge_cents"] == 100
    assert regularization["summary"]["credit_cents"] == -50
    approved_regularization = command(session, "erp2.regularization.approve", community, {
        "id_regularizacion": regularization["id_regularizacion"], "confirm_pending_recipients": True,
    })["entity"]
    assert approved_regularization["estado"] == "aprobada" and not approved_regularization["receipt_emission"]
    duplicate_regularization = command(session, "erp2.regularization.preview", community, {
        "id_plan": plan_id, "cutoff_date": "2027-12-31", "coverage_start": "2027-01-01",
        "coverage_end": "2027-12-31", "reason": "Intento repetido", "emitted": emitted,
    })["entity"]
    assert duplicate_regularization["duplicate"] is True and duplicate_regularization["id_regularizacion"] == regularization["id_regularizacion"]
    emitted_changed = json.loads(json.dumps(emitted))
    target = next(row for row in emitted_changed if row["property_id"] == properties[0] and row["period_key"] == "P01")
    target["net_emitted_cents"] -= 50
    next_regularization = command(session, "erp2.regularization.preview", community, {
        "id_plan": plan_id, "cutoff_date": "2028-01-01", "coverage_start": "2027-01-01",
        "coverage_end": "2027-12-31", "reason": "Cambio posterior de cobertura", "emitted": emitted_changed,
    })["entity"]
    assert next_regularization["summary"]["charge_cents"] == 50 and next_regularization["summary"]["credit_cents"] == 0
    checks.append("regularizacion contra emitido impagado, cargo/abono, deduplicacion y ajustes previos")

    denied = {"id_usuario": actor, "nombre": actor_name, "rol": "Usuario", "comunidades": [
        {"id_comunidad": other, "nombre": "ERP2 Aislada", "puede_ver": 1, "puede_actualizar": 0},
    ]}
    try:
        query(denied, "erp2.budget.list", community)
        raise AssertionError("Se permitio consultar otra comunidad")
    except PermissionError:
        pass
    conn = sqlite3.connect(database)
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(conn.execute("PRAGMA foreign_key_check"))
    assert conn.execute("SELECT COUNT(*) FROM erp_audit_events WHERE id_comunidad=? AND entity_type LIKE 'erp_%'", (community,)).fetchone()[0] >= 10
    assert conn.execute("SELECT COUNT(*) FROM erp_outbox WHERE id_comunidad=? AND event_type LIKE 'erp2.%'", (community,)).fetchone()[0] >= 10
    conn.close()
    restored = work / "restored.db"
    copy_source = sqlite3.connect(database)
    copy_target = sqlite3.connect(restored)
    copy_source.backup(copy_target)
    copy_source.close()
    assert copy_target.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(copy_target.execute("PRAGMA foreign_key_check"))
    copy_target.close()
    assert hashlib.sha256(database.read_bytes()).hexdigest() and restored.is_file()
    checks.append("aislamiento, auditoria, outbox, integridad y restauracion aislada")

    print("ERP 2 COMPLETE VERIFIED")
    for check in checks:
        print(f"OK - {check}")
    print(f"workspace={work}")
finally:
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
