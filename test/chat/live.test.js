// test/chat/live.test.js
//
// The only test that drives the real @anthropic-ai/claude-agent-sdk. It spends tokens and needs a
// working Claude Code login, so it is opt-in: `E2E_LIVE=1 node --test test/chat/live.test.js`.
// Everything else in the suite runs against test/chat/fake-sdk.js and never touches the network.
//
// Run it from a shell that is NOT itself inside a Claude Code session: a child session inherits the
// parent's permission behaviour through the environment, which would make this test pass for the
// wrong reason.
//
// It asks for a file write, not a shell command, on purpose. Claude Code decides some Bash calls
// above this gate — a trivial sandboxed command can run without canUseTool ever being consulted —
// so a Bash-based assertion would be testing the CLI's policy layer, not ours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createChatRepo } from '../../src/store/chat.js';
import { createSessionManager } from '../../src/chat/session.js';
import { createPermissionGate } from '../../src/chat/permissions.js';

const live = { skip: process.env.E2E_LIVE === '1' ? false : 'set E2E_LIVE=1 to run against the real SDK' };

function harness() {
  const events = [];
  const hub = {
    broadcast(event, data) { events.push({ event, data }); },
    of(name) { return events.filter((e) => e.event === name).map((e) => e.data); },
  };
  const store = createChatRepo(openDb(join(mkdtempSync(join(tmpdir(), 'ap-live-')), 'data.db')));
  const permissions = createPermissionGate({ hub, timeoutMs: 60_000 });
  const sessions = createSessionManager({ store, hub, permissions });
  return { hub, store, permissions, sessions };
}

function waitFor(hub, name, match = () => true, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = hub.of(name).find(match);
      if (hit) return resolve(hit);
      const [failed] = hub.of('chat.error');
      if (failed) return reject(new Error(`chat.error while waiting for ${name}: ${failed.detail}`));
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${name}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

test('a real session loads the user\'s own agents, so settingSources is doing its job', live, async () => {
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), 'ap-live-proj-'));
  await h.sessions.send(cwd, 'Reply with the single word: ready. Do not use any tools.');

  const ready = await waitFor(h.hub, 'chat.status', (s) => s.state === 'ready');
  assert.ok(Array.isArray(ready.agents));

  const userAgents = readdirSync(join(homedir(), '.claude', 'agents'), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.replace(/\.md$/, ''));
  if (userAgents.length > 0) {
    // These exist only in ~/.claude/agents. Without settingSources the SDK runs isolated and this
    // list comes back with none of them.
    assert.ok(userAgents.some((name) => ready.agents.includes(name)),
      `session saw ${JSON.stringify(ready.agents)}, none of the user's ${JSON.stringify(userAgents)}`);
  }
  await h.sessions.close();
  h.permissions.close();
});

test('a real tool call stops at the gate and stays denied', live, async () => {
  const h = harness();
  const cwd = mkdtempSync(join(tmpdir(), 'ap-live-proj-'));
  await h.sessions.send(cwd, 'Use the Write tool to create a file called agentpanel-live-check.txt containing the word hello.');

  const request = await waitFor(h.hub, 'permission.request');
  assert.equal(request.toolName, 'Write');
  assert.equal(request.projectPath, cwd);
  assert.match(JSON.stringify(request.input), /agentpanel-live-check/);

  assert.deepEqual(h.permissions.resolve(request.id, 'deny'), { ok: true });
  assert.deepEqual(h.hub.of('permission.resolved').map((e) => e.decision), ['deny']);

  const result = await waitFor(h.hub, 'chat.result');
  assert.equal(typeof result.totalCostUsd, 'number');
  // The write was refused, so the file cannot exist.
  assert.equal(existsSync(join(cwd, 'agentpanel-live-check.txt')), false, 'the denied write went through anyway');
  await h.sessions.close();
  h.permissions.close();
});
