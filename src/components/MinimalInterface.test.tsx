// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createInitialSnapshot, emptyHostDraft } from "../data";
import { emptyConnectionProfile } from "../lib/connectionProfile";
import { DEFAULT_PREFERENCES, type AppPreferences } from "../lib/preferences";
import { useAppStore } from "../store/appStore";
import { HostFilters } from "./HostFilters";
import { PreferencesPanel } from "./PreferencesPanel";
afterEach(cleanup);

it("changes everyday preferences without resetting hidden advanced values", () => {
  const changed = vi.fn();
  function Preferences() {
    const [preferences, setPreferences] = useState<AppPreferences>({ ...DEFAULT_PREFERENCES, keepaliveSeconds: 120, terminalCursor: "underline", shortcuts: { ...DEFAULT_PREFERENCES.shortcuts, palette: "Ctrl+Shift+Q" } });
    return <PreferencesPanel preferences={preferences} onClose={vi.fn()} onChange={patch => { changed(patch); setPreferences(current => ({ ...current, ...patch })); }} />;
  }
  render(<Preferences />);
  expect(screen.queryByLabelText("Keepalive SSH")).toBeNull();
  expect(screen.queryByLabelText("Atajo Paleta de comandos")).toBeNull();
  fireEvent.change(screen.getByLabelText("Apariencia"), { target: { value: "light" } });
  expect(changed).toHaveBeenLastCalledWith({ interfaceTheme: "light" });
  fireEvent.click(screen.getByRole("button", { name: "Avanzado" }));
  expect(screen.getByLabelText("Keepalive SSH")).toHaveProperty("value", "120");
  expect(screen.getByLabelText("Cursor")).toHaveProperty("value", "underline");
  expect(screen.getByLabelText("Atajo Paleta de comandos")).toHaveProperty("value", "Ctrl+Shift+Q");
  fireEvent.change(screen.getByLabelText("Keepalive SSH"), { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "Avanzado" }));
  fireEvent.click(screen.getByRole("button", { name: "Avanzado" }));
  expect(screen.getByLabelText("Keepalive SSH")).toHaveProperty("value", "60");
  expect(screen.getByLabelText("Apariencia")).toHaveProperty("value", "light");
});



it("keeps filters removable when their last matching host disappears", () => {
  const environment = vi.fn(), tags = vi.fn();
  render(<HostFilters environments={[]} tags={[]} environment="Producción" selectedTags={["Linux"]} onEnvironment={environment} onTags={tags} />);
  expect(screen.queryByLabelText("Añadir filtro de etiqueta")).toBeNull();
  expect(screen.getByLabelText("Filtrar por entorno")).toHaveProperty("value", "name:Producción");
  fireEvent.click(screen.getByRole("button", { name: "Quitar filtro Linux" }));
  expect(tags).toHaveBeenCalledWith([]);
  fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
  expect(environment).toHaveBeenCalledWith(null);
});

it("omits empty filters without blocking the host list", () => {
  render(<HostFilters environments={[]} tags={[]} environment={null} selectedTags={[]} onEnvironment={vi.fn()} onTags={vi.fn()} />);
  expect(screen.queryByRole("group", { name: "Filtros de hosts" })).toBeNull();
});
