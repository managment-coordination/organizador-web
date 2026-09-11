# ERP 1 - Datos maestros: implementacion

Estado: COMPLETADO, 10/09/2026. Implantacion certificada: 100% de ERP 1. [Roadmap ERP](ERP_COMUNIDADES_ROADMAP.md) | [Modelo maestro](ERP_MODELO_DATOS_MAESTROS.md) | [Titularidades, coeficientes y reparto](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md).

ERP 1 identifica y conserva comunidades, ejercicios, agrupaciones, propiedades, propietarios, contactos, titularidades, coeficientes y grupos. No implementa presupuestos, cuotas, recibos, SEPA ni contabilidad de ERP 2-7.

## Linea base, checkpoints y backups

- Linea base estable: commit `1a947d63f8c069d864ca851fdefd6c6d0ffecdc1`; tag recuperable `pre-erp1-20260910-1a947d6`.
- Checkpoint de dominio inicial: `eeb99e9`.
- Checkpoint estable de los bloques 1-3: tag `erp1-post-blocks-1-3-20260910`.
- Checkpoint estable de titularidades: tag `erp1-post-ownership-20260910`.
- Checkpoint estable de coeficientes y grupos: tag `erp1-post-coefficients-groups-20260910`.
- Los tres checkpoints estructurales apuntan a `adfc3d3`: la migracion de esquema es atomica y no se modificaron datos de produccion entre esos bloques.
- Compuerta de despliegue: commit `9930083b9bc293984348e899cde5a3d1f6af9ece`.
- Backup previo verificado: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-111627`.
- Backup inmediato del publicador: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260910-122115`.
- Backup posterior completo: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-122302`.
- El backup posterior supero checksum, integridad, recuentos, migracion reentrante, sintaxis y arranque HTTP aislado con el codigo asociado.

El nombre historico `erp0-backup-v1` identifica el formato reutilizable del backup, no limita su contenido a ERP 0. Git no contiene la base ni sustituye estos respaldos.

## Migracion y datos conservados

La migracion versionada `2 / erp1_master_data` se ejecuto primero sobre copia real y despues en produccion. Es reentrante, usa checksum y comprueba `foreign_key_check` antes de confirmar. La reconstruccion necesaria de `cf_propiedades` y `cf_propietarios` conserva IDs y columnas legacy, elimina unicidades globales incompatibles y aplica claves naturales por comunidad.

Resultado productivo tras migrar:

| Control | Resultado |
|---|---:|
| Integridad SQLite | `ok` |
| Violaciones FK | 0 |
| Comunidades | 3 |
| Propiedades | 703 |
| Propietarios | 535 |
| Contactos | 1.151 |
| Relaciones propietario-propiedad | 703 |
| Recibos conservados | 16.289 |
| Filas de censo de asamblea conservadas | 703 |
| Tablas totales | 91 |

No se inventaron ejercicios ni agrupaciones a partir de nombres legacy: comienzan vacios hasta que se creen o acrediten. Los 703 coeficientes existentes se proyectaron en un unico grupo `LEGACY_GENERAL`, en estado de preparacion y calidad observada. Las 703 titularidades legacy se conservaron igualmente como observadas. Sus fechas de conocimiento proceden de la importacion cuando existe; en otro caso, de la fecha de migracion. Ningun valor heredado se declara validado sin evidencia.

## Bloques implementados

1. Comunidades ampliadas, configuracion versionada, ejercicios y bloqueos de periodo.
2. Agrupaciones jerarquicas, tipos configurables, propiedades, alias, relaciones y pertenencias estructurales.
3. Propietarios aislados por comunidad, persona fisica/juridica/desconocida, contactos tipados, verificacion y vigencia.
4. Titularidades N:M con propuestas revisables, composicion completa o incompleta, intervalos `[desde, hasta)` y doble tiempo efectivo/conocido.
5. Series y versiones de coeficientes en decimal exacto almacenado como texto canonico; el `REAL` legacy queda solo como proyeccion de compatibilidad.
6. Grupos de reparto configurables, versiones y pertenencias historicas. No existe todavia motor de reparto.
7. Procedencia de registros, referencias de importacion y enlaces documentales maestros.
8. Consultas y comandos deterministas mediante contratos allow-listed de ERP 0.
9. Interfaz web minima en `Herramientas > Datos maestros`, operativa en escritorio y movil.
10. Compatibilidad verificada con acceso, tareas, proyectos, presidencia, documentos, informes, seguridad, asambleas y Centro IA.

## Reglas operativas y seguridad

- Todo dato maestro pertenece a una comunidad; un codigo se puede repetir en otra comunidad sin colision.
- Los propietarios de comunidades distintas no se fusionan por nombre, NIF, email ni similitud.
- Lecturas y escrituras revalidan sesion y permiso de comunidad en backend.
- Cada comando exige clave de idempotencia y las ediciones exigen version esperada.
- Cambio, auditoria y outbox se confirman en la misma transaccion `BEGIN IMMEDIATE`.
- Una composicion completa validada suma exactamente 100; una suma superior se rechaza y una parcial permanece explicitamente incompleta.
- Confirmar una titularidad no mueve deuda, no altera recibos y no reescribe asambleas o informes historicos.
- La interfaz no expone SQL general; el dispatcher solo admite comandos y consultas registrados.

## Pruebas y evidencias

`scripts/verify-erp1-master-data.py` cubre los escenarios obligatorios de dominio: varias propiedades por titular, copropiedad 60/40, venta efectiva, consultas 30/06 y 01/07, obligado historico intacto, exceso 110 bloqueado, cobertura parcial, idempotencia de importacion, correccion bitemporal, fecha incierta, varios coeficientes, salida de grupo, codigos aislados, anexos independientes, concurrencia, permisos, asamblea inmutable y restauracion. Tambien comprueba contactos, auditoria, outbox y operaciones masivas de grupos.

`scripts/verify-operational-release.mjs` supero 19 grupos de regresion sobre una copia con forma de produccion. `scripts/verify-release-ui.mjs` supero las vistas principales, incluida Datos maestros, a 1440x1000 y 390x844 sin desbordamiento de pagina. El despliegue repitio las pruebas ERP 1 y la regresion antes de publicar.

## Incidencias resueltas

- El primer paquete fue rechazado por contener raices no admitidas. La barrera funciono antes de cualquier publicacion; se genero un paquete limitado al alcance permitido.
- El primer ensayo detecto que la prueba de recuentos no exceptuaba el libro de migraciones ERP. Se corrigio para exigir que las migraciones anteriores sean subconjunto inmutable y permitir unicamente nuevas filas versionadas.
- La interfaz limitaba los selectores a 150 registros. Se amplio el servicio y la pantalla a 1.000, suficiente para los 703 inmuebles y 535 propietarios actuales, y se muestran totales reales.

## Compatibilidad y limites

Los lectores antiguos mantienen sus tablas e IDs. Los campos `coeficiente REAL` y `porcentaje_titularidad REAL` se conservan como compatibilidad temporal, pero ningun calculo nuevo debe usarlos. Las asambleas siguen usando sus snapshots y la deuda conserva su obligado historico.

### Ajuste UX de contactos - 10/09/2026

La ficha del propietario presenta `Email` y `Telefono` como campos directos, junto con `Telefono alternativo / movil`, `Direccion de contacto` y otros valores habituales cuando existen. Los contactos adicionales se crean desde la accion plegada `+ Añadir contacto`, que conserva la seleccion de tipo solo para ese caso excepcional.

El ajuste no modifica ni duplica el modelo `cf_contactos_propietario`: cada campo edita o desactiva su misma fila mediante el comando normalizado, version esperada, permiso de comunidad, auditoria y procedencia. Al cambiar un valor previamente verificado, el nuevo valor queda pendiente de verificar. Los contactos inactivos permanecen consultables como historico.

La persistencia, ausencia de duplicado, permisos y regresion se comprobaron mediante `verify-erp1-master-data.py`, `verify-operational-release.mjs` y el recorrido Playwright de `verify-release-ui.mjs` en escritorio y movil.

### Ajuste UX de propiedades - 10/09/2026

El formulario ordinario de alta y edicion ya no solicita `Estado` ni `Calidad`. Una propiedad creada manualmente por un usuario autorizado nace como `Activa` y `Validada`; una edicion posterior conserva ambos valores salvo que el usuario ejecute una accion especifica. El estado y la calidad se muestran como indicadores en la ficha, sin trasladar al usuario la complejidad tecnica del modelo.

Los estados conservan finalidades distintas: `Activa` participa en la operativa normal; `Preparacion` identifica datos aun no activados; `Inactiva` suspende temporalmente la participacion operativa; y `Baja` representa el cese documentado. Los dos estados intermedios solo se muestran cuando ya existen y permiten activar la propiedad. La baja se gestiona como accion excepcional plegada, con fecha y motivo obligatorios, y puede revertirse mediante una reactivacion confirmada.

La calidad sigue siendo una propiedad normalizada del dato: la creacion manual confirmada queda `Validada`, una importacion sin revision permanece `Observada` y un conflicto identificado queda `Pendiente de revision`. Estas dos ultimas situaciones generan un aviso contextual y una accion explicita de validacion. Editar un dato observado no lo valida implicitamente. Se mantienen procedencia, control de version, permisos, auditoria e historico; no se ha modificado el esquema ni se han duplicado campos.

Este ajuste se verifica en servicio y navegador: alta manual con valores automaticos, edicion sin alterarlos, persistencia, permisos y representacion responsive en escritorio y movil.

### Ajuste UX de propietarios y titularidades - 10/09/2026

La titularidad deja de presentarse como una entidad tecnica de navegacion cotidiana. Desde una propiedad se consultan los `Propietarios actuales`, se abre directamente cada propietario y se utiliza `Gestionar propietarios` para preparar un cambio o una copropiedad. El asistente permite seleccionar propietarios existentes, crear uno nuevo, indicar fecha efectiva y porcentajes, vincular el origen documental y revisar la composicion completa antes de confirmar. La ficha traduce los intervalos internos a fechas comprensibles y conserva un `Historico de propietarios` separado.

La ficha de propietario deriva del mismo dominio sus `Propiedades actuales`, `Propiedades anteriores` y, cuando existen, cambios futuros programados, con navegacion directa en ambos sentidos. No se ha creado una relacion alternativa propietario-propiedad ni se ha eliminado la consulta avanzada: permanecen las versiones, el tiempo efectivo y de conocimiento, la procedencia, la calidad, la idempotencia y la auditoria. Los datos tecnicos se muestran solo ante una incidencia o en el detalle avanzado.

La confirmacion sigue ejecutando el comando transaccional normalizado de titularidades. Cambiar propietarios no mueve deuda, no modifica recibos historicos, no altera censos o asambleas y no reasigna responsabilidad economica.

### Ajuste UX de coeficientes y grupos - 10/09/2026

Los grupos se crean con terminologia operativa: `Porcentaje`, `Peso relativo` o `Sin coeficiente`. La base extensible `Otro` permanece soportada internamente, pero no se ofrece en el flujo habitual al no tener todavia un comportamiento economico definido. Para porcentajes se declara el total esperado, normalmente 100; esta configuracion describe la participacion y no anticipa reglas de reparto de ERP 2.

`Gestionar propiedades` abre una unica operacion masiva con busqueda, filtros por tipo, agrupacion, bloque y planta, seleccion de todas las filas visibles y edicion conjunta de coeficientes o pesos. En grupos sin coeficiente basta con seleccionar miembros. El total se calcula con aritmetica decimal exacta y muestra suma, pendiente o exceso permanentemente; nunca normaliza ni distribuye diferencias de forma automatica.

La accion `Pegar datos` admite filas `codigo de propiedad + valor`, busca solo coincidencias exactas dentro de la comunidad activa y presenta una vista previa con codigos inexistentes, duplicados y valores invalidos. Ninguna coincidencia dudosa se aplica. Antes de guardar se resume el numero de altas, bajas y modificaciones y la suma final.

La operacion masiva exige comunidad explicita, permiso backend, version esperada e idempotencia, y confirma miembros, coeficientes, auditoria y outbox en una sola transaccion. Un error produce rollback completo. Las bajas cierran la vigencia sin borrar el historico y cada coeficiente especial conserva su propia serie: editar jardines, por ejemplo, no altera el coeficiente general.

Desde una propiedad se muestran todos los grupos de la comunidad, indicando participacion y valor actual. Desde el grupo se ven tipo, estado, participantes, suma exacta, tabla de propiedades e historico, mientras las versiones tecnicas quedan en un detalle avanzado. Este ajuste no calcula presupuestos, cuotas, derramas, recibos ni repartos economicos.

Las pruebas de ERP 1 incorporan propietario unico, copropiedad, cambio efectivo, historico bidireccional, aislamiento por comunidad e inmutabilidad de deuda y asambleas; tambien cubren 40 propiedades, seleccion masiva de 16, suma exacta, exceso y defecto, peso, pertenencia sin coeficiente, coexistencia de coeficientes, baja historica, rollback, permisos y pegado revisable. El recorrido Playwright valida los flujos principales en escritorio y movil.

### Ajuste UX de estructura de propiedades - 10/09/2026

El dominio `erp_agrupaciones` se presenta como `Estructura de propiedades` en una pestaña propia, independiente de Comunidad/Ejercicios y de Coeficientes y grupos. Su finalidad visible es organizar opcionalmente inmuebles por fases, bloques, portales, zonas u otras divisiones fisicas. Una comunidad sin estructura adicional conserva toda la operativa de propiedades, propietarios, coeficientes y grupos.

La pantalla ordena las divisiones como un arbol padre-hijo y muestra rutas comprensibles como `Fase 1 > Bloque A`, propiedades asignadas directamente y total incluido en cada rama. La creacion y edicion seleccionan el elemento padre por nombre y ruta, sin exponer IDs. `Gestionar propiedades` permite buscar, filtrar, seleccionar varias filas, revisar altas y retiradas y confirmar la operacion completa en una unica transaccion con permiso de comunidad, idempotencia, version esperada, auditoria y rollback.

La ficha de propiedad muestra `Ubicacion / estructura` solo cuando existe una pertenencia actual. Los intervalos conservan su vigencia; retirar una propiedad finaliza la pertenencia sin alterar periodos anteriores. Los grupos de reparto pueden utilizar cualquier nodo, incluidos sus descendientes, como filtro de seleccion masiva, pero nunca se crea un grupo economico ni se modifica un coeficiente por pertenecer a una estructura.

No se ha modificado el esquema ni se ha implementado ERP 2. Las pruebas cubren comunidad sin estructura, division simple, jerarquia Fase > Bloques, asignacion masiva, rutas y filtros derivados, vigencia, permisos, rollback, inmutabilidad de coeficientes y grupos, escritorio y movil.

La interfaz es deliberadamente la minima de ERP 1: alta/edicion y consulta de maestros, historicos, coeficientes y grupos. Las reglas economicas pertenecen a ERP 2. Antes de cualquier siguiente cambio estructural siguen siendo obligatorios checkpoint Git, backup independiente de SQLite y restauracion ensayada.

## Estado final

ERP 1 queda operativo y desplegado en el servidor Ubuntu en el puerto 8771. No quedan decisiones funcionales bloqueantes dentro de su alcance aprobado. El siguiente trabajo recomendado es definir y autorizar ERP 2 sobre estos maestros, sin reinterpretar los datos observados como evidencia validada.

## Revision UX transversal y onboarding - 11/09/2026

Se adopta el estandar permanente [ERP UX](ERP_UX_PRINCIPIOS.md). `Datos maestros` incorpora `Configuracion inicial`, un asistente revisable para importar propietarios y propiedades desde plantillas descargables o Excel/CSV propios. Detecta cabeceras, propone su correspondencia, permite corregirla, conserva el archivo por hash y utiliza staging antes de confirmar. Las coincidencias son exactas dentro de la comunidad; NIF en conflicto, propietario inexistente, copropiedad distinta de 100, tipo desconocido o coeficiente incoherente bloquean la confirmacion.

La confirmacion escribe en `cf_propietarios`, `cf_contactos_propietario`, `cf_propiedades`, titularidades y series/grupos ERP 1 existentes. No existe un maestro alternativo. La migracion aditiva `6 / erp1_onboarding_staging` solo conserva importaciones, filas, incidencias, decisiones y trazabilidad. La reimportacion del mismo archivo confirmado es idempotente.

Los grupos se inician ahora desde `¿Como se reparte?`: Por coeficiente, A partes iguales, Por peso relativo o Configuracion avanzada. Por coeficiente permite reutilizar una serie existente o crear una especial; la gestion posterior conserva busqueda, filtros estructurales, seleccion masiva, pegado tabular y una unica tabla exacta de valores y sumas. Coeficientes generales y especiales siguen siendo independientes.

La ficha de propiedad presenta `¿Tiene inquilino?` como eleccion directa y solo revela sus campos al responder Si. Destinatario/pagador, ciclos de vida, alias, relaciones y detalle avanzado quedan plegados cuando no son necesarios. IDs y versiones internas dejan de mostrarse en el flujo ordinario, sin modificar el modelo.

### MEJORAS UX AUTÓNOMAS

- La propia plantilla reconoce automaticamente sus encabezados, incluidos nombres con preposiciones.
- Las columnas de pertenencia interpretan `No`, `0` y `Falso` como ausencia y nunca como alta accidental.
- Una carga requiere permiso de actualizacion antes de almacenar el archivo y exige mapear los campos obligatorios antes de crear staging.
- El asistente ofrece coeficientes existentes antes de crear otro, reduciendo duplicados conceptuales.

La verificacion `verify-erp-ux-onboarding.py` cubre migracion reentrante, propietarios/contactos, reimportacion, propiedades, titularidades, coeficiente especial, incidencias, permisos e invariabilidad economica ERP 2. Playwright recorre onboarding, propietarios, contactos, titularidades, estructuras y grupos en 1440x1000 y 390x844.

## Correccion de recorte movil y analisis de Excel propio - 11/09/2026

- Checkpoint previo: `ux-mobile-onboarding-pre-20260911`, commit `ca4dab7`. Sin migraciones ni cambios de dominio, permisos, datos maestros o calculos.
- Causa reproducida: la pista implicita del grid de Datos maestros se ensanchaba por el ancho minimo de la barra de pestañas. En 390 px, un panel ocupaba 697,97 px. `overflow-x:hidden` en el documento ocultaba el sobrante y hacia que la comprobacion anterior de `document.scrollWidth` no detectara el recorte.
- Se limitan las pistas y anchos minimos de contenedores, etiquetas y selectores ERP 1/2. Las tablas mantienen desplazamiento local; las pestañas mantienen navegacion horizontal contenida. No se ocultan datos para ajustar el ancho.
- El analisis muestra columnas, numero de filas y ejemplos; lleva el foco al resultado o a un error visible. Conserva el archivo, mapeo manual y fecha efectiva; evita reutilizar resultados al cambiar de comunidad. Una nueva seleccion invalida la vista previa anterior. El analisis tiene limite de espera y permite reintentar.
- MEJORA UX AUTONOMA: aviso cuando se carga una tabla de propiedades en el paso Propietarios y accion explicita para analizarla en el paso correcto. Los nombres de propietarios no se convierten en codigos ni se vinculan por similitud.
- El Excel comunicado por el usuario pudo analizarse en servidor aislado: tres columnas y 40 filas; no se confirmo su importacion. Un archivo con nombres pero sin identificadores estables sigue necesitando correspondencia documentada con propietarios existentes. Formatos de este flujo: `.xlsx` y `.csv`; `.xls` muestra una indicacion de conversion, no se anuncia como soportado.
- `scripts/verify-onboarding-mobile.mjs`: reproduccion anterior fallida y comprobacion posterior en 360, 390 y 1440 px; analisis de tabla no basada en plantilla; ejemplos; cambio de tipo explicito; mapeo conservado tras error; ausencia de confirmacion ante campos requeridos incompletos; errores de sesion/formato; reintento; limpieza al cambiar de comunidad. Admite verificacion privada opcional del archivo comunicado, sin incorporarlo al repositorio.
- `scripts/verify-release-ui.mjs` comprueba ahora limites geometricos de paneles ademas del ancho del documento, para evitar un falso positivo cuando el CSS oculta el desbordamiento.
- Publicacion: cambio `21edf01`, checkpoint de cierre `ux-mobile-onboarding-certified-20260911`. Pruebas UI completas en 1440x1000 y 390x844 (siete vistas), pruebas especificas en 360/390/1440 y regresiones ERP 0/1/2, onboarding y recorrido operativo superadas. El analisis no confirmo la importacion del archivo real.
- Backup de publicacion: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260911-054202`; checksums comprobados y SQLite restaurado aisladamente en `backups/restore-ux-mobile-jpk3mz9g/restored.db`, integridad correcta y sin errores FK. Servicio actualizado y HTTP 200 por LAN y Tailscale en 8771. ERP 3 no iniciado.

