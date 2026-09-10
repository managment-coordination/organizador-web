"""Allow-listed ERP tools. There is deliberately no arbitrary SQL command."""

import os

from .contracts import CommandEnvelope, QueryEnvelope
from .errors import NotFoundError
from .service import FoundationService


def execute_command(database_path, session, value):
    envelope = CommandEnvelope.from_value(value)
    if envelope.command == "erp0.foundation.set_status" and os.environ.get("ERP0_REFERENCE_COMMANDS") == "1":
        return FoundationService(database_path).set_status(session, envelope)
    raise NotFoundError("Comando ERP no registrado o no habilitado.")


def execute_query(database_path, session, value):
    query = QueryEnvelope.from_value(value)
    if query.query == "erp0.foundation.get_status":
        return FoundationService(database_path).get_status(session, query)
    raise NotFoundError("Consulta ERP no registrada.")


def catalog():
    return {
        "contract_version": "erp_internal_v1",
        "queries": ["erp0.foundation.get_status"],
        "commands": ["erp0.foundation.set_status"] if os.environ.get("ERP0_REFERENCE_COMMANDS") == "1" else [],
        "arbitrary_sql": False,
    }
