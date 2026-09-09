"""Private review drafts; confirmation joins the existing follow-up transaction."""
import hashlib
import json
import uuid
from datetime import datetime
from access_control import require_permission


def migrate(conn):
    with conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS ia_borradores_seguimiento (
            id TEXT PRIMARY KEY, id_usuario INTEGER NOT NULL REFERENCES usuarios(id_usuario),
            id_comunidad INTEGER NOT NULL REFERENCES comunidades(id_comunidad),
            tipo TEXT NOT NULL CHECK(tipo IN ('task','project')), id_entidad INTEGER NOT NULL,
            estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','confirmado')),
            entrada TEXT NOT NULL, fecha_origen TEXT NOT NULL DEFAULT '', propuesta_json TEXT NOT NULL,
            version_entidad TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            resultado_json TEXT, fecha_creacion TEXT NOT NULL, fecha_actualizacion TEXT NOT NULL
        )""")
        conn.execute('CREATE INDEX IF NOT EXISTS ia_borradores_por_usuario ON ia_borradores_seguimiento(id_usuario,tipo,id_entidad,estado)')


def entity(conn, session, kind, entity_id):
    if kind not in {'task', 'project'}:
        raise ValueError('Tipo de expediente no valido.')
    table, key = ('tareas', 'id_tarea') if kind == 'task' else ('proyectos', 'id_proyecto')
    row = conn.execute(f'SELECT * FROM {table} WHERE {key}=?', (entity_id,)).fetchone()
    if not row:
        raise PermissionError('Expediente no encontrado o sin permiso.')
    require_permission(session, row['id_comunidad'], 'puede_actualizar')
    return dict(row)


def version(conn, kind, row):
    table, key, record_key = ('registros', 'id_tarea', 'id_registro') if kind == 'task' else ('registros_proyectos', 'id_proyecto', 'id_registro_proyecto')
    last = conn.execute(f'SELECT MAX({record_key}) FROM {table} WHERE {key}=?', (row[key],)).fetchone()[0]
    return hashlib.sha256(json.dumps([row, last], sort_keys=True, default=str).encode()).hexdigest()


def owned(conn, session, draft_id):
    row = conn.execute('SELECT * FROM ia_borradores_seguimiento WHERE id=? AND id_usuario=?',
                       (draft_id, session.get('id_usuario'))).fetchone()
    if not row:
        raise PermissionError('Borrador no encontrado o sin permiso.')
    require_permission(session, row['id_comunidad'], 'puede_actualizar')
    entity(conn, session, row['tipo'], row['id_entidad'])
    return dict(row)


def serialize(row):
    row = dict(row)
    row['proposal'] = json.loads(row.pop('propuesta_json'))
    row.pop('version_entidad', None)
    row.pop('resultado_json', None)
    return row


def create(conn, session, kind, entity_id, text, source_date, proposal, expected_version):
    row = entity(conn, session, kind, entity_id)
    current = version(conn, kind, row)
    if current != expected_version:
        raise ValueError('La ficha ha cambiado durante el analisis. Vuelve a abrirla y analizar el texto; no se ha guardado el seguimiento.')
    draft_id = str(uuid.uuid4())
    now = datetime.now().isoformat(timespec='seconds')
    conn.execute('''INSERT INTO ia_borradores_seguimiento
        (id,id_usuario,id_comunidad,tipo,id_entidad,entrada,fecha_origen,propuesta_json,version_entidad,fecha_creacion,fecha_actualizacion)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)''', (draft_id, session['id_usuario'],row['id_comunidad'],kind,entity_id,text,source_date,
        json.dumps(proposal,ensure_ascii=False),current,now,now))
    return serialize(owned(conn, session, draft_id))


def update(conn, session, draft_id, revision, payload):
    row = owned(conn, session, draft_id)
    if row['estado'] != 'pendiente' or row['revision'] != revision:
        raise ValueError('El borrador ya fue confirmado o editado desde otra ventana. Recuperalo antes de continuar.')
    proposal = json.loads(row['propuesta_json'])
    proposal['payload'] = payload
    if str(payload.get('comentario') or '').strip():
        proposal['requires_clarification'] = False
        proposal['action'] = 'seguimiento_tarea' if row['tipo'] == 'task' else 'seguimiento_proyecto'
    conn.execute('UPDATE ia_borradores_seguimiento SET propuesta_json=?,revision=revision+1,fecha_actualizacion=? WHERE id=?',
        (json.dumps(proposal,ensure_ascii=False),datetime.now().isoformat(timespec='seconds'),draft_id))
    return serialize(owned(conn, session, draft_id))


def latest(conn, session, kind, entity_id):
    entity(conn, session, kind, entity_id)
    row = conn.execute("SELECT * FROM ia_borradores_seguimiento WHERE id_usuario=? AND tipo=? AND id_entidad=? AND estado='pendiente' ORDER BY fecha_creacion DESC,rowid DESC LIMIT 1",
                       (session['id_usuario'],kind,entity_id)).fetchone()
    return serialize(owned(conn, session, row['id'])) if row else None


def before_confirm(conn, session, kind, entity_id, draft_id, revision):
    row = owned(conn, session, draft_id)
    if row['tipo'] != kind or row['id_entidad'] != entity_id:
        raise PermissionError('El borrador pertenece a otro expediente.')
    if row['estado'] == 'confirmado':
        return json.loads(row['resultado_json'])
    if row['revision'] != revision:
        raise ValueError('El borrador ha cambiado en otra ventana. Recuperalo antes de confirmar.')
    if row['version_entidad'] != version(conn, kind, entity(conn, session, kind, entity_id)):
        raise ValueError('La ficha ha cambiado desde el analisis. Revisa el estado actual y vuelve a analizar antes de confirmar.')
    return None


def applied(conn, session, draft_id, result, payload, pc):
    row = owned(conn, session, draft_id)
    proposal = json.loads(row['propuesta_json'])
    proposal['payload'] = payload
    conn.execute("UPDATE ia_borradores_seguimiento SET estado='confirmado',propuesta_json=?,resultado_json=?,fecha_actualizacion=? WHERE id=?",
                 (json.dumps(proposal,ensure_ascii=False),json.dumps(result),datetime.now().isoformat(timespec='seconds'),draft_id))
    conn.execute('INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)',
        (datetime.now().isoformat(timespec='seconds'),session.get('nombre',''),pc,'Confirmar seguimiento IA',row['tipo'],row['id_entidad'],draft_id))
