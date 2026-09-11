"""Shared rules for tasks/projects, commitments and explicit lifecycle changes."""
import json
import hashlib
from datetime import date, datetime
from access_control import columns, require_permission, president_for

def stamp():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')

APPROVALS = ('Propuesta', 'Pendiente de aprobacion', 'Aprobado', 'No aprobado')
CLOSED = {'Terminada','Finalizada','Finalizado','Cancelada','Cancelado','Archivada','Archivado'}
STATES = {
    'task': {'Pendiente','En curso','Pendiente de tercero','Bloqueada','Terminada','Archivada','Cancelada'},
    'project': {'Pendiente','En curso','Pendiente de tercero','Bloqueado','Finalizado','Archivado','Cancelado'},
}

def clean(value):
    return str(value or '').strip()


def confirmation(conn,session,kind,entity_id,data,record_id=None):
    """Optional keys preserve older clients; new confirmations are retry-safe."""
    entity(conn,session,kind,entity_id)
    key=clean(data.get('confirmation_key'))
    if not key:return None
    if len(key)>128:raise ValueError('Clave de confirmacion no valida.')
    table,field,link=('registros','id_tarea','id_registro_tarea') if kind=='task' else ('registros_proyectos','id_proyecto','id_registro_proyecto')
    record_key='id_registro' if kind=='task' else 'id_registro_proyecto'
    digest=hashlib.sha256(json.dumps({k:v for k,v in data.items() if k!='confirmation_key'},sort_keys=True,ensure_ascii=True,separators=(',',':')).encode()).hexdigest()
    if record_id is not None:
        conn.execute(f'UPDATE {table} SET confirmation_key=?,confirmation_hash=?,id_usuario_confirmacion=? WHERE {record_key}=?',
            (key,digest,session['id_usuario'],record_id))
        return None
    previous=conn.execute(f'SELECT * FROM {table} WHERE id_usuario_confirmacion=? AND confirmation_key=?',(session['id_usuario'],key)).fetchone()
    if not previous:return None
    if previous[field]!=entity_id or previous['confirmation_hash']!=digest:
        raise ValueError('Esta confirmacion ya se uso con otros datos. Abre un nuevo seguimiento.')
    request=conn.execute(f'SELECT id_solicitud FROM solicitudes_presidente WHERE {link}=? AND {field}=? ORDER BY id_solicitud LIMIT 1',
        (previous[record_key],entity_id)).fetchone()
    return {'ok':True,'record_id':previous[record_key],'request_id':request['id_solicitud'] if request else None}

def migrate(conn):
    if conn.execute("SELECT 1 FROM web_migrations WHERE version='work_module02_v1'").fetchone():
        return
    schema=conn.execute("SELECT sql FROM sqlite_master WHERE name='registros' AND type='table'").fetchone()[0]
    if 'id_proyecto INTEGER NOT NULL' in schema:
        conn.commit()
        foreign_keys=conn.execute('PRAGMA foreign_keys').fetchone()[0]
        existing=set(tuple(r) for r in conn.execute('PRAGMA foreign_key_check'))
        objects=[r[0] for r in conn.execute("SELECT sql FROM sqlite_master WHERE tbl_name='registros' AND type IN ('index','trigger') AND sql IS NOT NULL")]
        sequence=conn.execute("SELECT seq FROM sqlite_sequence WHERE name='registros'").fetchone()
        conn.execute('PRAGMA foreign_keys=OFF')
        try:
            with conn:
                conn.execute(schema.replace('CREATE TABLE registros','CREATE TABLE registros_independent',1).replace('id_proyecto INTEGER NOT NULL','id_proyecto INTEGER'))
                conn.execute('INSERT INTO registros_independent SELECT * FROM registros')
                conn.execute('DROP TABLE registros')
                conn.execute('ALTER TABLE registros_independent RENAME TO registros')
                for sql in objects:conn.execute(sql)
                if sequence:conn.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='registros'",(sequence[0],))
                if set(tuple(r) for r in conn.execute('PRAGMA foreign_key_check'))-existing:raise ValueError('La migracion alteraria relaciones del historial.')
        finally:conn.execute(f'PRAGMA foreign_keys={foreign_keys}')
    with conn:
        for field in ('fase_aprobacion','proximo_paso_actual'):
            if field not in columns(conn,'proyectos'):
                conn.execute(f'ALTER TABLE proyectos ADD COLUMN {field} TEXT')
        if 'fecha_objetivo' not in columns(conn,'acciones_pendientes'):
            conn.execute('ALTER TABLE acciones_pendientes ADD COLUMN fecha_objetivo TEXT')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_accion_expediente ON acciones_pendientes(tipo_entidad,id_tarea,id_proyecto,estado)')
        conn.execute("INSERT INTO web_migrations VALUES ('work_module02_v1',?)",(stamp(),))

