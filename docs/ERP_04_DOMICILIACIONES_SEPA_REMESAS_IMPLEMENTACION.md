# ERP 4 - Implementacion de domiciliaciones, mandatos y remesas

Fecha: 11/09/2026. Continuidad de implementacion, no nuevo diseno.

Contrato: [ERP 4](ERP_04_DOMICILIACIONES_SEPA_REMESAS.md).
Estado y metodologia: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md).
Dependencia economica: [cierre ERP 3](ERP_03_RECIBOS_COBROS_DEUDA_IMPLEMENTACION.md).

## Estado verificable

DESARROLLO. Diseno 100%. Implementacion **25% certificado**; aceptacion funcional completa pendiente.
No publicado. Rutas bancarias dedicadas preparadas y cerradas por defecto; sin interfaz ERP 4 ni recorrido web certificado.
No se han tratado datos bancarios reales ni migrado produccion.

| Hito | Evidencia | Certificacion |
| --- | --- | --- |
| 4A Fundamentos y migracion | Migraciones 13-15 aditivas sobre copia, integridad/FK, permisos bancarios explicitos, cifrado, regresiones y restauracion de codigo/datos/secretos comprobada | 25 puntos |
| 4B Servicios deterministas | Exportacion cifrada, resultados y efectos atomicos ERP 3, reenvios y consultas incorporados; quedan operaciones de contrato y seguridad integrada por cerrar | Sin puntos |
| 4C Recorrido integrado | No implementado | Sin puntos |
| 4D Aceptacion y publicacion | No implementado; las pruebas del nucleo/adaptador no equivalen a los 50 casos integrales del contrato | Sin puntos |

## Checkpoint y recuperacion previa

- Commit anterior: `f3b538e0243834fa08bbd920a80adfa6a290ae0d`.
- Contrato y roadmap cerrados en `dd7f2e3`; tag `erp4-pre-20260911`.
- Cambios ajenos conservados sin incluir: `ERP_UX_PRINCIPIOS.md` y `ERP_REFERENCIAS_SECTOR_UX.md`.
- Servicio Ubuntu `organizador-web.service` comprobado activo. Codigo productivo comprobado: `de064928e43eabda69a1e6482dd4f56cae7bb1a7`.
- Backup independiente: `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260911-181120`.
- Restauracion previa: `/tmp/organizador-erp0-restore-dnnmfppc`; 166 tablas, integridad correcta y runtime accesible.
- Copia local de trabajo: `backups/erp4-pre-20260911.db`. Todos los fixtures se derivan de esta copia y permanecen aislados.
- Continuacion desde `686896a513238b2f815da36a2d9ebe9ec5aa4b06`, checkpoint previo `erp4-pre-integration-20260911`. No se repitieron ni modificaron migraciones 13-15.
- No se han sobrescrito backups ni checkpoints ERP 0-3. No se ha tocado Marbella UNO.

## Bloques incorporados

### Migraciones y limites

- 13 `erp4_banking_foundations`: cuentas cifradas, relaciones con sujetos, tesoreria/acreedor, mandatos/versiones/firmantes/eventos, domiciliaciones/versiones, prenotificaciones, remesas/revisiones/lineas/reservas, ficheros/presentaciones/resultados, identidades de operaciones e importaciones.
- 14 `erp4_economic_reservation_guards`: impide anulacion de recibo reservado y marca remesa para revision ante cambio de version economica. La consulta previa ERP 3 muestra el conflicto antes de confirmar; la guarda SQL protege la transaccion.
- 15 `erp4_mandate_scope_integrity`: alcance mandato-propiedad con FK compuesta por comunidad e historico inmutable. El JSON de propiedades es evidencia, no segunda relacion rectora.
- 16: perfiles bancarios versionados, vinculo de revision con perfil, eventos inmutables por intento, aplicaciones de resultados y tickets de descarga. Probada exclusivamente sobre copias.
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

### Adaptador SEPA y conexion con servicios

