// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { FilePane } from "./SftpWorkspace";
const entry = { name: "file.txt", path: "/folder/file.txt", isDirectory: false, isSymlink: false, size: 10, modifiedAt: null, permissions: "rw-r--r--", owner: "demo" };
function props(): ComponentProps<typeof FilePane> {
  return { side: "left", source: { kind: "local" }, hosts: [], title: "Mi equipo", subtitle: "Local", icon: null, directory: { path: "/folder", entries: [entry] }, entries: [entry, { ...entry, name: ".hidden", path: "/folder/.hidden" }], selectedPaths: [entry.path], busy: false, loading: false, error: null, parentPath: "/", connectionStatus: "connected", latencyMs: null, reconnectAttempts: 0, canGoBack: true, canGoForward: false, favorites: [{ id: "favorite", sourceKey: "local", path: "/saved", label: "Saved folder" }], currentFavorite: false, onSourceChange: vi.fn(), onBack: vi.fn(), onForward: vi.fn(), onToggleFavorite: vi.fn(), onOpenFavorite: vi.fn(), onSelect: vi.fn(), onSelectPath: vi.fn(), onOpen: vi.fn(), onOpenPath: vi.fn(), onRefresh: vi.fn(), onNewFolder: vi.fn(), onNewFile: vi.fn(), onRename: vi.fn(), onDeleteSelection: vi.fn(), onCopySelection: vi.fn(), onCutSelection: vi.fn(), onPaste: vi.fn(), canPaste: false, onContextMenu: vi.fn(), onStartDrag: vi.fn(), onSelectAll: vi.fn(), onClearSelection: vi.fn(), dropActive: false };
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }); });
afterEach(cleanup);
it("opens and clears the optional filter using Ctrl F and Escape", async () => {
  render(<FilePane {...props()} />);
  expect(screen.queryByLabelText("Filtrar archivos de Mi equipo")).toBeNull();
  fireEvent.keyDown(screen.getByRole("region", { name: "Panel izquierdo: Mi equipo" }), { key: "f", ctrlKey: true });
  const input = screen.getByLabelText("Filtrar archivos de Mi equipo");
  await waitFor(() => expect(document.activeElement).toBe(input));
  fireEvent.change(input, { target: { value: "unmatched" } });
  expect(screen.getByRole("region", { name: "Panel izquierdo: Mi equipo" }).querySelectorAll(".pane-file-row")).toHaveLength(0);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByLabelText("Filtrar archivos de Mi equipo")).toBeNull();
  expect(screen.getAllByText("file.txt").length).toBeGreaterThan(0);
});
it("keeps secondary actions and favorites usable without opening the selected file", async () => {
  const handlers = props(); render(<FilePane {...handlers} />);
  const opener = screen.getByRole("button", { name: "Opciones de archivos de Mi equipo" });
  fireEvent.keyDown(opener, { key: "Enter" });
  expect(handlers.onOpen).not.toHaveBeenCalled();
  fireEvent.click(opener);
  const refresh = screen.getByRole("menuitem", { name: "Actualizar" });
  fireEvent.keyDown(refresh, { key: "Enter" }); fireEvent.click(refresh);
  expect(handlers.onRefresh).toHaveBeenCalledOnce(); expect(handlers.onOpen).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Mostrar archivos ocultos" }));
  expect(screen.getByText(".hidden")).toBeTruthy();
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("menuitem", { name: "Ubicaciones favoritas" }));
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Saved folder" }));
  expect(handlers.onOpenFavorite).toHaveBeenCalledWith("/saved");
  await act(async () => {});
});
