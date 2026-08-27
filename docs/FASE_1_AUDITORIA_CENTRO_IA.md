# Fase 1 - Auditoria inicial del Centro IA

Fecha: 2026-08-26.

## Estado de partida

- Nucleo: Fase 1 - Agente de consulta fiable.
- Porcentaje anterior: 30%.
- Porcentaje tras esta auditoria: 35%.
- Alcance de este avance: lectura de codigo, rutas, separacion funcional, historial y fuentes internas.
- Produccion: no modificada.
- Datos reales: no modificados.

## Estructura actual detectada

### Rutas del backend

El backend ya separa varias rutas de IA:

- `POST /api/ai/query`: consulta de solo lectura.
- `POST /api/ai/operate`: preparacion de accion operativa.
- `POST /api/ai/analyze`: analisis general con posible propuesta operativa.
- `GET /api/ai/history`: historial personal de consultas.
- `POST /api/ai/history/action`: borrar una consulta o vaciar historial personal.

### Funciones principales

- `answerAiQuery(session, text)`: fuerza el resultado final a `action: "consulta"` y guarda historial.
- `analyzeOperationalWithAi(session, text)`: si detecta consulta dentro de entrada operativa, evita guardar cambios y devuelve `revisar_manual`.
- `analyzeWithAi(session, text, target)`: combina seguimiento dirigido, asistente local, clasificador local e IA externa opcional.
- `querySmartAssistant(session, text)`: consulta local de datos estructurados con Python embebido.
- `localAiProposal(text, context)`: clasificador local para tareas/proyectos/consultas/incidencias.
- `externalAiProposal(text, context)`: proveedor externo compatible con OpenAI/NVIDIA.
- `runAiHistoryCommand(...)` y `server/ai-history.py`: historial de consultas por usuario.

## Separacion consulta / accion

Lo que ya esta bien:

- La interfaz tiene dos cajas distintas: `Consultas IA` y `Entrada inteligente`.
- La consulta se guarda en historial.
- La entrada operativa no guarda directamente; prepara propuesta revisable.
- Si una consulta entra por la caja operativa, se redirige a revision manual.
- La respuesta de consulta puede mostrar tarjetas, tablas, notas y exportacion CSV.

Riesgos detectados:

- `POST /api/ai/analyze` no tiene la misma restriccion de rol que `/api/ai/operate`; aunque no guarda por si sola, puede devolver propuestas operativas a perfiles no previstos si se invoca directamente.
- `querySmartAssistant` mezcla varias familias de consulta en una funcion grande; esto dificulta controlar fuentes, permisos y formato por modulo.
- La respuesta no tiene todavia un bloque obligatorio de fuentes internas, limitaciones y nivel de dato confirmado/inferido.
- Algunas consultas de trabajo operativo usan SQL directo y no aplican filtro de comunidad de forma visible en el bloque revisado.
- Las consultas de contabilidad/deuda funcionan como bloque comun y no queda explicitado si pertenecen solo a Macrocomunidad o si deben filtrar por comunidad.

## Fuentes internas detectadas

### Propietarios y propiedades

Tablas usadas:

- `cf_propietarios`
- `cf_propiedades`
- `cf_propietario_propiedad`
- `cf_contactos_propietario`

Consultas actuales:

- propietario por email;
- propietario por propiedad;
- busqueda aproximada por nombre;
- busqueda aproximada por codigo de propiedad;
- propiedades activas de un propietario.

### Deuda y recibos

Tablas usadas:

- `cf_recibos`
- `cf_movimientos_deuda`

Consultas actuales:

- deuda por propietario;
- deuda por propiedad;
- deuda por ejercicio;
- listado de deudores;
- desglose de recibos pendientes.

Riesgo:

- hace falta confirmar el alcance por comunidad y la fecha exacta de actualizacion de datos importados.

### Contabilidad y presupuesto

Tablas usadas:

- `informes_contables`
- `cf_gastos_facturas`
- `cf_extractos_banco_lineas`
- `cf_recibos`
- `cf_movimientos_deuda`

