"""Allow-listed ERP tools. There is deliberately no arbitrary SQL command."""

import os

from .contracts import CommandEnvelope, QueryEnvelope
from .errors import NotFoundError
from .service import FoundationService
from .master_service import MasterDataService
from .onboarding_service import OnboardingService
from .budget_service import BudgetService
from .budget_contracts import contract_catalog as budget_contract_catalog
from .receivables_service import ReceivablesService


COMMANDS = {
    "erp1.community.update": "community_update",
    "erp1.exercise.save": "exercise_save",
    "erp1.exercise.lock": "exercise_lock",
    "erp1.aggregation.save": "aggregation_save",
    "erp1.aggregation.configure": "aggregation_configure",
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

ONBOARDING_COMMANDS = {
    "erp1.onboarding.preview": "preview",
    "erp1.onboarding.confirm": "confirm",
}

ONBOARDING_QUERIES = {
    "erp1.onboarding.get": "get",
    "erp1.onboarding.list": "list",
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

ERP2_COMMANDS = {
    "erp2.budget.create": "budget_create",
    "erp2.budget.copy": "budget_copy",
    "erp2.budget.amend": "budget_copy",
    "erp2.budget.save": "budget_save",
    "erp2.budget.import.preview": "budget_import_preview",
    "erp2.budget.import.confirm": "budget_import_confirm",
    "erp2.budget.simulate": "budget_simulate",
    "erp2.budget.propose": "budget_propose",
    "erp2.budget.approve": "budget_approve",
    "erp2.budget.close": "budget_close",
    "erp2.assessment.save": "assessment_save",
    "erp2.assessment.simulate": "assessment_simulate",
    "erp2.assessment.approve": "assessment_approve",
    "erp2.regularization.preview": "regularization_preview",
    "erp2.regularization.approve": "regularization_approve",
    "erp2.occupancy.save": "occupancy_save",
    "erp2.billing.propose": "billing_propose",
    "erp2.billing.confirm": "billing_confirm",
}

ERP2_QUERIES = {
    "erp2.reference.get": "reference_get",
    "erp2.budget.list": "budget_list",
    "erp2.budget.get": "budget_get",
    "erp2.budget.compare": "budget_compare",
    "erp2.simulation.get": "simulation_get",
    "erp2.quota.explain": "quota_explain",
    "erp2.billing.preview": "billing_preview",
    "erp2.plan.export.preview": "plan_export_preview",
    "erp2.plan.list": "plan_list",
    "erp2.assessment.list": "assessment_list",
    "erp2.assessment.get": "assessment_get",
    "erp2.regularization.list": "regularization_list",
}

ERP3_COMMANDS = {
    'erp3.allocation.batch.preview':'allocation_batch_preview',
    'erp3.allocation.batch.confirm':'allocation_batch_confirm',
    'erp3.export.prepare':'export_prepare',
    'erp3.coverage.activation.preview':'coverage_activation_preview',
    'erp3.coverage.activation.confirm':'coverage_activation_confirm',
    'erp3.return.reverse.preview':'return_reverse_preview',
    'erp3.return.reverse.confirm':'return_reverse_confirm',
    'erp3.collection.payer.preview':'collection_payer_preview',
    'erp3.collection.payer.confirm':'collection_payer_confirm',
    'erp3.credit.reverse.preview':'credit_reverse_preview',
    'erp3.credit.reverse.confirm':'credit_reverse_confirm',
    'erp3.credit.apply.reverse.preview':'credit_apply_reverse_preview',
    'erp3.credit.apply.reverse.confirm':'credit_apply_reverse_confirm',
    'erp3.opening.move.preview':'opening_move_preview',
    'erp3.opening.move.confirm':'opening_move_confirm',
    'erp3.permissions.save':'permissions_save',
    'erp3.coverage.confirm':'coverage_confirm',
    'erp3.policy.save':'policy_save',
    'erp3.responsibility.confirm':'responsibility_confirm',
    'erp3.collection.record':'collection_record',
    'erp3.claim.record':'claim_record',
    'erp3.proposal.discard':'proposal_discard',
    **{f'erp3.{name}.{step}':name.replace('.','_')+'_'+step
       for name in ('emission','allocation','return','credit','void','uncollectible',
                    'allocation.reverse','refund','credit.apply','return.fee','responsibility.transfer',
                    'regularization.emission','history.import') for step in ('preview','confirm')},
}

ERP3_QUERIES = {
    'erp3.evidence.list':'evidence_list',
    'erp3.coverage.candidates':'coverage_candidates',
    'erp3.period.summary':'period_summary',
    'erp3.opening.get':'opening_get',
    'erp3.account.statement':'account_statement',
    'erp3.responsibility.get':'responsibility_get',
    'erp3.import.access':'import_access',
    'erp3.workspace.get':'workspace_get',
    'erp3.receipt.get':'receipt_get',
    'erp3.receipt.explain':'receipt_get',
    'erp3.receipt.list':'receipt_list',
    'erp3.receipt.timeline':'receipt_timeline',
    'erp3.collection.get':'collection_get',
    'erp3.collection.unallocated':'collection_unallocated',
    'erp3.debt.summary':'debt_summary',
    'erp3.emitted.coverage':'emitted_coverage',
    'erp3.history.import.get':'history_import_get',
    'erp3.reference.get':'reference_get',
}


def execute_command(database_path, session, value):
    envelope = CommandEnvelope.from_value(value)
    if envelope.command in ERP3_COMMANDS:
        return getattr(ReceivablesService(database_path),ERP3_COMMANDS[envelope.command])(session,envelope)
    if envelope.command in ONBOARDING_COMMANDS:
        return getattr(OnboardingService(database_path), ONBOARDING_COMMANDS[envelope.command])(session, envelope)
    if envelope.command in ERP2_COMMANDS:
        return getattr(BudgetService(database_path), ERP2_COMMANDS[envelope.command])(session, envelope)
    if envelope.command in COMMANDS:
        return getattr(MasterDataService(database_path), COMMANDS[envelope.command])(session, envelope)
    if envelope.command == "erp0.foundation.set_status" and os.environ.get("ERP0_REFERENCE_COMMANDS") == "1":
        return FoundationService(database_path).set_status(session, envelope)
    raise NotFoundError("Comando ERP no registrado o no habilitado.")


def execute_query(database_path, session, value):
    query = QueryEnvelope.from_value(value)
    if query.query in ERP3_QUERIES:
        return getattr(ReceivablesService(database_path),ERP3_QUERIES[query.query])(session,query)
    if query.query in ONBOARDING_QUERIES:
        return getattr(OnboardingService(database_path), ONBOARDING_QUERIES[query.query])(session, query)
    if query.query in ERP2_QUERIES:
        return getattr(BudgetService(database_path), ERP2_QUERIES[query.query])(session, query)
    if query.query in QUERIES:
        return getattr(MasterDataService(database_path), QUERIES[query.query])(session, query)
    if query.query == "erp0.foundation.get_status":
        return FoundationService(database_path).get_status(session, query)
    raise NotFoundError("Consulta ERP no registrada.")


def catalog():
    return {
        "contract_version": "erp_internal_v1",
        "queries": ["erp0.foundation.get_status", *sorted(QUERIES), *sorted(ONBOARDING_QUERIES), *sorted(ERP2_QUERIES), *sorted(ERP3_QUERIES)],
        "commands": sorted(COMMANDS) + sorted(ONBOARDING_COMMANDS) + sorted(ERP2_COMMANDS) + sorted(ERP3_COMMANDS) + (["erp0.foundation.set_status"] if os.environ.get("ERP0_REFERENCE_COMMANDS") == "1" else []),
        "erp2a": budget_contract_catalog(),
        "arbitrary_sql": False,
    }
