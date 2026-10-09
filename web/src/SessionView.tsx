import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import type { AgentUsage, Roster, SessionInfo } from "../../shared/protocol.ts";
import { UsageButton } from "./Usage.tsx";
import { OpencodeControls, OpencodeModelList, OpencodeVariantList, useOpencodeOptions, variantLabel } from "./OpencodeControls.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { ApiFailure, api, type PaneKey } from "./api.ts";
import { agentLook, sessionName } from "./home.ts";
import { MAX_FONT_PX, fitTerminal, isRule } from "./terminal.ts";
import { Icon } from "./Home.tsx";
import { PhoneDialog } from "./OpenOnPhone.tsx";
import { BELL_ICON, PUSH_LABEL, SOUND_OFF_ICON, SOUND_ON_ICON, usePushToggle } from "./AlertSettings.tsx";
import { setSoundMuted, useSoundMuted } from "./alerts.ts";
import { createPortal } from "react-dom";

/** the special-keys bar under the terminal; `|` and `~` are typed as text */
const KEYS: { label: string; aria: string; key?: PaneKey; text?: string }[] = [
  { label: "Esc", aria: "Escape", key: "esc" },
  { label: "Tab", aria: "Tab", key: "tab" },
  { label: "↑", aria: "Up arrow", key: "up" },
  { label: "↓", aria: "Down arrow", key: "down" },
  { label: "←", aria: "Left arrow", key: "left" },
  { label: "→", aria: "Right arrow", key: "right" },
  { label: "⏎", aria: "Enter", key: "enter" },
  { label: "⌫", aria: "Backspace", key: "backspace" },
  { label: "|", aria: "Pipe", text: "|" },
  { label: "~", aria: "Tilde", text: "~" },
  { label: "^C", aria: "Control C", key: "ctrl+c" },
];

const POLL_MS = 1000;

// the chat (and its markdown renderer) loads only when a chat is opened
const ChatView = lazy(() => import("./ChatView.tsx").then((m) => ({ default: m.ChatView })));

/** agents whose conversation the chat view can read; the rest show their terminal */
const CHAT_AGENTS = new Set(["claude", "opencode"]);

/** Claude model ids → a short name: claude-opus-5-5 → Opus 5.5 */
export function modelName(model: string | null): string | null {
  if (!model) return null;
  // other providers' ids (MiniMax-M3, gpt-5…) read fine as they are
  if (!model.startsWith("claude-")) return model;
  const parts = model.replace(/^claude-/, "").split("-");
  const family = parts.shift() ?? "";
  return [family.charAt(0).toUpperCase() + family.slice(1), parts.filter((p) => /^\d+$/.test(p)).join(".")].filter(Boolean).join(" ");
}

