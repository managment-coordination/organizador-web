# ERP 2 - Presupuestos y cuotas: implementacion

Estado: ERP 2A COMPLETADO, 10/09/2026. Implantacion certificada de ERP 2: 25%. Aceptacion funcional del flujo completo: pendiente de ERP 2B-2E.

[Diseno funcional y UX](ERP_02_PRESUPUESTOS_CUOTAS_DISENO.md) | [Modelo y contratos](ERP_02_MODELO_CALCULO_CONTRATOS.md) | [Roadmap ERP](ERP_COMUNIDADES_ROADMAP.md)

## Linea base, checkpoint y backup previo

- Commit inicial ERP 2A: `2e7f642c5aa6383cae4174e7c4de475127f044f3` (`Document and close ERP 2 design`).
- Tag previo: `pre-erp2a-20260910`.
- Base productiva previa: integridad `ok`, 91 tablas, migraciones ERP 1 y 2 aplicadas, servicio `organizador-web.service` activo.
- Backup independiente previo: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-150439`.
- El manifiesto identifica el commit, conserva SQLite mediante API de backup, aplicacion/configuracion/documentos y hashes SHA-256.
- Restauracion previa verificada en `/tmp/organizador-erp0-restore-8muaacck`: integridad `ok`, 91 tablas y runtime accesible. No sustituye ni sobrescribe backups ERP 0/1.
- Copia de trabajo local ignorada por Git: `backups/erp2a-source-20260910-150439.db`; se utiliza solo como fuente de pruebas aisladas.

## Alcance ERP 2A implementado

ERP 2A implementa exclusivamente el bloque definido en el contrato vigente: capacidades, contratos, migracion aditiva, compatibilidad y pruebas sinteticas. No activa todavia servicios de calculo, pantallas ni emision.

1. Migracion ERP `3 / erp2a_budget_foundations`, ordenada, transaccional y con checksum. Las migraciones 1/2 no se modifican.
2. Modelo persistente preparado para presupuestos/versiones, capitulos, partidas, asignaciones multiples, financiaciones, excepciones, reglas versionadas, simulaciones/snapshots, planes/periodos, derramas, regularizaciones, ocupacion, destinatario/pagador e importacion en staging.
3. Capacidades economicas por usuario y comunidad separadas de los permisos operativos generales: ver, preparar, aprobar y configurar cobro. El alta futura de asignaciones recibe valores conservadores por rol; la aprobacion no se deriva de poder editar tareas.
4. Contrato `erp_budget_v1`: dinero como centimos enteros serializados en texto, decimales canonicos de hasta 30 posiciones, periodicidades y reglas enumeradas, motor/redondeo versionados y prohibicion expresa de formulas ejecutables.
5. Catalogo interno informa los contratos previstos como `not enabled`. Ningun comando ERP 2 se ha habilitado sin servicio determinista.
6. Frontera preparada con ERP 3: planes y snapshots no son recibos, no modifican deuda y no materializan emisiones.

## Invariantes estructurales

- Toda entidad economica nueva tiene comunidad explicita; las relaciones criticas usan FK compuesta por comunidad cuando el padre la permite.
- No existen columnas nuevas `REAL`, `FLOAT` o `DOUBLE` en el dominio ERP 2A.
- Presupuesto, partida y cuenta PGC permanecen conceptos distintos.
- Grupos, propiedades, propietarios, titularidades, coeficientes y ejercicios siguen siendo los maestros ERP 1; no se han duplicado.
- El esquema puede conservar el snapshot exacto del presupuesto aprobado, incluida la referencia de grupos, pertenencias, coeficientes, reglas, calculos y residuos.
- Configuracion de recibo tiene vigencia por fecha efectiva, preparada para resolver destinatario en la futura fecha real de emision. No incorpora prorrateo.
- Regularizacion conserva por linea debido, emitido neto, cobrado informativo, ajustes anteriores y la restriccion exacta `diferencia = debido - emitido_neto - ajustes_previos`.
- La base no permite que un fallo de insercion transversal deje una operacion parcial en las pruebas transaccionales.

## Decisiones tecnicas

- Se creo un servicio de contratos separado (`budget_contracts.py`) y no se amplio `master_service.py`: datos maestros y economia mantienen limites claros.
- Las capacidades economicas se guardan en `erp_presupuesto_permisos`, relacionadas con usuario y comunidad. Esto evita cambiar el significado de permisos operativos ya publicados y permite administrarlas expresamente en la UX futura.
- Los resultados monetarios persistidos usan centimos enteros; los importes exactos no monetizados y parametros usan texto decimal. La API futura no transportara dinero mediante `Number` JavaScript.
- Los comandos/consultas previstos aparecen en el catalogo pero el dispatcher los rechaza hasta que exista su implementacion determinista. No hay endpoint parcialmente funcional.
- `fecha_emision_prevista` y la vigencia de configuracion quedan separadas; la fecha efectiva y el snapshot definitivo pertenecen al acto de emision ERP 3.

## MEJORA AUTÓNOMA IMPLEMENTADA

Problema: la puerta de publicacion solo ejecutaba regresion ERP 1 y podia desplegar en el futuro una migracion ERP 2A rota.

Solucion: `deploy-operational-release.py` ejecuta tambien `verify-erp2a-foundations.py` en staging, antes de detener el servicio o aplicar codigo. Beneficio: cualquier fallo de esquema, aislamiento, precision o compatibilidad bloquea la publicacion sin tocar produccion. Impacto: solo aumenta el tiempo de validacion previa; no cambia datos ni interfaz. Prueba: ejecucion completa contra copia consistente de la base productiva.

## Pruebas y evidencias

`scripts/verify-erp2a-foundations.py` se ejecuta siempre sobre copia temporal. Verifica:

- migracion 3 y reaplicacion sin cambios;
- integridad SQLite y `foreign_key_check` vacio;
- recuentos y hashes invariables de propiedades, propietarios, relaciones, recibos y censo de asamblea;
- presencia del modelo objetivo y ausencia de tipos flotantes nuevos;
- permisos economicos y denegacion transversal;
- fixture comunidad-ejercicio-presupuesto-capitulo-partida-grupo-regla-snapshot-plan-periodo;
- rollback completo ante FK de otra comunidad;
- contrato de dinero/decimales, catalogo sin formulas y sin emision;
- rechazo de comandos ERP 2 aun no habilitados;
- backup sintetico posterior restaurable.

Regresion ejecutada contra copia real: ERP 0 completa; ERP 1 completa, incluidos 40 inmuebles/16 miembros, copropiedad, titularidad temporal, coeficientes multiples, permisos, auditoria, outbox, deuda y asamblea intactas. Sintaxis Python y `git diff --check` correctos.

## Checkpoints

- PRE ERP 2A: `pre-erp2a-20260910` (`2e7f642`).
- POST MIGRACION: `erp2a-post-migration-20260910` (`152191b`).
- POST MOTOR y POST UX/INTEGRACION: no se crean artificialmente; pertenecen a ERP 2B/2C segun el diseno cerrado.
- CIERRE ERP 2A: se registra en el commit/tag final de esta entrega tras validar y publicar.

## Alcance no implementado

ERP 2B-2E permanecen pendientes: motor racional, snapshots calculados, redondeo espacial/temporal, servicios de presupuesto, copia/importacion operativa, simulacion/comparacion/aprobacion, UX, ocupacion/configuracion operativa, derramas, regularizaciones y explicabilidad. No hay recibos, cobros, SEPA, conciliacion, asientos ni IA economica.

La matriz de 30 casos del diseno se conserva para esas fases. En ERP 2A solo se prueban sus precondiciones estructurales; no se declara que una tabla vacia equivalga a una funcionalidad terminada.

## Estado final

ERP 2A acredita el hito 1 del roadmap: contrato de dominio y migracion validados sobre copia. Por metodologia acordada, ERP 2 pasa de 0% a 25% de implantacion. No se concede porcentaje de servicios, recorrido funcional ni aceptacion de usuario.
