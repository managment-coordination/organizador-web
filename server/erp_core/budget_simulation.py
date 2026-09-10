"""Atomic persistence and retrieval for ERP 2B calculated snapshots."""

import hashlib
import json

from .budget_contracts import CONTRACT_VERSION, MOTOR_VERSION, ROUNDING_VERSION
from .budget_engine import simulate_budget
from .contracts import canonical_json
from .database import connect, write_transaction
from .migrations import utc_now


def _result_hash(result):
    return result.get("result_hash") or hashlib.sha256(canonical_json(result).encode("utf-8")).hexdigest()


def _snapshot_target(manifest, result):
    if result.get("status") == "completa":
        return int(result["quota_target_cents"])
    total = 0
    for item in manifest.get("items", []) if isinstance(manifest, dict) else []:
        raw = item.get("amount_cents") if isinstance(item, dict) else None
        if isinstance(raw, (str, int)) and str(raw).isdigit():
            total += int(raw)
    return total


def _load_by_id(conn, community_id, simulation_id):
    row = conn.execute("""SELECT s.*,r.resultado_json,r.hash_resultado
        FROM erp_simulaciones s
        JOIN erp_simulacion_resultados r
          ON r.id_comunidad=s.id_comunidad AND r.id_simulacion=s.id_simulacion
        WHERE s.id_comunidad=? AND s.id_simulacion=?""", (community_id, simulation_id)).fetchone()
    if not row:
        return None
    result = json.loads(row["resultado_json"])
    result["simulation_id"] = int(row["id_simulacion"])
    result["stored_result_hash"] = row["hash_resultado"]
    return result


def load_simulation(database_path, community_id, simulation_id):
    conn = connect(database_path, readonly=True)
    try:
        return _load_by_id(conn, int(community_id), int(simulation_id))
    finally:
        conn.close()


