"""Versioned, read-only statement adapters; all monetary normalization is exact."""

import base64
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import io
import re

from .banking_tabular import parse_workbook
from .errors import ContractError
from .receivables_contracts import cents, day
from .contracts import canonical_json

PROFILES = ('tabular-v1', 'cuaderno43-v1', 'camt.053.001.08', 'camt.054.001.08', 'manual-v1')


def amount(value, decimal_separator='.'):
    if not isinstance(value, str):
        raise ContractError('El importe debe conservarse como texto decimal.')
    value = value.strip().replace(' ', '')
    if decimal_separator not in ('.', ','):
        raise ContractError('Selecciona el separador decimal.')
    if decimal_separator == ',':
        value = value.replace('.', '').replace(',', '.')
    elif ',' in value:
        raise ContractError('Confirma el formato decimal de los importes.')
    if not re.fullmatch(r'[+-]?\d+(?:\.\d+)?', value):
        raise ContractError('Importe decimal no valido.')
    try:
        scaled = Decimal(value) * 100
        if not scaled.is_finite() or scaled != scaled.to_integral_value():
            raise ContractError('El importe contiene fracciones de centimo.')
        return str(cents(int(scaled)))
    except InvalidOperation:
        raise ContractError('Importe decimal no valido.') from None


def source_date(value, fmt='iso'):
    value = str(value).strip()
    try:
        if fmt == 'dmy':
            return datetime.strptime(value, '%d/%m/%Y').date().isoformat()
        if fmt == 'mdy':
            return datetime.strptime(value, '%m/%d/%Y').date().isoformat()
        return day(value[:10] if re.fullmatch(r'\d{4}-\d{2}-\d{2}(?:[ T].*)?', value) else value)
    except ValueError:
        raise ContractError('Fecha no valida; revisa su formato.') from None


def normalize(row):
    allowed = {'operation_on','value_on','amount_cents','currency','concept','counterparty','reference',
               'external_id','namespace','source_state','balance_cents','original','row_number'}
    if not isinstance(row, dict) or set(row) - allowed:
        raise ContractError('Campos de movimiento no admitidos.')
    result = dict(row)
    result['operation_on'] = day(result['operation_on'])
    result['value_on'] = day(result['value_on']) if result.get('value_on') else None
    result['amount_cents'] = str(cents(result['amount_cents']))
    if not int(result['amount_cents']):
        raise ContractError('Un movimiento debe tener importe distinto de cero.')
    if result.get('currency','EUR') != 'EUR':
        raise ContractError('La aplicacion de esta moneda no esta soportada.')
    result['currency'] = 'EUR'
    result['source_state'] = result.get('source_state','booked')
    if result['source_state'] not in ('booked','pending'):
        raise ContractError('Estado bancario no soportado.')
    for field in ('concept','counterparty','reference','external_id','namespace'):
        result[field] = str(result.get(field) or '')
        if len(result[field]) > 10000:
            raise ContractError('Texto de movimiento excesivo.')
    if result.get('balance_cents') is not None:
        result['balance_cents'] = str(cents(result['balance_cents']))
    return result


