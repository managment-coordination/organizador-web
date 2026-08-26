import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


DATABASE = sys.argv[1]
REQUEST = json.loads(sys.argv[2])
SESSION = REQUEST.get("session") or {}
ACTION = str(REQUEST.get("action") or "")
DATA = REQUEST.get("data") or {}
USER = str(SESSION.get("nombre") or "web")
ROLE = str(SESSION.get("rol") or "")
PC = str(REQUEST.get("pc") or "web")
ALLOWED = [int(row.get("id_comunidad")) for row in SESSION.get("comunidades", []) if row.get("id_comunidad")]
WRITE_ROLES = {"Superusuario", "Administrador", "Usuario"}


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connection(readonly=False):
    if readonly:
        conn = sqlite3.connect(f"file:{DATABASE}?mode=ro", uri=True)
    else:
        conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


def dictionaries(rows):
    return [dict(row) for row in rows]


def require_visible(assembly_id, conn):
    row = conn.execute(
        """SELECT a.*, c.nombre AS comunidad
           FROM asambleas a LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
           WHERE a.id_asamblea=?""",
        (int(assembly_id),),
    ).fetchone()
    if not row:
        raise ValueError("La asamblea no existe.")
    if ROLE != "Superusuario" and int(row["id_comunidad"] or 0) not in ALLOWED:
        raise PermissionError("No tienes permiso para esta comunidad.")
    return dict(row)


def require_write():
    if ROLE not in WRITE_ROLES:
        raise PermissionError("Tu perfil solo puede consultar asambleas.")


def require_community(community_id):
    value = int(community_id or 0)
    if not value:
        raise ValueError("Selecciona una comunidad.")
    if ROLE != "Superusuario" and value not in ALLOWED:
        raise PermissionError("No tienes permiso para esa comunidad.")
    return value


def audit(conn, action, entity, entity_id, detail=""):
    conn.execute(
        "INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)",
        (now(), USER, PC, action, entity, int(entity_id or 0), str(detail or "")[:2000]),
    )


def update_log(conn, assembly_id, kind, comment):
    timestamp = now()
    conn.execute(
        """INSERT INTO asamblea_actualizaciones
           (id_asamblea,fecha_hora,tipo,comentario,usuario,pc) VALUES (?,?,?,?,?,?)""",
        (int(assembly_id), timestamp, str(kind or "Seguimiento"), str(comment or ""), USER, PC),
    )


