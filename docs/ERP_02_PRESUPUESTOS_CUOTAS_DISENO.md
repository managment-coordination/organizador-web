# ERP 2 - Presupuestos y cuotas: diseno funcional y UX

Fecha: 10/09/2026. Estado de fase: ANALISIS. Diseno funcional cerrado tras ratificacion y precision del usuario; implantacion: 0%. No autoriza implementacion, migraciones, emision de recibos ni cambios en produccion.

[Roadmap ERP](ERP_COMUNIDADES_ROADMAP.md) | [Modelo, motor y contratos ERP 2](ERP_02_MODELO_CALCULO_CONTRATOS.md) | [ERP 1 y ajustes UX vigentes](ERP_01_DATOS_MAESTROS_IMPLEMENTACION.md)

## 1. Alcance y fuente de verdad

ERP 2 prepara presupuestos aprobados, planes de cuotas explicables, derramas y propuestas de regularizacion. No cobra, no emite recibos, no mueve deuda y no contabiliza. La IA futura podra consultar y proponer mediante los mismos servicios que la interfaz; no decide formulas, destinatarios dudosos ni aprobaciones.

La base es el repositorio `158f6f9`, las migraciones 1/2 y servicios de `server/erp_core`, y los documentos [ERP 0](ERP_00_FUNDAMENTOS_IMPLEMENTACION.md), [modelo maestro](ERP_MODELO_DATOS_MAESTROS.md) y [titularidades/reparto](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md). Las decisiones del usuario sobre periodicidad, ausencia de prorrateo y cargo unico cierran las alternativas que esos documentos dejaban pendientes. No se reabre ni redisenia ERP 1.

Los importes, grupos y reglas concretos de cada comunidad son configuracion posterior, no decisiones que deba inventar este diseno. No se afirma cumplimiento juridico o contable a partir de una arquitectura de software.

## 2. Conceptos que no deben mezclarse

| Concepto | Finalidad |
|---|---|
| Presupuesto | Necesidad economica planificada y aprobada para un intervalo y comunidad |
| Capitulo / partida | Presentacion y destino del gasto; identidad estable entre versiones/ejercicios |
| Asignacion de reparto | Parte del importe de una partida distribuida a un grupo mediante una regla |
| Grupo ERP 1 | Participantes y valores, no un capitulo ni una cuenta contable |
| Estructura de propiedades | Fases/bloques/zonas opcionales, solo filtro, nunca reparto automatico |
| Plan de cuotas | Calendario y resultados por propiedad/concepto/periodo; no son recibos |
| Titular juridico | Composicion temporal ERP 1, incluida copropiedad |
| Destinatario / pagador | Nombre del recibo / persona prevista para el pago; no atribuyen por si solos deuda juridica |
| Obligado historico | Responsabilidad vinculada a un cargo, definida por ERP 3; no equivale siempre al destinatario |
| Cuenta de cobro | Medio referenciado del pagador; mandato y autorizacion bancaria pertenecen a ERP 4 |

## 3. Recorrido principal del administrador

1. Entrar en la comunidad y en `Presupuestos y cuotas`. Nunca editar un presupuesto en contexto `Todas`.
2. Crear desde cero, copiar anterior o importar. Elegir ejercicio e intervalo; recuperar periodicidad ordinaria de comunidad.
3. Editar capitulos y partidas en tabla: nombre, importe y `Como se reparte`. Reordenar con controles accesibles, no solo arrastrando.
4. Reutilizar grupos existentes. En cada partida asignar importe o porcentaje a uno o varios grupos y elegir regla.
5. Revisar calendario y simular. Resolver incidencias desde enlaces al dato concreto, sin recorrer todas las fichas.
6. Comparar presupuesto anterior e impacto en cuotas; consultar `Por que paga esto` en cualquier propiedad.
7. Presentar propuesta y registrar aprobacion con fecha, acuerdo/documento y persona autorizada. Aprobar congela version y simulacion.
8. Consultar plan aprobado. `Preparar emision` sera un enlace a ERP 3 cuando este disponible, no un boton que emita desde ERP 2.

Guardar un borrador no exige completar todo. Aprobar exige coherencia economica total. Una simulacion de borrador se identifica como tal y puede mostrar resultados parciales, nunca una cuota definitiva si hay errores.

