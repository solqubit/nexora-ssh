// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./TerminalPane", () => ({ TerminalPane: ({ session, focused }: { session: { id: string }; focused: boolean }) => <div data-testid={`terminal-${session.id}`} data-focused={focused}><input aria-label={`Input ${session.id}`} /></div> }));
import { TerminalDeck, TerminalTools } from "./TerminalDeck";
import { useAppStore } from "../store/appStore";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { DEFAULT_PREFERENCES } from "../lib/preferences";
beforeEach(() => {
  localStorage.clear(); const snapshot = createInitialSnapshot(); snapshot.hosts.push({ ...emptyHostDraft(snapshot.vaults[0].id), id: "host", name: "Test", address: "localhost", username: "test", createdAt: "now", updatedAt: "now" });
  useAppStore.setState({ snapshot, tabs: [{ id: "a", hostId: "host", title: "A", status: "disconnected" }, { id: "b", hostId: "host", title: "B", status: "disconnected" }], activeTabId: "a", paneIds: ["a", "b"], terminalLayout: "columns", splitRatio: 50, maximizedPaneId: null });
});
afterEach(cleanup);
it("keeps terminal components mounted while changing focus and maximizing", async () => {
  render(<><TerminalTools onFiles={vi.fn()} onAddPane={vi.fn()} /><TerminalDeck visible preferences={DEFAULT_PREFERENCES} onPreferencesChange={vi.fn()} /></>);
  const first = await screen.findByTestId("terminal-a"); const second = await screen.findByTestId("terminal-b");
  fireEvent.focus(screen.getByLabelText("Input b")); await waitFor(() => expect(second.getAttribute("data-focused")).toBe("true"));
  expect(first).toBe(screen.getByTestId("terminal-a")); expect(first.getAttribute("data-focused")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Opciones de terminal" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Ampliar panel activo" })); expect(useAppStore.getState().maximizedPaneId).toBe("b");
  expect(screen.getByTestId("terminal-a")).toBe(first); expect(first.parentElement?.closest(".terminal-cell")?.hasAttribute("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Opciones de terminal" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Restaurar paneles" })); expect(useAppStore.getState().paneIds).toEqual(["a", "b"]);
});
