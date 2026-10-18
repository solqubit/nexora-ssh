// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { clearVaultViewState, restoreVaultViewState } from "./desktop";
beforeEach(() => { clearVaultViewState(); localStorage.clear(); });
it("isolates saved tabs and file favorites between vaults while keeping application preferences", () => {
  localStorage.setItem("nexora.preferences.v1", "global-theme");
  restoreVaultViewState("folder-A");
  localStorage.setItem("nexora.sftp.favorites", "favorites-A");
  localStorage.setItem("nexora.session-tabs.v1", "tabs-A");
  restoreVaultViewState("folder-B");
  expect(localStorage.getItem("nexora.sftp.favorites")).toBeNull();
  expect(localStorage.getItem("nexora.session-tabs.v1")).toBeNull();
  localStorage.setItem("nexora.sftp.favorites", "favorites-B");
  clearVaultViewState();
  restoreVaultViewState("folder-A");
  expect(localStorage.getItem("nexora.sftp.favorites")).toBe("favorites-A");
  expect(localStorage.getItem("nexora.session-tabs.v1")).toBe("tabs-A");
  expect(localStorage.getItem("nexora.preferences.v1")).toBe("global-theme");
  clearVaultViewState();
  restoreVaultViewState("folder-B");
  expect(localStorage.getItem("nexora.sftp.favorites")).toBe("favorites-B");
});
