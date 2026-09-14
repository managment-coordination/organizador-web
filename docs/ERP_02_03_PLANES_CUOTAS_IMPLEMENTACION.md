# Ampliacion posterior ERP 2/3: planes de cuotas activos

Fecha: 14/09/2026. No reabre los cierres certificados ERP 0-4 ni inicia ERP 5.
Referencia: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md), contratos [ERP 2](ERP_02_PRESUPUESTOS_CUOTAS_IMPLEMENTACION.md), [ERP 3](ERP_03_RECIBOS_COBROS_DEUDA.md) y [ERP 4](ERP_04_DOMICILIACIONES_SEPA_REMESAS.md).

## Estado y checkpoint

Implementacion en PRUEBAS; cierre/publicacion pendientes. No atribuir 100% por el codigo.
Checkpoint previo `planes-cuotas-pre-20260914`, commit `8187e279e245804802e8cf3565ff8f9f43067679`.
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
- Cero recibos nuevos aparece como `0`, no como celda vacia; volver a editar conserva campos y reconfigura las opciones visibles.

## Evidencia de pruebas

`verify-quota-plans.py`: copia sintetica 40/16; presupuesto 1.000.000 EUR y manual 40.000 EUR. Enero genera 56 recibos, no 80 si solo 16 pertenecen al segundo grupo. Enero exacto con politica certificada: 86.667,04 EUR; la distribucion de residuos por propiedad no equivale a redondear un unico total mensual. Los 12 periodos, si permanecen activos, suman 1.040.000,00 EUR.
Febrero con manual desactivado genera solo 40 ordinarios; enero no cambia.
Reintento y segunda revision sin duplicados; fallo inyectado en segundo plan revierte toda la emision; propuesta obsoleta rechazada; version futura/retroactiva; regularizacion emitido impagado aprobada y materializada; auditoria; FKs; reproduccion racional; cuatro frecuencias y ambos modos; fijo/unidades; remesa ERP 4 sintetica.

`verify-quota-plans-web.mjs`: shell completo, login real, puente ERP, crear/corregir/confirmar/desactivar, 56 recibos y reemision cero; capturas escritorio 1440/1920 y movil 390/360 sin desbordamiento horizontal. Capturas inspeccionadas, sin errores JavaScript.
ERP 0, ERP 1, ERP 2 completo y motor ERP 2B: regresiones locales correctas.
Regresion completa ERP 3/4 local interrumpida por espacio temporal (no fallo de dominio): repetir en copia Ubuntu antes de publicar; no certificar ejecuciones incompletas.

## Pendientes exactos de cierre

1. Ejecutar las pruebas ampliadas y regresion completa ERP 0-4 en staging Ubuntu; verificar preservacion de todas las tablas existentes al migrar.
2. Revalidar navegador con el codigo final y publicar solo tras superar las puertas de seguridad.
3. Checkpoint final, backup posterior y restauracion aislada; smoke de Ubuntu, rutas, autorizacion e integridad.
4. Sustituir este estado por la evidencia final y actualizar roadmap sin modificar porcentajes certificados ERP 2/3/4.

## Restauracion y limites

Usar backup ERP 0 compatible de codigo, SQLite, documentos y configuracion. Git no sustituye el backup. Preservar primero operaciones nuevas posteriores al checkpoint antes de restaurar; no sobrescribirlas silenciosamente.
No scheduler desatendido: la automatizacion consiste en detectar/generar todos los planes al ejecutar la accion revisada. No crea agentes, contabilidad, SEPA nuevo ni conciliacion ERP 5.
Sin autoactivacion de planes heredados, sin fusion de conceptos, sin reinterpretacion del historico.
