"""Reviewed Excel onboarding that writes only to ERP 1 master domains."""

from collections import defaultdict
from decimal import Decimal, InvalidOperation
import json
import uuid
import unicodedata

from .errors import ConflictError, ContractError, NotFoundError
from .master_service import MasterDataService, _dict, _rows
from .master_validation import iso_date, normalized, one_of, text
from .migrations import utc_now


OWNER_FIELDS = {
    "codigo_propietario", "nombre", "tipo_persona", "nif", "direccion", "cp",
    "poblacion", "provincia", "idioma", "email", "telefono", "telefono_alternativo",
}
PROPERTY_FIELDS = {
    "codigo_propiedad", "tipo_propiedad", "bloque", "portal", "planta", "puerta",
    "descripcion", "referencia_registral", "referencia_catastral", "codigo_propietario",
    "porcentaje_titularidad", "fecha_efectiva", "nombre_propietario",
}


def owner_name_key(value):
    raw = unicodedata.normalize("NFD", _clean(value))
    return " ".join("".join(c for c in raw if not unicodedata.combining(c)).casefold().split())


def _clean(value):
    return str(value if value is not None else "").strip()


def _decimal(value, label, required=False):
    raw = _clean(value).replace(" ", "").replace(",", ".")
    if not raw:
        if required:
            raise ContractError(f"Falta {label}.")
        return None
    try:
        parsed = Decimal(raw)
    except InvalidOperation as error:
        raise ContractError(f"{label} no es un numero valido.") from error
    if not parsed.is_finite() or parsed < 0:
        raise ContractError(f"{label} debe ser un numero positivo.")
    rendered = format(parsed, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


class OnboardingService(MasterDataService):
    def list(self, session, query):
        def op(conn, q):
            items = _rows(conn.execute("""SELECT id_importacion,tipo,nombre_archivo,hoja,estado,total_filas,
                filas_validas,incidencias,creada_en,confirmada_en,version
                FROM erp_onboarding_importaciones WHERE id_comunidad=? ORDER BY id_importacion DESC LIMIT 30""",
                (q.community_id,)))
            return {"ok": True, "query": q.query, "items": items}
        return self._read(session, query, op)

    def get(self, session, query):
        def op(conn, q):
            import_id = int(q.filters.get("id_importacion") or 0)
            item = self._require_entity(conn, "erp_onboarding_importaciones", "id_importacion", import_id, q.community_id)
            item["filas"] = _rows(conn.execute("""SELECT numero_fila,datos_json,decision,incidencias_json,
                entidad_destino,id_destino FROM erp_onboarding_filas WHERE id_importacion=? ORDER BY numero_fila""",
                (import_id,)))
            for row in item["filas"]:
                row["datos"] = json.loads(row.pop("datos_json"))
                row["incidencias"] = json.loads(row.pop("incidencias_json"))
            item["mapeo"] = json.loads(item["mapeo_json"])
            item["opciones"] = json.loads(item["opciones_json"])
            return {"ok": True, "query": q.query, "entity": item}
        return self._read(session, query, op)

    def preview(self, session, envelope):
        def op(conn, actor, env):
            payload = env.payload
            kind = one_of(payload.get("tipo"), "tipo", {"propietarios", "propiedades"})
            digest = text(payload.get("hash_archivo"), "hash_archivo", required=True, maximum=128)
            filename = text(payload.get("nombre_archivo"), "nombre_archivo", required=True, maximum=300)
            sheet = text(payload.get("hoja"), "hoja", required=True, maximum=200)
            path = text(payload.get("ruta_privada"), "ruta_privada", maximum=1000)
            headers = payload.get("cabeceras")
            mapping = payload.get("mapeo")
            options = payload.get("opciones") or {}
            rows = payload.get("filas")
            if not isinstance(headers, list) or not isinstance(mapping, dict) or not isinstance(rows, list):
                raise ContractError("La importacion no contiene columnas, mapeo y filas validos.")
            if len(rows) > 10000:
                raise ContractError("El asistente admite hasta 10.000 filas por archivo.")
            allowed = OWNER_FIELDS if kind == "propietarios" else PROPERTY_FIELDS
            for key in mapping.values():
                if key and key not in allowed and not str(key).startswith(("coeficiente_grupo:", "miembro_grupo:")):
                    raise ContractError("El mapeo contiene un destino no permitido.")
            prepared = self._prepare_rows(conn, env.community_id, kind, rows, options)
            incidents = sum(1 for row in prepared if row["incidencias"])
            valid = len(prepared) - incidents
            existing = conn.execute("""SELECT * FROM erp_onboarding_importaciones
                WHERE id_comunidad=? AND tipo=? AND hash_archivo=?""", (env.community_id, kind, digest)).fetchone()
            now = utc_now()
            if existing and existing["estado"] == "confirmada":
                result = dict(existing)
                result["reimportacion"] = True
                return self._outcome("Importacion ya confirmada", "onboarding_importacion", existing["id_importacion"],
                    result, result, "erp1.onboarding.replayed")
            if existing:
                import_id = existing["id_importacion"]
                conn.execute("DELETE FROM erp_onboarding_filas WHERE id_importacion=?", (import_id,))
                conn.execute("""UPDATE erp_onboarding_importaciones SET nombre_archivo=?,ruta_privada=?,hoja=?,
                    cabeceras_json=?,mapeo_json=?,opciones_json=?,total_filas=?,filas_validas=?,incidencias=?,
                    creada_en=?,creada_por=?,resumen_json=NULL,version=version+1 WHERE id_importacion=?""",
                    (filename,path,sheet,json.dumps(headers,ensure_ascii=False),json.dumps(mapping,ensure_ascii=False),
                     json.dumps(options,ensure_ascii=False),len(prepared),valid,incidents,now,actor.user_id,import_id))
            else:
                import_id = conn.execute("""INSERT INTO erp_onboarding_importaciones
                    (id_comunidad,tipo,hash_archivo,nombre_archivo,ruta_privada,hoja,cabeceras_json,mapeo_json,
                     opciones_json,estado,total_filas,filas_validas,incidencias,creada_en,creada_por)
                    VALUES(?,?,?,?,?,?,?,?,?,'staging',?,?,?,?,?)""",
                    (env.community_id,kind,digest,filename,path,sheet,json.dumps(headers,ensure_ascii=False),
                     json.dumps(mapping,ensure_ascii=False),json.dumps(options,ensure_ascii=False),len(prepared),
                     valid,incidents,now,actor.user_id)).lastrowid
            for row in prepared:
                conn.execute("""INSERT INTO erp_onboarding_filas
                    (id_comunidad,id_importacion,numero_fila,original_json,datos_json,decision,incidencias_json,
                     entidad_destino,id_destino) VALUES(?,?,?,?,?,?,?,?,?)""",
                    (env.community_id,import_id,row["numero_fila"],json.dumps(row["original"],ensure_ascii=False),
                     json.dumps(row["datos"],ensure_ascii=False),row["decision"],
                     json.dumps(row["incidencias"],ensure_ascii=False),row.get("entidad_destino"),row.get("id_destino")))
            stored = conn.execute("SELECT version FROM erp_onboarding_importaciones WHERE id_importacion=?", (import_id,)).fetchone()
            result = {"id_importacion": import_id, "tipo": kind, "estado": "staging", "total_filas": len(prepared),
                      "filas_validas": valid, "incidencias": incidents, "filas": prepared,
                      "puede_confirmar": bool(prepared) and incidents == 0, "version": stored["version"]}
            return self._outcome("Importacion revisada", "onboarding_importacion", import_id, None, result,
                                 "erp1.onboarding.previewed")
        return self._write(session, envelope, op)

    def confirm(self, session, envelope):
        def op(conn, actor, env):
            import_id = int(env.payload.get("id_importacion") or 0)
            source = self._require_entity(conn, "erp_onboarding_importaciones", "id_importacion", import_id, env.community_id)
            self._expected(env, source)
            if source["estado"] == "confirmada":
                summary = json.loads(source["resumen_json"] or "{}")
                return self._outcome("Importacion ya confirmada", "onboarding_importacion", import_id, source, source,
                                     "erp1.onboarding.replayed") | {"result": summary}
            if source["incidencias"]:
                raise ConflictError("La importacion contiene incidencias. Corrige el Excel o el mapeo antes de confirmar.")
            rows = _rows(conn.execute("SELECT * FROM erp_onboarding_filas WHERE id_importacion=? ORDER BY numero_fila", (import_id,)))
            parsed = [{**row, "datos": json.loads(row["datos_json"])} for row in rows]
            if source["tipo"] == "propietarios":
                summary = self._apply_owners(conn, env.community_id, parsed, actor, import_id)
            else:
                options = json.loads(source["opciones_json"] or "{}")
                reviewed = self._prepare_rows(conn, env.community_id, "propiedades",
                    [json.loads(row["original_json"]) for row in rows], options)
                if any(row["incidencias"] for row in reviewed):
                    raise ConflictError("Los datos han cambiado o tienen incidencias. Repite la vista previa antes de confirmar.")
                for previous, current in zip(parsed, reviewed):
                    old_owner = previous["datos"].get("vinculacion_propietario", {})
                    new_owner = current["datos"]["vinculacion_propietario"]
                    if old_owner and any(old_owner.get(key) != new_owner.get(key) for key in ("id_propietario", "nombre", "version")):
                        raise ConflictError("Un propietario ha cambiado desde la revision. Repite la vista previa.")
                    previous["datos"] = current["datos"]
                summary = self._apply_properties(conn, env.community_id, parsed, options, actor, import_id)
            now = utc_now()
            conn.execute("""UPDATE erp_onboarding_importaciones SET estado='confirmada',confirmada_en=?,
                confirmada_por=?,resumen_json=?,version=version+1 WHERE id_importacion=?""",
                (now,actor.user_id,json.dumps(summary,ensure_ascii=False),import_id))
            after = self._require_entity(conn, "erp_onboarding_importaciones", "id_importacion", import_id, env.community_id)
            summary["id_importacion"] = import_id
            return self._outcome("Importacion confirmada", "onboarding_importacion", import_id, source, after,
                                 "erp1.onboarding.confirmed") | {"result": summary}
        return self._write(session, envelope, op)

    def _prepare_rows(self, conn, community_id, kind, rows, options):
        prepared = []
        seen = set()
        property_owners = defaultdict(set)
        property_percentages = defaultdict(Decimal)
        owners = _rows(conn.execute("SELECT id_propietario,nombre,codigo_netfincas,nif,version FROM cf_propietarios WHERE id_comunidad=? AND activo=1", (community_id,))) if kind == "propiedades" else []
        by_name, by_owner_code = defaultdict(list), defaultdict(list)
        by_id = {str(owner["id_propietario"]): owner for owner in owners}
        for owner in owners:
            by_name[owner_name_key(owner["nombre"])].append(owner)
            if _clean(owner["codigo_netfincas"]):
                by_owner_code[_clean(owner["codigo_netfincas"]).upper()].append(owner)
        choices = options.get("propietarios_por_fila") or {}
        if not isinstance(choices, dict):
            raise ContractError("Las selecciones de propietarios no son validas.")
        for index, original in enumerate(rows, start=2):
            data = {str(k): _clean(v) for k, v in (original or {}).items() if _clean(v)}
            data.pop("vinculacion_propietario", None)
            issues = []
            try:
                if kind == "propietarios":
                    code = data.get("codigo_propietario", "")
                    name = data.get("nombre", "")
                    if not code: issues.append("Falta el codigo de propietario.")
                    if not name: issues.append("Falta el nombre o razon social.")
                    key = normalized(code)
                    if key in seen: issues.append("Codigo de propietario duplicado en el archivo.")
                    seen.add(key)
                    existing = conn.execute("SELECT * FROM cf_propietarios WHERE id_comunidad=? AND upper(trim(codigo_netfincas))=upper(trim(?))", (community_id,code)).fetchone() if code else None
                    if data.get("nif"):
                        conflict = conn.execute("SELECT id_propietario,codigo_netfincas FROM cf_propietarios WHERE id_comunidad=? AND upper(trim(nif))=upper(trim(?))", (community_id,data["nif"])).fetchone()
                        if conflict and (not existing or conflict["id_propietario"] != existing["id_propietario"]):
                            issues.append("La identificacion ya pertenece a otro propietario; no se fusionara automaticamente.")
                    destination, destination_id = "propietario", existing and existing["id_propietario"]
                    decision = "actualizar" if existing else "crear"
                else:
                    code = data.get("codigo_propiedad", "")
                    owner_code = data.get("codigo_propietario", "")
                    owner_name = data.get("nombre_propietario", "")
                    candidates = by_owner_code.get(owner_code.upper(), []) if owner_code else by_name.get(owner_name_key(owner_name), []) if owner_name else []
                    selected = choices.get(str(index))
                    owner = by_id.get(str(selected)) if selected else candidates[0] if len(candidates) == 1 else None
                    method = "seleccion_manual" if selected else "codigo" if owner_code else "nombre_exacto"
                    if selected and not owner:
                        issues.append("El propietario seleccionado no esta activo en esta comunidad.")
                    elif selected and owner_code and owner not in candidates:
                        issues.append("El propietario seleccionado no coincide con el codigo del archivo. Revisa el mapeo.")
                    elif not owner:
                        issues.append("Varios propietarios coinciden; selecciona uno." if len(candidates)>1 else "No se encuentra el propietario; busca y selecciona uno existente.")
                    elif owner_code and owner_name and not selected and owner_name_key(owner_name) != owner_name_key(owner["nombre"]):
                        issues.append("El codigo y el nombre del propietario no coinciden. Revisa la vinculacion.")
                    data["vinculacion_propietario"] = {**(owner or {}), "metodo":method,
                        "candidatos":candidates if not owner else []}
                    if not code: issues.append("Falta el codigo de propiedad.")
                    if not owner_code and not owner_name: issues.append("Falta el nombre o codigo de propietario relacionado.")
                    pair = (normalized(code), str(owner["id_propietario"]) if owner else owner_code or owner_name_key(owner_name))
                    if pair in seen: issues.append("Propiedad y propietario duplicados en el archivo.")
                    seen.add(pair)
                    existing = conn.execute("SELECT * FROM cf_propiedades WHERE id_comunidad=? AND codigo_normalizado=?", (community_id,normalized(code))).fetchone() if code else None
                    type_value = data.get("tipo_propiedad") or options.get("tipo_propiedad_predeterminado") or "vivienda"
                    property_type = conn.execute("SELECT * FROM erp_tipos_propiedad WHERE id_comunidad=? AND (upper(codigo)=upper(?) OR upper(nombre)=upper(?))", (community_id,type_value,type_value)).fetchone()
                    if not property_type: issues.append("El tipo de propiedad no existe en esta comunidad.")
                    data["tipo_id"] = str(property_type["id_tipo_propiedad"]) if property_type else ""
                    pct = _decimal(data.get("porcentaje_titularidad") or "100", "porcentaje de titularidad", required=True)
                    data["porcentaje_titularidad"] = pct
                    if code and owner:
                        property_owners[normalized(code)].add(str(owner["id_propietario"]))
                        property_percentages[normalized(code)] += Decimal(pct)
                    for key, value in list(data.items()):
                        if key.startswith("coeficiente_grupo:"):
                            group_id = int(key.split(":",1)[1] or 0)
                            group = conn.execute("SELECT * FROM erp_grupos_reparto WHERE id_comunidad=? AND id_grupo=?", (community_id,group_id)).fetchone()
                            if not group: issues.append("El grupo de reparto seleccionado no existe en esta comunidad.")
                            data[key] = _decimal(value, "coeficiente o peso", required=True)
                        elif key.startswith("miembro_grupo:"):
                            group_id = int(key.split(":",1)[1] or 0)
                            if not conn.execute("SELECT 1 FROM erp_grupos_reparto WHERE id_comunidad=? AND id_grupo=?", (community_id,group_id)).fetchone():
                                issues.append("El grupo de reparto seleccionado no existe en esta comunidad.")
                    if existing and owner:
                        current = conn.execute("SELECT id_propietario FROM cf_propietario_propiedad WHERE id_comunidad=? AND id_propiedad=? AND activo=1", (community_id,existing["id_propiedad"])).fetchall()
                        current_ids = {row[0] for row in current}
                        if current_ids and owner["id_propietario"] not in current_ids:
                            issues.append("La propiedad tiene otro propietario actual; el cambio debe revisarse desde su ficha.")
                    destination, destination_id = "propiedad", existing and existing["id_propiedad"]
                    decision = "actualizar" if existing else "crear"
                if data.get("fecha_efectiva"):
                    data["fecha_efectiva"] = iso_date(data["fecha_efectiva"], "fecha_efectiva", required=True)
            except (ContractError, ValueError) as error:
                issues.append(str(error))
                destination, destination_id, decision = kind[:-1], None, "pendiente"
            prepared.append({"numero_fila": index, "original": original, "datos": data,
                             "decision": "pendiente" if issues else decision, "incidencias": issues,
                             "entidad_destino": destination, "id_destino": destination_id})
        if kind == "propiedades":
            for row in prepared:
                code = normalized(row["datos"].get("codigo_propiedad"))
                if code and property_percentages[code] != Decimal("100"):
                    row["incidencias"].append(f"La titularidad importada de la propiedad suma {property_percentages[code]} %, no 100 %.")
                    row["decision"] = "pendiente"
            staged_groups = defaultdict(dict)
            for row in prepared:
                code = normalized(row["datos"].get("codigo_propiedad"))
                for key, value in row["datos"].items():
                    if key.startswith("coeficiente_grupo:") and code:
                        group_id = int(key.split(":", 1)[1])
                        previous = staged_groups[group_id].get(code)
                        if previous is not None and previous != value:
                            row["incidencias"].append("La propiedad repite valores distintos para el mismo grupo.")
                            row["decision"] = "pendiente"
                        staged_groups[group_id][code] = value
            effective = options.get("fecha_efectiva")
            for group_id, staged in staged_groups.items():
                config = self._group_current_version(conn, group_id, effective)
                if not config or config["base"] != "porcentaje" or config.get("suma_esperada_decimal") is None:
                    continue
                current = {normalized(item["codigo_propiedad"]): item["valor_decimal"] for item in
                           self._group_members(conn, community_id, group_id, effective)
                           if item["participa"] and not item["excluida"] and item.get("valor_decimal") is not None}
                current.update(staged)
                total = sum((Decimal(value) for value in current.values()), Decimal("0"))
                expected = Decimal(config["suma_esperada_decimal"])
                if total != expected:
                    message = f"La suma final del grupo es {total} %, debe ser {expected} %."
                    for row in prepared:
                        if f"coeficiente_grupo:{group_id}" in row["datos"]:
                            row["incidencias"].append(message)
                            row["decision"] = "pendiente"
        return prepared

    @staticmethod
    def _upsert_contact(conn, community_id, owner_id, kind, value, actor_id, now):
        if not value:
            return
        current = conn.execute("""SELECT * FROM cf_contactos_propietario WHERE id_comunidad=? AND id_propietario=?
            AND tipo=? AND activo=1 ORDER BY principal DESC,id_contacto LIMIT 1""", (community_id,owner_id,kind)).fetchone()
        if current and normalized(current["valor"]).lower() == normalized(value).lower():
            return
        conn.execute("UPDATE cf_contactos_propietario SET principal=0 WHERE id_comunidad=? AND id_propietario=? AND tipo=?", (community_id,owner_id,kind))
        if current:
            conn.execute("""UPDATE cf_contactos_propietario SET valor=?,valor_normalizado=?,principal=1,verificado=0,
                activo=1,procedencia='onboarding_excel',fecha_ultima_actualizacion=?,version=version+1 WHERE id_contacto=?""",
                (value,normalized(value).lower(),now,current["id_contacto"]))
        else:
            conn.execute("""INSERT INTO cf_contactos_propietario
                (id_propietario,tipo,valor,valor_normalizado,principal,verificado,activo,fecha_creacion,
                 fecha_ultima_actualizacion,id_comunidad,procedencia)
                VALUES(?,?,?,?,1,0,1,?,?,?,?)""",
                (owner_id,kind,value,normalized(value).lower(),now,now,community_id,"onboarding_excel"))

    def _apply_owners(self, conn, community_id, rows, actor, import_id):
        now = utc_now(); created = updated = 0
        for row in rows:
            data = row["datos"]; code = data["codigo_propietario"]
            current = conn.execute("SELECT * FROM cf_propietarios WHERE id_comunidad=? AND upper(trim(codigo_netfincas))=upper(trim(?))", (community_id,code)).fetchone()
            ptype = data.get("tipo_persona") or ("juridica" if data.get("nombre","").upper().endswith((" S.L."," S.A."," SL"," SA")) else "desconocida")
            ptype = ptype.lower()
            if ptype not in {"fisica","juridica","desconocida"}: ptype = "desconocida"
            values = (data["nombre"],normalized(data["nombre"]),ptype,data.get("nif"),data.get("direccion"),data.get("cp"),data.get("poblacion"),data.get("provincia"),data.get("idioma"),now)
            if current:
                conn.execute("""UPDATE cf_propietarios SET nombre=?,nombre_normalizado=?,tipo_persona=?,
                    nif=COALESCE(NULLIF(?,''),nif),direccion=COALESCE(NULLIF(?,''),direccion),cp=COALESCE(NULLIF(?,''),cp),
                    poblacion=COALESCE(NULLIF(?,''),poblacion),provincia=COALESCE(NULLIF(?,''),provincia),
                    idioma_preferido=COALESCE(NULLIF(?,''),idioma_preferido),estado='activo',calidad_identidad='validada',
                    activo=1,origen_dato='onboarding_excel',fecha_ultima_actualizacion=?,version=version+1 WHERE id_propietario=?""",
                    (*values,current["id_propietario"])); owner_id=current["id_propietario"]; updated += 1
            else:
                owner_id=conn.execute("""INSERT INTO cf_propietarios
                    (codigo_netfincas,nombre,nombre_normalizado,tipo_persona,nif,direccion,cp,poblacion,provincia,
                     idioma_preferido,estado,calidad_identidad,activo,id_comunidad,origen_dato,fecha_creacion,fecha_ultima_actualizacion)
                    VALUES(?,?,?,?,?,?,?,?,?,?,'activo','validada',1,?,'onboarding_excel',?,?)""",
                    (code,*values[:-1],community_id,now,now)).lastrowid; created += 1
            for kind in ("email","telefono","telefono_alternativo"):
                self._upsert_contact(conn,community_id,owner_id,kind,data.get(kind),actor.user_id,now)
            conn.execute("UPDATE erp_onboarding_filas SET entidad_destino='propietario',id_destino=?,aplicada_en=? WHERE id_fila=?", (owner_id,now,row["id_fila"]))
        return {"tipo":"propietarios","creados":created,"actualizados":updated,"total":len(rows)}

    def _apply_properties(self, conn, community_id, rows, options, actor, import_id):
        now=utc_now(); created=updated=0; linked=0; coefficients=0
        effective=iso_date(options.get("fecha_efectiva"),"fecha_efectiva") or now[:10]
        by_code=defaultdict(list)
        for row in rows: by_code[normalized(row["datos"]["codigo_propiedad"])].append(row)
        for _, grouped in by_code.items():
            first=grouped[0]["datos"]; code=first["codigo_propiedad"]
            current=conn.execute("SELECT * FROM cf_propiedades WHERE id_comunidad=? AND codigo_normalizado=?",(community_id,normalized(code))).fetchone()
            values=(int(first["tipo_id"]),first.get("bloque"),first.get("portal"),first.get("planta"),first.get("puerta"),first.get("descripcion"),first.get("referencia_registral"),first.get("referencia_catastral"),now)
            if current:
                conn.execute("""UPDATE cf_propiedades SET id_tipo_propiedad=?,bloque=COALESCE(NULLIF(?,''),bloque),
                    portal=COALESCE(NULLIF(?,''),portal),planta=COALESCE(NULLIF(?,''),planta),puerta=COALESCE(NULLIF(?,''),puerta),
                    descripcion_direccion=COALESCE(NULLIF(?,''),descripcion_direccion),referencia_registral=COALESCE(NULLIF(?,''),referencia_registral),
                    referencia_catastral=COALESCE(NULLIF(?,''),referencia_catastral),estado='activa',calidad_dato='validada',activa=1,
                    origen_dato='onboarding_excel',fecha_ultima_actualizacion=?,version=version+1 WHERE id_propiedad=?""",(*values,current["id_propiedad"]));
                property_id=current["id_propiedad"];updated+=1
            else:
                property_id=conn.execute("""INSERT INTO cf_propiedades
                    (codigo_propiedad,codigo_normalizado,id_tipo_propiedad,id_comunidad,bloque,portal,planta,puerta,
                     descripcion_direccion,referencia_registral,referencia_catastral,estado,calidad_dato,origen_dato,activa,
                     fecha_creacion,fecha_ultima_actualizacion) VALUES(?,?,?,?,?,?,?,?,?,?,?,'activa','validada','onboarding_excel',1,?,?)""",
                    (code,normalized(code),values[0],community_id,*values[1:-1],now,now)).lastrowid;created+=1
            owners=[]
            for row in grouped:
                data=row["datos"]
                owner=self._require_entity(conn,"cf_propietarios","id_propietario",data["vinculacion_propietario"]["id_propietario"],community_id)
                owners.append((owner,data["porcentaje_titularidad"],data.get("fecha_efectiva") or effective))
            active=_rows(conn.execute("SELECT * FROM cf_propietario_propiedad WHERE id_comunidad=? AND id_propiedad=? AND activo=1",(community_id,property_id)))
            if not active:
                operation=str(uuid.uuid4())
                for owner,pct,start in owners:
                    relation_id=conn.execute("""INSERT INTO cf_propietario_propiedad
                        (id_propietario,id_propiedad,fecha_desde,activo,porcentaje_titularidad_decimal,motivo,id_comunidad,
                         calidad,procedencia,fecha_conocimiento,version) VALUES(?,?,?,1,?,'Configuracion inicial por Excel',?,'validada','onboarding_excel',?,1)""",
                        (owner["id_propietario"],property_id,start,pct,community_id,now)).lastrowid
                    conn.execute("""INSERT INTO erp_titularidad_versiones
                        (id_comunidad,id_relacion,id_propiedad,id_propietario,porcentaje_decimal,porcentaje_original,
                         efectiva_desde,calidad,composicion_completa,motivo,registrada_en,registrada_por,origen,
                         evidencia_tipo,evidencia_id,id_operacion,version_concurrencia)
                        VALUES(?,?,?,?,?,?,?,'validada',1,'Configuracion inicial por Excel',?,?,
                         'onboarding_excel','onboarding_importacion',?,?,1)""",
                        (community_id,relation_id,property_id,owner["id_propietario"],pct,pct,start,now,actor.user_id,str(import_id),operation))
                    linked+=1
            coefficient_values={}
            for row in grouped:
                for key,value in row["datos"].items():
                    if key.startswith(("coeficiente_grupo:","miembro_grupo:")):
                        if key in coefficient_values and coefficient_values[key]!=value:
                            raise ConflictError("Una propiedad contiene valores distintos para el mismo grupo.")
                        coefficient_values[key]=value
            for key,value in coefficient_values.items():
                group_id=int(key.split(":",1)[1]); self._upsert_group_value(conn,community_id,group_id,property_id,value if key.startswith("coeficiente_") else None,effective,actor,now); coefficients+=1
            for row in grouped:
                conn.execute("UPDATE erp_onboarding_filas SET entidad_destino='propiedad',id_destino=?,aplicada_en=? WHERE id_fila=?",(property_id,now,row["id_fila"]))
        return {"tipo":"propiedades","creadas":created,"actualizadas":updated,"titularidades_creadas":linked,
                "participaciones_configuradas":coefficients,"total_filas":len(rows)}

    def _upsert_group_value(self,conn,community_id,group_id,property_id,value,effective,actor,now):
        group=self._require_entity(conn,"erp_grupos_reparto","id_grupo",group_id,community_id)
        config=self._group_current_version(conn,group_id,effective)
        if not config: raise ConflictError("El grupo no tiene configuracion vigente.")
        base=config["base"]
        if base in {"porcentaje","peso"} and value is None: raise ContractError("El grupo requiere coeficiente o peso.")
        member=conn.execute("SELECT * FROM erp_grupo_miembros WHERE id_comunidad=? AND id_grupo=? AND id_propiedad=?",(community_id,group_id,property_id)).fetchone()
        if member: mid=member["id_miembro"]
        else: mid=conn.execute("INSERT INTO erp_grupo_miembros(id_comunidad,id_grupo,id_propiedad,creado_en,creado_por,origen) VALUES(?,?,?,?,?,'onboarding_excel')",(community_id,group_id,property_id,now,actor.user_id)).lastrowid
        latest=conn.execute("SELECT * FROM erp_grupo_miembro_versiones WHERE id_miembro=? ORDER BY version DESC LIMIT 1",(mid,)).fetchone()
        if not latest or not latest["participa"] or latest["excluida"]:
            version=(latest["version"]+1) if latest else 1
            conn.execute("""INSERT INTO erp_grupo_miembro_versiones
                (id_comunidad,id_miembro,version,efectiva_desde,participa,excluida,motivo,registrada_en,registrada_por,origen)
                VALUES(?,?,?,?,1,0,'Configuracion inicial por Excel',?,?,'onboarding_excel')""",(community_id,mid,version,effective,now,actor.user_id))
        if base in {"porcentaje","peso"}:
            unit=base
            series=conn.execute("SELECT * FROM erp_coeficiente_series WHERE id_comunidad=? AND id_grupo=? AND id_propiedad=? AND estado='activa'",(community_id,group_id,property_id)).fetchone()
            if not series:
                sid=conn.execute("""INSERT INTO erp_coeficiente_series
                    (id_comunidad,id_propiedad,id_grupo,finalidad,unidad,escala,estado,creada_en,creada_por,origen)
                    VALUES(?,?,?,'participacion',?,12,'activa',?,?,'onboarding_excel')""",(community_id,property_id,group_id,unit,now,actor.user_id)).lastrowid
            else: sid=series["id_serie"]
            current=self._coefficient_version(conn,sid,effective)
            if not current or current["valor_decimal"]!=value:
                version=conn.execute("SELECT COALESCE(MAX(version),0)+1 FROM erp_coeficiente_versiones WHERE id_serie=?",(sid,)).fetchone()[0]
                if current: conn.execute("UPDATE erp_coeficiente_versiones SET efectiva_hasta=?,estado='sustituida' WHERE id_coeficiente_version=?",(effective,current["id_coeficiente_version"]))
                conn.execute("""INSERT INTO erp_coeficiente_versiones
                    (id_comunidad,id_serie,version,efectiva_desde,valor_decimal,valor_original,precision_original,
                     calidad,estado,registrada_en,registrada_por,origen)
                    VALUES(?,?,?,?,?,?,?,'validada','aprobada',?,?,'onboarding_excel')""",
                    (community_id,sid,version,effective,value,value,len(value.partition('.')[2]),now,actor.user_id))
        conn.execute("UPDATE erp_grupos_reparto SET version=version+1 WHERE id_grupo=?",(group_id,))
