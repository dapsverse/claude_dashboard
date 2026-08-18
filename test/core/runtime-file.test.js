import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime, readRuntime, readLiveRuntime, clearRuntime, isAlive } from '../../src/core/runtime-file.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'ap-')), 'nested', 'daemon.json');

test('writes 0600 and reads back', () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  assert.equal((statSync(f).mode & 0o777), 0o600);
  assert.equal(readRuntime(f).port, 8888);
});

test('readRuntime returns null for missing or corrupt files', () => {
  assert.equal(readRuntime('/nonexistent/daemon.json'), null);
});

test('readLiveRuntime returns null when the pid is dead', () => {
  const f = file();
  writeRuntime({ pid: 999999, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  assert.equal(readLiveRuntime(f), null);
  assert.ok(readRuntime(f), 'the file itself is left in place for diagnostics');
});

test('readLiveRuntime returns the record when the pid is alive', () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  assert.equal(readLiveRuntime(f).token, 'abc');
});

test('isAlive rejects nonsense pids', () => {
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive('x'), false);
});

test('clearRuntime is idempotent', () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 1, token: 't', startedAt: 1, version: '0.1.0' }, f);
  clearRuntime(f); clearRuntime(f);
  assert.equal(readRuntime(f), null);
});