def tabular(encoded, filename, mapping=None, options=None):
    options = options or {};numeric_cells=set()
    if str(filename).lower().endswith('.xls'):
        import xlrd
        from xlrd.compdoc import CompDoc
        import struct
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > 16*1024*1024:
            raise ContractError('Archivo excesivo.')
        if raw[:8]==b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1':
            compound=CompDoc(raw,logfile=io.StringIO())
            if any('vba' in d.name.lower() or d.name.lower()=='macros' for d in compound.dirlist):
                raise ContractError('No se admiten macros en el libro.')
            biff=compound.get_named_stream('Workbook') or compound.get_named_stream('Book')
        else:biff=raw
        if not biff:raise ContractError('Libro XLS no valido.')
        offset=0
        while offset+4<=len(biff):
            record,size=struct.unpack_from('<HH',biff,offset);offset+=4
            if record in (0x0006,0x01AE,0x002F):raise ContractError('XLS con formulas, enlaces externos o cifrado no admitido. Exporta solo valores.')
            if offset+size>len(biff):raise ContractError('Registro XLS incompleto.')
            offset+=size
        book = xlrd.open_workbook(file_contents=raw,logfile=io.StringIO())
        sheet = book.sheet_by_index(options.get('sheet_index',0))
        if sheet.nrows > 1001 or sheet.ncols > 100:
            raise ContractError('Maximo 1.000 filas y 100 columnas.')
        def cell(cell):
            if cell.ctype == xlrd.XL_CELL_DATE:
                return xlrd.xldate_as_datetime(cell.value,book.datemode).date().isoformat()
            return str(cell.value)
        parsed = {'headers':[cell(c) for c in sheet.row(0)],'rows':[
            {'row':i+1,'values':[cell(c) for c in sheet.row(i)]} for i in range(1,sheet.nrows)]}
        numeric_cells={(i+1,j) for i in range(1,sheet.nrows) for j,c in enumerate(sheet.row(i)) if c.ctype==xlrd.XL_CELL_NUMBER}
    else:
        parsed = parse_workbook(encoded,filename,options.get('sheet_index',0))
        if str(filename).lower().endswith('.xlsx'):
            import openpyxl
            book=openpyxl.load_workbook(io.BytesIO(base64.b64decode(encoded,validate=True)),read_only=True,data_only=False,keep_links=False)
            try:
                sheet=book.worksheets[options.get('sheet_index',0)]
                numeric_cells={(i,j) for i,row in enumerate(sheet.iter_rows(),1) for j,c in enumerate(row)
                               if c.data_type=='n' and c.value is not None and not isinstance(c.value,bool)}
            finally:book.close()
    if mapping is None:
        return parsed
    if not isinstance(mapping,dict) or set(mapping)-{'operation_on','value_on','amount','debit','credit','currency',
            'concept','counterparty','reference','external_id','balance'}:
        raise ContractError('Mapeo de columnas no valido.')
    if 'operation_on' not in mapping or not ('amount' in mapping or ('debit' in mapping and 'credit' in mapping)):
        raise ContractError('Mapea fecha e importe, o columnas de cargos y abonos.')
    if any(type(i) is not int or not 0<=i<len(parsed['headers']) for i in mapping.values()):
        raise ContractError('Columna fuera del archivo.')
    rows=[];errors=[]
    for r in parsed['rows']:
        try:
            def value(key):
                i=mapping.get(key)
                return r['values'][i].strip() if i is not None and i<len(r['values']) else ''
            separator=options.get('decimal_separator','.')
            def number_value(key):return amount(value(key) or '0','.' if (r['row'],mapping.get(key)) in numeric_cells else separator)
            number=number_value('amount') if 'amount' in mapping else str(int(number_value('credit'))-int(number_value('debit')))
            rows.append(normalize({'operation_on':source_date(value('operation_on'),options.get('date_format','iso')),
                'value_on':source_date(value('value_on'),options.get('date_format','iso')) if value('value_on') else None,
                'amount_cents':number,'currency':value('currency') or 'EUR','concept':value('concept'),
                'counterparty':value('counterparty'),'reference':value('reference'),'external_id':value('external_id'),
                'namespace':options.get('namespace','tabular-v1'), 'row_number':r['row'],
                'balance_cents':number_value('balance') if value('balance') else None,'original':r['values']}))
        except (ContractError,ValueError) as e:
            errors.append({'row':r['row'],'error':str(e)})
    return {'rows':rows,'errors':errors,'headers':parsed['headers']}


def selected_block(blocks, options):
    if not blocks or len(blocks)>200:raise ContractError('Entre 1 y 200 bloques de cuenta por archivo.')
    index=(options or {}).get('block_index')
    if index is None:return None
    if type(index) is not int or not 0<=index<len(blocks):raise ContractError('Selecciona un bloque de cuenta valido.')
    return index


