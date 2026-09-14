# ERP 5 - Implementacion de banco y conciliacion

Contrato obligatorio: [diseno ERP 5](ERP_05_BANCO_CONCILIACION.md).
Seguimiento: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md).

## Estado de continuidad

Diseno cerrado 100%. Implementacion **100% certificado**, COMPLETADO.
5A migracion/adaptadores, 5B servicios/integracion, 5C recorrido funcional
y 5D aceptacion/regresion/publicacion/recuperacion tienen 25/25 cada uno.
Cierre tecnico con escenarios sinteticos y copias controladas; no significa
activacion de cuentas/fuentes reales ni autorizacion de operativa bancaria real.
No iniciar ERP 6 ni habilitar operativa bancaria real.

## Checkpoint y recuperacion

- Inicio: `39a38c9`, tag `erp5-pre-20260914`.
- Backup independiente Ubuntu:
  `/home/coordinador/apps/organizador-web/backups/erp5-pre-20260914/erp0-backup-20260914-113917`.
- Restauracion previa comprobada en
  `backups/erp5-pre-20260914/organizador-erp0-restore-v301l9xr`: apertura,
  runtime, integridad y 208 tablas correctos. Codigo publicado previo `b2329cd`.
- Claves ERP 4 permanecen fuera del repositorio; recuperacion DPAPI existente.
  Restauracion de avance con migracion 20 verificada: `erp0-backup-20260914-130311`,
  restore `verification/organizador-erp0-restore-derxg75d`, runtime y 25 registros
  cifrados recuperados con clave sintetica separada. Recuperacion final de
  migracion 21 y publicacion verificada en la seccion de cierre.
- Avance anterior: `081b623fe5339faab4a2c18247b79af25c3e8989`,
  `erp5-progress-domain-web-20260914`. Nuevo checkpoint se registra en Git
  bajo `erp5-progress-acceptance-20260914` (`cb5ac04`); no sustituye el backup de datos.
- Codigo publicado: `2a970157e0782ad32ce7b6765a30b16d86272adc`, checkpoint
  `erp5-pre-publication-20260914`. Cierre documental/test de smoke:
  `erp5-completed-20260914` (resoluble en Git, sin hash autorreferente).
- Trabajo aislado Ubuntu: `backups/erp5-work-20260914`. Nunca desplegar
  esta carpeta sobre produccion sin cerrar aceptacion.

## Bloques desarrollados

- Migracion aditiva 20: evidencias/importaciones cifradas, ocurrencias,
  identidades HMAC, correcciones, coberturas, propuestas, enlaces N:M,
  salidas, transferencias/extremos, cierres, pendientes y activacion de fuente.
- Migracion aditiva 21: rectificaciones inmutables de salidas/extremos propios.
  Contramovimientos explicitos, fecha efectiva, evidencia y eventos separados;
  nunca modificar el apunte bancario ni borrar el hecho original.
- Adaptadores CSV/XLSX/XLS/manual/Cuaderno 43/camt.053 y camt.054 v08.
  Limites de entrada, importes exactos, rechazo de contenido hostil,
  revision de duplicados y sustitucion pending/booked sin doble saldo.
- Conciliacion parcial/N:M, netos documentados, enlace de fondos existentes,
  delegacion ERP 3/4 en una transaccion, guardias de capacidad/version,
  devoluciones, reintegros y desconciliacion sin borrar historia economica.
- Salidas documentadas y transferencias banco/banco/caja; extremos ausentes
  en transito y completado posterior sin inventar movimientos.
- Saldos acreditados y cierre con pendientes documentados, reapertura;
  fuente rectora ERP 5 sin sumar saldos legacy. Exportacion CSV/XLSX exacta.
- Transporte bancario privado y UI reutilizando el sistema visual actual.
- Desglose bruto/neto editable sin persistencia durante la preparacion;
  revision humana con aplicaciones a recibos y remanente del movimiento.
  Contextos de recibo/cobro/propiedad/propietario/comunidad, seleccion masiva
  entre paginas, originales reautenticados e informes CSV/XLSX/PDF.
- Consultas bancarias incrustadas en `server/index.js` dirigidas a ERP 5
  por cobertura y permisos: sin fallback legacy cuando ERP 5 ya esta activo.

## Evidencia ejecutada

- Fundamentos finales: **58/58** Ubuntu, 185,156 s, carpeta
  `backups/stage-erp4-20260914-141003/verification/organizador-erp5-foundations-17fnzme9`.
  Ejecucion anterior 58/58, 196,018 s, `organizador-erp5-foundations-6ypmzc0x`.
  Integridad/FK verificadas
  al terminar cada caso; incluye rectificaciones, bloqueo economico,
  autorizacion revocada entre preview/confirm y parseo fuera del bloqueo de escritura.
