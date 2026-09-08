# Modulo 02: Tareas y proyectos

## Estado

Actualizacion posterior: el modulo 04 sustituye la solicitud implicita al asignar al presidente por una accion explicita. Ver `MODULO_04_NOTIFICACIONES_PRESIDENCIA.md`; los compromisos y el responsable general siguen siendo independientes.

Definicion funcional confirmada por el usuario el 08/09/2026: 100%. Implementacion, pruebas y publicacion en Ubuntu: 100% del alcance confirmado. El porcentaje no certifica toda la aplicacion ni sustituye la aceptacion del usuario durante el uso real.

Implementacion autorizada por el usuario. Copias previas: `backups/before-module02-20260908.tar.gz` local y `/home/coordinador/apps/organizador-web/backups/before-module02-20260908-072728` en Ubuntu. Crear ademas copia coherente justo antes de publicar.

## Acuerdos confirmados

### Finalidad y clasificacion

- Tareas: asuntos ordinarios del dia a dia, gestion cotidiana y resolucion de incidencias.
- Proyectos: trabajos extraordinarios programados, principalmente acordados en junta.
- Un proyecto puede comenzar como propuesta previa a aprobacion, reuniendo definicion de trabajos, documentos y presupuestos.
- Tareas y proyectos son independientes: un proyecto no exige crear tareas vinculadas.
- Fase de aprobacion separada del estado operativo: Propuesta, Pendiente de aprobacion, Aprobado y No aprobado. No confundir con En curso o Finalizado.

### Creacion

- Titulo breve obligatorio para identificar el expediente y su tarjeta.
- Descripcion y responsable general obligatorios.
- Fecha de creacion registrada automaticamente.
- Mantener el aislamiento y los permisos de comunidad acordados en el modulo 01.

### Seguimiento y responsabilidad

- Comentario de actualizacion y proximo responsable obligatorios.
- Proximo paso opcional: no impedir guardar por dejarlo vacio.
- Responsable general del expediente y responsable del proximo paso son conceptos distintos.
- Cambiar el proximo responsable no cambia automaticamente al responsable general.
- Los compromisos anteriores siguen pendientes aunque se anadan nuevos seguimientos, hasta resolverlos explicitamente.
- Fechas opcionales: registrar solo plazos conocidos y avisar de vencimiento cuando exista fecha.
- Un proximo paso vacio no inventa una accion ni borra compromisos anteriores.

### Cierre y trazabilidad

- Cualquier usuario con permiso de actualizacion puede finalizar un asunto.
- Comentario de cierre obligatorio.
- Historial, documentos y trazabilidad deben conservarse.
- Antes de finalizar, mostrar compromisos abiertos y exigir resolverlos o cancelarlos expresamente, dejando constancia.
- Reapertura permitida a usuarios con permiso de actualizacion, con motivo obligatorio e historial conservado.

### Interconexion e IA

- Mantener coherencia con Trabajo Hoy, notificaciones, presidencia e informes.
- La IA puede consultar y proponer acciones en todo el modulo, respetando permisos y comunidades.
- No guardar cambios sin revision y confirmacion del usuario.
- No interpretar esta autorizacion como aprobacion de automatizaciones nuevas fuera del modulo.

## Confirmacion final

1. Separar fase de aprobacion del proyecto de su estado operativo.
2. Definir el significado de dejar el proximo paso vacio: no modificar compromisos anteriores ni inventar uno.
3. Fechas de compromiso opcionales, sin inventar plazos; avisar de vencimiento solo si existe fecha.
4. Cierre con compromisos abiertos: exigir resolverlos o cancelarlos explicitamente, sin desaparicion silenciosa.
5. Reapertura con motivo por usuario autorizado, conservando el historial.

Las cinco reglas anteriores fueron confirmadas por el usuario mediante respuesta afirmativa el 08/09/2026. No quedan preguntas funcionales abiertas en este bloque. Cualquier ampliacion del alcance necesita nueva confirmacion.

## Contraste inicial con el codigo

- `server/index.js`, `writeEntityRecord`: invoca `close_pending_actions_for_entity` y `cancel_stale_pending_actions` al guardar seguimientos. Esta cancelacion/cierre implicito contradice conservar compromisos hasta resolverlos expresamente.
- `create_pending_action` descarta destinatarios que sean el propio usuario o que no sean usuarios activos. No basta para representar todos los compromisos, incluidos proveedores y los propios.
- El seguimiento exige comentario, pero el proximo responsable puede rellenarse por sustitucion automatica. Se debe validar y mostrar el responsable seleccionado antes de confirmar.
- En tareas, un proximo paso vacio recupera el anterior; en proyectos se registra vacio y el resumen usa observaciones. Hay que unificar el comportamiento sin convertir una nota antigua en un compromiso nuevo.
- La creacion valida titulo; debe reforzarse descripcion y responsable, conservando fecha automatica.
- No se identifica en el flujo revisado una fase independiente de aprobacion ni una comprobacion explicita de compromisos antes del cierre o un motivo especifico para reabrir. Verificar tambien edicion directa e importaciones para no dejar vias alternativas incoherentes.

## Alcance de implementacion propuesto

