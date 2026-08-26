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

Implementar el primer ajuste de Fase 1:

- crear contrato comun de respuesta IA;
- anadir fuentes internas a consultas existentes;
- endurecer permisos de `/api/ai/analyze`;
- preparar pruebas de no modificacion de datos.
