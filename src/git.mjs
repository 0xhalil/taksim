// Git helpers for agent folders. An agent works on whatever branch its folder has checked out; the
// folder picker lists the repo's branches and can check one out, like `git checkout` in a terminal.

import { execFileSync } from "node:child_process";
import { httpError } from "./http.mjs";

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (dir, ...args) => { try { return git(dir, ...args); } catch { return null; } };

export const repoRoot = (dir) => tryGit(dir, "rev-parse", "--show-toplevel");

// The checked-out branch (or short commit when detached) of the repo around `dir`; null outside git.
// Cached briefly: views and status events ask often.
const branches = new Map();
export function branchOf(dir) {
  const hit = branches.get(dir);
  if (hit && Date.now() - hit.at < 3000) return hit.branch;
  const branch = tryGit(dir, "branch", "--show-current") || tryGit(dir, "rev-parse", "--short", "HEAD") || null;
  branches.set(dir, { branch, at: Date.now() });
  return branch;
}

// For the folder picker: the repo's local branches, most recently committed first.
export function repoInfo(dir) {
  const root = repoRoot(dir);
  if (!root) return { repo: null };
  const list = (tryGit(dir, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads") || "")
    .split("\n").filter(Boolean);
  return { repo: root, current: branchOf(dir), branches: list };
}

// Checks out `branch` in the folder, as `git switch` would (creating it from the current commit if it's
// new). Git itself refuses when uncommitted changes would be overwritten.
export function checkout(dir, branch) {
  if (typeof branch !== "string" || tryGit(dir, "check-ref-format", "--branch", branch) === null) {
    throw httpError(400, `"${branch}" is not a valid branch name`);
  }
  if (!repoRoot(dir)) throw httpError(400, `${dir} is not in a git repository`);
  const exists = tryGit(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`) !== null;
  try {
    // an existing branch (or a same-named remote one, which git picks up) is switched to; a new one is created.
    // `switch` only ever takes a branch: `checkout src` would restore the folder src from HEAD instead.
    if (exists || tryGit(dir, "switch", branch) === null) git(dir, "switch", ...(exists ? [branch] : ["-c", branch]));
  } catch (e) {
    throw httpError(409, `couldn't switch to ${branch}: ${String(e.stderr || e.message).trim().split("\n").slice(0, 3).join(" ")}`);
  }
  branches.clear();
  return branchOf(dir);
}
