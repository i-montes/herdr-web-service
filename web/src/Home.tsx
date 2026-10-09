import { useEffect, useMemo, useState } from "react";
import type { Roster, RosterPane, SessionInfo } from "../../shared/protocol.ts";
import { Ago } from "./Ago.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { InstallBanner } from "./InstallBanner.tsx";
import { NewSessionDialog } from "./NewSession.tsx";
import { OpenOnPhone } from "./OpenOnPhone.tsx";
import { sessionHref } from "./roster.ts";
import { FILTERS, STATUS_LABEL, BUCKET_OF, agentLook, homeView, plural, sessionName, type Filter, type WorkspaceGroup } from "./home.ts";
import { useTheme } from "./theme.ts";

/** chip and dot classes per status (design: waiting / working / idle) */
const STATUS_LOOK = {
  waiting: { dot: "bg-accent-ink", chip: "bg-accent-soft text-accent-soft-ink" },
  working: { dot: "bg-ok-dot", chip: "bg-ok text-ok-ink" },
  idle: { dot: "bg-idle-dot", chip: "bg-idle text-muted" },
} as const;

const FILTER_DOT: Record<Filter, string> = { all: "bg-ink", waiting: STATUS_LOOK.waiting.dot, working: STATUS_LOOK.working.dot, idle: STATUS_LOOK.idle.dot };

function accessLook(session: SessionInfo): { label: string; short: string; host: string; ok: boolean } {
  const url = session.access?.url;
  let host = location.host;
  try {
    if (url) host = new URL(url).host;
  } catch {
    /* a junk PUBLIC_URL: show where the page was opened */
  }
  if (session.herdr?.connected === false) return { label: "Herdr not responding", short: "No Herdr", host, ok: false };
  switch (session.access?.mode) {
    case "remote": return { label: "Remote access", short: "Remote", host, ok: true };
    case "lan": return { label: "Local network", short: "LAN", host, ok: true };
    default: return { label: "This computer only", short: "Local", host, ok: true };
  }
}

