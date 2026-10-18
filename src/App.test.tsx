// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInitialSnapshot, emptyHostDraft } from "./data";
const api = vi.hoisted(() => ({ loadSnapshot: vi.fn(), getSecretStatus: vi.fn(), persistSnapshot: vi.fn() }));
vi.mock("./lib/desktop", async original => ({ ...await original<object>(), ...api }));
vi.mock("./components/SftpWorkspace", () => ({ SftpWorkspace: () => <div /> }));
vi.mock("./components/TerminalPane", () => ({ TerminalPane: () => <div /> }));
import App from "./App";
import { useAppStore } from "./store/appStore";
import { emptyConnectionProfile } from "./lib/connectionProfile";

beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear();
  const snapshot = createInitialSnapshot();
  snapshot.hosts.push({ ...emptyHostDraft(snapshot.vaults[0].id), id: "server", name: "Fixture server", address: "localhost", username: "test", createdAt: "now", updatedAt: "now" });
  api.loadSnapshot.mockResolvedValue(snapshot);
  api.getSecretStatus.mockResolvedValue({ hasPassword: true, hasPrivateKey: false, hasKeyPassphrase: false, privateKeyName: null });
  useAppStore.setState({ snapshot, selectedVaultId: snapshot.vaults[0].id, selectedHostId: null, selectedGroupId: null, search: "", tabs: [], activeTabId: null, hostActivity: {}, ready: false });
});
afterEach(cleanup);

it("connects with Enter without opening details, and ignores repeats and composition", async () => {
  render(<App />);
  const host = await screen.findByRole("group", { name: /^Host Fixture server/ });
  fireEvent.keyDown(host, { key: "Enter", repeat: true });
  fireEvent.keyDown(host, { key: "Enter", isComposing: true });
  expect(useAppStore.getState().tabs).toHaveLength(0);
  fireEvent.keyDown(host, { key: "Enter" });
  expect(useAppStore.getState().tabs).toHaveLength(1);
  expect(useAppStore.getState().tabs[0].hostId).toBe("server");
  expect(useAppStore.getState().selectedHostId).toBeNull();
});

