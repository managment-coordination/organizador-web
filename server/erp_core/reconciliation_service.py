"""ERP 5: encrypted evidence, exact bank assignments and reviewed economic commands."""

from dataclasses import replace
from datetime import date, timedelta
import json

from access_control import permission, profile
from .banking_service import BankingService
from .banking_tabular import masked_cell
from .contracts import Actor, CommandEnvelope, canonical_json
from .errors import ContractError, ConflictError, NotFoundError
from .outbox import enqueue
from .receivables_contracts import cents, day, identity, require_fields, text
from .receivables_service import ReceivablesService
from .reconciliation_adapters import parse, normalize
from .reconciliation_operations import ReconciliationOperations

CAPABILITIES = frozenset(('read','import','propose','confirm','manage_outflows','manage_transfers',
                         'correct','close','reopen','configure','export','audit'))
COMMANDS = frozenset('erp5.'+x for x in ('permissions.save','statement.analyze','statement.preview',
    'statement.confirm','statement.remap','match.preview','match.confirm','match.reverse','opening.confirm',
    'closure.preview','closure.confirm','closure.reopen','pending.assign','transfer.preview','transfer.confirm',
    'movement.correct','legacy.preview','legacy.confirm','transfer.complete_preview','transfer.complete_confirm','report.export','source.preview','source.confirm','profile.save'))
QUERIES = frozenset(('workspace.get','movement.list','movement.get','statement.get','balances.get',
                    'proposals.get','closure.list','transfer.list','permissions.get','report.get','facts.list','source.status','profile.list'))


