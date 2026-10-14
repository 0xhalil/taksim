import { createHash } from 'node:crypto';

const statuses = new Set(['pending', 'in_progress', 'completed', 'cancelled', 'blocked']);
const identity = (text, occurrence) => 'native-' + createHash('sha256').update(`${text}\0${occurrence}`).digest('hex').slice(0, 24);
// Text-derived identities survive status changes and reordering; repeated labels remain distinct.
function list(rows, codex = false) {
  if (!Array.isArray(rows) || rows.length > 40) return null;
  const seen = new Map();
  const tasks = [];
  for (const row of rows) {
    const content = codex ? row?.text : row?.content;
    const status = codex ? (typeof row?.completed === 'boolean' ? (row.completed ? 'completed' : 'pending') : null) : row?.status;
    if (typeof content !== 'string' || !content.trim() || content.length > 500 || !statuses.has(status)) return null;
    const text = content.trim(), n = seen.get(text) || 0;
    seen.set(text, n + 1);
    tasks.push({ id: identity(text, n), content: text, status,
      ...(['high', 'medium', 'low'].includes(row.priority) ? { priority: row.priority } : {}),
      ...(typeof row.activeForm === 'string' && row.activeForm.trim() && row.activeForm.length <= 500 ? { activeForm: row.activeForm.trim() } : {}) });
  }
  return tasks;
}

// One tracker per CLI invocation. Tool proposals are applied only after their successful result.
export class TaskEvents {
  constructor(seed = []) {
    this.pending = new Map(); this.tasks = new Map();
    this.known = new Map(seed.filter((t) => typeof t.id === 'string' && t.id.startsWith('claude-') && typeof t.content === 'string' && t.content.trim() && t.content.length <= 500 && statuses.has(t.status)).slice(0, 40).map((t) => [t.id, t]));
  }
  remember(id, call) {
    if (typeof id !== 'string') return;
    this.pending.set(id, call);
    if (this.pending.size > 80) this.pending.delete(this.pending.keys().next().value);
  }
  take(event) {
    // OpenCode emits the complete tool part, including the accepted input and result.
    if (event.type === 'tool_use' && event.part?.type === 'tool') {
      const part = event.part;
      if (part.state?.status !== 'completed' || !['todowrite', 'todoread'].includes(part.tool)) return null;
      return list(part.state.metadata?.todos ?? (part.tool === 'todowrite' ? part.state.input?.todos : json(part.state.output)));
    }
    // Gemini proposals are followed by a separate success/error event.
    if (event.type === 'tool_use' && event.tool_name === 'write_todos' && typeof event.tool_id === 'string') {
      this.remember(event.tool_id, { name: 'gemini', input: event.parameters });
      return null;
    }
    if (event.type === 'tool_result') {
      const call = this.pending.get(event.tool_id); this.pending.delete(event.tool_id);
      if (call?.name !== 'gemini' || event.status !== 'success') return null;
      const rows = call.input?.todos;
      return list(Array.isArray(rows) ? rows.map((t) => ({ ...t, content: t.description })) : rows);
    }
    // Copilot and local models share the same CLI. Older TodoWrite-style tools
    // carry a full list; SQL-based todo signals carry no list and must not be guessed.
    if (event.type === 'tool.execution_start' && !event.agentId && !event.data?.parentToolCallId && ['update_todo', 'TodoWrite'].includes(event.data?.toolName)) {
      this.remember(event.data.toolCallId, { name: 'copilot', input: event.data.arguments });
      return null;
    }
    if (event.type === 'tool.execution_complete') {
      const call = this.pending.get(event.data?.toolCallId); this.pending.delete(event.data?.toolCallId);
      if (event.agentId || event.data?.parentToolCallId || call?.name !== 'copilot' || event.data?.success !== true) return null;
      return list(call.input?.todos);
    }
    if (/^item\.(started|updated|completed)$/.test(event.type) && event.item?.type === 'todo_list') {
      return list(event.item.items, true);
    }
    if (event.type === 'assistant' && !event.parent_tool_use_id) {
      for (const block of (Array.isArray(event.message?.content) ? event.message.content : [])) {
        if (block?.type === 'tool_use' && typeof block.id === 'string' && ['TodoWrite', 'TaskCreate', 'TaskUpdate'].includes(block.name)) {
          this.remember(block.id, { name: block.name, input: block.input || {} });
        }
      }
    }
    if (event.type !== 'user' || event.parent_tool_use_id) return null;
    const results = (Array.isArray(event.message?.content) ? event.message.content : []).filter((b) => b?.type === 'tool_result');
    let changed = false;
    for (const result of results) {
      const call = this.pending.get(result.tool_use_id);
      this.pending.delete(result.tool_use_id);
      if (!call || result.is_error) continue;
      const input = call.input;
      if (call.name === 'TodoWrite') {
        const todos = list(input.todos);
        if (todos === null) continue;
        this.tasks = new Map(todos.map((t) => [t.id, t])); changed = true;
      } else if (call.name === 'TaskCreate') {
        let output = results.length === 1 ? event.tool_use_result : null;
        if (!output) {
          const text = typeof result.content === 'string' ? result.content : Array.isArray(result.content) ? result.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : null;
          try { output = JSON.parse(text); } catch { continue; }
        }
        if (typeof output === 'string') { try { output = JSON.parse(output); } catch { continue; } }
        const taskId = output?.task?.id;
        if (typeof taskId !== 'string' || !taskId || taskId.length > 64 || typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 500) continue;
        const id = `claude-${taskId}`;
        if (this.tasks.size >= 40 && !this.tasks.has(id)) continue;
        this.tasks.set(id, { id, content: input.subject.trim(), status: 'pending', ...active(input) }); changed = true;
      } else {
        const taskId = input.taskId ?? input.id ?? input.task_id;
        const id = `claude-${taskId}`, old = this.tasks.get(id) || this.known.get(id);
        if (!old) continue;
        if (input.status === 'deleted') { this.tasks.delete(id); this.known.delete(id); changed = true; continue; }
        if (this.tasks.size >= 40 && !this.tasks.has(id)) continue;
        if (input.status !== undefined && !statuses.has(input.status)) continue;
        if (input.subject !== undefined && (typeof input.subject !== 'string' || !input.subject.trim() || input.subject.length > 500)) continue;
        this.tasks.set(id, { ...old, ...(input.subject ? { content: input.subject.trim() } : {}), ...(input.status ? { status: input.status } : {}), ...active(input) }); changed = true;
      }
    }
    return changed ? [...this.tasks.values()] : null;
  }
}
function active(input) {
  const text = input.activeForm ?? input.active_form;
  return typeof text === 'string' && text.trim() && text.length <= 500 ? { activeForm: text.trim() } : {};
}

function json(value) { try { return JSON.parse(value); } catch { return null; } }
