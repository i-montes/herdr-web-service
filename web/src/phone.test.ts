import { expect, test } from "bun:test";
import { phoneUrl } from "./OpenOnPhone.tsx";

test("the phone gets the public address, with the session when there is one", () => {
  expect(phoneUrl({ mode: "remote", url: "https://mac.tail1.ts.net" }, "#/")).toEqual({ url: "https://mac.tail1.ts.net/" });
  expect(phoneUrl({ mode: "lan", url: "http://192.168.1.20:7340" }, "#/sesion/w1%3Ap2")).toEqual({ url: "http://192.168.1.20:7340/#/sesion/w1%3Ap2" });
  expect(phoneUrl({ mode: "local", url: "http://localhost:7340" }, "")).toEqual({ reason: "local" });
  expect(phoneUrl({ mode: "remote", url: "pwd" }, "")).toEqual({ reason: "no-url" });
  expect(phoneUrl(undefined, "")).toEqual({ reason: "local" });
});
