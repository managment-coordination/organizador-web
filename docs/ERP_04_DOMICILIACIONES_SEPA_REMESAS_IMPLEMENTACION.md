# ERP 4 - Implementacion de domiciliaciones, mandatos y remesas

Actualizado: 14/09/2026. Continuidad de implementacion, no nuevo diseno.

Contrato: [ERP 4](ERP_04_DOMICILIACIONES_SEPA_REMESAS.md).
Estado y metodologia: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md).
Dependencia economica: [cierre ERP 3](ERP_03_RECIBOS_COBROS_DEUDA_IMPLEMENTACION.md).

## Estado verificable

PRUEBAS. Diseno 100%. Implementacion **75% certificado**; cierre de publicacion pendiente.
No publicado. Interfaz bancaria integrada en codigo y recorridos HTTPS sobre copia verificados; falta la aceptacion completa y custodia productiva. La operativa bancaria real permanece deshabilitada.
No se han tratado datos bancarios reales ni migrado produccion.

| Hito | Evidencia | Certificacion |
| --- | --- | --- |
| 4A Fundamentos y migracion | Migraciones 13-15 aditivas sobre copia, integridad/FK, permisos bancarios explicitos, cifrado, regresiones y restauracion de codigo/datos/secretos comprobada | 25 puntos |
| 4B Servicios deterministas | 84/84 del nucleo; 17/17 del adaptador; servicios restantes, lote 200, rollback de artefacto, resultados ERP 3, custodia POSIX y restauracion sintetica acreditados. Casos adicionales 85-88 de seleccion, parcial, ejercicio cerrado y gasto independiente superados | 25 puntos |
| 4C Recorrido integrado | Aplicacion completa con login HTTPS/POSIX: propiedad/propietario/comunidad, mandato, seleccion, XML, rechazo masivo, reenvio y gasto ERP 3. Navegador con 200 recibos, dos paginas, documentos y Excel revisado; 1440/1920/390 sin desbordamiento | 25 puntos |
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

1. Checkpoint de aceptacion, backup/restauracion con el codigo final y esquema 18. Los servicios, acciones UX y recorridos descritos anteriormente estan terminados; no reiniciarlos.
2. Preparar runtime bancario independiente de los ERP anteriores, ejecutar las regresiones finales en copia Ubuntu, publicar el candidato solo si pasan las puertas y verificar restauracion posterior, rutas, aislamiento e integridad productiva.
3. Mantener bancaria real y acceso sensible deshabilitados hasta HTTPS acreditado y configuracion bancaria por comunidad. Esto no bloquea el cierre tecnico autorizado, pero no equivale a una remesa aceptada por el banco.

No hay nueva decision funcional material que requiera al usuario. Configuraciones bancarias reales y seguridad de implantacion siguen siendo puertas obligatorias del contrato, no autorizacion para operar con datos reales ahora.

## Continuacion operativa 14/09/2026

### Candidato de aceptacion integral

Este apartado prevalece sobre los estados parciales historicos de este documento.

