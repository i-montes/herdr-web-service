import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentUsage, ChatItem, ChatSnapshot, PanePrompt, RosterPane } from "../../shared/protocol.ts";
import { AgentTile } from "./AgentTile.tsx";
import { ApiFailure, api } from "./api.ts";
import { agentLook } from "./home.ts";
import { Icon } from "./Home.tsx";
import { RunningTasks } from "./RunningTasks.tsx";

const POLL_MS = 1500;
const MAX_IMAGE = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** an image added to the next message: shown at once, uploaded in the background */
interface Attachment {
  id: string;
  preview: string;
  /** server path the agent reads; null while uploading */
  path: string | null;
  error: string | null;
}

/**
 * Images out of a paste or a drop. Safari often hands pasted images over as clipboard items, not
 * files, so both are read; a copy from a Mac app may be TIFF or HEIC: those are redrawn as PNG.
 */
function imagesFrom(data: DataTransfer): File[] {
  const files = [...data.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) return files;
  return [...data.items].filter((i) => i.kind === "file" && i.type.startsWith("image/")).map((i) => i.getAsFile()).filter((f): f is File => f !== null);
}

async function asUploadable(file: File): Promise<Blob> {
  if (IMAGE_TYPES.includes(file.type)) return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png"))), "image/png"));
}

/** how an image travels inside a message: the agent reads the path */
const imageToken = (path: string) => `[image: ${path}]`;
/** also the Spanish `[imagen: …]` that earlier versions sent, so old conversations keep their thumbnails */
const IMAGE_TOKEN = /\[(image|imagen): ([^\]]+)\]/g;
const UPLOAD_NAME = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|gif|webp))$/;
const FAST_POLL_MS = 600;

type ToolItem = Extract<ChatItem, { kind: "tool" }>;
type QuestionItem = Extract<ChatItem, { kind: "question" }>;

