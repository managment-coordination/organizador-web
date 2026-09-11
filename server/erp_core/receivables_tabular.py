"""Strict tabular boundary: exact amounts and community-scoped, unambiguous keys."""

from datetime import datetime
from decimal import Decimal, InvalidOperation
import re

from .errors import ContractError
from .receivables_contracts import cents, day


FIELDS = {'reference', 'amount', 'property_code', 'owner_code', 'cutoff_date',
          'coverage_from', 'coverage_until', 'scope', 'limitations', 'legacy_receipt_ids'}


def money_text(value):
    if not isinstance(value, str):
        raise ContractError('El importe debe conservarse como texto del archivo.')
    value = value.strip().replace('\u00a0', '').replace(' ', '').removesuffix('EUR').removesuffix('\u20ac')
    if ',' in value:
        if not re.fullmatch(r'-?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}', value):
            raise ContractError('Importe ambiguo o con mas de dos decimales.')
        value = value.replace('.', '').replace(',', '.')
    if not re.fullmatch(r'-?\d+(?:\.\d{1,2})?', value):
        raise ContractError('Importe ambiguo o con mas de dos decimales.')
    try:
        return str(cents(int(Decimal(value) * 100)))
    except (InvalidOperation, ValueError):
        raise ContractError('Importe no valido.') from None


def date_text(value):
    value = str(value or '').strip()
    if re.fullmatch(r'\d{2}/\d{2}/\d{4}', value):
        try:
            return datetime.strptime(value, '%d/%m/%Y').date().isoformat()
        except ValueError:
            raise ContractError('Fecha no valida.') from None
    return day(value)


def normalize_rows(conn, community, rows, mapping, defaults):
    if not isinstance(mapping, dict) or set(mapping.values()) - FIELDS - {''}:
        raise ContractError('El mapeo contiene campos no admitidos.')
    selected = [v for v in mapping.values() if v]
    if len(selected) != len(set(selected)) or not {'reference', 'amount'} <= set(selected):
        raise ContractError('Relaciona referencia e importe, sin duplicar destinos.')
    allowed_defaults = {'cutoff_date', 'coverage_from', 'coverage_until', 'scope', 'limitations', 'attribution_confirmed'}
    if not isinstance(defaults, dict) or set(defaults) - allowed_defaults:
        raise ContractError('Configuracion de importacion no admitida.')
    if not isinstance(rows, list) or not 1 <= len(rows) <= 500:
        raise ContractError('Revisa archivos de entre 1 y 500 filas.')
    result = []
    for index, source in enumerate(rows, 1):
        values = source.get('values', {})
        row = {**defaults, **{dest: str(values.get(header, '')).strip()
                            for header, dest in mapping.items() if dest and str(values.get(header, '')).strip()}}
        original = {'row_number': source.get('rowNumber', index), 'cells': values}
        try:
            row['amount_cents'] = money_text(row.pop('amount', ''))
            for field in ('cutoff_date', 'coverage_from', 'coverage_until'):
                row[field] = date_text(row.get(field))
            for field, table, code, key, destination in (
                ('property_code', 'cf_propiedades', 'codigo_propiedad', 'id_propiedad', 'property_id'),
                ('owner_code', 'cf_propietarios', 'codigo_netfincas', 'id_propietario', 'owner_id'),
            ):
                value = row.pop(field, '')
                if not value:
                    continue
                matches = list(conn.execute(f'SELECT {key} FROM {table} WHERE id_comunidad=? AND {code}=?', (community, value)))
                if len(matches) != 1:
                    raise ContractError('Codigo inexistente o no unico en esta comunidad: ' + value)
                row[destination] = matches[0][0]
            if row.get('legacy_receipt_ids'):
                refs = row['legacy_receipt_ids'].split(';')
                if not all(re.fullmatch(r'[1-9]\d*', r.strip()) for r in refs):
                    raise ContractError('Las referencias historicas deben ser identificadores separados por punto y coma.')
                row['legacy_receipt_ids'] = [int(r.strip()) for r in refs]
            row['original'] = original
            result.append(row)
        except ContractError as error:
            # The staging layer preserves an explicit row issue without inventing a value.
            result.append({'reference': row.get('reference', ''), 'original': original, '_tabular_issue': str(error)})
    return result