Consultas actuales:

- presupuesto segun ultimo informe contable;
- principales desviaciones;
- balance financiero provisional por periodo;
- caja, devengo, deuda, mejoras e inversiones.

Riesgo:

- el balance se presenta como provisional, correcto para consulta, pero necesita fuente y fecha de calculo visible.

### Tareas y proyectos

Tablas usadas:

- `tareas`
- `proyectos`
- `registros`
- `registros_proyectos`

Consultas actuales:

- busqueda por titulo, descripcion y contexto;
- estado;
- responsable;
- proximo paso.

Riesgo:

- la consulta operativa en `querySmartAssistant` debe aplicar el mismo filtro de comunidad que `queryAiContext` y `queryGlobalSearch`.

### Documentos, anexos e informes

Tablas usadas en buscador/documentos:

- `anexos_registros`
- `informes`
- `acciones_pendientes`

Estado:

- disponibles en buscador global y centro documental;
- no integrados de forma sistematica en el contrato de respuesta IA.

### Asambleas

Estado:

- existe modulo independiente por `assembly-bridge.py`;
- el Centro IA no parece consultar todavia asambleas de forma general, salvo generacion de actas.

Pendiente:

- definir consultas tipo: asistentes, quorum, resultado de punto, acuerdos, documentos y estado de acta.

### Seguridad

Estado:

- existe modulo independiente por `security-bridge.py`;
- no aparece integrado como fuente general del Centro IA.

Pendiente:

- permitir consultas de incidencias solo a usuarios autorizados.

## Contrato de respuesta recomendado

Toda respuesta de consulta deberia devolver como minimo:

```json
{
  "action": "consulta",
  "answer": "texto breve",
  "confidence": 0.0,
  "data_status": "confirmado | inferido | incompleto",
  "sources": [
    {
      "module": "contabilidad",
      "table": "cf_recibos",
      "description": "Recibos actualmente importados",
      "freshness": "fecha de ultima importacion si existe"
    }
  ],
  "display": {
    "title": "Titulo visible",
    "cards": [],
    "tables": [],
    "note": "Limitaciones"
  },
  "questions": [],
  "candidates": []
}
```

## Orden recomendado de intervencion

1. Crear un registro unico de herramientas/fuentes de consulta por modulo.
2. Separar `querySmartAssistant` en consultas por dominio: propietarios, deuda, contabilidad, trabajo, asambleas y seguridad.
3. Aplicar filtros de comunidad y rol en cada herramienta.
4. Anadir `sources` y `data_status` a todas las respuestas.
5. Reforzar `/api/ai/analyze` para que respete las restricciones de rol de propuesta operativa.
6. Crear pruebas representativas.

## Primer ajuste implementado

Fecha: 2026-08-26.

Porcentaje:

- Antes: 35% tecnico / 30% funcional.
- Despues: 45% tecnico / 35% funcional.

Cambios realizados:

- Se anade un registro interno `AI_SOURCES` con las fuentes principales de propietarios, propiedades, deuda, contabilidad, tareas y proyectos.
- Las respuestas de consulta incluyen `data_status`: `confirmado`, `inferido` o `incompleto`.
- Las respuestas de consulta incluyen `sources` para mostrar al usuario las tablas/fuentes internas usadas.
- La interfaz muestra un bloque de evidencia con estado del dato y fuentes internas.
- Las consultas de tareas y proyectos aplican filtro de comunidad segun permisos del usuario activo.
- `POST /api/ai/analyze` queda restringido a `Superusuario`, `Administrador` y `Usuario`, igual que la preparacion operativa.
- Se anade `scripts/check-ai-python.mjs` para compilar el bloque Python embebido de `querySmartAssistant` y detectar errores de sintaxis antes de desplegar.

Limitaciones pendientes:

