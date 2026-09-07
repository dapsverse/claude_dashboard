// test/daemon/sweeper.test.js
//
// The dead-run sweeper is the missing half of a bug the owner hit three times: a subagent stopped
// mid-session kept its desk in the office scene forever, because the activity feed knew it had
// stopped while `runs.status` still said 'running'. These tests hold the two properties that make
// the fix worth having — a dead agent leaves, a healthy long-lived one does not — and the second is
// the one that a naive age-based sweeper fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { createSessionsRepo } from '../../src/store/sessions.js';
import { createChatRepo } from '../../src/store/chat.js';
import { createHub } from '../../src/daemon/sse.js';
import { createServer } from '../../src/daemon/server.js';
import { hooksRoute } from '../../src/daemon/routes/hooks.js';
import { createSessionManager } from '../../src/chat/session.js';
import { createPermissionGate } from '../../src/chat/permissions.js';
import { createFakeSdk, initMessage } from '../chat/fake-sdk.js';
import { sweepDeadRuns, RUN_SILENCE_TIMEOUT_MS, LIVENESS_SWEEP_INTERVAL_MS } from '../../src/daemon/sweepers.js';

const MINUTE = 60 * 1000;
const T0 = 1_700_000_000_000;

let clock = T0;
const now = () => clock;

function setup({ silenceMs = RUN_SILENCE_TIMEOUT_MS } = {}) {
  clock = T0;
  const dir = mkdtempSync(join(tmpdir(), 'ap-sweep-'));
  const db = openDb(join(dir, 'data.db'));
  const runs = createRunsRepo(db);
  const sessions = createSessionsRepo(db);
  const hub = createHub();
  const frames = [];
  hub.add({ write: (c) => frames.push(c), end() {}, on() {}, writeHead() {}, flushHeaders() {} });
  const closes = () => frames.filter((f) => f.startsWith('event: run.close'));
  // Built at T0 so the boot floor never masks a silence the test set up on purpose.
  const sweeper = sweepDeadRuns({ runs, sessions, hub, now, silenceMs });
  return { db, dir, runs, sessions, hub, frames, closes, sweeper };
}

const openRun = (runs, sessions, { id, sessionId = 'sess-1', at = clock }) => {
  sessions.touch({ id: sessionId, projectPath: '/p', at });
  runs.open({ id, sessionId, agentType: 'engineer', description: 'writing code', startedAt: at });
};

// The test that rejects the previous attempt at this feature. That one closed any run older than
// five minutes, which in this repo means closing the agent that is doing the work. Age is not
// liveness: the only thing that matters is when the session was last heard from.
test('a healthy agent twenty minutes old is left alone while it is still reporting', () => {
  const { runs, sessions, sweeper, closes } = setup();
  openRun(runs, sessions, { id: 'sess-1:toolu_alive' });

  clock = T0 + 20 * MINUTE - 5000;
  sweeper.noteActivity({ sessionId: 'sess-1', kind: 'task_progress', data: { toolUseId: 'toolu_alive' } });

  clock = T0 + 20 * MINUTE;
  assert.deepEqual(sweeper.sweep(clock), []);
  assert.equal(runs.get('sess-1:toolu_alive').status, 'running');
  assert.equal(closes().length, 0);
});

test('a run whose session has said nothing for the silence window is closed and broadcast once', () => {
  const { runs, sessions, sweeper, closes } = setup();
  openRun(runs, sessions, { id: 'sess-1:toolu_ghost' });

  clock = T0 + 10 * MINUTE;
  assert.deepEqual(sweeper.sweep(clock), ['sess-1:toolu_ghost']);

  const run = runs.get('sess-1:toolu_ghost');
  assert.notEqual(run.status, 'running');
  assert.equal(run.status, 'done');
  assert.equal(run.resultPreview, 'interrupted');
  assert.equal(run.endedAt, clock);
  assert.equal(closes().length, 1);
  assert.ok(closes()[0].includes('sess-1:toolu_ghost'));
});

