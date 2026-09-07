import json
import sqlite3
import sys

from access_control import migrate, profile, stamp


def main():
    request = json.load(sys.stdin)
    with sqlite3.connect(sys.argv[1], timeout=30) as conn:
        conn.row_factory = sqlite3.Row
        action = request.get("action")
        if action == "migrate":
            migrate(conn)
            return {"ok": True}
        if action == "profile":
            return {"user": profile(conn, int(request.get("id_usuario") or 0))}
        if action == "access_event":
            user_id = int(request.get("id_usuario") or 0)
            event = request.get("event")
            if event not in {"Acceso correcto web", "Contrasena incorrecta web", "Cerrar sesion web", "Cambiar comunidad web"}:
                raise ValueError("Evento de acceso no valido.")
            with conn:
                if event == "Acceso correcto web":
                    conn.execute("UPDATE usuarios SET ultimo_acceso=?,intentos_fallidos=0 WHERE id_usuario=?", (stamp(), user_id))
                elif event == "Contrasena incorrecta web":
                    conn.execute("UPDATE usuarios SET intentos_fallidos=COALESCE(intentos_fallidos,0)+1 WHERE id_usuario=?", (user_id,))
                conn.execute("""INSERT INTO auditoria (fecha_hora,usuario,pc,accion,entidad,id_entidad,detalle)
                    VALUES (?,?,?,?,?,?,?)""", (stamp(), request.get("nombre") or "web", request.get("pc") or "web",
                    event, "usuario", user_id, str(request.get("detalle") or "")[:500]))
            return {"ok": True}
        raise ValueError("Operacion de acceso no valida.")


try:
    print(json.dumps(main(), ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"error": str(exc), "error_type": type(exc).__name__}, ensure_ascii=False))
    sys.exit(1)
