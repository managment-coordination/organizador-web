"""Document classification does not change files or their original follow-up links."""
import json
from datetime import datetime

CATEGORIES = ('Sin clasificar', 'Presupuesto', 'Factura', 'Contrato', 'Informe tecnico', 'Fotografia', 'Otro')


def migrate(conn):
    if conn.execute("SELECT 1 FROM web_migrations WHERE version='documents_v1'").fetchone():
        return
    with conn:
        columns = {r[1] for r in conn.execute('PRAGMA table_info(anexos_registros)')}
        if 'categoria_documental' not in columns:
            conn.execute("ALTER TABLE anexos_registros ADD COLUMN categoria_documental TEXT NOT NULL DEFAULT 'Sin clasificar'")
        conn.execute("INSERT INTO web_migrations VALUES ('documents_v1',?)", (datetime.now().isoformat(timespec='seconds'),))


def classify(conn, session, attachment_id, category, pc):
    from access_control import require_permission
    if category not in CATEGORIES:
        raise ValueError('Categoria documental no valida.')
    row = conn.execute('SELECT * FROM anexos_registros WHERE id_anexo=?', (attachment_id,)).fetchone()
    if not row:
        raise PermissionError('Documento no encontrado o sin permiso.')
    require_permission(session, row['id_comunidad'], 'puede_actualizar')
    with conn:
        conn.execute('UPDATE anexos_registros SET categoria_documental=? WHERE id_anexo=?', (category, attachment_id))
        conn.execute('INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)',
                     (datetime.now().isoformat(timespec='seconds'), session.get('nombre',''), pc,
                      'Clasificar documento', 'anexo', attachment_id,
                      json.dumps({'anterior':row['categoria_documental'],'nueva':category}, ensure_ascii=False)))
    return {'ok':True, 'categoria_documental':category}