## 4. Estados, versiones y aprobacion

`Borrador -> Propuesto -> Aprobado -> Cerrado` es el ciclo visible. Propuesto significa preparado para decision, no autorizado para cobrar. Puede volver a borrador con motivo; una edicion invalida su simulacion y deja de considerarse propuesto.

- Cabecera estable + revisiones de contenido. Guardar exige version esperada; el historial de cambios se consulta bajo demanda. Al presentar se fija una revision identificable.
- Aprobar crea un acto append-only vinculado a revision, simulacion, acuerdo y hash de entradas. Ni capitulos, partidas, importes, reglas, calendario ni evidencia de esa aprobacion se sobrescriben.
- Cerrar es un evento de ciclo de vida: no elimina cuotas, obligaciones futuras o historial ni cierra el ejercicio contable. Si quedan periodos futuros vigentes se bloquea el cierre hasta concluirlos o documentar una sucesion/cancelacion prospectiva.
- Archivar un borrador lo retira de la lista habitual, sin confundirlo con un presupuesto aprobado cerrado.
- Una modificacion formal parte de copia de la version aprobada, tiene nueva aprobacion y fecha de aplicacion. Explica que periodos sustituye; los ya emitidos permanecen intactos y, si procede, se regularizan aparte.
- Solo un plan ordinario rector por comunidad/intervalo/concepto. Pueden coexistir escenarios borrador y derramas, no dos planes que originen el mismo cargo ordinario.
- Aprobar acredita un acuerdo aportado; no toma decisiones de junta, no recalcula mayorias ni modifica un acta. Puede enlazar la asamblea existente o un documento externo.

**Decision autonoma de diseno D01:** separar aprobacion economica de preparacion para cobro. Datos bancarios o destinatarios pendientes no impiden aprobar un presupuesto calculable; si impiden preparar los cargos afectados. La pantalla muestra ambos controles, sin un falso estado global `Todo correcto`.

## 5. Periodos y cambios temporales

### Cuota ordinaria

Periodicidad versionada por comunidad: mensual, trimestral, semestral o anual. El calendario establece intervalos `[inicio, fin)`, emision prevista y vencimiento, anclados al ejercicio. Todas las partidas ordinarias usan ese calendario. Para ejercicios no naturales se muestra el calendario concreto, no se infieren meses por el numero de ano.

La configuracion futura puede admitir numero de meses y anclaje validado. No se ofrece inicialmente un editor de expresiones cron ni periodicidad por partida. Los dias de emision/vencimiento inexistentes en un mes se llevan al ultimo dia de ese mes y se muestran antes de aprobar. Ajustar a dias bancarios habiles corresponde a ERP 4 y no cambia el periodo de cuota.

Un informe semestral no crea un ejercicio ni reduce un presupuesto anual. Un presupuesto de intervalo menor declara importe de ese intervalo: no se anualiza ni divide por dias automaticamente. Los periodos inicial/final incompletos requieren calendario e importes/pesos temporales expresos antes de aprobar; esta no es una opcion para prorratear entre titulares.

**Decision autonoma de diseno D02:** cuotas ordinarias iguales en peso entre periodos completos, con diferencias solo de centimos documentadas. El calendario aprobado fija sus pesos y deja preparada una excepcion expresamente justificada, sin imponer un reparto estacional por partida.

### Titularidad y destinatario operativo

No hay prorrateo de cuota entre antiguo y nuevo propietario. No se cambian fechas juridicas para adaptar el cobro. Una propiedad con dos titulares 60/40 mantiene una sola cuota; no hay dos cargos del 60% y 40%.

**Politica confirmada por el usuario:** un recibo ya emitido conserva su destinatario; una transmision posterior no lo cambia automaticamente. Para un recibo todavia no emitido, se determina el destinatario mediante la configuracion de titular/destinatario vigente en la fecha efectiva de emision. No se utiliza necesariamente el inicio natural del periodo ni su fecha prevista de emision. No existe prorrateo.

