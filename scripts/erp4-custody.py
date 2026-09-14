"""Explicit Ubuntu key provisioning. Does not enable banking or touch business data."""
import hashlib
import json
import os
from pathlib import Path
import sys

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'server'))
from erp_core.banking_crypto import BankVault

directory=Path.home()/'.config/organizador-web'
if os.name!='posix' or Path.home()!=Path('/home/coordinador'):
    raise SystemExit('Run only as the configured Ubuntu application user.')
directory.mkdir(mode=0o700,parents=True,exist_ok=True)
if directory.is_symlink() or directory.stat().st_mode&0o077:
    raise SystemExit('Custody directory must be private, without symbolic links.')
key=directory/'erp4-keys.json'
if not key.exists():BankVault.create_key_file(key)
vault=BankVault(key)
payload=os.urandom(32);aad=b'erp4-custody-recovery-check'
sealed=vault._encrypt(vault.keks[vault.active_kek],payload,aad)
assert vault._decrypt(vault.keks[vault.active_kek],sealed,aad)==payload
print(json.dumps({'key_file':str(key),'sha256':hashlib.sha256(key.read_bytes()).hexdigest(),
    'private_permissions':True,'encryption_verified':True,'banking_enabled':False}))
