// Runs a packaged desktop app the way a person would and checks what ships works: the app starts its own engine
// with the Node inside the package, an agent answers in its chat, a real terminal opens in a node, and quitting
// stops the engine. With the fake provider only, in a throwaway TAKSIM_HOME.
//   node desktop/test/package-smoke.mjs <the app's executable>
// (dist/desktop/linux-unpacked/taksim, dist/desktop/win-unpacked/taksim.exe, dist/desktop/mac-arm64/taksim.app/Contents/MacOS/taksim)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import WebSocket from 'ws';

const exe = process.argv[2];
if (!exe || !existsSync(exe)) { console.error('usage: node desktop/test/package-smoke.mjs <app executable>'); process.exit(2); }
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = mkdtempSync(join(tmpdir(), 'taksim-package-'));
const port = await free(), debug = await free();
const env = { ...process.env, TAKSIM_HOME: home, TAKSIM_PORT: String(port), TAKSIM_FAKE: '1', TAKSIM_NO_UPDATE: '1', TAKSIM_QUIET: '1' };
delete env.TAKSIM_URL; delete env.TAKSIM_ROOT; delete env.TAKSIM_NODE; delete env.ELECTRON_RUN_AS_NODE;
const args = [`--remote-debugging-port=${debug}`, `--user-data-dir=${join(home, 'electron')}`];
if (process.platform === 'linux') args.push('--no-sandbox');
const app = spawn(exe, args, { env, stdio: ['ignore', 'inherit', 'inherit'] });
let exited = false;
app.on('exit', () => { exited = true; });

async function until(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} if (exited) break; await sleep(250); }
  throw new Error(`timed out waiting for ${what}`);
}

let failed = false;
try {
  const health = await until('the engine', async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok);
  console.log('engine up:', health);
  const target = await until('the window', async () => (await (await fetch(`http://127.0.0.1:${debug}/json`)).json()).find((t) => t.type === 'page' && t.url.includes('/app')));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  let id = 0;
  const send = (method, params) => new Promise((r) => { const i = ++id; const on = (m) => { const d = JSON.parse(m); if (d.id === i) { ws.off('message', on); r(d.result); } }; ws.on('message', on); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await until('the app', () => evaluate('!!window.taksim?.store?.currentId'));
  // the engine is the packaged one, run by the Node inside the package
  const engine = await evaluate(`fetch('/v1/models').then((r) => r.ok)`);
  if (!engine) throw new Error('the engine does not list models');
  // an agent answers in its chat
  await evaluate("taksim.welcome.close(); taksim.store.addAgent({ model: 'fake-echo', pos: [80, 80] }).then((a) => a.id)");
  await until('the chat', () => evaluate("!!document.querySelector('.chat .composer-field')"));
  await evaluate(`(() => { const f = document.querySelector('.chat .composer-field'); f.value = 'package-smoke'; f.dispatchEvent(new Event('input')); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until('the answer', () => evaluate("document.querySelector('.chat').textContent.includes('package-smoke')"));
  console.log('chat answered');
  // a real terminal opens in a node (node-pty from the package)
  const shellId = await evaluate(`taksim.store.addAgent({ model: 'fake-echo', chat: false, cwd: ${JSON.stringify(home)}, pos: [80, 600] }).then((a) => a.id)`);
  await evaluate(`taksim.store.toggleTerminal(${JSON.stringify(shellId)})`);
  await until('the terminal', () => evaluate(`!!taksim.store.agents.get(${JSON.stringify(shellId)})?.shell && !!document.querySelector('.term-box .xterm')`));
  await sleep(1000);
  await evaluate(`taksim.bodyLayer.focus(${JSON.stringify(shellId)})`);
  await send('Input.insertText', { text: 'echo package-terminal-ok' });
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until('the terminal output', () => evaluate("[...document.querySelectorAll('.term-box')].some((t) => t.textContent.includes('package-terminal-ok'))"), 30000);
  console.log('terminal works');
  // quitting as a person does: the last window closes
  await evaluate('setTimeout(() => window.close(), 50), true').catch(() => {});
  ws.close();
} catch (e) {
  failed = true;
  console.error('package smoke failed:', e.message);
  const log = join(home, 'desktop-server.log');
  if (existsSync(log)) console.error('engine log:\n' + readFileSync(log, 'utf8').slice(-4000));
}
// quitting stops the engine it started
await until('the app to quit', () => exited, 20000).catch(() => { failed = true; console.error('the app did not quit when its window closed'); app.kill(); });
const stopped = await until('the engine to stop', async () => { try { await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } }, 15000).catch(() => false);
if (!stopped) { failed = true; console.error('the engine kept running after the app quit'); }
try { rmSync(home, { recursive: true, force: true }); } catch {}
console.log(failed ? 'package smoke FAILED' : 'package smoke passed');
process.exit(failed ? 1 : 0);
