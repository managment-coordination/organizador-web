"""Reviewable movements after an observed cutoff; the original opening stays immutable."""

import json

from .contracts import canonical_json
from .errors import ConflictError, ContractError
from .receivables_contracts import cents, identity, require_fields
from .receivables_projection import opening_balance, collection_balance, receipt_balance, validate_timeline


class OpeningOperations:
    def _opening_preview(self,conn,community,p):
        require_fields(p,('opening_id','kind','effective_on','amount_cents'),
                       ('collection_id','receipt_id','reverses_id','responsibility_subjects','beneficiary'))
        row=self._entity(conn,'erp_saldos_apertura',community,p['opening_id'])
        effective=self._date_open(conn,community,p['effective_on'])
        if effective<row['effective_on']:raise ConflictError('No se pueden reconstruir movimientos anteriores al corte con un saldo agregado.')
        kind=p['kind'];amount=cents(p['amount_cents'],positive=True)
        before=opening_balance(conn,community,row['id'],effective)
        sign=1 if row['amount_cents']>0 else -1
        original=None;collection=None;receipt=None;subjects=None
        if kind.startswith('reverse_'):
            original=self._entity(conn,'erp_apertura_movimientos',community,p.get('reverses_id'))
            if original['opening_id']!=row['id'] or kind!='reverse_'+original['kind'] or original['effective_on']>effective:
                raise ContractError('El movimiento no corresponde a esta reversion.')
            used=sum(r[0] for r in conn.execute('SELECT amount_cents FROM erp_apertura_movimientos WHERE id_comunidad=? AND reverses_id=?',(community,original['id'])))
            if amount>original['amount_cents']-used:raise ConflictError('El importe ya se ha revertido.')
            collection=original['collection_id'];receipt=original['receipt_id'];subjects=json.loads(original['responsibility_json']) if original['responsibility_json'] else None
        elif kind=='allocation':
            if sign<0:raise ContractError('Solo un saldo deudor puede recibir una imputacion de cobro.')
            collection=identity(p.get('collection_id'))
            cb=collection_balance(conn,community,collection,effective)
            if amount>int(cb['available_cents']):raise ConflictError('El cobro no tiene saldo suficiente.')
        elif kind=='credit_apply':
            if sign>0 or not row['owner_id']:raise ConflictError('Selecciona un saldo a favor con beneficiario historico acreditado.')
            receipt=identity(p.get('receipt_id'))
            rb=receipt_balance(conn,community,receipt,effective)
            if amount>int(rb['pending_cents']):raise ConflictError('El importe supera el recibo pendiente.')
            subjects=self._choose_responsibility(conn,community,receipt,effective,amount,p.get('responsibility_subjects'))
        elif kind=='refund':
            if sign>0 or not row['owner_id']:raise ConflictError('El reintegro requiere saldo a favor y beneficiario acreditado.')
            beneficiary=self._subject(conn,community,p.get('beneficiary'))
            if beneficiary['type']!='owner' or beneficiary['id']!=row['owner_id']:raise ConflictError('El beneficiario no corresponde al saldo historico.')
        elif kind=='credit':
            if sign<0:raise ContractError('El abono reduce saldo deudor, no saldo a favor.')
        else:raise ContractError('Movimiento de apertura no admitido.')
        if not original and amount>abs(int(before['remaining_cents'])):raise ConflictError('El importe supera el saldo de apertura disponible.')
        if original and kind not in ('reverse_allocation','reverse_credit_apply','reverse_credit'):raise ContractError('Reversion no admitida.')
        if collection:
            c=self._entity(conn,'erp_cobros',community,collection)
            currency=conn.execute('SELECT moneda FROM comunidades WHERE id_comunidad=?',(community,)).fetchone()[0]
            if c['currency']!=currency:raise ConflictError('La moneda no corresponde a la apertura.')
        return {'opening_id':row['id'],'kind':kind,'amount_cents':str(amount),'effective_on':effective,
                'collection_id':collection,'receipt_id':receipt,'reverses_id':original['id'] if original else None,
                'responsibility_subjects':subjects,'before_cents':before['remaining_cents'],
                'after_cents':str(int(before['remaining_cents'])+sign*amount*(1 if original else -1)),
                'source_cutoff':row['effective_on'],'opening_quality':row['quality'],
                'movement_version':conn.execute('SELECT COUNT(*) FROM erp_apertura_movimientos WHERE id_comunidad=? AND opening_id=?',(community,row['id'])).fetchone()[0],
                'collection_version':self._entity(conn,'erp_cobros',community,collection)['version'] if collection else None,
                'receipt_version':self._entity(conn,'erp_recibos',community,receipt)['version'] if receipt else None}

    def _opening_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        event,now=self._event(conn,actor,e,'erp3.opening.'+p['kind'],p['effective_on'],p)
        mid=conn.execute('''INSERT INTO erp_apertura_movimientos
            (id_comunidad,opening_id,event_id,collection_id,receipt_id,reverses_id,kind,amount_cents,responsibility_json,effective_on,registered_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)''',(e.community_id,p['opening_id'],event,p['collection_id'],p['receipt_id'],p['reverses_id'],p['kind'],
            int(p['amount_cents']),canonical_json(p['responsibility_subjects']) if p['responsibility_subjects'] is not None else None,p['effective_on'],now)).lastrowid
        self._bump_balances(conn,e.community_id,[p['receipt_id']] if p['receipt_id'] else [],[p['collection_id']] if p['collection_id'] else [])
        validate_timeline(conn,e.community_id,opening_ids=[p['opening_id']])
        return {'event_ids':[event],'movement_id':mid,'opening_id':p['opening_id'],'original_changed':False}

    @staticmethod
    def _opening_capability(kind):
        return {'allocation':'allocate','reverse_allocation':'reverse_allocation','credit_apply':'allocate',
                'reverse_credit_apply':'reverse_allocation','refund':'refund','credit':'credit','reverse_credit':'credit'}.get(kind)

    def opening_move_preview(self,session,env):
        capability=self._opening_capability(env.payload.get('kind'))
        if not capability:raise ContractError('Operacion de apertura no admitida.')
        return self._review_operation(session,env,'opening_move',capability,self._opening_preview)

    def opening_move_confirm(self,session,env):
        # Capability is derived from the immutable proposal, never a client assertion.
        def build(conn,community,p):
            capability=self._opening_capability(p.get('kind'))
            self._session(conn,session,community,capability)
            return self._opening_preview(conn,community,p)
        return self._review_operation(session,env,'opening_move','read',build,self._opening_apply)
