// REST + SSE routes for canvases and their agents. Returns false when the path isn't a canvas route.

import { readJson, sendJson, httpError } from "../http.mjs";
import { readTranscript, appendTranscript, listGroupHistory, readGroupVersion, workspaceDir } from "../canvas/store.mjs";
import { turnReview, publicReview, changeReview, reviewStates } from "../canvas/chat-review.mjs";
import { restore, fileDiff, fileInTree, repoTop } from "../canvas/checkpoint.mjs";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative, isAbsolute, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { listCanvases, getCanvas, createCanvas, removeCanvas, allCanvases } from "../canvas/canvas.mjs";
import { langOf, T } from "../lang.mjs";
import { panelRoutes } from "./panels.mjs";
import { ideRoutes } from "./ide.mjs";
import { toolboxRoutes } from "./toolbox.mjs";
import { computerState, setComputer } from "../computer/access.mjs";
import { listHistory, forgetHistory, heldSessions } from "../canvas/history.mjs";
import { listOutsideSessions } from "../canvas/cli-sessions.mjs";
import { branchState, addSet, updateSet, removeSet, switchBranches, switchToSet } from "../canvas/branch-sets.mjs";

// /v1/canvases/:id/branches (each repo's branch, the sets, the active one; POST {set} or {branches} switches)
// and /v1/canvases/:id/branch-sets[/:sid]
async function branchRoutes(req, res, canvas, section, sid) {
  const method = req.method;
  const body = ["POST", "PATCH"].includes(method) ? await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); }) : null;
  if (section === "branches") {
    if (method === "GET") return sendJson(res, 200, await branchState(canvas));
    if (method === "POST") {
      if (body?.set) return sendJson(res, 200, await switchToSet(canvas, body.set));
      if (body?.branches && typeof body.branches === "object") return sendJson(res, 200, await switchBranches(canvas, body.branches));
      throw httpError(400, "set or branches is required");
    }
    throw httpError(405, "method not allowed");
  }
  if (!sid) {
    if (method === "POST") return sendJson(res, 201, await addSet(canvas, body || {}));
    throw httpError(405, "method not allowed");
  }
  if (method === "PATCH") return sendJson(res, 200, updateSet(canvas, sid, body || {}));
  if (method === "DELETE") { removeSet(canvas, sid); return sendJson(res, 200, { ok: true }); }
  throw httpError(405, "method not allowed");
}

// /v1/canvases/:id/groups[/:gid[/context|/history[/:version]]]
async function groupRoutes(req, res, canvas, gid, action, version) {
  const method = req.method;
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); }) : null;
  if (!gid) {
    if (method === "GET") return sendJson(res, 200, { groups: canvas.groups.map((g) => canvas.groupView(g)) });
    if (method === "POST") {
      const g = canvas.addGroup(body);
      if (typeof body.context === "string" && body.context.trim()) canvas.writeContext(g, body.context, "user");
      return sendJson(res, 201, canvas.groupView(g));
    }
    throw httpError(405, "method not allowed");
  }
  const g = canvas.findGroup(gid);
  if (!g) throw httpError(404, `no group ${gid}`);
  if (!action) {
    if (method === "GET") return sendJson(res, 200, { ...canvas.groupView(g), context: canvas.readContext(g), memory: canvas.readMemory(g) });
    if (method === "PATCH" || method === "PUT") { canvas.updateGroup(g, body); return sendJson(res, 200, canvas.groupView(g)); }
    if (method === "DELETE") { canvas.removeGroup(g); return sendJson(res, 200, { ok: true }); }
  }
  if (action === "context") {
    if (method === "GET") return sendJson(res, 200, { content: canvas.readContext(g), version: g.version });
    if (method === "PUT") {
      if (typeof body.content !== "string") throw httpError(400, "content is required");
      return sendJson(res, 200, { version: canvas.writeContext(g, body.content, "user") });
    }
  }
  if (action === "history" && method === "GET") {
    if (version) {
      const content = readGroupVersion(canvas.id, g.id, Number(version));
      if (content === null) throw httpError(404, `no version ${version}`);
      return sendJson(res, 200, { version: Number(version), content });
    }
    return sendJson(res, 200, { versions: listGroupHistory(canvas.id, g.id) });
  }
  throw httpError(405, "method not allowed");
}

