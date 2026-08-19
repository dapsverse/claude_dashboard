import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, startupLines } from '../../src/cli/index.js';

// A stand-in for the daemon: a live pid recorded in daemon.json, which is the only handle
// `agentpanel uninstall` has to stop it before it deletes that same file.
async function fakeDaemon(claudeDir, { ignoreTerm = false } = {}) {
  const handler = ignoreTerm ? "process.on('SIGTERM', () => {});" : '';
  const child = spawn(process.execPath,
    ['-e', `${handler} setInterval(() => {}, 1000); console.log('ready');`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => child.stdout.once('data', r));
  const stateDir = join(claudeDir, 'agentpanel');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'daemon.json'),
    JSON.stringify({ pid: child.pid, port: 8888, token: 'a'.repeat(64), startedAt: 1, version: '0.1.0' }));
  return child;
}

test('status reports stopped and exits 1 when nothing is running', async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  const lines = [];
  const code = await main(['status'], (l) => lines.push(l));
  assert.equal(code, 1);
  assert.equal(lines[0], 'stopped');
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('an unknown command prints usage and exits 1', async () => {
  const lines = [];
  assert.equal(await main(['nonsense'], (l) => lines.push(l)), 1);
  assert.match(lines[0], /^usage:/);
});

test('open reports not-running rather than launching a browser', async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  const lines = [];
  assert.equal(await main(['open'], (l) => lines.push(l)), 1);
  assert.match(lines[0], /Not running/);
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('uninstall exits 0 once the daemon is confirmed stopped', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: {} }));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const lines = [];
  const code = await main(['uninstall'], (l) => lines.push(l));
  assert.equal(code, 0);
  assert.ok(lines.some((l) => /fully removed/.test(l)));
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('uninstall exits non-zero when the daemon refuses to stop, rather than reporting success', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ hooks: {} }));
  const child = await fakeDaemon(claudeDir, { ignoreTerm: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  const lines = [];
  const code = await main(['uninstall'], (l) => lines.push(l));
  delete process.env.CLAUDE_CONFIG_DIR;
  child.kill('SIGKILL');
  assert.equal(code, 1, 'a script must see failure while a daemon still holds the port');
  assert.ok(lines.some((l) => l.includes('did not exit')));
});

test('start prints the token url only to a terminal', () => {
  const url = 'http://127.0.0.1:8888/auth?token=' + 'a'.repeat(64);
  const tty = startupLines({ port: 8888, url, isTty: true });
  assert.ok(tty.some((l) => l.includes(url)), 'a human at a terminal needs the clickable url');
});

test('start never prints the token when stdout is not a terminal', () => {
  // The SessionStart bootstrap detaches the daemon with stdout redirected into daemon.log. Printing
  // the url there writes the token into a file, and that log has been created 0644 in the past.
  const token = 'a'.repeat(64);
  const lines = startupLines({ port: 8888, url: `http://127.0.0.1:8888/auth?token=${token}`, isTty: false });
  const out = lines.join('\n');
  assert.ok(!out.includes(token), 'the token must not reach a log file');
  assert.ok(!out.includes('token='));
  assert.match(out, /8888/, 'the port is still reported');
  assert.match(out, /agentpanel open/, 'and the user is told how to get the url');
});
