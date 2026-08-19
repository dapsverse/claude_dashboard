// test/chat/session.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createChatRepo } from '../../src/store/chat.js';
import { createSessionManager, SETTING_SOURCES } from '../../src/chat/session.js';
import { createPermissionGate } from '../../src/chat/permissions.js';
import { createFakeSdk, initMessage, assistantText, resultMessage } from './fake-sdk.js';

function harness({ now = () => 1000 } = {}) {
  const events = [];
  const hub = {
    broadcast(event, data) { events.push({ event, data }); },
    of(name) { return events.filter((e) => e.event === name).map((e) => e.data); },
    events,
  };
  const store = createChatRepo(openDb(join(mkdtempSync(join(tmpdir(), 'ap-sess-')), 'data.db')));
  const sdk = createFakeSdk();
  const permissions = createPermissionGate({ hub, now });
  const sessions = createSessionManager({ store, hub, now, sdk, permissions });
  return { hub, store, sdk, permissions, sessions };
}

const settled = () => new Promise((r) => setTimeout(r, 5));

test('nothing starts until the first message is sent', async () => {
  const { sdk, sessions } = harness();
  assert.equal(sessions.get('/p/one').running, false);
  assert.equal(sdk.calls.length, 0);
  await sessions.close();
});

test('the first send starts exactly one session with the user\'s own configuration', async () => {
  const { sdk, sessions } = harness();
  await sessions.send('/p/one', 'hello');
  assert.equal(sdk.calls.length, 1);
  const { options } = sdk.last();
  assert.equal(options.cwd, '/p/one');
  // Without this the session loads none of the user's CLAUDE.md, agents, skills or plugins.
  assert.deepEqual(options.settingSources, SETTING_SOURCES);
  assert.deepEqual(SETTING_SOURCES, ['user', 'project', 'local']);
  assert.equal(options.permissionMode, 'default');
  assert.equal(options.includePartialMessages, true);
  assert.equal(typeof options.canUseTool, 'function');
  assert.ok(options.abortController instanceof AbortController);
  assert.equal(options.resume, undefined);
  await sessions.close();
});

test('the queued message has the shape the SDK requires of an interactive prompt', async () => {
  const { sdk, sessions } = harness();
  await sessions.send('/p/one', 'hello');
  const [message] = await sdk.last().waitForInput();
  assert.equal(message.type, 'user');
  assert.equal(message.parent_tool_use_id, null);
  assert.deepEqual(message.message, { role: 'user', content: 'hello' });
  assert.deepEqual(message.origin, { kind: 'human' });
  await sessions.close();
});

test('a second message reuses the running session rather than starting another', async () => {
  const { sdk, sessions } = harness();
  await sessions.send('/p/one', 'first');
  await sessions.send('/p/one', 'second');
  assert.equal(sdk.calls.length, 1);
  const inputs = await sdk.last().waitForInput(2);
  assert.deepEqual(inputs.map((m) => m.message.content), ['first', 'second']);
  await sessions.close();
});

test('two sends racing each other still start only one session', async () => {
  const { sdk, sessions } = harness();
  await Promise.all([sessions.send('/p/one', 'a'), sessions.send('/p/one', 'b')]);
  assert.equal(sdk.calls.length, 1);
  await sessions.close();
});

test('projects are isolated: separate sessions, separate cwds, no cross-delivery', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'for one');
  await sessions.send('/p/two', 'for two');
  assert.equal(sdk.calls.length, 2);
  assert.deepEqual(sdk.calls.map((c) => c.options.cwd), ['/p/one', '/p/two']);
  assert.deepEqual((await sdk.calls[0].waitForInput()).map((m) => m.message.content), ['for one']);
  assert.deepEqual((await sdk.calls[1].waitForInput()).map((m) => m.message.content), ['for two']);

  sdk.calls[0].outbox.push(assistantText('answer for one'));
  await settled();
  assert.deepEqual(hub.of('chat.message').map((m) => m.projectPath), ['/p/one']);
  await sessions.close();
});

test('the init message persists the sdk session id and reports the session ready', async () => {
  const { sdk, sessions, store, hub } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.push(initMessage('sess-abc'));
  await settled();
  assert.equal(store.getSession('/p/one').sessionId, 'sess-abc');
  const ready = hub.of('chat.status').find((s) => s.state === 'ready');
  assert.deepEqual(ready, {
    projectPath: '/p/one', ts: 1000, state: 'ready', sessionId: 'sess-abc',
    model: 'claude-opus-5', tools: ['Read', 'Bash'], agents: ['reviewer'], permissionMode: 'default',
  });
  assert.equal(sessions.get('/p/one').sessionId, 'sess-abc');
  await sessions.close();
});

test('a known project resumes its stored session instead of forking a new one', async () => {
  const { sdk, sessions, store } = harness();
  store.setSessionId({ projectPath: '/p/one', sessionId: 'sess-old', at: 1 });
  await sessions.send('/p/one', 'still there?');
  assert.equal(sdk.last().options.resume, 'sess-old');
  assert.equal(sdk.last().options.forkSession, false);
  await sessions.close();
});

