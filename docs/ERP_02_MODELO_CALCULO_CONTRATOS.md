# ERP 2 - Modelo, calculo y contratos

Fecha: 10/09/2026. Contrato de diseno, NO implementado. [Producto y UX](ERP_02_PRESUPUESTOS_CUOTAS_DISENO.md) | [Roadmap](ERP_COMUNIDADES_ROADMAP.md) | [Maestros](ERP_MODELO_DATOS_MAESTROS.md) | [Modelo temporal](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md).

Este documento define persistencia, algoritmos y limites de servicio; las decisiones funcionales y pantallas se mantienen en el documento de producto, no se duplican aqui.

Cierre de diseno: politicas temporales y base de regularizacion confirmadas por el usuario. La fecha efectiva de emision, no el inicio del periodo, determina la configuracion vigente del destinatario de un recibo no emitido. ERP 2A pendiente de autorizacion; ninguna implementacion en esta entrega.

## 1. Integracion con el repositorio real

| Componente existente comprobado | Uso ERP 2 / limite |
|---|---|
| `server/erp_core/contracts.py`, `dispatcher.py` | Ampliar lista cerrada de comandos/consultas; sobres existentes y actor de sesion; no SQL ni funciones elegidas por cliente |
| `database.py`, `repository.py`, patron `_write` de `master_service.py` | Reutilizar transaccion, log idempotente y concurrencia; nuevo servicio de presupuestos separado del servicio maestro |
| `audit.py`, `outbox.py` | Cambio, auditoria y evento en una transaccion; payload minimo sin datos bancarios/personales innecesarios |
| `migrations.py`, migraciones ERP 1/2 | Futuras migraciones aditivas numeradas con checksum; no editar las ya aplicadas |
| `erp_comunidad_config_versiones`, `erp_ejercicios`, `erp_bloqueos_periodo` | Contexto de comunidad/moneda/ejercicio y bloqueos; ampliar configuracion versionada, no otra comunidad |
| `cf_propiedades`, `cf_propietarios`, contactos y titularidades ERP 1 | Identidades y consultas temporales; no columna `propietario_actual` ni copia de propiedad |
| `erp_grupos_reparto`, `erp_grupo_versiones`, miembros, series y coeficientes | Consumir por IDs/versiones/fecha; ninguna tabla nueva de grupos o coeficientes |
| `master_validation.decimal_text` | Entrada exacta canonica, escala hasta 30; serie ERP 1 declara escala 0..30, por defecto 12 |
| `erp_fuente_registros`, `erp_master_document_links` | Reutilizar procedencia y resolucion documental; enlaces de presupuesto tipados sin forzar un documento de presupuesto como maestro |
| `/api/erp/query`, `/api/erp/command` en `server/index.js` | Transporte autenticado existente; proyeccion y permisos por accion en backend |

Referencias heredadas `cf_repartos_cuotas` / `cf_reparto_lineas` constan en el modelo previo como resultados simples, no equivalen a este motor. No se ha verificado una API activa de esas tablas en el dispatcher ERP actual. Su compatibilidad se inventariara en copia antes de migrar: conservarlas y, si se usan, referenciar resultados como legado mediante adaptador de lectura; no reinterpretar sus REAL ni su propietario unico como resultados ERP 2 certificados. No duplicar un motor existente sin identificar previamente sus consumidores.

### Dos condiciones reales que no deben ocultarse

1. `group_save` crea versiones de grupo en `borrador`; tener grupo activo y coeficientes guardados no prueba que la version economica este aprobada. ERP 2 requiere publicacion explicita de una version de grupo revisada, reutilizando su estado/versionado y con evidencia; no modificarla silenciosamente durante la simulacion. El flujo de incidencias puede llevar a `Validar configuracion para reparto`. Esto es una dependencia de integracion, no redisenar grupos.
2. Los datos legacy migrados en ERP 1 estan observados/en preparacion, con fechas a veces desconocidas. No se usan para aprobacion como si estuvieran validados. Admitir ensayo rotulado con incidencias, pero bloquear resultado definitivo hasta acreditar entradas. Los resolutores de visualizacion `group_current_version` / `coefficient_version` no sustituyen el resolutor estricto de calculo.

## 2. Reglas transversales del esquema objetivo

Todas las nuevas entidades persistentes tienen `id_comunidad`, ID estable, version de concurrencia cuando sean editables, origen, UTC/actor y evidencia cuando proceda. FKs compuestas comunidad+ID; si un destino antiguo no las permite, adaptador valida comunidad dentro de la misma transaccion hasta su migracion acordada. Indices por comunidad/ejercicio/estado y por propiedad/periodo.

Fechas de negocio como ISO date e intervalos `[desde,hasta)`. Conocimiento UTC distinto de efecto. Revisiones publicadas append-only, sucesion/anulacion por evento/version nueva. Borradores pueden guardar revisiones y auditoria sin considerarse acuerdos. Referencias a documentos incluyen version/hash, no solo ruta mutable. No borrar entidades referenciadas por aprobaciones, snapshots o cargos.