- `querySmartAssistant` sigue siendo una funcion grande; debe separarse por dominio para mantenimiento y control de permisos.
- Asambleas y seguridad existen como modulos, pero aun no estan integrados como fuentes generales del Centro IA.
- Las consultas contables se tratan como fuente comun; si hay contabilidad por varias comunidades, habra que aplicar alcance por comunidad de forma explicita.
- La IA todavia no ejecuta acciones automaticas; eso pertenece a Fase 2 y requiere confirmacion editable y auditoria.

## Segundo ajuste implementado

Fecha: 2026-08-26.

Porcentaje:

- Antes: 45% tecnico / 35% funcional.
- Despues: 50% tecnico / 40% funcional.

Cambios realizados:

- Se anade `detect_query_domain(...)` como primer enrutador explicito de consultas.
- Cada respuesta del Centro IA declara `query_domain`: propietarios/contacto, propiedad, deuda, contabilidad, presupuesto, trabajo o general.
- La interfaz muestra el dominio detectado junto al estado del dato y las fuentes internas.
- Se anade `scripts/smoke-ai-query.mjs` para probar consultas reales contra una base local sin arrancar servidor.
- Se corrige el extractor de correo para que las preguntas con email entren por propietarios/contacto.
- Se corrigen los scripts de prueba para interpretar el template JS como lo ejecuta Node, evitando falsos negativos por escapes.

Pruebas ejecutadas contra `data/ai-audit.db`:

- `quien es el propietario con email icogo23@hotmail.com`: dominio `propietarios_contacto`, dato confirmado, propietario encontrado.
- `que deuda tiene PROMAGA`: dominio `deuda`, dato confirmado, resumen y desglose por ejercicio/propiedad.
- `dame listado de deudores`: dominio `deuda`, dato confirmado, listado estructurado.
- `que cantidad de deuda pertenece a 2026`: dominio `deuda`, dato confirmado, deuda del ejercicio.
- `estado del proyecto isletas`: dominio `trabajo`, dato confirmado, proyecto encontrado.

Pendiente para cerrar Fase 1:

- Extraer cada dominio a una funcion o modulo propio.
- Integrar consultas de asambleas y seguridad.
- Anadir pruebas automatizadas con aserciones, no solo smoke manual.
- Revisar codificacion de algunos datos importados que aparecen con caracteres corruptos en respuestas de deuda.

## Tercer ajuste implementado

Fecha: 2026-08-26.

Porcentaje:

- Antes: 50% tecnico / 40% funcional.
- Despues: 60% tecnico / 50% funcional.

Cambios realizados:

- Se anaden fuentes internas de asambleas: `asambleas`, `asamblea_puntos`, `asamblea_asistencia` y `asamblea_votos`.
- Se anaden fuentes internas de seguridad: `seguridad_incidencias` y `seguridad_documentos`.
- El Centro IA responde consultas de la ultima asamblea visible, asistencia, proxys, puntos y resultado de un punto concreto.
- El Centro IA responde consultas de seguridad con resumen de partes, incidencias, estados, categorias e incidencias pendientes.
- La consulta de seguridad respeta permisos: Superusuario, Seguridad o usuarios con `usuario_permisos.gestionar_seguridad`.
- La interfaz muestra los nuevos dominios `Asambleas` y `Seguridad`.

Pruebas ejecutadas contra `data/ai-audit.db`:

- `resumen de la ultima asamblea`: dominio `asambleas`, dato confirmado, puntos/asistencia/proxys.
- `resultado del punto 3 de la ultima asamblea`: dominio `asambleas`, dato confirmado, votos registrados.
- `que incidencias de seguridad estan pendientes`: dominio `seguridad`, dato confirmado para usuario autorizado.
- Misma consulta de seguridad con rol `Presidente`: acceso denegado, sin fuentes expuestas.

Pendiente para cerrar Fase 1:

- Convertir `scripts/smoke-ai-query.mjs` en prueba con aserciones por dominio, estado y fuentes.
- Probar presupuesto, balance y permisos por comunidad.
- Extraer el bloque monolitico de consultas a funciones o modulo dedicado.
- Corregir en una fase posterior la codificacion historica de algunos datos importados que muestran caracteres corruptos.

