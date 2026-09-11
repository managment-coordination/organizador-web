# Modulo 04: Notificaciones y solicitudes al presidente

## Estado y alcance

Definicion confirmada por el usuario: 100%. Implementacion, pruebas y publicacion Ubuntu: 100% del alcance acordado. Pendiente aceptacion del usuario durante el uso real; no equivale a certificar toda la aplicacion.
El modulo 03 se omite por decision del usuario: sin eliminar ni redisenar Trabajo Hoy, mapa o dashboard.

## Acuerdos funcionales

- Regla ratificada el 11/09/2026: al confirmar un seguimiento cuyo siguiente responsable final sea Presidente, se crea automaticamente una solicitud al presidente asignado a la comunidad. Sustituye expresamente el acuerdo anterior que exigia siempre una solicitud separada y prohibia esta automatizacion. Incluye seguimientos propuestos por IA una vez revisados y confirmados, nunca durante la edicion o el analisis.
- La accion manual Solicitar decision sigue disponible para decisiones independientes. Crear o editar una ficha sin confirmar un seguimiento no genera una solicitud por asignar Presidente.
- Solicitud con decision requerida, contexto, documentos vinculados del expediente y plazo opcional.
- Presidente asignado a esa comunidad: Aprobar, Rechazar o Solicitar aclaracion; comentario obligatorio.
- Tras respuesta, quien solicito debe aclarar o registrar la gestion realizada. Leer avisos no completa esa gestion.
- Aclaracion en el mismo hilo: respuesta del solicitante, vuelta al presidente y conservacion de cada intervencion.
- Varias solicitudes independientes por expediente, sin cerrar unas al responder otras.
- Visibilidad prioritaria: accion pendiente, quien debe actuar, decision y plazo. Responsable general del expediente no cambia por una decision.
- Avisos nuevos por asignacion, respuesta o mencion explicita; no se notifica cada nota ordinaria.

## Datos y permisos

- `solicitudes_presidente`: estado de la decision, estado de gestion independiente, identidad del solicitante y presidente, plazo y version.
- `solicitudes_conversacion`: entradas cronologicas con usuario, fecha, comentario y referencias a documentos; no se sobrescriben respuestas anteriores.
- `acciones_pendientes.id_solicitud_presidente`: vinculo estable para resolver unicamente la accion de esa solicitud.
- Control de comunidad y rol en el servidor. Solo presidente destinatario responde. Solicitante o superusuario autorizado contesta aclaraciones y registra gestion.
- Un usuario con escritura puede cancelar una solicitud aun pendiente o en aclaracion, con comentario. No puede cancelar ni modificar una decision ya emitida.
- Cada transicion usa transaccion y version comprobada para evitar doble respuesta o cambios sobre una pantalla desactualizada.
- Menciones seleccionadas explicitamente entre usuarios internos de la comunidad; ningun texto ambiguo dispara notificaciones a otras comunidades.

## Migracion y conservacion

- Respaldo local `backups/before-module04-20260908.tar.gz`.
- Respaldo Ubuntu previo `/home/coordinador/apps/organizador-web/backups/before-module04-20260908-141720`, integridad comprobada.
- Migracion aditiva `presidency_v2`; conserva solicitudes, respuestas, documentos e historial existentes.
- Para solicitudes anteriores se incorpora la informacion conservada como entradas historicas. No se inventan conversaciones antiguas que no estaban almacenadas.
- Las acciones antiguas se vinculan solo si existe una coincidencia unica de expediente, destinatario y fecha de respuesta. Casos ambiguos no se fusionan automaticamente.
- Si un solicitante antiguo no se identifica por nombre, se conserva su nombre historico y el superusuario puede gestionar la solicitud; no se asigna a otra persona por aproximacion.
- No se reconstruyen automaticamente compromisos ya eliminados o cancelados en versiones antiguas.

## Pruebas

- `verify-operational-release.mjs`: migracion, permisos, solicitudes automaticas al confirmar seguimiento y explicitas con anexos, decisiones independientes, comentario obligatorio, hilo de aclaraciones, version obsoleta, lectura sin resolucion y menciones con aislamiento.
- `verify-release-ui.mjs`: cinco vistas en escritorio y movil; crear solicitudes, cancelarlas, pedir aclaracion como presidente, contestarla como solicitante, aprobar y registrar gestion.
- Evidencia visual: `C:/Users/EQUIPO/AppData/Local/Temp/organizador-ui-release-bjcOzW`.
- Los 22 contratos de regresion existentes se mantienen; estas pruebas no certifican la calidad semantica del modelo IA externo.

## Fuera de alcance

- Envio automatico de email, recordatorios programados y nuevas capacidades de razonamiento IA.
- Reorganizacion del dashboard omitida por el usuario.
- No se aprueba automaticamente la fase global de un proyecto cuando se aprueba una solicitud concreta: podria referirse solo a un presupuesto o una actuacion.
- No se aplican cambios a contabilidad, asambleas ni UNO Marbella.

## Continuidad

El siguiente modulo es 05: Informes y documentos. Empezar por preguntas de contexto antes de modificarlo.

## Cierre de entrega: 08/09/2026

