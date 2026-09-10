# ERP: arquitectura y datos maestros

Linea base de diseno, 10/09/2026. Sin codigo ni migraciones. [Roadmap](ERP_COMUNIDADES_ROADMAP.md) | [Titularidades y repartos](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md).

## Evidencia y limites de esta inspeccion

Repositorio `organizador-web`, base de codigo `1bf2e25`. Fuentes revisadas: `server/index.js` (configuracion, querySmartAssistant, owner_for_property, properties_for_owner), `server/access_control.py` (permisos y migrate_data_scope), `server/documents_domain.py`, `server/assembly-bridge.py`, fichas de cierre 01/06 y roadmap modular. Se consulto exclusivamente `sqlite_master` de la base Ubuntu con `mode=ro` el 10/09/2026: estructura, no registros personales. Parte del esquema financiero proviene del escritorio importado y no tiene su DDL original completo en este repositorio. No confundir tabla existente con proceso ERP implementado o con datos verificados.

Hallazgos que condicionan el diseno:

| Evidencia real | Consecuencia |
|---|---|
| `comunidades`: id, nombre UNIQUE, descripcion, activo, fecha/usuario/pc | No contiene aun identificacion fiscal, configuracion financiera ni jerarquia |
| `cf_propiedades`: codigo/codigo_normalizado, tipo, zona/subzona/grupo, coeficiente REAL, activa, importacion | Se conserva ID; reemplazar progresivamente coeficiente unico y textos estructurales |
| `cf_propietarios`: codigo_netfincas UNIQUE, nombre, nif, direccion, cp/poblacion/provincia, activo, importacion | Persona no equivale a usuario de acceso; identificar tipo/idioma y evitar unicidad global del origen |
| `cf_contactos_propietario`: tipo, valor, principal, activo | Base reutilizable para telefonos/emails; no asumir que cualquier contacto es un destinatario autorizado |
| `cf_propietario_propiedad`: ambos IDs, fecha_desde/hasta, activo, porcentaje_titularidad REAL DEFAULT 100, motivo/origen | Ya hay relacion N:M temporal; ampliarla, no crear otro maestro paralelo |
| Consultas owner_for_property/properties_for_owner filtran activo, no vigencia a fecha | La reconstruccion historica necesita servicio nuevo, no solo columnas |
| `cf_repartos_cuotas` y `cf_reparto_lineas`: criterio/importe, coeficiente_usado, importe_manual/final, un id_propietario | Reutilizar snapshots; adaptar copropiedad y parametros versionados |
| `cf_recibos`, movimientos de deuda/financieros, extractos y gastos existen | Insumos y saldos importados conservados; no se presume diario definitivo |
| `cf_cuentas_contables.codigo` PK global; varias UNIQUE de codigo/CIF/hash sin comunidad | Revisar constraints y FKs antes de nuevas comunidades financieras |
| migrate_data_scope anade id_comunidad a cf_* historicas | Alcance aplicativo existente, no aislamiento de todas las claves naturales |
| `auditoria` tiene fecha, usuario/pc, accion, entidad/id y detalle TEXT | Ampliar estructura sin perder historico; usuario textual no es ID estable |
| `asamblea_censo` guarda propietario/propiedad textual y coeficiente REAL | Es snapshot de asamblea, no nuevo maestro de propiedades |

No se encontraron tablas especificas de ejercicios, grupos de reparto versionados o mandatos SEPA en el esquema consultado. `informes_contables` y un campo `ejercicio INTEGER` no sustituyen esos dominios.

## Arquitectura objetivo

Conservar HTTP Node y modulos de dominio Python con SQLite servidor inicialmente. Separar progresivamente el SQL embebido en `index.js` en repositorios y servicios, segun se toque cada dominio; no reescritura global. Un solo escritor logico de negocio por comando transaccional. No compartir la base activa mediante sincronizacion OneDrive.

Flujo: interfaz o herramienta -> autenticacion/permiso -> contrato de comando/consulta -> servicio determinista -> repositorio/transaccion -> auditoria/evento -> respuesta. Integraciones posteriores (correo, banco) mediante outbox persistente tras commit, reintentos idempotentes, nunca una llamada externa dentro de una transaccion financiera abierta.

Cada comando futuro lleva comunidad explicita, idempotency_key, version esperada, motivo/origen y documentos cuando correspondan. El servidor obtiene usuario y permisos de la sesion, no acepta roles del cuerpo. Las consultas pueden abarcar varias comunidades autorizadas; una escritura no usa el ambiguo alcance "todas". Vista previa no aplica datos; confirmar revalida permisos, version y reglas. IA nunca recibe una herramienta de SQL generico.

