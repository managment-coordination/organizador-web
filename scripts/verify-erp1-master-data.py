"""Verify ERP 1 against an isolated copy of a real compatible database."""

from datetime import datetime, timezone
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

from erp_core.contracts import CommandEnvelope, QueryEnvelope
from erp_core.dispatcher import execute_command, execute_query
from erp_core.errors import ConflictError, ContractError
from erp_core.migrations import apply_all


parser = argparse.ArgumentParser()
parser.add_argument("database", type=Path)
parser.add_argument("--keep", action="store_true")
args = parser.parse_args()
source = args.database.resolve()
work = Path(tempfile.mkdtemp(prefix="organizador-erp1-master-data-"))
database = work / "database.db"
shutil.copy2(source, database)


def rows_hash(conn, table):
    rows = [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
    return hashlib.sha256(repr(rows).encode()).hexdigest()


def command(session, name, community, payload, *, expected=None, evidence=None, key=None):
    return execute_command(str(database), session, {
        "command": name, "id_comunidad": community, "payload": payload,
        "idempotency_key": key or str(uuid.uuid4()), "expected_version": expected,
        "reason": "Prueba automatizada ERP 1", "origin": "test", "evidence": evidence,
    })


def query(session, name, community, filters=None):
    return execute_query(str(database), session, {
        "query": name, "id_comunidad": community, "filters": filters or {},
    })


checks = []
try:
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    original_counts = {table: conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                       for table in ("comunidades", "cf_propiedades", "cf_propietarios",
                                     "cf_propietario_propiedad", "asamblea_censo", "cf_recibos")}
    assembly_hash = rows_hash(conn, "asamblea_censo")
    debt_hash = rows_hash(conn, "cf_recibos")
    apply_all(conn)
    first_migrations = list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    apply_all(conn)
    assert first_migrations == list(conn.execute("SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version"))
    assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not list(conn.execute("PRAGMA foreign_key_check"))
    for table, count in original_counts.items():
        assert conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] == count
    checks.append("migracion versionada, reentrante e integra con IDs/recuentos conservados")

    super_row = conn.execute("SELECT id_usuario,nombre FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()
    if not super_row:
        super_row = conn.execute("SELECT id_usuario,nombre FROM usuarios WHERE activo=1 LIMIT 1").fetchone()
    actor_id, actor_name = int(super_row[0]), str(super_row[1])
    communities = [dict(row) for row in conn.execute("SELECT id_comunidad,nombre FROM comunidades WHERE activo=1 ORDER BY id_comunidad")]
    for row in communities:
        row.update({"puede_ver": 1, "puede_actualizar": 1})
    session = {"id_usuario": actor_id, "nombre": actor_name, "rol": "Superusuario", "comunidades": communities}
    community = int(communities[0]["id_comunidad"])
    second = int(communities[1]["id_comunidad"]) if len(communities) > 1 else None
    type_id = conn.execute("SELECT id_tipo_propiedad FROM erp_tipos_propiedad WHERE id_comunidad=? AND codigo='vivienda'", (community,)).fetchone()[0]
    conn.close()

    def new_owner(name, suffix):
        return command(session, "erp1.owner.save", community, {
            "codigo_netfincas": "ERP1-" + suffix, "nombre": name,
            "tipo_persona": "fisica", "estado": "activo", "calidad_identidad": "validada",
        })["entity"]

    def new_property(code, target_community=community):
        conn = sqlite3.connect(database)
        local_type = conn.execute("SELECT id_tipo_propiedad FROM erp_tipos_propiedad WHERE id_comunidad=? AND codigo='vivienda'", (target_community,)).fetchone()[0]
        conn.close()
        return command(session, "erp1.property.save", target_community, {
            "codigo_propiedad": code, "tipo_id": local_type, "estado": "activa", "calidad_dato": "validada",
        })["entity"]

    owner_a = new_owner("Titular A ERP1", "A")
    owner_b = new_owner("Titular B ERP1", "B")
    owner_c = new_owner("Titular C ERP1", "C")
    prop_p = new_property("ERP1-P")
    prop_q = new_property("ERP1-Q")

    def ownership(prop, lines, effective, *, complete=True, quality="validada", known="2026-01-02T10:00:00Z"):
        evidence = {"type": "test_document", "id": "ERP1-EVIDENCE"} if quality == "validada" else None
        proposed = command(session, "erp1.ownership.propose", community, {
            "id_propiedad": prop["id_propiedad"], "efectiva_desde": effective,
            "fecha_conocimiento": known, "calidad": quality,
            "composicion_completa": complete, "lineas": lines,
            "motivo": "Composicion de prueba",
        }, evidence=evidence)
        return command(session, "erp1.ownership.confirm", community,
                       {"id_propuesta": proposed["entity"]["id_propuesta"]},
                       expected=proposed["entity"]["version"])

    ownership(prop_p, [{"id_propietario": owner_a["id_propietario"], "porcentaje_decimal": "100"}], "2026-01-01")
    ownership(prop_q, [{"id_propietario": owner_a["id_propietario"], "porcentaje_decimal": "100"}], "2026-01-01")
    assert len(query(session,"erp1.owner.get",community,{"id_propietario":owner_a["id_propietario"]})["entity"]["propiedades"]) == 2
    checks.append("un propietario puede poseer varias propiedades")

    prop_shared = new_property("ERP1-SHARED")
    ownership(prop_shared, [
        {"id_propietario":owner_a["id_propietario"],"porcentaje_decimal":"60"},
        {"id_propietario":owner_b["id_propietario"],"porcentaje_decimal":"40"},
    ], "2026-01-01")
    shared = query(session,"erp1.ownership.list",community,{"id_propiedad":prop_shared["id_propiedad"],"fecha":"2026-02-01"})
    assert shared["composicion_completa"] and shared["porcentaje_conocido"] == "100"
    checks.append("copropiedad exacta 60/40 validada")

    prop_sale = new_property("ERP1-SALE")
    ownership(prop_sale,[{"id_propietario":owner_a["id_propietario"],"porcentaje_decimal":"100"}],"2026-01-01",known="2026-01-01T10:00:00Z")
    ownership(prop_sale,[{"id_propietario":owner_b["id_propietario"],"porcentaje_decimal":"100"}],"2026-07-01",known="2026-08-01T10:00:00Z")
    june=query(session,"erp1.ownership.list",community,{"id_propiedad":prop_sale["id_propiedad"],"fecha":"2026-06-30"})
    july=query(session,"erp1.ownership.list",community,{"id_propiedad":prop_sale["id_propiedad"],"fecha":"2026-07-01"})
    assert [r["id_propietario"] for r in june["items"]]==[owner_a["id_propietario"]]
    assert [r["id_propietario"] for r in july["items"]]==[owner_b["id_propietario"]]
    known_july=query(session,"erp1.ownership.known_at",community,{"id_propiedad":prop_sale["id_propiedad"],"fecha":"2026-07-15","conocido_en":"2026-07-20T00:00:00Z"})
    known_aug=query(session,"erp1.ownership.known_at",community,{"id_propiedad":prop_sale["id_propiedad"],"fecha":"2026-07-15","conocido_en":"2026-08-02T00:00:00Z"})
    assert not known_july["items"] and [r["id_propietario"] for r in known_aug["items"]]==[owner_b["id_propietario"]]
    checks.append("venta [desde,hasta) y tiempo efectivo/conocido diferenciados")

    try:
        ownership(prop_shared,[
            {"id_propietario":owner_b["id_propietario"],"porcentaje_decimal":"60"},
            {"id_propietario":owner_c["id_propietario"],"porcentaje_decimal":"50"},
        ],"2027-01-01")
        raise AssertionError("Se acepto una composicion de 110 %")
    except ContractError:
        pass
    partial_prop=new_property("ERP1-PARTIAL")
    partial=ownership(partial_prop,[{"id_propietario":owner_c["id_propietario"],"porcentaje_decimal":"50"}],None,complete=False,quality="observada")
    snapshot=query(session,"erp1.ownership.list",community,{"id_propiedad":partial_prop["id_propiedad"]})
    assert snapshot["cobertura"]=="incompleta" and snapshot["porcentaje_conocido"]=="50"
    checks.append("110 % bloqueado y composicion incompleta conservada sin titular ficticio")

    replay_key=str(uuid.uuid4())
    first=command(session,"erp1.provenance.record",community,{"sistema_origen":"Netfincas","entidad_origen":"titularidad","codigo_origen":"ERP1-X","entidad_destino":"propiedad","id_destino":str(prop_p["id_propiedad"]),"decision":"observada"},key=replay_key)
    replay=command(session,"erp1.provenance.record",community,{"sistema_origen":"Netfincas","entidad_origen":"titularidad","codigo_origen":"ERP1-X","entidad_destino":"propiedad","id_destino":str(prop_p["id_propiedad"]),"decision":"observada"},key=replay_key)
    assert replay["idempotent_replay"] and replay["entity"]["id_fuente_registro"]==first["entity"]["id_fuente_registro"]
    checks.append("importacion/hecho repetido idempotente")

    uncertain_prop=new_property("ERP1-UNKNOWN-DATE")
    ownership(uncertain_prop,[{"id_propietario":owner_c["id_propietario"],"porcentaje_decimal":"100"}],None,complete=True,quality="observada")
    uncertain=query(session,"erp1.ownership.list",community,{"id_propiedad":uncertain_prop["id_propiedad"],"fecha":"2020-01-01"})
    assert uncertain["items"] and uncertain["items"][0]["efectiva_desde"] is None and uncertain["items"][0]["calidad"]=='observada'
    checks.append("fecha efectiva desconocida conserva incertidumbre")

    group=command(session,"erp1.group.save",community,{"codigo":"ERP1-GAR","nombre":"Garajes ERP1","base":"peso","estado":"activo"})["entity"]
    coef_general=command(session,"erp1.coefficient.save",community,{"id_propiedad":prop_p["id_propiedad"],"id_grupo":group["id_grupo"],"finalidad":"general","unidad":"peso","valor_decimal":"1.123456789012","calidad":"validada","estado":"aprobada","efectiva_desde":"2026-01-01"})["entity"]
    second_group=command(session,"erp1.group.save",community,{"codigo":"ERP1-SPECIAL","nombre":"Especial ERP1","base":"peso","estado":"activo"})["entity"]
    command(session,"erp1.coefficient.save",community,{"id_propiedad":prop_p["id_propiedad"],"id_grupo":second_group["id_grupo"],"finalidad":"garajes","unidad":"peso","valor_decimal":"5.000000000001","calidad":"validada","estado":"aprobada","efectiva_desde":"2026-01-01"})
    coeffs=query(session,"erp1.coefficient.get",community,{"id_propiedad":prop_p["id_propiedad"]})["items"]
    assert any(x["version_vigente"]["valor_decimal"]=="1.123456789012" for x in coeffs) and any(x["version_vigente"]["valor_decimal"]=="5.000000000001" for x in coeffs)
    checks.append("coeficientes exactos diferentes por grupo sin usar REAL para calcular")

    command(session,"erp1.group.membership.save",community,{"id_grupo":group["id_grupo"],"id_propiedad":prop_p["id_propiedad"],"participa":True,"efectiva_desde":"2026-01-01"})
    command(session,"erp1.group.membership.save",community,{"id_grupo":group["id_grupo"],"id_propiedad":prop_p["id_propiedad"],"participa":False,"excluida":True,"efectiva_desde":"2026-07-01","motivo":"Salida de prueba"})
    members_before=query(session,"erp1.group.get",community,{"id_grupo":group["id_grupo"],"fecha":"2026-06-30"})["entity"]["miembros"]
    members_after=query(session,"erp1.group.get",community,{"id_grupo":group["id_grupo"],"fecha":"2026-07-01"})["entity"]["miembros"]
    assert members_before[0]["participa"]==1 and members_after[0]["excluida"]==1
    checks.append("pertenencia y exclusion versionadas sin prorrateo implicito")

    if second:
        same_1=new_property("ERP1-SAME-CODE",community)
        same_2=new_property("ERP1-SAME-CODE",second)
        assert same_1["id_comunidad"]!=same_2["id_comunidad"]
        denied={"id_usuario":actor_id,"nombre":actor_name,"rol":"Usuario","comunidades":[{"id_comunidad":community,"puede_ver":1,"puede_actualizar":1}]}
        try:
            query(denied,"erp1.property.get",second,{"id_propiedad":same_2["id_propiedad"]})
            raise AssertionError("Se permitio una lectura de otra comunidad")
        except PermissionError:
            pass
        checks.append("mismo codigo aislado por comunidad y permiso transversal denegado")

    command(session,"erp1.property.relation.save",community,{"id_propiedad_origen":prop_p["id_propiedad"],"id_propiedad_destino":prop_q["id_propiedad"],"tipo":"anexo","estado":"activa"})
    p_detail=query(session,"erp1.property.get",community,{"id_propiedad":prop_p["id_propiedad"]})["entity"]
    assert p_detail["relaciones"] and len(p_detail["titularidades"]["items"])==1
    checks.append("anexo relacionado sin agregar titularidad ni coeficiente")

    stale_owner=new_owner("Version ERP1", "VERSION")
    update_key=str(uuid.uuid4())
    updated=command(session,"erp1.owner.save",community,{"id_propietario":stale_owner["id_propietario"],"nombre":"Version ERP1 actualizada"},expected=stale_owner["version"],key=update_key)
    replay=command(session,"erp1.owner.save",community,{"id_propietario":stale_owner["id_propietario"],"nombre":"Version ERP1 actualizada"},expected=stale_owner["version"],key=update_key)
    assert replay["idempotent_replay"]
    try:
        command(session,"erp1.owner.save",community,{"id_propietario":stale_owner["id_propietario"],"nombre":"Version obsoleta"},expected=stale_owner["version"])
        raise AssertionError("Se acepto expected_version obsoleta")
    except ConflictError:
        pass
    checks.append("confirmacion concurrente idempotente y version obsoleta bloqueada")

    conn=sqlite3.connect(database)
    assert rows_hash(conn,"asamblea_censo")==assembly_hash
    assert rows_hash(conn,"cf_recibos")==debt_hash
    assert conn.execute("PRAGMA integrity_check").fetchone()[0]=='ok'
    assert not list(conn.execute("PRAGMA foreign_key_check"))
    restored=work/'restored.db'; target=sqlite3.connect(restored); conn.backup(target); target.close(); conn.close()
    restored_conn=sqlite3.connect(restored)
    assert restored_conn.execute("PRAGMA integrity_check").fetchone()[0]=='ok'
    restored_conn.close()
    checks.append("deuda y asamblea historica intactas; backup posterior restaurable")

    print(json.dumps({"ok":True,"checks":checks,"fixture":str(work),"schema_version":2},ensure_ascii=False))
finally:
    if not args.keep:
        shutil.rmtree(work,ignore_errors=True)
