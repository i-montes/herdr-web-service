/** Step 8: the public URL answers /api/health from this machine, certificate validated. */
import { isIP, type LookupFunction } from "node:net";
import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** `note`: said along with the success (e.g. this machine cannot resolve its own public name yet) */
export type HealthResult = { ok: true; note?: string } | { ok: false; reason: string };

export interface VerifyDeps {
  /** this machine's resolver; [] when it does not know the name */
  resolveLocal?: (host: string) => Promise<string[]>;
  /** public DNS (1.1.1.1, 8.8.8.8): a fresh tunnel name may not have reached the local resolver */
  resolvePublic?: (host: string) => Promise<string[]>;
}

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|ISSUER|HOSTNAME|ALTNAME/i;

function describe(error: unknown, timeoutMs: number): string {
  const e = error as { name?: string; code?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `no response in ${Math.round(timeoutMs / 1000)} s`;
  const code = e?.code ?? "";
  if (TLS_CODES.test(code)) return `invalid TLS certificate (${code})`;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "connection refused: the server is not listening";
  if (code === "ENOTFOUND" || code === "FailedToResolve" || /DNS|resolve/i.test(code)) return `could not resolve the name (${code})`;
  return code ? `${code}: ${e.message ?? ""}`.trim() : e?.message || String(error);
}

async function resolveLocal(host: string): Promise<string[]> {
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

async function resolvePublic(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  try {
    return await resolver.resolve4(host);
  } catch {
    return [];
  }
}

/** GET `target` connecting to `ip`, with the URL's name for Host, SNI and the certificate check. */
function getVia(target: URL, ip: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const request = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        servername: target.hostname,
        timeout: timeoutMs,
        lookup: ((_host, opts, cb) =>
          opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)) as LookupFunction,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end();
  });
}

const isHealthy = (body: unknown) => (body as { ok?: unknown } | null)?.ok === true;
const NOT_OURS = "answered 200 but it is not this server (no ok: true)";

/**
 * `GET <url>/api/health` until it answers 200 with `{ ok: true }` or `timeoutMs` runs out
 * (a service that was just restarted needs a moment). The last failure is the reason. When this
 * machine cannot resolve the name, it goes to the address public DNS gives (same TLS checks).
 */
export async function verifyHealth(url: string, timeoutMs = 10_000, deps: VerifyDeps = {}): Promise<HealthResult> {
  const target = new URL(`${url.replace(/\/+$/, "")}/api/health`);
  const host = target.hostname;
  const named = !isIP(host.replace(/^\[|\]$/g, "")) && host !== "localhost";
  const deadline = Date.now() + timeoutMs;
  let reason = "no response";
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, reason };
    try {
      if (named && (await (deps.resolveLocal ?? resolveLocal)(host)).length === 0) {
        const [ip] = await (deps.resolvePublic ?? resolvePublic)(host);
        if (!ip) throw Object.assign(new Error(host), { code: "ENOTFOUND" });
        const { status, body } = await getVia(target, ip, Math.max(1, deadline - Date.now()));
        if (status === 200 && isHealthy(JSON.parse(body || "null"))) {
          return { ok: true, note: `This machine cannot resolve ${host} yet (its DNS does not know the name); it does respond from the internet.` };
        }
        reason = status === 200 ? NOT_OURS : `answered HTTP ${status}`;
      } else {
        const response = await fetch(target, { signal: AbortSignal.timeout(left), redirect: "manual" });
        if (response.status === 200) {
          if (isHealthy(await response.json().catch(() => null))) return { ok: true };
          reason = NOT_OURS;
        } else {
          reason = `answered HTTP ${response.status}`;
        }
      }
    } catch (error) {
      reason = describe(error, timeoutMs);
      // TLS problems do not fix themselves by waiting
      if (reason.startsWith("invalid TLS certificate")) return { ok: false, reason };
    }
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}
