# ERP 4 - Implementacion de domiciliaciones, mandatos y remesas

Fecha: 11/09/2026. Continuidad de implementacion, no nuevo diseno.

Contrato: [ERP 4](ERP_04_DOMICILIACIONES_SEPA_REMESAS.md).
Estado y metodologia: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md).
Dependencia economica: [cierre ERP 3](ERP_03_RECIBOS_COBROS_DEUDA_IMPLEMENTACION.md).

## Estado verificable

DESARROLLO. Diseno 100%. Implementacion **25% certificado**; aceptacion funcional completa pendiente.
No publicado. No hay rutas, dispatcher ni interfaz ERP 4 activos.
No se han tratado datos bancarios reales ni migrado produccion.

| Hito | Evidencia | Certificacion |
| --- | --- | --- |
| 4A Fundamentos y migracion | Migraciones 13-15 aditivas sobre copia, integridad/FK, permisos bancarios explicitos, cifrado, regresiones y restauracion de codigo/datos/secretos comprobada | 25 puntos |
| 4B Servicios deterministas | Cuentas, mandatos, domiciliaciones y reservas parciales; faltan XML/resultados y servicios detallados abajo | Sin puntos |
| 4C Recorrido integrado | No implementado | Sin puntos |
| 4D Aceptacion y publicacion | No implementado; 28 pruebas del nucleo no equivalen a los 50 casos del contrato | Sin puntos |

## Checkpoint y recuperacion previa

