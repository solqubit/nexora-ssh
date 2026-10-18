import { describe, expect, it } from "vitest";
import { nextFileSelection } from "./fileSelection";

const paths = ["a", "b", "c", "d", "e"];

describe("nextFileSelection", () => {
  it("replaces the selection on a normal click", () => {
    expect(nextFileSelection(paths, ["a", "b"], "d", "a", { additive: false, range: false }))
      .toEqual({ paths: ["d"], anchor: "d" });
  });

  it("toggles entries with Ctrl", () => {
    expect(nextFileSelection(paths, ["a", "c"], "c", "a", { additive: true, range: false }).paths)
      .toEqual(["a"]);
    expect(nextFileSelection(paths, ["a"], "d", "a", { additive: true, range: false }).paths)
      .toEqual(["a", "d"]);
  });

  it("selects contiguous ranges with Shift in both directions", () => {
    expect(nextFileSelection(paths, ["b"], "e", "b", { additive: false, range: true }).paths)
      .toEqual(["b", "c", "d", "e"]);
    expect(nextFileSelection(paths, ["d"], "b", "d", { additive: false, range: true }).paths)
      .toEqual(["b", "c", "d"]);
  });

  it("adds a range with Ctrl+Shift without duplicates", () => {
    expect(nextFileSelection(paths, ["a", "c"], "d", "c", { additive: true, range: true }).paths)
      .toEqual(["a", "c", "d"]);
  });
});