- Nucleo final: **91/91**, 143,477 s, `%TEMP%/organizador-erp4-foundations-f2due_p1`. Los casos 85-91 cubren seleccion paginada/subconjunto, devolucion parcial, ejercicio cerrado, cobro manual con remesa exportada, gasto ERP 3 independiente, saldo parcial/cero/anulado, fuente observada separada, domiciliacion ambigua/especifica y representante/cuenta conjunta/RUM con extension comercial. Casos 90-91 repetidos tras ampliar las variantes: `organizador-erp4-foundations-blg54qb0`.
- Web masiva **200 recibos** con dos paginas, confirmacion sin incorporar filas nuevas, XML 200 lineas, cobro/devolucion y reenvio de una sola linea, cancelacion y corte externo: `organizador-erp4-foundations-uf0guquh/test_74_operational_selectors_use_same_domain_and_tenant`. `node scripts/verify-erp4-web.mjs --bulk`, HTTPS y servicios reales sobre copia.
- Aplicacion completa en Ubuntu aislado: `node scripts/verify-erp4-app.mjs`, evidencia `%TEMP%/erp4-full-app-ABuP3K`; login/cookie Secure, propiedad -> mandato -> seleccion -> exportacion -> rechazo por lote -> reenvio -> cancelacion, contexto propietario/comunidad y acceso al gasto independiente ERP 3. 1440/1920/390; sin errores JS ni overflow. Clave POSIX real del entorno de prueba, no inyeccion de constructor.
- Ubuntu aislado: `/home/coordinador/apps/organizador-web-erp4-validation-20260914-0912`. `linux-proof.json` acredita `from_runtime`, descifrado/restauracion y permisos POSIX. No se ha usado el servicio ni datos bancarios productivos para estas operaciones.
- `notification.draft` no registra envio; la UI exige confirmar envio ya realizado antes de `notification.record`. Cambiar seleccion/fecha/autorizacion invalida ese reconocimiento. Acuses/rechazos masivos pasan por los mismos preview/confirm. Excepciones conservan evidencia y no trasladan deuda.
- MEJORA UX AUTONOMA: instrucciones anteriores reutilizan busqueda/seleccion/paginacion, sin exigir un acreedor nuevo para documentar un corte externo. Reglas y reservas intactas; prueba 85 y navegador masivo.
- MEJORA AUTONOMA IMPLEMENTADA: runtime bancario configurable con `ERP4_PYTHON_BIN`, separado del Python usado por los modulos previos. Dependencias criptograficas no requieren sustituir su entorno. Sesiones Secure cuando se active ERP 4; activar exige direccion HTTPS para el login.
- Checkpoint anterior recuperable: `erp4-progress-ui-documents-20260914`, codigo `36b3a5e4c215b56614a3cf721164fa3fc0cb1fbf`; backup `backups/erp4-progress-ui-documents-20260914/erp0-backup-20260914-091031`, restore `organizador-erp0-restore-svz8_vdf`, 205 tablas iguales/secretos/checksums de migracion/17 pruebas de adaptador/transporte. Clave sintetica separada `erp4-checkpoint-custody-25d4cbv1`.

### Matriz A01-A50

### Ajustes finales de publicacion

- Candidato `d657e1887f6d1cd0b9caaa100df2d9d6561d2dbb`, tag `erp4-acceptance-candidate-20260914`: backup `backups/erp4-acceptance-candidate-20260914/erp0-backup-20260914-095701`, restore `organizador-erp0-restore-f25jb4iq`; 205 tablas, secretos, checksums, adaptador y transporte verificados.
- Primera puerta Ubuntu detenida antes de instalar codigo: el arranque de la copia excedio la ventana de seis segundos. Servicio anterior reiniciado y activo, sin migracion productiva. Se hace configurable exclusivamente el plazo del verificador (60 segundos en despliegue). Backup previo `erp0-backup-20260914-080133` restaurado y arrancado correctamente en `/tmp/organizador-erp0-restore-tuucv3vz`; integridad correcta, 166 tablas.
- Stage validado `stage-erp4-20260914-075805`: migracion conserva hashes de 164 tablas de negocio; ERP 0 (11), ERP 1 (26), ERP 2 (recorrido 40/16), ERP 3 (42/42), ERP 4 (seis casos economicos/documentales/masivos criticos), adaptador (17/17) y transporte correctos en Ubuntu. El reintento puede reutilizar esta evidencia solo si coincide el hash de todos los archivos backend; vuelve a migrar una copia reciente y verificar el historico. No se omiten gates por cambios de dominio.
- MEJORA UX AUTONOMA: al cambiar de ficha se ignora el error de una peticion anterior; solo un 403 bancario explicito ofrece configuracion de permisos al superusuario. Los errores tecnicos se muestran, no se confunden con falta de permisos. `verify-erp4-ui-state.mjs` verifica los tres casos. Recorrido completo repetido correctamente en `%TEMP%/erp4-full-app-dvVaiJ`, capturas estables 1440/1920/390 inspeccionadas, sin overflow ni errores JS.

### Correspondencia contractual

Evidencia de dominio: numero `N` = `test_N` de `scripts/verify-erp4-foundations.py`, no numero de caso contractual. AD = `verify-erp4-adapter.py`; HTTP = `verify-erp4-http.mjs`; WEB = recorrido masivo anterior; APP = recorrido completo Ubuntu anterior. Todas las filas acreditan alcance tecnico sintetico/controlado. A40/A44 se completan ademas con restauracion/regresion de publicacion; ningun caso acredita aceptacion comercial por un PSP real.

