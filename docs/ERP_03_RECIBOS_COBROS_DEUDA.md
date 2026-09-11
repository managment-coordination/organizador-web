# ERP 3 - Recibos, cobros, devoluciones y deuda

Fecha: 11/09/2026. Linea base inspeccionada: `42aa98f`; ratificacion documental posterior sobre ERP 0/1/2 certificados. Diseno funcional/tecnico: CERRADO, 100%, D1-D6 ratificadas expresamente por el usuario. Estado de implantacion: PENDIENTE, listo para implementacion con Sol. Implementacion certificada: 0%; aceptacion funcional: no ejecutada. El cierre del contrato no autoriza en esta entrega codigo, migraciones ni emision.

[Roadmap](ERP_COMUNIDADES_ROADMAP.md) | [ERP 0](ERP_00_FUNDAMENTOS_IMPLEMENTACION.md) | [ERP 1](ERP_01_DATOS_MAESTROS_IMPLEMENTACION.md) | [ERP 2 cierre](ERP_02_PRESUPUESTOS_CUOTAS_IMPLEMENTACION.md) | [Contrato ERP 2](ERP_02_MODELO_CALCULO_CONTRATOS.md) | [Maestros](ERP_MODELO_DATOS_MAESTROS.md) | [Titularidades](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md) | [UX permanente](ERP_UX_PRINCIPIOS.md)

## 1. Comprobacion previa acotada

ERP 2 es suficiente como origen. Se ha contrastado documentacion de cierre, contrato y codigo; no se ha vuelto a certificar ejecutando pruebas ni se ha accedido en escritura a produccion.

| Requisito | Evidencia actual | Consumo ERP 3 |
|---|---|---|
| Presupuesto aprobado/versionado | `budget_service.py:budget_approve`, planes/versiones y protecciones documentadas | Solo origen aprobado y revision rectora |
| Partidas, varios grupos, reglas, coeficientes | `_manifest`, `budget_engine.py`, resultados de componentes | Referencias congeladas; no volver a consultar coeficiente actual |
| Cuotas/periodos | `erp_planes_cuota`, `erp_plan_versiones`, `erp_plan_periodos`, `plan_export_preview` | Resultado por propiedad y periodo del snapshot, no dividir el total anual otra vez |
| Precision y redondeo | `budget_contracts.py:Money`, `erp2-rational-v1`, `largest-remainder-v1` | Centimos enteros y trazas racionales intactas |
| Explicabilidad | `quota_explain`, simulaciones persistidas | Enlace al desglose aprobado |
| Derramas | `assessment_approve` crea plan aprobado y calendario propio | Mismo adaptador de emision, origen extraordinario separado |
| Regularizaciones | `regularization_preview/approve`, `erp_regularizacion_lineas/origenes` | Diferencia firmada aprobada, fuentes y cobertura; seccion 7 |
| Destinatario/pagador | `billing_preview`, `_billing_at`, `erp_config_recibo_versiones`, `erp_personas_cobro` | Resolver a emision efectiva, congelar; no confundir con obligado |

`plan_export_preview` no es todavia una orden de emision: devuelve plan, periodos, totales y `receipt_emission:false`. ERP 3 debe construir el candidato desde resultados periodicos ya persistidos. El snapshot de destinatarios del plan es una prevision: no sustituye la resolucion definitiva al emitir. `_billing_at` consulta la configuracion ordinaria; no inventar una politica especial de derramas por reutilizar el metodo. ERP 3 debe exponer una fachada tipada que reutilice esa resolucion y complete la identidad referenciada, sin cambiar su politica temporal. Una identidad incompleta o ambigua bloquea la linea.

El adaptador manual de emitidos de ERP 2 es deliberadamente temporal y tiene un contrato documentado para sustituirlo. La ausencia de recibos ERP 3 no es un hueco de calculo de ERP 2. El adaptador nuevo descrito aqui no modifica importes ni formulas aprobadas.

Inventario leido en modo SQLite `mode=ro` sobre copia existente `onboarding-owner-source.db`: 16.289 `cf_recibos`. Confirma el recuento historico documentado, no afirma un recuento productivo en tiempo real. Campos reales: referencia, emision, ejercicio numerico, remesa, tipo, textos de propietario/propiedad, sus IDs, importe/cobrado/deuda `REAL`, estado, importacion, fechas de creacion/actualizacion y comunidad. `cf_movimientos_deuda` contiene recibo, propietario, propiedad, fecha, tipo, importe `REAL`, comentario, importacion, creacion y comunidad. No contiene una relacion N:M certificada ni garantiza cada fecha de cobro. El numero 16.289 es un control base a reconciliar, no una constante de migracion.

## 2. Principios y limites

Pregunta rectora: por que esta propiedad o este obligado debe esta cantidad en una fecha determinada. Cuota es calculo ERP 2; cargo es obligacion emitida; cobro es entrada de fondos; imputacion aplica fondos; devolucion revierte fondos; abono reduce obligacion; deuda es resultado, nunca campo editable.

- Reutilizar monolito modular Python, SQLite, comandos/consultas allow-listed y transporte Node. No servicio externo ni motor IA financiero.
- No prorrateo. Una obligacion operativa por propiedad/concepto/periodo, sin division automatica por copropiedad.
- Titular, obligado, destinatario, pagador previsto y pagador efectivo son roles distintos. Cambiar titular no reasigna deuda.
- Emision conserva importe y sujetos historicos; no se actualizan desde fichas vivas. Identidad corregida posteriormente se documenta, no se reescribe el original.
- Importes finales de dos decimales, centimos `INTEGER` con limites `Money`, transporte JSON como texto. Intermedios Decimal/racionales ERP 2, nunca `float`, `REAL` nuevo ni `Number` para dinero.
- No SEPA, conciliacion, asientos definitivos, prescripcion automatica, intereses automaticos ni certificaciones juridicas automaticas. El diseno no determina por si mismo responsabilidad legal.

## 3. Modelo objetivo y reutilizacion

Nombres propuestos para la futura migracion, no tablas ya creadas. Toda tabla nueva incluye `id_comunidad`, PK, claves alternativas por comunidad, FKs compuestas en relaciones criticas, actor/origen/registro y version donde proceda. Los movimientos confirmados son append-only; una correccion es otra operacion enlazada. No crear otro maestro de propietarios/personas universales.

