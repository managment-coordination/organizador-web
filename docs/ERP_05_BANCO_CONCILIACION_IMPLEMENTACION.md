# ERP 5 - Implementacion de banco y conciliacion

Contrato obligatorio: [diseno ERP 5](ERP_05_BANCO_CONCILIACION.md).
Seguimiento: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md).

## Estado de continuidad

Diseno cerrado 100%. Implementacion **25% certificado**, DESARROLLO.
Solo el hito de contrato/migracion validada tiene 25/25. Servicios,
recorrido integrado y aceptacion final siguen abiertos; no sumar puntos
por codigo sin completar su evidencia. Produccion no modificada por ERP 5.
No iniciar ERP 6 ni habilitar operativa bancaria real.

## Checkpoint y recuperacion

- Inicio: `39a38c9`, tag `erp5-pre-20260914`.
- Backup independiente Ubuntu:
  `/home/coordinador/apps/organizador-web/backups/erp5-pre-20260914/erp0-backup-20260914-113917`.
- Restauracion previa comprobada en
  `backups/erp5-pre-20260914/organizador-erp0-restore-v301l9xr`: apertura,
  runtime, integridad y 208 tablas correctos. Codigo publicado previo `b2329cd`.
- Claves ERP 4 permanecen fuera del repositorio; recuperacion DPAPI existente.
  Restauracion final con migracion 20 y claves pendiente.
- Trabajo aislado Ubuntu: `backups/erp5-work-20260914`. Nunca desplegar
  esta carpeta sobre produccion sin cerrar aceptacion.

## Bloques desarrollados

- Migracion aditiva 20: evidencias/importaciones cifradas, ocurrencias,
  identidades HMAC, correcciones, coberturas, propuestas, enlaces N:M,
  salidas, transferencias/extremos, cierres, pendientes y activacion de fuente.
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

## Evidencia ejecutada

- Fundamentos: **44/44** pruebas en Ubuntu (168,760 s), carpeta
  `verification/organizador-erp5-foundations-x0x192b2` dentro del trabajo aislado.
- Adaptadores: **20/20** locales, incluido Excel numerico con separador
  de usuario distinto, XLS/formulas y detalle camt inconsistente.
- Integracion remesas: **9/9** casos y repeticion focalizada 07/08 correctos:
  ambos ordenes de llegada extracto/resultado, sin duplicar cobros/devoluciones.
  Caso 10 contextual desarrollado; pendiente registrar su ejecucion final.
- Regresion completa Ubuntu:
  `verification/organizador-erp5-regression-zpimcwen/results.json`.
  Migracion preserva hashes de 207 tablas existentes; SQLite y FK correctos.
  ERP 0, ERP 1 (26), ERP 2 integral/2B (14), Planes de Cuotas (20),
  ERP 3 (42), ERP 4 (92), adaptador SEPA (17), HTTP/UI existentes correctos.
- Navegador real HTTPS, escritorio 1440x900 y movil 390x844:
  importar -> cobro parcial -> pendiente -> acreditar saldos -> cierre ->
  descarga XLSX, sin desbordamiento horizontal de pagina.
  Capturas en `organizador-erp5-foundations-0zbcsxky/browser` del temporal local.
  Ultima repeticion local correcta en `organizador-erp5-foundations-bhji1er4/browser`:
  originales reautenticados, Excel y PDF; cero errores de pagina. PDF renderizado
  e inspeccionado. Shell completo y recorridos contextuales aun pendientes.
- Regresion focalizada ERP 4 tras resultados/consultas: **5/5**, 55,876 s.
- Estado UI ERP 4/ERP 5 y sintaxis JS correctos. Migracion actual verificada
  nuevamente: hashes de 207 tablas anteriores intactos, integridad y cero FK.

No afirmar A01-A64 completos: la matriz final aun no esta acreditada.
Los cambios posteriores a cada ejecucion requieren sus pruebas focalizadas.

## Decisiones tecnicas y mejoras autonomas

- MEJORA AUTONOMA IMPLEMENTADA: valores numericos nativos de Excel usan
  su representacion decimal nativa; el separador del usuario solo aplica a
  celdas de texto. Evita multiplicar importes por una lectura de miles erronea.
- Moneda operativa EUR; enteros de centimos/Decimal, sin float economico.
- Una evidencia no es un cobro. Eventos de enlace y hechos monetarios separados.
- Ningun saldo desconocido se presenta como cero verificable.
- Descarga de originales por canal separado, reautenticacion y permisos;
  nunca almacenar el archivo descifrado en el resultado general de comandos.

## Pendientes exactos para cierre

1. Rectificaciones explicitas de hechos propios de salida/extremos de
   transferencia y sus eventos compensatorios; no basta la desconciliacion.
2. UI: alias de identidad entre perfiles, ventana visible de propuestas,
   pendiente documental de pagos y seleccion masiva entre paginas.
3. Registrar prueba contextual recibo/cobro/propiedad y comprobar shell
   completo, remesa, propietario y comunidad en escritorio/movil.
4. Completar sustitucion controlada de consumidores bancarios legacy y
   verificar consulta Python incrustada de periodos/frescura/fuente ERP 5.
5. Ejecutar/documentar matriz A01-A64, incluidos limites, planes ordinarios/
   especiales e importacion bancaria legible; no inferir cobertura por conteos.
6. Ejecutar restauracion del avance con clave sintetica separada usando
   `verify-erp5-recovery.py`; no confundirla con custodia productiva acreditada.
7. Checkpoint final, backup posterior y restauracion aislada de datos/clave,
   regresion focalizada de cambios nuevos, publicacion y smoke Ubuntu.

## Seguridad de puesta en servicio

ERP4_BANKING_ENABLED, ERP4_LIVE_BANKING_ENABLED y ERP4_HTTPS_READY siguen
deshabilitados en produccion. Pruebas con cuentas/importes sinteticos en
copias y claves aisladas. TLS, custodia organizativa/retencion y configuracion
bancaria acreditada por comunidad siguen siendo puertas de activacion real,
no autorizaciones inferidas del desarrollo.
