/**
 * The Herdr Web Service server: static app + JSON API + WebSocket, all behind one password.
 *
 * Open routes: GET /api/health (liveness), GET /api/session, POST /api/auth/login. Everything else
 * under /api and /ws needs a session cookie. Every request first passes the access policy in
 * access.ts (Host, Origin, login transport) and every response carries its security headers. Static files are served to anyone (the app itself is not secret;
 * every piece of data it shows comes through the gated API).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ChatResponse, PanePrompt, Roster, ServerFrame, SessionInfo } from "../shared/protocol.ts";
import { passwordConfigured, verifyPassword } from "./auth/password.ts";
import { handleLogin } from "./auth/login.ts";
import { clearedSessionCookie, createSession, revokeSession, sessionAlive, sessionCookie, sessionFromRequest } from "./auth/sessions.ts";
import { clientAddress, factsFrom, hostAllowed, isSecure, loginTransportAllowed, originAllowed, securityHeaders, type AccessConfig, type RequestFacts } from "./access.ts";
import { STATE_DIR, config } from "./config.ts";
import { HerdrClient, HerdrError } from "./herdr/client.ts";
import { buildRoster, type StatusMemory } from "./herdr/roster.ts";
import { launchSession, parseNewSession, readyPrompts } from "./herdr/launch.ts";
import { paneIdFrom, parsePaneInput } from "./herdr/panes.ts";
import { listDirs } from "./fsbrowse.ts";
import { MAX_UPLOAD, cleanupUploads, saveUpload, uploadPath } from "./uploads.ts";
import { locateTranscript, readChat } from "./chat/store.ts";
import { keysToChoose, parsePrompt } from "./chat/prompt.ts";
import { locateOpencodeSession, opencodeDb, readOpencodeChat } from "./chat/opencode.ts";
import { readClaudeStatus } from "./chat/usage.ts";
import { opencodeCatalog, opencodeUsage, opencodeVariants, recentOpencodeModels, setOpencodeModel, setOpencodeVariant } from "./chat/opencode-controls.ts";
import { apiError, isRegularFile, json, withHeaders } from "./http.ts";
import { socketsOfSession, staleSockets } from "./ws.ts";

const herdr = new HerdrClient(config.herdrSocket);
const access: AccessConfig = { mode: config.accessMode, publicUrl: config.publicUrl, host: config.host, port: config.port, devOrigin: config.devOrigin };

const statusMemory: StatusMemory = new Map();

async function loadRoster(): Promise<Roster> {
  const result = await herdr.request<{ snapshot: { workspaces?: unknown; tabs?: unknown; panes?: unknown } }>("session.snapshot");
  return buildRoster(result.snapshot ?? {}, statusMemory, Date.now(), homedir());
}

// --- live roster: one Herdr subscription fans out to every browser -------------------------

type WsData = { sessionId: string };
const clients = new Set<import("bun").ServerWebSocket<WsData>>();
let unsubscribe: (() => void) | null = null;
let rosterTimer: ReturnType<typeof setTimeout> | null = null;
/** the last roster sent; pane.updated fires on every title tick, most reads change nothing */
let lastRoster = "";
/** a new browser needs the roster even when it did not change */
let forceRoster = false;

function broadcast(frame: ServerFrame): void {
  const text = JSON.stringify(frame);
  for (const ws of clients) ws.send(text);
}

/** coalesce bursts of events into one snapshot read */
function scheduleRoster(force = false): void {
  forceRoster ||= force;
  if (rosterTimer) return;
  rosterTimer = setTimeout(async () => {
    rosterTimer = null;
    try {
      const roster = await loadRoster();
      for (const prompt of readyPrompts(roster)) {
        herdr.request("agent.prompt", { target: prompt.pane_id, text: prompt.text }).catch((error) => console.error("first message:", error instanceof Error ? error.message : error));
      }
      const text = JSON.stringify(roster);
      if (text === lastRoster && !forceRoster) return;
      lastRoster = text;
      forceRoster = false;
      broadcast({ type: "roster", roster });
    } catch (error) {
      lastRoster = "";
      broadcast({ type: "herdr", connected: false });
      console.error("roster:", error instanceof Error ? error.message : error);
    }
  }, 150);
}

