"""Strict command/query envelopes. The actor always comes from the server session."""

from dataclasses import dataclass
import hashlib
import json

from .errors import ContractError


ORIGINS = {"web", "importer", "automation", "ai", "agent", "system", "test"}
COMMAND_FIELDS = {
    "command", "id_comunidad", "payload", "idempotency_key", "expected_version",
    "reason", "origin", "evidence",
}


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class Actor:
    user_id: int
    name: str

    @classmethod
    def from_session(cls, session):
        if not isinstance(session, dict):
            raise PermissionError("No autenticado.")
        user_id = int(session.get("id_usuario") or 0)
        name = str(session.get("nombre") or "").strip()
        if user_id <= 0 or not name:
            raise PermissionError("La sesion no contiene un actor valido.")
        return cls(user_id=user_id, name=name)


@dataclass(frozen=True)
class EvidenceRef:
    entity_type: str
    entity_id: str

    @classmethod
    def from_value(cls, value):
        if value in (None, {}):
            return None
        if not isinstance(value, dict) or set(value) - {"type", "id"}:
            raise ContractError("La referencia documental no cumple el contrato.")
        entity_type = str(value.get("type") or "").strip()
        entity_id = str(value.get("id") or "").strip()
        if not entity_type or not entity_id or len(entity_type) > 80 or len(entity_id) > 200:
            raise ContractError("La referencia documental esta incompleta.")
        return cls(entity_type=entity_type, entity_id=entity_id)


@dataclass(frozen=True)
class CommandEnvelope:
    command: str
    community_id: int
    payload: dict
    idempotency_key: str | None
    expected_version: int | None
    reason: str
    origin: str
    evidence: EvidenceRef | None

    @classmethod
    def from_value(cls, value):
        if not isinstance(value, dict):
            raise ContractError("El comando ERP debe ser un objeto.")
        unknown = set(value) - COMMAND_FIELDS
        if unknown:
            raise ContractError("Campos no admitidos en el comando ERP: " + ", ".join(sorted(unknown)))
        command = str(value.get("command") or "").strip()
        if not command or len(command) > 120:
            raise ContractError("Indica un comando ERP valido.")
        try:
            community_id = int(value.get("id_comunidad") or 0)
        except (TypeError, ValueError):
            community_id = 0
        if community_id <= 0:
            raise ContractError("El comando requiere una comunidad explicita.")
        payload = value.get("payload")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ContractError("El payload del comando debe ser un objeto.")
        key = str(value.get("idempotency_key") or "").strip() or None
        if key and len(key) > 160:
            raise ContractError("La clave de idempotencia es demasiado larga.")
        expected = value.get("expected_version")
        if expected is not None:
            if isinstance(expected, bool):
                raise ContractError("expected_version debe ser un entero no negativo.")
            try:
                expected = int(expected)
            except (TypeError, ValueError):
                raise ContractError("expected_version debe ser un entero no negativo.")
            if expected < 0:
                raise ContractError("expected_version debe ser un entero no negativo.")
        reason = str(value.get("reason") or "").strip()
        if len(reason) > 2000:
            raise ContractError("El motivo es demasiado largo.")
        origin = str(value.get("origin") or "web").strip().lower()
        if origin not in ORIGINS:
            raise ContractError("Origen ERP no admitido.")
        return cls(command, community_id, payload, key, expected, reason, origin,
                   EvidenceRef.from_value(value.get("evidence")))

    def request_hash(self):
        safe = {
            "command": self.command,
            "id_comunidad": self.community_id,
            "payload": self.payload,
            "expected_version": self.expected_version,
            "reason": self.reason,
            "origin": self.origin,
            "evidence": None if self.evidence is None else {
                "type": self.evidence.entity_type, "id": self.evidence.entity_id,
            },
        }
        return hashlib.sha256(canonical_json(safe).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class QueryEnvelope:
    query: str
    community_id: int
    filters: dict

    @classmethod
    def from_value(cls, value):
        if not isinstance(value, dict) or set(value) - {"query", "id_comunidad", "filters"}:
            raise ContractError("La consulta ERP no cumple el contrato.")
        query = str(value.get("query") or "").strip()
        try:
            community_id = int(value.get("id_comunidad") or 0)
        except (TypeError, ValueError):
            community_id = 0
        filters = value.get("filters") or {}
        if not query or community_id <= 0 or not isinstance(filters, dict):
            raise ContractError("La consulta requiere nombre, comunidad y filtros validos.")
        return cls(query, community_id, filters)
