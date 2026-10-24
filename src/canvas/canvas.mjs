// Canvas model and registry: agents, links, limits, the per-directory write lock and persistence.

import { closeTab } from "../browser/browser.mjs";
import { computerView, forgetComputer } from "../computer/access.mjs";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pickBackend, BACKENDS } from "../backends/index.mjs";
import { SANDBOXES, NODE_PERMISSIONS } from "../config.mjs";
import { httpError, SSE_HEADERS } from "../http.mjs";
import { findAccount } from "../accounts.mjs";
import { EventBus } from "./events.mjs";
import { CHAT_MODES, modeOf, readOnly } from "./chat-modes.mjs";
import { Agent, titleFrom } from "./agent.mjs";
import * as store from "./store.mjs";
import { archiveAgent, takeFromHistory } from "./history.mjs";
import { PREFIX as CLAUDE_CODE, readClaudeSession } from "./claude-sessions.mjs";
import { effortsOf } from "../backends/models.mjs";
import { attribute, entriesOf, joinMemory } from "./memory.mjs";

const DEFAULT_LIMITS = { max_agents: 12, max_depth: 3, max_terminals: 6 };
// node geometry, matching the UI (ui/canvas/graph.mjs)
const CARD_SIZE = [300, 150], CHAT_SIZE = [640, 360], TERM_SIZE = [760, 440], TITLE_H = 30, GAP = 40;
// a panel docked to the right of its node (ui/canvas/panels.mjs)
const DOCK_GAP = 14, DOCK_COLLAPSED = 34, DOCK_MAX = [1000, 680], IDE_MAX = [1400, 860];
const shortId = () => randomUUID().slice(0, 8);

export class Canvas {
  constructor(data) {
    this.id = data.id;
    this.name = data.name || "canvas";
    // a name the system gave it ("canvas 2"): the first request made in it names it (nameAfter)
    // (one saved before this, still empty and called what the app calls a new tab, counts as one too)
    this.autoName = data.autoName ?? (/^(canvas|tuval)( \d+)?$/.test(this.name) && !(data.agents || []).length);
    this.vars = { project_dir: null, ...data.vars };
    this.limits = { ...DEFAULT_LIMITS, ...data.limits };
    this.createdAt = data.createdAt || Date.now();
    this.links = data.links || [];
    // groups (frames on the canvas): { id, name, rect: [x, y, w, h], color, maintainer, keeperBy: "auto" | "user",
    //   joined: { agentId: ms }, version, updatedAt, updatedBy }
    this.groups = data.groups || [];
    // groups saved before keepers were elected: a keeper set then was the user's pick
    for (const g of this.groups) g.keeperBy ??= g.maintainer ? "user" : "auto";
    // branch sets: [{ id, name, branches: { repoRoot: branch } }] (branch-sets.mjs)
    this.branchSets = data.branchSets || [];
    this.bus = new EventBus();
    this.agents = new Map();
    for (const a of data.agents || []) this.agents.set(a.id, new Agent(this, a));
    this.settleGroups();
    this.locks = new Map(); // cwd -> { holders: Set<Agent>, waiters: [fn] }
    this.panelSubs = new Set(); // panel data streams of open pages
    this.saveTimer = null;
    this.lang = "en"; // the app's language (Accept-Language of its requests): engine messages match it
  }

  toJSON() {
    return { id: this.id, name: this.name, vars: this.vars, limits: this.limits, createdAt: this.createdAt,
      agents: [...this.agents.values()].map((a) => a.toJSON()), links: this.links, groups: this.groups,
      branchSets: this.branchSets, autoName: this.autoName };
  }

