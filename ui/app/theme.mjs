// The app's colours, as native/Sources/Taksim/Theme.swift has them: each token is its IntelliJ Dark and
// IntelliJ Light value; Darcula and High Contrast remap the dark ones. The CSS reads them as --<token>,
// the canvas through `pal`. The theme follows the system until one is picked (Settings › Appearance).
import { tr } from './tr.mjs';

const tokens = {
  bg: [0x1E1F22, 0xFFFFFF], panel: [0x2B2D30, 0xF7F8FA], panel2: [0x393B40, 0xEBECF0], line: [0x43454A, 0xDFE1E5],
  ink: [0xDFE1E5, 0x1E1F22], text: [0xBCBEC4, 0x2B2D30], muted: [0x868A91, 0x6C707E], muted2: [0x6F737A, 0xA8ADBD],
  muted1: [0x9DA0A8, 0x5A5D6B], line2: [0x4E5157, 0xC9CCD6], accent: [0x3574F0, 0x3574F0], accentInk: [0xFFFFFE, 0xFFFFFF],
  sel: [0x2E436E, 0xD4E2FF], ok: [0x5FB865, 0x208A3C], err: [0xF75464, 0xDB3B4B], warn: [0xF2C55C, 0xB27A00],
  wait: [0x2AACB8, 0x0B8A96], grid: [0x35373B, 0xDFE1E5], nodeHead: [0x323438, 0xF2F3F5], nodeBody: [0x2B2D30, 0xFFFFFF],
  tabEdge: [0x1E1F22, 0xEBECF0], caret: [0xCED0D6, 0x1E1F22],
};

/** PyCharm's Darcula and High Contrast, keyed by the IntelliJ Dark value they replace */
const darcula = {
  0x1E1F22: 0x2B2B2B, 0x2B2D30: 0x3C3F41, 0x393B40: 0x4C5052, 0x43454A: 0x555555, 0x4E5157: 0x5E6060,
  0xDFE1E5: 0xBBBBBB, 0xBCBEC4: 0xA9B7C6, 0x9DA0A8: 0x999999, 0x868A91: 0x808080, 0x6F737A: 0x606366,
  0x3574F0: 0x4A88C7, 0x2E436E: 0x2F65CA, 0x5FB865: 0x499C54, 0xF75464: 0xC75450, 0xF2C55C: 0xBBB529,
  0x2AACB8: 0x299999, 0x35373B: 0x3A3A3A, 0x323438: 0x45494A, 0xCED0D6: 0xBBBBBB,
};
const contrast = {
  0x1E1F22: 0x000000, 0x2B2D30: 0x0A0A0A, 0x393B40: 0x1F1F1F, 0x43454A: 0x6E6E6E, 0x4E5157: 0x8C8C8C,
  0xDFE1E5: 0xFFFFFF, 0xBCBEC4: 0xFFFFFF, 0x9DA0A8: 0xDADADA, 0x868A91: 0xC8C8C8, 0x6F737A: 0x9A9A9A,
  0x3574F0: 0x1AEBFF, 0x2E436E: 0x0F4C75, 0x5FB865: 0x3DD68C, 0xF75464: 0xFF6B6B, 0xF2C55C: 0xFFD000,
  0x2AACB8: 0x00E5FF, 0x35373B: 0x2A2A2A, 0x323438: 0x141414, 0xCED0D6: 0xFFFFFF, 0xFFFFFE: 0x000000,
};

export const themes = [['system', 'System'], ['light', 'IntelliJ Light'], ['dark', 'IntelliJ Dark'], ['darcula', 'Darcula'], ['contrast', 'High Contrast']];

/** canvas icon colours, picked by an FNV-1a hash of the name */
const iconColors = [0x3574F0, 0x4A9C5D, 0xD9773F, 0x9B6EE0, 0x1F9AA6, 0xC09534, 0xB85EA8, 0xD9534F, 0x5B7FD6, 0x7A8A34];
export const groupColors = ['#548af7', '#5fb865', '#d6ae58', '#b189f5', '#2aacb8', '#e08855', '#c77dbb'];

export const hex = (n) => '#' + n.toString(16).padStart(6, '0');
export function rgba(color, alpha) {
  const n = parseInt(color.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function stored(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function store(key, value) { try { localStorage.setItem(key, value); } catch {} }

const media = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();
export let choice = stored('taksim.theme', 'system');
export let isDark = true;
/** the palette for drawing, as #rrggbb strings */
export const pal = {};

export function iconColor(name) {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0;
  return hex(iconColors[h % iconColors.length]);
}

export function apply() {
  isDark = choice === 'system' ? media.matches : choice !== 'light';
  const map = isDark ? (choice === 'darcula' ? darcula : choice === 'contrast' ? contrast : {}) : {};
  const root = document.documentElement;
  for (const [name, [dark, light]] of Object.entries(tokens)) {
    const value = hex(isDark ? (map[dark] ?? dark) : light);
    pal[name] = value;
    root.style.setProperty('--' + name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), value);
  }
  // white over dark, black over light: hover tints, the shell's backdrop
  pal.tint = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  pal.tintStrong = isDark ? 'rgba(255,255,255,0.133)' : 'rgba(0,0,0,0.094)';
  pal.faint = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  root.style.setProperty('--tint', pal.tint);
  root.dataset.theme = isDark ? 'dark' : 'light';
  root.style.colorScheme = isDark ? 'dark' : 'light';
  for (const fn of listeners) fn();
}

export function setTheme(next) { choice = next; store('taksim.theme', next); apply(); }
export function onTheme(fn) { listeners.add(fn); return () => listeners.delete(fn); }
media.addEventListener('change', () => { if (choice === 'system') apply(); });

// ---------- language (TaksimKit/Language.swift) ----------

export let lang = stored('taksim.language', 'en');
export function setLanguage(next) { lang = next; store('taksim.language', next); for (const fn of listeners) fn(); }

/** a user-facing string written in English: `L('Add agent')`, `L('Delete %@?', name)` */
export function L(en, ...args) {
  let s = (lang === 'tr' ? tr[en] : null) ?? en;
  let i = 0;
  if (args.length) s = s.replace(/%(%|@|d|\.\df|\d\$@)/g, (m, k) => k === '%' ? '%' : String(args[i++] ?? ''));
  return s;
}

apply();
