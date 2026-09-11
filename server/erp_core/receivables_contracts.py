"""Strict ERP 3 primitives. Money shares the certified ERP 2 integer range."""

from datetime import date, datetime, timezone
import hashlib
import re

from .budget_contracts import Money
from .contracts import canonical_json
from .errors import ContractError


CONTRACT_VERSION = 'erp_receivables_v1'
CAPABILITIES = frozenset({
    'read', 'sensitive_read', 'prepare_emission', 'confirm_emission', 'record_collection',
    'allocate', 'reverse_allocation', 'return_collection', 'credit', 'void', 'adjust',
    'refund', 'claim', 'import_history', 'approve_opening', 'resolve_responsibility',
    'classify_uncollectible', 'transfer_responsibility', 'configure',
})


def cents(value, *, positive=False, nonnegative=False):
    result = Money.from_contract(value).cents
    if (positive and result <= 0) or (nonnegative and result < 0):
        raise ContractError('Importe fuera del intervalo permitido.')
    return result


def identity(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not re.fullmatch(r'[1-9]\d*', str(value)):
        raise ContractError('La referencia debe ser un identificador positivo.')
    return int(value)


def day(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ContractError('La fecha debe tener formato AAAA-MM-DD.')
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ContractError('Fecha no valida.') from exc


def known_time(value):
    if value is None:
        return datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
    if not isinstance(value, str):
        raise ContractError('La fecha de conocimiento requiere zona horaria.')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
    except ValueError as exc:
        raise ContractError('La fecha de conocimiento requiere zona horaria.') from exc


def text(value, name, *, required=True, maximum=2000):
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > maximum:
        raise ContractError(f'{name} no es valido.')
    return value.strip()


def fingerprint(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def require_fields(value, required, optional=()):
    if not isinstance(value, dict) or set(required)-value.keys() or value.keys()-set(required)-set(optional):
        raise ContractError('Campos incompletos o no admitidos en la operacion economica.')
    return value


def subject(value):
    require_fields(value, ('type', 'id'))
    if value['type'] not in ('owner', 'person'):
        raise ContractError('Tipo de sujeto no valido.')
    return {'type': value['type'], 'id': identity(value['id'])}
