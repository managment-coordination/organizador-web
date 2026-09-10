# ERP 0 - Fundamentos: implementacion

Estado de esta ficha: implementacion candidata, 10/09/2026. [Roadmap ERP](ERP_COMUNIDADES_ROADMAP.md) | [Modelo maestro](ERP_MODELO_DATOS_MAESTROS.md). No implementa ERP 1.

## Estado inicial y checkpoint

- Commit inicial limpio: `a3c12023bb6347ba3eca2bdd3cadebaa82204963`.
- Tag recuperable local y GitHub: `erp0-checkpoint-20260910-a3c1202`.
- Produccion seguia operativa en Ubuntu antes de editar.
- Backup previo independiente: `/home/coordinador/apps/organizador-web/backups/before-erp0-20260910-103208`.
- Contenido: `database.db`, codigo/configuracion/documentos en `application-and-documents.tar.gz` y `manifest.json`. Permisos restringidos.
- Verificacion: checksums SHA-256, apertura SQLite, `integrity_check=ok`, 67 tablas del esquema original y extraccion segura en `/tmp`; la carpeta temporal se elimino tras la prueba.

El manifiesto previo registra SHA-256 de base y archivo. La clave Git identifica el codigo. Git no contiene ni sustituye la base, `.env` o documentos.

## Cambios realizados

Nuevo paquete `server/erp_core`, sin pantallas ni datos ERP 1:

- `contracts.py`: sobres tipados y estrictos de comando/consulta. Comunidad obligatoria; actor derivado de sesion; payload validado por servicio; idempotencia y version opcionales; motivo, origen y evidencia acotados. Campos desconocidos se rechazan.
- `database.py`: conexiones con FKs, espera ocupada y `BEGIN IMMEDIATE`; commit o rollback en el limite del servicio.
- `repository.py`: SQL del ejemplo separado de reglas, permisos y transaccion.
- `service.py`: recorrido de referencia completo para el estado tecnico ERP por comunidad. La operacion de escritura solo existe si `ERP0_REFERENCE_COMMANDS=1`; las instalaciones normales no la exponen como comando disponible.
- `dispatcher.py` y `erp-bridge.py`: registro cerrado de herramientas. No existe SQL libre ni nombre de funcion ejecutable enviado por el cliente.
- `audit.py`: eventos estructurados en la misma transaccion y proyeccion minima compatible en `auditoria`; rechaza campos sensibles conocidos.
- `outbox.py`: alta atomica, reclamacion corta y confirmacion/fallo posterior. La llamada externa ocurriria despues de cerrar la transaccion; no se conecta ningun servicio.
- `migrations.py`: registro ERP ordenado, transaccional y con checksum. El mecanismo legado `web_migrations` se conserva; futuras migraciones ERP usan el nuevo registro. Modificar una migracion aplicada produce fallo claro.
- `server/index.js`: dos contratos internos autenticados (`/api/erp/query`, `/api/erp/command`) conectados al puente. Toda `/api/*` sigue refrescando la sesion desde backend. Errores de contrato/conflicto/no encontrado tienen 400/409/404.
- `access_control.migrate`: aplica al final la serie ERP 0, tanto en instalaciones existentes como nuevas compatibles. No se alteran tablas maestras financieras existentes.

El ejemplo persistente `erp_community_foundation` no es una configuracion economica ni una segunda tabla de comunidades. Solo prueba el patron y version por comunidad; queda vacio en produccion salvo uso interno expresamente habilitado. En produccion `ERP0_REFERENCE_COMMANDS` debe permanecer ausente.

## Migracion ERP 0

Version `1 / erp0_foundations`, exclusivamente aditiva:

- `erp_schema_migrations`: version, nombre, checksum y UTC.
- `erp_command_log`: idempotencia local por comunidad+comando+clave y hash de solicitud.
- `erp_audit_events`: actor, comunidad, antes/despues, motivo, origen, request, version, UTC y evidencia.
- `erp_outbox`: evento persistente, deduplicacion, estado, intentos y proxima disponibilidad.
- `erp_community_foundation`: registro tecnico versionado del ejemplo.
- indices de consulta de auditoria, comandos y cola.

No se eliminan restricciones globales heredadas. Siguen documentadas para ERP 1: `cf_propiedades.codigo_normalizado`, `cf_propietarios.codigo_netfincas`, proveedor/CIF, alias/equivalencias, cuentas contables y hashes bancarios. No se corrige una UNIQUE quitandola sin adaptar consumidores y reconciliar datos.

## Garantias y limites

