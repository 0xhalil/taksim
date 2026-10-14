// MCP tools for saved tools: find one that fits, open it as the agent's panel, save the agent's panel as one.

import { Panel } from "../panels/panel.mjs";
import { httpError } from "../http.mjs";
import { listTools, getTool, saveTool, normalize, parametrize, fillParams, trimPreview, recordUse, card, marketTools, install, slug, similarTools } from "./store.mjs";
import { rank } from "./match.mjs";
import { DESIGN_TOOL, designTool } from "./guide.mjs";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false };

export const TOOLBOX_TOOLS = [
  DESIGN_TOOL,
  {
    name: "find_tools",
    description: "Searches the saved tools: ready panels that people and agents built before (e.g. watching Kubernetes pods, docker containers, a log file, slow Postgres queries), with their parameters. Call it before building a panel from bricks, and whenever the user asks for something to watch or check; using a fitting tool is faster and is what the user expects. Describe the need in a few words.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "what you need, e.g. \"kubernetes pod restarts\"" } }, required: ["query"] },
    annotations: READ_ONLY,
  },
  {
    name: "add_tool",
    description: "Adds a tool from the market (shared by other taksim users, see find_tools' in_market_not_added) to the user's library, so use_tool can open it. Only while the user has tool help on for you. Its commands still run only after the user approves them.",
    inputSchema: { type: "object", properties: {
      tool: { type: "string", description: "the market tool's id" },
      by: { type: "string", description: "its author, when two authors share an id" } }, required: ["tool"] },
  },
  {
    name: "use_tool",
    description: "Opens a saved tool as your panel (replacing your current one) and returns its instructions for you. Pass params for its settings (e.g. namespace); ones you leave out use the tool's defaults. Its commands start once the user approves them.",
    inputSchema: { type: "object", properties: {
      tool: { type: "string", description: "tool id or name (see find_tools)" },
      params: { type: "object", description: "{ <param>: value }" } }, required: ["tool"] },
    annotations: READ_ONLY,
  },
  {
    name: "save_tool",
    description: "Saves your current panel as a reusable tool the user can share in taksim's market. You write what makes it findable: `when` is 8-14 short requests a person would type when they need it, in the user's language and English, varied (\"pod'lar neden restart oluyor\", \"watch k8s pods\"); `not_when` is requests it must NOT match (a lookalike need it can't serve); `keywords` are single words (programs, technologies, synonyms). In `params`, name the values that differ per use (a namespace, a file path, a host) with the value your panel has now, so they become settings. `instructions` tell the next agent how to read the panel and what to watch for. One need, one tool: a near-duplicate of a saved tool is refused (update it with `id` instead), and parts no view shows are reported back so you can trim them. Call it when the user asks to save or share the panel, and on your own once a panel works and serves a need that comes back (watching a service, a cluster, a queue, CI); not for a one-off investigation. The user can rename or delete it later.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "short display name" },
      summary: { type: "string", description: "one sentence: what it shows and what for" },
      when: { type: "array", items: { type: "string" } },
      not_when: { type: "array", items: { type: "string" }, description: "requests this tool must not match" },
      keywords: { type: "array", items: { type: "string" } },
      params: { type: "object", description: "{ <name>: { value: \"<as in the panel now>\", desc } }" },
      instructions: { type: "string", description: "markdown for the agent that uses it" },
      id: { type: "string", description: "to update a tool you saved before" },
      reference: { type: "object", description: "the product you modeled it on (see design_tool): { product, url, borrowed: [features you took] }" },
    }, required: ["name", "summary", "when", "keywords"] },
    annotations: READ_ONLY,
  },
];

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

const brief = (t, extra = {}) => {
  const c = card(t);
  return { id: t.id, name: t.name, summary: t.summary, params: Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, `${p.desc || k}${p.default !== null ? ` (default ${p.default})` : " (required)"}`])),
    ...(c.available.ok ? {} : { missing_programs: c.available.missing }), used: t.uses || 0, ...extra };
};

