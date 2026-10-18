# Guía de uso y recuperación

[Volver al README](../README.md)

## Editar un host

Haz clic en su tarjeta y modifica los campos en el panel lateral. **Guardar** aplica los cambios sin cerrarlo; **Descartar** recupera los datos guardados. **Conectar** guarda los cambios pendientes antes de abrir la terminal. Deja vacíos los campos de contraseña o clave guardadas para conservarlas.

## Conexiones rápidas

Para una conexión rápida, escribe `usuario@servidor:puerto` o `ssh usuario@[IPv6] -p puerto` en Inicio o la paleta. El formulario permite **Conectar sin guardar** o **Guardar y conectar**. Un acceso temporal se conserva en memoria hasta cerrar Nexora o cambiar de bóveda; puedes guardarlo desde su terminal o desde Inicio sin interrumpir la sesión. Cerrar su pestaña permite volver a abrirlo en Inicio. **Olvidar** cierra sus conexiones y retira sus credenciales temporales. Guarda el host para conservarlo en la bóveda.

## Conectar por Telnet

Crea o edita un host y elige **TELNET** en Protocolo. El puerto predeterminado es **23**; puedes cambiarlo. Usuario y contraseña son opcionales: Nexora los envía una sola vez si reconoce los avisos de inicio de sesión. También puedes escribirlos en la terminal. Al empezar a escribir, el inicio automático se detiene.

Telnet transmite sin cifrado y no usa huellas SSH. Las contraseñas guardadas permanecen cifradas en la bóveda. SFTP y los túneles requieren un host SSH.

## Reemplazar la clave de un servidor SSH

Si reinstalaste un servidor y cambió su clave, comprueba la nueva huella en la alerta y pulsa **Reemplazar clave y conectar**. Nexora guarda esa clave y vuelve a conectar. Cerrar la alerta conserva la anterior y mantiene la conexión bloqueada. El mismo flujo está disponible en SFTP y los túneles.

## Identidades

Crea una identidad en **Identidades**. Al crear o editar un host SSH, selecciónala en **Identidad**; su usuario predeterminado se completa y sus credenciales se usan al conectar. Puedes cambiar el usuario para ese host. La contraseña y la clave privada compartidas se editan desde la identidad.

## Túneles

En **Túneles**, guarda un perfil local, remoto o SOCKS5 y pulsa **Iniciar**. Local conecta un puerto de tu equipo a un servicio accesible desde el servidor; remoto conecta una escucha del servidor a un servicio de tu equipo. SOCKS5 admite CONNECT TCP con DNS remoto, IPv4 e IPv6, sin UDP/BIND ni contraseña SOCKS, y solo escucha en loopback. El puerto de escucha 0 solicita un puerto libre. **Detener** cierra la escucha y sus clientes; **Detener todos** cierra todos los túneles. Cerrar una terminal mantiene los túneles activos. Al iniciar Nexora, los túneles permanecen detenidos. Exportar una bóveda incluye únicamente sus metadatos y secretos.

## PowerShell

Para abrir PowerShell, usa la paleta de comandos o el selector de terminales. Se abre sin cargar el perfil personal.

## Snippets

Los snippets con variables permiten elegir POSIX o PowerShell para proteger sus argumentos con la sintaxis correspondiente. La inserción y la ejecución requieren destinos conectados seleccionados explícitamente. Guardar o restaurar un snippet no lo ejecuta.

## Credenciales

Los secretos persistentes permanecen cifrados en el núcleo nativo; los accesos temporales guardan sus credenciales únicamente en memoria nativa hasta guardarse o retirarse. La interfaz solo puede solicitar la revelación temporal de una contraseña guardada después de una acción explícita del usuario. Las claves privadas guardadas no se devuelven a la WebView y una huella solo se marca como confiable mediante el flujo nativo de verificación.

## Bóvedas por carpeta

Al iniciar, elige **Crear bóveda** o **Abrir bóveda**. Para crearla, selecciona una carpeta, escribe un nombre y establece una contraseña maestra de al menos diez caracteres. Conserva esa contraseña: no se puede recuperar.

La carpeta contiene `boveda.nexora`, una base SQLite con los perfiles y las credenciales cifradas. Las contraseñas, claves privadas y frases de paso están cifradas; los nombres, direcciones y otros metadatos no están cifrados. No se guardan la contraseña maestra ni una clave sin proteger en la carpeta.

Cada alta, edición guardada o eliminación actualiza esa misma bóveda. **Cambiar bóveda** cierra las conexiones y vuelve al selector. Primero deben resolverse los borradores y terminar o cancelar las transferencias.

Para trasladarla o hacer una copia, cierra Nexora y copia la carpeta completa. Podrás abrirla con la misma contraseña en otro equipo; no depende del almacén de Windows. No copies solamente el archivo principal mientras esté abierta: SQLite puede tener cambios pendientes en archivos auxiliares `-wal` y `-shm`. No borres esos archivos manualmente.

Usa almacenamiento local. La apertura simultánea de una misma bóveda en equipos diferentes o la sincronización de sus archivos mientras está abierta no están soportadas. La versión del formato se comprueba antes de modificarlo; una aplicación incompatible pedirá actualizarse. Una migración compatible crea previamente una copia consistente `.bak` en esa carpeta.

## Verificación y límites

`npm.cmd run check` ejecuta pruebas de React/estado, build TypeScript/Vite, rustfmt, pruebas Rust y Clippy; falla en cuanto falla una etapa. Los tests de red usan un servidor efímero en loopback y credenciales de prueba. El workflow de Windows repite los controles y crea un instalador en GitHub.

`npm.cmd audit` y `cargo audit --file src-tauri/Cargo.lock` verifican dependencias. Los resultados de esta versión y los avisos pendientes están en [validación y límites conocidos](validacion.md). Una compilación correcta no equivale a una auditoría de seguridad sin hallazgos.

Los reemplazos locales usan archivo temporal, sincronización y sustitución sin borrar antes el original. En servidores SFTP sin sustitución atómica se protege el original con un `.nexora-backup`; ante un corte durante la renombración puede requerir recuperación manual. Las carpetas se transfieren por archivos: una cancelación conserva los archivos ya completados y puede dejar carpetas parciales. No hay garantía transaccional de una carpeta entera ni pruebas universales con todos los servidores SSH, unidades de red y antivirus.
