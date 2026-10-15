// MCP server (streamable HTTP, JSON responses) at /mcp/<agent-token>. The token identifies the calling
// agent, so every tool acts on that agent's canvas: list, ask (wait), tell (reply comes back later), create,
// and its own panel (panels/tools.mjs).

import { readJson, sendJson } from "../http.mjs";
import { agentByToken } from "../canvas/canvas.mjs";
import { describeModels, tierOf } from "../backends/models.mjs";
import { machineStatus, accountBackends } from "../accounts.mjs";
import { listAccounts, findAccount } from "../accounts.mjs";
import { modeOf, readOnly } from "../canvas/chat-modes.mjs";
import { PANEL_TOOLS, callPanelTool } from "../panels/tools.mjs";
import { IDE_TOOLS, callIdeTool } from "../ide/tools.mjs";
import { TOOLBOX_TOOLS, callToolboxTool, openTool, delegates, splits } from "../toolbox/mcp.mjs";
import { BROWSER_TOOLS, callBrowserTool } from "../browser/tools.mjs";
import { computerTools, callComputerTool } from "../computer/tools.mjs";
import { jevReady, pick } from "../jev.mjs";

const PROTOCOL = "2025-06-18";
const ASK_TIMEOUT_S = Number(process.env.TAKSIM_ASK_TIMEOUT_S || 600);

