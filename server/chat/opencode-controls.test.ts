import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { opencodeUsage, opencodeVariants, parseOpencodeFooter, recentOpencodeModels, setOpencodeModel, setOpencodeVariant } from "./opencode-controls.ts";

const catalog = {
  minimax: { name: "MiniMax (minimax.io)", models: { "MiniMax-M3": { name: "MiniMax-M3", limit: { context: 1000000 }, reasoning_options: [{ type: "toggle" }] } } },
  openai: { name: "OpenAI", models: { "gpt-5": { name: "GPT-5", limit: { context: 400000 }, reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high"] }] } } },
};

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run("create table session (id text primary key, cost real, time_updated integer)");
  db.run("create table message (id text primary key, session_id text, time_created integer, data text)");
});
const msg = (id: string, sid: string, t: number, data: object) => db.run("insert into message values (?, ?, ?, ?)", [id, sid, t, JSON.stringify(data)]);

test("recent models, newest first, named from the catalogue", () => {
  msg("a", "s1", 1, { role: "assistant", providerID: "openai", modelID: "gpt-5" });
  msg("b", "s1", 2, { role: "assistant", providerID: "minimax", modelID: "MiniMax-M3" });
  msg("c", "s1", 3, { role: "user" });
  msg("d", "s1", 4, { role: "assistant", providerID: "ollama", modelID: "qwen3.8:27b-32k" });
  expect(recentOpencodeModels(db, catalog)).toEqual([
    { provider: "ollama", model: "qwen3.8:27b-32k", name: "qwen3.8:27b-32k", providerName: "ollama" },
    { provider: "minimax", model: "MiniMax-M3", name: "MiniMax-M3", providerName: "MiniMax (minimax.io)" },
    { provider: "openai", model: "gpt-5", name: "GPT-5", providerName: "OpenAI" },
  ]);
});

test("variants by reasoning option", () => {
  expect(opencodeVariants(catalog, "minimax", "MiniMax-M3")).toEqual([null, "none", "thinking"]);
  expect(opencodeVariants(catalog, "openai", "gpt-5")).toEqual([null, "minimal", "low", "medium", "high"]);
  expect(opencodeVariants(catalog, "x", "y")).toEqual([null]);
});

test("the prompt footer", () => {
  const screen = "\n  ┃  hola\n  ┃\n  ┃  Build · MiniMax-M3 MiniMax (minimax.io) · thinking\n  ╹▀▀▀▀\n   tab agents  ctrl+p commands\n";
  expect(parseOpencodeFooter(screen)).toEqual({ agent: "Build", model: "MiniMax-M3 MiniMax (minimax.io)", variant: "thinking" });
  expect(parseOpencodeFooter("  ┃  Plan · GPT-5 OpenAI\n")).toEqual({ agent: "Plan", model: "GPT-5 OpenAI", variant: null });
  expect(parseOpencodeFooter("nada")).toBeNull();
});

function fakePane(variants: (string | null)[]) {
  let at = 0;
  const calls: string[] = [];
  return {
    calls,
    herdr: {
      async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        calls.push(method === "pane.send_keys" ? `keys:${(params["keys"] as string[]).join("+")}` : method === "pane.send_text" ? `text:${params["text"]}` : method);
        if (method === "pane.send_keys" && (params["keys"] as string[])[0] === "ctrl+t") at = (at + 1) % variants.length;
        const v = variants[at];
        return { read: { text: `┃  Build · MiniMax-M3 MiniMax${v ? ` · ${v}` : ""}` } } as T;
      },
    },
  };
}

test("ctrl+t until the footer shows the variant; gives up on one that never comes", async () => {
  const p = fakePane(["thinking", null, "none"]);
  expect(await setOpencodeVariant(p.herdr, "w1:p1", "none", async () => {})).toBe(true);
  expect(p.calls.filter((c) => c === "keys:ctrl+t")).toHaveLength(2);
  expect(await setOpencodeVariant(fakePane(["thinking", null]).herdr, "w1:p1", "max", async () => {}, 4)).toBe(false);
});

test("choosing a model drives the dialog: /models, search, Enter", async () => {
  const p = fakePane([null]);
  await setOpencodeModel(p.herdr, "w1:p1", "GPT-5", async () => {});
  expect(p.calls).toEqual(["text:/models", "keys:enter", "text:GPT-5", "keys:enter"]);
});

test("usage: context from the last answer, session and week cost", () => {
  db.run("insert into session values ('s1', 0.5, 100), ('s2', 1.25, 100), ('old', 9, 1)");
  msg("a", "s1", 50, { role: "assistant", providerID: "minimax", modelID: "MiniMax-M3", variant: "thinking", tokens: { input: 20000, cache: { read: 30000, write: 0 } } });
  expect(opencodeUsage(db, catalog, "s1", 200)).toEqual({
    context: { percent: 5, used: 50000, size: 1000000 },
    fiveHour: null,
    week: null,
    model: "MiniMax-M3",
    effort: "thinking",
    costUsd: 0.5,
    weekCostUsd: 1.75 + 9,
    updatedAt: 50,
  });
  expect(opencodeUsage(db, catalog, "nobody")).toBeNull();
});
