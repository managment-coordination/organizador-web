"""Explicit, versioned decision requests with a durable clarification thread."""
import json
from access_control import columns, require_permission, president_for, permission
from work_domain import clean, stamp, entity, history, validate_date, CLOSED


def migrate(conn):
    if conn.execute("SELECT 1 FROM web_migrations WHERE version='presidency_v2'").fetchone():
        return
    with conn:
        for name,sql_type in [('id_usuario_solicitante','INTEGER'),('fecha_objetivo','TEXT'),
                              ('version','INTEGER NOT NULL DEFAULT 0'),('gestion_estado',"TEXT NOT NULL DEFAULT 'Pendiente'")]:
            if name not in columns(conn,'solicitudes_presidente'):
                conn.execute(f'ALTER TABLE solicitudes_presidente ADD COLUMN {name} {sql_type}')
        if 'id_solicitud_presidente' not in columns(conn,'acciones_pendientes'):
            conn.execute('ALTER TABLE acciones_pendientes ADD COLUMN id_solicitud_presidente INTEGER')
        conn.execute('''CREATE TABLE IF NOT EXISTS solicitudes_conversacion (
            id INTEGER PRIMARY KEY, id_solicitud INTEGER NOT NULL REFERENCES solicitudes_presidente(id_solicitud),
            fecha TEXT NOT NULL, tipo TEXT NOT NULL, id_usuario INTEGER, usuario TEXT NOT NULL,
            comentario TEXT NOT NULL, adjuntos_json TEXT NOT NULL DEFAULT '[]')''')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_solicitud_hilo ON solicitudes_conversacion(id_solicitud,id)')
        conn.execute('''UPDATE solicitudes_presidente SET id_usuario_solicitante=
            (SELECT id_usuario FROM usuarios WHERE nombre=solicitante COLLATE NOCASE LIMIT 1)''')
        # Preserve the legacy snapshot, without inventing earlier conversations.
        for r in conn.execute('SELECT * FROM solicitudes_presidente').fetchall():
            conn.execute('''INSERT INTO solicitudes_conversacion(id_solicitud,fecha,tipo,usuario,comentario)
                VALUES (?,?,?,?,?)''',(r['id_solicitud'],r['fecha_creacion'] or stamp(),'Solicitud anterior',
                r['solicitante'] or '',r['detalle'] or r['ultimo_comentario'] or r['titulo'] or 'Solicitud anterior'))
            if r['comentario_respuesta']:
                conn.execute('''INSERT INTO solicitudes_conversacion(id_solicitud,fecha,tipo,usuario,comentario)
                    VALUES (?,?,?,?,?)''',(r['id_solicitud'],r['fecha_respuesta'] or stamp(),r['estado'],
                    r['usuario_respuesta'] or '',r['comentario_respuesta']))
            if r['estado'] in {'Aprobada','Rechazada','Solicita aclaracion'}:
                matches=conn.execute('''SELECT id_accion,estado FROM acciones_pendientes
                    WHERE tipo_accion='Gestionar respuesta de presidencia' AND usuario_destino=?
                    AND tipo_entidad=? AND COALESCE(id_tarea,0)=? AND COALESCE(id_proyecto,0)=?
                    AND fecha_creacion=? AND id_solicitud_presidente IS NULL''',
                    (r['solicitante'],r['tipo_origen'],r['id_tarea'] or 0,r['id_proyecto'] or 0,r['fecha_respuesta'])).fetchall()
                if len(matches)==1:
                    conn.execute('UPDATE acciones_pendientes SET id_solicitud_presidente=? WHERE id_accion=?',(r['id_solicitud'],matches[0]['id_accion']))
                    if matches[0]['estado']!='Pendiente' and r['estado']!='Solicita aclaracion':
                        conn.execute("UPDATE solicitudes_presidente SET gestion_estado='Gestionada' WHERE id_solicitud=?",(r['id_solicitud'],))
        conn.execute("INSERT INTO web_migrations VALUES ('presidency_v2',?)",(stamp(),))


def next_action(row):
    if row['estado']=='Pendiente': return row.get('presidente') or 'Presidente','Responder solicitud'
    if row['estado']=='Solicita aclaracion': return row.get('solicitante_actual') or row['solicitante'],'Contestar aclaracion'
    if row['estado'] in {'Aprobada','Rechazada'} and row['gestion_estado']!='Gestionada':
        return row.get('solicitante_actual') or row['solicitante'],'Gestionar decision: '+row['estado']
    return '', 'Gestionada' if row['gestion_estado']=='Gestionada' else row['estado']


