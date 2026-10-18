import { describe, expect, it } from "vitest";
import { createInitialSnapshot } from "../data";
import { parseAppSnapshot } from "./validation";
import { workspaceSchema } from "./productivityValidation";

describe("parseAppSnapshot", () => {
  it("accepts legacy workspaces and validates saved file paths and split bounds", () => {
    const workspace = { id: "workspace", name: "Work", vaultId: "vault", sessions: [{ hostId: "h".repeat(200), title: "Host", pinned: false }], paneIndices: [0], layout: "columns", splitRatio: 50, updatedAt: "now" };
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
    const files = { left: { kind: "local", path: "C:\\work" }, right: { kind: "host", hostId: "h".repeat(200), path: "/var/log" }, splitRatio: 60 };
    expect(workspaceSchema.safeParse({ ...workspace, files }).success).toBe(true);
    for (const path of ["relative/path", "/bad\0path", "a".repeat(4097)]) expect(workspaceSchema.safeParse({ ...workspace, files: { ...files, right: { ...files.right, path } } }).success).toBe(false);
    expect(workspaceSchema.safeParse({ ...workspace, files: { ...files, splitRatio: 90 } }).success).toBe(false);
  });
  it("accepts a valid application snapshot", () => {
    const snapshot = createInitialSnapshot();
    expect(parseAppSnapshot(snapshot)).toEqual(snapshot);
  });

  it("rejects dangling group references", () => {
    const snapshot = createInitialSnapshot();
    snapshot.hosts.push({
      id: "host-1",
      vaultId: snapshot.vaults[0].id,
      groupId: "missing-group",
      name: "Servidor",
      address: "192.168.1.10",
      port: 22,
      username: "ubuntu",
      authMethod: "password",
      keyPath: null,
      favorite: false,
      color: "#54d6b4",
      tags: [],
      note: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(() => parseAppSnapshot(snapshot)).toThrow(/referencias inválidas/);
  });

  it("rejects out-of-range SSH ports", () => {
    const snapshot = createInitialSnapshot() as unknown as { hosts: unknown[] } & Record<string, unknown>;
    snapshot.hosts.push({
      id: "host-1",
      vaultId: (snapshot.vaults as { id: string }[])[0].id,
      groupId: null,
      name: "Servidor",
      address: "localhost",
      port: 70_000,
      username: "ubuntu",
      authMethod: "password",
      keyPath: null,
      favorite: false,
      color: "#54d6b4",
      tags: [],
      note: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(() => parseAppSnapshot(snapshot)).toThrow(/datos guardados no son válidos/i);
  });

  it("rejects snapshots with more than one vault", () => {
    const snapshot = createInitialSnapshot();
    snapshot.vaults.push({
      ...snapshot.vaults[0],
      id: "vault-secondary",
      name: "Bóveda secundaria",
    });

    expect(() => parseAppSnapshot(snapshot)).toThrow(/datos guardados no son válidos/i);
  });

  it("rejects the removed SSH Agent authentication method", () => {
    const snapshot = createInitialSnapshot() as unknown as { hosts: unknown[] } & Record<string, unknown>;
    snapshot.hosts.push({
      id: "host-agent",
      vaultId: (snapshot.vaults as { id: string }[])[0].id,
      groupId: null,
      name: "Servidor antiguo",
      address: "localhost",
      port: 22,
      username: "ubuntu",
      authMethod: "agent",
      keyPath: null,
      favorite: false,
      color: "#54d6b4",
      tags: [],
      note: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(() => parseAppSnapshot(snapshot)).toThrow(/datos guardados no son válidos/i);
  });
});
