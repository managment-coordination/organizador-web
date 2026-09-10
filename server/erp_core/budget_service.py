"""Transactional ERP 2 services built on the deterministic ERP 2B engine."""

from calendar import monthrange
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import json
import uuid

from access_control import budget_permission, require_budget_permission

from .audit import write_event
from .budget_contracts import CONTRACT_VERSION, MOTOR_VERSION
from .budget_engine import explain_property, simulate_budget
from .budget_simulation import load_simulation, persist_simulation
from .contracts import Actor, canonical_json
from .database import connect, write_transaction
from .errors import ConflictError, ContractError, NotFoundError
from .migrations import utc_now
from .outbox import enqueue
from .repository import CommandRepository, FoundationRepository


FREQUENCIES = {"mensual": 12, "trimestral": 4, "semestral": 2, "anual": 1}
RULES = {"coeficiente", "partes_iguales", "importe_fijo", "unidades", "porcentaje_especial"}


def _rows(cursor):
    return [dict(row) for row in cursor]


def _money(value, field="importe"):
    if isinstance(value, bool):
        raise ContractError(f"{field} debe expresarse en centimos enteros.")
    raw = str(value if value is not None else "").strip()
    if not raw or (raw[0] == "-" and not raw[1:].isdigit()) or (raw[0] != "-" and not raw.isdigit()):
        raise ContractError(f"{field} debe expresarse en centimos enteros.")
    return int(raw)


