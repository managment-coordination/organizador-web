"""Regression for reviewed Excel onboarding and unchanged ERP 2 economics."""

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
from erp_core.errors import ConflictError
from erp_core.migrations import MIGRATIONS, apply_all

parser = argparse.ArgumentParser()
parser.add_argument("database", type=Path)
args = parser.parse_args()
work = Path(tempfile.mkdtemp(prefix="organizador-ux-onboarding-"))
database = work / "database.db"
shutil.copy2(args.database.resolve(), database)


def table_hash(conn, table):
    rows = [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
    return hashlib.sha256(repr(rows).encode()).hexdigest()


def command(session, name, community, payload, expected=None, key=None):
    return execute_command(str(database), session, {
        "command": name, "id_comunidad": community, "payload": payload,
        "idempotency_key": key or str(uuid.uuid4()), "expected_version": expected,
        "reason": "Prueba UX y onboarding", "origin": "test", "evidence": None,
    })


checks = []
conn = sqlite3.connect(database)
conn.row_factory = sqlite3.Row
economic_tables = ["erp_simulaciones", "erp_simulacion_resultados", "erp_calculo_lineas", "erp_planes_cuota"]
apply_all(conn, MIGRATIONS)
economic_before = {table: table_hash(conn, table) for table in economic_tables}
apply_all(conn, MIGRATIONS)
assert [tuple(row) for row in conn.execute('SELECT version,name,checksum FROM erp_schema_migrations ORDER BY version')] == [(m.version,m.name,m.checksum) for m in MIGRATIONS]
assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert not list(conn.execute("PRAGMA foreign_key_check"))
checks.append("migracion 6 reentrante, integra y aditiva")

user = conn.execute("SELECT id_usuario,nombre FROM usuarios WHERE activo=1 ORDER BY CASE WHEN rol='Superusuario' THEN 0 ELSE 1 END LIMIT 1").fetchone()
community = conn.execute("SELECT id_comunidad,nombre FROM comunidades WHERE activo=1 ORDER BY id_comunidad LIMIT 1").fetchone()
community_id = int(community[0])
session = {"id_usuario": int(user[0]), "nombre": str(user[1]), "rol": "Superusuario",
           "comunidades": [{"id_comunidad": community_id, "nombre": community[1], "puede_ver": 1, "puede_actualizar": 1}]}
conn.close()

group = command(session, "erp1.group.save", community_id, {
    "codigo": "UX_ONBOARDING", "nombre": "Grupo UX onboarding", "finalidad": "Prueba aislada",
    "estado": "activo", "base": "porcentaje", "suma_esperada_decimal": "100", "efectiva_desde": "2026-01-01",
})["entity"]
group_id = group["id_grupo"]

owners = [
    {"codigo_propietario": "UX-001", "nombre": "Persona UX Uno", "email": "ux1@example.invalid", "telefono": "600000001"},
    {"codigo_propietario": "UX-002", "nombre": "Persona UX Dos"},
]
preview = command(session, "erp1.onboarding.preview", community_id, {
    "tipo": "propietarios", "hash_archivo": "a" * 64, "nombre_archivo": "propietarios.xlsx",
    "ruta_privada": "test/propietarios.xlsx", "hoja": "Propietarios", "cabeceras": ["Codigo", "Nombre"],
    "mapeo": {"Codigo": "codigo_propietario", "Nombre": "nombre"}, "opciones": {}, "filas": owners,
})["entity"]
assert preview["filas_validas"] == 2 and preview["incidencias"] == 0 and preview["puede_confirmar"]
confirmed = command(session, "erp1.onboarding.confirm", community_id,
                    {"id_importacion": preview["id_importacion"]}, preview["version"])["entity"]
assert confirmed["creados"] == 2
replay = command(session, "erp1.onboarding.preview", community_id, {
    "tipo": "propietarios", "hash_archivo": "a" * 64, "nombre_archivo": "propietarios.xlsx",
    "ruta_privada": "test/propietarios.xlsx", "hoja": "Propietarios", "cabeceras": ["Codigo", "Nombre"],
    "mapeo": {"Codigo": "codigo_propietario", "Nombre": "nombre"}, "opciones": {}, "filas": owners,
})["entity"]
assert replay["estado"] == "confirmada" and replay["reimportacion"]
checks.append("propietarios, contactos y reimportacion sin duplicados")

props = [
    {"codigo_propiedad": "UX-P01", "codigo_propietario": "UX-001", "tipo_propiedad": "vivienda",
     "porcentaje_titularidad": "100", f"coeficiente_grupo:{group_id}": "40"},
    {"codigo_propiedad": "UX-P02", "codigo_propietario": "UX-002", "tipo_propiedad": "vivienda",
     "porcentaje_titularidad": "100", f"coeficiente_grupo:{group_id}": "60"},
]
preview = command(session, "erp1.onboarding.preview", community_id, {
    "tipo": "propiedades", "hash_archivo": "b" * 64, "nombre_archivo": "propiedades.xlsx",
    "ruta_privada": "test/propiedades.xlsx", "hoja": "Propiedades", "cabeceras": ["Codigo"],
    "mapeo": {"Codigo": "codigo_propiedad"}, "opciones": {"fecha_efectiva": "2026-01-01"}, "filas": props,
})["entity"]
assert preview["filas_validas"] == 2 and preview["incidencias"] == 0
confirmed = command(session, "erp1.onboarding.confirm", community_id,
                    {"id_importacion": preview["id_importacion"]}, preview["version"])["entity"]
assert confirmed["creadas"] == 2 and confirmed["titularidades_creadas"] == 2
conn = sqlite3.connect(database)
conn.row_factory = sqlite3.Row
values = [row[0] for row in conn.execute("""SELECT v.valor_decimal FROM erp_coeficiente_series s
    JOIN erp_coeficiente_versiones v ON v.id_serie=s.id_serie WHERE s.id_grupo=? ORDER BY s.id_propiedad""", (group_id,))]
assert values == ["40", "60"]
assert conn.execute("SELECT COUNT(*) FROM cf_propietarios WHERE codigo_netfincas LIKE 'UX-%'").fetchone()[0] == 2
assert conn.execute("SELECT COUNT(*) FROM cf_propiedades WHERE codigo_propiedad LIKE 'UX-%'").fetchone()[0] == 2
checks.append("propiedades, titularidades y coeficiente especial masivos")

bad = command(session, "erp1.onboarding.preview", community_id, {
    "tipo": "propiedades", "hash_archivo": "c" * 64, "nombre_archivo": "incompleto.xlsx",
    "ruta_privada": "test/incompleto.xlsx", "hoja": "Propiedades", "cabeceras": ["Codigo"],
    "mapeo": {"Codigo": "codigo_propiedad"}, "opciones": {"fecha_efectiva": "2026-01-01"},
    "filas": [{"codigo_propiedad": "UX-P03", "codigo_propietario": "NO-EXISTE", "tipo_propiedad": "vivienda",
               "porcentaje_titularidad": "100", f"coeficiente_grupo:{group_id}": "1"}],
})["entity"]
assert bad["incidencias"] == 1 and not bad["puede_confirmar"]
checks.append("coincidencias dudosas e importes incoherentes quedan bloqueados")

def name_preview(rows, choices=None, digest=None):
    return command(session, "erp1.onboarding.preview", community_id, {
        "tipo":"propiedades", "hash_archivo":digest or uuid.uuid4().hex*2,
        "nombre_archivo":"nombres.xlsx", "ruta_privada":"test/nombres.xlsx", "hoja":"Hoja1",
        "cabeceras":["Propiedad","Propietario"],
        "mapeo":{"Propiedad":"codigo_propiedad","Propietario":"nombre_propietario"},
        "opciones":{"fecha_efectiva":"2026-01-01","propietarios_por_fila":choices or {}}, "filas":rows,
    })["entity"]

named = command(session, "erp1.owner.save", community_id, {"nombre":"Persona Jose Alvarez UX", "estado":"activo"})["entity"]
named_id=named["id_propietario"]
before_owner_count=conn.execute("SELECT COUNT(*) FROM cf_propietarios").fetchone()[0]
name_group=command(session,"erp1.group.save",community_id,{"codigo":"NAME-GENERAL","nombre":"General por nombres UX","estado":"activo","base":"porcentaje","suma_esperada_decimal":"100","efectiva_desde":"2026-01-01"})["entity"]
name_rows=[{"codigo_propiedad":f"NAME-P{i:02}","nombre_propietario":"  PERSONA   Jos\u00e9 ALVAREZ ux  ",f"coeficiente_grupo:{name_group['id_grupo']}":"2,5"} for i in range(40)]
name_digest=uuid.uuid4().hex*2
matched=name_preview(name_rows,digest=name_digest)
assert matched["puede_confirmar"] and matched["filas_validas"]==40
assert all(row["datos"]["vinculacion_propietario"]["id_propietario"]==named_id for row in matched["filas"])
result=command(session,"erp1.onboarding.confirm",community_id,{"id_importacion":matched["id_importacion"]},matched["version"])["entity"]
assert result["creadas"]==40 and result["titularidades_creadas"]==40
assert result["participaciones_configuradas"]==40
assert conn.execute("SELECT COUNT(*) FROM cf_propietarios").fetchone()[0]==before_owner_count
assert name_preview(name_rows,digest=name_digest)["reimportacion"]
checks.append("40 propiedades por nombre normalizado, propietario sin codigo, sin nuevos propietarios y reimportacion idempotente")

homonym=command(session,"erp1.owner.save",community_id,{"nombre":"Persona Jos\u00e9 Alvarez UX","estado":"activo"})["entity"]
ambiguous_rows=[{"codigo_propiedad":"NAME-AMB","nombre_propietario":"Persona Jose Alvarez UX"}]
ambiguous=name_preview(ambiguous_rows)
assert not ambiguous["puede_confirmar"]
assert len(ambiguous["filas"][0]["datos"]["vinculacion_propietario"]["candidatos"])==2
resolved=name_preview(ambiguous_rows,{"2":named_id})
assert resolved["puede_confirmar"]
assert resolved["filas"][0]["datos"]["vinculacion_propietario"]["metodo"]=="seleccion_manual"
assert not name_preview([{"codigo_propiedad":"NAME-TYPO","nombre_propietario":"Persona Jsoe Alvarez UX"}])["puede_confirmar"]
manual=name_preview([{"codigo_propiedad":"NAME-TYPO","nombre_propietario":"Persona Jsoe Alvarez UX"}],{"2":named_id})
assert manual["puede_confirmar"]
assert not name_preview(ambiguous_rows,{"2":999999999})["puede_confirmar"]
inactive=command(session,"erp1.owner.save",community_id,{"nombre":"Inactivo prueba UX","estado":"inactivo"})["entity"]
assert not name_preview([{"codigo_propiedad":"NAME-INACTIVE","nombre_propietario":inactive["nombre"]}],{"2":inactive["id_propietario"]})["puede_confirmar"]
assert not name_preview([{"codigo_propiedad":"NAME-MISMATCH","codigo_propietario":"UX-001","nombre_propietario":"Persona UX Dos"}])["puede_confirmar"]
checks.append("homonimos y parecido no vinculan automaticamente; seleccion manual explicita auditada")

other=conn.execute("SELECT id_comunidad FROM comunidades WHERE id_comunidad<>? LIMIT 1",(community_id,)).fetchone()
if other:
    other_session={**session,"comunidades":[{"id_comunidad":other[0],"puede_ver":1,"puede_actualizar":1}]}
    foreign=command(other_session,"erp1.owner.save",other[0],{"nombre":"Persona exclusiva otra comunidad UX"})["entity"]
    cross=[{"codigo_propiedad":"NAME-CROSS","nombre_propietario":foreign["nombre"]}]
    assert not name_preview(cross)["puede_confirmar"]
    assert not name_preview(cross,{"2":foreign["id_propietario"]})["puede_confirmar"]
checks.append("busqueda y seleccion de propietarios aisladas por comunidad")

before_properties=conn.execute("SELECT COUNT(*) FROM cf_propiedades").fetchone()[0]
conn.execute("UPDATE cf_propietarios SET version=version+1 WHERE id_propietario=?",(named_id,));conn.commit()
try:
    command(session,"erp1.onboarding.confirm",community_id,{"id_importacion":resolved["id_importacion"]},resolved["version"])
    raise AssertionError("Se confirmo un propietario cambiado desde la revision")
except ConflictError:
    pass
assert conn.execute("SELECT COUNT(*) FROM cf_propiedades").fetchone()[0]==before_properties
assert not name_preview([{"codigo_propiedad":"UX-P01","nombre_propietario":"Persona UX Dos"}])["puede_confirmar"]
checks.append("revision obsoleta bloqueada sin escrituras parciales y titularidad existente no sustituida")

readonly = {"id_usuario": int(user[0]), "nombre": str(user[1]), "rol": "Usuario",
            "comunidades": [{"id_comunidad": community_id, "puede_ver": 1, "puede_actualizar": 0}]}
try:
    command(readonly, "erp1.onboarding.preview", community_id, {
        "tipo": "propietarios", "hash_archivo": "d" * 64, "nombre_archivo": "x.xlsx",
        "ruta_privada": "x", "hoja": "X", "cabeceras": ["Codigo"],
        "mapeo": {"Codigo": "codigo_propietario"}, "opciones": {}, "filas": owners,
    })
    raise AssertionError("Un usuario sin permiso ha podido importar")
except PermissionError:
    pass
checks.append("permiso de comunidad aplicado en backend")

assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert not list(conn.execute("PRAGMA foreign_key_check"))
for table, digest in economic_before.items():
    assert table_hash(conn, table) == digest
checks.append("resultados economicos ERP 2 permanecen identicos")
conn.close()
print(json.dumps({"ok": True, "checks": checks, "work": str(work)}, ensure_ascii=False, indent=2))