test('reset clears the stored session and the transcript, and the next send starts fresh', async () => {
  const { sdk, sessions, store, hub } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.calls[0].outbox.push(initMessage('sess-abc'));
  await settled();

  await sessions.reset('/p/one');
  assert.equal(store.getSession('/p/one'), null);
  assert.equal(store.list('/p/one').length, 0);
  assert.equal(sdk.calls[0].closed, true);
  assert.ok(hub.of('chat.status').some((s) => s.state === 'reset'));

  await sessions.send('/p/one', 'new conversation');
  assert.equal(sdk.calls.length, 2);
  assert.equal(sdk.calls[1].options.resume, undefined);
  await sessions.close();
});

test('assistant text is broadcast and persisted', async () => {
  const { sdk, sessions, store, hub } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.push(assistantText('here is the answer'));
  await settled();

  assert.deepEqual(hub.of('chat.message'), [{
    projectPath: '/p/one', ts: 1000, messageId: 'msg_1', parentToolUseId: null,
    role: 'assistant', subagentType: null,
    blocks: [{ type: 'text', text: 'here is the answer' }],
  }]);
  const stored = store.list('/p/one');
  assert.deepEqual(stored.map((m) => m.role), ['user', 'assistant']);
  assert.equal(stored[1].blocks[0].text, 'here is the answer');
  await sessions.close();
});

test('a tool_use block raises its own event carrying the raw input', async () => {
  const { sdk, sessions, hub, store } = harness();
  await sessions.send('/p/one', 'run it');
  sdk.last().outbox.push(assistantText('', {
    message: {
      id: 'msg_2', role: 'assistant', content: [
        { type: 'text', text: 'running' },
        { type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls -la' } },
      ],
    },
  }));
  await settled();

  assert.deepEqual(hub.of('chat.tool_use'), [{
    projectPath: '/p/one', ts: 1000, messageId: 'msg_2', parentToolUseId: null,
    toolUseId: 'toolu_9', name: 'Bash', input: { command: 'ls -la' }, agentDispatch: false,
  }]);
  // The full message keeps both blocks, and the stored copy holds a preview instead of raw input.
  assert.equal(hub.of('chat.message')[0].blocks.length, 2);
  assert.equal(store.list('/p/one').at(-1).blocks[1].inputPreview, '{"command":"ls -la"}');
  await sessions.close();
});

test('a subagent dispatch is flagged so the UI can tie it to the live rail', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'delegate');
  sdk.last().outbox.push(assistantText('', {
    message: { id: 'msg_3', role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Task', input: { subagent_type: 'reviewer' } },
    ] },
  }));
  await settled();
  assert.equal(hub.of('chat.tool_use')[0].agentDispatch, true);
  await sessions.close();
});

test('partial text deltas stream, stamped with the message they belong to', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  const { outbox } = sdk.last();
  outbox.push({ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_7' } } });
  outbox.push({ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } } });
  outbox.push({ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'tial' } } });
  // A thinking delta is not chat text and must not be spliced into the answer.
  outbox.push({ type: 'stream_event', session_id: 's', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } });
  await settled();

  assert.deepEqual(hub.of('chat.delta'), [
    { projectPath: '/p/one', ts: 1000, messageId: 'msg_7', parentToolUseId: null, text: 'par' },
    { projectPath: '/p/one', ts: 1000, messageId: 'msg_7', parentToolUseId: null, text: 'tial' },
  ]);
  await sessions.close();
});

test('a result reports cost, usage and duration, is persisted, and returns the session to idle', async () => {
  const { sdk, sessions, hub, store } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.push(resultMessage());
  await settled();

  assert.deepEqual(hub.of('chat.result'), [{
    projectPath: '/p/one', ts: 1000, sessionId: 'sess-1', subtype: 'success', isError: false,
    durationMs: 1234, durationApiMs: 1000, numTurns: 2, totalCostUsd: 0.0421,
    usage: { input_tokens: 10, output_tokens: 20 }, text: 'all done',
  }]);
  assert.equal(store.list('/p/one').at(-1).blocks[0].type, 'result');
  assert.ok(hub.of('chat.status').some((s) => s.state === 'idle'));
  await sessions.close();
});

test('an errored result is reported as an error result, not as a crash', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.push(resultMessage({ subtype: 'error_during_execution', is_error: true, result: undefined }));
  await settled();
  assert.equal(hub.of('chat.result')[0].isError, true);
  assert.equal(hub.of('chat.error').length, 0);
  await sessions.close();
});

