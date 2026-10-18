import { expect, it } from "vitest";
import { emptyHostDraft } from "../data";
import { matchesHostLabels, uniqueLabels } from "./hostFilters";
import { connectionProfileSchema } from "./productivityValidation";
import { emptyConnectionProfile } from "./connectionProfile";
it("deduplicates labels ignoring case and combines every selected tag with the environment", () => {
  expect(uniqueLabels([" Linux ", "linux", "web", "", "WEB"])).toEqual(["Linux", "web"]);
  const host = { ...emptyHostDraft("vault"), id: "host", createdAt: "now", updatedAt: "now", tags: ["Linux", "web"] };
  expect(matchesHostLabels(host, " Producción ", "producción", ["linux", "WEB"])).toBe(true);
  expect(matchesHostLabels(host, "Producción", null, ["db"])).toBe(false);
  expect(matchesHostLabels(host, "", "", [])).toBe(true);
  expect(matchesHostLabels(host, "Producción", "", [])).toBe(false);
});
it("keeps environments optional for legacy profiles and rejects blank or unbounded values", () => {
  const profile = emptyConnectionProfile("host");
  expect(connectionProfileSchema.parse(profile).environment).toBeUndefined();
  expect(connectionProfileSchema.parse({ ...profile, environment: "Producción" }).environment).toBe("Producción");
  for (const value of ["", "  ", "x".repeat(61), "a\0b"]) expect(() => connectionProfileSchema.parse({ ...profile, environment: value })).toThrow();
});
