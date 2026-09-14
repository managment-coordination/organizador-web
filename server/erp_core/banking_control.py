"""Explicit operational reviews, external cutover and documented mandate succession."""

from .errors import ContractError, ConflictError, NotFoundError
from .receivables_contracts import day, identity, require_fields, text


class BankingControl:
    def _control_event(self, conn, actor, e, now, kind, effective, *, line=None, external=None, conflict=None, details=None):
        secret = self.vault.put(conn, e.community_id, 'bank-control', {
            **self._evidence_value(e), 'details': details or {}}, now)
        return conn.execute('''INSERT INTO erp_banca_control_eventos
            (id_comunidad,external_id,line_id,conflict_event_id,kind,secret_id,effective_on,registered_at,actor_id)
            VALUES (?,?,?,?,?,?,?,?,?)''',
            (e.community_id,external,line,conflict,kind,secret,effective,now,actor.user_id)).lastrowid

    def external_register(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('receipt_ids','cutoff_on','source','reference'))
            cutoff = day(p['cutoff_on'])
            if cutoff > now[:10]:
                raise ContractError('La fecha de corte no puede ser futura.')
            source = text(p['source'], 'Origen', maximum=200)
            reference = text(p['reference'], 'Referencia externa', maximum=200)
            ids = p['receipt_ids']
            if not isinstance(ids,list) or not 1 <= len(ids) <= 10000:
                raise ContractError('Selecciona los recibos acreditados al corte.')
            ids = [identity(x) for x in ids]
            if len(set(ids)) != len(ids):
                raise ContractError('Hay recibos repetidos.')
            result = []
            for rid in ids:
                if not conn.execute('SELECT 1 FROM erp_recibos WHERE id_comunidad=? AND id=?',(e.community_id,rid)).fetchone():
                    raise NotFoundError('Recibo no disponible en esta comunidad.')
                old = conn.execute("SELECT id,secret_id,cutoff_on FROM erp_banca_instrucciones_externas WHERE id_comunidad=? AND receipt_id=? AND state='activa'",(e.community_id,rid)).fetchone()
                details = {'source':source,'reference':reference}
                if old:
                    prior = self.vault.get(conn,e.community_id,old['secret_id'],'external-instruction')
                    if prior['instruction'] != details or old['cutoff_on'] != cutoff:
                        raise ConflictError('El recibo ya tiene otra instruccion externa pendiente.')
                    result.append(old['id'])
                    continue
                secret = self.vault.put(conn,e.community_id,'external-instruction',{'instruction':details,**self._evidence_value(e)},now)
                result.append(conn.execute('''INSERT INTO erp_banca_instrucciones_externas
                    (id_comunidad,receipt_id,secret_id,cutoff_on,registered_at,actor_id) VALUES (?,?,?,?,?,?)''',
                    (e.community_id,rid,secret,cutoff,now,actor.user_id)).lastrowid)
            return {'ids':result,'count':len(result),'state':'activa','economic_effect':False}
        return self._write(session,env,'prepare',op)

    def external_close(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('id','effective_on','terminal_confirmed'))
            row = conn.execute('SELECT * FROM erp_banca_instrucciones_externas WHERE id_comunidad=? AND id=?',(e.community_id,identity(p['id']))).fetchone()
            if not row:raise NotFoundError('Instruccion externa no disponible.')
            self._version(row,e.expected_version)
            effective = day(p['effective_on'])
            if p['terminal_confirmed'] is not True or not row['cutoff_on'] <= effective <= now[:10]:
                raise ContractError('Acredita el cierre bancario y su fecha antes de liberar el recibo.')
            if row['state'] != 'activa':raise ConflictError('La instruccion ya esta cerrada.')
            event = self._control_event(conn,actor,e,now,'external_closed',effective,external=row['id'])
            conn.execute("UPDATE erp_banca_instrucciones_externas SET state='cerrada',version=version+1 WHERE id_comunidad=? AND id=?",(e.community_id,row['id']))
            return {'id':row['id'],'version':row['version']+1,'event_id':event,'state':'cerrada','economic_effect':False}
        return self._write(session,env,'present_cancel',op)

    def mandate_succeed(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('predecessor_id','successor_id','successor_version','effective_on'))
            old = self._entity(conn,'erp_mandatos',e.community_id,p['predecessor_id'])
            new = self._entity(conn,'erp_mandatos',e.community_id,p['successor_id'])
            self._version(old,e.expected_version)
            self._version(new,p['successor_version'])
            effective = day(p['effective_on'])
            if old['id'] >= new['id'] or new['state'] != 'activo' or effective > now[:10]:
                raise ContractError('Selecciona un mandato sucesor posterior, firmado y activado; no se heredan autorizaciones.')
            previous = conn.execute('SELECT debtor_owner_id,debtor_person_id FROM erp_mandato_versiones WHERE id_comunidad=? AND mandate_id=? ORDER BY version DESC LIMIT 1',(e.community_id,old['id'])).fetchone()
            current = conn.execute('SELECT debtor_owner_id,debtor_person_id FROM erp_mandato_versiones WHERE id_comunidad=? AND mandate_id=? ORDER BY version DESC LIMIT 1',(e.community_id,new['id'])).fetchone()
            if tuple(previous) != tuple(current):
                raise ContractError('La sucesion de referencia o acreedor no sustituye al deudor bancario.')
            secret = self.vault.put(conn,e.community_id,'mandate-succession',self._evidence_value(e),now)
            sid = conn.execute('''INSERT INTO erp_mandato_sucesiones
                (id_comunidad,predecessor_id,successor_id,secret_id,effective_on,registered_at,actor_id) VALUES (?,?,?,?,?,?,?)''',
                (e.community_id,old['id'],new['id'],secret,effective,now,actor.user_id)).lastrowid
            # Both identities and their global collision guards remain permanent.
            return {'id':sid,'predecessor_id':old['id'],'successor_id':new['id'],'direct_debits_unchanged':True}
        return self._write(session,env,'manage_mandates',op)

    def conflict_review(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('event_id','keep_economic_history','effective_on'))
            event = conn.execute("SELECT * FROM erp_banca_linea_eventos WHERE id_comunidad=? AND id=? AND kind='conflict'",(e.community_id,identity(p['event_id']))).fetchone()
            if not event:raise NotFoundError('Incidencia no disponible.')
            rem = conn.execute('''SELECT r.* FROM erp_remesa_lineas l JOIN erp_remesa_revisiones v ON v.id=l.revision_id
                JOIN erp_remesas r ON r.id=v.remittance_id WHERE l.id_comunidad=? AND l.id=?''',(e.community_id,event['line_id'])).fetchone()
            self._version(rem,e.expected_version)
            effective = day(p['effective_on'])
            if p['keep_economic_history'] is not True or not event['effective_on'] <= effective <= now[:10]:
                raise ContractError('La revision conserva los hechos economicos. Una rectificacion requiere otra operacion ERP 3.')
            eid = self._control_event(conn,actor,e,now,'conflict_reviewed',effective,line=event['line_id'],conflict=event['id'])
            # Do not clear needs_review: other causes (saldo, mandato, otro intento) may coexist.
            conn.execute('UPDATE erp_remesas SET version=version+1 WHERE id_comunidad=? AND id=?',(e.community_id,rem['id']))
            return {'id':eid,'line_id':event['line_id'],'remittance_id':rem['id'],'version':rem['version']+1,'economic_effect':False}
        return self._write(session,env,'results',op)

    def reversal_request(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('line_id','effective_on'))
            line = self._entity(conn,'erp_remesa_lineas',e.community_id,p['line_id'])
            if self._line_status(conn,e.community_id,line['id']) != 'settlement':
                raise ContractError('La inversion requiere una liquidacion identificada, no una cancelacion local.')
            effective = day(p['effective_on'])
            if effective > now[:10]:raise ContractError('La solicitud no puede ser futura.')
            old = conn.execute("SELECT id FROM erp_banca_control_eventos WHERE id_comunidad=? AND line_id=? AND kind='reversal_requested'",(e.community_id,line['id'])).fetchone()
            eid = old['id'] if old else self._control_event(conn,actor,e,now,'reversal_requested',effective,line=line['id'])
            return {'id':eid,'line_id':line['id'],'state':'pendiente_banco','xml_enabled':False,'economic_effect':False}
        return self._write(session,env,'present_cancel',op)

    def mandate_authorize_retry(self, session, env):
        def op(conn, actor, e, now):
            p = require_fields(e.payload, ('line_id','effective_on'))
            line = self._entity(conn,'erp_remesa_lineas',e.community_id,p['line_id'])
            mv = self._entity(conn,'erp_mandato_versiones',e.community_id,line['mandate_version_id'])
            mandate = self._entity(conn,'erp_mandatos',e.community_id,mv['mandate_id'])
            self._version(mandate,e.expected_version)
            _,config = self._bank_profile(conn,e.community_id,mandate['creditor_id'])
            if mandate['kind']!='puntual' or mandate['state']!='activo' or not config.get('allow_failed_oneoff_retry'):
                raise ContractError('El perfil bancario no permite repetir este mandato puntual.')
            if self._line_status(conn,e.community_id,line['id']) not in ('rejected','cancelled'):
                raise ConflictError('Solo puede acreditarse la repeticion de un intento fallido cerrado.')
            if conn.execute('''SELECT 1 FROM erp_banca_linea_eventos ev JOIN erp_remesa_lineas l ON l.id=ev.line_id
                JOIN erp_mandato_versiones v ON v.id=l.mandate_version_id WHERE ev.id_comunidad=? AND v.mandate_id=?
                AND ev.kind IN ('settlement','returned')''',(e.community_id,mandate['id'])).fetchone():
                raise ConflictError('El mandato puntual ya ha tenido ejecucion economica.')
            effective = day(p['effective_on'])
            if effective>now[:10]:raise ContractError('La autorizacion no puede ser futura.')
            eid = self._control_event(conn,actor,e,now,'oneoff_retry_authorized',effective,line=line['id'],
                details={'mandate_id':mandate['id'],'mandate_version':mandate['version']})
            return {'id':eid,'line_id':line['id'],'requires_retry_confirmation':True}
        return self._write(session,env,'manage_mandates',op)

    def control_list(self, session, query):
        def op(conn, q):
            require_fields(q.filters, (), ('property_id','offset','limit','search'))
            offset,limit = q.filters.get('offset',0),q.filters.get('limit',100)
            if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=200:
                raise ContractError('Paginacion no valida.')
            prop = identity(q.filters['property_id']) if q.filters.get('property_id') else None
            search=q.filters.get('search','')
            if not isinstance(search,str) or len(search)>200:raise ContractError('Busqueda no valida.')
            pattern='%'+search.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'
            sql=""" FROM erp_banca_instrucciones_externas x JOIN erp_recibos r ON r.id_comunidad=x.id_comunidad AND r.id=x.receipt_id
                JOIN cf_propiedades p ON p.id_comunidad=r.id_comunidad AND p.id_propiedad=r.id_propiedad
                WHERE x.id_comunidad=? AND (? IS NULL OR r.id_propiedad=?) AND (r.number LIKE ? ESCAPE '\\' OR p.codigo_propiedad LIKE ? ESCAPE '\\')"""
            args=(q.community_id,prop,prop,pattern,pattern)
            total=conn.execute('SELECT count(*)'+sql,args).fetchone()[0]
            rows=conn.execute('SELECT x.id,x.receipt_id,r.number,r.id_propiedad,p.codigo_propiedad AS property_code,x.cutoff_on,x.state,x.version'+sql+' ORDER BY x.id DESC LIMIT ? OFFSET ?',(*args,limit,offset)).fetchall()
            return {'external_instructions':[dict(r) for r in rows],'total':total}
        return self._read(session,query,'read_masked',op)