const TOOLS = [
  { name: "update_todos", description: "Publish real progress for this Agent turn. Replace the list or merge by stable id. Keep at most one task in_progress; mark completed only after checking its result. Do not invent progress.",
    inputSchema: { type: "object", properties: { todos: { type: "array", maxItems: 40, items: { type: "object", properties: { id: { type: "string" }, content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled", "blocked"] } }, required: ["id", "content", "status"] } }, merge: { type: "boolean" } }, required: ["todos"] },
    annotations: { readOnlyHint: true } },
  {
    name: "ask_user", description: "Ask the person one to three consequential clarification questions and wait for their answers. Use only when scope or a decision cannot be resolved from the project. Put titles and short options in the user's language; free-text answers are always possible.",
    inputSchema: { type: "object", properties: { questions: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: { title: { type: "string" }, options: { type: "array", items: { type: "string" }, maxItems: 5 } }, required: ["title"] } } }, required: ["questions"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "propose_plan", description: "Publish the researched implementation plan in Plan mode. The person reviews and edits this persistent Markdown plan before explicitly building a chosen version. Include concrete files, ordered steps and validation; do not implement it yourself.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_agents",
    description: "List the agents on your canvas (name, role, model, account, status, creator), the available models, and the user's named accounts (e.g. work, personal).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true }, // usable in plan mode (read-only agents)
  },
  {
    name: "ask_agent",
    description: "Send a message to another agent and wait for its answer. Use for questions or short tasks whose result you need now. The other agent sees none of your context, so make the message self-contained.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name or id (see list_agents)" },
        message: { type: "string" },
        timeout_s: { type: "number", description: `Max seconds to wait (default ${ASK_TIMEOUT_S})` },
        about: { type: "string", description: "A few words in the user's language on what you ask it (shown on the arrow to it), e.g. \"README çevirisi\"" },
      },
      required: ["agent", "message"],
    },
  },
  {
    name: "tell_agent",
    description: "Send a message to another agent without waiting. Its answer arrives later as a new message to you. Use for longer tasks or to work in parallel.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, message: { type: "string" },
        about: { type: "string", description: "A few words in the user's language on what you hand it (shown on the arrow to it), e.g. \"README çevirisi\"" } },
      required: ["agent", "message"],
    },
  },
  {
    name: "get_context",
    description: "Read the shared memory of the groups you are in (outermost first): goals, decisions, conventions, findings. Your system prompt only has a summary.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "update_context",
    description: "Rewrite or extend a group's shared memory. Only the group's maintainer may do this. Keep it short and current: decisions, conventions, who does what. To add one fact, any member can use remember.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Group name or id" },
        content: { type: "string", description: "Markdown" },
        mode: { type: "string", enum: ["replace", "append"], description: "replace (default) or append to the end" },
      },
      required: ["group", "content"],
    },
  },
  {
    name: "remember",
    description: "Add one entry to the shared memory of a group you are in, so its other members (and later agents) know it: a decision, a finding, a convention, who does what. Keep it to a line or two; the user sees who wrote it and may edit it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The entry, markdown (one line or a short paragraph)" },
        group: { type: "string", description: "Group name or id; defaults to your innermost group" },
      },
      required: ["text"],
    },
    annotations: { readOnlyHint: true }, // writes the group's memory, not the workspace
  },
  {
    name: "plan_work",
    description: "Orchestrate work that clearly pays to split (only when \"Create agents\" is on for you; most work, and most coding, is better done by you alone). State every part once, at most 4. One writer: at most one part may change files; the others read. taksim checks the parts, asks the user before anything starts, creates the agents, runs each part after the parts it depends on and gives it what they found (readers run together), asks the user what to do when a part fails, runs your check commands itself, has the change reviewed from its diff alone by an agent with no knowledge of the conversation, and and tells you once, in a new message, every part's answer, the files that really changed, the checks' results and the review. The call itself returns at once: end your turn after it and wait for that message.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The whole job in a few words, in the user's language" },
        request: { type: "string", description: "What the user asked for, in their words: the reviewer judges the change against this" },
        checks: { type: "array", items: { type: "string" }, description: "Up to 3 shell commands that prove the work, run by taksim in your folder after the writing part ends, e.g. [\"npm test\"]. The user sees them before the work starts. Exit code 0 passes." },
        parts: {
          type: "array",
          description: "The parts. Keep them few: split only what can be done and judged on its own.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short id other parts refer to, e.g. \"api\"" },
              title: { type: "string", description: "A few words in the user's language; it names the agent and is shown to the user" },
              task: { type: "string", description: "Everything the agent needs: what to do, where, what to leave alone. It sees none of your context." },
              files: { type: "array", items: { type: "string" }, description: "Files or folders this part is about" },
              depends_on: { type: "array", items: { type: "string" }, description: "Ids of parts that must be done first" },
              writes: { type: "boolean", description: "true for the one part that changes files or runs modifying commands (at most one in a job); false (default) for research, review, analysis" },
              model: { type: "string", description: "Model id from list_agents' available_models that fits this part best; defaults to yours" },
              effort: { type: "string", description: "Thinking level for that model, when it has them" },
              done_when: { type: "string", description: "What must be true for this part to count as done, e.g. \"pytest tests/auth passes\"" },
              agent: { type: "string", description: "An existing agent to give the part to instead of creating one" },
            },
            required: ["title", "task"],
          },
        },
      },
      required: ["parts"],
    },
  },
  {
    name: "create_agent",
    description: "Create a standing agent the user asked for (\"create an agent that watches the cluster\"). Not for handing out parts of your work: that is plan_work, and this tool refuses it. Give it a role and optionally a first task; its answer to the task comes back to you as a message. Every agent can build a live panel next to itself (commands every N seconds, log streams, tables), so for watching or monitoring work, ask it in the task to set one up. Command and SQL panels require workspace-write access; read-only helpers can investigate and present findings. It works in your directory unless you pass `cwd` (e.g. when the user names another project folder). Pass `account` to run it under one of the user's named accounts (e.g. \"work\", \"personal\"; see list_agents).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string", description: "What this agent is for, e.g. 'reviews diffs for bugs'" },
        model: { type: "string", description: "Model id; defaults to yours (or the account's CLI default). See list_agents for available models and their tiers (light, standard, strong)." },
        effort: { type: "string", description: "Thinking level when the model has them (see list_agents' efforts), e.g. \"low\" for light work; omit for the model's default." },
        account: { type: "string", description: "Name of one of the user's accounts to run it under, e.g. \"work\" or \"personal\" (see list_agents). Use it when the user says which account to use; omit for this machine's default login." },
        system: { type: "string", description: "Extra instructions" },
        sandbox: { type: "string", enum: ["read-only", "workspace-write"], description: "read-only (default) reads and analyzes; workspace-write can also edit files and run commands in its directory." },
        cwd: { type: "string", description: "Absolute path (or ~/...) of the folder it works in; defaults to yours. Use it only when the user points at a specific folder." },
        task: { type: "string", description: "First message to send it (optional)" },
        reason: { type: "string", description: "Why you create it, a few words in the user's language; written on the arrow from you to it so the user knows later what it is for, e.g. \"TR çeviri\" or \"zor bug analizi\"" },
        tool: { type: "string", description: "A saved tool (see find_tools) the new agent starts with: its panel opens next to it and it gets the tool's instructions. Use it when one fits the job, e.g. for \"create an agent and watch kubernetes\"." },
        tool_params: { type: "object", description: "Settings for that tool, e.g. {\"namespace\": \"prod\"}" },
      },
      required: ["name", "role"],
    },
  },
];