- Adaptadores: **22/22** Ubuntu, incluido Excel numerico/textual, XLS/formulas,
  camt inconsistente y seleccion explicita de cuenta en archivos multibloque.
- Integracion final ERP 3/4: **15/15**, 107,823 s, con el runtime ERP 5.
  Incluye remesa sin detalle fiable y enmascarado de texto libre de candidatos.
  El primer intento del caso 14 utilizaba un resultado inexistente y esperaba
  otra clase de error; corregida la fixture para representar ausencia de detalle,
  sin modificar el dominio para hacer pasar la prueba. Gate final ejecutara el conjunto.
- Regresion completa Ubuntu:
  `verification/organizador-erp5-regression-ci26w7dl/results.json`.
  Migracion preserva hashes de 207 tablas existentes; SQLite y FK correctos.
  ERP 0, ERP 1 (26), ERP 2 integral/2B (14), Planes de Cuotas (20),
  ERP 3 (42), ERP 4 (92), adaptador SEPA (17), HTTP/UI existentes correctos.
- Navegador real HTTPS con login/cookies Secure/SameSite y aplicacion completa:
  `C:/Users/EQUIPO/AppData/Local/Temp/erp5-full-shell-FqXhBI`: cobro parcial,
  salida negativa/documento pendiente, desconciliacion, rectificacion explicita,
  saldos, cierre con pendientes y contextos de cobro/propiedad/propietario/comunidad.
  `erp5-full-shell-G7fYFz`: neto 98 = cobro 100 - comision 2, cero confirmaciones
  economicas durante preparacion/preview, una confirmacion y remanente exacto cero.
  Escritorio 1440/1920 y movil 390, sin desbordamientos ni errores de pagina;
  capturas realmente inspeccionadas. Descarga original/Excel/PDF validada antes
  en `organizador-erp5-foundations-g8vuew9c/browser`; PDF renderizado e inspeccionado.
- Plan ordinario y especial: `verification/organizador-erp5-plans-1d_rrkgd/proof.json`,
  dos recibos independientes y dos cobros; cuotas, snapshots y coeficientes
  intactos. Solo cambia legitimamente la version de concurrencia del recibo.
- UI real en prueba focal: signos negativos del formulario manual, version de
  rectificacion, reintento de preview sin duplicar componentes y desglose neto
  preparado sin efectos. UI masiva: 52 seleccionados a traves de dos paginas.
- Regresion focalizada ERP 4 tras resultados/consultas: **5/5**, 55,876 s.
- Estado UI ERP 4/ERP 5 y sintaxis JS correctos. Migracion actual verificada
  nuevamente: hashes de 207 tablas anteriores intactos, integridad y cero FK.

La matriz siguiente identifica evidencia por criterio, no por conteos.
Aceptacion A01-A64 completada con la publicacion/recuperacion y smoke registrados.

## Decisiones tecnicas y mejoras autonomas

- MEJORA AUTONOMA IMPLEMENTADA: valores numericos nativos de Excel usan
  su representacion decimal nativa; el separador del usuario solo aplica a
  celdas de texto. Evita multiplicar importes por una lectura de miles erronea.
- Moneda operativa EUR; enteros de centimos/Decimal, sin float economico.
- Una evidencia no es un cobro. Eventos de enlace y hechos monetarios separados.
- Ningun saldo desconocido se presenta como cero verificable.
- Descarga de originales por canal separado, reautenticacion y permisos;
  nunca almacenar el archivo descifrado en el resultado general de comandos.
- MEJORA AUTONOMA IMPLEMENTADA: archivos multicuenta requieren seleccionar
  bloque; identidad de evidencia por archivo/perfil/bloque, sin sumar cuentas
  ajenas ni revelar IBAN en el manifiesto.
- MEJORA AUTONOMA IMPLEMENTADA: analizar/remapear archivos fuera del bloqueo
  de escritura, reautorizando y verificando version dentro de la transaccion.
- MEJORA AUTONOMA IMPLEMENTADA: borrador de desglose neto local y editable,
  con vista previa y remanente del backend, sin crear fondos mientras se edita.
- Defecto directamente relacionado corregido: conversor compartido acepta solo
  magnitudes positivas; formulario bancario aplica explicitamente el signo sin
  cambiar ese conversor ni los otros dominios. Validado en navegador real.
