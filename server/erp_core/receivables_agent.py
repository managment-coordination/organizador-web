"""Read-only presentation adapter. The assistant never calculates or attributes debt."""

from .dispatcher import execute_query
from .errors import ContractError, ConflictError, NotFoundError
from .receivables_contracts import cents


def money(value):
    amount=cents(value);sign='-' if amount<0 else '';whole,decimal=divmod(abs(amount),100)
    return sign+format(whole,',').replace(',','.')+','+str(decimal).zfill(2)+' EUR'


def period_answer(database,session,community_ids,start,end):
    keys=('issued_cents','issued_in_period_pending_at_end_cents','cash_received_cents','cash_returns_cents',
          'cash_refunds_cents','receipt_reductions_cents','legacy_observed_issued_cents')
    totals={k:0 for k in keys};issues=[]
    for community in community_ids:
        result=execute_query(database,session,{'query':'erp3.period.summary','id_comunidad':community,
            'filters':{'from':start,'until':end}})['entity']
        for key in keys:totals[key]=cents(totals[key]+int(result[key]))
        issues.extend(result['issues'])
    return {**{k:money(v) for k,v in totals.items()},'note':' '.join(dict.fromkeys(i['message'] for i in issues))}


def debt_answer(database,session,community_ids,*,owner_id=None,property_id=None,year=None,minimum_cents='0'):
    entries=[];issues=[];subtotal=0;shared=0;observed=0;cutoffs=set();count=0
    for community in community_ids:
        filters={'limit':200,'minimum_cents':minimum_cents}
        if owner_id:filters['owner_id']=owner_id
        if property_id:filters['property_id']=property_id
        if year:filters['year']=year
        try:
            result=execute_query(database,session,{'query':'erp3.account.statement','id_comunidad':community,'filters':filters})['entity']
            subtotal+=int(result['documented_subtotal_cents']);shared+=int(result['shared_cents']);observed+=int(result['observed_cents'])
            issues.extend(result['issues']);count+=result['total_count'];cutoffs.add(result['effective_at'])
            entries.extend(result['items'])
            for offset in range(200,min(result['total_count'],10000),200):
                page=execute_query(database,session,{'query':'erp3.account.statement','id_comunidad':community,'filters':{**filters,'offset':offset,'known_at':result['known_at']}})['entity']
                entries.extend(page['items'])
            if result['total_count']>10000:issues.append({'message':'La vista contiene las primeras 10.000 lineas; acota comunidad, propiedad o ejercicio.'})
        except (PermissionError,ContractError,ConflictError,NotFoundError) as error:
            issues.append({'message':str(error)})
    limited=bool(issues)
    heading='Deuda por propiedad' if property_id else 'Deuda del propietario' if owner_id else 'Relacion de deuda'
    text=('Subtotal personal acreditado: '+money(subtotal-shared)+'. Obligaciones compartidas: '+money(shared)+'.') if owner_id else 'Pendiente documentado: '+money(subtotal)+'.'
    text+=' Incluye '+money(observed)+' de fuentes historicas observadas, no validadas automaticamente.'
    if limited:text+=' La cobertura es incompleta; estos datos no permiten certificar el saldo total ni la ausencia de deuda.'
    rows=[{'Referencia':r['reference'],'Propiedad':r['property'],'Obligado / texto de origen':r['obligated'],
           'Pendiente':money(r['pending_cents']),'Atribucion':{'shared':'Compartida, sin dividir','accredited':'Acreditada','unattributed':'Sin atribuir','unaccredited':'Texto historico sin acreditar'}[r['attribution']],
           'Fuente':{'erp3':'ERP','opening':'Apertura observada','legacy_observed':'Netfincas observado'}[r['source']],
           'Corte':r['cutoff_date']} for r in entries]
    return {'answer':text,'facts':{'tipo_resultado':'deuda_erp3','deuda_centimos':str(cents(subtotal)),
                'compartida_centimos':str(cents(shared)),'recibos':count,'ejercicio':year,'id_propiedad':property_id,'id_propietario':owner_id},
            'display':{'title':heading,'subtitle':'Corte efectivo: '+', '.join(sorted(cutoffs)),
                'cards':[{'label':'Subtotal documentado','value':money(subtotal)},{'label':'Obligaciones compartidas','value':money(shared)}],
                'tables':[{'title':heading,'columns':list(rows[0]) if rows else ['Referencia','Propiedad','Pendiente'],'rows':rows}],
                'note':' '.join(dict.fromkeys(i['message'] for i in issues)) or 'Los saldos a favor no se compensan automaticamente.'},
            'sources':[{'module':'ingresos_recibos','table':'erp3.account.statement','description':'Proyeccion determinista ERP 3 con cobertura historica observada'}],
            'data_status':'incompleto' if limited else 'observado' if observed else 'confirmado','query_domain':'deuda'}