def ensure_minutes_schema(conn):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS asamblea_actas (
             id_acta INTEGER PRIMARY KEY AUTOINCREMENT,
             id_asamblea INTEGER NOT NULL UNIQUE,
             estado TEXT NOT NULL DEFAULT 'Borrador',
             transcripcion TEXT NOT NULL DEFAULT '',
             fuente_transcripcion TEXT NOT NULL DEFAULT '',
             convocante TEXT NOT NULL DEFAULT '',
             secretario TEXT NOT NULL DEFAULT '',
             hora_cierre TEXT NOT NULL DEFAULT '',
             introduccion_es TEXT NOT NULL DEFAULT '',
             introduccion_en TEXT NOT NULL DEFAULT '',
             cierre_es TEXT NOT NULL DEFAULT '',
             cierre_en TEXT NOT NULL DEFAULT '',
             puntos_json TEXT NOT NULL DEFAULT '[]',
             advertencias_json TEXT NOT NULL DEFAULT '[]',
             generado_ia INTEGER NOT NULL DEFAULT 0,
             fecha_creacion TEXT NOT NULL,
             fecha_actualizacion TEXT NOT NULL,
             usuario_actualizacion TEXT NOT NULL DEFAULT '',
             pc_actualizacion TEXT NOT NULL DEFAULT '',
             FOREIGN KEY(id_asamblea) REFERENCES asambleas(id_asamblea)
           )"""
    )


def decoded_json(value, fallback):
    try:
        parsed = json.loads(str(value or ""))
        return parsed if isinstance(parsed, type(fallback)) else fallback
    except (TypeError, ValueError, json.JSONDecodeError):
        return fallback


def minutes_row(conn, assembly_id, create=True):
    ensure_minutes_schema(conn)
    row = conn.execute("SELECT * FROM asamblea_actas WHERE id_asamblea=?", (int(assembly_id),)).fetchone()
    if not row and create:
        timestamp = now()
        conn.execute(
            """INSERT INTO asamblea_actas
               (id_asamblea,fecha_creacion,fecha_actualizacion,usuario_actualizacion,pc_actualizacion)
               VALUES (?,?,?,?,?)""",
            (int(assembly_id), timestamp, timestamp, USER, PC),
        )
        row = conn.execute("SELECT * FROM asamblea_actas WHERE id_asamblea=?", (int(assembly_id),)).fetchone()
    if not row:
        return None
    result = dict(row)
    result["puntos"] = decoded_json(result.pop("puntos_json", "[]"), [])
    result["advertencias"] = decoded_json(result.pop("advertencias_json", "[]"), [])
    result["generado_ia"] = bool(result.get("generado_ia"))
    return result
    conn.execute(
        """UPDATE asambleas SET fecha_ultima_actualizacion=?,usuario_ultima_actualizacion=?,pc_ultima_actualizacion=?
           WHERE id_asamblea=?""",
        (timestamp, USER, PC, int(assembly_id)),
    )


def owner_rows(conn, assembly_id):
    return dictionaries(conn.execute(
        """SELECT propietario,SUM(coeficiente) AS coeficiente,COUNT(*) AS propiedades,MAX(moroso) AS moroso,
                  GROUP_CONCAT(propiedad_id, ' | ') AS propiedad_ids
           FROM asamblea_censo WHERE id_asamblea=? GROUP BY propietario ORDER BY propietario""",
        (int(assembly_id),),
    ).fetchall())


def attendance_rows(conn, assembly_id):
    return dictionaries(conn.execute(
        """SELECT a.*,o.coeficiente,o.propiedades,o.moroso,o.propiedad_ids
           FROM asamblea_asistencia a
           LEFT JOIN (
             SELECT propietario,SUM(coeficiente) AS coeficiente,COUNT(*) AS propiedades,MAX(moroso) AS moroso,
                    GROUP_CONCAT(propiedad_id, ' | ') AS propiedad_ids
             FROM asamblea_censo WHERE id_asamblea=? GROUP BY propietario
           ) o ON o.propietario=a.propietario
           WHERE a.id_asamblea=? ORDER BY a.tipo,a.propietario""",
        (int(assembly_id), int(assembly_id)),
    ).fetchall())


def totals_for(owners, attendance):
    eligible = [row for row in attendance if not int(row.get("sin_voto") or 0) and not int(row.get("moroso") or 0)]
    return {
        "owners": len(owners),
        "properties": sum(int(row.get("propiedades") or 0) for row in owners),
        "total_coef": sum(float(row.get("coeficiente") or 0) for row in owners),
        "attended_owners": len(attendance),
        "attended_coef": sum(float(row.get("coeficiente") or 0) for row in attendance),
        "eligible_votes": len(eligible),
        "eligible_coef": sum(float(row.get("coeficiente") or 0) for row in eligible),
        "present": sum(1 for row in attendance if row.get("tipo") == "presente"),
        "represented": sum(1 for row in attendance if row.get("tipo") == "representado"),
        "without_vote": sum(1 for row in attendance if int(row.get("sin_voto") or 0) or int(row.get("moroso") or 0)),
    }


def point_result(point, attendance, votes):
    result = {
        "si": {"votes": 0, "coef": 0.0}, "no": {"votes": 0, "coef": 0.0},
        "abs": {"votes": 0, "coef": 0.0}, "sin": {"votes": 0, "coef": 0.0},
        "base_votes": 0, "base_coef": 0.0, "approved": False,
        "majority": point.get("tipo_mayoria") or "simple",
    }
    for row in attendance:
        if int(row.get("sin_voto") or 0) or int(row.get("moroso") or 0):
            continue
        vote = votes.get(row["propietario"], {}).get("voto", "sin")
        if vote not in {"si", "no", "abs", "sin"}:
            vote = "sin"
        coefficient = float(row.get("coeficiente") or 0)
        result[vote]["votes"] += 1
        result[vote]["coef"] += coefficient
        result["base_votes"] += 1
        result["base_coef"] += coefficient
    yes_votes = result["si"]["votes"]
    yes_coefficient = result["si"]["coef"]
    base_votes = max(1, result["base_votes"])
    base_coefficient = max(0.0000001, result["base_coef"])
    majority = result["majority"]
    if majority == "3/5":
        result["approved"] = yes_votes >= base_votes * 0.6 and yes_coefficient >= base_coefficient * 0.6
    elif majority == "2/3":
        result["approved"] = yes_votes >= base_votes * (2 / 3) and yes_coefficient >= base_coefficient * (2 / 3)
    elif majority == "unanimidad":
        result["approved"] = result["no"]["votes"] == 0 and yes_votes > 0
    else:
        result["approved"] = yes_votes > base_votes / 2 and yes_coefficient > base_coefficient / 2
    return result


def list_assemblies():
    conn = connection(True)
    scope = "" if ROLE == "Superusuario" else (f" AND a.id_comunidad IN ({','.join('?' for _ in ALLOWED)})" if ALLOWED else " AND 1=0")
    rows = dictionaries(conn.execute(
        """SELECT a.*,c.nombre AS comunidad,
                  (SELECT COUNT(*) FROM asamblea_puntos p WHERE p.id_asamblea=a.id_asamblea AND p.activo=1) AS total_puntos,
                  (SELECT COUNT(*) FROM asamblea_asistencia s WHERE s.id_asamblea=a.id_asamblea) AS total_asistencia,
                  (SELECT COUNT(*) FROM asamblea_proxys x WHERE x.id_asamblea=a.id_asamblea AND COALESCE(x.estado,'')<>'Eliminado') AS total_proxys,
                  (SELECT COUNT(*) FROM asamblea_documentos d WHERE d.id_asamblea=a.id_asamblea) AS total_documentos
           FROM asambleas a LEFT JOIN comunidades c ON c.id_comunidad=a.id_comunidad
           WHERE 1=1""" + scope + " ORDER BY COALESCE(a.fecha,'') DESC,a.id_asamblea DESC",
        tuple(ALLOWED if ROLE != "Superusuario" else []),
    ).fetchall())
    conn.close()
    return {"assemblies": rows}


def assembly_detail():
    assembly_id = int(DATA.get("id") or 0)
    conn = connection(True)
    assembly = require_visible(assembly_id, conn)
    owners = owner_rows(conn, assembly_id)
    attendance = attendance_rows(conn, assembly_id)
    points = dictionaries(conn.execute(
        "SELECT * FROM asamblea_puntos WHERE id_asamblea=? AND activo=1 ORDER BY orden,id_punto",
        (assembly_id,),
    ).fetchall())
    vote_rows = dictionaries(conn.execute(
        "SELECT id_punto,propietario,voto,origen,bloqueado,fecha_registro FROM asamblea_votos WHERE id_asamblea=?",
        (assembly_id,),
    ).fetchall())
    votes = {}
    for row in vote_rows:
        votes.setdefault(str(row["id_punto"]), {})[row["propietario"]] = {
            "voto": row.get("voto") or "sin", "origen": row.get("origen") or "",
            "bloqueado": bool(row.get("bloqueado")), "fecha": row.get("fecha_registro") or "",
        }
    for point in points:
        point["result"] = point_result(point, attendance, votes.get(str(point["id_punto"]), {}))
    proxies = dictionaries(conn.execute(
        """SELECT id_proxy,propietario,documento,representante,propiedades_json,votos_json,estado,avisos,
                  fecha_importacion,origen_archivo FROM asamblea_proxys WHERE id_asamblea=?
           ORDER BY fecha_importacion DESC,id_proxy DESC""",
        (assembly_id,),
    ).fetchall())
    for proxy in proxies:
        proxy["nombre_archivo"] = Path(str(proxy.pop("origen_archivo", "") or "")).name
    documents = dictionaries(conn.execute(
        """SELECT id_documento_asamblea,nombre_archivo,descripcion,fecha_adjuntado,usuario,carpeta
           FROM asamblea_documentos WHERE id_asamblea=? ORDER BY carpeta,nombre_archivo""",
        (assembly_id,),
    ).fetchall())
    updates = dictionaries(conn.execute(
        "SELECT * FROM asamblea_actualizaciones WHERE id_asamblea=? ORDER BY fecha_hora DESC,id_actualizacion DESC LIMIT 250",
        (assembly_id,),
    ).fetchall())
    groups = {}
    for row in attendance:
        representative = row.get("representante") if row.get("tipo") == "representado" else row.get("propietario")
        representative = str(representative or row.get("propietario") or "Sin representante")
        group = groups.setdefault(representative, {"representante": representative, "members": []})
        member = dict(row)
        member["votes"] = {str(point["id_punto"]): votes.get(str(point["id_punto"]), {}).get(row["propietario"], {"voto": "sin", "origen": "", "bloqueado": False}) for point in points}
        group["members"].append(member)
    conn.close()
    return {
        "assembly": assembly, "owners": owners, "attendance": attendance,
        "totals": totals_for(owners, attendance), "points": points, "votes": votes,
        "groups": list(groups.values()), "proxys": proxies, "documents": documents, "updates": updates,
    }


def create_assembly():
    require_write()
    community_id = require_community(DATA.get("id_comunidad"))
    code = str(DATA.get("codigo") or "").strip()
    name = str(DATA.get("nombre") or "").strip()
    if not code or not name:
        raise ValueError("Codigo y nombre son obligatorios.")
    timestamp = now()
    conn = connection()
    with conn:
        cursor = conn.execute(
            """INSERT INTO asambleas
               (id_comunidad,codigo,nombre,fecha,convocatoria,estado,email_recepcion,ubicacion,presidente,
                administrador,junta_directiva,hora_inicio,lugar_celebracion,observaciones,propiedades_json,
                plantilla_origen,fecha_creacion,usuario_creacion,pc_creacion,fecha_ultima_actualizacion,
                usuario_ultima_actualizacion,pc_ultima_actualizacion)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (community_id, code, name, str(DATA.get("fecha") or ""), str(DATA.get("convocatoria") or "segunda"),
             str(DATA.get("estado") or "Preparacion"), str(DATA.get("email_recepcion") or ""), str(DATA.get("ubicacion") or ""),
             str(DATA.get("presidente") or ""), str(DATA.get("administrador") or ""), str(DATA.get("junta_directiva") or ""),
             str(DATA.get("hora_inicio") or ""), str(DATA.get("lugar_celebracion") or ""), str(DATA.get("observaciones") or ""),
             "", "", timestamp, USER, PC, timestamp, USER, PC),
        )
        assembly_id = int(cursor.lastrowid)
        update_log(conn, assembly_id, "Creacion", "Asamblea creada desde la web.")
        audit(conn, "Crear asamblea web", "asamblea", assembly_id, name)
    conn.close()
    return {"ok": True, "id": assembly_id}


