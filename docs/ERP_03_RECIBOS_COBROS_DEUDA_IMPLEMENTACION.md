# ERP 3 - Implementacion de recibos, cobros y deuda

Fecha: 11/09/2026. Estado: DESARROLLO. **ERP 3 no esta completado ni publicado. Implantacion certificada: 25%.** Hito 1: contrato y migraciones aditivas, compatibilidad observada, permisos y restauracion en copia verificados. Los servicios y la interfaz se han ampliado, pero no se concede el segundo hito hasta cubrir todas las operaciones y sus casos. Diseno cerrado: 100%; recorrido web integrado y probado parcialmente; aceptacion funcional completa: pendiente. La seccion "Continuacion web y correcciones" contiene el estado vigente, posterior a las evidencias iniciales.

Contrato obligatorio: [ERP 3 ratificado](ERP_03_RECIBOS_COBROS_DEUDA.md). [Roadmap](ERP_COMUNIDADES_ROADMAP.md). Sin cambios en las seis decisiones ni avance ERP 4/5/6.

## Checkpoint y respaldo

- Codigo previo `b4ee95a`; contrato ratificado incorporado a Git en `feebc61`.
- Checkpoint recuperable `erp3-pre-20260911` en `feebc61`.
- Reanudacion desde `72d4e45`, sin revertir `82eb185`; tag `erp3-resume-20260911`. Checkpoint de esta ampliacion: `erp3-progress-services-20260911` (no es cierre de ERP 3).
- Commit de servicios: `67c12a3b3f7a56a87858af0eabf66aecf4c6c1db`.
- Backup Ubuntu valido: `/home/coordinador/apps/organizador-web/backups/erp3-pre-20260911-105917`. SQLite mediante backup API, archivo de codigo/configuracion/documentos y `SHA256SUMS.json`. Restauracion aislada `restore-check.db`, integridad y FKs correctas. Parada breve solo de `organizador-web.service`, reiniciado al terminar; UNO Marbella intacto.
- Intento previo `erp3-pre-20260911-105815` NO valido para cierre: tar detecto cambios mientras leia `data/`. Se conserva, pero no se usa como checkpoint recuperable.
- Copia local de trabajo: `%TEMP%/erp3-source-20260911.db`. Cada prueba crea otra copia temporal; nunca modifica esta fuente ni la base del servidor.
- Backup de verificacion **SINTETICO, NO RESTAURAR EN PRODUCCION**: `C:/Users/EQUIPO/Documents/Codex/ERP3-synthetic-checkpoints/erp0-backup-20260911-140522`. Creado con `erp0-backup.py` desde el codigo del commit de servicios y el fixture ERP 3. `verify-erp0-backup.py --keep` verifica SHA-256, 160 tablas, recuentos, integridad, apertura/migracion del codigo restaurado y sintaxis Node. Restauracion `%TEMP%/organizador-erp0-restore-fin5n7mw`; comprobacion adicional de FK y proyecciones identicas para sus 41 recibos y un credito. No se ejecuta HTTP en ese restore (`runtime_accessible:false`); la regresion HTTP separada si ha pasado. No sustituye el futuro backup productivo de publicacion.
- Restauracion: verificar checksums del backup valido; preservar operaciones posteriores; restaurar codigo/configuracion/documentos compatibles y base desde backup con servicio detenido. No restaurar datos antiguos solo para deshacer codigo no publicado. Git no sustituye backup de SQLite.

## Implementacion de dominio

