import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "taksim-browser-"));
process.env.TAKSIM_HOME = home;
const { callBrowserTool, BROWSER_TOOLS } = await import("../src/browser/tools.mjs");
const { browserPath, stopBrowser } = await import("../src/browser/browser.mjs");
// Chrome's helpers still write to the profile for a moment after it exits: up to 5 s to let go
after(async () => { await stopBrowser(); rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); });

const FORM = `<!doctype html><title>Form</title><label>Name <input id=n></label><button onclick="document.title='Hi '+n.value">Greet</button>`;

// one page with every kind of interaction; the iframe on the other host name is cross-site (its own process)
const PAGE = (other) => `<!doctype html><title>All</title>
<style>#menu{display:none} #hov:hover #menu{display:block} .box{width:120px;height:60px;border:1px solid}</style>
<div id=hov><span>Hover me</span><div id=menu><button onclick="document.title='menu'">Secret item</button></div></div>
<button id=ctx oncontextmenu="document.title='right';return false">Right click me</button>
<div id=card draggable=true ondragstart="event.dataTransfer.setData('text','card')">Card</div>
<div id=drop class=box ondragover="event.preventDefault()" ondrop="event.preventDefault();document.title='dropped '+event.dataTransfer.getData('text')">Drop zone</div>
<div id=knob style="width:40px;height:20px;background:#888" onmousedown="window.d=1" onmouseup="if(window.d)document.title='slid '+Math.round(event.clientX)">Knob</div>
<label>Fruit <select id=fruit onchange="document.title='fruit '+this.value"><option value=a>Apple</option><option value=b>Banana</option></select></label>
<label>File <input type=file id=f onchange="document.title='file '+this.files[0].name"></label>
<a href="/form" target=_blank>Open form</a>
<button onclick="document.title=confirm('Sure?')?'yes':'no'">Ask</button>
<button onclick="document.title='hello '+prompt('Name?')">Prompt</button>
<iframe src="/inner" width=300 height=80></iframe>
<iframe src="${other}/inner2" width=300 height=80></iframe>`;
const INNER = `<!doctype html><button onclick="parent.document.title='inner clicked'">Inner button</button>`;
const INNER2 = `<!doctype html><title>x</title><button onclick="document.body.dataset.hit=1;this.textContent='Cross hit'">Cross button</button>`;

test("an agent reads a page as refs, types, clicks and sees it", { skip: !browserPath() && "no Chrome installed" }, async () => {
  const server = createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(FORM); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const me = { id: "agent-1" };
    const url = `http://127.0.0.1:${server.address().port}/`;
    const page = (await callBrowserTool(me, "browser_navigate", { url })).content[0].text;
    assert.match(page, /Title: Form/);
    const field = page.match(/\[(e\d+)\] text "Name"/)[1], button = page.match(/\[(e\d+)\] button "Greet"/)[1];
    await callBrowserTool(me, "browser_type", { ref: field, text: "Ada" });
    const after = (await callBrowserTool(me, "browser_click", { ref: button })).content[0].text;
    assert.match(after, /Title: Hi Ada/);
    const shot = (await callBrowserTool(me, "browser_screenshot")).content[0];
    assert.equal(shot.type, "image");
    assert.ok(shot.data.length > 1000);
    // another agent gets a tab of its own
    const other = (await callBrowserTool({ id: "agent-2" }, "browser_snapshot")).content[0].text;
    assert.match(other, /URL: about:blank/);
  } finally { server.close(); }
});

