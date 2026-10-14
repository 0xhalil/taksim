// Git for the IDE's Commit and Git log windows. Paths are relative to the IDE's root (which may be a
// subfolder of the repository); git runs there and is told to keep paths relative to it.

import { execFile } from "node:child_process";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { httpError } from "../http.mjs";
import { inside } from "./fs.mjs";

const git = (root, args, { timeout = 30000, allowFail = false } = {}) => new Promise((resolve, reject) => {
  execFile("git", args, { cwd: realpathSync(root), maxBuffer: 16 * 1024 * 1024, timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout, stderr) => {
    if (err && !allowFail) return reject(httpError(400, (String(stderr).trim() || err.message).split("\n").slice(-6).join("\n")));
    resolve({ ok: !err, out: String(stdout), err: String(stderr) });
  });
});

// the paths must exist in the project (or be deletions git knows about); never options
function paths(root, files) {
  if (!Array.isArray(files) || !files.length) throw httpError(400, "choose at least one file");
  return files.map((f) => {
    const p = String(f);
    if (p.startsWith("-")) throw httpError(400, `bad path ${p}`);
    inside(root, p);
    return p;
  });
}

export async function commit(root, { files, message, amend = false }) {
  const msg = String(message || "").trim();
  if (!msg) throw httpError(400, "write a commit message");
  if (amend && (!files || !files.length)) {
    await git(root, ["commit", "--amend", "-m", msg]);
  } else {
    const list = paths(root, files);
    await git(root, ["add", "-A", "--", ...list]);
    await git(root, ["commit", ...(amend ? ["--amend"] : []), "-m", msg, "--", ...list]);
  }
  const head = await git(root, ["log", "-1", "--pretty=format:%h%x1f%s"]);
  const [hash, subject] = head.out.split("\x1f");
  return { hash, subject };
}

export async function push(root) {
  const up = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true });
  if (up.ok) {
    const r = await git(root, ["push"], { timeout: 120000 });
    return { output: (r.err || r.out).trim() };
  }
  // no upstream yet: the first remote, as PyCharm's push dialog would pick
  const remotes = (await git(root, ["remote"])).out.split("\n").filter(Boolean);
  if (!remotes.length) throw httpError(400, "this repository has no remote to push to");
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  const r = await git(root, ["push", "-u", remotes.includes("origin") ? "origin" : remotes[0], branch], { timeout: 120000 });
  return { output: (r.err || r.out).trim() };
}

// Throws away local changes: tracked files go back to HEAD, new files are deleted.
export async function rollback(root, files) {
  const list = paths(root, files);
  const untracked = new Set((await git(root, ["ls-files", "--others", "--exclude-standard", "--", ...list])).out.split("\n").filter(Boolean));
  const tracked = list.filter((p) => !untracked.has(p));
  if (tracked.length) await git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  for (const p of untracked) rmSync(inside(root, p), { force: true });
  return { restored: tracked.length, deleted: untracked.size };
}

export async function log(root, n = 100) {
  const r = await git(root, ["log", `-n${Math.min(500, n)}`, "--date=format:%Y-%m-%d %H:%M", "--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1f%D%x1e", "--", "."], { allowFail: true });
  if (!r.ok) return [];
  return r.out.split("\x1e").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [hash, short, author, date, subject, refs] = x.split("\x1f");
    return { hash, short, author, date, subject, refs: refs ? refs.split(", ").filter(Boolean) : [] };
  });
}

// One commit: its message and the files it changed (relative to the root).
export async function show(root, hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(String(hash))) throw httpError(400, "bad commit id");
  const r = await git(root, ["show", "--relative", "--name-status", "--date=format:%Y-%m-%d %H:%M", "--pretty=format:%H%x1f%an%x1f%ad%x1f%B%x1e", hash]);
  const [head, rest = ""] = r.out.split("\x1e");
  const [full, author, date, body] = head.split("\x1f");
  const files = rest.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [code, ...p] = l.split("\t");
    return { path: p.at(-1), status: { A: "added", D: "deleted", M: "modified" }[code[0]] || (code[0] === "R" ? "renamed" : "modified") };
  });
  return { hash: full, author, date, message: (body || "").trim(), files };
}

// A file as of a commit ("" when it didn't exist then); rev "HEAD", a hash, or hash^ for its parent.
export async function fileAt(root, rev, path) {
  if (!/^(HEAD|[0-9a-f]{4,40})\^?$/i.test(String(rev))) throw httpError(400, "bad revision");
  inside(root, path);
  const r = await git(root, ["show", `${rev}:./${path}`], { allowFail: true });
  return r.ok ? r.out : "";
}

// The chosen files' changes as text for a model to describe: tracked files as `git diff HEAD` (staged and
// unstaged together), new files with every line marked added. Capped, so a huge change can't flood a prompt.
export async function diffForModel(root, files, { maxBytes = 24000 } = {}) {
  const list = paths(root, files);
  const others = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...list])).out.split("\0").filter(Boolean);
  const untracked = new Set(others);
  const tracked = list.filter((p) => !untracked.has(p));
  let text = "";
  if (tracked.length) text += (await git(root, ["diff", "--no-color", "HEAD", "--", ...tracked], { allowFail: true })).out;
  for (const p of others) {
    let content = "";
    try { content = readFileSync(inside(root, p), "utf8"); } catch { continue; }
    if (content.length > 8000) content = `${content.slice(0, 8000)}\n…`;
    text += `diff --git a/${p} b/${p}\nnew file\n${content.split("\n").map((l) => `+${l}`).join("\n")}\n`;
  }
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n…` : text;
}
