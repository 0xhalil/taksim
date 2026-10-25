// The canvas: group enclosures, links, agent cards and selection, painted on a 2D canvas the way
// GraphView.swift and GraphDraw.swift paint them with Core Graphics. Coordinates follow LiteGraph:
// screen = (graph + offset) · scale; an agent's `pos` is the top-left of its body, its 30-high title bar above it.
import { pal, rgba, L, onTheme } from './theme.mjs';
import { drawIcon } from './icons.mjs';
import { logos } from './logos.mjs';

export const TH = 30;                 // LiteGraph.NODE_TITLE_HEIGHT
export const BTN = 22;                // a title-bar button
const HANDLE = 22;                    // the corner a resize starts from
const JOIN_MS = 220, BORN_MS = 300, PULSE_MS = 900;
const MIN_CARD = [220, 80], MIN_TERM = [480, 280], MIN_CHAT = [320, 260];
export const TERM_EDGE = 10;          // node edge left uncovered by a terminal or chat, for resizing
export const TERM_MIN_SCALE = 0.45;   // below this a terminal or chat is unreadable: the card shows instead
export const PANEL_GAP = 14;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, Ubuntu, Cantarell, sans-serif';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const now = () => performance.now() / 1000;
const isDelegate = (a) => (a.createdBy ?? 'user') !== 'user';
const effortNames = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Very high', max: 'Max', ultra: 'Ultra' };
export const effortName = (e) => (effortNames[e] ? L(effortNames[e]) : e);

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }

/** the person's canvas text size (Settings › Appearance): a multiplier on every canvas font */
export const canvasText = {
  get size() { const v = stored('taksim.canvasTextSize', 1); return Math.min(1.5, Math.max(0.75, v || 1)); },
  set size(v) { try { localStorage.setItem('taksim.canvasTextSize', JSON.stringify(Math.min(1.5, Math.max(0.75, v)))); } catch {} },
};
export const showGrid = {
  get on() { return stored('taksim.showGrid', true); },
  set on(v) { try { localStorage.setItem('taksim.showGrid', JSON.stringify(v)); } catch {} },
};

const rect = (x, y, w, h) => ({ x, y, w, h });
const contains = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return rect(x, y, Math.max(a.x + a.w, b.x + b.w) - x, Math.max(a.y + a.h, b.y + b.h) - y); };
const inset = (r, dx, dy) => rect(r.x + dx, r.y + dy, r.w - dx * 2, r.h - dy * 2);

function rounded(ctx, r, radius) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.max(0, Math.min(radius, r.w / 2, r.h / 2)));
}

export class GraphView {
  scale = 1;
  offset = { x: 0, y: 0 };
  selected = new Set();
  hover = {};                 // id | term | ide | helpers | fold | computer | note: the agent or group under the pointer
  hoverLink = null;
  pressed = null;             // a title button just pressed: { id, kind, at }
  drag = null;
  localPos = new Map();       // positions while nodes are dragged
  localSize = new Map();      // sizes while a corner is dragged
  localGroup = new Map();     // group frames while dragged
  draggingItems = false;
  dragStartGroups = null;
  dragPos = null;
  groupAnims = [];
  pulses = [];
  flashes = new Map();
  baseRects = new Map();
  modes = new Map();          // terminal open, as last laid out: a change moves the node
  viewAnim = null;
  /** room docked beside a node (panel, IDE, plan): functions (agent) => [w, h] | null */
  docks = [];
  /** set by the app: what presses on the canvas do */
  actions = {};
  /** the bodies over the nodes (chats, terminals) follow every change of the view */
  onLayout = () => {};

