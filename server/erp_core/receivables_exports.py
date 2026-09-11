"""Audited exports use the same projections and never executable spreadsheet cells."""

import base64
import csv
import hashlib
import io
import re
from pathlib import Path
import sys
from .contracts import QueryEnvelope
from .receivables_contracts import require_fields
from .errors import ContractError


def safe_cell(value):
    value='' if value is None else str(value)
    if re.fullmatch(r'-?\d+\.\d{2}',value):return value
    return "'"+value if value.lstrip().startswith(('=','+','-','@','\t','\r','\n')) or value.startswith(('\t','\r','\n')) else value


def euros(value):
    n=int(value)
    return ('-' if n<0 else '')+str(abs(n)//100)+'.'+str(abs(n)%100).zfill(2)


class ExportOperations:
    def export_prepare(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('kind','format','filters'))
            if p['kind'] not in ('receipts','statement') or p['format'] not in ('csv','xlsx'):
                raise ContractError('Selecciona recibos o deuda, en CSV o Excel.')
            if not isinstance(p['filters'],dict):raise ContractError('Filtros no validos.')
            f=self._financial_filters(p['filters'])
            issues=[]
            if p['kind']=='statement':
                query=QueryEnvelope.from_value({'query':'erp3.account.statement','id_comunidad':e.community_id,'filters':{**p['filters'],'known_at':f['known_at'],'effective_at':f['effective_at']}})
                data=self.account_statement(session,query,connection=conn,all_rows=True)
                issues=data['issues'];items=data['items']
                rows=[['Referencia','Propiedad','Obligados','Atribucion','Pendiente EUR','Vencimiento','Antiguedad','Origen','Calidad','Corte origen']]
                for r in items:rows.append([r['reference'],r['property'],r['obligated'],r['attribution'],euros(r['pending_cents']),r['due_on'],r['aging_bucket'],r['source'],r['quality'],r['cutoff_date']])
                total=data['documented_subtotal_cents']
            else:
                items=self._receipt_rows(conn,e.community_id,f)
                rows=[['Recibo','Propiedad','Concepto','Periodo desde','Periodo hasta','Emision','Vencimiento','Original EUR','Aplicado EUR','Reducido EUR','Pendiente EUR','Estado']]
                for r in items:
                    b=r['balance'];rows.append([r['number'],r['property_code'],r['description'],r['period_from'],r['period_until'],r['issued_on'],r['due_on'],euros(b['original_cents']),euros(b['paid_cents']),euros(b['reduced_cents']),euros(b['pending_cents']),b['state']])
                total=str(sum(int(r['balance']['pending_cents']) for r in items))
            if len(items)>20000:raise ContractError('La seleccion supera 20.000 filas. Acota los filtros antes de exportar.')
            metadata=[['Comunidad',str(e.community_id)],['Fecha efectiva',f['effective_at']],['Conocido hasta',f['known_at']],
                ['Filas',str(len(items))],['Subtotal documentado EUR',euros(total)],
                ['Alcance','Todas las paginas de la seleccion; sin compensacion automatica'],
                ['Advertencia','Los saldos observados no equivalen a historia certificada ni acreditan por si solos responsabilidad personal.']]
            metadata.extend(['Incidencia',i.get('message',str(i))] for i in issues)
            if p['format']=='csv':
                stream=io.StringIO(newline='');writer=csv.writer(stream,delimiter=';')
                writer.writerows([[safe_cell(c) for c in row] for row in metadata+[[]]+rows])
                content=stream.getvalue().encode('utf-8-sig');mime='text/csv;charset=utf-8'
            else:
                vendor = Path(__file__).resolve().parents[1] / '_python_packages'
                if vendor.is_dir() and str(vendor) not in sys.path:
                    sys.path.insert(0, str(vendor))
                from openpyxl import Workbook
                book=Workbook();sheet=book.active;sheet.title='Datos';info=book.create_sheet('Origen y alcance')
                for target,values in ((sheet,rows),(info,metadata)):
                    for row in values:target.append([safe_cell(c) for c in row])
                    target.freeze_panes='A2'
                    for col in target.columns:target.column_dimensions[col[0].column_letter].width=24
                sheet.auto_filter.ref=sheet.dimensions
                stream=io.BytesIO();book.save(stream);content=stream.getvalue()
                mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            if len(content)>12*1024*1024:raise ContractError('Exportacion demasiado grande. Acota la seleccion.')
            return {'file_name':f"{p['kind']}-{e.community_id}-{f['effective_at']}.{p['format']}",
                'mime':mime,'content_base64':base64.b64encode(content).decode('ascii'),
                'sha256':hashlib.sha256(content).hexdigest(),'row_count':len(items),'filters':f,
                'issues':issues,'subtotal_cents':total,'economic_changes':False}
        return self._write(session,env,op,'sensitive_read',audit_projection=lambda r:{k:v for k,v in r.items() if k!='content_base64'})
