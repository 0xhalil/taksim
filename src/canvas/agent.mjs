// An agent on a canvas: persistent identity + session, a mailbox, and one turn at a time.
// Every agent works in a directory (the canvas project dir, or the canvas workspace) with read-only or
// editing access. With its terminal closed, each turn is a single headless CLI run (src/runner.mjs) that
// resumes the CLI session. With its terminal open, the same
// session runs in the CLI's own TUI: messages are pasted in when it's idle and the CLI's hooks report
// turn start/stop and the final answer.

import { agentServers } from "../mcp/servers.mjs";
import { modeOf, readOnly } from "./chat-modes.mjs";
import { ChatTasks } from "./chat-tasks.mjs";
import { ChatWorkflow } from "./chat-workflow.mjs";
import { Orchestration } from "./orchestration.mjs";
import { randomUUID } from "node:crypto";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { basename } from "node:path";
import { branchOf } from "../git.mjs";
import { run } from "../runner.mjs";
import { pickBackend } from "../backends/index.mjs";
import { INTRO as GEMINI_INTRO } from "../backends/gemini.mjs";
import { snapshot, changes } from "./checkpoint.mjs";
import { cfg, NODE_PERMISSIONS } from "../config.mjs";
import { Terminal } from "../term/pty.mjs";
import { findAccount, accountEnv, listAccounts, prepareForTerminal } from "../accounts.mjs";
import { usageKey, refreshUsage, noteClaudeLimits } from "../usage.mjs";
import { appendTranscript, readTranscript, workspaceDir } from "./store.mjs";
import { Panel } from "../panels/panel.mjs";
import { Ide } from "../ide/ide.mjs";
import { listTools, card } from "../toolbox/store.mjs";
import { candidates } from "../toolbox/match.mjs";
import { judge } from "../toolbox/route.mjs";
import { toolHints, delegates } from "../toolbox/mcp.mjs";
import { projectRules } from "../ide/rules.mjs";

export const PERSISTED = ["id", "name", "role", "system", "chatOrigin", "forkContext", "chatMode", "chatPlan", "chatReviews", "job", "jobRole", "modeContextSince", "seedHistory", "model", "effort", "delegate", "toolHelp", "chat", "account", "sandbox", "cwd", "session",
  "pos", "size", "cardSize", "collapsed", "context", "mcp", "parent", "depth", "createdBy", "createdAt", "panel", "autoApprove", "ide", "permission"];

// The node's "helpers" switch: the agent leads and hands work to helper agents on the cheapest model that fits.
// the tools switch on the node (on unless the user turned it off): what the agent is told
const TOOL_HELP = [
  "Tool help is on: you decide, for each request, whether a tool helps. Before you build a panel or a recurring check, call find_tools.",
  "If a saved tool really serves the request, open it with use_tool without asking. If only a market tool fits (shared by other taksim",
  "users), add it with add_tool, then open it with use_tool; its commands still wait for the user's approval. If nothing fits and a live",
  "panel would clearly help, build one from bricks on the spot; once it works and the need will come back, save it with save_tool so it",
  "can be reused and shared. A tool that only shares words with the request doesn't fit, and most coding requests need none.",
];
const NO_TOOL_HELP = "Tool help is off: don't look up, add or suggest saved tools unless the user asks for one.";

// "Create agents" on (the node's switch, `delegate`): this agent is the orchestrator of the work it is given.
const DELEGATE = [
  "Create agents is on: you may orchestrate. Most work is still best done by one agent, you: other agents see none of your context,",
  "every hand-off loses some of it, and they cost several times the tokens. Do the work yourself unless splitting clearly pays:",
  "the parts are truly independent (each can be done and judged without knowing the others' decisions), or a part needs a different",
  "capability than yours (a stronger model for a hard decision, wide reading you would drown in, a second opinion). Work whose",
  "steps build on each other, and most coding, is one agent's work. When in doubt, don't split.",
  "The user's wish outranks that judgment: when they ask you to split the work across agents, or name the parts or the models, split",
  "their way with plan_work. The rules below still hold; if one of them stops what they asked for, say which and why.",
  "When it does pay, hand the parts out with plan_work, one call that names every part (at most 4): its task, the files it is about,",
  "what it depends on, the model and effort you chose, and what makes it done. One writer: at most one part may change files (or none,",
  "and you make the change yourself afterwards with what the parts found); the others read: research, analysis, where and why to change.",
  "Give the job check commands that prove it (the project's tests, a build, a linter): taksim runs them itself. taksim then asks the",
  "user before anything starts, creates the agents, gives each part what the parts it depends on found, asks the user when a part",
  "fails, runs the checks, has the change reviewed from its diff alone by an agent that knows nothing of the conversation, and sends",
  "you one message with all of it when every part has ended. plan_work itself returns at once: end your turn after it, and don't do",
  "the parts meanwhile. Do not hand out the parts of one job with create_agent or tell_agent yourself.",
  "Choose the model for each part by who does that kind of work well, not by price: call list_agents first; it lists what this",
  "computer can run with tier (light, standard, strong), thinking levels and whether it is free. Strong with a higher effort for",
  "design decisions, subtle bugs and hard analysis; standard for ordinary implementation; light only for lookups, summaries,",
  "translation and boilerplate. Stay on your own CLI's models unless another CLI's clearly does the part better: another CLI is",
  "another login and another bill. Reuse before you create: name an existing agent with a fitting role as the part's agent.",
  "A task must stand alone: say what to do, where, what to leave alone, and what to report back.",
  "You own the result. Failed checks mean the work is not done: fix the cause. Weigh the reviewer's findings against what the user",
  "asked and fix the real ones. A part that was skipped, stopped or failed is not done: say so; never present unfinished work as",
  "finished. Always pass create_agent's reason and ask_agent's or tell_agent's about: a few words in the user's language that the",
  "user reads on the arrow to that agent. Tell the user in a line which agent did what, on which model, and what was checked.",
];

