"""Isolated browser/domain fixture. Never used by the production server."""
from pathlib import Path
import base64
import json
import runpy
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'server'))

def main():
    if sys.argv[1]=='create':
        source=sys.argv[2]
        sys.argv=[str(ROOT/'scripts/verify-erp4-foundations.py'),source]
        tests=runpy.run_path(str(ROOT/'scripts/verify-erp4-foundations.py'))
        fixture=tests['BankingTests']('test_74_operational_selectors_use_same_domain_and_tenant')
        fixture.setUp()
        p,m=fixture.remittance_setup()
        for cap in tests['CAPABILITIES']:
            if not fixture.conn.execute('SELECT 1 FROM erp_banca_permisos WHERE id_comunidad=? AND id_usuario=? AND capability=?',(fixture.community,fixture.uid,cap)).fetchone():fixture.grant(cap)
        target=fixture.work/'browser-fixture.json'
        config={'db':str(fixture.db),'key':str(fixture.key),'session':fixture.session,'community':fixture.community,
                'creditor_id':p['creditor_id'],'mandate_id':m['id'],'requested_on':p['requested_on'],'receipt_ids':p['receipt_ids']}
        target.write_text(json.dumps(config),encoding='utf8')
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes,serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        from datetime import datetime,timedelta,timezone
        import ipaddress
        private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])
        now=datetime.now(timezone.utc)
        certificate=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(private.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
            .sign(private,hashes.SHA256()))
        (fixture.work/'tls.key').write_bytes(private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        (fixture.work/'tls.crt').write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        fixture.conn.close()
        print(json.dumps({'fixture':str(target)}))
        return
    path=Path(sys.argv[2]).resolve()
    if not any(p.name.startswith('organizador-erp4-foundations-') for p in path.parents):
        raise RuntimeError('Only isolated test fixture paths are permitted.')
    config=json.loads(path.read_text(encoding='utf8'))
    if Path(config['db']).parent!=path.parent or Path(config['key']).parent!=path.parent:
        raise RuntimeError('Fixture scope mismatch.')
    from erp_core.banking_service import BankingService,COMMAND_NAMES
    from erp_core.banking_crypto import BankVault
    from erp_core.contracts import CommandEnvelope,QueryEnvelope
    from erp_core.errors import ContractError,ConflictError,NotFoundError
    service=BankingService(config['db'],vault=BankVault(config['key']))
    try:
        request=json.load(sys.stdin);value=request['envelope'];session=request['session'];action=request['action']
        if session['id_usuario']!=config['session']['id_usuario']:raise PermissionError('Fixture user mismatch.')
        if action=='command':
            env=CommandEnvelope.from_value(value)
            if env.command not in COMMAND_NAMES:raise NotFoundError('Comando no disponible.')
            result=getattr(service,env.command[5:].replace('.','_'))(session,env)
        elif action=='query':
            query=QueryEnvelope.from_value(value)
            allowed=runpy.run_path(str(ROOT/'server/banking-bridge.py'))['QUERIES']
            if query.query[5:] not in allowed:raise NotFoundError('Consulta no disponible.')
            result=getattr(service,query.query[5:].replace('.','_'))(session,query)
        elif action=='download':result={'ok':True,'content_base64':base64.b64encode(service.download_bytes(session,value['id_comunidad'],value['token'])).decode()}
        elif action=='reveal':result=service.reveal_account(session,value['id_comunidad'],value['account_id'],value['reason'])
        elif action=='document':result=service.document_download(session,value['id_comunidad'],value['document_id'],value['reason'])
        else:raise NotFoundError('Accion no disponible.')
        print(json.dumps(result))
    except (ContractError,ConflictError,NotFoundError,PermissionError) as error:
        print(json.dumps({'ok':False,'error_type':type(error).__name__,'error':str(error)}))

if __name__=='__main__':main()
