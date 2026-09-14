"""Pure, versioned CORE adapter. No database, network or economic side effects."""

from datetime import date, datetime, timedelta
import hashlib
from pathlib import Path
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from lxml import etree
from stdnum import iban

from .errors import ContractError
from .receivables_contracts import cents, day, require_fields, text


PROFILE_ID = 'core-2025-v1.1-pain008v08'
ENGINE_VERSION = 'core-xml-1'
NS = 'urn:iso:std:iso:20022:tech:xsd:pain.008.001.08'
STATUS_NS = 'urn:iso:std:iso:20022:tech:xsd:pain.002.001.10'
SCHEMAS = {
    'pain.008.001.08': '7edf4e4ce34c47a5567af6a327e22af4ed4007f715822af9f353c94ecc10f5ba',
    'pain.002.001.10': '2f9f8d0e9891fa9f31ccf0576397afe501614384d688ae6e43ba694b3d24b0cf',
}


def parse_xml(data):
    if not isinstance(data, bytes) or not data or len(data) > 16 * 1024 * 1024:
        raise ContractError('El archivo XML no es valido o supera el limite permitido.')
    try:
        parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False,
                                 huge_tree=False, recover=False)
        root = etree.fromstring(data, parser)
        if root.getroottree().docinfo.doctype:
            raise ValueError('DTD')
        count = 0
        pending = [(root, 1)]
        while pending:
            element, depth = pending.pop()
            count += 1
            if depth > 32 or count > 200000 or not isinstance(element.tag, str):
                raise ValueError('XML limit')
            pending.extend((child, depth + 1) for child in element)
        return root
    except (etree.XMLSyntaxError, ValueError, TypeError):
        raise ContractError('XML no admitido. No se permiten entidades, DTD ni estructuras excesivas.') from None


def validate_xml(data, schema_name):
    if schema_name not in SCHEMAS:
        raise ContractError('Formato bancario no registrado.')
    raw = (Path(__file__).parent / 'banking_xsd' / (schema_name + '.xsd')).read_bytes()
    if hashlib.sha256(raw).hexdigest() != SCHEMAS[schema_name]:
        raise ContractError('La integridad del esquema bancario no es correcta.')
    schema = etree.XMLSchema(parse_xml(raw))
    root = parse_xml(data)
    if not schema.validate(root):
        # The lxml error log may include IBAN or original document values.
        raise ContractError('El archivo no cumple el esquema bancario seleccionado.')
    return root


def amount(value):
    integer = cents(value, positive=True)
    return f'{integer // 100}.{integer % 100:02d}'


def profile_config(value):
    require_fields(value, ('bank_name', 'timezone', 'cutoff', 'lead_business_days', 'holidays',
                          'countries', 'max_lines', 'max_total_cents', 'recurrent_sequence', 'mode',
                          'bank_profile_accepted', 'external_instructions_reviewed'), ('ascii_only','allow_failed_oneoff_retry'))
    text(value['bank_name'], 'Entidad bancaria', maximum=100)
    try:
        ZoneInfo(value['timezone'])
    except (ZoneInfoNotFoundError, TypeError, ValueError):
        raise ContractError('Zona horaria no disponible.') from None
    if not isinstance(value['cutoff'], str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value['cutoff']):
        raise ContractError('Hora de corte no valida.')
    if type(value['lead_business_days']) is not int or not 1 <= value['lead_business_days'] <= 30:
        raise ContractError('Plazo de presentacion no valido.')
    if type(value['max_lines']) is not int or not 1 <= value['max_lines'] <= 10000:
        raise ContractError('Limite de lineas no valido.')
    cents(value['max_total_cents'], positive=True)
    if not isinstance(value['holidays'], list) or len(value['holidays']) > 2000:
        raise ContractError('Calendario no valido.')
    for d in value['holidays']:
        day(d)
    if not isinstance(value['countries'], list) or not value['countries'] or len(value['countries']) > 100:
        raise ContractError('Indica los paises admitidos por el perfil contratado.')
    if any(not isinstance(c, str) or not re.fullmatch(r'[A-Z]{2}', c) for c in value['countries']):
        raise ContractError('Pais no valido en el perfil.')
    if value['recurrent_sequence'] not in ('RCUR', 'FRST_THEN_RCUR') or value['mode'] not in ('test', 'live'):
        raise ContractError('Secuencia o modo bancario no validos.')
    for flag in ('bank_profile_accepted', 'external_instructions_reviewed'):
        if type(value[flag]) is not bool:
            raise ContractError('Confirma la configuracion bancaria.')
    for option in ('ascii_only','allow_failed_oneoff_retry'):
        if option in value and type(value[option]) is not bool:
            raise ContractError('Configuracion opcional no valida.')
    if value['mode'] == 'live' and not (value['bank_profile_accepted'] and value['external_instructions_reviewed']):
        raise ContractError('El uso real requiere perfil bancario aceptado y revision de remesas externas.')
    return dict(value)