async function ensureSubscribed(): Promise<void> {
  if (unsubscribe) return;
  // pane.updated carries agent_status changes; pane.agent_status_changed needs a pane_id, so a
  // global subscription to it is refused and takes the whole subscription down with it
  const subscriptions = ["pane.created", "pane.closed", "pane.updated", "pane.agent_detected", "pane.focused", "workspace.created", "workspace.closed", "workspace.renamed"].map((type) => ({ type }));
  try {
    unsubscribe = await HerdrClient.subscribe(config.herdrSocket, subscriptions, () => scheduleRoster(), (reason) => {
      unsubscribe = null;
      console.error(`herdr subscription closed (${reason}); retrying`);
      broadcast({ type: "herdr", connected: false });
      setTimeout(() => void ensureSubscribed().then(() => scheduleRoster(true)), 2000);
    });
    broadcast({ type: "herdr", connected: true });
  } catch (error) {
    console.error("herdr subscribe:", error instanceof Error ? error.message : error);
    setTimeout(() => void ensureSubscribed(), 5000);
  }
}

// --- HTTP ----------------------------------------------------------------------------------

/** H7: Herdr's state is only disclosed to a signed-in browser. */
async function sessionInfo(request: Request): Promise<SessionInfo> {
  const info: SessionInfo = { authenticated: sessionFromRequest(request) !== null, setup_required: !passwordConfigured() };
  if (!info.authenticated) return info;
  let connected = false;
  try {
    await herdr.request("ping");
    connected = true;
  } catch {
    connected = false;
  }
  return { ...info, herdr: { connected }, access: { mode: config.accessMode, url: config.publicUrl || null } };
}

function staticHeaders(path: string): Record<string, string> {
  if (path.startsWith("/assets/")) return { "cache-control": "public, max-age=31536000, immutable" };
  // the service worker and manifest must be re-checked so updates reach installed apps
  if (path === "/sw.js") return { "cache-control": "no-cache", "content-type": "text/javascript; charset=utf-8" };
  if (path.endsWith(".webmanifest")) return { "cache-control": "no-cache", "content-type": "application/manifest+json" };
  return {};
}

function staticFile(pathname: string): Response | null {
  if (!existsSync(config.distDir)) return null;
  const clean = pathname === "/" ? "/index.html" : pathname;
  const candidate = join(config.distDir, clean);
  if (!candidate.startsWith(config.distDir)) return null;
  if (isRegularFile(candidate)) return new Response(Bun.file(candidate), { headers: staticHeaders(clean) });
  // SPA fallback (also for directories such as /assets)
  const index = join(config.distDir, "index.html");
  return isRegularFile(index) ? new Response(Bun.file(index)) : null;
}

async function route(request: Request, facts: RequestFacts, server: import("bun").Server<WsData>): Promise<Response | undefined> {
  const { path: pathname, method } = facts;
  if (!hostAllowed(facts, access)) return apiError("invalid_host", "unexpected Host header", 421);
  if ((method !== "GET" && method !== "HEAD") || pathname === "/ws") {
    if (!originAllowed(facts, access)) return apiError("invalid_origin", "cross-origin request refused", 403);
  }

  if (pathname === "/api/health") return json({ ok: true, version: "0.1.0" });
  if (pathname === "/api/auth/login" && method === "POST") {
    if (!loginTransportAllowed(facts, access)) return apiError("insecure_transport", "sign in over HTTPS", 403);
    const secure = isSecure(facts);
    return handleLogin(request, clientAddress(facts), {
      configured: passwordConfigured,
      verify: verifyPassword,
      startSession: (req, address, remember) => sessionCookie(createSession(req, address).token, secure, remember),
    });
  }
  if (pathname === "/api/session") return json(await sessionInfo(request));

  if (pathname.startsWith("/api/") || pathname === "/ws") {
    const session = sessionFromRequest(request);
    if (!session) return apiError("unauthorized", passwordConfigured() ? "sign in" : "run setup first", 401);

    if (pathname === "/api/auth/logout" && method === "POST") {
      revokeSession(session.id_hash);
      for (const ws of socketsOfSession(clients, session.id_hash)) ws.close(1008, "signed out");
      return new Response(null, { status: 204, headers: { "set-cookie": clearedSessionCookie() } });
    }
    if (pathname === "/ws") {
      if (server.upgrade(request, { data: { sessionId: session.id_hash } })) return undefined;
      return apiError("upgrade_failed", "expected a WebSocket", 400);
    }
    try {
      return (await herdrRoute(request, pathname, method)) ?? apiError("not_found", "no such route", 404);
    } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") return apiError("pane_not_found", "that session is closed", 404);
      const code = error instanceof HerdrError ? error.code : "herdr_unavailable";
      return apiError(code, error instanceof Error ? error.message : String(error), 502);
    }
  }

  return staticFile(pathname) ?? apiError("not_built", "run `bun run build` first", 503);
}

