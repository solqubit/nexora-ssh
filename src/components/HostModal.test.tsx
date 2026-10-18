// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostModal } from "./HostModal";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { emptyConnectionProfile } from "../lib/connectionProfile";
import { useAppStore } from "../store/appStore";
import type { Host } from "../types";
const api = vi.hoisted(() => ({ getSecretStatus: vi.fn(), revealHostPassword: vi.fn() }));
vi.mock("../lib/desktop", () => api);
let host: Host;
beforeEach(() => {
  vi.resetAllMocks();
  const snapshot = createInitialSnapshot();
  host = { ...emptyHostDraft(snapshot.vaults[0].id), id: "existing", name: "Existing", address: "server.invalid", username: "demo", color: "#7198f5", tags: ["web"], note: "Keep notes", favorite: true, createdAt: "before", updatedAt: "before" };
  snapshot.hosts = [host];
  snapshot.productivity!.connectionProfiles = [{ ...emptyConnectionProfile(host.id), environment: "Production", tmuxSession: "work", keepaliveSeconds: 60 }];
  useAppStore.setState({ snapshot });
  api.getSecretStatus.mockResolvedValue({ hasPassword: true, hasPrivateKey: false, hasKeyPassphrase: false, privateKeyName: null });
});
afterEach(cleanup);
it("creates a Telnet host on port 23 with optional interactive credentials", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<HostModal vaultId={host.vaultId} selectedGroupId={null} groups={[]} onSave={save} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Protocolo"), { target: { value: "telnet" } });
  expect(screen.getByLabelText("Puerto")).toHaveProperty("value", "23");
  expect(screen.queryByLabelText("Identidad")).toBeNull();
  expect(screen.queryByRole("button", { name: "Agente SSH" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Opciones adicionales" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Equipo antiguo" } });
  fireEvent.change(screen.getByLabelText("Dirección o IP"), { target: { value: "192.0.2.23" } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar y conectar" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ protocol: "telnet", port: 23, username: "" }), expect.objectContaining({ password: null }), true, expect.any(Object), false));
});

it("retains a custom port when switching protocols", async () => {
  render(<HostModal vaultId={host.vaultId} selectedGroupId={null} groups={[]} onSave={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Puerto"), { target: { value: "2323" } });
  fireEvent.change(screen.getByLabelText("Protocolo"), { target: { value: "telnet" } });
  expect(screen.getByLabelText("Puerto")).toHaveProperty("value", "2323");
});

it("assigns an identity while editing an existing host without exposing its password", async () => {
  const snapshot = useAppStore.getState().snapshot;
  snapshot.productivity!.identities = [{ id: "shared", vaultId: host.vaultId, name: "Operador", username: "operator", authMethod: "password", updatedAt: "now" }];
  const save = vi.fn().mockResolvedValue(undefined);
  render(<HostModal host={host} vaultId={host.vaultId} selectedGroupId={null} groups={[]} onSave={save} onClose={vi.fn()} />);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText("Identidad"), { target: { value: "shared" } });
  expect(screen.getByLabelText("Usuario")).toHaveProperty("value", "operator");
  expect(screen.queryByLabelText("Contraseña SSH")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ username: "operator" }), expect.objectContaining({ password: null, clearPassword: false }), false, expect.objectContaining({ identityId: "shared" }), false));
  expect(api.revealHostPassword).not.toHaveBeenCalled();
});
async function editor(save = vi.fn().mockResolvedValue(undefined), close = vi.fn()) {
  render(<HostModal host={host} vaultId={host.vaultId} selectedGroupId={null} groups={[]} onSave={save} onClose={close} />);
  await act(async () => {});
  return { save, close };
}
it("updates existing metadata and keeps stored credentials and hidden connection settings", async () => {
  const { save, close } = await editor();
  expect((screen.getByLabelText("Contraseña SSH") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: host.id, name: "Renamed", tags: ["web"], note: "Keep notes", favorite: true, color: host.color }), expect.objectContaining({ password: null, privateKey: null, keyPassphrase: null, clearPassword: false }), false, expect.objectContaining({ environment: "Production", tmuxSession: "work", keepaliveSeconds: 60 }), false);
  expect(api.revealHostPassword).not.toHaveBeenCalled();
});
it("preserves a stored private key and its passphrase when editing the host", async () => {
  host.authMethod = "private_key";
  api.getSecretStatus.mockResolvedValue({ hasPassword: false, hasPrivateKey: true, hasKeyPassphrase: true, privateKeyName: "id_ed25519" });
  const { save } = await editor();
  expect(screen.getByText(/id_ed25519/)).toBeTruthy();
  expect((screen.getByLabelText("Clave privada") as HTMLTextAreaElement).value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Guardar y conectar" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][1]).toEqual({ password: null, privateKey: null, privateKeyName: null, keyPassphrase: null, clearPassword: true, clearPrivateKey: false });
  expect(save.mock.calls[0][2]).toBe(true);
});
it("requires a replacement credential after switching authentication method", async () => {
  await editor();
  fireEvent.click(screen.getByRole("button", { name: "Clave privada" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
  expect(screen.getByRole("alert").textContent).toContain("clave privada");
});
it("keeps edits until an explicit discard and prevents duplicate saves", async () => {
  let resolve!: () => void;
  const save = vi.fn().mockReturnValue(new Promise<void>(done => { resolve = done; }));
  const { close } = await editor(save);
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  fireEvent.click(screen.getByRole("button", { name: "Seguir editando" }));
  expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Unsaved");
  const form = screen.getByRole("dialog", { name: "Editar host" });
  fireEvent.submit(form); fireEvent.submit(form);
  expect(save).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Cancelar" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolve());
  expect(close).toHaveBeenCalledOnce();
});
