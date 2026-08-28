# Mapa maestro - Plataforma central inteligente

## Proposito

Convertir Organizador Web en el entorno central de trabajo para la gestion integral de comunidades: operativa diaria, tareas, proyectos, asambleas, seguridad, proveedores, contabilidad, deuda, documentacion, comunicaciones, autorizaciones, informes, analisis de riesgos y soporte inteligente mediante conversacion natural.

El objetivo final no es tener "una IA que contesta", sino un agente operativo con datos fiables, memoria controlada, permisos, confirmacion previa, trazabilidad y capacidad de proponer actuaciones defendiendo los intereses de la comunidad.

## Estado global

- App web operativa actual: 74%.
- Plataforma central inteligente final: 45% - 50%.
- Agente conversacional real: 58% - 62%.

Estos porcentajes se revisaran al cerrar cada nucleo. En cada avance se debe indicar:

- nucleo en curso;
- porcentaje antes/despues;
- que queda pendiente;
- riesgos o bloqueos;
- si ha aparecido alguna ramificacion.

## Tablero actual

| Campo | Estado |
| --- | --- |
| Nucleo activo | Fase 5 - Agente completo |
| Estado tecnico | 72% |
| Estado funcional | 58% |
| Nucleo anterior | Fase 4 - Automatizacion guiada cerrada al 100% en su nucleo inicial |
| Accion permitida ahora | Usar el agente-router con respuestas guiadas, contexto reciente, catalogo de herramientas y preparacion de informes Word |
| Accion no permitida sin confirmacion | Ejecutar acciones automaticas de IA, modificar datos sensibles o activar conectores externos |
| Bloqueo actual | Ninguno |
| Riesgo principal | Intentar acciones complejas sin dividirlas en herramientas internas auditables |

Proxima accion:

1. Convertir herramientas planificadas en flujos seguros uno a uno.
2. Priorizar email y contabilidad solo con modo propuesta.
3. Mantener confirmacion por cada accion sensible.
4. Afinar la comprension de mensajes que dependen del contexto anterior.
5. Crear acciones sugeridas clicables cuando exista herramienta segura.

## Reglas de trabajo

1. Antes de cada cambio relevante se crea copia de seguridad.
2. No se modifica produccion sin comprobar antes el cambio en local o staging cuando sea posible.
3. No se suben a GitHub bases reales, adjuntos, informes, claves, logs ni datos personales.
4. La IA no ejecuta cambios sensibles sin pantalla de confirmacion editable.
5. Cada accion importante debe quedar auditada.
6. Si durante un paso aparece una mejora lateral, se registra como ramificacion y se pide confirmacion antes de construirla.
7. No se abre un nucleo nuevo si el anterior no esta confirmado o si no se ha dejado documentado lo pendiente.
8. Las respuestas del agente deben distinguir dato confirmado, inferencia, recomendacion y riesgo.
9. La app debe mantener permisos por rol, usuario y comunidad en cualquier consulta o accion.
10. Toda automatizacion debe poder revisarse, corregirse y deshacerse o compensarse con trazabilidad.

## Protocolo de avance

Cada vez que se trabaje en un nucleo se debe usar este formato de seguimiento:

```text
Nucleo:
Porcentaje anterior:
Porcentaje actual:
Hecho en este avance:
Pendiente:
Pruebas realizadas:
Riesgos:
Ramificaciones detectadas:
Decision necesaria:
```

Regla practica: si una ramificacion no bloquea el nucleo actual, no se desarrolla en ese momento. Se anota, se explica y se espera confirmacion expresa del usuario.

## Control anti-bucle

El proyecto puede crecer en muchas direcciones, pero cada avance debe proteger el objetivo principal. Para evitar bucles infinitos:

- cada sesion debe tener un nucleo activo;
- cada nucleo debe tener un criterio de cierre comprobable;
- las mejoras visuales, comodidades y automatizaciones se aceptan solo si refuerzan un nucleo;
- las ideas laterales se guardan en el registro de ramificaciones;
- no se inicia una ramificacion si no resuelve un bloqueo real o si el usuario no la confirma;
- si una mejora necesita mas informacion, se deja documentada la duda y se continua con el trabajo principal que si pueda avanzar.