test('two sweeps in a row close the run once and broadcast once', () => {
  const { runs, sweeper, sessions, closes } = setup();
  openRun(runs, sessions, { id: 'sess-1:toolu_ghost' });

  clock = T0 + 10 * MINUTE;
  assert.deepEqual(sweeper.sweep(clock), ['sess-1:toolu_ghost']);
  // The second cycle sees a run that is no longer active at all; endRun would refuse it either way.
  assert.deepEqual(sweeper.sweep(clock + LIVENESS_SWEEP_INTERVAL_MS), []);
  assert.equal(closes().length, 1);
});

// The reported bug, in one test: the user stops a subagent, the SDK says so, and the run must not
// wait out the silence window — let alone the 30-minute stale window — to leave the office.
test('an SDK task_notification of a stop closes the run on the next sweep, however young it is', () => {
  const { runs, sessions, sweeper, closes } = setup();
  openRun(runs, sessions, { id: 'sess-1:toolu_stopped' });

  clock = T0 + 30 * 1000;
  sweeper.noteActivity({
    sessionId: 'sess-1',
    kind: 'task_notification',
    data: { taskId: 'task-1', toolUseId: 'toolu_stopped', status: 'stopped' },
  });

  assert.deepEqual(sweeper.sweep(clock), ['sess-1:toolu_stopped']);
  assert.equal(runs.get('sess-1:toolu_stopped').status, 'done');
  assert.equal(runs.get('sess-1:toolu_stopped').resultPreview, 'interrupted');
  assert.equal(closes().length, 1);
});

test('a task that merely finished is left for the hook that carries its real result', () => {
  const { runs, sessions, sweeper, closes } = setup();
  openRun(runs, sessions, { id: 'sess-1:toolu_done' });

  clock = T0 + 30 * 1000;
  sweeper.noteActivity({
    sessionId: 'sess-1', kind: 'task_notification',
    data: { toolUseId: 'toolu_done', status: 'completed' },
  });

  assert.deepEqual(sweeper.sweep(clock), []);
  assert.equal(runs.get('sess-1:toolu_done').status, 'running');
  assert.equal(closes().length, 0);
});

test('a stop reported before the row exists still closes it once the row arrives', () => {
  const { runs, sessions, sweeper } = setup();
  // PostToolUse can beat PreToolUse to the daemon, so the notification can beat the row.
  sweeper.noteActivity({
    sessionId: 'sess-1', kind: 'task_notification',
    data: { toolUseId: 'toolu_racy', status: 'cancelled' },
  });
  assert.deepEqual(sweeper.sweep(clock), []);

  openRun(runs, sessions, { id: 'sess-1:toolu_racy' });
  assert.deepEqual(sweeper.sweep(clock), ['sess-1:toolu_racy']);
});

test('a session that declared itself ended takes its open runs with it', () => {
  const { runs, sessions, sweeper, closes } = setup();
  openRun(runs, sessions, { id: 'sess-1:toolu_orphan' });
  sessions.end('sess-1', clock);

  assert.deepEqual(sweeper.sweep(clock), ['sess-1:toolu_orphan']);
  assert.equal(runs.get('sess-1:toolu_orphan').resultPreview, 'session_ended');
  assert.equal(closes().length, 1);
});

// A restart wipes the in-memory heartbeats. Judging the runs that were already open against an
// empty map would close every one of them on the first tick.
test('runs already open when the daemon starts are not swept on the first tick', () => {
  clock = T0;
  const dir = mkdtempSync(join(tmpdir(), 'ap-sweep-boot-'));
  const db = openDb(join(dir, 'data.db'));
  const runs = createRunsRepo(db);
  const sessions = createSessionsRepo(db);
  const hub = createHub();
  openRun(runs, sessions, { id: 'sess-1:toolu_survivor' });

  // The daemon comes back an hour later; the run and its last hook are both ancient.
  clock = T0 + 60 * MINUTE;
  const sweeper = sweepDeadRuns({ runs, sessions, hub, now });
  assert.deepEqual(sweeper.sweep(clock), []);

  // ...and the grace lasts exactly one silence window, not forever.
  assert.deepEqual(sweeper.sweep(clock + RUN_SILENCE_TIMEOUT_MS + 1), ['sess-1:toolu_survivor']);
});

