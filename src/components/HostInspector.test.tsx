// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostInspector } from "./HostInspector";
import { emptyHostDraft } from "../data";
import type { Host } from "../types";
const api = vi.hoisted(() => ({ getSecretStatus: vi.fn(), revealHostPassword: vi.fn() }));
vi.mock("../lib/desktop", () => api);
const host = (id: string): Host => ({ ...emptyHostDraft("vault"), id, name: id, address: "localhost", username: "test", createdAt: "now", updatedAt: "now" });
const handlers = { onClose: vi.fn(), onOpen: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined), onDiscard: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(), onDirtyChange: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  api.getSecretStatus.mockResolvedValue({ hasPassword: true, hasPrivateKey: false, privateKeyName: null, hasKeyPassphrase: false });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("temporary credential reveal", () => {
  it("ignores a password response from a previously selected host", async () => {
    let resolve!: (value: string) => void;
    api.revealHostPassword.mockReturnValue(new Promise<string>(done => { resolve = done; }));
    const view = render(<HostInspector host={host("first")} groups={[]} {...handlers} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Revelar contraseña" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Revelar contraseña" }));
    expect(api.revealHostPassword).toHaveBeenCalledWith("first");
    view.rerender(<HostInspector host={host("second")} groups={[]} {...handlers} />);
    await act(async () => resolve("FIRST_HOST_SECRET"));
    expect((screen.getByPlaceholderText("Guardada · deja vacío para conservarla") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Ocultar contraseña" })).toBeNull();
  });
  it("hides the revealed password after 20 seconds and does not resubmit a revealed password", async () => {
    api.revealHostPassword.mockResolvedValue("fixture-password");
    render(<HostInspector host={host("host")} groups={[]} {...handlers} />);
    await act(async () => {});
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revelar contraseña" })));
    expect((screen.getByPlaceholderText("Guardada · deja vacío para conservarla") as HTMLInputElement).value).toBe("fixture-password");
    act(() => vi.advanceTimersByTime(20_000));
    expect((screen.getByPlaceholderText("Guardada · deja vacío para conservarla") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Ocultar contraseña" })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revelar contraseña" })));
    vi.useRealTimers();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(handlers.onSave).toHaveBeenCalledOnce());
    expect(handlers.onSave.mock.calls[0][1].password).toBeNull();
    expect((screen.getByPlaceholderText("Guardada · deja vacío para conservarla") as HTMLInputElement).value).toBe("");
  });
});

describe("inline host editor", () => {
  async function openEditor() {
    render(<HostInspector host={host("server")} groups={[]} {...handlers} />);
    await waitFor(() => expect((screen.getByLabelText("Nombre") as HTMLInputElement).disabled).toBe(false));
  }

  it("edits connection fields and saves without opening or closing a dialog or replacing stored credentials", async () => {
    await openEditor();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Huella SSH")).toBeNull();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Servidor editado" } });
    fireEvent.change(screen.getByLabelText("Dirección o IP"), { target: { value: "server.local" } });
    fireEvent.change(screen.getByLabelText("Puerto"), { target: { value: "2222" } });
    fireEvent.change(screen.getByLabelText("Usuario"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(handlers.onSave).toHaveBeenCalledOnce());
    expect(handlers.onSave.mock.calls[0][0]).toMatchObject({ name: "Servidor editado", address: "server.local", port: 2222, username: "admin" });
    expect(handlers.onSave.mock.calls[0][1]).toMatchObject({ password: null, clearPassword: false });
    expect(handlers.onSave.mock.calls[0][2]).toBe(false);
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: "Editar conexión de server" })).toBeTruthy();
  });

  it("connects immediately when clean and saves before connecting when edited", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    expect(handlers.onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Nuevo nombre" } });
    fireEvent.click(screen.getByRole("button", { name: "Conectar" }));
    await waitFor(() => expect(handlers.onSave).toHaveBeenCalledOnce());
    expect(handlers.onSave.mock.calls[0][2]).toBe(true);
    expect(handlers.onOpen).toHaveBeenCalledOnce();
  });

  it("submits a replacement password without revealing the saved password", async () => {
    await openEditor();
    fireEvent.change(screen.getByLabelText("Contraseña", { selector: "input" }), { target: { value: "new-fixture-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Mostrar contraseña" }));
    expect(api.revealHostPassword).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(handlers.onSave).toHaveBeenCalledOnce());
    expect(handlers.onSave.mock.calls[0][1].password).toBe("new-fixture-secret");
  });

  it("keeps the draft and shows the error when saving fails", async () => {
    handlers.onSave.mockRejectedValueOnce(new Error("No se pudo guardar"));
    await openEditor();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Borrador conservado" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No se pudo guardar");
    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Borrador conservado");
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});
