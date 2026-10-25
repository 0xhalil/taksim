// Computer control over MCP: the first use asks and waits for the person, coordinates map between the agent's
// screenshot and the screen, reading gives clickable refs, Ask/Plan only look, and macOS refusals are explained.
// A stand-in for taksim-computer records what it was told; the real helper is checked when it is built.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-computer-"));
const log = join(home, "helper.log"), deny = join(home, "deny");
const fake = join(home, "fake-helper.mjs");
writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const display = { index: 0, id: 1, x: 0, y: 0, width: 1440, height: 900, scale: 2, main: true };
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, line + "\\n");
  const refuse = existsSync(${JSON.stringify(deny)}) ? readFileSync(${JSON.stringify(deny)}, "utf8").trim() : "";
  const out = (o) => process.stdout.write(JSON.stringify({ id: m.id, ok: true, ...o }) + "\\n");
  if (m.cmd === "status") return out({ screen: true, accessibility: true, displays: [display], cursor: [720, 450] });
  if (refuse && m.cmd !== "windows") return process.stdout.write(JSON.stringify({ id: m.id, ok: false, error: refuse }) + "\\n");
  if (m.cmd === "screenshot") {
    const w = m.region ? m.region[2] : 1440, px = Math.min(m.maxWidth, w * 2) / w;
    return out({ data: "AAAA", width: Math.round(w * px), height: Math.round((m.region ? m.region[3] : 900) * px), origin: m.region ? m.region.slice(0, 2) : [0, 0], pxPerPoint: px, display, cursor: [720, 450] });
  }
  if (m.cmd === "windows") return out({ windows: [{ app: "Notes", pid: 7, title: "Groceries", x: 144, y: 90, width: 720, height: 450 }], frontmost: "Notes", frontmostPid: 7, cursor: [0, 0], displays: [display] });
  if (m.cmd === "read") return out({ app: "Notes", window: "Groceries", nodes: [{ role: "Button", name: "New Note", depth: 0, frame: [180, 100, 36, 24] }, { role: "TextArea", name: "", value: "milk", depth: 1, frame: [300, 200, 400, 300], focused: true }] });
  out({ cursor: [0, 0] });
});
`);
chmodSync(fake, 0o755);
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";
process.env.TAKSIM_COMPUTER_HELPER = fake;
process.env.TAKSIM_COMPUTER_ASK_S = "3";

const { startServer } = await import("../src/server.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");
const { stopHelper } = await import("../src/computer/helper.mjs");
const { forgetComputerView, toScreen, toPicture } = await import("../src/computer/tools.mjs");
const { resetComputerAccess } = await import("../src/computer/access.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { stopHelper(); server.close(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
let rpcId = 0;
async function tool(token, name, args = {}) {
  const r = await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }) });
  return (await r.json()).result;
}
const sent = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function setup(spec = {}) {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo", ...spec })).data;
  const agent = getCanvas(c.id).agents.get(a.id);
  return { c, a, agent, token: agent.token, path: `/v1/canvases/${c.id}/agents/${a.id}/computer` };
}

test("the first computer call waits for the person's one click, then runs; the allowance stays", { skip: process.platform !== "darwin" && "computer control is macOS only" }, async () => {
  const { c, agent, token, path } = await setup();
  const events = [];
  agent.canvas.bus.subs.add((ev) => { if (ev.type === "computer") events.push(ev.data.computer?.state ?? null); });
  const list = await (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  const names = list.result.tools.map((t) => t.name);
  for (const n of ["computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_drag", "computer_read", "computer_windows", "computer_open"]) assert.ok(names.includes(n), n);

  const pending = tool(token, "computer_screenshot");
  await sleep(150);
  assert.equal((await api("GET", path)).data.computer.state, "asking");
  assert.equal((await api("GET", `/v1/canvases/${c.id}`)).data.computer[agent.id].state, "asking");
  assert.equal(agent.status, "waiting");
  assert.equal((await api("POST", path, { allow: true })).status, 200);
  const shot = await pending;
  assert.equal(shot.content[0].type, "image");
  assert.match(textOf(shot), /1280×800 pixels/);
  assert.match(textOf(shot), /Pointer at 640,400/);
  assert.deepEqual(events.slice(0, 2), ["asking", "on"]);
  // remembered across a restart of the engine's memory
  resetComputerAccess();
  assert.equal((await api("GET", path)).data.computer.state, "on");
  assert.deepEqual(JSON.parse(readFileSync(join(home, "computer.json"), "utf8")).agents, [agent.id]);
});

test("declining or not answering ends the wait with a clear answer", async () => {
  const { token, path } = await setup();
  const pending = tool(token, "computer_screenshot");
  await sleep(150);
  await api("POST", path, { allow: false });
  const r = await pending;
  assert.equal(r.isError, true);
  assert.match(textOf(r), /did not allow computer control/);
  const late = await tool(token, "computer_windows"); // nobody answers within TAKSIM_COMPUTER_ASK_S
  assert.equal(late.isError, true);
  assert.match(textOf(late), /hasn't allowed computer control/);
  assert.equal((await api("GET", path)).data.computer, null);
});

test("coordinates are the screenshot's pixels; refs from reading an app are clickable", { skip: process.platform !== "darwin" && "computer control is macOS only" }, async () => {
  const { agent, token, path } = await setup();
  await api("POST", path, { allow: true });
  forgetComputerView(agent.id);
  const before = sent().length;
  await tool(token, "computer_screenshot");
  const click = await tool(token, "computer_click", { x: 640, y: 400, count: 2, modifiers: ["cmd"], screenshot: false });
  assert.match(textOf(click), /Double-clicked/);
  const read = textOf(await tool(token, "computer_read"));
  assert.match(read, /App: Notes — window "Groceries"/);
  assert.match(read, /\[w1\] Button "New Note" @160,89 32×21/);
  assert.match(read, /\[w2\] TextArea @267,178 356×267 = "milk" focused/);
  await tool(token, "computer_click", { ref: "w1", screenshot: false });
  await tool(token, "computer_drag", { from_ref: "w1", to_x: 1280, to_y: 800, screenshot: false });
  await tool(token, "computer_type", { text: "eggs\n", screenshot: false });
  await tool(token, "computer_key", { key: "cmd+s", repeat: 2, screenshot: false });
  await tool(token, "computer_scroll", { x: 0, y: 0, dy: 3, screenshot: false });
  const zoom = await tool(token, "computer_screenshot", { region: [640, 400, 320, 200] });
  assert.match(textOf(zoom), /Zoomed into \[640, 400, 320, 200\]/);
  const wins = textOf(await tool(token, "computer_windows"));
  assert.match(wins, /Notes "Groceries" @128,80 640×400/);
  const cmds = sent().slice(before);
  const by = (c) => cmds.filter((m) => m.cmd === c);
  assert.deepEqual(by("click").map((m) => [m.x, m.y, m.count, m.modifiers.join()]), [[720, 450, 2, "cmd"], [198, 112, 1, ""]]);
  assert.deepEqual([by("drag")[0].fromX, by("drag")[0].toX, by("drag")[0].toY], [198, 1440, 900]);
  assert.equal(by("type")[0].text, "eggs\n");
  assert.deepEqual([by("key")[0].key, by("key")[0].repeat], ["cmd+s", 2]);
  assert.equal(by("scroll")[0].dy, 3);
  assert.deepEqual(by("screenshot").at(-1).region, [720, 450, 360, 225]); // the zoom asks for that part of the screen
  // after acting, a screenshot comes back by default
  const shown = await tool(token, "computer_move", { x: 10, y: 10 });
  assert.equal(shown.content[0].type, "image");
  assert.match(textOf(shown), /Pointer moved/);
});

test("Ask and Plan agents only look; their tool list has no hands", async () => {
  const { token, path, agent } = await setup({ sandbox: "read-only" });
  await api("POST", path, { allow: true });
  const list = await (await fetch(`${base}/mcp/${token}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).json();
  const names = list.result.tools.map((t) => t.name).filter((n) => n.startsWith("computer_"));
  assert.deepEqual(names.sort(), ["computer_read", "computer_screenshot", "computer_windows"]);
  const r = await tool(token, "computer_click", { x: 1, y: 1 });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /needs Agent mode/);
  assert.equal(agent.status !== "waiting", true);
});

