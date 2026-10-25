// What fills a node's body (TerminalLayer.swift): its shell's terminal, or its chat. Each is laid out at the
// node's size in graph units and scaled with the canvas, like the native ZoomBox; one cut-out per node in front
// keeps the bodies stacked in the agents' order.
import { Terminal } from '../vendor/xterm.mjs';
import { FitAddon } from '../vendor/xterm-addon-fit.mjs';
import { pal, isDark, onTheme } from './theme.mjs';
import { el } from './ui.mjs';
import { TERM_EDGE } from './graph.mjs';
import { ChatModel } from './chat/model.mjs';
import { ChatView } from './chat/view.mjs';

const darkAnsi = ['#1E1F22', '#CD3131', '#0DBC79', '#E5E510', '#2472C8', '#BC3FBC', '#11A8CD', '#E5E5E5', '#6F737A', '#F14C4C', '#23D18B', '#F5F543', '#3B8EEA', '#D670D6', '#29B8DB', '#E5E5E5'];
const lightAnsi = ['#000000', '#C7222D', '#067D17', '#A67C00', '#1750EB', '#871094', '#0E7D8C', '#6C707E', '#8C8C8C', '#E55765', '#208A3C', '#C27D04', '#3574F0', '#A64AB3', '#1A9AA8', '#1E1F22'];
const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/** xterm's colours as the native terminal sets them (TermColors) */
function termTheme() {
  const ansi = isDark ? darkAnsi : lightAnsi;
  return { background: pal.bg, foreground: isDark ? pal.text : pal.ink, cursor: pal.caret, cursorAccent: pal.bg, selectionBackground: pal.sel,
    ...Object.fromEntries(ansiNames.map((n, i) => [n, ansi[i]])) };
}

/** one agent's terminal: its view and its socket (/term/shell/<canvas>/<agent>; {t:"i",d} input, {t:"r",cols,rows} size) */
export class AgentTerminal {
  retries = 0;
  closed = false;

  constructor(path, onGone) {
    this.path = path;
    this.onGone = onGone;
    this.root = el('div', 'term-box');
    this.screen = el('div', 'term-screen');
    this.root.append(this.screen);
    this.term = new Terminal({ fontSize: 13, fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      theme: termTheme(), cursorBlink: true, scrollback: 5000, allowProposedApi: true });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.screen);
    this.untheme = onTheme(() => { this.term.options.theme = termTheme(); });
    this.term.onData((d) => this.send({ t: 'i', d }));
    this.term.onResize(({ cols, rows }) => this.send({ t: 'r', cols, rows }));
    this.observer = new ResizeObserver(() => { if (this.screen.clientWidth && this.screen.clientHeight) try { this.fit.fit(); } catch {} });
    this.observer.observe(this.screen);
    // pinches zoom the canvas, not the terminal's scrollback
    this.root.addEventListener('wheel', (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopPropagation(); this.zoom?.(e); } }, { passive: false, capture: true });
    this.connect();
  }

  send(obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${this.path}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.closed) return;
      this.retries = 0;
      this.term.reset();
      try { this.fit.fit(); } catch {}
      this.send({ t: 'r', cols: this.term.cols, rows: this.term.rows });
    };
    ws.onmessage = (e) => this.term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    // retry briefly (network blips); after that, let the app re-check whether the terminal still exists
    ws.onclose = () => {
      if (this.closed || this.ws !== ws) return;
      this.retries++;
      if (this.retries <= 3) setTimeout(() => this.connect(), this.retries * 1000);
      else this.onGone();
    };
  }

  focus() { this.term.focus(); }

  close() {
    this.closed = true;
    this.ws?.close();
    this.observer.disconnect();
    this.untheme();
    this.term.dispose();
    this.root.remove();
  }
}

export class Bodies {
  terminals = new Map();   // agent id -> { t: AgentTerminal, canvas }
  chats = new Map();       // agent id -> { model, view, canvas }

  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.graph = app.graph;
    this.root = app.bodies;
    this.graph.onLayout = () => this.layout();
    this.store.listen((type, d) => this.#event(type, d));
    // a press anywhere on a node (its title, its terminal, its chat) brings it to the front
    this.root.addEventListener('pointerdown', (e) => {
      const id = e.target.closest?.('[data-agent]')?.dataset.agent;
      if (id) { this.store.raise(id); this.graph.select([id]); }
    }, true);
  }

