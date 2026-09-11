# ERP 3 - Implementacion de recibos, cobros y deuda

Fecha: 11/09/2026. Estado: DESARROLLO. **ERP 3 no esta completado ni publicado. Implantacion certificada: 25%.** Hito 1: contrato y migraciones aditivas, compatibilidad observada, permisos y restauracion en copia verificados. Los servicios se han ampliado, pero no se concede el segundo hito hasta cubrir todas las operaciones y sus casos. Diseno cerrado: 100%; recorrido web y aceptacion funcional completa: pendientes.

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

Los servicios disponibles **estan registrados en el dispatcher allow-listed** y reutilizan el transporte ERP; las pruebas de fundamentos pasan por ese dispatcher. **No existe aun interfaz ERP 3 integrada ni se han sustituido los consumidores legacy.** No activar dinero real por la mera presencia del catalogo o de las migraciones.

## Evidencia de pruebas parcial

- `verify-erp3-foundations.py`: 19 pruebas sobre copia; conserva los casos anteriores y anade abono cobrado atomico, desimputacion, tres politicas de gastos, reintegro, staging/reimportacion, atribucion personal, evidencia inexistente, reasignacion 60/40 economica sin usar copropiedad, cobro posterior explicitamente atribuido, devolucion, concurrencia real de dos confirmaciones y rollback de un traslado de varias lineas. No equivalen a los 35 casos completos de aceptacion.
- Ultima ejecucion de esas 19 pruebas: `%TEMP%/organizador-erp3-foundations-cxnmix__`, 19/19 correctas. `git diff --check` correcto. Servicio Ubuntu consultado en lectura: `organizador-web.service` activo; sin despliegue, reinicio ni cambio productivo en esta ampliacion.
- `verify-erp3-emission.py`: fixture ERP 2 de 40 viviendas/16 jardines; 40 cargos por 46.704 centimos, detalle congelado, idempotencia y doble obligacion bloqueada. Ademas materializa la regularizacion aprobada del fixture (cargos y creditos), conserva hashes/importes originales y verifica conjuntos disjuntos antes/despues sin aplicar creditos automaticamente. Evidencia `%TEMP%/organizador-erp3-emission-af7ket5y`. No es una prueba web ni una importacion real.
- `verify-erp2-complete.py`: regresion completa superada con migracion 8, incluidos 40/16, presupuesto inmutable, copia/importacion, derrama, regularizaciones, inquilino/pagador, permisos y restauracion. Fixture `%TEMP%/organizador-erp2-complete-kw6q7x3p`.
- `verify-erp1-master-data.py`: regresion maestra superada; mantiene su propio alcance certificado de migracion ERP 1. No se usa como prueba de la totalidad de ERP 3.
- Regresion HTTP operativa `verify-operational-release.mjs` superada: ERP 0, sesiones/permisos, tareas/proyectos, documentos/informes, presidencia, seguridad, asambleas, IA y consultas. Ejecucion `%TEMP%/organizador-release-KKc1qU` (el runner limpia su fixture al terminar); no sustituye las pruebas pendientes de ERP 3.
- No pruebas UX ERP 3: su interfaz no esta implementada. No despliegue ni migracion productiva.

## Pendientes obligatorios para continuar

1. Completar ERP 3B: movimientos contra aperturas historicas (actualmente se conservan/consultan, pero no se cobran directamente), contramovimientos restantes de creditos/devoluciones, cobertura completa de abonos de ajustes y ajustes de otros planes; enlazar el adaptador a la preparacion ERP 2 y probar una nueva regularizacion posterior, no solo su identidad aritmetica. Conservar formula ERP 2 y evitar doble reserva.
2. Emision: reemplazo documentado de anulados, identidad procesada de cuota cero, casos completos de cambio de destinatario y sucesion de configuracion de obligados. La cobertura impide emitir sobre intervalos legacy sin reconciliar; falta el recorrido de activacion/mapeo completo de esos intervalos. No desactivar este bloqueo para facilitar una demo.
3. Completar consultas de cuenta/antiguedad y sujeto persona, exportaciones, contratos de eventos y todos los casos restantes; comprobar referencias documentales con perfiles no root y no solo documento inexistente. Mantener informacion incompleta como incidencia, no total definitivo.
4. ERP 3C: UI Gestion > Ingresos y recibos, fichas contextuales, permisos configurables, documentos, importacion Excel con carga/mapeo/edicion de staging y todos los recorridos de revision. Sustituir consumidores existentes de `cf_recibos`/`cf_movimientos_deuda` con equivalencia/cobertura probadas; la consulta nueva todavia no los sustituye.
5. ERP 3D: completar 35 casos del contrato, perfiles, auditoria e idempotencia de todas las operaciones, Playwright escritorio/movil, backup/restauracion final de publicacion y despliegue. La prueba concurrente y las regresiones actuales son evidencia parcial, no cierre.

## Riesgos y limites actuales

No utilizar el dominio parcial para operar dinero real. Persisten los huecos enumerados y no existe todavia recorrido web aceptado. La config de obligados temporal necesita completar casos de sucesion/correccion. No convertir datos observados a validados por rellenar una FK. Preservar checksums de migraciones 7/8 y utilizar una nueva migracion para ampliaciones posteriores al checkpoint de servicios.

No se ha identificado una nueva decision funcional material que deba tomar el usuario. Lo pendiente es implementacion y verificacion conforme al contrato, no una reapertura de D1-D6. Configuracion de usuarios/cobertura/corte reales sigue siendo puerta de activacion, no autorizacion inferida del cierre de diseno.

Checkpoints locales de avance: `erp3-progress-domain-20260911` y `erp3-progress-services-20260911`. No son cierre de ERP 3. No se ha publicado esta ampliacion ni migrado produccion. Conservar estas pruebas como regresion; no declarar 50/75/100% por la mera existencia de servicios o tablas.

## Mejoras tecnicas incorporadas

- MEJORA AUTONOMA IMPLEMENTADA: atribucion de cada imputacion/abono/compensacion a un conjunto acreditado cuando un traslado divide el pendiente; evita que un pago posterior reduzca silenciosamente deuda de otro obligado. No usa porcentajes juridicos ni habilita division automatica de recibos.
- MEJORA AUTONOMA IMPLEMENTADA: total paginado independiente de la pagina; subtotal y advertencias ante cobertura incompleta; evita presentar como deuda total segura una consulta parcial o una atribucion legacy no acreditada.
- MEJORA AUTONOMA IMPLEMENTADA: gasto de devolucion resuelve destinatario/pagador a su propia emision y ejercicio abierto correspondiente, manteniendo separados los obligados historicos del gasto y el recibo original.
