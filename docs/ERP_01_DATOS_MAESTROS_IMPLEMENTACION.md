# ERP 1 - Datos maestros: implementacion

Estado: COMPLETADO, 10/09/2026. Implantacion certificada: 100% de ERP 1. [Roadmap ERP](ERP_COMUNIDADES_ROADMAP.md) | [Modelo maestro](ERP_MODELO_DATOS_MAESTROS.md) | [Titularidades, coeficientes y reparto](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md).

ERP 1 identifica y conserva comunidades, ejercicios, agrupaciones, propiedades, propietarios, contactos, titularidades, coeficientes y grupos. No implementa presupuestos, cuotas, recibos, SEPA ni contabilidad de ERP 2-7.

## Linea base, checkpoints y backups

- Linea base estable: commit `1a947d63f8c069d864ca851fdefd6c6d0ffecdc1`; tag recuperable `pre-erp1-20260910-1a947d6`.
- Checkpoint de dominio inicial: `eeb99e9`.
- Checkpoint estable de los bloques 1-3: tag `erp1-post-blocks-1-3-20260910`.
- Checkpoint estable de titularidades: tag `erp1-post-ownership-20260910`.
- Checkpoint estable de coeficientes y grupos: tag `erp1-post-coefficients-groups-20260910`.
- Los tres checkpoints estructurales apuntan a `adfc3d3`: la migracion de esquema es atomica y no se modificaron datos de produccion entre esos bloques.
- Compuerta de despliegue: commit `9930083b9bc293984348e899cde5a3d1f6af9ece`.
- Backup previo verificado: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-111627`.
- Backup inmediato del publicador: `/home/coordinador/apps/organizador-web/backups/before-operational-publish-20260910-122115`.
- Backup posterior completo: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260910-122302`.
- El backup posterior supero checksum, integridad, recuentos, migracion reentrante, sintaxis y arranque HTTP aislado con el codigo asociado.

El nombre historico `erp0-backup-v1` identifica el formato reutilizable del backup, no limita su contenido a ERP 0. Git no contiene la base ni sustituye estos respaldos.

## Migracion y datos conservados

La migracion versionada `2 / erp1_master_data` se ejecuto primero sobre copia real y despues en produccion. Es reentrante, usa checksum y comprueba `foreign_key_check` antes de confirmar. La reconstruccion necesaria de `cf_propiedades` y `cf_propietarios` conserva IDs y columnas legacy, elimina unicidades globales incompatibles y aplica claves naturales por comunidad.

Resultado productivo tras migrar:

| Control | Resultado |
|---|---:|
| Integridad SQLite | `ok` |
| Violaciones FK | 0 |
| Comunidades | 3 |
| Propiedades | 703 |
| Propietarios | 535 |
| Contactos | 1.151 |
| Relaciones propietario-propiedad | 703 |
| Recibos conservados | 16.289 |
| Filas de censo de asamblea conservadas | 703 |
| Tablas totales | 91 |

No se inventaron ejercicios ni agrupaciones a partir de nombres legacy: comienzan vacios hasta que se creen o acrediten. Los 703 coeficientes existentes se proyectaron en un unico grupo `LEGACY_GENERAL`, en estado de preparacion y calidad observada. Las 703 titularidades legacy se conservaron igualmente como observadas. Sus fechas de conocimiento proceden de la importacion cuando existe; en otro caso, de la fecha de migracion. Ningun valor heredado se declara validado sin evidencia.

## Bloques implementados

