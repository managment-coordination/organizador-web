"""ERP 3 migration/transaction tests on an isolated SQLite backup, never production."""

import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))

from access_control import profile
from erp_core.contracts import CommandEnvelope, QueryEnvelope
from erp_core.database import connect
from erp_core.errors import ConflictError, ContractError
from erp_core.migrations import apply_all
from erp_core.receivables_contracts import cents, day, known_time
from erp_core.receivables_projection import receipt_balance, collection_balance
from erp_core.receivables_service import ReceivablesService


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

    def command(self,name,payload,version=None,key=None,session=None):
        self.n+=1
        env=CommandEnvelope.from_value({'command':'erp3.'+name,'id_comunidad':self.community,'payload':payload,
            'idempotency_key':key or 'test-'+str(self.n),'expected_version':version,'reason':'Verificacion sintetica','origin':'test'})
        return getattr(self.service,name.replace('.','_'))(session or self.session,env)

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