/** One session: the chat for Claude, the terminal for everything else (and on demand). */
export function SessionView({ paneId, roster, loaded, access, onBack }: { paneId: string; roster: Roster; loaded: boolean; access: SessionInfo["access"]; onBack: () => void }) {
  const pane = roster.panes.find((p) => p.pane_id === paneId);
  const workspace = roster.workspaces.find((w) => w.workspace_id === pane?.workspace_id);
  const hasChat = !!pane?.agent && CHAT_AGENTS.has(pane.agent);
  const [gone, setGone] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const look = agentLook(pane?.agent ?? null);
  const title = pane ? sessionName(pane) : paneId;
  const ended = gone || (loaded && !pane);
  const subtitle = [pane?.cwd ?? workspace?.path ?? "", modelName(model) ?? look.label].filter(Boolean).join(" · ");

  const close = async () => {
    try {
      await api.closePane(paneId);
    } catch {
      /* already closed: going back is the same */
    }
    onBack();
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex items-center border-b border-line bg-surface px-[clamp(12px,3vw,32px)] py-2.5 lg:py-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 lg:gap-3.5">
          <a href="#/" onClick={(e) => { e.preventDefault(); onBack(); }} aria-label="Back to Home" className="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-sunken lg:border lg:border-line">
            <Icon d="M19 12H5M11 6l-6 6 6 6" size={18} width={2.2} />
          </a>
          <AgentTile agent={pane?.agent ?? null} className="size-9 rounded-[10px] font-mono text-base font-semibold" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[17px] font-bold">{title}</span>
            <span className="truncate font-mono text-xs text-muted">{subtitle}</span>
          </span>
          {!ended && pane?.agent === "claude" && (
            <ModelControls
              model={usage?.model ?? modelName(model)}
              effort={usage?.effort ?? null}
              // only a Claude at rest opens its menus: not while starting (unknown) or working
              busy={pane.status !== "idle" && pane.status !== "done"}
              menuOpen={menuOpen}
              onCommand={(command) => void api.prompt(paneId, command).catch(() => {})}
            />
          )}
          {!ended && pane?.agent === "opencode" && <OpencodeControls paneId={paneId} busy={pane.status !== "idle" && pane.status !== "done"} />}
          {!ended && usage && <UsageButton usage={usage} />}
          {!ended && (
            <SessionMenu
              access={access}
              onClose={close}
              // on a phone the header has no room for the model and effort buttons: they live here
              agentItems={(dismiss, item) =>
                pane?.agent === "claude" ? (
                  <ClaudeMenuItems
                    model={usage?.model ?? modelName(model)}
                    effort={usage?.effort ?? null}
                    busy={pane.status !== "idle" && pane.status !== "done"}
                    menuOpen={menuOpen}
                    item={item}
                    onCommand={(command) => {
                      dismiss();
                      void api.prompt(paneId, command).catch(() => {});
                    }}
                  />
                ) : pane?.agent === "opencode" ? (
                  <OpencodeMenuItems paneId={paneId} busy={pane.status !== "idle" && pane.status !== "done"} item={item} onDone={dismiss} />
                ) : null
              }
            />
          )}
        </div>
      </header>

      {ended ? (
        <main className="flex flex-1 flex-col p-4">
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[18px] border-[1.5px] border-dashed border-line p-10 text-center">
            <span className="text-xl font-bold">This session is no longer open</span>
            <button type="button" onClick={onBack} className="min-h-11 cursor-pointer rounded-full bg-accent px-5 text-[15px] font-semibold text-white">
              Back to Home
            </button>
          </div>
        </main>
      ) : hasChat && pane ? (
        // an agent with a chat is only a chat: its menus and prompts are answered from there
        <Suspense fallback={<p className="py-16 text-center text-muted">Loading conversation…</p>}>
          <ChatView key={pane.pane_id} pane={pane} onModel={setModel} onUsage={setUsage} onMenu={setMenuOpen} onGone={() => setGone(true)} />
        </Suspense>
      ) : (
        <main className="flex flex-1 flex-col gap-3 px-[clamp(12px,3vw,24px)] py-4">
          {pane?.agent && !hasChat && (
            <p className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-muted">
              Chat for {look.label} is coming later. For now you see its terminal, and you can type into it from here.
            </p>
          )}
          <TerminalPanel paneId={paneId} onGone={() => setGone(true)} />
        </main>
      )}
    </div>
  );
}

/**
 * Desktop: the model and effort as buttons that open Claude Code's own /model and /effort menus,
 * which the chat then shows as cards. Claude only opens them while it is not working.
 */