- `banking_adapter.py`: generacion CORE `pain.008.001.08` con lxml, estructura/direcciones/importe exacto, grupos por secuencia, referencias unicas y bytes reproducibles para las mismas entradas.
- XSD oficiales ISO `pain.008.001.08` y `pain.002.001.10` incorporados sin modificacion, con URL y SHA-256 en `server/erp_core/banking_xsd/README.md`. Verificacion del checksum en ejecucion; no descarga de XSD ni resolucion de entidades en runtime.
- Parser `pain.002.001.10`: acuse/ACSC es tecnico, no acredita cobro; RJCT identifica rechazo, pendiente conserva incertidumbre. El servicio expande referencias exactas de fichero/grupo/linea, conserva fuente cifrada y deja referencias desconocidas pendientes, sin casarlas por similitud.
- Configuracion tipada persistida y versionada de calendario, corte, zona horaria, limites, paises y modo prueba/real; modo real exige declaraciones de aceptacion del perfil y revision de instrucciones externas. Falta configuracion UX y verificacion de implantacion; esto no habilita exportacion real.
- Validacion adicional de localidad obligatoria, mandato puntual sin dos instrucciones en el lote, datos originales para enmienda, IBAN correcto, cantidades exactas y direcciones estructuradas. No truncado silencioso.
- Cargas limitadas a 16 MiB/32 niveles/200000 elementos; DTD/XXE rechazados, errores sin revelar datos del fichero. No log de errores XSD con valores sensibles.
- Preparacion congela secuencia, concepto, perfil/configuracion y datos originales de enmienda. Generacion XML fuera del lock; antes de persistir se revalidan huella y version dentro de transaccion. Artefacto cifrado e inmutable; ticket temporal ligado a usuario/version de autenticacion; descarga revalida permiso y checksum. No hay todavia ruta HTTP de descarga ni prueba de navegador de este flujo.

### Resultados y ciclo por intento

- `banking_files.py`: configurar perfil, generar artefacto, exportar, descargar, registrar presentacion, solicitar retirada y acreditar no presentacion. Exportar/presentar no escribe cobros. Solicitar retirada no libera reservas.
- `banking_results.py`: staging manual/XML, revision, resolucion explicita de referencias pendientes y confirmacion. Una resolucion conserva la fuente anterior y necesita despues confirmacion del efecto; no reinterpreta resultados ya confirmados.
- `ReceivablesService.in_transaction`: reutiliza los comandos economicos existentes dentro de la transaccion ERP 4. Valida que la conexion corresponde a la misma base y no abre/termina otra transaccion. Cobro, imputacion o devolucion, identidad bancaria, evento y reserva se confirman o revierten conjuntamente.
- Identidad canonica protegida por HMAC; mismo hecho en otro fichero enlaza la operacion existente; misma identidad con distinto contenido bloquea. No emparejamiento por importe/nombre. Referencias insuficientes no generan fondos.
- Cobro real permite imputacion expresamente revisada; sobrante queda disponible ERP 3. Devolucion requiere cobro identificado e importes/reversos revisados. No crea deuda paralela.
- Reenvio requiere referencia explicita al intento cerrado, nueva preview/confirmacion y nueva referencia. Resultado pendiente/contradictorio impide reenvio; un rechazo tardio nunca libera la reserva nueva. Liquidacion posterior a cancelacion conserva fondos y marca contradiccion/revision.
- Cambio masivo de domiciliacion exige versiones actuales y fecha posterior; crea revisiones sin reescribir anteriores. Consulta de propiedad deriva intervalos historicos. Plazo excepcional de prenotificacion exige acuerdo documentado conservado en la revision del mandato.
- Pagador distinto del recibo requiere autorizacion explicita para cada recibo/mandato, con evidencia validada y congelada en la revision cifrada. No cambia pagador emitido, destinatario ni obligados.
- `banking_queries.py`: vistas enmascaradas de comunidad, acreedores, mandatos, domiciliaciones por propiedad, remesas/lineas/historico y resultados. Permiso de resultados independiente. No se publican fuentes bancarias ni IBAN completos por consultas genericas.
- `banking-http.js` / `banking-bridge.py`: transporte bancario separado; rutas genericas ERP rechazan operaciones ERP 4. HTTPS/origen/Host validados; proxy solo loopback explicitamente autorizado. Reautenticacion comprobando contrasena, limitada en intentos y ligada a sesion/comunidad durante cinco minutos; cuerpo de respuesta XML solo en descarga dedicada no cacheable. Fallos tecnicos no devuelven stderr ni trazas sensibles. Falta aceptacion HTTP real extremo a extremo en Ubuntu y ACL documental bancaria.
- Suspension/finalizacion de domiciliacion crea revision sin revocar cuenta ni mandato compartidos; reactivacion requiere nueva revision de pagador/mandato. Se invalida la preparacion afectada, no se borra deuda. Cambios de estado el mismo dia conservan las versiones y tiempo de registro anteriores.
- Importacion bancaria estructurada: origen/archivo/corte/filas cifrados, revision enmascarada, incidencias por fila, duplicados, confirmacion explicita de subconjunto y rollback atomico. Reimportar no duplica cuentas. Referencias observadas de mandato/propiedad/pagador permanecen observadas: no generan mandato activo, domiciliacion ni identidad por similitud. Falta interfaz de archivo/columnas y tratamiento del corte de instrucciones externas.
- Revelacion puntual de cuenta por ruta dedicada: permiso `reveal`, reautenticacion vigente y motivo protegido; auditoria solo enmascarada. Un error de contrasena de reautenticacion devuelve 403 para no invalidar indebidamente la sesion ordinaria.

