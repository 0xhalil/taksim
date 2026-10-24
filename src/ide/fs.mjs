// Files for the IDE dock: everything is relative to one root (the agent's working directory) and stays
// inside it. Symlinks that lead out, credential files and .git internals are refused.

import { readdirSync, readFileSync, writeFileSync, statSync, realpathSync, mkdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname, sep, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { httpError } from "../http.mjs";
import { isSecretPath } from "../bricks/catalog.mjs";

const MAX_READ = 2 * 1024 * 1024;
// shown in the tree (dimmed, like PyCharm's excluded folders) but never walked by search
export const SKIP = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache", ".idea", "dist", "build", ".next", ".tox", "target", ".gradle"]);

const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// Re-check a resolved path just before use: the CLI in the same folder can swap a
// symlink between inside()'s check and the write, so confirm the parent still resolves inside.
export function recheck(root, abs, rel) {
  const realRoot = realpathSync(root);
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const cur = join(realpathSync(probe), relative(probe, abs));
  if (!under(cur, realRoot)) throw httpError(400, `${rel} is outside the project (${realRoot})`);
  if (isSecretPath(cur)) throw httpError(403, `${rel} holds credentials`);
  return cur;
}

// A path inside root, as a real absolute path. `rel` is relative to root ("" is root itself), or absolute
// within it. Symlinks are followed, so one that leads out is outside too.
export function inside(root, rel = "") {
  const realRoot = realpathSync(root);
  const s = String(rel);
  const asked = isAbsolute(s) ? resolve(s) : resolve(realRoot, s);
  // the deepest existing ancestor decides where the path really is
  let probe = asked;
  while (!existsSync(probe)) probe = dirname(probe);
  const abs = join(realpathSync(probe), relative(probe, asked));
  if (!under(abs, realRoot)) throw httpError(400, `${rel} is outside the project (${realRoot})`);
  if (isSecretPath(abs)) throw httpError(403, `${rel} holds credentials`);
  return abs;
}

// The project-relative form of a path ("src/app.py"), however it was given.
export const relPath = (root, p) => relOf(root, inside(root, p));

const relOf = (root, abs) => relative(realpathSync(root), abs).split(sep).join("/");

export function list(root, rel = "") {
  const dir = inside(root, rel);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { throw httpError(404, `can't read ${rel || "."}: ${e.code || e.message}`); }
  return entries
    .filter((e) => e.name !== ".DS_Store" && e.name !== ".git") // PyCharm doesn't show .git either
    .map((e) => {
      const isDir = e.isDirectory() || (e.isSymbolicLink() && (() => { try { return statSync(join(dir, e.name)).isDirectory(); } catch { return false; } })());
      return { name: e.name, path: rel ? `${rel}/${e.name}` : e.name, dir: isDir, excluded: isDir && SKIP.has(e.name) };
    })
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export function read(root, rel) {
  const abs = inside(root, rel);
  let st;
  try { st = statSync(abs); } catch { throw httpError(404, `no such file: ${rel}`); }
  if (st.isDirectory()) throw httpError(400, `${rel} is a folder`);
  if (st.size > MAX_READ) return { path: rel, mtime: st.mtimeMs, size: st.size, tooLarge: true };
  const buf = readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return { path: rel, mtime: st.mtimeMs, size: st.size, binary: true };
  return { path: rel, mtime: st.mtimeMs, size: st.size, content: buf.toString("utf8") };
}

// Saves a file. With `mtime` (what the editor loaded), a file changed on disk since then is a conflict.
export function write(root, rel, content, mtime) {
  const abs = inside(root, rel);
  if (rel.split("/").includes(".git")) throw httpError(403, "the IDE doesn't write inside .git");
  if (typeof content !== "string") throw httpError(400, "content must be a string");
  if (mtime !== undefined && mtime !== null && existsSync(abs)) {
    const now = statSync(abs).mtimeMs;
    if (Math.abs(now - Number(mtime)) > 1) throw Object.assign(httpError(409, `${rel} changed on disk since it was opened`), { mtime: now });
  }
  mkdirSync(dirname(abs), { recursive: true });
  const cur = recheck(root, abs, rel);
  writeFileSync(cur, content);
  return { path: rel, mtime: statSync(cur).mtimeMs };
}

export function mkdir(root, rel) {
  const cur = recheck(root, inside(root, rel), rel);
  mkdirSync(cur, { recursive: true });
  return { path: rel };
}

export function move(root, from, to) {
  const a = inside(root, from), b = inside(root, to);
  if (!existsSync(a)) throw httpError(404, `no such file: ${from}`);
  if (existsSync(b)) throw httpError(409, `${to} already exists`);
  mkdirSync(dirname(b), { recursive: true });
  renameSync(recheck(root, a, from), recheck(root, b, to));
  return { path: to };
}

export function remove(root, rel) {
  if (!rel) throw httpError(400, "won't delete the project folder");
  rmSync(recheck(root, inside(root, rel), rel), { recursive: true });
  return { ok: true };
}

// Every file in the project (for "go to file"), skipping excluded folders. Cached briefly per root.
const fileCache = new Map();
export function allFiles(root, limit = 20000) {
  const hit = fileCache.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.files;
  const base = realpathSync(root), files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= limit) return;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name)); } else if (e.isFile()) files.push(relOf(base, join(dir, e.name)));
    }
  };
  walk(base);
  fileCache.set(root, { at: Date.now(), files });
  return files;
}
export const forgetFiles = (root) => fileCache.delete(root);

