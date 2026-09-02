# Roadmap de revision modular

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

## Estado inicial del proceso

El siguiente modulo a revisar es:

```text
Modulo activo: Usuarios, roles y comunidades
Porcentaje de revision modular global: 2%
Objetivo inmediato: cerrar la base de permisos, alcance por comunidad y perfiles especiales antes de revisar tareas/proyectos.
Ficha activa: docs/MODULO_01_USUARIOS_ROLES_COMUNIDADES.md
```
