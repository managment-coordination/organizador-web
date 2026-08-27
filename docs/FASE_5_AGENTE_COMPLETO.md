# Fase 5 - Agente completo

## Nucleo trabajado

Primer nucleo de Fase 5: entrada conversacional unica para Centro IA.

El objetivo de este nucleo no es que la IA ejecute libremente, sino crear un agente-router seguro que lea una instruccion natural y decida si corresponde a:

- consulta de datos internos;
- accion individual revisable;
- lote de acciones revisables;
- aclaracion necesaria.

## Estado

| Campo | Valor |
| --- | --- |
| Porcentaje anterior tecnico | 0% |
| Porcentaje actual tecnico | 25% |
| Porcentaje anterior funcional | 0% |
| Porcentaje actual funcional | 18% |
| Contrato | `agent_router_v1` |
| Endpoint | `POST /api/agent/message` |
| Escritura operativa directa | No |
| Confirmacion obligatoria | Si, para accion y lote |

## Funcionamiento

El usuario puede escribir en la caja `Agente IA` de Centro IA. El servidor analiza la intencion con `detectAgentIntent()` y deriva la peticion:

- `consulta`: usa `answerAiQuery()` y guarda la respuesta en historial de consultas;
- `accion`: usa `analyzeOperationalWithAi()` y prepara la pantalla editable de Entrada inteligente;
- `lote`: usa `analyzeGuidedAutomationBatch()` y prepara tarjetas editables en Automatizacion guiada;
- `aclaracion`: no prepara cambios y pide al usuario concretar.

## Garantias

- El agente no llama directamente a endpoints de escritura operativa.
- Las acciones se siguen aplicando solo desde `/api/entity/record` o `/api/entity/create` despues de confirmacion manual.
- El acceso queda limitado a perfiles `Superusuario`, `Administrador` y `Usuario`.
- El perfil Presidente y el perfil Seguridad no reciben este agente operativo en esta fase.
- El flujo reutiliza las piezas ya probadas de Fase 2, Fase 3 y Fase 4.

## Pendiente de Fase 5

1. Conversaciones con memoria contextual de sesion.
2. Catalogo explicito de herramientas internas por modulo.
3. Respuestas del agente con pasos sugeridos y preguntas de aclaracion mas ricas.
4. Ejecucion guiada de herramientas avanzadas: informes, asambleas, contabilidad, seguridad y documentos.
5. Modo auditor: diferenciar dato confirmado, inferencia, recomendacion, riesgo y accion propuesta.
6. Conectores externos en modo propuesta, especialmente email/Outlook, sin ejecucion automatica inicial.

## Ramificaciones detectadas

No se abre ninguna ramificacion nueva en este nucleo. El siguiente paso natural es catalogar herramientas internas por modulo para que el agente pueda decidir no solo entre consulta/accion/lote, sino entre operaciones concretas de tareas, proyectos, contabilidad, asambleas, seguridad, documentos y proveedores.
