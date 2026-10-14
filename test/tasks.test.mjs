import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskEvents } from '../src/backends/tasks.mjs';
const use = (id, name, input, extra = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const result = (id, output = {}, is_error = false) => ({ type: 'user', tool_use_result: output, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } });
const codex = (items, type = 'item.updated') => ({ type, item: { id: 'plan', type: 'todo_list', items } });

test('Codex task identities survive status changes and reordering without inventing an active step', () => {
  const tracker = new TaskEvents();
  const first = tracker.take(codex([{ text: 'Read', completed: false }, { text: 'Test', completed: false }]));
  const reordered = tracker.take(codex([{ text: 'Test', completed: false }, { text: 'Read', completed: true }], 'item.completed'));
  assert.equal(reordered[0].id, first[1].id);
  assert.equal(reordered[1].id, first[0].id);
  assert.deepEqual(reordered.map((t) => t.status), ['pending', 'completed']);
  const duplicates = tracker.take(codex([{ text: 'Test', completed: false }, { text: 'Test', completed: true }]));
  assert.notEqual(duplicates[0].id, duplicates[1].id);
  assert.equal(tracker.take(codex([{ text: 'Test', completed: 'yes' }])), null);
  assert.equal(tracker.take(codex(Array(41).fill({ text: 'Test', completed: false }))), null);
  assert.deepEqual(tracker.take(codex([])), []);
});

test('Claude tasks correlate assigned IDs and apply updates only after a successful tool result', () => {
  const tracker = new TaskEvents();
  assert.equal(tracker.take(use('create', 'TaskCreate', { subject: 'Read', active_form: 'Reading' })), null);
  assert.equal(tracker.take(result('unrelated')), null);
  const initial = tracker.take(result('create', { task: { id: '1' } }));
  assert.equal(initial[0].id, 'claude-1');
  assert.equal(initial[0].status, 'pending');
  tracker.take(use('fail', 'TaskUpdate', { taskId: '1', status: 'completed' }));
  assert.equal(tracker.take(result('fail', {}, true)), null);
  tracker.take(use('active', 'TaskUpdate', { task_id: '1', status: 'in_progress' }));
  const active = tracker.take(result('active'));
  assert.equal(active[0].status, 'in_progress'); assert.equal(active[0].activeForm, 'Reading');
  tracker.take(use('done', 'TaskUpdate', { id: '1', status: 'completed', subject: 'Read source' }));
  assert.equal(tracker.take(result('done'))[0].content, 'Read source');
  tracker.take(use('delete', 'TaskUpdate', { taskId: '1', status: 'deleted' }));
  assert.deepEqual(tracker.take(result('delete')), []);
  assert.equal(tracker.take(result('delete')), null, 'duplicate results do not reapply tasks');
});

test('TodoWrite ignores partial, failed, nested and malformed calls, and applies full snapshots', () => {
  const tracker = new TaskEvents();
  assert.equal(tracker.take({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't', name: 'TodoWrite', input: {} } } }), null);
  tracker.take(use('nested', 'TodoWrite', { todos: [{ content: 'Other agent', status: 'completed' }] }, { parent_tool_use_id: 'parent' }));
  assert.equal(tracker.take(result('nested')), null);
  tracker.take(use('t', 'TodoWrite', { todos: [{ content: 'Test', status: 'in_progress', activeForm: 'Testing' }] }));
  assert.equal(tracker.take(result('t'))[0].activeForm, 'Testing');
  tracker.take(use('bad', 'TodoWrite', { todos: [{ content: 'False', status: 'completed' }] }));
  assert.equal(tracker.take(result('bad', {}, true)), null);
  tracker.take(use('clear', 'TodoWrite', { todos: [] }));
  assert.deepEqual(tracker.take(result('clear')), []);
  assert.equal(tracker.take({ type: 'assistant', message: { content: 'noise' } }), null);
  assert.equal(tracker.take({ type: 'user', message: { content: {} } }), null);
});


test('resumed Claude tasks appear only when successfully updated in the current turn', () => {
  const tracker = new TaskEvents([{ id: 'claude-1', content: 'Read', status: 'pending' }, { id: 'claude-2', content: 'Test', status: 'pending' }]);
  assert.equal(tracker.take({ type: 'result' }), null);
  tracker.take(use('failed', 'TaskUpdate', { taskId: '2', status: 'completed' }));
  assert.equal(tracker.take(result('failed', {}, true)), null);
  tracker.take(use('done', 'TaskUpdate', { taskId: '1', status: 'completed' }));
  assert.deepEqual(tracker.take(result('done')), [{ id: 'claude-1', content: 'Read', status: 'completed' }]);
  const fresh = new TaskEvents();
  fresh.take(use('old', 'TaskUpdate', { taskId: '1', status: 'completed' }));
  assert.equal(fresh.take(result('old')), null);
});


test('OpenCode accepts successful todo snapshots and reads, rejecting proposals and errors atomically', () => {
  const tracker = new TaskEvents();
  const rows = [{ content: 'Read', status: 'in_progress', priority: 'high' }, { content: 'Test', status: 'blocked', priority: 'low' }];
  const event = (status, todos = rows, tool = 'todowrite') => ({ type: 'tool_use', part: { type: 'tool', tool, state: { status, input: { todos }, output: JSON.stringify(todos) } } });
  assert.equal(tracker.take(event('running')), null);
  assert.equal(tracker.take(event('error')), null);
  const accepted = tracker.take(event('completed'));
  assert.equal(accepted[0].priority, 'high');
  assert.deepEqual(accepted.map((t) => t.status), ['in_progress', 'blocked']);
  assert.deepEqual(tracker.take(event('completed', rows, 'todoread')), accepted);
  assert.equal(tracker.take(event('completed', [...rows, { content: 'Invalid', status: 'bogus' }])), null);
  assert.deepEqual(tracker.take(event('completed', [])), []);
});

test('Gemini and Copilot/local correlate task proposals to successful results and ignore nested tasks', () => {
  const tracker = new TaskEvents();
  const todos = [{ content: 'Read', status: 'completed' }, { content: 'Test', status: 'blocked' }];
  tracker.take({ type: 'tool_use', tool_name: 'write_todos', tool_id: 'g1', parameters: { todos: todos.map((t) => ({ description: t.content, status: t.status })) } });
  assert.equal(tracker.take({ type: 'tool_result', tool_id: 'unknown', status: 'success' }), null);
  assert.deepEqual(tracker.take({ type: 'tool_result', tool_id: 'g1', status: 'success' }).map((t) => t.status), ['completed', 'blocked']);
  const start = (id, extra = {}) => ({ type: 'tool.execution_start', data: { toolCallId: id, toolName: 'update_todo', arguments: { todos }, ...extra } });
  const done = (id, success) => ({ type: 'tool.execution_complete', data: { toolCallId: id, success } });
  tracker.take(start('c1')); assert.equal(tracker.take(done('c1', false)), null);
  tracker.take(start('c2')); assert.equal(tracker.take(done('c2', true))[0].content, 'Read');
  tracker.take(start('nested', { parentToolCallId: 'parent' })); assert.equal(tracker.take(done('nested', true)), null);
  assert.equal(tracker.take({ type: 'session.todos_changed', data: {} }), null, 'payload-free SQL signals cannot invent a list');
});