## Importacion de propiedades por nombre de propietario - 11/09/2026

Checkpoint previo `onboarding-owner-names-pre-20260911` (`d13b7e0`). Esta mejora sustituye la limitacion del apartado anterior que exigia codigo de propietario en el archivo. No requiere migracion ni maestros alternativos.

- La columna `Propietario` puede mapearse a `Nombre de propietario existente`, manteniendo la alternativa por codigo. Se proponen solo coincidencias unicas entre propietarios activos de la comunidad; se ignoran mayusculas, tildes y espacios repetidos. No se eliminan palabras ni se vincula automaticamente por parecido. Codigo y nombre contradictorios generan incidencia.
- La vista previa muestra propiedad, nombre de origen, propietario propuesto, coeficientes por grupo y resultado. Homonimos o nombres no encontrados requieren seleccion explicita; se puede buscar por nombre o NIF entre propietarios de la comunidad. Las opciones muestran nombre, codigo y NIF disponibles. Tambien se puede cambiar una propuesta unica antes de confirmar.
- La eleccion manual invalida la confirmacion hasta actualizar la vista previa. Se conservan las elecciones al paginar (50 filas por pagina); cambiar archivo, hoja, comunidad o mapeo no reutiliza vinculos manuales de otra entrada. La tabla se presenta en filas apiladas en movil.
- La vinculacion usa el ID interno del propietario existente, tambien si no tiene codigo externo. La importacion de propiedades no crea propietarios. El archivo original, mapeo, elecciones y datos de la propuesta quedan registrados en el staging/auditoria existente; no se modifica la titularidad existente por esta via.
- Al confirmar se revalidan fuentes y elecciones dentro de la transaccion. Propietarios modificados, desactivados, ambiguos, ajenos a la comunidad o conflictos de titularidad bloquean la escritura. Un archivo ya confirmado se reconoce sin duplicar registros. Los coeficientes siguen requiriendo seleccion explicita de su grupo y sus validaciones exactas; no se inventa un grupo General.
- Pruebas ampliadas: 40 propiedades y 40 coeficientes por nombre, propietario sin codigo, normalizacion, homonimos, errores de nombre, seleccion manual, propietario inactivo, contradiccion codigo/nombre, aislamiento, reimportacion, revision obsoleta sin escritura parcial y resultados ERP 2 identicos. Playwright verifica vinculacion automatica y dos selecciones manuales hasta confirmar en 360/390/1440 px, y acceso a una incidencia en la fila 52 sin ocultarla por paginacion. Ningun listado real se confirma como parte de estas pruebas.
- MEJORA UX AUTONOMA: filtro inicial de filas con incidencias, con acceso al listado completo; acciones de revision/confirmacion junto al resumen y margen de desplazamiento para que la cabecera no oculte el resultado. Reduce desplazamientos sin ocultar incidencias ni saltarse la confirmacion.
- Cierre: implementacion `f32994c`, checkpoint `onboarding-owner-names-certified-20260911`. Regresiones ERP 0/1/2 y recorrido operativo superados en staging de Ubuntu; UI general (siete vistas) y recorrido especifico de importacion por nombres superados. Publicado en 8771 y comprobado HTTP 200 con la nueva interfaz por LAN y Tailscale.
- Backup `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260911-065824`; checksums correctos y restauracion aislada en `backups/restore-owner-names-na7rhca3/restored.db`, integridad correcta y sin errores FK. No se han ejecutado migraciones ni iniciado ERP 3.

