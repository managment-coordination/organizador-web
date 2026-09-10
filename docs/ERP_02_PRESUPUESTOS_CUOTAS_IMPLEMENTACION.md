# ERP 2 - Presupuestos y cuotas: implementacion

Estado: ERP 2 COMPLETADO, 10/09/2026. Implantacion y aceptacion funcional certificadas: 100%.

[Diseno funcional y UX](ERP_02_PRESUPUESTOS_CUOTAS_DISENO.md) | [Modelo y contratos](ERP_02_MODELO_CALCULO_CONTRATOS.md) | [Roadmap ERP](ERP_COMUNIDADES_ROADMAP.md)

## Linea base, checkpoint y backup previo

- Commit inicial ERP 2A: `2e7f642c5aa6383cae4174e7c4de475127f044f3` (`Document and close ERP 2 design`).
- Tag previo: `pre-erp2a-20260910`.
- Base productiva previa: integridad `ok`, 91 tablas, migraciones ERP 1 y 2 aplicadas, servicio `organizador-web.service` activo.
- Backup independiente previo: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-150439`.
- El manifiesto identifica el commit, conserva SQLite mediante API de backup, aplicacion/configuracion/documentos y hashes SHA-256.
- Restauracion previa verificada en `/tmp/organizador-erp0-restore-8muaacck`: integridad `ok`, 91 tablas y runtime accesible. No sustituye ni sobrescribe backups ERP 0/1.
- Copia de trabajo local ignorada por Git: `backups/erp2a-source-20260910-150439.db`; se utiliza solo como fuente de pruebas aisladas.
- Backup previo ERP 2B: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-160027`; restauracion aislada correcta, integridad `ok`, 128 tablas y runtime accesible.

## Alcance ERP 2A implementado

ERP 2A implementa exclusivamente el bloque definido en el contrato vigente: capacidades, contratos, migracion aditiva, compatibilidad y pruebas sinteticas. No activa todavia servicios de calculo, pantallas ni emision.

1. Migracion ERP `3 / erp2a_budget_foundations`, ordenada, transaccional y con checksum. Las migraciones 1/2 no se modifican.
2. Modelo persistente preparado para presupuestos/versiones, capitulos, partidas, asignaciones multiples, financiaciones, excepciones, reglas versionadas, simulaciones/snapshots, planes/periodos, derramas, regularizaciones, ocupacion, destinatario/pagador e importacion en staging.
3. Capacidades economicas por usuario y comunidad separadas de los permisos operativos generales: ver, preparar, aprobar y configurar cobro. El alta futura de asignaciones recibe valores conservadores por rol; la aprobacion no se deriva de poder editar tareas.
4. Contrato `erp_budget_v1`: dinero como centimos enteros serializados en texto, decimales canonicos de hasta 30 posiciones, periodicidades y reglas enumeradas, motor/redondeo versionados y prohibicion expresa de formulas ejecutables.
5. El catalogo interno nacio con contratos deshabilitados y, tras ERP 2B, solo se activo al quedar enlazado con servicios deterministas, permisos y pruebas.
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

## ERP 2B - motor determinista

- Motor puro `budget_engine.py`, sin acceso a base de datos, red, IA ni estado global. Recibe exclusivamente un manifiesto estructurado/versionado y utiliza enteros y racionales `Fraction`.
- Reglas ejecutables: coeficiente, partes iguales, importe fijo, unidades, porcentaje especial y mixta controlada de un nivel. Consumo permanece preparado pero no ejecutable.
- Asignaciones por importe o porcentaje exclusivo, multiples grupos por partida, financiacion explicita y exclusion con redistribucion declarada. Los descuadres no se corrigen silenciosamente.
- Mayores restos espacial sobre magnitudes, con desempate por identificador estable; importes negativos conservan signo y criterio. La suma distribuida coincide exactamente con el objetivo.
- Periodificacion por pesos aprobados y orden cronologico estable. Cada linea anual coincide exactamente con la suma de sus periodos para mensual, trimestral, semestral y anual.
- Resultado explicable por propiedad, partida, asignacion, grupo, regla, valor, racional exacto, base, ajuste de centimo, importe final y periodo.
- `budget_simulation.py` calcula fuera del bloqueo y guarda manifest, resultado, lineas, componentes, periodos e incidencias en una unica transaccion. La huella de entrada hace idempotente la persistencia.
- Migracion aditiva `4 / erp2b_deterministic_results`: separa los periodos de simulacion del futuro plan aprobado y conserva trazas de componentes y residuos. No modifica ni elimina tablas ERP 2A.
- La simulacion se expone exclusivamente a traves del servicio ERP 2 y reutiliza este motor; no existe un segundo calculo en Node ni en el navegador.