Nombres nuevos `erp_*` en este diseno son propuestos. Los maestros existentes conservan `cf_*` e IDs; no crear `erp_propietarios` duplicado. Las interfaces ocultan los nombres de almacenamiento para permitir evolucion futura sin alterar todas las pantallas.

## Identidad y aislamiento

Base conservadora compatible: cada propietario, propiedad, grupo, ejercicio y dato de contacto pertenece a una comunidad. No fusionar identidades de comunidades distintas por NIF/nombre/email. Se puede proponer correspondencia entre ellas mas adelante, con permiso independiente en cada lado, sin compartir automaticamente documentos o preferencias. Esta politica se confirma antes de migrar identidades, no se ha implementado.

Una comunidad legalmente separada usa `comunidades` con su propio id y permisos aunque pertenezca a una macrocomunidad. Una zona o bloque es `erp_agrupaciones`, no otro tenant. La jerarquia de comunidades no concede acceso heredado. Los miembros de una subcomunidad que tambien pertenecen a la macro mantienen inscripciones de propiedad por comunidad, eventualmente relacionadas como misma finca con prueba; cada inscripcion tiene coeficientes propios. La correspondencia no duplica cargos dentro de una misma comunidad.

Regla referencial futura: padre `UNIQUE(id_comunidad,id)` y FK compuesta `(id_comunidad,id_padre)` en cada hijo de negocio. No basta con dos FKs independientes. Indices locales: propiedad `(id_comunidad,codigo_normalizado)`; origen `(id_comunidad,sistema,tipo,codigo_origen)`; grupos `(id_comunidad,codigo)`; cuentas contables `(id_comunidad,codigo)`. Revisar tambien proveedores, equivalencias PGC/banco y hashes: no quitar una UNIQUE global sin adaptar sus consumidores.

IDs tecnicos estables nunca se reciclan. Nombres/codigos normalizados son busqueda, no identidad. NIF puede ser desconocido, erroneo o corresponder a una agrupacion importada: no bloquear importacion ni fusionar silenciosamente; incidencias de calidad separadas de registro validado.

## Catalogo objetivo y transicion

Campos siguientes son contrato propuesto, no DDL ejecutado. Todas las entidades nuevas de negocio llevan id estable, id_comunidad no nulo, version de concurrencia, fecha de registro UTC, actor y origen; referencias opcionales desconocidas son NULL, no cero ni texto ficticio.

### Comunidad: ampliar `comunidades`

- Mantener id/nombre/descripcion/activo y metadatos. Anadir codigo estable, denominacion, NIF si existe, domicilio, contacto administrativo, zona horaria, moneda y estado operativo.
- `erp_comunidad_config_versiones`: comunidad, version, vigencia, parametros tipados (precision, politica de cierre/reparto), fuente y aprobacion. No usar JSON libre como sustituto de reglas economicas obligatorias.
- `erp_comunidad_relaciones`: comunidad padre/hija, tipo y vigencia. Opcional, sin ciclos, sin inferir autoridad ni consolidacion contable automatica.
- Ejercicio seleccionado es preferencia/contexto; no limitar una comunidad a un unico ejercicio abierto global. Cada operacion referencia su ejercicio.
- `erp_cuentas_tesoreria`: comunidad, tipo banco/caja, nombre, moneda, identificador bancario protegido cuando exista, estado y vigencia. Banco y caja separados; varias cuentas permitidas. `cuenta_tesoreria TEXT` existente se mapea, no se considera FK valida automaticamente.
- Cuentas de pagadores/mandatos son ERP 4, separadas de las cuentas propias.

### Subcomunidad / agrupacion: crear `erp_agrupaciones`

- id, comunidad, padre opcional de la misma comunidad, codigo, nombre, tipo configurable, estado. Jerarquia aciclica; un nodo no puede ser padre de si mismo.
- `erp_propiedad_agrupacion`: propiedad, agrupacion, rol estructural/etiqueta y vigencia. Una localizacion estructural principal por dimension y fecha; varias etiquetas permitidas.
- Pueblo 1 fase 1 y fase 2 se reconocen como comunidades distintas segun decision previa. Su representacion como zonas dentro del alcance macro no crea ni autoriza automaticamente los tenants separados.
- Clasificacion acordada: unifamiliares en P1F1; mansiones 1-5/10 y aterrazadas 11-15 en fase 1; mansiones 6-9 y aterrazadas 16-20 en fase 2; PM1-4 casas independientes; PLZ en Condominio B, garajes P1F1/P1F2 en su fase. Conservar como mapeo local revisable, no reglas universales ni reglas de reparto implicitas.
- Hoteles, casa club y parcelas se mantienen como tipos/zonas compatibles; no convertirlos en viviendas por comodidad.

### Propiedad: ampliar `cf_propiedades`

