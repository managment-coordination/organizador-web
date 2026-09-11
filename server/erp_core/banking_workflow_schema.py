"""Versioned bank profiles and append-only instruction outcomes."""

from .banking_schema import table, immutable, STAMP

STATEMENTS = (
    table('erp_banca_configuraciones', f"""
        creditor_id INTEGER NOT NULL, version INTEGER NOT NULL CHECK(version>0),
        secret_id TEXT NOT NULL, {STAMP}, UNIQUE(creditor_id,version),
        FOREIGN KEY(id_comunidad,creditor_id) REFERENCES erp_acreedor_versiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    table('erp_remesa_perfiles', f"""
        revision_id INTEGER NOT NULL UNIQUE, config_id INTEGER NOT NULL, {STAMP},
        FOREIGN KEY(id_comunidad,revision_id) REFERENCES erp_remesa_revisiones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,config_id) REFERENCES erp_banca_configuraciones(id_comunidad,id)
    """),
    table('erp_banca_linea_eventos', f"""
        line_id INTEGER NOT NULL, result_line_id INTEGER, operation_id INTEGER,
        kind TEXT NOT NULL CHECK(kind IN ('technical','pending','rejected','settlement','returned','cancelled','conflict')),
        effective_on TEXT NOT NULL, secret_id TEXT NOT NULL, {STAMP},
        FOREIGN KEY(id_comunidad,line_id) REFERENCES erp_remesa_lineas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,result_line_id) REFERENCES erp_resultado_lineas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,operation_id) REFERENCES erp_banco_operaciones(id_comunidad,id),
        FOREIGN KEY(id_comunidad,secret_id) REFERENCES erp_banca_secretos(id_comunidad,id)
    """),
    "CREATE INDEX erp_banca_linea_eventos_history ON erp_banca_linea_eventos(id_comunidad,line_id,effective_on,id)",
    table('erp_banca_resultado_aplicaciones', f"""
        result_line_id INTEGER NOT NULL UNIQUE, event_id INTEGER NOT NULL, {STAMP},
        FOREIGN KEY(id_comunidad,result_line_id) REFERENCES erp_resultado_lineas(id_comunidad,id),
        FOREIGN KEY(id_comunidad,event_id) REFERENCES erp_banca_linea_eventos(id_comunidad,id)
    """),
    """CREATE TABLE erp_banca_descargas (
        token TEXT PRIMARY KEY, id_comunidad INTEGER NOT NULL, file_id INTEGER NOT NULL,
        actor_id INTEGER NOT NULL REFERENCES usuarios(id_usuario), auth_version INTEGER NOT NULL,
        expires_at TEXT NOT NULL, registered_at TEXT NOT NULL,
        FOREIGN KEY(id_comunidad,file_id) REFERENCES erp_remesa_ficheros(id_comunidad,id)
    )""",
) + tuple(sql for name in ('erp_banca_configuraciones','erp_remesa_perfiles','erp_banca_linea_eventos','erp_banca_resultado_aplicaciones') for sql in immutable(name))