1. Comunidades ampliadas, configuracion versionada, ejercicios y bloqueos de periodo.
2. Agrupaciones jerarquicas, tipos configurables, propiedades, alias, relaciones y pertenencias estructurales.
3. Propietarios aislados por comunidad, persona fisica/juridica/desconocida, contactos tipados, verificacion y vigencia.
4. Titularidades N:M con propuestas revisables, composicion completa o incompleta, intervalos `[desde, hasta)` y doble tiempo efectivo/conocido.
5. Series y versiones de coeficientes en decimal exacto almacenado como texto canonico; el `REAL` legacy queda solo como proyeccion de compatibilidad.
6. Grupos de reparto configurables, versiones y pertenencias historicas. No existe todavia motor de reparto.
7. Procedencia de registros, referencias de importacion y enlaces documentales maestros.
8. Consultas y comandos deterministas mediante contratos allow-listed de ERP 0.
9. Interfaz web minima en `Herramientas > Datos maestros`, operativa en escritorio y movil.
10. Compatibilidad verificada con acceso, tareas, proyectos, presidencia, documentos, informes, seguridad, asambleas y Centro IA.

## Reglas operativas y seguridad

- Todo dato maestro pertenece a una comunidad; un codigo se puede repetir en otra comunidad sin colision.
- Los propietarios de comunidades distintas no se fusionan por nombre, NIF, email ni similitud.
- Lecturas y escrituras revalidan sesion y permiso de comunidad en backend.
- Cada comando exige clave de idempotencia y las ediciones exigen version esperada.
- Cambio, auditoria y outbox se confirman en la misma transaccion `BEGIN IMMEDIATE`.
- Una composicion completa validada suma exactamente 100; una suma superior se rechaza y una parcial permanece explicitamente incompleta.
- Confirmar una titularidad no mueve deuda, no altera recibos y no reescribe asambleas o informes historicos.
- La interfaz no expone SQL general; el dispatcher solo admite comandos y consultas registrados.

## Pruebas y evidencias

`scripts/verify-erp1-master-data.py` cubre los 19 escenarios obligatorios: varias propiedades por titular, copropiedad 60/40, venta efectiva, consultas 30/06 y 01/07, obligado historico intacto, exceso 110 bloqueado, cobertura parcial, idempotencia de importacion, correccion bitemporal, fecha incierta, varios coeficientes, salida de grupo, codigos aislados, anexos independientes, concurrencia, permisos, asamblea inmutable y restauracion. Tambien comprueba contactos, auditoria y outbox.

`scripts/verify-operational-release.mjs` supero 19 grupos de regresion sobre una copia con forma de produccion. `scripts/verify-release-ui.mjs` supero las vistas principales, incluida Datos maestros, a 1440x1000 y 390x844 sin desbordamiento de pagina. El despliegue repitio las pruebas ERP 1 y la regresion antes de publicar.

## Incidencias resueltas

- El primer paquete fue rechazado por contener raices no admitidas. La barrera funciono antes de cualquier publicacion; se genero un paquete limitado al alcance permitido.
- El primer ensayo detecto que la prueba de recuentos no exceptuaba el libro de migraciones ERP. Se corrigio para exigir que las migraciones anteriores sean subconjunto inmutable y permitir unicamente nuevas filas versionadas.
- La interfaz limitaba los selectores a 150 registros. Se amplio el servicio y la pantalla a 1.000, suficiente para los 703 inmuebles y 535 propietarios actuales, y se muestran totales reales.

## Compatibilidad y limites

Los lectores antiguos mantienen sus tablas e IDs. Los campos `coeficiente REAL` y `porcentaje_titularidad REAL` se conservan como compatibilidad temporal, pero ningun calculo nuevo debe usarlos. Las asambleas siguen usando sus snapshots y la deuda conserva su obligado historico.

La interfaz es deliberadamente la minima de ERP 1: alta/edicion y consulta de maestros, historicos, coeficientes y grupos. La importacion masiva revisable y las reglas economicas pertenecen a entregas posteriores. Antes de cualquier siguiente cambio estructural siguen siendo obligatorios checkpoint Git, backup independiente de SQLite y restauracion ensayada.

## Estado final

ERP 1 queda operativo y desplegado en el servidor Ubuntu en el puerto 8771. No quedan decisiones funcionales bloqueantes dentro de su alcance aprobado. El siguiente trabajo recomendado es definir y autorizar ERP 2 sobre estos maestros, sin reinterpretar los datos observados como evidencia validada.
