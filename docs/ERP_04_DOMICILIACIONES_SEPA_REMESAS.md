# ERP 4 - Domiciliaciones, mandatos SEPA y remesas

Fecha: 11/09/2026. Contrato funcional, tecnico y UX v1.0. **Diseno: 100%, cerrado. Implementacion: 0%, PENDIENTE. Aceptacion funcional: pendiente de implementacion y pruebas.**

[Roadmap](ERP_COMUNIDADES_ROADMAP.md) | [Fundamentos](ERP_00_FUNDAMENTOS_IMPLEMENTACION.md) | [Maestros](ERP_MODELO_DATOS_MAESTROS.md) | [Roles de cobro ERP 2](ERP_02_MODELO_CALCULO_CONTRATOS.md) | [Contrato ERP 3](ERP_03_RECIBOS_COBROS_DEUDA.md) | [Cierre ERP 3](ERP_03_RECIBOS_COBROS_DEUDA_IMPLEMENTACION.md) | [Principios UX](ERP_UX_PRINCIPIOS.md).

Esta entrega solo documenta. No crea tablas, modifica recibos, conecta bancos, asigna permisos ni publica software. La ratificacion del usuario de las catorce reglas de ERP 4 y su autorizacion para resolver detalles tecnicos cierran este contrato. Datos de contratacion bancaria y habilitacion por comunidad se configuran antes del uso real; no son decisiones pendientes del modelo general.

## 1. Alcance y fronteras cerradas

Flujo: cuenta de pagador -> domiciliacion -> mandato acreditado -> seleccion de recibos -> reserva -> remesa -> fichero -> presentacion -> resultado -> rechazo/devolucion/reintento.

- ERP 4 controla autorizacion bancaria, instrucciones, evidencias y estado de presentacion. **No calcula cuotas ni mantiene una segunda deuda.**
- ERP 3 sigue siendo el unico escritor de recibos, cobros, imputaciones, devoluciones economicas, gastos y deuda. ERP 4 propone sus comandos y el usuario confirma el efecto economico.
- ERP 5 incorporara movimientos/extractos y conciliacion. No se construye un importador general de extractos ni un agregador bancario en ERP 4.
- Una cuenta admite varias propiedades. Una propiedad puede cambiar de cuenta; nunca se sobrescriben instrucciones anteriores. Cuenta, titular de cuenta, pagador, propietario, obligado, destinatario y firmante son papeles distintos.
- Una propiedad no se divide entre copropietarios ni varios cargos por defecto. Las alternativas de pagador se resuelven por concepto/vigencia; un intento utiliza una sola cuenta, mandato y pagador. Dividir simultaneamente un recibo entre varios pagadores no se activa en esta fase.
- Recibo reservado: ninguna segunda reserva activa, incluso para otra fraccion de su saldo. Cancelar libera reserva, no deuda. Exportar, presentar o aceptar tecnicamente no acredita un cobro.
- Devueltos/rechazados solo se proponen para reintento tras revision y confirmacion. No reenvios, imputaciones ni gastos automaticos ocultos.
- Quedan fuera: B2B operativo, tarjetas, transferencias de pago a proveedores, anticipos/financiacion, firma electronica cualificada propia, conexion automatica al portal bancario, ERP 5/6 y nuevos agentes.

## 2. SEPA y fuentes oficiales verificadas

### 2.1 Modalidad inicial y formato