Adaptacion de fechas existentes: `erp_ejercicios` y `erp_bloqueos_periodo` tienen `fecha_fin` y permiten inicio=fin; no reinterpretarlos como intervalos exclusivos. El adaptador conserva su convencion inclusiva y traduce el fin a dia siguiente al comparar con periodos ERP 2. Validar esta conversion con los servicios vigentes en 2A; no migrar fechas para uniformar nombres. Presupuesto futuro puede prepararse/aprobarse para un ejercicio en preparacion con calendario valido, pero habilitar cargos requiere ejercicio abierto en ERP 3. Una regularizacion actual puede referenciar periodos cerrados como origen sin escribir dentro de ellos.

Dinero EUR final: entero de centimos en persistencia con control de rango SQLite; API lo serializa como cadena para evitar limites de Number. Moneda explicita y unica por presupuesto. Coeficientes/cantidades/tarifas: TEXT decimal canonico con escala de origen preservada, no float/REAL. El modelo admite moneda pero ERP 2 inicial trabaja con monedas de dos decimales; otra escala es validacion no soportada, no conversion tacita.

## 3. Modelo de presupuestos y continuidad

Nombres propuestos, a concretar en migracion futura; no son tablas creadas en esta entrega.

| Entidad | Campos/relaciones clave | Invariantes |
|---|---|---|
| `erp_presupuestos` | comunidad, ejercicio, codigo/nombre, moneda, familia ordinaria, revision de trabajo, version | Identidad del presupuesto, no contenedor de recibos |
| `erp_presupuesto_versiones` | presupuesto, numero, intervalo, configuracion comunidad referenciada, revision origen, creada/registrada, estado de preparacion | Contenido aprobado no mutable; numero unico por presupuesto |
| `erp_presupuesto_capitulos` | version, clave_continuidad, nombre, orden | Identidad de continuidad conservada al copiar; orden estable |
| `erp_presupuesto_partidas` | capitulo/version, clave_continuidad, nombre, importe_centimos, categoria_origen_ref, correspondencia_PGC_ref opcional | Una partida contable/presupuestaria no se duplica por grupo |
| `erp_partida_repartos` | partida/version, clave_linea, grupo, seleccion de serie/finalidad, regla_version, modo importe/porcentaje, valor, orden | Suma asignada + financiacion = partida; exclusividad del modo de entrada |
| `erp_partida_financiaciones` | partida, tipo de fuente, importe, referencia/evidencia, estado de revision | Planificacion, no movimiento de tesoreria; ninguna diferencia sin linea explicita |
| `erp_partida_exenciones` | version_partida, propiedad, intervalo, motivo, evidencia, tratamiento importe | No altera miembro/coefficient ERP 1; unicidad por tramo efectivo |
| `erp_reglas_reparto_versiones` | codigo motor, version de algoritmo, tipo, parametros tipados, unidad, alcance temporal, esquema_version | Catalogo permitido, parametros validados, sin eval/codigo libre |
| `erp_regla_componentes` | regla mixta, subregla_version, importe/fraccion, orden | Grafo sin ciclos; inicial un nivel de mezcla; hojas suman padre |
| `erp_presupuesto_correspondencias` | identidades origen/destino, relacion copia/division/fusion, confirmacion | Correspondencia explicita; no fuzzy matching automatico |
| `erp_presupuesto_actos` | presupuesto/revision, tipo proponer/aprobar/cerrar/archivar/sustituir, simulacion, hash, fecha acuerdo, actor, documento | Aprobacion inmutable; lifecycle no reescribe el acuerdo |

Continuidad: claves opacas estables por comunidad, no nombre o posicion. Una identidad de partida aparece una vez por revision. Copiar a otra comunidad exige mapeo de grupos, no trasplanta IDs ni permisos. Versiones rivales pueden existir en borrador; la aprobacion verifica exclusividad del intervalo rector y sucesiones explicitas.

## 4. Configuracion, calendario, planes y operaciones especiales

La configuracion ordinaria reside en una nueva revision tipada de `erp_comunidad_config_versiones`: frecuencia/meses, anclaje, dia previsto de emision, vencimiento, referencia economica y version de redondeo. Validar estos campos con contrato, no JSON arbitrario; cualquier cambio crea revision y no afecta planes aprobados. La resolucion del destinatario por fecha efectiva de emision es una regla de contrato confirmada, no una opcion que pueda cambiar silenciosamente la configuracion del calendario.

