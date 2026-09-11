"""Read-only, exact balance projections with effective and knowledge cutoffs."""

from datetime import date

from .errors import ContractError, NotFoundError
from .receivables_contracts import cents, day, known_time


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
    returned=_sum(conn,'erp_devoluciones',None,community_id,'collection_id',collection_id,effective_at,known_at)
    refunded=_sum(conn,'erp_reintegros',None,community_id,'collection_id',collection_id,effective_at,known_at)
    available=cents(int(row['amount_cents'])-applied-returned-refunded)
    if min(available,applied,returned,refunded)<0:
        raise ContractError('Los movimientos superan los fondos disponibles.')
    return {'collection_id':collection_id,'original_cents':str(row['amount_cents']),
            'applied_cents':str(applied),'returned_cents':str(returned),'refunded_cents':str(refunded),
            'available_cents':str(available),'currency':row['currency'],'effective_at':effective_at,'known_at':known_at}


def validate_timeline(conn, community_id, receipt_ids=(), collection_ids=()):
    """A backdated operation must not overdraw any later effective cutoff."""
    dates={date.today().isoformat()}
    for table in ('erp_imputaciones','erp_devoluciones','erp_rectificaciones','erp_credito_aplicaciones','erp_reintegros'):
        dates.update(row[0] for row in conn.execute(f'SELECT DISTINCT effective_on FROM {table} WHERE id_comunidad=?',(community_id,)))
    for receipt_id in set(receipt_ids):
        row=conn.execute('SELECT issued_on FROM erp_recibos WHERE id_comunidad=? AND id=?',(community_id,receipt_id)).fetchone()
        if row is None:raise NotFoundError('Recibo no encontrado.')
        for cutoff in sorted(dates|{row[0]}):
            if cutoff>=row[0]:receipt_balance(conn,community_id,receipt_id,cutoff)
    for collection_id in set(collection_ids):
        row=conn.execute('SELECT effective_on FROM erp_cobros WHERE id_comunidad=? AND id=?',(community_id,collection_id)).fetchone()
        if row is None:raise NotFoundError('Cobro no encontrado.')
        for cutoff in sorted(dates|{row[0]}):
            if cutoff>=row[0]:collection_balance(conn,community_id,collection_id,cutoff)