- Migracion 7 aditiva en `receivables_schema.py`, registrada en el mecanismo versionado existente. Tablas separadas para recibos/sujetos/detalles, cobros/imputaciones, devoluciones, rectificaciones, creditos, reintegros, eventos, responsabilidad, aperturas e importacion. No copia ni convierte automaticamente datos legacy. Triggers preservan originales y hechos; solo versiones operativas permitidas pueden cambiar.
- Migracion 8 aditiva: coberturas rectoras y correspondencias de regularizaciones materializadas; atribucion explicita de movimientos a conjuntos de obligados; proteccion de propuestas/importaciones cerradas. Se conserva el checksum de la migracion 7 de los checkpoints anteriores. Solo aplicada a copias.
- Contratos estrictos de dinero basados en `Money` ERP 2: centimos enteros, rango limitado, JSON monetario como texto; rechazo de float/bool, fechas invalidas y campos inesperados.
- Servicios internos con permisos ERP 3 explicitos por comunidad, sesion refrescada, rechazo por defecto, idempotencia, version esperada, transaccion, auditoria y outbox. No heredan permisos de tareas o presupuestos. Ninguna capacidad ordinaria se concede automaticamente.
- Emision en dominio desde plan/simulacion aprobados ERP 2, sin recalcular cuotas. Obligados configurados explicitamente, destinatario/pagador a fecha de emision, detalle congelado, propuesta y confirmacion, control de doble obligacion.
- Registro de cobros independientes; propuesta/confirmacion de imputaciones N:M, saldos libres y control de versiones de ambos extremos.
- Proyecciones exactas de recibo/cobro con corte efectivo y conocimiento; validacion de cortes posteriores para no dejar sobregiros retroactivos.
- Devolucion parcial/total con contramovimiento de imputaciones y fondos libres; anulacion solo sin movimientos; clasificacion incobrable mediante propuesta/confirmacion sin reducir saldo.
- Abono sobre cobrado: el usuario selecciona las imputaciones que se liberan por el importe necesario; liberacion y reduccion se confirman en la misma transaccion. No crea cobro ni deja deuda negativa.
- `receivables_adjustments.py`: desimputacion revisable; reintegro de saldo acreditado; compensacion de credito existente; politica none/actual/fixed y gasto separado; gestion de reclamacion; descarte auditado de propuestas; reasignacion excepcional por recibo con evidencia/autorizacion, identidades historicas e impacto antes/despues.
- Reasignacion y cobros posteriores: se conserva un conjunto de obligados por cada porcion, sin aplicar porcentajes de titularidad. Si hay varios conjuntos, una imputacion debe indicar a cual reduce deuda. La devolucion restaura esa misma atribucion. Consultas efectivas/conocidas y validacion de cortes posteriores impiden saldos personales negativos.
- `receivables_regularization.py`: materializa diferencias aprobadas ERP 2 como cargo, credito separado o linea cero trazada; deduplicacion por linea origen. Destinatario/pagador a emision efectiva y obligados acreditados explicitamente para cada ajuste. El adaptador de cobertura separa base, ajustes aprobados, materializados y reservas; no utiliza lo cobrado como base.
- `receivables_history.py`: staging estructurado con filas originales, huella de archivo y de filas, incidencias, revision y confirmacion; aperturas observadas con corte/cobertura/limitaciones; identidad estable entre archivos; rechazo de referencias contradictorias y coberturas agregadas solapadas. No genera recibos o cobros ficticios ni valida automaticamente el legado. Es servicio de dominio: la carga/mapeo Excel web todavia no esta integrada.
- `receivables_queries.py`: listados paginados con totales exactos sobre todas las paginas; deuda propia/compartida/no atribuida; fondos separados; timeline; legacy observado y aperturas sin doble inclusion por enlaces. Las limitaciones bloquean un total definitivo: se devuelve subtotal documentado e incidencias. Una FK legacy no acredita deuda personal. La fecha de actualizacion legacy es una limitacion de conocimiento, no una fecha inventada de cobro.
- Evidencias: documentos existentes requieren comunidad y permiso documental; referencias externas son declaraciones expresas auditadas, no documentos descargables verificados. No se admiten tipos arbitrarios de evidencia.

Los servicios disponibles **estan registrados en el dispatcher allow-listed** y reutilizan el transporte ERP; las pruebas de fundamentos pasan por ese dispatcher. La continuacion incorpora interfaz web y adapta consumidores de consultas; consultar las evidencias y limites actuales al final. No activar dinero real por la mera presencia del catalogo o de las migraciones.

## Evidencia de pruebas parcial

