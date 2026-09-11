# ERP Comunidades: roadmap de evolucion

Fecha: 11/09/2026. Documento rector del nuevo ERP. ERP 0, ERP 1 y ERP 2 estan implantados y certificados. La revision transversal previa a ERP 3 aplica el estandar [ERP UX](ERP_UX_PRINCIPIOS.md), onboarding Excel y simplificacion operativa sin cambiar porcentajes ni reglas certificadas. Las fases posteriores requieren autorizacion independiente.

## Alcance y continuidad

El modulo 06 queda cerrado por aceptacion expresa del usuario para su alcance operativo probado. El [roadmap modular](ROADMAP_REVISION_MODULAR.md) permanece como consolidacion de la app; no se sustituye ni se suman sus porcentajes a estos. Los modulos pendientes no se consideran revisados por aparecer aqui.

La linea de diseno se conserva en este roadmap, el [modelo maestro](ERP_MODELO_DATOS_MAESTROS.md) y [titularidades y reparto](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md). La evidencia de implantacion se registra separadamente en [ERP 0](ERP_00_FUNDAMENTOS_IMPLEMENTACION.md) y [ERP 1](ERP_01_DATOS_MAESTROS_IMPLEMENTACION.md).

Referencia transversal de producto: [hallazgos verificados de Gesfincas, Terranet, Fynkus y Netfincas](ERP_REFERENCIAS_SECTOR_UX.md), 11/09/2026. Consultar sus ajustes A1-A6 antes de ampliar el recorrido financiero y sus criterios P1-P8 al preparar ERP 3-7. Son recomendaciones pendientes, no nuevos dominios ni cambios aprobados de reglas. La investigacion no modifica porcentajes ni certificaciones; el rediseño general queda separado de la consolidacion inmediata.

## Medicion y estados

Estados permitidos: PENDIENTE, ANÁLISIS, DESARROLLO, PRUEBAS, BLOQUEADO, COMPLETADO.

Cada fase tiene cuatro hitos de implantacion: contrato de dominio y migracion validado sobre copia; servicios deterministas; recorrido funcional integrado; pruebas y aceptacion. Cada hito vale 25 puntos, concedidos solo con evidencia, no por redactarlo o por encontrar tablas parecidas. El porcentaje inicial certificado de implantacion es 0% en cada fase: no significa que la app parta de cero, sino que ninguna ha pasado esos hitos del nuevo ERP. No estimar un global ponderado sin desglosar esfuerzo. Reutilizacion y diseno se muestran aparte. No atribuir 100% ERP 9 al cierre del modulo 06.

La presente arquitectura es la linea base. Un cambio material se registra como decision con motivo, impacto y aprobacion; no crea una rama de desarrollo automatica. Antes de implementar cada fase, concretar el conjunto minimo de criterios y sus evidencias. Detenerse ante una decision bloqueante, sin completar porcentajes por inferencia.

## Dependencias y secuencia real

ERP 0 -> ERP 1 -> ERP 2 -> ERP 3 -> ERP 4. ERP 5 necesita 0, 1 y 3 para conciliacion de cobros. ERP 6 necesita 0 y 1; definir su contrato de hechos economicos antes de activar la emision real de ERP 3, aunque su interfaz completa venga despues. ERP 7 necesita 1, 2, 5 y 6. ERP 8 se integra progresivamente mediante contratos, sin reescribir lo operativo. ERP 9 consume servicios ya aceptados; no sustituye sus reglas.

La numeracion no obliga a duplicar cobros en 3 y 5 ni a emitir operaciones sin integracion contable: el evento economico es unico. La contabilizacion puede quedar pendiente explicitamente mientras no exista su adaptador; no se declara contabilidad definitiva ni se sustituye Netfincas durante esa transicion.

## ERP 0 - Fundamentos