test('start schedules an unref\'d interval and stop clears it', () => {
  const { sweeper } = setup();
  const handle = sweeper.start();
  assert.ok(handle);
  assert.equal(handle.hasRef(), false, 'the timer must never hold the process open on its own');
  // Idempotent: a second start must not strand the first interval.
  assert.equal(sweeper.start(), handle);
  sweeper.stop();
  sweeper.stop();                       // and stopping twice is not an error
});

test('the sweep interval is short enough to be noticed, and far shorter than the stale window', () => {
  assert.ok(LIVENESS_SWEEP_INTERVAL_MS >= 10_000 && LIVENESS_SWEEP_INTERVAL_MS <= 30_000);
  assert.ok(RUN_SILENCE_TIMEOUT_MS < 30 * MINUTE);
});

// End to end over the wire: the run is opened by a real hook request against the real route, and
// closed by the sweeper, with the browser's SSE stream watching.
test('a run opened by a hook and then abandoned is closed by the sweeper and announced on the stream', async () => {
  const { runs, sessions, hub, closes, sweeper } = setup();
  const TOKEN = 'd'.repeat(64);
  const server = createServer({
    token: TOKEN, port: 0, hub, routes: [hooksRoute({ runs, sessions, hub, now })],
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/hooks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-wire',
      tool_name: 'Task',
      tool_use_id: 'toolu_wire',
      cwd: '/p',
      tool_input: { subagent_type: 'engineer', description: 'writing code', prompt: 'go' },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(runs.get('sess-wire:toolu_wire').status, 'running');

  // Nothing more is ever heard from that session: its process was killed.
  clock = T0 + 10 * MINUTE;
  assert.deepEqual(sweeper.sweep(clock), ['sess-wire:toolu_wire']);
  assert.notEqual(runs.get('sess-wire:toolu_wire').status, 'running');
  assert.equal(closes().length, 1);

  const payload = JSON.parse(closes()[0].split('\ndata: ')[1]);
  assert.equal(payload.id, 'sess-wire:toolu_wire');
  assert.equal(payload.status, 'done');

  await new Promise((r) => server.close(r));
});

// The wire the whole feature hangs on: the session manager has to actually report the stop, and the
// daemon has to actually be listening. Two attempts at this feature ended with a sweeper nobody
// called; this asserts the connection, not the pieces.
test('the session manager reports a stopped task into the sweeper, which closes the run', async () => {
  const { runs, sessions, hub, sweeper, closes } = setup();
  const chatDir = mkdtempSync(join(tmpdir(), 'ap-sweep-chat-'));
  const chat = createChatRepo(openDb(join(chatDir, 'chat.db')));
  const sdk = createFakeSdk();
  const permissions = createPermissionGate({ hub, now });
  const chatSessions = createSessionManager({
    store: chat, hub, now, sdk, permissions,
    onActivity: (message) => sweeper.noteActivity(message),
  });

  await chatSessions.send('/p', 'dispatch an agent');
  sdk.last().outbox.push(initMessage('sess-sdk'));
  await new Promise((r) => setTimeout(r, 5));

  openRun(runs, sessions, { id: 'sess-sdk:toolu_sdk', sessionId: 'sess-sdk' });

  sdk.last().outbox.push({
    type: 'system', subtype: 'task_notification', session_id: 'sess-sdk',
    task_id: 'task-9', tool_use_id: 'toolu_sdk', status: 'stopped', summary: 'stopped',
  });
  await new Promise((r) => setTimeout(r, 5));

  assert.deepEqual(sweeper.sweep(clock), ['sess-sdk:toolu_sdk']);
  assert.equal(runs.get('sess-sdk:toolu_sdk').status, 'done');
  assert.equal(closes().length, 1);

  await chatSessions.close();
});