| Entidad | Contenido |
|---|---|
| `erp_planes_cuota` | comunidad, tipo ordinario/derrama/regularizacion/ajuste, origen tipado, version, moneda, intervalo, estado; no recibo |
| `erp_plan_periodos` | plan_version, clave_periodo estable, inicio/fin, emision prevista, vencimiento, peso temporal, ejercicio destino, ordinal |
| `erp_plan_sucesiones` | plan origen/destino, concepto y periodos afectados, acuerdo; una autoridad por periodo |
| `erp_derrama_versiones` | identidad derrama, concepto, importe, aprobacion, proyecto/acuerdo, version de plan propio |
| `erp_derrama_repartos` | derrama_version, grupo/serie/regla y valor de asignacion; mismo validador que partida, FK tipada |
| `erp_regularizaciones` | plan esperado, periodos origen, motivo, corte/conocimiento, cobertura de cargos, aprobacion y fecha de ajuste |
| `erp_regularizacion_lineas` | propiedad/concepto/periodo, esperado, emitido_neto, cobrado informativo, ajustes previos, diferencia, destinatario pendiente/confirmado |
| `erp_regularizacion_origenes` | linea, cargo/abono/ajuste fuente con sistema+ID estable, snapshot e importe computado |
| `erp_ajustes_plan` | plan/propiedad/concepto, importe firmado, motivo, evidencia, contrapartida/financiacion, estado |

Usar enlaces tipados y CHECK XOR para el origen de cada plan, no `tipo+ID` sin validacion. Derramas reutilizan motor/contratos, no una copia del algoritmo. Las claves de concepto distinguen ordinaria, cada derrama y cada regularizacion, sin usar texto como identidad.

La planificacion no se transforma en recibo por cambiar un estado. ERP 3 poseera el registro unico de emision. Ninguna tabla ERP 2 guarda una segunda version mutable del saldo de deuda.

## 5. Inquilinos y configuracion operativa

Mantener `cf_propietarios` y `cf_contactos_propietario` como autoridad de identidades propietarias. No crear un maestro global de personas/proveedores contrario al modelo ERP 1.

| Entidad nueva limitada | Contenido e integridad |
|---|---|
| `erp_personas_cobro` | comunidad, tipo fisica/juridica, nombre, identificacion opcional, direccion/idioma, estado/version; solo personas no propietarias del dominio de ocupacion/cobro |
| `erp_persona_cobro_contactos` | persona de cobro, tipo/valor, principal por tipo, verificacion, vigencia y origen; mismo contrato de validacion de contactos, no filas duplicadas de propietario |
| `erp_ocupaciones` / `erp_ocupacion_versiones` | propiedad, tipo arrendamiento/ocupacion documentada, desde/hasta, origen/documento, conocimiento, sustituye; historico preservado |
| `erp_ocupacion_personas` | ocupacion_version, propietario_ref XOR persona_cobro_ref, papel en ocupacion | 
| `erp_config_recibo_versiones` | propiedad, concepto/alcance ordinario o especifico, efectiva_desde/efectiva_hasta, registrada_en y version sustituida, destinatario y pagador mediante pares FK XOR, medio previsto, referencia bancaria opcional, confirmacion/evidencia; vigencia por fecha, no limitada a periodos |
| `erp_persona_cobro_vinculos` | persona no propietaria -> propietario verificado de misma comunidad, fecha/actor/motivo | 

No asociar automaticamente por NIF/email. Si una persona de cobro se convierte en propietario, se vincula tras revision y futuras referencias usan al propietario; contactos se concilian explicitamente con su origen, no se mantienen dos escritores. El registro anterior queda historico y no se editan sus snapshots. Las consultas usan un resolutor tipado comun, no una nueva relacion de titularidad.

Las referencias de destinatario y pagador contienen exactamente un ID de una de las dos tablas. La ocupacion puede contener varios participantes; configuracion operativa elige uno por papel. Por propiedad/concepto/fecha efectiva no puede haber dos configuraciones igualmente prioritarias. La especifica prevalece sobre la general y la simulacion de destinatarios muestra esa precedencia. El resolutor consulta el intervalo que contiene la fecha efectiva de emision y las versiones confirmadas conocidas al ejecutar la operacion. No desplaza la fecha de la transmision ni de la configuracion al inicio del siguiente periodo.

La referencia bancaria sera un identificador opaco del contrato de medios de cobro, nullable. Mientras ERP 4 no publique su registro, solo se almacena preferencia/estado pendiente o referencia heredada verificada por adaptador, nunca un ID inexistente dado por valido ni un IBAN en parametros de regla. ERP 4 resolvera cuenta, relacion con pagador, firmante y mandato. No duplicar cuentas de tesoreria de comunidad ni usar una cuenta de banco/caja como cuenta domiciliada del residente.

Consultas a fecha y conocido_en reproducen ocupaciones/configuracion anteriores. Una correccion nueva no cambia al destinatario congelado de ERP 3. La falta de identidad responsable no altera el importe calculado por propiedad, pero bloquea preparar ese cargo.

