"""Read-only, exact balance projections with effective and knowledge cutoffs."""

from datetime import date
import json

from .errors import ContractError, NotFoundError
from .receivables_contracts import cents, day, known_time


def subject_group(subjects):
    return sorted([{'type':s['type'],'id':int(s['id'])} for s in subjects],key=lambda s:(s['type'],s['id']))


def original_responsibility(conn,community,receipt_id):
    return subject_group([json.loads(r[0]) for r in conn.execute(
        "SELECT snapshot_json FROM erp_recibo_sujetos WHERE id_comunidad=? AND receipt_id=? AND role='obligated'",(community,receipt_id))])


def responsibility_balance(conn,community,receipt_id,effective_at=None,known_at=None):
    effective=day(effective_at or date.today().isoformat());known=known_time(known_at)
    balance=receipt_balance(conn,community,receipt_id,effective,known)
    original=original_responsibility(conn,community,receipt_id);buckets={}
    def add(subjects,delta):
        group=subject_group(subjects);key=json.dumps(group,sort_keys=True)
        bucket=buckets.setdefault(key,{'subjects':group,'pending_cents':0})
        bucket['pending_cents']=cents(bucket['pending_cents']+delta)
    add(original,int(balance['original_cents']))
    for table in ('erp_imputaciones','erp_credito_aplicaciones','erp_rectificaciones'):
        for r in conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? AND receipt_id=? AND effective_on<=? AND registered_at<=?',(community,receipt_id,effective,known)):
            reversed_=(r['kind']=='reverse_credit') if table=='erp_rectificaciones' else bool(r['reverses_id'])
            add(json.loads(r['responsibility_json']) if r['responsibility_json'] else original,r['amount_cents']*(1 if reversed_ else -1))
    for r in conn.execute('SELECT * FROM erp_reasignaciones_obligacion WHERE id_comunidad=? AND receipt_id=? AND effective_on<=? AND registered_at<=?',(community,receipt_id,effective,known)):
        add(json.loads(r['source_json']),-r['amount_cents']);add(json.loads(r['target_json']),r['amount_cents'])
    for r in conn.execute('SELECT * FROM erp_apertura_movimientos WHERE id_comunidad=? AND receipt_id=? AND effective_on<=? AND registered_at<=?',(community,receipt_id,effective,known)):
        add(json.loads(r['responsibility_json']) if r['responsibility_json'] else original,r['amount_cents']*(1 if r['reverses_id'] else -1))
    if any(x['pending_cents']<0 for x in buckets.values()) or sum(x['pending_cents'] for x in buckets.values())!=int(balance['pending_cents']):
        raise ContractError('La distribucion de responsabilidad no cuadra con el pendiente. Revisa la atribucion de la operacion.')
    return [{'subjects':x['subjects'],'pending_cents':str(x['pending_cents']),'shared':len(x['subjects'])>1,'unattributed':not x['subjects']}
            for _,x in sorted(buckets.items()) if x['pending_cents']]


def _sum(conn, table, field, community_id, key, entity_id, effective_at, known_at, expression='amount_cents'):
    # Table/column names are constants passed only by this module, never request input.
    rows = conn.execute(f'SELECT {expression} AS amount FROM {table} WHERE id_comunidad=? AND {key}=? AND effective_on<=? AND registered_at<=?',
                        (community_id, entity_id, effective_at, known_at))
    return cents(sum(int(row['amount']) for row in rows))


