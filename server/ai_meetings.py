"""Private meeting drafts. Item confirmation shares the business transaction."""
import json
import uuid
from datetime import datetime
from access_control import require_permission, permission
from ai_drafts import entity, version


def migrate(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS ia_reuniones (
        id TEXT PRIMARY KEY, id_usuario INTEGER NOT NULL, comunidades TEXT NOT NULL,
        entrada TEXT NOT NULL, fecha_origen TEXT NOT NULL, estado TEXT NOT NULL,
        progreso INTEGER NOT NULL DEFAULT 0, mensaje TEXT NOT NULL DEFAULT '',
        fecha TEXT NOT NULL, catalogo TEXT NOT NULL)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS ia_reunion_asuntos (
        id TEXT PRIMARY KEY, reunion_id TEXT NOT NULL REFERENCES ia_reuniones(id),
        posicion INTEGER NOT NULL, propuesta TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        confirmado INTEGER NOT NULL DEFAULT 0, resultado TEXT)''')
    conn.execute('CREATE INDEX IF NOT EXISTS ia_reuniones_usuario ON ia_reuniones(id_usuario,fecha)')


def owned(conn, session, batch_id):
    row = conn.execute('SELECT * FROM ia_reuniones WHERE id=? AND id_usuario=?', (batch_id,session['id_usuario'])).fetchone()
    if not row:
        raise PermissionError('Reunion no encontrada o sin permiso.')
    for cid in json.loads(row['comunidades']):
        require_permission(session,cid,'puede_actualizar')
    return dict(row)


def catalog(conn, session):
    result = []
    for kind, table, pk in [('task','tareas','id_tarea'),('project','proyectos','id_proyecto')]:
        for row in conn.execute(f'SELECT * FROM {table}'):
            row = dict(row)
            if not permission(session,row['id_comunidad'],'puede_actualizar'):
                continue
            result.append({'type':kind,'id':row[pk], 'id_comunidad':row['id_comunidad'],
                'titulo':row.get('titulo') or row.get('nombre'), 'descripcion':row.get('descripcion') or '',
                'estado':row.get('estado') or row.get('estado_general'), 'prioridad':row.get('prioridad'),
                'responsable':row.get('responsable') or row.get('responsable_principal'),
                'categoria':row.get('categoria'), 'version':version(conn,kind,row)})
    return result


def get(conn, session, batch_id):
    batch = owned(conn,session,batch_id)
    proposals = []
    for row in conn.execute('SELECT * FROM ia_reunion_asuntos WHERE reunion_id=? ORDER BY posicion',(batch_id,)):
        p = json.loads(row['propuesta'])
        target = p.get('entity') or {}
        if target.get('id'):
            entity(conn,session,target['type'],int(target['id']))
        p.update(meeting_item_id=row['id'],revision=row['revision'],confirmed=bool(row['confirmado']))
        if row['confirmado']:
            p['selected'] = False
        p.pop('baseline_version',None)
        proposals.append(p)
    return {'ok':True,'meeting_id':batch_id,'status':batch['estado'],'progress':batch['progreso'],
        'message':batch['mensaje'],'source_date':batch['fecha_origen'],'proposals':proposals,
        'source_text':batch['entrada'],'batch_mode':'meeting_v2','batch_contract':'guided_batch_v1',
        'total':len(proposals),'actionable':sum(bool(p.get('selected')) for p in proposals),
        'catalog':[ {k:v for k,v in item.items() if k != 'version'} for item in json.loads(batch['catalogo']) ],
        'communities':[c for c in session['comunidades'] if int(c['id_comunidad']) in json.loads(batch['comunidades'])]}


def item_owned(conn, session, item_id):
    row = conn.execute('SELECT * FROM ia_reunion_asuntos WHERE id=?',(item_id,)).fetchone()
    if not row:
        raise PermissionError('Asunto no encontrado.')
    batch = owned(conn,session,row['reunion_id'])
    return dict(row),batch


def save_item(conn, session, data):
    row,batch = item_owned(conn,session,data['meeting_item_id'])
    if row['confirmado'] or row['revision'] != int(data['revision']):
        raise ValueError('El asunto ya fue confirmado o editado en otra ventana. Recupera el borrador.')
    old = json.loads(row['propuesta'])
    action = data['action']
    if action not in {'seguimiento_tarea','seguimiento_proyecto','crear_tarea','crear_proyecto','revisar_manual','descartar','fuera_de_alcance'}:
        raise ValueError('Accion no valida.')
    kind = 'task' if action.endswith('tarea') else 'project'
    entity_id = int(data.get('entity_id') or 0)
    payload = dict(data['payload'])
    if action.startswith('seguimiento_'):
        current = entity(conn,session,kind,entity_id)
        if int(current['id_comunidad']) not in json.loads(batch['comunidades']):
            raise PermissionError('El destino no pertenece al alcance de la reunion.')
        previous_target = old.get('entity') or {}
        if previous_target.get('type') != kind or previous_target.get('id') != entity_id:
            old['baseline_version'] = version(conn,kind,current)
            # Changing destination requires explicit state review, not inheriting another item's state.
            payload['estado_nuevo'] = current.get('estado') or current.get('estado_general')
            payload['responsable_nuevo'] = current.get('responsable') or current.get('responsable_principal') or 'Administracion'
        payload['id_comunidad'] = current['id_comunidad']
        old['entity'] = {'type':kind,'id':entity_id,'title':current.get('titulo') or current.get('nombre')}
    elif action.startswith('crear_'):
        cid = int(payload.get('id_comunidad') or 0)
        if cid and cid not in json.loads(batch['comunidades']):
            raise PermissionError('Selecciona una comunidad del borrador.')
        if cid:
            require_permission(session,cid,'puede_crear')
        old['entity'] = {'type':kind,'id':None,'title':payload.get('titulo','')}
        old['baseline_version'] = ''
    payload['responsable_proximo_paso'] = str(payload.get('responsable_proximo_paso') or '').strip() or 'Administracion'
    old.update(action=action,payload=payload,selected=bool(data.get('selected')))
    conn.execute('UPDATE ia_reunion_asuntos SET propuesta=?,revision=revision+1 WHERE id=?',
        (json.dumps(old,ensure_ascii=False),row['id']))
    return get(conn,session,row['reunion_id'])


def before_apply(conn, session, kind, entity_id, data):
    item_id = data.get('meeting_item_id')
    if not item_id:
        return None
    row,batch = item_owned(conn,session,item_id)
    p = json.loads(row['propuesta'])
    expected = ('seguimiento_' if entity_id else 'crear_') + ('tarea' if kind == 'task' else 'proyecto')
    if p['action'] != expected or (entity_id and p['entity']['id'] != entity_id):
        raise PermissionError('La confirmacion no corresponde al asunto revisado.')
    if row['confirmado']:
        return json.loads(row['resultado'])
    if row['revision'] != int(data.get('meeting_revision') or 0):
        raise ValueError('El borrador ha cambiado. Recuperalo antes de confirmar.')
    expected_payload = p['payload']
    actual = {k:v for k,v in data.items() if k not in {'meeting_item_id','meeting_revision'}}
    if actual != expected_payload:
        raise ValueError('Guarda las ediciones del borrador antes de confirmar.')
    if entity_id and p.get('baseline_version') != version(conn,kind,entity(conn,session,kind,entity_id)):
        raise ValueError('El expediente ha cambiado desde el analisis. Revisa su estado actual antes de volver a analizar este asunto.')
    return None


def applied(conn, session, data, result, pc):
    if not data.get('meeting_item_id'):
        return
    row,_ = item_owned(conn,session,data['meeting_item_id'])
    conn.execute('UPDATE ia_reunion_asuntos SET confirmado=1,resultado=? WHERE id=?',(json.dumps(result),row['id']))
    conn.execute('INSERT INTO auditoria(fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES(?,?,?,?,?,?,?)',
        (datetime.now().isoformat(timespec='seconds'),session.get('nombre',''),pc,'Confirmar asunto de reunion IA','reunion',None,row['reunion_id']+':'+row['id']))


def command(conn, session, action, data):
    if action == 'catalog':
        return catalog(conn,session)
    if action == 'create':
        communities = [int(c['id_comunidad']) for c in session['comunidades'] if permission(session,c['id_comunidad'],'puede_actualizar')]
        if not communities:
            raise PermissionError('Sin comunidades con permiso de actualizacion.')
        batch_id = str(uuid.uuid4())
        conn.execute('INSERT INTO ia_reuniones(id,id_usuario,comunidades,entrada,fecha_origen,estado,fecha,catalogo) VALUES(?,?,?,?,?,?,?,?)',
            (batch_id,session['id_usuario'],json.dumps(communities),data['text'],data.get('source_date',''),'analizando',datetime.now().isoformat(),json.dumps(data['catalog'])))
        return get(conn,session,batch_id)
    if action == 'list':
        result=[]
        for row in conn.execute('SELECT id,fecha,estado FROM ia_reuniones WHERE id_usuario=? ORDER BY fecha DESC',(session['id_usuario'],)):
            try:
                owned(conn,session,row['id'])
                result.append(dict(row))
            except PermissionError:
                pass
        return {'meetings':result}
    if action == 'save':
        return save_item(conn,session,data)
    batch = owned(conn,session,data['meeting_id'])
    if action == 'get':
        return get(conn,session,batch['id'])
    if action == 'progress':
        conn.execute('UPDATE ia_reuniones SET progreso=?,mensaje=? WHERE id=?',(data['progress'],data['message'],batch['id']))
    elif action == 'error':
        conn.execute("UPDATE ia_reuniones SET estado='error',mensaje=? WHERE id=?",(data['message'],batch['id']))
    elif action == 'finish':
        if batch['estado'] != 'analizando':
            raise ValueError('La reunion no esta en analisis.')
        for i,p in enumerate(data['proposals']):
            conn.execute('INSERT INTO ia_reunion_asuntos(id,reunion_id,posicion,propuesta) VALUES(?,?,?,?)',(str(uuid.uuid4()),batch['id'],i,json.dumps(p,ensure_ascii=False)))
        conn.execute("UPDATE ia_reuniones SET estado='revision',progreso=100,mensaje=? WHERE id=?",(data.get('message','Propuestas listas para revisar.'),batch['id']))
    else:
        raise ValueError('Accion de reunion no valida.')
    return get(conn,session,batch['id'])
