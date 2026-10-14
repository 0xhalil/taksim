// Processes an IDE runs, each in a pseudo-terminal the page shows with xterm (ws /term/ide/<canvas>/<agent>/<sid>):
//   terminal  a shell in the agent's folder
//   run       the current file (python, node, bash…)
//   debug     a Python file under taksim's debugger (pydebug.py), which reports stops over a localhost socket
//   exec      an explicit command (kubectl exec -it pod -- sh, docker exec -it …): the pod shell Lens opens
// They live as long as the IDE (not across server restarts).

import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { ROOT } from "../config.mjs";
import { httpError } from "../http.mjs";
import { Terminal } from "../term/pty.mjs";
import { inside, relPath } from "./fs.mjs";

const MAX_SESSIONS = 8;
const RUNNER = join(ROOT, "src/ide/pydebug.py");

// The project's own interpreter when it has a virtualenv, like PyCharm's project interpreter.
export function pythonFor(root) {
  for (const v of [".venv", "venv", "env"]) {
    const p = join(root, v, "bin", "python");
    if (existsSync(p)) return p;
  }
  return process.env.TAKSIM_PYTHON || "python3";
}

function runCommand(root, abs) {
  const ext = extname(abs).toLowerCase();
  if (ext === ".py") return [pythonFor(root), "-u", abs];
  if ([".js", ".mjs", ".cjs"].includes(ext)) return [process.execPath, abs];
  if ([".sh", ".bash"].includes(ext)) return ["bash", abs];
  if (ext === ".zsh") return ["zsh", abs];
  if (ext === ".ts") return ["npx", "--yes", "tsx", abs];
  throw httpError(400, `don't know how to run ${basename(abs)}; open a terminal instead`);
}

export class Sessions {
  constructor(ide) {
    this.ide = ide;
    this.list = new Map(); // id -> session
  }

  get agent() { return this.ide.agent; }

  view(s) {
    return { id: s.id, kind: s.kind, title: s.title, path: s.path || null, status: s.status, exitCode: s.exitCode ?? null,
      debug: s.kind === "debug" ? s.debug.state : undefined };
  }

  views() { return [...this.list.values()].map((s) => this.view(s)); }

  emit(s) { this.agent.canvas.bus.emit("ide_session", { id: this.agent.id, session: this.view(s) }); }

  async start({ kind, path, args = [], title = null }) {
    if (this.list.size >= MAX_SESSIONS) {
      // make room by dropping the oldest finished one
      const done = [...this.list.values()].find((s) => s.status === "exited");
      if (done) this.remove(done.id); else throw httpError(409, `at most ${MAX_SESSIONS} terminals and runs; close one`);
    }
    const root = this.ide.root;
    const id = randomUUID().slice(0, 8);
    const s = { id, kind, status: "running" };
    let file, argv, env = {};
    if (kind === "terminal") {
      file = process.env.SHELL || "/bin/zsh";
      argv = [];
      s.title = `Local${[...this.list.values()].some((x) => x.kind === "terminal") ? ` (${[...this.list.values()].filter((x) => x.kind === "terminal").length + 1})` : ""}`;
    } else if (kind === "exec") {
      // no shell in between: args runs exactly, in the agent's folder (kubectl exec -it pod -- sh …)
      const cmd = (Array.isArray(args) ? args : []).map(String).filter((a) => a.length);
      if (!cmd.length || !cmd[0]) throw httpError(400, "exec needs argv: { kind: \"exec\", args: [program, ...args] }");
      [file, ...argv] = cmd;
      s.title = typeof title === "string" && title ? title.slice(0, 60) : basename(file);
    } else {
      if (!path) throw httpError(400, "path is required");
      s.path = relPath(root, path);
      const abs = inside(root, s.path);
      if (!existsSync(abs)) throw httpError(404, `no such file: ${s.path}`);
      const extra = (Array.isArray(args) ? args : []).map(String);
      if (kind === "run") {
        [file, ...argv] = [...runCommand(root, abs), ...extra];
      } else if (kind === "debug") {
        if (extname(abs).toLowerCase() !== ".py") throw httpError(400, "the debugger runs Python files");
        file = pythonFor(root);
        argv = ["-u", RUNNER, root, abs, ...extra];
        s.debug = await new DebugLink(this, s).listen();
        env = { TAKSIM_DBG_PORT: String(s.debug.port), TAKSIM_DBG_TOKEN: s.debug.token };
      } else throw httpError(400, "kind must be terminal, run, debug or exec");
      s.title = basename(s.path);
    }
    try {
      s.term = new Terminal({ file, args: argv, cwd: root, env: { ...env, PYTHONUNBUFFERED: "1" }, cols: 120, rows: 20,
        onExit: ({ exitCode }) => { s.status = "exited"; s.exitCode = exitCode; s.debug?.ended(exitCode); this.emit(s); } });
    } catch (e) {
      s.debug?.close();
      throw httpError(400, `couldn't start ${file}: ${e.message}`);
    }
    this.list.set(id, s);
    this.emit(s);
    return s;
  }

