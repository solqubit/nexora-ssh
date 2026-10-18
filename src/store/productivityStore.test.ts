// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { expandSnippet, snippetVariables, useProductivityStore } from "./productivityStore";
import { useAppStore } from "./appStore";
import { createInitialSnapshot } from "../data";
import { productivitySchema } from "../lib/productivityValidation";
beforeEach(() => { localStorage.clear(); useAppStore.getState().replaceSnapshot(createInitialSnapshot()); });
it("expands every unique variable as a literal POSIX shell argument", () => {
  const command = "printf '%s' {{service}}; echo {{service}}";
  expect(snippetVariables(command)).toEqual(["service"]);
  expect(expandSnippet(command, { service: "web';shutdown #" })).toBe("printf '%s' 'web'\\'';shutdown #'; echo 'web'\\'';shutdown #'");
  expect(() => expandSnippet(command, {})).toThrow();
});
it("quotes PowerShell variables without turning apostrophes or subexpressions into executable text", () => {
  expect(expandSnippet("Write-Output {{value}}", { value: "web';$(shutdown);#" }, "powershell")).toBe("Write-Output 'web'';$(shutdown);#'");
  expect(expandSnippet("Get-Item {{path}}", { path: "C:\\Program Files\\App" }, "powershell")).toBe("Get-Item 'C:\\Program Files\\App'");
  for (const command of ['Write-Output "{{value}}"', "Write-Output `{{value}}", "@'\n{{value}}\n'@", "Write-Output $({{value}})"]) expect(() => expandSnippet(command, { value: "value" }, "powershell")).toThrow();
});
it("rejects variable contexts where shell quoting would no longer protect arguments", () => {
  for (const command of ['echo "{{value}}"', "echo '{{value}}'", "echo \\{{value}}", "echo $(({{value}}))", "echo $(echo {{value}})", "cat <<EOF\n{{value}}\nEOF"]) expect(() => expandSnippet(command, { value: "$(reboot)" })).toThrow();
  expect(() => expandSnippet("echo {{value}}", { value: "test\rreboot" })).toThrow();
  expect(expandSnippet('echo "fixed" --service={{value}}', { value: 'a";$(reboot)' })).toBe('echo "fixed" --service=\'a";$(reboot)\'');
});
it("does not report a saved snippet if persistence fails", async () => {
  const snippet = { id: "1", vaultId: useAppStore.getState().snapshot.vaults[0].id, name: "Logs", category: "Ops", description: "", command: "journalctl", updatedAt: "now" };
  const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("disk full"); });
  await expect(useProductivityStore.getState().saveSnippet(snippet)).rejects.toThrow("disk full"); expect(useProductivityStore.getState().snippets).toEqual([]); spy.mockRestore();
});
it("rejects invalid pane indices loaded from storage", () => {
  expect(() => productivitySchema.parse({ snippets: [], workspaces: [{ id: "1", name: "Space", vaultId: "v", sessions: [{ hostId: "h", title: "t", pinned: false }], paneIndices: [5], layout: "grid", splitRatio: 50, updatedAt: "now" }] })).toThrow();
});
it("queues concurrent snippet saves in the same snapshot and reloads committed values", async () => {
  const base = { vaultId: useAppStore.getState().snapshot.vaults[0].id, category: "Ops", description: "", command: "uptime", updatedAt: "now" };
  await Promise.all([useProductivityStore.getState().saveSnippet({ ...base, id: "1", name: "One" }), useProductivityStore.getState().saveSnippet({ ...base, id: "2", name: "Two" })]);
  expect(useProductivityStore.getState().snippets.map(item => item.name)).toEqual(["One", "Two"]);
  useAppStore.getState().replaceSnapshot(createInitialSnapshot()); expect(useProductivityStore.getState().snippets).toEqual([]);
});
