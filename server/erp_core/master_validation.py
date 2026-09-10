"""Validation helpers for exact, tenant-scoped ERP master data."""

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
import re
import unicodedata

from .errors import ContractError


def only(payload, allowed):
    unknown = set(payload) - set(allowed)
    if unknown:
        raise ContractError("Campos no admitidos: " + ", ".join(sorted(unknown)))


def text(value, name, *, required=False, maximum=500):
    result = str(value or "").strip()
    if required and not result:
        raise ContractError(f"El campo {name} es obligatorio.")
    if len(result) > maximum:
        raise ContractError(f"El campo {name} supera {maximum} caracteres.")
    return result or None


def integer(value, name, *, required=False, minimum=1):
    if value in (None, ""):
        if required:
            raise ContractError(f"El campo {name} es obligatorio.")
        return None
    if isinstance(value, bool):
        raise ContractError(f"El campo {name} debe ser entero.")
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ContractError(f"El campo {name} debe ser entero.")
    if result < minimum:
        raise ContractError(f"El campo {name} no es valido.")
    return result


def boolean(value, name, *, default=False):
    if value is None:
        return bool(default)
    if value in (True, 1, "1", "true", "True"):
        return True
    if value in (False, 0, "0", "false", "False"):
        return False
    raise ContractError(f"El campo {name} debe ser booleano.")


def iso_date(value, name, *, required=False):
    result = text(value, name, required=required, maximum=10)
    if result is None:
        return None
    try:
        return date.fromisoformat(result).isoformat()
    except ValueError:
        raise ContractError(f"El campo {name} debe usar AAAA-MM-DD.")


def iso_datetime(value, name, *, required=False):
    result = text(value, name, required=required, maximum=40)
    if result is None:
        return None
    try:
        parsed = datetime.fromisoformat(result.replace("Z", "+00:00"))
    except ValueError:
        raise ContractError(f"El campo {name} no contiene fecha y hora valida.")
    return parsed.isoformat(timespec="seconds").replace("+00:00", "Z")


def decimal_text(value, name, *, required=False, positive=False, max_scale=30):
    raw = text(value, name, required=required, maximum=120)
    if raw is None:
        return None
    normalized = raw.replace(" ", "").replace(",", ".")
    if not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", normalized):
        raise ContractError(f"El campo {name} debe ser decimal exacto.")
    try:
        number = Decimal(normalized)
    except InvalidOperation:
        raise ContractError(f"El campo {name} debe ser decimal exacto.")
    if not number.is_finite() or (positive and number <= 0):
        raise ContractError(f"El campo {name} no es valido.")
    scale = max(0, -number.as_tuple().exponent)
    if scale > max_scale:
        raise ContractError(f"El campo {name} supera la precision admitida ({max_scale} decimales).")
    canonical = format(number, "f")
    if "." in canonical:
        canonical = canonical.rstrip("0").rstrip(".")
    return canonical or "0"


def normalized(value):
    raw = unicodedata.normalize("NFKD", str(value or ""))
    raw = "".join(char for char in raw if not unicodedata.combining(char)).upper()
    return re.sub(r"[^A-Z0-9]+", " ", raw).strip()


def one_of(value, name, choices, *, default=None):
    result = text(value if value not in (None, "") else default, name, required=True, maximum=80)
    if result not in choices:
        raise ContractError(f"El campo {name} no admite el valor indicado.")
    return result


def valid_interval(start, end):
    if start and end and end <= start:
        raise ContractError("La fecha final debe ser posterior a la fecha inicial.")

