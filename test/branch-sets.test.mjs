// Branch sets: a canvas's repos switched together, uncommitted work shelved per branch, all or nothing.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const home = mkdtempSync(join(tmpdir(), "taksim-home-"));
const work = realpathSync(mkdtempSync(join(tmpdir(), "taksim-repos-")));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = "1";
process.env.TAKSIM_QUIET = "1";

const { startServer } = await import("../src/server.mjs");
const { getCanvas } = await import("../src/canvas/canvas.mjs");
const { autoName } = await import("../src/canvas/branch-sets.mjs");

const repo = (name, branches) => {
  const dir = join(work, name);
  mkdirSync(dir);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir }).toString().trim();
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "main\n");
  g("add", "."); g("commit", "-qm", "init");
  for (const b of branches) { g("branch", b); }
  return { dir, g, branch: () => g("branch", "--show-current"), read: (f) => readFileSync(join(dir, f), "utf8"), write: (f, t) => writeFileSync(join(dir, f), t) };
};
const A = repo("payments", ["fix/payments"]);
const B = repo("gateway", ["fix/payments", "feature/x"]);
mkdirSync(join(B.dir, "sub"));

let server, base, canvas;
before(async () => {
  server = await startServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
  canvas = (await api("POST", "/v1/canvases", { name: "work" })).data.id;
  await api("POST", `/v1/canvases/${canvas}/agents`, { name: "pay", cwd: A.dir });
  await api("POST", `/v1/canvases/${canvas}/agents`, { name: "gw", cwd: B.dir });
  await api("POST", `/v1/canvases/${canvas}/agents`, { name: "gw2", cwd: join(B.dir, "sub") });
});
after(() => { server.close(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

async function api(method, path, body) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
}

test("a set is named by its one special branch, else what every repo shares", () => {
  assert.equal(autoName({ a: "fix/payments", b: "main" }), "fix/payments");
  assert.equal(autoName({ a: "main", b: "main" }), "main");
  assert.equal(autoName({ a: "main", b: "main" }, ["main"]), "main 2");
  assert.equal(autoName({ a: "x", b: "y", c: "y", d: "main" }), "y +1");
});

let mainSet, paySet;
test("the canvas's repos come once each, however many agents work in them", async () => {
  const { data } = await api("GET", `/v1/canvases/${canvas}/branches`);
  assert.deepEqual(data.repos.map((r) => [r.name, r.branch]).sort(), [["gateway", "main"], ["payments", "main"]]);
  assert.ok(data.repos.find((r) => r.name === "gateway").branches.includes("feature/x"));
  assert.deepEqual([data.sets, data.active], [[], null]);
});

test("one click keeps the current branches as a set; the same branches give the same set", async () => {
  const r = await api("POST", `/v1/canvases/${canvas}/branch-sets`);
  assert.equal(r.status, 201);
  mainSet = r.data;
  assert.equal(mainSet.name, "main");
  assert.deepEqual(mainSet.branches, { [A.dir]: "main", [B.dir]: "main" });
  assert.equal((await api("POST", `/v1/canvases/${canvas}/branch-sets`)).data.id, mainSet.id);
  paySet = (await api("POST", `/v1/canvases/${canvas}/branch-sets`, { branches: { [A.dir]: "fix/payments", [join(B.dir, "sub")]: "main" } })).data;
  assert.equal(paySet.name, "fix/payments");
  assert.deepEqual(paySet.branches, { [A.dir]: "fix/payments", [B.dir]: "main" }); // a sub folder means its repo
  assert.equal((await api("GET", `/v1/canvases/${canvas}/branches`)).data.active, mainSet.id);
});

test("switching moves every repo; what was uncommitted waits on its branch and comes back with it", async () => {
  A.write("a.txt", "half done on main\n");
  A.write("new.txt", "untracked\n");
  const r = await api("POST", `/v1/canvases/${canvas}/branches`, { set: paySet.id });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(A.branch(), "fix/payments");
  assert.equal(A.read("a.txt"), "main\n"); // the main work didn't follow
  assert.equal(r.data.active, paySet.id);
  assert.deepEqual(r.data.switched.map((s) => [s.from, s.to, s.shelved]), [["main", "fix/payments", true]]);
  // the agent's folder line shows the new branch
  const agent = (await api("GET", `/v1/canvases/${canvas}`)).data.agents.find((a) => a.name === "pay");
  assert.equal(agent.folder.branch, "fix/payments");

  A.write("a.txt", "payments work\n");
  await api("POST", `/v1/canvases/${canvas}/branches`, { set: mainSet.id });
  assert.equal(A.branch(), "main");
  assert.equal(A.read("a.txt"), "half done on main\n");
  assert.equal(A.read("new.txt"), "untracked\n");
  await api("POST", `/v1/canvases/${canvas}/branches`, { set: paySet.id });
  assert.equal(A.read("a.txt"), "payments work\n");
  await api("POST", `/v1/canvases/${canvas}/branches`, { set: mainSet.id });
  // only what is still uncommitted on fix/payments waits; main's came back
  assert.deepEqual(A.g("stash", "list", "--format=%gs").split("\n"), ["On fix/payments: taksim: fix/payments"]);
});

test("a repo can move on its own too", async () => {
  const r = await api("POST", `/v1/canvases/${canvas}/branches`, { branches: { [B.dir]: "feature/x" } });
  assert.equal(B.branch(), "feature/x");
  assert.equal(r.data.active, null);
  await api("POST", `/v1/canvases/${canvas}/branches`, { branches: { [B.dir]: "main" } });
});

test("nothing moves while an agent works in one of the repos", async () => {
  const pay = [...getCanvas(canvas).agents.values()].find((a) => a.name === "pay");
  pay.status = "running";
  try {
    const r = await api("POST", `/v1/canvases/${canvas}/branches`, { set: paySet.id });
    assert.equal(r.status, 409);
    assert.match(r.data.error.message, /"pay"/);
    assert.equal(A.branch(), "main");
  } finally { pay.status = "idle"; }
});

test("all or nothing: when one repo can't switch, the ones already moved go back with their changes", async () => {
  A.write("a.txt", "keep me\n");
  const bad = (await api("POST", `/v1/canvases/${canvas}/branch-sets`, { branches: { [A.dir]: "fix/payments", [B.dir]: "no/such-branch" } })).data;
  const r = await api("POST", `/v1/canvases/${canvas}/branches`, { set: bad.id });
  assert.equal(r.status, 409);
  assert.match(r.data.error.message, /gateway/);
  assert.equal(A.branch(), "main");
  assert.equal(A.read("a.txt"), "keep me\n");
  assert.equal(B.branch(), "main");
  A.g("checkout", "--", "a.txt");
});

test("sets are renamed, changed and removed, and kept with the canvas", async () => {
  await api("PATCH", `/v1/canvases/${canvas}/branch-sets/${paySet.id}`, { name: "payments fix", branches: { [B.dir]: "fix/payments" } });
  const view = (await api("GET", `/v1/canvases/${canvas}`)).data;
  const kept = view.branchSets.find((s) => s.id === paySet.id);
  assert.equal(kept.name, "payments fix");
  assert.equal(kept.branches[B.dir], "fix/payments");
  assert.equal((await api("DELETE", `/v1/canvases/${canvas}/branch-sets/${paySet.id}`)).status, 200);
  assert.equal((await api("GET", `/v1/canvases/${canvas}/branches`)).data.sets.some((s) => s.id === paySet.id), false);
});
