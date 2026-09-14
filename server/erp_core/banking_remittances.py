"""Preparation/reservation operations. They never create collections or alter debt."""

import calendar
from datetime import date
import json
import uuid
from dataclasses import replace

from .errors import ConflictError, ContractError, NotFoundError
from .receivables_contracts import cents, day, identity, require_fields
from .receivables_projection import receipt_balance
from .banking_adapter import validate_schedule
from .migrations import utc_now
from .contracts import EvidenceRef


def _months_after(value, months):
    original = date.fromisoformat(value)
    year, month = divmod(original.year * 12 + original.month - 1 + months, 12)
    return date(year, month + 1, min(original.day, calendar.monthrange(year, month + 1)[1])).isoformat()


class RemittanceOperations:
    @staticmethod
    def _direct_for_receipt(conn,community,receipt,requested):
        rows=list(conn.execute('''SELECT d.id,d.concept_key,v.id AS version_id,v.mandate_id,v.billing_config_id,
            v.effective_from,v.effective_until,v.state FROM erp_domiciliaciones d
            JOIN erp_domiciliacion_versiones v ON v.direct_debit_id=d.id AND v.id_comunidad=d.id_comunidad
            WHERE d.id_comunidad=? AND d.property_id=? AND (d.concept_key='' OR d.concept_key=?)
            AND v.effective_from<=? AND NOT EXISTS (SELECT 1 FROM erp_domiciliacion_versiones newer
                WHERE newer.direct_debit_id=d.id AND newer.effective_from<=? AND newer.version>v.version)''',
            (community,receipt['id_propiedad'],receipt['concept_key'],requested,requested)))
        # A suspended specific authorization must not silently fall back to the generic one.
        specific=[r for r in rows if r['concept_key']==receipt['concept_key']]
        matches=[r for r in (specific or rows) if r['state']=='activa' and (not r['effective_until'] or r['effective_until']>requested)]
        if len(matches)!=1:
            raise ContractError('Falta una domiciliacion inequivoca y vigente para el recibo.')
        return matches[0]
    def _attempt_evidence(self, conn, session, env):
        from .receivables_service import ReceivablesService
        authorizations = env.payload.get('third_party_authorizations', {})
        if not isinstance(authorizations, dict):
            raise ContractError('Revisa las autorizaciones de pago de terceros.')
        for item in authorizations.values():
            require_fields(item, ('mandate_id','evidence'))
            evidence = EvidenceRef.from_value(item['evidence'])
            if evidence is None:
                raise ContractError('El pago de un tercero requiere evidencia especifica.')
            ReceivablesService(self.database_path)._validate_evidence(conn,session,replace(env,evidence=evidence))

    def notification_record(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('sent_on', 'lines'))
            sent = day(p['sent_on'])
            if sent > date.today().isoformat() or not isinstance(p['lines'], list) or not 1 <= len(p['lines']) <= 10000:
                raise ContractError('Revisa la prenotificacion enviada y sus lineas.')
            lines, seen = [], set()
            for item in p['lines']:
                require_fields(item, ('receipt_id', 'amount_cents', 'requested_on', 'mandate_id'))
                rid = identity(item['receipt_id'])
                if rid in seen or not conn.execute('SELECT 1 FROM erp_recibos WHERE id_comunidad=? AND id=?', (e.community_id, rid)).fetchone():
                    raise ContractError('Recibo repetido o no disponible.')
                seen.add(rid)
                mandate = self._entity(conn, 'erp_mandatos', e.community_id, item['mandate_id'])
                lines.append({'receipt_id': rid, 'amount_cents': str(cents(item['amount_cents'], positive=True)),
                              'requested_on': day(item['requested_on']), 'mandate_id': mandate['id']})
            secret = self.vault.put(conn, e.community_id, 'prenotification', {'lines': lines, **self._evidence_value(e)}, now)
            nid = conn.execute('''INSERT INTO erp_prenotificaciones(id_comunidad,secret_id,sent_on,state,registered_at,actor_id)
                VALUES (?,?,?,'enviada',?,?)''', (e.community_id, secret, sent, now, actor.user_id)).lastrowid
            return {'id': nid, 'version': 1, 'line_count': len(lines), 'state': 'enviada'}
        return self._write(session, env, 'prepare', op)

    def _remittance_preview(self, conn, community, p, reserved_remittance_id=None):
        require_fields(p, ('creditor_id', 'requested_on', 'receipt_ids', 'notification_id'), ('preview_hash','retry_of','third_party_authorizations'))
        requested = day(p['requested_on'])
        if requested < date.today().isoformat():
            raise ContractError('La fecha de cargo no puede estar en el pasado.')
        creditor = self._entity(conn, 'erp_acreedor_versiones', community, p['creditor_id'])
        config_row, config = self._bank_profile(conn,community,creditor['id'])
        validate_schedule(config,requested,utc_now())
        if creditor['effective_from'] > requested or (creditor['effective_until'] and creditor['effective_until'] <= requested):
            raise ContractError('El acreedor no esta vigente en la fecha de cargo.')
        notification = self._entity(conn, 'erp_prenotificaciones', community, p['notification_id'])
        if notification['state'] != 'enviada' or not notification['sent_on']:
            raise ContractError('Falta una prenotificacion enviada.')
        notice = self.vault.get(conn, community, notification['secret_id'], 'prenotification')
        ids = p['receipt_ids']
        if not isinstance(ids, list) or not 1 <= len(ids) <= 10000:
            raise ContractError('Selecciona recibos para preparar la remesa.')
        ids = [identity(v) for v in ids]
        if len(ids)>config['max_lines']:
            raise ContractError('La seleccion supera el limite bancario de lineas.')
        if len(ids) != len(set(ids)):
            raise ContractError('Hay recibos repetidos.')
        retries=p.get('retry_of',{})
        if not isinstance(retries,dict) or any(str(identity(k)) not in {str(r) for r in ids} for k in retries):
            raise ContractError('Las referencias de reenvio no corresponden a la seleccion.')
        authorizations = p.get('third_party_authorizations', {})
        if not isinstance(authorizations,dict) or any(str(identity(k)) not in {str(r) for r in ids} for k in authorizations):
            raise ContractError('La autorizacion de pago no corresponde a los recibos seleccionados.')
        lines, total, single_use = [], 0, set()
        for rid in sorted(ids):
            if conn.execute("SELECT 1 FROM erp_banca_instrucciones_externas WHERE id_comunidad=? AND receipt_id=? AND state='activa'",(community,rid)).fetchone():
                raise ConflictError('El recibo tiene una instruccion bancaria externa pendiente de cierre.')
            receipt = conn.execute('SELECT * FROM erp_recibos WHERE id_comunidad=? AND id=?', (community, rid)).fetchone()
            if not receipt:
                raise NotFoundError('Recibo no disponible en esta comunidad.')
            balance = receipt_balance(conn, community, rid)
            amount = cents(balance['pending_cents'], positive=True)
            if receipt['currency'] != 'EUR' or balance['state'] == 'anulado' or balance['management'] == 'incobrable':
                raise ContractError('El recibo no es elegible para remesa ordinaria.')
            reservation=conn.execute('''SELECT v.remittance_id FROM erp_remesa_reservas r
                JOIN erp_remesa_lineas l ON l.id_comunidad=r.id_comunidad AND l.id=r.line_id
                JOIN erp_remesa_revisiones v ON v.id_comunidad=l.id_comunidad AND v.id=l.revision_id
                WHERE r.id_comunidad=? AND r.receipt_id=? AND r.state='activa' ''',(community,rid)).fetchone()
            if reservation and reservation['remittance_id']!=reserved_remittance_id:
                raise ConflictError('Un recibo seleccionado ya esta reservado.')
            previous=conn.execute('''SELECT l.id,r.state FROM erp_remesa_lineas l
                JOIN erp_remesa_revisiones v ON v.id_comunidad=l.id_comunidad AND v.id=l.revision_id
                JOIN erp_remesas r ON r.id_comunidad=v.id_comunidad AND r.id=v.remittance_id
                WHERE l.id_comunidad=? AND l.receipt_id=? AND r.id!=? ORDER BY l.id DESC LIMIT 1''',
                (community,rid,reserved_remittance_id or -1)).fetchone()
            retry_of=None
            if previous:
                terminal=self._line_status(conn,community,previous['id'])
                if terminal=='conflict' or conn.execute('''SELECT 1 FROM erp_resultado_lineas
                    WHERE id_comunidad=? AND line_id=? AND state!='confirmada' ''',(community,previous['id'])).fetchone():
                    raise ConflictError('El intento anterior tiene resultados pendientes o contradictorios; revisalos antes de reenviar.')
                if previous['state']!='cancelada' and terminal not in ('rejected','returned','cancelled'):
                    raise ConflictError('El intento anterior no tiene cierre acreditado para reenviar.')
                if retries.get(str(rid))!=previous['id']:
                    raise ContractError('Confirma expresamente el reenvio del intento anterior.')
                retry_of=previous['id']
            elif str(rid) in retries:
                raise ContractError('No existe el intento anterior indicado.')
            payers = list(conn.execute("SELECT snapshot_json FROM erp_recibo_sujetos WHERE id_comunidad=? AND receipt_id=? AND role='payer'", (community, rid)))
            obligated = list(conn.execute("SELECT id FROM erp_recibo_sujetos WHERE id_comunidad=? AND receipt_id=? AND role='obligated'", (community, rid)))
            if len(payers) != 1 or not obligated:
                raise ContractError('El recibo requiere pagador y responsabilidad acreditados.')
            payer_snapshot = json.loads(payers[0][0])
            payer = {'type': payer_snapshot.get('type'), 'id': payer_snapshot.get('id')}
            direct = self._direct_for_receipt(conn,community,receipt,requested)
            mandate = self._entity(conn, 'erp_mandatos', community, direct['mandate_id'])
            if mandate['state'] != 'activo' or mandate['creditor_id'] != creditor['id']:
                raise ContractError('El mandato no esta activo para el acreedor seleccionado.')
            version = conn.execute('''SELECT * FROM erp_mandato_versiones WHERE id_comunidad=? AND mandate_id=?
                AND effective_from<=? ORDER BY version DESC LIMIT 1''', (community, mandate['id'], requested)).fetchone()
            if not version or (version['effective_until'] and version['effective_until'] <= requested):
                raise ContractError('El mandato no cubre la fecha de cargo.')
            details = self.vault.get(conn, community, version['secret_id'], 'mandate-version')
            notice_days = details.get('prenotification_agreement', {}).get('days', 14)
            if (date.fromisoformat(requested) - date.fromisoformat(notification['sent_on'])).days < notice_days:
                raise ContractError('La prenotificacion no cubre el plazo aplicable a este mandato.')
            debtor = {'type': 'owner', 'id': version['debtor_owner_id']} if version['debtor_owner_id'] else {'type': 'person', 'id': version['debtor_person_id']}
            if payer != debtor:
                agreement=authorizations.get(str(rid))
                if not agreement:
                    raise ContractError('El pagador del recibo difiere del mandato. Requiere autorizacion especifica, no traslado de deuda.')
                require_fields(agreement,('mandate_id','evidence'))
                if identity(agreement['mandate_id'])!=mandate['id'] or EvidenceRef.from_value(agreement['evidence']) is None:
                    raise ContractError('La autorizacion especifica no corresponde al mandato seleccionado.')
            elif str(rid) in authorizations:
                raise ContractError('Este recibo no necesita sustituir su pagador para el intento.')
            account = self._entity(conn, 'erp_cuentas_pagador', community, version['account_id'])
            if account['state'] != 'activa':
                raise ContractError('La cuenta del mandato no esta activa.')
            if not conn.execute('SELECT 1 FROM erp_mandato_propiedades WHERE id_comunidad=? AND mandate_version_id=? AND property_id=?',
                                (community, version['id'], receipt['id_propiedad'])).fetchone():
                raise ContractError('El mandato no cubre esta propiedad.')
            latest = conn.execute("SELECT MAX(effective_on) FROM erp_mandato_eventos WHERE id_comunidad=? AND mandate_id=? AND event_type='presentada'",
                                  (community, mandate['id'])).fetchone()[0]
            if requested >= _months_after(latest or version['signed_on'], 36):
                raise ContractError('El mandato requiere revision por inactividad.')
            authorized_retry = False
            if mandate['kind']=='puntual' and retry_of and config.get('allow_failed_oneoff_retry'):
                authorization = conn.execute("SELECT secret_id FROM erp_banca_control_eventos WHERE id_comunidad=? AND line_id=? AND kind='oneoff_retry_authorized' ORDER BY id DESC LIMIT 1",(community,retry_of)).fetchone()
                if authorization:
                    authorized_retry = self.vault.get(conn,community,authorization['secret_id'],'bank-control')['details'] == {
                        'mandate_id':mandate['id'],'mandate_version':mandate['version']}
                if self._line_status(conn,community,retry_of) not in ('rejected','cancelled'):
                    authorized_retry = False
            if mandate['kind'] == 'puntual' and ((latest and not authorized_retry) or conn.execute('''SELECT 1 FROM erp_remesa_reservas r
                JOIN erp_remesa_lineas l ON l.id=r.line_id JOIN erp_mandato_versiones v ON v.id=l.mandate_version_id
                WHERE r.id_comunidad=? AND v.mandate_id=? AND r.state IN ('activa','consumida')
                AND NOT EXISTS (SELECT 1 FROM erp_remesa_revisiones rev WHERE rev.id=l.revision_id AND rev.remittance_id=?)''',
                (community, mandate['id'], reserved_remittance_id or -1)).fetchone()):
                raise ConflictError('El mandato puntual ya tiene una instruccion activa o utilizada.')
            if mandate['kind'] == 'puntual':
                if mandate['id'] in single_use:
                    raise ConflictError('Un mandato puntual no puede cubrir varias instrucciones del lote.')
                single_use.add(mandate['id'])
            if not any(n['receipt_id'] == rid and n['amount_cents'] == str(amount) and n['requested_on'] == requested
                       and n['mandate_id'] == mandate['id'] for n in notice['lines']):
                raise ContractError('La prenotificacion no coincide con importe, fecha y mandato del recibo.')
            total = cents(total + amount)
            lines.append({'receipt_id': rid, 'receipt_version': receipt['version'], 'amount_cents': str(amount),
                'property_id': receipt['id_propiedad'], 'mandate_id': mandate['id'], 'mandate_version_id': version['id'],
                'mandate_version': mandate['version'], 'account_id': account['id'], 'account_version': account['version'],
                'direct_debit_version_id': direct['version_id'], 'notification_id': notification['id'],
                'sequence': 'OOFF' if mandate['kind']=='puntual' else 'FRST' if not latest and config['recurrent_sequence']=='FRST_THEN_RCUR' else 'RCUR',
                'concept':'Recibo '+receipt['number'], 'retry_of_id':retry_of,
                'prenotification_days':notice_days, 'third_party':payer!=debtor})
        if total>cents(config['max_total_cents'],positive=True):
            raise ContractError('La seleccion supera el importe permitido por el banco.')
        result = {'creditor_id': creditor['id'], 'creditor_version': creditor['version'], 'requested_on': requested,
                  'notification_id': notification['id'], 'lines': lines, 'total_cents': str(total), 'currency': 'EUR',
                  'config_id':config_row['id'], 'config_version':config_row['version'],
                  'third_party_authorizations':authorizations}
        result['preview_hash'] = self.vault.fingerprint(community, 'remittance-preview', result)
        return result

    def remittance_preview(self, session, env):
        def op(conn, actor, e, now):
            from .receivables_service import ReceivablesService
            ReceivablesService._session(conn, session, e.community_id, 'read')
            self._attempt_evidence(conn,session,e)
            preview=self._remittance_preview(conn,e.community_id,e.payload)
            return {k:v for k,v in preview.items() if k!='third_party_authorizations'}
        return self._write(session, env, 'prepare', op)

    def remittance_prepare(self, session, env):
        def op(conn, actor, e, now):
            from .receivables_service import ReceivablesService
            ReceivablesService._session(conn, session, e.community_id, 'read')
            self._attempt_evidence(conn,session,e)
            preview = self._remittance_preview(conn, e.community_id, e.payload)
            if e.payload.get('preview_hash') != preview['preview_hash']:
                raise ConflictError('La seleccion ha cambiado o no ha sido revisada.')
            rid = conn.execute('''INSERT INTO erp_remesas
                (id_comunidad,creditor_id,requested_on,currency,state,registered_at,actor_id) VALUES (?,?,?,'EUR','preparada',?,?)''',
                (e.community_id, preview['creditor_id'], preview['requested_on'], now, actor.user_id)).lastrowid
            secret = self.vault.put(conn, e.community_id, 'remittance-revision', preview, now)
            revision = conn.execute('''INSERT INTO erp_remesa_revisiones
                (id_comunidad,remittance_id,revision,secret_id,fingerprint,registered_at,actor_id) VALUES (?,?,1,?,?,?,?)''',
                (e.community_id, rid, secret, preview['preview_hash'], now, actor.user_id)).lastrowid
            conn.execute('''INSERT INTO erp_remesa_perfiles (id_comunidad,revision_id,config_id,registered_at,actor_id)
                VALUES (?,?,?,?,?)''',(e.community_id,revision,preview['config_id'],now,actor.user_id))
            for line in preview['lines']:
                # Freeze encrypted bank data now, not references to mutable masters alone.
                mandate = self._entity(conn, 'erp_mandatos', e.community_id, line['mandate_id'])
                mv = self._entity(conn, 'erp_mandato_versiones', e.community_id, line['mandate_version_id'])
                account = self._entity(conn, 'erp_cuentas_pagador', e.community_id, line['account_id'])
                creditor = self._entity(conn, 'erp_acreedor_versiones', e.community_id, preview['creditor_id'])
                treasury = self._entity(conn, 'erp_cuentas_tesoreria', e.community_id, creditor['treasury_id'])
                frozen = {**line, 'payer_account': self.vault.get(conn, e.community_id, account['secret_id'], 'payer-account'),
                    'mandate': self.vault.get(conn, e.community_id, mandate['rum_secret_id'], 'mandate-identity'),
                    'mandate_details': self.vault.get(conn, e.community_id, mv['secret_id'], 'mandate-version'),
                    'signed_on': mv['signed_on'], 'kind': mandate['kind'],
                    'creditor': self.vault.get(conn, e.community_id, creditor['secret_id'], 'creditor'),
                    'creditor_account': self.vault.get(conn, e.community_id, treasury['secret_id'], 'treasury-account')}
                if mv['supersedes_id']:
                    previous=self._entity(conn,'erp_mandato_versiones',e.community_id,mv['supersedes_id'])
                    old_account=self._entity(conn,'erp_cuentas_pagador',e.community_id,previous['account_id'])
                    frozen['original_debtor_iban']=self.vault.get(conn,e.community_id,old_account['secret_id'],'payer-account')['iban']
                secret = self.vault.put(conn, e.community_id, 'remittance-line', frozen, now)
                lid = conn.execute('''INSERT INTO erp_remesa_lineas
                    (id_comunidad,revision_id,receipt_id,attempt_key,amount_cents,mandate_version_id,notification_id,secret_id,registered_at,actor_id,retry_of_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)''', (e.community_id, revision, line['receipt_id'], 'E' + uuid.uuid4().hex.upper(),
                    int(line['amount_cents']), line['mandate_version_id'], line['notification_id'], secret, now, actor.user_id,line['retry_of_id'])).lastrowid
                conn.execute('''INSERT INTO erp_remesa_reservas
                    (id_comunidad,receipt_id,line_id,amount_cents,state,registered_at,actor_id) VALUES (?,?,?,?,'activa',?,?)''',
                    (e.community_id, line['receipt_id'], lid, int(line['amount_cents']), now, actor.user_id))
            return {'id': rid, 'version': 1, 'state': 'preparada', 'count': len(preview['lines']), 'total_cents': preview['total_cents']}
        return self._write(session, env, 'prepare', op)

    def remittance_cancel_local(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('id',))
            row = self._entity(conn, 'erp_remesas', e.community_id, p['id'])
            self._version(row, e.expected_version)
            if row['state'] not in ('preparada', 'validada', 'fichero_disponible'):
                raise ContractError('Esta remesa requiere acreditar su retirada; no admite cancelacion local.')
            conn.execute('''UPDATE erp_remesa_reservas SET state='liberada',finished_at=?,reason='cancelacion_local'
                WHERE id_comunidad=? AND state='activa' AND line_id IN
                (SELECT l.id FROM erp_remesa_lineas l JOIN erp_remesa_revisiones r ON r.id=l.revision_id WHERE r.remittance_id=?)''',
                (now, e.community_id, row['id']))
            conn.execute("UPDATE erp_remesas SET state='cancelada',version=version+1 WHERE id_comunidad=? AND id=?", (e.community_id, row['id']))
            return {'id': row['id'], 'version': row['version'] + 1, 'state': 'cancelada'}
        return self._write(session, env, 'present_cancel', op)

    def retry_preview(self,session,env):
        if not env.payload.get('retry_of'):raise ContractError('Selecciona los intentos que deseas reenviar.')
        return self.remittance_preview(session,env)

    def retry_confirm(self,session,env):
        if not env.payload.get('retry_of'):raise ContractError('El reenvio necesita confirmacion del intento anterior.')
        return self.remittance_prepare(session,env)
