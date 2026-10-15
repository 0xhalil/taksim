// REST routes for saved tools and the market. Returns false when the path isn't one of them.
//   GET    /v1/toolbox?q=                 the user's tools (builtin + library), ranked when q is given
//   GET    /v1/toolbox/:id                one tool, with its preview
//   PATCH  /v1/toolbox/:id                rename, edit triggers, summary, notes, param defaults
//   DELETE /v1/toolbox/:id
//   POST   /v1/toolbox/:id/triggers       write the triggers again with a model
//   POST   /v1/toolbox/:id/publish        {shelf, preview}: put it on a market shelf
//   POST   /v1/toolbox/import             {tool}: a tool file someone sent
//   GET    /v1/market?q=                  every shelf's tools · GET /v1/market/shelves
//   POST   /v1/market/install             {shelf, id, as?}
//   DELETE /v1/market/:shelf/:id          take one of this computer's tools off the local shelf
//   GET|POST /v1/market/tools             this taksim as a shelf for others: list · receive {tool}
//   POST   /v1/canvases/:cid/agents/:aid/tool   {tool, params}: open a tool as the agent's panel
//   POST   /v1/canvases/:cid/agents/:aid/panel/save {name}: save the agent's panel as a tool

import { readJson, sendJson, httpError } from "../http.mjs";
import { langOf } from "../lang.mjs";
import { getCanvas } from "../canvas/canvas.mjs";
import { marketRepo, setMarketRepo } from "../toolbox/store.mjs";
import { author, getTool, editTool, deleteTool, searchTools, card, publish, importTool, marketTools, install, unpublish, receive, servedMarket, shelves, saveTool, normalize, trimPreview, slug } from "../toolbox/store.mjs";
import { rank } from "../toolbox/match.mjs";
import { generateTriggers } from "../toolbox/triggers.mjs";
import { openTool } from "../toolbox/mcp.mjs";
import { allCanvases } from "../canvas/canvas.mjs";

const changed = (id) => { for (const c of allCanvases()) c.bus.emit("toolbox_changed", { id }); };

// Triggers by a model, in the background: the tool is saved at once with words from its spec, and gets
// the model's version a little later.
function retrigger(id, agent) {
  const t = getTool(id);
  if (!t) return;
  generateTriggers(t, { agent }).then((g) => {
    const now = getTool(id);
    if (!now) return;
    editTool(id, { summary: now.summary || g.summary, when: g.when, keywords: g.keywords, ...(g.reference && !now.reference ? { reference: g.reference } : {}) });
    changed(id);
  }).catch(() => {});
}

