// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
afterEach(cleanup);
it("filters by multiple terms and executes the selected result with the keyboard", () => {
  const connect = vi.fn(), close = vi.fn();
  render(<CommandPalette onClose={close} onQuickConnect={vi.fn()} items={[{ id: "1", label: "Production DB", category: "Host", detail: "admin@db.example", run: connect }, { id: "2", label: "Development", category: "Host", detail: "dev@example", run: vi.fn() }]} />);
  const input = screen.getByRole("combobox"); fireEvent.change(input, { target: { value: "prod admin" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(input, { key: "Enter" }); expect(close).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledOnce();
});
it("offers quick connect without executing the text as a command", () => {
  const quick = vi.fn(); render(<CommandPalette items={[]} onClose={vi.fn()} onQuickConnect={quick} />);
  const input = screen.getByRole("combobox"); fireEvent.change(input, { target: { value: "ssh user@host -p 2222" } }); fireEvent.keyDown(input, { key: "Enter" });
  expect(quick).toHaveBeenCalledWith("ssh user@host -p 2222");
});
