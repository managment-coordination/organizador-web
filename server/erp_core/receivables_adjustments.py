"""Reviewed corrective operations sharing the ERP 3 transaction boundary."""

import json
from .budget_service import BudgetService

from .contracts import canonical_json
from .errors import ConflictError, ContractError
from .receivables_contracts import cents, day, fingerprint, identity, known_time, require_fields, text
from .receivables_projection import collection_balance, credit_balance, receipt_balance, validate_timeline, responsibility_balance, original_responsibility, subject_group
from .receivables_projection import collection_payer


class AdjustmentOperations:
    def _choose_responsibility(self,conn,community,rid,effective,amount,selection=None,releases=()):
        buckets=responsibility_balance(conn,community,rid,effective)
        for release in releases:
            group=release['responsibility_subjects']
            bucket=next((b for b in buckets if b['subjects']==group),None)
            if bucket is None:
                bucket={'subjects':group,'pending_cents':'0'};buckets.append(bucket)
            bucket['pending_cents']=str(int(bucket['pending_cents'])+int(release['amount_cents']))
        if selection is None:
            candidates=[b for b in buckets if int(b['pending_cents'])>0]
            if len(candidates)!=1:raise ConflictError('Indica a que obligado o conjunto de obligados se aplica el importe.')
            group=candidates[0]['subjects']
        else:
            if not isinstance(selection,list):raise ContractError('Seleccion de obligados no valida.')
            group=subject_group([self._subject(conn,community,s) for s in selection])
        found=next((b for b in buckets if b['subjects']==group),None)
        if not found or int(found['pending_cents'])<amount:raise ConflictError('El importe supera el pendiente de los obligados seleccionados.')
        return group

    @staticmethod
    def _reversal_lines(conn, community, rows, effective):
        if not isinstance(rows, list) or len(rows)>500:
            raise ContractError('Selecciona hasta 500 imputaciones.')
        result=[]; seen=set()
        for item in rows:
            require_fields(item, ('allocation_id','amount_cents'))
            aid=identity(item['allocation_id']); amount=cents(item['amount_cents'],positive=True)
            row=conn.execute('SELECT * FROM erp_imputaciones WHERE id_comunidad=? AND id=?',(community,aid)).fetchone()
            if not row or row['reverses_id'] or row['effective_on']>effective or aid in seen:
                raise ContractError('Imputacion incompatible con la reversion.')
            seen.add(aid)
            used=sum(r[0] for r in conn.execute('SELECT amount_cents FROM erp_imputaciones WHERE id_comunidad=? AND reverses_id=?',(community,aid)))
            if amount>row['amount_cents']-used:
                raise ConflictError('La imputacion ya fue revertida total o parcialmente.')
            receipt=conn.execute('SELECT version FROM erp_recibos WHERE id_comunidad=? AND id=?',(community,row['receipt_id'])).fetchone()
            collection=conn.execute('SELECT version FROM erp_cobros WHERE id_comunidad=? AND id=?',(community,row['collection_id'])).fetchone()
            result.append({'allocation_id':aid,'receipt_id':row['receipt_id'],'collection_id':row['collection_id'],
                           'receipt_version':receipt[0],'collection_version':collection[0],'amount_cents':str(amount),
                           'responsibility_subjects':json.loads(row['responsibility_json']) if row['responsibility_json'] else original_responsibility(conn,community,row['receipt_id'])})
        return result

    @staticmethod
    def _insert_reversal(conn, community, event, now, effective, line):
        conn.execute('''INSERT INTO erp_imputaciones
            (id_comunidad,collection_id,receipt_id,event_id,reverses_id,amount_cents,effective_on,registered_at,responsibility_json)
            VALUES (?,?,?,?,?,?,?,?,?)''',(community,line['collection_id'],line['receipt_id'],event,
                                      line['allocation_id'],int(line['amount_cents']),effective,now,canonical_json(line['responsibility_subjects'])))

    def _review_operation(self, session, env, operation, capability, build, apply=None):
        def op(conn,actor,e):
            if not e.reason:raise ContractError('Indica el motivo de la operacion.')
            if apply is None:
                preview=build(conn,e.community_id,e.payload)
                lot=conn.execute('''INSERT INTO erp_emisiones_lotes
                    (id_comunidad,operation,state,payload_json,preview_json,preview_hash,registered_at,actor_id)
                    VALUES (?,?,'draft',?,?,?,?,?)''',(e.community_id,operation,canonical_json(e.payload),
                        canonical_json(preview),fingerprint(preview),known_time(None),actor.user_id)).lastrowid
                return {'id':lot,'version':1,'preview':preview}
            require_fields(e.payload,('proposal_id',))
            lot=self._entity(conn,'erp_emisiones_lotes',e.community_id,e.payload['proposal_id'])
            self._version(lot,e.expected_version)
            if lot['state']!='draft' or lot['operation']!=operation:raise ConflictError('Propuesta incompatible.')
            preview=build(conn,e.community_id,json.loads(lot['payload_json']))
            if fingerprint(preview)!=lot['preview_hash']:
                raise ConflictError('Los saldos o la configuracion cambiaron. Revisa una nueva propuesta.')
            result=apply(conn,actor,e,preview)
            result.update(id=lot['id'],version=lot['version']+1,preview=preview)
            conn.execute("UPDATE erp_emisiones_lotes SET state='confirmed',version=version+1,confirmed_at=?,result_json=? WHERE id=?",
                         (known_time(None),canonical_json(result),lot['id']))
            return result
        return self._write(session,env,op,capability)

    def _reverse_preview(self,conn,community,p):
        require_fields(p,('effective_on','reversals'))
        effective=self._date_open(conn,community,p['effective_on'])
        lines=self._reversal_lines(conn,community,p['reversals'],effective)
        if not lines:raise ContractError('Selecciona alguna imputacion para liberar.')
        return {'effective_on':effective,'reversals':lines,'released_cents':str(cents(sum(int(x['amount_cents']) for x in lines)))}

    def _reverse_apply(self,conn,actor,e,p):
        event,now=self._event(conn,actor,e,'erp3.allocation.reversed',p['effective_on'],p)
        for line in p['reversals']:self._insert_reversal(conn,e.community_id,event,now,p['effective_on'],line)
        receipts={x['receipt_id'] for x in p['reversals']}; collections={x['collection_id'] for x in p['reversals']}
        self._bump_balances(conn,e.community_id,receipts,collections)
        return {'event_ids':[event]}

    @staticmethod
    def _bump_balances(conn,community,receipts=(),collections=(),credits=()):
        for table,ids in (('erp_recibos',receipts),('erp_cobros',collections)):
            for rid in set(ids):conn.execute(f'UPDATE {table} SET version=version+1 WHERE id_comunidad=? AND id=?',(community,rid))
        validate_timeline(conn,community,receipts,collections,credits)

    def allocation_reverse_preview(self,s,e):
        return self._review_operation(s,e,'reverse_allocation','reverse_allocation',self._reverse_preview)

    def allocation_reverse_confirm(self,s,e):
        return self._review_operation(s,e,'reverse_allocation','reverse_allocation',self._reverse_preview,self._reverse_apply)

    def _refund_preview(self,conn,community,p):
        require_fields(p,('effective_on','amount_cents','beneficiary'),('collection_id','credit_id'))
        if bool(p.get('collection_id'))==bool(p.get('credit_id')):raise ContractError('Selecciona un unico origen del reintegro.')
        effective=self._date_open(conn,community,p['effective_on']); amount=cents(p['amount_cents'],positive=True)
        beneficiary=self._subject(conn,community,p['beneficiary'])
        is_cash=bool(p.get('collection_id')); key='collection_id' if is_cash else 'credit_id'
        row=self._entity(conn,'erp_cobros' if is_cash else 'erp_creditos',community,p[key])
        balance=(collection_balance if is_cash else credit_balance)(conn,community,row['id'],effective)
        if amount>int(balance['available_cents']):raise ConflictError('El reintegro supera el saldo disponible.')
        payer=collection_payer(conn,community,row['id'],effective) if is_cash else None
        owner=payer['payer_owner_id'] if is_cash else row['owner_id']; person=payer['payer_person_id'] if is_cash else row['person_id']
        if (owner and (beneficiary['type']!='owner' or beneficiary['id']!=owner)) or (person and (beneficiary['type']!='person' or beneficiary['id']!=person)):
            raise ContractError('El beneficiario no coincide con el titular acreditado del saldo.')
        if not owner and not person:raise ConflictError('Acredita el titular del cobro antes de reintegrarlo.')
        return {key:row['id'],'source_version':row.get('version'),'effective_on':effective,'amount_cents':str(amount),
                'beneficiary':beneficiary,'available_before_cents':balance['available_cents'],
                'available_after_cents':str(int(balance['available_cents'])-amount)}

    def _refund_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        event,now=self._event(conn,actor,e,'erp3.balance.refunded',p['effective_on'],p)
        conn.execute('''INSERT INTO erp_reintegros (id_comunidad,event_id,collection_id,credit_id,amount_cents,effective_on,registered_at)
            VALUES (?,?,?,?,?,?,?)''',(e.community_id,event,p.get('collection_id'),p.get('credit_id'),int(p['amount_cents']),p['effective_on'],now))
        self._bump_balances(conn,e.community_id,collections=[p['collection_id']] if p.get('collection_id') else [],credits=[p['credit_id']] if p.get('credit_id') else [])
        return {'event_ids':[event]}

    def refund_preview(self,s,e):return self._review_operation(s,e,'refund','refund',self._refund_preview)
    def refund_confirm(self,s,e):return self._review_operation(s,e,'refund','refund',self._refund_preview,self._refund_apply)

    def _credit_apply_preview(self,conn,community,p):
        require_fields(p,('credit_id','receipt_id','amount_cents','effective_on'),('responsibility_subjects',))
        effective=self._date_open(conn,community,p['effective_on']); amount=cents(p['amount_cents'],positive=True)
        credit=self._entity(conn,'erp_creditos',community,p['credit_id']); receipt=self._entity(conn,'erp_recibos',community,p['receipt_id'])
        cb=credit_balance(conn,community,credit['id'],effective); rb=receipt_balance(conn,community,receipt['id'],effective)
        if amount>min(int(cb['available_cents']),int(rb['pending_cents'])):raise ConflictError('La compensacion supera el credito o el pendiente.')
        return {'credit_id':credit['id'],'receipt_id':receipt['id'],'receipt_version':receipt['version'],
                'amount_cents':str(amount),'effective_on':effective,'available_before_cents':cb['available_cents'],
                'available_after_cents':str(int(cb['available_cents'])-amount),'pending_before_cents':rb['pending_cents'],
                'pending_after_cents':str(int(rb['pending_cents'])-amount),
                'responsibility_subjects':self._choose_responsibility(conn,community,receipt['id'],effective,amount,p.get('responsibility_subjects'))}

    def _credit_apply_confirm(self,conn,actor,e,p):
        event,now=self._event(conn,actor,e,'erp3.credit.applied',p['effective_on'],p)
        conn.execute('''INSERT INTO erp_credito_aplicaciones
            (id_comunidad,credit_id,receipt_id,event_id,amount_cents,effective_on,registered_at,responsibility_json) VALUES (?,?,?,?,?,?,?,?)''',
            (e.community_id,p['credit_id'],p['receipt_id'],event,int(p['amount_cents']),p['effective_on'],now,canonical_json(p['responsibility_subjects'])))
        self._bump_balances(conn,e.community_id,[p['receipt_id']],credits=[p['credit_id']])
        return {'event_ids':[event]}

    def credit_apply_preview(self,s,e):return self._review_operation(s,e,'credit_apply','allocate',self._credit_apply_preview)
    def credit_apply_confirm(self,s,e):return self._review_operation(s,e,'credit_apply','allocate',self._credit_apply_preview,self._credit_apply_confirm)

    def policy_save(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('effective_from','return_fee_mode'),('fixed_cents',))
            if p['return_fee_mode'] not in ('none','actual','fixed'):raise ContractError('Politica de gastos no valida.')
            amount=cents(p.get('fixed_cents','0'),nonnegative=True)
            if p['return_fee_mode']!='fixed' and amount:raise ContractError('El importe fijo solo corresponde a la politica fija.')
            version=conn.execute('SELECT COALESCE(MAX(version),0) FROM erp_recibo_politicas WHERE id_comunidad=?',(e.community_id,)).fetchone()[0]
            if e.expected_version!=version:raise ConflictError('La politica ha cambiado.')
            rid=conn.execute('''INSERT INTO erp_recibo_politicas
                (id_comunidad,version,effective_from,return_fee_mode,fixed_cents,registered_at,actor_id) VALUES (?,?,?,?,?,?,?)''',
                (e.community_id,version+1,day(p['effective_from']),p['return_fee_mode'],amount,known_time(None),actor.user_id)).lastrowid
            return {'id':rid,'version':version+1,'policy':p}
        return self._write(session,env,op,'configure')

    def _transfer_preview(self,conn,community,p):
        require_fields(p,('effective_on','lines','authorization_reference'))
        effective=self._date_open(conn,community,p['effective_on'])
        authorization=text(p['authorization_reference'],'Autorizacion',maximum=1000)
        if not isinstance(p['lines'],list) or not 1<=len(p['lines'])<=500:raise ContractError('Revisa entre 1 y 500 recibos.')
        result=[];seen=set()
        for item in p['lines']:
            require_fields(item,('receipt_id','amount_cents','source_subjects','target_subjects'))
            receipt=self._entity(conn,'erp_recibos',community,item['receipt_id']);amount=cents(item['amount_cents'],positive=True)
            if receipt['id'] in seen:raise ContractError('Selecciona una sola reasignacion por recibo y propuesta.')
            seen.add(receipt['id'])
            for field in ('source_subjects','target_subjects'):
                if not isinstance(item[field],list) or not 1<=len(item[field])<=50:raise ContractError('Identifica los obligados de origen y destino.')
            source=subject_group([self._subject(conn,community,s) for s in item['source_subjects']])
            target=subject_group([self._subject(conn,community,s) for s in item['target_subjects']])
            if len({(s['type'],s['id']) for s in source})!=len(source) or len({(s['type'],s['id']) for s in target})!=len(target):
                raise ContractError('Obligado duplicado.')
            if source==target:raise ContractError('El origen y destino son iguales.')
            before=responsibility_balance(conn,community,receipt['id'],effective)
            bucket=next((b for b in before if b['subjects']==source),None)
            if not bucket or amount>int(bucket['pending_cents']):raise ConflictError('La reasignacion supera la deuda atribuida al origen.')
            after=[dict(b) for b in before]
            src=next(b for b in after if b['subjects']==source);src['pending_cents']=str(int(src['pending_cents'])-amount)
            dst=next((b for b in after if b['subjects']==target),None)
            if dst is None:
                dst={'subjects':target,'pending_cents':'0','shared':len(target)>1,'unattributed':False};after.append(dst)
            dst['pending_cents']=str(cents(int(dst['pending_cents'])+amount))
            result.append({'receipt_id':receipt['id'],'receipt_version':receipt['version'],'amount_cents':str(amount),
                'source_subjects':source,'target_subjects':target,'before':before,'after':after,
                'source_identity_snapshot':[self._subject(conn,community,s) for s in source],
                'target_identity_snapshot':[self._subject(conn,community,s) for s in target],
                'community_delta_cents':'0','cash_delta_cents':'0','accounting_status':'pendiente_ERP6'})
        return {'effective_on':effective,'authorization_reference':authorization,'lines':result}

    def _transfer_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        events=[];ids=[]
        for index,line in enumerate(p['lines']):
            event,now=self._event(conn,actor,e,'erp3.responsibility.transferred',p['effective_on'],
                {**line,'authorization_reference':p['authorization_reference'],'authorized_by':actor.user_id},str(index))
            rid=conn.execute('''INSERT INTO erp_reasignaciones_obligacion
                (id_comunidad,receipt_id,event_id,amount_cents,source_json,target_json,economic_impact_json,effective_on,registered_at)
                VALUES (?,?,?,?,?,?,?,?,?)''',(e.community_id,line['receipt_id'],event,int(line['amount_cents']),
                    canonical_json(line['source_subjects']),canonical_json(line['target_subjects']),canonical_json(line),p['effective_on'],now)).lastrowid
            events.append(event);ids.append(rid)
        self._bump_balances(conn,e.community_id,[x['receipt_id'] for x in p['lines']])
        return {'event_ids':events,'transfer_ids':ids,'original_subjects_changed':False,'community_delta_cents':'0'}

    def responsibility_transfer_preview(self,s,e):
        return self._review_operation(s,e,'responsibility_transfer','transfer_responsibility',self._transfer_preview)

    def responsibility_transfer_confirm(self,s,e):
        return self._review_operation(s,e,'responsibility_transfer','transfer_responsibility',self._transfer_preview,self._transfer_apply)

    def _fee_preview(self,conn,community,p):
        require_fields(p,('return_id','receipt_id','effective_on','cost_cents','cost_reference'),('due_on','obligated_subjects','exercise_id'))
        effective=self._date_open(conn,community,p['effective_on']); cost=cents(p['cost_cents'],nonnegative=True)
        returned=self._entity(conn,'erp_devoluciones',community,p['return_id'])
        receipt=self._entity(conn,'erp_recibos',community,p['receipt_id'])
        if returned['effective_on']>effective:raise ContractError('El gasto no puede preceder a la devolucion.')
        if receipt['id'] not in {x['receipt_id'] for x in json.loads(returned['details_json'])}:
            raise ContractError('El recibo no esta afectado por la devolucion seleccionada.')
        policy=conn.execute('''SELECT * FROM erp_recibo_politicas WHERE id_comunidad=? AND effective_from<=?
            ORDER BY effective_from DESC,version DESC LIMIT 1''',(community,effective)).fetchone()
        if not policy:raise ConflictError('Configura previamente si se repercuten los gastos de devolucion.')
        amount=cost if policy['return_fee_mode']=='actual' else policy['fixed_cents'] if policy['return_fee_mode']=='fixed' else 0
        reference=text(p['cost_reference'],'Referencia del coste',maximum=200)
        existing=conn.execute("SELECT 1 FROM erp_hechos_economicos WHERE id_comunidad=? AND event_type='erp3.return_fee.recorded' AND json_extract(payload_json,'$.cost_reference')=?",(community,reference)).fetchone()
        if existing:raise ConflictError('Este coste ya fue registrado.')
        subjects=[json.loads(r[0]) for r in conn.execute("SELECT snapshot_json FROM erp_recibo_sujetos WHERE id_comunidad=? AND receipt_id=? AND role='obligated'",(community,receipt['id']))]
        if p.get('obligated_subjects') is not None:
            if not isinstance(p['obligated_subjects'],list) or not p['obligated_subjects']:raise ContractError('Identifica los obligados del gasto.')
            subjects=[self._subject(conn,community,s) for s in p['obligated_subjects']]
        elif amount and conn.execute('SELECT 1 FROM erp_reasignaciones_obligacion WHERE id_comunidad=? AND receipt_id=?',(community,receipt['id'])).fetchone():
            raise ConflictError('Existe una reasignacion de responsabilidad; acredita quien asume este gasto independiente.')
        if amount and not subjects:raise ConflictError('El recibo carece de obligado acreditado para repercutir el gasto.')
        roles={};exercise_id=None
        if amount:
            billing=BudgetService(self.database_path)._billing_at(conn,community,receipt['id_propiedad'],effective)
            for role in ('recipient','payer'):
                value=billing[role]
                if not value:raise ConflictError('Confirma el destinatario y pagador vigentes para emitir el nuevo gasto.')
                roles[role]=self._subject(conn,community,{'type':'owner','id':value['id_propietario']} if value.get('id_propietario') else {'type':'person','id':value['id_persona_cobro']})
            exercises=list(conn.execute("SELECT id_ejercicio FROM erp_ejercicios WHERE id_comunidad=? AND fecha_inicio<=? AND fecha_fin>=? AND estado='abierto'",(community,effective,effective)))
            if p.get('exercise_id'):
                exercise_id=identity(p['exercise_id'])
                if exercise_id not in {r[0] for r in exercises}:raise ContractError('El ejercicio no esta abierto en la fecha del gasto.')
            elif len(exercises)==1:exercise_id=exercises[0][0]
            else:raise ConflictError('Selecciona el ejercicio abierto correspondiente al nuevo gasto.')
        return {'return_id':returned['id'],'receipt_id':receipt['id'],'receipt_version':receipt['version'],
                'policy':dict(policy),'cost_cents':str(cost),'amount_cents':str(amount),'cost_reference':reference,
                'effective_on':effective,'due_on':day(p['due_on']) if p.get('due_on') else None,'obligated':subjects,'exercise_id':exercise_id,**roles}

    def _fee_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        event,now=self._event(conn,actor,e,'erp3.return_fee.recorded',p['effective_on'],p)
        rid=None
        if int(p['amount_cents']):
            original=self._entity(conn,'erp_recibos',e.community_id,p['receipt_id'])
            serial=conn.execute('SELECT COUNT(*)+1 FROM erp_recibos WHERE id_comunidad=?',(e.community_id,)).fetchone()[0]
            source='return-cost:'+p['cost_reference']
            rid=conn.execute('''INSERT INTO erp_recibos
                (id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,
                 source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id)
                VALUES (?,?,?,?,'gasto_devolucion','Gastos de devolucion',?,?,?,'return_fee',?,?,?,?,?,?,?,?,?,?)''',
                (e.community_id,original['id_propiedad'],p['exercise_id'],f'R-{serial:08d}',original['period_key'],
                 original['period_from'],original['period_until'],source,source,int(p['amount_cents']),original['currency'],
                 p['effective_on'],p['due_on'],canonical_json(p),fingerprint(p),now,actor.user_id)).lastrowid
            for role,subjects in [('obligated',p['obligated']),('recipient',[p['recipient']]),('payer',[p['payer']])]:
                for s in subjects:conn.execute('INSERT INTO erp_recibo_sujetos (id_comunidad,receipt_id,role,owner_id,person_id,snapshot_json) VALUES (?,?,?,?,?,?)',
                    (e.community_id,rid,role,s['id'] if s['type']=='owner' else None,s['id'] if s['type']=='person' else None,canonical_json(s)))
            conn.execute('''INSERT INTO erp_recibo_detalles (id_comunidad,receipt_id,line_key,amount_cents,snapshot_json)
                VALUES (?,?,?,?,?)''',(e.community_id,rid,source,int(p['amount_cents']),canonical_json(p)))
        return {'event_ids':[event],'receipt_id':rid,'community_cost_cents':p['cost_cents'] if not rid else '0'}

    def return_fee_preview(self,s,e):return self._review_operation(s,e,'return_fee','adjust',self._fee_preview)
    def return_fee_confirm(self,s,e):return self._review_operation(s,e,'return_fee','adjust',self._fee_preview,self._fee_apply)

    def claim_record(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('receipt_id','effective_on','classification'))
            if p['classification'] not in ('en_gestion','reclamado','suspendido','cerrado','en_disputa'):
                raise ContractError('Clasificacion de gestion no valida.')
            receipt=self._entity(conn,'erp_recibos',e.community_id,p['receipt_id']);self._version(receipt,e.expected_version)
            effective=self._date_open(conn,e.community_id,p['effective_on']);receipt_balance(conn,e.community_id,receipt['id'],effective)
            if not e.reason:raise ContractError('Indica el motivo o seguimiento de la reclamacion.')
            event,now=self._event(conn,actor,e,'erp3.receipt.management_recorded',effective,p)
            rid=conn.execute('''INSERT INTO erp_recibo_gestion_eventos
                (id_comunidad,receipt_id,event_id,classification,effective_on,registered_at) VALUES (?,?,?,?,?,?)''',
                (e.community_id,receipt['id'],event,p['classification'],effective,now)).lastrowid
            self._bump_balances(conn,e.community_id,[receipt['id']])
            return {'id':rid,'event_ids':[event],'balance_changed':False}
        return self._write(session,env,op,'claim')

    def proposal_discard(self,session,env):
        def op(conn,actor,e):
            require_fields(e.payload,('proposal_id',))
            row=self._entity(conn,'erp_emisiones_lotes',e.community_id,e.payload['proposal_id']);self._version(row,e.expected_version)
            if row['state']!='draft':raise ConflictError('Solo pueden descartarse propuestas sin confirmar.')
            if row['actor_id']!=actor.user_id:raise PermissionError('Solo el autor puede descartar su propuesta.')
            conn.execute("UPDATE erp_emisiones_lotes SET state='discarded',version=version+1 WHERE id=?",(row['id'],))
            return {'id':row['id'],'version':row['version']+1,'state':'discarded','event_ids':[]}
        return self._write(session,env,op,'read')
