# Titularidades, coeficientes y grupos de reparto

Contrato de diseno, 10/09/2026. Su implantacion ERP 1 se documenta en [evidencia de cierre](ERP_01_DATOS_MAESTROS_IMPLEMENTACION.md). [Modelo maestro](ERP_MODELO_DATOS_MAESTROS.md) | [Roadmap](ERP_COMUNIDADES_ROADMAP.md). No implementa el motor de reparto de ERP 2.

## Cuatro conceptos independientes

1. Titularidad: quien posee una propiedad, en que proporcion y durante que intervalo.
2. Coeficiente: valor exacto que representa participacion o peso para un contexto definido; no siempre suma 100 ni tiene el mismo significado en todos los grupos.
3. Grupo/regla de reparto: a quienes se reparte un importe y con que criterio aprobado.
4. Obligacion/cobro: quien debe un recibo y quien lo paga. No se deriva automaticamente del titular actual ni del porcentaje de dominio.

Un 50% de copropiedad NO significa automaticamente pagar el 50% de cada recibo. Un 2% de participacion comunitaria NO equivale a 2% de propiedad sobre la vivienda. Un grupo presupuestario de gasto NO es necesariamente un grupo de reparto ni una cuenta PGC. La cuenta de origen Netfincas puede clasificar una partida, pero no dicta su naturaleza contable.

## Titularidades: evolucion del modelo real

Fuente actual: `cf_propietario_propiedad(id_relacion,id_propietario,id_propiedad,fecha_desde,fecha_hasta,activo,porcentaje_titularidad,motivo,id_importacion_origen,id_comunidad)`. Existe N:M; faltan precision exacta, validacion de intervalos y distincion entre dato importado y confirmado.

Propuesta: conservar la identidad `id_relacion` y referencias existentes. Introducir revisiones append-only `erp_titularidad_versiones`, de modo que una correccion no destruya lo que se conocia antes. La proyeccion legacy solo sirve a lectores antiguos mientras se migran; no queda como segundo escritor.

| Campo en version | Regla |
|---|---|
| id_version, id_relacion, id_comunidad | identidad tecnica, FK compatible y alcance obligatorio |
| id_propiedad, id_propietario | FK compuesta de misma comunidad; no texto libre |
| porcentaje_titularidad | decimal exacto 0 < p <= 100 para participaciones validadas; NULL si desconocido en staging |
| efectiva_desde, efectiva_hasta | fechas de vigencia, extremo final exclusivo; NULL inicio significa desconocido, no "desde siempre" |
| calidad | propuesta / pendiente_documentacion / validada / observada |
| anulada, motivo | anulacion de una version erronea no elimina evidencia ni cargo historico |
| registrada_en, id_usuario, origen | fecha de conocimiento UTC, actor y proceso |
| id_version_sustituida, id_operacion | cadena de correcciones y transaccion que agrupa el cambio |
| documento_version / importacion_fila | prueba de origen, puede faltar pero queda pendiente |
| version_concurrencia | impide aplicar vista previa desactualizada |

La finita lista de estados es propuesta de contrato, ampliable mediante revision del contrato. Una titularidad finalizada es valida historicamente; no se oculta por desactivar al propietario.

### Tiempo efectivo y tiempo de conocimiento

Usar intervalos `[desde, hasta)`. Ejemplo: venta efectiva 01/07, antiguo titular hasta 01/07, nuevo desde 01/07. Si un documento usa ultimo dia incluido, la importacion convierte expresamente el formato y conserva la fecha original. No asumir que `fecha_hasta` legacy ya sigue esta convencion.

La consulta a fecha T usa las versiones conocidas actualmente cuyos intervalos incluyen T. Una consulta historica "tal como se sabia en K" limita las versiones a registrada_en <= K y resuelve sustituciones solo conocidas en K. No mezclar ambos informes. Una correccion retroactiva cambia la lectura actual del pasado, pero no reescribe recibos, actas ni informes ya emitidos.

Inicio desconocido: conservar referencia a fecha de observacion del fichero. Responder "consta en la fuente de fecha X; fecha de adquisicion no acreditada". No inferir toda la historia anterior. Fin nulo en version validada significa abierto; inicio nulo mantiene incertidumbre y no puede usarse para prorrateos historicos como si fuera preciso.

### Invariantes de validacion