- Seguridad: permiso backend de lectura/escritura en la comunidad; el rol enviado por cliente no pertenece al contrato. La sesion se refresca contra usuarios/permisos antes de la ruta.
- Atomicidad: cambio, auditoria, outbox y finalizacion idempotente comparten `BEGIN IMMEDIATE`. Un fallo intermedio no deja ninguno.
- Idempotencia: misma clave+contenido devuelve el resultado almacenado; misma clave con otro contenido da conflicto. Cada servicio futuro decide cuando exigir clave.
- Concurrencia: `expected_version` compara dentro de la transaccion de escritura; conflicto 409 obliga a releer.
- Auditoria: compatible, estructurada y no criptograficamente inmutable. La migracion se traza mediante version/checksum/UTC. No se serializa automaticamente todo el payload.
- Outbox: el dominio deposita un payload minimo seguro. Un worker reclama y cierra transaccion antes de llamar fuera; resultados se marcan en otra transaccion. No hay worker ni integracion externa en ERP 0.
- Aislamiento: las nuevas tablas tienen comunidad y claves idempotentes locales. La integridad N:M futura requerira FKs/validaciones compuestas del mismo tenant en ERP 1; `id_comunidad` aislado no basta.
- SQLite: se mantiene. `BEGIN IMMEDIATE` serializa escrituras ERP criticas. Debe medirse concurrencia real antes de considerar otro motor.

No hay promesa de ocultar datos a quien administre directamente el fichero SQLite o el servidor. Los permisos son de aplicacion. Los campos financieros nuevos deben usar proyecciones seguras y no guardar tokens, claves, passwords o IBAN completos en auditoria/outbox/logs.

## Backup y restauracion reproducibles

Crear copia:

```bash
python3 scripts/erp0-backup.py \
  --app /home/coordinador/apps/organizador-web \
  --output-root /home/coordinador/apps/organizador-web/backups
```

La copia usa la API de backup SQLite aunque el servicio este activo, empaqueta codigo/configuracion/documentos sin duplicar la base/WAL y genera manifiesto con commit, recuentos y SHA-256. No enviar `.env`, documentos o backup a GitHub.

Verificar/restaurar de ensayo, sin tocar produccion:

```bash
python3 scripts/verify-erp0-backup.py /ruta/al/backup
```

Procedimiento de recuperacion real:

1. Identificar backup y commit del mismo manifiesto. Validarlo con el comando anterior.
2. Detener solo `organizador-web.service`; no tocar UNO Marbella.
3. Crear antes otro backup del estado fallido para no perder operaciones posteriores.
4. Extraer `application-and-documents.tar.gz` en una carpeta temporal, nunca directamente sobre la app.
5. Comprobar que la ruta destino resuelta es exactamente `/home/coordinador/apps/organizador-web`.
6. Restaurar codigo/configuracion/documentos del staging y `database.db` como `data/organizador_tareas.db`. Mantener `backups/`.
7. Comprobar checksums, `PRAGMA integrity_check`, recuentos y commit compatible antes de iniciar.
8. Iniciar solo `organizador-web.service`; probar localhost, Tailscale, cinco perfiles y rutas de solo lectura.

Si existen operaciones reales posteriores al backup, no sobrescribirlas silenciosamente: conservar ambas copias y conciliarlas antes de volver a servicio. La restauracion no es un `git reset`; codigo y datos deben corresponder.

## Pruebas y evidencia

`scripts/verify-erp0-foundations.py` opera siempre sobre otra copia SQLite. Cubre migracion ordenada y reejecutable, rollback de migracion defectuosa, permiso de comunidad, contrato de actor, rollback despues de escritura, idempotencia, contenido distinto, version obsoleta, auditoria/outbox atomicos, rechazo de campo sensible y `integrity_check`.

`scripts/verify-operational-release.mjs` incorpora el contrato HTTP: comunidad permitida/no permitida, Consulta sin escritura, rol inyectado rechazado, reintento, conflicto y SQL arbitrario no registrado. Mantiene la bateria existente de usuarios, tareas/proyectos, presidencia, documentos/informes, seguridad, asambleas e IA.

Los scripts de backup/restauracion se probaron primero con una copia local. El checkpoint anterior se restauro y verifico en un directorio temporal de Ubuntu. Las rutas temporales nunca son la base real.

## Estado final y pendientes

El estado/porcentaje definitivo se registra al terminar pruebas en staging Ubuntu, migracion de produccion, validacion posterior y copia ya en formato ERP 0. Hasta entonces no usar esta ficha para declarar COMPLETADO.

ERP 1 sigue sin implementar. Antes de comenzarlo hay que confirmar las decisiones funcionales ya documentadas sobre identidad entre comunidades y, antes del motor de cuotas, corte/prorrateo y destinatario en copropiedad. No bloquean ERP 0.
