/**
 * OpenCode's model, variant (its effort) and usage for the chat header.
 *
 * OpenCode's model dialog marks the highlighted row only with colour, so it cannot be read like
 * Claude's menus: the web offers its own list (recent models from OpenCode's database) and the
 * server drives the dialog like a person would — `/models`, type the name in its search, Enter.
 * The variant cycles with ctrl+t; the prompt's footer (`Build · MiniMax-M3 MiniMax · thinking`)
 * shows the current one, so the server presses until the footer shows the chosen one.
 */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentUsage } from "../../shared/protocol.ts";
import type { Requester } from "../herdr/launch.ts";

type Raw = Record<string, unknown>;

export interface OpencodeModel {
  provider: string;
  model: string;
  /** as OpenCode's dialog shows it (and searches it) */
  name: string;
  providerName: string;
}

export interface OpencodeOptions {
  models: OpencodeModel[];
  /** null is OpenCode's default (no variant) */
  variants: (string | null)[];
  current: { model: string | null; variant: string | null };
}

/** models.dev catalogue OpenCode keeps in its cache: names, context limits, reasoning options */
export function opencodeCatalog(home: string): Raw {
  try {
    return JSON.parse(readFileSync(join(home, ".cache", "opencode", "models.json"), "utf8")) as Raw;
  } catch {
    return {};
  }
}

function catalogModel(catalog: Raw, provider: string, model: string): Raw | null {
  const models = ((catalog[provider] as Raw | undefined)?.["models"] ?? {}) as Raw;
  return (models[model] as Raw | undefined) ?? null;
}

/** recent models first (from OpenCode's own messages), the current one included */
export function recentOpencodeModels(db: Database, catalog: Raw, limit = 12): OpencodeModel[] {
  const rows = db
    .query("select json_extract(data,'$.providerID') p, json_extract(data,'$.modelID') m, max(time_created) t from message where json_extract(data,'$.role') = 'assistant' and json_extract(data,'$.modelID') is not null group by p, m order by t desc limit ?")
    .all(limit) as { p: string; m: string }[];
  return rows.map((r) => {
    const entry = catalogModel(catalog, r.p, r.m);
    const providerName = String(((catalog[r.p] as Raw | undefined)?.["name"] as string | undefined) ?? r.p);
    return { provider: r.p, model: r.m, name: String((entry?.["name"] as string | undefined) ?? r.m), providerName };
  });
}

/** the variants ctrl+t cycles through for a model, OpenCode's default (null) first */
export function opencodeVariants(catalog: Raw, provider: string, model: string): (string | null)[] {
  const options = (catalogModel(catalog, provider, model)?.["reasoning_options"] ?? []) as Raw[];
  const variants: (string | null)[] = [null];
  for (const option of options) {
    if (option["type"] === "effort" && Array.isArray(option["values"])) variants.push(...(option["values"] as string[]));
    else if (option["type"] === "toggle") variants.push("none", "thinking");
    else if (option["type"] === "budget_tokens") variants.push("high", "max");
  }
  return [...new Set(variants)];
}

/** `Build · MiniMax-M3 MiniMax (minimax.io) · thinking` → agent, model text, variant */
export function parseOpencodeFooter(screen: string): { agent: string; model: string; variant: string | null } | null {
  const line = screen
    .split("\n")
    .map((l) => l.replace(/^[\s┃│]+/, "").replace(/[\s┃│]+$/, ""))
    .filter((l) => /^[A-Z][\w-]* · \S/.test(l))
    .pop();
  if (!line) return null;
  const [agent, model, ...rest] = line.split(" · ");
  return { agent: agent!, model: model ?? "", variant: rest.length ? rest.join(" · ").trim() : null };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function screenOf(herdr: Requester, pane: string): Promise<string> {
  return (await herdr.request<{ read: { text: string } }>("pane.read", { pane_id: pane, source: "visible", strip_ansi: true })).read.text;
}

/** open /models, search the model's name, take the first match */
export async function setOpencodeModel(herdr: Requester, pane: string, name: string, wait = pause): Promise<void> {
  await herdr.request("pane.send_text", { pane_id: pane, text: "/models" });
  await wait(800);
  await herdr.request("pane.send_keys", { pane_id: pane, keys: ["enter"] });
  await wait(900);
  await herdr.request("pane.send_text", { pane_id: pane, text: name });
  await wait(600);
  await herdr.request("pane.send_keys", { pane_id: pane, keys: ["enter"] });
}

/** press ctrl+t until the footer shows `target` (null: no variant); false when it never does */
export async function setOpencodeVariant(herdr: Requester, pane: string, target: string | null, wait = pause, maxPresses = 8): Promise<boolean> {
  for (let i = 0; i <= maxPresses; i++) {
    const footer = parseOpencodeFooter(await screenOf(herdr, pane));
    if (!footer) return false;
    if (footer.variant === target) return true;
    if (i === maxPresses) return false;
    await herdr.request("pane.send_keys", { pane_id: pane, keys: ["ctrl+t"] });
    await wait(500);
  }
  return false;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** context share from the last answer, session and week cost; OpenCode knows no plan limits */
export function opencodeUsage(db: Database, catalog: Raw, sessionId: string, now = Date.now()): AgentUsage | null {
  const last = db.query("select data, time_created from message where session_id = ? and json_extract(data,'$.role') = 'assistant' order by time_created desc limit 1").get(sessionId) as { data: string; time_created: number } | null;
  if (!last) return null;
  const data = JSON.parse(last.data) as Raw;
  const tokens = (data["tokens"] ?? {}) as Raw;
  const cache = (tokens["cache"] ?? {}) as Raw;
  const used = [tokens["input"], cache["read"], cache["write"]].reduce<number>((sum, v) => sum + (typeof v === "number" ? v : 0), 0);
  const entry = catalogModel(catalog, String(data["providerID"] ?? ""), String(data["modelID"] ?? ""));
  const size = Number(((entry?.["limit"] ?? {}) as Raw)["context"] ?? 0);
  const session = db.query("select cost from session where id = ?").get(sessionId) as { cost: number } | null;
  const week = db.query("select coalesce(sum(cost), 0) c from session where time_updated >= ?").get(now - WEEK_MS) as { c: number };
  return {
    context: size > 0 ? { percent: Math.min(100, (used / size) * 100), used, size } : null,
    fiveHour: null,
    week: null,
    model: typeof data["modelID"] === "string" ? (entry?.["name"] as string | undefined) ?? (data["modelID"] as string) : null,
    effort: typeof data["variant"] === "string" ? (data["variant"] as string) : null,
    costUsd: session?.cost ?? null,
    weekCostUsd: week.c,
    updatedAt: last.time_created,
  };
}
