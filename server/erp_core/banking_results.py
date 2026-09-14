"""Staged bank evidence and atomic, explicitly reviewed ERP 3 effects."""

import base64
from dataclasses import replace
import json

from .banking_adapter import parse_status
from .contracts import CommandEnvelope, canonical_json
from .errors import ConflictError, ContractError, NotFoundError
from .receivables_contracts import cents, day, identity, require_fields, text
from .receivables_projection import receipt_balance, collection_balance
from .receivables_service import ReceivablesService


KINDS = {'technical','pending','rejected','settlement','returned','cancelled'}


class BankingResults:
    @staticmethod
    def _line_status(conn,community,line_id):
        rows=list(conn.execute('''SELECT kind FROM erp_banca_linea_eventos e WHERE id_comunidad=? AND line_id=?
            AND NOT EXISTS (SELECT 1 FROM erp_banca_control_eventos c WHERE c.id_comunidad=e.id_comunidad
                AND c.conflict_event_id=e.id AND c.kind='conflict_reviewed') ORDER BY effective_on DESC,id DESC''',
                               (community,line_id)))
        if any(r['kind']=='conflict' for r in rows):
            return 'conflict'
        economic=next((r['kind'] for r in rows if r['kind'] in ('settlement','returned')),None)
        terminal=economic or next((r['kind'] for r in rows if r['kind'] in ('cancelled','rejected')),None)
        if terminal:return terminal
        if conn.execute("SELECT 1 FROM erp_banca_control_eventos WHERE id_comunidad=? AND line_id=? AND kind='terminal_history_gap'",(community,line_id)).fetchone():
            return 'cancelled'
        cancelled=conn.execute('''SELECT 1 FROM erp_remesa_lineas l JOIN erp_remesa_revisiones v ON v.id=l.revision_id
            JOIN erp_remesas r ON r.id=v.remittance_id WHERE l.id_comunidad=? AND l.id=? AND r.state='cancelada' ''',(community,line_id)).fetchone()
        return 'cancelled' if cancelled else 'pending'

    def _stage_status_rows(self,conn,community,data):
        parsed=parse_status(data)
        file=conn.execute('SELECT * FROM erp_remesa_ficheros WHERE id_comunidad=? AND message_id=?',
                          (community,parsed['original_message_id'])).fetchone()
        if not file:
            return [{'kind':'pending','unresolved_reference':parsed['original_message_id'],'source_entries':parsed['entries']}]
        meta=self.vault.get(conn,community,file['secret_id'],'remittance-file')['metadata']
        lines=list(conn.execute('SELECT id,attempt_key FROM erp_remesa_lineas WHERE id_comunidad=? AND revision_id=?',(community,file['revision_id'])))
        groups={g['id']:set(g['attempt_keys']) for g in meta['payment_groups']}
        entries={row['attempt_key']:[] for row in lines}
        unmatched=[]
        for entry in parsed['entries']:
            keys=set(entries) if entry['scope']=='file' else groups.get(entry['reference'],set()) if entry['scope']=='group' else {entry['reference']}&entries.keys()
            if not keys:unmatched.append({'kind':'pending','unresolved_reference':entry['reference'],'source_entries':[entry]})
            for key in keys:entries[key].append(entry)
        result=[]
        for key,matches in entries.items():
            if not matches:continue
            specific=sorted(matches,key=lambda x: {'file':0,'group':1,'line':2}[x['scope']],reverse=True)[0]
            # A partial file can contain a rejected line, but peers cannot disagree.
            peers=[e for e in matches if e['scope']==specific['scope']]
            contradiction=(len({e['type'] for e in peers})>1 or
                (any(e['type']=='rejected' for e in matches) and any(e['type']=='technical' for e in matches)))
            result.append({'attempt_key':key,'kind':'pending' if contradiction else specific['type'],
                           'reason_code':specific.get('reason_code'),'source_entries':matches,
                           'contradictory':contradiction,'effective_on':None})
        return result+unmatched

    def results_import(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('format','data','effective_on'))
            effective=day(p['effective_on'])
            if effective>now[:10]:raise ContractError('El resultado bancario no puede ser futuro.')
            if p['format']=='pain002':
                if not isinstance(p['data'],str) or len(p['data'])>24*1024*1024:raise ContractError('Archivo de resultado demasiado grande.')
                try:raw=base64.b64decode(p['data'],validate=True)
                except Exception:raise ContractError('Archivo bancario no valido.') from None
                items=self._stage_status_rows(conn,e.community_id,raw)
            elif p['format']=='manual':
                items=p['data']
                if not isinstance(items,list) or not 1<=len(items)<=1000:raise ContractError('Indica entre 1 y 1000 resultados.')
                items=[dict(require_fields(x,('attempt_key','kind'),('effective_on','amount_cents','currency','bank_event_id',
                    'psp','service','reason_code','funds_evidence','terminal','notes'))) for x in items]
            else:raise ContractError('Formato no admitido. Conserva la evidencia para revision manual.')
            digests=self.vault.fingerprints(e.community_id,'bank-result-source',p)
            for digest in digests.values():
                old=conn.execute('SELECT id,version,state FROM erp_resultados_bancarios WHERE id_comunidad=? AND source_hash=?',(e.community_id,digest)).fetchone()
                if old:return dict(old)
            secret=self.vault.put(conn,e.community_id,'bank-result-source',{'source':p,**self._evidence_value(e)},now)
            rid=conn.execute('''INSERT INTO erp_resultados_bancarios
                (id_comunidad,source_hash,profile_id,secret_id,state,registered_at,actor_id) VALUES (?,?,?,?,'pendiente',?,?)''',
                (e.community_id,digests[self.vault.active_index],p['format'],secret,now,actor.user_id)).lastrowid
            missing=0
            for item in items:
                if item['kind'] not in KINDS:raise ContractError('Tipo de resultado desconocido. Registralo como pendiente.')
                if item.get('amount_cents') is not None:
                    item['amount_cents']=str(cents(item['amount_cents'],positive=True))
                item['effective_on']=day(item.get('effective_on') or effective)
                if item['effective_on']>now[:10]:raise ContractError('Fecha bancaria futura no admitida.')
                line=conn.execute('SELECT id FROM erp_remesa_lineas WHERE id_comunidad=? AND attempt_key=?',
                                  (e.community_id,item.get('attempt_key'))).fetchone()
                if not line:missing+=1
                secret=self.vault.put(conn,e.community_id,'bank-result-line',item,now)
                conn.execute('''INSERT INTO erp_resultado_lineas (id_comunidad,result_id,line_id,secret_id,state,registered_at,actor_id)
                    VALUES (?,?,?,?,'pendiente',?,?)''',(e.community_id,rid,line['id'] if line else None,secret,now,actor.user_id))
            return {'id':rid,'version':1,'state':'pendiente','line_count':len(items),'unmatched':missing}
        return self._write(session,env,'results',op)

    def _bank_identity(self,community,treasury,data,line_id):
        require_fields(data,('kind','effective_on','amount_cents','currency','bank_event_id','psp','service'),
            ('attempt_key','reason_code','funds_evidence','terminal','notes'))
        if data['currency']!='EUR':raise ContractError('El resultado no acredita un importe en EUR.')
        identity_value={'treasury_id':treasury,'kind':data['kind'],
            'event_id':text(data['bank_event_id'],'Identificador bancario',maximum=200),
            'psp':text(data['psp'],'Banco emisor del resultado',maximum=100),
            'service':text(data['service'],'Servicio bancario',maximum=80)}
        canonical={'identity':identity_value,'line_id':line_id,'amount_cents':str(cents(data['amount_cents'],positive=True)),
                   'currency':'EUR','effective_on':day(data['effective_on'])}
        return identity_value,canonical

    def results_resolve(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('result_line_id','line_id','details'))
            row=conn.execute('SELECT * FROM erp_resultado_lineas WHERE id_comunidad=? AND id=?',
                (e.community_id,identity(p['result_line_id']))).fetchone()
            if not row:raise NotFoundError('Linea de resultado no disponible.')
            self._version(row,e.expected_version)
            if row['state']=='confirmada':raise ConflictError('Un resultado confirmado no se reinterpreta. Conserva un nuevo hecho documentado.')
            line=self._entity(conn,'erp_remesa_lineas',e.community_id,p['line_id'])
            details=dict(require_fields(p['details'],('kind','effective_on'),
                ('amount_cents','currency','bank_event_id','psp','service','reason_code','funds_evidence','terminal','notes')))
            if details['kind'] not in KINDS-{'pending'}:raise ContractError('Selecciona un resultado acreditado.')
            details['effective_on']=day(details['effective_on'])
            if details['effective_on']>now[:10]:raise ContractError('El resultado no puede ser futuro.')
            if details.get('amount_cents') is not None:details['amount_cents']=str(cents(details['amount_cents'],positive=True))
            details['attempt_key']=line['attempt_key']
            original=self.vault.get(conn,e.community_id,row['secret_id'],'bank-result-line')
            if row['line_id'] and row['line_id']!=line['id'] and not original.get('contradictory'):
                raise ConflictError('La referencia ya identifica otro intento. No se sustituye por similitud; conserva evidencia adicional.')
            # The original file and every previous secret remain immutable and recoverable.
            history=self.vault.put(conn,e.community_id,'bank-result-resolution',{
                'previous_secret_id':row['secret_id'],'line_id':line['id'],'details':details,**self._evidence_value(e)},now)
            secret=self.vault.put(conn,e.community_id,'bank-result-line',details,now)
            conn.execute("UPDATE erp_resultado_lineas SET line_id=?,secret_id=?,state='pendiente',version=version+1 WHERE id_comunidad=? AND id=?",
                (line['id'],secret,e.community_id,row['id']))
            conn.execute("UPDATE erp_resultados_bancarios SET state='pendiente',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,row['result_id']))
            return {'id':row['id'],'result_id':row['result_id'],'version':row['version']+1,'resolution_id':history,
                'state':'pendiente','requires_economic_confirmation':True}
        return self._write(session,env,'results',op)

    def _existing_bank_operation(self,conn,community,value,canonical):
        for key,digest in self.vault.fingerprints(community,'bank-operation-identity',value).items():
            old=conn.execute('''SELECT o.* FROM erp_banco_identidades i JOIN erp_banco_operaciones o ON o.id_comunidad=i.id_comunidad AND o.id=i.operation_id
                WHERE i.id_comunidad=? AND i.key_id=? AND i.digest=?''',(community,key,digest)).fetchone()
            if old:
                frozen=self.vault.get(conn,community,old['secret_id'],'bank-operation')
                if frozen['canonical']!=canonical:raise ConflictError('La identidad bancaria ya existe con datos diferentes. Requiere revision.')
                return old
        return None

    def _result_plan(self,conn,session,community,p):
        require_fields(p,('result_id','decisions'),('preview_hash',))
        result=self._entity(conn,'erp_resultados_bancarios',community,p['result_id'])
        if not isinstance(p['decisions'],list) or not 1<=len(p['decisions'])<=200:raise ContractError('Revisa entre 1 y 200 lineas por confirmacion.')
        planned=[];seen=set()
        for decision in p['decisions']:
            require_fields(decision,('result_line_id','action'),('allocate_cents','collection_id','return_spec','return_id'))
            row=conn.execute('SELECT * FROM erp_resultado_lineas WHERE id_comunidad=? AND id=? AND result_id=?',
                             (community,identity(decision['result_line_id']),result['id'])).fetchone()
            if not row or row['id'] in seen:raise ContractError('Linea no disponible o repetida.')
            seen.add(row['id'])
            if row['state']=='confirmada':raise ConflictError('La linea ya esta confirmada; consulta su historico.')
            if not row['line_id']:raise ConflictError('La evidencia no identifica una instruccion. No se aplica por similitud.')
            line=self._entity(conn,'erp_remesa_lineas',community,row['line_id'])
            revision=conn.execute('SELECT remittance_id FROM erp_remesa_revisiones WHERE id_comunidad=? AND id=?',(community,line['revision_id'])).fetchone()
            rem=self._entity(conn,'erp_remesas',community,revision['remittance_id'])
            creditor=self._entity(conn,'erp_acreedor_versiones',community,rem['creditor_id'])
            data=self.vault.get(conn,community,row['secret_id'],'bank-result-line')
            current=self._line_status(conn,community,line['id'])
            action=decision['action'];kind=data['kind']
            if kind=='pending' or data.get('contradictory'):raise ConflictError('El resultado sigue pendiente de aclaracion; no hay efecto que confirmar.')
            expected={'settlement':{'record_collection','link_collection'},'returned':{'return','link_return','terminal_without_collection'},
                      'technical':{'none'},'rejected':{'none'},'cancelled':{'none'}}[kind]
            if action not in expected:raise ContractError('La accion no corresponde al resultado bancario.')
            row_plan={'result_line_id':row['id'],'row_version':row['version'],'line_id':line['id'],
                      'receipt_id':line['receipt_id'],'kind':kind,'action':action,'effective_on':data['effective_on'],
                      'current':current,'remittance_version':rem['version'],'remittance_id':rem['id'],
                      'treasury_id':creditor['treasury_id'],'already_processed':False}
            if action=='terminal_without_collection':
                if data.get('terminal') is not True:
                    raise ContractError('Sin cobro identificado, acredita que el banco ha cerrado definitivamente la instruccion.')
                if conn.execute("SELECT 1 FROM erp_banca_linea_eventos WHERE id_comunidad=? AND line_id=? AND kind IN ('settlement','returned')",(community,line['id'])).fetchone():
                    raise ConflictError('Este intento tiene historia economica: utiliza la devolucion ERP 3.')
                row_plan['economic_history_pending']=True
            elif kind in ('settlement','returned'):
                ReceivablesService._session(conn,session,community,'record_collection' if kind=='settlement' else 'return_collection')
                ReceivablesService._date_open(conn,community,data['effective_on'])
                identity_value,canonical=self._bank_identity(community,creditor['treasury_id'],data,line['id'])
                old=self._existing_bank_operation(conn,community,identity_value,canonical)
                from .reconciliation_sources import bank_occurrence_facts
                occurrence=bank_occurrence_facts(conn,self.vault,community,identity_value,canonical) if not old else None
                if occurrence:
                    required='link_collection' if kind=='settlement' else 'link_return'
                    field='collection_id' if kind=='settlement' else 'return_id'
                    if action!=required or identity(decision.get(field))!=occurrence['fact_id']:
                        raise ConflictError('Esta ocurrencia ya tiene un hecho ERP 3. Enlaza el existente; no crees otro cobro/devolucion.')
                    row_plan['occurrence_movement_id']=occurrence['movement_id']
                row_plan.update(amount_cents=canonical['amount_cents'],identity=identity_value,canonical=canonical)
                if old:
                    row_plan.update(already_processed=True,operation_id=old['id'],collection_id=old['collection_id'],return_id=old['return_id'])
                elif kind=='settlement':
                    if data.get('funds_evidence') is not True:raise ContractError('Falta evidencia de fondos; un acuse no acredita cobro.')
                    rb=receipt_balance(conn,community,line['receipt_id'],data['effective_on'])
                    receipt=conn.execute('SELECT version FROM erp_recibos WHERE id_comunidad=? AND id=?',(community,line['receipt_id'])).fetchone()
                    allocation=cents(decision.get('allocate_cents','0'),nonnegative=True)
                    if allocation>min(int(rb['pending_cents']),int(canonical['amount_cents'])):raise ConflictError('La imputacion supera el importe disponible o pendiente.')
                    if allocation:
                        ReceivablesService._session(conn,session,community,'allocate')
                        ReceivablesService(self.database_path)._choose_responsibility(conn,community,line['receipt_id'],data['effective_on'],allocation,None)
                    row_plan.update(allocate_cents=str(allocation),receipt_version=receipt['version'],pending_cents=rb['pending_cents'])
                    if action=='link_collection':
                        collection=ReceivablesService._entity(conn,'erp_cobros',community,decision.get('collection_id'))
                        if conn.execute('SELECT 1 FROM erp_banco_operaciones WHERE id_comunidad=? AND collection_id=?',
                                        (community,collection['id'])).fetchone():
                            raise ConflictError('El cobro ya esta vinculado a otra identidad bancaria. Revisa la referencia antes de crear un nuevo enlace.')
                        balance=collection_balance(conn,community,collection['id'],data['effective_on'])
                        if collection['amount_cents']!=int(canonical['amount_cents']) or collection['currency']!='EUR' or collection['effective_on']!=data['effective_on']:
                            raise ConflictError('El cobro seleccionado no coincide con importe, moneda y fecha acreditados.')
                        if allocation>int(balance['available_cents']):raise ConflictError('El cobro no tiene fondos libres suficientes.')
                        row_plan.update(collection_id=collection['id'],collection_version=collection['version'])
                else:
                    collection_id=identity(decision.get('collection_id'))
                    linked=conn.execute('''SELECT 1 FROM erp_banca_linea_eventos e JOIN erp_banco_operaciones o
                        ON o.id_comunidad=e.id_comunidad AND o.id=e.operation_id WHERE e.id_comunidad=? AND e.line_id=?
                        AND e.kind='settlement' AND o.collection_id=?''',(community,line['id'],collection_id)).fetchone()
                    if not linked:raise ConflictError('La devolucion no tiene un cobro identificado para este intento. Conserva la evidencia pendiente.')
                    if action=='link_return':
                        returned=ReceivablesService._entity(conn,'erp_devoluciones',community,decision.get('return_id'))
                        if returned['collection_id']!=collection_id or returned['effective_on']!=data['effective_on'] or returned['amount_cents']!=int(canonical['amount_cents']):
                            raise ConflictError('La devolucion existente no corresponde a este cobro, importe y fecha.')
                        if conn.execute('SELECT 1 FROM erp_banco_operaciones WHERE id_comunidad=? AND return_id=?',(community,returned['id'])).fetchone():
                            raise ConflictError('La devolucion ya tiene identidad bancaria; revisa su referencia.')
                        row_plan.update(collection_id=collection_id,return_id=returned['id'])
                        planned.append(row_plan)
                        continue
                    spec=require_fields(decision.get('return_spec',{}),('free_cents','reversals'))
                    key='bank-return-'+self.vault.fingerprint(community,'bank-operation-identity',identity_value)
                    return_payload={'collection_id':collection_id,'effective_on':data['effective_on'],'external_key':key,**spec}
                    preview=ReceivablesService(self.database_path)._correction_preview(conn,community,'return',return_payload)
                    if preview['amount_cents']!=canonical['amount_cents']:raise ConflictError('La devolucion propuesta no coincide con el importe bancario.')
                    row_plan.update(collection_id=collection_id,return_payload=return_payload,return_preview=preview)
            elif kind=='cancelled' and data.get('terminal') is not True:
                raise ContractError('La retirada requiere confirmacion bancaria de que la instruccion ya no se ejecutara.')
            planned.append(row_plan)
        public={'result_id':result['id'],'version':result['version'],'rows':planned}
        # The full plan contains bank references. Only its opaque fingerprint leaves this boundary.
        public['preview_hash']=self.vault.fingerprint(community,'bank-result-plan',public)
        return public

    @staticmethod
    def _public_plan(plan):
        hidden={'identity','canonical','return_payload'}
        rows=[{k:v for k,v in row.items() if k not in hidden} for row in plan['rows']]
        # ERP 3 return previews include a protected synthetic external key, not the bank reference.
        return {**plan,'rows':rows}

    def results_preview(self,session,env):
        def op(conn,actor,e,now):return self._public_plan(self._result_plan(conn,session,e.community_id,e.payload))
        return self._write(session,env,'results',op)

    @staticmethod
    def _economic_envelope(parent,operation,key,payload,version=None):
        return CommandEnvelope.from_value({'command':'erp3.'+operation,'id_comunidad':parent.community_id,
            'payload':payload,'idempotency_key':key,'expected_version':version,'origin':parent.origin,
            'reason':'Resultado bancario revisado. Evidencia protegida en ERP 4.',
            'evidence':{'type':'external_reference','id':'erp4-result:'+str(parent.payload['result_id'])}})

    def results_confirm(self,session,env):
        def op(conn,actor,e,now):
            plan=self._result_plan(conn,session,e.community_id,e.payload)
            if e.expected_version!=plan['version'] or e.payload.get('preview_hash')!=plan['preview_hash']:
                raise ConflictError('El resultado o sus saldos han cambiado. Revisa de nuevo.')
            economic=ReceivablesService.in_transaction(self.database_path,conn)
            applied=[]
            for row in plan['rows']:
                kind=row['kind'];operation_id=row.get('operation_id');collection_id=row.get('collection_id');return_id=row.get('return_id')
                key='bank-result-'+str(row['result_line_id'])
                history_gap=row['action']=='terminal_without_collection'
                if kind in ('settlement','returned') and not row['already_processed'] and not history_gap:
                    if kind=='settlement':
                        if row['action']=='record_collection':
                            line=self._entity(conn,'erp_remesa_lineas',e.community_id,row['line_id'])
                            mv=self._entity(conn,'erp_mandato_versiones',e.community_id,line['mandate_version_id'])
                            payer={'type':'owner','id':mv['debtor_owner_id']} if mv['debtor_owner_id'] else {'type':'person','id':mv['debtor_person_id']}
                            payload={'amount_cents':row['amount_cents'],'currency':'EUR','effective_on':row['effective_on'],
                                'method':'remesa','external_source':'erp4','external_key':key,'payer':payer,'treasury_reference':'erp4-treasury:'+str(row['treasury_id'])}
                            collection_id=economic.collection_record(session,self._economic_envelope(e,'collection.record',key+'-collection',payload))['entity']['id']
                        if int(row['allocate_cents']):
                            payload={'collection_id':collection_id,'effective_on':row['effective_on'],
                                     'allocations':[{'receipt_id':row['receipt_id'],'amount_cents':row['allocate_cents']}]}
                            proposal=economic.allocation_preview(session,self._economic_envelope(e,'allocation.preview',key+'-allocation-preview',payload))['entity']
                            economic.allocation_confirm(session,self._economic_envelope(e,'allocation.confirm',key+'-allocation',{'proposal_id':proposal['id']},proposal['version']))
                    elif row['action']!='link_return':
                        proposal=economic.return_preview(session,self._economic_envelope(e,'return.preview',key+'-return-preview',row['return_payload']))['entity']
                        economic.return_confirm(session,self._economic_envelope(e,'return.confirm',key+'-return',{'proposal_id':proposal['id']},proposal['version']))
                        return_id=conn.execute('SELECT id FROM erp_devoluciones WHERE id_comunidad=? AND external_key=?',(e.community_id,row['return_payload']['external_key'])).fetchone()[0]
                    secret=self.vault.put(conn,e.community_id,'bank-operation',{'canonical':row['canonical']},now)
                    operation_id=conn.execute('''INSERT INTO erp_banco_operaciones
                        (id_comunidad,treasury_id,event_type,secret_id,collection_id,return_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?)''',
                        (e.community_id,row['treasury_id'],kind,secret,collection_id,return_id,now,actor.user_id)).lastrowid
                    for kid,digest in self.vault.fingerprints(e.community_id,'bank-operation-identity',row['identity']).items():
                        conn.execute('INSERT INTO erp_banco_identidades VALUES (?,?,?,?)',(e.community_id,kid,digest,operation_id))
                prior=row['current']
                event_kind='pending' if history_gap else 'conflict' if kind in ('cancelled','rejected') and prior in ('settlement','returned') else kind
                source=conn.execute('SELECT secret_id FROM erp_resultado_lineas WHERE id_comunidad=? AND id=?',(e.community_id,row['result_line_id'])).fetchone()[0]
                event=conn.execute('''INSERT INTO erp_banca_linea_eventos
                    (id_comunidad,line_id,result_line_id,operation_id,kind,effective_on,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?,?)''',
                    (e.community_id,row['line_id'],row['result_line_id'],operation_id,event_kind,row['effective_on'],source,now,actor.user_id)).lastrowid
                conn.execute('INSERT INTO erp_banca_resultado_aplicaciones(id_comunidad,result_line_id,event_id,registered_at,actor_id) VALUES (?,?,?,?,?)',
                             (e.community_id,row['result_line_id'],event,now,actor.user_id))
                if history_gap:
                    self._control_event(conn,actor,e,now,'terminal_history_gap',row['effective_on'],line=row['line_id'],
                        details={'result_line_id':row['result_line_id'],'economic_history_pending':True})
                if history_gap or event_kind in ('settlement','rejected','cancelled'):
                    state='consumida' if kind=='settlement' else 'liberada'
                    conn.execute("UPDATE erp_remesa_reservas SET state=?,finished_at=?,reason=? WHERE id_comunidad=? AND line_id=? AND state='activa'",
                                 (state,now,kind,e.community_id,row['line_id']))
                if kind=='settlement' and prior in ('cancelled','rejected'):
                    conn.execute('''UPDATE erp_remesas SET needs_review=1,version=version+1 WHERE id_comunidad=? AND id IN
                        (SELECT rev.remittance_id FROM erp_remesa_reservas r JOIN erp_remesa_lineas l ON l.id=r.line_id
                         JOIN erp_remesa_revisiones rev ON rev.id=l.revision_id WHERE r.id_comunidad=? AND r.receipt_id=? AND r.state='activa')''',
                        (e.community_id,e.community_id,row['receipt_id']))
                conn.execute("UPDATE erp_resultado_lineas SET state='confirmada',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,row['result_line_id']))
                statuses = [self._line_status(conn, e.community_id, item[0]) for item in conn.execute('''
                    SELECT l.id FROM erp_remesa_lineas l JOIN erp_remesa_revisiones v
                    ON v.id_comunidad=l.id_comunidad AND v.id=l.revision_id
                    WHERE v.id_comunidad=? AND v.remittance_id=?''',(e.community_id,row['remittance_id']))]
                closed = all(s in ('settlement','returned','rejected','cancelled') for s in statuses)
                rem_state = 'cancelada' if all(s=='cancelled' for s in statuses) else 'finalizada' if closed else 'seguimiento'
                conflicting = history_gap or event_kind=='conflict' or (kind=='settlement' and prior in ('cancelled','rejected'))
                conn.execute('''UPDATE erp_remesas SET state=?,needs_review=CASE WHEN ? THEN 1 ELSE needs_review END,
                    version=version+1 WHERE id_comunidad=? AND id=?''',
                    (rem_state,int(conflicting),e.community_id,row['remittance_id']))
                applied.append({'line_id':row['line_id'],'event_id':event,'operation_id':operation_id,'collection_id':collection_id,'return_id':return_id,'kind':event_kind,'already_processed':row['already_processed']})
            remaining=conn.execute("SELECT count(*) FROM erp_resultado_lineas WHERE id_comunidad=? AND result_id=? AND state!='confirmada'",(e.community_id,plan['result_id'])).fetchone()[0]
            state='pendiente' if remaining else 'confirmado'
            conn.execute('UPDATE erp_resultados_bancarios SET state=?,version=version+1 WHERE id_comunidad=? AND id=?',(state,e.community_id,plan['result_id']))
            return {'id':plan['result_id'],'version':plan['version']+1,'state':state,'applied':applied}
        return self._write(session,env,'results',op)