| Entidad | Contenido y restricciones |
|---|---|
| `erp_recibos` | Cargo propio: numero por serie/comunidad, propiedad, ejercicio ERP 1, concepto estable, periodo desde/hasta y clave, origen tipado, importe original positivo, moneda, emision efectiva, vencimiento, registro UTC, estado documental, version. Referencia a plan/version/periodo/simulacion/hash o regularizacion/linea; legado conserva su referencia. Importe/sujetos/origen de emitido no editables. Cero no emite cargo: linea resuelta sin cargo, trazada. Diferencia negativa genera abono. |
| `erp_recibo_detalles` | Componentes por partida/capitulo/asignacion y periodo, importes exactos en centimos, referencias al resultado ERP 2. Suma de detalle igual al cargo; no recalcula. Un documento puede contener varios detalles sin crear varias obligaciones. |
| `erp_recibo_sujetos` | Rol obligado/destinatario/pagador previsto/titular de referencia; FK a `cf_propietarios` o `erp_personas_cobro`, XOR tipado, identidad snapshot protegida. Los obligados incluyen modo, importe/porcentaje explicito cuando proceda, fuente, evidencia y decision. No copiar porcentajes de dominio. Obligado desconocido posible SOLO en legado observado; impide afirmar deuda personal. |
| `erp_obligacion_config_versiones` | Nueva configuracion economica por propiedad/concepto, temporal y con evidencia, separada de titularidad y de configuracion del destinatario ERP 2. Resolucion segun D1 ratificada: uno o varios obligados acreditados y cargo unico por defecto. Conserva tiempo efectivo/conocido; conflictos no se resuelven eligiendo el ultimo nombre. |
| `erp_emisiones_lotes/lineas` | Propuesta durable, origen, seleccion, corte, hash, versiones leidas, incidencias, confirmacion, recibo/abono resultante. Clave de obligacion independiente de version presupuestaria. Unicidad adicional por origen/linea impide emitir dos veces la misma regularizacion. |
| `erp_cobros` | Entrada de fondos positiva, fecha efectiva, fecha valor opcional, registro, medio tipado, moneda, importe, cuenta de tesoreria referenciada, pagador conocido o no, justificante, identidad externa/origen, version para concurrencia. No requiere recibo. Transferencia, efectivo, tarjeta, remesa y otros configurables; compensacion usa instrumento no monetario, no fabrica cobro. |
| `erp_imputaciones` | N:M cobro-cargo con importe positivo, efectiva/registrada, actor, motivo; reversiones parciales referencian imputacion original. Mismo tenant/moneda y saldo suficiente en ambos extremos. No borrar ni editar imputacion confirmada. |
| `erp_devoluciones` y detalles | Contramovimiento ligado a cobro, importe/fecha/motivo/referencia externa; detalle separa parte libre y partes que revierten imputaciones concretas. Suma de detalles igual a devolucion; acumulado no supera cobro neto disponible para devolver. Reversion de devolucion es nuevo hecho enlazado. |
| `erp_rectificaciones` y aplicaciones | Abono, anulacion, correccion, reversion; cargo origen, motivo, evidencia, fecha, importe y aprobacion. Abono no es cobro. Una rectificacion de varios cargos usa aplicaciones explicitas por cargo, no saldo global sin origen. Correccion de sujeto sigue D6 ratificada sin reescribir snapshot emitido. |
| `erp_reasignaciones_obligacion` y lineas | Operacion excepcional separada: origen/destino, recibos, importes, fecha efectiva y registrada, motivo, documento/evidencia, autorizacion, impacto antes/despues y referencia contable. Lineas enlazadas a la obligacion original; no duplican cargo ni crean cobro. Inmutables tras confirmacion, reversibles mediante nuevo hecho. Misma comunidad y moneda. |
| `erp_creditos` y aplicaciones | Credito no monetario a favor nacido de abono, importe disponible, sujeto acreditado, origen y vigencia de hechos. Aplicacion N:M a cargos sin duplicar el abono original. Sobrepago/anticipo monetario permanece disponible en `erp_cobros`, no se registra tambien como nuevo credito. |
| `erp_reintegros` | Salida aprobada de saldo a favor, fuente cobro/credito, sujeto, evidencia y disponibilidad. Reduce saldo a favor sin reabrir cargo pagado. No confundir reembolso de exceso con devolucion bancaria. Propuesta y confirmacion humana, nunca reembolso automatico. |
| `erp_recibo_gestion_eventos` | Reclamacion, disputa, seguimiento, suspension e incobrabilidad separados del saldo. Referencia expediente/documento; no concluye accion judicial ni extingue deuda por cambiar etiqueta. |
| `erp_saldos_apertura` | Saldo documentado positivo/deudor o negativo/a favor, corte, cobertura, propiedad y sujeto si acreditados, fuente, limitaciones, calidad y referencia original. No factura recibos ficticios; no inventa devengos. |
| `erp_importaciones_economicas/filas/vinculos` | Staging de fuentes legacy/nuevas, hash, fila, valor original, decision, calidad/cobertura, correspondencia unica origen->entidad ERP. Reutiliza gestion documental y patron de importacion ERP 1, sin usar su servicio de maestros para movimientos economicos. |
| `erp_hechos_economicos` | Diario de hechos de dominio, tipado/versionado, inmutable, referencias y deltas. No es diario PGC; no duplica maestros ni permite movimientos SQL libres. Outbox ERP 0 transporta la referencia a este hecho. |

Deuda, disponible, antiguedad y estados economicos son proyecciones reconstruibles. Pueden tener cache materializada con version/corte/hash y conciliacion contra hechos; cache nunca autoriza escritura de saldo. FK y restricciones protegen referencia a origen y unicidad; invariantes N:M se verifican ademas bajo transaccion, no con un CHECK que ignore otras filas.

No guardar IBAN nuevos en estas tablas. Cuenta de tesoreria (banco/caja de comunidad) y preferencia de cuenta del pagador no son el mismo dato: conservar referencias existentes con resolucion inequívoca; si el legado no identifica cuenta de forma estable, registrar medio y cuenta pendiente, no inventar enlace. ERP 4 gestionara mandato/cuenta operativa y ERP 5 enlace bancario. La carencia se muestra en revision.

## 4. Obligado, titularidad y tiempo

**Ya cerrado:** destinatario de no emitidos se resuelve en fecha efectiva de emision; emitidos conservan su destinatario. Titularidad juridica mantiene su fecha real; sin prorrateo. Una venta el 10/07 no cambia julio emitido el 03/07. Si julio se emite realmente el 12/07, usa configuracion vigente el 12/07. No falsear fecha para elegir otro sujeto.