- Objetivo: evolucionar el despliegue actual a un monolito modular seguro, sin reescritura total ni microservicios iniciales.
- Dependencias: cierre 06 aceptado; inventario de esquema actual documentado.
- Componentes: contratos internos, comunidad obligatoria, autorizacion por accion, auditoria estructurada, migraciones versionadas, transacciones, idempotencia, concurrencia, backups y restauracion, referencias documentales, observabilidad sin secretos.
- Reutiliza: `access_control.py`, usuarios y permisos por comunidad, `web_migrations`, dominios Python existentes, HTTP Node, SQLite servidor, respaldos y revision de propuestas.
- Estado: COMPLETADO. Implantacion certificada: 100% de ERP 0. Los cuatro hitos estan acreditados: contrato/migracion en copia y produccion; servicios deterministas; recorrido interno autenticado; pruebas, restauracion y regresion. Evidencia en [ERP 0 - implementacion](ERP_00_FUNDAMENTOS_IMPLEMENTACION.md). No concede avance a ERP 1-9 ni certifica contabilidad financiera.
- Aceptacion: ninguna FK de negocio cruza comunidades; acceso denegado probado por endpoint/herramienta/archivo; migracion reproducible con recuentos e integridad; restauracion ensayada; reglas fuera de plantillas de texto y prompts; una operacion y su auditoria se confirman juntas.
- Riesgos: SQL distribuido en `index.js`, migraciones invocadas desde accesos, claves globales heredadas y restricciones de concurrencia de SQLite. `id_comunidad` por si solo no prueba aislamiento referencial.
- Decisiones pendientes: ninguna para cerrar ERP 0. Medir concurrencia antes de considerar otro motor. El objetivo de recuperacion y la retencion se acuerdan antes de operar datos financieros definitivos; el procedimiento actual ya permite checkpoint, backup consistente y restauracion comprobada.

## ERP 1 - Datos maestros

- Objetivo: identificar de forma estable comunidades, propiedades, titulares y sus relaciones a fecha determinada.
- Dependencias: ERP 0; modelo detallado enlazado arriba.
- Componentes: comunidades, agrupaciones, tipos y relaciones de propiedades, propietarios y contactos, ejercicios, titularidades, coeficientes y grupos temporales, referencias de origen y documentos.
- Reutiliza: `comunidades`, `cf_propiedades`, `cf_propietarios`, `cf_contactos_propietario`, `cf_propietario_propiedad`, etiquetas e importaciones. Conservar IDs y consumidores existentes.
- Estado: COMPLETADO. Implantacion certificada: 100% de ERP 1. Hito 1: contrato y migracion versionada validados en copia real y produccion. Hito 2: consultas y comandos deterministas con idempotencia, concurrencia, auditoria y outbox. Hito 3: recorrido web integrado en Datos maestros para comunidades autorizadas. Hito 4: 19 casos obligatorios, regresion completa, UI escritorio/movil y restauracion posterior superados. Evidencia en [ERP 1 - implementacion](ERP_01_DATOS_MAESTROS_IMPLEMENTACION.md). No concede avance a ERP 2-9.
- Aceptacion: copropiedad y cambios con vigencia; consultas historicas o respuesta explicita de dato desconocido; propiedades repetidas en comunidades distintas; importacion repetida sin duplicar; cero fusiones por similitud; coeficientes versionados por grupo; inventario de discrepancias con fuente.
- Riesgos: porcentajes por defecto 100, fechas nulas, propietarios de nombre compuesto y codigo unico global, coeficiente flotante y agrupaciones en texto.
- Decisiones pendientes: ninguna para cerrar ERP 1. La politica confirmada mantiene propietarios separados por comunidad, sin fusion automatica. Los datos legacy observados requieren evidencia para elevarse a validados, pero esto es trabajo operativo y no una carencia estructural.

## ERP 2 - Presupuestos y cuotas

