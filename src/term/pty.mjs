// A CLI running in a pseudo-terminal, shared by any number of browser clients. It keeps running when
// no browser is attached; a client that (re)attaches first receives the scrollback.

import { createRequire } from "node:module";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCommand, normalizeEnv } from "../platform.mjs";

const require = createRequire(import.meta.url);
const SCROLLBACK = 1024 * 1024;
const PASTE_SUBMIT_DELAY_MS = 150;
const TAIL = 8000; // plain-text tail of the screen output, for readiness checks

// Escape sequences: CSI (arrows, focus in/out, mouse reports, bracketed-paste markers), OSC, SS3 and
// two-byte escapes. Terminals send these on their own (e.g. on focus), so they are not typing.
const ESC_SEQ = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|O.|[@-Z\\-_])/y;
export const stripAnsi = (s) => s.replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|O.|[@-Z\\-_])/g, "")
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

let pty;
function loadPty() {
  if (pty) return pty;
  pty = require("node-pty");
  // node-pty 1.1's prebuilt spawn-helper can lose its exec bit on install ("posix_spawnp failed")
  const base = dirname(require.resolve("node-pty/package.json"));
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const helper = join(base, "prebuilds", arch, "spawn-helper");
    try { if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755); } catch { /* read-only install */ }
  }
  return pty;
}

export class Terminal {
  constructor({ file, args, env, cwd, cols = 120, rows = 34, onExit }) {
    // Windows: the program through PATHEXT, an npm shim's script run by this Node (src/platform.mjs)
    const all = normalizeEnv({ ...process.env, ...env, TERM: "xterm-256color", COLORTERM: "truecolor" });
    ({ file, args } = resolveCommand(file, args, { env: all }));
    this.proc = loadPty().spawn(file, args, {
      name: "xterm-256color", cols, rows, cwd, env: all,
    });
    this.pid = this.proc.pid;
    this.cols = cols;
    this.rows = rows;
    this.chunks = [];
    this.size = 0;
    this.clients = new Set();
    this.lastInputAt = 0;
    this.pendingChars = 0; // characters typed since the last Enter, to avoid pasting into a half-written line
    this.exited = false;
    this.onSubmit = null;  // called when the user presses Enter
    this.onOutput = null;  // called with each chunk of output
    this.tail = "";        // plain text of the latest output
    this.written = 0;      // total plain characters ever appended to tail

    this.proc.onData((data) => {
      const plain = stripAnsi(data);
      this.tail = (this.tail + plain).slice(-TAIL);
      this.written += plain.length;
      this.onOutput?.(data);
      this.chunks.push(data);
      this.size += data.length;
      while (this.size > SCROLLBACK && this.chunks.length > 1) this.size -= this.chunks.shift().length;
      for (const ws of this.clients) if (ws.readyState === 1) ws.send(data);
    });
    this.proc.onExit(({ exitCode, signal }) => {
      this.exited = true;
      for (const ws of this.clients) ws.close(1000, "terminal exited");
      this.clients.clear();
      onExit?.({ exitCode, signal });
      // Windows: node-pty keeps the finished program's console (and its thread) open until told to let go
      if (process.platform === "win32") setImmediate(() => this.#release());
    });
  }

  attach(ws) {
    this.clients.add(ws);
    if (this.size) ws.send(this.chunks.join(""));
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === "i" && typeof msg.d === "string") this.input(msg.d);
      else if (msg.t === "r") this.resize(msg.cols, msg.rows);
    });
    ws.on("close", () => this.clients.delete(ws));
  }

  // Input from the browser: keystrokes, but also escape sequences the terminal emits by itself.
  input(data) {
    if (this.exited) return;
    let typed = false;
    for (let i = 0; i < data.length;) {
      if (data[i] === "\x1b") {
        ESC_SEQ.lastIndex = i;
        const m = ESC_SEQ.exec(data);
        if (m) { i += m[0].length; continue; }
        typed = true; i++; continue; // a lone Esc keypress
      }
      const ch = data[i++];
      typed = true;
      if (ch === "\r") { this.onSubmit?.(this.pendingChars > 0); this.pendingChars = 0; }
      else if (ch === "\x7f" || ch === "\b") this.pendingChars = Math.max(0, this.pendingChars - 1);
      else if (ch === "\x03" || ch === "\x15") this.pendingChars = 0; // Ctrl-C / Ctrl-U clear the line
      else if (ch >= " ") this.pendingChars++;
    }
    if (typed) this.lastInputAt = Date.now();
    this.proc.write(data);
  }

  // Plain text written since `mark` (a previous value of this.written), as far as the tail reaches.
  textSince(mark) {
    return this.tail.slice(Math.max(0, this.tail.length - (this.written - mark)));
  }

  // True while a person is typing or has an unsent line, so injected messages wait.
  userBusy(quietMs = 4000) {
    return this.pendingChars > 0 || Date.now() - this.lastInputAt < quietMs;
  }

  // Types a message as one bracketed paste, then submits it.
  paste(text) {
    if (this.exited) return;
    this.proc.write(`\x1b[200~${text.replace(/\x1b/g, "")}\x1b[201~`);
    setTimeout(() => { if (!this.exited) this.proc.write("\r"); }, PASTE_SUBMIT_DELAY_MS);
  }

  resize(cols, rows) {
    cols = Math.max(20, Math.min(500, Math.floor(cols)));
    rows = Math.max(5, Math.min(200, Math.floor(rows)));
    if (this.exited || !cols || !rows || (cols === this.cols && rows === this.rows)) return;
    this.cols = cols;
    this.rows = rows;
    this.proc.resize(cols, rows);
  }

  // node-pty's kill on Windows, once: a second one on the same console corrupts its memory and ends the engine
  #released = false;
  #release() {
    if (this.#released) return;
    this.#released = true;
    try { this.proc.kill(); } catch { /* gone */ }
  }

  kill() {
    if (this.exited) return;
    // Windows: node-pty ends what runs in the console and lets go of it
    if (process.platform === "win32") { this.#release(); return; }
    try { process.kill(-this.pid, "SIGHUP"); } catch { this.proc.kill("SIGHUP"); }
    setTimeout(() => { try { process.kill(-this.pid, "SIGKILL"); } catch { /* gone */ } }, 3000).unref();
  }
}