## Cuarto ajuste implementado

Fecha: 2026-08-26.

Porcentaje:

- Antes: 60% tecnico / 50% funcional.
- Despues: 70% tecnico / 60% funcional.

Cambios realizados:

- Se anade `scripts/assert-ai-query.mjs` con aserciones automaticas sobre dominio, estado del dato, contenido minimo y fuentes.
- La bateria cubre 10 consultas principales: email, propietario por propiedad exacta, deuda por propietario, deuda por ejercicio, listado deudores, presupuesto, balance, trabajo, asamblea, punto de asamblea y seguridad.
- Incluye una prueba negativa: el rol Presidente no puede consultar Seguridad ni recibe fuentes internas.

Pruebas ejecutadas:

- `npm run check`.
- `node scripts/check-ai-python.mjs`.
- `node scripts/assert-ai-query.mjs`.
- `git diff --check`.

Pendiente para cerrar Fase 1:

- Probar permisos por comunidad con usuarios no superusuario y comunidades limitadas.
- Extraer el bloque monolitico de consultas a funciones o modulo dedicado.
- Revisar codificacion historica de datos importados.

## Quinto ajuste implementado

Fecha: 2026-08-27.

Porcentaje:

- Antes: 70% tecnico / 60% funcional.
- Despues: 78% tecnico / 68% funcional.

Cambios realizados:

- `scripts/assert-ai-query.mjs` reutiliza `runQuery(...)` para pruebas de consulta.
- Se anaden pruebas de permisos por comunidad:
  - usuario limitado a comunidad `7` no ve el proyecto `isletas` de Macrocomunidad;
  - usuario limitado a comunidad `7` no ve la asamblea de Macrocomunidad.
- La prueba detecto un fallo real en las consultas de trabajo: el filtro de comunidad usaba alias `p`/`t`, pero las tablas no estaban aliasadas.
- Se corrige el SQL de trabajo con alias explicitos `proyectos p` y `tareas t`.
- La bateria queda en 10 consultas funcionales y 3 controles de permiso.

Pruebas ejecutadas:

- `npm run check`.
- `node scripts/check-ai-python.mjs`.
- `node scripts/assert-ai-query.mjs`.
- `git diff --check`.

Pendiente para cerrar Fase 1:

- Extraer el bloque monolitico de consultas a funciones o modulo dedicado.
- Revisar codificacion historica de datos importados que muestran caracteres corruptos.
- Dejar documentado que contabilidad/propietarios siguen siendo fuentes comunes hasta que exista `id_comunidad` en esas tablas o una relacion equivalente.

## Sexto ajuste implementado

Fecha: 2026-08-27.

Porcentaje:

- Antes: 78% tecnico / 68% funcional.
- Despues: 82% tecnico / 72% funcional.

Cambios realizados:

- Se inicia la modularizacion interna del Centro IA sin cambiar la respuesta visible al usuario.
- Se extraen a handlers dedicados los dominios:
  - `propietarios_contacto`;
  - `seguridad`;
  - `trabajo`.
- Se anade un despachador `QUERY_HANDLERS` para que esos dominios no dependan ya del bloque condicional principal.
- Se mantiene el bloque anterior como continuidad para el resto de dominios mientras se completa la extraccion por fases.

Pruebas ejecutadas:

- `npm run check`.
- `node scripts/check-ai-python.mjs`.
- `node scripts/assert-ai-query.mjs`.

Resultado:

- 10 consultas funcionales correctas.
- 3 controles de permisos correctos.
- La prueba Python embebida compila correctamente.

Pendiente para cerrar Fase 1:

- Extraer `deuda`, `propiedad`, `contabilidad`, `presupuesto` y `asambleas`.
- Revisar codificacion historica de datos importados que muestran caracteres corruptos.
- Documentar el alcance comunitario de contabilidad/propietarios hasta que estas tablas tengan relacion directa con comunidad.

