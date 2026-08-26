# Mapa maestro - Plataforma central inteligente

## Proposito

Convertir Organizador Web en el entorno central de trabajo para la gestion integral de comunidades: operativa diaria, tareas, proyectos, asambleas, seguridad, proveedores, contabilidad, deuda, documentacion, comunicaciones, autorizaciones, informes, analisis de riesgos y soporte inteligente mediante conversacion natural.

El objetivo final no es tener "una IA que contesta", sino un agente operativo con datos fiables, memoria controlada, permisos, confirmacion previa, trazabilidad y capacidad de proponer actuaciones defendiendo los intereses de la comunidad.

## Estado global

- App web operativa actual: 60%.
- Plataforma central inteligente final: 35% - 40%.
- Agente conversacional real: 15% - 20%.

Estos porcentajes se revisaran al cerrar cada nucleo. En cada avance se debe indicar:

- nucleo en curso;
- porcentaje antes/despues;
- que queda pendiente;
- riesgos o bloqueos;
- si ha aparecido alguna ramificacion.

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

Estado: en curso.

Objetivo:

- dejar este mapa maestro creado;
- enlazarlo desde README;
- usarlo como referencia en cada avance.

Cierre:

- documento creado y versionado;
- porcentaje inicial establecido;
- regla de ramificaciones definida.

### Fase 1 - Agente de consulta fiable

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

## Ultima actualizacion

- Fecha: 2026-08-26.
- Nucleo activo: Fase 0 - Memoria del proyecto.
- Avance del nucleo: 98%.
- Pendiente inmediato: confirmacion del usuario para cerrar la Fase 0 y pasar a la Fase 1.