- `verify-erp3-foundations.py`: 19 pruebas sobre copia; conserva los casos anteriores y anade abono cobrado atomico, desimputacion, tres politicas de gastos, reintegro, staging/reimportacion, atribucion personal, evidencia inexistente, reasignacion 60/40 economica sin usar copropiedad, cobro posterior explicitamente atribuido, devolucion, concurrencia real de dos confirmaciones y rollback de un traslado de varias lineas. No equivalen a los 35 casos completos de aceptacion.
- Ultima ejecucion de esas 19 pruebas: `%TEMP%/organizador-erp3-foundations-cxnmix__`, 19/19 correctas. `git diff --check` correcto. Servicio Ubuntu consultado en lectura: `organizador-web.service` activo; sin despliegue, reinicio ni cambio productivo en esta ampliacion.
- `verify-erp3-emission.py`: fixture ERP 2 de 40 viviendas/16 jardines; 40 cargos por 46.704 centimos, detalle congelado, idempotencia y doble obligacion bloqueada. Ademas materializa la regularizacion aprobada del fixture (cargos y creditos), conserva hashes/importes originales y verifica conjuntos disjuntos antes/despues sin aplicar creditos automaticamente. Evidencia `%TEMP%/organizador-erp3-emission-af7ket5y`. No es una prueba web ni una importacion real.
- `verify-erp2-complete.py`: regresion completa superada con migracion 8, incluidos 40/16, presupuesto inmutable, copia/importacion, derrama, regularizaciones, inquilino/pagador, permisos y restauracion. Fixture `%TEMP%/organizador-erp2-complete-kw6q7x3p`.
- `verify-erp1-master-data.py`: regresion maestra superada; mantiene su propio alcance certificado de migracion ERP 1. No se usa como prueba de la totalidad de ERP 3.
- Regresion HTTP operativa `verify-operational-release.mjs` superada: ERP 0, sesiones/permisos, tareas/proyectos, documentos/informes, presidencia, seguridad, asambleas, IA y consultas. Ejecucion `%TEMP%/organizador-release-KKc1qU` (el runner limpia su fixture al terminar); no sustituye las pruebas pendientes de ERP 3.
- No pruebas UX ERP 3: su interfaz no esta implementada. No despliegue ni migracion productiva.

## Pendientes del checkpoint anterior (sustituidos por el estado vigente inferior)

1. Completar ERP 3B: movimientos contra aperturas historicas (actualmente se conservan/consultan, pero no se cobran directamente), contramovimientos restantes de creditos/devoluciones, cobertura completa de abonos de ajustes y ajustes de otros planes; enlazar el adaptador a la preparacion ERP 2 y probar una nueva regularizacion posterior, no solo su identidad aritmetica. Conservar formula ERP 2 y evitar doble reserva.
2. Emision: reemplazo documentado de anulados, identidad procesada de cuota cero, casos completos de cambio de destinatario y sucesion de configuracion de obligados. La cobertura impide emitir sobre intervalos legacy sin reconciliar; falta el recorrido de activacion/mapeo completo de esos intervalos. No desactivar este bloqueo para facilitar una demo.
3. Completar consultas de cuenta/antiguedad y sujeto persona, exportaciones, contratos de eventos y todos los casos restantes; comprobar referencias documentales con perfiles no root y no solo documento inexistente. Mantener informacion incompleta como incidencia, no total definitivo.
4. ERP 3C: UI Gestion > Ingresos y recibos, fichas contextuales, permisos configurables, documentos, importacion Excel con carga/mapeo/edicion de staging y todos los recorridos de revision. Sustituir consumidores existentes de `cf_recibos`/`cf_movimientos_deuda` con equivalencia/cobertura probadas; la consulta nueva todavia no los sustituye.
5. ERP 3D: completar 35 casos del contrato, perfiles, auditoria e idempotencia de todas las operaciones, Playwright escritorio/movil, backup/restauracion final de publicacion y despliegue. La prueba concurrente y las regresiones actuales son evidencia parcial, no cierre.

## Riesgos y limites actuales

No utilizar el dominio parcial para operar dinero real. Persisten los huecos del estado vigente inferior; el recorrido web tiene evidencia parcial, no aceptacion integral. No convertir datos observados a validados por rellenar una FK. Preservar checksums de migraciones ya registradas y utilizar una nueva migracion para ampliaciones posteriores al checkpoint de servicios.

No se ha identificado una nueva decision funcional material que deba tomar el usuario. Lo pendiente es implementacion y verificacion conforme al contrato, no una reapertura de D1-D6. Configuracion de usuarios/cobertura/corte reales sigue siendo puerta de activacion, no autorizacion inferida del cierre de diseno.

Checkpoints locales de avance: `erp3-progress-domain-20260911` y `erp3-progress-services-20260911`. No son cierre de ERP 3. No se ha publicado esta ampliacion ni migrado produccion. Conservar estas pruebas como regresion; no declarar 50/75/100% por la mera existencia de servicios o tablas.

## Mejoras tecnicas incorporadas

Las evidencias de esta seccion inicial corresponden al checkpoint de servicios; la continuacion siguiente las amplia sin volver a certificar el contrato.