Ejemplos: julio emitido el 03/07, venta efectiva el 10/07: julio mantiene el antiguo destinatario; agosto usa la configuracion vigente al emitirse. Si julio no se ha emitido y la transmision del 10/07 ya consta cuando se emite el 15/07, julio usa la configuracion vigente el 15/07, sin dividir su importe. La misma regla se aplica a cuotas trimestrales, semestrales o anuales: importa si el recibo se ha emitido, no si el periodo ya ha empezado. Una reimpresion o reintento de una emision confirmada devuelve el destinatario congelado, no vuelve a resolverlo.

Un cambio registrado tarde no reescribe cargos emitidos. Para los no emitidos, incluidos periodos anteriores pendientes de emitir, se consulta la vigencia en la fecha efectiva de emision con la informacion confirmada conocida en ese momento. La fecha efectiva juridica sigue siendo la de la escritura, aunque se conozca despues. Si una correccion posterior revela que un recibo emitido tenia destinatario incorrecto, se muestra para una operacion explicita de ERP 3, nunca se modifica automaticamente.

La vista previa distingue periodo de cuota, fecha prevista y fecha efectiva de emision utilizada para resolver el destinatario. Preparar un lote o simular no congela definitivamente este ultimo: al confirmar la futura emision ERP 3 revalida fecha y versiones. Si han cambiado desde la revision humana, solicita revisar de nuevo los destinatarios afectados. La informacion desconocida o contradictoria bloquea ese cargo, no se suple eligiendo al primer titular.

La sucesion de titulares genera una propuesta determinista de destinatario si existe un unico titular completo conocido; el usuario confirma. En copropiedad debe elegir representante operativo/destinatario expresamente, sin elegir por mayor porcentaje, orden alfabetico o primer ID. Mantener configuracion de inquilino al vender requiere revision; no se arrastra silenciosamente.

### Coeficientes y participantes

**Politica ratificada por el usuario:** coeficientes, participantes, grupos y reglas utilizados quedan congelados en el snapshot del presupuesto aprobado. La simulacion declara la fecha de referencia economica y la fecha de conocimiento utilizadas. Un cambio posterior de ERP 1 no recalcula el aprobado. Si debe tener efecto economico, requiere modificacion formal, nueva version cuando proceda o regularizacion, sin alterar retrospectivamente el presupuesto aprobado. Esta congelacion del calculo no congela anticipadamente los destinatarios de recibos aun no emitidos.

No se presume que la regla de cambio de propietario determine como aplicar un cambio de coeficiente. Se conserva la capacidad de snapshots por tramo en el modelo para acuerdos futuros, sin activar prorrateos ni migrar despues el resultado historico.

## 6. Inquilinos, destinatario y pagador

En la ficha de propiedad: `Ocupacion y recibos`, plegada si no hay configuracion especial.

- `Tiene inquilino`: muestra ocupacion vigente o permite alta. No es un booleano que borre historia al cambiarlo a No.
- Seleccionar persona ya conocida en esa comunidad o registrar nombre, tipo/identificacion cuando proceda, email, telefono e idioma confirmado; fechas y documento si existe. No se convierte al inquilino en propietario ficticio.
- Historico de ocupaciones con inicio/fin, participantes y origen. Un contrato puede tener varios inquilinos; se elige un destinatario/pagador operativo, no se multiplican cuotas. Solapamientos de contratos completos se senalan; solo se aceptan si se documenta una ocupacion simultanea real.
- Dos opciones independientes: `Recibo a nombre del inquilino` y `Cobrar en la cuenta del inquilino`. Con varios inquilinos, obligan a seleccionar cual. Tambien se admite otro pagador identificado.
- Resumen siempre visible: titulares juridicos; destinatario; pagador; medio previsto; vigencia de configuracion y recibos aun no emitidos afectados segun fecha de emision prevista. Esta prevision se revalida a la fecha efectiva de emision. Titular de cuenta y autorizacion bancaria no se deducen del nombre del pagador.
- Por defecto, propietario unico = destinatario = pagador. En copropiedad el defecto queda pendiente de eleccion, no se interpreta la igualdad como un unico titular juridico.
- Terminar arrendamiento propone retorno al titular desde la fecha efectiva aplicable y solicita confirmacion. La configuracion vigente se resuelve al emitir los recibos pendientes; los ya emitidos no cambian. Si falta propietario claro, queda pendiente. No se usa una cuenta del antiguo inquilino por omision.
- En ERP 2 puede elegirse medio `Transferencia`, `Otro` o `Domiciliacion pendiente de configurar`. La referencia de cuenta existente es opcional; no se solicita un IBAN en texto libre que luego haya que migrar.

