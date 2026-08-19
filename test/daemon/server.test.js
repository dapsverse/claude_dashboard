import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../../src/daemon/sse.js';
import { createServer } from '../../src/daemon/server.js';

const TOKEN = 'c'.repeat(64);

async function boot(routes = []) {
  const hub = createHub();
  const server = createServer({ token: TOKEN, port: 0, hub, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, hub, port, base: `http://127.0.0.1:${port}` };
}

test('health route requires no token but still enforces Host', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/health', public: true, handler: (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    } },
  ]);
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  server.close();
});

test('protected route rejects without a token', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/runs', handler: (_q, res) => { res.writeHead(200); res.end('[]'); } },
  ]);
  const res = await fetch(`${base}/api/runs`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'bad_token' });
  server.close();
});

test('protected route accepts a bearer token', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/runs', handler: (_q, res) => { res.writeHead(200); res.end('[]'); } },
  ]);
  const res = await fetch(`${base}/api/runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  server.close();
});

test('unknown path returns 404 json', async () => {
  const { server, base } = await boot();
  const res = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  server.close();
});

test('wrong method on a known path returns 404', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/runs', handler: (_q, res) => { res.writeHead(200); res.end('[]'); } },
  ]);
  const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
  server.close();
});

test('hub broadcasts framed SSE to connected clients', async () => {
  const chunks = [];
  const fakeRes = { write: (c) => chunks.push(c), end() {}, on() {}, writeHead() {}, flushHeaders() {} };
  const hub = createHub();
  hub.add(fakeRes);
  assert.equal(hub.size(), 1);
  hub.broadcast('run.open', { id: 'x' });
  assert.equal(chunks.at(-1), 'event: run.open\ndata: {"id":"x"}\n\n');
});

test('hub drops a client whose write throws', () => {
  const hub = createHub();
  hub.add({ write() { throw new Error('EPIPE'); }, end() {}, on() {}, writeHead() {}, flushHeaders() {} });
  hub.broadcast('ping', {});
  assert.equal(hub.size(), 0);
});

test('a state-changing route that is also public refuses to boot', () => {
  assert.throws(
    () => createServer({
      token: TOKEN, port: 0, hub: createHub(),
      routes: [{ method: 'POST', path: '/api/chat', stateChanging: true, public: true, handler() {} }],
    }),
    /cannot be public/,
  );
});
