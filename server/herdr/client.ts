/**
 * Newline-delimited JSON over Herdr's Unix socket.
 *
 * Herdr closes a request connection after its answer, so every request opens its own; `subscribe`
 * keeps a dedicated connection open because Herdr pushes events on it. See docs/socket-api.mdx in the Herdr
 * repo, or `herdr api schema --json`, for method names and payloads.
 */
export class HerdrError extends Error {
  constructor(readonly code: string, message: string, readonly data?: unknown) {
    super(message);
  }
}

type Line = { id?: string; result?: unknown; error?: { code: string; message: string; data?: unknown }; event?: unknown } & Record<string, unknown>;

function frames(buffer: { rest: string }, chunk: Uint8Array): Line[] {
  buffer.rest += new TextDecoder().decode(chunk);
  const out: Line[] = [];
  let nl: number;
  while ((nl = buffer.rest.indexOf("\n")) !== -1) {
    const line = buffer.rest.slice(0, nl).trim();
    buffer.rest = buffer.rest.slice(nl + 1);
    if (line) out.push(JSON.parse(line) as Line);
  }
  return out;
}

export class HerdrClient {
  private seq = 0;

  constructor(readonly path: string) {}

  /** Herdr answers one request per connection and then closes it, so each request dials anew. */
  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = `req_${++this.seq}`;
    const buffer = { rest: "" };
    let settled = false;
    return new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      Bun.connect({
        unix: this.path,
        socket: {
          open: (socket) => {
            socket.write(JSON.stringify({ id, method, params }) + "\n");
          },
          data: (socket, chunk) => {
            for (const line of frames(buffer, chunk)) {
              if (line.id !== id) continue;
              settle(() => (line.error ? reject(new HerdrError(line.error.code, line.error.message, line.error.data)) : resolve(line.result as T)));
              socket.end();
            }
          },
          close: () => settle(() => reject(new HerdrError("disconnected", "herdr socket closed"))),
          error: (_socket, error) => settle(() => reject(new HerdrError("socket_error", error.message))),
          connectError: (_socket, error) => settle(() => reject(error)),
        },
      }).catch((error: Error) => settle(() => reject(error)));
    });
  }

  /**
   * A dedicated connection that stays open. `onEvent` gets every pushed line after the
   * acknowledgement; `onClose` fires when Herdr drops it (including `events_lost`), after which
   * the caller should resubscribe and re-read state. `onClose` fires once per subscription.
   */
  static subscribe(path: string, subscriptions: Record<string, unknown>[], onEvent: (event: Line) => void, onClose: (reason: string) => void): Promise<() => void> {
    const buffer = { rest: "" };
    let acked = false;
    let closed = false;
    // an error line is followed by the socket closing: report only the first
    const close = (reason: string) => {
      if (closed) return;
      closed = true;
      onClose(reason);
    };
    return new Promise((resolve, reject) => {
      Bun.connect({
        unix: path,
        socket: {
          open: (socket) => {
            socket.write(JSON.stringify({ id: "sub_1", method: "events.subscribe", params: { subscriptions } }) + "\n");
            resolve(() => socket.end());
          },
          data: (socket, chunk) => {
            for (const line of frames(buffer, chunk)) {
              if (!acked) {
                acked = true;
                if (line.error) {
                  close(line.error.code);
                  socket.end();
                  return;
                }
                continue;
              }
              if (line.error) {
                close(line.error.code);
                socket.end();
                return;
              }
              onEvent(line);
            }
          },
          close: () => close("closed"),
          error: (_socket, error) => close(error.message),
          connectError: (_socket, error) => reject(error),
        },
      }).catch(reject);
    });
  }
}
