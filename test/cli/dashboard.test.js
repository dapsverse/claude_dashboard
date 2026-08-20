import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/index.js';

const TOKEN = 'b'.repeat(64);

function withState({ running = true } = {}) {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-dash-'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  if (running) {
    mkdirSync(join(claudeDir, 'agentpanel'), { recursive: true });
    writeFileSync(join(claudeDir, 'agentpanel', 'daemon.json'), JSON.stringify({
      pid: process.pid, port: 8899, token: TOKEN, startedAt: Date.now(), version: '0.1.0',
    }));
  }
  return claudeDir;
}

function spy({ runtime = null } = {}) {
  const calls = { spawned: 0, opened: [] };
  return {
    calls,
    deps: {
      spawnDaemon: () => { calls.spawned += 1; },
      awaitRuntime: async () => runtime,
      openUrl: (opener, url) => calls.opened.push([opener, url]),
      platform: 'darwin',
    },
  };
}

test('dashboard opens the browser for a daemon that is already running', async () => {
  withState();
  const s = spy();
  const lines = [];
  assert.equal(await main(['dashboard'], (l) => lines.push(l), s.deps), 0);

  assert.equal(s.calls.spawned, 0);                 // nothing to start
  assert.equal(s.calls.opened.length, 1);
  assert.deepEqual(s.calls.opened[0], ['open', `http://127.0.0.1:8899/auth?token=${TOKEN}`]);
  assert.match(lines[0], /already running on http:\/\/127\.0\.0\.1:8899/);
  delete process.env.CLAUDE_CONFIG_DIR;
});

// The whole reason this command exists separately from `open`: its output is read back into a Claude
// Code session and written to that session's transcript on disk.
test('dashboard never prints the token, on any path it can take', async () => {
  for (const scenario of [
    { state: { running: true }, spy: spy() },
    { state: { running: false }, spy: spy({ runtime: { pid: 4242, port: 8899, token: TOKEN } }) },
    { state: { running: true }, spy: { ...spy(), deps: { ...spy().deps, platform: 'win32' } } },
  ]) {
    withState(scenario.state);
    const lines = [];
    await main(['dashboard'], (l) => lines.push(l), scenario.spy.deps);
    const printed = lines.join('\n');
    assert.ok(!printed.includes(TOKEN), `token leaked: ${printed}`);
    assert.ok(!printed.includes('token='), `token query leaked: ${printed}`);
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('dashboard starts the daemon when none is running, then opens it', async () => {
  withState({ running: false });
  const s = spy({ runtime: { pid: 4242, port: 8899, token: TOKEN } });
  const lines = [];
  assert.equal(await main(['dashboard'], (l) => lines.push(l), s.deps), 0);

  assert.equal(s.calls.spawned, 1);
  assert.equal(s.calls.opened.length, 1);
  assert.match(lines[0], /now running on http:\/\/127\.0\.0\.1:8899 \(pid 4242\)/);
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('dashboard names the log file when the daemon never comes up', async () => {
  const claudeDir = withState({ running: false });
  const s = spy({ runtime: null });
  const lines = [];
  assert.equal(await main(['dashboard'], (l) => lines.push(l), s.deps), 1);

  assert.equal(s.calls.spawned, 1);
  assert.equal(s.calls.opened.length, 0);           // never claim a browser was opened
  assert.match(lines.join('\n'), /did not come up/);
  assert.match(lines.join('\n'), new RegExp(join(claudeDir, 'agentpanel', 'daemon.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('dashboard says how to open it by hand on a platform with no opener', async () => {
  withState();
  const s = spy();
  const lines = [];
  assert.equal(await main(['dashboard'], (l) => lines.push(l), { ...s.deps, platform: 'win32' }), 0);

  assert.equal(s.calls.opened.length, 0);
  assert.match(lines.join('\n'), /agentpanel open/);
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('usage lists dashboard, or nobody discovers it', async () => {
  const lines = [];
  await main(['nonsense'], (l) => lines.push(l));
  assert.match(lines[0], /dashboard/);
});

// The command file is what makes `/dashboard` exist, and it runs whatever string this produces. If
// the template ever loses its placeholder, the installed command would tell Claude to run the
// literal text `__AGENTPANEL_COMMAND__`.
test('the shipped command template still carries its placeholder in both places', () => {
  const template = readFileSync(new URL('../../commands/dashboard.md', import.meta.url), 'utf8');
  assert.equal(template.split('__AGENTPANEL_COMMAND__').length - 1, 2);
  assert.match(template, /^---\ndescription: /);
  assert.match(template, /agentpanel-command-version:/);
});