def request_row(conn, request_id):
    r=conn.execute('''SELECT s.*,p.nombre AS presidente,u.nombre AS solicitante_actual FROM solicitudes_presidente s
        LEFT JOIN usuarios p ON p.id_usuario=s.id_usuario_presidente
        LEFT JOIN usuarios u ON u.id_usuario=s.id_usuario_solicitante WHERE s.id_solicitud=?''',(request_id,)).fetchone()
    if not r:raise PermissionError('Solicitud no encontrada o sin permiso.')
    return dict(r)


def view(conn, session, request_id):
    r=request_row(conn,request_id)
    require_permission(session,r['id_comunidad'])
    if session['rol']=='Seguridad':raise PermissionError('Tu perfil no puede consultar solicitudes.')
    if session['rol']=='Presidente' and r['id_usuario_presidente']!=session['id_usuario']:
        raise PermissionError('Esta solicitud no esta dirigida a ti.')
    r['siguiente_responsable'],r['siguiente_accion']=next_action(r)
    r['conversacion']=[dict(x) for x in conn.execute('SELECT * FROM solicitudes_conversacion WHERE id_solicitud=? ORDER BY id',(request_id,))]
    if not permission(session,r['id_comunidad'],'puede_ver_documentos'):
        for x in r['conversacion']:x['adjuntos_json']='[]'
    return r


def entity_requests(conn,session,kind,entity_id):
    field,origin=('id_tarea','tarea') if kind=='task' else ('id_proyecto','proyecto')
    ids=conn.execute(f'SELECT id_solicitud,id_usuario_presidente FROM solicitudes_presidente WHERE {field}=? AND tipo_origen=? ORDER BY id_solicitud DESC',(entity_id,origin)).fetchall()
    return [view(conn,session,r[0]) for r in ids if session['rol']!='Presidente' or r[1]==session['id_usuario']]


def notify(conn, uid, kind, title, text, item, request_id=None):
    user=conn.execute('''SELECT u.nombre FROM usuarios u WHERE u.id_usuario=? AND u.activo=1 AND
        (u.rol='Superusuario' OR EXISTS(SELECT 1 FROM usuario_comunidad uc WHERE uc.id_usuario=u.id_usuario AND uc.id_comunidad=?))''',(uid,item['id_comunidad'])).fetchone()
    if not user: return
    conn.execute('''INSERT INTO notificaciones(id_comunidad,id_usuario_destino,usuario_destino,tipo,titulo,mensaje,
        id_solicitud,id_tarea,id_proyecto,leida,fecha_creacion) VALUES (?,?,?,?,?,?,?,?,?,0,?)''',
        (item['id_comunidad'],uid,user[0],kind,title,text,request_id,item.get('id_tarea'),
         None if item.get('id_tarea') else item.get('id_proyecto'),stamp()))


def recipients(conn,community_id):
    return [dict(r) for r in conn.execute('''SELECT u.id_usuario,u.nombre FROM usuarios u
        WHERE (u.rol='Superusuario' OR EXISTS(SELECT 1 FROM usuario_comunidad uc WHERE uc.id_usuario=u.id_usuario AND uc.id_comunidad=?))
        AND u.activo=1 AND u.rol IN ('Superusuario','Administrador','Usuario') ORDER BY u.nombre''',(community_id,))]


def notify_assignment(conn,session,item,owner,description):
    users=recipients(conn,item['id_comunidad'])
    target=clean(owner)
    if not any(r['nombre']==target for r in users):target={'Luis':'Luis Gallardo','Elena':'Elena Cuenca'}.get(target,target)
    uid=next((r['id_usuario'] for r in users if r['nombre']==target and r['nombre']!=session['nombre']),None)
    if uid:notify(conn,uid,'Asignacion',item.get('titulo') or item.get('nombre'),description,item)


def notify_mentions(conn,session,item,data):
    allowed={r['id_usuario'] for r in recipients(conn,item['id_comunidad'])}
    ids={int(v) for v in data.get('menciones') or []}
    if not ids.issubset(allowed):raise PermissionError('Solo puedes mencionar usuarios de esta comunidad.')
    for uid in ids:
        if uid!=session.get('id_usuario'):
            notify(conn,uid,'Mencion directa',item.get('titulo') or item.get('nombre'),clean(data.get('comentario')),item)


