// REST routes for agents' panels: the user edits, approves, resizes and clicks them here. Returns false when
// the path isn't a panel route.
//   GET  /v1/canvases/:id/panels/stream                    data of every panel (SSE)
//   GET|PUT|PATCH|DELETE /v1/canvases/:id/agents/:aid/panel   view · spec (the user's own, so approved) · ui state · remove
//   POST …/panel/approve {always?} · /reject · /refresh {source?} · /action {view, index, row}

import { readJson, sendJson, httpError } from "../http.mjs";
import { getCanvas } from "../canvas/canvas.mjs";
import { Panel } from "../panels/panel.mjs";

export async function panelRoutes(req, res, path) {
  const stream = path.match(/^\/v1\/canvases\/([\w-]+)\/panels\/stream$/);
  if (stream) {
    const canvas = getCanvas(stream[1]);
    if (!canvas) throw httpError(404, `no canvas ${stream[1]}`);
    canvas.streamPanels(req, res);
    return true;
  }
  const m = path.match(/^\/v1\/canvases\/([\w-]+)\/agents\/([\w-]+)\/panel(?:\/(approve|reject|refresh|action|button|inputs))?$/);
  if (!m) return false;
  const canvas = getCanvas(m[1]);
  if (!canvas) throw httpError(404, `no canvas ${m[1]}`);
  const agent = canvas.agents.get(m[2]);
  if (!agent) throw httpError(404, `no agent ${m[2]}`);
  const method = req.method;
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); }) : null;
  const panel = () => {
    if (!agent.panel?.spec) throw httpError(404, `${agent.name} has no panel`);
    return agent.panel;
  };

  if (!m[3]) {
    if (method === "GET") return sendJson(res, 200, { ...panel().view(), data: panel().snapshot() });
    if (method === "PUT") {
      const p = agent.panel || new Panel(agent);
      const view = p.setSpec(body?.spec, { by: "user", keepTool: true });
      agent.panel = p;
      return sendJson(res, 200, view);
    }
    if (method === "PATCH") { panel().setUi(body); return sendJson(res, 200, panel().view()); }
    if (method === "DELETE") { agent.removePanel(); return sendJson(res, 200, { ok: true }); }
    throw httpError(405, "method not allowed");
  }
  if (method !== "POST") throw httpError(405, "method not allowed");
  if (m[3] === "approve") {
    if (body?.always) canvas.updateAgent(agent, { autoApprove: true });
    panel().approve();
    return sendJson(res, 200, panel().view());
  }
  if (m[3] === "reject") { panel().reject(); return sendJson(res, 200, panel().view()); }
  if (m[3] === "refresh") { panel().refresh(body?.source); return sendJson(res, 200, { ok: true }); }
  if (m[3] === "inputs") return sendJson(res, 200, panel().setInputs(body || {}));
  if (m[3] === "button") return sendJson(res, 200, await panel().button(Number(body?.index)));
  return sendJson(res, 200, await panel().action(body || {}));
}