- MEJORA AUTONOMA IMPLEMENTADA: atribucion de cada imputacion/abono/compensacion a un conjunto acreditado cuando un traslado divide el pendiente; evita que un pago posterior reduzca silenciosamente deuda de otro obligado. No usa porcentajes juridicos ni habilita division automatica de recibos.
- MEJORA AUTONOMA IMPLEMENTADA: total paginado independiente de la pagina; subtotal y advertencias ante cobertura incompleta; evita presentar como deuda total segura una consulta parcial o una atribucion legacy no acreditada.
- MEJORA AUTONOMA IMPLEMENTADA: gasto de devolucion resuelve destinatario/pagador a su propia emision y ejercicio abierto correspondiente, manteniendo separados los obligados historicos del gasto y el recibo original.

## Continuacion web y correcciones (estado vigente)

Reanudacion desde `cf61ef7`, sin revertir `67c12a3`. Checkpoint previo `erp3-resume-web-20260911`. Codigo de avance `be1ce8bdbdc37aebd70186ce8fd06cd603518b6f`, tag `erp3-progress-web-20260911`; NO es cierre/publicacion.

### Bloques incorporados

- Migraciones aditivas 9, 10 y 11, aplicadas exclusivamente en copias: movimientos inmutables de aperturas; identidad de cuotas cero procesadas; reversos de devoluciones y acreditacion temporal del pagador de un cobro inicialmente desconocido. Checksums 7/8 intactos.
- Aperturas: imputar/desimputar cobros, aplicar/revertir saldo a favor, abonar/revertir abono y reintegrar saldo acreditado. No crea cobros/recibos ficticios. Fuente, corte, calidad e importe original permanecen intactos.
- Reversiones de abonos y aplicaciones de credito con revision, evidencia, idempotencia, control de saldo/version y validacion de cortes posteriores. Rectificar una devolucion recupera fondos libres; NO reimputa ni cambia automaticamente el gasto independiente.
- Pagador desconocido: acreditacion separada y temporal, evidencia obligatoria, identidad original conservada; permite reintegrar posteriormente al beneficiario acreditado. No cambia obligado ni destinatario.
- Emision: sustitucion explicita de un recibo anulado con nuevo numero y referencia al original; cuotas cero registradas sin recibo ficticio. Configuracion de obligados finalizada no reactiva una anterior.
- ERP 2: preparacion de regularizacion conectada a `erp3.emitted.coverage` dentro de la transaccion. Aprobacion vuelve a comprobar base emitida y ajustes aprobados; una propuesta obsoleta se rechaza. Nueva propuesta tras reserva aprobada no duplica el ajuste. Abonos emitidos por otros planes se consideran separados de las reservas del plan actual. El conocimiento temporal de aprobaciones usa su evento persistente.
- `receivables-http.js` / `receivables_tabular.py`: carga privada Excel/CSV, permiso antes de escritura, hash, deteccion de columnas, mapeo, codigos exactos dentro de comunidad, importes Decimal, errores por fila, conservacion del archivo y celdas originales. Rehacer mapeo de staging requiere version; no modifica una importacion confirmada. Confirmacion humana, transaccion e idempotencia.
- `receivables-ui.js`: Gestion > Ingresos y recibos integrado en el sistema visual actual; recibos, cobros/saldos, deuda, ajustes/gastos, importacion y configuracion. Propuestas revisables, apertura contextual desde fichas de comunidad/propiedad/propietario, politicas y permisos explicitos. No se conceden capacidades financieras automaticamente a usuarios reales.
- Consulta de cuenta unificada y resumen de periodo. El Centro IA consulta `erp3.account.statement` y el resumen financiero `erp3.period.summary`; retiradas las sumas directas de recibos/cobros legacy del handler. Gastos y banco conservan su lectura existente, fuera del dominio ERP 3. Las observaciones de Netfincas no se suman silenciosamente a movimientos ERP; limitaciones y corte se muestran.

### Evidencia nueva

