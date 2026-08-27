# Fase 5 - Agente completo

## Nucleo trabajado

Primeros nucleos de Fase 5: entrada conversacional unica para Centro IA y catalogo de herramientas internas por modulo.

El objetivo de este nucleo no es que la IA ejecute libremente, sino crear un agente-router seguro que lea una instruccion natural y decida si corresponde a:

- consulta de datos internos;
- accion individual revisable;
- lote de acciones revisables;
- aclaracion necesaria.

## Estado

| Campo | Valor |
| --- | --- |
| Porcentaje anterior tecnico | 0% |
| Porcentaje actual tecnico | 40% |
| Porcentaje anterior funcional | 0% |
| Porcentaje actual funcional | 28% |
| Contrato | `agent_router_v1` |
| Endpoint | `POST /api/agent/message` |
| Catalogo | `agent_tool_catalog_v1` |
| Endpoint de catalogo | `GET /api/agent/tools` |
| Escritura operativa directa | No |
| Confirmacion obligatoria | Si, para accion y lote |

## Funcionamiento

El usuario puede escribir en la caja `Agente IA` de Centro IA. El servidor analiza la intencion con `detectAgentIntent()` y deriva la peticion:

- `consulta`: usa `answerAiQuery()` y guarda la respuesta en historial de consultas;
- `accion`: usa `analyzeOperationalWithAi()` y prepara la pantalla editable de Entrada inteligente;
- `lote`: usa `analyzeGuidedAutomationBatch()` y prepara tarjetas editables en Automatizacion guiada;
- `aclaracion`: no prepara cambios y pide al usuario concretar.

Ademas, el agente selecciona una herramienta interna mediante `selectAgentTool()` y devuelve:

- herramienta elegida;
- modulo;
- estado `active` o `planned`;
- endpoint interno, cuando existe;
- si requiere confirmacion;
- limitacion cuando la herramienta todavia no esta disponible.

Si la herramienta adecuada esta planificada pero aun no es segura, el agente no fuerza la peticion por otro camino. Devuelve aclaracion y explica que falta implementar.

## Garantias

- El agente no llama directamente a endpoints de escritura operativa.
- Las acciones se siguen aplicando solo desde `/api/entity/record` o `/api/entity/create` despues de confirmacion manual.
- El acceso queda limitado a perfiles `Superusuario`, `Administrador` y `Usuario`.
- El perfil Presidente y el perfil Seguridad no reciben este agente operativo en esta fase.
- El flujo reutiliza las piezas ya probadas de Fase 2, Fase 3 y Fase 4.
- El catalogo separa herramientas activas y planificadas para no confundir una solicitud de email, conciliacion bancaria o cambio de titularidad con una tarea comun.

## Pendiente de Fase 5

1. Conversaciones con memoria contextual de sesion.
2. Respuestas del agente con pasos sugeridos y preguntas de aclaracion mas ricas.
3. Ejecucion guiada de herramientas avanzadas: informes, asambleas, contabilidad, seguridad y documentos.
4. Modo auditor: diferenciar dato confirmado, inferencia, recomendacion, riesgo y accion propuesta.
5. Conectores externos en modo propuesta, especialmente email/Outlook, sin ejecucion automatica inicial.
6. Convertir herramientas planificadas en flujos seguros uno a uno.

## Ramificaciones detectadas

No se abre ninguna ramificacion nueva en este nucleo. El siguiente paso natural es memoria contextual de conversacion y respuestas mas guiadas: que el agente mantenga el hilo de lo hablado en una sesion sin convertirlo en reglas permanentes automaticamente.