class ReconciliationService(ReconciliationOperations, BankingService):
    COMMANDS = COMMANDS
    AUDIT_ENTITY = 'erp5_operation'

    @classmethod
    def from_runtime(cls,database_path):
        banking=BankingService.from_runtime(database_path)
        return cls(database_path,vault=banking.vault)

    @staticmethod
    def _session(conn,session,community,capability):
        actor=Actor.from_session(session);current=profile(conn,actor.user_id)
        if not current or current['bloqueado'] or current['auth_version']!=session.get('auth_version'):
            raise PermissionError('La sesion de conciliacion no esta vigente.')
        if not permission(current,community,'puede_ver'):
            raise PermissionError('No tienes acceso a esta comunidad.')
        from .repository import FoundationRepository
        FoundationRepository(conn).require_active_community(community)
        if capability=='grant':
            if current['rol']!='Superusuario':raise PermissionError('No puedes administrar permisos de conciliacion.')
        else:
            if capability not in CAPABILITIES:raise ContractError('Permiso de conciliacion desconocido.')
            row=conn.execute('SELECT allowed FROM erp_conciliacion_permisos WHERE id_comunidad=? AND user_id=? AND capability=?',
                             (community,actor.user_id,capability)).fetchone()
            if not row or not row[0]:raise PermissionError('No tienes permiso para esta operacion de conciliacion.')
        return actor,current

    @staticmethod
    def _row(conn,table,community,rid):
        allowed={'erp_extractos_importaciones','erp_banco_movimientos','erp_conciliacion_propuestas',
                 'erp_conciliaciones','erp_conciliacion_cierres','erp_tesoreria_salidas','erp_tesoreria_transferencias'}
        if table not in allowed:raise ContractError('Entidad de conciliacion no valida.')
        row=conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? AND id=?',(community,identity(rid))).fetchone()
        if not row:raise NotFoundError('Registro no disponible en esta comunidad.')
        return row

    def _account(self,conn,community,rid,active=True):
        row=BankingService._entity(conn,'erp_cuentas_tesoreria',community,rid)
        if (active and row['state']!='activa') or row['currency']!='EUR':raise ContractError('Cuenta no activa o moneda no soportada.')
        return row

    @staticmethod
    def _guard_open(conn,community,account,on):
        if conn.execute("SELECT 1 FROM erp_conciliacion_cierres WHERE id_comunidad=? AND treasury_id=? AND start_on<=? AND end_on>=? AND state!='reabierto'",
                        (community,account,on,on)).fetchone():
            raise ConflictError('El periodo tiene una conciliacion cerrada. Reabre antes de modificarlo.')

    @staticmethod
    def _remaining(conn,community,movement):
        assigned=sum(r[0] for r in conn.execute('SELECT amount_cents FROM erp_conciliacion_componentes WHERE id_comunidad=? AND movement_id=?',
                                               (community,movement['id'])))
        return int(movement['amount_cents'])-assigned

    def _movement_public(self,conn,community,row):
        private=self.vault.get(conn,community,row['secret_id'],'bank-movement')
        remain=self._remaining(conn,community,row)
        correction=conn.execute('SELECT kind,replacement_id FROM erp_banco_movimiento_correcciones WHERE id_comunidad=? AND movement_id=? ORDER BY id DESC LIMIT 1',
                                (community,row['id'])).fetchone()
        return {'id':row['id'],'treasury_id':row['treasury_id'],'operation_on':row['operation_on'],
            'value_on':row['value_on'],'amount_cents':str(row['amount_cents']),'currency':row['currency'],
            'source_state':row['source_state'],'concept':masked_cell(private.get('concept','')),
            'counterparty':masked_cell(private.get('counterparty','')),'reference':masked_cell(private.get('reference','')),
            'remaining_cents':str(remain),'version':row['version'],
            'state':'rectificado' if correction else 'conciliado' if not remain else 'pendiente' if remain==row['amount_cents'] else 'parcial'}

    def _event(self,conn,e,event,aggregate,identifier,payload):
        from .migrations import utc_now
        context={'schema_version':1,'community_id':e.community_id,'aggregate_type':aggregate,'aggregate_id':str(identifier),
            'origin':e.origin,'recorded_at':utc_now(),'correlation_id':e.request_hash()}
        if event in ('reconciliation.confirmed','reconciliation.reversed'):
            links=[]
            for row in conn.execute('SELECT * FROM erp_conciliacion_componentes WHERE id_comunidad=? AND match_id=? ORDER BY id',(e.community_id,identifier)):
                m=self._row(conn,'erp_banco_movimientos',e.community_id,row['movement_id']);kind=row['kind'];fact=row[kind+'_id']
                economic_event=None
                if kind in ('return','refund'):
                    table={'return':'erp_devoluciones','refund':'erp_reintegros'}[kind]
                    economic_event=conn.execute(f'SELECT event_id FROM {table} WHERE id_comunidad=? AND id=?',(e.community_id,fact)).fetchone()[0]
                links.append({'component_id':str(row['id']),'movement_id':m['id'],'treasury_id':m['treasury_id'],
                    'economic_fact_id':('erp3:' if kind in ('collection','return','refund') else 'erp5:')+kind+':'+str(fact),
                    'economic_event_id':economic_event,'amount_cents':str(row['amount_cents']),'currency':m['currency'],
                    'operation_on':m['operation_on'],'value_on':m['value_on'],'reverses_component_id':row['reverses_id']})
            context['links']=links
        return enqueue(conn,community_id=e.community_id,event_type='erp5.'+event,
            aggregate_type=aggregate,aggregate_id=identifier,payload={**context,**payload},
            dedupe_key='erp5-'+event+'-'+str(identifier))

    def permissions_save(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('user_id','capability','allowed'))
            if p['capability'] not in CAPABILITIES or type(p['allowed']) is not bool:raise ContractError('Permiso no valido.')
            target=profile(conn,identity(p['user_id']))
            if not target or not permission(target,e.community_id,'puede_ver'):raise PermissionError('Usuario no disponible en esta comunidad.')
            old=conn.execute('SELECT version FROM erp_conciliacion_permisos WHERE id_comunidad=? AND user_id=? AND capability=?',
                             (e.community_id,p['user_id'],p['capability'])).fetchone()
            version=old[0] if old else 0
            if e.expected_version!=version:raise ConflictError('El permiso ha cambiado.')
            conn.execute('''INSERT INTO erp_conciliacion_permisos
                (id_comunidad,user_id,capability,allowed,version,registered_at,actor_id) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(id_comunidad,user_id,capability) DO UPDATE SET allowed=excluded.allowed,
                version=excluded.version,registered_at=excluded.registered_at,actor_id=excluded.actor_id''',
                (e.community_id,p['user_id'],p['capability'],int(p['allowed']),version+1,now,actor.user_id))
            return {'user_id':p['user_id'],'capability':p['capability'],'allowed':p['allowed'],'version':version+1}
        return self._write(session,env,'grant',op)

    def permissions_get(self,session,q):
        def op(conn,q):
            rows=conn.execute('SELECT user_id,capability,allowed,version FROM erp_conciliacion_permisos WHERE id_comunidad=?',(q.community_id,))
            users=[dict(r) for r in conn.execute('SELECT id_usuario,nombre FROM usuarios WHERE activo=1 ORDER BY nombre')
                   if permission(profile(conn,r['id_usuario']),q.community_id,'puede_ver')]
            return {'items':[dict(r) for r in rows],'users':users,'capabilities':sorted(CAPABILITIES)}
        return self._read(session,q,'grant',op)

    def workspace_get(self,session,q):
        def op(conn,q):
            accounts=[]
            for r in conn.execute('SELECT * FROM erp_cuentas_tesoreria WHERE id_comunidad=?',(q.community_id,)):
                secret=self.vault.get(conn,q.community_id,r['secret_id'],'treasury-account') if r['secret_id'] else {}
                iban=secret.get('iban','')
                accounts.append({'id':r['id'],'kind':r['kind'],'state':r['state'],'currency':r['currency'],
                                 'label':'Caja' if r['kind']=='caja' else 'Banco '+iban[:4]+' **** '+iban[-4:]})
            grants={r['capability']:bool(r['allowed']) for r in conn.execute('SELECT * FROM erp_conciliacion_permisos WHERE id_comunidad=? AND user_id=?',
                                                                          (q.community_id,session['id_usuario']))}
            return {'accounts':accounts,'permissions':grants,'banking_real':False,'current_user_id':session['id_usuario']}
        return self._read(session,q,'read',op)

    def facts_list(self,session,q):
        def op(conn,q):
            ReceivablesService._session(conn,session,q.community_id,'sensitive_read')
            account=identity(q.filters['treasury_id']);self._account(conn,q.community_id,account)
            items=[]
            for kind,table in (('collection','erp_cobros'),('return','erp_devoluciones'),('refund','erp_reintegros'),('outflow','erp_tesoreria_salidas')):
                for r in conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? ORDER BY id DESC',(q.community_id,)):
                    if kind=='outflow':correct=r['treasury_id']==account
                    else:
                        related=r if kind=='collection' else conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND id=?',(q.community_id,r['collection_id'])).fetchone()
                        correct=related and related['treasury_reference']=='erp4-treasury:'+str(account)
                    if not correct:continue
                    used=abs(sum(c[0] for c in conn.execute(f'SELECT amount_cents FROM erp_conciliacion_componentes WHERE id_comunidad=? AND {kind}_id=?',(q.community_id,r['id']))))
                    if used>=r['amount_cents']:continue
                    items.append({'kind':kind,'id':r['id'],'amount_cents':str(r['amount_cents']-used),'effective_on':r['effective_on']})
            from .receivables_projection import collection_balance,collection_payer
            collections=[]
            for r in conn.execute("SELECT * FROM erp_cobros WHERE id_comunidad=? AND treasury_reference=? ORDER BY id DESC LIMIT 201",(q.community_id,'erp4-treasury:'+str(account))):
                payer=collection_payer(conn,q.community_id,r['id']);allocations=[]
                for a in conn.execute('''SELECT a.id,a.amount_cents,r.number FROM erp_imputaciones a JOIN erp_recibos r
                    ON r.id_comunidad=a.id_comunidad AND r.id=a.receipt_id WHERE a.id_comunidad=? AND a.collection_id=? AND a.reverses_id IS NULL''',(q.community_id,r['id'])):
                    reversed_total=sum(x[0] for x in conn.execute('SELECT amount_cents FROM erp_imputaciones WHERE id_comunidad=? AND reverses_id=?',(q.community_id,a['id'])))
                    remaining=a['amount_cents']-reversed_total
                    if remaining>0:allocations.append({'id':a['id'],'number':a['number'],'remaining_cents':str(remaining)})
                collections.append({'id':r['id'],'effective_on':r['effective_on'],'amount_cents':str(r['amount_cents']),
                    'available_cents':collection_balance(conn,q.community_id,r['id'])['available_cents'],
                    'beneficiary':{'type':'owner','id':payer['payer_owner_id']} if payer['payer_owner_id'] else {'type':'person','id':payer['payer_person_id']} if payer['payer_person_id'] else None,
                    'allocations':allocations})
            from .receivables_projection import receipt_balance
            receipts=[]
            for r in conn.execute('SELECT * FROM erp_recibos WHERE id_comunidad=? ORDER BY issued_on DESC,id DESC',(q.community_id,)):
                b=receipt_balance(conn,q.community_id,r['id'])
                if int(b['pending_cents']):receipts.append({'id':r['id'],'number':r['number'],'description':r['description'],'pending_cents':b['pending_cents']})
            return {'items':items[:200],'receipts':receipts[:200],'collections':collections[:200],
                'truncated':len(items)>200 or len(receipts)>200 or len(collections)>200}
        return self._read(session,q,'read',op)

    def statement_analyze(self,session,env):
        def op(conn,actor,e,now):
            self._account(conn,e.community_id,e.payload['treasury_id'])
            result=parse(e.payload)
            if 'headers' not in result:raise ContractError('Este formato no requiere mapeo de columnas.')
            signature=self.vault.fingerprint(e.community_id,'statement-columns',result['headers'])
            signatures=set(self.vault.fingerprints(e.community_id,'statement-columns',result['headers']).values())
            profiles=[]
            for row in conn.execute("""SELECT p.* FROM erp_conciliacion_perfiles p WHERE p.id_comunidad=? AND p.treasury_id=? AND p.kind='mapping'
                AND NOT EXISTS(SELECT 1 FROM erp_conciliacion_perfiles n WHERE n.id_comunidad=p.id_comunidad AND n.treasury_id=p.treasury_id
                AND n.kind=p.kind AND n.profile_key=p.profile_key AND n.version>p.version) ORDER BY p.id DESC""",(e.community_id,e.payload['treasury_id'])):
                data=self.vault.get(conn,e.community_id,row['secret_id'],'reconciliation-profile')
                if data['config']['header_signature'] in signatures:profiles.append({'id':row['id'],'name':masked_cell(data['name']),'version':row['version'],
                    'mapping':data['config']['mapping'],'options':data['config']['options']})
            return {'headers':[masked_cell(h) for h in result['headers']],
                    'sample':[[masked_cell(v) for v in r['values']] for r in result['rows'][:5]],'rows':len(result['rows']),
                    'header_signature':signature,'saved_profiles':profiles}
        return self._write(session,env,'import',op)

    def profile_save(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('treasury_id','name','kind','config'));self._account(conn,e.community_id,p['treasury_id'])
            name=text(p['name'],'Nombre del perfil',maximum=100);kind=p['kind'];config=p['config']
            if kind=='mapping':
                require_fields(config,('mapping','options','header_signature'))
                require_fields(config['mapping'],('operation_on',),('value_on','amount','debit','credit','concept','reference','counterparty','external_id','balance'))
                if 'amount' not in config['mapping'] and not {'debit','credit'}.intersection(config['mapping']):raise ContractError('Indica columnas de importe.')
                if any(type(v) is not int or not 0<=v<100 for v in config['mapping'].values()):raise ContractError('Columna no valida.')
                require_fields(config['options'],('decimal_separator','date_format'),('namespace',))
                if config['options']['decimal_separator'] not in ('.',',') or config['options']['date_format'] not in ('iso','dmy','mdy'):raise ContractError('Convencion de importacion no valida.')
                text(config['header_signature'],'Firma de columnas',maximum=128)
            elif kind=='matching':
                require_fields(config,('window_days',))
                if type(config['window_days']) is not int or not 0<=config['window_days']<=90:raise ContractError('Ventana de fechas entre 0 y 90 dias.')
            else:raise ContractError('Tipo de perfil no disponible.')
            key=self.vault.fingerprint(e.community_id,'reconciliation-profile-name',name)
            keys=list(self.vault.fingerprints(e.community_id,'reconciliation-profile-name',name).values())
            previous=conn.execute('SELECT profile_key,version FROM erp_conciliacion_perfiles WHERE id_comunidad=? AND treasury_id=? AND profile_key IN ('+','.join('?' for _ in keys)+') AND kind=? ORDER BY version DESC LIMIT 1',
                (e.community_id,p['treasury_id'],*keys,kind)).fetchone()
            version=previous['version'] if previous else 0
            if previous:key=previous['profile_key']
            if e.expected_version!=version:raise ConflictError('El perfil ha cambiado; revisa su version actual.')
            secret=self.vault.put(conn,e.community_id,'reconciliation-profile',{'name':name,'config':config},now)
            rid=conn.execute('INSERT INTO erp_conciliacion_perfiles(id_comunidad,treasury_id,profile_key,kind,version,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?)',
                (e.community_id,p['treasury_id'],key,kind,version+1,secret,now,actor.user_id)).lastrowid
            return {'id':rid,'version':version+1,'kind':kind}
        return self._write(session,env,'configure',op)

    def profile_list(self,session,q):
        def op(conn,q):
            self._account(conn,q.community_id,q.filters['treasury_id'],active=False)
            rows=[]
            for row in conn.execute('SELECT * FROM erp_conciliacion_perfiles WHERE id_comunidad=? AND treasury_id=? ORDER BY id DESC',(q.community_id,q.filters['treasury_id'])):
                data=self.vault.get(conn,q.community_id,row['secret_id'],'reconciliation-profile')
                rows.append({'id':row['id'],'name':masked_cell(data['name']),'kind':row['kind'],'version':row['version'],'config':data['config'] if row['kind']=='matching' else None})
            return {'items':rows}
        return self._read(session,q,'read',op)

    def _import_plan(self,conn,community,data,decisions=None):
        decisions=decisions or {};result=[];seen=set()
        for row in data['parsed']['rows']:
            stable=None
            if row.get('external_id'):
                value=[data['treasury_id'],row['namespace'],row['external_id']]
                token=canonical_json(value)
                if token in seen:raise ConflictError('Identificador de apunte repetido en el mismo archivo. Revisa las filas antes de confirmar.')
                seen.add(token)
                for kid,digest in self.vault.fingerprints(community,'bank-movement-identity',value).items():
                    prior=conn.execute('SELECT movement_id FROM erp_banco_movimiento_identidades WHERE id_comunidad=? AND key_id=? AND digest=?',
                                       (community,kid,digest)).fetchone()
                    if prior:stable=prior[0];break
            essential={k:row.get(k) for k in ('operation_on','value_on','amount_cents','currency','source_state')}
            fpdata={**essential,**{k:row.get(k) for k in ('concept','counterparty','reference','balance_cents')}}
            fingerprints=self.vault.fingerprints(community,'bank-movement-candidate',[data['treasury_id'],fpdata])
            candidates=[r['id'] for r in conn.execute('SELECT * FROM erp_banco_movimientos WHERE id_comunidad=? AND treasury_id=?',
                                                    (community,data['treasury_id'])) if r['fingerprint'] in fingerprints.values()]
            action='link' if stable else 'review' if candidates else 'new';target=stable
            if stable:
                corrected=conn.execute('SELECT replacement_id FROM erp_banco_movimiento_correcciones WHERE id_comunidad=? AND movement_id=? ORDER BY id DESC LIMIT 1',
                                       (community,stable)).fetchone()
                if corrected:stable=corrected['replacement_id'];target=stable
                prior=self._row(conn,'erp_banco_movimientos',community,stable)
                transitioning=prior['source_state']=='pending' and essential['source_state']=='booked'
                if any(str(prior[k])!=str(essential[k]) for k in essential if not (transitioning and k=='source_state')):
                    raise ConflictError('Identidad bancaria con datos incompatibles.')
                if transitioning:action='book'
            choice=decisions.get(str(row['row_number']))
            if choice and not stable:
                if choice.get('action')=='new' and choice.get('reason'):action='new'
                elif choice.get('action')=='link' and choice.get('id') in candidates:action='link';target=choice['id']
                elif choice.get('action')=='skip' and choice.get('reason'):action='skip'
                elif choice.get('action')=='alias' and choice.get('reason'):
                    prior=self._row(conn,'erp_banco_movimientos',community,choice.get('id'))
                    if prior['treasury_id']!=data['treasury_id'] or any(str(prior[k])!=str(essential[k]) for k in essential):
                        raise ConflictError('El alias no coincide exactamente en cuenta, moneda, importe y fechas.')
                    if conn.execute('SELECT 1 FROM erp_banco_movimiento_correcciones WHERE id_comunidad=? AND movement_id=?',(community,prior['id'])).fetchone():raise ConflictError('El alias apunta a un movimiento rectificado.')
                    action='link';target=prior['id']
                else:raise ContractError('Revisa la decision de la fila.')
            result.append({'row':row['row_number'],'action':action,'id':target,'candidates':candidates,
                'fingerprint':fingerprints[self.vault.active_index],'essential':essential,'data':row})
        return result

    def _import_public(self,plan,errors):
        return {'rows':[{'row':r['row'],'action':r['action'],'id':r['id'],'candidates':r['candidates'],
            'operation_on':r['essential']['operation_on'],'amount_cents':r['essential']['amount_cents'],
            'concept':masked_cell(r['data'].get('concept',''))} for r in plan], 'errors':errors,
            'new_count':sum(r['action'] in ('new','book') for r in plan),'review_count':sum(r['action']=='review' for r in plan)}

    def statement_remap(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('id','mapping','options'))
            row=self._row(conn,'erp_extractos_importaciones',e.community_id,p['id']);self._version(row,e.expected_version)
            if row['state']!='pendiente':raise ConflictError('El extracto confirmado no se remapea; revisa sus movimientos mediante correccion.')
            data=self.vault.get(conn,e.community_id,row['secret_id'],'bank-statement')
            original={**data['original'],'mapping':p['mapping'],'options':p['options']};parsed=parse(original)
            secret=self.vault.put(conn,e.community_id,'bank-statement',{**data,'previous_secret_id':row['secret_id'],
                'original':original,'parsed':parsed,'coverage':original.get('coverage') or parsed.get('coverage')},now)
            conn.execute('UPDATE erp_extractos_importaciones SET secret_id=?,version=version+1 WHERE id=?',(secret,row['id']))
            return {'id':row['id'],'version':row['version']+1,'state':'pendiente',
                    **self._import_public(self._import_plan(conn,e.community_id,{**data,'parsed':parsed}),parsed['errors'])}
        return self._write(session,env,'import',op)

    def statement_preview(self,session,env):
        def op(conn,actor,e,now):
            account=self._account(conn,e.community_id,e.payload['treasury_id'])
            if account['kind']!='banco':raise ContractError('Los extractos corresponden a una cuenta de banco.')
            parsed=parse(e.payload)
            if parsed.get('headers') and e.payload.get('mapping') is None:raise ContractError('Mapea las columnas antes de revisar.')
            actual=self.vault.get(conn,e.community_id,account['secret_id'],'treasury-account')['iban']
            if parsed.get('account_iban') and parsed['account_iban']!=actual:raise ConflictError('El archivo corresponde a otra cuenta.')
            if parsed.get('account_ccc') and parsed['account_ccc']!=actual[4:12]+actual[14:]:raise ConflictError('El archivo corresponde a otra cuenta.')
            old=conn.execute('SELECT * FROM erp_extractos_importaciones WHERE id_comunidad=? AND treasury_id=? AND source_hash=?',
                             (e.community_id,account['id'],parsed['source_hash'])).fetchone()
            if old:
                data=self.vault.get(conn,e.community_id,old['secret_id'],'bank-statement')
                return {'id':old['id'],'version':old['version'],'state':old['state'],
                        **self._import_public(self._import_plan(conn,e.community_id,data),data['parsed']['errors'])}
            data={'treasury_id':account['id'],'parsed':parsed,'original':e.payload,
                  'coverage':e.payload.get('coverage') or parsed.get('coverage')}
            secret=self.vault.put(conn,e.community_id,'bank-statement',data,now)
            rid=conn.execute('''INSERT INTO erp_extractos_importaciones
                (id_comunidad,treasury_id,source_hash,secret_id,state,registered_at,actor_id) VALUES (?,?,?,?,'pendiente',?,?)''',
                (e.community_id,account['id'],parsed['source_hash'],secret,now,actor.user_id)).lastrowid
            return {'id':rid,'version':1,'state':'pendiente',**self._import_public(self._import_plan(conn,e.community_id,data),parsed['errors'])}
        return self._write(session,env,'import',op)

    def _coverage(self,conn,actor,e,now,p,import_id=None):
        account=self._account(conn,e.community_id,p['treasury_id']);start=day(p['start_on']);end=day(p['end_on'])
        if end<start:raise ContractError('Intervalo no valido.')
        if conn.execute("SELECT 1 FROM erp_conciliacion_cierres WHERE id_comunidad=? AND treasury_id=? AND start_on<=? AND end_on>=? AND state!='reabierto'",
                        (e.community_id,account['id'],end,start)).fetchone():
            raise ConflictError('La cobertura solapa un periodo cerrado. Reabre antes de modificarlo.')
        if p.get('balance_type','booked') not in ('booked','available','value') or type(p.get('complete',False)) is not bool:
            raise ContractError('Base de saldo o cobertura no valida.')
        opening=cents(p['opening_cents']) if p.get('opening_cents') is not None else None
        closing=cents(p['closing_cents']) if p.get('closing_cents') is not None else None
        secret=self.vault.put(conn,e.community_id,'bank-coverage',{'payload':p,'reason':e.reason},now)
        return conn.execute('''INSERT INTO erp_extractos_coberturas
            (id_comunidad,treasury_id,import_id,start_on,end_on,opening_cents,closing_cents,balance_type,complete,secret_id,registered_at,actor_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',(e.community_id,account['id'],import_id,start,end,opening,closing,
            p.get('balance_type','booked'),int(p.get('complete',False)),secret,now,actor.user_id)).lastrowid

    def statement_confirm(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('id',),('decisions','exclude_errors'))
            row=self._row(conn,'erp_extractos_importaciones',e.community_id,p['id']);self._version(row,e.expected_version)
            if row['state']=='confirmada':return {'id':row['id'],'version':row['version'],'state':'confirmada','already_confirmed':True,
                'movement_ids':[r[0] for r in conn.execute('SELECT movement_id FROM erp_banco_movimiento_evidencias WHERE id_comunidad=? AND import_id=? ORDER BY row_number',
                                                        (e.community_id,row['id']))]}
            data=self.vault.get(conn,e.community_id,row['secret_id'],'bank-statement')
            if data['parsed']['errors'] and p.get('exclude_errors') is not True:raise ContractError('Revisa o excluye expresamente las filas con errores.')
            plan=self._import_plan(conn,e.community_id,data,p.get('decisions'))
            if any(r['action']=='review' for r in plan):raise ConflictError('Quedan movimientos iguales pendientes de distinguir.')
            ids=[]
            for r in plan:
                if r['action']=='skip':continue
                mid=r['id'];d=r['data']
                if r['action'] in ('new','book'):
                    # Late statements stay in staging until affected periods are reopened.
                    self._guard_open(conn,e.community_id,row['treasury_id'],d['operation_on'])
                    secret=self.vault.put(conn,e.community_id,'bank-movement',d,now)
                    mid=conn.execute('''INSERT INTO erp_banco_movimientos
                        (id_comunidad,treasury_id,amount_cents,currency,operation_on,value_on,source_state,secret_id,fingerprint,registered_at,actor_id)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)''',(e.community_id,row['treasury_id'],int(d['amount_cents']),d['currency'],
                        d['operation_on'],d.get('value_on'),d['source_state'],secret,r['fingerprint'],now,actor.user_id)).lastrowid
                    if r['action']=='book':
                        correction=self.vault.put(conn,e.community_id,'bank-correction',{'kind':'pending_to_booked','previous_id':r['id']},now)
                        conn.execute('INSERT INTO erp_banco_movimiento_correcciones (id_comunidad,movement_id,replacement_id,kind,secret_id,registered_at,actor_id) VALUES (?,?,?,\'substitute\',?,?,?)',
                                     (e.community_id,r['id'],mid,correction,now,actor.user_id))
                    if d.get('external_id') and r['action']!='book':
                        for kid,digest in self.vault.fingerprints(e.community_id,'bank-movement-identity',[row['treasury_id'],d['namespace'],d['external_id']]).items():
                            conn.execute('INSERT INTO erp_banco_movimiento_identidades (id_comunidad,movement_id,key_id,digest,registered_at,actor_id) VALUES (?,?,?,?,?,?)',
                                         (e.community_id,mid,kid,digest,now,actor.user_id))
                    self._event(conn,e,'bank_movement.imported','movement',mid,{'effect':'evidence','movement_id':mid,
                        'treasury_id':row['treasury_id'],'amount_cents':d['amount_cents'],'currency':'EUR','operation_on':d['operation_on'],'value_on':d.get('value_on')})
                conn.execute('INSERT INTO erp_banco_movimiento_evidencias (id_comunidad,movement_id,import_id,row_number,registered_at,actor_id) VALUES (?,?,?,?,?,?)',
                             (e.community_id,mid,row['id'],r['row'],now,actor.user_id));ids.append(mid)
                if r['action']=='link' and d.get('external_id'):
                    for kid,digest in self.vault.fingerprints(e.community_id,'bank-movement-identity',[row['treasury_id'],d['namespace'],d['external_id']]).items():
                        prior=conn.execute('SELECT movement_id FROM erp_banco_movimiento_identidades WHERE id_comunidad=? AND key_id=? AND digest=?',(e.community_id,kid,digest)).fetchone()
                        if not prior:
                            conn.execute('INSERT INTO erp_banco_movimiento_identidades (id_comunidad,movement_id,key_id,digest,registered_at,actor_id) VALUES (?,?,?,?,?,?)',
                                (e.community_id,mid,kid,digest,now,actor.user_id))
            if data.get('coverage'):
                coverage={**data['coverage'],'treasury_id':row['treasury_id']}
                if data['parsed']['errors'] or any(r['action']=='skip' for r in plan):coverage['complete']=False
                self._coverage(conn,actor,e,now,coverage,row['id'])
            conn.execute("UPDATE erp_extractos_importaciones SET state='confirmada',version=version+1 WHERE id=?",(row['id'],))
            return {'id':row['id'],'version':row['version']+1,'state':'confirmada','movement_ids':ids}
        return self._write(session,env,'import',op)

    def statement_get(self,session,q):
        def op(conn,q):
            r=self._row(conn,'erp_extractos_importaciones',q.community_id,q.filters['id'])
            data=self.vault.get(conn,q.community_id,r['secret_id'],'bank-statement')
            return {'id':r['id'],'state':r['state'],'version':r['version'],
                    **self._import_public(self._import_plan(conn,q.community_id,data),data['parsed']['errors'])}
        return self._read(session,q,'import',op)

    def opening_confirm(self,session,env):
        def op(conn,actor,e,now):return {'id':self._coverage(conn,actor,e,now,e.payload),'effect':'evidence'}
        return self._write(session,env,'configure',op)

    def movement_list(self,session,q):
        def op(conn,q):
            p=q.filters;account=identity(p['treasury_id']);self._account(conn,q.community_id,account,active=False)
            offset=p.get('offset',0);limit=p.get('limit',50)
            if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=200:raise ContractError('Paginacion no valida.')
            rows=[self._movement_public(conn,q.community_id,r) for r in conn.execute(
                'SELECT * FROM erp_banco_movimientos WHERE id_comunidad=? AND treasury_id=? ORDER BY operation_on DESC,id DESC',(q.community_id,account))]
            if p.get('start_on'):rows=[r for r in rows if r['operation_on']>=day(p['start_on'])]
            if p.get('end_on'):rows=[r for r in rows if r['operation_on']<=day(p['end_on'])]
            if p.get('state'):rows=[r for r in rows if r['state']==p['state']]
            if p.get('search'):rows=[r for r in rows if str(p['search']).casefold() in (r['concept']+' '+r['counterparty']+' '+r['reference']).casefold()]
            if any(p.get(k) for k in ('owner_id','property_id','receipt_id','collection_id')):
                ReceivablesService._session(conn,session,q.community_id,'read')
                owner=identity(p['owner_id']) if p.get('owner_id') else None;prop=identity(p['property_id']) if p.get('property_id') else None
                target_receipt=identity(p['receipt_id']) if p.get('receipt_id') else None;target_collection=identity(p['collection_id']) if p.get('collection_id') else None
                if owner:BankingService._subject(conn,q.community_id,{'type':'owner','id':owner})
                if prop and not conn.execute('SELECT 1 FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?',(q.community_id,prop)).fetchone():raise NotFoundError('Propiedad no disponible.')
                for table,rid in (('erp_recibos',target_receipt),('erp_cobros',target_collection)):
                    if rid and not conn.execute(f'SELECT 1 FROM {table} WHERE id_comunidad=? AND id=?',(q.community_id,rid)).fetchone():raise NotFoundError('Expediente economico no disponible.')
                associated=set()
                for r in conn.execute('''SELECT c.movement_id,COALESCE(c.collection_id,d.collection_id,f.collection_id) collection_id
                    FROM erp_conciliacion_componentes c LEFT JOIN erp_devoluciones d ON d.id_comunidad=c.id_comunidad AND d.id=c.return_id
                    LEFT JOIN erp_reintegros f ON f.id_comunidad=c.id_comunidad AND f.id=c.refund_id WHERE c.id_comunidad=?''',(q.community_id,)):
                    cid=r['collection_id']
                    if not cid:continue
                    if target_collection and cid!=target_collection:continue
                    if target_collection and not owner and not prop and not target_receipt:associated.add(r['movement_id']);continue
                    if owner and not prop and not target_receipt and conn.execute('SELECT 1 FROM erp_cobros WHERE id_comunidad=? AND id=? AND payer_owner_id=?',(q.community_id,cid,owner)).fetchone():associated.add(r['movement_id']);continue
                    for receipt in conn.execute('''SELECT DISTINCT r.id,r.id_propiedad FROM erp_recibos r JOIN erp_imputaciones a ON a.id_comunidad=r.id_comunidad AND a.receipt_id=r.id
                        WHERE r.id_comunidad=? AND a.collection_id=?''',(q.community_id,cid)):
                        if target_receipt and receipt['id']!=target_receipt:continue
                        if prop and receipt['id_propiedad']!=prop:continue
                        if owner and not conn.execute("SELECT 1 FROM erp_recibo_sujetos WHERE id_comunidad=? AND receipt_id=? AND owner_id=? AND role IN ('payer','recipient','obligated')",
                                                     (q.community_id,receipt['id'],owner)).fetchone():continue
                        associated.add(r['movement_id'])
                rows=[r for r in rows if r['id'] in associated]
            return {'items':rows[offset:offset+limit],'total':len(rows),'sum_cents':str(sum(int(r['amount_cents']) for r in rows if r['state']!='rectificado'))}
        return self._read(session,q,'read',op)

    def movement_get(self,session,q):
        def op(conn,q):
            r=self._row(conn,'erp_banco_movimientos',q.community_id,q.filters['id'])
            result=self._movement_public(conn,q.community_id,r)
            result['history']=[{k:v for k,v in dict(c).items() if k not in ('secret_id',)} for c in conn.execute(
                'SELECT * FROM erp_conciliacion_componentes WHERE id_comunidad=? AND movement_id=? ORDER BY id',(q.community_id,r['id']))]
            result['imports']=[dict(x) for x in conn.execute('SELECT import_id,row_number FROM erp_banco_movimiento_evidencias WHERE id_comunidad=? AND movement_id=? ORDER BY id',
                                                           (q.community_id,r['id']))]
            return result
        return self._read(session,q,'read',op)

    def _proposal(self,conn,actor,e,now,kind,payload,public):
        secret=self.vault.put(conn,e.community_id,'reconciliation-proposal',{'payload':payload,'public':public},now)
        rid=conn.execute('INSERT INTO erp_conciliacion_propuestas (id_comunidad,kind,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?)',
                         (e.community_id,kind,secret,now,actor.user_id)).lastrowid
        return {'id':rid,'version':1,**public}

    def _components_plan(self,conn,session,community,p):
        require_fields(p,('components',),('net_evidence',))
        if not isinstance(p['components'],list) or not 1<=len(p['components'])<=200:raise ContractError('Revisa entre 1 y 200 componentes.')
        rows=[];used={};capacity={};net=bool(p.get('net_evidence'))
        for index,component in enumerate(p['components']):
            c=require_fields(component,('movement_id','action','amount_cents'),('fact_id','payer','allocations','return_payload',
                'kind','description','document','bank_result','expected_version','confidence','rule','treasury_reference','refund_payload'))
            m=self._row(conn,'erp_banco_movimientos',community,c['movement_id'])
            if m['source_state']!='booked':raise ContractError('El movimiento no esta asentado en el banco.')
            if conn.execute('SELECT 1 FROM erp_banco_movimiento_correcciones WHERE id_comunidad=? AND movement_id=?',(community,m['id'])).fetchone():
                raise ConflictError('Movimiento rectificado; revisa su sustituto.')
            self._guard_open(conn,community,m['treasury_id'],m['operation_on'])
            n=cents(c['amount_cents']);action=c['action'];fact=None;economic_snapshot=None
            if not n:raise ContractError('Componente sin importe.')
            if n*m['amount_cents']<0 and not net:raise ContractError('Un desglose de signo distinto requiere evidencia de bruto/neto.')
            used[m['id']]=used.get(m['id'],0)+n
            if action in ('link_collection','link_return','link_refund','link_outflow'):
                kind=action[5:];table={'collection':'erp_cobros','return':'erp_devoluciones','refund':'erp_reintegros','outflow':'erp_tesoreria_salidas'}[kind]
                fact=conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? AND id=?',(community,identity(c['fact_id']))).fetchone()
                if not fact:raise NotFoundError('Hecho economico no disponible.')
                if 'currency' in fact.keys() and fact['currency']!=m['currency']:raise ConflictError('Moneda del hecho distinta al movimiento.')
                ReceivablesService._session(conn,session,community,'read') if kind!='outflow' else self._session(conn,session,community,'read')
                sign=1 if kind=='collection' else -1
                if n*sign<=0:raise ContractError('Signo incompatible con el hecho.')
                reference=fact['treasury_reference'] if kind=='collection' else None
                if kind in ('return','refund'):
                    related=conn.execute('SELECT treasury_reference FROM erp_cobros WHERE id_comunidad=? AND id=?',(community,fact['collection_id'])).fetchone()
                    reference=related[0] if related else None
                if kind=='outflow' and fact['treasury_id']!=m['treasury_id']:raise ConflictError('Cuenta del pago distinta.')
                if kind!='outflow' and reference!='erp4-treasury:'+str(m['treasury_id']):
                    if c.get('treasury_reference')!='erp4-treasury:'+str(m['treasury_id']):raise ConflictError('Acredita la correspondencia de cuenta del hecho economico.')
                key=(kind,fact['id']);capacity[key]=capacity.get(key,0)+abs(n)
                assigned=abs(sum(r[0] for r in conn.execute(f'SELECT amount_cents FROM erp_conciliacion_componentes WHERE id_comunidad=? AND kind=? AND {kind}_id=?',
                                                         (community,kind,fact['id']))))
                if assigned+capacity[key]>fact['amount_cents']:raise ConflictError('Asignacion bancaria supera el importe del hecho.')
            elif action=='record_collection':
                if n<=0:raise ContractError('Un cobro es positivo.')
                ReceivablesService._session(conn,session,community,'record_collection')
                ReceivablesService._date_open(conn,community,m['operation_on'])
                if c.get('payer'):BankingService._subject(conn,community,c['payer'])
                if c.get('allocations'):
                    ReceivablesService._session(conn,session,community,'allocate')
                    if not isinstance(c['allocations'],list) or not 1<=len(c['allocations'])<=500:
                        raise ContractError('Revisa entre 1 y 500 aplicaciones.')
                    if sum(cents(a['amount_cents'],positive=True) for a in c['allocations'])>n:raise ContractError('Aplicaciones superan el cobro.')
                    from .receivables_projection import receipt_balance
                    economic=ReceivablesService(self.database_path);economic_snapshot=[];seen=set()
                    for allocation in c['allocations']:
                        require_fields(allocation,('receipt_id','amount_cents'),('responsibility_subjects',))
                        receipt=economic._entity(conn,'erp_recibos',community,allocation['receipt_id'])
                        if receipt['id'] in seen:raise ContractError('Recibo duplicado en la propuesta.')
                        seen.add(receipt['id']);allocated=cents(allocation['amount_cents'],positive=True)
                        balance=receipt_balance(conn,community,receipt['id'],m['operation_on'])
                        if receipt['currency']!='EUR' or allocated>int(balance['pending_cents']):
                            raise ConflictError('La aplicacion supera el pendiente o tiene otra moneda.')
                        responsibility=economic._choose_responsibility(conn,community,receipt['id'],m['operation_on'],allocated,allocation.get('responsibility_subjects'))
                        economic_snapshot.append({'receipt_id':receipt['id'],'version':receipt['version'],
                            'pending_cents':balance['pending_cents'],'responsibility':responsibility})
            elif action=='record_outflow':
                self._session(conn,session,community,'manage_outflows')
                if n>=0 or c.get('kind') not in ('payment','commission','other'):raise ContractError('Tipo de salida no valido.')
                ReceivablesService._date_open(conn,community,m['operation_on'])
                text(c.get('description'),'Concepto de salida')
                if c.get('document'):text(c['document'],'Documento vinculado',maximum=1000)
            elif action=='return':
                ReceivablesService._session(conn,session,community,'return_collection')
                if n>=0 or not c.get('return_payload'):raise ContractError('Identifica el cobro y las aplicaciones a devolver.')
                economic_snapshot=ReceivablesService(self.database_path)._correction_preview(conn,community,'return',c['return_payload'])
                if int(economic_snapshot['amount_cents'])!=-n:raise ContractError('Importe de devolucion incompatible.')
                collection=conn.execute('SELECT treasury_reference FROM erp_cobros WHERE id_comunidad=? AND id=?',
                                        (community,economic_snapshot['collection_id'])).fetchone()
                if collection['treasury_reference']!='erp4-treasury:'+str(m['treasury_id']):
                    raise ConflictError('La devolucion corresponde a otra cuenta o falta acreditar su cuenta.')
            elif action=='bank_result':
                bank=BankingService(self.database_path,vault=self.vault)
                BankingService._session(conn,session,community,'results')
                if not c.get('bank_result'):raise ContractError('Selecciona resultado y decisiones bancarias revisadas.')
                bankplan=bank._result_plan(conn,session,community,c['bank_result'])
                if not bankplan['rows']:raise ContractError('Resultado sin lineas identificadas.')
                sign_total=0
                for br in bankplan['rows']:
                    if br['kind'] not in ('settlement','returned'):raise ContractError('Este resultado no representa un movimiento monetario.')
                    if br['treasury_id']!=m['treasury_id']:raise ConflictError('Cuenta de resultado distinta.')
                    sign_total+=int(br['amount_cents'])*(1 if br['kind']=='settlement' else -1)
                if sign_total!=n:raise ContractError('El desglose del resultado no coincide con el movimiento.')
                fact={'id':bankplan['result_id'],'version':bankplan['version']}
                economic_snapshot={'bank_preview_hash':bankplan['preview_hash']}
            elif action=='refund':
                ReceivablesService._session(conn,session,community,'refund')
                if n>=0 or not c.get('refund_payload'):raise ContractError('Identifica el saldo y el beneficiario del reintegro.')
                economic_snapshot=ReceivablesService(self.database_path)._refund_preview(conn,community,c['refund_payload'])
                if int(economic_snapshot['amount_cents'])!=-n:raise ContractError('Importe del reintegro incompatible.')
                if economic_snapshot['effective_on']!=m['operation_on']:raise ContractError('Conserva la fecha del movimiento para el reintegro.')
            else:raise ContractError('Operacion de conciliacion no admitida.')
            rows.append({'index':index,'movement_id':m['id'],'movement_version':m['version'],'remaining_cents':str(self._remaining(conn,community,m)),
                'operation_on':m['operation_on'],'value_on':m['value_on'],'treasury_id':m['treasury_id'],
                'action':action,'amount_cents':str(n),'fact_id':fact['id'] if fact else None,'fact_version':fact['version'] if fact and 'version' in fact.keys() else None,
                'confidence':c.get('confidence','manual'),'rule':c.get('rule','manual-reviewed'),'economic_snapshot':economic_snapshot})
        for mid,n in used.items():
            m=self._row(conn,'erp_banco_movimientos',community,mid);remain=self._remaining(conn,community,m)
            if n*remain<0 or abs(n)>abs(remain):raise ConflictError('Asignacion supera el remanente bancario.')
            if net and n!=remain:raise ContractError('El grupo bruto/neto debe cuadrar completo con el remanente.')
        public={'components':rows,'remaining':[{'movement_id':mid,'after_cents':str(self._remaining(conn,community,self._row(conn,'erp_banco_movimientos',community,mid))-n)} for mid,n in used.items()],
                'effect':'review','net':net}
        public['preview_hash']=self.vault.fingerprint(community,'match-preview',{'payload':p,'public':public})
        return public

    def match_preview(self,session,env):
        def op(conn,actor,e,now):
            return self._proposal(conn,actor,e,now,'match',e.payload,self._components_plan(conn,session,e.community_id,e.payload))
        return self._write(session,env,'propose',op)

    @staticmethod
    def _economic(parent,command,key,payload,version=None):
        return CommandEnvelope.from_value({'command':'erp3.'+command,'id_comunidad':parent.community_id,'payload':payload,
            'idempotency_key':key,'expected_version':version,'origin':parent.origin,'reason':'Conciliacion bancaria revisada. Evidencia protegida ERP 5.',
            'evidence':{'type':'external_reference','id':'erp5-proposal:'+str(parent.payload['proposal_id'])}})

    def match_confirm(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('proposal_id',))
            proposal=self._row(conn,'erp_conciliacion_propuestas',e.community_id,p['proposal_id']);self._version(proposal,e.expected_version)
            if proposal['kind']!='match' or proposal['state']!='pendiente':raise ConflictError('Propuesta ya confirmada o incompatible.')
            data=self.vault.get(conn,e.community_id,proposal['secret_id'],'reconciliation-proposal');payload=data['payload']
            plan=self._components_plan(conn,session,e.community_id,payload)
            if plan['preview_hash']!=data['public']['preview_hash']:raise ConflictError('Han cambiado movimientos o hechos. Revisa de nuevo.')
            secret=self.vault.put(conn,e.community_id,'bank-match',{'proposal':proposal['id'],'plan':plan,'reason':e.reason},now)
            match=conn.execute('INSERT INTO erp_conciliaciones (id_comunidad,proposal_id,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?)',
                               (e.community_id,proposal['id'],secret,now,actor.user_id)).lastrowid
            economic=ReceivablesService.in_transaction(self.database_path,conn);components=[]
            for index,c in enumerate(payload['components']):
                row=plan['components'][index];action=c['action'];n=int(row['amount_cents']);fact=row['fact_id'];key='erp5-'+str(proposal['id'])+'-'+str(index)
                if action=='record_collection':
                    collection={'amount_cents':str(n),'currency':'EUR','effective_on':row['operation_on'],'method':'transferencia',
                        'external_source':'erp5','external_key':key,'treasury_reference':'erp4-treasury:'+str(row['treasury_id'])}
                    if row['value_on']:collection['value_on']=row['value_on']
                    if c.get('payer'):collection['payer']=c['payer']
                    fact=economic.collection_record(session,self._economic(e,'collection.record',key,collection))['entity']['id']
                    if c.get('allocations'):
                        allocation={'collection_id':fact,'effective_on':row['operation_on'],'allocations':c['allocations']}
                        preview=economic.allocation_preview(session,self._economic(e,'allocation.preview',key+'-ap',allocation))['entity']
                        economic.allocation_confirm(session,self._economic(e,'allocation.confirm',key+'-ac',{'proposal_id':preview['id']},preview['version']))
                    kind='collection'
                elif action=='record_outflow':
                    protected=self.vault.put(conn,e.community_id,'treasury-outflow',c,now)
                    fact=conn.execute('''INSERT INTO erp_tesoreria_salidas (id_comunidad,treasury_id,amount_cents,effective_on,kind,secret_id,external_key,registered_at,actor_id)
                        VALUES (?,?,?,?,?,?,?,?,?)''',(e.community_id,row['treasury_id'],-n,row['operation_on'],c['kind'],protected,key,now,actor.user_id)).lastrowid
                    kind='outflow';self._event(conn,e,'outflow.confirmed','outflow',fact,{'effect':'monetary','economic_fact_id':'erp5:outflow:'+str(fact),
                        'component_id':'funds','treasury_id':row['treasury_id'],'amount_cents':str(n),'currency':'EUR','operation_on':row['operation_on'],'kind':c['kind']})
                elif action=='return':
                    preview=economic.return_preview(session,self._economic(e,'return.preview',key+'-rp',c['return_payload']))['entity']
                    economic.return_confirm(session,self._economic(e,'return.confirm',key+'-rc',{'proposal_id':preview['id']},preview['version']))
                    fact=conn.execute('SELECT id FROM erp_devoluciones WHERE id_comunidad=? AND external_key=?',(e.community_id,c['return_payload']['external_key'])).fetchone()[0];kind='return'
                elif action=='bank_result':
                    bank=BankingService.in_transaction(self.database_path,conn,vault=self.vault)
                    bankplan=bank._result_plan(conn,session,e.community_id,c['bank_result'])
                    reviewed={**c['bank_result'],'preview_hash':bankplan['preview_hash']}
                    bankenv=replace(e,command='erp4.results.confirm',payload=reviewed,
                                    expected_version=bankplan['version'],idempotency_key=key+'-result')
                    result=bank.results_confirm(session,bankenv)['entity']
                    for br in result['applied']:
                        if not br['operation_id']:raise ConflictError('No hay identidad economica acreditada para esta linea.')
                        op_row=conn.execute('SELECT * FROM erp_banco_operaciones WHERE id_comunidad=? AND id=?',(e.community_id,br['operation_id'])).fetchone()
                        frozen=self.vault.get(conn,e.community_id,op_row['secret_id'],'bank-operation')['canonical']
                        amount=int(frozen['amount_cents'])*(1 if br['kind']=='settlement' else -1)
                        bankkind='collection' if br['kind']=='settlement' else 'return';bankfact=op_row['collection_id'] if bankkind=='collection' else op_row['return_id']
                        already=sum(r[0] for r in conn.execute(f'SELECT amount_cents FROM erp_conciliacion_componentes WHERE id_comunidad=? AND {bankkind}_id=?',
                                                              (e.community_id,bankfact)))
                        if already:raise ConflictError('Hecho de remesa ya conciliado; enlaza la evidencia existente.')
                        cid=conn.execute(f'''INSERT INTO erp_conciliacion_componentes (id_comunidad,match_id,movement_id,kind,{bankkind}_id,amount_cents,registered_at,actor_id)
                            VALUES (?,?,?,?,?,?,?,?)''',(e.community_id,match,row['movement_id'],bankkind,bankfact,amount,now,actor.user_id)).lastrowid
                        conn.execute('INSERT INTO erp_banco_operacion_vinculos (id_comunidad,movement_id,operation_id,registered_at,actor_id) VALUES (?,?,?,?,?)',
                                     (e.community_id,row['movement_id'],op_row['id'],now,actor.user_id));components.append(cid)
                    continue
                elif action=='refund':
                    preview=economic.refund_preview(session,self._economic(e,'refund.preview',key+'-fp',c['refund_payload']))['entity']
                    result=economic.refund_confirm(session,self._economic(e,'refund.confirm',key+'-fc',{'proposal_id':preview['id']},preview['version']))['entity']
                    event=result['event_ids'][0]
                    fact=conn.execute('SELECT id FROM erp_reintegros WHERE id_comunidad=? AND event_id=?',(e.community_id,event)).fetchone()[0];kind='refund'
                else:kind=action[5:]
                cid=conn.execute(f'''INSERT INTO erp_conciliacion_componentes
                    (id_comunidad,match_id,movement_id,kind,{kind}_id,amount_cents,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?)''',
                    (e.community_id,match,row['movement_id'],kind,fact,n,now,actor.user_id)).lastrowid
                components.append(cid)
            conn.execute("UPDATE erp_conciliacion_propuestas SET state='confirmada',version=version+1 WHERE id=?",(proposal['id'],))
            self._event(conn,e,'reconciliation.confirmed','match',match,{'effect':'link','component_ids':components,'proposal_id':proposal['id']})
            return {'id':match,'proposal_id':proposal['id'],'component_ids':components,'version':proposal['version']+1}
        return self._write(session,env,'confirm',op)

    def proposals_get(self,session,q):
        def op(conn,q):
            m=self._row(conn,'erp_banco_movimientos',q.community_id,q.filters['movement_id']);private=self.vault.get(conn,q.community_id,m['secret_id'],'bank-movement')
            remain=self._remaining(conn,q.community_id,m)
            if not remain or m['source_state']!='booked':return {'items':[],'movement':self._movement_public(conn,q.community_id,m)}
            ReceivablesService._session(conn,session,q.community_id,'read')
            profile=conn.execute("SELECT * FROM erp_conciliacion_perfiles WHERE id_comunidad=? AND treasury_id=? AND kind='matching' ORDER BY id DESC LIMIT 1",(q.community_id,m['treasury_id'])).fetchone()
            default_window=self.vault.get(conn,q.community_id,profile['secret_id'],'reconciliation-profile')['config']['window_days'] if profile else 7
            window=q.filters.get('window_days',default_window)
            if type(window) is not int or not 0<=window<=90:raise ContractError('Ventana de fechas entre 0 y 90 dias.')
            items=[]
            if remain<0:
                for kind,table in (('return','erp_devoluciones'),('refund','erp_reintegros'),('outflow','erp_tesoreria_salidas')):
                    for fact in conn.execute(f'SELECT * FROM {table} WHERE id_comunidad=? AND amount_cents=? ORDER BY id',(q.community_id,abs(m['amount_cents']))):
                        related=None if kind=='outflow' else conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND id=?',(q.community_id,fact['collection_id'])).fetchone()
                        correct=fact['treasury_id']==m['treasury_id'] if kind=='outflow' else related and related['treasury_reference']=='erp4-treasury:'+str(m['treasury_id'])
                        if not correct or abs((date.fromisoformat(fact['effective_on'])-date.fromisoformat(m['operation_on'])).days)>window:continue
                        used=abs(sum(r[0] for r in conn.execute(f'SELECT amount_cents FROM erp_conciliacion_componentes WHERE id_comunidad=? AND {kind}_id=?',(q.community_id,fact['id']))))
                        if used>=fact['amount_cents']:continue
                        items.append({'action':'link_'+kind,'fact_id':fact['id'],'amount_cents':str(-min(abs(remain),fact['amount_cents']-used)),
                            'confidence':'media','reason':'Salida existente del mismo importe y cuenta; revisar fecha e identidad',
                            'rule':'outgoing-amount-account-date-v1'})
                return {'items':items[:200],'truncated':len(items)>200,'movement':self._movement_public(conn,q.community_id,m),
                    'engine_version':'erp5-match-v3','window_days':window,'profile_id':profile['id'] if profile else None,'profile_version':profile['version'] if profile else None}
            for fact in conn.execute('SELECT * FROM erp_cobros WHERE id_comunidad=? AND amount_cents=?',(q.community_id,abs(m['amount_cents']))):
                if fact['treasury_reference']!='erp4-treasury:'+str(m['treasury_id']):continue
                distance=abs((date.fromisoformat(fact['effective_on'])-date.fromisoformat(m['operation_on'])).days)
                exact=bool(private.get('external_id') and fact['external_key']==private['external_id'] and fact['external_source']==private.get('namespace'))
                if not exact and distance>window:continue
                assigned=sum(r[0] for r in conn.execute('SELECT amount_cents FROM erp_conciliacion_componentes WHERE id_comunidad=? AND collection_id=?',(q.community_id,fact['id'])))
                if assigned>=fact['amount_cents']:continue
                items.append({'action':'link_collection','fact_id':fact['id'],'amount_cents':str(min(remain,fact['amount_cents']-assigned)),
                    'confidence':'alta' if exact else 'media','reason':'Referencia y cuenta exactas' if exact else 'Mismo importe/cuenta y fecha proxima; revisar identidad',
                    'rule':'external-reference-v1' if exact else 'amount-account-date-v1'})
            if not items:
                import re
                from .receivables_projection import receipt_balance
                reference=str(private.get('reference',''))+' '+str(private.get('concept',''))
                receipts=[]
                for receipt in conn.execute("SELECT * FROM erp_recibos WHERE id_comunidad=? AND currency='EUR' AND issued_on<=? ORDER BY id",(q.community_id,m['operation_on'])):
                    number=receipt['number']
                    if not number or not re.search(r'(?<![\w-])'+re.escape(number)+r'(?![\w-])',reference,re.IGNORECASE):continue
                    b=receipt_balance(conn,q.community_id,receipt['id'],m['operation_on']);pending=int(b['pending_cents'])
                    if pending>0:receipts.append((receipt,pending))
                    if len(receipts)>200:break
                if 0<len(receipts)<=200:
                    total=sum(n for _,n in receipts)
                    if len(receipts)==1 or total==remain:
                        n=min(remain,total)
                        items.append({'action':'record_collection','amount_cents':str(n),
                            'allocations':[{'receipt_id':r['id'],'amount_cents':str(min(n,p))} for r,p in receipts],
                            'confidence':'alta' if n==total and n==remain else 'media',
                            'reason':'Referencia exacta de recibo; confirmar fondos e identidad antes de registrar',
                            'rule':'receipt-reference-v1'})
            items.sort(key=lambda r:(r['confidence']!='alta',r.get('fact_id',0)))
            return {'items':items[:200],'truncated':len(items)>200,'movement':self._movement_public(conn,q.community_id,m),'engine_version':'erp5-match-v2',
                'window_days':window,'profile_id':profile['id'] if profile else None,'profile_version':profile['version'] if profile else None}
        return self._read(session,q,'propose',op)

    def match_reverse(self,session,env):
        def op(conn,actor,e,now):
            match=self._row(conn,'erp_conciliaciones',e.community_id,e.payload['id'])
            original=list(conn.execute('SELECT * FROM erp_conciliacion_componentes WHERE id_comunidad=? AND match_id=?',(e.community_id,match['id'])))
            if not original or any(c['reverses_id'] for c in original):raise ConflictError('No se puede compensar esa operacion.')
            if any(c['kind']=='transfer' for c in original):
                raise ConflictError('Una transferencia tiene extremos monetarios acreditados. No se desconcilia como un cobro; requiere rectificacion explicita.')
            secret=self.vault.put(conn,e.community_id,'bank-match',{'reverses':match['id'],'reason':e.reason},now)
            new=conn.execute('INSERT INTO erp_conciliaciones (id_comunidad,secret_id,registered_at,actor_id) VALUES (?,?,?,?)',(e.community_id,secret,now,actor.user_id)).lastrowid
            for c in original:
                m=self._row(conn,'erp_banco_movimientos',e.community_id,c['movement_id']);self._guard_open(conn,e.community_id,m['treasury_id'],m['operation_on'])
                if conn.execute('SELECT 1 FROM erp_conciliacion_componentes WHERE reverses_id=?',(c['id'],)).fetchone():raise ConflictError('Operacion ya desconciliada.')
                cols=('collection_id','return_id','refund_id','outflow_id','transfer_id')
                conn.execute('''INSERT INTO erp_conciliacion_componentes (id_comunidad,match_id,movement_id,kind,collection_id,return_id,refund_id,outflow_id,transfer_id,
                    amount_cents,reverses_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                    (e.community_id,new,m['id'],c['kind'],*(c[k] for k in cols),-c['amount_cents'],c['id'],now,actor.user_id))
            self._event(conn,e,'reconciliation.reversed','match',new,{'effect':'link','reverses_id':match['id']})
            return {'id':new,'reverses_id':match['id'],'economic_history_unchanged':True}
        return self._write(session,env,'correct',op)

    def _balances(self,conn,community,p):
        account=identity(p['treasury_id']);self._account(conn,community,account,active=False);start=day(p['start_on']);end=day(p['end_on'])
        coverage=conn.execute('''SELECT * FROM erp_extractos_coberturas WHERE id_comunidad=? AND treasury_id=?
            AND start_on=? AND end_on=? ORDER BY id DESC LIMIT 1''',(community,account,start,end)).fetchone()
        movements=[r for r in conn.execute('SELECT * FROM erp_banco_movimientos WHERE id_comunidad=? AND treasury_id=? AND operation_on>=? AND operation_on<=? AND source_state=?',
                                          (community,account,start,end,'booked')) if not conn.execute('SELECT 1 FROM erp_banco_movimiento_correcciones WHERE id_comunidad=? AND movement_id=?',(community,r['id'])).fetchone()]
        total=sum(r['amount_cents'] for r in movements)
        calculated=coverage['opening_cents']+total if coverage and coverage['opening_cents'] is not None else None
        reported=coverage['closing_cents'] if coverage else None
        comparable=bool(coverage and coverage['balance_type']=='booked')
        difference=reported-calculated if comparable and reported is not None and calculated is not None else None
        pending=[self._movement_public(conn,community,r) for r in movements if self._remaining(conn,community,r)]
        return {'treasury_id':account,'start_on':start,'end_on':end,'coverage_id':coverage['id'] if coverage else None,
            'complete':bool(coverage and coverage['complete']),'comparable':comparable,'opening_cents':str(coverage['opening_cents']) if coverage and coverage['opening_cents'] is not None else None,
            'reported_cents':str(reported) if reported is not None else None,'calculated_cents':str(calculated) if calculated is not None else None,
            'difference_cents':str(difference) if difference is not None else None,'movement_sum_cents':str(total),'movement_ids':[r['id'] for r in movements],
            'pending':pending,'can_close':difference==0 and comparable and bool(coverage['complete']) if coverage else False}

    def balances_get(self,session,q):return self._read(session,q,'read',lambda conn,q:self._balances(conn,q.community_id,q.filters))

    def pending_assign(self,session,env):
        def op(conn,actor,e,now):
            p=require_fields(e.payload,('movement_id','user_id','review_on','note'))
            self._row(conn,'erp_banco_movimientos',e.community_id,p['movement_id']);target=profile(conn,identity(p['user_id']))
            if not target or not permission(target,e.community_id,'puede_ver'):raise PermissionError('Responsable no disponible.')
            secret=self.vault.put(conn,e.community_id,'bank-pending',{'note':text(p['note'],'Motivo')},now)
            rid=conn.execute('INSERT INTO erp_conciliacion_pendientes (id_comunidad,movement_id,user_id,review_on,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?,?)',
                             (e.community_id,p['movement_id'],p['user_id'],day(p['review_on']),secret,now,actor.user_id)).lastrowid
            return {'id':rid,'movement_id':p['movement_id']}
        return self._write(session,env,'propose',op)

    def _closure_plan(self,conn,community,p):
        plan=self._balances(conn,community,p)
        if not plan['can_close']:raise ConflictError('Saldo no verificable, diferencia o cobertura incompleta. No se puede cerrar.')
        notes=[]
        for m in plan['pending']:
            note=conn.execute('SELECT * FROM erp_conciliacion_pendientes WHERE id_comunidad=? AND movement_id=? ORDER BY id DESC LIMIT 1',(community,m['id'])).fetchone()
            if not note:raise ConflictError('Documenta responsable, fecha y motivo de cada pendiente antes de cerrar.')
            notes.append({'movement_id':m['id'],'remaining_cents':m['remaining_cents'],'pending_id':note['id'],'user_id':note['user_id'],'review_on':note['review_on']})
        plan['pending_notes']=notes
        plan['links']=[dict(r) for mid in plan['movement_ids'] for r in conn.execute('SELECT * FROM erp_conciliacion_componentes WHERE id_comunidad=? AND movement_id=?',(community,mid))]
        plan['preview_hash']=self.vault.fingerprint(community,'closure',plan)
        return plan

    def closure_preview(self,session,env):
        return self._write(session,env,'close',lambda conn,actor,e,now:self._proposal(conn,actor,e,now,'closure',e.payload,self._closure_plan(conn,e.community_id,e.payload)))

    def closure_confirm(self,session,env):
        def op(conn,actor,e,now):
            r=self._row(conn,'erp_conciliacion_propuestas',e.community_id,e.payload['proposal_id']);self._version(r,e.expected_version)
            if r['state']!='pendiente' or r['kind']!='closure':raise ConflictError('Propuesta de cierre no disponible.')
            data=self.vault.get(conn,e.community_id,r['secret_id'],'reconciliation-proposal');plan=self._closure_plan(conn,e.community_id,data['payload'])
            if plan['preview_hash']!=data['public']['preview_hash']:raise ConflictError('Han cambiado los datos del cierre.')
            if conn.execute("SELECT 1 FROM erp_conciliacion_cierres WHERE id_comunidad=? AND treasury_id=? AND state!='reabierto' AND start_on<=? AND end_on>=?",
                            (e.community_id,plan['treasury_id'],plan['end_on'],plan['start_on'])).fetchone():raise ConflictError('Periodo ya cerrado o solapado.')
            secret=self.vault.put(conn,e.community_id,'bank-closure',plan,now);state='cerrado_pendientes' if plan['pending'] else 'cerrado'
            rid=conn.execute('INSERT INTO erp_conciliacion_cierres (id_comunidad,treasury_id,start_on,end_on,secret_id,state,registered_at,actor_id) VALUES (?,?,?,?,?,?,?,?)',
                             (e.community_id,plan['treasury_id'],plan['start_on'],plan['end_on'],secret,state,now,actor.user_id)).lastrowid
            conn.execute("UPDATE erp_conciliacion_propuestas SET state='confirmada',version=version+1 WHERE id=?",(r['id'],))
            self._event(conn,e,'closure.closed','closure',rid,{'effect':'evidence','state':state,'treasury_id':plan['treasury_id']})
            return {'id':rid,'version':1,'state':state,'pending_count':len(plan['pending'])}
        return self._write(session,env,'close',op)

    def closure_reopen(self,session,env):
        def op(conn,actor,e,now):
            r=self._row(conn,'erp_conciliacion_cierres',e.community_id,e.payload['id']);self._version(r,e.expected_version)
            if r['state']=='reabierto':raise ConflictError('El cierre ya esta reabierto.')
            secret=self.vault.put(conn,e.community_id,'bank-closure-reopen',{'previous_secret_id':r['secret_id'],'reason':e.reason},now)
            conn.execute('INSERT INTO erp_conciliacion_cierre_eventos (id_comunidad,closure_id,kind,secret_id,registered_at,actor_id) VALUES (?,?,?,?,?,?)',
                         (e.community_id,r['id'],'reopen',secret,now,actor.user_id))
            conn.execute("UPDATE erp_conciliacion_cierres SET state='reabierto',version=version+1 WHERE id=?",(r['id'],))
            self._event(conn,e,'closure.reopened','closure-reopen',secret,{'effect':'evidence','closure_id':r['id']})
            return {'id':r['id'],'version':r['version']+1,'state':'reabierto'}
        return self._write(session,env,'reopen',op)

    def closure_list(self,session,q):
        return self._read(session,q,'read',lambda conn,q:{'items':[{k:v for k,v in dict(r).items() if k!='secret_id'} for r in conn.execute(
            'SELECT * FROM erp_conciliacion_cierres WHERE id_comunidad=? AND treasury_id=? ORDER BY id DESC',(q.community_id,identity(q.filters['treasury_id'])))]})
