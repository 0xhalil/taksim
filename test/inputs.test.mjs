// Interactive panels: inputs the user changes while a panel runs (select, text, toggle, a clicked row),
// sources that follow them, views that show only with a value or narrow by one, and buttons.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";
process.env.TAKSIM_OPENCODE_BIN = "/nonexistent/opencode";

const { startServer } = await import("../src/server.mjs");
const { validate, catalog } = await import("../src/bricks/catalog.mjs");
const { fillInputs, checkValue } = await import("../src/bricks/inputs.mjs");

let server, base;
before(async () => { server = await startServer({ host: "127.0.0.1", port: 0 }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: method === "GET" ? {} : { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await sleep(50); } };

async function panelOf(spec) {
  const c = (await api("POST", "/v1/canvases", {})).data;
  const a = (await api("POST", `/v1/canvases/${c.id}/agents`, { model: "fake-echo" })).data;
  const p = `/v1/canvases/${c.id}/agents/${a.id}/panel`;
  const put = await api("PUT", p, { spec });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const data = async (source) => (await api("GET", p)).data.data[source];
  return { p, data };
}

test("the catalog's interactive example is valid; uses of unknown inputs and bad bindings are refused", () => {
  assert.deepEqual(validate(catalog().interactive_example).errors, []);
  const bad = validate({ title: "x", sources: { s: { brick: "command", run: ["echo", "{{in.nope}}"] } },
    inputs: { q: { kind: "toggle" }, r: { kind: "row", view: "missing", field: "x" } },
    views: [{ id: "t", brick: "table", source: "s", filter: { input: "q" }, when: "zzz" }] }).errors.join("\n");
  assert.match(bad, /sources\.s: no input "nope"/);
  assert.match(bad, /inputs\.r\.view/);
  assert.match(bad, /filter\.input: the name of a text input/);
  assert.match(bad, /when: no input "zzz"/);
});

test("filling inputs: values go in as written, but can't become options, leave a folder or break a URL", () => {
  assert.deepEqual(fillInputs({ brick: "command", run: ["kubectl", "-n", "{{in.ns}}"] }, { ns: "prod" }).value.run, ["kubectl", "-n", "prod"]);
  assert.match(fillInputs({ brick: "command", run: ["ls", "{{in.f}}"] }, { f: "-rf" }).error, /can't start with "-"/);
  assert.match(fillInputs({ brick: "tail", path: "logs/{{in.f}}" }, { f: "../../etc/passwd" }).error, /file path/);
  assert.equal(fillInputs({ brick: "http", url: "http://localhost/q?x={{in.q}}" }, { q: "a b&c" }).value.url, "http://localhost/q?x=a%20b%26c");
});

test("a slider input: validated, clamped to its range and step", () => {
  const ok = validate({ title: "x", sources: { s: { brick: "command", run: ["echo", "top {{in.n}}"] } },
    inputs: { n: { kind: "slider", min: 1, max: 50, step: 1, unit: "rows", default: 10 } },
    views: [{ id: "t", brick: "log", source: "s" }] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.spec.inputs.n, { kind: "slider", min: 1, max: 50, step: 1, unit: "rows", default: 10 });
  const bad = validate({ title: "x", sources: { s: { brick: "command", run: ["echo", "hi"] } },
    inputs: { n: { kind: "slider", min: 50, max: 1 } }, views: [{ id: "t", brick: "log", source: "s" }] }).errors.join("\n");
  assert.match(bad, /inputs\.n: min must be below max/);
  assert.match(validate({ title: "x", sources: { s: { brick: "command", run: ["echo", "hi"] } },
    inputs: { n: { kind: "slider", min: "a", max: 5 } }, views: [{ id: "t", brick: "log", source: "s" }] }).errors.join("\n"), /inputs\.n\.min/);
  const def = { kind: "slider", min: 1, max: 50, step: 5 };
  assert.equal(checkValue(def, 12), 11);
  assert.equal(checkValue(def, "48"), 46);
  assert.equal(checkValue(def, 49.9), 50);
  assert.equal(checkValue(def, 500), 50);
  assert.equal(checkValue(def, -3), 1);
  assert.throws(() => checkValue(def, "much"), /a number/);
  assert.equal(fillInputs({ brick: "command", run: ["echo", "top {{in.n}}"] }, { n: 10 }).value.run.at(-1), "top 10");
});

test("a source follows its input: a new value re-runs it, without asking for approval again", async () => {
  const { p, data } = await panelOf({ title: "env", inputs: { env: { kind: "select", options: ["dev", "prod"] } },
    sources: { out: { brick: "command", run: ["echo", "env={{in.env}}"], parse: "lines" } },
    views: [{ id: "o", brick: "log", source: "out" }] });
  await until(async () => JSON.stringify(await data("out")).includes("env=dev"));
  const v = (await api("POST", `${p}/inputs`, { env: "prod" })).data;
  assert.equal(v.status, "running");
  assert.equal(v.inputs.env, "prod");
  await until(async () => JSON.stringify(await data("out")).includes("env=prod"));
  assert.equal((await api("POST", `${p}/inputs`, { env: "qa" })).status, 400); // not one of the options
  assert.equal((await api("POST", `${p}/inputs`, { nope: "x" })).status, 400);
});

test("a row input: its sources wait for a pick, then run with the picked row's value; buttons use inputs too", async () => {
  const { p, data } = await panelOf({ title: "pods",
    inputs: { pod: { kind: "row", view: "list", field: "name" }, q: { kind: "text" } },
    sources: { list: { brick: "command", run: ["printf", "a\\nb\\n"], parse: "lines" },
      detail: { brick: "command", run: ["echo", "{{in.pod}}", "logs"], parse: "lines" } },
    views: [{ id: "list", brick: "table", source: "list", filter: { input: "q" } }, { id: "d", brick: "log", source: "detail", when: "pod" }],
    actions: [{ label: "Say", run: ["echo", "button {{in.pod}}"] }] });
  await until(async () => (await data("list"))?.data);
  assert.equal((await data("detail"))?.data ?? null, null);
  await api("POST", `${p}/inputs`, { pod: "b" });
  await until(async () => JSON.stringify(await data("detail")).includes("b logs"));
  const b = (await api("POST", `${p}/button`, { index: 0 })).data;
  assert.equal(b.output, "button b");
  assert.equal((await api("POST", `${p}/inputs`, { pod: "-x" })).status, 200); // allowed as a value…
  await until(async () => /can't start with/.test((await api("GET", p)).data.sources.detail?.error || "")); // …but never as an option
});

test("a slider input drives its source with a clamped number", async () => {
  const { p, data } = await panelOf({ title: "top", inputs: { n: { kind: "slider", min: 1, max: 50, default: 5 } },
    sources: { out: { brick: "command", run: ["echo", "top {{in.n}}"], parse: "lines" } },
    views: [{ id: "o", brick: "log", source: "out" }] });
  await until(async () => JSON.stringify(await data("out")).includes("top 5"));
  const v = (await api("POST", `${p}/inputs`, { n: 12 })).data;
  assert.equal(v.inputs.n, 12);
  await until(async () => JSON.stringify(await data("out")).includes("top 12"));
  assert.equal((await api("POST", `${p}/inputs`, { n: "much" })).status, 400);
});
