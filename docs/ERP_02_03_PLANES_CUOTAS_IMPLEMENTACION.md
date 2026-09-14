# Ampliacion posterior ERP 2/3: planes de cuotas activos

Fecha: 14/09/2026. No reabre los cierres certificados ERP 0-4 ni inicia ERP 5.
Referencia: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md), contratos [ERP 2](ERP_02_PRESUPUESTOS_CUOTAS_IMPLEMENTACION.md), [ERP 3](ERP_03_RECIBOS_COBROS_DEUDA.md) y [ERP 4](ERP_04_DOMICILIACIONES_SEPA_REMESAS.md).

## Estado y checkpoint

Implementacion COMPLETADA, 100% certificado: migracion, dominio, recorrido integrado y aceptacion/publicacion/restauracion acreditados. Los porcentajes certificados ERP 2/3/4 no cambian.
Checkpoint previo `planes-cuotas-pre-20260914`, commit `8187e279e245804802e8cf3565ff8f9f43067679`.
Checkpoints de avance `planes-cuotas-progress-20260914` (`fac8364`), revision UX `5c992ab`, proteccion de regularizaciones `aeba91a`; codigo final publicado `b2329cdb13d4d003f9557c620d87563bfa5e1cd5`. Checkpoint de cierre `planes-cuotas-completed-20260914` incluye esta documentacion.
Backup independiente Ubuntu:
`/home/coordinador/apps/organizador-web/backups/planes-cuotas-pre-20260914/erp0-backup-20260914-095239`.
Restauracion previa verificada: 205 tablas, integridad, FK y arranque; copia local `backups/planes-cuotas-pre-20260914.db`.
La custodia ERP 4 no se cambia; activacion bancaria real permanece deshabilitada.

## Implementacion

- Migracion 19 aditiva: historial operativo `erp_plan_operativo_versiones`, actividad `erp_plan_actividad` y vinculos de recibos `erp_plan_emision_vinculos`. Historicos inmutables mediante triggers y FKs por comunidad.
- Reutiliza `erp_planes_cuota`, versiones, calendarios y simulaciones ERP 2; no crea otro libro de cuotas/deuda.
- Presupuesto: consume su plan y snapshot completos aprobados. No crea una segunda cuota ordinaria ni vuelve a cargar sus partidas por separado. Importes, reglas y calendario aprobados siguen protegidos.
- Manual: usa el mismo motor y persistencia de snapshots; origen explicito `importe_manual`, sin inventar un presupuesto. El tipo tecnico existente `derrama` permite alojar este origen sin alterar enums historicos; la interfaz utiliza Plan de cuotas.
- Total anual: politica certificada de mayores restos por propiedad y despues por periodo. Cada propiedad conserva exactamente su anual; la suma del ejercicio tambien.
- Importe por periodo: el adaptador `erp2-periodic-plan-v1` repite el reparto certificado del objetivo de cada periodo. Guarda el calculo racional de cada periodo y la agregacion anual con base/ajuste coherentes. El motor historico `erp2-rational-v1` no cambia para entradas anteriores.
- Mensual/trimestral/semestral/anual; calendario del ejercicio, sin prorrateos. Vigencia final exclusiva. Una version iniciada dentro de un periodo se aplica al siguiente periodo completo; no divide la cuota de ese periodo.
- Activacion/desactivacion con fecha, actor, motivo, control de version e idempotencia. Nueva configuracion confirmada supone activacion explicita, no emision en segundo plano.
- Emision por ejercicio/inicio de periodo/fecha efectiva de emision: detecta todos los planes aplicables, muestra nuevos/ya existentes/incidencias y requiere confirmacion. Atomicidad conjunta, reservas economicas y validaciones ERP 3 reutilizadas. Limite actual de revision atomica: 500 recibos; no guarda parcialmente.
- Un recibo normal ERP 3 por propiedad/plan/periodo; conceptos distintos no se fusionan. Los existentes conservan datos, destinatario, pagador y snapshot. La version no permite volver a cobrar una obligacion ya emitida.
- Los destinatarios/pagadores se resuelven en fecha efectiva de emision mediante ERP 2/3, no por porcentaje de copropiedad. Los obligados requieren configuracion acreditada, no se deducen automaticamente del propietario actual.
- Regularizacion manual o presupuestaria: reutiliza calculo ERP 2 contra emitido neto y materializacion ERP 3. No carga otra vez lo emitido e impagado ni reescribe recibos. La aprobacion y posterior emision de cargos/abonos siguen siendo operaciones revisadas separadas.
- Compatible con ERP 4: recibos ordinarios, elegibilidad/reservas/remesas sin categoria economica paralela; no genera cobros al exportar.

## Recorrido y permisos

Presupuestos -> Planes activos y emision por periodo; tambien Ingresos y recibos -> Planes de cuotas.
Nuevo plan -> origen -> importe/modo/frecuencia/grupo/regla -> vigencia -> revisar -> guardar.
Listado: estado, proxima fecha, historico, editar, activar/desactivar, regularizar.
Generar recibos por periodo -> ejercicio -> periodo -> fecha de emision -> revisar todos los planes -> confirmar.