def receipt_balance(conn, community_id, receipt_id, effective_at=None, known_at=None):
    effective_at = day(effective_at or date.today().isoformat())
    known_at = known_time(known_at)
    row = conn.execute('SELECT * FROM erp_recibos WHERE id_comunidad=? AND id=? AND issued_on<=? AND registered_at<=?',
                       (community_id, receipt_id, effective_at, known_at)).fetchone()
    if row is None:
        raise NotFoundError('El recibo no existe en este ambito y fecha.')
    paid = _sum(conn,'erp_imputaciones',None,community_id,'receipt_id',receipt_id,effective_at,known_at,
                'CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END')
    credit = _sum(conn,'erp_credito_aplicaciones',None,community_id,'receipt_id',receipt_id,effective_at,known_at,
                  'CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END')
    credit += _sum(conn,'erp_apertura_movimientos',None,community_id,'receipt_id',receipt_id,effective_at,known_at,
                   'CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END')
    reductions = _sum(conn,'erp_rectificaciones',None,community_id,'receipt_id',receipt_id,effective_at,known_at,
                      "CASE WHEN kind='reverse_credit' THEN -amount_cents ELSE amount_cents END")
    pending = cents(int(row['amount_cents']) - paid - credit - reductions)
    if min(pending,paid,credit,reductions) < 0:
        raise ContractError('La proyeccion contiene un saldo negativo incompatible; no se oculta ni corrige.')
    voided = conn.execute("SELECT 1 FROM erp_rectificaciones WHERE id_comunidad=? AND receipt_id=? AND kind='void' AND effective_on<=? AND registered_at<=?",
                          (community_id,receipt_id,effective_at,known_at)).fetchone() is not None
    management = conn.execute('SELECT classification FROM erp_recibo_gestion_eventos WHERE id_comunidad=? AND receipt_id=? AND effective_on<=? AND registered_at<=? ORDER BY effective_on DESC,registered_at DESC,id DESC LIMIT 1',
                              (community_id,receipt_id,effective_at,known_at)).fetchone()
    return {'receipt_id':receipt_id,'original_cents':str(row['amount_cents']), 'paid_cents':str(paid),
            'compensated_cents':str(credit),'reduced_cents':str(reductions),'pending_cents':str(pending),
            'currency':row['currency'],'state':'anulado' if voided else 'liquidado' if not pending else 'pendiente' if pending==row['amount_cents'] else 'parcial',
            'management':management[0] if management else None,
            'overdue':bool(pending and row['due_on'] and row['due_on']<effective_at),
            'effective_at':effective_at,'known_at':known_at}


def collection_balance(conn, community_id, collection_id, effective_at=None, known_at=None):
    effective_at=day(effective_at or date.today().isoformat()); known_at=known_time(known_at)
    row=conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND id=? AND effective_on<=? AND registered_at<=?',
                     (community_id,collection_id,effective_at,known_at)).fetchone()
    if row is None:
        raise NotFoundError('El cobro no existe en este ambito y fecha.')
    applied=_sum(conn,'erp_imputaciones',None,community_id,'collection_id',collection_id,effective_at,known_at,
                 'CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END')
    applied+=_sum(conn,'erp_apertura_movimientos',None,community_id,'collection_id',collection_id,effective_at,known_at,
                  'CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END')
    returned=_sum(conn,'erp_devoluciones',None,community_id,'collection_id',collection_id,effective_at,known_at)
    returned-=_sum(conn,'erp_devolucion_reversiones',None,community_id,'collection_id',collection_id,effective_at,known_at)
    refunded=_sum(conn,'erp_reintegros',None,community_id,'collection_id',collection_id,effective_at,known_at)
    available=cents(int(row['amount_cents'])-applied-returned-refunded)
    if min(available,applied,returned,refunded)<0:
        raise ContractError('Los movimientos superan los fondos disponibles.')
    return {'collection_id':collection_id,'original_cents':str(row['amount_cents']),
            'applied_cents':str(applied),'returned_cents':str(returned),'refunded_cents':str(refunded),
            'available_cents':str(available),'currency':row['currency'],'effective_at':effective_at,'known_at':known_at}


def collection_payer(conn,community_id,collection_id,effective_at=None,known_at=None):
    effective=day(effective_at or date.today().isoformat());known=known_time(known_at)
    row=conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND id=? AND effective_on<=? AND registered_at<=?',(community_id,collection_id,effective,known)).fetchone()
    if not row:raise NotFoundError('El cobro no existe en este corte.')
    original={'payer_owner_id':row['payer_owner_id'],'payer_person_id':row['payer_person_id']}
    evidence=conn.execute('SELECT * FROM erp_cobro_acreditaciones WHERE id_comunidad=? AND collection_id=? AND effective_on<=? AND registered_at<=?',(community_id,collection_id,effective,known)).fetchone()
    return {**original,'accreditation_id':None} if not evidence else {'payer_owner_id':evidence['payer_owner_id'],'payer_person_id':evidence['payer_person_id'],'accreditation_id':evidence['id']}


