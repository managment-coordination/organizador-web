"""Explicit reversals preserve both the original movement and its economic attribution."""

import json

from .contracts import canonical_json
from .errors import ConflictError, ContractError
from .receivables_contracts import cents, require_fields
from .receivables_projection import receipt_balance, credit_balance, original_responsibility, collection_balance, collection_payer


class ReversalOperations:
    def _return_reverse_preview(self,conn,community,p):
        require_fields(p,('return_id','effective_on'))
        row=self._entity(conn,'erp_devoluciones',community,p['return_id'])
        effective=self._date_open(conn,community,p['effective_on'])
        if effective<row['effective_on']:raise ContractError('La rectificacion no puede preceder a la devolucion.')
        if conn.execute('SELECT 1 FROM erp_devolucion_reversiones WHERE id_comunidad=? AND return_id=?',(community,row['id'])).fetchone():
            raise ConflictError('La devolucion ya se ha revertido.')
        collection=self._entity(conn,'erp_cobros',community,row['collection_id'])
        balance=collection_balance(conn,community,collection['id'],effective)
        return {'return_id':row['id'],'collection_id':collection['id'],'collection_version':collection['version'],
                'effective_on':effective,'amount_cents':str(row['amount_cents']),
                'available_before_cents':balance['available_cents'],
                'available_after_cents':str(int(balance['available_cents'])+row['amount_cents']),
                'automatic_reallocation':False,'original_fee_changed':False}

    def _return_reverse_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        event,now=self._event(conn,actor,e,'erp3.collection.return_reversed',p['effective_on'],p)
        conn.execute('''INSERT INTO erp_devolucion_reversiones
            (id_comunidad,return_id,collection_id,event_id,amount_cents,effective_on,registered_at) VALUES (?,?,?,?,?,?,?)''',
            (e.community_id,p['return_id'],p['collection_id'],event,int(p['amount_cents']),p['effective_on'],now))
        self._bump_balances(conn,e.community_id,collections=[p['collection_id']])
        return {'event_ids':[event],'original_changed':False,'automatic_reallocation':False}

    def return_reverse_preview(self,s,e):
        return self._review_operation(s,e,'return_reverse','return_collection',self._return_reverse_preview)

    def return_reverse_confirm(self,s,e):
        return self._review_operation(s,e,'return_reverse','return_collection',self._return_reverse_preview,self._return_reverse_apply)

    def _payer_preview(self,conn,community,p):
        require_fields(p,('collection_id','payer','effective_on'))
        row=self._entity(conn,'erp_cobros',community,p['collection_id'])
        effective=self._date_open(conn,community,p['effective_on'])
        current=collection_payer(conn,community,row['id'],effective)
        if row['payer_owner_id'] or row['payer_person_id'] or conn.execute('SELECT 1 FROM erp_cobro_acreditaciones WHERE id_comunidad=? AND collection_id=?',(community,row['id'])).fetchone():
            raise ConflictError('El cobro ya tiene un pagador acreditado; esta accion solo identifica cobros pendientes.')
        return {'collection_id':row['id'],'collection_version':row['version'],'effective_on':effective,
                'payer':self._subject(conn,community,p['payer']),'previous_payer':current,'economic_balance_changed':False}

    def _payer_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        event,now=self._event(conn,actor,e,'erp3.collection.payer_accredited',p['effective_on'],p)
        payer=p['payer']
        conn.execute('''INSERT INTO erp_cobro_acreditaciones
            (id_comunidad,collection_id,event_id,payer_owner_id,payer_person_id,effective_on,registered_at) VALUES (?,?,?,?,?,?,?)''',
            (e.community_id,p['collection_id'],event,payer['id'] if payer['type']=='owner' else None,
             payer['id'] if payer['type']=='person' else None,p['effective_on'],now))
        self._bump_balances(conn,e.community_id,collections=[p['collection_id']])
        return {'event_ids':[event],'original_changed':False,'economic_balance_changed':False}

    def collection_payer_preview(self,s,e):
        return self._review_operation(s,e,'payer_accredit','record_collection',self._payer_preview)

    def collection_payer_confirm(self,s,e):
        return self._review_operation(s,e,'payer_accredit','record_collection',self._payer_preview,self._payer_apply)

    def _other_reversal_preview(self,conn,community,p,kind):
        require_fields(p,('movement_id','amount_cents','effective_on'))
        table='erp_rectificaciones' if kind=='credit' else 'erp_credito_aplicaciones'
        row=self._entity(conn,table,community,p['movement_id'])
        if row['reverses_id'] or (kind=='credit' and row['kind']!='credit'):
            raise ContractError('Selecciona un movimiento original de este tipo.')
        effective=self._date_open(conn,community,p['effective_on'])
        if effective<row['effective_on']:raise ContractError('La reversion no puede preceder al original.')
        amount=cents(p['amount_cents'],positive=True)
        used=sum(r[0] for r in conn.execute(f'SELECT amount_cents FROM {table} WHERE id_comunidad=? AND reverses_id=?',(community,row['id'])))
        if amount>row['amount_cents']-used:raise ConflictError('El movimiento ya se ha revertido total o parcialmente.')
        receipt=self._entity(conn,'erp_recibos',community,row['receipt_id'])
        balance=receipt_balance(conn,community,receipt['id'],effective)
        result={'movement_id':row['id'],'receipt_id':receipt['id'],'receipt_version':receipt['version'],
                'effective_on':effective,'amount_cents':str(amount),'before_cents':balance['pending_cents'],
                'after_cents':str(cents(int(balance['pending_cents'])+amount)),
                'already_reversed_cents':str(used),
                'responsibility_subjects':json.loads(row['responsibility_json']) if row['responsibility_json'] else original_responsibility(conn,community,receipt['id'])}
        if kind=='application':
            result['credit_id']=row['credit_id']
            result['credit_balance']={k:v for k,v in credit_balance(conn,community,row['credit_id'],effective).items() if k!='known_at'}
        return result

    def _other_reversal_apply(self,conn,actor,e,p,kind):
        self._evidence(e,required=True)
        event,now=self._event(conn,actor,e,'erp3.credit.reversed' if kind=='credit' else 'erp3.credit_application.reversed',p['effective_on'],p)
        if kind=='credit':
            conn.execute('''INSERT INTO erp_rectificaciones
                (id_comunidad,receipt_id,event_id,kind,amount_cents,effective_on,registered_at,reverses_id,responsibility_json)
                VALUES (?,?,?,'reverse_credit',?,?,?,?,?)''',(e.community_id,p['receipt_id'],event,int(p['amount_cents']),p['effective_on'],now,p['movement_id'],canonical_json(p['responsibility_subjects'])))
        else:
            conn.execute('''INSERT INTO erp_credito_aplicaciones
                (id_comunidad,credit_id,receipt_id,event_id,reverses_id,amount_cents,effective_on,registered_at,responsibility_json)
                VALUES (?,?,?,?,?,?,?,?,?)''',(e.community_id,p['credit_id'],p['receipt_id'],event,p['movement_id'],int(p['amount_cents']),p['effective_on'],now,canonical_json(p['responsibility_subjects'])))
        self._bump_balances(conn,e.community_id,[p['receipt_id']],credits=[p['credit_id']] if kind=='application' else [])
        return {'event_ids':[event],'receipt_id':p['receipt_id'],'original_changed':False}

    def credit_reverse_preview(self,s,e):
        return self._review_operation(s,e,'credit_reverse','credit',lambda c,k,p:self._other_reversal_preview(c,k,p,'credit'))

    def credit_reverse_confirm(self,s,e):
        return self._review_operation(s,e,'credit_reverse','credit',lambda c,k,p:self._other_reversal_preview(c,k,p,'credit'),lambda c,a,e,p:self._other_reversal_apply(c,a,e,p,'credit'))

    def credit_apply_reverse_preview(self,s,e):
        return self._review_operation(s,e,'credit_apply_reverse','reverse_allocation',lambda c,k,p:self._other_reversal_preview(c,k,p,'application'))

    def credit_apply_reverse_confirm(self,s,e):
        return self._review_operation(s,e,'credit_apply_reverse','reverse_allocation',lambda c,k,p:self._other_reversal_preview(c,k,p,'application'),lambda c,a,e,p:self._other_reversal_apply(c,a,e,p,'application'))