def update_assembly():
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    conn = connection()
    assembly = require_visible(assembly_id, conn)
    community_id = require_community(DATA.get("id_comunidad") or assembly.get("id_comunidad"))
    code = str(DATA.get("codigo", assembly.get("codigo")) or "").strip()
    name = str(DATA.get("nombre", assembly.get("nombre")) or "").strip()
    if not code or not name:
        raise ValueError("Codigo y nombre son obligatorios.")
    with conn:
        conn.execute(
            """UPDATE asambleas SET id_comunidad=?,codigo=?,nombre=?,fecha=?,convocatoria=?,estado=?,
               email_recepcion=?,ubicacion=?,presidente=?,administrador=?,junta_directiva=?,hora_inicio=?,
               lugar_celebracion=?,observaciones=? WHERE id_asamblea=?""",
            (community_id, code, name, str(DATA.get("fecha", assembly.get("fecha")) or ""),
             str(DATA.get("convocatoria", assembly.get("convocatoria")) or "segunda"),
             str(DATA.get("estado", assembly.get("estado")) or "Preparacion"),
             str(DATA.get("email_recepcion", assembly.get("email_recepcion")) or ""),
             str(DATA.get("ubicacion", assembly.get("ubicacion")) or ""), str(DATA.get("presidente", assembly.get("presidente")) or ""),
             str(DATA.get("administrador", assembly.get("administrador")) or ""), str(DATA.get("junta_directiva", assembly.get("junta_directiva")) or ""),
             str(DATA.get("hora_inicio", assembly.get("hora_inicio")) or ""), str(DATA.get("lugar_celebracion", assembly.get("lugar_celebracion")) or ""),
             str(DATA.get("observaciones", assembly.get("observaciones")) or ""), assembly_id),
        )
        update_log(conn, assembly_id, "Edicion", "Datos generales actualizados desde la web.")
        audit(conn, "Editar asamblea web", "asamblea", assembly_id, name)
    conn.close()
    return {"ok": True, "id": assembly_id}


