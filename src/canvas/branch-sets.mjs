// Branch sets: named "this repo on that branch" lists for a canvas's folders, so the whole canvas moves to
// another piece of work in one step. Switching uses `git switch` in each repo; what is uncommitted on the
// branch being left is put aside under that branch's name (a stash "taksim: <branch>") and comes back when
// the canvas returns to it, so nothing is lost and nothing leaks into the other branch. The active set isn't
// stored: it is the set every repo already matches, so a switch made in a terminal shows too.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import { httpError } from "../http.mjs";
import { T } from "../lang.mjs";
import { repoRoot, forgetBranches } from "../git.mjs";
import { allCanvases } from "./canvas.mjs";

const run = promisify(execFile);
const git = async (dir, ...args) => (await run("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 30000 })).stdout.trim();
const tryGit = (dir, ...args) => git(dir, ...args).catch(() => null);
const SHELF = "taksim: ";
// branches that say "nothing special": a set named after the one branch that isn't one of these
const PLAIN = new Set(["main", "master", "trunk", "develop", "dev"]);

const current = async (dir) => (await tryGit(dir, "branch", "--show-current")) || (await tryGit(dir, "rev-parse", "--short", "HEAD"));
const dirty = async (dir) => Boolean(await tryGit(dir, "status", "--porcelain"));

// the repos the canvas's agents work in (their top folders), with the agents in each
export function reposOf(canvas) {
  const repos = new Map();
  for (const a of canvas.agents.values()) {
    const root = repoRoot(a.workDir());
    if (!root) continue;
    if (!repos.has(root)) repos.set(root, { dir: root, name: basename(root), agents: [] });
    repos.get(root).agents.push(a);
  }
  return [...repos.values()];
}

const busyIn = (repo) => repo.agents.filter((a) => a.status === "running" || a.current || a.queue.length);

// what the dropdown shows: each repo's branch, the sets, and which set the canvas is on now
export async function branchState(canvas) {
  const repos = await Promise.all(reposOf(canvas).map(async (r) => {
    const list = (await tryGit(r.dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads")) || "";
    return { dir: r.dir, name: r.name, branch: await current(r.dir), dirty: await dirty(r.dir),
      busy: busyIn(r).length > 0, branches: list.split("\n").filter(Boolean).slice(0, 40) };
  }));
  const now = Object.fromEntries(repos.map((r) => [r.dir, r.branch]));
  const matches = (s) => {
    const own = Object.entries(s.branches).filter(([dir]) => dir in now);
    return own.length > 0 && own.every(([dir, b]) => now[dir] === b);
  };
  return { repos, sets: canvas.branchSets, active: canvas.branchSets.find(matches)?.id || null };
}

// the name a set gets without asking: the special branch most repos are on (main when there is none), and how
// many other special ones the set holds
export function autoName(branches, taken = []) {
  const count = new Map();
  for (const b of Object.values(branches)) count.set(b, (count.get(b) || 0) + 1);
  const ranked = [...count.keys()].sort((a, b) => count.get(b) - count.get(a));
  const special = ranked.filter((b) => !PLAIN.has(b));
  const base = special.length ? special[0] + (special.length > 1 ? ` +${special.length - 1}` : "") : ranked[0] || "branches";
  let name = base, n = 2;
  while (taken.includes(name)) name = `${base} ${n++}`;
  return name;
}

const sameBranches = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

const cleanBranches = (canvas, input) => {
  if (!input || typeof input !== "object") throw httpError(400, "branches must be an object of folder → branch");
  const out = {};
  for (const [dir, b] of Object.entries(input)) {
    if (typeof b !== "string" || !b.trim()) throw httpError(400, `no branch given for ${dir}`);
    const root = repoRoot(dir);
    if (!root) throw httpError(400, T(canvas.lang, `${dir} is not in a git repository`, `${dir} bir git deposunda değil`));
    out[root] = b.trim();
  }
  return out;
};

// a new set: the branches given, or the ones checked out now. The same branches again give the set that has them.
export async function addSet(canvas, body = {}) {
  let branches;
  if (body.branches) branches = cleanBranches(canvas, body.branches);
  else {
    branches = {};
    for (const r of reposOf(canvas)) { const b = await current(r.dir); if (b) branches[r.dir] = b; }
  }
  if (!Object.keys(branches).length) throw httpError(400, T(canvas.lang, "no agent on this canvas works in a git repository", "Bu kanvasta git deposunda çalışan ajan yok"));
  const twin = canvas.branchSets.find((s) => sameBranches(s.branches, branches));
  if (twin) return twin;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : autoName(branches, canvas.branchSets.map((s) => s.name));
  const set = { id: randomUUID().slice(0, 8), name, branches };
  canvas.branchSets.push(set);
  changed(canvas);
  return set;
}

export function updateSet(canvas, id, body = {}) {
  const set = findSet(canvas, id);
  if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim();
  if (body.branches) {
    // null drops a repo from the set; a branch sets it
    const drop = Object.entries(body.branches).filter(([, b]) => b === null).map(([d]) => repoRoot(d) || d);
    const keep = Object.fromEntries(Object.entries(body.branches).filter(([, b]) => b !== null));
    set.branches = { ...set.branches, ...cleanBranches(canvas, keep) };
    for (const d of drop) delete set.branches[d];
  }
  changed(canvas);
  return set;
}

export function removeSet(canvas, id) {
  const set = findSet(canvas, id);
  canvas.branchSets = canvas.branchSets.filter((s) => s !== set);
  changed(canvas);
}

function findSet(canvas, id) {
  const set = canvas.branchSets.find((s) => s.id === id);
  if (!set) throw httpError(404, `no branch set ${id}`);
  return set;
}

function changed(canvas) {
  canvas.save();
  canvas.bus.emit("branches_changed", {});
}

// the shelf of `branch`: the newest stash this file put aside for it
async function shelfOf(dir, branch) {
  const list = (await tryGit(dir, "stash", "list", "--format=%gd%x09%gs")) || "";
  for (const line of list.split("\n")) {
    const [ref, subject = ""] = line.split("\t");
    if (subject.endsWith(`: ${SHELF}${branch}`)) return ref;
  }
  return null;
}

async function unshelve(dir, branch) {
  const ref = await shelfOf(dir, branch);
  if (!ref) return false;
  // the staged part comes back staged when it can; a pop that can't apply cleanly leaves the stash in place
  if ((await tryGit(dir, "stash", "pop", "--index", ref)) !== null) return true;
  await tryGit(dir, "reset", "--merge");
  if ((await tryGit(dir, "stash", "pop", ref)) !== null) return true;
  await tryGit(dir, "reset", "--merge");
  return "kept";
}

async function moveRepo(dir, to) {
  const from = await current(dir);
  if (from === to) return { dir, from, to, shelved: false, restored: false };
  let shelved = false;
  if (await dirty(dir)) {
    await git(dir, "stash", "push", "--include-untracked", "-m", SHELF + from);
    shelved = true;
  }
  try {
    // a local branch, or a remote one of the same name (which git sets up to track)
    await git(dir, "switch", to);
  } catch (e) {
    if (shelved) await unshelve(dir, from);
    throw Object.assign(new Error(String(e.stderr || e.message).trim().split("\n").slice(0, 2).join(" ")), { dir });
  }
  return { dir, from, to, shelved, restored: await unshelve(dir, to) };
}

// Moves the canvas's repos to `target` ({dir: branch}) all at once, or not at all.
export async function switchBranches(canvas, target) {
  const repos = reposOf(canvas);
  const byDir = new Map(repos.map((r) => [r.dir, r]));
  const plan = [];
  for (const [dir, to] of Object.entries(target)) {
    const root = repoRoot(dir);
    if (!root) continue; // a repo that was moved or deleted: the rest still switch
    if ((await current(root)) !== to) plan.push([root, to]);
  }
  if (!plan.length) return branchState(canvas);
  const busy = plan.flatMap(([dir]) => busyIn(byDir.get(dir) || { agents: [] }));
  if (busy.length) {
    const names = busy.map((a) => `"${a.name}"`).join(", ");
    throw httpError(409, T(canvas.lang, `${names} is working in these folders; wait for it or stop it`, `${names} bu klasörlerde çalışıyor; bitmesini bekleyin ya da durdurun`));
  }
  // no agent starts writing while the folders move under it
  const guard = { id: "branch-switch", name: "branch switch", waitingOn: [], queue: [], status: "idle", setStatus() {} };
  const cwds = [...new Set(plan.flatMap(([dir]) => (byDir.get(dir)?.agents || []).map((a) => a.workDir())))];
  const releases = [];
  for (const cwd of cwds) releases.push(await canvas.lockCwd(cwd, guard, new AbortController().signal));
  const done = [];
  try {
    for (const [dir, to] of plan) done.push(await moveRepo(dir, to));
  } catch (e) {
    // back as it was: the repos already moved return to their branches and get their changes back
    for (const step of done.reverse()) {
      if (await dirty(step.dir)) await tryGit(step.dir, "stash", "push", "--include-untracked", "-m", SHELF + step.to);
      await tryGit(step.dir, "switch", step.from);
      await unshelve(step.dir, step.from);
    }
    throw httpError(409, T(canvas.lang, `couldn't switch ${basename(e.dir || "")}: ${e.message}`, `${basename(e.dir || "")} geçirilemedi: ${e.message}`));
  } finally {
    for (const release of releases) release();
    forgetBranches();
    // every agent's folder line shows its branch, on every canvas that works in these repos
    const moved = new Set(plan.map(([dir]) => dir));
    for (const c of allCanvases()) {
      for (const a of c.agents.values()) if (a.folder && moved.has(repoRoot(a.workDir()))) c.bus.emit("agent_updated", { agent: a.view() });
      if (c !== canvas && reposOf(c).some((r) => moved.has(r.dir))) c.bus.emit("branches_changed", {});
    }
    canvas.bus.emit("branches_changed", {});
  }
  const state = await branchState(canvas);
  return { ...state, switched: done.map(({ dir, from, to, shelved, restored }) => ({ dir, from, to, shelved, restored })) };
}

export async function switchToSet(canvas, id) {
  return switchBranches(canvas, findSet(canvas, id).branches);
}
