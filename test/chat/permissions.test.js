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

// ---------------------------------------------------------------- AskUserQuestion
//
// The CLI hands this tool to `canUseTool` unconditionally — its own `checkPermissions` always answers
// `behavior: 'ask'` — because the host is its question renderer. An allow that carries no `answers`
// in `updatedInput` produces the tool result "The user did not answer the questions.", which is how
// a plain approval prompt turns into a model reporting that nobody replied.

const QUESTION_INPUT = {
  questions: [{
    question: 'Which database?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'Relational', preview: 'CREATE TABLE …' },
      { label: 'SQLite', description: 'Embedded' },
    ],
  }],
};

test('an AskUserQuestion request is broadcast as a question, with its questions attached', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());

  const [req] = hub.of('permission.request');
  assert.equal(req.kind, 'question');
  assert.equal(req.questions.length, 1);
  assert.equal(req.questions[0].question, 'Which database?');
  assert.equal(req.questions[0].header, 'Database');
  assert.equal(req.questions[0].multiSelect, false);
  assert.deepEqual(req.questions[0].options.map((o) => o.label), ['Postgres', 'SQLite']);
  assert.equal(req.questions[0].options[0].preview, 'CREATE TABLE …');

  gate.resolve(req.id, 'allow', { answers: { 'Which database?': 'Postgres' } });
  await decision;
  gate.close();
});

// A question is the model waiting on the user to think. An approval window on that produces either a
// rushed answer or an auto-deny reported to the model as "the user refused to reply" — so a question
// gets no deadline, while a tool call keeps its fail-closed one.
test('a question is never expired by the approval window, and reports no deadline', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub, timeoutMs: 5 });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());

  const [req] = hub.of('permission.request');
  assert.equal(req.expiresAt, null);

  await new Promise((r) => setTimeout(r, 30));                  // well past the window a tool gets
  assert.deepEqual(hub.of('permission.resolved'), []);
  assert.equal(gate.list('/p').length, 1);

  gate.resolve(req.id, 'allow', { answers: { 'Which database?': 'Postgres' } });
  const result = await decision;
  assert.equal(result.behavior, 'allow');
  gate.close();
});

test('answering a question allows the tool with the answers in updatedInput', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());
  const [req] = hub.of('permission.request');

  assert.deepEqual(gate.resolve(req.id, 'allow', { answers: { 'Which database?': 'Postgres' } }), { ok: true, answered: 1 });
  const result = await decision;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, { 'Which database?': 'Postgres' });
  // The tool reads `questions` back out of its own input to build the result block; dropping it
  // turns the answer into a crash on the CLI side.
  assert.deepEqual(result.updatedInput.questions, QUESTION_INPUT.questions);
  // Derived from the picked option, never taken from the request body.
  assert.deepEqual(result.updatedInput.annotations, { 'Which database?': { preview: 'CREATE TABLE …' } });
  gate.close();
});

test('a multi-select answer is joined into the comma-separated form the tool documents', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const input = {
    questions: [{
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [{ label: 'auth', description: 'a' }, { label: 'billing', description: 'b' }],
    }],
  };
  const decision = gate.forProject('/p')('AskUserQuestion', input, ctx());
  const [req] = hub.of('permission.request');
  gate.resolve(req.id, 'allow', { answers: { 'Which features?': ['auth', 'billing'] } });
  const result = await decision;
  assert.equal(result.updatedInput.answers['Which features?'], 'auth, billing');
  gate.close();
});

test('an answer to a question that was never asked is dropped rather than passed through', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());
  const [req] = hub.of('permission.request');
  gate.resolve(req.id, 'allow', {
    answers: { 'Which database?': 'SQLite', 'Should I delete everything?': 'yes' },
  });
  const result = await decision;
  assert.deepEqual(result.updatedInput.answers, { 'Which database?': 'SQLite' });
  gate.close();
});

test('notes are carried as annotations, and a preview is never taken from the client', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());
  const [req] = hub.of('permission.request');
  gate.resolve(req.id, 'allow', {
    answers: { 'Which database?': 'SQLite' },
    notes: { 'Which database?': '  keep it single-file  ', 'Which database?x': 'ignored' },
  });
  const result = await decision;
  assert.deepEqual(result.updatedInput.annotations, { 'Which database?': { notes: 'keep it single-file' } });
  gate.close();
});

test('skipping a question is an allow with no answers, which is the tool own no-answer path', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());
  const [req] = hub.of('permission.request');
  gate.resolve(req.id, 'allow', { answers: {} });
  const result = await decision;
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(result.updatedInput.answers, {});
  assert.equal('annotations' in result.updatedInput, false);
  gate.close();
});

test('dismissing a question denies it with a message about the question, not about a tool call', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());
  const [req] = hub.of('permission.request');
  gate.resolve(req.id, 'deny');
  const result = await decision;
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /question/i);
  gate.close();
});

test('always-allow is refused for a question, because a session rule would answer nothing forever', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());
  const [req] = hub.of('permission.request');
  assert.deepEqual(gate.resolve(req.id, 'always'), { ok: false, reason: 'bad_decision' });
  // Still pending, so it can be answered properly.
  gate.resolve(req.id, 'allow', { answers: { 'Which database?': 'SQLite' } });
  assert.equal((await decision).behavior, 'allow');
  gate.close();
});

test('an AskUserQuestion whose input is not renderable degrades to an ordinary approval prompt', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  // Options are what make a question answerable; without them there is nothing to click.
  const decision = gate.forProject('/p')('AskUserQuestion', { questions: [{ question: 'hm?', options: [] }] }, ctx());
  const [req] = hub.of('permission.request');
  assert.equal(req.kind, 'tool');
  assert.equal(req.questions, null);
  gate.resolve(req.id, 'allow');
  assert.deepEqual(await decision, { behavior: 'allow' });
  gate.close();
});

test('a pending question is restorable after a reload, questions included', async () => {
  const hub = fakeHub();
  const gate = createPermissionGate({ hub });
  const decision = gate.forProject('/p')('AskUserQuestion', QUESTION_INPUT, ctx());
  const [descriptor] = gate.list('/p');
  assert.equal(descriptor.kind, 'question');
  assert.equal(descriptor.questions[0].question, 'Which database?');
  gate.resolve(descriptor.id, 'allow', { answers: { 'Which database?': 'Postgres' } });
  await decision;
  gate.close();
});
