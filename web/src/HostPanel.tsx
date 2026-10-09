import { useEffect, useState } from "react";
import type { HostProcess, HostSample } from "../../shared/protocol.ts";
import { Icon } from "./Home.tsx";
import { LEVEL_LABEL, bytes, cpuLevel, diskLevel, hostHealth, loadLevel, memLevel, pct, rate, uptime, useHost, type Level } from "./host.ts";

const HOUR = 60 * 60 * 1000;
const OPEN_KEY = "herdr-web.host-open";
const DETAILS_KEY = "herdr-web.host-details";

const LEVEL_LOOK: Record<Level, { pill: string; dot: string; ink: string; tile: string }> = {
  ok: { pill: "bg-ok text-ok-ink", dot: "bg-ok-dot", ink: "text-accent-ink", tile: "border-line" },
  warn: { pill: "bg-tool text-tool-ink", dot: "bg-tool-ink", ink: "text-tool-ink", tile: "border-tool-ink" },
  critical: { pill: "bg-danger text-danger-ink", dot: "bg-danger-line", ink: "text-danger-line", tile: "border-danger-line" },
};

const BAR: Record<Level, string> = { ok: "bg-accent-ink", warn: "bg-tool-ink", critical: "bg-danger-line" };

function useStored(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : saved === "1";
    } catch {
      return initial;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* private mode: remembered until the page reloads */
    }
  };
  return [value, set];
}

/** ticks once a minute, for the uptime */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Home's live view of the machine the server runs on: CPU, memory, disk and network with the
 * last hour charted, a health verdict that says what is wrong, and (in the details) the processes
 * using the most. Folds to one line.
 */
export function HostPanel() {
  const host = useHost();
  const [open, setOpen] = useStored(OPEN_KEY, true);
  const [details, setDetails] = useStored(DETAILS_KEY, false);
  const now = useMinute();
  if (!host || host.samples.length === 0) return null;

  const { info, samples } = host;
  const last = samples.at(-1)!;
  const health = hostHealth(host);
  const look = LEVEL_LOOK[health.level];
  const memPct = pct(last.mem, info.mem_total);
  const root = info.disks[0];
  const rootPct = root ? pct(root.used, root.total) : null;
  const end = last.t;
  // the charts span what there is, from 5 minutes up to the hour kept
  const span = Math.min(HOUR, Math.max(5 * 60_000, end - samples[0]!.t));
  const series = (pick: (s: HostSample) => number | null) => samples.map((s) => ({ t: s.t, v: pick(s) }));

  return (
    <section aria-labelledby="host-title" className="flex flex-col gap-3 lg:gap-3.5">
      <div className="flex items-center gap-2.5 border-b-2 border-ink pb-1.5 lg:gap-3 lg:pb-2">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-baseline gap-2.5 text-left lg:min-h-0 lg:gap-3">
          <h2 id="host-title" className="text-[22px] font-bold tracking-[-0.02em] lg:text-2xl">Host</h2>
          <span className="truncate font-mono text-xs text-muted lg:text-[13px]">
            {info.hostname} · up {uptime(info.boot_at, now)}
          </span>
        </button>
        <span title={health.reasons.join("\n") || "Everything within normal limits"} className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${look.pill}`}>
          <span className={`size-1.5 rounded-full ${look.dot}`} />
          {LEVEL_LABEL[health.level]}
        </span>
        <button type="button" onClick={() => setOpen(!open)} aria-label={open ? "Hide host stats" : "Show host stats"} className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-ink lg:size-9">
          <Icon d="M6 9l6 6 6-6" size={16} width={2.4} className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {!open ? (
        <p className="flex flex-wrap gap-x-3 font-mono text-xs whitespace-nowrap text-muted lg:text-[13px]">
          <span>CPU {Math.round(last.cpu)}%</span>
          <span>Mem {Math.round(memPct)}%</span>
          {rootPct !== null && <span>Disk {Math.round(rootPct)}%</span>}
          <span>↓ {rate(last.rx)} ↑ {rate(last.tx)}</span>
        </p>
      ) : (
        <>
          {health.reasons.length > 0 && (
            <ul className={`flex flex-col gap-0.5 text-sm ${health.level === "critical" ? "text-danger-ink" : "text-tool-ink"}`}>
              {health.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
            <Tile label="CPU" value={`${Math.round(last.cpu)}%`} level={worst(cpuLevel(last.cpu), loadLevel(info.load[0] / info.cores))} sub={`${info.cores} cores · load ${info.load.map((l) => l.toFixed(2)).join(" ")}`}>
              <Chart lines={[series((s) => s.cpu)]} max={100} end={end} span={span} />
            </Tile>
            <Tile label="Memory" value={`${Math.round(memPct)}%`} level={memLevel(memPct)} sub={`${bytes(last.mem)} of ${bytes(info.mem_total)}`}>
              <Chart lines={[series((s) => pct(s.mem, info.mem_total))]} max={100} end={end} span={span} />
            </Tile>
            <Tile label={root ? `Disk ${root.mount}` : "Disk"} value={rootPct === null ? "—" : `${Math.round(rootPct)}%`} level={rootPct === null ? "ok" : diskLevel(rootPct)} sub={root ? `${bytes(root.total - root.used)} free of ${bytes(root.total)}` : "No disks found"}>
              <div className="flex h-10 flex-col justify-end gap-1.5">
                {info.disks.slice(0, 3).map((d) => {
                  const p = pct(d.used, d.total);
                  return (
                    <div key={d.mount} className="flex items-center gap-2" title={`${d.mount}: ${bytes(d.used)} of ${bytes(d.total)}`}>
                      {info.disks.length > 1 && <span className="w-14 truncate font-mono text-[10px] text-muted">{d.mount}</span>}
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                        <span className={`block h-full rounded-full ${BAR[diskLevel(p)]}`} style={{ width: `${Math.min(100, p)}%` }} />
                      </span>
                    </div>
                  );
                })}
              </div>
            </Tile>
            <Tile label="Network" value={`↓ ${rate(last.rx)}`} level="ok" sub={`↑ ${rate(last.tx)}`}>
              <Chart lines={[series((s) => s.rx), series((s) => s.tx)]} end={end} span={span} />
            </Tile>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-x-4">
            <button type="button" aria-expanded={details} onClick={() => setDetails(!details)} className="flex min-h-11 cursor-pointer items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink lg:min-h-9">
              <Icon d="M9 6l6 6-6 6" size={14} width={2.4} className={`transition-transform duration-150 ${details ? "rotate-90" : ""}`} />
              {details ? "Hide details" : "Processes and details"}
            </button>
            <span className="font-mono text-xs text-muted">charts: last {span >= HOUR ? "hour" : `${Math.round(span / 60_000)} min`} · every {info.interval_ms / 1000}s</span>
          </div>

          {details && (
            <div className="grid gap-3 lg:grid-cols-3 lg:gap-4">
              <div className="flex flex-col gap-2 rounded-[18px] border border-line bg-surface p-4">
                <h3 className="font-mono text-[11px] tracking-[0.08em] text-muted uppercase">Machine</h3>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                  <Fact term="System">{info.os}</Fact>
                  <Fact term="CPU">{info.cpu_model ? `${info.cpu_model} · ` : ""}{info.cores} cores · {info.arch}</Fact>
                  <Fact term="Up since">{new Date(info.boot_at).toLocaleString("en", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}</Fact>
                  <Fact term="Processes">{info.processes || "—"}</Fact>
                  {info.swap_total ? <Fact term="Swap">{bytes(last.swap ?? 0)} of {bytes(info.swap_total)}</Fact> : null}
                  {last.steal !== null && <Fact term="CPU steal">{last.steal}%</Fact>}
                  {last.iowait !== null && <Fact term="I/O wait">{last.iowait}%</Fact>}
                  {info.disks.slice(1).map((d) => (
                    <Fact key={d.mount} term={d.mount}>{bytes(d.used)} of {bytes(d.total)}</Fact>
                  ))}
                </dl>
              </div>
              <ProcessList title="Top CPU" list={info.top_cpu} value={(p) => (p.cpu === null ? "—" : `${p.cpu}%`)} />
              <ProcessList title="Top memory" list={info.top_mem} value={(p) => bytes(p.mem)} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

function worst(a: Level, b: Level): Level {
  return a === "critical" || b === "critical" ? "critical" : a === "warn" || b === "warn" ? "warn" : "ok";
}

function Tile({ label, value, sub, level, children }: { label: string; value: string; sub: string; level: Level; children: React.ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-[18px] border bg-surface p-3.5 lg:p-4 ${LEVEL_LOOK[level].tile}`}>
      <span className="truncate font-mono text-[11px] tracking-[0.08em] text-muted uppercase">{label}</span>
      <span className={`truncate text-2xl leading-tight font-bold tracking-[-0.02em] lg:text-[28px] ${level === "ok" ? "" : LEVEL_LOOK[level].ink}`}>{value}</span>
      <span className="truncate text-xs text-muted lg:text-[13px]">{sub}</span>
      <div className={`mt-1 ${LEVEL_LOOK[level].ink}`}>{children}</div>
    </div>
  );
}

