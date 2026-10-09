import { expect, test } from "bun:test";
import { paneIdFrom, parsePaneInput } from "./panes.ts";

test("pane ids come from the path and are checked", () => {
  expect(paneIdFrom("/api/panes/w1%3Ap2/screen", "screen")).toBe("w1:p2");
  expect(paneIdFrom("/api/panes/w1:p2/input", "input")).toBe("w1:p2");
  expect(paneIdFrom("/api/panes/w1:p2/screen", "input")).toBeNull();
  expect(paneIdFrom("/api/panes/..%2F..%2Fx/screen", "screen")).toBeNull();
  expect(paneIdFrom("/api/panes//screen", "screen")).toBeNull();
});

test("input: text, enter and whitelisted keys", () => {
  expect(parsePaneInput({ text: "ls", enter: true })).toEqual({ ok: true, value: { text: "ls", keys: ["enter"] } });
  expect(parsePaneInput({ keys: ["esc", "down", "ctrl+c"] })).toEqual({ ok: true, value: { text: "", keys: ["esc", "down", "ctrl+c"] } });
  expect(parsePaneInput({ keys: ["ctrl+alt+del"] }).ok).toBe(false);
  expect(parsePaneInput({ text: 5 }).ok).toBe(false);
  expect(parsePaneInput({}).ok).toBe(false);
  expect(parsePaneInput({ text: "x".repeat(20_001) }).ok).toBe(false);
});