## Crear grupo desde el mapeo de coeficientes - 11/09/2026

- Checkpoint previo `onboarding-inline-group-pre-20260911` (`cc0fdb6`). El selector mostraba solamente grupos existentes, dejando sin salida directa una comunidad sin grupos. No se crea General automaticamente ni se cambia el modelo.
- Cada columna de coeficientes ofrece `Crear grupo para este coeficiente`: nombre, total porcentual esperado y vigencia. Reutiliza `erp1.group.save` con permiso por comunidad, auditoria e idempotencia. Tras confirmar la creacion, selecciona ese grupo en la columna sin perder archivo, mapeo ni elecciones de propietarios. Los datos del Excel siguen requiriendo vista previa y confirmacion separadas.
- Se evita duplicar nombre/codigo o el General legado; estos deben seleccionarse y revisarse cuando corresponda. El nuevo grupo es vacio: crear el grupo no importa propiedades, no normaliza valores ni valida automaticamente coeficientes observados. No se modifican cuentas, cuotas, deuda o presupuestos.
- MEJORA UX AUTONOMA: aviso explicito cuando no hay grupos, reintento de vinculacion tras creacion sin crear otro grupo y descarte de respuestas de otra comunidad/carga.
- Verificacion especifica: creacion desde Excel propio, seleccion automatica de la columna, duplicado bloqueado, archivo y propietarios conservados, importacion de 40 propiedades/coeficientes en 360/390/1440 px y limites geometricos del formulario. Publicacion y restauracion se registran al completar sus comprobaciones.
