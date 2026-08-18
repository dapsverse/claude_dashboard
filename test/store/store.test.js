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