// Opens a tool as the agent's panel. by "user": the person picked it after seeing its commands, which counts
// as approving them.
export function openTool(agent, ref, params = {}, { by = "agent", phrase } = {}) {
  const tool = getTool(ref);
  if (!tool) throw httpError(404, `no tool "${ref}"; call find_tools`);
  const values = {};
  const missing = [];
  for (const [k, p] of Object.entries(tool.params || {})) {
    const v = params?.[k] ?? p.default;
    if (v === null || v === undefined || v === "") missing.push(`${k} (${p.desc || "no description"})`);
    else values[k] = String(v);
  }
  if (missing.length) throw httpError(400, `"${tool.name}" needs: ${missing.join(", ")}. Ask the user if you don't know them.`);
  const panel = agent.panel || new Panel(agent);
  if (tool.origin === "market" || tool.origin === "imported") by = "agent"; // someone else's commands: asked when they first run
  const view = panel.setSpec(fillParams(tool.spec, values), { by, tool: { id: tool.id, name: tool.name, params: values } });
  agent.panel = panel;
  recordUse(tool.id, phrase);
  return { tool, view, values };
}

export async function callToolboxTool(self, name, args = {}) {
  if (name === "find_tools") {
    const r = rank(String(args.query || ""), listTools()).slice(0, 6);
    const market = (await marketTools().catch(() => [])).filter((t) => !t.installed);
    const extra = rank(String(args.query || ""), market).slice(0, 3);
    return text({
      tools: r.map((x) => brief(x.tool, { matched: x.why })),
      ...(extra.length ? { in_market_not_added: extra.map((x) => ({ id: x.tool.id, name: x.tool.name, summary: x.tool.summary, by: x.tool.author })),
        market_note: self.toolHelp === false
          ? "These are in the market but not in the user's library; tool help is off for you, so don't add them. Tell the user if one fits."
          : "These are in the market (shared by other taksim users) but not in the user's library: add the fitting one with add_tool, then open it with use_tool. Its commands still wait for the user's approval." } : {}),
      note: r.length ? "Open one with use_tool. If none fits, call design_tool and build one modeled on the best product for the need." : "No saved tool fits: call design_tool to see how the best products for this need do it, then build a panel from bricks (list_bricks, panel_open). If it turns out useful, offer to save it with save_tool.",
    });
  }
  if (name === "design_tool") return text(designTool(args.need));
  if (name === "add_tool") {
    if (self.toolHelp === false) throw new Error(self.canvas.lang === "tr"
      ? "tool help is off for you: the user adds market tools themselves (Araçlar → Market)"
      : "tool help is off for you: the user adds market tools themselves (Tools → Market)");
    const found = (await marketTools()).filter((t) => t.id === String(args.tool || "") && (!args.by || t.author === args.by));
    if (!found.length) throw new Error(`no market tool "${args.tool}"; call find_tools`);
    if (found.length > 1 && !args.by) throw new Error(`"${args.tool}" is shared by ${found.map((t) => t.author).join(", ")}; pass by`);
    const t = await install(found[0].shelf, found[0].id, { by: found[0].author });
    self.canvas.bus.emit("toolbox_changed", { id: t.id });
    return text({ added: t.id, name: t.name, by: found[0].author, note: "In the user's library now. Open it with use_tool; its commands wait for the user's approval." });
  }
  if (name === "use_tool") {
    const { tool, view, values } = openTool(self, args.tool, args.params || {}, { phrase: self.lastAsk });
    return text({
      opened: tool.name, params: values, status: view.status,
      note: view.status === "pending" ? `Waiting for the user to approve: ${view.pending.map((p) => p.argv ? p.argv.join(" ") : p.url || p.path).join(" · ")}.` : "Live. Read it with panel_read in a moment.",
      instructions: tool.instructions || "(none)",
    });
  }
  if (name === "save_tool") {
    if (!self.panel?.spec) throw new Error("you have no panel to save; build one first (panel_open)");
    const params = args.params && typeof args.params === "object" ? args.params : {};
    const prev = args.id ? getTool(args.id) : null;
    if (args.id && !prev) throw new Error(`no tool "${args.id}" to update`);
    if (prev && prev.origin !== "mine") throw new Error(`"${prev.name}" isn't the user's own tool; save under a new name`);
    const spec = parametrize(self.panel.spec, params);
    let id = prev?.id || slug(args.name);
    if (!prev) for (let i = 2; getTool(id); i++) id = `${slug(args.name).slice(0, 44)}-${i}`;
    const normalized = normalize({
      ...(prev || {}), id, name: prev?.name || args.name, summary: args.summary, when: args.when, keywords: args.keywords, not_when: args.not_when,
      instructions: args.instructions || prev?.instructions || "", spec, reference: args.reference || prev?.reference, version: prev ? (prev.version || 1) + 1 : 1,
      params: Object.fromEntries(Object.entries(params).map(([k, p]) => [k, { desc: p?.desc || "", default: p?.value ?? p?.default ?? null }])),
      preview: { data: trimPreview(self.panel.snapshot()), at: Date.now() }, author: undefined,
    }, { origin: "mine" });
    if (!prev) {
      // one need, one tool: a near-duplicate of a saved tool becomes an update of it, not a sibling
      const dup = similarTools(normalized)[0];
      if (dup) throw new Error(`this looks like the saved tool "${dup.name}" (${dup.id}, score ${dup.score}); update it with save_tool {id} instead of saving a sibling`);
    }
    const tool = saveTool(normalized);
    self.panel.tool = { id: tool.id, name: tool.name, params: Object.fromEntries(Object.entries(tool.params).map(([k, p]) => [k, p.default])) };
    self.panel.changed();
    self.canvas.bus.emit("toolbox_changed", { id: tool.id });
    const notes = tool.coherence?.length ? ` Coherence notes (trim so every part earns its place): ${tool.coherence.join("; ")}.` : "";
    const where = self.canvas.lang === "tr" ? "Araçlar" : "Tools";
    return text({ saved: tool.id, name: tool.name, params: Object.keys(tool.params),
      note: `Saved to the user's library. They can rename it, edit its triggers and share it from the Market ("${where}" button).${notes}` });
  }
  return undefined;
}

