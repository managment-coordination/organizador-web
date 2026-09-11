# ERP 3 - Implementacion de recibos, cobros y deuda

Fecha: 11/09/2026. Estado: DESARROLLO. **ERP 3 no esta completado ni publicado. Implantacion certificada: 0%.** El porcentaje no mide lineas de codigo: todavia no esta cerrado el primer hito completo de contratos/migracion/compatibilidad. Diseno cerrado: 100%; aceptacion funcional completa: no ejecutada.

Contrato obligatorio: [ERP 3 ratificado](ERP_03_RECIBOS_COBROS_DEUDA.md). [Roadmap](ERP_COMUNIDADES_ROADMAP.md). Sin cambios en las seis decisiones ni avance ERP 4/5/6.

## Checkpoint y respaldo

- Codigo previo `b4ee95a`; contrato ratificado incorporado a Git en `feebc61`.
- Checkpoint recuperable `erp3-pre-20260911` en `feebc61`.
- Backup Ubuntu valido: `/home/coordinador/apps/organizador-web/backups/erp3-pre-20260911-105917`. SQLite mediante backup API, archivo de codigo/configuracion/documentos y `SHA256SUMS.json`. Restauracion aislada `restore-check.db`, integridad y FKs correctas. Parada breve solo de `organizador-web.service`, reiniciado al terminar; UNO Marbella intacto.
- Intento previo `erp3-pre-20260911-105815` NO valido para cierre: tar detecto cambios mientras leia `data/`. Se conserva, pero no se usa como checkpoint recuperable.
- Copia local de trabajo: `%TEMP%/erp3-source-20260911.db`. Cada prueba crea otra copia temporal; nunca modifica esta fuente ni la base del servidor.
- Restauracion: verificar checksums del backup valido; preservar operaciones posteriores; restaurar codigo/configuracion/documentos compatibles y base desde backup con servicio detenido. No restaurar datos antiguos solo para deshacer codigo no publicado. Git no sustituye backup de SQLite.

## Implementacion existente, aun no certificada como fase

- Migracion 7 aditiva en `receivables_schema.py`, registrada en el mecanismo versionado existente. Tablas separadas para recibos/sujetos/detalles, cobros/imputaciones, devoluciones, rectificaciones, creditos, reintegros, eventos, responsabilidad, aperturas e importacion. No copia ni convierte automaticamente datos legacy. Triggers preservan originales y hechos; solo versiones operativas permitidas pueden cambiar.
- Contratos estrictos de dinero basados en `Money` ERP 2: centimos enteros, rango limitado, JSON monetario como texto; rechazo de float/bool, fechas invalidas y campos inesperados.
- Servicios internos con permisos ERP 3 explicitos por comunidad, sesion refrescada, rechazo por defecto, idempotencia, version esperada, transaccion, auditoria y outbox. No heredan permisos de tareas o presupuestos. Ninguna capacidad ordinaria se concede automaticamente.
- Emision en dominio desde plan/simulacion aprobados ERP 2, sin recalcular cuotas. Obligados configurados explicitamente, destinatario/pagador a fecha de emision, detalle congelado, propuesta y confirmacion, control de doble obligacion.
- Registro de cobros independientes; propuesta/confirmacion de imputaciones N:M, saldos libres y control de versiones de ambos extremos.
- Proyecciones exactas de recibo/cobro con corte efectivo y conocimiento; validacion de cortes posteriores para no dejar sobregiros retroactivos.
- Devolucion parcial/total con contramovimiento de imputaciones y fondos libres; abono limitado al pendiente; anulacion solo sin movimientos; clasificacion incobrable mediante propuesta/confirmacion sin reducir saldo.

Los servicios **todavia no estan registrados en dispatcher/API ni integrados en web**. Las tablas de un recorrido no implican que sus servicios ya existan. No activar ERP 3 por la mera presencia de la migracion.

## Evidencia de pruebas parcial

