# Organizador Web

Version web centralizada del Organizador de tareas, proyectos y gestion operativa.

## Objetivo

Convertir progresivamente la app local de Windows en una app web accesible desde PC y movil, con datos centralizados en el servidor Ubuntu y con IA integrada de forma controlada.

## Estado actual

La version web centraliza actualmente:

- acceso con los usuarios y permisos de la app;
- consulta, alta, edicion y archivo de tareas y proyectos;
- seguimientos manuales e inteligentes con confirmacion;
- centro IA para consultas estructuradas y propuestas operativas;
- bandeja de acciones pendientes adaptada al usuario activo;
- revision diaria ejecutiva con filtros por comunidad y tipo de elemento;
- centro de notificaciones con lectura individual o conjunta;
- decisiones de Presidencia con comentario obligatorio, historial y devolucion automatica de responsabilidad;
- informes Word individuales de tareas y proyectos;
- subida multiple, vista previa y descarga protegida de anexos;
- datos y documentos persistentes en el servidor Ubuntu.

Los datos reales siguen excluidos de GitHub:

- base SQLite;
- anexos e informes;
- claves y sesiones;
- copias de seguridad y logs.
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
URL Tailscale: http://100.108.29.39:8771
```

## Regla principal

Primero se migra y prueba una version reducida y segura. No se avanza al siguiente paso hasta confirmar el anterior al 100%.
