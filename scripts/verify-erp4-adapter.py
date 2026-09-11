"""Pure CORE adapter acceptance on synthetic data, without server or database writes."""

from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server'))
from erp_core.banking_adapter import (PROFILE_ID, NS, STATUS_NS, build_core, parse_status,
                                     parse_xml, profile_config, validate_schedule, validate_xml)
from erp_core.errors import ContractError


def fixture():
    config = {'bank_name': 'Entidad sintetica', 'timezone': 'Europe/Madrid', 'cutoff': '14:00',
              'lead_business_days': 1, 'holidays': [], 'countries': ['ES', 'DE'], 'max_lines': 10000,
              'max_total_cents': '100000000', 'recurrent_sequence': 'RCUR', 'mode': 'test',
              'bank_profile_accepted': False, 'external_instructions_reviewed': False}
    line = {'amount_cents': '3334', 'attempt_key': 'E00000000000000000000000000000001',
            'sequence': 'RCUR', 'kind': 'recurrente', 'concept': 'Cuota ordinaria sintetica',
            'mandate': {'rum': 'MANDATO-SINTETICO'}, 'signed_on': '2026-01-01',
            'mandate_details': {'debtor_name': 'Persona sintetica', 'address': {'country': 'ES', 'town': 'Madrid'}, 'amendment': False},
            'payer_account': {'iban': 'ES9121000418450200051332'},
            'creditor_account': {'iban': 'ES9121000418450200051332'},
            'creditor': {'name': 'Comunidad sintetica', 'creditor_identifier': 'ES97000M12345678',
                         'address': {'country': 'ES', 'town': 'Madrid', 'street': 'Calle de prueba', 'building': '1'}}}
    lines = []
    for index, value in enumerate(('3334', '3333', '3333'), 1):
        item = deepcopy(line)
        item.update(amount_cents=value, attempt_key='E' + str(index).zfill(32))
        lines.append(item)
    return {'message_id': 'M00000000000000000000000000000001', 'created_at': '2026-09-11T09:00:00+00:00',
            'requested_on': '2026-09-28', 'profile_id': PROFILE_ID, 'lines': lines}, config


