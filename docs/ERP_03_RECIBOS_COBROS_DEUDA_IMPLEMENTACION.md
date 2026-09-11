# ERP 3 - Implementacion de recibos, cobros y deuda

Fecha: 11/09/2026. Estado: **COMPLETADO. Implantacion certificada: 100%. Publicado en Ubuntu.** Cuatro hitos acreditados: contrato/migraciones, servicios, recorrido integrado y aceptacion/restauracion/publicacion. Diseno cerrado: 100%. La seccion "Cierre certificado" contiene el estado vigente; las anteriores conservan los checkpoints y sus porcentajes historicos. No se inicia ERP 4.

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

## Continuacion web y correcciones (checkpoint anterior)

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

## Candidato de cierre

Continuacion desde `erp3-progress-web-20260911`, sin revertirlo. Previo `erp3-pre-closure-20260911` en `b07635e`. Candidato de codigo `675f736dab2e88aa9c1842a528467c1034648def`, tag `erp3-candidate-20260911`; la ampliacion de pruebas y gates posterior se incorpora al checkpoint de aceptacion. No es aun publicacion.

### Pendientes funcionales completados

- Migracion aditiva 12: activacion historica y correspondencias de obligaciones inmutables; checksums anteriores intactos. Correspondencia completa, exacta, explicita y revisable; evidencia, hash de fuente, periodo, propiedad, emision original y saldo. No inventa cobros ni cambia calidad observada. Cambiar posteriormente la fuente bloquea su uso, no reinterpreta el pasado.
- Regularizacion consume emitido original historico acreditado, no pendiente ni cobrado; impide reemision de la misma obligacion. Abonos agregados sin desglose suficiente bloquean la atribucion por periodo.
- Exportaciones CSV/Excel auditadas, todas las paginas, filtros/corte/limitaciones, importes exactos en texto, neutralizacion de formulas, SHA-256 y reintento idempotente. Hasta 20.000 filas/12 MiB; no vuelca el fichero en auditoria/outbox. La respuesta idempotente conserva el archivo en el repositorio de comandos.
- Imputacion N:M masiva: hasta 100 cobros/500 aplicaciones, transaccion unica, control acumulado por recibo/obligados, versiones, fondos disponibles, rollback total y confirmacion humana. Selectores consultan todas las paginas, no solo los primeros 50 recibos.
- Antiguedad y consulta por persona de cobro; referencias documentales seleccionables y navegables con permisos, detalle protegido por capacidad sensible; consulta basica no revela sujetos personales.
- UX de sustitucion de anulados, cuotas cero, reversos de abonos y aplicaciones, seleccion masiva de propiedades/obligados. Cobros vinculados a aperturas aparecen en su propiedad. Regularizaciones identificadas como lote comunitario completo, sin fingir que el filtro de ficha modifica su alcance.
- MEJORA UX AUTONOMA: revision de emision en una fila por propiedad; paginacion movil de 10 registros, sin cambiar totales/exportaciones. Seleccion expresa del conjunto de obligados cuando existen varios.
- MEJORA TECNICA AUTONOMA: cookie de sesion compacta (solo identificadores del ambito); mantiene autenticacion, revocacion y permisos refrescados en backend. La copia de siete comunidades excedia el limite del navegador con el formato anterior duplicado. Compatibilidad con sesiones previas conservada.
- MEJORA TECNICA AUTONOMA: dependencias Python de Excel fijadas por version/SHA-256 y preparadas solo dentro de `server/_python_packages`; no requiere pip ni cambios globales de Ubuntu. Transporte de exportacion dimensionado para base64; resto de contratos conserva sus limites.

### Evidencia de aceptacion

