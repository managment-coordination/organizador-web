"""ERP 3 migration/transaction tests on an isolated SQLite backup, never production."""

import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))

from access_control import profile
from erp_core.contracts import CommandEnvelope, QueryEnvelope
from erp_core.database import connect
from erp_core.errors import ConflictError, ContractError, NotFoundError
from erp_core.migrations import apply_all
from erp_core.receivables_contracts import cents, day, known_time
from erp_core.receivables_projection import receipt_balance, collection_balance, responsibility_balance
from erp_core.receivables_service import ReceivablesService
from erp_core.dispatcher import execute_command, execute_query


SOURCE=Path(sys.argv[1]).resolve()
sys.argv=sys.argv[:1]
WORK=Path(tempfile.mkdtemp(prefix='organizador-erp3-foundations-'))


def backup(source,target):
    with closing(sqlite3.connect('file:'+str(source)+'?mode=ro',uri=True)) as src:
        with closing(sqlite3.connect(target)) as dst:src.backup(dst)


class ERP3Tests(unittest.TestCase):
    def setUp(self):
        self.db=WORK/(self._testMethodName+'.db');backup(SOURCE,self.db)
        self.conn=connect(self.db)
        self.before={t:self.conn.execute('SELECT count(*) FROM '+t).fetchone()[0] for t in ('cf_recibos','cf_movimientos_deuda','cf_propietarios','cf_propiedades')}
        apply_all(self.conn)
        self.uid=self.conn.execute("SELECT id_usuario FROM usuarios WHERE rol='Superusuario' AND activo=1 LIMIT 1").fetchone()[0]
        self.session=profile(self.conn,self.uid)
        self.community=self.session['comunidades'][0]['id_comunidad']
        self.property=self.conn.execute('SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=? LIMIT 1',(self.community,)).fetchone()[0]
        self.conn.execute('''INSERT INTO erp_ejercicios (id_comunidad,codigo,fecha_inicio,fecha_fin,estado,creado_en,creado_por,origen)
            VALUES (?,'ERP3-TEST','2026-01-01','2026-12-31','abierto','2026-01-01',?,'test')''',(self.community,self.uid))
        self.exercise=self.conn.execute('SELECT last_insert_rowid()').fetchone()[0]
        self.service=ReceivablesService(self.db)
        self.n=0

    def tearDown(self):
        for t,count in self.before.items():self.assertEqual(self.conn.execute('SELECT count(*) FROM '+t).fetchone()[0],count)
        self.assertEqual(self.conn.execute('PRAGMA integrity_check').fetchone()[0],'ok')
        self.assertEqual(self.conn.execute('PRAGMA foreign_key_check').fetchall(),[])
        self.conn.close()

    def command(self,name,payload,version=None,key=None,session=None,evidence=None):
        self.n+=1
        value={'command':'erp3.'+name,'id_comunidad':self.community,'payload':payload,
            'idempotency_key':key or 'test-'+str(self.n),'expected_version':version,'reason':'Verificacion sintetica','origin':'test','evidence':evidence}
        return execute_command(self.db,session or self.session,value)

    def receipt(self,amount=10000,number='TEST-1'):
        return self.conn.execute('''INSERT INTO erp_recibos
            (id_comunidad,id_propiedad,id_ejercicio,number,concept_key,description,period_key,period_from,period_until,
             source_type,source_key,obligation_key,amount_cents,currency,issued_on,due_on,snapshot_json,snapshot_hash,registered_at,actor_id)
             VALUES (?,?,?,?,'test','Cuota sintetica','P01','2026-01-01','2026-01-31','plan',?,?,?,'EUR',
             '2026-01-01','2026-01-10','{}','test','2026-01-01T00:00:00.000000Z',?)''',
             (self.community,self.property,self.exercise,number,number,number,amount,self.uid)).lastrowid

    def collection(self,amount=10000,key='BANK-1'):
        return self.command('collection.record',{'amount_cents':str(amount),'currency':'EUR','effective_on':'2026-01-15',
            'method':'transferencia','external_source':'synthetic','external_key':key})['entity']['id']

    def allocate(self,cid,rid,amount):
        proposal=self.command('allocation.preview',{'collection_id':cid,'effective_on':'2026-01-15',
            'allocations':[{'receipt_id':rid,'amount_cents':str(amount)}]})['entity']
        return self.command('allocation.confirm',{'proposal_id':proposal['id']},proposal['version'])

    def test_migration_reentrant_restore(self):
        checks=list(self.conn.execute('SELECT version,checksum FROM erp_schema_migrations'))
        apply_all(self.conn)
        self.assertEqual([tuple(r) for r in checks],[tuple(r) for r in self.conn.execute('SELECT version,checksum FROM erp_schema_migrations')])
        restored=WORK/'restored.db';backup(self.db,restored)
        with closing(sqlite3.connect(restored)) as conn:
            self.assertEqual(conn.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(conn.execute('PRAGMA foreign_key_check').fetchall(),[])

    def test_exact_validation(self):
        self.assertEqual(cents('100'),100)
        for bad in (1.2,True,'1.00','1e3',None,9000000000000001):
            with self.assertRaises(ContractError):cents(bad)
        with self.assertRaises(ContractError):day('20260101')
        with self.assertRaises(ContractError):known_time('2026-01-01T00:00:00')

    def test_paid_credit_frees_funds_atomically(self):
        rid=self.receipt();cid=self.collection();self.allocate(cid,rid,10000)
        aid=self.conn.execute('SELECT id FROM erp_imputaciones WHERE receipt_id=?',(rid,)).fetchone()[0]
        with self.assertRaises(ConflictError):
            self.command('credit.preview',{'receipt_id':rid,'effective_on':'2026-01-16','amount_cents':'2000'})
        p=self.command('credit.preview',{'receipt_id':rid,'effective_on':'2026-01-16','amount_cents':'2000',
            'release_allocations':[{'allocation_id':aid,'amount_cents':'2000'}]})['entity']
        self.command('credit.confirm',{'proposal_id':p['id']},1)
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['pending_cents'],'0')
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['paid_cents'],'8000')
        self.assertEqual(collection_balance(self.conn,self.community,cid)['available_cents'],'2000')
        self.assertEqual(self.conn.execute('SELECT amount_cents FROM erp_recibos WHERE id=?',(rid,)).fetchone()[0],10000)

    def test_desimputation_without_return_and_replay(self):
        rid=self.receipt();cid=self.collection();self.allocate(cid,rid,10000)
        aid=self.conn.execute('SELECT id FROM erp_imputaciones WHERE receipt_id=?',(rid,)).fetchone()[0]
        p=self.command('allocation.reverse.preview',{'effective_on':'2026-01-17','reversals':[{'allocation_id':aid,'amount_cents':'3000'}]})['entity']
        self.command('allocation.reverse.confirm',{'proposal_id':p['id']},1,key='reverse-confirm')
        replay=self.command('allocation.reverse.confirm',{'proposal_id':p['id']},1,key='reverse-confirm')
        self.assertTrue(replay['idempotent_replay'])
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['pending_cents'],'3000')
        self.assertEqual(collection_balance(self.conn,self.community,cid)['available_cents'],'3000')
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_devoluciones').fetchone()[0],0)

    def test_return_fee_policies_separate_charge(self):
        rid=self.receipt();cid=self.collection()
        owner=self.conn.execute('SELECT id_propietario,nombre FROM cf_propietarios WHERE id_comunidad=? LIMIT 1',(self.community,)).fetchone()
        self.conn.execute("INSERT INTO erp_recibo_sujetos (id_comunidad,receipt_id,role,owner_id,snapshot_json) VALUES (?,?,'obligated',?,?)",
            (self.community,rid,owner[0],json.dumps({'type':'owner','id':owner[0],'name':owner[1]})))
        self.conn.execute('''INSERT INTO erp_config_recibo_versiones
            (id_comunidad,id_propiedad,version,efectiva_desde,registrada_en,registrada_por,estado,destinatario_propietario_id,pagador_propietario_id,medio_previsto,origen)
            VALUES (?,?,1000,'2026-01-01','2026-01-01',?,'confirmada',?,?,'transferencia','test')''',(self.community,self.property,self.uid,owner[0],owner[0]))
        self.allocate(cid,rid,10000)
        aid=self.conn.execute('SELECT id FROM erp_imputaciones WHERE receipt_id=?',(rid,)).fetchone()[0]
        p=self.command('return.preview',{'collection_id':cid,'effective_on':'2026-01-17','free_cents':'0',
            'reversals':[{'allocation_id':aid,'amount_cents':'10000'}],'external_key':'RETURN-COST'})['entity']
        self.command('return.confirm',{'proposal_id':p['id']},1)
        did=self.conn.execute('SELECT id FROM erp_devoluciones').fetchone()[0]
        for version,mode,expected in [(0,'none',0),(1,'actual',500),(2,'fixed',700)]:
            self.command('policy.save',{'effective_from':'2026-01-17','return_fee_mode':mode,'fixed_cents':'700' if mode=='fixed' else '0'},version)
            p=self.command('return.fee.preview',{'return_id':did,'receipt_id':rid,'effective_on':'2026-01-18',
                'cost_cents':'500','cost_reference':'COST-'+mode,'exercise_id':self.exercise})['entity']
            self.assertEqual(p['preview']['amount_cents'],str(expected))
            result=self.command('return.fee.confirm',{'proposal_id':p['id']},1,evidence={'type':'external_reference','id':'synthetic:cost'})['entity']
            if expected:self.assertEqual(receipt_balance(self.conn,self.community,result['receipt_id'])['pending_cents'],str(expected))
            else:self.assertIsNone(result['receipt_id'])
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['original_cents'],'10000')
        with self.assertRaises(ConflictError):
            self.command('return.fee.preview',{'return_id':did,'receipt_id':rid,'effective_on':'2026-01-18','cost_cents':'500','cost_reference':'COST-fixed'})

    def test_refund_excess_does_not_reopen_receipt(self):
        rid=self.receipt();owner=self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? LIMIT 1',(self.community,)).fetchone()[0]
        cid=self.command('collection.record',{'amount_cents':'12000','currency':'EUR','effective_on':'2026-01-15',
            'method':'transferencia','external_source':'test','external_key':'REFUND','payer':{'type':'owner','id':owner}})['entity']['id']
        self.allocate(cid,rid,10000)
        p=self.command('refund.preview',{'collection_id':cid,'amount_cents':'2000','effective_on':'2026-01-20',
            'beneficiary':{'type':'owner','id':owner}})['entity']
        self.command('refund.confirm',{'proposal_id':p['id']},1,evidence={'type':'external_reference','id':'synthetic:refund'})
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['pending_cents'],'0')
        self.assertEqual(collection_balance(self.conn,self.community,cid)['available_cents'],'0')
        self.assertEqual(collection_balance(self.conn,self.community,cid)['refunded_cents'],'2000')

    def test_exceptional_transfer_and_explicit_later_payment(self):
        rid=self.receipt();owners=[r[0] for r in self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? LIMIT 2',(self.community,))]
        a=[{'type':'owner','id':owners[0]}];b=[{'type':'owner','id':owners[1]}]
        self.conn.execute("INSERT INTO erp_recibo_sujetos (id_comunidad,receipt_id,role,owner_id,snapshot_json) VALUES (?,?,'obligated',?,?)",
            (self.community,rid,owners[0],json.dumps(a[0])))
        original=self.conn.execute('SELECT snapshot_hash FROM erp_recibos WHERE id=?',(rid,)).fetchone()[0]
        p=self.command('responsibility.transfer.preview',{'effective_on':'2026-01-10','authorization_reference':'Acuerdo sintetico',
            'lines':[{'receipt_id':rid,'amount_cents':'4000','source_subjects':a,'target_subjects':b}]})['entity']
        self.command('responsibility.transfer.confirm',{'proposal_id':p['id']},1,key='transfer',evidence={'type':'external_reference','id':'synthetic:transfer'})
        self.assertEqual(sorted(int(x['pending_cents']) for x in responsibility_balance(self.conn,self.community,rid)),[4000,6000])
        self.assertEqual(responsibility_balance(self.conn,self.community,rid,'2026-01-09')[0]['pending_cents'],'10000')
        self.assertEqual(responsibility_balance(self.conn,self.community,rid,'2026-01-20','2026-02-01T00:00:00Z')[0]['pending_cents'],'10000')
        cid=self.collection(3000)
        with self.assertRaises(ConflictError):self.allocate(cid,rid,3000)
        p=self.command('allocation.preview',{'collection_id':cid,'effective_on':'2026-01-15','allocations':[
            {'receipt_id':rid,'amount_cents':'3000','responsibility_subjects':b}]})['entity']
        self.command('allocation.confirm',{'proposal_id':p['id']},1)
        balances=responsibility_balance(self.conn,self.community,rid)
        self.assertEqual(next(x['pending_cents'] for x in balances if x['subjects']==a),'6000')
        self.assertEqual(next(x['pending_cents'] for x in balances if x['subjects']==b),'1000')
        aid=self.conn.execute('SELECT id FROM erp_imputaciones WHERE receipt_id=?',(rid,)).fetchone()[0]
        p=self.command('return.preview',{'collection_id':cid,'effective_on':'2026-01-18','free_cents':'0','external_key':'TRANSFER-RETURN',
            'reversals':[{'allocation_id':aid,'amount_cents':'3000'}]})['entity']
        self.command('return.confirm',{'proposal_id':p['id']},1)
        self.assertEqual(sorted(int(x['pending_cents']) for x in responsibility_balance(self.conn,self.community,rid)),[4000,6000])
        self.assertEqual(self.conn.execute('SELECT snapshot_hash FROM erp_recibos WHERE id=?',(rid,)).fetchone()[0],original)

    def test_history_staging_cutoff_identity_and_rollback(self):
        row={'reference':'OPENING-2024','amount_cents':'530000','cutoff_date':'2024-12-31','coverage_from':'2024-01-01',
             'coverage_until':'2024-12-31','scope':'receipt','property_id':self.property,'limitations':'Saldo observado; cobros no reconstruibles.'}
        payload={'source':'synthetic-history','file_hash':'a'*64,'file_name':'historico.xlsx','rows':[row]}
        p=self.command('history.import.preview',payload)['entity']
        self.assertEqual(p['blocking_issues'],0)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_saldos_apertura').fetchone()[0],0)
        self.command('history.import.confirm',{'import_id':p['id']},1,evidence={'type':'external_reference','id':'synthetic:history'})
        self.assertEqual(self.conn.execute('SELECT amount_cents,effective_on,quality FROM erp_saldos_apertura').fetchone()[:],(530000,'2024-12-31','observada'))
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_cobros').fetchone()[0],0)
        replay=self.command('history.import.preview',payload)['entity'];self.assertTrue(replay['duplicate'])
        other=self.command('history.import.preview',{**payload,'file_hash':'b'*64})['entity']
        self.assertEqual(other['rows'][0]['decision'],'skip')
        self.command('history.import.confirm',{'import_id':other['id']},1,evidence={'type':'external_reference','id':'synthetic:history'})
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_saldos_apertura').fetchone()[0],1)
        conflict=self.command('history.import.preview',{**payload,'file_hash':'c'*64,'rows':[{**row,'amount_cents':'1'}]})['entity']
        self.assertEqual(conflict['blocking_issues'],1)
        with self.assertRaises(ConflictError):self.command('history.import.confirm',{'import_id':conflict['id']},1,evidence={'type':'external_reference','id':'synthetic:history'})
        with self.assertRaises(sqlite3.IntegrityError):self.conn.execute("UPDATE erp_saldos_apertura SET amount_cents=1")

    def test_pagination_exact_totals_and_personal_attribution(self):
        owners=[r[0] for r in self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? LIMIT 2',(self.community,))]
        for number,owner in [('DEBT-A',owners[0]),('DEBT-B',owners[1])]:
            rid=self.receipt(10000,number)
            self.conn.execute("INSERT INTO erp_recibo_sujetos (id_comunidad,receipt_id,role,owner_id,snapshot_json) VALUES (?,?,'obligated',?,?)",
                (self.community,rid,owner,json.dumps({'type':'owner','id':owner})))
        result=execute_query(self.db,self.session,{'query':'erp3.receipt.list','id_comunidad':self.community,
            'filters':{'property_id':self.property,'limit':1}})['entity']
        self.assertEqual(len(result['items']),1);self.assertEqual(result['total_count'],2)
        self.assertEqual(result['pending_cents'],'20000')
        summary=execute_query(self.db,self.session,{'query':'erp3.debt.summary','id_comunidad':self.community,
            'filters':{'owner_id':owners[0]}})['entity']
        self.assertEqual(summary['personal_pending_cents'],'10000')
        self.assertEqual(summary['shared_obligations_cents'],'0')
        self.assertIsNone(summary['total_pending_cents'])
        self.assertEqual(summary['observed_legacy_debt_cents'],'0')

    def test_evidence_scope_and_missing_document(self):
        with self.assertRaises(NotFoundError):
            self.command('policy.save',{'effective_from':'2026-01-01','return_fee_mode':'none'},0,
                evidence={'type':'attachment','id':'999999999'})
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_recibo_politicas').fetchone()[0],0)

    def test_concurrent_confirmation_cannot_spend_twice(self):
        a=self.receipt();b=self.receipt(10000,'CONCURRENT');cid=self.collection()
        proposals=[self.command('allocation.preview',{'collection_id':cid,'effective_on':'2026-01-15',
            'allocations':[{'receipt_id':rid,'amount_cents':'10000'}]})['entity'] for rid in (a,b)]
        barrier=Barrier(2)
        def confirm(i):
            barrier.wait()
            try:
                execute_command(self.db,self.session,{'command':'erp3.allocation.confirm','id_comunidad':self.community,
                    'payload':{'proposal_id':proposals[i]['id']},'expected_version':1,'idempotency_key':'parallel-'+str(i),
                    'origin':'test','reason':'Confirmacion humana sintetica concurrente'})
                return 'confirmed'
            except ConflictError:return 'conflict'
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(confirm,(0,1)))
        self.assertEqual(sorted(results),['confirmed','conflict'])
        self.assertEqual(collection_balance(self.conn,self.community,cid)['available_cents'],'0')
        self.assertEqual(sum(int(receipt_balance(self.conn,self.community,r)['pending_cents']) for r in (a,b)),10000)

    def test_transfer_lot_failure_rolls_back_all_lines(self):
        owners=[r[0] for r in self.conn.execute('SELECT id_propietario FROM cf_propietarios WHERE id_comunidad=? LIMIT 2',(self.community,))]
        a=[{'type':'owner','id':owners[0]}];b=[{'type':'owner','id':owners[1]}]
        receipts=[self.receipt(10000,'TRANSFER-'+str(i)) for i in range(2)]
        for rid in receipts:self.conn.execute("INSERT INTO erp_recibo_sujetos (id_comunidad,receipt_id,role,owner_id,snapshot_json) VALUES (?,?,'obligated',?,?)",(self.community,rid,owners[0],json.dumps(a[0])))
        proposal=self.command('responsibility.transfer.preview',{'effective_on':'2026-01-10','authorization_reference':'Acuerdo sintetico',
            'lines':[{'receipt_id':r,'amount_cents':'4000','source_subjects':a,'target_subjects':b} for r in receipts]})['entity']
        self.conn.execute(f"CREATE TRIGGER fail_transfer BEFORE INSERT ON erp_reasignaciones_obligacion WHEN NEW.receipt_id={receipts[1]} BEGIN SELECT RAISE(ABORT,'synthetic fault'); END")
        events=self.conn.execute('SELECT count(*) FROM erp_hechos_economicos').fetchone()[0]
        with self.assertRaises(sqlite3.IntegrityError):self.command('responsibility.transfer.confirm',{'proposal_id':proposal['id']},1,
            evidence={'type':'external_reference','id':'synthetic:transfer'})
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_reasignaciones_obligacion').fetchone()[0],0)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_hechos_economicos').fetchone()[0],events)
        for rid in receipts:self.assertEqual(responsibility_balance(self.conn,self.community,rid)[0]['pending_cents'],'10000')

    def test_partial_many_collections_and_overpayment(self):
        rid=self.receipt();c1=self.collection(3000);self.allocate(c1,rid,3000)
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['pending_cents'],'7000')
        c2=self.collection(9000,'BANK-2');self.allocate(c2,rid,7000)
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['pending_cents'],'0')
        self.assertEqual(collection_balance(self.conn,self.community,c2)['available_cents'],'2000')
        self.assertEqual(receipt_balance(self.conn,self.community,rid,'2026-01-14')['pending_cents'],'10000')
        self.assertEqual(receipt_balance(self.conn,self.community,rid,'2026-01-20','2026-02-01T00:00:00Z')['pending_cents'],'10000')

    def test_multiple_receipts_and_stale_preview(self):
        a=self.receipt();b=self.receipt(15000,'TEST-2');cid=self.collection(20000)
        p=self.command('allocation.preview',{'collection_id':cid,'effective_on':'2026-01-15','allocations':[
            {'receipt_id':a,'amount_cents':'10000'},{'receipt_id':b,'amount_cents':'10000'}]})['entity']
        self.allocate(cid,a,1000)
        with self.assertRaises(ConflictError):self.command('allocation.confirm',{'proposal_id':p['id']},1)
        self.assertEqual(collection_balance(self.conn,self.community,cid)['available_cents'],'19000')
        self.assertEqual(receipt_balance(self.conn,self.community,b)['pending_cents'],'15000')

    def test_immutable_and_cross_community_fk(self):
        rid=self.receipt()
        with self.assertRaises(sqlite3.IntegrityError):self.conn.execute('UPDATE erp_recibos SET amount_cents=1 WHERE id=?',(rid,))
        with self.assertRaises(sqlite3.IntegrityError):self.conn.execute('DELETE FROM erp_recibos WHERE id=?',(rid,))
        cid=self.collection()
        with self.assertRaises(sqlite3.IntegrityError):self.conn.execute('DELETE FROM erp_cobros WHERE id=?',(cid,))
        other=self.conn.execute('SELECT id_comunidad FROM comunidades WHERE id_comunidad<>? LIMIT 1',(self.community,)).fetchone()[0]
        event=self.conn.execute('SELECT id FROM erp_hechos_economicos WHERE id_comunidad=? LIMIT 1',(self.community,)).fetchone()[0]
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute('''INSERT INTO erp_imputaciones (id_comunidad,collection_id,receipt_id,event_id,amount_cents,effective_on,registered_at)
                VALUES (?,?,?,?,100,'2026-01-15','2026-01-15T00:00:00.000000Z')''',(other,cid,rid,event))
        with self.assertRaises(sqlite3.IntegrityError):self.conn.execute('UPDATE erp_recibos SET id=id+1000000 WHERE id=?',(rid,))

    def test_read_only_user_and_no_implicit_economic_grants(self):
        row=self.conn.execute("SELECT id_usuario FROM usuarios WHERE activo=1 AND rol<>'Superusuario' LIMIT 1").fetchone()
        self.assertIsNotNone(row)
        user=profile(self.conn,row[0])
        p={'amount_cents':'100','currency':'EUR','effective_on':'2026-01-15','method':'efectivo','external_source':'test','external_key':'denied'}
        with self.assertRaises(PermissionError):self.command('collection.record',p,session=user)
        self.assertEqual(self.conn.execute('SELECT COUNT(*) FROM erp_cobros').fetchone()[0],0)

    def test_idempotency_and_permissions(self):
        p={'amount_cents':'10000','currency':'EUR','effective_on':'2026-01-15','method':'efectivo','external_source':'test','external_key':'one'}
        a=self.command('collection.record',p,key='same');b=self.command('collection.record',p,key='same')
        self.assertEqual(a['entity']['id'],b['entity']['id'])
        self.assertTrue(b['idempotent_replay'])
        with self.assertRaises(ConflictError):self.command('collection.record',{**p,'amount_cents':'20000'},key='same')
        stale={**self.session,'auth_version':-1}
        with self.assertRaises(PermissionError):self.command('collection.record',{**p,'external_key':'other'},session=stale)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_cobros').fetchone()[0],1)

    def test_partial_return_keeps_original(self):
        rid=self.receipt();cid=self.collection();self.allocate(cid,rid,10000)
        aid=self.conn.execute('SELECT id FROM erp_imputaciones WHERE receipt_id=?',(rid,)).fetchone()[0]
        p=self.command('return.preview',{'collection_id':cid,'effective_on':'2026-01-20','free_cents':'0',
            'reversals':[{'allocation_id':aid,'amount_cents':'4000'}],'external_key':'RETURN-1'})['entity']
        self.command('return.confirm',{'proposal_id':p['id']},1)
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['pending_cents'],'4000')
        self.assertEqual(collection_balance(self.conn,self.community,cid)['returned_cents'],'4000')
        self.assertEqual(self.conn.execute('SELECT amount_cents FROM erp_cobros WHERE id=?',(cid,)).fetchone()[0],10000)
        with self.assertRaises(ConflictError):self.command('void.preview',{'receipt_id':rid,'effective_on':'2026-01-21'})

    def test_credit_void_and_atomic_failure(self):
        rid=self.receipt()
        p=self.command('credit.preview',{'receipt_id':rid,'effective_on':'2026-01-10','amount_cents':'2000'})['entity']
        self.command('credit.confirm',{'proposal_id':p['id']},1)
        self.assertEqual(receipt_balance(self.conn,self.community,rid)['pending_cents'],'8000')
        second=self.receipt(10000,'VOID')
        p=self.command('void.preview',{'receipt_id':second,'effective_on':'2026-01-10'})['entity']
        self.command('void.confirm',{'proposal_id':p['id']},1)
        self.assertEqual(receipt_balance(self.conn,self.community,second)['state'],'anulado')
        third=self.receipt(10000,'ROLLBACK');cid=self.collection()
        p=self.command('allocation.preview',{'collection_id':cid,'effective_on':'2026-01-15','allocations':[{'receipt_id':third,'amount_cents':'1000'}]})['entity']
        before=self.conn.execute('SELECT count(*) FROM erp_hechos_economicos').fetchone()[0]
        self.conn.execute("CREATE TRIGGER injected_failure BEFORE INSERT ON erp_imputaciones BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):self.command('allocation.confirm',{'proposal_id':p['id']},1)
        self.assertEqual(self.conn.execute('SELECT count(*) FROM erp_hechos_economicos').fetchone()[0],before)
        self.assertEqual(receipt_balance(self.conn,self.community,third)['pending_cents'],'10000')


if __name__=='__main__':
    print('Isolated workspace:',WORK,flush=True)
    unittest.main(verbosity=2)