def append(conn,session,r,kind,comment,attachments=()):
    conn.execute('''INSERT INTO solicitudes_conversacion(id_solicitud,fecha,tipo,id_usuario,usuario,comentario,adjuntos_json)
        VALUES (?,?,?,?,?,?,?)''',(r['id_solicitud'],stamp(),kind,session['id_usuario'],session['nombre'],comment,json.dumps(attachments)))
    task=r['tipo_origen']=='tarea'
    table,key=('tareas','id_tarea') if task else ('proyectos','id_proyecto')
    item=dict(conn.execute(f'SELECT * FROM {table} WHERE {key}=?',(r[key],)).fetchone())
    if item['id_comunidad']!=r['id_comunidad']:raise PermissionError('La solicitud y el expediente no pertenecen a la misma comunidad.')
    record_id=history(conn,session,'task' if task else 'project',item,f"Solicitud #{r['id_solicitud']} - {kind}: {comment}",'Solicitud de presidencia')
    conn.execute(f'UPDATE {table} SET fecha_ultima_actualizacion=?,usuario_ultima_actualizacion=?,pc_ultima_actualizacion=? WHERE {key}=?',
        (stamp(),session['nombre'],session.get('pc','web'),r[key]))
    conn.execute('INSERT INTO auditoria(fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)',
        (stamp(),session['nombre'],session.get('pc','web'),kind,'solicitud_presidente',r['id_solicitud'],comment))
    return item,record_id


def checked_attachments(conn,session,item,kind,ids):
    if not ids:return []
    require_permission(session,item['id_comunidad'],'puede_ver_documentos')
    field,origin=('id_tarea','tarea') if kind=='task' else ('id_proyecto','proyecto')
    result=[]
    for value in set(int(v) for v in ids):
        r=conn.execute(f'SELECT id_anexo,nombre_archivo FROM anexos_registros WHERE id_anexo=? AND {field}=? AND tipo_entidad=? AND id_comunidad=?',
            (value,item[field],origin,item['id_comunidad'])).fetchone()
        if not r:raise PermissionError('El documento no pertenece a este expediente.')
        result.append(dict(r))
    return result


def create(conn,session,kind,entity_id,data):
    item=entity(conn,session,kind,entity_id)
    if item['estado' if kind=='task' else 'estado_general'] in CLOSED:raise ValueError('Reabre el expediente antes de solicitar una decision.')
    question,context=clean(data.get('decision')),clean(data.get('contexto'))
    if not question or not context:raise ValueError('Indica que debe decidir el presidente y el contexto de la solicitud.')
    validate_date(data.get('fecha_objetivo'))
    president=president_for(conn,item['id_comunidad'])
    attachments=checked_attachments(conn,session,item,kind,data.get('adjuntos') or [])
    cur=conn.execute('''INSERT INTO solicitudes_presidente(id_comunidad,tipo_origen,id_tarea,id_proyecto,titulo,detalle,
        solicitante,ultimo_comentario,proximo_paso_solicitado,responsable_original,responsable_retorno,estado,
        fecha_creacion,usuario_creacion,pc_creacion,id_usuario_presidente,id_usuario_solicitante,fecha_objetivo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'Pendiente',?,?,?,?,?,?)''',
        (item['id_comunidad'],'tarea' if kind=='task' else 'proyecto',entity_id if kind=='task' else None,
         entity_id if kind=='project' else None,question,context,session['nombre'],context,question,
         item['responsable' if kind=='task' else 'responsable_principal'],session['nombre'],stamp(),session['nombre'],
         session.get('pc','web'),president['id_usuario'],session['id_usuario'],clean(data.get('fecha_objetivo'))))
    r=request_row(conn,cur.lastrowid)
    append(conn,session,r,'Solicitud',question+'\n'+context,attachments)
    notify(conn,president['id_usuario'],'Solicitud presidente',question,context,item,r['id_solicitud'])
    return view(conn,session,r['id_solicitud'])


