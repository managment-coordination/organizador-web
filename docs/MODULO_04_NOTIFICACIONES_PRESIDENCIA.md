# Modulo 04: Notificaciones y solicitudes al presidente

## Estado y alcance

Definicion confirmada por el usuario: 100%. Implementacion, pruebas y publicacion Ubuntu: 100% del alcance acordado. Pendiente aceptacion del usuario durante el uso real; no equivale a certificar toda la aplicacion.
El modulo 03 se omite por decision del usuario: sin eliminar ni redisenar Trabajo Hoy, mapa o dashboard.

## Acuerdos funcionales

- Solicitar decision es una accion explicita desde la ficha. Seleccionar al presidente como responsable no envia una solicitud, ni la IA puede hacerlo indirectamente al guardar un seguimiento.
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

- `verify-operational-release.mjs`: migracion, permisos, ausencia de solicitud implicita, solicitud explicita con anexos, decisiones independientes, comentario obligatorio, hilo de aclaraciones, version obsoleta, lectura sin resolucion y menciones con aislamiento.
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
