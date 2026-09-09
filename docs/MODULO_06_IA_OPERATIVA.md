# Modulo 06 - IA operativa

## Alcance confirmado el 09/09/2026

1. Seguimiento contextual primero: convertir lenguaje natural en comentario profesional, accion siguiente opcional, responsable siguiente obligatorio y fechas/estado solo respaldados. No reescribir manualmente lo que ya estaba en la entrada.
2. Reuniones despues: separar asuntos, buscar existentes primero, proponer seguimiento antes que alta, evitar duplicados y dejar dudas pendientes. Sin prefijos editoriales en comentarios.
3. Centro de consultas despues de estabilizar los dos anteriores.

Decisiones cerradas: confirmacion individual y por seleccion; borradores persistentes con ediciones y sin repetir confirmados; responsable desconocido Administracion, advertencia y guardado permitido.
Siempre permisos por comunidad, propuestas editables, contradicciones visibles y confirmacion humana. Nunca modificar el expediente durante el analisis.

## Secuencia verificable

- A: seguimiento externo dedicado, destino autorizado exacto, sin contaminacion de memoria ni mezcla con reglas locales.
- B: borradores persistentes y confirmacion idempotente, pruebas de permisos y concurrencia.
- C: reuniones multiasunto con reutilizacion de contratos, revision individual/seleccionada, deduplicacion y reanudacion.
- D: validacion integral en escritorio/movil y casos reales; consultas generales siguen despues.

No marcar todo el modulo completado por mejorar un prompt. Aceptacion semantica requiere pruebas reales y revision del usuario. Las evidencias literales son una comprobacion de origen, no una garantia de interpretacion correcta.

## Respaldo anterior a cambios

- Local: backups/before-module06-20260909.tar.gz (codigo y documentacion).
- Ubuntu: /home/coordinador/apps/organizador-web/backups/before-module06-20260909-065532 (SQLite verificada y archivos privados).
- Ningun cambio permitido en UNO Marbella.

## Estado

Definicion 100%. Bloques A y B: 100% de implementacion, publicados el 09/09/2026. C pendiente. D: regresion y vistas de seguimiento comprobadas; aceptacion semantica por el usuario pendiente. No confundir el cierre de A/B con el cierre del modulo completo.
Publicacion: backups/stage-operational-20260909-105755; copia anterior a publicar: backups/before-operational-publish-20260909-105755. La bateria operativa de 16 grupos paso antes de detener/reiniciar exclusivamente organizador-web.service. Salud localhost:8771 verificada.

### Cambios de A y B

- Analisis contextual en server/ai-followup.js: sin catalogo limitado, sin contexto de chat antiguo y sin sobreescritura posterior por reglas de redaccion.
- Consulta autorizada del expediente exacto. Nunca se conserva un destino inventado si el identificador no existe o no se puede actualizar.
- Una llamada externa por seguimiento y, solo si propone campos con evidencia invalida, una unica correccion adicional. Maximo dos llamadas, 90 segundos por llamada; no hay bucle de reintentos. Limite de entrada explicito; errores del proveedor y respuestas truncadas visibles, sin fallback silencioso.
- Comentario profesional; condicion presupuestaria conservada; proximo paso vacio permitido. Estado/prioridad/responsable general conservados salvo estado propuesto con evidencia y revision.
- Fechas relativas requieren fecha de conversacion; propietario siguiente incierto queda Administracion con aviso.
- Fecha opcional, campos sin heredar valores antiguos, proteccion frente a respuesta tardia de otra ficha o cambios manuales mientras se analiza.
- Tabla privada ia_borradores_seguimiento. Analizar conserva propuesta; Guardar borrador conserva ediciones de campos; Recuperar borrador restaura el ultimo pendiente de la ficha para el mismo usuario.
- Confirmacion en la misma transaccion que el seguimiento; version de ficha y revision del borrador comprobadas; reintento devuelve el registro ya creado, sin duplicarlo. Auditoria de confirmacion.
- El guardado del borrador no modifica tareas, proyectos ni compromisos.