def entity(conn, session, kind, entity_id):
    if kind not in STATES:
        raise ValueError('Tipo de expediente no valido.')
    table, key = ('tareas','id_tarea') if kind=='task' else ('proyectos','id_proyecto')
    row=conn.execute(f'SELECT * FROM {table} WHERE {key}=?',(entity_id,)).fetchone()
    if not row:
        raise PermissionError('Expediente no encontrado o sin permiso.')
    require_permission(session,row['id_comunidad'],'puede_actualizar')
    return dict(row)

def commitments(conn, kind, entity_id):
    field='id_tarea' if kind=='task' else 'id_proyecto'
    origin='tarea' if kind=='task' else 'proyecto'
    result=[dict(r) for r in conn.execute(f'''SELECT id_accion AS id, 'action' AS kind, detalle AS descripcion,
        usuario_destino AS responsable, estado, fecha_objetivo, fecha_creacion, comentario_cierre
        FROM acciones_pendientes WHERE {field}=? AND tipo_entidad=? AND id_solicitud_presidente IS NULL ORDER BY estado='Pendiente' DESC,id_accion DESC''',(entity_id,origin))]
    result.extend(dict(r) for r in conn.execute(f'''SELECT id_solicitud AS id,'decision' AS kind,
        COALESCE(NULLIF(proximo_paso_solicitado,''),ultimo_comentario) AS descripcion,
        COALESCE((SELECT nombre FROM usuarios WHERE id_usuario=s.id_usuario_presidente),'Presidente') AS responsable,
        CASE WHEN estado='Solicita aclaracion' OR (estado IN ('Aprobada','Rechazada') AND gestion_estado<>'Gestionada') THEN 'Pendiente' ELSE estado END AS estado,
        fecha_objetivo,fecha_creacion,comentario_respuesta AS comentario_cierre
        FROM solicitudes_presidente s WHERE {field}=? AND tipo_origen=? ORDER BY id_solicitud DESC''',(entity_id,origin)))
    from presidency_domain import request_row,next_action
    for r in result:
        if r['kind']=='decision':
            req=request_row(conn,r['id'])
            r['responsable'],action=next_action(req)
            r['descripcion']=action+': '+(r['descripcion'] or '')
    return result

def validate_date(value):
    if clean(value):
        try: date.fromisoformat(clean(value))
        except ValueError: raise ValueError('La fecha del compromiso debe ser una fecha valida (AAAA-MM-DD).')

def validate_creation(data, kind):
    if kind not in STATES: raise ValueError('Tipo de expediente no valido.')
    for label,value in (
        ('titulo',data.get('titulo') or data.get('nombre')),
        ('descripcion',data.get('descripcion') or data.get('comentario')),
        ('responsable general',data.get('responsable_nuevo') or data.get('responsable')),
    ):
        if not clean(value):raise ValueError(f'El campo {label} es obligatorio.')
    state=clean(data.get('estado_nuevo') or data.get('estado') or 'Pendiente')
    if state not in STATES[kind]:raise ValueError('Estado no valido.')
    if state in CLOSED and not data.get('historical_records'):
        raise ValueError('Crea el expediente abierto; finalizalo despues con un comentario de cierre.')
    if state in CLOSED and clean(data.get('proximo_paso')):
        raise ValueError('El historico cerrado no puede tener un compromiso actual. Revisa el estado y deja el proximo paso vacio.')
    if kind=='project' and clean(data.get('fase_aprobacion') or 'Propuesta') not in APPROVALS:
        raise ValueError('Fase de aprobacion no valida.')
    validate_date(data.get('fecha_objetivo_proximo_paso'))
    records=data.get('historical_records') or []
    if not isinstance(records,list) or len(records)>50:
        raise ValueError('El historico admite hasta 50 entradas revisadas.')
    for row in records:
        if not isinstance(row,dict) or not clean(row.get('comentario')):
            raise ValueError('Cada entrada historica necesita un comentario.')
        validate_date(row.get('fecha'))
        validate_date(row.get('fecha_objetivo_proximo_paso'))

