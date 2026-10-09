/** Request parsing for the terminal view: which pane, and what to type into it. */

/** the keys the web keyboard bar offers; Herdr accepts these names */
export const KEYS = ["enter", "esc", "tab", "up", "down", "left", "right", "backspace", "ctrl+c", "ctrl+d"] as const;
export type Key = (typeof KEYS)[number];

const MAX_TEXT = 20_000;

/** `/api/panes/<id>/<action>` → the pane id, or null */
export function paneIdFrom(pathname: string, action: string): string | null {
  const match = /^\/api\/panes\/([^/]+)\/([a-z]+)$/.exec(pathname);
  if (!match || match[2] !== action) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return /^[A-Za-z0-9:_-]{1,64}$/.test(id) ? id : null;
}

export function parsePaneInput(body: unknown): { ok: true; value: { text: string; keys: Key[] } } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (b["text"] !== undefined && typeof b["text"] !== "string") return { ok: false, error: "text must be a string" };
  const text = (b["text"] as string | undefined) ?? "";
  if (text.length > MAX_TEXT) return { ok: false, error: "text too long" };
  const raw = b["keys"] ?? [];
  if (!Array.isArray(raw) || !raw.every((k) => KEYS.includes(k as Key))) return { ok: false, error: "unknown key" };
  const keys = [...(raw as Key[]), ...(b["enter"] === true ? (["enter"] as Key[]) : [])];
  if (!text && keys.length === 0) return { ok: false, error: "nothing to send" };
  return { ok: true, value: { text, keys } };
}
