// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, loadPreferences, matchesShortcut, normalizeShortcuts } from "./preferences";
beforeEach(() => localStorage.clear());
it("repairs invalid shortcuts and preserves remote Ctrl combinations", () => {
  expect(normalizeShortcuts({ palette: "Ctrl+Shift+C" })).toEqual(DEFAULT_PREFERENCES.shortcuts);
  expect(normalizeShortcuts({ palette: "Ctrl+Shift+D" })).toEqual(DEFAULT_PREFERENCES.shortcuts);
  expect(matchesShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, key: "p" }, "Ctrl+Shift+P")).toBe(false);
  expect(matchesShortcut({ ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, key: "p" }, "Ctrl+Shift+P")).toBe(true);
});
it("loads older preferences with valid theme, width, font and shortcuts", () => {
  localStorage.setItem("nexora.preferences.v1", JSON.stringify({ terminalFontSize: 20, sidebarWidth: 5000, interfaceTheme: "unknown", terminalCursor: "bad" }));
  const value = loadPreferences(); expect(value.terminalFontSize).toBe(20); expect(value.sidebarWidth).toBe(420); expect(value.interfaceTheme).toBe("dark"); expect(value.terminalCursor).toBe("bar");
});