/**
 * The readings over the last `span` ms (a gap where the server was not running stays empty). With
 * no `max` it scales to the highest value. A second line is drawn fainter.
 */
function Chart({ lines, max, end, span }: { lines: { t: number; v: number | null }[][]; max?: number; end: number; span: number }) {
  const top = max ?? Math.max(1, ...lines.flat().map((p) => p.v ?? 0));
  const x = (t: number) => ((t - (end - span)) / span) * 100;
  const y = (v: number) => 40 - (Math.min(v, top) / top) * 38;
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="block h-10 w-full" aria-hidden="true">
      {lines.map((line, i) => {
        const points = line.filter((p) => p.v !== null && x(p.t) >= 0).map((p) => `${x(p.t).toFixed(2)},${y(p.v!).toFixed(2)}`);
        if (points.length < 2) return null;
        const first = points[0]!.split(",")[0];
        const lastX = points.at(-1)!.split(",")[0];
        return (
          <g key={i} opacity={i === 0 ? 1 : 0.55}>
            {i === 0 && <path d={`M${first},40 L${points.join(" L")} L${lastX},40 Z`} fill="currentColor" opacity={0.12} />}
            <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{term}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  );
}

function ProcessList({ title, list, value }: { title: string; list: HostProcess[]; value: (p: HostProcess) => string }) {
  return (
    <div className="flex flex-col gap-2 rounded-[18px] border border-line bg-surface p-4">
      <h3 className="font-mono text-[11px] tracking-[0.08em] text-muted uppercase">{title}</h3>
      {list.length === 0 ? (
        <p className="text-[13px] text-muted">Measuring…</p>
      ) : (
        <ol className="flex flex-col gap-1.5 text-[13px]">
          {list.map((p) => (
            <li key={p.name} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate">
                {p.name}
                {p.count > 1 && <span className="ml-1.5 font-mono text-xs text-muted">×{p.count}</span>}
              </span>
              <span className="shrink-0 font-mono text-xs">{value(p)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
