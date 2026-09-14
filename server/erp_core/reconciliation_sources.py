"""Read-only aggregate source router. Never union legacy and ERP 5 bank balances."""
from contextlib import closing
from .database import connect
from .receivables_contracts import day


def bank_occurrence_facts(conn,vault,community,identity_value,canonical):
    """Only a configured, exact PSP/service/kind namespace proves shared identity."""
    from .errors import ConflictError
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='erp_banco_movimiento_identidades'").fetchone():return None
    namespace='erp4:'+identity_value['psp']+':'+identity_value['service']+':'+identity_value['kind']
    value=[identity_value['treasury_id'],namespace,identity_value['event_id']]
    movement=None
    for key,digest in vault.fingerprints(community,'bank-movement-identity',value).items():
        row=conn.execute('''SELECT m.* FROM erp_banco_movimiento_identidades i JOIN erp_banco_movimientos m
            ON m.id_comunidad=i.id_comunidad AND m.id=i.movement_id
            WHERE i.id_comunidad=? AND i.key_id=? AND i.digest=?''',(community,key,digest)).fetchone()
        if row:
            if movement and movement['id']!=row['id']:raise ConflictError('Identidad bancaria incompatible entre claves.')
            movement=row
    if not movement:return None
    seen=set()
    while True:
        if movement['id'] in seen:raise ConflictError('La identidad bancaria tiene una cadena de correcciones incompatible.')
        seen.add(movement['id'])
        correction=conn.execute('SELECT replacement_id FROM erp_banco_movimiento_correcciones WHERE id_comunidad=? AND movement_id=?',(community,movement['id'])).fetchone()
        if not correction:break
        movement=conn.execute('SELECT * FROM erp_banco_movimientos WHERE id_comunidad=? AND id=?',(community,correction['replacement_id'])).fetchone()
        if not movement:raise ConflictError('No se puede reconstruir el sustituto de la ocurrencia bancaria.')
    sign=1 if identity_value['kind']=='settlement' else -1
    if movement['currency']!=canonical['currency'] or movement['operation_on']!=canonical['effective_on'] or movement['amount_cents']!=sign*int(canonical['amount_cents']):
        raise ConflictError('La ocurrencia del extracto tiene datos distintos al resultado. Revisa la evidencia.')
    kind='collection' if sign>0 else 'return'
    rows=list(conn.execute(f'''SELECT {kind}_id AS fact_id,sum(amount_cents) AS assigned
        FROM erp_conciliacion_componentes WHERE id_comunidad=? AND movement_id=? AND kind=? GROUP BY {kind}_id''',
        (community,movement['id'],kind)))
    rows=[r for r in rows if r['assigned']]
    if not rows:
        assigned=conn.execute('SELECT coalesce(sum(amount_cents),0) FROM erp_conciliacion_componentes WHERE id_comunidad=? AND movement_id=?',(community,movement['id'])).fetchone()[0]
        if assigned:raise ConflictError('La ocurrencia bancaria esta vinculada a otro tipo de hecho. Revisa la correspondencia antes de aplicar el resultado.')
        return None
    if len(rows)!=1 or rows[0]['assigned']!=movement['amount_cents']:
        raise ConflictError('Ocurrencia ya conciliada parcialmente o con varios hechos. Revisa sus correspondencias antes de aplicar el resultado.')
    return {'movement_id':movement['id'],'kind':kind,'fact_id':rows[0]['fact_id']}


def money(cents):
    if cents is None:return 'No verificable'
    n=abs(int(cents))
    return ('-' if int(cents)<0 else '')+str(n//100)+','+str(n%100).zfill(2)+' EUR'


def period_bank_answer(path,session,communities,start,end):
    start=day(start);end=day(end)
    if end<start:raise ValueError('Invalid bank period')
    with closing(connect(path)) as conn:
        conn.execute('BEGIN')
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='erp_banco_fuentes_activaciones'").fetchone():return None
        active=[]
        for community in communities:
            active.extend(conn.execute('SELECT * FROM erp_banco_fuentes_activaciones WHERE id_comunidad=? AND start_on<=? AND end_on>=?',(community,end,start)).fetchall())
        if not active:return None
        from .reconciliation_service import ReconciliationService
        items=[];complete=True
        for community in communities:
            try:ReconciliationService._session(conn,session,community,'read')
            except PermissionError:
                items.append({'community_id':community,'state':'no_autorizado'});complete=False;continue
            for account in conn.execute("SELECT * FROM erp_cuentas_tesoreria WHERE id_comunidad=? AND kind='banco'",(community,)):
                source=next((r for r in active if r['id_comunidad']==community and r['treasury_id']==account['id'] and r['start_on']<=start and r['end_on']>=end),None)
                coverage=conn.execute('SELECT * FROM erp_extractos_coberturas WHERE id_comunidad=? AND treasury_id=? AND start_on=? AND end_on=? ORDER BY id DESC LIMIT 1',
                    (community,account['id'],source['start_on'],source['end_on'])).fetchone() if source else None
                if not coverage or not coverage['complete'] or coverage['balance_type']!='booked' or coverage['opening_cents'] is None:
                    complete=False;items.append({'community_id':community,'treasury_id':account['id'],'state':'cobertura_incompleta'});continue
                rows=[r for r in conn.execute("SELECT * FROM erp_banco_movimientos WHERE id_comunidad=? AND treasury_id=? AND operation_on>=? AND operation_on<=? AND source_state='booked'",
                    (community,account['id'],coverage['start_on'],coverage['end_on'])) if not conn.execute('SELECT 1 FROM erp_banco_movimiento_correcciones WHERE id_comunidad=? AND movement_id=?',(community,r['id'])).fetchone()]
                reconstructed=coverage['opening_cents']+sum(r['amount_cents'] for r in rows)
                if coverage['closing_cents'] is None or coverage['closing_cents']!=reconstructed:
                    complete=False;items.append({'community_id':community,'treasury_id':account['id'],'state':'saldo_no_cuadrado'});continue
                opening=coverage['opening_cents']+sum(r['amount_cents'] for r in rows if r['operation_on']<start)
                ending=opening+sum(r['amount_cents'] for r in rows if start<=r['operation_on']<=end)
                items.append({'community_id':community,'treasury_id':account['id'],'opening_cents':str(opening),'ending_cents':str(ending),'state':'reconstruido'})
        opening=sum(int(r['opening_cents']) for r in items) if complete else None
        ending=sum(int(r['ending_cents']) for r in items) if complete else None
        return {'source':'ERP5','items':items,'complete':complete,'display_start':money(opening),'display_end':money(ending),
            'note':'Saldos ERP 5 reconstruidos por fecha de operacion sobre cobertura bancaria acreditada. No sumados al origen legacy.' if complete
            else 'ERP 5 es el origen rector del intervalo; faltan permisos, cobertura o cuadre para mostrar un total. No se utiliza legacy como sustituto.'}