  get(id) {
    const s = this.list.get(id);
    if (!s) throw httpError(404, "no such session");
    return s;
  }

  stop(id) {
    const s = this.get(id);
    s.debug?.send({ cmd: "stop" });
    s.term?.kill();
  }

  remove(id) {
    const s = this.list.get(id);
    if (!s) return;
    s.term?.kill();
    s.debug?.close();
    this.list.delete(id);
    this.agent.canvas.bus.emit("ide_session", { id: this.agent.id, session: { id, removed: true } });
  }

  // breakpoints changed in the editor: tell running debuggers
  breakpointsChanged() {
    for (const s of this.list.values()) if (s.debug && s.status === "running") s.debug.sendBreakpoints();
  }

  close() { for (const id of [...this.list.keys()]) this.remove(id); }

  // the debug session the agent or the "ask the agent" button refers to: paused first, else the latest
  current() {
    const debugs = [...this.list.values()].filter((s) => s.debug);
    return debugs.find((s) => s.debug.state.status === "paused") || debugs.at(-1) || null;
  }
}

// The socket between taksim and pydebug.py, and what it last said: running, paused (with frames and
// variables) or ended.
class DebugLink {
  constructor(sessions, s) {
    this.sessions = sessions;
    this.session = s;
    this.token = randomUUID();
    this.sock = null;
    this.seq = 0;
    this.pending = new Map();
    this.state = { status: "starting" };
    this.server = createServer((sock) => this.accept(sock));
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.port = this.server.address().port; resolve(); });
    }).then(() => this);
  }

  accept(sock) {
    let buf = "", hello = false;
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!hello) {
          // only the process we started knows the token
          if (msg.hello !== this.token || this.sock) return sock.destroy();
          hello = true;
          this.sock = sock;
          this.server.close(); // one debuggee per session
          this.sendBreakpoints();
          this.set({ status: "running" });
          continue;
        }
        this.onMessage(msg);
      }
    });
    sock.on("close", () => { if (this.sock === sock) this.sock = null; });
    sock.on("error", () => {});
  }

  onMessage(msg) {
    if (msg.reply !== undefined) {
      const p = this.pending.get(msg.reply);
      if (p) { this.pending.delete(msg.reply); p(msg); }
      return;
    }
    if (msg.event === "stopped") {
      const root = this.sessions.ide.root;
      const rel = (f) => { try { return relPath(root, f); } catch { return f; } };
      this.set({ status: "paused", reason: msg.reason, exception: msg.exception || null,
        frames: msg.frames.map((f) => ({ ...f, path: rel(f.file) })), frame: 0, variables: msg.variables });
    } else if (msg.event === "running") this.set({ status: "running" });
    else if (msg.event === "exited") this.set({ status: "ended", exitCode: msg.code });
  }

  set(state) {
    this.state = state;
    this.sessions.emit(this.session);
  }

  ended(code) {
    if (this.state.status !== "ended") this.set({ status: "ended", exitCode: code });
    for (const p of this.pending.values()) p({ error: "the program ended" });
    this.pending.clear();
    this.close();
  }

  close() {
    try { this.server.close(); } catch { /* closed */ }
    this.sock?.destroy();
    this.sock = null;
  }

  send(msg) {
    if (!this.sock) return false;
    this.sock.write(JSON.stringify(msg) + "\n");
    return true;
  }

  sendBreakpoints() {
    const root = this.sessions.ide.root;
    const out = {};
    for (const [p, lines] of Object.entries(this.sessions.ide.breakpoints)) {
      try { out[inside(root, p)] = lines; } catch { /* a file that left the project */ }
    }
    this.send({ cmd: "breakpoints", breakpoints: out });
  }

  // continue · next · step · return · pause · stop, and while paused: frame · expand · evaluate (answered)
  async command(cmd, args = {}) {
    if (["frame", "expand", "evaluate"].includes(cmd)) {
      if (this.state.status !== "paused") throw httpError(409, "the program isn't paused");
      const seq = ++this.seq;
      const reply = await new Promise((resolve) => {
        this.pending.set(seq, resolve);
        this.send({ cmd, seq, ...args });
        setTimeout(() => { if (this.pending.delete(seq)) resolve({ error: "the debugger didn't answer" }); }, 10000);
      });
      if (reply.error) throw httpError(400, reply.error);
      if (cmd === "frame") { this.state = { ...this.state, frame: Number(args.index) || 0, variables: reply.variables }; this.sessions.emit(this.session); }
      return reply;
    }
    if (!["continue", "next", "step", "return", "pause", "stop"].includes(cmd)) throw httpError(400, `unknown debugger command ${cmd}`);
    if (cmd !== "pause" && cmd !== "stop" && this.state.status !== "paused") throw httpError(409, "the program isn't paused");
    if (cmd === "stop") { this.send({ cmd }); setTimeout(() => this.session.term?.kill(), 300); return { ok: true }; }
    this.send({ cmd });
    return { ok: true };
  }
}
