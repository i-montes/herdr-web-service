import { afterAll, describe, expect, test } from "bun:test";
import { verifyHealth } from "./verify.ts";

const ok = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
const broken = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("boom", { status: 500 }) });
const notOk = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: false }) });
afterAll(() => {
  ok.stop(true);
  broken.stop(true);
  notOk.stop(true);
});

async function closedPort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

describe("verifyHealth", () => {
  test("ok when /api/health answers {ok:true}", async () => {
    expect(await verifyHealth(`http://127.0.0.1:${ok.port}`)).toEqual({ ok: true });
  });
  test("a 500 is reported with its status", async () => {
    const r = await verifyHealth(`http://127.0.0.1:${broken.port}`, 400);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("500");
  });
  test("a 200 without ok:true is not healthy", async () => {
    const r = await verifyHealth(`http://127.0.0.1:${notOk.port}`, 400);
    expect(r.ok).toBe(false);
  });
  test("a closed port gives a reason", async () => {
    const r = await verifyHealth(`http://127.0.0.1:${await closedPort()}`, 400);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
  test("waits for a server that comes up within the timeout", async () => {
    const port = await closedPort();
    let late: ReturnType<typeof Bun.serve> | undefined;
    setTimeout(() => {
      late = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
    }, 300);
    try {
      expect(await verifyHealth(`http://127.0.0.1:${port}`, 3000)).toEqual({ ok: true });
    } finally {
      late?.stop(true);
    }
  });
  test("a trailing slash in the URL is tolerated", async () => {
    expect(await verifyHealth(`http://127.0.0.1:${ok.port}/`)).toEqual({ ok: true });
  });
  test("this machine cannot resolve the name: checked through public DNS, with a note", async () => {
    const asked: string[] = [];
    const resolvePublic = async (host: string) => (asked.push(host), ["127.0.0.1"]);
    const r = await verifyHealth(`http://herdr-test.invalid:${ok.port}`, 2000, { resolvePublic });
    expect(asked).toEqual(["herdr-test.invalid"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.note).toContain("herdr-test.invalid");
  });
  test("public DNS does not know it either: still the DNS failure", async () => {
    const r = await verifyHealth(`http://herdr-test.invalid:${ok.port}`, 600, { resolvePublic: async () => [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("resolver");
  });
});