## Septimo ajuste implementado

Fecha: 2026-08-27.

Porcentaje:

- Antes: 82% tecnico / 72% funcional.
- Despues: 88% tecnico / 78% funcional.

Cambios realizados:

- Se completa la modularizacion interna de todos los dominios actuales del Centro IA:
  - `propietarios_contacto`;
  - `seguridad`;
  - `trabajo`;
  - `asambleas`;
  - `presupuesto`;
  - `contabilidad`;
  - `propiedad`;
  - `deuda`.
- Se elimina el bloque condicional duplicado que seguia debajo del despachador.
- El flujo principal queda reducido a:
  - detectar dominio;
  - llamar al handler correspondiente;
  - devolver `not_handled()` si la consulta no pertenece a ningun dominio fiable.
- `scripts/assert-ai-query.mjs` anade comprobacion estructural para impedir que vuelva un bloque `elif query_domain == ...` fuera del despachador.

Pruebas ejecutadas:

- `npm run check`.
- `node scripts/check-ai-python.mjs`.
- `node scripts/assert-ai-query.mjs`.
- `git diff --check`.

Resultado:

- 10 consultas funcionales correctas.
- 3 controles de permisos correctos.
- Todos los dominios estan registrados en `QUERY_HANDLERS`.
- No queda bloque condicional monolitico antiguo de `query_domain`.

Pendiente para cerrar Fase 1:

- Revisar codificacion historica de textos importados que muestran caracteres corruptos.
- Ampliar pruebas con consultas reales largas, especialmente deuda/listados y trabajo operativo.
- Documentar claramente las fuentes comunes de contabilidad/propietarios cuando no existe todavia separacion por comunidad.

## Octavo ajuste implementado

Fecha: 2026-08-27.

Porcentaje:

- Antes: 88% tecnico / 78% funcional.
- Despues: 92% tecnico / 84% funcional.

Cambios realizados:

- Se fuerza `PYTHONIOENCODING=utf-8` en los puentes Python de servidor para evitar que Windows convierta simbolos o acentos a caracteres `�` al devolver JSON a Node.
- Se aplica la misma codificacion en los scripts de prueba que ejecutan Python.
- Se anade limpieza de texto en el contrato `response(...)` del Centro IA:
  - corrige mojibake recuperable tipo `sesiÃ³n`;
  - elimina o normaliza caracteres irrecuperables en la salida;
  - no modifica la base de datos.
- `scripts/assert-ai-query.mjs` rechaza respuestas con marcadores mojibake en los casos cubiertos.

Pruebas ejecutadas:

- `npm run check`.
- `node scripts/check-ai-python.mjs`.
- `node scripts/assert-ai-query.mjs`.
- `git diff --check`.

Resultado:

- 10 consultas funcionales correctas.
- 3 controles de permisos correctos.
- Sin caracteres mojibake en las salidas de prueba cubiertas.

Pendiente para cerrar Fase 1:

- Ampliar pruebas con consultas reales largas.
- Documentar el alcance comunitario de propietarios/contabilidad, ya que actualmente funcionan como fuentes comunes si no existe relacion directa por comunidad.

## Cierre de Fase 1

Fecha: 2026-08-27.

Estado: cerrada como nucleo de consulta fiable.

Evidencia de cierre:

- El Centro IA separa consulta y operacion:
  - `/api/ai/query` llama a `answerAiQuery(...)`;
  - `/api/ai/operate` y `/api/ai/analyze` preparan cambios operativos y requieren rol permitido.
- Todas las consultas de Fase 1 devuelven `action: consulta`.
- Todas las consultas de Fase 1 declaran:
  - `query_domain`;
  - `data_status`;
  - `sources`;
  - `display` cuando hay datos estructurados.
- Los dominios actuales estan aislados en `QUERY_HANDLERS`.
- No queda bloque condicional monolitico antiguo de `query_domain`.
- La salida Python se fuerza a UTF-8.
- Las respuestas de prueba no contienen marcadores mojibake.
- La bateria automatica cubre 12 consultas funcionales y 3 controles de permisos.