def validate_change(conn, kind, item, data, mode='record', archive=False):
    current=item['estado'] if kind=='task' else item['estado_general']
    target=clean(data.get('estado_nuevo') if mode=='record' else data.get('estado')) or current
    if archive:target='Archivada' if kind=='task' else 'Archivado'
    if target not in STATES[kind] and target!=current:raise ValueError('Estado no valido.')
    if mode=='record':
        if not clean(data.get('comentario')):raise ValueError('El comentario es obligatorio.')
        if not clean(data.get('responsable_proximo_paso')):raise ValueError('Selecciona el proximo responsable.')
    if mode=='edit' and not archive:
        for key,label in [('titulo','titulo'),('descripcion','descripcion'),('responsable','responsable general')]:
            if key in data and not clean(data[key]):raise ValueError(f'El campo {label} es obligatorio.')
    validate_date(data.get('fecha_objetivo_proximo_paso'))
    entity_id=item['id_tarea'] if kind=='task' else item['id_proyecto']
    if target in CLOSED:
        pending=[r for r in commitments(conn,kind,entity_id) if r['estado']=='Pendiente']
        if pending:raise ValueError(f'Quedan {len(pending)} compromisos o decisiones pendientes. Resuelvelos o cancelalos expresamente desde la ficha antes de cerrar.')
        if target!=current and not clean(data.get('comentario') or data.get('motivo_cierre')):
            raise ValueError('El comentario de cierre es obligatorio.')
        if mode=='record' and clean(data.get('proximo_paso')):
            raise ValueError('Un expediente cerrado no puede generar un compromiso nuevo. Deja el proximo paso vacio o reabre el expediente.')
    if current in CLOSED and target not in CLOSED and not clean(data.get('motivo_reapertura')):
        raise ValueError('Indica el motivo de reapertura.')
    if kind=='project' and 'fase_aprobacion' in data:
        approval=clean(data['fase_aprobacion'])
        if approval not in APPROVALS and approval!=clean(item.get('fase_aprobacion')):
            raise ValueError('Selecciona una fase de aprobacion valida.')
    return target

def merge_edit(item, kind, data):
    task=kind=='task'
    return {**item,'titulo':item['titulo' if task else 'nombre'],
        'responsable':item['responsable' if task else 'responsable_principal'],
        'estado':item['estado' if task else 'estado_general'],
        'proximo_paso':item.get('proximo_paso') if task else item.get('proximo_paso_actual') or item.get('observaciones'), **data}

def history(conn, session, kind, item, comment, event='Gestion de compromiso', target=None):
    task=kind=='task'
    table='registros' if task else 'registros_proyectos'
    key='id_tarea' if task else 'id_proyecto'
    state=item['estado'] if task else item['estado_general']
    owner=item['responsable'] if task else item['responsable_principal']
    fields=[key,'id_comunidad','fecha_hora','tipo_registro','comentario','estado_anterior','estado_nuevo',
        'prioridad_anterior','prioridad_nueva','responsable_anterior','responsable_nuevo','usuario','pc']
    values=[item[key],item['id_comunidad'],stamp(),event,comment,state,target or state,
        item['prioridad'],item['prioridad'],owner,owner,session['nombre'],session.get('pc','web')]
    if task:fields.append('id_proyecto');values.append(item['id_proyecto'])
    cur=conn.execute(f"INSERT INTO {table} ({','.join(fields)}) VALUES ({','.join('?' for _ in fields)})",values)
    return cur.lastrowid

def add_commitment(conn, session, kind, item, description, owner, due='', record_id=None):
    if not clean(description):return None
    if not clean(owner):raise ValueError('El compromiso necesita un responsable.')
    validate_date(due)
    task=kind=='task'
    if clean(owner).lower() in {'presidente','presidencia'} or conn.execute("SELECT 1 FROM usuarios WHERE nombre=? AND rol='Presidente' AND activo=1",(clean(owner),)).fetchone():
        return None  # Decisions require the explicit request action.
    cur=conn.execute('''INSERT INTO acciones_pendientes
        (id_comunidad,tipo_entidad,id_tarea,id_proyecto,id_registro_origen,tipo_accion,usuario_destino,
         solicitante,titulo,detalle,estado,fecha_creacion,pc_creacion,fecha_objetivo)
        VALUES (?,?,?,?,?,'Compromiso',?,?,?,?,'Pendiente',?,?,?)''',
        (item['id_comunidad'],'tarea' if task else 'proyecto',item['id_tarea'] if task else None,
         None if task else item['id_proyecto'],record_id,clean(owner),session['nombre'],
         item['titulo'] if task else item['nombre'],clean(description),stamp(),session.get('pc','web'),clean(due)))
    from presidency_domain import notify_assignment
    notify_assignment(conn,session,item,owner,clean(description))
    return cur.lastrowid