  layout() {
    const s = this.store, g = this.graph, canvas = s.currentId;
    if (!canvas) { for (const x of [...this.terminals.values(), ...this.chats.values()]) (x.t?.root ?? x.view.root).hidden = true; return; }
    const keepT = new Set(), keepC = new Set();
    for (const a of g.agents) {
      const p = g.pos(a), [w, h] = g.size(a), gw = w - TERM_EDGE, gh = h - TERM_EDGE;
      let box = null;
      if (a.shell) {
        keepT.add(a.id);
        let entry = this.terminals.get(a.id);
        if (!entry) {
          const t = new AgentTerminal(`/term/shell/${canvas}/${a.id}`, () => s.reloadAgent(a.id).catch(() => {}));
          t.zoom = (e) => g.wheel(e);
          t.root.dataset.agent = a.id;
          this.root.append(t.root);
          entry = { t, canvas };
          this.terminals.set(a.id, entry);
        }
        box = entry.t.root;
      } else if (g.hasTranscript(a)) {
        keepC.add(a.id);
        let entry = this.chats.get(a.id);
        if (!entry) {
          const model = new ChatModel(s, canvas, a.id);
          const view = new ChatView(model, this.app);
          view.root.dataset.agent = a.id;
          this.root.append(view.root);
          entry = { model, view, canvas };
          this.chats.set(a.id, entry);
        }
        box = entry.view.root;
        if (entry.agentKey !== agentKey(a)) { entry.agentKey = agentKey(a); entry.view.schedule('all'); }
      }
      if (!box) continue;
      box.hidden = !g.terminalsShown || !!a.collapsed;
      if (box.hidden) continue;
      const sp = g.toScreen(p);
      box.style.width = gw + 'px';
      box.style.height = gh + 'px';
      box.style.transform = `translate(${sp.x}px, ${sp.y}px) scale(${g.scale})`;
    }
    // gone from this canvas: closed; on another canvas: kept, hidden, so coming back is instant
    for (const [id, e] of this.terminals) if (!keepT.has(id)) { if (e.canvas === canvas) { e.t.close(); this.terminals.delete(id); } else e.t.root.hidden = true; }
    for (const [id, e] of this.chats) if (!keepC.has(id)) { if (e.canvas === canvas) { e.view.root.remove(); this.chats.delete(id); } else e.view.root.hidden = true; }
    this.#stack();
    this.app.panels?.layout();
    this.app.docks?.layout();
    this.app.plans?.layout();
  }

  /** each body is cut away where a node in front of it lies, so the one in front is whole */
  #stack() {
    const g = this.graph, list = g.agents;
    list.forEach((a, i) => {
      const box = this.terminals.get(a.id)?.t.root ?? this.chats.get(a.id)?.view.root;
      if (!box || box.hidden) return;
      box.style.zIndex = String(i + 1);
      const p = g.pos(a), [w, h] = g.size(a), body = { x: p.x, y: p.y, w: w - TERM_EDGE, h: h - TERM_EDGE };
      const holes = [];
      for (const b of list.slice(i + 1)) {
        const r = g.rectOf(b), x = r.x - 3, y = r.y - 3, rw = r.w + 6, rh = r.h + 6;
        if (x >= body.x + body.w || y >= body.y + body.h || x + rw <= body.x || y + rh <= body.y) continue;
        holes.push(`M${x - body.x} ${y - body.y}h${rw}v${rh}h${-rw}z`);
      }
      box.style.clipPath = holes.length ? `path(evenodd, "M0 0h${body.w}v${body.h}h${-body.w}z ${holes.join(' ')}")` : '';
    });
  }

  focus(id) {
    const t = this.terminals.get(id);
    if (t) return t.t.focus();
    this.chats.get(id)?.view.focus();
  }

  chat(id) { return this.chats.get(id)?.model ?? null; }

  /** the live parts of a chat, from the canvas's events */
  #event(type, d) {
    const model = (id) => this.chats.get(id)?.model;
    switch (type) {
      case 'chat_tasks': model(d.id)?.takeTasks(d.tasks ?? []); break;
      case 'chat_workflow': {
        const m = model(d.id);
        if (!m) break;
        const before = m.plan;
        m.takeWorkflow(d.plan ?? null, d.question ?? null);
        // a plan just proposed (or proposed again) opens beside the node
        if (d.plan?.status === 'draft' && (before?.id !== d.plan.id || before?.version !== d.plan.version)) m.planShown = true;
        if (!d.plan) m.planShown = false;
        // the plan's dock opens beside the node (or goes): the canvas makes room for it
        this.layout();
        this.graph.kick();
        break;
      }
      case 'chat_job': { const m = model(d.id); if (m) { m.job = d.job ?? null; m.changed(); } break; }
      case 'chat_activity': model(d.id)?.takeActivity(d.activity ?? null, d.reset === true); break;
      case 'chat_queue': model(d.id)?.takeQueue(d.messages ?? []); break;
      case 'message':
        if (d.from === d.to) break;
        model(d.to)?.take(d);
        model(d.from)?.take(d);
        break;
      case 'text_delta': model(d.id)?.delta(d.text ?? ''); break;
      case 'agent_status': case 'agent_updated': {
        const id = d.id ?? d.agent?.id, e = this.chats.get(id);
        if (e) e.view.schedule('all');
        break;
      }
    }
  }
}

/** what of an agent its chat shows: a change draws the chat again */
const agentKey = (a) => JSON.stringify([a.status, a.chatMode, a.permission, a.model, a.effort, a.queued, a.context, a.delegate, a.blockedBy, a.workingWith, a.chatOrigin, a.name]);
