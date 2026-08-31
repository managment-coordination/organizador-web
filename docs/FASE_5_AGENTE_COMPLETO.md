# Fase 5 - Agente completo

## Nucleo trabajado

Primeros nucleos de Fase 5: entrada conversacional unica para Centro IA, catalogo de herramientas internas por modulo, memoria contextual de conversacion, respuestas guiadas, primera herramienta avanzada de documentos/informes, aviso de vigencia para datos economicos y primer flujo de email en modo propuesta.

El objetivo de este nucleo no es que la IA ejecute libremente, sino crear un agente-router seguro que lea una instruccion natural y decida si corresponde a:

- consulta de datos internos;
- accion individual revisable;
- lote de acciones revisables;
- informe Word revisable;
- borrador de email revisable;
- aclaracion necesaria.

## Estado

| Campo | Valor |
| --- | --- |
| Porcentaje anterior tecnico | 0% |
| Porcentaje actual tecnico | 80% |
| Porcentaje anterior funcional | 0% |
| Porcentaje actual funcional | 66% |
| Contrato | `agent_router_v1` |
| Endpoint | `POST /api/agent/message` |
| Catalogo | `agent_tool_catalog_v1` |
| Endpoint de catalogo | `GET /api/agent/tools` |
| Contexto | `agent_context_v1` |
| Tabla de contexto | `ia_contexto_conversacion` |
| Respuesta guiada | `agent_guidance_v1` |
| Preparacion de informe | `agent_report_prepare_v1` |
| Borrador de email | `email_draft_v1` |
| Vigencia economica | `freshness` en respuestas de deuda, contabilidad y presupuesto |
| Endpoint documental | `POST /api/agent/documents/query` |
| Endpoint preparar informe | `POST /api/agent/report/prepare` |
| Endpoint preparar email | `POST /api/agent/email/draft` |
| Escritura operativa directa | No |
| Confirmacion obligatoria | Si, para accion, lote, informe y email |

## Funcionamiento

El usuario puede escribir en la caja `Agente IA` de Centro IA. El servidor analiza la intencion con `detectAgentIntent()` y deriva la peticion:

- `consulta`: usa `answerAiQuery()` y guarda la respuesta en historial de consultas;
- `accion`: usa `analyzeOperationalWithAi()` y prepara la pantalla editable de Entrada inteligente;
- `lote`: usa `analyzeGuidedAutomationBatch()` y prepara tarjetas editables en Automatizacion guiada;
- `informe`: prepara una propuesta de informe Word sobre tarea/proyecto y solo genera el archivo al confirmar;
- `email`: prepara un borrador editable dentro de la app, reutilizando las consultas fiables de deuda/propietarios cuando proceda;
- `aclaracion`: no prepara cambios y pide al usuario concretar.

Ademas, el agente selecciona una herramienta interna mediante `selectAgentTool()` y devuelve:

- herramienta elegida;
- modulo;
- estado `active` o `planned`;
- endpoint interno, cuando existe;
- si requiere confirmacion;
- limitacion cuando la herramienta todavia no esta disponible.

Si la herramienta adecuada esta planificada pero aun no es segura, el agente no fuerza la peticion por otro camino. Devuelve aclaracion y explica que falta implementar.

El contexto conversacional se guarda en una tabla independiente llamada `ia_contexto_conversacion`. Este contexto:

- pertenece al usuario activo;
- conserva los turnos recientes del Agente IA;
- puede vaciarse desde Centro IA;
- se usa solo cuando la nueva instruccion depende claramente de lo anterior;
- no crea reglas permanentes ni cambia criterios de redaccion.

La respuesta guiada usa el contrato `agent_guidance_v1`. Cada respuesta del agente puede separar:

- datos confirmados;
- inferencias;
- riesgos;
- dudas pendientes;
- campos o decisiones que conviene revisar;
- siguientes acciones posibles.

Esta capa no inventa datos nuevos: organiza la respuesta generada por las herramientas internas y eleva las advertencias para que sean visibles.

La herramienta de documentos e informes queda activa en dos niveles:

- `documents.lookup` y `reports.lookup`: consultan anexos e informes visibles por rol y comunidad, sin guardar cambios.
- `reports.generate.entity`: prepara el destino de un informe Word sobre tarea o proyecto; el archivo se crea despues en `/api/report/generate` solo si el usuario confirma.

Las consultas economicas incorporan ahora un aviso de vigencia. Cuando el agente responde sobre deuda, contabilidad o presupuesto, calcula la fecha maxima disponible en las fuentes usadas, por ejemplo recibos Netfincas, movimientos de deuda, gastos/facturas, extractos bancarios o informes contables. La respuesta muestra una advertencia del tipo: datos disponibles hasta una fecha concreta y necesidad de comprobar si hay nuevas descargas de Netfincas o banco posteriores.

El flujo de email queda activado solo como propuesta interna. En esta primera version cubre especialmente comunicaciones de deuda y recibos pendientes: localiza el propietario, busca el email principal si existe, consulta la deuda con el mismo motor fiable de Centro IA, redacta asunto y cuerpo formal, incluye aviso de vigencia de datos y ofrece copiar el cuerpo o el email completo. No crea borradores en Outlook, no envia correos y no guarda cambios.

## Garantias

- El agente no llama directamente a endpoints de escritura operativa.
- Las acciones se siguen aplicando solo desde endpoints finales despues de confirmacion manual: `/api/entity/record`, `/api/entity/create` o `/api/report/generate`.
- El email queda limitado a borrador editable: `/api/agent/email/draft` no envia, no crea borradores externos y no escribe datos.
- El acceso queda limitado a perfiles `Superusuario`, `Administrador` y `Usuario`.
- El perfil Presidente y el perfil Seguridad no reciben este agente operativo en esta fase.
- El flujo reutiliza las piezas ya probadas de Fase 2, Fase 3 y Fase 4.
- El catalogo separa herramientas activas y planificadas para no confundir una solicitud de email, conciliacion bancaria, informe o cambio de titularidad con una tarea comun.
- El contexto conversacional queda separado de `ia_reglas`, que sigue siendo la memoria permanente confirmada.
- Las respuestas guiadas ayudan a distinguir lo seguro de lo dudoso antes de consultar, crear o actualizar.
- Las respuestas economicas no se presentan como datos absolutos actuales sin indicar hasta que fecha llegan las fuentes importadas.

## Pendiente de Fase 5

1. Ejecucion guiada de herramientas avanzadas restantes: asambleas, contabilidad, seguridad, Outlook real y documentos con lectura profunda.
2. Modo auditor mas profundo para decisiones sensibles: legal, economico, administrativo y operativo.
3. Conectores externos en modo propuesta real, especialmente Outlook, sin ejecucion automatica inicial.
4. Convertir herramientas planificadas en flujos seguros uno a uno.
5. Mejorar la comprension semantica de instrucciones dependientes de contexto.
6. Crear acciones sugeridas clicables cuando exista herramienta segura.

## Ramificaciones detectadas

No se abre ninguna ramificacion nueva en este nucleo. El siguiente paso natural confirmado es conciliacion bancaria revisable.