Separar `periodo_cuota`, `fecha_emision_prevista`, `fecha_emision_efectiva` y `emitido_en` (registro UTC). La fecha efectiva de emision es la fecha de negocio de la operacion confirmada, visible y auditada, no se sustituye por inicio del periodo ni por una fecha prevista vencida. Preparacion, simulacion o exportacion de una propuesta no son emision. Los snapshots previos solo sirven para revision: ERP 3 revalida fecha y versiones en la transaccion de emision; si difieren de lo revisado, devuelve conflicto y solicita nueva confirmacion. Un reintento idempotente de emision completada devuelve el cargo original, aunque hayan cambiado titular o configuracion. Las fechas excepcionales no se ajustan automaticamente para elegir destinatario; su validacion pertenece al comando de emision ERP 3.

## 6. Snapshots y resultados

| Entidad | Evidencia guardada |
|---|---|
| `erp_simulaciones` | comunidad, origen/revision, request/hash, motor/reglas/redondeo, corte efectivo/conocimiento, moneda, estado pendiente/calculando/completa/fallida/obsoleta, totales |
| `erp_simulacion_entradas` | manifest canonico de propiedades, versiones de grupo, miembros, series/valores, exenciones, cantidades/tarifas, financiacion, calendario y fuentes; IDs mas valores congelados |
| `erp_calculo_lineas` | propiedad, partida/asignacion/componente, grupo/version, serie/version, valor/denominador, racional exacto, base truncada, ajuste, final_centimos |
| `erp_calculo_periodos` | linea calculo + periodo, racional temporal, ajuste, final_centimos; suma por linea igual al total de linea |
| `erp_calculo_incidencias` | codigo/severidad, entidad/campo/propiedades afectadas, causa, solucion/revision, actor |
| `erp_plan_destinatarios_snapshot` | resolucion revisable de titulares, destinatario/pagador, configuracion/version, periodo, fecha de emision usada en prevision y fecha de conocimiento; NO sustituye snapshot de emision ERP 3 |

PK/UNIQUE de resultados impiden duplicar linea/propiedad/periodo dentro de simulacion. Los resultados monetarios no dependen del destinatario; su snapshot operativo puede prepararse despues sin alterar cantidades ni simular un cambio de titularidad juridica.

La traza incluye coeficiente original/canonico, escala y unidad, denominador usado, numerador/denominador racionales en texto entero, residuos, orden de desempate, fuentes y codigo de motor. Decimal aproximado solo para lectura. Descargar un aprobado reproduce su snapshot; no consulta valores actuales para recalcularlo.

Los snapshots son evidencia necesaria, no un segundo maestro editable. Reglas nuevas llevan nueva version. Cambiar motor exige pruebas de reproduccion historica o mantener el ejecutor anterior; no reescribir resultados porque se publique una mejora.

## 7. Algoritmo determinista

### 7.1 Captura y validacion

1. Autorizar actor/comunidad y revision. Validar moneda, ejercicio y bloqueos del dominio presupuestos. Leer entradas en una vista consistente de SQLite.
2. Resolver conjunto efectivo a fecha y conocimiento declarados. Cada miembro tiene pertenencia valida, cada coeficiente seleccionado exactamente una version aprobada y calidad validada. No usar `ORDER BY ... LIMIT 1` para ocultar ambiguedad temporal.
3. Verificar grupo/base/total esperado, fechas conocidas o cobertura documental expresamente validada, exenciones y selector de serie por propiedad. Una finalidad no equivale a un ID de serie unico para todo el grupo: ERP 1 define serie por propiedad+grupo+finalidad+unidad.
4. En grupo porcentaje validar suma declarada antes de exclusiones; despues validar politica expresa de redistribucion/financiacion. No convertir suma 99,85 en 100 en silencio. Grupo peso permite total distinto de 100; base otra queda no soportada.
5. Validar asignaciones, fuentes, calendario y reglas. Decimal de entrada hasta escala declarada (30 maximo actual); convertir a racionales exactos/integer para divisiones y productos. Ninguna operacion economica usa float.

### 7.2 Reparto por asignacion

Sea T el importe de asignacion en centimos, w_i el peso exacto de una propiedad elegible y W su suma positiva. Resultado racional q_i = T * w_i / W.

- Coeficiente/peso: w_i es valor de serie seleccionada. En porcentaje completo que suma 100, W=100; en tanto por uno, W=1. Redistribuir tras exencion solo si se aprobo esa politica, mostrando W efectivo y coeficientes originales intactos.
- Partes iguales: w_i=1 por propiedad, no por titular; no agregar anexos por similitud de codigo. No se introduce una unidad facturable compuesta nueva sin configuracion explicita posterior.
- Importe fijo: q_i procede del importe comprometido y alcance temporal; suma debe coincidir. No proporcionalizar para cuadrar. Si es importe por periodo, multiplicar por numero de periodos sin redondeos intermedios y exigir total coherente.
- Unidades/consumo por tarifa: q_i=cantidad_i*tarifa, convertido exactamente a centimos. La suma racional debe corresponder al importe contractual; solo se tolera diferencia explicita de redondeo monetario declarada por regla, nunca una diferencia comercial sin justificar. Consumo proporcional a un fondo usa w_i=consumo_i y T aprobado. Los dos modos no se mezclan.
- Porcentaje especial: algoritmo de coeficiente, distinto selector de serie. Nunca fallback al general.
- Mixta: repartir primero T entre componentes aprobados, luego ejecutar sus hojas. Orden estable y un nivel de composicion inicial; compartir propiedad entre hojas es valido si los importes de hojas no duplican T.

