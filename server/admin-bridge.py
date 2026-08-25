from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import sys
from datetime import datetime


DATABASE = sys.argv[1]
REQUEST = json.loads(sys.argv[2])
SESSION = REQUEST.get("session") or {}
ACTION = str(REQUEST.get("action") or "")
DATA = REQUEST.get("data") or {}
PC = str(REQUEST.get("pc") or "web")
ROLES = ["Superusuario", "Administrador", "Usuario", "Consulta", "Presidente", "Seguridad"]


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS usuario_permisos (
               id_usuario INTEGER PRIMARY KEY,
               gestionar_seguridad INTEGER NOT NULL DEFAULT 0,
               usuario_asignacion TEXT,
               fecha_asignacion TEXT,
               FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
           )"""
    )
    conn.commit()
    return conn


def dictionaries(rows) -> list[dict]:
    return [dict(row) for row in rows]


def require_superuser(conn: sqlite3.Connection) -> sqlite3.Row:
    user_id = int(SESSION.get("id_usuario") or 0)
    user = conn.execute(
        "SELECT id_usuario,nombre,rol,activo FROM usuarios WHERE id_usuario=?",
        (user_id,),
    ).fetchone()
    if not user or not user["activo"] or user["rol"] != "Superusuario" or SESSION.get("rol") != "Superusuario":
        raise PermissionError("Solo el Superusuario puede administrar usuarios y comunidades.")
    return user


def audit(conn: sqlite3.Connection, action: str, entity: str, entity_id: int | None, detail: str) -> None:
    conn.execute(
        """INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle)
           VALUES (?,?,?,?,?,?,?)""",
        (now_iso(), str(SESSION.get("nombre") or "web"), PC, action, entity, entity_id, detail),
    )


def hash_secret(secret: str) -> str:
    salt = secrets.token_hex(16)
    iterations = 260000
    digest = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt.encode("utf-8"), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${digest.hex()}"


def verify_secret(secret: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    try:
        algorithm, iterations, salt, digest = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        calculated = hashlib.pbkdf2_hmac(
            "sha256", secret.encode("utf-8"), salt.encode("utf-8"), int(iterations)
        ).hex()
        return hmac.compare_digest(calculated, digest)
    except (TypeError, ValueError):
        return False


def temporary_key() -> str:
    return secrets.token_urlsafe(9).replace("-", "").replace("_", "")[:10].upper()


def admin_list() -> dict:
    conn = connection()
    require_superuser(conn)
    users = dictionaries(conn.execute(
        """SELECT u.id_usuario,u.nombre,u.rol,u.activo,u.password_configurada,
                  u.requiere_cambio_password,u.ultimo_acceso,u.intentos_fallidos,u.bloqueado,
                  u.fecha_creacion,COALESCE(p.gestionar_seguridad,0) AS gestionar_seguridad
           FROM usuarios u
           LEFT JOIN usuario_permisos p ON p.id_usuario=u.id_usuario
           ORDER BY u.nombre COLLATE NOCASE"""
    ).fetchall())
    assignments = conn.execute(
        "SELECT id_usuario,id_comunidad FROM usuario_comunidad ORDER BY id_usuario,id_comunidad"
    ).fetchall()
    by_user: dict[int, list[int]] = {}
    for row in assignments:
        by_user.setdefault(int(row["id_usuario"]), []).append(int(row["id_comunidad"]))
    for user in users:
        user["community_ids"] = by_user.get(int(user["id_usuario"]), [])
        user["password_status"] = "Configurada" if user.get("password_configurada") and not user.get("requiere_cambio_password") else "Clave temporal pendiente"
    communities = dictionaries(conn.execute(
        """SELECT c.id_comunidad,c.nombre,c.descripcion,c.activo,c.fecha_creacion,
                  COUNT(DISTINCT uc.id_usuario) AS total_usuarios,
                  COUNT(DISTINCT p.id_proyecto) AS total_proyectos,
                  COUNT(DISTINCT t.id_tarea) AS total_tareas
           FROM comunidades c
           LEFT JOIN usuario_comunidad uc ON uc.id_comunidad=c.id_comunidad
           LEFT JOIN proyectos p ON p.id_comunidad=c.id_comunidad
           LEFT JOIN tareas t ON t.id_comunidad=c.id_comunidad
           GROUP BY c.id_comunidad ORDER BY c.nombre COLLATE NOCASE"""
    ).fetchall())
    conn.close()
    return {"users": users, "communities": communities, "roles": ROLES}


def normalized_community_ids(conn: sqlite3.Connection, values) -> list[int]:
    ids = sorted({int(value) for value in (values or []) if str(value).isdigit()})
    if not ids:
        return []
    marks = ",".join("?" for _ in ids)
    existing = {int(row[0]) for row in conn.execute(f"SELECT id_comunidad FROM comunidades WHERE id_comunidad IN ({marks})", ids)}
    if existing != set(ids):
        raise ValueError("Alguna comunidad seleccionada ya no existe.")
    return ids


def save_user() -> dict:
    conn = connection()
    current = require_superuser(conn)
    user_id = int(DATA.get("id_usuario") or 0)
    name = str(DATA.get("nombre") or "").strip()
    role = str(DATA.get("rol") or "Usuario").strip()
    active = 1 if DATA.get("activo", True) else 0
    manage_security = 1 if DATA.get("gestionar_seguridad", False) else 0
    if not name:
        raise ValueError("El nombre del usuario es obligatorio.")
    if role not in ROLES:
        raise ValueError("El rol seleccionado no es valido.")
    duplicate = conn.execute(
        "SELECT id_usuario FROM usuarios WHERE lower(trim(nombre))=lower(trim(?)) AND id_usuario<>?",
        (name, user_id),
    ).fetchone()
    if duplicate:
        raise ValueError("Ya existe otro usuario con ese nombre.")
    temp_key = ""
    community_ids = normalized_community_ids(conn, DATA.get("community_ids"))
    with conn:
        if user_id:
            existing = conn.execute("SELECT * FROM usuarios WHERE id_usuario=?", (user_id,)).fetchone()
            if not existing:
                raise ValueError("El usuario ya no existe.")
            if user_id == int(current["id_usuario"]) and (not active or role != "Superusuario"):
                raise ValueError("No puedes desactivar ni retirar el rol de tu propia sesion.")
            if existing["rol"] == "Superusuario" and existing["activo"] and (not active or role != "Superusuario"):
                others = conn.execute(
                    "SELECT COUNT(*) FROM usuarios WHERE rol='Superusuario' AND activo=1 AND id_usuario<>?",
                    (user_id,),
                ).fetchone()[0]
                if not others:
                    raise ValueError("Debe quedar al menos un Superusuario activo.")
            conn.execute("UPDATE usuarios SET nombre=?,rol=?,activo=? WHERE id_usuario=?", (name, role, active, user_id))
            action = "Editar usuario web"
        else:
            temp_key = temporary_key()
            cursor = conn.execute(
                """INSERT INTO usuarios
                   (nombre,rol,activo,fecha_creacion,usuario_creacion,pc_creacion,password_hash,
                    password_configurada,clave_temporal_hash,requiere_cambio_password,intentos_fallidos,bloqueado)
                   VALUES (?,?,?,?,?,?,NULL,0,?,1,0,0)""",
                (name, role, active, now_iso(), str(SESSION.get("nombre") or "web"), PC, hash_secret(temp_key)),
            )
            user_id = int(cursor.lastrowid)
            action = "Crear usuario web"
        conn.execute("DELETE FROM usuario_comunidad WHERE id_usuario=?", (user_id,))
        conn.executemany(
            "INSERT INTO usuario_comunidad (id_usuario,id_comunidad) VALUES (?,?)",
            [(user_id, community_id) for community_id in community_ids],
        )
        conn.execute(
            """INSERT INTO usuario_permisos
               (id_usuario,gestionar_seguridad,usuario_asignacion,fecha_asignacion)
               VALUES (?,?,?,?)
               ON CONFLICT(id_usuario) DO UPDATE SET
                   gestionar_seguridad=excluded.gestionar_seguridad,
                   usuario_asignacion=excluded.usuario_asignacion,
                   fecha_asignacion=excluded.fecha_asignacion""",
            (user_id, manage_security, str(SESSION.get("nombre") or "web"), now_iso()),
        )
        audit(
            conn,
            action,
            "usuario",
            user_id,
            f"{name}; rol={role}; activo={active}; comunidades={community_ids}; gestionar_seguridad={manage_security}",
        )
    conn.close()
    return {"ok": True, "id_usuario": user_id, "temporary_key": temp_key}


def save_community() -> dict:
    conn = connection()
    require_superuser(conn)
    community_id = int(DATA.get("id_comunidad") or 0)
    name = str(DATA.get("nombre") or "").strip()
    description = str(DATA.get("descripcion") or "").strip()
    active = 1 if DATA.get("activo", True) else 0
    if not name:
        raise ValueError("El nombre de la comunidad es obligatorio.")
    duplicate = conn.execute(
        "SELECT id_comunidad FROM comunidades WHERE lower(trim(nombre))=lower(trim(?)) AND id_comunidad<>?",
        (name, community_id),
    ).fetchone()
    if duplicate:
        raise ValueError("Ya existe otra comunidad con ese nombre.")
    with conn:
        if community_id:
            if not conn.execute("SELECT 1 FROM comunidades WHERE id_comunidad=?", (community_id,)).fetchone():
                raise ValueError("La comunidad ya no existe.")
            conn.execute(
                "UPDATE comunidades SET nombre=?,descripcion=?,activo=? WHERE id_comunidad=?",
                (name, description, active, community_id),
            )
            action = "Editar comunidad web"
        else:
            cursor = conn.execute(
                """INSERT INTO comunidades (nombre,descripcion,activo,fecha_creacion,usuario_creacion,pc_creacion)
                   VALUES (?,?,?,?,?,?)""",
                (name, description, active, now_iso(), str(SESSION.get("nombre") or "web"), PC),
            )
            community_id = int(cursor.lastrowid)
            action = "Crear comunidad web"
        audit(conn, action, "comunidad", community_id, f"{name}; activo={active}")
    conn.close()
    return {"ok": True, "id_comunidad": community_id}


def reset_password() -> dict:
    conn = connection()
    require_superuser(conn)
    user_id = int(DATA.get("id_usuario") or 0)
    user = conn.execute("SELECT nombre FROM usuarios WHERE id_usuario=?", (user_id,)).fetchone()
    if not user:
        raise ValueError("El usuario ya no existe.")
    temp_key = temporary_key()
    with conn:
        conn.execute(
            """UPDATE usuarios SET password_hash=NULL,password_configurada=0,clave_temporal_hash=?,
                      requiere_cambio_password=1,intentos_fallidos=0,bloqueado=0 WHERE id_usuario=?""",
            (hash_secret(temp_key), user_id),
        )
        audit(conn, "Resetear password web", "usuario", user_id, f"Nueva clave temporal para {user['nombre']}")
    conn.close()
    return {"ok": True, "id_usuario": user_id, "temporary_key": temp_key, "nombre": user["nombre"]}


def unlock_user() -> dict:
    conn = connection()
    require_superuser(conn)
    user_id = int(DATA.get("id_usuario") or 0)
    user = conn.execute("SELECT nombre FROM usuarios WHERE id_usuario=?", (user_id,)).fetchone()
    if not user:
        raise ValueError("El usuario ya no existe.")
    with conn:
        conn.execute("UPDATE usuarios SET intentos_fallidos=0,bloqueado=0 WHERE id_usuario=?", (user_id,))
        audit(conn, "Desbloquear usuario web", "usuario", user_id, str(user["nombre"]))
    conn.close()
    return {"ok": True}


def first_access() -> dict:
    name = str(DATA.get("nombre") or "").strip()
    key = str(DATA.get("clave_temporal") or "").strip()
    password = str(DATA.get("password") or "")
    confirmation = str(DATA.get("confirmacion") or "")
    if not name or not key:
        raise ValueError("Selecciona el usuario e introduce la clave temporal.")
    if password != confirmation:
        raise ValueError("Las contrasenas no coinciden.")
    if len(password.strip()) < 6:
        raise ValueError("La contrasena debe tener al menos 6 caracteres.")
    conn = connection()
    user = conn.execute("SELECT * FROM usuarios WHERE nombre=?", (name,)).fetchone()
    if not user or not user["activo"]:
        conn.close()
        raise ValueError("Usuario no valido o inactivo.")
    if user["bloqueado"]:
        conn.close()
        raise ValueError("Usuario bloqueado. Solicita al Superusuario una nueva clave temporal.")
    if user["password_configurada"] and not user["requiere_cambio_password"]:
        conn.close()
        raise ValueError("Este usuario ya tiene una contrasena configurada.")
    if not verify_secret(key, user["clave_temporal_hash"]):
        failed = int(user["intentos_fallidos"] or 0) + 1
        blocked = 1 if failed >= 5 else 0
        with conn:
            conn.execute(
                "UPDATE usuarios SET intentos_fallidos=?,bloqueado=? WHERE id_usuario=?",
                (failed, blocked, user["id_usuario"]),
            )
            conn.execute(
                """INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle)
                   VALUES (?,?,?,?,?,?,?)""",
                (now_iso(), name, PC, "Clave temporal incorrecta web", "usuario", user["id_usuario"], f"Intento {failed}"),
            )
        conn.close()
        raise ValueError("Clave temporal incorrecta.")
    with conn:
        conn.execute(
            """UPDATE usuarios SET password_hash=?,password_configurada=1,clave_temporal_hash=NULL,
                      requiere_cambio_password=0,ultimo_acceso=?,intentos_fallidos=0,bloqueado=0
               WHERE id_usuario=?""",
            (hash_secret(password), now_iso(), user["id_usuario"]),
        )
        conn.execute(
            """INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle)
               VALUES (?,?,?,?,?,?,?)""",
            (now_iso(), name, PC, "Configurar password definitivo web", "usuario", user["id_usuario"], "Primer acceso completado."),
        )
    conn.close()
    return {"ok": True}


def main() -> dict:
    if ACTION == "first_access":
        return first_access()
    actions = {
        "list": admin_list,
        "save_user": save_user,
        "save_community": save_community,
        "reset_password": reset_password,
        "unlock_user": unlock_user,
    }
    if ACTION not in actions:
        raise ValueError("Accion de administracion no permitida.")
    return actions[ACTION]()


try:
    print(json.dumps(main(), ensure_ascii=False))
except PermissionError as exc:
    print(json.dumps({"error_type": "PermissionError", "error": str(exc)}, ensure_ascii=False))
    raise SystemExit(2)
except (ValueError, sqlite3.Error) as exc:
    print(json.dumps({"error_type": "ValueError", "error": str(exc)}, ensure_ascii=False))
    raise SystemExit(3)