- `verify-erp3-foundations.py`: 40 casos superados en `organizador-erp3-foundations-gsg4ymp6`; ampliados a 42 con los ejemplos literales de devolucion total/cobro desconocido y un cobro para dos recibos. Resultado final del paquete se registra en la publicacion.
- `verify-erp3-emission.py`: `organizador-erp3-emission-3wt8f4tm`, 40/16, 46.704 centimos, cuota cero real de derrama, ajustes entre planes, emitido impagado, no prorrateo, destinatario tardio, inquilino destinatario/pagador alternativos, sustitucion y originales intactos.
- `verify-erp3-activation.py`: `organizador-erp3-activation-vf5sdwv7`, 100 emitidos/25 cobrados/75 pendientes usa 100 como base; bloquea repeticion y cambio de fuente. Cada runner trabaja en copia propia.
- `verify-erp3-web.mjs`: `organizador-erp3-web-16c2hO`, Playwright real 1440/390/360: carga/mapeo/reimportacion Excel, activacion, cobro, imputacion a recibo fuera de primera pagina, devolucion/reversion, exportacion, emision 40 propiedades y sustitucion; sin errores JS/desbordamiento. Capturas inspeccionadas; revision compactada tras inspeccion.
- `verify-erp3-roles.mjs`: `organizador-erp3-roles-745vLr`, usuario financiero no root 1440/390, registro revisado, emision oculta sin permiso, comunidad ajena denegada, CSV >2 MiB y reintento con mismo hash.
- `verify-erp3-legacy.py`: `organizador-erp3-legacy-hmb400j4`, copia consistente del historico real: 16.289 observaciones validas; subtotal/listado coinciden con comprobacion Decimal independiente, hashes originales intactos. No activa fuentes ni acredita automaticamente deuda personal.
- ERP 0/operativa HTTP: `organizador-release-hNR19n`; revocacion, alcance, roles, documentos, reuniones y consultas sin regresion tras compactar cookie. ERP 2 completo: `organizador-erp2-complete-y0mmqs0n`; ERP 1: `organizador-erp1-master-data-hiyyyfls`. Onboarding actualizado para verificar catalogo completo de migraciones/checksums, no MAX(version)=6: `organizador-ux-onboarding-wtqlb9y_`, resultados ERP 2 identicos.
- Backup sintetico del candidato: `C:/Users/EQUIPO/Documents/Codex/ERP3-synthetic-checkpoints/erp0-backup-20260911-165459`. Restauracion `organizador-erp0-restore-cqdfp9wx`: 166 tablas, SHA-256, FK/integridad, originales y proyecciones identicos. `runtime_accessible:false` en esta comprobacion local; la puerta Ubuntu exige ademas HTTP aislado. NO restaurar este fixture en produccion.

### Matriz de los 35 casos del contrato

F = `verify-erp3-foundations.py`; E = `verify-erp3-emission.py`; W = `verify-erp3-web.mjs`; R = `verify-erp3-roles.mjs`. Los nombres de metodos F siguientes omiten el prefijo `test_`. Ninguna equivalencia sustituye una comprobacion pendiente de publicacion.

