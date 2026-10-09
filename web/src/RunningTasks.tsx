import { useState } from "react";
import type { RunningTask } from "../../shared/protocol.ts";
import { Ago } from "./Ago.tsx";
import { Icon } from "./Home.tsx";

/** remembered per browser: whether the list is open */
const OPEN_KEY = "herdr-web.tasks-open";

const KIND: Record<RunningTask["kind"], { name: string; icon: string }> = {
  agent: { name: "subagent", icon: "M12 3l2.2 5.3L20 10.5l-5.8 2.2L12 18l-2.2-5.3L4 10.5l5.8-2.2z" },
  command: { name: "command", icon: "M5 17l5-5-5-5M13 18h6" },
  monitor: { name: "monitor", icon: "M3 12h4l3-7 4 14 3-7h4" },
};

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* private mode: it opens closed next time */
  }
}

/** how a task relates to the agent's turn, and what is behind it */
export function taskLine(task: RunningTask): string {
  const detail = task.detail !== task.label ? task.detail : null;
  return [KIND[task.kind].name, task.background ? "in the background" : "the agent waits for it", detail].filter(Boolean).join(" · ");
}

/**
 * Above the composer: what the agent left running (subagents, background commands, monitors), so a
 * "Working…" that never ends, or an idle agent with work still going, explains itself. Hidden
 * while nothing runs; the list opens from the tab and stays open or closed per browser.
 */
export function RunningTasks({ tasks }: { tasks: RunningTask[] }) {
  const [open, setOpen] = useState(loadOpen);
  if (tasks.length === 0) return null;
  const toggle = () => {
    setOpen(!open);
    saveOpen(!open);
  };
  return (
    <section aria-label="Running tasks" className="overflow-hidden rounded-2xl border border-line bg-canvas">
      <button type="button" onClick={toggle} aria-expanded={open} aria-controls="running-tasks" className="flex min-h-10 w-full cursor-pointer items-center gap-2.5 px-3.5 py-2 text-left text-[13px]">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-ok-dot" />
        <span className="shrink-0 font-semibold">{tasks.length} running</span>
        <span className="min-w-0 flex-1 truncate text-muted">{open ? "" : tasks.map((t) => t.label).join(" · ")}</span>
        <Icon d="M6 9l6 6 6-6" size={14} width={2.2} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul id="running-tasks" className="flex max-h-60 flex-col overflow-y-auto border-t border-line px-2 py-1.5">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start gap-2.5 rounded-xl px-1.5 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sunken text-muted" title={KIND[task.kind].name}>
                <Icon d={KIND[task.kind].icon} size={15} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold">{task.label}</span>
                <span className="truncate font-mono text-[11.5px] text-muted">{taskLine(task)}</span>
                {task.last_event && <span className="truncate text-[12.5px] text-muted">Last event: {task.last_event}</span>}
              </span>
              {task.started_at && <Ago at={Date.parse(task.started_at)} className="shrink-0 pt-0.5 font-mono text-[11px] text-muted" />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
