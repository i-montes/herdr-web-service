import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import * as tui from "../../tui.ts";
import { APP_CLI, enableLinkFrom, ensureFunnel, ensureLoggedIn, ensureOperator, funnelServes, funnelUrl, parseStatus, tailscaleBin, teardownFunnel } from "./tailscale.ts";
import { teardownTunnel } from "./index.ts";
import type { Runner } from "./run.ts";

const STATUS = '{"BackendState":"Running","Self":{"DNSName":"box.tail1234.ts.net."}}';

test("parseStatus strips the trailing dot", () => {
  expect(parseStatus(STATUS)).toEqual({ state: "Running", dnsName: "box.tail1234.ts.net" });
  expect(parseStatus('{"BackendState":"NeedsLogin"}')).toEqual({ state: "NeedsLogin", dnsName: null });
});

test("funnelUrl", () => {
  expect(funnelUrl("box.tail1234.ts.net")).toBe("https://box.tail1234.ts.net");
});

test("enableLinkFrom finds the login link", () => {
  const out = "Funnel is not enabled on your tailnet.\nTo enable, visit:\n  https://login.tailscale.com/f/funnel?node=abc\n";
  expect(enableLinkFrom(out)).toBe("https://login.tailscale.com/f/funnel?node=abc");
  expect(enableLinkFrom("all good")).toBeNull();
});

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  mock.restore();
});