- Mantener id/codigo y origen. Anadir id_tipo (catalogo `erp_tipos_propiedad` configurable: vivienda, local, parcela, garaje, trastero, otro), bloque, portal, planta, puerta, descripcion/direccion, referencia registral y catastral opcionales, estado y fecha de baja con motivo.
- Conservar el codigo original y aliases historicos (`erp_propiedad_alias`) para busqueda aproximada; planta/puerta son texto, admiten bajo, atico, derecha. Cambio de alias no cambia identidad.
- `erp_propiedad_relaciones`: propiedad origen/destino en misma comunidad, tipo anexo/segregacion/agrupacion/otra, vigencia y documento. No autorrelaciones; impedir ciclos para dependencias como anexo. Correspondencia entre comunidades va en una relacion separada autorizada, no FK transversal ordinaria.
- Un garaje anexo sigue siendo unidad identificable si el origen asi lo distingue. No sumar su coeficiente al principal automaticamente y luego cobrarlo tambien como unidad independiente.
- zona/subzona/grupo actuales se mantienen durante la transicion como etiquetas de compatibilidad; no son fuente de participacion economica.
- `coeficiente` actual queda solo como legado/proyeccion expresamente elegida; los calculos nuevos usan versiones de coeficientes por grupo. Detalle en documento especifico.

### Propietario: ampliar `cf_propietarios`

- Persona fisica/juridica, nombre o razon social, tipo y numero de identificacion, pais emisor si procede, direccion postal, idioma preferido y estado. Contactos y preferencias por comunidad, no por usuario de acceso.
- `cf_contactos_propietario`: ampliar etiqueta, principal por tipo, verificado, preferencia de uso, vigencia y procedencia. Guardar normalizacion de busqueda sin sustituir el valor original. No inferir idioma por apellido.
- `erp_preferencias_comunicacion`: propietario, canal, idioma, direccion/contacto elegido, alcance documental, vigencia, fuente y base/autorizacion cuando proceda. Email disponible no implica permiso para cualquier envio.
- Nombre importado con varios titulares no se divide por barras, comas o "y". Se conserva con `calidad_identidad=pendiente_desglosar`, texto original y origen; tipo desconocido permitido en staging. Su desdoblamiento requiere evidencia y tabla de correspondencias, preservando deuda y documentos del registro historico.
- Baja de titular actual no elimina propietario si hay deuda/historico. Servicio de consulta admite antiguos; pantalla puede filtrar actuales. No perder al deudor por `activo=0`.
- No crear un maestro universal de "terceros" ahora: proveedores y propietarios existentes conservan identidad propia; posible consolidacion futura es decision separada.

### Titularidad: refactorizar `cf_propietario_propiedad`

Ya contiene N:M, porcentaje y fechas. Conservar `id_relacion` como identidad compatible, ampliar precision, estados de calidad, procedencia y revision temporal. Sustituir `activo` como unica regla de vigencia por consulta a fecha. Reglas, copropiedad y ejemplos en [documento temporal](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md); no duplicarlas aqui.

### Ejercicio: crear `erp_ejercicios`

- id, comunidad, codigo, inicio, fin, moneda y estado (preparacion, abierto, cerrado), fechas/actor de apertura/cierre, motivo, version. `erp_bloqueos_periodo` para intervalo y dominio (recibos/contabilidad/presupuestos), actor/motivo y levantamiento auditado.
- No solapar ejercicios validados del mismo libro/comunidad. Reapertura explicita autorizada, nunca por importar un archivo nuevo. Bloqueo rechaza escritura efectiva en el intervalo aunque la pantalla muestre otra fecha.
- Informes anuales/semestrales usan rango de fechas y fecha de corte; un informe semestral NO crea automaticamente un ejercicio semestral. Ejercicios no naturales siguen posibles si se configuran y validan.
- Migrar `cf_recibos.ejercicio` y `cf_movimientos_financieros.ejercicio` mediante tabla de correspondencia; no asignar por ano sin comprobar periodo, emision y reglas del origen.

### Maestros auxiliares: crear o ampliar

| Entidad | Accion | Contrato |
|---|---|---|
| Grupos, pertenencias y coeficientes | Crear registros temporales | Definidos en documento especifico; sin catalogo hardcodeado |
| Tipos de propiedad/agrupacion | Crear catalogos | Codigos estables, desactivacion, configurables por comunidad |
| `cf_importaciones_netfincas` | Ampliar | hash/version archivo, sistema, comunidad, corte de datos, parametros, aprobacion y snapshot original |
| `cf_incidencias_importacion` | Reutilizar/ampliar | discrepancia, campo/fila, severidad, decision y resolucion trazable |
| `erp_referencias_origen` | Crear | sistema/entidad/codigo por comunidad, ID destino, importacion y fila; normalizacion no fusiona |
| Documentos y enlaces | Ampliar servicio existente | catalogo/version con comunidad, hash, ubicacion privada, tipo, fuente; enlaces tipados FK a titulares/propiedades/cambios |
| `auditoria` | Ampliar compatible | actor ID, comunidad, request/evento, antes/despues, motivo, origen, evidencia, version, fecha de registro |