**Decision autonoma de diseno D03:** identidad de personas de cobro limitada a este dominio, reutilizando propietario existente mediante referencia cuando lo sea. No crear un maestro universal de terceros ni duplicar contactos de propietarios. Detalle de integridad en el contrato tecnico.

Cambiar estos datos no transfiere deuda, no modifica titularidad, no altera recibos/asambleas historicas y no implica autorizacion para enviar comunicaciones. La responsabilidad legal del cargo queda fuera de estas casillas.

## 7. Partidas y reglas

Una partida conserva su identidad aunque cambie de nombre o capitulo. Puede mantener referencia separada a categoria heredada y correspondencia PGC; no se deduce una cuenta financiera de `603003` ni de un texto.

Cada partida contiene una o varias asignaciones. Un editor permite elegir un solo modo de division: importes exactos o porcentajes que sumen 100. En modo porcentajes, el motor distribuye los centimos entre asignaciones y muestra los importes equivalentes antes de aprobar. No mezcla valores contradictorios como dos fuentes de verdad.

Ejemplo: Jardineria 50.000,00; General 40.000,00 y Jardines privados 10.000,00. Que una propiedad este en ambos grupos es valido: paga porciones distintas de una sola partida. No se duplica la partida ni su total presupuestario.

| Regla visible | Datos solicitados | Incidencias bloqueantes |
|---|---|---|
| Por coeficiente | Grupo y finalidad/serie; base y denominador visibles en detalle | Valor faltante/ambiguo/no validado, total incoherente, denominador cero |
| Partes iguales | Grupo; una unidad por propiedad participante | Grupo vacio; no se cuentan personas/copropietarios |
| Importe fijo | Importe por propiedad; alcance `total del intervalo` o `cada periodo` | Suma no coincide con asignacion; no se escalan importes fijos para cuadrar |
| Unidades | Cantidad exacta por propiedad, unidad y tarifa | Falta de cantidades/evidencia o unidades incompatibles |
| Consumo | Datos revisados por propiedad/periodo y tarifa o fondo a distribuir | Lecturas/consumos faltantes, correcciones sin revisar |
| Porcentaje especial | Serie especial del grupo | Nunca sustituir por coeficiente general por omision |
| Mixta | Componentes de reglas conocidas y sus importes/porcentajes | Ciclos, doble contabilizacion, suma de componentes incorrecta |

Sin coeficiente permite partes iguales/fijos/unidades si tienen sus entradas; no solicita un porcentaje ficticio. Peso relativo no tiene que sumar 100. No se ofrece `Otra` como formula editable.

Consumo preparado con dos usos distintos: estimacion documentada para presupuesto y consumo real validado para regularizacion. Un importe estimado se etiqueta como tal; no se presenta como lectura ni cobro real. ERP 2 no incluye contadores, telelectura, reinicios automaticos ni facturacion de suministros completa.

### Exenciones y fuentes de financiacion

`Excepciones de esta partida` permite exclusion de propiedad con motivo, intervalo y acuerdo/documento. No elimina la pertenencia al grupo. Debe declararse si el importe se redistribuye entre elegibles o lo cubre otra fuente. Sin esa decision no se aprueba; no se normalizan porcentajes silenciosamente.

**Mejora propuesta por Astra M01:** distinguir gasto presupuestado de importe financiado por cuotas. Una partida puede declarar una aportacion de fondos propios/u otro ingreso previsto documentado, con importe y fuente, sin convertirla en un cobro ni en saldo disponible certificado. `Importe de partida = asignaciones a cuotas + financiacion explicita`. Con todo financiado por cuotas, las asignaciones igualan exactamente la partida. Un mero texto justificativo nunca compensa un descuadre numerico. No se implementa gestion de reservas ni tesoreria en ERP 2.

Es util para no cargar como cuota una inversion aprobada con fondos propios. Una fuente no acreditada queda marcada y requiere revision antes de aprobacion. Impuestos y costes se incorporan al importe presupuestario total indicado por usuario; ERP 2 no calcula IVA deducible ni retenciones.

## 8. Simulacion, incidencias y explicacion

