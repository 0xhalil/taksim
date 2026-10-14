// An agent's MCP servers ("connectors"): the ones its CLI is set up with — globally, for its account, for the
// project — and the ones added to the agent in taksim. Each can be turned off for one agent. The backends hand
// the result to their CLI (`opts.mcp`), next to taksim's own server.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { httpError } from "../http.mjs";

const NAME = /^[A-Za-z][\w-]{0,40}$/;
const RESERVED = new Set(["taksim"]);

const readJson = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; } catch { return null; } };

/** one server's spec in a common shape: { url } for HTTP, { command, args, env } for a local process */
function normalize(def) {
  if (!def || typeof def !== "object") return null;
  const url = def.url || def.httpUrl || def.serverUrl;
  if (url) return { url: String(url), ...(def.headers ? { headers: def.headers } : {}) };
  let command = def.command, args = def.args || [];
  if (Array.isArray(command)) { args = command.slice(1); command = command[0]; } // opencode: command: [bin, ...args]
  if (!command) return null;
  return { command: String(command), args: args.map(String), ...(def.env || def.environment ? { env: def.env || def.environment } : {}) };
}

/** the servers in Codex's config.toml: [mcp_servers.<name>] tables with command/args/url */
function codexServers(file) {
  if (!existsSync(file)) return {};
  const out = {};
  let cur = null;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    const table = /^\[mcp_servers\.("?)([^\]."]+)\1\]$/.exec(line);
    if (table) { cur = out[table[2]] = {}; continue; }
    if (line.startsWith("[")) { cur = null; continue; }
    if (!cur) continue;
    const kv = /^(command|url|args|enabled)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    try { cur[kv[1]] = JSON.parse(kv[2].replace(/'/g, '"')); } catch {}
  }
  return out;
}

/** The servers an agent's CLI is set up with, by name: { name: { spec, from } } (`from`: where it is set). */
export function cliServers(backend, env = {}, cwd = null) {
  const home = homedir(), out = {};
  const add = (servers, from) => {
    for (const [name, def] of Object.entries(servers || {})) {
      if (RESERVED.has(name) || def?.enabled === false || def?.disabled === true) continue;
      const spec = normalize(def);
      if (spec) out[name] = { spec, from };
    }
  };
  if (backend === "claude") {
    const cfg = readJson(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json"));
    add(cfg?.mcpServers, "user");
    if (cwd) { add(cfg?.projects?.[cwd]?.mcpServers, "project"); add(readJson(join(cwd, ".mcp.json"))?.mcpServers, "project"); }
  } else if (backend === "codex") {
    add(codexServers(join(env.CODEX_HOME || join(home, ".codex"), "config.toml")), "user");
  } else if (backend === "gemini") {
    add(readJson(join(env.GEMINI_CLI_HOME || home, ".gemini", "settings.json"))?.mcpServers, "user");
    if (cwd) add(readJson(join(cwd, ".gemini", "settings.json"))?.mcpServers, "project");
  } else if (backend === "opencode") {
    add(readJson(join(home, ".config", "opencode", "opencode.json"))?.mcp, "user");
    if (cwd) add(readJson(join(cwd, "opencode.json"))?.mcp, "project");
  } else if (backend === "copilot" || backend === "local") {
    add(readJson(join(env.COPILOT_HOME || join(home, ".copilot"), "mcp-config.json"))?.mcpServers, "user");
  }
  return out;
}

/** Checks a server added in taksim: a name, and a URL or a command line. */
export function checkServer(input) {
  const name = String(input?.name || "").trim();
  if (!NAME.test(name) || RESERVED.has(name)) throw httpError(400, "a server name is a letter followed by letters, digits, - or _");
  const spec = normalize(input);
  if (!spec) throw httpError(400, "give a url or a command");
  if (spec.url && !/^https?:\/\//.test(spec.url)) throw httpError(400, "the url must start with http:// or https://");
  return { name, spec };
}

/** A name from what the user typed: the host of a URL, the package of an npx/uvx line, else the command. */
export function suggestName(spec) {
  let base = "";
  if (spec.url) { try { base = new URL(spec.url).hostname.split(".").filter((p) => !["www", "mcp", "api", "com", "io", "dev", "net", "org", "app"].includes(p))[0] || ""; } catch {} }
  else {
    const pkg = [spec.command, ...(spec.args || [])].find((a) => /^@?[\w.-]+\/[\w.-]+|^[\w.-]+-mcp|^mcp-/.test(a)) || spec.command;
    base = pkg.split("/").pop().replace(/@[\w.^~-]*$/, "").replace(/^(server-|mcp-)|(-mcp|-server|-mcp-server)$/g, "");
  }
  return (base.replace(/[^\w-]/g, "-").replace(/^[^A-Za-z]+/, "") || "server").slice(0, 40);
}

/**
 * What an agent's CLI gets: `extra` — servers to add (taksim's added ones, and for Claude the CLI's own ones it
 * keeps on, since taksim passes its servers strictly) — and `off`, the CLI's own servers turned off.
 */
export function agentServers(agent) {
  const own = cliServers(agent.backend, agent.env || {}, agent.workDir?.());
  const off = new Set(agent.mcp?.off || []);
  const added = Object.entries(agent.mcp?.added || {}).filter(([n]) => !off.has(n)).map(([name, spec]) => ({ name, spec }));
  const cli = Object.entries(own).filter(([n]) => !off.has(n)).map(([name, { spec }]) => ({ name, spec }));
  const offNames = [...off].filter((n) => own[n]);
  return { added, cli, off: offNames, offSpecs: offNames.map((name) => ({ name, spec: own[name].spec })) };
}

/** The list the app shows: taksim's server, the CLI's own and the added ones, each on or off. */
export function describeServers(agent) {
  const own = cliServers(agent.backend, agent.env || {}, agent.workDir?.());
  const off = new Set(agent.mcp?.off || []);
  const show = (spec) => spec.url || [spec.command, ...(spec.args || [])].join(" ");
  return [
    { name: "taksim", from: "taksim", on: true, fixed: true, target: "taksim" },
    ...Object.entries(own).map(([name, { spec, from }]) => ({ name, from, on: !off.has(name), target: show(spec) })),
    ...Object.entries(agent.mcp?.added || {}).map(([name, spec]) => ({ name, from: "added", on: !off.has(name), target: show(spec) })),
  ];
}
