import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/index.js';

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
