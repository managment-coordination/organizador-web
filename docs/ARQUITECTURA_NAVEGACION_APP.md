# Arquitectura de navegacion de la app

Fecha: 11/09/2026. Reorganizacion transversal, sin cambios de dominio ni avance ERP. Linea base `42aa98f`. [Roadmap modular](ROADMAP_REVISION_MODULAR.md), [Roadmap ERP](ERP_COMUNIDADES_ROADMAP.md), [UX permanente](ERP_UX_PRINCIPIOS.md).

## Fase A - Inventario y validacion tecnica

Inspeccion del HTML servido por Ubuntu en 8771 (HTTP 200) y del repositorio: las mismas 17 vistas `data-view` en `server/index.js`. La app sirve una SPA en `/`; sus vistas son estado interno de `switchView`, no 17 rutas HTTP independientes. No se crean rutas nuevas ni se renombran claves/API. El directorio `web` no contiene otra app: solo README.

Antes: Inicio, Trabajo Hoy, Tareas, Proyectos, Asambleas y Seguridad en lista; Acciones/Revision condicionados por perfil; Herramientas reunia Buscar, Documentos, Datos maestros, Presupuestos, Informes, Importar, Notificaciones, IA y Administracion. Movil copiaba todos los botones en una lista plana. Datos maestros tiene seis pestañas y Presupuestos sus recorridos certificados. Inicio/Trabajo Hoy abren fichas y acciones contextuales.

| Funcion real | Ubicacion anterior | Destino | Accion / compatibilidad |
|---|---|---|---|
| Inicio `home` | Principal | Inicio | MANTENER panel de situacion y accesos de atencion |
| Trabajo Hoy / mapa `map` | Principal | Tareas > Trabajo Hoy | MOVER; Inicio conserva acceso contextual |
| Tarjetas tareas `tasks` | Principal | Tareas > Tareas | MOVER |
| Proyectos `projects` | Principal | Tareas > Proyectos | MOVER; no fusionar con tareas |
| Ficha/seguimiento/compromisos/adjuntos/solicitud | Tarjetas, mapa, modal | Misma ficha contextual | MANTENER, sin inventar listado de seguimientos |
| Acciones/Decisiones `work` | Condicionado por perfil | Tareas > Decisiones | MOVER con visibilidad original |
| Revision `review` | Oculto habitualmente | Tareas > Revision (oculto igual) | MANTENER COMO VISTA AVANZADA, sin habilitarla a otros roles |
| Notificaciones `notifications` | Herramientas | Tareas > Notificaciones | MOVER |
| Documentos `documents` | Herramientas | Tareas > Documentacion > Documentos | MOVER; buscador documental operativo y fichas conservados |
| Informes `reports` | Herramientas | Tareas > Documentacion > Informes de trabajo | RENOMBRAR acceso; informes ejecutivos/completos de tareas/proyectos, no confundir con informes PGC |
| Importar `imports` | Herramientas | Tareas > IA y reuniones > Importar textos y archivos | RENOMBRAR acceso; conservar extractor/analizador/confirmacion existente |
| Centro IA `ai` | Herramientas, boton global | Tareas > IA y reuniones > Centro IA | MOVER; boton global/panel contextual y seguimiento IA intactos |
| Seguridad `security` | Principal | Tareas > Seguridad | MOVER: partes/incidencias operativas; perfil Seguridad sigue acceso exclusivo directo |
| Asambleas `assemblies` | Principal | Gestion > Asambleas | MOVER; convocatoria, puntos, asistencia, delegaciones, votos, acta/exportaciones HTML/documentos intactos |
| Datos maestros `master-data` | Herramientas | Gestion > Ficheros > Datos de la comunidad | RENOMBRAR acceso; mismas pestañas y servicios |
| Propiedades/Propietarios | Pestañas maestras | Datos de la comunidad > Propiedades/Propietarios | MANTENER fichas, contactos, titulares actuales/historicos, copropiedad, documentos y ocupacion |
| Comunidad/ejercicios | Pestaña maestra | Datos de la comunidad > Comunidad y ejercicios | MANTENER, distinta de administracion global |
| Agrupaciones | Estructura de propiedades | Datos de la comunidad > Estructura de propiedades | MANTENER jerarquia/seleccion, no grupo economico |
| Coeficientes/grupos | Pestaña maestra | Datos de la comunidad > Coeficientes y grupos | MANTENER, nunca en Contabilidad |
| Onboarding Excel | Configuracion inicial maestra | Datos de la comunidad > Configuracion inicial | MANTENER importador distinto del operativo |
| Presupuestos `budgets` | Herramientas | Gestion > Ficheros > Presupuestos | MOVER; cuotas calculadas, derramas, regularizaciones, simulacion, comparacion, importacion y aprobacion existentes intactas |
| Buscar `global-search` | Herramientas | Acceso global secundario Buscar | MOVER; mismo buscador y apertura de entidades |
| Administracion `admin` | Herramientas | Configuracion global | RENOMBRAR acceso; usuarios, comunidades/asignaciones/permisos existentes, sin cambiar autoridad |
| Banco, contabilidad, recibos legacy, proveedores | Tablas, servicios/consultas IA, documentos; sin vista web independiente en inventario | Mismos consumidores actuales; futura ubicacion documentada abajo | NO crear un modulo web para simular una reubicacion. No suprimir datos/consultas |

Los accesos a un mismo modal desde mapa, IA, busqueda y tarjeta no son funciones duplicadas. Documentos e Informes no son equivalentes: no se fusionan. Importador de maestros e importador operativo tampoco. Las tablas contables/proveedores y su mencion en roadmaps no prueban que haya pantallas de gestion web; no se anuncia Contabilidad/Proveedores como nueva funcionalidad publicada. Cualquier interfaz de escritorio fuera de este repositorio queda fuera de esta intervencion y no se elimina.

