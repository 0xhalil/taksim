// The browser tools every agent gets over taksim's MCP (all CLIs alike): open a page, read it as a list of
// what can be clicked or typed into (refs), act on those refs — click, hover, drag, type, pick, upload — and look at
// it as a picture. Iframes (cross-site ones too), pages a link opens in a new tab and alert/confirm/prompt dialogs
// are handled.

import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { tabOf, browserPath, listTabs, switchTab, newTab, closeTabAt } from "./browser.mjs";
import { resolvePath, isSecretPath } from "../bricks/catalog.mjs";
import { realPath, isUnder } from "../platform.mjs";

const REF_HINT = "Refs come from browser_snapshot (e12 in the page, f1e3 inside its first iframe) and change when the page does; take a new snapshot after acting.";
const target = { ref: { type: "string" }, x: { type: "number" }, y: { type: "number" } };

export const BROWSER_TOOLS = [
  {
    name: "browser_navigate",
    description: "Open a URL in your own tab of taksim's browser (a visible Chrome window the user watches; logins made there persist). Returns the page as browser_snapshot does. Use it to check a web app you are building (http://localhost:…), read docs, or do something on a site for the user.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description: "Read your tab: its URL and title, every visible link, button, field and control as `[ref] role \"name\"` — inside iframes too — and the page text. Prefer it to screenshots for reading; act on the refs with the other browser_ tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: `Click an element by its ref, or at x,y in CSS pixels of the viewport. button: "right" opens a context menu; double: true double-clicks. ${REF_HINT}`,
    inputSchema: { type: "object", properties: { ...target, button: { type: "string", enum: ["left", "right", "middle"] }, double: { type: "boolean" } } },
  },
  {
    name: "browser_hover",
    description: `Move the pointer over an element (ref or x,y) and leave it there: opens hover menus and tooltips. ${REF_HINT}`,
    inputSchema: { type: "object", properties: target },
  },
  {
    name: "browser_drag",
    description: `Drag from one element (from_ref, or from_x/from_y) and drop on another (to_ref, or to_x/to_y): sortable lists, kanban cards, sliders, HTML drag and drop. ${REF_HINT}`,
    inputSchema: { type: "object", properties: { from_ref: { type: "string" }, from_x: { type: "number" }, from_y: { type: "number" }, to_ref: { type: "string" }, to_x: { type: "number" }, to_y: { type: "number" } } },
  },
  {
    name: "browser_type",
    description: `Type text into a field by its ref (its current text is replaced unless append is true); submit: true presses Enter after. ${REF_HINT}`,
    inputSchema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" }, append: { type: "boolean" } }, required: ["ref", "text"] },
  },
  {
    name: "browser_select",
    description: `Pick option(s) of a <select> by its ref, by value or visible label (values for a multiple select). ${REF_HINT}`,
    inputSchema: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" }, values: { type: "array", items: { type: "string" } } }, required: ["ref"] },
  },
  {
    name: "browser_upload",
    description: `Put files into a file input (its ref): paths in your folder (relative to it) or the temp folder. ${REF_HINT}`,
    inputSchema: { type: "object", properties: { ref: { type: "string" }, paths: { type: "array", items: { type: "string" } } }, required: ["ref", "paths"] },
  },
  {
    name: "browser_press",
    description: "Press a key in your tab: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp/PageDown, or a single character; modifiers like \"Control+a\", \"Meta+c\", \"Shift+Tab\".",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "browser_scroll",
    description: "Scroll your tab by dy CSS pixels (positive: down), or bring a ref into view.",
    inputSchema: { type: "object", properties: { dy: { type: "number" }, ref: { type: "string" } } },
  },
  {
    name: "browser_dialog",
    description: "Answer the alert / confirm / prompt / leave-page dialog your tab is showing: accept true (OK) or false (Cancel), text for a prompt. Other browser actions report when a dialog is open.",
    inputSchema: { type: "object", properties: { accept: { type: "boolean" }, text: { type: "string" } }, required: ["accept"] },
  },
  {
    name: "browser_tabs",
    description: "Your tabs: list them, switch to one, open a new one (url) or close one. A link or script that opens a new tab makes it your active tab by itself.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "switch", "new", "close"] }, index: { type: "number" }, url: { type: "string" } }, required: ["action"] },
  },
  {
    name: "browser_screenshot",
    description: "See your tab as an image (the visible part; full_page for all of it). Use it to check layout and visuals; read text with browser_snapshot.",
    inputSchema: { type: "object", properties: { full_page: { type: "boolean" } } },
  },
  {
    name: "browser_back",
    description: "Go back in your tab's history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_eval",
    description: "Run a JavaScript expression in your tab and get its JSON result (await works). For what the other tools can't do: reading app state, console checks.",
    inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  },
];

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Marks every visible control in one document with data-taksim-ref and describes it, with the document's text.
const SNAPSHOT_JS = `(() => {
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=slider],[draggable=true],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  for (const el of document.querySelectorAll('[data-taksim-ref]')) el.removeAttribute('data-taksim-ref');
  const seen = new Set(), out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (seen.has(el)) continue; seen.add(el);
    const r = el.getBoundingClientRect(), st = getComputedStyle(el);
    const fileInput = el.tagName === 'INPUT' && el.type === 'file';
    if (!fileInput && (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none')) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-taksim-ref', ref);
    const tag = el.tagName.toLowerCase(), type = el.getAttribute('type');
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? (type || 'text') : tag);
    // a label's own words, without the text of the control it wraps (a select's options)
    let label = '';
    if (el.labels && el.labels[0]) { const c = el.labels[0].cloneNode(true); for (const x of c.querySelectorAll('select,textarea,input,button')) x.remove(); label = c.innerText || c.textContent; }
    const name = (el.getAttribute('aria-label') || label || (tag === 'select' ? '' : el.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    let extra = '';
    if (tag === 'select') {
      const opts = [...el.options].slice(0, 30).map((o) => (o.selected ? '*' : '') + o.label.trim().slice(0, 30));
      extra += ' options=[' + opts.join(' | ') + (el.options.length > 30 ? ' …' : '') + ']';
    } else if ('value' in el && el.value && tag !== 'button' && !fileInput) extra += ' value="' + String(el.value).slice(0, 60) + '"';
    if (fileInput && el.files && el.files.length) extra += ' files=' + [...el.files].map((f) => f.name).join(',');
    if (el.checked) extra += ' checked';
    if (el.disabled) extra += ' disabled';
    if (el.getAttribute('draggable') === 'true') extra += ' draggable';
    if (tag === 'a') extra += ' -> ' + el.getAttribute('href').slice(0, 80);
    const off = fileInput && (r.width < 2 || st.display === 'none') ? ' (hidden file input)' : r.bottom < 0 || r.top > innerHeight ? ' (offscreen)' : '';
    out.push({ ref, line: role + ' "' + name + '"' + extra + off });
    if (out.length >= 300) break;
  }
  const body = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000);
  return { url: location.href, title: document.title, controls: out, text: body };
})()`;