// Offered only while Jev (TypeSafe's decision model) is connected: a quick judgment among fixed options.
const JEV_TOOL = {
  name: "decide",
  description: "Ask Jev, a fast decision model, a question with fixed answers and get a probability for each (it writes no text). "
    + "Use it for quick judgments: which model tier a part of the work needs, which existing agent should take a task, whether a command or change looks risky. "
    + "Pass the content as state, the question, and options as {name: what it means}. You get the likeliest option, its confidence and every probability. "
    + "When confidence is low, decide yourself or ask the user. Not for facts, and never a reason to skip the user's approval.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "The content to judge: the task, the command, the message" },
      question: { type: "string", description: "What to decide, e.g. \"Which model tier does this task need?\"" },
      options: { type: "object", description: "The answers to choose from: option name -> what it means, e.g. {\"light\": \"mechanical, small\", \"strong\": \"needs careful design\"}" },
    },
    required: ["state", "question", "options"],
  },
};

const text = (s) => ({ content: [{ type: "text", text: s }] });
const toolError = (s) => ({ content: [{ type: "text", text: s }], isError: true });

const describe = (a) => ({ id: a.id, name: a.name, role: a.role, model: a.model, model_tier: tierOf(a.model || ""), groups: a.canvas.groupsOf(a).map((g) => g.name), account: a.accountName || "default", access: a.sandbox === "read-only" ? "read-only" : "edit", status: a.status,
  created_by: a.createdBy === "user" ? "user" : a.canvas.agents.get(a.createdBy)?.name || a.createdBy });

// Which CLIs can actually answer: installed and signed in on this computer. An orchestrator given every
// installed CLI's models picked one whose login had expired (first real run); its part failed at once.
const signIns = new Map(); // cli -> { ok, at }
async function signedIn(cli) {
  if (cli === "fake" || cli === "local") return true;
  const hit = signIns.get(cli);
  if (hit && Date.now() - hit.at < 60000) return hit.ok;
  const ok = await machineStatus(cli).then((s) => s.loggedIn === true, () => false);
  signIns.set(cli, { ok, at: Date.now() });
  return ok;
}

// the models this agent can hand work to: its own CLI's (it runs, so it is signed in) and those of the other CLIs
// that are signed in on this computer; lightest first, with what they cost
async function availableModels(self, max = 40) {
  const installed = accountBackends().filter((b) => b.installed).map((b) => b.name);
  const usable = new Set([self.backend]);
  for (const cli of installed) if (await signedIn(cli)) usable.add(cli);
  const order = { light: 0, standard: 1, strong: 2 };
  return describeModels(self.canvas.lang)
    .filter((m) => (m.owned_by === "fake" ? process.env.TAKSIM_FAKE === "1" : usable.has(m.owned_by) || m.owned_by === "local"))
    .sort((a, b) => (b.free ? 1 : 0) - (a.free ? 1 : 0) || order[a.tier] - order[b.tier])
    .slice(0, max)
    .map((m) => ({ id: m.id, cli: m.owned_by, tier: m.tier, ...(m.free ? { free: true } : {}), ...(m.efforts ? { efforts: m.efforts } : {}) }));
}

