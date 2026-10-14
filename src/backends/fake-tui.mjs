#!/usr/bin/env node
// Stand-in interactive CLI for terminal tests. Raw mode like the real TUIs: a bracketed paste is one
// message, Enter submits. Each submitted line reports start/stop to the hook url, like Claude's hooks.
//   "CALL {json}" lines run MCP tool calls (see fake-cli.mjs), "SLOW" makes the turn take 1.5s,
//   "/exit" quits; anything else is answered with "tui: <last line>".
//   "DROP" lines are swallowed without any hook, like a prompt the TUI never took.
//   --dialog starts with a question that swallows input until Enter, like a trust prompt; the ready hook
//   fires only after it.

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const hookUrl = arg("--hook"), mcpUrl = arg("--mcp"), session = arg("--session");
const out = (s) => process.stdout.write(s);
const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((r) => r.json()).catch(() => null);

process.stdin.setRawMode?.(true);
process.stdin.setEncoding("utf8");
let dialog = argv.includes("--dialog");
if (dialog) out("Do you trust this folder? Press Enter to continue\r\n");
else { out(`fake-tui ready session=${session} config=${process.env.FAKE_CONFIG_DIR || "-"}\r\n> `); post(`${hookUrl}/ready`, { session_id: session }); }

const ESC = /\x1b(?:\[[0-?]*[ -\/]*[@-~]|O.)/y;
let line = "", inPaste = false, chain = Promise.resolve();
process.stdin.on("data", (data) => {
  if (dialog) { // everything typed or pasted here is lost, like in a real dialog
    if (data.includes("\r")) { dialog = false; out("fake-tui ready\r\n> "); post(`${hookUrl}/ready`, { session_id: session }); }
    return;
  }
  for (let i = 0; i < data.length; i++) {
    if (data.startsWith("\x1b[200~", i)) { inPaste = true; i += 5; continue; }
    if (data.startsWith("\x1b[201~", i)) { inPaste = false; i += 5; continue; }
    const ch = data[i];
    if (ch === "\x03") process.exit(0);
    if (ch === "\x1b") { // skip other escape sequences (focus, arrows, mouse) like a real TUI
      ESC.lastIndex = i;
      const m = ESC.exec(data);
      if (m) i += m[0].length - 1;
      continue;
    }
    if (ch === "\r" && !inPaste) {
      const text = line;
      line = "";
      out("\r\n");
      chain = chain.then(() => handle(text));
      continue;
    }
    if (ch === "\x7f") { line = line.slice(0, -1); out("\b \b"); continue; }
    if (ch === "\x15") { out("\b \b".repeat(line.length)); line = ""; continue; } // Ctrl-U clears the line
    line += ch === "\r" ? "\n" : ch;
    out(ch === "\r" || ch === "\n" ? "\r\n" : ch);
  }
});

async function handle(text) {
  if (!text.trim()) return out("> ");
  if (text.trim() === "/exit") process.exit(0);
  if (text.includes("DROP")) return out("> ");
  await post(`${hookUrl}/start`, { session_id: session, prompt: text });
  if (text.includes("SLOW")) await new Promise((r) => setTimeout(r, 1500));
  const calls = text.split("\n").filter((l) => l.startsWith("CALL ")).map((l) => JSON.parse(l.slice(5)));
  const results = [];
  for (const [i, c] of calls.entries()) {
    const r = await post(mcpUrl, { jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: c.tool, arguments: c.args || {} } });
    results.push(`${c.tool}: ${r?.result ? r.result.content.map((x) => x.text).join("") : "RPC error"}`);
  }
  const reply = results.length ? results.join("\n") : `tui: ${text.split("\n").pop()}`;
  out(reply.replace(/\n/g, "\r\n") + "\r\n> ");
  await post(`${hookUrl}/stop`, { session_id: session, last_assistant_message: reply });
}