Para tarifas con fracciones de centimo: declarar politica de cuantizacion del total (mitad hacia arriba sobre magnitud, signo al final), obtener objetivo en centimos y luego mayores restos entre sus lineas. Se muestra la diferencia entre total racional y monetario. No alterar una tarifa fija ya pactada a dos decimales para conseguir otro total. Toda regla guarda su politica, no depende del contexto Decimal global.

### 7.3 Mayores restos espacial

Para T positivo, b_i=floor(q_i) en centimos enteros, r_i=q_i-b_i, R=T-sum(b_i). Anadir 1 centimo a las R lineas con r_i mas alto. Comparar racionales por productos cruzados exactos. Desempate estable por ID de propiedad; en division de asignaciones/componentes, su clave estable. Ordenar el grid o cambiar un nombre no cambia el reparto.

Para total negativo, ejecutar sobre magnitudes y aplicar signo al final. No mezclar cargos positivos y creditos negativos dentro de un mismo fondo: calcular componentes separados y sumar despues. Registrar ajustados y criterio. No repartir un residuo imposible: indica una violacion de entradas/regla y bloquea.

### 7.4 Reparto entre periodos

Una vez fijado el importe entero A_i de cada linea/propiedad, distribuirlo entre periodos con pesos p_j aprobados: t_ij=A_i*p_j/sum(p). Aplicar mayores restos en esa fila, desempate por ordinal cronologico estable de periodo. Para importe fijo por periodo, respetar el valor fijo; no volver a distribuir un total que lo cambie.

Invariantes exactos: suma periodos de una linea = A_i; suma lineas propiedad = cuota total propiedad; suma propiedades = importe a cuotas; suma periodos global = importe a cuotas. El total de cada mes puede variar algunos centimos: no se promete simultaneamente doce meses globales identicos y cuotas individuales identicas cuando matematicamente no es posible. La pantalla muestra calendario real completo antes de aprobar. No concentrar un ajuste anual oculto despues de emitir.

No redondear de nuevo al sumar cuotas por propiedad/concepto/periodo; ya son centimos enteros. Esta agregacion origina un solo candidato de cargo ordinario, con muchas lineas explicativas.

Si el acuerdo ya contempla cambios de participantes/exenciones por tramos del calendario, debe declarar las asignaciones monetarias o pesos de cada tramo antes de simular, y cada tramo congela sus versiones. El motor conserva suma de tramos = total, sin ponderacion diaria implicita. Una vigencia que cambia dentro de un tramo sin tratamiento aprobado genera incidencia, no se aplica a todo el ano ni se ignora. Esta capacidad prepara excepciones temporales sin modificar automaticamente un aprobado cuando cambia ERP 1.

### 7.5 Ejemplos de control matematico

- 100,00 / 3 iguales -> 33,34; 33,33; 33,33 por ID estable. Crediticio -100,00 -> -33,34; -33,33; -33,33.
- 100,00 anual en 12 periodos -> cuatro de 8,34 y ocho de 8,33; total 100,00. El desempate temporal asigna los cuatro centimos a los primeros periodos del calendario.
- Partida 1.200,00 con A 60% y B 40% -> A 720,00 anual / 60,00 mensual; B 480,00 / 40,00. Que A tenga copropietarios 60/40 no cambia sus 60,00 ni crea dos cuotas.
- Pesos 1,2,3 sobre 100,00 -> 16,67; 33,33; 50,00. Peso total 6, nunca error por no ser 100.

## 8. Simular y aprobar sin carreras

Calculo puro separado de IO. Capturar manifest consistente en transaccion de lectura corta; calcular fuera de transaccion de escritura. Para volumen alto usar trabajo persistente consultable, con progreso por etapas y paginacion de resultados. No dejar `BEGIN IMMEDIATE` abierto mientras se parsea Excel o se calcula todo.

Guardar simulacion completa atomicamente; fallida no ofrece resultados definitivos. Repetir mismo request idempotente devuelve mismo trabajo/resultado. Una simulacion no escribe en maestros ni crea cargos. Captura y hash incluyen todas las entradas economicamente relevantes, no solo version del presupuesto.