La simulacion muestra total de gasto, financiacion, total a cuotas, capitulos, partidas, grupos, participantes y excepciones. Tabla por propiedad: total del intervalo, calendario, cuota anterior/nueva y variacion. Al desplegar una fila se recorre hasta coeficiente/valor exacto, version, denominador y ajuste de centimos.

`Por que pago esto` abre primero un resumen legible y despues el desglose por capitulo/partida. Los importes cobrables tienen dos decimales; los coeficientes y la evidencia matematica conservan su precision. Un racional no terminante se presenta como fraccion exacta y aproximacion rotulada, no como falso decimal exacto.

Tres clases de incidencia:

1. Error de calculo/estructura: bloquea aprobacion (descuadre, serie ambigua, moneda distinta, grupo vacio, vigencia sin cobertura, doble plan ordinario).
2. Advertencia revisable: cambio respecto al anterior, estimacion de consumo, acuerdo externo, fuente documental incompleta segun su relevancia. Exige reconocimiento motivado cuando afecte al acuerdo; no autoriza ignorar errores matematicos.
3. Pendiente de preparacion de cobro: destinatario/pagador no resuelto, cuenta/mandato ausente, ERP 3 no activo. Bloquea salida de cargos, no su calculo por propiedad.

**Mejora propuesta por Astra M02:** revision por diferencias. En una copia del anterior, resaltar solo importes, participantes, reglas y cuotas modificadas. `Ver solo cambios` no oculta incidencias del resto y el total siempre comprende todas las filas, no el filtro visible.

La simulacion queda obsoleta al modificar cualquier entrada economica relevante. Abrirla de nuevo no la recalcula en silencio: muestra el resultado guardado y ofrece otra simulacion. Antes de aprobar se comprueban de nuevo versiones, permisos, bloqueos y huella de fuentes.

## 9. Derramas

Flujo separado dentro de Presupuestos y cuotas: concepto -> importe -> una o varias asignaciones grupo/regla -> calendario propio -> simular -> acuerdo -> aprobar. Cada tramo puede tener fecha e importe/peso propios que sumen exactamente el total. No cambia la periodicidad ordinaria de comunidad.

Se vincula opcionalmente a proyecto, asamblea y documentos existentes. Usa el mismo motor, controles y explicacion; no se disfraza como partida ordinaria repetida. Su plan aprobado es inmutable. Cancelar tramos futuros es documentado y no borra recibos emitidos; modificar lo emitido requiere operacion compensatoria ERP 3.

Una derrama de varios anos es un unico plan con periodos asignados a sus ejercicios, no presupuestos ordinarios duplicados. Deben existir ejercicios de destino validos antes de habilitar sus tramos; un cierre contable no autoriza a cambiar el acuerdo.

## 10. Regularizaciones y ajustes

Flujo: elegir presupuesto/derrama aprobado y periodos -> obtener lo que correspondia -> obtener cargos netos ya emitidos por propiedad/concepto/periodo -> revisar diferencias -> acuerdo/motivo y fecha -> aprobar propuesta separada para ERP 3.

**Decision D04 ratificada por el usuario:** la base economica es lo emitido neto, no el efectivo cobrado. Un recibo pendiente ya constituye importe emitido y no debe volver a cargarse. El cobro se muestra en columna separada. Restar solo lo cobrado volveria a cargar deuda ya emitida.

Ejemplo: enero y febrero emitidos a 100,00 cada uno; nuevo plan 110,00 por mes. Correspondia 220,00; emitido 200,00; cobrado 100,00; regularizacion +20,00, no +120,00. Los 100,00 impagados siguen en sus recibos. Con plan de 90,00, regularizacion -20,00; no se cancela deuda ni se ordena una devolucion bancaria automaticamente.

Se conserva detalle de cada cargo/abono previo, regularizacion anterior, origen/importacion, periodo y corte. Los abonos se representan con signo; nada se sobrescribe. Una segunda ejecucion descuenta regularizaciones ya emitidas y considera las aprobadas pendientes para impedir propuestas duplicadas, mostrandolas por separado.

Si ERP 3 aun no existe: permitir ensayo con base importada revisable pero no publicar ajustes cobrables sin un contrato fiable de cargos emitidos, identificadores, abonos y cobertura. Un saldo de deuda o extracto bancario no sustituye esa base.

