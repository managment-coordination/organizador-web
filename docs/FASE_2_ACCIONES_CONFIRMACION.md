# Fase 2 - Acciones IA con confirmacion

## Objetivo

Convertir el Centro IA en un motor de acciones controladas: la IA puede interpretar un texto, proponer una creacion o actualizacion y preparar los campos, pero nunca debe guardar cambios directamente sin revision humana.

## Estado inicial

- Fecha de inicio: 2026-08-27.
- Porcentaje tecnico de partida: 35%.
- Porcentaje funcional de partida: 25%.
- Nucleo anterior cerrado: Fase 1 - Agente de consulta fiable.

## Regla principal

Toda accion propuesta por IA debe cumplir este flujo:

1. El usuario introduce una instruccion, conversacion, reunion o nota.
2. La IA analiza si corresponde crear tarea, crear proyecto, anadir seguimiento o pedir revision manual.
3. La app muestra una propuesta editable.
4. El usuario revisa y modifica los campos.
5. La app pide confirmacion explicita.
6. Solo entonces se llama al endpoint de escritura correspondiente.
7. La accion queda auditada por el flujo normal de la app.

## Contratos de respuesta

### `query_v1`

Uso: consultas puras.

Debe cumplir:

- `action = "consulta"`;
- `requires_confirmation = false`;
- `writes_data = false`;
- no debe mostrar boton de guardar cambios;
- debe guardar historial de consulta cuando sea posible.

### `editable_confirmation_v1`

Uso: acciones simples y revisables.

Acciones iniciales:

- `crear_tarea`;
- `crear_proyecto`;
- `seguimiento_tarea`;
- `seguimiento_proyecto`.

Debe cumplir:

- `requires_confirmation = true`;
- `writes_data = false` en la respuesta de IA;
- `allowed_write_endpoint` indica el unico endpoint que puede guardar;
- `editable_fields` enumera los campos que el usuario puede revisar;
- la interfaz muestra que nada se ha guardado todavia;
- la escritura solo ocurre tras pulsar aplicar y confirmar.

### `manual_review_v1`

Uso: textos ambiguos, fuera de alcance o consultas escritas en la caja operativa.

Debe cumplir:

- `requires_confirmation = false`;
- `writes_data = false`;
- debe explicar por que no prepara una accion directa;
- si detecta una consulta en la caja operativa, debe orientar al usuario a `Consultas IA`.

## Endpoints

Endpoints de analisis que no deben escribir:

- `POST /api/ai/query`;
- `POST /api/ai/operate`;
- `POST /api/ai/analyze`.

Endpoints que si pueden escribir, siempre despues de confirmacion o formulario:

- `POST /api/entity/record`;
- `POST /api/entity/create`;
- `POST /api/entity/update`;
- otros endpoints especificos de importacion, anexos, seguridad, asambleas o administracion.

## Alcance de esta primera iteracion

Incluido:

- contrato explicito en respuestas IA;
- aviso visible de confirmacion necesaria;
- resumen de impacto previsto antes de aplicar;
- proteccion para que una consulta en la caja operativa no cree cambios;
- prueba estatica de separacion entre IA y escritura.

Pendiente:

- previsualizacion completa antes/despues con valores actuales de base de datos;
- revision por lote de varias acciones propuestas;
- acciones sobre banco, recibos, documentos, email y cambios de titularidad;
- panel de auditoria especifico para acciones IA;
- rollback o compensacion asistida para cambios complejos.

## Criterio de cierre

Esta fase no queda cerrada hasta que:

- las acciones simples funcionen desde web con pantalla editable;
- las consultas no se interpreten como acciones;
- exista prueba automatica de contrato;
- GitHub y servidor Ubuntu esten actualizados;
- el usuario confirme que el flujo le resulta claro.
