// Saved tools: matching messages to tools, saving a panel as a tool (by an agent over MCP, or by the user),
// using one with params, hints with messages, renaming, the market (folder and remote shelves) and imports.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_AUTHOR = "ayse";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");
const { rank, suggest, tokens, similar } = await import("../src/toolbox/match.mjs");
const { listTools, normalize, parametrize, fillParams, similarTools } = await import("../src/toolbox/store.mjs");

let server, base;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const newCanvas = async () => (await api("POST", "/v1/canvases", {})).data;
const addAgent = async (cid, spec) => (await api("POST", `/v1/canvases/${cid}/agents`, spec)).data;
const say = async (cid, aid, text) => (await api("POST", `/v1/canvases/${cid}/agents/${aid}/messages`, { text, wait: true })).data;
const call = (tool, args) => `CALL ${JSON.stringify({ tool, args })}`;
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(50);
  }
}

// ---------- matching ----------

test("Turkish suffixes and aliases still match", () => {
  assert.deepEqual(tokens("Kubernetes'e bak, pod'ları göster"), ["kubernetes", "pod"]);
  assert.equal(similar("pod", "podlari"), 0.8);
  assert.equal(similar("izle", "izliyor"), 0);
  assert.equal(similar("izle", "izlesin"), 0.8);
});

test("builtin tools are found for what people say, and nothing for small talk", () => {
  const tools = listTools();
  const top = (q) => suggest(q, tools)[0]?.tool.id;
  assert.equal(top("agent oluştur kubernetes'e bak"), "k8s-pods");
  assert.equal(top("pod'lar neden sürekli çöküyor"), "k8s-pods");
  assert.equal(top("docker container durumlarını izle"), "docker-containers");
  assert.equal(top("app.log dosyasındaki hataları takip et"), "log-file");
  assert.equal(top("makine çok yavaşladı"), "top-processes");
  assert.equal(top("disk doldu galiba"), "disk-usage");
  assert.equal(top("hangi pod çok CPU yiyor"), "k8s-top");
  assert.equal(top("rollout bitti mi"), "k8s-deployments");
  assert.equal(top("cloud run servislerine bak"), "gcp-cloud-run");
  assert.equal(top("gke cluster'larına bak"), "gcp-gke");
  assert.equal(top("gcp loglarına bak"), "gcp-logs");
  assert.equal(top("vm'lere bak"), "gcp-compute");
  assert.equal(top("ci geçti mi"), "ci-runs");
  assert.equal(top("site yavaş mı"), "http-latency");
  assert.equal(top("review bekleyen PR'lar"), "pr-queue");
  assert.equal(top("issue'lar kimde"), "issues-by-owner");
  assert.equal(top("en son ne zaman deploy ettik"), "deploy-history");
  assert.equal(top("kim kaç commit attı"), "team-activity");
  assert.equal(suggest("merhaba nasılsın", tools).length, 0);
  assert.equal(suggest("bu fonksiyondaki bugı bul", tools).length, 0);
  // everyday coding requests share words with tools ("run", "test", "log" in "login") without being about them
  for (const q of ["selam", "selam yazıyorum", "run the tests", "write tests for login", "fix the login bug", "long running task",
    "My fix request for the a.txt change: use lowercase"]) assert.equal(suggest(q, tools).length, 0, q);
});

test("a tool is offered for its subject, never for words it only learned from an earlier message", () => {
  const tool = { id: "k8s-pods", name: "Kubernetes pod'ları", keywords: ["kubernetes", "pod"], when: ["kubernetes'e bak", "cluster'daki pod'ları izle"],
    learned: ["selam kubernetes adtech'i izler misin"] };
  const other = { id: "notlar", name: "Notlar", keywords: ["not"], when: ["notlarımı göster"] };
  assert.equal(suggest("selam", [tool, other]).length, 0);
  assert.equal(suggest("selam adtech nasıl gidiyor", [tool, other]).length, 0, "learned words alone");
  assert.equal(suggest("kubernetes'e bak", [tool, other])[0]?.tool.id, "k8s-pods");
  assert.equal(suggest("adtech podlarını izler misin", [tool, other])[0]?.tool.id, "k8s-pods", "the subject, helped by what was learned");
  assert.equal(rank("selam", [tool, other]).length, 0, "a greeting isn't a search word either");
});

