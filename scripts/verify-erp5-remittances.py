"""ERP 5 -> ERP 4 -> ERP 3 atomic acceptance, using existing isolated fixtures."""
from dataclasses import replace
from datetime import date
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1];source=sys.argv[1];requested=sys.argv[2:]
sys.argv=[sys.argv[0],source]
bank=runpy.run_path(str(ROOT/'scripts/verify-erp4-foundations.py'))
from erp_core.reconciliation_service import ReconciliationService,CAPABILITIES
from erp_core.contracts import QueryEnvelope
from erp_core.errors import ConflictError


class RemittanceIntegrationTests(bank['BankingTests']):
    def setUp(self):
        super().setUp();self.allow_economic_changes=True
        self.reconciliation=ReconciliationService(self.db,vault=self.vault)
        for cap in CAPABILITIES:self.reconciliation.permissions_save(self.session,self.e5('permissions.save',{'user_id':self.uid,'capability':cap,'allowed':True},0))

    def e5(self,name,p,version=None):return replace(self.envelope(name,p,version=version),command='erp5.'+name)

    def movement(self,n):
        treasury=self.conn.execute('SELECT treasury_id FROM erp_acreedor_versiones WHERE id_comunidad=? ORDER BY id LIMIT 1',(self.community,)).fetchone()[0]
        preview=self.reconciliation.statement_preview(self.session,self.e5('statement.preview',{'treasury_id':treasury,'profile':'manual-v1',
            'rows':[{'operation_on':date.today().isoformat(),'amount_cents':str(n),'concept':'Liquidacion sintetica'}]}))['entity']
        return self.reconciliation.statement_confirm(self.session,self.e5('statement.confirm',{'id':preview['id']},1))['entity']['movement_ids'][0]

    def result_match(self,mid,result,decisions,n):
        p=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':mid,'action':'bank_result',
            'amount_cents':str(n),'bank_result':{'result_id':result['id'],'decisions':decisions}}]}))['entity']
        return self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':p['id']},1))['entity']

    def test_integration_01_new_settlement_atomic(self):
        *_,line=self.bank_result_fixture();result,row=self.stage_bank_result(line,'settlement');mid=self.movement('10000')
        self.result_match(mid,result,[{'result_line_id':row,'action':'record_collection','allocate_cents':'10000'}],'10000')
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp4'").fetchone()[0],1)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_banco_operacion_vinculos').fetchone()[0],1)
        from erp_core.receivables_projection import receipt_balance
        self.assertEqual(receipt_balance(self.conn,self.community,line['receipt_id'])['pending_cents'],'0')

    def test_integration_02_existing_settlement_no_second_funds(self):
        *_,line=self.bank_result_fixture();first,row=self.stage_bank_result(line,'settlement')
        self.confirm_result(first,row,'record_collection',allocate_cents='10000')
        other,otherrow=self.stage_bank_result(line,'settlement',notes='Nueva evidencia');mid=self.movement('10000')
        before=self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0]
        self.result_match(mid,other,[{'result_line_id':otherrow,'action':'record_collection','allocate_cents':'10000'}],'10000')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0],before)

    def test_integration_03_failure_rolls_back_all_domains(self):
        *_,line=self.bank_result_fixture();result,row=self.stage_bank_result(line,'settlement');mid=self.movement('10000')
        baseline={t:self.conn.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('erp_cobros','erp_imputaciones','erp_banco_operaciones','erp_banco_operacion_vinculos')}
        with patch.object(self.reconciliation,'_event',side_effect=RuntimeError('Synthetic failure')):
            with self.assertRaises(RuntimeError):self.result_match(mid,result,[{'result_line_id':row,'action':'record_collection','allocate_cents':'10000'}],'10000')
        self.assertEqual(baseline,{t:self.conn.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in baseline})

    def test_integration_04_rejected_not_money(self):
        *_,line=self.bank_result_fixture();result,row=self.stage_bank_result(line,'rejected');mid=self.movement('10000')
        from erp_core.errors import ContractError
        with self.assertRaises(ContractError):self.result_match(mid,result,[{'result_line_id':row,'action':'none'}],'10000')

    def test_integration_05_one_movement_two_receipts_partial_debt(self):
        p,_=self.remittance_setup();mid=self.movement('15000')
        proposal=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':mid,'action':'record_collection','amount_cents':'15000',
            'allocations':[{'receipt_id':p['receipt_ids'][0],'amount_cents':'10000'},{'receipt_id':p['receipt_ids'][1],'amount_cents':'5000'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':proposal['id']},1))
        from erp_core.receivables_projection import receipt_balance
        self.assertEqual(receipt_balance(self.conn,self.community,p['receipt_ids'][0])['pending_cents'],'0')
        self.assertEqual(receipt_balance(self.conn,self.community,p['receipt_ids'][1])['pending_cents'],'5000')
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp5'").fetchone()[0],1)

    def test_integration_06_stale_receipt_proposal_is_not_confirmed(self):
        p,_=self.remittance_setup();mid=self.movement('10000')
        proposal=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':mid,'action':'record_collection','amount_cents':'5000',
            'allocations':[{'receipt_id':p['receipt_ids'][0],'amount_cents':'5000'}]}]}))['entity']
        other=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':mid,'action':'record_collection','amount_cents':'1000',
            'allocations':[{'receipt_id':p['receipt_ids'][0],'amount_cents':'1000'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':other['id']},1))
        with self.assertRaises(ConflictError):self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':proposal['id']},1))

    def identified_movement(self,kind,n,event):
        treasury=self.conn.execute('SELECT treasury_id FROM erp_acreedor_versiones WHERE id_comunidad=? ORDER BY id LIMIT 1',(self.community,)).fetchone()[0]
        preview=self.reconciliation.statement_preview(self.session,self.e5('statement.preview',{'treasury_id':treasury,'profile':'manual-v1',
            'rows':[{'operation_on':date.today().isoformat(),'amount_cents':n,'concept':'Ocurrencia sintetica',
                'namespace':'erp4:SYNTHETIC-PSP:CORE:'+kind,'external_id':event}]}))['entity']
        return self.reconciliation.statement_confirm(self.session,self.e5('statement.confirm',{'id':preview['id']},1))['entity']['movement_ids'][0]

    def test_integration_07_extract_before_result_links_existing_funds(self):
        *_,line=self.bank_result_fixture();mid=self.identified_movement('settlement','10000','ARRIVAL-1')
        proposal=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':mid,
            'action':'record_collection','amount_cents':'10000','allocations':[{'receipt_id':line['receipt_id'],'amount_cents':'10000'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':proposal['id']},1))
        collection=self.conn.execute("SELECT id FROM erp_cobros WHERE external_source='erp5' ORDER BY id DESC LIMIT 1").fetchone()[0]
        result,row=self.stage_bank_result(line,'settlement',event='ARRIVAL-1')
        with self.assertRaises(ConflictError):self.confirm_result(result,row,'record_collection',allocate_cents='0')
        before=self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0]
        self.confirm_result(result,row,'link_collection',collection_id=collection,allocate_cents='0')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0],before)

    def test_integration_08_return_before_result_does_not_return_twice(self):
        *_,line=self.bank_result_fixture();settled,row=self.stage_bank_result(line,'settlement',event='SETTLED-8')
        self.confirm_result(settled,row,'record_collection',allocate_cents='10000')
        collection=self.conn.execute('SELECT collection_id FROM erp_banco_operaciones ORDER BY id DESC LIMIT 1').fetchone()[0]
        allocation=self.conn.execute('SELECT id FROM erp_imputaciones WHERE collection_id=?',(collection,)).fetchone()[0]
        mid=self.identified_movement('returned','-10000','RETURN-8')
        proposal=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':mid,'action':'return','amount_cents':'-10000',
            'return_payload':{'collection_id':collection,'effective_on':date.today().isoformat(),'free_cents':'0','reversals':[{'allocation_id':allocation,'amount_cents':'10000'}],
                'external_key':'erp5-return-first'}}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':proposal['id']},1))
        returned=self.conn.execute('SELECT id FROM erp_devoluciones ORDER BY id DESC LIMIT 1').fetchone()[0]
        result,row=self.stage_bank_result(line,'returned',event='RETURN-8')
        choices=self.service.results_choices(self.session,QueryEnvelope('erp4.results.choices',self.community,{'result_line_id':row}))['entity']
        self.assertEqual(choices['returns'][0]['id'],returned)
        with self.assertRaises(ConflictError):self.confirm_result(result,row,'return',collection_id=collection,return_spec={'free_cents':'0','reversals':[]})
        self.confirm_result(result,row,'link_return',collection_id=collection,return_id=returned)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_devoluciones WHERE collection_id=?',(collection,)).fetchone()[0],1)

    def test_integration_09_exact_receipt_reference_proposes_structured_application(self):
        p,_=self.remittance_setup();receipt=self.conn.execute('SELECT * FROM erp_recibos WHERE id=?',(p['receipt_ids'][0],)).fetchone()
        treasury=self.conn.execute('SELECT treasury_id FROM erp_acreedor_versiones WHERE id_comunidad=? LIMIT 1',(self.community,)).fetchone()[0]
        preview=self.reconciliation.statement_preview(self.session,self.e5('statement.preview',{'treasury_id':treasury,'profile':'manual-v1',
            'rows':[{'operation_on':date.today().isoformat(),'amount_cents':'10000','reference':receipt['number'],'concept':'Pago sintetico'}]}))['entity']
        mid=self.reconciliation.statement_confirm(self.session,self.e5('statement.confirm',{'id':preview['id']},1))['entity']['movement_ids'][0]
        candidates=self.reconciliation.proposals_get(self.session,QueryEnvelope('erp5.proposals.get',self.community,{'movement_id':mid}))['entity']
        self.assertEqual(candidates['items'][0]['action'],'record_collection')
        self.assertEqual(candidates['items'][0]['allocations'],[{'receipt_id':receipt['id'],'amount_cents':'10000'}])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp5'").fetchone()[0],0)
        candidate=candidates['items'][0];self.assertEqual(candidate['confidence'],'alta')
        component={k:candidate[k] for k in ('action','amount_cents','allocations')};component['movement_id']=mid
        proposal=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[component]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':proposal['id']},1))
        from erp_core.receivables_projection import receipt_balance
        self.assertEqual(receipt_balance(self.conn,self.community,receipt['id'])['pending_cents'],'0')
        self.assertEqual(self.conn.execute("SELECT count(*) FROM erp_cobros WHERE external_source='erp5'").fetchone()[0],1)

    def test_integration_10_receipt_collection_and_property_contexts(self):
        p,_=self.remittance_setup();mid=self.movement('15000');unrelated=self.movement('7000')
        preview=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':mid,'action':'record_collection','amount_cents':'15000',
            'allocations':[{'receipt_id':p['receipt_ids'][0],'amount_cents':'10000'},{'receipt_id':p['receipt_ids'][1],'amount_cents':'5000'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':preview['id']},1))
        collection=self.conn.execute("SELECT id FROM erp_cobros WHERE external_source='erp5' ORDER BY id DESC LIMIT 1").fetchone()[0]
        receipt=self.conn.execute('SELECT * FROM erp_recibos WHERE id=?',(p['receipt_ids'][0],)).fetchone()
        treasury=self.conn.execute('SELECT treasury_id FROM erp_acreedor_versiones WHERE id_comunidad=? LIMIT 1',(self.community,)).fetchone()[0]
        for context in ({'receipt_id':receipt['id']},{'collection_id':collection},{'property_id':receipt['id_propiedad']}):
            result=self.reconciliation.movement_list(self.session,QueryEnvelope('erp5.movement.list',self.community,{'treasury_id':treasury,**context}))['entity']
            self.assertEqual([r['id'] for r in result['items']],[mid]);self.assertNotIn(unrelated,[r['id'] for r in result['items']])
        from erp_core.errors import NotFoundError
        with self.assertRaises(NotFoundError):self.reconciliation.movement_list(self.session,QueryEnvelope('erp5.movement.list',self.community,{'treasury_id':treasury,'receipt_id':9999999}))


    def test_integration_11_cent_differences_never_change_receipt(self):
        from erp_core.receivables_projection import receipt_balance,collection_balance
        p,_=self.remittance_setup();receipt=p['receipt_ids'][0]
        low=self.movement('9999')
        reviewed=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':low,'action':'record_collection','amount_cents':'9999',
            'allocations':[{'receipt_id':receipt,'amount_cents':'9999'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':reviewed['id']},1))
        self.assertEqual(receipt_balance(self.conn,self.community,receipt,date.today().isoformat())['pending_cents'],'1')
        second=p['receipt_ids'][1];high=self.movement('10001')
        reviewed=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':high,'action':'record_collection','amount_cents':'10001',
            'allocations':[{'receipt_id':second,'amount_cents':'10000'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':reviewed['id']},1))
        collection=self.conn.execute("SELECT id FROM erp_cobros WHERE external_source='erp5' ORDER BY id DESC LIMIT 1").fetchone()[0]
        self.assertEqual(collection_balance(self.conn,self.community,collection,date.today().isoformat())['available_cents'],'1')
        self.assertEqual(self.conn.execute('SELECT amount_cents FROM erp_recibos WHERE id=?',(second,)).fetchone()[0],10000)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_tesoreria_salidas').fetchone()[0],0)


    def test_integration_12_partially_registered_remittance_creates_only_missing_funds(self):
        *_,first=self.bank_result_fixture();second=dict(self.conn.execute('SELECT * FROM erp_remesa_lineas WHERE id<>? ORDER BY id LIMIT 1',(first['id'],)).fetchone())
        settled,row=self.stage_bank_result(first,'settlement',event='PARTIAL-A')
        self.confirm_result(settled,row,'record_collection',allocate_cents='10000')
        existing,existing_row=self.stage_bank_result(first,'settlement',event='PARTIAL-A',notes='Additional bank evidence')
        missing,missing_row=self.stage_bank_result(second,'settlement',event='PARTIAL-B')
        mid=self.movement('20000')
        review=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[
            {'movement_id':mid,'action':'bank_result','amount_cents':'10000','bank_result':{'result_id':existing['id'],'decisions':[{'result_line_id':existing_row,'action':'record_collection','allocate_cents':'10000'}]}},
            {'movement_id':mid,'action':'bank_result','amount_cents':'10000','bank_result':{'result_id':missing['id'],'decisions':[{'result_line_id':missing_row,'action':'record_collection','allocate_cents':'10000'}]}}
        ]}))['entity']
        before=self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0]
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':review['id']},1))
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0],before+1)
        from erp_core.receivables_projection import receipt_balance
        self.assertEqual(receipt_balance(self.conn,self.community,first['receipt_id'])['pending_cents'],'0')
        self.assertEqual(receipt_balance(self.conn,self.community,second['receipt_id'])['pending_cents'],'0')


    def test_integration_14_aggregate_without_reliable_detail_stays_pending(self):
        from erp_core.errors import ContractError
        from erp_core.receivables_projection import receipt_balance
        *_,line=self.bank_result_fixture()
        mid=self.movement('20000')
        receipts=list(self.conn.execute('SELECT receipt_id FROM erp_remesa_lineas WHERE id_comunidad=?',(self.community,)))
        before={r[0]:receipt_balance(self.conn,self.community,r[0])['pending_cents'] for r in receipts}
        tables=('erp_cobros','erp_imputaciones','erp_banco_operaciones','erp_conciliaciones','erp_conciliacion_componentes')
        counts={t:self.conn.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in tables}
        with self.assertRaises(ContractError):
            self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{
                'movement_id':mid,'action':'bank_result','amount_cents':'20000','bank_result':{}}]}))
        proposals=self.reconciliation.proposals_get(self.session,QueryEnvelope('erp5.proposals.get',self.community,{'movement_id':mid}))['entity']
        self.assertFalse(any(p.get('allocations') for p in proposals['items']))
        self.assertEqual(counts,{t:self.conn.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in tables})
        self.assertEqual(before,{r[0]:receipt_balance(self.conn,self.community,r[0])['pending_cents'] for r in receipts})
        self.assertEqual(self.reconciliation.movement_get(self.session,QueryEnvelope('erp5.movement.get',self.community,{'id':mid}))['entity']['remaining_cents'],'20000')

    def test_integration_13_partial_and_multiple_bank_entries_for_one_receipt(self):
        from erp_core.receivables_projection import receipt_balance
        p,_=self.remittance_setup();receipt=p['receipt_ids'][0]
        first=self.movement('6000')
        reviewed=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':first,'action':'record_collection','amount_cents':'6000',
            'allocations':[{'receipt_id':receipt,'amount_cents':'6000'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':reviewed['id']},1))
        self.assertEqual(receipt_balance(self.conn,self.community,receipt)['pending_cents'],'4000')
        second=self.movement('4000')
        reviewed=self.reconciliation.match_preview(self.session,self.e5('match.preview',{'components':[{'movement_id':second,'action':'record_collection','amount_cents':'4000',
            'allocations':[{'receipt_id':receipt,'amount_cents':'4000'}]}]}))['entity']
        self.reconciliation.match_confirm(self.session,self.e5('match.confirm',{'proposal_id':reviewed['id']},1))
        self.assertEqual(receipt_balance(self.conn,self.community,receipt)['pending_cents'],'0')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_imputaciones WHERE receipt_id=?',(receipt,)).fetchone()[0],2)


if __name__=='__main__':
    names=requested or [n for n in dir(RemittanceIntegrationTests) if n.startswith('test_integration_')]
    suite=unittest.TestSuite(RemittanceIntegrationTests(n) for n in names)
    result=unittest.TextTestRunner(verbosity=2).run(suite);raise SystemExit(not result.wasSuccessful())