**Decision tecnica DT-01:** primera modalidad **SEPA Direct Debit CORE en EUR**, recurrente y puntual. Es apropiada para comunidades que cobran a particulares y empresas; B2B no admite pagadores particulares y no se seleccionara por ser el acreedor una comunidad. [EPC: diferencias CORE/B2B](https://www.europeanpaymentscouncil.eu/what-we-do/sepa-direct-debit).

Base vigente consultada: Rulebook CORE 2025 v1.1 y guias C2PSP 2025 basadas en ISO 20022 de 2019. Desde **15/11/2026** deja de admitirse direccion exclusivamente no estructurada en los mensajes EPC. Se modelan direccion estructurada/hibrida y sus componentes desde el inicio; no se inventan localidad o pais a partir de texto dudoso. [EPC: versiones vigentes y cambio de direcciones](https://www.europeanpaymentscouncil.eu/what-we-do/epc-payment-schemes/sepa-direct-debit/sepa-direct-debit-core-rulebook-and-implementation).

Perfil inicial de salida: `pain.008.001.08`. Entrada tecnica base: `pain.002.001.10`. El contrato contempla inversion solicitada por acreedor mediante perfil `pain.007.001.09`, distinto de una cancelacion anterior al cobro; su exportacion solo se habilita con soporte bancario validado. RUM comparada sin distinguir mayusculas; identificador acreedor normalizado sin espacios ni distincion de mayusculas. Las restricciones de caracteres/longitud se validan con las guias, no mediante truncado de identidades. [EPC: guias C2PSP y mensajes](https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2025-10/EPC130-08%20SDD%20Core%20C2PSP%20IG%202025%20V1.0%20.pdf).

Normas que parametriza el validador: prenotificacion con 14 dias naturales salvo plazo acordado; calendario y corte del PSP, no confundir el limite interbancario D-1 con la hora limite del cliente; mandato sin uso durante 36 meses desde ultima presentacion, incluso fallida, requiere cancelacion y nuevo mandato; CORE contempla reembolso durante ocho semanas y reclamaciones no autorizadas hasta trece meses. RUM identifica mandato junto al acreedor sin su extension comercial. No se considera irreversible un cobro por haberlo aceptado el banco. [EPC: Rulebook CORE 2025 v1.1, apartados 4.2, 4.3, 4.8](https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2025-10/EPC016-06%202025%20SDD%20Core%20Rulebook%20version%201.1.pdf).

El documento de autorizacion debe identificar orden, cuenta, deudor bancario, acreedor, tipo de pago, fecha y firma. Un IBAN importado no acredita autorizacion. [SEPA Espana: mandato](https://www.sepaesp.es/sepa/es/faqs/elmandato/).

### 2.2 Adaptacion sin banco unico

**DT-02:** dominio canonico `erp_direct_debit_v1` separado de adaptadores registrados y versionados. Un perfil contiene modalidad, vigencia normativa, namespace/XSD/checksum, reglas de campos, paises/alcance, calendario/cortes, plazo de presentacion, limites de importe/lineas, secuencias permitidas, convenciones de referencias, capacidades de cancelacion/inversion y formatos de respuesta. No contiene formulas economicas ni codigo configurable por usuario.

Todo perfil bancario hereda validacion CORE y anade restricciones documentadas. Un formato antiguo o particular solo se habilita mediante adaptador con evidencia y pruebas; no hay fallback silencioso a otro XML. Separar version del esquema ISO, version EPC y revision del perfil del banco. La version elegida queda congelada por fichero.

Salida XML: libreria estructurada, XSD local fijado, reglas semanticas, totales en centimos y pruebas de ficheros de referencia. El XSD por si solo no acredita aceptacion bancaria. Secuencia bancaria se deriva del tipo/historia del mandato y perfil; no se deduce de si el recibo tiene deuda. No fabricar BIC ni exigir IBAN ES a todos los pagadores; validar IBAN por pais y posibilidad de operar en el esquema mediante el perfil, sin prometer comprobacion de titularidad o existencia real de cuenta.

Entrada: registro cerrado de adaptadores. Primero `pain.002` y formulario estructurado de resultado con evidencia bancaria. Para avisos de liquidacion/devolucion de otro formato se anade un adaptador documentado; `camt.053/054` queda preparado como referencia de ERP 5, no como un segundo importador de extractos. Un fichero no soportado queda como evidencia pendiente, no como resultado economicamente aplicado.

## 3. Reutilizacion comprobada, sin reauditoria

Referencia de codigo inspeccionada: `f3b538e0243834fa08bbd920a80adfa6a290ae0d`. Lectura dirigida de `server/erp_core` y contratos; sin abrir ni escribir la base productiva.

| Existente | Uso en ERP 4 / extension prevista |
|---|---|
| ERP 0: `contracts.py`, `database.py`, `audit.py`, `outbox.py`, `migrations.py`, registro de comandos | Sobres, `BEGIN IMMEDIATE`, control de version, permisos, idempotencia, auditoria y outbox. No nueva infraestructura paralela |
| `cf_propiedades`, `cf_propietarios`, titularidades ERP 1 | FKs por comunidad, identidades historicas y enlaces contextuales, sin duplicar sujetos ni mover deuda |
| `erp_personas_cobro`, `erp_config_recibo_versiones` y `budget_service.py` | Personas no propietarias, pagador/destinatario temporal y `referencia_medio` opaca. Resolver referencia hacia domiciliacion ERP 4, sin convertirla en IBAN |
| `erp_recibos`, `erp_recibo_sujetos`, `erp_cobros`, `erp_imputaciones`, `erp_devoluciones`, consultas ERP 3 | Saldo, sujetos de emision, fondos, aplicacion y reversos. Importes no se recalculan fuera de ERP 3 |
| `receivables_service.py`: `collection_record`, `allocation_*`, `return_*`; ajustes y gastos existentes | Unicos comandos economicos reutilizados. Cobro ya tiene identidad externa; devolucion tambien. No escrituras directas desde adaptador XML |
| Documentos, auditoria y UX vigentes | Evidencias vinculadas con permisos bancarios reforzados, fichas naturales y navegacion existente |
| Referencias legacy de remesa/cuenta | Solo staging/correspondencias; no prueban mandato, presentacion ni liquidacion |

**Extensiones necesarias y acotadas:** no se ha encontrado tabla operativa `erp_cuentas_tesoreria` en las migraciones consultadas, aunque esta prevista en maestros; se creara ese registro minimo, reutilizando referencias heredadas verificadas. Tampoco existe registro persistente de reserva bancaria en el servicio ERP 3 consultado: se anade guardia integrada conforme a su contrato de ERP 4, no se presupone implementada.

`erp_config_recibo_versiones.medio_previsto` admite hoy `transferencia/domiciliacion_pendiente/otro`: se conserva su compatibilidad. La aptitud para remesar la resuelve ERP 4 mediante `referencia_medio` y mandato; no se sobrecarga ni se migra silenciosamente ese enum. ERP 2 conserva la propiedad del dato de pagador configurado.

## 4. Modelo persistente objetivo

Nombres propuestos para migraciones futuras, no tablas creadas. Toda entidad de negocio: `id`, `id_comunidad`, version, actor de servidor, registro UTC, origen y evidencia cuando corresponda. Padres `UNIQUE(id_comunidad,id)`, FKs compuestas en hijos, indices locales. No FKs cruzadas entre comunidades. Identidades de persona: propietario existente XOR persona de cobro existente; comunidad acreedora referencia su maestro, no se crea un propietario ficticio.

Vigencia: intervalos efectivos `[desde,hasta)`, fin nullable; fecha de conocimiento/registro separada. Correcciones anaden revision con enlace a anterior. Una revision usada no se borra. Calidad de origen no se eleva sin evidencia. Estados operativos proyectados se versionan y cada transicion conserva evento; no es necesario duplicar todas las tablas en una segunda base historica.

| Entidad | Datos, relaciones y restricciones principales |
|---|---|
| `erp_cuentas_pagador` | Identidad de cuenta bancaria local a comunidad, IBAN normalizado cifrado, huella HMAC, ultimos cuatro caracteres/pais para mascara, estado. IBAN de identidad inmutable: cambiar numero crea otra cuenta, no edita la anterior |
| `erp_cuenta_pagador_versiones` | Alias, banco/BIC cuando requerido/verificado, moneda, procedencia, evidencia, estado y conocimiento. Referencia a secreto cifrado versionado. No saldo bancario |
| `erp_cuenta_personas` | Cuenta, sujeto, papel `titular/cotitular/autorizado/pagador`, vigencia/evidencia; varios papeles posibles. Ser propietario o tener email no prueba poder sobre cuenta |
| `erp_cuentas_tesoreria` | Registro minimo de banco/caja de comunidad, moneda, nombre, estado. Medio bancario protegido referenciado; caja no admite domiciliacion. Correspondencia explicita con `treasury_reference` legacy. Sin extractos ni conciliacion |
| `erp_acreedor_versiones` | Comunidad, nombre/identificacion/direccion, identificador SEPA y clave normalizada sin extension comercial, cuenta tesoreria, perfil banco/version, evidencia contractual, vigencia. Se pueden configurar varias cuentas; cada lote elige una |
| `erp_mandatos` | Identidad local, acreedor estable, RUM, modalidad, tipo `recurrente/puntual`, estado, origen. La identidad no depende de propiedad ni IBAN |
| `erp_mandato_versiones` | Mandato, cuenta version, deudor bancario, firmantes y representacion mediante relaciones referenciales, fecha firma, documento/hash, vigencia, modificaciones y campos originales para adaptador, causa/enlace anterior. Validacion exige evidencia, no firma dibujada inferida |
| `erp_mandato_eventos` | Alta, validacion, suspension, reanudacion, modificacion, revocacion, caducidad, utilizacion, cierre; fecha efectiva/conocida, actor, evidencia. Registro de presentaciones usado para inactividad/secuencia |
| `erp_domiciliaciones` / `erp_domiciliacion_versiones` | Propiedad, alcance/concepto, referencia configuracion ERP 2, mandato y cuenta, pagador acreditado, vigencia, estado y autorizacion. N propiedades pueden referenciar el mismo mandato si evidencia de alcance lo permite. No segundo dato rector de titularidad/pagador |
| `erp_prenotificaciones` | Lineas/calendario cubiertos, destinatario bancario, importes/fechas notificados, canal, evidencia de envio, plazo/acuerdo excepcional, hash, version. Borrador generado no equivale a notificacion enviada |
| `erp_remesas` / `erp_remesa_revisiones` | Comunidad, acreedor/cuenta/perfil, nombre, fecha cargo, EUR, estado/version, revision confirmada, actor; totales derivados de lineas, no saldo de deuda |
| `erp_remesa_lineas` | Revision, recibo ERP 3, intento, importe centimos positivo, huella de saldo/version ERP 3, pagador/mandato/cuenta/acreedor congelados, fecha cargo, prenotificacion, referencias XML, origen de reintento. Un intento por recibo y revision |
| `erp_remesa_reservas` | Recibo, linea/intento, importe, estado activa/liberada/consumida, causa/fechas. UNIQUE parcial `(id_comunidad,recibo_id)` cuando activa. UNIQUE intento. Historico conservado |
| `erp_remesa_ficheros` | Revision/perfil/motor, MsgId, grupos PmtInfId, hash SHA-256 de bytes, longitud, totales, localizacion cifrada, version de clave, fechas/actor. Artefacto inmutable; re-descarga no regenera XML |
| `erp_remesa_presentaciones` | Fichero/hash, canal, fecha, usuario, evidencia/acuse, referencia banco, estado y solicitud de cancelacion. Descarga y presentacion son hechos distintos |
| `erp_resultados_bancarios` / `erp_resultado_lineas` | Staging, fuente/hash, perfil/parser, IDs externos y originales, tipo, codigo/motivo, fechas, importe, cobertura fichero/grupo/linea, correspondencia y evidencia. Mantener resultado original cifrado |
| `erp_banco_operaciones` / `erp_banco_identidades` | Identidad canonica de operacion externa, aliases PSP/cuenta/referencia, tipo, linea, importes/fechas, IDs de cobro/devolucion ERP 3, estado de revision/aplicacion. Registro compartible con ERP 5, sin calcular saldos |
| `erp_banca_importaciones` / filas / correspondencias | Staging maestros bancarios, fuente/hash/corte, datos protegidos, errores, decision humana y entidades resultantes; no escrituras a ERP 3 por importar un mandato |

Restricciones adicionales: fechas/estado validos, cantidades positivas y EUR, imports nunca float/REAL, sujetos XOR comprobados, version unica por agregado. Relaciones N:M tipadas, no IDs arbitrarios guardados en JSON. JSON se reserva a parametros versionados, copias documentales y proyecciones; valida esquema cerrado.

Cada linea congela tambien nombre/direccion bancaria del acreedor y deudor, firmantes/referencia de evidencia, secuencia, concepto bancario validado, fecha de firma/modificacion, autorizacion y version de adaptador; campos sensibles dentro del bloque cifrado. Referenciar solo el maestro mutable no constituye snapshot. Importe: entero de centimos en SQLite/Python y string entero en JSON, formateado a dos decimales exclusivamente por adaptador; sumas y limites comprobados antes de exportar. La linea no calcula intereses ni redondea un saldo importado dudoso.

## 5. Cuentas, domiciliaciones y papeles

### 5.1 Cuenta y alcance

**DT-03:** deduplicar cuenta por `(comunidad, huella_HMAC_IBAN)` con identificador opaco. No deduplicar nombres por similitud ni compartir datos bancarios entre comunidades. La misma cuenta puede existir en dos comunidades con permisos/evidencias independientes. Una cuenta admite varios titulares y pagadores acreditados.

Una domiciliacion es la instruccion operativa para propiedad/concepto y fechas; un mandato es el consentimiento bancario. El mandato puede cubrir varias propiedades del mismo acreedor si su evidencia no lo limita. La UI permite seleccion masiva de propiedades sin crear varias copias de la cuenta ni del mandato. Cada recibo sigue produciendo su linea; no se agregan recibos silenciosamente por compartir IBAN.

Por propiedad/concepto/fecha, una domiciliacion efectiva prioritaria. Alcance especifico prevalece sobre general igual que ERP 2; dos candidatas de igual prioridad bloquean. La configuracion normal elige pagador ERP 2 y medio ERP 4. Cambiar persona utiliza el servicio ERP 2 y la vinculacion ERP 4 en unidad coherente, nunca un segundo campo editable divergente.

### 5.2 Recibos historicos y cambio de cuenta

No se modifica pagador/destinatario/obligados congelados al emitir. Para la presentacion bancaria se selecciona autorizacion vigente para la fecha prevista de cargo y conocida al confirmar/exportar. Si la configuracion actual no corresponde al pagador del recibo emitido, **no se usa el nuevo propietario por defecto**. Cobrar a un tercero exige seleccion explicita, mandato y evidencia que cubran ese recibo; se conserva como pagador de ese intento y del eventual cobro, no como nuevo obligado del cargo.

Cambiar IBAN: elegir/crear cuenta -> evidencia -> actualizar mandato mediante modificacion valida o nuevo mandato -> fecha efectiva -> revisar propiedades y remesas afectadas -> confirmar. No revocar globalmente una cuenta o mandato compartido por desvincular una propiedad. Revisiones no presentadas quedan invalidadas si afectan a su autorizacion; las presentadas conservan sus valores y generan incidencia si hay revocacion/cambio relevante.

No se sustituye al deudor bancario de un mandato por cambiar titularidad de propiedad. Nuevo deudor sin autorizacion precedente suficiente requiere mandato nuevo. La representacion del firmante se acredita; la aplicacion no certifica poderes por inferencia.

## 6. Mandatos: identidad, estados e historico

**DT-04:** nueva RUM generada en servidor (`M` + UUID aleatorio en hexadecimal mayusculo, 33 caracteres); no codifica nombre, IBAN o propiedad. Una importada conserva texto original y clave normalizada conforme al perfil. No renumerar mandatos antiguos para encajar una plantilla.

Unicidad real por acreedor normalizado sin extension comercial + RUM normalizada. Dentro de la comunidad: UNIQUE; entre comunidades con el mismo acreedor: guardia de colision mediante huella HMAC opaca de esa pareja, sin revelar la otra comunidad. La referencia no se reutiliza tras revocacion. Si existe una modificacion acreditada de referencia/acreedor, conservar alias unico y cadena anterior, no simular un alta desconectada. Se admite nuevo mandato vinculado como sucesor; no se trasladan autorizaciones sin evidencia.

| Estado | Entrada / salida permitida |
|---|---|
| Borrador | Datos/evidencia incompletos; sin remesa. Puede descartarse si nunca utilizado, con traza |
| Pendiente de validar | Firma/evidencia incorporada, falta revision autorizada; no elegible |
| Activo | Confirmacion con firma/fecha/cuenta/acreedor/alcance validos; autoriza segun vigencia |
| Suspendido | Incidencia temporal o autorizacion dudosa; bloquea nuevos intentos; reanudar exige motivo/evidencia |
| Revocado | Fecha/evidencia de retirada; irreversible para esta identidad, nuevo mandato si se vuelve a autorizar |
| Caducado por inactividad | Guardia temporal del perfil; no puede reactivarse como si siguiera vigente |
| Agotado/cerrado | Puntual utilizado o finalizacion expresa recurrente; nuevas operaciones requieren autorizacion aplicable |

Modificacion no es sobreescritura ni obliga a que todo cambio sea mandato nuevo. Una revision lleva los atributos originales necesarios, evidencia de consentimiento y tipo de cambio permitido por perfil. El adaptador genera los indicadores de modificacion. Un cambio no soportado queda pendiente, no se exporta sin la informacion requerida.

Puntual: una sola instruccion autorizada; no reutilizar un mandato agotado. Si un fallo tecnico acredita que no se ejecuto, el perfil puede permitir repetir el mismo objeto autorizado como nuevo intento, con confirmacion y sin ampliar alcance. Si resultado desconocido, bloqueo. Recurrente: ultimo uso se basa en presentacion acreditada, no en descarga; generacion de XML no renueva vigencia. Para importados sin historial suficiente se exige evidencia antes de declararlos aptos. Para nunca usados se aplica control conservador desde firma y validacion del perfil antes de primer cargo; no se inventa un ultimo uso.

## 7. Elegibilidad y reservas

### 7.1 Seleccion

Consulta ERP 3 con comunidad explicita: recibos emitidos/activados con identificacion acreditada, EUR, saldo positivo, cobertura suficiente, no anulados, sin reserva activa, sin resultado bancario contradictorio pendiente. Saldo agregado legacy sin recibo activado no es remesable. Incobrable o disputa con bloqueo operativo no se incluye por defecto; requiere revision expresa conforme a ERP 3, no cambia clasificacion para cobrar.

Por linea: verificar pagador/evidencia, domiciliacion y mandato, cuenta, acreedor/perfil vigentes, limite bancario, fecha cargo/presentacion, prenotificacion y versiones. Admitir recibo parcialmente pagado por su **pendiente ERP 3**, nunca importe original completo. Mostrar pendiente y lo seleccionado. Primera operativa usa todo el pendiente por intento, sin fraccionado manual ni compensacion automatica de saldos a favor.

Filtros: comunidad, periodo/concepto, vencimiento, propiedad/estructura, propietario, pagador, estado, pendientes/rechazados/devueltos y mandato. Seleccionar visibles o todos los resultados con contador e importe. Vista previa materializa IDs/versiones; una busqueda cambiante no amplifica posteriormente la seleccion. No mezclar comunidades, monedas o cuentas acreedoras en una remesa; preparacion masiva produce lotes separados y explicitamente revisados.

### 7.2 Concurrencia y cambios de saldo

**DT-05:** seleccionar no reserva. Confirmar preparacion crea todas las reservas del lote en `BEGIN IMMEDIATE` tras revalidar permisos, saldo/version, cuenta, mandato y configuracion. UNIQUE parcial arbitra entre dos usuarios. Falla una linea -> rollback completo; el usuario puede volver a confirmar un subconjunto explicitamente mostrado. No omitir filas silenciosamente. Sin caducidad automatica de reservas; bandeja muestra antiguedad y cancelacion.

Guardar propuesta incluye huella de entradas/seleccion y versiones. Confirmar con huella obsoleta responde conflicto y diferencias; no decide por el usuario. Cuenta/mandato/perfil se validan de nuevo antes de exportar y de registrar presentacion. La cantidad queda fijada por revision, no mutable por recalculo posterior.

Guardia integrada ERP 3: una anulacion simple con reserva activa se bloquea, como exige su contrato. Un cambio economico confirmado que afecte a un recibo reservado no desaparece ni se rechaza como si el dinero no hubiera llegado: si aun no se ha descargado fichero, marca revision obsoleta y exige cancelar/repreparar; si el fichero pudo salir, mantener reserva, incidencia y gestionar retirada/resultado. No silenciar cobros manuales reales. Si se cobra dos veces, ERP 3 conserva fondos no aplicados y propone tratamiento, nunca fabrica una imputacion negativa.

La guardia se ejecuta en el mismo limite transaccional de los comandos ERP 3 que afecten al saldo; un outbox diferido no sustituye ese control. Registrar fondos no requiere imputarlos, por lo que no se impide capturar evidencia mientras se resuelve el conflicto.

## 8. Remesas, ficheros y cancelaciones

### 8.1 Estados de trabajo

| Estado de remesa/revision | Significado y operaciones |
|---|---|
| Borrador | Editable, sin reserva, puede eliminarse segun permisos; conservar auditoria |
| Preparada | Seleccion confirmada y reservada, snapshot fijado; cambiar contenido crea revision tras liberar la anterior cuando sea seguro |
| Validada | Perfil, autorizaciones, prenotificacion, saldo y fechas correctos; informe de validacion conservado |
| Fichero disponible | Artefacto final generado y cifrado; aun no necesariamente descargado ni presentado |
| Exportada / presentacion no confirmada | Fichero entregado al navegador o a un canal; no presupone presentacion, pero existe riesgo de ejecucion externa |
| Presentada | Evidencia de entrega al banco, fecha/referencia. No significa aceptada ni cobrada |
| En seguimiento | Resultados parciales/aceptaciones y lineas pendientes; resumen derivado por lineas |
| Cancelacion solicitada | Banco debe confirmar retirada; reservas activas hasta resultado por linea |
| Cancelada | Todas las lineas retiradas/canceladas acreditadas y reservas liberadas; historico intacto |
| Finalizada | No quedan instrucciones activas sin resolver. Puede tener cobradas/rechazadas/canceladas; admite eventos posteriores de devolucion |

Obsoleta/con incidencias son indicadores adicionales, no un estado que borre presentacion. Aceptacion tecnica, financiera y estado del recibo se muestran separados. Una devolucion posterior reabre seguimiento por la linea sin reescribir el cierre previo.

### 8.2 Fichero inmutable y envio

**DT-06:** operativa inicial exportar fichero y subirlo al portal bancario por el usuario. No almacenar credenciales del banco ni automatizar envio. `Registrar presentacion` pide fecha y justificante/referencia; una descarga solo registra exportacion. Re-descarga devuelve los mismos bytes, referencias y hash con auditoria de nuevo acceso. Para cambiar fecha, importe, cuenta, mandato o perfil: nueva revision y nuevas referencias, previa retirada segura de la anterior.

Un `MsgId` por fichero, `PmtInfId` por bloque y `EndToEndId` por intento; generados opacos y unicos, con formato validado y sin PII. Agrupar bloques por cuenta acreedora/fecha/secuencia segun perfil sin agrupar obligaciones. Identificadores historicos de reintento se conservan como relaciones, no se reciclan. Totales y numero de operaciones corresponden a lineas exportadas; nunca sumas con coma flotante.

Generacion fuera de lock SQLite usando snapshot: almacenar temporal cifrado -> validar XSD/reglas -> comprobar hash/version bajo transaccion -> asociar artefacto final. No ofrecer descarga de fichero incompleto. Fallo elimina/recoge huerfano cifrado, mantiene revision recuperable. No se llama al banco bajo lock.

### 8.3 Cancelacion y reintento

- Antes de exportar: cancelar atomicamente y liberar reservas; invalidar descargas, conservar snapshot/artefacto como cancelados.
- Despues de exportar sin presentacion registrada: exigir declaracion explicita de no presentacion y motivo. Si no puede acreditarse, estado pendiente de comprobar; no libera. Advertir que la app no puede retirar una copia descargada.
- Despues de presentar o con entrega incierta: registrar solicitud, no simular cancelacion bancaria. Solo confirmacion acreditada por linea libera su reserva. Rechazo de cancelacion conserva seguimiento. Parcial: liberar solo lineas acreditadas; lote no figura totalmente cancelado.
- Tras liquidacion: no hay cancelacion local que borre fondos. Una inversion por acreedor es propuesta separada con evidencia y comando ERP 3 aplicable; el adaptador de inversion solo genera solicitud, no ejecuta el reverso economico por exportarla.
- Reintento: original rechazado/cancelado/devolucion resuelta, sin reserva activa ni resultado ambiguo; corregir causa, revalidar mandato/prenotificacion, consultar saldo ERP 3 y confirmar nueva linea. Nunca crear un segundo recibo ni duplicar gastos del mismo incidente.

## 9. Resultados y fuente economica unica

### 9.1 Interpretacion

| Resultado normalizado por linea | Reserva y efecto |
|---|---|
| Acuse / validacion tecnica / aceptada para proceso | Conservar reserva; sin cobro. Un `pain.002` de aceptacion no se convierte indiscriminadamente en liquidacion |
| Rechazo definitivo anterior a liquidacion | Liberar reserva, deuda igual, conservar razon; reintento propuesto tras resolver causa |
| Pendiente / desconocido / cancelacion en curso | Mantener reserva y mostrar incidencia, sin inferir exito por silencio o fecha |
| Liquidacion acreditada | Proponer registro/enlace de cobro ERP 3 e imputacion humana. Al confirmar resultado y efecto atomico, consumir reserva; ya no es instruccion en curso |
| Devolucion/reembolso sobre cobro existente | Proponer ERP 3 `return_preview/confirm` sobre ese cobro/aplicaciones; no sumar deuda otra vez por estado bancario |
| Aviso de devolucion sin cobro previo identificado | Incidencia pendiente; no crear cobro ficticio para poder revertirlo. Registrar cobro y reverso solo si evidencia acredita ambos hechos y fechas; en otro caso deuda sigue igual |
| Resultado desconocido/conflictivo | Staging visible; ningun efecto economico ni liberacion insegura |

Una entrada de liquidacion exige referencia verificable, importe, EUR, fecha efectiva, cuenta acreedora y evidencia de fondos, no solo fecha prevista de cargo. No deducir bruto/restar comisiones cuando el abono neto no viene desglosado. Entrada global sin detalle de cobertura/identidad no se reparte por proporcion. Puede registrarse evidencia y quedar pendiente del detalle o ERP 5.

Resultados de fichero/grupo se expanden solo a sus lineas identificadas y cuando el significado del codigo cubra inequivocamente ese conjunto. Un resultado parcial no arrastra las no mencionadas. Orden por fecha de registro no decide prioridad: guardar fecha bancaria, conocimiento y transicion admitida; aviso antiguo no revierte una liquidacion posterior. Correccion de resultado confirmado es evento nuevo, con motivo/evidencia, nunca reemplazo.

Todo resultado se aplica al intento identificado, no a la ultima remesa del recibo. Un rechazo tardio del intento anterior nunca libera la reserva del siguiente. Si llega liquidacion acreditada de un intento declarado cancelado, registrar contradiccion y proponer el cobro real sin borrarlo; bloquear/revisar cualquier nuevo intento en curso y gestionar retirada. Un cierre local no permite ignorar hechos bancarios posteriores. Un aviso de devolucion sin cobro enlazado solo libera la reserva si acredita expresamente que esa instruccion ya no puede ejecutarse y el usuario confirma; conservar la incidencia de historia incompleta antes de proponer reintento.

Codigos R: catalogo tipado versionado con texto claro y recomendacion. Por ejemplo cuenta incorrecta -> revisar cuenta; falta de mandato -> bloquear uso hasta acreditar; fondos insuficientes -> propuesta de reintento, no cambiar IBAN. Codigo desconocido siempre revisable, nunca mapeado a cobrado. Una recomendacion no autoriza gasto ni modifica deuda.

### 9.2 Deduplificacion ERP 4 / ERP 5

**DT-07:** `erp_banco_operaciones` identifica un hecho externo comun, no cada archivo que lo contiene. Clave estable basada en PSP/cuenta acreedora e ID bancario/servicio/tipo cuando este disponible; conservar aliases EndToEndId/MsgId/ref de retorno/ref bancaria. Idempotencia de importacion por hash no sustituye identidad del hecho. No casar por nombre+importe+fecha como si fueran identidad cierta.

Misma identidad con mismo contenido devuelve resultado previo; con contenido distinto, conflicto. Nueva fuente para misma operacion enlaza evidencia. Si ERP 5 recibe el movimiento de un cobro ya registrado desde remesa, referencia el mismo `erp_cobros.id`, no crea fondos otra vez. Si existe cobro manual sin identidad externa comun, sugerir candidatos y exigir confirmacion de enlace; sin evidencia suficiente, pendiente.

Entrada sin identificador fiable requiere acreditacion manual de correspondencia antes del efecto. Registrar referencia local de evidencia no permite asegurar deduplicacion automatica frente a otra fuente: mostrar limite y exigir revision. No se pierde el documento original al consolidar aliases.

### 9.3 Integracion de comandos y atomicidad

Registrar resultado bancario es un hecho operativo; materializar fondos requiere permisos ERP 3 y confirmacion humana. La revision muestra por separado `Registrar cobro`, `Imputar a estos recibos`, `Registrar devolucion` y gastos propuestos. Se pueden confirmar juntos en un lote explicitamente revisado; no utilizar una casilla de importacion para autorizar efectos no mostrados.

El limite de transaccion abarca confirmacion de resultado + guardia de identidad externa + comando(s) ERP 3 + transicion de reserva + auditoria + outbox. Reutilizar operaciones de dominio ERP 3 con la misma conexion/actor; sus wrappers actuales abren conexion propia. Durante implementacion extraer el nucleo necesario a primitivas internas con conexion compartida, conservando API, validaciones y pruebas. **No llamar un servicio que abre otra escritura SQLite desde dentro de un lock, ni copiar su SQL economico a ERP 4.**

Cobro e imputacion mantienen operaciones distintas y sus eventos; pueden agruparse atomicamente. Importe aplicable nunca supera el pendiente real; sobrante confirmado queda no aplicado en ERP 3. No compensacion futura automatica. Una reserva termina por rechazo/cancelacion o procesamiento acreditado, no por editar el estado visual.

Devolucion: respetar N:M y parciales del cobro existente, revertir solo aplicaciones identificadas. Gastos reutilizan politica comunidad ERP 3 (ninguno/coste real/fijo); cargo independiente, evidencia y dedupe por incidente/concepto. Banco aplica gasto pero no hay evidencia del coste -> no inventar importe. ERP 4 no configura otra politica distinta.

Inversion bancaria acreditada de una domiciliacion erronea: reverso de ese cobro y sus aplicaciones mediante el mismo dominio ERP 3, con tipo/origen bancario conservado. No implica abonar la obligacion. Si tambien procede rectificar el cargo, es una propuesta separada de abono ERP 3 con motivo y autorizacion. Un reintegro ordinario de saldo a favor utiliza el servicio de reintegros existente; no se clasifica artificialmente como devolucion de recibo. Ningun XML de solicitud materializa por si mismo estos efectos.

Periodo bloqueado: no abrir ejercicio ni modificar fecha bancaria para salvar la validacion. Resultado se conserva pendiente de tratamiento ERP 3 con usuario autorizado; mostrar bloqueo. ERP 5 consumira este mismo limite de comando, no escribira a las tablas desde su parser.

## 10. Seguridad, permisos y datos bancarios

### 10.1 Almacenamiento y claves

**DT-08:** cifrado autenticado de IBAN y evidencias bancarias en servidor, biblioteca mantenida, AES-256-GCM con nonce unico por cifrado; claves fuera de SQLite/Git. DEK por comunidad protegida por KEK del despliegue, con version/rotacion. AAD vincula comunidad, entidad y version; HMAC con clave separada para busqueda/deduplicacion, no SHA simple de IBAN. No implementar criptografia propia. Esta eleccion sigue separacion de claves y cifrado autenticado recomendados por [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html).

Guardar formato normalizado para validar; mascara `ES** **** ... 1234` no revela posiciones innecesarias. No guardar IBAN claro en snapshot JSON, staging, cache, registros de comandos, auditoria, outbox, trazas HTTP o nombres de archivos. Respuestas idempotentes contienen IDs/mascaras; hash del comando con datos bancarios usa proyeccion/HMAC, no evidencia reutilizable de IBAN. Revisar redaccion de errores y trazas del puente Node/Python.

HMAC y cifrado llevan identificador de clave independiente. Rotar clave de busqueda requiere mantener claves anteriores de lectura durante la transicion y recalcular indices bajo control de unicidad, sin crear cuentas/mandatos nuevos. La capacidad de lectura enmascarada no necesita descifrar IBAN. Al fallar la autenticacion criptografica, bloquear revelado/exportacion con incidencia segura; nunca sustituir por texto vacio y generar un fichero aparentemente valido.

Version logica del documento/remesa y hash de su contenido no cambian por rotar cifrado. Almacenamiento cifra el artefacto y conserva referencia/version de clave; la re-descarga autorizada devuelve bytes originales. Las firmas de mandatos y archivos bancarios van en almacenamiento protegido usando catalogo documental existente, no en carpeta estatica publica. Rutas genericas de documentos no pueden eludir ACL bancaria; si no permiten esa politica, extender la comprobacion central, sin crear un gestor documental paralelo.

Backups: base, adjuntos y artefactos cifrados con manifiestos/hashes; custodia y copia recuperable de claves por canal separado, acceso restringido y procedimiento de recuperacion probado. El empaquetado ERP 0 incluye configuracion: excluir claves en claro de ese paquete o cifrar envoltorio con clave externa y verificarlo. No basta cifrar SQLite si el mismo backup trae la clave abierta. Restauracion aislada prueba descifrado y enmascarado; perdida de claves impide recuperar datos.

Retencion por tipo de evidencia y obligaciones aplicables del responsable; conservar historicos vinculados y bloqueos de conservacion. No purgar automaticamente por llegar a 13 meses ni prometer retencion ilimitada de PII. Configurar politica de retencion antes de activar borrados; estado inicial sin purga automatica. Una politica de proteccion no autoriza borrar historia economica ni destruir evidencia vigente.

TLS y sesiones seguras para consulta/revelado/exportacion bancaria; no habilitar IBAN claro sobre HTTP de red local. El despliegue determina HTTPS y custodia de claves antes de activacion real. Administrador del servidor con acceso a proceso+claves sigue siendo frontera de confianza; no se promete defensa criptografica frente a ese administrador.

### 10.2 Capacidades

Capacidades de ERP 4 por comunidad, denegar por defecto, actor derivado de sesion; no concederlas por nombre de usuario, por ser presidente ni por `puede_actualizar`. Reutilizar infraestructura ERP 0; asignacion explicita de capacidades economicas compatible con ERP 3.

| Capacidad | Acceso |
|---|---|
| `banking.read_masked` | Cuentas/mandatos/remesas enmascarados y estados |
| `banking.manage_accounts` | Proponer/confirmar cuenta y relaciones con evidencia; no lectura masiva de IBAN por tener escritura |
| `banking.manage_mandates` | Validar/modificar/suspender/revocar mandato y domiciliacion |
| `banking.configure_creditor` | Acreedor, cuenta comunidad y perfil; reautenticacion reciente para cambios sensibles |
| `banking.prepare` | Vista previa/reserva/validacion de remesa |
| `banking.export` | Descarga de fichero final y documentacion bancaria expresamente autorizada; advertencia de datos completos y registro de acceso |
| `banking.reveal` | Revelado puntual de IBAN/evidencia sensible tras reautenticacion reciente y motivo; no aplica a toda la pagina |
| `banking.present_cancel` | Registrar entrega y gestionar retirada/cancelacion acreditada |
| `banking.results` | Importar/mapear/confirmar resultados operativos; efectos economicos requieren ademas capacidades ERP 3 correspondientes |
| `banking.audit` | Historico y accesos sin valores bancarios completos |

Exportar es en si permiso de acceso a datos completos del lote, distinto del revelado puntual. Puede asignarse a la misma persona que prepara; el contrato no impone doble firma bancaria ni inventa autorizaciones de la junta. Perfil presidente/seguridad no recibe permisos bancarios automaticamente. Revocar acceso tiene efecto en consulta, reintento, descarga y confirmacion, aunque propuesta anterior siga visible en cache.

CSRF/session segun contrato actual, limites y validacion de cargas, sin DTD/entidades externas/XML remoto, limites de tamano/profundidad/zip-bomb, antivirus cuando disponible. Ficheros resultado son datos no confiables; textos no se ejecutan ni se interpretan como instrucciones IA. Descargas autenticadas de corta duracion, `no-store`, sin URL publica ni IBAN en URL, registros o telemetria. CSV/Excel exportados neutralizan formula injection.

### 10.3 Auditoria, herramientas e IA

Auditar cambios, confirmaciones, revelados, descargas, presentaciones, cancelaciones, importaciones y enlaces de resultados: actor, UTC/fecha efectiva, comunidad, entidad/version, antes/despues seguros, motivo, origen, evidencia/ref, correlacion y permiso usado. Cuenta antes/despues como IDs+mascaras, nunca IBAN; no copiar documentos completos al log. Heredar limites de inmutabilidad de ERP 0.

Herramientas futuras devuelven estado/mascara/ID, no secreto ni XML. Preparar propuesta no exporta ni presenta. Agente sin SQL libre y sin permiso bancario implicito; confirmaciones enlazadas a usuario, comunidad, seleccion y version. Enviar datos completos a IA externa requiere autorizacion explicita, necesidad concreta, alcance minimo y politica de proveedor; deshabilitado por defecto. Evidencias bancarias excluidas de RAG general y de OCR externo no autorizado.

## 11. Contratos de servicios y eventos

Catalogo objetivo sobre `/api/erp/query` y `/api/erp/command` y dispatcher cerrado, no rutas nuevas obligatorias:

- Consultas: `erp4.accounts.list/detail`, `mandates.list/detail/history`, `property.direct_debit`, `receipts.eligible`, `remittances.list/detail/history`, `results.pending`, `banking.audit`.
- Comandos revisables: `accounts.create/link/retire`, `mandates.create/validate/amend/suspend/revoke`, `direct_debit.preview/confirm`, `remittance.preview/prepare/validate/build/export`, `presentation.record`, `cancellation.preview/confirm/request/result`, `retry.preview/confirm`, `results.import/map/preview/confirm`, `bank_operation.link`, `banking.import.preview/confirm`.
- `export` autoriza entrega del artefacto existente, no otra generacion ni un efecto economico. Revelado usa ruta/autorizacion dedicada, no respuesta cacheada general.

Sobre comun: comando/version de contrato, comunidad, payload tipado, idempotency key, expected_version, motivo, evidencia, origen; actor no editable. Propuesta: IDs, versiones, fecha de evaluacion, hash/HMAC de entradas, lineas, sumas, incidencias bloqueantes/avisos y cambios. Confirmacion invalida si cambia cualquier dato relevante; HTTP 409 legible. Errores no enumeran existencia en otra comunidad.

Transaccion de comando: reautorizacion -> replay seguro -> versiones/guardias -> escritura de dominio -> auditoria -> outbox -> respuesta segura e idempotente. Misma clave+misma solicitud reejecuta lectura del resultado previo; misma clave+otra solicitud da conflicto. Restricciones de dominio evitan duplicados aunque cliente use otra clave. Todos los comandos materiales requieren idempotencia y confirmacion, no solo los HTTP.

Eventos operativos `erp4.remittance.prepared/exported/presented/cancelled`, `erp4.line.rejected/settlement_reported/return_reported`, `erp4.mandate.changed`, con comunidad, agregado/version, IDs opacos, importe en centimos como string cuando cruce JSON, fechas, origen y correlacion. Payload minimo sin datos bancarios. No anunciar `paid` desde exportacion. Hechos monetarios y contables solo se publican por ERP 3.

Outbox al menos una vez; consumidor/inbox idempotente. Antes de worker externo, extender recuperacion de reclamaciones abandonadas de ERP 0 mediante lease/timeout y pruebas. No es requisito para exportacion manual sin worker. ERP 5 comparte identidades externas y recibe contrato de trazabilidad, no un numero de saldo alternativo.

## 12. UX operativa

Mantener `Gestion -> Bancos y remesas`, sin pestanas por cada tabla. Remesas es vista principal; `Cuentas y mandatos` y `Configuracion bancaria` son accesos secundarios. No introducir el futuro modulo de conciliacion como acceso vacio.

| Pantalla | Informacion principal | Acciones / detalle progresivo |
|---|---|---|
| Propiedad | Pagador, cuenta enmascarada, mandato apto/no apto, vigencia; propietario juridico separado | `Configurar domiciliacion`, `Cambiar cuenta`, `Ver historico`; vinculos a evidencia y propiedades compartidas |
| Propietario/pagador | Cuentas y propiedades que las utilizan; no atribuirle toda deuda de esas propiedades | Elegir cuenta existente, gestionar mandato y aplicaciones masivas revisadas |
| Preparar remesa | Comunidad, cuenta acreedora, fecha cargo propuesta, filtros y tabla de recibos | Seleccionar visibles/todos, importe/numero, excluidos con motivo; no reservar al marcar casillas |
| Revisar | Incluidos/excluidos, importes, pagadores, autorizaciones, avisos y prenotificacion | Resolver incidencias, confirmar preparacion; no XML, IDs ni claves tecnicas |
| Validar/exportar | Total, fecha, entidad, validacion y consecuencias | `Descargar fichero`, despues `Registrar presentacion`; estados claramente distintos |
| Historico/detalle | Lineas y resultados, pendientes, rechazos, cancelaciones, cobros ERP 3 | Re-descarga autorizada, evidencia, detalle de codigo bancario en desplegable |
| Resultados | Archivo o evidencia manual, deteccion, coincidencias, errores y efectos propuestos | Revisar por linea, confirmar lote/subconjunto explicito, enlazar cobro ya existente |
| Reenviar | Devueltos/rechazados aptos, causa, saldo actual, nueva fecha | Corregir causa, propuesta masiva, nueva confirmacion sin duplicar recibos |

**Mejoras autonomas de diseno:** reutilizacion masiva cuenta/mandato con alcance visible; bandeja de mandatos incompletos y remesas sin resultado; prenotificacion por calendario consolidado cuando la evidencia cubra fechas/importes; deteccion de cambios de saldo antes de exportar; re-descarga inmutable; resumen explicito de recibos excluidos. No automatizacion de correo ni recordatorios externos nueva en esta fase.

Prenotificacion: generar documento/borrador con referencias, importes y fecha, usando documentos/comunicaciones existentes. Registrar envio realizado y evidencia por canal; calendario anterior sirve si cubre realmente estas lineas. Plazo distinto del base requiere acuerdo acreditado por deudor/mandato, no un ajuste comunitario que lo presuponga para todos. Cambio de importe/fecha invalida cobertura y recalcula primera fecha posible sin alterar recibo. Usuario confirma nueva fecha; no desplazarla silenciosamente.

Escritorio: tabla compacta con totales/seleccion visibles, columnas sensibles enmascaradas, detalle lateral o ficha existente. Movil 390 px: una columna, detalle por linea, filtros plegados, acciones fijas sin tapar contenido y tabla con scroll local si necesario. Incidencias/totales/fecha no se ocultan en avanzado. Formularios cortos, ayuda contextual, fechas propuestas editables y ningun IBAN completo en listado.

## 13. Migracion y activacion futura

Sin migracion en esta entrega. Implementacion futura aditiva en registro ERP 0 con numero siguiente realmente disponible, checksums de migraciones antiguas intactos. No asignar ahora un numero que pueda colisionar.

1. Checkpoint Git + backup SQLite consistente/documentos/configuracion + restauracion aislada, antes de cambios persistentes. Extender custodia de claves segun seccion 10; Git no sustituye backup.
2. Crear registros bancarios vacios y guardias; probar en copia, FKs/integridad y regresion ERP 0-3. No autogenerar mandatos para preferencias ERP 2.
3. Importar cuentas/mandatos existentes mediante archivo -> mapeo -> staging protegido -> validacion -> vista previa -> confirmacion. IBAN, RUM, firma, fechas, acreedor y alcance sin evidencia quedan pendientes. Calidad observada no se valida por existir fila legacy.
4. Correspondencias explicitas entre referencia de medio ERP 2, domiciliacion ERP 4 y cuenta tesoreria referenciada por ERP 3. No interpretar nombre libre como FK ni convertir cuenta contable en IBAN.
5. Remesas historicas: importar como observadas con fuente/fecha/hash si existe evidencia. El campo legacy `remesa` no crea liquidacion, mandato ni reserva. Si hay instrucciones activas externas, inventariarlas al corte; bloquear nueva presentacion de los recibos afectados hasta acreditar cierre o importar sus reservas/identidades de forma revisada.
6. Reimportacion por identidad externa y contenido: mismos datos no duplican, conflicto a revision; no unir por parecido de nombres ni IBAN incompleto. Conservar archivo/corte y correspondencias protegidos.
7. Activacion por comunidad tras configurar acreedor/banco/mandatos, comprobar HTTPS/claves/permisos y validar fichero con PSP. Convivencia con Netfincas segun cobertura ERP 3: no remesar simultaneamente desde ambos sistemas las mismas obligaciones.
8. Publicar tras pruebas; backup posterior y restauracion aislada de cifrado+DB+adjuntos. Rollback de codigo requiere esquema compatible y conservar operaciones posteriores; no restaurar base antigua borrando presentaciones o cobros nuevos. Tras archivo presentado, primero reconciliar su estado externo.

## 14. Configuracion de implantacion, no bloqueo del contrato

| Dato por comunidad/contrato | Requisito para uso real |
|---|---|
| Identidad/direccion de comunidad, identificador acreedor y cuenta receptora | Acreditacion y validacion con PSP; no derivar identificador acreedor del NIF como si estuviera contratado |
| Banco/PSP, CORE contratado, formato y servicio de presentacion | Perfil habilitado y fichero de prueba aceptado; no seleccion comercial ni contratacion automatica |
| Calendario, limites, horas de corte, fecha cargo | Parametros documentados PSP; validacion de plazo/prenotificacion por lote |
| Mandatos existentes, firmantes, fechas, modificaciones y alcance | Evidencia suficiente; sin ella seguir operativo en ERP 3 sin remesa |
| Prenotificacion | Plazo base o acuerdo documentado y canal/evidencia de envio |
| Resultado/devolucion/cancelacion que proporciona el banco | Adaptador validado o registro manual documentado; no bloquear diseno por faltar fichero de muestra hoy |
| Usuarios habilitados y custodia de claves | Asignacion explicita, HTTPS, proteccion y restauracion verificadas |
| Politica de conservacion documental | Responsable define plazos aplicables antes de automatizar purgas; historicos relacionados protegidos |

No queda decision funcional material pendiente para implementar este contrato. Eleccion del banco, contratacion CORE, concesion de capacidades y acreditacion de documentos son actos de implantacion del cliente. Funciones opcionales de otro esquema o canal exigen nueva autorizacion/contrato, no impiden cerrar CORE manual.

## 15. Casos de aceptacion obligatorios

Pruebas futuras sobre datos sinteticos/copias controladas. Esta lista es contrato de aceptacion, **no resultados de pruebas ejecutadas**.

| ID | Caso / evidencia exigida |
|---|---|
| A01 | Una cuenta, tres propiedades y mandato de alcance suficiente: tres lineas trazadas, ninguna cuenta duplicada |
| A02 | Cuenta conjunta con firmante representante acreditado; propietario, deudor bancario y obligado diferentes sin fusionarlos |
| A03 | Pagador diferente por concepto/fecha; ambiguedad de igual prioridad bloquea; no division de copropiedad |
| A04 | Cambiar cuenta mantiene historico; cuenta anterior de otras propiedades sigue disponible |
| A05 | Alta/modificacion/revocacion/suspension/reactivacion e inactividad del mandato; fuente y fechas intactas |
| A06 | RUM repetida, diferencias de mayusculas y extension comercial del acreedor: colision detectada, sin revelar otra comunidad |
| A07 | Mandato puntual no permite segunda ejecucion; repeticion fallida solo con evidencia y perfil apto |
| A08 | Seleccion masiva de 200 recibos, filtros/paginacion y subconjunto; confirmacion no incorpora nuevas filas |
| A09 | Recibo parcial, saldo cero, anulado, observado y apertura agregada; solo elegibles acreditados se seleccionan |
| A10 | Dos usuarios reservan mismo recibo a la vez: una confirmacion gana, otra conflicto; rollback del lote perdedor |
| A11 | Doble confirmacion con misma/distinta clave no duplica reserva ni intento |
| A12 | Saldo o mandato cambian entre preview y confirmar/exportar: bloquea y muestra diferencias |
| A13 | Cobro manual durante reserva: dinero conservado, revision obsoleta o incidencia postexportacion, sin segundo cargo oculto |
| A14 | Anulacion simple ERP 3 con reserva activa bloqueada; liberacion posterior permite flujo normal |
| A15 | Cancelacion local libera todas las reservas y no cambia deuda; fallo intermedio revierte todo |
| A16 | Exportada con entrega incierta no libera por cancelar; presentacion confirmada necesita respuesta de retirada |
| A17 | Cancelacion bancaria parcial/rechazada/tardia: estado y reservas correctos por linea |
| A18 | Exportar/descargar/presentar/aceptacion tecnica no crean cobro ni alteran deuda |
| A19 | Fichero XSD+reglas validos, totales exactos, referencias unicas y re-descarga byte a byte identica |
| A20 | Fallo al generar/guardar artefacto: sin fichero publico parcial, sin efectos economicos y recuperacion segura |
| A21 | Validacion de fechas/corte/festivos, prenotificacion ausente y acuerdo excepcional; no cambiar fechas automaticamente |
| A22 | Direccion estructurada/hibrida y prueba de frontera 15/11/2026; direccion insuficiente se bloquea sin inventar datos |
| A23 | Rechazo de fichero/grupo/linea, respuesta parcial y codigo desconocido: alcance exacto, deuda intacta |
| A24 | Liquidacion acreditada -> confirmacion cobro ERP 3 -> imputacion revisada -> saldo; reserva consumida |
| A25 | Liquidacion sin detalle, neta sin desglose o simple acuse: no fabrica cobro ni comision |
| A26 | Cobro -> devolucion total/parcial -> reversos ERP 3; saldo correcto y gasto independiente segun politica |
| A27 | Aviso devolucion sin cobro identificado: pendiente sin duplicar deuda ni inventar historia |
| A28 | Dos ficheros con misma operacion y futuro movimiento ERP 5: un solo cobro/devolucion, evidencias enlazadas |
| A29 | Referencias externas insuficientes o colision con distinto contenido: revision sin casar por importe/nombre |
| A30 | Resultado antiguo posterior en recepcion no revierte estado reciente; correccion conserva ambos eventos |
| A31 | Reintento confirmado utiliza nueva referencia, saldo actual y autorizacion valida; mismo recibo, sin gasto duplicado |
| A32 | Cambio posterior IBAN, mandato, propietario o acreedor no cambia fichero/sujetos/snapshot historico |
| A33 | Recibo antiguo tras venta: no cargar al nuevo titular automaticamente; tercero explicitamente autorizado sin mover obligado |
| A34 | Saldo a favor no aplicado automaticamente; doble cobro real conservado como fondos disponibles ERP 3 |
| A35 | Resultado con ejercicio bloqueado no modifica fechas ni reabre ejercicio; evidencia pendiente visible |
| A36 | Permisos separados de lectura/revelado/exportacion/gestion/efecto ERP 3; revocacion entre preview y confirmacion efectiva |
| A37 | Consultas/IDs/imports de otra comunidad rechazados; cuenta compartida fisicamente no permite fuga entre comunidades |
| A38 | IBAN y firmas ausentes de logs/outbox/JSON general/RAG/auditoria/cache; descarga protegida y replay sin secretos |
| A39 | XML malicioso/DTD/XXE/bomba, columnas y ficheros manipulados: rechazo acotado sin red ni ejecucion |
| A40 | Rotacion de claves mantiene fichero original; restauracion aislada recupera secretos solo con claves autorizadas |
| A41 | Migracion aditiva, reimportacion idempotente y referencias legacy pendientes no activadas por defecto |
| A42 | Corte con remesas activas externas: evita presentar otra vez; no altera importe/cobrado/deuda historicos |
| A43 | Recorrido completo escritorio 1440/1920 y movil 390: propiedad -> mandato -> seleccion -> exportar -> resultado -> reintento |
| A44 | Regresion ERP 0/1/2/3, incluidos cuotas exactas, no prorrateo, snapshots, responsabilidades y historicos |
| A45 | Fallo tras comando ERP 3 antes de finalizar resultado: rollback de fondos/reserva/auditoria/inbox; retry una sola vez |
| A46 | Cambio de perfil/formatos requiere nueva validacion; reproducir fichero antiguo no consulta configuracion actual |
| A47 | Inversion postliquidacion no es cancelacion local; evidencia y contramovimiento ERP 3, sin XML de inversion habilitado por defecto |
| A48 | Descarga de evidencia por rutas documentales genericas no elude ACL bancaria; HTTP inseguro bloquea acceso sensible |
| A49 | Resultado tardio del intento previo no libera la reserva nueva; liquidacion tras cancelacion genera conflicto y conserva fondos reales |
| A50 | Rotacion HMAC sin duplicados e integridad criptografica fallida bloquea exportacion; no genera IBAN vacio |

## 16. Implementacion posterior y certificacion

No ejecutar en esta entrega. Secuencia preparada sin abrir ERP 5:

1. **ERP 4A, contrato/migracion (25 puntos de implantacion):** tablas/secretos/permisos/guardias, migracion en copia y restauracion con claves; sin validacion real no concede puntos.
2. **ERP 4B, servicios deterministas (25):** cuentas, mandatos, elegibilidad/reserva, perfiles/XML, resultados y limite ERP 3; concurrencia/idempotencia/precision/casos criticos.
3. **ERP 4C, recorrido integrado (25):** UX completa, operaciones masivas, documentos, importacion y consultas contextuales; escritorio/movil sin exposicion tecnica.
4. **ERP 4D, aceptacion (25):** matriz completa, regresiones, prueba de perfil de banco para comunidad habilitada, proteccion/restauracion, publicacion y smoke tests. Si falta evidencia bancaria, declarar alcance tecnico probado y activacion bancaria pendiente; no certificar remesas reales como aceptadas.

El diseno esta **COMPLETADO / listo para implementacion**; la implementacion permanece **PENDIENTE, 0%**, sin aceptacion funcional ejecutada. Los cuatro hitos usan la metodologia del roadmap; no se otorgan puntos por escribir este documento. La implementacion requiere autorizacion posterior del usuario.

## 17. Verificacion del cierre documental y riesgos

| Criterio de cierre del diseno | Definido en |
|---|---|
| Entidades, relaciones y temporalidad | 3-6 |
| Estados, invariantes, cancelacion y reintentos | 5-9 |
| Seguridad, permisos, auditoria e idempotencia | 7, 9-11 |
| Elegibilidad, reservas y conflictos concurrentes | 7 |
| Devoluciones y responsabilidad economica | 1, 5, 9 |
| SEPA, adaptadores y versionado | 2, 6, 8 |
| Integracion ERP 3 / frontera ERP 5 | 3, 9, 11 |
| UX e importacion/migracion | 12-13 |
| Implantacion, pruebas y aceptacion | 14-16 |

Riesgos residuales conocidos, no vacios del contrato: evidencia legacy insuficiente; banco con formato/canal no probado; ficheros descargados que se suban fuera del control de la app; resultados sin identidad/detalle; revocaciones mientras una instruccion esta en curso; perdida de claves; concentracion de permisos; coste/limites del PSP; acceso privilegiado al servidor. Se resuelven mediante bloqueos, configuracion, evidencias y pruebas descritos, no mediante predicciones de IA.

Coherencia revisada: no prorrateo, no traslado de deuda, no division por copropiedad, no alteracion de cuotas/snapshots, no cobro por exportacion, no doble libro de deuda, no aplicacion automatica de saldo a favor, gastos independientes y confirmacion humana. No quedan decisiones funcionales materiales abiertas en este alcance. Diseno listo para implementar; ningun cambio de codigo, datos, migracion, permiso ni despliegue realizado aqui.