- Runtime ERP 5 aislado preparado fuera del repositorio, conservando ERP 4:
  `/home/coordinador/.local/share/organizador-web/erp5-runtime`.
  Dependencias fijadas en `server/requirements-erp5.txt`; xlwt 1.3.0 solo para
  fixtures XLS. Gate/publicacion reutiliza `deploy-erp4-release.py --reconciliation`.
  Publicacion configura solo ERP4_PYTHON_BIN al runtime ERP 5; conserva el
  runtime ERP 4 para rollback y todas las puertas de activacion real en cero.
- MEJORA AUTONOMA IMPLEMENTADA: enmascarar tambien numero/descripcion de
  recibos y numeros de aplicaciones en la lista de candidatos bancarios;
  prueba I15 con texto IBAN sintetico conserva el recibo original sin alterarlo.
  La primera candidata de publicacion se detuvo antes de tocar produccion
  para incluir esta proteccion; no se han omitido errores de test del cierre.
- Recuperacion de migracion 21: `verification/organizador-erp5-recovery-2k7mpfpk`,
  backup `erp0-backup-20260914-140346`, restore `organizador-erp0-restore-xjni4nkq`:
  arranque, integridad/FK y 30 secretos recuperados con custodia sintetica separada.
  Recuperacion independiente de clave productiva verificada bajo DPAPI:
  `C:/Users/EQUIPO/.ssh/organizador-web-erp4-recovery-20260914-160412.dpapi`.

## Matriz de aceptacion

`Cnn`: `verify-erp5-foundations.py`; `Inn`: `verify-erp5-remittances.py`;
`Dnn`: `verify-erp5-adapters.py`. Numeros corresponden al prefijo del caso.
OK significa prueba ejecutada. 5D se cierra por la evidencia adicional de publicacion.

| Criterio | Evidencia | Estado |
|---|---|---|
| A01 | I09 propuesta exacta, sin efectos hasta confirmar | OK |
| A02 | C51 ingreso sin referencia | OK |
| A03 | I13 cobro 60, deuda 40 | OK |
| A04 | I05 un cobro/varias aplicaciones | OK |
| A05 | I13 y C07 varios apuntes | OK |
| A06 | I02 enlace de fondos ya existentes | OK |
| A07 | I02 remesa liquidada | OK |
| A08 | I01 delegacion atomica | OK |
| A09 | I12 solo fondos ausentes | OK |
| A10 | I14 sin detalle, sin aplicaciones ni fondos inventados | OK |
| A11 | C08 y navegador G7fYFz | OK |
| A12 | C09 no gasto sin evidencia | OK |
| A13 | C32 e I08 devolucion existente | OK |
| A14 | I08 y C26 una devolucion ERP 3 | OK |
| A15 | C51 no cobro ficticio | OK |
| A16 | I04 rechazo sin fondos | OK |
| A17 | C20 salida sin factura/asiento inventado | OK |
| A18 | C45 y navegador FqXhBI | OK |
| A19 | C08 y regresion ERP 4 caso 88, politica de gastos | OK |
| A20 | C21 dos extremos, sin principal adicional | OK |
| A21 | C22 extremo ausente | OK |
| A22 | C23 y C56 banco/caja en ambas direcciones | OK |
| A23 | C52 transferencia entre comunidades denegada | OK |
| A24 | C02 reimportacion | OK |
| A25 | C02 y C40 alias por perfil | OK |
| A26 | C04 contradiccion de identidad | OK |
| A27 | C03 multiplicidad legitima | OK |
| A28 | C03 solapamiento sin ID | OK |
| A29 | C11 operacion/valor | OK |
| A30 | C51 valor desconocido | OK |
| A31 | C16 y C29 saldo acreditado | OK |
| A32 | C53 sin saldo acreditado | OK |
| A33 | C17 diferencia bloqueante | OK |
| A34 | C53 base disponible/contable | OK |
| A35 | C51 pendiente sin deuda | OK |
| A36 | C16 y navegador FqXhBI | OK |
| A37 | C53 cobertura incompleta | OK |
| A38 | C54 importacion tardia | OK |
| A39 | C54 cierre anterior intacto | OK |
| A40 | C57 y regresion ERP 4 caso 86 | OK |
| A41 | I11 diferencias exactas de centimo | OK |
| A42 | C44 legacy observado | OK |
| A43 | C29 y C48 consumidor real sin fallback | OK |
| A44 | D01-07/15-17 y navegador CSV anterior | OK |
| A45 | D12/13/22 Cuaderno 43 | OK |
| A46 | D08-10/18-21 camt | OK |
| A47 | D06/07/11 y C30 exportacion segura | OK |
| A48 | C13/34/52 aislamiento | OK |
| A49 | C58 delegacion revocada, rollback total | OK |
| A50 | C27 dos revisores | OK |
| A51 | C14/15 doble confirmacion | OK |
| A52 | C24 e I03 rollback compartido | OK |
| A53 | C10 fondos intactos al desconciliar | OK |
| A54 | C45-47 rectificaciones explicitas | OK |
| A55 | C19/34 e I15 cifrado, texto libre enmascarado, canales privados | OK |
| A56 | C42 rotacion; restauracion de 30 secretos y recuperacion DPAPI | OK |
| A57 | verify-erp5-plans.py, proof 1d_rrkgd | OK |
| A58 | C43 inbox simulado; sin ERP 6 | OK |
| A59 | C43 evidencia no duplica dinero | OK |
| A60 | C21/22/46 eventos por extremos acreditados | OK |
| A61 | C49 y verify-erp5-bulk-ui.mjs, 52 en dos paginas | OK |
| A62 | FqXhBI/G7fYFz, login, division, confirmacion, cierre/contextos | OK |
| A63 | Backups 141922/142113 restaurados, 30 secretos sinteticos, publicacion y smoke | OK |
| A64 | regression-ci26w7dl completa y gate final del paquete 2a97015 | OK |