function ModelControls({ model, effort, busy, menuOpen, onCommand }: {
  model: string | null;
  effort: string | null;
  busy: boolean;
  menuOpen: boolean;
  onCommand: (command: string) => void;
}) {
  // after a click the buttons wait for the menu: disabled until it opens and closes again
  const [sent, setSent] = useState(false);
  const sawMenu = useRef(false);
  // set in the click itself: a second click in the same instant, before React redraws the
  // button as disabled, must not type another command into the menu that is opening
  const locked = useRef(false);
  useEffect(() => {
    if (!sent) return;
    if (menuOpen) sawMenu.current = true;
    else if (sawMenu.current) {
      setSent(false);
      locked.current = false;
    }
  }, [menuOpen, sent]);
  useEffect(() => {
    if (!sent) return;
    // the menu never showed (Claude busy, command refused): give the buttons back
    const timer = setTimeout(() => {
      if (sawMenu.current) return;
      setSent(false);
      locked.current = false;
    }, 8000);
    return () => clearTimeout(timer);
  }, [sent]);
  const run = (command: string) => {
    if (locked.current) return;
    locked.current = true;
    sawMenu.current = false;
    setSent(true);
    onCommand(command);
  };
  const disabled = busy || sent || menuOpen;
  const chevron = <Icon d="M6 9l6 6 6-6" size={14} width={2.2} className="text-muted" />;
  const button = "flex h-9 cursor-pointer items-center gap-1.5 px-3 text-[13px] font-semibold hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
  const why = busy ? "Available when Claude is ready" : sent || menuOpen ? "Pick from the menu in the chat" : undefined;
  return (
    <div className="hidden shrink-0 overflow-hidden rounded-full border border-line lg:flex">
      <button type="button" disabled={disabled} title={why ?? "Change model"} onClick={() => run("/model")} className={button}>
        {model ?? "Model"}
        {chevron}
      </button>
      <span className="w-px bg-line" aria-hidden="true" />
      <button type="button" disabled={disabled} title={why ?? "Change effort"} onClick={() => run("/effort")} className={button}>
        <span className="font-normal text-muted">effort</span>
        {effort ?? "—"}
        {chevron}
      </button>
    </div>
  );
}

const MODEL_ICON = "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 7h10v10H7z";
const EFFORT_ICON = "M4 18a8 8 0 1 1 16 0M12 14l4-4";