Para periodos con distinto obligado historico, el ajuste conserva origen por cargo y requiere revision del destinatario/obligado de la correccion; no se asigna todo al propietario actual. Si se quiere cambiar responsabilidad economica, queda pendiente para ERP 3, sin decidirlo por la casilla del inquilino.

Un ajuste manual es una operacion excepcional con importe, concepto, propiedad, motivo y evidencia. Debe mostrar impacto en el plan y su financiacion/contrapartida; no permite escribir sobre la celda de cuota aprobada para hacerla cuadrar.

## 11. Copia, comparacion e importacion

- Copiar anterior preserva identidades de continuidad de capitulos/partidas y referencias a grupos/reglas. Crea IDs de revision nuevos, importes editables, nuevo ejercicio/calendario y requiere validar fuentes vigentes. No copia aprobacion, excepciones caducadas, ejecuciones, cargos ni incidencias resueltas.
- Exenciones/documentos pueden sugerirse para revision, nunca renovarse por defecto. Plantillas reutilizan estructura, no coeficientes congelados del ano anterior.
- Comparar por identidad estable; partidas nuevas/eliminadas se muestran como tales. Divisiones/fusiones exigen correspondencia explicita N:M y se comparan agregadas sin inventar reparto del importe anterior.
- Diferencia = actual - anterior; porcentaje sobre anterior. Si anterior es cero, mostrar `Nuevo / sin base porcentual`, no infinito. Diferencias de intervalo/calendario se explicitan; no presentar semestral frente a anual como ahorro sin mas.
- Impacto por propiedad compara cuota calculada homogenea y, aparte, ultimo importe emitido si ERP 3 lo aporta. No comparar exclusivamente por nombre/codigo de vivienda.
- Excel/pegado: original privado + hash -> staging -> columnas/capitulo/partida -> coincidencias exactas/confirmadas -> vista previa e incidencias -> confirmar borrador atomico. Identidades ambiguas requieren eleccion; nuevas partidas se crean solo tras aceptacion expresa.
- Detectar cabeceras, subtotales, filas duplicadas, formatos de miles/decimales, celdas vacias, monedas y signos. No sumar subtotales otra vez. No ejecutar macros/formulas; si una celda no tiene valor fiable, pedir valor exportado. Conservar hoja/celda/texto y decision por fila.
- Guardar mapeo reutilizable por comunidad/formato como propuesta, no como autorizacion a importar datos futuros. Repetir mismo lote confirmado devuelve resultado original.

## 12. Pantallas y UX

No se crean pestanas para tablas tecnicas. Navegacion principal en el modulo: `Presupuestos`, `Cuotas`, `Derramas`; regularizaciones accesibles desde el plan/periodos. Configuracion avanzada bajo menu secundario.

| Pantalla | Objetivo e informacion principal | Acciones principales | Oculto habitualmente |
|---|---|---|---|
| Lista y resumen | Comunidad, ejercicio, presupuesto vigente/borrador, total, variacion, pendientes | Crear, abrir, continuar revision | Versiones tecnicas y lotes antiguos |
| Presupuesto | Cabecera compacta con gasto, a cuotas, financiacion, estado, propiedades e incidencias; tabla capitulos/partidas | Editar, simular, comparar, presentar/aprobar segun estado | IDs, huellas y versiones de regla |
| Como se reparte | Panel de partida con importe, grupos, regla y total asignado | Anadir asignacion, reutilizar configuracion, revisar miembros | Exenciones y parametros expertos |
| Simulacion | Cuotas por propiedad y calendario, errores accionables, totales globales | Resolver, explicar, comparar, exportar revision | Traza matematica completa hasta desplegar |
| Comparacion | Total/capitulos/partidas e impacto por propiedad | Solo cambios, enlazar correspondencia, volver a editar | Mapeos de continuidad tecnicos |
| Revision y aprobacion | Version concreta, total, cambios, calendario, acuerdo y advertencias | Confirmar aprobacion / volver | Datos de auditoria consultables |
| Plan de cuotas | Periodos, importes y preparacion operativa; etiqueta `No emitido por ERP 2` | Consultar explicacion; enlazar ERP 3 disponible | Claves de deduplicacion |
| Propiedad | Cuota y participaciones, ocupacion, destinatario/pagador, vigencia y recibos pendientes afectados | Gestionar ocupacion/recibo, consultar historico | Bitemporalidad e IDs |
| Derrama | Importe y calendario propio, proyecto/acuerdo, estado | Simular, aprobar, consultar tramos | Motor comun subyacente |
| Regularizacion | Correspondia/emitido/cobrado/diferencia por periodo y propiedad | Seleccionar periodos, revisar, confirmar propuesta | Referencias de eventos hasta pedir detalle |
| Importacion | Tabla fuente/destino, incidencias, totales previstos | Mapear, corregir, excluir fila con motivo, confirmar | Metadatos de parsing |

