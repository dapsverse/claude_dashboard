// test/hooks/scripts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../../hooks/agentpanel-hook.sh', import.meta.url));
const BOOTSTRAP = fileURLToPath(new URL('../../hooks/agentpanel-bootstrap.sh', import.meta.url));

// A `node` that does nothing, so the bootstrap script can be exercised to completion without
// actually detaching a daemon onto the machine running the tests.
function stubNodeOnPath() {
  const bin = mkdtempSync(join(tmpdir(), 'ap-bin-'));
  writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

function run(script, { stdin = '', env = {} }) {
  return new Promise((resolve) => {
    let writeError;
    const child = execFile('bash', [script], { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr, writeError }));
    child.stdin.on('error', (e) => { writeError = e.code ?? e.message; });
    child.stdin.end(stdin);
  });
}

function fakeConfigDir({ port, token, pid = process.pid }) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-cfg-'));
  mkdirSync(join(dir, 'agentpanel'), { recursive: true });
  if (port) {
    writeFileSync(join(dir, 'agentpanel', 'daemon.json'),
      JSON.stringify({ pid, port, token, startedAt: 1, version: '0.1.0' }));
  }
  return dir;
}

test('forwards the payload verbatim with the bearer token', async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ body, auth: req.headers.authorization, url: req.url }); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cfg = fakeConfigDir({ port, token: 'e'.repeat(64) });
  const payload = '{"hook_event_name":"PreToolUse","session_id":"s1"}';

  const out = await run(HOOK, { stdin: payload, env: { CLAUDE_CONFIG_DIR: cfg } });

  assert.equal(out.code, 0);
  assert.equal(out.stdout, '', 'stdout must stay empty — SessionStart stdout is injected into context');
  assert.equal(received.length, 1);
  assert.equal(received[0].body, payload);
  assert.equal(received[0].url, '/api/hooks');
  assert.equal(received[0].auth, `Bearer ${'e'.repeat(64)}`);
  server.close();
});

test('exits 0 and stays silent when no daemon.json exists', async () => {
  const cfg = fakeConfigDir({});
  const out = await run(HOOK, { stdin: '{"a":1}', env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
});

test('exits 0 when the recorded port refuses the connection', async () => {
  const cfg = fakeConfigDir({ port: 9, token: 'f'.repeat(64) });   // discard port, nothing listening
  const out = await run(HOOK, { stdin: '{"a":1}', env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
});

test('exits 0 on a corrupt daemon.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-cfg-'));
  mkdirSync(join(dir, 'agentpanel'), { recursive: true });
  writeFileSync(join(dir, 'agentpanel', 'daemon.json'), 'not json at all');
  const out = await run(HOOK, { stdin: '{"a":1}', env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
});

test('drains a payload larger than the pipe buffer even with no daemon.json', async () => {
  const cfg = fakeConfigDir({});
  // 256 KB is comfortably past the ~64 KB pipe buffer. If the script exited before reading stdin,
  // the writer would take an EPIPE here rather than completing.
  const out = await run(HOOK, { stdin: `{"big":"${'x'.repeat(256 * 1024)}"}`, env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
  assert.equal(out.writeError, undefined, 'the writer must not see EPIPE');
});

test('the token never reaches a process command line', async () => {
  // /proc/<pid>/cmdline is world-readable on Linux, and this hook fires on every SessionStart, Agent
  // dispatch, SubagentStop and SessionEnd — a token in curl's argv is a repeated local disclosure.
  // The process table is sampled from inside the request handler, with curl still blocked on the
  // response, so this observes the live command line rather than racing it.
  const token = 'abcdef0123456789'.repeat(4);
  let processes = '';
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      try { processes = execFileSync('ps', ['-Ao', 'args'], { encoding: 'utf8' }); }
      catch { processes = ''; }
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = fakeConfigDir({ port: server.address().port, token });

  const out = await run(HOOK, { stdin: '{"hook_event_name":"PreToolUse","session_id":"s1"}', env: { CLAUDE_CONFIG_DIR: cfg } });

  assert.equal(out.code, 0);
  assert.ok(processes.includes('curl'), 'the sample must have caught curl mid-request to mean anything');
  assert.ok(!processes.includes(token), 'no running process may show the token in its arguments');
  server.close();
});

test('the whole forward completes well inside the hook timeout budget', async () => {
  const server = createServer((req, res) => { req.resume(); req.on('end', () => res.end('{}')); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const cfg = fakeConfigDir({ port: server.address().port, token: 'a'.repeat(64) });

  const started = Date.now();
  const out = await run(HOOK, { stdin: '{"hook_event_name":"SessionEnd","session_id":"s1"}', env: { CLAUDE_CONFIG_DIR: cfg } });
  const elapsed = Date.now() - started;

  assert.equal(out.code, 0);
  assert.ok(elapsed < 1000, `hook took ${elapsed}ms; SessionEnd hooks share a 1.5s budget`);
  server.close();
});

test('the bootstrap script creates the state directory 0700 and the log 0600', async () => {
  // `mkdir -p` under the default umask made this 0755, and `>>` made the log 0644 — while the daemon
  // wrote its token-bearing url straight into that log.
  const cfg = mkdtempSync(join(tmpdir(), 'ap-boot-'));
  const out = await run(BOOTSTRAP, { stdin: '{"hook_event_name":"SessionStart"}', env: { CLAUDE_CONFIG_DIR: cfg, PATH: stubNodeOnPath() } });

  assert.equal(out.code, 0);
  assert.equal(out.stdout, '', 'SessionStart stdout is injected into the model context');
  const state = join(cfg, 'agentpanel');
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.ok(existsSync(join(state, 'daemon.log')));
  assert.equal(statSync(join(state, 'daemon.log')).mode & 0o777, 0o600);
});

test('the bootstrap script tightens a state directory and log an older version left behind', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'ap-boot-'));
  const state = join(cfg, 'agentpanel');
  mkdirSync(state, { recursive: true });
  chmodSync(state, 0o755);
  writeFileSync(join(state, 'daemon.log'), 'Open: http://127.0.0.1:8888/auth?token=deadbeef\n', { mode: 0o644 });

  const out = await run(BOOTSTRAP, { stdin: '{}', env: { CLAUDE_CONFIG_DIR: cfg, PATH: stubNodeOnPath() } });

  assert.equal(out.code, 0);
  assert.equal(statSync(join(state, 'daemon.log')).mode & 0o777, 0o600);
});