/** a menu row: icon, what it changes, and its current value */
function MenuRow({ icon, label, value, disabled, onClick, item }: { icon: string; label: string; value: string; disabled: boolean; onClick: () => void; item: string }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className={`${item} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}>
      <Icon d={icon} size={16} className="text-muted" />
      <span className="flex-1">{label}</span>
      <span className="max-w-[45%] truncate text-sm text-muted">{value}</span>
    </button>
  );
}

/**
 * Phone: Claude's model and effort in the "⋯" menu. Like the desktop buttons, each types /model or
 * /effort and the chat shows Claude Code's own menu as a card; only while Claude is at rest.
 */
function ClaudeMenuItems({ model, effort, busy, menuOpen, item, onCommand }: { model: string | null; effort: string | null; busy: boolean; menuOpen: boolean; item: string; onCommand: (command: string) => void }) {
  const why = busy ? "Available when Claude is ready" : menuOpen ? "Pick from the menu in the chat" : null;
  return (
    <>
      <MenuRow icon={MODEL_ICON} label="Model" value={model ?? "—"} disabled={!!why} onClick={() => onCommand("/model")} item={item} />
      <MenuRow icon={EFFORT_ICON} label="Effort" value={effort ?? "—"} disabled={!!why} onClick={() => onCommand("/effort")} item={item} />
      {why && <p className="px-3 pb-1 text-xs text-muted">{why}</p>}
    </>
  );
}

/** Phone: OpenCode's model and variant in the "⋯" menu; each opens its list in place. */
function OpencodeMenuItems({ paneId, busy, item, onDone }: { paneId: string; busy: boolean; item: string; onDone: () => void }) {
  const { options, working, error, setModel, setVariant, modelLabel } = useOpencodeOptions(paneId, busy);
  const [list, setList] = useState<"model" | "variant" | null>(null);
  if (!options || options.models.length === 0) return null;
  const why = busy ? "Available when OpenCode is ready" : working ? "Applying…" : null;
  // the menu stays open while OpenCode applies the change, and closes once it took it
  const pick = async (change: () => Promise<boolean>) => {
    setList(null);
    if (await change()) onDone();
  };
  if (list) {
    return (
      <>
        <button type="button" onClick={() => setList(null)} className={`${item} font-semibold`}>
          <Icon d="M15 6l-6 6 6 6" size={16} className="text-muted" />
          {list === "model" ? "Model" : "Effort"}
        </button>
        {list === "model" ? (
          <OpencodeModelList options={options} item={item} onPick={(provider, model) => void pick(() => setModel(provider, model))} />
        ) : (
          <OpencodeVariantList options={options} item={item} onPick={(v) => void pick(() => setVariant(v))} />
        )}
      </>
    );
  }
  return (
    <>
      <MenuRow icon={MODEL_ICON} label="Model" value={working ? "Applying…" : modelLabel} disabled={!!why} onClick={() => setList("model")} item={item} />
      <MenuRow icon={EFFORT_ICON} label="Effort" value={variantLabel(options.current.variant)} disabled={!!why || options.variants.length < 2} onClick={() => setList("variant")} item={item} />
      {(error ?? why) && <p className={`px-3 pb-1 text-xs ${error ? "text-danger-ink" : "text-muted"}`}>{error ?? why}</p>}
    </>
  );
}

/** the sound (muted for every session and Home alike) and this device's notifications */
function AlertItems({ item }: { item: string }) {
  const muted = useSoundMuted();
  const { state, busy, error, toggle } = usePushToggle();
  const push = PUSH_LABEL[state];
  return (
    <>
      <button type="button" role="menuitemcheckbox" aria-checked={!muted} onClick={() => setSoundMuted(!muted)} className={item}>
        <Icon d={muted ? SOUND_OFF_ICON : SOUND_ON_ICON} size={16} className="text-muted" />
        <span className="flex-1">{muted ? "Unmute sound" : "Mute sound"}</span>
      </button>
      {state !== "on" && (
        <button type="button" role="menuitem" disabled={!push.enabled || busy} title={push.hint} onClick={() => void toggle()} className={`${item} disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent`}>
          <Icon d={BELL_ICON} size={16} className="text-muted" />
          <span className="flex-1">{busy ? "Working on it…" : push.label}</span>
        </button>
      )}
      {error && <p className="px-3 pb-1 text-xs text-danger-ink">{error}</p>}
    </>
  );
}

/** "⋯": the actions that need not take header room (open on phone, close the session) */
function SessionMenu({ access, onClose, agentItems }: { access: SessionInfo["access"]; onClose: () => void; agentItems?: (dismiss: () => void, item: string) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [phone, setPhone] = useState(false);
  const root = useRef<HTMLDivElement>(null);

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

  const item = "flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 text-left text-[15px] hover:bg-sunken";
  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setConfirm(false);
        }}
        className="flex size-11 cursor-pointer items-center justify-center rounded-full hover:bg-sunken lg:border lg:border-line"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute top-12 right-0 z-30 flex max-h-[75dvh] w-72 flex-col gap-0.5 overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-dialog">
          {agentItems && (
            <div className="flex flex-col gap-0.5 border-b border-line pb-1.5 mb-1 empty:hidden lg:hidden">{agentItems(() => setOpen(false), item)}</div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setPhone(true);
            }}
            className={`${item} hidden lg:flex`}
          >
            <Icon d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM11 18h2" size={16} className="text-muted" />
            Open on phone
          </button>
          <AlertItems item={item} />
          {confirm ? (
            <div className="flex flex-col gap-2 p-2">
              <span className="text-sm">Close this session? The process will stop.</span>
              <div className="flex gap-2">
                <button type="button" role="menuitem" onClick={onClose} className="min-h-10 flex-1 cursor-pointer rounded-full bg-danger text-sm font-semibold text-danger-ink">
                  Yes, close
                </button>
                <button type="button" onClick={() => setConfirm(false)} className="min-h-10 flex-1 cursor-pointer rounded-full border border-line text-sm font-semibold">
                  No
                </button>
              </div>
            </div>
          ) : (
            <button type="button" role="menuitem" onClick={() => setConfirm(true)} className={`${item} text-danger-ink`}>
              <Icon d="M6 6l12 12M18 6L6 18" size={16} />
              Close session
            </button>
          )}
        </div>
      )}
      {phone && createPortal(<PhoneDialog access={access} onClose={() => setPhone(false)} />, document.body)}
    </div>
  );
}

/** what the pane shows, refreshed every second, with a line to type into it and special keys */
export function TerminalPanel({ paneId, onGone }: { paneId: string; onGone: () => void }) {
  const [screen, setScreen] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const term = useRef<HTMLPreElement>(null);
  const [width, setWidth] = useState(0);
  const stick = useRef(true);
  const refreshNow = useRef<() => void>(() => {});
  const gone = useRef(onGone);
  gone.current = onGone;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      try {
        const { text } = await api.screen(paneId);
        if (!live) return;
        setScreen(text.replace(/\s+$/, ""));
      } catch (e) {
        if (live && e instanceof ApiFailure && e.status === 404) gone.current();
      }
      if (live && !document.hidden) timer = setTimeout(tick, POLL_MS);
    };
    refreshNow.current = () => void tick();
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [paneId]);

  // the width the text gets (inside the padding), followed through rotations and resizes
  useEffect(() => {
    const el = term.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      setWidth(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lines = screen === null ? [] : screen.split("\n").map((l) => l.replace(/\s+$/, ""));
  const fit = width > 0 ? fitTerminal(lines, width) : { fontPx: MAX_FONT_PX, wrap: false };

  // follow the bottom of the screen unless the viewer scrolled up
  useEffect(() => {
    const el = term.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [screen]);

  const send = async (body: { text?: string; keys?: PaneKey[]; enter?: boolean }) => {
    setSendError(null);
    try {
      await api.input(paneId, body);
      setTimeout(() => refreshNow.current(), 120);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) gone.current();
      else setSendError("Couldn't send. Is the session still open?");
    }
  };

  const submitLine = (event: React.FormEvent) => {
    event.preventDefault();
    void send(line ? { text: line, enter: true } : { keys: ["enter"] });
    setLine("");
  };

  return (
    <>
      <pre
        ref={term}
        role="log"
        aria-label="Terminal"
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={`m-0 min-h-[420px] flex-1 overflow-y-auto rounded-[18px] border border-term-line bg-term px-3.5 py-4 font-mono leading-[1.5] text-term-ink sm:px-[22px] sm:py-5 ${fit.wrap ? "overflow-x-hidden whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto whitespace-pre"}`}
        style={{ maxHeight: "calc(100dvh - 260px)", fontSize: `${fit.fontPx}px` }}
      >
        {screen === null ? (
          <span className="text-term-muted">Connecting…</span>
        ) : (
          // one block per line; rules become a full-width line instead of wrapping characters
          lines.map((line, i) =>
            isRule(line) ? <div key={i} aria-hidden="true" className="my-[0.7em] border-t border-term-muted/50" /> : <div key={i} className="min-h-[1.5em]">{line}</div>,
          )
        )}
      </pre>

      <form onSubmit={submitLine} className="flex items-center gap-2 rounded-[14px] border border-term-line bg-term pr-1.5">
        <span className="pl-4 font-mono text-[15px] text-term-prompt">›</span>
        <label htmlFor="sv-line" className="sr-only">Type into the session</label>
        <input
          id="sv-line"
          type="text"
          value={line}
          onChange={(e) => setLine(e.target.value)}
          placeholder="Type and press Enter"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="h-12 min-w-0 flex-1 bg-transparent font-mono text-base text-term-ink outline-none placeholder:text-term-muted lg:text-[15px]"
        />
        <button type="submit" aria-label="Send" className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-white">
          <Icon d="M12 19V5M5 12l7-7 7 7" size={18} width={2.2} />
        </button>
      </form>

      {sendError && <p role="alert" className="text-sm text-danger-ink">{sendError}</p>}

      <div role="toolbar" aria-label="Special keys" className="flex flex-wrap gap-2">
        {KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            aria-label={k.aria}
            onClick={() => void send(k.key ? { keys: [k.key] } : { text: k.text! })}
            className="h-11 min-w-[52px] cursor-pointer rounded-xl border border-line bg-surface px-3 font-mono text-sm font-semibold hover:bg-sunken"
          >
            {k.label}
          </button>
        ))}
      </div>
    </>
  );
}
