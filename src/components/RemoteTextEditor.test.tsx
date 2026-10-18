// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteTextEditor, type RemoteTextTransport } from "./RemoteTextEditor";
afterEach(cleanup);
const props = () => ({ hostId: "fixture", hostName: "Fixture", path: "/config.txt", onClose: vi.fn(), onSaved: vi.fn(), onStateChange: vi.fn() });
it("retains the draft on conflicts and uses the reviewed revision only after an explicit replacement", async () => {
  const transport: RemoteTextTransport = { read: vi.fn().mockResolvedValue({ path: "/config.txt", text: "original", revision: "before" }), save: vi.fn().mockResolvedValueOnce({ status: "conflict", document: { path: "/config.txt", text: "changed externally", revision: "changed" } }).mockResolvedValueOnce({ status: "saved", document: { path: "/config.txt", text: "my draft", revision: "saved" }, warning: null }) };
  const handlers = props(); render(<RemoteTextEditor {...handlers} transport={transport} />);
  const field = await screen.findByRole("textbox", { name: "Contenido del archivo remoto" }); fireEvent.change(field, { target: { value: "my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar en servidor" }));
  expect(await screen.findByRole("textbox", { name: "Versión del servidor" })).toHaveProperty("value", "changed externally"); expect(field).toHaveProperty("value", "my draft");
  expect(transport.save).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "s", ctrlKey: true }); expect(transport.save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Guardar mi versión sobre esta revisión" }));
  await waitFor(() => expect(handlers.onSaved).toHaveBeenCalled());
  expect(transport.save).toHaveBeenLastCalledWith("fixture", "/config.txt", "changed", "my draft"); expect(screen.queryByRole("textbox", { name: "Versión del servidor" })).toBeNull();
});
it("keeps the draft on write failure and asks before closing it", async () => {
  const transport = { read: vi.fn().mockResolvedValue({ path: "/config.txt", text: "original", revision: "before" }), save: vi.fn().mockRejectedValue(new Error("Network failed")) };
  const handlers = props(); render(<RemoteTextEditor {...handlers} transport={transport} />);
  const field = await screen.findByRole("textbox", { name: "Contenido del archivo remoto" }); fireEvent.change(field, { target: { value: "my draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar en servidor" })); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Network failed"); expect(field).toHaveProperty("value", "my draft");
  fireEvent.click(screen.getByRole("button", { name: /^Cerrar$/ })); expect(handlers.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Seguir editando" })); expect(field).toHaveProperty("value", "my draft");
  fireEvent.click(screen.getByRole("button", { name: /^Cerrar$/ })); fireEvent.click(screen.getByRole("button", { name: "Descartar borrador y cerrar" })); expect(handlers.onClose).toHaveBeenCalled();
});
it("preserves CRLF across textarea normalization and prevents repeated save while pending", async () => {
  let resolve!: (value: unknown) => void;
  const transport = { read: vi.fn().mockResolvedValue({ path: "/config.txt", text: "original\r\nsecond\r\n", revision: "before" }), save: vi.fn().mockImplementation(() => new Promise(done => { resolve = done; })) };
  const handlers = props(); render(<RemoteTextEditor {...handlers} transport={transport} />);
  const field = await screen.findByRole("textbox", { name: "Contenido del archivo remoto" }); expect((screen.getByRole("button", { name: "Guardar en servidor" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(field, { target: { value: "changed\nsecond\n" } });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "s", ctrlKey: true }); fireEvent.keyDown(screen.getByRole("dialog"), { key: "s", ctrlKey: true });
  expect(transport.save).toHaveBeenCalledTimes(1); expect(transport.save).toHaveBeenCalledWith("fixture", "/config.txt", "before", "changed\r\nsecond\r\n");
  resolve({ status: "saved", document: { path: "/config.txt", text: "changed\r\nsecond\r\n", revision: "saved" }, warning: null }); await waitFor(() => expect(handlers.onSaved).toHaveBeenCalled());
});

it("retains an explicit line-ending change when file format is collapsed before saving", async () => {
  const transport = { read: vi.fn().mockResolvedValue({ path: "/config.txt", text: "first\r\nsecond\r\n", revision: "before" }), save: vi.fn().mockResolvedValue({ status: "saved", document: { path: "/config.txt", text: "first\nsecond\n", revision: "after" }, warning: null }) };
  render(<RemoteTextEditor {...props()} transport={transport} />);
  await screen.findByRole("textbox", { name: "Contenido del archivo remoto" });
  expect(screen.queryByLabelText("Fin de línea")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Formato del archivo" }));
  expect(screen.getByLabelText("Fin de línea")).toHaveProperty("value", "CRLF");
  fireEvent.change(screen.getByLabelText("Fin de línea"), { target: { value: "LF" } });
  fireEvent.click(screen.getByRole("button", { name: "Formato del archivo" }));
  fireEvent.click(screen.getByRole("button", { name: "Guardar en servidor" }));
  await waitFor(() => expect(transport.save).toHaveBeenCalledWith("fixture", "/config.txt", "before", "first\nsecond\n"));
});