test("what macOS hasn't allowed yet is explained and shown on the node", { skip: process.platform !== "darwin" && "computer control is macOS only" }, async () => {
  const { c, agent, token, path } = await setup();
  await api("POST", path, { allow: true });
  writeFileSync(deny, "screen-recording");
  try {
    const r = await tool(token, "computer_screenshot");
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Screen Recording/);
    assert.deepEqual((await api("GET", `/v1/canvases/${c.id}`)).data.computer[agent.id].missing, ["screen"]);
  } finally { rmSync(deny); }
  await tool(token, "computer_screenshot");
  assert.equal((await api("GET", path)).data.computer.missing, undefined);
});

test("removing the agent takes its allowance away", async () => {
  const { c, a, path } = await setup();
  await api("POST", path, { allow: true });
  await api("DELETE", `/v1/canvases/${c.id}/agents/${a.id}`);
  assert.ok(!JSON.parse(readFileSync(join(home, "computer.json"), "utf8")).agents.includes(a.id));
});

test("screenshot pixels and screen points map both ways, on any monitor", () => {
  const v = { origin: [-1728, 179], px: 1280 / 1728 };
  const p = toScreen(v, 640, 100);
  assert.deepEqual([Math.round(p.x), Math.round(p.y)], [-864, 314]);
  assert.deepEqual(toPicture(v, p.x, p.y), [640, 100]);
});

// the real helper, when this Mac has it built: it answers, and says what macOS allows
const real = ["native/.build/release/taksim-computer", "native/.build/debug/taksim-computer"].find((p) => existsSync(p));
test("taksim-computer answers its line protocol", { skip: (process.platform !== "darwin" || !real) && "taksim-computer isn't built" }, () => {
  const r = spawnSync(real, [], { input: '{"id":1,"cmd":"status"}\n{"id":2,"cmd":"windows"}\n{"id":3,"cmd":"nope"}\n', encoding: "utf8", timeout: 20000 });
  const [status, windows, bad] = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(status.ok, true);
  assert.equal(typeof status.screen, "boolean");
  assert.ok(status.displays.length >= 1);
  assert.ok(Array.isArray(windows.windows));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown command/);
});
