import { expect, it } from "vitest";
import { prepareSnippetInput } from "./terminalInput";
it("never submits an unprotected multiline insertion", () => {
  expect(() => prepareSnippetInput("uptime\nreboot", false, false)).toThrow(/varias líneas/);
  expect(prepareSnippetInput("uptime\nwhoami", false, true)).toBe("\x1b[200~uptime\nwhoami\x1b[201~");
  expect(prepareSnippetInput("uptime", false, false)).toBe("uptime");
  expect(prepareSnippetInput("uptime", true, true)).toBe("\x1b[200~uptime\x1b[201~\r");
});
it("rejects injected terminal controls before any payload can be sent", () => {
  for (const command of ["uptime\x1breboot", "uptime\x08reboot", "uptime\x03reboot", "uptime\x7freboot"]) expect(() => prepareSnippetInput(command, true, true)).toThrow(/control/);
});