test("hover, right click, drag, select, upload, iframes, new tabs and dialogs", { skip: !browserPath() && "no Chrome installed" }, async () => {
  let port;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/inner" ? INNER : req.url === "/inner2" ? INNER2 : req.url === "/form" ? FORM : PAGE(`http://localhost:${port}`));
  });
  await new Promise((r) => server.listen(0, r)); // every address: the cross-site iframe comes from localhost
  port = server.address().port;
  const work = mkdtempSync(join(tmpdir(), "taksim-upload-"));
  writeFileSync(join(work, "notes.txt"), "hi");
  const me = { id: "agent-3", workDir: () => work };
  const call = async (name, args) => (await callBrowserTool(me, name, args)).content[0].text;
  const ref = (page, re) => { const m = page.match(re); assert.ok(m, `no ${re} in\n${page}`); return m[1]; };
  try {
    let page = await call("browser_navigate", { url: `http://127.0.0.1:${port}/` });

    const at = async (id) => JSON.parse((await callBrowserTool(me, "browser_eval", { expression: `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()` })).content[0].text);

    // hover opens a menu whose item then shows up as a control
    assert.doesNotMatch(page, /Secret item/);
    page = await call("browser_hover", await at("hov"));
    page = await call("browser_click", { ref: ref(page, /\[(e\d+)\] button "Secret item"/) });
    assert.match(page, /Title: menu/);

    page = await call("browser_click", { ref: ref(page, /\[(e\d+)\] button "Right click me"/), button: "right" });
    assert.match(page, /Title: right/);

    const z = await at("drop");
    page = await call("browser_drag", { from_ref: ref(page, /\[(e\d+)\] div "Card" draggable/), to_x: z.x, to_y: z.y });
    assert.match(page, /Title: dropped card/);

    page = await call("browser_select", { ref: ref(page, /\[(e\d+)\] select "Fruit"/), value: "Banana" });
    assert.match(page, /Title: fruit b/);

    page = await call("browser_upload", { ref: ref(page, /\[(e\d+)\] file "File"/), paths: ["notes.txt"] });
    assert.match(page, /Title: file notes\.txt/);
    const refused = await callBrowserTool(me, "browser_upload", { ref: ref(page, /\[(e\d+)\] file "File"/), paths: [join(process.env.HOME || "/", ".ssh", "id_rsa")] }).catch((e) => e);
    assert.ok(refused instanceof Error || refused.isError, "a file outside the folder is refused");

    // a same-site iframe and a cross-site one (its own process)
    assert.match(page, /\[f\d+e\d+\] button "Inner button"/);
    page = await call("browser_click", { ref: ref(page, /\[(f\d+e\d+)\] button "Inner button"/) });
    assert.match(page, /Title: inner clicked/);
    page = await call("browser_click", { ref: ref(page, /\[(f\d+e\d+)\] button "Cross button"/) });
    assert.match(page, /button "Cross hit"/);

    // a confirm dialog stops the click from finishing; it's reported and answered
    page = await call("browser_click", { ref: ref(page, /\[(e\d+)\] button "Ask"/) });
    assert.match(page, /confirm dialog: "Sure\?"/);
    assert.match(await call("browser_snapshot"), /browser_dialog/);
    page = await call("browser_dialog", { accept: true });
    assert.match(page, /Title: yes/);
    page = await call("browser_click", { ref: ref(page, /\[(e\d+)\] button "Prompt"/) });
    assert.match(page, /prompt: "Name\?"/);
    page = await call("browser_dialog", { accept: true, text: "Ada" });
    assert.match(page, /Title: hello Ada/);

    // a link that opens a new tab becomes the active tab
    page = await call("browser_click", { ref: ref(page, /\[(e\d+)\] link "Open form"/) });
    await new Promise((r) => setTimeout(r, 500));
    page = await call("browser_snapshot");
    assert.match(page, /Title: Form/);
    assert.match(page, /2 tabs/);
    const tabs = await call("browser_tabs", { action: "list" });
    assert.match(tabs, /\* \[1\] Form/);
    page = await call("browser_tabs", { action: "switch", index: 0 });
    assert.match(await call("browser_snapshot"), /Title: hello Ada/);
  } finally { server.close(); rmSync(work, { recursive: true, force: true }); }
});

test("browser tools are only answered for their own names", async () => {
  assert.equal(await callBrowserTool({ id: "x" }, "update_todos", {}), null);
  assert.ok(BROWSER_TOOLS.every((t) => t.name.startsWith("browser_") && t.inputSchema));
});
