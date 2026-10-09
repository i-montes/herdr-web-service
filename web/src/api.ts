import type { ApiError, ChatResponse, Roster, SessionInfo, SignIn } from "../../shared/protocol.ts";

/** A non-2xx answer: `code` is the server's error code, `retryAfter` the seconds a 429 asks to wait */
export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  if (response.status === 204) return undefined as T;
  const body = (await response.json().catch(() => null)) as T | ApiError | null;
  if (!response.ok) {
    const error = (body as ApiError | null)?.error;
    const retry = Number(response.headers.get("retry-after"));
    throw new ApiFailure(error?.message ?? response.statusText, response.status, error?.code ?? null, retry > 0 ? retry : null);
  }
  return body as T;
}

export type SessionKind = "shell" | "claude" | "codex" | "opencode";

export interface OpencodeOptions {
  models: { provider: string; model: string; name: string; providerName: string }[];
  variants: (string | null)[];
  current: { model: string | null; variant: string | null };
}
export type Permission = "ask" | "edits" | "plan" | "bypass";

export interface NewSessionBody {
  cwd: string;
  kind: SessionKind;
  name?: string;
  message?: string;
  command?: string;
  permission?: Permission;
}

export type PaneKey = "enter" | "esc" | "tab" | "up" | "down" | "left" | "right" | "backspace" | "ctrl+c" | "ctrl+d";

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const pane = (id: string, action: string) => `/api/panes/${encodeURIComponent(id)}/${action}`;

export const api = {
  session: () => call<SessionInfo>("/api/session"),
  login: (password: string, remember: boolean) =>
    call<void>("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password, remember }) }),
  logout: () => call<void>("/api/auth/logout", { method: "POST" }),
  roster: () => call<Roster>("/api/roster"),
  folders: (path: string) => call<{ path: string; dirs: { name: string; git: string | null }[] }>(`/api/fs?path=${encodeURIComponent(path)}`),
  createSession: (body: NewSessionBody) => call<{ pane_id: string }>("/api/sessions", post(body)),
  screen: (id: string) => call<{ text: string }>(pane(id, "screen")),
  input: (id: string, body: { text?: string; keys?: PaneKey[]; enter?: boolean }) => call<void>(pane(id, "input"), post(body)),
  closePane: (id: string) => call<void>(pane(id, "close"), { method: "POST" }),
  upload: (file: Blob) => call<{ name: string; path: string; type: string; size: number }>("/api/uploads", { method: "POST", headers: { "content-type": file.type || "application/octet-stream" }, body: file }),
  chat: (id: string, version: string | null) => call<ChatResponse>(pane(id, "chat") + (version ? `?v=${encodeURIComponent(version)}` : "")),
  prompt: (id: string, text: string) => call<void>(pane(id, "prompt"), post({ text })),
  choose: (id: string, index: number) => call<void>(pane(id, "choose"), post({ index })),
  opencodeOptions: (id: string) => call<OpencodeOptions>(pane(id, "models")),
  opencodeModel: (id: string, provider: string, model: string) => call<void>(pane(id, "model"), post({ provider, model })),
  opencodeVariant: (id: string, variant: string | null) => call<void>(pane(id, "variant"), post({ variant })),
  pushKey: () => call<{ key: string }>("/api/push/key"),
  pushSubscribe: (subscription: PushSubscriptionJSON) => call<void>("/api/push/subscribe", post(subscription)),
  pushUnsubscribe: (endpoint: string) => call<void>("/api/push/unsubscribe", post({ endpoint })),
  signIns: () => call<SignIn[]>("/api/auth/sessions"),
  signOutDevice: (id: string) => call<void>("/api/auth/sessions/revoke", post({ id })),
  signOutOthers: () => call<void>("/api/auth/sessions/revoke-others", { method: "POST" }),
};