- fin > inicio cuando ambas conocidas; propiedad y titular deben existir en misma comunidad.
- Solapamiento entre propietarios distintos es permitido y necesario para copropiedad. No imponer exclusividad de un solo titular.
- Para la misma propiedad y el mismo titular no se permiten dos participaciones validadas solapadas dentro de la misma composicion; consolidar documentalmente o resolver conflicto antes de publicar.
- Para cada tramo temporal completo validado, la suma de porcentajes de todos los titulares es exactamente 100 con la precision elegida. Comprobar todos los puntos de cambio, no solo la fecha de hoy.
- Una composicion incompleta puede conservarse como observada, nunca declararse completa ni corregirse repartiendo artificialmente el faltante. Suma mayor de 100 bloquea validacion; menor de 100 exige completar o mantener observada. Cero no sustituye desconocido.
- Laguna entre titulares: visible como cobertura desconocida, no se atribuye al anterior por arrastre. Para operar sobre esa fecha se exige criterio/evidencia o excepcion explicita del dominio correspondiente.
- Copropiedad exige porcentajes documentados. Tres importados con valor por defecto 100 generan conflicto; no se convierten automaticamente en tercios.
- La confirmacion valida la composicion final dentro de una unica transaccion. Cerrar anteriores y abrir sucesores no deja un estado intermedio persistido de 0%/200%.
- Reintento con misma idempotency_key devuelve el resultado original. Version obsoleta exige recargar. En SQLite usar transaccion de escritura serializada para validar+guardar sin carrera; las CHECK simples no bastan para sumas temporales.

### Cambio de titularidad y deuda

Flujo futuro: seleccionar propiedad -> evidencia/fecha -> titulares y proporciones nuevas -> mostrar composicion anterior, conflictos y recibos vinculados -> revision -> confirmar solo titularidad.

La operacion NO mueve deudas. Conserva id_propietario/id_propiedad y texto original en recibos historicos. Si se solicita otro tratamiento, crear propuesta independiente de reasignacion/compensacion con recibos e importes concretos, motivo, documentacion, autorizacion y efecto contable; ERP 3 definira el criterio. No trasladar al nuevo propietario la deuda completa de la finca por defecto. Deudores antiguos permanecen consultables aunque ya no tengan propiedades.

Nombre importado conjunto: conservar ID compuesto hasta verificacion; el posterior desdoblamiento crea correspondencias a personas y composicion validada. No redistribuir historicamente cargos del registro compuesto sin decision documentada.

## Grupos configurables y coeficientes

No convertir `cf_propiedades.grupo` directamente en grupo economico. El primero es una etiqueta heredada. `cf_propiedades.coeficiente REAL` solo es una fuente inicial; hay que conocer su escala, contexto y fecha antes de publicarlo como coeficiente general.

### Entidades propuestas

| Entidad | Contenido y cardinalidad |
|---|---|
| `erp_grupos_reparto` | id, comunidad, codigo/nombre configurables, finalidad, estado; 1:N versiones |
| `erp_grupo_versiones` | grupo, vigencia, base (porcentaje/peso), suma esperada si procede, tolerancia de importacion, criterio documental, estado, evidencia y aprobacion |
| `erp_grupo_miembros` | identidad de pertenencia grupo-propiedad, mismo tenant; 1:N versiones |
| `erp_grupo_miembro_versiones` | vigencia, participa/excluida, motivo, documento y registro de conocimiento; coeficiente NULL no equivale a exclusion |
| `erp_coeficiente_series` | propiedad, grupo y finalidad (general, especial, etc. como catalogo), unidad/escala; no un unico campo por propiedad |
| `erp_coeficiente_versiones` | serie, vigencia, valor exacto, original/precision, fuente, calidad, registrada_en, sustituye y actor |
| `erp_reglas_reparto_versiones` | tipo, parametros tipados, unidades/base, vigencia/aprobacion; nuevas formulas requieren servicio versionado, no eval de texto |
| `erp_partida_repartos` (ERP 2) | partida/version presupuesto, grupo/version, regla/version, fraccion o importe de asignacion, fechas/corte |

Porcentajes generales tambien se representan como serie documentada; el grupo por defecto se configura por comunidad. No generar automaticamente grupos GENERAL/JARDINERIA/etc. como imposicion universal. Una propiedad puede participar en varios y usar valores distintos. Tipos mixtos reutilizan subreglas conocidas, nunca codigo proporcionado por IA.

### Reglas temporales de grupos