**D1 ratificada:** un unico recibo por propiedad/concepto/periodo por defecto, aunque exista copropiedad. Identificacion de obligado(s), sobre todo copropiedad/inquilino, NO deducible del destinatario ni del pagador. Proponer titulares como candidatos y exigir acreditacion/confirmacion de la configuracion economica; uno o varios obligados pueden compartir el mismo cargo con un destinatario operativo elegido. Si no hay reparto de responsabilidad aprobado, mostrar obligacion compartida sin adjudicar 60/40, solidaridad ni 100% personal a cada uno. ERP 2 conserva su configuracion explicita de destinatario sin convertirla en responsabilidad economica.

Modos de responsabilidad preparados: individual, conjunta sin reparto personal, pendiente de acreditar para legado y extension futura de distribucion explicita. No activar solidaridad ni copiar porcentajes de dominio. Deuda comunitaria cuenta una obligacion una vez; consulta individual separa deuda exclusiva/atribuida y obligaciones compartidas sin fraccion conocida. No sumar listados por persona para calcular comunidad. La division especifica queda preparada pero NO habilitada en el alcance inicial: una futura regla expresa debera definir importes y aplicacion de cobros/abonos antes de activarse; no bloquea el cargo unico de ERP 3.

Consultas de deuda: `effective_at` (fecha economica) y `known_at` (UTC de conocimiento, por defecto ahora). Incluir solo hechos efectivos <= corte y registrados <= conocimiento; reversiones tienen sus propias fechas. Orden estable `(efectiva, registrada, secuencia)` para desempates. Validar tambien saldos en cortes posteriores cuando se inserta hecho retroactivo; no aceptar una devolucion anterior al cobro ni imputacion anterior a disponibilidad/emision. Una correccion retroactiva no borra lo que se sabia antes.

Ejercicio, periodo devengado, emision, vencimiento, fecha valor y registro son dimensiones independientes. Deuda vencida exige vencimiento conocido y anterior al corte; fecha desconocida se informa, no se presume vencida. Domicilio/idioma y nombres del documento son snapshot; consulta avanzada puede mostrar identidad actual sin sustituir la historica.

## 5. Maquina de estados

| Eje | Valores y transiciones |
|---|---|
| Documento | Borrador editable/eliminable segun permisos, conservando auditoria de propuesta; no crea hecho economico. Emitido -> anulado con historico solo si no tiene movimientos economicos posteriores y cumple D5. Emitido nunca vuelve a borrador. Con movimientos, abono/rectificacion/contramovimiento enlazado, no edicion ni eliminacion. |
| Saldo derivado | Pendiente / parcialmente satisfecho / liquidado. Separar importe pagado, compensado y abonado: un cargo abonado no figura falsamente como cobrado. |
| Gestion | Sin reclamacion / en gestion / reclamado / suspendido / cerrado, con transiciones motivadas y evidencia; disputa/incobrabilidad son indicadores con historial. |
| Canal ERP 4 | Sin remesa / reservado / enviado / rechazado / resultado recibido, por intento/linea externa. Remesado no significa cobrado. |

`Devuelto` es indicador de contramovimiento con importe/fecha, no estado excluyente del saldo. Recibo 100, cobro 100 y devolucion 40: pendiente 40, pagado neto 60, indicador devuelto parcialmente. Puede estar reclamado a la vez. Abono 100 sin dinero: liquidado por abono, cobrado 0. UI ofrece filtros habituales (Pendientes, Parciales, Pagados, Devueltos, Reclamados) basados en ejes, no edicion manual de estado economico.

## 6. Invariantes economicos y operaciones

Para cargo nuevo `r`, a corte efectivo/conocido:

`pendiente_r = original + rectificaciones_debito - abonos_aplicados - imputaciones_monetarias_netas - creditos_aplicados_netos`.

Las devoluciones/desimputaciones se reflejan reduciendo imputaciones netas; NO se suman otra vez al pendiente. Cada contramovimiento identifica el hecho que revierte. Pendiente >= 0: una reduccion superior al pendiente libera fondos/crea credito segun fuente, no deja un cargo negativo sin explicar. Los ajustes de debito nuevos son cargos/documentos separados enlazados, nunca edicion del original.

Para cobro `c`: `disponible = importe - devoluciones_netas - reintegros - imputaciones_netas`. Devolver parte imputada revierte simultaneamente esas imputaciones; devolver parte libre no cambia deuda. Ejemplo 200, aplicado 100+50, libre 50; devolver 80 de los que 50 son libres y 30 del segundo cargo deja cobro neto 120, aplicado 100+20, libre 0; segundo cargo reabre 30. El usuario confirma ese detalle, no se aplica FIFO oculto.

