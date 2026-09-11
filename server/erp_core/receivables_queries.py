"""Scoped financial read models with explicit dates, sources and attribution."""

from datetime import date
from decimal import Decimal, InvalidOperation
import json

from access_control import profile
from .errors import ContractError
from .receivables_contracts import CAPABILITIES, cents, day, identity, known_time, require_fields, text
from .receivables_projection import receipt_balance, collection_balance, credit_balance, responsibility_balance, opening_balance
from .receivables_projection import collection_payer


def legacy_cents(value):
    """Observed REAL values are accepted only if their textual value is exact cents."""
    try:
        amount=Decimal(str(value))
        scaled=amount*100
        if not amount.is_finite() or scaled!=scaled.to_integral_value():raise ValueError()
        return cents(int(scaled))
    except (InvalidOperation,ValueError,TypeError,OverflowError):
        raise ContractError('Importe historico no expresable en centimos exactos; requiere revision.') from None


class ReceivablesQueries:
    def period_summary(self,session,query):
        def op(conn,q):
            p=require_fields(q.filters,('from','until'),('known_at',))
            start=day(p['from']);end=day(p['until']);known=known_time(p.get('known_at'))
            if end<start:raise ContractError('El fin no puede preceder al inicio.')
            emitted=0;pending=0;cash=0;returned=0;refunded=0;adjustments=0;observed=0;issues=[]
            for row in conn.execute('SELECT * FROM erp_recibos WHERE id_comunidad=? AND issued_on BETWEEN ? AND ? AND registered_at<=?',(q.community_id,start,end,known)):
                balance=receipt_balance(conn,q.community_id,row['id'],end,known)
                emitted+=row['amount_cents'];pending+=int(balance['pending_cents'])
            for row in conn.execute('SELECT amount_cents FROM erp_cobros WHERE id_comunidad=? AND effective_on BETWEEN ? AND ? AND registered_at<=?',(q.community_id,start,end,known)):cash+=row[0]
            for table,sign in (('erp_devoluciones',1),('erp_devolucion_reversiones',-1)):
                returned+=sign*sum(r[0] for r in conn.execute(f'SELECT amount_cents FROM {table} WHERE id_comunidad=? AND effective_on BETWEEN ? AND ? AND registered_at<=?',(q.community_id,start,end,known)))
            refunded=sum(r[0] for r in conn.execute('SELECT amount_cents FROM erp_reintegros WHERE id_comunidad=? AND effective_on BETWEEN ? AND ? AND registered_at<=?',(q.community_id,start,end,known)))
            refunded+=sum(r[0] for r in conn.execute("SELECT amount_cents FROM erp_apertura_movimientos WHERE id_comunidad=? AND kind='refund' AND effective_on BETWEEN ? AND ? AND registered_at<=?",(q.community_id,start,end,known)))
            for r in conn.execute('SELECT kind,amount_cents FROM erp_rectificaciones WHERE id_comunidad=? AND effective_on BETWEEN ? AND ? AND registered_at<=?',(q.community_id,start,end,known)):
                adjustments+=r['amount_cents']*(-1 if r['kind']=='reverse_credit' else 1)
            for r in conn.execute('SELECT * FROM cf_recibos WHERE id_comunidad=? AND fecha_emision BETWEEN ? AND ?',(q.community_id,start,end)):
                try:observed+=legacy_cents(r['importe'])
                except ContractError as error:issues.append({'message':str(error),'reference':r['referencia']})
            if observed or conn.execute('SELECT 1 FROM erp_saldos_apertura WHERE id_comunidad=?',(q.community_id,)).fetchone():
                issues.append({'message':'Los emitidos historicos son observaciones, no movimientos certificados del periodo. No se suman a los emitidos ERP ni se reconstruyen cobros a partir de un saldo.'})
            return {'from':start,'until':end,'known_at':known,'issued_cents':str(cents(emitted)),
                'issued_in_period_pending_at_end_cents':str(cents(pending)),'cash_received_cents':str(cents(cash)),
                'cash_returns_cents':str(cents(returned)),'cash_refunds_cents':str(cents(refunded)),
                'receipt_reductions_cents':str(cents(adjustments)),'legacy_observed_issued_cents':str(cents(observed)),
                'issues':issues,'legacy_combined':False,'source':'erp3.period.summary'}
        return self._read(session,query,op,'sensitive_read')

    def opening_get(self,session,query):
        def op(conn,q):
            p=require_fields(q.filters,('opening_id',),('effective_at','known_at'))
            row=self._entity(conn,'erp_saldos_apertura',q.community_id,p['opening_id'])
            balance=opening_balance(conn,q.community_id,row['id'],p.get('effective_at'),p.get('known_at'))
            movements=[dict(r) for r in conn.execute('''SELECT m.*,e.reason FROM erp_apertura_movimientos m
                JOIN erp_hechos_economicos e ON e.id_comunidad=m.id_comunidad AND e.id=m.event_id
                WHERE m.id_comunidad=? AND m.opening_id=? AND m.effective_on<=? AND m.registered_at<=? ORDER BY m.effective_on,m.id''',
                (q.community_id,row['id'],balance['effective_at'],balance['known_at']))]
            return {'opening':row,'balance':balance,'movements':movements}
        return self._read(session,query,op,'sensitive_read')

    def account_statement(self,session,query):
        def op(conn,q):
            filters=dict(q.filters);year=filters.pop('year',None)
            minimum=cents(filters.pop('minimum_cents','0'),nonnegative=True)
            if year is not None and (type(year) is not int or not 1900<=year<=9999):raise ContractError('Ejercicio no valido.')
            f=self._financial_filters(filters);self._session(conn,session,q.community_id,'sensitive_read')
            items=[];issues=[];covered=set()
            for r in self._receipt_rows(conn,q.community_id,f):
                if year and r['period_from'][:4]!=str(year):continue
                for bucket in r['responsibilities']:
                    if f['owner_id'] and not any(x['type']=='owner' and x['id']==f['owner_id'] for x in bucket['subjects']):continue
                    amount=int(bucket['pending_cents'])
                    if amount<minimum:continue
                    names=[]
                    for subject in bucket['subjects']:
                        names.append(self._subject(conn,q.community_id,subject)['name'])
                    items.append({'source':'erp3','receipt_id':r['id'],'reference':r['number'],'property_id':r['id_propiedad'],
                        'property':r['property_code'],'period_from':r['period_from'],'due_on':r['due_on'],
                        'pending_cents':str(amount),'obligated':', '.join(names) or 'Sin atribuir',
                        'attribution':'shared' if bucket['shared'] else 'accredited' if names else 'unattributed',
                        'quality':'confirmed','cutoff_date':f['effective_at']})
            for r in conn.execute('SELECT * FROM erp_saldos_apertura WHERE id_comunidad=? AND registered_at<=?',(q.community_id,f['known_at'])):
                source=json.loads(r['source_json']);covered.update(source.get('normalized',{}).get('legacy_receipt_ids',[]))
                if f['property_id'] and r['id_propiedad']!=f['property_id']:continue
                if f['owner_id'] and r['owner_id']!=f['owner_id']:continue
                if r['limitations']:
                    issues.append({'source':'opening','opening_id':r['id'],'message':str(r['limitations'])})
                if r['effective_on']>f['effective_at'] or year:
                    issues.append({'source':'opening','reference':source.get('normalized',{}).get('reference'),'message':'La apertura agregada no permite distribuir la deuda por ejercicio ni reconstruir cortes anteriores.'});continue
                amount=int(opening_balance(conn,q.community_id,r['id'],f['effective_at'],f['known_at'])['remaining_cents'])
                if amount<=0 or amount<minimum:continue
                prop=conn.execute('SELECT codigo_propiedad FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?',(q.community_id,r['id_propiedad'])).fetchone()
                owner=self._subject(conn,q.community_id,{'type':'owner','id':r['owner_id']}) if r['owner_id'] else None
                items.append({'source':'opening','opening_id':r['id'],'reference':source.get('normalized',{}).get('reference',''),
                    'property_id':r['id_propiedad'],'property':prop[0] if prop else 'Sin propiedad','period_from':None,'due_on':None,
                    'pending_cents':str(amount),'obligated':owner['name'] if owner else 'Sin atribuir',
                    'attribution':'accredited' if owner else 'unattributed','quality':'observed','cutoff_date':r['effective_on']})
            for r in conn.execute('SELECT * FROM cf_recibos WHERE id_comunidad=? AND (? IS NULL OR id_propiedad=?)',(q.community_id,f['property_id'],f['property_id'])):
                if r['id_recibo'] in covered:continue
                if f['owner_id']:
                    if not any(i.get('type')=='unaccredited_legacy' for i in issues):issues.append({'type':'unaccredited_legacy','message':'El historico observado no acredita por si solo la deuda personal. No puede afirmarse ausencia de deuda.'})
                    continue
                source_year=str(r['ejercicio'] or str(r['fecha_emision'] or '')[:4])
                if year and not source_year:
                    issues.append({'source':'legacy_observed','reference':r['referencia'],'message':'La fuente no identifica el ejercicio de esta deuda.'});continue
                if year and source_year!=str(year):continue
                try:
                    cutoff=day(str(r['fecha_ultima_actualizacion'] or r['fecha_creacion'] or '')[:10])
                    if cutoff>f['effective_at'] or cutoff>f['known_at'][:10]:raise ContractError('La fuente no reconstruye este corte efectivo/conocido.')
                    amount=legacy_cents(r['deuda'])
                    if amount<0 or legacy_cents(r['importe'])-legacy_cents(r['cobrado'])!=amount:raise ContractError('Los importes historicos no cuadran.')
                    if amount==0 or amount<minimum:continue
                    prop=conn.execute('SELECT codigo_propiedad FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?',(q.community_id,r['id_propiedad'])).fetchone()
                    items.append({'source':'legacy_observed','legacy_receipt_id':r['id_recibo'],'reference':r['referencia'] or '',
                        'property_id':r['id_propiedad'],'property':prop[0] if prop else r['propiedad_texto'] or 'Sin propiedad',
                        'period_from':r['fecha_emision'],'due_on':None,'pending_cents':str(amount),
                        'obligated':r['propietario_texto'] or 'Sin atribuir','attribution':'unaccredited','quality':'observed','cutoff_date':cutoff})
                except ContractError as error:issues.append({'source':'legacy_observed','reference':r['referencia'],'message':str(error)})
            items.sort(key=lambda r:(r['due_on'] or '9999-12-31',r['property'],r['reference']))
            subtotal=cents(sum(int(r['pending_cents']) for r in items))
            shared=cents(sum(int(r['pending_cents']) for r in items if r['attribution']=='shared'))
            observed=cents(sum(int(r['pending_cents']) for r in items if r['quality']=='observed'))
            return {'items':items[f['offset']:f['offset']+f['limit']],'total_count':len(items),'offset':f['offset'],'limit':f['limit'],
                    'documented_subtotal_cents':str(subtotal),'shared_cents':str(shared),'observed_cents':str(observed),
                    'personal_cents':str(subtotal-shared) if f['owner_id'] else None,
                    'complete':not issues,'issues':issues,'year':year,'effective_at':f['effective_at'],'known_at':f['known_at'],
                    'totals_scope':'filtered_all_pages','automatic_netting':False}
        return self._read(session,query,op)

    def responsibility_get(self,session,query):
        def op(conn,q):
            require_fields(q.filters,('property_id',),('concept_key',))
            pid=identity(q.filters['property_id']);concept=q.filters.get('concept_key','*')
            rows=[dict(r) for r in conn.execute('SELECT * FROM erp_obligacion_config_versiones WHERE id_comunidad=? AND id_propiedad=? AND concept_key=? ORDER BY version DESC',(q.community_id,pid,concept))]
            return {'version':rows[0]['version'] if rows else 0,'history':rows}
        return self._read(session,query,op,'resolve_responsibility')

    def import_access(self,session,query):
        def op(conn,q):
            require_fields(q.filters,())
            return {'allowed':True}
        return self._read(session,query,op,'import_history')

    def workspace_get(self,session,query):
        def op(conn,q):
            require_fields(q.filters,(),('effective_at','known_at','property_id','owner_id','state','search','offset','limit'))
            f=self._financial_filters(q.filters)
            self._session(conn,session,q.community_id,'sensitive_read')
            current=profile(conn,session['id_usuario'])
            collections=[]
            for row in conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND effective_on<=? AND registered_at<=? ORDER BY effective_on DESC,id DESC',
                                    (q.community_id,f['effective_at'],f['known_at'])):
                row={**dict(row),**collection_payer(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])}
                if f['owner_id'] and row['payer_owner_id']!=f['owner_id']:continue
                if f['property_id'] and not conn.execute('SELECT 1 FROM erp_imputaciones a JOIN erp_recibos r ON r.id=a.receipt_id AND r.id_comunidad=a.id_comunidad WHERE a.id_comunidad=? AND a.collection_id=? AND r.id_propiedad=? AND a.effective_on<=? AND a.registered_at<=?',(q.community_id,row['id'],f['property_id'],f['effective_at'],f['known_at'])).fetchone():continue
                collections.append({**dict(row),'balance':collection_balance(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])})
            result={'collections':collections[f['offset']:f['offset']+f['limit']],'collection_count':len(collections),
                    'properties':[dict(r) for r in conn.execute('SELECT id_propiedad,codigo_propiedad FROM cf_propiedades WHERE id_comunidad=? ORDER BY codigo_propiedad',(q.community_id,))],
                    'owners':[dict(r) for r in conn.execute('SELECT id_propietario,nombre FROM cf_propietarios WHERE id_comunidad=? ORDER BY nombre',(q.community_id,))],
                    'persons':[dict(r) for r in conn.execute('SELECT id_persona_cobro,nombre FROM erp_personas_cobro WHERE id_comunidad=? ORDER BY nombre',(q.community_id,))]}
            result['imports']=[dict(r) for r in conn.execute('SELECT id,source,state,version,registered_at FROM erp_importaciones_economicas WHERE id_comunidad=? ORDER BY id DESC LIMIT 100',(q.community_id,))]
            result['credits']=[{**dict(r),'balance':credit_balance(conn,q.community_id,r['id'],f['effective_at'],f['known_at'])}
                               for r in conn.execute('SELECT * FROM erp_creditos WHERE id_comunidad=? AND effective_on<=? AND registered_at<=? ORDER BY id DESC',(q.community_id,f['effective_at'],f['known_at']))
                               if not f['property_id'] and (not f['owner_id'] or r['owner_id']==f['owner_id'])]
            result['returns']=[dict(r) for r in conn.execute('''SELECT d.*,v.id AS reversal_id FROM erp_devoluciones d
                LEFT JOIN erp_devolucion_reversiones v ON v.id_comunidad=d.id_comunidad AND v.return_id=d.id AND v.effective_on<=? AND v.registered_at<=?
                WHERE d.id_comunidad=? AND d.effective_on<=? AND d.registered_at<=? ORDER BY d.id DESC LIMIT 100''',
                (f['effective_at'],f['known_at'],q.community_id,f['effective_at'],f['known_at']))
                if not (f['owner_id'] or f['property_id']) or any(c['id']==r['collection_id'] for c in collections)]
            result['regularizations']=[{**dict(r),'lines':[dict(l) for l in conn.execute('''SELECT l.*,p.codigo_propiedad,
                    m.id AS materialized_id FROM erp_regularizacion_lineas l
                    JOIN cf_propiedades p ON p.id_comunidad=l.id_comunidad AND p.id_propiedad=l.id_propiedad
                    LEFT JOIN erp_regularizaciones_materializadas m ON m.id_comunidad=l.id_comunidad AND m.line_id=l.id_linea
                    WHERE l.id_comunidad=? AND l.id_regularizacion=? ORDER BY l.id_linea''',(q.community_id,r['id_regularizacion']))]}
                for r in conn.execute("SELECT * FROM erp_regularizaciones WHERE id_comunidad=? AND estado='aprobada' ORDER BY id_regularizacion DESC LIMIT 50",(q.community_id,))]
            if current['rol']=='Superusuario':
                result['permission_users']=[]
                for user in conn.execute('SELECT id_usuario,nombre FROM usuarios WHERE activo=1 ORDER BY nombre'):
                    from access_control import permission
                    if not permission(profile(conn,user['id_usuario']),q.community_id):continue
                    grants=list(conn.execute('SELECT capability,allowed,version FROM erp_recibo_permisos WHERE id_comunidad=? AND id_usuario=?',(q.community_id,user['id_usuario'])))
                    result['permission_users'].append({**dict(user),'version':max((r['version'] for r in grants),default=0),'capabilities':{r['capability']:bool(r['allowed']) for r in grants}})
            return result
        return self._read(session,query,op)

    @staticmethod
    def _financial_filters(filters):
        require_fields(filters,(),('effective_at','known_at','property_id','owner_id','state','search','offset','limit'))
        offset=filters.get('offset',0);limit=filters.get('limit',50)
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=200:
            raise ContractError('Paginacion no valida.')
        return {'effective_at':day(filters.get('effective_at') or date.today().isoformat()),
                'known_at':known_time(filters.get('known_at')),'property_id':identity(filters['property_id']) if filters.get('property_id') else None,
                'owner_id':identity(filters['owner_id']) if filters.get('owner_id') else None,'state':filters.get('state'),
                'search':(text(filters.get('search'),'Busqueda',required=False,maximum=200) or '').casefold(),
                'offset':offset,'limit':limit}

    def _receipt_rows(self,conn,community,f):
        rows=[]
        for row in conn.execute('''SELECT r.*,p.codigo_propiedad AS property_code FROM erp_recibos r
            JOIN cf_propiedades p ON p.id_comunidad=r.id_comunidad AND p.id_propiedad=r.id_propiedad
            WHERE r.id_comunidad=? AND r.issued_on<=? AND r.registered_at<=?
            AND (? IS NULL OR r.id_propiedad=?) ORDER BY COALESCE(r.due_on,'9999-12-31'),r.id''',
            (community,f['effective_at'],f['known_at'],f['property_id'],f['property_id'])):
            balance=receipt_balance(conn,community,row['id'],f['effective_at'],f['known_at'])
            responsibilities=responsibility_balance(conn,community,row['id'],f['effective_at'],f['known_at'])
            subjects=[{'role':s['role'],**json.loads(s['snapshot_json'])} for s in conn.execute(
                'SELECT role,snapshot_json FROM erp_recibo_sujetos WHERE id_comunidad=? AND receipt_id=?',(community,row['id']))]
            related=not f['owner_id'] or any(s.get('type')=='owner' and s.get('id')==f['owner_id'] for s in subjects)
            related=related or any(s['type']=='owner' and s['id']==f['owner_id'] for b in responsibilities for s in b['subjects'])
            if not related and f['owner_id']:
                for transfer in conn.execute('''SELECT source_json,target_json FROM erp_reasignaciones_obligacion
                    WHERE id_comunidad=? AND receipt_id=? AND effective_on<=? AND registered_at<=?''',
                    (community,row['id'],f['effective_at'],f['known_at'])):
                    if any(s['type']=='owner' and s['id']==f['owner_id'] for s in json.loads(transfer[0])+json.loads(transfer[1])):
                        related=True;break
            if not related:continue
            if f['state'] and balance['state']!=f['state'] and balance['management']!=f['state']:continue
            if f['search'] and f['search'] not in ' '.join([row['number'],row['description'],row['property_code'] or '',*(s.get('name','') for s in subjects)]).casefold():continue
            row=dict(row);row.pop('snapshot_json');row.pop('snapshot_hash')
            rows.append({**row,'balance':balance,'responsibilities':responsibilities,'subjects':subjects})
        return rows

    def receipt_list(self,session,query):
        def op(conn,q):
            f=self._financial_filters(q.filters);rows=self._receipt_rows(conn,q.community_id,f)
            return {'items':rows[f['offset']:f['offset']+f['limit']],'total_count':len(rows),'offset':f['offset'],'limit':f['limit'],
                'pending_cents':str(cents(sum(int(r['balance']['pending_cents']) for r in rows))),
                'effective_at':f['effective_at'],'known_at':f['known_at'],'source':'ERP3','totals_scope':'filtered_all_pages'}
        return self._read(session,query,op)

    def debt_summary(self,session,query):
        def op(conn,q):
            f=self._financial_filters(q.filters)
            if f['owner_id']:self._session(conn,session,q.community_id,'sensitive_read')
            rows=self._receipt_rows(conn,q.community_id,f);native=0;personal=0;shared=0;unattributed=0;overdue=0
            for row in rows:
                pending=int(row['balance']['pending_cents']);native+=pending
                if row['balance']['overdue']:overdue+=pending
                for bucket in row['responsibilities']:
                    amount=int(bucket['pending_cents'])
                    if not bucket['subjects']:unattributed+=amount
                    elif f['owner_id'] and any(s['type']=='owner' and s['id']==f['owner_id'] for s in bucket['subjects']):
                        if bucket['shared']:shared+=amount
                        else:personal+=amount
            openings=[];covered_legacy=set();opening_debt=0;opening_credit=0;issues=[]
            # Coverage links are known-time sensitive even for a pre-cutoff query.
            for row in conn.execute('SELECT * FROM erp_saldos_apertura WHERE id_comunidad=? AND registered_at<=?',(q.community_id,f['known_at'])):
                source=json.loads(row['source_json']);n=source.get('normalized',{})
                covered_legacy.update(n.get('legacy_receipt_ids',[]))
                if f['property_id'] and row['id_propiedad']!=f['property_id']:continue
                if f['owner_id'] and row['owner_id']!=f['owner_id']:continue
                if row['effective_on']>f['effective_at']:
                    issues.append({'type':'insufficient_history','opening_id':row['id'],'available_from':row['effective_on']});continue
                amount=int(opening_balance(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])['remaining_cents']);opening_debt+=max(0,amount);opening_credit+=max(0,-amount)
                openings.append({'id':row['id'],'property_id':row['id_propiedad'],'owner_id':row['owner_id'],'amount_cents':str(amount),
                    'cutoff_date':row['effective_on'],'quality':row['quality'],'limitations':row['limitations'],'source':source})
                if not row['owner_id']:unattributed+=max(0,amount)
            legacy=0;legacy_count=0;legacy_cutoffs=set();unaccredited_legacy=0
            for row in conn.execute('SELECT * FROM cf_recibos WHERE id_comunidad=? AND (? IS NULL OR id_propiedad=?)',(q.community_id,f['property_id'],f['property_id'])):
                if row['id_recibo'] in covered_legacy:continue
                # A legacy owner FK alone does not accredit the historic economic debtor.
                if f['owner_id']:
                    unaccredited_legacy+=1
                    continue
                cutoff=str(row['fecha_ultima_actualizacion'] or row['fecha_creacion'] or '')[:10]
                try:
                    cutoff=day(cutoff)
                    if cutoff>f['effective_at'] or cutoff>f['known_at'][:10]:
                        issues.append({'type':'insufficient_history','legacy_receipt_id':row['id_recibo'],'available_from':cutoff});continue
                    amount=legacy_cents(row['deuda'])
                    original=legacy_cents(row['importe']);collected=legacy_cents(row['cobrado'])
                    if original-collected!=amount:raise ContractError('Los importes originales no cuadran.')
                    if amount<0:raise ContractError('Saldo historico negativo sin clasificacion acreditada.')
                    legacy+=amount;legacy_count+=1;legacy_cutoffs.add(cutoff)
                except ContractError as error:
                    issues.append({'type':'legacy_review','legacy_receipt_id':row['id_recibo'],'message':str(error)})
            if unaccredited_legacy:
                issues.append({'type':'personal_coverage_unaccredited','legacy_records':unaccredited_legacy,
                    'message':'El historico observado no acredita toda la responsabilidad personal; el saldo nativo no demuestra por si solo ausencia de deuda.'})
            cash_available=0;credit_available=0
            for row in conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND effective_on<=? AND registered_at<=?',(q.community_id,f['effective_at'],f['known_at'])):
                if f['property_id']:continue
                if f['owner_id'] and collection_payer(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])['payer_owner_id']!=f['owner_id']:continue
                cash_available+=int(collection_balance(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])['available_cents'])
            for row in conn.execute('SELECT * FROM erp_creditos WHERE id_comunidad=? AND effective_on<=? AND registered_at<=?',(q.community_id,f['effective_at'],f['known_at'])):
                if f['property_id']:continue
                if f['owner_id'] and row['owner_id']!=f['owner_id']:continue
                credit_available+=int(credit_balance(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])['available_cents'])
            return {'native_pending_cents':str(cents(native)),'native_overdue_cents':str(cents(overdue)),
                'personal_pending_cents':str(cents(personal)) if f['owner_id'] else None,
                'shared_obligations_cents':str(cents(shared)) if f['owner_id'] else None,
                'unattributed_cents':str(cents(unattributed+legacy)),'observed_opening_debt_cents':str(cents(opening_debt)),
                'observed_legacy_debt_cents':str(cents(legacy)),'observed_legacy_count':legacy_count,
                'native_cash_available_cents':str(cents(cash_available)),'native_credit_available_cents':str(cents(credit_available)),
                'observed_opening_credit_cents':str(cents(opening_credit)),
                'documented_subtotal_cents':str(cents(native+opening_debt+legacy)) if not f['owner_id'] else None,
                'total_pending_cents':str(cents(native+opening_debt+legacy)) if not f['owner_id'] and not issues else None,
                'legacy_cutoffs':sorted(legacy_cutoffs),'openings':openings,'issues':issues,'complete':not issues,
                'effective_at':f['effective_at'],'known_at':f['known_at'],'automatic_netting':False,
                'owner_legacy_attribution':'not_inferred','credit_property_attribution':'not_inferred' if f['property_id'] else None}
        return self._read(session,query,op)

    def collection_unallocated(self,session,query):
        def op(conn,q):
            f=self._financial_filters(q.filters);rows=[]
            for row in conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND effective_on<=? AND registered_at<=? ORDER BY effective_on,id',
                (q.community_id,f['effective_at'],f['known_at'])):
                row={**dict(row),**collection_payer(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])}
                if f['owner_id'] and row['payer_owner_id']!=f['owner_id']:continue
                b=collection_balance(conn,q.community_id,row['id'],f['effective_at'],f['known_at'])
                if int(b['available_cents']):rows.append({**dict(row),'balance':b})
            return {'items':rows[f['offset']:f['offset']+f['limit']],'total_count':len(rows),'available_cents':str(cents(sum(int(r['balance']['available_cents']) for r in rows))),
                    'effective_at':f['effective_at'],'known_at':f['known_at'],'totals_scope':'filtered_all_pages'}
        return self._read(session,query,op)

    def receipt_timeline(self,session,query):
        def op(conn,q):
            p=require_fields(q.filters,('receipt_id',),('effective_at','known_at'))
            rid=identity(p['receipt_id']);effective=day(p.get('effective_at') or date.today().isoformat());known=known_time(p.get('known_at'))
            balance=receipt_balance(conn,q.community_id,rid,effective,known);events=[]
            for table in ('erp_imputaciones','erp_credito_aplicaciones','erp_rectificaciones','erp_recibo_gestion_eventos','erp_reasignaciones_obligacion','erp_apertura_movimientos'):
                for row in conn.execute(f'''SELECT e.*,m.id AS movement_id FROM {table} m JOIN erp_hechos_economicos e ON e.id_comunidad=m.id_comunidad AND e.id=m.event_id
                    WHERE m.id_comunidad=? AND m.receipt_id=? AND m.effective_on<=? AND m.registered_at<=?''',(q.community_id,rid,effective,known)):
                    events.append(dict(row))
            return {'balance':balance,'responsibilities':responsibility_balance(conn,q.community_id,rid,effective,known),
                    'events':sorted(events,key=lambda x:(x['effective_on'],x['registered_at'],x['id'],x['movement_id']))}
        return self._read(session,query,op)

    def reference_get(self,session,query):
        def op(conn,q):
            require_fields(q.filters,())
            current=profile(conn,session['id_usuario'])
            grants={r['capability']:bool(r['allowed']) for r in conn.execute('SELECT * FROM erp_recibo_permisos WHERE id_comunidad=? AND id_usuario=?',(q.community_id,session['id_usuario']))}
            return {'capabilities':{k:current['rol']=='Superusuario' or grants.get(k,False) for k in sorted(CAPABILITIES)},
                'currency':conn.execute('SELECT moneda FROM comunidades WHERE id_comunidad=?',(q.community_id,)).fetchone()[0],
                'coverages':[dict(r) for r in conn.execute('SELECT * FROM erp_recibos_coberturas WHERE id_comunidad=? ORDER BY effective_from',(q.community_id,))],
                'policies':[dict(r) for r in conn.execute('SELECT * FROM erp_recibo_politicas WHERE id_comunidad=? ORDER BY effective_from DESC,version DESC',(q.community_id,))]}
        return self._read(session,query,op)
