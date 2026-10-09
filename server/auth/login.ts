/**
 * POST /api/auth/login. A failure is reserved synchronously, in the same step as the final wait
 * check and before the async password verification, so a burst of parallel guesses cannot all
 * slip through before the first failure is counted. A correct password releases the reservation.
 */
import { apiError } from "../http.ts";
import { loginWait, recordLoginFailure, recordLoginSuccess, releaseFailure } from "./ratelimit.ts";

export interface LoginDeps {
  configured: () => boolean;
  verify: (password: string) => Promise<boolean>;
  /** creates the session and returns the Set-Cookie value; `remember: false` asks for a browser-session cookie */
  startSession: (request: Request, address: string | null, remember: boolean) => string;
}

export async function handleLogin(request: Request, address: string | null, deps: LoginDeps): Promise<Response> {
  if (!deps.configured()) return apiError("setup_required", "no password set: run the setup action in Herdr", 503);
  const wait = loginWait(address);
  if (wait > 0) return apiError("too_many_attempts", `wait ${wait}s`, 429, { "retry-after": String(wait) });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "body must be JSON", 400);
  }
  const password = typeof body === "object" && body !== null && "password" in body ? (body as { password: unknown }).password : undefined;
  if (typeof password !== "string") return apiError("missing_password", "password is required", 400);
  const remember = (body as { remember?: unknown }).remember !== false;
  // The body parse above awaited: check again, then reserve the failure with no await in between.
  const left = loginWait(address);
  if (left > 0) return apiError("too_many_attempts", `wait ${left}s`, 429, { "retry-after": String(left) });
  const reserved = recordLoginFailure(address);
  if (!(await deps.verify(password))) return apiError("invalid_password", "wrong password", 401);
  releaseFailure(reserved);
  recordLoginSuccess(address);
  return new Response(null, { status: 204, headers: { "set-cookie": deps.startSession(request, address, remember) } });
}