// GET /v1/history[?q=]: past conversations, newest first · DELETE /v1/history/:id: gone for good
// POST /v1/canvases/:id/history/:hid {pos}: that conversation continued on this canvas
export async function historyRoutes(req, res, path) {
  const m = path.match(/^\/v1\/history(?:\/([\w-]+))?$/);
  if (!m) return false;
  if (!m[1] && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const query = q.get("q") || "", limit = Number(q.get("limit") || 200);
    // the CLIs' own sessions join in (every AI that worked in a folder), except those taksim's agents hold
    const owned = new Set([...heldSessions(), ...allCanvases().flatMap((c) => [...c.agents.values()].map((a) => a.session))].filter(Boolean));
    const all = [...listHistory({ q: query, limit }), ...await listOutsideSessions({ q: query, owned })];
    return sendJson(res, 200, { conversations: all.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, limit) });
  }
  if (m[1] && req.method === "DELETE") {
    if (!forgetHistory(m[1])) throw httpError(404, `no past conversation ${m[1]}`);
    return sendJson(res, 200, { ok: true });
  }
  throw httpError(405, "method not allowed");
}

export async function canvasRoutes(req, res, path) {
  const hm = path.match(/^\/v1\/canvases\/([\w-]+)\/history\/([\w-]+)$/);
  if (hm) {
    if (req.method !== "POST") throw httpError(405, "method not allowed");
    const canvas = getCanvas(hm[1]);
    if (!canvas) throw httpError(404, `no canvas ${hm[1]}`);
    const body = await readJson(req).catch(() => ({}));
    return sendJson(res, 201, (await canvas.continueConversation(hm[2], body?.pos, body?.models && typeof body.models === "object" ? body.models
      : typeof body?.model === "string" ? { claude: body.model } : null)).view());
  }
  if (/\/agents\/[\w-]+\/(tool|panel\/save)$/.test(path)) return toolboxRoutes(req, res, path);
  if (path.includes("/panel")) {
    const handled = await panelRoutes(req, res, path);
    if (handled !== false) return handled;
  }
  if (path.includes("/ide")) {
    const handled = await ideRoutes(req, res, path);
    if (handled !== false) return handled;
  }
  const gm = path.match(/^\/v1\/canvases\/([\w-]+)\/groups(?:\/([\w-]+))?(?:\/(context|history))?(?:\/(\d+))?$/);
  if (gm) {
    const canvas = getCanvas(gm[1]);
    if (!canvas) throw httpError(404, `no canvas ${gm[1]}`);
    canvas.lang = langOf(req);
    return groupRoutes(req, res, canvas, gm[2], gm[3], gm[4]);
  }
  const bm = path.match(/^\/v1\/canvases\/([\w-]+)\/(branches|branch-sets)(?:\/([\w-]+))?$/);
  if (bm && !(bm[2] === "branches" && bm[3])) {
    const canvas = getCanvas(bm[1]);
    if (!canvas) throw httpError(404, `no canvas ${bm[1]}`);
    canvas.lang = langOf(req);
    return branchRoutes(req, res, canvas, bm[2], bm[3]);
  }
  const m = path.match(/^\/v1\/canvases(?:\/([\w-]+))?(?:\/(events|agents))?(?:\/([\w-]+))?(?:\/(messages|queue|fork|activity|tasks|workflow|job|stop|transcript|terminal|shell|deliver|restore|review|diff|checkpoint|attachments|computer))?$/);
  if (!m) return false;
  const [, canvasId, section, agentId, action] = m;
  const method = req.method;
  // an attachment's body is the image itself, read by its route
  const body = ["POST", "PUT", "PATCH"].includes(method) && action !== "attachments" ? await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); }) : null;

  if (!canvasId) {
    if (method === "GET") return sendJson(res, 200, { canvases: listCanvases() });
    if (method === "POST") return sendJson(res, 201, createCanvas(body).view());
    throw httpError(405, "method not allowed");
  }

  const canvas = getCanvas(canvasId);
  if (!canvas) throw httpError(404, `no canvas ${canvasId}`);
  canvas.lang = langOf(req);

  if (!section) {
    if (method === "GET") return sendJson(res, 200, canvas.view());
    if (method === "PUT" || method === "PATCH") { canvas.update(body); return sendJson(res, 200, canvas.view()); }
    if (method === "DELETE") { removeCanvas(canvas); return sendJson(res, 200, { ok: true }); }
    throw httpError(405, "method not allowed");
  }

  if (section === "events") {
    if (method !== "GET") throw httpError(405, "method not allowed");
    canvas.bus.stream(req, res);
    return true;
  }

  // agents
  if (!agentId) {
    if (method === "GET") return sendJson(res, 200, { agents: canvas.view().agents });
    if (method === "POST") return sendJson(res, 201, canvas.addAgent(body).view());
    throw httpError(405, "method not allowed");
  }

  const agent = canvas.agents.get(agentId);
  if (!agent) throw httpError(404, `no agent ${agentId}`);

  if (!action) {
    if (method === "GET") return sendJson(res, 200, agent.view());
    if (method === "PATCH" || method === "PUT") { canvas.updateAgent(agent, body); return sendJson(res, 200, agent.view()); }
    if (method === "DELETE") { canvas.removeAgent(agent); return sendJson(res, 200, { ok: true }); }
    throw httpError(405, "method not allowed");
  }

  if (action === "transcript" && method === "GET") {
    const limit = Number(new URL(req.url, "http://x").searchParams.get("limit") || 500);
    return sendJson(res, 200, { transcript: readTranscript(canvas.id, agent.id, limit) });
  }

  if (action === "workflow") {
    if (method === "GET") return sendJson(res, 200, { plan: agent.chatPlan || null, question: agent.workflow.pending?.view || null });
    if (method === "PATCH") return sendJson(res, 200, { plan: agent.workflow.edit(body) });
    if (method === "POST") {
      if (body.action === "answer") { agent.workflow.answer(body); return sendJson(res, 200, { ok: true }); }
      if (body.action === "build") return sendJson(res, 202, { plan: agent.workflow.build(body) });
      if (body.action === "revise") return sendJson(res, 200, { plan: agent.workflow.revise(body) });
      if (body.action === "save") return sendJson(res, 201, agent.workflow.save(body));
      if (body.action === "publish") return sendJson(res, 201, { plan: agent.workflow.publish(body, true) });
      throw httpError(400, "unknown workflow action");
    }
    throw httpError(405, "method not allowed");
  }

  // computer control: the node's display key allows it (or answers the agent's ask), or takes it back
  if (action === "computer") {
    if (method === "GET") return sendJson(res, 200, { computer: computerState(agent) });
    if (method === "POST" || method === "PUT") {
      if (typeof body?.allow !== "boolean") throw httpError(400, "allow: true or false");
      setComputer(agent, body.allow);
      return sendJson(res, 200, { computer: computerState(agent) });
    }
    throw httpError(405, "method not allowed");
  }

  if (action === "tasks" && method === "GET") return sendJson(res, 200, { tasks: agent.current ? agent.tasks.items : [] });
  // the work it orchestrates, if any: its parts, who has each, how far they are
  if (action === "job" && method === "GET") return sendJson(res, 200, { job: agent.job || null, resumable: agent.orchestration.resumable });
  // "resume": go on where a stopped or interrupted job left off
  if (action === "job" && method === "POST") {
    if (body?.action !== "resume") throw httpError(400, "unknown job action");
    return sendJson(res, 200, { job: agent.orchestration.resume() });
  }

  if (action === "activity" && method === "GET") {
    return sendJson(res, 200, { activities: agent.current ? [...agent.activities.values()] : [] });
  }

  // A branch has its own CLI session. Its inherited conversation is frozen at the chosen message;
  // checkpoints stay on the original chat because branching never rewinds the shared working folder.
  if (action === "fork" && method === "POST") {
    // capped: context is capped below anyway, and the whole log must not be held in memory
    const history = body.fresh ? [] : readTranscript(canvas.id, agent.id, 20000);
    let end = history.length;
    if (body.at !== undefined) {
      const index = history.findIndex((e) => e.ts === body.at && e.from === body.from && e.text === body.text);
      if (index < 0) throw httpError(409, "message changed; reload the conversation");
      end = index + 1;
    }
    const inherited = history.slice(0, end).filter((e) => ["user", "assistant", "ask", "tell", "reply", "clarification"].includes(e.kind));
    const context = inherited.map((e) => `${e.from === agent.id ? "Assistant" : e.from === "user" ? "User" : e.from}:\n${e.text || ""}` +
      (e.attachments?.length ? `\nAttachments: ${JSON.stringify(e.attachments)}` : "")).join("\n\n");
    if (context.length > 120000) throw httpError(413, "branch context is too large; choose an earlier message");
    const branch = canvas.addAgent({ name: `${agent.name} · ${body.fresh ? T(canvas.lang, "new", "yeni") : T(canvas.lang, "branch", "dal")}`, model: agent.model,
      account: agent.account, effort: agent.effort, cwd: agent.cwd, sandbox: agent.sandbox, permission: agent.permission, system: agent.system,
      role: agent.role, chatMode: agent.chatMode, chat: true, pos: [agent.pos[0] + (agent.cardSize?.[0] || 640) + 40, agent.pos[1]] });
    branch.chatOrigin = { id: agent.id, name: agent.name, at: inherited.at(-1)?.ts || null };
    branch.forkContext = context;
    for (const e of inherited) appendTranscript(canvas.id, branch.id, { ts: e.ts,
      from: e.from === agent.id ? branch.id : e.from, to: e.to === agent.id ? branch.id : e.to,
      kind: e.kind, text: e.text, ...(e.attachments ? { attachments: e.attachments } : {}) });
    canvas.ensureLink(agent.id, branch.id, "message", body.fresh ? "Yeni sohbet" : "Yan sohbet");
    canvas.save();
    canvas.bus.emit("agent_updated", { agent: branch.view() });
    return sendJson(res, 201, branch.view());
  }

  if (action === "queue") {
    if (method === "GET") return sendJson(res, 200, { messages: agent.userQueue() });
    if (method === "PATCH") {
      if (body.order !== undefined) agent.reorderQueued(body.order);
      else {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const old = agent.userQueue().find((i) => i.id === body.id);
        if (!old) throw httpError(409, "message is no longer queued");
        const attachments = body.attachments === undefined ? old.attachments : checkAttachments(body.attachments, canvas);
        if (!text && !attachments.length) throw httpError(400, "text is required");
        agent.editQueued(body.id, text, attachments);
      }
      return sendJson(res, 200, { messages: agent.userQueue() });
    }
    if (method === "POST") {
      agent.cancelQueued(body.id);
      return sendJson(res, 200, { messages: agent.userQueue() });
    }
    throw httpError(405, "method not allowed");
  }

  if (action === "messages" && method === "POST") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const attachments = checkAttachments(body.attachments, canvas);
    if (!text && !attachments.length) throw httpError(400, "text is required");
    const reply = agent.enqueue({ kind: "user", from: null, text, attachments });
    // ?wait=1 (or {"wait": true}) holds the request until the turn finishes; otherwise 202 and follow the events.
    if (body.wait || new URL(req.url, "http://x").searchParams.get("wait")) {
      try { return sendJson(res, 200, { text: await reply }); }
      catch (e) { return sendJson(res, 502, { error: { message: e.message } }); }
    }
    reply.catch(() => {}); // failures are reported through events
    return sendJson(res, 202, { queued: agent.queue.length, status: agent.status });
  }

  if (action === "terminal") {
    if (method === "POST") { await agent.openTerminal(); return sendJson(res, 200, agent.view()); }
    if (method === "DELETE") { agent.closeTerminal(); return sendJson(res, 200, { ok: true }); }
    throw httpError(405, "method not allowed");
  }

  if (action === "shell") {
    if (method === "POST") { agent.openShell(); return sendJson(res, 200, agent.view()); }
    if (method === "DELETE") { agent.closeShell(); return sendJson(res, 200, { ok: true }); }
    throw httpError(405, "method not allowed");
  }

  if (action === "review") {
    const q = new URL(req.url, "http://x").searchParams;
    const input = method === "GET" ? Object.fromEntries(q) : body || {};
    // Trees must belong to this chat's recorded turn, not an arbitrary repository revision.
    const turn = readTranscript(canvas.id, agent.id, 20000).find((e) => e.from === agent.id && e.checkpoint === input.from && e.after === input.to);
    if (!turn || (input.path !== undefined && !turn.changes?.some((c) => c.path === input.path))) throw httpError(404, T(canvas.lang, "this chat has no such change", "Bu sohbetin değişikliği bulunamadı"));
    if (method === "GET" && input.path === undefined) return sendJson(res, 200, reviewStates(agent, input.from, input.to, turn.changes || []));
    if (method === "GET") return sendJson(res, 200, publicReview(await turnReview(agent, input.from, input.to, input.path)));
    if (method !== "POST") throw httpError(405, "method not allowed");
    const dir = agent.workDir();
    if ([...canvas.agents.values()].some((a) => a.workDir() === dir && (a.current || a.terminal || a.queue.length))) throw httpError(409, T(canvas.lang, "something is still working in this folder; wait for it", "Bu klasörde çalışan iş var; bitmesini bekleyin"));
    const guard = { id: agent.id, queue: [] };
    const release = await canvas.lockCwd(dir, guard, new AbortController().signal);
    try { return sendJson(res, 200, await changeReview(agent, await turnReview(agent, input.from, input.to, input.path), input.action, input.hunk)); }
    finally { release(); }
  }

  // the chat's checkpoints: go back to before a turn; one file's diff of a turn
  if (action === "restore" && method === "POST") {
    if (agent.status === "running") throw httpError(409, "the agent is working; stop it first");
    // restore rewrites the whole repo tree, not just the agent's folder: refuse while another
    // agent works anywhere in the same repository, or its in-flight writes would be silently undone.
    const dir = agent.workDir();
    const top = await repoTop(dir).catch(() => null);
    const busy = [...canvas.agents.values()].find((a) => {
      if (a === agent || a.status !== "running") return false;
      if (a.workDir() === dir) return true;
      if (!top) return false;
      return a.workDir() === top || a.workDir().startsWith(top + "/");
    });
    if (busy) throw httpError(409, canvas.lang === "tr" ? `"${busy.name}" aynı klasörde çalışıyor; önce onu durdurun` : `"${busy.name}" is working in the same folder; stop it first`);
    const r = await restore(agent.workDir(), body?.checkpoint).catch((e) => { throw httpError(400, e.message); });
    agent.record({ from: "user", to: agent.id, kind: "restore", text: "", checkpoint: body.checkpoint, redo: r.now });
    return sendJson(res, 200, r);
  }
  if (action === "diff" && method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const [from, to, file] = ["from", "to", "path"].map((k) => q.get(k) || "");
    if (![from, to].every((t) => /^[0-9a-f]{40,64}$/.test(t)) || !file) throw httpError(400, "from, to and path");
    return sendJson(res, 200, { diff: await fileDiff(agent.workDir(), from, to, file) });
  }
  // one file as it was at a checkpoint (or after a turn): the chat's turn diff reads both sides so
  if (action === "checkpoint" && method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const content = await fileInTree(agent.workDir(), q.get("at"), q.get("path")).catch((e) => { throw httpError(400, e.message); });
    return sendJson(res, 200, { content });
  }
  // an image the chat attached, shown back to a client without file access (the web app's thumbnails):
  // only files in this canvas's attachment folder
  if (action === "attachments" && method === "GET") {
    const dir = join(workspaceDir(canvas.id), "attachments");
    const file = resolve(new URL(req.url, "http://x").searchParams.get("path") || "");
    const type = { ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[extname(file).toLowerCase()];
    if (!type || relative(dir, file).startsWith("..") || isAbsolute(relative(dir, file)) || !existsSync(file)) throw httpError(404, "no such attachment");
    res.writeHead(200, { "content-type": type, "cache-control": "private, max-age=3600" });
    return res.end(readFileSync(file));
  }
  // an image pasted into the chat: kept in the canvas workspace, its path goes with the message
  if (action === "attachments" && method === "POST") {
    const type = String(req.headers["content-type"] || "");
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[type.split(";")[0]];
    if (!ext) throw httpError(415, "an image: png, jpeg, gif or webp");
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 20 * 1024 * 1024) throw httpError(413, "at most 20 MB"); chunks.push(c); }
    const dir = join(workspaceDir(canvas.id), "attachments");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`);
    writeFileSync(file, Buffer.concat(chunks));
    return sendJson(res, 201, { path: file });
  }

  if (action === "deliver" && method === "POST") {
    return sendJson(res, 200, { delivered: agent.deliverNow() });
  }

  if (action === "stop" && method === "POST") {
    agent.stop();
    return sendJson(res, 200, { ok: true });
  }

  throw httpError(405, "method not allowed");
}

// What a chat message may carry: files and folders by path, lines picked in the IDE, pasted images, agents.
const KINDS = ["conversation", "file", "folder", "image", "selection", "agent"];
function checkAttachments(list, canvas) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > 20) throw httpError(400, "attachments: a list of at most 20");
  return list.map((a, i) => {
    if (!a || !KINDS.includes(a.kind)) throw httpError(400, `attachments[${i}].kind: one of ${KINDS.join(", ")}`);
    if (a.kind === "conversation") {
      const source = canvas?.agents.get(a.path);
      if (!source) throw httpError(409, "conversation is no longer available");
      const text = readTranscript(canvas.id, source.id, 30).filter((e) => ["user", "assistant", "ask", "tell", "reply", "clarification"].includes(e.kind))
        .map((e) => `${e.from === source.id ? "Assistant" : e.from === "user" ? "User" : e.from}: ${e.text || ""}`).join("\n\n").slice(-32000);
      return { kind: "conversation", path: source.id, name: source.name, text };
    }
    if (a.kind === "agent") return { kind: "agent", name: String(a.name || "").slice(0, 80) };
    if (typeof a.path !== "string" || !a.path) throw httpError(400, `attachments[${i}].path is required`);
    const out = { kind: a.kind, path: a.path.slice(0, 1000) };
    if (a.kind === "selection") Object.assign(out, { from: Number(a.from) || 1, to: Number(a.to) || Number(a.from) || 1, text: String(a.text || "").slice(0, 20000) });
    return out;
  });
}
