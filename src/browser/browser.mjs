// A browser the agents can use: Chrome (or Chromium, Edge, Brave) on a profile of taksim's own, driven over the
// Chrome DevTools Protocol. The window is visible, so the person watches what the agents do; each agent works
// in a tab of its own. Logins made in it stay (the profile lives under ~/.taksim/browser) and never touch the
// person's own browser profile.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { HOME } from "../canvas/store.mjs";

const CANDIDATES = [
  process.env.TAKSIM_BROWSER,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].filter(Boolean);

export const browserPath = () => CANDIDATES.find((p) => existsSync(p)) || null;

/** One CDP connection: send commands, hear events. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    this.ready = new Promise((ok, fail) => { this.ws.once("open", ok); this.ws.once("error", fail); });
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id && this.pending.has(m.id)) {
        const { ok, fail } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) fail(new Error(m.error.message)); else ok(m.result);
      } else if (m.method) for (const h of this.handlers) h(m);
    });
    this.ws.on("close", () => { for (const { fail } of this.pending.values()) fail(new Error("the browser closed")); this.pending.clear(); this.closed = true; });
  }
  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(h) { this.handlers.add(h); return () => this.handlers.delete(h); }
  close() { try { this.ws.close(); } catch {} }
}

let chrome = null;   // { proc, cdp }
let starting = null;
// agent id -> { list: [page], active }; a page is { targetId, sessionId, dialog, dialogWaiters }
const tabs = new Map();
const owners = new Map(); // targetId -> agent id

async function start() {
  const bin = browserPath();
  if (!bin) throw new Error("No Chrome, Chromium, Edge or Brave found. Install Google Chrome to let agents use a browser.");
  const profile = join(HOME, "browser");
  mkdirSync(profile, { recursive: true });
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  const proc = spawn(bin, [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--disable-features=Translate", "--window-size=1280,900", "about:blank"], { stdio: "ignore", detached: false });
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  if (!existsSync(portFile)) { proc.kill(); throw new Error("the browser did not start"); }
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const cdp = new Cdp(`ws://127.0.0.1:${port}${path}`);
  await cdp.ready;
  const reset = () => { tabs.clear(); owners.clear(); };
  proc.once("exit", () => { if (chrome?.proc === proc) { chrome = null; reset(); } });
  cdp.ws.once("close", () => { if (chrome?.cdp === cdp) { chrome = null; reset(); } });
  // a page an agent's page opened (a link with target=_blank, window.open) becomes that agent's active tab
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  cdp.on(async (m) => {
    if (m.method === "Target.targetCreated") {
      const info = m.params.targetInfo;
      const agentId = info.type === "page" && info.openerId ? owners.get(info.openerId) : null;
      if (!agentId || owners.has(info.targetId)) return;
      const t = tabs.get(agentId);
      if (!t) return;
      const page = await attach(cdp, info.targetId, agentId).catch(() => null);
      if (page) { t.list.push(page); t.active = t.list.length - 1; }
    } else if (m.method === "Target.targetDestroyed") {
      const agentId = owners.get(m.params.targetId);
      owners.delete(m.params.targetId);
      const t = agentId && tabs.get(agentId);
      if (!t) return;
      t.list = t.list.filter((p) => p.targetId !== m.params.targetId);
      t.active = Math.max(0, Math.min(t.active, t.list.length - 1));
      if (!t.list.length) tabs.delete(agentId);
    }
  });
  return { proc, cdp };
}

async function ensure() {
  if (chrome && !chrome.cdp.closed) return chrome;
  starting ||= start().finally(() => { starting = null; });
  chrome = await starting;
  return chrome;
}

/** attaches to a page and keeps track of the dialogs it opens (alert, confirm, prompt, beforeunload) */
async function attach(cdp, targetId, agentId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = { targetId, sessionId, dialog: null, dialogWaiters: new Set(), frames: new Map() };
  owners.set(targetId, agentId);
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Page.javascriptDialogOpening") {
      page.dialog = m.params;
      for (const w of page.dialogWaiters) w(m.params);
      page.dialogWaiters.clear();
    } else if (m.method === "Page.javascriptDialogClosed") page.dialog = null;
    // cross-site iframes run in processes of their own: each comes as a session to evaluate in
    else if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "iframe") {
      page.frames.set(m.params.targetInfo.targetId, m.params.sessionId);
    } else if (m.method === "Target.detachedFromTarget") {
      for (const [id, sid] of page.frames) if (sid === m.params.sessionId) page.frames.delete(id);
    }
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("DOM.enable", {}, sessionId);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  return page;
}

