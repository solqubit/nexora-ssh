// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { HostModal } from "./HostModal";
import { PreferencesPanel } from "./PreferencesPanel";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
import { emptyConnectionProfile } from "../lib/connectionProfile";
import { useAppStore } from "../store/appStore";
import type { Host } from "../types";
const api = vi.hoisted(() => ({ getSecretStatus: vi.fn(), revealHostPassword: vi.fn() }));
vi.mock("../lib/desktop", async original => ({ ...await original<object>(), ...api }));
beforeEach(() => {
  vi.resetAllMocks();
  const snapshot = createInitialSnapshot(); snapshot.productivity!.identities = [{ id: "identity", name: "Access", vaultId: snapshot.vaults[0].id, username: "shared-user", authMethod: "password", updatedAt: "now" }];
  useAppStore.setState({ snapshot });
  api.getSecretStatus.mockResolvedValue({ hasPassword: false, hasPrivateKey: false, hasKeyPassphrase: false, privateKeyName: null });
});
afterEach(cleanup);

it.each(["enter", "temporary", "save"])("quick connect has an explicit save choice and defaults Enter to temporary: %s", async action => {
  const snapshot = useAppStore.getState().snapshot, save = vi.fn().mockResolvedValue(undefined), close = vi.fn();
  render(<HostModal quick vaultId={snapshot.vaults[0].id} groups={snapshot.groups} selectedGroupId={null} initialDraft={{ name: "Quick", address: "localhost", username: "test" }} onSave={save} onClose={close} />);
  const password = screen.getByLabelText("Contraseña SSH"); fireEvent.change(password, { target: { value: "fixture" } });
  if (action === "enter") fireEvent.keyDown(password, { key: "Enter" });
  else fireEvent.click(screen.getByRole("button", { name: action === "save" ? "Guardar y conectar" : "Conectar sin guardar" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Quick" }), expect.objectContaining({ password: "fixture" }), true, expect.any(Object), action !== "save");
});

it("creates a host from an identity in one submission without copying secrets to the form", async () => {
  const snapshot = useAppStore.getState().snapshot, save = vi.fn().mockResolvedValue(undefined), close = vi.fn();
  render(<HostModal vaultId={snapshot.vaults[0].id} groups={snapshot.groups} selectedGroupId={null} onSave={save} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Server" } });
  fireEvent.change(screen.getByLabelText("Dirección o IP"), { target: { value: "localhost" } });
  fireEvent.change(screen.getByLabelText("Identidad"), { target: { value: "identity" } });
  expect(screen.queryByLabelText("Contraseña SSH")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Guardar y conectar" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Server", username: "shared-user" }), { password: null, privateKey: null, privateKeyName: null, keyPassphrase: null, clearPassword: false, clearPrivateKey: false }, true, expect.objectContaining({ identityId: "identity" }), false);
});
it("edits metadata of an identity-backed host without revealing or replacing the shared password", async () => {
  const snapshot = useAppStore.getState().snapshot;
  const host: Host = { ...emptyHostDraft(snapshot.vaults[0].id), id: "host", name: "Server", address: "localhost", createdAt: "now", updatedAt: "now" };
  snapshot.hosts.push(host); snapshot.productivity!.connectionProfiles = [{ hostId: host.id, identityId: "identity", inheritUsername: false, inheritPort: false, inheritIdentity: false, inheritKeepalive: false, keepaliveSeconds: null }];
  const save = vi.fn().mockResolvedValue(undefined);
  render(<HostModal host={host} vaultId={host.vaultId} selectedGroupId={host.groupId} groups={snapshot.groups} onSave={save} onClose={vi.fn()} />);
  await waitFor(() => expect((screen.getByLabelText("Nombre") as HTMLInputElement).disabled).toBe(false));
  expect(screen.queryByRole("button", { name: "Revelar contraseña" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Renamed" } });
  fireEvent.change(screen.getByLabelText("Etiquetas"), { target: { value: "Linux, web, linux" } });
  fireEvent.click(screen.getByRole("button", { name: /^Guardar$/ }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed", tags: ["Linux", "web"] }), { password: null, privateKey: null, privateKeyName: null, keyPassphrase: null, clearPassword: false, clearPrivateKey: false }, false, expect.objectContaining({ identityId: "identity" }), false));
  expect(api.revealHostPassword).not.toHaveBeenCalled();
});
it("explains reserved or duplicate shortcuts without saving an invalid assignment", () => {
  const change = vi.fn(); render(<PreferencesPanel preferences={DEFAULT_PREFERENCES} onChange={change} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Avanzado" }));
  const input = screen.getByRole("textbox", { name: "Atajo Paleta de comandos" });
  fireEvent.keyDown(input, { key: "c", ctrlKey: true, shiftKey: true }); expect(screen.getByRole("alert").textContent).toContain("reservados"); expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "t", ctrlKey: true, shiftKey: true }); expect(screen.getByRole("alert").textContent).toContain("ya está asignado"); expect(change).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "q", ctrlKey: true, shiftKey: true }); expect(change).toHaveBeenCalledWith({ shortcuts: { ...DEFAULT_PREFERENCES.shortcuts, palette: "Ctrl+Shift+Q" } });
});
