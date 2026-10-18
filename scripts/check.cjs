const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
const windows = process.platform === "win32";
const npmCli = process.env.npm_execpath;
if (!npmCli) { console.error("Ejecuta npm run check desde la carpeta del proyecto."); process.exit(1); }
const localCargo = join(process.env.USERPROFILE || process.env.HOME || "", ".cargo", "bin", windows ? "cargo.exe" : "cargo");
const cargo = existsSync(localCargo) ? localCargo : "cargo";
const manifest = ["--manifest-path", "src-tauri/Cargo.toml"];
const steps = [
  [process.execPath, [npmCli, "test"]],
  [process.execPath, [npmCli, "run", "build"]],
  [cargo, ["fmt", ...manifest, "--", "--check"]],
  [cargo, ["test", ...manifest, "--locked"]],
  [cargo, ["clippy", ...manifest, "--locked", "--all-targets", "--", "-D", "warnings"]],
];
for (const [command, args] of steps) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}