def save_points():
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    points = DATA.get("points") or []
    conn = connection()
    require_visible(assembly_id, conn)
    kept = []
    with conn:
        for order, point in enumerate(points, 1):
            title = str(point.get("titulo") or "").strip()
            if not title:
                continue
            majority = str(point.get("tipo_mayoria") or "simple")
            point_id = int(point.get("id_punto") or 0)
            exists = conn.execute("SELECT id_punto FROM asamblea_puntos WHERE id_punto=? AND id_asamblea=?", (point_id, assembly_id)).fetchone() if point_id else None
            if exists:
                conn.execute("UPDATE asamblea_puntos SET orden=?,titulo=?,tipo_mayoria=?,activo=1 WHERE id_punto=?", (order, title, majority, point_id))
                kept.append(point_id)
            else:
                cursor = conn.execute("INSERT INTO asamblea_puntos (id_asamblea,orden,titulo,tipo_mayoria,activo) VALUES (?,?,?,?,1)", (assembly_id, order, title, majority))
                kept.append(int(cursor.lastrowid))
        if kept:
            placeholders = ",".join("?" for _ in kept)
            conn.execute(f"UPDATE asamblea_puntos SET activo=0 WHERE id_asamblea=? AND id_punto NOT IN ({placeholders})", (assembly_id, *kept))
        else:
            conn.execute("UPDATE asamblea_puntos SET activo=0 WHERE id_asamblea=?", (assembly_id,))
        update_log(conn, assembly_id, "Puntos", f"Puntos de votacion actualizados: {len(kept)}.")
        audit(conn, "Actualizar puntos asamblea web", "asamblea", assembly_id, str(len(kept)))
    conn.close()
    return {"ok": True, "points": len(kept)}


