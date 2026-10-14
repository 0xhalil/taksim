// Terminal layer: one xterm per open terminal node, in HTML positioned over the LiteGraph canvas and kept
// aligned with its node on every frame (LiteGraph draws on a canvas, so nodes can't hold DOM themselves).

import { Terminal } from "../vendor/xterm.mjs";
import { FitAddon } from "../vendor/xterm-addon-fit.mjs";
import { T, onTheme } from "./theme.mjs";

const EDGE = 10; // px of node edge left uncovered for resizing
const MIN_SCALE = 0.45; // below this the text is unreadable; the node shows its summary card instead
// the JetBrains terminal colors of each theme
const DARK = { background: "#1e1f22", foreground: "#bcbec4", cursor: "#ced0d6", selectionBackground: "#2e436e", black: "#1e1f22", brightBlack: "#6f737a" };
const LIGHT = { background: "#ffffff", foreground: "#1e1f22", cursor: "#1e1f22", cursorAccent: "#ffffff", selectionBackground: "#d4e2ff",
  black: "#000000", red: "#c7222d", green: "#067d17", yellow: "#a67c00", blue: "#1750eb", magenta: "#871094", cyan: "#0e7d8c", white: "#6c707e",
  brightBlack: "#8c8c8c", brightRed: "#e55765", brightGreen: "#208a3c", brightYellow: "#c27d04", brightBlue: "#3574f0", brightMagenta: "#a64ab3",
  brightCyan: "#1a9aa8", brightWhite: "#1e1f22" };
export const termTheme = () => (T.name === "light" ? LIGHT : DARK);

export class TermLayer {
  constructor(container, { onFocus, onGone } = {}) {
    this.el = container;
    this.terms = new Map(); // agent id -> { div, term, fit, ws, size, canvasId, closed, retries }
    this.onFocus = onFocus;
    this.onGone = onGone; // the server has no terminal for this agent any more (e.g. it restarted)
    this.visible = true;
    onTheme(() => { for (const e of this.terms.values()) e.term.options.theme = termTheme(); });
  }

  ensure(canvasId, agentId) {
    if (this.terms.has(agentId)) return;
    const div = document.createElement("div");
    div.className = "term";
    this.el.appendChild(div);
    const term = new Terminal({ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: termTheme(), cursorBlink: true, scrollback: 5000, allowProposedApi: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(div);
    const entry = { div, term, fit, ws: null, size: null, canvasId, closed: false, retries: 0 };
    this.terms.set(agentId, entry);

    // keep pointer, wheel and keys inside the terminal instead of panning/zooming/deleting on the canvas
    for (const ev of ["pointerdown", "mousedown", "wheel", "keydown", "keyup", "dblclick", "contextmenu"]) {
      div.addEventListener(ev, (e) => e.stopPropagation());
    }
    div.addEventListener("pointerdown", () => this.onFocus?.(agentId));
    term.onData((d) => { if (entry.ws?.readyState === 1) entry.ws.send(JSON.stringify({ t: "i", d })); });
    term.onResize(({ cols, rows }) => { if (entry.ws?.readyState === 1) entry.ws.send(JSON.stringify({ t: "r", cols, rows })); });
    this.connect(agentId);
  }

  connect(agentId) {
    const entry = this.terms.get(agentId);
    if (!entry || entry.closed) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/term/${entry.canvasId}/${agentId}`);
    entry.ws = ws;
    ws.onopen = () => {
      entry.retries = 0;
      entry.term.reset();
      const { cols, rows } = entry.term;
      ws.send(JSON.stringify({ t: "r", cols, rows }));
    };
    ws.onmessage = (m) => entry.term.write(typeof m.data === "string" ? m.data : new Uint8Array(m.data));
    // retry briefly (network blips); after that, ask the app to re-check whether the terminal still exists
    ws.onclose = () => {
      if (entry.closed) return;
      if (++entry.retries <= 3) setTimeout(() => this.connect(agentId), 1000 * entry.retries);
      else this.onGone?.(agentId);
    };
  }

  remove(agentId) {
    const entry = this.terms.get(agentId);
    if (!entry) return;
    entry.closed = true;
    entry.ws?.close();
    entry.term.dispose();
    entry.div.remove();
    this.terms.delete(agentId);
  }

  clear() { for (const id of [...this.terms.keys()]) this.remove(id); }

  focus(agentId) { this.terms.get(agentId)?.term.focus(); }

  // Called every frame with the view transform and the node rectangles (graph units, body only).
  layout({ scale, offset }, rects) {
    const show = scale >= MIN_SCALE;
    for (const [id, entry] of this.terms) {
      const r = rects.get(id);
      if (!r || !show) { entry.div.style.display = "none"; continue; }
      const s = entry.div.style;
      s.display = "block";
      s.left = `${(r.x + offset[0]) * scale}px`;
      s.top = `${(r.y + offset[1]) * scale}px`;
      // stop short of the right and bottom edges, so LiteGraph can still take resize drags there
      s.width = `${r.w - EDGE}px`;
      s.height = `${r.h - EDGE}px`;
      s.transform = `scale(${scale})`;
      const key = `${r.w}x${r.h}`;
      if (entry.size !== key) {
        entry.size = key;
        requestAnimationFrame(() => { try { entry.fit.fit(); } catch { /* not laid out yet */ } });
      }
    }
    this.visible = show;
  }

  isShown(agentId) { return this.visible && this.terms.has(agentId); }
}