async function callTool(self, name, args = {}) {
  const canvas = self.canvas;
  if (readOnly(self) && ["add_tool", "save_tool", "update_context", "update_todos"].includes(name)) throw new Error("This action needs Agent mode; Ask and Plan only investigate.");
  if (name === "update_todos") return text(JSON.stringify({ todos: self.tasks.update(args) }));
  if (name === "ask_user") return text(await self.workflow.ask(args));
  if (name === "propose_plan") return text(JSON.stringify(self.workflow.publish(args)));
  const target = () => {
    const t = canvas.find(args.agent);
    if (!t) throw new Error(`no agent "${args.agent}" on this canvas; call list_agents`);
    if (readOnly(self) && !readOnly(t))
      throw new Error("Ask and Plan modes can only consult read-only agents. Switch to Agent mode to delegate implementation.");
    if (t === self) throw new Error("you can't message yourself");
    return t;
  };

  if (name === "plan_work") return text(self.orchestration.propose(args, await availableModels(self, Infinity)));

  if (name === "list_agents") {
    const models = await availableModels(self);
    const accounts = listAccounts().map((a) => ({ name: a.name, cli: a.backend,
      ...(a.status?.email ? { email: a.status.email } : {}), logged_in: a.status ? a.status.loggedIn : "unknown" }));
    const groups = canvas.groups.map((g) => ({ name: g.name, members: canvas.groupView(g).members.map((id) => canvas.agents.get(id)?.name),
      maintainer: g.maintainer ? canvas.agents.get(g.maintainer)?.name : null, context_version: g.version }));
    return text(JSON.stringify({ you: self.name, your_account: self.accountName || "default",
      your_groups: canvas.groupsOf(self).map((g) => g.name), groups,
      agents: [...canvas.agents.values()].filter((a) => a !== self).map(describe),
      available_models: models, accounts, limits: canvas.limits }, null, 2));
  }

  if (name === "ask_agent") {
    const other = target();
    if (canvas.waitsOn(other, self)) {
      throw new Error(`"${other.name}" is waiting on you, so asking it would deadlock. Answer first, or use tell_agent.`);
    }
    const timeout = Math.max(1, Number(args.timeout_s) || ASK_TIMEOUT_S) * 1000;
    self.waitingOn.add(other.id);
    self.setStatus("waiting");
    canvas.wakeLockWaiters();
    let timer;
    const reply = other.enqueue({ kind: "ask", from: self.id, text: String(args.message), about: args.about });
    try {
      return text(await Promise.race([reply, new Promise((_, reject) => {
        timer = setTimeout(() => {
          // still queued: withdraw it; already running: let it finish, the answer is dropped
          const i = other.queue.findIndex((q) => q.from === self.id && q.kind === "ask");
          if (i >= 0) other.queue.splice(i, 1);
          reject(new Error(`"${other.name}" did not answer within ${timeout / 1000}s (status: ${other.status}). Try tell_agent instead.`));
        }, timeout);
      })]));
    } finally {
      clearTimeout(timer);
      reply.catch(() => {});
      self.waitingOn.delete(other.id);
      if (self.current) self.setStatus("running");
      canvas.wakeLockWaiters();
    }
  }

  if (name === "tell_agent") {
    const other = target();
    other.enqueue({ kind: "tell", from: self.id, text: String(args.message), about: args.about }).catch(() => {});
    return text(`Sent to "${other.name}". Its answer will arrive as a new message to you; you don't need to wait for it.`);
  }

  if (name === "get_context") {
    const groups = canvas.groupsOf(self);
    if (!groups.length) return text("You are not in any group, so there is no shared context.");
    self.seenGroups = Object.fromEntries(groups.map((g) => [g.id, g.version]));
    for (const g of groups) canvas.bus.emit("group_updated", { group: canvas.groupView(g) }); // the user sees who has read it
    return text(groups.map((g) => {
      const who = g.maintainer ? canvas.agents.get(g.maintainer)?.name : null;
      return `# ${g.name} (v${g.version}${g.maintainer === self.id ? ", you keep it: update_context rewrites it" : who ? `, maintained by ${who}` : ""})\n\n${canvas.readContext(g).trim() || "(empty)"}`;
    }).join("\n\n"));
  }

  if (name === "remember") {
    const mine = canvas.groupsOf(self);
    if (!mine.length) throw new Error("You are not in any group, so there is no shared memory. The user groups agents by framing them on the canvas.");
    const g = args.group ? canvas.findGroup(args.group) : mine[mine.length - 1];
    if (!g || !mine.includes(g)) throw new Error(`you are not in group "${args.group}"; your groups: ${mine.map((x) => x.name).join(", ")}`);
    if (!String(args.text || "").trim()) throw new Error("text is empty");
    const v = canvas.remember(g, args.text, self.id);
    self.seenGroups = { ...(self.seenGroups || {}), [g.id]: v };
    return text(`Remembered in "${g.name}" (v${v}).`);
  }

  if (name === "update_context") {
    const g = canvas.findGroup(args.group);
    if (!g) throw new Error(`no group "${args.group}"; groups: ${canvas.groups.map((x) => x.name).join(", ") || "none"}`);
    if (g.maintainer !== self.id) {
      const who = g.maintainer ? canvas.agents.get(g.maintainer)?.name : null;
      throw new Error(`only the group's maintainer can change its context (${who ? `"${who}"` : "the user; no agent is assigned"}). To add one fact, use remember; to change more, ask them or tell the user.`);
    }
    const content = args.mode === "append" ? `${canvas.readContext(g).trimEnd()}\n\n${args.content}` : String(args.content);
    const v = canvas.writeContext(g, content, self.id);
    self.seenGroups = { ...(self.seenGroups || {}), [g.id]: v };
    return text(`Updated "${g.name}" context to v${v}. Members see it from their next message.`);
  }

  if (name === "decide") {
    if (!jevReady()) throw new Error("Jev isn't connected: the user can add a TypeSafe key under Settings > Connections. Decide yourself.");
    const options = args?.options;
    if (!options || typeof options !== "object" || Object.keys(options).length < 2) throw new Error("options: an object with at least two answers (name -> what it means)");
    const r = await pick({ state: String(args.state || ""), instructions: String(args.question || ""), options });
    if (!r) throw new Error("Jev could not answer (key refused, slow or unreachable). Decide yourself.");
    return text(JSON.stringify(r));
  }

  if (name === "create_agent") {
    // Two ways an agent comes to be, and this tool is only one of them. A standing agent the person asked for in
    // so many words ("create an agent that watches the cluster") is made here. The parts of a piece of work go
    // through plan_work, switch on or off: only there does the person approve first, does one agent write, and is
    // the result checked. A model told this in its prompt alone made four agents here instead (first real run).
    const asks = [...(self.asks || []), self.lastAsk].map((t) => String(t || ""));
    const named = asks.some((t) => /create_agent/.test(t)); // the tool named outright (tests, power users)
    if (!named && asks.some(splits)) {
      throw new Error("The user asked for this work to be split across agents: hand the parts out with plan_work (one call naming every part), not create_agent. "
        + "plan_work asks them to start it, runs the parts, checks the result and sends you everything in one message.");
    }
    if (!named && !asks.some(delegates)) {
      throw new Error(self.delegate
        ? "create_agent is for an agent the user asked for by name or purpose. To hand out parts of your work, use plan_work (one call naming every part): the user approves it, taksim runs and checks it, and you get the results in one message. Or do the work yourself."
        : "Create agents is off for you and nobody asked you for a new agent. Do the work yourself, or give it to an agent that already exists "
          + "(list_agents, ask_agent, tell_agent). If a new agent would really help, tell the user: they can ask you to create one, or turn on \"Create agents\" in your node's title.");
    }
    if (args.account && !findAccount(args.account)) {
      throw new Error(`no account "${args.account}"; accounts: ${listAccounts().map((a) => `${a.name} (${a.backend})`).join(", ") || "none"}`);
    }
    const agent = canvas.addAgent({
      name: args.name, role: args.role, model: args.model, effort: args.effort, account: args.account, system: args.system, sandbox: args.sandbox, cwd: args.cwd,
    }, { createdBy: self.id, parent: self, reason: args.reason });
    let tool = null;
    if (args.tool) {
      try {
        const r = openTool(agent, args.tool, args.tool_params || {}, { phrase: self.lastAsk });
        tool = { name: r.tool.name, status: r.view.status };
        if (r.tool.instructions) { agent.system = [agent.system, `You started with the saved tool "${r.tool.name}" as your panel. Its notes:\n${r.tool.instructions}`].filter(Boolean).join("\n\n"); canvas.save(); }
      } catch (e) { tool = { error: e.message }; }
    }
    if (args.task) agent.enqueue({ kind: "tell", from: self.id, text: String(args.task), about: args.reason }).catch(() => {});
    return text(JSON.stringify({ created: describe(agent), ...(tool ? { tool } : {}),
      note: args.task ? "It is working on the task; its answer will arrive as a new message to you." : "Use ask_agent or tell_agent to give it work." }));
  }

  const panel = await callBrowserTool(self, name, args) || await callComputerTool(self, name, args) || await callPanelTool(self, name, args) || await callIdeTool(self, name, args) || await callToolboxTool(self, name, args);
  if (panel) return panel;
  throw new Error(`unknown tool ${name}`);
}

