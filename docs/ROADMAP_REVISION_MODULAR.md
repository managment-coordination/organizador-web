# Roadmap de revision modular

## Punto de continuidad: 10/09/2026

Actualizacion posterior por decision expresa del usuario: modulo 06 COMPLETADO para el alcance operativo que ha probado y aceptado. No equivale a consultas universales ni a IA infalible; los limites y ampliaciones se conservan en la ficha. El siguiente trabajo autorizado es exclusivamente el diseno documental de [ERP Comunidades](ERP_COMUNIDADES_ROADMAP.md), con porcentajes separados. Este roadmap sigue siendo el de consolidacion; no se ejecutan automaticamente los modulos 07-10. Las notas de continuidad inferiores se conservan como historial anterior a esta aceptacion.

Modulos 01, 02, 04 y 05 publicados; modulo 03 omitido por decision del usuario, sin eliminar su funcionalidad. Modulo 06: cerrado por aceptacion, con seguimiento contextual, borradores, reuniones multiasunto y consultas del alcance probado. La ampliacion general futura se encuadra en ERP 9, no es trabajo realizado. Ver `MODULO_06_IA_OPERATIVA.md`. No saltar a 07-10. Cinco perfiles activos y SQLite verificados tras la ultima publicacion tecnica.

## Proposito

Este documento fija el metodo de trabajo para consolidar la aplicacion modulo por modulo antes de seguir ampliandola.

El objetivo no es anadir funciones por impulso, sino dejar cada modulo cerrado, estable, comprensible y preparado para una capa superior de control mediante IA.

La arquitectura deseada es:

1. Datos maestros bien definidos.
2. Procesos operativos claros.
3. Documentacion y trazabilidad vinculadas.
4. Permisos por usuario, rol y comunidad.
5. Informes y consultas fiables.
6. Capa IA transversal que consulte, proponga y ayude, sin ejecutar acciones sensibles sin confirmacion.

## Regla principal

Antes de revisar o modificar cualquier modulo se debe empezar con preguntas de contexto, finalidad y uso real.

No se debe tocar codigo, datos ni interfaz del modulo hasta haber cerrado:

- para que existe el modulo;
- quien lo usa;
- que decisiones soporta;
- que datos son obligatorios;
- que parte debe ser manual;
- que parte puede automatizarse;
- que errores no son admisibles;
- como se considerara cerrado.

## Orden oficial de revision

1. Usuarios, roles y comunidades.
2. Tareas y proyectos.
3. Trabajo Hoy, mapa de trabajo y dashboard.
4. Notificaciones y solicitudes al presidente.
5. Informes y documentos.
6. Importadores y Centro IA.
7. Seguridad.
8. Asambleas.
9. Contabilidad.
10. Proveedores.

## Plantilla obligatoria de inicio de modulo

Al empezar cada modulo se debe responder primero a estas preguntas.

### 1. Finalidad

- Que problema real debe resolver este modulo?
- Que trabajo manual debe reducir?
- Que decision debe facilitar?
- Que resultado tiene que obtener el usuario al usarlo?
- Que no debe intentar resolver este modulo?

### 2. Usuarios y permisos

- Que perfiles usan este modulo?
- Que puede hacer Superusuario?
- Que puede hacer Administrador?
- Que puede hacer Usuario?
- Que puede hacer Consulta?
- Que puede hacer Presidente?
- Que puede hacer Seguridad?
- Hay datos que deban ocultarse por comunidad, rol o sensibilidad?

### 3. Datos

- Cuales son los datos maestros que usa?
- Cuales son datos operativos?
- Cuales son datos historicos?
- Cuales son documentos o anexos?
- Que campos son obligatorios?
- Que campos pueden quedar pendientes?
- Que dato manda si hay contradiccion entre fuentes?

### 4. Flujo operativo

- Como entra la informacion?
- Como se clasifica?
- Como se asigna responsable?
- Como se registra una actualizacion?
- Como se adjuntan documentos?
- Como se detecta que algo esta pendiente?
- Como se cierra o archiva?
- Que pasos sobran o son repetitivos?

### 5. Trazabilidad y seguridad