## Definicion de nucleo cerrado

Un nucleo solo se considera cerrado cuando existen evidencias concretas:

- el alcance trabajado coincide con el objetivo del nucleo;
- los cambios estan documentados en este mapa o en el README correspondiente;
- los datos sensibles siguen fuera de GitHub;
- el flujo critico ha sido probado o se ha explicado por que no aplica prueba tecnica;
- si toca produccion, existe copia de seguridad y verificacion posterior;
- los permisos por rol/comunidad se han revisado cuando el nucleo afecta datos reales;
- las ramificaciones aparecidas estan anotadas con decision;
- el usuario confirma el cierre funcional si el nucleo afecta a uso real de la app.

## Plantilla para decidir ramificaciones

Antes de construir una mejora lateral se debe responder:

```text
Ramificacion:
Origen:
Nucleo afectado:
Aporta al objetivo central:
Bloquea el nucleo actual:
Riesgo si se hace ahora:
Riesgo si se deja para despues:
Decision propuesta:
Confirmacion del usuario:
```

Decisiones posibles:

- `hacer ahora`: solo si desbloquea el nucleo activo o evita rehacer trabajo importante;
- `aparcar`: si es util pero no bloquea;
- `rechazar`: si es superflua, duplica funcionalidad o complica la app sin aportar valor real;
- `investigar`: si falta informacion critica antes de decidir.

## Checklist antes de modificar codigo o datos

- Confirmar nucleo activo.
- Confirmar porcentaje de partida.
- Crear copia de seguridad de codigo/documentacion o datos, segun corresponda.
- Revisar estado de Git.
- Identificar si el cambio toca produccion, staging o solo local.
- Revisar permisos y roles afectados.
- Definir pruebas minimas antes de desplegar.
- Confirmar si hay ramificaciones nuevas.

## Arquitectura objetivo

### 1. Base de datos central

Objetivo: que todos los modulos trabajen sobre datos estructurados, relacionados y consultables.

Subpuntos:

- propietarios y propiedades;
- historico de titularidad;
- contactos, idioma preferente y preferencias de comunicacion;
- recibos, deuda, cobros, remesas y movimientos bancarios;
- proveedores, categorias, valoraciones y relaciones con trabajos;
- tareas y proyectos independientes con seguimientos;
- asambleas, puntos, asistentes, representaciones, votos, actas y documentos;
- partes de seguridad e incidencias;
- documentos y anexos vinculados;
- auditoria y trazabilidad.

Estado estimado: 45%.

Pendiente:

- reforzar relaciones entre contabilidad, propietarios y documentos;
- normalizar proveedores y categorias;
- consolidar deuda y recibos con trazabilidad financiera;
- preparar datos para consultas IA fiables.

Criterio de cierre:

- las entidades principales existen, se consultan desde web y permiten trazabilidad basica;
- las consultas importantes pueden citar de donde sale el dato.

### 2. Interfaz central web

Objetivo: que la app sea util desde escritorio y movil sin depender de la app Windows.

Subpuntos:

- navegacion movil y escritorio;
- tarjetas operativas para tareas, proyectos, trabajo, acciones e incidencias;
- paneles por rol;
- administracion de usuarios y comunidades;
- asambleas;
- seguridad;
- contabilidad;
- centro IA.

Estado estimado: 65%.

Pendiente:

- pulir pantallas densas en movil;
- completar las acciones de administracion que falten en web;
- unificar patrones visuales en modulos nuevos;
- revisar experiencia del presidente y perfil seguridad.

Criterio de cierre:

- las funciones principales se pueden usar desde navegador;
- cada rol ve solo lo que debe ver;
- movil permite trabajar, no solo consultar.

### 3. Centro IA separado por finalidad

Objetivo: separar claramente consulta, entrada operativa y agente de acciones.

Subpuntos:

- IA de consulta: responde preguntas sobre datos internos;
- IA de entrada inteligente: transforma texto, llamada o reunion en propuestas;
- IA de acciones: prepara operaciones editables antes de guardar;
- historial de conversaciones;
- respuestas legibles con tablas, bloques y fuentes internas;
- control de dudas: si falta informacion, pregunta antes de actuar.

Estado estimado: 30%.

Pendiente:

- mejorar recuperacion de datos en consultas complejas;
- separar herramientas internas por modulo;
- mostrar evidencia de datos usados;
- evitar que una consulta se interprete como tarea/proyecto;
- crear memoria de conversacion y preferencias.

Criterio de cierre:

- el usuario puede preguntar por propietarios, deuda, tareas, proyectos, asambleas y contabilidad;
- la app responde con datos estructurados y no propone una accion si solo era consulta;
- cada respuesta importante muestra base de datos/fuente interna.

### 4. Motor de acciones controladas

Objetivo: que el agente pueda preparar y ejecutar acciones con confirmacion.

Subpuntos:

- crear tarea;
- crear proyecto;
- anadir seguimiento;
- clasificar movimiento bancario;
- asignar cobro a recibo;
- preparar borrador de email;
- generar informe;
- crear certificado;
- actualizar propietario o contacto;
- preparar cambio de titularidad como expediente revisable;
- vincular documentos;
- crear aviso o recordatorio;
- registrar decision o aprobacion.

Estado estimado: 15%.

Pendiente:

- definir contrato comun de accion;
- pantalla de confirmacion editable;
- validaciones por rol y comunidad;
- previsualizacion de impacto;
- auditoria antes/despues;
- resultado verificable.

Criterio de cierre:

- ninguna accion sensible se guarda sin confirmacion;
- el usuario ve que se va a crear, modificar o vincular;
- la accion queda auditada y se puede rastrear.

### 5. Memoria controlada y aprendizaje

Objetivo: que la app aprenda reglas utiles sin automatizar errores.

Subpuntos:

- idioma preferente de propietario;
- patrones de pagos bancarios;
- proveedor habitual por tipo de trabajo;
- categoria presupuestaria habitual;
- criterios confirmados por Luis/Elena;
- correcciones hechas a propuestas IA;
- reglas activas, inactivas y editables;
- nivel de confianza;
- fecha y usuario que confirma la regla.

Estado estimado: 5%.

Pendiente:

- crear tabla de reglas aprendidas;
- crear panel de revision de reglas;
- integrar reglas en conciliacion, emails, tareas y proveedores;
- pedir confirmacion antes de aplicar reglas dudosas.

Criterio de cierre:

- el agente recuerda patrones confirmados;
- las reglas se pueden ver, editar y borrar;
- las reglas de baja confianza solo proponen, no ejecutan.

### 6. Contabilidad financiera y gestion economica

Objetivo: transformar datos de Netfincas, banco y documentos en una vision financiera fiable.

Subpuntos:

- propietarios y propiedades;
- clasificacion de viviendas;
- cuotas y coeficientes;
- recibos emitidos, cobrados, pendientes y reclasificados;
- deuda por propietario y por propiedad;
- movimientos bancarios;
- conciliacion;
- bolsa "a revisar";
- grupos presupuestarios;
- traduccion a PGC;
- gastos devengados y pagados;
- acreedores;
- informes economicos Excel;
- remesas XML futuras.

Estado estimado: 35%.

Pendiente:

- cerrar conciliacion bancaria con aprendizaje;
- reforzar recibos y deuda actualizada;
- separar con claridad grupo presupuestario, cuenta Netfincas y cuenta PGC;
- completar generacion de asientos revisables;
- preparar remesas SEPA XML cuando se confirme alcance.

Criterio de cierre:

- se puede explicar de donde viene cada cifra;
- banco, recibos y deuda cuadran o quedan en "a revisar";
- los informes distinguen caja, devengo y vision financiera.

### 7. Asambleas y actas

Objetivo: gestionar asambleas de forma completa y generar actas justificadas.

Subpuntos:

- ficha de asamblea;
- censo;
- morosos y sin derecho a voto;
- proxys;
- asistentes y representaciones;
- votaciones;
- mayorias;
- detalle individual;
- documentos;
- transcripcion;
- construccion de acta bilingue;
- exportacion final;
- futura votacion movil por QR/PIN.

Estado estimado: 60%.

Pendiente:

- revisar bugs de importacion y exportacion;
- cerrar finalidad legal de exportaciones;
- robustecer acta con LPH, estatutos y orden del dia;
- dejar QR/PIN en standby hasta nueva confirmacion.

Criterio de cierre:

- la asamblea queda completa desde convocatoria hasta acta;
- resultados, asistentes y documentos son verificables;
- el acta no depende de calculos de IA para votos o coeficientes.

### 8. Comunicaciones y email

Objetivo: conectar la app con comunicaciones reales sin perder control.

Subpuntos:

- lectura de bandeja seleccionada;
- clasificacion de emails;
- propuesta de acciones;
- borradores de respuesta;
- envio tras confirmacion;
- guardado de adjuntos en expediente;
- cambio de titularidad como expediente;
- recordatorios de deuda;
- comunicados por tipo de vivienda;
- historial de comunicaciones.

Estado estimado: 0% en produccion.

Pendiente:

- modulo en standby por decision actual;
- decidir Outlook/Microsoft Graph;
- definir permisos y carpetas;
- crear modo solo borrador al inicio.

Criterio de cierre:

- la app propone, no envia ni modifica sin confirmacion;
- cada email queda vinculado al propietario/tarea/proyecto/asamblea correspondiente.

### 9. Seguridad e incidencias

Objetivo: transformar partes diarios en incidencias utiles y trazables.

Subpuntos:

- carga restringida por perfil Seguridad;
- extraccion de partes;
- clasificacion de incidencias;
- estadisticas;
- bandeja pendiente/revisada;
- creacion de tarea/proyecto;
- seguimiento y cierre;
- deteccion de recurrencias.

Estado estimado: 45%.

Pendiente:

- revisar calidad de extraccion con mas ejemplos;
- mejorar estadisticas por zona/tipo/gravedad;
- conectar recurrencias con riesgos operativos;
- crear informes periodicos.

Criterio de cierre:

- cada parte queda procesado;
- cada incidencia queda revisada o descartada;
- la app detecta patrones repetidos.

### 10. Proveedores y decisiones

Objetivo: tener 1-2 proveedores preaprobados por categoria y poder comparar decisiones.

Subpuntos:

- listado de proveedores;
- categorias;
- proveedor principal y alternativo;
- precios;
- calidad;
- referencias;
- trabajos realizados;
- incidencias;
- documentacion;
- comparativas;
- recomendacion justificada;
- relacion con tareas/proyectos.

Estado estimado: 10%.

Pendiente:

- importar y normalizar proveedores;
- crear panel por categoria;
- crear criterios de valoracion;
- vincular proveedores con trabajos y presupuestos;
- generar comparativas.

Criterio de cierre:

- para cada categoria critica existen proveedores alternativos;
- las recomendaciones se basan en datos y experiencia registrada.

### 11. Riesgos, criterio y defensa de intereses

Objetivo: que la app ayude a detectar riesgos y proponer actuaciones prudentes.

Subpuntos:

- riesgos tecnicos;
- riesgos legales;
- riesgos economicos;
- riesgos administrativos;
- riesgos reputacionales;
- decisiones de junta;
- desviaciones presupuestarias;
- contratos y obligaciones recurrentes;
- asuntos bloqueados;
- advertencias con nivel de confianza;
- recomendacion y alternativa.

Estado estimado: 5%.

Pendiente:

- definir matriz de riesgos;
- conectar historico de tareas, proyectos, seguridad, asambleas y contabilidad;
- distinguir recomendacion operativa de asesoramiento legal;
- generar alertas justificadas.

Criterio de cierre:

- la app no solo informa, tambien advierte;
- cada advertencia explica motivo, fuente y siguiente paso recomendado.

