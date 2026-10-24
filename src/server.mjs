// HTTP server: routing plus the guards that keep a localhost agent runner from being driven by web pages.

import { stopBrowser } from "./browser/browser.mjs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { cfg, ROOT, isLoopback, baseUrl } from "./config.mjs";
import { langOf, T } from "./lang.mjs";
import { BACKENDS, initBackends, pickBackend } from "./backends/index.mjs";
import { describeModels, refreshModelDetails } from "./backends/models.mjs";
import { acquire, release, gateStatus, killAll } from "./runner.mjs";
import { killAllPanelProcs } from "./panels/exec.mjs";
import { readJson, sendJson, httpError } from "./http.mjs";
import { optsFrom, validateOpts } from "./compat/common.mjs";
import { openaiChat } from "./compat/openai.mjs";
import { anthropicMessages } from "./compat/anthropic.mjs";
import { canvasRoutes, historyRoutes } from "./routes/canvas.mjs";
import { listClaudeSessions } from "./canvas/claude-sessions.mjs";
import { accountRoutes, usageRoutes } from "./routes/accounts.mjs";
import { connectionRoutes } from "./routes/connections.mjs";
import { toolboxRoutes } from "./routes/toolbox.mjs";
import { stopAllLogins, cleanDrafts } from "./accounts.mjs";
import { mcpRoute } from "./mcp/server.mjs";
import { agentByToken } from "./canvas/canvas.mjs";
import { handleUpgrade } from "./term/ws.mjs";
import { loadCanvases, closeCanvases, checkDir, allCanvases } from "./canvas/canvas.mjs";
import { resetAll } from "./reset.mjs";
import { repoInfo, checkout } from "./git.mjs";

const UI_DIR = join(ROOT, "ui");
// the code editor of the IDE dock, served from its npm package (it's large, and unmodified)
const MONACO_DIR = join(ROOT, "node_modules", "monaco-editor", "min");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".map": "application/json", ".svg": "image/svg+xml", ".ttf": "font/ttf" };

// Serves files under ui/ (or Monaco's directory) only; normalize + prefix check keeps "../" out.
function serveUi(res, rel, dir = UI_DIR, cache = "no-cache") {
  const file = normalize(join(dir, rel));
  if (!file.startsWith(dir + "/") || !TYPES[extname(file)] || !existsSync(file)) return false;
  res.writeHead(200, { "content-type": TYPES[extname(file)], "cache-control": cache });
  res.end(readFileSync(file));
  return true;
}

function authorized(req) {
  if (!cfg.token) return true;
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = bearer || req.headers["x-api-key"] || "";
  if (typeof a !== "string" || !a) return false;
  // constant-time compare so token length/content doesn't leak through timing
  const ab = Buffer.from(a), tb = Buffer.from(cfg.token);
  return ab.length === tb.length && timingSafeEqual(ab, tb);
}

// A web page can reach 127.0.0.1 (directly, or by DNS rebinding a hostname to it). Since requests
// can make agents edit files and run commands, accept only our own Host and same-origin browsers.
function guard(req) {
  if (!cfg.allowRemote) {
    const allowed = ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${cfg.port}`);
    if (!allowed.includes(req.headers.host)) return [403, "forbidden host"];
    const origin = req.headers.origin;
    if (origin && !allowed.some((h) => origin === `http://${h}`)) return [403, "forbidden origin"];
  }
  // an image pasted into a chat goes up as itself; like JSON, an image type can't be sent cross-site without a preflight
  const image = /\/attachments$/.test((req.url || "").split("?")[0]) && /^image\/(png|jpeg|gif|webp)\b/i.test(req.headers["content-type"] || "");
  if (["POST", "PUT", "PATCH"].includes(req.method) && !image && !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
    return [415, "content-type must be application/json"];
  }
}

// the engine's code as it was when this server started: the newest change under src/. The app compares it
// with the code on disk and offers a restart when the engine is older (a server left running across updates).
function newestChange(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestChange(p));
    else if (/\.(mjs|js|py)$/.test(e.name)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}
const CODE = newestChange(fileURLToPath(new URL(".", import.meta.url)));
const STARTED = Date.now();

