import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const home = mkdtempSync(join(tmpdir(), 'taksim-web-'));
process.env.TAKSIM_HOME = home;
process.env.TAKSIM_FAKE = '1';
process.env.TAKSIM_QUIET = '1';
const { startServer } = await import('../src/server.mjs');
const { tabOf, stopBrowser, browserPath } = await import('../src/browser/browser.mjs');
const { getCanvas } = await import('../src/canvas/canvas.mjs');
let server, base;
before(async () => { server = await startServer({ host: '127.0.0.1', port: 0 }); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await stopBrowser(); server.close(); server.closeAllConnections(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

const appDir = new URL('../ui/app/', import.meta.url);
const modules = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'scripts' ? [] : modules(join(dir, e.name))) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : []));

test('web client assets are local and traversal does not expose engine source', async () => {
  for (const path of ['/app', '/ui/app/app.mjs', '/ui/app/style.css', '/ui/vendor/xterm.mjs']) {
    const r = await fetch(base + path); assert.equal(r.status, 200, path);
  }
  // every module the client loads is served, and imports only local files
  for (const file of modules(appDir.pathname)) {
    const rel = relative(appDir.pathname, file);
    const r = await fetch(`${base}/ui/app/${rel}`);
    assert.equal(r.status, 200, rel);
    for (const m of readFileSync(file, 'utf8').matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)) assert.match(m[1], /^\.\.?\//, `${rel} imports ${m[1]}`);
  }
  const r = await fetch(base + '/ui/%2e%2e%2fpackage.json'); assert.notEqual(r.status, 200);
});

test('the shared scene model is the engine\'s, unchanged', () => {
  for (const f of ['data.mjs', 'scene.mjs']) {
    const copy = readFileSync(new URL(`shared/${f}`, appDir), 'utf8');
    assert.equal(copy.slice(copy.indexOf('\n') + 1), readFileSync(new URL(`../src/bricks/${f}`, import.meta.url), 'utf8'), `ui/app/shared/${f} is stale: run node ui/app/scripts/sync-native.mjs`);
  }
});

