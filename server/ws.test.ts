import { expect, test } from "bun:test";
import { socketsOfSession, staleSockets } from "./ws.ts";

const sock = (sessionId: string) => ({ data: { sessionId } });

test("staleSockets picks only sockets whose session is no longer alive", () => {
  const a1 = sock("a");
  const a2 = sock("a");
  const b = sock("b");
  const c = sock("c");
  const alive = new Set(["a", "c"]);
  expect(staleSockets(new Set([a1, b, a2, c]), (h) => alive.has(h))).toEqual([b]);
  expect(staleSockets(new Set([a1, c]), (h) => alive.has(h))).toEqual([]);
  expect(staleSockets(new Set([a1, b]), () => false)).toEqual([a1, b]);
});

test("socketsOfSession picks every socket opened with that session", () => {
  const a1 = sock("a");
  const a2 = sock("a");
  const b = sock("b");
  expect(socketsOfSession(new Set([a1, b, a2]), "a")).toEqual([a1, a2]);
  expect(socketsOfSession(new Set([b]), "a")).toEqual([]);
});
