# Fase 3 - Memoria controlada y reglas aprendidas

## Objetivo

Crear una memoria util pero controlada para que el agente mejore con el uso sin inventar ni automatizar errores. La app debe aprender criterios confirmados por Luis, Elena u otros perfiles autorizados y usarlos para proponer mejor, no para actuar sin supervision.

## Estado inicial

- Fecha de inicio: 2026-08-27.
- Porcentaje tecnico de partida: 5%.
- Porcentaje funcional de partida: 5%.
- Nucleo anterior cerrado: Fase 2 - Acciones IA con confirmacion.

## Estado de cierre del nucleo inicial

- Fecha de cierre: 2026-08-27.
- Estado tecnico: 100%.
- Estado funcional: 100% para el alcance inicial.
- Alcance cerrado: memoria persistente, panel visible, aprendizaje de correcciones de redaccion, aplicacion de reglas en propuestas y pruebas automaticas.

## Problema que resuelve

Ahora la IA ya separa consultas y acciones, y exige confirmacion antes de guardar. El siguiente salto es que aprenda de las correcciones:

- como redactar mejor titulos de tareas nuevas;
- como convertir transcripciones en comentarios formales;
- como proponer proximos pasos realmente operativos;
- que proveedor suele corresponder a un tipo de incidencia;
- que idioma prefiere cada propietario;
- que movimiento bancario suele pertenecer a que propietario o recibo;
- que categoria presupuestaria o contable suele corresponder a un proveedor.

## Regla principal

La memoria nunca debe ser invisible ni absoluta.

Toda regla aprendida debe tener:

- descripcion clara;
- modulo afectado;
- tipo de regla;
- valor detectado;
- valor propuesto;
- nivel de confianza;
- usuario que la confirma;
- fecha de confirmacion;
- estado activo/inactivo;
- trazabilidad de origen.

## Primer alcance

### 1. Memoria de redaccion operativa

Prioridad inmediata por observacion del usuario al cerrar Fase 2.

Debe aprender:

- estructura preferida para titulos de tareas;
- estructura preferida para comentarios de seguimiento;
- estructura preferida para proximos pasos;
- tono formal y administrativo;
- separacion entre hecho detectado, riesgo, decision y proximo paso.

Ejemplo de salida esperada:

```text
Titulo:
Arqueta con riesgo de obstruccion en villa 90

Comentario:
Se recibe aviso sobre una arqueta situada en la puerta de la villa 90. Segun la informacion trasladada, existen raices que estan obstruyendo parcialmente la salida del tubo. El jardinero ha revisado la incidencia, pero no ha intervenido por el riesgo de que el material retirado caiga al fondo de la arqueta y provoque una obstruccion aguas abajo.

Proximo paso:
Coordinar revision sobre el terreno con jardineria o proveedor especializado, valorar la retirada controlada de las raices y confirmar la actuacion necesaria para evitar la obstruccion.
```

### 2. Memoria de preferencias por propietario

Debe aprender solo tras confirmacion:

- idioma preferente;
- email principal;
- telefono util;
- si prefiere comunicaciones formales, cortas o bilingues.

### 3. Memoria de conciliacion y contabilidad

Debe aprender:

- patron de concepto bancario;
- propietario o propiedad probable;
- proveedor probable;
- grupo presupuestario;
- cuenta PGC traducida;
- reglas de excepcion.

### 4. Memoria de proveedores

Debe aprender:

- proveedor habitual por tipo de incidencia;
- categoria;
- calidad observada;
- referencias internas;
- problemas recurrentes;
- proveedor alternativo.

## Flujo obligatorio

1. La IA propone una regla nueva o una mejora de redaccion.
2. El usuario la corrige o la confirma.
3. La app guarda la regla como activa solo si hay confirmacion.
4. En futuras propuestas, la IA puede usar la regla y debe indicar que la ha usado.
5. El usuario puede editar, desactivar o borrar la regla.

## No permitido en esta fase

- ejecutar acciones automaticas por memoria sin confirmacion;
- aprender reglas sensibles sin aprobacion;
- modificar datos maestros directamente;
- enviar emails;
- cambiar titularidades;
- asignar cobros;
- crear asientos definitivos.

## Primer criterio de cierre parcial

Fase 3 podra considerarse al 40% cuando exista:

- tabla o estructura persistente de reglas IA;
- panel minimo para ver/desactivar reglas;
- guardado de correcciones de titulo, comentario y proximo paso;
- aplicacion de esas reglas en la entrada inteligente;
- prueba automatica de que una regla no ejecuta cambios sin confirmacion.

Resultado: cumplido y ampliado al alcance inicial completo. La fase queda cerrada como primer nucleo de memoria controlada. Las memorias especificas de propietario, banco, proveedores o contabilidad se desarrollaran cuando entren sus nucleos funcionales, usando esta misma estructura.

## Implementado

- Tabla `ia_reglas`.
- Acciones internas: listar, aprender redaccion, actualizar/desactivar y marcar uso.
- Panel `Memoria IA` dentro del Centro IA.
- Checkbox visible para aprender de correcciones al aplicar una propuesta.
- Registro de reglas para `redaccion_titulo`, `redaccion_comentario` y `redaccion_proximo_paso`.
- Aplicacion de reglas solo sobre acciones que ya requieren confirmacion.
- Trazabilidad de reglas usadas mediante `used_rules` y contador de usos.

## Pruebas

- `node scripts/assert-ai-memory.mjs`.
- `node scripts/assert-ai-action-contract.mjs`.
- `node scripts/assert-ai-query.mjs`.
- `npm run check`.

## Ramificacion registrada

Ramificacion: mejorar la calidad de titulo, comentario y proximo paso.

Origen: validacion funcional de Fase 2.

Decision: hacer dentro de Fase 3 como primer subnucleo, porque depende de memoria/correcciones confirmadas y no solo de ajustar una plantilla fija.