test('an attachment is served back only from its canvas', async () => {
  const c = await (await fetch(base + '/v1/canvases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'att' }) })).json();
  const a = await (await fetch(`${base}/v1/canvases/${c.id}/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-echo' }) })).json();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const up = await (await fetch(`${base}/v1/canvases/${c.id}/agents/${a.id}/attachments`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).json();
  const ok = await fetch(`${base}/v1/canvases/${c.id}/agents/${a.id}/attachments?path=${encodeURIComponent(up.path)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  const outside = await fetch(`${base}/v1/canvases/${c.id}/agents/${a.id}/attachments?path=${encodeURIComponent(join(home, '..', 'x.png'))}`);
  assert.equal(outside.status, 404);
});

test('web client adds an agent, chats, answers a question, drags, and runs a real terminal', { skip: !browserPath() && 'Chrome not installed' }, async () => {
  const page = await tabOf('web-app-test');
  const evaluate = async (expression) => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description);
    return r.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(100); }
    throw new Error(`UI did not reach: ${expression}\n${await evaluate('document.body.innerText')}`);
  };
  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  await page.send('Page.navigate', { url: base + '/app' });
  await until("window.taksim?.store.currentId && document.querySelector('#tabs .tab.active')");
  // the fake CLI only: the quick add takes the last model used
  await evaluate("localStorage.setItem('taksim.lastModel', JSON.stringify('fake-echo')); taksim.welcome.close(); taksim.store.newCanvas()");
  await until("taksim.store.currentAgents.length === 0 && taksim.store.models.length > 0");
  // + Agent → No folder: a chat agent in the middle of the view, its composer ready
  await evaluate("document.querySelector('.agent-key .add').click()");
  await until("[...document.querySelectorAll('.menu .item')].some((b) => b.textContent.includes('No folder'))");
  await evaluate("[...document.querySelectorAll('.menu .item')].find((b) => b.textContent.includes('No folder')).click()");
  await until("taksim.store.currentAgents.length === 1 && document.querySelector('.chat .composer-field')");
  const canvasId = await evaluate('taksim.store.currentId');
  const agentId = await evaluate('taksim.store.currentAgents[0].id');
  assert.equal(await evaluate('taksim.store.currentAgents[0].model'), 'fake-echo');
  const text = '<img src=x onerror=alert(1)> hello web';
  await evaluate(`(() => { const f = document.querySelector('.chat .composer-field'); f.value = ${JSON.stringify(text)}; f.dispatchEvent(new Event('input')); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await until("document.querySelectorAll('.chat .chat-answer').length >= 1 && document.querySelector('.chat .chat-answer').textContent.includes('hello web')");
  assert.equal(await evaluate("document.querySelectorAll('.chat img:not(.btile img)').length"), 0);
  // a question from the engine: the card takes the composer's place; a pick and Continue answer it
  const agent = getCanvas(canvasId).agents.get(agentId);
  const answer = agent.workflow.ask({ questions: [{ title: 'Choose a test option', options: ['One', 'Two'] }] }, { signal: new AbortController().signal });
  await until("document.querySelector('.question .question-option')");
  await evaluate("[...document.querySelectorAll('.question .question-option')].find((b) => b.textContent.includes('Two')).click()");
  await evaluate("document.querySelector('.question-continue').click()");
  assert.match(await answer, /Two/);
  await until("!document.querySelector('.question') && document.querySelector('.chat .composer')");
  // the card drags by its title bar, and the move is saved
  const oldPos = [...agent.pos];
  const point = await evaluate(`(() => { const g = taksim.graph, a = taksim.store.agents.get(${JSON.stringify(agentId)}), r = g.rectOf(a), p = g.toScreen({ x: r.x + 60, y: r.y + 15 }), b = g.canvas.getBoundingClientRect(); return { x: b.left + p.x, y: b.top + p.y, k: g.scale }; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 60, y: point.y + 40, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 60, y: point.y + 40, button: 'left', clickCount: 1 });
  for (let i = 0; i < 50 && agent.pos[0] === oldPos[0]; i++) await sleep(100);
  assert.ok(Math.abs(agent.pos[0] - (oldPos[0] + 60 / point.k)) < 2 && Math.abs(agent.pos[1] - (oldPos[1] + 40 / point.k)) < 2, `moved to ${agent.pos} from ${oldPos}`);
  // a mouse wheel zooms and a trackpad pans, told apart the way Chromium reports them (GraphView.scrollWheel)
  const wheel = await evaluate(`import('/ui/app/graph.mjs').then(({ wheelFromMouse: m }) => ({
    mac: /Mac/.test(navigator.platform),
    macWheel: m({ deltaMode: 0, deltaX: 0, deltaY: -4.000244140625, wheelDeltaX: 0, wheelDeltaY: 12 }),
    winWheel: m({ deltaMode: 0, deltaX: 0, deltaY: 100, wheelDeltaX: 0, wheelDeltaY: -120 }),
    lines: m({ deltaMode: 1, deltaX: 0, deltaY: 3 }),
    trackpad: m({ deltaMode: 0, deltaX: 2, deltaY: 12, wheelDeltaX: -6, wheelDeltaY: -36 }),
  }))`);
  assert.deepEqual(wheel, { mac: wheel.mac, macWheel: wheel.mac, winWheel: true, lines: true, trackpad: false });
  // a menu opened inside a sheet (an account's ⋯ in Settings) sits above it and takes clicks
  const overSheet = await evaluate(`(async () => {
    taksim.openSettings(); await new Promise((r) => setTimeout(r, 300));
    const { menu } = await import('/ui/app/ui.mjs');
    let ran = false;
    menu({ x: 300, y: 300 }, [{ label: 'Remove', run: () => { ran = true; } }]);
    const item = document.querySelector('.menu .item'), r = item.getBoundingClientRect();
    document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.item')?.click();
    document.querySelector('dialog')?.close();
    return ran;
  })()`);
  assert.equal(overSheet, true);
  // the theme follows Settings
  const theme = await evaluate('document.documentElement.dataset.theme');
  await evaluate(`import('/ui/app/theme.mjs').then((t) => t.setTheme(${JSON.stringify(theme === 'dark' ? 'light' : 'dark')}))`);
  await until(`document.documentElement.dataset.theme !== ${JSON.stringify(theme)}`);
  // an agent in a folder: its title's terminal key opens a real shell in the node
  const dir = mkdtempSync(join(home, 'proj-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const shellId = await evaluate(`taksim.store.addAgent({ model: 'fake-echo', cwd: ${JSON.stringify(dir)}, chat: false, pos: [40, 600] }).then((a) => a.id)`);
  const key = await evaluate(`(async () => { const g = taksim.graph; g.revealAgent(${JSON.stringify(shellId)}); await new Promise((r) => setTimeout(r, 500)); const a = taksim.store.agents.get(${JSON.stringify(shellId)}), r = g.rectOf(a), p = g.toScreen({ x: r.x + r.w - 6 - 11, y: r.y + 15 }), b = g.canvas.getBoundingClientRect(); return { x: b.left + p.x, y: b.top + p.y }; })()`);
  await click(key.x, key.y);
  await until(`taksim.store.agents.get(${JSON.stringify(shellId)}).shell && document.querySelector('.term-box .xterm')`);
  const shell = getCanvas(canvasId).agents.get(shellId);
  await sleep(500);
  await evaluate(`taksim.bodyLayer.focus(${JSON.stringify(shellId)})`);
  await page.send('Input.insertText', { text: 'echo web-terminal-ok' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(`document.querySelector('.term-box').textContent.includes('web-terminal-ok')`);
  assert.ok(shell.shell);
  if (process.env.TAKSIM_WEB_SNAPSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.TAKSIM_WEB_SNAPSHOT, Buffer.from(shot.data, 'base64'));
  }
  // a reload comes back to the same canvas and agents
  await page.send('Page.reload');
  await until(`window.taksim?.store.agents.has(${JSON.stringify(agentId)})`);
  assert.equal(await evaluate('taksim.store.currentId'), canvasId);
});

test('welcome preserves the selected named account and keeps failed starts retryable', { skip: !browserPath() && 'Chrome not installed' }, async () => {
  const page = await tabOf('welcome-accounts-test');
  await page.send('Page.navigate', { url: base + '/app' });
  const evaluate = async expression => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (let i = 0; i < 100 && !(await evaluate('!!window.taksim')); i++) await sleep(100);
  const result = await evaluate(`(async () => {
    const { AccountsModel } = await import('/ui/app/accounts.mjs');
    const { Welcome } = await import('/ui/app/welcome.mjs');
    const m = new AccountsModel();
    m.backends = [{ name: 'codex', label: 'ChatGPT', installed: true }];
    m.machine = { codex: { loggedIn: true, email: 'personal@example.com' } };
    m.accounts = [{ id: 'work', backend: 'codex', name: 'Work', dir: '/isolated', status: { loggedIn: true, email: 'work@example.com' } }];
    m.select('work');
    const selected = m.ready;
    let fields;
    const w = new Welcome({ store: { currentAgents: [], models: [{ id: 'gpt-test', owned_by: 'codex' }], loadChoices: async () => {}, addAgent: async f => { fields = f; throw new Error('Offline'); } }, graph: { viewCenter: () => ({ x: 0, y: 0 }) } });
    w.open(); w.accounts = m; w.draw(); w.start.click();
    await new Promise(r => setTimeout(r, 50));
    const retry = !!w.root && !w.start.disabled && w.error === 'Offline';
    w.close();
    m.accounts = [];
    return { selected, fields, retry, fallback: m.ready.account };
  })()`);
  assert.equal(result.selected.account, 'work');
  assert.equal(result.fields.account, 'work');
  assert.equal(result.fields.model, 'gpt-test');
  assert.equal(result.retry, true);
  assert.equal(result.fallback, null);
});

test('stream bursts coalesce view updates without dropping events; offscreen agents stop breathing', { skip: !browserPath() && 'Chrome not installed' }, async () => {
  const page = await tabOf('performance-test');
  await page.send('Page.navigate', { url: base + '/app' });
  const evaluate = async expression => {
    const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  for (let i = 0; i < 100 && !(await evaluate('!!window.taksim')); i++) await sleep(100);
  const result = await evaluate(`(async () => {
    const {CanvasStore} = await import('/ui/app/store.mjs');
    const {GraphView} = await import('/ui/app/graph.mjs');
    const s = new CanvasStore(); let views = 0, events = 0;
    s.watch(() => views++); s.listen(() => events++);
    for (let i = 0; i < 100; i++) { s.apply('text_delta', { id: 'test', text: 'x' }); await Promise.resolve(); }
    await new Promise(requestAnimationFrame);
    const stage = document.createElement('div'); stage.style.cssText = 'position:fixed;width:600px;height:400px;left:0;top:0'; document.body.append(stage);
    s.currentId = 'test'; s.order = ['test']; s.agents.set('test', {id:'test', name:'Test', model:'fake-echo', status:'running', pos:[10000,10000]});
    const g = new GraphView(s, stage); let draws = 0; const draw = g.draw.bind(g); g.draw = () => { draws++; draw(); };
    g.kick(); await new Promise(r => setTimeout(r, 200)); const initial = draws;
    await new Promise(r => setTimeout(r, 250)); const extra = draws - initial;
    stage.remove(); clearTimeout(g.breath); cancelAnimationFrame(g.frame);
    return {views, events, text: s.streaming.get('test').length, extra};
  })()`);
  assert.equal(result.views, 1);
  assert.equal(result.events, 100);
  assert.equal(result.text, 100);
  assert.equal(result.extra, 0);
  console.log('Performance regression:', JSON.stringify(result));
});