Mapa tecnicamente valido: cada vista y acceso real conserva destino, sin migracion, eliminacion ni cambio de negocio/permisos. Se autoriza pasar automaticamente a fase B segun la instruccion del usuario. No hay conflicto material que requiera escoger entre comportamientos distintos.

## Arquitectura objetivo aplicada

- Inicio: panel existente de atencion, sin duplicar menu entero.
- Tareas: Trabajo Hoy, Tareas, Proyectos, Decisiones/Revision segun perfil, Notificaciones, Documentacion, IA y reuniones, Seguridad.
- Gestion: Ficheros (Datos de la comunidad y Presupuestos) y Asambleas.
- Secundarios globales: Buscar y Configuracion global segun permisos. Centro IA conserva tambien acceso flotante transversal.

Los grupos se pliegan; abrir una vista revela su rama. Movil utiliza la misma estructura/visibilidad, no otro catalogo que pueda divergir. Breadcrumb informativo de ubicacion, sin sustituir acciones contextuales. Las incidencias y filtros de cada modulo permanecen sin cambios. No se renombra el concepto juridico/tecnico en datos, solo etiquetas de acceso.

## Compatibilidad y permisos

Conservar los 17 IDs de botones y claves de vista, `switchView`, `openEntity`, `data-home-view`, `data-daily-action` y enlaces de documentos/exportaciones. Sin cambio de `/api/entity/*`, `/api/president/*`, `/api/reports-center`, `/api/report/*`, `/api/import/*`, `/api/ai/*`, `/api/agent/*`, `/api/security/*`, `/api/assembl*`, `/api/admin*`, `/api/erp/*`. No hacen falta redirecciones.

La visibilidad parte de las condiciones de rol/comunidad ya existentes; un grupo sin destinos autorizados desaparece. Presidente sigue sin acceso a informes; Seguridad no obtiene navegacion hacia otros modulos. El backend sigue siendo la autoridad. Configuracion de comunidad sigue dentro de Ficheros; Configuracion global mantiene acceso exclusivo existente.

## Ubicaciones futuras, NO botones publicados

Gestion > Ingresos y recibos para ERP 3; Bancos y remesas para operaciones ERP 4/5; Proveedores y gastos para ERP 7; Contabilidad para ERP 6; Informes para informes administrativos/economicos cuando sus vistas existan. Datos bancarios maestros y proveedor contextual podran abrir una misma ficha desde Ficheros sin duplicar implementacion. Configuracion global podra incorporar catalogos, plantillas e integraciones solo cuando existan. Ejercicios se seleccionan en listados, sin duplicar modulos antiguos/nuevos. ERP 2 YA esta implementado: este trabajo lo conserva, no lo vuelve a desarrollar.

## Checkpoint, pruebas y cierre

Checkpoint previo previsto `navigation-structure-pre-20260911` en `42aa98f`. Cambios documentales previos (diseno ERP 3 e investigacion UX) no son incompatibles y no se revierten. Rollback: publicar el codigo previo mediante procedimiento existente conservando datos; no `reset --hard` ni restaurar una base antigua para un cambio de menu. Puerta de publicacion habitual exige backup consistente aunque este ajuste no migre datos.

Pruebas locales superadas: `verify-navigation-structure.mjs` comprueba los 17 IDs conservados, 15 destinos visibles del perfil completo con clics reales en 360/390/1440 px, apertura desde Inicio a Trabajo Hoy y de mapa a ficha, restricciones de Presidente/Consulta/Seguridad, rama activa, ausencia de desbordamiento y errores JavaScript. `verify-release-ui.mjs` supera sus siete vistas y recorridos ERP en escritorio/movil con apertura de ramas. Condiciones de rutas HTTP comparadas con `42aa98f`: identicas. No se prueba una pantalla inexistente de Contabilidad/Proveedores como si estuviera implementada; sus consultas siguen en la regresion operativa habitual.

La rama de la vista activa se abre y las otras se pliegan al cambiar de pantalla. No se requiere mantener todas las ramas desplegadas para localizar el destino actual.

### Cierre

- Reorganizacion completada y publicada: 100% de este trabajo transversal, sin variar certificaciones ERP. Implementacion `c7e9e10`; checkpoint final `navigation-structure-certified-20260911`. Codigo y documentacion de navegacion en GitHub.
- Capturas finales revisadas: `navigation-structure-B9Rb8q` (360/390/1440); regresion UI `organizador-ui-release-pd8Fkj` (siete vistas y recorridos en escritorio/movil). Comprobacion geometrica tras terminar la animacion del menu, no solo ancho del documento.
- Puerta Ubuntu superada: ERP 0/1/2, onboarding y regresion HTTP operativa (tareas/proyectos, documentos/informes, presidencia, seguridad, asambleas, IA y consultas contables). Pruebas sobre copias, sin operaciones economicas reales.
- Backup consistente `backups/before-operational-publish-20260911-094207`; checksums correctos, restauracion aislada `backups/restore-navigation-_psa6zcp/restored.db`, integridad y FKs correctas.
- Servicio publicado en 8771; HTTP 200 y estructura nueva comprobados por LAN y Tailscale. Sin migracion ni cambios de dominio/API. No se toca UNO Marbella.
- Incidencias bloqueantes: ninguna. Limitacion de inventario: Contabilidad/Proveedores no tienen vista web independiente que reubicar en este repositorio; sus datos/consumidores permanecen, y su ubicacion futura esta definida. ERP 3 sigue pendiente de decisiones funcionales de su contrato, no de esta reorganizacion.
