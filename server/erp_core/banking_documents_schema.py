"""Encrypted storage/ACL metadata, reusing the existing document catalogue."""

from .banking_schema import immutable

STATEMENTS=(
    'CREATE UNIQUE INDEX erp_document_catalogue_scope ON documentos_importados(id_comunidad,id_documento)',
    '''CREATE TABLE erp_banca_documentos (
        document_id INTEGER PRIMARY KEY, id_comunidad INTEGER NOT NULL, secret_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('mandate','account','creditor','result')),
        registered_at TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario),
        UNIQUE(id_comunidad,fingerprint),
        FOREIGN KEY(id_comunidad,document_id) REFERENCES documentos_importados(id_comunidad,id_documento),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id))''',
    '''CREATE TRIGGER erp_bank_catalogue_guard BEFORE UPDATE ON documentos_importados
        WHEN EXISTS (SELECT 1 FROM erp_banca_documentos WHERE document_id=OLD.id_documento)
        BEGIN SELECT RAISE(ABORT,'Protected bank document is immutable'); END''',
    '''CREATE TRIGGER erp_bank_catalogue_delete_guard BEFORE DELETE ON documentos_importados
        WHEN EXISTS (SELECT 1 FROM erp_banca_documentos WHERE document_id=OLD.id_documento)
        BEGIN SELECT RAISE(ABORT,'Protected bank document cannot be deleted'); END''',
) + tuple(immutable('erp_banca_documentos'))
