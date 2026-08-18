// test/core/correlator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planActions, runId, isErrorResponse, extractText } from '../../src/core/correlator.js';

const NOW = 1_700_000_000_000;
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/hooks/${name}.json`, import.meta.url)));

const pre = {
  hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/proj', transcript_path: '/t.jsonl',
  tool_name: 'Task', tool_use_id: 'tu_1',
  tool_input: { subagent_type: 'programmer', description: 'add auth', prompt: 'do the thing' },
};

test('every event touches its session', () => {
  const [a] = planActions({ hook_event_name: 'Notification', session_id: 's1', cwd: '/proj' }, { now: NOW });
  assert.deepEqual(a, { type: 'session.touch', session: { id: 's1', projectPath: '/proj', source: 'terminal', at: NOW } });
});

test('PreToolUse[Task] opens a run keyed by session and tool_use_id', () => {
  const actions = planActions(pre, { now: NOW });
  const open = actions.find((a) => a.type === 'run.open');
  assert.deepEqual(open.run, {
    id: 's1:tu_1', sessionId: 's1', agentType: 'programmer',
    description: 'add auth', prompt: 'do the thing', startedAt: NOW,
  });
});

test('PreToolUse for a non-Task tool opens nothing', () => {
  const actions = planActions({ ...pre, tool_name: 'Bash', tool_input: { command: 'ls' } }, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.open'), false);
});

test('PostToolUse[Task] closes the same id', () => {
  const evt = { ...pre, hook_event_name: 'PostToolUse', tool_response: 'all good', duration_ms: 4321 };
  const close = planActions(evt, { now: NOW }).find((a) => a.type === 'run.close');
  assert.deepEqual(close.close, {
    id: 's1:tu_1', status: 'done', endedAt: NOW, durationMs: 4321, resultPreview: 'all good',
  });
});

test('an error tool_response closes the run as error', () => {
  const evt = { ...pre, hook_event_name: 'PostToolUse', tool_response: { is_error: true, content: 'boom' } };
  const close = planActions(evt, { now: NOW }).find((a) => a.type === 'run.close');
  assert.equal(close.close.status, 'error');
});

test('a string response starting with Error is also an error', () => {
  assert.equal(isErrorResponse('Error: exceeded'), true);
  assert.equal(isErrorResponse('errors were fixed'), false);
});

test('extractText understands the content-block response shape', () => {
  assert.equal(extractText({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }), 'hello\nworld');
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText(undefined), '');
});

test('result previews are redacted and capped', () => {
  const evt = { ...pre, hook_event_name: 'PostToolUse', tool_response: `token ghp_${'a'.repeat(36)}` };
  const close = planActions(evt, { now: NOW }).find((a) => a.type === 'run.close');
  assert.ok(!close.close.resultPreview.includes('ghp_'));
});

test('SubagentStop produces a heuristic enrich, never an open or close', () => {
  const evt = {
    hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/proj',
    agent_id: 'ag_9', agent_type: 'programmer', agent_transcript_path: '/agent.jsonl',
    last_assistant_message: 'finished', stop_hook_active: false,
  };
  const actions = planActions(evt, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.open' || a.type === 'run.close'), false);
  const enrich = actions.find((a) => a.type === 'run.enrich');
  assert.deepEqual(enrich.match, { sessionId: 's1', agentType: 'programmer' });
  assert.equal(enrich.patch.transcriptPath, '/agent.jsonl');
});

test('SubagentStop without an agent_type enriches nothing', () => {
  const evt = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/p', agent_id: 'ag_9', agent_transcript_path: '/a' };
  assert.equal(planActions(evt, { now: NOW }).some((a) => a.type === 'run.enrich'), false);
});

test('SessionEnd ends the session', () => {
  const actions = planActions({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/p' }, { now: NOW });
  assert.deepEqual(actions.at(-1), { type: 'session.end', sessionId: 's1', at: NOW });
});

test('an event without a session_id yields no actions', () => {
  assert.deepEqual(planActions({ hook_event_name: 'PreToolUse' }, { now: NOW }), []);
  assert.deepEqual(planActions(null, { now: NOW }), []);
});

test('real captured fixtures produce the expected action types', () => {
  assert.ok(planActions(fixture('pre-tool-use-task'), { now: NOW }).some((a) => a.type === 'run.open'));
  assert.ok(planActions(fixture('post-tool-use-task'), { now: NOW }).some((a) => a.type === 'run.close'));
});

test('the fixture pair correlates to one id', () => {
  const open = planActions(fixture('pre-tool-use-task'), { now: NOW }).find((a) => a.type === 'run.open');
  const close = planActions(fixture('post-tool-use-task'), { now: NOW }).find((a) => a.type === 'run.close');
  assert.equal(open.run.id, close.close.id);
});