- Que acciones deben quedar auditadas?
- Que cambios deben poder revisarse posteriormente?
- Que acciones requieren confirmacion?
- Que acciones deberian ser reversibles o compensables?
- Que riesgos hay si un usuario se equivoca?
- Que datos no deben salir nunca a GitHub ni a servicios externos?

### 6. Interconexion

- Con que otros modulos se relaciona?
- Que informacion debe aportar al buscador global?
- Que informacion debe aparecer en Trabajo Hoy?
- Que notificaciones debe generar?
- Que informes debe alimentar?
- Que documentos debe poder vincular?

### 7. IA

- Que puede consultar la IA en este modulo?
- Que puede proponer la IA?
- Que no debe hacer nunca la IA sin confirmacion?
- Que campos debe rellenar la IA en una propuesta?
- Que evidencias debe mostrar para justificar su respuesta?
- Que debe hacer si no esta segura?

### 8. Criterio de cierre

- Que flujo minimo debe funcionar para considerar el modulo estable?
- Que pruebas se deben realizar?
- Que casos limite deben comprobarse?
- Que pantallas deben quedar revisadas en escritorio y movil?
- Que queda fuera de alcance para una fase posterior?

## Ficha de cierre de cada modulo

Al terminar la revision de un modulo se debe dejar una ficha con este formato:

```text
Modulo:
Estado anterior:
Estado final:
Porcentaje anterior:
Porcentaje final:
Finalidad cerrada:
Datos revisados:
Permisos revisados:
Flujos revisados:
Pantallas revisadas:
IA revisada:
Pruebas realizadas:
Riesgos pendientes:
Ramificaciones aparcadas:
Decision del usuario:
```

## Criterio anti-superfluo

Una mejora solo se acepta si cumple al menos una de estas condiciones:

- reduce trabajo administrativo;
- evita olvidos;
- mejora trazabilidad;
- evita errores;
- centraliza informacion dispersa;
- mejora la toma de decisiones;
- mejora la seguridad de los datos;
- mejora de forma clara el uso diario en movil o escritorio.

Si una mejora solo hace la app mas grande, mas vistosa o mas compleja sin resolver un problema real, se aparca o se rechaza.

## Estado actual del proceso

Punto de continuidad:

```text
Modulo 06: COMPLETADO, 100% del alcance operativo aceptado expresamente por el usuario el 10/09/2026. Ampliaciones de consultas y agentes fuera de este cierre. Ver docs/MODULO_06_IA_OPERATIVA.md.
Modulo 05: base funcional publicada y verificada en Ubuntu (09/09/2026). Aceptacion de uso real pendiente; sintesis ejecutiva determinista, no reescritura IA avanzada.
Ficha de continuidad: docs/MODULO_05_INFORMES_DOCUMENTOS.md (incluye limites de sintesis ejecutiva e incrustacion de anexos).
Decisiones 06 cerradas: confirmacion individual y por seleccion; borradores persistentes; Administracion con advertencia cuando no se identifica responsable. No repetir preguntas ya contestadas.
Modulo 04: 100% del alcance confirmado, publicado y verificado. Aceptacion de uso real pendiente del usuario.
Modulo 03: revision omitida por decision expresa del usuario. Su flujo principal consiste en revisar y priorizar las tarjetas de Tareas y Proyectos. Conservar Trabajo Hoy, mapa y dashboard existentes sin modificaciones; no se ha autorizado eliminarlos ni se consideran revisados/certificados.
Modulo anterior: 02 publicado; ver ficha de cierre y limites documentados.
Avance de definicion del modulo 02: 100% del bloque funcional, confirmado el 08/09/2026.
Implementacion de la revision del modulo 02: 100% del alcance confirmado, publicado y verificado. Aceptacion de uso real pendiente del usuario.
Porcentaje global: no recalculado; los modulos tienen alcances diferentes.
Objetivo inmediato autorizado: diseno documental ERP, sin implementacion ni migraciones, en docs/ERP_COMUNIDADES_ROADMAP.md. Conservar este roadmap y sus modulos pendientes.
Ficha de ultimo cierre: docs/MODULO_04_NOTIFICACIONES_PRESIDENCIA.md
```