async function handle(req, res) {
  const blocked = guard(req);
  if (blocked) return sendJson(res, blocked[0], { error: { message: blocked[1] } });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, "");

  // one agent's IDE filling the window (the native app's web view); the page reads the ids from the path
  if (req.method === "GET" && /^\/ide\/[\w-]+\/[\w-]+$/.test(path)) return serveUi(res, "ide.html");
  if (req.method === "GET" && path.startsWith("/ui/") && serveUi(res, path.slice(4))) return;
  if (req.method === "GET" && path.startsWith("/vendor/monaco/") && serveUi(res, path.slice(15), MONACO_DIR, "max-age=86400")) return;
  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, { ok: true, code: CODE, startedAt: STARTED, backends: Object.fromEntries(BACKENDS.map((b) => [b.name, gateStatus(b)])) });
  }
  // the per-agent token in the path is the credential, so MCP clients need no TAKSIM_TOKEN
  const mcp = path.match(/^\/mcp\/([\w-]+)$/);
  if (mcp) return mcpRoute(req, res, mcp[1]);

  // turn start/stop from a terminal agent's CLI hooks; the agent token is the credential
  const hook = path.match(/^\/hooks\/([\w-]+)\/(ready|start|stop)$/);
  // a CLI's pre-tool hook asking whether a tool call may run: the person answers in the chat (headless turns)
  const ask = path.match(/^\/hooks\/([\w-]+)\/permission$/);
  if (ask && req.method === "POST") {
    const agent = agentByToken(ask[1]);
    if (!agent) return sendJson(res, 404, { error: { message: "unknown hook token" } });
    return sendJson(res, 200, await agent.workflow.approve(await readJson(req).catch(() => ({}))));
  }
  if (hook && req.method === "POST") {
    const agent = agentByToken(hook[1]);
    if (!agent) return sendJson(res, 404, { error: { message: "unknown hook token" } });
    agent.onHook(hook[2], await readJson(req).catch(() => ({})));
    return sendJson(res, 200, { ok: true });
  }

  if (!authorized(req)) return sendJson(res, 401, { error: { message: "unauthorized" } });

  // the app's "↻": stop as on SIGTERM (canvases saved, CLIs and panel commands stopped); the app starts a new one
  // NOTE: after authorized() — restarting stops every agent, so it needs the token.
  if (req.method === "POST" && path === "/v1/restart") {
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 100);
    return;
  }

  // the app's "reset": as freshly installed (canvases, named accounts, connections, usage, tools)
  if (req.method === "POST" && path === "/v1/reset") return sendJson(res, 200, await resetAll());

  if (req.method === "GET" && path === "/v1/models") {
    return sendJson(res, 200, { object: "list", data: describeModels(langOf(req)) });
  }

  if (path.startsWith("/v1/usage") && await usageRoutes(req, res, path) !== false) return;

  if (path.startsWith("/v1/connections")) {
    try {
      if (await connectionRoutes(req, res, path) !== false) return;
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { message: e.message } });
    }
  }

  if (path.startsWith("/v1/accounts")) {
    try {
      if (await accountRoutes(req, res, path) !== false) return;
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { message: e.message } });
    }
  }

  // the folder picker outside the desktop app (which has its own): macOS's choose-folder dialog
  if (req.method === "POST" && path === "/v1/pick-folder") {
    const { start } = await readJson(req).catch(() => ({}));
    return sendJson(res, 200, { path: await pickFolder(start, langOf(req)) });
  }

  // the folder picker's "switch this folder to that branch": POST /v1/git/checkout {dir, branch}
  if (req.method === "POST" && path === "/v1/git/checkout") {
    try {
      const body = await readJson(req).catch(() => ({}));
      const dir = checkDir(body.dir || "");
      if (!dir) throw httpError(400, "dir is required");
      const branch = checkout(dir, body.branch);
      // every agent's folder line shows the folder's branch
      for (const c of allCanvases()) for (const a of c.agents.values()) if (a.folder) c.bus.emit("agent_updated", { agent: a.view() });
      return sendJson(res, 200, { branch });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { message: e.message } });
    }
  }

  // the folder picker's branch list: GET /v1/git?dir=/path
  if (req.method === "GET" && path === "/v1/git") {
    try {
      const dir = checkDir(new URL(req.url, "http://x").searchParams.get("dir") || "");
      if (!dir) throw httpError(400, "dir is required");
      return sendJson(res, 200, repoInfo(dir));
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { message: e.message } });
    }
  }

  if (path.startsWith("/v1/toolbox") || path.startsWith("/v1/market")) {
    try {
      if (await toolboxRoutes(req, res, path) !== false) return;
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { message: e.message } });
    }
  }

  if (path.startsWith("/v1/history")) {
    try {
      if (await historyRoutes(req, res, path) !== false) return;
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { message: e.message } });
    }
  }

  if (path.startsWith("/v1/canvases")) {
    try {
      if (await canvasRoutes(req, res, path) !== false) return;
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { message: e.message } });
    }
  }

  const handler = req.method === "POST" && (
    path === "/v1/chat/completions" ? openaiChat :
    path === "/v1/messages" ? anthropicMessages : null);
  if (!handler) return sendJson(res, 404, { error: { message: `no route for ${req.method} ${path}` } });

  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 400, { error: { message: "invalid JSON" } }); }
  if (!Array.isArray(body.messages) || !body.messages.some((m) => m.role !== "system")) {
    return sendJson(res, 400, { error: { message: "messages must include at least one non-system message" } });
  }

  const { backend, model, error } = pickBackend(body.model);
  if (error) return sendJson(res, 400, { error: { message: error } });
  let opts;
  try { opts = validateOpts(optsFrom(req.headers)); } catch (e) { return sendJson(res, e.status || 400, { error: { message: e.message } }); }
  opts.lang = langOf(req);

  const ac = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ac.abort(); });

  const started = Date.now();
  try { await acquire(backend, ac.signal); }
  catch { return; } // client went away while queued; slot was not taken
  try {
    await handler(req, res, body, { backend, model, opts, signal: ac.signal });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { error: { message: e.message, type: `${backend.name}_error` } });
    else res.end();
  } finally {
    release(backend);
    if (!process.env.TAKSIM_QUIET) {
      console.log(`${req.method} ${path} ${backend.name}/${model} ${opts.cwd ? `agent@${opts.cwd}` : "chat"} ${Date.now() - started}ms`);
    }
  }
}