Aprobar en transaccion corta: refrescar sesion/permiso -> comprobar expected_version -> idempotencia -> ejercicio/bloqueos -> huella vigente de dependencias -> simulacion completa sin bloqueos -> exclusividad de plan/periodos -> guardar acto, plan, auditoria y outbox -> commit. Fuente modificada da 409 y exige nueva revision/simulacion; no aceptar un hash enviado por cliente como prueba suficiente. Los valores congelados aprobados siguen siendo validos como historia aunque cambien los maestros despues.

No incluir la futura resolucion bancaria como dependencia del importe; si cambia pagador despues se revisa preparacion operativa, no se altera el presupuesto. Una revocacion de permiso bloquea confirmar aunque la pantalla se haya abierto antes.

## 9. Contratos internos propuestos

Prefijo futuro `erp2`, contrato payload versionado, incorporado al dispatcher existente solo al implementar. Campos estructurados de dinero como cadenas; comunidad explicita; filtros/IDs tambien autorizados en backend. Las escrituras requieren `idempotency_key`, `expected_version` donde haya agregado existente y motivo/evidencia segun accion.

| Comando / consulta | Entrada principal | Salida/efecto |
|---|---|---|
| `budget.create/copy/save` | ejercicio, origen, revision/lineas/calendario | Borrador y diferencias; no aprobado |
| `budget.import.preview/confirm` | archivo privado/hash, mapeo y decisiones | Staging/incidencias; confirmacion atomica de revision |
| `budget.simulate` | presupuesto/revision, corte/conocimiento | ID trabajo, manifest, resultados, errores y avisos |
| `budget.propose/approve/close` | revision, simulacion/evidencia/motivo | Acto auditado y, al aprobar, plan inmutable |
| `budget.amend` | aprobado origen, alcance de sucesion | Nueva revision, nunca UPDATE de aprobado |
| `budget.get/compare`, `simulation.get` | ID/version/filtros | Proyecciones paginadas con totales globales |
| `quota.explain` | plan/version, propiedad, periodo | Total, desgloses, racionales, fuentes, redondeo |
| `assessment.save/simulate/approve` | derrama, calendario y reglas | Revision y plan extraordinario |
| `regularization.preview/approve` | plan, periodos, snapshot cargos | Diferencias justificadas; propuesta para ERP 3 |
| `occupancy.save`, `billing.propose/confirm` | propiedad, personas/fechas/documento | Historico ocupacion y configuracion con vigencia por fecha, sin deuda |
| `billing.preview` | propiedad/plan/periodo, fecha_emision de referencia | Titulares, destinatario, pagador, vigencia, versiones consultadas, recibos pendientes afectados y bloqueos |
| `plan.export.preview` | plan/version, periodos | Candidatos de obligacion para contrato ERP 3, no XML/recibos |

Los nombres son catalogo de diseno, no rutas HTTP disponibles. No crear un comando generico que admita un SQL o una formula textual. Herramientas IA solo consultan o crean borradores/propuestas; la aprobacion exige actor humano y comprobacion backend, no un booleano `confirmed` inventado por el modelo.

## 10. Permisos, auditoria y documentos

Reutilizar autorizacion por comunidad y sesion. Introducir capacidades economicas explicitas: leer presupuesto, preparar, aprobar, configurar destinatarios/cobro y consultar datos sensibles. Deben mapearse a la infraestructura existente, con rechazo por defecto; `puede_actualizar` por si solo no habilita aprobar gasto. El permiso de ver presupuesto no permite ver IBAN/contactos de inquilinos.

Auditar revision antes/despues, confirmacion de importacion, reglas/excepciones, cambios de calendario, simulacion aprobada, modificaciones formales, configuracion de cobro y ocupacion. Detalle sensible solo en registros protegidos del dominio; auditoria/outbox usan IDs y cambios seguros. Ninguna cuenta completa en log, URL o exportacion general.

La descarga de presupuesto, acuerdo y fuente importada comprueba comunidad, permiso documental y sensibilidad; una URL enlazada no da acceso por si misma. Cerrar o borrar un enlace no elimina evidencia de un aprobado. CSV/Excel neutraliza texto que pueda interpretarse como formula; no ejecutar formulas del documento importado.

## 11. Fronteras con fases futuras

