import { httpError } from '../http.mjs';
import { modeOf } from './chat-modes.mjs';

// Real agent-reported progress, scoped to one turn and archived with its answer.
export class ChatTasks {
  constructor(agent) { this.agent = agent; this.items = []; }
  emit() { this.agent.canvas.bus.emit('chat_tasks', { id: this.agent.id, tasks: this.items }); }
  reset() { this.items = []; this.emit(); }
  update({ todos, merge = false }, native = false) {
    const a = this.agent;
    if (modeOf(a) !== 'agent') throw httpError(403, 'implementation tasks need Agent mode');
    if (!a.current || a.terminal) throw httpError(409, 'tasks need an active chat turn');
    if (!Array.isArray(todos) || todos.length > 40 || typeof merge !== 'boolean') throw httpError(400, 'provide up to 40 todos');
    const ids = new Set();
    const changed = todos.map((t) => {
      if (!t || typeof t.id !== 'string' || !t.id.trim() || t.id.length > 80 || ids.has(t.id)) throw httpError(400, 'each task needs a unique id');
      ids.add(t.id);
      if (typeof t.content !== 'string' || !t.content.trim() || t.content.length > 500) throw httpError(400, 'task content: 1–500 characters');
      if (!['pending', 'in_progress', 'completed', 'cancelled', 'blocked'].includes(t.status)) throw httpError(400, 'invalid task status');
      if (t.activeForm !== undefined && (typeof t.activeForm !== "string" || t.activeForm.length > 500)) throw httpError(400, "invalid active task label");
      if (t.priority !== undefined && !['high', 'medium', 'low'].includes(t.priority)) throw httpError(400, 'invalid task priority');
      return { ...(t.priority ? { priority: t.priority } : {}), id: t.id, content: t.content.trim(), status: t.status, ...(t.activeForm ? { activeForm: t.activeForm.trim() } : {}) };
    });
    const next = merge ? this.items.map((t) => changed.find((c) => c.id === t.id) || t).concat(changed.filter((c) => !this.items.some((t) => t.id === c.id))) : changed;
    if (next.length > 40 || (!native && next.filter((t) => t.status === 'in_progress').length > 1)) throw httpError(400, 'at most 40 tasks and one active task');
    if (JSON.stringify(next) === JSON.stringify(this.items)) return this.items;
    this.items = next; this.emit(); return this.items;
  }
  snapshot(failed = false) {
    return this.items.map((t) => ({ ...t, status: failed && t.status === 'in_progress' ? 'cancelled' : t.status }));
  }
}