### MEJORA AUTÓNOMA IMPLEMENTADA ERP 2B

Problema: la tabla de periodos calculados de ERP 2A dependia de un plan de cuota, pero una simulacion debe existir antes de aprobar y crear ese plan.

Solucion: periodos propios de simulacion y resultados periodicos separados, enlazados al snapshot calculado. Beneficio: simular no crea planes ni anticipa ERP 3, y el aprobado futuro puede consumir el resultado sin recalcularlo. Impacto: migracion aditiva de cuatro tablas, sin cambio de datos previos. La puerta de despliegue ejecuta desde ahora la regresion ERP 2B completa.

## ERP 2C-2E - servicios, integracion y aceptacion

- Servicio de dominio `budget_service.py` para presupuestos, versiones, capitulos, partidas, repartos, exclusiones, simulacion, comparacion, aprobacion, planes de cuota, ocupacion, destinatario/pagador, derramas, regularizaciones e importacion.
- Migracion aditiva `5 / erp2_complete_workflow`: configuracion periodica por comunidad, valores de unidades por reparto, calendario de derramas, huella semantica de regularizacion e indices. Triggers de base de datos protegen presupuestos, versiones y derramas aprobados incluso fuera del servicio.
- Crear presupuesto admite partir de cero, copiar uno anterior conservando correspondencia o importar texto tabular mediante staging, incidencias, vista previa y confirmacion idempotente.
- Edicion en borrador conserva version concurrente; capitulos, partidas, varios grupos, reglas y exclusiones se guardan como una operacion coherente. Proponer y aprobar son acciones expresas.
- Simulacion y aprobacion consumen el motor ERP 2B. La aprobacion congela manifest, resultados, periodos, destinatarios previstos y plan; no emite recibos.
- Comparacion disponible por total, capitulo, partida y propiedad cuando existe una simulacion comparable y continuidad fiable.
- Cuotas calculadas y consulta "Por que paga esto" reconstruyen capitulo, partida, regla, valor exacto, ajuste de redondeo y resultado sin exponer IDs tecnicos en el flujo habitual.
- Derramas tienen reparto y calendario propios, simulacion, aprobacion inmutable, plan explicable e historico, incluso cuando abarcan mas de un ejercicio.
- Regularizaciones calculan debido menos emitido neto menos ajustes aprobados previos; un pendiente ya emitido se descuenta. La entrada manual revisada es un adaptador temporal hasta ERP 3 y nunca reescribe recibos.
- La ficha de propiedad gestiona ocupacion historica, destinatario, pagador y preferencia de cuenta sin alterar titularidad ni anticipar mandatos SEPA.

### MEJORAS AUTÓNOMAS IMPLEMENTADAS ERP 2C-2E