async function dispatch(self, msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (method === "initialize") {
      return ok({ protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {} },
        serverInfo: { name: "taksim", version: "0.2.0" },
        instructions: `You are agent "${self.name}" on a taksim canvas. These tools reach the other agents on it, `
          + "and build your panel: a live view next to you (find_tools for saved ones first, then list_bricks, panel_open). Open one on your own when your work involves "
          + "something the user would watch: services, clusters, logs, builds, findings. "
          + `create_agent accepts "account" to choose which of the user's accounts the new agent uses`
          + (listAccounts().length ? ` (accounts: ${listAccounts().map((a) => `${a.name} [${a.backend}]`).join(", ")}).` : " (none set up yet).")
          + (computerTools(self).length ? " The computer_ tools see and drive the user's Mac (other apps, the desktop); the first one asks the user to allow it. Use them when the work is outside a browser page and your shell." : "")
          + (jevReady() ? " decide asks Jev, a fast decision model, to pick among options you name (a model tier for a part, an agent for a task, how risky a change is): use it when a quick judgment helps." : "") });
    }
    if (method === "ping") return ok({});
    // Claude Code defers MCP tools behind a search, so an agent sees only their names and rarely reaches for
    // its panel or IDE on its own; these few are always loaded with their descriptions.
    if (method === "tools/list") return ok({ tools: [...TOOLS, ...(jevReady() ? [JEV_TOOL] : []), ...TOOLBOX_TOOLS, ...PANEL_TOOLS, ...IDE_TOOLS, ...BROWSER_TOOLS, ...computerTools(self)].filter((t) => t.name === "update_todos" ? !readOnly(self) : t.name === "propose_plan" ? modeOf(self) === "plan" : !readOnly(self) || !["add_tool", "save_tool", "update_context"].includes(t.name)).map((t) => ({ ...t, _meta: { "anthropic/alwaysLoad": true } })) });
    if (method === "tools/call") {
      try { return ok(await callTool(self, params?.name, params?.arguments)); }
      catch (e) { return ok(toolError(e.message)); }
    }
    return fail(-32601, `method not found: ${method}`);
  } catch (e) {
    return fail(-32603, e.message);
  }
}

export async function mcpRoute(req, res, token) {
  const self = agentByToken(token);
  if (!self) return sendJson(res, 404, { error: { message: "unknown MCP token" } });
  if (req.method === "GET") { res.writeHead(405, { allow: "POST" }); return res.end(); } // no server-initiated stream
  if (req.method === "DELETE") { res.writeHead(200); return res.end(); }
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }

  let body;
  try { body = await readJson(req); } catch { return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const batch = Array.isArray(body) ? body : [body];
  const requests = batch.filter((m) => m && m.id !== undefined && m.method);
  if (!requests.length) { res.writeHead(202); return res.end(); } // notifications only
  const replies = await Promise.all(requests.map((m) => dispatch(self, m)));
  sendJson(res, 200, Array.isArray(body) ? replies : replies[0]);
}