def _decimal(value, field="valor", *, non_negative=True):
    raw = str(value if value is not None else "").strip().replace(",", ".")
    try:
        number = Decimal(raw)
    except InvalidOperation as exc:
        raise ContractError(f"{field} debe ser decimal exacto.") from exc
    if not number.is_finite() or (non_negative and number < 0):
        raise ContractError(f"{field} no es valido.")
    text = format(number, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _text(value, field, maximum=500, required=False):
    result = str(value or "").strip()
    if required and not result:
        raise ContractError(f"{field} es obligatorio.")
    if len(result) > maximum:
        raise ContractError(f"{field} supera la longitud admitida.")
    return result or None


def _iso(value, field, required=True):
    raw = str(value or "").strip()
    if not raw and not required:
        return None
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError as exc:
        raise ContractError(f"{field} debe tener formato AAAA-MM-DD.") from exc


def _id(value, field):
    try:
        result = int(value)
    except (TypeError, ValueError):
        result = 0
    if result <= 0:
        raise ContractError(f"{field} no es valido.")
    return result


def _add_months(value, months):
    month = value.month - 1 + months
    year = value.year + month // 12
    month = month % 12 + 1
    return date(year, month, min(value.day, monthrange(year, month)[1]))


def _periods(start_raw, end_raw, frequency, issue_day=None, due_day=None):
    start, end = date.fromisoformat(start_raw), date.fromisoformat(end_raw)
    count = FREQUENCIES.get(frequency)
    if not count:
        raise ContractError("La periodicidad ordinaria no es valida.")
    months = 12 // count
    values = []
    cursor = start
    for index in range(count):
        next_start = None if index == count - 1 else min(_add_months(start, months * (index + 1)), end + timedelta(days=1))
        period_end = end if next_start is None else min(end, next_start - timedelta(days=1))
        emission = None
        due = None
        if issue_day:
            emission = date(cursor.year, cursor.month, min(int(issue_day), monthrange(cursor.year, cursor.month)[1])).isoformat()
        if due_day:
            due = date(cursor.year, cursor.month, min(int(due_day), monthrange(cursor.year, cursor.month)[1])).isoformat()
        values.append({
            "key": f"P{index + 1:02d}", "order": index, "weight": "1",
            "date_start": cursor.isoformat(), "date_end": period_end.isoformat(),
            "issue_date": emission, "due_date": due,
        })
        if next_start is not None:
            cursor = next_start
    return values


class BudgetService:
    def __init__(self, database_path):
        self.database_path = database_path

    def _read(self, session, query, operation, permission="puede_ver"):
        Actor.from_session(session)
        conn = connect(self.database_path, readonly=True)
        try:
            require_budget_permission(conn, session, query.community_id, permission)
            FoundationRepository(conn).require_active_community(query.community_id)
            return operation(conn, query)
        finally:
            conn.close()

    def _write(self, session, envelope, operation, permission="puede_preparar"):
        actor = Actor.from_session(session)
        if not envelope.idempotency_key:
            raise ContractError("Los comandos ERP 2 requieren idempotency_key.")
        conn = connect(self.database_path)
        try:
            with write_transaction(conn):
                require_budget_permission(conn, session, envelope.community_id, permission)
                FoundationRepository(conn).require_active_community(envelope.community_id)
                commands = CommandRepository(conn)
                replay = commands.replay_or_start(envelope, actor)
                if replay is not None:
                    return replay
                outcome = operation(conn, actor, envelope)
                event_id = write_event(
                    conn, community_id=envelope.community_id, actor=actor,
                    action=outcome["action"], entity_type=outcome["entity_type"],
                    entity_id=outcome.get("entity_id"), before=outcome.get("before"),
                    after=outcome.get("after"), reason=envelope.reason,
                    origin=envelope.origin, request_id=envelope.idempotency_key,
                    entity_version=outcome.get("entity_version"), evidence=envelope.evidence,
                    metadata={"contract": CONTRACT_VERSION},
                )
                outbox_id = enqueue(
                    conn, community_id=envelope.community_id,
                    event_type=outcome["event_type"], aggregate_type=outcome["entity_type"],
                    aggregate_id=outcome.get("entity_id"),
                    payload={"id_comunidad": envelope.community_id,
                             "entity_id": outcome.get("entity_id"),
                             "version": outcome.get("entity_version"),
                             "audit_event_id": event_id},
                    dedupe_key=envelope.idempotency_key,
                )
                response = {"ok": True, "command": envelope.command,
                            "entity": outcome.get("result", outcome.get("after")),
                            "audit_event_id": event_id, "outbox_event_id": outbox_id,
                            "idempotent_replay": False}
                commands.complete(envelope, response)
                return response
        finally:
            conn.close()

    @staticmethod
    def _budget(conn, community_id, budget_id):
        row = conn.execute("""SELECT b.*,v.id_presupuesto_version,v.version AS version_contenido,
            v.fecha_inicio,v.fecha_fin,v.periodicidad,v.dia_emision_previsto,v.dia_vencimiento,
            v.estado AS estado_version,v.version_concurrencia,v.id_version_origen,
            v.registrada_en AS version_registrada_en
            FROM erp_presupuestos b JOIN erp_presupuesto_versiones v
              ON v.id_comunidad=b.id_comunidad AND v.id_presupuesto=b.id_presupuesto
            WHERE b.id_comunidad=? AND b.id_presupuesto=?
            ORDER BY v.version DESC LIMIT 1""", (community_id, budget_id)).fetchone()
        if not row:
            raise NotFoundError("El presupuesto no existe en la comunidad seleccionada.")
        return dict(row)

    @staticmethod
    def _assert_draft(row, envelope=None):
        if row["estado"] != "borrador" or row["estado_version"] != "borrador":
            raise ConflictError("Solo puede editarse directamente un presupuesto en borrador.")
        if envelope and envelope.expected_version is not None and int(row["version_concurrencia"]) != envelope.expected_version:
            raise ConflictError("El presupuesto ha cambiado; vuelve a cargarlo antes de guardar.")

    @staticmethod
    def _rule(conn, community_id, actor_id, rule_type, group_id, purpose, unit, config, origin):
        if rule_type not in RULES:
            raise ContractError("La regla de reparto no esta disponible en ERP 2.")
        params = {"group_id": group_id}
        if rule_type in {"coeficiente", "porcentaje_especial"}:
            params.update(series_purpose=purpose or "general", series_unit=unit or "porcentaje")
        elif rule_type == "importe_fijo":
            params.update(amount_cents=str(_money(config.get("fixed_cents"), "importe fijo")),
                          scope=str(config.get("fixed_scope") or "interval"))
        elif rule_type == "unidades":
            params.update(unit=_text(config.get("unit") or "unidad", "unidad", 80, True),
                          tariff_decimal=_decimal(config.get("tariff_decimal"), "tarifa"),
                          quantities_source="erp_partida_reparto_valores")
        signature = hashlib.sha256(canonical_json({"type": rule_type, "params": params}).encode()).hexdigest()[:16]
        code = f"AUTO-{rule_type.upper()}-{signature}"
        row = conn.execute("""SELECT v.* FROM erp_reglas_reparto r JOIN erp_regla_versiones v
            ON v.id_regla=r.id_regla WHERE r.id_comunidad=? AND r.codigo=? AND v.estado='aprobada'
            ORDER BY v.version DESC LIMIT 1""", (community_id, code)).fetchone()
        if row:
            return int(row["id_regla_version"])
        now = utc_now()
        rule_id = conn.execute("""INSERT INTO erp_reglas_reparto
            (id_comunidad,codigo,nombre,tipo,estado,version,creada_en,creada_por,origen)
            VALUES (?,?,?,?, 'activa',1,?,?,?)""",
            (community_id, code, rule_type.replace("_", " ").title(), rule_type, now, actor_id, origin)).lastrowid
        return conn.execute("""INSERT INTO erp_regla_versiones
            (id_comunidad,id_regla,version,codigo_motor,version_motor,parametros_json,
             esquema_parametros_json,estado,registrada_en,registrada_por,origen)
            VALUES (?,?,1,?,?,?,?,'aprobada',?,?,?)""",
            (community_id, rule_id, rule_type, MOTOR_VERSION, canonical_json(params), "{}", now, actor_id, origin)).lastrowid

    def reference_get(self, session, query):
        def op(conn, q):
            return {"ok": True, "query": q.query,
                    "community": dict(conn.execute("SELECT id_comunidad,nombre,moneda FROM comunidades WHERE id_comunidad=?", (q.community_id,)).fetchone()),
                    "permissions": {field: budget_permission(conn, session, q.community_id, field) for field in (
                        "puede_ver", "puede_preparar", "puede_aprobar", "puede_configurar_cobro"
                    )},
                    "exercises": _rows(conn.execute("""SELECT * FROM erp_ejercicios WHERE id_comunidad=?
                        ORDER BY CASE estado WHEN 'abierto' THEN 0 WHEN 'preparacion' THEN 1 ELSE 2 END,
                        fecha_inicio DESC,id_ejercicio DESC""", (q.community_id,))),
                    "groups": _rows(conn.execute("""SELECT g.id_grupo,g.codigo,g.nombre,g.estado,v.id_grupo_version,
                        v.base,v.suma_esperada_decimal,v.estado AS estado_version
                        FROM erp_grupos_reparto g JOIN erp_grupo_versiones v ON v.id_grupo=g.id_grupo
                        WHERE g.id_comunidad=? AND g.estado='activo' AND v.estado='aprobada'
                        AND v.version=(SELECT MAX(v2.version) FROM erp_grupo_versiones v2 WHERE v2.id_grupo=g.id_grupo AND v2.estado='aprobada')
                        ORDER BY g.nombre""", (q.community_id,))),
                    "properties": _rows(conn.execute("SELECT id_propiedad,codigo_propiedad AS codigo,descripcion_direccion AS denominacion,tipo_propiedad AS tipo,estado FROM cf_propiedades WHERE id_comunidad=? AND estado<>'baja' ORDER BY codigo_normalizado", (q.community_id,))),
                    "frequency": dict(conn.execute("SELECT * FROM erp_comunidad_cuota_config WHERE id_comunidad=?", (q.community_id,)).fetchone() or {"periodicidad": "mensual", "dia_emision_previsto": 3, "dia_vencimiento": 10})}
        return self._read(session, query, op)

    def budget_create(self, session, envelope):
        def op(conn, actor, env):
            p = env.payload
            exercise_id = _id(p.get("id_ejercicio"), "ejercicio")
            exercise = conn.execute("SELECT * FROM erp_ejercicios WHERE id_comunidad=? AND id_ejercicio=?", (env.community_id, exercise_id)).fetchone()
            if not exercise:
                raise ContractError("El ejercicio no pertenece a la comunidad.")
            name = _text(p.get("denominacion"), "denominacion", 240, True)
            code = _text(p.get("codigo") or f"P-{exercise['codigo']}-{uuid.uuid4().hex[:6].upper()}", "codigo", 80, True)
            frequency = str(p.get("periodicidad") or "mensual")
            if frequency not in FREQUENCIES:
                raise ContractError("La periodicidad no es valida.")
            start = _iso(p.get("fecha_inicio") or exercise["fecha_inicio"], "fecha_inicio")
            end = _iso(p.get("fecha_fin") or exercise["fecha_fin"], "fecha_fin")
            if end < start:
                raise ContractError("La fecha final no puede ser anterior a la inicial.")
            now = utc_now()
            budget_id = conn.execute("""INSERT INTO erp_presupuestos
                (id_comunidad,id_ejercicio,codigo,denominacion,tipo,moneda,estado,version,creado_en,creado_por,origen)
                VALUES (?,?,?,?, 'ordinario',?,'borrador',1,?,?,?)""",
                (env.community_id, exercise_id, code, name, exercise["moneda"], now, actor.user_id, env.origin)).lastrowid
            version_id = conn.execute("""INSERT INTO erp_presupuesto_versiones
                (id_comunidad,id_presupuesto,version,fecha_inicio,fecha_fin,periodicidad,dia_emision_previsto,
                 dia_vencimiento,estado,version_concurrencia,registrada_en,registrada_por,origen)
                VALUES (?,?,1,?,?,?,?,?,'borrador',1,?,?,?)""",
                (env.community_id, budget_id, start, end, frequency, int(p.get("dia_emision_previsto") or 3),
                 int(p.get("dia_vencimiento") or 10), now, actor.user_id, env.origin)).lastrowid
            conn.execute("""INSERT INTO erp_comunidad_cuota_config
                (id_comunidad,periodicidad,dia_emision_previsto,dia_vencimiento,version,actualizada_en,actualizada_por,origen)
                VALUES (?,?,?,?,1,?,?,?) ON CONFLICT(id_comunidad) DO UPDATE SET
                periodicidad=excluded.periodicidad,dia_emision_previsto=excluded.dia_emision_previsto,
                dia_vencimiento=excluded.dia_vencimiento,version=erp_comunidad_cuota_config.version+1,
                actualizada_en=excluded.actualizada_en,actualizada_por=excluded.actualizada_por,origen=excluded.origen""",
                (env.community_id,frequency,int(p.get("dia_emision_previsto") or 3),int(p.get("dia_vencimiento") or 10),now,actor.user_id,env.origin))
            after = self._budget(conn, env.community_id, budget_id)
            return {"action": "Presupuesto creado", "entity_type": "erp_presupuesto", "entity_id": budget_id,
                    "entity_version": 1, "before": None, "after": after, "event_type": "erp2.budget.created",
                    "result": {**after, "id_presupuesto_version": version_id}}
        return self._write(session, envelope, op)

    def _replace_content(self, conn, actor, env, budget):
        p = env.payload
        chapters = p.get("chapters")
        if not isinstance(chapters, list):
            raise ContractError("Los capitulos deben enviarse como lista.")
        version_id = int(budget["id_presupuesto_version"])
        old_links = _rows(conn.execute("""SELECT c.id_partida_origen,p.clave_continuidad
            FROM erp_presupuesto_correspondencias c JOIN erp_presupuesto_partidas p ON p.id_partida=c.id_partida_destino
            WHERE p.id_presupuesto_version=? AND c.tipo IN ('copia','continuidad')""", (version_id,)))
        conn.execute("UPDATE erp_simulaciones SET estado='obsoleta' WHERE id_comunidad=? AND id_presupuesto_version=? AND estado='completa'", (env.community_id, version_id))
        conn.execute("DELETE FROM erp_presupuesto_correspondencias WHERE id_partida_destino IN (SELECT id_partida FROM erp_presupuesto_partidas WHERE id_presupuesto_version=?)", (version_id,))
        conn.execute("DELETE FROM erp_partida_reparto_valores WHERE id_asignacion IN (SELECT r.id_asignacion FROM erp_partida_repartos r JOIN erp_presupuesto_partidas p ON p.id_partida=r.id_partida WHERE p.id_presupuesto_version=?)", (version_id,))
        conn.execute("DELETE FROM erp_partida_exenciones WHERE id_partida IN (SELECT id_partida FROM erp_presupuesto_partidas WHERE id_presupuesto_version=?)", (version_id,))
        conn.execute("DELETE FROM erp_partida_repartos WHERE id_partida IN (SELECT id_partida FROM erp_presupuesto_partidas WHERE id_presupuesto_version=?)", (version_id,))
        conn.execute("DELETE FROM erp_partida_financiaciones WHERE id_partida IN (SELECT id_partida FROM erp_presupuesto_partidas WHERE id_presupuesto_version=?)", (version_id,))
        conn.execute("DELETE FROM erp_presupuesto_partidas WHERE id_presupuesto_version=?", (version_id,))
        conn.execute("DELETE FROM erp_presupuesto_capitulos WHERE id_presupuesto_version=?", (version_id,))
        links = {row["clave_continuidad"]: row["id_partida_origen"] for row in old_links}
        seen_chapters = set()
        for chapter_order, chapter in enumerate(chapters):
            key = _text(chapter.get("key") or f"CAP-{chapter_order + 1}", "clave de capitulo", 120, True)
            if key in seen_chapters:
                raise ContractError("Las claves de capitulos deben ser unicas.")
            seen_chapters.add(key)
            chapter_id = conn.execute("""INSERT INTO erp_presupuesto_capitulos
                (id_comunidad,id_presupuesto_version,clave_continuidad,codigo,nombre,descripcion,orden)
                VALUES (?,?,?,?,?,?,?)""", (env.community_id, version_id, key, _text(chapter.get("code"), "codigo", 80),
                _text(chapter.get("name"), "nombre de capitulo", 240, True), _text(chapter.get("description"), "descripcion", 2000), chapter_order)).lastrowid
            items = chapter.get("items") or []
            if not isinstance(items, list):
                raise ContractError("Las partidas deben enviarse como lista.")
            for item_order, item in enumerate(items):
                item_key = _text(item.get("key") or f"{key}-P{item_order + 1}", "clave de partida", 140, True)
                item_id = conn.execute("""INSERT INTO erp_presupuesto_partidas
                    (id_comunidad,id_presupuesto_version,id_capitulo,clave_continuidad,codigo,concepto,descripcion,importe_centimos,orden,categoria_origen,referencia_pgc)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (env.community_id, version_id, chapter_id, item_key,
                    _text(item.get("code"), "codigo", 80), _text(item.get("name"), "concepto", 300, True),
                    _text(item.get("description"), "descripcion", 2000), _money(item.get("amount_cents")), item_order,
                    _text(item.get("budget_group"), "grupo presupuestario", 160), _text(item.get("pgc_reference"), "referencia PGC", 40))).lastrowid
                if item_key in links:
                    conn.execute("""INSERT INTO erp_presupuesto_correspondencias
                        (id_comunidad,id_partida_origen,id_partida_destino,tipo,confirmada_en,confirmada_por,origen)
                        VALUES (?,?,?,'continuidad',?,?,?)""", (env.community_id, links[item_key], item_id, utc_now(), actor.user_id, env.origin))
                financing = item.get("financing") or []
                for source in financing:
                    conn.execute("""INSERT INTO erp_partida_financiaciones
                        (id_comunidad,id_partida,tipo_fuente,importe_centimos,descripcion,estado_revision,evidencia_tipo,evidencia_id)
                        VALUES (?,?,?,?,?,'confirmada',?,?)""", (env.community_id, item_id, source.get("type", "otro_ingreso"),
                        _money(source.get("amount_cents"), "financiacion"), _text(source.get("description"), "descripcion", 500),
                        _text(source.get("evidence_type"), "evidencia", 80), _text(source.get("evidence_id"), "evidencia", 200)))
                assignments = item.get("assignments") or []
                for assignment_order, assignment in enumerate(assignments):
                    group_id = _id(assignment.get("group_id"), "grupo")
                    group = conn.execute("""SELECT g.id_grupo,v.id_grupo_version,v.base FROM erp_grupos_reparto g
                        JOIN erp_grupo_versiones v ON v.id_grupo=g.id_grupo
                        WHERE g.id_comunidad=? AND g.id_grupo=? AND g.estado='activo' AND v.estado='aprobada'
                        ORDER BY v.version DESC LIMIT 1""", (env.community_id, group_id)).fetchone()
                    if not group:
                        raise ContractError("El grupo seleccionado no tiene una version aprobada.")
                    rule_type = str(assignment.get("rule_type") or "coeficiente")
                    purpose = _text(assignment.get("series_purpose") or "general", "finalidad", 120)
                    unit = _text(assignment.get("series_unit") or ("porcentaje" if group["base"] == "porcentaje" else "peso"), "unidad", 40)
                    rule_version_id = self._rule(conn, env.community_id, actor.user_id, rule_type, group_id, purpose, unit, assignment, env.origin)
                    mode = str(assignment.get("mode") or "porcentaje")
                    if mode not in {"importe", "porcentaje"}:
                        raise ContractError("El modo de reparto debe ser importe o porcentaje.")
                    value = str(_money(assignment.get("value"), "importe de asignacion")) if mode == "importe" else _decimal(assignment.get("value"), "porcentaje")
                    assignment_id = conn.execute("""INSERT INTO erp_partida_repartos
                        (id_comunidad,id_partida,clave_linea,id_grupo,id_grupo_version,finalidad_serie,unidad_serie,id_regla_version,modo,valor_decimal,orden)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (env.community_id, item_id,
                        _text(assignment.get("key") or f"R{assignment_order + 1}", "clave de reparto", 120, True),
                        group_id, group["id_grupo_version"], purpose, unit, rule_version_id, mode, value, assignment_order)).lastrowid
                    quantities = assignment.get("quantities") or {}
                    if rule_type == "unidades":
                        if not isinstance(quantities, dict):
                            raise ContractError("Las unidades deben indicarse por propiedad.")
                        for property_id, quantity in quantities.items():
                            conn.execute("""INSERT INTO erp_partida_reparto_valores
                                (id_comunidad,id_asignacion,id_propiedad,tipo,valor_decimal,version,origen)
                                VALUES (?,?,?,'unidades',?,1,?)""", (env.community_id, assignment_id,
                                _id(property_id, "propiedad"), _decimal(quantity, "unidades"), env.origin))
                for exclusion in item.get("exclusions") or []:
                    conn.execute("""INSERT INTO erp_partida_exenciones
                        (id_comunidad,id_partida,id_propiedad,efectiva_desde,efectiva_hasta,tratamiento,motivo,
                         evidencia_tipo,evidencia_id,version,estado,creada_en,creada_por,origen)
                        VALUES (?,?,?,?,?,?,?,?,?,1,'activa',?,?,?)""", (env.community_id, item_id,
                        _id(exclusion.get("property_id"), "propiedad"), _iso(exclusion.get("date_start"), "fecha", False),
                        _iso(exclusion.get("date_end"), "fecha", False), exclusion.get("treatment", "redistribuir"),
                        _text(exclusion.get("reason"), "motivo", 1000, True), _text(exclusion.get("evidence_type"), "evidencia", 80),
                        _text(exclusion.get("evidence_id"), "evidencia", 200), utc_now(), actor.user_id, env.origin))
        conn.execute("UPDATE erp_presupuesto_versiones SET version_concurrencia=version_concurrencia+1 WHERE id_presupuesto_version=?", (version_id,))

    def budget_save(self, session, envelope):
        def op(conn, actor, env):
            budget = self._budget(conn, env.community_id, _id(env.payload.get("id_presupuesto"), "presupuesto"))
            self._assert_draft(budget, env)
            before = {"id_presupuesto": budget["id_presupuesto"], "version_concurrencia": budget["version_concurrencia"]}
            self._replace_content(conn, actor, env, budget)
            after = self._budget(conn, env.community_id, budget["id_presupuesto"])
            return {"action": "Borrador de presupuesto guardado", "entity_type": "erp_presupuesto",
                    "entity_id": budget["id_presupuesto"], "entity_version": after["version_concurrencia"],
                    "before": before, "after": {"id_presupuesto": after["id_presupuesto"], "version_concurrencia": after["version_concurrencia"]},
                    "event_type": "erp2.budget.draft_saved", "result": after}
        return self._write(session, envelope, op)

    def budget_copy(self, session, envelope):
        def op(conn, actor, env):
            source = self._budget(conn, env.community_id, _id(env.payload.get("source_budget_id"), "presupuesto origen"))
            target_exercise = _id(env.payload.get("id_ejercicio"), "ejercicio")
            exercise = conn.execute("SELECT * FROM erp_ejercicios WHERE id_comunidad=? AND id_ejercicio=?", (env.community_id, target_exercise)).fetchone()
            if not exercise:
                raise ContractError("El ejercicio destino no pertenece a la comunidad.")
            now = utc_now()
            code = _text(env.payload.get("codigo") or f"{source['codigo']}-COPIA-{uuid.uuid4().hex[:4].upper()}", "codigo", 80, True)
            name = _text(env.payload.get("denominacion") or f"{source['denominacion']} - copia", "denominacion", 240, True)
            budget_id = conn.execute("""INSERT INTO erp_presupuestos
                (id_comunidad,id_ejercicio,codigo,denominacion,tipo,moneda,estado,version,creado_en,creado_por,origen)
                VALUES (?,?,?,?, 'ordinario',?,'borrador',1,?,?,?)""", (env.community_id,target_exercise,code,name,source["moneda"],now,actor.user_id,env.origin)).lastrowid
            version_id = conn.execute("""INSERT INTO erp_presupuesto_versiones
                (id_comunidad,id_presupuesto,version,fecha_inicio,fecha_fin,periodicidad,dia_emision_previsto,dia_vencimiento,
                 id_version_origen,estado,version_concurrencia,registrada_en,registrada_por,origen)
                VALUES (?,?,1,?,?,?,?,?,?,'borrador',1,?,?,?)""", (env.community_id,budget_id,exercise["fecha_inicio"],exercise["fecha_fin"],source["periodicidad"],source["dia_emision_previsto"],source["dia_vencimiento"],source["id_presupuesto_version"],now,actor.user_id,env.origin)).lastrowid
            chapter_map = {}
            for chapter in conn.execute("SELECT * FROM erp_presupuesto_capitulos WHERE id_presupuesto_version=? ORDER BY orden", (source["id_presupuesto_version"],)):
                chapter_map[chapter["id_capitulo"]] = conn.execute("""INSERT INTO erp_presupuesto_capitulos
                    (id_comunidad,id_presupuesto_version,clave_continuidad,codigo,nombre,descripcion,orden) VALUES (?,?,?,?,?,?,?)""",
                    (env.community_id,version_id,chapter["clave_continuidad"],chapter["codigo"],chapter["nombre"],chapter["descripcion"],chapter["orden"])).lastrowid
            for item in conn.execute("SELECT * FROM erp_presupuesto_partidas WHERE id_presupuesto_version=? ORDER BY id_capitulo,orden", (source["id_presupuesto_version"],)):
                new_item = conn.execute("""INSERT INTO erp_presupuesto_partidas
                    (id_comunidad,id_presupuesto_version,id_capitulo,clave_continuidad,codigo,concepto,descripcion,importe_centimos,orden,categoria_origen,referencia_pgc)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (env.community_id,version_id,chapter_map[item["id_capitulo"]],item["clave_continuidad"],item["codigo"],item["concepto"],item["descripcion"],item["importe_centimos"],item["orden"],item["categoria_origen"],item["referencia_pgc"])).lastrowid
                conn.execute("""INSERT INTO erp_presupuesto_correspondencias
                    (id_comunidad,id_partida_origen,id_partida_destino,tipo,confirmada_en,confirmada_por,origen)
                    VALUES (?,?,?,'copia',?,?,?)""", (env.community_id,item["id_partida"],new_item,now,actor.user_id,env.origin))
                for assignment in conn.execute("SELECT * FROM erp_partida_repartos WHERE id_partida=? ORDER BY orden", (item["id_partida"],)):
                    new_assignment = conn.execute("""INSERT INTO erp_partida_repartos
                        (id_comunidad,id_partida,clave_linea,id_grupo,id_grupo_version,finalidad_serie,unidad_serie,id_regla_version,modo,valor_decimal,orden)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (env.community_id,new_item,assignment["clave_linea"],assignment["id_grupo"],assignment["id_grupo_version"],assignment["finalidad_serie"],assignment["unidad_serie"],assignment["id_regla_version"],assignment["modo"],assignment["valor_decimal"],assignment["orden"])).lastrowid
                    conn.execute("""INSERT INTO erp_partida_reparto_valores(id_comunidad,id_asignacion,id_propiedad,tipo,valor_decimal,version,origen)
                        SELECT id_comunidad,?,id_propiedad,tipo,valor_decimal,version,? FROM erp_partida_reparto_valores WHERE id_asignacion=?""", (new_assignment,env.origin,assignment["id_asignacion"]))
                conn.execute("""INSERT INTO erp_partida_financiaciones(id_comunidad,id_partida,tipo_fuente,importe_centimos,descripcion,estado_revision,evidencia_tipo,evidencia_id)
                    SELECT id_comunidad,?,tipo_fuente,importe_centimos,descripcion,estado_revision,evidencia_tipo,evidencia_id FROM erp_partida_financiaciones WHERE id_partida=?""", (new_item,item["id_partida"]))
                conn.execute("""INSERT INTO erp_partida_exenciones(id_comunidad,id_partida,id_propiedad,efectiva_desde,efectiva_hasta,tratamiento,motivo,evidencia_tipo,evidencia_id,version,estado,creada_en,creada_por,origen)
                    SELECT id_comunidad,?,id_propiedad,efectiva_desde,efectiva_hasta,tratamiento,motivo,evidencia_tipo,evidencia_id,1,estado,?,?,? FROM erp_partida_exenciones WHERE id_partida=?""", (new_item,now,actor.user_id,env.origin,item["id_partida"]))
            after = self._budget(conn, env.community_id, budget_id)
            return {"action":"Presupuesto copiado","entity_type":"erp_presupuesto","entity_id":budget_id,"entity_version":1,
                    "before":None,"after":after,"event_type":"erp2.budget.copied","result":after}
        return self._write(session, envelope, op)

    @staticmethod
    def _active_versions(rows, reference_date):
        return [dict(row) for row in rows if (not row["efectiva_desde"] or row["efectiva_desde"] <= reference_date)
                and (not row["efectiva_hasta"] or row["efectiva_hasta"] > reference_date)]

    def _manifest(self, conn, community_id, budget):
        version_id = int(budget["id_presupuesto_version"])
        reference_date = budget["fecha_inicio"]
        periods = _periods(budget["fecha_inicio"], budget["fecha_fin"], budget["periodicidad"],
                           budget["dia_emision_previsto"], budget["dia_vencimiento"])
        items = []
        for item in conn.execute("""SELECT p.*,c.nombre AS capitulo FROM erp_presupuesto_partidas p
            JOIN erp_presupuesto_capitulos c ON c.id_capitulo=p.id_capitulo
            WHERE p.id_comunidad=? AND p.id_presupuesto_version=? ORDER BY c.orden,p.orden""", (community_id, version_id)):
            assignments = []
            for assignment in conn.execute("""SELECT a.*,g.nombre AS grupo_nombre,v.base,v.suma_esperada_decimal,
                v.estado AS grupo_estado,r.tipo AS regla_tipo,rv.parametros_json,rv.estado AS regla_estado
                FROM erp_partida_repartos a JOIN erp_grupos_reparto g ON g.id_grupo=a.id_grupo
                JOIN erp_grupo_versiones v ON v.id_grupo_version=a.id_grupo_version
                JOIN erp_regla_versiones rv ON rv.id_regla_version=a.id_regla_version
                JOIN erp_reglas_reparto r ON r.id_regla=rv.id_regla
                WHERE a.id_comunidad=? AND a.id_partida=? ORDER BY a.orden""", (community_id, item["id_partida"])):
                members = []
                for member in conn.execute("SELECT * FROM erp_grupo_miembros WHERE id_comunidad=? AND id_grupo=? ORDER BY id_propiedad", (community_id, assignment["id_grupo"])):
                    versions = self._active_versions(conn.execute("SELECT * FROM erp_grupo_miembro_versiones WHERE id_comunidad=? AND id_miembro=? ORDER BY version", (community_id, member["id_miembro"])), reference_date)
                    if len(versions) > 1:
                        raise ContractError(f"La propiedad {member['id_propiedad']} tiene pertenencias vigentes incompatibles.")
                    if not versions or not versions[0]["participa"] or versions[0]["excluida"]:
                        continue
                    entry = {"property_id": int(member["id_propiedad"]), "participates": True,
                             "member_version_id": int(versions[0]["id_miembro_version"])}
                    exclusion = conn.execute("""SELECT * FROM erp_partida_exenciones WHERE id_comunidad=? AND id_partida=? AND id_propiedad=?
                        AND estado='activa' AND (efectiva_desde IS NULL OR efectiva_desde<=?)
                        AND (efectiva_hasta IS NULL OR efectiva_hasta>?) ORDER BY id_exencion DESC LIMIT 1""",
                        (community_id,item["id_partida"],member["id_propiedad"],reference_date,reference_date)).fetchone()
                    if exclusion:
                        entry["exclusion"] = {"id": exclusion["id_exencion"], "treatment": exclusion["tratamiento"], "reason": exclusion["motivo"]}
                    if assignment["regla_tipo"] in {"coeficiente", "porcentaje_especial"}:
                        candidates = []
                        for coefficient in conn.execute("""SELECT s.id_serie,s.finalidad,s.unidad,v.* FROM erp_coeficiente_series s
                            JOIN erp_coeficiente_versiones v ON v.id_serie=s.id_serie
                            WHERE s.id_comunidad=? AND s.id_propiedad=? AND s.id_grupo=? AND s.finalidad=? AND s.unidad=?
                              AND s.estado='activa' ORDER BY s.id_serie,v.version""",
                            (community_id,member["id_propiedad"],assignment["id_grupo"],assignment["finalidad_serie"],assignment["unidad_serie"])):
                            if (not coefficient["efectiva_desde"] or coefficient["efectiva_desde"] <= reference_date) and (not coefficient["efectiva_hasta"] or coefficient["efectiva_hasta"] > reference_date):
                                candidates.append({"series_id":coefficient["id_serie"],"version_id":coefficient["id_coeficiente_version"],
                                    "purpose":coefficient["finalidad"],"unit":coefficient["unidad"],"value":coefficient["valor_decimal"],
                                    "quality":coefficient["calidad"],"state":coefficient["estado"]})
                        entry["coefficient_candidates"] = candidates
                    if assignment["regla_tipo"] == "unidades":
                        quantity = conn.execute("SELECT valor_decimal FROM erp_partida_reparto_valores WHERE id_asignacion=? AND id_propiedad=? AND tipo='unidades'", (assignment["id_asignacion"],member["id_propiedad"])).fetchone()
                        entry["quantity"] = quantity[0] if quantity else None
                    members.append(entry)
                rule = {"version_id": int(assignment["id_regla_version"]), "type": assignment["regla_tipo"],
                        "state": assignment["regla_estado"], "parameters": json.loads(assignment["parametros_json"] or "{}")}
                assignments.append({
                    "id": int(assignment["id_asignacion"]), "key": assignment["clave_linea"],
                    "mode": assignment["modo"], "value": assignment["valor_decimal"],
                    "series_purpose": assignment["finalidad_serie"], "series_unit": assignment["unidad_serie"],
                    "group": {"id": int(assignment["id_grupo"]), "version_id": int(assignment["id_grupo_version"]),
                              "name": assignment["grupo_nombre"], "base": assignment["base"],
                              "expected_total": assignment["suma_esperada_decimal"], "state": assignment["grupo_estado"]},
                    "rule": rule, "members": members,
                })
            financing = [{"amount_cents": str(row["importe_centimos"]), "confirmed": row["estado_revision"] == "confirmada"}
                         for row in conn.execute("SELECT * FROM erp_partida_financiaciones WHERE id_partida=?", (item["id_partida"],))]
            items.append({"id":int(item["id_partida"]),"key":item["clave_continuidad"],"name":item["concepto"],
                          "chapter_id":int(item["id_capitulo"]),"chapter_name":item["capitulo"],
                          "amount_cents":str(item["importe_centimos"]),"financing":financing,"assignments":assignments})
        return {"contract_version":CONTRACT_VERSION,"community_id":community_id,"budget_version_id":version_id,
                "budget_version_number":int(budget["version_contenido"]),"origin_type":"presupuesto","origin_id":str(version_id),
                "reference_date":reference_date,"known_at":budget["version_registrada_en"],"currency":budget["moneda"],
                "periodicity":budget["periodicidad"],"periods":periods,"items":items}

    def budget_simulate(self, session, envelope):
        actor = Actor.from_session(session)
        conn = connect(self.database_path, readonly=True)
        try:
            require_budget_permission(conn, session, envelope.community_id, "puede_preparar")
            budget = self._budget(conn, envelope.community_id, _id(envelope.payload.get("id_presupuesto"), "presupuesto"))
            if budget["estado"] not in {"borrador", "propuesto"}:
                raise ConflictError("Un presupuesto aprobado conserva su simulacion congelada y no se recalcula.")
            manifest = self._manifest(conn, envelope.community_id, budget)
        finally:
            conn.close()
        result = persist_simulation(self.database_path, manifest, actor_id=actor.user_id, origin=envelope.origin,
                                    simulate_failure=bool(envelope.payload.get("simulate_failure")))
        return {"ok": True, "command": envelope.command, "entity": result,
                "idempotent_replay": bool(result.get("idempotent_replay"))}

    def budget_propose(self, session, envelope):
        def op(conn, actor, env):
            budget = self._budget(conn, env.community_id, _id(env.payload.get("id_presupuesto"), "presupuesto"))
            self._assert_draft(budget, env)
            simulation = conn.execute("""SELECT * FROM erp_simulaciones WHERE id_comunidad=? AND id_presupuesto_version=?
                AND estado='completa' ORDER BY id_simulacion DESC LIMIT 1""", (env.community_id,budget["id_presupuesto_version"])).fetchone()
            if not simulation:
                raise ConflictError("Simula correctamente el presupuesto antes de presentarlo.")
            conn.execute("UPDATE erp_presupuestos SET estado='propuesto',version=version+1 WHERE id_presupuesto=?", (budget["id_presupuesto"],))
            conn.execute("UPDATE erp_presupuesto_versiones SET estado='propuesta',version_concurrencia=version_concurrencia+1 WHERE id_presupuesto_version=?", (budget["id_presupuesto_version"],))
            content_hash = simulation["hash_entradas"]
            conn.execute("""INSERT INTO erp_presupuesto_actos
                (id_comunidad,id_presupuesto,id_presupuesto_version,id_simulacion,tipo,hash_contenido,fecha_acuerdo,motivo,evidencia_tipo,evidencia_id,registrado_en,registrado_por)
                VALUES (?,?,?,?, 'proponer',?,?,?,?,?,?,?)""", (env.community_id,budget["id_presupuesto"],budget["id_presupuesto_version"],simulation["id_simulacion"],content_hash,
                _iso(env.payload.get("date"), "fecha", False),_text(env.payload.get("reason"),"motivo",1000),env.evidence.entity_type if env.evidence else None,
                env.evidence.entity_id if env.evidence else None,utc_now(),actor.user_id))
            after=self._budget(conn,env.community_id,budget["id_presupuesto"])
            return {"action":"Presupuesto presentado","entity_type":"erp_presupuesto","entity_id":budget["id_presupuesto"],"entity_version":after["version"],
                    "before":{"estado":"borrador"},"after":{"estado":"propuesto"},"event_type":"erp2.budget.proposed","result":after}
        return self._write(session,envelope,op)

    @staticmethod
    def _owners_at(conn, community_id, property_id, effective_date):
        return _rows(conn.execute("""SELECT v.id_propietario,v.porcentaje_decimal,o.nombre,o.nif
            FROM erp_titularidad_versiones v JOIN cf_propietarios o ON o.id_propietario=v.id_propietario
            WHERE v.id_comunidad=? AND v.id_propiedad=? AND v.anulada=0
              AND (v.efectiva_desde IS NULL OR v.efectiva_desde<=?)
              AND (v.efectiva_hasta IS NULL OR v.efectiva_hasta>?)
              AND v.id_titularidad_version=(SELECT MAX(v2.id_titularidad_version) FROM erp_titularidad_versiones v2 WHERE v2.id_relacion=v.id_relacion AND v2.registrada_en<=?)
            ORDER BY o.nombre""", (community_id,property_id,effective_date,effective_date,utc_now())))

    def _billing_at(self, conn, community_id, property_id, effective_date):
        config = conn.execute("""SELECT * FROM erp_config_recibo_versiones WHERE id_comunidad=? AND id_propiedad=?
            AND alcance='ordinario' AND estado='confirmada' AND (efectiva_desde IS NULL OR efectiva_desde<=?)
            AND (efectiva_hasta IS NULL OR efectiva_hasta>?) ORDER BY version DESC LIMIT 1""", (community_id,property_id,effective_date,effective_date)).fetchone()
        owners = self._owners_at(conn, community_id, property_id, effective_date)
        owner_by_id = {int(row["id_propietario"]):row for row in owners}
        recipient = payer = None
        if config:
            if config["destinatario_propietario_id"]:
                recipient = owner_by_id.get(int(config["destinatario_propietario_id"])) or {"id_propietario":config["destinatario_propietario_id"],"tipo":"propietario"}
            elif config["destinatario_persona_cobro_id"]:
                recipient = dict(conn.execute("SELECT * FROM erp_personas_cobro WHERE id_comunidad=? AND id_persona_cobro=?", (community_id,config["destinatario_persona_cobro_id"])).fetchone() or {})
            if config["pagador_propietario_id"]:
                payer = owner_by_id.get(int(config["pagador_propietario_id"])) or {"id_propietario":config["pagador_propietario_id"],"tipo":"propietario"}
            elif config["pagador_persona_cobro_id"]:
                payer = dict(conn.execute("SELECT * FROM erp_personas_cobro WHERE id_comunidad=? AND id_persona_cobro=?", (community_id,config["pagador_persona_cobro_id"])).fetchone() or {})
        if recipient is None and len(owners) == 1:
            recipient = owners[0]
        if payer is None:
            payer = recipient
        return {"config":dict(config) if config else None,"owners":owners,"recipient":recipient,"payer":payer,
                "status":"confirmado" if recipient else "pendiente_revision"}

    def budget_approve(self, session, envelope):
        def op(conn, actor, env):
            budget=self._budget(conn,env.community_id,_id(env.payload.get("id_presupuesto"),"presupuesto"))
            if budget["estado"]!="propuesto" or budget["estado_version"]!="propuesta":
                raise ConflictError("El presupuesto debe estar presentado antes de aprobarse.")
            if env.expected_version is not None and int(budget["version_concurrencia"])!=env.expected_version:
                raise ConflictError("El presupuesto ha cambiado; vuelve a revisarlo.")
            simulation_row=conn.execute("""SELECT * FROM erp_simulaciones WHERE id_comunidad=? AND id_presupuesto_version=? AND estado='completa'
                ORDER BY id_simulacion DESC LIMIT 1""",(env.community_id,budget["id_presupuesto_version"])).fetchone()
            if not simulation_row:
                raise ConflictError("No existe una simulacion completa para aprobar.")
            current_result=simulate_budget(self._manifest(conn,env.community_id,budget))
            if current_result.get("status")!="completa" or current_result.get("input_hash")!=simulation_row["hash_entradas"]:
                raise ConflictError("Los datos maestros o el borrador cambiaron; vuelve a simular antes de aprobar.")
            duplicate=conn.execute("SELECT id_presupuesto FROM erp_presupuestos WHERE id_comunidad=? AND id_ejercicio=? AND estado='aprobado' AND id_presupuesto<>?",(env.community_id,budget["id_ejercicio"],budget["id_presupuesto"])).fetchone()
            if duplicate:
                raise ConflictError("Ya existe un presupuesto ordinario aprobado para este ejercicio.")
            now=utc_now()
            plan_id=conn.execute("""INSERT INTO erp_planes_cuota
                (id_comunidad,tipo,origen_tipo,origen_id,moneda,estado,version,creado_en,creado_por,origen)
                VALUES (?,'ordinario','presupuesto',?,?,'aprobado',1,?,?,?)""",(env.community_id,str(budget["id_presupuesto"]),budget["moneda"],now,actor.user_id,env.origin)).lastrowid
            plan_version_id=conn.execute("""INSERT INTO erp_plan_versiones
                (id_comunidad,id_plan,version,id_simulacion,fecha_inicio,fecha_fin,estado,registrada_en,registrada_por,origen)
                VALUES (?,?,1,?,?,?,'aprobada',?,?,?)""",(env.community_id,plan_id,simulation_row["id_simulacion"],budget["fecha_inicio"],budget["fecha_fin"],now,actor.user_id,env.origin)).lastrowid
            result=load_simulation(self.database_path,env.community_id,simulation_row["id_simulacion"])
            period_ids={}
            for period in self._manifest(conn,env.community_id,budget)["periods"]:
                period_ids[period["key"]]=conn.execute("""INSERT INTO erp_plan_periodos
                    (id_comunidad,id_plan_version,clave_periodo,fecha_inicio,fecha_fin,fecha_emision_prevista,fecha_vencimiento,peso_decimal,id_ejercicio,orden)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""",(env.community_id,plan_version_id,period["key"],period["date_start"],period["date_end"],period["issue_date"],period["due_date"],period["weight"],budget["id_ejercicio"],period["order"])).lastrowid
            properties={int(row["property_id"]) for row in result.get("property_totals",[])}
            for period in self._manifest(conn,env.community_id,budget)["periods"]:
                emission=period["issue_date"] or period["date_start"]
                for property_id in properties:
                    billing=self._billing_at(conn,env.community_id,property_id,emission)
                    conn.execute("""INSERT INTO erp_plan_destinatarios_snapshot
                        (id_comunidad,id_plan_version,id_periodo_plan,id_propiedad,fecha_emision_referencia,conocida_en,id_config_recibo,
                         titulares_json,destinatario_json,pagador_json,estado) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (env.community_id,plan_version_id,period_ids[period["key"]],property_id,emission,now,
                         billing["config"]["id_config_recibo"] if billing["config"] else None,canonical_json(billing["owners"]),
                         canonical_json(billing["recipient"]) if billing["recipient"] else None,canonical_json(billing["payer"]) if billing["payer"] else None,billing["status"]))
            conn.execute("UPDATE erp_presupuestos SET estado='aprobado',version=version+1 WHERE id_presupuesto=?",(budget["id_presupuesto"],))
            conn.execute("UPDATE erp_presupuesto_versiones SET estado='aprobada',version_concurrencia=version_concurrencia+1 WHERE id_presupuesto_version=?",(budget["id_presupuesto_version"],))
            conn.execute("""INSERT INTO erp_presupuesto_actos
                (id_comunidad,id_presupuesto,id_presupuesto_version,id_simulacion,id_plan_version,tipo,hash_contenido,fecha_acuerdo,motivo,evidencia_tipo,evidencia_id,registrado_en,registrado_por)
                VALUES (?,?,?,?,?,'aprobar',?,?,?,?,?,?,?)""",(env.community_id,budget["id_presupuesto"],budget["id_presupuesto_version"],simulation_row["id_simulacion"],plan_version_id,simulation_row["hash_entradas"],
                _iso(env.payload.get("date") or date.today().isoformat(),"fecha"),_text(env.payload.get("reason") or "Aprobacion registrada","motivo",1000),env.evidence.entity_type if env.evidence else None,env.evidence.entity_id if env.evidence else None,now,actor.user_id))
            return {"action":"Presupuesto aprobado","entity_type":"erp_presupuesto","entity_id":budget["id_presupuesto"],"entity_version":int(budget["version"])+1,
                    "before":{"estado":"propuesto"},"after":{"estado":"aprobado","id_plan":plan_id,"id_plan_version":plan_version_id,"id_simulacion":simulation_row["id_simulacion"]},
                    "event_type":"erp2.budget.approved"}
        return self._write(session,envelope,op,"puede_aprobar")

    def budget_close(self, session, envelope):
        def op(conn, actor, env):
            budget=self._budget(conn,env.community_id,_id(env.payload.get("id_presupuesto"),"presupuesto"))
            if budget["estado"]!="aprobado":
                raise ConflictError("Solo puede cerrarse un presupuesto aprobado.")
            conn.execute("UPDATE erp_presupuestos SET estado='cerrado',version=version+1 WHERE id_presupuesto=?",(budget["id_presupuesto"],))
            conn.execute("""INSERT INTO erp_presupuesto_actos
                (id_comunidad,id_presupuesto,id_presupuesto_version,tipo,hash_contenido,fecha_acuerdo,motivo,registrado_en,registrado_por)
                VALUES (?,?,?,'cerrar',?,?,?,?,?)""",(env.community_id,budget["id_presupuesto"],budget["id_presupuesto_version"],
                hashlib.sha256(canonical_json({"budget":budget["id_presupuesto"],"version":budget["version_contenido"]}).encode()).hexdigest(),
                _iso(env.payload.get("date") or date.today().isoformat(),"fecha"),_text(env.payload.get("reason") or "Cierre de presupuesto","motivo",1000),utc_now(),actor.user_id))
            return {"action":"Presupuesto cerrado","entity_type":"erp_presupuesto","entity_id":budget["id_presupuesto"],"entity_version":int(budget["version"])+1,
                    "before":{"estado":"aprobado"},"after":{"estado":"cerrado"},"event_type":"erp2.budget.closed"}
        return self._write(session,envelope,op,"puede_aprobar")

    @staticmethod
    def _budget_detail(conn, community_id, budget_id):
        budget=BudgetService._budget(conn,community_id,budget_id)
        chapters=[]
        for chapter in conn.execute("SELECT * FROM erp_presupuesto_capitulos WHERE id_presupuesto_version=? ORDER BY orden",(budget["id_presupuesto_version"],)):
            chapter_data=dict(chapter); chapter_data["items"]=[]
            for item in conn.execute("SELECT * FROM erp_presupuesto_partidas WHERE id_capitulo=? ORDER BY orden",(chapter["id_capitulo"],)):
                data=dict(item)
                data["assignments"]=_rows(conn.execute("""SELECT a.*,g.nombre AS grupo_nombre,g.codigo AS grupo_codigo,r.tipo AS regla_tipo,
                    v.base AS grupo_base,rv.parametros_json FROM erp_partida_repartos a JOIN erp_grupos_reparto g ON g.id_grupo=a.id_grupo
                    JOIN erp_grupo_versiones v ON v.id_grupo_version=a.id_grupo_version
                    JOIN erp_regla_versiones rv ON rv.id_regla_version=a.id_regla_version
                    JOIN erp_reglas_reparto r ON r.id_regla=rv.id_regla WHERE a.id_partida=? ORDER BY a.orden""",(item["id_partida"],)))
                for assignment in data["assignments"]:
                    assignment["quantities"]={str(row["id_propiedad"]):row["valor_decimal"] for row in conn.execute("SELECT * FROM erp_partida_reparto_valores WHERE id_asignacion=?",(assignment["id_asignacion"],))}
                data["exclusions"]=_rows(conn.execute("""SELECT e.*,p.codigo_propiedad AS propiedad_codigo,
                    p.descripcion_direccion AS propiedad_nombre FROM erp_partida_exenciones e
                    JOIN cf_propiedades p ON p.id_propiedad=e.id_propiedad
                    WHERE e.id_partida=? ORDER BY p.codigo_propiedad""",(item["id_partida"],)))
                data["financing"]=_rows(conn.execute("SELECT * FROM erp_partida_financiaciones WHERE id_partida=?",(item["id_partida"],)))
                chapter_data["items"].append(data)
            chapter_data["total_centimos"]=sum(int(row["importe_centimos"]) for row in chapter_data["items"])
            chapters.append(chapter_data)
        budget["chapters"]=chapters
        budget["total_centimos"]=sum(row["total_centimos"] for row in chapters)
        simulation=conn.execute("""SELECT id_simulacion,estado,importe_objetivo_centimos,importe_resultado_centimos,creada_en,hash_entradas
            FROM erp_simulaciones WHERE id_comunidad=? AND id_presupuesto_version=? ORDER BY id_simulacion DESC LIMIT 1""",(community_id,budget["id_presupuesto_version"])).fetchone()
        budget["simulation"]=dict(simulation) if simulation else None
        budget["acts"]=_rows(conn.execute("SELECT * FROM erp_presupuesto_actos WHERE id_presupuesto=? ORDER BY registrado_en",(budget_id,)))
        return budget

    def budget_list(self, session, query):
        return self._read(session,query,lambda conn,q:{"ok":True,"query":q.query,"items":_rows(conn.execute("""SELECT b.*,e.codigo AS ejercicio_codigo,
            v.id_presupuesto_version,v.fecha_inicio,v.fecha_fin,v.periodicidad,v.version_concurrencia,
            COALESCE((SELECT SUM(p.importe_centimos) FROM erp_presupuesto_partidas p WHERE p.id_presupuesto_version=v.id_presupuesto_version),0) AS total_centimos,
            (SELECT s.id_simulacion FROM erp_simulaciones s WHERE s.id_presupuesto_version=v.id_presupuesto_version ORDER BY s.id_simulacion DESC LIMIT 1) AS id_simulacion
            FROM erp_presupuestos b JOIN erp_ejercicios e ON e.id_ejercicio=b.id_ejercicio
            JOIN erp_presupuesto_versiones v ON v.id_presupuesto=b.id_presupuesto
            WHERE b.id_comunidad=? AND b.estado<>'archivado' ORDER BY e.fecha_inicio DESC,b.creado_en DESC""",(q.community_id,)))})

    def budget_get(self, session, query):
        return self._read(session,query,lambda conn,q:{"ok":True,"query":q.query,"entity":self._budget_detail(conn,q.community_id,_id(q.filters.get("id_presupuesto"),"presupuesto"))})

    def simulation_get(self, session, query):
        def op(conn,q):
            simulation_id=_id(q.filters.get("id_simulacion"),"simulacion")
            row=conn.execute("SELECT id_simulacion FROM erp_simulaciones WHERE id_comunidad=? AND id_simulacion=?",(q.community_id,simulation_id)).fetchone()
            if not row: raise NotFoundError("La simulacion no existe.")
            return {"ok":True,"query":q.query,"entity":load_simulation(self.database_path,q.community_id,simulation_id)}
        return self._read(session,query,op)

    def quota_explain(self, session, query):
        def op(conn,q):
            simulation_id=_id(q.filters.get("id_simulacion"),"simulacion")
            property_id=_id(q.filters.get("id_propiedad"),"propiedad")
            prop=conn.execute("""SELECT id_propiedad,codigo_propiedad AS codigo,
                descripcion_direccion AS denominacion FROM cf_propiedades
                WHERE id_comunidad=? AND id_propiedad=?""",(q.community_id,property_id)).fetchone()
            if not prop: raise NotFoundError("La propiedad no existe.")
            result=load_simulation(self.database_path,q.community_id,simulation_id)
            explanation=explain_property(result,property_id,q.filters.get("period_key") or None)
            names={row["id_partida"]:dict(row) for row in conn.execute("""SELECT p.id_partida,p.concepto,c.nombre AS capitulo FROM erp_presupuesto_partidas p
                JOIN erp_presupuesto_capitulos c ON c.id_capitulo=p.id_capitulo WHERE p.id_comunidad=?""",(q.community_id,))}
            for detail in explanation["details"]:
                source=names.get(detail["item_id"],{});detail["item"]=source.get("concepto",detail["item"]);detail["chapter"]=source.get("capitulo")
            return {"ok":True,"query":q.query,"property":dict(prop),"entity":explanation}
        return self._read(session,query,op)

    def budget_compare(self, session, query):
        def op(conn,q):
            current=self._budget_detail(conn,q.community_id,_id(q.filters.get("id_presupuesto"),"presupuesto"))
            previous_id=q.filters.get("previous_budget_id")
            if previous_id:
                previous=self._budget_detail(conn,q.community_id,_id(previous_id,"presupuesto anterior"))
            else:
                row=conn.execute("""SELECT id_presupuesto FROM erp_presupuestos WHERE id_comunidad=? AND id_presupuesto<>?
                    AND estado IN ('aprobado','cerrado') AND id_ejercicio<? ORDER BY id_ejercicio DESC LIMIT 1""",(q.community_id,current["id_presupuesto"],current["id_ejercicio"])).fetchone()
                previous=self._budget_detail(conn,q.community_id,row[0]) if row else None
            def index(budget):
                return {item["clave_continuidad"]:{"name":item["concepto"],"chapter":chapter["nombre"],"chapter_key":chapter["clave_continuidad"],"cents":int(item["importe_centimos"])} for chapter in budget["chapters"] for item in chapter["items"]}
            old=index(previous) if previous else {};new=index(current);keys=sorted(set(old)|set(new))
            lines=[]
            for key in keys:
                before=old.get(key,{}).get("cents",0);after=new.get(key,{}).get("cents",0)
                source=new.get(key,old.get(key,{}))
                lines.append({"key":key,"name":source.get("name"),"chapter":source.get("chapter"),"chapter_key":source.get("chapter_key"),
                              "previous_cents":before,"current_cents":after,"difference_cents":after-before,
                              "difference_percent":None if before==0 else _decimal(Decimal(after-before)*100/Decimal(before),"porcentaje",non_negative=False)})
            chapter_keys=sorted({line["chapter_key"] for line in lines})
            chapters=[]
            for chapter_key in chapter_keys:
                chapter_lines=[line for line in lines if line["chapter_key"]==chapter_key]
                before=sum(line["previous_cents"] for line in chapter_lines);after=sum(line["current_cents"] for line in chapter_lines)
                chapters.append({"key":chapter_key,"name":chapter_lines[0]["chapter"],"previous_cents":before,"current_cents":after,
                                 "difference_cents":after-before,"difference_percent":None if before==0 else _decimal(Decimal(after-before)*100/Decimal(before),"porcentaje",non_negative=False)})
            def simulation_for(budget):
                if not budget: return None
                row=conn.execute("""SELECT id_simulacion FROM erp_simulaciones WHERE id_comunidad=? AND id_presupuesto_version=?
                    AND estado='completa' ORDER BY id_simulacion DESC LIMIT 1""",(q.community_id,budget["id_presupuesto_version"])).fetchone()
                return load_simulation(self.database_path,q.community_id,row[0]) if row else None
            current_sim=simulation_for(current);previous_sim=simulation_for(previous)
            current_properties={int(row["property_id"]):int(row["annual_cents"]) for row in (current_sim or {}).get("property_totals",[])}
            previous_properties={int(row["property_id"]):int(row["annual_cents"]) for row in (previous_sim or {}).get("property_totals",[])}
            properties=[]
            for property_id in sorted(set(current_properties)|set(previous_properties)):
                before=previous_properties.get(property_id,0);after=current_properties.get(property_id,0)
                prop=conn.execute("SELECT codigo_propiedad,descripcion_direccion FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?",(q.community_id,property_id)).fetchone()
                properties.append({"property_id":property_id,"code":prop[0] if prop else str(property_id),"name":prop[1] if prop else None,
                                   "previous_cents":before,"current_cents":after,"difference_cents":after-before,
                                   "difference_percent":None if before==0 else _decimal(Decimal(after-before)*100/Decimal(before),"porcentaje",non_negative=False)})
            previous_total=int(previous["total_centimos"]) if previous else 0;current_total=int(current["total_centimos"])
            return {"ok":True,"query":q.query,
                    "summary":{"previous_cents":previous_total,"current_cents":current_total,"difference_cents":current_total-previous_total,
                               "difference_percent":None if previous_total==0 else _decimal(Decimal(current_total-previous_total)*100/Decimal(previous_total),"porcentaje",non_negative=False)},
                    "current":{"id":current["id_presupuesto"],"total_cents":current_total},
                    "previous":None if not previous else {"id":previous["id_presupuesto"],"total_cents":previous_total},
                    "chapters":chapters,"lines":lines,"properties":properties}
        return self._read(session,query,op)

    def plan_export_preview(self, session, query):
        def op(conn,q):
            plan_id=_id(q.filters.get("id_plan"),"plan")
            row=conn.execute("""SELECT p.*,v.id_plan_version,v.id_simulacion,v.fecha_inicio,v.fecha_fin FROM erp_planes_cuota p
                JOIN erp_plan_versiones v ON v.id_plan=p.id_plan WHERE p.id_comunidad=? AND p.id_plan=? ORDER BY v.version DESC LIMIT 1""",(q.community_id,plan_id)).fetchone()
            if not row: raise NotFoundError("El plan no existe.")
            result=load_simulation(self.database_path,q.community_id,row["id_simulacion"])
            return {"ok":True,"query":q.query,"entity":{"plan":dict(row),"periods":_rows(conn.execute("SELECT * FROM erp_plan_periodos WHERE id_plan_version=? ORDER BY orden",(row["id_plan_version"],))),"quotas":result.get("property_totals",[]),"receipt_emission":False}}
        return self._read(session,query,op)

    def budget_import_preview(self, session, envelope):
        def op(conn, actor, env):
            raw=str(env.payload.get("text") or "").strip()
            if not raw: raise ContractError("Pega al menos una fila del presupuesto.")
            digest=hashlib.sha256(raw.encode("utf-8")).hexdigest()
            existing=conn.execute("SELECT * FROM erp_importaciones_presupuesto WHERE id_comunidad=? AND hash_archivo=?",(env.community_id,digest)).fetchone()
            if existing:
                rows=_rows(conn.execute("SELECT * FROM erp_importacion_presupuesto_filas WHERE id_importacion=? ORDER BY CAST(fila AS INTEGER)",(existing["id_importacion"],)))
                return {"action":"Importacion recuperada","entity_type":"erp_importacion_presupuesto","entity_id":existing["id_importacion"],"entity_version":1,
                        "before":None,"after":{"estado":existing["estado"]},"event_type":"erp2.budget.import_previewed","result":{"import":dict(existing),"rows":rows,"duplicate":True}}
            now=utc_now();name=_text(env.payload.get("filename") or "presupuesto-pegado.tsv","nombre de archivo",240,True)
            import_id=conn.execute("""INSERT INTO erp_importaciones_presupuesto
                (id_comunidad,hash_archivo,nombre_archivo,formato,estado,parametros_json,creada_en,creada_por)
                VALUES (?,?,?,'texto_tabular','staging',?, ?,?)""",(env.community_id,digest,name,canonical_json({"separator":"tab/semicolon"}),now,actor.user_id)).lastrowid
            parsed=[]
            for number,line in enumerate(raw.splitlines(),1):
                line=line.strip()
                if not line: continue
                cells=[cell.strip() for cell in (line.split("\t") if "\t" in line else line.split(";"))]
                chapter=cells[0] if len(cells)>0 else ""
                concept=cells[1] if len(cells)>1 else ""
                amount=cells[2] if len(cells)>2 else ""
                incident=None;cents=None;decision="crear"
                try:
                    normalized=amount.replace(".","").replace(",",".") if "," in amount else amount
                    cents=int((Decimal(normalized)*100).quantize(Decimal("1")))
                    if cents<0: raise InvalidOperation()
                except Exception:
                    incident="Importe no valido";decision="pendiente"
                if not chapter or not concept:
                    incident="Faltan capitulo o concepto";decision="pendiente"
                conn.execute("""INSERT INTO erp_importacion_presupuesto_filas
                    (id_comunidad,id_importacion,fila,capitulo_original,concepto_original,importe_original,importe_centimos,decision,incidencia)
                    VALUES (?,?,?,?,?,?,?,?,?)""",(env.community_id,import_id,str(number),chapter,concept,amount,cents,decision,incident))
                parsed.append({"row":number,"chapter":chapter,"concept":concept,"amount":amount,"amount_cents":cents,"decision":decision,"incident":incident})
            if not parsed: raise ContractError("No se encontraron filas importables.")
            return {"action":"Importacion de presupuesto preparada","entity_type":"erp_importacion_presupuesto","entity_id":import_id,"entity_version":1,
                    "before":None,"after":{"estado":"staging","filas":len(parsed)},"event_type":"erp2.budget.import_previewed",
                    "result":{"id_importacion":import_id,"rows":parsed,"can_confirm":all(not row["incident"] for row in parsed)}}
        return self._write(session,envelope,op)

    def budget_import_confirm(self, session, envelope):
        def op(conn, actor, env):
            import_id=_id(env.payload.get("id_importacion"),"importacion")
            source=conn.execute("SELECT * FROM erp_importaciones_presupuesto WHERE id_comunidad=? AND id_importacion=?",(env.community_id,import_id)).fetchone()
            if not source: raise NotFoundError("La importacion no existe.")
            if source["estado"]=="confirmada":
                return {"action":"Importacion ya confirmada","entity_type":"erp_importacion_presupuesto","entity_id":import_id,"entity_version":1,
                        "before":None,"after":{"estado":"confirmada"},"event_type":"erp2.budget.import_confirmed","result":{"id_presupuesto":source["id_presupuesto"],"id_importacion":import_id}}
            bad=conn.execute("SELECT COUNT(*) FROM erp_importacion_presupuesto_filas WHERE id_importacion=? AND (incidencia IS NOT NULL OR decision='pendiente')",(import_id,)).fetchone()[0]
            if bad: raise ConflictError("Resuelve las incidencias de importacion antes de confirmar.")
            exercise_id=_id(env.payload.get("id_ejercicio"),"ejercicio")
            exercise=conn.execute("SELECT * FROM erp_ejercicios WHERE id_comunidad=? AND id_ejercicio=?",(env.community_id,exercise_id)).fetchone()
            if not exercise: raise ContractError("El ejercicio no pertenece a la comunidad.")
            now=utc_now();code=_text(env.payload.get("codigo") or f"IMP-{exercise['codigo']}-{uuid.uuid4().hex[:5].upper()}","codigo",80,True)
            name=_text(env.payload.get("denominacion") or f"Presupuesto {exercise['codigo']}","denominacion",240,True)
            budget_id=conn.execute("""INSERT INTO erp_presupuestos(id_comunidad,id_ejercicio,codigo,denominacion,tipo,moneda,estado,version,creado_en,creado_por,origen)
                VALUES (?,?,?,?, 'ordinario',?,'borrador',1,?,?,?)""",(env.community_id,exercise_id,code,name,exercise["moneda"],now,actor.user_id,env.origin)).lastrowid
            version_id=conn.execute("""INSERT INTO erp_presupuesto_versiones(id_comunidad,id_presupuesto,version,fecha_inicio,fecha_fin,periodicidad,dia_emision_previsto,dia_vencimiento,estado,version_concurrencia,registrada_en,registrada_por,origen)
                VALUES (?,?,1,?,?,?,?,?,'borrador',1,?,?,?)""",(env.community_id,budget_id,exercise["fecha_inicio"],exercise["fecha_fin"],str(env.payload.get("periodicidad") or "mensual"),3,10,now,actor.user_id,env.origin)).lastrowid
            chapters={}
            for row in conn.execute("SELECT * FROM erp_importacion_presupuesto_filas WHERE id_importacion=? AND decision='crear' ORDER BY CAST(fila AS INTEGER)",(import_id,)):
                chapter_name=row["capitulo_original"]
                if chapter_name not in chapters:
                    key=f"IMP-C{len(chapters)+1}"
                    chapters[chapter_name]=conn.execute("INSERT INTO erp_presupuesto_capitulos(id_comunidad,id_presupuesto_version,clave_continuidad,nombre,orden) VALUES (?,?,?,?,?)",(env.community_id,version_id,key,chapter_name,len(chapters))).lastrowid
                item_id=conn.execute("""INSERT INTO erp_presupuesto_partidas(id_comunidad,id_presupuesto_version,id_capitulo,clave_continuidad,concepto,importe_centimos,orden,categoria_origen)
                    VALUES (?,?,?,?,?,?,?,?)""",(env.community_id,version_id,chapters[chapter_name],f"IMP-P{row['fila']}",row["concepto_original"],row["importe_centimos"],int(row["fila"]),chapter_name)).lastrowid
                conn.execute("UPDATE erp_importacion_presupuesto_filas SET id_capitulo_destino=?,id_partida_destino=? WHERE id_fila=?",(chapters[chapter_name],item_id,row["id_fila"]))
            conn.execute("UPDATE erp_importaciones_presupuesto SET estado='confirmada',id_presupuesto=?,confirmada_en=?,confirmada_por=? WHERE id_importacion=?",(budget_id,now,actor.user_id,import_id))
            return {"action":"Importacion de presupuesto confirmada","entity_type":"erp_importacion_presupuesto","entity_id":import_id,"entity_version":1,
                    "before":{"estado":"staging"},"after":{"estado":"confirmada","id_presupuesto":budget_id},"event_type":"erp2.budget.import_confirmed"}
        return self._write(session,envelope,op)

    def occupancy_save(self, session, envelope):
        def op(conn, actor, env):
            p=env.payload;property_id=_id(p.get("id_propiedad"),"propiedad")
            prop=conn.execute("SELECT id_propiedad FROM cf_propiedades WHERE id_comunidad=? AND id_propiedad=?",(env.community_id,property_id)).fetchone()
            if not prop: raise NotFoundError("La propiedad no existe.")
            now=utc_now();start=_iso(p.get("date_start"),"fecha de inicio",False);end=_iso(p.get("date_end"),"fecha final",False)
            current=conn.execute("""SELECT o.id_ocupacion,v.id_ocupacion_version,v.version FROM erp_ocupaciones o JOIN erp_ocupacion_versiones v ON v.id_ocupacion=o.id_ocupacion
                WHERE o.id_comunidad=? AND o.id_propiedad=? AND v.estado='confirmada' ORDER BY v.version DESC LIMIT 1""",(env.community_id,property_id)).fetchone()
            if not p.get("has_tenant"):
                if current:
                    conn.execute("UPDATE erp_ocupacion_versiones SET efectiva_hasta=?,estado='sustituida' WHERE id_ocupacion_version=?",(start or date.today().isoformat(),current["id_ocupacion_version"]))
                return {"action":"Ocupacion finalizada","entity_type":"erp_ocupacion","entity_id":current["id_ocupacion"] if current else property_id,"entity_version":(current["version"]+1 if current else 1),
                        "before":{"activa":bool(current)},"after":{"activa":False},"event_type":"erp2.occupancy.ended"}
            name=_text(p.get("name"),"nombre del inquilino",240,True)
            person_id=conn.execute("""INSERT INTO erp_personas_cobro(id_comunidad,tipo,nombre,identificacion,direccion,idioma,estado,version,creada_en,creada_por,origen)
                VALUES (?,?,?,?,?,?,'activa',1,?,?,?)""",(env.community_id,str(p.get("person_type") or "fisica"),name,_text(p.get("identification"),"identificacion",80),_text(p.get("address"),"direccion",500),_text(p.get("language") or "es","idioma",20),now,actor.user_id,env.origin)).lastrowid
            for kind in ("email","telefono","telefono_alternativo"):
                value=_text(p.get(kind),kind,240)
                if value:
                    conn.execute("""INSERT INTO erp_persona_cobro_contactos(id_comunidad,id_persona_cobro,tipo,valor,valor_normalizado,principal,verificado,efectiva_desde,activo,version,creado_en,creado_por,origen)
                        VALUES (?,?,?,?,?,1,0,?,1,1,?,?,?)""",(env.community_id,person_id,kind,value,value.strip().lower(),start,now,actor.user_id,env.origin))
            if current:
                conn.execute("UPDATE erp_ocupacion_versiones SET efectiva_hasta=?,estado='sustituida' WHERE id_ocupacion_version=?",(start,current["id_ocupacion_version"]))
                occupancy_id=current["id_ocupacion"];version=int(current["version"])+1
            else:
                occupancy_id=conn.execute("INSERT INTO erp_ocupaciones(id_comunidad,id_propiedad,tipo,version,creada_en,creada_por,origen) VALUES (?,?,'arrendamiento',1,?,?,?)",(env.community_id,property_id,now,actor.user_id,env.origin)).lastrowid;version=1
            ov=conn.execute("""INSERT INTO erp_ocupacion_versiones(id_comunidad,id_ocupacion,version,efectiva_desde,efectiva_hasta,registrada_en,registrada_por,estado,origen,id_version_sustituida)
                VALUES (?,?,?,?,?,?,?,'confirmada',?,?)""",(env.community_id,occupancy_id,version,start,end,now,actor.user_id,env.origin,current["id_ocupacion_version"] if current else None)).lastrowid
            conn.execute("INSERT INTO erp_ocupacion_personas(id_comunidad,id_ocupacion_version,id_persona_cobro,papel) VALUES (?,?,?,'inquilino')",(env.community_id,ov,person_id))
            return {"action":"Inquilino guardado","entity_type":"erp_ocupacion","entity_id":occupancy_id,"entity_version":version,
                    "before":{"id_ocupacion_version":current["id_ocupacion_version"] if current else None},"after":{"id_ocupacion_version":ov,"id_persona_cobro":person_id},"event_type":"erp2.occupancy.saved"}
        return self._write(session,envelope,op,"puede_configurar_cobro")

    def billing_propose(self, session, envelope):
        def op(conn, actor, env):
            p=env.payload;property_id=_id(p.get("id_propiedad"),"propiedad");now=utc_now()
            current=conn.execute("SELECT MAX(version) FROM erp_config_recibo_versiones WHERE id_comunidad=? AND id_propiedad=? AND alcance=? AND concepto_clave IS ?",(env.community_id,property_id,str(p.get("scope") or "ordinario"),p.get("concept_key"))).fetchone()[0] or 0
            def choice(prefix):
                kind=str(p.get(prefix+"_type") or "propietario")
                if kind not in {"propietario", "inquilino", "persona"}:
                    raise ContractError(f"El tipo de {prefix} no es valido.")
                value=_id(p.get(prefix+"_id"),prefix)
                return (value,None) if kind=="propietario" else (None,value)
            recipient_owner,recipient_person=choice("recipient");payer_owner,payer_person=choice("payer")
            payment_method=str(p.get("payment_method") or "transferencia")
            if payment_method not in {"transferencia", "domiciliacion_pendiente", "otro"}:
                raise ContractError("El medio de cobro previsto no es valido.")
            config_id=conn.execute("""INSERT INTO erp_config_recibo_versiones
                (id_comunidad,id_propiedad,alcance,concepto_clave,version,efectiva_desde,efectiva_hasta,registrada_en,registrada_por,estado,
                 destinatario_propietario_id,destinatario_persona_cobro_id,pagador_propietario_id,pagador_persona_cobro_id,medio_previsto,referencia_medio,origen)
                VALUES (?,?,?,?,?,?,?,?,?,'borrador',?,?,?,?,?,?,?)""",(env.community_id,property_id,str(p.get("scope") or "ordinario"),p.get("concept_key"),current+1,_iso(p.get("date_start"),"fecha",False),_iso(p.get("date_end"),"fecha",False),now,actor.user_id,
                recipient_owner,recipient_person,payer_owner,payer_person,payment_method,_text(p.get("payment_reference"),"referencia",200),env.origin)).lastrowid
            return {"action":"Configuracion de cobro propuesta","entity_type":"erp_config_recibo","entity_id":config_id,"entity_version":current+1,
                    "before":None,"after":{"id_config_recibo":config_id,"estado":"borrador"},"event_type":"erp2.billing.proposed"}
        return self._write(session,envelope,op,"puede_configurar_cobro")

    def billing_confirm(self, session, envelope):
        def op(conn, actor, env):
            config_id=_id(env.payload.get("id_config_recibo"),"configuracion")
            row=conn.execute("SELECT * FROM erp_config_recibo_versiones WHERE id_comunidad=? AND id_config_recibo=?",(env.community_id,config_id)).fetchone()
            if not row: raise NotFoundError("La configuracion no existe.")
            if row["estado"]!="borrador": raise ConflictError("Solo puede confirmarse una propuesta en borrador.")
            previous=conn.execute("""SELECT id_config_recibo FROM erp_config_recibo_versiones WHERE id_comunidad=? AND id_propiedad=? AND alcance=? AND concepto_clave IS ? AND estado='confirmada'
                ORDER BY version DESC LIMIT 1""",(env.community_id,row["id_propiedad"],row["alcance"],row["concepto_clave"])).fetchone()
            if previous:
                conn.execute("UPDATE erp_config_recibo_versiones SET estado='sustituida',efectiva_hasta=COALESCE(efectiva_hasta,?) WHERE id_config_recibo=?",(row["efectiva_desde"] or date.today().isoformat(),previous[0]))
                conn.execute("UPDATE erp_config_recibo_versiones SET id_version_sustituida=? WHERE id_config_recibo=?",(previous[0],config_id))
            conn.execute("UPDATE erp_config_recibo_versiones SET estado='confirmada' WHERE id_config_recibo=?",(config_id,))
            return {"action":"Configuracion de cobro confirmada","entity_type":"erp_config_recibo","entity_id":config_id,"entity_version":row["version"],
                    "before":{"estado":"borrador"},"after":{"estado":"confirmada"},"event_type":"erp2.billing.confirmed"}
        return self._write(session,envelope,op,"puede_configurar_cobro")

    def billing_preview(self, session, query):
        def op(conn,q):
            property_id=_id(q.filters.get("id_propiedad"),"propiedad")
            effective=_iso(q.filters.get("effective_date") or date.today().isoformat(),"fecha")
            occupation=conn.execute("""SELECT o.id_ocupacion,v.*,p.id_persona_cobro,p.papel,pc.nombre,pc.identificacion,pc.idioma
                FROM erp_ocupaciones o JOIN erp_ocupacion_versiones v ON v.id_ocupacion=o.id_ocupacion
                JOIN erp_ocupacion_personas p ON p.id_ocupacion_version=v.id_ocupacion_version
                LEFT JOIN erp_personas_cobro pc ON pc.id_persona_cobro=p.id_persona_cobro
                WHERE o.id_comunidad=? AND o.id_propiedad=? AND v.estado='confirmada'
                AND (v.efectiva_desde IS NULL OR v.efectiva_desde<=?) AND (v.efectiva_hasta IS NULL OR v.efectiva_hasta>?)
                ORDER BY v.version DESC LIMIT 1""",(q.community_id,property_id,effective,effective)).fetchone()
            return {"ok":True,"query":q.query,"entity":{"effective_date":effective,"billing":self._billing_at(conn,q.community_id,property_id,effective),"tenant":dict(occupation) if occupation else None}}
        return self._read(session,query,op)

    def _assignment_members(self, conn, community_id, assignment, reference_date):
        members=[]
        for member in conn.execute("SELECT * FROM erp_grupo_miembros WHERE id_comunidad=? AND id_grupo=? ORDER BY id_propiedad",(community_id,assignment["id_grupo"])):
            versions=self._active_versions(conn.execute("SELECT * FROM erp_grupo_miembro_versiones WHERE id_comunidad=? AND id_miembro=? ORDER BY version",(community_id,member["id_miembro"])),reference_date)
            if len(versions)>1: raise ContractError("Existen pertenencias temporales incompatibles en el grupo.")
            if not versions or not versions[0]["participa"] or versions[0]["excluida"]: continue
            entry={"property_id":int(member["id_propiedad"]),"participates":True,"member_version_id":int(versions[0]["id_miembro_version"])}
            if assignment["regla_tipo"] in {"coeficiente","porcentaje_especial"}:
                candidates=[]
                for coefficient in conn.execute("""SELECT s.id_serie,s.finalidad,s.unidad,v.* FROM erp_coeficiente_series s
                    JOIN erp_coeficiente_versiones v ON v.id_serie=s.id_serie WHERE s.id_comunidad=? AND s.id_propiedad=?
                    AND s.id_grupo=? AND s.finalidad=? AND s.unidad=? AND s.estado='activa'""",(community_id,member["id_propiedad"],assignment["id_grupo"],assignment["finalidad_serie"],assignment["unidad_serie"])):
                    if (not coefficient["efectiva_desde"] or coefficient["efectiva_desde"]<=reference_date) and (not coefficient["efectiva_hasta"] or coefficient["efectiva_hasta"]>reference_date):
                        candidates.append({"series_id":coefficient["id_serie"],"version_id":coefficient["id_coeficiente_version"],"purpose":coefficient["finalidad"],"unit":coefficient["unidad"],"value":coefficient["valor_decimal"],"quality":coefficient["calidad"],"state":coefficient["estado"]})
                entry["coefficient_candidates"]=candidates
            members.append(entry)
        return members

    def assessment_save(self, session, envelope):
        def op(conn,actor,env):
            p=env.payload;assessment_id=int(p.get("id_derrama") or 0);before=None;now=utc_now()
            if assessment_id:
                before=conn.execute("SELECT * FROM erp_derramas WHERE id_comunidad=? AND id_derrama=?",(env.community_id,assessment_id)).fetchone()
                if not before: raise NotFoundError("La derrama no existe.")
                if before["estado"]!="borrador": raise ConflictError("Una derrama aprobada no puede editarse.")
                if env.expected_version is not None and int(before["version"])!=env.expected_version: raise ConflictError("La derrama ha cambiado; vuelve a cargarla.")
                conn.execute("UPDATE erp_simulaciones SET estado='obsoleta' WHERE id_comunidad=? AND origen_tipo='derrama' AND origen_id=? AND estado='completa'",(env.community_id,str(assessment_id)))
                conn.execute("UPDATE erp_derramas SET concepto=?,importe_centimos=?,version=version+1 WHERE id_derrama=?",(_text(p.get("concept"),"concepto",300,True),_money(p.get("amount_cents")),assessment_id))
                conn.execute("DELETE FROM erp_derrama_calendario WHERE id_derrama=?",(assessment_id,));conn.execute("DELETE FROM erp_derrama_repartos WHERE id_derrama=?",(assessment_id,))
            else:
                assessment_id=conn.execute("""INSERT INTO erp_derramas(id_comunidad,codigo,concepto,importe_centimos,moneda,estado,version,creado_en,creado_por,origen)
                    VALUES (?,?,?,?,?,'borrador',1,?,?,?)""",(env.community_id,_text(p.get("code") or f"D-{uuid.uuid4().hex[:7].upper()}","codigo",80,True),_text(p.get("concept"),"concepto",300,True),_money(p.get("amount_cents")),"EUR",now,actor.user_id,env.origin)).lastrowid
            assignments=p.get("assignments") or []
            for order,a in enumerate(assignments):
                group_id=_id(a.get("group_id"),"grupo")
                group=conn.execute("""SELECT g.id_grupo,v.id_grupo_version,v.base FROM erp_grupos_reparto g JOIN erp_grupo_versiones v ON v.id_grupo=g.id_grupo
                    WHERE g.id_comunidad=? AND g.id_grupo=? AND g.estado='activo' AND v.estado='aprobada' ORDER BY v.version DESC LIMIT 1""",(env.community_id,group_id)).fetchone()
                if not group: raise ContractError("El grupo no tiene version aprobada.")
                rule_type=str(a.get("rule_type") or "coeficiente");purpose=str(a.get("series_purpose") or "general");unit=str(a.get("series_unit") or ("porcentaje" if group["base"]=="porcentaje" else "peso"))
                rule=self._rule(conn,env.community_id,actor.user_id,rule_type,group_id,purpose,unit,a,env.origin)
                mode=str(a.get("mode") or "porcentaje");value=str(_money(a.get("value"),"asignacion")) if mode=="importe" else _decimal(a.get("value"),"porcentaje")
                if mode not in {"importe","porcentaje"}: raise ContractError("El modo de reparto debe ser importe o porcentaje.")
                conn.execute("""INSERT INTO erp_derrama_repartos(id_comunidad,id_derrama,id_grupo,id_grupo_version,finalidad_serie,unidad_serie,id_regla_version,modo,valor_decimal,orden)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""",(env.community_id,assessment_id,group_id,group["id_grupo_version"],purpose,unit,rule,mode,value,order))
            schedules=p.get("schedules") or []
            if not schedules: raise ContractError("La derrama necesita al menos un plazo.")
            for order,period in enumerate(schedules):
                start=_iso(period.get("date_start"),"inicio del plazo");end=_iso(period.get("date_end") or start,"fin del plazo")
                conn.execute("""INSERT INTO erp_derrama_calendario(id_comunidad,id_derrama,clave_plazo,fecha_inicio,fecha_fin,fecha_emision_prevista,fecha_vencimiento,peso_decimal,orden)
                    VALUES (?,?,?,?,?,?,?,?,?)""",(env.community_id,assessment_id,str(period.get("key") or f"P{order+1:02d}"),start,end,_iso(period.get("issue_date"),"emision",False),_iso(period.get("due_date"),"vencimiento",False),_decimal(period.get("weight") or "1","peso"),order))
            after=dict(conn.execute("SELECT * FROM erp_derramas WHERE id_derrama=?",(assessment_id,)).fetchone())
            return {"action":"Derrama guardada","entity_type":"erp_derrama","entity_id":assessment_id,"entity_version":after["version"],"before":dict(before) if before else None,"after":after,"event_type":"erp2.assessment.saved"}
        return self._write(session,envelope,op)

    def _assessment_manifest(self,conn,community_id,assessment_id):
        assessment=conn.execute("SELECT * FROM erp_derramas WHERE id_comunidad=? AND id_derrama=?",(community_id,assessment_id)).fetchone()
        if not assessment: raise NotFoundError("La derrama no existe.")
        periods=[{"key":row["clave_plazo"],"order":row["orden"],"weight":row["peso_decimal"],"date_start":row["fecha_inicio"],"date_end":row["fecha_fin"],"issue_date":row["fecha_emision_prevista"],"due_date":row["fecha_vencimiento"]} for row in conn.execute("SELECT * FROM erp_derrama_calendario WHERE id_derrama=? ORDER BY orden",(assessment_id,))]
        assignments=[]
        reference=periods[0]["date_start"] if periods else date.today().isoformat()
        for row in conn.execute("""SELECT a.*,g.nombre AS grupo_nombre,v.base,v.suma_esperada_decimal,v.estado AS grupo_estado,
            r.tipo AS regla_tipo,rv.parametros_json,rv.estado AS regla_estado FROM erp_derrama_repartos a
            JOIN erp_grupos_reparto g ON g.id_grupo=a.id_grupo JOIN erp_grupo_versiones v ON v.id_grupo_version=a.id_grupo_version
            JOIN erp_regla_versiones rv ON rv.id_regla_version=a.id_regla_version JOIN erp_reglas_reparto r ON r.id_regla=rv.id_regla
            WHERE a.id_derrama=? ORDER BY a.orden""",(assessment_id,)):
            assignments.append({"id":int(row["id_reparto"]),"key":f"D{row['id_reparto']}","mode":row["modo"],"value":row["valor_decimal"],"series_purpose":row["finalidad_serie"],"series_unit":row["unidad_serie"],
                "group":{"id":int(row["id_grupo"]),"version_id":int(row["id_grupo_version"]),"name":row["grupo_nombre"],"base":row["base"],"expected_total":row["suma_esperada_decimal"],"state":row["grupo_estado"]},
                "rule":{"version_id":int(row["id_regla_version"]),"type":row["regla_tipo"],"state":row["regla_estado"],"parameters":json.loads(row["parametros_json"] or "{}")},
                "members":self._assignment_members(conn,community_id,row,reference)})
        return {"contract_version":CONTRACT_VERSION,"community_id":community_id,"budget_version_id":None,"budget_version_number":int(assessment["version"]),"origin_type":"derrama","origin_id":str(assessment_id),
                "reference_date":reference,"known_at":assessment["creado_en"],"currency":assessment["moneda"],"periodicity":"personalizada","periods":periods,
                "items":[{"id":int(assessment_id),"key":assessment["codigo"],"name":assessment["concepto"],"chapter_id":None,"amount_cents":str(assessment["importe_centimos"]),"financing":[],"assignments":assignments}]}

    def assessment_simulate(self,session,envelope):
        actor=Actor.from_session(session);conn=connect(self.database_path,readonly=True)
        try:
            require_budget_permission(conn,session,envelope.community_id,"puede_preparar")
            manifest=self._assessment_manifest(conn,envelope.community_id,_id(envelope.payload.get("id_derrama"),"derrama"))
        finally: conn.close()
        result=persist_simulation(self.database_path,manifest,actor_id=actor.user_id,origin=envelope.origin)
        return {"ok":True,"command":envelope.command,"entity":result,"idempotent_replay":bool(result.get("idempotent_replay"))}

    def assessment_approve(self,session,envelope):
        def op(conn,actor,env):
            assessment_id=_id(env.payload.get("id_derrama"),"derrama");row=conn.execute("SELECT * FROM erp_derramas WHERE id_comunidad=? AND id_derrama=?",(env.community_id,assessment_id)).fetchone()
            if not row or row["estado"]!="borrador": raise ConflictError("La derrama no esta disponible para aprobar.")
            simulation=conn.execute("SELECT * FROM erp_simulaciones WHERE id_comunidad=? AND origen_tipo='derrama' AND origen_id=? AND estado='completa' ORDER BY id_simulacion DESC LIMIT 1",(env.community_id,str(assessment_id))).fetchone()
            current=simulate_budget(self._assessment_manifest(conn,env.community_id,assessment_id))
            if not simulation or current.get("input_hash")!=simulation["hash_entradas"]: raise ConflictError("Vuelve a simular la derrama antes de aprobar.")
            now=utc_now();conn.execute("UPDATE erp_derramas SET estado='aprobada',fecha_aprobacion=?,version=version+1,evidencia_tipo=?,evidencia_id=? WHERE id_derrama=?",(_iso(env.payload.get("date") or date.today().isoformat(),"fecha"),env.evidence.entity_type if env.evidence else None,env.evidence.entity_id if env.evidence else None,assessment_id))
            plan_id=conn.execute("""INSERT INTO erp_planes_cuota(id_comunidad,tipo,origen_tipo,origen_id,moneda,estado,version,creado_en,creado_por,origen)
                VALUES (?,'derrama','derrama',?,?,'aprobado',1,?,?,?)""",(env.community_id,str(assessment_id),row["moneda"],now,actor.user_id,env.origin)).lastrowid
            periods=_rows(conn.execute("SELECT * FROM erp_derrama_calendario WHERE id_derrama=? ORDER BY orden",(assessment_id,)))
            pv=conn.execute("""INSERT INTO erp_plan_versiones(id_comunidad,id_plan,version,id_simulacion,fecha_inicio,fecha_fin,estado,registrada_en,registrada_por,origen)
                VALUES (?,?,1,?,?,?,'aprobada',?,?,?)""",(env.community_id,plan_id,simulation["id_simulacion"],periods[0]["fecha_inicio"],periods[-1]["fecha_fin"],now,actor.user_id,env.origin)).lastrowid
            period_ids={}
            for period in periods:
                exercise=conn.execute("SELECT id_ejercicio FROM erp_ejercicios WHERE id_comunidad=? AND fecha_inicio<=? AND fecha_fin>=? ORDER BY fecha_inicio DESC LIMIT 1",(env.community_id,period["fecha_inicio"],period["fecha_inicio"])).fetchone()
                if not exercise: raise ConflictError(f"No existe ejercicio para el plazo {period['clave_plazo']} de la derrama.")
                period_ids[period["clave_plazo"]]=conn.execute("""INSERT INTO erp_plan_periodos(id_comunidad,id_plan_version,clave_periodo,fecha_inicio,fecha_fin,fecha_emision_prevista,fecha_vencimiento,peso_decimal,id_ejercicio,orden)
                    VALUES (?,?,?,?,?,?,?,?,?,?)""",(env.community_id,pv,period["clave_plazo"],period["fecha_inicio"],period["fecha_fin"],period["fecha_emision_prevista"],period["fecha_vencimiento"],period["peso_decimal"],exercise[0],period["orden"])).lastrowid
            result=load_simulation(self.database_path,env.community_id,simulation["id_simulacion"])
            properties={int(item["property_id"]) for item in result.get("property_totals",[])}
            for period in periods:
                emission=period["fecha_emision_prevista"] or period["fecha_inicio"]
                for property_id in properties:
                    billing=self._billing_at(conn,env.community_id,property_id,emission)
                    conn.execute("""INSERT INTO erp_plan_destinatarios_snapshot
                        (id_comunidad,id_plan_version,id_periodo_plan,id_propiedad,fecha_emision_referencia,conocida_en,id_config_recibo,
                         titulares_json,destinatario_json,pagador_json,estado) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (env.community_id,pv,period_ids[period["clave_plazo"]],property_id,emission,now,
                         billing["config"]["id_config_recibo"] if billing["config"] else None,canonical_json(billing["owners"]),
                         canonical_json(billing["recipient"]) if billing["recipient"] else None,canonical_json(billing["payer"]) if billing["payer"] else None,billing["status"]))
            return {"action":"Derrama aprobada","entity_type":"erp_derrama","entity_id":assessment_id,"entity_version":int(row["version"])+1,"before":{"estado":"borrador"},"after":{"estado":"aprobada","id_plan":plan_id,"id_plan_version":pv,"id_simulacion":simulation["id_simulacion"]},"event_type":"erp2.assessment.approved"}
        return self._write(session,envelope,op,"puede_aprobar")

    def assessment_list(self,session,query):
        return self._read(session,query,lambda conn,q:{"ok":True,"query":q.query,"items":_rows(conn.execute("""SELECT d.*,(SELECT s.id_simulacion FROM erp_simulaciones s WHERE s.id_comunidad=d.id_comunidad AND s.origen_tipo='derrama' AND s.origen_id=CAST(d.id_derrama AS TEXT) ORDER BY s.id_simulacion DESC LIMIT 1) AS id_simulacion
            FROM erp_derramas d WHERE d.id_comunidad=? ORDER BY d.creado_en DESC""",(q.community_id,)))})

    def assessment_get(self,session,query):
        def op(conn,q):
            assessment_id=_id(q.filters.get("id_derrama"),"derrama")
            row=conn.execute("SELECT * FROM erp_derramas WHERE id_comunidad=? AND id_derrama=?",(q.community_id,assessment_id)).fetchone()
            if not row: raise NotFoundError("La derrama no existe.")
            entity=dict(row)
            entity["assignments"]=_rows(conn.execute("""SELECT a.*,g.nombre AS grupo_nombre,r.tipo AS regla_tipo
                FROM erp_derrama_repartos a JOIN erp_grupos_reparto g ON g.id_grupo=a.id_grupo
                JOIN erp_regla_versiones rv ON rv.id_regla_version=a.id_regla_version
                JOIN erp_reglas_reparto r ON r.id_regla=rv.id_regla WHERE a.id_derrama=? ORDER BY a.orden""",(assessment_id,)))
            entity["schedules"]=_rows(conn.execute("SELECT * FROM erp_derrama_calendario WHERE id_derrama=? ORDER BY orden",(assessment_id,)))
            simulation=conn.execute("""SELECT id_simulacion FROM erp_simulaciones WHERE id_comunidad=? AND origen_tipo='derrama'
                AND origen_id=? ORDER BY id_simulacion DESC LIMIT 1""",(q.community_id,str(assessment_id))).fetchone()
            entity["simulation"]=load_simulation(self.database_path,q.community_id,simulation[0]) if simulation else None
            return {"ok":True,"query":q.query,"entity":entity}
        return self._read(session,query,op)

    def regularization_preview(self,session,envelope):
        def op(conn,actor,env):
            p=env.payload;plan_id=_id(p.get("id_plan"),"plan")
            plan=conn.execute("""SELECT p.*,v.id_plan_version,v.id_simulacion FROM erp_planes_cuota p JOIN erp_plan_versiones v ON v.id_plan=p.id_plan
                WHERE p.id_comunidad=? AND p.id_plan=? AND p.estado='aprobado' ORDER BY v.version DESC LIMIT 1""",(env.community_id,plan_id)).fetchone()
            if not plan: raise NotFoundError("El plan aprobado no existe.")
            emitted=p.get("emitted") or []
            if not isinstance(emitted,list): raise ContractError("Los importes emitidos deben enviarse como lista.")
            if any(row.get("confirmed") is not True for row in emitted): raise ConflictError("Confirma la cobertura de los importes emitidos antes de calcular.")
            result=load_simulation(self.database_path,env.community_id,plan["id_simulacion"])
            coverage_start=_iso(p.get("coverage_start"),"inicio",False)
            coverage_end=_iso(p.get("coverage_end"),"fin",False)
            selected_periods={row["clave_periodo"] for row in conn.execute("""SELECT clave_periodo FROM erp_plan_periodos
                WHERE id_plan_version=? AND (? IS NULL OR fecha_fin>=?) AND (? IS NULL OR fecha_inicio<=?)""",
                (plan["id_plan_version"],coverage_start,coverage_start,coverage_end,coverage_end))}
            if not selected_periods: raise ContractError("La cobertura indicada no contiene periodos del plan.")
            expected={}
            for prop in result.get("property_totals",[]):
                for period in prop.get("periods",[]):
                    if period["key"] in selected_periods: expected[(int(prop["property_id"]),period["key"])]=int(period["cents"])
            emitted_map={}
            for row in emitted:
                key=(_id(row.get("property_id"),"propiedad"),str(row.get("period_key") or ""))
                emitted_map[key]=emitted_map.get(key,0)+_money(row.get("net_emitted_cents"),"emitido neto")
            missing=set(expected)-set(emitted_map);unknown=set(emitted_map)-set(expected)
            if missing or unknown:
                raise ConflictError(f"La cobertura de emitidos no esta completa: faltan {len(missing)} lineas y sobran {len(unknown)}.")
            signature=hashlib.sha256(canonical_json({"plan":plan_id,"cutoff":p.get("cutoff_date"),"coverage_start":coverage_start,
                "coverage_end":coverage_end,"emitted":sorted((key[0],key[1],value) for key,value in emitted_map.items())}).encode()).hexdigest()
            existing=conn.execute("SELECT id_regularizacion,estado FROM erp_regularizaciones WHERE id_comunidad=? AND hash_calculo=?",(env.community_id,signature)).fetchone()
            if existing:
                return {"action":"Regularizacion recuperada","entity_type":"erp_regularizacion","entity_id":existing["id_regularizacion"],"entity_version":1,
                        "before":None,"after":{"estado":existing["estado"]},"event_type":"erp2.regularization.replayed",
                        "result":{"id_regularizacion":existing["id_regularizacion"],"duplicate":True,"receipt_emission":False}}
            previous_adjustments={}
            for row in conn.execute("""SELECT l.id_propiedad,l.periodo_clave,SUM(l.diferencia_centimos) AS total
                FROM erp_regularizacion_lineas l JOIN erp_regularizaciones r ON r.id_regularizacion=l.id_regularizacion
                WHERE r.id_comunidad=? AND r.id_plan_esperado=? AND r.estado='aprobada'
                GROUP BY l.id_propiedad,l.periodo_clave""",(env.community_id,plan_id)):
                previous_adjustments[(int(row["id_propiedad"]),row["periodo_clave"])]=int(row["total"] or 0)
            now=utc_now();regularization_id=conn.execute("""INSERT INTO erp_regularizaciones
                (id_comunidad,id_plan_esperado,fecha_corte,conocida_en,cobertura_desde,cobertura_hasta,motivo,estado,version,evidencia_tipo,evidencia_id,creada_en,creada_por,origen,hash_calculo)
                VALUES (?,?,?,?,?,?,?,'calculada',1,?,?,?,?,?,?)""",(env.community_id,plan_id,_iso(p.get("cutoff_date") or date.today().isoformat(),"fecha"),now,coverage_start,coverage_end,_text(p.get("reason"),"motivo",1000,True),env.evidence.entity_type if env.evidence else None,env.evidence.entity_id if env.evidence else None,now,actor.user_id,env.origin,signature)).lastrowid
            lines=[]
            for key in sorted(set(expected)|set(emitted_map)):
                due=expected.get(key,0);issued=emitted_map.get(key,0);adjustments=previous_adjustments.get(key,0);difference=due-issued-adjustments
                line_id=conn.execute("""INSERT INTO erp_regularizacion_lineas
                    (id_comunidad,id_regularizacion,id_propiedad,concepto_clave,periodo_clave,debido_centimos,emitido_neto_centimos,cobrado_centimos,ajustes_previos_centimos,diferencia_centimos,estado_destinatario)
                    VALUES (?,?,?,'cuota_ordinaria',?,?,?,?,?,?,'pendiente')""",(env.community_id,regularization_id,key[0],key[1],due,issued,int(next((r.get("collected_cents",0) for r in emitted if int(r.get("property_id",0))==key[0] and str(r.get("period_key"))==key[1]),0)),adjustments,difference)).lastrowid
                for source in [r for r in emitted if int(r.get("property_id",0))==key[0] and str(r.get("period_key"))==key[1]]:
                    source_type=str(source.get("type") or "").strip().lower()
                    if source_type not in {"cargo", "abono", "ajuste"}:
                        source_type="abono" if _money(source.get("net_emitted_cents"),"emitido") < 0 else "cargo"
                    conn.execute("""INSERT INTO erp_regularizacion_origenes(id_comunidad,id_linea,sistema,tipo,referencia,importe_centimos,snapshot_json)
                        VALUES (?,?,?,?,?,?,?)""",(env.community_id,line_id,str(source.get("system") or "entrada_revisada"),source_type,str(source.get("reference") or f"R-{line_id}"),_money(source.get("net_emitted_cents"),"emitido"),canonical_json(source)))
                lines.append({"property_id":key[0],"period_key":key[1],"due_cents":due,"net_emitted_cents":issued,"previous_adjustments_cents":adjustments,"difference_cents":difference})
            summary={"charge_cents":sum(max(0,row["difference_cents"]) for row in lines),"credit_cents":sum(min(0,row["difference_cents"]) for row in lines),"lines":len(lines),"receipt_emission":False}
            return {"action":"Regularizacion calculada","entity_type":"erp_regularizacion","entity_id":regularization_id,"entity_version":1,"before":None,"after":summary,"event_type":"erp2.regularization.calculated","result":{"id_regularizacion":regularization_id,"summary":summary,"lines":lines}}
        return self._write(session,envelope,op)

    def regularization_approve(self,session,envelope):
        def op(conn,actor,env):
            regularization_id=_id(env.payload.get("id_regularizacion"),"regularizacion")
            row=conn.execute("SELECT * FROM erp_regularizaciones WHERE id_comunidad=? AND id_regularizacion=?",(env.community_id,regularization_id)).fetchone()
            if not row or row["estado"]!="calculada": raise ConflictError("La regularizacion no esta calculada o ya fue procesada.")
            pending=conn.execute("SELECT COUNT(*) FROM erp_regularizacion_lineas WHERE id_regularizacion=? AND estado_destinatario='pendiente'",(regularization_id,)).fetchone()[0]
            if pending and not env.payload.get("confirm_pending_recipients"): raise ConflictError("Confirma que ERP 3 revisara los destinatarios antes de emitir.")
            conn.execute("UPDATE erp_regularizaciones SET estado='aprobada',version=version+1 WHERE id_regularizacion=?",(regularization_id,))
            return {"action":"Regularizacion aprobada","entity_type":"erp_regularizacion","entity_id":regularization_id,"entity_version":int(row["version"])+1,"before":{"estado":"calculada"},"after":{"estado":"aprobada","receipt_emission":False},"event_type":"erp2.regularization.approved"}
        return self._write(session,envelope,op,"puede_aprobar")

    def regularization_list(self,session,query):
        return self._read(session,query,lambda conn,q:{"ok":True,"query":q.query,"items":_rows(conn.execute("""SELECT r.*,
            COALESCE((SELECT SUM(CASE WHEN l.diferencia_centimos>0 THEN l.diferencia_centimos ELSE 0 END) FROM erp_regularizacion_lineas l WHERE l.id_regularizacion=r.id_regularizacion),0) AS cargos_centimos,
            COALESCE((SELECT SUM(CASE WHEN l.diferencia_centimos<0 THEN l.diferencia_centimos ELSE 0 END) FROM erp_regularizacion_lineas l WHERE l.id_regularizacion=r.id_regularizacion),0) AS abonos_centimos
            FROM erp_regularizaciones r WHERE r.id_comunidad=? ORDER BY r.creada_en DESC""",(q.community_id,)))})

    def plan_list(self,session,query):
        return self._read(session,query,lambda conn,q:{"ok":True,"query":q.query,"items":_rows(conn.execute("""SELECT p.*,v.id_plan_version,v.id_simulacion,v.fecha_inicio,v.fecha_fin
            FROM erp_planes_cuota p JOIN erp_plan_versiones v ON v.id_plan=p.id_plan WHERE p.id_comunidad=? ORDER BY p.creado_en DESC""",(q.community_id,)))})