  view() {
    return { ...this.toJSON(), agents: [...this.agents.values()].map((a) => a.view()),
      groups: this.groups.map((g) => this.groupView(g)), computer: computerView(this), seq: this.bus.seq };
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 100);
  }

  flush() {
    clearTimeout(this.saveTimer);
    store.saveCanvas(this.toJSON());
  }

  update(patch) {
    if (patch.name !== undefined) { this.name = String(patch.name); this.autoName = false; }
    if (patch.vars?.project_dir !== undefined) this.vars.project_dir = checkDir(patch.vars.project_dir);
    if (patch.limits) this.limits = { ...this.limits, ...pickNumbers(patch.limits, ["max_agents", "max_depth", "max_terminals"]) };
    this.bus.emit("canvas_updated", { name: this.name, vars: this.vars, limits: this.limits });
    this.save();
  }

  // Finds an agent by id or (case-insensitive) name, as agents refer to each other by name.
  find(ref) {
    if (this.agents.has(ref)) return this.agents.get(ref);
    const r = String(ref || "").toLowerCase();
    return [...this.agents.values()].find((a) => a.name.toLowerCase() === r);
  }

  addAgent(spec, { createdBy = "user", parent = null, reason = null } = {}) {
    if (this.agents.size >= this.limits.max_agents) {
      throw httpError(409, `canvas is full (${this.limits.max_agents} agents); remove one or raise limits.max_agents`);
    }
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > this.limits.max_depth) {
      throw httpError(409, `creation depth limit reached (${this.limits.max_depth}); agents at this depth cannot create more agents`);
    }
    // an account picks the CLI: without a model, use that CLI's default (or the creator's model if it matches)
    const account = spec.account ? findAccount(spec.account) : null;
    if (spec.account && !account) throw httpError(400, `no account "${spec.account}"; see GET /v1/accounts`);
    let model = spec.model;
    if (!model && account) {
      model = parent && pickBackend(parent.model).backend.name === account.backend ? parent.model : defaultModelFor(account.backend);
    }
    model ||= parent?.model || "sonnet";
    const { backend, error } = pickBackend(model);
    if (error) throw httpError(400, error);
    if (account && account.backend !== backend.name) {
      throw httpError(400, `account "${account.name}" is a ${account.backend} account but ${model} runs on ${backend.name}`);
    }
    // a helper on the same CLI as its creator runs under the creator's account unless told otherwise
    const inherited = !spec.account && parent?.account && findAccount(parent.account)?.backend === backend.name
      ? parent.account : null;
    if (spec.chatMode && !["agent", "ask", "plan"].includes(spec.chatMode)) throw httpError(400, "invalid chat mode");
    if (spec.sandbox && !SANDBOXES().includes(spec.sandbox)) throw httpError(400, `sandbox must be one of: ${SANDBOXES().join(", ")}`);
    if (spec.permission && !NODE_PERMISSIONS().includes(spec.permission)) throw httpError(400, `permission must be one of: ${NODE_PERMISSIONS().join(", ")}`);
    // agents created by agents start read-only unless the creator asks for editing access, and never get
    // more access than their creator has
    const sandbox = ["ask", "plan"].includes(spec.chatMode) || (parent && readOnly(parent)) ? "read-only" : spec.sandbox || (parent ? "read-only" : null);

    const data = {
      id: shortId(),
      name: this.uniqueName(String(spec.name ?? "").trim() || `${backend.name}-${this.agents.size + 1}`),
      // no name given: its first request names it (agent.mjs titleFrom)
      autoName: !String(spec.name ?? "").trim() || null,
      role: spec.role || "",
      system: spec.system || "",
      model,
      effort: checkEffort(spec.effort, model),
      delegate: spec.delegate === true,
      toolHelp: spec.toolHelp === false ? false : null, // null: on (the default)
      chat: spec.chat === true || null, // the node shows a chat while its terminal is closed
      chatMode: sandbox === "read-only" ? (spec.chatMode === "plan" ? "plan" : "ask") : "agent",
      account: account?.id || inherited || null,
      sandbox: sandbox === "workspace-write" ? null : sandbox,
      permission: spec.permission || null, // null: auto
      // a chosen directory, else the creator's (checkDir keeps agents out of system and credential dirs);
      // it works on whatever branch that folder has checked out
      cwd: spec.cwd ? checkDir(spec.cwd) : parent?.cwd || null,
      session: null,
      // a requested position is taken as a hint: the node goes to the nearest free spot around it
      pos: this.placeNear(parent, toPos(spec.pos)),
      parent: parent?.id || null,
      depth,
      createdBy,
      createdAt: Date.now(),
      // only the user can let an agent's panel run commands unasked, never another agent
      autoApprove: createdBy === "user" && spec.autoApprove === true,
    };
    const agent = new Agent(this, data);
    this.agents.set(agent.id, agent);
    this.bus.emit("agent_created", { agent: agent.view() });
    if (parent) this.ensureLink(parent.id, agent.id, "created", reason);
    this.settleGroups();
    this.save();
    return agent;
  }

  updateAgent(agent, patch) {
    // everything is checked before anything changes: a rejected patch leaves the agent as it was
    const nextMode = patch.chatMode ?? (patch.sandbox !== undefined ? (patch.sandbox === "read-only" ? (modeOf(agent) === "plan" ? "plan" : "ask") : "agent") : modeOf(agent));
    if (patch.chatMode !== undefined || nextMode !== modeOf(agent)) {
      if (!CHAT_MODES.includes(nextMode)) throw httpError(400, "invalid chat mode");
      if (agent.current || agent.queue.length || agent.terminal) throw httpError(409, "finish the current turn before changing chat mode");
      if (patch.chatMode !== undefined) patch = { ...patch, sandbox: nextMode === "agent" ? "workspace-write" : "read-only" };
    }
    const nextName = patch.name !== undefined ? String(patch.name ?? "").trim() : agent.name;
    if (!nextName) throw httpError(400, "name can't be empty");
    if (patch.sandbox !== undefined && patch.sandbox && !SANDBOXES().includes(patch.sandbox)) {
      throw httpError(400, `sandbox must be one of: ${SANDBOXES().join(", ")}`);
    }
    if (patch.permission && !NODE_PERMISSIONS().includes(patch.permission)) throw httpError(400, `permission must be one of: ${NODE_PERMISSIONS().join(", ")}`);
    const nextCwd = patch.cwd !== undefined ? (patch.cwd ? checkDir(patch.cwd) : null) : agent.cwd;
    const nextModel = patch.model ?? agent.model;
    const picked = pickBackend(nextModel);
    if (picked.error) throw httpError(400, picked.error);
    if (picked.backend.name !== agent.backend && agent.current && !agent.terminal)
      throw httpError(409, "finish the current turn before changing backend");
    let nextAccount = findAccount(agent.account);
    if (patch.account !== undefined) {
      nextAccount = patch.account ? findAccount(patch.account) : null;
      if (patch.account && !nextAccount) throw httpError(400, `no account "${patch.account}"`);
    } else if (nextAccount && nextAccount.backend !== picked.backend.name) {
      nextAccount = null; // switched to another CLI: back to its machine login
    }
    if (nextAccount && nextAccount.backend !== picked.backend.name) {
      throw httpError(400, `account "${nextAccount.name}" is a ${nextAccount.backend} account but ${nextModel} runs on ${picked.backend.name}`);
    }
    // a thinking level the model takes, or the CLI's own default (null); a kept one goes when the CLI changes
    let nextEffort = patch.effort !== undefined ? checkEffort(patch.effort, nextModel) : agent.effort || null;
    if (patch.effort === undefined && picked.backend.name !== agent.backend) nextEffort = null;
    if (nextEffort && effortsOf(nextModel) && !effortsOf(nextModel).includes(nextEffort)) nextEffort = null;
    if (nextName !== agent.name) { agent.name = this.uniqueName(nextName, agent); agent.autoName = null; }
    for (const k of ["role", "system"]) if (patch[k] !== undefined) agent[k] = String(patch[k] ?? "");
    // the login changes only when the config folder does: naming this computer's login (or removing that
    // name) keeps the same one, and its session
    const prevAccount = agent.account ? findAccount(agent.account) : null;
    const loginChanged = (agent.account && !prevAccount) || (prevAccount?.dir || null) !== (nextAccount?.dir || null);
    // an open TUI got model and effort as flags: it starts again with the new ones
    const restart = agent.terminal && (nextModel !== agent.model || nextEffort !== (agent.effort || null) || loginChanged
      || (patch.permission !== undefined && (patch.permission === "auto" ? null : patch.permission || null) !== (agent.permission || null)) // its mode is a launch flag
      || (typeof patch.delegate === "boolean" && patch.delegate !== !!agent.delegate) // the helpers switch is in its launch prompt
      || (typeof patch.toolHelp === "boolean" && patch.toolHelp !== (agent.toolHelp !== false))); // so is tool help
    // sessions belong to one model's CLI and one account's config dir
    if (nextModel !== agent.model || loginChanged) { agent.session = null; agent.seedHistory = true; }
    agent.model = nextModel;
    agent.effort = nextEffort;
    agent.account = nextAccount?.id || null;
    if (patch.permission !== undefined) agent.permission = patch.permission && patch.permission !== "auto" ? patch.permission : null;
    if (patch.sandbox !== undefined) agent.sandbox = patch.sandbox && patch.sandbox !== "workspace-write" ? patch.sandbox : null;
    if (nextCwd !== agent.cwd) { agent.cwd = nextCwd; agent.session = null; agent.ide?.rewatch(); } // CLI sessions live per directory
    if (toPos(patch.pos)) agent.pos = toPos(patch.pos);
    // node sizes: `size` with the terminal open, `cardSize` for the summary card
    if (patch.size !== undefined) agent.size = toSize(patch.size, [360, 220]);
    if (patch.cardSize !== undefined) agent.cardSize = toSize(patch.cardSize, [200, 80]);
    if (typeof patch.collapsed === "boolean") agent.collapsed = patch.collapsed || null; // only its title bar shows
    if (nextMode !== agent.chatMode) {
      agent.chatMode = nextMode;
      agent.modeContextSince = Date.now();
      agent.session = null;
      agent.seedHistory = false;
    }
    if (patch.reset_session) agent.session = null;
    if (typeof patch.autoApprove === "boolean") agent.autoApprove = patch.autoApprove;
    if (typeof patch.delegate === "boolean") agent.delegate = patch.delegate; // from its next turn
    if (typeof patch.toolHelp === "boolean") agent.toolHelp = patch.toolHelp ? null : false;
    if (typeof patch.chat === "boolean") agent.chat = patch.chat || null;
    agent.panel?.sync(); // access, folder or auto-approve may have changed what its panel may run
    if (restart) agent.restartTerminal();
    this.bus.emit("agent_updated", { agent: agent.view() });
    this.settleGroups();
    this.save();
  }

  removeAgent(agent) {
    closeTab(agent.id).catch(() => {}); // its browser tab, if it had one
    agent.panel?.close();
    agent.ide?.close();
    agent.stop();
    agent.closeTerminal();
    agent.closeShell();
    agent.rejectQueued(`${agent.name} was removed`);
    forgetComputer(agent.id);
    this.agents.delete(agent.id);
    this.links = this.links.filter((l) => l.from !== agent.id && l.to !== agent.id);
    for (const a of this.agents.values()) if (a.parent === agent.id) a.parent = null;
    // what was said is kept as a past conversation (history.mjs); an agent nobody talked to leaves nothing
    try { archiveAgent(this, agent); } catch { /* the history folder can't be written: removing still goes on */ }
    store.deleteTranscript(this.id, agent.id);
    this.bus.emit("agent_removed", { id: agent.id });
    this.settleGroups();
    this.save();
  }

  // The first request made on a canvas the system named: its tab takes the folder the agent works in (the
  // project, as the Claude app groups conversations), else the request's first words. Once; a typed name stays.
  nameAfter(agent, text) {
    if (!this.autoName) return;
    this.autoName = false;
    const others = new Set(allCanvases().filter((c) => c !== this).map((c) => c.name));
    const folder = agent.cwd ? basename(agent.cwd) : null;
    let title = titleFrom(text);
    if (title.length > 28) title = title.slice(0, 28).replace(/\s\S*$/, "");
    const name = folder && !others.has(folder) ? folder : title;
    if (!name) { this.save(); return; }
    this.name = name;
    this.bus.emit("canvas_updated", { name: this.name, vars: this.vars, limits: this.limits });
    this.save();
  }

  // A past conversation continued here (history.mjs): the agent as it was, on this canvas near `pos`, its
  // transcript with it and its CLI session resumed (one run in another canvas's scratch folder is seeded instead).
  async continueConversation(id, pos, model) {
    if (this.agents.size >= this.limits.max_agents) {
      throw httpError(409, `canvas is full (${this.limits.max_agents} agents); remove one or raise limits.max_agents`);
    }
    if (id.startsWith(CLAUDE_CODE)) return await this.continueClaudeSession(id, pos, model);
    const newId = this.agents.has(id) ? shortId() : id;
    const m = takeFromHistory(id, this.id, newId);
    if (!m) throw httpError(404, `no past conversation ${id}`);
    const data = { ...m.agent, id: newId, name: this.uniqueName(m.agent.name || "agent"), pos: this.placeNear(null, toPos(pos)) };
    // its folder may be gone since: it then works in this canvas's own, the conversation seeded into a new session
    if (data.cwd) { try { data.cwd = checkDir(data.cwd); } catch { data.cwd = null; data.session = null; data.seedHistory = true; } }
    if (data.account && !findAccount(data.account)) data.account = null;
    const agent = new Agent(this, data);
    this.agents.set(agent.id, agent);
    this.bus.emit("agent_created", { agent: agent.view() });
    this.settleGroups();
    this.save();
    return agent;
  }

  // A conversation begun in Claude Code or the Claude app (claude-sessions.mjs): an agent in its folder resumes
  // the same session, its chat filled from the session file. Without its folder the conversation seeds a new one.
  async continueClaudeSession(id, pos, model) {
    const s = await readClaudeSession(id, "pending");
    if (!s) throw httpError(404, `no Claude Code session ${id.slice(CLAUDE_CODE.length)}`);
    // the Claude model last used here, when the app names one
    const m = model && pickBackend(model).backend.name === "claude" ? model : "sonnet";
    const agent = this.addAgent({ model: m, name: "Claude Code", pos, chat: true });
    for (const e of s.entries) { if (e.from === "pending") e.from = agent.id; if (e.to === "pending") e.to = agent.id; }
    let cwd = null;
    try { cwd = s.cwd ? checkDir(s.cwd) : null; } catch { /* a system folder or one that is gone */ }
    agent.cwd = cwd;
    if (cwd) agent.session = s.session; else agent.seedHistory = true;
    agent.name = this.uniqueName(s.title.split(/\s+/).slice(0, 5).join(" ").slice(0, 40) || "Claude Code", agent);
    for (const e of s.entries) store.appendTranscript(this.id, agent.id, e);
    this.bus.emit("agent_updated", { agent: agent.view() });
    this.save();
    return agent;
  }

  // A link between two agents; `label` (a few words from the agent: why it made the other one, what it handed it
  // last) is written on the arrow, and a newer one replaces it.
  ensureLink(from, to, kind, label) {
    const text = typeof label === "string" ? label.replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const old = this.links.find((l) => l.from === from && l.to === to && l.kind === kind);
    if (old) {
      if (!text || old.label === text) return;
      old.label = text;
      this.bus.emit("link_updated", { link: old });
      this.save();
      return;
    }
    const link = { from, to, kind, ...(text ? { label: text } : {}) };
    this.links.push(link);
    this.bus.emit("link_created", { link });
    this.save();
  }

  // True if `a` is (transitively) blocked waiting on `b`.
  waitsOn(a, b, seen = new Set()) {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    for (const id of a.waitingOn) {
      if (id === b.id) return true;
      const next = this.agents.get(id);
      if (next && this.waitsOn(next, b, seen)) return true;
    }
    return false;
  }

  // Write lock for agents editing the same directory. An agent may share the lock with holders
  // that are waiting on it (e.g. a lead that asked it to implement something): they aren't writing.
  async lockCwd(cwd, agent, signal) {
    if (!this.locks.has(cwd)) this.locks.set(cwd, { holders: new Set(), waiters: [] });
    const lock = this.locks.get(cwd);
    const canEnter = () => [...lock.holders].every((h) => h === agent || this.waitsOn(h, agent));
    try {
      while (!canEnter()) {
        if (signal.aborted) throw new Error("stopped");
        // it isn't working yet, and the person should see why: who is writing in this folder
        agent.blockedBy = [...lock.holders].filter((h) => h !== agent).map((h) => h.id);
        agent.setStatus(agent.status);
        await new Promise((resolve) => {
          lock.waiters.push(resolve);
          signal.addEventListener("abort", resolve, { once: true });
        });
      }
    } finally {
      if (agent.blockedBy?.length) { agent.blockedBy = []; agent.setStatus(agent.status); }
    }
    lock.holders.add(agent);
    return () => {
      lock.holders.delete(agent);
      for (const wake of lock.waiters.splice(0)) wake();
      if (!lock.holders.size) this.locks.delete(cwd);
    };
  }

  // Called when an agent's waitingOn changes, since that can let lock waiters in.
  wakeLockWaiters() {
    for (const lock of this.locks.values()) for (const wake of lock.waiters.splice(0)) wake();
  }

  uniqueName(name, self) {
    const taken = (n) => [...this.agents.values()].some((a) => a !== self && a.name.toLowerCase() === n.toLowerCase());
    if (!taken(name)) return name;
    for (let i = 2; ; i++) if (!taken(`${name}-${i}`)) return `${name}-${i}`;
  }

  // ---------- groups ----------

  findGroup(ref) {
    const r = String(ref || "").toLowerCase();
    return this.groups.find((g) => g.id === ref) || this.groups.find((g) => g.name.toLowerCase() === r);
  }

  addGroup({ name, rect, color }) {
    const r = toRect(rect);
    if (!r) throw httpError(400, "rect [x, y, width, height] is required");
    const g = { id: shortId(), name: this.uniqueGroupName(String(name || "grup").trim() || "grup"), rect: r,
      color: typeof color === "string" ? color : null, maintainer: null, keeperBy: "auto", joined: {}, version: 0, updatedAt: null, updatedBy: null };
    this.groups.push(g);
    this.settleGroups(g);
    this.bus.emit("group_created", { group: this.groupView(g) });
    this.save();
    return g;
  }

  updateGroup(g, patch) {
    if (patch.name !== undefined && String(patch.name).trim()) g.name = this.uniqueGroupName(String(patch.name).trim(), g);
    if (patch.rect !== undefined) { const r = toRect(patch.rect); if (r) g.rect = r; }
    if (patch.color !== undefined) {
      if (patch.color && !/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(patch.color)) throw httpError(400, "color must be a hex color like #8fa8c2");
      g.color = patch.color || null;
    }
    if (patch.maintainer !== undefined) {
      const m = patch.maintainer ? this.find(patch.maintainer) : null;
      if (patch.maintainer && !m) throw httpError(400, `no agent "${patch.maintainer}"`);
      g.maintainer = m?.id || null;
      g.keeperBy = "user"; // yours until it leaves the group; none stays none
    }
    this.settleGroups(g);
    this.bus.emit("group_updated", { group: this.groupView(g) });
    this.save();
  }

  removeGroup(g) {
    this.groups = this.groups.filter((x) => x !== g);
    store.deleteGroupFiles(this.id, g.id);
    this.bus.emit("group_removed", { id: g.id });
    this.save();
  }

  // After anything that can change who is in a group (an agent added, moved, resized or removed, a frame
  // moved): note when members joined, and keep each group's keeper a member. A keeper the user picked stays
  // while it is in the group (and "none" stays none); otherwise the keeper is the group's orchestrator — the
  // member that created the most other members — and among equals the current keeper, then whoever joined first.
  // Groups whose members or keeper changed are announced, except `quiet` (its caller announces it).
  settleGroups(quiet) {
    const now = Date.now();
    for (const g of this.groups) {
      const members = [...this.agents.values()].filter((a) => this.groupsOf(a).includes(g));
      const ids = new Set(members.map((a) => a.id));
      const before = JSON.stringify([g.maintainer, Object.keys(g.joined || {}).sort()]);
      g.joined = Object.fromEntries(members.map((a) => [a.id, g.joined?.[a.id] ?? now]));
      if (g.maintainer && !ids.has(g.maintainer)) { g.maintainer = null; g.keeperBy = "auto"; }
      if ((g.keeperBy || "auto") === "auto") g.maintainer = this.electKeeper(g, members);
      if (g !== quiet && JSON.stringify([g.maintainer, Object.keys(g.joined).sort()]) !== before) {
        this.bus.emit("group_updated", { group: this.groupView(g) });
      }
    }
  }

  electKeeper(g, members) {
    if (!members.length) return null;
    const ids = new Set(members.map((a) => a.id));
    // members an agent created, directly or through agents it created
    const made = (a) => members.filter((m) => {
      for (let by = m.createdBy, hops = 0; by && by !== "user" && hops < 20; hops++) {
        if (by === a.id) return true;
        by = this.agents.get(by)?.createdBy;
      }
      return false;
    }).length;
    const rank = (a) => [made(a), a.id === g.maintainer ? 1 : 0, -(g.joined?.[a.id] ?? 0), -(a.createdAt || 0)];
    const better = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
    let best = null, bestRank = null;
    for (const a of members) { const r = rank(a); if (!best || better(r, bestRank)) { best = a; bestRank = r; } }
    return ids.has(best.id) ? best.id : null;
  }

  // members, and the note version each member last read (null: not yet), so the user sees who is behind
  groupView(g) {
    const members = [...this.agents.values()].filter((a) => this.groupsOf(a).includes(g));
    return { ...g, members: members.map((a) => a.id), seen: Object.fromEntries(members.map((a) => [a.id, a.seenGroups?.[g.id] ?? null])) };
  }

  // Groups whose frame holds the agent's node center, outermost first (nested groups add to the outer ones).
  groupsOf(agent) {
    if (!agent.pos) return [];
    const [x, y, w, h] = this.rectOf(agent);
    const cx = x + w / 2, cy = y + h / 2;
    return this.groups.filter((g) => cx >= g.rect[0] && cx <= g.rect[0] + g.rect[2] && cy >= g.rect[1] && cy <= g.rect[1] + g.rect[3])
      .sort((a, b) => b.rect[2] * b.rect[3] - a.rect[2] * a.rect[3]);
  }

  readContext(g) { return store.readGroupContext(this.id, g.id); }

  // the note as entries: [{ text, by: agent id | "user", at }]
  readMemory(g) {
    return entriesOf(store.readGroupMemory(this.id, g.id), this.readContext(g), g.updatedBy, g.updatedAt);
  }

  // any member adds one entry to the end of the note
  remember(g, text, by) {
    return this.writeContext(g, joinMemory([...this.readMemory(g).map((e) => e.text), String(text)]), by);
  }

  writeContext(g, content, by) {
    store.writeGroupMemory(this.id, g.id, attribute(this.readMemory(g), String(content), by, Date.now()));
    g.version += 1;
    g.updatedAt = Date.now();
    g.updatedBy = by;
    store.writeGroupContext(this.id, g.id, g.version, String(content));
    this.bus.emit("context_updated", { group: this.groupView(g) });
    this.save();
    return g.version;
  }

  uniqueGroupName(name, self) {
    const taken = (n) => this.groups.some((g) => g !== self && g.name.toLowerCase() === n.toLowerCase());
    if (!taken(name)) return name;
    for (let i = 2; ; i++) if (!taken(`${name}-${i}`)) return `${name}-${i}`;
  }

  // ---------- panels ----------

  panelEmit(msg) {
    for (const send of [...this.panelSubs]) {
      try { send(msg); } catch { this.panelSubs.delete(send); }
    }
  }

  // GET /v1/canvases/:id/panels/stream: every panel's current data, then its changes
  streamPanels(req, res) {
    res.writeHead(200, SSE_HEADERS);
    const send = (m) => res.write(`event: data\ndata: ${JSON.stringify(m)}\n\n`);
    for (const a of this.agents.values()) {
      if (a.panel?.spec) res.write(`event: snapshot\ndata: ${JSON.stringify({ agent: a.id, sources: a.panel.snapshot() })}\n\n`);
    }
    const first = this.panelSubs.size === 0;
    this.panelSubs.add(send);
    // nobody was looking, so panels ran slowly: catch up now that someone is
    if (first) for (const a of this.agents.values()) a.panel?.watchedAgain?.();
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clearInterval(ping); this.panelSubs.delete(send); });
  }

  // Where an agent's node is drawn, as [x, y, w, h] including its title bar: the terminal view when its
  // terminal is open, the summary card otherwise (the UI's defaults when no size was stored).
  rectOf(a) {
    const [w, h] = a.terminal ? a.size || TERM_SIZE : a.cardSize || (a.chat || (a.createdBy && a.createdBy !== "user") ? CHAT_SIZE : CARD_SIZE);
    return [a.pos[0], a.pos[1] - TITLE_H, w, (a.collapsed ? 0 : h) + TITLE_H];
  }

  // The node plus what is docked to its right (its panel, then its IDE): the space to keep free around it.
  footprintOf(a) {
    const r = [...this.rectOf(a)];
    for (const [dock, max] of [[a.panel?.spec && a.panel, DOCK_MAX], [a.ide, IDE_MAX]]) {
      if (!dock) continue;
      const ui = dock.ui;
      const [w, h] = ui.collapsed ? [DOCK_COLLAPSED, r[3]] : ui.maximized ? max : ui.size;
      r[2] += DOCK_GAP + w;
      r[3] = Math.max(r[3], h);
    }
    return r;
  }

  // The nearest spot where a new card overlaps no node: right of its creator, or near `near` / the
  // top-left for user-created agents. Real node sizes count, so open terminals and resized nodes are avoided.
  placeNear(parent, near) {
    const rects = [...this.agents.values()].filter((a) => a.pos).map((a) => this.footprintOf(a));
    const [w, h] = parent ? CHAT_SIZE : CARD_SIZE; // an agent made by an agent shows its chat
    const free = (x, y) => rects.every((r) =>
      x + w + GAP <= r[0] || r[0] + r[2] + GAP <= x || y - TITLE_H + h + TITLE_H + GAP <= r[1] || r[1] + r[3] + GAP <= y - TITLE_H);
    const [ox, oy] = parent?.pos ? [parent.pos[0] + this.footprintOf(parent)[2] + 80, parent.pos[1]] : near || [80, 80];
    if (free(ox, oy)) return [ox, oy];
    const STEP = 40;
    let best = null;
    for (let gx = -40; gx <= 60; gx++) {
      for (let gy = -40; gy <= 60; gy++) {
        // nearest first; on ties prefer right of / below the origin
        const d = Math.hypot(gx, gy) - (gx >= 0 ? 0.3 : 0) - (gy >= 0 ? 0.1 : 0);
        if (best && d >= best.d) continue;
        const x = ox + gx * STEP, y = oy + gy * STEP;
        if (y - TITLE_H >= 0 && free(x, y)) best = { x, y, d };
      }
    }
    return best ? [best.x, best.y] : [ox, oy];
  }

  close() {
    for (const a of this.agents.values()) { a.panel?.close(); a.ide?.close(); a.stop(); a.closeTerminal(); a.closeShell(); a.rejectQueued("canvas closed"); }
    this.panelSubs.clear();
    this.flush();
    this.bus.close();
  }
}