- Objetivo: presupuestos propios de la comunidad y cuotas justificables hasta la regla aplicada.
- Dependencias: 0 y 1; contrato de hechos economicos acordado con 6.
- Componentes: presupuesto/capitulos/partidas, asignaciones multiples grupo/regla, calendario ordinario por comunidad, derramas con calendario propio, regularizaciones, ajustes, redondeo espacial/temporal, simulacion/aprobacion inmutable y explicacion de cuotas; ocupacion y destinatario/pagador separados de titularidad.
- Reutiliza: servicios ERP 0/1, grupos/series temporales, documentos e informes existentes. `cf_repartos_cuotas` y `cf_reparto_lineas` son antecedentes de compatibilidad a inventariar, no motor ERP 2 certificado; no confundir cuenta Netfincas con cuenta PGC.
- Estado: COMPLETADO. Implantacion certificada: 100% de ERP 2. Hito 1: contrato, capacidades y migraciones aditivas validados. Hito 2: motor racional, reglas, redondeo espacial/temporal, snapshots y servicios deterministas. Hito 3: recorrido web integrado para crear, copiar, importar, editar, simular, comparar, aprobar y explicar cuotas, mas derramas, regularizaciones y configuracion de ocupacion/cobro. Hito 4: pruebas integrales, regresion ERP 0/1, escritorio/movil, publicacion y restauracion superadas. Evidencia en [implementacion ERP 2](ERP_02_PRESUPUESTOS_CUOTAS_IMPLEMENTACION.md). ERP 2 no emite recibos ni modifica deuda.
- Aceptacion: suma exacta al centimo; cada linea explica base, integrantes, coeficiente y regla versionados; ajuste manual motivado; presupuesto aprobado inmutable; nueva version/regularizacion para cambios posteriores; mismo snapshot produce mismo resultado.
- Riesgos: datos legacy observados y versiones de grupo en borrador; reparto por cuota no equivale a porcentaje de dominio; regularizar contra cobrado duplicaria deuda; snapshots y redondeo entre periodos deben conservar totales. Ver puertas de validacion en el contrato tecnico.
- Decisiones cerradas: sin prorrateo de cuotas por titularidad; un cargo operativo por propiedad/concepto/periodo; copropiedad no divide cargos; periodicidad ordinaria por comunidad; presupuesto aprobado inmutable; importes finales a dos decimales; destinatario/pagador/titular separados; SEPA reservado a ERP 4.
- Precisiones confirmadas: recibos no emitidos resuelven destinatario con la configuracion vigente a fecha efectiva de emision, no al inicio del periodo; emitidos conservan destinatario sin cambios automaticos. Coeficientes, participantes, grupos y reglas del aprobado quedan congelados en snapshot; cambios economicos posteriores requieren operacion formal. Regularizaciones contra emitido neto, incluyendo recibos pendientes, no solo cobrado.
- Decisiones pendientes: ninguna funcional material para el cierre de ERP 2. Usuarios autorizados a aprobar e importes/reglas concretos se configuran operativamente y no se infieren. La materializacion de recibos requiere el diseno y autorizacion de ERP 3.

## ERP 3 - Recibos, cobros y deuda

- Objetivo: explicar saldo por recibo, obligado, propiedad y fecha sin borrar deuda.
- Dependencias: 0, 1, 2; contrato contable de 6 previo a puesta en servicio.
- Componentes: emision, obligados y documento de cargo, imputaciones parciales, cobros no asignados, devoluciones, abonos, baja/incobrable documentada, ajustes y trazabilidad.
- Reutiliza: `cf_recibos`, `cf_movimientos_deuda`, referencias y fechas originales de importacion.
- Estado de implantacion: DESARROLLO, autorizado por el usuario. Diseno funcional/tecnico/UX: CERRADO, 100%; D1-D6 ratificadas expresamente el 11/09/2026 e incorporadas al [contrato ERP 3](ERP_03_RECIBOS_COBROS_DEUDA.md). Implantacion certificada: 25%; hito 1 acreditado por contratos, migraciones aditivas 7/8, compatibilidad observada, permisos y restauracion sobre copia. Servicios ampliados y registrados en dispatcher, pero hito 2 todavia incompleto; sin interfaz ERP 3 ni activacion productiva. Evidencia y pendientes en [implementacion ERP 3](ERP_03_RECIBOS_COBROS_DEUDA_IMPLEMENTACION.md). No concede 50% por servicios parciales ni 100% por diseno cerrado.
- Aceptacion: saldo reconstruible a fecha efectiva y conocimiento; pago parcial N:M y devolucion con contramovimiento; titular actual no sustituye al obligado historico; ninguna reduccion sin evento/motivo; duplicado de importacion no genera cobro nuevo; apertura y recibos detallados no se cuentan dos veces; ajustes ERP 2 aprobados/materializados se descuentan una sola vez.
- Riesgos: saldo importado no prueba todos sus movimientos historicos; deuda de propiedad no equivale a deuda de titular actual.
- Decisiones cerradas: D1 cargo unico por propiedad/concepto/periodo, uno o varios obligados sin division por porcentaje de dominio; D2 exceso cobrado sin aplicacion automatica; D3 imputacion asistida con confirmacion humana; D4 gastos configurables por comunidad (no repercutir/coste real/fijo) mediante cargo separado; D5 anulacion con historico solo sin movimientos economicos posteriores, resto por rectificacion; D6 incobrable conserva deuda y traslado excepcional explicito, documentado, autorizado y auditado. Titularidad, obligado y pagador permanecen separados.
- Decisiones funcionales bloqueantes: ninguna para implementar el alcance ratificado. Division especifica futura requiere regla expresa y no se activa ahora; automatizacion economica ERP 5 y contabilidad definitiva ERP 6 siguen fuera de alcance. No reabrir fecha efectiva de emision, no prorrateo ni destinatario operativo de ERP 2. Antes de activar datos reales: asignar usuarios/capacidades, politica de gastos y comunidad/cobertura/corte rector Netfincas. Son configuraciones/puertas de puesta en servicio, no diseno pendiente. Implementacion ya autorizada; no requiere aprobaciones entre subfases.

