import { useEffect, useRef, useState } from "react";
import type { Roster } from "../../shared/protocol.ts";
import { AgentTile } from "./AgentTile.tsx";
import { ApiFailure, api, type Permission, type SessionKind } from "./api.ts";
import { agentLook } from "./home.ts";
import { Icon } from "./Home.tsx";

const KINDS: SessionKind[] = ["shell", "claude", "codex", "opencode"];

const PERMISSIONS: { id: Permission; label: string; desc: string; danger?: boolean }[] = [
  { id: "ask", label: "Always ask", desc: "Every edit and command goes through you." },
  { id: "edits", label: "Accept edits", desc: "Edits files on its own; asks before running commands." },
  { id: "plan", label: "Plan only", desc: "Reads and proposes a plan without changing anything." },
  { id: "bypass", label: "Bypass permissions", desc: "Edits and runs commands without asking you. Only use it in folders you trust.", danger: true },
];

/** the permissions each agent can start with (the server checks the same); never remembered */
const KIND_PERMISSIONS: Partial<Record<SessionKind, Permission[]>> = {
  claude: ["ask", "edits", "plan", "bypass"],
  opencode: ["ask", "bypass"],
};

const COMMAND_CHIPS = ["git status", "ls -la"];

/** remembered per browser: the last folder and choice (the footer promises it) */
const LAST_KEY = "herdr-web.last-session";

function loadLast(): { cwd: string; kind: SessionKind } | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as { cwd?: unknown; kind?: unknown } | null;
    if (value && typeof value.cwd === "string" && KINDS.includes(value.kind as SessionKind)) return { cwd: value.cwd, kind: value.kind as SessionKind };
  } catch {
    /* unreadable storage: start from the defaults */
  }
  return null;
}

function saveLast(cwd: string, kind: SessionKind): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ cwd, kind }));
  } catch {
    /* private mode: nothing to remember */
  }
}

const lastSegment = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const shortPath = (path: string) => path.split("/").filter(Boolean).slice(-2).join("/");

