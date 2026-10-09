import { useEffect, useRef, useState } from "react";
import { ApiFailure, api } from "./api.ts";

type Status = "idle" | "checking" | "ok";

/** The server's answer to a failed sign-in, in the words the page shows */
function describe(error: unknown): string {
  if (!(error instanceof ApiFailure)) return "Couldn't reach the server.";
  switch (error.code) {
    case "invalid_password": return "Wrong password.";
    case "insecure_transport": return "Use HTTPS to sign in.";
    case "setup_required": return "The password hasn't been set in Herdr yet.";
    default: return error.message;
  }
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);

  const waitLeft = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  const locked = waitLeft > 0;
  const checking = status === "checking";

  useEffect(() => {
    if (!lockedUntil) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) {
        setLockedUntil(null);
        input.current?.focus();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (locked || checking) return;
    if (!password) {
      setError("Enter the password.");
      input.current?.focus();
      return;
    }
    setStatus("checking");
    setError(null);
    try {
      await api.login(password, remember);
      setStatus("ok");
      onDone();
    } catch (e) {
      setStatus("idle");
      if (e instanceof ApiFailure && e.status === 429) {
        setNow(Date.now());
        setLockedUntil(Date.now() + (e.retryAfter ?? 1) * 1000);
      } else {
        setError(describe(e));
        input.current?.select();
      }
    }
  };

  const invalid = error !== null || locked;
  const button = checking ? "Checking…" : locked ? "Locked" : "Sign in";

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-6">
      <form
        onSubmit={submit}
        noValidate
        className="flex w-full max-w-[400px] flex-col gap-6 rounded-[22px] border border-line bg-surface p-[clamp(28px,5vw,40px)]"
      >
        <div className="flex justify-center pb-1">
          <h1 className="text-[44px] leading-none font-extrabold tracking-[-0.045em]">
            Herdr<span className="text-accent-ink">.</span>
          </h1>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="herdr-pw" className="text-sm font-semibold">Password</label>
          <div className="relative flex items-center">
            <input
              ref={input}
              id="herdr-pw"
              name="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              disabled={locked}
              aria-invalid={invalid}
              aria-describedby="herdr-pw-msg"
              className={`h-13 w-full rounded-[14px] border-2 bg-field pr-14 pl-4 font-mono text-base text-ink outline-none transition-[border-color,box-shadow] duration-150 disabled:opacity-60 ${
                invalid ? "border-danger-line" : "border-line focus:border-accent-ink focus:shadow-[0_0_0_4px_var(--color-focus)]"
              }`}
            />
            <button
              type="button"
              aria-label={show ? "Hide password" : "Show password"}
              aria-pressed={show}
              onClick={() => setShow(!show)}
              className="absolute right-1 flex size-11 cursor-pointer items-center justify-center rounded-[10px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent-ink"
            >
              {show ? <EyeOff /> : <Eye />}
            </button>
          </div>
          <div id="herdr-pw-msg" aria-live="polite" className="min-h-5">
            {locked ? (
              <Message icon={<ClockIcon />}>Too many attempts. Wait {clock(waitLeft)}.</Message>
            ) : error ? (
              <Message icon={<AlertIcon />}>{error}</Message>
            ) : null}
          </div>
        </div>

        <label htmlFor="herdr-remember" className="-mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
          <input
            id="herdr-remember"
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="m-0 size-5 cursor-pointer accent-accent"
          />
          <span>Remember this browser</span>
        </label>

        {status === "ok" ? (
          <div role="status" className="flex h-13 items-center justify-center gap-2.5 rounded-full bg-ok text-base font-semibold text-ok-ink">
            <CheckIcon />
            Signing in…
          </div>
        ) : (
          <button
            type="submit"
            disabled={locked || checking}
            className={`h-13 rounded-full text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink ${
              locked ? "cursor-not-allowed bg-sunken text-muted" : checking ? "cursor-not-allowed bg-accent text-white" : "cursor-pointer bg-accent text-white"
            }`}
          >
            {button}
          </button>
        )}
      </form>
    </main>
  );
}

function Message({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <p className="m-0 flex items-center gap-2 text-sm text-danger-ink">{icon}{children}</p>;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Eye() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 19 12 19a9.7 9.7 0 0 0 5.4-1.6" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0" {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" className="shrink-0" {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" {...stroke} strokeWidth={2.4}>
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}
