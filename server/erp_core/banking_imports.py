"""Observed banking sources. Importing an IBAN never activates a mandate."""

import base64
from dataclasses import replace

from .errors import ContractError, ConflictError, NotFoundError
from .receivables_contracts import require_fields, identity, day, text


class BankingImports:
    def import_analyze(self,session,env):
        def op(conn,actor,e,now):
            from .banking_tabular import parse_workbook,masked_cell
            p=require_fields(e.payload,('file_base64','filename'),('sheet_index',))
            text(p['filename'],'Nombre del archivo',maximum=250)
            parsed=parse_workbook(p['file_base64'],p['filename'],p.get('sheet_index',0))
            source=self.vault.put(conn,e.community_id,'banking-workbook',{'file':p,'parsed':parsed,**self._evidence_value(e)},now)
            return {'source_id':source,'sheets':[{'index':i,'label':masked_cell(s)} for i,s in enumerate(parsed['sheets'])],
                'sheet_index':parsed['sheet_index'],'columns':[{'index':i,'label':masked_cell(name),
                    'sample':masked_cell(parsed['rows'][0]['values'][i]) if i<len(parsed['rows'][0]['values']) else ''} for i,name in enumerate(parsed['headers'])],
                'row_count':len(parsed['rows'])}
        return self._write(session,env,'manage_accounts',op)

    def import_file_preview(self,session,env):
        from .database import connect
        p=require_fields(env.payload,('source_id','mapping','source','cutoff'))
        mapping=require_fields(p['mapping'],('iban',),('alias','observed_mandate_reference','observed_property_reference','observed_payer_reference'))
        conn=connect(self.database_path,readonly=True)
        try:
            self._session(conn,session,env.community_id,'manage_accounts')
            source=self.vault.get(conn,env.community_id,p['source_id'],'banking-workbook')
        finally:conn.close()
        parsed=source['parsed']
        if any(type(index) is not int or not 0<=index<len(parsed['headers']) for index in mapping.values()) or len(set(mapping.values()))!=len(mapping):
            raise ContractError('Revisa el mapeo de columnas; no repitas ni inventes correspondencias.')
        rows=[{key:item['values'][index] if index<len(item['values']) else '' for key,index in mapping.items()} for item in parsed['rows']]
        # The existing import owns validation, staging and idempotence, including the original file.
        return self.import_preview(session,replace(env,payload={'source':p['source'],'cutoff':p['cutoff'],'rows':rows,
            'file_base64':source['file']['file_base64'],'filename':source['file']['filename']}))

    def import_preview(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('source','cutoff','rows'),('file_base64','filename'))
            text(p['source'],'Origen',maximum=200)
            day(p['cutoff'])
            if not isinstance(p['rows'],list) or not 1<=len(p['rows'])<=1000:
                raise ContractError('Revisa entre 1 y 1000 filas por importacion.')
            if p.get('file_base64'):
                if not isinstance(p['file_base64'],str) or len(p['file_base64'])>24*1024*1024:
                    raise ContractError('Archivo demasiado grande.')
                try:base64.b64decode(p['file_base64'],validate=True)
                except Exception:raise ContractError('Archivo de origen no valido.') from None
            hashes=self.vault.fingerprints(e.community_id,'banking-import',p)
            for digest in hashes.values():
                previous=conn.execute('SELECT id,state,version FROM erp_banca_importaciones WHERE id_comunidad=? AND source_hash=?',
                    (e.community_id,digest)).fetchone()
                if previous:return dict(previous)
            source=self.vault.put(conn,e.community_id,'banking-import-source',{'source':p,**self._evidence_value(e)},now)
            iid=conn.execute('''INSERT INTO erp_banca_importaciones (id_comunidad,secret_id,source_hash,state,registered_at,actor_id)
                VALUES (?,?,?,'pendiente',?,?)''',(e.community_id,source,hashes[self.vault.active_index],now,actor.user_id)).lastrowid
            seen=set();items=[]
            from stdnum import iban
            for index,item in enumerate(p['rows'],1):
                require_fields(item,('iban',),('alias','observed_mandate_reference','observed_property_reference','observed_payer_reference'))
                errors=[];number=None
                try:number=iban.validate(text(item['iban'],'Cuenta',maximum=64))
                except Exception:errors.append('IBAN no valido; conserva el original para revision.')
                if number:
                    if number in seen:errors.append('Cuenta repetida en el archivo; selecciona una sola fila.')
                    seen.add(number)
                secret=self.vault.put(conn,e.community_id,'banking-import-row',{'original':item,'normalized_iban':number,
                    'issues':errors,'cutoff':p['cutoff']},now)
                conn.execute('''INSERT INTO erp_banca_importacion_filas
                    (id_comunidad,import_id,row_number,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?)''',
                    (e.community_id,iid,index,secret,now,actor.user_id))
                items.append({'row':index,'masked':number[:2]+'** **** ... '+number[-4:] if number else 'Sin verificar','issues':errors})
            return {'id':iid,'version':1,'state':'pendiente','items':items,'mandates_activated':False}
        return self._write(session,env,'manage_accounts',op)

    def import_get(self,session,query):
        def op(conn,q):
            require_fields(q.filters,('id',))
            row=conn.execute('SELECT * FROM erp_banca_importaciones WHERE id_comunidad=? AND id=?',(q.community_id,identity(q.filters['id']))).fetchone()
            if not row:raise NotFoundError('Importacion no disponible.')
            items=[]
            for item in conn.execute('SELECT * FROM erp_banca_importacion_filas WHERE id_comunidad=? AND import_id=? ORDER BY row_number',(q.community_id,row['id'])):
                original=self.vault.get(conn,q.community_id,item['secret_id'],'banking-import-row')
                number=original['normalized_iban']
                items.append({'row':item['row_number'],'account_id':item['account_id'],
                    'masked':number[:2]+'** **** ... '+number[-4:] if number else 'Sin verificar',
                    'issues':original['issues'],'cutoff':original['cutoff'],
                    'observed_mandate_pending':bool(original['original'].get('observed_mandate_reference'))})
            return {'id':row['id'],'version':row['version'],'state':row['state'],'items':items,'mandates_activated':False}
        return self._read(session,query,'manage_accounts',op)

    def import_confirm(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('id','rows','acknowledge_observed_mandates'))
            if p['acknowledge_observed_mandates'] is not True:
                raise ContractError('Confirma que importar cuentas no acredita mandatos ni instrucciones bancarias externas.')
            row=conn.execute('SELECT * FROM erp_banca_importaciones WHERE id_comunidad=? AND id=?',(e.community_id,identity(p['id']))).fetchone()
            if not row:raise NotFoundError('Importacion no disponible.')
            self._version(row,e.expected_version)
            if row['state']!='pendiente':raise ConflictError('La importacion ya se confirmo.')
            if not isinstance(p['rows'],list) or not p['rows'] or len(p['rows'])>1000:
                raise ContractError('Selecciona las filas revisadas que deseas confirmar.')
            numbers=[identity(n) for n in p['rows']]
            if len(numbers)!=len(set(numbers)):raise ContractError('Hay filas repetidas.')
            accounts=[]
            for n in numbers:
                item=conn.execute('SELECT * FROM erp_banca_importacion_filas WHERE id_comunidad=? AND import_id=? AND row_number=?',
                    (e.community_id,row['id'],n)).fetchone()
                if not item:raise ContractError('La fila no pertenece a esta importacion.')
                original=self.vault.get(conn,e.community_id,item['secret_id'],'banking-import-row')
                if original['issues']:raise ConflictError('Resuelve las incidencias de las filas seleccionadas antes de confirmar.')
                account=self._account_create(conn,actor,replace(e,payload={'iban':original['normalized_iban'],
                    'alias':original['original'].get('alias','')}),now)
                conn.execute('UPDATE erp_banca_importacion_filas SET account_id=? WHERE id_comunidad=? AND id=?',(account['id'],e.community_id,item['id']))
                accounts.append({'row':n,'account_id':account['id']})
            conn.execute("UPDATE erp_banca_importaciones SET state='confirmada',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,row['id']))
            return {'id':row['id'],'version':row['version']+1,'state':'confirmada','accounts':accounts,'mandates_activated':False}
        return self._write(session,env,'manage_accounts',op)