def xml_statement(raw, profile, options=None):
    from pathlib import Path
    from lxml import etree
    from .banking_adapter import parse_xml
    hashes={'camt.053.001.08':'338e9cb0c9989b5181802a7b773eece070d6815fc9d6483ac0579117bc24ccba',
            'camt.054.001.08':'13d220337d47e22cf25788807c136794a76955791df612c6947277272d440da6'}
    schema_bytes=(Path(__file__).parent/'banking_xsd'/(profile+'.xsd')).read_bytes()
    if hashlib.sha256(schema_bytes).hexdigest()!=hashes[profile]:raise ContractError('Esquema camt incompatible o alterado.')
    root=parse_xml(raw)
    ns='urn:iso:std:iso:20022:tech:xsd:'+profile
    if root.tag != '{'+ns+'}Document':
        raise ContractError('Version XML no soportada.')
    if not etree.XMLSchema(parse_xml(schema_bytes)).validate(root):raise ContractError('El XML no cumple el esquema del perfil camt seleccionado.')
    n={'n':ns}
    def find(node,path):return node.findtext(path,default='',namespaces=n)
    blocks=root.findall('.//n:Stmt',n) if profile.startswith('camt.053') else root.findall('.//n:Ntfctn',n)
    manifest=[{'index':i,'label':'Cuenta ****'+find(b,'n:Acct/n:Id/n:IBAN')[-4:]+' · Bloque '+str(i+1)} for i,b in enumerate(blocks)]
    index=selected_block(blocks,options)
    if index is None and len(blocks)>1:return {'rows':[],'errors':[],'blocks':manifest,'requires_block':True}
    index=0 if index is None else index
    block=blocks[index];rows=[]
    for i,entry in enumerate(block.findall('n:Ntry',n)):
        a=entry.find('n:Amt',n)
        if a is None or a.attrib.get('Ccy')!='EUR':
            raise ContractError('Moneda o importe XML no soportado.')
        sign=find(entry,'n:CdtDbtInd')
        if sign not in ('CRDT','DBIT'):
            raise ContractError('Signo XML desconocido.')
        status=find(entry,'n:Sts/n:Cd') or find(entry,'n:Sts')
        if status not in ('BOOK','PDNG'):
            raise ContractError('Estado XML no soportado.')
        details=entry.findall('n:NtryDtls/n:TxDtls',n)
        if len(rows)>=1000 or len(details)>1000:raise ContractError('Maximo 1.000 apuntes o detalles por entrada.')
        detail_amounts=[]
        for detail in details:
            value=detail.find('n:Amt',n)
            if value is None:value=detail.find('n:AmtDtls/n:TxAmt/n:Amt',n)
            if value is not None:
                if value.attrib.get('Ccy')!='EUR':raise ContractError('Moneda de detalle XML distinta.')
                detail_sign=find(detail,'n:CdtDbtInd') or sign
                if detail_sign not in ('CRDT','DBIT'):raise ContractError('Signo de detalle XML desconocido.')
                detail_amounts.append(int(amount(value.text))*(1 if detail_sign=='CRDT' else -1))
        if details and len(detail_amounts)==len(details) and sum(detail_amounts)!=int(amount(a.text))*(1 if sign=='CRDT' else -1):
            raise ContractError('El detalle XML no cuadra con el apunte agregado.')
        rows.append(normalize({'operation_on':find(entry,'n:BookgDt/n:Dt') or find(entry,'n:BookgDt/n:DtTm')[:10],
            'value_on':find(entry,'n:ValDt/n:Dt') or find(entry,'n:ValDt/n:DtTm')[:10] or None,
            'amount_cents':str(int(amount(a.text))*(1 if sign=='CRDT' else -1)),
            'concept':' | '.join(find(d,'n:RmtInf/n:Ustrd') for d in details) or find(entry,'n:AddtlNtryInf'),
            'reference':find(entry,'n:NtryRef'), 'external_id':find(entry,'n:AcctSvcrRef'),
            'namespace':profile,'source_state':'booked' if status=='BOOK' else 'pending',
            'row_number':i+1,'original':etree.tostring(entry,encoding='unicode')}))
    balances={}
    for bal in block.findall('n:Bal',n):
        code=find(bal,'n:Tp/n:CdOrPrtry/n:Cd');amt=bal.find('n:Amt',n)
        if code in ('OPBD','CLBD') and amt is not None:
            balances[code]={'amount_cents':str(int(amount(amt.text))*(1 if find(bal,'n:CdtDbtInd')=='CRDT' else -1)),
                'on':find(bal,'n:Dt/n:Dt')}
    coverage=None
    if 'OPBD' in balances and 'CLBD' in balances:
        interval_from=find(block,'n:FrToDt/n:FrDtTm');interval_to=find(block,'n:FrToDt/n:ToDtTm')
        start=interval_from[:10];end=interval_to[:10];whole_days=False
        if interval_from and interval_to:
            beginning=datetime.fromisoformat(interval_from.replace('Z','+00:00'));ending=datetime.fromisoformat(interval_to.replace('Z','+00:00'))
            if beginning.utcoffset()==ending.utcoffset() and beginning.time().replace(tzinfo=None).isoformat()=='00:00:00':
                if ending.time().replace(tzinfo=None).isoformat()=='00:00:00' and ending.date()>beginning.date():
                    end=(ending.date()-timedelta(days=1)).isoformat();whole_days=True
                elif ending.time().replace(tzinfo=None).isoformat()=='23:59:59':whole_days=True
        coverage={'start_on':start or balances['OPBD']['on'],'end_on':end or balances['CLBD']['on'],
            'opening_cents':balances['OPBD']['amount_cents'],'closing_cents':balances['CLBD']['amount_cents'],
            'balance_type':'booked','complete':bool(profile.startswith('camt.053') and whole_days),
            'interval_from':interval_from or None,'interval_to':interval_to or None}
    return {'rows':rows,'errors':[],'account_iban':find(block,'n:Acct/n:Id/n:IBAN'), 'coverage':coverage,
            'blocks':manifest,'block_index':index}


