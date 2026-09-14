# ERP 5 - Banco y conciliacion

Contrato funcional, tecnico y UX v1.0, 14/09/2026. Diseno CERRADO 100%; implementacion 0%; aceptacion de implementacion pendiente. Esta entrega solo contiene documentacion. Base de codigo consultada: `7e24184`, tras cierre de planes de cuotas. No reabre ERP 0-4.

Fuentes internas: [roadmap](ERP_COMUNIDADES_ROADMAP.md), [ERP 0](ERP_00_FUNDAMENTOS_IMPLEMENTACION.md), [maestros](ERP_MODELO_DATOS_MAESTROS.md), [ERP 1](ERP_01_DATOS_MAESTROS_IMPLEMENTACION.md), [ERP 2](ERP_02_MODELO_CALCULO_CONTRATOS.md), [ERP 3](ERP_03_RECIBOS_COBROS_DEUDA.md), [implementacion ERP 3](ERP_03_RECIBOS_COBROS_DEUDA_IMPLEMENTACION.md), [ERP 4](ERP_04_DOMICILIACIONES_SEPA_REMESAS.md), [implementacion ERP 4](ERP_04_DOMICILIACIONES_SEPA_REMESAS_IMPLEMENTACION.md), [planes](ERP_02_03_PLANES_CUOTAS_IMPLEMENTACION.md), [UX](ERP_UX_PRINCIPIOS.md).

## 1. Finalidad, alcance y decisiones

Responder que ha ocurrido realmente en una cuenta y a que hecho ERP corresponde. Movimiento, cobro, pago, remesa, devolucion, transferencia y asiento son conceptos separados, enlazados con importes y evidencia.

Ratificaciones del usuario: propuesta -> revision -> confirmacion humana; confianza alta/media/baja solo ordena sugerencias; pendientes sin asignacion artificial; correspondencias N:M; transferencias propias sin ingreso/gasto ficticio; extracto de remesa no duplica cobros; historia confirmada no se borra; banco/adaptador configurable. No se autoriza conciliacion economica desatendida.

**D-CIERRE, ratificada expresamente el 14/09/2026:** permitir cerrar con pendientes documentados si el saldo bancario cuadra. Cierre operativo de conciliacion independiente del cierre contable. Se concreta en seccion 10 sin imponer que todo este identificado.

Incluye importacion, revision, conciliacion, salidas de tesoreria documentadas, comisiones, transferencias, saldos, cierres e informes bancarios. Fuera: ejecutar transferencias al banco, agregador operativo, formulas libres, contabilidad definitiva, facturacion/IVA, motor de proveedores ERP 7 y nuevos agentes. EUR es la moneda operativa inicial compatible con ERP 3/4; otras monedas se conservan en staging y se senala que su aplicacion requiere adaptador/dominio compatible. No convertir divisas por una tasa inventada.

## 2. Reutilizacion comprobada y fronteras

| Origen real | Uso ERP 5 |
|---|---|
| ERP 0 contratos/dispatcher, SQLite, auditoria, outbox, migraciones e idempotencia | Misma API interna, comunidad explicita, transaccion y recuperacion. Ninguna escritura financiera alternativa |
| ERP 1 comunidades, ejercicios, propiedades, sujetos, bloqueos | Identificacion y autorizacion; propietario actual no sustituye al obligado historico |
| ERP 2 y planes activos | Referencia de recibo/cuota/periodo/snapshot para explicar propuestas; ERP 5 no recalcula ni emite cuota |
| ERP 3 cobros, aplicaciones N:M, devoluciones, reintegros, gastos, coberturas | Unica fuente de deuda y fondos de propietarios; usar servicios y conexion compartida ya integrados con ERP 4 |
| `erp_cuentas_tesoreria` ERP 4 | Reutilizar banco/caja, moneda, estado y secreto. No crear otro maestro de cuentas |
| `erp_banco_operaciones`, `erp_banco_identidades` ERP 4 | Identidad de resultados de remesa y enlaces cobro/devolucion; no son un registro completo de extractos |
| `erp_remesas`, lineas/intentos, resultados y secretos ERP 4 | Snapshots, reservas y efectos economicos ya registrados; reutilizar estados mediante sus comandos |
| `banking_crypto.py`, documentos y control HTTP ERP 4 | Vault, fingerprints protegidos, evidencias cifradas, revelado/descargas y custodia |
| `cf_extractos_banco_importaciones`, `cf_extractos_banco_lineas`, `cf_equivalencias_banco`, `cf_conciliacion_gasto_banco` | Fuentes legacy a mapear y adaptar; no certificar automaticamente sus saldos ni coincidencias |

Comprobacion puntual en `banking_schema.py` y `banking_results.py`: operaciones actuales requieren cuenta, tipo, secreto y referencias opcionales a cobro/devolucion; identidades usan `key_id/digest`. ERP 5 anade movimientos y relaciones sin forzar cada apunte a una linea de remesa. La identidad de un asiento agregado de banco tampoco equivale a la de cada liquidacion que contiene.

## 3. Modelo objetivo y persistencia

Nombres de tablas propuestos, sujetos a ajuste tecnico equivalente al implementar; no representan tablas existentes salvo las indicadas. Toda entidad nueva incluye comunidad; IDs y FKs compuestos impiden cruzarla. Fechas efectivas ISO y conocimiento UTC separados. Importes EUR en centimos enteros; JSON como cadenas, calculos Python enteros/Decimal exacto, nunca float/REAL/Number. Mantener precision original en staging; importes con fracciones de centimo incompatibles bloquean su aplicacion, no se redondean al importar.

