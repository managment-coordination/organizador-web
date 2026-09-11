"""ERP 3 transaction boundary. No legacy writes or implicit financial confirmation."""

from datetime import date
import json

from access_control import permission, profile

from .audit import write_event
from .budget_service import BudgetService
from .budget_simulation import _load_by_id
from .contracts import Actor, canonical_json
from .database import connect, write_transaction
from .errors import ContractError, ConflictError, NotFoundError
from .outbox import enqueue
from .repository import CommandRepository, FoundationRepository
from .receivables_contracts import CAPABILITIES, CONTRACT_VERSION, cents, day, fingerprint, identity, known_time, require_fields, subject, text
from .receivables_projection import collection_balance, receipt_balance, validate_timeline


class ReceivablesService:
    def __init__(self, database_path):
        self.database_path = database_path

    @staticmethod
    def _wire(value):
        if isinstance(value,dict):
            return {k:str(v) if k.endswith('_cents') and type(v) is int else ReceivablesService._wire(v) for k,v in value.items()}
        if isinstance(value,list):return [ReceivablesService._wire(v) for v in value]
        return value

    @staticmethod
    def _session(conn, session, community_id, capability):
        actor=Actor.from_session(session)
        current=profile(conn,actor.user_id)
        if not current or current['bloqueado'] or current['auth_version']!=session.get('auth_version'):
            raise PermissionError('La sesion economica no esta vigente.')
        if not permission(current,community_id,'puede_ver'):
            raise PermissionError('No tienes acceso a esta comunidad.')
        FoundationRepository(conn).require_active_community(community_id)
        if capability not in CAPABILITIES:
            raise ContractError('Capacidad economica desconocida.')
        grant=conn.execute('SELECT allowed FROM erp_recibo_permisos WHERE id_comunidad=? AND id_usuario=? AND capability=?',
                           (community_id,actor.user_id,capability)).fetchone()
        if current['rol']!='Superusuario' and not (grant and grant[0]):
            raise PermissionError('No tienes permiso para esta operacion de recibos y cobros.')
        return actor,current

    def _read(self,session,query,op,capability='read'):
        conn=connect(self.database_path,readonly=True)
        try:
            self._session(conn,session,query.community_id,capability)
            conn.execute('BEGIN')
            return {'ok':True,'query':query.query,'entity':self._wire(op(conn,query))}
        finally:conn.close()

    def _write(self,session,env,op,capability):
        if not env.idempotency_key:raise ContractError('La operacion requiere idempotencia.')
        conn=connect(self.database_path)
        try:
            with write_transaction(conn):
                actor,_=self._session(conn,session,env.community_id,capability)
                commands=CommandRepository(conn)
                replay=commands.replay_or_start(env,actor)
                if replay is not None:return replay
                result=self._wire(op(conn,actor,env))
                audit=write_event(conn,community_id=env.community_id,actor=actor,action=env.command,
                    entity_type='erp3_operation',entity_id=result.get('id'),before=result.get('before'),
                    after=result,reason=env.reason,origin=env.origin,request_id=env.idempotency_key,
                    entity_version=result.get('version'),evidence=env.evidence,metadata={'contract':CONTRACT_VERSION})
                outbox=enqueue(conn,community_id=env.community_id,event_type=env.command,
                    aggregate_type='erp3_operation',aggregate_id=result.get('id'),
                    payload={'audit_event_id':audit,'economic_event_ids':result.get('event_ids',[]),'contract':CONTRACT_VERSION},
                    dedupe_key=env.idempotency_key)
                response={'ok':True,'command':env.command,'entity':result,'audit_event_id':audit,
                          'outbox_event_id':outbox,'idempotent_replay':False}
                commands.complete(env,response)
                return response
        finally:conn.close()

    @staticmethod
    def _entity(conn,table,community_id,entity_id):
        row=conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? AND id=?',(community_id,identity(entity_id))).fetchone()
        if row is None:raise NotFoundError('El registro no existe en esta comunidad.')
        return dict(row)

    @staticmethod
    def _version(row,expected):
        if expected is None or isinstance(expected,bool) or identity(expected)!=row['version']:
            raise ConflictError('El registro ha cambiado; revisa de nuevo antes de confirmar.')

    @staticmethod
    def _subject(conn,community_id,value):
        ref=subject(value)
        table,key=('cf_propietarios','id_propietario') if ref['type']=='owner' else ('erp_personas_cobro','id_persona_cobro')
        row=conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? AND {key}=?',(community_id,ref['id'])).fetchone()
        if row is None:raise NotFoundError('El sujeto no pertenece a esta comunidad.')
        return {**ref,'name':row['nombre']}

    @staticmethod
    def _date_open(conn,community_id,value):
        value=day(value)
        locked=conn.execute("SELECT 1 FROM erp_bloqueos_periodo WHERE id_comunidad=? AND activo=1 AND dominio IN ('todos','financiero','recibos','erp3') AND fecha_inicio<=? AND fecha_fin>=?",(community_id,value,value)).fetchone()
        closed=conn.execute("SELECT 1 FROM erp_ejercicios WHERE id_comunidad=? AND estado IN ('cerrado','bloqueado') AND fecha_inicio<=? AND fecha_fin>=?",(community_id,value,value)).fetchone()
        if locked or closed:raise ConflictError('El periodo economico esta bloqueado.')
        return value

    @staticmethod
    def _evidence(env,required=False):
        if required and env.evidence is None:raise ContractError('La operacion requiere documento o evidencia.')
        return None if env.evidence is None else {'type':env.evidence.entity_type,'id':env.evidence.entity_id}

    def _event(self,conn,actor,env,event_type,effective_on,payload,suffix='0'):
        now=known_time(None)
        event_id=conn.execute('''INSERT INTO erp_hechos_economicos
            (id_comunidad,event_key,event_type,schema_version,effective_on,registered_at,actor_id,
             payload_json,payload_hash,reason,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)''',
            (env.community_id,env.command+':'+env.idempotency_key+':'+suffix,event_type,CONTRACT_VERSION,
             effective_on,now,actor.user_id,canonical_json(payload),fingerprint(payload),env.reason,
             canonical_json(self._evidence(env)))).lastrowid
        return event_id,now

    def permissions_save(self,session,env):
        def op(conn,actor,e):
            current=profile(conn,actor.user_id)
            if current['rol']!='Superusuario':raise PermissionError('Solo administracion global puede asignar estas capacidades.')
            p=require_fields(e.payload,('user_id','capabilities'))
            uid=identity(p['user_id']); target=profile(conn,uid)
            if not target or not permission(target,e.community_id):raise ContractError('El usuario no tiene acceso a la comunidad.')
            caps=p['capabilities']
            if not isinstance(caps,dict) or set(caps)-CAPABILITIES or any(type(v) is not bool for v in caps.values()):
                raise ContractError('Capacidades no validas.')
            version=conn.execute('SELECT COALESCE(MAX(version),0) FROM erp_recibo_permisos WHERE id_comunidad=? AND id_usuario=?',(e.community_id,uid)).fetchone()[0]
            if e.expected_version!=version:raise ConflictError('Los permisos han cambiado.')
            before={row[0]:bool(row[1]) for row in conn.execute('SELECT capability,allowed FROM erp_recibo_permisos WHERE id_comunidad=? AND id_usuario=?',(e.community_id,uid))}
            for cap in sorted(CAPABILITIES):
                conn.execute('''INSERT INTO erp_recibo_permisos VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT(id_comunidad,id_usuario,capability) DO UPDATE SET allowed=excluded.allowed,
                    version=excluded.version,registered_at=excluded.registered_at,actor_id=excluded.actor_id''',
                    (e.community_id,uid,cap,int(caps.get(cap,False)),version+1,known_time(None),actor.user_id))
            return {'id':uid,'version':version+1,'before':before,'capabilities':caps}
        return self._write(session,env,op,'configure')

    def responsibility_confirm(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('property_id','effective_from','subjects'),('effective_until','concept_key'))
            pid=identity(p['property_id']); start=day(p['effective_from'])
            end=day(p['effective_until']) if p.get('effective_until') else None
            if end and end<=start:raise ContractError('Vigencia no valida.')
            if not conn.execute('SELECT 1 FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?',(e.community_id,pid)).fetchone():
                raise NotFoundError('Propiedad no encontrada en la comunidad.')
            concept=text(p.get('concept_key','*'),'Concepto',maximum=200)
            if not isinstance(p['subjects'],list) or not 1<=len(p['subjects'])<=50:raise ContractError('Indica los obligados acreditados.')
            subjects=[self._subject(conn,e.community_id,s) for s in p['subjects']]
            if len({(s['type'],s['id']) for s in subjects})!=len(subjects):raise ContractError('Obligado duplicado.')
            version=conn.execute('SELECT COALESCE(MAX(version),0) FROM erp_obligacion_config_versiones WHERE id_comunidad=? AND id_propiedad=? AND concept_key=?',(e.community_id,pid,concept)).fetchone()[0]
            if e.expected_version!=version:raise ConflictError('La configuracion de obligados ha cambiado.')
            if not e.reason:raise ContractError('Indica el motivo y origen de la acreditacion.')
            evidence=self._evidence(e,required=True)
            rid=conn.execute('''INSERT INTO erp_obligacion_config_versiones (id_comunidad,id_propiedad,concept_key,
                version,effective_from,effective_until,subjects_json,mode,registered_at,actor_id,evidence_json,reason)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',(e.community_id,pid,concept,version+1,start,end,
                canonical_json(subjects),'individual' if len(subjects)==1 else 'shared',known_time(None),actor.user_id,canonical_json(evidence),e.reason)).lastrowid
            return {'id':rid,'version':version+1,'subjects':subjects,'existing_receipts_changed':False}
        return self._write(session,env,op,'resolve_responsibility')

    def _emission_preview(self,conn,community_id,p):
        require_fields(p,('plan_version_id','period_keys','issued_on'),('property_ids','due_on'))
        issue=self._date_open(conn,community_id,p['issued_on'])
        plan=conn.execute('''SELECT v.*,p.tipo,p.origen_tipo,p.origen_id,p.moneda,p.estado AS plan_state
            FROM erp_plan_versiones v JOIN erp_planes_cuota p ON p.id_comunidad=v.id_comunidad AND p.id_plan=v.id_plan
            WHERE v.id_comunidad=? AND v.id_plan_version=?''',(community_id,identity(p['plan_version_id']))).fetchone()
        if not plan or plan['estado']!='aprobada' or plan['plan_state']!='aprobado':raise ConflictError('Selecciona un plan aprobado.')
        result=_load_by_id(conn,community_id,plan['id_simulacion'])
        if not result or result['status']!='completa':raise ConflictError('El plan no tiene calculo certificado.')
        if not isinstance(p['period_keys'],list) or not p['period_keys'] or len(set(p['period_keys']))!=len(p['period_keys']):
            raise ContractError('Selecciona periodos distintos.')
        periods={row['clave_periodo']:dict(row) for row in conn.execute('SELECT * FROM erp_plan_periodos WHERE id_comunidad=? AND id_plan_version=?',(community_id,plan['id_plan_version']))}
        if set(p['period_keys'])-periods.keys():raise ContractError('Periodo ajeno al plan.')
        selection=p.get('property_ids')
        if selection is not None and (not isinstance(selection,list) or not selection):raise ContractError('Seleccion de propiedades vacia.')
        selected={identity(i) for i in selection} if selection is not None else {int(q['property_id']) for q in result['property_totals']}
        if selected-{int(q['property_id']) for q in result['property_totals']}:raise ContractError('Propiedad ajena al calculo aprobado.')
        lines=[];total=0
        budget=BudgetService(self.database_path)
        for quota in result['property_totals']:
            pid=int(quota['property_id'])
            if pid not in selected:continue
            values={x['key']:cents(x['cents'],nonnegative=True) for x in quota['periods']}
            billing=budget._billing_at(conn,community_id,pid,issue)
            def role_ref(value):
                if not value:raise ContractError('Falta destinatario/pagador acreditado para emitir.')
                ref={'type':'owner','id':value['id_propietario']} if value.get('id_propietario') else {'type':'person','id':value.get('id_persona_cobro')}
                return self._subject(conn,community_id,ref)
            recipient=role_ref(billing['recipient']);payer=role_ref(billing['payer'])
            for key in p['period_keys']:
                period=periods[key];amount=values[key]
                concept='ordinario' if plan['tipo']=='ordinario' else 'derrama:'+str(plan['origen_id'])
                configs=list(conn.execute('''SELECT * FROM erp_obligacion_config_versiones WHERE id_comunidad=? AND id_propiedad=?
                    AND concept_key IN (?, '*') AND effective_from<=? AND (effective_until IS NULL OR effective_until>?)
                    ORDER BY CASE WHEN concept_key=? THEN 0 ELSE 1 END,effective_from DESC,version DESC''',(community_id,pid,concept,issue,issue,concept)))
                if not configs:raise ContractError('Confirma previamente los obligados economicos de la propiedad; no se deducen del destinatario.')
                config=configs[0]
                obligations=[self._subject(conn,community_id,{'type':s['type'],'id':s['id']}) for s in json.loads(config['subjects_json'])]
                semantic=f"{pid}:{concept}:{period['fecha_inicio']}:{period['fecha_fin']}"
                source=f"{plan['id_plan_version']}:{period['id_periodo_plan']}:{pid}"
                if conn.execute('SELECT 1 FROM erp_recibos WHERE id_comunidad=? AND obligation_key=?',(community_id,semantic)).fetchone():
                    raise ConflictError('Esta obligacion ya fue emitida. Una revision del presupuesto no permite duplicarla.')
                details=[]
                for line in result['lines']:
                    if int(line['property_id'])!=pid:continue
                    item=dict(line)
                    period_line=next((x for x in line['periods'] if x['key']==key),None)
                    if period_line is not None:
                        item['period_result']=period_line
                        details.append({'key':str(line['item_id'])+':'+str(line['assignment_id']),
                                        'amount_cents':str(cents(period_line['final_cents'])), 'calculation':item})
                if sum(int(x['amount_cents']) for x in details)!=amount:raise ContractError('El detalle del snapshot no cuadra con la cuota.')
                due=day(p['due_on']) if p.get('due_on') else period['fecha_vencimiento']
                lines.append({'property_id':pid,'exercise_id':period['id_ejercicio'],'period_key':key,
                    'period_from':period['fecha_inicio'],'period_until':period['fecha_fin'],'concept_key':concept,
                    'source_key':source,'obligation_key':semantic,'amount_cents':str(amount),'issued_on':issue,'due_on':due,
                    'recipient':recipient,'payer':payer,'obligated':obligations,'responsibility_version':config['id'],
                    'billing_config':billing['config'],'details':details})
                total=cents(total+amount)
        if len(lines)>500:raise ContractError('Selecciona un sublote de hasta 500 lineas para revision atomica.')
        return {'plan_version_id':plan['id_plan_version'],'simulation_id':plan['id_simulacion'],
                'calculation_hash':result['stored_result_hash'],'currency':plan['moneda'],
                'lines':lines,'total_cents':str(total),'issued_on':issue}

    def emission_preview(self,session,env):
        def op(conn,actor,e):
            preview=self._emission_preview(conn,e.community_id,e.payload)
            lot=conn.execute('''INSERT INTO erp_emisiones_lotes
                (id_comunidad,operation,state,payload_json,preview_json,preview_hash,registered_at,actor_id)
                VALUES (?,'emission','draft',?,?,?,?,?)''',(e.community_id,canonical_json(e.payload),canonical_json(preview),fingerprint(preview),known_time(None),actor.user_id)).lastrowid
            return {'id':lot,'version':1,'preview':preview}
        return self._write(session,env,op,'prepare_emission')

    def emission_confirm(self,session,env):
        def op(conn,actor,e):
            require_fields(e.payload,('proposal_id',))
            lot=self._entity(conn,'erp_emisiones_lotes',e.community_id,e.payload['proposal_id'])
            self._version(lot,e.expected_version)
            if lot['state']!='draft' or lot['operation']!='emission':raise ConflictError('La propuesta no se puede emitir.')
            preview=self._emission_preview(conn,e.community_id,json.loads(lot['payload_json']))
            if fingerprint(preview)!=lot['preview_hash']:raise ConflictError('El contexto de emision ha cambiado; revisa otra vez.')
            ids=[];events=[]
            serial=conn.execute('SELECT COUNT(*) FROM erp_recibos WHERE id_comunidad=?',(e.community_id,)).fetchone()[0]
            for index,line in enumerate(preview['lines']):
                if not int(line['amount_cents']):continue
                serial+=1;number=f"R-{serial:08d}"
                snapshot={**line,'simulation_id':preview['simulation_id'],'plan_version_id':preview['plan_version_id'],'calculation_hash':preview['calculation_hash']}
                event,now=self._event(conn,actor,e,'erp3.receipt.issued',line['issued_on'],
                    {'number':number,'source_key':line['source_key'],'amount_cents':line['amount_cents'],'currency':preview['currency']},str(index))
                rid=conn.execute('''INSERT INTO erp_recibos
                    (id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,
                     source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id)
                    VALUES (?,?,?,?,?,?,?,?,?,'plan',?,?,?,?,?,?,?,?,?,?)''',
                    (e.community_id,line['property_id'],line['exercise_id'],number,line['concept_key'],line['concept_key'],
                     line['period_key'],line['period_from'],line['period_until'],line['source_key'],line['obligation_key'],int(line['amount_cents']),
                     preview['currency'],line['issued_on'],line['due_on'],canonical_json(snapshot),fingerprint(snapshot),now,actor.user_id)).lastrowid
                for role,subjects in [('obligated',line['obligated']),('recipient',[line['recipient']]),('payer',[line['payer']])]:
                    for s in subjects:
                        conn.execute('INSERT INTO erp_recibo_sujetos (id_comunidad,receipt_id,role,owner_id,person_id,snapshot_json) VALUES (?,?,?,?,?,?)',
                            (e.community_id,rid,role,s['id'] if s['type']=='owner' else None,s['id'] if s['type']=='person' else None,canonical_json(s)))
                for detail in line['details']:
                    conn.execute('INSERT INTO erp_recibo_detalles (id_comunidad,receipt_id,line_key,amount_cents,snapshot_json) VALUES (?,?,?,?,?)',
                        (e.community_id,rid,detail['key'],int(detail['amount_cents']),canonical_json(detail['calculation'])))
                ids.append(rid);events.append(event)
            result={'id':lot['id'],'version':lot['version']+1,'receipt_ids':ids,'event_ids':events,'total_cents':preview['total_cents']}
            conn.execute("UPDATE erp_emisiones_lotes SET state='confirmed',version=version+1,confirmed_at=?,result_json=? WHERE id=?",(known_time(None),canonical_json(result),lot['id']))
            return result
        return self._write(session,env,op,'confirm_emission')

    def collection_record(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('amount_cents','currency','effective_on','method','external_source','external_key'),('payer','value_on','treasury_reference'))
            amount=cents(p['amount_cents'],positive=True); effective=self._date_open(conn,e.community_id,p['effective_on'])
            currency=conn.execute('SELECT moneda FROM comunidades WHERE id_comunidad=?',(e.community_id,)).fetchone()[0]
            if p['currency']!=currency:raise ContractError('La moneda no coincide con la comunidad.')
            if p['method'] not in ('transferencia','efectivo','tarjeta','remesa','otro'):raise ContractError('Medio de cobro no valido.')
            payer=self._subject(conn,e.community_id,p['payer']) if p.get('payer') else None
            external_source=text(p['external_source'],'Origen',maximum=80)
            external_key=text(p['external_key'],'Referencia',maximum=200)
            duplicate=conn.execute('SELECT id FROM erp_cobros WHERE id_comunidad=? AND external_source=? AND external_key=?',(e.community_id,external_source,external_key)).fetchone()
            if duplicate:raise ConflictError('Ya existe un cobro con esta referencia de origen.')
            event,now=self._event(conn,actor,e,'erp3.collection.recorded',effective,{'amount_cents':str(amount),'currency':currency})
            cid=conn.execute('''INSERT INTO erp_cobros (id_comunidad,amount_cents,currency,effective_on,value_on,
                method,treasury_reference,payer_owner_id,payer_person_id,external_source,external_key,
                registered_at,actor_id,evidence_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (e.community_id,amount,currency,effective,day(p['value_on']) if p.get('value_on') else None,p['method'],
                 text(p.get('treasury_reference'),'Cuenta',required=False,maximum=200),
                 payer['id'] if payer and payer['type']=='owner' else None,payer['id'] if payer and payer['type']=='person' else None,
                 external_source,external_key,now,actor.user_id,canonical_json(self._evidence(e)))).lastrowid
            return {'id':cid,'version':1,'event_ids':[event],'balance':collection_balance(conn,e.community_id,cid,effective)}
        return self._write(session,env,op,'record_collection')

    def _allocation_preview(self,conn,community_id,p):
        require_fields(p,('collection_id','effective_on','allocations'))
        collection=self._entity(conn,'erp_cobros',community_id,p['collection_id'])
        effective=self._date_open(conn,community_id,p['effective_on'])
        balance=collection_balance(conn,community_id,collection['id'],effective)
        lines=p['allocations']
        if not isinstance(lines,list) or not 1<=len(lines)<=500:raise ContractError('Selecciona entre 1 y 500 aplicaciones.')
        total=0;seen=set();result=[]
        for line in lines:
            require_fields(line,('receipt_id','amount_cents'))
            receipt=self._entity(conn,'erp_recibos',community_id,line['receipt_id'])
            if receipt['id'] in seen:raise ContractError('Recibo duplicado en la propuesta.')
            seen.add(receipt['id']);amount=cents(line['amount_cents'],positive=True)
            rb=receipt_balance(conn,community_id,receipt['id'],effective)
            if collection['currency']!=receipt['currency']:raise ContractError('Monedas distintas.')
            if amount>int(rb['pending_cents']):raise ConflictError('La aplicacion supera el pendiente.')
            total=cents(total+amount)
            result.append({'receipt_id':receipt['id'],'number':receipt['number'],'version':receipt['version'],
                           'amount_cents':str(amount),'before_cents':rb['pending_cents'],'after_cents':str(int(rb['pending_cents'])-amount)})
        if total>int(balance['available_cents']):raise ConflictError('La aplicacion supera los fondos disponibles.')
        return {'collection_id':collection['id'],'collection_version':collection['version'],'effective_on':effective,
                'before_cents':balance['available_cents'],'after_cents':str(int(balance['available_cents'])-total),'allocations':result}

    def allocation_preview(self,session,env):
        def op(conn,actor,e):
            preview=self._allocation_preview(conn,e.community_id,e.payload)
            lot=conn.execute('''INSERT INTO erp_emisiones_lotes
                (id_comunidad,operation,state,payload_json,preview_json,preview_hash,registered_at,actor_id)
                VALUES (?,'allocation','draft',?,?,?,?,?)''',
                (e.community_id,canonical_json(e.payload),canonical_json(preview),fingerprint(preview),known_time(None),actor.user_id)).lastrowid
            return {'id':lot,'version':1,'preview':preview}
        return self._write(session,env,op,'allocate')

    def allocation_confirm(self,session,env):
        def op(conn,actor,e):
            require_fields(e.payload,('proposal_id',))
            lot=self._entity(conn,'erp_emisiones_lotes',e.community_id,e.payload['proposal_id'])
            self._version(lot,e.expected_version)
            if lot['state']!='draft' or lot['operation']!='allocation':raise ConflictError('La propuesta no se puede confirmar.')
            preview=self._allocation_preview(conn,e.community_id,json.loads(lot['payload_json']))
            if fingerprint(preview)!=lot['preview_hash']:raise ConflictError('Los saldos cambiaron; genera una nueva propuesta.')
            if not e.reason:raise ContractError('Confirma el motivo de la imputacion, especialmente si el pagador es distinto del obligado.')
            event,now=self._event(conn,actor,e,'erp3.collection.allocated',preview['effective_on'],preview)
            for line in preview['allocations']:
                conn.execute('''INSERT INTO erp_imputaciones
                    (id_comunidad,collection_id,receipt_id,event_id,amount_cents,effective_on,registered_at)
                    VALUES (?,?,?,?,?,?,?)''',(e.community_id,preview['collection_id'],line['receipt_id'],event,int(line['amount_cents']),preview['effective_on'],now))
                conn.execute('UPDATE erp_recibos SET version=version+1 WHERE id=? AND id_comunidad=?',(line['receipt_id'],e.community_id))
            conn.execute('UPDATE erp_cobros SET version=version+1 WHERE id=? AND id_comunidad=?',(preview['collection_id'],e.community_id))
            validate_timeline(conn,e.community_id,[l['receipt_id'] for l in preview['allocations']],[preview['collection_id']])
            result={'id':lot['id'],'version':lot['version']+1,'event_ids':[event],'preview':preview}
            conn.execute("UPDATE erp_emisiones_lotes SET state='confirmed',version=version+1,confirmed_at=?,result_json=? WHERE id=?",(now,canonical_json(result),lot['id']))
            return result
        return self._write(session,env,op,'allocate')

    def receipt_get(self,session,query):
        def op(conn,q):
            p=require_fields(q.filters,('receipt_id',),('effective_at','known_at'))
            row=self._entity(conn,'erp_recibos',q.community_id,p['receipt_id'])
            balance=receipt_balance(conn,q.community_id,row['id'],p.get('effective_at'),p.get('known_at'))
            return {'receipt':row,'balance':balance,'subjects':[dict(r) for r in conn.execute('SELECT role,snapshot_json FROM erp_recibo_sujetos WHERE id_comunidad=? AND receipt_id=?',(q.community_id,row['id']))],
                    'details':[dict(r) for r in conn.execute('SELECT line_key,amount_cents,snapshot_json FROM erp_recibo_detalles WHERE id_comunidad=? AND receipt_id=?',(q.community_id,row['id']))]}
        return self._read(session,query,op)

    def _correction_preview(self,conn,community_id,operation,p):
        if operation=='return':
            require_fields(p,('collection_id','effective_on','free_cents','reversals','external_key'))
            c=self._entity(conn,'erp_cobros',community_id,p['collection_id'])
            effective=self._date_open(conn,community_id,p['effective_on'])
            before=collection_balance(conn,community_id,c['id'],effective)
            free=cents(p['free_cents'],nonnegative=True)
            if free>int(before['available_cents']):raise ConflictError('La devolucion de fondos libres supera el disponible.')
            if not isinstance(p['reversals'],list):raise ContractError('Detalla las imputaciones que revierte.')
            details=[];seen=set();total=free
            for item in p['reversals']:
                require_fields(item,('allocation_id','amount_cents'))
                a=self._entity(conn,'erp_imputaciones',community_id,item['allocation_id'])
                if a['reverses_id'] or a['collection_id']!=c['id'] or a['effective_on']>effective or a['id'] in seen:
                    raise ContractError('La imputacion no puede revertirse desde esta devolucion.')
                seen.add(a['id']);amount=cents(item['amount_cents'],positive=True)
                reversed_total=sum(r[0] for r in conn.execute('SELECT amount_cents FROM erp_imputaciones WHERE id_comunidad=? AND reverses_id=?',(community_id,a['id'])))
                if amount>int(a['amount_cents'])-reversed_total:raise ConflictError('Ya se ha revertido parte de esta imputacion.')
                r=self._entity(conn,'erp_recibos',community_id,a['receipt_id'])
                rb=receipt_balance(conn,community_id,r['id'],effective)
                details.append({'allocation_id':a['id'],'receipt_id':r['id'],'receipt_version':r['version'],'amount_cents':str(amount),
                                'pending_before':rb['pending_cents'],'pending_after':str(int(rb['pending_cents'])+amount)})
                total=cents(total+amount)
            if total<=0:raise ContractError('La devolucion debe ser positiva.')
            external_key=text(p['external_key'],'Referencia',maximum=200)
            if conn.execute('SELECT 1 FROM erp_devoluciones WHERE id_comunidad=? AND external_key=?',(community_id,external_key)).fetchone():
                raise ConflictError('Esta devolucion ya esta registrada.')
            return {'operation':operation,'collection_id':c['id'],'collection_version':c['version'],'effective_on':effective,
                    'amount_cents':str(total),'free_cents':str(free),'details':details,'external_key':external_key,
                    'available_before':before['available_cents'],'available_after':str(int(before['available_cents'])-free)}
        require_fields(p,('receipt_id','effective_on'),('amount_cents','classification'))
        r=self._entity(conn,'erp_recibos',community_id,p['receipt_id'])
        effective=self._date_open(conn,community_id,p['effective_on'])
        balance=receipt_balance(conn,community_id,r['id'],effective)
        if operation=='void':
            if balance['state']=='anulado':raise ConflictError('El recibo ya esta anulado.')
            for table in ('erp_imputaciones','erp_rectificaciones','erp_credito_aplicaciones','erp_reasignaciones_obligacion'):
                if conn.execute(f'SELECT 1 FROM {table} WHERE id_comunidad=? AND receipt_id=?',(community_id,r['id'])).fetchone():
                    raise ConflictError('Existen movimientos posteriores; utiliza una rectificacion, no anulacion simple.')
            amount=int(r['amount_cents'])
        elif operation=='credit':
            amount=cents(p.get('amount_cents'),positive=True)
            if amount>int(balance['pending_cents']):
                raise ConflictError('El abono supera el pendiente. Libera explicitamente los fondos aplicados antes de abonar.')
        elif operation=='uncollectible':
            classification=p.get('classification')
            if classification not in ('incobrable','en_gestion'):raise ContractError('Clasificacion no valida.')
            amount=0
        else:raise ContractError('Operacion correctora desconocida.')
        return {'operation':operation,'receipt_id':r['id'],'receipt_version':r['version'],'effective_on':effective,
                'amount_cents':str(amount),'pending_before':balance['pending_cents'],'pending_after':str(int(balance['pending_cents'])-amount),
                'classification':p.get('classification')}

    def _prepare_correction(self,session,env,operation,capability):
        def op(conn,actor,e):
            if not e.reason:raise ContractError('Indica el motivo de la operacion.')
            if operation=='uncollectible':self._evidence(e,required=True)
            preview=self._correction_preview(conn,e.community_id,operation,e.payload)
            lot=conn.execute('''INSERT INTO erp_emisiones_lotes
                (id_comunidad,operation,state,payload_json,preview_json,preview_hash,registered_at,actor_id)
                VALUES (?,?,'draft',?,?,?,?,?)''',(e.community_id,operation,canonical_json(e.payload),canonical_json(preview),fingerprint(preview),known_time(None),actor.user_id)).lastrowid
            return {'id':lot,'version':1,'preview':preview}
        return self._write(session,env,op,capability)

    def _confirm_correction(self,session,env,operation,capability):
        def op(conn,actor,e):
            require_fields(e.payload,('proposal_id',))
            if not e.reason:raise ContractError('Indica el motivo de la confirmacion.')
            if operation=='uncollectible':self._evidence(e,required=True)
            lot=self._entity(conn,'erp_emisiones_lotes',e.community_id,e.payload['proposal_id'])
            self._version(lot,e.expected_version)
            if lot['state']!='draft' or lot['operation']!=operation:raise ConflictError('Propuesta incompatible.')
            preview=self._correction_preview(conn,e.community_id,operation,json.loads(lot['payload_json']))
            if fingerprint(preview)!=lot['preview_hash']:raise ConflictError('El saldo o su contexto ha cambiado.')
            event,now=self._event(conn,actor,e,{'return':'erp3.collection.returned','void':'erp3.receipt.voided',
                'credit':'erp3.credit.issued','uncollectible':'erp3.receipt.uncollectible_classified'}[operation],preview['effective_on'],preview)
            receipts=[];collections=[]
            if operation=='return':
                collections=[preview['collection_id']]
                for item in preview['details']:
                    conn.execute('''INSERT INTO erp_imputaciones (id_comunidad,collection_id,receipt_id,event_id,reverses_id,amount_cents,effective_on,registered_at)
                        VALUES (?,?,?,?,?,?,?,?)''',(e.community_id,preview['collection_id'],item['receipt_id'],event,item['allocation_id'],int(item['amount_cents']),preview['effective_on'],now))
                    receipts.append(item['receipt_id'])
                conn.execute('''INSERT INTO erp_devoluciones (id_comunidad,collection_id,event_id,amount_cents,free_cents,details_json,effective_on,registered_at,external_key)
                    VALUES (?,?,?,?,?,?,?,?,?)''',(e.community_id,preview['collection_id'],event,int(preview['amount_cents']),int(preview['free_cents']),canonical_json(preview['details']),preview['effective_on'],now,preview['external_key']))
            elif operation in ('credit','void'):
                receipts=[preview['receipt_id']]
                conn.execute('''INSERT INTO erp_rectificaciones (id_comunidad,receipt_id,event_id,kind,amount_cents,effective_on,registered_at)
                    VALUES (?,?,?,?,?,?,?)''',(e.community_id,preview['receipt_id'],event,operation,int(preview['amount_cents']),preview['effective_on'],now))
            else:
                receipts=[preview['receipt_id']]
                conn.execute('INSERT INTO erp_recibo_gestion_eventos (id_comunidad,receipt_id,event_id,classification,effective_on,registered_at) VALUES (?,?,?,?,?,?)',
                    (e.community_id,preview['receipt_id'],event,preview['classification'],preview['effective_on'],now))
            for rid in set(receipts):conn.execute('UPDATE erp_recibos SET version=version+1 WHERE id_comunidad=? AND id=?',(e.community_id,rid))
            for cid in collections:conn.execute('UPDATE erp_cobros SET version=version+1 WHERE id_comunidad=? AND id=?',(e.community_id,cid))
            validate_timeline(conn,e.community_id,receipts,collections)
            result={'id':lot['id'],'version':lot['version']+1,'event_ids':[event],'preview':preview}
            conn.execute("UPDATE erp_emisiones_lotes SET state='confirmed',version=version+1,confirmed_at=?,result_json=? WHERE id=?",(now,canonical_json(result),lot['id']))
            return result
        return self._write(session,env,op,capability)

    def return_preview(self,session,env):return self._prepare_correction(session,env,'return','return_collection')
    def return_confirm(self,session,env):return self._confirm_correction(session,env,'return','return_collection')
    def credit_preview(self,session,env):return self._prepare_correction(session,env,'credit','credit')
    def credit_confirm(self,session,env):return self._confirm_correction(session,env,'credit','credit')
    def void_preview(self,session,env):return self._prepare_correction(session,env,'void','void')
    def void_confirm(self,session,env):return self._confirm_correction(session,env,'void','void')
    def uncollectible_preview(self,session,env):return self._prepare_correction(session,env,'uncollectible','classify_uncollectible')
    def uncollectible_confirm(self,session,env):return self._confirm_correction(session,env,'uncollectible','classify_uncollectible')

    def collection_get(self,session,query):
        def op(conn,q):
            p=require_fields(q.filters,('collection_id',),('effective_at','known_at'))
            row=self._entity(conn,'erp_cobros',q.community_id,p['collection_id'])
            return {'collection':row,'balance':collection_balance(conn,q.community_id,row['id'],p.get('effective_at'),p.get('known_at'))}
        return self._read(session,query,op)
