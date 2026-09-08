"""Permissions shared by the web session, administration and domain bridges."""

import json
import sqlite3
from datetime import datetime


WORK_ROLES = {"Superusuario", "Administrador", "Usuario"}
FIELDS = (
    "puede_ver", "puede_crear", "puede_actualizar", "puede_ver_documentos",
    "puede_generar_informes", "puede_gestionar_asambleas", "puede_gestionar_seguridad",
)


def stamp():
    return datetime.now().isoformat(timespec="seconds")


def defaults(role, security=False):
    work = role in WORK_ROLES
    general = work or role == "Consulta"
    return {
        "puede_ver": 1,
        "puede_crear": int(work),
        "puede_actualizar": int(work),
        "puede_ver_documentos": int(general or role == "Presidente"),
        "puede_generar_informes": int(general),
        "puede_gestionar_asambleas": int(work),
        "puede_gestionar_seguridad": int(work and security),
    }


def columns(conn, table):
    return {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}


def migrate(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS web_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    if conn.execute("SELECT 1 FROM web_migrations WHERE version='access_v1'").fetchone():
        migrate_data_scope(conn)
        from work_domain import migrate as migrate_work
        migrate_work(conn)
        from presidency_domain import migrate as migrate_presidency
        migrate_presidency(conn)
        return
    with conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS usuario_comunidad_permisos (
            id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario),
            id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
            rol_en_comunidad TEXT NOT NULL,
            puede_ver INTEGER NOT NULL DEFAULT 1,
            puede_crear INTEGER NOT NULL DEFAULT 0,
            puede_actualizar INTEGER NOT NULL DEFAULT 0,
            puede_ver_documentos INTEGER NOT NULL DEFAULT 1,
            puede_generar_informes INTEGER NOT NULL DEFAULT 0,
            puede_gestionar_asambleas INTEGER NOT NULL DEFAULT 0,
            puede_gestionar_seguridad INTEGER NOT NULL DEFAULT 0,
            activo INTEGER NOT NULL DEFAULT 1,
            fecha_actualizacion TEXT NOT NULL,
            PRIMARY KEY (id_usuario,id_comunidad)
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS comunidad_presidencia (
            id_comunidad INTEGER PRIMARY KEY REFERENCES comunidades(id_comunidad),
            id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario),
            fecha_asignacion TEXT NOT NULL
        )""")
        if "auth_version" not in columns(conn, "usuarios"):
            conn.execute("ALTER TABLE usuarios ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1")
        for table, field in (("solicitudes_presidente", "id_usuario_presidente"), ("notificaciones", "id_usuario_destino")):
            if field not in columns(conn, table):
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {field} INTEGER REFERENCES usuarios(id_usuario)")
        for row in conn.execute("""SELECT u.id_usuario,u.rol,uc.id_comunidad,
                    COALESCE(p.gestionar_seguridad,0) AS seguridad,c.nombre
                FROM usuario_comunidad uc JOIN usuarios u USING(id_usuario)
                JOIN comunidades c USING(id_comunidad)
                LEFT JOIN usuario_permisos p ON p.id_usuario=u.id_usuario""").fetchall():
            # The legacy security service only belonged to the Macrocomunidad.
            security = row["seguridad"] and row["nombre"] == "Macrocomunidad San Roque Club"
            save_permissions(conn, row["id_usuario"], row["id_comunidad"], row["rol"], defaults(row["rol"], security))
        conn.execute("""INSERT OR IGNORE INTO comunidad_presidencia
            SELECT uc.id_comunidad,MIN(u.id_usuario),? FROM usuario_comunidad uc
            JOIN usuarios u USING(id_usuario) WHERE u.rol='Presidente' AND u.activo=1
            GROUP BY uc.id_comunidad HAVING COUNT(*)=1""", (stamp(),))
        conn.execute("""UPDATE solicitudes_presidente SET id_usuario_presidente=(
            SELECT id_usuario FROM comunidad_presidencia p WHERE p.id_comunidad=solicitudes_presidente.id_comunidad)
            WHERE id_usuario_presidente IS NULL""")
        conn.execute("""UPDATE notificaciones SET id_usuario_destino=(
            SELECT id_usuario FROM usuarios u WHERE u.nombre=notificaciones.usuario_destino)
            WHERE id_usuario_destino IS NULL""")
        conn.execute("""UPDATE notificaciones SET id_usuario_destino=(
            SELECT id_usuario_presidente FROM solicitudes_presidente s WHERE s.id_solicitud=notificaciones.id_solicitud)
            WHERE usuario_destino IN ('Presidente','Presidencia') AND id_solicitud IS NOT NULL""")
        conn.execute("INSERT INTO web_migrations VALUES ('access_v1',?)", (stamp(),))
    migrate_data_scope(conn)
    from work_domain import migrate as migrate_work
    migrate_work(conn)
    from presidency_domain import migrate as migrate_presidency
    migrate_presidency(conn)


def migrate_data_scope(conn):
    if conn.execute("SELECT 1 FROM web_migrations WHERE version='data_scope_v1'").fetchone():
        migrate_independent_tasks(conn)
        return
    macro = conn.execute("SELECT id_comunidad FROM comunidades WHERE nombre='Macrocomunidad San Roque Club'").fetchone()
    if not macro:
        raise ValueError("No se puede identificar la comunidad de los datos historicos.")
    with conn:
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'cf_%'").fetchall():
            table = row[0]
            if "id_comunidad" not in columns(conn, table):
                conn.execute(f'ALTER TABLE "{table}" ADD COLUMN id_comunidad INTEGER REFERENCES comunidades(id_comunidad)')
                conn.execute(f'UPDATE "{table}" SET id_comunidad=?', (macro[0],))
        if "id_comunidad" not in columns(conn, "seguridad_documentos"):
            conn.execute("ALTER TABLE seguridad_documentos ADD COLUMN id_comunidad INTEGER REFERENCES comunidades(id_comunidad)")
            conn.execute("UPDATE seguridad_documentos SET id_comunidad=?", (macro[0],))
        conn.execute("UPDATE seguridad_documentos SET hash_archivo=CAST(id_comunidad AS TEXT)||':'||hash_archivo WHERE instr(hash_archivo,':')=0")
        conn.execute("DROP INDEX IF EXISTS idx_seguridad_reporte")
        conn.execute("""CREATE UNIQUE INDEX idx_seguridad_reporte ON seguridad_incidencias(id_comunidad,numero_reporte)
            WHERE COALESCE(numero_reporte,'')<>''""")
        conn.execute("INSERT INTO web_migrations VALUES ('data_scope_v1',?)", (stamp(),))
    migrate_independent_tasks(conn)


def migrate_independent_tasks(conn):
    if conn.execute("SELECT 1 FROM web_migrations WHERE version='independent_tasks_v1'").fetchone():
        return
    schema = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='tareas'").fetchone()[0]
    if "id_proyecto INTEGER NOT NULL" in schema:
        conn.commit()
        foreign_keys = conn.execute("PRAGMA foreign_keys").fetchone()[0]
        existing_errors = set(tuple(row) for row in conn.execute("PRAGMA foreign_key_check"))
        objects = [row[0] for row in conn.execute("SELECT sql FROM sqlite_master WHERE tbl_name='tareas' AND type IN ('index','trigger') AND sql IS NOT NULL")]
        sequence = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='tareas'").fetchone()
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            with conn:
                conn.execute(schema.replace("CREATE TABLE tareas", "CREATE TABLE tareas_independent", 1).replace("id_proyecto INTEGER NOT NULL", "id_proyecto INTEGER"))
                conn.execute("INSERT INTO tareas_independent SELECT * FROM tareas")
                conn.execute("DROP TABLE tareas")
                conn.execute("ALTER TABLE tareas_independent RENAME TO tareas")
                for sql in objects:
                    conn.execute(sql)
                if sequence:
                    conn.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='tareas'", (sequence[0],))
                if set(tuple(row) for row in conn.execute("PRAGMA foreign_key_check")) - existing_errors:
                    raise ValueError("La migracion de tareas alteraria relaciones existentes.")
        finally:
            conn.execute(f"PRAGMA foreign_keys={foreign_keys}")
    with conn:
        conn.execute("INSERT INTO web_migrations VALUES ('independent_tasks_v1',?)", (stamp(),))


def install_scoped_views(conn, community_ids, tables):
    """Read projections for legacy analytical queries; writes use the main tables."""
    ids = ",".join(str(int(value)) for value in community_ids) or "-1"
    for table in tables:
        if "id_comunidad" not in columns(conn, table):
            continue
        conn.execute(f'CREATE TEMP VIEW IF NOT EXISTS "{table}" AS SELECT * FROM main."{table}" WHERE id_comunidad IN ({ids})')


def install_document_views(conn, session):
    for field, tables in (
        ('puede_ver_documentos', ['anexos_registros', 'documentos_importados', 'asamblea_documentos']),
        ('puede_generar_informes', ['informes', 'informes_contables']),
    ):
        ids = [c['id_comunidad'] for c in session.get('comunidades', []) if permission(session, c['id_comunidad'], field)]
        install_scoped_views(conn, ids, tables)


def save_permissions(conn, user_id, community_id, role, permissions):
    values = [int(bool(permissions.get(field, 0))) for field in FIELDS]
    conn.execute(f"""INSERT INTO usuario_comunidad_permisos
        (id_usuario,id_comunidad,rol_en_comunidad,{','.join(FIELDS)},activo,fecha_actualizacion)
        VALUES (?,?,?,{','.join('?' for _ in FIELDS)},1,?)
        ON CONFLICT(id_usuario,id_comunidad) DO UPDATE SET
        rol_en_comunidad=excluded.rol_en_comunidad,
        {','.join(f'{f}=excluded.{f}' for f in FIELDS)},activo=1,fecha_actualizacion=excluded.fecha_actualizacion""",
        [user_id, community_id, role, *values, stamp()])


def profile(conn, user_id):
    user = conn.execute("""SELECT id_usuario,nombre,rol,activo,password_configurada,
        requiere_cambio_password,bloqueado,auth_version FROM usuarios WHERE id_usuario=?""", (user_id,)).fetchone()
    if not user or not user["activo"]:
        return None
    result = dict(user)
    if user["rol"] == "Superusuario":
        communities = [dict(row) for row in conn.execute("SELECT id_comunidad,nombre FROM comunidades WHERE activo=1 ORDER BY nombre")]
        for row in communities:
            row.update(defaults("Superusuario", True), rol_en_comunidad="Superusuario")
    else:
        communities = []
        for row in conn.execute("""SELECT c.id_comunidad,c.nombre,p.* FROM usuario_comunidad uc
            JOIN comunidades c USING(id_comunidad)
            LEFT JOIN usuario_comunidad_permisos p ON p.id_usuario=uc.id_usuario AND p.id_comunidad=uc.id_comunidad
            WHERE uc.id_usuario=? AND c.activo=1 AND COALESCE(p.activo,1)=1 AND COALESCE(p.puede_ver,1)=1
            ORDER BY c.nombre""", (user_id,)):
            data = dict(row)
            effective_role = data.get("rol_en_comunidad") or user["rol"]
            # A restricted global role cannot be promoted by an assignment.
            if user["rol"] not in WORK_ROLES:
                effective_role = user["rol"]
            caps = defaults(effective_role, bool(data.get("puede_gestionar_seguridad")))
            community = {"id_comunidad": data["id_comunidad"], "nombre": data["nombre"], "rol_en_comunidad": effective_role}
            for field in FIELDS:
                community[field] = int(caps[field] and (data.get(field) if data.get(field) is not None else caps[field]))
            communities.append(community)
    result["comunidades"] = communities
    return result


def permission(session, community_id, field="puede_ver"):
    if session.get("rol") == "Superusuario":
        return any(int(row["id_comunidad"]) == int(community_id or 0) for row in session.get("comunidades", []))
    return any(int(row["id_comunidad"]) == int(community_id or 0) and row.get(field, 0) for row in session.get("comunidades", []))


def require_permission(session, community_id, field="puede_ver"):
    if not permission(session, community_id, field):
        raise PermissionError("No tienes permiso para esta accion en la comunidad seleccionada.")


def president_for(conn, community_id):
    row = conn.execute("""SELECT u.id_usuario,u.nombre FROM comunidad_presidencia p
        JOIN usuarios u ON u.id_usuario=p.id_usuario
        JOIN usuario_comunidad uc ON uc.id_usuario=u.id_usuario AND uc.id_comunidad=p.id_comunidad
        JOIN comunidades c ON c.id_comunidad=p.id_comunidad
        WHERE p.id_comunidad=? AND u.activo=1 AND u.rol='Presidente' AND c.activo=1""", (community_id,)).fetchone()
    if not row:
        raise ValueError("Esta comunidad no tiene presidente asignado. Asignalo desde Administracion antes de solicitar una decision.")
    return dict(row)


def require_president_entity(conn, session, entity_type, entity_id):
    if session.get("rol") != "Presidente":
        return
    field = "id_tarea" if entity_type == "task" else "id_proyecto"
    row = conn.execute(f"""SELECT 1 FROM solicitudes_presidente s
        WHERE s.{field}=? AND s.id_usuario_presidente=? AND s.estado='Pendiente'
        AND (?='project' OR s.tipo_origen='tarea') LIMIT 1""",
        (entity_id, session["id_usuario"], entity_type)).fetchone()
    if not row:
        raise PermissionError("Solo puedes abrir el expediente de una solicitud pendiente dirigida a ti.")


def visible_history(session, stored):
    try:
        communities = json.loads(stored or "[]")
        ids = {int(row["id_comunidad"]) for row in communities}
    except (ValueError, TypeError, KeyError):
        return False
    allowed = {int(row["id_comunidad"]) for row in session.get("comunidades", [])}
    return bool(ids) and ids.issubset(allowed)