def validate_schedule(config, requested_on, now):
    requested = date.fromisoformat(day(requested_on))
    timestamp = datetime.fromisoformat(now.replace('Z', '+00:00'))
    if timestamp.tzinfo is None:
        raise ContractError('Falta zona horaria para comprobar el corte bancario.')
    local = timestamp.astimezone(ZoneInfo(config['timezone']))
    holidays = set(config['holidays'])

    def business(d):
        return d.weekday() < 5 and d.isoformat() not in holidays

    earliest = local.date()
    if not business(earliest) or local.strftime('%H:%M') >= config['cutoff']:
        earliest += timedelta(days=1)
        while not business(earliest):
            earliest += timedelta(days=1)
    for _ in range(config['lead_business_days']):
        earliest += timedelta(days=1)
        while not business(earliest):
            earliest += timedelta(days=1)
    if not business(requested) or requested < earliest:
        raise ContractError('La fecha de cargo incumple el calendario o corte. Primera fecha posible: ' + earliest.isoformat())


def _label(value, label, maximum, config):
    value = text(value, label, maximum=maximum)
    if any(ord(ch) < 32 or 0xD800 <= ord(ch) <= 0xDFFF for ch in value):
        raise ContractError('Caracteres no admitidos en ' + label + '.')
    if config.get('ascii_only') and any(ord(ch) > 126 for ch in value):
        raise ContractError('El perfil bancario requiere revisar los caracteres de ' + label + '.')
    return value