## ERP 4 - Domiciliaciones, SEPA y remesas

- Objetivo: preparar cobros bancarios controlados y trazables, no dar por cobrado un fichero emitido.
- Dependencias: 0, 1 y 3.
- Componentes: cuentas de comunidad y pagador separadas, mandatos versionados, referencia acreedor, lotes, exportacion XML, estados, rechazos/devoluciones y cancelaciones.
- Reutiliza: datos de remesa en recibos solo como referencia; no se ha encontrado un registro completo de mandatos en el esquema inspeccionado.
- Estado inicial: PENDIENTE. Implantacion certificada: 0%.
- Aceptacion: validacion del formato requerido por el banco, totales y duplicados; confirmacion antes de exportar; trazabilidad recibo-linea-fichero; permisos de datos bancarios; simulacion/rechazo sin falsear cobros.
- Riesgos: formato aceptado depende del banco; titular, pagador y firmante de mandato no son sinonimos.
- Decisiones pendientes: banco, modalidad y requisitos vigentes al implementar. No se promete conectividad bancaria ni gratuidad de agregadores.

## ERP 5 - Banco y conciliacion

- Objetivo: registrar una sola vez cada movimiento y reconciliarlo contra cobros/pagos verificables.
- Dependencias: 0, 1 y 3; gastos/pagos de 7 se incorporan progresivamente.
- Componentes: cuentas de banco y caja separadas, extractos, transferencias internas, imputaciones N:M, propuesta/revision/confirmacion, partidas a revisar, saldo conciliado.
- Reutiliza: `cf_extractos_banco_importaciones`, `cf_extractos_banco_lineas`, `cf_equivalencias_banco`, `cf_conciliacion_gasto_banco`.
- Estado inicial: PENDIENTE. Implantacion certificada: 0%.
- Aceptacion: movimiento repetido no duplica; transferencias no generan ingresos/gastos ficticios; asignacion parcial y multiples facturas; suma imputada no supera disponible; deshacer deja trazabilidad y no borra evidencia bancaria.
- Riesgos: `line_hash` global y conciliacion gasto-banco sin importe imputado no bastan para todos los pagos parciales; texto parecido solo permite proponer.
- Decisiones pendientes: formato de extractos por cuenta; algoritmo de deduplicacion con identificadores bancarios y casos sin ID. Conexion bancaria automatica fuera del primer alcance.

## ERP 6 - Contabilidad integrada

- Objetivo: libro financiero determinista con diario, mayor y balances conciliados.
- Dependencias: 0 y 1; hechos de 2/3/5/7 segun implantacion.
- Componentes: plan PGC y cuentas por comunidad, ejercicios, cabecera/lineas de asiento, reglas contables versionadas, apertura, cierre, bloqueos, rectificacion y estados de contabilizacion.
- Reutiliza: `cf_cuentas_contables`, `cf_equivalencias_pgc`, `cf_movimientos_financieros`, `informes_contables`; propuestas historicas no se convierten en asientos definitivos solo por cambiar su etiqueta.
- Estado inicial: PENDIENTE. Implantacion certificada: 0%.
- Aceptacion: debe=haber exacto; evento contabilizado una vez; diario/mayor/balance concordantes; periodos bloqueados protegidos; correcciones por contrapartida/asiento rectificativo, no borrado; apertura documentada conciliada con fuente.
- Riesgos: codigo de cuenta como PK global, movimientos provisionales sin cabecera contable robusta, `REAL`, equivalencia origen-PGC unica insuficiente para ciertos conceptos.
- Decisiones pendientes: politica contable aplicable y asiento inicial revisados por el responsable contable; no emitir garantia de cumplimiento normativo por este diseno tecnico.

## ERP 7 - Proveedores y control presupuestario

- Objetivo: comparar alternativas y saber presupuesto disponible, comprometido, facturado y pagado sin sumarlos doble.
- Dependencias: 1, 2, 5 y 6.
- Componentes: proveedores por categoria, evaluacion documentada, presupuestos comerciales, contratos/compromisos, facturas, vencimientos y pagos/imputaciones por partida.
- Reutiliza: `cf_proveedores`, `cf_proveedor_alias`, `cf_gastos_facturas`, equivalencias, anexos clasificados y expedientes.
- Estado inicial: PENDIENTE. Implantacion certificada: 0%.
- Aceptacion: factura sustituye la parte correspondiente de un compromiso; importe libre calculado con reglas explicadas; varios pagos/vencimientos; valoracion separada de aprobacion; vinculacion proveedor-factura verificada.
- Riesgos: proveedor textual en gastos y CIF unico global; clasificacion bancaria habitual no prueba partida correcta.
- Decisiones pendientes: criterio de preaprobacion de proveedores y autoridad para comprometer gasto. Reutilizar el requisito de 1-2 alternativas por categoria, no inventar puntuaciones.