| Casos | Evidencia ejecutable |
|---|---|
| 1, 2, 3, 4, 7 | F `partial_many_collections_and_overpayment`, `paid_credit_frees_funds_atomically` |
| 5 | F `acceptance_one_collection_multiple_receipts` |
| 6, 8 | F `acceptance_full_return_and_unidentified_cash` |
| 9 | F `partial_return_keeps_original` |
| 10 | F `return_fee_policies_separate_charge` |
| 11, 12, 13 | F `credit_void_and_atomic_failure`, `paid_credit_frees_funds_atomically`, `immutable_and_cross_community_fk`; E sustitucion |
| 14, 26, 27 | E 40/16, transmision, emision temprana/tardia, configuracion de inquilino y sujetos congelados |
| 15 | F `shared_obligated_group_never_splits_or_doubles_charge`, `person_is_not_inferred_from_owner_or_payer`; ERP 1 copropiedad 60/40 |
| 16 | E materializacion, nueva propuesta sin doble reserva, ajustes de otro plan y aprobacion obsoleta; activacion historica |
| 17, 19, 29 | F `history_staging_cutoff_identity_and_rollback`, `opening_collection_and_reversal_preserve_source`, `historical_activation_review_idempotency_and_originals`; W reimportacion |
| 18, 25 | F `mixed_return_and_known_time_no_automatic_netting`, `credit_reversal_preserves_original_and_cutoffs`, `refund_excess_does_not_reopen_receipt` |
| 20 | F `concurrent_confirmation_cannot_spend_twice` |
| 21, 22 | F `read_only_user_and_no_implicit_economic_grants`, `financial_user_document_evidence_and_export_permissions`, `immutable_and_cross_community_fk`; R, regresion HTTP carga sin permiso |
| 23 | F `idempotency_and_permissions`, `outbox_repeated_delivery_has_one_synthetic_consumer_effect` (consumidor sintetico, no ERP 6) |
| 24 | Backup/restauracion sinteticos anteriores; backup/restauracion productivos HTTP exigidos por gate final, pendientes |
| 28 | F `batch_allocation_many_to_many_atomic_and_replay`, `uncollectible_discard_and_period_lock_preserve_debt`, `multiple_receipts_and_stale_preview`; E |
| 30 | W, R y capturas inspeccionadas, dimensiones 360/390/1440; documentos positivos F y regresion HTTP |
| 31 | F `paid_credit_frees_funds_atomically`, `credit_application_reversal_does_not_create_cash`, `opening_credit_application_and_refund` |
| 32, 33 | F `mixed_return_and_known_time_no_automatic_netting`, `uncollectible_discard_and_period_lock_preserve_debt` |
| 34, 35 | F `exceptional_transfer_and_explicit_later_payment`, `transfer_lot_failure_rolls_back_all_lines` |

### Puerta final y limites

Hitos 1/2/3: 25 puntos cada uno, **75%**. Hito 4 no concedido hasta paquete exacto, Ubuntu, restauracion y smoke. El primer staging Ubuntu se detuvo correctamente por una asercion antigua de onboarding; no hubo parada, despliegue ni migracion real. Se corrige la comprobacion, no el dominio certificado.

`deploy-operational-release.py` prepara dependencias locales verificadas y copias consistentes; ejecuta ERP 1/onboarding/2A/2B/2/3 y regresion HTTP. Publicacion requiere backup ERP 0 restaurado con HTTP aislado, historicos iguales y FK/integridad. Comprueba /health y denegacion sin sesion; repite pruebas sobre copias con codigo instalado y realiza backup posterior/restauracion. Servicio y rutas limitados a organizador-web/8771. No toca UNO Marbella.

No requiere decisiones funcionales nuevas. Activar dinero real sigue exigiendo permisos, obligados y cobertura/corte acreditados por comunidad. No se activan automaticamente datos observados ni se concede acceso financiero a usuarios reales. No se ha implementado ERP 4.

## Cierre certificado

**ERP 3: COMPLETADO, 100% (25 + 25 + 25 + 25), 11/09/2026.** Los pendientes del candidato quedan cerrados mediante las evidencias siguientes. No se ha redisenado ERP 3 ni adelantado ERP 4.

