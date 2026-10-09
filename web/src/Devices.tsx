import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { SignIn } from "../../shared/protocol.ts";
import { Ago } from "./Ago.tsx";
import { api } from "./api.ts";
import { Icon } from "./Home.tsx";

const PHONE_ICON = "M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2";
const COMPUTER_ICON = "M4 5h16v11H4zM2 19h20";
const DEVICES_ICON = "M3 5h13v9H3zM1 17h17M18 9h4v10h-4z";
const isPhone = (device: string) => /iPhone|iPad|Android/.test(device);

/** Home's sidebar row that opens the devices list */
export function DevicesButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 cursor-pointer items-center gap-2 text-left text-sm text-muted hover:text-ink lg:min-h-10">
        <Icon d={DEVICES_ICON} size={16} />
        Signed-in devices
      </button>
      {/* portal: the sidebar is sticky, and its stacking context would trap the dialog */}
      {open && createPortal(<DevicesDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

/**
 * Every browser signed in with the password, newest activity first, and signing out the ones you
 * do not recognize. A signed-out browser is sent back to the password at once and stops getting
 * notifications.
 */
export function DevicesDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<SignIn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = () =>
    api.signIns().then(setList).catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      setConfirmAll(false);
    }
  };
  const others = list?.filter((s) => !s.current) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pt-[clamp(16px,10vh,96px)] pb-10">
      <div aria-hidden="true" className="fixed inset-0 bg-dialog-scrim" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="devices-title" className="relative flex w-full max-w-[520px] flex-col gap-4 rounded-3xl border border-line bg-surface p-6 shadow-dialog">
        <div className="flex items-center gap-3">
          <h2 id="devices-title" className="text-[26px] font-extrabold tracking-[-0.03em]">Signed-in devices</h2>
          <button type="button" onClick={onClose} aria-label="Close" autoFocus className="ml-auto flex size-11 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-ink">
            <Icon d="M6 6l12 12M18 6L6 18" size={18} width={2.2} />
          </button>
        </div>
        <p className="-mt-2 text-[15px] text-muted">Every browser that signed in with your password. Sign out the ones you don't recognize.</p>

        {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
        {!list && !error && <p className="py-6 text-center text-muted">Loading…</p>}

        {list && (
          <ul className="flex flex-col divide-y divide-line rounded-2xl border border-line">
            {list.map((s) => (
              <li key={s.id} className="flex items-start gap-3 px-4 py-3.5">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-sunken text-muted">
                  <Icon d={isPhone(s.device) ? PHONE_ICON : COMPUTER_ICON} size={18} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[15px] font-semibold">{s.device}</span>
                    {s.current && <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[11px] text-accent-soft-ink">This device</span>}
                    {s.notifications && <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] text-muted">Notifications</span>}
                  </span>
                  <span className="text-[13px] [overflow-wrap:anywhere] text-muted" title={s.user_agent}>
                    {s.address && `${s.address} · `}
                    {s.current ? "Active now" : <>Active <Ago at={s.last_seen_at} /></>}
                  </span>
                  <span className="text-xs text-muted">Signed in {new Date(s.created_at).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}</span>
                </span>
                {!s.current && (
                  <button type="button" disabled={busy !== null} onClick={() => void run(s.id, () => api.signOutDevice(s.id))} className="shrink-0 cursor-pointer rounded-full border border-line px-3.5 py-2 text-[13px] font-semibold text-danger-ink hover:bg-sunken disabled:cursor-default disabled:opacity-50">
                    {busy === s.id ? "Signing out…" : "Sign out"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {others.length > 1 &&
          (confirmAll ? (
            <div className="flex flex-col gap-2 rounded-2xl border border-danger-line p-3.5">
              <span className="text-sm">Sign out {others.length} other devices? They'll need the password to come back.</span>
              <div className="flex gap-2">
                <button type="button" disabled={busy !== null} onClick={() => void run("all", () => api.signOutOthers())} className="min-h-10 flex-1 cursor-pointer rounded-full bg-danger text-sm font-semibold text-danger-ink disabled:opacity-50">
                  {busy === "all" ? "Signing out…" : "Yes, sign them out"}
                </button>
                <button type="button" onClick={() => setConfirmAll(false)} className="min-h-10 flex-1 cursor-pointer rounded-full border border-line text-sm font-semibold">
                  No
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmAll(true)} className="min-h-11 cursor-pointer self-start rounded-full border border-line px-4 text-sm font-semibold text-danger-ink hover:bg-sunken">
              Sign out all other devices
            </button>
          ))}
      </div>
    </div>
  );
}