1. Datos y validaciones: fase de aprobacion independiente, campos obligatorios y separacion de responsables. Preservar datos antiguos; no inferir aprobaciones ni reconstruir compromisos cancelados sin evidencia.
2. Compromisos: identidad y estado propios, multiples pendientes por expediente, incluidos proveedores y el propio usuario. No cerrarlos por un simple seguimiento ni generar obligaciones solo porque se cambia un responsable.
3. Seguimiento, cierre y reapertura: proximo paso opcional, fechas conocidas, resolucion explicita de pendientes y motivo de reapertura con auditoria.
4. Interfaz e integracion: ficha, tarjetas, actualizacion manual y propuestas IA/importacion usan las mismas reglas; adaptar la informacion que reciben Trabajo Hoy e informes sin redisenar otros modulos.
5. Verificacion: copia previa, migracion probada sobre copia, pruebas HTTP y visuales en movil/escritorio; despliegue solo tras superar las comprobaciones.

## Pruebas de aceptacion

- No crear sin titulo, descripcion o responsable; fecha de creacion automatica y comunidad autorizada.
- Un proyecto propuesto admite presupuestos/documentos sin aparecer como aprobado; cambiar su estado operativo no cambia su aprobacion.
- Guardar seguimiento con comentario y proximo responsable, sin proximo paso ni fecha, conserva los pendientes anteriores.
- Cambiar el proximo responsable no altera al responsable general.
- Mantener varios compromisos simultaneos, incluidos proveedor y propio usuario, sin cancelaciones implicitas.
- No finalizar con compromisos sin tratar ni sin comentario de cierre.
- Reabrir exige motivo y conserva historial, adjuntos y decisiones previas.
- Las mismas restricciones se aplican a edicion, seguimiento, propuestas IA e importacion; no hay escrituras fuera de la comunidad autorizada.

## Siguiente trabajo tras cerrar definicion

- Contrastar el funcionamiento real y el almacenamiento con estos acuerdos.
- Presentar las diferencias, alcance y pruebas de aceptacion antes de implementar.
- Crear copia, corregir por bloques y verificar permisos, datos, historial, compromisos y vistas movil/escritorio.
- Documentar el cierre sin declarar completados otros modulos.

## Resultado implementado y limites

- Reglas compartidas en `server/work_domain.py`, llamadas desde creacion, edicion y seguimiento; las propuestas IA confirmadas usan esas mismas operaciones.
- La importacion historica guarda expediente y entradas en una sola transaccion. Los pasos historicos no se convierten todos en obligaciones actuales; solo se crea el compromiso actual revisado. Una fecha desconocida se identifica expresamente, no se presenta como fecha de la actuacion.
- Fase de aprobacion independiente en formulario, ficha, tarjeta e informe. Proyectos antiguos quedan sin clasificar; no se presume aprobacion.
- Cada compromiso mantiene responsable, plazo, estado y cierre propios. Incluye proveedores y el propio usuario. El solicitante ve tambien sus compromisos con proveedores en Trabajo Hoy.
- Resolver/cancelar exige comentario y deja historial y auditoria. No es una respuesta del presidente: las decisiones solo las responde el presidente asignado; gestion puede cancelar la solicitud expresamente.
- Cierre y reapertura validados en servidor. Cerrados/archivados recuperables mediante casilla en paneles. Se conserva historial y documentacion.
- Migracion conserva filas, indices y relaciones; permite registros de tareas sin proyecto.
- No se reconstruyen compromisos que versiones anteriores cancelaron, ni se corrigen aprobaciones antiguas sin evidencia.
- No se certifica aqui la comprension semantica de NVIDIA. El modulo 06 revisara importadores y Centro IA; esta entrega prueba contratos de confirmacion y permisos, sin consumo externo.
- Una importacion de varios expedientes sigue siendo un lote de operaciones independientes. La atomicidad nueva es por expediente con su historico, no por todo el lote.

## Verificacion local

- `scripts/verify-operational-release.mjs`: migracion sobre copia; roles/comunidades; crear, editar, seguir, resolver, cerrar, reabrir; aprobacion independiente; historico y presidencia; documentos/informes; regresiones de otros modulos.
- 22 scripts `assert-*.mjs` existentes superados.
- `scripts/verify-release-ui.mjs`: cinco vistas, 1440x1000 y 390x844, sin desbordamiento horizontal ni errores JS; formularios de tarea/proyecto y resolucion probados.
- Evidencia visual: `C:/Users/EQUIPO/AppData/Local/Temp/organizador-ui-release-G5wmax`.
- No usar los usuarios ni documentos de las bases de prueba en produccion.

## Cierre de entrega: 08/09/2026

- Validacion Ubuntu superada sobre copia de la base real: `/home/coordinador/apps/organizador-web/backups/stage-operational-20260908-121158`.
- Respaldo coherente justo antes de publicar: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260908-121158`, con `database.db`, codigo/documentos y hashes SHA256.
- Servicio `organizador-web.service` activo en puerto 8771; acceso Tailscale comprobado por navegador.
- Verificacion posterior de solo lectura: cinco usuarios activos, 24 consultas de perfil/rutas en total, integridad SQLite `ok`.
- No se ha modificado UNO Marbella, su servicio ni sus datos.
- Siguiente modulo: 03, Trabajo Hoy/mapa/dashboard; empezar con preguntas, sin nueva implementacion automatica.

### Recuperacion

Antes de revertir, detener solo `organizador-web.service`, crear otro respaldo del estado mas reciente y comprobar si existen entradas posteriores a esta entrega. Restaurar codigo y base como un conjunto coherente desde el respaldo anterior, verificando los hashes y la integridad SQLite; despues arrancar y ejecutar la verificacion de solo lectura. No restaurar una base antigua sobre trabajo posterior sin reconciliarlo con el usuario. `data/` y `backups/` no se borran en las actualizaciones.
