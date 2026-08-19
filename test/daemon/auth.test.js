// test/daemon/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, generateToken, safeEqual, readCookie, COOKIE_NAME } from '../../src/daemon/auth.js';

const TOKEN = 'a'.repeat(64);
const req = (headers) => ({ headers });
const ok = { token: TOKEN, port: 8888 };

test('token is 64 hex chars and unique per call', () => {
  const a = generateToken(), b = generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('safeEqual handles length mismatch without throwing', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'a'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('accepts a bearer token on a loopback host', () => {
  const r = req({ host: '127.0.0.1:8888', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: true });
});

test('accepts the cookie form', () => {
  const r = req({ host: 'localhost:8888', cookie: `other=1; ${COOKIE_NAME}=${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: true });
});

test('rejects a missing token', () => {
  const r = req({ host: '127.0.0.1:8888' });
  assert.deepEqual(authorize(r, ok), { ok: false, status: 401, reason: 'bad_token' });
});

test('rejects a wrong token', () => {
  const r = req({ host: '127.0.0.1:8888', authorization: `Bearer ${'b'.repeat(64)}` });
  assert.equal(authorize(r, ok).reason, 'bad_token');
});

test('rejects a foreign Host header — this closes DNS rebinding', () => {
  const r = req({ host: 'evil.example.com', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: false, status: 403, reason: 'bad_host' });
});

test('rejects the right host on the wrong port', () => {
  const r = req({ host: '127.0.0.1:9999', authorization: `Bearer ${TOKEN}` });
  assert.equal(authorize(r, ok).reason, 'bad_host');
});

test('rejects a cross-site Origin on state-changing requests', () => {
  const r = req({ host: '127.0.0.1:8888', origin: 'https://evil.example.com', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, { ...ok, stateChanging: true }), { ok: false, status: 403, reason: 'bad_origin' });
});

test('allows an absent Origin on state-changing requests — hook scripts are not browsers', () => {
  const r = req({ host: '127.0.0.1:8888', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, { ...ok, stateChanging: true }), { ok: true });
});

test('allows our own Origin on state-changing requests', () => {
  const r = req({ host: '127.0.0.1:8888', origin: 'http://127.0.0.1:8888', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, { ...ok, stateChanging: true }), { ok: true });
});

test('host check runs before token check so a bad host never leaks timing on the token', () => {
  const r = req({ host: 'evil.example.com' });
  assert.equal(authorize(r, ok).reason, 'bad_host');
});

test('readCookie ignores prefix collisions', () => {
  assert.equal(readCookie({ cookie: `not_${COOKIE_NAME}=x; ${COOKIE_NAME}=y` }, COOKIE_NAME), 'y');
});

test('rejects a foreign Origin on a read request too — cookies are not port-scoped', () => {
  // A dev server on another 127.0.0.1 port receives `agentpanel_token` from the browser and can
  // replay it. GET /api/runs, /api/catalog and /api/stream have to be gated exactly like a write.
  const r = req({ host: '127.0.0.1:8888', origin: 'http://127.0.0.1:3000', cookie: `${COOKIE_NAME}=${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: false, status: 403, reason: 'bad_origin' });
});

test('allows an absent Origin on a read request — the hook scripts and curl send none', () => {
  const r = req({ host: '127.0.0.1:8888', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: true });
});

test('the Origin check runs before the token check on a read request', () => {
  const r = req({ host: '127.0.0.1:8888', origin: 'https://evil.example.com' });
  assert.equal(authorize(r, ok).reason, 'bad_origin');
});