## Cierre y publicacion

- Paquete Git del codigo `2a97015`, publicacion mediante el procedimiento
  existente `deploy-erp4-release.py --quota-plans --reconciliation --publish`.
  La candidata anterior se detuvo antes de produccion; no reutilizarla como
  una publicacion exitosa ni repetir sus pruebas como evidencia final.
- Gate final: ERP 0; ERP 1 (26); ERP 2 integral y motor (14); planes (20);
  ERP 3 (42); SEPA (17); ERP 4 seis casos criticos tras la regresion completa
  previa de 92 casos; ERP 5 58/22/15; HTTP y tres pruebas focales UI.
  No afirmar que los seis casos finales son una nueva ejecucion de los 92.
- Fuente/migracion conserva hashes de 206 tablas de negocio existentes
  (el gate excluye las dos tablas de metadatos de migracion).
- Backup productivo previo independiente:
  `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260914-141922`.
  Restore: `backups/stage-erp4-20260914-141003/verification/organizador-erp0-restore-vjheznfs`:
  208 tablas, runtime accesible e integridad correcta.
- Backup productivo posterior:
  `/home/coordinador/apps/organizador-web/backups/erp0-backup-20260914-142113`.
  Restore: `backups/stage-erp4-20260914-141003/verification/organizador-erp0-restore-4exixhal`:
  229 tablas, runtime accesible, SQLite/FK correctas e historicos equivalentes.
  Prueba completa en `erp4-publication-proof.json` dentro de este backup;
  contiene explicitamente `bank_reconciliation=true` y las puertas reales en cero.
- Smoke sobre la aplicacion entregada en localhost y Tailscale:
  `verify-erp5-postrelease.mjs`: health, UI ERP 5 entregada, sintaxis de los
  scripts inline y denegacion 401 de rutas bancarias/recibos/comunidad ajena.
  Servicio `organizador-web.service` activo.
- Smoke economico POST publicacion sobre copias del backup posterior, con
  codigo/runtime publicados: C16/C26/C13, 3/3 en 9,374 s; I01/I08, 2/2 en
  13,938 s. Cierre/reapertura, devolucion, permisos, liquidacion y doble
  llegada de resultados correctos, sin movimientos economicos en produccion.
- Pruebas antiguas terminadas `organizador-erp5-foundations-fe7jn4z0`
  conservadas en el archivo privado homonimo `.tar.gz`, contenido comparado
  antes de liberar la carpeta temporal. SHA256:
  `d2986b0921357a45695ad40f6143d4e6b29fc09c0feb445579e96d5ce25dc982`.
  No eliminar backups previos/posteriores ni claves para liberar espacio.

## Pendiente de puesta en servicio

Sin bloques funcionales pendientes dentro del contrato ERP 5. Configurar y
acreditar por comunidad cuentas, perfiles/mapeos, permisos, fuente rectora,
corte/cobertura/saldos; HTTPS, custodia organizativa y retencion. Revisar
capacidad/retencion de copias de prueba. El agregador y la automatizacion
economica desatendida quedan fuera del alcance aprobado. ERP 6 puede pasar
a cierre de su contrato, sin comenzar su implementacion automaticamente.

## Seguridad de puesta en servicio

ERP4_BANKING_ENABLED, ERP4_LIVE_BANKING_ENABLED y ERP4_HTTPS_READY siguen
deshabilitados en produccion. Pruebas con cuentas/importes sinteticos en
copias y claves aisladas. TLS, custodia organizativa/retencion y configuracion
bancaria acreditada por comunidad siguen siendo puertas de activacion real,
no autorizaciones inferidas del desarrollo.