| Entidad objetivo | Datos y reglas |
|---|---|
| `erp_extractos_importaciones` | Cuenta, secreto de archivo, hash, perfil/adaptador y version, mapeo versionado, estado, actor, fechas, resumen. Un archivo puede contener cuentas separadas; cada bloque requiere correspondencia explicita |
| `erp_extractos_filas` | Importacion/bloque/fila, texto original cifrado, normalizacion, errores, decision y enlace a movimiento/evidencia. Conservar filas omitidas y motivo |
| `erp_extractos_coberturas` | Cuenta, intervalo y cortes, secuencia bancaria si existe, saldos comunicados tipados, movimientos incluidos, indicador de completitud y evidencia. Solapamientos no suman dos veces |
| `erp_banco_movimientos` | Cuenta, signo/centimos, moneda, fecha operacion, fecha valor opcional, fecha/hora fuente cuando exista, orden bancario, estado fuente booked/pending/reversed, referencia protegida, origen, version, secreto de concepto/contraparte. Importe firmado: entrada positiva, salida negativa |
| `erp_banco_movimiento_identidades` | Namespace PSP/perfil/cuenta/servicio, HMAC de ID estable, version de clave, movimiento; unicidad en ese alcance. No confundir referencias de pago reutilizables con ID unico de apunte |
| `erp_banco_movimiento_evidencias` | Multiples filas/documentos que acreditan el mismo apunte; metadatos seguros, calidad y version de interpretacion |
| `erp_banco_movimiento_correcciones` | Original, sustituto/duplicado/reverso, motivo, actor, documento y version. Nunca actualizar silenciosamente importe/fecha de un apunte confirmado |
| `erp_conciliacion_propuestas` | Motor/perfil versionado, entradas y versiones congeladas, candidatos, confianza/razones, componentes, sumas, errores, fecha y hash de revision |
| `erp_conciliaciones` y `erp_conciliacion_componentes` | Confirmacion y componentes N:M descritos en seccion 6; importes, tipo de hecho, referencia validada, motivo, regla, confianza, actor, fecha y compensaciones append-only |
| `erp_banco_operacion_vinculos` | Componente/movimiento/identidad de resultado ERP 4; guarda correspondencias agregadas sin duplicar `erp_banco_operaciones` |
| `erp_tesoreria_salidas` | Hecho de pago/comision/otro cargo confirmado: importe, cuenta, fecha, contraparte opcional, concepto, documento, clasificacion y origen. No deuda a proveedor, factura ni asiento. Componentes desembolsados, rectificaciones e identidad estable |
| `erp_tesoreria_transferencias` y extremos | Comunidad, origen/destino banco/caja, principal exacto, moneda, fechas, evidencia y estado de cada extremo; comision aparte |
| `erp_tesoreria_evidencias_caja` | Solo justificantes/arqueos de extremos de transferencia banco-caja; no segunda gestion de cobros en efectivo ni libro mayor |
| `erp_banco_saldos` | Observaciones inicial/final/intermedio, tipo contable/disponible/valor, fecha y frontera inclusiva/exclusiva, cuenta, fuente y revision; nunca saldo corrector calculado para cuadrar |
| `erp_conciliacion_cierres` y eventos | Cuenta/periodo, snapshot de cobertura/saldos/apuntes/enlaces, pendientes documentados, diferencias, actor, fecha, version y reaperturas |
| `erp_conciliacion_perfiles` | Reglas deterministas de propuestas y limites, version/vigencia; sin codigo ejecutable |
| `erp_banco_legacy_correspondencias` | Tabla/ID origen, cuenta/comunidad, nuevo ID, tipo de evidencia, decision, cobertura y fecha de activacion |

Campos de estado editables son proyecciones/cache con version; el historial confirmado es append-only y reconstruible. Importe/fecha originales permanecen en evidencia aunque una interpretacion posterior se corrija. Referencias a hechos ERP se validan mediante registro cerrado de tipos y FKs tipadas, no una cadena arbitraria ni SQL dinamico.

Una reversion bancaria real conserva tanto el apunte original como el contramovimiento firmado y ambos participan en el saldo segun sus fechas. No excluir el original por mostrar estado reversed y ademas restar el reverso. Excluir de la proyeccion una duplicacion/interpretacion importada incorrectamente es otra operacion, con evidencia de que no representa un segundo hecho bancario.

No exigir propietario, proveedor ni recibo para admitir un movimiento valido. Contraparte desconocida se conserva sin crear un maestro por su nombre. Cuenta bancaria propia se referencia por identidad ERP 4; la mascara del IBAN no demuestra igualdad.

## 4. Importacion y adaptadores

Flujo: elegir comunidad/cuenta -> archivo -> detectar formato/columnas -> mapear -> staging -> revisar nuevos/repetidos/dudas/errores/saldos -> confirmar importacion. Esta confirmacion admite evidencia bancaria; no autoriza cobros, imputaciones ni asientos. La segunda confirmacion corresponde a conciliar los efectos mostrados.

Soporte inicial: CSV, XLSX/XLS tabular, entrada manual revisable y Cuaderno/Norma 43. Incorporar tambien adaptador `camt.053.001.08`; `camt.054.001.08` para notificaciones/detalle y enlace a ERP 4, sin presumir cobertura completa de extracto. La version es un perfil soportado, no una afirmacion de que sea la ultima. Namespace distinto requiere adaptador registrado o rechazo explicito; no interpretar como si fuera v08. PDF queda como evidencia; extraccion futura nunca confirma importes por OCR sin revision.