// GIT_OPTIONAL_LOCKS=0: `git status` mustn't rewrite .git/index, which the IDE's watcher would report back as a change
const run = (cmd, args, cwd, max = 8 * 1024 * 1024) => new Promise((ok) => {
  execFile(cmd, args, { cwd, maxBuffer: max, timeout: 20000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
    (err, stdout, stderr) => ok({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
});

// Find in files: ripgrep when installed, otherwise a plain walk. { path, line, col, text }[]
export async function search(root, { q, regex = false, caseSensitive = false, limit = 500 }) {
  if (!q) return [];
  const base = realpathSync(root);
  const rg = await run("rg", ["--json", "--max-columns", "300", "--max-count", "50", ...(regex ? [] : ["--fixed-strings"]),
    ...(caseSensitive ? ["--case-sensitive"] : ["--ignore-case"]), ...[...SKIP].flatMap((d) => ["--glob", `!${d}`]), "--", q, "."], base);
  if (!rg.err || rg.err.code === 1) { // 1: no matches
    const out = [];
    for (const line of rg.stdout.split("\n")) {
      if (!line.includes('"type":"match"')) continue;
      try {
        const m = JSON.parse(line).data;
        out.push({ path: m.path.text.replace(/^\.\//, ""), line: m.line_number, col: (m.submatches[0]?.start ?? 0) + 1, text: m.lines.text?.replace(/\n$/, "") ?? "" });
      } catch { /* skip */ }
      if (out.length >= limit) break;
    }
    return out;
  }
  // no ripgrep
  let re;
  try { re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i"); } catch (e) { throw httpError(400, e.message); }
  const out = [];
  for (const rel of allFiles(root)) {
    let text;
    try { const buf = readFileSync(join(base, rel)); if (buf.length > MAX_READ || buf.subarray(0, 8000).includes(0)) continue; text = buf.toString("utf8"); } catch { continue; }
    text.split("\n").forEach((l, i) => {
      if (out.length >= limit) return;
      const m = re.exec(l);
      if (m) out.push({ path: rel, line: i + 1, col: m.index + 1, text: l.slice(0, 300) });
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Changed files: { branch, files: [{ path, status }] }; null when the root isn't in a git repo.
const WORD = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "added", T: "modified", U: "modified" };

// `git status`, the way a Source Control view needs it: per file what the index holds (indexStatus) and what
// the disk holds beyond it (workStatus); `status` stays the one word the file tree colors by.
export async function gitStatus(root) {
  const base = realpathSync(root);
  const top = await run("git", ["rev-parse", "--show-toplevel"], base);
  if (top.err) return null;
  const st = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], base);
  const br = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], base);
  const up = await run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], base);
  let ahead = 0, behind = 0;
  if (!up.err) {
    const n = await run("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], base);
    [behind, ahead] = n.stdout.trim().split(/\s+/).map((x) => Number(x) || 0);
  }
  const prefix = relative(realpathSync(top.stdout.trim()), base).split(sep).join("/");
  const files = [];
  const parts = st.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const code = p.slice(0, 2), path = p.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // the old name follows
    const rel = prefix ? path.slice(prefix.length + 1) : path;
    const untracked = code === "??";
    const staged = !untracked && code[0] !== " ";
    const unstaged = untracked || code[1] !== " ";
    const status = untracked ? "untracked" : /D/.test(code) ? "deleted" : /A/.test(code) ? "added" : /R/.test(code) ? "renamed" : "modified";
    files.push({ path: rel, status, staged, unstaged,
      indexStatus: staged ? WORD[code[0]] || "modified" : null,
      workStatus: untracked ? "untracked" : unstaged ? WORD[code[1]] || "modified" : null });
  }
  return { branch: br.stdout.trim() || null, upstream: up.err ? null : up.stdout.trim(), ahead, behind, files };
}

// A file as committed at HEAD, for the diff view; "" when it's new.
export async function gitHead(root, rel) {
  inside(root, rel);
  const base = realpathSync(root);
  const r = await run("git", ["show", `HEAD:./${rel}`], base);
  return r.err ? "" : r.stdout;
}
