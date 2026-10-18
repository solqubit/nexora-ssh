/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("allows the main desktop window to invoke every operation needed to open and close a vault", () => {
  const permissions = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as { windows: string[]; permissions: string[] };
  const manifest = readFileSync("src-tauri/build.rs", "utf8");
  const handlers = readFileSync("src-tauri/src/lib.rs", "utf8");
  expect(permissions.windows).toContain("main");
  for (const command of ["vault_info", "choose_vault_folder", "unlock_vault", "close_vault"]) {
    expect(permissions.permissions).toContain(`allow-${command.replaceAll("_", "-")}`);
    expect(manifest).toContain(`"${command}"`);
    expect(handlers).toContain(`vault::${command},`);
  }
  expect(permissions.permissions).not.toContain("allow-import-vault");
  expect(permissions.permissions).not.toContain("allow-export-vault");
});