## ERP 8 - Gestion transversal

- Objetivo: integrar datos ERP en expedientes y documentos actuales sin otra app operativa duplicada.
- Dependencias: 0 y contratos de cada dominio publicado.
- Componentes: documentos/versiones, informes ejecutivos/completos, asambleas y snapshots, tareas/proyectos independientes, seguimiento, seguridad, notificaciones y comunicaciones propuestas.
- Reutiliza: modulos 01/02/04/05/06 y funcionalidad de asambleas/seguridad existente; ver fichas de cierre en el roadmap modular, sin repetirlas aqui.
- Estado inicial: PENDIENTE. Implantacion certificada: 0%. Funcionalidad actual conservada; integracion ERP aun no verificada.
- Aceptacion: expediente enlaza recibo/factura/contrato sin copiar saldos; informes indican corte y fuente; actas/votos historicos no cambian al actualizar un maestro; permisos documentales en cada descarga.
- Riesgos: censo de asamblea usa texto/coeficiente propios; convertirlo en vista viva alteraria el pasado. Exportaciones viejas son snapshots, no fuente maestra vigente.
- Decisiones pendientes: retencion y acceso documental por tipo; correo enviado solo tras el proceso de autorizacion que se acuerde.

## ERP 9 - IA y agentes

- Objetivo: capa conversacional transversal sobre herramientas fiables; no depositar integridad en el LLM.
- Dependencias: contratos aceptados de los dominios utilizados; 0 obligatorio.
- Componentes: adaptador de proveedor/modelo, consultas con fuentes/fecha, RAG con permisos, herramientas tipadas, propuestas editables, memoria verificada, aprobacion y automatizaciones observables.
- Reutiliza: Centro IA, borradores, reuniones, contexto privado, confirmaciones idempotentes y proveedores configurables. No comenzar otro agente desde cero.
- Estado inicial: PENDIENTE. Implantacion certificada: 0% del nuevo alcance ERP.
- Aceptacion: no SQL arbitrario del modelo; ninguna herramienta omite autorizacion; mismo comando funciona sin IA; propuesta enumera impacto/documentos/fecha; revocacion y conflicto de version impiden aplicar; cambio de LLM no altera reglas financieras.
- Riesgos: documentos con instrucciones maliciosas, filtracion por indices, contexto obsoleto, alucinacion y dependencia de disponibilidad/coste.
- Decisiones pendientes: datos permitidos fuera de la oficina y limites de gasto/retencion antes de enviar nuevos documentos a un proveedor; no inferir autorizacion global de una clave API existente.

## Checkpoint obligatorio para futuros cambios estructurales

1. Fijar commit/checkpoint del codigo y esquema esperado; no incluir datos, claves ni documentos personales en Git.
2. Crear copia consistente independiente de SQLite y documentos/configuracion necesarios, con checksum y acceso restringido. Git NO sustituye el backup de datos.
3. Probar la migracion y restauracion en copia aislada: conteos, FKs, IDs, sumas por comunidad, precision y fechas desconocidas.
4. Publicar solo tras aceptacion; conservar `data/` y `backups/`. No usar el escritorio OneDrive como escritor simultaneo de la base web.
5. Restaurar codigo+datos compatibles; antes preservar nuevas operaciones posteriores al checkpoint. No sobrescribir actividad reciente silenciosamente.

## Siguiente entrega recomendada

ERP 2 completado con 100% certificado y revision UX/onboarding previa superada. ERP 3 continua autorizado, con [D1-D6 incorporadas](ERP_03_RECIBOS_COBROS_DEUDA.md#12-decisiones-materiales-ratificadas). Continuar desde [los pendientes de implementacion](ERP_03_RECIBOS_COBROS_DEUDA_IMPLEMENTACION.md), cerrar servicios, integrar UX y completar aceptacion antes de publicar. Implantacion certificada ERP 3: 25%; no requiere nueva autorizacion entre subfases. Mantener planes/cuotas ERP 2 como origen inmutable; no avanzar ERP 4/5/6.