| Caso | Evidencia verificable |
| --- | --- |
| A01 | 10,20,22,83; cuenta compartida, tres propiedades |
| A02 | 19,55,91; representante, cotitular y obligado separados |
| A03 | 55,75,90; prioridad temporal/concepto y ambiguedad; ERP 2/3 conserva copropiedad |
| A04 | 18,27,51; revisiones y otras propiedades intactas |
| A05 | 16,18,61,67,73; ciclo, sucesion e inactividad |
| A06 | 17,91; RUM normalizada y extension comercial, aislamiento 13 |
| A07 | 29,72; puntual y excepcion acreditada |
| A08 | 83,85; WEB 200/dos paginas/subconjunto de reenvio |
| A09 | 89; recibos acreditados, cero/anulado/parcial; aperturas y legacy no son recibos remesables |
| A10 | 23; concurrencia con un solo ganador |
| A11 | 4,22,23,32; claves de comando y reserva exclusiva |
| A12 | 24,25,33,87; entrada/cobro obsoleto detectados |
| A13 | 87; dinero manual conservado, incidencia visible, fichero historico no reescrito |
| A14 | 26,22; guarda ERP 3 y liberacion |
| A15 | 22,24,66,92; cancelacion atomica y fallo inyectado en segunda liberacion; rollback completo y reintento seguro; WEB |
| A16 | 35,46,47; entrega incierta y retirada acreditada |
| A17 | 45,46,53,56,79,80; resultados por linea, parciales/tardios |
| A18 | 30,35,38,83; exportacion y acuses sin fondos; WEB/APP |
| A19 | AD 17/17,30,31,83; XSD, totales y bytes |
| A20 | 84,42; fallo de artefacto/operacion atomico |
| A21 | AD calendario,52; aviso/acuerdo; 83 y WEB no consideran borrador enviado |
| A22 | AD prueba de frontera 15/11/2026 y direccion insuficiente |
| A23 | 58,79,80,83; fichero/grupo/linea y desconocidos |
| A24 | 36,39,81; ERP 3 unico; WEB |
| A25 | 38,40,57,80; acuse/insuficiencia/contradiccion sin fabricar fondos |
| A26 | 39,86,88; parcial/total/gasto separado; WEB/APP |
| A27 | 40,70,71; hueco documental conservado |
| A28 | 37,59; identidad canonica preparada para ERP 5, no implementacion ERP 5 |
| A29 | 41,58,59,84; identificacion exacta/colision |
| A30 | 45,48,56; recepcion tardia y conflicto sin borrar hechos |
| A31 | 44,45,72; WEB/APP reenvio confirmado |
| A32 | 27,31; fichero/sujetos cifrados e inmutables |
| A33 | 55,91; autorizacion especifica, deuda no trasladada; regresion ERP 1/3 |
| A34 | 43,48; fondos excedentes disponibles, no autoimputacion |
| A35 | 86; ejercicio cerrado conserva evidencia pendiente y no crea cobro |
| A36 | 2,9,34,54,60,64; HTTP reautenticacion y revocacion |
| A37 | 13,19,54,74,82; aislamiento de consultas/archivos/sujetos |
| A38 | 3,14,60,64,76,82; secretos fuera de catalogo generico/log/outbox; HTTP no-store |
| A39 | AD XXE/DTD/limites,77,78; parser tabular acotado |
| A40 | 6-8,28; restore checkpoint con 205 tablas/secretos; POSIX y recuperacion DPAPI separada |
| A41 | 1,62,63,76; aditiva, staging/reimportacion, sin mandatos inferidos |
| A42 | 65,66,85; WEB corte y cierre externo |
| A43 | APP y WEB: 1440/1920/390, recorrido completo contextual |
| A44 | ERP 0 11, ERP 1 26, ERP 2 completo 40/16, ERP 3 42; repeticion Ubuntu en gate de publicacion |
| A45 | 42,49; rollback ERP 3, reserva e identidad bancaria |
| A46 | 31,33,81; perfiles versionados, historico desde artefacto original |
| A47 | 69,39; inversion pendiente, efecto solo con resultado ERP 3, sin XML inverso |
| A48 | 82 y HTTP; catalogo sin ruta/texto, descarga privada y permiso documental; APP HTTPS |
| A49 | 45,48,56; reserva nueva intacta y fondos tardios conservados |
| A50 | 6,28,30,31; integridad del ciphertext/descarga y replay tras rotacion |

### Custodia y puertas de activacion

