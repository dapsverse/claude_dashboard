import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, startupLines } from '../../src/cli/index.js';

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