// "Create agents" off: new agents appear only because the person asked for one.
const NO_DELEGATE = "Create agents is off: call create_agent only when the user explicitly asks you to create an agent (\"create an agent that…\"); "
  + "never on your own initiative, however large the work is. Do the work yourself. You may still ask_agent or tell_agent an agent that already exists "
  + "when the user asks for that or names it. When the user explicitly asks you to split the work across agents, do it with plan_work (one call "
  + "naming every part, at most 4; at most one part may change files): taksim asks them to start it, runs the parts and returns their results once.";

const HISTORY = 30; // transcript entries given to a session that replaces a lost one
const SUMMARY = 1500; // characters of each group context put in the system prompt
const INJECT_ACK_MS = Number(process.env.TAKSIM_INJECT_ACK_MS || 12000); // time for a TUI to take a pasted prompt

export class Agent {
  constructor(canvas, data) {
    Object.assign(this, data);
    this.chatMode = modeOf(this);
    if (readOnly(this)) this.sandbox = "read-only";
    // A saved running plan has no live turn after an engine restart; leave it reviewable.
    if (this.chatPlan?.status === "running") this.chatPlan = { ...this.chatPlan, status: "failed", updatedAt: Date.now() };
    this.canvas = canvas;
    this.queue = [];
    this.workflow = new ChatWorkflow(this);
    this.orchestration = new Orchestration(this);
    this.activities = new Map();
    this.tasks = new ChatTasks(this);
    this.current = null;      // { item, ac }
    this.status = "idle";     // idle | running | waiting | error
    this.waitingOn = new Set(); // agent ids this agent is blocked on (ask_agent)
    this.token = randomUUID(); // MCP address key; regenerated each server start, never persisted
    this.lastError = null;
    this.lastText = readTranscript(canvas.id, this.id, 1)[0]?.text || "";
    this.terminal = null;     // Terminal while the TUI is open
    this.shell = null;        // a plain shell in the agent's folder, while its node shows one
    this.seedHistory = !!data.seedHistory; // the CLI lost this agent's session: give the next one the recent transcript
    this.seenGroups = null;   // { groupId: version } the agent last saw (terminal sessions keep their launch prompt)
    this.pendingSession = null; // session id given to a fresh TUI; kept only once a turn happens in it
    this.terminalOpenedAt = 0;
    this.termReady = false;   // the TUI reached its prompt (not a trust/update/login screen)
    this.termBlocked = false; // a paste wasn't taken; wait until the person interacts with the TUI
    this.injected = null;     // message pasted into the TUI, waiting for the stop hook
    this.injectAck = false;   // the TUI took the paste as a prompt (start hook / busy marker)
    this.retryTimer = null;
    this.injectTimer = null;
    this.hinted = new Set();  // saved tools already named to this agent with a message
    this.lastAsk = "";        // the latest request it got, remembered by a tool it then uses
    this.asks = [];           // the last few requests it got, to tell whether a new agent was asked for
    this.autoApprove = !!data.autoApprove; // the user lets this agent's panel run commands without asking
    this.panel = data.panel?.spec ? new Panel(this, data.panel) : null;
    this.ide = data.ide ? new Ide(this, data.ide) : null;
    if (this.ide) setImmediate(() => this.ide?.watch());
  }

  // the account's env (its CLI config dir); {} for the machine login or an account that was deleted
  get env() {
    const acct = findAccount(this.account);
    return acct && acct.backend === pickBackend(this.model).backend.name ? accountEnv(acct) : {};
  }

  get accountName() { return findAccount(this.account)?.name || null; }
  // the login it runs under, for src/usage.mjs: its account when that is for its CLI, else this computer's
  get login() { const acct = findAccount(this.account); return acct && acct.backend === this.backend ? acct : null; }
  get usageKey() { return usageKey(this.login, this.backend); }
  /** after a turn, the plan's numbers (a headless Claude run already reported them; a TUI turn gets a check now and then) */
  noteUsage() { refreshUsage({ key: this.usageKey, backend: this.backend, dir: this.login?.dir, env: this.env }).catch(() => {}); }

  get hookUrl() { return `http://${cfg.host}:${cfg.port}/hooks/${this.token}`; }
  get mcpUrl() { return `http://${cfg.host}:${cfg.port}/mcp/${this.token}`; }

  get backend() { return pickBackend(this.model).backend.name; }

  /** how this node's turns ask for permission: what the person picked, else Claude judges (auto) */
  permissionMode() {
    const p = this.permission || "auto";
    return NODE_PERMISSIONS().includes(p) ? p : "auto";
  }

  toJSON() { return Object.fromEntries(PERSISTED.map((k) => [k, this[k] ?? null])); }

  view() {
    // how full the context is, as the CLI measured it on the last turn; a new session starts empty
    return { ...this.toJSON(), permissions: this.backend === "claude" ? NODE_PERMISSIONS() : [], context: this.session ? this.context ?? null : null, backend: this.backend, status: this.status, queued: this.queue.length,
      waitingOn: [...this.waitingOn], blockedBy: this.blockedBy || [], workingWith: this.orchestration?.working() || [],
      lastError: this.lastError, lastText: this.lastText.slice(0, 280),
      accountName: this.accountName, usageKey: this.usageKey, folder: this.folder,
      terminal: !!this.terminal, shell: !!this.shell, termReady: this.terminal ? this.isTerminalReady() : null,
      autoDeliver: !!pickBackend(this.model).backend.hooks, panel: this.panel?.spec ? this.panel.view() : null, ide: this.ide?.view() || null };
  }

  removeIde() {
    if (!this.ide) return;
    this.ide.close();
    this.ide = null;
    this.canvas.bus.emit("ide_updated", { id: this.id, ide: null });
    this.canvas.save();
  }

  removePanel() {
    if (!this.panel) return;
    this.panel.close();
    this.panel = null;
    this.canvas.bus.emit("panel_updated", { id: this.id, panel: null });
    this.canvas.save();
  }