- **Registrar cobro:** fecha, importe, medio/cuenta y referencia; pagador desconocido permitido. Puede confirmar registro e imputaciones juntas. No confundir pagador efectivo con obligado: pagar deuda ajena no la transfiere.
- **Imputar:** propuesta de pendientes y cantidades editables, siempre con confirmacion humana en ERP 3, incluso ante referencia inequívoca. Suma <= disponible y cada aplicacion <= saldo del cargo. Control misma comunidad/moneda, cobertura y fechas. Multiples cobros y cargos permitidos. Si hay distinto obligado, exigir seleccion y motivo; no aplicar por mera coincidencia de propiedad. Ordenar sugerencias por vencimiento no ejecuta FIFO. Automatizacion economica futura solo mediante reglas expresas de ERP 5.
- **Desimputar:** libera fondos y reabre cargo sin sacar dinero; contramovimiento de la aplicacion. Reasignacion A->B es desimputar/aplicar atomico, no editar recibo o cobro.
- **Sobrepago/anticipo:** resto en cobro no imputado, con sujeto si acreditado. Desconocido no se atribuye a ningun propietario. Mostrar deuda bruta y saldo a favor por separado; neto informativo solo con alcance y titular del credito acreditados. No aplicar automaticamente a futuras deudas; propuesta, confirmacion humana y trazabilidad de cada aplicacion segun D2/D3 ratificadas.
- **Compensar:** aplica un credito ya existente o fondos libres, con movimientos enlazados; no registra una entrada de caja ficticia. No compensar entre comunidades.
- **Devolver cobro:** parcial/total, referencia original, motivo, detalles de aplicaciones revertidas; acumulado <= cobro menos devoluciones/reintegros previos. Error de registro de cobro tambien se rectifica, con motivo distinto de devolucion bancaria.
- **Gasto de devolucion:** politica versionada por comunidad: no repercutir, coste bancario real documentado o importe fijo exacto configurado; extension tipada para futuras reglas, nunca formulas ejecutables. Reutilizar configuracion de comunidad ERP 1, sin otro maestro. Sin politica configurada no proponer cargo repercutido. La propuesta congela politica/version, coste, importe, obligado acreditado, evidencia y aprobacion. Confirmacion humana crea cargo separado enlazado a devolucion/coste, sin modificar importe original del recibo ni importe devuelto. Idempotencia por coste evita doble repercusion. Coste asumido por comunidad se prepara para ERP 7/6, sin aumentar deuda del propietario ni crear asientos ahora.
- **Abonar:** documento negativo economico expresado como magnitud positiva+tipo, enlazado a cargo/fuente. Un cargo pendiente 100 con abono 20 queda pendiente 80. Si cobrado 100 y abono 20, propuesta atomica libera 20 de su imputacion y aplica reduccion 20: deuda 0, fondos libres 20, ningun cobro ficticio. Para credito sin cargo liquidable se conserva `erp_creditos`, requiere sujeto y causa acreditados.
- **Anular:** D5 ratificada: emitido sin movimientos economicos posteriores y sin reserva/remesa activa, mediante contramovimiento total con motivo/historico. No basta saldo aplicado cero: haber tenido movimientos, aunque esten revertidos, exige abono/rectificacion explicita y tratamiento de fondos. Bloqueo de ejercicio se conserva. Nunca borrar historia economica confirmada. Un numero emitido/anulado no se reutiliza; reemplazo exige relacion explicita y control de unica obligacion activa, no nueva clave inventada.
- **Rectificar:** agrupa correccion, contramovimientos y documento sustituto cuando proceda, atomicos. Importe original sigue consultable. Borrado de recibos emitidos/cobros/eventos se deniega incluso si el usuario tiene permiso de editar fichas.
- **Incobrable:** clasificacion de recuperabilidad que NO elimina ni reduce deuda. Conservar cargo, obligado, propiedad, importe, historico, motivo y documento/evidencia. Mostrar saldo incobrable separado sin desaparecer del saldo historico/total. Cambio de clasificacion tambien trazado. Baja contable y condonacion/extincion son hechos distintos no autorizados por esta marca; asientos definitivos quedan en ERP 6. No emitir `COBRO` por llevar a perdidas.
- **Traslado/reasignacion excepcional:** D6 ratificada; propuesta separada con origen, destino, recibos, importes, motivo, evidencia, autorizacion e impacto economico/contable explicitos. No se dispara por cambio de titular. Confirmacion humana y capacidad especifica dentro de una transaccion, idempotencia, versiones y auditoria completas. La reasignacion de pendiente no supera saldo disponible ni reatribuye cobros pasados: registra deltas de responsabilidad enlazados, conserva original y deuda total de la comunidad; no crea nuevo ingreso ni duplica cargo. Consultas temporales muestran atribucion original y sucesora con sus fechas. Impacto contable se registra como pendiente de tratamiento ERP 6, no como asiento ejecutado. Un caso que implique condonacion o cambio del importe total no se resuelve como simple traslado.

Saldo de apertura usa su importe acreditado al corte + hechos posteriores; no se suma otra vez cargo original+saldo de apertura que cubran lo mismo. Reducciones de apertura son explicitas con evidencia y referencian esa apertura.

## 7. Emision y regularizacion: contratos ERP 2 -> 3 -> 2

`erp3.emission.preview`: comunidad, plan/version aprobado o regularizacion aprobada, periodos seleccionados, fecha efectiva de emision, vencimiento propuesto, filtros de propiedades. Devuelve lote versionado, lineas, sujetos previstos, incidencias y totales; no crea deuda. Extrae cantidades periodicas del snapshot original ERP 2. Numero de recibo se asigna solo al confirmar; numero de negocio distinto del ID interno. Orden determinista por propiedad/periodo; sin duplicar obligacion por cambio de revision.

`erp3.emission.confirm`: id de lote, version esperada, hash de revision, clave idempotente, motivo/evidencia. Relee sesion/permisos, origen aprobado, bloqueo de ejercicio, unicidad, configuracion vigente y versiones revisadas. Si cambio un destinatario/obligado/plan rector tras preview: conflicto y nueva revision. Captura sujeto definitivo, fecha y conocimiento, importe exacto y origen; crea recibos+hechos+auditoria+outbox+resultado idempotente juntos. No mantiene locks mientras espera revision humana. Lotes grandes se dividen en sublotes explicitos con totales, nunca exito parcial oculto.

Clave base `(comunidad, propiedad, concepto_estable, periodo_estable)` para obligacion ordinaria; concepto de derrama lleva identidad de derrama, no titulo textual. Regularizacion tiene identidad propia+linea y enlaces a conceptos/periodos afectados. Registrar reemplazos autorizados con cadena y una unica obligacion activa; no levantar unicidad para emitir otra version del mismo presupuesto. Dos cuotas cero se resuelven sin documentos economicos pero con clave procesada.

Salida a ERP 4/5/6 contiene recibo y detalles, nunca otro calculo. Resolucion del sujeto se hace en emision real, no se utiliza como deudor quien sea titular al consultar. Regularizaciones que abarcan obligados historicos distintos exigen decision documentada; no consolidarlas automaticamente en un nuevo titular por comodidad.

### Evitar doble descuento de ajustes

El codigo actual de ERP 2 calcula `debido - emitido_base - ajustes_aprobados_previos` y suma los ajustes aprobados de ese plan/propiedad/periodo. No cambiar esa formula ni sus resultados historicos. El contrato ERP 2 ya exige que una reserva aprobada deje de contarse separadamente al materializarse; el adaptador ERP 3 debe mantener conjuntos disjuntos.

Consulta nueva `erp3.emitted.coverage` devuelve corte/conocimiento/cobertura completa, referencias unicas, cargos base, abonos/anulaciones netos, ajustes ERP 2 aprobados pendientes, ajustes materializados y cobrado solo informativo. Debe conservar a que concepto/periodo se aplica cada ajuste, aunque su documento use un concepto distinto.

Adaptacion compatible con el servicio actual: excluir del campo `net_emitted_cents` los documentos de regularizacion ya representados por `ajustes_previos_centimos` de ERP 2; mantenerlos en la respuesta total y trazabilidad. Asi `emitido_base + todos_ajustes_aprobados = emitido_neto_total + ajustes_reservados_no_emitidos`. No esconder esa exclusion: el snapshot del adaptador enumera ambos conjuntos, IDs, signos y cobertura. Alternativamente futura fachada ERP 2 puede recibir total+reservas pendientes si se valida equivalencia; no modificar silenciosamente el contrato existente.

Ejemplo: debido 110, base emitida impagada 100, ajuste aprobado 10. Antes de emitir ajuste: 110-100-10=0. Tras emitirlo: neto total 110, pero adaptador entrega base 100 y ajuste ERP 2 10, resultado 0, NO -10. Nuevo debido 120: diferencia 10. Se mantiene reserva de aprobados no emitidos y no se usa cobrado para calcular.

