"""Historical activation never invents a payment, recipient or economic period."""

import json
from .contracts import canonical_json
from .errors import ContractError,ConflictError
from .receivables_contracts import require_fields,day,identity,fingerprint,text
from .receivables_queries import legacy_cents


class ActivationOperations:
    def _activation_candidates(self,conn,community,coverage):
        rows=[];by_receipt={}
        for o in conn.execute('SELECT * FROM erp_saldos_apertura WHERE id_comunidad=?',(community,)):
            n=json.loads(o['source_json']).get('normalized',{})
            for rid in n.get('legacy_receipt_ids',[]):
                by_receipt.setdefault(rid,[]).append({'id':o['id'],'reference':n.get('reference')})
        for r in conn.execute('SELECT * FROM cf_recibos WHERE id_comunidad=? ORDER BY id_recibo',(community,)):
            try:issued=day(str(r['fecha_emision'] or '')[:10])
            except ContractError:
                raise ConflictError('Hay recibos historicos sin fecha de emision acreditada. Revisa la cobertura antes de activarla.') from None
            if not coverage['effective_from']<=issued<=coverage['effective_until']:continue
            openings=by_receipt.get(r['id_recibo'],[])
            rows.append({'legacy_receipt_id':r['id_recibo'],'property_id':r['id_propiedad'],'reference':r['referencia'],
                         'issued_on':issued,'original_cents':str(legacy_cents(r['importe'])),
                         'observed_collected_cents':str(legacy_cents(r['cobrado'])),'observed_pending_cents':str(legacy_cents(r['deuda'])),
                         'openings':openings,'source_hash':fingerprint(dict(r))})
        return rows

    def coverage_candidates(self,session,query):
        def op(conn,q):
            require_fields(q.filters,('coverage_id',))
            coverage=self._entity(conn,'erp_recibos_coberturas',q.community_id,q.filters['coverage_id'])
            return {'coverage':coverage,'items':self._activation_candidates(conn,q.community_id,coverage)}
        return self._read(session,query,op,'configure')

    def _activation_preview(self,conn,community,p):
        require_fields(p,('coverage_id','mappings'))
        coverage=self._entity(conn,'erp_recibos_coberturas',community,p['coverage_id'])
        if coverage['authority']!='legacy_observed':raise ConflictError('Selecciona una cobertura historica observada.')
        if conn.execute('SELECT 1 FROM erp_cobertura_activaciones WHERE id_comunidad=? AND coverage_id=?',(community,coverage['id'])).fetchone():
            raise ConflictError('La cobertura ya esta activada.')
        candidates=self._activation_candidates(conn,community,coverage)
        if not isinstance(p['mappings'],list) or len(p['mappings'])>500:raise ContractError('Revisa una cobertura de hasta 500 recibos.')
        supplied={};lines=[]
        for mapping in p['mappings']:
            require_fields(mapping,('legacy_receipt_id','opening_id','period_from','period_until'),('concept_key',))
            rid=identity(mapping['legacy_receipt_id'])
            if rid in supplied:raise ConflictError('Recibo repetido en la revision.')
            supplied[rid]=mapping
        if set(supplied)!={r['legacy_receipt_id'] for r in candidates}:
            raise ConflictError('La revision debe cubrir todos y solo los recibos del intervalo.')
        for row in candidates:
            m=supplied[row['legacy_receipt_id']];opening=next((o for o in row['openings'] if o['id']==identity(m['opening_id'])),None)
            if not row['property_id'] or not opening:raise ConflictError('Cada recibo debe tener propiedad y correspondencia con una apertura revisada.')
            if int(row['original_cents'])-int(row['observed_collected_cents'])!=int(row['observed_pending_cents']):
                raise ConflictError('Los importes historicos no cuadran; no se corrigen al activar.')
            if min(int(row[k]) for k in ('original_cents','observed_collected_cents','observed_pending_cents'))<0:
                raise ConflictError('Un importe historico negativo requiere clasificacion especifica, no activacion como cargo.')
            concept=text(m.get('concept_key',coverage['concept_key']),'Concepto acreditado',maximum=200)
            start=day(m['period_from']);end=day(m['period_until'])
            if not coverage['effective_from']<=start<=end<=coverage['effective_until']:
                raise ContractError('El periodo acreditado debe pertenecer al intervalo de cobertura.')
            if conn.execute('SELECT 1 FROM erp_recibos WHERE id_comunidad=? AND id_propiedad=? AND concept_key=? AND period_from<=? AND period_until>=?',(community,row['property_id'],concept,end,start)).fetchone():
                raise ConflictError('Existe una obligacion ERP solapada: no se activa una segunda fuente.')
            prior=conn.execute('SELECT * FROM erp_historico_obligaciones WHERE id_comunidad=? AND legacy_receipt_id=?',(community,row['legacy_receipt_id'])).fetchone()
            if prior and (prior['opening_id'],prior['period_from'],prior['period_until'],prior['concept_key'],prior['net_emitted_cents'])!=(opening['id'],start,end,concept,int(row['original_cents'])):
                raise ConflictError('La correspondencia historica ya acreditada no se reinterpreta.')
            if prior and json.loads(prior['snapshot_json'])['source_hash']!=row['source_hash']:
                raise ConflictError('La fuente historica ha cambiado desde su acreditacion. Requiere revision documentada.')
            lines.append({**row,'opening_id':opening['id'],'period_from':start,'period_until':end,
                          'net_emitted_cents':row['original_cents'],'concept_key':concept,'already_mapped':bool(prior)})
        return {'coverage_id':coverage['id'],'concept_key':coverage['concept_key'],'effective_from':coverage['effective_from'],
                'effective_until':coverage['effective_until'],'lines':lines,'source':'legacy_observed',
                'historical_receipts_reissued':False,'economic_responsibility_inferred':False}

    def _activation_apply(self,conn,actor,e,p):
        self._evidence(e,required=True)
        event,now=self._event(conn,actor,e,'erp3.coverage.activated',p['effective_from'],p)
        activation=conn.execute('INSERT INTO erp_cobertura_activaciones(id_comunidad,coverage_id,event_id,snapshot_json,registered_at) VALUES (?,?,?,?,?)',
            (e.community_id,p['coverage_id'],event,canonical_json(p),now)).lastrowid
        for line in p['lines']:
            if line['already_mapped']:continue
            conn.execute('''INSERT INTO erp_historico_obligaciones
                (id_comunidad,activation_id,legacy_receipt_id,opening_id,id_propiedad,concept_key,period_from,period_until,net_emitted_cents,snapshot_json,registered_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)''',(e.community_id,activation,line['legacy_receipt_id'],line['opening_id'],line['property_id'],line['concept_key'],
                line['period_from'],line['period_until'],int(line['net_emitted_cents']),canonical_json(line),now))
        return {'activation_id':activation,'event_ids':[event],'legacy_changed':False,'receipts_created':False}

    def coverage_activation_preview(self,s,e):return self._review_operation(s,e,'coverage_activation','configure',self._activation_preview)
    def coverage_activation_confirm(self,s,e):return self._review_operation(s,e,'coverage_activation','configure',self._activation_preview,self._activation_apply)
