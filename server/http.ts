import { statSync } from "node:fs";
import type { ApiError } from "../shared/protocol.ts";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}

export function apiError(code: string, message: string, status: number, headers: Record<string, string> = {}): Response {
  const body: ApiError = { error: { code, message } };
  return json(body, status, headers);
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    try {
      out.set(pair.slice(0, eq).trim(), decodeURIComponent(pair.slice(eq + 1).trim()));
    } catch {
      /* a junk cookie from another app must not break the user */
    }
  }
  return out;
}

/** Set `headers` on `response` (overriding same-named ones) and return it. */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/** True only for an existing regular file (not a directory, not missing). */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
