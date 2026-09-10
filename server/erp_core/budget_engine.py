"""Pure, deterministic ERP 2 budget calculation engine.

The engine accepts a fully structured, versioned manifest. It never reads current
master data, emits receipts, calls external services, or evaluates user code.
All economic arithmetic uses integers and ``fractions.Fraction``.
"""

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP, localcontext
from fractions import Fraction
import hashlib

from .budget_contracts import (
    CONTRACT_VERSION, Frequency, MOTOR_VERSION, ROUNDING_VERSION, RuleType,
    exact_decimal,
)
from .contracts import canonical_json
from .errors import ContractError


SUPPORTED_RULES = {
    RuleType.COEFFICIENT.value,
    RuleType.EQUAL.value,
    RuleType.FIXED.value,
    RuleType.UNITS.value,
    RuleType.SPECIAL_PERCENTAGE.value,
    RuleType.MIXED.value,
}
PERIOD_COUNTS = {
    Frequency.MONTHLY.value: 12,
    Frequency.QUARTERLY.value: 4,
    Frequency.SEMIANNUAL.value: 2,
    Frequency.ANNUAL.value: 1,
}
TIE_CRITERION = "largest-remainder;remainder-desc;stable-key-asc"


@dataclass(frozen=True)
class CalculationIssue:
    code: str
    message: str
    entity_type: str | None = None
    entity_id: str | None = None
    field: str | None = None
    solution: str | None = None

    def to_dict(self):
        return {
            "code": self.code,
            "severity": "error",
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "field": self.field,
            "message": self.message,
            "solution": self.solution,
        }


class CalculationBlocked(ContractError):
    def __init__(self, issue):
        self.issue = issue
        super().__init__(issue.message)


def _block(code, message, *, entity_type=None, entity_id=None, field=None, solution=None):
    raise CalculationBlocked(CalculationIssue(
        code, message, entity_type, None if entity_id is None else str(entity_id),
        field, solution,
    ))


def _positive_id(value, name):
    if isinstance(value, bool):
        _block("INVALID_ID", f"{name} debe ser un identificador entero positivo.", field=name)
    try:
        result = int(value)
    except (TypeError, ValueError):
        result = 0
    if result <= 0:
        _block("INVALID_ID", f"{name} debe ser un identificador entero positivo.", field=name)
    return result


def _cents(value, name, *, allow_negative=False):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        _block("INVALID_MONEY", f"{name} debe expresarse como centimos enteros.", field=name)
    raw = str(value).strip()
    if not raw or raw.lstrip("-").isdigit() is False:
        _block("INVALID_MONEY", f"{name} debe expresarse como centimos enteros.", field=name)
    result = int(raw)
    if not allow_negative and result < 0:
        _block("INVALID_MONEY", f"{name} no puede ser negativo.", field=name)
    if abs(result) > 9_000_000_000_000_000:
        _block("MONEY_OUT_OF_RANGE", f"{name} supera el rango admitido.", field=name)
    return result


def _fraction(value, name, *, positive=False, allow_zero=True):
    try:
        canonical = exact_decimal(value, name, positive=positive, allow_zero=allow_zero)
    except ContractError as exc:
        _block("INVALID_DECIMAL", str(exc), field=name)
    return Fraction(Decimal(canonical))


def _stable_key(value):
    if isinstance(value, bool):
        return (2, str(value))
    if isinstance(value, int):
        return (0, value)
    raw = str(value)
    if raw.isdigit():
        return (0, int(raw))
    return (1, raw)


def _fraction_dict(value):
    with localcontext() as context:
        context.prec = 40
        approximate = Decimal(value.numerator) / Decimal(value.denominator)
    return {
        "numerator": str(value.numerator),
        "denominator": str(value.denominator),
        "approximate": format(approximate, ".30f").rstrip("0").rstrip("."),
    }