def transition(conn,session,request_id,action,data):
    r=request_row(conn,request_id)
    require_permission(session,r['id_comunidad'])
    if data.get('version') is None or int(data['version'])!=r['version']:
        raise ValueError('La solicitud ha cambiado. Vuelve a abrirla antes de responder.')
    comment=clean(data.get('comentario'))
    if not comment:raise ValueError('El comentario es obligatorio.')
    if action=='respond':
        if session['rol']!='Presidente' or r['id_usuario_presidente']!=session['id_usuario']:
            raise PermissionError('Solo el presidente destinatario puede responder.')
        if r['estado']!='Pendiente':raise ValueError('La solicitud no esta pendiente del presidente.')
        decision=data.get('decision')
        if decision not in {'Aprobada','Rechazada','Solicita aclaracion'}:raise ValueError('Respuesta no valida.')
        conn.execute('''UPDATE solicitudes_presidente SET estado=?,fecha_respuesta=?,usuario_respuesta=?,
            comentario_respuesta=?,gestion_estado='Pendiente',version=version+1 WHERE id_solicitud=?''',
            (decision,stamp(),session['nombre'],comment,request_id))
        item,rid=append(conn,session,r,decision,comment)
        label='Contestar aclaracion' if decision=='Solicita aclaracion' else 'Gestionar decision: '+decision
        conn.execute('''INSERT INTO acciones_pendientes(id_comunidad,tipo_entidad,id_tarea,id_proyecto,id_registro_origen,
            tipo_accion,usuario_destino,solicitante,titulo,detalle,estado,fecha_creacion,pc_creacion,id_solicitud_presidente)
            VALUES (?,?,?,?,?,'Gestionar respuesta de presidencia',?,?,?,?,'Pendiente',?,?,?)''',
            (r['id_comunidad'],r['tipo_origen'],r['id_tarea'],r['id_proyecto'],rid,r.get('solicitante_actual') or r['solicitante'],
             session['nombre'],r['titulo'],label+': '+comment,stamp(),session.get('pc','web'),request_id))
        notify(conn,r['id_usuario_solicitante'],'Respuesta presidente',label,comment,item,request_id)
    else:
        require_permission(session,r['id_comunidad'],'puede_actualizar')
        if action!='cancel' and session['rol']!='Superusuario' and r['id_usuario_solicitante']!=session['id_usuario']:
            raise PermissionError('Esta accion corresponde al solicitante.')
        if action=='clarify':
            if r['estado']!='Solicita aclaracion':raise ValueError('No hay aclaracion pendiente.')
            president=president_for(conn,r['id_comunidad'])
            conn.execute("UPDATE solicitudes_presidente SET estado='Pendiente',ultimo_comentario=?,id_usuario_presidente=?,version=version+1 WHERE id_solicitud=?",(comment,president['id_usuario'],request_id))
            item,_=append(conn,session,r,'Aclaracion enviada',comment)
            notify(conn,president['id_usuario'],'Respuesta a aclaracion',r['titulo'],comment,item,request_id)
        elif action=='manage':
            if r['estado'] not in {'Aprobada','Rechazada'} or r['gestion_estado']=='Gestionada':raise ValueError('No hay una decision pendiente de gestionar.')
            conn.execute("UPDATE solicitudes_presidente SET gestion_estado='Gestionada',version=version+1 WHERE id_solicitud=?",(request_id,))
            append(conn,session,r,'Decision gestionada',comment)
        elif action=='cancel':
            if r['estado'] not in {'Pendiente','Solicita aclaracion'}:
                raise ValueError('Una decision emitida no se cancela: registra como se ha gestionado, conservando la respuesta del presidente.')
            conn.execute("UPDATE solicitudes_presidente SET estado='Cancelada',gestion_estado='Gestionada',version=version+1 WHERE id_solicitud=?",(request_id,))
            item,_=append(conn,session,r,'Solicitud cancelada',comment)
            for uid in {r['id_usuario_solicitante'],r['id_usuario_presidente']}:
                if uid!=session['id_usuario']:notify(conn,uid,'Respuesta solicitud',r['titulo'],comment,item,request_id)
        else:raise ValueError('Accion no valida.')
        conn.execute('''UPDATE acciones_pendientes SET estado=?,fecha_cierre=?,usuario_cierre=?,comentario_cierre=?,pc_cierre=?
            WHERE id_solicitud_presidente=? AND estado='Pendiente' ''',
            ('Cancelada' if action=='cancel' else 'Resuelta',stamp(),session['nombre'],comment,session.get('pc','web'),request_id))
    conn.execute('''UPDATE notificaciones SET leida=1,fecha_lectura=? WHERE id_solicitud=? AND id_usuario_destino=? AND leida=0''',
        (stamp(),request_id,session['id_usuario']))
    return view(conn,session,request_id)
