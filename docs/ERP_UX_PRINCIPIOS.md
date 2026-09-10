# Principios UX permanentes del ERP

Fecha de adopcion: 11/09/2026. Este documento es vinculante para ERP 0-9 y para cualquier modulo transversal. Complementa los contratos de dominio: nunca autoriza a simplificar reglas, historicos, permisos, calculos o auditoria.

## Principios

1. Interfaz compacta y orientada a trabajo continuado, sin sacrificar legibilidad ni incidencias relevantes.
2. Lenguaje de administrador de comunidades. IDs, versiones, tablas, snapshots, claves de idempotencia y precision interna quedan fuera del flujo cotidiano.
3. Ayuda breve mediante `i` contextual o contenido desplegable; evitar parrafos permanentes que aumenten el recorrido.
4. Revelacion progresiva: primero la decision habitual y despues opciones secundarias o avanzadas plegadas.
5. Formularios cortos. No solicitar datos que el sistema pueda determinar con seguridad y mostrar valores propuestos antes de confirmar.
6. Operaciones masivas para altas, pertenencias, coeficientes y cambios repetitivos; toda operacion masiva ofrece vista previa, incidencias y confirmacion atomica.
7. Acciones desde la entidad natural: propietarios desde la propiedad, propiedades desde el propietario, participantes desde el grupo y ejercicio desde el presupuesto.
8. Incidencias bloqueantes, diferencias economicas, vencimientos y conflictos permanecen siempre visibles; la ayuda y el detalle tecnico si pueden plegarse.
9. Movil: una columna, controles tactiles estables, tablas con desplazamiento contenido y el menor scroll posible. La edicion economica intensiva sigue priorizando escritorio.
10. No crear una tabla o pestaña visible solo porque exista una entidad tecnica. La navegacion representa el trabajo del usuario.

## Patron de importacion

Toda importacion sigue `archivo -> deteccion de columnas -> mapeo -> staging -> vista previa -> incidencias -> confirmacion`. Las coincidencias dudosas no se fusionan, el archivo se identifica por hash y la repeticion confirmada no duplica datos. La escritura usa exclusivamente servicios de dominio existentes, permisos por comunidad, transaccion, version, idempotencia y auditoria.

## Lista de aceptacion UX

- La accion principal y su efecto se entienden sin documentacion tecnica.
- Las opciones avanzadas no interrumpen el flujo habitual.
- La aplicacion explica por que bloquea una accion y como resolverla.
- Una operacion repetitiva no obliga a abrir registros individualmente.
- Escritorio y 390 px no presentan desbordamiento global ni acciones inaccesibles.
- El resultado determinista antes y despues de un ajuste puramente UX es identico.

Documentos relacionados: [roadmap ERP](ERP_COMUNIDADES_ROADMAP.md), [ERP 1](ERP_01_DATOS_MAESTROS_IMPLEMENTACION.md) y [ERP 2](ERP_02_PRESUPUESTOS_CUOTAS_IMPLEMENTACION.md).