def status_xml(status='ACSC'):
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="{STATUS_NS}"><CstmrPmtStsRpt><GrpHdr><MsgId>BANK-RESULT</MsgId>
<CreDtTm>2026-09-28T12:00:00Z</CreDtTm><InitgPty><Nm>Banco sintetico</Nm></InitgPty></GrpHdr>
<OrgnlGrpInfAndSts><OrgnlMsgId>M00000000000000000000000000000001</OrgnlMsgId>
<OrgnlMsgNmId>pain.008.001.08</OrgnlMsgNmId><GrpSts>{status}</GrpSts></OrgnlGrpInfAndSts>
</CstmrPmtStsRpt></Document>'''.encode()


class AdapterTests(unittest.TestCase):
    def test_01_xsd_and_exact_totals(self):
        data, cfg = fixture()
        xml, meta = build_core(data, cfg)
        root = validate_xml(xml, 'pain.008.001.08')
        ns = {'p': NS}
        self.assertEqual(root.findtext('p:CstmrDrctDbtInitn/p:GrpHdr/p:CtrlSum', namespaces=ns), '100.00')
        self.assertEqual(root.findall('.//p:InstdAmt', ns)[0].text, '33.34')
        self.assertEqual(meta['total_cents'], '10000')
        self.assertEqual(meta['count'], 3)
        self.assertEqual(meta['length'], len(xml))

    def test_02_reproduction_is_byte_identical(self):
        data, cfg = fixture()
        original = deepcopy(data)
        self.assertEqual(build_core(data, cfg), build_core(deepcopy(data), deepcopy(cfg)))
        self.assertEqual(original, data)

    def test_03_reject_duplicates(self):
        data, cfg = fixture()
        data['lines'][1]['attempt_key'] = data['lines'][0]['attempt_key']
        with self.assertRaises(ContractError):
            build_core(data, cfg)

    def test_04_invalid_missing_iban_and_unsupported_country(self):
        for account in ('ES9100000000000000000000', '', 'FR1420041010050500013M02606'):
            data, cfg = fixture()
            data['lines'][0]['payer_account']['iban'] = account
            with self.assertRaises(ContractError):
                build_core(data, cfg)

    def test_05_missing_address_and_length(self):
        data, cfg = fixture()
        data['lines'][0]['mandate_details']['address']['town'] = ''
        with self.assertRaises(ContractError):
            build_core(data, cfg)
        data, cfg = fixture()
        data['lines'][0]['mandate_details']['debtor_name'] = 'X' * 71
        with self.assertRaises(ContractError):
            build_core(data, cfg)

    def test_06_amendment_requires_original_account(self):
        data, cfg = fixture()
        data['lines'][0]['mandate_details']['amendment'] = True
        with self.assertRaises(ContractError):
            build_core(data, cfg)
        data['lines'][0]['original_debtor_iban'] = 'DE89370400440532013000'
        xml, _ = build_core(data, cfg)
        self.assertIn(b'OrgnlDbtrAcct', xml)

    def test_07_sequences_are_separate_groups(self):
        data, cfg = fixture()
        data['lines'][0].update(sequence='OOFF', kind='puntual')
        _, meta = build_core(data, cfg)
        self.assertEqual(len(meta['payment_groups']), 2)

    def test_08_calendar_cutoff_holiday(self):
        _, cfg = fixture()
        validate_schedule(cfg, '2026-09-14', '2026-09-11T09:00:00Z')
        with self.assertRaises(ContractError):
            validate_schedule(cfg, '2026-09-14', '2026-09-11T15:00:00Z')
        cfg['holidays'] = ['2026-09-14']
        with self.assertRaises(ContractError):
            validate_schedule(cfg, '2026-09-14', '2026-09-11T09:00:00Z')
        validate_schedule(cfg, '2026-09-15', '2026-09-11T09:00:00Z')

    def test_09_live_requires_explicit_acceptance(self):
        _, cfg = fixture()
        cfg['mode'] = 'live'
        with self.assertRaises(ContractError):
            profile_config(cfg)
        cfg.update(bank_profile_accepted=True, external_instructions_reviewed=True)
        self.assertEqual(profile_config(cfg)['mode'], 'live')

    def test_10_limits_and_non_exact_inputs(self):
        data, cfg = fixture()
        cfg['max_lines'] = 2
        with self.assertRaises(ContractError):
            build_core(data, cfg)
        cfg['max_lines'] = 100
        cfg['max_total_cents'] = '9999'
        with self.assertRaises(ContractError):
            build_core(data, cfg)
        cfg['max_total_cents'] = '10000'
        data['lines'][0]['amount_cents'] = 33.34
        with self.assertRaises(ContractError):
            build_core(data, cfg)

    def test_11_xxe_dtd_and_large_input(self):
        malicious = b'<!DOCTYPE Document [<!ENTITY leak SYSTEM "file:///etc/passwd">]><Document>&leak;</Document>'
        for xml in (malicious, b'<x>' * 40 + b'</x>' * 40, b'x' * (16 * 1024 * 1024 + 1)):
            with self.assertRaises(ContractError):
                parse_xml(xml)

    def test_12_schema_integrity_fail_closed(self):
        with patch('erp_core.banking_adapter.Path.read_bytes', return_value=b'<schema/>'):
            with self.assertRaises(ContractError):
                validate_xml(b'<Document/>', 'pain.008.001.08')

    def test_13_accepted_does_not_imply_settlement(self):
        result = parse_status(status_xml('ACSC'))
        self.assertEqual(result['entries'][0]['type'], 'technical')
        self.assertNotIn('collection_id', result)

    def test_14_reject_and_pending_status(self):
        self.assertEqual(parse_status(status_xml('RJCT'))['entries'][0]['type'], 'rejected')
        self.assertEqual(parse_status(status_xml('PDNG'))['entries'][0]['type'], 'pending')

    def test_15_foreign_message_is_not_interpreted(self):
        with self.assertRaises(ContractError):
            parse_status(status_xml().replace(b'pain.008.001.08', b'pain.001.001.09'))

    def test_16_200_lines_and_structured_address_after_boundary(self):
        data, cfg = fixture()
        data['created_at'] = '2026-11-16T09:00:00Z'
        data['requested_on'] = '2026-12-01'
        original = data['lines'][0]
        data['lines'] = [{**deepcopy(original), 'attempt_key': 'E' + str(i).zfill(32), 'amount_cents': '100'} for i in range(200)]
        xml, meta = build_core(data, cfg)
        self.assertEqual(meta['count'], 200)
        self.assertEqual(meta['total_cents'], '20000')
        self.assertIn(b'<TwnNm>Madrid</TwnNm>', xml)
        self.assertNotIn(b'<AdrLine>', xml)

    def test_17_oneoff_cannot_be_used_twice_in_same_file(self):
        data, cfg = fixture()
        for line in data['lines'][:2]:
            line.update(sequence='OOFF', kind='puntual')
        with self.assertRaises(ContractError):
            build_core(data, cfg)


unittest.main(verbosity=2)
