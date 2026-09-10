"""Verify ERP 2B deterministic calculation and snapshots on an isolated copy."""

from copy import deepcopy
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

from erp_core.budget_contracts import CONTRACT_VERSION, MOTOR_VERSION, contract_catalog
from erp_core.budget_engine import explain_property, simulate_budget
from erp_core.budget_simulation import load_simulation, persist_simulation
from erp_core.migrations import MIGRATIONS, apply_all


parser = argparse.ArgumentParser()
parser.add_argument("database", type=Path)
parser.add_argument("--keep", action="store_true")
args = parser.parse_args()
source = args.database.resolve()
if not source.is_file():
    raise SystemExit("Indica una base SQLite de origen.")

work = Path(tempfile.mkdtemp(prefix="organizador-erp2b-engine-"))
database = work / "database.db"
source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
target_connection = sqlite3.connect(database)
source_connection.backup(target_connection)
source_connection.close()
target_connection.close()


def table_hash(conn, table):
    rows = [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
    return hashlib.sha256(repr(rows).encode()).hexdigest()


def periods(frequency):
    counts = {"mensual": 12, "trimestral": 4, "semestral": 2, "anual": 1}
    return [{"key": f"P{index + 1:02d}", "order": index, "weight": "1"}
            for index in range(counts[frequency])]


def member(property_id, *, value=None, purpose="general", quality="validada", state="aprobada",
           member_version_id=None, series_id=None, coefficient_version_id=None, quantity=None,
           exclusion=None):
    result = {"property_id": property_id, "participates": True}
    if member_version_id is not None:
        result["member_version_id"] = member_version_id
    if value is not None:
        result["coefficient"] = {
            "value": value, "purpose": purpose, "quality": quality, "state": state,
            "series_id": series_id, "version_id": coefficient_version_id,
        }
    if quantity is not None:
        result["quantity"] = quantity
    if exclusion is not None:
        result["exclusion"] = {"treatment": exclusion}
    return result


def assignment(assignment_id, members, rule_type, *, amount="10000", group_id=1,
               group_version_id=1, base="sin_coeficiente", expected=None,
               rule_version_id=1, parameters=None, purpose="general", mode="importe"):
    return {
        "id": assignment_id, "key": f"A-{assignment_id}", "mode": mode, "value": amount,
        "series_purpose": purpose,
        "group": {"id": group_id, "version_id": group_version_id, "name": f"G-{group_id}",
                  "base": base, "expected_total": expected, "state": "aprobada"},
        "rule": {"version_id": rule_version_id, "type": rule_type,
                 "state": "aprobada", "parameters": parameters or {}},
        "members": members,
    }


def manifest(items, *, frequency="anual", community_id=1, budget_version_id=None, origin_id="test"):
    return {
        "contract_version": CONTRACT_VERSION,
        "community_id": community_id,
        "budget_version_id": budget_version_id,
        "budget_version_number": 1,
        "origin_type": "presupuesto",
        "origin_id": origin_id,
        "reference_date": "2027-01-01",
        "known_at": "2026-09-10T16:00:00Z",
        "currency": "EUR",
        "periodicity": frequency,
        "periods": periods(frequency),
        "items": items,
    }


def item(item_id, amount, assignments, *, chapter_id=None, name=None, financing=None):
    return {
        "id": item_id, "key": f"I-{item_id}", "name": name or f"Partida {item_id}",
        "chapter_id": chapter_id, "amount_cents": str(amount),
        "financing": financing or [], "assignments": assignments,
    }


def finals(result):
    return [int(line["final_cents"]) for line in result["lines"]]


checks = []
try:
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    protected = ("cf_propiedades", "cf_propietarios", "cf_propietario_propiedad", "cf_recibos", "asamblea_censo")
    before = {table: (conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0], table_hash(conn, table))
              for table in protected}
    first = apply_all(conn, MIGRATIONS[:4])
    migrations = list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    second = apply_all(conn, MIGRATIONS[:4])
    assert first["schema_version"] >= 4 and second["schema_version"] >= 4
    assert conn.execute("SELECT name FROM erp_schema_migrations WHERE version=4").fetchone()[0] == "erp2b_deterministic_results"
    assert migrations == list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(conn.execute("PRAGMA foreign_key_check"))
    for table in protected:
        assert before[table] == (conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0], table_hash(conn, table))
    required = {"erp_simulacion_periodos", "erp_simulacion_resultados", "erp_calculo_componentes", "erp_calculo_periodo_resultados"}
    actual = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert required <= actual
    for table in required:
        assert all(str(column[2]).upper() not in {"REAL", "FLOAT", "DOUBLE"}
                   for column in conn.execute(f'PRAGMA table_info("{table}")'))
    checks.append("migracion 4 aditiva y reentrante; maestros, recibos, deuda y asamblea intactos")

    equal_members = [member(1), member(2), member(3)]
    equal = simulate_budget(manifest([item(1, 10000, [assignment(1, equal_members, "partes_iguales")])]))
    assert equal["status"] == "completa" and finals(equal) == [3334, 3333, 3333]
    assert sum(finals(equal)) == 10000
    credit = deepcopy(equal_members)
    from erp_core.budget_engine import largest_remainder
    assert [line["final_cents"] for line in largest_remainder(-10000, [
        {"weight": __import__("fractions").Fraction(1), "tie_key": index}
        for index in (1, 2, 3)])] == [-3334, -3333, -3333]
    checks.append("mayores restos exactos para cargos y abonos; desempate estable por propiedad")

    weighted = [member(1, value="1"), member(2, value="2"), member(3, value="3")]
    weight_result = simulate_budget(manifest([item(2, 10000, [assignment(
        2, weighted, "coeficiente", base="peso", expected=None, rule_version_id=2)])]))
    assert finals(weight_result) == [1667, 3333, 5000]
    percentage = [member(1, value="20"), member(2, value="30"), member(3, value="50")]
    percentage_result = simulate_budget(manifest([item(3, 10000, [assignment(
        3, percentage, "coeficiente", base="porcentaje", expected="100", rule_version_id=3)])]))
    assert finals(percentage_result) == [2000, 3000, 5000]
    checks.append("coeficiente porcentual y pesos 1/2/3 sin normalizacion silenciosa")

    missing = deepcopy(percentage)
    missing[1].pop("coefficient")
    failed = simulate_budget(manifest([item(4, 10000, [assignment(
        4, missing, "coeficiente", base="porcentaje", expected="100", rule_version_id=4)])]))
    assert failed["status"] == "fallida" and failed["incidents"][0]["code"] == "MISSING_COEFFICIENT"
    ambiguous = deepcopy(percentage)
    ambiguous[0]["coefficient_candidates"] = [ambiguous[0]["coefficient"], ambiguous[0]["coefficient"]]
    assert simulate_budget(manifest([item(5, 10000, [assignment(
        5, ambiguous, "coeficiente", base="porcentaje", expected="100", rule_version_id=5)])]))["incidents"][0]["code"] == "AMBIGUOUS_COEFFICIENT"
    observed = deepcopy(percentage)
    observed[0]["coefficient"]["quality"] = "observada"
    assert simulate_budget(manifest([item(6, 10000, [assignment(
        6, observed, "coeficiente", base="porcentaje", expected="100", rule_version_id=6)])]))["incidents"][0]["code"] == "COEFFICIENT_NOT_VALIDATED"
    checks.append("ausencia, ambiguedad y calidad insuficiente bloquean con incidencia estructurada")

    excluded = [member(1, value="25"), member(2, value="25", exclusion="redistribuir"),
                member(3, value="50")]
    exclusion_result = simulate_budget(manifest([item(7, 10000, [assignment(
        7, excluded, "coeficiente", base="porcentaje", expected="100", rule_version_id=7)])]))
    assert [line["property_id"] for line in exclusion_result["lines"]] == [1, 3]
    assert finals(exclusion_result) == [3333, 6667]
    assert excluded[1]["coefficient"]["value"] == "25"
    checks.append("exclusion por partida redistribuye de forma explicita sin alterar grupo ni coeficientes")

    first_group = assignment(8, [member(1), member(2)], "partes_iguales", amount="6000", group_id=8, rule_version_id=8)
    second_group = assignment(9, [member(2), member(3)], "partes_iguales", amount="4000", group_id=9, rule_version_id=9)
    multi = simulate_budget(manifest([item(8, 10000, [first_group, second_group])]))
    assert sum(finals(multi)) == 10000
    totals = {entry["property_id"]: int(entry["annual_cents"]) for entry in multi["property_totals"]}
    assert totals == {1: 3000, 2: 5000, 3: 2000}
    percentage_groups = deepcopy([first_group, second_group])
    percentage_groups[0].update({"mode": "porcentaje", "value": "60"})
    percentage_groups[1].update({"mode": "porcentaje", "value": "40"})
    assert simulate_budget(manifest([item(81, 10001, percentage_groups)]))["result_total_cents"] == "10001"
    checks.append("una partida se distribuye entre varios grupos y agrega una sola cuota por propiedad")

    fixed = simulate_budget(manifest([item(9, 3000, [assignment(
        10, equal_members, "importe_fijo", amount="3000", rule_version_id=10,
        parameters={"amount_cents": "1000", "scope": "interval"})])]))
    assert finals(fixed) == [1000, 1000, 1000]
    units_members = [member(1, quantity="1"), member(2, quantity="2")]
    units = simulate_budget(manifest([item(10, 3000, [assignment(
        11, units_members, "unidades", amount="3000", rule_version_id=11,
        parameters={"unit": "unidad", "tariff_decimal": "10", "quantities_source": "snapshot"})])]))
    assert finals(units) == [1000, 2000]
    mismatch = simulate_budget(manifest([item(11, 3001, [assignment(
        12, units_members, "unidades", amount="3001", rule_version_id=12,
        parameters={"unit": "unidad", "tariff_decimal": "10", "quantities_source": "snapshot"})])]))
    assert mismatch["incidents"][0]["code"] == "UNITS_TOTAL_MISMATCH"
    checks.append("importe fijo y unidades por tarifa exacta; descuadre comercial bloqueado")

    mixed_rule = {
        "version_id": 20, "type": "mixta", "state": "aprobada", "parameters": {},
        "components": [
            {"key": "IGUAL", "mode": "porcentaje", "value": "60",
             "rule": {"version_id": 21, "type": "partes_iguales", "state": "aprobada", "parameters": {}}},
            {"key": "PESO", "mode": "porcentaje", "value": "40",
             "rule": {"version_id": 22, "type": "coeficiente", "state": "aprobada", "parameters": {}}},
        ],
    }
    mixed_assignment = assignment(13, weighted, "partes_iguales", amount="10000", base="peso", rule_version_id=20)
    mixed_assignment["rule"] = mixed_rule
    mixed = simulate_budget(manifest([item(12, 10000, [mixed_assignment])]))
    assert mixed["status"] == "completa" and sum(finals(mixed)) == 10000
    assert all(len(line["components"]) == 2 for line in mixed["lines"])
    checks.append("regla mixta de un nivel conserva componentes, hojas y total")

    for frequency in ("mensual", "trimestral", "semestral", "anual"):
        periodic = simulate_budget(manifest([item(13, 10000, [assignment(
            14, [member(1)], "partes_iguales", rule_version_id=30)])], frequency=frequency))
        line = periodic["lines"][0]
        assert sum(int(period["final_cents"]) for period in line["periods"]) == 10000
        assert len(line["periods"]) == {"mensual": 12, "trimestral": 4, "semestral": 2, "anual": 1}[frequency]
    monthly = simulate_budget(manifest([item(14, 10000, [assignment(
        15, [member(1)], "partes_iguales", rule_version_id=31)])], frequency="mensual"))
    assert [int(period["final_cents"]) for period in monthly["lines"][0]["periods"]] == [834] * 4 + [833] * 8
    checks.append("periodicidades de comunidad conservan anual; residuos temporales van por orden estable")

    general_members = [member(index, value="2.5", purpose="general") for index in range(1, 41)]
    garden_members = [member(index, value="6.25", purpose="jardines") for index in range(1, 17)]
    general_assignment = assignment(40, general_members, "coeficiente", amount="400000", group_id=40,
                                    group_version_id=40, base="porcentaje", expected="100",
                                    rule_version_id=40, purpose="general")
    garden_assignment = assignment(41, garden_members, "porcentaje_especial", amount="160000", group_id=41,
                                   group_version_id=41, base="porcentaje", expected="100",
                                   rule_version_id=41, purpose="jardines")
    reference_manifest = manifest([
        item(40, 400000, [general_assignment], name="Gastos generales"),
        item(41, 160000, [garden_assignment], name="Jardines privados"),
    ], frequency="mensual")
    reference = simulate_budget(reference_manifest)
    assert reference["status"] == "completa" and reference["result_total_cents"] == "560000"
    garden_lines = [line for line in reference["lines"] if line["item_id"] == 41]
    assert len(garden_lines) == 16 and {line["property_id"] for line in garden_lines} == set(range(1, 17))
    assert all(line["value_decimal"] == "6.25" for line in garden_lines)
    assert all(line["value_decimal"] == "2.5" for line in reference["lines"] if line["item_id"] == 40)
    assert sum(int(line["final_cents"]) for line in garden_lines) == 160000
    assert sum(int(line["final_cents"]) for line in reference["lines"] if line["item_id"] == 40) == 400000
    assert all(sum(int(period["final_cents"]) for period in line["periods"]) == int(line["final_cents"])
               for line in reference["lines"])
    checks.append("caso 40 viviendas/16 bajos usa coeficiente especial sin alterar el general y cuadra anual/periodos")

    again = simulate_budget(deepcopy(reference_manifest))
    assert again == reference and again["result_hash"] == reference["result_hash"]
    reordered_manifest = deepcopy(reference_manifest)
    reordered_manifest["items"][0]["assignments"][0]["members"].reverse()
    reordered = simulate_budget(reordered_manifest)
    assert [(line["property_id"], line["final_cents"]) for line in reordered["lines"]] == [
        (line["property_id"], line["final_cents"]) for line in reference["lines"]]
    explanation = explain_property(reference, 1, "P01")
    assert explanation["total_cents"] == "1668" and len(explanation["details"]) == 2
    assert all(detail["exact"]["numerator"] and detail["exact"]["denominator"] for detail in explanation["details"])
    checks.append("mismo snapshot produce resultado identico y explicacion racional por partida/periodo")

    actor = conn.execute("SELECT id_usuario FROM usuarios WHERE activo=1 ORDER BY id_usuario LIMIT 1").fetchone()[0]
    now = "2026-09-10T16:00:00Z"
    with conn:
        community = conn.execute("""INSERT INTO comunidades
            (nombre,descripcion,activo,codigo,denominacion,moneda,estado_operativo,version)
            VALUES ('ERP2B Prueba','Fixture aislado',1,'ERP2B-TEST','ERP2B Prueba','EUR','activa',1)""").lastrowid
        other = conn.execute("""INSERT INTO comunidades
            (nombre,descripcion,activo,codigo,denominacion,moneda,estado_operativo,version)
            VALUES ('ERP2B Otra','Fixture aislado',1,'ERP2B-OTHER','ERP2B Otra','EUR','activa',1)""").lastrowid
        exercise = conn.execute("""INSERT INTO erp_ejercicios
            (id_comunidad,codigo,fecha_inicio,fecha_fin,moneda,estado,creado_en,creado_por,origen)
            VALUES (?,'2027','2027-01-01','2027-12-31','EUR','preparacion',?,?,'test')""", (community, now, actor)).lastrowid
        type_id = conn.execute("""INSERT INTO erp_tipos_propiedad
            (id_comunidad,codigo,nombre,creado_en,origen) VALUES (?,'vivienda','Vivienda',?,'test')""", (community, now)).lastrowid
        properties = [conn.execute("""INSERT INTO cf_propiedades
            (id_comunidad,codigo_propiedad,codigo_normalizado,id_tipo_propiedad,tipo_propiedad,
             activa,estado,calidad_dato,version,fecha_creacion,fecha_ultima_actualizacion,origen_dato)
            VALUES (?,?,?,?,?,1,'activa','validada',1,?,?,?)""",
            (community, f"T-{index}", f"T {index}", type_id, "vivienda", now, now, "test")).lastrowid
            for index in range(1, 4)]
        group = conn.execute("""INSERT INTO erp_grupos_reparto
            (id_comunidad,codigo,nombre,estado,creado_en,creado_por,origen)
            VALUES (?,'GENERAL','General','activo',?,?,'test')""", (community, now, actor)).lastrowid
        group_version = conn.execute("""INSERT INTO erp_grupo_versiones
            (id_comunidad,id_grupo,version,base,suma_esperada_decimal,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,'porcentaje','100','aprobada',?,?,'test')""", (community, group, now, actor)).lastrowid
        persisted_members = []
        coefficient_versions = []
        for property_id, coefficient_value in zip(properties, ("33.333333333333", "33.333333333333", "33.333333333334")):
            member_id = conn.execute("""INSERT INTO erp_grupo_miembros
                (id_comunidad,id_grupo,id_propiedad,creado_en,creado_por,origen)
                VALUES (?,?,?,?,?,'test')""", (community, group, property_id, now, actor)).lastrowid
            member_version = conn.execute("""INSERT INTO erp_grupo_miembro_versiones
                (id_comunidad,id_miembro,version,participa,excluida,registrada_en,registrada_por,origen)
                VALUES (?,?,1,1,0,?,?,'test')""", (community, member_id, now, actor)).lastrowid
            series_id = conn.execute("""INSERT INTO erp_coeficiente_series
                (id_comunidad,id_propiedad,id_grupo,finalidad,unidad,escala,estado,creada_en,creada_por,origen)
                VALUES (?,?,?,'general','porcentaje',12,'activa',?,?,'test')""",
                (community, property_id, group, now, actor)).lastrowid
            coefficient_version = conn.execute("""INSERT INTO erp_coeficiente_versiones
                (id_comunidad,id_serie,version,valor_decimal,valor_original,precision_original,
                 calidad,estado,registrada_en,registrada_por,origen)
                VALUES (?,?,1,?,?,12,'validada','aprobada',?,?,'test')""",
                (community, series_id, coefficient_value, coefficient_value, now, actor)).lastrowid
            coefficient_versions.append(coefficient_version)
            persisted_members.append(member(
                property_id, value=coefficient_value, member_version_id=member_version,
                series_id=series_id, coefficient_version_id=coefficient_version,
            ))
        rule = conn.execute("""INSERT INTO erp_reglas_reparto
            (id_comunidad,codigo,nombre,tipo,estado,creada_en,creada_por,origen)
            VALUES (?,'COEF','Coeficiente','coeficiente','activa',?,?,'test')""", (community, now, actor)).lastrowid
        rule_version = conn.execute("""INSERT INTO erp_regla_versiones
            (id_comunidad,id_regla,version,codigo_motor,version_motor,parametros_json,
             esquema_parametros_json,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,'coefficient',?,'{}','{}','aprobada',?,?,'test')""", (community, rule, MOTOR_VERSION, now, actor)).lastrowid
        budget = conn.execute("""INSERT INTO erp_presupuestos
            (id_comunidad,id_ejercicio,codigo,denominacion,tipo,moneda,estado,creado_en,creado_por,origen)
            VALUES (?,?,'P-2027','Presupuesto 2027','ordinario','EUR','borrador',?,?,'test')""", (community, exercise, now, actor)).lastrowid
        budget_version = conn.execute("""INSERT INTO erp_presupuesto_versiones
            (id_comunidad,id_presupuesto,version,fecha_inicio,fecha_fin,periodicidad,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,'2027-01-01','2027-12-31','mensual','borrador',?,?,'test')""", (community, budget, now, actor)).lastrowid
        chapter = conn.execute("""INSERT INTO erp_presupuesto_capitulos
            (id_comunidad,id_presupuesto_version,clave_continuidad,nombre,orden)
            VALUES (?,?,'CAP','General',1)""", (community, budget_version)).lastrowid
        db_item = conn.execute("""INSERT INTO erp_presupuesto_partidas
            (id_comunidad,id_presupuesto_version,id_capitulo,clave_continuidad,concepto,importe_centimos,orden)
            VALUES (?,?,?,'ITEM','General',10000,1)""", (community, budget_version, chapter)).lastrowid
        db_assignment = conn.execute("""INSERT INTO erp_partida_repartos
            (id_comunidad,id_partida,clave_linea,id_grupo,id_grupo_version,id_regla_version,modo,valor_decimal,orden)
            VALUES (?,?,'A',?,?,?,'importe','10000',1)""", (community, db_item, group, group_version, rule_version)).lastrowid
    conn.close()

    persisted_assignment = assignment(
        db_assignment, persisted_members, "coeficiente", group_id=group,
        group_version_id=group_version, rule_version_id=rule_version,
        base="porcentaje", expected="100",
    )
    persisted_manifest = manifest([item(db_item, 10000, [persisted_assignment], chapter_id=chapter)],
                                  frequency="mensual", community_id=community,
                                  budget_version_id=budget_version, origin_id=str(budget))
    stored = persist_simulation(database, persisted_manifest, actor_id=actor, origin="test")
    assert stored["status"] == "completa" and not stored["idempotent_replay"]
    replay = persist_simulation(database, deepcopy(persisted_manifest), actor_id=actor, origin="test")
    assert replay["idempotent_replay"] and replay["simulation_id"] == stored["simulation_id"]
    loaded = load_simulation(database, community, stored["simulation_id"])
    assert loaded["result_hash"] == stored["result_hash"]
    snapshot_before = json.dumps(loaded, sort_keys=True)
    db = sqlite3.connect(database)
    db.execute("UPDATE erp_coeficiente_versiones SET valor_decimal='99' WHERE id_coeficiente_version=?", (coefficient_versions[0],))
    db.commit()
    counts = {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in (
        "erp_simulaciones", "erp_simulacion_resultados", "erp_calculo_lineas",
        "erp_calculo_componentes", "erp_calculo_periodo_resultados")}
    db.close()
    assert json.dumps(load_simulation(database, community, stored["simulation_id"]), sort_keys=True) == snapshot_before
    checks.append("snapshot persistido e idempotente no cambia tras modificar posteriormente el coeficiente maestro")

    failing_manifest = deepcopy(persisted_manifest)
    failing_manifest["origin_id"] = "rollback"
    failing_manifest["items"][0]["name"] = "Fallo controlado"
    try:
        persist_simulation(database, failing_manifest, actor_id=actor, origin="test", simulate_failure=True)
        raise AssertionError("El fallo simulado no interrumpio el guardado.")
    except RuntimeError:
        pass
    db = sqlite3.connect(database)
    assert counts == {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in counts}
    db.close()
    cross_manifest = deepcopy(persisted_manifest)
    cross_manifest["community_id"] = other
    cross_manifest["origin_id"] = "cross-community"
    try:
        persist_simulation(database, cross_manifest, actor_id=actor, origin="test")
        raise AssertionError("Se persistio un snapshot con referencias de otra comunidad.")
    except sqlite3.IntegrityError:
        pass
    db = sqlite3.connect(database)
    assert db.execute("SELECT COUNT(*) FROM erp_simulaciones WHERE id_comunidad=?", (other,)).fetchone()[0] == 0
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(db.execute("PRAGMA foreign_key_check"))
    db.close()
    checks.append("rollback completo y FKs impiden snapshots transversales entre comunidades")

    assert contract_catalog()["implementation_stage"] == "2B-domain-engine"
    assert "consumo" not in contract_catalog()["engine_rules_enabled"]
    assert not contract_catalog()["receipt_emission"]
    checks.append("motor sin formulas, IA, recibos, deuda, contabilidad, SEPA ni consumo adelantado")

    print(json.dumps({
        "ok": True, "schema_version": 4, "engine_version": MOTOR_VERSION,
        "checks": checks, "fixture": str(work), "production_modified": False,
    }, ensure_ascii=False))
finally:
    if not args.keep:
        shutil.rmtree(work, ignore_errors=True)
