"""Masked operational views; raw bank evidence never uses a generic query."""

from datetime import date

from .errors import ContractError, NotFoundError
from .receivables_contracts import identity, require_fields
from .receivables_projection import receipt_balance
from .receivables_service import ReceivablesService


class BankingQueries:
    @staticmethod
    def _page(filters):
        offset, limit = filters.get('offset', 0), filters.get('limit', 100)
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise ContractError('Paginacion no valida.')
        return offset, limit

    def workspace_get(self, session, query):
        def op(conn, q):
            require_fields(q.filters, ())
            from .contracts import Actor
            grants = {r['capability']: bool(r['allowed']) for r in conn.execute(
                'SELECT capability,allowed FROM erp_banca_permisos WHERE id_comunidad=? AND id_usuario=?',
                (q.community_id, Actor.from_session(session).user_id))}
            counts = {}
            for name, table in (('accounts','erp_cuentas_pagador'),('mandates','erp_mandatos'),('remittances','erp_remesas')):
                counts[name] = [dict(r) for r in conn.execute(
                    f'SELECT state,COUNT(*) AS count FROM {table} WHERE id_comunidad=? GROUP BY state', (q.community_id,))]
            counts['pending_results'] = conn.execute("SELECT COUNT(*) FROM erp_resultados_bancarios WHERE id_comunidad=? AND state!='confirmado'", (q.community_id,)).fetchone()[0]
            counts['needs_review'] = conn.execute('SELECT COUNT(*) FROM erp_remesas WHERE id_comunidad=? AND needs_review=1', (q.community_id,)).fetchone()[0]
            return {'permissions':grants,'counts':counts}
        return self._read(session, query, 'read_masked', op)

    def creditor_list(self, session, query):
        def op(conn, q):
            require_fields(q.filters, ())
            rows=[]
            for row in conn.execute('SELECT * FROM erp_acreedor_versiones WHERE id_comunidad=? ORDER BY id DESC', (q.community_id,)):
                details=self.vault.get(conn,q.community_id,row['secret_id'],'creditor')
                treasury=self._entity(conn,'erp_cuentas_tesoreria',q.community_id,row['treasury_id'])
                iban=self.vault.get(conn,q.community_id,treasury['secret_id'],'treasury-account')['iban']
                profile=conn.execute('SELECT id,version FROM erp_banca_configuraciones WHERE id_comunidad=? AND creditor_id=? ORDER BY version DESC LIMIT 1', (q.community_id,row['id'])).fetchone()
                rows.append({'id':row['id'],'name':details['name'],'creditor_identifier':details['creditor_identifier'],
                    'masked':iban[:2]+'** **** ... '+iban[-4:],'version':row['version'],
                    'effective_from':row['effective_from'],'effective_until':row['effective_until'],
                    'profile':dict(profile) if profile else None})
            return {'items':rows}
        return self._read(session, query, 'read_masked', op)

    def mandate_list(self, session, query):
        def op(conn, q):
            require_fields(q.filters, (), ('offset','limit','state','property_id','owner_id'))
            offset,limit=self._page(q.filters)
            where=['m.id_comunidad=?'];args=[q.community_id]
            if q.filters.get('state'):
                where.append('m.state=?');args.append(q.filters['state'])
            for key,clause in (
                ('property_id','EXISTS (SELECT 1 FROM erp_mandato_propiedades p WHERE p.id_comunidad=m.id_comunidad AND p.mandate_version_id=v.id AND p.property_id=?)'),
                ('owner_id','(v.debtor_owner_id=? OR EXISTS (SELECT 1 FROM erp_mandato_firmantes f WHERE f.id_comunidad=m.id_comunidad AND f.mandate_version_id=v.id AND f.owner_id=?))')):
                if q.filters.get(key):
                    value=identity(q.filters[key]);where.append(clause);args.extend([value]*(2 if key=='owner_id' else 1))
            sql='''FROM erp_mandatos m JOIN erp_mandato_versiones v ON v.id_comunidad=m.id_comunidad AND v.mandate_id=m.id
                AND v.version=(SELECT MAX(v2.version) FROM erp_mandato_versiones v2 WHERE v2.id_comunidad=m.id_comunidad AND v2.mandate_id=m.id)
                WHERE '''+' AND '.join(where)
            count=conn.execute('SELECT COUNT(*) '+sql,args).fetchone()[0]
            rows=[]
            for row in conn.execute('SELECT m.*,v.account_id,v.secret_id,v.signed_on,v.effective_from,v.effective_until '+sql+' ORDER BY m.id DESC LIMIT ? OFFSET ?',args+[limit,offset]):
                details=self.vault.get(conn,q.community_id,row['secret_id'],'mandate-version')
                rows.append({**self._mandate_public(row),'debtor_name':details['debtor_name'],
                    'signed_on':row['signed_on'],'effective_from':row['effective_from'],'effective_until':row['effective_until'],
                    'property_ids':details['property_ids'],
                    'account':self._account_public(self._entity(conn,'erp_cuentas_pagador',q.community_id,row['account_id']))})
            return {'items':rows,'total':count}
        return self._read(session,query,'read_masked',op)

    def direct_debit_list(self,session,query):
        def op(conn,q):
            require_fields(q.filters,('property_id',),('on',))
            prop=identity(q.filters['property_id'])
            from .receivables_contracts import day
            on=day(q.filters.get('on') or date.today().isoformat())
            if not conn.execute('SELECT 1 FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?',(q.community_id,prop)).fetchone():
                raise NotFoundError('Propiedad no disponible.')
            rows=[]
            for row in conn.execute('''SELECT d.id AS direct_debit_id,d.version AS current_version,d.scope,d.concept_key,v.*
                FROM erp_domiciliaciones d JOIN erp_domiciliacion_versiones v ON v.id_comunidad=d.id_comunidad AND v.direct_debit_id=d.id
                WHERE d.id_comunidad=? AND d.property_id=? ORDER BY d.id,v.version DESC''',(q.community_id,prop)):
                successor=conn.execute('''SELECT MIN(effective_from) FROM erp_domiciliacion_versiones
                    WHERE id_comunidad=? AND direct_debit_id=? AND version>?''',(q.community_id,row['direct_debit_id'],row['version'])).fetchone()[0]
                end=min(x for x in (row['effective_until'],successor) if x) if row['effective_until'] or successor else None
                mandate=self._entity(conn,'erp_mandatos',q.community_id,row['mandate_id'])
                rows.append({'id':row['direct_debit_id'],'version':row['current_version'],'revision':row['version'],
                    'scope':row['scope'],'concept_key':row['concept_key'],'billing_config_id':row['billing_config_id'],
                    'mandate':self._mandate_public(mandate),'state':row['state'],'effective_from':row['effective_from'],
                    'effective_until':end,'current':row['effective_from']<=on and (not end or end>on)})
            return {'property_id':prop,'on':on,'items':rows}
        return self._read(session,query,'read_masked',op)

    def remittance_list(self,session,query):
        def op(conn,q):
            require_fields(q.filters,(),('offset','limit','state','property_id'))
            offset,limit=self._page(q.filters)
            where=['r.id_comunidad=?'];args=[q.community_id]
            if q.filters.get('state'):
                where.append('r.state=?');args.append(q.filters['state'])
            if q.filters.get('property_id'):
                where.append('''EXISTS (SELECT 1 FROM erp_remesa_revisiones v JOIN erp_remesa_lineas l ON l.revision_id=v.id
                    JOIN erp_recibos rec ON rec.id=l.receipt_id WHERE v.id_comunidad=r.id_comunidad AND v.remittance_id=r.id AND rec.id_propiedad=?)''')
                args.append(identity(q.filters['property_id']))
            sql=' FROM erp_remesas r WHERE '+' AND '.join(where)
            total=conn.execute('SELECT COUNT(*)'+sql,args).fetchone()[0]
            items=[]
            for row in conn.execute('SELECT r.*'+sql+' ORDER BY r.id DESC LIMIT ? OFFSET ?',args+[limit,offset]):
                values=conn.execute('''SELECT COUNT(*),COALESCE(SUM(l.amount_cents),0) FROM erp_remesa_lineas l
                    JOIN erp_remesa_revisiones v ON v.id=l.revision_id AND v.id_comunidad=l.id_comunidad
                    WHERE v.id_comunidad=? AND v.remittance_id=?''',(q.community_id,row['id'])).fetchone()
                items.append({'id':row['id'],'creditor_id':row['creditor_id'],'requested_on':row['requested_on'],
                    'state':row['state'],'version':row['version'],'needs_review':bool(row['needs_review']),
                    'line_count':values[0],'amount_cents':str(values[1]),'currency':row['currency'],'registered_at':row['registered_at']})
            return {'items':items,'total':total}
        return self._read(session,query,'read_masked',op)

    def remittance_get(self,session,query):
        def op(conn,q):
            require_fields(q.filters,('id',))
            ReceivablesService._session(conn,session,q.community_id,'read')
            rem=self._entity(conn,'erp_remesas',q.community_id,q.filters['id'])
            revision=self._revision(conn,q.community_id,rem['id'])
            lines=[]
            for line in conn.execute('SELECT * FROM erp_remesa_lineas WHERE id_comunidad=? AND revision_id=? ORDER BY id',(q.community_id,revision['id'])):
                frozen=self.vault.get(conn,q.community_id,line['secret_id'],'remittance-line')
                iban=frozen['payer_account']['iban']
                events=[dict(r) for r in conn.execute('''SELECT e.id,e.kind,e.effective_on,o.collection_id,o.return_id
                    FROM erp_banca_linea_eventos e LEFT JOIN erp_banco_operaciones o ON o.id=e.operation_id AND o.id_comunidad=e.id_comunidad
                    WHERE e.id_comunidad=? AND e.line_id=? ORDER BY e.id''',(q.community_id,line['id']))]
                lines.append({'id':line['id'],'receipt_id':line['receipt_id'],'attempt_key':line['attempt_key'],
                    'retry_of_id':line['retry_of_id'],'amount_cents':str(line['amount_cents']),
                    'concept':frozen['concept'],'debtor_name':frozen['mandate_details']['debtor_name'],
                    'masked':iban[:2]+'** **** ... '+iban[-4:], 'state':self._line_status(conn,q.community_id,line['id']),
                    'receipt_balance':receipt_balance(conn,q.community_id,line['receipt_id']), 'events':events})
            files=[dict(r) for r in conn.execute('''SELECT id,message_id,content_hash,profile_id,registered_at
                FROM erp_remesa_ficheros WHERE id_comunidad=? AND revision_id=? ORDER BY id''',(q.community_id,revision['id']))]
            return {'id':rem['id'],'state':rem['state'],'version':rem['version'],'requested_on':rem['requested_on'],
                'needs_review':bool(rem['needs_review']),'lines':lines,'files':files}
        return self._read(session,query,'read_masked',op)

    def results_list(self,session,query):
        def op(conn,q):
            require_fields(q.filters,(),('offset','limit'))
            offset,limit=self._page(q.filters)
            rows=[dict(r) for r in conn.execute('''SELECT id,profile_id,state,version,registered_at FROM erp_resultados_bancarios
                WHERE id_comunidad=? ORDER BY id DESC LIMIT ? OFFSET ?''',(q.community_id,limit,offset))]
            return {'items':rows,'total':conn.execute('SELECT COUNT(*) FROM erp_resultados_bancarios WHERE id_comunidad=?',(q.community_id,)).fetchone()[0]}
        return self._read(session,query,'results',op)

    def results_get(self,session,query):
        def op(conn,q):
            require_fields(q.filters,('id',))
            result=self._entity(conn,'erp_resultados_bancarios',q.community_id,q.filters['id'])
            lines=[]
            for row in conn.execute('SELECT * FROM erp_resultado_lineas WHERE id_comunidad=? AND result_id=? ORDER BY id',(q.community_id,result['id'])):
                evidence=self.vault.get(conn,q.community_id,row['secret_id'],'bank-result-line')
                line=self._entity(conn,'erp_remesa_lineas',q.community_id,row['line_id']) if row['line_id'] else None
                # User-supplied bank references and notes can contain IBANs. Keep them encrypted.
                lines.append({'id':row['id'],'line_id':row['line_id'],'version':row['version'],'state':row['state'],
                    'kind':evidence['kind'],'effective_on':evidence['effective_on'],
                    'matched':line is not None,'receipt_id':line['receipt_id'] if line else None,
                    'amount_cents':evidence.get('amount_cents'),'contradictory':bool(evidence.get('contradictory'))})
            return {'id':result['id'],'version':result['version'],'state':result['state'],'lines':lines}
        return self._read(session,query,'results',op)