### 12. Gobierno tecnico, pruebas y despliegue

Objetivo: que el crecimiento no rompa lo que ya funciona.

Subpuntos:

- backups antes de cambios;
- staging separado;
- produccion estable;
- migraciones aditivas;
- tests de rutas criticas;
- logs utiles;
- rollback;
- documentacion viva;
- GitHub actualizado;
- despliegue controlado en Ubuntu.

Estado estimado: 50%.

Pendiente:

- mejorar test automatizado;
- crear checklist de despliegue por nucleo;
- consolidar migraciones de base de datos;
- documentar dependencias y variables.

Criterio de cierre:

- cada nucleo se puede probar, desplegar y revertir con bajo riesgo;
- existe documentacion suficiente para retomar el trabajo sin perder contexto.

## Prioridad por fases

### Fase 0 - Memoria del proyecto

Estado: cerrada.

Objetivo:

- dejar este mapa maestro creado;
- enlazarlo desde README;
- usarlo como referencia en cada avance.

Cierre:

- documento creado y versionado;
- porcentaje inicial establecido;
- regla de ramificaciones definida.

### Fase 1 - Agente de consulta fiable

Estado: iniciada.

Objetivo:

- separar definitivamente consulta de entrada operativa;
- responder sobre datos internos con formato claro;
- mostrar fuentes internas;
- mantener historial.

Modulos prioritarios:

- propietarios;
- deuda;
- recibos;
- tareas;
- proyectos;
- asambleas;
- seguridad;
- contabilidad.

Porcentaje inicial estimado: 30%.

Subpasos previstos:

1. Auditar el Centro IA actual y separar por completo consulta, entrada inteligente y acciones.
2. Crear un contrato interno de respuesta para consultas: resumen, datos, tabla, fuentes internas, dudas y siguientes opciones.
3. Mapear fuentes disponibles por modulo: tablas, endpoints, documentos y limitaciones.
4. Mejorar busquedas sobre propietarios, propiedades, deuda, tareas, proyectos, asambleas y seguridad.
5. Guardar historial de consulta con usuario, comunidad, pregunta, fuentes usadas y respuesta.
6. Mostrar respuestas largas en bloques legibles y tablas, especialmente en movil.
7. Anadir pruebas de consultas representativas.

Criterios para cerrar Fase 1:

- una consulta no se interpreta como entrada operativa;
- las respuestas indican si el dato es confirmado o inferido;
- cada dato importante muestra fuente interna o limitacion;
- las consultas por propietario, vivienda, deuda, tarea, proyecto y asamblea funcionan de forma consistente;
- el historial permite retomar conversaciones sin perder contexto inmediato.

### Fase 2 - Acciones con confirmacion

Objetivo:

- crear un motor comun de propuestas;
- permitir editar antes de guardar;
- auditar cada accion;
- empezar con acciones simples y reversibles.

Primeras acciones:

- crear tarea/proyecto;
- anadir seguimiento;
- clasificar movimiento;
- vincular documento;
- preparar email como borrador.

### Fase 3 - Memoria y reglas aprendidas

Objetivo:

- guardar patrones confirmados;
- aplicar reglas con confianza;
- mostrar reglas aprendidas al usuario.

Primeras reglas:

- idioma de propietario;
- patron de ingreso bancario;
- proveedor habitual;
- categoria presupuestaria habitual.

### Fase 4 - Automatizacion guiada

Objetivo:

- que la app revise bandejas, extractos, partes y documentos;
- proponga acciones agrupadas;
- permita aprobarlas una a una o por lote.

### Fase 5 - Agente completo

Objetivo:

- conversacion natural;
- acciones complejas multistep;
- informes;
- documentos;
- comunicaciones;
- riesgos;
- aprendizaje controlado.

## Registro de ramificaciones

Toda idea nueva que aparezca durante un nucleo se registrara aqui antes de construirla.

| Fecha | Nucleo | Ramificacion | Decision |
| --- | --- | --- | --- |
| 2026-08-26 | 0 | Crear mapa maestro del agente y reglas de avance | Confirmado |

