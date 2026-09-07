# Cierre operativo: usuarios, roles y comunidades

## Alcance

Estabilizacion del modulo 01 y de sus permisos transversales. No equivale a completar los diez modulos del roadmap ni garantiza interpretaciones infalibles de IA.

## Cambios

- Permisos por usuario y comunidad, con acceso operativo o Consulta, documentos, informes, asambleas y revision de Seguridad.
- Presidente identificable por su nombre y asignado a una comunidad; solicitudes dirigidas por identificador, no por el nombre literal Presidente.
- El presidente no accede a informes ni a administracion. Abre el expediente y adjuntos de solicitudes pendientes dirigidas a el.
- Solo Superusuario administra usuarios y comunidades. Los cambios de acceso se comprueban en cada peticion; desactivar o resetear invalida la sesion.
- Primer acceso con clave temporal, hash de contrasena, auditoria e intentos fallidos sin bloqueo automatico.
- Contabilidad historica y partes antiguos identificados con Macrocomunidad San Roque Club. Consultas filtradas por comunidad.
- Seguridad puede cargar partes y utilizar su consulta autorizada; la revision requiere permiso en esa comunidad.
- Memoria e historial IA limitados al alcance que origino la conversacion. Entradas antiguas sin alcance verificable se conservan pero no se reutilizan.
- JSON convertido correctamente a Python, incluidos null/false; corregido el guardado de preferencias de redaccion.
- Nuevas tareas independientes de proyectos. Se conservan las relaciones historicas existentes y todos los registros.
- Adjuntos, informes y metadatos documentales sujetos a permisos. No se cambia la comunidad de una asamblea existente con su informacion vinculada.

## Verificacion

`node scripts/verify-operational-release.mjs` trabaja exclusivamente sobre una copia temporal y comprueba:

1. Migracion sin cambios en recuentos ni nuevas relaciones rotas.
2. Primer acceso y claves temporales.
3. Limites de roles y endpoints principales.
4. Tareas independientes y permisos de escritura por comunidad.
5. Solicitudes a presidentes, comentario obligatorio, no duplicacion y retorno de responsabilidad.
6. Subida y apertura de adjuntos; generacion y descarga Word.
7. Partes de Seguridad y deduplicacion separados por comunidad.
8. Seleccion de comunidad y ausencia de fuga contable entre comunidades.
9. Creacion y edicion de asamblea y orden del dia.
10. Respuesta del Centro IA, persistencia del contexto y aislamiento de preferencias.
11. Revocacion tras desactivar/resetear y recuperacion tras intentos incorrectos.

La bateria `assert-*.mjs` combina comprobaciones estaticas con consultas reales. No sustituye a la anterior prueba HTTP.

`verify-release-ui.mjs` exige una base temporal creada por la prueba anterior. Verifica acceso y cinco vistas en 1440x1000 y 390x844; guarda capturas fuera del repositorio. Requiere Playwright y navegador Edge. No instala dependencias en la aplicacion.

## Uso del Superusuario

1. Administracion > seleccionar usuario > comunidades asignadas.
2. En cada comunidad definir su acceso y permisos; guardar.
3. Para un nuevo presidente: crear su usuario con nombre real y rol Presidente, asignarle comunidad y facilitar la clave temporal.
4. Seleccionar la comunidad en Administracion y comprobar su presidente asignado.
5. Resetear contrasenas desde el usuario genera una clave temporal nueva; nunca muestra la contrasena anterior.

No se renombra al presidente existente sin confirmar su identidad. La migracion conserva su usuario y asignacion.

## Limites y continuidad

- El Centro IA se prueba en modo local para esta regresion: esta prueba no certifica calidad de respuestas NVIDIA, reuniones largas ni disponibilidad del proveedor externo.
- Outlook conectado, importacion bancaria web completa y cambios de titularidad guiados siguen siendo fases pendientes, no funciones completadas por este cierre.
- La contabilidad historica se conserva; nuevas importaciones deben aportar comunidad explicita. No usar el escritorio antiguo para modificar simultaneamente esta base web.
- Continuar con las preguntas del modulo 02 antes de una nueva ampliacion funcional.
- El porcentaje comunicado corresponde al cierre de esta entrega, no a toda la vision futura de la aplicacion.

## Despliegue y vuelta atras

Publicado y verificado en `http://100.108.29.39:8771/` y localhost del servidor. La prueba ampliada tambien paso en Ubuntu sobre copia del estado real; las consultas de verificacion de los cinco usuarios activos y `PRAGMA integrity_check` pasaron tras publicar.

Copia previa: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260907-222059/` (nombre en UTC). Contiene `database.db`, `application-and-documents.tar.gz` y `SHA256SUMS.json`. No contiene datos sinteticos de las pruebas. Las capturas de cinco vistas en escritorio y movil se comprobaron sobre una copia aislada.

Conservar `.env`, `data/`, `backups/` y dependencias de servidor. Probar primero una copia en Ubuntu. Antes de sustituir codigo, parar solo `organizador-web.service` y obtener una copia consistente de base y documentos.

Para restaurar, detener ese servicio, conservar una copia del estado fallido y recuperar codigo y base de la misma copia de seguridad. Una restauracion posterior al uso real necesita conciliar antes cualquier entrada nueva: no sobrescribir datos posteriores silenciosamente.

No modificar UNO Marbella, su servicio, puerto ni sus datos.
