// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { emptyHostDraft } from "../data";
import { SftpWorkspace, type SftpWorkspaceHandle } from "./SftpWorkspace";
import type { Host, LocalDirectory, SftpDirectory } from "../types";
const native = vi.hoisted(() => ({ listLocalDirectory: vi.fn(), connectSftp: vi.fn(), disconnectSftp: vi.fn(), transferLocalToSftp: vi.fn(), listSftpDirectory: vi.fn(), cleanupPreparedDrag: vi.fn(), readSftpTextFile: vi.fn(), saveSftpTextFile: vi.fn(), trustSshHostKey: vi.fn() }));
vi.mock("../lib/desktop", async original => ({ ...await original<object>(), ...native }));
const host: Host = { ...emptyHostDraft("vault"), id: "fixture", name: "Fixture", address: "localhost", username: "test", createdAt: "now", updatedAt: "now" };
const local: LocalDirectory = { path: "/source", parentPath: "/", roots: [], breadcrumbs: [], entries: ["conflict.txt", "fresh.txt"].map(name => ({ name, path: `/source/${name}`, isDirectory: false, isSymlink: false, size: 10, modifiedAt: null })) };
const remote: SftpDirectory = { path: "/target", entries: [] };
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  native.listLocalDirectory.mockResolvedValue(local);
  native.connectSftp.mockResolvedValue({ status: "connected", directory: remote });
  native.listSftpDirectory.mockResolvedValue(remote);
  native.disconnectSftp.mockResolvedValue(undefined);
  native.cleanupPreparedDrag.mockResolvedValue(undefined);
  native.transferLocalToSftp.mockImplementation(async (_host, source: string, _target, _overwrite, name: string | null) => source.includes("conflict") && !name
    ? { status: "conflict", name: "conflict.txt", targetPath: "/target/conflict.txt", isDirectory: false }
    : { status: "transferred", name: name ?? "fresh.txt", targetPath: `/target/${name ?? "fresh.txt"}`, fileCount: 1, totalBytes: 10 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps file actions reachable through More while retaining the selected file", async () => {
  render(<SftpWorkspace host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  const left = screen.getByRole("region", { name: "Panel izquierdo: Mi equipo" });
  const fileName = await within(left).findByText("fresh.txt");
  fireEvent.contextMenu(fileName, { clientX: 40, clientY: 40 });
  expect(screen.getByRole("menuitem", { name: /Renombrar/ })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Copiar ruta" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Más acciones" }));
  expect(screen.getByRole("menuitem", { name: "Copiar ruta" })).toBeTruthy();
  expect(fileName.closest('[aria-selected]')?.getAttribute("aria-selected")).toBe("true");
});
it("trusts the intermediate server while reconnecting the requested SFTP destination", async () => {
  native.connectSftp.mockResolvedValueOnce({ status: "trust_required", verificationHostId: "gateway", algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", address: "Gateway · localhost:22", challengeId: "challenge" }).mockResolvedValueOnce({ status: "connected", directory: remote });
  native.trustSshHostKey.mockResolvedValue({ id: "known-gateway", hostId: "gateway", algorithm: "ssh-ed25519", fingerprint: "SHA256:fixture", publicKey: "fixture-key", trustedAt: "now" });
  render(<SftpWorkspace host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Conectar" })); expect(await screen.findByText("Gateway · localhost:22")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Confiar y conectar" }));
  await waitFor(() => expect(native.connectSftp).toHaveBeenCalledTimes(2)); expect(native.trustSshHostKey).toHaveBeenCalledWith("gateway", "challenge", false); expect(native.connectSftp.mock.calls[1][0]).toBe(host.id);
});
it("explicitly replaces a changed SFTP key before retrying the destination", async () => {
  native.connectSftp.mockResolvedValueOnce({ status: "host_key_changed", verificationHostId: host.id, algorithm: "ssh-ed25519", fingerprint: "SHA256:new", address: "Reinstalled server", challengeId: "replace-sftp" }).mockResolvedValueOnce({ status: "connected", directory: remote });
  native.trustSshHostKey.mockResolvedValue({ id: "new", hostId: host.id, algorithm: "ssh-ed25519", fingerprint: "SHA256:new", publicKey: "new", trustedAt: "now" });
  render(<SftpWorkspace host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Conectar" }));
  expect(await screen.findByText("Reinstalled server")).toBeTruthy();
  expect(native.trustSshHostKey).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reemplazar clave y conectar" }));
  await waitFor(() => expect(native.connectSftp).toHaveBeenCalledTimes(2));
  expect(native.trustSshHostKey).toHaveBeenCalledWith(host.id, "replace-sftp", true);
});

it.each([false, true])("uses the native retry decision for route failures (retryable=%s)", async retryable => {
  const message = "Gateway connection rejected: TCP forwarding denied";
  native.connectSftp.mockResolvedValueOnce({ status: "failed", message, retryable });
  const activity = vi.fn();
  render(<SftpWorkspace host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={activity} onOpenSsh={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Conectar" }));
  await waitFor(() => expect(activity).toHaveBeenCalledWith(host.id, "error", message));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1800)); });
  expect(native.connectSftp).toHaveBeenCalledTimes(retryable ? 2 : 1);
  expect(screen.queryByText(/reintentando en/)).toBeNull();
});