function handle(cdp, page) {
  return {
    page,
    send: (method, params) => cdp.send(method, params, page.sessionId),
    /** a command to one of the page's out-of-process frames (a cross-site iframe) */
    sendTo: (sessionId, method, params) => cdp.send(method, params, sessionId),
    on: (h) => cdp.on((m) => { if (m.sessionId === page.sessionId) h(m); }),
    /** resolves when the page opens a dialog (an action that opens one never finishes on its own) */
    whenDialog: () => page.dialog ? Promise.resolve(page.dialog) : new Promise((r) => page.dialogWaiters.add(r)),
  };
}

/** The agent's active tab, opened (and brought forward) on first use. */
export async function tabOf(agentId) {
  const { cdp } = await ensure();
  let t = tabs.get(agentId);
  if (!t) {
    // the blank first tab is taken by the first agent; others get new ones
    const { targetInfos } = await cdp.send("Target.getTargets");
    const blank = targetInfos.find((i) => i.type === "page" && i.url === "about:blank" && !owners.has(i.targetId));
    const targetId = blank?.targetId || (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
    t = { list: [await attach(cdp, targetId, agentId)], active: 0 };
    tabs.set(agentId, t);
  }
  const page = t.list[t.active];
  // Re-activating a focused tab can clear Chrome's hover state on macOS between actions.
  // A dialog pauses evaluation; its tab is already in front and must stay answerable.
  if (!page.dialog) {
    const focused = await cdp.send("Runtime.evaluate", { expression: "document.hasFocus()", returnByValue: true }, page.sessionId);
    if (!focused.result.value) await cdp.send("Target.activateTarget", { targetId: page.targetId }).catch(() => {});
  }
  return handle(cdp, page);
}

/** The agent's tabs: their URL and title, which one is active. */
export async function listTabs(agentId) {
  const t = tabs.get(agentId);
  if (!t || !chrome) return [];
  const { targetInfos } = await chrome.cdp.send("Target.getTargets");
  return t.list.map((p, i) => {
    const info = targetInfos.find((x) => x.targetId === p.targetId) || {};
    return { index: i, url: info.url || "", title: info.title || "", active: i === t.active };
  });
}

export async function switchTab(agentId, index) {
  const t = tabs.get(agentId);
  if (!t || !t.list[index]) throw new Error(`no tab ${index}; see browser_tabs`);
  t.active = index;
}

export async function newTab(agentId, url = "about:blank") {
  const { cdp } = await ensure();
  await tabOf(agentId);
  const t = tabs.get(agentId);
  const { targetId } = await cdp.send("Target.createTarget", { url });
  if (owners.has(targetId)) return; // already taken by the discovery handler
  t.list.push(await attach(cdp, targetId, agentId));
  t.active = t.list.length - 1;
}

export async function closeTabAt(agentId, index) {
  const t = tabs.get(agentId);
  if (!t || !t.list[index] || !chrome) throw new Error(`no tab ${index}; see browser_tabs`);
  await chrome.cdp.send("Target.closeTarget", { targetId: t.list[index].targetId }).catch(() => {});
}

/** Closes an agent's tabs (when the agent is deleted). */
export async function closeTab(agentId) {
  const t = tabs.get(agentId);
  if (!t || !chrome) return;
  tabs.delete(agentId);
  for (const p of t.list) {
    owners.delete(p.targetId);
    await chrome.cdp.send("Target.closeTarget", { targetId: p.targetId }).catch(() => {});
  }
}

/** Closes the browser; resolves once it has exited. */
export function stopBrowser() {
  if (!chrome) return Promise.resolve();
  const { proc, cdp } = chrome;
  chrome = null; tabs.clear(); owners.clear();
  const gone = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => { proc.once("exit", r); setTimeout(r, 3000).unref(); });
  cdp.close(); proc.kill();
  return gone;
}
