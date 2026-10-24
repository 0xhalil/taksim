// The light tools a local model works with (local.mjs): list, read, edit and write files in the agent's folder, and
// run a command there. Short descriptions, so they fit a small window; everything stays inside the folder (fs.mjs
// inside), and Manual / Accept edits ask in the chat first, as the CLIs' hooks do.

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, relative } from "node:path";
import { inside } from "../ide/fs.mjs";
import { decide, askTaksim } from "../term/permission-hook.mjs";

const fn = (name, description, properties, required) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const str = (description) => ({ type: "string", description });

// in the order they are dropped when the window is too small for all of them: the first ones stay longest
export const TOOLS = [
  fn("read_file", "Read a text file in the project. Long files come in parts: pass offset (first line) and limit.",
    { path: str("relative path"), offset: { type: "integer" }, limit: { type: "integer" } }, ["path"]),
  fn("edit_file", "Replace one exact, unique piece of a file with new text.",
    { path: str("relative path"), old: str("the exact text now in the file"), new: str("the text to put there") }, ["path", "old", "new"]),
  fn("list_files", "List the files and folders in a project folder.", { path: str("relative folder, default the project") }, []),
  fn("write_file", "Create a new file with the given text. To change a file that exists, use edit_file.", { path: str("relative path"), content: str("the whole file") }, ["path", "content"]),
  fn("run_command", "Run a shell command in the project folder and get its output (tests, builds, git).", { command: str("the command") }, ["command"]),
];
const KIND = { read_file: "read", list_files: "read", edit_file: "edit", write_file: "edit", run_command: "command" };
export const READ_ONLY = new Set(["read_file", "list_files"]);

/** what the chat's tool line says: a label and the file or command */
export function describe(name, args = {}) {
  return { label: { read_file: "Read", list_files: "List", edit_file: "Edit", write_file: "Write", run_command: "Run" }[name] || name,
    detail: String(args.command || args.path || "") };
}

const SKIP = new Set([".git", "node_modules", ".build", "dist", "build", ".venv", "__pycache__"]);

/** runs one call; returns the text the model reads back. A wrong call answers with what was wrong, so the model can fix it. */
export async function runTool(name, args, { cwd, permission, permissionUrl, signal, maxChars = 8000 }) {
  if (!KIND[name]) return `error: there is no tool "${name}"; the tools are ${Object.keys(KIND).join(", ")}`;
  if (typeof args !== "object" || args === null) return `error: ${name} takes a JSON object`;
  const verdict = decide({ kind: KIND[name] }, permission);
  if (verdict === "ask") {
    const answer = await askTaksim(permissionUrl, { tool: name, input: args });
    if (answer.behavior !== "allow") return `error: the user declined (${answer.message || "no"}); don't retry it`;
  }
  try {
    switch (name) {
      case "list_files": {
        const dir = inside(cwd, args.path || "");
        const names = readdirSync(dir, { withFileTypes: true }).filter((d) => !SKIP.has(d.name))
          .map((d) => d.name + (d.isDirectory() ? "/" : "")).sort().slice(0, 300);
        return names.join("\n") || "(empty)";
      }
      case "read_file": {
        if (!args.path) return "error: read_file needs a path";
        const file = inside(cwd, args.path);
        if (statSync(file).size > 5_000_000) return "error: the file is too large to read";
        const lines = readFileSync(file, "utf8").split("\n");
        // small models write offset 0 for the start and limit -1 (or 0) for "all of it"
        const from = Math.max(1, Number(args.offset) || 1);
        const limit = Number(args.limit) > 0 ? Number(args.limit) : lines.length;
        let out = "", n = from;
        const end = Math.min(lines.length, from - 1 + limit);
        for (; n <= end; n++) {
          const line = `${n}\t${lines[n - 1]}\n`;
          if (out.length + line.length > maxChars) break;
          out += line;
        }
        return n <= end ? `${out}… (stopped at line ${n - 1} of ${lines.length}; read on with offset ${n})` : out || "(empty file)";
      }
      case "edit_file": {
        if (!args.path || typeof args.old !== "string" || typeof args.new !== "string") return "error: edit_file needs path, old and new";
        const file = inside(cwd, args.path);
        const text = readFileSync(file, "utf8");
        const found = locate(text, args.old);
        if (found === "many") return "error: old appears more than once; include more of the surrounding lines";
        if (!found) return "error: old was not found in the file; read it again and copy the exact text";
        writeFileSync(file, text.slice(0, found.at) + (found.indents ? reindent(args.new, found.indents) : args.new) + text.slice(found.at + found.length));
        return `edited ${relative(cwd, file) || args.path}`;
      }
      case "write_file": {
        if (!args.path || typeof args.content !== "string") return "error: write_file needs path and content";
        const file = inside(cwd, args.path);
        // a small model rewriting a whole file loses what it didn't copy: files that exist change with edit_file
        if (existsSync(file)) return `error: ${args.path} already exists; change it with edit_file`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, args.content);
        return `created ${args.path}`;
      }
      case "run_command": {
        if (!args.command) return "error: run_command needs a command";
        return await command(String(args.command), cwd, signal, maxChars);
      }
    }
  } catch (e) {
    return `error: ${e.message}`;
  }
}

/** where `old` is in the text: exactly; else with the line numbers read_file shows taken off; else line by line with
 * the indentation ignored. Only a single place counts; "many" when it is ambiguous. */
export function locate(text, old) {
  if (!old) return null;
  const once = (needle) => {
    const at = text.indexOf(needle);
    if (at < 0) return null;
    return text.indexOf(needle, at + 1) >= 0 ? "many" : { at, length: needle.length };
  };
  const exact = once(old);
  if (exact) return exact;
  const unnumbered = old.replace(/^\s*\d+\t/gm, "");
  if (unnumbered !== old) { const r = once(unnumbered); if (r) return r; }
  // the same lines with other indentation: matched on trimmed lines, replaced with the file's own indentation
  const want = unnumbered.split("\n").map((l) => l.trim()).filter((l, i, a) => l || (i > 0 && i < a.length - 1));
  if (!want.length) return null;
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => lines[i + k].trim() === w)) hits.push(i);
  }
  if (hits.length !== 1) return hits.length ? "many" : null;
  const i = hits[0];
  const at = lines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  const length = lines.slice(i, i + want.length).join("\n").length;
  return { at, length, indents: lines.slice(i, i + want.length).map((l) => l.match(/^\s*/)[0]) };
}

// the new text with the file's indentation where the model's own was off: line for line when it has as many lines
// as the text it replaces, else every line moved by the first line's
export function reindent(text, indents) {
  const ls = text.split("\n");
  if (ls.length === indents.length) return ls.map((l, k) => (l.trim() ? indents[k] + l.trim() : l)).join("\n");
  const own = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return ls.map((l) => (l.trim() ? indents[0] + l.slice(Number.isFinite(own) ? own : 0) : l)).join("\n");
}

function command(cmd, cwd, signal, maxChars) {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    const keep = (c) => { out = (out + c).slice(-maxChars); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(kill, 120000);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => { clearTimeout(timer); resolve(`error: ${e.message}`); });
    child.on("close", (code) => { clearTimeout(timer); resolve(`exit ${code}\n${out.trim()}`); });
  });
}
