import { beforeEach, expect, test } from "bun:test";
import { handleLogin, type LoginDeps } from "./login.ts";
import { FREE_FAILURES, GLOBAL_FAILURES, _reset, _setNow, loginWait, recordLoginFailure } from "./ratelimit.ts";

beforeEach(() => { _reset(); _setNow(1_000_000); });

const req = (password: string) =>
  new Request("http://x/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });

function deps(calls: { n: number }): LoginDeps {
  return {
    configured: () => true,
    verify: async (pw) => { calls.n++; await Bun.sleep(20); return pw === "right"; },
    startSession: () => "sid=1",
  };
}

test("a burst of parallel wrong guesses from one address is throttled", async () => {
  const calls = { n: 0 };
  const res = await Promise.all(Array.from({ length: 10 }, () => handleLogin(req("wrong"), "1.2.3.4", deps(calls))));
  // the 5 free failures plus the 6th attempt that earns the first wait: same as sequential guessing
  expect(calls.n).toBeLessThanOrEqual(FREE_FAILURES + 1);
  expect(res.filter((r) => r.status === 429).length).toBe(10 - calls.n);
  expect(res.filter((r) => r.status === 401).length).toBe(calls.n);
});

test("a burst from many strangers is held by the global window", async () => {
  const calls = { n: 0 };
  const res = await Promise.all(Array.from({ length: 80 }, (_, i) => handleLogin(req("wrong"), `10.0.0.${i}`, deps(calls))));
  expect(calls.n).toBe(GLOBAL_FAILURES);
  expect(res.filter((r) => r.status === 429).length).toBe(30);
});

test("a correct login leaves the global window count unchanged", async () => {
  const calls = { n: 0 };
  for (let i = 0; i < GLOBAL_FAILURES - 1; i++) recordLoginFailure(`10.0.0.${i}`);
  const ok = await handleLogin(req("right"), "9.9.9.9", deps(calls));
  expect(ok.status).toBe(204);
  expect(loginWait("8.8.8.8")).toBe(0); // 49 failures: a new stranger is not held
  expect(loginWait("9.9.9.9")).toBe(0);
});

test("remember defaults to true and false is passed to the session", async () => {
  const seen: boolean[] = [];
  const d: LoginDeps = { ...deps({ n: 0 }), startSession: (_r, _a, remember) => { seen.push(remember); return "sid=1"; } };
  const post = (body: unknown) => new Request("http://x/api/auth/login", { method: "POST", body: JSON.stringify(body) });
  expect((await handleLogin(post({ password: "right" }), "1.1.1.1", d)).status).toBe(204);
  expect((await handleLogin(post({ password: "right", remember: false }), "1.1.1.1", d)).status).toBe(204);
  expect((await handleLogin(post({ password: "right", remember: "no" }), "1.1.1.1", d)).status).toBe(204);
  expect(seen).toEqual([true, false, true]);
});
