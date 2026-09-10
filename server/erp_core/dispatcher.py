"""Allow-listed ERP tools. There is deliberately no arbitrary SQL command."""

import os

from .contracts import CommandEnvelope, QueryEnvelope
from .errors import NotFoundError
from .service import FoundationService
from .master_service import MasterDataService


COMMANDS = {
    "erp1.community.update": "community_update",
    "erp1.exercise.save": "exercise_save",
    "erp1.exercise.lock": "exercise_lock",
    "erp1.aggregation.save": "aggregation_save",
    "erp1.property.save": "property_save",
    "erp1.property.alias.save": "property_alias_save",
    "erp1.property.relation.save": "property_relation_save",
    "erp1.property.aggregation.save": "property_aggregation_save",
    "erp1.owner.save": "owner_save",
    "erp1.owner.contact.save": "contact_save",
    "erp1.ownership.propose": "ownership_propose",
    "erp1.ownership.confirm": "ownership_confirm",
    "erp1.group.save": "group_save",
    "erp1.group.configure": "group_configure",
    "erp1.group.membership.save": "membership_save",
    "erp1.coefficient.save": "coefficient_save",
    "erp1.provenance.record": "provenance_record",
}

QUERIES = {
    "erp1.community.get": "community_get",
    "erp1.exercise.list": "exercise_list",
    "erp1.property.list": "property_list",
    "erp1.property.get": "property_get",
    "erp1.owner.list": "owner_list",
    "erp1.owner.get": "owner_get",
    "erp1.ownership.list": "ownership_list",
    "erp1.ownership.known_at": "ownership_list",
    "erp1.coefficient.get": "coefficient_get",
    "erp1.group.list": "group_list",
    "erp1.group.get": "group_list",
    "erp1.group.members": "group_list",
}


def execute_command(database_path, session, value):
    envelope = CommandEnvelope.from_value(value)
    if envelope.command in COMMANDS:
        return getattr(MasterDataService(database_path), COMMANDS[envelope.command])(session, envelope)
    if envelope.command == "erp0.foundation.set_status" and os.environ.get("ERP0_REFERENCE_COMMANDS") == "1":
        return FoundationService(database_path).set_status(session, envelope)
    raise NotFoundError("Comando ERP no registrado o no habilitado.")


def execute_query(database_path, session, value):
    query = QueryEnvelope.from_value(value)
    if query.query in QUERIES:
        return getattr(MasterDataService(database_path), QUERIES[query.query])(session, query)
    if query.query == "erp0.foundation.get_status":
        return FoundationService(database_path).get_status(session, query)
    raise NotFoundError("Consulta ERP no registrada.")


def catalog():
    return {
        "contract_version": "erp_internal_v1",
        "queries": ["erp0.foundation.get_status", *sorted(QUERIES)],
        "commands": sorted(COMMANDS) + (["erp0.foundation.set_status"] if os.environ.get("ERP0_REFERENCE_COMMANDS") == "1" else []),
        "arbitrary_sql": False,
    }
