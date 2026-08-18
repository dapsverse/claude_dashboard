// test/core/paths.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('claudeHome defaults to ~/.claude', async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const { claudeHome } = await import('../../src/core/paths.js?1');
  assert.equal(claudeHome(), join(homedir(), '.claude'));
});

test('CLAUDE_CONFIG_DIR overrides and is resolved to absolute', async () => {
  process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg/../cfg';
  const { claudeHome, stateDir, dbPath } = await import('../../src/core/paths.js?2');
  assert.equal(claudeHome(), '/tmp/cfg');
  assert.equal(stateDir(), '/tmp/cfg/agentpanel');
  assert.equal(dbPath(), '/tmp/cfg/agentpanel/data.db');
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('project dirs resolve relative roots', async () => {
  const { projectAgentsDir } = await import('../../src/core/paths.js?3');
  assert.equal(projectAgentsDir('/a/b/'), '/a/b/.claude/agents');
});