export function NewSessionDialog({ roster, initialPath, onClose, onCreated }: {
  roster: Roster;
  /** a workspace's folder (its "+" button); undefined: the last one used */
  initialPath: string | undefined;
  onClose: () => void;
  onCreated: (paneId: string) => void;
}) {
  const last = useRef(loadLast()).current;
  // only folders inside home can host a session (the server refuses the rest)
  const recents = [...new Set([last?.cwd, ...roster.workspaces.map((w) => w.path)].filter((p): p is string => !!p && (p === "~" || p.startsWith("~/"))))].slice(0, 4);
  const [path, setPath] = useState(initialPath?.startsWith("~") ? initialPath : (recents[0] ?? "~"));
  const [kind, setKind] = useState<SessionKind>(last?.kind ?? "claude");
  const [explorer, setExplorer] = useState(false);
  const [message, setMessage] = useState("");
  const [command, setCommand] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [permission, setPermission] = useState<Permission>("ask");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLFormElement>(null);

  const isShell = kind === "shell";
  const look = agentLook(isShell ? null : kind);
  const defaultName = `${lastSegment(path)}-${kind}`;
  const sessionName = name ?? defaultName;
  const permOptions = PERMISSIONS.filter((p) => KIND_PERMISSIONS[kind]?.includes(p.id));
  // a choice the new agent does not have falls back to asking
  const perm = permOptions.find((p) => p.id === permission) ?? PERMISSIONS[0]!;
  const summary = permOptions.length === 0 ? sessionName : `${sessionName} · ${perm.label}`;
  const startLabel = isShell ? "Open terminal" : `Start ${look.label}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (explorer) setExplorer(false);
        else onClose();
        return;
      }
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && /^[1-4]$/.test(e.key)) {
        setKind(KINDS[Number(e.key) - 1]!);
        setName(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [explorer, onClose]);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createSession({
        cwd: path,
        kind,
        name: sessionName,
        ...(isShell ? { command } : { message, permission: perm.id }),
      });
      saveLast(path, kind);
      onCreated(created.pane_id);
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiFailure && e.code === "invalid_session" ? "Check the folder and the session details." : e instanceof ApiFailure && e.status === 502 ? "Herdr couldn't create the session." : "Couldn't create the session.");
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto px-4 pt-[clamp(16px,7vh,72px)] pb-10">
      <div aria-hidden="true" className="fixed inset-0 bg-dialog-scrim" onClick={onClose} />
      <form
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ns-title"
        onSubmit={submit}
        className="relative flex w-full max-w-[640px] flex-col overflow-hidden rounded-3xl border border-line bg-surface shadow-dialog"
      >
        <div className="flex items-center gap-3 pt-[18px] pr-4 pb-1.5 pl-6">
          <h1 id="ns-title" className="text-[26px] font-extrabold tracking-[-0.03em]">New session</h1>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex size-11 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-sunken hover:text-ink">
            <Icon d="M6 6l12 12M18 6L6 18" size={18} width={2.2} />
          </button>
        </div>

        <div className="flex flex-col gap-[22px] px-6 pt-3 pb-6 max-sm:px-4">
          <div className="flex flex-col gap-2.5">
            <span className="text-[13px] font-bold text-muted">Where</span>
            <button
              type="button"
              onClick={() => setExplorer(!explorer)}
              aria-expanded={explorer}
              className={`flex min-h-[52px] cursor-pointer items-center gap-3 rounded-[14px] border bg-inset px-3.5 text-left font-mono text-[15px] ${explorer ? "border-accent-ink" : "border-line"}`}
            >
              <FolderIcon />
              <span className="min-w-0 flex-1 truncate">{path}</span>
              <span className="font-sans text-sm font-semibold text-accent-ink">{explorer ? "Done" : "Change"}</span>
            </button>
            {explorer ? (
              <Explorer path={path} onPath={setPath} onDone={() => setExplorer(false)} />
            ) : (
              recents.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-0.5 text-[13px] text-muted">Recent</span>
                  {recents.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={r === path}
                      onClick={() => setPath(r)}
                      className={`min-h-9 cursor-pointer rounded-full border px-3 font-mono text-[13px] ${r === path ? "border-inverse bg-inverse text-inverse-ink" : "border-line bg-surface text-ink"}`}
                    >
                      {shortPath(r) || r}
                    </button>
                  ))}
                </div>
              )
            )}
          </div>

          <div className="flex flex-col gap-2.5">
            <span id="ns-kind" className="text-[13px] font-bold text-muted">With</span>
            <div role="radiogroup" aria-labelledby="ns-kind" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {KINDS.map((k, i) => {
                const on = k === kind;
                return (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    data-autofocus={on ? "" : undefined}
                    onClick={() => {
                      setKind(k);
                      setName(null);
                    }}
                    className={`relative flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl px-1.5 py-3 ${on ? "border-2 border-ink bg-inset" : "border border-line bg-surface"}`}
                  >
                    <AgentTile agent={k === "shell" ? null : k} className={`size-10 rounded-[11px] text-[17px] font-bold ${k === "shell" ? "font-mono" : ""}`} />
                    <span className="text-center text-sm leading-tight font-semibold">{agentLook(k === "shell" ? null : k).label}</span>
                    <span className="absolute top-2 right-2.5 font-mono text-[11px] text-muted max-sm:hidden">{i + 1}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {isShell ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="ns-cmd" className="text-[13px] font-bold text-muted">
                Command on open <span className="font-normal">(optional)</span>
              </label>
              <div className="flex items-center overflow-hidden rounded-[14px] border border-term-line bg-term">
                <span className="pr-1 pl-4 font-mono text-[15px] text-term-prompt">$</span>
                <input
                  id="ns-cmd"
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npm run dev"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-[52px] min-w-0 flex-1 bg-transparent px-3 font-mono text-base text-term-ink lg:text-[15px] outline-none placeholder:text-term-muted"
                />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {COMMAND_CHIPS.map((c) => (
                  <button key={c} type="button" onClick={() => setCommand(c)} className="min-h-9 cursor-pointer rounded-full border border-line bg-surface px-3 font-mono text-[13px]">
                    {c}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="ns-msg" className="text-[13px] font-bold text-muted">
                First message <span className="font-normal">(optional)</span>
              </label>
              <textarea
                id="ns-msg"
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
                }}
                placeholder="What should it do? You can leave this empty and write later."
                className="resize-none rounded-[14px] border border-line bg-inset px-4 py-3.5 text-base leading-normal text-ink outline-none placeholder:text-muted focus:border-accent-ink"
              />
            </div>
          )}

          <div className="flex flex-col rounded-[14px] border border-line">
            <button type="button" onClick={() => setOptionsOpen(!optionsOpen)} aria-expanded={optionsOpen} className="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-[14px] px-3.5 text-left text-sm">
              <Icon d="M9 6l6 6-6 6" size={14} width={2.4} className={`shrink-0 text-muted transition-transform duration-150 ${optionsOpen ? "rotate-90" : ""}`} />
              <span className="font-semibold">Options</span>
              <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted">{summary}</span>
            </button>
            {optionsOpen && (
              <div className="flex flex-col gap-4 px-3.5 pt-1 pb-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="ns-name" className="text-[13px] font-bold">Name</label>
                  <input
                    id="ns-name"
                    type="text"
                    value={sessionName}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                    className="h-11 rounded-[10px] border border-line bg-surface px-3.5 font-mono text-base text-ink lg:text-sm outline-none focus:border-accent-ink"
                  />
                </div>
                {permOptions.length > 0 && (
                  <div role="radiogroup" aria-labelledby="ns-perm" className="flex flex-col gap-1.5">
                    <span id="ns-perm" className="text-[13px] font-bold">Permissions</span>
                    <div className="flex flex-wrap gap-1.5">
                      {permOptions.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          role="radio"
                          aria-checked={p.id === perm.id}
                          onClick={() => setPermission(p.id)}
                          className={`min-h-10 cursor-pointer rounded-full border px-3.5 text-sm font-semibold ${
                            p.id !== perm.id ? "border-line bg-surface text-ink" : p.danger ? "border-danger-line bg-danger text-danger-ink" : "border-inverse bg-inverse text-inverse-ink"
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <span className={`text-[13px] ${perm.danger ? "font-semibold text-danger-ink" : "text-muted"}`}>{perm.desc}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="rounded-xl bg-danger px-4 py-3 text-sm text-danger-ink">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-foot py-3.5 pr-4 pl-6 max-sm:pl-4">
          <span className="text-[13px] text-muted max-sm:hidden">We remember your last folder and choice</span>
          <button
            type="submit"
            disabled={busy}
            className="ml-auto flex h-12 cursor-pointer items-center gap-2.5 rounded-full bg-accent px-[22px] text-base font-semibold text-white disabled:cursor-wait disabled:opacity-70 max-sm:w-full max-sm:justify-center"
          >
            {busy ? "Starting…" : startLabel}
            {!busy && <span className="rounded-md bg-white/20 px-[7px] py-0.5 font-mono text-xs">⏎</span>}
          </button>
        </div>
      </form>
    </div>
  );
}