- ERP 3 recibe candidato con comunidad, plan/version, simulacion/hash, propiedad, concepto, periodo, importe_centimos, moneda, vencimiento y referencias de desglose. Al emitir un cargo pendiente resuelve destinatario/pagador con la configuracion vigente en la fecha efectiva de emision y congela identidad, configuracion/version, fecha y conocimiento utilizados; no usa el inicio natural del periodo. El obligado se determina con las reglas propias de ERP 3, sin equipararlo automaticamente a destinatario o pagador; la relacion juridica historica se conserva aparte. Un cargo ya emitido no cambia automaticamente por transmision ni correccion posterior. Clave de obligacion de negocio `(comunidad, propiedad, concepto, periodo)` independiente de revision, con revision rectora comprobada: cambiar version no permite emitir dos veces. Regularizacion usa concepto propio y vinculos de origen.
- ERP 3 devuelve cargos netos emitidos, abonos/anulaciones trazadas, cobros y corte/cobertura por identidad estable. La regularizacion no consume un mero saldo ni deduce cobro de un fichero SEPA. Reserva logica de ajuste aprobada pendiente impide proponerla otra vez; al emitirse cambia su estado, no se descuenta dos veces.
- ERP 4 conecta la referencia de medio con cuenta/pagador/mandato. Recibo a nombre de inquilino no es mandato. Ningun XML, firma SEPA o remesa se implementa aqui.
- ERP 5 aporta pagos/conciliacion, no modifica previsiones ni cuotas para hacerlas coincidir con banco. Cuenta de caja y banco de comunidad siguen separadas de medios de cobro particulares.
- ERP 6 recibe el hecho de emision de ERP 3, no un asiento por simular o aprobar presupuesto. `budget.approved` es evento de planificacion, no ingreso/devengo automatico. Catalogo de hechos y contrato de asientos antes de emision financiera real.
- ERP 7 relacionara compromisos/facturas/pagos con identidad de partida y revision autorizada. ERP 2 muestra `sin datos de ejecucion` hasta disponer del contrato; no calcula disponible real como presupuesto menos pagos. Presupuesto != gasto comprometido != facturado != pagado.
- ERP 8 reutiliza proyectos/documentos/asambleas/informes. Documento aprobado usa snapshot, no altera actas anteriores.
- ERP 9 consume explicacion estructurada con corte y fuentes; reglas y almacenamiento no tienen proveedor LLM ni llamadas al modelo. No se inicia otro agente.

## 12. Secuencia futura de implementacion y aceptacion

Implantacion actual 0%. Los siguientes son bloques propuestos, no ejecutados:

| Bloque | Entrega | Dependencia / puerta de salida |
|---|---|---|
| 2A | Contratos, capacidades, migracion aditiva, compatibilidad y datos sinteticos | Diseno funcional cerrado; autorizacion de inicio, checkpoint codigo + backup independiente restaurado en copia |
| 2B | Motor puro y snapshots: coeficiente/igual/fijo/unidades/especial/mixta; interfaz consumo revisado | Pruebas exactas, aislamiento, no uso de REAL; no interfaz antes de probar conservacion |
| 2C | Edicion capitulos/partidas, copia/importacion, calendario, simulacion/comparacion/aprobacion | Revision obsoleta, rollback y usuario sin permiso probados |
| 2D | Ocupacion/destinatarios, derramas y regularizacion revisable; explicacion/exportaciones | No cargos sin ERP 3; no SEPA; contratos futuros documentados |
| 2E | Regresion, pruebas UX escritorio/movil, restauracion, prueba de usuario y despliegue autorizado | Evidencia antes de conceder porcentaje de implantacion; no suma automatica por completar diseno |

Mantener hitos de porcentaje del roadmap, no asignar 20% por cada fila: los bloques se pueden solapar con los cuatro hitos certificados de 25 puntos. Activacion por comunidad y opcion de deshabilitar UI nueva sin perder datos. Los escritores antiguos de reparto no podran escribir en resultados ERP 2; cualquier retirada/reemplazo exige inventario de consumidores en 2A.

## 13. Matriz de pruebas obligatoria futura

No son pruebas ejecutadas en esta entrega de diseno.

