// test/store/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { createSessionsRepo } from '../../src/store/sessions.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'ap-db-')), 'nested', 'data.db'));
const baseRun = { id: 's1:t1', sessionId: 's1', agentType: 'programmer', description: 'do a thing', prompt: 'p', startedAt: 1000 };

test('database file is created 0600', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ap-db-')), 'data.db');
  openDb(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('open then close produces a completed run with a duration', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3500, resultPreview: 'ok' });
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 2500);
  assert.equal(row.resultPreview, 'ok');
});

test('close honours an explicitly supplied durationMs', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3500, durationMs: 99, resultPreview: 'ok' });
  assert.equal(runs.get('s1:t1').durationMs, 99);
});

test('open is idempotent — a replayed hook does not duplicate or reset the row', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.open({ ...baseRun, startedAt: 9999, description: 'changed' });
  assert.equal(runs.listActive().length, 1);
  assert.equal(runs.get('s1:t1').startedAt, 1000);
});

test('closing an unknown id is a silent no-op', () => {
  const runs = createRunsRepo(fresh());
  assert.equal(runs.close({ id: 'ghost', status: 'done', endedAt: 1 }), false);
  assert.equal(runs.get('ghost'), null);
});

test('a replayed close reports no transition and does not alter the row', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.close({ id: 's1:t1', status: 'done', endedAt: 3000, resultPreview: 'ok' }), true);
  assert.equal(runs.close({ id: 's1:t1', status: 'error', endedAt: 9999, resultPreview: 'CHANGED' }), false);
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.endedAt, 3000);
  assert.equal(row.resultPreview, 'ok');
});

test('a backwards clock cannot store a negative duration', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'back', startedAt: 5000 });
  runs.close({ id: 'back', status: 'done', endedAt: 1000 });
  assert.equal(runs.get('back').durationMs, 0);
});

test('listActive returns only running rows, newest first', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'a', startedAt: 1 });
  runs.open({ ...baseRun, id: 'b', startedAt: 2 });
  runs.close({ id: 'a', status: 'done', endedAt: 5 });
  assert.deepEqual(runs.listActive().map((r) => r.id), ['b']);
});

test('markStaleBefore only touches running rows older than the cutoff', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'old', startedAt: 1 });
  runs.open({ ...baseRun, id: 'new', startedAt: 10_000 });
  runs.markStaleBefore(5000, 20_000);
  assert.equal(runs.get('old').status, 'stale');
  assert.equal(runs.get('new').status, 'running');
});

test('endSessionRuns marks that session\'s open runs stale and leaves others alone', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'mine', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'other', sessionId: 's2' });
  runs.endSessionRuns('s1', 7000);
  assert.equal(runs.get('mine').status, 'stale');
  assert.equal(runs.get('other').status, 'running');
});

test('enrich attaches transcript data to the oldest matching open run', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'first', startedAt: 1 });
  runs.open({ ...baseRun, id: 'second', startedAt: 2 });
  const hit = runs.enrich({ sessionId: 's1', agentType: 'programmer' }, { transcriptPath: '/t.jsonl' });
  assert.equal(hit, 'first');
  assert.equal(runs.get('first').transcriptPath, '/t.jsonl');
  assert.equal(runs.get('second').transcriptPath, null);
});

test('enrich returns null when nothing matches, rather than guessing', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.enrich({ sessionId: 's1', agentType: 'qa' }, { transcriptPath: '/t' }), null);
});

// A background dispatch reports its agent id at launch and keeps running. Recording the id without
// closing the row is the whole fix for a subagent that rendered as done in 0s.
test('launch records the agent id and leaves the run running', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.launch({ id: 's1:t1', agentId: 'ag_7' }), true);
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'running');
  assert.equal(row.agentId, 'ag_7');
});

test('launch refuses a run that is already finished', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 2000 });
  assert.equal(runs.launch({ id: 's1:t1', agentId: 'ag_7' }), false);
  assert.equal(runs.get('s1:t1').agentId, null);
});

test('finish closes the launched run its agent id names, with a real duration', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.launch({ id: 's1:t1', agentId: 'ag_7' });
  const outcome = runs.finish(
    { agentId: 'ag_7', sessionId: 's1', agentType: 'programmer' },
    { endedAt: 61_000, transcriptPath: '/a.jsonl', resultPreview: 'done here' },
  );
  assert.deepEqual(outcome, { id: 's1:t1', closed: true });
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 60_000);
  assert.equal(row.transcriptPath, '/a.jsonl');
  assert.equal(row.resultPreview, 'done here');
});

