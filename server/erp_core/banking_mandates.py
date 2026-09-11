"""Versioned bank authorizations. Property ownership is never edited here."""

from datetime import date
import json
import re
import uuid

from .errors import ConflictError, ContractError, NotFoundError
from .receivables_contracts import day, identity, require_fields, text


class MandateOperations:
    @staticmethod
    def _evidence_value(e):
        return {'reason': e.reason, 'evidence': {'type': e.evidence.entity_type, 'id': e.evidence.entity_id}}

    @staticmethod
    def _creditor_identifier(value):
        value = re.sub(r'\s+', '', text(value, 'Identificador de acreedor', maximum=70)).upper()
        if not re.fullmatch(r'[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{1,28}', value):
            raise ContractError('Identificador de acreedor no valido.')
        # EPC checksum excludes the three-character business code.
        rearranged = value[7:] + value[:4]
        digits = ''.join(str(ord(c) - 55) if c.isalpha() else c for c in rearranged)
        if int(digits) % 97 != 1:
            raise ContractError('El identificador de acreedor no supera la validacion.')
        return value, value[:4] + value[7:]

    def creditor_create(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('name', 'creditor_identifier', 'iban', 'address', 'effective_from'), ('effective_until',))
            from stdnum import iban
            try:
                number = iban.validate(text(p['iban'], 'Cuenta acreedora', maximum=64))
            except Exception:
                raise ContractError('La cuenta acreedora no es valida.') from None
            cid, canonical = self._creditor_identifier(p['creditor_identifier'])
            start, end = self._interval(p)
            address = require_fields(p['address'], ('country', 'town'), ('street', 'building', 'postal_code'))
            for field, value in address.items():
                text(value, 'Direccion', maximum=100)
            if not re.fullmatch(r'[A-Z]{2}', address['country']):
                raise ContractError('Pais de direccion no valido.')
            details = {'name': text(p['name'], 'Nombre acreedor', maximum=70), 'creditor_identifier': cid,
                       'canonical_identifier': canonical, 'address': address, **self._evidence_value(e)}
            treasury_secret = self.vault.put(conn, e.community_id, 'treasury-account', {'iban': number}, now)
            treasury = conn.execute('''INSERT INTO erp_cuentas_tesoreria
                (id_comunidad,kind,currency,secret_id,registered_at,actor_id) VALUES (?,'banco','EUR',?,?,?)''',
                                    (e.community_id, treasury_secret, now, actor.user_id)).lastrowid
            secret = self.vault.put(conn, e.community_id, 'creditor', details, now)
            cid = conn.execute('''INSERT INTO erp_acreedor_versiones
                (id_comunidad,treasury_id,secret_id,profile_id,effective_from,effective_until,version,registered_at,actor_id)
                VALUES (?,?,?,'core-2025-v1.1-pain008v08',?,?,1,?,?)''',
                               (e.community_id, treasury, secret, start, end, now, actor.user_id)).lastrowid
            return {'id': cid, 'version': 1, 'treasury_id': treasury, 'bank_activation_pending': True}
        return self._write(session, env, 'configure_creditor', op)

    def _mandate_public(self, row):
        return {'id': row['id'], 'creditor_id': row['creditor_id'], 'kind': row['kind'],
                'scheme': row['scheme'], 'state': row['state'], 'version': row['version']}

    def _mandate_revision(self, conn, actor, e, now, mandate, p):
        account = self._entity(conn, 'erp_cuentas_pagador', e.community_id, p['account_id'])
        if account['state'] != 'activa':
            raise ContractError('La cuenta no esta activa.')
        debtor = self._subject(conn, e.community_id, p['debtor'])
        start, end = self._interval(p)
        signed = day(p['signed_on'])
        if signed > start or signed > date.today().isoformat():
            raise ContractError('Revisa la fecha de firma y la fecha efectiva.')
        if not isinstance(p['signers'], list) or not 1 <= len(p['signers']) <= 20:
            raise ContractError('El mandato requiere al menos un firmante acreditado.')
        signers = []
        for signer in p['signers']:
            require_fields(signer, ('subject', 'capacity'))
            who = self._subject(conn, e.community_id, signer['subject'])
            signers.append({'subject': who, 'capacity': text(signer['capacity'], 'Representacion', maximum=200)})
        if len({(s['subject']['type'], s['subject']['id']) for s in signers}) != len(signers):
            raise ContractError('No repitas un firmante.')
        properties = p['property_ids']
        if not isinstance(properties, list) or not properties or len(properties) > 10000:
            raise ContractError('Indica las propiedades cubiertas por el mandato.')
        properties = [identity(v) for v in properties]
        if len(set(properties)) != len(properties):
            raise ContractError('Hay propiedades repetidas.')
        for prop in properties:
            if not conn.execute('SELECT 1 FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?', (e.community_id, prop)).fetchone():
                raise NotFoundError('Propiedad no disponible en esta comunidad.')
        name = text(p['debtor_name'], 'Nombre del deudor bancario', maximum=70)
        address = require_fields(p['address'], ('country', 'town'), ('street', 'building', 'postal_code'))
        for field, value in address.items():
            text(value, 'Direccion', maximum=100)
        if not re.fullmatch(r'[A-Z]{2}', address['country']):
            raise ContractError('Pais no valido.')
        previous = conn.execute('SELECT * FROM erp_mandato_versiones WHERE id_comunidad=? AND mandate_id=? ORDER BY version DESC LIMIT 1',
                                (e.community_id, mandate['id'])).fetchone()
        if previous:
            if start <= previous['effective_from']:
                raise ConflictError('La modificacion debe tener fecha posterior a la revision anterior.')
            if (previous['debtor_owner_id'], previous['debtor_person_id']) != (
                    debtor['id'] if debtor['type'] == 'owner' else None, debtor['id'] if debtor['type'] == 'person' else None):
                raise ContractError('Un deudor bancario diferente requiere un mandato nuevo.')
            signed = previous['signed_on']
        details = {'debtor_name': name, 'address': address, 'property_ids': sorted(properties),
                   'signers': signers, 'evidence': self._evidence_value(e), 'amendment': previous is not None}
        secret = self.vault.put(conn, e.community_id, 'mandate-version', details, now)
        version = previous['version'] + 1 if previous else 1
        row_id = conn.execute('''INSERT INTO erp_mandato_versiones
            (id_comunidad,mandate_id,account_id,debtor_owner_id,debtor_person_id,secret_id,signed_on,effective_from,
             effective_until,version,supersedes_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            (e.community_id, mandate['id'], account['id'], debtor['id'] if debtor['type'] == 'owner' else None,
             debtor['id'] if debtor['type'] == 'person' else None, secret, signed, start, end, version,
             previous['id'] if previous else None, now, actor.user_id)).lastrowid
        for signer in signers:
            who = signer['subject']
            conn.execute('''INSERT INTO erp_mandato_firmantes
                (id_comunidad,mandate_version_id,owner_id,person_id,evidence_secret_id) VALUES (?,?,?,?,?)''',
                (e.community_id, row_id, who['id'] if who['type'] == 'owner' else None,
                 who['id'] if who['type'] == 'person' else None, secret))
        for prop in properties:
            conn.execute('INSERT INTO erp_mandato_propiedades(id_comunidad,mandate_version_id,property_id) VALUES (?,?,?)',
                         (e.community_id, row_id, prop))
        return row_id

    def mandate_create(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('creditor_id', 'kind', 'account_id', 'debtor', 'debtor_name', 'address',
                'signers', 'signed_on', 'effective_from', 'property_ids'), ('effective_until', 'rum'))
            creditor = self._entity(conn, 'erp_acreedor_versiones', e.community_id, p['creditor_id'])
            if p['kind'] not in ('recurrente', 'puntual'):
                raise ContractError('Tipo de mandato no valido.')
            rum = p.get('rum') or 'M' + uuid.uuid4().hex.upper()
            if not isinstance(rum, str) or not re.fullmatch(r'[A-Za-z0-9+?/:().,\- ]{1,35}', rum) or rum != rum.strip() or rum.startswith('/') or rum.endswith('/') or '//' in rum:
                raise ContractError('La referencia de mandato no cumple el formato admitido.')
            creditor_data = self.vault.get(conn, e.community_id, creditor['secret_id'], 'creditor')
            # The opaque global guard prevents creditor/RUM collisions without cross-tenant disclosure.
            fps = self.vault.fingerprints(0, 'creditor-rum', [creditor_data['canonical_identifier'], rum.upper()])
            for key_id, digest in fps.items():
                if conn.execute('SELECT 1 FROM erp_mandato_huellas WHERE key_id=? AND digest=?', (key_id, digest)).fetchone():
                    raise ConflictError('La referencia de mandato ya esta registrada; revisa su procedencia.')
            secret = self.vault.put(conn, e.community_id, 'mandate-identity', {'rum': rum}, now)
            mid = conn.execute('''INSERT INTO erp_mandatos
                (id_comunidad,creditor_id,kind,scheme,state,rum_secret_id,registered_at,actor_id)
                VALUES (?,?,?,'CORE','pendiente',?,?,?)''', (e.community_id, creditor['id'], p['kind'], secret, now, actor.user_id)).lastrowid
            for key_id, digest in fps.items():
                conn.execute('INSERT INTO erp_mandato_huellas(key_id,digest,id_comunidad,mandate_id) VALUES (?,?,?,?)',
                             (key_id, digest, e.community_id, mid))
            mandate = self._entity(conn, 'erp_mandatos', e.community_id, mid)
            self._mandate_revision(conn, actor, e, now, mandate, p)
            self._mandate_event(conn, actor, e, now, mid, 'alta', p['effective_from'])
            return self._mandate_public(mandate)
        return self._write(session, env, 'manage_mandates', op)

    def _mandate_event(self, conn, actor, e, now, mid, kind, effective):
        secret = self.vault.put(conn, e.community_id, 'mandate-event', self._evidence_value(e), now)
        conn.execute('''INSERT INTO erp_mandato_eventos
            (id_comunidad,mandate_id,event_type,effective_on,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,?)''',
            (e.community_id, mid, kind, day(effective), secret, now, actor.user_id))

    def _flag_mandate(self, conn, community, mid):
        conn.execute('''UPDATE erp_remesas SET needs_review=1,version=version+1 WHERE id_comunidad=? AND id IN
            (SELECT r.remittance_id FROM erp_remesa_revisiones r JOIN erp_remesa_lineas l ON l.revision_id=r.id
             JOIN erp_mandato_versiones m ON m.id=l.mandate_version_id
             JOIN erp_remesa_reservas v ON v.line_id=l.id AND v.state='activa'
             WHERE m.id_comunidad=? AND m.mandate_id=?)''', (community, community, mid))

    def mandate_amend(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('id', 'account_id', 'debtor', 'debtor_name', 'address', 'signers',
                'signed_on', 'effective_from', 'property_ids'), ('effective_until',))
            mandate = self._entity(conn, 'erp_mandatos', e.community_id, p['id'])
            self._version(mandate, e.expected_version)
            if mandate['state'] not in ('activo', 'pendiente', 'suspendido'):
                raise ContractError('El mandato no permite modificaciones.')
            self._mandate_revision(conn, actor, e, now, mandate, p)
            conn.execute("UPDATE erp_mandatos SET version=version+1,state='pendiente' WHERE id_comunidad=? AND id=?",
                         (e.community_id, mandate['id']))
            self._mandate_event(conn, actor, e, now, mandate['id'], 'modificacion', p['effective_from'])
            self._flag_mandate(conn, e.community_id, mandate['id'])
            return self._mandate_public(self._entity(conn, 'erp_mandatos', e.community_id, mandate['id']))
        return self._write(session, env, 'manage_mandates', op)

    def mandate_transition(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('id', 'state', 'effective_on'))
            mandate = self._entity(conn, 'erp_mandatos', e.community_id, p['id'])
            self._version(mandate, e.expected_version)
            transitions = {'pendiente': {'activo', 'revocado'}, 'activo': {'suspendido', 'revocado'},
                           'suspendido': {'activo', 'revocado'}}
            if p['state'] not in transitions.get(mandate['state'], set()):
                raise ContractError('Transicion de mandato no permitida.')
            effective = day(p['effective_on'])
            if effective > date.today().isoformat():
                raise ContractError('Registra la transicion cuando sea efectiva; no anticipes el estado.')
            if p['state'] == 'activo':
                revision = conn.execute('SELECT * FROM erp_mandato_versiones WHERE id_comunidad=? AND mandate_id=? ORDER BY version DESC LIMIT 1',
                                        (e.community_id, mandate['id'])).fetchone()
                if not revision or not conn.execute('SELECT 1 FROM erp_mandato_firmantes WHERE id_comunidad=? AND mandate_version_id=?',
                                                    (e.community_id, revision['id'])).fetchone():
                    raise ContractError('Falta evidencia de firma del mandato.')
                if self._entity(conn, 'erp_cuentas_pagador', e.community_id, revision['account_id'])['state'] != 'activa':
                    raise ContractError('La cuenta del mandato no esta activa.')
            self._mandate_event(conn, actor, e, now, mandate['id'], p['state'], effective)
            conn.execute('UPDATE erp_mandatos SET state=?,version=version+1 WHERE id_comunidad=? AND id=?',
                         (p['state'], e.community_id, mandate['id']))
            self._flag_mandate(conn, e.community_id, mandate['id'])
            return self._mandate_public(self._entity(conn, 'erp_mandatos', e.community_id, mandate['id']))
        return self._write(session, env, 'manage_mandates', op)

    def mandate_detail(self, session, query):
        def op(conn, q):
            require_fields(q.filters, ('id',))
            mandate = self._entity(conn, 'erp_mandatos', q.community_id, q.filters['id'])
            revisions = [dict(r) for r in conn.execute('''SELECT v.id,v.version,v.account_id,v.signed_on,v.effective_from,
                v.effective_until,v.supersedes_id,v.registered_at FROM erp_mandato_versiones v
                WHERE v.id_comunidad=? AND v.mandate_id=? ORDER BY v.version DESC''', (q.community_id, mandate['id']))]
            for revision in revisions:
                account = self._entity(conn, 'erp_cuentas_pagador', q.community_id, revision['account_id'])
                revision['account'] = self._account_public(account)
            events = [dict(r) for r in conn.execute('SELECT id,event_type,effective_on,registered_at FROM erp_mandato_eventos WHERE id_comunidad=? AND mandate_id=? ORDER BY id',
                                                   (q.community_id, mandate['id']))]
            return {**self._mandate_public(mandate), 'revisions': revisions, 'events': events}
        return self._read(session, query, 'read_masked', op)

    def direct_debit_confirm(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('billing_config_ids', 'mandate_id', 'effective_from'), ('effective_until',))
            mandate = self._entity(conn, 'erp_mandatos', e.community_id, p['mandate_id'])
            self._version(mandate, e.expected_version)
            if mandate['state'] != 'activo':
                raise ContractError('El mandato no esta activo.')
            start, end = self._interval(p)
            revision = conn.execute('''SELECT * FROM erp_mandato_versiones WHERE id_comunidad=? AND mandate_id=?
                AND effective_from<=? ORDER BY version DESC LIMIT 1''', (e.community_id, mandate['id'], start)).fetchone()
            if not revision or (revision['effective_until'] and revision['effective_until'] <= start):
                raise ContractError('El mandato no cubre la fecha efectiva.')
            covered = {r[0] for r in conn.execute('SELECT property_id FROM erp_mandato_propiedades WHERE id_comunidad=? AND mandate_version_id=?',
                                                (e.community_id, revision['id']))}
            configs = p['billing_config_ids']
            if not isinstance(configs, list) or not 1 <= len(configs) <= 10000:
                raise ContractError('Selecciona configuraciones de cobro.')
            configs = [identity(v) for v in configs]
            if len(configs) != len(set(configs)):
                raise ContractError('No repitas una configuracion.')
            result = []
            secret = self.vault.put(conn, e.community_id, 'direct-debit-evidence', self._evidence_value(e), now)
            for config in configs:
                billing = conn.execute('SELECT * FROM erp_config_recibo_versiones WHERE id_comunidad=? AND id_config_recibo=?',
                                       (e.community_id, config)).fetchone()
                if not billing or billing['estado'] != 'confirmada' or billing['id_propiedad'] not in covered:
                    raise ContractError('La configuracion no esta confirmada o no esta cubierta por el mandato.')
                if (billing['efectiva_desde'] and billing['efectiva_desde'] > start) or (billing['efectiva_hasta'] and billing['efectiva_hasta'] <= start):
                    raise ContractError('La configuracion de pagador no cubre esa fecha.')
                if (billing['pagador_propietario_id'], billing['pagador_persona_cobro_id']) != (revision['debtor_owner_id'], revision['debtor_person_id']):
                    raise ContractError('El pagador configurado no coincide con el deudor bancario autorizado.')
                existing = conn.execute('SELECT * FROM erp_domiciliaciones WHERE id_comunidad=? AND property_id=? AND scope=? AND concept_key=?',
                                        (e.community_id, billing['id_propiedad'], billing['alcance'], billing['concepto_clave'] or '')).fetchone()
                if existing:
                    # Replacement is a separate revision operation, not a blind bulk overwrite.
                    raise ConflictError('Ya existe domiciliacion para una propiedad. Revisa su historico antes de sustituirla.')
                did = conn.execute('''INSERT INTO erp_domiciliaciones
                    (id_comunidad,property_id,scope,concept_key,registered_at,actor_id) VALUES (?,?,?,?,?,?)''',
                    (e.community_id, billing['id_propiedad'], billing['alcance'], billing['concepto_clave'] or '', now, actor.user_id)).lastrowid
                conn.execute('''INSERT INTO erp_domiciliacion_versiones
                    (id_comunidad,direct_debit_id,billing_config_id,mandate_id,effective_from,effective_until,state,version,
                     evidence_secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,'activa',1,?,?,?)''',
                    (e.community_id, did, config, mandate['id'], start, end, secret, now, actor.user_id))
                result.append(did)
            return {'id': mandate['id'], 'direct_debit_ids': result, 'count': len(result), 'version': mandate['version']}
        return self._write(session, env, 'manage_mandates', op)