def _fraction_decimal(value):
    denominator = value.denominator
    while denominator % 2 == 0:
        denominator //= 2
    while denominator % 5 == 0:
        denominator //= 5
    if denominator != 1:
        raise AssertionError("Una entrada decimal dejo de ser representable como decimal finito.")
    with localcontext() as context:
        context.prec = 80
        return exact_decimal(Decimal(value.numerator) / Decimal(value.denominator), "decimal exacto")


def _signed_floor_magnitude(value):
    sign = -1 if value < 0 else 1
    magnitude = abs(value)
    return sign * (magnitude.numerator // magnitude.denominator)


def _round_exact_values(values, target_cents):
    """Round exact cent values to an exact signed target by largest remainder."""
    if not values:
        if target_cents:
            _block("EMPTY_DISTRIBUTION", "No existen unidades para distribuir el importe objetivo.")
        return []
    if target_cents and any((value["exact"] < 0) != (target_cents < 0) for value in values if value["exact"]):
        _block("MIXED_SIGNS", "Un mismo fondo no puede mezclar cargos y abonos.")
    sign = -1 if target_cents < 0 else 1
    work = []
    base_total = 0
    for value in values:
        exact = abs(value["exact"])
        base = exact.numerator // exact.denominator
        remainder = exact - base
        base_total += base
        work.append({**value, "base_magnitude": base, "remainder": remainder})
    residue = abs(target_cents) - base_total
    if residue < 0 or residue > len(work):
        _block(
            "IMPOSSIBLE_REMAINDER",
            "El residuo no puede distribuirse sin alterar las entradas exactas.",
            solution="Revise el importe objetivo y la regla de reparto.",
        )
    ranked = sorted(
        range(len(work)),
        key=lambda index: (-work[index]["remainder"], _stable_key(work[index]["tie_key"])),
    )
    adjusted = set(ranked[:residue])
    result = []
    for index, value in enumerate(work):
        adjustment = sign if index in adjusted else 0
        base = sign * value["base_magnitude"]
        result.append({
            **{key: child for key, child in value.items() if key not in {"base_magnitude", "remainder"}},
            "base_cents": base,
            "adjustment_cents": adjustment,
            "final_cents": base + adjustment,
            "remainder": value["remainder"],
            "rounding_criterion": TIE_CRITERION,
        })
    if sum(value["final_cents"] for value in result) != target_cents:
        raise AssertionError("El reparto por mayores restos no conserva el total.")
    return result


def largest_remainder(target_cents, weighted_units):
    """Distribute integer cents proportionally using exact rational arithmetic."""
    if not weighted_units:
        _block("EMPTY_GROUP", "El grupo no contiene propiedades participantes.")
    total_weight = sum((value["weight"] for value in weighted_units), Fraction(0))
    if total_weight <= 0:
        _block("ZERO_WEIGHT_SUM", "La suma de pesos debe ser mayor que cero.")
    exact_values = [{
        **value,
        "exact": Fraction(target_cents) * value["weight"] / total_weight,
    } for value in weighted_units]
    return _round_exact_values(exact_values, target_cents)


def _allocate_targets(total_cents, entries, context):
    modes = {str(entry.get("mode") or "").strip() for entry in entries}
    if not entries:
        _block("MISSING_ASSIGNMENTS", f"{context} no tiene asignaciones de reparto.")
    if len(modes) != 1 or modes.pop() not in {"importe", "porcentaje"}:
        _block("MIXED_ASSIGNMENT_MODES", f"{context} debe usar exclusivamente importes o porcentajes.")
    mode = str(entries[0]["mode"]).strip()
    if mode == "importe":
        targets = [_cents(entry.get("value"), "valor de asignacion") for entry in entries]
        if sum(targets) != total_cents:
            _block(
                "ASSIGNMENTS_DO_NOT_BALANCE",
                f"Las asignaciones de {context} no coinciden con su importe objetivo.",
                solution="Ajuste los importes sin modificar silenciosamente ninguna linea.",
            )
        return targets
    weights = [_fraction(entry.get("value"), "porcentaje de asignacion", positive=True) for entry in entries]
    if sum(weights, Fraction(0)) != 100:
        _block("PERCENTAGES_NOT_100", f"Los porcentajes de {context} deben sumar exactamente 100.")
    rounded = largest_remainder(total_cents, [
        {"weight": weight, "tie_key": entry.get("key", entry.get("id", index))}
        for index, (entry, weight) in enumerate(zip(entries, weights))
    ])
    return [value["final_cents"] for value in rounded]


def _validate_periods(manifest):
    frequency = str(manifest.get("periodicity") or "").strip()
    if frequency not in PERIOD_COUNTS and frequency != "personalizada":
        _block("INVALID_FREQUENCY", "La periodicidad ordinaria no es valida.", field="periodicity")
    periods = manifest.get("periods")
    expected_count = PERIOD_COUNTS.get(frequency)
    if not isinstance(periods, list) or not periods or (expected_count is not None and len(periods) != expected_count):
        _block(
            "INVALID_PERIOD_COUNT",
            (f"La periodicidad {frequency} requiere {expected_count} periodos."
             if expected_count is not None else "El calendario personalizado requiere al menos un plazo."),
            field="periods",
        )
    keys, orders, normalized = set(), set(), []
    for index, period in enumerate(periods):
        if not isinstance(period, dict):
            _block("INVALID_PERIOD", "Cada periodo debe ser un objeto estructurado.")
        key = str(period.get("key") or "").strip()
        order = period.get("order", index)
        if not key or key in keys or not isinstance(order, int) or isinstance(order, bool) or order < 0 or order in orders:
            _block("INVALID_PERIOD", "Las claves y ordenes de periodo deben ser unicos y validos.")
        keys.add(key); orders.add(order)
        normalized.append({
            "key": key,
            "order": order,
            "weight": _fraction(period.get("weight", "1"), "peso de periodo", positive=True, allow_zero=False),
            "date_start": period.get("date_start"),
            "date_end": period.get("date_end"),
        })
    return frequency, sorted(normalized, key=lambda value: value["order"])


def _eligible_members(assignment, rule_type):
    group = assignment.get("group")
    if not isinstance(group, dict):
        _block("MISSING_GROUP", "La asignacion no contiene un grupo versionado.")
    group_id = _positive_id(group.get("id"), "group.id")
    _positive_id(group.get("version_id"), "group.version_id")
    if group.get("state") != "aprobada":
        _block("GROUP_NOT_APPROVED", "La version del grupo debe estar aprobada.", entity_type="group", entity_id=group_id)
    base = str(group.get("base") or "").strip()
    if base == "otra":
        _block("UNSUPPORTED_GROUP_BASE", "La base 'otra' no tiene calculo definido.", entity_type="group", entity_id=group_id)
    members = assignment.get("members")
    if not isinstance(members, list) or not members:
        _block("EMPTY_GROUP", "El grupo no contiene propiedades participantes.", entity_type="group", entity_id=group_id)
    seen, normalized = set(), []
    for member in members:
        property_id = _positive_id(member.get("property_id"), "member.property_id")
        if property_id in seen:
            _block("DUPLICATE_MEMBER", "Una propiedad aparece mas de una vez en la asignacion.", entity_type="property", entity_id=property_id)
        seen.add(property_id)
        if member.get("participates", True) is not True:
            continue
        exclusion = member.get("exclusion")
        if exclusion:
            if not isinstance(exclusion, dict) or exclusion.get("treatment") not in {"redistribuir", "otra_financiacion"}:
                _block("INVALID_EXCLUSION", "La exclusion no tiene un tratamiento economico valido.", entity_type="property", entity_id=property_id)
            if exclusion.get("treatment") == "otra_financiacion":
                _block(
                    "EXCLUSION_FUNDING_NOT_RESOLVED",
                    "La exclusion con otra financiacion requiere cuantificacion explicita antes de calcular.",
                    entity_type="property", entity_id=property_id,
                )
        normalized.append({**member, "property_id": property_id, "excluded": bool(exclusion)})
    if not normalized:
        _block("EMPTY_GROUP", "El grupo no contiene propiedades participantes.", entity_type="group", entity_id=group_id)

    if rule_type in {RuleType.COEFFICIENT.value, RuleType.SPECIAL_PERCENTAGE.value}:
        if base not in {"porcentaje", "peso"}:
            _block("INCOMPATIBLE_GROUP_BASE", "La regla requiere un grupo de porcentaje o peso.", entity_type="group", entity_id=group_id)
        if rule_type == RuleType.SPECIAL_PERCENTAGE.value and base != "porcentaje":
            _block("INCOMPATIBLE_GROUP_BASE", "El porcentaje especial requiere un grupo porcentual.", entity_type="group", entity_id=group_id)
        total = Fraction(0)
        for member in normalized:
            candidates = member.get("coefficient_candidates")
            if candidates is not None:
                if not isinstance(candidates, list) or len(candidates) != 1:
                    _block("AMBIGUOUS_COEFFICIENT", "Debe existir exactamente un coeficiente vigente compatible.", entity_type="property", entity_id=member["property_id"])
                coefficient = candidates[0]
            else:
                coefficient = member.get("coefficient")
            if not isinstance(coefficient, dict):
                _block("MISSING_COEFFICIENT", "Falta el coeficiente requerido.", entity_type="property", entity_id=member["property_id"])
            if coefficient.get("state") != "aprobada" or coefficient.get("quality") != "validada":
                _block("COEFFICIENT_NOT_VALIDATED", "El coeficiente debe estar aprobado y validado.", entity_type="property", entity_id=member["property_id"])
            expected_purpose = assignment.get("series_purpose")
            expected_unit = assignment.get("series_unit")
            if expected_purpose and coefficient.get("purpose") != expected_purpose:
                _block("COEFFICIENT_SELECTOR_MISMATCH", "El coeficiente no coincide con la finalidad seleccionada.", entity_type="property", entity_id=member["property_id"])
            if expected_unit and coefficient.get("unit") != expected_unit:
                _block("COEFFICIENT_SELECTOR_MISMATCH", "El coeficiente no coincide con la unidad seleccionada.", entity_type="property", entity_id=member["property_id"])
            member["coefficient"] = coefficient
            member["weight"] = _fraction(coefficient.get("value"), "coeficiente", positive=True)
            total += member["weight"]
        expected = group.get("expected_total")
        if base == "porcentaje" and expected is not None and total != _fraction(expected, "suma esperada", positive=True):
            _block("COEFFICIENT_TOTAL_MISMATCH", "La suma de coeficientes del grupo no coincide con el total aprobado.", entity_type="group", entity_id=group_id)
    return group, [member for member in normalized if not member["excluded"]]


def _leaf_calculation(target_cents, assignment, rule, periods, component_key="root"):
    rule_type = str(rule.get("type") or "").strip()
    if rule_type not in SUPPORTED_RULES or rule_type == RuleType.MIXED.value:
        _block("UNSUPPORTED_RULE", f"La regla {rule_type or '(vacia)'} no es ejecutable en ERP 2B.")
    rule_version_id = _positive_id(rule.get("version_id"), "rule.version_id")
    if rule.get("state") != "aprobada":
        _block("RULE_NOT_APPROVED", "La version de la regla debe estar aprobada.", entity_type="rule", entity_id=rule_version_id)
    group, members = _eligible_members(assignment, rule_type)
    if not members:
        _block("EMPTY_GROUP", "La exclusion deja el grupo sin participantes.")
    params = rule.get("parameters") or {}
    if not isinstance(params, dict):
        _block("INVALID_RULE_PARAMETERS", "Los parametros de la regla deben estar estructurados.")

    if rule_type in {RuleType.COEFFICIENT.value, RuleType.SPECIAL_PERCENTAGE.value}:
        rounded = largest_remainder(target_cents, [{
            "property_id": member["property_id"], "member": member,
            "weight": member["weight"], "tie_key": member["property_id"],
        } for member in members])
    elif rule_type == RuleType.EQUAL.value:
        rounded = largest_remainder(target_cents, [{
            "property_id": member["property_id"], "member": member,
            "weight": Fraction(1), "tie_key": member["property_id"],
        } for member in members])
    elif rule_type == RuleType.FIXED.value:
        amount = _cents(params.get("amount_cents"), "importe fijo", allow_negative=True)
        scope = params.get("scope")
        if scope not in {"interval", "period"}:
            _block("INVALID_FIXED_SCOPE", "El importe fijo debe indicar alcance interval o period.")
        exact = amount * (len(periods) if scope == "period" else 1)
        if exact * len(members) != target_cents:
            _block("FIXED_TOTAL_MISMATCH", "Los importes fijos no coinciden con el importe de la asignacion.")
        rounded = [{
            "property_id": member["property_id"], "member": member,
            "weight": Fraction(1), "tie_key": member["property_id"], "exact": Fraction(exact),
            "base_cents": exact, "adjustment_cents": 0, "final_cents": exact,
            "remainder": Fraction(0), "rounding_criterion": "exact-fixed-amount",
        } for member in members]
    elif rule_type == RuleType.UNITS.value:
        tariff = _fraction(params.get("tariff_decimal"), "tarifa", positive=True)
        exact_values = []
        for member in members:
            quantity = _fraction(member.get("quantity"), "unidades", positive=True)
            exact_values.append({
                "property_id": member["property_id"], "member": member,
                "weight": quantity, "tie_key": member["property_id"],
                "exact": quantity * tariff * 100,
            })
        exact_total = sum((value["exact"] for value in exact_values), Fraction(0))
        with localcontext() as context:
            context.prec = 50
            quantized = int((Decimal(exact_total.numerator) / Decimal(exact_total.denominator)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        if quantized != target_cents:
            _block("UNITS_TOTAL_MISMATCH", "Cantidad por tarifa no coincide con el importe contractual de la asignacion.")
        rounded = _round_exact_values(exact_values, target_cents)
    else:
        raise AssertionError("Regla hoja no contemplada.")

    values = []
    for value in rounded:
        member = value["member"]
        coefficient = member.get("coefficient") or {}
        values.append({
            "component_key": component_key,
            "property_id": value["property_id"],
            "member_version_id": member.get("member_version_id"),
            "series_id": coefficient.get("series_id"),
            "coefficient_version_id": coefficient.get("version_id"),
            "rule_version_id": rule_version_id,
            "rule_type": rule_type,
            "value_decimal": coefficient.get("value", member.get("quantity", "1")),
            "denominator_decimal": _fraction_decimal(sum((item.get("weight", Fraction(1)) for item in rounded), Fraction(0))) if rule_type != RuleType.UNITS.value else None,
            "exact": value["exact"],
            "base_cents": value["base_cents"],
            "adjustment_cents": value["adjustment_cents"],
            "final_cents": value["final_cents"],
            "remainder": value["remainder"],
            "rounding_criterion": value["rounding_criterion"],
            "fixed_per_period": rule_type == RuleType.FIXED.value and params.get("scope") == "period",
            "fixed_period_cents": _cents(params.get("amount_cents"), "importe fijo", allow_negative=True) if rule_type == RuleType.FIXED.value and params.get("scope") == "period" else None,
            "group": group,
        })
    return values


def _calculate_assignment(target_cents, assignment, periods):
    rule = assignment.get("rule")
    if not isinstance(rule, dict):
        _block("MISSING_RULE", "La asignacion no contiene una regla versionada.")
    rule_type = str(rule.get("type") or "").strip()
    if rule_type != RuleType.MIXED.value:
        return _leaf_calculation(target_cents, assignment, rule, periods)
    rule_version_id = _positive_id(rule.get("version_id"), "rule.version_id")
    if rule.get("state") != "aprobada":
        _block("RULE_NOT_APPROVED", "La regla mixta debe estar aprobada.", entity_type="rule", entity_id=rule_version_id)
    components = rule.get("components")
    if not isinstance(components, list) or not components:
        _block("MIXED_WITHOUT_COMPONENTS", "La regla mixta no contiene componentes.")
    targets = _allocate_targets(target_cents, components, "la regla mixta")
    result = []
    seen = set()
    for index, (component, component_target) in enumerate(zip(components, targets)):
        key = str(component.get("key") or index)
        if key in seen:
            _block("DUPLICATE_COMPONENT", "Las claves de componentes mixtos deben ser unicas.")
        seen.add(key)
        subrule = component.get("rule")
        if not isinstance(subrule, dict) or subrule.get("type") in {RuleType.MIXED.value, RuleType.CONSUMPTION.value}:
            _block("INVALID_MIXED_COMPONENT", "ERP 2B admite un unico nivel de componentes con reglas ejecutables.")
        child_assignment = {**assignment, "members": component.get("members", assignment.get("members"))}
        result.extend(_leaf_calculation(component_target, child_assignment, subrule, periods, key))
    return result


def _periodize(line, periods):
    if line.get("fixed_per_period"):
        amount = line["fixed_period_cents"]
        values = [{
            "period": period, "exact": Fraction(amount), "base_cents": amount,
            "adjustment_cents": 0, "final_cents": amount, "remainder": Fraction(0),
            "rounding_criterion": "exact-fixed-per-period",
        } for period in periods]
        if sum(value["final_cents"] for value in values) != line["final_cents"]:
            raise AssertionError("El fijo periodico no conserva su importe anual.")
        return values
    return largest_remainder(line["final_cents"], [{
        "period": period, "weight": period["weight"], "tie_key": period["order"],
    } for period in periods])


def _serialize_trace(trace):
    return {
        **{key: value for key, value in trace.items() if key not in {"exact", "remainder", "group"}},
        "exact": _fraction_dict(trace["exact"]),
        "remainder": _fraction_dict(trace["remainder"]),
        "group": {
            "id": trace["group"].get("id"),
            "version_id": trace["group"].get("version_id"),
            "base": trace["group"].get("base"),
            "name": trace["group"].get("name"),
        },
    }


def calculate_budget(manifest):
    if not isinstance(manifest, dict):
        _block("INVALID_MANIFEST", "La simulacion requiere un manifiesto estructurado.")
    if manifest.get("contract_version") not in {None, CONTRACT_VERSION}:
        _block("CONTRACT_VERSION_MISMATCH", "La version del contrato no es compatible.")
    community_id = _positive_id(manifest.get("community_id"), "community_id")
    currency = str(manifest.get("currency") or "EUR").upper()
    if currency != "EUR":
        _block("UNSUPPORTED_CURRENCY", "ERP 2B admite inicialmente EUR con dos decimales.")
    frequency, periods = _validate_periods(manifest)
    items = manifest.get("items")
    if not isinstance(items, list) or not items:
        _block("EMPTY_BUDGET", "El presupuesto no contiene partidas.")

    input_hash = hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()
    all_lines, item_results = [], []
    seen_items = set()
    total_budget = total_financing = total_quota = 0
    for item_index, item in enumerate(items):
        item_id = _positive_id(item.get("id"), "item.id")
        if item_id in seen_items:
            _block("DUPLICATE_ITEM", "Una partida aparece mas de una vez.", entity_type="item", entity_id=item_id)
        seen_items.add(item_id)
        amount = _cents(item.get("amount_cents"), "importe de partida")
        financing = item.get("financing") or []
        if not isinstance(financing, list):
            _block("INVALID_FINANCING", "La financiacion debe ser una lista estructurada.", entity_type="item", entity_id=item_id)
        financing_total = 0
        for source in financing:
            if source.get("confirmed") is not True:
                _block("UNCONFIRMED_FINANCING", "Toda financiacion debe estar confirmada para calcular.", entity_type="item", entity_id=item_id)
            financing_total += _cents(source.get("amount_cents"), "importe de financiacion")
        if financing_total > amount:
            _block("FINANCING_EXCEEDS_ITEM", "La financiacion supera el importe de la partida.", entity_type="item", entity_id=item_id)
        quota_target = amount - financing_total
        assignments = item.get("assignments")
        if not isinstance(assignments, list):
            _block("INVALID_ASSIGNMENTS", "Las asignaciones deben ser una lista.", entity_type="item", entity_id=item_id)
        targets = _allocate_targets(quota_target, assignments, f"la partida {item.get('key') or item_id}") if quota_target or assignments else []
        item_lines = []
        seen_assignments = set()
        for assignment_index, (assignment, target) in enumerate(zip(assignments, targets)):
            assignment_id = _positive_id(assignment.get("id"), "assignment.id")
            if assignment_id in seen_assignments:
                _block("DUPLICATE_ASSIGNMENT", "Una asignacion aparece mas de una vez.", entity_type="assignment", entity_id=assignment_id)
            seen_assignments.add(assignment_id)
            traces = _calculate_assignment(target, assignment, periods)
            grouped = defaultdict(list)
            for trace in traces:
                grouped[trace["property_id"]].append(trace)
            for property_id, property_traces in grouped.items():
                exact = sum((trace["exact"] for trace in property_traces), Fraction(0))
                final = sum(trace["final_cents"] for trace in property_traces)
                base = _signed_floor_magnitude(exact)
                period_lines = _periodize({
                    "final_cents": final,
                    "fixed_per_period": all(trace["fixed_per_period"] for trace in property_traces),
                    "fixed_period_cents": sum((trace.get("fixed_period_cents") or 0) for trace in property_traces),
                }, periods)
                line = {
                    "community_id": community_id,
                    "chapter_id": item.get("chapter_id"),
                    "item_id": item_id,
                    "item_key": item.get("key", str(item_id)),
                    "item_name": item.get("name"),
                    "assignment_id": assignment_id,
                    "assignment_key": assignment.get("key", str(assignment_id)),
                    "property_id": property_id,
                    "group_version_id": assignment["group"].get("version_id"),
                    "rule_version_id": assignment["rule"].get("version_id"),
                    "value_decimal": property_traces[0].get("value_decimal"),
                    "denominator_decimal": property_traces[0].get("denominator_decimal"),
                    "exact": _fraction_dict(exact),
                    "base_cents": str(base),
                    "adjustment_cents": str(final - base),
                    "final_cents": str(final),
                    "tie_key": str(property_id),
                    "rounding_criterion": TIE_CRITERION,
                    "components": [_serialize_trace(trace) for trace in property_traces],
                    "periods": [{
                        "key": value["period"]["key"],
                        "order": value["period"]["order"],
                        "exact": _fraction_dict(value["exact"]),
                        "base_cents": str(value["base_cents"]),
                        "adjustment_cents": str(value["adjustment_cents"]),
                        "final_cents": str(value["final_cents"]),
                        "remainder": _fraction_dict(value["remainder"]),
                        "rounding_criterion": value["rounding_criterion"],
                    } for value in period_lines],
                }
                if sum(int(value["final_cents"]) for value in line["periods"]) != final:
                    raise AssertionError("La periodificacion no conserva la cuota anual.")
                item_lines.append(line)
        if sum(int(line["final_cents"]) for line in item_lines) != quota_target:
            raise AssertionError("Las lineas de partida no conservan el objetivo de cuotas.")
        all_lines.extend(item_lines)
        item_results.append({
            "item_id": item_id,
            "item_key": item.get("key", str(item_id)),
            "amount_cents": str(amount),
            "financing_cents": str(financing_total),
            "quota_target_cents": str(quota_target),
            "result_cents": str(sum(int(line["final_cents"]) for line in item_lines)),
        })
        total_budget += amount; total_financing += financing_total; total_quota += quota_target

    property_totals = defaultdict(lambda: {"annual": 0, "periods": defaultdict(int)})
    for line in all_lines:
        property_totals[line["property_id"]]["annual"] += int(line["final_cents"])
        for period in line["periods"]:
            property_totals[line["property_id"]]["periods"][period["key"]] += int(period["final_cents"])
    if sum(value["annual"] for value in property_totals.values()) != total_quota:
        raise AssertionError("Las cuotas por propiedad no conservan el total.")
    for line in all_lines:
        if sum(int(value["final_cents"]) for value in line["periods"]) != int(line["final_cents"]):
            raise AssertionError("Una linea no conserva su total entre periodos.")

    result = {
        "status": "completa",
        "contract_version": CONTRACT_VERSION,
        "engine_version": MOTOR_VERSION,
        "rounding_version": ROUNDING_VERSION,
        "input_hash": input_hash,
        "community_id": community_id,
        "budget_version_id": manifest.get("budget_version_id"),
        "currency": currency,
        "periodicity": frequency,
        "periods": [{
            "key": period["key"], "order": period["order"],
            "weight": _fraction_decimal(period["weight"]),
            "date_start": period["date_start"], "date_end": period["date_end"],
        } for period in periods],
        "budget_total_cents": str(total_budget),
        "financing_total_cents": str(total_financing),
        "quota_target_cents": str(total_quota),
        "result_total_cents": str(sum(int(line["final_cents"]) for line in all_lines)),
        "items": item_results,
        "lines": sorted(all_lines, key=lambda line: (line["item_id"], line["assignment_id"], line["property_id"])),
        "property_totals": [{
            "property_id": property_id,
            "annual_cents": str(value["annual"]),
            "periods": [{"key": key, "cents": str(value["periods"][key])} for key in [period["key"] for period in periods]],
        } for property_id, value in sorted(property_totals.items())],
        "incidents": [],
        "receipt_emission": False,
    }
    result["result_hash"] = hashlib.sha256(canonical_json(result).encode("utf-8")).hexdigest()
    return result


def simulate_budget(manifest):
    try:
        return calculate_budget(manifest)
    except CalculationBlocked as exc:
        input_hash = hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest() if isinstance(manifest, dict) else None
        return {
            "status": "fallida",
            "contract_version": CONTRACT_VERSION,
            "engine_version": MOTOR_VERSION,
            "rounding_version": ROUNDING_VERSION,
            "input_hash": input_hash,
            "community_id": manifest.get("community_id") if isinstance(manifest, dict) else None,
            "incidents": [exc.issue.to_dict()],
            "receipt_emission": False,
        }


def explain_property(result, property_id, period_key=None):
    property_id = _positive_id(property_id, "property_id")
    lines = [line for line in result.get("lines", []) if int(line["property_id"]) == property_id]
    if not lines:
        _block("PROPERTY_WITHOUT_RESULT", "La propiedad no tiene cuota en esta simulacion.", entity_type="property", entity_id=property_id)
    details, total = [], 0
    for line in lines:
        amount = int(line["final_cents"])
        period_detail = None
        if period_key is not None:
            period_detail = next((value for value in line["periods"] if value["key"] == period_key), None)
            if period_detail is None:
                _block("PERIOD_NOT_FOUND", "El periodo no existe en la simulacion.", field="period_key")
            amount = int(period_detail["final_cents"])
        total += amount
        details.append({
            "chapter_id": line.get("chapter_id"), "item_id": line["item_id"],
            "item": line.get("item_name") or line.get("item_key"),
            "assignment_id": line["assignment_id"], "group_version_id": line.get("group_version_id"),
            "rule_version_id": line["rule_version_id"], "value_decimal": line.get("value_decimal"),
            "exact": period_detail["exact"] if period_detail else line["exact"],
            "base_cents": period_detail["base_cents"] if period_detail else line["base_cents"],
            "rounding_adjustment_cents": period_detail["adjustment_cents"] if period_detail else line["adjustment_cents"],
            "final_cents": str(amount), "components": line["components"],
        })
    return {
        "property_id": property_id,
        "period_key": period_key,
        "total_cents": str(total),
        "currency": result.get("currency"),
        "engine_version": result.get("engine_version"),
        "input_hash": result.get("input_hash"),
        "result_hash": result.get("result_hash"),
        "details": details,
    }