// The foreground path still closes through PostToolUse, which reports the tool's own duration and
// its full response. SubagentStop arrives first and must only fill in the transcript.
test('finish only enriches when no launched run matches the agent id', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  const outcome = runs.finish(
    { agentId: 'ag_unknown', sessionId: 's1', agentType: 'programmer' },
    { endedAt: 61_000, transcriptPath: '/a.jsonl', resultPreview: 'partial' },
  );
  assert.deepEqual(outcome, { id: 's1:t1', closed: false });
  assert.equal(runs.get('s1:t1').status, 'running');
  assert.equal(runs.get('s1:t1').transcriptPath, '/a.jsonl');
});

// Otherwise one foreground agent's transcript would land on a background run of the same type that
// is still working, and the exact id it was launched with would be contradicted by a guess.
test('the heuristic never touches a run that was launched with an agent id', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.launch({ id: 's1:t1', agentId: 'ag_7' });
  const outcome = runs.finish(
    { agentId: 'ag_other', sessionId: 's1', agentType: 'programmer' },
    { endedAt: 61_000, transcriptPath: '/other.jsonl', resultPreview: 'not mine' },
  );
  assert.equal(outcome, null);
  assert.equal(runs.get('s1:t1').transcriptPath, null);
});

test('finish reports nothing when neither the id nor the type matches', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.finish({ agentId: null, sessionId: 's1', agentType: 'qa' }, { endedAt: 2000 }), null);
});

test('close records the agent id a foreground response reports', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3000, agentId: 'ag_7' });
  assert.equal(runs.get('s1:t1').agentId, 'ag_7');
});

test('pruneBefore deletes finished rows older than the cutoff and keeps running ones', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'old' });
  runs.close({ id: 'old', status: 'done', endedAt: 100 });
  runs.open({ ...baseRun, id: 'live', startedAt: 100 });
  runs.pruneBefore(1000);
  assert.equal(runs.get('old'), null);
  assert.ok(runs.get('live'));
});

test('sessions touch upserts and preserves the original startedAt', () => {
  const s = createSessionsRepo(fresh());
  s.touch({ id: 'x', projectPath: '/p', source: 'terminal', at: 10 });
  s.touch({ id: 'x', projectPath: '/p', source: 'terminal', at: 20 });
  assert.equal(s.get('x').startedAt, 10);
  assert.equal(s.get('x').lastEventAt, 20);
  s.end('x', 30);
  assert.equal(s.get('x').status, 'ended');
});

test('staling records a duration so the row does not render as 0s', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'swept', startedAt: 1000 });
  runs.markStaleBefore(5000, 20_000);
  assert.equal(runs.get('swept').durationMs, 19_000);

  runs.open({ ...baseRun, id: 'ended', sessionId: 's9', startedAt: 2000 });
  runs.endSessionRuns('s9', 8000);
  assert.equal(runs.get('ended').durationMs, 6000);
});

test('endSessionRuns returns the ids it staled so the caller can broadcast each one', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'a', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'b', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'c', sessionId: 's2' });
  assert.deepEqual(runs.endSessionRuns('s1', 7000).sort(), ['a', 'b']);
  assert.deepEqual(runs.endSessionRuns('s1', 8000), [], 'nothing left open to report a second time');
});

test('a genuine completion recovers a staled run rather than being discarded', () => {
  // A run longer than the 30-minute sweeper window is marked stale while still alive. Its real
  // PostToolUse must be allowed to overwrite that guess, or the run is recorded as abandoned
  // forever with no duration and no result.
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'long', startedAt: 0 });
  runs.markStaleBefore(1000, 1_860_000);
  assert.equal(runs.get('long').status, 'stale');

  assert.equal(runs.close({ id: 'long', status: 'done', endedAt: 1_861_000, resultPreview: 'shipped' }), true);
  const row = runs.get('long');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 1_861_000);
  assert.equal(row.resultPreview, 'shipped');
});

test('a finished run is still immune to a later close', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'done-once' });
  runs.close({ id: 'done-once', status: 'done', endedAt: 2000, resultPreview: 'ok' });
  assert.equal(runs.close({ id: 'done-once', status: 'error', endedAt: 9000, resultPreview: 'no' }), false);
  assert.equal(runs.get('done-once').resultPreview, 'ok');
});
