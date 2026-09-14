"""Protected storage extension of the existing imported-document catalogue."""

import base64
import hashlib
import uuid

from access_control import permission
from .audit import write_event
from .database import connect, write_transaction
from .errors import ContractError, NotFoundError
from .migrations import utc_now
from .receivables_contracts import identity, require_fields, text


class BankingDocuments:
    def document_upload(self,session,env):
        purposes={'mandate':'manage_mandates','account':'manage_accounts','creditor':'configure_creditor','result':'results'}
        purpose=env.payload.get('purpose')
        if purpose not in purposes:raise ContractError('Selecciona la finalidad del documento bancario.')
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('purpose','filename','data'))
            name=text(p['filename'],'Nombre de documento',maximum=200)
            if not isinstance(p['data'],str) or len(p['data'])>24*1024*1024:raise ContractError('Documento demasiado grande.')
            try:raw=base64.b64decode(p['data'],validate=True)
            except Exception:raise ContractError('Documento no valido.') from None
            if not raw or len(raw)>16*1024*1024:raise ContractError('Documento vacio o demasiado grande.')
            ext=('pdf' if raw.startswith(b'%PDF-') else 'png' if raw.startswith(b'\x89PNG\r\n\x1a\n') else
                 'jpg' if raw.startswith(b'\xff\xd8\xff') else None)
            if not ext:raise ContractError('Adjunta un PDF o una imagen PNG/JPEG. No se extrae ni ejecuta su contenido.')
            label='Documento bancario protegido.'+ext
            fingerprints=self.vault.fingerprints(e.community_id,'bank-document',{'data':p['data'],'purpose':purpose})
            for digest in fingerprints.values():
                old=conn.execute('SELECT document_id FROM erp_banca_documentos WHERE id_comunidad=? AND fingerprint=?',(e.community_id,digest)).fetchone()
                if old:return {'id':old[0],'version':1,'label':label,'protected':True}
            secret=self.vault.put(conn,e.community_id,'bank-document',{'filename':name,'data':p['data'],'extension':ext,
                'sha256':hashlib.sha256(raw).hexdigest(),**self._evidence_value(e)},now)
            # No filesystem path or extracted bank content enters the generic catalogue/RAG.
            did=conn.execute('''INSERT INTO documentos_importados
                (nombre_archivo,ruta_archivo,tipo_archivo,fecha_importacion,fecha_documento,asunto_documento,
                 texto_extraido,proyecto_sugerido,observaciones,usuario,pc,id_comunidad)
                VALUES (?,'','bancario_protegido',?,'','Documento bancario protegido','','','Acceso bancario restringido',?,'web',?)''',
                (label,now,str(actor.user_id),e.community_id)).lastrowid
            conn.execute('''INSERT INTO erp_banca_documentos
                (document_id,id_comunidad,secret_id,fingerprint,purpose,registered_at,actor_id) VALUES (?,?,?,?,?,?,?)''',
                (did,e.community_id,secret,fingerprints[self.vault.active_index],purpose,now,actor.user_id))
            return {'id':did,'version':1,'label':label,'protected':True}
        return self._write(session,env,purposes[purpose],op)

    def document_list(self,session,query):
        def op(conn,q):
            require_fields(q.filters,(),('offset','limit'))
            offset,limit=self._page(q.filters)
            rows=[dict(r) for r in conn.execute('''SELECT b.document_id AS id,d.nombre_archivo AS label,b.purpose,b.registered_at
                FROM erp_banca_documentos b JOIN documentos_importados d ON d.id_documento=b.document_id AND d.id_comunidad=b.id_comunidad
                WHERE b.id_comunidad=? ORDER BY b.document_id DESC LIMIT ? OFFSET ?''',(q.community_id,limit,offset))]
            return {'items':rows,'total':conn.execute('SELECT count(*) FROM erp_banca_documentos WHERE id_comunidad=?',(q.community_id,)).fetchone()[0]}
        return self._read(session,query,'read_masked',op)

    def document_download(self,session,community,document_id,reason):
        self._recent_auth(session)
        reason=text(reason,'Motivo de acceso al documento',maximum=1000)
        conn=connect(self.database_path)
        try:
            with write_transaction(conn):
                actor,current=self._session(conn,session,community,'export')
                self._session(conn,session,community,'reveal')
                if not permission(current,community,'puede_ver_documentos'):raise PermissionError('No tienes acceso a documentos.')
                row=conn.execute('SELECT * FROM erp_banca_documentos WHERE id_comunidad=? AND document_id=?',(community,identity(document_id))).fetchone()
                if not row:raise NotFoundError('Documento bancario no disponible.')
                data=self.vault.get(conn,community,row['secret_id'],'bank-document')
                raw=base64.b64decode(data['data'],validate=True)
                if hashlib.sha256(raw).hexdigest()!=data['sha256']:raise ContractError('El documento no supera la comprobacion de integridad.')
                now=utc_now();context=self.vault.put(conn,community,'bank-document-access',{'reason':reason},now)
                write_event(conn,community_id=community,actor=actor,action='erp4.document.download',entity_type='documentos_importados',
                    entity_id=row['document_id'],before=None,after={'document_id':row['document_id']},reason='Acceso bancario autorizado',
                    origin='web',request_id=uuid.uuid4().hex,entity_version=1,metadata={'protected_context_id':context})
                return {'ok':True,'content_base64':data['data'],'extension':data['extension']}
        finally:conn.close()
