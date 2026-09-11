"""ERP 4 boundary: explicit bank grants, encrypted evidence, safe idempotent commands."""

from dataclasses import replace
import os
from pathlib import Path
import sqlite3

from access_control import permission, profile
from .audit import write_event
from .banking_crypto import BankVault
from .banking_mandates import MandateOperations
from .banking_remittances import RemittanceOperations
from .contracts import Actor, canonical_json
from .database import connect, write_transaction
from .errors import ConflictError, ContractError, NotFoundError
from .migrations import utc_now
from .outbox import enqueue
from .receivables_contracts import day, identity, require_fields, subject, text
from .repository import CommandRepository, FoundationRepository


CAPABILITIES = frozenset(('read_masked', 'manage_accounts', 'manage_mandates', 'configure_creditor',
                         'prepare', 'export', 'reveal', 'present_cancel', 'results', 'audit'))

COMMAND_NAMES = frozenset('erp4.' + name for name in (
    'permissions.save', 'account.create', 'account.link', 'account.state', 'creditor.create',
    'mandate.create', 'mandate.amend', 'mandate.transition', 'direct_debit.confirm',
    'notification.record', 'remittance.preview', 'remittance.prepare', 'remittance.cancel_local'))


class BankingService(MandateOperations, RemittanceOperations):
    def __init__(self, database_path, *, vault=None):
        self.database_path = str(database_path)
        self.vault = vault

    @classmethod
    def from_runtime(cls, database_path):
        # Production opt-in is intentionally independent of the migration being present.
        if os.environ.get('ERP4_BANKING_ENABLED') != '1':
            raise ContractError('La operativa bancaria aun no esta habilitada.')
        if os.environ.get('ERP4_HTTPS_READY') != '1' or os.name != 'posix':
            raise ContractError('La infraestructura bancaria segura no esta validada.')
        key_file = os.environ.get('ERP4_KEY_FILE')
        if not key_file:
            raise ContractError('Falta configurar la custodia de claves bancarias.')
        key = Path(key_file).resolve()
        app = Path(__file__).resolve().parents[2]
        if key.is_relative_to(app) or key.is_relative_to(Path(database_path).resolve().parent):
            raise ContractError('Las claves deben custodiarse fuera de la aplicacion y sus datos.')
        return cls(database_path, vault=BankVault(key_file))

    @staticmethod
    def _session(conn, session, community, capability):
        actor = Actor.from_session(session)
        current = profile(conn, actor.user_id)
        if not current or current['bloqueado'] or current['auth_version'] != session.get('auth_version'):
            raise PermissionError('La sesion bancaria no esta vigente.')
        if not permission(current, community, 'puede_ver'):
            raise PermissionError('No tienes acceso a esta comunidad.')
        FoundationRepository(conn).require_active_community(community)
        if capability == 'grant':
            if current['rol'] != 'Superusuario':
                raise PermissionError('No puedes administrar permisos bancarios.')
        else:
            if capability not in CAPABILITIES:
                raise ContractError('Capacidad bancaria desconocida.')
            row = conn.execute('SELECT allowed FROM erp_banca_permisos WHERE id_comunidad=? AND id_usuario=? AND capability=?',
                               (community, actor.user_id, capability)).fetchone()
            if not row or not row[0]:
                raise PermissionError('No tienes permiso para esta operacion bancaria.')
        return actor, current

    @staticmethod
    def _entity(conn, table, community, value):
        allowed = {'erp_cuentas_pagador', 'erp_mandatos', 'erp_acreedor_versiones', 'erp_cuentas_tesoreria',
                   'erp_mandato_versiones', 'erp_domiciliaciones', 'erp_remesas', 'erp_remesa_lineas',
                   'erp_resultados_bancarios', 'erp_prenotificaciones'}
        if table not in allowed:
            raise ContractError('Entidad bancaria desconocida.')
        row = conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? AND id=?', (community, identity(value))).fetchone()
        if not row:
            raise NotFoundError('No se encuentra el registro en esta comunidad.')
        return row

    @staticmethod
    def _version(row, expected):
        if expected is None or type(expected) is not int or row['version'] != expected:
            raise ConflictError('El registro ha cambiado. Revisa su version actual.')

    @staticmethod
    def _subject(conn, community, value):
        value = subject(value)
        table, key = ('cf_propietarios', 'id_propietario') if value['type'] == 'owner' else ('erp_personas_cobro', 'id_persona_cobro')
        if not conn.execute(f'SELECT 1 FROM {table} WHERE id_comunidad=? AND {key}=?', (community, value['id'])).fetchone():
            raise NotFoundError('El sujeto no pertenece a esta comunidad.')
        return value

    @staticmethod
    def _interval(payload):
        start = day(payload['effective_from'])
        end = day(payload['effective_until']) if payload.get('effective_until') else None
        if end and end <= start:
            raise ContractError('La fecha final debe ser posterior a la inicial.')
        return start, end

    def _protected_context(self, conn, env, session):
        if env.evidence is None or not env.reason:
            raise ContractError('Indica motivo y evidencia de esta operacion bancaria.')
        # Reuse document/community validation, not the generic document read permission.
        from .receivables_service import ReceivablesService
        ReceivablesService(self.database_path)._validate_evidence(conn, session, env)
        return {'reason': env.reason, 'evidence': {'type': env.evidence.entity_type, 'id': env.evidence.entity_id}}

    def _write(self, session, env, capability, op):
        if env.command not in COMMAND_NAMES:
            raise ContractError('Comando bancario no registrado.')
        if self.vault is None:
            raise ContractError('La custodia bancaria no esta configurada.')
        if not env.idempotency_key:
            raise ContractError('La operacion bancaria requiere idempotencia.')
        if env.origin in ('ai', 'agent'):
            raise PermissionError('Las operaciones bancarias requieren confirmacion humana directa.')
        conn = connect(self.database_path)
        try:
            with write_transaction(conn):
                actor, _ = self._session(conn, session, env.community_id, capability)
                context = self._protected_context(conn, env, session)
                request = {'actor': actor.user_id, 'payload': env.payload, 'version': env.expected_version,
                           'context': context, 'origin': env.origin}
                # Never persist a raw request hash or caller-supplied key containing bank data.
                request_digests = self.vault.fingerprints(env.community_id, env.command, request)
                key_digests = self.vault.fingerprints(env.community_id, 'command-key', env.idempotency_key)
                key_id = self.vault.active_index
                for candidate, digest in key_digests.items():
                    if conn.execute('SELECT 1 FROM erp_command_log WHERE id_comunidad=? AND command_name=? AND idempotency_key=?',
                                    (env.community_id, env.command, 'bank-' + digest)).fetchone():
                        key_id = candidate
                        break
                safe = replace(env, payload={'fingerprint': request_digests[key_id]},
                               reason='Contexto bancario protegido', evidence=None,
                               idempotency_key='bank-' + key_digests[key_id])
                repo = CommandRepository(conn)
                replay = repo.replay_or_start(safe, actor)
                if replay is not None:
                    return replay
                now = utc_now()
                protected = self.vault.put(conn, env.community_id, 'operation-context', context, now)
                result = op(conn, actor, env, now)
                audit = write_event(conn, community_id=env.community_id, actor=actor, action=env.command,
                                    entity_type='erp4_operation', entity_id=result.get('id'), before=None,
                                    after=result, reason=safe.reason, origin=env.origin, request_id=safe.idempotency_key,
                                    entity_version=result.get('version'), metadata={'protected_context_id': protected})
                outbox = enqueue(conn, community_id=env.community_id, event_type=env.command,
                                 aggregate_type='erp4_operation', aggregate_id=result.get('id'),
                                 payload={'audit_event_id': audit}, dedupe_key=safe.idempotency_key)
                response = {'ok': True, 'entity': result, 'audit_event_id': audit,
                            'outbox_event_id': outbox, 'idempotent_replay': False}
                repo.complete(safe, response)
                return response
        except sqlite3.IntegrityError:
            raise ConflictError('El registro bancario entra en conflicto con sus relaciones o con otra operacion.') from None
        finally:
            conn.close()

    def _read(self, session, query, capability, op):
        conn = connect(self.database_path, readonly=True)
        try:
            conn.execute('BEGIN')
            self._session(conn, session, query.community_id, capability)
            return {'ok': True, 'entity': op(conn, query)}
        finally:
            conn.close()

    def permissions_save(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('user_id', 'capability', 'allowed'))
            user = identity(p['user_id'])
            if p['capability'] not in CAPABILITIES or type(p['allowed']) is not bool:
                raise ContractError('Permiso bancario no valido.')
            target = profile(conn, user)
            if not target or not permission(target, e.community_id, 'puede_ver'):
                raise PermissionError('El usuario no tiene acceso a esta comunidad.')
            row = conn.execute('SELECT version FROM erp_banca_permisos WHERE id_comunidad=? AND id_usuario=? AND capability=?',
                               (e.community_id, user, p['capability'])).fetchone()
            version = row[0] if row else 0
            if e.expected_version != version:
                raise ConflictError('Revisa la version actual del permiso.')
            conn.execute('''INSERT INTO erp_banca_permisos
                (id_comunidad,id_usuario,capability,allowed,version,actor_id,registered_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(id_comunidad,id_usuario,capability) DO UPDATE SET allowed=excluded.allowed,
                version=excluded.version,actor_id=excluded.actor_id,registered_at=excluded.registered_at''',
                         (e.community_id, user, p['capability'], int(p['allowed']), version + 1, actor.user_id, now))
            return {'user_id': user, 'capability': p['capability'], 'allowed': p['allowed'], 'version': version + 1}
        return self._write(session, env, 'grant', op)

    def _account_public(self, row):
        return {'id': row['id'], 'masked': row['country'] + '** **** ... ' + row['last_four'],
                'state': row['state'], 'version': row['version']}

    def _account_create(self, conn, actor, e, now):
        p = require_fields(e.payload, ('iban',), ('alias', 'bic'))
        from stdnum import iban
        try:
            number = iban.validate(text(p['iban'], 'Cuenta', maximum=64))
        except Exception:
            raise ContractError('El IBAN no es valido.') from None
        fingerprints = self.vault.fingerprints(e.community_id, 'iban', number)
        for key_id, digest in fingerprints.items():
            found = conn.execute('SELECT account_id FROM erp_cuenta_huellas WHERE id_comunidad=? AND key_id=? AND digest=?',
                                 (e.community_id, key_id, digest)).fetchone()
            if found:
                return {**self._account_public(self._entity(conn, 'erp_cuentas_pagador', e.community_id, found[0])), 'existing': True}
        secret = self.vault.put(conn, e.community_id, 'payer-account', {'iban': number}, now)
        account = conn.execute('''INSERT INTO erp_cuentas_pagador(id_comunidad,secret_id,country,last_four,registered_at,actor_id)
            VALUES (?,?,?,?,?,?)''', (e.community_id, secret, number[:2], number[-4:], now, actor.user_id)).lastrowid
        for key_id, digest in fingerprints.items():
            conn.execute('INSERT INTO erp_cuenta_huellas(id_comunidad,account_id,key_id,digest) VALUES (?,?,?,?)',
                         (e.community_id, account, key_id, digest))
        metadata = {'alias': text(p.get('alias', ''), 'Alias', required=False, maximum=100),
                    'bic': text(p.get('bic', ''), 'BIC', required=False, maximum=11)}
        secret = self.vault.put(conn, e.community_id, 'payer-account-metadata', metadata, now)
        conn.execute('''INSERT INTO erp_cuenta_pagador_versiones(id_comunidad,account_id,version,secret_id,registered_at,actor_id)
            VALUES (?,?,1,?,?,?)''', (e.community_id, account, secret, now, actor.user_id))
        return self._account_public(self._entity(conn, 'erp_cuentas_pagador', e.community_id, account))

    def account_create(self, session, env):
        return self._write(session, env, 'manage_accounts', self._account_create)

    def account_list(self, session, query):
        def op(conn, q):
            require_fields(q.filters, (), ('offset', 'limit'))
            offset = q.filters.get('offset', 0)
            limit = q.filters.get('limit', 100)
            if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
                raise ContractError('Paginacion no valida.')
            rows = conn.execute('SELECT * FROM erp_cuentas_pagador WHERE id_comunidad=? ORDER BY id LIMIT ? OFFSET ?',
                                (q.community_id, limit, offset)).fetchall()
            count = conn.execute('SELECT count(*) FROM erp_cuentas_pagador WHERE id_comunidad=?', (q.community_id,)).fetchone()[0]
            return {'items': [self._account_public(r) for r in rows], 'total': count}
        return self._read(session, query, 'read_masked', op)

    def account_link(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('account_id', 'subject', 'role', 'effective_from'), ('effective_until',))
            account = self._entity(conn, 'erp_cuentas_pagador', e.community_id, p['account_id'])
            self._version(account, e.expected_version)
            if account['state'] != 'activa' or p['role'] not in ('titular', 'cotitular', 'autorizado', 'pagador'):
                raise ContractError('Cuenta o relacion no disponible.')
            who = self._subject(conn, e.community_id, p['subject'])
            start, end = self._interval(p)
            owner, person = (who['id'], None) if who['type'] == 'owner' else (None, who['id'])
            if conn.execute('''SELECT 1 FROM erp_cuenta_personas WHERE id_comunidad=? AND account_id=?
                AND owner_id IS ? AND person_id IS ? AND role=? AND effective_from<COALESCE(?,'9999-12-31')
                AND COALESCE(effective_until,'9999-12-31')>?''',
                            (e.community_id, account['id'], owner, person, p['role'], end, start)).fetchone():
                raise ConflictError('Ya existe una relacion vigente para ese sujeto y papel.')
            evidence = self.vault.put(conn, e.community_id, 'account-relationship',
                                      {'reason': e.reason, 'evidence': {'type': e.evidence.entity_type, 'id': e.evidence.entity_id}}, now)
            link = conn.execute('''INSERT INTO erp_cuenta_personas
                (id_comunidad,account_id,owner_id,person_id,role,effective_from,effective_until,evidence_secret_id,registered_at,actor_id)
                VALUES (?,?,?,?,?,?,?,?,?,?)''', (e.community_id, account['id'], owner, person, p['role'], start, end,
                                               evidence, now, actor.user_id)).lastrowid
            conn.execute('UPDATE erp_cuentas_pagador SET version=version+1 WHERE id_comunidad=? AND id=?',
                         (e.community_id, account['id']))
            return {'id': account['id'], 'relationship_id': link, 'version': account['version'] + 1}
        return self._write(session, env, 'manage_accounts', op)

    def account_state(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('id', 'state'))
            account = self._entity(conn, 'erp_cuentas_pagador', e.community_id, p['id'])
            self._version(account, e.expected_version)
            if p['state'] not in ('activa', 'bloqueada', 'cerrada') or account['state'] == 'cerrada':
                raise ContractError('Transicion de cuenta no permitida.')
            conn.execute('UPDATE erp_cuentas_pagador SET state=?,version=version+1 WHERE id_comunidad=? AND id=?',
                         (p['state'], e.community_id, account['id']))
            # Do not change the immutable file: expose affected active instructions for review.
            conn.execute('''UPDATE erp_remesas SET needs_review=1,version=version+1 WHERE id_comunidad=? AND id IN
                (SELECT r.remittance_id FROM erp_remesa_revisiones r JOIN erp_remesa_lineas l ON l.revision_id=r.id
                 JOIN erp_mandato_versiones m ON m.id=l.mandate_version_id
                 JOIN erp_remesa_reservas v ON v.line_id=l.id AND v.state='activa'
                 WHERE m.id_comunidad=? AND m.account_id=?)''', (e.community_id, e.community_id, account['id']))
            return self._account_public(self._entity(conn, 'erp_cuentas_pagador', e.community_id, account['id']))
        return self._write(session, env, 'manage_accounts', op)