/** what the header's model and effort buttons offer for an OpenCode pane */
async function opencodeOptions(paneId: string): Promise<{ models: ReturnType<typeof recentOpencodeModels>; variants: (string | null)[]; current: { model: string | null; variant: string | null } }> {
  const { pane } = await herdr.request<{ pane: PaneInfo }>("pane.get", { pane_id: paneId });
  const db = opencodeDb(homedir());
  if (pane.agent !== "opencode" || !db || !pane.cwd) return { models: [], variants: [null], current: { model: null, variant: null } };
  const catalog = opencodeCatalog(homedir());
  const models = recentOpencodeModels(db, catalog);
  const session = locateOpencodeSession(db, { cwd: pane.cwd, session: pane.agent_session ?? null });
  const last = session
    ? (db.query("select json_extract(data,'$.providerID') p, json_extract(data,'$.modelID') m, json_extract(data,'$.variant') v from message where session_id = ? and json_extract(data,'$.role') = 'assistant' order by time_created desc limit 1").get(session.id) as { p: string; m: string; v: string | null } | null)
    : null;
  const current = last ?? (models[0] ? { p: models[0].provider, m: models[0].model, v: null } : null);
  return {
    models,
    variants: current ? opencodeVariants(catalog, current.p, current.m) : [null],
    current: { model: current?.m ?? null, variant: current?.v ?? null },
  };
}

async function currentPrompt(paneId: string): Promise<PanePrompt | null> {
  const screen = await herdr.request<{ read: { text: string } }>("pane.read", { pane_id: paneId, source: "visible", strip_ansi: true });
  return parsePrompt(screen.read.text);
}

type PaneInfo = { cwd?: string; agent?: string | null; agent_status?: string; agent_session?: { kind: string; value: string } | null };