Permisos backend separados: `read`, `plan_create`, `plan_modify`, `plan_activate`, `prepare_emission`, `confirm_emission`; no concede permisos bancarios nuevos.
La fuente/corte economico se acredita con el servicio de cobertura ERP 3 existente. Accion contextual Fuente de emision evita pedir al usuario la clave tecnica del concepto. Si hay historico externo/conflictos no se sustituye automaticamente: bloquear y revisar la cobertura existente. Requiere permiso `configure` y evidencia.

## Mejoras autonomas

- Periodos superpuestos de distinta frecuencia bloquean una nueva emision; no prorrateo ni doble cargo para sustituir calendarios.
- Una propuesta se vuelve a validar completa antes de confirmar: cambios de estado, maestros, destinatarios o recibos impiden confirmar una revision obsoleta.
- Composicion transaccional verifica que la conexion compartida corresponde a la misma base de datos.
- La firma de regularizacion incorpora el resultado calculado para distinguir versiones economicas con las mismas propiedades/periodos.
- Una regularizacion aprobada no nula sobre un periodo todavia no emitido bloquea la posterior emision de la cuota completa superpuesta: evita duplicar el cargo sin compensaciones silenciosas. Requiere revisar los cargos/abonos existentes.
- Cero recibos nuevos aparece como `0`, no como celda vacia; volver a editar conserva campos y reconfigura las opciones visibles.

## Evidencia de pruebas

`verify-quota-plans.py`: copia sintetica 40/16; presupuesto 1.000.000 EUR y manual 40.000 EUR. Enero genera 56 recibos, no 80 si solo 16 pertenecen al segundo grupo. Enero exacto con politica certificada: 86.667,04 EUR; la distribucion de residuos por propiedad no equivale a redondear un unico total mensual. Los 12 periodos, si permanecen activos, suman 1.040.000,00 EUR.
Febrero con manual desactivado genera solo 40 ordinarios; enero no cambia.
Reintento y segunda revision sin duplicados; fallo inyectado en segundo plan revierte toda la emision; propuesta obsoleta rechazada; version futura/retroactiva; regularizacion emitido impagado aprobada y materializada; auditoria; FKs; reproduccion racional; cuatro frecuencias y ambos modos; fijo/unidades; remesa ERP 4 sintetica.

`verify-quota-plans-web.mjs`: shell completo, login real, puente ERP, crear/corregir/confirmar/desactivar, 56 recibos y reemision cero; capturas escritorio 1440/1920 y movil 390/360 sin desbordamiento horizontal. Capturas inspeccionadas, sin errores JavaScript.
ERP 0, ERP 1, ERP 2 completo y motor ERP 2B: regresiones locales correctas.
La regresion local ERP 3/4 se interrumpio por espacio temporal; no se cuenta como superada. Se completo en copias Ubuntu: ERP 3 42/42 y ERP 4 92/92. Tras la ultima proteccion de regularizaciones se repitieron ERP 0/1/2, motor 2B, las 20 comprobaciones agrupadas de planes, ERP 3 42/42, seis casos bancarios criticos, adaptador SEPA 17/17 y seguridad HTTP. Las 92 pruebas bancarias completas corresponden a la puerta anterior, no a una supuesta segunda ejecucion completa final.
Recorrido web revalidado contra shell y puente reales de Ubuntu aislado: Fuente de emision, correccion de propuesta, guardado, desactivacion, 56 recibos y segunda revision cero; cuatro anchuras sin desbordamiento ni errores JavaScript.

## Publicacion y restauracion verificadas

Staging final: `/home/coordinador/apps/organizador-web/backups/stage-erp4-20260914-102620`. La migracion conserva las 203 tablas de negocio anteriores; las dos tablas de metadatos de migracion se verifican por separado.
Publicacion Ubuntu, servicio independiente `organizador-web.service`, puerto 8771. Smoke: health, interfaz, rutas ERP 3/4 sin sesion rechazan con 401, integridad SQLite y FKs correctas, historicos preservados. No se toca UNO Marbella.
Backup previo a publicar: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260914-103058`; restauracion aislada `verification/organizador-erp0-restore-kbqd7d72`, 205 tablas y arranque correcto.
Backup posterior: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260914-103255`; restauracion aislada `verification/organizador-erp0-restore-h5nxlqy7`, 208 tablas y arranque correcto. Ambos directorios de restauracion estan dentro del staging final; firmas de datos coinciden con sus backups.
Evidencia estructurada: `erp4-publication-proof.json` dentro del backup posterior; codigo `b2329cd`, integridad/FK e historicos correctos, planes activos disponibles y operativa bancaria real deshabilitada.
Sin pendientes funcionales de esta ampliacion. Para usarla en una comunidad real siguen siendo necesarios permisos, fuente/corte de emision y obligados acreditados; no se inventan ni activan datos reales. Limpiar espacio temporal del PC queda como mantenimiento del entorno, no defecto del dominio.

## Restauracion y limites

Usar backup ERP 0 compatible de codigo, SQLite, documentos y configuracion. Git no sustituye el backup. Preservar primero operaciones nuevas posteriores al checkpoint antes de restaurar; no sobrescribirlas silenciosamente.
No scheduler desatendido: la automatizacion consiste en detectar/generar todos los planes al ejecutar la accion revisada. No crea agentes, contabilidad, SEPA nuevo ni conciliacion ERP 5.
Sin autoactivacion de planes heredados, sin fusion de conceptos, sin reinterpretacion del historico.
