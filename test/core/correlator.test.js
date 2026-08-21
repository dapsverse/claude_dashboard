// test/core/correlator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planActions, runId, isErrorResponse, extractText, isAgentDispatch } from '../../src/core/correlator.js';

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
    id: 's1:tu_1', status: 'done', endedAt: NOW, durationMs: 4321, resultPreview: 'all good', agentId: null,
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

// A background dispatch returns the moment the agent is launched: the tool response says so, and
// the hook fires ~10ms after PreToolUse. Closing on it is what rendered a subagent that was still
// working as "done" in 0s, and dropped it out of listActive().
test('PostToolUse for an async dispatch launches the run instead of closing it', () => {
  const evt = {
    ...pre,
    hook_event_name: 'PostToolUse',
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'ag_7', description: 'add auth' },
    duration_ms: 9,
  };
  const actions = planActions(evt, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.close'), false);
  const launch = actions.find((a) => a.type === 'run.launch');
  assert.deepEqual(launch, { type: 'run.launch', id: 's1:tu_1', agentId: 'ag_7' });
});

test('an async launch without an agentId still refuses to close the run', () => {
  const evt = { ...pre, hook_event_name: 'PostToolUse', tool_response: { status: 'async_launched' }, duration_ms: 9 };
  const actions = planActions(evt, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.close'), false);
  assert.equal(actions.find((a) => a.type === 'run.launch').agentId, null);
});

test('a foreground dispatch still closes on PostToolUse, carrying the agent id it reports', () => {
  const evt = {
    ...pre,
    hook_event_name: 'PostToolUse',
    tool_response: { status: 'completed', agentId: 'ag_7', content: [{ type: 'text', text: 'hello' }] },
    duration_ms: 2027,
  };
  const close = planActions(evt, { now: NOW }).find((a) => a.type === 'run.close');
  assert.equal(close.close.status, 'done');
  assert.equal(close.close.agentId, 'ag_7');
  assert.equal(close.close.resultPreview, 'hello');
});

test('the real async fixture launches rather than closes', () => {
  const actions = planActions(fixture('post-tool-use-task-async'), { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.close'), false);
  const launch = actions.find((a) => a.type === 'run.launch');
  assert.equal(launch.agentId, 'a901f1f5a347036f4');
  assert.equal(launch.id, runId('e4c28e67-99d2-431f-bb70-e6172b8c31f2', 'toolu_01WTQs8ynPa4PA2s2S8PmajR'));
});

test('SubagentStop finishes the run it names, by agent id and by heuristic', () => {
  const evt = {
    hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/proj',
    agent_id: 'ag_9', agent_type: 'programmer', agent_transcript_path: '/agent.jsonl',
    last_assistant_message: 'finished', stop_hook_active: false,
  };
  const actions = planActions(evt, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.open' || a.type === 'run.close'), false);
  const finish = actions.find((a) => a.type === 'run.finish');
  // The agent id is the exact key an async launch recorded; agent_type is the fallback for a build
  // that reports no id, and for the foreground runs PostToolUse has already closed.
  assert.deepEqual(finish.match, { agentId: 'ag_9', sessionId: 's1', agentType: 'programmer' });
  assert.equal(finish.patch.transcriptPath, '/agent.jsonl');
  assert.equal(finish.patch.endedAt, NOW);
});

test('SubagentStop with an agent id but no agent_type is still enough to finish a run', () => {
  const evt = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/p', agent_id: 'ag_9', agent_transcript_path: '/a' };
  const finish = planActions(evt, { now: NOW }).find((a) => a.type === 'run.finish');
  assert.deepEqual(finish.match, { agentId: 'ag_9', sessionId: 's1', agentType: null });
});

test('SubagentStop naming neither an agent id nor a type matches nothing', () => {
  const evt = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/p' };
  assert.equal(planActions(evt, { now: NOW }).some((a) => a.type === 'run.finish'), false);
});

test('the real SubagentStop fixture carries its agent id', () => {
  const finish = planActions(fixture('subagent-stop'), { now: NOW }).find((a) => a.type === 'run.finish');
  assert.equal(finish.match.agentId, 'ab64803ae3b64584a');
  assert.equal(finish.patch.resultPreview, 'hello');
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

test('the dispatch tool is recognised under both of its names', () => {
  assert.equal(isAgentDispatch('Agent'), true);
  assert.equal(isAgentDispatch('Task'), true);
  assert.equal(isAgentDispatch('Bash'), false);
  assert.equal(isAgentDispatch(undefined), false);
});

test('a Task-named dispatch still opens a run', () => {
  const actions = planActions({ ...pre, tool_name: 'Task' }, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.open'), true);
});

test('the fixture pair correlates to one id', () => {
  const open = planActions(fixture('pre-tool-use-task'), { now: NOW }).find((a) => a.type === 'run.open');
  const close = planActions(fixture('post-tool-use-task'), { now: NOW }).find((a) => a.type === 'run.close');
  assert.equal(open.run.id, close.close.id);
});