def persist_simulation(database_path, manifest, *, actor_id, origin="system", simulate_failure=False):
    """Calculate outside the write lock, then store the complete snapshot atomically."""
    result = simulate_budget(manifest)
    community_id = int(result.get("community_id") or manifest.get("community_id") or 0)
    if community_id <= 0:
        raise ValueError("La simulacion requiere comunidad valida para persistir.")
    input_hash = result.get("input_hash")
    if not input_hash:
        input_hash = hashlib.sha256(canonical_json(manifest).encode("utf-8")).hexdigest()
    result_hash = _result_hash(result)
    now = utc_now()
    conn = connect(database_path)
    try:
        with write_transaction(conn):
            existing = conn.execute("""SELECT id_simulacion FROM erp_simulaciones
                WHERE id_comunidad=? AND hash_entradas=? AND version_motor=?""",
                (community_id, input_hash, MOTOR_VERSION)).fetchone()
            if existing:
                replay = _load_by_id(conn, community_id, int(existing["id_simulacion"]))
                replay["idempotent_replay"] = True
                return replay

            status = "completa" if result.get("status") == "completa" else "fallida"
            simulation_id = conn.execute("""INSERT INTO erp_simulaciones
                (id_comunidad,id_presupuesto_version,origen_tipo,origen_id,hash_entradas,
                 version_motor,version_redondeo,fecha_referencia,conocida_en,moneda,estado,
                 importe_objetivo_centimos,importe_resultado_centimos,creada_en,creada_por,
                 completada_en,origen)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    community_id, manifest.get("budget_version_id"),
                    manifest.get("origin_type", "presupuesto"),
                    str(manifest.get("origin_id") or manifest.get("budget_version_id") or "domain"),
                    input_hash, MOTOR_VERSION, ROUNDING_VERSION,
                    str(manifest.get("reference_date") or "1970-01-01"),
                    str(manifest.get("known_at") or now), str(manifest.get("currency") or "EUR"),
                    status, _snapshot_target(manifest, result),
                    int(result["result_total_cents"]) if status == "completa" else None,
                    now, int(actor_id), now, origin,
                )).lastrowid
            manifest_json = canonical_json(manifest)
            conn.execute("""INSERT INTO erp_simulacion_entradas
                (id_comunidad,id_simulacion,tipo,clave,referencia_id,version_referencia,valor_json,hash_valor)
                VALUES (?,?,?,?,?,?,?,?)""", (
                    community_id, simulation_id, "manifest", "root",
                    str(manifest.get("budget_version_id") or ""), manifest.get("budget_version_number"),
                    manifest_json, hashlib.sha256(manifest_json.encode("utf-8")).hexdigest(),
                ))
            conn.execute("""INSERT INTO erp_simulacion_resultados
                (id_simulacion,id_comunidad,contrato_version,hash_resultado,resultado_json,creado_en)
                VALUES (?,?,?,?,?,?)""", (
                    simulation_id, community_id, CONTRACT_VERSION, result_hash,
                    canonical_json(result), now,
                ))
            for incident in result.get("incidents", []):
                conn.execute("""INSERT INTO erp_calculo_incidencias
                    (id_comunidad,id_simulacion,codigo,severidad,entidad_tipo,entidad_id,campo,mensaje,solucion)
                    VALUES (?,?,?,?,?,?,?,?,?)""", (
                        community_id, simulation_id, incident["code"], incident.get("severity", "error"),
                        incident.get("entity_type"), incident.get("entity_id"), incident.get("field"),
                        incident["message"], incident.get("solution"),
                    ))
            period_ids = {}
            for period in result.get("periods", []):
                period_ids[period["key"]] = conn.execute("""INSERT INTO erp_simulacion_periodos
                    (id_comunidad,id_simulacion,clave_periodo,fecha_inicio,fecha_fin,peso_decimal,orden)
                    VALUES (?,?,?,?,?,?,?)""", (
                        community_id, simulation_id, period["key"], period.get("date_start"),
                        period.get("date_end"), period["weight"], period["order"],
                    )).lastrowid
            for index, line in enumerate(result.get("lines", [])):
                first = line["components"][0]
                line_id = conn.execute("""INSERT INTO erp_calculo_lineas
                    (id_comunidad,id_simulacion,id_propiedad,id_capitulo,id_partida,id_asignacion,
                     id_grupo_version,id_miembro_version,id_serie,id_coeficiente_version,id_regla_version,
                     valor_decimal,denominador_decimal,numerador_exacto,denominador_exacto,
                     importe_base_centimos,ajuste_redondeo_centimos,importe_final_centimos,orden_desempate)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                        community_id, simulation_id, line["property_id"], line.get("chapter_id"),
                        line.get("item_id"), line.get("assignment_id"), line.get("group_version_id"),
                        first.get("member_version_id"), first.get("series_id"),
                        first.get("coefficient_version_id"), line["rule_version_id"],
                        line.get("value_decimal"), line.get("denominator_decimal"),
                        line["exact"]["numerator"], line["exact"]["denominator"],
                        int(line["base_cents"]), int(line["adjustment_cents"]),
                        int(line["final_cents"]), line["tie_key"],
                    )).lastrowid
                for component in line["components"]:
                    conn.execute("""INSERT INTO erp_calculo_componentes
                        (id_comunidad,id_simulacion,id_calculo_linea,id_propiedad,id_partida,id_asignacion,
                         clave_componente,id_regla_version,numerador_exacto,denominador_exacto,
                         importe_base_centimos,ajuste_redondeo_centimos,importe_final_centimos,
                         residuo_numerador,residuo_denominador,criterio_redondeo,orden_desempate)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                            community_id, simulation_id, line_id, line["property_id"], line.get("item_id"),
                            line.get("assignment_id"), component["component_key"], component["rule_version_id"],
                            component["exact"]["numerator"], component["exact"]["denominator"],
                            component["base_cents"], component["adjustment_cents"], component["final_cents"],
                            component["remainder"]["numerator"], component["remainder"]["denominator"],
                            component["rounding_criterion"], str(line["property_id"]),
                        ))
                for period in line["periods"]:
                    conn.execute("""INSERT INTO erp_calculo_periodo_resultados
                        (id_comunidad,id_calculo_linea,id_simulacion_periodo,numerador_exacto,
                         denominador_exacto,importe_base_centimos,ajuste_redondeo_centimos,
                         importe_final_centimos,residuo_numerador,residuo_denominador,criterio_redondeo)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)""", (
                            community_id, line_id, period_ids[period["key"]],
                            period["exact"]["numerator"], period["exact"]["denominator"],
                            int(period["base_cents"]), int(period["adjustment_cents"]),
                            int(period["final_cents"]), period["remainder"]["numerator"],
                            period["remainder"]["denominator"], period["rounding_criterion"],
                        ))
                if simulate_failure and index == 0:
                    raise RuntimeError("Fallo simulado durante el guardado del snapshot.")
            stored = _load_by_id(conn, community_id, simulation_id)
            stored["idempotent_replay"] = False
            return stored
    finally:
        conn.close()
