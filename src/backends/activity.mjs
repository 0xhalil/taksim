// Normalize real CLI tool events without exposing the backend's wire format in the UI.
const detailOf = (input) => String(input?.command || input?.file_path || input?.filePath || input?.path || input?.query || input?.description || "").slice(0, 4000);
const tool = (lang) => (lang === "tr" ? "Araç" : "Tool");
export function activityOf(event, lang = "en") {
  // Antigravity: a tool is one step of its conversation, ACTIVE then DONE or ERROR
  if (event.event === "step_update" && event.step_update?.step_type === "tool") {
    const s = event.step_update, p = s.tool_info?.parameters || {};
    return [{ id: `${s.conversation_id}:${s.step_index}`, label: s.tool_name || tool(lang),
      detail: String(p.CommandLine || p.AbsolutePath || p.TargetFile || p.DirectoryPath || p.Query || p.Url || detailOf(p)).slice(0, 4000),
      status: s.state === "ERROR" ? "error" : s.state === "DONE" ? "done" : "running" }];
  }
  if (event.type === "tool_use" && event.part?.type === "tool") {
    const p = event.part, state = p.state;
    if (!p.callID || !state || !["running", "completed", "error"].includes(state.status)) return [];
    return [{ id: p.callID, label: p.tool || tool(lang), detail: detailOf(state.input), status: state.status === "error" || (state.metadata?.exit != null && state.metadata.exit !== 0) ? "error" : state.status === "completed" ? "done" : "running" }];
  }
  if (event.type === "tool_use" && event.tool_id) return [{ id: event.tool_id, label: event.tool_name || tool(lang), detail: detailOf(event.parameters), status: "running" }];
  if (event.type === "tool_result" && event.tool_id) return [{ id: event.tool_id, status: event.status === "success" ? "done" : "error" }];
  if (event.type === "tool.execution_start" && event.data?.toolCallId) return [{ id: event.data.toolCallId, label: event.data.toolName || tool(lang), detail: detailOf(event.data.arguments), status: "running" }];
  if (event.type === "tool.execution_complete" && event.data?.toolCallId) return [{ id: event.data.toolCallId, status: event.data.success === true ? "done" : "error" }];
  if (/^item\.(started|updated|completed)$/.test(event.type)) {
    const item = event.item;
    if (!item?.id || !["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) return [];
    const label = item.type === "command_execution" ? (lang === "tr" ? "Komut" : "Command") : item.type === "file_change" ? (lang === "tr" ? "Dosya" : "File") :
      item.type === "web_search" ? (lang === "tr" ? "Arama" : "Search") : item.tool || tool(lang);
    const detail = item.command || item.query || item.changes?.map((c) => c.path).join("\n") || item.server || "";
    return [{ id: item.id, label, detail: String(detail).slice(0, 4000),
      status: item.status === "failed" || item.error || (item.exit_code != null && item.exit_code !== 0) ? "error" :
        event.type === "item.completed" ? "done" : "running" }];
  }
  // Claude's streamed tool_use is followed by an assistant block with complete tool input.
  const block = event.type === "stream_event" ? event.event : event;
  const contents = block.type === "content_block_start" ? [block.content_block] :
    event.type === "assistant" ? (Array.isArray(event.message?.content) ? event.message.content : []) : [];
  const tools = contents.filter((c) => c?.type === "tool_use" && c.id).map((c) => ({ id: c.id,
    label: c.name || tool(lang), detail: String(c.input?.command || c.input?.file_path || c.input?.path || c.input?.query || "").slice(0, 4000), status: "running" }));
  if (event.type === "user") for (const result of (Array.isArray(event.message?.content) ? event.message.content : [])) {
    if (result.type === "tool_result" && result.tool_use_id) tools.push({ id: result.tool_use_id, status: result.is_error ? "error" : "done" });
  }
  return tools;
}
