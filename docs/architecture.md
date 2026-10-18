# Arquitectura de Nexora SSH

## Capas

React/TypeScript usa Zustand para perfiles, selección y pestañas; xterm.js mantiene cada terminal. IPC tipado y permisos de Tauri limitan los comandos disponibles a la ventana principal. Rust administra SSH con russh/Tokio, Telnet con un transporte Tokio y negociación IAC, SFTP con russh-sftp, SQLite con rusqlite y bóvedas SQLite por carpeta.

El administrador de archivos puede solicitar operaciones locales con los permisos del usuario. Los permisos IPC limitan comandos y ventanas; no son un sandbox de rutas arbitrarias para comandos propios. Los nombres recibidos de servidores se consideran no confiables, se validan por componente y se rechazan escapes de rutas, ADS, dispositivos reservados y enlaces simbólicos de destino. Los enlaces externos solo aceptan HTTP/HTTPS.

## Estado durable

SQLite contiene metadatos, huellas confiables y un blob con secretos cifrados usando XChaCha20-Poly1305. Cada registro usa un nonce aleatorio y el ID del host como datos autenticados. Una clave maestra aleatoria por bóveda cifra los secretos. Se almacena protegida con XChaCha20-Poly1305 y una clave derivada de la contraseña mediante Argon2id (64 MiB, tres iteraciones, paralelismo uno). La sal y los nonces son aleatorios. La contraseña no se persiste y las claves en memoria se borran al liberarse; no se utiliza keyring. Un cambio prepara un almacén cifrado en memoria, valida la instantánea y confirma metadatos/cifrado en una sola transacción; solo después reemplaza el estado vivo. Un fallo deja la versión anterior de ambos.

Las mutaciones del frontend se ejecutan en cola y leen el estado al llegar a su turno. El backend compara la instantánea esperada contra los metadatos actuales y conserva las huellas aceptadas por el motor. Una instancia única y un bloqueo exclusivo del directorio evitan escritores independientes. SQLite usa WAL, FULL y espera de bloqueo de cinco segundos. La aplicación inicia bloqueada sin una bóveda implícita. Los metadatos permanecen en claro; las contraseñas, claves privadas y frases de paso se cifran.

## Sesiones y huellas

Terminal y SFTP comparten autenticación y política TOFU, con transports independientes. Nunca se autentica contra una huella desconocida o modificada. Cada propuesta obtiene un ID de desafío independiente, vinculado al host, dirección, puerto, clave y cinco minutos de vigencia. Aceptar una propuesta no acepta otra clave simultánea. La identidad cambiada requiere confirmar explícitamente el reemplazo. El desafío incluye la clave anterior observada; un cambio simultáneo invalida la confirmación.

Las conexiones tienen límites de espera para negociación/autenticación y cancelación. Una generación evita que respuestas tardías sustituyan conexiones o paneles nuevos. Las colas de transferencia cancelan lecturas/escrituras bloqueadas, acotan recorridos y no siguen enlaces. Mover a la misma ruta final o a una subcarpeta propia se rechaza antes de copiar. Mover elimina el origen únicamente después de terminar la copia; cancelar antes de ese paso conserva el origen.

Telnet comparte las pestañas y la cancelación del motor de terminales, con un transporte TCP independiente. Negocia ECHO, SGA, BINARY, NAWS y tipo de terminal VT100 para equipos antiguos. Las credenciales opcionales se envían desde Rust ante avisos de login; el tráfico Telnet no está cifrado y no utiliza TOFU.

## Bóvedas por carpeta

`VaultShell` controla el acceso al resto de la interfaz. El núcleo abre `boveda.nexora` únicamente tras verificar la contraseña. La cabecera contiene el identificador, formato, sal, nonce y clave maestra cifrada. La aplicación y el esquema tienen versiones independientes; se rechazan formatos futuros antes de escribir. Las migraciones compatibles usan la API de backup de SQLite antes de convertir datos.

Crear reserva el archivo de forma exclusiva y no sobrescribe archivos existentes. Abrir valida la cabecera y los secretos antes de abrir para escritura. El bloqueo `.nexora.lock` evita otro escritor cooperante sobre la carpeta. Cambiar de bóveda exige resolver borradores y transferencias, cerrar conexiones y túneles, retirar accesos temporales y limpiar el estado de la interfaz. El núcleo vuelve a comprobar que no queden operaciones antes de sustituir el almacén activo.

No hay importación ni exportación. Para trasladar datos, se cierra la bóveda y se copia su carpeta completa. AppData conserva únicamente datos auxiliares de la aplicación, como el estado de ventana; no aloja una bóveda automática.

## Protección de archivos

Los archivos locales se copian a un temporal exclusivo, se sincronizan y se sustituyen mediante MoveFileExW en Windows o rename/hard-link en Unix. El original no se elimina antes del reemplazo. Un fallo o cancelación limpia el temporal. Para SFTP se usa un respaldo temporal del original y se intenta restaurar si falla el renombrado; un corte de transporte puede requerir recuperar el respaldo manualmente. Las carpetas no forman una transacción global.

## Validación y distribución

Las pruebas de interfaz y estado comprueban guardados concurrentes, fallos de persistencia, borradores, revelación temporal, restauración y políticas de conflicto. Las pruebas Rust cubren transacciones, cifrado, validación, rutas, cancelación, archivos y SSH/SFTP de loopback. `npm run check` ejecuta todas las capas. El bundle Windows NSIS se construye con `npm run build:desktop`.

Los resultados de las comprobaciones y los avisos de dependencias se registran en [validación y límites conocidos](validacion.md).
