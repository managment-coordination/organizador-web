# Seguridad de datos

## Nunca subir a GitHub

- `data/`
- `backups/`
- `logs/`
- `.env`
- bases SQLite reales;
- adjuntos;
- informes;
- documentos de comunidades;
- claves API;
- claves SSH.

## Principio de IA

La IA no ejecuta cambios directamente.

Flujo obligatorio:

1. El usuario introduce consulta, llamada, reunion o documento.
2. La app muestra que datos se enviaran a la IA.
3. La IA devuelve una propuesta estructurada.
4. La app muestra una pantalla editable de confirmacion.
5. Solo al confirmar se guarda en la base de datos.
6. Toda accion importante queda auditada.

## Reglas de migracion

- La base original de Windows/OneDrive no se modifica.
- Primero se copia a servidor como snapshot de prueba.
- Despues se validan conteos y relaciones.
- Solo tras validacion se decide si la web pasa a ser fuente principal.