def norm43(raw, options):
    lines=raw.decode(options.get('encoding','latin-1')).splitlines()
    if any(len(line)!=80 for line in lines):raise ContractError('Cuaderno 43: registros de 80 caracteres requeridos.')
    blocks=[];current=[]
    for line in lines:
        kind=line[:2]
        if kind=='11':
            if current:raise ContractError('Cuaderno 43: falta cierre del bloque anterior.')
            current=[line]
        elif kind=='88':
            if current:raise ContractError('Cuaderno 43: cierre de archivo dentro de un bloque.')
        else:
            if not current:raise ContractError('Cuaderno 43: registro fuera de un bloque de cuenta.')
            current.append(line)
            if kind=='33':blocks.append(current);current=[]
    if current:raise ContractError('Cuaderno 43 incompleto.')
    manifest=[{'index':i,'label':'Cuenta ****'+b[0][16:20]+' · Bloque '+str(i+1)} for i,b in enumerate(blocks)]
    index=selected_block(blocks,options)
    if index is None and len(blocks)>1:return {'rows':[],'errors':[],'blocks':manifest,'requires_block':True}
    index=0 if index is None else index
    result=norm43_block(('\n'.join(blocks[index])).encode(options.get('encoding','latin-1')),options)
    return {**result,'blocks':manifest,'block_index':index}