export function Home({ session, roster, connected, live, onLogout, onCreated }: {
  session: SessionInfo;
  roster: Roster;
  connected: boolean;
  /** the live-update socket is open */
  live: boolean;
  onLogout: () => void;
  onCreated: (paneId: string) => void;
}) {
  const { theme, toggle } = useTheme();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  /** the new-session dialog: null when closed, else the folder to start in (undefined: last used) */
  const [newIn, setNewIn] = useState<string | undefined | null>(null);

  const openNew = (path?: string) => {
    setDrawer(false);
    setNewIn(path);
  };

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  const view = useMemo(() => homeView(roster, filter, query), [roster, filter, query]);
  const access = accessLook({ ...session, herdr: { connected } });
  const showWaiting = view.waiting.length > 0 && (filter === "all" || filter === "waiting") && !query.trim();
  const shownGroups = view.groups.filter((g) => g.shown.length > 0);
  const filterLabel = filter === "all" ? "all sessions" : FILTERS.find((f) => f.id === filter)!.label.toLowerCase();
  const themeLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <div className="min-h-dvh lg:flex">
      {/* desktop sidebar */}
      <aside className="hidden w-[280px] shrink-0 flex-col gap-5 border-r border-line bg-surface px-4 py-6 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:overflow-y-auto">
        <div className="flex items-center justify-between px-2">
          <Brand size="text-[26px]" />
          <ThemeButton theme={theme} label={themeLabel} onClick={toggle} className="bg-canvas" />
        </div>
        <SidebarBody groups={view.groups} access={access} onLogout={onLogout} onNew={() => openNew()} extra={<OpenOnPhone access={session.access} />} />
      </aside>

      {/* mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-30 flex lg:hidden">
          <aside aria-label="Menu" className="relative z-10 flex w-[312px] max-w-[85vw] flex-col gap-4.5 overflow-y-auto border-r border-line bg-surface px-3.5 pt-3 pb-6 shadow-drawer">
            <div className="flex min-h-11 items-center gap-2 pl-1.5">
              <Brand size="text-2xl" />
              <button type="button" onClick={() => setDrawer(false)} aria-label="Close menu" className="ml-auto flex size-11 cursor-pointer items-center justify-center rounded-full border border-line">
                <Icon d="M6 6l12 12M18 6L6 18" size={18} width={2.2} />
              </button>
            </div>
            <SidebarBody
              groups={view.groups}
              access={access}
              onLogout={onLogout}
              onNew={() => openNew()}
              mobile
              onHome={() => setDrawer(false)}
              themeToggle={
                <button type="button" onClick={toggle} className="flex min-h-11 cursor-pointer items-center gap-2 text-left text-sm">
                  <ThemeIcon theme={theme} size={16} />
                  {themeLabel}
                </button>
              }
            />
          </aside>
          <button type="button" aria-label="Close menu" onClick={() => setDrawer(false)} className="flex-1 cursor-pointer bg-scrim" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile header */}
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-line bg-canvas py-3 pr-4 pl-2 lg:hidden">
          <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer} className="relative flex size-11 cursor-pointer items-center justify-center rounded-full">
            <Icon d="M4 7h16M4 12h16M4 17h10" size={22} width={2.2} />
            {view.waiting.length > 0 && <span className="absolute top-[9px] right-[7px] size-[9px] rounded-full border-2 border-canvas bg-accent-ink" />}
          </button>
          <Brand size="text-2xl" />
          <span className={`ml-auto flex items-center gap-1.5 text-xs ${access.ok ? "text-ok-ink" : "text-danger-ink"}`}>
            <span className={`size-[7px] rounded-full ${access.ok ? "bg-ok-dot" : "bg-danger-line"}`} />
            {access.short}
          </span>
          <ThemeButton theme={theme} label={themeLabel} onClick={toggle} className="bg-surface" />
        </header>

        <main className="flex flex-1 flex-col gap-6 px-4 pt-5 pb-8 lg:gap-9 lg:p-[clamp(24px,4vw,48px)]">
          <header className="flex flex-wrap items-end justify-between gap-5">
            <div className="flex flex-col gap-1 lg:gap-1.5">
              <h1 className="text-[40px] leading-none font-extrabold tracking-[-0.04em] lg:text-[clamp(36px,4vw,52px)]">Home</h1>
              <p className="text-[15px] text-muted lg:text-base">
                {plural(view.groups.length, "workspace", "workspaces")} · {plural(view.sessions, "open session", "open sessions")}
              </p>
            </div>
            <div className="relative flex w-full items-center lg:w-auto lg:min-w-[220px] lg:flex-[0_1_320px]">
              <label htmlFor="herdr-q" className="sr-only">Search sessions</label>
              <Icon d="M20 20l-3.5-3.5" circle={[11, 11, 7]} size={18} className="pointer-events-none absolute left-3.5 text-muted" />
              <input
                id="herdr-q"
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sessions or workspaces"
                className="h-12 w-full rounded-full border border-line bg-surface pr-4 pl-[42px] text-base text-ink outline-none placeholder:text-muted focus:border-accent-ink focus:shadow-[0_0_0_4px_var(--color-focus)] lg:h-11 lg:text-[15px]"
              />
            </div>
          </header>

          <div role="group" aria-label="Filter by status" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0 lg:pb-0">
            {FILTERS.map((f) => {
              const selected = f.id === filter;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setFilter(f.id)}
                  className={`flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-semibold whitespace-nowrap lg:min-h-10 ${
                    selected ? "border-inverse bg-inverse text-inverse-ink" : "border-line bg-surface text-ink"
                  }`}
                >
                  <span className={`size-2 rounded-full ${selected && f.id === "all" ? "bg-inverse-ink" : FILTER_DOT[f.id]}`} />
                  {f.label}
                  <span className="font-mono text-xs opacity-75">{view.counts[f.id]}</span>
                </button>
              );
            })}
          </div>

          {!live && (
            <p role="status" className="rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-muted">
              Lost connection to the server. Reconnecting…
            </p>
          )}

          {live && !connected && (
            <p role="status" className="rounded-2xl border border-danger-line px-4 py-3 text-sm text-danger-ink">
              Herdr isn't responding. The list will update when it's back.
            </p>
          )}

          {showWaiting && (
            <section className="flex flex-col gap-3 lg:gap-3.5">
              <SectionTitle title="Needs you" meta={String(view.waiting.length)} />
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
                {view.waiting.map((p) => (
                  <WaitingCard key={p.pane_id} pane={p} workspace={roster.workspaces.find((w) => w.workspace_id === p.workspace_id)?.label ?? ""} />
                ))}
              </div>
            </section>
          )}

          <section className="flex flex-col gap-3 lg:gap-3.5">
            <SectionTitle title="Workspaces" meta={filterLabel} />
            {shownGroups.length === 0 && (
              <div className="rounded-[18px] border-[1.5px] border-dashed border-line px-4 py-7 text-center text-[15px] text-muted lg:p-8">
                {view.sessions === 0 ? "No open sessions in Herdr." : "No sessions match this filter."}
              </div>
            )}
            <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr))]">
              {shownGroups.map((g) => (
                <WorkspaceCard key={g.workspace.workspace_id} group={g} onNew={() => openNew(g.workspace.path)} />
              ))}
            </div>
          </section>

          <div className="flex items-center justify-between gap-3 pt-2 text-[13px] text-muted lg:hidden">
            <span className="truncate font-mono text-xs">{access.host}</span>
            <LogoutButton onClick={onLogout} />
          </div>
        </main>

        {/* mobile: the main action stays in reach */}
        <div className="sticky bottom-0 z-10 bg-gradient-to-t from-canvas from-65% to-transparent px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] lg:hidden">
          <NewSession className="min-h-13 text-base shadow-fab" onClick={() => openNew()} />
        </div>
      </div>

      {newIn === null && <InstallBanner />}

      {newIn !== null && (
        <NewSessionDialog
          roster={roster}
          initialPath={newIn}
          onClose={() => setNewIn(null)}
          onCreated={(paneId) => {
            setNewIn(null);
            onCreated(paneId);
          }}
        />
      )}
    </div>
  );
}

