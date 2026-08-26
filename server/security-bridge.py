from __future__ import annotations

import json
import re
import sqlite3
import sys
import unicodedata
from datetime import datetime, timedelta
from difflib import SequenceMatcher


DATABASE = sys.argv[1]
REQUEST = json.loads(sys.argv[2])
SESSION = REQUEST.get("session") or {}
ACTION = str(REQUEST.get("action") or "")
DATA = REQUEST.get("data") or {}
PC = str(REQUEST.get("pc") or "web")

CATEGORIES = [
    "Accesos e identificaciones",
    "Alarmas y sistemas de seguridad",
    "Convivencia y normas internas",
    "Instalaciones, puertas y barreras",
    "Agua y saneamiento",
    "Daños, vandalismo o robo",
    "Tráfico y vehículos",
    "Emergencias, incendios y asistencia sanitaria",
    "Animales y medioambiente",
    "Otros",
]
SEVERITIES = ["Critica", "Alta", "Media", "Informativa"]
FINAL_STATUSES = {"Confirmada", "Informativa", "Resuelta", "Descartada", "Vinculada"}


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def normalize(value: object) -> str:
    text = str(value or "").upper()
    text = "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^A-Z0-9]+", " ", text)).strip()


def dictionaries(rows) -> list[dict]:
    return [dict(row) for row in rows]


def connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    ensure_schema(conn)
    return conn


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS usuario_permisos (
            id_usuario INTEGER PRIMARY KEY,
            gestionar_seguridad INTEGER NOT NULL DEFAULT 0,
            usuario_asignacion TEXT,
            fecha_asignacion TEXT,
            FOREIGN KEY (id_usuario) REFERENCES usuarios(id_usuario)
        );

        CREATE TABLE IF NOT EXISTS seguridad_categorias (
            id_categoria INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre TEXT NOT NULL UNIQUE,
            activa INTEGER NOT NULL DEFAULT 1,
            orden INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS seguridad_documentos (
            id_documento INTEGER PRIMARY KEY AUTOINCREMENT,
            hash_archivo TEXT NOT NULL UNIQUE,
            nombre_original TEXT NOT NULL,
            ruta_archivo TEXT NOT NULL,
            tipo_mime TEXT,
            extension TEXT,
            tamano_bytes INTEGER NOT NULL DEFAULT 0,
            fecha_carga TEXT NOT NULL,
            usuario_carga TEXT NOT NULL,
            pc_carga TEXT NOT NULL,
            estado_procesamiento TEXT NOT NULL DEFAULT 'Recibido',
            error_procesamiento TEXT,
            advertencias TEXT,
            texto_extraido TEXT,
            tipo_documento TEXT,
            inicio_turno TEXT,
            fin_turno TEXT,
            operativos TEXT,
            incidencias_detectadas INTEGER NOT NULL DEFAULT 0,
            incidencias_nuevas INTEGER NOT NULL DEFAULT 0,
            incidencias_duplicadas INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS seguridad_incidencias (
            id_incidencia INTEGER PRIMARY KEY AUTOINCREMENT,
            id_comunidad INTEGER NOT NULL,
            numero_reporte TEXT,
            fecha_hora_suceso TEXT,
            fecha_hora_reporte TEXT,
            zona TEXT,
            ubicacion TEXT,
            categoria_origen TEXT,
            tipo_origen TEXT,
            situacion_origen TEXT,
            categoria_normalizada TEXT NOT NULL DEFAULT 'Otros',
            gravedad TEXT NOT NULL DEFAULT 'Media',
            titulo TEXT NOT NULL,
            descripcion TEXT,
            actuacion_seguridad TEXT,
            resultado TEXT,
            estado_revision TEXT NOT NULL DEFAULT 'Pendiente de revision',
            revisor TEXT,
            fecha_inicio_revision TEXT,
            fecha_revision TEXT,
            notas_revision TEXT,
            id_duplicado_de INTEGER,
            tipo_entidad_vinculada TEXT,
            id_entidad_vinculada INTEGER,
            tipo_vinculo TEXT,
            sensible INTEGER NOT NULL DEFAULT 0,
            confianza REAL NOT NULL DEFAULT 0,
            fecha_creacion TEXT NOT NULL,
            fecha_actualizacion TEXT NOT NULL,
            FOREIGN KEY (id_comunidad) REFERENCES comunidades(id_comunidad),
            FOREIGN KEY (id_duplicado_de) REFERENCES seguridad_incidencias(id_incidencia)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_seguridad_reporte
        ON seguridad_incidencias(numero_reporte)
        WHERE COALESCE(numero_reporte, '') <> '';
        CREATE INDEX IF NOT EXISTS idx_seguridad_revision ON seguridad_incidencias(estado_revision);
        CREATE INDEX IF NOT EXISTS idx_seguridad_fecha ON seguridad_incidencias(fecha_hora_suceso);
        CREATE INDEX IF NOT EXISTS idx_seguridad_categoria ON seguridad_incidencias(categoria_normalizada);

        CREATE TABLE IF NOT EXISTS seguridad_incidencia_fuentes (
            id_fuente INTEGER PRIMARY KEY AUTOINCREMENT,
            id_incidencia INTEGER NOT NULL,
            id_documento INTEGER NOT NULL,
            fragmento TEXT,
            es_principal INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (id_incidencia) REFERENCES seguridad_incidencias(id_incidencia) ON DELETE CASCADE,
            FOREIGN KEY (id_documento) REFERENCES seguridad_documentos(id_documento) ON DELETE CASCADE,
            UNIQUE (id_incidencia, id_documento)
        );
        """
    )
    for order, name in enumerate(CATEGORIES, 1):
        conn.execute(
            "INSERT OR IGNORE INTO seguridad_categorias (nombre, activa, orden) VALUES (?, 1, ?)",
            (name, order),
        )
    conn.execute("UPDATE OR IGNORE seguridad_categorias SET nombre='Daños, vandalismo o robo' WHERE nombre='Danos, vandalismo o robo'")
    conn.execute("UPDATE OR IGNORE seguridad_categorias SET nombre='Tráfico y vehículos' WHERE nombre='Trafico y vehiculos'")
    conn.execute("DELETE FROM seguridad_categorias WHERE nombre IN ('Danos, vandalismo o robo','Trafico y vehiculos')")
    for name in ("Luis Gallardo", "Elena Cuenca"):
        row = conn.execute("SELECT id_usuario FROM usuarios WHERE lower(nombre)=lower(?)", (name,)).fetchone()
        if row:
            conn.execute(
                """INSERT INTO usuario_permisos
                   (id_usuario, gestionar_seguridad, usuario_asignacion, fecha_asignacion)
                   VALUES (?, 1, 'Migracion modulo Seguridad', ?)
                   ON CONFLICT(id_usuario) DO NOTHING""",
                (int(row["id_usuario"]), now_iso()),
            )
    conn.commit()


def macro_community_id(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT id_comunidad FROM comunidades WHERE lower(nombre)=lower('Macrocomunidad San Roque Club') LIMIT 1"
    ).fetchone()
    if not row:
        raise ValueError("No existe la comunidad gestora Macrocomunidad San Roque Club.")
    return int(row["id_comunidad"])


def can_manage(conn: sqlite3.Connection) -> bool:
    if str(SESSION.get("rol") or "") == "Superusuario":
        return True
    user_id = int(SESSION.get("id_usuario") or 0)
    row = conn.execute(
        "SELECT gestionar_seguridad FROM usuario_permisos WHERE id_usuario=?", (user_id,)
    ).fetchone()
    return bool(row and row["gestionar_seguridad"])


def require_manager(conn: sqlite3.Connection) -> None:
    if not can_manage(conn):
        raise PermissionError("No tienes permiso para gestionar el modulo de Seguridad.")


def require_uploader(conn: sqlite3.Connection) -> None:
    if str(SESSION.get("rol") or "") == "Seguridad" or can_manage(conn):
        return
    raise PermissionError("Tu perfil no puede subir partes de Seguridad.")


def audit(conn: sqlite3.Connection, action: str, entity: str, entity_id: int | None, detail: str) -> None:
    conn.execute(
        """INSERT INTO auditoria (fecha_hora, usuario, pc, accion, entidad, id_entidad, detalle)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (now_iso(), str(SESSION.get("nombre") or "web"), PC, action, entity, entity_id, detail),
    )


def incident_similarity(existing: sqlite3.Row, incoming: dict) -> float:
    existing_text = normalize(
        " ".join(
            str(existing[key] or "")
            for key in ("fecha_hora_suceso", "zona", "ubicacion", "titulo", "descripcion")
        )
    )
    incoming_text = normalize(
        " ".join(
            str(incoming.get(key) or "")
            for key in ("fecha_hora_suceso", "zona", "ubicacion", "titulo", "descripcion")
        )
    )
    if not existing_text or not incoming_text:
        return 0.0
    left, right = set(existing_text.split()), set(incoming_text.split())
    jaccard = len(left & right) / max(1, len(left | right))
    sequence = SequenceMatcher(None, existing_text, incoming_text).ratio()
    return max(jaccard, sequence)


def find_duplicate(conn: sqlite3.Connection, incident: dict) -> tuple[int, float] | None:
    report = str(incident.get("numero_reporte") or "").strip()
    if report:
        row = conn.execute(
            "SELECT id_incidencia FROM seguridad_incidencias WHERE numero_reporte=?", (report,)
        ).fetchone()
        if row:
            return int(row["id_incidencia"]), 1.0
    event_date = str(incident.get("fecha_hora_suceso") or "")[:10]
    candidates = conn.execute(
        """SELECT * FROM seguridad_incidencias
           WHERE (?='' OR substr(COALESCE(fecha_hora_suceso,''),1,10)=?)
           ORDER BY id_incidencia DESC LIMIT 80""",
        (event_date, event_date),
    ).fetchall()
    scored = [(int(row["id_incidencia"]), incident_similarity(row, incident)) for row in candidates]
    if not scored:
        return None
    best = max(scored, key=lambda item: item[1])
    return best if best[1] >= 0.86 else None


def migrate() -> dict:
    conn = connection()
    community_id = macro_community_id(conn)
    conn.close()
    return {"ok": True, "id_comunidad": community_id}


def access() -> dict:
    conn = connection()
    payload = {
        "ok": True,
        "can_upload": str(SESSION.get("rol") or "") == "Seguridad" or can_manage(conn),
        "can_manage": can_manage(conn),
        "upload_only": str(SESSION.get("rol") or "") == "Seguridad",
    }
    conn.close()
    return payload


def file_exists() -> dict:
    conn = connection()
    require_uploader(conn)
    row = conn.execute(
        "SELECT id_documento,nombre_original,fecha_carga FROM seguridad_documentos WHERE hash_archivo=?",
        (str(DATA.get("hash_archivo") or ""),),
    ).fetchone()
    conn.close()
    return {"exists": bool(row), "document": dict(row) if row else None}


def notify_reviewers(conn: sqlite3.Connection, community_id: int, new_incidents: list[dict]) -> None:
    notifiable = [row for row in new_incidents if str(row.get("gravedad")) in {"Critica", "Alta"}]
    if not notifiable:
        return
    severity_order = {"Critica": 4, "Alta": 3, "Media": 2, "Informativa": 1}
    maximum = max(notifiable, key=lambda row: severity_order.get(str(row.get("gravedad")), 0))
    critical = str(maximum.get("gravedad")) == "Critica"
    title = "Posible incidencia critica de Seguridad" if critical else "Nuevas incidencias de Seguridad"
    message = (
        f"{len(notifiable)} incidencia(s) de prioridad alta pendiente(s) de revision. "
        + (f"Revisar con prioridad: {maximum.get('titulo')}." if critical else "Accede al modulo Seguridad para validarlas.")
    )
    for user in ("Luis Gallardo", "Elena Cuenca"):
        conn.execute(
            """INSERT INTO notificaciones
               (id_comunidad,usuario_destino,tipo,titulo,mensaje,id_solicitud,id_tarea,id_proyecto,leida,fecha_creacion)
               VALUES (?,?,?,?,?,NULL,NULL,NULL,0,?)""",
            (community_id, user, "Seguridad", title, message, now_iso()),
        )


def register_upload() -> dict:
    conn = connection()
    require_uploader(conn)
    document = DATA.get("document") or {}
    incidents = list(DATA.get("incidents") or [])[:100]
    file_hash = str(document.get("hash_archivo") or "").strip()
    if not file_hash:
        raise ValueError("No se ha calculado la huella del documento.")
    existing = conn.execute(
        "SELECT id_documento,nombre_original,fecha_carga FROM seguridad_documentos WHERE hash_archivo=?",
        (file_hash,),
    ).fetchone()
    if existing:
        conn.close()
        return {"ok": True, "duplicate_document": True, "document": dict(existing), "new_incidents": 0}
    community_id = macro_community_id(conn)
    now = now_iso()
    new_rows: list[dict] = []
    duplicate_count = 0
    with conn:
        cursor = conn.execute(
            """INSERT INTO seguridad_documentos
               (hash_archivo,nombre_original,ruta_archivo,tipo_mime,extension,tamano_bytes,fecha_carga,
                usuario_carga,pc_carga,estado_procesamiento,error_procesamiento,advertencias,texto_extraido,
                tipo_documento,inicio_turno,fin_turno,operativos,incidencias_detectadas)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                file_hash,
                str(document.get("nombre_original") or "Documento"),
                str(document.get("ruta_archivo") or ""),
                str(document.get("tipo_mime") or ""),
                str(document.get("extension") or ""),
                int(document.get("tamano_bytes") or 0),
                now,
                str(SESSION.get("nombre") or "web"),
                PC,
                str(document.get("estado_procesamiento") or "Procesado"),
                str(document.get("error_procesamiento") or ""),
                json.dumps(document.get("advertencias") or [], ensure_ascii=False),
                str(document.get("texto_extraido") or "")[:250000],
                str(document.get("tipo_documento") or "Documento"),
                str(document.get("inicio_turno") or ""),
                str(document.get("fin_turno") or ""),
                json.dumps(document.get("operativos") or [], ensure_ascii=False),
                len(incidents),
            ),
        )
        document_id = int(cursor.lastrowid)
        for incident in incidents:
            duplicate = find_duplicate(conn, incident)
            if duplicate:
                incident_id, _score = duplicate
                duplicate_count += 1
                conn.execute(
                    """INSERT OR IGNORE INTO seguridad_incidencia_fuentes
                       (id_incidencia,id_documento,fragmento,es_principal) VALUES (?,?,?,0)""",
                    (incident_id, document_id, str(incident.get("fragmento") or "")[:10000]),
                )
                continue
            cursor = conn.execute(
                """INSERT INTO seguridad_incidencias
                   (id_comunidad,numero_reporte,fecha_hora_suceso,fecha_hora_reporte,zona,ubicacion,
                    categoria_origen,tipo_origen,situacion_origen,categoria_normalizada,gravedad,titulo,
                    descripcion,actuacion_seguridad,resultado,estado_revision,sensible,confianza,
                    fecha_creacion,fecha_actualizacion)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Pendiente de revision',?,?,?,?)""",
                (
                    community_id,
                    str(incident.get("numero_reporte") or ""),
                    str(incident.get("fecha_hora_suceso") or ""),
                    str(incident.get("fecha_hora_reporte") or ""),
                    str(incident.get("zona") or "Sin determinar"),
                    str(incident.get("ubicacion") or ""),
                    str(incident.get("categoria_origen") or ""),
                    str(incident.get("tipo_origen") or ""),
                    str(incident.get("situacion_origen") or ""),
                    str(incident.get("categoria_normalizada") or "Otros"),
                    str(incident.get("gravedad") or "Media"),
                    str(incident.get("titulo") or "Incidencia de Seguridad"),
                    str(incident.get("descripcion") or ""),
                    str(incident.get("actuacion_seguridad") or ""),
                    str(incident.get("resultado") or "Pendiente de revision"),
                    1 if incident.get("sensible") else 0,
                    float(incident.get("confianza") or 0),
                    now,
                    now,
                ),
            )
            incident_id = int(cursor.lastrowid)
            conn.execute(
                """INSERT INTO seguridad_incidencia_fuentes
                   (id_incidencia,id_documento,fragmento,es_principal) VALUES (?,?,?,1)""",
                (incident_id, document_id, str(incident.get("fragmento") or "")[:10000]),
            )
            new_rows.append({**incident, "id_incidencia": incident_id})
        conn.execute(
            """UPDATE seguridad_documentos
               SET incidencias_nuevas=?,incidencias_duplicadas=?,estado_procesamiento=?
               WHERE id_documento=?""",
            (
                len(new_rows),
                duplicate_count,
                "Error" if document.get("error_procesamiento") else ("Sin incidencias" if not incidents else "Procesado"),
                document_id,
            ),
        )
        notify_reviewers(conn, community_id, new_rows)
        audit(
            conn,
            "Cargar parte de Seguridad",
            "seguridad_documento",
            document_id,
            f"{document.get('nombre_original')}; nuevas={len(new_rows)}; duplicadas={duplicate_count}",
        )
    conn.close()
    return {
        "ok": True,
        "duplicate_document": False,
        "document_id": document_id,
        "detected_incidents": len(incidents),
        "new_incidents": len(new_rows),
        "duplicate_incidents": duplicate_count,
        "warnings": document.get("advertencias") or [],
    }


def overview() -> dict:
    conn = connection()
    require_manager(conn)
    counts = {
        str(row["estado_revision"]): int(row["total"])
        for row in conn.execute(
            "SELECT estado_revision,COUNT(*) AS total FROM seguridad_incidencias GROUP BY estado_revision"
        )
    }
    severities = dictionaries(
        conn.execute(
            """SELECT gravedad AS label,COUNT(*) AS total FROM seguridad_incidencias
               GROUP BY gravedad ORDER BY total DESC"""
        ).fetchall()
    )
    categories = dictionaries(
        conn.execute(
            """SELECT categoria_normalizada AS label,COUNT(*) AS total FROM seguridad_incidencias
               GROUP BY categoria_normalizada ORDER BY total DESC"""
        ).fetchall()
    )
    document_summary = dict(
        conn.execute(
            """SELECT COUNT(*) AS total,
                      SUM(CASE WHEN estado_procesamiento IN ('Procesado','Sin incidencias') THEN 1 ELSE 0 END) AS examined,
                      SUM(CASE WHEN estado_procesamiento='Error' THEN 1 ELSE 0 END) AS errors,
                      COALESCE(SUM(incidencias_detectadas),0) AS detected_incidents
               FROM seguridad_documentos"""
        ).fetchone()
    )
    zones = dictionaries(
        conn.execute(
            """SELECT COALESCE(NULLIF(zona,''),'Sin determinar') AS label,COUNT(*) AS total
               FROM seguridad_incidencias WHERE estado_revision<>'Descartada'
               GROUP BY COALESCE(NULLIF(zona,''),'Sin determinar') ORDER BY total DESC LIMIT 12"""
        ).fetchall()
    )
    months = dictionaries(
        conn.execute(
            """SELECT substr(COALESCE(fecha_hora_suceso,fecha_creacion),1,7) AS label,COUNT(*) AS total
               FROM seguridad_incidencias WHERE estado_revision<>'Descartada'
               GROUP BY substr(COALESCE(fecha_hora_suceso,fecha_creacion),1,7)
               ORDER BY label DESC LIMIT 12"""
        ).fetchall()
    )
    incidents = dictionaries(
        conn.execute(
            """SELECT i.*,
                      (SELECT COUNT(*) FROM seguridad_incidencia_fuentes f WHERE f.id_incidencia=i.id_incidencia) AS total_fuentes,
                      c.nombre AS comunidad_gestora
               FROM seguridad_incidencias i
               LEFT JOIN comunidades c ON c.id_comunidad=i.id_comunidad
               ORDER BY CASE i.estado_revision WHEN 'Pendiente de revision' THEN 1 WHEN 'En revision' THEN 2 ELSE 3 END,
                        CASE i.gravedad WHEN 'Critica' THEN 1 WHEN 'Alta' THEN 2 WHEN 'Media' THEN 3 ELSE 4 END,
                        COALESCE(i.fecha_hora_suceso,i.fecha_creacion) DESC
               LIMIT 400"""
        ).fetchall()
    )
    documents = dictionaries(
        conn.execute(
            """SELECT id_documento,nombre_original,extension,tamano_bytes,fecha_carga,usuario_carga,
                      estado_procesamiento,error_procesamiento,advertencias,tipo_documento,
                      inicio_turno,fin_turno,operativos,incidencias_detectadas,incidencias_nuevas,incidencias_duplicadas
               FROM seguridad_documentos ORDER BY id_documento DESC LIMIT 150"""
        ).fetchall()
    )
    category_options = [row["nombre"] for row in conn.execute(
        "SELECT nombre FROM seguridad_categorias WHERE activa=1 ORDER BY orden,nombre"
    )]
    community_id = macro_community_id(conn)
    pending = counts.get("Pendiente de revision", 0) + counts.get("En revision", 0)
    total = sum(counts.values())
    conn.close()
    return {
        "ok": True,
        "counts": counts,
        "total": total,
        "pending": pending,
        "reviewed": max(0, total - pending),
        "document_summary": document_summary,
        "severities": severities,
        "categories": categories,
        "zones": zones,
        "months": months,
        "incidents": incidents,
        "documents": documents,
        "category_options": category_options,
        "severity_options": SEVERITIES,
        "id_comunidad": community_id,
    }


def candidate_score(incident: sqlite3.Row, title: str, category: str, description: str) -> float:
    source = normalize(
        " ".join(
            [
                str(incident["titulo"] or ""),
                str(incident["categoria_normalizada"] or ""),
                str(incident["zona"] or ""),
                str(incident["ubicacion"] or ""),
                str(incident["descripcion"] or ""),
            ]
        )
    )
    target = normalize(" ".join([title, category, description]))
    if not source or not target:
        return 0.0
    source_tokens, target_tokens = set(source.split()), set(target.split())
    overlap = len(source_tokens & target_tokens) / max(1, len(source_tokens | target_tokens))
    return max(overlap, SequenceMatcher(None, source, target).ratio())


def incident_detail() -> dict:
    conn = connection()
    require_manager(conn)
    incident_id = int(DATA.get("id") or 0)
    incident = conn.execute(
        "SELECT * FROM seguridad_incidencias WHERE id_incidencia=?", (incident_id,)
    ).fetchone()
    if not incident:
        raise ValueError("La incidencia ya no existe.")
    sources = dictionaries(
        conn.execute(
            """SELECT d.id_documento,d.nombre_original,d.extension,d.fecha_carga,d.tipo_documento,
                      f.es_principal
               FROM seguridad_incidencia_fuentes f
               JOIN seguridad_documentos d ON d.id_documento=f.id_documento
               WHERE f.id_incidencia=? ORDER BY f.es_principal DESC,d.id_documento""",
            (incident_id,),
        ).fetchall()
    )
    candidates: list[dict] = []
    for row in conn.execute(
        """SELECT 'task' AS entity_type,id_tarea AS entity_id,titulo,categoria,descripcion
           FROM tareas WHERE id_comunidad=? AND COALESCE(activa,1)=1 AND COALESCE(archivada,0)=0
           UNION ALL
           SELECT 'project',id_proyecto,nombre,categoria,descripcion
           FROM proyectos WHERE id_comunidad=? AND COALESCE(activo,1)=1""",
        (incident["id_comunidad"], incident["id_comunidad"]),
    ):
        score = candidate_score(incident, str(row["titulo"] or ""), str(row["categoria"] or ""), str(row["descripcion"] or ""))
        if score >= 0.18:
            candidates.append(
                {
                    "entity_type": row["entity_type"],
                    "entity_id": row["entity_id"],
                    "title": row["titulo"],
                    "score": round(score, 3),
                }
            )
    candidates.sort(key=lambda row: row["score"], reverse=True)
    conn.close()
    return {"ok": True, "incident": dict(incident), "sources": sources, "candidates": candidates[:8]}


def ensure_claim(conn: sqlite3.Connection, incident: sqlite3.Row) -> None:
    reviewer = str(incident["revisor"] or "")
    current = str(SESSION.get("nombre") or "")
    if not reviewer or reviewer == current or str(SESSION.get("rol") or "") == "Superusuario":
        return
    started = str(incident["fecha_inicio_revision"] or "")
    try:
        active = datetime.strptime(started, "%Y-%m-%d %H:%M:%S") > datetime.now() - timedelta(minutes=30)
    except ValueError:
        active = False
    if active:
        raise PermissionError(f"La incidencia esta siendo revisada por {reviewer}.")


def claim() -> dict:
    conn = connection()
    require_manager(conn)
    incident_id = int(DATA.get("id") or 0)
    incident = conn.execute("SELECT * FROM seguridad_incidencias WHERE id_incidencia=?", (incident_id,)).fetchone()
    if not incident:
        raise ValueError("La incidencia ya no existe.")
    ensure_claim(conn, incident)
    user = str(SESSION.get("nombre") or "web")
    with conn:
        conn.execute(
            """UPDATE seguridad_incidencias SET estado_revision='En revision',revisor=?,
                      fecha_inicio_revision=?,fecha_actualizacion=? WHERE id_incidencia=?""",
            (user, now_iso(), now_iso(), incident_id),
        )
        audit(conn, "Iniciar revision de Seguridad", "seguridad_incidencia", incident_id, user)
    conn.close()
    return {"ok": True, "reviewer": user}


def save_incident() -> dict:
    conn = connection()
    require_manager(conn)
    incident_id = int(DATA.get("id") or 0)
    incident = conn.execute("SELECT * FROM seguridad_incidencias WHERE id_incidencia=?", (incident_id,)).fetchone()
    if not incident:
        raise ValueError("La incidencia ya no existe.")
    ensure_claim(conn, incident)
    category = str(DATA.get("categoria_normalizada") or "Otros").strip()
    severity = str(DATA.get("gravedad") or "Media").strip()
    if severity not in SEVERITIES:
        raise ValueError("La gravedad seleccionada no es valida.")
    user = str(SESSION.get("nombre") or "web")
    with conn:
        conn.execute(
            """UPDATE seguridad_incidencias
               SET fecha_hora_suceso=?,zona=?,ubicacion=?,categoria_normalizada=?,gravedad=?,titulo=?,
                   descripcion=?,actuacion_seguridad=?,resultado=?,notas_revision=?,estado_revision='En revision',
                   revisor=?,fecha_inicio_revision=COALESCE(fecha_inicio_revision,?),fecha_actualizacion=?
               WHERE id_incidencia=?""",
            (
                str(DATA.get("fecha_hora_suceso") or ""),
                str(DATA.get("zona") or "Sin determinar"),
                str(DATA.get("ubicacion") or ""),
                category,
                severity,
                str(DATA.get("titulo") or "Incidencia de Seguridad"),
                str(DATA.get("descripcion") or ""),
                str(DATA.get("actuacion_seguridad") or ""),
                str(DATA.get("resultado") or "Pendiente"),
                str(DATA.get("notas_revision") or ""),
                user,
                now_iso(),
                now_iso(),
                incident_id,
            ),
        )
        audit(conn, "Editar incidencia de Seguridad", "seguridad_incidencia", incident_id, category)
    conn.close()
    return {"ok": True}


def resolve_incident() -> dict:
    conn = connection()
    require_manager(conn)
    incident_id = int(DATA.get("id") or 0)
    status = str(DATA.get("status") or "").strip()
    if status not in {"Confirmada", "Informativa", "Resuelta", "Descartada"}:
        raise ValueError("El resultado de revision no es valido.")
    incident = conn.execute("SELECT * FROM seguridad_incidencias WHERE id_incidencia=?", (incident_id,)).fetchone()
    if not incident:
        raise ValueError("La incidencia ya no existe.")
    ensure_claim(conn, incident)
    with conn:
        conn.execute(
            """UPDATE seguridad_incidencias SET estado_revision=?,fecha_revision=?,fecha_actualizacion=?,
                      notas_revision=?,revisor=? WHERE id_incidencia=?""",
            (
                status,
                now_iso(),
                now_iso(),
                str(DATA.get("notes") or incident["notas_revision"] or ""),
                str(SESSION.get("nombre") or "web"),
                incident_id,
            ),
        )
        audit(conn, "Resolver incidencia de Seguridad", "seguridad_incidencia", incident_id, status)
    conn.close()
    return {"ok": True, "status": status}


def link_incident() -> dict:
    conn = connection()
    require_manager(conn)
    incident_id = int(DATA.get("id") or 0)
    entity_type = str(DATA.get("entity_type") or "")
    entity_id = int(DATA.get("entity_id") or 0)
    relation = str(DATA.get("relation") or "Vinculada")
    if entity_type not in {"task", "project"} or not entity_id:
        raise ValueError("La tarea o proyecto vinculado no es valido.")
    table = "tareas" if entity_type == "task" else "proyectos"
    column = "id_tarea" if entity_type == "task" else "id_proyecto"
    if not conn.execute(f"SELECT 1 FROM {table} WHERE {column}=?", (entity_id,)).fetchone():
        raise ValueError("El elemento vinculado ya no existe.")
    with conn:
        conn.execute(
            """UPDATE seguridad_incidencias
               SET estado_revision='Vinculada',tipo_entidad_vinculada=?,id_entidad_vinculada=?,
                   tipo_vinculo=?,revisor=?,fecha_revision=?,fecha_actualizacion=? WHERE id_incidencia=?""",
            (entity_type, entity_id, relation, str(SESSION.get("nombre") or "web"), now_iso(), now_iso(), incident_id),
        )
        audit(conn, "Vincular incidencia de Seguridad", "seguridad_incidencia", incident_id, f"{entity_type}:{entity_id}; {relation}")
    conn.close()
    return {"ok": True, "entity_type": entity_type, "entity_id": entity_id}


def document_info() -> dict:
    conn = connection()
    require_manager(conn)
    document_id = int(DATA.get("id") or 0)
    row = conn.execute(
        "SELECT id_documento,nombre_original,ruta_archivo FROM seguridad_documentos WHERE id_documento=?",
        (document_id,),
    ).fetchone()
    if not row:
        raise ValueError("El documento ya no existe.")
    with conn:
        audit(conn, "Abrir parte de Seguridad", "seguridad_documento", document_id, str(row["nombre_original"]))
    payload = dict(row)
    conn.close()
    return payload


def main() -> dict:
    actions = {
        "migrate": migrate,
        "access": access,
        "file_exists": file_exists,
        "register_upload": register_upload,
        "overview": overview,
        "detail": incident_detail,
        "claim": claim,
        "save": save_incident,
        "resolve": resolve_incident,
        "link": link_incident,
        "document_info": document_info,
    }
    if ACTION not in actions:
        raise ValueError("Accion de Seguridad no permitida.")
    return actions[ACTION]()


try:
    print(json.dumps(main(), ensure_ascii=False))
except PermissionError as exc:
    print(json.dumps({"error_type": "PermissionError", "error": str(exc)}, ensure_ascii=False))
    raise SystemExit(2)
except (ValueError, sqlite3.Error) as exc:
    print(json.dumps({"error_type": "ValueError", "error": str(exc)}, ensure_ascii=False))
    raise SystemExit(3)
