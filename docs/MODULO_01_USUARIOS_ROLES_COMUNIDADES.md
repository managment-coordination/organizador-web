# Modulo 01 - Usuarios, roles y comunidades

## Estado de revision

```text
Modulo: Usuarios, roles y comunidades
Porcentaje de revision del modulo: 20%
Estado: diagnostico inicial y decisiones funcionales principales tomadas
Codigo modificado: no
Datos modificados: no
Ultima revision: 2026-09-02
```

## Finalidad cerrada

Este modulo tiene dos finalidades principales:

1. Controlar el acceso a la aplicacion.
2. Organizar el trabajo por usuario y comunidad.

No debe ser solo un login. Debe actuar como la base de seguridad, alcance de datos y reparto operativo de toda la app.

## Decisiones funcionales confirmadas

- La app debe permitir elegir una comunidad concreta o todas las comunidades asignadas cuando el usuario tenga mas de una.
- Los roles actuales se mantienen por ahora: Superusuario, Administrador, Usuario, Consulta, Presidente y Seguridad.
- Luis Gallardo debe ser usuario operativo normal.
- SuperUsuario debe reservarse para administracion tecnica/configuracion.
- Elena Cuenca es perfil Usuario.
- Las comunidades deben ser separacion real de datos, no solo filtro visual.
- Cada comunidad contiene sus propios datos, configuracion y documentacion.
- Seguridad pertenece actualmente a Macrocomunidad San Roque Club.
- Si en el futuro otra comunidad tiene seguridad propia, debe poder existir un usuario Seguridad vinculado a esa comunidad.
- Un usuario puede tener acceso a varias comunidades.
- Solo Superusuario puede crear, editar o desactivar usuarios y comunidades.
- Consulta puede ver documentos.
- Presidente debe ver solo proyectos/solicitudes dirigidas a el y nunca tareas salvo autorizacion concreta.
- Se mantiene contrasena propia por usuario y clave temporal de primer acceso.
- No se quiere bloqueo general por intentos fallidos de contrasena.
- No se quiere cierre automatico por inactividad en web.
- La IA debe respetar exactamente los permisos del usuario activo.
- Superusuario puede hacer consultas IA globales sobre todas las comunidades.
- La IA debe explicar cuando no puede mostrar algo por falta de permiso.

## Estado tecnico actual observado

### Tablas existentes principales

- `usuarios`
- `comunidades`
- `usuario_comunidad`
- `usuario_permisos`
- `auditoria`
- `notificaciones`
- `solicitudes_presidente`

### Campos relevantes existentes en usuarios

- `id_usuario`
- `nombre`
- `rol`
- `activo`
- `password_hash`
- `password_configurada`
- `clave_temporal_hash`
- `requiere_cambio_password`
- `ultimo_acceso`
- `intentos_fallidos`
- `bloqueado`
- `fecha_creacion`

La estructura de password es correcta a nivel conceptual: guarda hash, no texto plano.

### Usuarios actuales observados en servidor

- SuperUsuario - Superusuario.
- Elena Cuenca - Usuario.
- Luis Gallardo - Usuario.
- Presidente - Presidente.
- Seguridad - Seguridad.

### Comunidades actuales observadas en servidor

- Macrocomunidad San Roque Club.
- Alboaire Golf.
- Pueblo 1 Fase 1.

### Asignaciones actuales observadas

- Elena Cuenca: Macrocomunidad San Roque Club y Alboaire Golf.
- Luis Gallardo: Macrocomunidad San Roque Club.
- Presidente: Macrocomunidad San Roque Club.
- Seguridad: Macrocomunidad San Roque Club.
- SuperUsuario: Macrocomunidad San Roque Club, aunque por rol puede ver todas.

## Diagnostico

La base actual es valida como primera version, pero no esta suficientemente cerrada para una plataforma multi-comunidad avanzada.

Funciona para:

- acceso por usuario;
- contrasena con primer acceso;
- roles globales;
- asignacion de comunidades;
- seleccion de alcance por comunidad;
- filtros por comunidad en muchas consultas;
- perfil Seguridad limitado;
- perfil Presidente limitado;
- auditoria basica.

Necesita consolidacion en:

- presidente real por comunidad;
- permisos distintos por comunidad;
- reglas exactas de visibilidad para documentos;
- destino de notificaciones al presidente concreto;
- modelo de usuario Seguridad por comunidad;
- evitar usuario generico `Presidente` como identidad permanente;
- aclarar rol global frente a rol por comunidad.

## Punto critico 1 - Presidente por comunidad