/** the page and its iframes: where to evaluate in each, by ref prefix ("" for the page, "f1"…) */
async function framesOf(tab) {
  const frames = [{ prefix: "" }];
  const { frameTree } = await tab.send("Page.getFrameTree");
  const walk = async (node) => {
    for (const child of node.childFrames || []) {
      const prefix = "f" + frames.length;
      const sessionId = tab.page.frames.get(child.frame.id);
      if (sessionId) frames.push({ prefix, frameId: child.frame.id, sessionId });
      else {
        const world = await tab.send("Page.createIsolatedWorld", { frameId: child.frame.id, worldName: "taksim" }).catch(() => null);
        if (world) frames.push({ prefix, frameId: child.frame.id, contextId: world.executionContextId });
      }
      if (frames.length >= 8) return;
      await walk(child);
    }
  };
  await walk(frameTree);
  // cross-site iframes run in processes of their own and aren't in the page's frame tree
  for (const [frameId, sessionId] of tab.page.frames) {
    if (frames.length >= 8) break;
    if (!frames.some((f) => f.frameId === frameId)) frames.push({ prefix: "f" + frames.length, frameId, sessionId });
  }
  tab.page.refFrames = new Map(frames.map((f) => [f.prefix, f]));
  return frames;
}

async function evalIn(tab, frame, expression, byValue = true) {
  const params = { expression, returnByValue: byValue, awaitPromise: true, ...(frame?.contextId ? { contextId: frame.contextId } : {}) };
  const r = frame?.sessionId ? await tab.sendTo(frame.sessionId, "Runtime.evaluate", params) : await tab.send("Runtime.evaluate", params);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return byValue ? r.result.value : r.result;
}

