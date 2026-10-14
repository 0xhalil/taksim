// One agent's IDE in a page of its own (ui/ide.html), for a window outside the canvas such as the native
// app's web view:  /ide/<canvas>/<agent>   or   /ui/ide.html?canvas=<canvas>&agent=<agent>
//   ?theme=light|dark (darcula and contrast show as dark); without it, the canvas's saved choice or the system's.
// It is the same IdeLayer as the dock (ide.mjs), told to fill the window, fed by the canvas's event stream.
// Opening the page opens the IDE if the agent had none.

import { setTheme, themeName } from "./theme.mjs";
import { T } from "./lang.mjs";

const q = new URLSearchParams(location.search);
const [, pathCanvas, pathAgent] = location.pathname.match(/^\/ide\/([\w-]+)\/([\w-]+)/) || [];
const canvasId = pathCanvas || q.get("canvas");
const agentId = pathAgent || q.get("agent");

const want = q.get("theme");
setTheme(want ? (want === "light" ? "light" : "dark") : themeName(), { save: false });

const { IdeLayer } = await import("./ide.mjs");

const toastEl = document.getElementById("toast");
function toast(text) {
  toastEl.textContent = text;
  toastEl.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (toastEl.style.display = "none"), 4000);
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data;
}
const agentPath = (id, rest = "") => `/v1/canvases/${canvasId}/agents/${id}${rest}`;

const ides = new IdeLayer(document.getElementById("ides"), {
  fill: true, api, path: agentPath, toast, canvasId: () => canvasId,
  askAgent: (id, text) => api("POST", agentPath(id, "/messages"), { text }).then(() => toast(T("The agent is looking into it"))).catch((e) => toast(e.message)),
});

// closed from the canvas (or by the agent): the one thing to do here is to open it again
const reopen = document.body.appendChild(document.createElement("button"));
reopen.className = "ibig";
reopen.style.cssText = "position: fixed; inset: 0; color: var(--accent)";
reopen.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4 1.5 8l4 4M10.5 4l4 4-4 4M9.2 2.5 6.8 13.5"/></svg>';
reopen.title = T("Open the IDE");
reopen.hidden = true;
reopen.onclick = () => api("POST", agentPath(agentId, "/ide"), {}).catch((e) => toast(e.message));

async function start() {
  if (!canvasId || !agentId) return toast(T("/ide/<canvas>/<agent>"));
  let canvas;
  try { canvas = await api("GET", `/v1/canvases/${canvasId}`); } catch (e) { return toast(e.message); }
  const agent = canvas.agents.find((a) => a.id === agentId);
  if (!agent) return toast(T("no such agent: {id}", { id: agentId }));
  document.title = `${agent.name} · IDE`;
  const view = agent.ide || await api("POST", agentPath(agentId, "/ide"), {}).catch((e) => { toast(e.message); return null; });
  if (view) ides.set(agentId, view); else reopen.hidden = false;
  const es = new EventSource(`/v1/canvases/${canvasId}/events?since=${canvas.seq}`);
  const mine = (type, fn) => es.addEventListener(type, (m) => { const { data } = JSON.parse(m.data); if (data.id === agentId) fn(data); });
  mine("ide_updated", (d) => { reopen.hidden = !!d.ide; ides.set(agentId, d.ide, d.reveal); });
  mine("ide_files", (d) => ides.filesChanged(agentId, d.paths));
  mine("ide_session", (d) => ides.sessionChanged(agentId, d.session));
  mine("agent_updated", (d) => { if (d.name) document.title = `${d.name} · IDE`; });
}
start();
