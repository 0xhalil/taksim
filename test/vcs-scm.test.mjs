// The Source Control view's git: the index and the disk apart, commit from the index, branches, stash, undo.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import * as vcs from "../src/ide/vcs.mjs";
import { gitStatus } from "../src/ide/fs.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "taksim-scm-")));
const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root }).toString();
const w = (n, t) => writeFileSync(join(root, n), t);
g("init", "-q", "-b", "main");
// Engine commits must work without the developer's global Git identity.
g("config", "user.name", "t");
g("config", "user.email", "t@t");
w("a.txt", "one\n"); w("b.txt", "two\n");
g("add", "."); g("commit", "-qm", "init");
const by = async () => Object.fromEntries((await gitStatus(root)).files.map((f) => [f.path, f]));

test("a file can be staged and changed again: both sides are told apart", async () => {
  w("a.txt", "one\nstaged\n");
  await vcs.stage(root, ["a.txt"]);
  w("a.txt", "one\nstaged\nmore\n");
  w("new.txt", "n\n");
  const f = await by();
  assert.deepEqual([f["a.txt"].staged, f["a.txt"].unstaged, f["a.txt"].indexStatus, f["a.txt"].workStatus], [true, true, "modified", "modified"]);
  assert.deepEqual([f["new.txt"].staged, f["new.txt"].unstaged, f["new.txt"].workStatus], [false, true, "untracked"]);
  assert.equal(await vcs.fileAt(root, "INDEX", "a.txt"), "one\nstaged\n");
});

test("commit takes what is staged, and refuses when nothing is", async () => {
  await assert.rejects(vcs.commit(root, { message: "x" }).then(() => vcs.commit(root, { message: "y" })), /nothing is staged/);
  assert.equal(g("log", "-1", "--pretty=%s").trim(), "x");
  assert.equal((await by())["a.txt"].workStatus, "modified"); // the later edit stayed out
});

test("discard with keepIndex goes back to the index, rollback to HEAD; a staged new file is removed", async () => {
  w("a.txt", "scribble\n");
  await vcs.rollback(root, ["a.txt"], { keepIndex: true });
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "one\nstaged\n");
  await vcs.stage(root, ["new.txt"]);
  await vcs.rollback(root, ["new.txt"]);
  assert.equal(existsSync(join(root, "new.txt")), false);
  assert.equal((await by())["new.txt"], undefined);
});

test("branches, checkout, stash and undo last commit", async () => {
  assert.deepEqual(await vcs.branches(root), { current: "main", branches: ["main"] });
  await vcs.checkout(root, { branch: "feature", create: true });
  assert.equal((await vcs.branches(root)).current, "feature");
  await assert.rejects(vcs.checkout(root, { branch: "-x" }), /bad branch/);
  w("b.txt", "dirty\n");
  await vcs.stash(root);
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "two\n");
  await vcs.stash(root, { pop: true });
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "dirty\n");
  g("add", "b.txt"); g("commit", "-qm", "second");
  const r = await vcs.uncommit(root);
  assert.equal(r.message, "second");
  assert.equal((await by())["b.txt"].indexStatus, "modified");
  rmSync(root, { recursive: true, force: true });
});
