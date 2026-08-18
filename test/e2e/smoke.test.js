// test/e2e/smoke.test.js
//
// The only test that drives the real hook script against a real daemon: it proves the shell
// script, the HTTP route, the correlator, and the store all agree with each other. Everything
// else in this suite substitutes at least one of those four for a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../../src/daemon/index.js';

const HOOK = fileURLToPath(new URL('../../hooks/agentpanel-hook.sh', import.meta.url));

function fire(payload, configDir) {
  return new Promise((resolve) => {
    const child = execFile('bash', [HOOK], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } },
      () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
}

test('a dispatched subagent appears and then completes, end to end', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-e2e-'));
  const uiDir = mkdtempSync(join(tmpdir(), 'ap-e2e-ui-'));
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>t</title>');

  const daemon = await startDaemon({
    claudeDir, projectRoot: claudeDir, uiDir, portRange: { start: 19100, end: 19150 },
  });

  // Note the dispatch tool is `Agent` on this CLI version, not `Task` — that is what the
  // fixtures and the correlator expect.
  const base = { session_id: 'e2e', cwd: '/proj', tool_name: 'Agent', tool_use_id: 'tu_e2e' };
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/runs`,
      { headers: { authorization: `Bearer ${daemon.token}` } });
    return res.json();
  };

  await fire({ ...base, hook_event_name: 'PreToolUse',
    tool_input: { subagent_type: 'programmer', description: 'wire it up', prompt: 'go' } }, claudeDir);

  let state = await get();
  assert.equal(state.active.length, 1);
  assert.equal(state.active[0].agentType, 'programmer');
  assert.equal(state.active[0].description, 'wire it up');

  await fire({ ...base, hook_event_name: 'PostToolUse', tool_response: 'finished', duration_ms: 1234 }, claudeDir);

  state = await get();
  assert.equal(state.active.length, 0);
  assert.equal(state.recent[0].status, 'done');
  assert.equal(state.recent[0].durationMs, 1234);

  await daemon.stop();
});

test('the hook script does not disturb a session when the daemon is stopped', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-e2e-off-'));
  await fire({ hook_event_name: 'PreToolUse', session_id: 'x' }, claudeDir);
  // Reaching this line without a throw or hang is the assertion.
  assert.ok(true);
});
