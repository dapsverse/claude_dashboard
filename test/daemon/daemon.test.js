import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/index.js';
import { mergeHooks } from '../../src/cli/hook-config.js';

function env() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-d-'));
  const uiDir = mkdtempSync(join(tmpdir(), 'ap-ui-'));
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>agentpanel</title>');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1)');
  return { claudeDir, uiDir, projectRoot: claudeDir };
}

test('binds loopback, writes a live runtime file, and reports a token url', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 18900, end: 18950 } });
  assert.ok(d.port >= 18900 && d.port <= 18950);
  assert.equal(d.server.address().address, '127.0.0.1');
  assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+\/auth\?token=[0-9a-f]{64}$/);
  await d.stop();
});

test('the auth route exchanges a token for a cookie and redirects', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 18951, end: 18990 } });
  const res = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /agentpanel_token=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  await d.stop();
});

test('the auth route rejects a wrong token', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 18991, end: 18999 } });
  const res = await fetch(`http://127.0.0.1:${d.port}/auth?token=${'0'.repeat(64)}`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  await d.stop();
});

test('the cookie from /auth authenticates an api call', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19000, end: 19010 } });
  const auth = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`http://127.0.0.1:${d.port}/api/catalog`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.agents));
  await d.stop();
});

test('static assets are served and unknown paths fall back to index.html', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19011, end: 19020 } });
  const auth = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const asset = await fetch(`http://127.0.0.1:${d.port}/assets/app.js`, { headers: { cookie } });
  assert.equal(asset.status, 200);
  const spa = await fetch(`http://127.0.0.1:${d.port}/activity`, { headers: { cookie } });
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /<!doctype html>/i);
  await d.stop();
});

test('a traversal attempt cannot escape the ui directory', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19021, end: 19030 } });
  const auth = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`http://127.0.0.1:${d.port}/../../../../etc/passwd`, { headers: { cookie } });
  assert.notEqual(res.status, 200);
  await d.stop();
});

test('stop clears the runtime file so the next bootstrap starts fresh', async () => {
  const e = env();
  const d = await startDaemon({ ...e, portRange: { start: 19031, end: 19040 } });
  const { readRuntime } = await import('../../src/core/runtime-file.js');
  const file = join(e.claudeDir, 'agentpanel', 'daemon.json');
  assert.equal(readRuntime(file).port, d.port);
  await d.stop();
  assert.equal(readRuntime(file), null);
});

test('a second daemon takes the next port instead of failing', async () => {
  const a = await startDaemon({ ...env(), portRange: { start: 19041, end: 19050 } });
  const b = await startDaemon({ ...env(), portRange: { start: 19041, end: 19050 } });
  assert.notEqual(a.port, b.port);
  await a.stop(); await b.stop();
});

test('a non-loopback host is refused unless unsafeBind is set', async () => {
  await assert.rejects(
    () => startDaemon({ ...env(), host: '0.0.0.0', portRange: { start: 19051, end: 19060 } }),
    /Refusing to bind/,
  );
});

test('unsafeBind explicitly allows a non-loopback host', async () => {
  const d = await startDaemon({
    ...env(), host: '0.0.0.0', unsafeBind: true, portRange: { start: 19061, end: 19070 },
  });
  assert.equal(d.server.address().address, '0.0.0.0');
  await d.stop();
});

test('a symlink inside uiDir cannot serve a file from outside it', async () => {
  const e = env();
  const outside = mkdtempSync(join(tmpdir(), 'ap-outside-'));
  const secretPath = join(outside, 'secret.txt');
  writeFileSync(secretPath, 'top secret');
  symlinkSync(secretPath, join(e.uiDir, 'assets', 'escape.txt'));

  const d = await startDaemon({ ...e, portRange: { start: 19071, end: 19080 } });
  const auth = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];

  const escaped = await fetch(`http://127.0.0.1:${d.port}/assets/escape.txt`, { headers: { cookie } });
  assert.notEqual(escaped.status, 200);

  const asset = await fetch(`http://127.0.0.1:${d.port}/assets/app.js`, { headers: { cookie } });
  assert.equal(asset.status, 200);

  await d.stop();
});

test('health reports hooksInstalled false when settings.json has never been written', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19111, end: 19120 } });
  const res = await fetch(`http://127.0.0.1:${d.port}/api/health`);
  const body = await res.json();
  assert.equal(body.hooksInstalled, false);
  await d.stop();
});

test('health reports hooksInstalled true once our hooks are in settings.json', async () => {
  const e = env();
  const { hooks } = mergeHooks({}, '/opt/agentpanel/hooks');
  writeFileSync(join(e.claudeDir, 'settings.json'), JSON.stringify({ hooks }));

  const d = await startDaemon({ ...e, portRange: { start: 19121, end: 19130 } });
  const res = await fetch(`http://127.0.0.1:${d.port}/api/health`);
  const body = await res.json();
  assert.equal(body.hooksInstalled, true);
  await d.stop();
});

