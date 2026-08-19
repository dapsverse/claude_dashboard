// test/daemon/chat-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../src/daemon/server.js';
import { openDb } from '../../src/store/db.js';
import { createChatRepo } from '../../src/store/chat.js';
import { createProjectsRepo } from '../../src/store/projects.js';
import { createSessionManager } from '../../src/chat/session.js';
import { createPermissionGate } from '../../src/chat/permissions.js';
import { chatRoutes } from '../../src/daemon/routes/chat.js';
import { createFakeSdk } from '../chat/fake-sdk.js';

const TOKEN = 'd'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function boot() {
  const events = [];
  const hub = {
    broadcast(event, data) { events.push({ event, data }); },
    of(name) { return events.filter((e) => e.event === name).map((e) => e.data); },
  };
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ap-croute-')), 'data.db'));
  const chat = createChatRepo(db);
  const projects = createProjectsRepo(db);
  const sdk = createFakeSdk();
  const permissions = createPermissionGate({ hub });
  const sessions = createSessionManager({ store: chat, hub, sdk, permissions });
  const routes = chatRoutes({ sessions, permissions, chat, projects });

  const server = createServer({ token: TOKEN, port: 0, hub, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-proj-')));

  return {
    hub, chat, projects, sdk, sessions, permissions, routes, base, dir,
    post: (path, body, headers = {}) => fetch(`${base}${path}`, {
      method: 'POST', headers: { ...AUTH, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    get: (path, headers = {}) => fetch(`${base}${path}`, { headers: { ...AUTH, ...headers } }),
    async stop() { await sessions.close(); permissions.close(); server.close(); },
  };
}

test('every state-changing chat route is authenticated and none is public', async () => {
  const h = await boot();
  const mutating = h.routes.filter((r) => r.method === 'POST');
  assert.ok(mutating.length >= 4);
  for (const route of mutating) {
    assert.equal(route.stateChanging, true, `${route.path ?? route.prefix} must declare stateChanging`);
    assert.notEqual(route.public, true);
  }
  await h.stop();
});

test('posting a message without a token is rejected before anything is stored', async () => {
  const h = await boot();
  const res = await fetch(`${h.base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: h.dir, text: 'hello' }),
  });
  assert.equal(res.status, 401);
  assert.equal(h.sdk.calls.length, 0);
  await h.stop();
});

test('a foreign Origin cannot start a session through the browser\'s ambient cookie', async () => {
  const h = await boot();
  const res = await h.post('/api/chat', { projectPath: h.dir, text: 'hello' }, { origin: 'http://127.0.0.1:5173' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'bad_origin' });
  assert.equal(h.sdk.calls.length, 0);
  await h.stop();
});

test('a message starts a session in the requested project and is queued to it', async () => {
  const h = await boot();
  const res = await h.post('/api/chat', { projectPath: h.dir, text: 'hello there' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, projectPath: h.dir, sessionId: null });
  assert.equal(h.sdk.calls.length, 1);
  assert.equal(h.sdk.last().options.cwd, h.dir);
  assert.deepEqual((await h.sdk.last().waitForInput()).map((m) => m.message.content), ['hello there']);
  await h.stop();
});

test('a path that is not an existing directory is refused', async () => {
  const h = await boot();
  const file = join(h.dir, 'a-file.txt');
  writeFileSync(file, 'x');
  for (const projectPath of [join(h.dir, 'nope'), file, 'relative/path', '', 42, null]) {
    const res = await h.post('/api/chat', { projectPath, text: 'hello' });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(projectPath)}`);
    assert.equal((await res.json()).error, 'bad_project');
  }
  assert.equal(h.sdk.calls.length, 0);
  await h.stop();
});

test('an empty message, a malformed body and a non-object body are all refused', async () => {
  const h = await boot();
  assert.equal((await h.post('/api/chat', { projectPath: h.dir, text: '   ' })).status, 400);
  assert.equal((await h.post('/api/chat', 'not json at all')).status, 400);
  assert.equal((await h.post('/api/chat', '[1,2,3]')).status, 400);
  assert.equal(h.sdk.calls.length, 0);
  await h.stop();
});

test('interrupt and reset act on the named project only', async () => {
  const h = await boot();
  await h.post('/api/chat', { projectPath: h.dir, text: 'hello' });
  h.sdk.last().outbox.push({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm' });
  await new Promise((r) => setTimeout(r, 5));

  const interrupted = await h.post('/api/chat/interrupt', { projectPath: h.dir });
  assert.equal(interrupted.status, 200);
  assert.equal(h.sdk.last().interrupts, 1);

  assert.equal(h.chat.getSession(h.dir).sessionId, 'sess-1');
  const reset = await h.post('/api/chat/reset', { projectPath: h.dir });
  assert.equal(reset.status, 200);
  assert.equal(h.chat.getSession(h.dir), null);
  await h.stop();
});

test('interrupt and reset refuse a bad project path too', async () => {
  const h = await boot();
  for (const path of ['/api/chat/interrupt', '/api/chat/reset']) {
    const res = await h.post(path, { projectPath: 'nowhere' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_project');
  }
  await h.stop();
});

test('a pending permission request is resolved by its route and the tool is released', async () => {
  const h = await boot();
  await h.post('/api/chat', { projectPath: h.dir, text: 'do it' });
  const decision = h.sdk.last().options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' });
  const [request] = h.hub.of('permission.request');

  const res = await h.post(`/api/permissions/${request.id}`, { decision: 'allow' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, id: request.id, decision: 'allow' });
  assert.deepEqual(await decision, { behavior: 'allow' });
  await h.stop();
});

test('always-allow through the route yields a session-scoped rule and nothing wider', async () => {
  const h = await boot();
  await h.post('/api/chat', { projectPath: h.dir, text: 'do it' });
  const decision = h.sdk.last().options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't1' });
  const [request] = h.hub.of('permission.request');
  await h.post(`/api/permissions/${request.id}`, { decision: 'always' });
  const result = await decision;
  assert.deepEqual(result.updatedPermissions, [
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
  ]);
  await h.stop();
});

test('an unknown request id is a 404 and an unknown decision is a 400', async () => {
  const h = await boot();
  const missing = await h.post('/api/permissions/does-not-exist', { decision: 'allow' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'unknown_request' });

  for (const decision of ['bypassPermissions', 'acceptEdits', '', null, 1, 'ALLOW']) {
    const res = await h.post('/api/permissions/whatever', { decision });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(decision)}`);
    assert.deepEqual(await res.json(), { error: 'bad_decision' });
  }
  await h.stop();
});

test('a permission route with no id is not a way to resolve anything', async () => {
  const h = await boot();
  const res = await h.post('/api/permissions/', { decision: 'allow' });
  assert.equal(res.status, 404);
  await h.stop();
});

test('history returns the persisted transcript for one project, newest last', async () => {
  const h = await boot();
  await h.post('/api/chat', { projectPath: h.dir, text: 'first question' });
  h.sdk.last().outbox.push({
    type: 'assistant', uuid: 'u1', parent_tool_use_id: null,
    message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
  });
  await new Promise((r) => setTimeout(r, 5));

  const res = await h.get(`/api/chat/history?projectPath=${encodeURIComponent(h.dir)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.projectPath, h.dir);
  assert.equal(body.running, true);
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(body.messages[1].blocks[0].text, 'an answer');
  assert.ok(Array.isArray(body.pendingPermissions));
  await h.stop();
});

test('history without a project path is a 400, and an unknown project is simply empty', async () => {
  const h = await boot();
  assert.equal((await h.get('/api/chat/history')).status, 400);
  const res = await h.get(`/api/chat/history?projectPath=${encodeURIComponent(h.dir)}`);
  assert.deepEqual((await res.json()).messages, []);
  await h.stop();
});

test('projects are listed, added once, and rejected when the path is not a directory', async () => {
  const h = await boot();
  assert.deepEqual(await (await h.get('/api/projects')).json(), { projects: [] });

  const created = await h.post('/api/projects', { path: h.dir });
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.project.path, h.dir);
  assert.ok(body.project.name.length > 0);

  await h.post('/api/projects', { path: h.dir });
  assert.equal((await (await h.get('/api/projects')).json()).projects.length, 1);

  for (const path of [join(h.dir, 'missing'), 'relative', '', null]) {
    const res = await h.post('/api/projects', { path });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_project');
  }
  await h.stop();
});

test('a project path is normalised through symlinks so one directory is one session', async () => {
  const h = await boot();
  // On macOS /tmp is a symlink to /private/tmp: the unresolved and resolved spellings must not
  // become two sessions for the same directory.
  const viaTmp = h.dir.replace('/private/tmp/', '/tmp/');
  await h.post('/api/chat', { projectPath: h.dir, text: 'one' });
  await h.post('/api/chat', { projectPath: viaTmp, text: 'two' });
  assert.equal(h.sdk.calls.length, 1);
  await h.stop();
});