Si un documento de ajuste materializado se anula/abona: el adaptador incluye el contramovimiento firmado una sola vez y deja explicito el tratamiento de su reserva; prueba de equivalencia obligatoria. No cancelar administrativamente reservas ERP 2 mediante SQL ni cambiar aprobado: operacion de correccion documentada. Cobertura incompleta, origen de ajuste no identificable o resultado cuya equivalencia no pueda demostrarse bloquean nueva regularizacion, no se rellenan ceros.

Regularizacion negativa emite abono, no recibo negativo ni transferencia. La aplicacion a pendientes o saldo a favor sigue D2/D5. La aprobacion ERP 2 no declara cobrado ni emite evento de ingreso.

## 8. Historico, migracion y fuente unica

Estrategia: extension aditiva con adaptador, no reescritura de `cf_recibos` ni conversion masiva ciega de `REAL`. Los IDs y referencias legacy permanecen. Tabla de correspondencias permite que cada fila visible se lea de una sola fuente: legacy observado o dominio ERP 3 adaptado, nunca ambas en el total.

Tres coberturas por entidad: (a) movimientos detallados acreditados, (b) cargo identificado y saldo observado a fecha de corte pero cobros no reconstruibles, (c) solo saldo inicial agregado con cobertura documentada. En (b), conservar importe original/cobrado/deuda informativos de la fuente y apertura residual para operacion posterior; NO crear cobro ficticio agregado. En (c), no inventar recibos, años ni deudor. Antes del corte una consulta responde cobertura insuficiente, no saldo 0.

Migracion futura: checkpoint+backup consistente -> inventario por comunidad -> staging con hashes y valores originales -> conciliacion de identidades/cortes/periodos -> revision -> correspondencia aprobada -> activacion por cobertura -> comparacion independiente de totales. Valores monetarios se leen desde evidencia original cuando exista; sin ella, conversion decimal textual del legado con validacion de centimos y diferencia registrada. No redondear silenciosamente un `REAL` incompatible ni arreglarlo para que cuadre. No validar un `id_propietario` legacy solo porque exista: revisar procedencia y posibles vinculaciones al titular actual. FKs/nombres no prueban responsabilidad historica.

`importe - cobrado != deuda`, fechas desconocidas, sujeto ambiguo, comunidad inconsistente o movimientos con significado desconocido quedan observados en incidencia; preservar todos los valores originales. Abrir servicio financiero nuevo para filas reconciliadas no autoriza atribuir como validado lo no revisado. Deuda personal excluye atribucion no acreditada y muestra cuantia no atribuida aparte.

Convivencia Netfincas: fuente rectora y corte por comunidad/conjunto de obligaciones. Mientras Netfincas sea rector, imports son observaciones; no emitir tambien la misma obligacion local. Tras activar ERP 3 para una cobertura, reimportaciones que la solapen van a revision sin sobrescribir operaciones locales. Identidad externa estable por sistema/comunidad/referencia; hash de archivo deduplica repeticion, no identifica por si solo una operacion presente en distintos archivos. Referencias reutilizadas requieren discriminantes acreditados; fecha+importe+nombre no bastan.

Consumidores actuales a adaptar al activar: consultas IA y deuda, informes, propietarios/propiedades, contabilidad legacy, importadores y conciliacion. `server/index.js` aun referencia directamente `cf_recibos`/`cf_movimientos_deuda`: la nueva consulta comun de deuda debe sustituir esos calculos, con pruebas de equivalencia, no escritura dual silenciosa. Asambleas/documentos historicos siguen snapshots. Consultas nuevas en asamblea solo consumen informacion con fecha/fuente; no alteran votos anteriores.

## 9. Eventos y fronteras

Sobre versionado `erp_receivables_v1`: `event_id` estable de negocio, `event_type`, `schema_version`, comunidad, agregado/version, fecha efectiva, registro UTC, ejercicio, moneda, centimos firmados o magnitud+tipo, referencias de sujetos protegidas, documentos, origen, request/correlation/causation, reverses_event_id cuando proceda, lineas/deltas y hash. Payload sin IBAN, contactos, transcripciones ni datos personales innecesarios. Detalle sensible se consulta con autorizacion.

| Hecho | Efecto de dominio / frontera contable |
|---|---|
| `erp3.receipt.issued` | +obligacion, no +caja. Incluye origen, propiedad, concepto, periodo y obligados. ERP 6 aplica politica contable, no presupone ingreso otra vez al cobrar. |
| `erp3.collection.recorded` | +fondos disponibles identificados/no identificados, sin volver a crear cargo. Cuenta banco/caja referenciada. |
| `erp3.collection.allocated/released` | Reduce/reabre pendiente y disponible; no mueve banco. Contabilizable como aplicacion/reclasificacion segun ERP 6, nunca segundo ingreso. |
| `erp3.collection.returned` | -fondos y reversion de aplicaciones enumeradas; hecho compuesto con componentes identificados. No contabilizar el agregado y sus componentes dos veces. |
| `erp3.credit.issued/applied` | Reduccion/credito no monetario y aplicacion, con fuente. No inventa caja. |
| `erp3.receipt.voided` | Reversion de obligacion conforme D5; referencia emision original. |
| `erp3.refund.recorded` | Salida de saldo a favor, no reapertura arbitraria de deuda. |
| `erp3.adjustment.approved` | Debe indicar `effect=proposal` sin efecto financiero o referenciar hecho efectivamente emitido. Aprobacion sola no contabiliza. |
| `erp3.opening.accepted` | Apertura documentada/cobertura, no ingreso nuevo por migrar. ERP 6 reconcilia con su asiento de apertura y evita duplicidad. |
| `erp3.receipt.uncollectible_classified` | Solo clasificacion de recuperabilidad, saldo sin cambio; motivo, evidencia y anterior/nueva clasificacion. No genera cobro ni asiento de baja automaticamente. |
| `erp3.responsibility.transferred` | Deltas de responsabilidad origen/destino por recibo e importe, con autorizacion/documento y doble fecha. Total de obligacion y caja sin cambio; impacto de reclasificacion pendiente de tratamiento ERP 6, sin duplicar emision. |

Hecho+auditoria+outbox+escritura en la misma transaccion. Transporte al menos una vez; efecto contable una vez mediante inbox/UNIQUE `(comunidad,consumidor,event_id,componente)` y commit atomico de asiento+consumo en ERP 6. Una nueva version de regla contable no vuelve a contabilizar el mismo evento sin proceso correctivo. No prometer entrega exactamente una vez. Outbox actual usa estado `processing` sin arrendamiento temporal: preparar recuperacion de reclamaciones abandonadas antes de activar un worker externo; no ejecutar llamadas externas bajo lock SQLite. Hasta ERP 6, estado explicito pendiente de contabilizar, no contabilidad certificada.