La situacion actual usa un usuario llamado `Presidente`. Esto vale para una sola comunidad, pero no escala.

Modelo recomendado:

- El presidente debe ser un usuario real con nombre reconocible.
- Ejemplo: `Rudy Hassam`.
- Su rol global puede ser `Presidente`.
- Debe estar asignado solo a la comunidad o comunidades donde ejerce.
- Las solicitudes y notificaciones deben dirigirse al presidente asignado a esa comunidad, no al texto generico `Presidente`.

Pendiente tecnico:

- revisar si `solicitudes_presidente` y `notificaciones` deben guardar `id_usuario_presidente` ademas de `usuario_destino`;
- ajustar la creacion de solicitudes para buscar el presidente de la comunidad;
- mantener compatibilidad con solicitudes antiguas dirigidas a `Presidente`.

## Punto critico 2 - Permisos distintos por comunidad

Actualmente `usuario_comunidad` solo guarda:

- `id_usuario`
- `id_comunidad`

Esto permite saber que comunidades puede ver un usuario, pero no permite permisos diferentes por comunidad.

Modelo recomendado:

- Mantener rol global como perfil base.
- Ampliar `usuario_comunidad` con permisos por comunidad o crear una tabla nueva de permisos por comunidad.

Ejemplo conceptual:

```text
usuario_comunidad
- id_usuario
- id_comunidad
- rol_en_comunidad
- puede_ver
- puede_crear
- puede_actualizar
- puede_ver_documentos
- puede_generar_informes
- puede_gestionar_asambleas
- puede_gestionar_seguridad
- activo
```

Esto permitiria casos como:

- Luis gestiona dos comunidades con permisos completos.
- Elena puede trabajar en una comunidad y consultar otra.
- Presidente de una comunidad solo responde solicitudes de esa comunidad.
- Seguridad de una comunidad solo sube partes de esa comunidad.

## Punto pendiente - Administrador

La pregunta pendiente era:

`El Administrador puede asignar tareas/proyectos a otros usuarios o solo trabajar dentro de sus comunidades?`

Sentido de la pregunta:

No se refiere a crear usuarios. Eso queda solo para Superusuario.

Se refiere a si un futuro Administrador puede, dentro de sus comunidades asignadas:

- crear tareas/proyectos;
- editar tareas/proyectos;
- cambiar responsables;
- asignar proximos pasos a Luis, Elena, proveedor, presidente u otros;
- generar informes;
- gestionar documentos;
- gestionar asambleas de esa comunidad.

Propuesta recomendada:

- Superusuario: administra sistema, usuarios, comunidades y configuracion global.
- Administrador: administra el trabajo operativo de sus comunidades, pero no crea ni modifica usuarios/comunidades.
- Usuario: trabaja, crea y actualiza tareas/proyectos de sus comunidades, pero sin administrar configuracion.
- Consulta: solo lectura, con documentos si se autoriza.
- Presidente: solo decisiones/solicitudes de sus comunidades.
- Seguridad: solo modulo Seguridad de sus comunidades.

Decision pendiente del usuario:

- Confirmar si aceptamos esta definicion de Administrador.

## Reglas preliminares de IA para este modulo

La IA debe:

- consultar solo usuarios/comunidades visibles segun rol;
- no revelar hashes, claves temporales ni datos tecnicos sensibles;
- no resetear contrasenas sin confirmacion del Superusuario;
- explicar falta de permisos cuando proceda;
- para Superusuario, poder resumir usuarios, roles, comunidades asignadas y posibles incoherencias;
- no proponer crear usuarios genericos si el rol requiere identidad real, especialmente Presidente.

## Riesgos actuales

1. Usuario `Presidente` generico no escala a varias comunidades.
2. Las notificaciones al presidente pueden depender del nombre literal `Presidente`.
3. No hay permisos granulares por comunidad.
4. `usuario_permisos` solo contempla gestion de seguridad, no un modelo general.
5. Si se sigue ampliando sin cerrar esto, tareas, asambleas, seguridad e IA podrian heredar permisos insuficientemente definidos.

## Criterio de cierre del modulo

Este modulo se considerara estable cuando:

- existan usuarios reales por persona;
- los presidentes sean usuarios reales asignados a comunidades concretas;
- se pueda elegir comunidad o todas al entrar;
- los permisos por rol y comunidad esten definidos;
- las consultas respeten comunidades asignadas;
- la IA respete permisos y explique denegaciones;
- solo Superusuario administre usuarios y comunidades;
- Seguridad y Presidente no puedan acceder a modulos no permitidos;
- haya pruebas tecnicas de acceso por rol;
- se documente la matriz final de permisos.

