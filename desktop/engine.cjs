// Finds or starts the taksim engine (the Node server), as ServerLauncher.swift does for the Mac app: reuse a
// server already on the port, else start bin/taksim.mjs with the login shell's environment (apps started from a
// launcher don't inherit the shell's PATH, and the agent CLIs live there), and stop it on quit. A packaged app
// brings the engine and its own Node in resources/engine; a checkout uses the repository and the Node on PATH.
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, openSync, closeSync } = require('node:fs');
const { join, delimiter } = require('node:path');
const { createServer } = require('node:net');
const { homedir } = require('node:os');

const win = process.platform === 'win32';

/** the engine: TAKSIM_ROOT, else the one packed into the app, else the checkout this file sits in */
function engineRoot(packaged) {
  if (process.env.TAKSIM_ROOT) return process.env.TAKSIM_ROOT;
  const packed = process.resourcesPath && join(process.resourcesPath, 'engine');
  if (packaged && packed && existsSync(join(packed, 'bin', 'taksim.mjs'))) return packed;
  return join(__dirname, '..');
}

function find(bin, path) {
  const names = win ? (process.env.PATHEXT || '.EXE;.CMD').split(';').map((e) => bin + e.toLowerCase()).concat(bin) : [bin];
  for (const dir of (path || '').split(delimiter)) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  return null;
}

/** the app's own Node beside the engine, else TAKSIM_NODE, else the one on PATH */
function nodeFor(root, env) {
  const bundled = join(root, 'runtime', win ? 'node.exe' : 'node');
  if (existsSync(bundled)) return bundled;
  return env.TAKSIM_NODE || find('node', env.PATH || env.Path) || null;
}

/** the environment of an interactive login shell, so ~/.zshrc or ~/.bashrc PATH tweaks (nvm, ~/.local/bin) apply */
function loginShellEnv() {
  if (win) return {};
  const sh = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const r = spawnSync(sh, ['-ilc', "printf '\\0__TAKSIM_ENV__\\0'; env -0"], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
  const text = r.stdout || '', at = text.indexOf('\0__TAKSIM_ENV__\0');
  if (at < 0) return {};
  const env = {};
  for (const entry of text.slice(at + 16).split('\0')) { const eq = entry.indexOf('='); if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1); }
  return env;
}

/** what the engine gets: the shell's environment, without this app's Electron switches or a Claude Code session's markers */
function engineEnv(port) {
  const env = { ...process.env, ...loginShellEnv() };
  for (const k of Object.keys(env)) {
    if (k.startsWith('ELECTRON_') || k.startsWith('CLAUDECODE') || k.startsWith('CLAUDE_CODE_') || k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  env.TAKSIM_HOST = '127.0.0.1';
  env.TAKSIM_PORT = String(port);
  // the engine stops when this app is gone, however it went (src/server.mjs)
  env.TAKSIM_PARENT_PID = String(process.pid);
  return env;
}

/** "taksim" when our server answers, "other" when something else does, null when nothing does */
async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    const body = await r.json().catch(() => null);
    return body && body.backends ? 'taksim' : 'other';
  } catch { return null; }
}

/** nothing listens on the port: it can be bound on 127.0.0.1 */
function isFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

class Engine {
  /** `movable`: the port was not asked for, so another program on it moves the engine to a free one (kept via onMove) */
  constructor({ port = 8787, movable = true, packaged = false, onMove = () => {} } = {}) {
    this.port = port;
    this.movable = movable;
    this.root = engineRoot(packaged);
    this.onMove = onMove;
    this.child = null;
    const home = process.env.TAKSIM_HOME || join(homedir(), '.taksim');
    this.log = join(home, 'desktop-server.log');
  }

  get url() { return `http://127.0.0.1:${this.port}`; }

  async #move() {
    if (!this.movable) throw new Error(`Port ${this.port} is used by another program.`);
    for (let p = this.port + 1; p <= this.port + 40; p++) if (await isFree(p)) { this.port = p; this.onMove(p); return; }
    throw new Error(`Port ${this.port} is used by another program.`);
  }

  async ensure() {
    const h = await health(this.port);
    if (h === 'taksim') return;
    if (h === 'other' || !(await isFree(this.port))) { await this.#move(); return this.ensure(); }
    const env = engineEnv(this.port);
    const node = nodeFor(this.root, env);
    if (!node) throw new Error('Taksim could not start: Node.js 20 or newer is needed.');
    mkdirSync(join(this.log, '..'), { recursive: true });
    const out = openSync(this.log, 'a');
    let failure = null;
    try {
      this.child = spawn(node, [join(this.root, 'bin', 'taksim.mjs'), 'serve'], { cwd: this.root, env, stdio: ['ignore', out, out], windowsHide: true });
    } finally { closeSync(out); }
    this.child.on('error', (e) => { failure = e; });
    for (let n = 0; n < 240; n++) {
      if (failure) throw failure;
      if (this.child.exitCode !== null) throw new Error(`Taksim could not start; log: ${this.log}`);
      if (await health(this.port) === 'taksim') return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Taksim could not start; log: ${this.log}`);
  }

  /** stops the engine this app started: it saves and closes everything, as on SIGTERM (Windows has no signals) */
  async stop() {
    const c = this.child;
    this.child = null;
    if (!c || c.exitCode !== null) return;
    const gone = new Promise((r) => c.once('exit', r));
    try { await fetch(`${this.url}/v1/restart`, { method: 'POST', signal: AbortSignal.timeout(1500) }); } catch { c.kill(); }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 4000))]);
    if (c.exitCode === null) c.kill('SIGKILL');
  }
}

module.exports = { Engine, engineRoot, engineEnv, nodeFor, loginShellEnv, health, isFree };
