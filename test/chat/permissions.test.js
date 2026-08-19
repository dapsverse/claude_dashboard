// test/chat/permissions.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionGate, AUTO_ALLOW_TOOLS } from '../../src/chat/permissions.js';

function fakeHub() {
  const events = [];
  return {
    events,
    broadcast(event, data) { events.push({ event, data }); },
    of(name) { return events.filter((e) => e.event === name).map((e) => e.data); },
  };
}

const ctx = (over = {}) => ({ signal: new AbortController().signal, toolUseID: 'tu-1', ...over });

test('a read-only tool is allowed without ever asking the user', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  for (const tool of AUTO_ALLOW_TOOLS) {
    assert.deepEqual(await gate.forProject('/p')(tool, {}, ctx()), { behavior: 'allow' });
  }
  assert.equal(hub.of('permission.request').length, 0);
  gate.close();
});

test('any other tool broadcasts a request and blocks until it is answered', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub, now: () => 1000 });
  const decision = gate.forProject('/p/one')('Bash', { command: 'rm -rf /' }, ctx());

  const [req] = hub.of('permission.request');
  assert.equal(req.projectPath, '/p/one');
  assert.equal(req.toolName, 'Bash');
  assert.deepEqual(req.input, { command: 'rm -rf /' });
  assert.equal(req.toolUseId, 'tu-1');
  assert.ok(typeof req.id === 'string' && req.id.length > 0);
  assert.equal(req.ts, 1000);

  assert.equal(gate.resolve(req.id, 'allow').ok, true);
  assert.deepEqual(await decision, { behavior: 'allow' });
  assert.deepEqual(hub.of('permission.resolved'), [{ id: req.id, projectPath: '/p/one', decision: 'allow', ts: 1000 }]);
  gate.close();
});

test('a deny carries a message, which the SDK type requires, and does not interrupt', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('Bash', {}, ctx());
  gate.resolve(hub.of('permission.request')[0].id, 'deny');
  const result = await decision;
  assert.equal(result.behavior, 'deny');
  assert.ok(result.message.length > 0);
  assert.notEqual(result.interrupt, true);
  gate.close();
});

test('always-allow returns a session-scoped addRules update and nothing wider', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('Bash', {}, ctx({
    // The SDK's own suggestion writes to the user's settings file. Taking it would persist a rule
    // outside the session the user answered in.
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'userSettings' }],
  }));
  gate.resolve(hub.of('permission.request')[0].id, 'always');
  const result = await decision;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
  ]);
  gate.close();
});

test('an unanswered request denies on timeout — it never times out into an allow', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub, timeoutMs: 10 });
  const result = await gate.forProject('/p')('Bash', {}, ctx());
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /timed out/i);
  assert.deepEqual(hub.of('permission.resolved').map((e) => e.decision), ['timeout']);
  gate.close();
});

test('an aborted session settles its pending requests instead of leaking the promise', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const controller = new AbortController();
  const decision = gate.forProject('/p')('Bash', {}, ctx({ signal: controller.signal }));
  controller.abort();
  const result = await decision;
  assert.equal(result.behavior, 'deny');
  assert.deepEqual(hub.of('permission.resolved').map((e) => e.decision), ['aborted']);
  gate.close();
});

test('a request whose signal is already aborted is denied without being broadcast', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const controller = new AbortController();
  controller.abort();
  const result = await gate.forProject('/p')('Bash', {}, ctx({ signal: controller.signal }));
  assert.equal(result.behavior, 'deny');
  assert.equal(hub.of('permission.request').length, 0);
  gate.close();
});

test('resolving an unknown or already-settled id reports failure instead of settling twice', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  assert.deepEqual(gate.resolve('nope', 'allow'), { ok: false, reason: 'unknown_request' });
  const decision = gate.forProject('/p')('Bash', {}, ctx());
  const { id } = hub.of('permission.request')[0];
  assert.equal(gate.resolve(id, 'allow').ok, true);
  assert.deepEqual(gate.resolve(id, 'deny'), { ok: false, reason: 'unknown_request' });
  assert.equal((await decision).behavior, 'allow');
  gate.close();
});

test('an unrecognised decision is refused rather than guessed at', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub, timeoutMs: 50 });
  const decision = gate.forProject('/p')('Bash', {}, ctx());
  assert.deepEqual(gate.resolve(hub.of('permission.request')[0].id, 'bypassPermissions'), { ok: false, reason: 'bad_decision' });
  assert.equal((await decision).behavior, 'deny');       // still pending, then times out closed
  gate.close();
});

test('aborting one project leaves another project\'s request pending', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const one = gate.forProject('/p/one')('Bash', {}, ctx());
  const two = gate.forProject('/p/two')('Bash', {}, ctx());
  gate.abortProject('/p/one');
  assert.equal((await one).behavior, 'deny');
  assert.equal(gate.list('/p/two').length, 1);
  assert.equal(gate.list('/p/one').length, 0);
  gate.resolve(gate.list('/p/two')[0].id, 'allow');
  assert.equal((await two).behavior, 'allow');
  gate.close();
});

test('close denies everything still pending so no tool is left waiting on a dead daemon', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('Bash', {}, ctx());
  gate.close();
  assert.equal((await decision).behavior, 'deny');
  assert.equal(gate.list().length, 0);
});

test('no path ever returns null, which would block the tool forever', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub, timeoutMs: 10 });
  const controller = new AbortController();
  const results = await Promise.all([
    gate.forProject('/p')('Read', {}, ctx()),                                   // auto-allow
    gate.forProject('/p')('Bash', {}, ctx()),                                   // timeout
    (async () => {
      const d = gate.forProject('/p')('Write', {}, ctx({ signal: controller.signal }));
      controller.abort();
      return d;
    })(),
  ]);
  for (const result of results) {
    assert.notEqual(result, null);
    assert.ok(result.behavior === 'allow' || result.behavior === 'deny');
  }
  gate.close();
});
