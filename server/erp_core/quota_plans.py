"""Active ERP 2 plans composed with the certified ERP 3 emission boundary."""

from datetime import date, timedelta
import json

from .budget_contracts import CONTRACT_VERSION
from .budget_engine import PERIOD_COUNTS, simulate_budget
from .budget_service import BudgetService, _periods
from .budget_simulation import _load_by_id, persist_simulation
from .contracts import CommandEnvelope, canonical_json
from .errors import ConflictError, ContractError, NotFoundError
from .receivables_contracts import cents, day, fingerprint, identity, known_time, require_fields, text
from .receivables_service import ReceivablesService


def operational_at(conn, community, plan, effective):
    row=conn.execute('''SELECT * FROM erp_plan_operativo_versiones WHERE id_comunidad=? AND id_plan=?
        AND efectiva_desde<=? ORDER BY efectiva_desde DESC,version DESC LIMIT 1''',(community,plan,effective)).fetchone()
    return dict(row) if row and (not row['efectiva_hasta'] or effective<row['efectiva_hasta']) else None


def activity_at(conn, community, plan, effective):
    row=conn.execute('''SELECT activa FROM erp_plan_actividad WHERE id_comunidad=? AND id_plan=?
        AND efectiva_desde<=? ORDER BY efectiva_desde DESC,version DESC LIMIT 1''',(community,plan,effective)).fetchone()
    return bool(row and row[0])


def configured_version(conn, community, version):
    return conn.execute('SELECT * FROM erp_plan_operativo_versiones WHERE id_comunidad=? AND id_plan_version=? ORDER BY version DESC LIMIT 1',
                        (community,version)).fetchone()