test('activity messages surface as status without inventing new event names', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  const { outbox } = sdk.last();
  outbox.push({ type: 'system', subtype: 'task_started', task_id: 't1', description: 'review', subagent_type: 'reviewer' });
  outbox.push({ type: 'system', subtype: 'task_progress', task_id: 't1', description: 'review', usage: { total_tokens: 5, tool_uses: 1, duration_ms: 9 } });
  outbox.push({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', output_file: '/tmp/x' });
  outbox.push({ type: 'tool_progress', tool_use_id: 'toolu_1', tool_name: 'Bash', elapsed_time_seconds: 3, parent_tool_use_id: null });
  outbox.push({ type: 'system', subtype: 'status', status: { message: 'compacting' } });
  await settled();

  const kinds = hub.of('chat.status').filter((s) => s.state === 'activity').map((s) => s.kind);
  assert.deepEqual(kinds, ['task_started', 'task_progress', 'task_notification', 'tool_progress', 'status']);
  await sessions.close();
});

test('rate limits, auth trouble, refusals and out-of-band denials arrive as warnings', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  const { outbox } = sdk.last();
  outbox.push({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.9 } });
  outbox.push({ type: 'auth_status', isAuthenticating: false, error: 'token expired', output: [] });
  outbox.push({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_2' });
  outbox.push({ type: 'system', subtype: 'model_refusal_fallback', original_model: 'a', fallback_model: 'b', direction: 'retry', trigger: 'refusal', request_id: null });
  outbox.push({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'a', request_id: null, content: 'refused' });
  await settled();

  const kinds = hub.of('chat.status').filter((s) => s.state === 'warning').map((s) => s.kind);
  assert.deepEqual(kinds, ['rate_limit_event', 'auth_status', 'permission_denied', 'model_refusal_fallback', 'model_refusal_no_fallback']);
  await sessions.close();
});

test('an unknown message variant is ignored rather than crashing the pump', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.push({ type: 'some_future_message', payload: { deeply: { nested: true } } });
  sdk.last().outbox.push({ type: 'system', subtype: 'a_subtype_from_2027' });
  sdk.last().outbox.push(assistantText('still alive'));
  await settled();
  assert.equal(hub.of('chat.error').length, 0);
  assert.equal(hub.of('chat.message').length, 1);
  await sessions.close();
});

test('a session that throws reports one error and is replaced on the next send', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.fail(new Error('spawn claude ENOENT'));
  await settled();

  const [err] = hub.of('chat.error');
  assert.equal(err.projectPath, '/p/one');
  assert.match(err.detail, /ENOENT/);
  assert.equal(sessions.get('/p/one').running, false);

  await sessions.send('/p/one', 'again');
  assert.equal(sdk.calls.length, 2);
  await sessions.close();
});

test('a failed resume clears the stored id so the next send is not stuck on it', async () => {
  const { sdk, sessions, store, hub } = harness();
  store.setSessionId({ projectPath: '/p/one', sessionId: 'sess-gone', at: 1 });
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.fail(new Error('No conversation found with session ID sess-gone'));
  await settled();
  assert.equal(store.getSession('/p/one'), null);
  assert.match(hub.of('chat.error')[0].message, /could not be resumed/i);
  await sessions.close();
});

test('a session that ends on its own is reported closed and not reused', async () => {
  const { sdk, sessions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  sdk.last().outbox.end();
  await settled();
  assert.ok(hub.of('chat.status').some((s) => s.state === 'closed'));
  assert.equal(sessions.get('/p/one').running, false);
  await sessions.close();
});

test('interrupt stops the session and settles the tool call waiting for approval', async () => {
  const { sdk, sessions, permissions, hub } = harness();
  await sessions.send('/p/one', 'hello');
  const decision = sdk.last().options.canUseTool('Bash', { command: 'sleep 100' }, { signal: new AbortController().signal, toolUseID: 't1' });
  assert.equal(permissions.list('/p/one').length, 1);

  await sessions.interrupt('/p/one');
  assert.equal(sdk.last().interrupts, 1);
  assert.equal((await decision).behavior, 'deny');
  assert.ok(hub.of('chat.status').some((s) => s.state === 'interrupted'));
  await sessions.close();
});

test('interrupting a project that was never started is a no-op, not an error', async () => {
  const { sessions, sdk } = harness();
  await sessions.interrupt('/p/never');
  assert.equal(sdk.calls.length, 0);
  await sessions.close();
});

test('close shuts every session down and closes their input queues', async () => {
  const { sdk, sessions } = harness();
  await sessions.send('/p/one', 'hello');
  await sessions.send('/p/two', 'hello');
  await sessions.close();
  assert.deepEqual(sdk.calls.map((c) => c.closed), [true, true]);
  assert.equal(sessions.get('/p/one').running, false);
});

test('the user prompt is persisted redacted before the session is even started', async () => {
  const { sessions, store } = harness();
  await sessions.send('/p/one', 'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
  const [first] = store.list('/p/one');
  assert.equal(first.role, 'user');
  assert.ok(!first.blocks[0].text.includes('sk-ant-'));
  await sessions.close();
});

test('an empty message is refused before anything is started or stored', async () => {
  const { sessions, sdk, store } = harness();
  await assert.rejects(() => sessions.send('/p/one', '   '), /empty/);
  assert.equal(sdk.calls.length, 0);
  assert.equal(store.list('/p/one').length, 0);
  await sessions.close();
});
