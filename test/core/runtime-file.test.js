import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeRuntime, readRuntime, readLiveRuntime, clearRuntime, isAlive, acquireStartLock, restrictStatePaths } from '../../src/core/runtime-file.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'ap-')), 'nested', 'daemon.json');

test('writes 0600 and reads back', () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  assert.equal((statSync(f).mode & 0o777), 0o600);
  assert.equal(readRuntime(f).port, 8888);
});

test('readRuntime returns null for missing or corrupt files', () => {
  assert.equal(readRuntime('/nonexistent/daemon.json'), null);
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, 'not json at all');
  assert.equal(readRuntime(f), null);
});

test('readRuntime rethrows a permission error instead of reporting no daemon', { skip: process.getuid?.() === 0 }, () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  chmodSync(f, 0o000);
  try {
    assert.throws(() => readRuntime(f), (e) => e.code === 'EACCES' || e.code === 'EPERM');
  } finally {
    chmodSync(f, 0o600);
  }
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

test('acquireStartLock is not wedged by an empty lock file', () => {
  const f = `${file()}.lock`;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, '');
  const release = acquireStartLock(f);
  assert.ok(release, 'an empty, unowned lock file must be taken over rather than blocking forever');
  release();
});

test('acquireStartLock is not wedged by an unparseable lock file', () => {
  const f = `${file()}.lock`;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, 'not-a-pid');
  const release = acquireStartLock(f);
  assert.ok(release, 'garbage lock content must not be mistaken for a live holder');
  release();
});

test('acquireStartLock refuses when the recorded pid is genuinely alive', () => {
  const f = `${file()}.lock`;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, String(process.pid));
  assert.equal(acquireStartLock(f), null);
});

test('restrictStatePaths tightens a state directory and log the bootstrap left world-readable', () => {
  // `mkdir -p` in the SessionStart script creates the directory under the umask, and mkdirSync's
  // mode is ignored for a directory that already exists — so nothing else re-asserts these modes.
  const dir = mkdtempSync(join(tmpdir(), 'ap-state-'));
  const log = join(dir, 'daemon.log');
  chmodSync(dir, 0o755);
  writeFileSync(log, 'Open: http://127.0.0.1:8888/auth?token=deadbeef\n', { mode: 0o644 });

  restrictStatePaths(dir);

  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(log).mode & 0o777, 0o600);
});

test('restrictStatePaths is a no-op when the directory and log do not exist yet', () => {
  assert.doesNotThrow(() => restrictStatePaths(join(tmpdir(), 'ap-state-absent-', String(Date.now()))));
});