/** inline folder browser: breadcrumbs, `..`, subfolders with their git branch */
function Explorer({ path, onPath, onDone }: { path: string; onPath: (path: string) => void; onDone: () => void }) {
  const [dirs, setDirs] = useState<{ name: string; git: string | null }[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setDirs(null);
    setFailed(false);
    api.folders(path).then(
      (r) => live && setDirs(r.dirs),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [path]);

  const segments = path.split("/").filter(Boolean);
  const crumbs = segments.map((label, i) => ({ label, to: segments.slice(0, i + 1).join("/") }));
  const folder = segments[segments.length - 1] ?? path;

  return (
    <div className="flex flex-col overflow-hidden rounded-[14px] border border-line">
      <nav aria-label="Path" className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2.5">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={c.to} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onPath(c.to)}
                aria-current={last ? "location" : undefined}
                className={`min-h-[34px] cursor-pointer rounded-full px-2.5 font-mono text-[13px] ${last ? "bg-inverse text-inverse-ink" : "bg-inset text-ink"}`}
              >
                {c.label}
              </button>
              {!last && <span className="font-mono text-muted">/</span>}
            </span>
          );
        })}
      </nav>
      <div className="flex max-h-[260px] flex-col overflow-y-auto p-1.5">
        {segments.length > 1 && (
          <button type="button" onClick={() => onPath(segments.slice(0, -1).join("/"))} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-left font-mono text-sm text-muted hover:bg-inset">
            <Icon d="M15 18l-6-6 6-6" size={16} />
            ..
          </button>
        )}
        {failed && <p className="px-2.5 py-3 text-sm text-danger-ink">Couldn't read this folder.</p>}
        {!failed && dirs === null && <p className="px-2.5 py-3 text-sm text-muted">Loading…</p>}
        {dirs?.length === 0 && <p className="px-2.5 py-3 text-sm text-muted">No subfolders.</p>}
        {dirs?.map((d) => (
          <button key={d.name} type="button" onClick={() => onPath(`${path}/${d.name}`)} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-left text-[15px] hover:bg-inset">
            <FolderIcon size={16} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            {d.git && <span className="font-mono text-[11px] text-muted">{d.git}</span>}
            <Icon d="M9 6l6 6-6 6" size={14} className="shrink-0 text-muted" />
          </button>
        ))}
      </div>
      <div className="flex justify-end border-t border-line bg-inset px-2.5 py-2">
        <button type="button" onClick={onDone} className="min-h-10 cursor-pointer rounded-full bg-inverse px-4 text-sm font-semibold text-inverse-ink">
          Use {folder}
        </button>
      </div>
    </div>
  );
}

function FolderIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-accent-ink">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
