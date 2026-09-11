"""ERP 4 foundation tests on independent SQLite copies. No production writes."""

import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from datetime import date, timedelta
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from threading import Barrier
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
from access_control import profile
from erp_core.banking_crypto import BankVault
from erp_core.banking_service import BankingService, CAPABILITIES
from erp_core.contracts import CommandEnvelope, QueryEnvelope
from erp_core.database import connect, write_transaction
from erp_core.errors import ContractError, ConflictError
from erp_core.migrations import apply_all, MIGRATIONS
from erp_core.receivables_service import ReceivablesService
from erp_core.receivables_projection import receipt_balance

SOURCE = Path(sys.argv[1]).resolve()
sys.argv = sys.argv[:1]
WORK = Path(tempfile.mkdtemp(prefix='organizador-erp4-foundations-'))
IBAN = 'ES9121000418450200051332'  # Public validation example, only in isolated fixtures.


def backup(source, target):
    with closing(sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True)) as src:
        with closing(sqlite3.connect(target)) as dst:
            src.backup(dst)


class BankingTests(unittest.TestCase):
    def setUp(self):
        self.work = WORK / self._testMethodName
        self.work.mkdir()
        self.db = self.work / 'database.db'
        backup(SOURCE, self.db)
        self.conn = connect(self.db)
        self.baseline = {t: [tuple(r) for r in self.conn.execute('SELECT * FROM ' + t)]
                         for t in ('erp_recibos', 'erp_cobros', 'erp_imputaciones', 'erp_devoluciones', 'cf_recibos', 'cf_movimientos_deuda')}
        apply_all(self.conn)
        self.uid = self.conn.execute("SELECT id_usuario FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()[0]
        self.session = profile(self.conn, self.uid)
        self.community = self.session['comunidades'][0]['id_comunidad']
        self.key = BankVault.create_key_file(self.work / 'test-custody.key')
        self.vault = BankVault(self.key)
        self.service = BankingService(self.db, vault=self.vault)
        self.sequence = 0
        self.synthetic_receipts = set()

    def tearDown(self):
        for table, rows in self.baseline.items():
            current = [tuple(r) for r in self.conn.execute('SELECT * FROM ' + table)
                       if not (table == 'erp_recibos' and r['id'] in self.synthetic_receipts)]
            self.assertEqual(current, rows, table)
        self.assertEqual(self.conn.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        self.assertEqual(self.conn.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.conn.close()

    def envelope(self, name, payload, *, version=None, key=None, community=None):
        self.sequence += 1
        return CommandEnvelope.from_value({'command': 'erp4.' + name, 'id_comunidad': community or self.community,
            'payload': payload, 'idempotency_key': key or 'fixture-' + str(self.sequence), 'expected_version': version,
            'reason': 'Evidencia sintetica de prueba', 'origin': 'test',
            'evidence': {'type': 'external_reference', 'id': 'synthetic-evidence'}})

    def grant(self, capability):
        return self.service.permissions_save(self.session, self.envelope('permissions.save',
            {'user_id': self.uid, 'capability': capability, 'allowed': True}, version=0))

    def account(self):
        self.grant('manage_accounts')
        return self.service.account_create(self.session, self.envelope('account.create', {'iban': IBAN}))['entity']

    def mandate_setup(self):
        a = self.account()
        self.grant('configure_creditor')
        self.grant('manage_mandates')
        country, suffix = 'ES', 'M12345678'
        digits = ''.join(str(ord(c) - 55) if c.isalpha() else c for c in suffix + country + '00')
        creditor_code = country + str(98 - int(digits) % 97).zfill(2) + '000' + suffix
        creditor = self.service.creditor_create(self.session, self.envelope('creditor.create', {
            'name': 'Comunidad sintetica', 'creditor_identifier': creditor_code, 'iban': IBAN,
            'address': {'country': 'ES', 'town': 'Madrid'}, 'effective_from': '2026-01-01'}))['entity']
        owner = self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? LIMIT 1', (self.community,)).fetchone()[0]
        properties = [r[0] for r in self.conn.execute('SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=? LIMIT 3', (self.community,))]
        payload = {'creditor_id': creditor['id'], 'kind': 'recurrente', 'account_id': a['id'],
            'debtor': {'type': 'owner', 'id': owner}, 'debtor_name': 'Pagador sintetico',
            'address': {'country': 'ES', 'town': 'Madrid'}, 'signers': [{'subject': {'type': 'owner', 'id': owner}, 'capacity': 'Titular acreditado'}],
            'signed_on': '2026-01-01', 'effective_from': '2026-01-01', 'property_ids': properties, 'rum': 'SYNTHETIC-MANDATE'}
        mandate = self.service.mandate_create(self.session, self.envelope('mandate.create', payload))['entity']
        return a, mandate, payload

    def test_01_migration_reentrant_preserves_old_checksums(self):
        before = list(self.conn.execute('SELECT version,checksum FROM erp_schema_migrations'))
        apply_all(self.conn)
        self.assertEqual(before, list(self.conn.execute('SELECT version,checksum FROM erp_schema_migrations')))
        self.assertEqual(before[-1][0], 15)
        self.assertEqual(len(MIGRATIONS), 15)
        for name in ('erp_cuentas_pagador', 'erp_mandatos', 'erp_remesa_reservas', 'erp_banco_operaciones'):
            self.assertEqual(self.conn.execute('SELECT count(*) FROM ' + name).fetchone()[0], 0)

    def test_02_no_implicit_bank_permission_even_superuser(self):
        with self.assertRaises(PermissionError):
            self.service.account_create(self.session, self.envelope('account.create', {'iban': IBAN}))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_banca_secretos').fetchone()[0], 0)

    def test_03_ciphertext_and_masked_read(self):
        a = self.account()
        self.grant('read_masked')
        q = QueryEnvelope('erp4.accounts.list', self.community, {})
        result = self.service.account_list(self.session, q)
        self.assertEqual(result['entity']['items'][0]['masked'], 'ES** **** ... 1332')
        self.assertNotIn(IBAN, json.dumps(result))
        secret_id = self.conn.execute('SELECT secret_id FROM erp_cuentas_pagador WHERE id=?', (a['id'],)).fetchone()[0]
        self.assertEqual(self.vault.get(self.conn, self.community, secret_id, 'payer-account')['iban'], IBAN)
        for table in ('erp_banca_secretos', 'erp_command_log', 'erp_audit_events', 'erp_outbox'):
            self.assertNotIn(IBAN, repr([tuple(r) for r in self.conn.execute('SELECT * FROM ' + table)]), table)
        self.assertNotIn(IBAN.encode(), self.db.read_bytes())

    def test_04_replay_and_domain_account_deduplication(self):
        self.grant('manage_accounts')
        e = self.envelope('account.create', {'iban': IBAN})
        first = self.service.account_create(self.session, e)
        self.assertTrue(self.service.account_create(self.session, e)['idempotent_replay'])
        other = self.service.account_create(self.session, self.envelope('account.create', {'iban': IBAN.lower()}))
        self.assertEqual(first['entity']['id'], other['entity']['id'])
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cuentas_pagador').fetchone()[0], 1)
        with self.assertRaises(ConflictError):
            self.service.account_create(self.session, replace(e, payload={'iban': 'DE89370400440532013000'}))

    def test_05_invalid_iban_rolls_back_everything(self):
        self.grant('manage_accounts')
        counts = {t: self.conn.execute('SELECT count(*) FROM ' + t).fetchone()[0]
                  for t in ('erp_banca_secretos', 'erp_command_log', 'erp_audit_events', 'erp_outbox')}
        with self.assertRaises(ContractError):
            self.service.account_create(self.session, self.envelope('account.create', {'iban': IBAN[:-1] + '1'}))
        for t, count in counts.items():
            self.assertEqual(self.conn.execute('SELECT count(*) FROM ' + t).fetchone()[0], count)

    def test_06_ciphertext_tamper_and_wrong_context(self):
        account = self.account()
        row = self.conn.execute('SELECT * FROM erp_banca_secretos WHERE purpose=?', ('payer-account',)).fetchone()
        with self.assertRaises(ContractError):
            self.vault.get(self.conn, self.community + 9999, row['id'], 'payer-account')
        with self.assertRaises(ContractError):
            self.vault.get(self.conn, self.community, row['id'], 'operation-context')
        sealed = json.loads(row['sealed'])
        content = bytearray(base64.b64decode(sealed['ciphertext']))
        content[0] ^= 1
        sealed['ciphertext'] = base64.b64encode(content).decode()
        self.conn.execute('UPDATE erp_banca_secretos SET sealed=? WHERE id=?', (json.dumps(sealed), row['id']))
        with self.assertRaises(ContractError):
            self.vault.get(self.conn, self.community, row['id'], 'payer-account')
        self.assertTrue(account['masked'])

    def test_07_key_custody_and_restoration(self):
        self.account()
        target = self.work / 'restored.db'
        backup(self.db, target)
        restored = connect(target)
        try:
            secret = restored.execute("SELECT id FROM erp_banca_secretos WHERE purpose='payer-account'").fetchone()[0]
            self.assertEqual(BankVault(self.key).get(restored, self.community, secret, 'payer-account')['iban'], IBAN)
            wrong = BankVault.create_key_file(self.work / 'wrong.key')
            with self.assertRaises(ContractError):
                BankVault(wrong).get(restored, self.community, secret, 'payer-account')
            self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        finally:
            restored.close()
        with self.assertRaises(FileExistsError):
            BankVault.create_key_file(self.key)

    def test_08_rotation_keeps_payload_unchanged(self):
        self.account()
        rows = list(self.conn.execute('SELECT id,sealed FROM erp_banca_secretos'))
        keys = json.loads(self.key.read_text())
        keys['encryption_keys']['enc-2'] = base64.b64encode(os.urandom(32)).decode()
        keys['active_encryption_key'] = 'enc-2'
        self.key.write_text(json.dumps(keys))
        rotated = BankVault(self.key)
        with write_transaction(self.conn):
            rotated.rewrap(self.conn, self.community)
        self.assertEqual(rows, list(self.conn.execute('SELECT id,sealed FROM erp_banca_secretos')))
        secret = self.conn.execute("SELECT id FROM erp_banca_secretos WHERE purpose='payer-account'").fetchone()[0]
        self.assertEqual(rotated.get(self.conn, self.community, secret, 'payer-account')['iban'], IBAN)

    def test_09_revoke_permission_before_replay(self):
        self.grant('manage_accounts')
        e = self.envelope('account.create', {'iban': IBAN})
        self.service.account_create(self.session, e)
        self.service.permissions_save(self.session, self.envelope('permissions.save',
            {'user_id': self.uid, 'capability': 'manage_accounts', 'allowed': False}, version=1))
        with self.assertRaises(PermissionError):
            self.service.account_create(self.session, e)

    def test_10_one_account_several_person_roles_and_overlap(self):
        a = self.account()
        owner = self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? LIMIT 1', (self.community,)).fetchone()[0]
        p = {'account_id': a['id'], 'subject': {'type': 'owner', 'id': owner}, 'role': 'pagador', 'effective_from': '2026-01-01'}
        self.service.account_link(self.session, self.envelope('account.link', p, version=1))
        with self.assertRaises(ConflictError):
            self.service.account_link(self.session, self.envelope('account.link', p, version=2))
        p['role'] = 'titular'
        self.service.account_link(self.session, self.envelope('account.link', p, version=2))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cuenta_personas').fetchone()[0], 2)

    def test_11_account_identity_and_versions_immutable(self):
        a = self.account()
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute('UPDATE erp_cuentas_pagador SET last_four=? WHERE id=?', ('9999', a['id']))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute('DELETE FROM erp_cuenta_pagador_versiones')
        self.service.account_state(self.session, self.envelope('account.state', {'id': a['id'], 'state': 'cerrada'}, version=1))
        with self.assertRaises(ContractError):
            self.service.account_state(self.session, self.envelope('account.state', {'id': a['id'], 'state': 'activa'}, version=2))

    def test_12_concurrent_account_identity(self):
        self.grant('manage_accounts')
        barrier = Barrier(2)
        envs = [self.envelope('account.create', {'iban': IBAN}) for _ in range(2)]
        def run(env):
            service = BankingService(self.db, vault=BankVault(self.key))
            barrier.wait()
            return service.account_create(self.session, env)['entity']['id']
        with ThreadPoolExecutor(max_workers=2) as pool:
            ids = list(pool.map(run, envs))
        self.assertEqual(ids[0], ids[1])

    def test_13_cross_community_and_agent_denied(self):
        self.account()
        with self.assertRaises((PermissionError, ContractError)):
            self.service.account_create(self.session, self.envelope('account.create', {'iban': IBAN}, community=999999))
        e = replace(self.envelope('account.create', {'iban': IBAN}), origin='agent')
        with self.assertRaises(PermissionError):
            self.service.account_create(self.session, e)

    def test_14_raw_key_and_reason_never_enter_general_log(self):
        self.grant('manage_accounts')
        e = replace(self.envelope('account.create', {'iban': IBAN}, key=IBAN), reason='Cuenta aportada: ' + IBAN)
        self.service.account_create(self.session, e)
        for t in ('erp_command_log', 'erp_audit_events', 'erp_outbox', 'auditoria'):
            self.assertNotIn(IBAN, repr([tuple(r) for r in self.conn.execute('SELECT * FROM ' + t)]))

    def test_15_runtime_closed_by_default(self):
        previous = os.environ.pop('ERP4_BANKING_ENABLED', None)
        try:
            with self.assertRaises(ContractError):
                BankingService.from_runtime(self.db)
        finally:
            if previous is not None:
                os.environ['ERP4_BANKING_ENABLED'] = previous

    def test_16_mandate_validation_revocation_and_history(self):
        account, mandate, payload = self.mandate_setup()
        self.assertEqual(mandate['state'], 'pendiente')
        e = self.envelope('mandate.transition', {'id': mandate['id'], 'state': 'activo', 'effective_on': '2026-01-01'}, version=1)
        self.assertEqual(self.service.mandate_transition(self.session, e)['entity']['state'], 'activo')
        self.assertTrue(self.service.mandate_transition(self.session, e)['idempotent_replay'])
        self.service.mandate_transition(self.session, self.envelope('mandate.transition',
            {'id': mandate['id'], 'state': 'revocado', 'effective_on': '2026-02-01'}, version=2))
        with self.assertRaises(ContractError):
            self.service.mandate_transition(self.session, self.envelope('mandate.transition',
                {'id': mandate['id'], 'state': 'activo', 'effective_on': '2026-03-01'}, version=3))
        self.grant('read_masked')
        detail = self.service.mandate_detail(self.session, QueryEnvelope('erp4.mandate.detail', self.community, {'id': mandate['id']}))['entity']
        self.assertEqual(len(detail['events']), 3)
        self.assertEqual(len(detail['revisions']), 1)
        self.assertNotIn(IBAN, json.dumps(detail))

    def test_17_mandate_rum_case_collision(self):
        account, mandate, payload = self.mandate_setup()
        payload['rum'] = payload['rum'].lower()
        with self.assertRaises(ConflictError):
            self.service.mandate_create(self.session, self.envelope('mandate.create', payload))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_mandatos').fetchone()[0], 1)

    def test_18_account_change_preserves_mandate_revision(self):
        a, m, p = self.mandate_setup()
        new = self.service.account_create(self.session, self.envelope('account.create', {'iban': 'DE89370400440532013000'}))['entity']
        p = {k: v for k, v in p.items() if k not in ('creditor_id', 'kind', 'rum')}
        p.update({'id': m['id'], 'account_id': new['id'], 'effective_from': '2026-02-01'})
        self.service.mandate_amend(self.session, self.envelope('mandate.amend', p, version=1))
        versions = list(self.conn.execute('SELECT account_id,supersedes_id FROM erp_mandato_versiones ORDER BY version'))
        self.assertEqual([r['account_id'] for r in versions], [a['id'], new['id']])
        self.assertIsNotNone(versions[1]['supersedes_id'])
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute('DELETE FROM erp_mandato_versiones')

    def test_19_mandate_signer_foreign_subject_rolls_back(self):
        account, mandate, payload = self.mandate_setup()
        payload['rum'] = 'OTHER-SYNTHETIC'
        payload['signers'][0]['subject']['id'] = 999999
        with self.assertRaises(Exception):
            self.service.mandate_create(self.session, self.envelope('mandate.create', payload))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_mandatos').fetchone()[0], 1)

    def test_20_bulk_domiciliation_uses_existing_billing(self):
        account, mandate, payload = self.mandate_setup()
        self.service.mandate_transition(self.session, self.envelope('mandate.transition',
            {'id': mandate['id'], 'state': 'activo', 'effective_on': '2026-01-01'}, version=1))
        configs = []
        for prop in payload['property_ids']:
            configs.append(self.conn.execute('''INSERT INTO erp_config_recibo_versiones
                (id_comunidad,id_propiedad,alcance,version,efectiva_desde,registrada_en,registrada_por,estado,
                 destinatario_propietario_id,pagador_propietario_id,medio_previsto,origen)
                 VALUES (?,?,'bank-fixture',1,'2026-01-01','2026-01-01',?,'confirmada',?,?,'domiciliacion_pendiente','test')''',
                (self.community, prop, self.uid, payload['debtor']['id'], payload['debtor']['id'])).lastrowid)
        e = self.envelope('direct_debit.confirm', {'mandate_id': mandate['id'], 'billing_config_ids': configs, 'effective_from': '2026-01-01'}, version=2)
        result = self.service.direct_debit_confirm(self.session, e)
        self.assertEqual(result['entity']['count'], 3)
        self.assertTrue(self.service.direct_debit_confirm(self.session, e)['idempotent_replay'])
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cuentas_pagador').fetchone()[0], 1)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_domiciliacion_versiones').fetchone()[0], 3)

    def test_21_bulk_invalid_billing_rolls_back_all(self):
        account, mandate, payload = self.mandate_setup()
        self.service.mandate_transition(self.session, self.envelope('mandate.transition',
            {'id': mandate['id'], 'state': 'activo', 'effective_on': '2026-01-01'}, version=1))
        with self.assertRaises(ContractError):
            self.service.direct_debit_confirm(self.session, self.envelope('direct_debit.confirm',
                {'mandate_id': mandate['id'], 'billing_config_ids': [999999], 'effective_from': '2026-01-01'}, version=2))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_domiciliaciones').fetchone()[0], 0)

    def remittance_setup(self):
        account, mandate, payload = self.mandate_setup()
        self.grant('prepare')
        self.grant('present_cancel')
        self.service.mandate_transition(self.session, self.envelope('mandate.transition',
            {'id': mandate['id'], 'state': 'activo', 'effective_on': '2026-01-01'}, version=1))
        exercise = self.conn.execute('''INSERT INTO erp_ejercicios
            (id_comunidad,codigo,fecha_inicio,fecha_fin,estado,creado_en,creado_por,origen)
            VALUES (?,'BANK-TEST','2026-01-01','2026-12-31','abierto','2026-01-01',?,'test')''',
            (self.community, self.uid)).lastrowid
        configs, receipts = [], []
        for index, prop in enumerate(payload['property_ids']):
            configs.append(self.conn.execute('''INSERT INTO erp_config_recibo_versiones
                (id_comunidad,id_propiedad,alcance,version,efectiva_desde,registrada_en,registrada_por,estado,
                 destinatario_propietario_id,pagador_propietario_id,medio_previsto,origen)
                VALUES (?,?,'bank-fixture',1,'2026-01-01','2026-01-01',?,'confirmada',?,?,'domiciliacion_pendiente','test')''',
                (self.community, prop, self.uid, payload['debtor']['id'], payload['debtor']['id'])).lastrowid)
            number = 'BANK-TEST-' + str(index)
            rid = self.conn.execute('''INSERT INTO erp_recibos
                (id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,
                 source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id)
                VALUES (?,?,?,?,'bank-test','Cuota sintetica','P01','2026-01-01','2026-01-31','plan',?,?,10000,'EUR',
                '2026-01-01','2026-01-10','{}','synthetic','2026-01-01T00:00:00Z',?)''',
                (self.community, prop, exercise, number, number, number, self.uid)).lastrowid
            receipts.append(rid)
            self.synthetic_receipts.add(rid)
            for role in ('payer', 'obligated'):
                self.conn.execute('INSERT INTO erp_recibo_sujetos(id_comunidad,receipt_id,role,owner_id,snapshot_json) VALUES (?,?,?,?,?)',
                    (self.community, rid, role, payload['debtor']['id'], json.dumps({**payload['debtor'], 'name': 'Pagador sintetico'})))
        self.service.direct_debit_confirm(self.session, self.envelope('direct_debit.confirm',
            {'mandate_id': mandate['id'], 'billing_config_ids': configs, 'effective_from': '2026-01-01'}, version=2))
        requested = (date.today() + timedelta(days=21)).isoformat()
        notification = self.service.notification_record(self.session, self.envelope('notification.record', {
            'sent_on': date.today().isoformat(), 'lines': [{'receipt_id': rid, 'amount_cents': '10000',
                'requested_on': requested, 'mandate_id': mandate['id']} for rid in receipts]}))['entity']['id']
        p = {'creditor_id': payload['creditor_id'], 'requested_on': requested, 'receipt_ids': receipts, 'notification_id': notification}
        preview = self.service.remittance_preview(self.session, self.envelope('remittance.preview', p))['entity']
        return {**p, 'preview_hash': preview['preview_hash']}, mandate

    def test_22_reserve_cancel_does_not_change_debt(self):
        p, mandate = self.remittance_setup()
        e = self.envelope('remittance.prepare', p)
        result = self.service.remittance_prepare(self.session, e)['entity']
        self.assertEqual(result['total_cents'], '30000')
        self.assertTrue(self.service.remittance_prepare(self.session, e)['idempotent_replay'])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0], 3)
        for rid in p['receipt_ids']:
            self.assertEqual(receipt_balance(self.conn, self.community, rid)['pending_cents'], '10000')
        with self.assertRaises(ConflictError):
            self.service.remittance_prepare(self.session, self.envelope('remittance.prepare', p))
        self.service.remittance_cancel_local(self.session, self.envelope('remittance.cancel_local', {'id': result['id']}, version=1))
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0], 0)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_remesa_lineas').fetchone()[0], 3)
        for rid in p['receipt_ids']:
            self.assertEqual(receipt_balance(self.conn, self.community, rid)['pending_cents'], '10000')

    def test_23_concurrent_reservation_one_winner(self):
        p, _ = self.remittance_setup()
        envs = [self.envelope('remittance.prepare', p) for _ in range(2)]
        barrier = Barrier(2)
        def run(e):
            service = BankingService(self.db, vault=BankVault(self.key))
            barrier.wait()
            try:
                service.remittance_prepare(self.session, e)
                return 'ok'
            except ConflictError:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(run, envs)), ['conflict', 'ok'])
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_remesas').fetchone()[0], 1)

    def test_24_stale_preview_has_no_partial_reservation(self):
        p, mandate = self.remittance_setup()
        self.service.mandate_transition(self.session, self.envelope('mandate.transition',
            {'id': mandate['id'], 'state': 'revocado', 'effective_on': date.today().isoformat()}, version=2))
        with self.assertRaises(ContractError):
            self.service.remittance_prepare(self.session, self.envelope('remittance.prepare', p))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_remesa_reservas').fetchone()[0], 0)

    def test_25_economic_version_change_marks_remittance(self):
        p, _ = self.remittance_setup()
        result = self.service.remittance_prepare(self.session, self.envelope('remittance.prepare', p))['entity']
        self.conn.execute('UPDATE erp_recibos SET version=version+1 WHERE id=?', (p['receipt_ids'][0],))
        rem = self.conn.execute('SELECT * FROM erp_remesas WHERE id=?', (result['id'],)).fetchone()
        self.assertEqual(rem['needs_review'], 1)
        self.assertEqual(rem['version'], 2)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0], 3)

    def test_26_erp3_void_preview_blocks_reservation(self):
        p, _ = self.remittance_setup()
        self.service.remittance_prepare(self.session, self.envelope('remittance.prepare', p))
        e = replace(self.envelope('void.preview', {'receipt_id': p['receipt_ids'][0], 'effective_on': date.today().isoformat()}), command='erp3.void.preview')
        with self.assertRaises(ConflictError):
            ReceivablesService(self.db).void_preview(self.session, e)

    def test_27_frozen_bank_data_survives_account_change(self):
        p, mandate = self.remittance_setup()
        self.service.remittance_prepare(self.session, self.envelope('remittance.prepare', p))
        line = self.conn.execute('SELECT secret_id FROM erp_remesa_lineas ORDER BY id LIMIT 1').fetchone()[0]
        before = self.vault.get(self.conn, self.community, line, 'remittance-line')
        aid = before['account_id']
        self.service.account_state(self.session, self.envelope('account.state', {'id': aid, 'state': 'bloqueada'}, version=1))
        after = self.vault.get(self.conn, self.community, line, 'remittance-line')
        self.assertEqual(before, after)
        self.assertEqual(after['payer_account']['iban'], IBAN)

    def test_28_hmac_rotation_preserves_command_replay(self):
        self.grant('manage_accounts')
        e = self.envelope('account.create', {'iban': IBAN})
        result = self.service.account_create(self.session, e)
        keys = json.loads(self.key.read_text())
        keys['index_keys']['idx-2'] = base64.b64encode(os.urandom(32)).decode()
        keys['active_index_key'] = 'idx-2'
        self.key.write_text(json.dumps(keys))
        service = BankingService(self.db, vault=BankVault(self.key))
        replay = service.account_create(self.session, e)
        self.assertTrue(replay['idempotent_replay'])
        self.assertEqual(result['entity'], replay['entity'])
        self.assertEqual(service.account_create(self.session, self.envelope('account.create', {'iban': IBAN}))['entity']['id'], result['entity']['id'])


if __name__ == '__main__':
    print('Isolated ERP4 workspace:', WORK, flush=True)
    unittest.main(verbosity=2)
