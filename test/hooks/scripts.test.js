// test/hooks/scripts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../../hooks/agentpanel-hook.sh', import.meta.url));

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