def credit_balance(conn,community_id,credit_id,effective_at=None,known_at=None):
    effective_at=day(effective_at or date.today().isoformat()); known_at=known_time(known_at)
    row=conn.execute('SELECT * FROM erp_creditos WHERE id_comunidad=? AND id=? AND effective_on<=? AND registered_at<=?',
                     (community_id,credit_id,effective_at,known_at)).fetchone()
    if row is None:raise NotFoundError('El credito no existe en este ambito y fecha.')
    applied=_sum(conn,'erp_credito_aplicaciones',None,community_id,'credit_id',credit_id,effective_at,known_at,
                 'CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END')
    refunded=_sum(conn,'erp_reintegros',None,community_id,'credit_id',credit_id,effective_at,known_at)
    available=cents(row['amount_cents']-applied-refunded)
    if min(available,applied,refunded)<0:raise ContractError('Los movimientos superan el credito disponible.')
    return {'credit_id':credit_id,'original_cents':str(row['amount_cents']),'applied_cents':str(applied),
            'refunded_cents':str(refunded),'available_cents':str(available),'effective_at':effective_at,'known_at':known_at}


def opening_balance(conn,community_id,opening_id,effective_at=None,known_at=None):
    effective=day(effective_at or date.today().isoformat());known=known_time(known_at)
    row=conn.execute('SELECT * FROM erp_saldos_apertura WHERE id_comunidad=? AND id=? AND effective_on<=? AND registered_at<=?',(community_id,opening_id,effective,known)).fetchone()
    if not row:raise NotFoundError('La apertura no se conoce para ese corte.')
    movements=_sum(conn,'erp_apertura_movimientos',None,community_id,'opening_id',opening_id,effective,known,
                   'CASE WHEN reverses_id IS NULL THEN amount_cents ELSE -amount_cents END')
    available=abs(row['amount_cents'])-movements
    if min(available,movements)<0:raise ContractError('Los movimientos superan el saldo de apertura.')
    return {'opening_id':opening_id,'original_cents':str(row['amount_cents']),'moved_cents':str(movements),
            'remaining_cents':str(available if row['amount_cents']>=0 else -available),'cutoff_date':row['effective_on'],
            'quality':row['quality'],'effective_at':effective,'known_at':known}


def validate_timeline(conn, community_id, receipt_ids=(), collection_ids=(), credit_ids=(), opening_ids=()):
    """A backdated operation must not overdraw any later effective cutoff."""
    dates={date.today().isoformat()}
    for table in ('erp_imputaciones','erp_devoluciones','erp_devolucion_reversiones','erp_rectificaciones','erp_credito_aplicaciones','erp_reintegros','erp_reasignaciones_obligacion','erp_apertura_movimientos'):
        dates.update(row[0] for row in conn.execute(f'SELECT DISTINCT effective_on FROM {table} WHERE id_comunidad=?',(community_id,)))
    for receipt_id in set(receipt_ids):
        row=conn.execute('SELECT issued_on FROM erp_recibos WHERE id_comunidad=? AND id=?',(community_id,receipt_id)).fetchone()
        if row is None:raise NotFoundError('Recibo no encontrado.')
        for cutoff in sorted(dates|{row[0]}):
            if cutoff>=row[0]:
                receipt_balance(conn,community_id,receipt_id,cutoff)
                responsibility_balance(conn,community_id,receipt_id,cutoff)
    for collection_id in set(collection_ids):
        row=conn.execute('SELECT effective_on FROM erp_cobros WHERE id_comunidad=? AND id=?',(community_id,collection_id)).fetchone()
        if row is None:raise NotFoundError('Cobro no encontrado.')
        for cutoff in sorted(dates|{row[0]}):
            if cutoff>=row[0]:collection_balance(conn,community_id,collection_id,cutoff)
    for credit_id in set(credit_ids):
        row=conn.execute('SELECT effective_on FROM erp_creditos WHERE id_comunidad=? AND id=?',(community_id,credit_id)).fetchone()
        if row is None:raise NotFoundError('Credito no encontrado.')
        for cutoff in sorted(dates|{row[0]}):
            if cutoff>=row[0]:credit_balance(conn,community_id,credit_id,cutoff)
    for opening_id in set(opening_ids):
        row=conn.execute('SELECT effective_on FROM erp_saldos_apertura WHERE id_comunidad=? AND id=?',(community_id,opening_id)).fetchone()
        if not row:raise NotFoundError('Apertura no encontrada.')
        for cutoff in sorted(dates|{row[0]}):
            if cutoff>=row[0]:opening_balance(conn,community_id,opening_id,cutoff)