def build_core(snapshot, config):
    config = profile_config(config)
    require_fields(snapshot, ('message_id', 'created_at', 'requested_on', 'lines', 'profile_id'))
    if snapshot['profile_id'] != PROFILE_ID:
        raise ContractError('No hay adaptador para el perfil bancario seleccionado.')
    validate_schedule(config, snapshot['requested_on'], snapshot['created_at'])
    lines = snapshot['lines']
    if not isinstance(lines, list) or not 1 <= len(lines) <= config['max_lines']:
        raise ContractError('La remesa incumple el limite de lineas.')
    total = sum(cents(line['amount_cents'], positive=True) for line in lines)
    if total > cents(config['max_total_cents'], positive=True):
        raise ContractError('La remesa supera el importe permitido por el perfil.')
    references = [line['attempt_key'] for line in lines]
    if len(set(references)) != len(references):
        raise ContractError('Hay referencias de instruccion repetidas.')
    single_use = [(line['creditor']['creditor_identifier'].upper(), line['mandate']['rum'].upper())
                  for line in lines if line['kind'] == 'puntual']
    if len(single_use) != len(set(single_use)):
        raise ContractError('Un mandato puntual no puede generar varias instrucciones.')
    root = etree.Element('{' + NS + '}Document', nsmap={None: NS})

    def child(parent, name, value=None, **attrs):
        node = etree.SubElement(parent, '{' + NS + '}' + name, **attrs)
        if value is not None:
            node.text = str(value)
        return node

    def party(parent, name, value):
        node = child(parent, name)
        child(node, 'Nm', _label(value['name'], 'nombre', 70, config))
        address = value['address']
        require_fields(address, ('country', 'town'), ('street', 'building', 'postal_code'))
        _label(address['town'], 'localidad', 35, config)
        if not re.fullmatch(r'[A-Z]{2}', address['country']):
            raise ContractError('Falta un pais valido en la direccion bancaria.')
        postal = child(node, 'PstlAdr')
        for key, field, maximum in (('street', 'StrtNm', 70), ('building', 'BldgNb', 16),
                                    ('postal_code', 'PstCd', 16), ('town', 'TwnNm', 35), ('country', 'Ctry', 2)):
            if address.get(key):
                child(postal, field, _label(address[key], 'direccion', maximum, config))
        return node

    def bank_account(parent, name, number):
        try:
            number = iban.validate(number)
        except Exception:
            raise ContractError('Una cuenta del fichero no supera la validacion.') from None
        if number[:2] not in config['countries']:
            raise ContractError('Una cuenta pertenece a un pais no habilitado en el perfil.')
        child(child(child(parent, name), 'Id'), 'IBAN', number)

    def agent(parent, name):
        child(child(child(child(parent, name), 'FinInstnId'), 'Othr'), 'Id', 'NOTPROVIDED')

    document = child(root, 'CstmrDrctDbtInitn')
    header = child(document, 'GrpHdr')
    child(header, 'MsgId', _label(snapshot['message_id'], 'referencia de fichero', 35, config))
    child(header, 'CreDtTm', snapshot['created_at'])
    child(header, 'NbOfTxs', len(lines))
    child(header, 'CtrlSum', amount(total))
    child(child(header, 'InitgPty'), 'Nm', _label(lines[0]['creditor']['name'], 'iniciador', 70, config))
    groups = {}
    for line in lines:
        sequence = line['sequence']
        if sequence not in ('OOFF', 'FRST', 'RCUR') or (line['kind'] == 'puntual') != (sequence == 'OOFF'):
            raise ContractError('Secuencia incompatible con el mandato.')
        groups.setdefault(sequence, []).append(line)
    group_refs = []
    for index, (sequence, members) in enumerate(sorted(groups.items()), 1):
        pmt = child(document, 'PmtInf')
        group_ref = 'P' + hashlib.sha256((snapshot['message_id'] + ':' + str(index)).encode()).hexdigest()[:32].upper()
        group_refs.append({'id': group_ref, 'attempt_keys': [l['attempt_key'] for l in members]})
        child(pmt, 'PmtInfId', group_ref)
        child(pmt, 'PmtMtd', 'DD')
        child(pmt, 'BtchBookg', 'true')
        child(pmt, 'NbOfTxs', len(members))
        child(pmt, 'CtrlSum', amount(sum(cents(l['amount_cents'], positive=True) for l in members)))
        types = child(pmt, 'PmtTpInf')
        child(child(types, 'SvcLvl'), 'Cd', 'SEPA')
        child(child(types, 'LclInstrm'), 'Cd', 'CORE')
        child(types, 'SeqTp', sequence)
        child(pmt, 'ReqdColltnDt', day(snapshot['requested_on']))
        party(pmt, 'Cdtr', members[0]['creditor'])
        bank_account(pmt, 'CdtrAcct', members[0]['creditor_account']['iban'])
        agent(pmt, 'CdtrAgt')
        child(pmt, 'ChrgBr', 'SLEV')
        scheme = child(child(child(child(pmt, 'CdtrSchmeId'), 'Id'), 'PrvtId'), 'Othr')
        child(scheme, 'Id', members[0]['creditor']['creditor_identifier'])
        child(child(scheme, 'SchmeNm'), 'Prtry', 'SEPA')
        for line in members:
            if line['creditor'] != members[0]['creditor'] or line['creditor_account'] != members[0]['creditor_account']:
                raise ContractError('La remesa mezcla acreedores o cuentas.')
            tx = child(pmt, 'DrctDbtTxInf')
            child(child(tx, 'PmtId'), 'EndToEndId', _label(line['attempt_key'], 'referencia de instruccion', 35, config))
            child(tx, 'InstdAmt', amount(line['amount_cents']), Ccy='EUR')
            mandate = child(child(tx, 'DrctDbtTx'), 'MndtRltdInf')
            child(mandate, 'MndtId', _label(line['mandate']['rum'], 'referencia del mandato', 35, config))
            child(mandate, 'DtOfSgntr', day(line['signed_on']))
            amendment = line['mandate_details'].get('amendment', False)
            child(mandate, 'AmdmntInd', 'true' if amendment else 'false')
            if amendment:
                if not line.get('original_debtor_iban'):
                    raise ContractError('La modificacion de mandato necesita datos originales acreditados.')
                bank_account(child(mandate, 'AmdmntInfDtls'), 'OrgnlDbtrAcct', line['original_debtor_iban'])
            agent(tx, 'DbtrAgt')
            party(tx, 'Dbtr', {'name': line['mandate_details']['debtor_name'], 'address': line['mandate_details']['address']})
            bank_account(tx, 'DbtrAcct', line['payer_account']['iban'])
            child(child(tx, 'RmtInf'), 'Ustrd', _label(line['concept'], 'concepto bancario', 140, config))
    xml = etree.tostring(root, encoding='UTF-8', xml_declaration=True, pretty_print=False)
    validate_xml(xml, 'pain.008.001.08')
    return xml, {'profile_id': PROFILE_ID, 'engine_version': ENGINE_VERSION, 'schema_sha256': SCHEMAS['pain.008.001.08'],
                 'count': len(lines), 'total_cents': str(total), 'payment_groups': group_refs,
                 'sha256': hashlib.sha256(xml).hexdigest(), 'length': len(xml), 'mode': config['mode']}


