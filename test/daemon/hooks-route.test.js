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