- Dinero tratado como texto/centimos y `BigInt` en navegador para evitar conversiones binarias de `Number`.
- Presupuesto y derrama aprobados protegidos por servicio y por triggers SQLite; no se permite volver a simular ni editar silenciosamente un aprobado.
- Copia de presupuesto conserva claves de continuidad para comparaciones robustas sin emparejar por parecido textual.
- Regularizaciones tienen huella semantica y descuentan ajustes previos para que repetir una propuesta no duplique cargos o abonos.
- La interfaz separa Presupuestos, Cuotas calculadas, Derramas y Regularizaciones; parametros avanzados y exclusiones permanecen plegados hasta necesitarlos.
- La puerta de publicacion incorpora `verify-erp2-complete.py` y la prueba visual incluye Presupuestos en escritorio y movil.
- Ajuste UX posterior al cierre: una comunidad sin ejercicio ofrece crearlo desde el propio flujo de Nuevo presupuesto y continua automaticamente. Las acciones de preparar, aprobar y configurar se muestran segun los permisos economicos efectivos; un perfil preparador como Elena no ve acciones de aprobacion que no puede ejecutar.

## Decisiones tecnicas

- Se creo un servicio de contratos separado (`budget_contracts.py`) y no se amplio `master_service.py`: datos maestros y economia mantienen limites claros.
- Las capacidades economicas se guardan en `erp_presupuesto_permisos`, relacionadas con usuario y comunidad. Esto evita cambiar el significado de permisos operativos ya publicados y permite administrarlas expresamente en la UX futura.
- Los resultados monetarios persistidos usan centimos enteros; los importes exactos no monetizados y parametros usan texto decimal. La API futura no transportara dinero mediante `Number` JavaScript.
- Los comandos y consultas del catalogo se registran en el dispatcher solo con servicio determinista y capacidad explicita por comunidad. No existe acceso SQL libre desde la interfaz.
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
- registro coherente de comandos ERP 2 habilitados y sus capacidades;
- backup sintetico posterior restaurable.

Regresion ejecutada contra copia real: ERP 0 completa; ERP 1 completa, incluidos 40 inmuebles/16 miembros, copropiedad, titularidad temporal, coeficientes multiples, permisos, auditoria, outbox, deuda y asamblea intactas. Sintaxis Python y `git diff --check` correctos.

### Evidencia ERP 2B

`scripts/verify-erp2b-engine.py` valida sobre copia aislada migracion 4, ausencia de tipos flotantes, mayores restos positivos/negativos, pesos 1/2/3, coeficientes porcentuales, controles de ausencia/ambiguedad/calidad, exclusiones, varios grupos por partida, importes fijos, unidades, regla mixta, cuatro periodicidades, orden arbitrario de entrada, explicacion racional, idempotencia, inmutabilidad del snapshot tras cambiar un coeficiente, rollback y aislamiento entre comunidades.

Caso de referencia superado: 40 viviendas en General y 16 bajos en Jardines privados, con coeficientes general y especial simultaneos. Solo los 16 bajos reciben la partida de jardines; ambos fondos y todos los periodos cuadran al centimo, sin modificar el coeficiente general.

### Evidencia de cierre ERP 2

`scripts/verify-erp2-complete.py` valida sobre copia aislada la migracion 5 reentrante, operacion atomica del borrador, caso 40/16, aprobacion y plan sin recibos, inmutabilidad ante cambios maestros, copia/comparacion/importacion, ocupacion y pagador, derrama plurianual, regularizacion contra emitido impagado, deduplicacion, aislamiento, auditoria, outbox, integridad y restauracion.

La regresion final incluye ERP 0, ERP 1, ERP 2A, ERP 2B y el recorrido HTTP operativo. La prueba Playwright recorre Inicio, Tareas, Proyectos, Datos maestros, Presupuestos, Administracion e IA en 1440x1000 y 390x844, sin errores JavaScript ni desbordamiento horizontal. El flujo economico se prueba sobre datos sinteticos o copias controladas; nunca sobre la base productiva durante validacion.

## Checkpoints

