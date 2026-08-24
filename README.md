# Organizador Web

Version web centralizada del Organizador de tareas, proyectos y gestion operativa.

## Objetivo

Convertir progresivamente la app local de Windows en una app web accesible desde PC y movil, con datos centralizados en el servidor Ubuntu y con IA integrada de forma controlada.

## Alcance del paso 1

Este repositorio contiene solo la base tecnica inicial:

- estructura de carpetas;
- servidor minimo;
- documentacion de seguridad;
- configuracion base;
- proteccion para no subir datos sensibles.

No contiene:

- base de datos real;
- adjuntos reales;
- API keys;
- backups reales;
- logs reales;
- datos personales.

## Estructura

```text
organizador-web
  server/    Backend Node.js
  web/       Interfaz web
  data/      Datos persistentes locales, fuera de GitHub
  backups/   Copias, fuera de GitHub
  logs/      Logs, fuera de GitHub
  scripts/   Scripts de despliegue y mantenimiento
  docs/      Documentacion tecnica y decisiones
```

## Servidor previsto

```text
Ruta: /home/coordinador/apps/organizador-web
Puerto: 8771
URL futura: http://100.108.29.39:8771
```

## Regla principal

Primero se migra y prueba una version reducida y segura. No se avanza al siguiente paso hasta confirmar el anterior al 100%.