/** the pane's Claude conversation (unchanged when `version` still matches) and its open menu */
async function chatOfPane(paneId: string, version: string | null): Promise<ChatResponse> {
  const { pane } = await herdr.request<{ pane: PaneInfo }>("pane.get", { pane_id: paneId });
  // a menu (permission, question, a slash command's) only shows while the agent is not working
  const prompt = pane.agent_status !== "working" ? await currentPrompt(paneId).catch(() => null) : null;
  if (!pane.cwd) return { chat: null, prompt };
  const ref = { cwd: pane.cwd, session: pane.agent_session ?? null };
  if (pane.agent === "opencode") {
    const db = opencodeDb(homedir());
    const session = db && locateOpencodeSession(db, ref);
    if (!db || !session) return { chat: null, prompt };
    const snapshot = readOpencodeChat(db, session.id, homedir());
    if (version && version === snapshot.version) return { chat: null, unchanged: true, prompt };
    const usage = opencodeUsage(db, opencodeCatalog(homedir()), session.id);
    return { chat: { ...snapshot, usage, source: session.source }, prompt };
  }
  if (pane.agent !== "claude") return { chat: null, prompt };
  const found = locateTranscript(ref, homedir());
  if (!found) return { chat: null, prompt };
  const snapshot = await readChat(found.path, homedir());
  // the status line rewrites its file on its own schedule: its time joins the version
  const usage = readClaudeStatus(STATE_DIR, basename(found.path, ".jsonl"));
  const full = `${snapshot.version}:${usage?.updatedAt ?? 0}`;
  if (version && version === full) return { chat: null, unchanged: true, prompt };
  return { chat: { ...snapshot, version: full, usage, source: found.source }, prompt };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** signed-in routes that read or drive Herdr; null when no route matches */
async function herdrRoute(request: Request, pathname: string, method: string): Promise<Response | null> {
  if (pathname === "/api/roster" && method === "GET") return json(await loadRoster());
  if (pathname === "/api/fs" && method === "GET") {
    const listing = listDirs(new URL(request.url).searchParams.get("path") ?? "~", homedir());
    return listing.ok ? json(listing) : apiError("folder_not_found", listing.error, 404);
  }
  if (pathname === "/api/sessions" && method === "POST") {
    const parsed = parseNewSession(await readJson(request), homedir());
    if (!parsed.ok) return apiError("invalid_session", parsed.error, 400);
    const created = await launchSession(herdr, parsed.value, await loadRoster(), homedir());
    scheduleRoster(true);
    return json(created, 201);
  }
  const screenOf = paneIdFrom(pathname, "screen");
  if (screenOf && method === "GET") {
    const result = await herdr.request<{ read: { text: string } }>("pane.read", { pane_id: screenOf, source: "visible", strip_ansi: true });
    return json({ text: result.read.text });
  }
  const inputTo = paneIdFrom(pathname, "input");
  if (inputTo && method === "POST") {
    const parsed = parsePaneInput(await readJson(request));
    if (!parsed.ok) return apiError("invalid_input", parsed.error, 400);
    await herdr.request("pane.send_input", { pane_id: inputTo, ...(parsed.value.text ? { text: parsed.value.text } : {}), keys: parsed.value.keys });
    return new Response(null, { status: 204 });
  }
  // images for the agent: uploaded raw, kept in the temp folder, shown back by name
  if (pathname === "/api/uploads" && method === "POST") {
    if (Number(request.headers.get("content-length") ?? 0) > MAX_UPLOAD) return apiError("too_large", "images up to 10 MB", 413);
    const saved = saveUpload(new Uint8Array(await request.arrayBuffer()));
    if (!saved.ok) return apiError(saved.error, saved.error === "too_large" ? "images up to 10 MB" : "PNG, JPEG, GIF or WebP only", saved.error === "too_large" ? 413 : 415);
    return json({ name: saved.name, path: saved.path, type: saved.type, size: saved.size }, 201);
  }
  const uploadName = /^\/api\/uploads\/([^/]+)$/.exec(pathname)?.[1];
  if (uploadName && method === "GET") {
    const found = uploadPath(uploadName);
    if (!found) return apiError("not_found", "no such image", 404);
    return new Response(Bun.file(found.path), { headers: { "content-type": found.type, "cache-control": "private, max-age=86400" } });
  }
  const chatOf = paneIdFrom(pathname, "chat");
  if (chatOf && method === "GET") return json(await chatOfPane(chatOf, new URL(request.url).searchParams.get("v")));
  const promptTo = paneIdFrom(pathname, "prompt");
  if (promptTo && method === "POST") {
    const body = (await readJson(request)) as { text?: unknown } | undefined;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 20_000) return apiError("invalid_input", "text is required", 400);
    // Herdr's agent.prompt refuses slash commands: those are typed into the pane like at the keyboard
    if (text.startsWith("/")) await herdr.request("pane.send_input", { pane_id: promptTo, text, keys: ["enter"] });
    else await herdr.request("agent.prompt", { target: promptTo, text });
    return new Response(null, { status: 204 });
  }
  const chooseIn = paneIdFrom(pathname, "choose");
  if (chooseIn && method === "POST") {
    const body = (await readJson(request)) as { index?: unknown } | undefined;
    // read the menu again now: the answer is relative to what the terminal shows this moment
    const prompt = await currentPrompt(chooseIn);
    const keys = prompt && keysToChoose(prompt, Number(body?.index));
    if (!keys) return apiError("no_prompt", "nothing to choose right now", 409);
    await herdr.request("pane.send_keys", { pane_id: chooseIn, keys });
    return new Response(null, { status: 204 });
  }
  // OpenCode's model and variant (its effort), driven through its own dialog and ctrl+t
  const modelsOf = paneIdFrom(pathname, "models");
  if (modelsOf && method === "GET") return json(await opencodeOptions(modelsOf));
  const modelOf = paneIdFrom(pathname, "model");
  if (modelOf && method === "POST") {
    const body = (await readJson(request)) as { provider?: unknown; model?: unknown } | undefined;
    const options = await opencodeOptions(modelOf);
    const pick = options.models.find((m) => m.provider === body?.provider && m.model === body?.model);
    if (!pick) return apiError("invalid_model", "not one of the offered models", 400);
    await setOpencodeModel(herdr, modelOf, pick.name);
    return new Response(null, { status: 204 });
  }
  const variantOf = paneIdFrom(pathname, "variant");
  if (variantOf && method === "POST") {
    const body = (await readJson(request)) as { variant?: unknown } | undefined;
    const options = await opencodeOptions(variantOf);
    const target = body?.variant ?? null;
    if (target !== null && typeof target !== "string") return apiError("invalid_variant", "variant must be a string or null", 400);
    if (!options.variants.includes(target)) return apiError("invalid_variant", "not a variant of this model", 400);
    const ok = await setOpencodeVariant(herdr, variantOf, target);
    return ok ? new Response(null, { status: 204 }) : apiError("variant_not_reached", "OpenCode did not take that variant", 409);
  }
  const closeOf = paneIdFrom(pathname, "close");
  if (closeOf && method === "POST") {
    await herdr.request("pane.close", { pane_id: closeOf });
    scheduleRoster(true);
    return new Response(null, { status: 204 });
  }
  return null;
}

