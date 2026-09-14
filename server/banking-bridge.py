"""Private banking process boundary. Never expose through generic ERP/AI routes."""

import base64
import json
import sys

from erp_core.banking_service import BankingService, COMMAND_NAMES
from erp_core.reconciliation_service import ReconciliationService, COMMANDS as ERP5_COMMANDS, QUERIES as ERP5_QUERIES
from erp_core.contracts import CommandEnvelope, QueryEnvelope
from erp_core.errors import ContractError, ConflictError, NotFoundError

QUERIES = {
    'workspace.get','creditor.list','account.list','mandate.list','mandate.detail',
    'direct_debit.list','remittance.list','remittance.get','results.list','results.get','import.get','control.list',
    'reference.list','permissions.get','receipt.candidates','results.choices','profile.get','document.list','mandate.edit','instruction.find','notification.draft',
}


def main():
    request=json.load(sys.stdin)
    service=BankingService.from_runtime(sys.argv[1])
    session=request.get('session')
    action=request.get('action')
    value=request.get('envelope') or {}
    if action=='command':
        env=CommandEnvelope.from_value(value)
        if env.command in ERP5_COMMANDS:
            erp5=ReconciliationService(service.database_path,vault=service.vault)
            return getattr(erp5,env.command[5:].replace('.','_'))(session,env)
        if env.command not in COMMAND_NAMES:raise NotFoundError('Operacion bancaria no disponible.')
        return getattr(service,env.command[5:].replace('.','_'))(session,env)
    if action=='query':
        query=QueryEnvelope.from_value(value)
        if query.query.startswith('erp5.') and query.query[5:] in ERP5_QUERIES:
            erp5=ReconciliationService(service.database_path,vault=service.vault)
            return getattr(erp5,query.query[5:].replace('.','_'))(session,query)
        name=query.query[5:] if query.query.startswith('erp4.') else ''
        if name not in QUERIES:raise NotFoundError('Consulta bancaria no disponible.')
        return getattr(service,name.replace('.','_'))(session,query)
    if action=='download':
        data=service.download_bytes(session,value.get('id_comunidad'),value.get('token'))
        return {'ok':True,'content_base64':base64.b64encode(data).decode('ascii')}
    if action=='reveal':
        return service.reveal_account(session,value.get('id_comunidad'),value.get('account_id'),value.get('reason'))
    if action=='document':
        return service.document_download(session,value.get('id_comunidad'),value.get('document_id'),value.get('reason'))
    if action=='statement-original':
        return ReconciliationService(service.database_path,vault=service.vault).statement_original(session,
            value.get('id_comunidad'),value.get('import_id'),value.get('reason'))
    raise NotFoundError('Operacion bancaria no disponible.')


if __name__=='__main__':
    try:
        print(json.dumps(main(),ensure_ascii=False))
    except (ContractError,ConflictError,NotFoundError,PermissionError) as error:
        print(json.dumps({'ok':False,'error_type':type(error).__name__,'error':str(error)},ensure_ascii=False))
        sys.exit(1)
    except Exception:
        # Tracebacks, XML validation details and subprocess arguments may contain bank data.
        print(json.dumps({'ok':False,'error_type':'BankingTechnicalError',
                          'error':'No se pudo completar la operacion bancaria. No se ha confirmado el cambio.'}))
        sys.exit(1)
