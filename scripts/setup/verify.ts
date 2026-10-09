/** Step 8: the public URL answers /api/health from this machine, certificate validated. */
export type HealthResult = { ok: true } | { ok: false; reason: string };

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|ISSUER|HOSTNAME|ALTNAME/i;

function describe(error: unknown, timeoutMs: number): string {
  const e = error as { name?: string; code?: string; message?: string };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `sin respuesta en ${Math.round(timeoutMs / 1000)} s`;
  const code = e?.code ?? "";
  if (TLS_CODES.test(code)) return `certificado TLS no válido (${code})`;
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") return "conexión rechazada: el servidor no está escuchando";
  if (code === "ENOTFOUND" || code === "FailedToResolve" || /DNS|resolve/i.test(code)) return `no se pudo resolver el nombre (${code})`;
  return code ? `${code}: ${e.message ?? ""}`.trim() : e?.message || String(error);
}

/**
 * `GET <url>/api/health` until it answers 200 with `{ ok: true }` or `timeoutMs` runs out
 * (a service that was just restarted needs a moment). The last failure is the reason.
 */
export async function verifyHealth(url: string, timeoutMs = 10_000): Promise<HealthResult> {
  const target = `${url.replace(/\/+$/, "")}/api/health`;
  const deadline = Date.now() + timeoutMs;
  let reason = "sin respuesta";
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { ok: false, reason };
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(left), redirect: "manual" });
      if (response.status === 200) {
        const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
        if (body?.ok === true) return { ok: true };
        reason = "respondió 200 pero no es este servidor (falta ok: true)";
      } else {
        reason = `respondió HTTP ${response.status}`;
      }
    } catch (error) {
      reason = describe(error, timeoutMs);
      // TLS problems do not fix themselves by waiting
      if (reason.startsWith("certificado")) return { ok: false, reason };
    }
    await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
}