/** Claude Code's conversation for a pane, live, with a composer and the menus it waits on. */
export function ChatView({ pane, onModel, onUsage, onMenu, onGone }: {
  pane: RosterPane;
  onModel: (model: string | null) => void;
  onUsage: (usage: AgentUsage | null) => void;
  /** a menu (question, permission, /model…) is open in the chat, or not */
  onMenu: (open: boolean) => void;
  onGone: () => void;
}) {
  const [chat, setChat] = useState<ChatSnapshot | null>(null);
  const [prompt, setPrompt] = useState<PanePrompt | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  /** the option the keyboard is on, in the open menu */
  const [highlight, setHighlight] = useState(0);
  /** the menu's "write another answer" was picked: show the composer again */
  const [freeText, setFreeText] = useState(false);
  const version = useRef<string | null>(null);
  const pollNow = useRef<(fast?: boolean) => void>(() => {});
  const composer = useRef<HTMLTextAreaElement>(null);
  const callbacks = useRef({ onModel, onUsage, onMenu, onGone });
  callbacks.current = { onModel, onUsage, onMenu, onGone };
  const paneId = pane.pane_id;

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fastUntil = 0;
    const tick = async () => {
      clearTimeout(timer);
      try {
        const res = await api.chat(paneId, version.current);
        if (!live) return;
        setPrompt(res.prompt);
        if (res.chat) {
          version.current = res.chat.version;
          setChat(res.chat);
          callbacks.current.onModel(res.chat.usage?.model ?? res.chat.model);
          callbacks.current.onUsage(res.chat.usage ?? null);
        }
        setLoaded(true);
      } catch (e) {
        if (live && e instanceof ApiFailure && e.status === 404) callbacks.current.onGone();
      }
      if (live && !document.hidden) timer = setTimeout(tick, Date.now() < fastUntil ? FAST_POLL_MS : POLL_MS);
    };
    pollNow.current = (fast = false) => {
      if (fast) fastUntil = Date.now() + 15_000;
      void tick();
    };
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [paneId]);

  // stay at the bottom while new things arrive, unless the reader scrolled up
  useEffect(() => {
    const onScroll = () => setAtBottom(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const stick = useRef(true);
  stick.current = atBottom;
  useLayoutEffect(() => {
    if (stick.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [chat, prompt, pane.status]);

  const addImages = (files: Iterable<File>) => {
    setError(null);
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setError("Only images can be attached.");
        continue;
      }
      // not crypto.randomUUID: browsers only offer it on HTTPS, and the LAN mode serves plain HTTP
      const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setAttachments((list) => [...list, { id, preview: URL.createObjectURL(file), path: null, error: null }]);
      asUploadable(file)
        .then((blob) => {
          if (blob.size > MAX_IMAGE) throw new Error("too_large");
          return api.upload(blob);
        })
        .then(
        (saved) => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, path: saved.path } : a))),
        (e: Error) => setAttachments((list) => list.map((a) => (a.id === id ? { ...a, error: e.message === "too_large" ? "Larger than 10 MB" : "Upload failed" } : a))),
      );
    }
  };

  const removeImage = (id: string) =>
    setAttachments((list) => {
      const gone = list.find((a) => a.id === id);
      if (gone) URL.revokeObjectURL(gone.preview);
      return list.filter((a) => a.id !== id);
    });

  // paste works anywhere in the chat, not only with the cursor in the composer
  const addRef = useRef(addImages);
  addRef.current = addImages;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const files = imagesFrom(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      addRef.current(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  const uploading = attachments.some((a) => !a.path && !a.error);
  const ready = attachments.filter((a) => a.path);

  const send = async () => {
    const images = ready.map((a) => imageToken(a.path!));
    const text = [draft.trim(), ...images].filter(Boolean).join(" ");
    if (!text || sending || uploading) return;
    setSending(true);
    setError(null);
    try {
      await api.prompt(paneId, text);
      setDraft("");
      for (const a of attachments) URL.revokeObjectURL(a.preview);
      setAttachments([]);
      // the textarea grew with the message: back to one row
      if (composer.current) composer.current.style.height = "";
      stick.current = true;
      setAtBottom(true);
      pollNow.current(true);
    } catch {
      setError("Couldn't send the message.");
    } finally {
      setSending(false);
      composer.current?.focus();
    }
  };

  const stop = async () => {
    setError(null);
    try {
      await api.input(paneId, { keys: ["esc"] });
      pollNow.current(true);
    } catch {
      setError("Couldn't stop.");
    }
  };

  const cancel = async () => {
    setError(null);
    try {
      await api.input(paneId, { keys: ["esc"] });
      pollNow.current(true);
    } catch {
      setError("Couldn't cancel.");
    }
  };

  const choose = async (index: number, focusComposer: boolean) => {
    setError(null);
    try {
      await api.choose(paneId, index);
      pollNow.current(true);
      if (focusComposer) {
        // "write another answer": the composer comes back for the free text
        setFreeText(true);
        setTimeout(() => composer.current?.focus(), 50);
      }
    } catch (e) {
      setError(e instanceof ApiFailure && e.code === "no_prompt" ? "The question has changed; check the terminal." : "Couldn't answer.");
      pollNow.current();
    }
  };

  const items = chat?.items ?? [];
  const pendingQuestion = [...items].reverse().find((i): i is QuestionItem => i.kind === "question" && i.answer === null) ?? null;
  const choosing = !!prompt && !freeText;
  const pick = (index: number) => {
    if (!prompt) return;
    void choose(index, FREE_OPTION.test(prompt.options[index] ?? ""));
  };

  // a new menu starts highlighted where the terminal's cursor (or the current setting) is
  const promptKey = prompt ? `${prompt.title}|${prompt.options.join("|")}` : "";
  useEffect(() => {
    callbacks.current.onMenu(!!prompt);
    setHighlight(prompt ? (prompt.current ?? prompt.selected) : 0);
    if (!prompt) setFreeText(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptKey]);

  // keyboard: arrows move, Enter or a number picks, Esc cancels
  useEffect(() => {
    if (!choosing || !prompt) return;
    const count = prompt.options.length;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % count);
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + count) % count);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        pick(highlight);
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= count) {
        e.preventDefault();
        pick(Number(e.key) - 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        void cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const look = agentLook(pane.agent);
  const working = pane.status === "working";
  const empty = loaded && items.length === 0;

  return (
    <>
      <main
        className={`relative flex flex-1 justify-center bg-stream px-4 pt-6 pb-4 ${dragging ? "outline-2 -outline-offset-8 outline-accent-ink outline-dashed" : ""}`}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
        onDrop={(e) => {
          const files = imagesFrom(e.dataTransfer);
          if (!files.length) return;
          e.preventDefault();
          setDragging(false);
          addImages(files);
        }}
      >
        <div className="flex w-full max-w-[820px] flex-col gap-[18px]">
          {chat?.source === "guess" && (
            <p className="rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[13px] text-muted">
              Conversation picked by folder. If it isn't this session's, restart the agent in it and Herdr will identify it.
            </p>
          )}
          {chat && chat.hidden > 0 && <p className="text-center text-[13px] text-muted">{chat.hidden} earlier items not shown</p>}

          {!loaded && <p className="py-16 text-center text-muted">Loading conversation…</p>}

          {empty && !prompt && (
            <div className="flex flex-col items-center gap-2.5 px-4 py-16 text-center">
              <AgentTile agent={pane.agent} className="size-14 rounded-2xl text-[22px] font-bold" />
              <span className="text-2xl font-bold tracking-[-0.02em]">{look.label} is ready</span>
              <span className="text-[15px] text-muted">Type below what you want it to do.</span>
            </div>
          )}

          {items.map((item) => (
            <ChatEntry key={item.id} item={item} />
          ))}

          {chat?.queued.map((text, i) => (
            <div key={`q${i}`} className="flex max-w-[85%] flex-col items-end gap-1 self-end">
              <UserBubble text={text} queued />
              <span className="font-mono text-[11px] text-muted">queued</span>
            </div>
          ))}

          {prompt &&
            (pendingQuestion ? (
              <QuestionPrompt prompt={prompt} question={pendingQuestion} highlight={choosing ? highlight : -1} onPick={pick} onHover={setHighlight} onCancel={cancel} />
            ) : (
              <ChoicePrompt prompt={prompt} highlight={choosing ? highlight : -1} onPick={pick} onHover={setHighlight} onCancel={cancel} />
            ))}

          {working && (
            <div className="flex items-center gap-2.5 text-sm text-muted" role="status">
              <span className="flex gap-1">
                <span className="size-1.5 animate-pulse rounded-full bg-accent-ink" />
                <span className="size-1.5 animate-pulse rounded-full bg-accent-ink opacity-60 [animation-delay:150ms]" />
                <span className="size-1.5 animate-pulse rounded-full bg-accent-ink opacity-30 [animation-delay:300ms]" />
              </span>
              Working…
            </div>
          )}
        </div>
      </main>

      {choosing && prompt && (
        <div className="sticky bottom-0 z-10 hidden justify-center border-t border-line bg-surface px-4 py-3 text-[13px] text-muted lg:flex">
          ↑ ↓ to move · 1–{Math.min(prompt.options.length, 9)} to pick · Enter confirms · Esc cancels
        </div>
      )}
      <div className={`sticky bottom-0 z-10 justify-center border-t border-line bg-surface px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] ${choosing ? "hidden" : "flex"}`}>
        <div className="relative flex w-full max-w-[820px] flex-col gap-2">
          {!atBottom && (
            <button
              type="button"
              onClick={() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })}
              className="absolute -top-14 left-1/2 flex h-9 -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[13px] font-semibold shadow-fab"
            >
              <Icon d="M12 5v14M5 12l7 7 7-7" size={14} width={2.4} />
              Jump to bottom
            </button>
          )}
          <RunningTasks tasks={chat?.tasks ?? []} />
          {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Attached images">
              {attachments.map((a) => (
                <div key={a.id} className="relative size-16 overflow-hidden rounded-xl border border-line bg-inset">
                  <img src={a.preview} alt="Attached image" className={`size-full object-cover ${a.path ? "" : "opacity-50"}`} />
                  {!a.path && !a.error && <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold">Uploading…</span>}
                  {a.error && <span className="absolute inset-x-0 bottom-0 bg-danger px-1 text-center text-[10px] text-danger-ink">{a.error}</span>}
                  <button type="button" onClick={() => removeImage(a.id)} aria-label="Remove image" className="absolute top-1 right-1 flex size-6 cursor-pointer items-center justify-center rounded-full bg-inverse/80 text-inverse-ink">
                    <Icon d="M6 6l12 12M18 6L6 18" size={12} width={2.6} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            className="flex items-end gap-2.5"
          >
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addImages(e.target.files);
                e.target.value = "";
              }}
            />
            <button type="button" onClick={() => picker.current?.click()} aria-label="Attach image" title="Attach image" className="flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line text-muted hover:bg-sunken hover:text-ink">
              <Icon d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" size={20} />
            </button>
            <label htmlFor="chat-compose" className="sr-only">Message to the agent</label>
            <textarea
              id="chat-compose"
              ref={composer}
              rows={1}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
              }}
              onKeyDown={(e) => {
                // Enter sends on a keyboard; on a phone Enter is a new line and the button sends
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={`Message ${look.label}`}
              className="max-h-[180px] min-h-12 flex-1 resize-none rounded-[18px] border border-line bg-canvas px-4 py-3 text-base leading-[1.45] text-ink outline-none placeholder:text-muted focus:border-accent-ink"
            />
            {working && !draft.trim() && attachments.length === 0 ? (
              // while the agent works the send button becomes its stop button (Esc in Claude Code)
              <button type="button" onClick={stop} aria-label="Stop" title="Stop" className="flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-danger-line text-white">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button type="submit" disabled={(!draft.trim() && ready.length === 0) || sending || uploading} aria-label="Send" className="flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-white disabled:cursor-default disabled:opacity-50">
                <Icon d="M12 19V5M5 12l7-7 7 7" size={20} width={2.2} />
              </button>
            )}
          </form>
        </div>
      </div>
    </>
  );
}

/** a message from the person; `[image: …]` tokens of uploaded images show as thumbnails */
function UserBubble({ text, queued = false }: { text: string; queued?: boolean }) {
  const images: string[] = [];
  const words = text
    .replace(IMAGE_TOKEN, (token: string, _word: string, path: string) => {
      const name = UPLOAD_NAME.exec(path.trim())?.[1];
      if (name) {
        images.push(name);
        return "";
      }
      return token;
    })
    .trim();
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1.5 self-end">
      {images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {images.map((name) => (
            <a key={name} href={`/api/uploads/${name}`} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl border border-line">
              <img src={`/api/uploads/${name}`} alt="Sent image" loading="lazy" className="max-h-48 max-w-[240px] object-cover" />
            </a>
          ))}
        </div>
      )}
      {words && (
        <div className={`rounded-[18px_18px_6px_18px] px-4 py-3 text-base leading-[1.45] whitespace-pre-wrap [overflow-wrap:anywhere] ${queued ? "border border-dashed border-line bg-surface text-ink" : "bg-inverse text-inverse-ink"}`}>{words}</div>
      )}
    </div>
  );
}

function ChatEntry({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} />;
    case "assistant":
      return (
        <div className="hw-md text-base leading-[1.6] text-ink-soft [overflow-wrap:anywhere]">
          <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}>
            {item.text}
          </Markdown>
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "plan": {
      const done = item.items.filter((t) => t.status === "completed").length;
      return (
        <div className="flex flex-col gap-1.5 rounded-[14px] border border-line bg-surface px-4 py-3.5">
          <div className="text-[13px] font-semibold text-muted">Plan · {done} of {item.items.length}</div>
          {item.items.map((t, i) => (
            <div key={i} className={`flex items-start gap-2.5 text-sm ${t.status === "completed" ? "text-idle-dot line-through" : t.status === "in_progress" ? "font-semibold" : ""}`}>
              <span className={`mt-0.5 size-4 shrink-0 rounded-[5px] ${t.status === "completed" ? "bg-ok-dot" : t.status === "in_progress" ? "border-2 border-accent-ink" : "border-[1.5px] border-line"}`} />
              {t.text}
            </div>
          ))}
        </div>
      );
    }
    case "question":
      return (
        <div className="flex flex-col gap-2 rounded-[14px] border border-line bg-surface px-4 py-3.5">
          <div className="font-mono text-[11px] tracking-[0.12em] text-muted uppercase">Question</div>
          {item.questions.map((q, i) => (
            <div key={i} className="text-[15px] font-semibold">{q.question}</div>
          ))}
          {item.answer !== null ? <div className="text-sm text-muted">{item.answer}</div> : <div className="text-sm text-muted">Waiting for your answer…</div>}
        </div>
      );
    case "command":
      return (
        <div className="flex flex-col items-end gap-1.5">
          <div className="max-w-[85%] rounded-[18px_18px_6px_18px] bg-inverse px-4 py-2.5 font-mono text-[15px] text-inverse-ink">{item.command}</div>
          {item.output && <pre className="m-0 max-w-[85%] rounded-xl border border-line bg-surface px-3.5 py-2.5 font-mono text-xs leading-[1.6] whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{item.output}</pre>}
        </div>
      );
    case "divider":
      return (
        <div className="flex items-center gap-3 text-[12px] text-muted">
          <span className="h-px flex-1 bg-line" />
          {item.text}
          <span className="h-px flex-1 bg-line" />
        </div>
      );
  }
}

/** a tool call as an accordion: the header always, the command, output or diff on demand */
function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const diff = item.detail?.type === "diff" ? item.detail : null;
  // the summary shows the first line; the full command only when there is more to it
  const command = item.detail?.type === "command" && item.detail.command.trim() !== item.summary.trim() ? item.detail.command : null;
  const output = item.output?.replace(/\s+$/, "") ?? "";
  const hasBody = !!diff || !!command || !!output;
  const bodyId = `tool-${item.id}`;

  return (
    <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface">
      <button
        type="button"
        onClick={() => hasBody && setOpen(!open)}
        aria-expanded={hasBody ? open : undefined}
        aria-controls={hasBody ? bodyId : undefined}
        className={`flex min-h-11 items-center gap-2.5 px-3.5 py-2.5 text-left ${hasBody ? "cursor-pointer hover:bg-inset" : "cursor-default"}`}
      >
        <Icon d="M9 6l6 6-6 6" size={14} width={2.4} className={`shrink-0 text-muted transition-transform duration-150 ${open ? "rotate-90" : ""} ${hasBody ? "" : "opacity-0"}`} />
        <span className="shrink-0 rounded-md bg-tool px-2 py-[3px] font-mono text-[11px] font-semibold text-tool-ink">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{item.summary}</span>
        {diff && (
          <span className="shrink-0 font-mono text-xs">
            <span className="text-ok-ink">+{diff.added}</span> <span className="text-danger-ink">−{diff.removed}</span>
          </span>
        )}
        {item.state === "running" ? (
          <span className="shrink-0 text-xs text-muted">…</span>
        ) : item.state === "error" ? (
          <span className="shrink-0 text-xs text-danger-ink">error</span>
        ) : (
          !diff && <span className="shrink-0 text-xs text-ok-ink">done</span>
        )}
      </button>
      {open && hasBody && (
        <div id={bodyId} className="max-h-[60vh] overflow-auto border-t border-line">
          {command && <pre className="m-0 bg-inset px-3.5 py-2.5 font-mono text-xs leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">{command}</pre>}
          {diff && (
            <div className="font-mono text-xs leading-[1.75]">
              {diff.lines.map((l, i) =>
                l.op === "@" ? (
                  // a hunk starts: where in the file
                  <div key={i} className="border-y border-line bg-inset px-3.5 py-0.5 text-[11px] text-muted first:border-t-0">
                    line {l.text}
                  </div>
                ) : (
                  <div key={i} className={`px-3.5 whitespace-pre-wrap [overflow-wrap:anywhere] ${l.op === "-" ? "bg-danger text-danger-ink" : l.op === "+" ? "bg-ok text-ok-ink" : "text-muted"}`}>
                    {l.op === "-" ? "− " : l.op === "+" ? "+ " : "  "}
                    {l.text}
                  </div>
                ),
              )}
              {diff.truncated && <div className="px-3.5 py-1.5 text-muted">… (diff truncated)</div>}
            </div>
          )}
          {output && (
            <pre className={`m-0 bg-term px-3.5 py-3 font-mono text-xs leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere] ${item.state === "error" ? "text-[#fca5a5]" : "text-[#d6d3c9]"}`}>{output}</pre>
          )}
        </div>
      )}
    </div>
  );
}