def parse_status(data):
    """Technical statuses only: even ACSC needs separate settlement evidence."""
    root = validate_xml(data, 'pain.002.001.10')
    ns = {'p': STATUS_NS}
    report = root.find('p:CstmrPmtStsRpt', ns)
    if report is None:
        raise ContractError('El archivo no es un resultado bancario compatible.')
    group = report.find('p:OrgnlGrpInfAndSts', ns)
    if group is None:
        raise ContractError('Falta identificar el fichero al que responde el banco.')
    original = group.findtext('p:OrgnlMsgId', namespaces=ns)
    if group.findtext('p:OrgnlMsgNmId', namespaces=ns) != 'pain.008.001.08':
        raise ContractError('El resultado corresponde a otro tipo de fichero.')
    output = []

    def entry(node, scope, reference, status):
        reason = node.findtext('p:StsRsnInf/p:Rsn/p:Cd', namespaces=ns)
        effect = 'rejected' if status == 'RJCT' else 'technical' if status in ('ACCP', 'ACSP', 'ACSC', 'ACWC', 'ACTC') else 'pending'
        output.append({'scope': scope, 'reference': reference, 'status': status, 'reason_code': reason,
                       'type': effect, 'message_id': original})

    global_status = group.findtext('p:GrpSts', namespaces=ns)
    if global_status:
        entry(group, 'file', original, global_status)
    for pmt in report.findall('p:OrgnlPmtInfAndSts', ns):
        pmt_ref = pmt.findtext('p:OrgnlPmtInfId', namespaces=ns)
        pmt_status = pmt.findtext('p:PmtInfSts', namespaces=ns)
        if pmt_status:
            entry(pmt, 'group', pmt_ref, pmt_status)
        for tx in pmt.findall('p:TxInfAndSts', ns):
            entry(tx, 'line', tx.findtext('p:OrgnlEndToEndId', namespaces=ns), tx.findtext('p:TxSts', namespaces=ns))
    if not output or any(not row['reference'] or not row['status'] for row in output):
        raise ContractError('El resultado no identifica sus instrucciones o estados.')
    return {'source_sha256': hashlib.sha256(data).hexdigest(), 'original_message_id': original, 'entries': output}
