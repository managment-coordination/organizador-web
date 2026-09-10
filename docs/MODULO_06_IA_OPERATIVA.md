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

Definicion 100%. Bloques A y B publicados el 09/09/2026. Bloque C: 100% de implementacion y pruebas tecnicas, publicado el 10/09/2026. D: regresion, proveedor sintetico y vistas comprobados; aceptacion semantica por el usuario pendiente. No confundir implementacion con una garantia de comprension infalible.
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

- El nuevo recorrido de reuniones sustituye la ruta anterior en Centro IA (transcripciones extensas), Analizar reunion, lotes del agente e importacion de texto natural. La importacion de texto expresamente estructurado y la carga de historicos conservan su contrato anterior; no se presentan como analisis semantico nuevo.
- Los borradores de seguimiento se guardan por ficha; todavia no existe un listado historico de todos los borradores. Las ediciones requieren Guardar borrador; no hay autosalvado silencioso.
- Una prueba sintetica satisfactoria no garantiza interpretacion perfecta en casos reales. La revision humana sigue siendo obligatoria.

## Bloque C: reuniones revisables (10/09/2026)

- server/ai-meetings.js: lectura de TODO el texto por fragmentos, citas literales comprobadas, agrupacion posterior de temas intercalados, busqueda en catalogo autorizado completo y redaccion profesional por asunto. No aplica el pulido mecanico antiguo a la salida.
- El catalogo incluye expedientes cerrados, descripcion, comunidad y version del registro; ningun identificador propuesto fuera del catalogo puede convertirse automaticamente en seguimiento.
- Una propuesta por expediente existente; si la IA repite u omite indices de asuntos se interrumpe con error visible. Las citas verifican origen, no garantizan exhaustividad semantica.
- Ante destino dudoso: tarjeta con comentario util y pregunta, sin seleccionar. Se puede elegir existente o alta nueva. Responsable incierto: Administracion y advertencia. Proximo paso opcional.
- Se conserva el estado real; se traduce la nomenclatura de cierre/bloqueo para tareas y proyectos. La fecha de una llamada no debe convertirse en fecha de la siguiente accion.
- Modelo de redaccion probado: NVIDIA Nemotron 3 Super, mediante la misma configuracion AI_FOLLOWUP_MODEL; otros proveedores mantienen su adaptador. No afecta a AI_MODEL de las consultas generales.
- Tablas privadas ia_reuniones e ia_reunion_asuntos: entrada original, fecha de referencia, catalogo, propuestas, revisiones y resultados confirmados. Auditoria enlaza reunion y asunto.
- Analisis en segundo plano con progreso persistido. Si se reinicia el servidor, el borrador pasa a interrupcion explicita al consultarlo; se recupera el texto para reanalizar. No se reintenta automaticamente ni se repite consumo sin accion humana.
- Revision individual y por seleccion. Guardar borrador conserva ediciones; al confirmar se conservan tambien las ediciones de otras tarjetas. Confirmados quedan plegados y no editables.
- Cada confirmacion queda marcada dentro de la MISMA transaccion de alta/seguimiento. Si una seleccion falla parcialmente, los resultados correctos siguen confirmados y no se repiten al reintentar. Version de expediente y revision del borrador impiden sobrescrituras silenciosas.
- Alcance por usuario y comunidades, mas permiso de creacion para altas. No envia solicitudes presidenciales por inferir un nombre.

### Capacidad y limites explicitos

- Hasta 180.000 caracteres de entrada; fragmentos de hasta 14.000. Hasta 1.000 expedientes y 180.000 caracteres de catalogo. Hasta 100 fragmentos de asuntos y 50 propuestas finales. Al superar un limite se pide dividir o concretar, nunca se corta silenciosamente.
- Llamadas externas: una por fragmento, una para agrupar/asociar y una por asunto final; 120 segundos maximos por llamada, sin reintentos ocultos. Maximo dos reuniones simultaneas. Una reunion extensa puede tardar varios minutos; no hay garantia de latencia del proveedor.
- Borradores recuperables desde Centro IA > Reuniones guardadas. Las ediciones sin Guardar borrador o Confirmar no se autosalvan al cerrar el navegador.
- No se garantiza que la IA detecte todos los asuntos ni que toda inferencia sea correcta. Hay que revisar el comentario, las condiciones, el destino y los plazos.
- La entrada extraida queda conservada en el borrador; este cambio no promete adjuntar automaticamente el archivo binario original a cada expediente. Los anexos se incorporan desde Adjuntar de la ficha.
- Las consultas generales conservan funcionalidad existente y pruebas de regresion; su ampliacion transversal no se ha implementado en este bloque. No declararla cerrada por haber terminado reuniones.

### Comprobaciones