const FREE_OPTION = /^type something/i;

interface MenuProps {
  prompt: PanePrompt;
  /** the keyboard's option, -1 when the menu is not taking keys */
  highlight: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  onCancel: () => void;
}

/** a question the agent asked (AskUserQuestion / question tool), answerable from here */
function QuestionPrompt({ prompt, question, highlight, onPick, onHover, onCancel }: MenuProps & { question: QuestionItem }) {
  const descriptions = new Map(question.questions.flatMap((q) => q.options.map((o) => [o.label, o.description] as const)));
  const title = question.questions.find((q) => prompt.title.includes(q.question.slice(0, 20)))?.question ?? prompt.title;
  return (
    <div role="listbox" aria-label={title} className="flex flex-col gap-3.5 rounded-[18px] bg-accent p-5 text-white">
      <div className="font-mono text-[11px] tracking-[0.12em] text-question-soft uppercase">Question</div>
      <div className="text-xl leading-tight font-bold tracking-[-0.01em]">{title}</div>
      <div className="flex flex-col gap-2">
        {prompt.options.map((label, i) => {
          const free = FREE_OPTION.test(label);
          const on = i === highlight;
          return (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onPick(i)}
              onMouseEnter={() => onHover(i)}
              className={`flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3 text-left ${free ? "border border-dashed border-question-line" : on ? "bg-white text-[#16161a]" : "border border-question-line bg-question-alt"} ${on ? "ring-2 ring-white ring-offset-2 ring-offset-accent" : ""}`}
            >
              <span className={`flex size-[26px] shrink-0 items-center justify-center rounded-[7px] font-mono text-xs ${on && !free ? "bg-[#16161a] text-white" : "bg-question-tile text-white"}`}>{i + 1}</span>
              <span className="flex flex-col gap-px">
                <span className="text-[15px] font-semibold">{free ? "Type another answer…" : label}</span>
                {descriptions.get(label) && <span className={`text-[13px] ${on && !free ? "text-[#66645c]" : "text-question-soft"}`}>{descriptions.get(label)}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <button type="button" onClick={onCancel} className="min-h-9 cursor-pointer self-start text-[13px] font-semibold text-question-soft underline">
        Cancel
      </button>
    </div>
  );
}

/** any other menu the agent waits on: a permission, the folder-trust prompt, a slash command's menu */
function ChoicePrompt({ prompt, highlight, onPick, onHover, onCancel }: MenuProps) {
  // a settings menu (many options, or label · description rows) reads better as a list than as chips
  const list = prompt.options.length > 4 || prompt.options.some((o) => o.includes(" · "));
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-ask-line bg-ask px-4 py-3.5">
      <span className="text-[15px] font-semibold">{prompt.title || "The agent is waiting for your decision"}</span>
      <div role="listbox" aria-label={prompt.title || "Options"} className={list ? "flex flex-col gap-1.5" : "flex flex-wrap gap-2"}>
        {prompt.options.map((option, i) => {
          const [label, ...rest] = option.split(" · ");
          const description = rest.join(" · ");
          const isCurrent = prompt.current === i;
          const on = i === highlight;
          const ring = on ? "ring-2 ring-accent-ink ring-offset-2 ring-offset-ask" : "";
          const number = i < 9 && <span className="font-mono text-xs text-muted">{i + 1}</span>;
          if (list) {
            return (
              <button
                key={i}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onPick(i)}
                onMouseEnter={() => onHover(i)}
                aria-current={isCurrent ? "true" : undefined}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border bg-surface px-3.5 py-2 text-left ${isCurrent ? "border-ink" : "border-line"} ${ring}`}
              >
                {number}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[15px] font-semibold">{label}</span>
                  {description && <span className="text-[13px] text-muted">{description}</span>}
                </span>
                {isCurrent && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-soft-ink">current</span>}
              </button>
            );
          }
          return (
            <button
              key={i}
              type="button"
              role="option"
              aria-selected={on}
              onClick={() => onPick(i)}
              onMouseEnter={() => onHover(i)}
              aria-current={isCurrent ? "true" : undefined}
              className={`flex min-h-10 max-w-full cursor-pointer items-center gap-2 rounded-full px-4 py-2 text-left text-sm font-semibold ${on ? "bg-inverse text-inverse-ink" : "border border-line bg-surface text-ink"} ${ring}`}
            >
              {i < 9 && <span className="font-mono text-xs opacity-60">{i + 1}</span>}
              {option}
              {isCurrent && <span className="opacity-70">✓</span>}
            </button>
          );
        })}
      </div>
      <button type="button" onClick={onCancel} className="min-h-9 cursor-pointer self-start text-[13px] font-semibold text-muted underline">
        Cancel
      </button>
    </div>
  );
}