// [x, y] from an array or an array-like object ({"0": x, "1": y}, as typed arrays serialize)
function toPos(p) {
  if (!p || typeof p !== "object") return null;
  const x = Number(p[0]), y = Number(p[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [Math.round(x), Math.round(y)] : null;
}

function defaultModelFor(backendName) {
  const b = BACKENDS.find((x) => x.name === backendName);
  return b?.defaultModel || "sonnet";
}

function toRect(r) {
  if (!r || typeof r !== "object") return null;
  const v = [0, 1, 2, 3].map((i) => Number(r[i]));
  if (!v.every(Number.isFinite)) return null;
  return [Math.round(v[0]), Math.round(v[1]), Math.max(140, Math.round(v[2])), Math.max(80, Math.round(v[3]))];
}

function toSize(p, [minW, minH]) {
  const v = toPos(p);
  return v ? [Math.min(4000, Math.max(minW, v[0])), Math.min(3000, Math.max(minH, v[1]))] : null;
}

// An agent's directory: absolute (or ~/...), existing, and not the whole home folder, a system folder or
// where logins and keys live.
const HOME_DIR = homedir();
const OFF_LIMITS = ["/System", "/usr", "/bin", "/sbin", "/etc", "/private/etc", "/var", "/private/var/db", "/Library",
  ...[".ssh", ".aws", ".gnupg", ".claude", ".codex", ".taksim/accounts", ".config/gcloud", "Library"].map((d) => join(HOME_DIR, d))];
export function checkDir(p) {
  if (p === null || p === "") return null;
  if (typeof p !== "string") throw httpError(400, "directories must be absolute paths");
  if (p === "~" || p.startsWith("~/")) p = join(HOME_DIR, p.slice(1));
  if (!p.startsWith("/")) throw httpError(400, "directories must be absolute paths");
  let real;
  try { real = realpathSync(p); } catch { throw httpError(400, `no such directory: ${p}`); }
  if (!statSync(real).isDirectory()) throw httpError(400, `not a directory: ${p}`);
  const tmp = realpathSync(process.env.TMPDIR || "/tmp");
  const under = (d) => real === d || real.startsWith(d + "/");
  if (real === "/" || real === HOME_DIR || (OFF_LIMITS.some(under) && !under(tmp))) {
    throw httpError(400, `${p} can't be an agent's directory; pick a project folder`);
  }
  // NOTE: the resolved path — callers lock and spawn on this, so two spellings of one
  // directory share a lock and a post-check symlink swap can't escape the check.
  return real === "/" ? "/" : real.replace(/\/+$/, "");
}

function pickNumbers(obj, keys) {
  return Object.fromEntries(keys.filter((k) => Number.isFinite(Number(obj[k])) && obj[k] !== undefined)
    .map((k) => [k, Math.max(0, Math.floor(Number(obj[k])))]));
}

// ---------- registry ----------
const canvases = new Map();

export function loadCanvases() {
  for (const id of store.listCanvasIds()) {
    if (canvases.has(id)) continue;
    try { canvases.set(id, new Canvas(store.loadCanvas(id))); }
    catch (e) { console.error(`could not load canvas ${id}: ${e.message}`); }
  }
}

export const listCanvases = () => [...canvases.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((c) =>
  ({ id: c.id, name: c.name, agents: c.agents.size, busy: [...c.agents.values()].filter((a) => a.status === "running").length, createdAt: c.createdAt }));

export const getCanvas = (id) => canvases.get(id);
export const allCanvases = () => [...canvases.values()];

export function createCanvas({ name, vars, limits, autoName } = {}) {
  // no name, or one the app made up ("canvas 3"): the first request in it names it
  const c = new Canvas({ id: shortId(), name: name || "canvas", limits, autoName: !name || autoName === true });
  if (vars?.project_dir) c.vars.project_dir = checkDir(vars.project_dir);
  canvases.set(c.id, c);
  c.flush();
  return c;
}

export function removeCanvas(c) {
  c.close();
  // its conversations stay findable (history.mjs) after the canvas and its files are gone
  for (const a of c.agents.values()) { try { archiveAgent(c, a); } catch { /* not writable: the canvas still goes */ } }
  canvases.delete(c.id);
  store.deleteCanvas(c.id);
}

// Finds the agent an MCP token belongs to.
export function agentByToken(token) {
  for (const c of canvases.values()) for (const a of c.agents.values()) if (a.token === token) return a;
}

export function closeCanvases() {
  for (const c of canvases.values()) c.close();
  canvases.clear();
}

// a thinking level: one the model lists (when its CLI says which), or null for the CLI's default
const EFFORT_BACKENDS = ["claude", "codex", "copilot", "opencode", "fake"]; // the CLIs that take a thinking level (fake: tests)
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"]; // until `claude --help` has been read
function checkEffort(effort, model) {
  if (effort === undefined || effort === null || effort === "") return null;
  const backend = pickBackend(model).backend.name;
  if (!EFFORT_BACKENDS.includes(backend)) throw httpError(400, `${backend} models have no thinking level; leave effort empty`);
  const known = effortsOf(model) || (backend === "claude" ? CLAUDE_EFFORTS : null);
  if (typeof effort !== "string" || !/^[a-z]+$/.test(effort) || (known && !known.includes(effort))) {
    throw httpError(400, `effort must be one of: ${(known || ["low", "medium", "high"]).join(", ")} (or empty for the default)`);
  }
  return effort;
}
