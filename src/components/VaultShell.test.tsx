// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ vaultInfo:vi.fn(),chooseVaultFolder:vi.fn(),unlockVault:vi.fn(),closeVault:vi.fn(),clearVaultViewState:vi.fn(),disconnectSshSession:vi.fn(),stopAllTunnels:vi.fn() }));
vi.mock("../lib/desktop",async original => ({...await original<object>(),...api}));
vi.mock("../App",() => ({ default:({onCloseVault}:{onCloseVault:()=>Promise<void>}) => <button onClick={() => void onCloseVault()}>Cambiar bóveda</button> }));
import { VaultShell } from "./VaultShell";
beforeEach(() => { vi.resetAllMocks();api.vaultInfo.mockResolvedValue(null);api.chooseVaultFolder.mockResolvedValue("D:/Bovedas/Personal");api.unlockVault.mockResolvedValue({folder:"D:/Bovedas/Personal",name:"Personal"}); });
afterEach(cleanup);
it("starts at vault selection without loading a saved connection list", async () => {
  render(<VaultShell />);
  expect(await screen.findByRole("heading",{name:"Tu bóveda, en tu carpeta"})).toBeTruthy();
  expect(api.clearVaultViewState).toHaveBeenCalled();
  expect(api.unlockVault).not.toHaveBeenCalled();
  expect(screen.queryByText("Importar")).toBeNull();
});
it("creates a named vault in the selected folder with a confirmed master password", async () => {
  render(<VaultShell />); fireEvent.click(await screen.findByRole("button",{name:"Crear bóveda"}));
  fireEvent.change(screen.getByLabelText("Nombre"),{target:{value:"Personal"}});
  fireEvent.click(screen.getByRole("button",{name:"Seleccionar carpeta"}));
  await waitFor(() => expect(screen.getByLabelText("Carpeta de la bóveda")).toHaveProperty("value","D:/Bovedas/Personal"));
  fireEvent.change(screen.getByLabelText("Contraseña maestra"),{target:{value:"fixture-password"}});
  fireEvent.change(screen.getByLabelText("Confirmar contraseña"),{target:{value:"fixture-password"}});
  fireEvent.submit(screen.getByRole("form",{name:"Crear bóveda"}));
  expect(await screen.findByRole("button",{name:"Cambiar bóveda"})).toBeTruthy();
  expect(api.unlockVault).toHaveBeenCalledWith("D:/Bovedas/Personal","Personal","fixture-password");
  fireEvent.click(screen.getByRole("button",{name:"Cambiar bóveda"}));
  expect(await screen.findByRole("heading",{name:"Tu bóveda, en tu carpeta"})).toBeTruthy();
  expect(api.closeVault).toHaveBeenCalledOnce();
});
it("keeps the vault closed on an incorrect password and permits retry", async () => {
  api.unlockVault.mockRejectedValueOnce(new Error("Contraseña incorrecta"));
  render(<VaultShell />); await screen.findByRole("form",{name:"Abrir bóveda"});
  fireEvent.click(screen.getByRole("button",{name:"Seleccionar carpeta"}));
  await waitFor(() => expect(screen.getByLabelText("Carpeta de la bóveda")).toHaveProperty("value","D:/Bovedas/Personal"));
  fireEvent.change(screen.getByLabelText("Contraseña maestra"),{target:{value:"wrong"}});
  fireEvent.submit(screen.getByRole("form",{name:"Abrir bóveda"}));
  expect((await screen.findByRole("alert")).textContent).toBe("Contraseña incorrecta");
  expect(screen.queryByRole("button",{name:"Cambiar bóveda"})).toBeNull();
  fireEvent.change(screen.getByLabelText("Contraseña maestra"),{target:{value:"correct-password"}});
  fireEvent.submit(screen.getByRole("form",{name:"Abrir bóveda"}));
  await screen.findByRole("button",{name:"Cambiar bóveda"});
  expect(api.unlockVault).toHaveBeenLastCalledWith("D:/Bovedas/Personal",null,"correct-password");
});
