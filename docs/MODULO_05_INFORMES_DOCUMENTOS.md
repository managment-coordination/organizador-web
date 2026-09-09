# Modulo 05 - Informes y documentos

## Alcance confirmado

Revision confirmada por el usuario. Informes operativos para presidencia, directiva y reuniones generales, en Word. Eleccion ejecutivo/completo, siempre sobre todo el historial. Una tarea o proyecto, o seleccion de expedientes independientes de una misma comunidad. No modificar contabilidad ni actas de asamblea.

Categorias: Presupuesto, Factura, Contrato, Informe tecnico, Fotografia, Otro. Documentos anteriores permanecen Sin clasificar. La clasificacion no cambia su archivo, autor, fecha ni vinculacion al seguimiento.

## Estado al 09/09/2026

- Definicion: 100%.
- Implementacion base y publicacion: 100% de los controles documentales y de generacion descritos aqui; no equivale al cierre completo del modulo. Aceptacion funcional y calidad editorial con expedientes reales pendientes.
- Publicado en Ubuntu, puerto 8771. Verificacion posterior de solo lectura: 5 perfiles, 28 rutas, integridad SQLite OK. Acceso de navegador por Tailscale comprobado.
- Pruebas: 15 grupos de integracion sobre copia aislada local y sobre copia actual de produccion en Ubuntu; 23 scripts de regresion sin fallos; interfaz en 1440x1000 y 390x844.
- Word: apertura real con Word de informes ejecutivo, completo y conjunto, aplicando membrete oficial. Renderizado de paginas e inspeccion visual.
- No se considera cerrado todo el roadmap ni revisado el modulo 03, omitido por el usuario.

## Funcionamiento

1. Desde una ficha o una tarjeta se pulsa Generar informe. Se abre una sola ventana de configuracion, con formato y documentos seleccionables.
2. En el centro de informes se seleccionan tareas/proyectos y se abre la misma configuracion. Limite operativo actual: 40 expedientes de una comunidad por informe; la seleccion de anexos no puede incorporar documentos de otro expediente.
3. Ejecutivo: objeto, estado actual, hitos del historial sin duplicados exactos, responsables, compromisos pendientes, proximo paso vigente y conclusion. Los hitos son una seleccion determinista de apertura, ultima actuacion, decisiones y cambios de estado. No es una nueva sintesis semantica por IA.
4. Completo: incluye ademas TODOS los seguimientos en orden cronologico con autor, fecha, comentario, cambio de estado y paso propuesto en aquella fecha. Comentarios en parrafos, nunca dentro de columnas estrechas. Se normalizan espacios y saltos, sin reescribir lo almacenado.
5. El campo de observaciones historicas acumuladas NO se reutiliza como proximo paso vigente. En expedientes cerrados, los pasos antiguos no se presentan como pendientes actuales. Compromisos aun pendientes se muestran como discrepancias a revisar.
6. Cada Word genera un archivo unico, una fila nueva en informes, auditoria y una instantanea de sus entidades, historiales, compromisos y anexos elegidos, con autor, fecha y SHA256. Reclasificar documentos o actualizar el expediente no modifica una version previa.
7. Los informes individuales de tareas y los conjuntos se encuentran tambien desde la ficha correspondiente. Corregida la colision JavaScript entre los botones de generar informe individual y conjunto.
8. Documentos del expediente: busqueda por nombre/tipo, filtro de categoria, presupuestos/facturas/contratos primero. Clasificacion editable solo con permiso de actualizacion. Consulta/Presidente no pueden reclasificar.
9. Subida directa desde ficha y subida rapida desde tarjetas permiten indicar categoria. Los puntos de entrada antiguos que no la envien conservan Sin clasificar; no se inventa el tipo por el nombre.

## Plantillas y archivos

- Plantillas privadas por comunidad en `data/report-templates/ID_COMUNIDAD.docx`. No se suben a GitHub.
- Macrocomunidad: plantilla oficial suministrada por el usuario, ID 1. No se aplica su identidad a otras comunidades.
- Se conservan membrete, imagen, pie, margenes y marco; los estilos del contenido se mantienen independientes. Tratamiento ZIP/XML con biblioteca estandar, sin automatizacion de Office en el servidor.
- Seleccionar anexos no elimina los excluidos. PNG/JPEG se incorporan respetando proporciones. El resto se identifica como referencia documental al original conservado en la ficha; no se afirma que el PDF/Word este incrustado cuando no lo esta.
- Limitacion explicita: no hay conversion/incrustacion de todos los formatos externos dentro del Word. Tampoco se ha reactivado la conversion de informes a PDF que el usuario pidio retirar.
- La aceptacion de calidad de redaccion con expedientes reales largos queda pendiente del usuario. No se presenta una seleccion de hitos por reglas como una redaccion inteligente avanzada.

## Seguridad y pruebas

- Migracion `documents_v1` anade una columna con valor por defecto; conserva filas y enlaces. Idempotente.
- Aislamiento por comunidad y permisos comprobados en subir, clasificar, listar, incluir anexos, generar y descargar.
- Presidente mantiene la exclusion de informes; documentos sujetos a sus permisos y al contexto autorizado. No se ha ampliado su acceso.
- Auditoria de clasificacion: categoria anterior/nueva, documento, usuario y PC.
- `scripts/verify-operational-release.mjs`: migracion sobre copia, autenticacion real, dos comunidades, roles, Word individual/conjunto, seleccion de anexos, versiones y auditoria.
- `scripts/assert-module05-reports.mjs`: ambos formatos, cronologia completa, pasos antiguos, relaciones de plantilla y archivos Word de prueba.
- `scripts/verify-release-ui.mjs`: crear, actualizar, solicitudes, subir documento, filtrar, elegir formato/anexos, generar y descargar Word, escritorio/movil.
- `scripts/render-report-qa.ps1`: SOLO directorios temporales de pruebas; Word local oculto para comprobacion visual. Nunca se usa en el servidor ni en el flujo del usuario.

## Respaldo y continuidad

Respaldo previo local: `backups/before-module05-20260908.tar.gz`.
Respaldo previo servidor: `/home/coordinador/apps/organizador-web/backups/before-module05-20260908-181056/` (SQLite backup con integridad OK y archivo de codigo/documentos).
Antes de publicar, el procedimiento crea un segundo respaldo fresco con la app detenida, y valida previamente una copia actual de produccion. No toca UNO Marbella.

Segundo respaldo fresco anterior al despliegue: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260908-231231/`, con SQLite y codigo/documentos, mas SHA256. Fecha del servidor en UTC; publicacion local el 09/09/2026.

Pendiente inmediato: validar con el usuario un informe ejecutivo y otro completo de un expediente real largo, comprobar la utilidad de la clasificacion y decidir el cierre editorial. La sintesis narrativa avanzada y la incrustacion completa de otros formatos NO se certifican como realizadas. El siguiente modulo del roadmap es 06 (importadores y Centro IA), empezando por preguntas; no avanzar automaticamente a el.
