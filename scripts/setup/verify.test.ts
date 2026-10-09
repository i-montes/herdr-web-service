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
});