  constructor(store, stage) {
    this.store = store;
    this.stage = stage;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'graph';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', L('Canvas'));
    this.canvas.setAttribute('role', 'application');
    this.ctx = this.canvas.getContext('2d');
    stage.append(this.canvas);
    new ResizeObserver(() => this.#resize()).observe(stage);
    this.#resize();
    this.#bind();
    onTheme(() => this.kick());
  }

  get width() { return this.stage.clientWidth; }
  get height() { return this.stage.clientHeight; }
  get agents() { return this.store.currentAgents; }
  get groups() { return [...this.store.groups.values()].sort((a, b) => (a.id < b.id ? -1 : 1)); }
  get terminalsShown() { return this.scale >= TERM_MIN_SCALE; }

  #resize() {
    const dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(this.width * dpr));
    this.canvas.height = Math.max(1, Math.round(this.height * dpr));
    this.dpr = dpr;
    this.draw();
    this.onLayout();
  }

  // ---------- geometry ----------

  toScreen(p) { return { x: (p.x + this.offset.x) * this.scale, y: (p.y + this.offset.y) * this.scale }; }
  toGraph(p) { return { x: p.x / this.scale - this.offset.x, y: p.y / this.scale - this.offset.y }; }
  screenRect(r) { const p = this.toScreen(r); return rect(p.x, p.y, r.w * this.scale, r.h * this.scale); }
  /** a graph rect in the window's coordinates (for fields and menus laid over the canvas) */
  clientRect(r) { const s = this.screenRect(r), b = this.canvas.getBoundingClientRect(); return { x: s.x + b.left, y: s.y + b.top, width: s.w, height: s.h }; }

  pos(a) { return this.localPos.get(a.id) ?? { x: a.pos?.[0] ?? 0, y: a.pos?.[1] ?? 0 }; }
  setLocal(id, p) { this.localPos.set(id, p); this.kick(); }

  isTerminalOpen(a) { return !!a.shell; }
  hasFolder(a) { return !!a.folder; }
  isCollapsed(a) { return !!a.collapsed; }
  hasIDE(a) { return a.folder?.branch != null; }
  /** the node shows its chat: a delegate, or an agent the person switched to chat, while no terminal is open */
  hasTranscript(a) { return !a.shell && (isDelegate(a) || a.chat === true); }
  waitsForOthers(a) { return !!(a.workingWith?.length || a.blockedBy?.length); }
  computerOf(a) { return this.store.computer[a.id] ?? null; }

  size(a) {
    if (this.isCollapsed(a)) return [this.collapsedWidth(a), 0];
    return this.localSize.get(a.id) ?? this.expandedSize(a);
  }

  /** folded, it narrows to its logo, name, status dot and title buttons */
  collapsedWidth(a) {
    const buttons = (this.hasIDE(a) ? 3 : 2) + (this.computerOf(a) ? 1 : 0);
    const full = TH + this.measure(a.name, this.ctitle()) + 8 + 22 + buttons * (BTN + 4) + 6;
    return Math.min(this.expandedSize(a)[0], Math.max(150, Math.round(full)));
  }

  /** its size when it isn't folded: a stored size on the 10 grid and within bounds */
  expandedSize(a) {
    const term = this.isTerminalOpen(a), chat = this.hasTranscript(a);
    const raw = term ? (a.size ?? [760, 440]) : (a.cardSize ?? (chat ? [640, 360] : [300, 150]));
    const mn = term ? MIN_TERM : chat ? MIN_CHAT : MIN_CARD, mx = term ? [1800, 1400] : [1000, 900];
    const g = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v / 10) * 10));
    return [g(raw[0] ?? (term ? 760 : 300), mn[0], mx[0]), g(raw[1] ?? (term ? 440 : 150), mn[1], mx[1])];
  }

  /** body plus title bar, in graph units */
  rectOf(a) { const p = this.pos(a), [w, h] = this.size(a); return rect(p.x, p.y - TH, w, h + TH); }
  centerOf(a) { const r = this.rectOf(a); return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }

  dockSize(a) {
    if (this.isCollapsed(a)) return null;
    const docks = this.docks.map((fn) => fn(a)).filter(Boolean);
    if (!docks.length) return null;
    return [docks.reduce((s, d) => s + d[0] + PANEL_GAP, 0), Math.max(...docks.map((d) => d[1]))];
  }
  footprintOf(a) { const r = this.rectOf(a), d = this.dockSize(a); return d ? rect(r.x, r.y, r.w + d[0], Math.max(r.h, d[1])) : r; }

  groupRect(g) { return this.localGroup.get(g.id) ?? (g.rect?.length >= 4 ? rect(g.rect[0], g.rect[1], g.rect[2], g.rect[3]) : rect(0, 0, 0, 0)); }
  groupColor(g) { return /^#[0-9a-f]{6}/i.test(g.color ?? '') ? g.color.slice(0, 7) : '#548af7'; }
  inside(g, p) { return contains(this.groupRect(g), p); }
  groupIds(a) { return new Set(this.groups.filter((g) => this.inside(g, this.centerOf(a))).map((g) => g.id)); }
  innerGroup(a) {
    const area = (g) => { const r = this.groupRect(g); return r.w * r.h; };
    return this.groups.filter((g) => this.inside(g, this.centerOf(a))).sort((x, y) => area(x) - area(y))[0] ?? null;
  }

  // ---------- hit testing ----------

  agentAt(p) { return [...this.agents].reverse().find((a) => contains(this.rectOf(a), p)) ?? null; }

  cornerAt(a, p) {
    if (this.isCollapsed(a)) return null;
    const r = this.rectOf(a), h = HANDLE;
    const left = p.x < r.x + h, right = p.x > r.x + r.w - h, top = p.y < r.y + h, bottom = p.y > r.y + r.h - h;
    if (bottom && right) return 'se';
    if (bottom && left) return 'sw';
    if (top && right && !this.inTermButton(a, p)) return 'ne';
    if (top && left && p.x < r.x + 8) return 'nw';
    return null;
  }

  /** the title's buttons from the right: terminal (with a folder), IDE (in a git repo), helpers, fold */
  slotX(a, i) { const r = this.rectOf(a); return r.x + r.w - 6 - BTN - i * (BTN + 4); }
  helpersX(a) { return this.slotX(a, (this.hasFolder(a) ? 1 : 0) + (this.hasIDE(a) ? 1 : 0)); }
  foldX(a) { return this.helpersX(a) - BTN - 4; }
  computerX(a) { return this.foldX(a) - BTN - 4; }
  inSlot(a, p, x) { const r = this.rectOf(a); return p.x >= x && p.x <= x + BTN && p.y >= r.y && p.y <= r.y + TH; }
  inTermButton(a, p) {
    if (!this.hasFolder(a)) return false;
    const r = this.rectOf(a), bx = r.x + r.w - BTN - 8;
    return p.x >= bx && p.x <= bx + BTN + 4 && p.y >= r.y && p.y <= r.y + TH;
  }
  inIDEButton(a, p) { return this.hasIDE(a) && this.inSlot(a, p, this.slotX(a, this.hasFolder(a) ? 1 : 0)); }
  inHelpersButton(a, p) { return this.inSlot(a, p, this.helpersX(a)); }
  inFoldButton(a, p) { return this.inSlot(a, p, this.foldX(a)); }
  inComputerButton(a, p) { return !!this.computerOf(a) && this.inSlot(a, p, this.computerX(a)); }

  noteRect(g) { const r = this.groupRect(g); return rect(r.x + r.w - 26, r.y + 8, 15, 15); }
  groupNoteAt(p) { return [...this.groups].reverse().find((g) => contains(inset(this.noteRect(g), -5, -5), p)) ?? null; }
  groupTitleAt(p) { return [...this.groups].reverse().find((g) => { const r = this.groupRect(g); return contains(r, p) && p.y < r.y + 18 * 1.4; }) ?? null; }
  groupResizeAt(p) { return [...this.groups].reverse().find((g) => { const r = this.groupRect(g); return p.x > r.x + r.w - 16 && p.x <= r.x + r.w + 2 && p.y > r.y + r.h - 16 && p.y <= r.y + r.h + 2; }) ?? null; }
  groupAt(p) {
    const area = (g) => { const r = this.groupRect(g); return r.w * r.h; };
    return this.groups.filter((g) => this.inside(g, p)).sort((x, y) => area(x) - area(y))[0] ?? null;
  }

  linkAt(p) {
    const reach = 7 / Math.max(this.scale, 0.2);
    for (const l of this.store.links) {
      if (!l.label) continue;
      const e = this.endpoints(l.from, l.to, l.kind === 'message' && this.#both(l) ? 6 : 0);
      if (!e) continue;
      const [a, b] = e, dx = b.x - a.x, dy = b.y - a.y, len2 = Math.max(dx * dx + dy * dy, 1);
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      if (Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)) < reach) return l;
    }
    return null;
  }

  // ---------- the view ----------

  fit(animated = false) {
    const rs = this.agents.map((a) => this.footprintOf(a));
    if (!rs.length || this.width <= 0) return;
    const box = rs.reduce(union), pad = 80;
    const s = Math.min(1.1, Math.max(0.45, Math.min(this.width / (box.w + pad * 2), this.height / (box.h + pad * 2))));
    const to = { x: this.width / 2 / s - (box.x + box.w / 2), y: this.height / 2 / s - (box.y + box.h / 2) };
    if (animated) this.animateView(s, to); else this.moveView(s, to);
  }

  revealAgent(id) {
    const a = this.store.agents.get(id);
    if (!a || this.width <= 0) return;
    this.select([id]);
    const r = this.rectOf(a);
    const zoom = Math.max(0.1, Math.min(1, this.width / (r.w + 80), this.height / (r.h + 80)));
    this.animateView(zoom, { x: this.width / 2 / zoom - (r.x + r.w / 2), y: this.height / 2 / zoom - (r.y + r.h / 2) });
  }

  animateView(s, o) {
    if (reduceMotion.matches) return this.moveView(s, o);
    this.viewAnim = { from: [this.scale, { ...this.offset }], to: [s, o], start: now() };
    this.kick();
  }

  moveView(s, o) {
    this.scale = s;
    this.offset = { x: o.x, y: o.y };
    this.actions.viewMoved?.();
    this.kick();
    this.onLayout();
  }

  /** where a new agent goes when none is chosen: the middle of the view */
  viewCenter() { return { x: this.width / 2 / this.scale - this.offset.x - 150, y: this.height / 2 / this.scale - this.offset.y - 75 }; }

  zoom(k, at) {
    const g = this.toGraph(at), s = Math.min(10, Math.max(0.1, this.scale * k));
    this.moveView(s, { x: at.x / s - g.x, y: at.y / s - g.y });
  }

  select(ids) {
    const next = new Set(ids);
    if (next.size === this.selected.size && [...next].every((id) => this.selected.has(id))) return;
    this.selected = next;
    this.actions.selectionChanged?.([...next]);
    this.kick();
  }

  // ---------- animation: draw every frame while something moves ----------

  kick() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => this.#tick());
  }

  #tick() {
    this.frame = null;
    const t = now();
    if (this.viewAnim) {
      const v = this.viewAnim, k = 1 - Math.pow(1 - Math.min(1, (t - v.start) / 0.35), 3);
      this.scale = v.from[0] + (v.to[0] - v.from[0]) * k;
      this.offset = { x: v.from[1].x + (v.to[1].x - v.from[1].x) * k, y: v.from[1].y + (v.to[1].y - v.from[1].y) * k };
      if (k >= 1) this.viewAnim = null;
      this.onLayout();
    }
    for (const [id, at] of this.flashes) if (t - at >= 0.7) this.flashes.delete(id);
    this.draw();
    const moving = this.viewAnim || this.pulses.length || this.groupAnims.length || this.drag || this.flashes.size || (this.pressed && t - this.pressed.at < 0.25);
    const area = rect(-this.offset.x, -this.offset.y, this.width / this.scale, this.height / this.scale);
    const breathing = this.agents.some((a) => intersects(inset(this.footprintOf(a), -16, -16), area) && ((a.status ?? 'idle') !== 'idle' || a.waitingOn?.length || this.waitsForOthers(a) || (a.collapsed && a.panel?.status === 'pending')));
    if (moving) this.kick();
    else if (breathing) { clearTimeout(this.breath); this.breath = setTimeout(() => this.kick(), 50); }
  }

  pulse(from, to, color) { this.pulses.push({ from, to, start: now(), color }); this.kick(); }
  celebrateGroup(gid) { this.groupAnims.push({ gid, kind: 'born', start: now() }); this.kick(); }
  press(id, kind) { this.pressed = { id, kind, at: now() }; this.kick(); }
  pressDepth(id, kind) {
    const p = this.pressed;
    if (!p || p.id !== id || p.kind !== kind) return 0;
    const t = (now() - p.at) / 0.22;
    return t >= 1 ? 0 : Math.sin(t * Math.PI);
  }
  flash(id) { this.flashes.set(id, now()); this.kick(); }

  // ---------- text ----------

  cfont(size, weight = 400) { return { css: `${weight} ${size * canvasText.size}px ${FONT}`, size: size * canvasText.size }; }
  ctitle() { return { css: `400 ${14 * canvasText.size}px Arial, ${FONT}`, size: 14 * canvasText.size }; }

  measure(s, font) {
    const key = font.css + '|' + s;
    let w = this.widths?.get(key);
    if (w == null) {
      this.widths ??= new Map();
      if (this.widths.size > 2000) this.widths.clear();
      this.ctx.font = font.css;
      w = this.ctx.measureText(s).width;
      this.widths.set(key, w);
    }
    return w;
  }

  /** text with its vertical middle at y, or its baseline at y */
  drawText(s, font, color, x, y, { middle = true, align = 'left' } = {}) {
    const ctx = this.ctx;
    ctx.font = font.css;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = middle ? 'middle' : 'alphabetic';
    ctx.fillText(s, x, y);
  }

  /** the baseline that centres a line's letters (between cap and x height) on y, as an eye sees it */
  midBaseline(font, y) { return y + font.size * 0.305; }

  /** text cut to a width, with an ellipsis */
  fitText(text, font, maxW) {
    if (this.measure(text, font) <= maxW) return text;
    const chars = [...text];
    let lo = 0, hi = chars.length;
    while (lo < hi) {
      const m = Math.ceil((lo + hi) / 2);
      if (this.measure(chars.slice(0, m).join('') + '…', font) <= maxW) lo = m; else hi = m - 1;
    }
    return lo > 0 ? chars.slice(0, lo).join('').trim() + '…' : '';
  }

  /** a card's text in lines within a width, the last one cut with an ellipsis */
  wrap(text, font, maxW, maxLines) {
    if (!text) return [];
    const lines = [];
    let line = '';
    for (let word of text.split(' ')) {
      while (this.measure(word, font) > maxW && word.length > 1) {
        if (line) { lines.push(line); line = ''; }
        let n = word.length;
        while (n > 1 && this.measure(word.slice(0, n), font) > maxW) n = Math.floor(n * 0.9);
        lines.push(word.slice(0, n));
        word = word.slice(n);
        if (lines.length > maxLines * 6) break;
      }
      const next = line ? `${line} ${word}` : word;
      if (this.measure(next, font) > maxW && line) { lines.push(line); line = word; } else line = next;
      if (lines.length > maxLines * 6) break;
    }
    if (line) lines.push(line);
    if (lines.length <= maxLines) return lines;
    const out = lines.slice(0, maxLines);
    out[maxLines - 1] = out[maxLines - 1].slice(0, -Math.min(2, out[maxLines - 1].length)) + '…';
    return out;
  }

  shortTitle(a) {
    const w = (this.isCollapsed(a) ? this.expandedSize(a)[0] : this.size(a)[0]);
    return this.fitText(a.name, this.ctitle(), w - TH - BTN * (3 + (this.hasFolder(a) ? 1 : 0) + (this.hasIDE(a) ? 1 : 0)) - 50);
  }
  /** where a node's name ends in its title bar (double-click there renames) */
  nameEnd(a) { return TH + this.measure(this.shortTitle(a), this.ctitle()) + 8; }

  // ---------- drawing ----------

  draw() {
    const ctx = this.ctx, s = this.scale;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    if (!this.store.currentId) return;
    ctx.save();
    ctx.scale(s, s);
    ctx.translate(this.offset.x, this.offset.y);
    const area = rect(-this.offset.x, -this.offset.y, this.width / s, this.height / s);
    this.drawGroups();
    this.drawGrid(area);
    this.drawLinks();
    const lifted = this.draggingItems ? this.selected : new Set();
    for (const a of this.agents) if (!lifted.has(a.id) && intersects(inset(this.footprintOf(a), -16, -16), area)) this.drawNode(a);
    for (const a of this.agents) if (lifted.has(a.id)) this.drawNode(a);
    this.drawGroupFeedback();
    this.drawMarquee();
    ctx.restore();
  }

  drawGrid(area) {
    if (!showGrid.on) return;
    const ctx = this.ctx, step = 40;
    ctx.fillStyle = pal.grid;
    for (let x = Math.floor(area.x / step) * step; x < area.x + area.w; x += step) {
      for (let y = Math.floor(area.y / step) * step; y < area.y + area.h; y += step) ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }

  /** quiet enclosures, with colour kept for membership and the heading */
  drawGroups() {
    const ctx = this.ctx;
    for (const g of this.groups) {
      const r = this.groupRect(g), c = this.groupColor(g);
      ctx.save();
      rounded(ctx, r, 10);
      ctx.fillStyle = rgba(c, 0.055); ctx.fill();
      ctx.strokeStyle = rgba(c, 0.28); ctx.lineWidth = 1 / this.scale; ctx.stroke();
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(r.x + 13.5, r.y + 13.5, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(c, 0.5);
      ctx.beginPath(); ctx.moveTo(r.x + r.w - 13, r.y + r.h - 6); ctx.lineTo(r.x + r.w - 6, r.y + r.h - 13); ctx.stroke();
      ctx.restore();
      const f = this.cfont(12, 500);
      this.drawText(this.fitText(g.name, f, Math.max(0, r.w - 80)), f, pal.ink, r.x + 23, r.y + 18, { middle: false });
      // the group's shared note: an open book, filled once something is written, with its version
      const n = this.noteRect(g), written = (g.version ?? 0) > 0;
      const tint = this.hover.note === g.id ? pal.ink : written ? c : pal.muted;
      drawIcon(ctx, written ? 'book.closed.fill' : 'book.closed', n.x, n.y, n.w, n.h, tint);
      if (written) this.drawText(`v${g.version}`, this.cfont(10.5, 500), tint, n.x - 3, n.y + n.h / 2 + 4, { middle: false, align: 'right' });
    }
  }

  // ---------- links ----------

  /** where the segment from the centre of r toward p leaves r */
  edgePoint(r, p) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2, dx = p.x - cx, dy = p.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = Math.min(Math.abs((r.w / 2 + 6) / (dx || 1e-9)), Math.abs((r.h / 2 + 6) / (dy || 1e-9)));
    return { x: cx + dx * s, y: cy + dy * s };
  }

  endpoints(from, to, off = 0) {
    const A = this.store.agents.get(from), B = this.store.agents.get(to);
    if (!A || !B) return null;
    const ra = this.rectOf(A), rb = this.rectOf(B);
    const ca = { x: ra.x + ra.w / 2, y: ra.y + ra.h / 2 }, cb = { x: rb.x + rb.w / 2, y: rb.y + rb.h / 2 };
    const len = Math.max(Math.hypot(cb.x - ca.x, cb.y - ca.y), 1);
    const ox = -(cb.y - ca.y) / len * off, oy = (cb.x - ca.x) / len * off;
    const a = this.edgePoint(ra, { x: cb.x + ox, y: cb.y + oy }), b = this.edgePoint(rb, { x: ca.x + ox, y: ca.y + oy });
    return [{ x: a.x + ox, y: a.y + oy }, { x: b.x + ox, y: b.y + oy }];
  }

  drawArrow(a, b, color, { width = 1.5, dash = [], head = true, alpha = 1 } = {}) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (head) {
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4));
      ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  #both(l) { return this.store.links.some((x) => x.from === l.to && x.to === l.from && x.kind === 'message'); }

  /** what an agent is busy with for another: the label of the last arrow into it */
  workingOn(a) {
    if (!['running', 'waiting'].includes(a.status ?? '')) return null;
    const into = this.store.links.filter((l) => l.to === a.id && l.label);
    return (into.find((l) => l.kind === 'message') ?? into.find((l) => l.kind === 'created'))?.label ?? null;
  }

  drawLinks() {
    const ctx = this.ctx, links = this.store.links;
    for (const l of links) {
      const e = this.endpoints(l.from, l.to, l.kind === 'message' && this.#both(l) ? 6 : 0);
      if (!e) continue;
      if (l.kind === 'created') this.drawArrow(e[0], e[1], pal.muted2, { width: 2 });
      else this.drawArrow(e[0], e[1], '#6b6862', { width: 1.2, dash: [5, 5], alpha: 0.8 });
    }
    // an arrow's label, while the pointer is on it or the agent it points to works on that
    const isHover = (l) => this.hoverLink && this.hoverLink.from === l.from && this.hoverLink.to === l.to && this.hoverLink.kind === l.kind;
    const isWorking = (l) => { const a = this.store.agents.get(l.to); return l.label && a && this.workingOn(a) === l.label; };
    const pills = [];
    for (const l of links) {
      if (!l.label || !(isWorking(l) || isHover(l))) continue;
      const e = this.endpoints(l.from, l.to, l.kind === 'message' && this.#both(l) ? 6 : 0);
      if (!e) continue;
      const t = l.kind === 'created' ? 0.4 : 0.62, f = this.cfont(11, l.kind === 'created' ? 500 : 400);
      const s = this.fitText(l.label, f, 170), w = this.measure(s, f);
      const c = { x: e[0].x + (e[1].x - e[0].x) * t, y: e[0].y + (e[1].y - e[0].y) * t };
      pills.push({ s, f, c, r: rect(c.x - w / 2 - 7, c.y - 9, w + 14, 18), rank: isHover(l) ? 0 : l.kind === 'message' ? 1 : 2, strong: l.kind === 'created' });
    }
    const drawn = [];
    for (const p of pills.sort((a, b) => a.rank - b.rank)) {
      if (drawn.some((r) => intersects(inset(r, -6, -3), p.r))) continue;
      drawn.push(p.r);
      rounded(ctx, p.r, 9);
      ctx.fillStyle = pal.panel; ctx.fill();
      ctx.strokeStyle = pal.line; ctx.lineWidth = 1; ctx.stroke();
      this.drawText(p.s, p.f, p.strong ? pal.text : pal.muted, p.c.x, p.c.y + 4, { middle: false, align: 'center' });
    }
    // one sign for "this one waits for that one": a bright dashed line
    for (const a of this.agents) {
      for (const t of new Set([...(a.waitingOn ?? []), ...(a.workingWith ?? []), ...(a.blockedBy ?? [])])) {
        const e = this.endpoints(a.id, t, 6);
        if (e) this.drawArrow(e[0], e[1], pal.wait, { width: 2, dash: [8, 6], alpha: 0.9 });
      }
    }
    const t0 = now();
    this.pulses = this.pulses.filter((p) => (t0 - p.start) * 1000 < PULSE_MS);
    for (const p of this.pulses) {
      const t = (t0 - p.start) * 1000 / PULSE_MS, e = this.endpoints(p.from, p.to, 6);
      if (!e) continue;
      this.drawArrow(e[0], e[1], p.color, { width: 2.5, alpha: 1 - t * 0.6 });
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(e[0].x + (e[1].x - e[0].x) * t, e[0].y + (e[1].y - e[0].y) * t, 5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // ---------- the agent card ----------

  drawNode(a) {
    const ctx = this.ctx, r = this.rectOf(a), w = r.w, h = r.h - TH;
    const status = this.waitsForOthers(a) ? 'waiting' : a.status ?? 'idle';
    const scolor = { running: pal.ok, waiting: pal.wait, error: pal.err }[status] ?? null;
    const pulseAlpha = Math.pow(Math.sin((now() % 1.4) / 1.4 * Math.PI * 2), 2);
    ctx.save();
    ctx.translate(r.x, r.y + TH);

    // the body with its shadow, the title bar, the line under it
    const body = rect(0, -TH, w, h + TH), lifted = this.draggingItems && this.selected.has(a.id);
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${lifted ? 0.22 : 0.12})`;
    ctx.shadowBlur = (lifted ? 12 : 3) * this.scale * this.dpr;
    ctx.shadowOffsetY = (lifted ? 5 : 1) * this.scale * this.dpr;
    rounded(ctx, body, 8);
    ctx.fillStyle = pal.nodeBody; ctx.fill();
    ctx.restore();
    ctx.save();
    rounded(ctx, body, 8); ctx.clip();
    ctx.fillStyle = pal.nodeHead; ctx.fillRect(0, -TH, w, TH);
    if (!this.isCollapsed(a)) { ctx.fillStyle = pal.grid; ctx.fillRect(0, -1 / this.scale, w, 1 / this.scale); }
    ctx.restore();

    if (this.selected.has(a.id)) {
      ctx.save();
      ctx.globalAlpha = 0.8; ctx.strokeStyle = pal.accent; ctx.lineWidth = 1.5 / this.scale;
      rounded(ctx, rect(-3, -TH - 3, w + 6, h + TH + 6), 11); ctx.stroke();
      ctx.restore();
    } else if (this.hover.id === a.id && !this.drag) {
      ctx.save();
      ctx.strokeStyle = rgba(pal.muted, 0.55); ctx.lineWidth = 1 / this.scale;
      rounded(ctx, body, 8); ctx.stroke();
      ctx.restore();
    }

    // title: the CLI's logo tile, the name
    this.drawLogo(a.backend, 9, -TH + (TH - 14) / 2, 14);
    const title = this.shortTitle(a), tf = this.ctitle();
    this.drawText(title, tf, pal.ink, TH, this.midBaseline(tf, -TH / 2), { middle: false });
    let whyW = 0;
    const why = this.workingOn(a);
    if (why) {
      const nameW = this.measure(title, tf), f = this.cfont(11.5);
      const room = w - TH - nameW - BTN * (2 + (this.hasFolder(a) ? 1 : 0) + (this.hasIDE(a) ? 1 : 0)) - 64;
      const s = this.fitText(why, f, room);
      if (room > 40 && s) { this.drawText(s, f, pal.muted, TH + nameW + 8, this.midBaseline(f, -TH / 2), { middle: false }); whyW = this.measure(s, f) + 8; }
    }

    // a solid, flush rail makes group membership readable at a glance
    const g = this.innerGroup(a);
    if (g) { ctx.save(); rounded(ctx, body, 8); ctx.clip(); ctx.fillStyle = this.groupColor(g); ctx.fillRect(0, -TH, 4, h + TH); ctx.restore(); }

    const bx = w - BTN - 6, by = -TH + (TH - 18) / 2;
    if (this.hasFolder(a)) {
      this.titleButton(bx, by, a.shell ? 'rgba(0,0,0,0.333)' : pal.tintStrong, this.hover.term === a.id, this.pressDepth(a.id, 'term'),
        (q) => drawIcon(ctx, a.shell ? 'minus' : 'terminal', q.x + (q.w - 15) / 2, q.y + (q.h - 15) / 2, 15, 15, pal.ink));
    }
    const lead = this.hasFolder(a) ? bx - BTN - 4 : bx;
    if (this.hasIDE(a)) {
      this.titleButton(lead, by, pal.faint, this.hover.ide === a.id, this.pressDepth(a.id, 'ide'),
        (q) => drawIcon(ctx, 'chevron.left.forwardslash.chevron.right', q.x + (q.w - 14) / 2, q.y + (q.h - 14) / 2, 14, 14, pal.ink));
    }
    // the switch that makes it an orchestrator: lit while it may create agents for parts of its work
    const hx = this.hasIDE(a) ? lead - BTN - 4 : lead, helping = a.delegate === true;
    this.titleButton(hx, by, helping ? rgba(pal.accent, 0.22) : pal.faint, this.hover.helpers === a.id, this.pressDepth(a.id, 'helpers'),
      (q) => drawIcon(ctx, helping ? 'person.2.fill' : 'person.2', q.x + (q.w - 15) / 2, q.y + (q.h - 15) / 2, 15, 15, helping ? pal.accent : pal.ink));
    const fx = hx - BTN - 4;
    this.titleButton(fx, by, pal.faint, this.hover.fold === a.id, this.pressDepth(a.id, 'fold'),
      (q) => drawIcon(ctx, this.isCollapsed(a) ? 'chevron.down' : 'minus', q.x + (q.w - 14) / 2, q.y + (q.h - 14) / 2, 14, 14, pal.ink));
    // computer control's key: breathes while the agent asks for the screen, lit while it has it
    const computer = this.computerOf(a);
    if (computer) {
      const needs = computer.missing?.length > 0, tint = needs ? pal.warn : pal.accent;
      const flash = computer.at ? Math.max(0, 1 - (Date.now() - computer.at) / 600) : 0;
      const glow = computer.state === 'asking' ? 0.12 + 0.3 * pulseAlpha : 0.22 + 0.25 * flash;
      this.titleButton(fx - BTN - 4, by, rgba(tint, glow), this.hover.computer === a.id, this.pressDepth(a.id, 'computer'),
        (q) => drawIcon(ctx, 'display', q.x + (q.w - 15) / 2, q.y + (q.h - 15) / 2, 15, 15, tint));
    }
    const tx = computer ? fx - BTN - 4 : fx;

    // status: a dot left of the buttons; queued messages: a badge on the terminal button
    if (scolor) {
      ctx.save();
      ctx.globalAlpha = status === 'running' ? 0.55 + 0.45 * pulseAlpha : 1;
      ctx.fillStyle = scolor;
      ctx.beginPath(); ctx.arc(tx - 11, -TH / 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    if (a.queued > 0) {
      const f = this.cfont(10, 700), label = String(a.queued), bw = Math.max(15, this.measure(label, f) + 8);
      const qx = bx + BTN - bw / 2 + 3, qy = by - 4;
      rounded(ctx, rect(qx, qy - 7, bw, 15), 7.5);
      ctx.fillStyle = pal.accent; ctx.fill();
      this.drawText(label, f, '#fff', qx + bw / 2, qy + 0.5, { align: 'center' });
    }
    // the status outline, pulsing while running or waiting
    if (scolor) {
      ctx.save();
      ctx.globalAlpha = status === 'error' ? 0.9 : 0.45 + 0.45 * pulseAlpha;
      ctx.strokeStyle = scolor; ctx.lineWidth = 2;
      rounded(ctx, rect(-3, -TH - 3, w + 6, h + TH + 6), 10); ctx.stroke();
      ctx.restore();
    }
    // heard a double-click it can't act on yet: an accent outline that fades
    const fl = this.flashes.get(a.id);
    if (fl != null) {
      const t = Math.min(1, (now() - fl) / 0.7), grow = 3 + 6 * t;
      ctx.save();
      ctx.globalAlpha = 1 - t; ctx.strokeStyle = pal.accent; ctx.lineWidth = 2.5;
      rounded(ctx, rect(-grow, -TH - grow, w + grow * 2, h + TH + grow * 2), 10 + grow); ctx.stroke();
      ctx.restore();
    }

    if (this.isCollapsed(a)) {
      // folded: a tool waiting for approval lights the bar red
      if (a.panel?.spec && a.panel?.status === 'pending') {
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * pulseAlpha; ctx.strokeStyle = pal.err; ctx.lineWidth = 2;
        rounded(ctx, rect(-3, -TH - 3, w + 6, TH + 6), 10); ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
      return;
    }

    if ((a.shell || this.hasTranscript(a)) && this.terminalsShown) {
      // the terminal or chat covers the body; where it works sits in the title bar after the name
      const nx = this.nameEnd(a) + 6 + whyW, room = tx - 22 - nx;
      if (room > 60 && (a.folder || a.accountName)) this.drawMeta(a, nx + 8, -TH / 2 + 1, room - 8, pal.muted1);
      ctx.fillStyle = pal.bg;
      ctx.fillRect(4, 2, w - 14, h - 12);
      this.grip(w, h);
      ctx.restore();
      return;
    }

    const pad = 10;
    this.drawMeta(a, pad, 15, w - pad * 2, a.folder || a.accountName ? pal.muted1 : pal.muted);
    const streaming = this.store.streaming.get(a.id);
    const text = (status === 'running' ? streaming : null) ?? a.lastError ?? (a.lastText || null) ?? a.role ?? '';
    const lines = Math.max(1, Math.floor((h - 32) / 17));
    const color = a.lastError && status !== 'running' ? pal.err : a.lastText || status === 'running' ? pal.ink : pal.muted;
    const f = this.cfont(12.5);
    const clean = String(text).replace(/\s+/g, ' ').trim();
    this.wrap(clean, f, w - pad * 2, lines).forEach((line, i) => this.drawText(line, f, color, pad, 38 + i * 17));
    if (this.hover.id === a.id) this.grip(w, h);
    ctx.restore();
  }

  /** a square in a node's title bar: its fill, lighter under the pointer, dipping in for a moment when pressed */
  titleButton(x, y, fill, hover, depth, drawGlyph) {
    const ctx = this.ctx, full = rect(x, y, BTN, 18), q = inset(full, full.w * 0.06 * depth, full.h * 0.06 * depth);
    rounded(ctx, q, 5); ctx.fillStyle = fill; ctx.fill();
    if (hover || depth > 0) { rounded(ctx, q, 5); ctx.fillStyle = rgba(pal.ink, 0.08 + 0.1 * depth); ctx.fill(); }
    drawGlyph(q);
  }

  grip(w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = pal.muted; ctx.lineWidth = 1.5;
    for (const d of [4, 8]) { ctx.beginPath(); ctx.moveTo(w - 2, h - 2 - d); ctx.lineTo(w - 2 - d, h - 2); ctx.stroke(); }
  }

  /** the CLI's mark: its own icon, else its brand mark on its colour; a terminal symbol for one without a logo */
  drawLogo(backend, x, y, size) {
    const ctx = this.ctx, tile = rect(x - 3, y - 3, size + 6, size + 6);
    ctx.save();
    const img = logoImage(backend);
    if (img) {
      rounded(ctx, tile, 5); ctx.clip();
      if (img.complete && img.naturalWidth) ctx.drawImage(img, tile.x, tile.y, tile.w, tile.h);
      else img.addEventListener('load', () => this.kick(), { once: true });
      ctx.restore();
      return;
    }
    rounded(ctx, tile, 5);
    ctx.fillStyle = logos.tiles[backend] ?? '#6b6862'; ctx.fill();
    const d = logos.paths[backend];
    if (d) {
      ctx.translate(x, y); ctx.scale(size / 24, size / 24);
      ctx.fillStyle = '#fff'; ctx.fill(logoPath(backend, d));
    } else drawIcon(ctx, 'terminal', x, y, size, size, '#fff');
    ctx.restore();
  }

  /** folder, branch and account when chosen, else the model; icons instead of labels */
  drawMeta(a, x0, y, maxW, color) {
    const f = this.cfont(11.5), parts = [];
    if (a.sandbox === 'read-only' || a.chatMode === 'ask' || a.chatMode === 'plan') parts.push(['lock', '']);
    if (a.folder) { parts.push(['folder', a.folder.name]); if (a.folder.branch) parts.push(['arrow.triangle.branch', a.folder.branch]); }
    if (a.accountName) parts.push(['person', a.accountName]);
    if (!parts.length) parts.push([null, [a.model ?? '', a.sandbox === 'read-only' ? 'okur' : ''].filter(Boolean).join(' · ')]);
    if (a.effort) parts.push(['brain', effortName(a.effort)]);
    const u = a.usageKey ? this.store.usageFor(a.usageKey) : null;
    const peak = u?.windows?.length ? u.windows.reduce((m, w) => (w.used > m.used ? w : m)) : null;
    const level = u?.limited ? 'full' : (peak?.used ?? 0) >= 0.95 ? 'full' : (peak?.used ?? 0) >= 0.75 ? 'high' : 'calm';
    if (u && level !== 'calm' && peak) parts.splice(Math.min(1, parts.length), 0, ['gauge.with.dots.needle.67percent', u.limited ? 'dolu' : `%${Math.round(peak.used * 100)}`]);
    let x = x0, room = maxW;
    parts.forEach(([ic, text], i) => {
      if (room <= 0) return;
      const iw = ic ? 15 : 0, full = this.measure(text, f), last = i === parts.length - 1;
      const width = i === 0 ? Math.min(full, last ? room - iw : Math.max(room * 0.62, room - iw - 90)) : Math.min(full, room - iw);
      if (i > 0 && width < Math.min(full, 70)) { room = 0; return; }
      if (!text && ic) {
        if (room <= 16) return;
        drawIcon(this.ctx, ic, x, y - 6, 12, 12, color);
        x += 18; room -= 18;
        return;
      }
      const t = room > 24 ? this.fitText(text, f, width) : '';
      if (!t) return;
      if (ic) drawIcon(this.ctx, ic, x, y - 6, 12, 12, color);
      this.drawText(t, f, color, x + iw, y);
      const used = iw + this.measure(t, f) + 12;
      x += used; room -= used;
    });
  }

  drawGroupFeedback() {
    const ctx = this.ctx;
    ctx.save();
    if (this.draggingItems) {
      const changes = this.membershipChanges();
      for (const gid of new Set(changes.map((c) => c.gid))) {
        const g = this.store.groups.get(gid);
        if (!g) continue;
        const joining = changes.some((c) => c.gid === gid && c.kind === 'join');
        ctx.strokeStyle = rgba(this.groupColor(g), joining ? 0.85 : 0.4);
        ctx.lineWidth = (joining ? 2 : 1) / this.scale;
        ctx.setLineDash(joining ? [] : [4 / this.scale, 4 / this.scale]);
        rounded(ctx, this.groupRect(g), 10); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    const t = now();
    this.groupAnims = this.groupAnims.filter((an) => (t - an.start) * 1000 < (an.kind === 'born' ? BORN_MS : JOIN_MS));
    for (const an of this.groupAnims) {
      const g = this.store.groups.get(an.gid);
      if (!g) continue;
      const opacity = 1 - (t - an.start) * 1000 / (an.kind === 'born' ? BORN_MS : JOIN_MS);
      ctx.strokeStyle = rgba(this.groupColor(g), opacity * 0.6);
      ctx.lineWidth = 2 / this.scale;
      rounded(ctx, this.groupRect(g), 10); ctx.stroke();
    }
    ctx.restore();
  }

  /** a selection drag: a soft rounded marquee; the nodes it takes get a ring; a count rides its corner */
  drawMarquee() {
    if (this.drag?.kind !== 'marquee') return;
    const { start: s, now: n } = this.drag, ctx = this.ctx;
    const m = rect(Math.min(s.x, n.x), Math.min(s.y, n.y), Math.abs(n.x - s.x), Math.abs(n.y - s.y));
    if (m.w + m.h < 4) return;
    ctx.save();
    rounded(ctx, m, 12 / this.scale);
    ctx.fillStyle = rgba(pal.accent, 0.07); ctx.fill();
    ctx.strokeStyle = rgba(pal.accent, 0.75); ctx.lineWidth = 1.5 / this.scale; ctx.stroke();
    let count = 0;
    for (const a of this.agents) {
      if (!intersects(this.rectOf(a), m)) continue;
      count++;
      ctx.save();
      ctx.strokeStyle = pal.accent; ctx.lineWidth = 2.5 / this.scale;
      ctx.shadowColor = pal.accent; ctx.shadowBlur = 14 * this.dpr;
      rounded(ctx, inset(this.rectOf(a), -4, -4), 11); ctx.stroke();
      ctx.restore();
    }
    if (count) {
      const rad = 11 / this.scale;
      const cx = n.x + (n.x >= m.x + m.w / 2 ? 1 : -1) * rad * 1.4, cy = n.y + (n.y >= m.y + m.h / 2 ? 1 : -1) * rad * 1.4;
      ctx.fillStyle = pal.accent;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.fill();
      this.drawText(String(count), { css: `700 ${12 / this.scale}px ${FONT}`, size: 12 / this.scale }, pal.bg, cx, cy + 0.5 / this.scale, { align: 'center' });
    }
    ctx.restore();
  }

  // ---------- group membership while nodes move ----------

  beginMembership() {
    this.dragStartGroups = new Map(this.agents.map((a) => [a.id, this.groupIds(a)]));
    this.dragPos = new Map(this.agents.map((a) => [a.id, this.pos(a)]));
  }

  membershipChanges() {
    if (!this.dragStartGroups) return [];
    const out = [];
    for (const a of this.agents) {
      const was = this.dragStartGroups.get(a.id);
      if (!was) continue;
      const is = this.groupIds(a);
      for (const gid of is) if (!was.has(gid)) out.push({ id: a.id, gid, kind: 'join' });
      for (const gid of was) if (!is.has(gid)) out.push({ id: a.id, gid, kind: 'leave' });
    }
    return out;
  }

  finishMembership() {
    if (reduceMotion.matches) return;
    const changes = this.membershipChanges(), t = now();
    for (const gid of new Set(changes.map((c) => c.gid))) {
      this.groupAnims.push({ gid, kind: changes.some((c) => c.gid === gid && c.kind === 'join') ? 'join' : 'leave', start: t });
    }
  }

  // ---------- a node that opened or closed its terminal moves to a free spot ----------

  syncModes() {
    const moved = new Set();
    for (const a of this.agents) {
      const was = this.modes.get(a.id), is = !!a.shell;
      this.modes.set(a.id, is);
      if (was == null || was === is) continue;
      const gids = this.groupsAt(a);
      const p = is ? this.placeFree(a) : null;
      if (p) { this.store.move(a.id, [p.x, p.y]); moved.add(a.id); }
      this.fitGroups(gids, a.id);
    }
    for (const id of this.modes.keys()) if (!this.store.agents.has(id)) this.modes.delete(id);
    return moved;
  }

  groupsAt(a) {
    const r = this.rectOf(a), pts = [{ x: r.x + 1, y: r.y + 1 }, { x: r.x + r.w / 2, y: r.y + r.h / 2 }];
    const area = (g) => { const q = this.groupRect(g); return q.w * q.h; };
    return this.groups.filter((g) => pts.some((p) => this.inside(g, p))).sort((x, y) => area(x) - area(y)).map((g) => g.id);
  }
  membersOf(gid) { const g = this.store.groups.get(gid); return g ? this.agents.filter((a) => this.inside(g, this.centerOf(a))).map((a) => a.id) : []; }
  boundsOf(ids) {
    const rs = ids.map((id) => this.store.agents.get(id)).filter(Boolean).map((a) => this.rectOf(a));
    if (!rs.length) return null;
    const u = rs.reduce(union);
    return rect(u.x - 30, u.y - 60, u.w + 60, u.h + 90);
  }

  /** the nearest free spot on a 40 grid for a node that grew, preferring right and below */
  placeFree(a) {
    const overlaps = (p, q) => p.x < q.x + q.w + 40 && q.x < p.x + p.w + 40 && p.y < q.y + q.h + 30 && q.y < p.y + p.h + 30;
    const others = this.agents.filter((o) => o.id !== a.id).map((o) => this.footprintOf(o));
    const own = this.footprintOf(a), p0 = this.pos(a);
    const free = (x, y) => !others.some((o) => overlaps(rect(x, y - TH, own.w, own.h), o));
    if (free(p0.x, p0.y)) return null;
    let best = null;
    for (let gx = -40; gx <= 40; gx++) for (let gy = -40; gy <= 40; gy++) {
      const x = p0.x + gx * 40, y = p0.y + gy * 40, d = Math.hypot(gx, gy) - (gx > 0 ? 0.01 : 0) - (gy > 0 ? 0.005 : 0);
      if ((!best || d < best.d) && free(x, y)) best = { p: { x: Math.round(x), y: Math.round(y) }, d };
    }
    return best?.p ?? null;
  }

  /** the groups a node sat in grow to hold it again, inner ones first */
  fitGroups(gids, id) {
    let inner = null;
    for (const gid of gids) {
      const g = this.store.groups.get(gid);
      if (!g || g.rect?.length < 4) continue;
      const cur = rect(...g.rect), base = this.baseRects.get(gid) ?? cur;
      let r = base;
      const b = this.boundsOf([...new Set([...this.membersOf(gid), id])]);
      if (b) r = union(r, b);
      if (inner) r = union(r, inner);
      const next = [r.x, r.y, r.w, r.h].map(Math.round);
      inner = rect(...next);
      if (next.every((v, i) => v === g.rect[i])) continue;
      this.baseRects.set(gid, base);
      this.store.setGroupRect(gid, next);
    }
  }

  // ---------- pointer ----------

  #point(e) { const b = this.canvas.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }

  #bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.#down(e));
    c.addEventListener('pointermove', (e) => this.#move(e));
    c.addEventListener('pointerup', (e) => this.#up(e));
    c.addEventListener('pointercancel', (e) => this.#up(e));
    c.addEventListener('pointerleave', () => { if (!this.drag && Object.keys(this.hover).length) { this.hover = {}; this.hoverLink = null; this.kick(); } });
    c.addEventListener('dblclick', (e) => this.#doubleClick(this.toGraph(this.#point(e))));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#rightClick(e); });
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    c.addEventListener('keydown', (e) => this.#key(e));
    // Safari's pinch
    c.addEventListener('gesturestart', (e) => { e.preventDefault(); this.gestureScale = 1; });
    c.addEventListener('gesturechange', (e) => { e.preventDefault(); this.zoom(e.scale / (this.gestureScale || 1), this.#point(e)); this.gestureScale = e.scale; });
  }

  #down(e) {
    if (e.button !== 0) return;
    this.canvas.focus({ preventScroll: true });
    this.actions.viewMoved?.();
    const sp = this.#point(e), p = this.toGraph(sp), cmd = e.metaKey || e.ctrlKey;
    if (e.detail >= 2) return;
    const a = this.agentAt(p);
    if (a) {
      this.store.raise(a.id);
      if (this.inTermButton(a, p)) { this.press(a.id, 'term'); this.actions.toggleTerminal?.(a.id); return; }
      if (this.inIDEButton(a, p)) { this.press(a.id, 'ide'); this.actions.openIDE?.(a.id); return; }
      if (this.inFoldButton(a, p)) { this.press(a.id, 'fold'); this.actions.toggleCollapsed?.(a.id); return; }
      if (this.inHelpersButton(a, p)) { this.press(a.id, 'helpers'); this.actions.toggleHelpers?.(a.id); return; }
      if (this.inComputerButton(a, p)) { this.press(a.id, 'computer'); this.actions.computerKey?.(a.id); return; }
      this.canvas.setPointerCapture(e.pointerId);
      const corner = this.cornerAt(a, p);
      if (corner) { this.drag = { kind: 'resize', id: a.id, corner, start: p, rect: this.rectOf(a) }; return; }
      if (e.shiftKey) { const s = new Set(this.selected); if (s.has(a.id)) s.delete(a.id); else s.add(a.id); this.select(s); }
      else if (!this.selected.has(a.id)) this.select([a.id]);
      this.drag = { kind: 'nodes', start: p, from: new Map(this.agents.filter((x) => this.selected.has(x.id)).map((x) => [x.id, this.pos(x)])) };
      this.beginMembership();
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    if (cmd) { this.drag = { kind: 'marquee', start: p, now: p }; this.select([]); this.kick(); return; }
    const note = this.groupNoteAt(p);
    if (note) { this.actions.openGroupNote?.(note.id, this.clientRect(this.noteRect(note))); return; }
    const gr = this.groupResizeAt(p);
    if (gr) { this.drag = { kind: 'groupResize', id: gr.id, start: p, rect: this.groupRect(gr) }; return; }
    const gt = this.groupTitleAt(p);
    if (gt) {
      this.drag = { kind: 'group', id: gt.id, start: p, rect: this.groupRect(gt), members: new Map(this.agents.filter((x) => this.inside(gt, this.centerOf(x))).map((x) => [x.id, this.pos(x)])) };
      this.beginMembership();
      return;
    }
    this.select([]);
    this.drag = { kind: 'pan', start: sp, offset: { ...this.offset } };
    this.canvas.style.cursor = 'grabbing';
  }

  #move(e) {
    const sp = this.#point(e), p = this.toGraph(sp), d = this.drag;
    if (!d) return this.#hover(sp, p, e);
    switch (d.kind) {
      case 'pan': this.moveView(this.scale, { x: d.offset.x + (sp.x - d.start.x) / this.scale, y: d.offset.y + (sp.y - d.start.y) / this.scale }); break;
      case 'nodes':
        this.draggingItems = true;
        for (const [id, f] of d.from) this.localPos.set(id, { x: f.x + p.x - d.start.x, y: f.y + p.y - d.start.y });
        this.onLayout();
        break;
      case 'resize': this.#resizeNode(d, { x: p.x - d.start.x, y: p.y - d.start.y }); break;
      case 'group': {
        const dx = p.x - d.start.x, dy = p.y - d.start.y;
        this.localGroup.set(d.id, rect(d.rect.x + dx, d.rect.y + dy, d.rect.w, d.rect.h));
        for (const [id, f] of d.members) this.localPos.set(id, { x: f.x + dx, y: f.y + dy });
        this.onLayout();
        break;
      }
      case 'groupResize': this.localGroup.set(d.id, rect(d.rect.x, d.rect.y, Math.max(140, d.rect.w + p.x - d.start.x), Math.max(80, d.rect.h + p.y - d.start.y))); break;
      case 'marquee': d.now = p; break;
    }
    this.kick();
  }

  /** a corner drag: LiteGraph's rule (top and left corners move the node too), held above the minimum */
  #resizeNode(d, delta) {
    const a = this.store.agents.get(d.id);
    if (!a) return;
    const mn = a.shell ? MIN_TERM : this.hasTranscript(a) ? MIN_CHAT : MIN_CARD, r = d.rect;
    let { x, y, w, h } = r;
    if (d.corner === 'se') { w += delta.x; h += delta.y; }
    if (d.corner === 'sw') { x += delta.x; w -= delta.x; h += delta.y; }
    if (d.corner === 'ne') { y += delta.y; w += delta.x; h -= delta.y; }
    if (d.corner === 'nw') { x += delta.x; y += delta.y; w -= delta.x; h -= delta.y; }
    if (w < mn[0]) { if (d.corner === 'sw' || d.corner === 'nw') x = r.x + r.w - mn[0]; w = mn[0]; }
    if (h - TH < mn[1]) { if (d.corner === 'ne' || d.corner === 'nw') y = r.y + r.h - mn[1] - TH; h = mn[1] + TH; }
    this.localSize.set(d.id, [w, h - TH]);
    this.localPos.set(d.id, { x, y: y + TH });
    this.onLayout();
  }

  #up(e) {
    const d = this.drag;
    this.drag = null;
    const wasDragging = this.draggingItems;
    this.draggingItems = false;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.canvas.style.cursor = '';
    if (!d) return;
    switch (d.kind) {
      case 'nodes':
        this.finishMembership();
        for (const a of this.agents) {
          const before = this.dragPos?.get(a.id), p = this.pos(a);
          if (before && (p.x !== before.x || p.y !== before.y)) this.store.move(a.id, [Math.round(p.x), Math.round(p.y)]);
        }
        break;
      case 'resize': {
        const a = this.store.agents.get(d.id), s = this.localSize.get(d.id);
        if (a && s) {
          const p = this.pos(a);
          this.store.resize(d.id, s.map(Math.round), !!a.shell, [Math.round(p.x), Math.round(p.y)]);
        }
        this.localSize.delete(d.id);
        break;
      }
      case 'group': {
        this.finishMembership();
        const r = this.localGroup.get(d.id);
        if (r) { this.baseRects.delete(d.id); this.store.setGroupRect(d.id, [r.x, r.y, r.w, r.h].map(Math.round)); }
        this.localGroup.delete(d.id);
        for (const id of d.members.keys()) { const a = this.store.agents.get(id); if (a) { const p = this.pos(a); this.store.move(id, [Math.round(p.x), Math.round(p.y)]); } }
        break;
      }
      case 'groupResize': {
        const r = this.localGroup.get(d.id);
        if (r) { this.baseRects.delete(d.id); this.store.setGroupRect(d.id, [r.x, r.y, r.w, r.h].map(Math.round)); }
        this.localGroup.delete(d.id);
        break;
      }
      case 'marquee': {
        const m = rect(Math.min(d.start.x, d.now.x), Math.min(d.start.y, d.now.y), Math.abs(d.now.x - d.start.x), Math.abs(d.now.y - d.start.y));
        this.marqueeEnded = true;
        if (m.w + m.h > 4) this.select(this.agents.filter((a) => intersects(this.rectOf(a), m)).map((a) => a.id));
        this.marqueeEnded = false;
        break;
      }
    }
    this.localPos.clear();
    this.dragStartGroups = null;
    if (wasDragging || d.kind !== 'pan') this.onLayout();
    this.kick();
  }

  #doubleClick(p) {
    const a = this.agentAt(p);
    if (a) {
      const r = this.rectOf(a);
      if (p.y < r.y + TH && p.x < r.x + this.nameEnd(a)) {
        this.actions.renameAgent?.(a.id, this.clientRect(rect(r.x + 30, r.y + 3, Math.max(120, this.nameEnd(a) - 26), TH - 6)));
      }
      return;
    }
    const g = this.groupTitleAt(p);
    if (g) { const r = this.groupRect(g); this.actions.renameGroup?.(g.id, this.clientRect(rect(r.x + 2, r.y + 2, Math.min(r.w - 4, 320), 18 * 1.4 - 2))); }
  }

  #rightClick(e) {
    const p = this.toGraph(this.#point(e)), a = this.agentAt(p);
    const at = { x: e.clientX, y: e.clientY };
    if (a) { if (!this.selected.has(a.id)) this.select([a.id]); this.actions.menu?.({ agent: a.id }, at, p); }
    else { const g = this.groupAt(p); this.actions.menu?.(g ? { group: g.id } : { canvas: true }, at, p); }
  }

  /** GraphView.scrollWheel; chats and terminals hand their ⌘-wheels and pinches here */
  wheel(e) {
    e.preventDefault();
    this.actions.viewMoved?.();
    const sp = this.#point(e);
    // a mouse wheel zooms, as do pinches (ctrl) and ⌘; a trackpad's two fingers pan.
    // Wheel up / fingers up zooms in, as LiteGraph does.
    const mouse = wheelFromMouse(e);
    if (mouse) this.zoom(Math.max(0.2, 1 + wheelLines(e) * 0.04), sp);
    else if (e.ctrlKey) this.zoom(Math.exp(-e.deltaY * 0.01), sp);
    else if (e.metaKey) this.zoom(Math.max(0.2, 1 - e.deltaY * 0.004), sp);
    else this.moveView(this.scale, { x: this.offset.x - e.deltaX / this.scale, y: this.offset.y - e.deltaY / this.scale });
  }

  #key(e) {
    const id = [...this.selected][0];
    if ((e.key === 'Backspace' || e.key === 'Delete') && id) { e.preventDefault(); this.actions.deleteAgent?.(id); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && this.selected.size) { e.preventDefault(); this.actions.groupSelection?.(); }
  }

  /** the cursor says what a press would do; the card under the pointer shows its corner grip */
  #hover(sp, p, e) {
    const a = this.agentAt(p);
    let cursor = 'default', tip = '';
    const next = {};
    if (a) {
      if (!a.shell) next.id = a.id;
      if (this.inTermButton(a, p)) { next.term = a.id; tip = a.shell ? L('Close terminal') : L('Open terminal'); }
      else if (this.inIDEButton(a, p)) { next.ide = a.id; tip = 'IDE'; }
      else if (this.inFoldButton(a, p)) { next.fold = a.id; tip = a.collapsed ? L('Open') : L('Fold'); }
      else if (this.inHelpersButton(a, p)) { next.helpers = a.id; tip = a.delegate ? L('Creates agents') : L('Create agents'); }
      else if (this.inComputerButton(a, p)) {
        next.computer = a.id;
        const c = this.computerOf(a);
        tip = c.missing?.length ? L('Allow in System Settings') : c.state === 'asking' ? L('Allow computer control') : L('Controls the computer');
      }
      if (next.term || next.ide || next.fold || next.helpers || next.computer) cursor = 'pointer';
      else { const c = this.cornerAt(a, p); if (c) cursor = c === 'se' || c === 'nw' ? 'nwse-resize' : 'nesw-resize'; }
    } else {
      const note = this.groupNoteAt(p);
      if (note) { next.note = note.id; cursor = 'pointer'; }
      else if (this.groupResizeAt(p)) cursor = 'nwse-resize';
      else if (e.metaKey || e.ctrlKey) cursor = 'crosshair';
    }
    const link = a ? null : this.linkAt(p);
    const changed = JSON.stringify(next) !== JSON.stringify(this.hover) || link !== this.hoverLink;
    this.hover = next;
    this.hoverLink = link;
    this.canvas.style.cursor = cursor;
    this.canvas.title = tip;
    if (changed) this.kick();
  }
}

// Whether a wheel event came from a mouse wheel (NSEvent.hasPreciseScrollingDeltas == false), read from what Chromium
// puts in it: a trackpad's wheelDelta is exactly three times its whole-pixel delta; a Mac wheel's delta is its line
// count × 40 with a fixed-point fraction (4.000244), elsewhere whole notches of 120. Firefox counts lines.
const mac = /Mac/.test(navigator.platform || navigator.userAgent);
export function wheelFromMouse(e) {
  if (e.deltaMode === 1 || e.deltaMode === 2) return true;
  const w = e.wheelDeltaY, h = e.wheelDeltaX;
  if (typeof w !== 'number') return e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
  if (!w && !h) return false;
  if (w === -3 * e.deltaY && h === -3 * e.deltaX) return false;
  return mac || (w % 120 === 0 && h % 120 === 0);
}
/** a mouse wheel's turn in lines (NSEvent.scrollingDeltaY), up positive */
export function wheelLines(e) {
  if (e.deltaMode === 1) return -e.deltaY;
  if (e.deltaMode === 2) return -e.deltaY * 10;
  if (mac) return -e.deltaY / 40;
  return typeof e.wheelDeltaY === 'number' && e.wheelDeltaY ? e.wheelDeltaY / 120 : -e.deltaY / 100;
}

const logoImages = new Map();
function logoImage(backend) {
  const svg = logos.icons[backend];
  if (!svg) return null;
  let img = logoImages.get(backend);
  if (!img) { img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); logoImages.set(backend, img); }
  return img;
}
const logoPaths = new Map();
function logoPath(backend, d) { let p = logoPaths.get(backend); if (!p) { p = new Path2D(d); logoPaths.set(backend, p); } return p; }
