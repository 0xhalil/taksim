import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { terminalShell, folderDialog, findProgram, resolveCommand, normalizeEnv, shellSpawn } from "../src/platform.mjs";
import { Terminal } from "../src/term/pty.mjs";

test("terminal defaults match the host and preserve the user's POSIX shell", () => {
  assert.equal(terminalShell({}, "darwin"), "/bin/zsh");
  assert.equal(terminalShell({}, "linux"), "/bin/sh");
  assert.equal(terminalShell({ SHELL: "/usr/bin/fish" }, "linux"), "/usr/bin/fish");
  assert.equal(terminalShell({ SHELL: "/bin/bash" }, "darwin"), "/bin/bash");
  assert.equal(terminalShell({ SHELL: "/bin/bash" }, "win32"), "cmd.exe");
  assert.equal(terminalShell({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "win32"), "C:\\Windows\\System32\\cmd.exe");
  assert.equal(terminalShell({ COMSPEC: "cmd.exe" }, "win32"), "cmd.exe");
});

test("each OS gets its own choose-folder dialog, and none when Linux has no dialog program", () => {
  const [mac, macArgs] = folderDialog("/Users/me", "Choose folder", { platform: "darwin" });
  assert.equal(mac, "osascript");
  assert.match(macArgs.at(-1), /choose folder with prompt "Choose folder" default location \(POSIX file "\/Users\/me"\)/);
  const [win, winArgs] = folderDialog("C:\\Users\\o'brien", "Klasör seç", { platform: "win32" });
  assert.equal(win, "powershell.exe");
  assert.match(winArgs.at(-1), /FolderBrowserDialog/);
  assert.match(winArgs.at(-1), /SelectedPath = 'C:\\Users\\o''brien'/);
  assert.deepEqual(folderDialog("/home/me", "Choose folder", { platform: "linux", has: (n) => n === "zenity" }),
    ["zenity", ["--file-selection", "--directory", "--title=Choose folder", "--filename=/home/me/"]]);
  assert.deepEqual(folderDialog(null, "Choose folder", { platform: "linux", has: (n) => n === "kdialog" }),
    ["kdialog", ["--getexistingdirectory", ".", "--title", "Choose folder"]]);
  assert.equal(folderDialog(null, "Choose folder", { platform: "linux" }), null);
});

test("the host shell executes a command through a real pseudo-terminal", async () => {
  const windows = process.platform === "win32";
  let terminal;
  const exited = new Promise((resolve) => {
    terminal = new Terminal({ file: terminalShell(),
      args: windows ? ["/d", "/s", "/c", "echo taksim-platform-ready"] : ["-c", "printf taksim-platform-ready"],
      env: {}, cwd: tmpdir(), onExit: resolve });
  });
  let timer;
  try {
    const result = await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("terminal did not exit")), 10000);
    })]);
    assert.equal(result.exitCode, 0);
    assert.match(terminal.tail, /taksim-platform-ready/);
  } finally { clearTimeout(timer); terminal.kill(); }
});

test("Windows finds CLIs through PATHEXT and runs npm's .cmd shims with Node, other batch files through cmd.exe", () => {
  const files = {
    "C:\\bin\\claude.exe": "",
    "C:\\npm\\codex": "#!/bin/sh",
    "C:\\npm\\codex.cmd": '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
    "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js": "",
    "C:\\tools\\odd.bat": "echo %*",
  };
  const opts = { platform: "win32", env: { Path: "C:\\bin;C:\\npm;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "C:\\Windows\\cmd.exe" },
    exists: (f) => f in files, read: (f) => files[f] };
  assert.equal(findProgram("claude", opts), "C:\\bin\\claude.exe");
  // npm's extensionless sh script is never what Windows runs
  assert.equal(findProgram("codex", opts), "C:\\npm\\codex.cmd");
  assert.equal(findProgram("gemini", opts), null);
  assert.deepEqual(resolveCommand("claude", ["-p"], opts), { file: "C:\\bin\\claude.exe", args: ["-p"] });
  assert.deepEqual(resolveCommand("codex", ["exec", "a b"], opts), { file: process.execPath, args: ["C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js", "exec", "a b"] });
  const odd = resolveCommand("odd", ["a&b"], opts);
  assert.equal(odd.file, "C:\\Windows\\cmd.exe");
  assert.equal(odd.verbatim, true);
  assert.deepEqual(odd.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(odd.args[3], /odd\.bat \^\^\^"a\^\^\^&b\^\^\^"/);
  // elsewhere a command stays as given
  assert.deepEqual(resolveCommand("codex", ["exec"], { platform: "linux" }), { file: "codex", args: ["exec"] });
  assert.equal(findProgram("sh", { platform: "linux", env: { PATH: "/usr/bin:/bin" }, exists: (f) => f === "/bin/sh" }), "/bin/sh");
});

test("a Windows environment keeps one PATH, the one set last", () => {
  assert.deepEqual(normalizeEnv({ Path: "C:\\a", HOME: "x", PATH: "C:\\b" }, "win32"), { HOME: "x", PATH: "C:\\b" });
  const env = { Path: "a", PATH: "b" };
  assert.equal(normalizeEnv(env, "linux"), env);
});

test("a shell command line runs on the host's shell", async () => {
  const child = shellSpawn("echo shell-ok", { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  await new Promise((r) => child.on("close", r));
  assert.match(out, /shell-ok/);
});