def norm43_block(raw, options):
    lines=raw.decode(options.get('encoding','latin-1')).splitlines();rows=[];head=None;tail=None
    for i,line in enumerate(lines):
        if len(line)!=80:
            raise ContractError('Cuaderno 43: registros de 80 caracteres requeridos.')
        kind=line[:2]
        if kind=='11':
            if head is not None:raise ContractError('Importa una cuenta por bloque Cuaderno 43.')
            head=line
        elif kind=='22':
            if head is None:raise ContractError('Cuaderno 43 sin cabecera.')
            if tail is not None or len(rows)>=1000:raise ContractError('Bloque Cuaderno 43 terminado o excesivo.')
            def d(value):return datetime.strptime(value,'%y%m%d').date().isoformat()
            if line[27] not in ('1','2'):raise ContractError('Signo Cuaderno 43 desconocido.')
            rows.append(normalize({'operation_on':d(line[10:16]),'value_on':d(line[16:22]),
                'amount_cents':str(int(line[28:42])*(-1 if line[27]=='1' else 1)),
                'concept':line[22:27],'reference':line[52:80].strip(), 'row_number':i+1,
                'namespace':'cuaderno43-v1','original':line}))
        elif kind=='23':
            if not rows:raise ContractError('Concepto sin movimiento.')
            rows[-1]['concept']+=' '+line[4:80].strip()
            rows[-1]['original']+='\n'+line
        elif kind=='33':
            if tail is not None:raise ContractError('Doble cierre Cuaderno 43.')
            tail=line
        elif kind not in ('88',):raise ContractError('Registro Cuaderno 43 no soportado.')
    if head is None or tail is None:raise ContractError('Cuaderno 43 incompleto.')
    debit=sum(-int(r['amount_cents']) for r in rows if int(r['amount_cents'])<0)
    credit=sum(int(r['amount_cents']) for r in rows if int(r['amount_cents'])>0)
    if debit!=int(tail[25:39]) or credit!=int(tail[44:58]):
        raise ContractError('Totales Cuaderno 43 no coinciden.')
    if head[2:20]!=tail[2:20] or head[47:50]!='978' or tail[73:76]!='978':
        raise ContractError('Cuenta o moneda Cuaderno 43 incompatible.')
    if int(tail[20:25])!=sum(int(r['amount_cents'])<0 for r in rows) or int(tail[39:44])!=sum(int(r['amount_cents'])>0 for r in rows):
        raise ContractError('Recuento Cuaderno 43 no coincide.')
    opening=int(head[33:47])*(-1 if head[32]=='1' else 1)
    closing=int(tail[59:73])*(-1 if tail[58]=='1' else 1)
    if opening+credit-debit!=closing:raise ContractError('Saldo Cuaderno 43 no cuadra.')
    return {'rows':rows,'errors':[],'account_ccc':head[2:20],
        'coverage':{'start_on':datetime.strptime(head[20:26],'%y%m%d').date().isoformat(),
            'end_on':datetime.strptime(head[26:32],'%y%m%d').date().isoformat(),
            'opening_cents':str(opening),'closing_cents':str(closing),'complete':True,'balance_type':'booked'}}


def decode_file(encoded):
    try:raw=base64.b64decode(encoded,validate=True)
    except Exception:raise ContractError('Archivo no valido.') from None
    if not raw or len(raw)>16*1024*1024:raise ContractError('Archivo vacio o excesivo.')
    return raw


def parse(payload):
    profile=payload.get('profile','manual-v1')
    if profile not in PROFILES:raise ContractError('Adaptador no soportado.')
    if profile=='manual-v1':
        rows=payload.get('rows')
        if not isinstance(rows,list) or not 1<=len(rows)<=1000:raise ContractError('Entre 1 y 1.000 movimientos.')
        result={'rows':[],'errors':[]}
        for i,r in enumerate(rows):
            try:result['rows'].append(normalize({**r,'row_number':i+1}))
            except (ContractError,KeyError) as e:result['errors'].append({'row':i+1,'error':str(e)})
        raw=canonical_json(rows).encode()
    else:
        raw=decode_file(payload.get('content_base64'))
        if profile=='tabular-v1':result=tabular(payload['content_base64'],payload['filename'],payload.get('mapping'),payload.get('options'))
        elif profile=='cuaderno43-v1':result=norm43(raw,payload.get('options') or {})
        else:result=xml_statement(raw,profile,payload.get('options') or {})
    file_hash=hashlib.sha256(raw).hexdigest()
    source_hash=hashlib.sha256(canonical_json({'file_hash':file_hash,'profile':profile,'block_index':result['block_index']}).encode()).hexdigest() if len(result.get('blocks',[]))>1 and not result.get('requires_block') else file_hash
    return {**result,'profile':profile,'source_hash':source_hash,'file_hash':file_hash}
