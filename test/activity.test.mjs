import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../src/backends/activity.mjs';

test('Codex activity reports actual tools, failures and file changes, excluding reasoning', () => {
  assert.deepEqual(activityOf({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'done' } }), []);
  assert.deepEqual(activityOf({ type: 'item.started', item: { id: 'b', type: 'command_execution', command: 'npm test' } }),
    [{ id: 'b', label: 'Command', detail: 'npm test', status: 'running' }]);
  assert.equal(activityOf({ type: 'item.completed', item: { id: 'b', type: 'command_execution', exit_code: 1 } })[0].status, 'error');
  assert.deepEqual(activityOf({ type: 'item.completed', item: { id: 'c', type: 'file_change', changes: [{ path: 'main.swift' }] } }),
    [{ id: 'c', label: 'File', detail: 'main.swift', status: 'done' }]);
  assert.deepEqual(activityOf({ type: 'item.started', item: { id: 'b', type: 'command_execution', command: 'npm test' } }, 'tr'),
    [{ id: 'b', label: 'Komut', detail: 'npm test', status: 'running' }]);
});
test('Claude streamed starts, complete inputs and results share the same tool identity', () => {
  assert.deepEqual(activityOf({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } } }),
    [{ id: 't', label: 'Read', detail: '', status: 'running' }]);
  assert.equal(activityOf({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'app.py' } }] } })[0].detail, 'app.py');
  assert.deepEqual(activityOf({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: false }] } }), [{ id: 't', status: 'done' }]);
});


test('OpenCode, Gemini and Copilot/local expose real tool lifecycles and failures', () => {
  const open = activityOf({ type: 'tool_use', part: { type: 'tool', callID: 'o', tool: 'bash', state: { status: 'completed', input: { command: 'test' }, metadata: { exit: 1 } } } });
  assert.deepEqual(open, [{ id: 'o', label: 'bash', detail: 'test', status: 'error' }]);
  assert.equal(activityOf({ type: 'tool_use', tool_id: 'g', tool_name: 'read_file', parameters: { file_path: 'a.swift' } })[0].detail, 'a.swift');
  assert.deepEqual(activityOf({ type: 'tool_result', tool_id: 'g', status: 'error' }), [{ id: 'g', status: 'error' }]);
  assert.equal(activityOf({ type: 'tool.execution_start', data: { toolCallId: 'c', toolName: 'view', arguments: { path: 'a.swift' } } })[0].status, 'running');
  assert.deepEqual(activityOf({ type: 'tool.execution_complete', data: { toolCallId: 'c', success: true } }), [{ id: 'c', status: 'done' }]);
  assert.deepEqual(activityOf({ type: 'assistant', message: { content: 'malformed' } }), []);
});
