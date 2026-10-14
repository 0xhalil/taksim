// MCP tools for the calling agent's IDE: a PyCharm-like editor docked next to its node, on its working directory.

import { readFileSync } from "node:fs";
import { Ide } from "./ide.mjs";
import { inside } from "./fs.mjs";

// The IDE shows files and notes; it changes nothing on disk, so plan mode (read-only agents) may use it.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false };

export const IDE_TOOLS = [
  {
    name: "ide_open",
    description: "Opens your IDE (a PyCharm-like editor docked next to you, on your working directory) and shows files to the user. "
      + "Use it on your own whenever code is what the user should look at: when you explain or review code, point at a bug, or after you edit files "
      + "(open what you changed, at the change). path + line (and end_line) scrolls there and highlights the lines; files opens more tabs.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "file to show, relative to your working directory (an absolute path inside it works too)" },
      line: { type: "number", description: "1-based line to scroll to and highlight" },
      end_line: { type: "number", description: "last highlighted line (default: line)" },
      files: { type: "array", items: { type: "string" }, description: "more files to open as tabs" } } },
    annotations: READ_ONLY,
  },
  {
    name: "ide_note",
    description: "Marks lines in your IDE with a note the user sees in the gutter and in the Problems window, like an inspection: "
      + "a bug you found, a review comment, what a block does. severity: info, warning or error. Pass code (the text of the first marked line, "
      + "e.g. \"self.discount += 0.05\") so the note lands on the right line even if your line number is off. clear: true removes your notes (for path, or all).",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "file, relative to your working directory" },
      line: { type: "number", description: "1-based first line" }, end_line: { type: "number", description: "last line (default: line)" },
      text: { type: "string", description: "the note, short and specific" },
      code: { type: "string", description: "text of the first marked line, to place the note exactly" },
      severity: { type: "string", enum: ["info", "warning", "error"] },
      clear: { type: "boolean", description: "remove your notes instead (in path, or everywhere without one)" } } },
    annotations: READ_ONLY,
  },
  {
    name: "ide_debug_state",
    description: "What the user's debugger in your IDE shows: whether a program is paused, where (file, line, the code around it), "
      + "why (breakpoint, step or an uncaught exception), the call stack and the variables of the current frame. "
      + "Use it when the user asks about a program they are debugging (\"why is this value wrong here?\").",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "ide_close",
    description: "Closes your IDE.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
];

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

// Returns undefined for tools that aren't IDE tools.
export async function callIdeTool(self, name, args = {}) {
  if (name === "ide_open") {
    const ide = self.ide || new Ide(self);
    const view = ide.open({ files: Array.isArray(args.files) ? args.files : [], path: args.path, line: args.line, endLine: args.end_line });
    self.ide = ide; // only once the files checked out
    return text({ open_tabs: view.tabs, showing: view.active, root: view.root });
  }
  if (name === "ide_note") {
    const ide = self.ide || new Ide(self);
    if (args.clear) {
      const n = ide.clearNotes({ path: args.path });
      self.ide = ide;
      return text(`Removed ${n} note(s).`);
    }
    const note = ide.note(args);
    self.ide = ide;
    if (!ide.tabs.includes(note.path)) ide.open({ path: note.path, line: note.line, endLine: note.endLine });
    return text(`Noted ${note.path}:${note.line}${note.endLine > note.line ? `-${note.endLine}` : ""} (${note.severity}).`
      + (note.moved ? ` Moved ${note.moved > 0 ? "+" : ""}${note.moved} lines to where that code is; use ${note.line} when you refer to it.` : ""));
  }
  if (name === "ide_debug_state") {
    const s = self.ide?.sessions.current();
    if (!s) return text("No debug session. The user starts one with the 🐞 button in your IDE (Python files).");
    const st = s.debug.state;
    const out = { file: s.path, status: st.status, ...(st.exitCode !== undefined ? { exit_code: st.exitCode } : {}) };
    if (st.status === "paused") {
      const top = st.frames[st.frame || 0];
      Object.assign(out, { reason: st.reason, exception: st.exception || undefined,
        stack: st.frames.map((f) => `${f.path}:${f.line} in ${f.name}`),
        frame: `${top.path}:${top.line} in ${top.name}`,
        variables: Object.fromEntries(st.variables.map((v) => [v.name, `${v.value}  (${v.type}${v.size != null ? `, len ${v.size}` : ""})`])) });
      try {
        const lines = readFileSync(inside(self.ide.root, top.path), "utf8").split("\n");
        const from = Math.max(1, top.line - 6), to = Math.min(lines.length, top.line + 4);
        out.code = lines.slice(from - 1, to).map((l, i) => `${from + i === top.line ? "→" : " "} ${String(from + i).padStart(4)}  ${l}`).join("\n");
      } catch { /* the file moved */ }
    }
    return text(out);
  }
  if (name === "ide_close") {
    self.removeIde();
    return text("IDE closed.");
  }
  return undefined;
}
