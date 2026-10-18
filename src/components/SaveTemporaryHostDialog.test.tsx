// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SaveTemporaryHostDialog } from "./SaveTemporaryHostDialog";
import { useAppStore } from "../store/appStore";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { emptyConnectionProfile } from "../lib/connectionProfile";
afterEach(cleanup);
it("previews inherited group changes, submits once, and retains the entered name after a native failure", async () => {
  const snapshot = createInitialSnapshot(), group = snapshot.groups[0], host = { ...emptyHostDraft(snapshot.vaults[0].id), id: "temporary", name: "Quick", address: "localhost", username: "own", createdAt: "now", updatedAt: "now" };
  snapshot.productivity!.groupDefaults = [{ groupId: group.id, username: "inherited", port: 2222, identityId: null, keepaliveSeconds: null }];
  useAppStore.setState({ snapshot, temporaryHosts: [{ host, connection: { ...emptyConnectionProfile(host.id), inheritUsername: true, inheritPort: true }, knownHost: null }] });
  let reject!: (error: Error) => void; const save = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; })), close = vi.fn();
  render(<SaveTemporaryHostDialog host={host} groups={snapshot.groups} onSave={save} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Nombre del host"), { target: { value: "Saved name" } });
  fireEvent.change(screen.getByLabelText("Grupo"), { target: { value: group.id } });
  expect(screen.getByText(/Próxima conexión:/).textContent).toContain("inherited@localhost:2222");
  fireEvent.click(screen.getByRole("button", { name: "Guardar host" }));
  expect(save).toHaveBeenCalledWith("Saved name", group.id); expect(save).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Nombre del host")).toHaveProperty("disabled", true);
  reject(new Error("Native transaction failed"));
  expect((await screen.findByRole("alert")).textContent).toBe("Native transaction failed");
  await waitFor(() => expect(screen.getByLabelText("Nombre del host")).toHaveProperty("disabled", false));
  expect(screen.getByLabelText("Nombre del host")).toHaveProperty("value", "Saved name"); expect(close).not.toHaveBeenCalled();
});