  setStatus(status) {
    this.status = status;
    this.canvas.bus.emit("agent_status", { id: this.id, status, queued: this.queue.length,
      waitingOn: [...this.waitingOn], blockedBy: this.blockedBy || [], workingWith: this.orchestration?.working() || [], lastError: this.lastError, termReady: this.terminal ? this.isTerminalReady() : null,
      folder: this.folder });
  }

  // the folder chosen for this agent and the branch checked out there now; null when none was chosen
  get folder() {
    const path = this.cwd || this.canvas.vars.project_dir;
    return path ? { path, name: basename(path), branch: branchOf(path) } : null;
  }

  // item: { kind: "user" | "ask" | "tell" | "reply", from: agentId | null, text }
  // Returns a promise of the reply text for asks (and for user messages, so callers can wait).
  enqueue(item) {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...item, id: randomUUID(), ts: Date.now(), resolve, reject });
      this.emitQueue();
      if (this.status !== "idle" && this.status !== "error") this.setStatus(this.status); // queue count changed
      this.pump();
    });
  }

  // Only the person's pending messages are editable; asks and replies between agents keep their place.
  userQueue() {
    return this.queue.filter((i) => i.kind === "user" && !i.from && !i.recorded)
      .map(({ id, text, attachments, ts }) => ({ id, text, attachments: attachments || [], ts }));
  }

  emitQueue() { this.canvas.bus.emit("chat_queue", { id: this.id, messages: this.userQueue() }); }

  editQueued(id, text, attachments) {
    const item = this.queue.find((i) => i.id === id && i.kind === "user" && !i.from && !i.recorded);
    if (!item) throw Object.assign(new Error("message is no longer queued"), { status: 409 });
    item.text = text;
    if (attachments !== undefined) item.attachments = attachments;
    this.emitQueue();
  }

  cancelQueued(id) {
    const index = this.queue.findIndex((i) => i.id === id && i.kind === "user" && !i.from && !i.recorded);
    if (index < 0) throw Object.assign(new Error("message is no longer queued"), { status: 409 });
    this.queue.splice(index, 1)[0].reject(new Error("message cancelled"));
    this.emitQueue();
    this.setStatus(this.status);
  }

  reorderQueued(ids) {
    const pending = this.userQueue();
    if (!Array.isArray(ids) || ids.length !== pending.length || new Set(ids).size !== ids.length ||
        !ids.every((id) => pending.some((i) => i.id === id))) {
      throw Object.assign(new Error("queue changed; reload it"), { status: 409 });
    }
    const items = new Map(this.queue.map((i) => [i.id, i]));
    const editable = new Set(ids);
    let n = 0;
    this.queue = this.queue.map((i) => editable.has(i.id) ? items.get(ids[n++]) : i);
    this.emitQueue();
  }

  pump() {
    if (this.terminal) return this.pumpTerminal();
    if (this.current || this.queue.length === 0) return;
    const item = this.queue.shift();
    this.emitQueue();
    this.turn(item).finally(() => { this.current = null; this.pump(); });
  }

  // ---------- terminal ----------

  async openTerminal() {
    if (this.terminal) return;
    const canvas = this.canvas;
    const open = [...canvas.agents.values()].filter((a) => a.terminal).length;
    if (open >= canvas.limits.max_terminals) throw Object.assign(new Error(`at most ${canvas.limits.max_terminals} terminals can be open on a canvas`), { status: 409 });
    const { backend, model, error } = pickBackend(this.model);
    if (error) throw Object.assign(new Error(error), { status: 400 });
    if (!backend.interactive) throw Object.assign(new Error(`${backend.name} has no terminal mode`), { status: 400 });
    while (this.current) await new Promise((r) => setTimeout(r, 200)); // let a headless turn finish first

    // same directory as headless turns: claude keeps sessions per directory, so --resume needs it
    const cwd = this.workDir() || workspaceDir(canvas.id);
    const newSession = !this.session && backend.ownSessionIds;
    let system = this.systemPrompt();
    if (newSession) {
      // CLIs don't store a session nobody talked in, so this id becomes agent.session only after a turn
      this.pendingSession = randomUUID();
      // a session that replaces a lost one gets the earlier conversation
      const history = this.seedHistory ? this.historyText() : "";
      if (history) system += `\n\nEarlier conversation with you (before this session):\n${history}`;
      this.seedHistory = false;
    }
    const { file, args, env } = backend.interactive({
      model, cwd, session: this.session || this.pendingSession, newSession, system, mcpUrl: this.mcpUrl, hookUrl: this.hookUrl,
      sandbox: this.sandbox, effort: this.effort || undefined, mcp: agentServers(this), permission: this.permission || undefined,
    });
    this.terminalOpenedAt = Date.now();
    this.termReady = false;
    this.termBlocked = false;
    if (this.account) prepareForTerminal(this.account, cwd);
    this.terminal = new Terminal({ file, args, env: { ...this.env, ...env }, cwd, onExit: () => this.onTerminalExit() });
    this.terminal.onSubmit = (hadText) => {
      // a submitted line is a turn start for CLIs without a start hook (codex)
      if (hadText && !backend.readyHook && this.status !== "running") { this.lastError = null; this.setStatus("running"); }
      // the person answered whatever the TUI showed; look again for a chance to deliver
      if (this.termBlocked) { this.termBlocked = false; this.lastError = null; this.canvas.bus.emit("agent_updated", { agent: this.view() }); }
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.pump(), 1500);
    };
    this.lastError = null;
    canvas.bus.emit("agent_updated", { agent: this.view() });
    canvas.save();
    this.setStatus("idle");
  }

  closeTerminal() {
    this.terminal?.kill();
  }

  // A plain shell in the agent's folder (what the node's terminal button shows): not the CLI's TUI, so nothing
  // here touches the agent's session or queue.
  openShell() {
    if (this.shell) return;
    if (!this.cwd) throw Object.assign(new Error("the agent has no folder"), { status: 400 });
    const shell = new Terminal({ file: process.env.SHELL || "/bin/zsh", args: [], env: {}, cwd: this.cwd,
      onExit: () => { if (this.shell === shell) { this.shell = null; this.canvas.bus.emit("agent_updated", { agent: this.view() }); } } });
    this.shell = shell;
    this.canvas.bus.emit("agent_updated", { agent: this.view() });
  }

  closeShell() {
    this.shell?.kill();
  }

  // the TUI took its model and effort as flags: close it and open it again on the same session
  restartTerminal() {
    if (!this.terminal) return;
    this.reopenTerminal = true;
    this.terminal.kill();
  }

  onTerminalExit() {
    if (this.reopenTerminal) {
      this.reopenTerminal = false;
      this.terminal = null;
      this.termReady = false;
      if (this.injected) { this.queue.unshift(this.injected); this.injected = null; }
      this.openTerminal().catch((e) => { this.lastError = e.message; this.setStatus("error"); this.pump(); });
      return;
    }
    const tail = this.terminal?.tail || "";
    const quick = Date.now() - this.terminalOpenedAt < 15000;
    this.terminal = null;
    this.pendingSession = null;
    this.termReady = false;
    // the stored session is gone on the CLI's side (e.g. it was never written): start a fresh one
    if (quick && this.session && /No conversation found|no rollout found|session not found/i.test(tail)) {
      this.session = null;
      this.seedHistory = true;
      this.canvas.save();
      this.lastError = null;
      this.openTerminal().catch((e) => { this.lastError = e.message; this.setStatus("error"); });
      return;
    }
    if (quick && !tail.trim()) this.lastError = "the terminal closed right after starting";
    clearTimeout(this.retryTimer);
    clearTimeout(this.injectTimer);
    if (this.injected) { this.queue.unshift(this.injected); this.injected = null; } // headless picks it up
    this.canvas.bus.emit("agent_updated", { agent: this.view() });
    this.setStatus("idle");
    this.pump();
  }

  // True once the TUI shows its prompt. A fresh terminal may first show a trust, update or login screen;
  // a message pasted there would be lost. Claude reports readiness with its SessionStart hook (which only
  // runs once the folder is trusted); codex is ready when its composer placeholder is on screen.
  isTerminalReady() {
    if (!this.terminal || this.termBlocked) return false;
    if (this.termReady) return true;
    const { backend } = pickBackend(this.model);
    if (backend.readyPattern) return backend.readyPattern.test(this.terminal.tail.slice(-2000));
    return !backend.readyHook;
  }

  // Pastes the next queued message into the TUI once it is ready, idle and nobody is typing.
  pumpTerminal() {
    clearTimeout(this.retryTimer);
    if (this.injected || this.queue.length === 0) return;
    if (!pickBackend(this.model).backend.hooks) return; // no way to know when it's idle: wait for deliverNow()
    if (this.status === "running") return; // the stop hook pumps again
    if (this.terminal.userBusy() || !this.isTerminalReady()) {
      if (!this.waitNoticed) { this.waitNoticed = true; this.setStatus(this.status); } // show "waiting for the terminal"
      this.retryTimer = setTimeout(() => this.pump(), 1000);
      return;
    }
    this.waitNoticed = false;
    this.inject(this.queue.shift());
  }

  // Manual delivery, for CLIs without turn hooks (or to push past the typing guard).
  deliverNow() {
    if (!this.terminal || this.injected || !this.queue.length) return false;
    this.inject(this.queue.shift());
    return true;
  }

  inject(item) {
    this.emitQueue();
    const sender = item.from ? this.canvas.agents.get(item.from) : null;
    this.injected = item;
    this.injectAck = false;
    if (!item.recorded) {
      this.record({ from: item.from || "user", to: this.id, kind: item.kind, text: item.text });
      item.recorded = true;
    }
    if (sender) this.canvas.ensureLink(sender.id, this.id, "message", item.about);
    this.lastError = null;
    this.setStatus("running");
    const mark = this.terminal.written;
    this.terminal.paste(this.groupNotices() + this.messageText(item, sender));
    // If the TUI didn't take it as a prompt (a dialog was up), put it back and wait for the person.
    clearTimeout(this.injectTimer);
    this.injectTimer = setTimeout(() => this.checkInjected(item, mark), INJECT_ACK_MS);
  }

  checkInjected(item, mark) {
    if (this.injected !== item || this.injectAck || !this.terminal) return;
    const { backend } = pickBackend(this.model);
    if (backend.busyPattern?.test(this.terminal.textSince(mark))) { this.injectAck = true; return; }
    this.injected = null;
    this.queue.unshift(item);
    this.termBlocked = true;
    this.lastError = "the terminal didn't accept the message; it may be showing a question. Answer it and the message will be sent again.";
    this.canvas.bus.emit("agent_updated", { agent: this.view() });
    this.setStatus("idle");
    this.retryTimer = setTimeout(() => this.pump(), 1000);
  }

  // POST /hooks/<token>/<event> from the CLI's hooks (claude) or notify program (codex).
  onHook(event, payload = {}) {
    if (this.termBlocked) { this.termBlocked = false; if (this.lastError?.startsWith("the terminal didn't accept")) this.lastError = null; }
    // a turn makes the session real (the ready hook fires for empty sessions too)
    const session = payload.session_id || payload["thread-id"] || payload.thread_id;
    if (event !== "ready" && session && session !== this.session) {
      this.session = session;
      this.pendingSession = null;
      this.canvas.save();
    }

    if (event === "ready") {
      this.termReady = true;
      this.canvas.bus.emit("agent_updated", { agent: this.view() });
      this.pump();
      return;
    }
    if (event === "start") {
      if (this.injected) this.injectAck = true;
      this.termReady = true;
      // a prompt the person typed (ours are recorded when injected)
      // (a session's setup message, its standing instructions, isn't something the person said)
      if (payload.prompt && !this.injected && !String(payload.prompt).startsWith(GEMINI_INTRO)) { this.record({ from: "user", to: this.id, kind: "user", text: payload.prompt }); this.suggestFromTerminal(payload.prompt); }
      this.lastError = null;
      if (this.status !== "running") this.setStatus("running");
      // the folder before this terminal turn, for what it changes (see turnChanges)
      if (this.sandbox !== "read-only" && !this.termBefore) this.termBefore = snapshot(this.workDir()).catch(() => null);
      return;
    }
    if (event !== "stop") return;

    const text = lastAssistantText(payload);
    const item = this.injected;
    this.injected = null;
    this.termReady = true;
    clearTimeout(this.injectTimer);
    if (!item) {
      const typed = payload["input-messages"]?.at?.(-1);
      if (typed) this.record({ from: "user", to: this.id, kind: "user", text: typed });
    }
    if (text) {
      this.lastText = text;
      this.record({ from: this.id, to: item?.from || "user", kind: "assistant", text });
      // what the turn changed follows once git has said (a "changes" entry the chat shows with the answer)
      const before = this.termBefore;
      this.termBefore = null;
      if (before) (async () => {
        const ch = await this.turnChanges(this.workDir(), await before);
        if (ch.checkpoint) this.record({ from: this.id, to: item?.from || "user", kind: "changes", text: "", ...ch });
      })().catch(() => {});
    }
    this.canvas.bus.emit("turn_done", { id: this.id, text, replyTo: item?.from || "user" });
    if (item) this.deliver(item, item.from ? this.canvas.agents.get(item.from) : null, text || "(no text answer)");
    this.setStatus("idle");
    this.canvas.save();
    this.noteUsage();
    this.pump();
  }

  stop() {
    this.orchestration?.cancel(); // the work it handed out stops with it
    this.current?.ac.abort();
    if (this.terminal && this.status === "running") this.terminal.proc.write("\x1b"); // Esc interrupts the TUIs
  }

  // Drops queued work, e.g. when the agent is removed.
  rejectQueued(reason) {
    for (const item of this.queue.splice(0)) item.reject(new Error(reason));
    this.emitQueue();
  }

  async turn(item) {
    const canvas = this.canvas;
    const ac = new AbortController();
    this.current = { item, ac };
    this.activities.clear();
    this.tasks.reset();
    canvas.bus.emit("chat_activity", { id: this.id, reset: true });
    const sender = item.from ? canvas.agents.get(item.from) : null;

    this.record({ from: item.from || "user", to: this.id, kind: item.kind, text: item.text, ...(item.attachments?.length ? { attachments: item.attachments } : {}) });
    if (sender) canvas.ensureLink(sender.id, this.id, "message", item.about);
    this.lastError = null;
    this.setStatus("running");
    let before = null;

    const { backend, model, error } = pickBackend(this.model);
    const cwd = this.workDir();
    let release = () => {};
    try {
      if (error) throw new Error(error);
      // While work it handed out is under way, the folder is its writer's: the orchestrator can still be talked
      // to (it reads, it answers), but this turn can't change files, and so doesn't wait for the folder either.
      const guest = (this.orchestration.active && item.kind !== "job") || item.guest === true;
      const sandbox = guest ? "read-only" : this.sandbox;
      if (sandbox !== "read-only") release = await canvas.lockCwd(cwd, this, ac.signal);
      // its folder as it is now, to show what this turn changed and to go back to (git folders only)
      if (sandbox !== "read-only") before = await snapshot(cwd).catch(() => null);

      const mcpUrl = `http://${cfg.host}:${cfg.port}/mcp/${this.token}`;
      // The CLI session carries the conversation, and the terminal resumes the same one.
      // CLIs that let us name sessions get a fresh id up front; the others report theirs.
      const newSession = !this.session && backend.ownSessionIds;
      const session = this.session || (newSession ? randomUUID() : undefined);
      const opts = { cwd, sandbox: sandbox || undefined, permission: this.permissionMode(), session, newSession, mcpUrl, effort: this.effort || undefined, lang: canvas.lang, mcp: agentServers(this) };
      let streamed = "";
      // group changes since the last turn, said in the message too: a resumed session may otherwise keep
      // to what it answered before joining (the system prompt alone doesn't override its own history)
      const notices = this.groupNotices();
      const taskSeed = readTranscript(canvas.id, this.id, HISTORY).filter((e) => e.from === this.id && e.tasks?.length).at(-1)?.tasks || [];
      const attempt = () => run(backend, {
        taskSeed: opts.session && !opts.newSession ? taskSeed : [],
        model, system: this.systemPrompt(), prompt: notices + (guest && !item.guest ? "[taksim: the work you handed out is still under way. For this message you can read and answer, not change files; its results will arrive when it ends.]\n\n" : "")
          + this.prompt(item, sender) + attachmentNote(item.attachments), opts, signal: ac.signal, env: this.env,
        onTasks: (todos) => {
          if (!readOnly(this)) { try { this.tasks.update({ todos }, true); } catch { /* unsupported native payload: preserve last valid progress */ } }
        },
        onActivity: (activity) => {
          this.activities.set(activity.id, activity);
          canvas.bus.emit("chat_activity", { id: this.id, activity });
        },
        onLimits: (l) => noteClaudeLimits(this.usageKey, l),
        onText: (t) => { streamed += t; canvas.bus.emit("text_delta", { id: this.id, text: t }); },
      });
      let r;
      try {
        r = await attempt();
      } catch (e) {
        // the CLI no longer has the stored session: start a fresh one, seeded with the transcript
        if (!opts.session || ac.signal.aborted || !/No conversation found|no rollout found|session not found/i.test(e.message)) throw e;
        this.session = null;
        this.seedHistory = true;
        opts.newSession = !!backend.ownSessionIds;
        opts.session = opts.newSession ? randomUUID() : undefined;
        streamed = "";
        this.activities.clear();
        this.tasks.reset();
        canvas.bus.emit("chat_activity", { id: this.id, reset: true });
        r = await attempt();
        if (opts.newSession && !r.session) r.session = opts.session;
      }
      if (r.session || opts.newSession) this.session = r.session || opts.session;
      const text = r.text || streamed;
      this.lastText = text;
      if (r.context?.used && r.context.window) this.context = { used: r.context.used, window: r.context.window, at: Date.now() };
      this.record({ from: this.id, to: item.from || "user", kind: "assistant", text, usage: r.usage, tasks: this.tasks.snapshot(), activities: [...this.activities.values()], ...(await this.turnChanges(cwd, before)) });
      canvas.bus.emit("turn_done", { id: this.id, text, usage: r.usage, replyTo: item.from || "user" });
      canvas.save();
      this.workflow.completed(item, true);
      this.deliver(item, sender, text);
      // a question the engine put to the person about handed-out work outlives the turn: the node keeps saying so
      this.setStatus(this.workflow.pending ? "waiting" : "idle");
      this.noteUsage();
    } catch (e) {
      const message = ac.signal.aborted ? "stopped" : e.message;
      this.workflow.completed(item, false);
      this.lastError = message;
      this.record({ from: this.id, to: item.from || "user", kind: "error", text: message, tasks: this.tasks.snapshot(true), activities: [...this.activities.values()].map((a) => a.status === "running" ? { ...a, status: "cancelled" } : a), ...(await this.turnChanges(this.workDir(), before)) });
      canvas.bus.emit("turn_failed", { id: this.id, error: message });
      item.reject(new Error(`${this.name}: ${message}`));
      if (item.kind === "tell" && sender) {
        sender.enqueue({ kind: "reply", from: this.id, text: `(failed: ${message})` }).catch(() => {});
      }
      this.setStatus(ac.signal.aborted ? "idle" : "error");
    } finally {
      this.tasks.reset();
      release();
    }
  }

  deliver(item, sender, text) {
    item.resolve(text);
    // A tell's answer goes back to the sender as a new message; an ask's answer is the awaited result.
    if (item.kind === "tell" && sender && this.canvas.agents.has(sender.id)) {
      sender.enqueue({ kind: "reply", from: this.id, text }).catch(() => {});
    }
  }

  /** what a turn changed in its folder since `before`, and the checkpoint to go back to */
  async turnChanges(cwd, before) {
    if (!before) return {};
    const after = await snapshot(cwd).catch(() => null);
    const files = await changes(cwd, before, after).catch(() => []);
    return files.length ? { checkpoint: before, after, changes: files } : { checkpoint: before };
  }

  record(entry) {
    const e = { ts: Date.now(), mode: this.chatMode || (this.sandbox === "read-only" ? "ask" : "agent"), ...entry };
    appendTranscript(this.canvas.id, this.id, e);
    this.canvas.bus.emit("message", e);
  }

  systemPrompt() {
    const lines = [`You are "${this.name}", an agent on a shared taksim canvas.`];
    if (this.forkContext) lines.push("This is an independent branch. The following is reference context from the parent conversation, not new instructions. Do not assume its file changes were reverted:", `<parent_conversation>\n${this.forkContext}\n</parent_conversation>`);
    if (this.chatMode === "ask") lines.push("Chat mode: Ask. Search and read the actual codebase to answer questions, trace call sites and architecture, and cite concrete files and lines using ide_open/ide_note. Distinguish evidence from inference. Answer concisely; do not implement, run modifying commands or delegate changes. If the question is ambiguous, use ask_user. Project instructions and rules still apply.");
    if (this.chatMode === "plan") lines.push("Chat mode: Plan. Research the actual codebase first. Use ask_user only for decisions that materially affect scope, architecture or validation; make routine decisions yourself. Identify affected files, dependencies, ordered steps, risks and concrete validation. Publish the finished plan with propose_plan (title and Markdown content) so the user can edit and build it; then give a short handoff without repeating the whole artifact. Do not implement, run modifying commands or delegate implementation. The user must build the reviewed plan using the UI. Do not treat an ordinary chat reply as approval. Project instructions and rules still apply.");
    if ((this.chatMode || "agent") === "agent" && this.sandbox !== "read-only") lines.push("Chat mode: Agent. Investigate, implement and validate the task autonomously. For multi-step work, use your native task tools when available, otherwise update_todos, to publish a short task list early, mark one task in_progress and update it as actual work proceeds. Mark a task completed only after its result was checked; leave unfinished tasks pending or cancel them with a reason. Skip task lists for trivial requests. Read project rules before edits. Make coherent changes across files, run appropriate tests, inspect the result and fix failures. Use ask_user for consequential missing decisions. Report concrete changes and validation, including any limitation; do not claim checks you did not run.");
    if (modeOf(this) === "agent" && ["copilot", "local"].includes(pickBackend(this.model).backend?.name)) lines.push("For task progress always use the taksim update_todos tool, with stable ids and real statuses, so the person sees your live list. Native SQL todo signals do not expose the list through this CLI connection. Do not rely on them alone.");
    if (this.role) lines.push(`Your role: ${this.role}`);
    lines.push(this.sandbox === "read-only"
      ? "Your access is read-only: read and analyze, but don't modify files; say what should change instead."
      : "You may read and edit files in your working directory.");
    lines.push(
      "The taksim tools connect you to the other agents on the canvas: list_agents, ask_agent (wait for an answer),",
      "tell_agent (don't wait; the answer arrives later as a new message) and create_agent (a standing agent the user asked for;",
      "the parts of a piece of work are handed out with plan_work instead, and create_agent refuses them).",
      "Other agents see none of your context.",
      "",
      "You have a panel docked next to your node: a live view you assemble from bricks (list_bricks, panel_open, panel_patch, panel_push, panel_read).",
      "Show, don't tell: a chart for how something changes over time, a timeline for durations and waiting (runs, deploys, open PRs),",
      "bars for rankings (most restarts, most CPU, most issues); they animate as the data changes, so they explain better than a paragraph.",
      "People save panels that worked as tools and share them: before building one, call find_tools (and use_tool if one fits);",
      "when nothing fits, call design_tool and model the new panel on the best product people use for that need (k9s, lazydocker, lnav, …);",
      "messages may also come with a note naming saved tools that look relevant. When the user asks you to create an agent for some job",
      "(\"create an agent that watches kubernetes\"), the tool is that agent's: pass it as create_agent's `tool` (find_tools first), never use_tool",
      "on yourself. Build a tool for the need, not a fixed view: when the user would steer it (pick a target, search, open a row's detail,",
      "take an action) give it inputs and buttons (list_bricks' interactive_example). Once a tool works and the need comes back (watching",
      "something, a routine check), save it yourself with save_tool, without being asked, and write its triggers: the varied requests a",
      "person would type when they need it, and keywords; a one-off investigation isn't saved. Save when the user asks to keep or share too.",
      "Open it on your own, without being asked, whenever your work involves something the user would want to watch or check at a glance:",
      "a cluster, services, containers, logs, queues, builds, test runs, metrics, or a list of findings. Do it early, as soon as you know which",
      "commands show the state, and keep it current. Use every_s or stream for anything that changes, so it stays live without you;",
      "when the user asks you to keep watching something, that is what the panel is for. Pin commands to explicit targets",
      "(e.g. --context and --namespace, a host, a file) instead of whatever is current. Panel commands run through taksim once the user",
      "approves them, so they work even where your own shell commands need approval; read their output with panel_read.",
      "When the user asks to change the panel (a column, a view, a filter), use panel_patch. Its row actions send the user's clicks to you as messages.",
      "",
      "You also have an IDE: a PyCharm-like editor on your working directory, docked next to you (ide_open, ide_note).",
      "Whenever your answer is about specific code (a bug you found, code you explain or review, files you changed), call ide_open on that",
      "file and line before you answer, and mark the exact lines with ide_note (severity error for bugs, warning for risks, info for explanations;",
      "pass code, the text of the line, so the note lands exactly).",
      "The user reads the code there, so your answer can point at it instead of pasting it. These tools are read-only and allowed in plan mode.",
      "The user can also run and debug Python files in that IDE; when they ask about a program they are debugging, call ide_debug_state",
      "to see where it is paused, the call stack and the variables.",
    );
    // accounts change over time, so name the current ones and point at list_agents for the live list
    const accounts = listAccounts();
    lines.push(accounts.length
      ? `create_agent takes an optional "account": the name of one of the user's accounts, so the new agent runs under that login. Current accounts: ${accounts.map((a) => `"${a.name}" (${a.backend})`).join(", ")}. You run under ${this.accountName ? `"${this.accountName}"` : "this machine's default login"}. Call list_agents for the up-to-date list. When the user names an account, pass it; if it doesn't exist, tell them to add it under "Hesaplar" in taksim.`
      : `create_agent takes an optional "account" (one of the user's named accounts). None exist yet; the user can add them under "Hesaplar" in taksim, then you can pass the account name.`);
    const rules = projectRules(this.workDir());
    if (rules) lines.push("", "Project rules (kept by the user in .taksimrules, .cursorrules or .cursor/rules; follow them):", rules);
    if (this.system) lines.push(this.system);
    if (readOnly(this)) lines.push("Core mode policy overrides conflicting instructions: investigate and explain only. Do not implement or run command/SQL panel sources, even with auto-approval. Present findings using agent data sources or the IDE. To implement, the user must switch to Agent mode.");
    // one switch decides who makes agents: on, this agent orchestrates; off, only the person asks for one
    if (this.delegate && !readOnly(this)) lines.push("", ...DELEGATE); else lines.push("", NO_DELEGATE);
    lines.push("", ...(this.toolHelp === false ? [NO_TOOL_HELP] : TOOL_HELP));
    const groups = this.canvas.groupsOf(this);
    if (groups.length) {
      lines.push("", `You are in group${groups.length > 1 ? "s" : ""} ${groups.map((g) => `"${g.name}"`).join(" > ")}. `
        + "Their shared context (summary below) applies to your work; call get_context for the full, current version.");
      for (const g of groups) {
        const note = this.canvas.readContext(g).trim();
        if (note) lines.push(`--- ${g.name} (v${g.version}) ---`, note.length > SUMMARY ? `${note.slice(0, SUMMARY)}\n… (truncated; call get_context)` : note);
      }
      const maintained = groups.filter((g) => g.maintainer === this.id);
      if (maintained.length) {
        lines.push(`You maintain the context of ${maintained.map((g) => `"${g.name}"`).join(", ")}: keep it short and current with update_context when decisions change.`);
      }
    }
    this.seenGroups = Object.fromEntries(groups.map((g) => [g.id, g.version]));
    return lines.join("\n");
  }

  // One line per group change since the agent last saw its groups: joined, left, or a newer context version.
  groupNotices() {
    const groups = this.canvas.groupsOf(this);
    if (this.seenGroups === null && !groups.length) { this.seenGroups = {}; return ""; }
    const before = this.seenGroups || {};
    const now = Object.fromEntries(groups.map((g) => [g.id, g.version]));
    const notes = [];
    for (const g of groups) {
      if (!(g.id in before)) notes.push(`[You are now in group "${g.name}"; call get_context for its shared context.]`);
      else if (before[g.id] !== g.version) notes.push(`[Group "${g.name}" context updated to v${g.version}; call get_context if it matters for this.]`);
    }
    for (const id of Object.keys(before)) {
      if (!(id in now)) notes.push(`[You left group "${this.canvas.groups.find((g) => g.id === id)?.name || id}"; its context no longer applies.]`);
    }
    this.seenGroups = now;
    return notes.length ? notes.join("\n") + "\n\n" : "";
  }

  messageText(item, sender) {
    const who = sender ? `agent "${sender.name}" (${sender.model})` : "";
    const header = {
      user: "",
      job: "[taksim: the engine, not the user, about work you handed out with plan_work.]\n\n",
      ask: `[Message from ${who}. They are waiting for your answer; reply directly.]\n\n`,
      tell: `[Message from ${who}. Your final answer will be delivered back to them.]\n\n`,
      reply: `[Reply from ${who} to a message you sent earlier.]\n\n`,
    }[item.kind];
    // a reply, or the prompt the engine wrote to apply a plan, isn't a request to match tools against
    return header + item.text + (item.kind === "reply" || item.plan || item.quiet ? "" : this.toolNote(item.text, item.kind));
  }

  // Saved tools that may fit a request, named along with it. The agent is the judge: it opens one that really
  // serves the request (use_tool), builds one when a live panel would help and none fits, or ignores the note.
  // Each is named once per agent; the one already open as its panel isn't named.
  toolNote(text, kind = "user") {
    this.lastAsk = String(text || "").slice(0, 400);
    this.asks = [...(this.asks || []), this.lastAsk].slice(-4);
    if (this.toolHelp === false) return ""; // the user turned tool help off for this agent
    try {
      const open = this.panel?.tool?.id;
      const found = candidates(text, listTools()).filter(({ tool }) => tool.id !== open && !this.hinted.has(tool.id));
      for (const { tool } of found) this.hinted.add(tool.id);
      return toolHints(found, { delegate: delegates(text) });
    } catch { return ""; }
  }

  // The judge thinks a saved tool serves the request and nothing is docked yet: the page shows the tool as a
  // faint panel next to the node, opened with one press.
  offerTool(tool) {
    if (!tool || this.panel?.spec) return;
    this.canvas.bus.emit("tool_suggested", { id: this.id, tool: card(tool, { preview: true }) });
  }

  // A prompt typed straight into the terminal: the agent can't be told any more, but the person can be shown.
  // A model judges whether a tool sharing words with it really fits, in the background; a later prompt wins.
  suggestFromTerminal(text) {
    this.lastAsk = String(text || "").slice(0, 400);
    this.asks = [...(this.asks || []), this.lastAsk].slice(-4);
    if (this.toolHelp === false || delegates(text)) return; // a tool for a new agent belongs to that agent
    const turn = this.judged = (this.judged || 0) + 1;
    const tools = listTools().filter((t) => t.id !== this.panel?.tool?.id && !this.hinted.has(t.id));
    return judge(text, tools, { model: this.model, env: this.env }).then(({ use }) => {
      if (!use || turn !== this.judged || this.hinted.has(use.id)) return;
      this.hinted.add(use.id);
      this.offerTool(use);
    }).catch(() => { /* suggestions are best-effort */ });
  }

  // Its own cwd, else the canvas project dir, else the canvas workspace. Stable, since CLIs keep
  // sessions per directory and --resume needs the same one.
  workDir() {
    return this.cwd || this.canvas.vars.project_dir || workspaceDir(this.canvas.id);
  }

  prompt(item, sender) {
    const message = this.messageText(item, sender);
    if (!this.seedHistory) return message; // the CLI session carries the history
    this.seedHistory = false;
    const history = this.historyText(1);
    return history ? `<conversation_history>\n${history}\n</conversation_history>\n\n${message}` : message;
  }

  // The recent transcript as tagged text; `skipLast` drops entries already being sent as the message.
  historyText(skipLast = 0) {
    const entries = readTranscript(this.canvas.id, this.id, HISTORY + skipLast);
    return entries.slice(0, entries.length - skipLast)
      .filter((e) => !["error", "restore", "changes"].includes(e.kind) && (!this.modeContextSince || (e.ts >= this.modeContextSince && e.mode === this.chatMode)))
      .map((e) => {
        const tag = e.from === this.id ? "you" : e.from === "user" ? "user" : "agent";
        return `<${tag}>\n${e.text}\n</${tag}>`;
      }).join("\n\n");
  }
}