ERP 4 reserva saldo por recibo/intento, exporta y comunica resultados con referencias unicas; enviar XML nunca registra cobro. Cancelar remesa libera reserva, no deuda. Doble notificacion banco/remesa se resuelve por identidad externa, no duplica cobro/devolucion.

ERP 5 solicita propuesta/aplicacion a estos mismos comandos e identifica movimiento/cuenta. Si ya existe cobro manual, enlaza evidencia tras revision, no crea otro. ERP 3 registra devoluciones manuales documentadas; ERP 4/5 aportaran despues adaptadores de ficheros, no otro dominio de devolucion. Traspaso banco-caja no es cobro nuevo al propietario.

## 10. API, seguridad y concurrencia

Catalogo de contrato, no comandos actuales: `erp3.emission.preview/confirm`, `collection.record`, `allocation.preview/confirm/reverse`, `return.preview/confirm`, `credit.preview/confirm/apply`, `receipt.void.preview/confirm`, `refund.preview/confirm`, `opening.preview/confirm`, `import.preview/confirm`, `claim.record`, `responsibility.preview/confirm`, `uncollectible.preview/confirm`, `responsibility.transfer.preview/confirm`. Los tres ultimos siguen D1/D6 ratificadas y capacidades explicitas; no habilitan division futura, condonacion ni contabilidad definitiva.

Consultas: `receipt.get/list`, `debt.summary`, `account.statement`, `collection.unallocated`, `emitted.coverage`, `receipt.explain`. Admiten filtros estructurados de comunidad, sujeto/propiedad, periodo, concepto, corte/conocimiento y paginacion. Respuesta: total exacto sobre conjunto autorizado completo, paginas ordenadas, fuente/cobertura, actualizado_hasta, incidencias, saldo pendiente/vencido/no atribuido y credito separado. Un agente no puede confundir resumen paginado con listado completo.

Capacidades por usuario/comunidad: consultar deuda, consultar sensibilidad, preparar emision, confirmar emision, registrar cobro, imputar/desimputar, devolver, rectificar/abonar, anular, ajustar, aprobar reintegro, gestionar reclamacion, importar historico, aprobar apertura, resolver responsabilidad. Extension especifica de ERP 0, sin heredar permiso de tareas ni asumir que presidente/seguridad pueden ver deuda. Roles efectivos se asignan explicitamente; rechazo por defecto hasta configurar, sin cambiar los permisos certificados de ERP 0/1/2. Evidencia documental exige tambien permiso de descarga.

En cada confirmacion: refrescar sesion/tenant/capacidad, validar payload tipado, idempotencia obligatoria y versiones de TODOS los saldos afectados dentro de `BEGIN IMMEDIATE`; comparar hash de propuesta; validar importes/cortes/invariantes; escribir atomico. Una clave repetida devuelve resultado anterior; misma clave con otro contenido 409; claves distintas con misma identidad de negocio no duplican. Una version obsoleta 409 muestra que cambio y requiere nueva revision. No aceptar actor/rol del cliente ni confirmacion suministrada por LLM como autorizacion.

Bloqueo ERP 1 del dominio/periodo financiero impide fechas efectivas cerradas. Operacion correctora en periodo abierto debe documentar referencia al anterior; no falsificar fecha historica. Ningun DELETE/UPDATE de importe emitido disponible por API. Protecciones de base complementan servicio; no se promete inmutabilidad criptografica frente al administrador del fichero.

## 11. UX y operaciones masivas

No crear pestañas por cada tabla. Dentro del area economica: **Recibos y cobros** con Pendientes, Todos, Cobros sin aplicar y Emisiones; gestion/reclamacion como filtros. **Emitir recibos** inicia desde plan aprobado o desde esta vista, no pide ID, coeficiente, importe calculado ni idempotencia. Configuracion avanzada fuera del flujo cotidiano.

| Pantalla | Visible y acciones | Avanzado |
|---|---|---|
| Comunidad / Estado economico | Pendiente, vencido, sin atribucion acreditada, fondos sin aplicar, proximos vencimientos; corte/fuente siempre visibles. Abrir pendientes, registrar cobro o emitir. No netear automaticamente. | Cobertura/importaciones y conciliacion tecnica |
| Propiedad / Cuenta | Recibos, deuda por obligado historico, pagados/abonados, devoluciones e historico. Abrir recibo/documento y registrar cobro contextual. | Titularidades a fecha, responsabilidad documentada |
| Propietario / Cuenta | Deuda propia, compartida sin reparto si procede y creditos acreditados; propiedades actuales/anteriores enlazadas. Nunca asignar toda la deuda del inmueble al actual. | Evidencia de atribucion y doble corte temporal |
| Recibo | Importe original, saldo, vencimiento, obligado/destinatario, desglose y timeline monetaria con documentos. Cobrar, aplicar, devolver o rectificar segun permiso/estado. | Versiones, referencias y eventos |
| Lote de emision | Plan/periodos, emision/vencimiento propuestos editables segun contrato, tabla de importes/sujetos, duplicados/incidencias, seleccionar visibles/todos indicando alcance y total exacto; revisar/confirmar | Hashes y referencias de motor |
| Registrar/aplicar cobro | Importe, fecha, medio, referencia; pendientes propuestos por contexto con importes editables en tabla, disponible/resto visible y revision. Buscar propietario/propiedad/codigo sin vinculo dudoso. | Motivo de aplicacion a otro obligado y evidencias |
| Correccion/devolucion | Original, motivo, importe y vista antes/despues de pendientes/fondos; confirmacion explicita | Efecto contable futuro y cadena de reversiones |

Al cancelar propuesta no cambia saldo. Importar sigue archivo->columnas->mapeo->staging->incidencias->confirmar; errores quedan junto a la fila, no solo toast. Exportaciones incluyen corte, fuente, cobertura y filtros, neutralizan formulas CSV/Excel. Recordatorios son borradores con idioma acreditado, no envios automaticos ni certificado legal por defecto.

Movil: ficha en una columna, saldo/fecha/accion principal visibles, detalle desplegable, tabla intensiva con desplazamiento local o filas apiladas; no desbordamiento global. Escritorio permite seleccion masiva, teclado, tabla de aplicaciones y totales fijos. Incidencias nunca plegadas por defecto. Aplicar `ERP_UX_PRINCIPIOS.md`, sin rediseño estetico general ni dashboard adicional.