- Validacion sobre copia de los datos reales: `/home/coordinador/apps/organizador-web/backups/stage-operational-20260908-175028`.
- Copia coherente inmediatamente anterior a la publicacion: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260908-175028`, base SQLite, codigo, documentos y hashes.
- Servicio `organizador-web.service`, puerto 8771: publicado y activo. Acceso Tailscale comprobado por navegador.
- Prueba posterior de solo lectura con los cinco usuarios reales: 28 rutas comprobadas, incluidas solicitudes, integridad SQLite `ok`.
- Recuperacion: conservar primero una copia de los datos mas recientes; detener solo este servicio y restaurar codigo/base coherentes desde el respaldo. No sobrescribir trabajo posterior sin reconciliarlo con el usuario. No borrar `data/` ni `backups/`.
- Sin cambios en UNO Marbella ni en su servicio o datos.

## Actualizacion puntual: 11/09/2026

- Reutiliza `create`, `append`, `notify` y `view` del modulo existente. No existe una segunda tabla/logica de solicitudes.
- Enlaces existentes `id_registro_tarea` / `id_registro_proyecto`: identifican el seguimiento que origina la solicitud, junto con expediente, comunidad, creador, fecha y destinatario.
- Decision solicitada: proximo paso del seguimiento; si no se indica, su comentario. Contexto: comentario completo confirmado. Plazo: fecha del proximo paso, si existe. No se extrae una peticion de textos antiguos de la ficha.
- Presidente/Presidencia son roles relativos a la comunidad, incluso si hay un usuario historico llamado Presidente en otra comunidad. Un nombre concreto de presidente debe corresponder al asignado a esa comunidad.
- Sin presidente asignado, permisos insuficientes o error al crear la solicitud/aviso: no se guarda parcialmente el seguimiento. Se informa al usuario para corregir y confirmar de nuevo.
- Seguimiento, solicitud, conversacion, notificacion y auditoria comparten `BEGIN IMMEDIATE`. La solicitud existente para un seguimiento se conserva, incluyendo decisiones ya emitidas; no se sobrescribe ni duplica.
- Migracion aditiva `presidency_followup_v1`: clave, huella y usuario de confirmacion en las dos tablas de seguimientos, con indices unicos. Sin entidades nuevas, reconstruccion de solicitudes antiguas ni cambios economicos.
- Las confirmaciones web conservan su clave durante reintentos; cambiar el contenido genera otra confirmacion. Reutilizar una clave con datos distintos se rechaza. Borradores IA y reuniones conservan ademas su idempotencia existente. Los clientes antiguos sin clave siguen siendo compatibles; deben enviarla para reintentos de una nueva insercion.
- Checkpoint previo: `president-followup-pre-20260911` (`d326d80`, que incluye login y descripcion).
- Backup previo: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260911-164501`; restauracion aislada `/tmp/organizador-erp0-restore-c66g43i0`, SQLite e inicio HTTP correctos.
- Pruebas de servidor y navegador: tarea/proyecto, responsable final distinto, cancelar confirmacion, solicitud enlazada, reintento tras respuesta perdida, peticiones concurrentes, comentario sin proximo paso, presidente de otra comunidad, permisos, auditoria y rollback ante fallo del aviso. Escritorio 1440 px y movil 390 px, junto a login y descripcion. Evidencias de publicacion se registran tras superar el gate Ubuntu.

### Publicacion conjunta verificada

- Codigo publicado: `de064928e43eabda69a1e6482dd4f56cae7bb1a7`; incluye `d326d80` (login y descripcion). GitHub actualizado. Servicio `organizador-web.service`, puerto 8771, activo.
- Gate sobre copia: `backups/stage-operational-20260911-165606`. Regresiones ERP 0/1/2/3 superadas; 22 bloques operativos (incluidos modulos 02 y 04) antes y despues de publicar, y 42 casos del nucleo economico en ambas comprobaciones. Historial economico y asambleas conservan sus hashes.
- Antes de publicar: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260911-170027`, restauracion aislada `organizador-erp0-restore-2hgva1dg`, arranque HTTP correcto. El manifiesto automatico anterior indica commit desconocido porque produccion no es un checkout Git; no se atribuye al nuevo commit.
- Backup final: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260911-170342`; restauracion aislada `organizador-erp0-restore-ivn390f1`, 166 tablas, integridad y arranque HTTP correctos, sin errores FK. Ambas restauraciones estan dentro de `stage-operational-20260911-165606/verification-temp/`.
- Evidencia automatica de despliegue en el backup final: `erp3-publication-proof.json` (nombre conservado por el procedimiento existente; esta entrega no modifica ERP 3).
- Navegador: siete bloques verificados a 1440/390 px; evidencias locales `C:/Users/EQUIPO/AppData/Local/Temp/organizador-login-description-72DOeB`. Acceso Tailscale y login publicado verificados en ambos anchos (`organizador-live-followup-djvPlc`).
- Smoke de solo lectura con los cinco perfiles reales: 28 rutas correctas e integridad SQLite `ok`. No se han creado seguimientos ni solicitudes de prueba en produccion. No se ha tocado UNO Marbella.
- Las pestanas que estuvieran abiertas deben recargarse para utilizar los nuevos mensajes, descripcion y claves de confirmacion del cliente.