export async function toolboxRoutes(req, res, path) {
  const method = req.method;
  const lang = langOf(req);
  const url = new URL(req.url, "http://x");
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); }) : null;

  // ---------- agent-side: open a tool, save a panel ----------
  const ag = path.match(/^\/v1\/canvases\/([\w-]+)\/agents\/([\w-]+)\/(tool|panel\/save)$/);
  if (ag) {
    if (method !== "POST") throw httpError(405, "method not allowed");
    const canvas = getCanvas(ag[1]);
    if (!canvas) throw httpError(404, `no canvas ${ag[1]}`);
    const agent = canvas.agents.get(ag[2]);
    if (!agent) throw httpError(404, `no agent ${ag[2]}`);
    if (ag[3] === "tool") {
      const { tool, view } = openTool(agent, body?.tool, body?.params || {}, { by: "user" });
      if (tool.instructions) agent.enqueue({ kind: "user", from: null, text: `[The user opened the saved tool "${tool.name}" as your panel. Its notes for you:]\n${tool.instructions}\n\nLook at the panel (panel_read) and tell the user briefly what it shows.` }).catch(() => {});
      return sendJson(res, 200, view);
    }
    if (!agent.panel?.spec) throw httpError(404, `${agent.name} has no panel`);
    const name = String(body?.name || agent.panel.spec.title || agent.name).trim();
    let id = slug(name);
    for (let i = 2; getTool(id); i++) id = `${slug(name).slice(0, 44)}-${i}`;
    const t = saveTool(normalize({ id, name, summary: "", spec: agent.panel.spec, instructions: body?.instructions || "",
      preview: { data: trimPreview(agent.panel.snapshot()), at: Date.now() } }, { origin: "mine" }));
    const g = (await import("../toolbox/triggers.mjs")).heuristicTriggers(t);
    editTool(t.id, { summary: g.summary, when: g.when, keywords: g.keywords });
    agent.panel.tool = { id: t.id, name: t.name, params: {} };
    agent.panel.changed();
    retrigger(t.id, agent);
    changed(t.id);
    return sendJson(res, 200, card(getTool(t.id)));
  }

  // ---------- the user's tools ----------
  if (path === "/v1/toolbox") {
    if (method !== "GET") throw httpError(405, "method not allowed");
    return sendJson(res, 200, { me: author(), tools: searchTools(url.searchParams.get("q")).map((r) => ({ ...card(r.tool, { preview: true }), score: r.score, matched: r.why })) });
  }
  if (path === "/v1/toolbox/import") {
    if (method !== "POST") throw httpError(405, "method not allowed");
    const t = importTool(body?.tool);
    if (!t.when.length) retrigger(t.id);
    changed(t.id);
    return sendJson(res, 200, card(t, { preview: true }));
  }
  const tm = path.match(/^\/v1\/toolbox\/([\w-]+)(?:\/(triggers|publish))?$/);
  if (tm) {
    const id = tm[1];
    if (!tm[2]) {
      if (method === "GET") { const t = getTool(id); if (!t) throw httpError(404, `no tool ${id}`); return sendJson(res, 200, { ...card(t, { preview: true }), learned: t.learned, params: t.params, spec: t.spec }); }
      if (method === "PATCH") { const t = editTool(id, body || {}); changed(id); return sendJson(res, 200, card(t, { preview: true })); }
      if (method === "DELETE") { const r = deleteTool(id, lang); changed(id); return sendJson(res, 200, r); }
      throw httpError(405, "method not allowed");
    }
    if (method !== "POST") throw httpError(405, "method not allowed");
    if (tm[2] === "triggers") {
      const t = getTool(id);
      if (!t) throw httpError(404, `no tool ${id}`);
      const g = await generateTriggers(t);
      const next = editTool(id, { summary: body?.keepSummary ? t.summary : g.summary || t.summary, when: g.when, keywords: g.keywords, ...(g.reference && !t.reference ? { reference: g.reference } : {}) });
      changed(id);
      return sendJson(res, 200, { ...card(next, { preview: true }), by: g.by });
    }
    const r = await publish(id, { shelf: body?.shelf || "local", withPreview: body?.preview !== false, lang });
    changed(id);
    return sendJson(res, 200, r);
  }

  // ---------- market ----------
  if (path === "/v1/market") {
    if (method !== "GET") throw httpError(405, "method not allowed");
    const tools = await marketTools();
    const q = url.searchParams.get("q");
    const list = q ? rank(q, tools).map((r) => ({ ...r.tool, score: r.score, matched: r.why })) : tools.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    return sendJson(res, 200, { shelves: shelves().map(({ id, label }) => ({ id, label })), tools: list.map((t) => ({ ...card(t, { preview: true }), shelf: t.shelf, shelfLabel: t.shelfLabel, installed: t.installed, installedVersion: t.installedVersion, score: t.score, matched: t.matched })) });
  }
  // the shared market's GitHub repository: GET it, PUT {repo} to change it (empty: none)
  if (path === "/v1/market/repo") {
    if (method === "PUT") return sendJson(res, 200, { repo: setMarketRepo(body?.repo) });
    return sendJson(res, 200, { repo: marketRepo() });
  }
  if (path === "/v1/market/shelves") return sendJson(res, 200, { shelves: shelves().map(({ id, label }) => ({ id, label })) });
  if (path === "/v1/market/install") {
    if (method !== "POST") throw httpError(405, "method not allowed");
    const t = await install(String(body?.shelf || ""), String(body?.id || ""), { as: body?.as, by: body?.by || undefined });
    changed(t.id);
    return sendJson(res, 200, card(t, { preview: true }));
  }
  if (path === "/v1/market/tools") {
    if (method === "GET") return sendJson(res, 200, { tools: servedMarket() });
    if (method === "POST") { const t = receive(body?.tool); changed(t.id); return sendJson(res, 200, { ok: true, id: t.id }); }
    throw httpError(405, "method not allowed");
  }
  const mm = path.match(/^\/v1\/market\/([\w-]+)\/([\w-]+)$/);
  if (mm && method === "DELETE") { const r = unpublish(mm[1], mm[2]); changed(mm[2]); return sendJson(res, 200, r); }
  return false;
}
