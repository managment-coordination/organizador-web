"""Bank vault: authenticated encryption, tenant binding and separately keyed indexes."""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import stat
import uuid

from .contracts import canonical_json
from .errors import ContractError


def _b64(value):
    return base64.b64encode(value).decode('ascii')


def _unb64(value):
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise ContractError('La configuracion criptografica no es valida.') from None


class BankVault:
    def __init__(self, key_file):
        if Path(key_file).is_symlink():
            raise ContractError('Se requiere un archivo de claves privado, no un enlace.')
        self.path = Path(key_file).resolve(strict=True)
        if not self.path.is_file() or self.path.is_symlink():
            raise ContractError('Se requiere un archivo de claves privado.')
        if os.name == 'posix':
            info = self.path.stat()
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
                raise ContractError('El archivo de claves debe ser privado del usuario de servicio.')
        try:
            value = json.loads(self.path.read_text(encoding='utf-8'))
            self.keks = {k: _unb64(v) for k, v in value['encryption_keys'].items()}
            self.index_keys = {k: _unb64(v) for k, v in value['index_keys'].items()}
            self.active_kek = value['active_encryption_key']
            self.active_index = value['active_index_key']
            if not self.keks or not self.index_keys or any(len(k) != 32 for k in (*self.keks.values(), *self.index_keys.values())):
                raise ValueError()
            if self.active_kek not in self.keks or self.active_index not in self.index_keys:
                raise ValueError()
            if set(self.keks.values()) & set(self.index_keys.values()):
                raise ValueError()
        except (KeyError, ValueError, TypeError, AttributeError):
            raise ContractError('El archivo de claves bancarias no cumple el contrato.') from None

    @staticmethod
    def create_key_file(path):
        """Explicit provisioning only. Refuse overwrites; never called at app startup."""
        path = Path(path)
        value = {'active_encryption_key': 'enc-1', 'active_index_key': 'idx-1',
                 'encryption_keys': {'enc-1': _b64(os.urandom(32))},
                 'index_keys': {'idx-1': _b64(os.urandom(32))}}
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(canonical_json(value))
        return path

    @staticmethod
    def _encrypt(key, value, aad):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce = os.urandom(12)
        return {'nonce': _b64(nonce), 'ciphertext': _b64(AESGCM(key).encrypt(nonce, value, aad))}

    @staticmethod
    def _decrypt(key, value, aad):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        try:
            return AESGCM(key).decrypt(_unb64(value['nonce']), _unb64(value['ciphertext']), aad)
        except Exception:
            raise ContractError('No se puede verificar la integridad del dato bancario.') from None

    def _dek(self, conn, community, *, create=False):
        row = conn.execute('SELECT wrapped_key FROM erp_banca_claves WHERE id_comunidad=?', (community,)).fetchone()
        aad = ('erp4:dek:' + str(community)).encode()
        if row:
            try:
                wrapped = json.loads(row[0])
                key = self.keks[wrapped['key_id']]
            except (ValueError, KeyError):
                raise ContractError('No esta disponible la clave bancaria requerida.') from None
            return self._decrypt(key, wrapped, aad)
        if not create or not conn.in_transaction:
            raise ContractError('No existe una clave bancaria habilitada para esta comunidad.')
        key = os.urandom(32)
        wrapped = self._encrypt(self.keks[self.active_kek], key, aad)
        wrapped['key_id'] = self.active_kek
        conn.execute('INSERT INTO erp_banca_claves(id_comunidad,wrapped_key) VALUES (?,?)', (community, canonical_json(wrapped)))
        return key

    def put(self, conn, community, purpose, value, now):
        identity = uuid.uuid4().hex
        aad = canonical_json([community, identity, purpose, 1]).encode()
        encrypted = self._encrypt(self._dek(conn, community, create=True), canonical_json(value).encode(), aad)
        conn.execute('INSERT INTO erp_banca_secretos(id,id_comunidad,purpose,sealed,registered_at) VALUES (?,?,?,?,?)',
                     (identity, community, purpose, canonical_json(encrypted), now))
        return identity

    def get(self, conn, community, identity, purpose):
        row = conn.execute('SELECT * FROM erp_banca_secretos WHERE id_comunidad=? AND id=? AND purpose=?',
                           (community, identity, purpose)).fetchone()
        if not row:
            raise ContractError('No se encuentra el dato bancario autorizado.')
        aad = canonical_json([community, identity, purpose, row['version']]).encode()
        try:
            value = json.loads(row['sealed'])
            return json.loads(self._decrypt(self._dek(conn, community), value, aad))
        except (ValueError, KeyError, TypeError):
            raise ContractError('No se puede verificar la integridad del dato bancario.') from None

    def fingerprints(self, community, namespace, value):
        message = canonical_json([community, namespace, value]).encode()
        return {name: hmac.new(key, message, hashlib.sha256).hexdigest() for name, key in self.index_keys.items()}

    def fingerprint(self, community, namespace, value):
        return self.fingerprints(community, namespace, value)[self.active_index]

    def rewrap(self, conn, community):
        """Rotate only the KEK wrapper; logical snapshots and payload bytes stay intact."""
        if not conn.in_transaction:
            raise ContractError('La rotacion requiere una transaccion.')
        key = self._dek(conn, community)
        wrapped = self._encrypt(self.keks[self.active_kek], key, ('erp4:dek:' + str(community)).encode())
        wrapped['key_id'] = self.active_kek
        conn.execute('UPDATE erp_banca_claves SET wrapped_key=?,key_version=key_version+1 WHERE id_comunidad=?',
                     (canonical_json(wrapped), community))