- 17 grupos de regresion operativa en copia aislada de SQLite, incluidos guardado privado, revisiones obsoletas, confirmacion individual/seleccionada, alta nueva, fallo parcial y reintento sin duplicados.
- Pruebas puras: cobertura completa de fragmentacion, fuentes inexistentes, indices omitidos/repetidos, limite de catalogo, existente preferente, dudas con comentario, condiciones y siguiente paso vacio.
- Prueba sintetica con proveedor real: badenes asociado a proyecto existente con condicion de presupuesto; alumbrado parcial asociado a tarea sin darla por finalizada; nueva gotera propuesta como tarea. No se enviaron registros reales de propietarios/contabilidad.
- La lectura humana del resultado detecto que "Hoy he hablado" se usaba como plazo. Se anadio control conservador y regresion especifica; las pruebas iniciales se ampliaron para comprobarlo.
- Playwright escritorio 1440x1000 y movil 390x844, cinco vistas y revision de reuniones; edicion de un asunto conservada al confirmar otro. Se registran evidencias en archivos temporales de QA, nunca en la base real.

### Continuidad

Publicado tras superar los 17 grupos tambien en Ubuntu sobre copia de la base real. Stage: backups/stage-operational-20260910-093924. Copia previa a publicar: backups/before-operational-publish-20260910-093924 (SQLite integra, codigo, documentos y configuracion privada). Solo se reinicio organizador-web.service; UNO Marbella no se modifico.

Validacion posterior: 28 rutas, cinco perfiles activos, integridad SQLite ok. Regresion assert*.mjs completa. Ultima prueba externa sintetica pasa tambien la fecha de conversacion frente al plazo. Ultimas capturas: C:/Users/EQUIPO/AppData/Local/Temp/organizador-ui-release-pBGR1c (movil/escritorio, cinco vistas y reuniones). Fixtures locales y remotas independientes; nunca se crearon asuntos de prueba en produccion.

Siguiente verificacion funcional: una reunion real del usuario, revisando omisiones, asociaciones y redaccion antes de confirmar. La ampliacion de consultas generales queda pendiente, no se considera ejecutada por haber cerrado el bloque C. No iniciar Seguridad, Asambleas ni un nuevo roadmap sin indicacion del usuario.

La idempotencia corresponde a la confirmacion de cada asunto del mismo borrador. Reanalizar deliberadamente el mismo texto como una reunion nueva crea otro borrador y requiere revisar posibles seguimientos repetidos; no hay deduplicacion universal entre reuniones diferentes.

## Correccion de enrutamiento de consultas (10/09/2026)

Incidencia comunicada: "quien es el propietario marchito" se trataba como lote. El Centro IA construia un texto con instrucciones, palabras de herramientas y contexto de pantalla y lo pasaba al clasificador como si fuera la entrada del usuario. El contexto conversacional podia contaminar tambien la decision. Ademas, la consulta de propietario se derivaba siempre a buscar una propiedad, no a buscar una persona por nombre.

- La decision de intencion y herramienta se toma ahora sobre la instruccion actual, separada del contexto auxiliar. Una pregunta explicita de lectura no se convierte en lote por adjuntos antiguos o por el historico. Las peticiones explicitas de escritura, informes y emails conservan su ruta.
- Las consultas autonomas no heredan contexto previo. Las referencias expresas ("ese propietario", "esa tarea") conservan posibilidad de contexto; las preguntas sobre documentos pueden seguir usando sus datos de apoyo sin convertirlos en instrucciones de escritura.
- Identidad por nombre: consulta las tablas autorizadas, devuelve coincidencia, candidatos o aclaracion. Se conserva la consulta por vivienda/codigo y por email. No se inventa un propietario si no existe.
- Identidad, contacto y propiedad se devuelven directamente desde los datos estructurados, sin esperar una reescritura de NVIDIA. Un fallo o truncamiento de esa reescritura no debe impedir una respuesta que ya existe en base de datos.
- Regresion: pregunta comunicada, variantes, contexto de reunion de 500 repeticiones, adjunto anterior, propietario inexistente, aislamiento por comunidad y solicitudes de escritura que no deben convertirse en consultas. Se mantienen los 14 casos de consulta anteriores.
- Lectura: la respuesta de consulta aparece antes de los detalles de interpretacion (desplegables). Las respuestas breves no quedan ocultas tras "Ver respuesta en texto". Cada contenedor usa un identificador propio para no renderizar en otro panel oculto.
- Verificacion local: 17 grupos operativos; 14 consultas existentes y tres comprobaciones de permisos; pruebas de enrutamiento y contexto; interfaz en escritorio y movil sobre copias aisladas, sin crear propietarios ni expedientes de prueba en produccion.