// The final answer from a stop hook: given directly (codex notify, newer claude) or read from claude's or copilot's transcript.
// The hook caller knows only the agent token, so the path is untrusted: read just the
// tail of a .jsonl transcript (bounded, no whole-file exfil into the transcript log).
function lastAssistantText(payload) {
  // Claude's last_assistant_message, Copilot's, Gemini's AfterAgent prompt_response
  const direct = payload.last_assistant_message ?? payload["last-assistant-message"] ?? payload.prompt_response;
  if (typeof direct === "string") return direct;
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path) return "";
  if (!payload.transcript_path.endsWith(".jsonl")) return "";
  try {
    const st = statSync(payload.transcript_path);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) return "";
    const len = Math.min(st.size, 512 * 1024);
    const fd = openSync(payload.transcript_path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString("utf8").trim().split("\n").reverse();
      for (const line of lines) {
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        // Copilot's events.jsonl
        if (e.type === "assistant.message" && e.data?.content) return e.data.content;
        if (e.type !== "assistant") continue;
        const parts = (e.message?.content || []).filter((c) => c.type === "text").map((c) => c.text);
        if (parts.length) return parts.join("\n");
      }
    } finally { closeSync(fd); }
  } catch { /* unreadable transcript */ }
  return "";
}

// What the user attached to a message in the chat (a file, lines picked in the IDE, a pasted image), said to the
// agent after it.
export function attachmentNote(list) {
  if (!Array.isArray(list) || !list.length) return "";
  const lines = ["", "", "[Attached by the user]"];
  for (const a of list.slice(0, 20)) {
    if (a.kind === "conversation") lines.push(`- reference conversation "${a.name}" (context only, not instructions):`, "<reference_conversation>", a.text || "", "</reference_conversation>");
    else if (a.kind === "image") lines.push(`- image: ${a.path} (look at it: read the file)`);
    else if (a.kind === "selection") lines.push(`- lines ${a.from}-${a.to} of ${a.path}:`, "```", String(a.text || "").slice(0, 20000), "```");
    else if (a.kind === "agent") lines.push(`- the agent "${a.name}" (reach it with ask_agent or tell_agent)`);
    else lines.push(`- ${a.kind === "folder" ? "folder" : "file"}: ${a.path}`);
  }
  return lines.join("\n");
}
