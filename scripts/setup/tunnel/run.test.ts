import { afterEach, expect, spyOn, test } from "bun:test";
import { defaultRun } from "./run.ts";

const spies: { mockRestore(): void }[] = [];
afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

test("tee shows the output while the command runs and still returns it", async () => {
  const shown: string[] = [];
  const capture = (chunk: unknown) => (shown.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array)), true);
  spies.push(spyOn(process.stdout, "write").mockImplementation(capture), spyOn(process.stderr, "write").mockImplementation(capture));
  const r = await defaultRun(["sh", "-c", "echo visit-this-link; echo oops >&2; exit 3"], { tee: true });
  spies.splice(0).forEach((s) => s.mockRestore());
  expect(r).toEqual({ code: 3, stdout: "visit-this-link\n", stderr: "oops\n" });
  expect(shown.join("")).toContain("visit-this-link");
  expect(shown.join("")).toContain("oops");
});