- Commit anterior: `f3b538e0243834fa08bbd920a80adfa6a290ae0d`.
- Contrato y roadmap cerrados en `dd7f2e3`; tag `erp4-pre-20260911`.
- Cambios ajenos conservados sin incluir: `ERP_UX_PRINCIPIOS.md` y `ERP_REFERENCIAS_SECTOR_UX.md`.
- Servicio Ubuntu `organizador-web.service` comprobado activo. Codigo productivo comprobado: `de064928e43eabda69a1e6482dd4f56cae7bb1a7`.
- Backup independiente: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260911-181120`.
- Restauracion previa: `/tmp/organizador-erp0-restore-dnnmfppc`; 166 tablas, integridad correcta y runtime accesible.
- Copia local de trabajo: `backups/erp4-pre-20260911.db`. Todos los fixtures se derivan de esta copia y permanecen aislados.
- No se han sobrescrito backups ni checkpoints ERP 0-3. No se ha tocado Marbella UNO.

## Bloques incorporados

### Migraciones y limites

- 13 `erp4_banking_foundations`: cuentas cifradas, relaciones con sujetos, tesoreria/acreedor, mandatos/versiones/firmantes/eventos, domiciliaciones/versiones, prenotificaciones, remesas/revisiones/lineas/reservas, ficheros/presentaciones/resultados, identidades de operaciones e importaciones.
- 14 `erp4_economic_reservation_guards`: impide anulacion de recibo reservado y marca remesa para revision ante cambio de version economica. La consulta previa ERP 3 muestra el conflicto antes de confirmar; la guarda SQL protege la transaccion.
- 15 `erp4_mandate_scope_integrity`: alcance mandato-propiedad con FK compuesta por comunidad e historico inmutable. El JSON de propiedades es evidencia, no segunda relacion rectora.
- Migraciones anteriores sin cambios de checksum. Versiones y snapshots protegidos por triggers. Reserva activa unica por comunidad/recibo y no reabrible ni borrable.
- Varias tablas son preparacion de contrato: su existencia NO acredita servicios, XML, interfaz o procesamiento bancario.

### Seguridad y comandos

- `BankVault`: AES-256-GCM, DEK por comunidad envuelta con KEK externa, AAD por comunidad/secreto/finalidad/version. Indices HMAC con claves distintas del cifrado.
- Claves fuera de repositorio, base y archivo de aplicacion. Aprovisionamiento explicito, sin generacion silenciosa al iniciar. En POSIX se comprueban propietario y permisos del fichero.
- Rotacion de KEK probada sin alterar ciphertext. Reintentos tras rotacion HMAC localizan claves retenidas del comando anterior; retirar claves antiguas requiere futura migracion controlada, no borrar el fichero de claves.
- IBAN validado mediante `python-stdnum`, identidad bancaria deduplicada mediante HMAC, respuestas enmascaradas. Contexto sensible cifrado; no IBAN completo en auditoria/outbox ni claves de idempotencia persistidas en claro.
- Capacidades bancarias explicitas por comunidad, incluso para superusuario. Sesion y permisos se vuelven a comprobar en reintentos. Origen IA/agente rechazado para comandos bancarios.
- `from_runtime` cerrado por defecto y exige opt-in, POSIX, declaracion HTTPS y clave externa. Esto NO certifica despliegue HTTPS, custodia productiva ni el futuro permiso de revelacion completa: faltan integracion y aceptacion especificas.

### Dominio parcial operativo en pruebas

- Alta/deduplicacion/bloqueo de cuenta, vinculos historicos con sujetos ya existentes, listado enmascarado.
- Cuenta acreedora minima e identificador de acreedor validado; activacion bancaria real pendiente de perfil/configuracion.
- Mandato pendiente, activacion, suspension/revocacion, revisiones y cambio de cuenta sin reescribir historico; firmantes distintos del pagador; RUM protegida frente a colisiones.
- Domiciliaciones masivas basadas en configuraciones de cobro ERP 2, con validacion atomica de comunidad, pagador y alcance del mandato. No se duplican propietarios ni personas de cobro.
- Registro de evidencia de prenotificacion; previsualizacion y preparacion de remesa con cantidades exactas, huella de propuesta y datos bancarios congelados/cifrados.
- Reservas exclusivas transaccionales, concurrencia de dos preparaciones, rechazo de propuestas obsoletas, cancelacion local anterior a exportacion y liberacion sin tocar deuda.
- Saldo/obligados/pagador leidos de ERP 3. Preparar/cancelar no crea cobro, devuelve dinero ni cambia deuda.

## Pruebas ejecutadas

Runtime aislado e ignorado por Git: `backups/erp4-runtime/Scripts/python.exe`.
Dependencias fijadas en `server/requirements-erp4.txt`: cryptography 46.0.7, lxml 6.1.3 y python-stdnum 2.2. lxml esta preparado, aun no hay adaptador XML.

| Comando (desde raiz) | Resultado | Evidencia aislada |
| --- | --- | --- |
| `scripts/verify-erp4-foundations.py backups/erp4-pre-20260911.db` | 28/28 correctas, 27,408 s; integridad, FK e historicos comprobados por caso | `%TEMP%/organizador-erp4-foundations-g_7t6ycw` |
| `scripts/verify-erp0-foundations.py` sobre copia | 11 comprobaciones correctas | `%TEMP%/organizador-erp0-foundations-kok6jtmp` |
| `scripts/verify-erp1-master-data.py` sobre copia | 26 comprobaciones correctas | `%TEMP%/organizador-erp1-master-data-h6n9uty5` |
| `scripts/verify-erp2-complete.py` sobre copia | Recorrido completo correcto, incluido 40/16 | `%TEMP%/organizador-erp2-complete-mx_spe76` |
| `scripts/verify-erp3-foundations.py` sobre copia | 42/42 correctas | `%TEMP%/organizador-erp3-foundations-f4hq7nvm` |

Los 28 casos cubren cifrado/manipulacion/AAD, restauracion con clave correcta/incorrecta, rotacion KEK/HMAC, ausencia de privilegios implicitos, aislamiento, idempotencia, cuenta compartida, mandato revocado, cambios historicos, alta masiva atomica, reservas concurrentes, cancelacion y guardas ERP 3. Incluyen el pagador real de ERP 3 con campos de presentacion adicionales al tipo/ID.

No se han ejecutado aun los 50 casos completos del contrato, XSD, interfaz escritorio/movil ni smoke test ERP 4 en Ubuntu. No contabilizarlos como realizados.

## Mejoras autonomas implementadas

- Problema: RUM/IBAN u otros datos podian llegar al registro general mediante motivo o clave aportada por el cliente. Solucion: contexto cifrado y huellas de peticion/idempotencia HMAC. Beneficio: trazabilidad sin secretos en el log. Prueba 14.
- Problema: rotar HMAC podia convertir un reintento en comando nuevo. Solucion: busqueda en indices retenidos y reutilizacion de la identidad anterior. Prueba 28.
- Problema: anulacion legacy podia eludir una reserva bancaria. Solucion: guarda en propuesta ERP 3 y trigger transaccional, sin cambiar el saldo ni las reglas de anulacion. Pruebas 25-26 y regresion ERP 3.
- Problema: comparar objetos de pagador completos dependia del nombre mostrado. Solucion: identidad por tipo/ID, conservando el resto en el snapshot. Fixture ERP 3 con nombre y reserva correcta.

## Pendientes exactos de continuacion

Continuar desde estos servicios, sin reiniciar migraciones ni repetir el diseno:

1. Completar servicios 4B: cambio historico de domiciliacion y configuracion, alcance por concepto/pagador, perfiles bancarios y puertas de activacion, enmiendas completas, prenotificaciones/acuerdos excepcionales, consulta/importacion observada, ciclo de inactividad/mandato puntual y revisiones de propuestas.
2. Implementar adaptador CORE `pain.008.001.08`, validacion XSD oficial y reglas del perfil, sumas/referencias, artefacto cifrado inmutable y descarga auditada. No usar namespaces TVS de pruebas como namespace de fichero bancario productivo.
3. Presentacion/cancelacion posterior a exportacion, retirada confirmada, resultado por intento/linea y referencias externas, rechazo/devolucion/reenvio humano. Usar identidad canonica de operacion y primitivas ERP 3 en la misma transaccion; no abrir dos transacciones SQLite anidadas ni crear una deuda paralela.
4. Completar seguridad integrada: HTTPS real del gateway, revelacion con reautenticacion, ACL de evidencias/exportaciones, provisionado/custodia y restauracion operativa en Ubuntu, rotacion y retirada controlada de indices. Claves/configuracion productivas NO aprovisionadas.
5. Integrar dispatcher y HTTP, vistas Bancos y remesas del design system actual, enlaces de comunidad/propiedad/propietario, seleccion masiva y revision comprensible. No hay UI ERP 4 que pueda probarse aun.
6. Completar matriz A01-A50, recorridos economicos con ERP 3, pruebas escritorio/movil, regresiones finales, checkpoint/backup/restauracion y solo entonces publicacion y smoke test Ubuntu. No publicar este estado parcial.

No hay nueva decision funcional material que requiera al usuario. Configuraciones bancarias reales y seguridad de implantacion siguen siendo puertas obligatorias del contrato, no autorizacion para operar con datos reales ahora.

## Restauracion del checkpoint parcial

`scripts/verify-erp4-checkpoint.py` archiva el commit, genera backup mediante ERP 0 y lo restaura aisladamente. Verifica todos los hashes de tablas, integridad/FK y descifrado usando el codigo restaurado y una copia independiente de la clave de pruebas. La clave no entra en el archivo de aplicacion. La prueba requiere un fixture sintetico con secretos, nunca una base productiva.

Comprobacion final superada con codigo `6a6363ddc515fb5022e09af3d8a6d0c8a2283e42`:

- Backup: `backups/erp4-progress-foundations-20260911/erp0-backup-20260911-204659`.
- Restauracion: `%TEMP%/organizador-erp0-restore-v5z1r_8x`.
- Custodia independiente de la clave sintetica: `%TEMP%/erp4-checkpoint-custody-so6l66y3`.
- 196 tablas con hashes identicos; integridad y FK correctas; valores descifrados identicos; claves excluidas del archivo de aplicacion.
- Evidencia mecanica: `erp4-restore-proof.json` dentro del backup. El codigo utilizado para descifrar procede del archivo restaurado, no del working tree.
- Checkpoint de continuidad: `erp4-progress-foundations-20260911`. Los cambios posteriores al commit de codigo son documentales; no modifican migraciones ni datos.
- Estos fixtures y sus claves son recuperacion sintetica de prueba, no custodia bancaria productiva. No borrar la copia de clave antes de acabar la validacion; en produccion se necesitara almacenamiento independiente duradero, ACL, retencion y ensayo de perdida del servidor.

## Publicacion

No realizada. Produccion conserva ERP 0-3 y su configuracion previa. ERP 4 no esta listo para uso bancario ni para declarar cerrado su contrato operativo hacia ERP 5.
