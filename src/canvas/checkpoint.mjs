// Checkpoints (Cursor's "restore to before this message"): before an agent's turn the working tree of its
// folder is written as a git tree object, without touching the user's index, branch or stash; after the turn,
// what changed is the diff between two such trees, and going back makes the working tree that tree again.
// Only in git folders; ignored files are left alone.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);
// async, so a big repository never holds up the engine
const git = async (dir, args, env) => (await run("git", ["-C", dir, ...args], {
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000,
  env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0" } })).stdout;

async function root(dir) {
  try { return (await git(dir, ["rev-parse", "--show-toplevel"])).trim(); } catch { return null; }
}
// Exported for the restore route's scope check: two agents in one repo share one tree.
export const repoTop = (dir) => root(dir);

/** the folder's working tree as a tree id (tracked and untracked, not ignored), or null outside git */
export async function snapshot(dir) {
  const top = dir && await root(dir);
  if (!top) return null;
  const tmp = mkdtempSync(join(tmpdir(), "taksim-cp-"));
  const index = join(tmp, "index");
  try {
    // a copy of the real index: its stat cache makes `add -A` fast on a big repository
    const real = (await git(top, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    if (existsSync(real)) {
      const stamp = statSync(real);
      copyFileSync(real, index);
      // Preserve Git's racy-index timestamp: a freshly copied index must not make
      // same-size edits with matching cached stat information appear clean.
      utimesSync(index, stamp.atime, stamp.mtime);
    }
    const env = { GIT_INDEX_FILE: index };
    await git(top, ["add", "-A", "--", "."], env);
    return (await git(top, ["write-tree"], env)).trim();
  } catch { return null; } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** what changed between two snapshots: [{ path, added, removed }] (binary files count as null) */
export async function changes(dir, from, to) {
  const top = await root(dir);
  if (!top || !from || !to || from === to) return [];
  try {
    return (await git(top, ["diff", "--numstat", "--no-renames", from, to])).split("\n").filter(Boolean).map((l) => {
      const [a, r, ...p] = l.split("\t");
      return { path: p.join("\t"), added: a === "-" ? null : Number(a), removed: r === "-" ? null : Number(r) };
    }).slice(0, 200);
  } catch { return []; }
}

/** one file's diff between two snapshots, as unified diff text */
export async function fileDiff(dir, from, to, path) {
  const top = await root(dir);
  if (!top) return "";
  try { return await git(top, ["diff", "--no-renames", from, to, "--", path]); } catch { return ""; }
}

/** one file as it was in a checkpoint tree ("" when it wasn't there): the chat's turn diff reads both sides
 *  this way. Paths are the ones `changes` reported, relative to the repository's top. */
export async function fileInTree(dir, tree, path) {
  const top = await root(dir);
  if (!top) return "";
  if (!/^[0-9a-f]{40,64}$/.test(String(tree))) throw new Error("not a checkpoint");
  const p = String(path || "");
  if (!p || p.startsWith("-") || p.includes("\0")) throw new Error("bad path");
  try { return await git(top, ["show", `${tree}:${p}`]); } catch { return ""; }
}

/** makes the folder's working tree what it was at `tree`: changed files come back, files made since go */
export async function restore(dir, tree) {
  const top = await root(dir);
  if (!top) throw new Error("not a git folder");
  if (!/^[0-9a-f]{40,64}$/.test(String(tree))) throw new Error("not a checkpoint");
  const now = await snapshot(top);
  // files that exist now and didn't then
  const made = (await git(top, ["diff", "--name-only", "--no-renames", "--diff-filter=A", tree, now])).split("\n").filter(Boolean);
  for (const f of made) {
    // git output is trusted but never blindly: no absolutes, no escapes, no option-looking names
    if (!f || f.startsWith("/") || f.startsWith("-") || f.split("/").includes("..") || f.includes("\0")) continue;
    rmSync(join(top, f), { force: true });
  }
  await git(top, ["restore", `--source=${tree}`, "--worktree", "--", "."]);
  // `now` is where it was: going back to it undoes the restore
  return { restored: tree, removed: made.length, now };
}
