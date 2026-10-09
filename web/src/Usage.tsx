import { useEffect, useRef, useState } from "react";
import type { AgentUsage, UsageWindow } from "../../shared/protocol.ts";
import { Ago } from "./Ago.tsx";

/** colour by how full: calm, getting there, nearly out */
function tone(percent: number): { bar: string; text: string } {
  if (percent >= 90) return { bar: "bg-danger-line", text: "text-danger-ink" };
  if (percent >= 70) return { bar: "bg-tool-ink", text: "text-tool-ink" };
  return { bar: "bg-ok-dot", text: "text-ink" };
}

/** "in 2 h 13 min", or the weekday and hour when it is days away */
export function resetsIn(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} h ${minutes % 60} min`;
  const date = new Date(at);
  const day = date.toLocaleDateString("en", { weekday: "long" });
  const time = date.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
  return `on ${day} at ${time}`;
}

const tokens = (n: number) => n.toLocaleString("en");

/** header pill with the context ring; opens the details */
export function UsageButton({ usage }: { usage: AgentUsage }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shown = usage.context?.percent ?? usage.fiveHour?.percent ?? 0;
  const label = usage.context ? `Context ${Math.round(usage.context.percent)}%` : `Usage ${Math.round(shown)}%`;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  // a ring: the stroke's dash covers the used share of the circle
  const r = 8;
  const circumference = 2 * Math.PI * r;
  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${label}. Show usage`}
        className="flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 text-[13px] font-semibold hover:bg-sunken"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" className="-rotate-90">
          <circle cx="10" cy="10" r={r} fill="none" stroke="var(--color-line)" strokeWidth="3" />
          <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(Math.min(shown, 100) / 100) * circumference} ${circumference}`} className={tone(shown).text} />
        </svg>
        <span className="font-mono">{Math.round(shown)}%</span>
      </button>
      {open && <UsagePanel usage={usage} />}
    </div>
  );
}

function UsagePanel({ usage }: { usage: AgentUsage }) {
  const now = Date.now();
  return (
    // phones: pinned under the header across the screen, wherever the pill sits; desktop: under the pill
    <div role="dialog" aria-label="Usage" className="fixed inset-x-3 top-[68px] z-30 flex flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-dialog lg:absolute lg:inset-x-auto lg:top-11 lg:right-0 lg:w-[320px]">
      {usage.context && (
        <Meter title="Context" percent={usage.context.percent} detail={`${tokens(usage.context.used)} of ${tokens(usage.context.size)} tokens`} />
      )}
      {usage.fiveHour && <LimitMeter title="Session (5 hours)" window={usage.fiveHour} now={now} />}
      {usage.week && <LimitMeter title="Week" window={usage.week} now={now} />}
      {usage.weekCostUsd !== undefined ? (
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">Spend (last 7 days)</span>
          <span className="font-mono text-sm font-semibold">${usage.weekCostUsd.toFixed(2)}</span>
        </div>
      ) : (
        !usage.fiveHour && !usage.week && <p className="text-[13px] text-muted">Your plan doesn't report usage limits.</p>
      )}
      <div className="flex flex-wrap gap-x-2 gap-y-1 border-t border-line pt-3 text-xs text-muted">
        {[usage.model, usage.effort && `effort ${usage.effort}`, usage.costUsd !== null && (usage.weekCostUsd !== undefined ? `$${usage.costUsd.toFixed(2)} this session` : `≈ $${usage.costUsd.toFixed(2)} at API prices`)].filter(Boolean).join(" · ")}
        {usage.updatedAt > 0 && (
          <span>
            · updated <Ago at={usage.updatedAt} />
          </span>
        )}
      </div>
    </div>
  );
}

function LimitMeter({ title, window: w, now }: { title: string; window: UsageWindow; now: number }) {
  return <Meter title={title} percent={w.percent} detail={w.resetsAt ? `Resets ${resetsIn(w.resetsAt, now)}` : null} />;
}

function Meter({ title, percent, detail }: { title: string; percent: number; detail: string | null }) {
  const t = tone(percent);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className={`font-mono text-sm font-semibold ${t.text}`}>{Math.round(percent)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label={title}>
        <div className={`h-full rounded-full ${t.bar}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      {detail && <span className="text-xs text-muted">{detail}</span>}
    </div>
  );
}
