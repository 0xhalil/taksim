// Project rules, Cursor's way: instructions a project keeps for the models that work in it. Read from
// .taksimrules, .cursorrules and .cursor/rules/*.mdc|md, so a project that already has Cursor rules works as it is.
// The CLIs read their own files (CLAUDE.md, AGENTS.md, GEMINI.md); these are the ones no CLI reads, so every
// agent gets them in its system prompt. A rule file may carry front matter: alwaysApply, description, globs.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_RULE = 8000, MAX_ALL = 24000;

function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const l of m[1].split("\n")) { const k = l.match(/^(\w+)\s*:\s*(.*)$/); if (k) meta[k[1]] = k[2].trim().replace(/^["']|["']$/g, ""); }
  return { meta, body: text.slice(m[0].length) };
}

/** [{ path, name, description, globs, always, body }] for the rule files of a project folder */
export function listRules(root) {
  const out = [];
  const add = (rel, always) => {
    let text;
    try { text = readFileSync(join(root, rel), "utf8"); } catch { return; }
    if (!text.trim()) return;
    const { meta, body } = frontMatter(text);
    out.push({ path: rel, name: rel.split("/").pop().replace(/\.(mdc|md)$/, ""), description: meta.description || "", globs: meta.globs || "",
      always: meta.alwaysApply !== undefined ? meta.alwaysApply === "true" : always, body: body.trim().slice(0, MAX_RULE) });
  };
  add(".taksimrules", true);
  add(".cursorrules", true);
  let dir = [];
  try { dir = readdirSync(join(root, ".cursor", "rules")).filter((f) => /\.(mdc|md)$/.test(f)).sort(); } catch { /* none */ }
  for (const f of dir) add(`.cursor/rules/${f}`, false);
  return out;
}

/** the rules as the text an agent's system prompt carries: always-on rules in full, the others by name so the agent can read them */
export function projectRules(root, { all = false } = {}) {
  let rules;
  try { rules = listRules(root); } catch { return ""; }
  const parts = [], rest = [];
  let size = 0;
  for (const r of rules) {
    if (r.always || all && !r.globs && !r.description) {
      if (size + r.body.length > MAX_ALL) continue;
      size += r.body.length;
      parts.push(`# ${r.path}\n${r.body}`);
    } else rest.push(`- ${r.path}${r.description ? `: ${r.description}` : ""}${r.globs ? ` (files: ${r.globs})` : ""}`);
  }
  if (!all && rest.length) parts.push(`Further rules, read one when its description or files fit your task:\n${rest.join("\n")}`);
  return parts.join("\n\n");
}

/** the first rules file, `.taksimrules` created empty when the project has none yet */
export function ensureRules(root) {
  const have = listRules(root)[0];
  if (have) return have.path;
  writeFileSync(join(root, ".taksimrules"), "", { flag: "a" });
  return ".taksimrules";
}