- PRE ERP 2A: `pre-erp2a-20260910` (`2e7f642`).
- POST MIGRACION: `erp2a-post-migration-20260910` (`152191b`).
- POST UX/INTEGRACION: `erp2-post-services-20260910` (`4a754ac`).
- CIERRE ERP 2A: `erp2a-complete-20260910`, tras validar, publicar y restaurar el backup posterior.
- PRE ERP 2B: `pre-erp2b-20260910` (`e7b244f`).
- POST MOTOR ERP 2B: `erp2b-post-engine-20260910` (`e02320e`).
- CIERRE ERP 2B: `erp2b-complete-20260910`, tras publicar y restaurar el backup posterior.
- PRE ERP 2C: `pre-erp2c-20260910` (`2486425`).
- POST SERVICIOS/INTEGRACION: `erp2-post-services-20260910` (`4a754ac`).
- CIERRE ERP 2: `erp2-complete-20260910`, tras publicacion, backup y restauracion final.

## Publicacion y restauracion final

- Candidato publicado: `8454943f9b860727bb94fbc5cf6e3aae2d4f3809` (`Close ERP 2A implementation`).
- Backup automatico inmediatamente anterior a publicar: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260910-152954`.
- Publicacion completada en `/home/coordinador/apps/organizador-web`; el servicio de usuario `organizador-web.service` queda activo y la aplicacion responde por HTTP en el puerto 8771.
- Base productiva posterior: migracion ERP 2A aplicada, integridad `ok`, 128 tablas y verificacion ERP 2A completa superada sobre copia aislada sin modificar produccion.
- Backup independiente posterior: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-153151`.
- Restauracion posterior verificada en `/tmp/organizador-erp0-restore-174eht05`: integridad `ok`, 128 tablas, commit de aplicacion reconocido y runtime accesible.

### Publicacion ERP 2B

- Candidato publicado: `e35b8374fdfb32f89ef75f00453c816ef49f1ed0` (`Document ERP 2B implementation`).
- Backup automatico inmediatamente anterior: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260910-163202`.
- Staging completo: ERP 1, ERP 2A, ERP 2B y recorrido operativo superados antes de publicar. La migracion 4 se probo sobre copia y no modifico produccion durante la verificacion.
- Produccion: servicio de usuario activo, HTTP `200`, esquema ERP version 4, 132 tablas e integridad confirmada.
- Backup independiente posterior: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-163352`.
- Restauracion posterior verificada en `/tmp/organizador-erp0-restore-db49usu7`: integridad `ok`, 132 tablas, commit reconocido y runtime accesible.

### Publicacion y cierre ERP 2

- Commit funcional: `4a754acb7670ed0da2bcb2edced3de1220c84462` (`Complete ERP 2 operational workflow`). Commit documental publicado: `ba8c2288baf2d3c8154ddb35ea8aa53b054c1220`.
- Backup independiente previo: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-180745`; restauracion aislada correcta en `/tmp/organizador-erp0-restore-2r5psnbn`.
- Staging validado: `/home/coordinador/apps/organizador-web/backups/stage-operational-20260910-180828`. La puerta ejecuto ERP 1, ERP 2A, ERP 2B, ERP 2 completo y regresion HTTP antes de publicar.
- Backup automatico de publicacion: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260910-180828`.
- Produccion: `organizador-web.service` activo, HTTP `200`, migracion ERP 5, 135 tablas, integridad `ok` y cero errores de FK. El JavaScript servido por `http://100.108.29.39:8771/` compila correctamente.
- Backup independiente posterior: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-181031`.
- Restauracion final conservada en `/tmp/organizador-erp0-restore-j1n94jgz`: integridad `ok`, 135 tablas, commit reconocido y runtime accesible.

## Limites conservados

ERP 2 calcula, explica y congela cuotas, derramas y regularizaciones. No materializa recibos, cobros, deuda, mandatos, SEPA, conciliacion, asientos ni IA economica. La preferencia de cuenta no es un mandato. La entrada manual de emitidos para regularizar se sustituira por la consulta estructurada de ERP 3 sin cambiar la formula.

## Estado final

ERP 2A acredita el hito 1; ERP 2B, el hito 2; ERP 2C-2D acreditan servicios y recorrido web; ERP 2E acredita pruebas, UX, publicacion y restauracion. Los cuatro hitos tienen evidencia y ERP 2 alcanza 100% certificado. ERP 3 permanece sin iniciar.