Los binarios existentes de anexos/importados/asambleas/seguridad no se mueven en este diseno. Resolverlos mediante adaptador documental con control de acceso; un enlace no puede otorgar acceso a un documento de otra comunidad. Evitar una tabla polimorfica sin integridad: usar enlaces tipados o validar tipo+ID y comunidad dentro del servicio.

## Auditoria, fechas y exactitud

Auditar altas, cambios de identidad/contacto, clasificacion estructural, titularidad, coeficientes, pertenencias, cierre/bloqueo, importaciones confirmadas, mapeos y permisos. Registrar antes/despues estructurados, actor ID y nombre snapshot, comunidad, UTC, origen (manual/importacion/herramienta), documento/version, motivo, request_id y version. Distinguir fecha efectiva del hecho de fecha de registro.

Conservar auditoria antigua; no inventar actor/fecha si no constan. Para cambios economicos guardar revisiones de dominio ademas del log: un JSON de auditoria no es el unico historial operativo. Proteger borrado/modificacion; el usuario de sistema con acceso a SQLite puede alterar archivos, por lo que no se promete inmutabilidad criptografica sin controles adicionales. No registrar claves, tokens o IBAN completo en logs generales.

Precision, intervalos y redondeo se especifican una sola vez en el [contrato temporal](ERP_TITULARIDADES_COEFICIENTES_REPARTO.md#precision-y-redondeo). No usar float/REAL ni JSON number para importes y factores del nuevo motor.

## Integracion futura sin doble verdad

Netfincas sigue siendo origen durante la convivencia. Exportacion -> staging -> correspondencia -> diferencias -> revision -> transaccion confirmada. Guardar originales, corte y limitaciones. Ausencia en un fichero parcial no significa venta, baja ni pago. Ni nombre coincidente ni fecha de importacion prueban una escritura de compraventa.

Primera migracion futura: inventariar dependencias y copias, ampliar de forma aditiva, mantener IDs y consultas de compatibilidad, reconciliar por comunidad, activar servicio nuevo por dominio y deshabilitar su escritura antigua. Una sola fuente efectiva por dato; no escribir tanto en columna legacy como en tabla nueva sin una proyeccion controlada y comprobable.

El saldo inicial/importado puede conservarse aunque falte todo el historico de movimientos. Declarar cobertura desde fecha conocida. No fabricar fechas ni reconstrucciones completas para satisfacer una consulta de IA.

No ligar futuros cargos a la FK "propietario actual": recibo conserva obligado/snapshot al emitirse; movimientos conservan su imputacion. El detalle de deuda transmisible se decide en ERP 3 con documentacion, no en una migracion de maestros.

## Contratos internos propuestos (sin implementacion)

- Consultar propiedad/propietario: comunidad, identidad o filtros, fecha efectiva opcional; devuelve coincidencias, cobertura temporal, fuentes y version, no seleccion arbitraria por similitud.
- Consultar titularidades: propiedad y fecha; devuelve lista/porcentajes, calidad y lagunas; opcion conocido_a para reconstruir lo que se sabia entonces.
- Proponer cambio de titularidad: evidencia, fecha, composicion antes/despues y advertencia de deuda; no modifica saldos.
- Confirmar cambio: permiso, version esperada, idempotencia, validacion temporal y auditoria en misma transaccion.
- Simular reparto (ERP 2): presupuesto/version, grupo/regla/version, fecha de corte y politica temporal; resultado explicable, sin emitir recibos.
- Publicar resultado: snapshot aprobado, claves de origen y controles de periodo. Las herramientas IA usan exactamente estos contratos.

## Decisiones y riesgos que no se ocultan

El diseno conserva identidad aislada por comunidad. Si se desea ficha personal unica global, confirmar antes de migrar: afecta a claves, contactos, documentos y permisos. No es necesario resolverlo para finalizar este documento; si se acepta el aislamiento actual, continuar con el modelo propuesto.

Antes de calculos reales confirmar el corte/prorrateo y criterio de facturacion en copropiedad (no necesariamente proporcional al dominio). Tipos de agrupacion, etiquetas y alias son configuraciones reversibles y no requieren bloquear el diseno.

No se ha hecho una auditoria legal ni una certificacion contable. Se ha identificado el soporte tecnico necesario para que esos criterios se configuren y revisen por personas autorizadas en sus fases.
