import { useEffect, useRef, useState } from "react";
import type { Notice } from "../../shared/protocol.ts";
import { attending, onNotice, pushEndpoint, soundMuted } from "./alerts.ts";
import { Icon } from "./Home.tsx";
import { sessionHref } from "./roster.ts";
import { playNoticeSound } from "./sound.ts";

const MAX_TOASTS = 3;
/** a session waiting on you stays up longer than one that finished */
const LIFETIME_MS = { blocked: 12_000, finished: 6_000 };

/**
 * Notices while the app is open: a toast (top right; on a phone, across the top) and, unless
 * muted, a sound. Nothing for the session you are looking at (tab in view, window focused). Not
 * looking on a device with push: no sound here, the system notification brings its own.
 */
export function Toasts({ viewing }: { viewing: string | null }) {
  const [toasts, setToasts] = useState<Notice[]>([]);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  useEffect(
    () =>
      onNotice((notice) => {
        const looking = attending();
        if (looking && viewingRef.current === notice.pane_id) return;
        // not looking with push on: the system notification brings its own sound
        if (!soundMuted() && (looking || !pushEndpoint())) playNoticeSound(notice.kind);
        // a newer notice for the same session replaces the older one
        setToasts((list) => [...list.filter((t) => t.pane_id !== notice.pane_id), notice].slice(-MAX_TOASTS));
      }),
    [],
  );

  const dismiss = (id: string) => setToasts((list) => list.filter((t) => t.id !== id));
  // the session you open is the one you were told about
  useEffect(() => {
    if (viewing) setToasts((list) => list.filter((t) => t.pane_id !== viewing));
  }, [viewing]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-3 top-3 z-50 flex flex-col items-stretch gap-2 sm:inset-x-auto sm:right-4 sm:top-4 sm:w-[360px]">
      {toasts.map((t) => (
        <Toast key={t.id} notice={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function Toast({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  // the parent hands a new callback on every render: the timer must not restart with it
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismissRef.current(), LIFETIME_MS[notice.kind]);
    return () => clearTimeout(timer);
  }, [paused, notice.kind]);
  const blocked = notice.kind === "blocked";
  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`pointer-events-auto flex items-start gap-3 rounded-2xl border bg-surface p-3.5 shadow-dialog ${blocked ? "border-accent-ink" : "border-line"}`}
    >
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${blocked ? "bg-accent-ink" : "bg-ok-dot"}`} aria-hidden="true" />
      <a href={sessionHref(notice.pane_id)} onClick={onDismiss} className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold">{notice.title}</span>
        <span className="line-clamp-2 text-[13px] text-muted">{notice.body}</span>
        <span className={`mt-1 text-[13px] font-semibold ${blocked ? "text-accent-ink" : "text-ink"}`}>{blocked ? "Answer" : "Open"} →</span>
      </a>
      <button type="button" onClick={onDismiss} aria-label="Dismiss" className="-m-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-ink">
        <Icon d="M6 6l12 12M18 6L6 18" size={14} width={2.4} />
      </button>
    </div>
  );
}
