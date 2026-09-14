"""Protected HTTPS browser fixture over an independent synthetic SQLite copy."""
import ipaddress
import json
from pathlib import Path
import runpy
import sys
from datetime import datetime,timedelta,timezone

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'server'))


def main():
    if sys.argv[1]=='create':
        source=sys.argv[2];sys.argv=[sys.argv[0],source]
        tests=runpy.run_path(str(ROOT/'scripts/verify-erp5-foundations.py'))
        fixture=tests['ReconciliationTests']('test_01_migration_reentrant_history');fixture._testMethodName='browser';fixture.setUp()
        from erp_core.banking_service import BankingService
        bank=BankingService(fixture.db,vault=fixture.vault)
        for cap in ('read_masked','results','export','reveal'):bank.permissions_save(fixture.session,fixture.e4('permissions.save',{'user_id':fixture.uid,'capability':cap,'allowed':True},0))
        config={'db':str(fixture.db),'key':str(fixture.work/'custody.key'),'community':fixture.community,
                'account':fixture.account,'session':fixture.session}
        target=fixture.work/'browser.json';target.write_text(json.dumps(config),encoding='utf8')
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes,serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048);now=datetime.now(timezone.utc)
        name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
        certificate=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256()))
        (fixture.work/'tls.key').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        (fixture.work/'tls.crt').write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        fixture.conn.close();print(json.dumps({'fixture':str(target)}));return
    path=Path(sys.argv[2]).resolve()
    if not any(p.name.startswith('organizador-erp5-foundations-') for p in path.parents):raise RuntimeError('Isolated fixture required')
    config=json.loads(path.read_text(encoding='utf8'))
    if Path(config['db']).parent!=path.parent or Path(config['key']).parent!=path.parent:raise RuntimeError('Fixture scope mismatch')
    from erp_core.reconciliation_service import ReconciliationService,COMMANDS,QUERIES
    from erp_core.banking_crypto import BankVault
    from erp_core.contracts import CommandEnvelope,QueryEnvelope
    from erp_core.errors import ContractError,ConflictError,NotFoundError
    service=ReconciliationService(config['db'],vault=BankVault(config['key']))
    request=json.load(sys.stdin)
    try:
        session=request['session'];value=request['envelope']
        if session['id_usuario']!=config['session']['id_usuario']:raise PermissionError('Fixture user mismatch')
        if request['action']=='command':
            env=CommandEnvelope.from_value(value)
            if env.command not in COMMANDS:raise NotFoundError('Comando no disponible')
            result=getattr(service,env.command[5:].replace('.','_'))(session,env)
        elif request['action']=='query':
            query=QueryEnvelope.from_value(value)
            if query.query.startswith('erp4.'):
                from erp_core.banking_service import BankingService
                if query.query[5:] not in ('results.list','results.get','results.choices'):raise NotFoundError('Consulta no disponible')
                result=getattr(BankingService(config['db'],vault=service.vault),query.query[5:].replace('.','_'))(session,query)
            else:
                if query.query[5:] not in QUERIES:raise NotFoundError('Consulta no disponible')
                result=getattr(service,query.query[5:].replace('.','_'))(session,query)
        elif request['action']=='statement-original':result=service.statement_original(session,value['id_comunidad'],value['import_id'],value['reason'])
        else:raise NotFoundError('Accion no disponible')
        print(json.dumps(result))
    except (ContractError,ConflictError,NotFoundError,PermissionError) as error:
        print(json.dumps({'ok':False,'error_type':type(error).__name__,'error':str(error)}))


if __name__=='__main__':main()