## Bitacora de avance

| Fecha | Nucleo | Avance | Evidencia | Pendiente |
| --- | --- | --- | --- | --- |
| 2026-08-26 | Fase 0 - Memoria del proyecto | 98% | Commit `e89cd28` publicado en GitHub con README y mapa maestro | Confirmacion del usuario para cerrar al 100% |
| 2026-08-26 | Fase 0 - Memoria del proyecto | 99% tecnico | Commit `010fa7d` publicado en GitHub con control anti-bucle, bitacora y Fase 1 marcada como preparada | Confirmacion del usuario para cerrar al 100% |
| 2026-08-26 | Fase 0 - Memoria del proyecto | 99% tecnico reforzado | Se anade definicion de nucleo cerrado y plantilla de decision de ramificaciones | Commit y push de esta ampliacion |
| 2026-08-26 | Fase 0 - Memoria del proyecto | 99% tecnico reforzado | Se anade tablero actual con siguiente nucleo, accion permitida y bloqueo funcional | Commit y push de esta ampliacion |
| 2026-08-26 | Fase 0 - Memoria del proyecto | 100% | Usuario confirma el mapa maestro. Se inicia Fase 1 con porcentaje base 30% | Auditar Centro IA actual |
| 2026-08-26 | Fase 1 - Agente de consulta fiable | 35% tecnico | Auditoria inicial del Centro IA documentada en `docs/FASE_1_AUDITORIA_CENTRO_IA.md` | Implementar contrato comun de respuesta y fuentes internas |
| 2026-08-26 | Fase 1 - Agente de consulta fiable | 45% tecnico / 35% funcional | Contrato `data_status` + `sources`, fuentes visibles en UI, permisos reforzados en `/api/ai/analyze`, filtro de comunidad en consultas de trabajo y check Python anadido | Separar por dominios y completar pruebas funcionales con preguntas reales |
| 2026-08-26 | Fase 1 - Agente de consulta fiable | 50% tecnico / 40% funcional | Enrutador `query_domain`, dominio visible en respuesta, smoke test reutilizable y pruebas reales de email, deuda por propietario, deuda por ejercicio y proyecto | Extraer cada dominio a funcion/modulo propio e integrar asambleas/seguridad |
| 2026-08-26 | Fase 1 - Agente de consulta fiable | 60% tecnico / 50% funcional | Consultas IA de asambleas y seguridad integradas con dominio, fuentes, permisos y pruebas de punto/asamblea/incidencias | Modularizar consultas y crear pruebas con aserciones |
| 2026-08-26 | Fase 1 - Agente de consulta fiable | 70% tecnico / 60% funcional | `scripts/assert-ai-query.mjs` valida 10 consultas: propietario/email, propiedad exacta, deuda, listado, presupuesto, balance, trabajo, asambleas y seguridad; incluye permiso negativo de Seguridad | Modularizar consultas y probar permisos por comunidad |
| 2026-08-27 | Fase 1 - Agente de consulta fiable | 78% tecnico / 68% funcional | Pruebas de comunidad anadidas: usuario limitado no ve proyecto/asamblea fuera de su comunidad. Se corrige alias SQL en consulta de trabajo detectado por la prueba | Modularizar consultas y revisar codificacion historica |
| 2026-08-27 | Fase 1 - Agente de consulta fiable | 82% tecnico / 72% funcional | Primer corte modular del Centro IA: consultas de contacto, seguridad y trabajo pasan a handlers dedicados y mantienen 10 consultas + 3 pruebas de permisos correctas | Extraer deuda, contabilidad, presupuesto y asambleas; revisar codificacion historica |
| 2026-08-27 | Fase 1 - Agente de consulta fiable | 88% tecnico / 78% funcional | Todos los dominios principales pasan a `QUERY_HANDLERS`: contacto, seguridad, trabajo, asambleas, presupuesto, contabilidad, propiedad y deuda. Se elimina el bloque antiguo duplicado y la prueba valida que no vuelva | Revisar codificacion historica y ampliar casos reales largos |
| 2026-08-27 | Fase 1 - Agente de consulta fiable | 92% tecnico / 84% funcional | Se fuerza salida UTF-8 en puentes Python, se limpia mojibake en respuestas IA sin modificar la base y la prueba rechaza salidas con caracteres rotos | Documentar alcance comunitario de datos comunes y ampliar consultas reales largas |
| 2026-08-27 | Fase 1 - Agente de consulta fiable | 100% nucleo cerrado | La bateria sube a 12 consultas reales + 3 permisos: incluye Inversiones Senada, propietarios con deuda superior a 1000 EUR y limite de filas en listados largos. Fuentes, dominio, estado del dato, permisos y salida legible quedan verificados | Pasar a Fase 2 solo cuando se confirmen acciones con ventana editable |
| 2026-08-27 | Fase 2 - Acciones con confirmacion | 45% tecnico / 35% funcional | Se anade contrato `editable_confirmation_v1` para crear tarea/proyecto y anadir seguimiento; consultas quedan como `query_v1`; la UI avisa que nada se guarda hasta revisar y confirmar; prueba automatica verifica que rutas IA no escriben directamente | Probar acciones reales, previsualizar impacto antes/despues y extender a documentos/banco/email |
| 2026-08-27 | Fase 2 - Acciones con confirmacion | 52% tecnico / 42% funcional | Las propuestas IA muestran un resumen de impacto previsto antes de aplicar; la prueba del contrato valida tambien que ese resumen exista | Completar previsualizacion antes/despues con datos actuales y probar acciones reales desde web |
| 2026-08-27 | Fase 2 - Acciones con confirmacion | 85% tecnico / 75% funcional | Se anade previsualizacion antes/despues con snapshot actual y valores propuestos; al editar campos se actualiza la columna propuesta. Las pruebas de consultas y contrato siguen correctas | Validacion funcional del usuario en web para cerrar Fase 2 al 100% |
| 2026-08-27 | Fase 2 - Acciones con confirmacion | 100% cerrado | Usuario confirma que el flujo se entiende y puede refinarse mas adelante. La mejora de calidad en titulo, comentario y proximo paso se registra para Fase 3 | Abrir memoria controlada y reglas aprendidas |
| 2026-08-27 | Fase 3 - Memoria y reglas aprendidas | 5% tecnico / 5% funcional | Se crea documento de fase con objetivo, reglas, primer alcance y ramificacion de redaccion operativa | Crear estructura persistente de reglas IA |
| 2026-08-27 | Fase 3 - Memoria y reglas aprendidas | 100% nucleo inicial cerrado | Se implementa tabla `ia_reglas`, panel Memoria IA, aprendizaje de correcciones de redaccion, aplicacion de reglas en propuestas confirmables y prueba `assert-ai-memory` | Abrir Fase 4 - Automatizacion guiada |
| 2026-08-27 | Fase 4 - Automatizacion guiada | 100% nucleo inicial cerrado | Se implementa lote guiado con contrato `guided_batch_v1`, separacion en propuestas independientes, tarjetas editables, seleccion por propuesta, confirmacion final y aprendizaje opcional de correcciones | Preparar Fase 5 - Agente completo por herramientas internas |
| 2026-08-28 | Fase 5 - Agente completo | 72% tecnico / 58% funcional | Se activa documentos/informes en el agente: consulta de anexos e informes visibles, contrato `agent_report_prepare_v1`, propuesta revisable de informe Word y generacion solo tras confirmacion | Convertir otra herramienta planificada en flujo seguro: email/Outlook o conciliacion bancaria |

## Ultima actualizacion

- Fecha: 2026-08-28.
- Nucleo activo: Fase 5 - Agente completo.
- Ultimo nucleo cerrado: Fase 4 - Automatizacion guiada al 100% en su nucleo inicial.
- Avance actual: 72% tecnico / 58% funcional.
- Pendiente inmediato: escoger el siguiente dominio complejo y mantenerlo como herramienta confirmable, sin ejecucion automatica sensible.
