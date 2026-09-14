"""Prepare a guarded Linux-only acceptance copy, never the deployed application."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
from contextlib import closing
from datetime import datetime,timedelta,timezone

ROOT=Path(__file__).resolve().parents[1]
base=Path(sys.argv[1]).resolve(strict=True)
if os.name!='posix' or not base.name.startswith('organizador-web-erp4-validation-') or ROOT!=base/'app':
    raise SystemExit('Only an isolated ERP4 Linux validation directory is permitted.')
base.chmod(0o700)
sys.path.insert(0,str(ROOT/'server'))
from erp_core.banking_service import BankingService
from erp_core.banking_crypto import BankVault
from erp_core.database import connect
from erp_core.migrations import apply_all
from erp_core.contracts import QueryEnvelope
from access_control import profile

key=base/'test-custody.key';key.chmod(0o600)
data=ROOT/'data';data.mkdir(exist_ok=True)
db=data/'acceptance.db'
if db.exists():raise SystemExit('Do not overwrite an existing acceptance copy.')
with closing(sqlite3.connect(base/'database.db')) as src,closing(sqlite3.connect(db)) as dst:src.backup(dst)
config=json.loads((base/'browser-fixture.json').read_text())
uid=config['session']['id_usuario'];community=config['community']
password='synthetic-linux-acceptance-only';salt=os.urandom(16).hex()
digest=hashlib.pbkdf2_hmac('sha256',password.encode(),salt.encode(),260000).hex()
conn=connect(db);apply_all(conn)
conn.execute("UPDATE usuarios SET nombre='ERP4 Acceptance',password_hash=?,password_configurada=1,requiere_cambio_password=0,bloqueado=0 WHERE id_usuario=?",('pbkdf2_sha256$260000$'+salt+'$'+digest,uid))
session=profile(conn,uid)
os.environ.update(ERP4_BANKING_ENABLED='1',ERP4_HTTPS_READY='1',ERP4_KEY_FILE=str(key),ERP4_LIVE_BANKING_ENABLED='0')
service=BankingService.from_runtime(db)
service.account_list(session,QueryEnvelope('erp4.account.list',community,{}))
signature=[]
for row in conn.execute('SELECT * FROM erp_banca_secretos ORDER BY id'):
    value=service.vault.get(conn,community,row['id'],row['purpose'])
    signature.append(hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest())
recovery=base/'recovery';recovery.mkdir(mode=0o700)
recovery_key=recovery/'custody.key'
fd=os.open(recovery_key,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'wb') as f:f.write(key.read_bytes())
restored=recovery/'restored.db'
with closing(sqlite3.connect(restored)) as dst:conn.backup(dst)
with closing(connect(restored,readonly=True)) as restored_conn:
    vault=BankVault(recovery_key)
    after=[hashlib.sha256(json.dumps(vault.get(restored_conn,r['id_comunidad'],r['id'],r['purpose']),sort_keys=True).encode()).hexdigest() for r in restored_conn.execute('SELECT * FROM erp_banca_secretos ORDER BY id')]
    assert signature==after and signature
    assert restored_conn.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not restored_conn.execute('PRAGMA foreign_key_check').fetchall()
conn.close()
from cryptography import x509
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
import ipaddress
private=rsa.generate_private_key(public_exponent=65537,key_size=2048)
subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'ERP4 isolated localhost')]);now=datetime.now(timezone.utc)
cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(private.public_key()).serial_number(x509.random_serial_number())
    .not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=1))
    .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(private,hashes.SHA256()))
fd=os.open(base/'tls.key',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'wb') as f:f.write(private.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
(base/'tls.crt').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
proof={'ok':True,'runtime_posix':True,'secrets_restored':True,'live_enabled':False,'synthetic_only':True,'community':community,'user_id':uid}
(base/'linux-proof.json').write_text(json.dumps(proof))
print(json.dumps(proof))