class QuotaPlanService(ReceivablesService):
    @staticmethod
    def _plan(conn,community,plan_id):
        row=conn.execute('SELECT * FROM erp_planes_cuota WHERE id_comunidad=? AND id_plan=?',(community,identity(plan_id))).fetchone()
        if row is None:raise NotFoundError('El plan no existe en esta comunidad.')
        return dict(row)

    def _configuration(self,conn,actor,e,known_at):
        p=require_fields(e.payload,('name','concept','exercise_id','origin_type','effective_from'),
            ('plan_id','effective_until','description','amount_cents','amount_mode','frequency','group_id',
             'rule_type','series_purpose','series_unit','rule_parameters','budget_id','budget_item_id'))
        community=e.community_id
        exercise=conn.execute('SELECT * FROM erp_ejercicios WHERE id_comunidad=? AND id_ejercicio=?',
                              (community,identity(p['exercise_id']))).fetchone()
        if not exercise or exercise['estado'] in ('cerrado','bloqueado'):raise ConflictError('Selecciona un ejercicio disponible.')
        start=day(p['effective_from']);end=day(p['effective_until']) if p.get('effective_until') else None
        if not exercise['fecha_inicio']<=start<=exercise['fecha_fin'] or end and (end<=start or end>(date.fromisoformat(exercise['fecha_fin'])+timedelta(days=1)).isoformat()):
            raise ContractError('La vigencia debe pertenecer al ejercicio; el fin es exclusivo.')
        plan_id=identity(p['plan_id']) if p.get('plan_id') else None
        previous=self._plan(conn,community,plan_id) if plan_id else None
        version=conn.execute('SELECT COALESCE(MAX(version),0) FROM erp_plan_operativo_versiones WHERE id_comunidad=? AND id_plan=?',(community,plan_id)).fetchone()[0] if plan_id else 0
        if e.expected_version!=version:raise ConflictError('La configuracion del plan ha cambiado.')
        if plan_id and not version and previous['origen_tipo']!='presupuesto':raise ContractError('Este plan historico no se configura desde esta operativa.')
        budget=BudgetService(self.database_path)
        config={'name':text(p['name'],'Nombre',maximum=200),'concept':text(p['concept'],'Concepto',maximum=300),
            'description':text(p.get('description'),'Descripcion',required=False),'exercise_id':exercise['id_ejercicio'],
            'origin_type':p['origin_type'],'effective_from':start,'effective_until':end,'plan_id':plan_id,
            'previous_version':version}
        if p['origin_type']=='presupuesto':
            b=budget._budget(conn,community,identity(p.get('budget_id')))
            if b['estado']!='aprobado' or b['id_ejercicio']!=exercise['id_ejercicio']:raise ConflictError('Selecciona un presupuesto aprobado del ejercicio.')
            base=conn.execute('''SELECT p.id_plan,v.* FROM erp_planes_cuota p JOIN erp_plan_versiones v ON v.id_plan=p.id_plan
                WHERE p.id_comunidad=? AND p.origen_tipo='presupuesto' AND p.origen_id=? AND v.estado='aprobada' ORDER BY v.version DESC LIMIT 1''',
                (community,str(b['id_presupuesto']))).fetchone()
            if not base:raise ConflictError('El presupuesto no tiene un plan calculado.')
            if plan_id and plan_id!=base['id_plan']:raise ConflictError('No se sustituye el origen economico de un plan. Crea otro o regulariza.')
            # Reuse the complete approved snapshot, including all group assignments.
            if p.get('budget_item_id'):raise ContractError('La cuota ordinaria utiliza el presupuesto completo; sus partidas no se cobran otra vez por separado.')
            result=_load_by_id(conn,community,base['id_simulacion'])
            config.update(plan_id=base['id_plan'],budget_id=b['id_presupuesto'],budget_version_id=b['id_presupuesto_version'],
                calculation_version_id=base['id_plan_version'],amount_cents=result['quota_target_cents'],
                amount_mode='total_anual',frequency=b['periodicidad'],simulation_id=base['id_simulacion'])
            real_version=conn.execute('SELECT COALESCE(MAX(version),0) FROM erp_plan_operativo_versiones WHERE id_plan=?',(base['id_plan'],)).fetchone()[0]
            if real_version!=version:raise ConflictError('El presupuesto ya tiene un plan operativo; edita ese plan para evitar duplicados.')
            return config,None,result
        if p['origin_type']!='importe_manual':raise ContractError('Origen del plan no admitido.')
        if previous and previous['origen_tipo']!='importe_manual':raise ConflictError('Un presupuesto aprobado no se sustituye por un importe manual.')
        frequency=p.get('frequency');mode=p.get('amount_mode')
        if frequency not in PERIOD_COUNTS or mode not in ('total_anual','por_periodo'):raise ContractError('Selecciona periodicidad y modo de importe.')
        amount=cents(p.get('amount_cents'),positive=True);total=cents(amount*(PERIOD_COUNTS[frequency] if mode=='por_periodo' else 1),positive=True)
        group_id=identity(p.get('group_id'))
        group=conn.execute('''SELECT g.*,v.id_grupo_version,v.base,v.suma_esperada_decimal,v.estado AS version_state
            FROM erp_grupos_reparto g JOIN erp_grupo_versiones v ON v.id_grupo=g.id_grupo
            WHERE g.id_comunidad=? AND g.id_grupo=? AND g.estado='activo' AND v.estado='aprobada'
            AND (v.efectiva_desde IS NULL OR v.efectiva_desde<=?) AND (v.efectiva_hasta IS NULL OR v.efectiva_hasta>?)
            ORDER BY v.version DESC''',(community,group_id,start,start)).fetchall()
        if len(group)!=1:raise ConflictError('El grupo debe tener una unica version aprobada y vigente.')
        group=group[0];rule_type=p.get('rule_type','coeficiente');purpose=p.get('series_purpose','general')
        unit=p.get('series_unit') or ('porcentaje' if group['base']=='porcentaje' else 'peso')
        params=p.get('rule_parameters') or {}
        rule=budget._rule(conn,community,actor.user_id,rule_type,group_id,purpose,unit,params,e.origin)
        parameters=json.loads(conn.execute('SELECT parametros_json FROM erp_regla_versiones WHERE id_regla_version=?',(rule,)).fetchone()[0])
        assignment={'id':rule,'key':'plan','mode':'importe','value':str(total),
            'series_purpose':purpose,'series_unit':unit,
            'group':{'id':group_id,'version_id':group['id_grupo_version'],'name':group['nombre'],'base':group['base'],
                     'expected_total':group['suma_esperada_decimal'],'state':group['version_state']},
            'rule':{'version_id':rule,'type':rule_type,'state':'aprobada','parameters':parameters},
            'members':budget._assignment_members(conn,community,{'id_grupo':group_id,'regla_tipo':rule_type,
                'finalidad_serie':purpose,'unidad_serie':unit},start)}
        if params.get('quantities'):
            for member in assignment['members']:member['quantity']=params['quantities'].get(str(member['property_id']))
        periods=_periods(exercise['fecha_inicio'],exercise['fecha_fin'],frequency,3,10)
        manifest={'contract_version':CONTRACT_VERSION,'community_id':community,'budget_version_id':None,
            'budget_version_number':version+1,'origin_type':'derrama','origin_id':'manual-plan:'+fingerprint(config),
            'reference_date':start,'known_at':known_at,'currency':exercise['moneda'],'periodicity':frequency,
            'periods':periods,'items':[{'id':1,'key':'cuota-manual','name':config['concept'],'chapter_id':None,
                'amount_cents':str(total),'financing':[],'assignments':[assignment]}]}
        if mode=='por_periodo':manifest.update(plan_amount_mode=mode,period_target_cents=str(amount))
        result=simulate_budget(manifest)
        if result['status']!='completa':raise ContractError(' '.join(i['message'] for i in result.get('incidents',[])))
        if mode=='por_periodo' and any(sum(int(q['cents']) for prop in result['property_totals'] for q in prop['periods'] if q['key']==period['key'])!=amount for period in periods):
            raise ConflictError('La periodificacion no conserva el importe por periodo; revisa el reparto.')
        config.update(amount_cents=str(amount),annual_cents=str(total),amount_mode=mode,frequency=frequency,
            group_id=group_id,group_name=group['nombre'],rule_type=rule_type,series_purpose=purpose,series_unit=unit,rule_parameters=params)
        return config,manifest,result

    def plan_preview(self,session,env):
        def op(conn,actor,e):
            registered=known_time(None)
            config,manifest,result=self._configuration(conn,actor,e,registered)
            preview={'config':config,'manifest':manifest,'result':result}
            lot=conn.execute('''INSERT INTO erp_emisiones_lotes(id_comunidad,operation,state,payload_json,preview_json,preview_hash,registered_at,actor_id)
                VALUES (?,'quota_plan','draft',?,?,?,?,?)''',(e.community_id,canonical_json(e.payload),canonical_json(preview),fingerprint(preview),registered,actor.user_id)).lastrowid
            return {'id':lot,'version':1,'preview':preview,'configuration_version':config['previous_version']}
        return self._write(session,env,op,'plan_modify' if env.payload.get('plan_id') else 'plan_create')

    def plan_confirm(self,session,env):
        def op(conn,actor,e):
            self._session(conn,session,e.community_id,'plan_activate')
            require_fields(e.payload,('proposal_id','configuration_version'))
            lot=self._entity(conn,'erp_emisiones_lotes',e.community_id,e.payload['proposal_id']);self._version(lot,e.expected_version)
            if lot['operation']!='quota_plan' or lot['state']!='draft':raise ConflictError('La propuesta ya no se puede guardar.')
            original=CommandEnvelope.from_value({'command':e.command,'id_comunidad':e.community_id,'payload':json.loads(lot['payload_json']),
                'expected_version':e.payload['configuration_version'],'idempotency_key':e.idempotency_key,'reason':e.reason,'origin':e.origin})
            config,manifest,result=self._configuration(conn,actor,original,lot['registered_at'])
            if fingerprint({'config':config,'manifest':manifest,'result':result})!=lot['preview_hash']:raise ConflictError('Los datos han cambiado. Revisa el plan otra vez.')
            if not e.reason:raise ContractError('Documenta el motivo del plan.')
            now=known_time(None);pid=config['plan_id']
            if manifest:
                if not pid:
                    pid=conn.execute('''INSERT INTO erp_planes_cuota(id_comunidad,tipo,origen_tipo,origen_id,moneda,estado,version,creado_en,creado_por,origen)
                        VALUES (?,'derrama','importe_manual',?,?,'aprobado',1,?,?,?)''',(e.community_id,e.idempotency_key,manifest['currency'],now,actor.user_id,e.origin)).lastrowid
                simulation=persist_simulation(self.database_path,manifest,actor_id=actor.user_id,origin=e.origin,connection=conn)
                pv_version=conn.execute('SELECT COALESCE(MAX(version),0)+1 FROM erp_plan_versiones WHERE id_plan=?',(pid,)).fetchone()[0]
                periods=manifest['periods']
                pv=conn.execute('''INSERT INTO erp_plan_versiones(id_comunidad,id_plan,version,id_simulacion,fecha_inicio,fecha_fin,estado,registrada_en,registrada_por,origen)
                    VALUES (?,?,?,?,?,?,'aprobada',?,?,?)''',(e.community_id,pid,pv_version,simulation['simulation_id'],periods[0]['date_start'],periods[-1]['date_end'],now,actor.user_id,e.origin)).lastrowid
                for period in periods:
                    conn.execute('''INSERT INTO erp_plan_periodos(id_comunidad,id_plan_version,clave_periodo,fecha_inicio,fecha_fin,fecha_emision_prevista,fecha_vencimiento,peso_decimal,id_ejercicio,orden)
                        VALUES (?,?,?,?,?,?,?,?,?,?)''',(e.community_id,pv,period['key'],period['date_start'],period['date_end'],period['issue_date'],period['due_date'],period['weight'],config['exercise_id'],period['order']))
                config.update(plan_id=pid,calculation_version_id=pv,simulation_id=simulation['simulation_id'])
            rid=conn.execute('''INSERT INTO erp_plan_operativo_versiones(id_comunidad,id_plan,id_plan_version,id_ejercicio,version,nombre,concepto,descripcion,origen_tipo,
                modo_importe,importe_centimos,periodicidad,efectiva_desde,efectiva_hasta,configuracion_json,registrada_en,registrada_por,motivo,origen)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',(e.community_id,pid,config['calculation_version_id'],config['exercise_id'],config['previous_version']+1,
                config['name'],config['concept'],config['description'],config['origin_type'],config['amount_mode'],int(config['amount_cents']),config['frequency'],
                config['effective_from'],config['effective_until'],canonical_json(config),now,actor.user_id,e.reason,e.origin)).lastrowid
            # Saving a new configuration is an explicit activation, not background issuance.
            av=conn.execute('SELECT COALESCE(MAX(version),0)+1 FROM erp_plan_actividad WHERE id_plan=?',(pid,)).fetchone()[0]
            conn.execute('INSERT INTO erp_plan_actividad(id_comunidad,id_plan,version,activa,efectiva_desde,registrada_en,registrada_por,motivo) VALUES (?,?,?,1,?,?,?,?)',
                         (e.community_id,pid,av,config['effective_from'],now,actor.user_id,e.reason))
            result={'id':pid,'version':config['previous_version']+1,'operational_version_id':rid,'calculation_version_id':config['calculation_version_id'],
                'retroactive':bool(conn.execute('''SELECT 1 FROM erp_plan_emision_vinculos v
                    JOIN erp_recibos r ON r.id=v.receipt_id AND r.id_comunidad=v.id_comunidad
                    WHERE v.id_comunidad=? AND v.id_plan=? AND r.period_from>=?''',(e.community_id,pid,config['effective_from'])).fetchone()),
                'historical_receipts_changed':False,'regularization_required':False}
            result['regularization_required']=result['retroactive']
            conn.execute("UPDATE erp_emisiones_lotes SET state='confirmed',version=version+1,confirmed_at=?,result_json=? WHERE id=?",(now,canonical_json(result),lot['id']))
            return result
        return self._write(session,env,op,'plan_modify' if env.payload.get('configuration_version') else 'plan_create')

    def plan_activity(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('plan_id','active','effective_from'))
            pid=identity(p['plan_id']);effective=day(p['effective_from'])
            if type(p['active']) is not bool:raise ContractError('Indica activo o inactivo.')
            self._plan(conn,e.community_id,pid)
            if not conn.execute('SELECT 1 FROM erp_plan_operativo_versiones WHERE id_comunidad=? AND id_plan=?',(e.community_id,pid)).fetchone():raise ContractError('Configura primero el plan.')
            version=conn.execute('SELECT COALESCE(MAX(version),0) FROM erp_plan_actividad WHERE id_plan=?',(pid,)).fetchone()[0]
            if e.expected_version!=version:raise ConflictError('El estado del plan ha cambiado.')
            if not e.reason:raise ContractError('Indica el motivo del cambio.')
            conn.execute('INSERT INTO erp_plan_actividad(id_comunidad,id_plan,version,activa,efectiva_desde,registrada_en,registrada_por,motivo) VALUES (?,?,?,?,?,?,?,?)',
                (e.community_id,pid,version+1,int(p['active']),effective,known_time(None),actor.user_id,e.reason))
            return {'id':pid,'version':version+1,'active':p['active'],'effective_from':effective,'historical_receipts_changed':False}
        return self._write(session,env,op,'plan_activate')

    def plan_list(self,session,query):
        def op(conn,q):
            at=day(q.filters.get('effective_at') or date.today().isoformat());items=[]
            for plan in conn.execute('SELECT * FROM erp_planes_cuota WHERE id_comunidad=? ORDER BY id_plan DESC',(q.community_id,)):
                versions=[dict(r) for r in conn.execute('SELECT * FROM erp_plan_operativo_versiones WHERE id_comunidad=? AND id_plan=? ORDER BY version DESC',(q.community_id,plan['id_plan']))]
                if not versions:
                    if plan['origen_tipo']!='presupuesto':continue
                    b=conn.execute('SELECT denominacion,id_ejercicio FROM erp_presupuestos WHERE id_comunidad=? AND id_presupuesto=?',(q.community_id,plan['origen_id'])).fetchone()
                    if b:items.append({'id':plan['id_plan'],'name':b['denominacion'],'origin_type':'presupuesto','budget_id':int(plan['origen_id']),
                                      'exercise_id':b['id_ejercicio'],'configured':False,'active':False})
                    continue
                current=operational_at(conn,q.community_id,plan['id_plan'],at)
                shown=current or versions[0];config=json.loads(shown['configuracion_json'])
                acts=[dict(r) for r in conn.execute('SELECT * FROM erp_plan_actividad WHERE id_comunidad=? AND id_plan=? ORDER BY version DESC',(q.community_id,plan['id_plan']))]
                active=bool(current and activity_at(conn,q.community_id,plan['id_plan'],at))
                periods=[dict(r) for r in conn.execute('SELECT * FROM erp_plan_periodos WHERE id_plan_version=? ORDER BY orden',(shown['id_plan_version'],))]
                next_period=next((p for p in periods if p['fecha_emision_prevista']>=at and p['fecha_inicio']>=shown['efectiva_desde'] and (not shown['efectiva_hasta'] or p['fecha_inicio']<shown['efectiva_hasta']) and activity_at(conn,q.community_id,plan['id_plan'],p['fecha_inicio'])),None)
                items.append({'id':plan['id_plan'],'configured':True,'name':shown['nombre'],'concept':shown['concepto'],'config':config,
                    'origin_type':shown['origen_tipo'],'amount_cents':str(shown['importe_centimos']),'amount_mode':shown['modo_importe'],
                    'frequency':shown['periodicidad'],'active':active,'version':versions[0]['version'],'activity_version':acts[0]['version'],
                    'effective_from':shown['efectiva_desde'],'effective_until':shown['efectiva_hasta'],'exercise_id':shown['id_ejercicio'],
                    'next_issue':next_period['fecha_emision_prevista'] if next_period else None,'history':versions,'activity_history':acts,
                    'emissions':[dict(r) for r in conn.execute('SELECT receipt_id,id_plan_operativo FROM erp_plan_emision_vinculos WHERE id_comunidad=? AND id_plan=?',(q.community_id,plan['id_plan']))]})
            groups=[dict(r) for r in conn.execute('SELECT id_grupo,codigo,nombre FROM erp_grupos_reparto WHERE id_comunidad=? AND estado=\'activo\' ORDER BY nombre',(q.community_id,))]
            series=[dict(r) for r in conn.execute('SELECT DISTINCT id_grupo,finalidad,unidad FROM erp_coeficiente_series WHERE id_comunidad=? AND estado=\'activa\' ORDER BY finalidad',(q.community_id,))]
            exercises=[dict(r) for r in conn.execute('SELECT id_ejercicio,codigo,fecha_inicio,fecha_fin FROM erp_ejercicios WHERE id_comunidad=? AND estado NOT IN (\'cerrado\',\'bloqueado\') ORDER BY fecha_inicio DESC',(q.community_id,))]
            budgets=[dict(r) for r in conn.execute('SELECT id_presupuesto,id_ejercicio,denominacion FROM erp_presupuestos WHERE id_comunidad=? AND estado=\'aprobado\' ORDER BY id_presupuesto DESC',(q.community_id,))]
            properties=[dict(r) for r in conn.execute('SELECT id_propiedad,codigo_propiedad FROM cf_propiedades WHERE id_comunidad=? ORDER BY codigo_propiedad',(q.community_id,))]
            return {'items':items,'effective_at':at,'references':{'groups':groups,'series':series,'exercises':exercises,'budgets':budgets,'properties':properties},
                'capabilities':{cap:self._allowed(conn,session,q.community_id,cap) for cap in ('plan_create','plan_modify','plan_activate','prepare_emission','confirm_emission')}}
        return self._read(session,query,op)

    def _allowed(self,conn,session,community,cap):
        try:self._session(conn,session,community,cap);return True
        except PermissionError:return False

    def _period_preview(self,conn,community,p):
        require_fields(p,('exercise_id','period_from','issued_on'),('due_on',))
        start=day(p['period_from']);issued=self._date_open(conn,community,p['issued_on']);exercise=identity(p['exercise_id'])
        erow=conn.execute('SELECT * FROM erp_ejercicios WHERE id_comunidad=? AND id_ejercicio=?',(community,exercise)).fetchone()
        if not erow or not erow['fecha_inicio']<=start<=erow['fecha_fin']:raise ContractError('El periodo no pertenece al ejercicio de esta comunidad.')
        plans=[];existing=[];total=0;errors=[]
        for (pid,) in conn.execute('SELECT DISTINCT id_plan FROM erp_plan_operativo_versiones WHERE id_comunidad=? AND id_ejercicio=? ORDER BY id_plan',(community,exercise)):
            config=operational_at(conn,community,pid,start)
            if not config or not activity_at(conn,community,pid,start):continue
            period=conn.execute('SELECT * FROM erp_plan_periodos WHERE id_comunidad=? AND id_plan_version=? AND fecha_inicio=?',(community,config['id_plan_version'],start)).fetchone()
            if not period:continue
            concept='ordinario' if config['origen_tipo']=='presupuesto' else 'cuota_plan:'+str(pid)
            simulation=_load_by_id(conn,community,config['id_simulacion']) if 'id_simulacion' in config else _load_by_id(conn,community,json.loads(config['configuracion_json'])['simulation_id'])
            missing=[]
            for quota in simulation['property_totals']:
                semantic=f"{quota['property_id']}:{concept}:{period['fecha_inicio']}:{period['fecha_fin']}"
                prior=conn.execute('SELECT id FROM erp_recibos WHERE id_comunidad=? AND obligation_key=? ORDER BY id DESC LIMIT 1',(community,semantic)).fetchone()
                zero=conn.execute('SELECT 1 FROM erp_cuotas_cero_procesadas WHERE id_comunidad=? AND obligation_key=?',(community,semantic)).fetchone()
                if prior or zero:existing.append({'plan_id':pid,'name':config['nombre'],'property_id':quota['property_id'],'receipt_id':prior['id'] if prior else None})
                else:missing.append(quota['property_id'])
            if not missing:continue
            payload={'plan_version_id':config['id_plan_version'],'period_keys':[period['clave_periodo']],'property_ids':missing,'issued_on':issued}
            if p.get('due_on'):payload['due_on']=p['due_on']
            try:preview=self._emission_preview(conn,community,payload)
            except (ContractError,ConflictError) as error:
                errors.append({'plan_id':pid,'name':config['nombre'],'message':str(error)});continue
            plans.append({'id':pid,'name':config['nombre'],'operational_version_id':config['id'],'payload':payload,'preview':preview})
            total=cents(total+int(preview['total_cents']))
        if sum(len(x['preview']['lines']) for x in plans)>500:raise ContractError('La revision atomica admite hasta 500 recibos; acota los planes o periodos.')
        return {'exercise_id':exercise,'period_from':start,'issued_on':issued,'plans':plans,'already_issued':existing,
                'errors':errors,'total_cents':str(total),'receipt_count':sum(len(x['preview']['lines']) for x in plans)}

    def period_preview(self,session,env):
        def op(conn,actor,e):
            preview=self._period_preview(conn,e.community_id,e.payload)
            lot=conn.execute('''INSERT INTO erp_emisiones_lotes(id_comunidad,operation,state,payload_json,preview_json,preview_hash,registered_at,actor_id)
                VALUES (?,'active_plans','draft',?,?,?,?,?)''',(e.community_id,canonical_json(e.payload),canonical_json(preview),fingerprint(preview),known_time(None),actor.user_id)).lastrowid
            return {'id':lot,'version':1,'preview':preview}
        return self._write(session,env,op,'prepare_emission')

    def period_confirm(self,session,env):
        def op(conn,actor,e):
            require_fields(e.payload,('proposal_id',))
            lot=self._entity(conn,'erp_emisiones_lotes',e.community_id,e.payload['proposal_id']);self._version(lot,e.expected_version)
            if lot['state']!='draft' or lot['operation']!='active_plans':raise ConflictError('La propuesta ya esta confirmada o descartada.')
            preview=self._period_preview(conn,e.community_id,json.loads(lot['payload_json']))
            if preview['errors']:raise ConflictError('Resuelve las incidencias de todos los planes antes de emitir.')
            if fingerprint(preview)!=lot['preview_hash']:raise ConflictError('Los planes, destinatarios o recibos han cambiado. Revisa de nuevo.')
            service=ReceivablesService.in_transaction(self.database_path,conn);receipts=[];events=[]
            for index,plan in enumerate(preview['plans']):
                def envelope(command,payload,version=None,suffix=''):
                    return CommandEnvelope.from_value({'command':command,'id_comunidad':e.community_id,'payload':payload,
                        'expected_version':version,'idempotency_key':e.idempotency_key+':'+str(index)+suffix,'reason':e.reason,'origin':e.origin})
                proposal=service.emission_preview(session,envelope('erp3.emission.preview',plan['payload'],suffix=':preview'))['entity']
                result=service.emission_confirm(session,envelope('erp3.emission.confirm',{'proposal_id':proposal['id']},proposal['version'],':confirm'))['entity']
                receipts+=result['receipt_ids'];events+=result['event_ids']
            result={'id':lot['id'],'version':lot['version']+1,'receipt_ids':receipts,'event_ids':events,'total_cents':preview['total_cents'],'already_issued':preview['already_issued']}
            conn.execute("UPDATE erp_emisiones_lotes SET state='confirmed',version=version+1,confirmed_at=?,result_json=? WHERE id=?",(known_time(None),canonical_json(result),lot['id']))
            return result
        return self._write(session,env,op,'confirm_emission')
