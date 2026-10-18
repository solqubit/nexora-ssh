# Desarrollo de Nexora SSH

Versión del código: **0.1.7**. Aplicación de escritorio para Windows con Tauri 2, React/TypeScript y Rust.

## Interfaz

- Diseño minimalista y tarjetas compactas de 224 px, alineadas a la izquierda.
- El panel lateral permite editar conexión, credenciales y organización; Guardar mantiene abierto el panel y Descartar recupera los datos guardados.
- Conectar guarda los cambios pendientes. La huella no aparece en los detalles; se conserva la verificación nativa de claves SSH.
- Herramientas accesibles desde la barra izquierda. Los controles de Espacios, tmux y agente SSH no forman parte de la interfaz actual.

## Mapa del proyecto

- `src/components/VaultShell.tsx` y `src-tauri/src/vault.rs`: selección, desbloqueo y ciclo de vida de las bóvedas.
- `src/App.tsx`: navegación y coordinación de acciones.
- `src/components/HostModal.tsx`: formulario compartido de creación y edición.
- `src/components/HostInspector.tsx`: editor lateral del host.
- `src/styles.css`: diseño, temas y adaptación de la interfaz.
- `src/store/`: estado, perfiles y sesiones.
- `src-tauri/src/`: conexiones, persistencia, cifrado y archivos.
- `qa/`: escenarios visuales con datos de prueba.

## Trabajo local

Lee el README y comprueba el estado real de Git antes de modificar código. Conserva las funciones, perfiles y credenciales existentes. La bóveda activa reside en la carpeta seleccionada: `boveda.nexora` (SQLite) y archivos auxiliares administrados por Nexora. La contraseña maestra protege una clave aleatoria mediante Argon2id y XChaCha20-Poly1305. No se usa el almacén de credenciales de Windows ni un formato de exportación. El inicio permanece bloqueado hasta crear o abrir una bóveda. No crear una base de datos implícita en AppData.

Para revisar la interfaz en el navegador, usa `npm.cmd run dev -- --host 127.0.0.1`. Las conexiones y el almacén de credenciales requieren el núcleo nativo. La compilación de escritorio no es necesaria para ajustar el diseño.

Ejecuta `npm.cmd run check` para validar el proyecto. Las instrucciones de compilación están en el [README](README.md), la descripción técnica en [arquitectura](docs/architecture.md) y los resultados de publicación en [validación](docs/validacion.md). Distingue comprobaciones actuales de resultados anteriores.

`node_modules/`, `dist/` y `src-tauri/target/` son regenerables y están excluidos de Git. Los archivos de entorno, bases de datos, claves y bóvedas tampoco deben incorporarse al repositorio.

Los compilados de prueba se guardan en `.local/releases/<versión>/`, excluidos de Git. Trabajar desde este repositorio; mantener respaldos y salidas auxiliares dentro de `.local/`.
