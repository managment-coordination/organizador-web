"""Encrypted remittance artifacts, explicit delivery and protected downloads."""

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import uuid

from .banking_adapter import PROFILE_ID, build_core, profile_config, validate_schedule
from .contracts import Actor
from .database import connect, write_transaction
from .errors import ContractError, ConflictError, NotFoundError
from .migrations import utc_now
from .receivables_contracts import day, identity, require_fields, text


class BankingFiles:
    def reveal_account(self,session,community,account_id,reason):
        self._recent_auth(session)
        reason=text(reason,'Motivo de consulta bancaria',maximum=1000)
        conn=connect(self.database_path)
        try:
            with write_transaction(conn):
                actor,_=self._session(conn,session,community,'reveal')
                account=self._entity(conn,'erp_cuentas_pagador',community,account_id)
                now=utc_now()
                context=self.vault.put(conn,community,'banking-reveal-context',{'reason':reason},now)
                from .audit import write_event
                write_event(conn,community_id=community,actor=actor,action='erp4.account.reveal',
                    entity_type='erp_cuentas_pagador',entity_id=account['id'],before=None,after=self._account_public(account),
                    reason='Consulta bancaria autorizada',origin='web',request_id=uuid.uuid4().hex,
                    entity_version=account['version'],metadata={'protected_context_id':context})
                return {'ok':True,'id':account['id'],'iban':self.vault.get(conn,community,account['secret_id'],'payer-account')['iban']}
        finally:
            conn.close()

    @staticmethod
    def _recent_auth(session):
        try:
            verified = datetime.fromisoformat(session['banking_reauthenticated_at'].replace('Z', '+00:00'))
            age = (datetime.now(timezone.utc) - verified).total_seconds()
        except (KeyError, TypeError, ValueError, AttributeError):
            raise PermissionError('Confirma de nuevo tu contrasena para esta operacion bancaria.') from None
        if not 0 <= age <= 300:
            raise PermissionError('La confirmacion de identidad bancaria ha caducado.')

    def profile_configure(self, session, env):
        self._recent_auth(session)
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('creditor_id', 'config'))
            creditor = self._entity(conn, 'erp_acreedor_versiones', e.community_id, p['creditor_id'])
            config = profile_config(p['config'])
            current = conn.execute('SELECT COALESCE(MAX(version),0) FROM erp_banca_configuraciones WHERE id_comunidad=? AND creditor_id=?',
                                   (e.community_id, creditor['id'])).fetchone()[0]
            if e.expected_version != current:
                raise ConflictError('La configuracion bancaria ha cambiado.')
            secret = self.vault.put(conn, e.community_id, 'bank-profile', {'config': config, **self._evidence_value(e)}, now)
            rid = conn.execute('''INSERT INTO erp_banca_configuraciones
                (id_comunidad,creditor_id,version,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?)''',
                (e.community_id, creditor['id'], current + 1, secret, now, actor.user_id)).lastrowid
            conn.execute("UPDATE erp_remesas SET needs_review=1,version=version+1 WHERE id_comunidad=? AND creditor_id=? AND state NOT IN ('cancelada','finalizada')",
                         (e.community_id, creditor['id']))
            return {'id': rid, 'version': current + 1, 'creditor_id': creditor['id'], 'mode': config['mode']}
        return self._write(session, env, 'configure_creditor', op)

    def _bank_profile(self, conn, community, creditor_id):
        row = conn.execute('SELECT * FROM erp_banca_configuraciones WHERE id_comunidad=? AND creditor_id=? ORDER BY version DESC LIMIT 1',
                           (community, creditor_id)).fetchone()
        if not row:
            raise ContractError('Completa la configuracion bancaria de la comunidad antes de preparar la remesa.')
        config = self.vault.get(conn, community, row['secret_id'], 'bank-profile')['config']
        return row, profile_config(config)

    def _revision(self, conn, community, remittance_id):
        row = conn.execute('SELECT * FROM erp_remesa_revisiones WHERE id_comunidad=? AND remittance_id=? ORDER BY revision DESC LIMIT 1',
                           (community, remittance_id)).fetchone()
        if not row:
            raise ContractError('La remesa no tiene una revision confirmada.')
        return row

    def _fresh_remittance(self, conn, community, remittance):
        revision = self._revision(conn, community, remittance['id'])
        frozen = self.vault.get(conn, community, revision['secret_id'], 'remittance-revision')
        payload = {'creditor_id': frozen['creditor_id'], 'requested_on': frozen['requested_on'],
                   'notification_id': frozen['notification_id'], 'receipt_ids': [l['receipt_id'] for l in frozen['lines']]}
        payload['retry_of']={str(l['receipt_id']):l['retry_of_id'] for l in frozen['lines'] if l.get('retry_of_id')}
        payload['third_party_authorizations']=frozen.get('third_party_authorizations',{})
        preview = self._remittance_preview(conn, community, payload, reserved_remittance_id=remittance['id'])
        if remittance['needs_review'] or preview['preview_hash'] != revision['fingerprint']:
            raise ConflictError('Han cambiado saldos, autorizaciones o configuracion. Cancela esta preparacion y revisa una nueva.')
        return revision, frozen

    @staticmethod
    def _file_public(row):
        return {'id': row['id'], 'file_id': row['id'], 'revision_id': row['revision_id'],
                'profile_id': row['profile_id'], 'sha256': row['content_hash'], 'message_id': row['message_id']}

    def remittance_build(self, session, env):
        require_fields(env.payload, ('id',))
        conn = connect(self.database_path, readonly=True)
        try:
            conn.execute('BEGIN')
            self._session(conn, session, env.community_id, 'prepare')
            rem = self._entity(conn, 'erp_remesas', env.community_id, env.payload['id'])
            revision = self._revision(conn, env.community_id, rem['id'])
            existing = conn.execute('SELECT * FROM erp_remesa_ficheros WHERE id_comunidad=? AND revision_id=?', (env.community_id, revision['id'])).fetchone()
            candidate = None
            if existing is None:
                self._version(rem, env.expected_version)
                if rem['state'] not in ('preparada', 'validada'):
                    raise ConflictError('Esta remesa no admite generar un fichero nuevo.')
                revision, frozen = self._fresh_remittance(conn, env.community_id, rem)
                config_row, config = self._bank_profile(conn, env.community_id, rem['creditor_id'])
                lines = []
                for row in conn.execute('SELECT * FROM erp_remesa_lineas WHERE id_comunidad=? AND revision_id=? ORDER BY id', (env.community_id, revision['id'])):
                    item = self.vault.get(conn, env.community_id, row['secret_id'], 'remittance-line')
                    lines.append({**item, 'attempt_key': row['attempt_key']})
                candidate = {'profile_id': PROFILE_ID, 'message_id': 'M' + uuid.uuid4().hex.upper(),
                             'created_at': utc_now(), 'requested_on': rem['requested_on'], 'lines': lines}
        finally:
            conn.close()
        # Generate/validate outside SQLite's writer lock; recheck all inputs when attaching it.
        if candidate is not None:
            xml, metadata = build_core(candidate, config)
        def op(conn, actor, e, now):
            current = self._entity(conn, 'erp_remesas', e.community_id, e.payload['id'])
            rev = self._revision(conn, e.community_id, current['id'])
            saved = conn.execute('SELECT * FROM erp_remesa_ficheros WHERE id_comunidad=? AND revision_id=?', (e.community_id, rev['id'])).fetchone()
            if saved is not None:
                return {**self._file_public(saved), 'remittance_id': current['id'], 'version': current['version'], 'state': current['state']}
            self._version(current, e.expected_version)
            checked, _ = self._fresh_remittance(conn, e.community_id, current)
            if candidate is None or checked['id'] != revision['id']:
                raise ConflictError('La revision del fichero ha cambiado.')
            secret = self.vault.put(conn, e.community_id, 'remittance-file',
                {'content_base64': base64.b64encode(xml).decode(), 'metadata': metadata, 'config': config,
                 'config_id': config_row['id'], 'message_id': candidate['message_id'], 'requested_on': current['requested_on']}, now)
            fid = conn.execute('''INSERT INTO erp_remesa_ficheros
                (id_comunidad,revision_id,secret_id,message_id,profile_id,content_hash,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?)''',
                (e.community_id, rev['id'], secret, candidate['message_id'], PROFILE_ID, metadata['sha256'], now, actor.user_id)).lastrowid
            conn.execute("UPDATE erp_remesas SET state='fichero_disponible',version=version+1 WHERE id_comunidad=? AND id=?", (e.community_id,current['id']))
            return {'id': fid, 'file_id': fid, 'remittance_id': current['id'], 'version': current['version'] + 1,
                    'state': 'fichero_disponible', 'sha256': metadata['sha256'], 'total_cents': metadata['total_cents']}
        return self._write(session, env, 'prepare', op)

    def _file_and_remittance(self, conn, community, file_id):
        file = self._entity(conn, 'erp_remesa_ficheros', community, file_id)
        revision = conn.execute('SELECT * FROM erp_remesa_revisiones WHERE id_comunidad=? AND id=?', (community,file['revision_id'])).fetchone()
        return file, self._entity(conn, 'erp_remesas', community, revision['remittance_id'])

    def remittance_export(self, session, env):
        self._recent_auth(session)
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('file_id', 'acknowledge_bank_data'))
            if p['acknowledge_bank_data'] is not True:
                raise ContractError('Confirma que el fichero contiene datos bancarios completos.')
            file, rem = self._file_and_remittance(conn, e.community_id, p['file_id'])
            self._version(rem, e.expected_version)
            if rem['state'] == 'cancelada':
                raise ConflictError('La remesa esta cancelada.')
            artifact = self.vault.get(conn, e.community_id, file['secret_id'], 'remittance-file')
            if rem['state'] == 'fichero_disponible':
                self._fresh_remittance(conn,e.community_id,rem)
                validate_schedule(artifact['config'], rem['requested_on'], now)
            xml = base64.b64decode(artifact['content_base64'], validate=True)
            if hashlib.sha256(xml).hexdigest() != file['content_hash']:
                raise ContractError('La integridad del fichero no es correcta.')
            secret = self.vault.put(conn,e.community_id,'bank-presentation',self._evidence_value(e),now)
            conn.execute('''INSERT INTO erp_remesa_presentaciones
                (id_comunidad,file_id,kind,effective_on,secret_id,registered_at,actor_id) VALUES (?,?,'exportada',?,?,?,?)''',
                (e.community_id,file['id'],now[:10],secret,now,actor.user_id))
            changed = rem['state'] == 'fichero_disponible'
            if changed:
                conn.execute("UPDATE erp_remesas SET state='exportada',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,rem['id']))
            token = uuid.uuid4().hex
            expiry = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
            conn.execute('INSERT INTO erp_banca_descargas VALUES (?,?,?,?,?,?,?)',
                (token,e.community_id,file['id'],actor.user_id,session['auth_version'],expiry,now))
            return {'id': rem['id'], 'file_id': file['id'], 'download_token': token, 'version':rem['version']+int(changed),
                    'state':'exportada' if changed else rem['state'], 'mode':artifact['config']['mode'], 'creates_collection':False}
        return self._write(session,env,'export',op)

    def download_bytes(self, session, community, token):
        self._recent_auth(session)
        from .audit import write_event
        if not isinstance(token,str) or len(token)!=32:
            raise NotFoundError('Descarga bancaria no disponible.')
        conn = connect(self.database_path)
        try:
            with write_transaction(conn):
                actor,_ = self._session(conn,session,community,'export')
                grant = conn.execute('SELECT * FROM erp_banca_descargas WHERE token=? AND id_comunidad=? AND actor_id=?',
                    (token,community,actor.user_id)).fetchone()
                if not grant or grant['auth_version']!=session['auth_version'] or datetime.fromisoformat(grant['expires_at'])<datetime.now(timezone.utc):
                    raise PermissionError('La autorizacion de descarga ha caducado.')
                file, rem = self._file_and_remittance(conn,community,grant['file_id'])
                if rem['state']=='cancelada':raise ConflictError('La remesa esta cancelada.')
                data = self.vault.get(conn,community,file['secret_id'],'remittance-file')
                xml = base64.b64decode(data['content_base64'],validate=True)
                if hashlib.sha256(xml).hexdigest()!=file['content_hash']:raise ContractError('Fichero bancario no integro.')
                write_event(conn,community_id=community,actor=actor,action='erp4.file.download',entity_type='erp4_file',
                    entity_id=file['id'],before=None,after={'sha256':file['content_hash']},reason='Descarga bancaria autorizada',origin='web',
                    request_id=uuid.uuid4().hex,entity_version=rem['version'])
                return xml
        finally:conn.close()

    def presentation_record(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('file_id','effective_on','bank_reference'))
            file,rem=self._file_and_remittance(conn,e.community_id,p['file_id'])
            self._version(rem,e.expected_version)
            if rem['state']!='exportada':raise ConflictError('Solo puede registrarse la presentacion de un fichero exportado.')
            effective=day(p['effective_on'])
            if effective>now[:10]:raise ContractError('La presentacion debe haber ocurrido.')
            from .receivables_contracts import text
            ref=text(p['bank_reference'],'Referencia del banco',maximum=200)
            secret=self.vault.put(conn,e.community_id,'bank-presentation',{'bank_reference':ref,**self._evidence_value(e)},now)
            conn.execute('''INSERT INTO erp_remesa_presentaciones (id_comunidad,file_id,kind,effective_on,secret_id,registered_at,actor_id)
                VALUES (?,?,'presentada',?,?,?,?)''',(e.community_id,file['id'],effective,secret,now,actor.user_id))
            mandates={row[0] for row in conn.execute('''SELECT v.mandate_id FROM erp_remesa_lineas l JOIN erp_mandato_versiones v
                ON v.id_comunidad=l.id_comunidad AND v.id=l.mandate_version_id WHERE l.id_comunidad=? AND l.revision_id=?''',(e.community_id,file['revision_id']))}
            for mid in mandates:
                conn.execute('''INSERT INTO erp_mandato_eventos (id_comunidad,mandate_id,event_type,effective_on,secret_id,registered_at,actor_id)
                    VALUES (?,?,'presentada',?,?,?,?)''',(e.community_id,mid,effective,secret,now,actor.user_id))
            conn.execute("UPDATE erp_remesas SET state='presentada',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,rem['id']))
            return {'id':rem['id'],'version':rem['version']+1,'state':'presentada','creates_collection':False}
        return self._write(session,env,'present_cancel',op)

    def cancellation_request(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('file_id',))
            file,rem=self._file_and_remittance(conn,e.community_id,p['file_id'])
            self._version(rem,e.expected_version)
            if rem['state'] not in ('exportada','presentada','seguimiento'):
                raise ConflictError('Esta remesa no admite solicitar retirada.')
            active=conn.execute('''SELECT 1 FROM erp_remesa_reservas r JOIN erp_remesa_lineas l ON l.id=r.line_id
                WHERE r.id_comunidad=? AND l.revision_id=? AND r.state='activa' ''',(e.community_id,file['revision_id'])).fetchone()
            if not active:raise ConflictError('No quedan instrucciones activas. Un cobro requiere su operacion economica, no cancelacion local.')
            secret=self.vault.put(conn,e.community_id,'bank-presentation',self._evidence_value(e),now)
            conn.execute('''INSERT INTO erp_remesa_presentaciones (id_comunidad,file_id,kind,effective_on,secret_id,registered_at,actor_id)
                VALUES (?,?,'retirada_solicitada',?,?,?,?)''',(e.community_id,file['id'],now[:10],secret,now,actor.user_id))
            conn.execute("UPDATE erp_remesas SET state='cancelacion_solicitada',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,rem['id']))
            return {'id':rem['id'],'version':rem['version']+1,'state':'cancelacion_solicitada','reservations_released':False}
        return self._write(session,env,'present_cancel',op)

    def cancellation_not_presented(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('file_id','declare_not_presented'))
            if p['declare_not_presented'] is not True:raise ContractError('Acredita expresamente que no se ha presentado el fichero.')
            file,rem=self._file_and_remittance(conn,e.community_id,p['file_id'])
            self._version(rem,e.expected_version)
            if rem['state']!='exportada' or conn.execute("SELECT 1 FROM erp_remesa_presentaciones WHERE id_comunidad=? AND file_id=? AND kind='presentada'",(e.community_id,file['id'])).fetchone():
                raise ConflictError('Existe presentacion o resultado registrado. Solicita retirada y espera confirmacion.')
            conn.execute('''UPDATE erp_remesa_reservas SET state='liberada',finished_at=?,reason='no_presentada_acreditada'
                WHERE id_comunidad=? AND state='activa' AND line_id IN
                (SELECT id FROM erp_remesa_lineas WHERE id_comunidad=? AND revision_id=?)''',(now,e.community_id,e.community_id,file['revision_id']))
            conn.execute("UPDATE erp_remesas SET state='cancelada',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,rem['id']))
            return {'id':rem['id'],'version':rem['version']+1,'state':'cancelada','reservations_released':True}
        return self._write(session,env,'present_cancel',op)