def add_update():
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    comment = str(DATA.get("comentario") or "").strip()
    if not comment:
        raise ValueError("Escribe el comentario del seguimiento.")
    conn = connection()
    require_visible(assembly_id, conn)
    with conn:
        update_log(conn, assembly_id, str(DATA.get("tipo") or "Seguimiento"), comment)
        audit(conn, "Seguimiento asamblea web", "asamblea", assembly_id, str(DATA.get("tipo") or "Seguimiento"))
    conn.close()
    return {"ok": True}


def set_attendance(batch=False):
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    conn = connection()
    require_visible(assembly_id, conn)
    names = DATA.get("propietarios") if batch else [DATA.get("propietario")]
    names = [str(name or "").strip() for name in (names or []) if str(name or "").strip()]
    kind = str(DATA.get("tipo") or "presente")
    representative = str(DATA.get("representante") or "").strip()
    if not names:
        raise ValueError("Selecciona al menos un propietario.")
    if kind not in {"presente", "representado"}:
        raise ValueError("Tipo de asistencia no valido.")
    if kind == "representado" and not representative:
        raise ValueError("Indica el representante.")
    timestamp = now()
    with conn:
        for owner in names:
            census = conn.execute("SELECT MAX(moroso) AS moroso FROM asamblea_censo WHERE id_asamblea=? AND propietario=?", (assembly_id, owner)).fetchone()
            if not census or census["moroso"] is None:
                raise ValueError(f"{owner} no existe en el censo.")
            without_vote = 1 if int(census["moroso"] or 0) or bool(DATA.get("sin_voto")) else 0
            conn.execute(
                """INSERT INTO asamblea_asistencia
                   (id_asamblea,propietario,tipo,representante,sin_voto,fecha_registro,usuario,pc)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(id_asamblea,propietario) DO UPDATE SET tipo=excluded.tipo,representante=excluded.representante,
                   sin_voto=excluded.sin_voto,fecha_registro=excluded.fecha_registro,usuario=excluded.usuario,pc=excluded.pc""",
                (assembly_id, owner, kind, representative if kind == "representado" else "", without_vote, timestamp, USER, PC),
            )
        update_log(conn, assembly_id, "Registro", f"Asistencia actualizada: {len(names)} propietario(s).")
        audit(conn, "Registrar asistencia asamblea web", "asamblea", assembly_id, f"{len(names)}: {kind}")
    conn.close()
    return {"ok": True, "updated": len(names)}


def remove_attendance():
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    owner = str(DATA.get("propietario") or "").strip()
    conn = connection()
    require_visible(assembly_id, conn)
    with conn:
        conn.execute("DELETE FROM asamblea_asistencia WHERE id_asamblea=? AND propietario=?", (assembly_id, owner))
        conn.execute("DELETE FROM asamblea_votos WHERE id_asamblea=? AND propietario=? AND COALESCE(bloqueado,0)=0", (assembly_id, owner))
        update_log(conn, assembly_id, "Registro", f"Asistencia eliminada: {owner}.")
        audit(conn, "Eliminar asistencia asamblea web", "asamblea", assembly_id, owner)
    conn.close()
    return {"ok": True}


