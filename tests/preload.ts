import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// config.ts resolves these once, at import time, and the first test file to import it wins:
// set them here so no test ever reads or writes the real sessions.json, auth.json or .env.
const dirs = { HERDR_PLUGIN_STATE_DIR: "hwv-state-", HERDR_PLUGIN_CONFIG_DIR: "hwv-config-" };
for (const [key, prefix] of Object.entries(dirs)) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env[key] = dir;
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
}
