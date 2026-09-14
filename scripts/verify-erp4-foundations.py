"""ERP 4 foundation tests on independent SQLite copies. No production writes."""

import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from datetime import date, timedelta, datetime, timezone
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
from erp_core.errors import ContractError, ConflictError, NotFoundError
from erp_core.migrations import apply_all, MIGRATIONS
from erp_core.receivables_service import ReceivablesService
from erp_core.receivables_projection import receipt_balance

SOURCE = Path(sys.argv[1]).resolve()
sys.argv = [sys.argv[0], *sys.argv[2:]]
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
        self.session['banking_reauthenticated_at'] = datetime.now(timezone.utc).isoformat()
        self.community = self.session['comunidades'][0]['id_comunidad']
        self.key = BankVault.create_key_file(self.work / 'test-custody.key')
        self.vault = BankVault(self.key)
        self.service = BankingService(self.db, vault=self.vault)
        self.sequence = 0
        self.synthetic_receipts = set()
        self.allow_economic_changes = False

    def tearDown(self):
        for table, rows in self.baseline.items():
            current = [tuple(r) for r in self.conn.execute('SELECT * FROM ' + table)
                       if not (table == 'erp_recibos' and r['id'] in self.synthetic_receipts)]
            if self.allow_economic_changes and table in ('erp_cobros','erp_imputaciones','erp_devoluciones'):
                original_ids={r[0] for r in rows}
                current=[r for r in current if r[0] in original_ids]
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

    def mandate_setup(self, kind='recurrente'):
        a = self.account()
        self.grant('configure_creditor')
        self.grant('manage_mandates')
        country, suffix = 'ES', 'M12345678'
        digits = ''.join(str(ord(c) - 55) if c.isalpha() else c for c in suffix + country + '00')
        creditor_code = country + str(98 - int(digits) % 97).zfill(2) + '000' + suffix
        creditor = self.service.creditor_create(self.session, self.envelope('creditor.create', {
            'name': 'Comunidad sintetica', 'creditor_identifier': creditor_code, 'iban': IBAN,
            'address': {'country': 'ES', 'town': 'Madrid'}, 'effective_from': '2026-01-01'}))['entity']
        self.service.profile_configure(self.session,self.envelope('profile.configure',{'creditor_id':creditor['id'],
            'config':{'bank_name':'Entidad sintetica','timezone':'Europe/Madrid','cutoff':'14:00','lead_business_days':1,
                'holidays':[],'countries':['ES','DE'],'max_lines':10000,'max_total_cents':'100000000',
                'recurrent_sequence':'RCUR','mode':'test','bank_profile_accepted':False,'external_instructions_reviewed':False}},version=0))
        owner = self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? LIMIT 1', (self.community,)).fetchone()[0]
        properties = [r[0] for r in self.conn.execute('SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=? LIMIT 3', (self.community,))]
        payload = {'creditor_id': creditor['id'], 'kind': kind, 'account_id': a['id'],
            'debtor': {'type': 'owner', 'id': owner}, 'debtor_name': 'Pagador sintetico',
            'address': {'country': 'ES', 'town': 'Madrid'}, 'signers': [{'subject': {'type': 'owner', 'id': owner}, 'capacity': 'Titular acreditado'}],
            'signed_on': '2026-01-01', 'effective_from': '2026-01-01', 'property_ids': properties, 'rum': 'SYNTHETIC-MANDATE'}
        mandate = self.service.mandate_create(self.session, self.envelope('mandate.create', payload))['entity']
        return a, mandate, payload

    def test_01_migration_reentrant_preserves_old_checksums(self):
        before = list(self.conn.execute('SELECT version,checksum FROM erp_schema_migrations'))
        apply_all(self.conn)
        self.assertEqual(before, list(self.conn.execute('SELECT version,checksum FROM erp_schema_migrations')))
        self.assertEqual(before[-1][0], 18)
        self.assertEqual(len(MIGRATIONS), 18)
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
        with self.assertRaises(NotFoundError):
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

    def remittance_setup(self, kind='recurrente', third_party=False):
        account, mandate, payload = self.mandate_setup(kind)
        self.grant('prepare')
        self.grant('present_cancel')
        self.service.mandate_transition(self.session, self.envelope('mandate.transition',
            {'id': mandate['id'], 'state': 'activo', 'effective_on': '2026-01-01'}, version=1))
        exercise = self.conn.execute('''INSERT INTO erp_ejercicios
            (id_comunidad,codigo,fecha_inicio,fecha_fin,estado,creado_en,creado_por,origen)
            VALUES (?,'BANK-TEST','2026-01-01','2026-12-31','abierto','2026-01-01',?,'test')''',
            (self.community, self.uid)).lastrowid
        configs, receipts = [], []
        receipt_debtor = payload['debtor']
        if third_party:
            old_owner=self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? AND id_propietario!=? LIMIT 1',
                (self.community,payload['debtor']['id'])).fetchone()[0]
            receipt_debtor={'type':'owner','id':old_owner}
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
                    (self.community, rid, role, receipt_debtor['id'], json.dumps({**receipt_debtor, 'name': 'Pagador sintetico'})))
        self.service.direct_debit_confirm(self.session, self.envelope('direct_debit.confirm',
            {'mandate_id': mandate['id'], 'billing_config_ids': configs, 'effective_from': '2026-01-01'}, version=2))
        requested_date = date.today() + timedelta(days=21)
        while requested_date.weekday()>4:
            requested_date += timedelta(days=1)
        requested = requested_date.isoformat()
        notification = self.service.notification_record(self.session, self.envelope('notification.record', {
            'sent_on': date.today().isoformat(), 'lines': [{'receipt_id': rid, 'amount_cents': '10000',
                'requested_on': requested, 'mandate_id': mandate['id']} for rid in receipts]}))['entity']['id']
        p = {'creditor_id': payload['creditor_id'], 'requested_on': requested, 'receipt_ids': receipts, 'notification_id': notification}
        if third_party:return p,mandate
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

    def test_29_single_use_mandate_cannot_cover_three_instructions(self):
        with self.assertRaises(ConflictError):
            self.remittance_setup('puntual')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_remesa_reservas').fetchone()[0], 0)

    def build_fixture(self):
        p, m = self.remittance_setup()
        rem = self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',p))['entity']
        built = self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':rem['id']},version=1))['entity']
        return p,m,rem,built

    def test_30_build_export_download_never_collects(self):
        p,m,rem,built = self.build_fixture()
        self.grant('export')
        before = self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0]
        exported = self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))['entity']
        first = self.service.download_bytes(self.session,self.community,exported['download_token'])
        self.assertIn(b'<CtrlSum>300.00</CtrlSum>',first)
        self.assertEqual(first,self.service.download_bytes(self.session,self.community,exported['download_token']))
        self.assertEqual(before,self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],3)
        self.assertFalse(exported['creates_collection'])

    def test_31_built_artifact_frozen_after_account_change(self):
        p,m,rem,built = self.build_fixture()
        self.grant('export')
        exported = self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))['entity']
        first = self.service.download_bytes(self.session,self.community,exported['download_token'])
        aid=self.conn.execute('SELECT account_id FROM erp_mandato_versiones WHERE mandate_id=?',(m['id'],)).fetchone()[0]
        self.service.account_state(self.session,self.envelope('account.state',{'id':aid,'state':'bloqueada'},version=1))
        self.assertEqual(first,self.service.download_bytes(self.session,self.community,exported['download_token']))

    def test_32_build_replay_does_not_create_second_file(self):
        p,m,rem,built = self.build_fixture()
        again = self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':rem['id']},version=2))['entity']
        self.assertEqual(built['file_id'],again['file_id'])
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_remesa_ficheros').fetchone()[0],1)

    def test_33_build_is_revalidated_before_export(self):
        p,m,rem,built = self.build_fixture()
        self.grant('export')
        self.service.mandate_transition(self.session,self.envelope('mandate.transition',
            {'id':m['id'],'state':'revocado','effective_on':date.today().isoformat()},version=2))
        version=self.conn.execute('SELECT version FROM erp_remesas WHERE id=?',(rem['id'],)).fetchone()[0]
        with self.assertRaises((ContractError,ConflictError)):
            self.service.remittance_export(self.session,self.envelope('remittance.export',
                {'file_id':built['file_id'],'acknowledge_bank_data':True},version=version))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_banca_descargas').fetchone()[0],0)

    def test_34_download_requires_current_permission(self):
        p,m,rem,built = self.build_fixture()
        self.grant('export')
        exported=self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))['entity']
        self.service.permissions_save(self.session,self.envelope('permissions.save',
            {'user_id':self.uid,'capability':'export','allowed':False},version=1))
        with self.assertRaises(PermissionError):
            self.service.download_bytes(self.session,self.community,exported['download_token'])

    def test_35_presenting_does_not_collect_or_release(self):
        p,m,rem,built = self.build_fixture()
        self.grant('export')
        self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))
        result=self.service.presentation_record(self.session,self.envelope('presentation.record',
            {'file_id':built['file_id'],'effective_on':date.today().isoformat(),'bank_reference':'SYNTHETIC-BANK-ACK'},version=3))['entity']
        self.assertEqual(result['state'],'presentada')
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],3)
        with self.assertRaises(ContractError):
            self.service.remittance_cancel_local(self.session,self.envelope('remittance.cancel_local',{'id':rem['id']},version=4))

    def bank_result_fixture(self):
        p,m,rem,built=self.build_fixture()
        self.grant('export');self.grant('results')
        self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))
        self.service.presentation_record(self.session,self.envelope('presentation.record',
            {'file_id':built['file_id'],'effective_on':date.today().isoformat(),'bank_reference':'SYNTHETIC-PRESENTATION'},version=3))
        line=dict(self.conn.execute('SELECT * FROM erp_remesa_lineas ORDER BY id LIMIT 1').fetchone())
        return p,m,rem,built,line

    def stage_bank_result(self,line,kind,event='BANK-SYNTHETIC-1',amount='10000',notes=''):
        item={'attempt_key':line['attempt_key'],'kind':kind,'effective_on':date.today().isoformat(),
              'amount_cents':amount,'currency':'EUR','bank_event_id':event,'psp':'SYNTHETIC-PSP',
              'service':'CORE','funds_evidence':True,'terminal':True,'notes':notes}
        result=self.service.results_import(self.session,self.envelope('results.import',
            {'format':'manual','data':[item],'effective_on':date.today().isoformat()}))['entity']
        row=self.conn.execute('SELECT id FROM erp_resultado_lineas WHERE result_id=?',(result['id'],)).fetchone()[0]
        return result,row

    def confirm_result(self,result,row,action,**choices):
        p={'result_id':result['id'],'decisions':[{'result_line_id':row,'action':action,**choices}]}
        preview=self.service.results_preview(self.session,self.envelope('results.preview',p))['entity']
        p['preview_hash']=preview['preview_hash']
        e=self.envelope('results.confirm',p,version=preview['version'])
        return self.service.results_confirm(self.session,e),e

    def test_36_settlement_uses_erp3_and_replay_is_safe(self):
        self.allow_economic_changes=True
        p,m,rem,built,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        applied,e=self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'0')
        self.assertTrue(self.service.results_confirm(self.session,e)['idempotent_replay'])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp4'").fetchone()[0],1)
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesa_reservas WHERE line_id=?',(line['id'],)).fetchone()[0],'consumida')

    def test_37_duplicate_bank_event_different_file_only_links(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        other,otherrow=self.stage_bank_result(line,'settlement',notes='Otra evidencia del mismo hecho')
        response,_=self.confirm_result(other,otherrow,'record_collection',allocate_cents='10000')
        self.assertTrue(response['entity']['applied'][0]['already_processed'])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp4'").fetchone()[0],1)

    def test_38_rejection_and_technical_results_never_collect(self):
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'technical')
        self.confirm_result(result,row,'none')
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesa_reservas WHERE line_id=?',(line['id'],)).fetchone()[0],'activa')
        result,row=self.stage_bank_result(line,'rejected',event='BANK-REJECT')
        self.confirm_result(result,row,'none')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'10000')
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesa_reservas WHERE line_id=?',(line['id'],)).fetchone()[0],'liberada')

    def test_39_return_uses_erp3_once(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        paid,_=self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        collection=paid['entity']['applied'][0]['collection_id']
        allocation=self.conn.execute('SELECT id FROM erp_imputaciones WHERE collection_id=?',(collection,)).fetchone()[0]
        result,row=self.stage_bank_result(line,'returned',event='BANK-RETURN')
        returned,e=self.confirm_result(result,row,'return',collection_id=collection,
            return_spec={'free_cents':'0','reversals':[{'allocation_id':allocation,'amount_cents':'10000'}]})
        self.assertTrue(self.service.results_confirm(self.session,e)['idempotent_replay'])
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'10000')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_devoluciones WHERE collection_id=?',(collection,)).fetchone()[0],1)

    def test_40_missing_collection_does_not_invent_return(self):
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'returned')
        with self.assertRaises(ConflictError):
            self.confirm_result(result,row,'return',collection_id=999999,return_spec={'free_cents':'10000','reversals':[]})
        self.assertEqual(self.conn.execute('SELECT state FROM erp_resultado_lineas WHERE id=?',(row,)).fetchone()[0],'pendiente')

    def test_41_bank_operation_collision_stops_changes(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        result,row=self.stage_bank_result(line,'settlement',amount='9000')
        with self.assertRaises(ConflictError):
            self.confirm_result(result,row,'record_collection',allocate_cents='0')

    def test_42_failure_after_erp3_rolls_back_everything(self):
        from unittest.mock import patch
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        p={'result_id':result['id'],'decisions':[{'result_line_id':row,'action':'record_collection','allocate_cents':'10000'}]}
        preview=self.service.results_preview(self.session,self.envelope('results.preview',p))['entity']
        e=self.envelope('results.confirm',{**p,'preview_hash':preview['preview_hash']},version=1)
        original=self.vault.put
        def fail(conn,community,purpose,value,now):
            if purpose=='bank-operation':raise RuntimeError('synthetic failure after economic writes')
            return original(conn,community,purpose,value,now)
        with patch.object(self.vault,'put',side_effect=fail):
            with self.assertRaises(RuntimeError):self.service.results_confirm(self.session,e)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp4'").fetchone()[0],0)
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'10000')
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesa_reservas WHERE line_id=?',(line['id'],)).fetchone()[0],'activa')
        self.allow_economic_changes=True
        self.service.results_confirm(self.session,e)

    def test_43_no_implicit_application_of_overpayment(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement',amount='12000')
        paid,_=self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        from erp_core.receivables_projection import collection_balance
        self.assertEqual(collection_balance(self.conn,self.community,paid['entity']['applied'][0]['collection_id'])['available_cents'],'2000')

    def retry_payload(self,p,line):
        return {**p,'receipt_ids':[line['receipt_id']],
                'retry_of':{str(line['receipt_id']):line['id']}}

    def test_44_retry_requires_confirmation_and_preserves_attempt(self):
        p,m,rem,built,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'rejected')
        self.confirm_result(result,row,'none')
        with self.assertRaises(ContractError):
            self.service.remittance_preview(self.session,self.envelope('remittance.preview',
                {**p,'receipt_ids':[line['receipt_id']]}))
        payload=self.retry_payload(p,line)
        preview=self.service.retry_preview(self.session,self.envelope('retry.preview',payload))['entity']
        command=self.envelope('retry.confirm',{**payload,'preview_hash':preview['preview_hash']})
        new=self.service.retry_confirm(self.session,command)['entity']
        self.assertTrue(self.service.retry_confirm(self.session,command)['idempotent_replay'])
        attempt=self.conn.execute('SELECT * FROM erp_remesa_lineas WHERE retry_of_id=?',(line['id'],)).fetchone()
        self.assertIsNotNone(attempt)
        self.assertNotEqual(attempt['attempt_key'],line['attempt_key'])
        self.assertNotEqual(new['id'],rem['id'])
        self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':new['id']},version=1))

    def test_45_late_rejection_does_not_release_new_reservation(self):
        p,m,rem,built,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'rejected')
        self.confirm_result(result,row,'none')
        payload=self.retry_payload(p,line)
        preview=self.service.retry_preview(self.session,self.envelope('retry.preview',payload))['entity']
        self.service.retry_confirm(self.session,self.envelope('retry.confirm',{**payload,'preview_hash':preview['preview_hash']}))
        result,row=self.stage_bank_result(line,'rejected',event='LATE-REJECT')
        self.confirm_result(result,row,'none')
        self.assertEqual(self.conn.execute('''SELECT r.state FROM erp_remesa_reservas r JOIN erp_remesa_lineas l
            ON l.id=r.line_id WHERE l.retry_of_id=?''',(line['id'],)).fetchone()[0],'activa')

    def test_46_withdrawal_request_does_not_release_or_collect(self):
        p,m,rem,built,line=self.bank_result_fixture()
        result=self.service.cancellation_request(self.session,self.envelope('cancellation.request',
            {'file_id':built['file_id']},version=4))['entity']
        self.assertFalse(result['reservations_released'])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],3)
        with self.assertRaises(ConflictError):
            self.service.cancellation_not_presented(self.session,self.envelope('cancellation.not_presented',
                {'file_id':built['file_id'],'declare_not_presented':True},version=5))

    def test_47_exported_not_presented_requires_explicit_evidence(self):
        p,m,rem,built=self.build_fixture()
        self.grant('export')
        exported=self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))['entity']
        with self.assertRaises(ContractError):
            self.service.cancellation_not_presented(self.session,self.envelope('cancellation.not_presented',
                {'file_id':built['file_id'],'declare_not_presented':False},version=3))
        self.service.cancellation_not_presented(self.session,self.envelope('cancellation.not_presented',
            {'file_id':built['file_id'],'declare_not_presented':True},version=3))
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],0)
        with self.assertRaises(ConflictError):
            self.service.download_bytes(self.session,self.community,exported['download_token'])

    def test_48_late_settlement_flags_retry_but_keeps_real_funds(self):
        self.allow_economic_changes=True
        p,m,rem,built,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'cancelled')
        self.confirm_result(result,row,'none')
        payload=self.retry_payload(p,line)
        preview=self.service.retry_preview(self.session,self.envelope('retry.preview',payload))['entity']
        new=self.service.retry_confirm(self.session,self.envelope('retry.confirm',{**payload,'preview_hash':preview['preview_hash']}))['entity']
        result,row=self.stage_bank_result(line,'settlement',event='LATE-SETTLEMENT')
        self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'0')
        self.assertEqual(self.conn.execute('SELECT needs_review FROM erp_remesas WHERE id=?',(new['id'],)).fetchone()[0],1)
        self.assertEqual(self.conn.execute('''SELECT r.state FROM erp_remesa_reservas r JOIN erp_remesa_lineas l
            ON l.id=r.line_id WHERE l.retry_of_id=?''',(line['id'],)).fetchone()[0],'activa')

    def test_49_shared_economic_transaction_rejects_other_database(self):
        from erp_core.receivables_service import ReceivablesService
        with self.assertRaises((ContractError,RuntimeError)):
            ReceivablesService.in_transaction(self.db,self.conn)
        self.conn.execute('BEGIN IMMEDIATE')
        try:
            with self.assertRaises((ContractError,RuntimeError)):
                ReceivablesService.in_transaction(self.db.parent/'different.db',self.conn)
        finally:
            self.conn.rollback()

    def query(self,name,filters=None):
        return QueryEnvelope.from_value({'query':'erp4.'+name,'id_comunidad':self.community,'filters':filters or {}})

    def test_50_masked_workspace_and_context_queries(self):
        p,m,rem,built,line=self.bank_result_fixture()
        self.grant('read_masked')
        result,_=self.stage_bank_result(line,'technical')
        prop=self.conn.execute('SELECT id_propiedad FROM erp_recibos WHERE id=?',(line['receipt_id'],)).fetchone()[0]
        outputs=[self.service.workspace_get(self.session,self.query('workspace.get')),
            self.service.creditor_list(self.session,self.query('creditor.list')),
            self.service.mandate_list(self.session,self.query('mandate.list',{'property_id':prop})),
            self.service.direct_debit_list(self.session,self.query('direct_debit.list',{'property_id':prop})),
            self.service.remittance_list(self.session,self.query('remittance.list',{'property_id':prop})),
            self.service.remittance_get(self.session,self.query('remittance.get',{'id':rem['id']})),
            self.service.results_list(self.session,self.query('results.list')),
            self.service.results_get(self.session,self.query('results.get',{'id':result['id']}))]
        self.assertNotIn(IBAN,json.dumps(outputs))
        self.assertEqual(outputs[2]['entity']['items'][0]['id'],m['id'])
        self.assertEqual(outputs[4]['entity']['total'],1)
        self.assertEqual(outputs[5]['entity']['lines'][0]['amount_cents'],'10000')

    def test_51_domiciliation_replacement_keeps_temporal_history(self):
        p,m=self.remittance_setup()
        rows=[dict(r) for r in self.conn.execute('SELECT * FROM erp_domiciliacion_versiones')]
        configs=[r['billing_config_id'] for r in rows]
        replacements={str(r['direct_debit_id']):1 for r in rows}
        payload={'mandate_id':m['id'],'billing_config_ids':configs,'effective_from':'2026-02-01','replacements':replacements}
        self.service.direct_debit_confirm(self.session,self.envelope('direct_debit.confirm',payload,version=2))
        for row in rows:
            self.assertEqual(dict(self.conn.execute('SELECT * FROM erp_domiciliacion_versiones WHERE id=?',(row['id'],)).fetchone()),row)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_domiciliacion_versiones').fetchone()[0],6)
        with self.assertRaises(ConflictError):
            self.service.direct_debit_confirm(self.session,self.envelope('direct_debit.confirm',payload,version=2))
        self.grant('read_masked')
        prop=self.conn.execute('SELECT property_id FROM erp_domiciliaciones LIMIT 1').fetchone()[0]
        old=self.service.direct_debit_list(self.session,self.query('direct_debit.list',{'property_id':prop,'on':'2026-01-15'}))['entity']['items']
        new=self.service.direct_debit_list(self.session,self.query('direct_debit.list',{'property_id':prop,'on':'2026-02-15'}))['entity']['items']
        self.assertEqual([r['revision'] for r in old if r['current']],[1])
        self.assertEqual([r['revision'] for r in new if r['current']],[2])

    def test_52_explicit_prenotification_agreement(self):
        p,m=self.remittance_setup()
        mv=self.conn.execute('SELECT * FROM erp_mandato_versiones WHERE mandate_id=?',(m['id'],)).fetchone()
        details=self.vault.get(self.conn,self.community,mv['secret_id'],'mandate-version')
        payload={'id':m['id'],'account_id':mv['account_id'],
            'debtor':{'type':'owner','id':mv['debtor_owner_id']},'debtor_name':details['debtor_name'],
            'address':details['address'],'signers':details['signers'],'signed_on':mv['signed_on'],
            'effective_from':'2026-02-01','property_ids':details['property_ids'],
            'prenotification_agreement':{'days':2,'evidence':{'type':'external_reference','id':'SIGNED-AGREEMENT'}}}
        self.service.mandate_amend(self.session,self.envelope('mandate.amend',payload,version=2))
        self.service.mandate_transition(self.session,self.envelope('mandate.transition',{'id':m['id'],'state':'activo','effective_on':'2026-02-01'},version=3))
        requested=date.today()+timedelta(days=5)
        while requested.weekday()>4:requested+=timedelta(days=1)
        notice=self.service.notification_record(self.session,self.envelope('notification.record',{
            'sent_on':date.today().isoformat(),'lines':[{'receipt_id':rid,'amount_cents':'10000','requested_on':requested.isoformat(),'mandate_id':m['id']} for rid in p['receipt_ids']]}))['entity']
        preview=self.service.remittance_preview(self.session,self.envelope('remittance.preview',
            {**p,'notification_id':notice['id'],'requested_on':requested.isoformat()}))['entity']
        self.assertEqual({r['prenotification_days'] for r in preview['lines']},{2})

    def test_53_all_terminal_results_close_remittance(self):
        p,m,rem,built,line=self.bank_result_fixture()
        for row in self.conn.execute('SELECT * FROM erp_remesa_lineas').fetchall():
            result,item=self.stage_bank_result(dict(row),'rejected',event='REJECT-'+str(row['id']))
            self.confirm_result(result,item,'none')
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesas WHERE id=?',(rem['id'],)).fetchone()[0],'finalizada')

    def test_54_queries_require_independent_permissions(self):
        self.remittance_setup()
        with self.assertRaises(PermissionError):
            self.service.workspace_get(self.session,self.query('workspace.get'))
        self.grant('read_masked')
        with self.assertRaises(PermissionError):
            self.service.results_list(self.session,self.query('results.list'))

    def test_55_third_party_requires_explicit_receipt_authorization(self):
        p,m=self.remittance_setup(third_party=True)
        with self.assertRaises(ContractError):
            self.service.remittance_preview(self.session,self.envelope('remittance.preview',p))
        original=[tuple(r) for r in self.conn.execute('SELECT * FROM erp_recibo_sujetos')]
        p['third_party_authorizations']={str(r):{'mandate_id':m['id'],
            'evidence':{'type':'external_reference','id':'EXPLICIT-SYNTHETIC-CONSENT-'+str(r)}} for r in p['receipt_ids']}
        preview=self.service.remittance_preview(self.session,self.envelope('remittance.preview',p))['entity']
        self.assertTrue(all(r['third_party'] for r in preview['lines']))
        self.assertNotIn('third_party_authorizations',preview)
        rem=self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',{**p,'preview_hash':preview['preview_hash']}))['entity']
        self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':rem['id']},version=1))
        self.assertEqual([tuple(r) for r in self.conn.execute('SELECT * FROM erp_recibo_sujetos')],original)

    def test_56_late_result_after_local_withdrawal_is_not_ignored(self):
        self.allow_economic_changes=True
        p,m,rem,built=self.build_fixture()
        self.grant('export');self.grant('results')
        self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))
        self.service.cancellation_not_presented(self.session,self.envelope('cancellation.not_presented',
            {'file_id':built['file_id'],'declare_not_presented':True},version=3))
        line=dict(self.conn.execute('SELECT * FROM erp_remesa_lineas LIMIT 1').fetchone())
        result,row=self.stage_bank_result(line,'settlement')
        self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'0')
        self.assertEqual(self.conn.execute('SELECT needs_review FROM erp_remesas WHERE id=?',(rem['id'],)).fetchone()[0],1)

    def test_57_pending_result_prevents_retry_until_reviewed(self):
        p,m,rem,built,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'rejected')
        self.confirm_result(result,row,'none')
        pending,row=self.stage_bank_result(line,'pending',event='UNRESOLVED')
        with self.assertRaises(ConflictError):
            self.service.retry_preview(self.session,self.envelope('retry.preview',self.retry_payload(p,line)))

    def test_58_resolve_unmatched_evidence_requires_second_confirmation(self):
        p,m,rem,built,line=self.bank_result_fixture()
        result,row=self.stage_bank_result({'attempt_key':'UNRECOGNIZED'},'pending')
        previous=self.conn.execute('SELECT secret_id FROM erp_resultado_lineas WHERE id=?',(row,)).fetchone()[0]
        resolved=self.service.results_resolve(self.session,self.envelope('results.resolve',{
            'result_line_id':row,'line_id':line['id'],'details':{'kind':'rejected','effective_on':date.today().isoformat()}},version=1))['entity']
        self.assertTrue(resolved['requires_economic_confirmation'])
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesa_reservas WHERE line_id=?',(line['id'],)).fetchone()[0],'activa')
        self.assertEqual(self.vault.get(self.conn,self.community,previous,'bank-result-line')['attempt_key'],'UNRECOGNIZED')
        self.confirm_result(result,row,'none')
        with self.assertRaises(ConflictError):
            self.service.results_resolve(self.session,self.envelope('results.resolve',{
                'result_line_id':row,'line_id':line['id'],'details':{'kind':'technical','effective_on':date.today().isoformat()}},version=3))

    def test_59_two_bank_identities_cannot_reuse_one_collection(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        paid,_=self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        collection=paid['entity']['applied'][0]['collection_id']
        result,row=self.stage_bank_result(line,'settlement',event='DIFFERENT-BANK-IDENTITY')
        with self.assertRaises(ConflictError):
            self.confirm_result(result,row,'link_collection',collection_id=collection,allocate_cents='0')

    def test_60_export_and_download_require_recent_reauthentication(self):
        p,m,rem,built=self.build_fixture()
        self.grant('export')
        session={**self.session,'banking_reauthenticated_at':(datetime.now(timezone.utc)-timedelta(minutes=6)).isoformat()}
        with self.assertRaises(PermissionError):
            self.service._recent_auth({**self.session,'banking_reauthenticated_at':None})
        with self.assertRaises(PermissionError):
            self.service.remittance_export(session,self.envelope('remittance.export',
                {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))
        exported=self.service.remittance_export(self.session,self.envelope('remittance.export',
            {'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))['entity']
        with self.assertRaises(PermissionError):
            self.service.download_bytes(session,self.community,exported['download_token'])

    def test_61_end_one_domiciliation_does_not_revoke_shared_mandate(self):
        p,m=self.remittance_setup()
        direct=self.conn.execute('SELECT * FROM erp_domiciliaciones ORDER BY id LIMIT 1').fetchone()
        self.service.direct_debit_state(self.session,self.envelope('direct_debit.state',
            {'id':direct['id'],'state':'finalizada','effective_from':date.today().isoformat()},version=1))
        self.assertEqual(self.conn.execute('SELECT state FROM erp_mandatos WHERE id=?',(m['id'],)).fetchone()[0],'activo')
        with self.assertRaises(ContractError):
            self.service.remittance_preview(self.session,self.envelope('remittance.preview',p))
        other_ids=[r[0] for r in self.conn.execute('SELECT id FROM erp_recibos WHERE number LIKE ? AND id_propiedad!=?',('BANK-TEST-%',direct['property_id']))]
        preview=self.service.remittance_preview(self.session,self.envelope('remittance.preview',{**p,'receipt_ids':other_ids}))['entity']
        self.assertEqual(len(preview['lines']),2)

    def test_62_bank_import_observed_no_mandate_activation_or_duplicates(self):
        self.grant('manage_accounts')
        p={'source':'SYNTHETIC-LEGACY','cutoff':'2026-09-01','rows':[{
            'iban':IBAN,'observed_mandate_reference':'OLD-REFERENCE-UNVERIFIED','observed_property_reference':'UNKNOWN'}]}
        preview=self.service.import_preview(self.session,self.envelope('import.preview',p))['entity']
        repeated=self.service.import_preview(self.session,self.envelope('import.preview',p))['entity']
        self.assertEqual(preview['id'],repeated['id'])
        self.assertNotIn(IBAN,json.dumps(preview))
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_cuentas_pagador').fetchone()[0],0)
        env=self.envelope('import.confirm',{'id':preview['id'],'rows':[1],'acknowledge_observed_mandates':True},version=1)
        self.service.import_confirm(self.session,env)
        self.assertTrue(self.service.import_confirm(self.session,env)['idempotent_replay'])
        detail=self.service.import_get(self.session,self.query('import.get',{'id':preview['id']}))['entity']
        self.assertEqual(detail['items'][0]['cutoff'],'2026-09-01')
        self.assertTrue(detail['items'][0]['observed_mandate_pending'])
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_mandatos').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_cuentas_pagador').fetchone()[0],1)

    def test_63_bank_import_invalid_row_rolls_back_whole_confirmation(self):
        self.grant('manage_accounts')
        p={'source':'SYNTHETIC','cutoff':'2026-09-01','rows':[{'iban':IBAN},{'iban':'invalid'},{'iban':IBAN}]}
        preview=self.service.import_preview(self.session,self.envelope('import.preview',p))['entity']
        self.assertTrue(preview['items'][1]['issues'])
        self.assertTrue(preview['items'][2]['issues'])
        with self.assertRaises(ConflictError):
            self.service.import_confirm(self.session,self.envelope('import.confirm',
                {'id':preview['id'],'rows':[1,2],'acknowledge_observed_mandates':True},version=1))
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_cuentas_pagador').fetchone()[0],0)

    def test_64_reveal_is_explicit_recent_and_never_in_general_audit(self):
        account=self.account()
        self.grant('read_masked')
        with self.assertRaises(PermissionError):
            self.service.reveal_account(self.session,self.community,account['id'],'Verificacion bancaria')
        self.grant('reveal')
        result=self.service.reveal_account(self.session,self.community,account['id'],'Verificacion: '+IBAN)
        self.assertEqual(result['iban'],IBAN)
        with self.assertRaises(PermissionError):
            self.service.reveal_account({**self.session,'banking_reauthenticated_at':None},self.community,account['id'],'Verificacion')
        for table in ('erp_command_log','erp_audit_events','erp_outbox','auditoria'):
            self.assertNotIn(IBAN,repr([tuple(r) for r in self.conn.execute('SELECT * FROM '+table)]))


    def test_65_external_cutover_blocks_until_evidenced_closure(self):
        p,_=self.remittance_setup()
        command=self.envelope('external.register',{'receipt_ids':p['receipt_ids'],'source':'Previous bank file',
            'reference':'CONFIDENTIAL-EXTERNAL-REF','cutoff_on':date.today().isoformat()})
        registered=self.service.external_register(self.session,command)['entity']
        self.assertTrue(self.service.external_register(self.session,command)['idempotent_replay'])
        again=self.service.external_register(self.session,self.envelope('external.register',command.payload))['entity']
        self.assertEqual(registered['ids'],again['ids'])
        with self.assertRaises(ConflictError):
            self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',p))
        for eid in registered['ids']:
            with self.assertRaises(ContractError):
                self.service.external_close(self.session,self.envelope('external.close',{'id':eid,
                    'effective_on':date.today().isoformat(),'terminal_confirmed':False},version=1))
            self.service.external_close(self.session,self.envelope('external.close',{'id':eid,
                'effective_on':date.today().isoformat(),'terminal_confirmed':True},version=1))
        self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',p))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_banca_control_eventos').fetchone()[0],3)
        self.assertNotIn('CONFIDENTIAL-EXTERNAL-REF',repr(list(self.conn.execute('SELECT * FROM erp_audit_events'))))

    def test_66_external_registration_rolls_back_if_local_reserved(self):
        p,_=self.remittance_setup()
        only={**p,'receipt_ids':[p['receipt_ids'][1]]}
        pv=self.service.remittance_preview(self.session,self.envelope('remittance.preview',only))['entity']
        self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',{**only,'preview_hash':pv['preview_hash']}))
        with self.assertRaises(ConflictError):
            self.service.external_register(self.session,self.envelope('external.register',{
                'receipt_ids':p['receipt_ids'],'cutoff_on':date.today().isoformat(),'source':'Previous','reference':'Pending'}))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_banca_instrucciones_externas').fetchone()[0],0)

    def test_67_successor_keeps_original_identity_and_authorizations(self):
        _,old,p=self.mandate_setup()
        new=self.service.mandate_create(self.session,self.envelope('mandate.create',{**p,'rum':'SUCCESSOR-RUM'}))['entity']
        self.service.mandate_transition(self.session,self.envelope('mandate.transition',{'id':new['id'],'state':'activo','effective_on':'2026-01-01'},version=1))
        before=[tuple(r) for r in self.conn.execute('SELECT * FROM erp_mandatos')]
        cmd=self.envelope('mandate.succeed',{'predecessor_id':old['id'],'successor_id':new['id'],
            'successor_version':2,'effective_on':date.today().isoformat()},version=1)
        self.service.mandate_succeed(self.session,cmd)
        self.assertTrue(self.service.mandate_succeed(self.session,cmd)['idempotent_replay'])
        self.assertEqual(before,[tuple(r) for r in self.conn.execute('SELECT * FROM erp_mandatos')])
        with self.assertRaises(ConflictError):
            self.service.mandate_create(self.session,self.envelope('mandate.create',p))

    def test_68_confirmed_conflict_review_preserves_economic_history(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        result,row=self.stage_bank_result(line,'rejected',event='LATE-TECHNICAL-REJECTION')
        self.confirm_result(result,row,'none')
        self.assertEqual(self.service._line_status(self.conn,self.community,line['id']),'conflict')
        event=self.conn.execute("SELECT * FROM erp_banca_linea_eventos WHERE kind='conflict'").fetchone()
        rem=self.conn.execute('SELECT * FROM erp_remesas').fetchone()
        before=[tuple(r) for r in self.conn.execute('SELECT * FROM erp_cobros')]
        cmd=self.envelope('conflict.review',{'event_id':event['id'],'keep_economic_history':True,
            'effective_on':date.today().isoformat()},version=rem['version'])
        self.service.conflict_review(self.session,cmd)
        self.assertTrue(self.service.conflict_review(self.session,cmd)['idempotent_replay'])
        self.assertEqual(self.service._line_status(self.conn,self.community,line['id']),'settlement')
        self.assertEqual(before,[tuple(r) for r in self.conn.execute('SELECT * FROM erp_cobros')])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_banca_linea_eventos WHERE kind='conflict'").fetchone()[0],1)

    def test_69_reversal_request_is_not_money_or_local_cancel(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        payload={'line_id':line['id'],'effective_on':date.today().isoformat()}
        with self.assertRaises(ContractError):
            self.service.reversal_request(self.session,self.envelope('reversal.request',payload))
        result,row=self.stage_bank_result(line,'settlement')
        self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        request=self.service.reversal_request(self.session,self.envelope('reversal.request',payload))['entity']
        self.assertFalse(request['xml_enabled'])
        self.assertFalse(request['economic_effect'])
        again=self.service.reversal_request(self.session,self.envelope('reversal.request',payload))['entity']
        self.assertEqual(request['id'],again['id'])
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'0')


    def test_70_terminal_return_without_cash_preserves_gap_and_debt(self):
        p,_,rem,_,line=self.bank_result_fixture()
        result=self.service.results_import(self.session,self.envelope('results.import',{'format':'manual',
            'effective_on':date.today().isoformat(),'data':[{'attempt_key':line['attempt_key'],
                'kind':'returned','terminal':False}]}))['entity']
        row=self.conn.execute('SELECT id FROM erp_resultado_lineas WHERE result_id=?',(result['id'],)).fetchone()[0]
        with self.assertRaises(ContractError):
            self.confirm_result(result,row,'terminal_without_collection')
        result=self.service.results_import(self.session,self.envelope('results.import',{'format':'manual',
            'effective_on':date.today().isoformat(),'data':[{'attempt_key':line['attempt_key'],
                'kind':'returned','terminal':True}]}))['entity']
        row=self.conn.execute('SELECT id FROM erp_resultado_lineas WHERE result_id=?',(result['id'],)).fetchone()[0]
        self.confirm_result(result,row,'terminal_without_collection')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'10000')
        self.assertEqual(self.service._line_status(self.conn,self.community,line['id']),'cancelled')
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesa_reservas WHERE line_id=?',(line['id'],)).fetchone()[0],'liberada')
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_banca_control_eventos WHERE kind='terminal_history_gap'").fetchone()[0],1)
        self.assertEqual(self.conn.execute('SELECT needs_review FROM erp_remesas WHERE id=?',(rem['id'],)).fetchone()[0],1)

    def test_71_terminal_gap_cannot_hide_known_collection(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        result=self.service.results_import(self.session,self.envelope('results.import',{'format':'manual',
            'effective_on':date.today().isoformat(),'data':[{'attempt_key':line['attempt_key'],
                'kind':'returned','terminal':True}]}))['entity']
        row=self.conn.execute('SELECT id FROM erp_resultado_lineas WHERE result_id=?',(result['id'],)).fetchone()[0]
        with self.assertRaises(ConflictError):self.confirm_result(result,row,'terminal_without_collection')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'0')

    def test_72_oneoff_retry_needs_profile_and_specific_evidence(self):
        p,mandate=self.remittance_setup()
        # Set the synthetic mandate kind before any instruction, to reuse the same fixture setup.
        self.conn.execute("UPDATE erp_mandatos SET kind='puntual' WHERE id=?",(mandate['id'],))
        one={**p,'receipt_ids':p['receipt_ids'][:1]}
        preview=self.service.remittance_preview(self.session,self.envelope('remittance.preview',one))['entity']
        rem=self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',{**one,'preview_hash':preview['preview_hash']}))['entity']
        built=self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':rem['id']},version=1))['entity']
        self.grant('export');self.grant('results')
        self.service.remittance_export(self.session,self.envelope('remittance.export',{'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))
        self.service.presentation_record(self.session,self.envelope('presentation.record',{'file_id':built['file_id'],'effective_on':date.today().isoformat(),'bank_reference':'SYNTHETIC-ONEOFF'},version=3))
        line=self.conn.execute('SELECT * FROM erp_remesa_lineas').fetchone()
        result,row=self.stage_bank_result(line,'rejected')
        self.confirm_result(result,row,'none')
        payload={'line_id':line['id'],'effective_on':date.today().isoformat()}
        with self.assertRaises(ContractError):
            self.service.mandate_authorize_retry(self.session,self.envelope('mandate.authorize_retry',payload,version=2))
        configrow,config=self.service._bank_profile(self.conn,self.community,p['creditor_id'])
        self.service.profile_configure(self.session,self.envelope('profile.configure',{'creditor_id':p['creditor_id'],
            'config':{**config,'allow_failed_oneoff_retry':True}},version=configrow['version']))
        retry=self.retry_payload(p,line)
        with self.assertRaises(ConflictError):self.service.retry_preview(self.session,self.envelope('retry.preview',retry))
        self.service.mandate_authorize_retry(self.session,self.envelope('mandate.authorize_retry',payload,version=2))
        proposed=self.service.retry_preview(self.session,self.envelope('retry.preview',retry))['entity']
        self.assertEqual(proposed['lines'][0]['sequence'],'OOFF')
        new=self.service.retry_confirm(self.session,self.envelope('retry.confirm',{**retry,'preview_hash':proposed['preview_hash']}))['entity']
        self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':new['id']},version=1))

    def test_73_inactive_mandate_cannot_be_reactivated(self):
        _,_,p=self.mandate_setup()
        stale=self.service.mandate_create(self.session,self.envelope('mandate.create',{
            **p,'rum':'EXPIRED-SYNTHETIC','signed_on':'2020-01-01','effective_from':'2020-01-01'}))['entity']
        with self.assertRaises(ContractError):
            self.service.mandate_transition(self.session,self.envelope('mandate.transition',{
                'id':stale['id'],'state':'activo','effective_on':date.today().isoformat()},version=1))
        self.service.mandate_transition(self.session,self.envelope('mandate.transition',{
            'id':stale['id'],'state':'caducado','effective_on':date.today().isoformat()},version=1))
        with self.assertRaises(ContractError):
            self.service.mandate_transition(self.session,self.envelope('mandate.transition',{
                'id':stale['id'],'state':'activo','effective_on':date.today().isoformat()},version=2))


    def test_74_operational_selectors_use_same_domain_and_tenant(self):
        p,m=self.remittance_setup();self.grant('read_masked')
        properties=self.service.reference_list(self.session,self.query('reference.list',{'kind':'properties'}))['entity']
        self.assertGreater(properties['total'],0)
        billing=self.service.reference_list(self.session,self.query('reference.list',{'kind':'billing','mandate_id':m['id']}))['entity']
        self.assertEqual(len(billing['items']),3)
        rows=self.service.receipt_candidates(self.session,self.query('receipt.candidates',{
            'creditor_id':p['creditor_id'],'requested_on':p['requested_on'],'notification_id':p['notification_id']}))['entity']['items']
        found=[r for r in rows if r['id'] in p['receipt_ids']]
        self.assertEqual(len(found),3)
        self.assertTrue(all(r['validated'] and not r['issues'] for r in found))
        for r in found:self.assertEqual(r['pending_cents'],'10000')
        self.assertNotIn(IBAN,json.dumps([properties,billing,rows]))
        with self.assertRaises(PermissionError):
            self.service.reference_list(self.session,replace(self.query('reference.list',{'kind':'owners'}),community_id=self.community+900000))

    def test_75_suspended_specific_direct_debit_does_not_fall_back(self):
        p,m=self.remittance_setup()
        direct=self.conn.execute('SELECT * FROM erp_domiciliaciones ORDER BY id LIMIT 1').fetchone()
        generic=direct['id']
        self.conn.execute("UPDATE erp_domiciliaciones SET concept_key='bank-test' WHERE id=?",(generic,))
        self.service.direct_debit_state(self.session,self.envelope('direct_debit.state',{
            'id':generic,'state':'suspendida','effective_from':date.today().isoformat()},version=1))
        receipt=self.conn.execute('SELECT * FROM erp_recibos WHERE id=?',(p['receipt_ids'][0],)).fetchone()
        with self.assertRaises(ContractError):
            self.service._direct_for_receipt(self.conn,self.community,receipt,p['requested_on'])


    def test_76_excel_mapping_is_masked_revisable_and_idempotent(self):
        import io
        import openpyxl
        self.grant('manage_accounts')
        workbook=openpyxl.Workbook();sheet=workbook.active
        sheet.append(['Propiedad','Cuenta bancaria','Nombre'])
        sheet.append(['VILLA-TEST',IBAN,'Propietario de prueba'])
        sheet.append(['VILLA-TEST-2',IBAN,'Misma cuenta'])
        raw=io.BytesIO();workbook.save(raw)
        payload={'filename':'cuentas.xlsx','file_base64':base64.b64encode(raw.getvalue()).decode()}
        analyze=self.service.import_analyze(self.session,self.envelope('import.analyze',payload))['entity']
        self.assertNotIn(IBAN,json.dumps(analyze))
        self.assertEqual(analyze['row_count'],2)
        mapping={'source_id':analyze['source_id'],'mapping':{'iban':1,'alias':2,'observed_property_reference':0},
            'source':'Libro original','cutoff':date.today().isoformat()}
        preview=self.service.import_file_preview(self.session,self.envelope('import.file_preview',mapping))['entity']
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cuentas_pagador').fetchone()[0],0)
        self.assertTrue(preview['items'][1]['issues'])
        command=self.envelope('import.confirm',{'id':preview['id'],'rows':[1],'acknowledge_observed_mandates':True},version=1)
        self.service.import_confirm(self.session,command)
        again=self.service.import_file_preview(self.session,self.envelope('import.file_preview',mapping))['entity']
        self.assertEqual(again['id'],preview['id'])
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cuentas_pagador').fetchone()[0],1)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_mandatos').fetchone()[0],0)
        with self.assertRaises(PermissionError):
            self.service.import_file_preview(self.session,self.envelope('import.file_preview',mapping,community=self.community+999999))

    def test_77_spreadsheet_parser_rejects_dtd_and_excess(self):
        from erp_core.banking_tabular import parse_workbook
        import io,zipfile
        buf=io.BytesIO()
        with zipfile.ZipFile(buf,'w') as archive:archive.writestr('doc.xml','<!DOCTYPE doc [<!ENTITY secret SYSTEM "file:///test">]><doc>&secret;</doc>')
        with self.assertRaises(ContractError):parse_workbook(base64.b64encode(buf.getvalue()).decode(),'bad.xlsx')
        content='IBAN\n'+'\n'.join([IBAN]*1017)
        with self.assertRaises(ContractError):parse_workbook(base64.b64encode(content.encode()).decode(),'big.csv')
        content='Propiedad;Cuenta\nVILLA-TEST;'+IBAN
        parsed=parse_workbook(base64.b64encode(content.encode()).decode(),'original.csv')
        self.assertEqual(parsed['rows'][0]['values'][1],IBAN)

    def test_78_mapping_must_be_exact_and_formulas_are_not_values(self):
        import io,openpyxl
        self.grant('manage_accounts')
        workbook=openpyxl.Workbook();sheet=workbook.active;sheet.append(['IBAN']);sheet.append(['="'+IBAN+'"'])
        buf=io.BytesIO();workbook.save(buf)
        result=self.service.import_analyze(self.session,self.envelope('import.analyze',{
            'filename':'formula.xlsx','file_base64':base64.b64encode(buf.getvalue()).decode()}))['entity']
        payload={'source_id':result['source_id'],'mapping':{'iban':0},'source':'Formula','cutoff':date.today().isoformat()}
        preview=self.service.import_file_preview(self.session,self.envelope('import.file_preview',payload))['entity']
        self.assertTrue(preview['items'][0]['issues'])
        with self.assertRaises(ContractError):
            self.service.import_file_preview(self.session,self.envelope('import.file_preview',{**payload,'mapping':{'iban':0,'alias':0}}))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cuentas_pagador').fetchone()[0],0)


    def pain002(self, built, status='PART', details=''):
        from erp_core.banking_adapter import STATUS_NS
        file=self.conn.execute('SELECT message_id FROM erp_remesa_ficheros WHERE id=?',(built['file_id'],)).fetchone()
        return f'''<Document xmlns="{STATUS_NS}"><CstmrPmtStsRpt><GrpHdr><MsgId>SYNTHETIC-STATUS</MsgId>
            <CreDtTm>2026-09-11T12:00:00Z</CreDtTm><InitgPty><Nm>Banco sintetico</Nm></InitgPty></GrpHdr>
            <OrgnlGrpInfAndSts><OrgnlMsgId>{file['message_id']}</OrgnlMsgId><OrgnlMsgNmId>pain.008.001.08</OrgnlMsgNmId>
            <GrpSts>{status}</GrpSts></OrgnlGrpInfAndSts>{details}</CstmrPmtStsRpt></Document>'''.encode()

    def test_79_pain002_partial_file_and_unknown_reference_are_reviewable(self):
        *_,built,line=self.bank_result_fixture()
        detail=f'''<OrgnlPmtInfAndSts><OrgnlPmtInfId>SYNTHETIC-GROUP</OrgnlPmtInfId>
            <TxInfAndSts><OrgnlEndToEndId>{line['attempt_key']}</OrgnlEndToEndId><TxSts>RJCT</TxSts></TxInfAndSts>
            <TxInfAndSts><OrgnlEndToEndId>UNKNOWN-REFERENCE</OrgnlEndToEndId><TxSts>RJCT</TxSts></TxInfAndSts>
            </OrgnlPmtInfAndSts>'''
        raw=self.pain002(built,details=detail)
        p={'format':'pain002','data':base64.b64encode(raw).decode(),'effective_on':date.today().isoformat()}
        imported=self.service.results_import(self.session,self.envelope('results.import',p))['entity']
        self.assertEqual(imported['unmatched'],1)
        rows=list(self.conn.execute('SELECT * FROM erp_resultado_lineas WHERE result_id=?',(imported['id'],)))
        rejected=next(r for r in rows if r['line_id']==line['id'])
        data=self.vault.get(self.conn,self.community,rejected['secret_id'],'bank-result-line')
        self.assertEqual(data['kind'],'rejected')
        self.assertFalse(data['contradictory'])
        self.confirm_result(imported,rejected['id'],'none')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'10000')
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],2)
        repeated=self.service.results_import(self.session,self.envelope('results.import',p))['entity']
        self.assertEqual(repeated['id'],imported['id'])

    def test_80_pain002_peer_contradiction_blocks_and_group_rejection_expands(self):
        *_,built,line=self.bank_result_fixture()
        detail=f'''<OrgnlPmtInfAndSts><OrgnlPmtInfId>SYNTHETIC-GROUP</OrgnlPmtInfId>
            <TxInfAndSts><OrgnlEndToEndId>{line['attempt_key']}</OrgnlEndToEndId><TxSts>RJCT</TxSts></TxInfAndSts>
            <TxInfAndSts><OrgnlEndToEndId>{line['attempt_key']}</OrgnlEndToEndId><TxSts>PDNG</TxSts></TxInfAndSts>
            </OrgnlPmtInfAndSts>'''
        rows=self.service._stage_status_rows(self.conn,self.community,self.pain002(built,details=detail))
        row=next(r for r in rows if r.get('attempt_key')==line['attempt_key'])
        self.assertEqual(row['kind'],'pending');self.assertTrue(row['contradictory'])
        file=self.conn.execute('SELECT * FROM erp_remesa_ficheros WHERE id=?',(built['file_id'],)).fetchone()
        meta=self.vault.get(self.conn,self.community,file['secret_id'],'remittance-file')['metadata']
        group=meta['payment_groups'][0]
        detail=f"<OrgnlPmtInfAndSts><OrgnlPmtInfId>{group['id']}</OrgnlPmtInfId><PmtInfSts>RJCT</PmtInfSts></OrgnlPmtInfAndSts>"
        rows=self.service._stage_status_rows(self.conn,self.community,self.pain002(built,details=detail))
        self.assertEqual({r['attempt_key'] for r in rows if r['kind']=='rejected'},set(group['attempt_keys']))
        rows=self.service._stage_status_rows(self.conn,self.community,self.pain002(built,'RJCT'))
        self.assertEqual(len(rows),3);self.assertTrue(all(r['kind']=='rejected' for r in rows))

    def test_81_result_choices_reuse_erp3_and_live_profile_is_explicitly_gated(self):
        from unittest.mock import patch
        self.allow_economic_changes=True
        p,m,rem,built,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        paid,_=self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        collection=paid['entity']['applied'][0]['collection_id']
        returned,row=self.stage_bank_result(line,'returned',event='CHOICES-RETURN')
        choices=self.service.results_choices(self.session,QueryEnvelope('erp4.results.choices',self.community,{'result_line_id':row}))['entity']
        self.assertEqual([c['id'] for c in choices['collections']],[collection])
        self.assertEqual(str(choices['collections'][0]['allocations'][0]['remaining_cents']),'10000')
        profile=self.service.profile_get(self.session,QueryEnvelope('erp4.profile.get',self.community,{'creditor_id':p['creditor_id']}))['entity']
        self.assertEqual(profile['version'],1)
        config={**profile['config'],'mode':'live','bank_profile_accepted':True,'external_instructions_reviewed':True}
        with patch.dict(os.environ,{'ERP4_LIVE_BANKING_ENABLED':'0'}):
            self.service.profile_configure(self.session,self.envelope('profile.configure',{'creditor_id':p['creditor_id'],'config':config},version=1))
            with self.assertRaises(ContractError):
                self.service._bank_profile(self.conn,self.community,p['creditor_id'])

    def test_82_bank_documents_reuse_catalogue_without_plaintext_or_generic_path(self):
        self.grant('manage_mandates');self.grant('read_masked')
        raw=b'%PDF-1.7\nSynthetic bank evidence '+IBAN.encode()+b'\n%%EOF'
        p={'purpose':'mandate','filename':IBAN+'.pdf','data':base64.b64encode(raw).decode()}
        document=self.service.document_upload(self.session,self.envelope('document.upload',p))['entity']
        repeated=self.service.document_upload(self.session,self.envelope('document.upload',p))['entity']
        self.assertEqual(document['id'],repeated['id'])
        row=self.conn.execute('SELECT * FROM documentos_importados WHERE id_documento=?',(document['id'],)).fetchone()
        self.assertEqual(row['ruta_archivo'],'');self.assertEqual(row['texto_extraido'],'')
        self.assertNotIn(IBAN,json.dumps(dict(row)))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute('UPDATE documentos_importados SET ruta_archivo=? WHERE id_documento=?',('plain-file.pdf',document['id']))
        with self.assertRaises(PermissionError):
            self.service.document_download(self.session,self.community,document['id'],'Consulta autorizada')
        self.grant('export');self.grant('reveal')
        with self.assertRaises(PermissionError):
            self.service.document_download({**self.session,'banking_reauthenticated_at':None},self.community,document['id'],'Consulta autorizada')
        result=self.service.document_download(self.session,self.community,document['id'],'Consulta autorizada '+IBAN)
        self.assertEqual(base64.b64decode(result['content_base64']),raw)
        with self.assertRaises(PermissionError):
            self.service.document_download(self.session,999999,document['id'],'Consulta autorizada')
        for table in ('erp_command_log','erp_audit_events','erp_outbox'):
            self.assertNotIn(IBAN,json.dumps([dict(r) for r in self.conn.execute('SELECT * FROM '+table)]))
        self.grant('manage_accounts')
        env=replace(self.envelope('account.create',{'iban':IBAN}),evidence=CommandEnvelope.from_value({
            'command':'erp4.account.create','id_comunidad':self.community,'payload':{},'idempotency_key':'protected-evidence',
            'reason':'Test','origin':'test','evidence':{'type':'imported_document','id':document['id']}}).evidence)
        self.service.account_create(self.session,env)
        self.assertEqual(self.service.document_list(self.session,QueryEnvelope('erp4.document.list',self.community,{}))['entity']['total'],1)

    def seed_extra_receipts(self,p,count):
        source=dict(self.conn.execute('SELECT * FROM erp_recibos WHERE id=?',(p['receipt_ids'][0],)).fetchone())
        subjects=[dict(r) for r in self.conn.execute('SELECT * FROM erp_recibo_sujetos WHERE receipt_id=?',(source['id'],))]
        for index in range(count):
            row={k:v for k,v in source.items() if k!='id'}
            row.update(number='BANK-BULK-'+str(index),source_key='BANK-BULK-'+str(index),obligation_key='BANK-BULK-'+str(index),period_key='BULK-'+str(index))
            rid=self.conn.execute('INSERT INTO erp_recibos ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values())).lastrowid
            self.synthetic_receipts.add(rid);p['receipt_ids'].append(rid)
            for old in subjects:
                item={k:v for k,v in old.items() if k!='id'};item['receipt_id']=rid
                self.conn.execute('INSERT INTO erp_recibo_sujetos ('+','.join(item)+') VALUES ('+','.join('?' for _ in item)+')',tuple(item.values()))

    def test_83_bulk_200_domain_notifications_and_result_confirmation(self):
        p,m=self.remittance_setup()
        self.seed_extra_receipts(p,197)
        before=self.conn.execute('SELECT count(*) FROM erp_prenotificaciones').fetchone()[0]
        draft=self.service.notification_draft(self.session,QueryEnvelope('erp4.notification.draft',self.community,{'receipt_ids':p['receipt_ids'],'requested_on':p['requested_on']}))['entity']
        self.assertFalse(draft['sent']);self.assertNotIn(IBAN,json.dumps(draft))
        self.assertEqual(before,self.conn.execute('SELECT count(*) FROM erp_prenotificaciones').fetchone()[0])
        notice=self.service.notification_record(self.session,self.envelope('notification.record',{'sent_on':date.today().isoformat(),
            'lines':[{'receipt_id':rid,'amount_cents':'10000','requested_on':p['requested_on'],'mandate_id':m['id']} for rid in p['receipt_ids']]}))['entity']
        p['notification_id']=notice['id'];p.pop('preview_hash')
        preview=self.service.remittance_preview(self.session,self.envelope('remittance.preview',p))['entity']
        self.assertEqual(preview['total_cents'],'2000000')
        rem=self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',{**p,'preview_hash':preview['preview_hash']}))['entity']
        self.assertEqual(rem['count'],200)
        built=self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':rem['id']},version=1))['entity']
        self.grant('results');self.grant('export')
        exported=self.service.remittance_export(self.session,self.envelope('remittance.export',{'file_id':built['file_id'],'acknowledge_bank_data':True},version=2))['entity']
        xml=self.service.download_bytes(self.session,self.community,exported['download_token'])
        self.assertEqual(xml.count(b'<DrctDbtTxInf>'),200)
        self.assertIn(b'<CtrlSum>20000.00</CtrlSum>',xml)
        raw=self.pain002(built,'RJCT')
        imported=self.service.results_import(self.session,self.envelope('results.import',{'format':'pain002','data':base64.b64encode(raw).decode(),'effective_on':date.today().isoformat()}))['entity']
        decisions=[{'result_line_id':r[0],'action':'none'} for r in self.conn.execute('SELECT id FROM erp_resultado_lineas WHERE result_id=?',(imported['id'],))]
        plan={'result_id':imported['id'],'decisions':decisions}
        pv=self.service.results_preview(self.session,self.envelope('results.preview',plan))['entity']
        self.service.results_confirm(self.session,self.envelope('results.confirm',{**plan,'preview_hash':pv['preview_hash']},version=pv['version']))
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],0)
        self.assertEqual(sum(int(receipt_balance(self.conn,self.community,r)['pending_cents']) for r in p['receipt_ids']),2000000)

    def test_84_artifact_failure_is_atomic_and_new_edit_queries_are_scoped(self):
        from unittest.mock import patch
        p,m=self.remittance_setup()
        edit=self.service.mandate_edit(self.session,QueryEnvelope('erp4.mandate.edit',self.community,{'id':m['id']}))['entity']
        self.assertEqual(edit['payload']['id'],m['id']);self.assertNotIn(IBAN,json.dumps(edit))
        rem=self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',p))['entity']
        original=self.service.vault.put
        def broken(conn,community,purpose,value,now):
            if purpose=='remittance-file':raise RuntimeError('Synthetic artifact persistence failure')
            return original(conn,community,purpose,value,now)
        with patch.object(self.service.vault,'put',side_effect=broken):
            with self.assertRaises(RuntimeError):self.service.remittance_build(self.session,self.envelope('remittance.build',{'id':rem['id']},version=1))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_remesa_ficheros').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT version FROM erp_remesas WHERE id=?',(rem['id'],)).fetchone()[0],1)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],3)
        self.grant('results')
        line=self.conn.execute('SELECT id,attempt_key FROM erp_remesa_lineas ORDER BY id LIMIT 1').fetchone()
        found=self.service.instruction_find(self.session,QueryEnvelope('erp4.instruction.find',self.community,{'attempt_key':line['attempt_key']}))['entity']
        self.assertEqual(found['id'],line['id'])
        with self.assertRaises(NotFoundError):self.service.instruction_find(self.session,QueryEnvelope('erp4.instruction.find',self.community,{'attempt_key':line['attempt_key'][:-1]}))

    def erp3_command(self,name,payload,version=None):
        env=replace(self.envelope('unused',payload,version=version),command='erp3.'+name)
        return getattr(ReceivablesService(self.db),name.replace('.','_'))(self.session,env)['entity']

    def test_85_external_selection_search_pages_and_confirmed_subset(self):
        p,m=self.remittance_setup();self.grant('read_masked')
        page=self.service.reference_list(self.session,QueryEnvelope('erp4.reference.list',self.community,{'kind':'receipts','limit':2}))['entity']
        second=self.service.reference_list(self.session,QueryEnvelope('erp4.reference.list',self.community,{'kind':'receipts','limit':2,'offset':2}))['entity']
        self.assertGreaterEqual(page['total'],3);self.assertFalse(set(r['id'] for r in page['items'])&set(r['id'] for r in second['items']))
        row=page['items'][0]
        found=self.service.reference_list(self.session,QueryEnvelope('erp4.reference.list',self.community,{'kind':'receipts','search':row['number']}))['entity']
        self.assertIn(row['id'],[r['id'] for r in found['items']])
        self.service.external_register(self.session,self.envelope('external.register',{'receipt_ids':[row['id']],
            'source':'Synthetic cutover','reference':'SYN-85','cutoff_on':date.today().isoformat()}))
        control=self.service.control_list(self.session,QueryEnvelope('erp4.control.list',self.community,{'search':row['number'],'limit':1}))['entity']
        self.assertEqual(control['total'],1);self.assertEqual(control['external_instructions'][0]['receipt_id'],row['id'])
        found=self.service.reference_list(self.session,QueryEnvelope('erp4.reference.list',self.community,{'kind':'receipts','search':row['number']}))['entity']
        self.assertTrue(next(r for r in found['items'] if r['id']==row['id'])['issues'])
        empty=self.service.control_list(self.session,QueryEnvelope('erp4.control.list',self.community,{'offset':1}))['entity']
        self.assertEqual(empty['external_instructions'],[]);self.assertEqual(empty['total'],1)

    def test_86_bank_partial_return_and_locked_exercise_keep_economic_boundary(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        paid,_=self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        collection=paid['entity']['applied'][0]['collection_id']
        allocation=self.conn.execute('SELECT id FROM erp_imputaciones WHERE collection_id=?',(collection,)).fetchone()[0]
        result,row=self.stage_bank_result(line,'returned',event='BANK-PARTIAL-RETURN',amount='4000')
        returned,env=self.confirm_result(result,row,'return',collection_id=collection,
            return_spec={'free_cents':'0','reversals':[{'allocation_id':allocation,'amount_cents':'4000'}]})
        self.assertTrue(self.service.results_confirm(self.session,env)['idempotent_replay'])
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'4000')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['original_cents'],'10000')
        exercise=self.conn.execute('SELECT id_ejercicio,estado FROM erp_ejercicios WHERE id_comunidad=? AND fecha_inicio<=? AND fecha_fin>=?',(self.community,date.today().isoformat(),date.today().isoformat())).fetchone()
        self.assertIsNotNone(exercise)
        self.conn.execute("UPDATE erp_ejercicios SET estado='cerrado' WHERE id_ejercicio=?",(exercise['id_ejercicio'],))
        other=dict(self.conn.execute('SELECT * FROM erp_remesa_lineas WHERE id!=? LIMIT 1',(line['id'],)).fetchone())
        result,row=self.stage_bank_result(other,'settlement',event='BANK-LOCKED')
        before=self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0]
        with self.assertRaises(ConflictError):self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0],before)
        self.assertEqual(self.conn.execute('SELECT state FROM erp_resultado_lineas WHERE id=?',(row,)).fetchone()[0],'pendiente')
        self.assertEqual(self.conn.execute('SELECT estado FROM erp_ejercicios WHERE id_ejercicio=?',(exercise['id_ejercicio'],)).fetchone()[0],'cerrado')

    def test_87_manual_collection_after_export_keeps_funds_and_flags_snapshot(self):
        self.allow_economic_changes=True
        p,m,rem,built,line=self.bank_result_fixture()
        original_file=self.conn.execute('SELECT secret_id FROM erp_remesa_ficheros WHERE id=?',(built['file_id'],)).fetchone()[0]
        cash=self.erp3_command('collection.record',{'amount_cents':'4000','currency':'EUR','effective_on':date.today().isoformat(),
            'method':'transferencia','external_source':'synthetic-manual','external_key':'MANUAL-87'})
        proposal=self.erp3_command('allocation.preview',{'collection_id':cash['id'],'effective_on':date.today().isoformat(),
            'allocations':[{'receipt_id':line['receipt_id'],'amount_cents':'4000'}]})
        self.erp3_command('allocation.confirm',{'proposal_id':proposal['id']},1)
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'6000')
        current=self.conn.execute('SELECT * FROM erp_remesas WHERE id=?',(rem['id'],)).fetchone()
        self.assertEqual(current['needs_review'],1)
        self.assertEqual(self.conn.execute('SELECT secret_id FROM erp_remesa_ficheros WHERE id=?',(built['file_id'],)).fetchone()[0],original_file)
        self.assertEqual(self.conn.execute('SELECT state FROM erp_remesa_reservas WHERE line_id=?',(line['id'],)).fetchone()[0],'activa')
        redownload=self.service.remittance_export(self.session,self.envelope('remittance.export',{'file_id':built['file_id'],'acknowledge_bank_data':True},version=current['version']))['entity']
        self.assertIn(b'<InstdAmt Ccy="EUR">100.00</InstdAmt>',self.service.download_bytes(self.session,self.community,redownload['download_token']))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_remesa_ficheros').fetchone()[0],1)

    def test_88_partial_return_fee_uses_existing_policy_and_original_receipt(self):
        self.allow_economic_changes=True
        *_,line=self.bank_result_fixture()
        result,row=self.stage_bank_result(line,'settlement')
        paid,_=self.confirm_result(result,row,'record_collection',allocate_cents='10000')
        cid=paid['entity']['applied'][0]['collection_id']
        aid=self.conn.execute('SELECT id FROM erp_imputaciones WHERE collection_id=?',(cid,)).fetchone()[0]
        result,row=self.stage_bank_result(line,'returned',event='BANK-RETURN-FEE',amount='4000')
        returned,_=self.confirm_result(result,row,'return',collection_id=cid,return_spec={'free_cents':'0','reversals':[{'allocation_id':aid,'amount_cents':'4000'}]})
        did=returned['entity']['applied'][0]['return_id']
        self.erp3_command('policy.save',{'effective_from':date.today().isoformat(),'return_fee_mode':'actual','fixed_cents':'0'},0)
        exercise=self.conn.execute('SELECT id_ejercicio FROM erp_recibos WHERE id=?',(line['receipt_id'],)).fetchone()[0]
        proposal=self.erp3_command('return.fee.preview',{'return_id':did,'receipt_id':line['receipt_id'],'effective_on':date.today().isoformat(),
            'cost_cents':'500','cost_reference':'BANK-FEE-88','exercise_id':exercise})
        fee=self.erp3_command('return.fee.confirm',{'proposal_id':proposal['id']},1)
        self.synthetic_receipts.add(fee['receipt_id'])
        self.assertNotEqual(fee['receipt_id'],line['receipt_id'])
        self.assertEqual(receipt_balance(self.conn,self.community,fee['receipt_id'])['pending_cents'],'500')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['original_cents'],'10000')
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'4000')

    def test_89_partial_zero_void_and_observed_sources_are_not_mixed(self):
        self.allow_economic_changes=True
        p,m=self.remittance_setup();self.grant('read_masked')
        rid,zero,void=p['receipt_ids']
        cash=self.erp3_command('collection.record',{'amount_cents':'14000','currency':'EUR','effective_on':date.today().isoformat(),
            'method':'transferencia','external_source':'synthetic-selection','external_key':'SELECT-89'})
        proposal=self.erp3_command('allocation.preview',{'collection_id':cash['id'],'effective_on':date.today().isoformat(),
            'allocations':[{'receipt_id':rid,'amount_cents':'4000'},{'receipt_id':zero,'amount_cents':'10000'}]})
        self.erp3_command('allocation.confirm',{'proposal_id':proposal['id']},1)
        proposal=self.erp3_command('void.preview',{'receipt_id':void,'effective_on':date.today().isoformat()})
        self.erp3_command('void.confirm',{'proposal_id':proposal['id']},1)
        rows=self.service.receipt_candidates(self.session,QueryEnvelope('erp4.receipt.candidates',self.community,{'creditor_id':p['creditor_id'],'requested_on':p['requested_on']}))['entity']['items']
        mapped={r['id']:r for r in rows}
        self.assertEqual(mapped[rid]['pending_cents'],'6000');self.assertFalse(mapped[rid]['issues'])
        self.assertTrue(mapped[zero]['issues']);self.assertTrue(mapped[void]['issues'])
        # Legacy observed receipts and aggregate openings have no remittable receipt identity.
        self.assertEqual({r['id'] for r in rows},{r[0] for r in self.conn.execute('SELECT id FROM erp_recibos WHERE id_comunidad=?',(self.community,))})
        notice=self.service.notification_record(self.session,self.envelope('notification.record',{'sent_on':date.today().isoformat(),
            'lines':[{'receipt_id':rid,'amount_cents':'6000','requested_on':p['requested_on'],'mandate_id':m['id']}]}))['entity']
        preview=self.service.remittance_preview(self.session,self.envelope('remittance.preview',{**p,'receipt_ids':[rid],'notification_id':notice['id']}))['entity']
        self.assertEqual(preview['total_cents'],'6000')

    def test_90_ambiguous_generic_and_suspended_specific_do_not_fall_back(self):
        p,m=self.remittance_setup()
        receipt=self.conn.execute('SELECT * FROM erp_recibos WHERE id=?',(p['receipt_ids'][0],)).fetchone()
        old=dict(self.conn.execute('SELECT * FROM erp_domiciliaciones WHERE property_id=?',(receipt['id_propiedad'],)).fetchone())
        new={k:v for k,v in old.items() if k!='id'};new['scope']='second-test-scope'
        did=self.conn.execute('INSERT INTO erp_domiciliaciones ('+','.join(new)+') VALUES ('+','.join('?' for _ in new)+')',tuple(new.values())).lastrowid
        version=dict(self.conn.execute('SELECT * FROM erp_domiciliacion_versiones WHERE direct_debit_id=?',(old['id'],)).fetchone())
        row={k:v for k,v in version.items() if k!='id'};row['direct_debit_id']=did
        self.conn.execute('INSERT INTO erp_domiciliacion_versiones ('+','.join(row)+') VALUES ('+','.join('?' for _ in row)+')',tuple(row.values()))
        with self.assertRaises(ContractError):self.service._direct_for_receipt(self.conn,self.community,receipt,p['requested_on'])
        self.conn.execute('UPDATE erp_domiciliaciones SET concept_key=? WHERE id=?',(receipt['concept_key'],did))
        self.assertEqual(self.service._direct_for_receipt(self.conn,self.community,receipt,p['requested_on'])['id'],did)
        self.service.direct_debit_state(self.session,self.envelope('direct_debit.state',{'id':did,'state':'suspendida','effective_from':date.today().isoformat()},version=1))
        with self.assertRaises(ContractError):self.service._direct_for_receipt(self.conn,self.community,receipt,p['requested_on'])

    def test_91_representative_shared_account_and_creditor_business_rum_collision(self):
        p,m=self.remittance_setup(third_party=True);self.grant('read_masked')
        edit=self.service.mandate_edit(self.session,QueryEnvelope('erp4.mandate.edit',self.community,{'id':m['id']}))['entity']
        payload=edit['payload'];debtor=payload['debtor']
        representative=self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? AND id_propietario!=? LIMIT 1',(self.community,debtor['id'])).fetchone()[0]
        self.service.account_link(self.session,self.envelope('account.link',{'account_id':payload['account_id'],'subject':debtor,'role':'titular','effective_from':'2026-01-01'},version=1))
        account=self.conn.execute('SELECT version FROM erp_cuentas_pagador WHERE id=?',(payload['account_id'],)).fetchone()
        self.service.account_link(self.session,self.envelope('account.link',{'account_id':payload['account_id'],'subject':{'type':'owner','id':representative},'role':'titular','effective_from':'2026-01-01'},version=account['version']))
        payload['signers']=[{'subject':{'type':'owner','id':representative},'capacity':'Representante acreditado de cotitulares'}]
        payload['effective_from']=date.today().isoformat()
        amended=self.service.mandate_amend(self.session,self.envelope('mandate.amend',payload,version=edit['version']))['entity']
        self.service.mandate_transition(self.session,self.envelope('mandate.transition',{'id':m['id'],'state':'activo','effective_on':date.today().isoformat()},version=amended['version']))
        p['third_party_authorizations']={str(r):{'mandate_id':m['id'],'evidence':{'type':'external_reference','id':'AUTHORIZED-REPRESENTATIVE'}} for r in p['receipt_ids']}
        preview=self.service.remittance_preview(self.session,self.envelope('remittance.preview',p))['entity']
        self.assertEqual(len(preview['lines']),3)
        self.assertTrue(all(l['third_party'] for l in preview['lines']))
        creditor=self.service.creditor_list(self.session,QueryEnvelope('erp4.creditor.list',self.community,{}))['entity']['items'][0]
        cid=creditor['creditor_identifier'];alternate=cid[:4]+'ABC'+cid[7:]
        new=self.service.creditor_create(self.session,self.envelope('creditor.create',{'name':'Comunidad sintetica','creditor_identifier':alternate,'iban':IBAN,
            'address':{'country':'ES','town':'Madrid'},'effective_from':'2026-01-01'}))['entity']
        creation={k:v for k,v in payload.items() if k!='id'}
        creation.update(creditor_id=new['id'],kind='recurrente',rum='synthetic-mandate')
        with self.assertRaises(ConflictError):self.service.mandate_create(self.session,self.envelope('mandate.create',creation))

    def test_92_cancel_midway_rolls_back_every_reservation(self):
        p,m=self.remittance_setup()
        rem=self.service.remittance_prepare(self.session,self.envelope('remittance.prepare',p))['entity']
        self.conn.execute("""CREATE TRIGGER synthetic_cancel_failure AFTER UPDATE OF state ON erp_remesa_reservas
            WHEN NEW.state='liberada' BEGIN
            SELECT CASE WHEN (SELECT count(*) FROM erp_remesa_reservas WHERE state='liberada')=2
            THEN RAISE(ABORT,'synthetic midway failure') END; END""")
        env=self.envelope('remittance.cancel_local',{'id':rem['id']},version=1)
        with self.assertRaises((ConflictError,sqlite3.IntegrityError)):self.service.remittance_cancel_local(self.session,env)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],3)
        self.assertEqual(self.conn.execute('SELECT version FROM erp_remesas WHERE id=?',(rem['id'],)).fetchone()[0],1)
        self.conn.execute('DROP TRIGGER synthetic_cancel_failure')
        self.service.remittance_cancel_local(self.session,env)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_remesa_reservas WHERE state='activa'").fetchone()[0],0)

if __name__ == '__main__':
    print('Isolated ERP4 workspace:', WORK, flush=True)
    unittest.main(verbosity=2)