Mejoras de bajo riesgo incorporadas al contrato: explicar cada diferencia antes/despues; resolver incidencias en lote conservando filas validas; impedir doble emision con clave semantica; mostrar siempre fondos sin aplicar y fecha de cobertura; automatizar solo sugerencias deterministas revisables. D3 excluye FIFO y confirmacion economica automatica del alcance inicial.

## 12. Decisiones materiales ratificadas

Ratificacion expresa del usuario incorporada el 11/09/2026. Estas reglas sustituyen las alternativas anteriores y son contrato obligatorio para Sol. No autorizan implementar en esta entrega documental.

| ID | Decision cerrada | Limite operativo |
|---|---|---|
| D1 | Un recibo por propiedad/concepto/periodo por defecto. Uno o varios obligados acreditados; titularidad, obligado y pagador/domiciliacion separados. Copropiedad no divide el cargo ni atribuye porcentajes automaticamente. | Modelo preparado para futura division solo mediante regla expresa; sin activarla ahora. No inferir solidaridad ni deuda personal por ser destinatario/inquilino. |
| D2 | Exceso cobrado sobre imputado queda como saldo a favor/cobro no aplicado. Aplicacion posterior propuesta, con confirmacion humana y traza. | No aplicar automaticamente a futuras deudas ni netear saldos de origen desconocido. |
| D3 | Imputacion asistida: detectar y proponer coincidencias; confirmar siempre por una persona. | Automatizacion economica inequívoca/configurable se reserva a ERP 5, no se activa en ERP 3. |
| D4 | Politica por comunidad: no repercutir, coste bancario real o importe fijo. Preparar futuras reglas tipadas. Todo cargo repercutido es independiente y trazado. | No alterar importe original del recibo. Configuracion, evidencia y confirmacion de cada propuesta segun seccion 6; no imponer politica juridica global. |
| D5 | Borradores modificables/eliminables segun permisos. Emitido sin movimientos posteriores puede anularse conservando historico. Con movimientos, abonos/rectificaciones/contramovimientos explicitos. | Nunca borrar historia economica confirmada, ni considerar ausencia de saldo neto equivalente a ausencia de movimientos. Mantener bloqueos de ejercicio y reserva. |
| D6 | Incobrable conserva cargo, obligado, propiedad, importe, historico, motivo, documentacion y clasificacion. Traslado excepcional separado con origen/destino/recibos/importes/motivo/evidencia/autorizacion/impacto economico-contable. | Confirmacion humana, auditoria completa y transaccion. Venta nunca mueve deuda. No se autoriza condonacion ni baja contable automatica; reasignacion no altera el total comunitario ni reescribe el original. |

Ya resuelto y NO se vuelve a preguntar: no prorrateo; fecha de emision efectiva para destinatario de pendientes; emitidos inmutables; un cargo por propiedad/concepto/periodo; no trasladar deuda por venta; regularizar contra neto emitido; dos decimales; presupuesto congelado; no repartir recibos por copropiedad; SEPA ERP 4.

Antes de activar datos reales, designar usuarios/capacidades y comunidad/cobertura/corte rector de la transicion Netfincas. Son parametros operativos documentados, no excusa para inventar responsabilidad ni necesidad de decidir una nueva arquitectura.

No queda decision funcional material bloqueante para implementar este alcance. La division futura de cargos, automatizacion de imputaciones ERP 5 y politica contable definitiva ERP 6 son extensiones posteriores, no pendientes ocultos de ERP 3. La puesta en servicio real sigue requiriendo configurar autoridades, politica de gastos, fuentes y corte, y superar pruebas/restauracion; no se infieren de este cierre.

## 13. Casos de aceptacion para Sol

Pruebas futuras, NO ejecutadas en este diseno. Fixtures sinteticos y copia controlada; cortes/conocimiento, fuentes e importes siempre explicitos. Ademas de cada resultado, comprobar auditoria/outbox, no escritura en `cf_recibos`, permisos y suma reconstruida.

