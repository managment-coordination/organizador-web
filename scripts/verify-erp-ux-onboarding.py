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
assert conn.execute("SELECT MAX(version) FROM erp_schema_migrations").fetchone()[0] == 6
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