### Verificaciones realizadas

- Pruebas unitarias de evidencia literal, condiciones, vacios, fechas, datos insuficientes, proveedor fallido y nombres de columnas de proyectos.
- Bateria operativa de 16 grupos en copia aislada de SQLite, incluidos borradores privados, permisos por comunidad, conflicto de edicion y doble confirmacion.
- Regresiones assert*.mjs y Playwright en escritorio 1440x1000 y movil 390x844. Sin errores de JavaScript ni desbordamiento horizontal en las vistas comprobadas.
- Prueba externa sintetica de badenes con configuracion real NVIDIA (openai/gpt-oss-20b): comentario formal, siguiente paso condicionado, Administracion con aviso, sin fecha inventada ni cambio de estado.
- Una prueba adicional de reparacion parcial detecto evidencia extraida del responsable antiguo en lugar de la entrada. Se incorporo validacion y una correccion acotada. La comparacion final con Nemotron paso antes de publicar.
- La prueba de plazo relativo detecto que el modelo podia omitir la fecha pese a existir referencia expresa. Hoy/manana/pasado manana se resuelven de forma determinista solo con cita valida y fecha de conversacion.
- Hubo un timeout externo de 90 segundos. Se ensayo reasoning_effort=low y se descarto: omitio una condicion presupuestaria del proximo paso. Se conserva medium para NVIDIA GPT-OSS con 4096 tokens, sin cambiar modelo ni las otras funciones IA. Parametros documentados en https://docs.api.nvidia.com/nim/reference/openai-gpt-oss-20b-infer. No prometer disponibilidad ni latencia garantizadas del proveedor.
- El control de calidad tambien pide corregir un siguiente paso cuando detecta condiciones en la entrada no reflejadas en el paso. Es una alerta conservadora de revision, no una prueba semantica exhaustiva; si persiste tras una correccion se muestra advertencia.
- Respuestas externas vacias, incompletas o en cola (HTTP 202) no se presentan como analisis valido.
- Comparacion real final: NVIDIA nvidia/nemotron-3-super-120b-a12b pasa los tres casos (presupuesto condicionado, reparacion parcial con responsable y manana, entrada insuficiente con preguntas). GPT-OSS-120b responde HTTP 410 y no se utiliza. GPT-OSS-20b dio resultados inconsistentes y timeouts.
- Se selecciona Nemotron 3 Super solo para targeted_followup_*. AI_FOLLOWUP_MODEL permite override; AI_MODEL del resto de modulos no cambia. OpenAI u otros proveedores mantienen AI_MODEL salvo override explicito. El motor no se instala localmente ni se sustituye el proveedor.
- La salida de reparacion parcial sugirio tambien reparar si fuera necesario: se refuerza la instruccion de no ampliar "revisar" a "reparar". Esta limitacion ilustra por que las propuestas necesitan revision humana incluso cuando pasan las aserciones automaticas.
- Ningun dato de negocio escrito por las pruebas. No se han enviado documentos o bases de datos reales en las pruebas externas.

### Limites y continuidad

- No certificar todavia reuniones: el flujo previo corta catalogos y texto, impone un timeout de 8 segundos y vuelve a aplicar reglas locales a la salida de IA. Debe sustituirse como bloque, no darlo por corregido por mejorar el seguimiento.
- Pendiente persistencia de lotes de reuniones, confirmacion individual/seleccionada, matching completo, manejo de altas y reintentos parciales sin duplicados.
- Los borradores de seguimiento se guardan por ficha; todavia no existe un listado historico de todos los borradores. Las ediciones requieren Guardar borrador; no hay autosalvado silencioso.
- Una prueba sintetica satisfactoria no garantiza interpretacion perfecta en casos reales. La revision humana sigue siendo obligatoria.
