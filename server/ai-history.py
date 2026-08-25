import json
import sqlite3
import sys
from datetime import datetime


def ensure_schema(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ia_consultas (
            id_consulta INTEGER PRIMARY KEY AUTOINCREMENT,
            id_usuario INTEGER NOT NULL,
            usuario TEXT NOT NULL,
            pregunta TEXT NOT NULL,
            respuesta_json TEXT NOT NULL,
            fuente TEXT,
            confianza REAL,
            comunidades_json TEXT,
            fecha_creacion TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ia_consultas_usuario_fecha
        ON ia_consultas (id_usuario, fecha_creacion DESC, id_consulta DESC)
        """
    )


def main():
    if len(sys.argv) < 3:
        raise ValueError("Faltan parametros para gestionar el historial IA.")

    database_path = sys.argv[1]
    request = json.loads(sys.argv[2])
    session = request.get("session") or {}
    action = str(request.get("action") or "")
    data = request.get("data") or {}
    user_id = int(session.get("id_usuario") or 0)
    user_name = str(session.get("nombre") or "").strip()

    if not user_id or not user_name:
        raise PermissionError("No autenticado.")

    conn = sqlite3.connect(database_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)

        if action == "list":
            limit = min(max(int(data.get("limit") or 40), 1), 100)
            rows = conn.execute(
                """
                SELECT id_consulta, pregunta, respuesta_json, fuente, confianza, fecha_creacion
                FROM ia_consultas
                WHERE id_usuario = ?
                ORDER BY fecha_creacion DESC, id_consulta DESC
                LIMIT ?
                """,
                (user_id, limit),
            ).fetchall()
            history = []
            for row in rows:
                try:
                    answer = json.loads(row["respuesta_json"] or "{}")
                except json.JSONDecodeError:
                    answer = {"action": "consulta", "answer": row["respuesta_json"] or ""}
                history.append(
                    {
                        "id_consulta": row["id_consulta"],
                        "pregunta": row["pregunta"],
                        "respuesta": answer,
                        "fuente": row["fuente"] or "",
                        "confianza": row["confianza"],
                        "fecha_creacion": row["fecha_creacion"],
                    }
                )
            print(json.dumps({"history": history}, ensure_ascii=False))
            return

        if action == "save":
            question = str(data.get("pregunta") or "").strip()
            answer = data.get("respuesta") or {}
            if not question:
                raise ValueError("La consulta esta vacia.")
            now = datetime.now().isoformat(timespec="seconds")
            cursor = conn.execute(
                """
                INSERT INTO ia_consultas
                    (id_usuario, usuario, pregunta, respuesta_json, fuente, confianza, comunidades_json, fecha_creacion)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    user_name,
                    question,
                    json.dumps(answer, ensure_ascii=False),
                    str(answer.get("source") or ""),
                    float(answer.get("confidence") or 0),
                    json.dumps(session.get("comunidades") or [], ensure_ascii=False),
                    now,
                ),
            )
            conn.execute(
                """
                DELETE FROM ia_consultas
                WHERE id_usuario = ?
                  AND id_consulta NOT IN (
                      SELECT id_consulta
                      FROM ia_consultas
                      WHERE id_usuario = ?
                      ORDER BY fecha_creacion DESC, id_consulta DESC
                      LIMIT 500
                  )
                """,
                (user_id, user_id),
            )
            conn.commit()
            print(json.dumps({"ok": True, "id_consulta": cursor.lastrowid, "fecha_creacion": now}, ensure_ascii=False))
            return

        if action == "delete":
            history_id = int(data.get("id_consulta") or 0)
            if not history_id:
                raise ValueError("Consulta no valida.")
            cursor = conn.execute(
                "DELETE FROM ia_consultas WHERE id_consulta = ? AND id_usuario = ?",
                (history_id, user_id),
            )
            conn.commit()
            print(json.dumps({"ok": True, "deleted": cursor.rowcount}, ensure_ascii=False))
            return

        if action == "clear":
            cursor = conn.execute("DELETE FROM ia_consultas WHERE id_usuario = ?", (user_id,))
            conn.commit()
            print(json.dumps({"ok": True, "deleted": cursor.rowcount}, ensure_ascii=False))
            return

        raise ValueError("Accion de historial IA no valida.")
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc), "error_type": type(exc).__name__}, ensure_ascii=False))
        raise