Eleccion tecnica: Cuaderno 43 facilita el inicio en Espana; la documentacion de [recepcion de ficheros de CaixaBank](https://www.caixabank.es/empresa/transferenciaficheros/recepcionficheros_es.html) enumera soporte de Cuaderno 43 y codigos propios. El [catalogo oficial ISO 20022](https://www.iso20022.org/catalogue-messages/iso-20022-messages-archive?page=1) documenta las familias/versiones camt.053/054. Fuentes consultadas el 14/09/2026; no autorizan asumir iguales codigos o disponibilidad en todos los bancos. Guardar especificacion/XSD y fixtures de cada perfil en su implementacion, con hash/version; validar estructura y totales segun ese perfil.

Contrato del adaptador: entrada bytes + perfil + opciones declaradas; salida cuentas/bloques/coberturas/observaciones/filas normalizadas con ubicacion original, diagnosticos y capacidades de identidad. Sin acceso a escritura economica. Un detalle camt de un apunte es componente del apunte, no otro movimiento sumable; si el detalle no cuadra, conservar y bloquear su uso como desglose.

CSV/Excel: detectar cabecera, separadores, codificacion y decimales; mostrar convencion de signos, columnas Debe/Haber o importe firmado y formato de fechas. Ambiguedad `01/02`, miles/decimales o signo exige mapeo; no elegir por probabilidad. Formula sin valor fiable, macros, enlaces externos y filas total no son movimientos automaticos. Limites de archivo/filas, zip-bomb y XML sin DTD/entidades externas. Plantilla y perfil guardable por cuenta, revisado al cambiar columnas.

La seleccion confirmada es atomica. Errores aislados pueden excluirse expresamente conservando su incidencia; ese extracto queda incompleto para certificar cobertura hasta resolverlos. Cuenta equivocada, totales estructurales invalidos o fechas/moneda indeterminadas bloquean el bloque. Archivos multicuenta se separan en lotes autorizados; no se importa otra comunidad por detectar su IBAN.

Entrada manual exige cuenta, fecha, importe firmado, moneda y evidencia/motivo. Queda `observado_manual`, no prueba por si sola que se disponga de todo el periodo. Un apunte previsto/pending no se incluye en saldos booked ni materializa fondos; posterior booked se relaciona con el anterior mediante identidad/evidencia sin contarlo doble.

## 5. Identidad y deduplicacion

Tres niveles independientes: archivo, ocurrencia bancaria y hecho economico ERP 3/4. Hash de archivo identifica reimportacion, no todos los hechos; referencia de remesa no es ID unico de cada liquidacion.

1. Archivo igual + misma comunidad/cuenta/configuracion: reutilizar staging/resultado, sin filas nuevas. Mapeo corregido crea revision de importacion; no habilita duplicar filas previamente admitidas.
2. ID estable: normalizacion segun namespace de adaptador/PSP/cuenta/tipo. Mismo ID y mismos datos esenciales enlaza nueva evidencia. Importe, moneda, signo o fecha esencial incompatibles -> conflicto, sin sobrescribir. Cambios de descripcion secundarios conservan ambas fuentes y se muestran.
3. Sin ID: fingerprint versionado incluye cuenta, moneda, signo, importe exacto, fechas disponibles, referencias fiables, concepto normalizado, identidad protegida de contraparte y secuencia/saldo cuando la fuente los acredita. Guardar tambien la forma original cifrada. No usar solo fecha+importe ni mascara IBAN.
4. Fingerprint repetido es candidato, no UNIQUE destructivo. Multiplicidad por extracto, posicion dentro de bloque, referencias vecinas y saldos ayudan a proponer correspondencia entre extractos solapados. Dos cargos identicos del mismo dia se conservan como dos ocurrencias si la evidencia los distingue.
5. Si no se puede distinguir reimportacion parcial de otra operacion igual, bloquear solo la admision dudosa: elegir Enlazar existente / Es otro movimiento con evidencia y motivo. No crear un tercero ni borrar el segundo automaticamente.
6. HMAC con alcance de comunidad y rotacion segun vault ERP 4; busqueda durante rotacion reconoce claves activas/anteriores para que rotar no cause duplicados. Alias de identidad nuevo requiere evidencia y guardia contra colisiones.

Una cuenta/periodo solo tiene una cobertura operativa rectora entre legacy y ERP 5. Deduplicar prueba existencia bancaria; conciliar con un cobro ya registrado exige ademas comprobar identidad economica. Nueva fuente para un resultado ERP 4 enlaza `operation_id` y cobro/devolucion existentes. Sin alias comun fiable, confirmacion de enlace manual revisable obligatoria.

## 6. Conciliacion N:M y efecto economico

La propuesta muestra por separado: movimientos, hechos existentes a enlazar, hechos nuevos a registrar, aplicaciones a recibos, comisiones, sobrantes y pendientes. Ningun efecto oculto por clasificar un concepto. Revalidar saldos/identidades/versiones al confirmar.

Cada componente tiene lado movimiento (apunte + importe firmado), lado hecho (tipo/ID + componente + importe firmado), cuenta/moneda, operacion externa si existe y evidencia. Una conciliacion agrupa N apuntes con M hechos. Recibos se alcanzan a traves de cobro -> imputacion ERP 3; no guardar una aplicacion directa movimiento-recibo que reduzca deuda en otro lugar.

Invariantes exactos:

- En conciliacion simple, asignacion con signo del apunte, suma de magnitudes <= importe disponible del apunte. Remanente permanece pendiente.
- Cobro/pago/devolucion existente no puede quedar acreditado por mas movimiento que su componente de fondos; control global de asignaciones activas, misma cuenta y moneda. Un hecho confirmado por otra fuente puede tener evidencia adicional, no otra asignacion que consuma capacidad dos veces.
- Agregado neto documentado permite componentes de signos distintos: por ejemplo banco +980 = cobros +1.000 + comision -20. Guardar grupo bruto/neto indivisible con desglose acreditado. No aplicar la restriccion simple de magnitudes al bruto; exigir suma firmada exacta y limites de cada hecho. Nunca inventar esos 20 por diferencia.
- Asignaciones parciales de un agregado neto solo si el documento acredita el desglose parcial. Lo demas queda pendiente; no liberar capacidad ficticia reutilizando componentes negativos.
- Las aplicaciones cobro-recibo siguen las reglas ERP 3: importe <= fondos y pendiente, sobrante sin aplicar, obligados acreditados, ninguna aplicacion automatica futura. Capacidad bancaria de un cobro es distinta de su disponible para imputar: un cobro ya aplicado puede enlazarse con su extracto sin crear otro.
- El conjunto asignado mas remanente reproduce el apunte; conciliado exige remanente cero, identidad sin conflicto y efectos autorizados confirmados. No equivale a que todo cobro este aplicado a recibos.

Estados visibles derivados: Pendiente de identificar, Con propuesta, Parcialmente conciliado, Conciliado, En conflicto. La revision de un apunte corregido muestra Sustituido/Rectificado y referencia al nuevo; su historial sigue accesible. No mezclar estado bancario de fuente con estado de conciliacion.

| Situacion | Accion confirmable |
|---|---|
| Ingreso y cobro existente | Enlazar al cobro, sin nuevos fondos ni nueva imputacion |
| Ingreso acreditado sin cobro | Registrar cobro ERP 3; opcion separada de imputacion revisada. Pagador puede quedar desconocido |
| Movimiento desconocido | Mantener pendiente, sin forzar cobro ni deuda |
| +100 para recibos de 60 y 40 | Un cobro y dos aplicaciones ERP 3; enlaces explican ambos recibos |
| +30 y +70 para recibo de 100 | Dos cobros de 30/70 con aplicaciones al mismo recibo; tambien admite enlace parcial a cobro manual de 100 ya existente y acreditado |
| +110 para pendiente de 100 | Cobro 110, aplicacion humana 100, saldo sin aplicar 10 |
| -importe devolucion | Reutilizar devolucion ERP 3 sobre cobro/aplicaciones identificados; no otro cargo al recibo |
| -reintegro a propietario | Enlazar/registrar reintegro ERP 3, no clasificarlo como gasto proveedor |

## 7. Motor de propuestas, tolerancias y correcciones

Motor determinista tipado, versionado, orden estable por evidencia y referencias. Misma entrada/version produce misma lista/razones; no aprender una autorizacion de cobro por repeticion.

Confianza alta: identificador externo verificable o referencia unica corroborada por cuenta, moneda, signo e importe/desglose. Media: varias coincidencias coherentes, como identidad protegida de pagador + importe + ventana temporal, sin ID externo. Baja: texto, nombres, propiedad o patron historico por si solos. Conflicto de identidad/moneda/saldo siempre bloquea, incluso con otras coincidencias altas. Mostrar razones y candidatos alternativos; no presentar porcentajes como probabilidades certificadas.

La ventana de fechas filtra candidatos, no altera fecha efectiva. Configuracion inicial conservadora de busqueda +/-7 dias naturales, ampliable mediante filtro visible y perfiles versionados; coincidencias por ID se buscan tambien fuera de la ventana y muestran aviso. Alias de proveedor/propiedad existentes sirven para sugerir, no para cambiar responsabilidad. Generacion de combinaciones agregadas acotada; superar limite tecnico se informa y permite seleccion manual, sin presentar lista truncada como unica solucion.

Tolerancia economica inicial = **0 centimos**. Un filtro de candidatos puede admitir diferencia visible configurable, pero confirmar exige asignacion parcial exacta o componente documentado. Ejemplos: 99,99 para deuda 100 deja 0,01 pendiente; 100,01 deja 0,01 sin aplicar tras imputar 100. No condonar, redondear deuda, crear comision o modificar cuota para cuadrar. En remesas, usar los importes emitidos y snapshots; la periodificacion exacta de planes no se recalcula.

Desconciliar crea compensacion de enlaces, motivo y auditoria; no elimina un cobro correcto ni reabre deuda por defecto. Si el propio cobro era incorrecto, ofrecer propuesta correctora ERP 3 con su autorizacion y efectos completos; puede confirmarse atomicamente con el desenlace. Si ya existen efectos posteriores/bloqueos, conservar incidencia y usar contramovimientos admitidos, no forzar rollback de la historia. Rectificar un duplicado importado exige comprobar y liberar/corregir sus enlaces antes de excluirlo de la proyeccion de saldos.

## 8. Pagos, comisiones y transferencias

ERP 5 registra salidas de tesoreria efectivamente acreditadas, su clasificacion y correspondencias; no ordena pagos ni determina su autorizacion comercial. Un pago a proveedor puede tener documento/factura/contrato existente y varios movimientos. No crear factura, IVA, cuenta PGC o deuda de proveedor al clasificar. Si falta documento, mostrar Pagado, documentacion pendiente; el hecho bancario puede ser cierto aunque falte la imputacion de gasto. Identificacion insuficiente permanece pendiente.

Reutilizar proveedor/documento legacy solo con correspondencia acreditada. `erp_tesoreria_salidas` es el registro minimo de desembolso; ERP 7 consumira esos IDs al aplicar a facturas, sin registrar otra salida. Aplicacion a factura es relacion posterior y no cambia el importe pagado. Si legacy ya registra un pago, el adaptador de activacion lo enlaza por cobertura/evidencia antes de crear un hecho nuevo.

Comision: componente/operacion independiente con evidencia bancaria, cuenta, importe y fecha. La comision del banco a la comunidad y el eventual cargo de devolucion al obligado son hechos distintos; reutilizar politica ERP 3 para repercusion revisada e idempotente. No repercutir cada comision automaticamente ni suponer IVA. Una devolucion real no se deduce de todo movimiento negativo.

Transferencia interna: dos cuentas distintas de la misma comunidad/moneda, principal, identificador y evidencias de salida/entrada. Puede tener un extremo observado y otro pendiente, con fechas diferentes; no inventar el segundo apunte. Varios apuntes pueden cubrir un extremo si se acredita su suma. Entrada/salida de distinto importe solo cuadra con principal y comision documentada; diferencia sin evidencia permanece pendiente. Movimientos entre comunidades son externos a cada una, no se compensan como internos por compartir administrador.

Cada extremo consume capacidad exclusivamente en su cuenta; no netear apuntes de cuentas distintas para aparentar que un movimiento individual esta conciliado. Confirmar el emparejamiento exige acceso a ambas cuentas y comprobar sus periodos/versiones. Si un extremo pertenece a un cierre protegido, usar el flujo de reapertura correspondiente antes de modificar sus enlaces.

Banco -> caja y caja -> banco usan la cuenta caja existente y justificante de entrega/recepcion/arqueo firmado o acreditado. Un justificante no se importa como extracto de banco. En el consolidado, principal transferido se excluye de ingreso/gasto; cada cuenta refleja solo su movimiento observado y el pendiente en transito se informa aparte. No generar un cobro a propietario para representar ingreso de efectivo procedente de caja. Reversion de transferencia incorrecta conserva ambos extremos y motivo; rectificaciones no ejecutan devolucion bancaria.

## 9. Fechas y saldos

Fecha operacion/booked: orden y corte bancario operativo principal, movimientos del extracto e informe bancario. Fecha valor: columna conservada y vista especifica de valor cuando exista base comparable; no sustituye fecha operacion ni se rellena como conocida si falta. Conocimiento: UTC de registro, para reproducir que se sabia al cerrar. Secuencia bancaria resuelve orden intradia; sin ella no inferir saldo tras cada fila por su orden visual.

Fecha efectiva de cobro/devolucion se transmite a ERP 3 desde evidencia de fondos; propuesta habitual fecha operacion, editable solo con evidencia de otra fecha efectiva. ERP 6 recibira las fechas originales y decidira fecha contable conforme a su contrato y bloqueos. ERP 5 no adopta politica de devengo ni cambia una fecha para salvar un ejercicio cerrado. Recibo pendiente/obligado/planes siguen sus cortes propios.

`saldo_calculado(corte) = saldo_inicial_acreditado + suma de movimientos booked unicos dentro de la cobertura`. Saldo inicial especifica exactamente antes/despues de que frontera, cuenta, moneda, tipo y documento. Si falta, resultado es No verificable, no cero. Saldo disponible no se compara como si fuera contable: retenciones/limites pueden producir diferencias sin apunte.

Comparacion usa saldo comunicado contable final de misma cuenta/moneda/corte y misma base. Guardar diferencia exacta y causas conocidas: falta de filas, duplicados, fechas, signo, cobertura incompleta, pendiente de documentar. No crear Ajuste de saldo para borrar diferencia. Correccion del saldo inicial exige evidencia, evento y revision de cierres dependientes. Puede acreditarse mediante extracto, certificado o documento manual revisado; no es asiento de apertura ni nuevo cobro ERP 3.

Los informes distinguen saldo banco comunicado, reconstruido, diferencia, total sin identificar, fondos sin aplicar ERP 3 y transferencias en transito. Deuda no se deduce del saldo del banco. Agregar cuentas solo con moneda y cortes/coberturas comparables; mostrar cuentas faltantes y evitar un total aparentemente completo. Comprobar totales Debe/Haber y secuencias del extracto cuando existan; saldo que cuadra no demuestra por si solo que dos errores se compensen.

## 10. Cierre con pendientes ratificado

Unidad: cuenta y periodo bancario con limites explicitos, independiente de la periodicidad de cuotas y del cierre de ejercicio ERP 1. Una comunidad puede cerrar cada cuenta en fechas distintas y consultar su estado conjunto.

Condiciones de cierre: saldo inicial/final comparable acreditado, cobertura completa declarada con evidencia, suma exacta sin diferencia, sin duplicados/identidades/correcciones estructurales irresueltos. Se permiten movimientos sin identificar o parcialmente conciliados si cada remanente queda en anexo con importe, motivo, responsable autorizado y proxima fecha de revision. El responsable se propone desde el usuario que cierra, editable; fecha se confirma. Son campos operativos de la cola, sin crear tareas automaticamente.

Resultado visible Cerrado o Cerrado con pendientes. Snapshot conserva saldos, cobertura, apunte/version, enlaces, pendientes y actor. Pendiente documentado no equivale a clasificado ni contabilizado; permanece en cola y en informes posteriores hasta resolverse.

Un cierre impide alterar silenciosamente su imagen. Resolver despues un pendiente o incorporar evidencia que cambia sus datos/enlaces requiere reapertura explicita con motivo/permiso y nuevo cierre versionado; el cierre anterior se conserva. Nueva importacion tardia puede almacenarse en staging y mostrar Cierre afectado, pero no cambia el saldo certificado sin reapertura. Si no afecta importes ni enlaces, evidencia adicional puede anexarse auditadamente sin sustituir el snapshot. Bloqueo contable/ERP 1 sigue prevaleciendo para nuevos efectos economicos; reabrir conciliacion nunca reabre contabilidad.

No cerrar con diferencia inexplicada de un centimo, saldo ausente o cobertura desconocida. Puede guardarse revision de trabajo sin certificar cierre. No activar automaticamente cierre por alcanzar fin de mes.

## 11. Remesas ERP 4 y fondos ERP 3

Buscar primero identidad/aliases de resultado ERP 4 y su cobro/devolucion. La existencia de XML exportado/presentado no acredita dinero. Extracto que acredita liquidacion inicia propuesta de resultado ERP 4, con lineas/intentos identificados y servicios ERP 3 compartidos; mantiene reservas y politica de reintento del dominio propietario.

Agregado +1.000 de diez lineas: si todas fueron liquidadas, enlazar los diez cobros existentes sin nuevos fondos. Si ninguna lo fue, registrar los diez resultados/cobros identificados en la misma confirmacion. Si cinco ya existen, reutilizar cinco y crear solo los restantes. Si solo hay importe global sin detalle fiable, dejar pendiente: no repartir a prorrata ni suponer que corresponda a la ultima remesa. Importes parciales exigen detalle de lineas/importe realmente liquidado.

Abono neto con comision usa ecuacion firmada seccion 6 y evidencia de bruto/gasto. Cargo agregado de devoluciones exige identificar cada cobro e importe; los que ERP 4 ya devolvio solo se enlazan. Un rechazo previo a liquidacion no genera movimiento ficticio, ni segundo incremento de deuda. Devolucion sin cobro identificado mantiene incidencia; no crear un cobro ficticio para deshacerlo. Reenvio se propone exclusivamente mediante ERP 4 y requiere confirmacion.

La guardia de identidad compartida y la capacidad de asignacion cubren llegada en cualquier orden: fichero ERP 4, extracto ERP 5, registro manual previo. El servicio ERP 4 consulta los enlaces/aliases confirmados ERP 5 antes de materializar; extender esa comprobacion mediante API compartida, sin duplicar SQL economico. Un nuevo alias conocido posteriormente une evidencias solo tras verificar contenido; no fusionar dos cobros existentes automaticamente.

## 12. Servicios, permisos y seguridad

Catalogo objetivo del dispatcher ERP 0; nombres adaptables al implementar conservando comportamiento:

- Consultas `erp5.accounts.overview`, `statements.preview/history`, `movements.list/detail`, `matches.proposals`, `balances.compare`, `closures.detail/history`, `pending.list`, `reports.export_preview`.
- Comandos `statement.stage/map/preview/confirm`, `movement.manual.preview/confirm`, `identity.resolve.preview/confirm`, `match.preview/confirm/reverse_preview/reverse_confirm`, `outflow.preview/confirm`, `transfer.preview/confirm`, `opening.preview/confirm`, `closure.preview/confirm/reopen`, `pending.assign`, `report.export`.
- Mismo sobre comunidad/actor de sesion/contrato/version/idempotency/expected_version/evidencia/motivo. Preview congela IDs, versiones de hechos/saldos/cierres, reglas y hash; confirmar reutiliza payload revisado y verifica todo dentro de transaccion. HTTP 409 legible si cambio algun dato relevante.

`BEGIN IMMEDIATE`: reautorizar -> comprobar replay/identidad/capacidades -> comprobar invariantes -> aplicar servicios ERP 3/4 con conexion compartida -> enlaces/hechos propios -> auditoria -> outbox -> resultado idempotente. Fallo revierte lote completo, sin cobro huerfano. Los importadores no escriben tablas economicas. No llamadas externas, lectura de ficheros pesada ni parseo bajo lock.

Lotes revisados acotados a la capacidad del comando delegado mas restrictivo (actualmente resultados ERP 4: 200 decisiones). Para mayores conjuntos, mostrar lotes independientes con limites/estado, confirmar cada lote explicitamente; nunca aparentar atomicidad global mientras se guardan por detras bloques parciales. La importacion masiva puede procesarse en staging por bloques sin efectos economicos. Doble clic, otra clave y dos usuarios simultaneos no duplican asignacion ni saldo.

| Capacidad por comunidad | Permite |
|---|---|
| `reconciliation.read` | Movimientos y proyecciones seguras enmascaradas |
| `reconciliation.import` | Staging/mapeo/confirmacion de extractos; sin confirmacion economica implicita |
| `reconciliation.propose` | Crear/editar propuestas sin persistir efectos |
| `reconciliation.confirm` | Confirmar enlaces; nuevos efectos exigen ademas permisos ERP 3/4 correspondientes |
| `reconciliation.manage_outflows` | Confirmar pagos/comisiones documentados; no orden bancaria |
| `reconciliation.manage_transfers` | Registrar/enlazar extremos propios, sin ejecutar transferencias |
| `reconciliation.correct` | Desconciliar/rectificar con motivo, respetando autorizaciones del efecto original |
| `reconciliation.close` / `reconciliation.reopen` | Cerrar/reabrir cuenta-periodo, sin permiso de cierre contable implicito |
| `reconciliation.configure` | Perfiles, apertura y cobertura revisada; no habilitar automatizacion desatendida |
| `reconciliation.export` / `reconciliation.audit` | Informes enmascarados y auditoria segura |

Revelado/original sensible reutiliza `banking.reveal`/capacidad de exportacion protegida ERP 4 y reautenticacion; importar no concede lectura masiva ni descarga. Cambiar cuenta/IBAN usa ERP 4. Denegar por defecto; no dar permisos por llamarse Elena/Luis/Presidente ni por acceso a tareas. Actor siempre backend y autorizacion en lista, detalle, exportacion y reintento; una seleccion multicomunidad no mezcla escrituras.

Cifrar archivo, concepto completo, contrapartes, referencias/IBAN y resoluciones sensibles con vault ERP 4. Campos indexables minimos (cuenta interna, fecha, centimos, moneda, estado) y HMAC para identidades; proyeccion sanitizada sin IBAN en claro. El texto libre de un extracto puede contener IBAN aunque no este en su columna: no enviarlo a logs, auditoria, busqueda general ni IA. RAG/IA reciben IDs/mascaras y datos autorizados minimos; originales excluidos por defecto.

TLS, custodia externa, recuperacion de clave, reautenticacion, descargas autenticadas `no-store`, limites y formula injection heredan ERP 4. La puerta de datos bancarios sensibles se verifica tambien para originales de extractos y exportaciones; que ERP 4 este cerrado tecnicamente no acredita activacion real. No registrar claves ni IBAN en Git/URLs. Backups deben restaurar datos cifrados y clave por canal separado, sin empaquetar clave abierta junto al dato. Sin purga automatica nueva de evidencias/historicos.

## 13. Eventos y contrato ERP 6

Payload comun seguro: event_id, schema_version, comunidad, agregado/version, economic_fact_id cuando corresponda, component_id, cuenta, importe firmado/moneda, fecha operacion/valor/efectiva/conocimiento, origen/documentos por ID, correlacion/causacion, referencia al hecho original o reverso. Sin datos bancarios completos ni texto libre sensible.

| Evento objetivo | Consumo permitido ERP 6 |
|---|---|
| `erp5.bank_movement.imported` | Evidencia bancaria disponible; `effect=evidence`, no segundo ingreso/cobro por importar |
| `erp5.reconciliation.confirmed` | Enlaces y componentes de evidencia; `effect=link`, referencia a hechos economicos propietarios |
| `erp5.outflow.confirmed` (pago/comision tipados) | Hecho nuevo de salida una sola vez, `effect=monetary`; ERP 6 decide tratamiento, no presume gasto/IVA desde el tipo pago |
| `erp5.transfer.confirmed` | Identidad de transferencia operativa; sin contabilizar extremos ausentes |
| `erp5.transfer.leg_confirmed` | Movimiento acreditado de un extremo, componente monetario unico; ERP 6 tratara transito/contrapartida segun su politica |
| `erp5.reconciliation.reversed` | Reversion del enlace, `effect=link`; no anula automaticamente el asiento del cobro correcto |
| `erp5.outflow.reversed`, `erp5.transfer.leg_reversed` | Contramovimiento de un hecho propio previamente confirmado, motivo y referencia; no borrar evento inicial |
| `erp5.balance.opening_confirmed`, `closure.closed/reopened` | Apertura/cierre operativo documentado; no nuevo movimiento monetario ni asiento automatico |

Cuando confirmar conciliacion crea cobro/devolucion/reintegro ERP 3, los eventos monetarios siguen siendo SOLO los emitidos por ERP 3. ERP 5 publica enlaces y referencias al mismo economic_fact_id. Para salidas propias y extremos de transferencia, ERP 5 es propietario del hecho; ERP 7 aplicara factura a pago existente, sin otro desembolso. El agregado bruto/neto es agrupador y no un hecho monetario extra. Comision nueva tiene su propio componente; comision ya registrada se enlaza.

ERP 6 deduplica dos niveles: inbox UNIQUE comunidad/consumidor/event_id/componente para transporte y registro UNIQUE comunidad/economic_fact_id/componente/tipo_efecto para identidad economica. Versionar una regla o llegada de una fuente nueva no crea otro asiento del mismo hecho. Asiento+consumo atomicos; correcciones con hecho compensatorio y referencia. Outbox al menos una vez, recuperacion de leases antes de activar worker; no prometer entrega exactamente una vez. Politica PGC, devengo, IVA y uso de cuentas de transito pertenecen a ERP 6 y no bloquean este contrato de eventos.

## 14. UX y automatizaciones utiles

Ubicacion: Gestion -> Bancos y remesas, vistas de trabajo Remesas / Conciliacion dentro del sistema visual actual. Conciliacion abre con selector de cuenta y periodo, estado de cobertura, diferencia de saldo y pendientes; ninguna tabla tecnica se convierte en menu.

| Pantalla | Informacion y acciones principales | Detalle secundario |
|---|---|---|
| Cuenta / Conciliacion | Saldo comunicado/reconstruido/diferencia, corte, pendientes y lista compacta; Importar, Ver propuestas, Cerrar | Perfil de archivo, auditoria y versiones |
| Importar | Archivo propio o plantilla, mapeo reutilizable, nuevos/repetidos/dudas/errores y totales; revisar/confirmar | Opciones regionales y formato con ayuda contextual |
| Lista | Fecha operacion, concepto seguro, entrada/salida, estado y candidato; filtros pendientes/parciales/conflictos, seleccion masiva | Fecha valor, referencia y columnas adicionales |
| Revision de movimiento | Documento protegido, hechos existentes/nuevos, importes editables exactos y remanente visible; enlazar/dividir/transferir/dejar pendiente | Razon de confianza, evidencia y calculo; nunca ocultar diferencias |
| Pago/comision/transferencia | Cuenta, importe y fechas ya propuestos, contraparte/documento/destino cuando corresponda; confirmar efectos | Clasificacion avanzada, sin obligar a elegir cuenta PGC |
| Cierre | Saldos, cobertura, incidencias y anexo de pendientes con responsable/fecha; confirmar/reabrir | Snapshot y registro historico |
| Informes | Cuenta/periodo/corte, saldos, conciliados/pendientes, pagos/comisiones/transitos; exportar CSV/XLSX e informe PDF | Datos sensibles solo mediante permiso separado |

Accesos contextuales: comunidad -> sus cuentas/pendientes; recibo/cobro -> movimientos que lo justifican; remesa -> liquidaciones/devoluciones/evidencias; propiedad/propietario -> sus hechos ERP 3 con enlaces de banco autorizados. No mostrar toda una remesa sensible a un perfil por poder leer un recibo suyo.

Escritorio: tabla principal y panel de revision, totales estables y acciones por seleccion. Movil: fila resumida y detalle en pantalla completa, botones accesibles, ayuda plegada y sin overflow global. No compresion automatica de comentarios/historico. Estado incierto y diferencia siempre visibles.

Mejoras autonomas de diseno: reutilizar mapeo del mismo banco; reimportar sin duplicar; proponer enlaces ya liquidados; filtro de pendientes de cierres anteriores; agrupar coincidencias con la misma razon para revision masiva; detectar efectos ya existentes antes de ofrecer crearlos. No autoaprobar por confianza ni crear tareas/recordatorios externos sin flujo autorizado.

## 15. Migracion y secuencia de implementacion

No se ejecuta ahora. Migracion aditiva posterior al esquema 19: conservar checksums aplicados, probar primero sobre copia, FKs compuestas y guardias nuevas. Checkpoint Git + backup ERP 0 de SQLite/documentos/configuracion + recuperacion de claves; verificar apertura, descifrado, arranque y restauracion antes/despues de publicar.

Por cuenta/comunidad/cobertura: inventariar solo tablas/consumidores bancarios afectados -> staging legacy -> resolver cuenta/moneda/fechas/identidades -> enlazar importaciones y hechos ya registrados ERP 3/4 -> comprobar totales independientes -> revision de correspondencias -> activar cobertura ERP 5. `line_hash` global legacy no se copia como identidad unica universal; conservarlo como referencia. Ausencia de importe imputado en `cf_conciliacion_gasto_banco` no significa pago total: enlace observado pendiente de acreditar.

REAL legacy: volver a fuente original cuando exista; en otro caso representacion decimal y control de centimos/diferencias, nunca redondeo silencioso. Fecha `fecha` legacy se mapea con evidencia; no declararla fecha valor si no consta. Mapeo de cuenta inexistente queda pendiente, no crear cuenta por similitud. Snapshot de informes/asambleas historicos intacto.

Adaptar lectores de saldos/extractos/conciliacion/IA que hoy consultan `cf_extractos_banco_lineas` (por ejemplo `server/index.js`) con router por cobertura y permisos. Antes de activacion, legacy etiquetado; despues, ERP 5 para esa cobertura. No UNION de saldos duplicados ni escritura dual. Conservar estructura legacy hasta consumidores migrados/probados; registrar alias nuevo solo con evidencia. Mantener imports externos posteriores en staging si solapan cobertura, sin cambiar su fuente rectora automaticamente.

Hitos futuros: 5A modelo/migracion y adaptadores validados; 5B servicios deterministas/integracion; 5C recorrido funcional/contextos; 5D aceptacion/regresion/publicacion/restauracion. Cada uno 25 puntos de implementacion con evidencia. Diseno 100% no concede ninguno de esos puntos. Sin activacion de fuentes reales por ejecutar una migracion; asignar permisos/cuentas/cortes mediante configuracion revisada.

## 16. Casos de aceptacion obligatorios

Todos pendientes de ejecutar en implementacion, con datos sinteticos/copias controladas. Deben comprobar tambien importes, fuentes, eventos y ausencia de efectos no autorizados.

| Caso | Resultado requerido |
|---|---|
| A01 Referencia exacta | Propuesta alta; confirma humano y enlaza hecho correcto |
| A02 Transferencia recibida sin referencia | Candidatos revisables o pendiente; ninguna asignacion inventada |
| A03 Cobro parcial 60 de 100 | Cobro/aplicacion 60, deuda 40 |
| A04 Un apunte para varios recibos | Un cobro, aplicaciones exactas N:M |
| A05 Varios apuntes para un recibo | Fondos y aplicaciones sin duplicar recibo ni superar saldo |
| A06 Cobro manual ya aplicado | Enlace de extracto sin otro cobro ni nueva aplicacion |
| A07 Remesa agregada ya liquidada | Enlazar cobros existentes, fondos sin cambio |
| A08 Remesa aun no liquidada | Resultados acreditados y efectos ERP 3 revisados/atomicos |
| A09 Remesa parcialmente registrada | Crear solo efectos ausentes con identidad cierta |
| A10 Remesa sin detalle fiable | Pendiente sin reparto proporcional |
| A11 Neto 980/bruto 1000/comision 20 | Desglose probado, suma firmada 980, capacidad sin doble consumo |
| A12 Neto sin prueba de comision | Diferencia pendiente, sin gasto inventado |
| A13 Devolucion registrada ERP 4 | Extracto enlaza, deuda no aumenta otra vez |
| A14 Devolucion nueva acreditada | Un reverso ERP 3 de las aplicaciones identificadas |
| A15 Devolucion sin cobro | Incidencia, sin crear cobro ficticio |
| A16 Rechazo previo a liquidacion | No cobro ni movimiento ficticio; estado ERP 4 conservado |
| A17 Pago proveedor | Salida documentada, sin factura/IVA/asiento inventados |
| A18 Pago parcial/documento pendiente | Importes exactos y pendiente documental visible |
| A19 Comision y repercusion | Cargo banco separado; repercusion solo por politica/confirmacion ERP 3 |
| A20 Banco A -> B | Ambos extremos, cero ingreso/gasto por principal |
| A21 Transferencia con extremo ausente | Estado en transito; no apunte de destino ficticio |
| A22 Banco -> caja / caja -> banco | Cuenta caja existente y justificantes; no cobro a propietario |
| A23 Transferencia entre comunidades | No enlace interno cruzado ni neteo automatico |
| A24 Archivo repetido | Reutilizacion sin movimientos/efectos nuevos |
| A25 Mismo ID en fuentes distintas | Nueva evidencia de la misma ocurrencia |
| A26 Mismo ID/datos contradictorios | Conflicto sin sobrescritura |
| A27 Dos cargos iguales legitimos | Preservar multiplicidad, no colapsarlos |
| A28 Extractos solapados sin ID | Revisar ocurrencias; duda bloquea solo filas afectadas |
| A29 Fechas operacion/valor distintas | Ambas conservadas; saldo por base declarada |
| A30 Falta fecha valor | Desconocida visible, no fecha fabricada |
| A31 Saldo inicial acreditado | Reconstruccion exacta en frontera correcta |
| A32 Saldo inicial ausente | No verificable, cierre bloqueado |
| A33 Diferencia de saldo 0,01 | Visible y bloquea cierre; no ajuste automatico |
| A34 Saldo disponible vs contable | No comparacion silenciosa de bases diferentes |
| A35 Pendiente de identificar | Apunte admitido sin contaminar deuda/contabilidad |
| A36 Cierre con pendientes | Saldo cuadra y anexo responsable/fecha; pendientes siguen en cola |
| A37 Cierre sin cobertura completa | Bloqueo aunque casualmente cuadre el importe |
| A38 Importacion tardia tras cierre | Staging y cierre afectado; reapertura antes de cambiarlo |
| A39 Reapertura y resolucion | Version anterior intacta y nuevo cierre trazado |
| A40 Ejercicio bloqueado | No modificar fecha ni abrirlo desde conciliacion |
| A41 99,99 / 100,01 sobre deuda 100 | 0,01 pendiente / sin aplicar, sin tolerancia monetaria |
| A42 Datos observados legacy | No certificar pago/cuenta/fecha por existir enlace |
| A43 Activacion de cobertura | Un solo origen activo para la misma cuenta/periodo |
| A44 CSV/Excel propios | Mapeo, signos, fechas, errores por fila y confirmacion |
| A45 Cuaderno 43 | Perfil versionado, saldos/totales y conceptos originales preservados |
| A46 camt.053/054 | Namespace soportado, booked/pending, apunte/detalle sin doble suma |
| A47 XML/Excel hostil | DTD/macros/formulas externas/zip-bomb rechazados; exportacion segura |
| A48 Permisos por comunidad | Lectura/escritura/exportacion ajenas denegadas |
| A49 Confirmar sin permiso ERP 3/4 | No efectos delegados, lote revierte completo |
| A50 Concurrencia de dos revisores | Solo una asignacion valida, otro recibe conflicto legible |
| A51 Doble clic/otra clave/replay | Ninguna duplicacion economica ni de correspondencia |
| A52 Fallo tras crear cobro delegado | Rollback de cobro, enlaces, auditoria y outbox |
| A53 Desconciliar cobro correcto | Deshace enlace, no borra fondos ni deuda historica |
| A54 Rectificacion con efectos posteriores | Contramovimientos permitidos o bloqueo explicito |
| A55 IBAN y texto libre sensible | Cifrados/enmascarados; logs/outbox/RAG sin datos completos |
| A56 Rotacion y recuperacion clave | Identidad estable y descifrado restaurable, sin duplicados |
| A57 Plan ordinario y especial | Recibos independientes y cuotas/snapshots intactos al conciliar |
| A58 ERP 6 consumo repetido | Inbox/hecho-componente simulado cuenta un solo efecto; sin asientos reales |
| A59 Eventos ERP 3 y ERP 5 del mismo cobro | Evento evidencia no duplica efecto monetario |
| A60 Transferencia por extremos | Solo extremos acreditados, no agregado monetario adicional |
| A61 Lote mayor del limite | Bloques visibles/confirmados, sin falsa atomicidad global |
| A62 Escritorio y movil | Flujo importacion -> propuesta -> division -> confirmacion -> cierre accesible |
| A63 Restauracion/publicacion | Backup/clave/arranque, integridad SQLite/FKs e historicos equivalentes |
| A64 Regresion ERP 0-4 y planes | Contratos, permisos, calculos, recibos, remesas y UX existente intactos |

## 17. Configuracion, riesgos y verificacion de cierre del diseno

Por comunidad: cuentas ya acreditadas, moneda, permisos; por cuenta: PSP/perfil de formato, mapeo, referencias, fuente rectora/corte/saldos iniciales y calendario de revision; perfiles de sugerencia y ventana de fechas; recuperacion de claves/TLS y retencion segun contrato existente. No requiere conocer banco concreto para implementar el dominio. Agregador, automatizacion economica desatendida, multimoneda operativa y politica contable requieren alcance posterior explicito.

Riesgos: datos legacy incompletos, operaciones iguales sin ID, netos sin desglose, extractos parciales que aparentan cuadrar, llegada tardia despues de cierre, asignaciones manuales previas sin identidad bancaria y custodia pendiente de activacion. Sus respuestas estan definidas: staging/conflicto/pendiente, evidencia, cierre versionado y guardias economicas. No prometer acierto automatico ni alterar saldos para superar controles.

Lista de cierre de diseno: modelo seccion 3; importacion 4; identidad 5; N:M 6; reglas/tolerancias 7; pagos/transferencias 8; fechas/saldos 9; cierre ratificado 10; remesas 11; permisos/seguridad 12; eventos ERP 6 13; UX 14; migracion 15; aceptacion 16. Coherencia documental comprobada con fuente economica unica ERP 3, reservas/identidades/custodia ERP 4 y cuotas/snapshots ERP 2. Ninguna contradiccion material detectada ni decision funcional bloqueante pendiente. Diseno listo para implementar con autorizacion independiente; implementacion y pruebas de aceptacion permanecen al 0%.