def synchronize(conn, session, kind, item, data, mode='record', archive=False):
    task=kind=='task'; table='tareas' if task else 'proyectos'; key='id_tarea' if task else 'id_proyecto'
    state=clean(data.get('estado_nuevo') if mode=='record' else data.get('estado')) or item['estado' if task else 'estado_general']
    if archive:state='Archivada' if task else 'Archivado'
    reopened=item['estado' if task else 'estado_general'] in CLOSED and state not in CLOSED
    if mode=='record' and reopened:
        history(conn,session,kind,item,clean(data.get('motivo_reapertura')),'Reapertura',state)
    if task:
        conn.execute('UPDATE tareas SET activa=?,archivada=? WHERE id_tarea=?',(int(state not in CLOSED),int(state=='Archivada'),item[key]))
    else:
        conn.execute('UPDATE proyectos SET activo=?,fecha_real_finalizacion=? WHERE id_proyecto=?',
            (int(state not in {'Archivado','Cancelado'}), (item.get('fecha_real_finalizacion') or date.today().isoformat()) if state=='Finalizado' else None,item[key]))
        if 'fase_aprobacion' in data and clean(data['fase_aprobacion'])!=clean(item.get('fase_aprobacion')):
            approval=clean(data['fase_aprobacion'])
            conn.execute('UPDATE proyectos SET fase_aprobacion=? WHERE id_proyecto=?',(approval,item[key]))
            history(conn,session,kind,item,f"Fase de aprobacion: {item.get('fase_aprobacion') or 'Sin clasificar'} -> {approval}.",'Aprobacion de proyecto')
    next_step=clean(data.get('proximo_paso'))
    if next_step:
        conn.execute(f'UPDATE {table} SET {"proximo_paso" if task else "proximo_paso_actual"}=? WHERE {key}=?',(next_step,item[key]))
    if mode=='edit' and not next_step and task:
        conn.execute('UPDATE tareas SET proximo_paso=? WHERE id_tarea=?',(item.get('proximo_paso'),item[key]))
    if not task and mode=='edit':
        conn.execute('UPDATE proyectos SET observaciones=? WHERE id_proyecto=?',(item.get('observaciones'),item[key]))
    if mode=='edit':
        comment=clean(data.get('motivo_reapertura') or data.get('comentario') or data.get('motivo_cierre')) or 'Datos del expediente actualizados.'
        reopened=item['estado' if task else 'estado_general'] in CLOSED and state not in CLOSED
        record_id=history(conn,session,kind,item,comment,'Reapertura' if reopened else 'Edicion de expediente',state)
        previous=item.get('proximo_paso') if task else item.get('proximo_paso_actual') or item.get('observaciones')
        if next_step and next_step!=clean(previous) and state not in CLOSED:
            add_commitment(conn,session,kind,item,next_step,data.get('responsable_proximo_paso') or item.get('responsable_proximo_paso'),data.get('fecha_objetivo_proximo_paso'),record_id)
    if state in CLOSED:
        conn.execute(f'UPDATE {table} SET {"proximo_paso" if task else "proximo_paso_actual"}=?,fecha_objetivo_proximo_paso=NULL WHERE {key}=?',('',item[key]))
    from presidency_domain import notify_assignment
    owner=data.get('responsable_nuevo') if mode=='record' else data.get('responsable')
    if owner and owner!=item['responsable' if task else 'responsable_principal']:
        notify_assignment(conn,session,item,owner,'Responsabilidad general asignada.')

