import { expect, test } from "bun:test";
import { installIntegration, integrationStates, parseIntegrationStatus } from "./integrations.ts";
import type { Runner } from "./tunnel/run.ts";

const STATUS = `pi: not installed (/home/u/.pi/agent/extensions/herdr-agent-state.ts)
claude: current (v10) (/home/u/.claude/hooks/herdr-agent-state.sh)
codex: not installed (/home/u/.codex/herdr-agent-state.sh)
opencode: outdated (v11, current v13) (/home/u/.config/opencode/plugins/herdr-agent-state.js)
`;

test("herdr integration status: each agent's status and the file it installs", () => {
  const parsed = parseIntegrationStatus(STATUS);
  expect(parsed.get("claude")).toEqual({ status: "current (v10)", target: "/home/u/.claude/hooks/herdr-agent-state.sh" });
  expect(parsed.get("opencode")?.status).toBe("outdated (v11, current v13)");
  expect(parsed.get("pi")?.status).toBe("not installed");
});

test("only the chat's agents, and present only when their config folder exists", async () => {
  const calls: string[][] = [];
  const run: Runner = async (argv) => (calls.push(argv), { code: 0, stdout: STATUS.replace("outdated (v11, current v13)", "not installed"), stderr: "" });
  const states = await integrationStates(run, "/bin/herdr", (p) => p === "/home/u/.claude");
  expect(calls).toEqual([["/bin/herdr", "integration", "status"]]);
  expect(states.map((s) => [s.id, s.status, s.agentPresent])).toEqual([["claude", "current", true], ["opencode", "missing", false]]);
});

test("an older version counts as one to update; Herdr failing to answer is an error", async () => {
  const run: Runner = async () => ({ code: 0, stdout: STATUS, stderr: "" });
  expect((await integrationStates(run, "herdr", () => true)).find((s) => s.id === "opencode")?.status).toBe("outdated");
  const failing: Runner = async () => ({ code: 127, stdout: "", stderr: "herdr: command not found" });
  await expect(integrationStates(failing, "herdr", () => true)).rejects.toThrow("herdr: command not found");
});

test("install runs herdr integration install <agent> and reports its message", async () => {
  const ok: Runner = async (argv) => ({ code: 0, stdout: `installed ${argv[3]} integration hook\n`, stderr: "" });
  expect(await installIntegration(ok, "claude", "herdr")).toEqual({ ok: true, message: "installed claude integration hook" });
  const bad: Runner = async () => ({ code: 1, stdout: "", stderr: "error: the Claude config directory must already exist\n" });
  expect(await installIntegration(bad, "claude", "herdr")).toEqual({ ok: false, message: "error: the Claude config directory must already exist" });
});
