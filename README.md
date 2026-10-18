# Nexora SSH

Cliente SSH, Telnet y SFTP para Windows, con una interfaz minimalista para organizar servidores, abrir terminales y transferir archivos.

**Versión 0.1.7 · Windows x64**

## Descargar

**[Descargar Nexora SSH para Windows x64](https://github.com/solqubit/nexora-ssh/releases/latest)**

Elige el archivo terminado en **`-setup.exe`** para instalar. También encontrarás el ejecutable independiente y los hashes SHA-256.

Requiere Microsoft Edge WebView2. Los binarios no están firmados digitalmente.

## Funciones principales

- Terminales SSH y Telnet en pestañas.
- Transferencias SFTP con doble panel y cola de archivos.
- Servidores organizados en grupos, favoritos y tarjetas compactas.
- Autenticación SSH por contraseña, clave privada o identidad guardada.
- Bóvedas por carpeta con contraseña maestra y credenciales cifradas.
- Túneles SSH, snippets y editor remoto.

Al iniciar, crea una bóveda en una carpeta o abre una existente. Cada cambio se guarda directamente en ella. Para trasladarla, ciérrala y copia su carpeta; necesitarás su contraseña maestra. [Guía de uso y recuperación](docs/guia-de-uso.md).

## Compilar para uso personal

Necesitas Git, Node.js 24+, Rust 1.90+ (MSVC, rustfmt y Clippy), Visual Studio Build Tools 2022 con C++ y WebView2.

En PowerShell:

```powershell
git clone https://github.com/solqubit/nexora-ssh.git
cd nexora-ssh
npm.cmd ci
npm.cmd run check
npm.cmd run build:desktop -- --bundles nsis -- --locked
```

Encontrarás el instalador en `src-tauri/target/release/bundle/nsis/` y el ejecutable en `src-tauri/target/release/nexora-ssh.exe`.

Para desarrollo, usa `npm.cmd run tauri dev` después de instalar las dependencias. La compilación y distribución están verificadas para Windows x64.

## Documentación

- [Guía de uso, respaldos y límites](docs/guia-de-uso.md).
- [Arquitectura](docs/architecture.md).
- [Validación y límites conocidos](docs/validacion.md).