def initialize_created(conn, session, kind, entity_id, data):
    table,key=('tareas','id_tarea') if kind=='task' else ('proyectos','id_proyecto')
    item=dict(conn.execute(f'SELECT * FROM {table} WHERE {key}=?',(entity_id,)).fetchone())
    if kind=='project':
        conn.execute('UPDATE proyectos SET fase_aprobacion=?,proximo_paso_actual=? WHERE id_proyecto=?',
            (clean(data.get('fase_aprobacion') or 'Propuesta'),clean(data.get('proximo_paso')),entity_id))
    record_id=history(conn,session,kind,item,clean(data.get('descripcion') or data.get('comentario')),'Creacion')
    from presidency_domain import notify_assignment
    notify_assignment(conn,session,item,item['responsable' if kind=='task' else 'responsable_principal'],'Responsabilidad general asignada.')
    state=item['estado' if kind=='task' else 'estado_general']
    if state in CLOSED:
        synchronize(conn,session,kind,item,{'estado_nuevo':state})
    # Historical steps are evidence, not newly assigned outstanding commitments.
    task=kind=='task'
    for row in data.get('historical_records') or []:
        comment=clean(row.get('comentario'))
        if not clean(row.get('fecha')):
            comment='[Fecha de la actuacion no indicada; registrada en la fecha de importacion]\n'+comment
        rid=history(conn,session,kind,item,comment,clean(row.get('tipo_registro')) or 'Seguimiento historico')
        history_table,history_key=('registros','id_registro') if task else ('registros_proyectos','id_registro_proyecto')
        source_state=clean(row.get('estado_nuevo'))
        if not task:source_state=source_state.replace('Bloqueada','Bloqueado').replace('Terminada','Finalizado')
        conn.execute(f'''UPDATE {history_table} SET fecha_hora=?,estado_nuevo=?,proximo_paso=?,
            responsable_proximo_paso=?,fecha_objetivo_proximo_paso=?,responsable_nuevo=?,prioridad_nueva=?,motivo_bloqueo=? WHERE {history_key}=?''',
            (clean(row.get('fecha'))+' 00:00:00' if clean(row.get('fecha')) else stamp(),
             source_state or item['estado' if task else 'estado_general'],clean(row.get('proximo_paso')),
             clean(row.get('responsable_proximo_paso')),clean(row.get('fecha_objetivo_proximo_paso')),
             clean(row.get('responsable_nuevo')),clean(row.get('prioridad_nueva')),clean(row.get('motivo_bloqueo')),rid))
    add_commitment(conn,session,kind,item,data.get('proximo_paso'),item['responsable_proximo_paso'],data.get('fecha_objetivo_proximo_paso'),record_id)

def resolve(conn, session, kind, entity_id, data):
    item=entity(conn,session,kind,entity_id)
    comment=clean(data.get('comentario'))
    if not comment:raise ValueError('Explica la resolucion o cancelacion del compromiso.')
    commitment=next((r for r in commitments(conn,kind,entity_id) if r['id']==int(data.get('id') or 0) and r['kind']==data.get('kind')),None)
    if not commitment or commitment['estado']!='Pendiente':raise ValueError('El compromiso ya no esta pendiente o no pertenece al expediente.')
    state=data.get('estado')
    if commitment['kind']=='decision':
        if state!='Cancelada':raise ValueError('Solo el presidente puede responder. Puedes cancelar expresamente la solicitud.')
        raise ValueError('Cancela la solicitud desde su conversacion para conservar todas las respuestas.')
    else:
        if state not in {'Resuelta','Cancelada'}:raise ValueError('Estado de compromiso no valido.')
        conn.execute('UPDATE acciones_pendientes SET estado=?,fecha_cierre=?,usuario_cierre=?,comentario_cierre=?,pc_cierre=? WHERE id_accion=?',
            (state,stamp(),session['nombre'],comment,session.get('pc','web'),commitment['id']))
    text=f"{state}: {commitment['descripcion']} | Responsable: {commitment['responsable']}. {comment}"
    history(conn,session,kind,item,text)
    table,key=('tareas','id_tarea') if kind=='task' else ('proyectos','id_proyecto')
    conn.execute(f'UPDATE {table} SET fecha_ultima_actualizacion=?,usuario_ultima_actualizacion=?,pc_ultima_actualizacion=? WHERE {key}=?',
        (stamp(),session['nombre'],session.get('pc','web'),entity_id))
    conn.execute('INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle) VALUES (?,?,?,?,?,?,?)',
        (stamp(),session['nombre'],session.get('pc','web'),'Resolver compromiso',kind,entity_id,text))
    return {'ok':True}