## Pruebas ejecutadas

Runtime aislado e ignorado por Git: `backups/erp4-runtime/Scripts/python.exe`.
Dependencias fijadas en `server/requirements-erp4.txt`: cryptography 46.0.7, lxml 6.1.3, python-stdnum 2.2 y tzdata 2026.3. Esta ultima permite comprobar zonas horarias tambien en Windows sin depender de una base del sistema ausente.

| Comando (desde raiz) | Resultado | Evidencia aislada |
| --- | --- | --- |
| `scripts/verify-erp4-foundations.py backups/erp4-pre-20260911.db` | 29/29 correctas, 29,484 s; integridad, FK e historicos comprobados por caso | `%TEMP%/organizador-erp4-foundations-vuxqahi_` |
| `scripts/verify-erp4-adapter.py` | 17/17 correctas; XML/XSD, 200 lineas, suma 100 entre tres, esquema alterado, XXE, calendario, direcciones y acuse sin cobro | Fixtures en memoria, sin DB ni datos reales |
| `scripts/verify-erp0-foundations.py` sobre copia | 11 comprobaciones correctas | `%TEMP%/organizador-erp0-foundations-kok6jtmp` |
| `scripts/verify-erp1-master-data.py` sobre copia | 26 comprobaciones correctas | `%TEMP%/organizador-erp1-master-data-h6n9uty5` |
| `scripts/verify-erp2-complete.py` sobre copia | Recorrido completo correcto, incluido 40/16 | `%TEMP%/organizador-erp2-complete-mx_spe76` |
| `scripts/verify-erp3-foundations.py` sobre copia | 42/42 correctas, repetidas despues del adaptador en 29,318 s | `%TEMP%/organizador-erp3-foundations-6ppq5zki` |

Los 29 casos del nucleo cubren cifrado/manipulacion/AAD, restauracion con clave correcta/incorrecta, rotacion KEK/HMAC, ausencia de privilegios implicitos, aislamiento, idempotencia, cuenta compartida, mandato revocado, cambios historicos, alta masiva atomica, reservas concurrentes, cancelacion y guardas ERP 3. Incluyen el pagador real de ERP 3 con campos de presentacion adicionales al tipo/ID y rechazo del mandato puntual repetido en un mismo lote.

No se han ejecutado aun los 50 casos completos del contrato, interfaz escritorio/movil ni smoke test ERP 4 en Ubuntu. La validacion XSD sintetica no equivale a la aceptacion de ficheros por el banco. No contabilizar como realizados los recorridos integrados pendientes.

Continuacion integrada: **60/60** pruebas del nucleo correctas (67,766 s), fixture `%TEMP%/organizador-erp4-foundations-oxe7g5lr`. Incluyen exportacion sin cobro, bytes historicos, permiso/reautenticacion al descargar, presentacion, resultados duplicados, retorno ERP 3, rollback posterior a escritura economica, saldo a favor, reenvio, retirada, eventos tardios, consultas enmascaradas, historico de domiciliacion, acuerdo excepcional, tercero autorizado sin mover sujetos, resolucion revisable de referencia y rechazo de doble identidad para un mismo cobro. Caso 60 repetido tras anadir sesion sin reautenticacion, correcto en `%TEMP%/organizador-erp4-foundations-mso3_fm3`.