- `verify-erp3-foundations.py`: 9 pruebas sobre copia. Migracion reentrante, restauracion aislada, importes exactos, parcialidad/sobrepago, varios cobros, propuesta obsoleta, corte historico, devolucion parcial, abono/anulacion, rollback inyectado, originales inmutables, FK transversal rechazada, permisos sin concesion implicita y reintentos. Ultima evidencia: `%TEMP%/organizador-erp3-foundations-pw0ix91n`.
- `verify-erp3-emission.py`: fixture integral ERP 2 de 40 viviendas/16 jardines; 40 cargos de un periodo desde resultado congelado, detalles suman 46.704 centimos, reintento no duplica y nueva propuesta para mismo origen se bloquea. Evidencia `%TEMP%/organizador-erp3-emission-1up5p47m`. No es prueba de importacion real ni de emision por web.
- `verify-erp2-complete.py`: regresion completa superada con migracion 7, incluidos 40/16, presupuesto inmutable, copia/importacion, derrama, regularizaciones, inquilino/pagador, permisos y restauracion. Fixture conservado `%TEMP%/organizador-erp2-complete-ety6mkhl`.
- `verify-erp1-master-data.py`: regresion maestra superada; mantiene su propio alcance certificado de migracion ERP 1. No se usa como prueba de la totalidad de ERP 3.
- Regresion HTTP operativa `verify-operational-release.mjs` superada: ERP 0, sesiones/permisos, tareas/proyectos, documentos/informes, presidencia, seguridad, asambleas, IA y consultas. Evidencia `%TEMP%/organizador-release-yMisYW`; no sustituye las pruebas pendientes de ERP 3.
- No pruebas UX ERP 3: su interfaz no esta implementada. No despliegue ni migracion productiva.

## Pendientes obligatorios para continuar

1. Cerrar ERP 3A: adaptador legacy observado/aperturas/cobertura y enlaces de origen, staging y deduplicacion entre archivos; inventario de consumidores y compatibilidad. Completar constraints y permisos/evidencias en todos los recorridos, no solo los probados.
2. ERP 3B: regularizaciones emitidas/abonadas y adaptador de cobertura ERP 2; politicas y cargos separados por gastos de devolucion; desimputacion/reintegros/creditos y abono sobre cobrado atomico; reasignaciones excepcionales con distribucion de responsabilidad y corte; aperturas/movimientos; deuda filtrada/antiguedad, eventos completos y contratos ERP 4/5/6. El abono de un recibo cobrado actualmente se bloquea: falta el flujo atomico de liberar fondos y abonar, no es un cambio de politica.
3. Revisar emision: fuentes rectoras/activacion por cobertura, sustitucion documentada de anulados, sublotes grandes, casos de destinatario antes/despues, periodos futuros y sujetos incompletos. El control conservador actual bloquea reemision incluso tras anulacion; falta el reemplazo explicito.
4. ERP 3C: registro allow-listed de comandos/consultas, endpoints existentes, UI profesional Gestion > Ingresos y recibos, fichas contextuales, permisos configurables, documentos e historico. Migrar lectores existentes solo con equivalencia/cobertura probadas; sin escritura dual.
5. ERP 3D: 35 casos del contrato, concurrencia real, sesiones/roles, auditoria e idempotencia de todos los comandos, regresion completa, recorrido Playwright escritorio/movil, backups posteriores/restauracion y publicacion controlada.

## Riesgos y limites actuales

No utilizar el dominio parcial para operar dinero real. Persisten huecos de servicios y validacion de evidencia documental: `EvidenceRef` acredita forma de referencia, no por si sola la existencia/acceso al archivo. Validar referencias antes de publicar los comandos que las requieren. La config de obligados temporal necesita completar casos de sucesion/correccion antes de certificarse. No convertir datos observados a validados por rellenar una FK. La migracion 7 solo se ha aplicado a copias y puede ajustarse hasta cerrar 3A; una vez certificada/publicada su checksum sera inmutable.

No se ha identificado una nueva decision funcional material que deba tomar el usuario. Lo pendiente es implementacion y verificacion conforme al contrato, no una reapertura de D1-D6. Configuracion de usuarios/cobertura/corte reales sigue siendo puerta de activacion, no autorizacion inferida del cierre de diseno.

Checkpoint de avance local: `erp3-progress-domain-20260911`. No es checkpoint de certificacion ni cierre de ERP 3. Produccion permanece en el rediseno UX certificado, esquema 6; migracion 7 y comandos parciales no publicados. Conservar las pruebas actuales como regresion al completar servicios, sin usarlas para afirmar los 35 casos de aceptacion.