| ID | Escenario | Aceptacion |
|---|---|---|
| C01 | 40 propiedades, General todas, Jardines 16 | Especial no altera general; resto no paga jardines |
| C02 | Porcentaje 100 exacto / 99,85 / 101,25 | Solo primero aprobable; no normalizacion oculta |
| C03 | Pesos 1/2/3; grupo sin coeficiente partes iguales | Resultados de seccion 7; sin exigir suma 100 ni valores ficticios |
| C04 | 100/3 y -100/3; resto empatado | Conservacion exacta, signo simetrico, desempate estable |
| C05 | 100 anual/12; multiples partidas y periodos | Suma fila, propiedad, calendario y presupuesto iguales al centimo |
| C06 | 50.000 repartidos 80/20 con miembros compartidos | Asignaciones suman partida, una cuota agregada por concepto |
| C07 | Fijos/unidades con total discordante, tarifa subcentimo | Bloqueo comercial; solo redondeo declarado, nunca escala oculta |
| C08 | Mixta valida, ciclo y duplicacion de importe | Hoja trazable; ciclo/descuadre rechazados |
| C09 | Serie general/especial, nula, no aprobada, intervalos ambiguos | Correcta seleccion; fallos no se resuelven por primer registro |
| C10 | Exencion sin alterar grupo | Importe redistribuido o financiado expresamente; sin politica bloquea |
| C11 | Fuente fondos propios y todo financiado por cuotas | Gasto = cuotas + fuentes; ningun apunte/cobro generado |
| C12 | Copropiedad 60/40 | Una cuota; destinatario explicito, titulares e historico intactos |
| C13 | Venta efectiva 10/07, julio emitido 03/07 | Julio conserva antiguo destinatario; agosto usa configuracion vigente al emitirse; sin prorrateo |
| C13b | Julio pendiente, transmision 10/07 conocida, emision efectiva 15/07 | Configuracion vigente 15/07; cuota completa al destinatario resuelto, no al de inicio de julio |
| C13c | Periodo anterior/trimestral pendiente y cambio efectivo en fecha de emision | Resolver vigencia a fecha de emision con extremo inicial incluido; no esperar al periodo siguiente |
| C13d | Cambio de fecha/configuracion entre propuesta y emision; reintento de cargo ya emitido | Conflicto y nueva revision antes de emitir; reintento completado devuelve snapshot original |
| C13e | Transmision conocida despues de emision con efecto anterior | Ningun cambio automatico del emitido; discrepancia revisable mediante operacion ERP 3 |
| C14 | Inquilino destinatario/pagador, solo pagador, varios inquilinos | Casillas independientes; no cambia titularidad ni deuda |
| C15 | Fin ocupacion, correccion conocida tarde, cambio de cuenta | Vigencia por fecha y resolucion de pendientes a fecha de emision; antiguos snapshots intactos |
| C16 | Cambio coeficiente tras aprobar / antes de confirmar simulacion | Historico intacto / conflicto y recalculo respectivamente |
| C17 | Cambio periodicidad, ejercicio no natural, tramo parcial | Calendario explicito, no dias prorrateados ni partida con frecuencia propia |
| C18 | Derrama varios plazos/ejercicios | Calendario propio exacto, ordinarias inalteradas, sin XML |
| C19 | Regularizacion 220 esperado / 200 emitido / 100 cobrado | +20; credito -20 si correspondia 180; deuda anterior intacta |
| C20 | Ajuste previo emitido o pendiente; reintento | Sin doble regularizacion ni doble descuento |
| C21 | Solo saldo bancario/deuda, sin cargos fiables | Simulacion rotulada; no regularizacion cobrable |
| C22 | Copia, renombrar, mover, fusion/division partidas | Comparacion por identidad; sin aprobaciones copiadas |
| C23 | Excel valido, duplicado, subtotal, formula, moneda/decimal ambiguo | Staging y confirmacion; nunca importacion dudosa silenciosa |
| C24 | Dos confirmaciones, fallo intermedio, clave con otro contenido | Idempotencia, 409 o rollback de datos+auditoria+outbox |
| C25 | Comunidad ajena, permiso revocado, sesion solo lectura | Rechazo de comando/consulta sensible/export/documento |
| C26 | Presupuesto aprobado, periodo bloqueado, ejercicio cerrado | No edicion retrospectiva; nueva operacion autorizada cuando corresponda |
| C27 | Reproducir snapshot tras renombrar/desactivar maestros | Mismos centimos, evidencia y destinatarios historicos |
| C28 | Carga sintetica 1.000 propiedades x 100 partidas x 12 periodos | Calculo fuera de bloqueo de escritura, paginacion y progreso; medir p95 antes de publicar |
| C29 | Escritorio/movil, teclado, volver de incidencia, guardado conflictivo | Sin perdida de borrador, controles legibles, no overflow de pagina |
| C30 | Regresion ERP 0/1, recibos, deuda, asambleas y restauracion | IDs y datos previos conservados; backup recuperable ensayado |

Anadir tests generativos de conservacion para cantidades exactas, orden arbitrario de filas y distintos calendarios; usar semilla reproducible y oraculo racional independiente. Ninguna prueba debe necesitar NVIDIA/OpenAI ni enviar informacion personal fuera del entorno.

## 14. Riesgos y control de cierre

- Calidad legacy y grupos en borrador: puerta de validacion antes de calculo definitivo, no elevar calidad por migrar.
- Responsabilidad economica de propietario/inquilino: configuracion de destinatario no resuelve deuda; contrato ERP 3 y documentacion independiente.
- Cargos historicos incompletos: sin cobertura de emisiones, no afirmar regularizacion final.
- Duplicacion de verdad con reparto antiguo: inventario y adaptador, nunca dos escritores economicos para el mismo plan.
- Redondeo multi-etapa: invariantes espaciales/temporales y politica versionada; no prometer cuotas/meses identicos imposibles.
- SQLite/concurrencia: transacciones cortas, captura consistente y conflictos claros; no migrar a otro motor sin medicion.
- Datos personales: identidades de cobro limitadas a comunidad, no exportaciones generales con datos bancarios, descargas autorizadas.

Verificacion de esta entrega: diseno enlazado, reglas cerradas cubiertas, modelo real referenciado, UX ERP 1 conservada, precision de hasta 30 decimales respetada, ERP 3/4 fuera de implementacion. Solo documentacion modificada. No se han ejecutado migraciones ni pruebas de negocio sobre datos reales.