Edicion economica en escritorio: tabla estable, importes alineados a derecha, encabezados fijos, navegacion por teclado, pegado en bloque con revision, guardado de borrador y aviso de conflicto. Seleccionar visibles no equivale a seleccionar toda la comunidad; mostrar ambos contadores. Campos numericos como texto decimal validado, sin conversion binaria del navegador.

Movil: resumen compacto, lista de partidas desplegable, ficha de propiedad y comparacion antes/despues. Ediciones puntuales y confirmacion disponibles; tablas economicas densas con desplazamiento dentro de su region, no desbordando toda la pagina. Evitar modales anidados; panel de reparto a pantalla completa en movil. Botones de confirmar separados de cancelar; estado con texto/icono, no solo color. Accesibilidad de foco, etiquetas y mensajes por campo.

**Mejora propuesta por Astra M03:** enlaces directos desde incidencia al grupo/propiedad existente, conservando retorno al presupuesto y el borrador. Sin copiar el editor de Datos maestros ni perder filtros al volver.

**Mejora propuesta por Astra M04:** exportacion de revision en Excel con presupuesto, cuotas y explicacion, y documento legible para junta mediante generadores existentes. Marca borrador/aprobado, version, fuentes y fecha. No crea un informe contable ni atribuye ejecucion real a una prevision.

## 13. Automatizaciones acotadas

Se incorporan al diseno: copiar estructura, detectar descuadres, completar calendario, calcular cuotas, comparar cambios, localizar dependencias obsoletas y proponer destinatario operativo tras cambios confirmados. Todas deterministas; la confirmacion relevante sigue siendo humana.

No se incorporan ahora: aprobacion automatica, envios, movimientos bancarios, clasificacion juridica de deudas, pronosticos de tesoreria sin fuentes, motor fiscal, IA nueva o reglas por texto ejecutable. No se crea un aviso/tarea por cada guardado: incidencias agrupadas en el presupuesto, sin ruido operativo.

## 14. Decisiones materiales y siguiente paso

Reglas cerradas respetadas: periodicidad por comunidad, sin prorrateo, cargo unico, copropiedad sin division, version aprobada inmutable, dos decimales finales, roles separados, SEPA en ERP 4.

El usuario cierra las decisiones materiales: destinatario segun configuracion vigente a fecha efectiva de emision para recibos no emitidos; destinatario ya emitido protegido frente a cambios automaticos; sin prorrateo; snapshot economico aprobado congelado; regularizacion contra emitido neto y no contra cobrado. Queda sustituida la propuesta anterior de fijar destinatario al inicio programado del periodo.

No queda ninguna decision funcional material pendiente para iniciar ERP 2A. La calidad de fuentes, los permisos concretos de aprobacion y la configuracion de cada comunidad son requisitos de implantacion/puesta en servicio, no alternativas funcionales abiertas. Las decisiones sobre responsabilidad juridica de deuda y mandatos bancarios permanecen en ERP 3/4 y no se resuelven con la eleccion de destinatario.

La autoridad para aprobar se vinculara a permiso economico explicito por comunidad, sin inferirla de poder editar tareas ni del nombre `presidente`. La asignacion de usuarios autorizados sera requisito de puesta en servicio; no exige redisenar perfiles ahora.

El [contrato tecnico](ERP_02_MODELO_CALCULO_CONTRATOS.md) contiene tablas objetivo, invariantes, precision, algoritmos, comandos, dependencias y pruebas de aceptacion. El siguiente trabajo, solo tras autorizacion, es ERP 2A: contratos y migracion aditiva en copia, no comenzar por pantallas ni emitir recibos.