- Provisionado explicito mediante `scripts/erp4-custody.py`: `/home/coordinador/.config/organizador-web/erp4-keys.json`, directorio 0700/archivo 0600, fuera de app/repositorio/backup ordinario. No activa el modulo ni inserta datos.
- Copia separada cifrada para usuario Windows: `C:/Users/EQUIPO/.ssh/organizador-web-erp4-recovery-20260914-095046.dpapi`. `backup-erp4-key.ps1` verifica checksum y descifrado DPAPI antes de eliminar el temporal en claro. SHA-256 del fichero de claves: `f2ee4b8f204d03014814d2debabaad2d3f16d5928e7d0422bcae7ffa520bb4e3`. No incluir claves en Git ni en informes.
- Recuperacion: restaurar backup ERP 0; recuperar claves con `ProtectedData.Unprotect` como el mismo usuario Windows, transferir por SSH al archivo privado del usuario Ubuntu; comprobar hash/permisos/descifrado en copia antes de iniciar. El runtime bancario se reconstruye de `server/requirements-erp4.txt`. La copia DPAPI requiere conservar perfil/credenciales Windows: no equivale a custodia externa ante perdida simultanea de ambos equipos. Antes del uso real acreditar esa retencion organizativa.
- Retener todas las KEK/indices historicos necesarios: no borrar claves antiguas ni regenerar fichero por un fallo de lectura. Rotacion de cifrado y lookup HMAC conservan identidad y bytes; retirada de claves requiere migracion/ensayo separado.
- Tailscale actual: sin certificado HTTPS configurado (`CertDomains: null`, serve vacio). No se habilita HTTPS con certificado de pruebas ni se cambia la entrada HTTP existente. `ERP4_BANKING_ENABLED=0`, `ERP4_HTTPS_READY=0`, `ERP4_LIVE_BANKING_ENABLED=0` hasta acreditar acceso HTTPS y banco/comunidad. UI y dominio estan probados en HTTPS aislado; el usuario productivo recibira bloqueo explicito de acceso bancario sensible. No se declara aceptacion bancaria real.

Este apartado y los pendientes anteriores sustituyen las afirmaciones de ausencia de UI/archivo de los checkpoints historicos de abajo; no invalidan sus evidencias de prueba.

- Checkpoint previo de esta ampliacion: `erp4-pre-operational-closure-20260911`, sobre `7aa3ecdf96a89c9000f6ae79e90bf59776d51d52`. Backup sintetico `backups/erp4-pre-operational-closure-20260911/erp0-backup-20260911-222810`, restaurado en `%TEMP%/organizador-erp0-restore-ox69i427`, clave separada `%TEMP%/erp4-checkpoint-custody-mzgsdhr4`. 201 tablas identicas y descifrado verificado; no custodia productiva.
- Migracion 17: instrucciones externas con reserva/guardas, eventos de revision inmutables, sucesion referencial de mandatos. Migracion 18: extension de almacenamiento/ACL del catalogo `documentos_importados`; metadatos genericos sin ruta ni texto extraido, archivo cifrado en vault, referencias de comunidad, catalogo inmutable. Probadas sobre copias, no produccion.
- Corte externo masivo y cierre acreditado sin modificar deuda; enlace de mandato sucesor sin heredar domiciliaciones; caducidad conservadora; reintento puntual solo con perfil y prueba de fallo; revision de conflicto que conserva hechos economicos; inversion como solicitud, sin XML ni fondos; retorno terminal sin cobro conocido conserva incidencia de historico y no inventa devolucion ERP 3.
- `pain.002`: expansion fichero/grupo/linea, parcial con rechazo concreto, referencia desconocida pendiente y contradicciones del mismo nivel bloqueadas. Idempotencia de fuente conservada.
- Selectores de personas/propiedades/configuraciones usan ERP 1/2; elegibilidad y cobros/imputaciones consultan ERP 3. La domiciliacion especifica suspendida no recae silenciosamente en una generica.
- Importacion `.xlsx`/CSV con archivo y staging cifrados, mapeo por indices, muestras enmascaradas, limites de ZIP/XML, DTD/XXE/formulas rechazados, duplicados y confirmacion revisable. Dependencias adicionales fijadas: openpyxl 3.1.5 y defusedxml 0.7.1.
- UI `banking-ui.js`, incluida en shell existente: remesas, cuentas/mandatos, resultados, instrucciones externas y configuracion. Seleccion masiva, revision/edicion, reautenticacion y descarga no cacheable. Accesos contextuales a ERP 1 y recibo ERP 3, sin mover reglas economicas al navegador. Nuevos valores monetarios usan cadenas/BigInt solo para presentacion/sumas, servicios ERP para efectos.
- Documentos PDF/PNG/JPEG cifrados, sin extraccion automatica ni IA; descarga dedicada exige `export` + `reveal`, permiso documental y reautenticacion. Referenciar un documento interno no protegido desde un comando bancario se rechaza; se puede aportar referencia externa acreditada o incorporarlo por el almacen protegido. El archivo nunca se publica en rutas genericas.
- `ERP4_LIVE_BANKING_ENABLED` independiente de disponibilidad tecnica: modo real bloqueado si no vale `1`, incluso si se ha guardado la configuracion de comunidad. No se activa en esta continuacion.

