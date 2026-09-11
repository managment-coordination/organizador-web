"""Materialize approved ERP 2 differences without recalculating their amounts."""

import json

from .budget_service import BudgetService
from .budget_simulation import _load_by_id
from .contracts import canonical_json
from .errors import ConflictError, ContractError, NotFoundError
from .receivables_contracts import cents, day, fingerprint, identity, known_time, require_fields, text
from .receivables_projection import receipt_balance


class RegularizationOperations:
    @staticmethod
    def _require_coverage(conn,community,concept,start,end):
        rows=list(conn.execute('''SELECT * FROM erp_recibos_coberturas WHERE id_comunidad=? AND concept_key=?
            AND effective_from<=? AND effective_until>=?''',(community,concept,start,end)))
        if len(rows)!=1 or rows[0]['authority']!='erp3':
            raise ConflictError('Falta confirmar ERP 3 como fuente rectora para este concepto y periodo. No se presupone cobertura cero.')
        return dict(rows[0])

    def coverage_confirm(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('concept_key','effective_from','effective_until','authority'))
            start=day(p['effective_from']);end=day(p['effective_until']);concept=text(p['concept_key'],'Concepto',maximum=200)
            if end<start or p['authority'] not in ('erp3','legacy_observed'):raise ContractError('Cobertura no valida.')
            if not e.reason:raise ContractError('Documenta el corte y la fuente rectora.')
            evidence=self._evidence(e,required=True)
            if conn.execute('''SELECT 1 FROM erp_recibos_coberturas WHERE id_comunidad=? AND concept_key=?
                AND effective_from<=? AND effective_until>=?''',(e.community_id,concept,end,start)).fetchone():
                raise ConflictError('La cobertura se solapa con otra ya confirmada.')
            # Legacy periods are not reinterpreted as locally issued obligations.
            if p['authority']=='erp3' and conn.execute('''SELECT 1 FROM cf_recibos WHERE id_comunidad=?
                AND fecha_emision>=? AND fecha_emision<=? LIMIT 1''',(e.community_id,start,end)).fetchone():
                raise ConflictError('Existen recibos historicos en este intervalo; reconcilia su cobertura antes de activar emision local.')
            rid=conn.execute('''INSERT INTO erp_recibos_coberturas
                (id_comunidad,concept_key,effective_from,effective_until,authority,registered_at,actor_id,reason,evidence_json)
                VALUES (?,?,?,?,?,?,?,?,?)''',(e.community_id,concept,start,end,p['authority'],known_time(None),actor.user_id,e.reason,canonical_json(evidence))).lastrowid
            return {'id':rid,'coverage':p,'legacy_changed':False}
        return self._write(session,env,op,'configure')

    def _regularization_preview(self,conn,community,p):
        require_fields(p,('regularization_id','effective_on','decisions'),('due_on',))
        effective=self._date_open(conn,community,p['effective_on'])
        reg=conn.execute('SELECT * FROM erp_regularizaciones WHERE id_comunidad=? AND id_regularizacion=?',
                         (community,identity(p['regularization_id']))).fetchone()
        if not reg or reg['estado']!='aprobada':raise ConflictError('Selecciona una regularizacion aprobada.')
        rows=list(conn.execute('SELECT * FROM erp_regularizacion_lineas WHERE id_comunidad=? AND id_regularizacion=? ORDER BY id_linea',(community,reg['id_regularizacion'])))
        if not isinstance(p['decisions'],list):raise ContractError('Revisa los sujetos de cada ajuste.')
        decisions={identity(x.get('line_id')):x for x in p['decisions']}
        if len(decisions)!=len(p['decisions']) or set(decisions)!={r['id_linea'] for r in rows}:
            raise ContractError('Revisa una vez cada linea de la regularizacion, sin omisiones ni duplicados.')
        plan=conn.execute('SELECT * FROM erp_planes_cuota WHERE id_comunidad=? AND id_plan=?',(community,reg['id_plan_esperado'])).fetchone()
        version=conn.execute("SELECT * FROM erp_plan_versiones WHERE id_comunidad=? AND id_plan=? AND estado='aprobada' ORDER BY version DESC LIMIT 1",(community,plan['id_plan'])).fetchone()
        if not version:raise ConflictError('El plan origen no tiene version aprobada.')
        periods={r['clave_periodo']:dict(r) for r in conn.execute('SELECT * FROM erp_plan_periodos WHERE id_comunidad=? AND id_plan_version=?',(community,version['id_plan_version']))}
        result=[]
        for row in rows:
            if conn.execute('SELECT 1 FROM erp_regularizaciones_materializadas WHERE id_comunidad=? AND line_id=?',(community,row['id_linea'])).fetchone():
                raise ConflictError('Esta regularizacion ya se ha materializado.')
            decision=decisions[row['id_linea']];amount=cents(row['diferencia_centimos']);period=periods.get(row['periodo_clave'])
            if not period:raise ConflictError('No se puede resolver el periodo de la regularizacion.')
            coverage=self._require_coverage(conn,community,'ordinario',period['fecha_inicio'],period['fecha_fin'])
            require_fields(decision,('line_id','subjects'),('credit_beneficiary',))
            if not isinstance(decision['subjects'],list) or not decision['subjects']:raise ContractError('Acredita los obligados del ajuste sin deducirlos del titular actual.')
            subjects=[self._subject(conn,community,x) for x in decision['subjects']]
            if len({(x['type'],x['id']) for x in subjects})!=len(subjects):raise ContractError('Obligado duplicado.')
            billing=BudgetService(self.database_path)._billing_at(conn,community,row['id_propiedad'],effective)
            roles={}
            if amount>0:
                for role in ('recipient','payer'):
                    value=billing[role]
                    if not value:raise ConflictError('Falta destinatario o pagador confirmado para el ajuste.')
                    roles[role]=self._subject(conn,community,{'type':'owner','id':value['id_propietario']} if value.get('id_propietario') else {'type':'person','id':value['id_persona_cobro']})
            if amount<0:
                roles['credit_beneficiary']=self._subject(conn,community,decision.get('credit_beneficiary'))
            result.append({'line_id':row['id_linea'],'property_id':row['id_propiedad'],'period_key':row['periodo_clave'],
                'period':period,'amount_cents':str(amount),'due_cents':str(row['debido_centimos']),
                'net_emitted_cents':str(row['emitido_neto_centimos']),'previous_adjustments_cents':str(row['ajustes_previos_centimos']),
                'subjects':subjects,'coverage_id':coverage['id'],**roles})
        return {'regularization_id':reg['id_regularizacion'],'regularization_version':reg['version'],'plan_id':plan['id_plan'],
                'currency':plan['moneda'],'effective_on':effective,'due_on':day(p['due_on']) if p.get('due_on') else None,
                'lines':result,'charge_cents':str(cents(sum(max(0,int(r['amount_cents'])) for r in result))),
                'credit_cents':str(cents(sum(max(0,-int(r['amount_cents'])) for r in result)))}

    def _regularization_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        events=[];receipts=[];credits=[]
        serial=conn.execute('SELECT COUNT(*) FROM erp_recibos WHERE id_comunidad=?',(e.community_id,)).fetchone()[0]
        for line in p['lines']:
            amount=int(line['amount_cents']);rid=None;cid=None
            snapshot={**line,'regularization_id':p['regularization_id'],'effective_on':p['effective_on'],'plan_id':p['plan_id']}
            event,now=self._event(conn,actor,e,'erp3.regularization.materialized',p['effective_on'],snapshot,str(line['line_id']))
            if amount>0:
                serial+=1;source='regularization:'+str(line['line_id']);period=line['period']
                rid=conn.execute('''INSERT INTO erp_recibos
                    (id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,
                     source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id)
                    VALUES (?,?,?,?,'regularizacion','Regularizacion de cuotas',?,?,?,'regularization',?,?,?,?,?,?,?,?,?,?)''',
                    (e.community_id,line['property_id'],period['id_ejercicio'],f'R-{serial:08d}',line['period_key'],period['fecha_inicio'],period['fecha_fin'],
                     source,source,amount,p['currency'],p['effective_on'],p['due_on'],canonical_json(snapshot),fingerprint(snapshot),now,actor.user_id)).lastrowid
                for role,subjects in [('obligated',line['subjects']),('recipient',[line['recipient']]),('payer',[line['payer']])]:
                    for s in subjects:conn.execute('INSERT INTO erp_recibo_sujetos (id_comunidad,receipt_id,role,owner_id,person_id,snapshot_json) VALUES (?,?,?,?,?,?)',
                        (e.community_id,rid,role,s['id'] if s['type']=='owner' else None,s['id'] if s['type']=='person' else None,canonical_json(s)))
                conn.execute('INSERT INTO erp_recibo_detalles (id_comunidad,receipt_id,line_key,amount_cents,snapshot_json) VALUES (?,?,?,?,?)',
                             (e.community_id,rid,source,amount,canonical_json(snapshot)))
                receipts.append(rid)
            elif amount<0:
                s=line['credit_beneficiary']
                cid=conn.execute('''INSERT INTO erp_creditos (id_comunidad,event_id,owner_id,person_id,amount_cents,effective_on,registered_at)
                    VALUES (?,?,?,?,?,?,?)''',(e.community_id,event,s['id'] if s['type']=='owner' else None,s['id'] if s['type']=='person' else None,-amount,p['effective_on'],now)).lastrowid
                credits.append(cid)
            conn.execute('''INSERT INTO erp_regularizaciones_materializadas
                (id_comunidad,line_id,event_id,receipt_id,credit_id,amount_cents,effective_on,registered_at) VALUES (?,?,?,?,?,?,?,?)''',
                (e.community_id,line['line_id'],event,rid,cid,amount,p['effective_on'],now))
            events.append(event)
        return {'event_ids':events,'receipt_ids':receipts,'credit_ids':credits,'original_receipts_changed':False,'automatic_credit_application':False}

    def regularization_emission_preview(self,s,e):
        return self._review_operation(s,e,'regularization_emission','adjust',self._regularization_preview)

    def regularization_emission_confirm(self,s,e):
        return self._review_operation(s,e,'regularization_emission','adjust',self._regularization_preview,self._regularization_apply)

    def emitted_coverage(self,session,query):
        def op(conn,q):
            p=require_fields(q.filters,('plan_id','effective_at'),('period_keys','known_at'))
            effective=day(p['effective_at']);known=known_time(p.get('known_at'))
            plan=conn.execute("SELECT * FROM erp_planes_cuota WHERE id_comunidad=? AND id_plan=? AND estado='aprobado'",(q.community_id,identity(p['plan_id']))).fetchone()
            if not plan or plan['tipo']!='ordinario':raise NotFoundError('Selecciona un plan ordinario aprobado.')
            version=conn.execute("SELECT * FROM erp_plan_versiones WHERE id_comunidad=? AND id_plan=? AND estado='aprobada' ORDER BY version DESC LIMIT 1",(q.community_id,plan['id_plan'])).fetchone()
            result=_load_by_id(conn,q.community_id,version['id_simulacion'])
            periods={r['clave_periodo']:dict(r) for r in conn.execute('SELECT * FROM erp_plan_periodos WHERE id_comunidad=? AND id_plan_version=?',(q.community_id,version['id_plan_version']))}
            selected=p.get('period_keys',list(periods))
            if not isinstance(selected,list) or not selected or len(set(selected))!=len(selected) or set(selected)-periods.keys():
                raise ContractError('Selecciona periodos distintos del plan.')
            emitted=[]
            for quota in result['property_totals']:
                pid=int(quota['property_id'])
                for key in selected:
                    period=periods[key];coverage=self._require_coverage(conn,q.community_id,'ordinario',period['fecha_inicio'],period['fecha_fin'])
                    if coverage['registered_at']>known:raise ConflictError('La cobertura no estaba acreditada en esa fecha de conocimiento.')
                    base=0;materialized=0;adjustments=0;collected=0;references=[]
                    receipts=conn.execute('''SELECT * FROM erp_recibos WHERE id_comunidad=? AND id_propiedad=?
                        AND period_from=? AND period_until=? AND issued_on<=? AND registered_at<=? AND concept_key IN ('ordinario','regularizacion')''',
                        (q.community_id,pid,period['fecha_inicio'],period['fecha_fin'],effective,known))
                    for r in receipts:
                        balance=receipt_balance(conn,q.community_id,r['id'],effective,known)
                        reductions=int(balance['reduced_cents']);collected+=int(balance['paid_cents'])
                        if r['source_type']=='regularization':
                            link=conn.execute('''SELECT m.*,g.id_plan_esperado FROM erp_regularizaciones_materializadas m
                                JOIN erp_regularizacion_lineas l ON l.id_comunidad=m.id_comunidad AND l.id_linea=m.line_id
                                JOIN erp_regularizaciones g ON g.id_comunidad=l.id_comunidad AND g.id_regularizacion=l.id_regularizacion
                                WHERE m.id_comunidad=? AND m.receipt_id=?''',(q.community_id,r['id'])).fetchone()
                            if not link:raise ConflictError('Ajuste materializado sin correspondencia acreditada.')
                            if link['id_plan_esperado']==plan['id_plan']:
                                materialized+=r['amount_cents'];base-=reductions
                            else:base+=r['amount_cents']-reductions
                        else:base+=r['amount_cents']-reductions
                        references.append({'receipt_id':r['id'],'net_cents':str(r['amount_cents']-reductions),'type':r['source_type']})
                    prior=conn.execute('''SELECT l.*,m.credit_id,m.amount_cents AS materialized_cents,m.effective_on,m.registered_at AS materialized_at
                        FROM erp_regularizacion_lineas l JOIN erp_regularizaciones g ON g.id_comunidad=l.id_comunidad AND g.id_regularizacion=l.id_regularizacion
                        LEFT JOIN erp_regularizaciones_materializadas m ON m.id_comunidad=l.id_comunidad AND m.line_id=l.id_linea
                        WHERE g.id_comunidad=? AND g.id_plan_esperado=? AND g.estado='aprobada' AND l.id_propiedad=? AND l.periodo_clave=?''',
                        (q.community_id,plan['id_plan'],pid,key))
                    for r in prior:
                        adjustments+=r['diferencia_centimos']
                        if r['credit_id'] and r['effective_on']<=effective and r['materialized_at']<=known:materialized+=r['materialized_cents']
                    total=base+materialized;reserved=adjustments-materialized
                    if base+adjustments!=total+reserved:raise ContractError('La cobertura de regularizaciones no es disjunta.')
                    emitted.append({'property_id':pid,'period_key':key,'net_emitted_cents':str(cents(base)),
                        'collected_cents':str(cents(collected)),'approved_adjustments_cents':str(cents(adjustments)),
                        'materialized_adjustments_cents':str(cents(materialized)),'reserved_adjustments_cents':str(cents(reserved)),
                        'total_net_emitted_cents':str(cents(total)),'system':'erp3','reference':f'{pid}:{key}',
                        'coverage_id':coverage['id'],'references':references,'confirmed':True})
            return {'effective_at':effective,'known_at':known,'emitted':emitted,'manual_collections_not_used':True}
        return self._read(session,query,op)
