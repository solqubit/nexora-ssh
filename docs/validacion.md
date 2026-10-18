# Validación de Nexora SSH 0.1.7

## Comprobaciones de publicación

Ejecutadas el 17 de octubre de 2026 en Windows x64:

| Comprobación | Resultado |
| --- | --- |
| `npm.cmd run check` | Correcto |
| Interfaz y estado | 125 pruebas aprobadas en 28 archivos |
| TypeScript y Vite | Correctos |
| Pruebas Rust | 87 aprobadas |
| rustfmt y Clippy con `-D warnings` | Correctos |
| Compilación limpia de escritorio, NSIS y lockfile fijo | Correcta |
| `npm.cmd audit --json` | Cero vulnerabilidades detectadas |
| `cargo audit --file src-tauri/Cargo.lock --json` | Una vulnerabilidad y cinco avisos adicionales |

Las pruebas de red utilizan servidores locales de prueba. Incluyen SSH, SFTP, Telnet, túneles, cancelación y verificación de claves. También se comprueban cifrado, portabilidad de credenciales entre carpetas, contraseñas incorrectas, rechazo de formatos futuros, bloqueo de escritores y respaldos previos a migraciones y conservación de borradores del editor.

La pantalla de creación y apertura de bóvedas se revisó en el navegador sin cargar datos personales. Las pruebas de persistencia se ejecutaron sobre el núcleo nativo y carpetas temporales; el navegador no sustituye sus operaciones de archivos. No representa una instalación ni una prueba visual nueva del ejecutable distribuido. Los resultados anteriores del desarrollo no se cuentan como pruebas nuevas de publicación.

## Dependencias y límites

Auditorías completas: [npm](npm-audit-2026-10-17.json) y [Cargo](cargo-audit-2026-10-17.json).

Cargo informa `RUSTSEC-2023-0071` en `rsa 0.10.0-rc.18`, sin versión corregida indicada por la base consultada. También aparecen cuatro avisos de mantenimiento y uno de `glib` en el lockfile de múltiples plataformas. No se han silenciado estos resultados.

La distribución se prepara para Windows x64 y requiere WebView2. Los binarios no están firmados digitalmente. No se ha verificado una instalación manual del paquete ni compatibilidad universal con servidores SSH. El repositorio no incluye una licencia de distribución seleccionada.

Los hashes de los paquetes se adjuntan a la release en `SHA256SUMS.txt`.