Consultas verificadas:

- propietario por email;
- deuda por propietario;
- deuda por nombre parcial real: Inversiones Senada;
- propietario por propiedad exacta;
- listado general de deudores;
- propietarios con deuda superior a 1000 EUR;
- estado de proyecto;
- presupuesto;
- balance financiero por periodo;
- resumen de asamblea;
- resultado de punto de asamblea;
- incidencias de seguridad pendientes.

Controles de permisos verificados:

- Presidente no puede consultar Seguridad.
- Usuario limitado a comunidad `7` no ve proyecto de Macrocomunidad.
- Usuario limitado a comunidad `7` no ve asamblea de Macrocomunidad.

Riesgo documentado:

- Propietarios, propiedades, recibos, movimientos de deuda, facturas y bancos siguen siendo fuentes comunes hasta que el modulo contable tenga relacion directa por comunidad.
- Este riesgo no bloquea Fase 1 porque la consulta muestra fuentes y no ejecuta acciones automaticas.
- Antes de usar varias comunidades contables independientes habra que anadir `id_comunidad` o relacion equivalente.

Siguiente fase:

- Fase 2 - Acciones con confirmacion.
- Ninguna accion automatica debe modificar datos sin pantalla editable y confirmacion expresa.

## Alcance comunitario de fuentes comunes

Estado actual:

- Tareas, proyectos, asambleas y seguridad aplican permisos por comunidad cuando la tabla tiene `id_comunidad` o una relacion directa.
- Propietarios, propiedades, recibos, movimientos de deuda, facturas y extractos de banco funcionan actualmente como fuentes comunes de la base contable.

Riesgo:

- Si en el futuro se cargan varias comunidades contables completas en las mismas tablas sin una relacion clara por comunidad, una consulta IA de deuda o propietario podria devolver informacion de mas de una comunidad.

Criterio de seguridad para Fase 1:

- Mientras la contabilidad se use como base comun de Macrocomunidad, se documenta el alcance y no se marca como bloqueo.
- Antes de usar la misma base para varias comunidades contables independientes, habra que anadir `id_comunidad` o una tabla de relacion equivalente en propietarios, propiedades, recibos, deuda, gastos y bancos.
- Hasta entonces, el Centro IA debe mostrar fuentes internas y no ejecutar acciones automaticas sobre estos datos.

## Pruebas recomendadas para cerrar la Fase 1

- `quien es el propietario de CB 2 derecha`
- `que deuda tiene PROMAGA`
- `dame listado de deudores`
- `que cantidad de deuda pertenece a 2026`
- `como van los presupuestos`
- `balance financiero desde 01/01/2026 hasta 30/08/2026`
- `estado del proyecto isletas`
- `que incidencias de seguridad estan pendientes`
- `resultado del punto 3 de la ultima asamblea`

Cada prueba debe validar:

- no crea ni modifica datos;
- respeta rol y comunidad;
- muestra datos estructurados;
- indica fuente interna;
- pregunta si falta informacion.

## Ramificaciones detectadas

| Ramificacion | Decision propuesta | Motivo |
| --- | --- | --- |
| Conectar Outlook/email | Aparcar | Modulo ya decidido en standby. No bloquea Fase 1. |
| Activar acciones automaticas del agente | Aparcar | Pertenece a Fase 2. Primero consulta fiable. |
| Votacion movil QR/PIN | Aparcar | Pertenece a Asambleas, no bloquea consultas. |
| Filtro de comunidad en contabilidad | Investigar | Puede ser requisito critico si la contabilidad deja de ser solo Macrocomunidad. |

## Proximo paso

- iniciar Fase 2 con propuestas editables;
- mantener las pruebas actuales como barrera de regresion;
- ampliar el modelo comunitario contable antes de mezclar varias comunidades con deuda o bancos independientes.
