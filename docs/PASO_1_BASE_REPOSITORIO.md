# Paso 1 - Base del repositorio web

## Confirmacion funcional

Este paso queda cerrado cuando esten confirmados estos puntos:

- La carpeta local del repositorio existe.
- Git esta inicializado localmente.
- `.gitignore` protege datos sensibles.
- Existe una base minima de servidor web.
- El puerto previsto es `8771`.
- La carpeta prevista del servidor es `/home/coordinador/apps/organizador-web`.
- No se ha migrado ninguna base real.
- No se han copiado adjuntos reales.
- No se han guardado API keys.

## Decision tecnica

- Backend inicial: Node.js.
- Base de datos futura: SQLite en servidor.
- Datos persistentes: `data/`, fuera de GitHub.
- Adjuntos futuros: `data/uploads/`, fuera de GitHub.
- Backups: `backups/`, fuera de GitHub.
- Logs: `logs/`, fuera de GitHub.

## Siguiente paso, todavia no ejecutado

Crear el repositorio privado en GitHub y/o desplegar esta base minima en el servidor Ubuntu.

No pasar a migracion de datos hasta confirmar este paso al 100%.
