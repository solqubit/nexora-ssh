import { expect, it } from "vitest";
import { parseQuickTarget } from "./quickConnect";
it("parses SSH flags, compact ports, targets and IPv6 without invoking a shell", () => {
  expect(parseQuickTarget("ssh test@server.local -p 2222")).toEqual({ username: "test", address: "server.local", port: 2222 });
  expect(parseQuickTarget("ssh -p2222 -l test 192.168.1.20")).toEqual({ username: "test", address: "192.168.1.20", port: 2222 });
  expect(parseQuickTarget("test@[2001:db8::1]:2200")).toEqual({ username: "test", address: "2001:db8::1", port: 2200 });
  expect(parseQuickTarget("server.local")).toEqual({ username: "", address: "server.local", port: 22 });
});
it.each(["ssh test@host rm -rf /", "test@host;shutdown", "test@host | echo hi", "ssh -oProxyCommand=x host", "ssh -p 22 host:2200", "ssh -p 22 -p 23 host", "test@host:0", "test@host:65536", "[::1]:notaport", "test@host\nshutdown", "ssh -l a b@host", "a@@host"])("rejects ambiguous or executable input: %s", input => expect(() => parseQuickTarget(input)).toThrow());