def set_moroso():
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    owner = str(DATA.get("propietario") or "").strip()
    reason = str(DATA.get("motivo") or "").strip()
    moroso = bool(DATA.get("moroso"))
    if not owner or not reason:
        raise ValueError("Propietario y motivo son obligatorios.")
    conn = connection()
    require_visible(assembly_id, conn)
    with conn:
        cursor = conn.execute("UPDATE asamblea_censo SET moroso=? WHERE id_asamblea=? AND propietario=?", (1 if moroso else 0, assembly_id, owner))
        if not cursor.rowcount:
            raise ValueError("El propietario no existe en el censo.")
        conn.execute("UPDATE asamblea_asistencia SET sin_voto=? WHERE id_asamblea=? AND propietario=?", (1 if moroso else 0, assembly_id, owner))
        if moroso:
            conn.execute("DELETE FROM asamblea_votos WHERE id_asamblea=? AND propietario=?", (assembly_id, owner))
        update_log(conn, assembly_id, "Morosidad", f"{'Marcado como moroso' if moroso else 'Retirado de morosos'}: {owner}. Motivo: {reason}")
        audit(conn, "Actualizar morosidad asamblea web", "asamblea", assembly_id, f"{owner}: {moroso}")
    conn.close()
    return {"ok": True}


def set_vote(bulk=False):
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    point_id = int(DATA.get("id_punto") or 0)
    vote = str(DATA.get("voto") or "sin")
    if vote not in {"si", "no", "abs", "sin"}:
        raise ValueError("Voto no valido.")
    conn = connection()
    require_visible(assembly_id, conn)
    if not conn.execute("SELECT 1 FROM asamblea_puntos WHERE id_asamblea=? AND id_punto=? AND activo=1", (assembly_id, point_id)).fetchone():
        raise ValueError("El punto de votacion no existe.")
    if bulk:
        representative = str(DATA.get("representante") or "").strip()
        targets = dictionaries(conn.execute(
            """SELECT a.propietario,a.sin_voto,COALESCE(o.moroso,0) AS moroso
               FROM asamblea_asistencia a LEFT JOIN (
                 SELECT propietario,MAX(moroso) AS moroso FROM asamblea_censo WHERE id_asamblea=? GROUP BY propietario
               ) o ON o.propietario=a.propietario
               WHERE a.id_asamblea=? AND ((a.tipo='presente' AND a.propietario=?) OR (a.tipo='representado' AND a.representante=?))""",
            (assembly_id, assembly_id, representative, representative),
        ).fetchall())
    else:
        owner = str(DATA.get("propietario") or "").strip()
        row = conn.execute(
            """SELECT a.propietario,a.sin_voto,COALESCE(o.moroso,0) AS moroso
               FROM asamblea_asistencia a LEFT JOIN (
                 SELECT propietario,MAX(moroso) AS moroso FROM asamblea_censo WHERE id_asamblea=? GROUP BY propietario
               ) o ON o.propietario=a.propietario WHERE a.id_asamblea=? AND a.propietario=?""",
            (assembly_id, assembly_id, owner),
        ).fetchone()
        targets = [dict(row)] if row else []
    if not targets:
        raise ValueError("No se encontraron asistentes para registrar el voto.")
    changed = 0
    locked = 0
    timestamp = now()
    with conn:
        for target in targets:
            if int(target.get("sin_voto") or 0) or int(target.get("moroso") or 0):
                continue
            current = conn.execute("SELECT bloqueado FROM asamblea_votos WHERE id_asamblea=? AND id_punto=? AND propietario=?", (assembly_id, point_id, target["propietario"])).fetchone()
            if current and int(current["bloqueado"] or 0):
                locked += 1
                continue
            conn.execute(
                """INSERT INTO asamblea_votos
                   (id_asamblea,id_punto,propietario,voto,origen,bloqueado,fecha_registro,usuario,pc)
                   VALUES (?,?,?,?,'manual',0,?,?,?)
                   ON CONFLICT(id_asamblea,id_punto,propietario) DO UPDATE SET voto=excluded.voto,origen='manual',
                   bloqueado=0,fecha_registro=excluded.fecha_registro,usuario=excluded.usuario,pc=excluded.pc""",
                (assembly_id, point_id, target["propietario"], vote, timestamp, USER, PC),
            )
            changed += 1
        audit(conn, "Registrar voto asamblea web", "asamblea", assembly_id, f"Punto {point_id}: {vote}; {changed} votos; {locked} bloqueados")
    conn.close()
    return {"ok": True, "changed": changed, "locked": locked}