export async function startServer({ host = cfg.host, port = cfg.port } = {}) {
  if (!isLoopback(host) && !(cfg.allowRemote && cfg.token)) {
    throw new Error(`refusing to listen on ${host}: set TAKSIM_ALLOW_REMOTE=1 and TAKSIM_TOKEN to expose taksim beyond this machine`);
  }
  cfg.host = host;
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } }); else res.end(); });
  });
  loadCanvases(); // before listening, so nothing sees an empty canvas list while backends start
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  cfg.port = server.address().port;
  server.on("upgrade", handleUpgrade);
  // an account whose adding was cut short (the app quit mid sign-in) is kept only if it did sign in
  cleanDrafts().catch(() => {});
  // Claude Code's sessions read once in the background, so the first look at the history is instant
  if (!process.env.TAKSIM_QUIET) setTimeout(() => listClaudeSessions().catch(() => {}), 4000).unref();
  server.on("close", () => { closeCanvases(); stopAllLogins(); killAll(); killAllPanelProcs(); stopBrowser(); });
  await initBackends();
  refreshModelDetails(); // in the background: the CLIs take a few seconds to list their models
  return server;
}

export async function serve() {
  const server = await startServer();
  if (cfg.allowRemote) console.warn("WARNING: TAKSIM_ALLOW_REMOTE=1 — anyone with the token can run agents on this machine.");
  console.log(`taksim on ${baseUrl()}  backends: ${BACKENDS.map((b) => `${b.name}(${b.models.length})`).join(", ")}${cfg.token ? "  (token required)" : ""}`);
  const stop = () => { closeCanvases(); stopAllLogins(); killAll(); killAllPanelProcs(); stopBrowser(); server.close(); setTimeout(() => process.exit(0), 200).unref(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return server;
}

function pickFolder(start, lang = "en") {
  if (process.platform !== "darwin") return Promise.resolve(null);
  const from = typeof start === "string" && start.startsWith("/") && existsSync(start) ? start : null;
  const script = `POSIX path of (choose folder with prompt "${T(lang, "Choose folder", "Klasör seç")}"${from ? ` default location (POSIX file ${JSON.stringify(from)})` : ""})`;
  return new Promise((resolve) => {
    execFile("osascript", ["-e", 'tell application "System Events" to activate', "-e", script], { timeout: 10 * 60 * 1000 },
      (err, out) => resolve(err ? null : out.trim().replace(/(.)\/$/, "$1") || null));
  });
}
