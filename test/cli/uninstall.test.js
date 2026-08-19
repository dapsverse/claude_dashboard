// test/cli/uninstall.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.js';
import { runUninstall } from '../../src/cli/uninstall.js';

function env() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-uninstall-'));
  return {
    settingsPath: join(claudeDir, 'settings.json'),
    hooksDir: '/opt/agentpanel/hooks',
    stateDir: join(claudeDir, 'agentpanel'),
  };
}

test('uninstall leaves the settings backup on disk and reports its path', async () => {
  const { settingsPath, hooksDir, stateDir } = env();
  writeFileSync(settingsPath, JSON.stringify({ someUserKey: true }, null, 2));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'data.db'), 'not really a db');

  runInit({ settingsPath, hooksDir, assumeYes: true, log: () => {} });
  const backupPath = `${settingsPath}.agentpanel-backup`;
  assert.ok(existsSync(backupPath), 'init writes the backup before overwriting settings.json');

  const lines = [];
  await runUninstall({ settingsPath, stateDir, log: (l) => lines.push(l) });

  // The backup is the user's safety net for a tool that edits their settings.json — uninstall
  // must never delete it, only tell the user it is there.
  assert.ok(existsSync(backupPath), 'the backup survives uninstall');
  assert.equal(JSON.parse(readFileSync(backupPath, 'utf8')).someUserKey, true);
  assert.ok(lines.some((l) => l.includes(backupPath)), 'uninstall reports the backup path');
});

test('uninstall does not mention a backup that was never written', async () => {
  const { settingsPath, hooksDir, stateDir } = env();
  writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
  void hooksDir;

  const lines = [];
  await runUninstall({ settingsPath, stateDir, log: (l) => lines.push(l) });

  assert.ok(!lines.some((l) => l.includes('.agentpanel-backup')));
});

// A stand-in for the daemon: a live pid recorded in daemon.json, which is the only handle
// `agentpanel stop` has — and the file uninstall is about to delete.
async function fakeDaemon(stateDir, { ignoreTerm = false } = {}) {
  const handler = ignoreTerm ? "process.on('SIGTERM', () => {});" : '';
  // Wait for the child to announce itself: a SIGTERM delivered before the script has been evaluated
  // takes the default disposition and kills even the process meant to ignore it.
  const child = spawn(process.execPath,
    ['-e', `${handler} setInterval(() => {}, 1000); console.log('ready');`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => child.stdout.once('data', r));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'daemon.json'),
    JSON.stringify({ pid: child.pid, port: 8888, token: 'a'.repeat(64), startedAt: 1, version: '0.1.0' }));
  return child;
}

const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };

test('uninstall stops the running daemon before destroying the file that names it', async () => {
  const { settingsPath, stateDir } = env();
  writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
  const child = await fakeDaemon(stateDir);
  const exited = new Promise((r) => child.on('exit', r));

  const lines = [];
  const result = await runUninstall({ settingsPath, stateDir, log: (l) => lines.push(l) });
  await exited;

  assert.equal(result.stopped, true);
  assert.ok(gone(child.pid), 'the daemon must be dead, not orphaned holding the port');
  assert.ok(!existsSync(stateDir));
  assert.ok(lines.some((l) => l.includes(`stopped the running daemon (pid ${child.pid})`)));
  assert.ok(lines.some((l) => /No daemon is left running/.test(l)));
  // The old closing line told the user to run `agentpanel stop`, which cannot work: uninstall has
  // just deleted the runtime file that command reads.
  assert.ok(!lines.some((l) => /agentpanel stop/.test(l)));
});

test('uninstall reports the pid when the daemon refuses to exit, rather than claiming success', async () => {
  const { settingsPath, stateDir } = env();
  writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
  const child = await fakeDaemon(stateDir, { ignoreTerm: true });

  const lines = [];
  const result = await runUninstall({ settingsPath, stateDir, log: (l) => lines.push(l), timeoutMs: 300, pollMs: 20 });

  assert.equal(result.stopped, false);
  assert.equal(result.pid, child.pid);
  assert.ok(lines.some((l) => l.includes(`did not exit`)));
  assert.ok(lines.some((l) => l.includes(`kill ${child.pid}`)));
  assert.ok(!lines.some((l) => /fully removed/.test(l)));
  child.kill('SIGKILL');
});

test('uninstall with no daemon running reports a clean removal', async () => {
  const { settingsPath, stateDir } = env();
  writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'daemon.json'),
    JSON.stringify({ pid: 999_999, port: 8888, token: 'a'.repeat(64), startedAt: 1, version: '0.1.0' }));

  const lines = [];
  const result = await runUninstall({ settingsPath, stateDir, log: (l) => lines.push(l) });
  assert.equal(result.stopped, true);
  assert.ok(lines.some((l) => /fully removed/.test(l)));
});
