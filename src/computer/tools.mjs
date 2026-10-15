// The computer tools every agent gets over taksim's MCP (all CLIs alike): see the Mac's screen, read an app's
// window as a list of controls, and drive the mouse and keyboard, the way Claude's, Copilot's and Codex's computer
// use do. The first use asks the person (access.mjs); macOS then asks for Screen Recording and Accessibility.
// The agent works in the pixels of its last screenshot; the helper works in global points; this file maps them.

import { execFile } from "node:child_process";
import { readOnly } from "../canvas/chat-modes.mjs";
import { helper, helperPath } from "./helper.mjs";
import { requireComputer, noteMissing, noteAct, computerState } from "./access.mjs";

const MAX_WIDTH = 1280; // a screenshot's widest side in pixels: sharp enough to read, light enough to send often
const AT = "x,y are pixels of your last computer_screenshot (or a ref from computer_read).";
const target = { x: { type: "number" }, y: { type: "number" }, ref: { type: "string" } };
const look = { screenshot: { type: "boolean", description: "Return a screenshot after acting (default true)." } };

export const COMPUTER_TOOLS = [
  {
    name: "computer_screenshot",
    description: "See the user's screen (the whole Mac, not only taksim's browser) as an image. Coordinates for the other computer_ tools are pixels of this picture. "
      + "display picks another monitor (see computer_windows); region [x, y, width, height] zooms into part of the last full screenshot at full sharpness (coordinates stay those of the full one); wait_s waits first. "
      + "The first computer_ call asks the user to allow computer control; it waits until they do. For web pages prefer the browser_ tools.",
    inputSchema: { type: "object", properties: { display: { type: "number" }, region: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }, wait_s: { type: "number" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "computer_windows",
    description: "List the open windows (app, title, position in screenshot pixels), the frontmost app, the monitors and the pointer.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "computer_read",
    description: "Read an app's focused window (the frontmost app, or app by name) as its controls: `[w12] Button \"Save\" @x,y w×h` with values, focus and disabled state. Prefer it to screenshots for reading text and finding what to click; click a control by its ref.",
    inputSchema: { type: "object", properties: { app: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "computer_click",
    description: `Click at x,y or on a ref. button left (default), right or middle; count 2 double-clicks, 3 triple-clicks; modifiers held while clicking, e.g. ["cmd"], ["shift"]. press "down" or "up" only presses or releases the button (hold-and-drag by hand). ${AT}`,
    inputSchema: { type: "object", properties: { ...target, button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "number" },
      modifiers: { type: "array", items: { type: "string", enum: ["cmd", "ctrl", "alt", "shift", "fn"] } }, press: { type: "string", enum: ["down", "up"] }, ...look } },
  },
  {
    name: "computer_move",
    description: `Move the pointer to x,y or a ref and leave it there: hover menus, tooltips. ${AT}`,
    inputSchema: { type: "object", properties: { ...target, ...look } },
  },
  {
    name: "computer_drag",
    description: `Press at from (from_x/from_y or from_ref), drag to to (to_x/to_y or to_ref) and release: move files, windows, sliders, selections. ${AT}`,
    inputSchema: { type: "object", properties: { from_x: { type: "number" }, from_y: { type: "number" }, from_ref: { type: "string" },
      to_x: { type: "number" }, to_y: { type: "number" }, to_ref: { type: "string" }, button: { type: "string", enum: ["left", "right", "middle"] }, ...look } },
  },
  {
    name: "computer_type",
    description: "Type text where the keyboard focus is (click the field first), in any language; a newline presses Return.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, ...look }, required: ["text"] },
  },
  {
    name: "computer_key",
    description: "Press a key or shortcut: \"return\", \"escape\", \"tab\", \"backspace\", \"up\", \"pagedown\", \"f5\", \"cmd+c\", \"cmd+shift+4\", \"ctrl+a\". repeat presses it again; hold_s keeps it down that long.",
    inputSchema: { type: "object", properties: { key: { type: "string" }, repeat: { type: "number" }, hold_s: { type: "number" }, ...look }, required: ["key"] },
  },
  {
    name: "computer_scroll",
    description: `Scroll at x,y or a ref (or where the pointer is): dy notches down (negative: up), dx right (negative: left). ${AT}`,
    inputSchema: { type: "object", properties: { ...target, dy: { type: "number" }, dx: { type: "number" }, ...look } },
  },
  {
    name: "computer_open",
    description: "Open or bring forward an app by name (\"Notes\", \"Finder\", \"Xcode\"), or a file or URL with its default app.",
    inputSchema: { type: "object", properties: { app: { type: "string" }, path: { type: "string" } } },
  },
];

const LOOKING = new Set(["computer_screenshot", "computer_windows", "computer_read"]);
export const computerTools = (agent) => (helperPath() ? COMPUTER_TOOLS.filter((t) => !readOnly(agent) || LOOKING.has(t.name)) : []);

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// per agent: how its last screenshot maps to the screen, and where its last computer_read's refs are
const views = new Map(); // agent id -> { origin: [gx, gy], px, width, height, display }
const refs = new Map();  // agent id -> Map(ref -> [gx, gy])

/** the picture an agent sees, without a screenshot yet: the main display at screenshot size */
async function viewOf(agent) {
  if (views.has(agent.id)) return views.get(agent.id);
  const s = await helper("status");
  const d = s.displays.find((x) => x.main) || s.displays[0];
  const px = Math.min(MAX_WIDTH, d.width * d.scale) / d.width;
  const v = { origin: [d.x, d.y], px, width: Math.round(d.width * px), height: Math.round(d.height * px), display: d.index };
  views.set(agent.id, v);
  return v;
}

/** picture pixels -> global points */
export const toScreen = (v, x, y) => ({ x: v.origin[0] + Number(x) / v.px, y: v.origin[1] + Number(y) / v.px });
/** global points -> picture pixels */
export const toPicture = (v, gx, gy) => [Math.round((gx - v.origin[0]) * v.px), Math.round((gy - v.origin[1]) * v.px)];

async function where(agent, { x, y, ref }, what = "") {
  if (ref) {
    const p = refs.get(agent.id)?.get(String(ref));
    if (!p) throw new Error(`no ref ${ref}; take a new computer_read`);
    return { x: p[0], y: p[1] };
  }
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error(`give ${what}x and ${what}y (pixels of your screenshot) or ${what}ref`);
  return toScreen(await viewOf(agent), x, y);
}

const MAC_SETTINGS = {
  screen: "System Settings › Privacy & Security › Screen Recording",
  accessibility: "System Settings › Privacy & Security › Accessibility",
};

/** a helper call; macOS refusals become a note on the agent's node and a clear answer */
const NEEDS = { screenshot: "screen", read: "accessibility", click: "accessibility", move: "accessibility", drag: "accessibility",
  mouse: "accessibility", scroll: "accessibility", type: "accessibility", key: "accessibility" };
async function run(agent, cmd, args, timeoutMs) {
  const missing = () => computerState(agent)?.missing || [];
  try {
    const r = await helper(cmd, args, timeoutMs);
    if (NEEDS[cmd]) noteMissing(agent, missing().filter((m) => m !== NEEDS[cmd]));
    return r;
  } catch (e) {
    const which = e.code === "screen-recording" ? "screen" : e.code === "accessibility" ? "accessibility" : null;
    if (!which) throw e;
    noteMissing(agent, [...new Set([...missing(), which])]);
    const what = which === "screen" ? "to see the screen" : cmd === "read" ? "to read app windows" : "to control the mouse and keyboard";
    throw new Error(`macOS hasn't allowed taksim ${what} yet. `
      + `The user turns it on in ${MAC_SETTINGS[which]} (the display key on your node opens it), then you can try again.`);
  }
}

async function screenshot(agent, args = {}) {
  const v0 = await viewOf(agent);
  const display = args.display !== undefined ? Number(args.display) : v0.display;
  if (Number(args.wait_s) > 0) await sleep(Math.min(10, Number(args.wait_s)) * 1000);
  if (Array.isArray(args.region)) {
    const [x, y, w, h] = args.region.map(Number);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) throw new Error("region is [x, y, width, height] in pixels of your last screenshot");
    const a = toScreen(v0, x, y);
    const r = await run(agent, "screenshot", { display: v0.display, maxWidth: MAX_WIDTH, region: [a.x, a.y, w / v0.px, h / v0.px] });
    return { content: [{ type: "image", data: r.data, mimeType: "image/jpeg" },
      { type: "text", text: `Zoomed into [${x}, ${y}, ${w}, ${h}] of your screenshot (${r.width}×${r.height} picture). Coordinates still refer to the full screenshot.` }] };
  }
  const r = await run(agent, "screenshot", { display, maxWidth: MAX_WIDTH });
  const v = { origin: r.origin, px: r.pxPerPoint, width: r.width, height: r.height, display };
  views.set(agent.id, v);
  const [cx, cy] = r.cursor ? toPicture(v, ...r.cursor) : [];
  return { content: [{ type: "image", data: r.data, mimeType: "image/jpeg" },
    { type: "text", text: `Display ${display}: ${r.width}×${r.height} pixels; use these coordinates.${cx !== undefined ? ` Pointer at ${cx},${cy}.` : ""}` }] };
}

/** after acting: a moment for the screen to change, then a screenshot unless the agent said no */
async function after(agent, args, note) {
  noteAct(agent);
  if (args.screenshot === false) return text(note);
  await sleep(350);
  const shot = await screenshot(agent);
  shot.content.push({ type: "text", text: note });
  return shot;
}

function readText(agent, r) {
  const v = views.get(agent.id);
  const map = new Map();
  const lines = r.nodes.map((n, i) => {
    const ref = `w${i + 1}`;
    let at = "";
    if (n.frame?.length === 4) {
      const [gx, gy, gw, gh] = n.frame;
      map.set(ref, [gx + gw / 2, gy + gh / 2]);
      if (v) { const [px, py] = toPicture(v, gx, gy); at = ` @${px},${py} ${Math.round(gw * v.px)}×${Math.round(gh * v.px)}`; }
    }
    const flags = `${n.value !== undefined ? ` = "${n.value}"` : ""}${n.focused ? " focused" : ""}${n.disabled ? " disabled" : ""}`;
    return `${"  ".repeat(Math.min(n.depth, 12))}[${ref}] ${n.role}${n.name ? ` "${n.name}"` : ""}${at}${flags}`;
  });
  refs.set(agent.id, map);
  return `App: ${r.app}${r.window ? ` — window "${r.window}"` : ""}\n${lines.join("\n") || "(no readable controls)"}${r.truncated ? "\n…(more; read a narrower app window)" : ""}`
    + (v ? "" : "\n(Take a computer_screenshot to get pixel positions; refs work without one.)");
}

function open(args) {
  const argv = args.app ? ["-a", String(args.app), ...(args.path ? [String(args.path)] : [])] : args.path ? [String(args.path)] : null;
  if (!argv) throw new Error("give app or path");
  return new Promise((ok, no) => execFile("/usr/bin/open", argv, { timeout: 15000 }, (e, _o, err) => e ? no(new Error(String(err || e.message).trim())) : ok()));
}

export async function callComputerTool(self, name, args = {}) {
  if (!name.startsWith("computer_") || !COMPUTER_TOOLS.some((t) => t.name === name)) return null;
  if (!helperPath()) return fail("Computer control needs taksim's macOS app (its taksim-computer helper isn't here).");
  if (readOnly(self) && !LOOKING.has(name)) return fail("This action needs Agent mode; Ask and Plan only look at the screen.");
  await requireComputer(self);
  switch (name) {
    case "computer_screenshot": return screenshot(self, args);
    case "computer_windows": {
      const r = await run(self, "windows");
      const v = await viewOf(self);
      const pos = (w) => { const [x, y] = toPicture(v, w.x, w.y); return `@${x},${y} ${Math.round(w.width * v.px)}×${Math.round(w.height * v.px)}`; };
      const [cx, cy] = toPicture(v, ...r.cursor);
      return text([`Frontmost: ${r.frontmost}`, `Pointer: ${cx},${cy}`,
        `Displays: ${r.displays.map((d) => `${d.index}${d.main ? " (main)" : ""} ${d.width}×${d.height} pt`).join(", ")}; positions are pixels of display ${v.display}'s screenshot`,
        "Windows (front to back):", ...r.windows.map((w) => `- ${w.app}${w.title ? ` "${w.title}"` : ""} ${pos(w)}`)].join("\n"));
    }
    case "computer_read": return text(readText(self, await run(self, "read", { app: args.app ? String(args.app) : undefined })));
    case "computer_click": {
      const p = await where(self, args);
      const button = args.button || "left";
      if (args.press) {
        await run(self, "mouse", { ...p, button, up: args.press === "up" });
        return after(self, args, `${button} button ${args.press}.`);
      }
      const count = Math.max(1, Math.min(3, Number(args.count) || 1));
      await run(self, "click", { ...p, button, count, modifiers: Array.isArray(args.modifiers) ? args.modifiers : [] });
      return after(self, args, `${count > 1 ? ["", "", "Double-", "Triple-"][count] : ""}${button === "left" ? "clicked" : `${button}-clicked`}.`);
    }
    case "computer_move": {
      await run(self, "move", await where(self, args));
      return after(self, args, "Pointer moved.");
    }
    case "computer_drag": {
      const from = await where(self, { x: args.from_x, y: args.from_y, ref: args.from_ref }, "from_");
      const to = await where(self, { x: args.to_x, y: args.to_y, ref: args.to_ref }, "to_");
      await run(self, "drag", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, button: args.button || "left" });
      return after(self, args, "Dragged.");
    }
    case "computer_type": {
      const t = String(args.text ?? "");
      await run(self, "type", { text: t }, 20000 + t.length * 20);
      return after(self, args, `Typed ${t.length} characters.`);
    }
    case "computer_key": {
      const hold = Math.max(0, Math.min(10, Number(args.hold_s) || 0)), times = Math.max(1, Math.min(100, Number(args.repeat) || 1));
      await run(self, "key", { key: String(args.key || ""), repeat: times, hold }, 20000 + hold * times * 1000);
      return after(self, args, `Pressed ${args.key}${times > 1 ? ` ×${times}` : ""}.`);
    }
    case "computer_scroll": {
      const p = args.ref || args.x !== undefined ? await where(self, args) : {};
      await run(self, "scroll", { ...p, dy: Math.round(Number(args.dy) || 0), dx: Math.round(Number(args.dx) || 0) });
      return after(self, args, "Scrolled.");
    }
    case "computer_open": {
      await open(args);
      noteAct(self);
      await sleep(900);
      return screenshot(self);
    }
  }
  return null;
}

/** forget an agent's picture and refs (tests; an agent removed) */
export function forgetComputerView(id) { views.delete(id); refs.delete(id); }