// A request to have another agent do the work ("kubernetes'e bakan bir agent oluştur", "spawn an agent that
// watches the pods"): a tool that fits belongs to that new agent, not to the one being asked.
const AGENT = /\b(agent|ajan|ajanı|ajanlar|ajana|agents?|bot|worker|helper|yardımcı)\w*/i;
const MAKE = /\b(oluştur|olustur|yarat|aç|ac|kur|ekle|başlat|baslat|create|spawn|make|start|add|launch|set up|setup|new|yeni)\w*/i;
// "split this across agents", "işi ajanlara böl": the person asks for the work to be divided among agents.
// Both words are needed: "split this function in two" is about code, not about who does the work.
const SPLIT = /(^|[^\p{L}])(böl|bölüş|parçala|paylaştır|dağıt|ayır|split|divide|distribut|parallel|paralel|orchestrat|orkestr)/iu;
export function splits(text) {
  const t = String(text || "").toLowerCase();
  return AGENT.test(t) && SPLIT.test(t);
}

export function delegates(text) {
  const t = String(text || "").toLowerCase();
  return AGENT.test(t) && MAKE.test(t);
}

// The tools worth naming to an agent along with a message, as a short note after it.
export function toolHints(suggestions, { delegate = false } = {}) {
  if (!suggestions.length) return "";
  const lines = suggestions.map(({ tool }) => {
    const p = Object.keys(tool.params || {});
    return `- ${tool.id} "${tool.name}": ${tool.summary}${p.length ? ` (params: ${p.join(", ")})` : ""}`;
  });
  const weak = (suggestions[0]?.score ?? 99) < 5
    ? " Fits are weak: if none truly fits the need, design a new tool instead of forcing one."
    : "";
  const how = delegate
    ? "The user asked for another agent to do this: create it with create_agent and pass the fitting tool as its `tool` (with tool_params), so the panel opens next to the new agent. Don't open it on yourself."
    : `If one fits, open it with use_tool instead of building a panel from scratch (if you hand the work to a new agent, pass it as create_agent's \`tool\` instead); find_tools searches for more. Ignore this if none fits.${weak}`;
  return `\n\n[taksim: saved tools that look relevant to this message:\n${lines.join("\n")}\n${how}]`;
}
