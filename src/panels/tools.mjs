// MCP tools for the calling agent's panel: it assembles bricks into a live view docked next to its node.

import { catalog } from "../bricks/catalog.mjs";
import { Panel } from "./panel.mjs";

// Claude Code's plan mode (read-only agents) only lets through MCP tools marked read-only. A panel changes no
// files and its commands still need the user's approval, so its tools count as read-only.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false };

const SPEC_DESC = "Panel spec: { title, sources: { <name>: { brick: command|tail|http|agent, … } }, views: [ { id, brick: table|log|stat|kv|markdown|json|chart|timeline|bars|scene, source, … } ], inputs?: { <name>: select|text|toggle|row }, actions?: [ buttons ] }. Make it interactive when the user would steer it: a namespace or environment to pick, a search box, a row to drill into (inputs, used in sources as {{in.<name>}}), buttons for the actions they'd take. Call list_bricks first for every field and examples.";

export const PANEL_TOOLS = [
  {
    name: "list_bricks",
    description: "The building blocks for your panel (a live view docked next to you on the canvas): sources (commands, files, URLs, data you push), parsers, filters, views (table, log, stat, kv, markdown, json, and the animated chart for trends, timeline for durations, bars for rankings) and row actions, with their fields and an example spec.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
  {
    name: "panel_open",
    description: `Opens (or replaces) your panel, a live view docked next to you. Open it without being asked when your work involves something to watch: command output refreshed every N seconds, a log stream, an endpoint, your findings. ${SPEC_DESC} Commands and run actions start once the user approves them; the result says if approval is pending. An invalid spec is rejected with what to fix.`,
    inputSchema: { type: "object", properties: { spec: { type: "object", description: SPEC_DESC } }, required: ["spec"] },
    annotations: READ_ONLY,
  },
  {
    name: "panel_patch",
    description: "Changes part of your panel, e.g. when the user asks for another column or view. sources: {<name>: source | null to remove}; views: [{id, …fields to change}] changes a view, a new id adds one, {id, remove: true} removes one; order: [view ids]; title; inputs: {<name>: input | null}; actions: [buttons] (replaces them); values: {<input>: value} sets what an input shows (e.g. to point the user at a namespace).",
    inputSchema: { type: "object", properties: {
      title: { type: "string" }, sources: { type: "object" }, views: { type: "array", items: { type: "object" } },
      order: { type: "array", items: { type: "string" } }, inputs: { type: "object" }, actions: { type: "array", items: { type: "object" } },
      values: { type: "object" } } },
    annotations: READ_ONLY,
  },
  {
    name: "panel_push",
    description: "Puts your own data into the panel: an \"agent\" source (added if missing). mode replace (default) sets it; append adds rows (e.g. findings as you go). A markdown view shows a string; a table shows a list of objects.",
    inputSchema: { type: "object", properties: {
      source: { type: "string" }, data: { description: "string, object or list of objects" },
      mode: { type: "string", enum: ["replace", "append"] } }, required: ["source", "data"] },
    annotations: READ_ONLY,
  },
  {
    name: "panel_read",
    description: "Reads the latest data of your panel's sources (what the user sees), with errors. Cheaper than re-running a command it already watches.",
    inputSchema: { type: "object", properties: { source: { type: "string", description: "one source; default all" } } },
    annotations: READ_ONLY,
  },
  {
    name: "panel_close",
    description: "Removes your panel and stops its sources.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ_ONLY,
  },
];

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

function summary(self, view) {
  const pending = view.status === "pending";
  return {
    status: view.status,
    views: view.spec.views.map((v) => v.id),
    sources: Object.keys(view.spec.sources),
    note: pending
      ? `Waiting for the user to approve: ${view.pending.map((p) => p.argv ? p.argv.join(" ") : p.url || p.path).join(" · ")}. Those start after that; the other sources already run. Tell the user what you set up and why.`
      : view.status === "rejected" ? "The user rejected this panel's commands; ask them what they would accept."
      : "Live. Check it with panel_read in a moment.",
  };
}

// Returns undefined for tools that aren't panel tools.
export async function callPanelTool(self, name, args = {}) {
  if (name === "list_bricks") return text(catalog());
  if (name === "panel_open") {
    const panel = self.panel || new Panel(self);
    const view = panel.setSpec(args.spec); // a rejected spec leaves no panel behind
    self.panel = panel;
    return text(summary(self, view));
  }
  if (name === "panel_patch") {
    if (!self.panel?.spec) throw new Error("you have no panel yet; open one with panel_open");
    const { title, sources, views, order, inputs, actions, values } = args;
    if (title !== undefined || sources || views || order || inputs || actions) self.panel.patch({ title, sources, views, order, inputs, actions });
    return text(summary(self, values ? self.panel.setInputs(values) : self.panel.view()));
  }
  if (name === "panel_push") {
    const panel = self.panel || new Panel(self);
    panel.push(String(args.source), args.data, args.mode === "append" ? "append" : "replace");
    self.panel = panel;
    return text(`Pushed to "${args.source}".`);
  }
  if (name === "panel_read") {
    if (!self.panel?.spec) throw new Error("you have no panel; open one with panel_open");
    return text(self.panel.read(args.source));
  }
  if (name === "panel_close") {
    self.removePanel();
    return text("Panel removed.");
  }
  return undefined;
}