- Codigo instalado: `aaadb1b03b0903f14d828c23624f5aa327765edc`; checkpoint de aceptacion `erp3-acceptance-20260911` en `f87311e`, mas correcciones de empaquetado/pruebas `8cdd1be` y `aaadb1b`. Checkpoint final: `erp3-completed-20260911`, que incorpora esta ficha de cierre sin cambiar el codigo desplegado.
- Paquete: `backups/erp3-release-disk-20260911.tar`. Instalacion aislada de dependencias Python verificadas por SHA-256, sin pip/globales; scripts de aceptacion utilizan esa misma dependencia. Los temporales y restauraciones se ubican en disco dentro del stage, no en tmpfs. Los intentos previos fallaron antes de tocar produccion por asercion antigua, ruta de dependencia del test y E/S de tmpfs; resueltos y repetidos satisfactoriamente.
- Stage final: `/home/coordinador/apps/organizador-web/backups/stage-operational-20260911-150642`. ERP 1, onboarding, ERP 2A/2B/2 completo, 42/42 fundamentos ERP 3, emision 40/16, activacion historica, compatibilidad de 16.289 observaciones y regresion HTTP ERP 0/operativa superados. Datos de prueba exclusivamente en copias.
- Las 42 pruebas cubren la matriz anterior; quedan confirmados tambien sus casos literales de devolucion total, cobro desconocido y N:M. Inquilino como destinatario y propietario como pagador, y caso inverso, comprobados en la emision real del fixture, con obligado separado.
- Backup productivo previo: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260911-151106`. Restauracion aislada `verification-temp/organizador-erp0-restore-koil5z96` dentro del stage: 137 tablas, checksums/recuentos/integridad y HTTP correctos. El commit antiguo no estaba identificado en Ubuntu (`unknown`); el archivo completo preserva el codigo anterior y no se le atribuye falsamente el commit nuevo.
- Backup productivo posterior: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260911-151433`. Restauracion `verification-temp/organizador-erp0-restore-d6j87lbc`: 166 tablas, checksums/recuentos, integridad, cero FKs invalidas y arranque HTTP aislado correcto. Comparacion adicional: **121 tablas ERP/CF identicas** entre backup y restauracion. Pruebas persistidas en `erp3-publication-proof.json` y `erp3-restore-financial-proof.json` dentro de este backup. No confundir estos backups reales con los fixtures sinteticos anteriores.
- Publicacion y smoke: servicio `organizador-web.service` activo, puerto 8771; `/health` correcto; consulta financiera sin sesion rechazada con 401; esquema 12, integridad `ok`, cero errores FK. Hashes de recibos/deuda/maestros/asambleas anteriores iguales durante la migracion. Comprobacion directa: 16.289 recibos legacy, cero recibos nativos y cero hechos economicos reales generados por la publicacion.
- Regresion posterior con **codigo instalado**: HTTP ERP 0/operativa en `verification-temp/organizador-release-vDFWgB` y 42/42 fundamentos en `verification-temp/organizador-erp3-foundations-wsim7_8y`; ambos dentro del stage final y correctos. Las operaciones sinteticas no se ejecutaron sobre la base productiva.
- Navegador Tailscale real 1440/390 y salud por LAN/Tailscale correctos: `%TEMP%/erp3-live-smoke-Ewy8dK`. Esta prueba productiva verifica acceso/login sin usar credenciales reales; los recorridos financieros autenticados completos se verificaron en copias. Ultima prueba de perfil financiero y exportacion >2 MiB: `%TEMP%/organizador-erp3-roles-AVMDdO`, correcta, capturas inspeccionadas. El recorrido W final sigue siendo `organizador-erp3-web-16c2hO`.

### Limites operativos conservados

No hay bloqueo funcional pendiente de ERP 3. La puesta en servicio economica de cada comunidad requiere configurar expresamente permisos, obligados, politica de gastos y cobertura/corte con evidencia; el cierre tecnico no inventa esas decisiones ni valida automaticamente Netfincas. Los saldos observados siguen identificados como tales. No hay imputacion automatica, traslado automatico de deuda, SEPA ni asientos nuevos.

Limites de proteccion: exportacion 20.000 filas/12 MiB; lote de imputacion 100 cobros/500 aplicaciones; activacion historica revisable hasta 500 correspondencias por cobertura. Las operaciones mayores deben delimitarse antes de confirmar; no se truncan silenciosamente. Las dependencias Node heredadas muestran avisos de obsolescencia; su mantenimiento queda separado de esta fase, sin alterar paquetes de otros modulos durante el cierre.

Restauracion: detener exclusivamente este servicio, verificar manifiesto/checksums, preservar operaciones posteriores y restaurar codigo/configuracion/documentos/base compatibles. No restaurar automaticamente una base anterior si ya contiene trabajo real posterior. Git no sustituye SQLite ni documentos.

ERP 4 puede comenzar como siguiente fase autorizada, reutilizando contratos de pagador, cobro, devolucion y hechos economicos; **no se ha comenzado**.