- Fundamentos: **29/29 correctas**, fixture `%TEMP%/organizador-erp3-foundations-tscebx9o`. Nuevos casos de aperturas, mapeo/reimportacion, reversiones, pagador desconocido, resumen de periodo, proyeccion compartida con agente. Integridad/FK y recuentos historicos verificados por caso. No equivalen automaticamente a los 35 casos integrales del contrato.
- Emision `%TEMP%/organizador-erp3-emission-6frdqfue`: 40 propiedades/16 jardines, 46.704 centimos primer periodo, detalle congelado, destinatario a emision, transmision ERP 1 sin mover deuda anterior, no prorrateo, sucesion de obligados, sustitucion de anulado, regularizacion contra emitido impagado y bloqueo de aprobacion obsoleta. La identidad de cuota cero necesita caso dedicado antes del cierre.
- Regresion ERP 2 completa con migracion 11: `%TEMP%/organizador-erp2-complete-z_ljd2_i`. ERP 1: `%TEMP%/organizador-erp1-master-data-vx393fiu` (su suite certifica especificamente migraciones maestras, no todo ERP 3).
- Regresion HTTP ERP 0/operativa: `%TEMP%/organizador-release-cymGjF`, todas las comprobaciones correctas, incluidas consultas/aislamiento despues de sustituir el resumen financiero.
- Web ERP 3: `%TEMP%/organizador-erp3-web-6wVyBi`. Playwright real 1440/390/360: navegacion, registrar/revisar/confirmar cobro, imputacion parcial, devolucion y rectificacion sin reimputacion, Excel con vista previa/confirmacion/reimportacion, incidencias visibles; cero errores JS/desbordamiento global. Capturas inspeccionadas de recibos escritorio/movil en ejecucion previa `%TEMP%/organizador-erp3-web-4IXWER`.
- Navegacion general: `%TEMP%/navigation-structure-YkPIQ5`, 390/360/1920, 16 vistas accesibles al perfil de prueba, restricciones de presidente/lector/seguridad y cero errores JS/desbordamientos. No implica aceptacion de todas las operaciones financieras en cada perfil.
- `verify-erp3-checkpoint.py` prepara un backup consistente de un commit y fixture sintetico, verifica restauracion aislada, hashes de originales y proyecciones. No sustituye backup de produccion.
- Backup de este checkpoint: `C:/Users/EQUIPO/Documents/Codex/ERP3-synthetic-checkpoints/erp0-backup-20260911-151817`. **SINTETICO: NO RESTAURAR EN PRODUCCION.** Restauracion aislada `%TEMP%/organizador-erp0-restore-rizhyoz4`: SHA-256, 164 tablas, integridad/FK, hashes de originales y proyecciones economicas identicos. Prueba HTTP adicional del codigo restaurado con dependencias locales enlazadas: `/health` correcto en puerto aislado 49625; proceso detenido al terminar. La prueba automatica de archivo indica `runtime_accessible:false` porque no enlaza dependencias; esta comprobacion HTTP posterior es independiente y positiva. Produccion no modificada.

### Pendientes efectivos para el cierre (no repetir lo anterior)

1. Cerrar activacion/reconciliacion de intervalos historicos cubiertos. El bloqueo de emision cuando hay legacy en el intervalo sigue vigente; no existe aun recorrido completo para acreditar todas las correspondencias y activar esos intervalos con seguridad.
2. Completar consulta por sujeto de cobro, antiguedad y exportaciones auditadas con neutralizacion de formulas. Probar expresamente cuota cero, ajustes de otro plan, cortes de conocimiento y contrato de consumo idempotente de eventos. No dar por validada una rama por existir codigo.
3. Completar UX masiva y cobertura de operaciones: selector de recibos no limitado a la pagina cargada, imputacion N:M por lote, edicion de obligados sin listado excesivo, reversion de credito/abono nativo, sustitucion y cuotas cero, documentos de evidencia accesibles. Revisar filtros/contexto de ajustes, cambios de comunidad y perfiles financieros no root en todos los flujos.
4. Completar aceptacion de los 35 casos con matriz de evidencia, pruebas documentales positivas por perfil, rollback de importacion/lotes completos, eventos y regresion final del paquete exacto a publicar. La sustitucion de consultas necesita aceptacion de equivalencia/cobertura con las fuentes reales, no solo fixtures.
5. Backup final de publicacion, restauracion aislada HTTP, gates de despliegue ERP 3, publicacion Ubuntu/GitHub y smoke tests productivos. NO realizados; produccion y datos reales no se han modificado en esta continuacion.

Certificacion: hito 1 **25/25**; hito 2 pendiente de completar; hitos 3/4 sin certificar. **ERP 3 permanece en 25% certificado.** El incremento de codigo y pruebas no concede puntos parciales. No se declara 100%, no se publica y no se inicia ERP 4. No hay nueva decision funcional material del usuario; queda implementacion y verificacion.

MEJORA UX AUTONOMA: filtros habituales colapsados, tabs adaptadas al movil, filas legibles sin desbordamiento, conservacion de valores al volver desde revision y bloqueo de doble pulsacion. MEJORA TECNICA AUTONOMA: revalidacion de emitidos al aprobar regularizacion, identidad desconocida acreditada mediante hecho separado y advertencia de limitaciones historicas tambien en el agente. Sin cambios en reglas cerradas.