test("every builtin tool is complete, its spec validates and its preview feeds every view", () => {
  const builtin = listTools().filter((t) => t.origin === "builtin");
  assert.ok(builtin.length >= 18);
  for (const t of builtin) {
    const n = normalize(t, { origin: "builtin" }); // throws with what's wrong
    assert.ok(n.name && n.summary && n.instructions && n.reference?.product, t.id);
    assert.ok(n.when.length >= 6 && n.keywords.length >= 5, `${t.id}: when/keywords`);
    if (Object.values(t.spec.sources).some((s) => s.brick === "command")) assert.ok(n.requires.bin.length, `${t.id}: requires.bin`);
    assert.ok(n.preview, `${t.id}: preview survives normalize (size limit)`);
    for (const v of t.spec.views) {
      if (!v.source) continue;
      assert.ok(t.preview.data[v.source] !== undefined, `${t.id}: preview data for ${v.id}`);
      // a live chart (no x) needs a short history in the preview to look like one
      if (v.brick === "chart" && !v.x) assert.ok(t.preview.series?.[v.id]?.length >= 10, `${t.id}: preview series for ${v.id}`);
    }
  }
  const series = normalize({ name: "seri", spec: { sources: { s: { brick: "agent" } }, views: [{ id: "c", brick: "chart", source: "s" }] },
    preview: { data: { s: [] }, series: { c: [1, "2", [3, 4], "x", null] } } });
  assert.deepEqual(series.preview.series, { c: [1, 2, [3, 4], 0] });
});

test("learned phrases and use counts lift a tool", () => {
  const a = { id: "a", name: "Kuyruk", summary: "", when: [], keywords: ["rabbitmq"], spec: {} };
  const b = { ...a, id: "b", learned: ["sipariş kuyruğu tıkandı mı"] };
  const r = rank("sipariş kuyruğu tıkandı", [a, b]);
  assert.equal(r[0].tool.id, "b");
});

test("not_when keeps lookalike needs away", () => {
  const base = { id: "db", name: "DB", summary: "", when: ["slow database queries"], keywords: ["postgres", "sql"] };
  assert.ok(rank("postgres slow queries", [base])[0].score > 0);
  assert.deepEqual(rank("postgres slow queries", [{ ...base, not_when: ["postgres slow queries"] }]), []);
});

test("thin triggers are filled from the spec; dead parts are reported", () => {
  const t = normalize({ name: "diskim", when: [], keywords: [],
    spec: { title: "Disk", sources: {
      df: { brick: "command", run: ["df", "-k"], parse: "columns" },
      dead: { brick: "command", run: ["uptime"], parse: "lines" },
    }, views: [{ brick: "table", source: "df" }] } });
  assert.ok(t.when.length >= 3 && t.keywords.length >= 3);
  assert.match(t.coherence.join(";"), /sources\.dead: no view shows it/);
  assert.deepEqual(normalize({ name: "ok", when: ["a", "b", "c"], keywords: ["d", "e", "f"],
    spec: { title: "Ok", sources: { s: { brick: "agent" } }, views: [{ brick: "markdown", source: "s" }] } }).coherence, []);
});

