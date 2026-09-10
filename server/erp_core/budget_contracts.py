"""ERP 2A contract catalogue and strict validation primitives.

These contracts describe the approved boundary. They are not executable ERP 2
commands until the deterministic services of the following implementation block
are registered in dispatcher.py.
"""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import Enum
import re

from .errors import ContractError


CONTRACT_VERSION = "erp_budget_v1"
MOTOR_VERSION = "erp2-rational-v1"
ROUNDING_VERSION = "largest-remainder-v1"


class BudgetState(str, Enum):
    DRAFT = "borrador"
    PROPOSED = "propuesto"
    APPROVED = "aprobado"
    CLOSED = "cerrado"
    ARCHIVED = "archivado"


class Frequency(str, Enum):
    MONTHLY = "mensual"
    QUARTERLY = "trimestral"
    SEMIANNUAL = "semestral"
    ANNUAL = "anual"


class RuleType(str, Enum):
    COEFFICIENT = "coeficiente"
    EQUAL = "partes_iguales"
    FIXED = "importe_fijo"
    UNITS = "unidades"
    CONSUMPTION = "consumo"
    SPECIAL_PERCENTAGE = "porcentaje_especial"
    MIXED = "mixta"


class DistributionMode(str, Enum):
    AMOUNT = "importe"
    PERCENTAGE = "porcentaje"


class SimulationOrigin(str, Enum):
    BUDGET = "presupuesto"
    ASSESSMENT = "derrama"
    REGULARIZATION = "regularizacion"


@dataclass(frozen=True)
class Money:
    cents: int
    currency: str = "EUR"

    @classmethod
    def from_contract(cls, value, *, name="importe_centimos", currency="EUR"):
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            raise ContractError(f"{name} debe expresarse como centimos enteros.")
        raw = str(value).strip()
        if not re.fullmatch(r"-?\d+", raw):
            raise ContractError(f"{name} debe expresarse como centimos enteros.")
        cents = int(raw)
        if abs(cents) > 9_000_000_000_000_000:
            raise ContractError(f"{name} supera el rango economico admitido.")
        code = str(currency or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", code):
            raise ContractError("La moneda debe ser un codigo ISO de tres letras.")
        return cls(cents=cents, currency=code)

    def to_contract(self):
        return {"cents": str(self.cents), "currency": self.currency}


def exact_decimal(value, name, *, positive=False, allow_zero=True, max_scale=30):
    raw = str(value if value is not None else "").strip()
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", raw):
        raise ContractError(f"{name} debe ser decimal exacto canonico con punto decimal.")
    try:
        result = Decimal(raw)
    except InvalidOperation as exc:
        raise ContractError(f"{name} debe ser decimal exacto.") from exc
    if not result.is_finite():
        raise ContractError(f"{name} debe ser finito.")
    if positive and result < 0:
        raise ContractError(f"{name} no puede ser negativo.")
    if not allow_zero and result == 0:
        raise ContractError(f"{name} no puede ser cero.")
    if max(0, -result.as_tuple().exponent) > max_scale:
        raise ContractError(f"{name} supera {max_scale} decimales.")
    canonical = format(result, "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    return canonical or "0"


RULE_PARAMETER_SCHEMAS = {
    RuleType.COEFFICIENT.value: {
        "required": ["group_id", "series_purpose", "series_unit"],
        "properties": {"group_id": "integer", "series_purpose": "string", "series_unit": "string"},
    },
    RuleType.EQUAL.value: {"required": ["group_id"], "properties": {"group_id": "integer"}},
    RuleType.FIXED.value: {
        "required": ["amount_cents", "scope"],
        "properties": {"amount_cents": "integer-string", "scope": ["interval", "period"]},
    },
    RuleType.UNITS.value: {
        "required": ["unit", "tariff_decimal", "quantities_source"],
        "properties": {"unit": "string", "tariff_decimal": "decimal-string", "quantities_source": "reference"},
    },
    RuleType.CONSUMPTION.value: {
        "required": ["mode", "unit", "values_source"],
        "properties": {"mode": ["tariff", "proportional_fund"], "unit": "string", "values_source": "reference"},
        "status": "prepared-not-executable-in-erp2a",
    },
    RuleType.SPECIAL_PERCENTAGE.value: {
        "required": ["group_id", "series_purpose", "series_unit"],
        "properties": {"group_id": "integer", "series_purpose": "string", "series_unit": "string"},
    },
    RuleType.MIXED.value: {
        "required": ["components"],
        "properties": {"components": "approved-rule-component-list-one-level"},
    },
}


PLANNED_COMMANDS = {
    "erp2.budget.create", "erp2.budget.copy", "erp2.budget.save",
    "erp2.budget.import.preview", "erp2.budget.import.confirm",
    "erp2.budget.simulate", "erp2.budget.propose", "erp2.budget.approve",
    "erp2.budget.close", "erp2.budget.amend",
    "erp2.assessment.save", "erp2.assessment.simulate", "erp2.assessment.approve",
    "erp2.regularization.preview", "erp2.regularization.approve",
    "erp2.occupancy.save", "erp2.billing.propose", "erp2.billing.confirm",
}

PLANNED_QUERIES = {
    "erp2.budget.list", "erp2.budget.get", "erp2.budget.compare",
    "erp2.simulation.get", "erp2.quota.explain", "erp2.billing.preview",
    "erp2.plan.export.preview",
}


def contract_catalog():
    return {
        "contract_version": CONTRACT_VERSION,
        "motor_version": MOTOR_VERSION,
        "rounding_version": ROUNDING_VERSION,
        "implementation_stage": "2B-domain-engine",
        "engine_rules_enabled": [
            RuleType.COEFFICIENT.value, RuleType.EQUAL.value, RuleType.FIXED.value,
            RuleType.UNITS.value, RuleType.SPECIAL_PERCENTAGE.value, RuleType.MIXED.value,
        ],
        "consumption_engine": "prepared-not-executable",
        "commands_planned_not_enabled": sorted(PLANNED_COMMANDS),
        "queries_planned_not_enabled": sorted(PLANNED_QUERIES),
        "frequencies": [item.value for item in Frequency],
        "rule_types": [item.value for item in RuleType],
        "rule_parameter_schemas": RULE_PARAMETER_SCHEMAS,
        "money_transport": "integer-cents-as-string",
        "decimal_transport": "canonical-string-max-30-decimals",
        "arbitrary_formulas": False,
        "receipt_emission": False,
    }