test("ensureFunnel: enable link, confirm, retry succeeds", async () => {
  const confirmSpy = spyOn(tui, "confirm").mockReturnValue(true);
  const calls: string[][] = [];
  let funnelRuns = 0;
  const run: Runner = async (argv) => {
    calls.push(argv);
    if (argv[1] === "funnel") {
      funnelRuns++;
      return funnelRuns === 1
        ? { code: 1, stdout: "Funnel is not enabled. Visit https://login.tailscale.com/f/funnel?node=abc\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: STATUS, stderr: "" };
  };
  const url = await ensureFunnel(7340, "tailscale", run);
  expect(url).toBe("https://box.tail1234.ts.net");
  expect(funnelRuns).toBe(2);
  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(calls[0]).toEqual(["tailscale", "funnel", "--bg", "7340"]);
  expect(logSpy.mock.calls.flat().join("\n")).toContain("https://login.tailscale.com/f/funnel?node=abc");
});

test("ensureFunnel throws on a failure without a link", async () => {
  const run: Runner = async () => ({ code: 1, stdout: "", stderr: "boom" });
  await expect(ensureFunnel(7340, "tailscale", run)).rejects.toThrow("boom");
});

test("teardownTunnel(tailscale) turns the funnel off", async () => {
  const calls: string[][] = [];
  await teardownTunnel("tailscale", 7340, async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  });
  expect(calls).toEqual([["tailscale", "version"], ["tailscale", "funnel", "--bg", "7340", "off"]]);
});

import { ensureInstalled } from "./tailscale.ts";

test.skipIf(process.platform === "darwin")("ensureInstalled errors when installer fails or tailscale stays missing", async () => {
  spyOn(tui, "confirm").mockReturnValue(true);
  const failing: Runner = async (argv) => ({ code: argv[0] === "bash" ? 1 : 127, stdout: "", stderr: "" });
  await expect(ensureInstalled(failing)).rejects.toThrow("Falló la instalación");
  const missing: Runner = async (argv) => ({ code: argv[0] === "bash" ? 0 : 127, stdout: "", stderr: "" });
  await expect(ensureInstalled(missing)).rejects.toThrow("no responde");
});

const SERVE = (proxy: string) =>
  JSON.stringify({ TCP: { "443": { HTTPS: true } }, Web: { "box.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } }, AllowFunnel: { "box.ts.net:443": true } });

test("funnelServes finds our port in funnel status", async () => {
  const run = (out: string, code = 0): Runner => async () => ({ code, stdout: out, stderr: "" });
  expect(await funnelServes(7340, run(SERVE("http://127.0.0.1:7340")))).toBe(true);
  expect(await funnelServes(7340, run(SERVE("http://localhost:7340/")))).toBe(true);
  expect(await funnelServes(7340, run(SERVE("http://127.0.0.1:73400")))).toBe(false);
  expect(await funnelServes(7340, run(SERVE("http://127.0.0.1:8080")))).toBe(false);
  expect(await funnelServes(7340, run("{}"))).toBe(false);
  expect(await funnelServes(7340, run("", 127))).toBe(false);
  expect(await funnelServes(7340, run("not json"))).toBe(false);
});

test("teardownFunnel reports whether funnel off worked", async () => {
  expect(await teardownFunnel(7340, async () => ({ code: 0, stdout: "", stderr: "" }))).toBe(true);
  expect(await teardownFunnel(7340, async () => ({ code: 1, stdout: "", stderr: "denied" }))).toBe(false);
});

/** A machine with only the macOS app: `tailscale` is not on PATH, the app's CLI answers. */
function appOnly(calls: string[][], extra: (argv: string[]) => { code: number; stdout: string; stderr: string } = () => ({ code: 0, stdout: "", stderr: "" })): Runner {
  return async (argv) => {
    calls.push(argv);
    if (argv[0] === "tailscale") return { code: 127, stdout: "", stderr: "ENOENT" };
    if (argv[0] === "sudo") return { code: 1, stdout: "", stderr: "no sudo expected" };
    return extra(argv);
  };
}

test("tailscaleBin falls back to the macOS app's CLI when tailscale is not on PATH", async () => {
  expect(APP_CLI).toBe("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  expect(await tailscaleBin(appOnly([]))).toBe(APP_CLI);
  expect(await tailscaleBin(async () => ({ code: 0, stdout: "1.80.0", stderr: "" }))).toBe("tailscale");
  expect(await tailscaleBin(async () => ({ code: 127, stdout: "", stderr: "" }))).toBeNull();
});

test("ensureInstalled returns the app CLI and later calls use it", async () => {
  const calls: string[][] = [];
  const run = appOnly(calls, (argv) => (argv[1] === "status" ? { code: 0, stdout: STATUS, stderr: "" } : { code: 0, stdout: "", stderr: "" }));
  const bin = await ensureInstalled(run);
  expect(bin).toBe(APP_CLI);
  calls.length = 0;
  await ensureLoggedIn(bin, run);
  await ensureOperator(bin, run, "darwin");
  expect(await ensureFunnel(7340, bin, run)).toBe("https://box.tail1234.ts.net");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((argv) => argv[0] === APP_CLI)).toBe(true);
});

test("teardownFunnel and funnelServes resolve the app CLI too", async () => {
  const calls: string[][] = [];
  const run = appOnly(calls, (argv) =>
    argv[2] === "status" ? { code: 0, stdout: SERVE("http://127.0.0.1:7340"), stderr: "" } : { code: 0, stdout: "", stderr: "" },
  );
  expect(await funnelServes(7340, run)).toBe(true);
  expect(await teardownFunnel(7340, run)).toBe(true);
  expect(calls).toContainEqual([APP_CLI, "funnel", "status", "--json"]);
  expect(calls).toContainEqual([APP_CLI, "funnel", "--bg", "7340", "off"]);
  expect(await teardownFunnel(7340, async () => ({ code: 127, stdout: "", stderr: "" }))).toBe(false);
});

test("ensureOperator never runs sudo on macOS, even when the probe fails", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return { code: 1, stdout: "", stderr: "access denied" };
  };
  await ensureOperator("tailscale", run, "darwin");
  expect(calls.some((argv) => argv[0] === "sudo")).toBe(false);
});

test("ensureOperator on Linux sets the operator with sudo when the probe fails", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => {
    calls.push(argv);
    return argv[0] === "sudo" ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "access denied" };
  };
  await ensureOperator("/usr/bin/tailscale", run, "linux");
  expect(calls.find((argv) => argv[0] === "sudo")?.slice(0, 3)).toEqual(["sudo", "/usr/bin/tailscale", "set"]);
});

test("ensureLoggedIn logs in without `up`, which refuses when the host has non-default settings", async () => {
  const calls: string[][] = [];
  let loggedIn = false;
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv.includes("login")) loggedIn = true;
    if (argv.includes("status")) {
      return { code: 0, stdout: loggedIn ? STATUS : STATUS.replace('"Running"', '"NeedsLogin"'), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  await ensureLoggedIn("tailscale", run);
  expect(calls.some((argv) => argv.at(-1) === "login")).toBe(true);
  expect(calls.some((argv) => argv.includes("up"))).toBe(false);
});

test("ensureFunnel shows tailscale's output: it may wait on an enable link instead of exiting", async () => {
  const opts: ({ inherit?: boolean; tee?: boolean } | undefined)[] = [];
  const run = async (argv: string[], o?: { inherit?: boolean; tee?: boolean }) => {
    if (argv.includes("funnel")) opts.push(o);
    return { code: 0, stdout: argv.includes("status") ? STATUS : "", stderr: "" };
  };
  await ensureFunnel(7340, "tailscale", run);
  expect(opts).toEqual([{ tee: true }]);
});