test("a near-duplicate panel is refused at save, with the original named", async () => {
  const c = await newCanvas();
  const maker = await addAgent(c.id, { name: "maker2", model: "fake-delegate" });
  const spec = { title: "Disk", sources: { df: { brick: "command", run: ["df", "-h"], parse: "columns" } }, views: [{ brick: "table", source: "df" }] };
  await say(c.id, maker.id, call("panel_open", { spec }));
  const first = await say(c.id, maker.id, call("save_tool", { name: "Disk A", summary: "disk kullanımı",
    when: ["disk durumunu göster"], keywords: ["disk"] }));
  assert.match(first.text, /"saved": "disk-a"/);
  const second = await say(c.id, maker.id, call("save_tool", { name: "Disk B", summary: "disk kullanımı",
    when: ["disk durumunu göster"], keywords: ["disk"] }));
  assert.match(second.text, /looks like the saved tool "Disk A" \(disk-a/);
  assert.deepEqual(similarTools({ spec, when: ["disk durumunu göster"], keywords: ["disk"] })[0].id, "disk-a");
  await api("DELETE", `/v1/canvases/${c.id}`);
});

// ---------- params ----------

test("params: values become {{name}} and fill back in; undeclared params are rejected", () => {
  const spec = { title: "k8s prod", sources: { p: { brick: "command", run: ["kubectl", "get", "pods", "-n", "prod", "--context", "kind-dev"], parse: "columns" } }, views: [{ brick: "table", source: "p" }] };
  const p = parametrize(spec, { namespace: { value: "prod" }, context: { value: "kind-dev" } });
  assert.deepEqual(p.sources.p.run, ["kubectl", "get", "pods", "-n", "{{namespace}}", "--context", "{{context}}"]);
  assert.equal(p.title, "k8s {{namespace}}");
  assert.deepEqual(fillParams(p, { namespace: "qa", context: "x" }).sources.p.run.slice(-3), ["qa", "--context", "x"]);
  assert.throws(() => normalize({ name: "x", spec: p, params: { namespace: {} } }), /doesn't declare/);
  // docker's own {{json .}} isn't a param
  const d = normalize({ name: "dk", spec: { sources: { s: { brick: "command", run: ["docker", "ps", "--format", "{{json .}}"], parse: "jsonl" } }, views: [{ brick: "table", source: "s" }] } });
  assert.deepEqual(d.requires.bin, ["docker"]);
});

// ---------- agents ----------

test("an agent saves its panel as a tool with its own triggers; another agent finds and uses it with params", async () => {
  const c = await newCanvas();
  const maker = await addAgent(c.id, { name: "maker", model: "fake-delegate" });
  const spec = { title: "Kuyruk orders", sources: { q: { brick: "command", run: ["rabbitmqctl", "list_queues", "-p", "orders"], parse: "columns", every_s: 5 } },
    views: [{ id: "q", brick: "table", source: "q" }] };
  await say(c.id, maker.id, call("panel_open", { spec }));
  const saved = await say(c.id, maker.id, call("save_tool", { name: "RabbitMQ kuyrukları", summary: "Bir vhost'taki kuyruklar ve birikmiş mesajlar",
    when: ["kuyruklar birikti mi", "rabbitmq kuyruklarını izle", "watch rabbit queues"], keywords: ["rabbitmq", "queue", "kuyruk", "amqp"],
    params: { vhost: { value: "orders", desc: "virtual host" } }, instructions: "Look at messages_ready.",
    reference: { product: "RabbitMQ management UI", url: "https://www.rabbitmq.com/docs/management", borrowed: ["ready/unacked per queue"] } }));
  assert.match(saved.text, /"saved": "rabbitmq-kuyruklari"/);
  const tool = (await api("GET", "/v1/toolbox/rabbitmq-kuyruklari")).data;
  assert.deepEqual(tool.spec.sources.q.run, ["rabbitmqctl", "list_queues", "-p", "{{vhost}}"]);
  assert.equal(tool.params.vhost.default, "orders");
  assert.equal(tool.author, "ayse");
  assert.equal(tool.origin, "mine");
  assert.equal(tool.reference.product, "RabbitMQ management UI");
  assert.ok(tool.preview, "a preview sample is saved with it");
  assert.equal(getCanvas(c.id).agents.get(maker.id).panel.tool.id, "rabbitmq-kuyruklari");

  // another agent: the message comes with a hint naming the tool (fake-echo answers with what it got)
  const other = await addAgent(c.id, { name: "other", model: "fake-echo" });
  const echoed = await say(c.id, other.id, "rabbitmq kuyrukları birikti mi bakar mısın");
  assert.match(echoed.text, /saved tools that look relevant[\s\S]*rabbitmq-kuyruklari/);
  // named once per agent
  assert.doesNotMatch((await say(c.id, other.id, "rabbitmq kuyruklarına tekrar bak")).text, /rabbitmq-kuyruklari/);
  assert.doesNotMatch((await say(c.id, other.id, "merhaba")).text, /saved tools/);

  const user = await addAgent(c.id, { name: "user", model: "fake-delegate" });
  const design = await say(c.id, user.id, call("design_tool", { need: "rabbitmq kuyrukları birikiyor mu izle" }));
  assert.match(design.text, /steps[\s\S]*RabbitMQ management UI/);
  const found = await say(c.id, user.id, call("find_tools", { query: "rabbit queue backlog" }));
  assert.match(found.text, /rabbitmq-kuyruklari/);
  const used = await say(c.id, user.id, `sipariş kuyruğu tıkandı mı\n${call("use_tool", { tool: "RabbitMQ kuyrukları", params: { vhost: "billing" } })}`);
  assert.match(used.text, /"opened": "RabbitMQ kuyrukları"/);
  assert.match(used.text, /Look at messages_ready/);
  const panel = getCanvas(c.id).agents.get(user.id).panel;
  assert.deepEqual(panel.spec.sources.q.run, ["rabbitmqctl", "list_queues", "-p", "billing"]);
  assert.equal(panel.status(), "pending", "the agent's pick still needs the user's approval");
  const after = (await api("GET", "/v1/toolbox/rabbitmq-kuyruklari")).data;
  assert.equal(after.uses, 1);
  assert.ok(after.learned.some((p) => p.includes("sipariş kuyruğu tıkandı mı")), "the request that led to it is learned");

  // a param without a default must be given
  const k8s = await say(c.id, user.id, call("use_tool", { tool: "k8s-pods" }));
  assert.match(k8s.text, /ERROR "Kubernetes pod'ları" needs: context/);
});

test("create_agent starts an agent with a tool's panel and notes", async () => {
  const c = await newCanvas();
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  const out = await say(c.id, lead.id, call("create_agent", { name: "k8s", role: "watches the cluster", model: "fake-echo", sandbox: "workspace-write", tool: "k8s-pods", tool_params: { context: "kind-dev", namespace: "shop" } }));
  assert.match(out.text, /"tool":\{"name":"Kubernetes pod'ları","status":"pending"\}/);
  const a = [...getCanvas(c.id).agents.values()].find((x) => x.name === "k8s");
  assert.ok(a.panel.spec.sources.pods.run.includes("shop"));
  assert.match(a.system, /Its notes/);
});

// ---------- user ----------

test("the user saves a panel, renames the tool, edits triggers, sets it up on an agent (approved)", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "a", model: "fake-echo" });
  const spec = { title: "Disk", sources: { df: { brick: "command", run: ["df", "-k"], parse: "columns" } }, views: [{ brick: "table", source: "df" }] };
  await api("PUT", `/v1/canvases/${c.id}/agents/${a.id}/panel`, { spec });
  const saved = await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/panel/save`, { name: "Benim diskim" });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.id, "benim-diskim");
  assert.ok(saved.data.keywords.includes("df"), "words from the spec until a model writes triggers");
  // the model step (fake-echo can't write JSON triggers) falls back to the spec's words
  const tr = await api("POST", "/v1/toolbox/benim-diskim/triggers", {});
  assert.equal(tr.data.by, "spec");

  const ren = await api("PATCH", "/v1/toolbox/benim-diskim", { name: "Disk (mac)", when: ["disk doldu mu", "yer kaldı mı"] });
  assert.equal(ren.data.name, "Disk (mac)");
  assert.equal(ren.data.id, "benim-diskim");
  assert.equal(suggest("diskte yer kaldı mı", listTools().filter((t) => t.id === "benim-diskim"))[0]?.tool.id, "benim-diskim");

  // a builtin renamed is the user's copy; deleting it brings the original back
  await api("PATCH", "/v1/toolbox/disk-usage", { name: "Diskler" });
  assert.equal((await api("GET", "/v1/toolbox/disk-usage")).data.name, "Diskler");
  assert.equal((await api("DELETE", "/v1/toolbox/disk-usage")).data.restored, "builtin");
  assert.equal((await api("GET", "/v1/toolbox/disk-usage")).data.name, "Disk doluluğu");

  const b = await addAgent(c.id, { name: "b", model: "fake-echo" });
  const r = await api("POST", `/v1/canvases/${c.id}/agents/${b.id}/tool`, { tool: "benim-diskim" });
  assert.equal(r.data.status, "running", "the user picked it, so it is approved");
  assert.equal(r.data.tool.id, "benim-diskim");

  const list = (await api("GET", "/v1/toolbox?q=disk doldu")).data.tools;
  assert.ok(["benim-diskim", "disk-usage"].includes(list[0].id));
  assert.ok(list[0].preview, "cards carry the preview");
});

// ---------- market ----------

test("publish to the local shelf and to another taksim, install with a version, without private traces", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "a", model: "fake-echo" });
  await api("PUT", `/v1/canvases/${c.id}/agents/${a.id}/panel`, { spec: { title: "Up", sources: { u: { brick: "command", run: ["uptime"], parse: "lines" } }, views: [{ brick: "log", source: "u" }] } });
  await api("POST", `/v1/canvases/${c.id}/agents/${a.id}/panel/save`, { name: "Uptime" });
  await api("PATCH", "/v1/toolbox/uptime", { when: ["sistem ne zamandır açık"] });
  writeFileSync(join(home, "toolbox", "uptime.json"), JSON.stringify({ ...(await api("GET", "/v1/toolbox/uptime")).data, learned: ["gizli bir mesaj"], uses: 4 }));

  const pub = await api("POST", "/v1/toolbox/uptime/publish", { shelf: "local", preview: false });
  assert.equal(pub.status, 200);
  const onShelf = (await api("GET", "/v1/market")).data.tools.find((t) => t.id === "uptime");
  assert.equal(onShelf.author, "ayse");
  assert.equal(onShelf.installed, true);
  assert.equal(onShelf.preview, null, "preview left out on request");
  assert.equal(onShelf.learned, 0, "learned phrases stay private");
  assert.equal(onShelf.uses, 0);

  // another taksim's market: this server, reached over HTTP
  process.env.TAKSIM_MARKET = base;
  const remote = await api("POST", "/v1/toolbox/uptime/publish", { shelf: "s1" });
  assert.equal(remote.status, 200, JSON.stringify(remote.data));
  assert.equal(remote.data.version, 2, "a newer version than the one already on the shelf");
  const tools = (await api("GET", "/v1/market?q=sistem açık")).data.tools;
  assert.ok(tools.some((t) => t.shelf === "s1" && t.id === "uptime"));
  delete process.env.TAKSIM_MARKET;

  // someone else's tool lands on the shelf; adding it shows as market origin
  const theirs = { id: "redis-info", name: "Redis", summary: "redis INFO", author: "mehmet", when: ["redis bellek"], spec: { sources: { r: { brick: "command", run: ["redis-cli", "info"], parse: "lines" } }, views: [{ brick: "log", source: "r" }] } };
  assert.equal((await api("POST", "/v1/market/tools", { tool: theirs })).status, 200);
  assert.equal((await api("POST", "/v1/market/tools", { tool: { ...theirs, author: "ayse" } })).status, 409, "nobody overwrites someone else's tool");
  const inst = await api("POST", "/v1/market/install", { shelf: "local", id: "redis-info" });
  assert.equal(inst.data.origin, "market");
  assert.equal((await api("POST", "/v1/market/install", { shelf: "local", id: "uptime" })).status, 409, "the user's own tool isn't replaced");

  // an agent can use installed tools, and is told about ones it could ask the user to add
  writeFileSync(join(home, "market", "pg-slow.json"), JSON.stringify(normalize({ id: "pg-slow", name: "Postgres yavaş sorgular", summary: "pg_stat_statements", author: "mehmet", when: ["yavaş sorgular"], keywords: ["postgres"], spec: { sources: { q: { brick: "command", run: ["psql", "-c", "select 1"], parse: "lines" } }, views: [{ brick: "log", source: "q" }] } }, { origin: "market" })));
  const lead = await addAgent(c.id, { name: "lead", model: "fake-delegate" });
  const found = await say(c.id, lead.id, call("find_tools", { query: "postgres yavaş sorgular" }));
  assert.match(found.text, /in_market_not_added[\s\S]*pg-slow/);
  assert.equal((await api("DELETE", "/v1/market/local/pg-slow")).status, 200);
});

test("import a tool file; broken tools are rejected with what to fix", async () => {
  const ok = await api("POST", "/v1/toolbox/import", { tool: { id: "hello", name: "Hello", spec: { sources: { n: { brick: "agent" } }, views: [{ brick: "markdown", source: "n" }] } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.origin, "imported");
  const bad = await api("POST", "/v1/toolbox/import", { tool: { name: "x", spec: { sources: { a: { brick: "nope" } }, views: [] } } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /unknown source "nope"/);
  await until(async () => (await api("GET", "/v1/toolbox/hello")).data?.when?.length >= 0);
  assert.ok(existsSync(join(home, "toolbox")) && readdirSync(join(home, "toolbox")).includes("hello.json"));
});

test("asked to make an agent for a job, the tool is meant for the new agent, not the one asked", async () => {
  const { delegates, toolHints } = await import("../src/toolbox/mcp.mjs");
  assert.ok(delegates("kubernetes'e bakan bir agent oluştur"));
  assert.ok(delegates("pod'ları izleyen yeni bir ajan yarat"));
  assert.ok(delegates("spawn an agent that watches the pods"));
  assert.ok(!delegates("kubernetes pod'larını izle"));
  assert.ok(!delegates("docker container'larını izle"));
  const hint = toolHints([{ tool: { id: "k8s-pods", name: "Kubernetes pod'ları", summary: "pods", params: {} } }], { delegate: true });
  assert.match(hint, /create_agent/);
  assert.match(hint, /Don't open it on yourself/);

  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "orch", model: "fake-echo" });
  const canvas = getCanvas(c.id);
  const seen = [];
  canvas.bus.subs.add((ev) => { if (ev.type === "tool_suggested") seen.push(ev.data); });
  const r = await say(c.id, a.id, "kubernetes pod'larını izleyen bir agent oluştur");
  assert.equal(seen.length, 0, "no tool offered beside the orchestrator");
  assert.match(r.text, /pass the fitting tool as its `tool`/);
});

test("a request that fits a tool offers it to the page; someone else's tool still asks before it runs", async () => {
  const c = await newCanvas();
  const a = await addAgent(c.id, { name: "a", model: "fake-echo" });
  const canvas = getCanvas(c.id);
  const seen = [];
  canvas.bus.subs.add((ev) => { if (ev.type === "tool_suggested") seen.push(ev.data); });
  await say(c.id, a.id, "docker container'larını izle");
  assert.equal(seen[0]?.id, a.id);
  assert.equal(seen[0].tool.id, "docker-containers");
  assert.ok(seen[0].tool.preview, "the page draws it from its preview");
  await say(c.id, a.id, "docker'a tekrar bak");
  assert.equal(seen.length, 1, "offered once");

  const theirs = { id: "theirs", name: "Theirs", author: "mehmet", spec: { sources: { r: { brick: "command", run: ["uptime"], parse: "lines" } }, views: [{ brick: "log", source: "r" }] } };
  await api("POST", "/v1/market/tools", { tool: theirs });
  await api("POST", "/v1/market/install", { shelf: "local", id: "theirs" });
  const b = await addAgent(c.id, { name: "b", model: "fake-echo" });
  const r = await api("POST", `/v1/canvases/${c.id}/agents/${b.id}/tool`, { tool: "theirs" });
  assert.equal(r.data.status, "pending");
});

test("tool help: on by default, an agent adds a market tool itself; off, it neither adds nor hears of tools", async () => {
  const c = await newCanvas();
  writeFileSync(join(home, "market", "zeynep-disk.json"), JSON.stringify(normalize({ id: "zeynep-disk", name: "Disk doluluk", summary: "df -h", author: "zeynep",
    when: ["disk doldu mu", "disk usage"], keywords: ["df", "disk"], spec: { sources: { d: { brick: "command", run: ["df", "-h"], parse: "columns" } }, views: [{ brick: "table", source: "d" }] } }, { origin: "market" })));
  const on = await addAgent(c.id, { name: "on", model: "fake-delegate" });
  assert.notEqual(on.toolHelp, false);
  const added = await say(c.id, on.id, call("add_tool", { tool: "zeynep-disk" }));
  assert.match(added.text, /"added":\s*"zeynep-disk"/);
  assert.equal((await api("GET", "/v1/toolbox/zeynep-disk")).data.origin, "market", "in the library, still someone else's tool");

  const off = await addAgent(c.id, { name: "off", model: "fake-delegate", toolHelp: false });
  assert.equal(off.toolHelp, false);
  const refused = await say(c.id, off.id, call("add_tool", { tool: "zeynep-disk" }));
  assert.match(refused.text, /tool help is off/);
  const agent = getCanvas(c.id).agents.get(off.id);
  assert.match(agent.systemPrompt(), /Tool help is off/);
  assert.equal(agent.toolNote("disk doldu mu"), "", "no tools named with its messages");
  // switched on from the node
  await api("PATCH", `/v1/canvases/${c.id}/agents/${off.id}`, { toolHelp: true });
  assert.match(agent.systemPrompt(), /Tool help is on/);
  assert.notEqual((await api("GET", `/v1/canvases/${c.id}/agents/${off.id}`)).data.toolHelp, false);
  await api("DELETE", "/v1/market/local/zeynep-disk");
});

test("the shared market is a GitHub repository: read by anyone, shared under the user's GitHub name, a pull request without push access", async () => {
  const { connect } = await import("../src/connectors.mjs");
  const realFetch = globalThis.fetch;
  const files = { "tools/mehmet/redis-mem.json": { id: "redis-mem", name: "Redis bellek", summary: "INFO memory", author: "someone-else", when: ["redis bellek"],
    spec: { sources: { r: { brick: "command", run: ["redis-cli", "info", "memory"], parse: "lines" } }, views: [{ brick: "log", source: "r" }] } } };
  const writes = [];
  let canPush = true;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.github.com/")) return realFetch(url, opts);
    const p = u.slice("https://api.github.com/".length), m = opts.method || "GET";
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (p === "user") return json({ login: "ayse-gh" });
    if (p.startsWith("repos/team/market/git/trees/")) return json({ tree: Object.keys(files).map((path) => ({ path })) });
    if (p.startsWith("repos/team/market/contents/") && m === "GET") {
      const f = files[decodeURIComponent(p.slice("repos/team/market/contents/".length))];
      return f ? json(f) : json({ message: "Not Found" }, 404);
    }
    if (p.startsWith("repos/team/market/contents/") && m === "PUT") {
      if (!canPush) return json({ message: "Resource not accessible" }, 403);
      writes.push({ repo: "team/market", path: p.slice(27), body: JSON.parse(opts.body) });
      return json({ content: { html_url: "https://github.com/team/market/blob/main/x" } }, 201);
    }
    if (p === "repos/team/market") return json({ default_branch: "main" });
    if (p === "repos/team/market/forks") return json({ full_name: "ayse-gh/market" }, 202);
    if (p === "repos/team/market/git/ref/heads/main") return json({ object: { sha: "abc" } });
    if (p === "repos/ayse-gh/market/git/refs") return json({ ref: "x" }, 201);
    if (p.startsWith("repos/ayse-gh/market/contents/")) {
      if (m === "GET") return json({ message: "Not Found" }, 404);
      writes.push({ repo: "ayse-gh/market", body: JSON.parse(opts.body) }); return json({}, 201);
    }
    if (p === "repos/team/market/pulls") return json({ html_url: "https://github.com/team/market/pull/7" }, 201);
    return json({ message: `unexpected ${m} ${p}` }, 500);
  };
  try {
    assert.equal((await api("PUT", "/v1/market/repo", { repo: "https://github.com/team/market.git" })).data.repo, "team/market");
    assert.equal((await api("PUT", "/v1/market/repo", { repo: "not a repo" })).status, 400);
    const market = (await api("GET", "/v1/market")).data;
    assert.ok(market.shelves.some((s) => s.id === "github" && s.label === "team/market"));
    const t = market.tools.find((x) => x.shelf === "github" && x.id === "redis-mem");
    assert.equal(t.author, "mehmet", "the folder is the author, whatever the file says");
    assert.equal((await api("POST", "/v1/market/install", { shelf: "github", id: "redis-mem", by: "mehmet" })).data.origin, "market");

    // sharing needs GitHub connected; then it goes to the user's own folder
    assert.equal((await api("POST", "/v1/toolbox/uptime/publish", { shelf: "github" })).status, 400);
    await connect("github", "ghp_test", { verify: false });
    const pub = await api("POST", "/v1/toolbox/uptime/publish", { shelf: "github" });
    assert.equal(pub.status, 200, JSON.stringify(pub.data));
    assert.equal(pub.data.author, "ayse-gh");
    assert.equal(writes[0].path, "tools/ayse-gh/uptime.json");
    assert.equal(JSON.parse(Buffer.from(writes[0].body.content, "base64")).author, "ayse-gh");
    assert.ok(!Buffer.from(writes[0].body.content, "base64").toString().includes("gizli bir mesaj"), "learned phrases stay private");

    // no push access: a branch on the fork and a pull request
    canPush = false;
    const pr = await api("POST", "/v1/toolbox/uptime/publish", { shelf: "github" });
    assert.equal(pr.data.pr, "https://github.com/team/market/pull/7");
    assert.equal(writes.at(-1).repo, "ayse-gh/market");
  } finally {
    globalThis.fetch = realFetch;
    await api("PUT", "/v1/market/repo", { repo: "" });
  }
});
