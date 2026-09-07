import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { createSessionsRepo } from '../../src/store/sessions.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'ap-run-end-')), 'data.db'));
const baseRun = { id: 's1:t1', sessionId: 's1', agentType: 'programmer', startedAt: 1000 };

test('endRun stops a running agent mid-session without ending its siblings or session', () => {
  const db = fresh();
  const runs = createRunsRepo(db);
  const sessions = createSessionsRepo(db);
  sessions.touch({ id: 's1', projectPath: '/proj', source: 'terminal', at: 1000 });
  runs.open(baseRun);
  runs.launch({ id: baseRun.id, agentId: 'ag_7' });
  runs.open({ ...baseRun, id: 's1:t2' });
  const sibling = runs.get('s1:t2');
  const session = sessions.get('s1');

  assert.equal(runs.endRun(baseRun.id, 3500, 'interrupted'), true);
  const row = runs.get(baseRun.id);
  assert.equal(row.status, 'done');
  assert.equal(row.endedAt, 3500);
  assert.equal(row.durationMs, 2500);
  assert.equal(row.resultPreview, 'interrupted');
  assert.equal(row.agentId, 'ag_7');
  assert.deepEqual(runs.get('s1:t2'), sibling);
  assert.deepEqual(sessions.get('s1'), session);
});

test('endRun is idempotent and preserves the first ending', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.endRun(baseRun.id, 3500, 'interrupted'), true);
  const ended = runs.get(baseRun.id);

  assert.equal(runs.endRun(baseRun.id, 9000, 'another reason'), false);
  assert.deepEqual(runs.get(baseRun.id), ended);
});

test('endRun ignores an already-finished run', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: baseRun.id, status: 'done', endedAt: 3500, resultPreview: 'completed normally' });
  const finished = runs.get(baseRun.id);

  assert.equal(runs.endRun(baseRun.id, 9000, 'interrupted'), false);
  assert.deepEqual(runs.get(baseRun.id), finished);
});

test('endRun recovers a stale run with the supplied ending time and reason', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.markStaleBefore(2000, 3500);
  assert.equal(runs.get(baseRun.id).status, 'stale');

  assert.equal(runs.endRun(baseRun.id, 5000, 'interrupted'), true);
  const row = runs.get(baseRun.id);
  assert.equal(row.status, 'done');
  assert.equal(row.endedAt, 5000);
  assert.equal(row.durationMs, 4000);
  assert.equal(row.resultPreview, 'interrupted');
  assert.equal(row.stopReason, null);
});

test('endRun removes a launched background agent from listActive', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.launch({ id: baseRun.id, agentId: 'ag_background' }), true);
  assert.deepEqual(runs.listActive().map((run) => run.id), [baseRun.id]);

  assert.equal(runs.endRun(baseRun.id, 3500, 'stopped'), true);
  assert.deepEqual(runs.listActive(), []);
  assert.equal(runs.get(baseRun.id).agentId, 'ag_background');
});

test('endRun returns false for a missing run without creating it', () => {
  const runs = createRunsRepo(fresh());
  assert.equal(runs.endRun('missing', 3500), false);
  assert.equal(runs.get('missing'), null);
});

test('endRun defaults the reason to stopped', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.endRun(baseRun.id, 3500), true);
  assert.equal(runs.get(baseRun.id).resultPreview, 'stopped');
});

test('endRun clamps duration to zero when the clock moves backwards', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.endRun(baseRun.id, 500), true);
  assert.equal(runs.get(baseRun.id).endedAt, 500);
  assert.equal(runs.get(baseRun.id).durationMs, 0);
});

test('endRun replaces a partial result with the interruption reason', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.enrich({ sessionId: 's1', agentType: 'programmer' }, { resultPreview: 'partial output' });

  assert.equal(runs.endRun(baseRun.id, 3500, 'interrupted'), true);
  assert.equal(runs.get(baseRun.id).resultPreview, 'interrupted');
});

test('endRun preserves the existing preview when the reason is explicitly null', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.enrich({ sessionId: 's1', agentType: 'programmer' }, { resultPreview: 'partial output' });

  assert.equal(runs.endRun(baseRun.id, 3500, null), true);
  assert.equal(runs.get(baseRun.id).resultPreview, 'partial output');
});
