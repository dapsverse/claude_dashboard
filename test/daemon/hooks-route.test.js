// test/daemon/hooks-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { createSessionsRepo } from '../../src/store/sessions.js';
import { createHub } from '../../src/daemon/sse.js';
import { createServer } from '../../src/daemon/server.js';
import { hooksRoute, runsRoute } from '../../src/daemon/routes/hooks.js';
import { startSweeper } from '../../src/core/sweeper.js';

const TOKEN = 'd'.repeat(64);
let clock = 1_000_000;
const now = () => clock;

async function boot() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ap-h-')), 'data.db'));
  const runs = createRunsRepo(db);
  const sessions = createSessionsRepo(db);
  const hub = createHub();
  const events = [];
  hub.add({ write: (c) => events.push(c), end() {}, on() {}, writeHead() {}, flushHeaders() {} });
  const server = createServer({ token: TOKEN, port: 0, hub,
    routes: [hooksRoute({ runs, sessions, hub, now }), runsRoute({ runs })] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/hooks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { server, runs, sessions, post, base, events };
}

const pre = {
  hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/proj',
  tool_name: 'Agent', tool_use_id: 'tu_1',
  tool_input: { subagent_type: 'qa', description: 'write tests', prompt: 'p' },
};

// End to end over the wire, because this is the bug the dashboard actually showed: a background
// agent launched, reported as done in 0s, and gone from the live list while it was still working.
test('a background dispatch stays running until its SubagentStop arrives', async () => {
  const { server, runs, post, events } = await boot();
  await post(pre);
  await post({
    ...pre,
    hook_event_name: 'PostToolUse',
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'ag_7' },
    duration_ms: 9,
  });
  assert.equal(runs.listActive().length, 1, 'the launch must not close the run');
  assert.equal(runs.get('s1:tu_1').agentId, 'ag_7');

  clock += 90_000;
  await post({
    hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/proj',
    agent_id: 'ag_7', agent_type: 'qa',
    agent_transcript_path: '/agent.jsonl', last_assistant_message: 'tests written',
  });
  const row = runs.get('s1:tu_1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 90_000);
  assert.equal(row.resultPreview, 'tests written');
  assert.equal(row.transcriptPath, '/agent.jsonl');
  assert.match(events.join(''), /event: run\.close/);
  server.close();
});

test('a foreground dispatch is still closed by its own PostToolUse', async () => {
  const { server, runs, post } = await boot();
  await post(pre);
  await post({
    hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/proj',
    agent_id: 'ag_9', agent_type: 'qa', agent_transcript_path: '/agent.jsonl', last_assistant_message: 'partial',
  });
  assert.equal(runs.get('s1:tu_1').status, 'running', 'SubagentStop must not close a foreground run');
  assert.equal(runs.get('s1:tu_1').transcriptPath, '/agent.jsonl');
  await post({
    ...pre, hook_event_name: 'PostToolUse',
    tool_response: { status: 'completed', agentId: 'ag_9', content: [{ type: 'text', text: 'all done' }] },
    duration_ms: 2027,
  });
  const row = runs.get('s1:tu_1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 2027);
  assert.equal(row.resultPreview, 'all done');
  server.close();
});

test('a PreToolUse[Agent] post creates a running row and broadcasts it', async () => {
  const { server, runs, post, events } = await boot();
  const res = await post(pre);
  assert.equal(res.status, 200);
  assert.equal(runs.listActive().length, 1);
  assert.match(events.join(''), /event: run\.open/);
  server.close();
});

test('the matching PostToolUse closes it', async () => {
  const { server, runs, post } = await boot();
  await post(pre);
  clock += 5000;
  await post({ ...pre, hook_event_name: 'PostToolUse', tool_response: 'done' });
  assert.equal(runs.listActive().length, 0);
  assert.equal(runs.get('s1:tu_1').status, 'done');
  server.close();
});

test('malformed json is rejected without touching the store', async () => {
  const { server, runs, post } = await boot();
  const res = await post('{not json');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_json' });
  assert.equal(runs.listRecent().length, 0);
  server.close();
});

test('an oversized body is rejected', async () => {
  const { server, post } = await boot();
  const res = await post({ ...pre, tool_input: { ...pre.tool_input, prompt: 'x'.repeat(300_000) } });
  assert.equal(res.status, 413);
  server.close();
});

test('an unknown event is accepted but changes no runs', async () => {
  const { server, runs, post } = await boot();
  const res = await post({ hook_event_name: 'Notification', session_id: 's9', cwd: '/p' });
  assert.equal(res.status, 200);
  assert.equal(runs.listRecent().length, 0);
  server.close();
});

test('the ingest route requires a token', async () => {
  const { server, base } = await boot();
  const res = await fetch(`${base}/api/hooks`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  server.close();
});

test('SessionEnd stales that session\'s open runs', async () => {
  const { server, runs, post } = await boot();
  await post(pre);
  await post({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/proj' });
  assert.equal(runs.get('s1:tu_1').status, 'stale');
  server.close();
});

test('GET /api/runs returns active and recent', async () => {
  const { server, post, base } = await boot();
  await post(pre);
  const res = await fetch(`${base}/api/runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  assert.equal(body.active.length, 1);
  assert.equal(body.active[0].agentType, 'qa');
  server.close();
});

test('a wrong-typed field is refused without taking the daemon down', async () => {
  const { server, post } = await boot();
  const res = await post({ hook_event_name: 'Notification', session_id: 's1', cwd: {} });
  assert.equal(res.status, 500);
  assert.deepEqual(Object.keys(await res.json()).sort(), ['detail', 'error']);
  const still = await post({ ...pre });
  assert.equal(still.status, 200, 'the daemon is still serving after the bad payload');
  server.close();
});

test('the sweeper stales an abandoned run and broadcasts it', async () => {
  const { server, runs, post, events } = await boot();
  await post(pre);
  clock += 31 * 60 * 1000;
  const stop = startSweeper({ runs, hub: { broadcast: (e, d) => events.push(`event: ${e}\n`) }, now, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(runs.get('s1:tu_1').status, 'stale');
  server.close();
});

test('SessionEnd broadcasts a run.close carrying the staled run, not only a sessionId', async () => {
  // The dashboard keys every row by run id and ignores a payload without one, so a bare
  // {sessionId} left a phantom agent in the rail with a ticking clock until the page reloaded.
  const { server, post, events } = await boot();
  await post(pre);
  events.length = 0;
  clock += 4000;
  await post({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/proj' });

  const frames = events.join('');
  assert.match(frames, /event: run\.close/);
  const payload = JSON.parse(/event: run\.close\ndata: (.*)\n/.exec(frames)[1]);
  assert.equal(payload.id, 's1:tu_1');
  assert.equal(payload.status, 'stale');
  assert.equal(payload.durationMs, 4000, 'a staled run must not render as 0s');
  assert.match(frames, /event: session\.end/);
  server.close();
});

test('a genuine PostToolUse after a stale still records the real result', async () => {
  // A run longer than the 30-minute stale window is the core case for this product: the sweeper
  // marks it stale while it is very much alive, and the real completion must overwrite that guess.
  const { server, runs, post, events } = await boot();
  await post(pre);
  clock += 31 * 60 * 1000;
  const stop = startSweeper({ runs, hub: { broadcast: () => {} }, now, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(runs.get('s1:tu_1').status, 'stale');

  events.length = 0;
  clock += 1000;
  const res = await post({ ...pre, hook_event_name: 'PostToolUse', tool_response: 'all done', duration_ms: 1_861_000 });
  assert.equal(res.status, 200);

  const row = runs.get('s1:tu_1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 1_861_000);
  assert.equal(row.resultPreview, 'all done');
  assert.match(events.join(''), /event: run\.close/, 'the recovery is reported to the dashboard');
  server.close();
});