- No solapar versiones publicadas del mismo grupo o serie. Varias series con finalidades distintas se permiten, pero la regla debe seleccionar una explicitamente.
- Pertenencia y coeficiente son independientes: un grupo por partes iguales no necesita coeficiente; una propiedad excluida puede conservar un coeficiente historico.
- Un miembro participante en regla por coeficiente debe tener exactamente un valor vigente de la serie requerida en fecha de corte. Ausencia o multiples valores bloquean el calculo, no se sustituyen por cero.
- Alta/baja cambia vigencia de pertenencia, no borra el historial. Desactivar un grupo no invalida snapshots anteriores.
- Si base porcentaje con total declarado, validar total y precision antes de aprobar. Si base pesos, se normaliza por suma de pesos positivos segun regla; no exigir que sumen 100. Base desconocida bloquea aprobacion.
- Tolerancia de importacion permite avisar sobre una discrepancia, no autoriza reescribir el coeficiente ni afirmar suma exacta. Normalizacion, si se elige, debe ser una regla aprobada y visible en el snapshot.
- Grupos distintos pueden compartir miembros. Evitar doble cargo a nivel asignacion de partida: suma de fracciones = 100% o suma de importes = importe distribuible, con eventual residuo explicito aprobado.
- Grupo vacio, suma pesos cero, exclusion total, coeficiente negativo o version sin aprobar: no emitir cuota; mostrar causa concreta.
- Anexo y propiedad principal no se agregan automaticamente. Regla identifica unidad facturable; si se agrupan, snapshot registra los componentes y evita facturarlos otra vez por separado.

## Reglas futuras del motor (solo contrato)

| Tipo | Dato necesario | Control |
|---|---|---|
| Coeficiente | valor vigente y base/denominador | reparto proporcional con suma verificable |
| Partes iguales | conjunto de unidades participantes a corte | unidad es propiedad/agrupacion pactada, no numero accidental de titulares |
| Importe fijo | importe por unidad y periodo | total compatible con asignacion o diferencia explicita |
| Unidades | cantidad, unidad y tarifa/importe base | cantidad exacta, misma dimension |
| Consumo | lecturas inicial/final, periodo, contador/unidad | evidencia, reinicios y faltantes revisados, no inventar lectura |
| Porcentaje especial | serie especial validada | no reutilizar coeficiente general sin orden |
| Mixta | subreglas, importes/fracciones y orden | sin ciclos, componentes cuadran y no duplican cargos |

Cuota ordinaria mensual por coeficiente se conserva como caso de uso ya acordado, no unica regla posible. Partida presupuestaria mantiene categoria propia y puede tener asignaciones a varios grupos. Referencia PGC independiente; no codificar cuenta 603003 como si fuera una cuenta financiera validada.

Actualizacion de diseno ERP 2: el usuario cierra ausencia de prorrateo y cargo operativo unico sin division por copropiedad. Destinatario y pagador se configuran separadamente de titularidad. Las politicas confirmadas (destinatario vigente a fecha efectiva de emision para pendientes, emitidos protegidos, snapshot economico congelado y regularizacion contra emitido neto) se mantienen en [ERP 2 - producto](ERP_02_PRESUPUESTOS_CUOTAS_DISENO.md); algoritmos, precision real implementada en ERP 1 (escala hasta 30) y snapshots en [contrato ERP 2](ERP_02_MODELO_CALCULO_CONTRATOS.md). Diseno cerrado; no modifica el dominio ERP 1 ni implementa el motor.

## Precision y redondeo

Propuesta tecnica reversible antes de migrar: cantidades monetarias finales en unidades menores enteras (EUR: centimos), moneda explicita; calculos intermedios Decimal de al menos 38 digitos. Porcentajes, coeficientes, cantidades y factores como cadenas decimales canonicas de hasta 12 decimales, procesadas con Decimal; no `REAL`, floats JS ni JSON number para estos valores. En SQLite TEXT validado por servicio/constraints; si cambia el motor, equivalente NUMERIC exacto sin alterar contrato.

Un porcentaje 2.345600 se conserva con valor decimal exacto y precision original por separado. Coeficiente en tanto por uno, porcentaje o peso requiere unidad; 0.023456 y 2.3456 no se intercambian sin conversion explicita. Porcentaje de dominio en escala 0-100, factores de reparto con su base especifica.

No limitar importaciones a 12 decimales truncando silenciosamente: si la fuente supera escala o capacidad, conservar texto original y bloquear publicacion hasta ampliar precision o aprobar ajuste. Los `REAL` existentes no permiten recuperar automaticamente cifras perdidas: contrastar exportacion original y cuantificar diferencias por comunidad antes de migrar.

