# Fase 4 - Automatizacion guiada

## Objetivo

Permitir que la IA trabaje con varios asuntos a la vez sin convertirlo en una automatizacion opaca. La app puede dividir un texto largo, preparar propuestas independientes y permitir aplicar solo las seleccionadas despues de revision humana.

## Estado

- Fecha de inicio: 2026-08-27.
- Fecha de cierre del nucleo inicial: 2026-08-27.
- Estado tecnico: 100%.
- Estado funcional: 100% para el alcance inicial.
- Nucleo anterior cerrado: Fase 3 - Memoria y reglas aprendidas.

## Regla principal

La automatizacion guiada no ejecuta nada al analizar.

El flujo obligatorio es:

1. El usuario pega varios asuntos o notas.
2. La app divide el contenido en bloques independientes.
3. La IA prepara una propuesta por bloque.
4. Cada propuesta se muestra como tarjeta editable.
5. El usuario marca o desmarca que propuestas aplicar.
6. La app pide confirmacion final de lote.
7. Solo entonces se aplican las propuestas seleccionadas.
8. Si el usuario lo permite, la app aprende de las correcciones del lote.

## Contratos

### `guided_batch_v1`

Contrato de lote.

Debe cumplir:

- `requires_confirmation = true`;
- `writes_data = false` durante el analisis;
- contiene `total`, `actionable` y `proposals`;
- no guarda datos por si mismo.

### `guided_batch_item_v1`

Contrato de cada propuesta del lote.

Debe cumplir:

- contiene la propuesta individual;
- conserva el texto fuente en `source_text`;
- indica si queda seleccionada por defecto;
- mantiene el contrato de accion individual cuando corresponda.

## Implementado

- Seccion `Automatizacion guiada` dentro del Centro IA.
- Separacion de asuntos por `---`, encabezados o bloques.
- Endpoint `POST /api/ai/batch-operate`.
- Tarjetas editables por propuesta.
- Checkbox por propuesta.
- Aplicacion por lote con confirmacion final.
- Aprendizaje opcional de correcciones del lote.
- Prueba `scripts/assert-ai-guided-automation.mjs`.

## No permitido todavia

- revisar email real;
- enviar comunicaciones;
- clasificar banco automaticamente;
- modificar propietarios;
- ejecutar acciones sensibles sin pantalla especifica;
- aplicar lotes sin confirmacion final.

## Pendiente posterior

Estas ampliaciones se haran cuando entren sus nucleos:

- lotes desde emails;
- lotes desde extractos bancarios;
- lotes desde partes de seguridad;
- lotes desde documentos adjuntos;
- simulacion de impacto antes de aplicar un lote grande;
- cola de aprobacion por usuario.

## Criterio de cierre

Cumplido para el nucleo inicial:

- el usuario puede preparar varias propuestas;
- cada una se puede revisar y editar;
- se puede aplicar solo una seleccion;
- nada se escribe al analizar;
- la memoria de Fase 3 puede aprender de correcciones confirmadas.
