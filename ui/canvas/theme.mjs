// Light and dark, as JetBrains ships them: IntelliJ Light and Dark (the New UI). The palettes are CSS
// variables in canvas.html (:root and [data-theme="light"]); what draws on a canvas (the graph, xterm,
// Monaco) reads them from T and redraws when the theme changes.

export const T = {};
const VARS = {
  bg: "--bg", panel: "--panel", panel2: "--panel-2", line: "--line", ink: "--ink", text: "--text",
  muted: "--muted", muted1: "--muted-1", muted2: "--muted-2", accent: "--accent", ok: "--ok", err: "--err",
  warn: "--warn", wait: "--wait", sel: "--sel", grid: "--grid", nodeHead: "--node-head", nodeBody: "--node-body",
  tint: "--tint-3",
};
const listeners = new Set();
const KEY = "taksim.theme";
const stored = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const system = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

export const themeName = () => document.documentElement.dataset.theme || "dark";

function read() {
  const cs = getComputedStyle(document.documentElement);
  for (const [k, v] of Object.entries(VARS)) T[k] = cs.getPropertyValue(v).trim();
  T.name = themeName();
}

export function setTheme(name, { save = true } = {}) {
  document.documentElement.dataset.theme = name;
  if (save) { try { localStorage.setItem(KEY, name); } catch { /* private mode */ } }
  read();
  for (const fn of listeners) fn(T);
}

export function onTheme(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// the saved choice, else the system's; follows the system until the user picks one
setTheme(stored() || system(), { save: false });
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (!stored()) setTheme(system(), { save: false }); });