it("opens the inline editor directly from the host menu", async () => {
  render(<App />);
  fireEvent.contextMenu(await screen.findByRole("group", { name: /^Host Fixture server/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Editar host" }));
  const editor = await screen.findByRole("form", { name: "Editar conexión de Fixture server" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(editor).getByLabelText("Nombre")).toHaveProperty("value", "Fixture server");
  expect(useAppStore.getState().tabs).toHaveLength(0);
});

it("shows all tools directly and removes workspaces and More", async () => {
  render(<App />); await screen.findByText("Fixture server");
  expect(screen.queryByRole("button", { name: "Más" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Espacios" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Snippets" }));
  expect(await screen.findByRole("heading", { name: "Snippets" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hosts" }));
  expect(screen.getByRole("group", { name: /^Host Fixture server/ })).toBeTruthy();
});

it("shows connection details immediately without advanced settings", async () => {
  render(<App />); const host = await screen.findByRole("group", { name: /^Host Fixture server/ });
  fireEvent.click(host);
  expect(screen.getByText("Protocolo")).toBeTruthy();
  expect(screen.getByText("Puerto")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Avanzado…" })).toBeNull();
});

it("protects an inline draft when switching to an existing terminal tab", async () => {
  render(<App />);
  const card = await screen.findByRole("group", { name: /^Host Fixture server/ });
  fireEvent.keyDown(card, { key: "Enter" });
  fireEvent.click(screen.getByRole("tab", { name: "Inicio" }));
  fireEvent.click(screen.getByRole("group", { name: /^Host Fixture server/ }));
  await waitFor(() => expect((screen.getByLabelText("Nombre") as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("tab", { name: "Fixture server" }));
  const confirmation = await screen.findByRole("alertdialog", { name: "Descartar cambios" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancelar" }));
  expect(screen.getByLabelText("Nombre")).toHaveProperty("value", "Keep this draft");
  expect(useAppStore.getState().activeTabId).toBeNull();
});

it("keeps the inline panel open after saving and discards back to that saved version", async () => {
  const fixture = await api.loadSnapshot();
  api.loadSnapshot.mockImplementation(async () => JSON.parse(localStorage.getItem("nexora.snapshot.v1") ?? "null") ?? fixture);
  render(<App />);
  fireEvent.click(await screen.findByRole("group", { name: /^Host Fixture server/ }));
  await waitFor(() => expect((screen.getByLabelText("Nombre") as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Saved server" } });
  fireEvent.click(screen.getByRole("button", { name: /^Guardar$/ }));
  await screen.findByRole("form", { name: "Editar conexión de Saved server" });
  await waitFor(() => expect((screen.getByRole("button", { name: /^Guardar$/ }) as HTMLButtonElement).disabled).toBe(true));
  const editor = screen.getByRole("form", { name: "Editar conexión de Saved server" });
  expect(useAppStore.getState().snapshot.hosts[0].name).toBe("Saved server");
  expect(screen.getByRole("group", { name: /^Host Saved server/ })).toBeTruthy();
  fireEvent.change(within(editor).getByLabelText("Nombre"), { target: { value: "Discard this draft" } });
  fireEvent.click(within(editor).getByRole("button", { name: /^Descartar$/ }));
  expect(screen.getByLabelText("Nombre")).toHaveProperty("value", "Saved server");
  expect(useAppStore.getState().snapshot.hosts[0].name).toBe("Saved server");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("consumes Enter while opening quick connect, so focus does not implicitly submit the new form", async () => {
  render(<App />); const input = await screen.findByRole("textbox", { name: "Buscar hosts" });
  fireEvent.change(input, { target: { value: "ssh qa@[2001:db8::1] -p 2222" } });
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  const form = await screen.findByRole("dialog", { name: "Conexión rápida" });
  expect(within(form).getByLabelText("Dirección o IP")).toHaveProperty("value", "2001:db8::1");
  expect(within(form).getByLabelText("Puerto")).toHaveProperty("value", "2222");
  expect(within(form).queryByRole("alert")).toBeNull();
  expect(within(form).getByRole("button", { name: "Conectar sin guardar" })).toBeTruthy();
});

it("combines environment and multiple tag filters and clears them without losing profiles", async () => {
  const snapshot = await api.loadSnapshot();
  snapshot.hosts[0].tags = ["Linux", "web"];
  snapshot.hosts.push({ ...snapshot.hosts[0], id: "dev", name: "Development host", tags: ["linux"] });
  snapshot.productivity.connectionProfiles = [{ ...emptyConnectionProfile("server"), environment: "Producción" }, { ...emptyConnectionProfile("dev"), environment: "Desarrollo" }];
  render(<App />); await screen.findByText("Fixture server");
  const cards = () => screen.queryAllByRole("group", { name: /^Host / });
  expect(cards()).toHaveLength(2);
  fireEvent.change(screen.getByRole("combobox", { name: "Filtrar por entorno" }), { target: { value: "name:Producción" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Añadir filtro de etiqueta" }), { target: { value: "Linux" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Añadir filtro de etiqueta" }), { target: { value: "web" } });
  expect(cards()).toHaveLength(1); expect(cards()[0].getAttribute("aria-label")).toContain("Producción");
  expect(screen.getByText("Coincide con todas las etiquetas")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Filtrar por entorno" }), { target: { value: "name:Desarrollo" } });
  expect(cards()).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Quitar filtro web" }));
  expect(cards()).toHaveLength(1); expect(cards()[0].textContent).toContain("Development host");
  fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
  expect(cards()).toHaveLength(2); expect(useAppStore.getState().snapshot.hosts).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox", { name: "Buscar hosts" }), { target: { value: "Producción" } });
  expect(cards()).toHaveLength(1);
});
it("keeps the selected host and its draft when group navigation is cancelled", async () => {
  render(<App />);
  fireEvent.click(await screen.findByText("Fixture server"));
  await waitFor(() => expect((screen.getByLabelText("Nombre") as HTMLInputElement).disabled).toBe(false));
  const input = screen.getByLabelText("Nombre") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Unsaved draft" } });
  fireEvent.click(screen.getByText("Producción", { selector: ".group-row span" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Descartar cambios" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancelar" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Descartar cambios" })).toBeNull());
  expect(useAppStore.getState().selectedHostId).toBe("server");
  expect(useAppStore.getState().selectedGroupId).toBeNull();
  expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Unsaved draft");
  fireEvent.click(screen.getByText("Producción", { selector: ".group-row span" }));
  fireEvent.click(within(await screen.findByRole("alertdialog", { name: "Descartar cambios" })).getByRole("button", { name: "Descartar cambios" }));
  await waitFor(() => expect(useAppStore.getState().selectedHostId).toBeNull());
  expect(useAppStore.getState().selectedGroupId).toBe(useAppStore.getState().snapshot.groups[0].id);
});
