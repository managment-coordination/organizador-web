"""Deterministic ERP 1 master-data services."""

from datetime import date
from decimal import Decimal
import hashlib
import json
import uuid

from access_control import require_permission

from .audit import write_event
from .contracts import Actor, canonical_json
from .database import connect, write_transaction
from .errors import ConflictError, ContractError, NotFoundError
from .migrations import utc_now
from .outbox import enqueue
from .repository import CommandRepository, FoundationRepository
from .master_validation import (
    boolean, decimal_text, integer, iso_date, iso_datetime, normalized, one_of,
    only, text, valid_interval,
)


def _dict(row):
    return dict(row) if row else None


def _rows(cursor):
    return [dict(row) for row in cursor]


class MasterDataService:
    def __init__(self, database_path):
        self.database_path = database_path

    def _read(self, session, query, operation):
        Actor.from_session(session)
        require_permission(session, query.community_id, "puede_ver")
        conn = connect(self.database_path, readonly=True)
        try:
            FoundationRepository(conn).require_active_community(query.community_id)
            return operation(conn, query)
        finally:
            conn.close()

    def _write(self, session, envelope, operation):
        actor = Actor.from_session(session)
        require_permission(session, envelope.community_id, "puede_actualizar")
        if not envelope.idempotency_key:
            raise ContractError("Los comandos ERP 1 requieren idempotency_key.")
        conn = connect(self.database_path)
        try:
            with write_transaction(conn):
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
                    metadata={"contract": "erp_master_data_v1"},
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
    def _require_entity(conn, table, id_field, entity_id, community_id):
        row = conn.execute(
            f'SELECT * FROM "{table}" WHERE "{id_field}"=? AND id_comunidad=?',
            (entity_id, community_id),
        ).fetchone()
        if not row:
            raise NotFoundError("El elemento no existe en la comunidad seleccionada.")
        return dict(row)

    @staticmethod
    def _expected(envelope, current):
        actual = int(current.get("version") or 0)
        if envelope.expected_version is None:
            raise ContractError("La actualizacion requiere expected_version.")
        if envelope.expected_version != actual:
            raise ConflictError(f"Conflicto de version: esperada {envelope.expected_version}, actual {actual}.")

    def community_get(self, session, query):
        def op(conn, q):
            row = self._require_entity(conn, "comunidades", "id_comunidad", q.community_id, q.community_id)
            row["ejercicios"] = _rows(conn.execute(
                "SELECT * FROM erp_ejercicios WHERE id_comunidad=? ORDER BY fecha_inicio DESC", (q.community_id,)))
            row["tipos_propiedad"] = _rows(conn.execute(
                "SELECT * FROM erp_tipos_propiedad WHERE id_comunidad=? ORDER BY nombre", (q.community_id,)))
            row["agrupaciones"] = _rows(conn.execute(
                "SELECT * FROM erp_agrupaciones WHERE id_comunidad=? ORDER BY tipo,nombre", (q.community_id,)))
            return {"ok": True, "query": q.query, "entity": row}
        return self._read(session, query, op)

    def community_update(self, session, envelope):
        if str(session.get("rol")) != "Superusuario":
            raise PermissionError("Solo el Superusuario puede editar datos maestros de la comunidad.")
        def op(conn, actor, env):
            allowed = {"codigo", "denominacion", "nif", "domicilio", "contacto_administrativo",
                       "zona_horaria", "moneda", "estado_operativo"}
            only(env.payload, allowed)
            before = self._require_entity(conn, "comunidades", "id_comunidad", env.community_id, env.community_id)
            self._expected(env, before)
            values = {
                "codigo": text(env.payload.get("codigo", before["codigo"]), "codigo", required=True, maximum=60),
                "denominacion": text(env.payload.get("denominacion", before["denominacion"]), "denominacion", required=True, maximum=240),
                "nif": text(env.payload.get("nif", before["nif"]), "nif", maximum=40),
                "domicilio": text(env.payload.get("domicilio", before["domicilio"]), "domicilio", maximum=500),
                "contacto_administrativo": text(env.payload.get("contacto_administrativo", before["contacto_administrativo"]), "contacto_administrativo", maximum=500),
                "zona_horaria": text(env.payload.get("zona_horaria", before["zona_horaria"]), "zona_horaria", required=True, maximum=80),
                "moneda": text(env.payload.get("moneda", before["moneda"]), "moneda", required=True, maximum=3).upper(),
                "estado_operativo": one_of(env.payload.get("estado_operativo", before["estado_operativo"]), "estado_operativo", {"preparacion","activa","suspendida","baja"}),
            }
            conn.execute("""UPDATE comunidades SET codigo=?,denominacion=?,nif=?,domicilio=?,
                contacto_administrativo=?,zona_horaria=?,moneda=?,estado_operativo=?,version=version+1
                WHERE id_comunidad=?""", (*values.values(), env.community_id))
            after = self._require_entity(conn, "comunidades", "id_comunidad", env.community_id, env.community_id)
            return self._outcome("Comunidad actualizada", "comunidad", env.community_id, before, after,
                                 "erp1.community.updated")
        return self._write(session, envelope, op)

    def exercise_list(self, session, query):
        return self._read(session, query, lambda conn, q: {
            "ok": True, "query": q.query,
            "items": _rows(conn.execute("SELECT * FROM erp_ejercicios WHERE id_comunidad=? ORDER BY fecha_inicio DESC", (q.community_id,))),
            "locks": _rows(conn.execute("SELECT * FROM erp_bloqueos_periodo WHERE id_comunidad=? ORDER BY fecha_inicio DESC", (q.community_id,))),
        })

    def exercise_save(self, session, envelope):
        def op(conn, actor, env):
            only(env.payload, {"id_ejercicio","codigo","fecha_inicio","fecha_fin","moneda","estado","motivo"})
            entity_id = integer(env.payload.get("id_ejercicio"), "id_ejercicio")
            before = self._require_entity(conn, "erp_ejercicios", "id_ejercicio", entity_id, env.community_id) if entity_id else None
            if before: self._expected(env, before)
            start = iso_date(env.payload.get("fecha_inicio", before and before["fecha_inicio"]), "fecha_inicio", required=True)
            end = iso_date(env.payload.get("fecha_fin", before and before["fecha_fin"]), "fecha_fin", required=True)
            if end < start: raise ContractError("El ejercicio no puede finalizar antes de comenzar.")
            state = one_of(env.payload.get("estado", before and before["estado"] or "preparacion"), "estado", {"preparacion","abierto","cerrado"})
            if state != "preparacion":
                conflict = conn.execute("""SELECT id_ejercicio FROM erp_ejercicios WHERE id_comunidad=?
                    AND estado IN ('abierto','cerrado') AND id_ejercicio<>COALESCE(?,0)
                    AND NOT(fecha_fin<? OR fecha_inicio>?) LIMIT 1""", (env.community_id, entity_id, start, end)).fetchone()
                if conflict: raise ConflictError("El ejercicio se solapa con otro ejercicio validado de la comunidad.")
            values = (text(env.payload.get("codigo", before and before["codigo"]), "codigo", required=True, maximum=60),
                      start, end, text(env.payload.get("moneda", before and before["moneda"] or "EUR"), "moneda", required=True, maximum=3).upper(),
                      state, text(env.payload.get("motivo", before and before["motivo"]), "motivo", maximum=1000))
            now = utc_now()
            if before:
                conn.execute("""UPDATE erp_ejercicios SET codigo=?,fecha_inicio=?,fecha_fin=?,moneda=?,estado=?,motivo=?,
                    fecha_apertura=CASE WHEN ?='abierto' AND fecha_apertura IS NULL THEN ? ELSE fecha_apertura END,
                    abierto_por=CASE WHEN ?='abierto' AND abierto_por IS NULL THEN ? ELSE abierto_por END,
                    fecha_cierre=CASE WHEN ?='cerrado' THEN ? ELSE fecha_cierre END,
                    cerrado_por=CASE WHEN ?='cerrado' THEN ? ELSE cerrado_por END,version=version+1 WHERE id_ejercicio=?""",
                    (*values, state, now, state, actor.user_id, state, now, state, actor.user_id, entity_id))
            else:
                cur = conn.execute("""INSERT INTO erp_ejercicios(id_comunidad,codigo,fecha_inicio,fecha_fin,moneda,estado,
                    fecha_apertura,abierto_por,fecha_cierre,cerrado_por,motivo,creado_en,creado_por,origen)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (env.community_id,*values[:5],
                    now if state=='abierto' else None, actor.user_id if state=='abierto' else None,
                    now if state=='cerrado' else None, actor.user_id if state=='cerrado' else None,
                    values[5],now,actor.user_id,env.origin))
                entity_id = cur.lastrowid
            after = self._require_entity(conn, "erp_ejercicios", "id_ejercicio", entity_id, env.community_id)
            return self._outcome("Ejercicio guardado", "erp_ejercicio", entity_id, before, after, "erp1.exercise.saved")
        return self._write(session, envelope, op)

    def exercise_lock(self, session, envelope):
        def op(conn, actor, env):
            only(env.payload, {"id_ejercicio","dominio","fecha_inicio","fecha_fin","motivo","activo"})
            exercise_id = integer(env.payload.get("id_ejercicio"), "id_ejercicio")
            if exercise_id: self._require_entity(conn,"erp_ejercicios","id_ejercicio",exercise_id,env.community_id)
            start=iso_date(env.payload.get("fecha_inicio"),"fecha_inicio",required=True)
            end=iso_date(env.payload.get("fecha_fin"),"fecha_fin",required=True)
            if end < start: raise ContractError("El bloqueo no puede finalizar antes de comenzar.")
            cur=conn.execute("""INSERT INTO erp_bloqueos_periodo(id_comunidad,id_ejercicio,dominio,fecha_inicio,
                fecha_fin,motivo,activo,creado_en,creado_por) VALUES(?,?,?,?,?,?,?,?,?)""",
                (env.community_id,exercise_id,text(env.payload.get("dominio"),"dominio",required=True,maximum=80),start,end,
                 text(env.payload.get("motivo"),"motivo",required=True,maximum=1000),int(boolean(env.payload.get("activo"),"activo",default=True)),utc_now(),actor.user_id))
            after=self._require_entity(conn,"erp_bloqueos_periodo","id_bloqueo",cur.lastrowid,env.community_id)
            return self._outcome("Periodo bloqueado", "erp_bloqueo_periodo", cur.lastrowid, None, after, "erp1.period.locked")
        return self._write(session,envelope,op)

    def property_list(self, session, query):
        def op(conn, q):
            only(q.filters, {"search","estado","tipo","limit","offset","fecha"})
            search = normalized(q.filters.get("search"))
            limit = min(integer(q.filters.get("limit",100),"limit",minimum=1),1000)
            offset = integer(q.filters.get("offset",0),"offset",minimum=0)
            clauses=["p.id_comunidad=?"]; values=[q.community_id]
            if q.filters.get("estado"): clauses.append("p.estado=?"); values.append(str(q.filters["estado"]))
            if q.filters.get("tipo"): clauses.append("t.codigo=?"); values.append(str(q.filters["tipo"]))
            if search:
                clauses.append("(p.codigo_normalizado LIKE ? OR upper(p.codigo_propiedad) LIKE ? OR EXISTS(SELECT 1 FROM erp_propiedad_aliases a WHERE a.id_propiedad=p.id_propiedad AND a.alias_normalizado LIKE ?))")
                pattern="%"+search.replace(" ","%")+"%"; values += [pattern,pattern,pattern]
            sql="""SELECT p.*,t.codigo AS tipo_codigo,t.nombre AS tipo_nombre,
                (SELECT group_concat(o.nombre, ' / ') FROM cf_propietario_propiedad r
                 JOIN cf_propietarios o ON o.id_propietario=r.id_propietario
                 WHERE r.id_propiedad=p.id_propiedad AND r.activo=1) AS titulares_actuales
                FROM cf_propiedades p LEFT JOIN erp_tipos_propiedad t ON t.id_tipo_propiedad=p.id_tipo_propiedad
                WHERE """+" AND ".join(clauses)+" ORDER BY p.codigo_normalizado LIMIT ? OFFSET ?"
            values += [limit,offset]
            items=_rows(conn.execute(sql,values))
            total=conn.execute("SELECT COUNT(*) FROM cf_propiedades p LEFT JOIN erp_tipos_propiedad t ON t.id_tipo_propiedad=p.id_tipo_propiedad WHERE "+" AND ".join(clauses),values[:-2]).fetchone()[0]
            return {"ok":True,"query":q.query,"items":items,"total":total,"limit":limit,"offset":offset}
        return self._read(session,query,op)

    def property_get(self, session, query):
        def op(conn,q):
            only(q.filters,{"id_propiedad","fecha","conocido_en"})
            entity_id=integer(q.filters.get("id_propiedad"),"id_propiedad",required=True)
            row=self._require_entity(conn,"cf_propiedades","id_propiedad",entity_id,q.community_id)
            row["aliases"]=_rows(conn.execute("SELECT * FROM erp_propiedad_aliases WHERE id_comunidad=? AND id_propiedad=? ORDER BY activo DESC,alias",(q.community_id,entity_id)))
            row["relaciones"]=_rows(conn.execute("""SELECT r.*,p.codigo_propiedad AS propiedad_destino FROM erp_propiedad_relaciones r
                JOIN cf_propiedades p ON p.id_propiedad=r.id_propiedad_destino WHERE r.id_comunidad=? AND r.id_propiedad_origen=? ORDER BY r.creada_en DESC""",(q.community_id,entity_id)))
            row["agrupaciones"]=_rows(conn.execute("""SELECT pa.*,a.codigo,a.nombre,a.tipo FROM erp_propiedad_agrupaciones pa
                JOIN erp_agrupaciones a ON a.id_agrupacion=pa.id_agrupacion WHERE pa.id_comunidad=? AND pa.id_propiedad=? ORDER BY a.tipo,a.nombre""",(q.community_id,entity_id)))
            row["titularidades"]=self._ownership_snapshot(conn,q.community_id,entity_id,q.filters.get("fecha"),q.filters.get("conocido_en"))
            row["coeficientes"]=_rows(conn.execute("""SELECT s.*,g.codigo AS grupo_codigo,g.nombre AS grupo_nombre,
                v.valor_decimal,v.valor_original,v.efectiva_desde,v.efectiva_hasta,v.calidad,v.estado AS version_estado
                FROM erp_coeficiente_series s LEFT JOIN erp_grupos_reparto g ON g.id_grupo=s.id_grupo
                LEFT JOIN erp_coeficiente_versiones v ON v.id_serie=s.id_serie
                WHERE s.id_comunidad=? AND s.id_propiedad=? ORDER BY g.nombre,s.finalidad,v.version DESC""",(q.community_id,entity_id)))
            return {"ok":True,"query":q.query,"entity":row}
        return self._read(session,query,op)

    def property_save(self, session, envelope):
        def op(conn,actor,env):
            allowed={"id_propiedad","codigo_propiedad","tipo_id","bloque","portal","planta","puerta","descripcion_direccion","referencia_registral","referencia_catastral","estado","fecha_baja","motivo_baja","calidad_dato"}
            only(env.payload,allowed)
            entity_id=integer(env.payload.get("id_propiedad"),"id_propiedad")
            before=self._require_entity(conn,"cf_propiedades","id_propiedad",entity_id,env.community_id) if entity_id else None
            if before:self._expected(env,before)
            code=text(env.payload.get("codigo_propiedad",before and before["codigo_propiedad"]),"codigo_propiedad",required=True,maximum=120)
            type_id=integer(env.payload.get("tipo_id",before and before["id_tipo_propiedad"]),"tipo_id",required=True)
            self._require_entity(conn,"erp_tipos_propiedad","id_tipo_propiedad",type_id,env.community_id)
            fields=["bloque","portal","planta","puerta","descripcion_direccion","referencia_registral","referencia_catastral","motivo_baja"]
            vals={f:text(env.payload.get(f,before and before[f]),f,maximum=500) for f in fields}
            status=one_of(env.payload.get("estado",before and before["estado"] or "activa"),"estado",{"preparacion","activa","inactiva","baja"})
            quality=one_of(env.payload.get("calidad_dato",before and before["calidad_dato"] or "observada"),"calidad_dato",{"observada","pendiente_revision","validada"})
            date_off=iso_date(env.payload.get("fecha_baja",before and before["fecha_baja"]),"fecha_baja")
            norm=normalized(code)
            now=utc_now()
            if before:
                conn.execute("""UPDATE cf_propiedades SET codigo_propiedad=?,codigo_normalizado=?,id_tipo_propiedad=?,bloque=?,portal=?,planta=?,puerta=?,descripcion_direccion=?,referencia_registral=?,referencia_catastral=?,estado=?,fecha_baja=?,motivo_baja=?,calidad_dato=?,activa=?,fecha_ultima_actualizacion=?,version=version+1 WHERE id_propiedad=?""",
                    (code,norm,type_id,vals['bloque'],vals['portal'],vals['planta'],vals['puerta'],vals['descripcion_direccion'],vals['referencia_registral'],vals['referencia_catastral'],status,date_off,vals['motivo_baja'],quality,int(status=='activa'),now,entity_id))
            else:
                cur=conn.execute("""INSERT INTO cf_propiedades(codigo_propiedad,codigo_normalizado,id_tipo_propiedad,id_comunidad,bloque,portal,planta,puerta,descripcion_direccion,referencia_registral,referencia_catastral,estado,fecha_baja,motivo_baja,calidad_dato,origen_dato,activa,fecha_creacion,fecha_ultima_actualizacion) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (code,norm,type_id,env.community_id,vals['bloque'],vals['portal'],vals['planta'],vals['puerta'],vals['descripcion_direccion'],vals['referencia_registral'],vals['referencia_catastral'],status,date_off,vals['motivo_baja'],quality,env.origin,int(status=='activa'),now,now)); entity_id=cur.lastrowid
            after=self._require_entity(conn,"cf_propiedades","id_propiedad",entity_id,env.community_id)
            return self._outcome("Propiedad guardada","propiedad",entity_id,before,after,"erp1.property.saved")
        return self._write(session,envelope,op)

    def owner_list(self, session, query):
        def op(conn,q):
            only(q.filters,{"search","estado","limit","offset","fecha"})
            search=normalized(q.filters.get("search")); limit=min(integer(q.filters.get("limit",100),"limit",minimum=1),1000); offset=integer(q.filters.get("offset",0),"offset",minimum=0)
            clauses=["o.id_comunidad=?"]; values=[q.community_id]
            if q.filters.get("estado"):clauses.append("o.estado=?");values.append(str(q.filters["estado"]))
            if search:
                pattern="%"+search.replace(" ","%")+"%"; clauses.append("(o.nombre_normalizado LIKE ? OR upper(coalesce(o.nif,'')) LIKE ? OR EXISTS(SELECT 1 FROM cf_contactos_propietario c WHERE c.id_propietario=o.id_propietario AND c.valor_normalizado LIKE ?))"); values += [pattern,pattern,pattern.lower()]
            sql="""SELECT o.*,(SELECT group_concat(p.codigo_propiedad, ', ') FROM cf_propietario_propiedad r
                JOIN cf_propiedades p ON p.id_propiedad=r.id_propiedad WHERE r.id_propietario=o.id_propietario AND r.activo=1) AS propiedades_actuales
                FROM cf_propietarios o WHERE """+" AND ".join(clauses)+" ORDER BY o.nombre_normalizado LIMIT ? OFFSET ?"
            items=_rows(conn.execute(sql,[*values,limit,offset])); total=conn.execute("SELECT COUNT(*) FROM cf_propietarios o WHERE "+" AND ".join(clauses),values).fetchone()[0]
            return {"ok":True,"query":q.query,"items":items,"total":total,"limit":limit,"offset":offset}
        return self._read(session,query,op)

    def owner_get(self, session, query):
        def op(conn,q):
            only(q.filters,{"id_propietario"})
            entity_id=integer(q.filters.get("id_propietario"),"id_propietario",required=True)
            row=self._require_entity(conn,"cf_propietarios","id_propietario",entity_id,q.community_id)
            row["contactos"]=_rows(conn.execute("SELECT * FROM cf_contactos_propietario WHERE id_comunidad=? AND id_propietario=? ORDER BY tipo,principal DESC",(q.community_id,entity_id)))
            row["propiedades"]=_rows(conn.execute("""SELECT r.*,p.codigo_propiedad,p.estado AS propiedad_estado FROM cf_propietario_propiedad r
                JOIN cf_propiedades p ON p.id_propiedad=r.id_propiedad WHERE r.id_comunidad=? AND r.id_propietario=? ORDER BY r.activo DESC,r.fecha_desde DESC""",(q.community_id,entity_id)))
            return {"ok":True,"query":q.query,"entity":row}
        return self._read(session,query,op)

    def owner_save(self, session, envelope):
        def op(conn,actor,env):
            allowed={"id_propietario","codigo_netfincas","nombre","tipo_persona","nombres","apellidos","razon_social","nif","tipo_identificacion","pais_emisor","direccion","cp","poblacion","provincia","idioma_preferido","estado","calidad_identidad"}
            only(env.payload,allowed); entity_id=integer(env.payload.get("id_propietario"),"id_propietario")
            before=self._require_entity(conn,"cf_propietarios","id_propietario",entity_id,env.community_id) if entity_id else None
            if before:self._expected(env,before)
            name=text(env.payload.get("nombre",before and before['nombre']),"nombre",required=True,maximum=300)
            ptype=one_of(env.payload.get("tipo_persona",before and before['tipo_persona'] or 'desconocida'),"tipo_persona",{'fisica','juridica','desconocida'})
            state=one_of(env.payload.get("estado",before and before['estado'] or 'activo'),"estado",{'preparacion','activo','inactivo','baja'})
            quality=one_of(env.payload.get("calidad_identidad",before and before['calidad_identidad'] or 'observada'),"calidad_identidad",{'observada','pendiente_desglosar','pendiente_revision','validada'})
            fields=['codigo_netfincas','nombres','apellidos','razon_social','nif','tipo_identificacion','pais_emisor','direccion','cp','poblacion','provincia','idioma_preferido']
            vals={f:text(env.payload.get(f,before and before[f]),f,maximum=500) for f in fields}; now=utc_now()
            if before:
                conn.execute("""UPDATE cf_propietarios SET codigo_netfincas=?,nombre=?,nombre_normalizado=?,tipo_persona=?,nombres=?,apellidos=?,razon_social=?,nif=?,tipo_identificacion=?,pais_emisor=?,direccion=?,cp=?,poblacion=?,provincia=?,idioma_preferido=?,estado=?,calidad_identidad=?,activo=?,fecha_ultima_actualizacion=?,version=version+1 WHERE id_propietario=?""",
                    (vals['codigo_netfincas'],name,normalized(name),ptype,vals['nombres'],vals['apellidos'],vals['razon_social'],vals['nif'],vals['tipo_identificacion'],vals['pais_emisor'],vals['direccion'],vals['cp'],vals['poblacion'],vals['provincia'],vals['idioma_preferido'],state,quality,int(state=='activo'),now,entity_id))
            else:
                cur=conn.execute("""INSERT INTO cf_propietarios(codigo_netfincas,nombre,nombre_normalizado,tipo_persona,nombres,apellidos,razon_social,nif,tipo_identificacion,pais_emisor,direccion,cp,poblacion,provincia,idioma_preferido,estado,calidad_identidad,activo,id_comunidad,origen_dato,fecha_creacion,fecha_ultima_actualizacion) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (vals['codigo_netfincas'],name,normalized(name),ptype,vals['nombres'],vals['apellidos'],vals['razon_social'],vals['nif'],vals['tipo_identificacion'],vals['pais_emisor'],vals['direccion'],vals['cp'],vals['poblacion'],vals['provincia'],vals['idioma_preferido'],state,quality,int(state=='activo'),env.community_id,env.origin,now,now)); entity_id=cur.lastrowid
            after=self._require_entity(conn,"cf_propietarios","id_propietario",entity_id,env.community_id)
            return self._outcome("Propietario guardado","propietario",entity_id,before,after,"erp1.owner.saved")
        return self._write(session,envelope,op)

    def contact_save(self, session, envelope):
        def op(conn,actor,env):
            allowed={'id_contacto','id_propietario','tipo','valor','principal','verificado','uso_preferido','efectiva_desde','efectiva_hasta','activo'}; only(env.payload,allowed)
            cid=integer(env.payload.get('id_contacto'),'id_contacto'); before=self._require_entity(conn,'cf_contactos_propietario','id_contacto',cid,env.community_id) if cid else None
            if before:self._expected(env,before)
            oid=integer(env.payload.get('id_propietario',before and before['id_propietario']),'id_propietario',required=True); self._require_entity(conn,'cf_propietarios','id_propietario',oid,env.community_id)
            kind=text(env.payload.get('tipo',before and before['tipo']),'tipo',required=True,maximum=50); value=text(env.payload.get('valor',before and before['valor']),'valor',required=True,maximum=500)
            start=iso_date(env.payload.get('efectiva_desde',before and before['efectiva_desde']),'efectiva_desde'); end=iso_date(env.payload.get('efectiva_hasta',before and before['efectiva_hasta']),'efectiva_hasta'); valid_interval(start,end)
            principal=boolean(env.payload.get('principal',before and before['principal']),'principal'); verified=boolean(env.payload.get('verificado',before and before['verificado']),'verificado'); active=boolean(env.payload.get('activo',before and before['activo'] if before else True),'activo')
            if principal: conn.execute("UPDATE cf_contactos_propietario SET principal=0 WHERE id_comunidad=? AND id_propietario=? AND tipo=?",(env.community_id,oid,kind))
            vals=(oid,kind,value,normalized(value).lower(),int(principal),int(verified),text(env.payload.get('uso_preferido',before and before['uso_preferido']),'uso_preferido',maximum=100),start,end,int(active),utc_now())
            if before: conn.execute("""UPDATE cf_contactos_propietario SET id_propietario=?,tipo=?,valor=?,valor_normalizado=?,principal=?,verificado=?,uso_preferido=?,efectiva_desde=?,efectiva_hasta=?,activo=?,fecha_ultima_actualizacion=?,version=version+1 WHERE id_contacto=?""",(*vals,cid))
            else:
                cur=conn.execute("""INSERT INTO cf_contactos_propietario(id_propietario,tipo,valor,valor_normalizado,principal,verificado,uso_preferido,efectiva_desde,efectiva_hasta,activo,fecha_ultima_actualizacion,id_comunidad,procedencia,fecha_creacion) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",(*vals,env.community_id,env.origin,vals[-1])); cid=cur.lastrowid
            after=self._require_entity(conn,'cf_contactos_propietario','id_contacto',cid,env.community_id)
            return self._outcome('Contacto guardado','propietario_contacto',cid,before,after,'erp1.owner.contact.saved')
        return self._write(session,envelope,op)

    def aggregation_save(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{'id_agrupacion','id_padre','codigo','nombre','tipo','estado','efectiva_desde','efectiva_hasta'})
            aid=integer(env.payload.get('id_agrupacion'),'id_agrupacion')
            before=self._require_entity(conn,'erp_agrupaciones','id_agrupacion',aid,env.community_id) if aid else None
            if before:self._expected(env,before)
            parent=integer(env.payload.get('id_padre',before and before['id_padre']),'id_padre')
            if parent:
                self._require_entity(conn,'erp_agrupaciones','id_agrupacion',parent,env.community_id)
                if aid:
                    cycle=conn.execute("""WITH RECURSIVE descendants(id) AS (
                        SELECT id_agrupacion FROM erp_agrupaciones WHERE id_padre=? AND id_comunidad=?
                        UNION ALL SELECT a.id_agrupacion FROM erp_agrupaciones a JOIN descendants d ON a.id_padre=d.id
                        WHERE a.id_comunidad=?) SELECT 1 FROM descendants WHERE id=?""",(aid,env.community_id,env.community_id,parent)).fetchone()
                    if parent==aid or cycle:raise ConflictError('La jerarquia de agrupaciones no puede contener ciclos.')
            start=iso_date(env.payload.get('efectiva_desde',before and before['efectiva_desde']),'efectiva_desde'); end=iso_date(env.payload.get('efectiva_hasta',before and before['efectiva_hasta']),'efectiva_hasta'); valid_interval(start,end)
            values=(parent,text(env.payload.get('codigo',before and before['codigo']),'codigo',required=True,maximum=60),text(env.payload.get('nombre',before and before['nombre']),'nombre',required=True,maximum=240),text(env.payload.get('tipo',before and before['tipo']),'tipo',required=True,maximum=80),one_of(env.payload.get('estado',before and before['estado'] or 'activa'),'estado',{'preparacion','activa','inactiva'}),start,end)
            if before:conn.execute('UPDATE erp_agrupaciones SET id_padre=?,codigo=?,nombre=?,tipo=?,estado=?,efectiva_desde=?,efectiva_hasta=?,version=version+1 WHERE id_agrupacion=?',(*values,aid))
            else:
                cur=conn.execute('INSERT INTO erp_agrupaciones(id_comunidad,id_padre,codigo,nombre,tipo,estado,efectiva_desde,efectiva_hasta,creada_en,creada_por,origen) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(env.community_id,*values,utc_now(),actor.user_id,env.origin));aid=cur.lastrowid
            after=self._require_entity(conn,'erp_agrupaciones','id_agrupacion',aid,env.community_id)
            return self._outcome('Agrupacion guardada','agrupacion',aid,before,after,'erp1.aggregation.saved')
        return self._write(session,envelope,op)

    def property_alias_save(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{'id_propiedad','alias','tipo','efectiva_desde','efectiva_hasta','activo'})
            pid=integer(env.payload.get('id_propiedad'),'id_propiedad',required=True);self._require_entity(conn,'cf_propiedades','id_propiedad',pid,env.community_id)
            alias=text(env.payload.get('alias'),'alias',required=True,maximum=240);start=iso_date(env.payload.get('efectiva_desde'),'efectiva_desde');end=iso_date(env.payload.get('efectiva_hasta'),'efectiva_hasta');valid_interval(start,end)
            cur=conn.execute('INSERT INTO erp_propiedad_aliases(id_comunidad,id_propiedad,alias,alias_normalizado,tipo,efectiva_desde,efectiva_hasta,activo,origen,creado_en,creado_por) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id_comunidad,id_propiedad,alias_normalizado) DO UPDATE SET alias=excluded.alias,tipo=excluded.tipo,efectiva_desde=excluded.efectiva_desde,efectiva_hasta=excluded.efectiva_hasta,activo=excluded.activo',(env.community_id,pid,alias,normalized(alias),text(env.payload.get('tipo'),'tipo',maximum=80) or 'busqueda',start,end,int(boolean(env.payload.get('activo'),'activo',default=True)),env.origin,utc_now(),actor.user_id))
            row=conn.execute('SELECT * FROM erp_propiedad_aliases WHERE id_comunidad=? AND id_propiedad=? AND alias_normalizado=?',(env.community_id,pid,normalized(alias))).fetchone();after=dict(row)
            return self._outcome('Alias de propiedad guardado','propiedad_alias',after['id_alias'],None,after,'erp1.property.alias.saved')
        return self._write(session,envelope,op)

    def property_relation_save(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{'id_propiedad_origen','id_propiedad_destino','tipo','efectiva_desde','efectiva_hasta','estado','motivo'})
            source=integer(env.payload.get('id_propiedad_origen'),'id_propiedad_origen',required=True);target=integer(env.payload.get('id_propiedad_destino'),'id_propiedad_destino',required=True)
            self._require_entity(conn,'cf_propiedades','id_propiedad',source,env.community_id);self._require_entity(conn,'cf_propiedades','id_propiedad',target,env.community_id)
            if source==target:raise ContractError('Una propiedad no puede relacionarse consigo misma.')
            kind=one_of(env.payload.get('tipo'),'tipo',{'anexo','segregacion','agrupacion','otra'});start=iso_date(env.payload.get('efectiva_desde'),'efectiva_desde');end=iso_date(env.payload.get('efectiva_hasta'),'efectiva_hasta');valid_interval(start,end)
            if kind in {'anexo','agrupacion'}:
                cycle=conn.execute("""WITH RECURSIVE linked(id) AS (
                    SELECT id_propiedad_destino FROM erp_propiedad_relaciones WHERE id_comunidad=? AND id_propiedad_origen=? AND tipo IN ('anexo','agrupacion') AND estado='activa'
                    UNION ALL SELECT r.id_propiedad_destino FROM erp_propiedad_relaciones r JOIN linked l ON r.id_propiedad_origen=l.id WHERE r.id_comunidad=? AND r.tipo IN ('anexo','agrupacion') AND r.estado='activa') SELECT 1 FROM linked WHERE id=?""",(env.community_id,target,env.community_id,source)).fetchone()
                if cycle:raise ConflictError('La relacion entre propiedades crearia un ciclo.')
            cur=conn.execute("""INSERT INTO erp_propiedad_relaciones(id_comunidad,id_propiedad_origen,id_propiedad_destino,tipo,efectiva_desde,efectiva_hasta,estado,motivo,evidencia_tipo,evidencia_id,creada_en,creada_por,origen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",(env.community_id,source,target,kind,start,end,one_of(env.payload.get('estado'),'estado',{'propuesta','activa','inactiva'},default='activa'),text(env.payload.get('motivo'),'motivo',maximum=1000),env.evidence.entity_type if env.evidence else None,env.evidence.entity_id if env.evidence else None,utc_now(),actor.user_id,env.origin));rid=cur.lastrowid
            after=self._require_entity(conn,'erp_propiedad_relaciones','id_relacion_propiedad',rid,env.community_id)
            return self._outcome('Relacion entre propiedades guardada','propiedad_relacion',rid,None,after,'erp1.property.relation.saved')
        return self._write(session,envelope,op)

    def property_aggregation_save(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{'id_propiedad','id_agrupacion','rol','efectiva_desde','efectiva_hasta'})
            pid=integer(env.payload.get('id_propiedad'),'id_propiedad',required=True);aid=integer(env.payload.get('id_agrupacion'),'id_agrupacion',required=True)
            self._require_entity(conn,'cf_propiedades','id_propiedad',pid,env.community_id);self._require_entity(conn,'erp_agrupaciones','id_agrupacion',aid,env.community_id)
            start=iso_date(env.payload.get('efectiva_desde'),'efectiva_desde');end=iso_date(env.payload.get('efectiva_hasta'),'efectiva_hasta');valid_interval(start,end)
            cur=conn.execute('INSERT INTO erp_propiedad_agrupaciones(id_comunidad,id_propiedad,id_agrupacion,rol,efectiva_desde,efectiva_hasta,version,origen,creada_en,creada_por) VALUES(?,?,?,?,?,?,1,?,?,?)',(env.community_id,pid,aid,text(env.payload.get('rol'),'rol',maximum=80) or 'estructural',start,end,env.origin,utc_now(),actor.user_id));link_id=cur.lastrowid
            after=self._require_entity(conn,'erp_propiedad_agrupaciones','id_pertenencia',link_id,env.community_id)
            return self._outcome('Propiedad clasificada en agrupacion','propiedad_agrupacion',link_id,None,after,'erp1.property.aggregation.saved')
        return self._write(session,envelope,op)

    def ownership_list(self, session, query):
        def op(conn,q):
            only(q.filters,{"id_propiedad","fecha","conocido_en"}); pid=integer(q.filters.get("id_propiedad"),"id_propiedad",required=True)
            self._require_entity(conn,"cf_propiedades","id_propiedad",pid,q.community_id)
            return {"ok":True,"query":q.query,**self._ownership_snapshot(conn,q.community_id,pid,q.filters.get("fecha"),q.filters.get("conocido_en"))}
        return self._read(session,query,op)

    def ownership_propose(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{"id_propiedad","efectiva_desde","fecha_conocimiento","calidad","composicion_completa","lineas","motivo"})
            pid=integer(env.payload.get("id_propiedad"),"id_propiedad",required=True); self._require_entity(conn,"cf_propiedades","id_propiedad",pid,env.community_id)
            effective=iso_date(env.payload.get("efectiva_desde"),"efectiva_desde")
            known=iso_datetime(env.payload.get("fecha_conocimiento"),"fecha_conocimiento") or utc_now()
            quality=one_of(env.payload.get("calidad"),"calidad",{"pendiente_documentacion","observada","validada"},default="pendiente_documentacion")
            complete=boolean(env.payload.get("composicion_completa"),"composicion_completa")
            lines=self._validated_ownership_lines(conn,env.community_id,env.payload.get("lineas"),quality,complete)
            if quality=='validada' and not effective: raise ContractError('Una titularidad validada requiere fecha efectiva acreditada.')
            if quality=='validada' and env.evidence is None: raise ContractError('Una titularidad validada requiere referencia de evidencia.')
            cur=conn.execute("""INSERT INTO erp_titularidad_propuestas(id_comunidad,id_propiedad,efectiva_desde,fecha_conocimiento,calidad,composicion_completa,motivo,evidencia_tipo,evidencia_id,creada_en,creada_por) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (env.community_id,pid,effective,known,quality,int(complete),text(env.payload.get('motivo'),'motivo',maximum=2000),env.evidence.entity_type if env.evidence else None,env.evidence.entity_id if env.evidence else None,utc_now(),actor.user_id)); proposal_id=cur.lastrowid
            for line in lines: conn.execute("INSERT INTO erp_titularidad_propuesta_lineas(id_propuesta,id_propietario,porcentaje_decimal,porcentaje_original,calidad) VALUES(?,?,?,?,?)",(proposal_id,line['id_propietario'],line['porcentaje_decimal'],line['porcentaje_original'],quality))
            after=self._proposal(conn,env.community_id,proposal_id)
            return self._outcome('Cambio de titularidad propuesto','titularidad_propuesta',proposal_id,None,after,'erp1.ownership.proposed')
        return self._write(session,envelope,op)

    def ownership_confirm(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{"id_propuesta"}); proposal_id=integer(env.payload.get('id_propuesta'),'id_propuesta',required=True)
            before=self._proposal(conn,env.community_id,proposal_id)
            if before['estado']!='borrador': raise ConflictError('La propuesta ya no esta pendiente.')
            self._expected(env,before)
            effective=before['efectiva_desde']; quality=before['calidad']; complete=bool(before['composicion_completa'])
            lines=self._validated_ownership_lines(conn,env.community_id,before['lineas'],quality,complete)
            operation_id=str(uuid.uuid4()); now=utc_now(); registered_at=before['fecha_conocimiento']; pid=before['id_propiedad']
            if effective:
                active=_rows(conn.execute("""SELECT v.* FROM erp_titularidad_versiones v WHERE v.id_comunidad=? AND v.id_propiedad=? AND v.anulada=0 AND v.efectiva_hasta IS NULL""",(env.community_id,pid)))
                for current in active:
                    if current['efectiva_desde'] and current['efectiva_desde']>=effective: raise ConflictError('Existe una titularidad vigente desde la misma fecha o una posterior.')
                    next_version=int(current['version_concurrencia'])+1
                    conn.execute("""INSERT INTO erp_titularidad_versiones(id_comunidad,id_relacion,id_propiedad,id_propietario,porcentaje_decimal,porcentaje_original,efectiva_desde,efectiva_hasta,calidad,composicion_completa,motivo,registrada_en,registrada_por,origen,evidencia_tipo,evidencia_id,id_version_sustituida,id_operacion,version_concurrencia)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",(env.community_id,current['id_relacion'],pid,current['id_propietario'],current['porcentaje_decimal'],current['porcentaje_original'],current['efectiva_desde'],effective,current['calidad'],current['composicion_completa'],'Cierre por cambio de titularidad',registered_at,actor.user_id,env.origin,before['evidencia_tipo'],before['evidencia_id'],current['id_titularidad_version'],operation_id,next_version))
                    conn.execute("UPDATE erp_titularidad_versiones SET anulada=1 WHERE id_titularidad_version=?",(current['id_titularidad_version'],))
                conn.execute("UPDATE cf_propietario_propiedad SET activo=0,fecha_hasta=?,version=version+1 WHERE id_comunidad=? AND id_propiedad=? AND activo=1",(effective,env.community_id,pid))
            for line in lines:
                cur=conn.execute("""INSERT INTO cf_propietario_propiedad(id_propietario,id_propiedad,fecha_desde,activo,porcentaje_titularidad,porcentaje_titularidad_decimal,motivo,id_comunidad,calidad,procedencia,fecha_conocimiento,version)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,1)""",(line['id_propietario'],pid,effective,1,float(Decimal(line['porcentaje_decimal'])) if line['porcentaje_decimal'] is not None else None,line['porcentaje_decimal'],before['motivo'],env.community_id,quality,env.origin,before['fecha_conocimiento']))
                relation_id=cur.lastrowid
                conn.execute("""INSERT INTO erp_titularidad_versiones(id_comunidad,id_relacion,id_propiedad,id_propietario,porcentaje_decimal,porcentaje_original,efectiva_desde,calidad,composicion_completa,motivo,registrada_en,registrada_por,origen,evidencia_tipo,evidencia_id,id_operacion,version_concurrencia)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",(env.community_id,relation_id,pid,line['id_propietario'],line['porcentaje_decimal'],line['porcentaje_original'],effective,quality,int(complete),before['motivo'],registered_at,actor.user_id,env.origin,before['evidencia_tipo'],before['evidencia_id'],operation_id))
            conn.execute("UPDATE erp_titularidad_propuestas SET estado='confirmada',confirmada_en=?,confirmada_por=?,id_operacion=?,version=version+1 WHERE id_propuesta=?",(now,actor.user_id,operation_id,proposal_id))
            after=self._proposal(conn,env.community_id,proposal_id); after['composicion_resultante']=self._ownership_snapshot(conn,env.community_id,pid,effective,now)
            return self._outcome('Cambio de titularidad confirmado','titularidad_propuesta',proposal_id,before,after,'erp1.ownership.confirmed')
        return self._write(session,envelope,op)

    def group_list(self, session, query):
        def op(conn,q):
            only(q.filters,{"id_grupo","fecha"})
            gid=integer(q.filters.get('id_grupo'),'id_grupo')
            if gid:
                entity=self._require_entity(conn,'erp_grupos_reparto','id_grupo',gid,q.community_id)
                entity['versiones']=_rows(conn.execute('SELECT * FROM erp_grupo_versiones WHERE id_grupo=? ORDER BY version DESC',(gid,)))
                entity['miembros']=self._group_members(conn,q.community_id,gid,q.filters.get('fecha'))
                return {'ok':True,'query':q.query,'entity':entity}
            return {'ok':True,'query':q.query,'items':_rows(conn.execute("""SELECT g.*,(SELECT COUNT(*) FROM erp_grupo_miembros m WHERE m.id_grupo=g.id_grupo) AS miembros FROM erp_grupos_reparto g WHERE g.id_comunidad=? ORDER BY g.nombre""",(q.community_id,)))}
        return self._read(session,query,op)

    def group_save(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{'id_grupo','codigo','nombre','finalidad','estado','base','suma_esperada_decimal','efectiva_desde','efectiva_hasta'})
            gid=integer(env.payload.get('id_grupo'),'id_grupo'); before=self._require_entity(conn,'erp_grupos_reparto','id_grupo',gid,env.community_id) if gid else None
            if before:self._expected(env,before)
            code=text(env.payload.get('codigo',before and before['codigo']),'codigo',required=True,maximum=60); name=text(env.payload.get('nombre',before and before['nombre']),'nombre',required=True,maximum=240)
            state=one_of(env.payload.get('estado',before and before['estado'] or 'preparacion'),'estado',{'preparacion','activo','inactivo'}); now=utc_now()
            if before: conn.execute('UPDATE erp_grupos_reparto SET codigo=?,nombre=?,finalidad=?,estado=?,version=version+1 WHERE id_grupo=?',(code,name,text(env.payload.get('finalidad',before['finalidad']),'finalidad',maximum=500),state,gid))
            else:
                cur=conn.execute('INSERT INTO erp_grupos_reparto(id_comunidad,codigo,nombre,finalidad,estado,creado_en,creado_por,origen) VALUES(?,?,?,?,?,?,?,?)',(env.community_id,code,name,text(env.payload.get('finalidad'),'finalidad',maximum=500),state,now,actor.user_id,env.origin)); gid=cur.lastrowid
            if not before or 'base' in env.payload:
                start=iso_date(env.payload.get('efectiva_desde'),'efectiva_desde'); end=iso_date(env.payload.get('efectiva_hasta'),'efectiva_hasta'); valid_interval(start,end)
                version=conn.execute('SELECT COALESCE(MAX(version),0)+1 FROM erp_grupo_versiones WHERE id_grupo=?',(gid,)).fetchone()[0]
                conn.execute("""INSERT INTO erp_grupo_versiones(id_comunidad,id_grupo,version,efectiva_desde,efectiva_hasta,base,suma_esperada_decimal,estado,registrada_en,registrada_por,origen) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",(env.community_id,gid,version,start,end,one_of(env.payload.get('base'),'base',{'porcentaje','peso','sin_coeficiente','otra'},default='sin_coeficiente'),decimal_text(env.payload.get('suma_esperada_decimal'),'suma_esperada_decimal'),'borrador',now,actor.user_id,env.origin))
            after=self._require_entity(conn,'erp_grupos_reparto','id_grupo',gid,env.community_id)
            return self._outcome('Grupo de reparto guardado','grupo_reparto',gid,before,after,'erp1.group.saved')
        return self._write(session,envelope,op)

    def membership_save(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{'id_grupo','id_propiedad','participa','excluida','efectiva_desde','efectiva_hasta','motivo'})
            gid=integer(env.payload.get('id_grupo'),'id_grupo',required=True); pid=integer(env.payload.get('id_propiedad'),'id_propiedad',required=True)
            self._require_entity(conn,'erp_grupos_reparto','id_grupo',gid,env.community_id); self._require_entity(conn,'cf_propiedades','id_propiedad',pid,env.community_id)
            start=iso_date(env.payload.get('efectiva_desde'),'efectiva_desde'); end=iso_date(env.payload.get('efectiva_hasta'),'efectiva_hasta'); valid_interval(start,end)
            participates=boolean(env.payload.get('participa'),'participa',default=True); excluded=boolean(env.payload.get('excluida'),'excluida')
            if participates and excluded: raise ContractError('Una propiedad no puede participar y estar excluida simultaneamente.')
            member=conn.execute('SELECT * FROM erp_grupo_miembros WHERE id_comunidad=? AND id_grupo=? AND id_propiedad=?',(env.community_id,gid,pid)).fetchone(); before=_dict(member)
            if not member:
                cur=conn.execute('INSERT INTO erp_grupo_miembros(id_comunidad,id_grupo,id_propiedad,creado_en,creado_por,origen) VALUES(?,?,?,?,?,?)',(env.community_id,gid,pid,utc_now(),actor.user_id,env.origin)); mid=cur.lastrowid; version=1
            else: mid=member['id_miembro']; version=conn.execute('SELECT COALESCE(MAX(version),0)+1 FROM erp_grupo_miembro_versiones WHERE id_miembro=?',(mid,)).fetchone()[0]
            conn.execute('INSERT INTO erp_grupo_miembro_versiones(id_comunidad,id_miembro,version,efectiva_desde,efectiva_hasta,participa,excluida,motivo,registrada_en,registrada_por,origen) VALUES(?,?,?,?,?,?,?,?,?,?,?)',(env.community_id,mid,version,start,end,int(participates),int(excluded),text(env.payload.get('motivo'),'motivo',maximum=1000),utc_now(),actor.user_id,env.origin))
            after=self._require_entity(conn,'erp_grupo_miembros','id_miembro',mid,env.community_id); after['ultima_version']=_dict(conn.execute('SELECT * FROM erp_grupo_miembro_versiones WHERE id_miembro=? ORDER BY version DESC LIMIT 1',(mid,)).fetchone())
            return self._outcome('Pertenencia a grupo guardada','grupo_miembro',mid,before,after,'erp1.group.membership.saved')
        return self._write(session,envelope,op)

    def coefficient_get(self, session, query):
        def op(conn,q):
            only(q.filters,{'id_propiedad','id_grupo','fecha','finalidad'}); pid=integer(q.filters.get('id_propiedad'),'id_propiedad',required=True); self._require_entity(conn,'cf_propiedades','id_propiedad',pid,q.community_id)
            clauses=['s.id_comunidad=?','s.id_propiedad=?']; values=[q.community_id,pid]
            if q.filters.get('id_grupo') not in (None,''): clauses.append('s.id_grupo=?'); values.append(integer(q.filters.get('id_grupo'),'id_grupo'))
            if q.filters.get('finalidad'): clauses.append('s.finalidad=?'); values.append(str(q.filters['finalidad']))
            items=[]
            for series in conn.execute('SELECT s.*,g.codigo AS grupo_codigo,g.nombre AS grupo_nombre FROM erp_coeficiente_series s LEFT JOIN erp_grupos_reparto g ON g.id_grupo=s.id_grupo WHERE '+' AND '.join(clauses),values):
                item=dict(series); item['version_vigente']=self._coefficient_version(conn,item['id_serie'],q.filters.get('fecha')); items.append(item)
            return {'ok':True,'query':q.query,'items':items}
        return self._read(session,query,op)

    def coefficient_save(self, session, envelope):
        def op(conn,actor,env):
            only(env.payload,{'id_serie','id_propiedad','id_grupo','finalidad','unidad','escala','estado_serie','valor_decimal','valor_original','precision_original','calidad','estado','efectiva_desde','efectiva_hasta'})
            sid=integer(env.payload.get('id_serie'),'id_serie'); before=self._require_entity(conn,'erp_coeficiente_series','id_serie',sid,env.community_id) if sid else None
            if before:self._expected(env,before)
            pid=integer(env.payload.get('id_propiedad',before and before['id_propiedad']),'id_propiedad',required=True); self._require_entity(conn,'cf_propiedades','id_propiedad',pid,env.community_id)
            gid=integer(env.payload.get('id_grupo',before and before['id_grupo']),'id_grupo')
            if gid:self._require_entity(conn,'erp_grupos_reparto','id_grupo',gid,env.community_id)
            purpose=text(env.payload.get('finalidad',before and before['finalidad']),'finalidad',required=True,maximum=100); unit=one_of(env.payload.get('unidad',before and before['unidad']),'unidad',{'porcentaje','tanto_por_uno','peso','otra'})
            scale=integer(env.payload.get('escala',before and before['escala'] or 12),'escala',minimum=0)
            if scale>30:raise ContractError('La escala supera 30 decimales.')
            series_state=one_of(env.payload.get('estado_serie',before and before['estado'] or 'activa'),'estado_serie',{'preparacion','activa','inactiva'}); now=utc_now()
            if before: conn.execute('UPDATE erp_coeficiente_series SET id_propiedad=?,id_grupo=?,finalidad=?,unidad=?,escala=?,estado=?,version=version+1 WHERE id_serie=?',(pid,gid,purpose,unit,scale,series_state,sid))
            else:
                cur=conn.execute('INSERT INTO erp_coeficiente_series(id_comunidad,id_propiedad,id_grupo,finalidad,unidad,escala,estado,creada_en,creada_por,origen) VALUES(?,?,?,?,?,?,?,?,?,?)',(env.community_id,pid,gid,purpose,unit,scale,series_state,now,actor.user_id,env.origin)); sid=cur.lastrowid
            start=iso_date(env.payload.get('efectiva_desde'),'efectiva_desde'); end=iso_date(env.payload.get('efectiva_hasta'),'efectiva_hasta'); valid_interval(start,end)
            value=decimal_text(env.payload.get('valor_decimal'),'valor_decimal',required=True,max_scale=scale); status=one_of(env.payload.get('estado'),'estado',{'borrador','observada','aprobada','sustituida','anulada'},default='observada'); quality=one_of(env.payload.get('calidad'),'calidad',{'pendiente_documentacion','observada','validada'},default='observada')
            if status=='aprobada':
                overlap=conn.execute("""SELECT 1 FROM erp_coeficiente_versiones WHERE id_serie=? AND estado='aprobada' AND NOT(COALESCE(efectiva_hasta,'9999-12-31')<=COALESCE(?,'0001-01-01') OR COALESCE(efectiva_desde,'0001-01-01')>=COALESCE(?,'9999-12-31')) LIMIT 1""",(sid,start,end)).fetchone()
                if overlap:raise ConflictError('Existe otro coeficiente aprobado vigente en ese intervalo.')
            version=conn.execute('SELECT COALESCE(MAX(version),0)+1 FROM erp_coeficiente_versiones WHERE id_serie=?',(sid,)).fetchone()[0]
            conn.execute('INSERT INTO erp_coeficiente_versiones(id_comunidad,id_serie,version,efectiva_desde,efectiva_hasta,valor_decimal,valor_original,precision_original,calidad,estado,registrada_en,registrada_por,origen,evidencia_tipo,evidencia_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(env.community_id,sid,version,start,end,value,text(env.payload.get('valor_original'),'valor_original',maximum=120) or str(env.payload.get('valor_decimal')),integer(env.payload.get('precision_original'),'precision_original',minimum=0),quality,status,now,actor.user_id,env.origin,env.evidence.entity_type if env.evidence else None,env.evidence.entity_id if env.evidence else None))
            after=self._require_entity(conn,'erp_coeficiente_series','id_serie',sid,env.community_id); after['version_vigente']=self._coefficient_version(conn,sid,start)
            return self._outcome('Coeficiente guardado','coeficiente_serie',sid,before,after,'erp1.coefficient.saved')
        return self._write(session,envelope,op)

    def provenance_record(self, session, envelope):
        def op(conn,actor,env):
            allowed={'sistema_origen','entidad_origen','codigo_origen','id_importacion','fila_origen','campo_origen','valor_original','entidad_destino','id_destino','decision','incidencia','resolucion'};only(env.payload,allowed)
            source={k:env.payload.get(k) for k in sorted(allowed) if k not in {'incidencia','resolucion'}}
            digest=hashlib.sha256(canonical_json(source).encode('utf-8')).hexdigest()
            existing=conn.execute('SELECT * FROM erp_fuente_registros WHERE id_comunidad=? AND sistema_origen=? AND hash_hecho=?',(env.community_id,text(env.payload.get('sistema_origen'),'sistema_origen',required=True,maximum=80),digest)).fetchone()
            if existing:
                after=dict(existing); entity_id=after['id_fuente_registro']; before=after
            else:
                cur=conn.execute('INSERT INTO erp_fuente_registros(id_comunidad,sistema_origen,entidad_origen,codigo_origen,id_importacion,fila_origen,campo_origen,valor_original,entidad_destino,id_destino,decision,incidencia,resolucion,hash_hecho,registrada_en,registrada_por) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(env.community_id,text(env.payload.get('sistema_origen'),'sistema_origen',required=True,maximum=80),text(env.payload.get('entidad_origen'),'entidad_origen',required=True,maximum=80),text(env.payload.get('codigo_origen'),'codigo_origen',maximum=200),integer(env.payload.get('id_importacion'),'id_importacion'),text(env.payload.get('fila_origen'),'fila_origen',maximum=120),text(env.payload.get('campo_origen'),'campo_origen',maximum=120),text(env.payload.get('valor_original'),'valor_original',maximum=4000),text(env.payload.get('entidad_destino'),'entidad_destino',required=True,maximum=80),text(env.payload.get('id_destino'),'id_destino',required=True,maximum=120),text(env.payload.get('decision'),'decision',required=True,maximum=120),text(env.payload.get('incidencia'),'incidencia',maximum=1000),text(env.payload.get('resolucion'),'resolucion',maximum=1000),digest,utc_now(),actor.user_id)); entity_id=cur.lastrowid; before=None; after=dict(conn.execute('SELECT * FROM erp_fuente_registros WHERE id_fuente_registro=?',(entity_id,)).fetchone())
            return self._outcome('Procedencia registrada','fuente_registro',entity_id,before,after,'erp1.provenance.recorded')
        return self._write(session,envelope,op)

    @staticmethod
    def _outcome(action,entity_type,entity_id,before,after,event_type):
        return {'action':action,'entity_type':entity_type,'entity_id':entity_id,'before':before,'after':after,'result':after,'entity_version':int((after or {}).get('version') or 1),'event_type':event_type}

    def _proposal(self,conn,community_id,proposal_id):
        result=self._require_entity(conn,'erp_titularidad_propuestas','id_propuesta',proposal_id,community_id)
        result['lineas']=_rows(conn.execute("""SELECT l.*,o.nombre,o.nif FROM erp_titularidad_propuesta_lineas l JOIN cf_propietarios o ON o.id_propietario=l.id_propietario WHERE l.id_propuesta=? ORDER BY o.nombre""",(proposal_id,)))
        return result

    def _validated_ownership_lines(self,conn,community_id,lines,quality,complete):
        if not isinstance(lines,list) or not lines:raise ContractError('La propuesta requiere al menos un titular.')
        result=[]; seen=set(); total=Decimal('0'); unknown=False
        for raw in lines:
            if not isinstance(raw,dict):raise ContractError('Cada titular debe ser un objeto.')
            only(raw,{'id_propietario','porcentaje_decimal','porcentaje_original','calidad','nombre','nif','id_linea','id_propuesta'})
            oid=integer(raw.get('id_propietario'),'id_propietario',required=True)
            if oid in seen:raise ContractError('Un propietario no puede repetirse en la misma composicion.')
            seen.add(oid);self._require_entity(conn,'cf_propietarios','id_propietario',oid,community_id)
            pct=decimal_text(raw.get('porcentaje_decimal'),'porcentaje_decimal',max_scale=12)
            if pct is None:unknown=True
            else:
                number=Decimal(pct)
                if number<=0 or number>100:raise ContractError('Cada porcentaje debe ser mayor que 0 y menor o igual que 100.')
                total+=number
            result.append({'id_propietario':oid,'porcentaje_decimal':pct,'porcentaje_original':text(raw.get('porcentaje_original'),'porcentaje_original',maximum=120) or pct})
        if total>Decimal('100'):raise ContractError(f'La composicion suma {total} %, por encima de 100 %.')
        if complete and (unknown or total!=Decimal('100')):raise ContractError('Una composicion completa debe sumar exactamente 100 %.')
        if quality=='validada' and not complete:raise ContractError('Una composicion validada debe declararse completa.')
        return result

    def _ownership_snapshot(self,conn,community_id,property_id,effective_date=None,known_at=None):
        effective=iso_date(effective_date,'fecha') or date.today().isoformat(); known=iso_datetime(known_at,'conocido_en') or '9999-12-31T23:59:59Z'
        versions=_rows(conn.execute("""SELECT v.*,o.nombre,o.nif FROM erp_titularidad_versiones v JOIN cf_propietarios o ON o.id_propietario=v.id_propietario WHERE v.id_comunidad=? AND v.id_propiedad=? AND v.registrada_en<=? ORDER BY v.registrada_en,v.id_titularidad_version""",(community_id,property_id,known)))
        replaced={v['id_version_sustituida'] for v in versions if v.get('id_version_sustituida')}
        active=[v for v in versions if not v['anulada'] and v['id_titularidad_version'] not in replaced and (not v['efectiva_desde'] or v['efectiva_desde']<=effective) and (not v['efectiva_hasta'] or v['efectiva_hasta']>effective)]
        total=sum((Decimal(v['porcentaje_decimal']) for v in active if v['porcentaje_decimal'] is not None),Decimal('0')); unknown=any(v['porcentaje_decimal'] is None for v in active)
        return {'items':active,'fecha_efectiva':effective,'conocido_en':known,'porcentaje_conocido':format(total,'f'),'composicion_completa':bool(active) and not unknown and total==Decimal('100'),'cobertura':'completa' if active and not unknown and total==Decimal('100') else ('sin_datos' if not active else 'incompleta')}

    @staticmethod
    def _group_members(conn,community_id,group_id,effective_date=None):
        effective=iso_date(effective_date,'fecha') or date.today().isoformat()
        return _rows(conn.execute("""SELECT m.id_miembro,m.id_propiedad,p.codigo_propiedad,v.participa,v.excluida,v.efectiva_desde,v.efectiva_hasta,v.motivo FROM erp_grupo_miembros m JOIN cf_propiedades p ON p.id_propiedad=m.id_propiedad JOIN erp_grupo_miembro_versiones v ON v.id_miembro=m.id_miembro WHERE m.id_comunidad=? AND m.id_grupo=? AND v.version=(SELECT MAX(v2.version) FROM erp_grupo_miembro_versiones v2 WHERE v2.id_miembro=m.id_miembro AND (v2.efectiva_desde IS NULL OR v2.efectiva_desde<=?) AND (v2.efectiva_hasta IS NULL OR v2.efectiva_hasta>?)) ORDER BY p.codigo_normalizado""",(community_id,group_id,effective,effective)))

    @staticmethod
    def _coefficient_version(conn,series_id,effective_date=None):
        effective=iso_date(effective_date,'fecha') or date.today().isoformat()
        return _dict(conn.execute("""SELECT * FROM erp_coeficiente_versiones WHERE id_serie=? AND estado<>'anulada' AND (efectiva_desde IS NULL OR efectiva_desde<=?) AND (efectiva_hasta IS NULL OR efectiva_hasta>?) ORDER BY CASE estado WHEN 'aprobada' THEN 0 WHEN 'observada' THEN 1 ELSE 2 END,version DESC LIMIT 1""",(series_id,effective,effective)).fetchone())