Regresiones de esta continuacion: ERP 0 **11 comprobaciones** (`organizador-erp0-foundations-1tezfvw7`), ERP 1 **26** (`organizador-erp1-master-data-ye0flkss`), ERP 2 recorrido completo/40-16 (`organizador-erp2-complete-_dwr5ppi`), ERP 3 **42/42** en 26,793 s (`organizador-erp3-foundations-sy0dewbo`), adaptador **17/17**. `node scripts/verify-erp4-http.mjs` correcto: HTTPS, proxy no suplantable desde red externa, origen, aislamiento, reautenticacion/expiracion, sesion distinta, limite de intentos y descarga no cacheable. `node --check server/index.js` correcto. Estas pruebas HTTP usan transporte simulado, NO navegador ni infraestructura productiva. Las pruebas unitarias numeradas NO equivalen a casos A01-A50 completos.

Ampliacion final del checkpoint de acceso: **64/64** pruebas del nucleo correctas, 72,722 s; fixture `%TEMP%/organizador-erp4-foundations-gwt42qa6`. Los cuatro casos adicionales verifican finalizacion individual sin revocar mandato compartido, importacion observada/reimportacion, rollback de importacion con filas invalidas y permiso/reautenticacion/auditoria de revelacion. Transporte HTTP repetido correctamente tras mantener la sesion ordinaria ante error de reautenticacion. El ejecutor admite seleccionar casos concretos despues del argumento de base para no repetir pruebas innecesariamente durante la continuacion.

## Mejoras autonomas implementadas

- Problema: RUM/IBAN u otros datos podian llegar al registro general mediante motivo o clave aportada por el cliente. Solucion: contexto cifrado y huellas de peticion/idempotencia HMAC. Beneficio: trazabilidad sin secretos en el log. Prueba 14.
- Problema: rotar HMAC podia convertir un reintento en comando nuevo. Solucion: busqueda en indices retenidos y reutilizacion de la identidad anterior. Prueba 28.
- Problema: anulacion legacy podia eludir una reserva bancaria. Solucion: guarda en propuesta ERP 3 y trigger transaccional, sin cambiar el saldo ni las reglas de anulacion. Pruebas 25-26 y regresion ERP 3.
- Problema: comparar objetos de pagador completos dependia del nombre mostrado. Solucion: identidad por tipo/ID, conservando el resto en el snapshot. Fixture ERP 3 con nombre y reserva correcta.
- Problema: validar solo XSD permitia omitir localidad y repetir un mandato puntual en instrucciones distintas. Solucion: guardas semanticas del adaptador y del lote. Pruebas de adapter 05/17 y dominio 29.
- Problema: conversion automatica de saltos de linea podia invalidar hashes de XSD al publicar en Ubuntu. Solucion: `.gitattributes` conserva bytes originales solo para estos esquemas; la prueba de restauracion ejecuta tambien el adaptador archivado.

## Pendientes exactos de continuacion

Continuar desde estos servicios, sin reiniciar migraciones ni repetir el diseno:

1. Completar operaciones 4B restantes: corte con reservas/instrucciones bancarias externas, enmiendas de RUM/acreedor con aliases/sucesion documentada, ciclo de inactividad/mandato puntual y resolucion de incidencias contradictorias ya confirmadas. Importacion observada de cuentas y suspension/finalizacion de domiciliacion ya estan implementadas; no repetirlas ni repetir generacion/XML, resultados o reenvio.
2. Completar casos de resultados: cobertura integral pain.002 a nivel servicio, retorno sin cobro previo con acreditacion terminal e incidencia, inversion postliquidacion y enlace UX al gasto independiente ERP 3. Identidades/aliases futuros ERP 5 no deben duplicar cobros manuales; mantener confirmacion humana.
3. Cerrar pruebas de todos los cambios del servicio y su integracion. Configuracion, excepciones de prenotificacion y terceros ya tienen contrato operativo en dominio; falta UX completa y puertas de implantacion. Conservar el adaptador/XSD actual.
4. Completar seguridad integrada: comprobar HTTPS real del gateway y revelacion/descarga extremo a extremo, ACL de evidencias/exportaciones, provisionado/custodia y restauracion operativa en Ubuntu, rotacion y retirada controlada de indices. Revelacion y reautenticacion de dominio/transporte ya incorporadas; claves/configuracion productivas NO aprovisionadas.
5. Completar/verificar extremo a extremo el transporte HTTP dedicado ya incorporado (no incorporar bancos al dispatcher general/IA), vistas Bancos y remesas del design system actual, enlaces de comunidad/propiedad/propietario, seleccion masiva y revision comprensible. No hay UI ERP 4 que pueda probarse aun. Configuracion preparada: `ERP4_PUBLIC_ORIGIN`, `ERP4_TRUST_LOOPBACK_PROXY`, ademas de los opt-in y custodia del contrato; no configurada en produccion.
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
- Checkpoint de fundamentos: `erp4-progress-foundations-20260911`. La ampliacion posterior del adaptador conserva las migraciones 13-15; se registra un segundo checkpoint y restauracion para ese codigo.
- Estos fixtures y sus claves son recuperacion sintetica de prueba, no custodia bancaria productiva. No borrar la copia de clave antes de acabar la validacion; en produccion se necesitara almacenamiento independiente duradero, ACL, retencion y ensayo de perdida del servidor.

Segundo checkpoint, adaptador incluido:

- Codigo: `173496ef9ed06b5b3faf325917e0f45dc2a662da` (adaptador en `7003633`, correccion de empaquetado XSD en `173496e`).
- Backup: `backups/erp4-progress-sepa-20260911/erp0-backup-20260911-205958`.
- Restauracion: `%TEMP%/organizador-erp0-restore-x2_8h2kn`; custodia independiente: `%TEMP%/erp4-checkpoint-custody-tjfnyx5w`.
- 196 tablas identicas, integridad/FK correctas, secretos recuperados y 17 pruebas del adaptador ejecutadas desde el codigo restaurado. Evidencia: `erp4-restore-proof.json` en el backup, `restored_adapter_tests_passed=true`.
- Incidencia detectada y corregida: el primer archivo Git habia normalizado XSD antes de aplicar `-text`; se reindexaron exclusivamente los dos esquemas para conservar sus bytes originales y se repitio la restauracion. La copia fallida anterior no acredita cierre y no se publico.
- Este checkpoint SEPA sigue siendo recuperable. La continuacion posterior incorpora migracion 16 y nuevos servicios; usar el ultimo checkpoint de resultados indicado abajo al retomar, no reiniciar desde este tag.

## Publicacion

No realizada. Produccion conserva ERP 0-3 y su configuracion previa; comprobacion final SSH: `organizador-web.service` activo. ERP 4 no esta listo para uso bancario ni para declarar cerrado su contrato operativo hacia ERP 5. El 75% restante sigue pendiente, no bloqueado por una nueva decision del usuario. No continuar a ERP 5.

## Checkpoint de resultados y transporte protegido

- Codigo: `7b8904f8849a01dc033d4411a6de7fd70d82a57d`; checkpoint de continuidad `erp4-progress-results-20260911`.
- Backup: `backups/erp4-progress-results-20260911/erp0-backup-20260911-220731`.
- Restauracion: `%TEMP%/organizador-erp0-restore-vhgw3h7y`; clave sintetica independiente en `%TEMP%/erp4-checkpoint-custody-10yyf3pd`.
- 201 tablas identicas, integridad/FK correctas, valores descifrados identicos y 17 pruebas del adaptador desde el codigo restaurado. Fuente sintetica con exportacion, cobro e imputacion ERP 3 y devolucion; no datos bancarios reales. Prueba mecanica `erp4-restore-proof.json` dentro del backup.
- Continuar desde este checkpoint y la lista de pendientes exactos, no desde `686896a`. No volver a implementar XML, transaccion compartida ERP 3, resultados/reenvios ni transporte protegido ya existentes.
- No publicar ni conceder el hito 4B hasta cerrar sus operaciones pendientes; tampoco habilitar datos bancarios reales por disponer de pruebas con claves temporales.
