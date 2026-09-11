"""Reviewed historical openings, with source identities rather than guessed payments."""

import json
import re

from .contracts import canonical_json
from .errors import ConflictError, ContractError, NotFoundError
from .receivables_contracts import cents, day, fingerprint, identity, known_time, require_fields, text
from .receivables_tabular import normalize_rows


class HistoryOperations:
    def _history_row(self,conn,community,source,row):
        if row.get('_tabular_issue'):
            raise ContractError(text(row['_tabular_issue'],'Incidencia de la fila'))
        require_fields(row,('reference','amount_cents','cutoff_date','coverage_from','coverage_until','scope','limitations'),
                       ('property_id','owner_id','attribution_confirmed','legacy_receipt_ids','original'))
        reference=text(row['reference'],'Referencia estable de origen',maximum=200)
        amount=cents(row['amount_cents']);cutoff=day(row['cutoff_date']);start=day(row['coverage_from']);end=day(row['coverage_until'])
        if start>end or end>cutoff:raise ContractError('La cobertura historica debe finalizar como maximo en la fecha de corte.')
        if row['scope'] not in ('aggregate','receipt'):raise ContractError('Indica si la fuente es un saldo agregado o un recibo identificado.')
        pid=identity(row['property_id']) if row.get('property_id') else None
        owner=identity(row['owner_id']) if row.get('owner_id') else None
        if not pid and not owner:raise ContractError('Identifica una propiedad o un propietario acreditado.')
        if pid and not conn.execute('SELECT 1 FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?',(community,pid)).fetchone():
            raise NotFoundError('La propiedad no pertenece a esta comunidad.')
        if owner:
            self._subject(conn,community,{'type':'owner','id':owner})
            if row.get('attribution_confirmed') is not True:raise ConflictError('Confirma documentalmente la atribucion historica o deja el saldo sin propietario.')
        legacy=row.get('legacy_receipt_ids',[])
        if not isinstance(legacy,list) or len(legacy)!=len(set(legacy)):raise ContractError('Referencias historicas duplicadas o incompatibles.')
        legacy=[identity(i) for i in legacy]
        for rid in legacy:
            old=conn.execute('SELECT * FROM cf_recibos WHERE id_comunidad=? AND id_recibo=?',(community,rid)).fetchone()
            if not old or (pid and old['id_propiedad']!=pid):raise ContractError('El recibo historico no corresponde a la propiedad/comunidad seleccionada.')
        if row['scope']=='aggregate' and pid:
            old_ids={r[0] for r in conn.execute('''SELECT id_recibo FROM cf_recibos WHERE id_comunidad=? AND id_propiedad=?
                AND (fecha_emision IS NULL OR fecha_emision='' OR fecha_emision BETWEEN ? AND ?)''',(community,pid,start,end))}
            if old_ids-set(legacy):raise ConflictError('El saldo agregado se solapa con recibos historicos no incluidos en su cobertura.')
        if pid and conn.execute('''SELECT 1 FROM erp_recibos WHERE id_comunidad=? AND id_propiedad=?
            AND period_from<=? AND period_until>=?''',(community,pid,end,start)).fetchone():
            raise ConflictError('La apertura se solapa con recibos locales; no se permite duplicar saldo.')
        key=fingerprint({'source':source,'reference':reference})
        existing=conn.execute('SELECT * FROM erp_saldos_apertura WHERE id_comunidad=? AND coverage_key=?',(community,key)).fetchone()
        normalized={'reference':reference,'amount_cents':str(amount),'cutoff_date':cutoff,'coverage_from':start,'coverage_until':end,
            'scope':row['scope'],'limitations':text(row['limitations'],'Limitaciones de la fuente',maximum=4000),
            'property_id':pid,'owner_id':owner,'legacy_receipt_ids':sorted(legacy),'attribution_confirmed':bool(owner),
            'original':row.get('original')}
        if existing:
            original=json.loads(existing['source_json'])['normalized']
            if original!=normalized:raise ConflictError('La misma referencia contiene valores distintos. Requiere rectificacion, no reimportacion.')
            return {'decision':'skip','opening_id':existing['id'],'coverage_key':key,'normalized':normalized}
        if conn.execute('''SELECT 1 FROM erp_recibos_coberturas c
            LEFT JOIN erp_cobertura_activaciones a ON a.id_comunidad=c.id_comunidad AND a.coverage_id=c.id
            WHERE c.id_comunidad=? AND c.effective_from<=? AND c.effective_until>=?
                AND (c.authority='erp3' OR a.id IS NOT NULL)''',(community,end,start)).fetchone():
            raise ConflictError('El intervalo ya esta activado. No se anade otra fuente de saldo mediante importacion.')
        for other in conn.execute('SELECT * FROM erp_saldos_apertura WHERE id_comunidad=?',(community,)):
            data=json.loads(other['source_json']).get('normalized',{})
            if set(data.get('legacy_receipt_ids',[]))&set(legacy):raise ConflictError('Un recibo historico ya esta cubierto por otra apertura.')
            same_scope=(pid is not None and other['id_propiedad']==pid) or (pid is None and other['id_propiedad'] is None and other['owner_id']==owner)
            if same_scope and (row['scope']=='aggregate' or data.get('scope')=='aggregate') and data.get('coverage_from','0001-01-01')<=end and data.get('coverage_until','9999-12-31')>=start:
                raise ConflictError('Las coberturas de saldos agregados no pueden solaparse.')
        return {'decision':'create','coverage_key':key,'normalized':normalized}

    def history_import_preview(self,session,env):
        def op(conn,actor,e):
            p=require_fields(e.payload,('source','file_hash','file_name','rows'),('mapping','defaults','file_path','sheet'))
            p=dict(p)
            source=text(p['source'],'Sistema de origen',maximum=80);file_name=text(p['file_name'],'Nombre de archivo',maximum=250)
            if not isinstance(p['file_hash'],str) or not re.fullmatch('[0-9a-f]{64}',p['file_hash']):raise ContractError('El archivo requiere huella SHA-256.')
            if not isinstance(p['rows'],list) or not 1<=len(p['rows'])<=500:raise ContractError('Revisa sublotes de entre 1 y 500 filas.')
            raw_rows=p['rows']
            if 'mapping' in p:
                p['rows']=normalize_rows(conn,e.community_id,raw_rows,p['mapping'],p.get('defaults',{}))
            digest=fingerprint(p['rows'])
            existing=conn.execute('SELECT * FROM erp_importaciones_economicas WHERE id_comunidad=? AND source=? AND file_hash=?',(e.community_id,source,p['file_hash'])).fetchone()
            if existing:
                if json.loads(existing['source_json'])['rows_hash']==digest:
                    previous=[json.loads(r[0]) for r in conn.execute('SELECT preview_json FROM erp_importaciones_economicas_filas WHERE id_comunidad=? AND import_id=? ORDER BY row_number',(e.community_id,existing['id']))]
                    return {'id':existing['id'],'version':existing['version'],'state':existing['state'],'duplicate':True,
                            'rows':previous,'blocking_issues':sum(bool(r['issues']) for r in previous)}
                if existing['state']!='draft':raise ConflictError('El archivo ya esta confirmado con otro mapeo. No puede reescribirse.')
                self._version(dict(existing),e.expected_version)
            results=[];seen=set();legacy_seen=set();created=[]
            for index,row in enumerate(p['rows'],1):
                try:
                    item=self._history_row(conn,e.community_id,source,row)
                    if item['coverage_key'] in seen:raise ConflictError('Referencia repetida en el archivo.')
                    seen.add(item['coverage_key']);n=item['normalized'];ids=set(n['legacy_receipt_ids'])
                    if ids&legacy_seen:raise ConflictError('Un recibo aparece en mas de una fila del archivo.')
                    legacy_seen.update(ids)
                    for previous in created:
                        same_scope=(n['property_id'] is not None and n['property_id']==previous['property_id']) or (n['property_id'] is None and previous['property_id'] is None and n['owner_id']==previous['owner_id'])
                        if same_scope and 'aggregate' in (n['scope'],previous['scope']) and n['coverage_from']<=previous['coverage_until'] and n['coverage_until']>=previous['coverage_from']:
                            raise ConflictError('Coberturas agregadas solapadas dentro del archivo.')
                    created.append(n)
                    results.append({'row_number':index,**item,'issues':[]})
                except (ContractError,ConflictError,NotFoundError) as error:
                    results.append({'row_number':index,'decision':'review','issues':[str(error)]})
            now=known_time(None)
            metadata={'file_name':file_name,'rows_hash':digest,'file_path':p.get('file_path'),
                      'sheet':p.get('sheet'),'mapping':p.get('mapping'),'defaults':p.get('defaults'),
                      'raw_rows':raw_rows}
            before=None
            if existing:
                iid=existing['id'];version=existing['version']+1
                before={'source':json.loads(existing['source_json']),
                        'rows':[json.loads(r[0]) for r in conn.execute('SELECT preview_json FROM erp_importaciones_economicas_filas WHERE import_id=?',(iid,))]}
                conn.execute('DELETE FROM erp_importaciones_economicas_filas WHERE import_id=?',(iid,))
                conn.execute('UPDATE erp_importaciones_economicas SET source_json=?,version=? WHERE id=?',(canonical_json(metadata),version,iid))
            else:
                version=1
                iid=conn.execute('''INSERT INTO erp_importaciones_economicas
                (id_comunidad,source,file_hash,source_json,state,version,registered_at,actor_id) VALUES (?,?,?,?,'draft',1,?,?)''',
                (e.community_id,source,p['file_hash'],canonical_json(metadata),now,actor.user_id)).lastrowid
            for original,preview in zip(p['rows'],results):
                conn.execute('''INSERT INTO erp_importaciones_economicas_filas
                    (id_comunidad,import_id,row_number,source_key,original_json,preview_json,state) VALUES (?,?,?,?,?,?,?)''',
                    (e.community_id,iid,preview['row_number'],str(original.get('reference','')),canonical_json(original),canonical_json(preview),preview['decision']))
            return {'id':iid,'version':version,'state':'draft','before':before,'rows':results,'blocking_issues':sum(bool(r['issues']) for r in results),
                    'total_cents':str(cents(sum(int(r['normalized']['amount_cents']) for r in results if r['decision']=='create')))}
        return self._write(session,env,op,'import_history')

    def history_import_confirm(self,session,env):
        def op(conn,actor,e):
            require_fields(e.payload,('import_id',))
            self._session(conn,session,e.community_id,'approve_opening')
            self._evidence(e,required=True)
            imp=self._entity(conn,'erp_importaciones_economicas',e.community_id,e.payload['import_id']);self._version(imp,e.expected_version)
            if imp['state']!='draft':raise ConflictError('La importacion ya fue confirmada.')
            rows=list(conn.execute('SELECT * FROM erp_importaciones_economicas_filas WHERE id_comunidad=? AND import_id=? ORDER BY row_number',(e.community_id,imp['id'])))
            if any(r['state']=='review' for r in rows):raise ConflictError('Resuelve las incidencias del archivo antes de confirmar.')
            openings=[];events=[]
            for row in rows:
                previous=json.loads(row['preview_json']);current=self._history_row(conn,e.community_id,imp['source'],json.loads(row['original_json']))
                if current['decision']!=previous['decision'] or current.get('normalized')!=previous.get('normalized'):
                    raise ConflictError('La cobertura historica ha cambiado; vuelve a revisar la importacion.')
                if current['decision']=='skip':continue
                n=current['normalized'];source={'system':imp['source'],'file_hash':imp['file_hash'],'row_number':row['row_number'],
                    'import_id':imp['id'],'normalized':n,'original':json.loads(row['original_json'])}
                event,now=self._event(conn,actor,e,'erp3.opening.confirmed',n['cutoff_date'],source,str(row['id']))
                oid=conn.execute('''INSERT INTO erp_saldos_apertura
                    (id_comunidad,id_propiedad,owner_id,event_id,amount_cents,effective_on,registered_at,coverage_key,source_json,limitations,quality)
                    VALUES (?,?,?,?,?,?,?,?,?,?,'observada')''',(e.community_id,n['property_id'],n['owner_id'],event,int(n['amount_cents']),n['cutoff_date'],now,
                    current['coverage_key'],canonical_json(source),n['limitations'])).lastrowid
                conn.execute('''INSERT INTO erp_importaciones_economicas_vinculos
                    (id_comunidad,source,source_key,row_id,entity_type,entity_id) VALUES (?,?,?,?,'opening',?)''',
                    (e.community_id,imp['source'],n['reference'],row['id'],oid))
                openings.append(oid);events.append(event)
            conn.execute("UPDATE erp_importaciones_economicas SET state='confirmed',version=version+1 WHERE id=?",(imp['id'],))
            return {'id':imp['id'],'version':imp['version']+1,'opening_ids':openings,'event_ids':events,'invented_collections':False,'legacy_modified':False}
        return self._write(session,env,op,'import_history')

    def history_import_get(self,session,query):
        def op(conn,q):
            require_fields(q.filters,('import_id',))
            imp=self._entity(conn,'erp_importaciones_economicas',q.community_id,q.filters['import_id'])
            imp['rows']=[json.loads(r[0]) for r in conn.execute('SELECT preview_json FROM erp_importaciones_economicas_filas WHERE id_comunidad=? AND import_id=? ORDER BY row_number',(q.community_id,imp['id']))]
            return imp
        return self._read(session,query,op,'import_history')