### Evidencias de esta ampliacion

- Nucleo **82/82**, 106,315 s: `%TEMP%/organizador-erp4-foundations-1axhj9j2`. Integridad/FK e historicos intactos por caso. Casos 65-82 son nuevos; su numeracion NO representa A01-A50.
- Navegador Edge/Playwright con HTTPS local y servicio Python/SQLite real aislado: `%TEMP%/organizador-erp4-foundations-30w3lz15/test_74_operational_selectors_use_same_domain_and_tenant`. Flujo masivo de 3 recibos, preparar/generar/exportar/presentar, acuse sin fondos, importacion CSV/mapeo/confirmacion, documento cifrado subido/descargado y cobro/imputacion/devolucion con ERP 3. Viewports 1440/1920/390, sin overflow ni errores JS. Evidencia visual en PNG junto al fixture; pantalla movil inspeccionada realmente.
- Regresiones ERP 0: 11 comprobaciones (`organizador-erp0-foundations-8eoiyhn0`); ERP 1: 26 (`organizador-erp1-master-data-qu_gcwoz`); ERP 2 completo 40/16 (`organizador-erp2-complete-jg8jsvpv`); ERP 3 **42/42**, 32,112 s (`organizador-erp3-foundations-gdrrik7r`). Transporte HTTP simulado repetido correctamente. Caso 52 de acuerdo de prenotificacion repetido tras validar evidencia protegida, correcto (`organizador-erp4-foundations-z1pzd353`).
- Consulta SSH de solo lectura: `organizador-web.service` activo. No es smoke test de ERP 4 ni publicacion. No se ha tocado Marbella UNO.

MEJORAS AUTONOMAS IMPLEMENTADAS: guardia de especificidad de domiciliacion; contradicciones pain.002 sin seleccion arbitraria; selectores ERP 3 en vez de IDs manuales; bloqueo de doble clic/confirmacion; alerta visible de modo real deshabilitado; catalogo documental sin copia PII en texto/IA. Pruebas indicadas arriba. El restore verifica ahora tambien correspondencia de checksums del esquema con el codigo archivado.

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

Ultimo checkpoint de continuacion: `erp4-progress-results-access-20260911`.

- Codigo `df7469f2538b2c36d745464282e807058a2f9bb6`: incluye las ampliaciones de importacion observada, suspension/finalizacion y revelacion restringida, con 64 pruebas de nucleo correctas.
- Backup independiente `backups/erp4-progress-results-access-20260911/erp0-backup-20260911-221553`.
- Restauracion `%TEMP%/organizador-erp0-restore-sl7ad7ov`; clave sintetica separada `%TEMP%/erp4-checkpoint-custody-zlkk2ads`.
- 201 tablas/hash identicos, valores descifrados identicos, integridad/FK correctas, pruebas de adaptador y transporte HTTP ejecutadas desde el codigo restaurado. No se ha probado aun un navegador contra una instancia ERP 4 completa.
- Comprobacion final solo de lectura en Ubuntu: `systemctl --user is-active organizador-web.service` devuelve `active`. No se ha instalado codigo, migrado datos ni aprovisionado claves productivas. Esta comprobacion no sustituye al futuro smoke test de publicacion ERP 4.
- Pendientes exactos siguen en su apartado: servicios y corte externo restantes, UI/archivo y contexto, ACL/custodia productivas, A01-A50, escritorio/movil y publicacion. No existe una decision funcional nueva que deba tomar el usuario. **ERP 4 conserva 25% certificado; no esta cerrado ni habilita ERP 5.**