function SidebarBody({ groups, access, onLogout, onNew, mobile, onHome, themeToggle, extra }: {
  groups: WorkspaceGroup[];
  access: ReturnType<typeof accessLook>;
  onLogout: () => void;
  onNew: () => void;
  mobile?: boolean;
  onHome?: () => void;
  themeToggle?: React.ReactNode;
  extra?: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <>
      <NewSession className={mobile ? "min-h-12 text-[15px]" : "min-h-11 text-[15px]"} onClick={onNew} />
      <nav aria-label="Workspaces" className="flex flex-1 flex-col gap-1">
        {mobile && (
          <button type="button" onClick={onHome} aria-current="page" className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[10px] bg-sunken px-2.5 text-left text-[15px] font-semibold">
            <Icon d="M3 11l9-7 9 7M5 10v10h14V10" size={18} />
            Home
          </button>
        )}
        <div className={`px-2 font-mono text-[11px] tracking-[0.12em] text-muted uppercase ${mobile ? "pt-3.5 pb-1.5" : "pt-1 pb-1.5"}`}>Workspaces</div>
        {groups.length === 0 && <p className="px-2 text-sm text-muted">No workspaces.</p>}
        {groups.map((g) => {
          const id = g.workspace.workspace_id;
          const expanded = !collapsed[id];
          return (
            <div key={id} className="flex flex-col">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setCollapsed({ ...collapsed, [id]: expanded })}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-[10px] px-2 text-left text-[15px] font-bold hover:bg-sunken"
              >
                <Chevron open={expanded} size={14} />
                <span className="min-w-0 flex-1 truncate">{g.workspace.label}</span>
                {g.waiting > 0 && <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[11px] text-white">{g.waiting}</span>}
                <span className="font-mono text-[11px] text-muted">{g.panes.length}</span>
              </button>
              {expanded && (
                <div className={`flex flex-col gap-0.5 pb-2 ${mobile ? "pl-6" : "pl-[22px]"}`}>
                  {g.panes.map((p) => {
                    return (
                      <a key={p.pane_id} href={sessionHref(p.pane_id)} className={`flex items-center gap-2.5 rounded-[10px] px-2.5 hover:bg-sunken ${mobile ? "min-h-11 text-[15px]" : "min-h-10 text-sm"} ${p.status === "blocked" ? "bg-accent-soft" : ""}`}>
                        <span className={`size-2 shrink-0 rounded-full ${STATUS_LOOK[BUCKET_OF[p.status]].dot}`} />
                        <span className="min-w-0 flex-1 truncate">{sessionName(p)}</span>
                        <AgentTile agent={p.agent} className={`rounded-[5px] font-mono text-[10px] font-semibold ${mobile ? "size-5" : "size-[18px]"}`} />
                      </a>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className={`flex flex-col border-t border-line px-2.5 pt-3.5 ${mobile ? "gap-1.5" : "gap-2.5"}`}>
        <span className={`flex items-center gap-2 text-[13px] ${access.ok ? "text-ok-ink" : "text-danger-ink"}`}>
          <span className={`size-2 rounded-full ${access.ok ? "bg-ok-dot" : "bg-danger-line"}`} />
          {access.label}
        </span>
        <span className="truncate font-mono text-xs text-muted">{access.host}</span>
        {themeToggle}
        {extra}
        <LogoutButton onClick={onLogout} />
      </div>
    </>
  );
}

function WaitingCard({ pane, workspace }: { pane: RosterPane; workspace: string }) {
  const look = agentLook(pane.agent);
  return (
    <article className="flex flex-col gap-3 rounded-[18px] border-2 border-accent-ink bg-surface p-4 lg:gap-3.5 lg:p-5">
      <div className="flex items-center gap-2.5 lg:gap-3">
        <AgentTile agent={pane.agent} className="size-[34px] rounded-[10px] text-[15px] font-bold lg:size-9" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-base font-bold lg:text-[17px]">{sessionName(pane)}</span>
          <span className="truncate font-mono text-[11px] text-muted lg:text-xs">{workspace} · {look.label}</span>
        </div>
        <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[11px] text-accent-soft-ink">{STATUS_LABEL.blocked}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Ago at={pane.changed_at} className="text-[13px] text-muted" fallback={<span className="text-[13px] text-muted">{pane.cwd}</span>} />
        <a href={sessionHref(pane.pane_id)} className="flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-[18px] text-[15px] font-semibold text-white lg:min-h-10 lg:text-sm">
          Open
          <Icon d="M5 12h14M13 6l6 6-6 6" size={14} width={2.4} />
        </a>
      </div>
    </article>
  );
}

function WorkspaceCard({ group, onNew }: { group: WorkspaceGroup; onNew: () => void }) {
  const [open, setOpen] = useState(true);
  const { workspace, shown } = group;
  const waiting = shown.filter((p) => p.status === "blocked").length;
  return (
    <article className="flex flex-col overflow-hidden rounded-[18px] border border-line bg-surface">
      <div className="flex items-center gap-1 py-1.5 pr-2 pl-1.5 lg:gap-3 lg:pt-4 lg:pr-4 lg:pb-3 lg:pl-5">
        {/* on a phone the header folds the card; on a desktop the card is always open */}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-h-[52px] min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl px-2 text-left lg:pointer-events-none lg:min-h-0 lg:gap-3 lg:px-0"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-inverse text-[15px] font-bold text-inverse-ink">{workspace.label[0]?.toUpperCase()}</span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[17px] font-bold tracking-[-0.01em] lg:text-lg">{workspace.label}</span>
            <span className="truncate font-mono text-[11px] text-muted lg:text-xs">{workspace.path}</span>
          </span>
          {waiting > 0 && <span className="rounded-full bg-accent px-2 py-0.5 font-mono text-[11px] text-white lg:hidden">{waiting}</span>}
          <span className="font-mono text-xs text-muted lg:hidden">{shown.length}</span>
          <Chevron open={open} size={16} className="lg:hidden" />
        </button>
        <button type="button" onClick={onNew} aria-label={`New session in ${workspace.label}`} className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line hover:bg-sunken lg:size-10">
          <Icon d="M12 5v14M5 12h14" size={16} width={2.2} />
        </button>
      </div>
      <div className={`flex-col px-1.5 pb-1.5 lg:flex lg:px-2 lg:pb-2 ${open ? "flex" : "hidden"}`}>
        {shown.map((p) => (
          <SessionRow key={p.pane_id} pane={p} />
        ))}
      </div>
    </article>
  );
}

function SessionRow({ pane }: { pane: RosterPane }) {
  const look = agentLook(pane.agent);
  const status = STATUS_LOOK[BUCKET_OF[pane.status]];
  return (
    <a href={sessionHref(pane.pane_id)} className="flex min-h-16 items-center gap-3 border-t border-line-soft px-2.5 py-2 hover:bg-inset lg:min-h-[60px] lg:rounded-xl lg:px-3">
      <AgentTile agent={pane.agent} className="size-[30px] rounded-lg font-mono text-[13px] font-semibold" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold">{sessionName(pane)}</span>
        <span className="truncate text-[13px] text-muted">{look.label} · {pane.cwd}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className={`flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11px] font-semibold lg:px-2.5 lg:text-xs ${status.chip}`}>
          <span className={`size-1.5 rounded-full ${status.dot}`} />
          {STATUS_LABEL[pane.status]}
        </span>
        <Ago at={pane.changed_at} className="text-[11px] text-muted lg:text-xs" />
      </span>
    </a>
  );
}

function SectionTitle({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-baseline gap-2.5 border-b-2 border-ink pb-1.5 lg:gap-3 lg:pb-2">
      <h2 className="text-[22px] font-bold tracking-[-0.02em] lg:text-2xl">{title}</h2>
      <span className="font-mono text-xs text-muted lg:text-[13px]">{meta}</span>
    </div>
  );
}

function Brand({ size }: { size: string }) {
  return (
    <span className={`${size} leading-none font-extrabold tracking-[-0.045em]`}>
      Herdr<span className="text-accent-ink">.</span>
    </span>
  );
}

function NewSession({ className, onClick }: { className: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-accent font-semibold text-white ${className}`}>
      <Icon d="M12 5v14M5 12h14" size={16} width={2.2} />
      New session
    </button>
  );
}

function LogoutButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted hover:text-ink lg:min-h-10">
      <Icon d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" size={16} />
      Sign out
    </button>
  );
}

function ThemeButton({ theme, label, onClick, className }: { theme: "light" | "dark"; label: string; onClick: () => void; className: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={`flex size-11 cursor-pointer items-center justify-center rounded-full border border-line ${className}`}>
      <ThemeIcon theme={theme} size={18} />
    </button>
  );
}

/** a sun in dark mode (go light), a moon in light mode (go dark) */
function ThemeIcon({ theme, size }: { theme: "light" | "dark"; size: number }) {
  return theme === "dark" ? (
    <Icon d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" circle={[12, 12, 4]} size={size} />
  ) : (
    <Icon d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" size={size} />
  );
}

function Chevron({ open, size, className = "" }: { open: boolean; size: number; className?: string }) {
  return (
    <Icon d="M9 6l6 6-6 6" size={size} width={2.4} className={`shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-90" : ""} ${className}`} />
  );
}

export function Icon({ d, size, width = 2, circle, className }: { d: string; size: number; width?: number; circle?: [number, number, number]; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {circle && <circle cx={circle[0]} cy={circle[1]} r={circle[2]} />}
      <path d={d} />
    </svg>
  );
}