it.each(["Omitir", "Conservar ambos"])("applies %s only to conflicting files in a mixed batch", async choice => {
  render(<SftpWorkspace host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Conectar" }));
  const left = screen.getByRole("region", { name: "Panel izquierdo: Mi equipo" });
  await within(left).findByText("fresh.txt");
  await waitFor(() => expect((within(left).getByRole("textbox", { name: "Ruta de Mi equipo" }) as HTMLInputElement).disabled).toBe(false));
  fireEvent.keyDown(left, { key: "a", ctrlKey: true });
  fireEvent.contextMenu(within(left).getByText("conflict.txt"));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Copiar al otro panel" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(`^${choice}`) }));
  await waitFor(() => expect(native.transferLocalToSftp.mock.calls.some(call => call[1] === "/source/fresh.txt")).toBe(true));
  const fresh = native.transferLocalToSftp.mock.calls.find(call => call[1] === "/source/fresh.txt")!;
  expect(fresh[4]).toBeNull();
  expect(native.transferLocalToSftp).toHaveBeenCalledTimes(choice === "Omitir" ? 2 : 3);
  await act(async () => {});
});

it.each(["double click", "context menu"])("opens the remote editor through %s and blocks vault restore while a draft is dirty", async method => {
  const file = { name: "config.txt", path: "/target/config.txt", isDirectory: false, isSymlink: false, size: 8, modifiedAt: null, permissions: 0o100640, owner: null, group: null };
  native.connectSftp.mockResolvedValue({ status: "connected", directory: { ...remote, entries: [file] } });
  native.readSftpTextFile.mockResolvedValue({ path: file.path, text: "original", revision: "before" });
  native.saveSftpTextFile.mockResolvedValue({ status: "saved", document: { path: file.path, text: "changed", revision: "after" }, warning: null });
  render(<SftpWorkspace host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Conectar" }));
  const right = screen.getByRole("region", { name: "Panel derecho: Fixture" });
  const row = await within(right).findByText("config.txt");
  if (method === "double click") fireEvent.doubleClick(row);
  else { fireEvent.contextMenu(row); fireEvent.click(await screen.findByRole("menuitem", { name: "Editar texto remoto" })); }
  const field = await screen.findByRole("textbox", { name: "Contenido del archivo remoto" });
  expect(native.readSftpTextFile).toHaveBeenCalledWith(host.id, file.path);
  fireEvent.change(field, { target: { value: "changed" } });
  const prepare = () => new Promise<void>((resolve, reject) => window.dispatchEvent(new CustomEvent("nexora:prepare-vault-change", { detail: { resolve, reject } })));
  await expect(prepare()).rejects.toThrow("borrador");
  expect(native.disconnectSftp).not.toHaveBeenCalled(); expect(field).toHaveProperty("value", "changed");
  fireEvent.click(screen.getByRole("button", { name: "Guardar en servidor" }));
  await screen.findByText("Archivo guardado en el servidor.");
  await act(async () => { await prepare(); });
  expect(native.disconnectSftp).toHaveBeenCalledWith(host.id);
  expect(screen.queryByRole("dialog", { name: /Editar archivo/ })).toBeNull();
});

it("restores file paths without opening SSH/SFTP and uses the saved remote path on explicit connect", async () => {
  const ref = createRef<SftpWorkspaceHandle>();
  native.listLocalDirectory.mockImplementation(async (path: string | null) => ({ ...local, path: path ?? local.path }));
  render(<SftpWorkspace ref={ref} host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  await screen.findByText("fresh.txt");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Ruta de Mi equipo" })).toHaveProperty("disabled", false));
  await act(async () => { await ref.current!.restore({ left: { kind: "local", path: "/saved-local" }, right: { kind: "host", hostId: host.id, path: "/var/log" }, splitRatio: 60 }); });
  expect(native.connectSftp).not.toHaveBeenCalled();
  expect(native.listLocalDirectory).toHaveBeenLastCalledWith("/saved-local");
  expect(ref.current!.capture()).toEqual({ left: { kind: "local", path: "/saved-local" }, right: { kind: "host", hostId: host.id, path: "/var/log" }, splitRatio: 60 });
  expect(screen.getByText(/Ubicación guardada: \/var\/log/)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
  await waitFor(() => expect(native.connectSftp).toHaveBeenCalledWith(host.id, "/var/log", 30));
});

it("refuses workspace restoration with a dirty editor and retains both the connection and draft", async () => {
  const ref = createRef<SftpWorkspaceHandle>();
  const file = { name: "config.txt", path: "/target/config.txt", isDirectory: false, isSymlink: false, size: 8, modifiedAt: null, permissions: "640", owner: null };
  native.connectSftp.mockResolvedValue({ status: "connected", directory: { ...remote, entries: [file] } });
  native.readSftpTextFile.mockResolvedValue({ path: file.path, text: "original", revision: "before" });
  render(<SftpWorkspace ref={ref} host={host} hosts={[host]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Conectar" }));
  fireEvent.doubleClick(await screen.findByText("config.txt"));
  const field = await screen.findByRole("textbox", { name: "Contenido del archivo remoto" }); fireEvent.change(field, { target: { value: "draft" } });
  await expect(ref.current!.restore({ left: { kind: "local", path: null }, right: { kind: "local", path: null }, splitRatio: 50 })).rejects.toThrow("borrador");
  await expect(ref.current!.detachHost(host.id)).rejects.toThrow("borrador");
  expect(field).toHaveProperty("value", "draft"); expect(native.disconnectSftp).not.toHaveBeenCalled();
});

it("detaches a forgotten host without replacing the other saved location", async () => {
  const ref = createRef<SftpWorkspaceHandle>(), other = { ...host, id: "other", name: "Other" };
  render(<SftpWorkspace ref={ref} host={host} hosts={[host, other]} hostActivity={{}} keepaliveSeconds={30} onRecordHostActivity={vi.fn()} onOpenSsh={vi.fn()} />);
  await screen.findByText("fresh.txt");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Ruta de Mi equipo" })).toHaveProperty("disabled", false));
  await act(async () => { await ref.current!.restore({ left: { kind: "host", hostId: other.id, path: "/other" }, right: { kind: "host", hostId: host.id, path: "/target" }, splitRatio: 60 }); });
  await act(async () => { await ref.current!.detachHost(host.id); });
  expect(native.disconnectSftp).toHaveBeenCalledWith(host.id); expect(native.disconnectSftp).not.toHaveBeenCalledWith(other.id);
  expect(ref.current!.capture()).toEqual({ left: { kind: "host", hostId: other.id, path: "/other" }, right: { kind: "local", path: "/source" }, splitRatio: 60 });
});