def add_document():
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    conn = connection()
    assembly = require_visible(assembly_id, conn)
    file_path = str(DATA.get("ruta_archivo") or "")
    name = str(DATA.get("nombre_archivo") or Path(file_path).name)
    with conn:
        cursor = conn.execute(
            """INSERT INTO asamblea_documentos
               (id_asamblea,id_comunidad,nombre_archivo,ruta_archivo,descripcion,fecha_adjuntado,usuario,pc,carpeta)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (assembly_id, assembly["id_comunidad"], name, file_path, str(DATA.get("descripcion") or ""), now(), USER, PC, str(DATA.get("carpeta") or "General")),
        )
        document_id = int(cursor.lastrowid)
        update_log(conn, assembly_id, "Documento", f"Documento anadido: {name}")
        audit(conn, "Anadir documento asamblea web", "asamblea", assembly_id, name)
    conn.close()
    return {"ok": True, "document_id": document_id}


def document_info():
    conn = connection(True)
    row = conn.execute("SELECT * FROM asamblea_documentos WHERE id_documento_asamblea=?", (int(DATA.get("id_documento") or 0),)).fetchone()
    if not row:
        raise ValueError("Documento no encontrado.")
    require_visible(row["id_asamblea"], conn)
    result = dict(row)
    conn.close()
    return result


def delete_document():
    require_write()
    conn = connection()
    row = conn.execute("SELECT * FROM asamblea_documentos WHERE id_documento_asamblea=?", (int(DATA.get("id_documento") or 0),)).fetchone()
    if not row:
        raise ValueError("Documento no encontrado.")
    require_visible(row["id_asamblea"], conn)
    with conn:
        conn.execute("DELETE FROM asamblea_documentos WHERE id_documento_asamblea=?", (row["id_documento_asamblea"],))
        update_log(conn, row["id_asamblea"], "Documento", f"Documento eliminado: {row['nombre_archivo']}")
        audit(conn, "Eliminar documento asamblea web", "asamblea", row["id_asamblea"], row["nombre_archivo"])
    result = {"ok": True, "ruta_archivo": row["ruta_archivo"]}
    conn.close()
    return result


def get_minutes():
    assembly_id = int(DATA.get("id") or 0)
    conn = connection()
    require_visible(assembly_id, conn)
    with conn:
        minutes = minutes_row(conn, assembly_id, True)
    conn.close()
    return {"minutes": minutes}


def save_minutes():
    require_write()
    assembly_id = int(DATA.get("id") or 0)
    conn = connection()
    assembly = require_visible(assembly_id, conn)
    allowed_states = {"Borrador", "Revisada", "Cerrada"}
    state = str(DATA.get("estado") or "Borrador").strip()
    if state not in allowed_states:
        raise ValueError("Estado del acta no valido.")
    points = DATA.get("puntos") or []
    if not isinstance(points, list):
        raise ValueError("El contenido de los puntos no es valido.")
    valid_point_ids = {
        int(row["id_punto"])
        for row in conn.execute(
            "SELECT id_punto FROM asamblea_puntos WHERE id_asamblea=? AND activo=1", (assembly_id,)
        ).fetchall()
    }
    normalized_points = []
    for point in points:
        point_id = int(point.get("id_punto") or 0)
        if point_id not in valid_point_ids:
            continue
        normalized_points.append({
            "id_punto": point_id,
            "debate_es": str(point.get("debate_es") or "").strip(),
            "acuerdo_es": str(point.get("acuerdo_es") or "").strip(),
            "debate_en": str(point.get("debate_en") or "").strip(),
            "acuerdo_en": str(point.get("acuerdo_en") or "").strip(),
        })
    if state == "Cerrada":
        missing = []
        if not str(assembly.get("fecha") or "").strip(): missing.append("fecha")
        if not str(assembly.get("lugar_celebracion") or assembly.get("ubicacion") or "").strip(): missing.append("lugar")
        if not str(assembly.get("hora_inicio") or "").strip(): missing.append("hora de inicio")
        if not str(assembly.get("presidente") or "").strip(): missing.append("presidente")
        if not str(DATA.get("convocante") or "").strip(): missing.append("convocante")
        if not str(DATA.get("secretario") or assembly.get("administrador") or "").strip(): missing.append("secretario/administrador")
        if not str(DATA.get("hora_cierre") or "").strip(): missing.append("hora de cierre")
        attendance_count = conn.execute("SELECT COUNT(*) FROM asamblea_asistencia WHERE id_asamblea=?", (assembly_id,)).fetchone()[0]
        if not attendance_count: missing.append("asistencia")
        incomplete = [
            point for point in normalized_points
            if not all(str(point.get(field) or "").strip() for field in ("debate_es", "acuerdo_es", "debate_en", "acuerdo_en"))
        ]
        if len(normalized_points) != len(valid_point_ids) or incomplete:
            missing.append("desarrollo y acuerdo bilingue de todos los puntos")
        if missing:
            raise ValueError("No se puede cerrar el acta. Falta: " + ", ".join(missing) + ".")
    warnings = DATA.get("advertencias") or []
    if not isinstance(warnings, list):
        warnings = []
    timestamp = now()
    with conn:
        ensure_minutes_schema(conn)
        conn.execute(
            """INSERT INTO asamblea_actas
               (id_asamblea,estado,transcripcion,fuente_transcripcion,convocante,secretario,hora_cierre,
                introduccion_es,introduccion_en,cierre_es,cierre_en,puntos_json,advertencias_json,generado_ia,
                fecha_creacion,fecha_actualizacion,usuario_actualizacion,pc_actualizacion)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(id_asamblea) DO UPDATE SET
                 estado=excluded.estado,transcripcion=excluded.transcripcion,
                 fuente_transcripcion=excluded.fuente_transcripcion,convocante=excluded.convocante,
                 secretario=excluded.secretario,hora_cierre=excluded.hora_cierre,
                 introduccion_es=excluded.introduccion_es,introduccion_en=excluded.introduccion_en,
                 cierre_es=excluded.cierre_es,cierre_en=excluded.cierre_en,
                 puntos_json=excluded.puntos_json,advertencias_json=excluded.advertencias_json,
                 generado_ia=excluded.generado_ia,fecha_actualizacion=excluded.fecha_actualizacion,
                 usuario_actualizacion=excluded.usuario_actualizacion,pc_actualizacion=excluded.pc_actualizacion""",
            (
                assembly_id, state, str(DATA.get("transcripcion") or ""),
                str(DATA.get("fuente_transcripcion") or ""), str(DATA.get("convocante") or ""),
                str(DATA.get("secretario") or ""), str(DATA.get("hora_cierre") or ""),
                str(DATA.get("introduccion_es") or ""), str(DATA.get("introduccion_en") or ""),
                str(DATA.get("cierre_es") or ""), str(DATA.get("cierre_en") or ""),
                json.dumps(normalized_points, ensure_ascii=False),
                json.dumps([str(item)[:1000] for item in warnings], ensure_ascii=False),
                1 if DATA.get("generado_ia") else 0, timestamp, timestamp, USER, PC,
            ),
        )
        update_log(conn, assembly_id, "Acta", f"Borrador del acta guardado en estado {state}.")
        audit(conn, "Guardar borrador acta web", "asamblea", assembly_id, state)
        minutes = minutes_row(conn, assembly_id, False)
    conn.close()
    return {"ok": True, "minutes": minutes}


ACTIONS = {
    "list": list_assemblies, "detail": assembly_detail, "create": create_assembly,
    "update": update_assembly, "save_points": save_points, "add_update": add_update,
    "attendance_set": lambda: set_attendance(False), "attendance_batch": lambda: set_attendance(True),
    "attendance_remove": remove_attendance, "moroso_set": set_moroso,
    "vote_set": lambda: set_vote(False), "vote_bulk": lambda: set_vote(True),
    "document_add": add_document, "document_info": document_info, "document_delete": delete_document,
    "minutes_get": get_minutes, "minutes_save": save_minutes,
}


try:
    if ROLE == "Presidente":
        raise PermissionError("El perfil Presidente no tiene acceso general al modulo de asambleas.")
    if ACTION not in ACTIONS:
        raise ValueError("Operacion de asamblea no valida.")
    print(json.dumps(ACTIONS[ACTION](), ensure_ascii=False))
except Exception as error:
    print(json.dumps({"error": str(error), "error_type": type(error).__name__}, ensure_ascii=False))
    sys.exit(2)