| Caso | Entrada | Resultado exigido |
|---|---|---|
| 1 | Cargo 100 | Pendiente 100, caja 0 |
| 2 | Cobro/aplicacion 100 | Pendiente 0, disponible 0, cobrado 100 |
| 3 | Cobro/aplicacion 30 | Pendiente 70 |
| 4 | Dos cobros 30+70 a cargo 100 | Pendiente 0, dos evidencias |
| 5 | Cobro 200 a cargos 100/150, aplicar 100/100 | Pendientes 0/50; una entrada 200 |
| 6 | Cobro desconocido 500 | Disponible 500 sin propietario ficticio, deuda no cambia |
| 7 | Cargo 100/cobro 120/aplicar 100 | Disponible 20, pendiente 0, no ingreso extra inventado |
| 8 | Devolver cobro 100 aplicado | Original intacto, pendiente 100, fondos netos 0 |
| 9 | Devolver 40 de cobro aplicado 100 | Pendiente 40, neto aplicado 60 |
| 10 | Coste devolucion 5 | No repercutir: deuda no aumenta; coste real: cargo 5; fijo: cargo por importe configurado. Todos con politica versionada, evidencia/confirmacion, cargo separado e idempotencia; original intacto |
| 11 | Abono 20 a pendiente 100; repetir con cargo cobrado | Pendiente 80; segundo escenario pendiente 0/fondos libres 20, no cobro ficticio |
| 12 | Anulacion permitida de cargo 100 | Documento conservado, pendiente 0 por contramovimiento, numero no reutilizado |
| 13 | Editar importe/sujeto de emitido/cobrado | Rechazo, hashes originales iguales |
| 14 | A vende a B con mayo pendiente | Deuda de mayo sigue en A; B no hereda en consulta. Julio emitido 03/07 y venta 10/07 intacto; julio emitido 12/07 resuelve configuracion vigente |
| 15 | Copropiedad 60/40 | Cargo unico, uno o varios obligados acreditados, sin division ni doble suma comunitaria; identidad/responsabilidad no acreditada bloquea atribucion personal definitiva, no se infiere 60/40 |
| 16 | Debido 110, emitido impagado 100 | Regularizacion 10. Aprobada/emitida la de 10, nueva propuesta 0, no -10; abono/reversion con cobertura disjunta |
| 17 | Apertura 5.300 al 31/12/2024 sin detalle | Saldo al corte documentado; años anteriores desconocidos, no recibos fabricados |
| 18 | Cargo 100 en diciembre, cobro 30 enero; corregido con registro marzo | Diciembre 100; enero 70 si evidencia; corte conocido anterior a marzo conserva lo que se sabia. Fechas imposibles bloqueadas |
| 19 | Mismo archivo y misma operacion en archivos distintos | Una correspondencia/operacion; distinta referencia genuina no se fusiona por importe |
| 20 | Dos usuarios aplican disponible 100 simultaneamente | Una confirma, otra conflicto; nunca 200 aplicado |
| 21 | Usuario lector intenta emitir/abonar/importar | Denegacion antes de escribir/staging sensible |
| 22 | Cobro comunidad A a recibo B | Rechazo transaccional y FK, cero efecto |
| 23 | Reintento comando y evento entregado dos veces | Un hecho economico; simulacion de consumidor genera un efecto contable, no dos |
| 24 | Checkpoint y backup posterior futuro | Restauracion aislada, checksums/integridad/FKs/recuentos/saldos coinciden |
| 25 | Devolucion mezcla fondos libres y aplicados, y reintegro de sobrepago | Ejemplo 200/80 de seccion 6 cuadra; reintegro libre no reabre recibo pagado |
| 26 | ERP 2 40 propiedades/16 jardines | Emision usa exactamente resultados congelados por periodo; nueva version no duplica; cambio maestro no altera emitido |
| 27 | Inquilino destinatario y pagador distinto | Snapshot de roles distintos; obligado no se deduce del inquilino; sin mandato implicito |
| 28 | Fallo intermedio lote, bloqueo ejercicio, preview obsoleto | Rollback total de sublote; rechazo de retroactividad bloqueada; nueva revision obligatoria |
| 29 | Apertura solapada con recibos/importacion nueva | Doble conteo bloqueado; corte/fuente unica y legacy preservado |
| 30 | UI 360/390/1440 px | Acciones alcanzables, incidencias visibles, lote/aplicaciones/comparacion antes-despues y documentos; sin desbordamiento global |
| 31 | Exceso 20 y nueva deuda 50; coincidencia inequívoca de cobro | Saldo a favor 20 y deuda 50 separados hasta confirmar; propuesta sola no escribe; aplicacion confirmada trazada una vez |
| 32 | Cargo con cobro totalmente revertido; borrar borrador autorizado | Primer caso no admite anulacion simple aunque saldo aplicado sea cero: rectificacion explicita; segundo permite descarte con auditoria, sin hecho economico |
| 33 | Marcar incobrable un pendiente 100 | Saldo total/historico 100 intacto, clasificacion separada, obligado/propiedad/documentos/motivo preservados; sin falso cobro |
| 34 | Reasignar excepcionalmente 40 de pendiente 100 A->B | Propuesta exige evidencia/autorizacion e impacto antes/despues; confirmacion atomica deja A 60/B 40 y total 100; original/historico intactos. Sin permiso, exceso, otra comunidad o version obsoleta: rechazo sin escrituras |
| 35 | Reintento y fallo intermedio de traslado; consulta anterior al efecto | Idempotencia, rollback total, auditoria/outbox; consulta temporal anterior conserva atribucion A. Venta posterior por si sola no ejecuta traslado |

## 14. Secuencia de implementacion propuesta

No autorizada por este documento. Mantener medicion del roadmap: cuatro hitos de 25 puntos SOLO por evidencia de implantacion.

1. **ERP 3A, contratos y compatibilidad:** D1-D6 ratificadas, checkpoint/backups y restauracion; migracion aditiva probada sobre copia, FKs, permisos y adaptador historico sin activacion ni reinterpretacion. Inventario de recuentos/sumas/identidades y cobertura.
2. **ERP 3B, servicios deterministas:** emision, movimientos/aplicaciones/contramovimientos, deuda a fecha, regularizaciones disjuntas, eventos y conflictos. Casos sinteticos y pruebas del adaptador ERP 2; sin UX ni datos financieros reales por defecto.
3. **ERP 3C, recorrido operativo:** fichas, lotes/importacion, cobro/revision, documentos y consumidores de deuda con fuente unica; interfaz movil/escritorio. Operaciones materiales solo segun politicas ratificadas. No iniciar ERP 4/5/6.
4. **ERP 3D, aceptacion y activacion:** pruebas completas, regresion ERP 0/1/2 y modulos actuales, igualdad de historico antes/despues, restauracion, comunidad/corte rector acordados, despliegue controlado, verificacion operativa y documentacion. Cierre solo tras evidencia, no por tablas existentes.

Riesgos prioritarios: atribucion historica no acreditada, `REAL` legacy, dobles escrituras Netfincas/ERP, doble ajuste en regularizaciones, confundir devolucion y reintegro, duplicar responsabilidad compartida y contabilizacion de entrada/aplicacion, ventanas de concurrencia. Todos tienen bloqueo o control definido; no se ocultan bajo una puntuacion de confianza IA.

## 15. Verificacion documental final

Deuda derivada; obligado historico congelado; venta no mueve deuda; aplicaciones N:M y parciales; devolucion como contramovimiento; rectificacion sin edicion; regularizacion sin reescribir recibos; aperturas sin fabricar historia; precision exacta; corte efectivo/conocido; eventos con consumo idempotente; integracion ERP 4/5/6 preparada; sin dependencia de LLM. Se reutilizan maestros, permisos base, auditoria, outbox, documentos y calculos existentes.

Coherencia contrastada con los documentos vigentes:

- ERP 0: capacidades explicitas por comunidad, transaccion de hecho/auditoria/outbox, idempotencia, concurrencia y checkpoint/backup/restauracion; ninguna operacion excepcional omite estas garantias.
- ERP 1: maestros y titularidad bitemporal reutilizados; copropiedad juridica independiente de obligacion y configuracion de cobro. No se modifican coeficientes, porcentajes de dominio ni historia por emitir, marcar incobrable o reasignar una obligacion.
- ERP 2: origen aprobado inmutable, importes/periodos y redondeos del snapshot, no prorrateo, cargo unico, destinatario de no emitidos a fecha efectiva de emision, emitidos preservados y regularizacion contra emitido neto, no cobrado. Adaptador de cobertura evita contar dos veces ajustes aprobados/materializados. Sin recalculo libre de cuotas.
- D5 sustituye expresamente la antigua condicion insuficiente de aplicaciones netas cero por ausencia de movimientos economicos posteriores. D6 conserva identidad de emision y permite documentar sucesiones de responsabilidad mediante hechos separados, no UPDATE del sujeto original. No hay contradiccion residual con inmutabilidad.

Solo se actualizan este documento y el roadmap. No se modifica codigo, datos, migraciones ni permisos; no se publica aplicacion ni se ejecutan pruebas economicas nuevas. Diseno ERP 3 CERRADO al 100%, listo para implementacion con Sol desde ERP 3A cuando se autorice. Implementacion certificada 0%, aceptacion funcional no ejecutada; ninguna decision funcional bloqueante pendiente en el alcance ratificado.
