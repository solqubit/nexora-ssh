// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { useAppStore } from "../store/appStore";
import { TunnelManager } from "./TunnelManager";
import type { TunnelProfile, TunnelState } from "../types";
const native = vi.hoisted(() => ({ listTunnels: vi.fn(), startTunnel: vi.fn(), stopTunnel: vi.fn(), stopAllTunnels: vi.fn(), trustSshHostKey: vi.fn() }));
vi.mock("../lib/desktop", async original => ({ ...await original<object>(), ...native }));
let saved: TunnelProfile, runtime: TunnelState[];
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  const snapshot = createInitialSnapshot(); snapshot.hosts = [{ ...emptyHostDraft(snapshot.vaults[0].id), id: "host", name: "Fixture", address: "localhost", username: "test", createdAt: "now", updatedAt: "now" }];
  saved = { id: "tunnel", hostId: "host", name: "Database", kind: "local", listenAddress: "127.0.0.1", listenPort: 0, targetAddress: "db.fixture.invalid", targetPort: 5432, updatedAt: "now" };
  snapshot.productivity!.tunnels = [saved]; useAppStore.setState({ snapshot }); runtime = [];
  native.listTunnels.mockImplementation(async () => runtime); native.startTunnel.mockResolvedValue(undefined); native.stopTunnel.mockResolvedValue(undefined); native.stopAllTunnels.mockResolvedValue(undefined);
});
afterEach(cleanup);
function manager() { render(<TunnelManager vaultId={useAppStore.getState().snapshot.vaults[0].id} keepaliveSeconds={30} />); }
it("shows the assigned port and closes an active tunnel explicitly", async () => {
  runtime = [{ profile: saved, status: "active", message: null, listenPort: 43123, lastError: null, trust: null }]; manager();
  await screen.findByText(/127.0.0.1:43123/); fireEvent.click(screen.getByRole("button", { name: /^Detener$/ }));
  await waitFor(() => expect(native.stopTunnel).toHaveBeenCalledWith("tunnel")); expect(native.startTunnel).not.toHaveBeenCalled();
});
it("saves SOCKS without opening SSH and refuses a non-loopback unauthenticated proxy", async () => {
  const previous = useAppStore.getState().updateProductivity; const save = vi.fn().mockResolvedValue(undefined); useAppStore.setState({ updateProductivity: save });
  try {
    manager(); fireEvent.click(screen.getByRole("button", { name: "Nuevo túnel" })); fireEvent.change(screen.getByLabelText("Nombre del túnel"), { target: { value: "Proxy" } }); fireEvent.change(screen.getByLabelText("Tipo de túnel"), { target: { value: "socks" } });
    expect(screen.queryByLabelText("Dirección de destino")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Avanzado" })); fireEvent.change(screen.getByLabelText("Dirección de escucha"), { target: { value: "0.0.0.0" } }); fireEvent.click(screen.getByRole("button", { name: "Guardar túnel" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("loopback")); expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Dirección de escucha"), { target: { value: "::1" } }); fireEvent.click(screen.getByRole("button", { name: "Guardar túnel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(native.startTunnel).not.toHaveBeenCalled();
    const result = save.mock.calls[0][0](useAppStore.getState().snapshot.productivity); expect(result.tunnels.at(-1)).toMatchObject({ kind: "socks", listenAddress: "::1", targetAddress: null, targetPort: null });
  } finally { useAppStore.setState({ updateProductivity: previous }); }
});
it("requires a concrete confirmation before exposing a listener beyond loopback", async () => {
  saved.listenAddress = "0.0.0.0"; manager(); fireEvent.click(screen.getByRole("button", { name: /^Iniciar$/ }));
  const dialog = await screen.findByRole("alertdialog"); expect(dialog.textContent).toContain("0.0.0.0:automático"); expect(native.startTunnel).not.toHaveBeenCalled(); fireEvent.click(within(dialog).getByRole("button", { name: "Iniciar con esta escucha" }));
  await waitFor(() => expect(native.startTunnel).toHaveBeenCalledWith("tunnel", 30));
});
it("trusts the exact jump server and resumes the originally selected tunnel", async () => {
  runtime = [{ profile: saved, status: "trust_required", message: "Verify", listenPort: null, lastError: null, trust: { hostId: "gateway", kind: "unknown", address: "Gateway", algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", challengeId: "challenge" } }];
  native.trustSshHostKey.mockResolvedValue({ id: "known", hostId: "gateway", algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", publicKey: "fixture", trustedAt: "now" });
  manager(); fireEvent.click(await screen.findByRole("button", { name: "Revisar huella" })); fireEvent.click(screen.getByRole("button", { name: "Confiar e iniciar" }));
  await waitFor(() => expect(native.startTunnel).toHaveBeenCalledWith("tunnel", 30)); expect(native.trustSshHostKey).toHaveBeenCalledWith("gateway", "challenge", false); expect(native.stopTunnel).toHaveBeenCalledWith("tunnel");
});
it("blocks changed fingerprints and retains the profile when stopping fails during deletion", async () => {
  runtime = [{ profile: saved, status: "error", message: "Changed", listenPort: null, lastError: null, trust: { hostId: "host", kind: "changed", address: "Fixture", algorithm: "ssh-ed25519", fingerprint: "SHA256:changed", challengeId: null } }]; manager();
  fireEvent.click(await screen.findByRole("button", { name: "Revisar huella" })); expect(screen.queryByRole("button", { name: "Confiar e iniciar" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: /^Cerrar$/ }));
  native.stopTunnel.mockRejectedValue(new Error("Cannot confirm closing")); fireEvent.click(screen.getByRole("button", { name: "Eliminar túnel Database" })); fireEvent.click(screen.getByRole("button", { name: "Detener y eliminar" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Cannot confirm closing"); expect(useAppStore.getState().snapshot.productivity!.tunnels).toEqual([saved]);
});