function internalError(): Response {
  return apiError("internal", "internal error", 500);
}

const server = Bun.serve<WsData>({
  hostname: config.host,
  port: config.port,
  // never render Bun's development error page (stack and source) to a client
  development: false,
  // the largest thing a browser sends is an image (10 MB); nothing needs more
  maxRequestBodySize: MAX_UPLOAD + 1024 * 1024,
  async fetch(request, server) {
    const facts = factsFrom(request, server.requestIP(request)?.address ?? null);
    let response: Response | undefined;
    try {
      response = await route(request, facts, server);
    } catch (error) {
      console.error("request failed:", error);
      response = internalError();
    }
    return response && withHeaders(response, securityHeaders(isSecure(facts)));
  },
  // backstop for anything thrown outside route(); facts are unknown here, so no HSTS
  error(error) {
    console.error("server error:", error);
    return withHeaders(internalError(), securityHeaders(false));
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      void ensureSubscribed();
      scheduleRoster(true);
    },
    message(ws, message) {
      if (String(message) === '{"type":"refresh"}') scheduleRoster(true);
      else ws.close(1003, "unknown frame");
    },
    close(ws) {
      clients.delete(ws);
    },
  },
});

// uploaded images older than a week go, even where the system never cleans its temp folder
cleanupUploads();
setInterval(() => cleanupUploads(), 3600_000);

// a socket outlives neither its session's expiry nor a revocation from elsewhere
const SWEEP_MS = 60_000;
setInterval(() => {
  for (const ws of staleSockets(clients, sessionAlive)) ws.close(1008, "session expired");
}, SWEEP_MS);

console.log(`herdr-web-service listening on http://${server.hostname}:${server.port} (herdr socket: ${config.herdrSocket})`);
if (config.host !== "127.0.0.1" && !passwordConfigured()) {
  console.warn("WARNING: bound to a non-loopback address with no password configured; the API refuses everything until setup runs");
}
