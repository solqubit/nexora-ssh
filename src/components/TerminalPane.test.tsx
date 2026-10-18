// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SshEvent } from "../types";
import { useAppStore } from "../store/appStore";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
const api = vi.hoisted(() => ({ startSshSession: vi.fn(), disconnectSshSession: vi.fn(), resizeSshSession: vi.fn(), trustSshHostKey: vi.fn() }));
vi.mock("../lib/desktop", async original => ({ ...await original<object>(), ...api }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  options = {}; cols = 80; rows = 24; modes = { bracketedPasteMode: true };
  loadAddon() {} open() {} writeln() {} write() {} focus() {} dispose() {} scrollToBottom() {}
  onData() { return { dispose() {} }; } onResize() { return { dispose() {} }; } onSelectionChange() { return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class { onDidChangeResults() { return { dispose() {} }; } } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
import { TerminalPane } from "./TerminalPane";
function Harness() {
  const snapshot = useAppStore(state => state.snapshot), session = useAppStore(state => state.tabs[0]);
  return <TerminalPane host={snapshot.hosts[0]} session={session} visible preferences={{ ...DEFAULT_PREFERENCES, autoReconnect: false }} onPreferencesChange={vi.fn()} />;
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  api.disconnectSshSession.mockResolvedValue(undefined); api.resizeSshSession.mockResolvedValue(undefined);
  const snapshot = createInitialSnapshot(); snapshot.hosts = [{ ...emptyHostDraft(snapshot.vaults[0].id), id: "host", name: "Server", address: "localhost", username: "test", createdAt: "now", updatedAt: "now" }];
  useAppStore.setState({ snapshot, temporaryHosts: [], tabs: [{ id: "session", hostId: "host", title: "Logs personalizados", status: "disconnected", autoConnect: false }], hostActivity: {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("requires an explicit replacement before reconnecting to a changed server key", async () => {
  let events!: (event: SshEvent) => void;
  api.startSshSession.mockImplementation(async (_id, _host, _columns, _rows, _keepalive, onEvent) => { events = onEvent; });
  api.trustSshHostKey.mockResolvedValue({ id: "new", hostId: "host", algorithm: "ssh-ed25519", fingerprint: "SHA256:new", publicKey: "new-key", trustedAt: "now" });
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
  await act(async () => {});
  act(() => events({ event: "hostKey", data: { hostId: "host", kind: "changed", algorithm: "ssh-ed25519", fingerprint: "SHA256:new", address: "localhost:22", challengeId: "replacement" } }));
  expect(api.trustSshHostKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reemplazar clave y conectar" }));
  await waitFor(() => expect(api.startSshSession).toHaveBeenCalledTimes(2));
  expect(api.trustSshHostKey).toHaveBeenCalledWith("host", "replacement", true);
  expect(useAppStore.getState().snapshot.knownHosts[0].publicKey).toBe("new-key");
});
it("confirms an intermediate host key and retries the original destination", async () => {
  let events!: (event: SshEvent) => void;
  api.startSshSession.mockImplementation(async (_id, _host, _columns, _rows, _keepalive, onEvent) => { events = onEvent; });
  const snapshot = useAppStore.getState().snapshot; snapshot.hosts.push({ ...snapshot.hosts[0], id: "gateway", name: "Gateway" });
  api.trustSshHostKey.mockResolvedValue({ id: "known-gateway", hostId: "gateway", algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", publicKey: "fixture-key", trustedAt: "now" });
  render(<Harness />); fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ })); await act(async () => {});
  act(() => { events({ event: "hostKey", data: { hostId: "gateway", kind: "unknown", algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", address: "Gateway · localhost:22", challengeId: "challenge-gateway" } }); events({ event: "status", data: { status: "trust_required", message: "Verify gateway" } }); });
  expect(screen.getByText("Gateway · localhost:22")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Confiar y conectar" }));
  await waitFor(() => expect(api.startSshSession).toHaveBeenCalledTimes(2));
  expect(api.trustSshHostKey).toHaveBeenCalledWith("gateway", "challenge-gateway", false); expect(api.startSshSession.mock.calls[1][1]).toBe("host"); expect(useAppStore.getState().snapshot.knownHosts[0].hostId).toBe("gateway");
});
it("renders a temporary session and removes its save banner without stopping the live terminal on promotion", async () => {
  const state = useAppStore.getState(), host = state.snapshot.hosts[0], savedSnapshot = state.snapshot, save = vi.fn(), forget = vi.fn();
  useAppStore.setState({ snapshot: { ...savedSnapshot, hosts: [] }, temporaryHosts: [{ host, connection: { hostId: host.id, identityId: null, inheritUsername: false, inheritPort: false, inheritIdentity: false, inheritKeepalive: false, keepaliveSeconds: null, environment: "QA" }, knownHost: null }], tabs: [{ ...state.tabs[0], status: "connected" }] });
  function TemporaryHarness() { const current = useAppStore(); return <TerminalPane host={current.snapshot.hosts[0] ?? current.temporaryHosts[0].host} session={current.tabs[0]} visible preferences={DEFAULT_PREFERENCES} onPreferencesChange={vi.fn()} onSaveTemporary={save} onForgetTemporary={forget} />; }
  render(<TemporaryHarness />); expect(screen.getByText("QA")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Guardar host" })); expect(save).toHaveBeenCalledWith(host.id);
  fireEvent.click(screen.getByRole("button", { name: "Olvidar" })); expect(forget).toHaveBeenCalledWith(host);
  act(() => useAppStore.setState({ snapshot: savedSnapshot, temporaryHosts: [] }));
  expect(screen.queryByText(/Conexión temporal/)).toBeNull(); expect(api.disconnectSshSession).not.toHaveBeenCalled(); expect(api.startSshSession).not.toHaveBeenCalled();
});
it("shows connection stages and cancels after native registration, ignoring stale events", async () => {
  let register!: () => void, events!: (event: SshEvent) => void;
  api.startSshSession.mockImplementation((_id, _host, _columns, _rows, _keepalive, onEvent) => { events = onEvent; return new Promise<void>(resolve => { register = resolve; }); });
  render(<Harness />);
  expect(screen.getByText("Logs personalizados")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
  act(() => events({ event: "stage", data: { phase: "authentication", message: "Autenticando a test…" } }));
  expect(screen.getByRole("status").textContent).toBe("Autenticando a test…");
  fireEvent.click(screen.getByRole("button", { name: /^Cancelar$/ }));
  expect(api.disconnectSshSession).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Cancelando…" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => events({ event: "status", data: { status: "connected", message: "Late event" } }));
  await act(async () => { register(); });
  await waitFor(() => expect(api.disconnectSshSession).toHaveBeenCalledWith("session"));
  expect(useAppStore.getState().tabs[0].status).toBe("disconnected");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("Late event")).toBeNull();
});
it("shows a native rejection as an actionable error and allows an explicit retry", async () => {
  api.startSshSession.mockRejectedValue(new Error("El servidor rechazó la terminal virtual"));
  render(<Harness />); fireEvent.click(screen.getByRole("button", { name: /^Conectar$/ }));
  expect((await screen.findByRole("alert")).textContent).toBe("El servidor rechazó la terminal virtual");
  fireEvent.click(screen.getByRole("button", { name: /^Reconectar$/ }));
  await waitFor(() => expect(api.startSshSession).toHaveBeenCalledTimes(2));
});