async function snapshotText(tab) {
  const parts = [];
  for (const f of await framesOf(tab)) {
    const s = await evalIn(tab, f, SNAPSHOT_JS).catch(() => null);
    if (!s) continue;
    const lines = s.controls.map((c) => `[${f.prefix}${c.ref}] ${c.line}`).join("\n");
    if (!f.prefix) parts.push(`URL: ${s.url}\nTitle: ${s.title}\n\nControls:\n${lines}\n\nText:\n${s.text}`);
    else if (s.controls.length || s.text.trim()) parts.push(`--- iframe ${f.prefix}: ${s.url}\nControls:\n${lines}\n\nText:\n${s.text.slice(0, 2000)}`);
  }
  const tabs = await listTabs(tab.agentId);
  const others = tabs.length > 1 ? `\n\n(${tabs.length} tabs; browser_tabs to switch)` : "";
  return parts.join("\n\n") + others;
}

/** a ref → its frame and the element's local ref */
function locate(tab, ref) {
  const m = /^(f\d+)?(e\d+)$/.exec(String(ref || ""));
  if (!m) throw new Error(`"${ref}" is not a ref; take a browser_snapshot`);
  const frame = tab.page.refFrames?.get(m[1] || "") || (m[1] ? null : { prefix: "" });
  if (!frame) throw new Error(`no iframe ${m[1]}; take a new browser_snapshot`);
  return { frame, local: m[2] };
}

const byRef = (local) => `document.querySelector('[data-taksim-ref="${local}"]')`;

/** where an iframe's content starts in the page's viewport (its owner element scrolled into view) */
async function frameOffset(tab, frame) {
  if (!frame.frameId) return { x: 0, y: 0 };
  const { backendNodeId } = await tab.send("DOM.getFrameOwner", { frameId: frame.frameId });
  await tab.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
  const { model } = await tab.send("DOM.getBoxModel", { backendNodeId });
  return { x: model.content[0], y: model.content[1] };
}

/** the centre of a ref (or x,y) in viewport coordinates, scrolled into view */
async function point(tab, { ref, x, y }) {
  if (!ref) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error("give a ref or x and y");
    return { x: Number(x), y: Number(y) };
  }
  const { frame, local } = locate(tab, ref);
  const off = await frameOffset(tab, frame);
  const box = await evalIn(tab, frame, `(() => { const el = ${byRef(local)};
    if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error(`no element with ref ${ref}; take a new browser_snapshot`);
  return { x: off.x + box.x, y: off.y + box.y };
}

const mouse = (tab, type, p, extra = {}) => tab.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, ...extra });

/** moves the pointer onto a ref (or x,y); leaving a hover menu can shift the page, so a ref is measured again
 *  once the pointer is there, until it stays put */
async function reach(tab, args) {
  let p = await point(tab, args);
  for (let i = 0; i < 3; i++) {
    await mouse(tab, "mouseMoved", p);
    if (!args.ref) break;
    await sleep(60);
    const q = await point(tab, args);
    if (Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) < 1) break;
    p = q;
  }
  return p;
}

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};
const MODS = { Alt: 1, Control: 2, Meta: 4, Command: 4, Shift: 8 };

async function press(tab, combo) {
  const parts = String(combo).split("+");
  const name = parts.pop();
  const modifiers = parts.reduce((m, p) => m | (MODS[p] || 0), 0);
  let k = KEYS[name];
  if (!k && name.length === 1) {
    const upper = name.toUpperCase();
    k = { key: name, code: /[a-z]/i.test(name) ? `Key${upper}` : undefined, windowsVirtualKeyCode: upper.charCodeAt(0), text: modifiers & ~8 ? undefined : name };
  }
  if (!k) throw new Error(`unknown key ${name}`);
  await tab.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", modifiers, ...k });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...k, text: undefined });
}

/** waits for the page to settle after an action: its load event if one comes, then a short pause */
async function settle(tab, ms = 8000) {
  let off;
  const loaded = new Promise((ok) => { off = tab.on((m) => { if (m.method === "Page.loadEventFired") ok(); }); });
  await Promise.race([loaded, sleep(600)]);
  const state = await evalIn(tab, null, "document.readyState").catch(() => "complete");
  if (state !== "complete") await Promise.race([loaded, sleep(ms)]);
  off();
  await sleep(250);
}

const DIALOG_NAMES = { alert: "an alert", confirm: "a confirm dialog", prompt: "a prompt", beforeunload: "a leave-page dialog" };
const describeDialog = (d) => `The page is showing ${DIALOG_NAMES[d.type] || "a dialog"}: "${d.message}"${d.type === "prompt" && d.defaultPrompt ? ` (default "${d.defaultPrompt}")` : ""}. Answer it with browser_dialog before anything else.`;

/** runs an action; a dialog it opens ends the wait (the action would never return) and is reported instead */
async function guarded(tab, action) {
  if (tab.page.dialog) return text(describeDialog(tab.page.dialog));
  let resolveDialog;
  const opened = new Promise((r) => { resolveDialog = r; tab.page.dialogWaiters.add(r); });
  try {
    const r = await Promise.race([action().then((v) => ({ v })), opened.then((d) => ({ d }))]);
    if (r.d) return text(describeDialog(r.d));
    return r.v;
  } finally { tab.page.dialogWaiters.delete(resolveDialog); }
}

/** files an agent may hand to a page: in its folder or the temp folder, existing, never where keys live */
function uploadable(self, paths) {
  const work = self.workDir?.() || process.cwd();
  const roots = [work, tmpdir(), "/tmp"].map((d) => { try { return realPath(d); } catch { return d; } });
  return paths.map((p) => {
    const abs = resolvePath(String(p), work);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`no such file: ${p}`);
    const real = realPath(abs);
    if (isSecretPath(real)) throw new Error(`${p} holds credentials; it can't be uploaded`);
    if (!roots.some((r) => isUnder(real, r))) throw new Error(`${p} is outside your folder; only files in it (or the temp folder) can be uploaded`);
    return real;
  });
}