Propuesta de redondeo para ERP 2, sujeta a aprobacion de politica: calcular importes exactos, truncar magnitudes a centimos y repartir residuo por mayores restos, desempate estable por ID de propiedad. Aplicar signo al final para abonos/regularizaciones. Ejemplo sintetico 100 EUR entre tres unidades iguales: 33,34 + 33,33 + 33,33; registrar quien recibio el centimo y por que. Suma final igual al importe objetivo; ninguna correccion oculta.

No usar ese metodo universalmente: importes fijos, tarifas e impuestos pueden requerir reglas distintas segun contrato; parametrizar y aprobar por regla. No corregir porcentajes de titularidad con el reparto de centimos. Presupuesto anual y cuotas mensuales deben cuadrar tambien entre periodos: registrar residuo anual y su asignacion, no redondear doce veces sin conciliacion.

## Snapshot de calculo y evidencia

Cada simulacion/aprobacion futura conserva presupuesto/version, comunidad, ejercicio/periodo, fecha de corte, versiones de regla/grupo/pertenencia/coeficiente, propiedades y titulares observados (con calidad), entradas exactas, resultado sin redondear, importe final, residuo, ajustes manuales y motivos, documentos de aprobacion, actor/UTC y version del motor.

No depender de resolver "coeficiente actual" cuando se vuelve a abrir un reparto antiguo. Recalcular con nuevas condiciones crea otra version, no actualiza la emitida. `cf_reparto_lineas` ya contiene coeficiente_usado/importe_final: ampliar con referencias/snapshot, no perder sus importes historicos. Para varios titulares, enlazar la composicion al snapshot; el unico `id_propietario` antiguo permanece como dato legado, no selecciona arbitrariamente al primero.

Asamblea: preservar censo/votos y coeficientes de esa celebracion. El nuevo maestro puede proponer censo para una futura asamblea, pero no recalcula quorums o votos pasados al cambiar una titularidad. Votos por propietario/representacion pertenecen al dominio asamblea; no usar numero de propiedades o cuotas como numero de votos sin su logica vigente.

## Migracion futura y casos de aceptacion

Solo diseno. Checkpoint de codigo y copia independiente consistente de datos/documentos antes de ejecutar; detalle en roadmap. Inventariar FKs/consumidores, perfiles y normas de fecha del origen. Staging preserva IDs/textos y marca dudas; no dar de baja por ausencia de un export parcial. Confirmar conjunto atomico, ofrecer resumen de cambios y reproducir consultas anteriores mediante adaptadores.

Casos que deberan probarse en una copia, no ejecutados en esta entrega:

| Caso sintetico | Resultado exigido |
|---|---|
| A posee P y Q | dos relaciones, una identidad; ninguna agregacion indebida de coeficientes |
| A/B 60/40 en P | composicion valida; misma vivienda no se cuenta dos veces al repartir por propiedad |
| Venta A a B el 01/07 | consulta 30/06=A, 01/07=B; deuda anterior conserva obligado |
| B60/C50 con solapamiento | bloqueo de validacion por 110%, sin corregir a prorrata |
| 50% conocido y resto desconocido | conservado como incompleto, sin titular ficticio |
| Dos ficheros repiten el mismo hecho | misma referencia de origen, no doble relacion ni doble cargo |
| Correccion conocida en agosto con efecto junio | reconstruccion efectiva y conocida-en distinguidas; recibos viejos intactos |
| Venta sin fecha acreditada | observacion a fecha del archivo, consulta anterior declara incertidumbre |
| P con coeficiente general 1 y garajes 5 | cada partida usa su grupo/serie; no sobrescribir uno con otro |
| P sale de garajes a mitad de periodo | resultado segun politica temporal pendiente de confirmar, no prorrateo implicito |
| Codigo P repetido en dos comunidades | IDs/relaciones separados; usuario no ve la otra comunidad |
| Anexo P-G con participacion propia | evitar doble imputacion al agrupar; snapshot explica componentes |
| Ajuste de reparto ya emitido | nueva version/regularizacion con motivo, no borrar linea original |
| Dos usuarios confirman misma vista previa | una operacion idempotente o conflicto de version; nunca doble escritura |

## Verificacion documental de esta entrega

Comunidad, agrupacion, propiedad, persona y titularidad estan separadas. Hay copropiedad, tiempo efectivo/conocido, grupos configurables, multiples coeficientes, precision exacta y redondeo propuesto. Se preservan deuda y snapshots, auditoria y documentos. Las formulas no dependen de LLM. No se ha ejecutado motor, migracion ni prueba economica de negocio; este apartado verifica cobertura del diseno, no certifica implementacion.