test('health reports hooksInstalled false when settings.json is malformed', async () => {
  const e = env();
  writeFileSync(join(e.claudeDir, 'settings.json'), 'not json{{{');

  const d = await startDaemon({ ...e, portRange: { start: 19131, end: 19140 } });
  const res = await fetch(`http://127.0.0.1:${d.port}/api/health`);
  const body = await res.json();
  assert.equal(body.hooksInstalled, false);
  await d.stop();
});

test('a second start against the same claudeDir is refused rather than orphaning the first', async () => {
  const e = env();
  const a = await startDaemon({ ...e, portRange: { start: 19081, end: 19090 } });
  await assert.rejects(
    () => startDaemon({ ...e, portRange: { start: 19091, end: 19100 } }),
    /already (in progress|running)/,
  );
  await a.stop();
  const b = await startDaemon({ ...e, portRange: { start: 19101, end: 19110 } });
  await b.stop();
});

test('a live-held lock reports an actionable error naming the lock file', async () => {
  const e = env();
  const a = await startDaemon({ ...e, portRange: { start: 19141, end: 19150 } });
  await assert.rejects(
    () => startDaemon({ ...e, portRange: { start: 19151, end: 19160 } }),
    (err) => {
      assert.match(err.message, /daemon\.json\.lock/);
      return true;
    },
  );
  await a.stop();
});

test('startup tightens a state directory and log the bootstrap script left world-readable', async () => {
  // The token is in daemon.json and everything the detached daemon prints lands in daemon.log, so a
  // 0755 directory beside a 0644 log is a token disclosure to every other user on the machine.
  const e = env();
  const state = join(e.claudeDir, 'agentpanel');
  mkdirSync(state, { recursive: true });
  chmodSync(state, 0o755);
  const log = join(state, 'daemon.log');
  writeFileSync(log, 'stale output\n', { mode: 0o644 });

  const d = await startDaemon({ ...e, portRange: { start: 19161, end: 19170 } });
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  await d.stop();
});

test('a read route rejects a foreign Origin — the cookie is not port-scoped', async () => {
  // Any other server on 127.0.0.1 the user visits receives `agentpanel_token` with its own requests
  // and can replay it here. The Origin check is what stops that page reading prompts and tool output.
  const d = await startDaemon({ ...env(), portRange: { start: 19171, end: 19180 } });
  for (const path of ['/api/runs', '/api/catalog', '/api/stream']) {
    const res = await fetch(`http://127.0.0.1:${d.port}${path}`, {
      headers: { cookie: `agentpanel_token=${d.token}`, origin: 'http://127.0.0.1:3000' },
    });
    assert.equal(res.status, 403, `${path} must refuse a foreign origin`);
    assert.equal((await res.json()).error, 'bad_origin');
  }
  await d.stop();
});

test('a read route still accepts our own Origin and an absent one', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19181, end: 19190 } });
  const own = await fetch(`http://127.0.0.1:${d.port}/api/runs`, {
    headers: { cookie: `agentpanel_token=${d.token}`, origin: `http://127.0.0.1:${d.port}` },
  });
  assert.equal(own.status, 200);
  const none = await fetch(`http://127.0.0.1:${d.port}/api/runs`, {
    headers: { authorization: `Bearer ${d.token}` },
  });
  assert.equal(none.status, 200);
  await d.stop();
});

test('the chat routes are served by the daemon and gated like every other route', async () => {
  const e = env();
  const d = await startDaemon({ ...e, portRange: { start: 19191, end: 19200 } });
  const auth = { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' };
  const at = (path) => `http://127.0.0.1:${d.port}${path}`;

  assert.deepEqual(await (await fetch(at('/api/projects'), { headers: auth })).json(), { projects: [] });

  const created = await fetch(at('/api/projects'), { method: 'POST', headers: auth, body: JSON.stringify({ path: e.claudeDir }) });
  assert.equal(created.status, 201);
  assert.equal((await (await fetch(at('/api/projects'), { headers: auth })).json()).projects.length, 1);

  const history = await fetch(at(`/api/chat/history?projectPath=${encodeURIComponent(e.claudeDir)}`), { headers: auth });
  assert.deepEqual((await history.json()).messages, []);

  // A path that is not a directory is refused before any session is started — which is also what
  // keeps this test from spawning a real Claude session.
  const bad = await fetch(at('/api/chat'), { method: 'POST', headers: auth, body: JSON.stringify({ projectPath: '/nope/nope', text: 'hi' }) });
  assert.equal(bad.status, 400);

  for (const path of ['/api/chat', '/api/chat/interrupt', '/api/chat/reset', '/api/permissions/abc']) {
    const anon = await fetch(at(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(anon.status, 401, `${path} must require a token`);
    const foreign = await fetch(at(path), {
      method: 'POST',
      headers: { cookie: `agentpanel_token=${d.token}`, origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(foreign.status, 403, `${path} must refuse a foreign origin`);
  }
  await d.stop();
});