export async function callBrowserTool(self, name, args = {}) {
  if (!name.startsWith("browser_") || !BROWSER_TOOLS.some((t) => t.name === name)) return null;
  if (!browserPath()) return fail("No browser is installed for taksim to drive (Google Chrome, Chromium, Edge or Brave).");
  if (name === "browser_tabs") {
    const action = args.action || "list";
    if (action === "switch") await switchTab(self.id, Number(args.index));
    else if (action === "new") await newTab(self.id, args.url ? String(args.url) : undefined);
    else if (action === "close") await closeTabAt(self.id, Number(args.index));
    if (action !== "list") await sleep(300);
    const tabs = await listTabs(self.id);
    return text(tabs.map((t) => `${t.active ? "*" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url}`).join("\n") || "no tabs yet");
  }
  const tab = await tabOf(self.id);
  tab.agentId = self.id;
  const snapshot = async () => text(await snapshotText(tab));
  if (name === "browser_dialog") {
    if (!tab.page.dialog) return fail("No dialog is open.");
    await tab.send("Page.handleJavaScriptDialog", { accept: !!args.accept, ...(args.text !== undefined ? { promptText: String(args.text) } : {}) });
    await settle(tab, 4000);
    return guarded(tab, snapshot);
  }
  return guarded(tab, async () => {
    switch (name) {
      case "browser_navigate": {
        let url = String(args.url || "").trim();
        if (!/^[a-z][\w+.-]*:/i.test(url)) url = (/^(localhost|127\.|\[::1\])/.test(url) ? "http://" : "https://") + url;
        const r = await tab.send("Page.navigate", { url });
        if (r.errorText) return fail(`could not open ${url}: ${r.errorText}`);
        await settle(tab);
        return snapshot();
      }
      case "browser_snapshot": return snapshot();
      case "browser_click": {
        const button = args.button || "left", clickCount = args.double ? 2 : 1;
        const buttons = { left: 1, right: 2, middle: 4 }[button] || 1;
        const p = await reach(tab, args);
        await mouse(tab, "mousePressed", p, { button, buttons, clickCount });
        await mouse(tab, "mouseReleased", p, { button, buttons: 0, clickCount });
        await settle(tab, 5000);
        return snapshot();
      }
      case "browser_hover": {
        await reach(tab, args);
        await sleep(400);
        return snapshot();
      }
      case "browser_drag": {
        const from = await point(tab, { ref: args.from_ref, x: args.from_x, y: args.from_y });
        const to = await point(tab, { ref: args.to_ref, x: args.to_x, y: args.to_y });
        // HTML drag and drop needs Chrome's own drag events; libraries that follow the mouse need the moves
        await tab.send("Input.setInterceptDrags", { enabled: true });
        let dragData = null;
        const off = tab.on((m) => { if (m.method === "Input.dragIntercepted") dragData = m.params.data; });
        try {
          await mouse(tab, "mouseMoved", from);
          await mouse(tab, "mousePressed", from, { button: "left", clickCount: 1 });
          const steps = 12;
          for (let i = 1; i <= steps; i++) {
            const p = { x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps };
            await mouse(tab, "mouseMoved", p, { button: "left", buttons: 1 });
            await sleep(16);
            if (dragData) break;
          }
          if (dragData) {
            for (const type of ["dragEnter", "dragOver", "drop"]) await tab.send("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data: dragData });
          }
          await mouse(tab, "mouseReleased", to, { button: "left", clickCount: 1 });
        } finally {
          off();
          await tab.send("Input.setInterceptDrags", { enabled: false }).catch(() => {});
        }
        await settle(tab, 3000);
        return snapshot();
      }
      case "browser_type": {
        const { frame, local } = locate(tab, args.ref);
        await point(tab, args);
        const ok = await evalIn(tab, frame, `(() => { const el = ${byRef(local)}; if (!el) return false; el.focus();
          ${args.append ? "" : "if ('value' in el && el.select) el.select(); else { const s = getSelection(); s.selectAllChildren(el); }"} return true; })()`);
        if (!ok) throw new Error(`no element with ref ${args.ref}; take a new browser_snapshot`);
        if (!args.append) await press(tab, "Backspace");
        await tab.send("Input.insertText", { text: String(args.text ?? "") });
        if (args.submit) { await press(tab, "Enter"); await settle(tab, 5000); }
        return snapshot();
      }
      case "browser_select": {
        const { frame, local } = locate(tab, args.ref);
        const wanted = JSON.stringify((args.values || [args.value]).filter((v) => v !== undefined).map(String));
        const r = await evalIn(tab, frame, `(() => { const el = ${byRef(local)};
          if (!el || el.tagName !== 'SELECT') return 'not a select';
          const want = ${wanted}.map((w) => w.trim().toLowerCase()); let hit = 0;
          for (const o of el.options) { const on = want.includes(o.value.toLowerCase()) || want.includes(o.label.trim().toLowerCase());
            if (el.multiple) o.selected = on; else if (on && !hit) { el.value = o.value; } if (on) hit++; }
          if (!hit) return 'no option matches ' + want.join(', ');
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
        if (r !== "ok") return fail(r);
        await settle(tab, 3000);
        return snapshot();
      }
      case "browser_upload": {
        const files = uploadable(self, Array.isArray(args.paths) ? args.paths : [args.paths]);
        const { frame, local } = locate(tab, args.ref);
        const obj = await evalIn(tab, frame, byRef(local), false);
        if (!obj?.objectId) throw new Error(`no element with ref ${args.ref}; take a new browser_snapshot`);
        const send = frame.sessionId ? (m, p) => tab.sendTo(frame.sessionId, m, p) : (m, p) => tab.send(m, p);
        await send("DOM.setFileInputFiles", { files, objectId: obj.objectId });
        await settle(tab, 3000);
        return snapshot();
      }
      case "browser_press": {
        await press(tab, String(args.key || ""));
        await settle(tab, 3000);
        return snapshot();
      }
      case "browser_scroll": {
        if (args.ref) await point(tab, args);
        else await evalIn(tab, null, `scrollBy(0, ${Number(args.dy) || 600})`);
        await sleep(250);
        return snapshot();
      }
      case "browser_back": {
        await evalIn(tab, null, "history.back()");
        await settle(tab, 5000);
        return snapshot();
      }
      case "browser_screenshot": {
        const shot = await tab.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: !!args.full_page,
          ...(args.full_page ? { clip: await evalIn(tab, null, "({ x: 0, y: 0, width: document.documentElement.scrollWidth, height: Math.min(document.documentElement.scrollHeight, 8000), scale: 1 })") } : {}) });
        return { content: [{ type: "image", data: shot.data, mimeType: "image/jpeg" }] };
      }
      case "browser_eval": {
        const v = await evalIn(tab, null, String(args.expression || "undefined"));
        return text(v === undefined ? "undefined" : JSON.stringify(v, null, 2).slice(0, 20000));
      }
    }
    return null;
  });
}
